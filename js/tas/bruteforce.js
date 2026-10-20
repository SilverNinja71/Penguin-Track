// Bruteforce optimiser in the spirit of TMInterface's: start from a base run,
// randomly modify its inputs inside a time window, re-simulate, and keep the
// change when the target gets strictly better. Every candidate restarts from a
// savestate of the base run at its first modified tick, so a change late in
// the run costs only the ticks after it, and a candidate that cannot beat the
// best any more (still racing at the best finish tick) is abandoned early.
//
// Deterministic: the same world, base, options and seed give the same
// improvements after the same number of iterations, however the iterations
// are batched (loop, Web Worker or Node).
import { TICK_MS } from '../core/constants.js';
import { segmentAABB } from '../core/collision.js';
import { Sim } from '../core/sim.js';
import { Rng } from '../core/rng.js';
import { clampSteer } from '../core/input.js';
import { buildWorld } from '../core/track.js';
import { decodeTrack } from '../core/codec.js';
import { formatTime } from '../core/format.js';
import { InputTimeline, GAS, BRAKE, MAX_TICKS } from './timeline.js';
import { runLimit } from './runner.js';
import { parse } from './script.js';

export const BRUTEFORCE_DEFAULTS = {
    target: 'finish',
    window: null,        // { from, to } ticks (to exclusive); default: the whole base run
    seed: 1,
    laps: undefined,
    maxTicks: undefined, // absolute tick limit (default: base timeline + 60 s)
    cacheEvery: 4,       // ticks between base-run savestates (restart granularity)
    rules: {
        maxChanges: 3,                                   // modifications per candidate: 1..maxChanges
        shift: { weight: 1, range: 3 },                  // move an input change by ±1..range ticks
        steer: { weight: 2, range: 8000, span: 12 },     // add ±1..range to the steering of 1..span ticks
        gas: { weight: 0.5, span: 10 },                  // toggle gas on 1..span ticks
        brake: { weight: 0.5, span: 10 },                // toggle brake on 1..span ticks
    },
};

const KINDS = ['shift', 'steer', 'gas', 'brake'];

// ---------------------------------------------------------------------------
// Targets: { name, stopTick, stopAtFinish, begin(sim) -> acc, tick(sim, acc, prevPos) -> stop?,
//            score(sim, acc) -> number[] (lower is better), bound(bestScore) -> tick, describe(score) }

/** Lexicographic comparison of scores (numbers or arrays): < 0 when a is better (lower). */
export function compareScores(a, b) {
    const x = Array.isArray(a) ? a : [a], y = Array.isArray(b) ? b : [b];
    const n = Math.max(x.length, y.length);
    for (let i = 0; i < n; i++) {
        const p = x[i] ?? -Infinity, q = y[i] ?? -Infinity;
        if (p < q) return -1;
        if (p > q) return 1;
    }
    return 0;
}

/** Entry fraction of the car's swept segment into the earliest of `triggers` (1 when none is entered). */
function crossing(prev, pos, triggers) {
    let best = 1;
    for (const t of triggers) {
        const f = segmentAABB(prev, pos, t);
        if (f >= 0 && f < best) best = f;
    }
    return best;
}

/** Ranking of a run that missed the goal: more checkpoints, then further along the route. */
function progressOf(sim, world) {
    const cps = sim.checkpointTimes.length + sim.lapTimes.length;
    let s = 0;
    if (world.route) s = world.route.project(sim.car.pos).s;
    return [-cps, -s];
}

