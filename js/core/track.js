// Track model: normalization, validation, the turtle path builder used to
// author tracks quickly, and buildWorld(), which turns a track into the static
// World that physics, rendering, the route and the AI all share.
import {
    CELL, LAYER, MAP_X, MAP_Y, MAP_Z, DIRS, DIR_NAMES, GROUND_Y, FALL_Y, DECK_THICKNESS,
    SURFACE_INDEX, MOODS, MODES, TRACK_FORMAT,
} from './constants.js';
import { DIR_QUATS, sq } from './mathd.js';
import { BLOCKS, getBlockGeometry, footprintSize, rotateCell, makeTransform } from './blocks.js';
import { CollisionMesh } from './collision.js';
import { buildRoute } from './route.js';
import { trackHash, normalizeLaps } from './codec.js';

export { normalizeLaps };

const MEDAL_KEYS = ['author', 'gold', 'silver', 'bronze'];

// ---------------------------------------------------------------------------
// Normalization and validation

/** Returns a new track with every field present and defaults filled in. */
export function normalizeTrack(track) {
    const t = track || {};
    const medals = {};
    for (const k of MEDAL_KEYS) {
        const v = t.medals ? t.medals[k] : null;
        medals[k] = v == null ? null : (typeof v === 'object' ? { ...v } : v);
    }
    return {
        format: TRACK_FORMAT,
        id: t.id != null ? String(t.id) : 'custom',
        name: t.name != null ? String(t.name) : 'Untitled Track',
        author: t.author != null ? String(t.author) : 'Anonymous',
        mood: MOODS.includes(t.mood) ? t.mood : 'day',
        mode: MODES.includes(t.mode) ? t.mode : 'race',
        laps: normalizeLaps(t.laps),
        medals,
        blocks: (t.blocks || []).map((b) => {
            const def = BLOCKS[b.b];
            return {
                b: b.b,
                x: b.x | 0,
                y: b.y | 0,
                z: b.z | 0,
                r: ((b.r | 0) % 4 + 4) % 4,
                s: b.s || (def ? def.defaultSurface : 'snow'),
            };
        }),
        decor: (t.decor || []).map((d) => ({ d: String(d.d), x: d.x | 0, y: d.y | 0, z: d.z | 0, r: ((d.r | 0) % 4 + 4) % 4 })),
    };
}

function isNormalized(t) {
    return !!t && Array.isArray(t.blocks) && Array.isArray(t.decor) && !!t.medals && t.format === TRACK_FORMAT;
}

/**
 * Validation findings as data. Every issue is { level: 'error'|'warning', code,
 * message, blocks: [block index…], cell?, dir?, checkpointIds?, decor? }; the
 * `errors` / `warnings` string lists mirror the messages.
 */
class Issues {
    constructor() {
        this.issues = [];
        this.errors = [];
        this.warnings = [];
    }

    add(level, code, message, extra = {}) {
        this.issues.push({ level, code, message, blocks: [], ...extra });
        (level === 'error' ? this.errors : this.warnings).push(message);
    }

    error(code, message, extra) {
        this.add('error', code, message, extra);
    }

    warn(code, message, extra) {
        this.add('warning', code, message, extra);
    }
}

/**
 * World-space connectors of a block placed at (x, y, z) with rotation r, whether
 * or not it is part of a track (editor snapping and previews use this too).
 * Each: { local, kind, profile, cell, dir, pos, out } where pos is the face
 * centre at deck level (a lip: its edge) and out the outward unit vector (a lip:
 * its launch tangent).
 */
export function placedConnectors(def, x, y, z, r) {
    if (typeof def === 'string') def = BLOCKS[def];
    const xf = makeTransform(def, x, y, z, r);
    return def.connectors.map((c, local) => {
        const off = rotateCell(def, xf.r, c.cell);
        const cell = [x + off[0], y + off[1], z + off[2]];
        const dir = xf.dir(c.dir);
        const d = DIRS[dir];
        let pos, out;
        if (c.kind === 'lip') {
            pos = xf.point(c.pos);
            out = xf.vector(c.tangent);
        } else {
            pos = [(cell[0] + 0.5 + d[0] * 0.5) * CELL, cell[1] * LAYER, (cell[2] + 0.5 + d[2] * 0.5) * CELL];
            out = [d[0], 0, d[2]];
        }
        return { local, kind: c.kind, profile: c.profile, cell, dir, pos, out };
    });
}

/** Cell key used by analyzeTrack's occupancy map. */
export function cellKey(x, y, z) {
    return (x * 64 + y) * 64 + z;
}

/**
 * Lays out blocks: footprints, connectors and their matches. Shared by
 * validateTrack and buildWorld. Never throws; problems go to `issues` (and the
 * `errors` / `warnings` strings). Accepts a raw track (it is normalized first).
 */
