// Geometry core: deterministic math, block catalog, connector continuity,
// collision queries, route, codec, world building speed and determinism.
import assert from 'node:assert/strict';
import { test, approx, info } from './_harness.mjs';
import * as M from '../../js/core/mathd.js';
import { Rng, hashSeed } from '../../js/core/rng.js';
import {
    BLOCKS, BLOCK_LIST, SURFACES, getBlockGeometry, makeTransform, rotateCell, footprintSize, clearGeometryCache,
} from '../../js/core/blocks.js';
import { buildWorld, validateTrack, trackFromPath, normalizeTrack, placeByConnector, PIECE_NAMES } from '../../js/core/track.js';
import { CollisionMesh, segmentAABB } from '../../js/core/collision.js';
import { encodeTrack, decodeTrack, trackHash } from '../../js/core/codec.js';
import { getSamples } from '../../js/core/samples.js';
import {
    CELL, LAYER, DIRS, SURFACE_INDEX, ROAD_HALF, MAP_Y, DECK_THICKNESS, ROAD_SURFACES, GROUND_Y,
} from '../../js/core/constants.js';

const DECK = new Set(ROAD_SURFACES.map((s) => SURFACE_INDEX[s]));

// ---------------------------------------------------------------------------
// Deterministic math

test('dsin/dcos/dtan match Math.* within 1e-12', () => {
    const rng = new Rng(7);
    const xs = [0, -0, 1e-300, 1e-8, 0.5, Math.PI / 4, Math.PI / 2, Math.PI, 2 * Math.PI, 3, -3, 100, -100, 1000.5, -12345.678, 1e5];
    for (let i = 0; i < 20000; i++) xs.push(rng.range(-50, 50));
    for (let i = 0; i < 2000; i++) xs.push(rng.range(-1e5, 1e5));
    let es = 0, ec = 0, et = 0;
    const sc = [0, 0];
    for (const x of xs) {
        es = Math.max(es, Math.abs(M.dsin(x) - Math.sin(x)));
        ec = Math.max(ec, Math.abs(M.dcos(x) - Math.cos(x)));
        M.dsincos(x, sc);
        assert.equal(sc[0], M.dsin(x));
        assert.equal(sc[1], M.dcos(x));
        if (Math.abs(Math.cos(x)) > 1e-2) et = Math.max(et, Math.abs(M.dtan(x) - Math.tan(x)) / Math.max(1, Math.abs(Math.tan(x))));
    }
    info(`max err sin ${es.toExponential(2)} cos ${ec.toExponential(2)} tan(rel) ${et.toExponential(2)}`);
    assert.ok(es < 1e-12 && ec < 1e-12 && et < 1e-12);
});

test('datan2/datan/dasin/dacos match Math.* within 1e-12', () => {
    let e = 0;
    const vals = [0, 1e-12, 1e-3, 0.1, 0.19891236737965800691, 0.5, 0.66817863791929891999, 1, 1.5, 7, 1e6];
    for (const a of vals) for (const b of vals) for (const sy of [1, -1]) for (const sx of [1, -1]) {
        const y = a * sy, x = b * sx;
        e = Math.max(e, Math.abs(M.datan2(y, x) - Math.atan2(y, x)));
    }
    const rng = new Rng(3);
    for (let i = 0; i < 20000; i++) {
        const y = rng.range(-100, 100), x = rng.range(-100, 100);
        e = Math.max(e, Math.abs(M.datan2(y, x) - Math.atan2(y, x)));
        const t = rng.range(-20, 20);
        e = Math.max(e, Math.abs(M.datan(t) - Math.atan(t)));
        const u = rng.range(-1, 1);
        e = Math.max(e, Math.abs(M.dasin(u) - Math.asin(u)), Math.abs(M.dacos(u) - Math.acos(u)));
    }
    assert.equal(M.datan2(0, -1), Math.PI);
    assert.equal(M.datan2(-0, -1), -Math.PI);
    assert.equal(M.datan2(0, 0), 0);
    info(`max err ${e.toExponential(2)}`);
    assert.ok(e < 1e-12);
});

test('dexp/dlog/dpow relative error below 1e-14', () => {
    const rng = new Rng(11);
    let e = 0;
    for (let i = 0; i < 20000; i++) {
        const x = rng.range(-700, 700);
        e = Math.max(e, Math.abs(M.dexp(x) / Math.exp(x) - 1));
        const y = M.dexp(rng.range(-700, 700));
        e = Math.max(e, Math.abs(M.dlog(y) - Math.log(y)) / Math.max(1, Math.abs(Math.log(y))));
        const b = rng.range(0.01, 10), p = rng.range(-5, 5);
        e = Math.max(e, Math.abs(M.dpow(b, p) / Math.pow(b, p) - 1) / 10);
    }
    assert.equal(M.dexp(0), 1);
    assert.equal(M.dlog(1), 0);
    assert.equal(M.dpow(3, 4), 81);
    info(`max rel err ${e.toExponential(2)}`);
    assert.ok(e < 1e-14);
});

