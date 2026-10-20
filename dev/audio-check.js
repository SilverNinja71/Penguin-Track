// Offline render checks for js/audio: every voice, the car on real drives and
// the menu music are rendered with OfflineAudioContext, both straight to the
// output ("raw", no limiter) and through the game's full mix at full volume,
// then measured: no NaN, peaks under the cap, loudness in a sane range, sound
// where sound is expected, silence after the tail. Each row draws a waveform
// and a log-frequency spectrogram so the sounds can be judged by eye.
import { SFX, EFFECT_SOUNDS } from '../js/audio/sfx.js';
import { CarVoice, carSoundParams, makeCarSoundState } from '../js/audio/carvoice.js';
import { MusicBox } from '../js/audio/music.js';
import { buildMix } from '../js/audio/audio.js';
import { seedVoices, reverbBuffer } from '../js/audio/synth.js';
import { buildWorld } from '../js/core/track.js';
import { getSample } from '../js/core/samples.js';
import { Sim } from '../js/core/sim.js';
import { Autopilot } from '../js/core/autopilot.js';

const SR = 44100;
const RAW_PEAK = 0.9;        // a voice alone must stay under this without any limiter
const MIX_PEAK = 0.95;

// --------------------------------------------------------------- cases

const sfx = (name, opts = {}, rms = [0.01, 0.3]) => ({
    group: 'sfx', name: name + (Object.keys(opts).length ? ' ' + JSON.stringify(opts).replace(/["{}]/g, '') : ''),
    rms, seconds: 0, voice: name, opts,
});

export function checkCases() {
    const c = [
        sfx('checkpoint'), sfx('checkpoint', { kind: 'good' }), sfx('checkpoint', { kind: 'bad' }),
        sfx('lap'), sfx('finish'), sfx('countdown'), sfx('go'), sfx('respawn'),
        sfx('boost', { level: 1 }), sfx('boost', { level: 2 }),
        sfx('frozen', { pitch: 0.8 }), sfx('frozen', { pitch: 1.2 }), sfx('thaw'), sfx('globe'), sfx('glide'), sfx('thinIce'),
        sfx('land', { strength: 2 }, [0.004, 0.3]), sfx('land', { strength: 10 }), sfx('land', { strength: 30 }),
        sfx('wallhit', { intensity: 3 }, [0.005, 0.3]), sfx('wallhit', { intensity: 12, pan: -0.6 }), sfx('wallhit', { intensity: 40, pan: 0.6 }),
        sfx('fragileBreak'), sfx('missing'), sfx('fall'),
        sfx('click'), sfx('hover', {}, [0.002, 0.1]), sfx('back'), sfx('error'),
        sfx('medal', { tier: 'bronze' }), sfx('medal', { tier: 'silver' }), sfx('medal', { tier: 'gold' }), sfx('medal', { tier: 'emperor' }),
    ];
    c.push(
        { group: 'car', name: 'car: idle, then full gas on packed snow', seconds: 9, rms: [0.02, 0.25], car: synthDrive('snow') },
        { group: 'car', name: 'car: powder slide', seconds: 7, rms: [0.02, 0.25], car: synthDrive('powder') },
        { group: 'car', name: 'car: ice slide', seconds: 7, rms: [0.02, 0.25], car: synthDrive('ice') },
        { group: 'car', name: 'car: deep snow', seconds: 7, rms: [0.02, 0.25], car: synthDrive('ground') },
        { group: 'car', name: 'car: S03 autopilot (jumps, loop, boost) + events', seconds: 14, rms: [0.02, 0.25], drive: 'S03' },
        { group: 'car', name: 'car: S05 autopilot (ice, powder) + events', seconds: 14, rms: [0.02, 0.25], drive: 'S05' },
        { group: 'music', name: 'music: seed 1', seconds: 40, rms: [0.004, 0.08], music: 1 },
        { group: 'music', name: 'music: seed 2', seconds: 40, rms: [0.004, 0.08], music: 2 },
    );
    return c;
}

/** Synthetic car views: idle, a launch through the gears, then a slide on one surface. */
function synthDrive(surface) {
    return (t) => {
        const launch = surface === 'snow' ? 1.5 : 0.5;
        const kmh = t < launch ? 0 : Math.min(260, 70 * Math.pow(t - launch, 0.8) * (surface === 'ground' ? 0.45 : 1));
        const gears = [0, 45, 90, 140, 190, 245];
        let g = 1;
        while (g < 6 && kmh >= gears[g]) g++;
        const hi = g < 6 ? gears[g] : 340;
        const rpm = t < launch ? 0.25 : 0.25 + 0.75 * Math.min(1, (kmh - gears[g - 1]) / (hi - gears[g - 1]));
        const sliding = t > 4.5 && t < 6.5;
        const slip = sliding ? 0.8 : 0.05;
        return {
            view: {
                speedKmh: kmh, speed: kmh / 3.6, forwardSpeed: kmh / 3.6, rpm, gear: g, airborne: false,
                drifting: sliding && surface !== 'ice', surfaceUnder: surface,
                wheels: [0, 1, 2, 3].map(() => ({ contact: true, surface, slip })),
                effects: { turbo: 0, turboTime: 0 },
            },
            input: { gas: t >= launch * 0.5, brake: false },
        };
    };
}

// ------------------------------------------------------------ rendering

function rawMix(ctx) {
    const reverb = ctx.createConvolver();
    reverb.normalize = false;
    reverb.buffer = reverbBuffer(ctx);
    const wetOut = ctx.createGain();
    wetOut.gain.value = 0.5;
    reverb.connect(wetOut).connect(ctx.destination);
    const musicIn = ctx.createGain();
    const send = ctx.createGain();
    send.gain.value = 0.4;
    musicIn.connect(ctx.destination);
    musicIn.connect(send).connect(reverb);
    return {
        sfx: { ctx, out: ctx.destination, wet: reverb },
        music: { ctx, out: musicIn, wet: null },
        car: ctx.destination,
    };
}

function fullMix(ctx) {
    const m = buildMix(ctx);
    m.musicFade.gain.value = 1;
    return m;
}

async function render(c, mode) {
    seedVoices(1234);
    let seconds = c.seconds;
    if (c.voice) {
        // Dry run to learn the length, then render with 2.4 s for the reverb tail.
        const probe = new OfflineAudioContext(1, 128, SR);
        seedVoices(1234);
        const end = SFX[c.voice](rawMix(probe).sfx, 0.05, c.opts);
        seconds = end + 2.4;
        seedVoices(1234);
    }
    const ctx = new OfflineAudioContext(2, Math.ceil(SR * seconds), SR);
    const mix = mode === 'raw' ? rawMix(ctx) : fullMix(ctx);
    let info = '';
    if (c.voice) {
        SFX[c.voice](mix.sfx, 0.05, c.opts);
    } else if (c.car) {
        const voice = new CarVoice(ctx, mix.car);
        voice.start(0);
        const st = makeCarSoundState();
        const p = {};
        for (let t = 0; t < seconds; t += 1 / 60) {
            const { view, input } = c.car(t);
            voice.set(carSoundParams(view, 1 / 60, st, input, p), t);
        }
    } else if (c.drive) {
        info = scheduleDrive(ctx, mix, c.drive, seconds);
    } else if (c.music) {
        const box = new MusicBox(c.music);
        box.reset(0.1);
        while (box.nextTime < seconds - 2) box.scheduleUntil(mix.music, seconds - 2);
    }
    const buf = await ctx.startRendering();
    return { buf, info };
}

/** A real autopilot drive: the car voice follows every other tick, events play at their tick. */
function scheduleDrive(ctx, mix, id, seconds) {
    const world = buildWorld(getSample(id));
    const sim = new Sim(world);
    const pilot = new Autopilot(world);
    const voice = new CarVoice(ctx, mix.car);
    voice.start(0);
    const st = makeCarSoundState();
    const p = {};
    const counts = {};
    const t0 = 0.3;
    const ticks = Math.floor((seconds - 1.5) * 100);
    for (let i = 0; i < ticks && !sim.finished; i++) {
        sim.step(pilot.act(sim));
        const t = t0 + i * 0.01;
        carSoundParams(sim.car, 0.01, st, sim.lastInput, p);
        if (i % 2 === 0) voice.set(p, t);
        for (const ev of sim.events || []) {
            counts[ev.type] = (counts[ev.type] || 0) + 1;
            const spec = eventVoice(ev);
            if (spec) SFX[spec[0]](mix.sfx, t, spec[1]);
        }
    }
    voice.stop(t0 + ticks * 0.01);
    return Object.entries(counts).map(([k, v]) => `${k}×${v}`).join(' ');
}

function eventVoice(ev) {
    switch (ev.type) {
        case 'checkpoint': return ['checkpoint', {}];
        case 'finish': return ['finish', {}];
        case 'lap': return ['lap', {}];
        case 'boost': return ['boost', { level: ev.level }];
        case 'effect': return EFFECT_SOUNDS[ev.effect] || null;
        case 'land': return ev.strength >= 1.2 ? ['land', { strength: ev.strength }] : null;
        case 'wallhit': return ['wallhit', { intensity: ev.intensity }];
        case 'respawn': return ['respawn', {}];
        case 'fragileBreak': return ['fragileBreak', {}];
        default: return null;
    }
}

// ------------------------------------------------------------- analysis

export function analyze(buf) {
    const chans = [];
    for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
    const n = buf.length;
    let bad = 0, peak = 0, sum = 0, dc = 0;
    const mono = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        let m = 0;
        for (const d of chans) {
            const x = d[i];
            if (!Number.isFinite(x)) { bad++; continue; }
            const a = Math.abs(x);
            if (a > peak) peak = a;
            sum += x * x;
            m += x;
        }
        mono[i] = m / chans.length;
        dc += mono[i];
    }
    const rms = Math.sqrt(sum / (n * chans.length));
    // Loudest 50 ms window: what a short one-shot really sounds like.
    const win = Math.floor(SR * 0.05);
    let maxWin = 0;
    for (let s = 0; s + win <= n; s += win >> 1) {
        let e = 0;
        for (let i = s; i < s + win; i++) e += mono[i] * mono[i];
        maxWin = Math.max(maxWin, Math.sqrt(e / win));
    }
    let tail = 0;
    for (let i = Math.max(0, n - win); i < n; i++) tail += mono[i] * mono[i];
    tail = Math.sqrt(tail / win);
    const spec = spectrogram(mono);
    return { bad, peak, rms, maxWin, tail, dc: dc / n, ...spec, mono, seconds: n / SR };
}

function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            [re[i], re[j]] = [re[j], re[i]];
            [im[i], im[j]] = [im[j], im[i]];
        }
    }
    for (let len = 2; len <= n; len <<= 1) {
        const ang = -2 * Math.PI / len;
        const wr = Math.cos(ang), wi = Math.sin(ang);
        for (let i = 0; i < n; i += len) {
            let cr = 1, ci = 0;
            for (let k = 0; k < len / 2; k++) {
                const a = i + k, b = a + len / 2;
                const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
                re[b] = re[a] - tr; im[b] = im[a] - ti;
                re[a] += tr; im[a] += ti;
                const ncr = cr * wr - ci * wi;
                ci = cr * wi + ci * wr;
                cr = ncr;
            }
        }
    }
}

