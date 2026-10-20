// PenguinEnv: a gym-style reinforcement-learning environment around the
// deterministic core. reset(seed) -> observation, step(action) -> { obs,
// reward, terminated, truncated, info }. Render-free and pure (no DOM), so the
// same environment runs in the AI Lab, in Web Workers, in the Node trainer and
// behind tools/headless.mjs for Python. docs/AI.md documents every
// observation index, the reward and the termination rules.
import { buildWorld } from '../core/track.js';
import { Sim } from '../core/sim.js';
import { RouteTracker, NO_SURFACE } from '../core/route.js';
import { ACTIONS, STEER_MAX } from '../core/input.js';
import { Recorder, decodeInputs, encodeInputs } from '../core/replay.js';
import { Autopilot } from '../core/autopilot.js';
import { SURFACE_PARAMS } from '../core/car.js';
import { Rng } from '../core/rng.js';
import { datan2, qrotate, qrotateInv, dsincos, PI, DEG } from '../core/mathd.js';
import { SURFACE_IDS, TICKS_PER_SECOND, TICK } from '../core/constants.js';

export const ENV_VERSION = 1;

export const ENV_DEFAULTS = Object.freeze({
    frameSkip: 4,            // ticks per env step (the action repeats)
    maxSeconds: 120,         // episode budget (truncated after)
    action: 'discrete',      // 'discrete' (core ACTIONS, 9) | 'continuous' ([steer, throttle])
    startMode: 'start',      // 'start' | 'random-checkpoint' | 'random' (autopilot snapshots)
    laps: null,              // null: the track's lap count
    onFall: 'terminate',     // 'terminate' | 'respawn' (TM-style back to the last checkpoint)
    stuckSeconds: 3,         // no new progress for this long -> terminated ('stuck')
    wrongWayMeters: 25,      // this far behind the best progress -> terminated ('wrong-way')
    offRouteMargin: 5,       // metres beyond the road half-width counted as off the route
    offRouteSeconds: 0.5,    // off the route this long -> terminated ('off-route')
    seed: 0,                 // RNG seed for random starts when reset() gets none
    obs: Object.freeze({
        edgeRays: 15,        // route.edgeRays sensors spread over `fov`
        fov: 180,            // degrees, centred on the car's heading
        rayLength: 120,      // metres
        lookahead: Object.freeze([10, 25, 50, 90]),   // metres ahead along the route
        collisionRays: 0,    // optional real raycasts against the collision mesh (slow)
    }),
    reward: Object.freeze({
        progress: 0.01,      // per metre of new route progress (m / 100)
        time: 0.05,          // penalty per second
        speed: 0.1,          // per second at 100 m/s along the route (scaled linearly)
        wallHit: 0.05,       // per wall hit, times min(intensity / 10 m/s, 3)
        finish: 10,          // finishing bonus...
        finishTime: 10,      // ...plus this × max(0, 1 - raceTime / refSeconds)
        refSeconds: null,    // null: maxSeconds
        fall: 5,             // penalty when the car falls (or respawns)
        crash: 2,            // penalty for a stuck / wrong-way / off-route termination
    }),
});

const START_MODES = ['start', 'random-checkpoint', 'random'];
const SNAPSHOT_TICKS = 200;          // 'random' start: one autopilot snapshot every 2 s
const MAX_RAW_GAIN = 2;              // metres a step may gain beyond what the car's speed explains
const GAP_MARGIN = 27;               // off-route margin over jumps and in the air (like the autopilot)
const AXIS_FWD = [0, 0, 1], AXIS_UP = [0, 1, 0], AXIS_RIGHT = [-1, 0, 0];

/**
 * Full, JSON-safe env config: defaults filled in, nested obs/reward merged,
 * values checked. Model files store this so a policy always sees the
 * observations it was trained on.
 */