function finishTarget(world, mode) {
    const lines = world.triggers.filter((t) => t.type === 'finish' || t.type === 'startfinish');
    const platform = mode === 'platform';
    return {
        name: 'finish',
        begin: () => ({ frac: 1 }),
        tick(sim, acc, prev) {
            if (!sim.finished) return false;
            acc.frac = crossing(prev, sim.car.pos, lines);
            return true;
        },
        // [0, respawns (platform), finish tick, sub-tick crossing] or [1, -checkpoints, -route metres]
        score: (sim, acc) => (sim.finished
            ? [0, platform ? sim.respawns : 0, sim.finishTimeMs / TICK_MS, acc.frac]
            : [1, ...progressOf(sim, world)]),
        bound: (best) => (best[0] === 0 && !platform ? best[2] : Infinity),
        describe(score) {
            if (score[0] !== 0) return `no finish (${-score[1]} checkpoints, ${(-score[2]).toFixed(1)} m)`;
            const precise = (score[2] - 1 + score[3]) * TICK_MS;
            return `finish ${formatTime(score[2] * TICK_MS)} (precise ${(precise / 1000).toFixed(5)} s)${platform ? `, ${score[1]} respawns` : ''}`;
        },
        timeMs: (score) => (score[0] === 0 ? score[2] * TICK_MS : null),
    };
}

function checkpointTarget(world, index) {
    if (!(Number.isInteger(index) && index >= 1)) throw new Error(`Checkpoint target needs a crossing number >= 1, got ${index}`);
    const byId = world.triggers.filter((t) => t.type === 'checkpoint');
    return {
        name: `checkpoint ${index}`,
        begin: () => ({ tick: -1, frac: 1 }),
        tick(sim, acc, prev) {
            if (sim.checkpointTimes.length < index) return false;
            const ev = sim.events.find((e) => e.type === 'checkpoint');
            const trg = ev ? byId.filter((t) => t.id === ev.id) : byId;
            acc.tick = sim.tick;
            acc.frac = crossing(prev, sim.car.pos, trg);
            return true;
        },
        score: (sim, acc) => (acc.tick >= 0 ? [0, acc.tick, acc.frac] : [1, ...progressOf(sim, world)]),
        bound: (best) => (best[0] === 0 ? best[1] : Infinity),
        describe: (score) => (score[0] === 0
            ? `checkpoint ${index} at ${formatTime(score[1] * TICK_MS)} (precise ${(((score[1] - 1 + score[2]) * TICK_MS) / 1000).toFixed(5)} s)`
            : `checkpoint ${index} not reached`),
        timeMs: (score) => (score[0] === 0 ? score[1] * TICK_MS : null),
    };
}

function speedTarget(tick) {
    if (!(Number.isInteger(tick) && tick > 0)) throw new Error(`Speed target needs a tick > 0, got ${tick}`);
    return {
        name: `speed at ${formatTime(tick * TICK_MS)}`,
        stopTick: tick,
        stopAtFinish: false,
        score: (sim) => [-sim.car.speed],
        describe: (score) => `${(-score[0] * 3.6).toFixed(3)} km/h at ${formatTime(tick * TICK_MS)}`,
    };
}

function positionTarget(point, tick, mode = 'min') {
    if (!Array.isArray(point) || point.length !== 3 || !point.every(Number.isFinite)) throw new Error('Position target needs a point [x, y, z]');
    if (!(Number.isInteger(tick) && tick > 0)) throw new Error(`Position target needs a tick > 0, got ${tick}`);
    if (mode !== 'min' && mode !== 'at') throw new Error(`Position mode is 'min' or 'at', got '${mode}'`);
    const dist = (p) => Math.sqrt((p[0] - point[0]) ** 2 + (p[1] - point[1]) ** 2 + (p[2] - point[2]) ** 2);
    return {
        name: `position ${point.join(',')} by ${formatTime(tick * TICK_MS)}`,
        stopTick: tick,
        stopAtFinish: false,
        begin: (sim) => ({ best: dist(sim.car.pos), at: sim.tick }),
        tick(sim, acc) {
            if (mode === 'min') {
                const d = dist(sim.car.pos);
                if (d < acc.best) { acc.best = d; acc.at = sim.tick; }
            }
            return false;
        },
        // Closest approach (or distance at the tick), then the earlier tick.
        score: (sim, acc) => (mode === 'min' ? [acc.best, acc.at] : [dist(sim.car.pos)]),
        describe: (score) => `${score[0].toFixed(4)} m from the point${mode === 'min' ? ` at ${formatTime(score[1] * TICK_MS)}` : ''}`,
    };
}

