// Replays: per-tick inputs recorded during a run, a compact run-length text
// encoding, and deterministic re-simulation for ghosts and verification.
//
// A replay object:
//   { format: 1, trackId, trackHash, laps, inputs: '<encoded>', ticks, timeMs,
//     respawnTicks: [...], finished, date, name }
//
// Encoding (version prefix "1:"): runs joined by '.', each run is
//   <flags><steer>[*<count in base36>]
// flags is one letter 'A'..'H' = 'A' + (gas | brake << 1 | respawn << 2); steer
// is empty for 0, 'R' / 'L' for full lock, otherwise a signed base-36 integer.
// Example: 3 s of straight full gas then 0.5 s full right with gas: "1:B*8c.BR*1e".
// The encoding is canonical: decodeInputs accepts exactly what encodeInputs
// produces (no leading zeros, no '*1', no '0' or ±65536 as numbers, adjacent
// runs differ), so one input list has one string.
import { STEER_MAX } from './constants.js';
import { clampInput } from './input.js';
import { Sim } from './sim.js';
import { TWO_PI } from './mathd.js';
import { CAR } from './car.js';

export const REPLAY_FORMAT = 1;
/** Longest replay decodeInputs / simulateReplay accept by default: one hour of ticks. */
export const MAX_REPLAY_TICKS = 360000;
const PREFIX = '1:';
const RUN_RE = /^([A-H])(R|L|-?[1-9a-z][0-9a-z]*)?(?:\*([1-9a-z][0-9a-z]*))?$/;

function flagsOf(inp) {
    return (inp.gas ? 1 : 0) | (inp.brake ? 2 : 0) | (inp.respawn ? 4 : 0);
}

function steerToken(s) {
    if (s === 0) return '';
    if (s === STEER_MAX) return 'R';
    if (s === -STEER_MAX) return 'L';
    return s.toString(36);
}

/** Inputs (array of { steer, gas, brake, respawn? }) -> compact string. */
export function encodeInputs(inputs) {
    const runs = [];
    let prevKey = null, count = 0;
    const flush = () => {
        if (prevKey === null) return;
        runs.push(count > 1 ? `${prevKey}*${count.toString(36)}` : prevKey);
    };
    for (let i = 0; i < inputs.length; i++) {
        const inp = clampInput(inputs[i]);
        const key = String.fromCharCode(65 + flagsOf(inp)) + steerToken(inp.steer);
        if (key === prevKey) {
            count++;
        } else {
            flush();
            prevKey = key;
            count = 1;
        }
    }
    flush();
    return PREFIX + runs.join('.');
}

/**
 * Compact string -> array of normalized inputs. Throws on malformed or
 * non-canonical text and when it holds more than opts.maxTicks inputs (checked
 * before anything is allocated, so a hostile string cannot exhaust memory).
 */
export function decodeInputs(text, opts = {}) {
    const maxTicks = opts.maxTicks ?? MAX_REPLAY_TICKS;
    const runs = parseRuns(text, maxTicks);
    const out = [];
    for (const r of runs) {
        for (let k = 0; k < r.count; k++) {
            const inp = { steer: r.steer, gas: r.gas, brake: r.brake };
            if (r.respawn) inp.respawn = true;
            out.push(inp);
        }
    }
    return out;
}

/** Number of ticks an encoded string holds (validates it like decodeInputs, without expanding). */
export function countInputs(text, opts = {}) {
    let n = 0;
    for (const r of parseRuns(text, opts.maxTicks ?? MAX_REPLAY_TICKS)) n += r.count;
    return n;
}