test('quaternion helpers: headings, rotation, integration, basis round trip', () => {
    const v = [0, 0, 0];
    for (let d = 0; d < 4; d++) {
        M.qrotate(v, M.DIR_QUATS[d], [0, 0, 1]);
        for (let k = 0; k < 3; k++) approx(v[k], DIRS[d][k], 1e-15);
        const q = M.qfromYaw([0, 0, 0, 1], -d * M.HALF_PI);
        M.qrotate(v, q, [0, 0, 1]);
        for (let k = 0; k < 3; k++) approx(v[k], DIRS[d][k], 1e-15);
        // Right of the heading is the next heading clockwise.
        M.qright(v, M.DIR_QUATS[d]);
        for (let k = 0; k < 3; k++) approx(v[k], DIRS[(d + 1) % 4][k], 1e-15);
    }
    const q = M.qfromAxisAngle([0, 0, 0, 1], M.vnormalize([0, 0, 0], [1, 2, 3]), 1.234);
    const p = M.qrotate([0, 0, 0], q, [0.3, -0.7, 2]);
    const back = M.qrotateInv([0, 0, 0], q, p);
    approx(back[0], 0.3, 1e-14); approx(back[1], -0.7, 1e-14); approx(back[2], 2, 1e-14);
    // Spinning about +Y at 1 rad/s for 1 s equals a 1 rad yaw.
    const qi = [0, 0, 0, 1];
    for (let i = 0; i < 1000; i++) M.qintegrate(qi, qi, [0, 1, 0], 0.001);
    const ref = M.qfromYaw([0, 0, 0, 1], 1);
    for (let k = 0; k < 4; k++) approx(qi[k], ref[k], 1e-6);
    const f = M.qforward([0, 0, 0], q), u = M.qup([0, 0, 0], q), r = M.qright([0, 0, 0], q);
    const q2 = M.qfromBasis([0, 0, 0, 1], r, u, f);
    const sgn = Math.sign(q2[3] * q[3] + q2[0] * q[0]) || 1;
    for (let k = 0; k < 4; k++) approx(q2[k] * sgn, q[k], 1e-12);
});

test('rng is seeded, deterministic and in range', () => {
    const a = new Rng(42), b = new Rng(42);
    for (let i = 0; i < 1000; i++) {
        const x = a.next();
        assert.equal(x, b.next());
        assert.ok(x >= 0 && x < 1);
    }
    const s = a.getState();
    const seq = [a.int(10), a.range(-1, 1), a.pick(['x', 'y', 'z'])];
    a.setState(s);
    assert.deepEqual([a.int(10), a.range(-1, 1), a.pick(['x', 'y', 'z'])], seq);
    let mean = 0;
    const r = new Rng(hashSeed('snow'));
    for (let i = 0; i < 20000; i++) mean += r.normal();
    assert.ok(Math.abs(mean / 20000) < 0.03);
});

// ---------------------------------------------------------------------------
// Blocks

test('every block id builds at all rotations, several heights and every surface', () => {
    for (const def of BLOCK_LIST) {
        for (const s of def.surfaces) {
            const g = getBlockGeometry(def.id, s);
            assert.ok(g.groups.get('main').surf.length > 0, def.id);
            assert.ok(g.paths.length > 0, `${def.id} has paths`);
            for (const [, grp] of g.groups) {
                for (const v of grp.col) assert.ok(Number.isFinite(v), `${def.id} NaN`);
                for (const m of grp.meshes) {
                    for (const v of m.pos) assert.ok(Number.isFinite(v));
                    for (const v of m.nrm) assert.ok(Number.isFinite(v));
                    assert.equal(m.idx.length % 3, 0);
                }
            }
        }
        for (let r = 0; r < 4; r++) {
            for (const y of [0, 3, MAP_Y - def.size[1]]) {
                const w = buildWorld({ blocks: [{ b: def.id, x: 10, y, z: 10, r }] }, { route: false });
                const [W, Hh, D] = footprintSize(def, r);
                const b = w.collision.bounds;
                const eps = 1e-6;
                assert.ok(b.min[0] >= 10 * CELL - eps && b.max[0] <= (10 + W) * CELL + eps, `${def.id} r${r} x bounds`);
                assert.ok(b.min[2] >= 10 * CELL - eps && b.max[2] <= (10 + D) * CELL + eps, `${def.id} r${r} z bounds`);
                // Below the block only pillars may reach down to the ground.
                const floor = y === 0 ? -DECK_THICKNESS : GROUND_Y;
                assert.ok(b.min[1] >= floor - eps && b.max[1] <= (y + Hh) * LAYER + eps, `${def.id} r${r} y bounds`);
                for (const v of w.collision.positions) assert.ok(Number.isFinite(v));
                for (const v of w.collision.normals) assert.ok(Number.isFinite(v));
            }
        }
    }
    info(`${BLOCK_LIST.length} blocks`);
});

