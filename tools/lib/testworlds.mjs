// Synthetic worlds for physics tests and the sim probe: an endless flat field
// of one surface, optionally with a long wall, shaped like buildWorld's output.
import { CollisionMesh } from '../../js/core/collision.js';
import { SURFACE_INDEX, FALL_Y } from '../../js/core/constants.js';

/**
 * Flat field at height y spanning [-half, half] in X and Z. The car spawns at
 * z = -half + 100 facing +Z. wallX (optional) adds a 3 m high wall along Z at
 * that x (the car's right-hand side is -X).
 */
export function flatWorld({ surface = 'snow', half = 3000, y = 0, wallX = null } = {}) {
    const s = SURFACE_INDEX[surface];
    const tris = [
        [-half, y, -half], [-half, y, half], [half, y, half],
        [-half, y, -half], [half, y, half], [half, y, -half],
    ];
    const surf = [s, s];
    if (wallX !== null) {
        const a = [wallX, y - 1, -half], b = [wallX, y + 3, -half], c = [wallX, y + 3, half], d = [wallX, y - 1, half];
        tris.push(a, b, c, a, c, d);
        surf.push(SURFACE_INDEX.wall, SURFACE_INDEX.wall);
    }
    const positions = new Float64Array(tris.length * 3);
    tris.forEach((p, i) => positions.set(p, i * 3));
    const collision = new CollisionMesh(positions, Uint8Array.from(surf), {});
    return {
        collision,
        triggers: [],
        checkpointCount: 0,
        spawn: { pos: [0, y, -half + 100], dir: 0, quat: [0, 0, 0, 1] },
        route: null,
        laps: 1,
        mode: 'race',
        fallY: FALL_Y,
    };
}

/** Adds an axis-aligned trigger box to a synthetic world (returns the trigger). */
export function addTrigger(world, trg) {
    const t = { index: world.triggers.length, id: 0, ...trg };
    t.center = [(t.min[0] + t.max[0]) / 2, (t.min[1] + t.max[1]) / 2, (t.min[2] + t.max[2]) / 2];
    if (t.type === 'checkpoint') t.id = world.checkpointCount++;
    world.triggers.push(t);
    return t;
}