export function normalizeEnvConfig(cfg = {}) {
    // Known keys only (a typo or a stray `track` never ends up in a model file).
    const pick = (defaults, src) => {
        const out = {};
        for (const k of Object.keys(defaults)) out[k] = src && src[k] !== undefined ? src[k] : defaults[k];
        return out;
    };
    const c = pick(ENV_DEFAULTS, cfg);
    c.obs = pick(ENV_DEFAULTS.obs, cfg.obs);
    c.obs.lookahead = Array.from(c.obs.lookahead || [], Number);
    c.reward = pick(ENV_DEFAULTS.reward, cfg.reward);
    const intIn = (v, lo, hi, name) => {
        if (!Number.isInteger(v) || v < lo || v > hi) throw new Error(`env ${name} must be an integer in ${lo}..${hi}, got ${v}`);
    };
    intIn(c.frameSkip, 1, 100, 'frameSkip');
    intIn(c.obs.edgeRays, 0, 64, 'obs.edgeRays');
    intIn(c.obs.collisionRays, 0, 64, 'obs.collisionRays');
    if (!(c.maxSeconds > 0)) throw new Error(`env maxSeconds must be positive, got ${c.maxSeconds}`);
    if (!(c.obs.rayLength > 0)) throw new Error('env obs.rayLength must be positive');
    if (!c.obs.lookahead.every((d) => d > 0)) throw new Error('env obs.lookahead distances must be positive');
    if (c.action !== 'discrete' && c.action !== 'continuous') throw new Error(`env action must be 'discrete' or 'continuous', got '${c.action}'`);
    if (!START_MODES.includes(c.startMode)) throw new Error(`env startMode must be one of ${START_MODES.join(', ')}`);
    if (c.onFall !== 'terminate' && c.onFall !== 'respawn') throw new Error(`env onFall must be 'terminate' or 'respawn'`);
    if (c.laps != null) intIn(c.laps, 1, 99, 'laps');
    return c;
}

/**
 * Observation layout for a config: [{ name, low, high }], index = position in
 * the observation vector. Values are clipped to [low, high].
 */
export function observationLayout(cfg) {
    const c = normalizeEnvConfig(cfg);
    const f = [];
    const add = (name, low, high) => f.push({ name, low, high });
    add('speed.forward', -1, 3);          // m/s / 100 in the car frame
    add('speed.right', -3, 3);            // m/s / 30
    add('speed.up', -3, 3);               // m/s / 30
    add('yawRate', -3, 3);                // rad/s / 3, + = turning right
    add('pitch', -1, 1);                  // forward.y (+ = nose up)
    add('roll', -1, 1);                   // -right.y (+ = leaning right)
    add('up.y', -1, 1);                   // 1 upright, -1 upside down
    add('steer', -1, 1);                  // smoothed steering (+ = right)
    for (const w of ['FL', 'FR', 'RL', 'RR']) add(`contact.${w}`, 0, 1);
    add('airborne', 0, 1);
    add('drifting', 0, 1);
    add('slipAngle', -2, 2);              // rad / 0.5
    for (const s of SURFACE_IDS) add(`surface.${s}`, 0, 1);
    add('route.headingError', -1, 1);     // rad / π, + = car points right of the route
    add('route.lateral', -3, 3);          // offset / half-width, + = right of the centerline
    add('route.vertical', -3, 3);         // height above the deck along its normal / 10 m
    add('route.halfWidth', 0, 2);         // m / 16
    add('route.gap', 0, 1);               // 1 over a jump
    add('route.speed', -1, 3);            // velocity along the route tangent / 100 m/s
    const la = c.obs.lookahead;
    for (const d of la) add(`curv@${d}`, -2, 2);        // lateral curvature × 16 m (+ = right turn)
    for (const d of la) add(`vcurv@${d}`, -2, 2);       // vertical curvature × 16 m (+ = compression)
    for (const d of la) add(`grip@${d}`, 0, 1);         // surface grip / packed snow (0 over a jump)
    for (const d of la) {
        add(`point@${d}.right`, -2, 2);   // route point in the car frame / distance
        add(`point@${d}.up`, -2, 2);
        add(`point@${d}.forward`, -2, 2);
    }
    for (const a of rayAngles(c.obs.edgeRays, c.obs.fov)) add(`edge@${Math.round(a / DEG)}`, 0, 1);
    for (const a of rayAngles(c.obs.collisionRays, c.obs.fov)) add(`wall@${Math.round(a / DEG)}`, 0, 1);
    add('effect.boost', 0, 1);            // boost level × remaining time, 1 = fresh Avalanche Boost
    add('effect.noEngine', 0, 1);
    add('effect.noSteer', 0, 1);
    add('effect.noBrake', 0, 1);
    add('effect.slowmo', 0, 1);           // Snow Globe stacks / 3
    add('effect.cruise', 0, 1);
    add('effect.fragile', 0, 1);
    add('effect.broken', 0, 1);
    add('progress', -0.5, 1.5);           // progress / (route length × laps)
    add('checkpoints', 0, 1);             // checkpoints taken this lap / total
    return f;
}

