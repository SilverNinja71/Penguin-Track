// Development fixtures: small tracks that together use every block. Tests,
// the world viewer and the physics/autopilot work run against these; the
// official campaign lives in js/levels.
import { trackFromPath } from './track.js';

export const SAMPLE_SPECS = [
    {
        id: 'S01', name: 'Frosty Oval', author: 'Penguintrack dev', mood: 'day',
        // Flat: every turn size, both directions.
        start: [6, 0, 4, 3],
        pieces: [
            'Start', 'Straight*3', 'Turn3R', 'Checkpoint', 'Straight*2', 'Turn2R', 'Straight*2',
            'Turn1L', 'Straight', 'Turn2L', 'Checkpoint', 'Straight*3', 'Turn3L', 'Straight*4',
            'Turn1R', 'Finish',
        ],
        decor: [{ d: 'Pine', x: 8, y: 0, z: 7 }, { d: 'Pine', x: 14, y: 0, z: 9 }, { d: 'Igloo', x: 4, y: 0, z: 8 }],
    },
    {
        id: 'S02', name: 'Snowdrift Hills', author: 'Penguintrack dev', mood: 'sunset',
        // Slopes, banks, a mogul, an elevated narrow ridge and a tunnel.
        start: [4, 0, 4, 0],
        pieces: [
            'Start', 'Straight', 'SlopeUp2', 'Bump', 'SlopeUp1', 'Bank3L', 'Checkpoint', 'Narrow',
            'Straight', 'SlopeDown1', 'Tunnel*2', 'Bank2R', 'Checkpoint', 'SlopeDown2', 'Straight*2',
            'SlopeBigUp', 'Turn1L', 'SlopeBigDown', 'Finish',
        ],
    },
    {
        id: 'S03', name: 'Penguin Air Show', author: 'Penguintrack dev', mood: 'aurora',
        // Loops both ways, a ski jump onto an elevated landing and a small kicker gap.
        start: [10, 0, 2, 0],
        pieces: [
            'Start', 'Straight*2', 'Turbo', 'Straight', 'Loop', 'Straight*2', 'Checkpoint', 'Straight',
            'RampBig', 'Gap*2', 'Up', 'Straight', 'SlopeDown2', 'Straight*2', 'Checkpoint',
            'RampSmall', 'Gap', 'Straight*2', 'Turn2L', 'Straight', 'LoopL', 'Straight', 'Finish',
        ],
    },
    {
        id: 'S04', name: 'Special Delivery', author: 'Penguintrack dev', mood: 'day',
        // Every special pad once, with checkpoints in between. Frozen Engine / Wheel /
        // Brakes, Snow Globe, Glide and Thin Ice last until a Thaw (Reset) pad.
        start: [20, 0, 1, 0],
        pieces: [
            'Start', 'Straight', 'Turbo', 'Straight*2', 'Turbo2', 'Straight*2', 'Checkpoint',
            'NoEngine', 'Straight*2', 'Reset', 'Straight', 'NoSteer', 'Straight*2', 'Reset', 'Checkpoint',
            'NoBrake', 'Straight*3', 'Reset', 'Turn2R', 'Straight', 'SlowMo', 'Straight*2', 'Cruise', 'Straight*2',
            'Checkpoint', 'Fragile', 'Straight*2', 'Reset', 'Finish',
        ],
    },
    {
        id: 'S05', name: 'Ice & Powder Run', author: 'Penguintrack dev', mood: 'night',
        // Surface changes, an intersection taken straight and turning, and snowfield platforms.
        start: [4, 0, 20, 3],
        pieces: [
            'Start', 'Straight*2', 'Straight*3:ice', 'Turn2R:ice', 'Straight*2:powder', 'Checkpoint:powder',
            'Turn1L:powder', 'Cross', 'Straight', 'CrossL', 'Straight*2', 'Platform:ice', 'PlatformRampUp',
            'PlatformR:powder', 'Straight', 'Checkpoint', 'SlopeDown1', 'Straight', 'Finish',
        ],
        // Side roads on the crossings, so they look like real junctions.
        extra: [
            { b: 'Straight', x: 12, y: 0, z: 26, r: 0 },
            { b: 'Straight', x: 12, y: 0, z: 24, r: 0 },
            { b: 'Straight', x: 14, y: 0, z: 26, r: 0 },
            { b: 'Straight', x: 15, y: 0, z: 25, r: 1 },
        ],
    },
    {
        id: 'S06', name: 'Igloo Circuit', author: 'Penguintrack dev', mood: 'day', laps: 3,
        // Multilap: the route is one lap from the StartFinish line back to it.
        start: [10, 0, 10, 0],
        pieces: [
            'StartFinish', 'Straight*2', 'Turn2R', 'Straight*2', 'Checkpoint', 'Turn2R', 'Straight*3',
            'Turn2R', 'Straight*2', 'Checkpoint', 'Turn2R',
        ],
        decor: [{ d: 'Pine', x: 7, y: 0, z: 11 }, { d: 'Pine', x: 7, y: 0, z: 12 }, { d: 'Snowman', x: 12, y: 0, z: 11 }],
    },
];

let built = null;

/** All sample tracks (built lazily, cached). */
export function getSamples() {
    if (!built) built = SAMPLE_SPECS.map((s) => trackFromPath(s));
    return built;
}

export function getSample(id) {
    return getSamples().find((t) => t.id === id) || null;
}
