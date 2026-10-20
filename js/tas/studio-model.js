// TAS Studio logic without DOM: timeline view maths, piano-roll edits
// (draw, toggle, copy / paste / shift / clear / delete), undo, markers from a
// runner trace, car readouts, bruteforce form -> options, and project storage.
// Kept pure so tools/tests/tas-studio.test.mjs can drive it in Node.
import { STEER_MAX, TICK_MS } from '../core/constants.js';
import { clampSteer } from '../core/input.js';
import { formatTime } from '../core/format.js';
import { InputTimeline, GAS, BRAKE, RESPAWN, MAX_TICKS, inputFrom } from './timeline.js';
import { parseTime, formatTick } from './script.js';

export { GAS, BRAKE, RESPAWN };

/** Playback speeds (loop.timeScale). */
export const SPEEDS = [0.05, 0.1, 0.25, 0.5, 1, 2, 4];
/** Savestate slot names in keyboard order (1..9, 0). */
export const SLOT_NAMES = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];

/** 'Digit3' / 'Numpad3' -> '3', else null. */
export function slotFromCode(code) {
    const m = /^(?:Digit|Numpad)(\d)$/.exec(code || '');
    return m ? m[1] : null;
}

/** Next speed up (dir 1) or down (dir -1) from the list. */
export function stepSpeed(speed, dir) {
    let i = SPEEDS.indexOf(speed);
    if (i < 0) i = SPEEDS.findIndex((s) => s >= speed);
    if (i < 0) i = SPEEDS.length - 1;
    return SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, i + dir))];
}

// ---------------------------------------------------------------------------
// Readouts

/**
 * Yaw / pitch / roll in degrees of a car quaternion [x, y, z, w] (Y up, the
 * car's forward axis is +Z): yaw 0 faces +Z and grows turning towards +X.
 */
export function quatToEuler(q) {
    const [x, y, z, w] = q;
    // Forward (+Z) axis, the up axis' height and the right (-X) axis' height in world space.
    const fx = 2 * (x * z + w * y), fy = 2 * (y * z - w * x), fz = 1 - 2 * (x * x + y * y);
    const uy = 1 - 2 * (x * x + z * z);
    const ry = -2 * (x * y + w * z);
    const deg = 180 / Math.PI;
    const yaw = Math.atan2(fx, fz) * deg;
    const pitch = Math.asin(Math.max(-1, Math.min(1, fy))) * deg;   // + = nose up
    const roll = Math.atan2(-ry, uy) * deg;                           // + = right side down
    return { yaw: norm180(yaw), pitch, roll };
}

function norm180(a) {
    let v = a % 360;
    if (v > 180) v -= 360;
    if (v <= -180) v += 360;
    return v;
}

export const SURFACE_LABELS = { snow: 'Packed Snow', powder: 'Powder', ice: 'Ice', ground: 'Deep Snow', wall: 'Wall' };

/** Short labels of the active pad effects. */
export function describeEffects(e) {
    if (!e) return [];
    const out = [];
    if (e.turbo > 0) out.push(`${e.turbo === 2 ? 'Avalanche' : 'Frost'} Boost ${e.turboTime.toFixed(2)} s`);
    if (e.noEngine) out.push('Frozen Engine');
    if (e.noSteer) out.push('Frozen Wheel');
    if (e.noBrake) out.push('Brake Freeze');
    if (e.slowmo > 0) out.push(`Snow Globe ×${e.slowmo}`);
    if (e.cruise) out.push(`Glide ${(e.cruiseSpeed * 3.6).toFixed(1)} km/h`);
    if (e.fragile) out.push(e.broken ? 'Thin Ice (cracked)' : 'Thin Ice');
    return out;
}

/** Fixed-decimal number with a sign slot, for aligned mono readouts. */
export function fmtNum(v, d = 3) {
    if (!Number.isFinite(v)) return '—';
    const s = Math.abs(v) < 0.5 * 10 ** -d ? 0 : v;
    return (s < 0 ? '−' : ' ') + Math.abs(s).toFixed(d);
}

/** Race time of a tick with milliseconds (0:12.340). */
export function tickTime(tick) {
    return formatTime(tick * TICK_MS, { style: 'long' });
}

/**
 * Time box text -> tick. Accepts script times ('12.34', '1:02.50') and raw
 * ticks ('t1234' or '#1234'). Returns { tick } or { error }.
 */
