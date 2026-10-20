// Multiplayer (js/mp): points and ranking, the hot-seat match, split-screen
// input, the shared race runner, the online protocol validators, and whole
// rooms (host + clients) over the in-memory loopback transport, including
// finishes verified by re-simulating their replays.
import assert from 'node:assert/strict';
import { test } from './_harness.mjs';
import { POINTS, rankRuns, compareRuns, isBetter } from '../../js/mp/scoring.js';
import * as HS from '../../js/mp/hotseat.js';
import { SplitInput, readPad, assignPads, KEYMAPS } from '../../js/mp/splitinput.js';
import { Racer, Countdown, COUNT_TICKS } from '../../js/mp/racer.js';
import {
    parseRoomCode, makeRoomCode, cleanName, cleanText, uniqueName, decode, encode, validateClientMsg,
    validateHostMsg, packPose, LIMITS, CODE_LENGTH, PROTOCOL_VERSION, cleanReplay, validateTrackRef,
} from '../../js/mp/protocol.js';
import { RoomHost, RoomClient, loopbackPair, PoseBuffer, slimReplay, FINISH_GRACE_MS } from '../../js/mp/room.js';
import { getSample } from '../../js/core/samples.js';
import { buildWorld } from '../../js/core/track.js';
import { runAutopilot, Autopilot } from '../../js/core/autopilot.js';
import { verifyReplay } from '../../js/core/replay.js';
import { STEER_MAX } from '../../js/core/constants.js';

const flush = () => new Promise((r) => setTimeout(r, 0));

let s01 = null;
function S01() {
    if (!s01) {
        const world = buildWorld(getSample('S01'));
        const run = runAutopilot(world, { record: true });
        s01 = { world, run };
    }
    return s01;
}

// ------------------------------------------------------------------ scoring

test('points table and ties share the better place', () => {
    assert.deepEqual(POINTS, [10, 8, 6, 5, 4, 3, 2, 1]);
    const r = rankRuns([
        { n: 'a', run: { timeMs: 30000 } },
        { n: 'b', run: null },
        { n: 'c', run: { timeMs: 29000 } },
        { n: 'd', run: { timeMs: 30000 } },
        { n: 'e', run: { timeMs: 31000 } },
    ]);
    assert.deepEqual(r.map((x) => x.n), ['c', 'a', 'd', 'e', 'b']);
    assert.deepEqual(r.map((x) => x.place), [0, 1, 1, 3, -1]);
    assert.deepEqual(r.map((x) => x.points), [10, 8, 8, 5, 0]);
    const nine = rankRuns(Array.from({ length: 9 }, (_, i) => ({ run: { timeMs: 1000 + i * 10 } })));
    assert.equal(nine[8].points, 0);
    assert.equal(nine[7].points, 1);
});

test('platform runs rank by respawns, then time', () => {
    assert.ok(compareRuns({ timeMs: 50000, respawns: 0 }, { timeMs: 20000, respawns: 1 }, true) < 0);
    assert.ok(compareRuns({ timeMs: 50000, respawns: 0 }, { timeMs: 20000, respawns: 1 }, false) > 0);
    assert.ok(isBetter({ timeMs: 1 }, null));
    assert.ok(!isBetter(null, { timeMs: 1 }));
    assert.ok(!isBetter({ timeMs: 5 }, { timeMs: 5 }));
});

// ------------------------------------------------------------------ hot-seat

const tracks2 = [{ id: 'A01', name: 'One' }, { id: 'A02', name: 'Two' }];

