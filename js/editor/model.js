// Track editor model: the track being edited, its undo history, placement
// rules (fit, footprints, connector snapping) and validation runs. Pure: no DOM,
// no three.js, so tools/tests/editor.test.mjs drives it in Node.
import { BLOCKS, BLOCK_LIST, footprintSize, rotateCell } from '../core/blocks.js';
import { normalizeTrack, analyzeTrack, placeByConnector } from '../core/track.js';
import { trackHash } from '../core/codec.js';
import { DIRS, MAP_X, MAP_Y, MAP_Z, MOODS, MODES } from '../core/constants.js';

export const MAP = { x: MAP_X, y: MAP_Y, z: MAP_Z };

/** Palette groups in display order (block categories from the core catalog). */
export const CATEGORIES = [
    { id: 'road', name: 'Roads' },
    { id: 'turn', name: 'Bends' },
    { id: 'slope', name: 'Slopes' },
    { id: 'gate', name: 'Gates' },
    { id: 'special', name: 'Pads' },
    { id: 'stunt', name: 'Stunts' },
    { id: 'platform', name: 'Snowfields' },
];

export function blocksIn(category) {
    return BLOCK_LIST.filter((d) => d.category === category);
}

export const DECOR_INFO = {
    Pine: 'A lone snowy pine.',
    PineCluster: 'Five pines huddled together.',
    Igloo: 'A cosy igloo.',
    Snowman: 'Carrot nose included.',
    PenguinCrowd: 'Three rows of cheering penguins, facing the arrow.',
    Penguin: 'One curious penguin.',
    IceCrystal: 'A glowing ice crystal.',
    Rock: 'A frosty boulder.',
    Banner: 'A trackside banner, facing the arrow.',
    Lamp: 'A lamp post (lights up at night).',
};

// Blocks whose two ends look and drive the same: flipping them while snapped changes nothing.
const SYMMETRIC = new Set(['Straight', 'Tunnel', 'Narrow', 'Bump', 'Checkpoint', 'Cross', 'Platform']);
const HISTORY_MAX = 2000;
const VALIDATIONS_MAX = 40;

export function newTrackId() {
    return 'c' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36);
}

/** An empty map with a Start igloo near the middle, facing +Z. */
export function newTrack({ author = 'Penguin', id = newTrackId(), name = 'Untitled Track' } = {}) {
    return normalizeTrack({
        format: 1, id, name, author, mood: 'day', mode: 'race', laps: 1,
        blocks: [{ b: 'Start', x: 23, y: 0, z: 20, r: 0, s: 'snow' }],
        decor: [],
    });
}

/**
 * Medals from a validation run, with the same formulas as tools/bake-levels.mjs
 * (race) and LEVELS.md (platform). A platform run with respawns keeps them in its
 * Emperor requirement and shifts the respawn caps, so the medals stay reachable.
 */
export function medalsFromAuthor(authorMs, mode = 'race', respawns = 0) {
    if (!Number.isFinite(authorMs)) return { author: null, gold: null, silver: null, bronze: null };
    if (mode === 'platform') {
        const r = Math.max(0, respawns | 0);
        if (r === 0) return { author: authorMs, gold: 0, silver: 3, bronze: 10 };
        return { author: { respawns: r, ms: authorMs }, gold: r, silver: r + 3, bronze: r + 10 };
    }
    return {
        author: authorMs,
        gold: Math.ceil((authorMs * 106) / 10000) * 100,
        silver: Math.ceil((authorMs * 12) / 10000) * 1000,
        bronze: Math.ceil((authorMs * 15) / 10000) * 1000,
    };
}

/** True when run a beats run b (platform: fewer respawns first). */
export function betterRun(mode, a, b) {
    if (!a || !Number.isFinite(a.timeMs)) return false;
    if (!b || !Number.isFinite(b.timeMs)) return true;
    if (mode === 'platform' && (a.respawns || 0) !== (b.respawns || 0)) return (a.respawns || 0) < (b.respawns || 0);
    return a.timeMs < b.timeMs;
}

/**
 * Where a block lands when the cursor is on `cell` with rotation r: the cell
 * of its entry connector (connector 0; a Start's own cell) sits on the cursor,
 * so "the car enters here" whatever the block's size.
 */