export function analyzeTrack(trackIn, issues = new Issues()) {
    const track = isNormalized(trackIn) ? trackIn : normalizeTrack(trackIn);
    const placements = [];
    const occupancy = new Map();   // cell key -> block index

    track.blocks.forEach((blk, index) => {
        const def = BLOCKS[blk.b];
        if (!def) {
            issues.error('unknownBlock', `Block #${index}: unknown block id '${blk.b}'`, { blocks: [index] });
            placements.push(null);
            return;
        }
        if (!def.surfaces.includes(blk.s)) issues.error('surface', `Block #${index} (${blk.b}): surface '${blk.s}' not allowed`, { blocks: [index] });
        const size = footprintSize(def, blk.r);
        const inBounds = blk.x >= 0 && blk.y >= 0 && blk.z >= 0
            && blk.x + size[0] <= MAP_X && blk.y + size[1] <= MAP_Y && blk.z + size[2] <= MAP_Z;
        if (!inBounds) issues.error('outside', `Block #${index} (${blk.b}) at ${blk.x},${blk.y},${blk.z}: outside the map`, { blocks: [index], cell: [blk.x, blk.y, blk.z] });
        for (let x = 0; x < size[0]; x++) {
            for (let y = 0; y < size[1]; y++) {
                for (let z = 0; z < size[2]; z++) {
                    const cx = blk.x + x, cy = blk.y + y, cz = blk.z + z;
                    const k = cellKey(cx, cy, cz);
                    const other = occupancy.get(k);
                    if (other !== undefined) {
                        issues.error('overlap', `Block #${index} (${blk.b}) overlaps block #${other} (${track.blocks[other].b}) at ${cx},${cy},${cz}`,
                            { blocks: [index, other], cell: [cx, cy, cz] });
                    } else {
                        occupancy.set(k, index);
                    }
                }
            }
        }
        placements.push({ index, def, ...blk, size, xf: makeTransform(def, blk.x, blk.y, blk.z, blk.r) });
    });

    // Connectors in world space, matched across shared faces.
    const connectors = [];
    const faces = new Map();
    for (const pl of placements) {
        if (!pl) continue;
        pl.connectors = [];
        for (const c of placedConnectors(pl.def, pl.x, pl.y, pl.z, pl.r)) {
            const rec = { index: connectors.length, block: pl.index, ...c, match: -1 };
            connectors.push(rec);
            pl.connectors.push(rec.index);
            if (c.kind !== 'lip') {
                // Faces are keyed by the cell on their -X/-Z side plus the axis.
                const fx = c.dir === 1 ? c.cell[0] - 1 : c.cell[0];
                const fz = c.dir === 2 ? c.cell[2] - 1 : c.cell[2];
                const key = `${fx},${c.cell[1]},${fz},${c.dir & 1}`;
                const list = faces.get(key);
                if (list) list.push(rec.index);
                else faces.set(key, [rec.index]);
            }
        }
    }
    for (const list of faces.values()) {
        if (list.length === 2) {
            const [a, b] = list;
            if (connectors[a].block !== connectors[b].block && connectors[a].dir === ((connectors[b].dir + 2) & 3)) {
                connectors[a].match = b;
                connectors[b].match = a;
            }
        }
    }

    // Rules
    const spawnBlocks = placements.filter((p) => p && p.def.spawn);
    const finishes = placements.filter((p) => p && (p.def.gate === 'finish' || p.def.gate === 'startfinish'));
    const hasSF = placements.some((p) => p && p.def.gate === 'startfinish');
    if (spawnBlocks.length === 0) issues.error('noSpawn', 'No Start (or StartFinish) block');
    if (spawnBlocks.length > 1) {
        issues.error('multiSpawn', `Only one Start or StartFinish block allowed (found ${spawnBlocks.length})`, { blocks: spawnBlocks.map((p) => p.index) });
    }
    if (finishes.length === 0) issues.error('noFinish', 'No Finish (or StartFinish) block');
    if (track.laps > 1 && !hasSF) issues.error('lapsNoStartFinish', 'Multilap tracks need a StartFinish block');
    if (hasSF && track.laps === 1) issues.warn('startFinishOneLap', 'StartFinish track with 1 lap: start and finish share the line');
    if (track.laps > 1) {
        const arches = placements.filter((p) => p && p.def.gate === 'finish').map((p) => p.index);
        if (arches.length) issues.warn('finishOnLapTrack', 'Finish arches on a lap track only count on the last lap', { blocks: arches });
    }
    const ord = MEDAL_KEYS.map((k) => track.medals[k]).filter((v) => typeof v === 'number');
    for (let i = 1; i < ord.length; i++) {
        if (ord[i] < ord[i - 1]) { issues.warn('medalOrder', 'Medal times are not in order (author <= gold <= silver <= bronze)'); break; }
    }
    track.decor.forEach((d, i) => {
        if (d.x < 0 || d.z < 0 || d.y < 0 || d.x >= MAP_X || d.z >= MAP_Z || d.y >= MAP_Y) issues.warn('decorOutside', `Decor #${i} is outside the map`, { decor: i });
    });
    return {
        track, placements, connectors, occupancy, cellKey,
        issues: issues.issues, errors: issues.errors, warnings: issues.warnings,
    };
}

/**
 * Raw-input checks normalizeTrack would silently paper over (fractional or
 * missing coordinates, bad lap counts). Returns false when the track is too
 * malformed to analyse at all.
 */