test('hot-seat: attempts limit, turn order rotates per track, scoring and podium', () => {
    const m = HS.createMatch({ players: ['Pingu', 'Pinga', 'Robby'], tracks: tracks2, limit: { type: 'attempts', count: 2 } });
    assert.equal(HS.turnPlayer(m), 0);
    assert.ok(HS.startAttempt(m));
    HS.submitFinish(m, { timeMs: 40000, respawns: 0 });
    assert.ok(HS.startAttempt(m));
    const r = HS.submitFinish(m, { timeMs: 41000 });
    assert.equal(r.improved, false);
    assert.equal(HS.attemptsLeft(m), 0);
    assert.equal(HS.startAttempt(m), false, 'third attempt refused');
    assert.ok(HS.turnSpent(m));
    assert.equal(HS.endTurn(m), 'turn');
    assert.equal(HS.turnPlayer(m), 1);
    HS.startAttempt(m);
    HS.submitFinish(m, { timeMs: 39000 });
    assert.equal(HS.leaderRun(m, 2).name, 'Pinga');
    HS.endTurn(m);
    HS.startAttempt(m);   // Robby never finishes
    assert.equal(HS.endTurn(m), 'trackResults');
    assert.deepEqual(m.awarded[0], [8, 10, 0]);
    assert.equal(HS.nextTrack(m), 'turn');
    assert.deepEqual(HS.turnOrder(m), [1, 2, 0], 'second track starts with the second player');
    assert.equal(HS.turnPlayer(m), 1);
    for (const t of [42000, 41000, 40000]) {
        HS.startAttempt(m);
        HS.submitFinish(m, { timeMs: t });
        HS.endTurn(m);
    }
    assert.equal(m.phase, 'done');
    const st = HS.standings(m);
    // Pingu 8 + 10, Pinga 10 + 6, Robby 0 + 8.
    assert.deepEqual(st.map((x) => [x.name, x.points, x.place]), [['Pingu', 18, 0], ['Pinga', 16, 1], ['Robby', 8, 2]]);
    assert.deepEqual(JSON.parse(JSON.stringify(m)), m, 'match state is JSON-safe');
});

test('hot-seat: time budget counts driving time', () => {
    const m = HS.createMatch({ players: ['A', 'B'], tracks: tracks2.slice(0, 1), limit: { type: 'time', ms: 60000 } });
    assert.equal(HS.timeLeft(m), 60000);
    assert.ok(HS.startAttempt(m));
    HS.addDriven(m, 45000);
    assert.ok(HS.canStartAttempt(m));
    HS.addDriven(m, 20000);
    assert.equal(HS.timeLeft(m), 0);
    assert.equal(HS.startAttempt(m), false);
    assert.throws(() => HS.createMatch({ players: ['solo'], tracks: tracks2 }));
    assert.throws(() => HS.createMatch({ players: ['a', 'b'], tracks: [] }));
    assert.equal(HS.normalizeLimit({ type: 'attempts', count: 99 }).count, 20);
    assert.equal(HS.normalizeLimit({ type: 'time', ms: 1 }).ms, 30000);
});

test('hot-seat: tied points split by wins, then share a place', () => {
    const m = HS.createMatch({ players: ['A', 'B'], tracks: tracks2, limit: { type: 'attempts', count: 1 } });
    for (const t of [30000, 31000]) { HS.startAttempt(m); HS.submitFinish(m, { timeMs: t }); HS.endTurn(m); }
    HS.nextTrack(m);
    // B drives first on track 2.
    for (const t of [30000, 31000]) { HS.startAttempt(m); HS.submitFinish(m, { timeMs: t }); HS.endTurn(m); }
    const st = HS.standings(m);
    assert.deepEqual(st.map((x) => [x.name, x.points, x.wins, x.place]), [['A', 18, 1, 0], ['B', 18, 1, 0]]);
});

// ------------------------------------------------------------------ split-screen input

test('split input: WASD+R and arrows+Enter drive separate players', () => {
    const si = new SplitInput();
    assert.ok(si.keydown('KeyW'));
    assert.ok(si.keydown('KeyA'));
    assert.ok(si.keydown('ArrowRight'));
    assert.ok(si.keydown('Enter'));
    assert.equal(si.keydown('KeyQ'), false);
    const a = si.input(0), b = si.input(1);
    assert.deepEqual(a, { steer: -STEER_MAX, gas: true, brake: false, respawn: false });
    assert.deepEqual(b, { steer: STEER_MAX, gas: false, brake: false, respawn: true });
    assert.equal(si.input(1).respawn, false, 'respawn is an edge');
    si.keydown('Enter', true);
    assert.equal(si.input(1).respawn, false, 'key repeat is ignored');
    si.keyup('KeyW');
    assert.equal(si.input(0).gas, false);
    si.keydown('Backspace');
    assert.ok(si.pressed('restart'));
    assert.ok(!si.pressed('restart'));
    assert.deepEqual(Object.keys(KEYMAPS[0]).sort(), ['brake', 'gas', 'left', 'respawn', 'right']);
});

