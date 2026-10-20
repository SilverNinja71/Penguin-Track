// Audio (js/audio): the car-sound mapping on real drives, and the whole engine
// against a strict WebAudio mock that throws wherever browsers throw (non-finite
// values, zero exponential targets, double starts, bad connections). Real
// rendering (levels, NaN, spectra) is checked in headless Chrome by
// dev/audio-demo.html?check=1 with OfflineAudioContext.
import assert from 'node:assert/strict';
import { test, info } from './_harness.mjs';
import { buildWorld } from '../../js/core/track.js';
import { getSample } from '../../js/core/samples.js';
import { Sim } from '../../js/core/sim.js';
import { Autopilot } from '../../js/core/autopilot.js';
import { snapshotCar } from '../../js/core/replay.js';
import { flatWorld } from '../lib/testworlds.mjs';
import { carSoundParams, makeCarSoundState, ENGINE_IDLE_HZ } from '../../js/audio/carvoice.js';
import { SFX, EFFECT_SOUNDS } from '../../js/audio/sfx.js';
import { MusicBox, STEP } from '../../js/audio/music.js';
import { AudioEngine, buildMix, taper } from '../../js/audio/audio.js';

const PARAM_KEYS = ['f0', 'engine', 'cutoff', 'rumble', 'turbo', 'turboFreq', 'squeal', 'squealFreq', 'roll', 'ice',
    'crunch', 'deep', 'crunchRate', 'wind', 'windFreq'];

function semitones(a, b) {
    return 12 * Math.log2(a / b);
}

/** Drives a sample with the autopilot, calling fn(sim, input) every tick. */
function drive(id, ticks, fn) {
    const world = buildWorld(getSample(id));
    const sim = new Sim(world);
    const ap = new Autopilot(world);
    for (let i = 0; i < ticks && !sim.finished; i++) {
        const inp = ap.act(sim);
        sim.step(inp);
        fn(sim, sim.lastInput);
    }
    return sim;
}

test('car sound params stay finite and in range on every sample drive', () => {
    for (const id of ['S01', 'S02', 'S03', 'S04', 'S05', 'S06']) {
        const st = makeCarSoundState();
        const p = {};
        const seen = { squeal: 0, ice: 0, crunch: 0, deep: 0, turbo: 0, wind: 0, air: 0 };
        drive(id, 2600, (sim, inp) => {
            carSoundParams(sim.car, 0.01, st, inp, p);
            for (const k of PARAM_KEYS) assert.ok(Number.isFinite(p[k]), `${id} ${k} = ${p[k]}`);
            assert.ok(p.f0 >= 20 && p.f0 <= 400, `${id} f0 ${p.f0}`);
            for (const k of ['engine', 'rumble', 'turbo', 'squeal', 'roll', 'ice', 'crunch', 'deep']) {
                assert.ok(p[k] >= 0 && p[k] <= 1.2, `${id} ${k} ${p[k]}`);
            }
            for (const k of Object.keys(seen)) if (k !== 'air') seen[k] = Math.max(seen[k], p[k]);
            if (sim.car.airborne) {
                seen.air++;
                assert.equal(p.squeal + p.roll + p.ice + p.crunch + p.deep, 0, 'no tyre noise in the air');
            }
        });
        info(id, Object.entries(seen).map(([k, v]) => `${k} ${typeof v === 'number' ? +v.toFixed(2) : v}`).join(', '));
        assert.ok(seen.wind > 0.3, `${id}: wind rises with speed`);
        if (id === 'S03') {
            assert.ok(seen.turbo > 0.3, 'S03 has a Frost Boost');
            assert.ok(seen.air > 20, 'S03 jumps');
        }
        if (id === 'S05') {
            assert.ok(seen.ice > 0.2, 'S05 ice hiss');
            assert.ok(seen.crunch > 0.2, 'S05 powder crunch');
        }
    }
});

