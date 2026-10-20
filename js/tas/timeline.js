// InputTimeline: the per-tick input list a TAS edits. Entry t is the input
// simulated by the step that takes the sim from tick t to t + 1 (race time
// t * 10 ms), exactly like a replay's input list. Past the end the last input
// is held (minus its respawn flag), the way a script's last commands stay in
// force, so a timeline never needs padding to "keep the gas down".
//
// Storage is two typed arrays (steer Int32, flags Uint8 with the replay's
// bits: gas 1, brake 2, respawn 4), so a one-hour run is ~2 MB and copies are
// memcpys. Every edit reports the lowest tick whose input changed, which is
// what savestate caches need to invalidate.
import { STEER_MAX } from '../core/constants.js';
import { clampSteer } from '../core/input.js';
import { encodeInputs, decodeInputs, MAX_REPLAY_TICKS } from '../core/replay.js';

export const GAS = 1;
export const BRAKE = 2;
export const RESPAWN = 4;
export const MAX_TICKS = MAX_REPLAY_TICKS;
export { STEER_MAX };

/** Flag bits of an input-like object. */
export function flagsOf(inp) {
    return inp ? (inp.gas ? GAS : 0) | (inp.brake ? BRAKE : 0) | (inp.respawn ? RESPAWN : 0) : 0;
}

/** Writes steer + flags into an input object ({ steer, gas, brake, respawn }). */
export function inputFrom(steer, flags, out = {}) {
    out.steer = steer;
    out.gas = (flags & GAS) !== 0;
    out.brake = (flags & BRAKE) !== 0;
    out.respawn = (flags & RESPAWN) !== 0;
    return out;
}

function checkTick(t, name = 'tick') {
    if (!Number.isInteger(t) || t < 0) throw new RangeError(`Bad ${name} ${t}`);
    if (t >= MAX_TICKS) throw new RangeError(`${name} ${t} is past the one-hour limit`);
}

export class InputTimeline {
    /** An empty timeline (all neutral), or `length` neutral ticks. */
    constructor(length = 0) {
        const cap = Math.max(64, length);
        this.steer = new Int32Array(cap);
        this.flags = new Uint8Array(cap);
        this._len = 0;
        this.version = 0;
        this._listeners = [];
        this._batch = 0;
        this._pending = Infinity;
        if (length > 0) this._grow(length);
    }

    /** From an array of input objects (normalised like the sim does). */
    static fromInputs(inputs) {
        const tl = new InputTimeline();
        tl._ensure(inputs.length);
        for (let i = 0; i < inputs.length; i++) {
            tl.steer[i] = clampSteer(inputs[i].steer);
            tl.flags[i] = flagsOf(inputs[i]);
        }
        tl._len = inputs.length;
        return tl;
    }

    /** From core replay encoding ('1:...'). */
    static decode(text) {
        return InputTimeline.fromInputs(decodeInputs(text));
    }

    /** Ticks stored explicitly (the last one is held after them). */
    get length() {
        return this._len;
    }

    get tailSteer() {
        return this._len ? this.steer[this._len - 1] : 0;
    }

    get tailFlags() {
        return this._len ? this.flags[this._len - 1] & ~RESPAWN : 0;
    }

    steerAt(t) {
        return t < this._len ? this.steer[t] : this.tailSteer;
    }

    flagsAt(t) {
        return t < this._len ? this.flags[t] : this.tailFlags;
    }

    /** The input of tick t as { steer, gas, brake, respawn } (written into `out` when given). */
    get(t, out = {}) {
        return t < this._len ? inputFrom(this.steer[t], this.flags[t], out) : inputFrom(this.tailSteer, this.tailFlags, out);
    }

    // -----------------------------------------------------------------
    // Edits. Each one notifies listeners with the lowest tick whose input changed.

    /** Replaces the input of tick t. */
    set(t, input) {
        checkTick(t);
        const s = clampSteer(input ? input.steer : 0), f = flagsOf(input);
        if (this.steerAt(t) === s && this.flagsAt(t) === f) return this;
        if (t >= this._len) this._grow(t + 1);
        this.steer[t] = s;
        this.flags[t] = f;
        this._changed(t);
        return this;
    }

    /** Changes only the given fields of tick t ({ steer?, gas?, brake?, respawn? }). */
    patch(t, fields) {
        return this.patchRange(t, t + 1, fields);
    }

    /** Sets ticks [from, to) to one input. */
    setRange(from, to, input) {
        const s = clampSteer(input ? input.steer : 0), f = flagsOf(input);
        return this._apply(from, to, () => s, () => f);
    }

