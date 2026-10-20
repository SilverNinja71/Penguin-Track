// TAS engine: script language, input timeline, runner (seek, savestates,
// record, trace, ghost compare), bruteforce, the worker protocol and the CLI.
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test, info } from './_harness.mjs';
import { STEER_MAX } from '../../js/core/constants.js';
import { Rng } from '../../js/core/rng.js';
import { buildWorld } from '../../js/core/track.js';
import { getSample } from '../../js/core/samples.js';
import { Sim } from '../../js/core/sim.js';
import { verifyReplay, decodeInputs } from '../../js/core/replay.js';
import { runAutopilot } from '../../js/core/autopilot.js';
import { InputTimeline } from '../../js/tas/timeline.js';
import { parse, serialize, parseTime, fromReplay, toReplay, replayMeta, channelEvents } from '../../js/tas/script.js';
import { TasRunner, simulateTimeline, compareTimelines, ghostSamples } from '../../js/tas/runner.js';
import { Bruteforce, BruteforceSession, compareScores, parseTargetSpec } from '../../js/tas/bruteforce.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const worlds = new Map();
function world(id) {
    if (!worlds.has(id)) worlds.set(id, buildWorld(getSample(id)));
    return worlds.get(id);
}

let autopilotS01 = null;
function autopilot() {
    if (!autopilotS01) autopilotS01 = runAutopilot(world('S01'), { record: true });
    return autopilotS01;
}

/** Plain re-simulation of a timeline to `ticks`, the reference every cache is checked against. */
function stateAt(w, tl, ticks) {
    const sim = new Sim(w);
    const inp = {};
    while (sim.tick < ticks) { tl.get(sim.tick, inp); sim.step(inp); }
    return sim.stateHash();
}

function randomTimeline(rng, n) {
    const tl = new InputTimeline();
    let t = 0;
    while (t < n) {
        const len = 1 + rng.int(40);
        const r = rng.next();
        const steer = r < 0.25 ? -STEER_MAX : r < 0.5 ? STEER_MAX : r < 0.6 ? 0 : rng.int(2 * STEER_MAX + 1) - STEER_MAX;
        tl.setRange(t, t + len, { steer, gas: rng.chance(0.7), brake: rng.chance(0.2) });
        if (rng.chance(0.05)) tl.patch(t, { respawn: true });
        t += len;
    }
    return tl;
}

// ---------------------------------------------------------------------------
// Script language

test('times: seconds, m:ss.cc and whole ticks only', () => {
    assert.equal(parseTime('0').tick, 0);
    assert.equal(parseTime('12.34').tick, 1234);
    assert.equal(parseTime('12.3').tick, 1230);
    assert.equal(parseTime('12.340').tick, 1234);
    assert.equal(parseTime('12.34000').tick, 1234);
    assert.equal(parseTime('1:02.50').tick, 6250);
    assert.equal(parseTime('2:00').tick, 12000);
    assert.match(parseTime('12.345').error, /multiple of 10 ms/);
    assert.match(parseTime('0.005').error, /multiple of 10 ms/);
    assert.match(parseTime('1:60.00').error, /below 60/);
    assert.match(parseTime('-1').error, /Bad time/);
    assert.match(parseTime('1.2.3').error, /Bad time/);
    assert.match(parseTime('99999').error, /one-hour/);
});