export function placementAt(id, cell, r, s) {
    const def = BLOCKS[id];
    r &= 3;
    const pivot = def.connectors[0] ? def.connectors[0].cell : [0, 0, 0];
    const off = rotateCell(def, r, pivot);
    return { b: id, x: cell[0] - off[0], y: cell[1] - off[1], z: cell[2] - off[2], r, s: surfaceFor(id, s) };
}

export function surfaceFor(id, s) {
    const def = BLOCKS[id];
    if (!def) return s || 'snow';
    return def.surfaces.includes(s) ? s : def.defaultSurface;
}

/** Every cell [x, y, z] a block covers. */
export function footprintCells(blk) {
    const def = BLOCKS[blk.b];
    const [w, hgt, d] = footprintSize(def, blk.r & 3);
    const out = [];
    for (let i = 0; i < w; i++) for (let j = 0; j < hgt; j++) for (let k = 0; k < d; k++) out.push([blk.x + i, blk.y + j, blk.z + k]);
    return out;
}

export function inMap(x, y, z) {
    return x >= 0 && y >= 0 && z >= 0 && x < MAP_X && y < MAP_Y && z < MAP_Z;
}

const key = (x, y, z) => (x * 64 + y) * 64 + z;

function clone(v) {
    return JSON.parse(JSON.stringify(v));
}

function cleanBlock(b) {
    return { b: b.b, x: b.x, y: b.y, z: b.z, r: b.r & 3, s: b.s };
}

/**
 * The editable document. Every change goes through `change()`, which records
 * an undo snapshot, bumps `version` and refreshes occupancy and connectors.
 */
export class EditorDoc {
    constructor(track, opts = {}) {
        this.track = normalizeTrack(clone(track));
        this.track.blocks = this.track.blocks.map(cleanBlock);
        this.validations = opts.validations ? clone(opts.validations) : {};
        this.savedId = opts.savedId || null;            // storage id it was last saved under
        this.savedSnap = opts.savedSnap ?? null;        // snapshot string at the last save
        this.undoStack = [];
        this.redoStack = [];
        this.version = 0;
        this._refresh();
        // An untouched new track has nothing worth a "discard changes?" question.
        if (opts.pristine) this.savedSnap = this.snapshot();
    }

    static fromJSON(o) {
        return new EditorDoc(o.track, { validations: o.validations, savedId: o.savedId, savedSnap: o.savedSnap });
    }

    toJSON() {
        return { track: this.track, validations: this.validations, savedId: this.savedId, savedSnap: this.savedSnap };
    }

    get blocks() {
        return this.track.blocks;
    }

    get decor() {
        return this.track.decor;
    }

    snapshot() {
        const t = this.track;
        return JSON.stringify([t.name, t.author, t.mood, t.mode, t.laps, t.blocks, t.decor]);
    }

    get dirty() {
        return this.savedSnap !== this.snapshot();
    }

    markSaved(id) {
        this.savedId = id;
        this.savedSnap = this.snapshot();
    }

    _restore(snap) {
        const [name, author, mood, mode, laps, blocks, decor] = JSON.parse(snap);
        Object.assign(this.track, { name, author, mood, mode, laps, blocks, decor });
        this._refresh();
    }

    _refresh() {
        this.version++;
        this._hash = null;
        const occ = new Map();
        this.track.blocks.forEach((b, i) => {
            if (!BLOCKS[b.b]) return;
            for (const c of footprintCells(b)) if (!occ.has(key(...c))) occ.set(key(...c), i);
        });
        this.occupancy = occ;
        const decorOcc = new Map();
        this.track.decor.forEach((d, i) => decorOcc.set(key(d.x, d.y, d.z), i));
        this.decorOcc = decorOcc;
        this._an = null;
    }

    /** Runs fn() as one undoable step (fn returns false to cancel). */
    change(fn, label = '') {
        const before = this.snapshot();
        if (fn(this.track) === false) return false;
        const after = this.snapshot();
        if (after === before) return false;
        this.undoStack.push({ snap: before, label });
        if (this.undoStack.length > HISTORY_MAX) this.undoStack.shift();
        this.redoStack.length = 0;
        this._refresh();
        return true;
    }