function parseRuns(text, maxTicks) {
    if (typeof text !== 'string' || !text.startsWith(PREFIX)) throw new Error('Not a Penguintrack input string');
    const body = text.slice(PREFIX.length);
    const runs = [];
    if (body === '') return runs;
    let total = 0, prevHead = null;
    for (const run of body.split('.')) {
        const m = RUN_RE.exec(run);
        if (!m) throw new Error(`Bad input run '${run.slice(0, 40)}'`);
        const head = m[1] + (m[2] || '');
        if (head === prevHead) throw new Error(`Input run '${run}' repeats the previous run (not canonical)`);
        prevHead = head;
        let count = 1;
        if (m[3] !== undefined) {
            // Bounded before parsing: 7 base-36 digits already exceed any sane cap.
            if (m[3].length > 6) throw new Error('Replay too long');
            count = parseInt(m[3], 36);
            if (count < 2) throw new Error(`Bad run length in '${run}' (not canonical)`);
        }
        total += count;
        if (total > maxTicks) throw new Error(`Replay too long (more than ${maxTicks} ticks)`);
        const f = m[1].charCodeAt(0) - 65;
        const tok = m[2] || '';
        let steer = 0;
        if (tok === 'R') steer = STEER_MAX;
        else if (tok === 'L') steer = -STEER_MAX;
        else if (tok !== '') {
            if (tok.length > 5) throw new Error(`Steer out of range '${tok}'`);
            steer = parseInt(tok, 36);
            if (!(steer < STEER_MAX && steer > -STEER_MAX)) throw new Error(`Steer out of range '${tok}' (full lock is 'R' / 'L')`);
        }
        runs.push({ steer, gas: (f & 1) !== 0, brake: (f & 2) !== 0, respawn: (f & 4) !== 0, count });
    }
    return runs;
}

/**
 * Collects one input per simulated tick. Push `sim.lastInput` right after each
 * `sim.step()`: it is exactly what the tick simulated (normalised steer,
 * respawns requested through the flag or `sim.respawn()`, neutral after the
 * finish), so feeding the recording back through Sim.step reproduces the run.
 */
export class Recorder {
    constructor() {
        this.inputs = [];
    }

    get length() {
        return this.inputs.length;
    }

    /** Record one tick's input (normalised copy). */
    push(input) {
        this.inputs.push(clampInput(input));
    }

    /** Keep only the first `ticks` inputs (TAS rewinds, restarts). */
    truncate(ticks) {
        if (ticks < this.inputs.length) this.inputs.length = Math.max(0, ticks);
    }

    clear() {
        this.inputs.length = 0;
    }

    /** Input indices (= tick - 1) carrying a respawn flag. */
    respawnTicks() {
        const out = [];
        for (let i = 0; i < this.inputs.length; i++) if (this.inputs[i].respawn) out.push(i);
        return out;
    }

    /**
     * Builds a replay object. meta: { sim | world (or trackId + trackHash), laps,
     * timeMs, finished, name, date }. With `sim`, the world, lap count, finish
     * flag and time default to the sim's.
     */
    toReplay(meta = {}) {
        const sim = meta.sim || null;
        const world = meta.world || (sim ? sim.world : null);
        const finished = meta.finished ?? (sim ? sim.finished : false);
        return {
            format: REPLAY_FORMAT,
            trackId: meta.trackId ?? (world && world.track ? world.track.id : null),
            trackHash: meta.trackHash ?? (world ? world.hash ?? null : null),
            laps: meta.laps ?? (sim ? sim.laps : world ? world.laps ?? 1 : 1),
            inputs: encodeInputs(this.inputs),
            ticks: this.inputs.length,
            timeMs: meta.timeMs ?? (sim && sim.finished ? sim.finishTimeMs : null),
            finished: !!finished,
            respawnTicks: this.respawnTicks(),
            date: meta.date ?? null,
            name: meta.name ?? '',
        };
    }
}

/** Inputs of a replay (accepts an encoded string or an input array). */
export function replayInputs(replay, opts = {}) {
    const src = replay.inputs;
    if (typeof src === 'string') return decodeInputs(src, opts);
    if (!Array.isArray(src)) throw new Error('Replay has no inputs');
    const max = opts.maxTicks ?? MAX_REPLAY_TICKS;
    if (src.length > max) throw new Error(`Replay too long (more than ${max} ticks)`);
    return src.map(clampInput);
}

function snapshot(sim, teleport) {
    const c = sim.car;
    return {
        tick: sim.tick,
        pos: c.pos.slice(),
        quat: c.quat.slice(),
        vel: c.vel.slice(),
        speedKmh: c.speedKmh,
        steer: c.steer,
        airborne: c.airborne,
        drifting: c.drifting,
        teleport,
        wheels: c.wheels.map((w) => ({ compression: w.compression, steer: w.steer, spin: w.spin, contact: w.contact })),
    };
}

