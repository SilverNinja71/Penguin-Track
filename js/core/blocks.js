// Block catalog. Each block is described in its own local frame (metres,
// origin at the min corner of its unrotated footprint, local +Z = forward)
// and generates collision triangles, render buffers, triggers, props and the
// centerline paths the route is built from. buildWorld places and rotates them.
import {
    CELL, LAYER, ROAD_HALF, BORDER_WIDTH, BORDER_HEIGHT, BORDER_SLANT, DECK_THICKNESS,
    NARROW_WIDTH, ROAD_OUTER, SURFACE_INDEX, ROAD_SURFACES, EFFECTS,
} from './constants.js';
import { PI, HALF_PI, TWO_PI, DEG, dsin, dcos, smoothstep, len3 } from './mathd.js';
import { MeshBuilder, curveFrames, lineFrames, joinFrames, sweep } from './geom.js';

export const SURFACES = {
    snow: { id: 'snow', index: 0, name: 'Packed Snow', drivable: true, color: '#eef4fb' },
    powder: { id: 'powder', index: 1, name: 'Powder', drivable: true, color: '#e3e9f0' },
    ice: { id: 'ice', index: 2, name: 'Ice', drivable: true, color: '#a8dcf5' },
    ground: { id: 'ground', index: 3, name: 'Deep Snow', drivable: true, color: '#f7fbff' },
    wall: { id: 'wall', index: 4, name: 'Snowbank', drivable: false, color: '#c7d6e8' },
};

/** Render materials emitted in world.render.meshes. */
export const MATERIALS = [
    'road_snow', 'road_powder', 'road_ice', 'platform_snow', 'platform_powder', 'platform_ice',
    'border', 'wall', 'roof_ice', 'ground', 'line_start', 'line_finish', 'line_checkpoint',
    ...EFFECTS.map((e) => 'pad_' + e),
];

export const BLOCKS = {};
export const BLOCK_LIST = [];

const DT = DECK_THICKNESS;
const W = SURFACE_INDEX.wall;
const H = ROAD_HALF;
const C2 = CELL / 2;
const STEP = 1.6;           // target sample spacing along curves (m)
const STRAIGHT_STEP = 8;    // straights need few samples; keeps triangles grid-friendly

// ---------------------------------------------------------------------------
// Standard road cross-section, clockwise seen along the tangent:
//   FL ─ OLD ─ OLT ─ ILT ─ DL ─ (deck points) ─ DR ─ IRT ─ ORT ─ ORD ─ FR ─ (FL)
// The deck (u = -hw..hw, v = 0) is split in n panels (4 on most roads; twisted
// decks such as banks and loops use more so their triangles crease less).
// O*/I* are the snowbank borders, F* the bottom corners (hanging deck: -DT below
// the deck; solid: down to floorY).
const FL = 0, OLD = 1, OLT = 2, ILT = 3, DL = 4;

/** Index layout of the cross-section for n deck panels. */
function sectionLayout(n) {
    return { n, DR: DL + n, IRT: DL + n + 1, ORT: DL + n + 2, ORD: DL + n + 3, FR: DL + n + 4, K: DL + n + 5 };
}
const STD = sectionLayout(4);
const TWISTED_PANELS = 8;

function roadPanels(surf, deckMat, L) {
    const border = { surf: W, mat: 'border' };
    const wall = { surf: W, mat: 'wall' };
    const deck = { surf: SURFACE_INDEX[surf], mat: deckMat, lat: true };
    const panels = [
        { a: FL, b: OLD, ...wall },
        { a: OLD, b: OLT, ...border },
        { a: OLT, b: ILT, ...border },
        { a: ILT, b: DL, ...border },
    ];
    for (let k = DL; k < L.DR; k++) panels.push({ a: k, b: k + 1, ...deck });
    panels.push(
        { a: L.DR, b: L.IRT, ...border },
        { a: L.IRT, b: L.ORT, ...border },
        { a: L.ORT, b: L.ORD, ...border },
        { a: L.ORD, b: L.FR, ...wall },
        { a: L.FR, b: FL, ...wall },
    );
    return panels;
}

/** shape(frame, i) -> { hw, w (border scale 0..1), floorY (null = hanging deck) } */
function roadSection(shape, L) {
    return (f, i, pts) => {
        const { hw, w = 1, floorY = null } = shape(f, i);
        const bw = BORDER_WIDTH * w, bh = BORDER_HEIGHT * w, sl = BORDER_SLANT * w;
        const put = (k, u, v) => {
            const P = pts[k];
            P[0] = f.p[0] + u * f.S[0] + v * f.U[0];
            P[1] = f.p[1] + u * f.S[1] + v * f.U[1];
            P[2] = f.p[2] + u * f.S[2] + v * f.U[2];
        };
        put(OLD, -hw - bw, 0);
        put(OLT, -hw - bw, bh);
        put(ILT, -hw - sl, bh);
        for (let k = 0; k <= L.n; k++) put(DL + k, hw * (2 * k / L.n - 1), 0);
        put(L.IRT, hw + sl, bh);
        put(L.ORT, hw + bw, bh);
        put(L.ORD, hw + bw, 0);
        if (floorY === null) {
            put(FL, -hw - bw, -DT);
            put(L.FR, hw + bw, -DT);
        } else {
            const l = pts[OLD], r = pts[L.ORD];
            pts[FL][0] = l[0]; pts[FL][1] = floorY; pts[FL][2] = l[2];
            pts[L.FR][0] = r[0]; pts[L.FR][1] = floorY; pts[L.FR][2] = r[2];
        }
    };
}