test('deck triangles face the driving side (normal agrees with the path up vector)', () => {
    for (const def of BLOCK_LIST) {
        const g = getBlockGeometry(def.id, def.defaultSurface);
        const pts = [], ups = [];
        for (const p of g.paths) {
            for (let i = 0; i < p.pts.length; i += 3) {
                pts.push([p.pts[i], p.pts[i + 1], p.pts[i + 2]]);
                ups.push([p.ups[i], p.ups[i + 1], p.ups[i + 2]]);
            }
        }
        const { col, surf } = g.groups.get('main');
        let checked = 0;
        for (let t = 0; t < surf.length; t++) {
            if (!DECK.has(surf[t])) continue;
            const a = [col[t * 9], col[t * 9 + 1], col[t * 9 + 2]];
            const e1 = M.vsub([0, 0, 0], [col[t * 9 + 3], col[t * 9 + 4], col[t * 9 + 5]], a);
            const e2 = M.vsub([0, 0, 0], [col[t * 9 + 6], col[t * 9 + 7], col[t * 9 + 8]], a);
            const n = M.vnormalize([0, 0, 0], M.vcross([0, 0, 0], e1, e2));
            const c = [(a[0] * 3 + e1[0] + e2[0]) / 3, (a[1] * 3 + e1[1] + e2[1]) / 3, (a[2] * 3 + e1[2] + e2[2]) / 3];
            let best = Infinity, up = null, at = null;
            for (let i = 0; i < pts.length; i++) {
                const d = M.vdist2(pts[i], c);
                if (d < best) { best = d; up = ups[i]; at = pts[i]; }
            }
            // Only the deck itself (v ~ 0); an ice roof is not the road.
            if (Math.abs(M.vdot(M.vsub([0, 0, 0], c, at), up)) > 0.5) continue;
            assert.ok(M.vdot(n, up) > 0.5, `${def.id}: deck triangle ${t} faces away (dot ${M.vdot(n, up).toFixed(3)})`);
            checked++;
        }
        assert.ok(checked > 0, `${def.id} has deck triangles`);
    }
});

test('raycast down onto every deck finds the block surface at the path height', () => {
    let rays = 0;
    for (const def of BLOCK_LIST) {
        const s = def.surfaces[def.surfaces.length - 1];
        for (let r = 0; r < 4; r++) {
            const w = buildWorld({ blocks: [{ b: def.id, x: 5, y: 2, z: 5, r, s }] }, { route: false });
            const xf = makeTransform(def, 5, 2, 5, r);
            const g = getBlockGeometry(def.id, s);
            for (const p of g.paths) {
                const n = p.pts.length / 3;
                for (let i = 0; i < p.pts.length; i += 3) {
                    // End points sit exactly on the block face (or a ramp lip): probe 2 cm inside.
                    const j = i === 0 ? 3 : i === p.pts.length - 3 ? i - 3 : i;
                    const f = i === 0 || i === p.pts.length - 3 ? 0.02 / Math.max(1e-9, Math.hypot(p.pts[j] - p.pts[i], p.pts[j + 1] - p.pts[i + 1], p.pts[j + 2] - p.pts[i + 2])) : 0;
                    const lp = [0, 1, 2].map((k) => p.pts[i + k] + (p.pts[j + k] - p.pts[i + k]) * (n > 1 ? f : 0));
                    const pt = xf.point(lp);
                    const up = xf.vector([p.ups[i], p.ups[i + 1], p.ups[i + 2]]);
                    const o = M.vaddScaled([0, 0, 0], pt, up, 1.5);
                    const hit = w.collision.raycast(o, M.vneg([0, 0, 0], up), 3);
                    assert.ok(hit, `${def.id} r${r}: no deck under path point ${i / 3}`);
                    assert.equal(hit.surfaceId, s, `${def.id} r${r} point ${i / 3}`);
                    assert.ok(M.vdist(hit.point, pt) < 0.02, `${def.id} r${r} point ${i / 3}: deck ${M.vdist(hit.point, pt).toFixed(4)} m off the path`);
                    assert.ok(M.vdot(hit.normal, up) > 0.7);
                    rays++;
                }
            }
        }
    }
    info(`${rays} rays`);
});

// Brute-force downward ray against a small triangle list; returns the top-most hit height or null.
function topHeight(tris, x, z) {
    let best = null;
    for (let t = 0; t < tris.length; t += 9) {
        const ax = tris[t], ay = tris[t + 1], az = tris[t + 2];
        const bx = tris[t + 3], by = tris[t + 4], bz = tris[t + 5];
        const cx = tris[t + 6], cy = tris[t + 7], cz = tris[t + 8];
        const d = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
        if (Math.abs(d) < 1e-12) continue;
        const u = ((z - az) * (cx - ax) - (x - ax) * (cz - az)) / d;
        const v = ((bz - az) * (x - ax) - (bx - ax) * (z - az)) / d;
        if (u < -1e-9 || v < -1e-9 || u + v > 1 + 1e-9) continue;
        const h = ay + u * (by - ay) + v * (cy - ay);
        if (best === null || h > best) best = h;
    }
    return best;
}

const faceCache = new Map();

/** Local triangles (deck + borders, main group) within 2 m of a connector face. */
function faceTris(def, ci) {
    const key = def.id + ci;
    if (faceCache.has(key)) return faceCache.get(key);
    const c = def.connectors[ci];
    const d = DIRS[c.dir];
    const ctr = [(c.cell[0] + 0.5 + d[0] * 0.5) * CELL, c.cell[1] * LAYER, (c.cell[2] + 0.5 + d[2] * 0.5) * CELL];
    const { col } = getBlockGeometry(def.id, 'snow').groups.get('main');
    const out = [];
    for (let t = 0; t < col.length; t += 9) {
        // Deck and snowbanks only: anything higher (a tunnel roof) is not part of the profile.
        // (A bank's outer snowbank is already a little above BORDER_HEIGHT 1.6 m in.)
        let near = false, low = true;
        for (let k = 0; k < 9; k += 3) {
            const dist = (col[t + k] - ctr[0]) * d[0] + (col[t + k + 2] - ctr[2]) * d[2];
            if (Math.abs(dist) < 2) near = true;
            if (col[t + k + 1] - ctr[1] > 1.6 || col[t + k + 1] - ctr[1] < -2) low = false;
        }
        near = near && low;
        if (near) for (let k = 0; k < 9; k++) out.push(col[t + k]);
    }
    faceCache.set(key, out);
    return out;
}