test('script commands build the per-tick inputs (ranges, analog steer, digital override, respawn)', () => {
    const { timeline: tl, errors, warnings, meta, commands } = parse([
        '# track: S01',
        '# name: Snowball',
        '0 press up            # gas from GO',
        '0.50-1.00 press left',
        '0.80 steer 20000',
        '1.20-1.30 press right',
        '1.50 steer -5',
        '2 gas off',
        '2.00-2.10 brake on',
        '2.50 respawn',
        '3:00 rel up',   // releasing what is already released: allowed, no change
    ].join('\n'));
    assert.deepEqual(errors, []);
    assert.deepEqual(warnings, []);
    assert.deepEqual(meta, { track: 'S01', name: 'Snowball' });
    assert.deepEqual(commands[1], { line: 4, from: 50, to: 100, channel: 'left', value: true });
    assert.equal(commands.length, 9);
    const at = (t) => tl.get(t);
    assert.deepEqual(at(0), { steer: 0, gas: true, brake: false, respawn: false });
    assert.equal(at(49).steer, 0);
    assert.equal(at(50).steer, -STEER_MAX);
    assert.equal(at(80).steer, -STEER_MAX, 'left held wins over the analog value');
    assert.equal(at(100).steer, 20000, 'analog value shows once left is released');
    assert.equal(at(120).steer, STEER_MAX);
    assert.equal(at(130).steer, 20000);
    assert.equal(at(150).steer, -5);
    assert.equal(at(199).gas, true);
    assert.equal(at(200).gas, false);
    assert.equal(at(200).brake, true);
    assert.equal(at(210).brake, false);
    assert.equal(at(250).respawn, true);
    assert.equal(at(251).respawn, false);
    assert.equal(tl.length, 18001);
    assert.deepEqual(at(99999), { steer: -5, gas: false, brake: false, respawn: false }, 'the last input is held');
});

