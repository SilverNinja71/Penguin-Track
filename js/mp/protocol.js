// Online room wire protocol (pure, Node-tested). Every message is one JSON
// text frame. Nothing from the network is trusted: decode() checks the size
// before parsing, and validate*() rebuilds each message field by field with
// types, ranges and lengths checked, dropping anything unexpected.

export const PROTOCOL_VERSION = 1;
export const PEER_PREFIX = 'penguintrack-';
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no 0/O, 1/I
export const CODE_LENGTH = 5;
export const MAX_PLAYERS = 8;

export const LIMITS = {
    frame: 96 * 1024,        // one message, as text
    name: 16,
    chat: 200,
    trackCode: 48 * 1024,
    inputs: 64 * 1024,       // encoded replay inputs (an hour of keyboard play is far less)
    respawnTicks: 2000,
    id: 40,
    coord: 1e5,              // metres: the map is 1.5 km across
    roundMs: [60000, 15 * 60000],
};

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const TRACK_ID_RE = /^[A-Za-z0-9_.-]{1,40}$/;
const HASH_RE = /^[0-9a-f]{8,32}$/;

// ------------------------------------------------------------------ helpers

/** A room code from a random source (a function returning [0, 1)). */
export function makeRoomCode(rand = Math.random) {
    let s = '';
    for (let i = 0; i < CODE_LENGTH; i++) s += CODE_ALPHABET[Math.floor(rand() * CODE_ALPHABET.length) % CODE_ALPHABET.length];
    return s;
}

/** Normalises typed codes ('ab-c2d ' → 'ABC2D'); null when it cannot be a code. */
export function parseRoomCode(text) {
    if (typeof text !== 'string') return null;
    let s = text.trim().toUpperCase();
    if (s.startsWith(PEER_PREFIX.toUpperCase())) s = s.slice(PEER_PREFIX.length);
    s = s.replace(/[\s-]/g, '');
    if (s.length !== CODE_LENGTH) return null;
    for (const ch of s) if (!CODE_ALPHABET.includes(ch)) return null;
    return s;
}

export function peerIdFor(code) {
    return PEER_PREFIX + code;
}

// Control characters, bidi overrides and zero-width marks: invisible tricks in names and chat.
const STRIP = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁯﻿]/g;

/** Cleans free text: no control/bidi characters, collapsed spaces, at most `max` characters. */
export function cleanText(s, max) {
    if (typeof s !== 'string') return '';
    const t = s.slice(0, max * 4).replace(STRIP, '').replace(/\s+/g, ' ').trim();
    return Array.from(t).slice(0, max).join('').trim();
}

export function cleanName(s) {
    return cleanText(s, LIMITS.name) || 'Penguin';
}

/** Makes `name` unique among `taken` (case-insensitive) with a number suffix. */
export function uniqueName(name, taken) {
    const lower = new Set([...taken].map((n) => n.toLowerCase()));
    if (!lower.has(name.toLowerCase())) return name;
    for (let i = 2; i < 100; i++) {
        const base = Array.from(name).slice(0, LIMITS.name - String(i).length - 1).join('');
        const cand = `${base} ${i}`;
        if (!lower.has(cand.toLowerCase())) return cand;
    }
    return name;
}

const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const isNum = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const isStr = (v, max) => typeof v === 'string' && v.length <= max;

function vec(v, n, lim) {
    if (!Array.isArray(v) || v.length !== n) return null;
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
        if (!isNum(v[i], -lim, lim)) return null;
        out[i] = v[i];
    }
    return out;
}

/** Rounds pose numbers for the wire: centimetres, 1e-4 for the quaternion. */
export function packPose(run, tick, pos, quat, speedKmh) {
    const r2 = (x) => Math.round(x * 100) / 100;
    const r4 = (x) => Math.round(x * 10000) / 10000;
    return { t: 'pose', r: run, k: tick, p: [r2(pos[0]), r2(pos[1]), r2(pos[2])], q: [r4(quat[0]), r4(quat[1]), r4(quat[2]), r4(quat[3])], s: Math.round(speedKmh) };
}