/** Ray angles (radians, + = right), evenly spread over fov degrees. */
export function rayAngles(n, fov) {
    const out = [];
    if (n <= 0) return out;
    if (n === 1) return [0];
    const half = (fov * DEG) / 2;
    for (let i = 0; i < n; i++) out.push(-half + (2 * half * i) / (n - 1));
    return out;
}

export class PenguinEnv {
    /**
     * opts: { track (JSON) | world (from buildWorld), ...config } — see
     * ENV_DEFAULTS. The world needs a route (it measures progress).
     */
    constructor(opts = {}) {
        const world = opts.world || (opts.track ? buildWorld(opts.track) : null);
        if (!world) throw new Error('PenguinEnv needs a track or a world');
        if (!world.route) throw new Error(`This track has no route: ${world.routeError || 'invalid track'}`);
        this.world = world;
        this.route = world.route;
        this.config = normalizeEnvConfig(opts);
        const c = this.config;
        this.laps = c.laps ?? world.laps ?? 1;
        this.sim = new Sim(world, { laps: this.laps });
        this.tracker = new RouteTracker(this.route);
        this.recorder = new Recorder();
        this.layout = observationLayout(c);
        this.obsSize = this.layout.length;
        this._low = new Float32Array(this.layout.map((f) => f.low));
        this._high = new Float32Array(this.layout.map((f) => f.high));
        this.observationSpace = {
            type: 'box', shape: [this.obsSize], dtype: 'float32',
            low: Array.from(this._low), high: Array.from(this._high), names: this.layout.map((f) => f.name),
        };
        this.actionSpace = c.action === 'discrete'
            ? { type: 'discrete', n: ACTIONS.length, names: ACTIONS.map((a) => a.name) }
            : { type: 'box', shape: [2], dtype: 'float32', low: [-1, -1], high: [1, 1], names: ['steer', 'throttle'] };
        this.actionSize = c.action === 'discrete' ? ACTIONS.length : 2;
        this.totalLength = this.route.closed ? this.route.length * this.laps : this.route.length;
        this.stepSeconds = c.frameSkip * TICK;
        this.maxTicks = Math.round(c.maxSeconds * TICKS_PER_SECOND);
        this._edgeAngles = rayAngles(c.obs.edgeRays, c.obs.fov);
        this._wallAngles = rayAngles(c.obs.collisionRays, c.obs.fov);
        this._edgeOut = new Float64Array(this._edgeAngles.length);
        this._raw = new Float64Array(this.obsSize);
        this._rng = new Rng(c.seed);
        this._proj = { s: 0, index: 0, t: 0, point: [0, 0, 0], tangent: [0, 0, 1], up: [0, 1, 0], lateral: 0, vertical: 0, dist: 0, halfWidth: 0 };
        this._pt = { point: [0, 0, 0], tangent: [0, 0, 1], up: [0, 1, 0], index: 0, s: 0, halfWidth: 0, surface: 0, gap: 0 };
        this._v = [0, 0, 0]; this._w = [0, 0, 0];
        this._fwd = [0, 0, 1]; this._up = [0, 1, 0]; this._right = [-1, 0, 0];
        this._hit = { t: 0, point: [0, 0, 0], normal: [0, 1, 0], surface: 0, surfaceId: 'snow', tri: -1, backface: false, u: 0, v: 0 };
        this._input = { steer: 0, gas: false, brake: false, respawn: false };
        this._starts = null;
        this.done = true;
        this.reason = null;
        this.episodeReturn = 0;
        this.steps = 0;
    }