/**
 * Re-simulates a replay. opts: { sampleEvery = 1 (ticks; 0 = no samples),
 * stopAtFinish = true, laps (default: replay.laps, else the world's),
 * maxTicks = MAX_REPLAY_TICKS, onTick(sim, input) }.
 * Returns { finished, timeMs, ticks, respawns, respawnTicks, checkpointTimes,
 * lapTimes, samples, sim }. respawnTicks are the input indices whose tick began
 * with a respawn. samples hold { tick, pos, quat, vel, speedKmh, steer,
 * airborne, drifting, teleport, wheels } for ghosts; `teleport` is true when a
 * respawn happened since the previous sample (do not interpolate across it).
 */
export function simulateReplay(world, replay, opts = {}) {
    const every = opts.sampleEvery ?? 1;
    const inputs = replayInputs(replay, opts);
    const laps = opts.laps ?? replay.laps ?? undefined;
    const sim = new Sim(world, laps != null ? { laps } : {});
    const samples = [];
    const respawnTicks = [];
    if (every > 0) samples.push(snapshot(sim, false));
    let teleport = false;
    for (let i = 0; i < inputs.length; i++) {
        sim.step(inputs[i]);
        if (sim.lastInput.respawn) respawnTicks.push(i);
        if (sim.events.length) for (const ev of sim.events) if (ev.type === 'respawn') teleport = true;
        if (opts.onTick) opts.onTick(sim, inputs[i]);
        if (every > 0 && sim.tick % every === 0) {
            samples.push(snapshot(sim, teleport));
            teleport = false;
        }
        if (sim.finished && opts.stopAtFinish !== false) break;
    }
    if (every > 0 && samples[samples.length - 1].tick !== sim.tick) samples.push(snapshot(sim, teleport));
    return {
        finished: sim.finished,
        timeMs: sim.finished ? sim.finishTimeMs : null,
        ticks: sim.tick,
        respawns: sim.respawns,
        respawnTicks,
        checkpointTimes: sim.checkpointTimes.slice(),
        lapTimes: sim.lapTimes.slice(),
        samples,
        sim,
    };
}

/**
 * Checks that a replay belongs to this world and that every claim it makes is
 * what re-simulating it gives: track hash (required), tick count, finish flag,
 * time, and respawn ticks (up to the finish). opts.requireFinish (default
 * true) also rejects replays that do not finish, since records and ghosts are
 * finished runs. Returns { ok, reason, finished, timeMs, respawns }.
 */
export function verifyReplay(world, replay, opts = {}) {
    const fail = (reason, base = null) => ({ ok: false, reason, finished: base ? base.finished : false, timeMs: base ? base.timeMs : null, respawns: base ? base.respawns : 0 });
    if (!replay || typeof replay !== 'object') return fail('Not a replay');
    if (!replay.trackHash) return fail('Replay has no track hash');
    if (!world.hash || replay.trackHash !== world.hash) return fail('Replay was recorded on a different track layout');
    let res, count;
    try {
        count = typeof replay.inputs === 'string' ? countInputs(replay.inputs) : replayInputs(replay).length;
        if (replay.ticks != null && replay.ticks !== count) return fail(`Replay says ${replay.ticks} ticks but holds ${count} inputs`);
        res = simulateReplay(world, replay, { sampleEvery: 0 });
    } catch (e) {
        return fail(e.message);
    }
    const base = { finished: res.finished, timeMs: res.timeMs, respawns: res.respawns };
    const requireFinish = opts.requireFinish !== false;
    if ((requireFinish || replay.finished) && !res.finished) return fail('Replay does not reach the finish', base);
    if (replay.finished != null && !!replay.finished !== res.finished) return fail('Replay claims it did not finish, but it does', base);
    if (res.finished && replay.timeMs == null) return fail('Replay has no time', base);
    if (replay.timeMs != null && res.timeMs !== replay.timeMs) {
        return fail(`Time mismatch: replay says ${replay.timeMs} ms, simulation gives ${res.timeMs} ms`, base);
    }
    if (replay.respawnTicks != null) {
        const claimed = Array.isArray(replay.respawnTicks) ? replay.respawnTicks.filter((t) => t < res.ticks) : null;
        const same = claimed && claimed.length === res.respawnTicks.length && claimed.every((t, i) => t === res.respawnTicks[i]);
        if (!same) return fail('Respawn ticks do not match the simulation', base);
    }
    return { ok: true, reason: null, ...base };
}