function pose(m) {
    if (!isInt(m.r, 0, 1e9) || !isInt(m.k, 0, 1e8)) return null;
    const p = vec(m.p, 3, LIMITS.coord);
    const q = vec(m.q, 4, 1.01);
    if (!p || !q || !isNum(m.s, -2000, 2000)) return null;
    const ql = Math.hypot(q[0], q[1], q[2], q[3]);
    if (ql < 0.5) return null;
    return { r: m.r, k: m.k, p, q: q.map((x) => x / ql), s: m.s };
}

/** A track reference: an official id, or a share code (with its hash). */
function trackRef(v) {
    if (!v || typeof v !== 'object') return null;
    if (typeof v.id === 'string' && TRACK_ID_RE.test(v.id) && v.code == null) {
        const out = { id: v.id };
        if (v.hash != null) {
            if (typeof v.hash !== 'string' || !HASH_RE.test(v.hash)) return null;
            out.hash = v.hash;
        }
        if (v.name != null) out.name = cleanText(v.name, 40);
        return out;
    }
    if (isStr(v.code, LIMITS.trackCode) && v.code.startsWith('PT1.') && /^[A-Za-z0-9._-]+$/.test(v.code)) {
        if (typeof v.hash !== 'string' || !HASH_RE.test(v.hash)) return null;
        return { code: v.code, hash: v.hash, name: cleanText(v.name || '', 40) };
    }
    return null;
}

/** The replay part of a finish: only what verifyReplay needs. */
export function cleanReplay(v) {
    if (!v || typeof v !== 'object') return null;
    if (!isStr(v.inputs, LIMITS.inputs) || !/^1:[A-Za-z0-9.*-]*$/.test(v.inputs)) return null;
    if (typeof v.trackHash !== 'string' || !HASH_RE.test(v.trackHash)) return null;
    if (!isInt(v.ticks, 1, 360000) || !isInt(v.timeMs, 10, 3600000) || !isInt(v.laps ?? 1, 1, 99)) return null;
    if (!Array.isArray(v.respawnTicks) || v.respawnTicks.length > LIMITS.respawnTicks) return null;
    for (const t of v.respawnTicks) if (!isInt(t, 0, 360000)) return null;
    return {
        format: 1, trackId: TRACK_ID_RE.test(v.trackId || '') ? v.trackId : 'room', trackHash: v.trackHash,
        laps: v.laps ?? 1, inputs: v.inputs, ticks: v.ticks, timeMs: v.timeMs, finished: true,
        respawnTicks: v.respawnTicks.slice(), date: null, name: cleanText(v.name || '', 60),
    };
}

// ------------------------------------------------------------------ framing

export function encode(msg) {
    return JSON.stringify(msg);
}

/** Text frame → plain object, or null (too big, not JSON, not an object with a string `t`). */
export function decode(frame) {
    let text = frame;
    if (typeof text !== 'string') {
        // Another serializer may hand us an object: measure it the same way.
        try {
            text = JSON.stringify(text);
        } catch (e) {
            return null;
        }
    }
    if (typeof text !== 'string' || text.length > LIMITS.frame) return null;
    let m;
    try {
        m = JSON.parse(text);
    } catch (e) {
        return null;
    }
    if (!m || typeof m !== 'object' || Array.isArray(m) || typeof m.t !== 'string') return null;
    return m;
}

// ------------------------------------------------------------------ client → host

/** Validates a message a client sent to the host. Returns a clean copy or null. */
export function validateClientMsg(m) {
    if (!m || typeof m !== 'object') return null;
    switch (m.t) {
        case 'hello':
            if (!isInt(m.v, 0, 1000)) return null;
            return { t: 'hello', v: m.v, name: cleanName(m.name) };
        case 'chat': {
            const text = cleanText(m.text, LIMITS.chat);
            return text ? { t: 'chat', text } : null;
        }
        case 'pose': {
            const p = pose(m);
            return p ? { t: 'pose', ...p } : null;
        }
        case 'idle':
            return { t: 'idle' };
        case 'fin': {
            if (!isInt(m.round, 1, 1e6)) return null;
            const replay = cleanReplay(m.replay);
            if (!replay) return null;
            if (!isInt(m.respawns ?? 0, 0, 100000)) return null;
            return { t: 'fin', round: m.round, timeMs: replay.timeMs, respawns: m.respawns ?? 0, replay };
        }
        case 'want':
            return isStr(m.id, LIMITS.id) && ID_RE.test(m.id) ? { t: 'want', id: m.id } : null;
        case 'ping':
            return isNum(m.c, 0, 1e13) ? { t: 'ping', c: m.c } : null;
        case 'bye':
            return { t: 'bye' };
        default:
            return null;
    }
}