test('split input: gamepads go to P1 then P2, analog steering with a dead zone', () => {
    const pad = (ax, pressed = []) => ({ connected: true, axes: [ax, 0], buttons: Array.from({ length: 16 }, (_, i) => ({ pressed: pressed.includes(i), value: pressed.includes(i) ? 1 : 0 })) });
    assert.deepEqual(assignPads([null, pad(0), { connected: false }, pad(0), pad(0)]).map(Boolean), [true, true]);
    assert.equal(readPad(pad(0.05)).steer, 0);
    assert.equal(readPad(pad(1)).steer, STEER_MAX);
    assert.ok(readPad(pad(-0.5)).steer < 0 && readPad(pad(-0.5)).steer > -STEER_MAX);
    const si = new SplitInput();
    si.pollPads([pad(0, [7]), pad(-1, [1])]);
    assert.equal(si.input(0).gas, true);
    const p2 = si.input(1);
    assert.equal(p2.steer, -STEER_MAX);
    assert.equal(p2.respawn, true);
    si.pollPads([pad(0, [7]), pad(-1, [1])]);
    assert.equal(si.input(1).respawn, false, 'held B is one respawn');
});

// ------------------------------------------------------------------ race runner

test('racer: countdown, autopilot run to the finish, replay verifies', () => {
    const { world } = S01();
    const cd = new Countdown();
    const seen = [];
    for (let i = 0; i < COUNT_TICKS + 5; i++) {
        const v = cd.tick();
        if (v != null) seen.push(v);
    }
    assert.deepEqual(seen, [3, 2, 1, 'GO']);
    const racer = new Racer(world, { name: 'P1' });
    assert.equal(racer.step({ gas: true, steer: 0, brake: false }).length, 0, 'frozen before GO');
    assert.equal(racer.sim.tick, 0);
    racer.go();
    const pilot = new Autopilot(world);
    let n = 0;
    while (racer.state === 'racing' && n++ < 60000) racer.step(pilot.act(racer.sim));
    assert.equal(racer.state, 'finished');
    const v = verifyReplay(world, racer.result.replay);
    assert.ok(v.ok, v.reason);
    assert.equal(v.timeMs, racer.result.timeMs);
    const run0 = racer.run;
    racer.reset();
    assert.equal(racer.run, run0 + 1);
    assert.equal(racer.state, 'ready');
});

// ------------------------------------------------------------------ protocol

test('protocol: room codes, names and text are cleaned', () => {
    const code = makeRoomCode(() => 0.5);
    assert.equal(code.length, CODE_LENGTH);
    assert.equal(parseRoomCode(` ${code.toLowerCase().slice(0, 2)}-${code.slice(2)} `), code);
    assert.equal(parseRoomCode('penguintrack-' + code), code);
    assert.equal(parseRoomCode('ABC'), null);
    assert.equal(parseRoomCode('ABCD0'), null, '0 is not in the alphabet');
    assert.equal(parseRoomCode(42), null);
    assert.equal(cleanName('  Pin‮gu\u0000  the   great penguin of ice '), 'Pingu the great');
    assert.equal(cleanName(''), 'Penguin');
    assert.equal(cleanName({}), 'Penguin');
    assert.equal(cleanText('a'.repeat(5000), 200).length, 200);
    assert.equal(uniqueName('Pingu', ['pingu', 'Pingu 2']), 'Pingu 3');
});

test('protocol: decode refuses oversize and non-object frames', () => {
    assert.equal(decode('x'.repeat(LIMITS.frame + 1)), null);
    assert.equal(decode('not json'), null);
    assert.equal(decode('[1,2]'), null);
    assert.equal(decode('{"t":5}'), null);
    assert.deepEqual(decode(encode({ t: 'idle' })), { t: 'idle' });
    assert.deepEqual(decode({ t: 'idle' }), { t: 'idle' }, 'already-parsed objects are measured too');
});

