// Quick TAS (js/tas/quick.js): savestate markers over a live race. Rewinding
// to a marker and driving on must give exactly the run an uninterrupted drive
// gives, the recording must stay in step with the sim, and the marker chain
// must keep or overwrite later markers as documented. Also the Quick TAS key
// context (controls.js) and the savestate flags (render/effects.js).
import assert from 'node:assert/strict';
import module from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test, info } from './_harness.mjs';
import { buildWorld } from '../../js/core/track.js';
import { getSample } from '../../js/core/samples.js';
import { runAutopilot } from '../../js/core/autopilot.js';
import { Sim } from '../../js/core/sim.js';
import { Recorder, decodeInputs, encodeInputs, verifyReplay } from '../../js/core/replay.js';
import { STEER_MAX } from '../../js/core/constants.js';
import { QuickTas, MAX_MARKERS } from '../../js/tas/quick.js';
import { Controls } from '../../js/game/controls.js';
import { defaultSettings, bindingsConflict, ACTIONS, DEFAULT_BINDINGS } from '../../js/game/settings.js';

let cached = null;
function s01() {
    if (!cached) {
        const world = buildWorld(getSample('S01'));
        const run = runAutopilot(world, { record: true });
        assert.ok(run.finished, 'the autopilot finishes S01');
        cached = { world, inputs: decodeInputs(run.replay.inputs), timeMs: run.timeMs };
    }
    return cached;
}

/** A race as race.js runs it: step, then record what the tick simulated. */
function drive(sim, rec, inputs, from, to) {
    for (let i = from; i < to && !sim.finished; i++) {
        sim.step(inputs[i]);
        rec.push(sim.lastInput);
    }
}

/** Some ticks of a botched attempt: full lock into the wall with the brake on. */
function crash(sim, rec, n) {
    const bad = { steer: -STEER_MAX, gas: false, brake: true };
    for (let i = 0; i < n && !sim.finished; i++) {
        sim.step(bad);
        rec.push(sim.lastInput);
    }
}

function straightRun(world, inputs) {
    const sim = new Sim(world);
    for (const inp of inputs) {
        sim.step(inp);
        if (sim.finished) break;
    }
    return sim;
}

test('restoring a savestate and driving on ends on the same tick and position as an uninterrupted run', () => {
    const { world, inputs, timeMs } = s01();
    const ref = straightRun(world, inputs);
    assert.ok(ref.finished);
    assert.equal(ref.finishTimeMs, timeMs);

    const sim = new Sim(world), rec = new Recorder(), qt = new QuickTas(sim, rec);
    qt.begin();
    const at = Math.floor(inputs.length * 0.4);
    drive(sim, rec, inputs, 0, at);
    const m = qt.mark();
    assert.ok(m && m.tick === at, 'marker at the current tick');
    // Savestates are plain JSON: one that went through a serializer restores the same.
    m.state = JSON.parse(JSON.stringify(m.state));
    crash(sim, rec, 250);
    assert.notDeepEqual(sim.car.pos, m.pos, 'the crash moved the car');
    qt.rewind();
    assert.equal(sim.tick, at);
    assert.equal(rec.length, at, 'inputs after the marker are cut');
    drive(sim, rec, inputs, at, inputs.length);

    assert.ok(sim.finished);
    assert.equal(sim.tick, ref.tick, 'same final tick');
    assert.deepEqual(sim.car.pos, ref.car.pos, 'same final car position, bit for bit');
    assert.deepEqual(sim.car.vel, ref.car.vel);
    assert.equal(sim.finishTimeMs, ref.finishTimeMs);
    assert.equal(sim.stateHash(), ref.stateHash(), 'identical savestate at the end');
    // The recording is a real replay of that run.
    const replay = rec.toReplay({ sim });
    const v = verifyReplay(world, replay);
    assert.ok(v.ok, v.reason);
    assert.equal(v.timeMs, ref.finishTimeMs);
    assert.ok(qt.used && qt.rewinds === 1 && qt.placed === 1);
});

