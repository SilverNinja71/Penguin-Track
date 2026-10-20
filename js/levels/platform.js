// Platform: fewest respawns wins, then time. Precision over speed: snowfields
// without walls, narrow ridges, ice floes and drops, with frequent checkpoints.
export const PLATFORM = [
    {
        id: 'P01', name: 'Penguin Steps', mood: 'day', mode: 'platform',
        description: 'Climb the snowfield steps without slipping off the edges.',
        start: [10, 0, 4, 0],
        pieces: [
            'Start', 'Straight*2', 'Platform*2', 'PlatformRampUp', 'Platform*2', 'Checkpoint', 'Straight', 'PlatformRampUp',
            'Platform*2', 'PlatformL', 'Platform', 'Checkpoint', 'Narrow*2', 'Platform', 'PlatformR', 'Platform',
            'Checkpoint', 'Platform', 'PlatformRampDown', 'Platform', 'PlatformRampDown', 'Straight', 'Finish', 'Straight*2',
        ],
        fill: [
            { b: 'Platform', from: [9, 0, 7], to: [11, 0, 8] },
            { b: 'PlatformRamp', from: [9, 0, 9], to: [11, 0, 9] },
            { b: 'Platform', from: [9, 1, 10], to: [11, 1, 11] },
        ],
    },
    {
        id: 'P02', name: 'Narrow Ridges', mood: 'sunset', mode: 'platform',
        description: 'Knife-edge ridges high above the snow. Small inputs, steady speed.',
        start: [6, 0, 6, 3],
        pieces: [
            'Start', 'Straight', 'SlopeUp2', 'SlopeUp2', 'Checkpoint', 'Narrow*2', 'Turn2R', 'Checkpoint', 'Narrow*2',
            'Turn2L', 'Narrow', 'Checkpoint', 'Straight', 'SlopeUp2', 'Straight*2', 'Narrow*2', 'Turn1R', 'Checkpoint', 'Narrow*2',
            'Turn1R', 'Narrow', 'Checkpoint', 'SlopeDown2', 'SlopeDown2', 'SlopeDown2', 'Straight', 'Finish', 'Straight*2',
        ],
    },
    {
        id: 'P03', name: 'Ice Floe Hop', mood: 'night', mode: 'platform',
        description: 'Hop from floe to floe: kickers, drops and slippery landings.',
        start: [20, 0, 4, 0],
        pieces: [
            'Start', 'Straight*2', 'SlopeUp2', 'SlopeUp2', 'Checkpoint', 'Platform:ice', 'Down', 'Platform*2:ice',
            'Checkpoint', 'Straight', 'RampSmall', 'Gap', 'Platform*3:ice', 'Straight', 'Turn2R', 'Checkpoint', 'Platform*2',
            'Down', 'Platform:ice', 'Platform', 'Checkpoint', 'Straight*2', 'RampSmall', 'Gap', 'Straight*2:ice',
            'Checkpoint', 'Turn2L', 'Straight', 'Finish', 'Straight*2',
        ],
    },
    {
        id: 'P04', name: 'Glacier Stairs', mood: 'aurora', mode: 'platform',
        description: 'Up the frozen stairway and back down by the drops.',
        start: [6, 0, 6, 3],
        pieces: [
            'Start', 'Straight', 'PlatformRampUp', 'Platform', 'PlatformRampUp', 'Platform', 'Checkpoint', 'PlatformRampUp',
            'Platform', 'PlatformRampUp', 'Platform', 'Checkpoint', 'PlatformR', 'Narrow', 'Platform', 'Checkpoint',
            'Platform', 'Down', 'Platform', 'Down', 'Platform', 'Checkpoint', 'PlatformR', 'Platform', 'Down', 'Platform',
            'Down', 'Platform', 'Straight*2', 'Finish', 'Straight*2',
        ],
    },
    {
        id: 'P05', name: 'Summit Scramble', mood: 'day', mode: 'platform',
        description: 'The final scramble: ridges, floes, kickers and drops, ending on the high snowfield.',
        start: [12, 0, 4, 0],
        pieces: [
            'Start', 'Straight*2', 'SlopeUp2', 'SlopeUp2', 'Checkpoint', 'Narrow*2', 'Platform', 'PlatformL',
            'Checkpoint', 'PlatformRampUp', 'Platform*2:ice', 'Checkpoint', 'Narrow', 'Platform', 'PlatformR', 'Platform',
            'Checkpoint', 'Straight', 'RampSmall', 'Gap', 'Platform*2', 'Checkpoint', 'Platform', 'Down', 'Platform*2',
            'PlatformR', 'Checkpoint', 'Narrow*2', 'Platform:ice', 'Down', 'Platform', 'Checkpoint', 'Straight',
            'Turn2L', 'Narrow*2', 'Platform', 'PlatformRampUp', 'Platform:ice', 'Checkpoint', 'Straight', 'RampSmall', 'Gap',
            'Platform*3', 'Straight', 'Finish', 'Straight',
        ],
    },
];