test('protocol: client messages are rebuilt field by field', () => {
    assert.equal(validateClientMsg({ t: 'hello', v: 1, name: 'A', extra: 'x' }).extra, undefined);
    assert.equal(validateClientMsg({ t: 'hello', v: '1', name: 'A' }), null);
    assert.equal(validateClientMsg({ t: 'chat', text: '   ' }), null);
    assert.equal(validateClientMsg({ t: 'nope' }), null);
    const p = packPose(3, 120, [100.123456, 8.5, -3], [0, 0.7071, 0, 0.7071], 123.6);
    const v = validateClientMsg(p);
    assert.deepEqual(v.p, [100.12, 8.5, -3]);
    assert.equal(v.s, 124);
    for (const bad of [
        { ...p, p: [NaN, 0, 0] }, { ...p, p: [0, 0] }, { ...p, p: [1e9, 0, 0] }, { ...p, q: [0, 0, 0, 0] },
        { ...p, q: [5, 0, 0, 0] }, { ...p, k: -1 }, { ...p, r: 1.5 }, { ...p, p: '0,0,0' }, { ...p, s: Infinity },
    ]) assert.equal(validateClientMsg(bad), null, JSON.stringify(bad));
    const rp = { trackHash: 'abcdef0123456789', inputs: '1:B*8c.BR*1e', ticks: 344, timeMs: 3440, respawnTicks: [], laps: 1 };
    assert.ok(validateClientMsg({ t: 'fin', round: 1, replay: rp }));
    assert.equal(validateClientMsg({ t: 'fin', round: 1, replay: { ...rp, inputs: '1:<script>' } }), null);
    assert.equal(validateClientMsg({ t: 'fin', round: 1, replay: { ...rp, inputs: '1:' + 'B'.repeat(LIMITS.inputs) } }), null);
    assert.equal(validateClientMsg({ t: 'fin', round: 1, replay: { ...rp, respawnTicks: new Array(5000).fill(1) } }), null);
    assert.equal(validateClientMsg({ t: 'fin', round: 0, replay: rp }), null);
    assert.equal(cleanReplay({ ...rp, trackHash: 'XYZ' }), null);
    assert.equal(validateClientMsg({ t: 'want', id: '../etc' }), null);
});

test('protocol: host messages are checked too (a hostile host cannot inject)', () => {
    assert.equal(validateHostMsg({ t: 'players', list: new Array(9).fill({ id: 'p1', name: 'x' }) }), null);
    assert.equal(validateHostMsg({ t: 'players', list: [{ id: 'p 1', name: 'x' }] }), null);
    const pl = validateHostMsg({ t: 'players', list: [{ id: 'p1', name: '<b>x</b>', best: 41230, verified: 1, pts: 10, host: true }] });
    assert.equal(pl.list[0].name, '<b>x</b>', 'names are text; the UI never uses innerHTML for them');
    assert.equal(pl.list[0].verified, true);
    assert.equal(validateHostMsg({ t: 'players', list: [{ id: 'p1', best: -5 }] }), null);
    assert.equal(validateHostMsg({ t: 'round', n: 1, state: 'racing', track: { id: 'A01' }, durationMs: 1, leftMs: 0 }), null);
    assert.ok(validateHostMsg({ t: 'round', n: 1, state: 'racing', track: { id: 'A01' }, durationMs: 180000, leftMs: 1000 }));
    assert.equal(validateHostMsg({ t: 'round', n: 1, state: 'racing', track: { code: 'PT1.abc' }, durationMs: 180000, leftMs: 1000 }), null, 'codes need a hash');
    assert.ok(validateTrackRef({ code: 'PT1.abc_-', hash: 'abcdef0123456789', name: 'x' }));
    assert.equal(validateTrackRef({ code: 'javascript:alert(1)', hash: 'abcdef0123456789' }), null);
    assert.equal(validateHostMsg({ t: 'chat', text: 'hi' }), null, 'a player line needs an id');
    assert.equal(validateHostMsg({ t: 'chat', sys: true, text: 'hi' }).sys, true);
});

// ------------------------------------------------------------------ rooms

function makeRoom({ verify = null, now = null } = {}) {
    let t = 1000;
    const clock = now || (() => t);
    const host = new RoomHost({ code: 'ABCDE', now: clock, verify });
    const clients = [];
    const join = (name) => {
        const [hostEnd, clientEnd] = loopbackPair('h', 'c' + clients.length);
        host.addConnection(hostEnd, { host: clients.length === 0 });
        const events = [];
        const c = new RoomClient({ conn: clientEnd, name, now: clock, onEvent: (type, m) => events.push([type, m]) });
        c.events = events;
        clients.push(c);
        return c;
    };
    return { host, join, clients, tick: (ms) => { t += ms; }, clock };
}

