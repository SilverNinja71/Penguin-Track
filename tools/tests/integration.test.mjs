// Cross-module contracts: what the shell calls on the renderer and audio engine
// exists there, the catalog and levels agree on tracks and medals, and core
// validation treats platform medals (respawn caps) correctly.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from './_harness.mjs';
import { RENDERER_METHODS, AUDIO_METHODS, NullRenderer, NullAudio, hardenAudio } from '../../js/game/stubs.js';
import { AudioEngine } from '../../js/audio/audio.js';
import { makeCatalog } from '../../js/game/catalog.js';
import * as levels from '../../js/levels/index.js';
import { validateTrack, buildWorld } from '../../js/core/track.js';
import { getSample } from '../../js/core/samples.js';
import { GhostRun } from '../../js/game/ghost.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(path.join(root, p), 'utf8');

function memoryStorage() {
    const m = new Map();
    return {
        get: (k, d = null) => (m.has(k) ? JSON.parse(m.get(k)) : d),
        set: (k, v) => (m.set(k, JSON.stringify(v)), true),
        update(k, d, fn) {
            const v = fn(this.get(k, d));
            this.set(k, v);
            return v;
        },
        remove: (k) => m.delete(k),
    };
}

/** Method names called as `<obj>.name(` across the shell sources. */
function shellCalls(objPattern) {
    const files = ['js/main.js', ...readdirSync(path.join(root, 'js/game')).map((f) => `js/game/${f}`)];
    const re = new RegExp(`${objPattern}\\.([a-zA-Z_]\\w*)\\(`, 'g');
    const out = new Set();
    for (const f of files) for (const m of read(f).matchAll(re)) out.add(m[1]);
    return out;
}

test('every renderer method the shell calls is a GameRenderer method and has a stand-in', () => {
    const src = read('js/render/renderer.js');
    const cls = src.slice(src.indexOf('export class GameRenderer'));
    const has = (m) => new RegExp(`\\n    ${m}\\(`).test(cls);
    for (const m of RENDERER_METHODS) {
        assert.ok(has(m), `GameRenderer.${m}`);
        assert.equal(typeof NullRenderer.prototype[m], 'function', `NullRenderer.${m}`);
    }
    for (const m of shellCalls('renderer')) assert.ok(RENDERER_METHODS.includes(m) || m === 'snapshotCar', `shell calls renderer.${m}, which is not in RENDERER_METHODS`);
});

test('every audio method the shell calls exists on AudioEngine and NullAudio', () => {
    for (const m of AUDIO_METHODS) {
        assert.equal(typeof AudioEngine.prototype[m], 'function', `AudioEngine.${m}`);
        assert.equal(typeof NullAudio.prototype[m], 'function', `NullAudio.${m}`);
    }
    for (const m of shellCalls('audio')) assert.ok(AUDIO_METHODS.includes(m), `shell calls audio.${m}, which is not in AUDIO_METHODS`);
    // Without WebAudio (Node) the hardened engine is inert and never throws.
    const a = hardenAudio(new AudioEngine());
    a.autoUnlock(null);
    a.setVolume({ master: 0.5 });
    a.music(true);
    a.ui('medal', 'emperor');
    a.handleEvents([{ type: 'checkpoint', diff: -120 }, { type: 'finish' }]);
    a.updateCar(null, 0.016);
    a.stopCar();
});

test('catalog and levels agree: 35 official tracks, ids unique, medals earnable', () => {
    const cat = makeCatalog({ storage: memoryStorage() });
    const ids = cat.campaignIds();
    assert.equal(ids.length, 35);
    assert.equal(new Set(ids).size, 35);
    for (const id of ids) {
        const info = cat.info(id);
        const track = cat.getTrack(id);
        assert.equal(track.id, id);
        assert.equal(info.mode, track.mode, `${id} mode`);
        assert.deepEqual({ ...info.medals }, track.medals, `${id} summary medals`);
        // The author time with no respawns is always the Emperor medal.
        assert.equal(cat.medalFor(track, { timeMs: track.medals.author, respawns: 0 }), 'emperor', id);
        assert.equal(cat.medalTargets(info).length, 4, `${id} medal targets from the summary`);
    }
    const tiers = cat.campaigns().find((c) => c.id === 'race').tiers.map((t) => t.tracks.length);
    assert.deepEqual(tiers, [5, 5, 5, 5, 5]);
});

test('platform medals validate cleanly; out-of-order race medals still warn', () => {
    for (const id of levels.trackIds().filter((x) => levels.trackInfo(x).mode === 'platform')) {
        const codes = validateTrack(levels.getTrack(id)).issues.map((i) => i.code);
        assert.ok(!codes.includes('medalOrder'), `${id}: ${codes}`);
    }
    const race = { ...getSample('S01'), medals: { author: 30000, gold: 20000, silver: 40000, bronze: 50000 } };
    assert.ok(validateTrack(race).issues.some((i) => i.code === 'medalOrder'));
});

test('the Emperor ghost of a multilap and a platform track re-simulates to its medal time', () => {
    for (const id of ['D05', 'P01']) {
        const track = levels.getTrack(id);
        const ghost = new GhostRun(buildWorld(track), levels.authorReplay(id), { kind: 'emperor' });
        assert.ok(ghost.finished, id);
        assert.equal(ghost.timeMs, track.medals.author, id);
    }
});