function placeTris(local, def, blk) {
    const xf = makeTransform(def, blk.x, blk.y, blk.z, blk.r);
    const out = new Float64Array(local.length);
    const p = [0, 0, 0];
    for (let i = 0; i < local.length; i += 3) {
        xf.point([local[i], local[i + 1], local[i + 2]], p);
        out[i] = p[0]; out[i + 1] = p[1]; out[i + 2] = p[2];
    }
    return out;
}

test('connector continuity: every connectable pair meets without a step (< 1 cm)', () => {
    const ends = [];
    for (const def of BLOCK_LIST) def.connectors.forEach((c, i) => { if (c.kind === 'road') ends.push({ def, i, c }); });
    let pairs = 0, worst = 0;
    for (const A of ends) {
        const blkA = { x: 20, y: 8, z: 20, r: 0 };
        const cellA = [blkA.x + A.c.cell[0], blkA.y + A.c.cell[1], blkA.z + A.c.cell[2]];
        const d = DIRS[A.c.dir];
        const face = [(cellA[0] + 0.5 + d[0] * 0.5) * CELL, cellA[1] * LAYER, (cellA[2] + 0.5 + d[2] * 0.5) * CELL];
        const lat = [-d[2], 0, d[0]];
        const trisA = placeTris(faceTris(A.def, A.i), A.def, blkA);
        for (const B of ends) {
            const next = [cellA[0] + d[0], cellA[1], cellA[2] + d[2]];
            const res = placeByConnector(B.def.id, B.i, B.i, next, A.c.dir, 'snow');
            const trisB = placeTris(faceTris(B.def, B.i), B.def, res.block);
            // Compare snowbanks too when both sides have them; a platform only shares the deck.
            const banked = (p) => p === 'road' || p === 'tunnel';
            const umax = banked(A.c.profile) && banked(B.c.profile) ? 13.9
                : A.c.profile === 'platform' && B.c.profile === 'platform' ? 15.9 : 11.9;
            for (let u = -umax; u <= umax + 1e-9; u += 0.25) {
                const x = face[0] + lat[0] * u, z = face[2] + lat[2] * u;
                // Each side's own triangles, probed a hair inside its face.
                const ha = topHeight(trisA, x - d[0] * 1e-7, z - d[2] * 1e-7);
                const hb = topHeight(trisB, x + d[0] * 1e-7, z + d[2] * 1e-7);
                assert.ok(ha !== null && hb !== null, `${A.def.id}#${A.i} -> ${B.def.id}#${B.i}: no deck at u=${u}`);
                const diff = Math.abs(ha - hb);
                worst = Math.max(worst, diff);
                assert.ok(diff < 0.01, `${A.def.id}#${A.i} -> ${B.def.id}#${B.i}: step of ${diff.toFixed(4)} m at u=${u}`);
                // 1 mm inside the face a bank has already started to twist by a few hundredths of a mm.
                if (Math.abs(u) < ROAD_HALF - 0.1) approx(ha, face[1], 1e-3, `${A.def.id}#${A.i} deck height at u=${u}`);
            }
            pairs++;
        }
    }
    info(`${pairs} pairs, worst step ${worst.toExponential(2)} m`);
});

test('placement transforms agree with rotateCell, footprints and DIRS', () => {
    for (const def of BLOCK_LIST) {
        for (let r = 0; r < 4; r++) {
            const xf = makeTransform(def, 3, 1, 4, r);
            const [W, , D] = footprintSize(def, r);
            for (const c of def.connectors) {
                const off = rotateCell(def, r, c.cell);
                assert.ok(off[0] >= 0 && off[0] < W && off[2] >= 0 && off[2] < D, `${def.id} r${r} cell in footprint`);
                const centre = xf.point([(c.cell[0] + 0.5) * CELL, 0, (c.cell[2] + 0.5) * CELL]);
                assert.equal(Math.floor(centre[0] / CELL), 3 + off[0]);
                assert.equal(Math.floor(centre[2] / CELL), 4 + off[2]);
                const v = xf.vector(DIRS[c.dir]);
                const wd = xf.dir(c.dir);
                for (let k = 0; k < 3; k++) approx(v[k], DIRS[wd][k], 0);
            }
        }
    }
});

// ---------------------------------------------------------------------------
// Collision queries

function straightPair() {
    return buildWorld({ blocks: [{ b: 'Straight', x: 2, y: 0, z: 2, r: 0 }, { b: 'Straight', x: 2, y: 0, z: 3, r: 0 }] }, { route: false });
}