const BORDER_OPTS = { surf: W, mat: 'border' };
const WALL_OPTS = { surf: W, mat: 'wall' };

function neg(v) {
    return [-v[0], -v[1], -v[2]];
}

/**
 * Caps the road profile at one end. key: connector index (caps go into
 * 'cap:<key>:border|deck' groups chosen by buildWorld) or null (always drawn).
 */
function roadCap(mb, row, f, outward, key, parts = ['border', 'deck'], L = STD) {
    const axes = [f.S, f.U];
    if (parts.includes('border')) {
        mb.use(key === null ? 'main' : `cap:${key}:border`);
        mb.poly([row[OLD], row[OLT], row[ILT], row[DL]], outward, BORDER_OPTS, axes);
        mb.poly([row[L.DR], row[L.IRT], row[L.ORT], row[L.ORD]], outward, BORDER_OPTS, axes);
    }
    if (parts.includes('deck')) {
        // A neighbour's deck slab only reaches DT below the deck, so on a solid end that
        // goes deeper (the top of a slope) the part below the slab is always exposed.
        const fl = slabBottom(row[OLD], row[FL]), fr = slabBottom(row[L.ORD], row[L.FR]);
        mb.use(key === null ? 'main' : `cap:${key}:deck`);
        mb.poly([fl, row[OLD], ...row.slice(DL, L.DR + 1), row[L.ORD], fr], outward, WALL_OPTS, axes);
        mb.use('main');
        if (fl !== row[FL]) mb.poly([row[FL], fl, fr, row[L.FR]], outward, WALL_OPTS, axes);
    }
    mb.use('main');
}

/** Bottom of a standard slab under `top`, or `floor` itself when the profile is no deeper. */
function slabBottom(top, floor) {
    if (floor[1] >= top[1] - DT - 1e-6) return floor;
    return [floor[0], top[1] - DT, floor[2]];
}

/**
 * Sweeps the road profile. o: { surf, shape, deckMat, capStart, capEnd, deckPanels = 4 }
 * cap*: connector index, null (always capped) or false (open, e.g. internal).
 * Returns { rows, path, layout } where path holds centerline points, ups and half-widths.
 */
function roadSweep(mb, frames, o) {
    const shape = o.shape || (() => ({ hw: H, w: 1, floorY: null }));
    const L = o.deckPanels ? sectionLayout(o.deckPanels) : STD;
    const rows = sweep(mb, frames, L.K, roadSection(shape, L), roadPanels(o.surf, o.deckMat || 'road_' + o.surf, L));
    const last = frames.length - 1;
    if (o.capStart !== false) roadCap(mb, rows[0], frames[0], neg(frames[0].T), o.capStart ?? null, o.capStartParts, L);
    if (o.capEnd !== false) roadCap(mb, rows[last], frames[last], frames[last].T, o.capEnd ?? null, o.capEndParts, L);
    return { rows, path: pathFromFrames(frames, (f, i) => shape(f, i).hw), layout: L };
}

function pathFromFrames(frames, hwOf) {
    return {
        pts: frames.map((f) => [f.p[0], f.p[1], f.p[2]]),
        ups: frames.map((f) => [f.U[0], f.U[1], f.U[2]]),
        hw: frames.map((f, i) => hwOf(f, i)),
    };
}

function linePath(a, b, hw, step = 4) {
    const L = len3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const n = Math.max(1, Math.ceil(L / step));
    const pts = [], ups = [], hws = [];
    for (let i = 0; i <= n; i++) {
        const t = i / n;
        pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
        ups.push([0, 1, 0]);
        hws.push(hw);
    }
    return { pts, ups, hw: hws };
}

/** Quarter arc on a flat cell from face centre a to face centre b around their shared corner. */
function cornerPath(a, b, hw) {
    const c = [a[0] + b[0] - C2, a[1], a[2] + b[2] - C2];
    const ua = [a[0] - c[0], 0, a[2] - c[2]], ub = [b[0] - c[0], 0, b[2] - c[2]];
    const n = 12;
    const pts = [], ups = [], hws = [];
    for (let i = 0; i <= n; i++) {
        const th = HALF_PI * i / n;
        const ca = dcos(th), sb = dsin(th);
        pts.push([c[0] + ua[0] * ca + ub[0] * sb, a[1], c[2] + ua[2] * ca + ub[2] * sb]);
        ups.push([0, 1, 0]);
        hws.push(hw);
    }
    return { pts, ups, hw: hws };
}

/** Render-only decal just above the deck (lines, pads). */
function decal(mb, x0, z0, x1, z1, y, mat) {
    const up = [0, 1, 0];
    mb.quad([x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1], up, [up, up, up, up],
        [[0, 0], [1, 0], [1, 1], [0, 1]], { mat, collide: false });
}

function solid() {
    return () => ({ hw: H, w: 1, floorY: -DT });
}

function sampleCount(length) {
    return Math.max(2, Math.ceil(length / STEP));
}

// ---------------------------------------------------------------------------
// Definitions

function conn(cell, dir, extra = {}) {
    return { cell, dir, kind: 'road', profile: 'road', ...extra };
}

function define(d) {
    const def = {
        surfaces: ROAD_SURFACES,
        defaultSurface: 'snow',
        gate: null,
        effect: null,
        spawn: null,
        hanging: false,
        ...d,
    };
    BLOCKS[def.id] = def;
    BLOCK_LIST.push(def);
    return def;
}