test('cycling markers keeps later ones (inputs included) until a new marker overwrites them', () => {
    const { world, inputs } = s01();
    const ref = straightRun(world, inputs);
    const sim = new Sim(world), rec = new Recorder(), qt = new QuickTas(sim, rec);
    qt.begin();
    const ticks = [300, 700, 1100];
    let t = 0;
    for (const at of ticks) {
        drive(sim, rec, inputs, t, at);
        qt.mark();
        t = at;
    }
    assert.equal(qt.markers.length, 4, 'Start + 3');
    assert.equal(qt.current, 3);
    // Back two markers, botch the corner there, then jump forward again.
    qt.cycle(-1);
    qt.cycle(-1);
    assert.equal(sim.tick, 300);
    crash(sim, rec, 120);
    qt.cycle(1);
    assert.equal(sim.tick, 700);
    assert.equal(encodeInputs(rec.inputs), encodeInputs(inputs.slice(0, 700)), 'the later marker brings its own inputs back');
    qt.cycle(1);
    qt.cycle(1);
    assert.equal(qt.current, 3, 'cycling stops at the newest marker');
    drive(sim, rec, inputs, 1100, inputs.length);
    assert.equal(sim.stateHash(), ref.stateHash());

    // From marker 1 a fresh attempt with a new marker overwrites markers 2 and 3.
    qt.cycle(-1);
    qt.cycle(-1);
    assert.equal(qt.current, 1);
    drive(sim, rec, inputs, 300, 500);
    const m = qt.mark();
    assert.equal(m.tick, 500);
    assert.deepEqual(qt.markers.map((x) => x.tick), [0, 300, 500]);
    assert.equal(qt.inputsTo(2).length, 500);
    // Start always rewinds to the line, standing still.
    qt.cycle(-1);
    qt.cycle(-1);
    qt.cycle(-1);
    assert.equal(sim.tick, 0);
    assert.equal(rec.length, 0);
    assert.deepEqual(sim.car.vel, [0, 0, 0]);
});

test('markers: none on the same tick or after the finish, and the cap merges the oldest away', () => {
    const { world, inputs } = s01();
    const sim = new Sim(world), rec = new Recorder(), qt = new QuickTas(sim, rec);
    qt.begin();
    assert.equal(qt.mark(), null, 'nothing to mark on the start line');
    assert.equal(qt.used, false);
    for (let i = 0; i < MAX_MARKERS + 40; i++) {
        drive(sim, rec, inputs, i * 5, i * 5 + 5);
        assert.ok(qt.mark());
        assert.equal(qt.mark(), null, 'one marker per tick');
    }
    assert.equal(qt.markers.length, MAX_MARKERS);
    assert.equal(qt.markers[0].label, 'Start');
    assert.equal(qt.markers[1].tick, 42 * 5, 'the oldest placed markers merged away');
    for (let i = 1; i < qt.markers.length; i++) {
        assert.equal(qt.inputsTo(i).length, qt.markers[i].tick, `marker ${i} keeps every input up to it`);
    }
    // Rewinding to a merged marker still restores the full recording.
    qt.cycle(-1);
    assert.deepEqual(rec.inputs, qt.inputsTo(qt.current));
    assert.equal(rec.length, sim.tick);
    drive(sim, rec, inputs, sim.tick, inputs.length);
    assert.ok(sim.finished);
    assert.equal(qt.mark(), null, 'no markers after the finish');
    // Rewinding a finished run reopens it.
    qt.rewind();
    assert.equal(sim.finished, false);
    assert.throws(() => {
        sim.step(inputs[sim.tick]);
        rec.push(sim.lastInput);
        rec.push(sim.lastInput);
        qt.mark();
    }, /recording holds/, 'a recording out of step with the sim is caught');
});

test('controls: Quick TAS keys act only in Quick TAS, win over the keys they share, never over driving', () => {
    const c = new Controls(defaultSettings());
    const key = (code) => c._onKeyDown({ code, target: null, repeat: false, metaKey: false, ctrlKey: false, altKey: false, preventDefault() {} });
    const up = (code) => c._onKeyUp({ code, preventDefault() {} });
    c.setActive(true);
    // A normal race: C cycles cameras, Backspace restarts, the TAS keys do nothing.
    for (const k of ['KeyC', 'Backspace', 'KeyR', 'BracketLeft', 'BracketRight']) { key(k); up(k); }
    assert.deepEqual([c.pressed('cameraCycle'), c.pressed('restart')], [true, true]);
    assert.deepEqual(['tasMark', 'tasRewind', 'tasPrev', 'tasNext'].map((a) => c.pressed(a)), [false, false, false, false]);
    // Quick TAS: C marks, R and Backspace rewind, [ ] cycle; Delete still restarts.
    c.setTasMode(true);
    key('KeyC');
    assert.deepEqual([c.pressed('tasMark'), c.pressed('cameraCycle')], [true, false]);
    key('Backspace');
    assert.deepEqual([c.pressed('tasRewind'), c.pressed('restart')], [true, false]);
    key('KeyR');
    assert.equal(c.pressed('tasRewind'), true);
    key('BracketLeft');
    key('BracketRight');
    assert.deepEqual([c.pressed('tasPrev'), c.pressed('tasNext')], [true, true]);
    key('Delete');
    assert.equal(c.pressed('restart'), true);
    key('Enter');
    assert.equal(c.input().respawn, true, 'respawn is untouched');
    // A player who put respawn on R keeps it: TAS keys never take driving or respawn keys.
    const s = defaultSettings();
    s.bindings.respawn = ['KeyR'];
    c.setSettings(s);
    key('KeyR');
    assert.deepEqual([c.input().respawn, c.pressed('tasRewind')], [true, false]);
    key('Backspace');
    assert.equal(c.pressed('tasRewind'), true);
    c.setTasMode(false);
    assert.equal(c.pressed('tasRewind'), false, 'leaving Quick TAS drops pending TAS presses');
    // The key settings let the TAS keys share only with what they replace.
    assert.equal(bindingsConflict('tasMark', 'cameraCycle'), false);
    assert.equal(bindingsConflict('tasRewind', 'restart'), false);
    assert.equal(bindingsConflict('tasRewind', 'respawn'), true);
    assert.equal(bindingsConflict('gas', 'tasMark'), true);
    assert.equal(bindingsConflict('gas', 'brake'), true);
    for (const a of ['tasMark', 'tasRewind', 'tasPrev', 'tasNext']) assert.ok(ACTIONS.some((x) => x.id === a), a);
    assert.deepEqual(DEFAULT_BINDINGS.tasMark, ['KeyC']);
    assert.deepEqual(DEFAULT_BINDINGS.tasRewind, ['KeyR', 'Backspace']);
});

