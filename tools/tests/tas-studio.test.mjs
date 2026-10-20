// TAS Studio pure logic (js/tas/studio-model.js): view maths, piano-roll edits,
// undo, markers, readouts, bruteforce form options, project storage.
import assert from 'node:assert/strict';
import { test, approx } from './_harness.mjs';
import { STEER_MAX } from '../../js/core/constants.js';
import { buildWorld } from '../../js/core/track.js';
import { getSample } from '../../js/core/samples.js';
import { InputTimeline, GAS, BRAKE, RESPAWN } from '../../js/tas/timeline.js';
import { TasRunner } from '../../js/tas/runner.js';
import { parse, serialize } from '../../js/tas/script.js';
import { resolveTarget } from '../../js/tas/bruteforce.js';
import {
    TimelineView, steerFromY, yFromSteer, paintSteer, paintFlag, toggleFlagSpan, copyRange, pasteClip, clearRange,
    removeRange, shiftRange, UndoStack, markersFromTrace, nextMarkerTick, quatToEuler, describeEffects, slotFromCode,
    stepSpeed, parseTickInput, bruteforceOptions, listProjects, saveProject, loadProject, deleteProject, uniqueName, fmtNum,
} from '../../js/tas/studio-model.js';

function tlFrom(steers, flags) {
    return InputTimeline.fromInputs(steers.map((s, i) => ({ steer: s, gas: !!(flags[i] & GAS), brake: !!(flags[i] & BRAKE), respawn: !!(flags[i] & RESPAWN) })));
}

function memStorage() {
    const m = new Map();
    return { get: (k, d) => (m.has(k) ? JSON.parse(m.get(k)) : d), set: (k, v) => { m.set(k, JSON.stringify(v)); return true; } };
}

test('view: tick <-> x, zoom keeps the anchor, follow, fit', () => {
    const v = new TimelineView({ start: 100, scale: 4, width: 400 });
    assert.equal(v.tickAt(0), 100);
    assert.equal(v.xAt(150), 200);
    const before = v.start + 200 / v.scale;
    v.zoom(2, 200, 10000);
    approx(v.start + 200 / v.scale, before, 1e-9);
    assert.equal(v.scale, 8);
    assert.equal(v.follow(140, 10000), false);
    assert.equal(v.follow(1000, 10000), true);
    assert.ok(v.xAt(1000) > 0 && v.xAt(1000) < 400);
    v.fit(2000);
    assert.equal(v.start, 0);
    assert.ok(v.xAt(2000) <= 400 && v.xAt(2000) > 350);
    v.scrollBy(-1e6, 2000);
    assert.equal(v.start, 0);
    assert.ok([1, 2, 5, 10, 20, 50, 100, 200, 500].includes(v.labelStep(70)) || v.labelStep(70) >= 1000);
});

test('steer lane mapping: top = full right, snaps near centre and lock, quantise', () => {
    assert.equal(steerFromY(0, 0, 100), STEER_MAX);
    assert.equal(steerFromY(100, 0, 100), -STEER_MAX);
    assert.equal(steerFromY(50, 0, 100), 0);
    assert.equal(steerFromY(52, 0, 100), 0);   // within the snap
    const v = steerFromY(30, 0, 100);
    assert.ok(v > 0 && v < STEER_MAX);
    approx(steerFromY(yFromSteer(v, 0, 100), 0, 100), v, 1);
    assert.equal(steerFromY(30, 0, 100, { quantize: 8192 }) % 8192, 0);
});

test('paintSteer interpolates both ways, one notification', () => {
    const tl = new InputTimeline();
    let calls = 0, low = -1;
    tl.onChange((t) => { calls++; low = t; });
    paintSteer(tl, 20, 1000, 10, 0);
    assert.equal(calls, 1);
    assert.equal(low, 11);   // tick 10 already held 0
    assert.equal(tl.steerAt(10), 0);
    assert.equal(tl.steerAt(20), 1000);
    assert.equal(tl.steerAt(15), 500);
    paintSteer(tl, 5, 70000, 5, 70000);
    assert.equal(tl.steerAt(5), STEER_MAX);   // clamped like the sim
});

