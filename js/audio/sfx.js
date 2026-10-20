// One-shot sound effects. Each voice is `(bus, t, opts) -> endTime`: it
// schedules its nodes on bus.ctx starting at time t and returns when it is
// silent. Levels are mixed so a single voice peaks around 0.2–0.5; the engine's
// limiter catches pile-ups.
import { bell, musicBox, tone, noiseBurst, sleighBells, voiceOut, envAHR, osc, filter,
    rand, randRange, clamp, fin, midiHz } from './synth.js';

// D major pentatonic world (the menu music shares it): D E F# A B.
const N = {
    D4: midiHz(62), F4s: midiHz(66), A4: midiHz(69), D5: midiHz(74), E5: midiHz(76), F5: midiHz(77), F5s: midiHz(78),
    A5: midiHz(81), B5: midiHz(83), D6: midiHz(86), E6: midiHz(88), F6s: midiHz(90), A6: midiHz(93), B6: midiHz(95),
    D7: midiHz(98), F7s: midiHz(102), A7: midiHz(105),
};

function maxOf(...xs) {
    let m = 0;
    for (const x of xs) if (x > m) m = x;
    return m;
}

function arpeggio(bus, t, notes, step, opts) {
    let end = t;
    notes.forEach((f, i) => {
        end = Math.max(end, bell(bus, t + i * step, f, opts));
    });
    return end;
}

/** Brassy pad: detuned saws through a lowpass that opens and settles. */
function brassChord(bus, t, notes, { gain = 0.03, attack = 0.08, hold = 0.5, tau = 0.35, open = 2200, wet = 0.3 } = {}) {
    const { ctx } = bus;
    const out = voiceOut(bus, 1, { wet });
    const f = filter(ctx, 'lowpass', 500, 1.2);
    f.frequency.setValueAtTime(500, t);
    f.frequency.linearRampToValueAtTime(open, t + attack + 0.05);
    f.frequency.setTargetAtTime(900, t + attack + 0.08, 0.25);
    const e = ctx.createGain();
    const stop = envAHR(e.gain, t, gain, attack, hold, tau);
    for (const n of notes) {
        for (const det of [-7, 6]) {
            const o = osc(ctx, 'sawtooth', n, t, stop);
            o.detune.value = det;
            o.connect(f);
        }
    }
    f.connect(e);
    e.connect(out);
    return stop;
}

/** Thump: a sine dropping in pitch, the body of landings and impacts. */
function thump(bus, t, { gain = 0.3, from = 140, to = 45, glide = 0.12, tau = 0.07, pan = 0 } = {}) {
    return tone(bus, t, { type: 'sine', freq: from, to, glide, gain, env: [0.002, 0.015, tau], pan });
}

function iceShards(bus, t, count, { gain = 0.05, spread = 0.12, lo = 2200, hi = 5000, pan = 0, decay = 0.3 } = {}) {
    let end = t;
    for (let i = 0; i < count; i++) {
        const f = randRange(lo, hi);
        end = Math.max(end, bell(bus, t + rand() * spread, f, {
            gain: gain * randRange(0.5, 1), decay: decay * randRange(0.6, 1.2), wet: 0.2,
            partials: [[1, 1, 1], [2.32, 0.35, 0.5]], pan: clamp(pan + randRange(-0.25, 0.25), -1, 1),
        }));
    }
    return end;
}

function buzz(bus, t, { gain = 0.09, freq = 155, count = 2, gap = 0.17 } = {}) {
    let end = t;
    for (let i = 0; i < count; i++) {
        const st = t + i * gap;
        end = Math.max(end,
            tone(bus, st, { type: 'square', freq, gain, env: [0.006, 0.085, 0.03], cutoff: 750, q: 1.2 }),
            tone(bus, st, { type: 'square', freq: freq * 1.02, gain: gain * 0.6, env: [0.006, 0.085, 0.03], cutoff: 600 }));
    }
    return end;
}