/**
 * Turns a target spec into an evaluator. Specs: 'finish'; { type: 'finish' };
 * { type: 'checkpoint', index }; { type: 'speed', tick }; { type: 'position',
 * point, tick, mode: 'min' | 'at' }; a custom evaluator object (anything with
 * score(sim, acc)); a function(sim) -> score; or { type: 'custom', source }
 * (JS source of such an object or function, for workers).
 */
export function resolveTarget(spec, world) {
    if (spec == null || spec === 'finish') return finishTarget(world, world.mode);
    if (typeof spec === 'function') return customTarget({ score: spec });
    if (typeof spec === 'string') return resolveTarget(parseTargetSpec(spec), world);
    if (typeof spec.score === 'function') return customTarget(spec);
    switch (spec.type) {
        case 'finish': return finishTarget(world, world.mode);
        case 'checkpoint': return checkpointTarget(world, spec.index);
        case 'speed': return speedTarget(spec.tick);
        case 'position': return positionTarget(spec.point, spec.tick, spec.mode);
        case 'custom': {
            if (typeof spec.source !== 'string') throw new Error('Custom target needs `source`');
            // The user's own evaluator code, run where the user asked for it (their browser or Node).
            const made = new Function(`"use strict"; return (${spec.source});`)();
            return customTarget(typeof made === 'function' ? { score: made } : made);
        }
        default: throw new Error(`Unknown bruteforce target '${spec.type}'`);
    }
}

function customTarget(t) {
    if (typeof t.score !== 'function') throw new Error('A custom target needs score(sim, acc)');
    return {
        name: t.name || 'custom',
        stopTick: t.stopTick ?? null,
        stopAtFinish: t.stopAtFinish !== false,
        begin: t.begin ? (sim) => t.begin(sim) : () => ({}),
        tick: t.tick ? (sim, acc, prev) => !!t.tick(sim, acc, prev) : null,
        score: (sim, acc) => {
            const s = t.score(sim, acc);
            const arr = Array.isArray(s) ? s : [s];
            if (!arr.every((v) => typeof v === 'number' && !Number.isNaN(v))) throw new Error('A custom score must be a number or an array of numbers');
            return arr;
        },
        bound: t.bound || null,
        describe: t.describe || ((score) => `score ${score.map((v) => +v.toFixed(6)).join(', ')}`),
    };
}

/**
 * CLI-style target text: 'finish', 'checkpoint:2', 'speed@12.5' (seconds),
 * 'position:x,y,z@12.5' (closest approach by then) or 'position-at:x,y,z@12.5'.
 */
export function parseTargetSpec(text) {
    const s = String(text).trim();
    if (s === 'finish') return { type: 'finish' };
    let m = /^checkpoint:(\d+)$/.exec(s);
    if (m) return { type: 'checkpoint', index: Number(m[1]) };
    m = /^speed@([\d.]+)$/.exec(s);
    if (m) return { type: 'speed', tick: secondsToTick(m[1]) };
    m = /^position(-at)?:(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)@([\d.]+)$/.exec(s);
    if (m) return { type: 'position', point: [Number(m[2]), Number(m[3]), Number(m[4])], tick: secondsToTick(m[5]), mode: m[1] ? 'at' : 'min' };
    throw new Error(`Unknown target '${s}' (finish, checkpoint:N, speed@SECONDS, position:x,y,z@SECONDS)`);
}

function secondsToTick(text) {
    const v = Number(text);
    if (!Number.isFinite(v) || v < 0) throw new Error(`Bad time '${text}'`);
    return Math.round(v * 100);
}

// ---------------------------------------------------------------------------

function mergeRules(rules = {}) {
    const d = BRUTEFORCE_DEFAULTS.rules;
    const out = { maxChanges: rules.maxChanges ?? d.maxChanges };
    for (const k of KINDS) out[k] = { ...d[k], ...(rules[k] || {}) };
    return out;
}

function cloneAcc(acc) {
    return acc && typeof acc === 'object' ? structuredClone(acc) : acc;
}

