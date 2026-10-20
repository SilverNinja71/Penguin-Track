// Route-following driver. It precomputes a racing line on the world route (an
// elastic band pulled tight inside the road, straight over jumps and through
// loops) and a speed plan from that line's curvature, the surface grip, banking,
// jump distances and braking distances, then drives it with pure-pursuit
// steering. Respawns when fallen, broken, stuck or far off the route. Used to
// prove every track is finishable, to produce medal baselines and as a demo /
// training baseline; runAutopilot() wraps a whole drive.
import { STEER_MAX } from './constants.js';
import { datan, datan2, dsin, clamp } from './mathd.js';
import { GRAVITY, CAR, SURFACE_PARAMS, steerAngleMax } from './car.js';
import { NO_SURFACE, RouteTracker } from './route.js';
import { Sim } from './sim.js';
import { Recorder } from './replay.js';

export const AUTOPILOT_DEFAULTS = {
    lookBase: 6,            // look-ahead distance (m) at standstill...
    lookPerSpeed: 0.28,     // ...plus this many seconds of travel
    lookMax: 36,
    lookLoop: 9,            // short look-ahead inside loops (strong vertical curvature)
    racingLine: true,       // false: follow the centerline
    lineMargin: 2.6,        // metres the line keeps from the road edge
    gripMargin: 0.92,       // fraction of the modelled grip the speed plan uses
    crestFactor: 1.25,      // allowed speed over crests relative to "wheels just stay down"
    brakeMargin: 0.8,       // fraction of the braking deceleration the plan counts on
    speedSlack: 1.5,        // m/s over the plan before braking (coast in between)
    stuckTicks: 300,        // no progress for this long -> respawn
    offRouteTicks: 80,      // this far off the route for this long -> respawn
    offRouteMargin: 9,      // metres beyond the road half-width counted as off route
    respawn: true,          // false: never request respawns
    maxSpeed: Infinity,     // m/s cap on the speed plan (tests, gentle demo driving)
    fullThrottle: false,    // ignore the speed plan: gas everywhere (steering still follows the line)
    jumpFactor: 1.15,       // launch speed over the speed that just reaches a jump's landing
};

const LOOP_VCURV = 0.05;    // compression (1/m) above which a route point is "in a loop" (radius < 20 m)
const SCAN_AHEAD = 260;     // metres of route scanned by the speed plan
const DRIFT_STEER = 0.3;    // stay below the car's drift trigger (0.35) while tapping the brake
const STRAIGHT_BEFORE_JUMP = 40, STRAIGHT_AFTER_JUMP = 16;
const STRAIGHT_BEFORE_LOOP = 30, STRAIGHT_AFTER_LOOP = 20;
const JUMP_MIN_DIST = 8;    // landings closer than this (a drop onto the road below) need no speed plan
const LIP_POINTS = 3;       // route points (~2 m each) before a gap that belong to its launch

export class Autopilot {
    constructor(world, opts = {}) {
        this.world = world;
        this.route = world.route;
        this.opts = { ...AUTOPILOT_DEFAULTS, ...opts };
        this.tracker = world.route ? new RouteTracker(world.route) : null;
        this._pt = { point: [0, 0, 0], tangent: [0, 0, 1], up: [0, 1, 0], index: 0, s: 0, halfWidth: 0, surface: 0, gap: 0 };
        this._fwd = [0, 0, 1];
        this._right = [-1, 0, 0];
        this._target = [0, 0, 0];
        if (this.route) this._plan();
        this.reset();
    }

    reset() {
        if (this.tracker) this.tracker.reset();
        this.offTicks = 0;
        this.pendingRespawn = false;
        this.brakeHeld = 0;
        this.respawnCount = 0;
        this.targetSpeed = 0;
    }

    /** Unwrapped distance driven along the route (laps add the route length). */
    get progress() {
        return this.tracker ? this.tracker.progress : 0;
    }