test('engine pitch follows speed with small dips on upshifts', () => {
    const world = flatWorld({ surface: 'snow' });
    const sim = new Sim(world, { allowNoSpawn: true });
    const st = makeCarSoundState();
    const p = {};
    let prevF = 0, prevGear = 1, shifts = 0, maxF = 0;
    const dips = [];
    for (let i = 0; i < 1400; i++) {
        sim.step({ steer: 0, gas: true, brake: false });
        carSoundParams(sim.car, 0.01, st, sim.lastInput, p);
        if (sim.car.gear > prevGear) {
            shifts++;
            dips.push(semitones(prevF, p.f0));
        }
        prevGear = sim.car.gear;
        prevF = p.f0;
        maxF = Math.max(maxF, p.f0);
    }
    info(`top speed ${sim.car.speedKmh.toFixed(0)} km/h, f0 ${ENGINE_IDLE_HZ} -> ${maxF.toFixed(1)} Hz, upshift dips ${dips.map((d) => d.toFixed(1)).join(' ')} st`);
    assert.equal(shifts, 5, 'five upshifts to sixth gear');
    for (const d of dips) assert.ok(d > 1.5 && d < 4.5, `dip ${d.toFixed(2)} semitones`);
    assert.ok(maxF > ENGINE_IDLE_HZ * 1.9 && maxF < ENGINE_IDLE_HZ * 2.6, `top pitch ${maxF}`);
});

test('throttle load: gas is louder than coasting, gas estimate works without input', () => {
    const world = flatWorld({ surface: 'snow' });
    const sim = new Sim(world, { allowNoSpawn: true });
    for (let i = 0; i < 300; i++) sim.step({ steer: 0, gas: true, brake: false });
    const snap = snapshotCar(sim.car);
    const onGas = carSoundParams(snap, 0.01, makeCarSoundState(), { gas: true, brake: false }, {});
    const coast = carSoundParams(snap, 0.01, makeCarSoundState(), { gas: false, brake: false }, {});
    assert.ok(onGas.engine > coast.engine * 1.3 && onGas.cutoff > coast.cutoff * 1.5, 'load opens the engine');
    // No input: the estimate from acceleration (a snapshot has no gasHeld).
    const st = makeCarSoundState();
    let est = {};
    for (let i = 0; i < 30; i++) {
        sim.step({ steer: 0, gas: true, brake: false });
        est = carSoundParams(snapshotCar(sim.car), 0.01, st, null, est);
    }
    assert.ok(st.gas > 0.9, `estimated gas while accelerating ${st.gas}`);
    for (let i = 0; i < 60; i++) {
        sim.step({ steer: 0, gas: false, brake: false });
        est = carSoundParams(snapshotCar(sim.car), 0.01, st, null, est);
    }
    assert.ok(st.gas < 0.1, `estimated gas while coasting ${st.gas}`);
});

test('drifting on packed snow squeals, ice hisses instead, deep snow rumbles', () => {
    for (const surface of ['snow', 'ice', 'ground', 'powder']) {
        const world = flatWorld({ surface });
        const sim = new Sim(world, { allowNoSpawn: true });
        const st = makeCarSoundState();
        let p = {};
        let squeal = 0, ice = 0, deep = 0, crunch = 0, drifted = false;
        for (let i = 0; i < 900; i++) {
            const t = i / 100;
            const inp = t < 6 ? { steer: 0, gas: true, brake: false }
                : t < 6.1 ? { steer: 65536, gas: false, brake: true } : { steer: 65536, gas: true, brake: false };
            sim.step(inp);
            p = carSoundParams(sim.car, 0.01, st, sim.lastInput, p);
            drifted ||= sim.car.drifting;
            if (t > 6) squeal = Math.max(squeal, p.squeal);
            ice = Math.max(ice, p.ice); deep = Math.max(deep, p.deep); crunch = Math.max(crunch, p.crunch);
        }
        info(`${surface}: drift ${drifted}, squeal ${squeal.toFixed(2)}, ice ${ice.toFixed(2)}, deep ${deep.toFixed(2)}, crunch ${crunch.toFixed(2)}`);
        if (surface === 'snow') assert.ok(drifted && squeal > 0.5, 'snow drift squeals');
        if (surface === 'ice') assert.ok(squeal === 0 && ice > 0.5, 'ice hisses, never squeals');
        if (surface === 'ground') assert.ok(deep > 0.5, 'deep snow rumble');
        if (surface === 'powder') assert.ok(crunch > 0.5, 'powder crunch');
    }
});