    /**
     * Starts an episode. seed (optional) reseeds the start RNG (gym semantics:
     * reset() without a seed continues the stream). Returns the observation.
     */
    reset(seed) {
        if (seed != null) this._rng = new Rng(Number(seed) >>> 0);
        const sim = this.sim, tr = this.tracker;
        tr.reset();
        this.recorder.clear();
        let start = null;
        if (this.config.startMode !== 'start') {
            const list = this._startStates();
            start = list[this._rng.int(list.length)];
        }
        if (start && start.sim) {
            sim.setState(start.sim);
            tr.setState(start.tracker);
            this.recorder.inputs = this._prefix.slice(0, start.inputs);
        } else {
            sim.reset();
        }
        tr.track(sim);
        tr.best = tr.progress;
        tr.bestTick = sim.tick;
        this.startTick = sim.tick;
        this.rewardBest = tr.progress;
        this.offTicks = 0;
        this.steps = 0;
        this.episodeReturn = 0;
        this.done = false;
        this.reason = null;
        this.lastEvents = [];
        return this.observe();
    }

    /** Core input for an action: discrete index, [steer, throttle], or an input object. */
    actionToInput(action, out = this._input) {
        out.respawn = false;
        const list = Array.isArray(action) || ArrayBuffer.isView(action);
        if (list && action.length === 1) action = Number(action[0]);   // [index] from array-minded callers
        else if (typeof action === 'string' && /^\d+$/.test(action)) action = Number(action);
        if (typeof action === 'number') {
            const a = ACTIONS[action];
            if (!a) throw new RangeError(`Unknown action ${action} (0..${ACTIONS.length - 1})`);
            out.steer = a.steer; out.gas = a.gas; out.brake = a.brake;
        } else if (!list && action && typeof action === 'object' && 'steer' in action) {
            out.steer = action.steer; out.gas = !!action.gas; out.brake = !!action.brake;
        } else if (list && action.length >= 2) {
            const s = Number(action[0]), t = Number(action[1]);
            const sc = s > 1 ? 1 : s < -1 ? -1 : s === s ? s : 0;
            out.steer = sc * STEER_MAX;
            out.gas = t >= 0.5;
            out.brake = t <= -0.5;
        } else {
            throw new TypeError(`Bad action ${JSON.stringify(action)}`);
        }
        return out;
    }