function checkRawTrack(track, issues) {
    if (!track || typeof track !== 'object') {
        issues.error('malformed', 'Malformed track: not an object');
        return false;
    }
    if (track.blocks != null && !Array.isArray(track.blocks)) {
        issues.error('malformed', 'Malformed track: blocks is not an array');
        return false;
    }
    let ok = true;
    (track.blocks || []).forEach((b, i) => {
        if (!b || typeof b !== 'object') {
            issues.error('malformed', `Block #${i} is not an object`, { blocks: [i] });
            ok = false;
            return;
        }
        const bad = ['x', 'y', 'z'].filter((k) => !Number.isInteger(b[k]));
        if (b.r != null && !Number.isInteger(b.r)) bad.push('r');
        if (bad.length) {
            const what = bad.map((k) => `${k} = ${JSON.stringify(b[k]) ?? 'missing'}`).join(', ');
            issues.error('badCoordinate', `Block #${i} (${b.b}): ${what}; coordinates and rotation must be integers`, { blocks: [i] });
        }
    });
    if (track.laps != null && !(Number.isInteger(track.laps) && track.laps > 0)) {
        issues.error('badLaps', `laps = ${JSON.stringify(track.laps)} must be a positive integer`);
    }
    return ok;
}

/**
 * Checks every rule a playable track must satisfy.
 * Returns { ok, errors: string[], warnings: string[], issues: Issue[] }.
 */
export function validateTrack(track) {
    const issues = new Issues();
    const result = () => ({ ok: issues.errors.length === 0, errors: issues.errors, warnings: issues.warnings, issues: issues.issues });
    if (!checkRawTrack(track, issues)) return result();
    const an = analyzeTrack(normalizeTrack(track), issues);
    if (issues.errors.length === 0) {
        try {
            const route = routeFor(an.track, an);
            if (an.track.laps > 1 && !route.closed) {
                issues.error('lapNotClosed', 'The lap route does not come back to the StartFinish line');
            }
        } catch (e) {
            const { code = 'route', message, level, ...extra } = e.issue || {};
            issues.error(code, e.message, extra);
        }
    }
    if (issues.errors.length === 0) openEnds(an, issues);
    return result();
}

function openEnds(an, issues) {
    for (const c of an.connectors) {
        if (c.match >= 0 || c.kind !== 'road') continue;
        const b = an.track.blocks[c.block];
        issues.warn('openEnd', `Open road end: block #${c.block} (${b.b}) at ${c.cell.join(',')} facing ${DIR_NAMES[c.dir]}`,
            { blocks: [c.block], cell: c.cell.slice(), dir: c.dir, connector: c.local });
    }
}

/** Collects world-space paths and trigger ids, then searches the route. */
function routeFor(track, an) {
    const { triggers } = collectTriggers(an);
    const paths = [];
    for (const pl of an.placements) {
        if (!pl) continue;
        const geo = getBlockGeometry(pl.b, pl.s);
        for (const p of geo.paths) {
            paths.push({
                block: pl.index,
                a: p.a < 0 ? -1 : pl.connectors[p.a],
                b: pl.connectors[p.b],
                pts: transformArray(p.pts, pl.xf, true),
                ups: transformArray(p.ups, pl.xf, false),
                hw: p.hw,
                surface: SURFACE_INDEX[pl.s],
                spawnAt: p.spawnAt,
                events: p.events.map((ev) => {
                    const trg = triggers[pl.triggerBase + ev.trigger];
                    return { type: trg.type, id: trg.id, at: ev.at };
                }),
            });
        }
    }
    const cps = triggers.filter((t) => t.type === 'checkpoint');
    const connectors = an.connectors.map((c) => ({ block: c.block, kind: c.kind, match: c.match, pos: c.pos, dir: c.out }));
    return buildRoute({
        connectors, paths, checkpointCount: cps.length, checkpointBlocks: cps.map((t) => t.blockIndex), laps: track.laps,
    });
}

function transformArray(src, xf, isPoint) {
    const out = new Float64Array(src.length);
    const tmp = [0, 0, 0], res = [0, 0, 0];
    for (let i = 0; i < src.length; i += 3) {
        tmp[0] = src[i]; tmp[1] = src[i + 1]; tmp[2] = src[i + 2];
        if (isPoint) xf.point(tmp, res); else xf.vector(tmp, res);
        out[i] = res[0]; out[i + 1] = res[1]; out[i + 2] = res[2];
    }
    return out;
}

/** World triggers in block order; checkpoint/finish ids count up per type. */
function collectTriggers(an) {
    const triggers = [];
    const counters = { checkpoint: 0, finish: 0, start: 0, startfinish: 0, effect: 0 };
    for (const pl of an.placements) {
        if (!pl) continue;
        const geo = getBlockGeometry(pl.b, pl.s);
        pl.triggerBase = triggers.length;
        for (const t of geo.triggers) {
            const a = pl.xf.point(t.min), b = pl.xf.point(t.max);
            const min = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])];
            const max = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])];
            const trg = {
                index: triggers.length,
                type: t.type,
                id: counters[t.type]++,
                min, max,
                center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
                dir: pl.xf.dir(0),
                blockIndex: pl.index,
            };
            if (t.effect) trg.effect = t.effect;
            triggers.push(trg);
        }
    }
    return { triggers, counters };
}