export class Bruteforce {
    /**
     * world: from buildWorld; timeline: the base run (not modified; see `best`).
     * opts: BRUTEFORCE_DEFAULTS shape (rules are merged per kind).
     */
    constructor(world, timeline, opts = {}) {
        this.world = world;
        this.opts = { ...BRUTEFORCE_DEFAULTS, ...opts, rules: mergeRules(opts.rules) };
        this.rules = this.opts.rules;
        this.seed = this.opts.seed >>> 0;
        this.rng = new Rng(this.seed);
        this.target = resolveTarget(this.opts.target, world);
        this.laps = this.opts.laps ?? world.laps ?? 1;
        this.sim = new Sim(world, { laps: this.laps });
        // Targets measured at a tick simulate exactly that far; the rest to the finish or the run limit.
        this.limit = this.target.stopTick != null ? Math.min(MAX_TICKS, this.target.stopTick) : runLimit(timeline, this.opts.maxTicks);
        this.base = timeline.clone().materialize(this.limit);
        this.cand = this.base.clone();
        this.iterations = 0;
        this.evaluated = 0;
        this.ticksSimulated = 0;
        this.improvements = [];
        this._prev = [0, 0, 0];
        this._inp = {};
        this._cache = [];
        const weights = KINDS.map((k) => Math.max(0, Number(this.rules[k].weight) || 0));
        this._weightSum = weights.reduce((a, b) => a + b, 0);
        if (!(this._weightSum > 0)) throw new Error('Every modification weight is 0');
        this._weights = weights;

        // The base run fills the savestate cache and sets the score to beat.
        this.cacheEvery = Math.max(1, Math.floor(this.opts.cacheEvery), Math.ceil(this.limit / 6000));
        const w = this.opts.window;
        this._cacheStart = Math.max(0, (w && w.from != null ? Math.floor(w.from) : 0) - this.cacheEvery);
        this.sim.reset();
        const acc0 = this.target.begin ? this.target.begin(this.sim) : {};
        this._cache[0] = { state: this.sim.getState(), acc: cloneAcc(acc0) };
        const base = this._simulate(this.base, 0, Infinity, true);
        this.best = { score: base.score, ticks: base.ticks, iteration: 0, firstTick: -1 };
        this.initial = { ...this.best };
        this._updateWindow();
    }

    /** Human-readable text of a score (or of the best one). */
    describe(score = this.best.score) {
        return this.target.describe(score);
    }

    /** Best race time in ms for time targets (finish / checkpoint), else null. */
    bestTimeMs() {
        return this.target.timeMs ? this.target.timeMs(this.best.score) : null;
    }

    /**
     * The best timeline so far (a copy): cut at the finish for the finish
     * target (later inputs never play), with held repeats trimmed.
     */
    bestTimeline() {
        const tl = this.base.clone();
        if (this.target.name === 'finish' && this.best.score[0] === 0) tl.truncate(this.best.ticks);
        return tl.compact();
    }

    /** One iteration; returns the improvement record when it improved, else null. */
    step() {
        this.iterations++;
        const first = this._mutate();
        if (first < 0) return null;
        this.evaluated++;
        const bound = this.target.bound ? this.target.bound(this.best.score) : Infinity;
        const res = this._simulate(this.cand, first, bound, false);
        if (res.bounded || compareScores(res.score, this.best.score) >= 0) return null;
        // Accept: the candidate becomes the base; refresh the cache after its first change.
        this._copy(this.base, this.cand);
        const again = this._simulate(this.base, first, Infinity, true);
        this.best = { score: again.score, ticks: again.ticks, iteration: this.iterations, firstTick: first };
        this._updateWindow();
        const rec = {
            iteration: this.iterations, score: again.score, text: this.describe(again.score),
            timeMs: this.bestTimeMs(), firstTick: first, timeline: this.bestTimeline(),
        };
        this.improvements.push(rec);
        return rec;
    }

    /** Runs n iterations; returns the improvements found in them. */
    run(n) {
        const found = [];
        for (let i = 0; i < n; i++) {
            const r = this.step();
            if (r) found.push(r);
        }
        return found;
    }