const FFT_N = 1024;

function spectrogram(mono) {
    const hop = Math.max(256, Math.floor(mono.length / 900));
    const frames = [];
    const win = new Float32Array(FFT_N);
    for (let i = 0; i < FFT_N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_N - 1));
    let eTot = 0, eHigh = 0, eLow = 0, cNum = 0;
    const re = new Float32Array(FFT_N), im = new Float32Array(FFT_N);
    for (let s = 0; s + FFT_N <= mono.length; s += hop) {
        for (let i = 0; i < FFT_N; i++) { re[i] = mono[s + i] * win[i]; im[i] = 0; }
        fft(re, im);
        const mag = new Float32Array(FFT_N / 2);
        for (let k = 0; k < FFT_N / 2; k++) {
            const p = re[k] * re[k] + im[k] * im[k];
            mag[k] = p;
            const f = (k * SR) / FFT_N;
            eTot += p;
            cNum += p * f;
            if (f > 6000) eHigh += p;
            else if (f < 100) eLow += p;
        }
        frames.push(mag);
    }
    return { frames, centroid: eTot > 0 ? cNum / eTot : 0, high: eTot > 0 ? eHigh / eTot : 0, low: eTot > 0 ? eLow / eTot : 0 };
}

// ---------------------------------------------------------------- drawing