/** Plain straight road, connector 0 at the back (local z = 0), 1 at the front. */
function straightBase(mb, surf, len = CELL) {
    const frames = lineFrames([C2, 0, 0], [C2, 0, len], STRAIGHT_STEP);
    const { path } = roadSweep(mb, frames, { surf, capStart: 0, capEnd: 1 });
    return { a: 0, b: 1, ...path, events: [] };
}

function straightConnectors(len = 1) {
    return [conn([0, 0, 0], 2), conn([0, 0, len - 1], 0)];
}

// Gates -----------------------------------------------------------------------

// y1 stays below a car on the next layer up (its centre rides at 8 + 0.65 m), so a road
// stacked over a gate never takes it.
const GATE_TRIGGER = { y0: -1, y1: 7, depth: 4 };

function gateTrigger(type, z) {
    return {
        type,
        min: [C2 - ROAD_OUTER, GATE_TRIGGER.y0, z - GATE_TRIGGER.depth / 2],
        max: [C2 + ROAD_OUTER, GATE_TRIGGER.y1, z + GATE_TRIGGER.depth / 2],
    };
}

function gateProp(gate, z) {
    return { kind: 'gate', gate, pos: [C2, 0, z], dir: 0, width: 2 * ROAD_OUTER, height: 9 };
}

define({
    id: 'Start',
    name: 'Start Igloo',
    category: 'gate',
    description: 'Where every run begins. The penguin waits under the arch for GO.',
    size: [1, 1, 1],
    connectors: [conn([0, 0, 0], 0)],
    gate: 'start',
    spawn: { pos: [C2, 0, 12], dir: 0 },
    build(surf) {
        const mb = new MeshBuilder();
        const frames = lineFrames([C2, 0, 0], [C2, 0, CELL], STRAIGHT_STEP);
        roadSweep(mb, frames, { surf, capStart: null, capEnd: 0 });
        // Packed-snow wall closing the back of the start area.
        mb.box([C2 - ROAD_OUTER, 0, 0], [C2 + ROAD_OUTER, 2.4, 2], BORDER_OPTS, ['ny']);
        decal(mb, C2 - H, 11.5, C2 + H, 12.5, 0.03, 'line_start');
        const spawnPath = { a: -1, b: 0, ...linePath([C2, 0, 12], [C2, 0, CELL], H), events: [], spawnAt: 0 };
        return {
            mb, paths: [spawnPath],
            triggers: [gateTrigger('start', 12)],
            props: [gateProp('start', 12)],
        };
    },
});

function gateBlock(id, name, gate, description) {
    define({
        id, name, category: 'gate', description,
        size: [1, 1, 1],
        connectors: straightConnectors(),
        gate,
        build(surf) {
            const mb = new MeshBuilder();
            const path = straightBase(mb, surf);
            decal(mb, C2 - H, 15, C2 + H, 17, 0.03, gate === 'finish' ? 'line_finish' : 'line_checkpoint');
            path.events.push({ trigger: 0, at: 16 });
            return { mb, paths: [path], triggers: [gateTrigger(gate, 16)], props: [gateProp(gate, 16)] };
        },
    });
}

gateBlock('Finish', 'Finish Arch', 'finish', 'Cross it to stop the clock. Works in both directions.');
gateBlock('Checkpoint', 'Snowflake Checkpoint', 'checkpoint', 'Every checkpoint must be crossed (any order, any direction) before the finish.');

define({
    id: 'StartFinish',
    name: 'Lap Igloo',
    category: 'gate',
    description: 'Start and lap line for multilap tracks. The car spawns just past the line.',
    size: [1, 1, 1],
    connectors: straightConnectors(),
    gate: 'startfinish',
    spawn: { pos: [C2, 0, 14], dir: 0 },
    build(surf) {
        const mb = new MeshBuilder();
        const path = straightBase(mb, surf);
        decal(mb, C2 - H, 7, C2 + H, 9, 0.03, 'line_finish');
        path.events.push({ trigger: 0, at: 8 });
        // The lap route starts on the line, so one lap is exactly route.length.
        const spawnPath = { a: -1, b: 1, ...linePath([C2, 0, 8], [C2, 0, CELL], H), events: [], spawnAt: 6 };
        return {
            mb, paths: [path, spawnPath],
            triggers: [gateTrigger('startfinish', 8)],
            props: [gateProp('startfinish', 8)],
        };
    },
});

// Roads -------------------------------------------------------------------------

define({
    id: 'Straight',
    name: 'Packed Trail',
    category: 'road',
    description: 'A straight run of packed snow between snowbanks.',
    size: [1, 1, 1],
    connectors: straightConnectors(),
    build(surf) {
        const mb = new MeshBuilder();
        return { mb, paths: [straightBase(mb, surf)] };
    },
});

define({
    id: 'Cross',
    name: 'Snow Crossing',
    category: 'road',
    description: 'Four-way intersection with open corners for cutting across.',
    size: [1, 1, 1],
    connectors: [conn([0, 0, 0], 0), conn([0, 0, 0], 1), conn([0, 0, 0], 2), conn([0, 0, 0], 3)],
    build(surf) {
        const mb = new MeshBuilder();
        const faces = faceCentres();
        // A 2 m stub of full road profile at each face so neighbours meet a normal cross-section.
        for (let d = 0; d < 4; d++) {
            const a = faces[d];
            const inward = [-FACE_DIRS[d][0], 0, -FACE_DIRS[d][2]];
            const b = [a[0] + inward[0] * 2, 0, a[2] + inward[2] * 2];
            roadSweep(mb, lineFrames(a, b, 2), { surf, capStart: d, capEnd: null, capEndParts: ['border'] });
        }
        flatSlab(mb, 2, 2, CELL - 2, CELL - 2, SURFACE_INDEX[surf], 'road_' + surf, 4);
        // Turning paths pass the stub snowbanks' inner ends sqrt(4² + 2²) m from the corner,
        // i.e. 11.53 m from the arc: report a little less as the drivable half-width.
        return { mb, paths: crossPaths(faces, H, CROSS_CORNER_HW) };
    },
});