    /** Driver memory (progress, timers) for savestates next to Sim.getState(). */
    getState() {
        return {
            tracker: this.tracker ? this.tracker.getState() : null,
            offTicks: this.offTicks, pendingRespawn: this.pendingRespawn,
            brakeHeld: this.brakeHeld, respawnCount: this.respawnCount,
            targetSpeed: Number.isFinite(this.targetSpeed) ? this.targetSpeed : null,
        };
    }

    setState(s) {
        if (this.tracker && s.tracker) this.tracker.setState(s.tracker);
        this.offTicks = s.offTicks; this.pendingRespawn = s.pendingRespawn;
        this.brakeHeld = s.brakeHeld; this.respawnCount = s.respawnCount;
        this.targetSpeed = s.targetSpeed === null ? Infinity : s.targetSpeed;
    }

    // -------------------------------------------------------------------
    // Planning

    _plan() {
        const r = this.route, n = r.count;
        this.commit = new Uint8Array(n);
        for (let i = 0; i < n; i++) if (r.gap[i] || r.vcurvature[i] > LOOP_VCURV) this.commit[i] = 1;
        this.offset = new Float64Array(n);
        this.rightV = new Float64Array(n * 3);
        for (let i = 0; i < n; i++) {
            const T = r.tangents, U = r.ups, b = i * 3;
            let x = T[b + 1] * U[b + 2] - T[b + 2] * U[b + 1];
            let y = T[b + 2] * U[b] - T[b] * U[b + 2];
            let z = T[b] * U[b + 1] - T[b + 1] * U[b];
            const l = Math.sqrt(x * x + y * y + z * z) || 1;
            this.rightV[b] = x / l; this.rightV[b + 1] = y / l; this.rightV[b + 2] = z / l;
        }
        if (this.opts.racingLine) this._racingLine();
        this._speedPlan();
    }

    /** Index i + d on the route (wrapping on closed routes, clamped otherwise). */
    _at(i, d) {
        const n = this.route.count;
        if (this.route.closed) {
            const m = n - 1;   // the last point repeats the first
            return (((i + d) % m) + m) % m;
        }
        const j = i + d;
        return j < 0 ? 0 : j >= n ? n - 1 : j;
    }

    /**
     * Minimum-curvature band: each point moves to where the discrete second
     * difference of the line vanishes, (-L[i-2] + 4 L[i-1] + 4 L[i+1] - L[i+2]) / 6,
     * projected on its lateral axis and clamped to the road, coarse to fine. The
     * result enters corners wide, apexes inside and exits wide, and takes banks
     * low in the middle where they are steepest.
     */
    _racingLine() {
        const r = this.route, n = r.count, P = r.points, R = this.rightV, o = this.offset;
        const lim = new Float64Array(n);
        for (let i = 0; i < n; i++) lim[i] = Math.max(0, r.halfWidth[i] - this.opts.lineMargin);
        // Straight approach and exit around jumps and loops, fixed ends on open routes.
        for (let i = 0; i < n; i++) {
            if (!this.commit[i]) continue;
            const loop = !r.gap[i];
            const before = loop ? STRAIGHT_BEFORE_LOOP : STRAIGHT_BEFORE_JUMP;
            const after = loop ? STRAIGHT_AFTER_LOOP : STRAIGHT_AFTER_JUMP;
            for (let k = -Math.ceil(before / 2); k <= Math.ceil(after / 2); k++) lim[this._at(i, k)] = 0;
        }
        if (!r.closed) { lim[0] = 0; lim[n - 1] = 0; }
        if (r.closed) lim[n - 1] = 0;   // duplicate of point 0; its offset mirrors it below

        const L = (i, c) => P[i * 3 + c] + R[i * 3 + c] * o[i];
        for (const stride of [32, 16, 8, 4, 2, 1]) {
            for (let it = 0; it < 60; it++) {
                for (let i = 0; i < n; i++) {
                    if (lim[i] === 0) { o[i] = 0; continue; }
                    const a2 = this._at(i, -2 * stride), a1 = this._at(i, -stride);
                    const b1 = this._at(i, stride), b2 = this._at(i, 2 * stride);
                    let d = 0;
                    for (let c = 0; c < 3; c++) {
                        const t = (-L(a2, c) + 4 * L(a1, c) + 4 * L(b1, c) - L(b2, c)) / 6;
                        d += (t - P[i * 3 + c]) * R[i * 3 + c];
                    }
                    o[i] = d > lim[i] ? lim[i] : d < -lim[i] ? -lim[i] : d;
                }
            }
        }
        if (r.closed) o[n - 1] = o[0];
    }

