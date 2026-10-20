// Scenery layout: where auto-scenery goes (pines, rocks, crystals, igloos,
// penguin crowds, night lamps, mountains) and the terrain height beyond the
// map. Pure and deterministic (seeded by the track hash) with no three.js, so
// Node tests can check it and every player sees the same landscape.
import { Rng, hashSeed } from '../core/rng.js';
import { CELL, LAYER, MAP_X, MAP_Z, DIRS } from '../core/constants.js';

const MAP_W = MAP_X * CELL, MAP_D = MAP_Z * CELL;
const CLEAR_LEVELS = 4;     // columns with a block this low (32 m) never get trees below it
const MARGIN_CELLS = 7;     // scenery reaches this far around the track's footprint

/** Terrain height (m) at world (x, z): 0 on the map, rolling snow hills outside it. */
export function terrainHeight(x, z) {
    const dx = x < 0 ? -x : x > MAP_W ? x - MAP_W : 0;
    const dz = z < 0 ? -z : z > MAP_D ? z - MAP_D : 0;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d <= 0) return 0;
    const rise = Math.min(1, d / 900);
    const hills = 18 * Math.sin(x * 0.0041 + 1.3) * Math.sin(z * 0.0037 + 0.4)
        + 9 * Math.sin(x * 0.011 + z * 0.006) + 5 * Math.sin(z * 0.017 - x * 0.004);
    return rise * rise * (40 + hills) + Math.min(d, 60) * 0.04 - 0.2;
}

function seedOf(world) {
    return hashSeed(String(world.hash || 'penguintrack') + ':scenery');
}

/**
 * Plans every auto-scenery instance for a world.
 * Returns { items: [{ kind, x, y, z, rot, scale, tint }], crowds: [{ x, y, z, rot, scale }],
 *           lamps: [{ x, y, z, rot, side, up:[3] }], mountains: [{ x, z, radius, height, seed }] }
 * kinds: 'pine', 'rock', 'crystal', 'igloo', 'snowman'.
 */
