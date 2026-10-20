// The player's car as a continuous voice: engine, turbo whine, tyres on each
// snow surface and wind. carSoundParams() is the pure mapping from a car view
// (sim.car or a snapshotCar copy) to synth targets, so it runs and is tested in
// Node; CarVoice is the WebAudio graph that follows those targets.
import { noiseBuffer, crunchBuffer, softClipCurve, clamp, fin } from './synth.js';

export const ENGINE_IDLE_HZ = 56;
// Pitch in octaves above idle: mostly road speed, plus a rev share that falls
// back on each upshift (the "little shift dip", ~3 semitones).
const SPEED_OCT = 1.0;     // octaves from 0 to 290 km/h
const REV_OCT = 0.26;      // octaves from the bottom to the top of a gear
const SHIFT_LIFT = 0.11;   // s of throttle lift after an upshift
const SLOWMO_PITCH = [1, 0.93, 0.86, 0.78];

export function makeCarSoundState() {
    return { gear: 1, shift: 0, fwd: 0, gas: 0, has: false };
}

function smoothstep(a, b, x) {
    const t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
}

function approach(cur, target, dt, tau) {
    return cur + (target - cur) * (1 - Math.exp(-dt / tau));
}

/**
 * Car view -> synth targets. `st` (makeCarSoundState) carries the gear, shift
 * timer and throttle estimate between calls. `input` (sim.lastInput) gives the
 * exact throttle; without it the live car's gasHeld or the acceleration is used.
 */