test('querySphere: one merged contact on a flat deck and across a seam; two in a border corner', () => {
    const w = straightPair();
    const out = [];
    const cx = 2 * CELL + 16;
    let n = w.collision.querySphere([cx + 1.3, 0.4, 2 * CELL + 9.1], 0.5, out);
    assert.equal(n, 1);
    approx(out[0].normal[1], 1, 1e-12);
    approx(out[0].depth, 0.1, 1e-9);
    assert.equal(out[0].surfaceId, 'snow');
    // Exactly over the seam between the two blocks.
    n = w.collision.querySphere([cx - 3, 0.45, 3 * CELL], 0.5, out);
    assert.equal(n, 1);
    approx(out[0].depth, 0.05, 1e-9);
    // Wheel pressed into the deck/border corner (border inner face at |u| = 12).
    n = w.collision.querySphere([cx - 11.7, 0.45, 2 * CELL + 16], 0.5, out);
    assert.equal(n, 2);
    const walls = out.slice(0, n).filter((c) => c.surfaceId === 'wall');
    assert.equal(walls.length, 1);
    assert.ok(walls[0].normal[0] > 0.9, 'border pushes back toward the road');
    // Off the road: the deep-snow ground.
    n = w.collision.querySphere([10, GROUND_Y + 0.2, 10], 0.5, out);
    assert.equal(n, 1);
    assert.equal(out[0].surfaceId, 'ground');
    approx(out[0].depth, 0.3, 1e-9);
});

test('raycast: decks, undersides, ground, misses and the reused result object', () => {
    const w = buildWorld({ blocks: [{ b: 'Straight', x: 2, y: 2, z: 2, r: 1 }] }, { route: false });
    const c = w.collision;
    const hit = c.raycast([2 * CELL + 16, 30, 2 * CELL + 16], [0, -1, 0], 100);
    approx(hit.point[1], 16, 1e-9);
    assert.equal(hit.surfaceId, 'snow');
    assert.equal(hit.backface, false);
    const under = c.raycast([2 * CELL + 16, 5, 2 * CELL + 16], [0, 1, 0], 100);
    approx(under.point[1], 16 - DECK_THICKNESS, 1e-9);
    assert.ok(under.normal[1] < -0.99);
    const g = c.raycast([100, 10, 100], [0, -1, 0], 100);
    assert.equal(g.surfaceId, 'ground');
    approx(g.point[1], GROUND_Y, 1e-12);
    assert.equal(c.raycast([-50, 10, -50], [0, -1, 0], 100), null);
    const reuse = { t: 0, point: [0, 0, 0], normal: [0, 0, 0], surface: 0, surfaceId: '', tri: 0, backface: false };
    assert.equal(c.raycast([2 * CELL + 16, 30, 2 * CELL + 16], [0, -1, 0], 100, reuse), reuse);
    // Horizontal ray into the snowbank (border along z for r = 1).
    const side = c.raycast([2 * CELL + 16, 16.5, 2 * CELL + 16], [0, 0, 1], 50);
    assert.equal(side.surfaceId, 'wall');
    approx(side.point[2], 2 * CELL + 16 + ROAD_HALF, 0.2);
});

test('sweepSphere stops at a wall; segmentAABB catches thin gates', () => {
    const w = straightPair();
    const cx = 2 * CELL + 16;
    const t = w.collision.sweepSphere([cx, 0.8, 2 * CELL + 10], [cx - 30, 0.8, 2 * CELL + 10], 0.5);
    assert.ok(t > 0 && t < 1);
    // The snowbank's inner face leans out 0.3 m over its 1.2 m height; at y = 0.8 the
    // sphere touches it with its centre 0.315 m inside the deck edge.
    approx(cx - 30 * t, cx - ROAD_HALF + 0.315, 0.02);
    assert.equal(w.collision.sweepSphere([cx, 3, 2 * CELL + 10], [cx, 3, 3 * CELL + 10], 0.5), -1);
    const box = { min: [0, 0, 10], max: [10, 10, 10.5] };
    approx(segmentAABB([5, 1, 0], [5, 1, 20], box), 0.5, 1e-12);
    assert.equal(segmentAABB([5, 1, 0], [5, 1, 9], box), -1);
});

// ---------------------------------------------------------------------------
// Tracks, validation, path builder

