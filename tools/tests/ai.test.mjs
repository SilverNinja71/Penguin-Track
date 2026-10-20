// AI training kit: the gym-style env, the MLP, policies and model files,
// neuroevolution (determinism, resume), the worker pool, the headless JSON-lines
// server and the shipped demo model.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { test, info } from './_harness.mjs';
import { PenguinEnv, observationLayout, normalizeEnvConfig } from '../../js/ai/env.js';
import { MLP, dtanh, encodeF32, decodeF32 } from '../../js/ai/nn.js';
import { archFor, makePolicy, runEpisode, makeModelFile, loadModelFile } from '../../js/ai/policy.js';
import { GA, ES, NeuroTrainer, LocalEvaluator, centeredRanks, raceFitness, evaluateParams } from '../../js/ai/neuro.js';
import { EvalPool } from '../../js/ai/pool.js';
import { resolveTrack, resolveTrackSync, listTracks } from '../../js/ai/tracks.js';
import { getSample, getSamples } from '../../js/core/samples.js';
import { buildWorld } from '../../js/core/track.js';
import { encodeTrack } from '../../js/core/codec.js';
import { Autopilot } from '../../js/core/autopilot.js';
import { verifyReplay } from '../../js/core/replay.js';
import { Rng } from '../../js/core/rng.js';
import { STEER_MAX } from '../../js/core/constants.js';

const ROOT = new URL('../../', import.meta.url);
const worlds = new Map();
function world(id) {
    if (!worlds.has(id)) worlds.set(id, buildWorld(getSample(id)));
    return worlds.get(id);
}

/** A fixed pseudo-random gas-heavy action sequence. */
function actionPlan(n, seed = 1) {
    const rng = new Rng(seed);
    return Array.from({ length: n }, () => (rng.chance(0.7) ? 3 : rng.int(9)));
}

test('env: spaces match the layout; observations are finite and inside their bounds on every sample', () => {
    for (const t of getSamples()) {
        const env = new PenguinEnv({ world: world(t.id) });
        assert.equal(env.observationSpace.shape[0], env.obsSize);
        assert.equal(env.observationSpace.names.length, env.obsSize);
        assert.deepEqual(env.actionSpace, { type: 'discrete', n: 9, names: env.actionSpace.names });
        let obs = env.reset(1);
        for (const a of actionPlan(150, 7)) {
            assert.equal(obs.length, env.obsSize);
            for (let i = 0; i < obs.length; i++) {
                assert.ok(Number.isFinite(obs[i]), `${t.id} obs ${env.layout[i].name} not finite`);
                assert.ok(obs[i] >= env.layout[i].low && obs[i] <= env.layout[i].high, `${t.id} obs ${i} out of bounds`);
            }
            const r = env.step(a);
            assert.ok(Number.isFinite(r.reward));
            obs = r.obs;
            if (r.terminated || r.truncated) obs = env.reset();
        }
    }
    const layout = observationLayout({ obs: { edgeRays: 3, lookahead: [20], collisionRays: 2 } });
    assert.equal(layout.length, 75 - 12 - 18 + 2);
    assert.deepEqual(layout.filter((f) => f.name.startsWith('edge@')).map((f) => f.name), ['edge@-90', 'edge@0', 'edge@90']);
    assert.throws(() => normalizeEnvConfig({ frameSkip: 0 }), /frameSkip/);
    assert.throws(() => normalizeEnvConfig({ action: 'joystick' }), /action/);
});

test('env: the autopilot driven through the env finishes and the episode replay verifies', () => {
    const env = new PenguinEnv({ world: world('S03'), frameSkip: 1 });
    env.reset();
    const pilot = new Autopilot(env.world);
    let r, ret = 0;
    do {
        r = env.step(pilot.act(env.sim));
        ret += r.reward;
    } while (!r.terminated && !r.truncated);
    assert.equal(r.info.reason, 'finish');
    assert.equal(r.info.finishTimeMs, 24390);
    assert.ok(r.info.progressFrac > 0.99);
    assert.ok(Math.abs(ret - r.info.episodeReturn) < 1e-9);
    const v = verifyReplay(env.world, env.replay());
    assert.ok(v.ok, v.reason);
    assert.equal(v.timeMs, 24390);
    assert.throws(() => env.step(3), /reset/);
});

