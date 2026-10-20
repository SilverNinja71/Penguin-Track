// AI Lab (js/ai/lab-logic.js, js/ai/lab-playback.js): presets and run configs,
// which agents the live view shows, model files in storage, imports, and the
// field playback reproducing every evaluated episode (and its decisions).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from './_harness.mjs';
import {
    PRESETS, PRESET_IDS, presetSettings, sanitizeSettings, matchPreset, parseHidden, runConfig, envConfigFor,
    autoSeconds, pickShown, rankColor, historyRows, compactHistory, niceRange, buildModelFile, modelSummary,
    listModels, saveModel, deleteModel, uniqueName, classifyImport, trackForFile, archLabel, paramCountOf, reasonLabel,
} from '../../js/ai/lab-logic.js';
import { FieldPlayback, obsGroup, COAST_TICKS } from '../../js/ai/lab-playback.js';
import { NeuroTrainer, LocalEvaluator } from '../../js/ai/neuro.js';
import { loadModelFile } from '../../js/ai/policy.js';
import { observationLayout } from '../../js/ai/env.js';
import { getSample } from '../../js/core/samples.js';
import { buildWorld } from '../../js/core/track.js';
import { encodeTrack, trackHash } from '../../js/core/codec.js';

function memoryStorage() {
    const m = new Map();
    return {
        get: (k, d = null) => (m.has(k) ? JSON.parse(m.get(k)) : d),
        set: (k, v) => {
            m.set(k, JSON.stringify(v));
            return true;
        },
        remove: (k) => m.delete(k),
    };
}

const s01 = getSample('S01');
const world = buildWorld(s01);

test('presets are valid, distinct and recognised', () => {
    assert.deepEqual(PRESET_IDS, ['quick', 'balanced', 'deep']);
    for (const id of PRESET_IDS) {
        const s = presetSettings(id);
        assert.deepEqual(sanitizeSettings(s), s, `${id} survives sanitizing`);
        assert.equal(matchPreset(s), id);
        assert.equal(matchPreset({ ...s, seed: 77 }), id, 'the seed does not change the preset');
        const rc = runConfig(s, world);
        assert.equal(rc.arch.sizes[0], observationLayout(rc.envConfig).length, `${id}: network input = observations`);
        assert.equal(rc.arch.sizes.at(-1), s.action === 'discrete' ? 9 : 2);
    }
    assert.equal(matchPreset({ ...presetSettings('quick'), popSize: 40 }), null);
    assert.ok(PRESETS.quick.popSize < PRESETS.balanced.popSize && PRESETS.balanced.popSize < PRESETS.deep.popSize);
});

test('settings sanitising: clamps, even ES populations, hidden layers', () => {
    const s = sanitizeSettings({ algo: 'es', popSize: 33, hidden: '64x32', frameSkip: 99, edgeRays: -3, maxSeconds: '45', lookahead: 'nope' });
    assert.equal(s.popSize, 34);
    assert.equal(s.hidden, '64,32');
    assert.equal(s.frameSkip, 20);
    assert.equal(s.edgeRays, 0);
    assert.equal(s.maxSeconds, 45);
    assert.equal(s.lookahead, 'standard');
    assert.equal(sanitizeSettings({ hidden: '0,5' }).hidden, '32,32');
    assert.deepEqual(parseHidden('16, 16'), [16, 16]);
    assert.equal(parseHidden(''), null);
    assert.equal(parseHidden('1,2,3,4,5'), null);
    const ec = envConfigFor({ ...presetSettings('deep'), wallRays: 5 }, world);
    assert.equal(ec.obs.edgeRays, 21);
    assert.equal(ec.obs.collisionRays, 5);
    assert.deepEqual(ec.obs.lookahead, [10, 25, 50, 90, 150]);
    assert.equal(ec.maxSeconds, autoSeconds(world));
    assert.ok(autoSeconds(world) >= 30 && autoSeconds(world) % 10 === 0);
});