/**
 * Interpolated ghost pose at a fractional tick from simulateReplay samples
 * (renderer helper). Never interpolates across a respawn (snaps to the later
 * sample). Pass `out.wheels` (4 objects) to also get wheel compression, steer,
 * contact and spin; spin advances by the distance travelled, so fast wheels
 * never appear to turn backwards.
 */
export function ghostPoseAt(samples, tick, out = { pos: [0, 0, 0], quat: [0, 0, 0, 1], speedKmh: 0 }) {
    if (!samples.length) return null;
    let lo = 0, hi = samples.length - 1;
    if (tick <= samples[0].tick) return copyPose(samples[0], out);
    if (tick >= samples[hi].tick) return copyPose(samples[hi], out);
    while (hi - lo > 1) {
        const m = (lo + hi) >> 1;
        if (samples[m].tick <= tick) lo = m; else hi = m;
    }
    const a = samples[lo], b = samples[hi];
    if (b.teleport) return copyPose(b, out);
    const f = (tick - a.tick) / (b.tick - a.tick);
    lerpPose(a, b, f, out);
    return out;
}

/** Pose interpolation shared by ghostPoseAt (a, b: samples or car snapshots). */
function lerpPose(a, b, f, out) {
    for (let k = 0; k < 3; k++) out.pos[k] = a.pos[k] + (b.pos[k] - a.pos[k]) * f;
    const d = a.quat[0] * b.quat[0] + a.quat[1] * b.quat[1] + a.quat[2] * b.quat[2] + a.quat[3] * b.quat[3];
    const sgn = d < 0 ? -1 : 1;
    let l = 0;
    for (let k = 0; k < 4; k++) {
        out.quat[k] = a.quat[k] + (b.quat[k] * sgn - a.quat[k]) * f;
        l += out.quat[k] * out.quat[k];
    }
    l = Math.sqrt(l) || 1;
    for (let k = 0; k < 4; k++) out.quat[k] /= l;
    out.speedKmh = a.speedKmh + (b.speedKmh - a.speedKmh) * f;
    if (out.wheels && a.wheels && b.wheels) {
        const travel = forwardTravel(a, b);
        for (let i = 0; i < 4; i++) {
            const wa = a.wheels[i], wb = b.wheels[i], w = out.wheels[i];
            w.compression = wa.compression + (wb.compression - wa.compression) * f;
            w.steer = wa.steer + (wb.steer - wa.steer) * f;
            w.contact = f < 0.5 ? wa.contact : wb.contact;
            w.spin = lerpSpin(wa.spin, wb.spin, travel / CAR.wheelRadius, f);
        }
    }
}

/** Distance moved along a's forward axis between two poses (sign = rolling direction). */
function forwardTravel(a, b) {
    const q = a.quat;
    // Car-local +Z rotated by q.
    const fx = 2 * (q[0] * q[2] + q[3] * q[1]);
    const fy = 2 * (q[1] * q[2] - q[3] * q[0]);
    const fz = 1 - 2 * (q[0] * q[0] + q[1] * q[1]);
    return (b.pos[0] - a.pos[0]) * fx + (b.pos[1] - a.pos[1]) * fy + (b.pos[2] - a.pos[2]) * fz;
}

/** Spin between two wrapped angles: the turn count closest to `expected` radians, then wrapped. */
function lerpSpin(sa, sb, expected, f) {
    let d = sb - sa;
    d += TWO_PI * Math.round((expected - d) / TWO_PI);
    const s = sa + d * f;
    return s - TWO_PI * Math.floor(s / TWO_PI);
}