function draw(canvas, a) {
    const g = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height, wave = 26;
    g.fillStyle = '#06142b';
    g.fillRect(0, 0, W, H);
    // Envelope strip.
    const per = Math.max(1, Math.floor(a.mono.length / W));
    g.fillStyle = '#7fdcff';
    for (let x = 0; x < W; x++) {
        let m = 0;
        for (let i = x * per; i < Math.min(a.mono.length, (x + 1) * per); i++) m = Math.max(m, Math.abs(a.mono[i]));
        const h = Math.min(1, m) * (wave - 2);
        g.fillRect(x, wave / 2 - h / 2, 1, Math.max(1, h));
    }
    // Spectrogram, log frequency 40 Hz .. 18 kHz, 60 dB below this render's loudest bin.
    const sh = H - wave;
    let top = 1e-12;
    for (const fr of a.frames) for (let k = 0; k < fr.length; k++) if (fr[k] > top) top = fr[k];
    const topDb = 10 * Math.log10(top);
    const lo = Math.log(40), hi = Math.log(18000);
    const img = g.createImageData(W, sh);
    const F = a.frames.length;
    for (let x = 0; x < W; x++) {
        const fr = a.frames[Math.min(F - 1, Math.floor((x / W) * F))];
        if (!fr) continue;
        for (let y = 0; y < sh; y++) {
            const f = Math.exp(hi - ((hi - lo) * y) / (sh - 1));
            const k = Math.min(fr.length - 1, Math.round((f * FFT_N) / SR));
            const db = 10 * Math.log10(fr[k] + 1e-12);
            const v = Math.max(0, Math.min(1, (db - topDb + 60) / 60));
            const o = (y * W + x) * 4;
            img.data[o] = 255 * Math.max(0, v * 1.6 - 0.6);
            img.data[o + 1] = 255 * Math.max(0, Math.min(1, v * 1.3 - 0.1));
            img.data[o + 2] = 255 * Math.min(1, 0.25 + v);
            img.data[o + 3] = 255;
        }
    }
    g.putImageData(img, 0, wave);
    g.fillStyle = 'rgba(200,230,255,0.5)';
    g.font = '9px monospace';
    for (const f of [100, 1000, 10000]) {
        const y = wave + ((hi - Math.log(f)) / (hi - lo)) * (sh - 1);
        g.fillRect(0, y, 4, 1);
        g.fillText(f >= 1000 ? f / 1000 + 'k' : String(f), 6, y + 3);
    }
}

