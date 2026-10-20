// Replay share codes: base64url(JSON) behind a prefix. 'PTR2.' codes are
// deflated first (analog steering makes long input strings; deflate roughly
// halves them); 'PTR1.' is the plain form for browsers without
// CompressionStream. A code carries the replay and, for tracks that are not
// official, the track itself as a share code, so a friend can watch it (and
// race its ghost) without having the track saved. The import box also takes the
// replay JSON that the TAS and AI tools write (decodeReplayText).
import { toBase64Url, fromBase64Url, encodeTrack, decodeTrack } from '../core/codec.js';
import { countInputs } from '../core/replay.js';

export const REPLAY_CODE_PREFIX = 'PTR1.';
export const REPLAY_CODE_PREFIX_Z = 'PTR2.';
const DAMAGED = 'That replay code is damaged. Copy the whole code and try again.';

function payloadOf(replay, track, meta) {
    const payload = { v: 1, replay, name: meta.name || replay.name || '', trackName: meta.trackName || (track && track.name) || '' };
    if (track) payload.track = encodeTrack(track);
    return new TextEncoder().encode(JSON.stringify(payload));
}

async function pipeBytes(bytes, stream) {
    const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
    return new Uint8Array(await out.arrayBuffer());
}

/** Plain code (synchronous). */
export function encodeReplayCode(replay, track = null, meta = {}) {
    return REPLAY_CODE_PREFIX + toBase64Url(payloadOf(replay, track, meta));
}

/** Compressed code when the browser can deflate, else the plain one. */
export async function encodeReplayCodeAsync(replay, track = null, meta = {}) {
    const bytes = payloadOf(replay, track, meta);
    if (typeof CompressionStream !== 'function') return REPLAY_CODE_PREFIX + toBase64Url(bytes);
    return REPLAY_CODE_PREFIX_Z + toBase64Url(await pipeBytes(bytes, new CompressionStream('deflate-raw')));
}

/** Decodes PTR1 and PTR2 codes. */
export async function decodeReplayCodeAsync(code) {
    const clean = String(code || '').replace(/\s+/g, '');
    if (!clean.startsWith(REPLAY_CODE_PREFIX_Z)) return decodeReplayCode(clean);
    if (typeof DecompressionStream !== 'function') throw new Error('This browser is too old to open compressed replay codes.');
    let bytes;
    try {
        bytes = await pipeBytes(fromBase64Url(clean.slice(REPLAY_CODE_PREFIX_Z.length)), new DecompressionStream('deflate-raw'));
    } catch (e) {
        throw new Error(DAMAGED);
    }
    return fromPayloadBytes(bytes);
}

/** Returns { replay, track (or null), name, trackName }; throws a friendly Error on bad input. */
export function decodeReplayCode(code) {
    const clean = String(code || '').replace(/\s+/g, '');
    if (!clean.startsWith(REPLAY_CODE_PREFIX)) throw new Error("That doesn't look like a Penguintrack replay code (they start with PTR).");
    let bytes;
    try {
        bytes = fromBase64Url(clean.slice(REPLAY_CODE_PREFIX.length));
    } catch (e) {
        throw new Error(DAMAGED);
    }
    return fromPayloadBytes(bytes);
}

/**
 * What the Replays import box accepts: a PTR2 / PTR1 replay code, or replay JSON
 * as the TAS and AI tools write it (a bare replay, { replay, track? } or an AI
 * model file carrying { replay, trackCode }). Returns { replay, track, name, trackName }.
 */
export async function decodeReplayText(text) {
    const clean = String(text || '').trim();
    if (!clean.startsWith('{')) return decodeReplayCodeAsync(clean);
    let data;
    try {
        data = JSON.parse(clean);
    } catch (e) {
        throw new Error("That replay file isn't valid JSON.");
    }
    const replay = data && typeof data.inputs === 'string' ? data : data && data.replay;
    const track = data && data.track && typeof data.track === 'object' ? data.track : null;
    const code = data && (typeof data.track === 'string' ? data.track : data.trackCode) || null;
    return checked({ replay, track: code, name: (data && data.name) || (replay && replay.name), trackName: data && data.trackName }, track);
}

function fromPayloadBytes(bytes) {
    let payload;
    try {
        payload = JSON.parse(new TextDecoder().decode(bytes));
    } catch (e) {
        throw new Error(DAMAGED);
    }
    return checked(payload);
}

/** Validates a decoded payload { replay, track?: PT1 code, name, trackName } (or a track object given directly). */
function checked(payload, trackObject = null) {
    const r = payload && payload.replay;
    if (!r || typeof r.inputs !== 'string' || !r.trackId) throw new Error('That replay has no run in it.');
    try {
        countInputs(r.inputs);
    } catch (e) {
        throw new Error(DAMAGED);
    }
    let track = trackObject;
    if (!track && payload.track) {
        try {
            track = decodeTrack(payload.track);
        } catch (e) {
            throw new Error('The track inside that replay is damaged.');
        }
    }
    return { replay: r, track, name: String(payload.name || ''), trackName: String(payload.trackName || '') };
}