define({
    id: 'Narrow',
    name: 'Narrow Ridge',
    category: 'road',
    description: 'A 10 m wide bridge without snowbanks. Tapers in and out so it joins normal road.',
    size: [1, 1, 2],
    connectors: straightConnectors(2),
    build(surf) {
        const mb = new MeshBuilder();
        const L = 2 * CELL, taper = 12;
        const frames = joinFrames(
            lineFrames([C2, 0, 0], [C2, 0, taper], 1.5),
            lineFrames([C2, 0, taper], [C2, 0, L - taper], STRAIGHT_STEP),
            lineFrames([C2, 0, L - taper], [C2, 0, L], 1.5),
        );
        const narrowHalf = NARROW_WIDTH / 2;
        const shape = (f) => {
            const z = f.p[2];
            const w = z < taper ? 1 - smoothstep(z / taper) : z > L - taper ? smoothstep((z - (L - taper)) / taper) : 0;
            return { hw: narrowHalf + (H - narrowHalf) * w, w, floorY: null };
        };
        const { path } = roadSweep(mb, frames, { surf, shape, capStart: 0, capEnd: 1 });
        return { mb, paths: [{ a: 0, b: 1, ...path, events: [] }] };
    },
});

// Tunnel roof: a shell of two half-ellipses resting on the snowbank tops.
const ROOF_M = 12;
// Outer peak stays below 6.5 m so a block stacked on the next layer never intersects it.
const ROOF = { ai: 12.9, bi: 4.6, ao: 13.7, bo: 5.2 };

function roofSection(f, i, pts) {
    const v0 = BORDER_HEIGHT;
    const put = (k, u, v) => {
        const P = pts[k];
        P[0] = f.p[0] + u * f.S[0] + v * f.U[0];
        P[1] = f.p[1] + u * f.S[1] + v * f.U[1];
        P[2] = f.p[2] + u * f.S[2] + v * f.U[2];
    };
    for (let j = 0; j <= ROOF_M; j++) {
        const phiO = PI - PI * j / ROOF_M;   // outer arc left -> right
        put(j, ROOF.ao * dcos(phiO), v0 + ROOF.bo * dsin(phiO));
        const phiI = PI * j / ROOF_M;        // inner arc right -> left
        put(ROOF_M + 1 + j, ROOF.ai * dcos(phiI), v0 + ROOF.bi * dsin(phiI));
    }
}

function roofPanels() {
    const o = { surf: SURFACE_INDEX.ice, mat: 'roof_ice' };
    const panels = [];
    const K = 2 * (ROOF_M + 1);
    for (let k = 0; k < K; k++) panels.push({ a: k, b: (k + 1) % K, ...o });
    return panels;
}

define({
    id: 'Tunnel',
    name: 'Ice Tunnel',
    category: 'road',
    description: 'Straight road under a solid ice roof. Joins seamlessly with more tunnel.',
    size: [1, 1, 1],
    connectors: [conn([0, 0, 0], 2, { profile: 'tunnel' }), conn([0, 0, 0], 0, { profile: 'tunnel' })],
    build(surf) {
        const mb = new MeshBuilder();
        const path = straightBase(mb, surf);
        const frames = lineFrames([C2, 0, 0], [C2, 0, CELL], STRAIGHT_STEP);
        const rows = sweep(mb, frames, 2 * (ROOF_M + 1), roofSection, roofPanels());
        // Ring caps where the roof ends (unless the neighbour continues the tunnel).
        const ring = (row, f, outward, key) => {
            mb.use(`cap:${key}:roof`);
            for (let j = 0; j < ROOF_M; j++) {
                const i0 = ROOF_M + 1 + (ROOF_M - j), i1 = ROOF_M + 1 + (ROOF_M - j - 1);
                mb.poly([row[j], row[j + 1], row[i1], row[i0]], outward, { surf: SURFACE_INDEX.ice, mat: 'roof_ice' }, [f.S, f.U]);
            }
            mb.use('main');
        };
        ring(rows[0], frames[0], neg(frames[0].T), 0);
        ring(rows[rows.length - 1], frames[frames.length - 1], frames[frames.length - 1].T, 1);
        return { mb, paths: [path] };
    },
});

// Turns -------------------------------------------------------------------------

/**
 * Quarter turn of n×n cells. Entering at the back of cell [0,0,0] heading +Z it
 * turns left and leaves through the +X face of cell [n-1,0,n-1]; driven the
 * other way it is a right turn. Centerline radius 32n - 16.
 */
function turnFrames(n, bankMax) {
    const R = CELL * n - C2;
    const cx = CELL * n;
    const arc = R * HALF_PI;
    const opts = {};
    // Banks roll fastest near their ends: sample those more finely (the warp halves
    // the spacing there and widens it mid-turn, where the roll barely changes), so
    // the first chord's kink against the flat neighbour stays small.
    let warp = (t) => t;
    let count = sampleCount(arc);
    if (bankMax) {
        opts.bank = (t) => bankMax * bankProfile(warp(t));
        opts.pivot = -H;   // inner deck edge stays at road level, the outside rises
        warp = (t) => t - (BANK_WARP * dsin(TWO_PI * t)) / TWO_PI;
        count = Math.ceil(count * 1.25);
    }
    return curveFrames(count, (t, p, dp) => {
        const th = warp(t) * HALF_PI;
        const s = dsin(th), c = dcos(th);
        p[0] = cx - R * c; p[1] = 0; p[2] = R * s;
        dp[0] = R * s * HALF_PI; dp[1] = 0; dp[2] = R * c * HALF_PI;
    }, opts);
}