// ---------------------------------------------------------------------------
// Path builder

const PIECES = {};

function piece(name, block, entry, exit) {
    PIECES[name] = { block, entry, exit };
}

for (const id of ['Straight', 'Checkpoint', 'Finish', 'StartFinish', 'Narrow', 'Tunnel', 'Bump',
    'Turbo', 'Turbo2', 'NoEngine', 'NoSteer', 'NoBrake', 'SlowMo', 'Cruise', 'Fragile', 'Reset']) {
    piece(id, id, 0, 1);
}
piece('Start', 'Start', null, 0);
for (const n of [1, 2, 3]) {
    piece(`Turn${n}L`, `Turn${n}`, 0, 1);
    piece(`Turn${n}R`, `Turn${n}`, 1, 0);
}
for (const n of [2, 3]) {
    piece(`Bank${n}L`, `Bank${n}`, 0, 1);
    piece(`Bank${n}R`, `Bank${n}`, 1, 0);
}
piece('SlopeUp1', 'SlopeUp1', 0, 1);
piece('SlopeDown1', 'SlopeUp1', 1, 0);
piece('SlopeUp2', 'SlopeUp2', 0, 1);
piece('SlopeDown2', 'SlopeUp2', 1, 0);
piece('SlopeBig', 'SlopeBig', 0, 1);
piece('SlopeBigUp', 'SlopeBig', 0, 1);
piece('SlopeBigDown', 'SlopeBig', 1, 0);
piece('RampSmall', 'RampSmall', 0, 1);
piece('RampBig', 'RampBig', 0, 1);
piece('Loop', 'Loop', 0, 1);
piece('LoopR', 'Loop', 0, 1);
piece('LoopL', 'LoopL', 0, 1);
// Cross/Platform connectors are indexed by local direction; enter from the back (2).
piece('Cross', 'Cross', 2, 0);
piece('CrossL', 'Cross', 2, 3);
piece('CrossR', 'Cross', 2, 1);
piece('Platform', 'Platform', 2, 0);
piece('PlatformL', 'Platform', 2, 3);
piece('PlatformR', 'Platform', 2, 1);
piece('PlatformRamp', 'PlatformRamp', 0, 1);
piece('PlatformRampUp', 'PlatformRamp', 0, 1);
piece('PlatformRampDown', 'PlatformRamp', 1, 0);

/** Names accepted by trackFromPath (besides the turtle moves Gap/Up/Down/Left/Right). */
export const PIECE_NAMES = Object.keys(PIECES);
const TURTLE_MOVES = ['Gap', 'Up', 'Down', 'Left', 'Right'];
// Piece names are matched case-insensitively.
const PIECE_BY_LOWER = new Map([...PIECE_NAMES, ...TURTLE_MOVES].map((n) => [n.toLowerCase(), n]));

/**
 * Places one block so that the cell of its connector `entry` is `cell` and the
 * car drives in through that connector heading `dir`. `cell` is the turtle
 * cell: the first cell past the previous block's open face, i.e. the cell just
 * beyond a connector you snap to (`connector.cell + DIRS[connector.dir]`).
 * `entry: null` places a spawn block (local cell [0,0,0] on `cell`, facing
 * `dir`). Returns { block, next: the turtle cell past the exit face, dir: the
 * heading out of the exit }.
 */
export function placeByConnector(blockId, entry, exit, cell, dir, surface) {
    const def = BLOCKS[blockId];
    if (!def) throw new Error(`unknown block '${blockId}'`);
    let r, anchor;
    if (entry === null) {
        // Spawn blocks: the turtle cell is local [0,0,0] and local +Z faces `dir`.
        r = dir;
        const off = rotateCell(def, r, [0, 0, 0]);
        anchor = [cell[0] - off[0], cell[1] - off[1], cell[2] - off[2]];
    } else {
        const c = def.connectors[entry];
        const heading = (c.dir + 2) & 3;
        r = (dir - heading + 4) & 3;
        const off = rotateCell(def, r, c.cell);
        anchor = [cell[0] - off[0], cell[1] - off[1], cell[2] - off[2]];
    }
    const x = def.connectors[exit];
    const off = rotateCell(def, r, x.cell);
    const wdir = (x.dir + r) & 3;
    const d = DIRS[wdir];
    const ex = [anchor[0] + off[0], anchor[1] + off[1], anchor[2] + off[2]];
    return {
        block: { b: blockId, x: anchor[0], y: anchor[1], z: anchor[2], r, s: surface || def.defaultSurface },
        next: [ex[0] + d[0], ex[1], ex[2] + d[2]],
        dir: wdir,
    };
}

