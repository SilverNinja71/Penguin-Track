// Gentle generative menu music: a sparse music-box melody over a soft pad and a
// low bass in D major pentatonic, with an occasional shaker and wind-chime
// glissando. MusicBox only decides notes and schedules them on the bus at
// given AudioContext times; the engine pumps it a little ahead of the clock,
// and the dev checks render it offline.
import { Rng } from '../core/rng.js';
import { musicBox, tone, noiseBurst, voiceOut, envAHR, filter, midiHz } from './synth.js';

export const BPM = 72;
export const STEP = 60 / BPM / 2;           // one eighth note
const STEPS_PER_CHORD = 16;                 // two bars
const MELODY = [74, 76, 78, 81, 83, 86, 88, 90, 93];   // D5 .. A6, pentatonic

// Dadd9, Bm7, Gmaj7, Asus2: tones (pitch classes) the melody leans on at bar starts.
const CHORDS = [
    { bass: 50, pad: [62, 66, 69, 76], tones: [2, 6, 9, 4] },
    { bass: 47, pad: [59, 62, 66, 69], tones: [11, 2, 6, 9] },
    { bass: 43, pad: [55, 59, 62, 66], tones: [7, 11, 2, 6] },
    { bass: 45, pad: [57, 59, 64, 69], tones: [9, 11, 4] },
];

// Melody density per 64-step loop: never busy, sometimes almost silent.
const DENSITY = [0.24, 0.34, 0.14, 0.3, 0.2, 0.36, 0.1, 0.28];

export class MusicBox {
    constructor(seed = 1) {
        this.rng = new Rng(seed);
        this.step = 0;
        this.nextTime = 0;
        this.mel = 4;
        this.lastNote = -1;
    }

    /** Restart the phrase at `time` (AudioContext seconds). */
    reset(time) {
        this.step = 0;
        this.nextTime = time;
    }

    /** Schedule every step that starts before `until`. */
    scheduleUntil(bus, until) {
        let guard = 0;
        while (this.nextTime < until && guard++ < 64) {
            this._step(bus, this.nextTime);
            this.nextTime += STEP;
            this.step++;
        }
    }

    _step(bus, t) {
        const r = this.rng;
        const s = this.step;
        const loop = Math.floor(s / 64);
        const inChord = s % STEPS_PER_CHORD;
        const chord = CHORDS[Math.floor(s / STEPS_PER_CHORD) % CHORDS.length];
        const density = DENSITY[loop % DENSITY.length];

        if (inChord === 0) {
            pad(bus, t, chord.pad, STEP * (STEPS_PER_CHORD - 2));
            tone(bus, t, { type: 'sine', freq: midiHz(chord.bass), gain: 0.07, env: [0.03, 0.4, 0.9] });
            tone(bus, t, { type: 'triangle', freq: midiHz(chord.bass + 12), gain: 0.018, env: [0.03, 0.2, 0.6], cutoff: 600 });
            if (s % 64 === 0 && loop > 0 && r.chance(0.5)) this._chimes(bus, t);
        } else if (inChord === 8 && r.chance(0.35)) {
            tone(bus, t, { type: 'sine', freq: midiHz(chord.bass + 7), gain: 0.04, env: [0.03, 0.2, 0.7] });
        }

        const onBeat = s % 2 === 0;
        if (r.chance(density * (onBeat ? 1.3 : 0.55))) {
            this.mel = this._nextMelody(chord, s % 8 === 0);
            const note = MELODY[this.mel];
            const vel = 0.07 + r.next() * 0.035;
            musicBox(bus, t, midiHz(note), { gain: vel, decay: 1.8, pan: r.range(-0.3, 0.3) });
            this.lastNote = note;
            if (r.chance(0.07) && this.mel < MELODY.length - 1) {
                musicBox(bus, t + STEP / 2, midiHz(MELODY[this.mel + 1]), { gain: vel * 0.7, decay: 1.4, pan: r.range(-0.3, 0.3) });
            }
        }

        // A soft shaker on the off-beats of every other loop.
        if (!onBeat && loop % 2 === 1 && r.chance(0.5)) {
            noiseBurst(bus, t, { kind: 'white', type: 'highpass', freq: 7000, gain: 0.014 + r.next() * 0.008, env: [0.004, 0.012, 0.022] });
        }
    }

    _nextMelody(chord, strong) {
        const r = this.rng;
        let i = this.mel;
        const moves = [-2, -1, -1, 1, 1, 2, -3, 3];
        for (let tries = 0; tries < 6; tries++) {
            let j = i + moves[r.int(moves.length)];
            if (j < 0) j = -j;
            if (j > MELODY.length - 1) j = 2 * (MELODY.length - 1) - j;
            if (MELODY[j] === this.lastNote) continue;
            if (strong && !chord.tones.includes(MELODY[j] % 12) && tries < 5) continue;
            return j;
        }
        return Math.max(0, Math.min(MELODY.length - 1, i + (i < 4 ? 1 : -1)));
    }

    // A quick descending wind-chime glissando across the top of the scale.
    _chimes(bus, t) {
        const top = MELODY.slice(-5).reverse();
        top.forEach((n, k) => {
            musicBox(bus, t + 0.06 + k * 0.075, midiHz(n + 12), { gain: 0.022, decay: 1.2, pan: -0.4 + k * 0.2 });
        });
    }
}

/** Soft pad: detuned triangles through a dark lowpass, slow swell and release. */
function pad(bus, t, notes, hold) {
    const { ctx } = bus;
    const out = voiceOut(bus, 1);
    const lp = filter(ctx, 'lowpass', 850, 0.5);
    const e = ctx.createGain();
    const stop = envAHR(e.gain, t, 0.022, 1.6, Math.max(0, hold - 1.6), 0.9);
    for (const n of notes) {
        for (const det of [-6, 5]) {
            const o = ctx.createOscillator();
            o.type = 'triangle';
            o.frequency.value = midiHz(n);
            o.detune.value = det;
            o.connect(lp);
            o.start(t);
            o.stop(stop);
        }
    }
    lp.connect(e);
    e.connect(out);
    return stop;
}