export function parseTickInput(text) {
    const s = String(text ?? '').trim();
    const m = /^[t#](\d+)$/i.exec(s);
    if (m) {
        const tick = Number(m[1]);
        return tick < MAX_TICKS ? { tick } : { error: 'Past the one-hour limit' };
    }
    return parseTime(s);
}

export { formatTick };

// ---------------------------------------------------------------------------
// Timeline view: tick <-> pixel maths for the piano roll

export class TimelineView {
    constructor({ start = 0, scale = 4, width = 800 } = {}) {
        this.start = start;      // tick at the left edge (fractional)
        this.scale = scale;      // pixels per tick
        this.width = width;
        this.minScale = 0.02;
        this.maxScale = 32;
    }

    tickAt(x) {
        return Math.floor(this.start + x / this.scale);
    }

    xAt(tick) {
        return (tick - this.start) * this.scale;
    }

    /** First and last (exclusive) ticks at least partly visible. */
    visible() {
        return { from: Math.max(0, Math.floor(this.start)), to: Math.ceil(this.start + this.width / this.scale) + 1 };
    }

    setWidth(w, total) {
        this.width = Math.max(1, w);
        this.clamp(total);
    }

    /** Zooms by `factor` keeping the tick under `anchorX` in place. */
    zoom(factor, anchorX, total) {
        const at = this.start + anchorX / this.scale;
        this.scale = Math.max(this.minScale, Math.min(this.maxScale, this.scale * factor));
        this.start = at - anchorX / this.scale;
        this.clamp(total);
    }

    scrollBy(px, total) {
        this.start += px / this.scale;
        this.clamp(total);
    }

    /** Keeps the view inside [0, total + a little]. */
    clamp(total) {
        const span = this.width / this.scale;
        const end = Math.max(span, total + span * 0.1);
        this.start = Math.max(0, Math.min(this.start, end - span));
    }

    /** Shows the whole run. */
    fit(total) {
        const n = Math.max(100, total);
        this.scale = Math.max(this.minScale, Math.min(this.maxScale, this.width / (n * 1.04)));
        this.start = 0;
        this.clamp(total);
    }

    /** Scrolls so `tick` is inside the view with a margin (fraction of the width); returns true when it moved. */
    follow(tick, total, margin = 0.15) {
        const span = this.width / this.scale;
        const lo = this.start + span * margin, hi = this.start + span * (1 - margin);
        if (tick >= lo && tick <= hi) return false;
        this.start = tick < lo ? tick - span * margin : tick - span * (1 - margin);
        this.clamp(total);
        return true;
    }

    /** Ruler step (ticks between labels) for at least `minPx` pixels per label. */
    labelStep(minPx = 70) {
        const steps = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 3000, 6000, 12000, 30000, 60000];
        for (const s of steps) if (s * this.scale >= minPx) return s;
        return steps[steps.length - 1];
    }
}

/** Steer value for a y inside a lane (top = full right, bottom = full left); snaps near 0 and full lock. */
export function steerFromY(y, top, height, { snapPx = 4, quantize = 0 } = {}) {
    const mid = top + height / 2, half = height / 2 - 2;
    let v = Math.round(((mid - y) / half) * STEER_MAX);
    if (quantize > 0) v = Math.round(v / quantize) * quantize;
    const px = (STEER_MAX / half) * snapPx;
    if (Math.abs(v) <= px) v = 0;
    if (v >= STEER_MAX - px) v = STEER_MAX;
    if (v <= -STEER_MAX + px) v = -STEER_MAX;
    return clampSteer(v);
}

export function yFromSteer(v, top, height) {
    const mid = top + height / 2, half = height / 2 - 2;
    return mid - (v / STEER_MAX) * half;
}

// ---------------------------------------------------------------------------
// Edits (each a single timeline notification through batch)

/** Draws steering along a line from (t0, v0) to (t1, v1), both ticks included. */
export function paintSteer(tl, t0, v0, t1, v1) {
    const a = Math.max(0, Math.min(t0, t1)), b = Math.min(MAX_TICKS - 1, Math.max(t0, t1));
    const va = t0 <= t1 ? v0 : v1, vb = t0 <= t1 ? v1 : v0;
    tl.batch(() => {
        for (let t = a; t <= b; t++) {
            const v = b === a ? vb : Math.round(va + ((vb - va) * (t - a)) / (b - a));
            tl.patch(t, { steer: v });
        }
    });
}

/** Sets gas / brake / respawn bit on ticks [from, to). */
export function paintFlag(tl, from, to, bit, on) {
    const key = bit === GAS ? 'gas' : bit === BRAKE ? 'brake' : 'respawn';
    tl.patchRange(Math.max(0, from), to, { [key]: !!on });
}

/** Turns a flag on over [from, to) unless it is already on everywhere there (then off). Returns the new value. */
export function toggleFlagSpan(tl, from, to, bit) {
    let all = true;
    for (let t = from; t < to; t++) if (!(tl.flagsAt(t) & bit)) { all = false; break; }
    paintFlag(tl, from, to, bit, !all);
    return !all;
}

