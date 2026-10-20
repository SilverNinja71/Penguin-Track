// Seeded scenery for the official tracks: penguin crowds and banners at the
// start and finish, then trees, igloos, snowmen, crystals or lamps scattered on
// the free ground around the road. Deterministic per track id, never on a road
// cell, and decor never touches physics or the track hash.
import { BLOCKS, footprintSize } from '../core/blocks.js';
import { DIRS, MAP_X, MAP_Z } from '../core/constants.js';
import { Rng, hashSeed } from '../core/rng.js';

/**
 * Extra decor for a built track (does not include track.decor).
 * opts = {
 *   kinds: { Pine: 6, Igloo: 1, … }   relative weights of the scattered models
 *   density: 0.3                      chance that a free cell near the road gets one
 *   near: 1, far: 3                   ring (cells from the road) to scatter in
 *   lamps: 0                          a Lamp beside every n-th road cell at ground level (0 = none)
 *   crowds: true                      PenguinCrowd + Banner beside level-0 gates
 * }
 */
export function scenery(track, opts = {}) {
    const { kinds = { Pine: 1 }, density = 0.3, near = 1, far = 3, lamps = 0, crowds = true } = opts;
    const rng = new Rng(hashSeed(`scenery:${track.id}`));
    const taken = new Set();     // columns holding a block, or decor already
    const road = [];             // [x, z, block] for every footprint column, in block order
    const key = (x, z) => x * 64 + z;   // only ever used for cells inside the map
    for (const d of track.decor) taken.add(key(d.x, d.z));
    for (const b of track.blocks) {
        const [W, , D] = footprintSize(BLOCKS[b.b], b.r);
        for (let x = b.x; x < b.x + W; x++) {
            for (let z = b.z; z < b.z + D; z++) {
                taken.add(key(x, z));
                road.push([x, z, b]);
            }
        }
    }
    const inMap = (x, z) => x >= 0 && z >= 0 && x < MAP_X && z < MAP_Z;
    const out = [];
    const put = (d, x, z, r = 0) => {
        if (!inMap(x, z) || taken.has(key(x, z))) return false;
        taken.add(key(x, z));
        out.push({ d, x, y: 0, z, r });
        return true;
    };

    // Crowds face the road from both sides of every start and finish on the ground.
    if (crowds) {
        for (const b of track.blocks) {
            const gate = BLOCKS[b.b].gate;
            if (!gate || gate === 'checkpoint' || b.y !== 0) continue;
            for (const side of [1, 3]) {
                const s = DIRS[(b.r + side) & 3];
                const facing = (b.r + side + 2) & 3;
                put('PenguinCrowd', b.x + s[0], b.z + s[2], facing);
                if (rng.chance(0.6)) put('PenguinCrowd', b.x + s[0] * 2, b.z + s[2] * 2, facing);
                const f = DIRS[b.r];
                put(gate === 'start' ? 'Banner' : 'PenguinCrowd', b.x + s[0] + f[0], b.z + s[2] + f[2], facing);
            }
        }
    }

    // Lamps line the ground-level road.
    if (lamps > 0) {
        let n = 0;
        for (const [x, z, b] of road) {
            if (b.y !== 0 || n++ % lamps) continue;
            const s = DIRS[(b.r + 1 + 2 * rng.int(2)) & 3];
            put('Lamp', x + s[0], z + s[2], b.r);
        }
    }

    // Scatter: every free cell within the ring around the road, in a fixed order.
    const ring = new Map();
    for (const [x, z] of road) {
        for (let dx = -far; dx <= far; dx++) {
            for (let dz = -far; dz <= far; dz++) {
                const dist = Math.max(Math.abs(dx), Math.abs(dz));
                if (dist < near || !inMap(x + dx, z + dz)) continue;
                const k = key(x + dx, z + dz);
                if (!ring.has(k) || ring.get(k) > dist) ring.set(k, dist);
            }
        }
    }
    const entries = Object.entries(kinds).filter(([, w]) => w > 0);
    const total = entries.reduce((a, [, w]) => a + w, 0);
    const cells = [...ring.keys()].sort((a, b) => a - b);
    for (const k of cells) {
        if (taken.has(k)) continue;
        const x = Math.floor(k / 64), z = k % 64;
        // Thicker close to the road, thinning out with distance.
        const p = density * (1 - (ring.get(k) - near) / (far - near + 2));
        if (!rng.chance(p) || !total) continue;
        let pick = rng.next() * total, kind = entries[0][0];
        for (const [d, w] of entries) {
            pick -= w;
            if (pick < 0) { kind = d; break; }
        }
        put(kind, x, z, rng.int(4));
    }
    return out;
}
