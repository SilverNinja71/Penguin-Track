// Game shell (js/game): settings, controls -> Input, the fixed-step loop,
// records and first-time medal gold, replay codes, ghosts and the catalog.
// The DOM-free parts run in Node; screens are checked in the browser (docs/GAME.md).
import assert from 'node:assert/strict';
import { test } from './_harness.mjs';
import { sanitizeSettings, defaultSettings, keyLabel, DEFAULT_BINDINGS, ACTIONS } from '../../js/game/settings.js';
import { Controls } from '../../js/game/controls.js';
import { Loop } from '../../js/game/loop.js';
import { submitRun, awardMedalGold, getRecord, saveReplay, listReplays, deleteReplay } from '../../js/game/records.js';
import { encodeReplayCode, decodeReplayCode, encodeReplayCodeAsync, decodeReplayCodeAsync, decodeReplayText } from '../../js/game/replaycode.js';
import { encodeTrack } from '../../js/core/codec.js';
import { GhostRun } from '../../js/game/ghost.js';
import { makeCatalog } from '../../js/game/catalog.js';
import { getSample } from '../../js/core/samples.js';
import { buildWorld } from '../../js/core/track.js';
import { runAutopilot } from '../../js/core/autopilot.js';
import { simulateReplay } from '../../js/core/replay.js';
import { STEER_MAX } from '../../js/core/constants.js';

function memoryStorage() {
    const m = new Map();
    return {
        get: (k, d = null) => (m.has(k) ? JSON.parse(m.get(k)) : d),
        set: (k, v) => {
            m.set(k, JSON.stringify(v));
            return true;
        },
        update(k, d, fn) {
            const v = fn(this.get(k, d));
            this.set(k, v);
            return v;
        },
        remove: (k) => m.delete(k),
    };
}

/** A signed-in (or guest) shared site account, as ../shared/accounts.js leaves it in localStorage. */
function fakeSiteAccount(signedIn, gold = 300) {
    const ls = new Map();
    if (signedIn) ls.set('spear_mace_user_profile', JSON.stringify({ username: 'Pingu', gold }));
    globalThis.localStorage = {
        getItem: (k) => (ls.has(k) ? ls.get(k) : null),
        setItem: (k, v) => ls.set(k, String(v)),
        removeItem: (k) => ls.delete(k),
    };
    globalThis.window = globalThis.window || {};
    globalThis.window.GameAccounts = { current: () => (signedIn ? { username: 'Pingu', key: 'pingu' } : null) };
    return () => JSON.parse(ls.get('spear_mace_user_profile') || 'null');
}

function clearSiteAccount() {
    delete globalThis.localStorage;
    if (globalThis.window) delete globalThis.window.GameAccounts;
}

let autopilotS01 = null;
function s01Run() {
    if (!autopilotS01) {
        const world = buildWorld(getSample('S01'));
        autopilotS01 = { world, run: runAutopilot(world, { record: true }) };
    }
    return autopilotS01;
}

test('settings: defaults, validation and the Trackmania key defaults', () => {
    const d = defaultSettings();
    assert.deepEqual(sanitizeSettings(null).bindings, d.bindings);
    const s = sanitizeSettings({
        volume: { master: 3, sfx: 'loud', music: 0.25 }, quality: 'ultra', units: 'mph', camera: 'cockpit',
        padDeadzone: -1, bindings: { gas: ['KeyI', 42, '', 'KeyJ', 'KeyK'], brake: 'nope' }, showSplits: 0,
    });
    assert.equal(s.volume.master, 1);
    assert.equal(s.volume.sfx, d.volume.sfx);
    assert.equal(s.volume.music, 0.25);
    assert.equal(s.quality, d.quality);
    assert.equal(s.units, 'mph');
    assert.equal(s.camera, 'cockpit');
    assert.equal(s.padDeadzone, 0);
    assert.equal(s.showSplits, d.showSplits);
    assert.deepEqual(s.bindings.gas, ['KeyI', 'KeyJ']);
    assert.deepEqual(s.bindings.brake, DEFAULT_BINDINGS.brake);
    for (const a of ACTIONS) assert.ok(Array.isArray(s.bindings[a.id]), a.id);
    assert.deepEqual(DEFAULT_BINDINGS.gas, ['ArrowUp', 'KeyW']);
    assert.deepEqual(DEFAULT_BINDINGS.respawn.slice(0, 1), ['Enter']);
    assert.deepEqual(DEFAULT_BINDINGS.restart, ['Backspace', 'Delete']);
    assert.equal(keyLabel('KeyW'), 'W');
    assert.equal(keyLabel('ArrowUp'), '↑');
    assert.equal(keyLabel('Digit1'), '1');
});