    /** Per point: the highest speed the line allows there (m/s). */
    _speedPlan() {
        const r = this.route, n = r.count, P = r.points, R = this.rightV, U = r.ups, o = this.offset;
        const kLat = new Float64Array(n), kVert = new Float64Array(n);
        const L = (i, c) => P[i * 3 + c] + R[i * 3 + c] * o[i];
        for (let i = 0; i < n; i++) {
            if (!r.closed && (i === 0 || i === n - 1)) continue;
            const a = this._at(i, -1), b = this._at(i, 1);
            let l1 = 0, l2 = 0;
            const d1 = [0, 0, 0], d2 = [0, 0, 0];
            for (let c = 0; c < 3; c++) {
                d1[c] = L(i, c) - L(a, c); d2[c] = L(b, c) - L(i, c);
                l1 += d1[c] * d1[c]; l2 += d2[c] * d2[c];
            }
            l1 = Math.sqrt(l1); l2 = Math.sqrt(l2);
            if (l1 < 1e-6 || l2 < 1e-6) continue;
            const ds = (l1 + l2) / 2;
            let kl = 0, kv = 0;
            for (let c = 0; c < 3; c++) {
                const dT = d2[c] / l2 - d1[c] / l1;
                kl += dT * R[i * 3 + c];
                kv += dT * U[i * 3 + c];
            }
            kLat[i] = kl / ds;
            kVert[i] = kv / ds;
        }
        this.lineCurvature = kLat;
        // The crest at a ramp lip or a road end is the launch itself: the jump plan
        // sets the speed there, so crest limits stop a few points short of a gap.
        const nearGap = new Uint8Array(n);
        for (let i = 0; i < n; i++) if (r.gap[i]) for (let k = -LIP_POINTS; k <= 1; k++) nearGap[this._at(i, k)] = 1;
        this.vAllow = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            if (this.commit[i]) { this.vAllow[i] = Infinity; continue; }
            let k = 0;
            for (let j = -2; j <= 2; j++) k += kLat[this._at(i, j)];
            k /= 5;
            let va = cornerSpeed(r, R, i, k, kVert[i], this.opts.gripMargin);
            // Crests: flying off them at full speed lands on whatever comes next. The wheels
            // stay down while gravity plus downforce exceed v² · (crest curvature).
            const vk = kVert[i];
            if (vk < -1e-3 && !nearGap[i]) {
                const g = GRAVITY * U[i * 3 + 1];
                const k = -vk - CAR.downforce;
                const vc = g <= 0 ? 0 : k <= 0 ? Infinity : this.opts.crestFactor * Math.sqrt(g / k);
                if (vc < va) va = vc;
            }
            this.vAllow[i] = va;
        }
        this._jumpPlan();
    }

    /**
     * Launch speeds for jumps: just enough to carry the gap (projectile from the
     * launch point along its tangent to the landing), times jumpFactor so the car
     * lands a little past the landing edge instead of far down the track. A jump
     * that cannot be reached at any speed keeps full gas.
     */
    _jumpPlan() {
        const r = this.route, n = r.count, P = r.points, D = r.segDirs;
        this.jumpSpeed = [];
        for (let i = 0; i + 1 < n; i++) {
            if (!r.gap[i] || (i > 0 && r.gap[i - 1])) continue;
            let j = i;
            while (j + 1 < n && r.gap[j]) j++;
            const dx = P[j * 3] - P[i * 3], dz = P[j * 3 + 2] - P[i * 3 + 2], dy = P[j * 3 + 1] - P[i * 3 + 1];
            const d = Math.sqrt(dx * dx + dz * dz);
            const th = Math.sqrt(D[i * 3] * D[i * 3] + D[i * 3 + 2] * D[i * 3 + 2]);
            if (d < JUMP_MIN_DIST || th < 1e-6) continue;
            const tan = D[i * 3 + 1] / th;
            const den = 2 * (d * tan - dy);
            if (den <= 0) continue;
            const v = Math.sqrt((GRAVITY * d * d * (1 + tan * tan)) / den) * this.opts.jumpFactor;
            // The launch point is the last one on the ground before the gap.
            const at = i > 0 ? i - 1 : i;
            if (v < this.vAllow[at]) this.vAllow[at] = v;
            this.jumpSpeed.push({ index: at, s: r.s[at], speed: v, distance: d, drop: -dy });
        }
    }

    // -------------------------------------------------------------------
    // Driving

    /** Input for the sim's next tick. */
    act(sim) {
        const r = this.route;
        const car = sim.car;
        if (!r || sim.finished) return { steer: 0, gas: false, brake: false };
        const o = this.opts;

        // Respawn on falls, a broken car, or when stuck / lost. Decided from sim state
        // (not the last tick's events), so a savestate taken on that tick resumes the same.
        if (o.respawn) {
            if (sim.fallen || car.effects.broken) this.pendingRespawn = true;
            if (this.pendingRespawn) return this._respawn();
        }

        const tr = this.tracker.track(sim);
        const pr = { s: tr.s, index: tr.index };
        if (o.respawn) {
            const loose = tr.gap === 1 || car.airborne ? 18 : 0;
            const off = tr.dist > tr.halfWidth + o.offRouteMargin + loose;
            this.offTicks = off ? this.offTicks + 1 : 0;
            if (this.offTicks > o.offRouteTicks || sim.tick - tr.bestTick > o.stuckTicks) return this._respawn();
        }

        const fwd = this._fwd, right = this._right, q = car.quat;
        rotate(fwd, q, 0, 0, 1);
        rotate(right, q, -1, 0, 0);
        const v = car.forwardSpeed;
        const av = v < 0 ? -v : v;

        // Steering: pure pursuit toward the racing line ahead.
        let look = o.lookBase + o.lookPerSpeed * av;
        if (look > o.lookMax) look = o.lookMax;
        if (this._loopAhead(pr.s, look)) look = Math.min(look, o.lookLoop);
        const tp = this._linePoint(pr.s + look);
        const dx = tp[0] - car.pos[0], dy = tp[1] - car.pos[1], dz = tp[2] - car.pos[2];
        const x = dx * right[0] + dy * right[1] + dz * right[2];
        const z = dx * fwd[0] + dy * fwd[1] + dz * fwd[2];
        const alpha = datan2(x, z);
        const dist = Math.sqrt(x * x + z * z) || 1;
        const kappa = (2 * dsin(alpha)) / dist;
        let steer = datan(kappa * CAR.wheelbase) / steerAngleMax(av);
        if (v < 0) steer = -steer;
        steer = clamp(steer, -1, 1);

        // Throttle: follow the speed plan; never lift over jumps or in loops.
        let target = this._targetSpeed(pr.index, pr.s, car);
        if (o.fullThrottle) target = Infinity;
        else if (target > o.maxSpeed) target = o.maxSpeed;
        this.targetSpeed = target;
        let gas = true, brake = false;
        if (this.commit[pr.index] || car.airborne) {
            gas = true;
        } else if (v > target + o.speedSlack) {
            gas = false;
            brake = v > target + o.speedSlack + 3 || v - target > 0.08 * target;
        } else if (v > target) {
            gas = false;
        }
        // Pressing the brake while steering hard above 70 km/h starts a drift, and a
        // drift barely brakes. Inside the car's brake-tap window keep a light hand on
        // the wheel (or coast); once the brake is held, trail braking is fine.
        if (brake && av > CAR.driftMinSpeed && this.brakeHeld <= CAR.driftTapTicks) {
            const hard = steer > DRIFT_STEER || steer < -DRIFT_STEER;
            if (hard && this.brakeHeld === 0 && v <= target + 8) {
                brake = false;
            } else if (hard || car.steer > DRIFT_STEER || car.steer < -DRIFT_STEER) {
                steer = clamp(steer, -DRIFT_STEER, DRIFT_STEER);
                // The car's steering lags the input; wait until it has come back.
                if (this.brakeHeld === 0 && (car.steer > DRIFT_STEER + 0.03 || car.steer < -DRIFT_STEER - 0.03)) brake = false;
            }
        }
        this.brakeHeld = brake ? this.brakeHeld + 1 : 0;
        return { steer: Math.round(steer * STEER_MAX), gas, brake };
    }

    /** Racing-line point at distance s (centerline + lateral offset). */
    _linePoint(s) {
        const r = this.route;
        const p = r.pointAt(s, this._pt);
        const i = p.index, j = Math.min(i + 1, r.count - 1);
        const L = r.segLens[i] || 1;
        const f = clamp((p.s - r.s[i]) / L, 0, 1);
        const off = this.offset[i] + (this.offset[j] - this.offset[i]) * f;
        const T = p.tangent, U = p.up, out = this._target;
        let x = T[1] * U[2] - T[2] * U[1], y = T[2] * U[0] - T[0] * U[2], z = T[0] * U[1] - T[1] * U[0];
        const l = Math.sqrt(x * x + y * y + z * z) || 1;
        x /= l; y /= l; z /= l;
        out[0] = p.point[0] + x * off; out[1] = p.point[1] + y * off; out[2] = p.point[2] + z * off;
        return out;
    }

    /** Requests a respawn; the tracker re-anchors progress and the stuck timer once it happens. */
    _respawn() {
        this.pendingRespawn = false;
        this.respawnCount++;
        this.offTicks = 0;
        this.brakeHeld = 0;
        return { steer: 0, gas: true, brake: false, respawn: true };
    }

    _loopAhead(s, look) {
        const r = this.route;
        const i0 = r.indexAt(s), i1 = r.indexAt(s + look);
        for (let i = i0, k = 0; k < 40; k++) {
            if (r.vcurvature[i] > LOOP_VCURV) return true;
            if (i === i1) break;
            i = this._at(i, 1);
        }
        return false;
    }

    /** Highest speed now that still lets the car slow down for every corner ahead. */
    _targetSpeed(index, s, car) {
        const r = this.route, n = r.count;
        const e = car.effects;
        const surf = car.surfaceUnder ? SURFACE_PARAMS[surfaceIndex(car.surfaceUnder)] : SURFACE_PARAMS[0];
        let decel = e.noBrake || e.cruise
            ? CAR.coastDecel + 1
            : CAR.brakeDecel * surf.brake * this.opts.brakeMargin;
        if (decel < 2) decel = 2;
        let best = Infinity;
        let i = index;
        let ahead = r.s[index] - s;
        for (let k = 0; k < n; k++) {
            if (ahead > SCAN_AHEAD) break;
            const va = this.vAllow[i];
            if (va !== Infinity) {
                const d = ahead > 0 ? ahead : 0;
                const vmax = Math.sqrt(va * va + 2 * decel * d);
                if (vmax < best) best = vmax;
            }
            if (i + 1 >= n) {
                if (!r.closed) break;
                i = 0;   // closed routes: the last point repeats the first
                continue;
            }
            ahead += r.segLens[i] || 0;
            i++;
        }
        return best;
    }
}