/** Inputs of [from, to) as a clip. */
export function copyRange(tl, from, to) {
    const n = Math.max(0, to - from);
    const clip = { length: n, steer: new Int32Array(n), flags: new Uint8Array(n) };
    for (let i = 0; i < n; i++) {
        clip.steer[i] = tl.steerAt(from + i);
        clip.flags[i] = tl.flagsAt(from + i);
    }
    return clip;
}

/** Writes a clip at `at` (overwrite), or inserts it there (later inputs move later). */
export function pasteClip(tl, at, clip, { insert = false } = {}) {
    if (!clip || !clip.length) return;
    const n = Math.min(clip.length, MAX_TICKS - at);
    if (n <= 0) return;
    const inp = {};
    tl.batch(() => {
        if (insert) tl.insertTicks(at, n);
        for (let i = 0; i < n; i++) tl.set(at + i, inputFrom(clip.steer[i], clip.flags[i], inp));
    });
}

/** Neutral inputs (no steer, no pedals) on [from, to). */
export function clearRange(tl, from, to) {
    tl.setRange(from, to, { steer: 0, gas: false, brake: false, respawn: false });
}

/** Removes ticks [from, to) (later inputs move earlier). */
export function removeRange(tl, from, to) {
    tl.deleteTicks(from, to - from);
}

/**
 * Moves the inputs of [from, to) by `delta` ticks. The gap left behind holds
 * the neighbouring input (the one before for a move later, the one after for a
 * move earlier); inputs in the destination are overwritten. Returns the new
 * selection { from, to }.
 */
export function shiftRange(tl, from, to, delta) {
    if (from + delta < 0) delta = -from;
    if (!delta || to <= from) return { from, to };
    const clip = copyRange(tl, from, to);
    const inp = {};
    tl.batch(() => {
        if (delta > 0) {
            const fill = from > 0 ? inputFrom(tl.steerAt(from - 1), tl.flagsAt(from - 1) & ~RESPAWN, {}) : { steer: 0 };
            tl.setRange(from, Math.min(to, from + delta), fill);
        } else {
            const fill = inputFrom(tl.steerAt(to), tl.flagsAt(to) & ~RESPAWN, {});
            tl.setRange(Math.max(from, to + delta), to, fill);
        }
        for (let i = 0; i < clip.length; i++) tl.set(from + delta + i, inputFrom(clip.steer[i], clip.flags[i], inp));
    });
    return { from: from + delta, to: to + delta };
}

/** Adds delta to the steering of [from, to). */
export function nudgeRange(tl, from, to, delta) {
    tl.nudgeSteer(from, to, delta);
}

/** Bounded undo / redo of whole-timeline snapshots (typed-array copies are cheap). */
export class UndoStack {
    constructor(limit = 80) {
        this.limit = limit;
        this.past = [];
        this.future = [];
    }

    /** Remembers the timeline before an edit. */
    push(tl) {
        const last = this.past[this.past.length - 1];
        if (last && last.equals(tl) && last.length === tl.length) return;
        this.past.push(tl.clone());
        if (this.past.length > this.limit) this.past.shift();
        this.future.length = 0;
    }

    undo(tl) {
        const prev = this.past.pop();
        if (!prev) return false;
        this.future.push(tl.clone());
        tl.copyFrom(prev);
        return true;
    }

    redo(tl) {
        const next = this.future.pop();
        if (!next) return false;
        this.past.push(tl.clone());
        tl.copyFrom(next);
        return true;
    }

    clear() {
        this.past.length = 0;
        this.future.length = 0;
    }
}

// ---------------------------------------------------------------------------
// Markers

/** Ruler markers from a runner trace: [{ tick, kind: 'checkpoint'|'lap'|'finish'|'respawn', label }]. */
export function markersFromTrace(trace) {
    const out = [];
    if (!trace) return out;
    let cp = 0;
    for (const e of trace.events) {
        if (e.type === 'checkpoint') out.push({ tick: e.tick, kind: 'checkpoint', label: `CP ${++cp}` });
        else if (e.type === 'lap') out.push({ tick: e.tick, kind: 'lap', label: `Lap ${e.lap + 1}` });
        else if (e.type === 'finish') out.push({ tick: e.tick, kind: 'finish', label: 'Finish' });
        else if (e.type === 'respawn') out.push({ tick: e.tick, kind: 'respawn', label: 'Respawn' });
    }
    return out;
}

/** The next (dir 1) or previous (dir -1) checkpoint / lap / finish tick from `tick`, or null. */
export function nextMarkerTick(markers, tick, dir = 1) {
    let best = null;
    for (const m of markers) {
        if (m.kind === 'respawn') continue;
        if (dir > 0 ? m.tick > tick && (best === null || m.tick < best) : m.tick < tick && (best === null || m.tick > best)) best = m.tick;
    }
    return best;
}

// ---------------------------------------------------------------------------
// Bruteforce form