test('samples validate, build and their routes cross every checkpoint and the finish', () => {
    for (const t of getSamples()) {
        const v = validateTrack(t);
        assert.ok(v.ok, `${t.id}: ${v.errors.join('; ')}`);
        const w = buildWorld(t);
        const r = w.route;
        assert.ok(r, `${t.id}: ${w.routeError}`);
        assert.equal(r.checkpoints.length, w.checkpointCount, `${t.id} checkpoints on route`);
        for (const trg of w.triggers) {
            if (trg.type !== 'checkpoint' && trg.type !== 'finish' && trg.type !== 'startfinish') continue;
            let crossed = false;
            for (let i = 0; i + 1 < r.count && !crossed; i++) {
                const a = [r.points[i * 3], r.points[i * 3 + 1], r.points[i * 3 + 2]];
                const b = [r.points[i * 3 + 3], r.points[i * 3 + 4], r.points[i * 3 + 5]];
                if (segmentAABB(a, b, trg) >= 0) crossed = true;
            }
            if (trg.type === 'finish' && w.triggers.filter((x) => x.type === 'finish').length > 1) continue;
            assert.ok(crossed, `${t.id}: route misses ${trg.type} #${trg.id}`);
        }
        // Spawn sits on the route; the route ends on a finish line.
        const sp = r.pointAt(r.spawnS);
        assert.ok(M.vdist(sp.point, w.spawn.pos) < 0.05, `${t.id} spawn on route`);
        const end = [r.points[(r.count - 1) * 3], r.points[(r.count - 1) * 3 + 1], r.points[(r.count - 1) * 3 + 2]];
        assert.ok(w.triggers.some((x) => (x.type === 'finish' || x.type === 'startfinish')
            && end[0] >= x.min[0] && end[0] <= x.max[0] && end[2] >= x.min[2] && end[2] <= x.max[2]), `${t.id} route ends on the line`);
        // Route points lie on drivable deck except over jumps.
        for (let i = 0; i < r.count; i++) {
            if (r.gap[i]) continue;
            const p = [r.points[i * 3], r.points[i * 3 + 1], r.points[i * 3 + 2]];
            const up = [r.ups[i * 3], r.ups[i * 3 + 1], r.ups[i * 3 + 2]];
            const hit = w.collision.raycast(M.vaddScaled([0, 0, 0], p, up, 1), M.vneg([0, 0, 0], up), 2);
            assert.ok(hit && DECK.has(hit.surface) && Math.abs(hit.t - 1) < 0.05, `${t.id}: route point ${i} not on deck`);
        }
    }
});

test('route projection inverts pointAt; lateral is positive to the right', () => {
    const w = buildWorld(getSamples()[0]);
    const r = w.route;
    const rng = new Rng(5);
    let hint = 0;
    for (let k = 0; k < 2000; k++) {
        const s = (k / 2000) * r.length;
        const p = r.pointAt(s);
        const pr = r.project(p.point, hint);
        approx(pr.s, s, 1e-6, `s at ${s}`);
        hint = pr.index;
        // Offset to the right (tangent x up).
        const right = M.vcross([0, 0, 0], p.tangent, p.up);
        const off = rng.range(-8, 8);
        // Lateral is measured against the nearest segment: near a vertex in a tight
        // curve a far offset projects onto the neighbouring segment (a few cm).
        const q = r.project(M.vaddScaled([0, 0, 0], p.point, right, off), pr.index);
        approx(q.lateral, off, 0.1);
        assert.equal(Math.sign(q.lateral), Math.sign(off));
    }
    // Global fallback without a hint.
    const far = r.pointAt(r.length * 0.7);
    approx(r.project(far.point).s, r.length * 0.7, 1e-6);
    // A right turn has positive curvature; S01 starts with Turn3R.
    const turn = r.checkpoints[0].s - 60;
    assert.ok(r.curvatureAt(turn) > 0, 'right turn is positive');
    approx(r.headingChange(turn - 140, turn + 55), M.HALF_PI, 0.02);
});

test('pillars stand under elevated decks with outward walls, never through lower blocks', () => {
    const w = buildWorld(getSamples().find((t) => t.id === 'S02'));
    const pillars = w.render.props.filter((p) => p.kind === 'pillar');
    assert.ok(pillars.length > 10);
    const out = [];
    for (const p of pillars) {
        approx(p.pos[1], GROUND_Y, 1e-12);
        // The deck underside sits right on top of the pillar.
        const up = w.collision.raycast([p.pos[0] + 1.5, p.pos[1] + 1, p.pos[2]], [0, 1, 0], 300);
        assert.ok(up && Math.abs(up.point[1] - (p.pos[1] + p.height)) < 0.05, 'pillar reaches the deck');
        const n = w.collision.querySphere([p.pos[0] + 1.3, p.pos[1] + p.height / 2, p.pos[2]], 0.5, out);
        assert.equal(n, 1);
        assert.ok(out[0].faceNormal[0] > 0.99 && out[0].normal[0] > 0.99, 'pillar side faces outward');
    }
    // A road under an elevated block takes the pillar's place.
    const stacked = buildWorld({ blocks: [{ b: 'Straight', x: 5, y: 2, z: 5, r: 0 }, { b: 'Straight', x: 5, y: 0, z: 5, r: 1 }] }, { route: false });
    assert.equal(stacked.render.props.filter((p) => p.kind === 'pillar').length, 0);
    const lone = buildWorld({ blocks: [{ b: 'Straight', x: 5, y: 2, z: 5, r: 0 }] }, { route: false });
    assert.equal(lone.render.props.filter((p) => p.kind === 'pillar').length, 1);
});

test('multilap route is a closed lap starting on the StartFinish line', () => {
    const t = getSamples().find((x) => x.laps > 1);
    const w = buildWorld(t);
    const r = w.route;
    assert.ok(r.closed);
    approx(r.spawnS, 6, 1e-6);
    const p = r.pointAt(r.length + 10), q = r.pointAt(10);
    assert.ok(M.vdist(p.point, q.point) < 1e-9);
});