/**
 * Highest steady speed at route point i on a line with lateral curvature k and
 * vertical curvature kv (deck frame): the tyres must supply v²k, minus what a
 * banked deck's gravity gives, within grip × normal load, where the load is
 * gravity along the deck normal plus v²·kv (compressions add, crests take away).
 */
function cornerSpeed(r, R, i, k, kv, margin) {
    const ak = k < 0 ? -k : k;
    if (ak < 1e-5) return Infinity;
    const surfIdx = r.surface[i] === NO_SURFACE ? 0 : r.surface[i];
    const mu = SURFACE_PARAMS[surfIdx].grip * margin;
    const gLat = GRAVITY * R[i * 3 + 1] * (k > 0 ? 1 : -1);   // + = gravity pulls to the outside
    const gNorm = GRAVITY * r.ups[i * 3 + 1];
    const ok = (v) => {
        const v2 = v * v;
        const demand = v2 * ak + gLat;
        return (demand < 0 ? -demand : demand) <= mu * (gNorm + v2 * (kv + CAR.downforce));
    };
    let lo = 0, hi = 280;
    if (ok(hi)) return Infinity;
    if (!ok(lo)) return 0;
    for (let it = 0; it < 40; it++) {
        const mid = (lo + hi) / 2;
        if (ok(mid)) lo = mid; else hi = mid;
    }
    return lo;
}