    /** Runs iterations for about `ms` milliseconds (at least one); returns the improvements found. */
    runFor(ms) {
        const found = [];
        const end = performance.now() + ms;
        do {
            for (let i = 0; i < 8; i++) {
                const r = this.step();
                if (r) found.push(r);
            }
        } while (performance.now() < end);
        return found;
    }

    /** Counters for progress displays. */
    stats() {
        return {
            iterations: this.iterations, evaluated: this.evaluated, improvements: this.improvements.length,
            ticksSimulated: this.ticksSimulated, window: { ...this.window }, best: this.describe(),
        };
    }

    // -----------------------------------------------------------------

    /**
     * Simulates `tl` from the cached base state at or before `from` until the
     * target stops, the run limit, or `bound` (a tick the run must not reach
     * unfinished). capture: refresh the cache along the way (base runs only).
     */
    _simulate(tl, from, bound, capture) {
        const ce = this.cacheEvery, sim = this.sim, tgt = this.target, prev = this._prev, inp = this._inp;
        let k = Math.floor(from / ce);
        while (k > 0 && !this._cache[k]) k--;
        const entry = this._cache[k];
        sim.setState(entry.state);
        let acc = cloneAcc(entry.acc);
        if (capture) this._cache.length = k + 1;
        const stop = Math.min(this.limit, tgt.stopTick ?? Infinity);
        const stopAtFinish = tgt.stopAtFinish !== false;
        const start = sim.tick;
        let bounded = false;
        while (sim.tick < stop) {
            if (sim.tick >= bound) { bounded = true; break; }
            const p = sim.car.pos;
            prev[0] = p[0]; prev[1] = p[1]; prev[2] = p[2];
            tl.get(sim.tick, inp);
            sim.step(inp);
            if (tgt.tick && tgt.tick(sim, acc, prev)) break;
            if (stopAtFinish && sim.finished) break;
            if (capture && sim.tick % ce === 0 && sim.tick >= this._cacheStart) {
                this._cache[sim.tick / ce] = { state: sim.getState(), acc: cloneAcc(acc) };
            }
        }
        this.ticksSimulated += sim.tick - start;
        if (bounded) return { bounded: true, ticks: sim.tick };
        return { bounded: false, score: tgt.score(sim, acc), ticks: sim.tick };
    }

    _updateWindow() {
        const w = this.opts.window;
        const end = Math.min(this.best.ticks, this.limit);
        const from = Math.max(0, Math.floor(w && w.from != null ? w.from : 0));
        const to = Math.min(end, Math.floor(w && w.to != null ? w.to : end));
        this.window = { from, to: Math.max(from, to) };
        this._events = null;
    }

    /** Input changes (tick, channel) inside the window, for the shift rule. */
    _changeEvents() {
        if (this._events) return this._events;
        const ev = [];
        const { from, to } = this.window;
        const s = this.base.steer, f = this.base.flags;
        for (let t = Math.max(1, from); t <= to && t < this.base.length; t++) {
            if (s[t] !== s[t - 1]) ev.push(t * 3);
            if ((f[t] ^ f[t - 1]) & GAS) ev.push(t * 3 + 1);
            if ((f[t] ^ f[t - 1]) & BRAKE) ev.push(t * 3 + 2);
        }
        this._events = ev;
        return ev;
    }

    _copy(dst, src) {
        dst.steer.set(src.steer.subarray(0, src.length));
        dst.flags.set(src.flags.subarray(0, src.length));
    }