test('pickShown spreads the field over the ranking, best first', () => {
    const fit = Array.from({ length: 65 }, (_, i) => (i * 37) % 65);
    const shown = pickShown(fit, 32);
    assert.equal(shown.length, 32);
    assert.equal(new Set(shown.map((s) => s.index)).size, 32);
    assert.equal(fit[shown[0].index], 64, 'the best comes first');
    assert.equal(fit[shown.at(-1).index], 0, 'the worst is included');
    for (let i = 1; i < shown.length; i++) assert.ok(shown[i].rank > shown[i - 1].rank);
    const small = pickShown([3, 9, 9, 1], 32);
    assert.deepEqual(small.map((s) => s.index), [1, 2, 0, 3], 'ties keep the lower index first');
    assert.equal(rankColor(0, 10), '#ffd54a');
    assert.match(rankColor(5, 10), /^#[0-9a-f]{6}$/);
});

test('chart helpers: history rows from trainers and model files', () => {
    const rows = historyRows([{ generation: 0, best: 50.1234, mean: 20, finishRate: 0.1, bestTimeMs: null }]);
    assert.deepEqual(compactHistory(rows), [[0, 50.123, 20, 0.1, null]]);
    assert.deepEqual(historyRows([[3, 140, 90, 0.5, 21000]])[0], { generation: 3, best: 140, mean: 90, finishRate: 0.5, bestTimeMs: 21000 });
    const [lo, hi] = niceRange([10, 20]);
    assert.ok(lo < 10 && hi > 20);
    assert.deepEqual(niceRange([]), [0, 1]);
    assert.ok(niceRange([5, 5])[1] > niceRange([5, 5])[0]);
});

/** Evaluator that keeps every generation's results with replays (what the Lab does around the worker pool). */
class Capturing {
    constructor(inner) {
        this.inner = inner;
        this.last = null;
    }

    async evaluate(list, opts) {
        const results = await this.inner.evaluate(list, { ...opts, replay: true });
        this.last = { list: list.map((p) => Float64Array.from(p)), results };
        return results;
    }
}

test('field playback re-drives every evaluated episode and the network decisions', async () => {
    const s = { ...presetSettings('quick'), popSize: 6, hidden: '8', maxSeconds: 40 };
    const rc = runConfig(s, world);
    const cap = new Capturing(new LocalEvaluator({ world, envConfig: rc.envConfig, arch: rc.arch, episodes: 1 }));
    const trainer = new NeuroTrainer({ ...rc.trainer, evaluator: cap });
    await trainer.step();
    await trainer.step();
    const { list, results } = cap.last;
    const shown = pickShown(results.map((r) => r.fitness), 4);
    const entries = shown.map(({ index, rank }) => ({ replay: results[index].replay, params: list[index], rank, info: results[index].info }));
    const pb = new FieldPlayback({ world, envConfig: rc.envConfig, arch: rc.arch, entries });
    assert.equal(pb.bestIndex(), 0);
    let checked = 0;
    while (!pb.over) {
        const d = pb.decision;
        if (d && d.driving && d.tick % rc.envConfig.frameSkip === 0 && d.outputs) {
            // The network's argmax is the action the recorded run applied.
            let best = 0;
            for (let i = 1; i < d.outputs.length; i++) if (d.outputs[i] > d.outputs[best]) best = i;
            assert.equal(best, d.action, `tick ${d.tick}`);
            checked++;
        }
        pb.step();
    }
    assert.ok(checked > 10, `checked ${checked} decisions`);
    for (const c of pb.cars) {
        const info = c.entry.info;
        assert.ok(c.done);
        assert.equal(c.finished, info.finished);
        assert.equal(c.endTick, info.ticks, 'the episode ends where the worker stopped it');
        if (!info.finished) assert.ok(Math.abs(c.env.tracker.progress - info.progress) < 1e-6, 'same progress');
    }
    pb.setFocus(1);
    assert.equal(pb.focus, 1);
    pb.setFocus(-1);
    assert.equal(pb.focus, pb.cars.length - 1);
    assert.ok(obsGroup(pb.decision, 'edge@').length === rc.envConfig.obs.edgeRays);
});

test('model files: built like tools/train.mjs, stored, listed, deleted', async () => {
    const s = { ...presetSettings('quick'), popSize: 4, hidden: '8', maxSeconds: 30 };
    const rc = runConfig(s, world);
    const ev = new LocalEvaluator({ world, envConfig: rc.envConfig, arch: rc.arch });
    const trainer = new NeuroTrainer({ ...rc.trainer, evaluator: ev });
    await trainer.step();
    const file = buildModelFile({
        name: 'Test pingu', world, envConfig: rc.envConfig, arch: rc.arch, trainSeconds: 3, date: '2026-01-01T00:00:00Z',
        run: { algo: trainer.algo, seed: trainer.seed, generation: trainer.generation, evaluations: trainer.evaluations, popSize: 4, history: trainer.history, best: trainer.best },
    });
    const loaded = loadModelFile(JSON.parse(JSON.stringify(file)));
    assert.equal(archLabel(loaded.net.arch), rc.arch.sizes.join('-'));
    assert.equal(paramCountOf(rc.arch), loaded.net.paramCount);
    assert.equal(file.trackHash, world.hash);
    assert.equal(file.stats.history.length, 1);
    assert.equal(file.replay.name, 'Test pingu (AI)');
    const sum = modelSummary(file);
    assert.equal(sum.trackId, 'S01');
    assert.equal(sum.algo, 'GA');

    const st = memoryStorage();
    assert.ok(saveModel(st, file));
    saveModel(st, { ...file, name: 'Older', date: '2025-01-01T00:00:00Z' });
    assert.deepEqual(listModels(st).map((m) => m.name), ['Test pingu', 'Older']);
    assert.equal(uniqueName('Test pingu', listModels(st).map((m) => m.name)), 'Test pingu (2)');
    assert.equal(uniqueName('Fresh', ['Test pingu']), 'Fresh');
    assert.ok(deleteModel(st, 'Older'));
    assert.ok(!deleteModel(st, 'Older'));
    assert.deepEqual(listModels(st).map((m) => m.name), ['Test pingu']);

    assert.equal(classifyImport(JSON.stringify(file)).kind, 'model');
    assert.equal(classifyImport(JSON.stringify({ format: 'penguintrack-train-run', trainer: {}, trackCode: 'PT1.x' })).kind, 'train-run');
    assert.equal(classifyImport(JSON.stringify(file.replay)).kind, 'other');
    assert.equal(classifyImport('PTR2.abc').kind, 'other');
    assert.throws(() => classifyImport('{nope'), /valid JSON/);
    const broken = JSON.parse(JSON.stringify(file));
    broken.env.obs.edgeRays = 3;
    assert.throws(() => classifyImport(JSON.stringify(broken)), /observations/);
});

test('trackForFile prefers the catalog track, falls back to the share code', () => {
    const file = { trackId: 'S01', trackHash: trackHash(s01), trackCode: encodeTrack(s01) };
    assert.equal(trackForFile(file, (id) => (id === 'S01' ? s01 : null)), s01);
    const moved = trackForFile({ ...file, trackHash: 'other' }, () => s01);
    assert.notEqual(moved, s01);
    assert.equal(trackHash(moved), trackHash(s01));
    assert.equal(trackForFile({ ...file, trackId: 'ZZZ' }, () => null).id, 'S01');
    assert.equal(reasonLabel('off-route'), 'left the road');
});

test('the demo driver loads and its ghost finishes in the field playback', () => {
    const file = JSON.parse(readFileSync(new URL('../../models/demo-S01.json', import.meta.url), 'utf8'));
    assert.equal(classifyImport(JSON.stringify(file)).kind, 'model');
    const m = loadModelFile(file);
    const track = trackForFile(file, (id) => getSample(id));
    const w = buildWorld(track);
    const pb = new FieldPlayback({ world: w, envConfig: m.envConfig, arch: m.net.arch, entries: [{ replay: file.replay, params: m.net.getParams(), rank: 0 }] });
    while (!pb.over) pb.step();
    const c = pb.cars[0];
    assert.ok(c.finished);
    assert.equal(c.sim.finishTimeMs, file.stats.timeMs);
    assert.equal(pb.tick, pb.endTick);
    assert.ok(pb.endTick >= c.endTick + COAST_TICKS);
});