test('controls: keyboard to Input, edges fire once, typing is ignored', () => {
    const c = new Controls(defaultSettings());
    const key = (type, code, extra = {}) => {
        const e = { code, target: extra.target || null, repeat: !!extra.repeat, metaKey: false, ctrlKey: false, altKey: false, prevented: false, preventDefault() { this.prevented = true; } };
        (type === 'down' ? c._onKeyDown : c._onKeyUp).call(c, e);
        return e;
    };
    c.setActive(true);
    const e = key('down', 'ArrowUp');
    assert.ok(e.prevented, 'game keys do not scroll the page while racing');
    key('down', 'KeyA');
    let inp = c.input();
    assert.deepEqual([inp.steer, inp.gas, inp.brake, inp.respawn], [-STEER_MAX, true, false, false]);
    key('down', 'KeyD');
    assert.equal(c.input().steer, 0, 'left + right cancel');
    key('up', 'KeyA');
    assert.equal(c.input().steer, STEER_MAX);
    key('down', 'Enter');
    key('down', 'Enter', { repeat: true });
    assert.equal(c.input().respawn, true);
    assert.equal(c.input().respawn, false, 'one respawn per press');
    key('down', 'Backspace');
    assert.equal(c.pressed('restart'), true);
    assert.equal(c.pressed('restart'), false);
    // Remapped gas, and keys typed into a text field never drive.
    const s = defaultSettings();
    s.bindings.gas = ['KeyI'];
    c.setSettings(s);
    key('up', 'ArrowUp');
    assert.equal(c.input().gas, false);
    key('down', 'KeyI', { target: { tagName: 'INPUT', type: 'text' } });
    assert.equal(c.input().gas, false);
    key('down', 'KeyI');
    assert.equal(c.input().gas, true);
    c.setActive(false);
    const m = key('down', 'ArrowDown');
    assert.equal(m.prevented, false, 'menus keep their arrow keys');
});

test('controls: gamepad stick with dead zone and sensitivity, triggers, edges', () => {
    const s = defaultSettings();
    s.padDeadzone = 0.2;
    const c = new Controls(s);
    let pad = { connected: true, id: 'test', axes: [0.1, 0], buttons: Array.from({ length: 17 }, () => ({ value: 0, pressed: false })) };
    const nav = globalThis.navigator;
    const desc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', { value: { getGamepads: () => [pad] }, configurable: true, writable: true });
    try {
        c.poll(0);
        assert.equal(c.input().steer, 0, 'inside the dead zone');
        pad.axes[0] = -1;
        c.poll(10);
        assert.equal(c.input().steer, -STEER_MAX);
        pad.axes[0] = 0.6;
        c.poll(20);
        const half = c.input().steer;
        assert.ok(half > 0 && half < STEER_MAX, `partial steer ${half}`);
        s.padSensitivity = 2;
        c.setSettings(s);
        c.poll(30);
        assert.ok(c.input().steer > half, 'more sensitive');
        pad.buttons[7] = { value: 0.9, pressed: true };   // RT
        pad.buttons[1] = { value: 1, pressed: true };     // B: respawn
        c.poll(40);
        const inp = c.input();
        assert.equal(inp.gas, true);
        assert.equal(inp.respawn, true);
        c.poll(50);
        assert.equal(c.input().respawn, false, 'held B is one respawn');
        assert.equal(c.lastDevice, 'gamepad');
    } finally {
        if (desc) Object.defineProperty(globalThis, 'navigator', desc);
        else globalThis.navigator = nav;
    }
});

test('loop: 100 Hz accumulator, frame cap, alpha and stop from a tick', () => {
    let pending = null;
    const raf = globalThis.requestAnimationFrame, caf = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = (cb) => {
        pending = cb;
        return 1;
    };
    globalThis.cancelAnimationFrame = () => { pending = null; };
    try {
        const loop = new Loop();
        let ticks = 0, alpha = -1;
        loop.start(() => ticks++, (a) => { alpha = a; });
        const t0 = loop.last;
        pending(t0 + 105);
        assert.equal(ticks, 10);
        assert.ok(alpha > 0.45 && alpha < 0.55, `alpha ${alpha}`);
        pending(t0 + 105 + 2000);   // a long stall: at most 25 ticks, never a spiral
        assert.equal(ticks, 35);
        loop.timeScale = 0.25;
        pending(t0 + 105 + 2000 + 220);   // slow motion: 55 ms of game time
        assert.equal(ticks, 40);
        loop.onTick = () => {
            ticks++;
            loop.stop();
        };
        loop.timeScale = 1;
        pending(t0 + 105 + 2000 + 220 + 100);
        assert.equal(ticks, 41, 'stop() inside a tick ends that frame');
        assert.equal(loop.running, false);
    } finally {
        globalThis.requestAnimationFrame = raf;
        globalThis.cancelAnimationFrame = caf;
    }
});

