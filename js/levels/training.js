// Training (for the AI lab and TAS): short, clean routes, one skill each.
export const TRAINING = [
    {
        id: 'T01', name: 'Oval', mood: 'day', laps: 2,
        description: 'Two straights and two sweepers. The classic first lesson for a learning driver.',
        start: [16, 0, 10, 3],
        pieces: [
            'StartFinish', 'Straight*5', 'Turn3R', 'Turn3R', 'Straight*3', 'Checkpoint', 'Straight*3', 'Turn3R', 'Turn3R',
            'Straight',
        ],
    },
    {
        id: 'T02', name: 'Figure Eight', mood: 'day', laps: 2,
        description: 'Two loops joined at a snow crossing: left turns, right turns and a crossroads.',
        start: [20, 0, 14, 0],
        pieces: [
            // Loop A turns left three times and comes back across the crossing; loop B turns right.
            // Checkpoint A sits right after the crossing, so the shortest legal lap is the figure eight.
            'StartFinish', 'Straight*2', 'Cross', 'Checkpoint', 'Straight', 'Turn3L', 'Straight*2', 'Turn3L', 'Turn3L',
            'Straight*4', 'Gap', 'Straight*2', 'Turn3R', 'Checkpoint', 'Straight', 'Turn3R', 'Turn3R', 'Straight',
        ],
    },
    {
        id: 'T03', name: 'Slalom', mood: 'day',
        description: 'Left, right, left, right: a chain of bends with no time to settle.',
        start: [6, 0, 4, 0],
        pieces: [
            'Start', 'Straight*2', 'Turn2L', 'Turn2R', 'Straight', 'Turn2R', 'Turn2L', 'Straight', 'Checkpoint',
            'Turn2L', 'Turn2R', 'Straight', 'Turn2R', 'Turn2L', 'Straight', 'Finish', 'Straight*2',
        ],
    },
    {
        id: 'T04', name: 'Ice Rink', mood: 'night', laps: 2,
        description: 'A closed ice circuit: smooth inputs, early turn-in and patience on the throttle.',
        start: [16, 0, 10, 3],
        surface: 'ice',
        pieces: [
            'StartFinish', 'Straight*2', 'Turn2R', 'Turn2R', 'Straight*2', 'Checkpoint', 'Straight', 'Turn2R', 'Turn2R',
            'Straight',
        ],
    },
    {
        id: 'T05', name: 'Jump Lab', mood: 'sunset',
        description: 'Kickers, a ski jump and a drop: learn when to lift and how to land.',
        start: [6, 0, 4, 0],
        pieces: [
            'Start', 'Straight*3', 'RampSmall', 'Gap', 'Straight*3', 'Checkpoint', 'Straight', 'RampSmall', 'Gap*2',
            'Straight*2', 'Checkpoint', 'Straight', 'Turn3L', 'SlopeUp2', 'Straight', 'RampBig', 'Gap*3', 'Up',
            'SlopeBigDown', 'Straight*4', 'Finish', 'Straight*2',
        ],
    },
];
