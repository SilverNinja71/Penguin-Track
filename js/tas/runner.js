// TasRunner: a Sim driven by an InputTimeline, with a savestate cache so the
// cursor can jump anywhere in a run at once. States are cached every
// `interval` ticks as they are simulated; editing the timeline drops only the
// states after the lowest edited tick (the state at tick T depends on inputs
// 0..T-1), so re-running after an edit starts right where the change is.
//
// The live cursor (`runner.sim`) and the full-run views (`result()`,
// `trace()`) use separate Sims that share the cache, so the studio can keep
// the cursor in place while it redraws the whole run.
import { Sim } from '../core/sim.js';
import { RouteTracker } from '../core/route.js';
import { simulateReplay } from '../core/replay.js';
import { InputTimeline, MAX_TICKS } from './timeline.js';

/** Ticks a run keeps simulating past the timeline's end (its last input held) before giving up. */
export const TAIL_TICKS = 6000;
export const DEFAULT_INTERVAL = 50;

/** Default simulation limit for a timeline: its length plus 60 s of held input. */
export function runLimit(timeline, maxTicks) {
    return Math.min(MAX_TICKS, maxTicks ?? timeline.length + TAIL_TICKS);
}

/**
 * Simulates a timeline from tick 0 (or from opts.state) to the finish, or to
 * opts.maxTicks (absolute tick; default: the timeline plus 60 s). opts: { laps,
 * maxTicks, stopAtFinish = true, sim (a Sim to reuse), state, onTick(sim) }.
 * Returns { finished, finishTimeMs, timeMs, ticks, respawns, checkpointTimes,
 * lapTimes, sim }.
 */
export function simulateTimeline(world, timeline, opts = {}) {
    const sim = opts.sim || new Sim(world, opts.laps != null ? { laps: opts.laps } : {});
    if (opts.state) sim.setState(opts.state);
    else if (opts.sim) sim.reset();
    const limit = runLimit(timeline, opts.maxTicks);
    const stopAtFinish = opts.stopAtFinish !== false;
    const onTick = opts.onTick || null;
    const inp = {};
    while (sim.tick < limit && !(stopAtFinish && sim.finished)) {
        timeline.get(sim.tick, inp);
        sim.step(inp);
        if (onTick) onTick(sim);
    }
    return runSummary(sim);
}

/** Race summary of a sim (plain data). */
export function runSummary(sim) {
    return {
        finished: sim.finished,
        finishTimeMs: sim.finished ? sim.finishTimeMs : null,
        timeMs: sim.timeMs,
        ticks: sim.tick,
        respawns: sim.respawns,
        checkpointTimes: sim.checkpointTimes.slice(),
        lapTimes: sim.lapTimes.slice(),
        sim,
    };
}

export class TasRunner {
    /**
     * opts: { laps (default: the world's), interval = 50 (ticks between cached
     * savestates), maxTicks (default: timeline + 60 s, for result/trace) }.
     */
    constructor(world, timeline = new InputTimeline(), opts = {}) {
        this.world = world;
        this.laps = opts.laps ?? world.laps ?? 1;
        this.interval = Math.max(1, Math.floor(opts.interval ?? DEFAULT_INTERVAL));
        this.maxTicks = opts.maxTicks ?? null;
        this.sim = new Sim(world, { laps: this.laps });
        this.tracker = world.route ? new RouteTracker(world.route) : null;
        this._probe = null;
        this._probeTracker = null;
        this._cache = [];
        this._stale = false;
        this._cursor = 0;
        this._inp = {};
        this._listeners = { edit: [], seek: [] };
        this._result = null;
        this._trace = null;
        this.slots = new Map();
        this.recording = false;
        this.timeline = null;
        this._unsub = null;
        this.setTimeline(timeline);
    }

    /** Switches to another timeline (cache dropped, cursor back to tick 0). */
    setTimeline(timeline) {
        if (this._unsub) this._unsub();
        this.timeline = timeline;
        this._unsub = timeline.onChange((t) => this._onEdit(t));
        this._cache = [];
        this._result = null;
        this._trace = null;
        for (const s of this.slots.values()) s.stale = true;
        this.sim.reset();
        if (this.tracker) this.tracker.reset();
        this._store(this.sim, this.tracker);
        this._stale = false;
        this._cursor = 0;
        return this;
    }