test('records: personal bests, medals and stale layouts', () => {
    const storage = memoryStorage();
    const cat = makeCatalog({ storage });
    const track = cat.getTrack('A01');
    const hash = buildWorld(track).hash;
    const m = track.medals;
    const replay = { inputs: '1:B*2', trackHash: hash };
    let r = submitRun(storage, cat, track, hash, { timeMs: m.silver, respawns: 0, replay, splits: [1000] });
    assert.equal(r.improved, true);
    assert.equal(r.medal, 'silver');
    assert.equal(r.firstMedal, true);
    r = submitRun(storage, cat, track, hash, { timeMs: m.silver + 500, respawns: 0, replay, splits: [] });
    assert.equal(r.improved, false);
    assert.equal(r.firstMedal, false);
    assert.equal(getRecord(storage, 'A01', hash).bestMs, m.silver);
    r = submitRun(storage, cat, track, hash, { timeMs: m.author, respawns: 2, replay, splits: [900] });
    assert.equal(r.improved, true);
    assert.equal(r.medal, 'emperor');
    assert.equal(r.previous.bestMs, m.silver);
    const stale = getRecord(storage, 'A01', 'another-layout');
    assert.equal(stale.stale, true);
    assert.equal(stale.bestMs, null);
    assert.equal(stale.medal, 'emperor', 'medals stay earned');
});

test('records: first-time medal gold goes to the signed-in site account once', () => {
    const storage = memoryStorage();
    const cat = makeCatalog({ storage });
    const track = cat.getTrack('A01');
    const hash = buildWorld(track).hash;
    const m = track.medals;
    try {
        fakeSiteAccount(false);
        submitRun(storage, cat, track, hash, { timeMs: m.gold, respawns: 0, replay: null, splits: [] });
        assert.equal(awardMedalGold(storage, cat, 'A01', 'gold'), null, 'guests earn no gold');
        const profile = fakeSiteAccount(true, 300);
        const paid = awardMedalGold(storage, cat, 'A01', 'gold');
        assert.deepEqual(paid, { amount: 30 + 15 + 5, total: 350 });
        assert.equal(awardMedalGold(storage, cat, 'A01', 'gold'), null, 'a medal pays once');
        assert.equal(awardMedalGold(storage, cat, 'A01', 'silver'), null);
        assert.deepEqual(awardMedalGold(storage, cat, 'A01', 'emperor'), { amount: 60, total: 410 });
        assert.equal(profile().gold, 410);
        // Custom tracks never pay (anyone can make an easy one).
        const custom = { ...track, id: 'my-track' };
        submitRun(storage, cat, custom, hash, { timeMs: m.author, respawns: 0, replay: null, splits: [] });
        assert.equal(awardMedalGold(storage, cat, 'my-track', 'emperor'), null);
    } finally {
        clearSiteAccount();
    }
});

test('records: saved replay list', () => {
    const storage = memoryStorage();
    const a = saveReplay(storage, { name: 'one', trackId: 'A01', replay: { inputs: '1:' } });
    saveReplay(storage, { name: 'two', trackId: 'A02', replay: { inputs: '1:' } });
    assert.deepEqual(listReplays(storage).map((r) => r.name), ['two', 'one']);
    deleteReplay(storage, a.id);
    assert.deepEqual(listReplays(storage).map((r) => r.name), ['two']);
});

test('replay codes: round trip, custom tracks travel inside, junk is refused', () => {
    const { world, run } = s01Run();
    const code = encodeReplayCode(run.replay, null, { name: 'fast lap' });
    assert.ok(code.startsWith('PTR1.'));
    const back = decodeReplayCode(code);
    assert.deepEqual(back.replay, run.replay);
    assert.equal(back.track, null);
    assert.equal(back.name, 'fast lap');
    const withTrack = decodeReplayCode(encodeReplayCode(run.replay, world.track));
    assert.equal(buildWorld(withTrack.track).hash, world.hash);
    assert.throws(() => decodeReplayCode('PT1.abc'), /replay code/);
    assert.throws(() => decodeReplayCode('PTR1.!!!'), /damaged/);
});

