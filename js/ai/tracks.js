// Track lookup for the AI kit: an official track id (js/levels/index.js), a
// dev sample id (S01–S06), a share code (PT1.…), track JSON text or a track
// object all resolve to a track JSON the env can build. The levels module is
// optional: when it is missing (or has no such id) the core samples answer.
import { getSample, getSamples } from '../core/samples.js';
import { decodeTrack, CODE_PREFIX } from '../core/codec.js';

let levelsPromise = null;

/** The campaign module, or null when it is not there (yet). Cached. */
export function loadLevels() {
    if (!levelsPromise) {
        levelsPromise = import('../levels/index.js').then((m) => m, () => null);
    }
    return levelsPromise;
}

/** Synchronous resolution of everything except official level ids. Returns null when unknown. */
export function resolveTrackSync(spec) {
    if (spec && typeof spec === 'object') return spec;
    if (typeof spec !== 'string') return null;
    const text = spec.trim();
    if (text.startsWith(CODE_PREFIX)) return decodeTrack(text);
    if (text.startsWith('{')) return JSON.parse(text);
    return getSample(text) || getSample(text.toUpperCase());
}

/**
 * Track JSON for: a track object, JSON text, a share code, an official level
 * id (via getTrack in js/levels/index.js) or a sample id. Throws when unknown.
 */
export async function resolveTrack(spec) {
    if (spec && typeof spec === 'object') return spec;
    if (typeof spec !== 'string' || !spec.trim()) throw new Error('No track given');
    const text = spec.trim();
    if (text.startsWith(CODE_PREFIX) || text.startsWith('{')) return resolveTrackSync(text);
    const levels = await loadLevels();
    if (levels) {
        const t = findLevel(levels, text);
        if (t) return t;
    }
    const s = resolveTrackSync(text);
    if (s) return s;
    throw new Error(`Unknown track '${text}' (try a level id, S01–S06, a PT1. share code or track JSON)`);
}

function findLevel(levels, id) {
    try {
        if (typeof levels.getTrack === 'function') {
            const t = levels.getTrack(id) || levels.getTrack(id.toUpperCase());
            if (t) return t;
        }
        const list = levelList(levels);
        return list.find((t) => t && (t.id === id || t.id === id.toUpperCase())) || null;
    } catch (e) {
        return null;
    }
}

function levelList(levels) {
    const raw = levels.TRACKS || levels.tracks || levels.LEVELS || levels.levels || (levels.default && levels.default.tracks) || [];
    return Array.isArray(raw) ? raw : Object.values(raw);
}

/** [{ id, name, source: 'levels' | 'sample' }] of every track the AI kit can find by id. */
export async function listTracks() {
    const out = [];
    const seen = new Set();
    const levels = await loadLevels();
    if (levels) {
        let list = [];
        try {
            if (typeof levels.trackIds === 'function') {
                list = levels.trackIds().map((id) => {
                    const info = typeof levels.trackInfo === 'function' ? levels.trackInfo(id) : null;
                    return { id, name: (info && info.name) || id };
                });
            } else {
                list = levelList(levels);
            }
        } catch (e) {
            list = [];
        }
        for (const t of list) {
            if (!t || !t.id || seen.has(t.id)) continue;
            seen.add(t.id);
            out.push({ id: t.id, name: t.name || t.id, source: 'levels' });
        }
    }
    for (const t of getSamples()) {
        if (seen.has(t.id)) continue;
        seen.add(t.id);
        out.push({ id: t.id, name: t.name, source: 'sample' });
    }
    return out;
}