// ------------------------------------------------------------------ host → client

function playerEntry(p) {
    if (!p || typeof p !== 'object' || !isStr(p.id, LIMITS.id) || !ID_RE.test(p.id)) return null;
    const best = p.best == null ? null : isInt(p.best, 10, 3600000) ? p.best : undefined;
    if (best === undefined) return null;
    return {
        id: p.id,
        name: cleanName(p.name),
        host: !!p.host,
        best,
        respawns: isInt(p.respawns ?? 0, 0, 100000) ? p.respawns ?? 0 : 0,
        verified: !!p.verified,
        pts: isInt(p.pts ?? 0, 0, 1e6) ? p.pts ?? 0 : 0,
        driving: !!p.driving,
    };
}

/** Validates a message the host sent. Returns a clean copy or null. */
export function validateHostMsg(m) {
    if (!m || typeof m !== 'object') return null;
    switch (m.t) {
        case 'welcome':
            if (!isInt(m.v, 0, 1000) || !isStr(m.you, LIMITS.id) || !ID_RE.test(m.you)) return null;
            return { t: 'welcome', v: m.v, you: m.you, name: cleanName(m.name) };
        case 'reject':
            return { t: 'reject', reason: cleanText(m.reason, 120) || 'The room said no.' };
        case 'players': {
            if (!Array.isArray(m.list) || m.list.length > MAX_PLAYERS) return null;
            const list = [];
            for (const p of m.list) {
                const e = playerEntry(p);
                if (!e) return null;
                list.push(e);
            }
            return { t: 'players', list };
        }
        case 'chat': {
            const text = cleanText(m.text, LIMITS.chat);
            if (!text) return null;
            const sys = !!m.sys;
            if (!sys && (!isStr(m.id, LIMITS.id) || !ID_RE.test(m.id))) return null;
            return { t: 'chat', sys, id: sys ? null : m.id, name: sys ? '' : cleanName(m.name), text };
        }
        case 'round': {
            if (!isInt(m.n, 0, 1e6) || !['lobby', 'racing', 'ended'].includes(m.state)) return null;
            const out = { t: 'round', n: m.n, state: m.state, track: null, durationMs: 0, leftMs: 0 };
            if (m.state !== 'lobby') {
                out.track = trackRef(m.track);
                if (!out.track) return null;
                if (!isInt(m.durationMs, LIMITS.roundMs[0], LIMITS.roundMs[1]) || !isInt(m.leftMs, 0, LIMITS.roundMs[1])) return null;
                out.durationMs = m.durationMs;
                out.leftMs = m.leftMs;
            }
            return out;
        }
        case 'pose': {
            if (!isStr(m.id, LIMITS.id) || !ID_RE.test(m.id)) return null;
            const p = pose(m);
            return p ? { t: 'pose', id: m.id, ...p } : null;
        }
        case 'idle':
            return isStr(m.id, LIMITS.id) && ID_RE.test(m.id) ? { t: 'idle', id: m.id } : null;
        case 'replay': {
            if (!isStr(m.id, LIMITS.id) || !ID_RE.test(m.id)) return null;
            const replay = cleanReplay(m.replay);
            return replay ? { t: 'replay', id: m.id, replay } : null;
        }
        case 'pong':
            return isNum(m.c, 0, 1e13) ? { t: 'pong', c: m.c } : null;
        default:
            return null;
    }
}

export function validateTrackRef(v) {
    return trackRef(v);
}
