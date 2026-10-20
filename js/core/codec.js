// Track share codes ('PT1.' + base64url of a compact binary form) and the
// stable track hash that binds replays to an exact block layout.
import { MOODS, MODES, TRACK_FORMAT } from './constants.js';
import { BLOCKS } from './blocks.js';

export const CODE_PREFIX = 'PT1.';
const BINARY_VERSION = 1;
const MEDAL_KEYS = ['author', 'gold', 'silver', 'bronze'];
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64_INV = (() => {
    const t = new Int16Array(128).fill(-1);
    for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
    return t;
})();

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

class Writer {
    constructor() {
        this.bytes = [];
    }

    u8(v) {
        this.bytes.push(v & 255);
    }

    /** Unsigned LEB128 (safe up to 2^53). */
    varint(v) {
        if (!(v >= 0) || !Number.isFinite(v)) throw new Error(`cannot encode ${v} as varint`);
        v = Math.floor(v);
        while (v >= 128) {
            this.bytes.push((v % 128) | 128);
            v = Math.floor(v / 128);
        }
        this.bytes.push(v);
    }

    zigzag(v) {
        this.varint(v < 0 ? -2 * v - 1 : 2 * v);
    }

    str(s) {
        const b = textEncoder.encode(String(s));
        this.varint(b.length);
        for (const x of b) this.bytes.push(x);
    }
}

class Reader {
    constructor(bytes, end) {
        this.b = bytes;
        this.i = 0;
        this.end = end;
    }

    u8() {
        if (this.i >= this.end) throw corrupt('unexpected end of data');
        return this.b[this.i++];
    }

    varint() {
        let v = 0, mul = 1;
        for (let k = 0; k < 8; k++) {
            const x = this.u8();
            v += (x & 127) * mul;
            if (x < 128) return v;
            mul *= 128;
        }
        throw corrupt('varint too long');
    }

    zigzag() {
        const v = this.varint();
        return v % 2 === 1 ? -(v + 1) / 2 : v / 2;
    }

    str() {
        const n = this.varint();
        if (this.i + n > this.end) throw corrupt('string runs past the end');
        const s = this.b.subarray(this.i, this.i + n);
        this.i += n;
        try {
            return textDecoder.decode(s);
        } catch (e) {
            throw corrupt('invalid text');
        }
    }
}

function corrupt(msg) {
    return new Error(`Corrupt track code: ${msg}`);
}

function fnv1a(bytes, end, seed = 0x811c9dc5) {
    let h = seed;
    for (let i = 0; i < end; i++) {
        h ^= bytes[i];
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

export function toBase64Url(bytes) {
    let out = '';
    let i = 0;
    for (; i + 2 < bytes.length; i += 3) {
        const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
        out += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
    }
    const rest = bytes.length - i;
    if (rest === 1) {
        const n = bytes[i] << 16;
        out += B64[n >> 18] + B64[(n >> 12) & 63];
    } else if (rest === 2) {
        const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
        out += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63];
    }
    return out;
}

export function fromBase64Url(str) {
    if (str.length % 4 === 1) throw corrupt('bad length');
    const out = new Uint8Array(Math.floor(str.length * 3 / 4));
    let o = 0, acc = 0, bits = 0;
    for (let i = 0; i < str.length; i++) {
        const c = str.charCodeAt(i);
        const v = c < 128 ? B64_INV[c] : -1;
        if (v < 0) throw corrupt(`invalid character '${str[i]}'`);
        acc = (acc << 6) | v;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out[o++] = (acc >> bits) & 255;
        }
    }
    // The last character's unused low bits must be zero, so every byte string has one code.
    if (bits > 0 && (acc & ((1 << bits) - 1)) !== 0) throw corrupt('non-zero padding bits');
    return out.subarray(0, o);
}