    get canUndo() { return this.undoStack.length > 0; }
    get canRedo() { return this.redoStack.length > 0; }

    undo() {
        const e = this.undoStack.pop();
        if (!e) return null;
        this.redoStack.push({ snap: this.snapshot(), label: e.label });
        this._restore(e.snap);
        return e.label;
    }

    redo() {
        const e = this.redoStack.pop();
        if (!e) return null;
        this.undoStack.push({ snap: this.snapshot(), label: e.label });
        this._restore(e.snap);
        return e.label;
    }

    /** Block index covering the cell, or -1. */
    blockAt(x, y, z) {
        const i = this.occupancy.get(key(x, y, z));
        return i === undefined ? -1 : i;
    }

    decorAt(x, y, z) {
        const i = this.decorOcc.get(key(x, y, z));
        return i === undefined ? -1 : i;
    }

    /** { ok, reason: null | 'unknown' | 'outside' | 'overlap', overlaps: [block indices] } */
    fits(blk, ignore = -1) {
        if (!BLOCKS[blk.b]) return { ok: false, reason: 'unknown', overlaps: [] };
        const overlaps = new Set();
        let outside = false;
        for (const [x, y, z] of footprintCells(blk)) {
            if (!inMap(x, y, z)) {
                outside = true;
                continue;
            }
            const i = this.blockAt(x, y, z);
            if (i >= 0 && i !== ignore) overlaps.add(i);
        }
        const reason = outside ? 'outside' : overlaps.size ? 'overlap' : null;
        return { ok: !reason, reason, overlaps: [...overlaps] };
    }

    fitsDecor(d) {
        if (!inMap(d.x, d.y, d.z)) return { ok: false, reason: 'outside' };
        if (this.blockAt(d.x, d.y, d.z) >= 0) return { ok: false, reason: 'overlap' };
        if (this.decorAt(d.x, d.y, d.z) >= 0) return { ok: false, reason: 'taken' };
        return { ok: true, reason: null };
    }

    /** Places a block if it fits. A second spawn block replaces the old one (one Start per track). */
    place(blk) {
        const b = cleanBlock({ ...blk, s: surfaceFor(blk.b, blk.s) });
        if (!this.fits(b).ok) return false;
        const spawn = BLOCKS[b.b].spawn;
        return this.change((t) => {
            if (spawn) t.blocks = t.blocks.filter((o) => !(BLOCKS[o.b] && BLOCKS[o.b].spawn));
            t.blocks.push(b);
        }, `Place ${BLOCKS[b.b].name}`);
    }

    remove(index) {
        const b = this.track.blocks[index];
        if (!b) return false;
        return this.change((t) => { t.blocks.splice(index, 1); }, `Remove ${BLOCKS[b.b]?.name || b.b}`);
    }

    placeDecor(d) {
        const item = { d: d.d, x: d.x, y: d.y, z: d.z, r: d.r & 3 };
        if (!this.fitsDecor(item).ok) return false;
        return this.change((t) => { t.decor.push(item); }, `Place ${d.d}`);
    }

    removeDecor(index) {
        if (!this.track.decor[index]) return false;
        return this.change((t) => { t.decor.splice(index, 1); }, 'Remove decor');
    }

    setProps(p) {
        return this.change((t) => {
            if (typeof p.name === 'string') t.name = p.name.trim().slice(0, 48) || 'Untitled Track';
            if (typeof p.author === 'string') t.author = p.author.trim().slice(0, 32) || 'Penguin';
            if (MOODS.includes(p.mood)) t.mood = p.mood;
            if (MODES.includes(p.mode)) t.mode = p.mode;
            if (p.laps != null) t.laps = Math.max(1, Math.min(20, Math.round(Number(p.laps)) || 1));
        }, 'Track properties');
    }

    /** Layout analysis (connectors, matches), cached per version. */
    analysis() {
        if (!this._an || this._anVersion !== this.version) {
            this._an = analyzeTrack(this.track);
            this._anVersion = this.version;
        }
        return this._an;
    }

    /** Unmatched connectors: { road: [...], lips: [...] } (placedConnectors records plus `block`). */
    openConnectors() {
        const an = this.analysis();
        const road = [], lips = [];
        for (const c of an.connectors) {
            if (c.match !== -1) continue;
            if (c.kind === 'lip') lips.push(c);
            else road.push(c);
        }
        return { road, lips };
    }