// The renderer's effects in Node: 'three' from vendor/, and a stand-in 2D canvas
// for the two small particle textures.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let threeHooks = false;
if (typeof module.registerHooks === 'function') {
    module.registerHooks({
        resolve(specifier, context, next) {
            if (specifier === 'three') return { url: pathToFileURL(path.join(root, 'vendor/three.module.min.js')).href, shortCircuit: true };
            return next(specifier, context);
        },
    });
    threeHooks = true;
}

class FakeCanvas {
    constructor(w, h) {
        this.width = w;
        this.height = h;
    }
    getContext() {
        const grad = { addColorStop() {} };
        return new Proxy({}, {
            get: (t, k) => (k in t ? t[k] : k === 'createRadialGradient' || k === 'createLinearGradient' ? () => grad : () => {}),
            set: (t, k, v) => { t[k] = v; return true; },
        });
    }
}

test('savestate flags: pooled meshes on shared geometry, kept by a rewind, nothing leaked', async () => {
    if (!threeHooks) return info('skipped: module.registerHooks needs Node >= 22.15');
    const hadCanvas = 'OffscreenCanvas' in globalThis;
    if (!hadCanvas) globalThis.OffscreenCanvas = FakeCanvas;
    try {
        const THREE = await import('three');
        const { Effects } = await import('../../js/render/effects.js');
        const fx = new Effects({ scene: new THREE.Scene(), reducedMotion: false, quality: 'low', cars: [] });
        const at = (x, current = false) => ({ pos: [x, 1, 0], quat: [0, 0, 0, 1], current });
        const shown = () => fx.flags.filter((f) => f.group.visible).length;
        fx.setMarkers([at(0), at(10), at(20, true)]);
        assert.equal(shown(), 3);
        const pole = fx.flagPoleGeo, cloth = fx.flagClothGeo;
        for (const f of fx.flags) {
            assert.equal(f.group.children[1].geometry, pole, 'every flag shares one pole geometry');
            assert.equal(f.cloth.geometry, cloth);
        }
        assert.equal(fx.flags[2].cloth.material, fx.flagMats.current, 'the current marker is gold');
        assert.equal(fx.flags[0].cloth.material, fx.flagMats.cloth);
        // Fewer markers hide flags, more reuse them: nothing is rebuilt.
        fx.setMarkers([at(0, true)]);
        assert.equal(shown(), 1);
        assert.equal(fx.flags[0].cloth.material, fx.flagMats.current);
        fx.setMarkers([at(0), at(1), at(2)]);
        assert.equal(fx.flags.length, 3, 'pool reused');
        // A rewind clears particles and skid marks but keeps the flags; a new world clears both.
        fx.soft.emit(0, 0, 0, 0, 0, 0, [1, 1, 1], 1, 1, 1, 1, 0, 0);
        assert.equal(fx.soft.n, 1);
        fx.clearTransient();
        assert.equal(fx.soft.n, 0);
        assert.equal(shown(), 3);
        fx.reset();
        assert.equal(shown(), 0);
        // A quality change rebuilds the effects and puts the flags back.
        fx.setMarkers([at(5), at(6, true)]);
        fx.setQuality('medium');
        assert.notEqual(fx.flagPoleGeo, pole);
        assert.equal(shown(), 2);
        assert.equal(fx.flags[1].cloth.material, fx.flagMats.current);
        // Teardown frees the shared flag geometry and materials.
        const freed = [];
        for (const o of [fx.flagPoleGeo, fx.flagClothGeo, ...Object.values(fx.flagMats)]) o.addEventListener('dispose', () => freed.push(o));
        fx.dispose();
        assert.equal(freed.length, 2 + Object.keys(fx.flagMats).length);
        assert.equal(fx.flags.length, 0);
    } finally {
        if (!hadCanvas) delete globalThis.OffscreenCanvas;
    }
});