/**
 * Bruteforce options from the panel's form values:
 * { target: 'finish'|'checkpoint'|'speed'|'position', cp, at (time text), point: [x,y,z], mode,
 *   from, to (time text, '' = whole run), seed, maxChanges, steerRange, steerSpan, shiftRange,
 *   wShift, wSteer, wGas, wBrake, gasSpan, brakeSpan, laps }.
 * Returns { options } or { error }.
 */
export function bruteforceOptions(f) {
    let target;
    const tickOf = (text, what) => {
        const r = parseTickInput(text);
        if (r.error) throw new Error(`${what}: ${r.error}`);
        return r.tick;
    };
    try {
        switch (f.target) {
            case 'checkpoint': {
                const n = Math.floor(Number(f.cp));
                if (!(n >= 1)) throw new Error('Checkpoint number must be 1 or more');
                target = { type: 'checkpoint', index: n };
                break;
            }
            case 'speed':
                target = { type: 'speed', tick: tickOf(f.at, 'Speed time') };
                break;
            case 'position': {
                const p = (f.point || []).map(Number);
                if (p.length !== 3 || !p.every(Number.isFinite)) throw new Error('Position needs three numbers x, y, z');
                target = { type: 'position', point: p, tick: tickOf(f.at, 'Position time'), mode: f.mode === 'at' ? 'at' : 'min' };
                break;
            }
            default:
                target = 'finish';
        }
        let window = null;
        const hasFrom = String(f.from ?? '').trim() !== '', hasTo = String(f.to ?? '').trim() !== '';
        if (hasFrom || hasTo) {
            const from = hasFrom ? tickOf(f.from, 'Window start') : 0;
            const to = hasTo ? tickOf(f.to, 'Window end') : MAX_TICKS;
            if (!(to > from)) throw new Error('The window ends before it starts');
            window = { from, to };
        }
        const num = (v, d, lo, hi) => {
            const n = Number(v);
            return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d;
        };
        const options = {
            target,
            window,
            seed: Math.floor(num(f.seed, 1, 0, 2 ** 31)),
            rules: {
                maxChanges: Math.floor(num(f.maxChanges, 3, 1, 20)),
                shift: { weight: num(f.wShift, 1, 0, 100), range: Math.floor(num(f.shiftRange, 3, 1, 100)) },
                steer: { weight: num(f.wSteer, 2, 0, 100), range: Math.floor(num(f.steerRange, 8000, 1, 2 * STEER_MAX)), span: Math.floor(num(f.steerSpan, 12, 1, 1000)) },
                gas: { weight: num(f.wGas, 0.5, 0, 100), span: Math.floor(num(f.gasSpan, 10, 1, 1000)) },
                brake: { weight: num(f.wBrake, 0.5, 0, 100), span: Math.floor(num(f.brakeSpan, 10, 1, 1000)) },
            },
        };
        if (f.laps != null) options.laps = f.laps;
        const w = options.rules;
        if (!(w.shift.weight + w.steer.weight + w.gas.weight + w.brake.weight > 0)) throw new Error('At least one rule needs a weight above 0');
        return { options };
    } catch (e) {
        return { error: e.message };
    }
}

// ---------------------------------------------------------------------------
// Projects: storage key 'tas' = { [name]: { trackId, track?, script, notes, slots, cursor, updated } }

export function listProjects(storage) {
    const all = storage.get('tas', {}) || {};
    return Object.keys(all).filter((k) => all[k] && typeof all[k].script === 'string')
        .map((name) => ({ name, ...all[name] }))
        .sort((a, b) => (b.updated || 0) - (a.updated || 0));
}

export function loadProject(storage, name) {
    const all = storage.get('tas', {}) || {};
    const p = all[name];
    return p && typeof p.script === 'string' ? { name, ...p } : null;
}

/** Saves (replaces) a project; returns false when storage is full. */
export function saveProject(storage, name, project) {
    const all = storage.get('tas', {}) || {};
    const { name: _n, ...rest } = project;
    all[name] = { ...rest, updated: project.updated ?? Date.now() };
    return storage.set('tas', all);
}

export function deleteProject(storage, name) {
    const all = storage.get('tas', {}) || {};
    delete all[name];
    storage.set('tas', all);
}

/** `base`, or `base (2)`, `base (3)`… not yet taken. */
export function uniqueName(storage, base) {
    const all = storage.get('tas', {}) || {};
    const b = String(base || 'Snow run').trim() || 'Snow run';
    if (!all[b]) return b;
    for (let i = 2; ; i++) if (!all[`${b} (${i})`]) return `${b} (${i})`;
}

/** Empty timeline helper (gas from GO keeps a new project moving). */
export function startTimeline(kind) {
    const tl = new InputTimeline();
    if (kind === 'gas') tl.set(0, { steer: 0, gas: true });
    return tl;
}