export function carSoundParams(view, dt, st, input = null, out = {}) {
    dt = clamp(fin(dt, 1 / 60), 0, 0.1);
    const fx = view.effects || {};
    const kmh = Math.abs(fin(view.speedKmh, fin(view.speed, 0) * 3.6));
    const fwd = fin(view.forwardSpeed, 0);
    const sp = clamp(kmh / 290, 0, 1.25);
    const air = !!view.airborne;
    const rpm = clamp(fin(view.rpm, 0.25), 0, 1);
    const gear = clamp(Math.round(fin(view.gear, 1)), 1, 6);

    // Throttle.
    let gas;
    if (input && typeof input.gas === 'boolean') gas = input.gas || (input.brake && fwd < 0.5) ? 1 : 0;
    else if (typeof view.gasHeld === 'boolean') gas = view.gasHeld ? 1 : 0;
    else if (air) gas = rpm > 0.9 ? 1 : 0;
    else if (kmh < 5) gas = rpm >= 0.44 ? 1 : 0;
    else {
        // Accelerating harder than drag and rolling resistance alone allow.
        const v = Math.abs(fwd);
        const accel = st.has && dt > 0 ? (v - Math.abs(st.fwd)) / dt : 0;
        gas = accel + 0.00055 * v * v + 0.3 > 1.8 ? 1 : 0;
    }
    st.gas = st.has ? approach(st.gas, gas, dt, 0.06) : gas;
    st.fwd = fwd;
    st.has = true;
    const engineOff = !!(fx.noEngine || fx.broken);
    const load = engineOff ? 0 : st.gas;

    // Gearbox.
    if (gear > st.gear && !air) st.shift = SHIFT_LIFT;
    st.gear = gear;
    st.shift = Math.max(0, st.shift - dt);
    const lift = st.shift > 0 ? 0.55 : 1;
    const rev = clamp((rpm - 0.25) / 0.75, -0.3, 1);
    const pitchScale = SLOWMO_PITCH[clamp(fin(fx.slowmo, 0) | 0, 0, 3)];
    const oct = engineOff ? -0.2 : SPEED_OCT * Math.min(sp, 1.1) + REV_OCT * rev;
    out.f0 = ENGINE_IDLE_HZ * Math.pow(2, oct) * pitchScale;
    out.engine = engineOff ? 0.12 : (0.5 + 0.32 * load + 0.18 * rev * load) * (air ? 0.62 : 1) * lift;
    out.cutoff = (280 + (500 + 1700 * clamp(rev, 0, 1)) * (0.35 + 0.65 * load) + 700 * Math.min(sp, 1))
        * (air ? 0.8 : 1) * (st.shift > 0 ? 0.75 : 1) * (engineOff ? 0.5 : 1);
    out.rumble = engineOff ? 0.15 : (0.35 + 0.65 * (1 - load)) * (0.5 + 0.5 * clamp(rev, 0, 1)) * (air ? 0.6 : 1);

    // Frost / Avalanche Boost whine fades with the boost.
    const level = fin(fx.turbo, 0) | 0;
    const boostLeft = level > 0 ? clamp(fin(fx.turboTime, 0) / 2, 0, 1) : 0;
    out.turbo = boostLeft * (level >= 2 ? 1 : 0.65);
    out.turboFreq = (1500 + 1300 * Math.min(sp, 1)) * (level >= 2 ? 1.18 : 1) * pitchScale;

    // Surfaces under the wheels in contact.
    let n = 0, wS = 0, wP = 0, wI = 0, wG = 0, slip = 0;
    const wheels = view.wheels;
    if (!air && wheels) {
        for (let i = 0; i < wheels.length; i++) {
            const w = wheels[i];
            if (!w || !w.contact) continue;
            n++;
            slip += clamp(fin(w.slip, 0), 0, 1);
            if (w.surface === 'snow') wS++;
            else if (w.surface === 'powder') wP++;
            else if (w.surface === 'ice') wI++;
            else if (w.surface === 'ground') wG++;
        }
    }
    let grounded = 0;
    if (n > 0) {
        wS /= n; wP /= n; wI /= n; wG /= n; slip /= n;
        grounded = n / 4;
    } else if (!air && view.surfaceUnder) {
        const s = view.surfaceUnder;
        wS = s === 'snow' ? 1 : 0; wP = s === 'powder' ? 1 : 0; wI = s === 'ice' ? 1 : 0; wG = s === 'ground' ? 1 : 0;
        slip = view.drifting ? 0.6 : 0;
        grounded = 1;
    }
    const moving = smoothstep(2, 30, kmh);
    const slide = grounded > 0 ? (view.drifting ? Math.max(0.6, slip) : smoothstep(0.5, 1, slip)) : 0;

    out.squeal = grounded * slide * smoothstep(20, 70, kmh) * (wS + 0.75 * wP + 0.5 * wG);
    out.squealFreq = 650 + 450 * Math.min(1, kmh / 250) + 150 * slip;
    out.roll = grounded * (wS + 0.5 * wP) * moving * (0.3 + 0.7 * Math.min(sp, 1));
    out.ice = Math.min(1, grounded * wI * moving * (0.25 + 0.75 * Math.min(1, kmh / 180)) * (1 + 0.8 * slide));
    out.crunch = grounded * wP * smoothstep(3, 50, kmh) * (0.6 + 0.4 * Math.min(sp, 1));
    out.deep = grounded * wG * moving * (0.5 + 0.5 * Math.min(1, kmh / 100));
    out.crunchRate = 0.6 + 1.6 * Math.min(1, kmh / 180);

    // Wind rush rises with speed, a little stronger in the air.
    out.wind = Math.pow(Math.min(sp, 1.2), 1.7) * (air ? 1.15 : 1);
    out.windFreq = (380 + 1300 * Math.min(sp, 1)) * (air ? 1.1 : 1);
    return out;
}

// Mix levels of each layer at full target (1.0).
export const CAR_MIX = {
    engine: 0.22, rumble: 0.07, turbo: 0.03, squeal: 0.15, roll: 0.07, ice: 0.06, crunch: 0.12, deep: 0.16,
    deepCrunch: 0.08, wind: 0.14,
};

const TAU = { pitch: 0.035, gain: 0.05, filter: 0.06, wind: 0.15, rate: 0.1 };