export function planScenery(world, opts = {}) {
    const density = opts.density ?? 1;
    const rng = new Rng(seedOf(world));
    const items = [], crowds = [], lamps = [];

    // Blocked columns: low blocks, decor, cells under the route (jump gaps included).
    const blocked = new Uint8Array(MAP_X * MAP_Z);
    const col = (x, z) => x * MAP_Z + z;
    let minX = MAP_X, minZ = MAP_Z, maxX = -1, maxZ = -1;
    const occ = world.occupancy;
    if (occ) {
        for (const key of occ.keys()) {
            const [x, y, z] = parseKey(key);
            if (x < 0 || z < 0 || x >= MAP_X || z >= MAP_Z) continue;
            minX = Math.min(minX, x); maxX = Math.max(maxX, x);
            minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
            if (y < CLEAR_LEVELS) blocked[col(x, z)] = 1;
        }
    }
    const route = world.route;
    if (route) {
        const p = route.points;
        for (let i = 0; i < route.count; i++) {
            const x = Math.floor(p[i * 3] / CELL), z = Math.floor(p[i * 3 + 2] / CELL);
            if (x >= 0 && z >= 0 && x < MAP_X && z < MAP_Z && p[i * 3 + 1] < CLEAR_LEVELS * LAYER + 8) blocked[col(x, z)] = 1;
        }
    }
    const decorCells = new Set();
    for (const d of world.track?.decor || []) {
        if (d.x >= 0 && d.z >= 0 && d.x < MAP_X && d.z < MAP_Z) {
            blocked[col(d.x, d.z)] = Math.max(blocked[col(d.x, d.z)], 2);
            decorCells.add(col(d.x, d.z));
        }
    }
    if (maxX < 0) {
        minX = minZ = 20; maxX = maxZ = 27;
    }

    // Chebyshev distance to the nearest blocked column (BFS, capped).
    const dist = new Uint8Array(MAP_X * MAP_Z).fill(255);
    let frontier = [];
    for (let x = 0; x < MAP_X; x++) for (let z = 0; z < MAP_Z; z++) if (blocked[col(x, z)]) { dist[col(x, z)] = 0; frontier.push([x, z]); }
    for (let d = 1; d <= 6 && frontier.length; d++) {
        const next = [];
        for (const [x, z] of frontier) {
            for (let ox = -1; ox <= 1; ox++) for (let oz = -1; oz <= 1; oz++) {
                const nx = x + ox, nz = z + oz;
                if (nx < 0 || nz < 0 || nx >= MAP_X || nz >= MAP_Z || dist[col(nx, nz)] !== 255) continue;
                dist[col(nx, nz)] = d;
                next.push([nx, nz]);
            }
        }
        frontier = next;
    }

    // Penguin crowds beside gates on the ground, facing the road.
    const used = new Set();
    for (const p of world.render?.props || []) {
        if (p.kind !== 'gate') continue;
        const level = Math.round(p.pos[1] / LAYER);
        const fwd = DIRS[p.dir];
        const right = [-fwd[2], 0, fwd[0]];     // any side; both are tried
        for (const s of [-1, 1]) {
            const cx = p.pos[0] + right[0] * s * 32, cz = p.pos[2] + right[2] * s * 32;
            const gx = Math.floor(cx / CELL), gz = Math.floor(cz / CELL);
            if (gx < 0 || gz < 0 || gx >= MAP_X || gz >= MAP_Z) continue;
            const c = col(gx, gz);
            if (blocked[c] || used.has(c) || level > 0) continue;
            used.add(c);
            const rows = 3, per = p.gate === 'checkpoint' ? 5 : 7;
            for (let r = 0; r < rows; r++) {
                for (let k = 0; k < per; k++) {
                    const along = (k - (per - 1) / 2) * 2.3 + rng.range(-0.5, 0.5);
                    const lat = 17.5 + r * 2.2 + rng.range(-0.4, 0.4);
                    const x = p.pos[0] + fwd[0] * along + right[0] * s * lat;
                    const z = p.pos[2] + fwd[2] * along + right[2] * s * lat;
                    // Face the road (toward the gate centre line), with a little jitter.
                    const rot = Math.atan2(-right[0] * s, -right[2] * s) + rng.range(-0.35, 0.35);
                    crowds.push({ x, y: 0, z, rot, scale: rng.range(0.9, 1.25), phase: rng.range(0, 6.28) });
                }
            }
        }
    }

    // Trees, rocks, crystals and igloos on free cells around the track.
    const x0 = Math.max(0, minX - MARGIN_CELLS), x1 = Math.min(MAP_X - 1, maxX + MARGIN_CELLS);
    const z0 = Math.max(0, minZ - MARGIN_CELLS), z1 = Math.min(MAP_Z - 1, maxZ + MARGIN_CELLS);
    for (let x = x0; x <= x1; x++) {
        for (let z = z0; z <= z1; z++) {
            const c = col(x, z);
            const d = dist[c];
            if (d === 0 || used.has(c)) continue;
            const cx = (x + 0.5) * CELL, cz = (z + 0.5) * CELL;
            // Push near-road items away from the road side.
            let ax = 0, az = 0;
            if (d === 1) {
                for (let ox = -1; ox <= 1; ox++) for (let oz = -1; oz <= 1; oz++) {
                    const nx = x + ox, nz = z + oz;
                    if (nx >= 0 && nz >= 0 && nx < MAP_X && nz < MAP_Z && blocked[col(nx, nz)]) { ax -= ox; az -= oz; }
                }
                const l = Math.sqrt(ax * ax + az * az) || 1;
                ax /= l; az /= l;
            }
            const roll = rng.next();
            if (d === 1) {
                if (roll > 0.42 * density) continue;
                const px = cx + ax * 8 + rng.range(-4, 4), pz = cz + az * 8 + rng.range(-4, 4);
                const kind = rng.chance(0.55) ? 'pine' : rng.chance(0.75) ? 'rock' : 'crystal';
                items.push(item(rng, kind, px, pz, kind === 'pine' ? rng.range(0.55, 0.85) : rng.range(0.7, 1.2)));
            } else if (d === 2) {
                if (roll > 0.62 * density) continue;
                const k = rng.next();
                if (k < 0.06) items.push(item(rng, 'igloo', cx + rng.range(-5, 5), cz + rng.range(-5, 5), rng.range(0.9, 1.15)));
                else if (k < 0.13) items.push(item(rng, 'crystal', cx + rng.range(-8, 8), cz + rng.range(-8, 8), rng.range(1, 1.6)));
                else if (k < 0.18) items.push(item(rng, 'snowman', cx + rng.range(-8, 8), cz + rng.range(-8, 8), rng.range(0.9, 1.2)));
                else {
                    const n = 1 + rng.int(2);
                    for (let i = 0; i < n; i++) items.push(item(rng, 'pine', cx + rng.range(-10, 10), cz + rng.range(-10, 10), rng.range(0.75, 1.15)));
                    if (rng.chance(0.3)) items.push(item(rng, 'rock', cx + rng.range(-12, 12), cz + rng.range(-12, 12), rng.range(0.8, 1.6)));
                }
            } else {
                if (roll > 0.8 * density) continue;
                const k = rng.next();
                if (k < 0.05) items.push(item(rng, 'igloo', cx + rng.range(-6, 6), cz + rng.range(-6, 6), rng.range(1, 1.3)));
                else if (k < 0.1) items.push(item(rng, 'crystal', cx + rng.range(-9, 9), cz + rng.range(-9, 9), rng.range(1.2, 2.2)));
                else {
                    const n = 1 + rng.int(3);
                    for (let i = 0; i < n; i++) items.push(item(rng, 'pine', cx + rng.range(-12, 12), cz + rng.range(-12, 12), rng.range(0.8, 1.35)));
                    if (rng.chance(0.25)) items.push(item(rng, 'rock', cx + rng.range(-12, 12), cz + rng.range(-12, 12), rng.range(1, 2.2)));
                }
            }
        }
    }

    // Forest beyond the map edge, on the hills, so the horizon never looks empty.
    const outside = Math.round(200 * density);
    for (let i = 0; i < outside; i++) {
        const a = rng.range(0, Math.PI * 2), r = rng.range(80, 1100);
        const side = rng.int(4);
        let x, z;
        if (side === 0) { x = rng.range(-r, MAP_W + r); z = -r * rng.range(0.15, 1); }
        else if (side === 1) { x = rng.range(-r, MAP_W + r); z = MAP_D + r * rng.range(0.15, 1); }
        else if (side === 2) { z = rng.range(-r, MAP_D + r); x = -r * rng.range(0.15, 1); }
        else { z = rng.range(-r, MAP_D + r); x = MAP_W + r * rng.range(0.15, 1); }
        const it = item(rng, 'pine', x + Math.cos(a) * 20, z + Math.sin(a) * 20, rng.range(1, 1.8));
        it.y = terrainHeight(it.x, it.z) - 0.3;
        items.push(it);
    }

    // Night lamps along the route, alternating sides every ~90 m, on flat road only.
    if (route && route.count > 2) {
        let nextS = 30, side = 1;
        const P = route.points, U = route.ups, T = route.tangents;
        for (let i = 0; i < route.count; i++) {
            if (route.s[i] < nextS) continue;
            const flat = U[i * 3 + 1] > 0.985 && !route.gap[i] && route.halfWidth[i] >= 11;
            if (!flat) continue;
            const tx = T[i * 3], tz = T[i * 3 + 2];
            const tl = Math.sqrt(tx * tx + tz * tz) || 1;
            // Right = tangent × up (core convention).
            const rx = -tz / tl, rz = tx / tl;
            const hw = route.halfWidth[i] + 1.2;
            lamps.push({
                x: P[i * 3] + rx * hw * side, y: P[i * 3 + 1] + 1.2, z: P[i * 3 + 2] + rz * hw * side,
                rot: Math.atan2(-rx * side, -rz * side), side,
                road: [P[i * 3] + rx * (hw - 5) * side, P[i * 3 + 1], P[i * 3 + 2] + rz * (hw - 5) * side],
            });
            side = -side;
            nextS = route.s[i] + 90;
        }
    }

    // A ring of mountains far beyond the map.
    const mountains = [];
    const cx = MAP_W / 2, cz = MAP_D / 2;
    const count = 22;
    for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2 + rng.range(-0.08, 0.08);
        const r = rng.range(2600, 3500);
        mountains.push({
            x: cx + Math.cos(a) * r, z: cz + Math.sin(a) * r,
            radius: rng.range(420, 720), height: rng.range(300, 720), seed: rng.nextU32(),
        });
    }
    return { items, crowds, lamps, mountains, decorCells: decorCells.size };
}

function item(rng, kind, x, z, scale) {
    return { kind, x, y: 0, z, rot: rng.range(0, Math.PI * 2), scale, tint: rng.range(0, 1) };
}

/** Inverse of core's cellKey(x, y, z) = (x * 64 + y) * 64 + z. */
function parseKey(key) {
    if (typeof key === 'string') return key.split(',').map(Number);
    return [Math.floor(key / 4096), Math.floor(key / 64) % 64, key % 64];
}