test('flags: paint and toggle spans', () => {
    const tl = tlFrom([0, 0, 0, 0, 0, 0], [GAS, GAS, 0, 0, 0, 0]);
    paintFlag(tl, 2, 4, GAS, true);
    assert.deepEqual([0, 1, 2, 3, 4].map((t) => tl.flagsAt(t) & GAS), [GAS, GAS, GAS, GAS, 0]);
    assert.equal(toggleFlagSpan(tl, 0, 4, GAS), false);   // all on -> off
    assert.equal(tl.flagsAt(1) & GAS, 0);
    assert.equal(toggleFlagSpan(tl, 3, 6, BRAKE), true);
    assert.equal(tl.flagsAt(5) & BRAKE, BRAKE);
});

test('clipboard: copy / paste over / paste insert / clear / remove', () => {
    const tl = tlFrom([1, 2, 3, 4, 5, 6, 7, 8], [GAS, GAS, GAS | RESPAWN, 0, 0, BRAKE, 0, 0]);
    const clip = copyRange(tl, 1, 4);
    assert.deepEqual([...clip.steer], [2, 3, 4]);
    assert.equal(clip.flags[1], GAS | RESPAWN);
    const a = tl.clone();
    pasteClip(a, 5, clip);
    assert.deepEqual([5, 6, 7].map((t) => a.steerAt(t)), [2, 3, 4]);
    assert.equal(a.flags[6], GAS | RESPAWN);
    assert.equal(a.length, 8);
    const b = tl.clone();
    pasteClip(b, 2, clip, { insert: true });
    assert.equal(b.length, 11);
    assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map((t) => b.steerAt(t)), [1, 2, 2, 3, 4, 3, 4]);
    const c = tl.clone();
    clearRange(c, 0, 3);
    assert.deepEqual([0, 1, 2, 3].map((t) => [c.steerAt(t), c.flagsAt(t)]), [[0, 0], [0, 0], [0, 0], [4, 0]]);
    const d = tl.clone();
    removeRange(d, 0, 2);
    assert.equal(d.length, 6);
    assert.equal(d.steerAt(0), 3);
});

test('shiftRange moves a block and fills the gap with the neighbour', () => {
    const tl = tlFrom([0, 0, 9, 9, 0, 0, 0, 0], [0, 0, GAS, GAS, 0, 0, 0, 0]);
    let sel = shiftRange(tl, 2, 4, 2);
    assert.deepEqual(sel, { from: 4, to: 6 });
    assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map((t) => tl.steerAt(t)), [0, 0, 0, 0, 9, 9, 0]);
    assert.equal(tl.flagsAt(5) & GAS, GAS);
    assert.equal(tl.flagsAt(2) & GAS, 0);
    sel = shiftRange(tl, 4, 6, -3);
    assert.deepEqual(sel, { from: 1, to: 3 });
    assert.deepEqual([0, 1, 2, 3, 4, 5].map((t) => tl.steerAt(t)), [0, 9, 9, 0, 0, 0]);
    assert.deepEqual(shiftRange(tl, 1, 3, -5), { from: 0, to: 2 });   // clamped at tick 0
});

test('undo / redo restore exact timelines', () => {
    const tl = tlFrom([1, 2, 3], [GAS, GAS, GAS]);
    const u = new UndoStack(3);
    const orig = tl.clone();
    u.push(tl);
    paintSteer(tl, 0, 500, 2, 500);
    const edited = tl.clone();
    assert.ok(u.undo(tl));
    assert.ok(tl.equals(orig));
    assert.ok(u.redo(tl));
    assert.ok(tl.equals(edited));
    assert.equal(u.redo(tl), false);
    for (let i = 0; i < 6; i++) { u.push(tl); tl.patch(0, { steer: i * 10 + 7 }); }
    assert.equal(u.past.length, 3);
});

test('markers from a real run and next / previous checkpoint', () => {
    const world = buildWorld(getSample('S01'));
    const p = parse('0 press up\n');
    const runner = new TasRunner(world, p.timeline);
    const m = markersFromTrace(runner.trace());
    assert.ok(m.length >= 1);
    const cps = m.filter((x) => x.kind === 'checkpoint');
    if (cps.length) {
        assert.equal(nextMarkerTick(m, 0, 1), m.filter((x) => x.kind !== 'respawn')[0].tick);
        assert.equal(nextMarkerTick(m, cps[0].tick, -1), null);
    }
    assert.equal(nextMarkerTick([], 5, 1), null);
});