function encodeMedal(w, v) {
    if (v == null) {
        w.u8(0);
    } else if (typeof v === 'number') {
        w.u8(1);
        w.varint(Math.max(0, Math.round(v)));
    } else {
        const keys = Object.keys(v).filter((k) => typeof v[k] === 'number').sort();
        w.u8(2);
        w.varint(keys.length);
        for (const k of keys) {
            w.str(k);
            w.varint(Math.max(0, Math.round(v[k])));
        }
    }
}

function decodeMedal(r) {
    const tag = r.u8();
    if (tag === 0) return null;
    if (tag === 1) return r.varint();
    if (tag === 2) {
        const n = r.varint();
        const o = {};
        for (let i = 0; i < n; i++) {
            const k = r.str();
            o[k] = r.varint();
        }
        return o;
    }
    throw corrupt('bad medal tag');
}

function table(items, keyOf) {
    const list = [];
    const index = new Map();
    for (const it of items) {
        const k = keyOf(it);
        if (!index.has(k)) {
            index.set(k, list.length);
            list.push(k);
        }
    }
    return { list, index };
}

/** The lap rule shared by normalizeTrack, trackHash and share codes: a positive integer, else 1. */
export function normalizeLaps(laps) {
    return Number.isInteger(laps) && laps > 0 ? laps : 1;
}

function rot(r) {
    return ((r | 0) % 4 + 4) % 4;
}

/**
 * Encodes a track into a share code. Block order is preserved (checkpoint
 * ids depend on it). Values are normalized exactly like normalizeTrack does
 * (integer coordinates, rotations 0..3, the lap rule), so a code always decodes
 * to the track buildWorld would have built. Unknown extra fields are not carried.
 */
export function encodeTrack(track) {
    const t = track || {};
    const blocks = (t.blocks || []).map((b) => ({ b: b.b, x: b.x | 0, y: b.y | 0, z: b.z | 0, r: rot(b.r), s: surfaceOf(b) }));
    const decor = (t.decor || []).map((d) => ({ d: String(d.d), x: d.x | 0, y: d.y | 0, z: d.z | 0, r: rot(d.r) }));
    const w = new Writer();
    w.u8(BINARY_VERSION);
    w.str(t.id ?? 'custom');
    w.str(t.name ?? 'Untitled Track');
    w.str(t.author ?? 'Anonymous');
    w.u8(Math.max(0, MOODS.indexOf(t.mood)));
    w.u8(Math.max(0, MODES.indexOf(t.mode)));
    w.varint(normalizeLaps(t.laps));
    for (const k of MEDAL_KEYS) encodeMedal(w, t.medals ? t.medals[k] : null);

    const ids = table(blocks, (b) => b.b);
    const surfs = table(blocks, (b) => b.s);
    w.varint(ids.list.length);
    for (const id of ids.list) w.str(id);
    w.varint(surfs.list.length);
    for (const s of surfs.list) w.str(s);
    if (surfs.list.length > 63) throw new Error('too many surfaces');
    w.varint(blocks.length);
    let px = 0, py = 0, pz = 0;
    for (const b of blocks) {
        w.varint(ids.index.get(b.b));
        w.zigzag(b.x - px); w.zigzag(b.y - py); w.zigzag(b.z - pz);
        px = b.x; py = b.y; pz = b.z;
        w.u8(b.r | (surfs.index.get(b.s) << 2));
    }

    const dids = table(decor, (d) => d.d);
    w.varint(dids.list.length);
    for (const id of dids.list) w.str(id);
    w.varint(decor.length);
    px = 0; py = 0; pz = 0;
    for (const d of decor) {
        w.varint(dids.index.get(d.d));
        w.zigzag(d.x - px); w.zigzag(d.y - py); w.zigzag(d.z - pz);
        px = d.x; py = d.y; pz = d.z;
        w.u8(d.r);
    }

    const h = fnv1a(w.bytes, w.bytes.length);
    w.u8(h); w.u8(h >>> 8); w.u8(h >>> 16); w.u8(h >>> 24);
    return CODE_PREFIX + toBase64Url(w.bytes);
}

