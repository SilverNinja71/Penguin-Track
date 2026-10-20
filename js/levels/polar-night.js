// Polar Night (black tier): long, hard runs that use everything; E03 is a
// multilap circuit and E05 the grand finale.
export const POLAR_NIGHT = [
    {
        id: 'E01', name: 'Whiteout Wastes', mood: 'night',
        description: 'Powder plains, ice tunnels and open snowfields in a whiteout. Read the road before it reads you.',
        start: [44, 0, 4, 1],
        pieces: [
            'Start', 'Straight*2', 'Straight*3:powder', 'Turn3L:powder', 'Straight:powder', 'Checkpoint:powder',
            'Straight*2:ice', 'Tunnel*3', 'Turn2R', 'Checkpoint', 'SlopeUp2', 'Platform*2', 'PlatformL', 'Platform',
            'PlatformRampDown', 'Straight', 'Checkpoint', 'Loop', 'Straight', 'Turn3L', 'Straight*2:powder', 'RampSmall',
            'Gap', 'Straight*2:powder', 'Checkpoint:powder', 'Bank3R', 'Straight*2:ice', 'Straight', 'Turn2R', 'Tunnel*2',
            'Checkpoint', 'SlopeUp2', 'Straight', 'Bank2L', 'Straight', 'Checkpoint', 'SlopeDown2', 'Straight:powder',
            'Turn2R:powder', 'Straight*2', 'Turn3L', 'Straight*2', 'Finish', 'Straight*2',
        ],
    },
    {
        id: 'E02', name: 'Frostfire Ridge', mood: 'night',
        description: 'Climb onto the ridge, thread the narrow crest, loop the blizzard loop and ski-jump back to the valley.',
        start: [16, 0, 46, 1],
        pieces: [
            'Start', 'Straight*3', 'Turbo', 'Straight*5', 'Bank3R', 'Checkpoint', 'Straight', 'SlopeBigUp', 'Straight', 'SlopeBigUp',
            'Straight', 'Checkpoint', 'Narrow*2', 'Straight',
            'Bank3R', 'Straight', 'Checkpoint', 'Loop', 'Straight*2', 'Turn2L', 'Narrow', 'Straight', 'Checkpoint',
            'SlopeBigUp', 'Straight*2:ice', 'Bank2R', 'Checkpoint:ice', 'Straight*3', 'RampBig', 'Gap*2', 'Up',
            'SlopeBigDown', 'Straight*2', 'Checkpoint', 'Turn3R', 'SlopeBigDown', 'Straight*2', 'Bank3R', 'SlopeBigDown',
            'Straight', 'Checkpoint', 'SlopeDown2', 'Straight', 'RampSmall', 'Gap', 'Straight*4', 'Finish', 'Straight*2',
        ],
    },
    {
        id: 'E03', name: 'Aurora Ring', mood: 'aurora', laps: 2,
        description: 'Two laps of a figure eight under the aurora: over the high bridge, through the ice tunnel, round the loop.',
        start: [16, 0, 24, 3],
        pieces: [
            // Low road east, passing under the bridge.
            'StartFinish', 'Straight*4', 'Checkpoint', 'Straight*3', 'Bank3L', 'Straight', 'SlopeUp2', 'Straight',
            'Bank2L', 'Straight*2', 'Turn2L',
            // The bridge: two levels up, straight over the low road.
            'SlopeUp2', 'Straight', 'Checkpoint', 'Straight*3', 'SlopeDown2', 'Straight', 'SlopeDown2', 'Straight',
            'Turn3R', 'Tunnel*2:ice', 'Checkpoint', 'RampSmall', 'Gap', 'Straight*3', 'Turn3R', 'Checkpoint',
            'Loop', 'Straight', 'Turn3R', 'Straight*3',
        ],
    },
    {
        id: 'E04', name: 'Permafrost Gauntlet', mood: 'night',
        description: 'Every effect the glacier knows, back to back. Thaw pads are your only friends.',
        start: [4, 0, 4, 0],
        pieces: [
            'Start', 'Straight', 'Turbo2', 'Straight*3', 'Turn3L', 'Straight', 'Checkpoint', 'NoSteer', 'Straight*2',
            'RampSmall', 'Gap', 'Straight*2', 'Reset', 'Turn2R', 'Checkpoint', 'Cruise', 'Bank3L', 'Straight', 'Bank3R',
            'Reset', 'Checkpoint', 'Straight', 'SlopeUp2', 'Fragile', 'Straight', 'Turn2L', 'Straight', 'Tunnel*2', 'Reset',
            'Checkpoint', 'SlopeUp2', 'NoEngine', 'Straight', 'SlopeDown2', 'Straight*2', 'Reset', 'Turn3R', 'Straight',
            'Checkpoint', 'SlowMo', 'Straight', 'RampBig', 'Gap*2', 'Up', 'SlopeBigDown', 'Reset', 'Checkpoint',
            'NoBrake', 'Bank3R', 'Reset', 'Straight', 'Checkpoint', 'NoSteer', 'Straight', 'Loop', 'Straight', 'Reset',
            'Straight', 'Turn3R', 'Straight*2', 'Finish', 'Straight*2',
        ],
    },
    {
        id: 'E05', name: "Emperor's Crown", mood: 'aurora',
        description: 'The grand finale: from the crown of the glacier down through every trick the snow can play.',
        start: [44, 10, 44, 2],
        pieces: [
            'Start', 'Straight', 'Turbo2', 'Straight*2', 'SlopeBigDown', 'Straight', 'Bank3L', 'Straight', 'Checkpoint',
            'Loop', 'Straight*2', 'SlopeBigDown', 'Straight', 'Turn2R', 'Checkpoint', 'RampBig', 'Gap*2', 'Up',
            'SlopeBigDown', 'Straight*3', 'Checkpoint', 'Bank3L', 'Straight:ice', 'SlopeDown2:ice', 'Straight*2:ice',
            'Turn3R', 'Checkpoint', 'Narrow*2', 'Straight', 'SlopeBigDown', 'Straight', 'Bank2R', 'Tunnel*3', 'Checkpoint',
            'Cruise', 'Straight', 'Bank3L', 'Straight', 'Reset', 'Turn2R:powder', 'Straight*2:powder', 'Checkpoint:powder',
            'Turn2R:powder', 'LoopL', 'Checkpoint', 'Turbo', 'Straight*2', 'RampSmall', 'Gap', 'Straight*3', 'Checkpoint',
            'Bank3R', 'Straight*2', 'SlopeDown2', 'Straight', 'SlopeDown2', 'Checkpoint', 'Straight', 'Turn2L', 'Straight*3',
            'Turn2R', 'Straight*2', 'Finish', 'Straight*2',
        ],
    },
];