export class CarVoice {
    /** Builds the graph on `ctx` feeding `dest`; silent until start(). */
    constructor(ctx, dest) {
        this.ctx = ctx;
        const t = ctx.currentTime;
        const g = (v = 0) => {
            const n = ctx.createGain();
            n.gain.value = v;
            return n;
        };
        const f = (type, freq, q = 0.707) => {
            const n = ctx.createBiquadFilter();
            n.type = type;
            n.frequency.value = freq;
            n.Q.value = q;
            return n;
        };
        const o = (type, freq) => {
            const n = ctx.createOscillator();
            n.type = type;
            n.frequency.value = freq;
            return n;
        };
        const loop = (buffer, offset) => {
            const n = ctx.createBufferSource();
            n.buffer = buffer;
            n.loop = true;
            this.sources.push([n, offset]);
            return n;
        };
        this.sources = [];
        this.out = g(0);
        // Nothing useful lives below ~35 Hz; cutting it keeps headroom for what speakers can play.
        const hp = f('highpass', 35, 0.6);
        this.out.connect(hp).connect(dest);

        // Engine: two saws an octave apart and a sub sine, warmed by a lowpass and a soft clip.
        this.oscA = o('sawtooth', ENGINE_IDLE_HZ);
        this.oscB = o('sawtooth', ENGINE_IDLE_HZ * 2);
        this.oscB.detune.value = 7;
        this.oscSub = o('sine', ENGINE_IDLE_HZ / 2);
        this.engFilter = f('lowpass', 600, 0.9);
        const pre = g(0.5);
        const mixB = g(0.32), mixSub = g(0.28);
        this.oscA.connect(pre);
        this.oscB.connect(mixB).connect(pre);
        pre.connect(this.engFilter);
        this.oscSub.connect(mixSub);
        const shaper = ctx.createWaveShaper();
        shaper.curve = softClipCurve(1.4);
        this.engFilter.connect(shaper);
        this.engGain = g(0);
        shaper.connect(this.engGain);
        mixSub.connect(this.engGain);
        this.engGain.connect(this.out);
        // A slow wobble keeps the tone from sounding like a test oscillator.
        this.wobble = o('sine', 6.7);
        const wobbleDepth = g(7);
        this.wobble.connect(wobbleDepth);
        wobbleDepth.connect(this.oscA.detune);
        wobbleDepth.connect(this.oscB.detune);

        // Combustion rumble: brown noise pulsed at the firing rate.
        const brown = noiseBuffer(ctx, 'brown');
        this.rumbleSrc = loop(brown, 0.3);
        this.rumbleBP = f('bandpass', ENGINE_IDLE_HZ * 1.5, 1.2);
        this.rumbleAM = g(0.5);
        this.am = o('sine', ENGINE_IDLE_HZ / 2);
        const amDepth = g(0.5);
        this.am.connect(amDepth);
        amDepth.connect(this.rumbleAM.gain);
        this.rumbleGain = g(0);
        this.rumbleSrc.connect(this.rumbleBP).connect(this.rumbleAM).connect(this.rumbleGain).connect(this.out);

        // Boost whine.
        this.turboOsc = o('sine', 1800);
        this.turboGain = g(0);
        this.turboOsc.connect(this.turboGain).connect(this.out);

        // Pink noise feeds the squeal, rolling and wind layers.
        const pink = loop(noiseBuffer(ctx, 'pink'), 0.7);
        this.squealBP1 = f('bandpass', 900, 5);
        this.squealBP2 = f('bandpass', 1450, 6);
        this.squealGain = g(0);
        pink.connect(this.squealBP1).connect(this.squealGain);
        pink.connect(this.squealBP2).connect(this.squealGain);
        this.squealGain.connect(this.out);
        this.squealLfo = o('sine', 5.3);
        const squealDepth = g(35);
        this.squealLfo.connect(squealDepth);
        squealDepth.connect(this.squealBP1.detune);
        squealDepth.connect(this.squealBP2.detune);

        this.rollLP = f('lowpass', 380, 0.6);
        this.rollGain = g(0);
        pink.connect(this.rollLP).connect(this.rollGain).connect(this.out);

        this.windBP = f('bandpass', 500, 0.7);
        const gust = g(1);
        this.gustLfo = o('sine', 0.17);
        const gustDepth = g(0.2);
        this.gustLfo.connect(gustDepth);
        gustDepth.connect(gust.gain);
        this.windGain = g(0);
        pink.connect(this.windBP).connect(gust).connect(this.windGain).connect(this.out);

        // Ice hiss: white noise kept in the mid-highs, never piercing.
        const white = loop(noiseBuffer(ctx, 'white'), 1.1);
        this.iceBP = f('bandpass', 3200, 0.8);
        const iceLP = f('lowpass', 6500, 0.5);
        this.iceGain = g(0);
        white.connect(this.iceBP).connect(iceLP).connect(this.iceGain).connect(this.out);

        // Powder crunch and its muffled deep-snow twin share one grain texture.
        this.crunchSrc = loop(crunchBuffer(ctx), 0.2);
        this.crunchBP = f('bandpass', 1600, 0.9);
        this.crunchGain = g(0);
        this.crunchSrc.connect(this.crunchBP).connect(this.crunchGain).connect(this.out);
        const deepCrunchLP = f('lowpass', 480, 0.7);
        this.deepCrunchGain = g(0);
        this.crunchSrc.connect(deepCrunchLP).connect(this.deepCrunchGain).connect(this.out);
        const deepSrc = loop(brown, 1.4);
        this.deepLP = f('lowpass', 240, 0.7);
        this.deepGain = g(0);
        deepSrc.connect(this.deepLP).connect(this.deepGain).connect(this.out);

        this.oscs = [this.oscA, this.oscB, this.oscSub, this.wobble, this.am, this.turboOsc, this.squealLfo, this.gustLfo];
        for (const n of this.oscs) n.start(t);
        for (const [n, offset] of this.sources) n.start(t, offset);
        this.stopped = false;
    }

