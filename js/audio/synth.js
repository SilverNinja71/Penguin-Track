// Shared building blocks for the procedural voices: noise and texture buffers,
// envelopes, bells and filtered noise bursts. Everything takes a
// BaseAudioContext, so the same code plays live or renders in an
// OfflineAudioContext (the dev checks do that).
//
// A "bus" is { ctx, out, wet }: voices connect their dry signal to `out` and an
// optional reverb send to `wet` (may be null).
import { Rng } from '../core/rng.js';

const stores = new WeakMap();

function store(ctx) {
    let s = stores.get(ctx);
    if (!s) {
        s = {};
        stores.set(ctx, s);
    }
    return s;
}

// One generator for every random choice a voice makes (grain times, shard
// pitches). Seedable so offline renders are reproducible.
let rng = new Rng(0x5eed5);

export function seedVoices(seed) {
    rng = new Rng(seed >>> 0);
}

export function rand() {
    return rng.next();
}

export function randRange(a, b) {
    return a + (b - a) * rng.next();
}

export function clamp(x, lo, hi) {
    return x < lo ? lo : x > hi ? hi : x;
}

/** Finite number or the fallback: WebAudio throws on NaN/Infinity. */
export function fin(x, fallback = 0) {
    return Number.isFinite(x) ? x : fallback;
}

export function midiHz(m) {
    return 440 * Math.pow(2, (m - 69) / 12);
}

// ------------------------------------------------------------------ buffers

const NOISE_SECONDS = 2;

/** Looping noise: 'white', 'pink' (Paul Kellet) or 'brown' (leaky integrator), peak ~0.9. */
export function noiseBuffer(ctx, kind = 'white') {
    const s = store(ctx);
    const key = 'noise_' + kind;
    if (s[key]) return s[key];
    const len = Math.floor(ctx.sampleRate * NOISE_SECONDS);
    const fade = Math.floor(ctx.sampleRate * 0.02);
    const g = new Float32Array(len + fade);
    const r = new Rng(kind === 'white' ? 11 : kind === 'pink' ? 23 : 37);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
    for (let i = 0; i < g.length; i++) {
        const w = r.next() * 2 - 1;
        if (kind === 'pink') {
            b0 = 0.99886 * b0 + w * 0.0555179;
            b1 = 0.99332 * b1 + w * 0.0750759;
            b2 = 0.96900 * b2 + w * 0.1538520;
            b3 = 0.86650 * b3 + w * 0.3104856;
            b4 = 0.55000 * b4 + w * 0.5329522;
            b5 = -0.7616 * b5 - w * 0.0168980;
            g[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
            b6 = w * 0.115926;
        } else if (kind === 'brown') {
            last = (last + 0.02 * w) / 1.02;
            g[i] = last;
        } else {
            g[i] = w;
        }
    }
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    // Generate a little past the end and fold it into the head, so the sample
    // after d[len - 1] (the loop's d[0]) continues the waveform: no seam click.
    for (let i = 0; i < len; i++) {
        if (i < fade) {
            const w = i / fade;
            d[i] = g[i] * w + g[len + i] * (1 - w);
        } else {
            d[i] = g[i];
        }
    }
    removeDc(d);
    normalize(d, 0.9);
    s[key] = buf;
    return buf;
}

/**
 * Snow crunch texture: sparse short grains of filtered noise, like boots in
 * fresh powder. Looped with a playbackRate that follows the car's speed.
 */
export function crunchBuffer(ctx) {
    const s = store(ctx);
    if (s.crunch) return s.crunch;
    const sr = ctx.sampleRate;
    const len = Math.floor(sr * NOISE_SECONDS);
    const buf = ctx.createBuffer(1, len, sr);
    const d = buf.getChannelData(0);
    const r = new Rng(91);
    let t = 0;
    while (t < NOISE_SECONDS) {
        t += -Math.log(1 - r.next() * 0.999) / 42;   // ~42 grains per second
        const start = Math.floor(t * sr);
        const tau = (0.002 + r.next() * 0.006) * sr;
        const n = Math.floor(tau * 6);
        const amp = 0.25 + 0.75 * r.next() * r.next();
        let lp = 0;
        const k = 0.25 + r.next() * 0.6;              // grain colour: lower k = duller
        for (let j = 0; j < n; j++) {
            lp += k * ((r.next() * 2 - 1) - lp);
            d[(start + j) % len] += amp * lp * Math.exp(-j / tau);
        }
    }
    removeDc(d);
    normalize(d, 0.9);
    s.crunch = buf;
    return buf;
}

/** Stereo reverb impulse: decaying noise that darkens over time (a snowy hall). */
export function reverbBuffer(ctx, seconds = 2.2) {
    const s = store(ctx);
    if (s.reverb) return s.reverb;
    const sr = ctx.sampleRate;
    const len = Math.floor(sr * seconds);
    const buf = ctx.createBuffer(2, len, sr);
    for (let c = 0; c < 2; c++) {
        const d = buf.getChannelData(c);
        const r = new Rng(301 + c);
        let lp = 0;
        for (let i = 0; i < len; i++) {
            const x = i / len;
            const k = 0.85 - 0.75 * x;   // one-pole lowpass closing over the tail
            lp += k * ((r.next() * 2 - 1) - lp);
            const env = Math.pow(1 - x, 2.2) * Math.exp(-x * 2.5);
            const pre = Math.min(1, i / (sr * 0.012));   // short fade-in, no click at the onset
            d[i] = lp * env * pre;
        }
    }
    // Unit energy per channel keeps the wet level predictable.
    for (let c = 0; c < 2; c++) {
        const d = buf.getChannelData(c);
        let e = 0;
        for (let i = 0; i < len; i++) e += d[i] * d[i];
        const g = 1 / Math.sqrt(e || 1);
        for (let i = 0; i < len; i++) d[i] *= g;
    }
    s.reverb = buf;
    return buf;
}

/** tanh soft clip curve for WaveShaper nodes. */
export function softClipCurve(drive = 1.6, n = 1024) {
    const c = new Float32Array(n);
    const norm = Math.tanh(drive);
    for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * 2 - 1;
        c[i] = Math.tanh(drive * x) / norm;
    }
    return c;
}