test('replay codes: compressed PTR2 codes are shorter and decode the same', async () => {
    const { world, run } = s01Run();
    const plain = encodeReplayCode(run.replay, world.track);
    const z = await encodeReplayCodeAsync(run.replay, world.track);
    assert.ok(z.startsWith('PTR2.'));
    assert.ok(z.length < plain.length * 0.7, `${z.length} vs ${plain.length}`);
    const back = await decodeReplayCodeAsync(z);
    assert.deepEqual(back.replay, run.replay);
    assert.equal(buildWorld(back.track).hash, world.hash);
    assert.deepEqual((await decodeReplayCodeAsync(plain)).replay, run.replay, 'PTR1 still opens');
    await assert.rejects(() => decodeReplayCodeAsync('PTR2.AAAA'), /damaged/);
});

test('replay import box: codes, bare replay JSON and AI model files', async () => {
    const { world, run } = s01Run();
    assert.deepEqual((await decodeReplayText(await encodeReplayCodeAsync(run.replay))).replay, run.replay);
    const bare = await decodeReplayText(JSON.stringify(run.replay));
    assert.deepEqual(bare.replay, run.replay);
    assert.equal(bare.track, null);
    // An AI model file carries its track as a PT1 code next to the replay.
    const model = await decodeReplayText(JSON.stringify({ name: 'demo', trackName: 'Frosty Oval', trackCode: encodeTrack(world.track), replay: run.replay }));
    assert.equal(model.name, 'demo');
    assert.equal(buildWorld(model.track).hash, world.hash);
    await assert.rejects(() => decodeReplayText('{"nope": 1}'), /no run/);
    await assert.rejects(() => decodeReplayText('{broken'), /JSON/);
});

test('ghosts: a re-simulated replay is exactly the recorded run', () => {
    const { world, run } = s01Run();
    assert.ok(run.finished);
    const ghost = new GhostRun(world, run.replay);
    assert.equal(ghost.timeMs, run.timeMs);
    assert.deepEqual(ghost.checkpointTimes, run.checkpointTimes);
    const ref = simulateReplay(world, run.replay, { sampleEvery: 1 });
    for (const t of [0, 1, 250, 1000, ref.ticks]) {
        const v = ghost.viewAt(t);
        assert.deepEqual(v.pos, ref.samples.find((s) => s.tick === t).pos, `tick ${t}`);
    }
    // Between ticks it interpolates; past the line it keeps coasting.
    const mid = ghost.viewAt(100.5).pos, a = ref.samples[100].pos, b = ref.samples[101].pos;
    for (let k = 0; k < 3; k++) assert.ok(Math.abs(mid[k] - (a[k] + b[k]) / 2) < 1e-6);
    assert.ok(ghost.lastTick > ref.ticks);
    assert.equal(ghost.view.wheels.length, 4);
});

test('catalog: official tracks, next track, custom tracks and medal helpers', () => {
    const storage = memoryStorage();
    const cat = makeCatalog({ storage });
    assert.equal(cat.getTrack('A01').id, 'A01');
    assert.equal(cat.campaigns().reduce((n, c) => n + c.tiers.reduce((k, t) => k + t.tracks.length, 0), 0), 35);
    assert.equal(cat.nextTrackId('A01'), 'A02');
    assert.equal(cat.isCampaign('A01'), true);
    storage.set('tracks', { mine: { ...getSample('S01'), id: 'whatever', name: 'Mine' } });
    const mine = cat.getTrack('mine');
    assert.equal(mine.id, 'mine', 'the storage key is the id');
    assert.equal(mine.name, 'Mine');
    assert.equal(cat.isCampaign('mine'), false);
    assert.equal(cat.customTracks().length, 1);
    assert.equal(cat.medalTargets(cat.getTrack('A01')).length, 4);
    assert.equal(cat.medalReward('emperor'), 60);
    // Dev samples open by id but are not campaign tracks, and their ids stay reserved.
    assert.equal(cat.getTrack('S03').id, 'S03');
    assert.equal(cat.isCampaign('S03'), false);
    assert.equal(cat.isReserved('S03'), true);
    assert.equal(cat.isReserved('mine'), false);
    assert.ok(!cat.campaignIds().includes('S01'));
    // Platform medals are respawn caps: the catalog hands out the levels rules.
    const p01 = cat.getTrack('P01');
    assert.equal(cat.medalFor(p01, { timeMs: 999999, respawns: 2 }), 'silver');
});