    /** Stops listening to the timeline. */
    dispose() {
        if (this._unsub) this._unsub();
        this._unsub = null;
    }

    /** on('edit', fn({ tick })) after a timeline edit; on('seek', fn({ tick })) after the cursor moves. Returns off(). */
    on(type, fn) {
        const list = this._listeners[type];
        if (!list) throw new Error(`Unknown runner event '${type}'`);
        list.push(fn);
        return () => {
            const i = list.indexOf(fn);
            if (i >= 0) list.splice(i, 1);
        };
    }

    /** Cursor tick (the live sim's tick). */
    get tick() {
        this._fresh();
        return this.sim.tick;
    }

    /** The input the next step will simulate. */
    get nextInput() {
        return this.timeline.get(this.tick);
    }

    // -----------------------------------------------------------------
    // Cursor

    /** Moves the cursor to exactly `tick` (cached savestate + at most `interval` steps). */
    seek(tick) {
        const target = Math.max(0, Math.min(MAX_TICKS, Math.floor(tick)));
        const sim = this.sim;
        if (this._stale || sim.tick > target || target - sim.tick > this.interval) {
            const from = this._nearest(target);
            // Restart from the cache unless the live sim is already closer.
            if (this._stale || sim.tick > target || from.tick > sim.tick) this._restore(sim, this.tracker, from);
        }
        this._stale = false;
        this._advance(sim, this.tracker, target, null);
        this._cursor = sim.tick;
        this._emit('seek', { tick: sim.tick });
        return this.info();
    }

    /** Steps the cursor n ticks forward; onTick(sim) after each (events in sim.events). */
    step(n = 1, onTick = null) {
        this._fresh();
        this._advance(this.sim, this.tracker, Math.min(MAX_TICKS, this.sim.tick + Math.max(0, Math.floor(n))), onTick);
        this._cursor = this.sim.tick;
        this._emit('seek', { tick: this.sim.tick });
        return this.info();
    }

    /** Steps forward to `tick` with per-tick callbacks, or seeks back when it is behind. */
    playTo(tick, onTick = null) {
        const cur = this.tick;
        return tick >= cur ? this.step(tick - cur, onTick) : this.seek(tick);
    }

    /** Steps until the finish (or the run limit); returns info(). */
    playToFinish(onTick = null) {
        this._fresh();
        const limit = runLimit(this.timeline, this.maxTicks);
        const sim = this.sim;
        while (!sim.finished && sim.tick < limit) this._advance(sim, this.tracker, sim.tick + 1, onTick);
        this._cursor = sim.tick;
        this._emit('seek', { tick: sim.tick });
        return this.info();
    }

    /** Race info at the cursor. */
    info() {
        this._fresh();
        const sim = this.sim, car = sim.car;
        return {
            tick: sim.tick,
            timeMs: sim.timeMs,
            finished: sim.finished,
            finishTimeMs: sim.finishTimeMs,
            lap: sim.lap,
            laps: sim.laps,
            checkpointTimes: sim.checkpointTimes.slice(),
            lapTimes: sim.lapTimes.slice(),
            collectedCount: sim.collectedCount,
            checkpointCount: sim.checkpointCount,
            respawns: sim.respawns,
            speedKmh: car.speedKmh,
            pos: car.pos.slice(),
            airborne: car.airborne,
            drifting: car.drifting,
            progress: this.tracker ? this.tracker.progress : null,
            input: this.timeline.get(sim.tick),
        };
    }

    // -----------------------------------------------------------------
    // Savestate slots (TMInterface's save/load state, kept in step with the timeline)

    /** Saves the cursor's exact state under a name. */
    save(name = 'default') {
        this._fresh();
        const slot = {
            name, tick: this.sim.tick, state: this.sim.getState(),
            tracker: this.tracker ? this.tracker.getState() : null, stale: false,
        };
        this.slots.set(name, slot);
        return slot;
    }