    /** Builds the next candidate in `cand`; returns its first changed tick, or -1 for a no-op. */
    _mutate() {
        const { from, to } = this.window;
        const cand = this.cand, base = this.base, rng = this.rng, R = this.rules;
        this._copy(cand, base);
        if (to <= from) return -1;
        const n = 1 + rng.int(Math.max(1, R.maxChanges));
        let lo = Infinity, hi = -1;
        const mark = (a, b) => { if (a < lo) lo = a; if (b > hi) hi = b; };
        for (let c = 0; c < n; c++) {
            let kind = this._pickKind();
            if (kind === 'shift' && !this._changeEvents().length) kind = 'steer';
            if (kind === 'shift') {
                const ev = this._changeEvents();
                const e = ev[rng.int(ev.length)];
                const t = Math.floor(e / 3), ch = e % 3;
                const range = Math.max(1, R.shift.range | 0);
                let d = 1 + rng.int(range);
                if (rng.next() < 0.5) d = -d;
                const r = this._shift(t, ch, d, from, to);
                if (r) mark(r[0], r[1]);
            } else if (kind === 'steer') {
                const t0 = from + rng.int(to - from);
                const t1 = Math.min(to, t0 + 1 + rng.int(Math.max(1, R.steer.span | 0)));
                const range = Math.max(1, R.steer.range | 0);
                let delta = 1 + rng.int(range);
                if (rng.next() < 0.5) delta = -delta;
                for (let t = t0; t < t1; t++) cand.steer[t] = clampSteer(cand.steer[t] + delta);
                mark(t0, t1);
            } else {
                const bit = kind === 'gas' ? GAS : BRAKE;
                const t0 = from + rng.int(to - from);
                const t1 = Math.min(to, t0 + 1 + rng.int(Math.max(1, R[kind].span | 0)));
                for (let t = t0; t < t1; t++) cand.flags[t] ^= bit;
                mark(t0, t1);
            }
        }
        if (hi < 0) return -1;
        // Changes can cancel out (a toggle twice, a clamped nudge): find the real first difference.
        for (let t = lo; t < hi; t++) if (cand.steer[t] !== base.steer[t] || cand.flags[t] !== base.flags[t]) return t;
        return -1;
    }

    _pickKind() {
        let r = this.rng.next() * this._weightSum;
        for (let i = 0; i < KINDS.length; i++) {
            r -= this._weights[i];
            if (r < 0) return KINDS[i];
        }
        return KINDS[KINDS.length - 1];
    }

    /** Moves the input change at tick t on channel ch (0 steer, 1 gas, 2 brake) by d ticks. Returns the touched range. */
    _shift(t, ch, d, from, to) {
        const cand = this.cand;
        const get = ch === 0 ? (i) => cand.steer[i] : (i) => cand.flags[i] & (ch === 1 ? GAS : BRAKE);
        const put = ch === 0 ? (i, v) => { cand.steer[i] = v; } : (i, v) => {
            const bit = ch === 1 ? GAS : BRAKE;
            cand.flags[i] = v ? cand.flags[i] | bit : cand.flags[i] & ~bit;
        };
        const before = get(t - 1), after = get(t);
        if (before === after) return null;
        let a = Infinity, b = -1;
        if (d > 0) {
            // Later: the old value lasts d more ticks (only over the new value's own run).
            for (let i = t; i < t + d && i < to && get(i) === after; i++) {
                if (i < from) continue;
                put(i, before); a = Math.min(a, i); b = i + 1;
            }
        } else {
            // Earlier: the new value starts up to -d ticks sooner (only over the old value's run).
            for (let i = t - 1; i >= t + d && i >= from && get(i) === before; i--) {
                put(i, after); a = Math.min(a, i); b = Math.max(b, i + 1);
            }
        }
        return b < 0 ? null : [a, b];
    }
}

// ---------------------------------------------------------------------------
// Worker / host protocol (js/tas/bruteforce-worker.js is a thin shell around this)

/**
 * Drives a Bruteforce from messages, posting progress back. Used by the Web
 * Worker and usable directly (Node, tests). Messages in:
 *   { type: 'start', track | code, inputs ('1:...') | script, options, maxIterations?, timeLimitMs?, sliceMs = 40, reportMs = 250 }
 *   { type: 'pause' } | { type: 'resume' } | { type: 'stop' }
 * Messages out:
 *   { type: 'ready', best, window, cacheEvery }
 *   { type: 'improvement', iteration, best, firstTick, inputs }
 *   { type: 'progress', iterations, evaluated, improvements, rate, elapsedMs, best }
 *   { type: 'done', reason: 'iterations' | 'time' | 'stopped', iterations, best, inputs }
 *   { type: 'error', message }
 * `best` is { score, text, timeMs }.
 */