test('frozen engine silences the engine; boosts whine and fade', () => {
    const view = {
        speedKmh: 120, speed: 33, forwardSpeed: 33, rpm: 0.6, gear: 3, airborne: false, drifting: false,
        surfaceUnder: 'snow', wheels: [0, 1, 2, 3].map(() => ({ contact: true, surface: 'snow', slip: 0 })),
        effects: { turbo: 0, turboTime: 0, noEngine: false },
    };
    const normal = carSoundParams(view, 0.016, makeCarSoundState(), { gas: true }, {});
    const frozen = carSoundParams({ ...view, effects: { noEngine: true } }, 0.016, makeCarSoundState(), { gas: true }, {});
    assert.ok(frozen.engine < normal.engine * 0.3 && frozen.f0 < normal.f0, 'Frozen Engine idles quietly');
    const frost = carSoundParams({ ...view, effects: { turbo: 1, turboTime: 2 } }, 0.016, makeCarSoundState(), { gas: true }, {});
    const aval = carSoundParams({ ...view, effects: { turbo: 2, turboTime: 2 } }, 0.016, makeCarSoundState(), { gas: true }, {});
    const late = carSoundParams({ ...view, effects: { turbo: 2, turboTime: 0.2 } }, 0.016, makeCarSoundState(), { gas: true }, {});
    assert.ok(aval.turbo > frost.turbo && frost.turbo > 0.5 && late.turbo < 0.15 && normal.turbo === 0);
    // Garbage in never makes NaN out.
    const junk = carSoundParams({ speedKmh: NaN, rpm: undefined, gear: Infinity, wheels: [null, {}], effects: { slowmo: 9 } },
        NaN, makeCarSoundState(), null, {});
    for (const k of PARAM_KEYS) assert.ok(Number.isFinite(junk[k]), `junk ${k}`);
});

// --------------------------------------------------------------- WebAudio mock

class Param {
    constructor(ctx, value) {
        this.ctx = ctx;
        this._v = value;
        this.events = 0;
    }
    get value() { return this._v; }
    set value(v) {
        if (!Number.isFinite(v)) throw new TypeError(`AudioParam.value = ${v}`);
        this._v = v;
    }
    _check(v, t) {
        if (!Number.isFinite(v) || !Number.isFinite(t)) throw new TypeError(`non-finite automation ${v} @ ${t}`);
        if (t < 0) throw new RangeError(`negative time ${t}`);
        this.events++;
        this.ctx.automations++;
    }
    setValueAtTime(v, t) { this._check(v, t); this._v = v; return this; }
    linearRampToValueAtTime(v, t) { this._check(v, t); this._v = v; return this; }
    exponentialRampToValueAtTime(v, t) {
        this._check(v, t);
        if (v === 0) throw new RangeError('exponential ramp to 0');
        this._v = v;
        return this;
    }
    setTargetAtTime(v, t, tau) {
        this._check(v, t);
        if (!Number.isFinite(tau) || tau < 0) throw new RangeError(`timeConstant ${tau}`);
        return this;
    }
    cancelScheduledValues(t) { this._check(0, t); return this; }
    cancelAndHoldAtTime(t) { this._check(0, t); return this; }
}

class Node {
    constructor(ctx, params = {}) {
        this.context = ctx;
        this.outputs = [];
        for (const [k, v] of Object.entries(params)) this[k] = new Param(ctx, v);
        ctx.nodes++;
    }
    connect(dest) {
        if (!(dest instanceof Node) && !(dest instanceof Param)) throw new TypeError('connect to a non-node');
        if (dest.ctx && dest.ctx !== this.context) throw new Error('cross-context connect');
        if (dest.context && dest.context !== this.context) throw new Error('cross-context connect');
        this.outputs.push(dest);
        return dest instanceof Node ? dest : undefined;
    }
    disconnect() { this.outputs = []; }
}