    /** Fade the voice in (from silence). */
    start(t = this.ctx.currentTime, fade = 0.15) {
        this.out.gain.cancelScheduledValues(t);
        this.out.gain.setValueAtTime(0, t);
        this.out.gain.setTargetAtTime(1, t, fade / 3);
    }

    /** Fade out and release every node shortly after. */
    stop(t = this.ctx.currentTime, fade = 0.12) {
        if (this.stopped) return;
        this.stopped = true;
        this.out.gain.cancelScheduledValues(t);
        this.out.gain.setTargetAtTime(0, t, fade / 3);
        const end = t + fade * 3 + 0.05;
        for (const n of this.oscs) n.stop(end);
        for (const [n] of this.sources) n.stop(end);
        // Disconnect after the tail so the graph can be collected.
        const out = this.out;
        if (typeof setTimeout === 'function' && this.ctx.state !== 'closed') {
            const ms = Math.max(0, (end - this.ctx.currentTime) * 1000 + 100);
            setTimeout(() => { try { out.disconnect(); } catch (e) { /* already gone */ } }, ms);
        }
    }

    /** Glide every layer toward the targets from carSoundParams at time t. */
    set(p, t = this.ctx.currentTime) {
        if (this.stopped) return;
        const M = CAR_MIX;
        const f0 = clamp(fin(p.f0, ENGINE_IDLE_HZ), 20, 400);
        const to = (param, v, tau) => param.setTargetAtTime(fin(v), t, tau);
        to(this.oscA.frequency, f0, TAU.pitch);
        to(this.oscB.frequency, f0 * 2, TAU.pitch);
        to(this.oscSub.frequency, f0 / 2, TAU.pitch);
        to(this.am.frequency, f0 / 2, TAU.pitch);
        to(this.rumbleBP.frequency, f0 * 1.5, TAU.pitch);
        to(this.engFilter.frequency, clamp(fin(p.cutoff, 600), 120, 5000), TAU.filter);
        to(this.engGain.gain, clamp(fin(p.engine), 0, 1.2) * M.engine, TAU.gain);
        to(this.rumbleGain.gain, clamp(fin(p.rumble), 0, 1) * M.rumble, TAU.gain);
        to(this.turboOsc.frequency, clamp(fin(p.turboFreq, 1800), 200, 6000), TAU.filter);
        to(this.turboGain.gain, clamp(fin(p.turbo), 0, 1) * M.turbo, TAU.gain * 2);
        to(this.squealGain.gain, clamp(fin(p.squeal), 0, 1) * M.squeal, TAU.gain);
        to(this.squealBP1.frequency, clamp(fin(p.squealFreq, 900), 200, 4000), TAU.filter);
        to(this.squealBP2.frequency, clamp(fin(p.squealFreq, 900), 200, 4000) * 1.6, TAU.filter);
        to(this.rollGain.gain, clamp(fin(p.roll), 0, 1) * M.roll, TAU.gain);
        to(this.iceGain.gain, clamp(fin(p.ice), 0, 1) * M.ice, TAU.gain);
        to(this.crunchGain.gain, clamp(fin(p.crunch), 0, 1) * M.crunch, TAU.gain);
        to(this.crunchSrc.playbackRate, clamp(fin(p.crunchRate, 1), 0.25, 4), TAU.rate);
        to(this.deepGain.gain, clamp(fin(p.deep), 0, 1) * M.deep, TAU.gain);
        to(this.deepCrunchGain.gain, clamp(fin(p.deep), 0, 1) * M.deepCrunch, TAU.gain);
        to(this.windGain.gain, clamp(fin(p.wind), 0, 1.3) * M.wind, TAU.wind);
        to(this.windBP.frequency, clamp(fin(p.windFreq, 500), 100, 4000), TAU.wind);
    }
}