const BANK_WARP = 0.6;

/**
 * Bank roll 0 -> 1 -> 0 over the turn. The outer half of the deck rises with the
 * roll and comes back down, so its height crests mid-turn; a plain cosine bump
 * crests hard enough to unload a car on the centerline at 250 km/h. The extra
 * harmonics move curvature from the middle (crest, -39 %) to the ends (where the
 * deck compresses, which only loads the car more).
 */
function bankProfile(t) {
    const a = TWO_PI * t;
    return (0.98 * (1 - dcos(a)) + 0.14 * (1 - dcos(2 * a)) + 0.02 * (1 - dcos(3 * a))) / 2;
}

function turnBlock(id, name, n, bank, description) {
    const BANK = 40 * DEG;
    define({
        id, name, category: 'turn', description,
        size: [n, bank ? 3 : 1, n],
        connectors: [conn([0, 0, 0], 2), conn([n - 1, 0, n - 1], 3)],
        build(surf) {
            const mb = new MeshBuilder();
            const frames = turnFrames(n, bank ? BANK : 0);
            const shape = bank ? solid() : undefined;
            const { path } = roadSweep(mb, frames, { surf, shape, capStart: 0, capEnd: 1, deckPanels: bank ? TWISTED_PANELS : 4 });
            return { mb, paths: [{ a: 0, b: 1, ...path, events: [] }] };
        },
    });
}

turnBlock('Turn1', 'Igloo Hairpin', 1, false, 'Tight 90° curve inside one cell (radius 16 m). Left or right depending on how you enter.');
turnBlock('Turn2', 'Drift Bend', 2, false, '90° curve over 2×2 cells (radius 48 m).');
turnBlock('Turn3', 'Glacier Sweep', 3, false, 'Fast 90° curve over 3×3 cells (radius 80 m).');
turnBlock('Bank2', 'Banked Drift', 2, true, '90° curve over 2×2 cells that banks up to 40° mid-turn. Flat at both ends.');
turnBlock('Bank3', 'Banked Glacier', 3, true, 'Wide 90° curve over 3×3 cells banking up to 40°. Flat at both ends.');

// Slopes ------------------------------------------------------------------------

/** Cosine S-profile: flat tangents at both ends, steepest in the middle. */
function slopeFrames(len, rise) {
    const arc = Math.sqrt(len * len + rise * rise) * 1.05;
    return curveFrames(sampleCount(arc), (t, p, dp) => {
        p[0] = C2; p[1] = rise * (1 - dcos(PI * t)) / 2; p[2] = len * t;
        dp[0] = 0; dp[1] = rise * PI * dsin(PI * t) / 2; dp[2] = len;
    });
}

function slopeBlock(id, name, cells, layers, description, platform = false) {
    const len = cells * CELL, rise = layers * LAYER;
    const profile = platform ? 'platform' : 'road';
    define({
        id, name, category: platform ? 'platform' : 'slope', description,
        size: [1, layers + 1, cells],
        connectors: [conn([0, 0, 0], 2, { profile }), conn([0, layers, cells - 1], 0, { profile })],
        build(surf) {
            const mb = new MeshBuilder();
            const frames = slopeFrames(len, rise);
            if (platform) {
                const shape = () => ({ hw: C2, w: 0, floorY: -DT });
                const { rows, path } = roadSweep(mb, frames, {
                    surf, shape, deckMat: 'platform_' + surf, capStart: false, capEnd: false,
                });
                platformSweepCap(mb, rows[0], frames[0], neg(frames[0].T), 0);
                platformSweepCap(mb, rows[rows.length - 1], frames[frames.length - 1], frames[frames.length - 1].T, 1);
                return { mb, paths: [{ a: 0, b: 1, ...path, events: [] }] };
            }
            const { path } = roadSweep(mb, frames, { surf, shape: solid(), capStart: 0, capEnd: 1 });
            return { mb, paths: [{ a: 0, b: 1, ...path, events: [] }] };
        },
    });
}

slopeBlock('SlopeUp1', 'Steep Snowslope', 1, 1, 'Climbs one layer (8 m) in one cell. Drive it backwards to go down.');
slopeBlock('SlopeUp2', 'Gentle Snowslope', 2, 1, 'Climbs one layer over two cells.');
slopeBlock('SlopeBig', 'Mountain Slope', 2, 2, 'Climbs two layers (16 m) over two cells.');

// Stunts ------------------------------------------------------------------------

