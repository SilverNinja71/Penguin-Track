// Pine Forest (green tier): powder, banks, jumps, tunnels and checkpoint flow.
export const PINE_FOREST = [
    {
        id: 'B01', name: 'Pinecone Powder', mood: 'sunset',
        description: 'Loose powder slides under you: brake with the wheel turned to drift the bends.',
        start: [6, 0, 6, 0],
        pieces: [
            'Start', 'Straight*3', 'Turn3L', 'Straight*2:powder', 'Turn2R:powder', 'Straight:powder', 'Checkpoint:powder',
            'Turn2L:powder', 'Straight*2', 'SlopeUp2', 'Straight', 'SlopeDown2', 'Straight', 'Turn3R:powder', 'Straight*3:powder',
            'Checkpoint', 'Straight', 'Turn2R:powder', 'Straight:powder', 'Turn2L:powder', 'SlopeUp2', 'SlopeDown2',
            'Straight*2', 'Finish', 'Straight*2',
        ],
    },
    {
        id: 'B02', name: 'Banked Hollow', mood: 'day',
        description: 'Lean into the banked drifts: the snow wall holds you at full speed.',
        start: [4, 0, 30, 3],
        pieces: [
            'Start', 'Straight*4', 'Bank3L', 'Straight*2', 'Checkpoint', 'SlopeUp2', 'Bank3R', 'Straight', 'Bank2R',
            'Straight', 'SlopeDown2', 'Straight*2', 'Bank3L', 'Straight', 'Checkpoint', 'Bank2L', 'Straight*2',
            'Bank2R', 'Straight*2', 'Bank3R', 'Straight*3', 'Finish', 'Straight*2',
        ],
    },
    {
        id: 'B03', name: 'Kicker Glade', mood: 'day',
        description: 'Snow kickers and a ski jump through the glade. Land straight and keep the gas in.',
        start: [4, 0, 8, 3],
        pieces: [
            'Start', 'Straight*3', 'RampSmall', 'Gap', 'Straight*3', 'Checkpoint', 'Straight', 'Turn3R', 'Straight*2',
            'RampSmall', 'Gap', 'Straight*3', 'Turn2L', 'Straight', 'Checkpoint', 'SlopeUp2', 'Straight', 'RampBig', 'Gap*3',
            'Up', 'SlopeBigDown', 'Straight*3', 'Turn3R', 'Straight*2', 'Finish', 'Straight*2',
        ],
    },
    {
        id: 'B04', name: 'Timber Tunnel', mood: 'night',
        description: 'Through the frozen tunnels and over the ridge: carry your speed in the dark.',
        start: [40, 0, 4, 1],
        pieces: [
            'Start', 'Straight*2', 'Tunnel*4', 'Turn3L', 'Straight', 'Checkpoint', 'SlopeUp2', 'Straight', 'Turn2R',
            'Straight*2', 'SlopeDown2', 'Tunnel*2', 'Checkpoint', 'Turn2L', 'Straight', 'Tunnel*3', 'Turn3L', 'Checkpoint',
            'SlopeUp2', 'SlopeUp2', 'Turn2L', 'Straight*8', 'SlopeDown2', 'SlopeDown2', 'Checkpoint',
            'Straight*3', 'Turn3R', 'Tunnel*2', 'Straight', 'Finish', 'Straight*2',
        ],
    },
    {
        id: 'B05', name: 'Evergreen Relay', mood: 'sunset',
        description: 'A flowing run through the forest with a checkpoint at every clearing.',
        start: [4, 0, 4, 0],
        pieces: [
            'Start', 'Straight*3', 'Turn2L', 'Straight*2', 'SlopeUp2', 'Checkpoint', 'Straight', 'Bank3R', 'Straight*2',
            'RampSmall', 'Gap', 'Straight*2', 'Turn2R:powder', 'Straight:powder', 'Checkpoint:powder', 'Turn2L:powder',
            'Straight', 'Tunnel*3', 'Turn3L', 'Straight', 'SlopeDown2', 'Straight', 'Checkpoint', 'Bank2R', 'Straight*2',
            'Turn2R:powder', 'Turn2L:powder', 'Straight', 'Turn3R', 'Straight*2', 'Finish', 'Straight*2',
        ],
    },
];
