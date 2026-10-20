// Penguintrack audio: procedural WebAudio only (no sound files). The engine is
// inert until unlock() is called from a user gesture; before that, and
// whenever WebAudio is missing, suspended or the page is hidden, every call is
// a cheap no-op: one-shots are dropped, never queued. The menu-music on/off
// wish is remembered and honoured on unlock.
import { SFX, EFFECT_SOUNDS } from './sfx.js';
import { CarVoice, carSoundParams, makeCarSoundState } from './carvoice.js';
import { MusicBox } from './music.js';
import { reverbBuffer, clamp, fin } from './synth.js';

const MAX_VOICES = 28;          // concurrent one-shots; extra ones are dropped
const LOOKAHEAD = 0.35;         // s of music scheduled ahead of the clock
const PUMP_MS = 60;
const MEDAL_TIERS = ['bronze', 'silver', 'gold', 'emperor'];

/** Slider value 0..1 -> gain (squared: an audio taper, 0.5 is about -12 dB). */
export function taper(v) {
    const x = clamp(fin(v, 0), 0, 1);
    return x * x;
}

/**
 * The shared mix: sfx and music buses with a common snowy reverb, a gentle
 * compressor and a soft clipper that keeps the output below 0.95.
 * Returns { sfx, music, car, sfxVol, sfxWet, musicVol, musicFade, master, input }.
 */
export function buildMix(ctx, destination = ctx.destination) {
    const g = (v) => {
        const n = ctx.createGain();
        n.gain.value = v;
        return n;
    };
    const master = g(1);
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 8;
    comp.ratio.value = 4;
    comp.attack.value = 0.004;
    comp.release.value = 0.2;
    const trim = g(0.8);   // the compressor adds make-up gain; take it back
    const clip = ctx.createWaveShaper();
    clip.curve = limiterCurve();
    clip.oversample = '2x';
    master.connect(comp).connect(trim).connect(clip).connect(destination);

    const reverb = ctx.createConvolver();
    reverb.normalize = false;
    reverb.buffer = reverbBuffer(ctx);
    const reverbOut = g(0.5);
    reverb.connect(reverbOut).connect(master);

    const sfxVol = g(1);
    const sfxWet = g(1);
    sfxVol.connect(master);
    sfxWet.connect(reverb);
    const car = g(1);
    car.connect(sfxVol);

    const musicFade = g(0);
    const musicVol = g(1);
    const musicSend = g(0.4);
    musicFade.connect(musicVol);
    musicVol.connect(master);
    musicVol.connect(musicSend).connect(reverb);

    return {
        master, comp, reverb, sfxVol, sfxWet, car, musicFade, musicVol,
        sfx: { ctx, out: sfxVol, wet: sfxWet },
        music: { ctx, out: musicFade, wet: null },
    };
}

// Linear below 0.7, then a tanh knee that never passes 0.95.
function limiterCurve(n = 2048) {
    const c = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * 2 - 1;
        const a = Math.abs(x);
        const y = a < 0.7 ? a : 0.7 + 0.25 * Math.tanh((a - 0.7) / 0.25);
        c[i] = x < 0 ? -y : y;
    }
    return c;
}

function audioContextClass() {
    const g = globalThis;
    return g.AudioContext || g.webkitAudioContext || null;
}

export class AudioEngine {
    /**
     * opts.volume: initial { master, sfx, music } (0..1).
     * opts.seed: music seed (defaults to a time-based one so menus vary).
     */
    constructor(opts = {}) {
        this.ctx = null;
        this.mix = null;
        this.available = !!audioContextClass();
        this.volume = { master: 0.8, sfx: 0.9, music: 0.55 };
        this._musicOn = false;
        this._musicBox = null;
        this._pump = null;
        this._musicStopTimer = null;
        this._suspended = false;
        this._hidden = typeof document !== 'undefined' && !!document.hidden;
        this._voices = [];
        this._gates = new Map();
        this._car = null;
        this._carState = makeCarSoundState();
        this._carParams = {};
        this._carPos = null;
        this._carQuat = null;
        this._seed = opts.seed != null ? opts.seed >>> 0 : (Date.now() % 1e9) >>> 0;
        this._unlockListeners = null;
        this._warned = false;
        if (opts.volume) this.setVolume(opts.volume);
        this._onVisibility = () => {
            this._hidden = !!document.hidden;
            this._applyRunState();
        };
        if (typeof document !== 'undefined' && document.addEventListener) {
            document.addEventListener('visibilitychange', this._onVisibility);
        }
    }

