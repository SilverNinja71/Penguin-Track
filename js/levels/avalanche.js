// Avalanche (red tier): technical runs mixing surfaces, big jumps, Avalanche
// Boost and the nastier effects (Brake Freeze, Thin Ice, Snow Globe) with Thaw
// pads to end them; D05 is a multilap circuit.
export const AVALANCHE = [
    {
        id: 'D01', name: 'Avalanche Chute', mood: 'sunset',
        description: 'From the summit igloo, ride the Avalanche Boost down the mountain and fly the ski jump.',
        start: [4, 8, 4, 3],
        pieces: [
            'Start', 'Straight', 'Turbo2', 'Straight*2', 'SlopeBigDown', 'Straight*2', 'Checkpoint', 'Straight', 'Bank3R',
            'Straight', 'SlopeBigDown', 'Straight', 'Checkpoint', 'Turn2L', 'Straight', 'RampBig', 'Gap*2', 'Up',
            'SlopeBigDown', 'Straight*3', 'Checkpoint', 'Bank3R', 'Straight', 'Turbo', 'SlopeBigDown', 'Straight*2',
            'SlopeDown2', 'Checkpoint', 'Straight', 'RampSmall', 'Gap', 'Straight*5', 'Turn3L', 'Straight*2', 'Bank3L',
            'Straight*2', 'Checkpoint', 'Turn2R', 'Straight*2', 'Finish', 'Straight*2',
        ],
    },
    {
        id: 'D02', name: 'Sleet Switchbacks', mood: 'day',
        description: 'Claw up the powder hairpins, then let the ice carry you down the other side.',
        start: [40, 0, 44, 2],
        pieces: [
            'Start', 'Straight', 'Straight:powder', 'SlopeUp2:powder', 'Straight:powder', 'SlopeUp2:powder', 'Straight',
            'Checkpoint', 'Turn2L:powder', 'Turn2L:powder', 'Straight:powder', 'SlopeUp2:powder', 'Checkpoint', 'SlopeUp2',
            'Straight:powder', 'Turn2R:powder', 'Turn2R:powder', 'Straight', 'SlopeUp2', 'Checkpoint', 'Straight', 'SlopeUp2',
            'Straight', 'Turn3L', 'Straight', 'Checkpoint', 'Straight:ice', 'SlopeDown2:ice', 'Straight:ice', 'Bank3L',
            'Checkpoint', 'SlopeBigDown', 'Straight*2:ice', 'Turn3R', 'SlopeBigDown:ice', 'Straight:ice', 'Checkpoint', 'SlopeDown2',
            'Straight', 'Turn2L:powder', 'Straight*2', 'Finish', 'Straight*2',
        ],
    },
    {
        id: 'D03', name: 'Brakeless Descent', mood: 'night',
        description: 'Brake Freeze down the banked bends, then Thin Ice: no walls, no hard landings.',
        start: [4, 4, 40, 2],
        pieces: [
            'Start', 'Straight', 'NoBrake', 'Straight*2', 'SlopeDown2', 'Straight', 'Bank3R', 'Checkpoint', 'SlopeDown2',
            'Straight', 'Bank3L', 'Straight', 'Reset', 'Checkpoint', 'Straight', 'Turn2R', 'Straight', 'Fragile', 'Straight',
            'SlopeDown2', 'Straight*2', 'RampSmall', 'Gap', 'Straight*2', 'Checkpoint', 'Turn3L', 'Straight', 'Reset',
            'SlopeUp2', 'Straight', 'RampBig', 'Gap*3', 'Up', 'SlopeBigDown', 'Straight*2', 'Checkpoint', 'NoBrake',
            'Straight', 'Bank3R', 'Reset', 'Straight*2', 'Turn2R', 'SlopeDown2', 'Straight', 'Finish', 'Straight*2',
        ],
    },
    {
        id: 'D04', name: 'Snow Globe Summit', mood: 'aurora',
        description: 'Inside the Snow Globe time crawls: float the summit jumps, then Thaw and race home.',
        start: [6, 0, 42, 2],
        pieces: [
            'Start', 'Straight*2', 'SlopeBigUp', 'Straight', 'Turn3R', 'SlopeBigUp', 'Straight', 'Checkpoint', 'SlowMo',
            'Straight', 'RampBig', 'Gap*3', 'Up', 'SlopeBigDown', 'Straight', 'Reset', 'Turn2L', 'Straight', 'Checkpoint',
            'SlopeBigUp', 'Straight', 'Bank3L', 'Straight', 'SlowMo', 'RampSmall', 'Gap*2', 'Straight*2', 'Reset',
            'Checkpoint', 'Straight', 'Turn3R', 'SlopeBigDown', 'Straight', 'Checkpoint', 'Turbo', 'Straight*2',
            'SlopeBigDown', 'Straight', 'Turn2R', 'Straight*2', 'Finish', 'Straight*2',
        ],
    },
    {
        id: 'D05', name: 'Iceberg Circuit', mood: 'sunset', laps: 2,
        description: 'Two laps around the iceberg: a banked sweeper, a kicker, an icy back straight and a hill.',
        start: [20, 0, 10, 3],
        pieces: [
            'StartFinish', 'Straight', 'Bank3R', 'Straight', 'Checkpoint', 'RampSmall', 'Gap', 'Straight*2',
            'Turn3R', 'Straight*3:ice', 'Straight', 'Turn2R', 'SlopeUp2', 'Checkpoint', 'SlopeDown2',
            'Straight*3', 'Turn2R', 'Straight*2',
        ],
    },
];