    /**
     * Restores a slot. A slot goes stale when the timeline is edited before its
     * tick; loading it then re-simulates to its tick with the current inputs
     * (the result says `stale: true`), so the cursor never shows a run the
     * timeline cannot reproduce.
     */
    load(name = 'default') {
        const slot = this.slots.get(name);
        if (!slot) throw new Error(`No savestate '${name}'`);
        if (slot.stale) return { ...this.seek(slot.tick), stale: true };
        this.sim.setState(slot.state);
        if (this.tracker && slot.tracker) this.tracker.setState(slot.tracker);
        this._stale = false;
        this._cursor = slot.tick;
        this._emit('seek', { tick: slot.tick });
        return { ...this.info(), stale: false };
    }

    deleteSlot(name) {
        return this.slots.delete(name);
    }

    // -----------------------------------------------------------------
    // Record mode: live inputs overwrite the timeline as the cursor moves

    /** truncate (default true): drop the timeline after the cursor, so the recording becomes the run's end. */
    startRecording({ truncate = true } = {}) {
        this._fresh();
        if (truncate) this.timeline.truncate(this.sim.tick);
        this.recording = true;
    }

    stopRecording() {
        this.recording = false;
    }

    /**
     * One live tick: while recording, `input` is written to the timeline at the
     * cursor first; otherwise the timeline's own input plays. Returns the sim.
     */
    stepLive(input, onTick = null) {
        this._fresh();
        if (this.recording && input) this.timeline.set(this.sim.tick, input);
        this._advance(this.sim, this.tracker, this.sim.tick + 1, onTick);
        this._cursor = this.sim.tick;
        return this.sim;
    }

    // -----------------------------------------------------------------
    // Whole-run views (do not move the cursor)

    /** Race result of the whole timeline (cached until the next edit). */
    result() {
        if (this._result) return this._result;
        const t = this.trace();
        this._result = {
            finished: t.finished, finishTimeMs: t.finishTimeMs, ticks: t.ticks, respawns: t.respawns,
            checkpointTimes: t.checkpointTimes.slice(), lapTimes: t.lapTimes.slice(),
        };
        return this._result;
    }

    /**
     * Per-tick view of the whole run for timelines and graphs, rebuilt only from
     * the lowest edited tick: { ticks, speedKmh: Float32Array, pos: Float32Array
     * (xyz), progress: Float32Array (route metres, NaN without a route), state:
     * Uint8Array (1 airborne, 2 drifting, 4 wheels on the ground), events: [{ tick,
     * type, ... }], finished, finishTimeMs, respawns, checkpointTimes, lapTimes }.
     * Index i is the state after i ticks (0 = the start).
     */
    trace() {
        const limit = runLimit(this.timeline, this.maxTicks);
        let tr = this._trace;
        if (tr && tr.complete && tr.limit === limit) return tr.view;
        if (!tr) tr = this._trace = newTrace(limit);
        else if (tr.limit !== limit) resizeTrace(tr, limit);
        const sim = this._probeSim();
        const tracker = this._probeTracker;
        const from = tr.len - 1;   // last valid sample
        if (from < 0) {
            sim.reset();
            if (tracker) tracker.reset();
            recordSample(tr, sim, tracker);
        } else {
            this._restore(sim, tracker, this._nearest(from));
            this._advance(sim, tracker, from, null);
        }
        tr.events = tr.events.filter((e) => e.tick <= sim.tick);
        while (!sim.finished && sim.tick < limit) {
            this._advance(sim, tracker, sim.tick + 1, null);
            recordSample(tr, sim, tracker);
            if (sim.events.length) for (const e of sim.events) tr.events.push({ ...e });
        }
        tr.complete = true;
        tr.view = {
            ticks: sim.tick,
            speedKmh: tr.speed.subarray(0, tr.len),
            pos: tr.pos.subarray(0, tr.len * 3),
            progress: tr.progress.subarray(0, tr.len),
            state: tr.state.subarray(0, tr.len),
            events: tr.events.slice(),
            finished: sim.finished,
            finishTimeMs: sim.finished ? sim.finishTimeMs : null,
            respawns: sim.respawns,
            checkpointTimes: sim.checkpointTimes.slice(),
            lapTimes: sim.lapTimes.slice(),
        };
        return tr.view;
    }

