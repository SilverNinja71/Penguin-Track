// Official tracks (js/levels): campaign shape, validation, bakes, author ghosts
// (one track per tier, the rest via tools/verify-levels.mjs) and medal rules.
import assert from 'node:assert/strict';
import { test, info } from './_harness.mjs';
import * as levels from '../../js/levels/index.js';
import { MEDALS, medalFor, medalTargets, formatMedalTarget, isBetterRun, nextMedalTarget, bestMedal } from '../../js/levels/medals.js';
import { BAKED } from '../../js/levels/baked.js';
import { medalsFromAuthor } from '../bake-levels.mjs';
import { validateTrack, buildWorld } from '../../js/core/track.js';
import { BLOCKS, footprintSize } from '../../js/core/blocks.js';
import { trackHash } from '../../js/core/codec.js';
import { verifyReplay } from '../../js/core/replay.js';

const STALE = 'stale bake: run node tools/bake-levels.mjs';

test('campaign shape: 5 tiers of 5 race tracks, 5 platform, 5 training', () => {
    const [race, platform, training] = levels.CAMPAIGNS;
    assert.deepEqual(levels.CAMPAIGNS.map((c) => c.id), ['race', 'platform', 'training']);
    assert.deepEqual(race.tiers.map((t) => t.name), ['Fresh Powder', 'Pine Forest', 'Glacier', 'Avalanche', 'Polar Night']);
    for (const [i, t] of race.tiers.entries()) {
        assert.deepEqual(t.tracks.map((x) => x.id), [1, 2, 3, 4, 5].map((n) => `${'ABCDE'[i]}0${n}`));
        assert.ok(t.color.startsWith('var(--tier-'));
    }
    assert.deepEqual(platform.tiers[0].tracks.map((x) => x.id), ['P01', 'P02', 'P03', 'P04', 'P05']);
    assert.deepEqual(training.tiers[0].tracks.map((x) => x.id), ['T01', 'T02', 'T03', 'T04', 'T05']);
    assert.deepEqual(training.tiers[0].tracks.map((x) => x.name), ['Oval', 'Figure Eight', 'Slalom', 'Ice Rink', 'Jump Lab']);
    for (const t of platform.tiers[0].tracks) assert.equal(t.mode, 'platform');
    const ids = levels.trackIds();
    assert.equal(ids.length, 35);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(new Set(ids.map((id) => levels.trackInfo(id).name.toLowerCase())).size, ids.length, 'names are unique');
    const multilap = ids.filter((id) => levels.trackInfo(id).laps > 1);
    assert.ok(multilap.some((id) => id[0] === 'D') && multilap.some((id) => id[0] === 'E'), 'a multilap in D and E');
});

test('navigation helpers', () => {
    assert.equal(levels.nextTrackId('A01'), 'A02');
    assert.equal(levels.nextTrackId('A05'), 'B01');
    assert.equal(levels.nextTrackId('E05'), null);
    assert.equal(levels.nextTrackId('P05'), null);
    assert.equal(levels.nextTrackId('nope'), null);
    assert.equal(levels.tierOf('C03').tier.name, 'Glacier');
    assert.equal(levels.getTrack('nope'), null);
    const a = levels.getTrack('B02');
    a.blocks.length = 0;
    assert.ok(levels.getTrack('B02').blocks.length > 0, 'getTrack returns a fresh copy');
    assert.equal(levels.allTracks().length, 35);
});

test('every track validates, builds a route and matches its bake', () => {
    let blocks = 0, decor = 0;
    for (const id of levels.trackIds()) {
        const t = levels.getTrack(id);
        const v = validateTrack(t);
        assert.deepEqual(v.errors, [], `${id} validates`);
        const unexpected = v.issues.filter((i) => i.level === 'warning' && i.code !== 'openEnd');
        assert.deepEqual(unexpected.map((i) => i.message), [], `${id} warnings`);
        assert.ok(BAKED[id], `${id} is baked (${STALE})`);
        assert.equal(BAKED[id].hash, trackHash(t), `${id}: ${STALE}`);
        assert.deepEqual(t.medals, medalsFromAuthor(BAKED[id].author, t.mode), `${id} medals follow the rule`);
        assert.ok(['day', 'sunset', 'night', 'aurora'].includes(t.mood));
        blocks += t.blocks.length;
        decor += t.decor.length;
    }
    // Building is the slow part: one track per tier.
    for (const id of ['A03', 'B04', 'C02', 'D02', 'E05', 'P02', 'T02']) {
        const w = buildWorld(levels.getTrack(id));
        assert.ok(w.route, `${id} has a route (${w.routeError})`);
    }
    info(`${blocks} blocks, ${decor} decor over 35 tracks`);
});