function parsePiece(p) {
    if (typeof p === 'object' && p) {
        if (p.at || p.mark != null || p.goto != null) return { control: p };
        if (p.d != null) return { decor: p };
        if (p.b == null) throw new Error("missing 'b' (a piece name or block id)");
        // { b: 'Turn2R', s, n } or, for any block, explicit connectors { b: 'Cross', entry: 2, exit: 3 }.
        const custom = Number.isInteger(p.exit) && BLOCKS[p.b] ? { block: p.b, entry: p.entry ?? null, exit: p.exit } : null;
        return { name: canonicalPiece(String(p.b)), count: p.n || 1, surface: p.s || null, custom };
    }
    const m = /^([A-Za-z0-9]+)(?:\*(\d+))?(?::(snow|powder|ice))?$/i.exec(String(p).trim());
    if (!m) throw new Error(`cannot parse '${p}'`);
    return { name: canonicalPiece(m[1]), count: m[2] ? parseInt(m[2], 10) : 1, surface: m[3] ? m[3].toLowerCase() : null };
}

function canonicalPiece(name) {
    return PIECE_BY_LOWER.get(name.toLowerCase()) || name;
}

/**
 * Turtle builder: lays pieces end to end from `start: [x, y, z, dir]`.
 * spec = { id, name, author, mood, mode, laps, medals, start, surface, pieces, extra, decor }
 * Besides block pieces, `pieces` may hold turtle moves ('Gap', 'Up', 'Down',
 * 'Left', 'Right', each with *n), { at: [x, y, z, dir] } (jump the turtle),
 * { mark: 'A' } / { goto: 'A' } (remember and return to a turtle position, e.g.
 * for a second branch) and decor next to the turtle
 * { d: 'Pine', side: 'left' | 'right', dist = 1, r = 0 }.
 * Throws Error('piece #i ...') on unknown pieces, overlaps or leaving the map.
 */
export function trackFromPath(spec) {
    let cell = [spec.start[0], spec.start[1], spec.start[2]];
    let dir = spec.start[3] || 0;
    const blocks = [];
    const decor = (spec.decor || []).slice();
    const marks = new Map();
    const occ = new Map();
    const key = (x, y, z) => `${x},${y},${z}`;
    const add = (blk, label) => {
        const def = BLOCKS[blk.b];
        if (!def) throw new Error(`${label}: unknown block '${blk.b}'`);
        const size = footprintSize(def, blk.r);
        if (blk.x < 0 || blk.y < 0 || blk.z < 0 || blk.x + size[0] > MAP_X || blk.y + size[1] > MAP_Y || blk.z + size[2] > MAP_Z) {
            throw new Error(`${label} (${blk.b}) at ${blk.x},${blk.y},${blk.z} r${blk.r} leaves the map`);
        }
        for (let x = 0; x < size[0]; x++)
            for (let y = 0; y < size[1]; y++)
                for (let z = 0; z < size[2]; z++) {
                    const k = key(blk.x + x, blk.y + y, blk.z + z);
                    if (occ.has(k)) throw new Error(`${label} (${blk.b}) overlaps ${occ.get(k)} at ${k}`);
                }
        for (let x = 0; x < size[0]; x++)
            for (let y = 0; y < size[1]; y++)
                for (let z = 0; z < size[2]; z++) occ.set(key(blk.x + x, blk.y + y, blk.z + z), `${label} (${blk.b})`);
        blocks.push(blk);
    };

    (spec.pieces || []).forEach((raw, i) => {
        const label = `piece #${i} '${typeof raw === 'string' ? raw : JSON.stringify(raw)}'`;
        let pc;
        try {
            pc = parsePiece(raw);
        } catch (e) {
            throw new Error(`${label}: ${e.message}`);
        }
        if (pc.control) {
            const c = pc.control;
            if (c.at) {
                cell = [c.at[0], c.at[1], c.at[2]];
                dir = ((c.at[3] | 0) % 4 + 4) % 4;
            } else if (c.mark != null) {
                marks.set(String(c.mark), { cell: cell.slice(), dir });
            } else {
                const m = marks.get(String(c.goto));
                if (!m) throw new Error(`${label}: no mark '${c.goto}'`);
                cell = m.cell.slice();
                dir = m.dir;
            }
            return;
        }
        if (pc.decor) {
            const p = pc.decor;
            const side = p.side === 'left' ? (dir + 3) & 3 : p.side === 'right' ? (dir + 1) & 3 : null;
            if (side === null) throw new Error(`${label}: decor needs side: 'left' or 'right'`);
            const n = p.dist ?? 1;
            decor.push({ d: p.d, x: cell[0] + DIRS[side][0] * n, y: cell[1], z: cell[2] + DIRS[side][2] * n, r: p.r ?? 0 });
            return;
        }
        for (let k = 0; k < pc.count; k++) {
            if (pc.name === 'Gap') {
                cell = [cell[0] + DIRS[dir][0], cell[1], cell[2] + DIRS[dir][2]];
                continue;
            }
            if (pc.name === 'Up' || pc.name === 'Down') {
                cell = [cell[0], cell[1] + (pc.name === 'Up' ? 1 : -1), cell[2]];
                continue;
            }
            if (pc.name === 'Left' || pc.name === 'Right') {
                const d = DIRS[pc.name === 'Left' ? (dir + 3) & 3 : (dir + 1) & 3];
                cell = [cell[0] + d[0], cell[1], cell[2] + d[2]];
                continue;
            }
            const def = pc.custom || PIECES[pc.name];
            if (!def) throw new Error(`${label}: unknown piece '${pc.name}'`);
            if (def.exit >= BLOCKS[def.block].connectors.length || (def.entry !== null && def.entry >= BLOCKS[def.block].connectors.length)) {
                throw new Error(`${label}: ${def.block} has no such connector`);
            }
            const surface = pc.surface || (BLOCKS[def.block].surfaces.includes(spec.surface) ? spec.surface : null);
            const res = placeByConnector(def.block, def.entry, def.exit, cell, dir, surface);
            add(res.block, label);
            cell = res.next;
            dir = res.dir;
        }
    });
    (spec.extra || []).forEach((blk, i) => {
        if (!blk || !BLOCKS[blk.b]) throw new Error(`extra #${i}: unknown block '${blk && blk.b}'`);
        add({ r: 0, s: BLOCKS[blk.b].defaultSurface, ...blk }, `extra #${i}`);
    });

    return normalizeTrack({
        id: spec.id, name: spec.name, author: spec.author, mood: spec.mood, mode: spec.mode,
        laps: spec.laps, medals: spec.medals, blocks, decor,
    });
}