test('jumps are bridged by gap edges from the ramp lip to the landing', () => {
    const w = buildWorld(getSamples().find((t) => t.id === 'S03'));
    const r = w.route;
    let gaps = 0;
    for (let i = 1; i < r.count; i++) if (r.gap[i] && !r.gap[i - 1]) gaps++;
    assert.equal(gaps, 2);
    let maxY = 0;
    for (let i = 0; i < r.count; i++) if (r.gap[i]) maxY = Math.max(maxY, r.points[i * 3 + 1]);
    assert.ok(maxY > 8, 'the big jump arcs above the lip');
});

test('validateTrack reports structural problems', () => {
    const base = getSamples()[0];
    const errs = (mut) => {
        const t = JSON.parse(JSON.stringify(base));
        mut(t);
        return validateTrack(t).errors.join(' | ');
    };
    assert.match(errs((t) => t.blocks.push({ ...t.blocks[3] })), /overlaps/);
    assert.match(errs((t) => t.blocks.push({ b: 'Straight', x: 47, y: 0, z: 47, r: 1 }) && t.blocks.push({ b: 'Turn3', x: 46, y: 0, z: 46, r: 0 })), /outside the map/);
    assert.match(errs((t) => { t.blocks = t.blocks.filter((b) => b.b !== 'Finish'); }), /No Finish/);
    assert.match(errs((t) => { t.blocks = t.blocks.filter((b) => b.b !== 'Start'); }), /No Start/);
    assert.match(errs((t) => { t.laps = 3; }), /StartFinish/);
    assert.match(errs((t) => t.blocks.push({ b: 'Snowplow', x: 0, y: 0, z: 0 })), /unknown block/);
    assert.match(errs((t) => { t.blocks[2].s = 'lava'; }), /surface 'lava'/);
    assert.match(errs((t) => { Object.assign(t.blocks.find((b) => b.b === 'Finish'), { x: 40, z: 40 }); }), /No route/);
    assert.match(errs((t) => t.blocks.push({ b: 'Start', x: 30, y: 0, z: 30 })), /Only one Start/);
});