test('decor stays off the road and uses known models', () => {
    const kinds = new Set(levels.DECOR_KINDS);
    for (const id of levels.trackIds()) {
        const t = levels.getTrack(id);
        const road = new Set();
        for (const b of t.blocks) {
            const [W, , D] = footprintSize(BLOCKS[b.b], b.r);
            for (let x = b.x; x < b.x + W; x++) for (let z = b.z; z < b.z + D; z++) road.add(`${x},${z}`);
        }
        for (const d of t.decor) {
            assert.ok(kinds.has(d.d), `${id}: decor kind ${d.d}`);
            assert.ok(!road.has(`${d.x},${d.z}`), `${id}: ${d.d} at ${d.x},${d.z} stands on the road`);
        }
    }
    assert.deepEqual(levels.getTrack('A01').decor, levels.getTrack('A01').decor, 'scenery is deterministic');
});

test('author ghosts re-simulate to the baked author time (one per tier)', () => {
    for (const id of ['A01', 'B03', 'C04', 'D05', 'E03', 'P03', 'T05']) {
        const t = levels.getTrack(id);
        const replay = levels.authorReplay(id);
        assert.ok(replay, `${id} has an author replay (${STALE})`);
        const res = verifyReplay(buildWorld(t), replay);
        assert.ok(res.ok, `${id}: ${res.reason} (${STALE})`);
        assert.equal(res.timeMs, t.medals.author, `${id} author time (${STALE})`);
        if (t.mode === 'platform') assert.equal(res.respawns, 0);
    }
});

test('race medals', () => {
    const t = { mode: 'race', medals: medalsFromAuthor(41230) };
    assert.deepEqual(t.medals, { author: 41230, gold: 43800, silver: 50000, bronze: 62000 });
    assert.deepEqual(MEDALS, ['emperor', 'gold', 'silver', 'bronze']);
    assert.equal(medalFor(t, { timeMs: 41230 }), 'emperor');
    assert.equal(medalFor(t, { timeMs: 41240, respawns: 3 }), 'gold');
    assert.equal(medalFor(t, { timeMs: 50000 }), 'silver');
    assert.equal(medalFor(t, { timeMs: 62000 }), 'bronze');
    assert.equal(medalFor(t, { timeMs: 62010 }), null);
    assert.equal(medalFor(t, { timeMs: null }), null);
    const targets = medalTargets(t);
    assert.deepEqual(targets.map((m) => [m.medal, m.value, m.kind]), [['emperor', 41230, 'time'], ['gold', 43800, 'time'], ['silver', 50000, 'time'], ['bronze', 62000, 'time']]);
    assert.equal(formatMedalTarget(targets[0]), '0:41.23');
    assert.equal(formatMedalTarget(t, 'gold'), '0:43.80');
    assert.equal(nextMedalTarget(t, null).medal, 'bronze');
    assert.equal(nextMedalTarget(t, 'silver').medal, 'gold');
    assert.equal(nextMedalTarget(t, 'emperor'), null);
    assert.equal(bestMedal('silver', 'gold'), 'gold');
    assert.equal(bestMedal(null, 'bronze'), 'bronze');
    assert.ok(isBetterRun(t, { timeMs: 40000, respawns: 9 }, { timeMs: 40010, respawns: 0 }));
});

test('platform medals: respawn caps, Emperor needs a clean run under the author time', () => {
    const t = { mode: 'platform', medals: medalsFromAuthor(30000, 'platform') };
    assert.deepEqual(t.medals, { author: 30000, gold: 0, silver: 3, bronze: 10 });
    assert.equal(medalFor(t, { timeMs: 29990, respawns: 0 }), 'emperor');
    assert.equal(medalFor(t, { timeMs: 30010, respawns: 0 }), 'gold');
    assert.equal(medalFor(t, { timeMs: 20000, respawns: 1 }), 'silver');
    assert.equal(medalFor(t, { timeMs: 99000, respawns: 3 }), 'silver');
    assert.equal(medalFor(t, { timeMs: 99000, respawns: 10 }), 'bronze');
    assert.equal(medalFor(t, { timeMs: 99000, respawns: 11 }), null);
    assert.deepEqual(medalTargets(t).map((m) => m.text), ['no respawns · 0:30.00', 'no respawns', '≤ 3 respawns', '≤ 10 respawns']);
    assert.ok(isBetterRun(t, { timeMs: 50000, respawns: 0 }, { timeMs: 20000, respawns: 1 }));
    assert.ok(isBetterRun(t, { timeMs: 20000, respawns: 1 }, { timeMs: 20010, respawns: 1 }));
    // The track-format object form works too (custom platform tracks).
    const o = { mode: 'platform', medals: { author: { respawns: 0, ms: 25000 }, gold: { respawns: 1 }, silver: null, bronze: { respawns: 5, ms: 90000 } } };
    assert.equal(medalFor(o, { timeMs: 24000, respawns: 0 }), 'emperor');
    assert.equal(medalFor(o, { timeMs: 99000, respawns: 1 }), 'gold');
    assert.equal(medalFor(o, { timeMs: 99000, respawns: 2 }), null);
    assert.equal(medalFor(o, { timeMs: 80000, respawns: 4 }), 'bronze');
    assert.equal(medalTargets(o).length, 3);
});