function copyPose(s, out) {
    for (let k = 0; k < 3; k++) out.pos[k] = s.pos[k];
    for (let k = 0; k < 4; k++) out.quat[k] = s.quat[k];
    out.speedKmh = s.speedKmh;
    if (out.wheels && s.wheels) {
        for (let i = 0; i < 4; i++) {
            const w = out.wheels[i], ws = s.wheels[i];
            w.compression = ws.compression; w.steer = ws.steer; w.contact = ws.contact; w.spin = ws.spin;
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// Car view snapshots (renderer, audio, ghosts, multiplayer)

function makeSnapshot() {
    const wheel = () => ({ contact: false, surface: null, compression: 0, steer: 0, spin: 0, pos: [0, 0, 0], slip: 0 });
    return {
        pos: [0, 0, 0], quat: [0, 0, 0, 1], vel: [0, 0, 0], angVel: [0, 0, 0],
        speed: 0, speedKmh: 0, forwardSpeed: 0, steer: 0, rpm: 0, gear: 1,
        airborne: false, drifting: false, slipAngle: 0, surfaceUnder: null,
        wheels: [wheel(), wheel(), wheel(), wheel()],
        effects: { turbo: 0, turboTime: 0, noEngine: false, noSteer: false, noBrake: false, slowmo: 0, cruise: false, cruiseSpeed: 0, fragile: false, broken: false },
    };
}

/**
 * Copies everything a renderer or audio engine reads from `sim.car` into `out`
 * (allocated when omitted). The car's own arrays are reused every tick, so keep
 * snapshots of the previous and current tick and interpolate between them.
 */
export function snapshotCar(car, out = null) {
    const o = out || makeSnapshot();
    for (let k = 0; k < 3; k++) { o.pos[k] = car.pos[k]; o.vel[k] = car.vel[k]; o.angVel[k] = car.angVel[k]; }
    for (let k = 0; k < 4; k++) o.quat[k] = car.quat[k];
    o.speed = car.speed; o.speedKmh = car.speedKmh; o.forwardSpeed = car.forwardSpeed; o.steer = car.steer;
    o.rpm = car.rpm; o.gear = car.gear; o.airborne = car.airborne; o.drifting = car.drifting;
    o.slipAngle = car.slipAngle; o.surfaceUnder = car.surfaceUnder;
    for (let i = 0; i < 4; i++) {
        const w = o.wheels[i], cw = car.wheels[i];
        w.contact = cw.contact; w.surface = cw.surface; w.compression = cw.compression; w.steer = cw.steer;
        w.spin = cw.spin; w.slip = cw.slip;
        w.pos[0] = cw.pos[0]; w.pos[1] = cw.pos[1]; w.pos[2] = cw.pos[2];
    }
    Object.assign(o.effects, car.effects);
    return o;
}

/**
 * Interpolates two snapshots (alpha 0 = a, 1 = b) into `out`. Continuous values
 * blend (quaternions by normalised lerp on the short arc, wheel spin by the
 * distance travelled); discrete ones (gear, flags, surfaces, effects) come
 * from b. After a respawn, draw b without blending.
 */
export function lerpCarSnapshot(a, b, alpha, out = null) {
    const o = out || makeSnapshot();
    const f = alpha;
    lerpPose(a, b, f, o);
    for (let k = 0; k < 3; k++) {
        o.vel[k] = a.vel[k] + (b.vel[k] - a.vel[k]) * f;
        o.angVel[k] = a.angVel[k] + (b.angVel[k] - a.angVel[k]) * f;
    }
    o.speed = a.speed + (b.speed - a.speed) * f;
    o.forwardSpeed = a.forwardSpeed + (b.forwardSpeed - a.forwardSpeed) * f;
    o.steer = a.steer + (b.steer - a.steer) * f;
    o.rpm = a.rpm + (b.rpm - a.rpm) * f;
    o.slipAngle = a.slipAngle + (b.slipAngle - a.slipAngle) * f;
    o.gear = b.gear; o.airborne = b.airborne; o.drifting = b.drifting; o.surfaceUnder = b.surfaceUnder;
    for (let i = 0; i < 4; i++) {
        const w = o.wheels[i], wa = a.wheels[i], wb = b.wheels[i];
        for (let k = 0; k < 3; k++) w.pos[k] = wa.pos[k] + (wb.pos[k] - wa.pos[k]) * f;
        w.slip = wa.slip + (wb.slip - wa.slip) * f;
        w.surface = wb.surface;
    }
    Object.assign(o.effects, b.effects);
    return o;
}