function surfaceOf(b) {
    if (b.s) return b.s;
    const def = BLOCKS[b.b];
    return def ? def.defaultSurface : 'snow';
}

/** Decodes a share code into a track (format 1). Throws on anything corrupt. */
export function decodeTrack(code) {
    if (typeof code !== 'string') throw corrupt('not a string');
    const trimmed = code.trim();
    if (!trimmed.startsWith(CODE_PREFIX)) throw corrupt(`missing '${CODE_PREFIX}' prefix`);
    const bytes = fromBase64Url(trimmed.slice(CODE_PREFIX.length));
    if (bytes.length < 5) throw corrupt('too short');
    const end = bytes.length - 4;
    const stored = (bytes[end] | (bytes[end + 1] << 8) | (bytes[end + 2] << 16) | (bytes[end + 3] << 24)) >>> 0;
    if (fnv1a(bytes, end) !== stored) throw corrupt('checksum mismatch');
    const r = new Reader(bytes, end);
    const version = r.u8();
    if (version !== BINARY_VERSION) throw corrupt(`unsupported version ${version}`);
    const track = { format: TRACK_FORMAT };
    track.id = r.str();
    track.name = r.str();
    track.author = r.str();
    const mood = r.u8(), mode = r.u8();
    if (mood >= MOODS.length || mode >= MODES.length) throw corrupt('bad mood or mode');
    track.mood = MOODS[mood];
    track.mode = MODES[mode];
    track.laps = r.varint();
    if (track.laps < 1) throw corrupt('bad lap count');
    track.medals = {};
    for (const k of MEDAL_KEYS) track.medals[k] = decodeMedal(r);

    const nIds = r.varint();
    const ids = [];
    for (let i = 0; i < nIds; i++) ids.push(r.str());
    const nSurf = r.varint();
    const surfs = [];
    for (let i = 0; i < nSurf; i++) surfs.push(r.str());
    const n = r.varint();
    if (n > 100000) throw corrupt('too many blocks');
    track.blocks = [];
    let px = 0, py = 0, pz = 0;
    for (let i = 0; i < n; i++) {
        const id = r.varint();
        if (id >= ids.length) throw corrupt('bad block id index');
        px += r.zigzag(); py += r.zigzag(); pz += r.zigzag();
        const rs = r.u8();
        const si = rs >> 2;
        if (si >= surfs.length) throw corrupt('bad surface index');
        track.blocks.push({ b: ids[id], x: px, y: py, z: pz, r: rs & 3, s: surfs[si] });
    }

    const nd = r.varint();
    const dids = [];
    for (let i = 0; i < nd; i++) dids.push(r.str());
    const m = r.varint();
    if (m > 100000) throw corrupt('too much decor');
    track.decor = [];
    px = 0; py = 0; pz = 0;
    for (let i = 0; i < m; i++) {
        const id = r.varint();
        if (id >= dids.length) throw corrupt('bad decor id index');
        px += r.zigzag(); py += r.zigzag(); pz += r.zigzag();
        track.decor.push({ d: dids[id], x: px, y: py, z: pz, r: r.u8() & 3 });
    }
    if (r.i !== end) throw corrupt('trailing bytes');
    return track;
}

/**
 * Short stable hash of everything that affects a run: laps, mode and the
 * exact block list (order, ids, positions, rotations, surfaces). Names,
 * medals and decor do not change it. 16 hex characters.
 */
export function trackHash(track) {
    const mode = MODES.includes(track.mode) ? track.mode : 'race';
    const parts = [`v1|${normalizeLaps(track.laps)}|${mode}`];
    for (const b of track.blocks || []) {
        parts.push(`${b.b},${b.x | 0},${b.y | 0},${b.z | 0},${rot(b.r)},${surfaceOf(b)}`);
    }
    const bytes = textEncoder.encode(parts.join(';'));
    const a = fnv1a(bytes, bytes.length);
    // Second lane: same bytes with a different basis, so collisions need both to agree.
    const b = fnv1a(bytes, bytes.length, a ^ 0x9e3779b9);
    return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}