export const SFX = {
    // ---------------------------------------------------------------- race

    /** Checkpoint chime: two bell notes. kind 'good' rises brighter, 'bad' falls softer. */
    checkpoint(bus, t, { kind = 'neutral' } = {}) {
        if (kind === 'good') {
            return maxOf(bell(bus, t, N.D6, { gain: 0.15, decay: 1.2 }),
                bell(bus, t + 0.085, N.A6, { gain: 0.17, decay: 1.5 }),
                bell(bus, t + 0.17, N.D7, { gain: 0.05, decay: 0.9 }));
        }
        if (kind === 'bad') {
            const soft = [[1, 1, 1], [2.0, 0.3, 0.5], [2.76, 0.15, 0.35]];
            return maxOf(bell(bus, t, N.A5, { gain: 0.15, decay: 1.0, partials: soft }),
                bell(bus, t + 0.11, N.F5, { gain: 0.15, decay: 1.2, partials: soft }));
        }
        return maxOf(bell(bus, t, N.A5, { gain: 0.15, decay: 1.1 }),
            bell(bus, t + 0.09, N.D6, { gain: 0.16, decay: 1.4 }));
    },

    lap(bus, t) {
        return maxOf(arpeggio(bus, t, [N.D6, N.F6s, N.A6, N.D7], 0.07, { gain: 0.12, decay: 1.3 }),
            sleighBells(bus, t + 0.05, { dur: 0.6, gain: 0.05 }));
    },

    /** Finish fanfare: a rising bell run, a brassy chord and sleigh-bell shimmer. */
    finish(bus, t) {
        const run = [N.D5, N.A5, N.D6, N.F6s, N.A6];
        return maxOf(
            arpeggio(bus, t, run, 0.075, { gain: 0.11, decay: 1.1 }),
            thump(bus, t + 0.42, { gain: 0.22, from: 110, to: 60, tau: 0.12 }),
            brassChord(bus, t + 0.4, [N.D4, N.F4s, N.A4, N.D5], { gain: 0.022, hold: 0.7, tau: 0.45 }),
            bell(bus, t + 0.42, N.D6, { gain: 0.1, decay: 2.4 }),
            bell(bus, t + 0.42, N.F6s, { gain: 0.08, decay: 2.2 }),
            bell(bus, t + 0.42, N.A6, { gain: 0.08, decay: 2.0 }),
            bell(bus, t + 0.9, N.D7, { gain: 0.05, decay: 1.6 }),
            sleighBells(bus, t + 0.4, { dur: 1.6, gain: 0.055 }),
        );
    },

    /** Countdown beep (3, 2, 1): short, low, soft-edged. */
    countdown(bus, t) {
        return maxOf(tone(bus, t, { type: 'triangle', freq: N.A4, gain: 0.2, env: [0.004, 0.12, 0.045] }),
            tone(bus, t, { type: 'sine', freq: N.A4 * 2, gain: 0.045, env: [0.004, 0.08, 0.04] }));
    },

    /** GO: an octave up, longer, with a sparkle. */
    go(bus, t) {
        return maxOf(tone(bus, t, { type: 'triangle', freq: N.A5, gain: 0.2, env: [0.004, 0.32, 0.1] }),
            tone(bus, t, { type: 'sine', freq: N.A5 * 2, gain: 0.05, env: [0.004, 0.25, 0.1] }),
            bell(bus, t + 0.02, N.A6, { gain: 0.05, decay: 1.0 }));
    },

    respawn(bus, t) {
        return maxOf(
            noiseBurst(bus, t, { kind: 'pink', type: 'bandpass', freq: 2600, to: 450, sweep: 0.34, q: 1.3, gain: 0.32, env: [0.07, 0.08, 0.09], wet: 0.2 }),
            tone(bus, t, { type: 'sine', freq: 900, to: 320, glide: 0.3, gain: 0.045, env: [0.05, 0.1, 0.08] }),
            bell(bus, t + 0.3, N.D6, { gain: 0.05, decay: 0.8 }),
        );
    },

    /** Frost Boost (level 1) or Avalanche Boost (level 2, bigger and longer). */
    boost(bus, t, { level = 1 } = {}) {
        if (level >= 2) {
            return maxOf(
                thump(bus, t, { gain: 0.24, from: 100, to: 45, tau: 0.1 }),
                noiseBurst(bus, t, { kind: 'pink', type: 'bandpass', freq: 250, to: 4200, sweep: 0.8, q: 1.1, gain: 0.44, env: [0.03, 0.3, 0.25], wet: 0.15 }),
                noiseBurst(bus, t, { kind: 'brown', type: 'lowpass', freq: 220, gain: 0.4, env: [0.02, 0.35, 0.3] }),
                tone(bus, t + 0.02, { type: 'sine', freq: 500, to: 2000, glide: 0.7, gain: 0.04, env: [0.03, 0.35, 0.18] }),
                tone(bus, t + 0.02, { type: 'sine', freq: 750, to: 3000, glide: 0.7, gain: 0.025, env: [0.03, 0.35, 0.18] }),
            );
        }
        return maxOf(
            thump(bus, t, { gain: 0.15, from: 90, to: 55, tau: 0.07 }),
            noiseBurst(bus, t, { kind: 'pink', type: 'bandpass', freq: 400, to: 3000, sweep: 0.5, q: 1.2, gain: 0.38, env: [0.03, 0.14, 0.17], wet: 0.12 }),
            tone(bus, t + 0.02, { type: 'sine', freq: 600, to: 1800, glide: 0.45, gain: 0.04, env: [0.02, 0.2, 0.14] }),
        );
    },

    /** Frozen pads (engine, wheel, brakes): a descending icy tone with frost crackle. */
    frozen(bus, t, { pitch = 1 } = {}) {
        pitch = clamp(fin(pitch, 1), 0.25, 4);
        return maxOf(
            tone(bus, t, { type: 'sine', freq: 2200 * pitch, to: 700 * pitch, glide: 0.45, gain: 0.07, env: [0.01, 0.3, 0.12], wet: 0.35 }),
            tone(bus, t, { type: 'triangle', freq: 1100 * pitch, to: 350 * pitch, glide: 0.45, gain: 0.05, env: [0.01, 0.3, 0.12], cutoff: 1800, wet: 0.35 }),
            bell(bus, t, 2637 * pitch, { gain: 0.05, decay: 0.7, wet: 0.4 }),
            bell(bus, t + 0.07, 3520 * pitch, { gain: 0.035, decay: 0.6, wet: 0.4 }),
            noiseBurst(bus, t, { kind: 'white', type: 'highpass', freq: 5000, gain: 0.05, env: [0.002, 0.12, 0.08] }),
        );
    },

    /** Thaw: warm rising fifths ending on a soft bell. */
    thaw(bus, t) {
        return maxOf(
            tone(bus, t, { type: 'triangle', freq: 294, to: 587, glide: 0.38, gain: 0.11, env: [0.08, 0.25, 0.15], cutoff: 1500, wet: 0.3 }),
            tone(bus, t, { type: 'triangle', freq: 440, to: 880, glide: 0.38, gain: 0.07, env: [0.08, 0.25, 0.15], cutoff: 1500, wet: 0.3 }),
            bell(bus, t + 0.36, N.D6, { gain: 0.08, decay: 1.2 }),
        );
    },

    /** Snow Globe (slow motion): a dreamy falling music-box line. */
    globe(bus, t) {
        const line = [N.A6, N.F6s, N.E6, N.D6];
        const when = [0, 0.11, 0.25, 0.43];
        let end = tone(bus, t, { type: 'sine', freq: N.D4, gain: 0.07, env: [0.25, 0.4, 0.4], wet: 0.4 });
        line.forEach((f, i) => { end = Math.max(end, musicBox(bus, t + when[i], f, { gain: 0.12, decay: 1.6, wet: 0.5 })); });
        return end;
    },

    /** Glide (cruise control): an airy whistle settling on a steady note. */
    glide(bus, t) {
        return maxOf(
            noiseBurst(bus, t, { kind: 'pink', type: 'bandpass', freq: 900, to: 1400, sweep: 0.3, q: 7, gain: 0.25, env: [0.06, 0.25, 0.15], wet: 0.3 }),
            tone(bus, t, { type: 'sine', freq: N.D5, to: N.A5, glide: 0.2, gain: 0.07, env: [0.04, 0.3, 0.15], wet: 0.3 }),
        );
    },

    /** Thin Ice: a delicate glassy creak. */
    thinIce(bus, t) {
        return maxOf(
            iceShards(bus, t, 5, { gain: 0.06, spread: 0.25, lo: 2600, hi: 5200 }),
            tone(bus, t, { type: 'sine', freq: 3000, to: 3700, glide: 0.25, gain: 0.025, env: [0.01, 0.15, 0.06] }),
        );
    },

    /** Landing thump scaled by strength (m/s into the ground). */
    land(bus, t, { strength = 5 } = {}) {
        const s = clamp((fin(strength, 5) - 1.5) / 18, 0, 1);
        const g = 0.07 + 0.3 * s;
        let end = maxOf(
            thump(bus, t, { gain: g, from: 130 + 30 * s, to: 42, glide: 0.1 + 0.05 * s, tau: 0.06 + 0.06 * s }),
            noiseBurst(bus, t, { kind: 'pink', type: 'lowpass', freq: 420 + 300 * s, gain: g * 0.8, env: [0.002, 0.02, 0.07 + 0.08 * s] }),
        );
        if (s > 0.35) {
            end = Math.max(end, noiseBurst(bus, t + 0.005, { kind: 'crunch', type: 'bandpass', freq: 1300, q: 0.8, gain: g * 0.9, env: [0.002, 0.04, 0.08 + 0.06 * s], rate: 1.3 }));
        }
        return end;
    },

    /** Wall hit: crunchy ice impact scaled by intensity (m/s into the wall), panned by side. */
    wallhit(bus, t, { intensity = 6, pan = 0 } = {}) {
        const s = clamp((fin(intensity, 6) - 2.5) / 20, 0, 1);
        const g = 0.08 + 0.28 * s;
        return maxOf(
            noiseBurst(bus, t, { kind: 'white', type: 'bandpass', freq: 2600, q: 1.4, gain: g * 0.7, env: [0.001, 0.008, 0.022 + 0.03 * s], pan }),
            noiseBurst(bus, t, { kind: 'crunch', type: 'bandpass', freq: 1500, q: 0.8, gain: g, env: [0.002, 0.03, 0.06 + 0.08 * s], rate: 1.6, pan }),
            thump(bus, t, { gain: g * 0.8, from: 120, to: 55, glide: 0.08, tau: 0.05, pan }),
            iceShards(bus, t + 0.01, 1 + Math.floor(3 * s), { gain: g * 0.22, spread: 0.12, pan }),
        );
    },

    /** Thin Ice broke: a sharp crack then falling glass. */
    fragileBreak(bus, t) {
        return maxOf(
            noiseBurst(bus, t, { kind: 'white', type: 'highpass', freq: 2500, gain: 0.32, env: [0.0005, 0.005, 0.015] }),
            noiseBurst(bus, t, { kind: 'crunch', type: 'bandpass', freq: 2200, q: 0.9, gain: 0.25, env: [0.001, 0.05, 0.08], rate: 2 }),
            thump(bus, t, { gain: 0.18, from: 160, to: 60, tau: 0.05 }),
            tone(bus, t + 0.02, { type: 'sine', freq: 2600, to: 900, glide: 0.3, gain: 0.04, env: [0.005, 0.2, 0.08] }),
            iceShards(bus, t + 0.03, 9, { gain: 0.075, spread: 0.7, lo: 2500, hi: 6500, decay: 0.45 }),
        );
    },

    /** Finish crossed with checkpoints missing: two soft low buzzes. */
    missing(bus, t) {
        return buzz(bus, t, { gain: 0.09 });
    },

    /** Fell off the world: a cartoon slide whistle down. */
    fall(bus, t) {
        return maxOf(
            tone(bus, t, { type: 'triangle', freq: 1250, to: 260, glide: 0.8, gain: 0.07, env: [0.03, 0.7, 0.12], cutoff: 2400 }),
            noiseBurst(bus, t, { kind: 'pink', type: 'bandpass', freq: 1500, to: 400, sweep: 0.8, q: 0.8, gain: 0.08, env: [0.1, 0.5, 0.15] }),
        );
    },

    // ------------------------------------------------------------------ ui

    click(bus, t) {
        return maxOf(tone(bus, t, { type: 'sine', freq: 1500, to: 900, glide: 0.03, gain: 0.12, env: [0.001, 0.006, 0.012] }),
            noiseBurst(bus, t, { kind: 'white', type: 'bandpass', freq: 4200, q: 1.5, gain: 0.05, env: [0.0005, 0.002, 0.004] }));
    },

    hover(bus, t) {
        return tone(bus, t, { type: 'sine', freq: 2100, gain: 0.03, env: [0.001, 0.003, 0.008] });
    },

    back(bus, t) {
        return maxOf(tone(bus, t, { type: 'sine', freq: 1100, gain: 0.09, env: [0.002, 0.02, 0.025] }),
            tone(bus, t + 0.065, { type: 'sine', freq: 820, gain: 0.09, env: [0.002, 0.025, 0.03] }));
    },

    error(bus, t) {
        return buzz(bus, t, { gain: 0.065, freq: 165, gap: 0.14 });
    },

    /** Medal fanfare per tier: bronze < silver < gold < emperor (grandest). */
    medal(bus, t, { tier = 'gold' } = {}) {
        if (tier === 'bronze') return arpeggio(bus, t, [N.D6, N.F6s, N.A6], 0.09, { gain: 0.12, decay: 1.3 });
        if (tier === 'silver') {
            return maxOf(arpeggio(bus, t, [N.D6, N.F6s, N.A6, N.D7], 0.085, { gain: 0.12, decay: 1.4 }),
                sleighBells(bus, t + 0.25, { dur: 0.4, gain: 0.04 }));
        }
        if (tier === 'emperor') {
            const run = [N.D5, N.E5, N.F5s, N.A5, N.B5, N.D6, N.E6, N.F6s, N.A6, N.B6, N.D7];
            const hit = t + run.length * 0.045 + 0.05;
            return maxOf(
                arpeggio(bus, t, run, 0.045, { gain: 0.075, decay: 0.9 }),
                thump(bus, hit, { gain: 0.24, from: 110, to: 55, tau: 0.14 }),
                brassChord(bus, hit, [N.D4, N.A4, N.D5, N.F5s], { gain: 0.022, hold: 1.0, tau: 0.6, open: 2600 }),
                bell(bus, hit, N.D6, { gain: 0.09, decay: 3.0 }),
                bell(bus, hit, N.F6s, { gain: 0.07, decay: 2.8 }),
                bell(bus, hit, N.A6, { gain: 0.07, decay: 2.6 }),
                bell(bus, hit, N.D7, { gain: 0.06, decay: 2.4 }),
                arpeggio(bus, hit + 0.5, [N.A7, N.F7s, N.D7, N.A6], 0.12, { gain: 0.03, decay: 0.9, wet: 0.5 }),
                sleighBells(bus, hit, { dur: 1.8, gain: 0.05 }),
            );
        }
        // gold
        return maxOf(arpeggio(bus, t, [N.D5, N.A5, N.D6, N.F6s, N.A6, N.D7], 0.07, { gain: 0.1, decay: 1.2 }),
            bell(bus, t + 0.45, N.D6, { gain: 0.08, decay: 2.0 }),
            bell(bus, t + 0.45, N.A6, { gain: 0.06, decay: 1.8 }),
            sleighBells(bus, t + 0.4, { dur: 0.8, gain: 0.045 }));
    },
};

/** Which voice and options an effect pad uses (turbo pads sound through their boost event). */
export const EFFECT_SOUNDS = {
    noEngine: ['frozen', { pitch: 0.8 }],
    noSteer: ['frozen', { pitch: 1 }],
    noBrake: ['frozen', { pitch: 1.2 }],
    slowmo: ['globe', {}],
    cruise: ['glide', {}],
    fragile: ['thinIce', {}],
    reset: ['thaw', {}],
};