function rampBlock(id, name, angleDeg, description) {
    const alpha = angleDeg * DEG;
    const Rr = CELL / dsin(alpha);
    const rise = Rr * (1 - dcos(alpha));
    const layers = Math.ceil((rise + BORDER_HEIGHT) / LAYER);
    define({
        id, name, category: 'stunt', description,
        size: [1, layers, 1],
        // The lip is an exit into the air: the route bridges it with a gap edge.
        connectors: [conn([0, 0, 0], 2), conn([0, 0, 0], 0, {
            kind: 'lip', profile: null, pos: [C2, rise, CELL], tangent: [0, dsin(alpha), dcos(alpha)],
        })],
        build(surf) {
            const mb = new MeshBuilder();
            const frames = curveFrames(sampleCount(Rr * alpha), (t, p, dp) => {
                const a = t * alpha;
                const s = dsin(a), c = dcos(a);
                p[0] = C2; p[1] = Rr * (1 - c); p[2] = Rr * s;
                dp[0] = 0; dp[1] = Rr * s * alpha; dp[2] = Rr * c * alpha;
            });
            const { path } = roadSweep(mb, frames, { surf, shape: solid(), capStart: 0, capEnd: null });
            return { mb, paths: [{ a: 0, b: 1, ...path, events: [] }] };
        },
    });
}

rampBlock('RampSmall', 'Snow Kicker', 15, 'Kicker ending in a 15° lip. No exit: you fly off the front.');
rampBlock('RampBig', 'Ski Jump', 28, 'Big kicker with a 28° lip, 8 m tall. Leave room to land.');

/**
 * Full vertical loop of radius 14 that comes down one cell to the side (a helix).
 * Entry and exit are flat road at the block's base, both heading +Z. The helix
 * tilts the deck sideways near the top; R = 14 keeps it inside 4 layers.
 */
function loopBlock(id, name, toRight, description) {
    const R = 14, zc = CELL;
    const xIn = toRight ? CELL + C2 : C2;
    const xOut = toRight ? C2 : CELL + C2;
    const dx = xOut - xIn;
    define({
        id, name, category: 'stunt', description,
        size: [2, 4, 2],
        hanging: true,   // the deck is a thin shell, not solid down to the base
        connectors: toRight
            ? [conn([1, 0, 0], 2), conn([0, 0, 1], 0)]
            : [conn([0, 0, 0], 2), conn([1, 0, 1], 0)],
        build(surf) {
            const mb = new MeshBuilder();
            // Side shift over t in [T0, 1 - T0], kept off the lowest part of the loop so the
            // tilt below never pushes the deck under the block. The deck roll follows the
            // shift's second derivative and its twist rate the third, so the profile is the
            // septic smoothstep (zero slope, curvature and jerk at both ends): the twist
            // fades in instead of starting at full rate.
            const T0 = 0.08, span = 1 - 2 * T0;
            const shift = (t) => {
                const u = (t - T0) / span;
                if (u <= 0 || u >= 1) return [u <= 0 ? 0 : 1, 0, 0];
                const u2 = u * u, v = 1 - u;
                return [
                    u2 * u2 * (35 - 84 * u + 70 * u2 - 20 * u2 * u),
                    (140 * u2 * u * v * v * v) / span,
                    (420 * u2 * v * v * (1 - 2 * u)) / (span * span),
                ];
            };
            const loop = curveFrames(80, (t, p, dp) => {
                const th = TWO_PI * t;
                const s = dsin(th), c = dcos(th);
                const [sig, dsig] = shift(t);
                p[0] = xIn + dx * sig; p[1] = R * (1 - c); p[2] = zc + R * s;
                dp[0] = dx * dsig; dp[1] = R * s * TWO_PI; dp[2] = R * c * TWO_PI;
            }, {
                // Deck normal = the centerline's principal normal (its acceleration minus the
                // tangential part). That makes the centerline a geodesic of the deck: a car
                // holding the wheel straight follows the sideways shift without steering.
                up: (t, T) => {
                    const th = TWO_PI * t, k = R * TWO_PI * TWO_PI;
                    const a = [dx * shift(t)[2], k * dcos(th), -k * dsin(th)];
                    const at = a[0] * T[0] + a[1] * T[1] + a[2] * T[2];
                    const u = [a[0] - T[0] * at, a[1] - T[1] * at, a[2] - T[2] * at];
                    const l = len3(u[0], u[1], u[2]);
                    return [u[0] / l, u[1] / l, u[2] / l];
                },
            });
            const frames = joinFrames(
                lineFrames([xIn, 0, 0], [xIn, 0, zc], STRAIGHT_STEP),
                loop,
                lineFrames([xOut, 0, zc], [xOut, 0, 2 * CELL], STRAIGHT_STEP),
            );
            const { path } = roadSweep(mb, frames, { surf, capStart: 0, capEnd: 1, deckPanels: TWISTED_PANELS });
            return { mb, paths: [{ a: 0, b: 1, ...path, events: [] }] };
        },
    });
}

loopBlock('Loop', 'Blizzard Loop', true, 'Full loop (radius 14 m) that lands one cell to the right. Same in both directions.');
loopBlock('LoopL', 'Blizzard Loop (left)', false, 'Mirror of the Blizzard Loop: lands one cell to the left.');

define({
    id: 'Bump',
    name: 'Mogul',
    category: 'stunt',
    description: 'A 1.5 m snow hump. Hit it fast to get airborne.',
    size: [1, 1, 1],
    connectors: straightConnectors(),
    build(surf) {
        const mb = new MeshBuilder();
        const h = 1.5;
        const frames = curveFrames(24, (t, p, dp) => {
            p[0] = C2; p[1] = h * (1 - dcos(TWO_PI * t)) / 2; p[2] = CELL * t;
            dp[0] = 0; dp[1] = h * PI * dsin(TWO_PI * t); dp[2] = CELL;
        });
        const { path } = roadSweep(mb, frames, { surf, shape: solid(), capStart: 0, capEnd: 1 });
        return { mb, paths: [{ a: 0, b: 1, ...path, events: [] }] };
    },
});

// Platforms ----------------------------------------------------------------------