    /** Changes only the given fields on ticks [from, to); the others keep their per-tick values. */
    patchRange(from, to, fields) {
        const has = (k) => fields && Object.prototype.hasOwnProperty.call(fields, k);
        const s = has('steer') ? clampSteer(fields.steer) : null;
        let set = 0, clear = 0;
        for (const [k, bit] of [['gas', GAS], ['brake', BRAKE], ['respawn', RESPAWN]]) {
            if (!has(k)) continue;
            if (fields[k]) set |= bit; else clear |= bit;
        }
        return this._apply(from, to, (old) => (s === null ? old : s), (old) => (old & ~clear) | set);
    }

    /** Adds `delta` to the steering of ticks [from, to) (clamped to full lock). */
    nudgeSteer(from, to, delta) {
        return this._apply(from, to, (old) => clampSteer(old + delta), (old) => old);
    }

    _apply(from, to, steerFn, flagsFn) {
        checkTick(from, 'from');
        if (!(to > from)) return this;
        checkTick(to - 1, 'to');
        let first = -1;
        for (let t = from; t < to; t++) {
            const os = this.steerAt(t), of = this.flagsAt(t);
            if (steerFn(os) !== os || flagsFn(of) !== of) { first = t; break; }
        }
        if (first < 0) return this;
        if (to > this._len) this._grow(to);
        for (let t = first; t < to; t++) {
            this.steer[t] = steerFn(this.steer[t]);
            this.flags[t] = flagsFn(this.flags[t]);
        }
        this._changed(first);
        return this;
    }

    /**
     * Inserts `count` ticks before tick `at`, shifting later inputs later. The new
     * ticks hold the input before them (minus respawn) unless `fill` is given.
     */
    insertTicks(at, count, fill = null) {
        checkTick(at, 'at');
        if (!(count > 0)) return this;
        const n = Math.floor(count);
        if (at > this._len) this._grow(at);
        const s = fill ? clampSteer(fill.steer) : at > 0 ? this.steer[at - 1] : 0;
        const f = fill ? flagsOf(fill) : at > 0 ? this.flags[at - 1] & ~RESPAWN : 0;
        const oldLen = this._len;
        this._ensure(oldLen + n);
        this.steer.copyWithin(at + n, at, oldLen);
        this.flags.copyWithin(at + n, at, oldLen);
        this.steer.fill(s, at, at + n);
        this.flags.fill(f, at, at + n);
        this._len = oldLen + n;
        this._changed(at);
        return this;
    }

    /** Removes ticks [at, at + count), shifting later inputs earlier. */
    deleteTicks(at, count) {
        checkTick(at, 'at');
        const end = Math.min(this._len, at + Math.floor(count));
        if (!(end > at)) return this;
        this.steer.copyWithin(at, end, this._len);
        this.flags.copyWithin(at, end, this._len);
        this._len -= end - at;
        this._changed(at);
        return this;
    }

    /** Keeps the first n ticks (the n-th is then held). */
    truncate(n) {
        if (n >= this._len) return this;
        const m = Math.max(0, Math.floor(n));
        const lost = this._semanticChangeOnTruncate(m);
        this._len = m;
        if (lost >= 0) this._changed(lost);
        return this;
    }

    _semanticChangeOnTruncate(m) {
        const ts = m ? this.steer[m - 1] : 0, tf = m ? this.flags[m - 1] & ~RESPAWN : 0;
        for (let t = m; t < this._len; t++) if (this.steer[t] !== ts || this.flags[t] !== tf) return t;
        return this.tailSteer !== ts || this.tailFlags !== tf ? this._len : -1;
    }

    clear() {
        return this.truncate(0);
    }

    /** Replaces the whole content with another timeline's (one notification). */
    copyFrom(other) {
        const first = this.firstDifference(other);
        this._ensure(other._len);
        this.steer.set(other.steer.subarray(0, other._len));
        this.flags.set(other.flags.subarray(0, other._len));
        this._len = other._len;
        if (first >= 0) this._changed(first);
        return this;
    }

    /** Stores at least n ticks explicitly (the held input fills them; no semantic change, no notification). */
    materialize(n) {
        if (n > this._len) this._grow(n);
        return this;
    }

    /** Drops trailing ticks that only repeat the held input (same semantics, shorter). */
    compact() {
        this._len = this.trimmedLength();
        return this;
    }

    /** Shortest length with the same inputs on every tick. */
    trimmedLength() {
        let n = this._len;
        while (n > 0) {
            const ps = n > 1 ? this.steer[n - 2] : 0, pf = n > 1 ? this.flags[n - 2] & ~RESPAWN : 0;
            if (this.flags[n - 1] & RESPAWN || this.steer[n - 1] !== ps || this.flags[n - 1] !== pf) break;
            n--;
        }
        return n;
    }

    /** Groups edits so listeners hear once, with the lowest changed tick. */
    batch(fn) {
        this._batch++;
        try {
            return fn(this);
        } finally {
            if (--this._batch === 0 && this._pending !== Infinity) {
                const t = this._pending;
                this._pending = Infinity;
                this._notify(t);
            }
        }
    }