test('env: same actions give identical episodes; JSON savestates resume bit-identically', () => {
    const plan = actionPlan(400, 3);
    const run = (env, actions) => actions.map((a) => {
        const r = env.step(a);
        return [r.reward, Array.from(r.obs).join(','), r.terminated, r.truncated];
    });
    const a = new PenguinEnv({ world: world('S02') });
    const b = new PenguinEnv({ world: world('S02') });
    a.reset(5); b.reset(5);
    const first = run(a, plan.slice(0, 60));
    assert.deepEqual(first, run(b, plan.slice(0, 60)));
    const state = JSON.parse(JSON.stringify(a.getState()));
    const tailA = run(a, plan.slice(60, 120));
    const c = new PenguinEnv({ world: world('S02') });
    const obs = c.setState(state);
    assert.equal(obs.length, c.obsSize);
    assert.deepEqual(run(c, plan.slice(60, 120)), tailA);
    assert.equal(c.replay().inputs, a.replay().inputs);
    assert.equal(c.sim.stateHash(), a.sim.stateHash());
});

test('env: actions — discrete table, continuous [steer, throttle], input objects', () => {
    const env = new PenguinEnv({ world: world('S01'), action: 'continuous' });
    assert.deepEqual(env.actionSpace.shape, [2]);
    const i = (a) => ({ ...env.actionToInput(a) });
    assert.deepEqual(i([0.5, 0.7]), { steer: 0.5 * STEER_MAX, gas: true, brake: false, respawn: false });
    assert.deepEqual(i([-2, -0.6]), { steer: -STEER_MAX, gas: false, brake: true, respawn: false });
    assert.deepEqual(i([0, 0.2]), { steer: 0, gas: false, brake: false, respawn: false });
    assert.deepEqual(i(8), { steer: STEER_MAX, gas: false, brake: true, respawn: false });
    assert.deepEqual(i([3]), { steer: 0, gas: true, brake: false, respawn: false });
    assert.deepEqual(i({ steer: -100, gas: 1, brake: 0 }), { steer: -100, gas: true, brake: false, respawn: false });
    assert.throws(() => i(9), RangeError);
    assert.throws(() => i('left'), TypeError);
});

test('env: episodes end on finish, stuck, wrong way, off route and the time limit', () => {
    const go = (env, act) => {
        let r;
        do r = env.step(typeof act === 'function' ? act(env) : act); while (!r.terminated && !r.truncated);
        return r;
    };
    const s01 = world('S01');
    let env = new PenguinEnv({ world: s01 });
    env.reset();
    let r = go(env, 4);
    assert.equal(r.info.reason, 'stuck');
    assert.equal(r.info.ticks, 300);
    assert.ok(r.terminated && !r.truncated);

    // The Start igloo is walled behind: drive off first, then brake and reverse.
    env = new PenguinEnv({ world: s01, stuckSeconds: 20 });
    env.reset();
    for (let k = 0; k < 100; k++) env.step(3);
    r = go(env, 5);
    assert.equal(r.info.reason, 'wrong-way');

    env = new PenguinEnv({ world: s01, maxSeconds: 1 });
    env.reset();
    r = go(env, 3);
    assert.equal(r.info.reason, 'time');
    assert.ok(r.truncated && !r.terminated);
    assert.equal(r.info.ticks, 100);

    // Teleport the car 30 m to the side of the road: off the route within 0.5 s.
    env = new PenguinEnv({ world: s01 });
    env.reset();
    for (let k = 0; k < 10; k++) env.step(3);
    const st = env.getState();
    const { tangent: T, up: U } = env.route.project(env.sim.car.pos);
    const right = [T[1] * U[2] - T[2] * U[1], T[2] * U[0] - T[0] * U[2], T[0] * U[1] - T[1] * U[0]];
    for (let c = 0; c < 3; c++) st.sim.car.pos[c] += right[c] * 30;
    env.setState(st);
    r = go(env, 3);
    assert.equal(r.info.reason, 'off-route');
    assert.ok(r.info.ticks - 40 <= 52, `off-route took ${r.info.ticks - 40} ticks`);
});