    /** True once the AudioContext exists and is running (sounds will play). */
    get unlocked() {
        return !!this.ctx && this.ctx.state === 'running';
    }

    /**
     * Create / resume the AudioContext. Call from a user gesture (click, key).
     * Safe to call repeatedly and when WebAudio is unavailable. Returns a
     * promise that resolves to `unlocked`.
     */
    unlock() {
        if (!this.available) return Promise.resolve(false);
        try {
            if (!this.ctx) this._create();
            if (this.ctx.state === 'suspended' && this._wantRunning()) {
                return this.ctx.resume().then(() => this.unlocked, () => false);
            }
        } catch (e) {
            this._warn(e);
            this.available = !!this.ctx;
            return Promise.resolve(false);
        }
        return Promise.resolve(this.unlocked);
    }

    /** Unlock on the first pointer / key / touch on `target` (default window). */
    autoUnlock(target = globalThis) {
        if (this._unlockListeners || !target || !target.addEventListener) return;
        const kinds = ['pointerdown', 'keydown', 'touchend'];
        const handler = () => {
            this.unlock().then((ok) => {
                if (ok) this._removeUnlockListeners();
            });
        };
        this._unlockListeners = { target, kinds, handler };
        for (const k of kinds) target.addEventListener(k, handler, { capture: true, passive: true });
    }

    setVolume({ master, sfx, music } = {}) {
        if (master != null) this.volume.master = clamp(fin(master, this.volume.master), 0, 1);
        if (sfx != null) this.volume.sfx = clamp(fin(sfx, this.volume.sfx), 0, 1);
        if (music != null) this.volume.music = clamp(fin(music, this.volume.music), 0, 1);
        this._applyVolume(0.03);
    }

    // ------------------------------------------------------------- car

    /**
     * Follow the player's car: engine, turbo, tyres, surfaces and wind.
     * carView is sim.car or a snapshotCar copy; dt the seconds since the last
     * call; input (optional, sim.lastInput) gives the exact throttle.
     */
    updateCar(carView, dt, input = null) {
        if (!carView || !this._ready()) return;
        try {
            if (!this._car) {
                this._car = new CarVoice(this.ctx, this.mix.car);
                this._carState = makeCarSoundState();
                this._car.start(this.ctx.currentTime);
            }
            const p = carSoundParams(carView, dt, this._carState, input, this._carParams);
            this._car.set(p, this.ctx.currentTime);
            this._carPos = carView.pos || null;
            this._carQuat = carView.quat || null;
        } catch (e) {
            this._warn(e);
        }
    }

    /** Fade the car out and release its nodes (menus, pause, results). */
    stopCar() {
        if (this._car) {
            try {
                this._car.stop(this.ctx.currentTime);
            } catch (e) {
                this._warn(e);
            }
            this._car = null;
        }
        this._carState = makeCarSoundState();
    }

    /**
     * The car jumped to another moment (a Quick TAS rewind): keep the running
     * voice, so no second engine ever stacks on the first, and only drop the
     * gear, shift and throttle smoothing so it follows the restored car at once.
     */
    resetCar() {
        this._carState = makeCarSoundState();
    }

    // ---------------------------------------------------------- events

    /**
     * Play the sounds for sim.events (any array of core events).
     * opts.checkpointDiff: the split against the best run in ms (negative =
     * ahead) as a number, or a function (event) -> number | null; a checkpoint
     * then chimes brighter when ahead and softer when behind. A checkpoint
     * event carrying `diff` (ms) or `ahead` (bool) itself works too.
     */
    handleEvents(events, opts = null) {
        if (!events || !events.length || !this._ready()) return;
        for (const ev of events) {
            if (ev && typeof ev.type === 'string') this._event(ev, opts);
        }
    }