    /**
     * Snapped placements of block `id` with its entry on `cell` (x, z of the
     * cursor): one per open road end whose next cell is there, preferring the
     * cursor's layer, and per sensible entry connector (a turn left or right, a
     * slope up or down). [] when nothing is open there.
     */
    snapVariants(id, cell, s) {
        const def = BLOCKS[id];
        if (!def) return [];
        const open = this.openConnectors().road.filter((c) => {
            const d = DIRS[c.dir];
            return c.cell[0] + d[0] === cell[0] && c.cell[2] + d[2] === cell[2] && Math.abs(c.cell[1] - cell[1]) <= 2;
        });
        open.sort((a, b) => Math.abs(a.cell[1] - cell[1]) - Math.abs(b.cell[1] - cell[1]));
        const entries = [];
        if (def.spawn && def.gate === 'start') entries.push([null, 0]);
        else {
            def.connectors.forEach((c, i) => {
                if (c.kind === 'lip') return;
                if (entries.length && (SYMMETRIC.has(id) || def.connectors.length > 2)) return;
                const exit = def.connectors.findIndex((o, j) => j !== i);
                entries.push([i, exit < 0 ? i : exit]);
            });
        }
        const out = [];
        for (const c of open) {
            const d = DIRS[c.dir];
            const target = [c.cell[0] + d[0], c.cell[1], c.cell[2] + d[2]];
            for (const [entry, exit] of entries) {
                const p = placeByConnector(id, entry, exit, target, c.dir, surfaceFor(id, s));
                out.push({ block: p.block, next: p.next, dir: p.dir, from: c, entry });
            }
        }
        return out;
    }

    hash() {
        if (!this._hash) this._hash = trackHash(this.track);
        return this._hash;
    }

    /** The best validation run of the current layout, or null. */
    validation() {
        return this.validations[this.hash()] || null;
    }

    get validated() {
        return !!this.validation();
    }

    /**
     * Records a finished run. It validates the layout it was driven on (its
     * replay's trackHash); returns true when it became that layout's best.
     */
    recordRun(run) {
        if (!run || !run.finished || !Number.isFinite(run.timeMs)) return false;
        const hash = run.hash || (run.replay && run.replay.trackHash) || this.hash();
        const entry = {
            hash, timeMs: run.timeMs, respawns: run.respawns || 0, by: run.by || 'driver',
            date: run.date || Date.now(), replay: run.replay || null,
        };
        const prev = this.validations[hash];
        if (prev && !betterRun(this.track.mode, entry, prev)) return false;
        this.validations[hash] = entry;
        const keys = Object.keys(this.validations);
        if (keys.length > VALIDATIONS_MAX) {
            keys.sort((a, b) => (this.validations[a].date || 0) - (this.validations[b].date || 0));
            for (const k of keys.slice(0, keys.length - VALIDATIONS_MAX)) if (k !== this.hash()) delete this.validations[k];
        }
        return true;
    }

    /** Medals of the current layout: from its validation run, or none. */
    medals() {
        const v = this.validation();
        return v ? medalsFromAuthor(v.timeMs, this.track.mode, v.respawns) : medalsFromAuthor(null);
    }

    /** Plain track JSON for saving, racing and share codes (medals only when validated). */
    toTrack() {
        const t = clone(this.track);
        t.medals = this.medals();
        return t;
    }

    /** What storage 'tracks' keeps: the track plus the validation of this layout. */
    toStored() {
        const t = this.toTrack();
        const v = this.validation();
        t.updated = Date.now();
        if (v) t.validation = { hash: v.hash, timeMs: v.timeMs, respawns: v.respawns, by: v.by, date: v.date, replay: v.replay };
        return t;
    }
}

/** A doc from a stored track (keeps its validation when it still matches the layout). */
export function docFromStored(stored, opts = {}) {
    const doc = new EditorDoc(stored, opts);
    const v = stored && stored.validation;
    if (v && v.hash && Number.isFinite(v.timeMs)) doc.validations[v.hash] = { ...v };
    return doc;
}