const FACE_DIRS = [[0, 0, 1], [-1, 0, 0], [0, 0, -1], [1, 0, 0]];
const CROSS_CORNER_HW = 11.4;

/** Face centres of a 1×1 cell at deck level, indexed by outward direction. */
function faceCentres() {
    return [[C2, 0, CELL], [0, 0, C2], [C2, 0, 0], [CELL, 0, C2]];
}

function crossPaths(faces, hw, cornerHw = hw) {
    const paths = [];
    for (let a = 0; a < 4; a++) {
        for (let b = a + 1; b < 4; b++) {
            const p = (b - a) === 2 ? linePath(faces[a], faces[b], hw) : cornerPath(faces[a], faces[b], cornerHw);
            paths.push({ a, b, ...p, events: [] });
        }
    }
    return paths;
}

/** Flat deck rectangle with underside, split in a grid of quads (no side walls). */
function flatSlab(mb, x0, z0, x1, z1, surf, mat, splits) {
    const up = [0, 1, 0], down = [0, -1, 0];
    const top = { surf, mat };
    for (let i = 0; i < splits; i++) {
        for (let j = 0; j < splits; j++) {
            const ax = x0 + (x1 - x0) * i / splits, bx = x0 + (x1 - x0) * (i + 1) / splits;
            const az = z0 + (z1 - z0) * j / splits, bz = z0 + (z1 - z0) * (j + 1) / splits;
            const uv = [[ax - C2, az], [bx - C2, az], [bx - C2, bz], [ax - C2, bz]];
            mb.quad([ax, 0, az], [bx, 0, az], [bx, 0, bz], [ax, 0, bz], up, [up, up, up, up], uv, top);
            mb.quad([ax, -DT, az], [bx, -DT, az], [bx, -DT, bz], [ax, -DT, bz], down, [down, down, down, down], uv, WALL_OPTS);
        }
    }
}

/** Vertical deck-side wall between two points at deck level, from 0 down to -DT. */
function sideWall(mb, a, b, outward) {
    const n = outward;
    mb.quad([a[0], 0, a[2]], [b[0], 0, b[2]], [b[0], -DT, b[2]], [a[0], -DT, a[2]], n, [n, n, n, n],
        [[0, 0], [1, 0], [1, 1], [0, 1]], WALL_OPTS);
}

/**
 * Platform side on face d split in three: the middle 28 m is hidden by an
 * attached road's deck slab, so it only appears when the face is free.
 */
function platformSide(mb, d) {
    const n = FACE_DIRS[d];
    const edge = [
        [[CELL, 0, CELL], [0, 0, CELL]],
        [[0, 0, CELL], [0, 0, 0]],
        [[0, 0, 0], [CELL, 0, 0]],
        [[CELL, 0, 0], [CELL, 0, CELL]],
    ][d];
    const [a, b] = edge;
    const at = (t) => [a[0] + (b[0] - a[0]) * t, 0, a[2] + (b[2] - a[2]) * t];
    const k0 = (C2 - ROAD_OUTER) / CELL, k1 = (C2 + ROAD_OUTER) / CELL;
    sideWall(mb, at(0), at(k0), n);
    sideWall(mb, at(k1), at(1), n);
    mb.use(`cap:${d}:side`);
    sideWall(mb, at(k0), at(k1), n);
    mb.use('main');
}

/** End cap of a borderless (platform-profile) sweep, split like platformSide. */
function platformSweepCap(mb, row, f, outward, key) {
    const axes = [f.S, f.U];
    const lerpP = (p, q, t) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t];
    const k = (C2 - ROAD_OUTER) / CELL;
    // Top edge DL..DR spans the full 32 m, the bottom FL..FR lies right under it.
    const tl = row[DL], tr = row[STD.DR], bl = row[FL], br = row[STD.FR];
    const t0 = lerpP(tl, tr, k), t1 = lerpP(tl, tr, 1 - k);
    const b0 = lerpP(bl, br, k), b1 = lerpP(bl, br, 1 - k);
    mb.poly([bl, tl, t0, b0], outward, WALL_OPTS, axes);
    mb.poly([b1, t1, tr, br], outward, WALL_OPTS, axes);
    // Only the slab-deep strip can be hidden by a neighbour (see roadCap).
    const s0 = slabBottom(t0, b0), s1 = slabBottom(t1, b1);
    mb.use(`cap:${key}:side`);
    mb.poly([s0, t0, t1, s1], outward, WALL_OPTS, axes);
    mb.use('main');
    if (s0 !== b0) mb.poly([b0, s0, s1, b1], outward, WALL_OPTS, axes);
}

define({
    id: 'Platform',
    name: 'Snowfield',
    category: 'platform',
    description: 'Open 32×32 m flat square without snowbanks. Any surface.',
    size: [1, 1, 1],
    connectors: [0, 1, 2, 3].map((d) => conn([0, 0, 0], d, { profile: 'platform' })),
    build(surf) {
        const mb = new MeshBuilder();
        flatSlab(mb, 0, 0, CELL, CELL, SURFACE_INDEX[surf], 'platform_' + surf, 4);
        for (let d = 0; d < 4; d++) platformSide(mb, d);
        return { mb, paths: crossPaths(faceCentres(), C2) };
    },
});

slopeBlock('PlatformRamp', 'Snowfield Ramp', 1, 1, 'Borderless 32 m wide slope climbing one layer.', true);

// Specials ----------------------------------------------------------------------