    _event(ev, opts) {
        switch (ev.type) {
            case 'checkpoint': {
                let diff = ev.diff;
                const cd = opts && opts.checkpointDiff;
                if (typeof cd === 'function') diff = cd(ev);
                else if (typeof cd === 'number') diff = cd;
                let kind = 'neutral';
                if (typeof diff === 'number' && Number.isFinite(diff) && diff !== 0) kind = diff < 0 ? 'good' : 'bad';
                else if (ev.ahead === true) kind = 'good';
                else if (ev.ahead === false) kind = 'bad';
                this._play('checkpoint', { kind });
                break;
            }
            case 'missingCheckpoints':
                if (this._gate('missing', 0.5)) this._play('missing');
                break;
            case 'lap': this._play('lap'); break;
            case 'finish': this._play('finish'); break;
            case 'respawn':
                if (this._gate('respawn', 0.15)) this._play('respawn');
                break;
            case 'fall': this._play('fall'); break;
            case 'boost': this._play('boost', { level: ev.level >= 2 ? 2 : 1 }); break;
            case 'effect': {
                const m = Object.hasOwn(EFFECT_SOUNDS, ev.effect) ? EFFECT_SOUNDS[ev.effect] : null;
                if (m) this._play(m[0], m[1]);
                break;
            }
            case 'land': {
                const strength = fin(ev.strength, 0);
                if (strength >= 1.2 && this._gate('land', 0.08)) this._play('land', { strength });
                break;
            }
            case 'wallhit': {
                // Scraping along a snowbank fires often: at most one hit per 70 ms unless much harder.
                const intensity = fin(ev.intensity, 0);
                const last = this._gates.get('wallhitI') || 0;
                if (this._gate('wallhit', 0.07) || intensity > last * 1.5) {
                    this._gates.set('wallhitI', intensity);
                    this._gates.set('wallhit', this.ctx.currentTime);
                    this._play('wallhit', { intensity, pan: this._panOf(ev.pos) });
                }
                break;
            }
            case 'fragileBreak': this._play('fragileBreak'); break;
            default: break;
        }
    }

    /** Checkpoint chime on its own: 'good' (ahead), 'bad' (behind) or neutral. */
    chime(kind = 'neutral') {
        this._play('checkpoint', { kind });
    }

    /** Countdown beep for 3, 2, 1 (low). */
    countdown(n) {
        // Gated per number, so a caller that repeats it every frame still beeps once.
        if (this._gate('countdown' + n, 0.7)) this._play('countdown', { n });
    }

    /** The high GO beep. */
    go() {
        if (this._gate('go', 0.7)) this._play('go');
    }

    /**
     * Menu sounds: 'click' | 'hover' | 'back' | 'error' | 'medal'.
     * For 'medal', detail is the tier: 'bronze' | 'silver' | 'gold' | 'emperor'.
     */
    ui(kind, detail) {
        switch (kind) {
            case 'hover':
                if (this._gate('hover', 0.04)) this._play('hover');
                break;
            case 'click':
                if (this._gate('click', 0.03)) this._play('click');
                break;
            case 'back': this._play('back'); break;
            case 'error':
                if (this._gate('error', 0.25)) this._play('error');
                break;
            case 'medal': {
                const tier = detail === 'author' ? 'emperor' : MEDAL_TIERS.includes(detail) ? detail : 'gold';
                this._play('medal', { tier });
                break;
            }
            default: break;
        }
    }

    /** Any voice of SFX by name (dev page, other modules). Returns its duration in s (0 if dropped). */
    play(name, opts = {}) {
        return this._play(name, opts);
    }

    // ----------------------------------------------------------- music

    /** Gentle generative snowy loop for menus; fades in and out. */
    music(on) {
        this._musicOn = !!on;
        if (!this.ctx) return;
        const t = this.ctx.currentTime;
        const fade = this.mix.musicFade.gain;
        if (this._musicOn) {
            if (this._musicStopTimer) {
                clearTimeout(this._musicStopTimer);
                this._musicStopTimer = null;
            }
            if (!this._musicBox) {
                this._musicBox = new MusicBox(this._seed);
                this._musicBox.reset(t + 0.1);
            }
            fade.cancelScheduledValues(t);
            fade.setTargetAtTime(1, t, 0.8);
            this._startPump();
        } else if (this._pump) {
            fade.cancelScheduledValues(t);
            fade.setTargetAtTime(0, t, 0.35);
            // Let the tail ring out, then stop scheduling.
            if (!this._musicStopTimer) {
                this._musicStopTimer = setTimeout(() => {
                    this._musicStopTimer = null;
                    if (!this._musicOn) this._stopPump();
                }, 2500);
            }
        }
    }

    // ------------------------------------------------------- lifecycle

    /** Pause all audio (game paused, overlay). */
    suspend() {
        this._suspended = true;
        this._applyRunState();
    }

    resume() {
        this._suspended = false;
        this._applyRunState();
    }

    dispose() {
        this._stopPump();
        if (this._musicStopTimer) clearTimeout(this._musicStopTimer);
        this._removeUnlockListeners();
        if (typeof document !== 'undefined' && document.removeEventListener) {
            document.removeEventListener('visibilitychange', this._onVisibility);
        }
        this.stopCar();
        if (this.ctx) {
            const ctx = this.ctx;
            this.ctx = null;
            this.mix = null;
            try {
                ctx.close().catch(() => {});
            } catch (e) { /* already closed */ }
        }
        this.available = false;
    }