test('trackFromPath: turtle rules, piece names and clear errors', () => {
    // Turn2R from heading +Z ends heading -X one cell left of the block.
    const t = trackFromPath({ start: [10, 0, 10, 0], pieces: ['Start', 'Turn2R', 'Turn1L', 'SlopeUp1', 'Up', 'Gap*2', 'SlopeDown1', 'Straight:ice', 'Finish'] });
    const [st, t2, t1, up, down, ice] = t.blocks;
    assert.deepEqual([st.x, st.z, st.r], [10, 10, 0]);
    assert.deepEqual([t2.b, t2.x, t2.z, t2.r], ['Turn2', 9, 11, 3]);
    assert.deepEqual([t1.x, t1.z], [8, 12]);
    assert.deepEqual([up.b, up.x, up.y, up.z], ['SlopeUp1', 8, 0, 13]);
    // After the slope (level 1) Up lifts to 2, Gap*2 skips 2 cells, SlopeDown1 lands back on level 1.
    assert.deepEqual([down.b, down.y, down.z], ['SlopeUp1', 1, 16]);
    assert.equal(ice.s, 'ice');
    assert.equal(ice.y, 1);
    for (const name of PIECE_NAMES) {
        assert.doesNotThrow(() => trackFromPath({ start: [20, 4, 20, 0], pieces: [name] }), name);
    }
    assert.throws(() => trackFromPath({ start: [1, 0, 1, 0], pieces: ['Start', 'Turn1L', 'Turn1L', 'Turn1L', 'Turn1L'] }), /piece #4 'Turn1L'.*overlaps/);
    assert.throws(() => trackFromPath({ start: [1, 0, 1, 2], pieces: ['Start', 'Straight*3'] }), /piece #1 'Straight\*3'.*leaves the map/);
    assert.throws(() => trackFromPath({ start: [1, 0, 1, 0], pieces: ['Start', 'Wobble'] }), /piece #1 'Wobble': unknown piece/);
    // Object pieces: named pieces with options, or explicit connectors of any block.
    const o = trackFromPath({ start: [10, 0, 10, 0], pieces: ['Start', { b: 'Straight', n: 2, s: 'powder' }, { b: 'Cross', entry: 2, exit: 1 }, 'Finish'] });
    assert.deepEqual(o.blocks.map((b) => b.b), ['Start', 'Straight', 'Straight', 'Cross', 'Finish']);
    assert.equal(o.blocks[1].s, 'powder');
    assert.deepEqual([o.blocks[4].x, o.blocks[4].z, o.blocks[4].r], [9, 13, 1]);
});

// ---------------------------------------------------------------------------
// Codec

test('codec round-trips every sample and rejects corrupt codes', () => {
    for (const t of getSamples()) {
        const tr = normalizeTrack({ ...t, medals: { author: 41230, gold: 44000, silver: { respawns: 2, ms: 50000 }, bronze: null } });
        const code = encodeTrack(tr);
        assert.ok(code.startsWith('PT1.'));
        assert.ok(/^[A-Za-z0-9_-]+$/.test(code.slice(4)));
        const back = decodeTrack(code);
        assert.deepEqual(normalizeTrack(back), tr);
        assert.equal(trackHash(back), trackHash(tr));
        info(`${t.id}: ${t.blocks.length} blocks -> ${code.length} chars`);
    }
    const code = encodeTrack(getSamples()[0]);
    const flip = code.slice(0, 20) + (code[20] === 'A' ? 'B' : 'A') + code.slice(21);
    assert.throws(() => decodeTrack(flip), /Corrupt/);
    assert.throws(() => decodeTrack(code.slice(0, -3)), /Corrupt/);
    assert.throws(() => decodeTrack('XX1.' + code.slice(4)), /Corrupt/);
    assert.throws(() => decodeTrack(code + '!'), /Corrupt/);
});

test('trackHash depends on the layout only', () => {
    const t = getSamples()[1];
    const h = trackHash(t);
    assert.match(h, /^[0-9a-f]{16}$/);
    assert.equal(trackHash({ ...t, name: 'Renamed', medals: {}, decor: [] }), h);
    const moved = JSON.parse(JSON.stringify(t));
    moved.blocks[3].r = (moved.blocks[3].r + 1) % 4;
    assert.notEqual(trackHash(moved), h);
    assert.notEqual(trackHash({ ...t, laps: 2 }), h);
});

// ---------------------------------------------------------------------------
// Speed and determinism

function serpentine() {
    const run = ['Straight', 'SlopeUp1', 'Straight', 'Checkpoint', 'SlopeDown1', 'Turbo', 'Straight', 'Bump', 'Tunnel', 'Straight'];
    const pieces = ['Start'];
    for (let c = 0; c < 6; c++) pieces.push(...run, 'Turn1R', 'Turn1R', ...run, 'Turn1L', 'Turn1L');
    pieces.push('Straight', 'Turn2R', 'Bank3L', 'Straight', 'Finish');
    return trackFromPath({ id: 'serp', name: 'Serpentine', start: [40, 0, 2, 0], pieces });
}

function hashFloats(arr) {
    const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
    let h = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) {
        h ^= bytes[i];
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16);
}

test('buildWorld is fast for a 150-block track', () => {
    const t = serpentine();
    assert.ok(t.blocks.length >= 150, `${t.blocks.length} blocks`);
    clearGeometryCache();
    let t0 = performance.now();
    const cold = buildWorld(t);
    const coldMs = performance.now() - t0;
    assert.ok(cold.route, cold.routeError);
    let best = Infinity;
    for (let i = 0; i < 5; i++) {
        t0 = performance.now();
        buildWorld(t);
        best = Math.min(best, performance.now() - t0);
    }
    info(`${t.blocks.length} blocks, ${cold.collision.triCount} tris: cold ${coldMs.toFixed(1)} ms, warm ${best.toFixed(1)} ms`);
    assert.ok(best < 50, `warm build took ${best.toFixed(1)} ms`);
});

test('buildWorld is deterministic (bit-identical triangles, route and render data)', () => {
    const t = getSamples().find((x) => x.id === 'S03');
    clearGeometryCache();
    const a = buildWorld(t);
    clearGeometryCache();
    const b = buildWorld(serpentine());
    const c = buildWorld(t);
    assert.equal(hashFloats(a.collision.positions), hashFloats(c.collision.positions));
    assert.equal(hashFloats(a.route.points), hashFloats(c.route.points));
    assert.equal(a.render.meshes.length, c.render.meshes.length);
    for (let i = 0; i < a.render.meshes.length; i++) assert.equal(hashFloats(a.render.meshes[i].positions), hashFloats(c.render.meshes[i].positions));
    assert.ok(b.collision.triCount > 0);
    info(`S03 collision hash ${hashFloats(a.collision.positions)} route ${hashFloats(a.route.points)}`);
});

test('collision micro-benchmark (wheel rays and sphere queries)', () => {
    const w = buildWorld(serpentine());
    const r = w.route;
    const c = w.collision;
    const N = 200000;
    const origins = [];
    const rng = new Rng(1);
    for (let i = 0; i < 1024; i++) {
        const p = r.pointAt(rng.range(0, r.length));
        const right = M.vcross([0, 0, 0], p.tangent, p.up);
        const o = M.vaddScaled([0, 0, 0], p.point, right, rng.range(-10, 10));
        origins.push([o[0], o[1] + 1.2, o[2]]);
    }
    const down = [0, -1, 0];
    const hit = { t: 0, point: [0, 0, 0], normal: [0, 0, 0], surface: 0, surfaceId: '', tri: 0, backface: false };
    let hits = 0;
    let t0 = performance.now();
    for (let i = 0; i < N; i++) if (c.raycast(origins[i & 1023], down, 2, hit)) hits++;
    const rayRate = N / ((performance.now() - t0) / 1000);
    const out = [];
    let contacts = 0;
    t0 = performance.now();
    for (let i = 0; i < N; i++) {
        const o = origins[i & 1023];
        contacts += c.querySphere([o[0], o[1] - 0.9, o[2]], 0.5, out);
    }
    const sphereRate = N / ((performance.now() - t0) / 1000);
    info(`${(rayRate / 1e6).toFixed(2)} M rays/s (${hits} hits), ${(sphereRate / 1e6).toFixed(2)} M sphere queries/s (${contacts} contacts), grid ${c.nx}x${c.ny}x${c.nz} @ ${c.cs} m`);
    assert.ok(hits > N * 0.9);
    // 20 queries per tick at 20k ticks/s needs 400k/s; leave headroom for slow CI.
    assert.ok(rayRate > 400000 && sphereRate > 200000);
});