function specialBlock(id, name, effect, description) {
    define({
        id, name, category: 'special', description,
        size: [1, 1, 1],
        connectors: straightConnectors(),
        effect,
        build(surf) {
            const mb = new MeshBuilder();
            const path = straightBase(mb, surf);
            decal(mb, C2 - H, 6, C2 + H, 26, 0.03, 'pad_' + effect);
            return {
                mb, paths: [path],
                triggers: [{ type: 'effect', effect, min: [C2 - H, -1, 6], max: [C2 + H, 4, 26] }],
                props: [{ kind: 'pad', effect, pos: [C2, 0, 16], dir: 0, size: [2 * H, 20] }],
            };
        },
    });
}

specialBlock('Turbo', 'Frost Boost', 'turbo', 'Pad that kicks the penguin forward with a burst of speed.');
specialBlock('Turbo2', 'Avalanche Boost', 'turbo2', 'Stronger, longer boost. Hold on to your scarf.');
specialBlock('NoEngine', 'Frozen Engine', 'noEngine', 'The engine freezes: no throttle until a Thaw or a respawn.');
specialBlock('NoSteer', 'Frozen Wheel', 'noSteer', 'Steering locks straight until a Thaw.');
specialBlock('NoBrake', 'Brake Freeze', 'noBrake', 'Brakes stop working until a Thaw.');
specialBlock('SlowMo', 'Snow Globe', 'slowmo', 'Time crawls until a Thaw (each globe slows it more); the clock does not.');
specialBlock('Cruise', 'Glide', 'cruise', 'Locks your current speed until a Thaw: no throttle or brake, steering still works.');
specialBlock('Fragile', 'Thin Ice', 'fragile', 'Until a Thaw, a hard landing or wall hit cracks the car and stops the engine: respawn to repair it.');
specialBlock('Reset', 'Thaw', 'reset', 'Clears every active effect.');

// ---------------------------------------------------------------------------
// Placement helpers shared by track.js, the editor and tests.

/** World footprint size [w, h, d] in cells for rotation r. */
export function footprintSize(def, r) {
    const [sx, sy, sz] = def.size;
    return r & 1 ? [sz, sy, sx] : [sx, sy, sz];
}

/** Offset (cells) of local cell [i, j, k] from the anchor (min corner) under rotation r. */
export function rotateCell(def, r, cell) {
    const [sx, , sz] = def.size;
    const [i, j, k] = cell;
    switch (r & 3) {
        case 0: return [i, j, k];
        case 1: return [sz - 1 - k, j, i];
        case 2: return [sx - 1 - i, j, sz - 1 - k];
        default: return [k, j, sx - 1 - i];
    }
}

/** Local metres -> world metres for a block anchored at cell (x, y, z) with rotation r. */
export function makeTransform(def, x, y, z, r) {
    const SX = def.size[0] * CELL, SZ = def.size[2] * CELL;
    const ox = x * CELL, oy = y * LAYER, oz = z * CELL;
    r &= 3;
    return {
        r,
        point(p, out = [0, 0, 0]) {
            const lx = p[0], ly = p[1], lz = p[2];
            let wx, wz;
            if (r === 0) { wx = lx; wz = lz; }
            else if (r === 1) { wx = SZ - lz; wz = lx; }
            else if (r === 2) { wx = SX - lx; wz = SZ - lz; }
            else { wx = lz; wz = SX - lx; }
            out[0] = ox + wx; out[1] = oy + ly; out[2] = oz + wz;
            return out;
        },
        vector(v, out = [0, 0, 0]) {
            const lx = v[0], ly = v[1], lz = v[2];
            if (r === 0) { out[0] = lx; out[2] = lz; }
            else if (r === 1) { out[0] = -lz; out[2] = lx; }
            else if (r === 2) { out[0] = -lx; out[2] = -lz; }
            else { out[0] = lz; out[2] = -lx; }
            out[1] = ly;
            return out;
        },
        dir(d) {
            return (d + r) & 3;
        },
    };
}

const geometryCache = new Map();

/**
 * Block-local geometry for a surface, generated once and cached:
 * { groups: Map(key -> { col: Float64Array, surf: Uint8Array, meshes }),
 *   paths, triggers, props }
 */
export function getBlockGeometry(id, surface) {
    const key = id + '|' + surface;
    let g = geometryCache.get(key);
    if (!g) {
        const def = BLOCKS[id];
        if (!def) throw new Error(`Unknown block '${id}'`);
        const built = def.build(surface);
        g = {
            groups: built.mb.finish(),
            paths: (built.paths || []).map(freezePath),
            triggers: built.triggers || [],
            props: built.props || [],
        };
        geometryCache.set(key, g);
    }
    return g;
}

/** Drops cached block geometry (tests use it to prove generation is deterministic). */
export function clearGeometryCache() {
    geometryCache.clear();
}

function freezePath(p) {
    const n = p.pts.length;
    const pts = new Float64Array(n * 3), ups = new Float64Array(n * 3), hw = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        pts[i * 3] = p.pts[i][0]; pts[i * 3 + 1] = p.pts[i][1]; pts[i * 3 + 2] = p.pts[i][2];
        ups[i * 3] = p.ups[i][0]; ups[i * 3 + 1] = p.ups[i][1]; ups[i * 3 + 2] = p.ups[i][2];
        hw[i] = p.hw[i];
    }
    return { a: p.a, b: p.b, pts, ups, hw, events: p.events || [], spawnAt: p.spawnAt || 0 };
}

/** Allowed surfaces for a block id (first one is the default). */
export function blockSurfaces(id) {
    const def = BLOCKS[id];
    return def ? def.surfaces : [];
}