test('script errors carry line numbers; the valid lines still build', () => {
    const res = parse([
        '0 press up',
        '1.005 press left',
        '2 steer 70000',
        '3 steer 1.5',
        '4-3 press down',
        '5 jump',
        '6 press space',
        '7',
        '8-9 respawn',
        '9 gas maybe',
        '10 press up now',
        '11 press down',
    ].join('\n'));
    assert.deepEqual(res.errors.map((e) => e.line), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    assert.match(res.errors[0].message, /multiple of 10 ms/);
    assert.match(res.errors[1].message, /out of range/);
    assert.match(res.errors[3].message, /must end after/);
    assert.equal(res.timeline.get(1100).brake, true);
    assert.equal(res.timeline.get(500).gas, true);
});

test('same-tick rules: range ends apply first, then file order; conflicts warn', () => {
    // A range ending where another command starts: the new command wins either way round.
    for (const text of ['0-1 press up\n1 press up', '1 press up\n0-1 press up']) {
        const { timeline } = parse(text);
        assert.equal(timeline.get(100).gas, true, text);
        assert.equal(timeline.get(5000).gas, true, text);
    }
    const { timeline: steer } = parse('0-1 steer 100\n1-2 steer 200');
    assert.deepEqual([steer.get(50).steer, steer.get(100).steer, steer.get(200).steer], [100, 200, 0]);
    const conflict = parse('1 press up\n1 rel up');
    assert.equal(conflict.warnings.length, 1);
    assert.match(conflict.warnings[0].message, /Overrides line 1/);
    assert.equal(conflict.timeline.get(100).gas, false, 'the later line wins');
    assert.equal(parse('2 respawn\n2 press enter').warnings.length, 1);
    assert.equal(parse('# track: A\n# track: B').warnings.length, 1);
    assert.equal(parse('# track: A\n0 press up\n# note: not a header').meta.note, undefined);
});

test('serialize is canonical: parse(serialize(t)) equals t and serialize is idempotent (both styles)', () => {
    const rng = new Rng(7);
    const cases = [new InputTimeline(), fromReplay(autopilot().replay)];
    for (let i = 0; i < 25; i++) cases.push(randomTimeline(rng, 50 + rng.int(800)));
    for (const tl of cases) {
        for (const style of ['ranges', 'events']) {
            const text = serialize(tl, { style, meta: { track: 'S01' } });
            const back = parse(text);
            assert.deepEqual(back.errors, []);
            assert.equal(back.timeline.firstDifference(tl), -1, `${style} round trip`);
            assert.equal(serialize(back.timeline, { style, meta: back.meta }), text, `${style} idempotent`);
        }
    }
    const tl = parse('0-2 press up\n0.5-1 press left\n1.5 steer 3000\n3 respawn').timeline;
    assert.equal(serialize(tl), '0.00-2.00 press up\n0.50-1.00 press left\n1.50 steer 3000\n3.00 respawn\n');
    assert.equal(serialize(tl, { style: 'events' }),
        '0.00 press up\n0.50 press left\n1.00 rel left\n1.50 steer 3000\n2.00 rel up\n3.00 respawn\n');
    const ev = channelEvents(tl);
    assert.deepEqual(ev.left, [{ tick: 50, value: true }, { tick: 100, value: false }]);
});

test('fromReplay / toReplay round trip through the core replay format and verify', () => {
    const ap = autopilot();
    const w = world('S01');
    const tl = fromReplay(ap.replay);
    assert.equal(tl.length, ap.replay.ticks);
    assert.equal(fromReplay(ap.replay.inputs).equals(tl), true);
    const rep = toReplay(tl, w, { name: 'tas' });
    assert.equal(rep.inputs, ap.replay.inputs);
    assert.equal(rep.timeMs, ap.timeMs);
    assert.deepEqual(verifyReplay(w, rep), { ok: true, reason: null, finished: true, timeMs: ap.timeMs, respawns: 0 });
    // Through the script text as well.
    const text = serialize(tl, { meta: replayMeta(ap.replay) });
    const back = parse(text);
    assert.equal(back.meta.track, 'S01');
    assert.equal(back.meta.hash, w.hash);
    assert.equal(verifyReplay(w, toReplay(back.timeline, w)).ok, true);
    // A short script with held gas plays on past its last command.
    const held = toReplay(parse('0 press up').timeline, w, { maxTicks: 300 });
    assert.equal(held.ticks, 300);
    assert.equal(decodeInputs(held.inputs).every((i) => i.gas), true);
});

// ---------------------------------------------------------------------------
// Timeline

test('timeline: held tail, edits, insert/delete, diff and change listeners', () => {
    const tl = new InputTimeline();
    const seen = [];
    const off = tl.onChange((t) => seen.push(t));
    assert.deepEqual(tl.get(5), { steer: 0, gas: false, brake: false, respawn: false });
    tl.set(10, { steer: 100, gas: true });
    assert.equal(tl.length, 11);
    assert.deepEqual(tl.get(500), { steer: 100, gas: true, brake: false, respawn: false });
    tl.set(10, { steer: 100, gas: true });            // no change, no notification
    tl.set(20, { steer: 100, gas: true });            // same as the held tail: no change
    assert.deepEqual(seen, [10]);
    tl.set(12, { steer: 100, gas: true, respawn: true });
    assert.equal(tl.get(12).respawn, true);
    assert.equal(tl.get(13).respawn, false, 'respawn is never held');
    tl.patchRange(0, 5, { brake: true });
    assert.deepEqual([tl.get(4).brake, tl.get(5).brake, tl.get(4).steer], [true, false, 0]);
    tl.nudgeSteer(10, 12, 70000);
    assert.equal(tl.get(10).steer, STEER_MAX);
    assert.deepEqual(seen, [10, 12, 0, 10]);

    const before = tl.clone();
    tl.insertTicks(3, 4);
    assert.equal(tl.get(3).brake, true, 'inserted ticks hold the previous input');
    assert.equal(tl.firstDifference(before), 5);
    tl.deleteTicks(3, 4);
    assert.equal(tl.equals(before), true);
    assert.equal(seen.slice(-2).join(), '3,3');

    tl.batch(() => { tl.set(8, { gas: true }); tl.set(2, { steer: 5 }); });
    assert.equal(seen[seen.length - 1], 2, 'a batch notifies once with the lowest tick');
    const d = tl.diff(before);
    assert.deepEqual(d, [{ from: 2, to: 3 }, { from: 8, to: 9 }]);
    const longer = tl.clone();
    longer.set(40, { steer: -1 });
    assert.deepEqual(longer.diff(tl), [{ from: 40, to: Infinity }]);
    assert.equal(tl.hash(), tl.clone().materialize(300).hash(), 'held padding does not change the hash');
    assert.notEqual(tl.hash(), longer.hash());
    off();
    tl.set(0, { steer: 1 });
    assert.equal(seen[seen.length - 1], 2, 'unsubscribed');
    const v = tl.version;
    tl.truncate(1);
    assert.equal(tl.version, v + 1);
    assert.equal(tl.get(50).steer, 1);
    assert.deepEqual(InputTimeline.decode(tl.encode()).toInputs(), tl.toInputs());
    assert.deepEqual(new InputTimeline(3).changePoints(), []);
    assert.deepEqual(parse('0.01 press up\n0.05 respawn').timeline.changePoints(), [1, 5]);
    assert.throws(() => tl.set(-1, {}), RangeError);
});

// ---------------------------------------------------------------------------
// Runner

test('runner: seek anywhere matches a plain re-simulation, and edits invalidate from the lowest tick', () => {
    const w = world('S03');
    const ap = runAutopilot(w, { record: true });
    const tl = fromReplay(ap.replay);
    const runner = new TasRunner(w, tl, { interval: 64 });
    const rng = new Rng(3);
    for (let i = 0; i < 12; i++) {
        const t = rng.int(tl.length + 200);
        runner.seek(t);
        assert.equal(runner.tick, t);
        assert.equal(runner.sim.stateHash(), stateAt(w, tl, t), `seek ${t}`);
    }
    runner.seek(1500);
    const edits = [];
    runner.on('edit', (e) => edits.push(e.tick));
    tl.setRange(900, 960, { steer: STEER_MAX, gas: false, brake: true });
    assert.deepEqual(edits, [900]);
    assert.ok(runner.cachedStates <= Math.floor(900 / 64) + 1, 'states after the edit are dropped');
    assert.equal(runner.tick, 1500, 'the cursor stays on its tick');
    assert.equal(runner.sim.stateHash(), stateAt(w, tl, 1500), 'and shows the edited run');
    runner.seek(800);
    assert.equal(runner.sim.stateHash(), stateAt(w, tl, 800));
    runner.step(250);
    assert.equal(runner.sim.stateHash(), stateAt(w, tl, 1050));
    const res = runner.result();
    const ref = simulateTimeline(w, tl);
    assert.equal(res.finished, ref.finished);
    assert.equal(res.ticks, ref.ticks);
    assert.deepEqual(res.checkpointTimes, ref.checkpointTimes);
});

test('runner: savestate slots, stale slots, record mode and playTo', () => {
    const w = world('S01');
    const tl = fromReplay(autopilot().replay);
    const runner = new TasRunner(w, tl);
    runner.seek(700);
    const slot = runner.save('apex');
    runner.seek(100);
    const loaded = runner.load('apex');
    assert.equal(loaded.stale, false);
    assert.equal(loaded.tick, 700);
    assert.equal(runner.sim.stateHash(), stateAt(w, tl, 700));
    assert.deepEqual(runner.sim.getState(), slot.state);
    tl.set(650, { steer: STEER_MAX, gas: true });
    const again = runner.load('apex');
    assert.equal(again.stale, true, 'an edit before the slot makes it stale');
    assert.equal(runner.sim.stateHash(), stateAt(w, tl, 700), 'a stale slot re-simulates with the new inputs');
    assert.throws(() => runner.load('nope'), /No savestate/);

    // Record: live inputs overwrite the timeline from the cursor on.
    runner.seek(300);
    runner.startRecording();
    assert.equal(tl.length, 300);
    for (let i = 0; i < 50; i++) runner.stepLive({ steer: -STEER_MAX, gas: true, brake: false });
    runner.stopRecording();
    assert.equal(runner.tick, 350);
    assert.equal(tl.get(320).steer, -STEER_MAX);
    assert.equal(runner.sim.stateHash(), stateAt(w, tl, 350));
    runner.stepLive({ steer: STEER_MAX }); // not recording: the timeline plays
    assert.equal(tl.get(350).steer, -STEER_MAX);
    const seen = [];
    runner.playTo(360, (sim) => seen.push(sim.tick));
    assert.deepEqual(seen, [352, 353, 354, 355, 356, 357, 358, 359, 360]);
    runner.playTo(10);
    assert.equal(runner.tick, 10);
});

test('runner: trace rebuilds only after the edit and equals a fresh trace; ghost compare', () => {
    const w = world('S01');
    const tl = fromReplay(autopilot().replay);
    const runner = new TasRunner(w, tl);
    const tr = runner.trace();
    assert.equal(tr.finished, true);
    assert.equal(tr.ticks, 2214);
    assert.equal(tr.speedKmh.length, 2215);
    assert.ok(tr.events.some((e) => e.type === 'finish' && e.tick === 2214));
    assert.ok(tr.progress[2214] > tr.progress[1000]);
    tl.setRange(1200, 1230, { steer: 0, gas: true, brake: false });
    const t0 = performance.now();
    const tr2 = runner.trace();
    const ms = performance.now() - t0;
    const fresh = new TasRunner(w, tl.clone()).trace();
    assert.equal(tr2.ticks, fresh.ticks);
    assert.deepEqual(Array.from(tr2.speedKmh), Array.from(fresh.speedKmh));
    assert.deepEqual(Array.from(tr2.pos), Array.from(fresh.pos));
    assert.deepEqual(tr2.events.map((e) => `${e.type}@${e.tick}`), fresh.events.map((e) => `${e.type}@${e.tick}`));
    info(`incremental trace after an edit at 12 s: ${ms.toFixed(1)} ms`);

    const base = fromReplay(autopilot().replay);
    const cmp = compareTimelines(w, base, tl);
    assert.equal(cmp.firstInputDifference, 1200);
    assert.ok(cmp.divergeTick > 1200 && cmp.divergeTick <= 1210, `diverges right after the edit (${cmp.divergeTick})`);
    assert.equal(cmp.splits.length, 2);
    assert.equal(cmp.splits[0].delta, 0, 'the first checkpoint is before the edit');
    assert.equal(cmp.a.finishTimeMs, 22140);
    assert.equal(cmp.finishDelta, cmp.b.finished ? cmp.b.finishTimeMs - 22140 : null);
    const same = runner.compare(tl.clone());
    assert.equal(same.divergeTick, -1);
    assert.equal(same.finishDelta, 0);
    const samples = ghostSamples(w, base, { sampleEvery: 10 });
    assert.equal(samples[samples.length - 1].tick, 2214);
});

test('runner: seeking anywhere in a 2-minute run is instant once cached', () => {
    const w = world('S06');
    const tl = parse('0 press up\n0.80-1.40 press right\n30-30.5 press left\n1:10-1:10.5 brake on').timeline;
    tl.materialize(12000);
    const runner = new TasRunner(w, tl, { laps: 3 });
    let t0 = performance.now();
    runner.seek(12000);
    const cold = performance.now() - t0;
    const rng = new Rng(11);
    t0 = performance.now();
    for (let i = 0; i < 300; i++) runner.seek(rng.int(12001));
    const per = (performance.now() - t0) / 300;
    info(`cold seek to 2:00 ${cold.toFixed(0)} ms, then ${per.toFixed(2)} ms per random seek`);
    assert.ok(per < 10, `random seeks take ${per.toFixed(2)} ms`);
    runner.seek(7777);
    assert.equal(runner.sim.stateHash(), stateAt(w, tl, 7777));
});

// ---------------------------------------------------------------------------
// Bruteforce

test('bruteforce improves the autopilot run, deterministically, and the result verifies', () => {
    const w = world('S01');
    const base = fromReplay(autopilot().replay);
    const a = new Bruteforce(w, base, { seed: 5 });
    assert.equal(a.bestTimeMs(), 22140);
    const found = a.run(60);
    assert.ok(found.length > 0 && a.bestTimeMs() < 22140, `improved to ${a.describe()}`);
    for (let i = 1; i < found.length; i++) assert.ok(compareScores(found[i].score, found[i - 1].score) < 0, 'strictly better each time');
    // Batching does not matter; the seed does.
    const b = new Bruteforce(w, base, { seed: 5 });
    b.run(25); b.run(35);
    assert.deepEqual(b.best.score, a.best.score);
    assert.equal(b.bestTimeline().hash(), a.bestTimeline().hash());
    const best = a.bestTimeline();
    const rep = toReplay(best, w);
    assert.deepEqual(verifyReplay(w, rep), { ok: true, reason: null, finished: true, timeMs: a.bestTimeMs(), respawns: 0 });
    // Restarting candidates from savestates gives exactly what a full run gives.
    const check = new Bruteforce(w, best, { seed: 1 });
    assert.deepEqual(check.best.score, a.best.score);
    assert.equal(base.equals(fromReplay(autopilot().replay)), true, 'the base timeline is not modified');
    info(`60 iterations: ${a.describe()} (${found.length} improvements)`);
});

test('bruteforce: window, rules and targets (checkpoint, speed, position, custom)', () => {
    const w = world('S01');
    const base = fromReplay(autopilot().replay);
    const win = new Bruteforce(w, base, { seed: 2, window: { from: 600, to: 900 }, rules: { maxChanges: 4, shift: { weight: 0 } } });
    win.run(40);
    for (const imp of win.improvements) {
        for (const r of imp.timeline.diff(base)) {
            assert.ok(r.from >= 600 && (r.to <= 900 || r.from >= imp.timeline.length - 1), `change ${r.from}-${r.to} inside the window`);
        }
    }
    assert.throws(() => new Bruteforce(w, base, { rules: { shift: { weight: 0 }, steer: { weight: 0 }, gas: { weight: 0 }, brake: { weight: 0 } } }), /weight/);

    const cp = new Bruteforce(w, base, { seed: 3, target: { type: 'checkpoint', index: 1 } });
    assert.match(cp.describe(), /checkpoint 1 at 0:06\.61/);
    cp.run(30);
    assert.ok(cp.bestTimeMs() <= 6610);
    assert.ok(cp.window.to <= 661);

    const sp = new Bruteforce(w, base, { seed: 4, target: 'speed@5' });
    const v0 = -sp.best.score[0];
    sp.run(30);
    assert.ok(-sp.best.score[0] > v0, 'faster at 5 s');
    assert.equal(sp.best.ticks, 500);

    const goal = [300, 8, 300];
    const pos = new Bruteforce(w, base, { seed: 4, target: { type: 'position', point: goal, tick: 400 } });
    const d0 = pos.best.score[0];
    pos.run(30);
    assert.ok(pos.best.score[0] <= d0);

    // A custom evaluator: maximise the height reached by 3 s (lower score is better).
    const custom = new Bruteforce(w, base, {
        seed: 9,
        target: { name: 'airtime', stopTick: 300, begin: () => ({ top: 0 }), tick: (sim, acc) => { acc.top = Math.max(acc.top, sim.car.pos[1]); }, score: (sim, acc) => -acc.top },
    });
    custom.run(10);
    assert.equal(custom.target.name, 'airtime');
    const fn = new Bruteforce(w, base, { target: { type: 'custom', source: '(sim) => -sim.car.speed' } });
    assert.equal(fn.best.ticks, 2214, 'a custom score is taken at the finish by default');

    assert.deepEqual(parseTargetSpec('checkpoint:2'), { type: 'checkpoint', index: 2 });
    assert.deepEqual(parseTargetSpec('speed@12.5'), { type: 'speed', tick: 1250 });
    assert.deepEqual(parseTargetSpec('position:1,-2,3.5@4'), { type: 'position', point: [1, -2, 3.5], tick: 400, mode: 'min' });
    assert.equal(parseTargetSpec('position-at:1,2,3@4').mode, 'at');
    assert.throws(() => parseTargetSpec('fastest'), /Unknown target/);
    assert.equal(compareScores([0, 1, 2], [0, 1, 3]), -1);
    assert.equal(compareScores(5, [5]), 0);
});

test('bruteforce session protocol (what the worker runs)', () => {
    const msgs = [];
    const queue = [];
    const session = new BruteforceSession((m) => msgs.push(m), { schedule: (fn) => queue.push(fn) });
    session.handle({
        type: 'start', track: getSample('S01'), inputs: autopilot().replay.inputs,
        options: { seed: 5, target: 'finish' }, maxIterations: 20, sliceMs: 5, reportMs: 0,
    });
    assert.equal(msgs[0].type, 'ready');
    assert.equal(msgs[0].best.timeMs, 22140);
    let guard = 0;
    while (queue.length && guard++ < 10000) queue.shift()();
    const done = msgs[msgs.length - 1];
    assert.equal(done.type, 'done');
    assert.equal(done.reason, 'iterations');
    assert.equal(done.iterations, 20);
    assert.ok(msgs.some((m) => m.type === 'improvement'));
    assert.ok(msgs.some((m) => m.type === 'progress'));
    const rep = toReplay(InputTimeline.decode(done.inputs), world('S01'));
    assert.equal(rep.timeMs, done.best.timeMs);
    assert.equal(verifyReplay(world('S01'), rep).ok, true);

    const errs = [];
    new BruteforceSession((m) => errs.push(m)).handle({ type: 'start', track: getSample('S01'), script: '0 press sideways' });
    assert.equal(errs[0].type, 'error');
    assert.match(errs[0].message, /line 1/);
});

test('bruteforce worker file speaks the protocol (worker_threads shim)', async () => {
    const workerUrl = pathToFileURL(path.join(ROOT, 'js/tas/bruteforce-worker.js')).href;
    const boot = `
        import { parentPort } from 'node:worker_threads';
        globalThis.self = { postMessage: (m) => parentPort.postMessage(m) };
        await import(${JSON.stringify(workerUrl)});
        parentPort.on('message', (m) => self.onmessage({ data: m }));
        parentPort.postMessage({ type: 'booted' });`;
    const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(boot)}`));
    try {
        const done = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('worker timed out')), 20000);
            worker.on('error', reject);
            worker.on('message', (m) => {
                if (m.type === 'booted') {
                    worker.postMessage({ type: 'start', track: getSample('S01'), inputs: autopilot().replay.inputs, options: { seed: 5 }, maxIterations: 15 });
                } else if (m.type === 'done' || m.type === 'error') {
                    clearTimeout(timer);
                    resolve(m);
                }
            });
        });
        assert.equal(done.type, 'done');
        assert.equal(done.iterations, 15);
        assert.ok(done.best.timeMs <= 22140);
    } finally {
        await worker.terminate();
    }
});

// ---------------------------------------------------------------------------
// CLI

test('CLI: autopilot, run, bruteforce, from-replay, compare', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pt-tas-'));
    const cli = (...args) => execFileSync(process.execPath, [path.join(ROOT, 'tools/tas.mjs'), ...args], { encoding: 'utf8' });
    try {
        const ap = path.join(dir, 'ap.txt'), bf = path.join(dir, 'bf.txt'), rep = path.join(dir, 'bf.json');
        assert.match(cli('autopilot', 'S01', '--out', ap), /0:22\.14/);
        const run = cli('run', ap);
        assert.match(run, /CP 1\s+0:06\.61/);
        assert.match(run, /Finish\s+0:22\.14/);
        assert.match(run, /Valid\s+yes/);
        const out = cli('bruteforce', 'S01', ap, '--iterations', '12', '--seed', '5', '--window', '0-22', '--out', bf, '--quiet');
        assert.match(out, /Valid\s+yes/);
        const json = JSON.parse(cli('run', bf, '--json', '--replay', rep));
        assert.equal(json.valid, true);
        assert.ok(json.finishTimeMs < 22140);
        assert.match(cli('from-replay', rep), /# track: S01/);
        // The game's replay codes (compressed PTR2 here) go both ways.
        const code = cli('to-replay', bf, '--code').trim();
        assert.match(code, /^PTR[12]\./);
        const back = path.join(dir, 'back.txt');
        cli('from-replay', code, '--out', back);
        assert.match(cli('run', back), /Valid\s+yes/);
        assert.match(cli('compare', ap, bf), /Finish\s+0:22\.14\s+0:2\d\.\d\d\s+-0\.\d\d/);
        writeFileSync(path.join(dir, 'bad.txt'), '0 press up\n1.234 press left\n');
        assert.throws(() => execFileSync(process.execPath, [path.join(ROOT, 'tools/tas.mjs'), 'run', 'S01', path.join(dir, 'bad.txt')], { stdio: 'pipe' }),
            (e) => /bad\.txt:2: error/.test(String(e.stderr)));
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