function removeDc(d) {
    let m = 0;
    for (let i = 0; i < d.length; i++) m += d[i];
    m /= d.length || 1;
    for (let i = 0; i < d.length; i++) d[i] -= m;
}

function normalize(d, peak) {
    let p = 0;
    for (let i = 0; i < d.length; i++) {
        const a = Math.abs(d[i]);
        if (a > p) p = a;
    }
    if (p > 0) {
        const g = peak / p;
        for (let i = 0; i < d.length; i++) d[i] *= g;
    }
}

// ---------------------------------------------------------------- envelopes

/**
 * Attack then exponential decay on an AudioParam: 0 → peak in `a` s, then
 * toward 0 with time constant `tau`. Returns the time the voice is inaudible
 * (−60 dB), when its sources may stop.
 */
export function envAD(param, t, peak, a, tau) {
    param.setValueAtTime(0, t);
    param.linearRampToValueAtTime(fin(peak), t + a);
    param.setTargetAtTime(0, t + a, Math.max(0.001, tau));
    return t + a + tau * 7;
}

/** Attack, hold at peak, then release with time constant `tau`. */
export function envAHR(param, t, peak, a, hold, tau) {
    param.setValueAtTime(0, t);
    param.linearRampToValueAtTime(fin(peak), t + a);
    param.setValueAtTime(fin(peak), t + a + hold);
    param.setTargetAtTime(0, t + a + hold, Math.max(0.001, tau));
    return t + a + hold + tau * 7;
}

// ------------------------------------------------------------------ routing

/** A gain node feeding the bus (dry) with an optional reverb send and pan. */
export function voiceOut(bus, gain = 1, { wet = 0, pan = 0 } = {}) {
    const { ctx } = bus;
    const g = ctx.createGain();
    g.gain.value = fin(gain);
    let tail = g;
    if (pan && ctx.createStereoPanner) {
        const p = ctx.createStereoPanner();
        p.pan.value = clamp(fin(pan), -1, 1);
        g.connect(p);
        tail = p;
    }
    tail.connect(bus.out);
    if (wet > 0 && bus.wet) {
        const s = ctx.createGain();
        s.gain.value = wet;
        tail.connect(s);
        s.connect(bus.wet);
    }
    return g;
}

export function osc(ctx, type, freq, t, stop) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(fin(freq, 440), t);
    o.start(t);
    o.stop(stop);
    return o;
}

/** Noise source starting at a random point of the looped buffer. */
export function noiseSrc(ctx, kind, t, stop, rate = 1) {
    const src = ctx.createBufferSource();
    src.buffer = kind === 'crunch' ? crunchBuffer(ctx) : noiseBuffer(ctx, kind);
    src.loop = true;
    src.playbackRate.value = rate;
    src.start(t, rand() * (NOISE_SECONDS - 0.1));
    src.stop(stop);
    return src;
}

export function filter(ctx, type, freq, q = 0.707) {
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = fin(freq, 1000);
    f.Q.value = q;
    return f;
}

// ------------------------------------------------------------------- voices