export class BruteforceSession {
    constructor(post, opts = {}) {
        this.post = post;
        this.schedule = opts.schedule || ((fn) => setTimeout(fn, 0));
        this.now = opts.now || (() => performance.now());
        this.bf = null;
        this.running = false;
        this.paused = false;
        this._timer = false;
    }

    handle(msg) {
        try {
            switch (msg && msg.type) {
                case 'start': return this._start(msg);
                case 'pause': this.paused = true; return undefined;
                case 'resume':
                    if (this.paused && this.running) { this.paused = false; this._kick(); }
                    return undefined;
                case 'stop': return this._finish('stopped');
                default: throw new Error(`Unknown message '${msg && msg.type}'`);
            }
        } catch (e) {
            this.running = false;
            this.post({ type: 'error', message: e && e.message ? e.message : String(e) });
            return undefined;
        }
    }

    _best() {
        const bf = this.bf;
        return { score: bf.best.score, text: bf.describe(), timeMs: bf.bestTimeMs() };
    }

    _start(msg) {
        const track = msg.track || (msg.code ? decodeTrack(msg.code) : null);
        const world = msg.world || (track ? buildWorld(track) : null);
        if (!world) throw new Error('start needs a track (JSON) or a share code');
        let tl;
        if (typeof msg.inputs === 'string') tl = InputTimeline.decode(msg.inputs);
        else if (typeof msg.script === 'string') {
            const p = parse(msg.script);
            if (p.errors.length) throw new Error(`Script line ${p.errors[0].line}: ${p.errors[0].message}`);
            tl = p.timeline;
        } else throw new Error('start needs inputs or a script');
        this.bf = new Bruteforce(world, tl, msg.options || {});
        this.maxIterations = msg.maxIterations ?? Infinity;
        this.timeLimitMs = msg.timeLimitMs ?? Infinity;
        this.sliceMs = msg.sliceMs ?? 40;
        this.reportMs = msg.reportMs ?? 250;
        this.started = this.now();
        this.lastReport = this.started;
        this.running = true;
        this.paused = false;
        this.post({ type: 'ready', best: this._best(), window: { ...this.bf.window }, cacheEvery: this.bf.cacheEvery });
        this._kick();
        return undefined;
    }

    _kick() {
        if (this._timer) return;
        this._timer = true;
        this.schedule(() => {
            this._timer = false;
            this._slice();
        });
    }

    _slice() {
        if (!this.running || this.paused) return;
        const bf = this.bf;
        try {
            const end = this.now() + this.sliceMs;
            do {
                if (bf.iterations >= this.maxIterations) return this._finish('iterations');
                const r = bf.step();
                if (r) {
                    this.post({ type: 'improvement', iteration: r.iteration, best: this._best(), firstTick: r.firstTick, inputs: r.timeline.encode() });
                }
            } while (this.now() < end);
            const now = this.now();
            if (now - this.started >= this.timeLimitMs) return this._finish('time');
            if (now - this.lastReport >= this.reportMs) {
                this.lastReport = now;
                const el = now - this.started;
                this.post({
                    type: 'progress', iterations: bf.iterations, evaluated: bf.evaluated, improvements: bf.improvements.length,
                    rate: el > 0 ? (bf.iterations * 1000) / el : 0, elapsedMs: el, best: this._best(),
                });
            }
        } catch (e) {
            this.running = false;
            this.post({ type: 'error', message: e && e.message ? e.message : String(e) });
            return undefined;
        }
        this._kick();
        return undefined;
    }

    _finish(reason) {
        if (!this.bf || !this.running) return undefined;
        this.running = false;
        const bf = this.bf;
        this.post({ type: 'done', reason, iterations: bf.iterations, best: this._best(), inputs: bf.bestTimeline().encode() });
        return undefined;
    }
}