// -------------------------------------------------------------- running

/**
 * Renders every case and fills `table` (a <tbody>) with results. Returns
 * { pass, results, relations } and also stores it on window.__audioCheck.
 */
export async function runChecks(table, { onProgress, filter = '', width = 420, height = 110 } = {}) {
    const cases = checkCases().filter((c) => !filter || c.name.includes(filter));
    const results = [];
    for (const c of cases) {
        const t0 = performance.now();
        const raw = analyze((await render(c, 'raw')).buf);
        const r = await render(c, 'mix');
        const mix = analyze(r.buf);
        const problems = [];
        if (raw.bad || mix.bad) problems.push(`${raw.bad + mix.bad} NaN samples`);
        if (raw.peak >= RAW_PEAK) problems.push(`raw peak ${raw.peak.toFixed(2)}`);
        if (mix.peak >= MIX_PEAK) problems.push(`mix peak ${mix.peak.toFixed(2)}`);
        const loud = c.group === 'sfx' ? raw.maxWin : raw.rms;
        if (loud < c.rms[0]) problems.push(`too quiet ${loud.toFixed(4)}`);
        if (loud > c.rms[1]) problems.push(`too loud ${loud.toFixed(3)}`);
        if (c.group === 'sfx' && raw.tail > 1e-3) problems.push(`still sounding at the end (${raw.tail.toFixed(4)})`);
        if (Math.abs(raw.dc) > 0.01) problems.push(`DC ${raw.dc.toFixed(3)}`);
        const res = {
            name: c.name, group: c.group, ok: problems.length === 0, problems, info: r.info,
            seconds: +raw.seconds.toFixed(2), rawPeak: +raw.peak.toFixed(3), mixPeak: +mix.peak.toFixed(3),
            rms: +raw.rms.toFixed(4), maxWin: +raw.maxWin.toFixed(4), centroid: Math.round(raw.centroid),
            high: +raw.high.toFixed(3), low: +raw.low.toFixed(3), ms: Math.round(performance.now() - t0),
        };
        results.push(res);
        if (table) addRow(table, res, raw, width, height);
        if (onProgress) onProgress(results.length, cases.length, res);
    }
    const by = (n) => results.find((r) => r.name === n);
    const relations = filter ? [] : [
        ['hover is far quieter than click', by('hover').maxWin < by('click').maxWin * 0.5],
        ['Avalanche Boost is louder and longer than Frost Boost', by('boost level:2').maxWin > by('boost level:1').maxWin && by('boost level:2').seconds > by('boost level:1').seconds],
        ['landings scale with strength', by('land strength:2').maxWin < by('land strength:10').maxWin && by('land strength:10').maxWin < by('land strength:30').maxWin],
        ['wall hits scale with intensity', by('wallhit intensity:3').maxWin < by('wallhit intensity:12,pan:-0.6').maxWin && by('wallhit intensity:12,pan:-0.6').maxWin < by('wallhit intensity:40,pan:0.6').maxWin],
        ['medals grow bronze < silver < gold < emperor', ['bronze', 'silver', 'gold', 'emperor'].map((t) => by('medal tier:' + t).seconds).every((s, i, a) => i === 0 || s > a[i - 1])],
        ['GO is higher than the countdown beeps', by('go').centroid > by('countdown').centroid],
        ['music stays quieter than the car', by('music: seed 1').rms < by('car: S03 autopilot (jumps, loop, boost) + events').rms],
    ].map(([name, ok]) => ({ name, ok: !!ok }));
    const pass = results.every((r) => r.ok) && relations.every((r) => r.ok);
    const out = { done: true, pass, results, relations };
    window.__audioCheck = out;
    return out;
}

function addRow(tbody, res, raw, width, height) {
    const tr = document.createElement('tr');
    tr.className = res.ok ? 'ok' : 'bad';
    const cell = (html) => {
        const td = document.createElement('td');
        td.innerHTML = html;
        tr.appendChild(td);
        return td;
    };
    cell(`<b>${res.name}</b><div class="au-note">${res.ok ? 'pass' : res.problems.join('; ')}${res.info ? '<br>' + res.info : ''}</div>`);
    cell(`${res.seconds}s`);
    cell(`${res.rawPeak} / ${res.mixPeak}`);
    cell(`${res.rms} / ${res.maxWin}`);
    cell(`${res.centroid} Hz<br>${(res.low * 100).toFixed(0)}% &lt;100<br>${(res.high * 100).toFixed(1)}% &gt;6k`);
    const td = cell('');
    const cv = document.createElement('canvas');
    cv.width = width;
    cv.height = height;
    td.appendChild(cv);
    draw(cv, raw);
    tbody.appendChild(tr);
}