test('room: join, welcome, unique names, chat relay, leave', async () => {
    const room = makeRoom();
    const a = room.join('Pingu');
    const b = room.join('Pingu');
    await flush();
    assert.equal(a.you, 'p1');
    assert.equal(b.you, 'p2');
    assert.equal(b.name, 'Pingu 2');
    assert.ok(a.isHostPlayer);
    assert.ok(!b.isHostPlayer);
    assert.deepEqual(a.players.map((p) => p.name), ['Pingu', 'Pingu 2']);
    b.sendChat('hello <img src=x onerror=alert(1)>');
    await flush();
    const line = a.chat.find((c) => !c.sys);
    assert.equal(line.name, 'Pingu 2');
    assert.equal(line.text, 'hello <img src=x onerror=alert(1)>', 'kept as text');
    b.leave();
    await flush();
    await flush();
    assert.deepEqual(a.players.map((p) => p.name), ['Pingu']);
    assert.ok(a.chat.some((c) => c.sys && /left/.test(c.text)));
});

test('room: full rooms and other protocol versions are refused', async () => {
    const room = makeRoom();
    room.host.maxPlayers = 2;
    room.join('A');
    room.join('B');
    const c = room.join('C');
    await flush();
    assert.equal(c.you, null);
    assert.match(c.rejected, /full/);
    const [h, e] = loopbackPair('h', 'x');
    room.host.addConnection(h);
    e.onData(() => {});
    const got = [];
    e.onData((f) => got.push(JSON.parse(f)));
    e.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION + 1, name: 'old' }));
    await flush();
    assert.equal(got[0].t, 'reject');
});

test('room: poses relay to the others only, throttled, ignored outside a round', async () => {
    const room = makeRoom();
    const a = room.join('A');
    const b = room.join('B');
    const c = room.join('C');
    await flush();
    a.sendPose(1, 10, [1, 2, 3], [0, 0, 0, 1], 50);
    await flush();
    assert.equal(b.remotes.size, 0, 'no round yet');
    room.host.startRound({ id: 'S01', name: 'S01' }, 180000);
    await flush();
    assert.equal(b.round.state, 'racing');
    assert.equal(b.round.leftMs, 180000);
    a.sendPose(1, 10, [1, 2, 3], [0, 0, 0, 1], 50);
    a.sendPose(1, 11, [1, 2, 4], [0, 0, 0, 1], 50);   // same instant: dropped by the 20 Hz cap
    await flush();
    assert.equal(b.remotes.get('p1').samples.length, 1);
    assert.equal(c.remotes.get('p1').samples.length, 1);
    assert.equal(a.remotes.size, 0, 'no echo to the sender');
    room.tick(100);
    a.sendPose(1, 20, [1, 2, 5], [0, 0, 0, 1], 50);
    await flush();
    assert.equal(b.remotes.get('p1').samples.length, 2);
    assert.ok(b.players.find((p) => p.id === 'p1').driving);
    a.sendIdle();
    await flush();
    assert.equal(b.remotes.has('p1'), false);
});

test('room: flooding and garbage get a client dropped', async () => {
    const room = makeRoom();
    const a = room.join('A');
    const b = room.join('B');
    await flush();
    for (let i = 0; i < 200; i++) b.conn.send('{"t":"chat","text":' + JSON.stringify('x' + i) + '}');
    await flush();
    const lines = a.chat.filter((c) => !c.sys).length;
    assert.ok(lines <= 4, `chat rate limit (${lines} lines)`);
    for (let i = 0; i < 40; i++) b.conn.send('garbage');
    await flush();
    await flush();
    assert.equal(room.host.players.length, 1, 'kicked');
    await new Promise((r) => setTimeout(r, 250));
    assert.ok(b.closed);
});