class Scheduled extends Node {
    constructor(ctx, params) {
        super(ctx, params);
        this.started = null;
        this.stopped = null;
    }
    start(t = 0, offset = 0) {
        if (this.started !== null) throw new Error('InvalidStateError: start twice');
        if (!Number.isFinite(t) || t < 0 || !Number.isFinite(offset) || offset < 0) throw new RangeError(`start(${t}, ${offset})`);
        this.started = t;
        this.context.sources++;
    }
    stop(t = 0) {
        if (this.started === null) throw new Error('InvalidStateError: stop before start');
        if (!Number.isFinite(t) || t < 0) throw new RangeError(`stop(${t})`);
        this.stopped = t;
    }
}

const OSC_TYPES = ['sine', 'square', 'sawtooth', 'triangle'];
const FILTER_TYPES = ['lowpass', 'highpass', 'bandpass', 'lowshelf', 'highshelf', 'peaking', 'notch', 'allpass'];

class MockAudioContext {
    constructor() {
        this.sampleRate = 8000;   // small buffers keep the test fast
        this.currentTime = 0;
        this.state = 'running';
        this.nodes = 0;
        this.sources = 0;
        this.automations = 0;
        this.buffers = [];
        this.destination = new Node(this);
        this.onstatechange = null;
        MockAudioContext.last = this;
    }
    resume() { this.state = 'running'; return Promise.resolve(); }
    suspend() { this.state = 'suspended'; return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
    createGain() { return new Node(this, { gain: 1 }); }
    createOscillator() {
        const o = new Scheduled(this, { frequency: 440, detune: 0 });
        let type = 'sine';
        Object.defineProperty(o, 'type', { get: () => type, set: (v) => { if (!OSC_TYPES.includes(v)) throw new TypeError(v); type = v; } });
        return o;
    }
    createBiquadFilter() {
        const f = new Node(this, { frequency: 350, Q: 1, detune: 0, gain: 0 });
        let type = 'lowpass';
        Object.defineProperty(f, 'type', { get: () => type, set: (v) => { if (!FILTER_TYPES.includes(v)) throw new TypeError(v); type = v; } });
        return f;
    }
    createBufferSource() {
        const s = new Scheduled(this, { playbackRate: 1, detune: 0 });
        s.buffer = null;
        s.loop = false;
        const start = s.start.bind(s);
        s.start = (t, offset = 0) => {
            if (!s.buffer) throw new Error('start without buffer');
            start(t, offset);
        };
        return s;
    }
    createBuffer(channels, length, sampleRate) {
        if (!(channels >= 1) || !(length >= 1) || !(sampleRate > 0)) throw new RangeError('createBuffer');
        const data = Array.from({ length: channels }, () => new Float32Array(length));
        const buf = { numberOfChannels: channels, length, sampleRate, duration: length / sampleRate, getChannelData: (c) => data[c] };
        this.buffers.push(buf);
        return buf;
    }
    createWaveShaper() {
        const n = new Node(this);
        n.curve = null;
        n.oversample = 'none';
        return n;
    }
    createDynamicsCompressor() { return new Node(this, { threshold: -24, knee: 30, ratio: 12, attack: 0.003, release: 0.25 }); }
    createConvolver() {
        const n = new Node(this);
        n.normalize = true;
        n.buffer = null;
        return n;
    }
    createStereoPanner() { return new Node(this, { pan: 0 }); }
}

/** Every noise / texture / impulse buffer the voices made is finite, bounded and not silent. */
function checkBuffers(ctx) {
    assert.ok(ctx.buffers.length >= 4, `${ctx.buffers.length} buffers`);
    for (const b of ctx.buffers) {
        for (let c = 0; c < b.numberOfChannels; c++) {
            const d = b.getChannelData(c);
            let peak = 0;
            for (let i = 0; i < d.length; i++) {
                assert.ok(Number.isFinite(d[i]), 'finite buffer sample');
                peak = Math.max(peak, Math.abs(d[i]));
            }
            assert.ok(peak > 1e-4 && peak <= 0.95, `buffer peak ${peak}`);
        }
    }
}

test('every SFX voice schedules cleanly on a strict WebAudio mock', () => {
    const ctx = new MockAudioContext();
    const mix = buildMix(ctx);
    const variants = {
        checkpoint: [{}, { kind: 'good' }, { kind: 'bad' }], boost: [{ level: 1 }, { level: 2 }],
        land: [{ strength: 0 }, { strength: 8 }, { strength: 40 }, { strength: NaN }],
        wallhit: [{ intensity: 2 }, { intensity: 12, pan: -1 }, { intensity: 80, pan: 1 }, { intensity: undefined }],
        medal: [{ tier: 'bronze' }, { tier: 'silver' }, { tier: 'gold' }, { tier: 'emperor' }, {}],
        frozen: [{ pitch: 0.8 }, { pitch: 1.2 }],
    };
    let count = 0;
    for (const [name, fn] of Object.entries(SFX)) {
        for (const opts of variants[name] || [{}]) {
            const before = ctx.nodes;
            ctx.currentTime += 1;
            const end = fn(mix.sfx, ctx.currentTime, opts);
            assert.ok(Number.isFinite(end) && end > ctx.currentTime && end < ctx.currentTime + 6, `${name} end ${end}`);
            assert.ok(ctx.nodes - before < 400, `${name} uses ${ctx.nodes - before} nodes`);
            count++;
        }
    }
    for (const [effect, [name]] of Object.entries(EFFECT_SOUNDS)) assert.ok(SFX[name], `${effect} -> ${name}`);
    info(`${count} voice variants, ${ctx.nodes} nodes, ${ctx.automations} automation events`);
    checkBuffers(ctx);
});

test('music box schedules sparse notes ahead of the clock', () => {
    const ctx = new MockAudioContext();
    const mix = buildMix(ctx);
    const box = new MusicBox(7);
    box.reset(0.1);
    const sources = ctx.sources;
    box.scheduleUntil(mix.music, 60);
    assert.equal(box.step, 64, 'one call schedules at most 64 steps (a stalled clock never floods)');
    while (box.nextTime < 60) box.scheduleUntil(mix.music, 60);
    const perSecond = (ctx.sources - sources) / 60;
    info(`60 s of music: ${box.step} steps, ${(ctx.sources - sources)} sources (${perSecond.toFixed(1)}/s)`);
    assert.ok(Math.abs(box.step * STEP - 59.9) < STEP + 1e-9);
    assert.ok(perSecond > 3 && perSecond < 40, 'sparse but alive');
    // Deterministic for a seed.
    const a = new MusicBox(3), b = new MusicBox(3);
    const ca = new MockAudioContext(), cb = new MockAudioContext();
    const ma = buildMix(ca), mb = buildMix(cb);
    while (a.nextTime < 30) a.scheduleUntil(ma.music, 30);
    while (b.nextTime < 30) b.scheduleUntil(mb.music, 30);
    assert.equal(ca.nodes, cb.nodes);
});

test('AudioEngine is a silent no-op without WebAudio', async () => {
    assert.equal(globalThis.AudioContext, undefined);
    const a = new AudioEngine();
    assert.equal(a.available, false);
    assert.equal(await a.unlock(), false);
    a.setVolume({ master: 0.5, sfx: 2, music: -1 });
    assert.deepEqual(a.volume, { master: 0.5, sfx: 1, music: 0 });
    a.updateCar({ speedKmh: 100 }, 0.016);
    a.handleEvents([{ type: 'finish' }, null, { type: 'wallhit', intensity: 9 }]);
    a.handleEvents(null);
    a.countdown(3); a.go(); a.chime('good');
    for (const k of ['click', 'hover', 'back', 'medal', 'error', 'nope']) a.ui(k, 'emperor');
    a.music(true); a.music(false); a.stopCar(); a.suspend(); a.resume();
    assert.equal(a.play('finish'), 0);
    a.dispose();
    assert.equal(taper(0.5), 0.25);
});

test('AudioEngine drives a full race on the mock: car, events, music, lifecycle', async () => {
    globalThis.AudioContext = MockAudioContext;
    try {
        const a = new AudioEngine({ seed: 5, volume: { master: 1, sfx: 1, music: 1 } });
        a.music(true);   // wished before unlock: starts on unlock
        a.handleEvents([{ type: 'finish' }]);
        assert.equal(a.ctx, null, 'nothing exists before unlock');
        assert.equal(await a.unlock(), true);
        const ctx = MockAudioContext.last;
        assert.ok(a._pump, 'music pump started on unlock');

        // Countdown, then a whole S03 drive with every tick's events.
        a.countdown(3); a.countdown(2); a.countdown(1); a.go();
        const seen = new Set();
        let played = 0;
        drive('S03', 2600, (sim, inp) => {
            ctx.currentTime += 0.01;
            a.updateCar(sim.car, 0.01, inp);
            for (const ev of sim.events || []) seen.add(ev.type);
            const before = ctx.sources;
            a.handleEvents(sim.events);
            if (ctx.sources > before) played++;
        });
        info(`events seen: ${[...seen].join(', ')}; ${played} ticks played sounds; ${ctx.nodes} nodes, ${ctx.automations} automations`);
        assert.ok(seen.has('checkpoint') && seen.has('finish') && seen.has('boost') && seen.has('land'));
        assert.ok(played >= seen.size - 1);

        // Every event type, including ones this drive did not produce and odd payloads.
        a.handleEvents([
            { type: 'checkpoint', diff: -120 }, { type: 'checkpoint', diff: 80 }, { type: 'checkpoint', ahead: true },
            { type: 'missingCheckpoints', missing: [1] }, { type: 'lap', lap: 1 }, { type: 'respawn', checkpoint: -1 },
            { type: 'fall' }, { type: 'boost', level: 2 }, { type: 'effect', effect: 'turbo' },
            ...Object.keys(EFFECT_SOUNDS).map((effect) => ({ type: 'effect', effect })),
            { type: 'land', strength: 30, airTime: 1 }, { type: 'wallhit', intensity: 25, pos: [1, 2, 3] },
            { type: 'fragileBreak', cause: 'wall' }, { type: 'mystery' }, { type: 'wallhit', intensity: NaN, pos: null },
        ]);
        for (const k of ['click', 'hover', 'back', 'error']) a.ui(k);
        for (const tier of ['bronze', 'silver', 'gold', 'emperor', 'author', undefined]) a.ui('medal', tier);
        a.chime('bad');

        // Voice cap: a flood is dropped, not queued.
        let dropped = 0;
        for (let i = 0; i < 100; i++) if (a.play('finish') === 0) dropped++;
        assert.ok(dropped > 50, `flood dropped ${dropped}`);

        a.stopCar();
        assert.equal(a._car, null);
        a.updateCar(snapshotCar(new Sim(buildWorld(getSample('S01'))).car), 0.016);
        assert.ok(a._car, 'car voice comes back on the next update');

        // Hidden page or pause: everything gated, the context suspends, then comes back.
        a.suspend();
        await new Promise((r) => setTimeout(r, 200));
        assert.equal(ctx.state, 'suspended');
        const n = ctx.sources;
        a.handleEvents([{ type: 'finish' }]);
        a.ui('click');
        assert.equal(ctx.sources, n, 'nothing plays while suspended');
        a.resume();
        await new Promise((r) => setTimeout(r, 10));
        assert.equal(ctx.state, 'running');

        a.music(false);
        a.setVolume({ master: 0, sfx: 0.3, music: 0.2 });
        a.dispose();
        assert.equal(ctx.state, 'closed');
        assert.equal(a._pump, null);
    } finally {
        delete globalThis.AudioContext;
    }
});

test('a locked context (no gesture yet) plays and queues nothing until it runs', async () => {
    class LockedContext extends MockAudioContext {
        constructor() {
            super();
            this.state = 'suspended';
        }
        resume() { return Promise.reject(new Error('NotAllowedError')); }
    }
    globalThis.AudioContext = LockedContext;
    try {
        const a = new AudioEngine({ seed: 9 });
        a.music(true);
        assert.equal(await a.unlock(), false, 'resume refused');
        const ctx = MockAudioContext.last;
        const n = ctx.sources;
        a.handleEvents([{ type: 'finish' }, { type: 'boost', level: 2 }]);
        a.countdown(3); a.go(); a.ui('click'); a.ui('medal', 'emperor');
        a.updateCar({ speedKmh: 100, rpm: 0.5, gear: 3 }, 0.016);
        await new Promise((r) => setTimeout(r, 150));   // a couple of music pump ticks
        assert.equal(ctx.sources, n, 'nothing scheduled while locked');
        assert.equal(a._car, null);
        // The gesture lands: from now on sounds play, and nothing from before bursts out.
        ctx.state = 'running';
        a.handleEvents([{ type: 'checkpoint' }]);
        assert.ok(ctx.sources > n);
        assert.equal(a._voices.length, 1, 'only the new chime');
        a.dispose();
    } finally {
        delete globalThis.AudioContext;
    }
});

test('checkpoint split chimes, gated countdown, unknown names', async () => {
    globalThis.AudioContext = MockAudioContext;
    const orig = { checkpoint: SFX.checkpoint, countdown: SFX.countdown };
    const kinds = [];
    let beeps = 0;
    SFX.checkpoint = (bus, t, o) => { kinds.push(o.kind); return orig.checkpoint(bus, t, o); };
    SFX.countdown = (bus, t, o) => { beeps++; return orig.countdown(bus, t, o); };
    try {
        const a = new AudioEngine();
        await a.unlock();
        const ctx = MockAudioContext.last;
        const cp = { type: 'checkpoint', id: 0 };
        a.handleEvents([cp]);
        a.handleEvents([cp], { checkpointDiff: -40 });
        a.handleEvents([cp], { checkpointDiff: (ev) => (ev.id === 0 ? 250 : null) });
        a.handleEvents([{ ...cp, ahead: true }]);
        a.handleEvents([cp], { checkpointDiff: () => null });
        assert.deepEqual(kinds, ['neutral', 'good', 'bad', 'good', 'neutral']);
        // A shell that repeats countdown(n) every frame still beeps once per number.
        for (let f = 0; f < 60; f++) {
            ctx.currentTime += 1 / 60;
            a.countdown(3 - Math.floor(f / 20));
        }
        assert.equal(beeps, 3);
        const n = ctx.sources;
        assert.equal(a.play('toString'), 0);
        assert.equal(a.play('__proto__'), 0);
        a.handleEvents([{ type: 'effect', effect: 'constructor' }, { type: 'effect', effect: 'turbo' }]);
        a.ui('constructor');
        assert.equal(ctx.sources, n, 'prototype names never play');
        a.dispose();
    } finally {
        Object.assign(SFX, orig);
        delete globalThis.AudioContext;
    }
});

test('a Quick TAS rewind keeps one engine voice: resetCar never stacks audio nodes', async () => {
    globalThis.AudioContext = MockAudioContext;
    try {
        const a = new AudioEngine({ seed: 3 });
        assert.equal(await a.unlock(), true);
        const ctx = MockAudioContext.last;
        const sim = new Sim(buildWorld(getSample('S01')));
        const step = () => {
            sim.step({ steer: 0, gas: true, brake: false });
            ctx.currentTime += 0.01;
            a.updateCar(sim.car, 0.01, sim.lastInput);
        };
        for (let i = 0; i < 50; i++) step();
        const voice = a._car, nodes = ctx.nodes, sources = ctx.sources;
        const saved = sim.getState();
        // Thirty rewinds in a row, as fast as a player can press R.
        for (let r = 0; r < 30; r++) {
            sim.setState(saved);
            a.resetCar();
            for (let i = 0; i < 5; i++) step();
        }
        assert.equal(a._car, voice, 'the same voice keeps playing');
        assert.equal(ctx.nodes, nodes, 'no new audio nodes');
        assert.equal(ctx.sources, sources, 'no new sources');
        assert.ok(nodes > 20, `the voice built its graph (${nodes} nodes)`);
        // A stopped car (pause, results) does build a fresh voice next time: that is the one other path.
        a.stopCar();
        step();
        assert.notEqual(a._car, voice);
        assert.ok(ctx.nodes > nodes);
        a.dispose();
    } finally {
        delete globalThis.AudioContext;
    }
});