    /** Advances frameSkip ticks with one action. */
    step(action) {
        if (this.done) throw new Error('The episode is over: call reset() first');
        const c = this.config, R = c.reward, sim = this.sim, tr = this.tracker;
        const inp = this.actionToInput(action);
        const events = [];
        let reward = 0, ticks = 0, fell = false, wall = 0;
        for (let k = 0; k < c.frameSkip; k++) {
            sim.step(inp);
            this.recorder.push(sim.lastInput);
            ticks++;
            if (sim.events.length) {
                for (const ev of sim.events) {
                    events.push(ev);
                    if (ev.type === 'wallhit') wall += Math.min(ev.intensity / 10, 3);
                    else if (ev.type === 'fall') fell = true;
                }
            }
            tr.track(sim);
            if (sim.finished || sim.fallen || sim.tick - this.startTick >= this.maxTicks) break;
        }
        inp.respawn = false;
        const seconds = ticks * TICK;
        this.steps++;
        this.lastEvents = events;

        // New ground only: driving back and forth (or respawning) never pays twice.
        const car = sim.car;
        const maxGain = car.speed * seconds + MAX_RAW_GAIN;
        let gain = tr.progress - this.rewardBest;
        if (gain > 0) {
            if (gain > maxGain) gain = maxGain;
            this.rewardBest += gain;
            reward += gain * R.progress;
        }
        const pr = this._project();
        const along = car.vel[0] * pr.tangent[0] + car.vel[1] * pr.tangent[1] + car.vel[2] * pr.tangent[2];
        if (along > 0) reward += R.speed * (along / 100) * seconds;
        reward -= R.time * seconds;
        reward -= R.wallHit * wall;

        let terminated = false, truncated = false, reason = null;
        if (sim.finished) {
            terminated = true;
            reason = 'finish';
            const ref = (R.refSeconds || c.maxSeconds) * 1000;
            reward += R.finish + R.finishTime * Math.max(0, 1 - sim.finishTimeMs / ref);
        } else if (fell || sim.fallen) {
            reward -= R.fall;
            if (c.onFall === 'respawn') {
                sim.respawn();
            } else {
                terminated = true;
                reason = 'fall';
            }
        }
        if (!terminated) {
            if (this._offRoute(pr)) this.offTicks += ticks;
            else this.offTicks = 0;
            if (sim.tick - tr.bestTick >= c.stuckSeconds * TICKS_PER_SECOND) reason = 'stuck';
            else if (tr.best - tr.progress > c.wrongWayMeters) reason = 'wrong-way';
            else if (this.offTicks >= c.offRouteSeconds * TICKS_PER_SECOND) reason = 'off-route';
            if (reason) {
                terminated = true;
                reward -= R.crash;
            } else if (sim.tick - this.startTick >= this.maxTicks) {
                truncated = true;
                reason = 'time';
            }
        }
        this.episodeReturn += reward;
        this.done = terminated || truncated;
        this.reason = reason;
        return { obs: this.observe(), reward, terminated, truncated, info: this.info() };
    }

    /** Off the route: beyond the half-width plus a margin, or well below / above the deck. */
    _offRoute(pr) {
        const c = this.config, car = this.sim.car;
        const loose = car.airborne || this.route.gap[pr.index];
        const lim = pr.halfWidth + (loose ? GAP_MARGIN : c.offRouteMargin);
        const lat = pr.lateral < 0 ? -pr.lateral : pr.lateral;
        if (lat > lim) return true;
        return loose ? pr.vertical < -GAP_MARGIN : pr.vertical < -c.offRouteMargin || pr.vertical > 40;
    }

    _project() {
        return this.route.project(this.sim.car.pos, this.tracker.hint, this._proj);
    }

    /** Episode summary of the current state. */
    info() {
        const sim = this.sim, tr = this.tracker;
        return {
            progress: tr.progress,
            progressFrac: this.totalLength > 0 ? tr.progress / this.totalLength : 0,
            timeMs: sim.timeMs,
            finished: sim.finished,
            finishTimeMs: sim.finishTimeMs,
            speedKmh: sim.car.speedKmh,
            checkpoints: sim.checkpointTimes.length,
            lap: sim.lap,
            respawns: sim.respawns,
            steps: this.steps,
            ticks: sim.tick - this.startTick,
            episodeReturn: this.episodeReturn,
            reason: this.reason,
        };
    }