// Inharmonic partials of a small handbell: [ratio, gain, decay scale].
const BELL = [[1, 1, 1], [2.0, 0.38, 0.6], [2.76, 0.26, 0.42], [4.07, 0.12, 0.3], [5.43, 0.07, 0.22], [8.93, 0.035, 0.15]];
const MUSIC_BOX = [[1, 1, 1], [2, 0.1, 0.45], [5.4, 0.05, 0.12]];

/**
 * Bell / glockenspiel note. `decay` is the fundamental's time to −60 dB.
 * Returns the end time.
 */
export function bell(bus, t, freq, { gain = 0.2, decay = 1.6, wet = 0.25, pan = 0, partials = BELL, attack = 0.002 } = {}) {
    const { ctx } = bus;
    const out = voiceOut(bus, gain, { wet, pan });
    const nyq = ctx.sampleRate * 0.45;
    let end = t;
    for (const [ratio, g, ds] of partials) {
        const f = freq * ratio;
        if (f > nyq) continue;
        const tau = (decay * ds) / 6.9;
        const e = ctx.createGain();
        const stop = envAD(e.gain, t, g, attack, tau);
        const o = osc(ctx, 'sine', f, t, stop);
        o.connect(e);
        e.connect(out);
        if (stop > end) end = stop;
    }
    return end;
}

export function musicBox(bus, t, freq, opts = {}) {
    return bell(bus, t, freq, { partials: MUSIC_BOX, decay: 1.4, ...opts });
}

/**
 * Pitched tone with optional glide and lowpass. `env` is [attack, hold, tau].
 */
export function tone(bus, t, { type = 'sine', freq = 440, to = 0, glide = 0.1, gain = 0.2, env = [0.005, 0.05, 0.08],
    cutoff = 0, q = 0.707, wet = 0, pan = 0, detune = 0 } = {}) {
    const { ctx } = bus;
    const out = voiceOut(bus, 1, { wet, pan });
    const e = ctx.createGain();
    const stop = envAHR(e.gain, t, gain, env[0], env[1], env[2]);
    const o = osc(ctx, type, freq, t, stop);
    if (detune) o.detune.value = detune;
    if (to > 0) o.frequency.exponentialRampToValueAtTime(to, t + Math.max(0.005, glide));
    let tail = o;
    if (cutoff > 0) {
        const f = filter(ctx, 'lowpass', cutoff, q);
        o.connect(f);
        tail = f;
    }
    tail.connect(e);
    e.connect(out);
    return stop;
}

/**
 * Filtered noise burst. `freq`→`to` sweeps the filter over `sweep` seconds.
 */
export function noiseBurst(bus, t, { kind = 'white', type = 'bandpass', freq = 1000, to = 0, sweep = 0.2, q = 1,
    gain = 0.2, env = [0.005, 0.02, 0.06], wet = 0, pan = 0, rate = 1 } = {}) {
    const { ctx } = bus;
    const out = voiceOut(bus, 1, { wet, pan });
    const e = ctx.createGain();
    const stop = envAHR(e.gain, t, gain, env[0], env[1], env[2]);
    const src = noiseSrc(ctx, kind, t, stop, rate);
    const f = filter(ctx, type, freq, q);
    if (to > 0) {
        f.frequency.setValueAtTime(fin(freq, 1000), t);
        f.frequency.exponentialRampToValueAtTime(to, t + Math.max(0.005, sweep));
    }
    src.connect(f);
    f.connect(e);
    e.connect(out);
    return stop;
}

/** Sleigh-bell shimmer: a shaken cluster of tiny jingles for `dur` seconds. */
export function sleighBells(bus, t, { dur = 1.2, rate = 11, gain = 0.06, wet = 0.3 } = {}) {
    const jingles = [4180, 4920, 5630, 6370];
    let end = t;
    const n = Math.max(1, Math.round(dur * rate));
    for (let i = 0; i < n; i++) {
        const x = i / n;
        const swell = Math.sin(Math.PI * Math.min(1, x * 1.25)) * (1 - 0.4 * x);
        const st = t + i / rate + randRange(-0.012, 0.012);
        const g = gain * (0.35 + 0.65 * swell) * randRange(0.7, 1);
        end = Math.max(end, noiseBurst(bus, Math.max(t, st), { kind: 'white', type: 'bandpass', freq: randRange(6500, 8500), q: 2.5,
            gain: g * 0.8, env: [0.002, 0.004, 0.018], wet, pan: randRange(-0.3, 0.3) }));
        const f = jingles[Math.floor(rand() * jingles.length)] * randRange(0.99, 1.01);
        end = Math.max(end, bell(bus, Math.max(t, st + 0.003), f, { gain: g * 0.5, decay: 0.22, wet,
            partials: [[1, 1, 1], [1.5, 0.4, 0.6]], pan: randRange(-0.4, 0.4) }));
    }
    return end;
}
