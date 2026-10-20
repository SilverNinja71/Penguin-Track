// Fresh Powder (white tier): five short, friendly tracks, one mechanic each.
export const FRESH_POWDER = [
    {
        id: 'A01', name: 'First Flakes', mood: 'day',
        description: 'Packed snow, wide sweepers and a gentle hill. Hold the gas and steer.',
        start: [8, 0, 4, 0],
        pieces: [
            { d: 'PenguinCrowd', side: 'left' }, { d: 'Banner', side: 'right' },
            'Start', 'Straight*3', { d: 'Pine', side: 'left' }, { d: 'Pine', side: 'right', dist: 2 },
            'Straight*2', 'Turn3L', 'Straight*2', { d: 'Igloo', side: 'right' }, 'Checkpoint', 'SlopeUp2', 'Straight*2',
            'SlopeDown2', { d: 'Snowman', side: 'left' }, 'Straight*2', 'Turn3R', 'Straight*3', 'Checkpoint',
            'Straight*2', { d: 'Pine', side: 'left' }, 'Turn3R', 'Straight*2', 'Turn3L', 'Straight*3', { d: 'PenguinCrowd', side: 'left' },
            { d: 'PenguinCrowd', side: 'right' }, 'Finish', 'Straight*2',
        ],
    },
    {
        id: 'A02', name: 'Mitten Curves', mood: 'day',
        description: 'Every size of bend. Lift or brake before the tight igloo hairpins.',
        start: [4, 0, 14, 3],
        pieces: [
            'Start', 'Straight*3', 'Turn2R', 'Straight', 'Turn2L', 'Straight*2', 'Checkpoint', 'Straight',
            'Turn1R', 'Straight*2', 'Turn1R', 'Straight*3', 'Turn2L', 'Checkpoint', 'Straight*2', 'Turn3R',
            'Straight', 'Turn2L', 'Straight*2', 'Finish', 'Straight*2',
        ],
    },
    {
        id: 'A03', name: 'Sledhill Rise', mood: 'sunset',
        description: 'Up the hill and down again: slopes, crests and a bridge on pillars.',
        start: [30, 0, 4, 0],
        pieces: [
            'Start', 'Straight*2', 'SlopeUp2', 'Straight', 'SlopeBigUp', 'Straight*2', 'Checkpoint', 'Turn2R',
            'Straight', 'SlopeDown1', 'Straight*2', 'SlopeDown2', 'Turn3L', 'Straight', 'Checkpoint', 'SlopeBigUp',
            'Straight*2', 'Turn2L', 'SlopeBigDown', 'Straight', 'SlopeDown2', 'Straight', 'Finish', 'Straight*2',
        ],
    },
    {
        id: 'A04', name: 'Frostbite Express', mood: 'day',
        description: 'Frost Boost pads: drive over the glowing pads and feel the push.',
        start: [4, 0, 8, 3],
        pieces: [
            'Start', 'Straight', 'Turbo', 'Straight*4', 'Turn3R', 'Straight', 'Checkpoint', 'Turbo', 'SlopeUp2',
            'Straight*2', 'SlopeDown2', 'Turn3L', 'Straight', 'Checkpoint', 'Straight', 'Turbo', 'Straight*3',
            'Turn3L', 'Straight', 'Turbo', 'Straight*2', 'Finish', 'Straight*2',
        ],
    },
    {
        id: 'A05', name: 'Skating Pond', mood: 'night',
        description: 'Your first ice: smooth hands, early lines, and no sudden steering.',
        start: [8, 0, 36, 2],
        pieces: [
            'Start', 'Straight*3', 'Straight*3:ice', 'Straight', 'Turn2R', 'Straight', 'Checkpoint',
            'Straight*2:ice', 'Turn3R:ice', 'Straight*2:ice', 'Straight', 'Checkpoint', 'Turn2L', 'Straight*2:ice',
            'Turn3L:ice', 'Straight*2', 'Finish', 'Straight*2',
        ],
    },
];