    /** The observation of the current state (a fresh Float32Array). */
    observe() {
        const sim = this.sim, car = sim.car, route = this.route, cfg = this.config.obs;
        const o = this._raw, v = this._v, w = this._w;
        const fwd = qrotate(this._fwd, car.quat, AXIS_FWD);
        const up = qrotate(this._up, car.quat, AXIS_UP);
        const right = qrotate(this._right, car.quat, AXIS_RIGHT);
        let k = 0;
        // Car-local axes: +X is left, so "right" components are -x.
        qrotateInv(v, car.quat, car.vel);
        o[k++] = v[2] / 100;
        o[k++] = -v[0] / 30;
        o[k++] = v[1] / 30;
        qrotateInv(w, car.quat, car.angVel);
        o[k++] = -w[1] / 3;
        o[k++] = fwd[1];
        o[k++] = -right[1];
        o[k++] = up[1];
        o[k++] = car.steer;
        for (let i = 0; i < 4; i++) o[k++] = car.wheels[i].contact ? 1 : 0;
        o[k++] = car.airborne ? 1 : 0;
        o[k++] = car.drifting ? 1 : 0;
        o[k++] = car.slipAngle / 0.5;
        for (let i = 0; i < SURFACE_IDS.length; i++) o[k++] = car.surfaceUnder === SURFACE_IDS[i] ? 1 : 0;

        const pr = this._project();
        const T = pr.tangent, U = pr.up;
        const rx = T[1] * U[2] - T[2] * U[1], ry = T[2] * U[0] - T[0] * U[2], rz = T[0] * U[1] - T[1] * U[0];
        const fu = fwd[0] * U[0] + fwd[1] * U[1] + fwd[2] * U[2];
        const px = fwd[0] - fu * U[0], py = fwd[1] - fu * U[1], pz = fwd[2] - fu * U[2];
        o[k++] = datan2(px * rx + py * ry + pz * rz, px * T[0] + py * T[1] + pz * T[2]) / PI;
        o[k++] = pr.halfWidth > 0 ? pr.lateral / pr.halfWidth : 0;
        o[k++] = pr.vertical / 10;
        o[k++] = pr.halfWidth / 16;
        o[k++] = route.gap[pr.index] ? 1 : 0;
        o[k++] = (car.vel[0] * T[0] + car.vel[1] * T[1] + car.vel[2] * T[2]) / 100;

        const la = cfg.lookahead;
        for (let i = 0; i < la.length; i++) o[k++] = route.curvatureAt(pr.s + la[i]) * 16;
        for (let i = 0; i < la.length; i++) o[k++] = vcurvatureAt(route, pr.s + la[i]) * 16;
        const pt = this._pt;
        for (let i = 0; i < la.length; i++) {
            route.pointAt(pr.s + la[i], pt);
            o[k++] = pt.gap || pt.surface === NO_SURFACE ? 0 : SURFACE_PARAMS[pt.surface].grip / SURFACE_PARAMS[0].grip;
        }
        for (let i = 0; i < la.length; i++) {
            route.pointAt(pr.s + la[i], pt);
            v[0] = pt.point[0] - car.pos[0]; v[1] = pt.point[1] - car.pos[1]; v[2] = pt.point[2] - car.pos[2];
            qrotateInv(v, car.quat, v);
            const d = la[i];
            o[k++] = -v[0] / d;
            o[k++] = v[1] / d;
            o[k++] = v[2] / d;
        }

        if (this._edgeAngles.length) {
            // Heading seen from above; straight up or down in a loop, fall back to the route's.
            let hx = fwd[0], hz = fwd[2];
            let hl = Math.sqrt(hx * hx + hz * hz);
            if (hl < 0.2) { hx = T[0]; hz = T[2]; hl = Math.sqrt(hx * hx + hz * hz) || 1; }
            const head = [hx / hl, hz / hl];
            const L = cfg.rayLength;
            route.edgeRays(car.pos, head, this._edgeAngles, L, this._edgeOut, pr.index);
            for (let i = 0; i < this._edgeAngles.length; i++) o[k++] = this._edgeOut[i] / L;
        }
        if (this._wallAngles.length) {
            const L = cfg.rayLength, sc = [0, 0], dir = [0, 0, 0], origin = [0, 0, 0];
            for (let c = 0; c < 3; c++) origin[c] = car.pos[c] + up[c] * 0.3;
            for (let i = 0; i < this._wallAngles.length; i++) {
                dsincos(this._wallAngles[i], sc);
                for (let c = 0; c < 3; c++) dir[c] = fwd[c] * sc[1] + right[c] * sc[0];
                const hit = this.world.collision.raycast(origin, dir, L, this._hit);
                o[k++] = hit ? hit.t / L : 1;
            }
        }

        const e = car.effects;
        o[k++] = (e.turbo * e.turboTime) / 4;
        o[k++] = e.noEngine ? 1 : 0;
        o[k++] = e.noSteer ? 1 : 0;
        o[k++] = e.noBrake ? 1 : 0;
        o[k++] = e.slowmo / 3;
        o[k++] = e.cruise ? 1 : 0;
        o[k++] = e.fragile ? 1 : 0;
        o[k++] = e.broken ? 1 : 0;
        o[k++] = this.totalLength > 0 ? this.tracker.progress / this.totalLength : 0;
        o[k++] = sim.checkpointCount > 0 ? sim.collectedCount / sim.checkpointCount : 0;

        const out = new Float32Array(this.obsSize);
        const lo = this._low, hi = this._high;
        for (let i = 0; i < out.length; i++) {
            const x = o[i];
            out[i] = x !== x ? 0 : x < lo[i] ? lo[i] : x > hi[i] ? hi[i] : x;
        }
        return out;
    }