test('env: random-checkpoint starts use autopilot snapshots and still record whole runs', () => {
    const env = new PenguinEnv({ world: world('S01'), startMode: 'random-checkpoint' });
    const starts = new Set();
    for (let seed = 0; seed < 12; seed++) {
        env.reset(seed);
        starts.add(env.sim.tick);
        assert.equal(env.recorder.length, env.sim.tick);
        assert.equal(env.info().ticks, 0);
    }
    assert.equal(starts.size, 3, `starts at ticks ${[...starts].join(', ')}`);   // start + 2 checkpoints
    // Same seed, same start.
    env.reset(4); const t4 = env.sim.tick;
    env.reset(4); assert.equal(env.sim.tick, t4);
    // From the last checkpoint, the autopilot finishes; the replay covers the run from GO.
    let seed = 0;
    while (env.reset(seed), env.sim.checkpointTimes.length < 2) seed++;
    const pilot = new Autopilot(env.world);
    let r;
    do r = env.step(pilot.act(env.sim)); while (!r.terminated && !r.truncated);
    assert.equal(r.info.reason, 'finish');
    const v = verifyReplay(env.world, env.replay());
    assert.ok(v.ok, v.reason);
});

test('nn: seeded init, flat params, deterministic tanh, JSON round trips', () => {
    const arch = { sizes: [5, 7, 3], activation: 'tanh', output: 'linear' };
    const a = new MLP({ ...arch, seed: 42 }), b = new MLP({ ...arch, seed: 42 }), c = new MLP({ ...arch, seed: 43 });
    assert.equal(a.paramCount, 5 * 7 + 7 + 7 * 3 + 3);
    assert.deepEqual(a.getParams(), b.getParams());
    assert.notDeepEqual(a.getParams(), c.getParams());
    for (const p of a.params) assert.equal(p, Math.fround(p));
    const x = [0.3, -1, 0.5, 2, 0];
    const y = Array.from(a.forward(x));
    // Manual forward pass.
    const P = a.params;
    const h = [];
    for (let o = 0; o < 7; o++) {
        let s = P[35 + o];
        for (let i = 0; i < 5; i++) s += P[o * 5 + i] * x[i];
        h.push(Math.tanh(s));
    }
    for (let o = 0; o < 3; o++) {
        let s = P[42 + 21 + o];
        for (let i = 0; i < 7; i++) s += P[42 + o * 7 + i] * h[i];
        assert.ok(Math.abs(s - y[o]) < 1e-12);
    }
    for (const v of [-30, -3, -0.5, -1e-9, 0, 1e-6, 0.7, 4, 25]) assert.ok(Math.abs(dtanh(v) - Math.tanh(v)) < 1e-15, `tanh(${v})`);
    for (const enc of ['f32', 'array']) {
        const r = MLP.fromJSON(JSON.parse(JSON.stringify(a.toJSON({ encoding: enc }))));
        assert.deepEqual(Array.from(r.forward(x)), y);
    }
    const odd = new Float64Array([0.1, -2.5e-8, 3]);
    assert.deepEqual(decodeF32(encodeF32(odd)), new Float64Array(Array.from(odd, Math.fround)));
    assert.throws(() => a.setParams(new Float64Array(3)), /parameters/);
    assert.throws(() => new MLP({ sizes: [3, 0] }), /sizes/);
    const relu = new MLP({ sizes: [2, 4, 2], activation: 'relu', output: 'tanh', seed: 1 });
    for (const v of relu.forward([5, -5])) assert.ok(v >= -1 && v <= 1);
});