test('readouts: euler angles, effects, numbers, slots, speeds, time boxes', () => {
    const e = quatToEuler([0, Math.sin(Math.PI / 4), 0, Math.cos(Math.PI / 4)]);
    approx(e.yaw, 90, 1e-9);
    approx(e.pitch, 0, 1e-9);
    const r = quatToEuler([0, 0, Math.sin(0.1), Math.cos(0.1)]);   // about the forward axis
    approx(Math.abs(r.roll), 0.2 * 180 / Math.PI, 1e-6);
    assert.deepEqual(describeEffects({ turbo: 2, turboTime: 1.5, noEngine: true, slowmo: 0, cruise: false, fragile: false }), ['Avalanche Boost 1.50 s', 'Frozen Engine']);
    assert.equal(fmtNum(-1.23456, 3), '−1.235');
    assert.equal(fmtNum(0.0001, 3), ' 0.000');
    assert.equal(slotFromCode('Digit0'), '0');
    assert.equal(slotFromCode('KeyA'), null);
    assert.equal(stepSpeed(1, 1), 2);
    assert.equal(stepSpeed(0.05, -1), 0.05);
    assert.equal(stepSpeed(4, 1), 4);
    assert.deepEqual(parseTickInput('1:02.50'), { tick: 6250 });
    assert.deepEqual(parseTickInput('t42'), { tick: 42 });
    assert.ok(parseTickInput('1.005').error);
});

test('bruteforce form -> options that resolve to targets', () => {
    const world = buildWorld(getSample('S01'));
    const base = { target: 'finish', from: '', to: '', seed: '7', maxChanges: '2', steerRange: '3000', steerSpan: '20', shiftRange: '4', wShift: '1', wSteer: '2', wGas: '0', wBrake: '1' };
    let r = bruteforceOptions(base);
    assert.equal(r.error, undefined);
    assert.equal(r.options.target, 'finish');
    assert.equal(r.options.window, null);
    assert.equal(r.options.seed, 7);
    assert.equal(r.options.rules.steer.range, 3000);
    assert.equal(r.options.rules.gas.weight, 0);
    r = bruteforceOptions({ ...base, from: '8.00', to: '12' });
    assert.deepEqual(r.options.window, { from: 800, to: 1200 });
    assert.ok(bruteforceOptions({ ...base, from: '12', to: '8' }).error);
    r = bruteforceOptions({ ...base, target: 'checkpoint', cp: '2' });
    assert.deepEqual(r.options.target, { type: 'checkpoint', index: 2 });
    r = bruteforceOptions({ ...base, target: 'speed', at: '5.50' });
    assert.deepEqual(r.options.target, { type: 'speed', tick: 550 });
    r = bruteforceOptions({ ...base, target: 'position', at: '3', point: ['1', '2', '3'], mode: 'at' });
    assert.deepEqual(r.options.target, { type: 'position', point: [1, 2, 3], tick: 300, mode: 'at' });
    for (const t of [r.options.target, { type: 'speed', tick: 550 }, 'finish']) assert.equal(typeof resolveTarget(t, world).score, 'function');
    assert.ok(bruteforceOptions({ ...base, target: 'position', at: '3', point: ['x', '2', '3'] }).error);
    assert.ok(bruteforceOptions({ ...base, wShift: 0, wSteer: 0, wGas: 0, wBrake: 0 }).error);
});

test('projects: save, list newest first, load, unique names, delete', () => {
    const st = memStorage();
    const tl = parse('0 press up\n1.00-1.50 press left\n').timeline;
    const script = serialize(tl, { meta: { track: 'S01' } });
    assert.ok(saveProject(st, 'Run A', { trackId: 'S01', script, notes: 'n', slots: [{ name: '1', tick: 40 }], updated: 1 }));
    assert.ok(saveProject(st, 'Run B', { trackId: 'S02', script, notes: '', slots: [], updated: 2 }));
    assert.deepEqual(listProjects(st).map((p) => p.name), ['Run B', 'Run A']);
    const a = loadProject(st, 'Run A');
    assert.equal(a.trackId, 'S01');
    assert.deepEqual(a.slots, [{ name: '1', tick: 40 }]);
    assert.ok(parse(a.script).timeline.equals(tl));
    assert.equal(uniqueName(st, 'Run A'), 'Run A (2)');
    assert.equal(uniqueName(st, 'Fresh'), 'Fresh');
    deleteProject(st, 'Run A');
    assert.equal(loadProject(st, 'Run A'), null);
    assert.equal(listProjects(st).length, 1);
});