    /** Ghost samples (core simulateReplay format, for ghostPoseAt) of another timeline, or this one. */
    ghost(timeline = this.timeline, opts = {}) {
        return ghostSamples(this.world, timeline, { laps: this.laps, maxTicks: this.maxTicks ?? undefined, ...opts });
    }

    /** Compares this timeline with another one (see compareTimelines). */
    compare(other, opts = {}) {
        return compareTimelines(this.world, this.timeline, other, { laps: this.laps, ...opts });
    }

    /** Number of cached savestates (debug, tests). */
    get cachedStates() {
        let n = 0;
        for (const e of this._cache) if (e) n++;
        return n;
    }

    // -----------------------------------------------------------------

    _probeSim() {
        if (!this._probe) {
            this._probe = new Sim(this.world, { laps: this.laps });
            this._probeTracker = this.world.route ? new RouteTracker(this.world.route) : null;
        }
        return this._probe;
    }

    _fresh() {
        if (this._stale) this.seek(this._cursor);
    }

    _nearest(tick) {
        for (let k = Math.min(this._cache.length - 1, Math.floor(tick / this.interval)); k >= 0; k--) {
            if (this._cache[k]) return this._cache[k];
        }
        throw new Error('Savestate cache lost tick 0');
    }

    _restore(sim, tracker, entry) {
        sim.setState(entry.state);
        if (tracker) tracker.setState(entry.tracker);
    }

    _store(sim, tracker) {
        const k = sim.tick / this.interval;
        if (!this._cache[k]) this._cache[k] = { tick: sim.tick, state: sim.getState(), tracker: tracker ? tracker.getState() : null };
    }

    /** Steps `sim` to `target` with the timeline's inputs, caching states on interval ticks. */
    _advance(sim, tracker, target, onTick) {
        const tl = this.timeline, inp = this._inp, iv = this.interval;
        while (sim.tick < target) {
            tl.get(sim.tick, inp);
            sim.step(inp);
            if (tracker) tracker.track(sim);
            if (sim.tick % iv === 0) this._store(sim, tracker);
            if (onTick) onTick(sim);
        }
    }

    _onEdit(t) {
        // States after tick t were built from the old input at t.
        const keep = Math.floor(t / this.interval) + 1;
        if (this._cache.length > keep) this._cache.length = keep;
        if (this.sim.tick > t) {
            this._stale = true;
            this._cursor = this.sim.tick;
        }
        for (const s of this.slots.values()) if (s.tick > t) s.stale = true;
        this._result = null;
        if (this._trace) {
            const tr = this._trace;
            if (tr.len > t + 1) tr.len = t + 1;
            tr.complete = false;
            tr.view = null;
        }
        this._emit('edit', { tick: t });
    }

    _emit(type, data) {
        for (const fn of this._listeners[type].slice()) fn(data);
    }
}

function newTrace(limit) {
    const cap = limit + 1;
    return {
        limit, len: 0, complete: false, view: null, events: [],
        speed: new Float32Array(cap), pos: new Float32Array(cap * 3),
        progress: new Float32Array(cap), state: new Uint8Array(cap),
    };
}

/** Keeps the valid samples when the run limit moves (the timeline grew or shrank). */
function resizeTrace(tr, limit) {
    if (limit + 1 > tr.speed.length) {
        const cap = Math.max(limit + 1, tr.speed.length * 2);
        const grow = (a, k) => { const b = new a.constructor(cap * k); b.set(a.subarray(0, tr.len * k)); return b; };
        tr.speed = grow(tr.speed, 1); tr.pos = grow(tr.pos, 3); tr.progress = grow(tr.progress, 1); tr.state = grow(tr.state, 1);
    }
    if (tr.len > limit + 1) tr.len = limit + 1;
    tr.limit = limit;
    tr.complete = false;
    tr.view = null;
}