// ---------------------------------------------------------------------------
// World

/**
 * Whether a block's optional cap part is drawn, given the profile of whatever
 * is attached on that connector's face (null = nothing). Parts are the
 * 'cap:<connector>:<part>' geometry groups: 'border', 'deck', 'roof', 'side'.
 */
export function capNeeded(part, other) {
    if (other === null) return true;
    if (part === 'border') return other === 'platform';
    if (part === 'roof') return other !== 'tunnel';
    return false;   // deck slab and platform side are covered by any attached block
}

const PILLAR_SIZE = 2;
const MIN_PILLAR = 1.5;

/** Geometry groups of one placement, caps chosen from the neighbours' profiles (null = open). */
function placementParts(pl, profileOf) {
    const parts = [];
    const geo = getBlockGeometry(pl.b, pl.s);
    for (const [key, group] of geo.groups) {
        if (key !== 'main') {
            const [, li, part] = key.split(':');
            if (!capNeeded(part, profileOf(+li))) continue;
        }
        parts.push({ pl, group });
    }
    return parts;
}

/**
 * Builds the static world for a track (see docs/CORE_API.md for the shape).
 * Deterministic and cached per block type, so repeated builds are cheap.
 * opts.route = false skips the route search (editor previews of broken tracks).
 */
export function buildWorld(trackIn, opts = {}) {
    const track = normalizeTrack(trackIn);
    const an = analyzeTrack(track);
    const unknown = an.placements.findIndex((p) => !p);
    if (unknown >= 0) throw new Error(`Block #${unknown}: unknown block id '${track.blocks[unknown].b}'`);
    const { placements, connectors } = an;
    const { triggers } = collectTriggers(an);

    // Gather geometry groups per placement.
    const parts = [];   // { pl, group }
    for (const pl of placements) {
        parts.push(...placementParts(pl, (li) => {
            const c = connectors[pl.connectors[li]];
            return c.match >= 0 ? connectors[c.match].profile : null;
        }));
    }

    // Pillars under elevated blocks: one per footprint column the deck passes
    // over, placed on the centerline nearest the column centre, when the column
    // below is free all the way to the ground.
    const pillars = [];
    for (const pl of placements) {
        if (pl.y === 0) continue;
        const geo = getBlockGeometry(pl.b, pl.s);
        const cols = new Map();
        const tmp = [0, 0, 0], w = [0, 0, 0];
        const margin = PILLAR_SIZE / 2;
        const base = pl.y * LAYER;
        for (const p of geo.paths) {
            for (let i = 0; i < p.pts.length; i += 3) {
                tmp[0] = p.pts[i]; tmp[1] = p.pts[i + 1]; tmp[2] = p.pts[i + 2];
                pl.xf.point(tmp, w);
                // Solid blocks sit on their base; hanging decks (the loop) only where the
                // deck is at base height, so the pillar top meets the slab underside.
                if (pl.def.hanging && Math.abs(w[1] - base) > 0.01) continue;
                const cx = Math.floor(w[0] / CELL), cz = Math.floor(w[2] / CELL);
                const lx = w[0] - cx * CELL, lz = w[2] - cz * CELL;
                if (cx < pl.x || cz < pl.z || cx >= pl.x + pl.size[0] || cz >= pl.z + pl.size[2]) continue;
                if (lx < margin || lz < margin || lx > CELL - margin || lz > CELL - margin) continue;
                const k = cx * 1000 + cz;
                const dc = sq(lx - CELL / 2) + sq(lz - CELL / 2);
                const cur = cols.get(k);
                if (!cur || dc < cur.dc - 1e-9) cols.set(k, { dc, cx, cz, x: w[0], z: w[2] });
            }
        }
        const sorted = [...cols.values()].sort((a, b) => a.cx - b.cx || a.cz - b.cz);
        for (const c of sorted) {
            let free = true;
            for (let y = 0; y < pl.y && free; y++) if (an.occupancy.has(cellKey(c.cx, y, c.cz))) free = false;
            const top = base - DECK_THICKNESS;
            if (!free || top - GROUND_Y < MIN_PILLAR) continue;
            pillars.push({ x: c.x, z: c.z, bottom: GROUND_Y, top, blockIndex: pl.index });
        }
    }

    // Collision triangles, each tagged with the block it belongs to.
    let triCount = 0;
    for (const { group } of parts) triCount += group.surf.length;
    triCount += pillars.length * 8;
    const positions = new Float64Array(triCount * 9);
    const surfaces = new Uint8Array(triCount);
    const triBlock = new Int32Array(triCount);
    let t = 0;
    const tmp = [0, 0, 0], res = [0, 0, 0];
    for (const { pl, group } of parts) {
        const col = group.col;
        const t0 = t;
        for (let i = 0; i < col.length; i += 3) {
            tmp[0] = col[i]; tmp[1] = col[i + 1]; tmp[2] = col[i + 2];
            pl.xf.point(tmp, res);
            positions[t * 9 + (i % 9)] = res[0];
            positions[t * 9 + (i % 9) + 1] = res[1];
            positions[t * 9 + (i % 9) + 2] = res[2];
            if (i % 9 === 6) t++;
        }
        surfaces.set(group.surf, t0);
        triBlock.fill(pl.index, t0, t);
    }
    for (const p of pillars) {
        const h = PILLAR_SIZE / 2;
        const c = [[p.x - h, p.z - h], [p.x + h, p.z - h], [p.x + h, p.z + h], [p.x - h, p.z + h]];
        for (let k = 0; k < 4; k++) {
            const [ax, az] = c[k], [bx, bz] = c[(k + 1) % 4];
            // This corner order makes every side's normal point away from the pillar.
            const quad = [[ax, p.bottom, az], [ax, p.top, az], [bx, p.top, bz], [bx, p.bottom, bz]];
            for (const [i0, i1, i2] of [[0, 1, 2], [0, 2, 3]]) {
                for (const [j, v] of [quad[i0], quad[i1], quad[i2]].entries()) {
                    positions[t * 9 + j * 3] = v[0]; positions[t * 9 + j * 3 + 1] = v[1]; positions[t * 9 + j * 3 + 2] = v[2];
                }
                triBlock[t] = p.blockIndex;
                surfaces[t++] = SURFACE_INDEX.wall;
            }
        }
    }
    const mapMax = [MAP_X * CELL, MAP_Z * CELL];
    const collision = new CollisionMesh(positions, surfaces, {
        ground: { y: GROUND_Y, minX: 0, maxX: mapMax[0], minZ: 0, maxZ: mapMax[1], surface: SURFACE_INDEX.ground },
    });
    collision.triBlock = triBlock;

    // Render meshes merged per material.
    const meshes = buildRenderMeshes(parts);
    meshes.push(groundMesh(mapMax));

    // Props
    const props = [];
    for (const pl of placements) {
        const geo = getBlockGeometry(pl.b, pl.s);
        for (const pr of geo.props) {
            props.push({ ...pr, pos: pl.xf.point(pr.pos), dir: pl.xf.dir(pr.dir || 0), blockIndex: pl.index });
        }
    }
    for (const p of pillars) {
        props.push({ kind: 'pillar', pos: [p.x, p.bottom, p.z], height: p.top - p.bottom, size: PILLAR_SIZE, blockIndex: p.blockIndex });
    }
    track.decor.forEach((d, i) => {
        props.push({ kind: 'decor', decor: d.d, pos: [(d.x + 0.5) * CELL, d.y * LAYER, (d.z + 0.5) * CELL], dir: d.r, decorIndex: i });
    });

    // Spawn
    let spawn = null;
    const sp = placements.find((p) => p.def.spawn);
    if (sp) {
        const dir = sp.xf.dir(sp.def.spawn.dir);
        spawn = { pos: sp.xf.point(sp.def.spawn.pos), dir, quat: DIR_QUATS[dir].slice(), blockIndex: sp.index };
        props.push({ kind: 'spawn', pos: spawn.pos.slice(), dir, blockIndex: sp.index });
    }

    let route = null, routeError = null;
    const issues = an.issues.slice();
    if (opts.route !== false && an.errors.length === 0) {
        try {
            route = routeFor(track, an);
        } catch (e) {
            routeError = e.message;
            const { code = 'route', message, level, ...extra } = e.issue || {};
            issues.push({ level: 'error', code, message: e.message, blocks: [], ...extra });
        }
    }

    const occupancy = an.occupancy;
    const b = collision.bounds;
    return {
        track,
        hash: trackHash(track),
        laps: track.laps,
        mode: track.mode,
        collision,
        triggers,
        checkpointCount: triggers.filter((x) => x.type === 'checkpoint').length,
        spawn,
        route,
        routeError,
        errors: an.errors,
        warnings: an.warnings,
        issues,
        render: { meshes, props },
        bounds: { min: b.min.slice(), max: b.max.slice() },
        groundY: GROUND_Y,
        fallY: FALL_Y,
        mapSize: [MAP_X * CELL, MAP_Y * LAYER, MAP_Z * CELL],
        occupancy,
        /** Index of the block whose footprint holds cell (x, y, z), or -1. */
        blockAt(x, y, z) {
            if (x < 0 || y < 0 || z < 0 || x >= 64 || y >= 64 || z >= 64) return -1;
            const i = occupancy.get(cellKey(x, y, z));
            return i === undefined ? -1 : i;
        },
        blocks: placements.map((p) => ({
            index: p.index, b: p.b, x: p.x, y: p.y, z: p.z, r: p.r, s: p.s, size: p.size,
            connectors: p.connectors.map((ci) => {
                const c = connectors[ci];
                return {
                    local: c.local, kind: c.kind, profile: c.profile, cell: c.cell, dir: c.dir, pos: c.pos,
                    match: c.match >= 0 ? { block: connectors[c.match].block, connector: connectors[c.match].local } : null,
                };
            }),
        })),
    };
}