    /**
     * Exact savestate of the episode (sim, progress tracker, env counters and,
     * unless opts.inputs is false, the recorded inputs). Plain JSON.
     */
    getState(opts = {}) {
        const st = {
            v: ENV_VERSION,
            sim: this.sim.getState(),
            tracker: this.tracker.getState(),
            env: {
                startTick: this.startTick ?? 0, steps: this.steps, rewardBest: this.rewardBest ?? 0,
                offTicks: this.offTicks ?? 0, episodeReturn: this.episodeReturn, done: this.done,
                reason: this.reason, rng: this._rng.getState(),
            },
        };
        if (opts.inputs !== false) st.inputs = encodeInputs(this.recorder.inputs);
        return st;
    }

    /** Restores getState(); returns the observation there. */
    setState(st) {
        if (!st || st.v !== ENV_VERSION || !st.sim || !st.env) throw new Error('Not a PenguinEnv state');
        this.sim.setState(st.sim);
        this.tracker.setState(st.tracker);
        const e = st.env;
        this.startTick = e.startTick; this.steps = e.steps; this.rewardBest = e.rewardBest;
        this.offTicks = e.offTicks; this.episodeReturn = e.episodeReturn; this.done = !!e.done;
        this.reason = e.reason ?? null;
        if (e.rng != null) this._rng.setState(e.rng);
        if (typeof st.inputs === 'string') this.recorder.inputs = decodeInputs(st.inputs);
        this.lastEvents = [];
        return this.observe();
    }

    /** Replay of the episode so far (a full run from GO, ghost-ready once finished). */
    replay(meta = {}) {
        return this.recorder.toReplay({ sim: this.sim, name: meta.name ?? 'AI driver', date: meta.date ?? null });
    }

    /** Starting states for the random start modes: an autopilot run, snapshotted. */
    _startStates() {
        if (this._starts) return this._starts;
        const world = this.world, mode = this.config.startMode;
        const sim = new Sim(world, { laps: this.laps });
        const pilot = new Autopilot(world);
        const tr = new RouteTracker(this.route);
        const rec = new Recorder();
        const starts = [{ sim: null, tracker: null, inputs: 0 }];
        const limit = Math.min(this.maxTicks * 4, 60000);
        while (!sim.finished && sim.tick < limit && sim.respawns < 20) {
            sim.step(pilot.act(sim));
            rec.push(sim.lastInput);
            tr.track(sim);
            if (sim.finished) break;
            let snap = mode === 'random' && sim.tick % SNAPSHOT_TICKS === 0 && !sim.car.airborne && !sim.fallen;
            for (const ev of sim.events) if (ev.type === 'checkpoint' || ev.type === 'lap') snap = true;
            if (snap) starts.push({ sim: sim.getState(), tracker: tr.getState(), inputs: rec.length });
        }
        this._prefix = rec.inputs;
        this._starts = starts;
        return starts;
    }

    close() {}
}

/** Vertical curvature (1/m, + = compression) at distance s, interpolated like curvatureAt. */
function vcurvatureAt(route, s) {
    const i = route.indexAt(s);
    const L = route.segLens[i] || 1;
    const f = Math.min(1, Math.max(0, (route.wrapS(s) - route.s[i]) / L));
    const c = route.vcurvature;
    return c[i] + (c[Math.min(i + 1, route.count - 1)] - c[i]) * f;
}