test('policy: argmax / tanh heads, episodes, self-contained model files', () => {
    const w = world('S01');
    const envConfig = { maxSeconds: 8 };
    const arch = archFor(envConfig, [16]);
    assert.deepEqual(arch.sizes, [75, 16, 9]);
    assert.deepEqual(archFor({ action: 'continuous' }, [8]).sizes.slice(-1), [2]);
    const net = new MLP({ ...arch, seed: 9 });
    const env = new PenguinEnv({ world: w, ...envConfig });
    const pol = makePolicy(net, 'discrete');
    const ep = runEpisode(env, pol, { seed: 0 });
    assert.ok(ep.steps > 0 && Number.isFinite(ep.return));
    assert.equal(ep.replay.trackHash, w.hash);
    const file = JSON.parse(JSON.stringify(makeModelFile({ name: 'Test penguin', world: w, envConfig, net, stats: { x: 1 }, replay: ep.replay })));
    const loaded = loadModelFile(file);
    assert.equal(file.trackId, 'S01');
    assert.equal(file.trackHash, w.hash);
    const env2 = new PenguinEnv({ track: resolveTrackSync(file.trackCode), ...loaded.envConfig });
    const ep2 = runEpisode(env2, loaded.policy, { seed: 0 });
    assert.equal(ep2.return, ep.return);
    assert.equal(ep2.replay.inputs, ep.replay.inputs);
    const cont = makePolicy(new MLP({ ...archFor({ action: 'continuous' }, [8]), seed: 2 }), 'continuous');
    const a = cont.act(new Float32Array(75).fill(0.5));
    assert.equal(a.length, 2);
    assert.ok(a.every((v) => v >= -1 && v <= 1));
    assert.throws(() => loadModelFile({ format: 'nope' }), /model/);
});

test('neuro: race fitness ranks any finish above any crash, then by time; return fitness is the reward sum', () => {
    assert.equal(raceFitness({ finished: true, finishTimeMs: 19700, progressFrac: 1 }, 70), 150.3);
    assert.equal(raceFitness({ finished: false, progressFrac: 0.5 }, 70), 50);
    assert.ok(raceFitness({ finished: false, progressFrac: 1.2 }, 70) < 100);
    assert.equal(raceFitness({ finished: false, progressFrac: -0.1 }, 70), 0);
    assert.ok(raceFitness({ finished: true, finishTimeMs: 69990 }, 70) > raceFitness({ finished: false, progressFrac: 0.9999 }, 70));
    const env = new PenguinEnv({ world: world('S01'), maxSeconds: 6 });
    const arch = archFor({}, [4]);
    const net = new MLP({ ...arch, seed: 3 });
    const pol = makePolicy(net, 'discrete');
    const race = evaluateParams(env, net, pol, net.getParams(), {});
    const ret = evaluateParams(env, net, pol, net.getParams(), { fitness: 'return', episodes: 2 });
    assert.equal(race.fitness, 100 * race.info.progressFrac);
    assert.equal(ret.fitness, ret.info.episodeReturn);
    assert.equal(ret.info.finishRate, 0);
    assert.throws(() => evaluateParams(env, net, pol, net.getParams(), { fitness: 'vibes' }), /fitness/);
});

test('neuro: centered ranks; GA and ES climb a synthetic hill', async () => {
    const ranks = centeredRanks([3, 1, 2, 2]);
    [0.5, -0.5, -1 / 6, 1 / 6].forEach((v, i) => assert.ok(Math.abs(ranks[i] - v) < 1e-12));
    const n = 20;
    const target = Float64Array.from({ length: n }, (_, i) => Math.sin(i));
    const fit = (p) => -p.reduce((s, v, i) => s + (v - target[i]) ** 2, 0);
    const evaluator = { evaluate: async (list) => list.map((p) => ({ fitness: fit(p), info: {} })) };
    const init = (rng) => Float64Array.from({ length: n }, () => rng.normal(0, 0.1));
    for (const opt of [
        new GA({ paramCount: n, init, seed: 3, popSize: 32, mutationStd: 0.05 }),
        new ES({ paramCount: n, init, seed: 3, popSize: 32, sigma: 0.05, lr: 0.05, l2: 0 }),
    ]) {
        let start = null, best = -Infinity;
        for (let g = 0; g < 60; g++) {
            const cands = opt.ask();
            const res = await evaluator.evaluate(cands);
            const f = res.map((r) => r.fitness);
            if (start === null) start = Math.max(...f);
            best = Math.max(best, ...f);
            opt.tell(f);
        }
        info(`${opt.constructor.name}: best ${start.toFixed(3)} -> ${best.toFixed(3)}`);
        assert.ok(best > start * 0.1, `${opt.constructor.name} did not climb (${start} -> ${best})`);
    }
});