/**
 * World-space render meshes of one block placed at (x, y, z, r) with surface s,
 * shaped exactly like world.render.meshes (minus the ground), for editor ghost
 * previews. neighbourProfiles[localConnector] is the profile attached there
 * ('road' | 'tunnel' | 'platform', null or missing = open), which picks the
 * same end caps buildWorld would draw.
 */
export function blockPreview(b, x, y, z, r = 0, s = null, neighbourProfiles = null) {
    const def = BLOCKS[b];
    if (!def) throw new Error(`unknown block '${b}'`);
    const surface = s || def.defaultSurface;
    const pl = { index: 0, def, b, s: surface, x, y, z, r: r & 3, xf: makeTransform(def, x, y, z, r & 3) };
    return buildRenderMeshes(placementParts(pl, (li) => (neighbourProfiles && neighbourProfiles[li]) || null));
}

/**
 * Render meshes merged per material, sorted by id. Each mesh also lists
 * `ranges: [{ blockIndex, start, count }]`: the slice of `indices` (start and
 * count in indices, multiples of 3) that belongs to each block, for picking
 * highlights and hiding single blocks.
 */
function buildRenderMeshes(parts) {
    const byMat = new Map();
    for (const { pl, group } of parts) {
        for (const m of group.meshes) {
            let e = byMat.get(m.material);
            if (!e) {
                e = { verts: 0, idx: 0, list: [] };
                byMat.set(m.material, e);
            }
            e.list.push({ pl, m });
            e.verts += m.pos.length / 3;
            e.idx += m.idx.length;
        }
    }
    const meshes = [];
    const tmp = [0, 0, 0], res = [0, 0, 0];
    const mats = [...byMat.keys()].sort();
    for (const material of mats) {
        const e = byMat.get(material);
        const positions = new Float32Array(e.verts * 3), normals = new Float32Array(e.verts * 3);
        const uvs = new Float32Array(e.verts * 2), indices = new Uint32Array(e.idx);
        const ranges = [];
        let v = 0, k = 0;
        for (const { pl, m } of e.list) {
            const n = m.pos.length / 3;
            for (let i = 0; i < n; i++) {
                tmp[0] = m.pos[i * 3]; tmp[1] = m.pos[i * 3 + 1]; tmp[2] = m.pos[i * 3 + 2];
                pl.xf.point(tmp, res);
                positions[(v + i) * 3] = res[0]; positions[(v + i) * 3 + 1] = res[1]; positions[(v + i) * 3 + 2] = res[2];
                tmp[0] = m.nrm[i * 3]; tmp[1] = m.nrm[i * 3 + 1]; tmp[2] = m.nrm[i * 3 + 2];
                pl.xf.vector(tmp, res);
                normals[(v + i) * 3] = res[0]; normals[(v + i) * 3 + 1] = res[1]; normals[(v + i) * 3 + 2] = res[2];
                uvs[(v + i) * 2] = m.uv[i * 2]; uvs[(v + i) * 2 + 1] = m.uv[i * 2 + 1];
            }
            for (let i = 0; i < m.idx.length; i++) indices[k + i] = m.idx[i] + v;
            const last = ranges[ranges.length - 1];
            if (last && last.blockIndex === pl.index && last.start + last.count === k) last.count += m.idx.length;
            else ranges.push({ blockIndex: pl.index, start: k, count: m.idx.length });
            v += n;
            k += m.idx.length;
        }
        meshes.push({ material, positions, normals, uvs, indices, ranges });
    }
    return meshes;
}

/** One quad over the whole map at GROUND_Y (coplanar with level-0 decks: draw it with a polygon offset). */
function groundMesh(mapMax) {
    const y = GROUND_Y;
    return {
        material: 'ground',
        positions: new Float32Array([0, y, 0, mapMax[0], y, 0, mapMax[0], y, mapMax[1], 0, y, mapMax[1]]),
        normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
        uvs: new Float32Array([0, 0, mapMax[0], 0, mapMax[0], mapMax[1], 0, mapMax[1]]),
        indices: new Uint32Array([0, 2, 1, 0, 3, 2]),
        ranges: [{ blockIndex: -1, start: 0, count: 6 }],
    };
}
