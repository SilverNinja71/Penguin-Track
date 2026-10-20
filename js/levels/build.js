// Turns an official track spec into track JSON: the path builder, then
// `fill` areas (snowfields widened around the path), then seeded scenery.
//
// spec.fill = [{ b: 'Platform', from: [x0, y, z0], to: [x1, y, z1], r = 0, s }]
// places block `b` on every cell of the rectangle whose footprint is still free
// (cells the path already uses are skipped), so a path through a field gets
// borderless neighbours on both sides.
import { trackFromPath, normalizeTrack } from '../core/track.js';
import { BLOCKS, footprintSize } from '../core/blocks.js';
import { scenery } from './scenery.js';

export const AUTHOR = 'Penguintrack';

function occupancy(blocks) {
    const occ = new Set();
    for (const b of blocks) {
        const [W, H, D] = footprintSize(BLOCKS[b.b], b.r);
        for (let x = b.x; x < b.x + W; x++)
            for (let y = b.y; y < b.y + H; y++)
                for (let z = b.z; z < b.z + D; z++) occ.add(`${x},${y},${z}`);
    }
    return occ;
}

function fillBlocks(blocks, fills) {
    const occ = occupancy(blocks);
    const out = [];
    for (const f of fills) {
        const def = BLOCKS[f.b];
        if (!def) throw new Error(`fill: unknown block '${f.b}'`);
        const r = f.r || 0;
        const [W, H, D] = footprintSize(def, r);
        const [x0, y, z0] = f.from, [x1, , z1] = f.to;
        for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x += W) {
            for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z += D) {
                let free = true;
                for (let dx = 0; dx < W && free; dx++)
                    for (let dy = 0; dy < H && free; dy++)
                        for (let dz = 0; dz < D && free; dz++) if (occ.has(`${x + dx},${y + dy},${z + dz}`)) free = false;
                if (!free) continue;
                const blk = { b: f.b, x, y, z, r, s: f.s || def.defaultSurface };
                for (let dx = 0; dx < W; dx++)
                    for (let dy = 0; dy < H; dy++)
                        for (let dz = 0; dz < D; dz++) occ.add(`${x + dx},${y + dy},${z + dz}`);
                out.push(blk);
            }
        }
    }
    return out;
}

/**
 * Track JSON for an official spec. opts: { medals, scenery (options for
 * scenery(), or null for none) }.
 */
export function buildOfficial(spec, opts = {}) {
    const track = trackFromPath({ author: AUTHOR, ...spec, medals: opts.medals || spec.medals });
    if (spec.fill && spec.fill.length) {
        const extra = fillBlocks(track.blocks, spec.fill);
        return finish(normalizeTrack({ ...track, blocks: track.blocks.concat(extra) }), opts);
    }
    return finish(track, opts);
}

function finish(track, opts) {
    if (opts.scenery) track.decor.push(...scenery(track, opts.scenery));
    return track;
}