function recordSample(tr, sim, tracker) {
    const i = sim.tick, car = sim.car;
    tr.speed[i] = car.speedKmh;
    tr.pos[i * 3] = car.pos[0]; tr.pos[i * 3 + 1] = car.pos[1]; tr.pos[i * 3 + 2] = car.pos[2];
    tr.progress[i] = tracker ? tracker.progress : NaN;
    tr.state[i] = (car.airborne ? 1 : 0) | (car.drifting ? 2 : 0) | (car.wheels.some((w) => w.contact) ? 4 : 0);
    tr.len = i + 1;
}

/** simulateReplay samples of a timeline (for ghostPoseAt). opts: { laps, maxTicks, sampleEvery = 1 }. */
export function ghostSamples(world, timeline, opts = {}) {
    const limit = runLimit(timeline, opts.maxTicks);
    const res = simulateReplay(world, { inputs: timeline.toInputs(limit), laps: opts.laps }, {
        sampleEvery: opts.sampleEvery ?? 1, maxTicks: MAX_TICKS,
    });
    return res.samples;
}

/**
 * Ghost compare of two timelines on one world: both race results, the first
 * tick whose input differs, the first tick where the cars separate (> 1 mm),
 * the widest separation, and per-checkpoint splits (b minus a, ms).
 * opts: { laps, maxTicks }.
 */
export function compareTimelines(world, a, b, opts = {}) {
    const laps = opts.laps != null ? { laps: opts.laps } : {};
    const firstInputDifference = a.firstDifference(b);
    const limit = Math.max(runLimit(a, opts.maxTicks), runLimit(b, opts.maxTicks));
    const sa = new Sim(world, laps), sb = new Sim(world, laps);
    const ia = {}, ib = {};
    if (firstInputDifference < 0) {
        const r = summaryData(simulateTimeline(world, a, { sim: sa, maxTicks: limit }).sim);
        return { a: r, b: r, firstInputDifference, divergeTick: -1, maxGap: 0, maxGapTick: -1,
            splits: r.checkpointTimes.map((t, i) => ({ index: i + 1, a: t, b: t, delta: 0 })),
            finishDelta: r.finished ? 0 : null };
    }
    // Identical up to the first differing input: simulate once, then copy.
    if (firstInputDifference > 0) {
        while (sa.tick < firstInputDifference && sa.tick < limit && !sa.finished) {
            a.get(sa.tick, ia);
            sa.step(ia);
        }
        sb.setState(sa.getState());
    }
    let divergeTick = null, maxGap = 0, maxGapTick = -1;
    while ((!sa.finished || !sb.finished) && Math.max(sa.tick, sb.tick) < limit) {
        if (!sa.finished) { a.get(sa.tick, ia); sa.step(ia); }
        if (!sb.finished) { b.get(sb.tick, ib); sb.step(ib); }
        if (sa.tick === sb.tick) {
            const pa = sa.car.pos, pb = sb.car.pos;
            const dx = pa[0] - pb[0], dy = pa[1] - pb[1], dz = pa[2] - pb[2];
            const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (divergeTick === null && d > 1e-3) divergeTick = sa.tick;
            if (d > maxGap) { maxGap = d; maxGapTick = sa.tick; }
        }
    }
    const ra = summaryData(sa), rb = summaryData(sb);
    const n = Math.max(ra.checkpointTimes.length, rb.checkpointTimes.length);
    const splits = [];
    for (let i = 0; i < n; i++) {
        const ta = ra.checkpointTimes[i] ?? null, tb = rb.checkpointTimes[i] ?? null;
        splits.push({ index: i + 1, a: ta, b: tb, delta: ta != null && tb != null ? tb - ta : null });
    }
    return {
        a: ra, b: rb,
        firstInputDifference,
        divergeTick: divergeTick ?? -1,
        maxGap, maxGapTick,
        splits,
        finishDelta: ra.finished && rb.finished ? rb.finishTimeMs - ra.finishTimeMs : null,
    };
}

function summaryData(sim) {
    const { sim: _s, ...rest } = runSummary(sim);
    return rest;
}