    /** listener(lowestChangedTick, timeline) after every edit; returns an unsubscribe function. */
    onChange(listener) {
        this._listeners.push(listener);
        return () => {
            const i = this._listeners.indexOf(listener);
            if (i >= 0) this._listeners.splice(i, 1);
        };
    }

    // -----------------------------------------------------------------
    // Queries

    clone() {
        const tl = new InputTimeline();
        tl._ensure(this._len);
        tl.steer.set(this.steer.subarray(0, this._len));
        tl.flags.set(this.flags.subarray(0, this._len));
        tl._len = this._len;
        return tl;
    }

    /** Same input on every tick (held tails included). */
    equals(other) {
        return this.firstDifference(other) < 0;
    }

    /** Lowest tick in [from, to) whose input differs from `other`'s, or -1. */
    firstDifference(other, from = 0, to = Infinity) {
        const common = Math.min(this._len, other._len, to);
        const as = this.steer, af = this.flags, bs = other.steer, bf = other.flags;
        let t = from;
        for (; t < common; t++) if (as[t] !== bs[t] || af[t] !== bf[t]) return t;
        // One of them (or both) holds its tail from here; one tick past the longer covers both tails.
        const end = Math.min(to, Math.max(this._len, other._len) + 1);
        for (; t < end; t++) {
            if (this.steerAt(t) !== other.steerAt(t) || this.flagsAt(t) !== other.flagsAt(t)) return t;
        }
        return -1;
    }

    /** Tick ranges [{ from, to }] where the inputs differ (to = Infinity when the held tails differ). */
    diff(other) {
        const out = [];
        // The last tick compared is past both ends, i.e. the two held tails.
        const end = Math.max(this._len, other._len) + 1;
        let start = -1;
        for (let t = 0; t < end; t++) {
            const d = this.steerAt(t) !== other.steerAt(t) || this.flagsAt(t) !== other.flagsAt(t);
            if (d && start < 0) start = t;
            else if (!d && start >= 0) { out.push({ from: start, to: t }); start = -1; }
        }
        if (start >= 0) out.push({ from: start, to: Infinity });
        return out;
    }

    /** Ticks in [from, to) whose input differs from the tick before (tick 0 compares with neutral). */
    changePoints(from = 0, to = this._len) {
        const out = [];
        for (let t = Math.max(0, from); t < Math.min(to, this._len); t++) {
            const ps = t ? this.steer[t - 1] : 0, pf = t ? this.flags[t - 1] : 0;
            if (this.steer[t] !== ps || this.flags[t] !== pf) out.push(t);
        }
        return out;
    }

    /** Ticks carrying a respawn flag. */
    respawnTicks() {
        const out = [];
        for (let t = 0; t < this._len; t++) if (this.flags[t] & RESPAWN) out.push(t);
        return out;
    }

    /** Input objects for ticks [0, n). */
    toInputs(n = this._len) {
        const out = new Array(n);
        for (let t = 0; t < n; t++) out[t] = this.get(t, {});
        return out;
    }

    /** Core replay encoding of ticks [0, n). */
    encode(n = this._len) {
        return encodeInputs(this.toInputs(n));
    }

    /** 8 hex chars over the inputs (held tails trimmed, so equal timelines hash equal). */
    hash() {
        const n = this.trimmedLength();
        let h = 0x811c9dc5;
        for (let t = 0; t < n; t++) {
            h = Math.imul(h ^ (this.steer[t] & 0xffff), 0x01000193);
            h = Math.imul(h ^ (this.steer[t] >>> 16), 0x01000193);
            h = Math.imul(h ^ this.flags[t], 0x01000193);
        }
        h = Math.imul(h ^ n, 0x01000193);
        return (h >>> 0).toString(16).padStart(8, '0');
    }

    // -----------------------------------------------------------------

    _ensure(n) {
        if (n > MAX_TICKS) throw new RangeError(`A timeline holds at most ${MAX_TICKS} ticks`);
        if (n <= this.steer.length) return;
        let cap = this.steer.length;
        while (cap < n) cap *= 2;
        const s = new Int32Array(cap), f = new Uint8Array(cap);
        s.set(this.steer.subarray(0, this._len));
        f.set(this.flags.subarray(0, this._len));
        this.steer = s;
        this.flags = f;
    }

    /** Extends to n ticks with the held input (no semantic change). */
    _grow(n) {
        const s = this.tailSteer, f = this.tailFlags;
        this._ensure(n);
        this.steer.fill(s, this._len, n);
        this.flags.fill(f, this._len, n);
        this._len = n;
    }

    _changed(t) {
        this.version++;
        if (this._batch > 0) {
            if (t < this._pending) this._pending = t;
            return;
        }
        this._notify(t);
    }

    _notify(t) {
        for (const fn of this._listeners.slice()) fn(t, this);
    }
}