test('room: finishes are verified by re-simulating the replay; forgeries are refused', async () => {
    const { world, run } = S01();
    const verify = (ref, replay) => verifyReplay(world, replay);
    const room = makeRoom({ verify });
    const a = room.join('Host');
    const b = room.join('Cheater');
    await flush();
    room.host.startRound({ id: 'S01', hash: world.hash, name: 'S01' }, 180000);
    await flush();
    assert.ok(a.sendFinish(run.replay, run.respawns));
    // Same inputs, claimed 5 s faster.
    b.sendFinish({ ...run.replay, timeMs: run.replay.timeMs - 5000 }, 0);
    await flush();
    await flush();
    const pa = a.players.find((p) => p.id === 'p1');
    const pb = a.players.find((p) => p.id === 'p2');
    assert.equal(pa.best, run.timeMs);
    assert.equal(pa.verified, true);
    assert.equal(pb.best, null);
    assert.ok(b.chat.some((c) => c.sys && /could not be verified/.test(c.text)));
    // A replay of another layout never counts.
    b.sendFinish({ ...run.replay, trackHash: '0123456789abcdef' }, 0);
    await flush();
    assert.equal(a.players.find((p) => p.id === 'p2').best, null);
    // The honest replay from the other client counts and ties.
    b.sendFinish(slimReplay(run.replay), run.respawns);
    await flush();
    assert.equal(a.players.find((p) => p.id === 'p2').best, run.timeMs);
    // Replays can be fetched to race against, and verify on the client too.
    let got = null;
    a.onEvent = (type, m) => { if (type === 'replay') got = m; };
    a.requestReplay('p2');
    await flush();
    await flush();
    assert.ok(got);
    assert.ok(verifyReplay(world, got.replay).ok);
});

test('room: the clock ends the round, awards points, late finishes are refused', async () => {
    const { world, run } = S01();
    const room = makeRoom({ verify: (ref, r) => verifyReplay(world, r) });
    const a = room.join('A');
    const b = room.join('B');
    const c = room.join('C');
    await flush();
    room.host.startRound({ id: 'S01', hash: world.hash }, 60000);
    await flush();
    a.sendFinish(run.replay, run.respawns);
    await flush();
    room.tick(60000 + FINISH_GRACE_MS + 1);
    b.sendFinish(run.replay, run.respawns);
    await flush();
    assert.equal(room.host.players[1].best, null, 'too late');
    c.ping();
    await flush();
    room.host.update();
    await flush();
    assert.equal(c.round.state, 'ended');
    assert.deepEqual(c.players.map((p) => p.pts), [10, 0, 0]);
    assert.ok(c.chat.some((m) => m.sys && /Round over! A takes it/.test(m.text)));
    room.host.startRound({ id: 'S01', hash: world.hash }, 60000);
    await flush();
    assert.equal(c.round.n, 2);
    assert.deepEqual(c.players.map((p) => p.best), [null, null, null], 'bests reset per round');
    assert.deepEqual(c.players.map((p) => p.pts), [10, 0, 0], 'points carry over');
});

test('room: silent peers time out, closing the room tells everyone', async () => {
    const room = makeRoom();
    const a = room.join('A');
    const b = room.join('B');
    await flush();
    room.tick(80000);
    a.ping();
    await flush();
    room.host.update();
    await flush();
    await flush();
    assert.deepEqual(room.host.players.map((p) => p.name), ['A'], 'the host player never times out, B does');
    assert.ok(a.chat.some((m) => m.sys && /lost the connection/.test(m.text)));
    const c = room.join('C');
    await flush();
    let closed = null;
    c.onEvent = (type, m) => { if (type === 'closed') closed = m; };
    room.host.close();
    await flush();
    await flush();
    assert.ok(closed);
    assert.match(closed.reason, /closed the room/);
    assert.ok(a.closed && b.closed && c.closed);
});

test('pose buffer: interpolates on the sender clock and snaps on restarts', () => {
    const pb = new PoseBuffer(100);
    const q = [0, 0, 0, 1];
    pb.push({ r: 1, k: 0, p: [0, 0, 0], q, s: 0 }, 1000);
    pb.push({ r: 1, k: 10, p: [10, 0, 0], q, s: 100 }, 1100);
    // 1150 - 100 delay = 1050 = tick 5 on the sender clock.
    const s = pb.sample(1150);
    assert.ok(Math.abs(s.pos[0] - 5) < 1e-9, String(s.pos[0]));
    assert.equal(pb.sample(5000).pos[0], 10, 'holds the last pose');
    pb.push({ r: 2, k: 0, p: [500, 0, 0], q, s: 0 }, 1200);
    assert.equal(pb.samples.length, 1);
    assert.equal(pb.sample(1250).pos[0], 500);
    pb.push({ r: 2, k: 0, p: [1, 0, 0], q, s: 0 }, 1300);
    assert.equal(pb.samples.length, 1, 'out-of-order ticks dropped');
});
