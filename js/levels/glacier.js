// Glacier (blue tier): ice, loops, snowfields and the first lasting effects.
export const GLACIER = [
    {
        id: 'C01', name: 'Crevasse Run', mood: 'day',
        description: 'Long ice slabs between packed-snow braking zones. Brake before the ice, not on it.',
        start: [6, 0, 44, 2],
        pieces: [
            'Start', 'Straight*2', 'Straight*4:ice', 'Checkpoint', 'Turn3R:ice', 'Straight*2', 'Straight*2:ice',
            'SlopeUp2:ice', 'Straight:ice', 'Checkpoint:ice', 'SlopeDown2:ice', 'Straight*2', 'Turn2L', 'Straight',
            'Straight*3:ice', 'Turn3R:ice', 'Checkpoint:ice', 'Straight*2:ice', 'Turn2R', 'Straight*2:ice', 'Checkpoint',
            'Straight*3:ice', 'Turn3L:ice', 'Straight*2', 'Finish', 'Straight*2',
        ],
    },
    {
        id: 'C02', name: 'Looping Floes', mood: 'aurora',
        description: 'Blizzard loops under the aurora. Keep the gas in and let the loop carry you.',
        start: [4, 0, 6, 3],
        pieces: [
            'Start', 'Straight*3', 'Loop', 'Straight*2', 'Checkpoint', 'Straight', 'Turn3R', 'Straight*2', 'LoopL',
            'Straight*2', 'Turn2L', 'Straight', 'Checkpoint', 'SlopeUp2', 'Straight', 'Loop:ice', 'Straight', 'SlopeDown2',
            'Turn3R', 'Straight', 'Checkpoint', 'Straight*2', 'LoopL', 'Straight*2', 'Turn2R', 'Straight', 'Checkpoint',
            'Straight*2:ice', 'LoopL:ice', 'Straight*2', 'Finish', 'Straight*2',
        ],
    },
    {
        id: 'C03', name: 'Snowfield Steps', mood: 'sunset',
        description: 'Open snowfields without walls, stepping up the glacier. Mind the edges.',
        start: [14, 0, 4, 0],
        pieces: [
            'Start', 'Straight*3', 'Platform*2', 'PlatformRampUp', 'Platform*3', 'PlatformL', 'Platform', 'Checkpoint',
            'Straight*2', 'Cross', 'Straight*2', 'Turn2R', 'Checkpoint', 'PlatformRampUp', 'Platform*2', 'PlatformR',
            'Platform*2', 'Checkpoint', 'Straight*2', 'PlatformRampDown', 'PlatformRampDown', 'Straight', 'Turn2L',
            'Straight', 'Cross', 'Straight', 'Checkpoint', 'Turn3R', 'Straight', 'Platform', 'PlatformL:powder', 'Platform:ice',
            'Straight', 'Turn2R', 'Straight*2', 'Finish', 'Straight*2',
        ],
        fill: [
            { b: 'Platform', from: [13, 0, 8], to: [15, 0, 9] },
            { b: 'PlatformRamp', from: [13, 0, 10], to: [15, 0, 10] },
            { b: 'Platform', from: [13, 1, 11], to: [15, 1, 15] },
        ],
    },
    {
        id: 'C04', name: 'Frozen Wheel Pass', mood: 'night',
        description: 'Frozen Wheel pads lock your steering until the next Thaw. Line up before you hit them.',
        start: [6, 0, 4, 0],
        pieces: [
            'Start', 'Straight*3', 'Turn3L', 'Straight', 'Checkpoint', 'Straight', 'NoSteer', 'Straight*2', 'RampSmall',
            'Gap', 'Straight*3', 'Reset', 'Turn3R', 'Straight*2:ice', 'Checkpoint', 'Straight', 'SlopeUp2', 'Turn2R',
            'NoSteer:ice', 'Straight*3:ice', 'Reset', 'Turn2L', 'SlopeDown2', 'Straight', 'Checkpoint', 'Turn3L',
            'NoSteer', 'Straight*2', 'Straight*2:ice', 'Reset', 'Turn3R', 'Straight*2', 'Finish', 'Straight*2',
        ],
    },
    {
        id: 'C05', name: 'Glide Glacier', mood: 'day',
        description: 'Glide pads freeze your speed: choose it well, then steer the banked sweepers.',
        start: [4, 0, 40, 2],
        pieces: [
            'Start', 'Straight*4', 'Turn3R', 'Straight', 'Checkpoint', 'Cruise', 'Straight*2', 'Bank3L', 'Straight*2',
            'Bank3R', 'Reset', 'Straight', 'Checkpoint', 'Turn2L', 'Straight*2:ice', 'SlopeUp2', 'Cruise', 'Bank2R',
            'Checkpoint', 'Bank3R', 'Straight*2', 'Reset', 'SlopeDown2', 'Straight', 'Turn2L', 'Straight*3', 'Turn3L',
            'Straight*2', 'Checkpoint', 'Straight', 'Turbo', 'Straight*4', 'Turn3R', 'Straight*2', 'Finish', 'Straight*2',
        ],
    },
];