function surfaceIndex(id) {
    return id === 'snow' ? 0 : id === 'powder' ? 1 : id === 'ice' ? 2 : id === 'ground' ? 3 : 4;
}

function rotate(out, q, x, y, z) {
    const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
    const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
    out[0] = x + qw * tx + (qy * tz - qz * ty);
    out[1] = y + qw * ty + (qz * tx - qx * tz);
    out[2] = z + qw * tz + (qx * ty - qy * tx);
    return out;
}

/**
 * Drives a whole run with the autopilot: proof that a track can be finished,
 * medal baselines, author ghosts. opts: { maxTicks = 60000, record = false,
 * maxRespawns = 40, giveUpAfter = 12 (respawns without reaching a new
 * checkpoint, lap or the finish), laps, ...autopilot options }.
 * Returns { finished, timeMs, ticks, respawns, checkpointTimes, lapTimes,
 * gaveUp, replay (with record: true; finished runs carry their time), sim,
 * pilot }. Throws when the world has no route (see world.routeError).
 */
export function runAutopilot(world, opts = {}) {
    const { maxTicks = 60000, record = false, maxRespawns = 40, giveUpAfter = 12, laps, ...pilotOpts } = opts;
    if (!world.route) throw new Error(`The autopilot needs a route: ${world.routeError || 'none was built'}`);
    const sim = new Sim(world, laps != null ? { laps } : {});
    const pilot = new Autopilot(world, pilotOpts);
    const rec = record ? new Recorder() : null;
    let gaveUp = false, marks = 0, respawnsAtMark = 0;
    while (!sim.finished && sim.tick < maxTicks) {
        sim.step(pilot.act(sim));
        if (rec) rec.push(sim.lastInput);
        const progress = sim.checkpointTimes.length + sim.lapTimes.length;
        if (progress !== marks) { marks = progress; respawnsAtMark = sim.respawns; }
        if (sim.respawns > maxRespawns || sim.respawns - respawnsAtMark > giveUpAfter) { gaveUp = true; break; }
    }
    return {
        finished: sim.finished,
        timeMs: sim.finished ? sim.finishTimeMs : null,
        ticks: sim.tick,
        respawns: sim.respawns,
        checkpointTimes: sim.checkpointTimes.slice(),
        lapTimes: sim.lapTimes.slice(),
        gaveUp,
        replay: rec ? rec.toReplay({ sim, name: 'Autopilot' }) : null,
        sim,
        pilot,
    };
}