test('neuro: the same seed gives the same training curve; resume continues it exactly', async () => {
    const w = world('S01');
    const envConfig = { maxSeconds: 5 };
    const arch = archFor(envConfig, [8]);
    const curve = async (algo, seed, gens, from = null) => {
        const evaluator = new LocalEvaluator({ world: w, envConfig, arch });
        const t = from ? new NeuroTrainer({ state: from, evaluator }) : new NeuroTrainer({ algo, arch, seed, evaluator, popSize: 8 });
        for (let g = 0; g < gens; g++) await t.step();
        return t;
    };
    const strip = (h) => h.map(({ evalMs, ...rest }) => rest);
    for (const algo of ['ga', 'es']) {
        const a = await curve(algo, 1, 3);
        const b = await curve(algo, 1, 3);
        const c = await curve(algo, 2, 3);
        assert.deepEqual(strip(a.history), strip(b.history), `${algo} curves differ for one seed`);
        assert.deepEqual(a.best.params, b.best.params);
        assert.notDeepEqual(strip(a.history), strip(c.history), `${algo} ignores the seed`);
        const half = await curve(algo, 1, 2);
        const resumed = await curve(algo, 1, 1, JSON.parse(JSON.stringify(half.getState())));
        assert.deepEqual(strip(resumed.history), strip(a.history), `${algo} resume diverged`);
        info(`${algo}: best per generation ${a.history.map((h) => h.best.toFixed(3)).join(' ')}`);
    }
});

test('worker: a worker_threads pool scores exactly like the in-thread evaluator', async () => {
    const track = getSample('S01');
    const envConfig = { maxSeconds: 6 };
    const arch = archFor(envConfig, [8]);
    const workers = [0, 1].map(() => new Worker(new URL('js/ai/worker.js', ROOT)));
    const pool = new EvalPool(workers);
    try {
        const ready = await pool.init({ trackJSON: track, envConfig, arch });
        assert.equal(ready.type, 'ready');
        assert.equal(ready.obsSize, 75);
        assert.equal(ready.trackHash, world('S01').hash);
        const rng = new Rng(5);
        const list = [0, 1, 2, 3, 4].map(() => MLP.randomParams(arch, rng));
        const local = new LocalEvaluator({ world: world('S01'), envConfig, arch });
        const expect = await local.evaluate(list, { seed: 3 });
        const got = await pool.evaluate(list, { seed: 3 });
        assert.deepEqual(got.map((r) => r.fitness), expect.map((r) => r.fitness));
        assert.deepEqual(got.map((r) => r.info), expect.map((r) => r.info));
        const withReplay = await pool.evaluate(list.slice(0, 1), { replay: true });
        assert.ok(withReplay[0].replay && withReplay[0].replay.inputs.startsWith('1:'));
        await assert.rejects(pool.evaluate([new Float64Array(3)]), /parameters/);
    } finally {
        pool.close();
    }
});