    // -------------------------------------------------------- internals

    _create() {
        const AC = audioContextClass();
        const ctx = new AC({ latencyHint: 'interactive' });
        this.ctx = ctx;
        this.mix = buildMix(ctx);
        this._applyVolume(0);
        ctx.onstatechange = () => {
            // Coming back from a suspension: the music clock may lag; resync it.
            if (ctx.state === 'running' && this._musicBox && this._musicBox.nextTime < ctx.currentTime) {
                this._musicBox.nextTime = ctx.currentTime + 0.05;
            }
        };
        if (this._musicOn) this.music(true);
        if (!this._wantRunning()) this._applyRunState();
    }

    _wantRunning() {
        return !this._hidden && !this._suspended;
    }

    _ready() {
        return !!this.ctx && this.ctx.state === 'running' && this._wantRunning();
    }

    _applyVolume(tau) {
        if (!this.mix) return;
        const t = this.ctx.currentTime;
        const set = (param, v) => {
            if (tau > 0) param.setTargetAtTime(v, t, tau);
            else param.setValueAtTime(v, t);
        };
        const on = this._wantRunning() ? 1 : 0;
        set(this.mix.master.gain, taper(this.volume.master) * on);
        set(this.mix.sfxVol.gain, taper(this.volume.sfx));
        set(this.mix.sfxWet.gain, taper(this.volume.sfx));
        set(this.mix.musicVol.gain, taper(this.volume.music));
    }

    _applyRunState() {
        if (!this.ctx) return;
        const ctx = this.ctx;
        this._applyVolume(0.04);
        if (this._wantRunning()) {
            if (ctx.state === 'suspended') ctx.resume().catch(() => {});
        } else {
            this.stopCar();
            // Fade first so the cut is not a click, then stop the clock.
            setTimeout(() => {
                if (this.ctx === ctx && !this._wantRunning() && ctx.state === 'running') ctx.suspend().catch(() => {});
            }, 150);
        }
    }

    _startPump() {
        if (this._pump) return;
        const tick = () => {
            if (!this.ctx || !this._musicBox || this.ctx.state !== 'running') return;
            const now = this.ctx.currentTime;
            // Never burst missed notes after a stall: skip ahead.
            if (this._musicBox.nextTime < now) this._musicBox.nextTime = now + 0.05;
            try {
                this._musicBox.scheduleUntil(this.mix.music, now + LOOKAHEAD);
            } catch (e) {
                this._warn(e);
            }
        };
        tick();
        this._pump = setInterval(tick, PUMP_MS);
    }

    _stopPump() {
        if (this._pump) clearInterval(this._pump);
        this._pump = null;
    }

    _play(name, opts = {}) {
        if (!Object.hasOwn(SFX, name) || !this._ready()) return 0;
        const fn = SFX[name];
        const now = this.ctx.currentTime;
        this._voices = this._voices.filter((end) => end > now);
        if (this._voices.length >= MAX_VOICES) return 0;
        const t = now + 0.005;
        try {
            const end = fn(this.mix.sfx, t, opts);
            this._voices.push(end);
            return end - t;
        } catch (e) {
            this._warn(e);
            return 0;
        }
    }

    /** True (and re-arms) when `key` has not fired for `gap` seconds. */
    _gate(key, gap) {
        if (!this.ctx) return false;
        const now = this.ctx.currentTime;
        const last = this._gates.get(key);
        if (last != null && now - last < gap && now >= last) return false;
        this._gates.set(key, now);
        return true;
    }

    // Wall hits sound from the side they happen on (car right = local -X).
    _panOf(pos) {
        const p = this._carPos, q = this._carQuat;
        if (!pos || !p || !q) return 0;
        const [x, y, z, w] = q;
        // q * (-1, 0, 0) * q^-1
        const rx = -(1 - 2 * (y * y + z * z));
        const ry = -(2 * (x * y + w * z));
        const rz = -(2 * (x * z - w * y));
        const d = (pos[0] - p[0]) * rx + (pos[1] - p[1]) * ry + (pos[2] - p[2]) * rz;
        return clamp(fin(d, 0) / 1.5, -1, 1) * 0.6;
    }

    _removeUnlockListeners() {
        const l = this._unlockListeners;
        if (!l) return;
        for (const k of l.kinds) l.target.removeEventListener(k, l.handler, { capture: true });
        this._unlockListeners = null;
    }

    _warn(e) {
        if (this._warned) return;
        this._warned = true;
        if (typeof console !== 'undefined') console.warn('[audio]', e && e.message ? e.message : e);
    }
}

export default AudioEngine;