test('headless: JSON-lines protocol (make, reset, step, batch, savestates, replay, errors)', async () => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('tools/headless.mjs', ROOT))], { stdio: ['pipe', 'pipe', 'inherit'] });
    let buf = '';
    const waiting = [];
    child.stdout.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i);
            buf = buf.slice(i + 1);
            waiting.shift()(JSON.parse(line));
        }
    });
    const send = (msg) => new Promise((resolve) => {
        waiting.push(resolve);
        child.stdin.write((typeof msg === 'string' ? msg : JSON.stringify(msg)) + '\n');
    });
    const f32 = (b64) => {
        const buf = Buffer.from(b64, 'base64');
        return Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4));
    };
    try {
        assert.equal((await send({ cmd: 'ping', id: 7 })).id, 7);
        assert.match((await send('{nope')).error, /Bad JSON/);
        assert.match((await send({ cmd: 'step', action: 3 })).error, /make/);
        const made = await send({ cmd: 'make', track: 'S01', config: { maxSeconds: 30 } });
        assert.ok(made.ok);
        assert.deepEqual(made.observation_space.shape, [75]);
        assert.equal(made.action_space.n, 9);
        assert.equal(made.track.hash, world('S01').hash);
        const r0 = await send({ cmd: 'reset', seed: 1 });
        const env = new PenguinEnv({ world: world('S01'), maxSeconds: 30 });
        assert.deepEqual(f32(r0.obs), Array.from(env.reset(1)));
        const plan = actionPlan(30, 9);
        for (const a of plan.slice(0, 15)) {
            const r = await send({ cmd: 'step', action: a });
            const e = env.step(a);
            assert.equal(r.reward, e.reward);
            assert.deepEqual(f32(r.obs), Array.from(e.obs));
        }
        const st = (await send({ cmd: 'get_state' })).state;
        const tail = [];
        for (const a of plan.slice(15)) tail.push((await send({ cmd: 'step', action: a })).reward);
        const back = await send({ cmd: 'set_state', state: st });
        assert.ok(back.ok);
        for (const [k, a] of plan.slice(15).entries()) assert.equal((await send({ cmd: 'step', action: a })).reward, tail[k]);
        const rep = (await send({ cmd: 'replay' })).replay;
        assert.equal(rep.ticks, 30 * 4);
        assert.match((await send({ cmd: 'step', action: 99 })).error, /Unknown action/);
        assert.match((await send({ cmd: 'warp' })).error, /Unknown cmd/);
        const vec = await send({ cmd: 'make', track: encodeTrack(getSample('S06')), num_envs: 3, obs_encoding: 'list', config: { maxSeconds: 1 } });
        assert.equal(vec.num_envs, 3);
        await send({ cmd: 'reset_all', seed: 1 });
        let ends = 0;
        for (let k = 0; k < 30; k++) {
            const b = await send({ cmd: 'step_batch', actions: [3, 4, 0] });
            assert.equal(b.obs.length, 3);
            assert.equal(b.obs[0].length, 75);
            for (let e = 0; e < 3; e++) if (b.truncated[e] || b.terminated[e]) { ends++; assert.equal(b.info[e].final_obs.length, 75); }
        }
        assert.ok(ends >= 3, `only ${ends} auto-resets`);
        assert.ok((await send({ cmd: 'replay', env: 1, last: true })).replay.ticks > 0);
        assert.match((await send({ cmd: 'step_batch', actions: [3] })).error, /3 actions/);
        assert.deepEqual(await send({ cmd: 'close', id: 'x' }), { ok: true, id: 'x' });
        const code = await new Promise((resolve) => child.on('exit', resolve));
        assert.equal(code, 0);
    } finally {
        child.kill();
    }
});

test('tracks: sample ids, share codes, JSON text, levels when present', async () => {
    assert.equal((await resolveTrack('S03')).id, 'S03');
    assert.equal((await resolveTrack('s05')).id, 'S05');
    const code = encodeTrack(getSample('S02'));
    assert.equal(buildWorld(await resolveTrack(code)).hash, world('S02').hash);
    assert.equal((await resolveTrack(JSON.stringify(getSample('S01')))).name, 'Frosty Oval');
    await assert.rejects(resolveTrack('NOPE-99'), /Unknown track/);
    const list = await listTracks();
    for (const id of ['S01', 'S06']) assert.ok(list.some((t) => t.id === id));
    const official = list.filter((t) => t.source === 'levels');
    if (official.length) {
        const t = await resolveTrack(official[0].id);
        assert.equal(t.id, official[0].id);
        info(`${official.length} official tracks found (${official[0].id} ${official[0].name} ...)`);
    } else {
        info('js/levels/index.js not available: samples only');
    }
});

test('demo model: models/demo-S01.json loads, finishes S01 and carries a verified ghost', () => {
    const path = new URL('models/demo-S01.json', ROOT);
    if (!existsSync(path)) {
        info('models/demo-S01.json not found (train it with tools/train.mjs)');
        return;
    }
    const file = JSON.parse(readFileSync(path, 'utf8'));
    const { policy, envConfig } = loadModelFile(file);
    const w = world('S01');
    assert.equal(file.trackHash, w.hash);
    const env = new PenguinEnv({ world: w, ...envConfig, startMode: 'start' });
    const ep = runEpisode(env, policy, { seed: 0 });
    assert.equal(ep.info.reason, 'finish');
    assert.equal(ep.replay.inputs, file.replay.inputs);
    const v = verifyReplay(w, file.replay);
    assert.ok(v.ok, v.reason);
    assert.equal(v.timeMs, file.stats.timeMs);
    info(`demo driver: ${(v.timeMs / 1000).toFixed(2)} s on S01 (autopilot 22.14 s), ${file.stats.generations} generations`);
});
