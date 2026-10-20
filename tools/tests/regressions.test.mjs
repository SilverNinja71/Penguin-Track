// Regression tests for the core audit findings (determinism at the API
// boundaries, physics feel, geometry and routes, editor / AI / TAS APIs).
// Each test names the problem it guards against.
import assert from 'node:assert/strict';
import { test, approx, info } from './_harness.mjs';
import { STEER_MAX, GROUND_Y, CELL, LAYER, DIRS } from '../../js/core/constants.js';
import * as M from '../../js/core/mathd.js';
import { Rng } from '../../js/core/rng.js';
import { BLOCKS, BLOCK_LIST, getBlockGeometry, makeTransform } from '../../js/core/blocks.js';
import {
    buildWorld, trackFromPath, validateTrack, analyzeTrack, normalizeTrack, placedConnectors, blockPreview,
} from '../../js/core/track.js';
import { encodeTrack, decodeTrack, trackHash, fromBase64Url } from '../../js/core/codec.js';
import { getSample } from '../../js/core/samples.js';
import { Sim, hashState } from '../../js/core/sim.js';
import { RIDE_HEIGHT, CAR, GRAVITY } from '../../js/core/car.js';
import { clampSteer, makeInput } from '../../js/core/input.js';
import {
    Recorder, encodeInputs, decodeInputs, countInputs, simulateReplay, verifyReplay, ghostPoseAt,
    snapshotCar, lerpCarSnapshot, MAX_REPLAY_TICKS,
} from '../../js/core/replay.js';
import { Autopilot, runAutopilot } from '../../js/core/autopilot.js';
import { RouteTracker } from '../../js/core/route.js';
import { formatTime } from '../../js/core/format.js';
import { flatWorld, addTrigger } from '../lib/testworlds.mjs';

const NONE = { steer: 0, gas: false, brake: false };
const GAS = { steer: 0, gas: true, brake: false };
const KMH = 3.6;

function pathWorld(pieces, start = [10, 0, 1, 0], extra = {}) {
    return buildWorld(trackFromPath({ id: 'T', name: 'test', start, pieces, ...extra }));
}

/** Overrides the car's pose in place (same world, so setState accepts it). */
function place(sim, { pos, quat = null, yaw = 0, vel = [0, 0, 0] }) {
    const st = sim.getState();
    st.car.quat = quat || M.qfromYaw([0, 0, 0, 1], yaw);
    st.car.pos = pos.slice();
    st.car.vel = vel.slice();
    st.car.angVel = [0, 0, 0];
    sim.setState(st);
}

function angSpeed(sim) {
    const w = sim.car.angVel;
    return Math.sqrt(w[0] * w[0] + w[1] * w[1] + w[2] * w[2]);
}

// ---------------------------------------------------------------------------
// Determinism at the API boundaries

test('steer is normalised once: fractional or garbage steer replays exactly', () => {
    const world = buildWorld(getSample('S01'));
    const odd = [(s) => s * 0.9999, (s) => s + 0.5, (s) => -s - 0.5, () => Infinity, () => -Infinity, () => NaN,
        () => 2 ** 31, () => -(2 ** 32) - 5, () => '123.6'];
    for (const f of odd) {
        for (const pushRaw of [false, true]) {
            const sim = new Sim(world), ap = new Autopilot(world), rec = new Recorder();
            for (let i = 0; i < 700; i++) {
                const a = ap.act(sim);
                const inp = { ...a, steer: f(a.steer) };
                sim.step(inp);
                rec.push(pushRaw ? inp : sim.lastInput);
            }
            const res = simulateReplay(world, rec.toReplay({ sim }), { sampleEvery: 0, stopAtFinish: false });
            assert.equal(res.sim.stateHash(), sim.stateHash(), `${f} (push ${pushRaw ? 'raw input' : 'lastInput'})`);
        }
    }
    assert.equal(clampSteer(2 ** 31), STEER_MAX);
    assert.equal(clampSteer(-Infinity), -STEER_MAX);
    assert.equal(clampSteer(NaN), 0);
    assert.equal(clampSteer(-0.4), 0);
    assert.ok(Object.is(clampSteer(-0.4), 0), 'no -0');
});

test('replay text is canonical, and hostile run lengths are refused before allocating', () => {
    let t0 = performance.now();
    assert.throws(() => decodeInputs('1:B*zzzzzz'), /too long/);
    assert.throws(() => decodeInputs('1:B*zzzzzzzzzzzzzz'), /too long/);
    assert.throws(() => countInputs(`1:B*${(MAX_REPLAY_TICKS + 1).toString(36)}`), /too long/);
    assert.ok(performance.now() - t0 < 50, 'refused quickly');
    assert.equal(countInputs(`1:B*${MAX_REPLAY_TICKS.toString(36)}`), MAX_REPLAY_TICKS);
    assert.equal(decodeInputs('1:B*3', { maxTicks: 3 }).length, 3);
    assert.throws(() => decodeInputs('1:B*4', { maxTicks: 3 }), /too long/);
    for (const bad of ['1:B*2!!', '1:D*9b!G0zazEF', '1:D*L', '1:A029', '1:A0', '1:H0', '1:B-0', '1:B*1', '1:B.B',
        '1:B1ekg', '1:B-1ekg', '1:B*01', '1:BR*1', '1:BR*', '1:B*', '1:I', '1:.B', '1:B.']) {
        assert.throws(() => decodeInputs(bad), undefined, bad);
    }
    // Every encoding decodes back to itself, one string per input list.
    const rng = new Rng(9);
    for (let k = 0; k < 300; k++) {
        const n = 1 + rng.int(60);
        const inputs = [];
        for (let i = 0; i < n; i++) {
            const pick = rng.int(5);
            const steer = pick === 0 ? 0 : pick === 1 ? STEER_MAX : pick === 2 ? -STEER_MAX : rng.int(2 * STEER_MAX + 1) - STEER_MAX;
            inputs.push(makeInput(rng.chance(0.3) ? steer : 0, rng.chance(0.6), rng.chance(0.2), rng.chance(0.02)));
        }
        const text = encodeInputs(inputs);
        assert.equal(encodeInputs(decodeInputs(text)), text);
        assert.equal(countInputs(text), n);
    }
    t0 = performance.now();
    info(`decode of a 1-hour replay: ${decodeInputs(`1:B*${MAX_REPLAY_TICKS.toString(36)}`).length} ticks in ${(performance.now() - t0).toFixed(0)} ms`);
});

/** Drives `world` with the autopilot; `perturb(sim)` may override the input; stops when `stop(sim)` is true. */
function driveUntil(world, perturb, stop, maxTicks = 8000) {
    const sim = new Sim(world), ap = new Autopilot(world);
    while (sim.tick < maxTicks) {
        const a = ap.act(sim);
        sim.step(perturb(sim) || a);
        if (stop(sim)) return { sim, ap };
    }
    throw new Error('event never happened');
}

function resumeFromSave(world, sim, ap) {
    const saved = JSON.parse(JSON.stringify({ sim: sim.getState(), ap: ap.getState() }));
    const sim2 = new Sim(world), ap2 = new Autopilot(world);
    sim2.setState(saved.sim);
    ap2.setState(saved.ap);
    assert.equal(sim2.stateHash(), sim.stateHash());
    for (let i = 0; i < 1500 && !sim.finished; i++) {
        const a = ap.act(sim), b = ap2.act(sim2);
        assert.deepEqual(b, a, `inputs differ ${i} ticks after the restore`);
        sim.step(a);
        sim2.step(b);
    }
    assert.equal(sim2.stateHash(), sim.stateHash());
    return sim;
}

test('autopilot savestates taken on a fall or a fragile break tick resume identically', () => {
    // Thin Ice broken by steering into the snowbank right after the pad (S04).
    const s04 = buildWorld(getSample('S04'));
    const broke = driveUntil(s04, (sim) => (sim.car.effects.fragile ? { steer: STEER_MAX, gas: true, brake: false } : null),
        (sim) => sim.events.some((e) => e.type === 'fragileBreak'));
    const after = resumeFromSave(s04, broke.sim, broke.ap);
    assert.ok(after.respawns >= 1, 'the restored pilot still respawns the broken car');
    // Off the edge of the map from a borderless snowfield: a real fall below fallY.
    const edge = pathWorld(['Start', 'Platform*6', 'Finish'], [0, 0, 2, 0]);
    const fell = driveUntil(edge, (sim) => (sim.car.pos[2] > 110 && !sim.fallen ? { steer: STEER_MAX / 2, gas: true, brake: false } : null),
        (sim) => sim.events.some((e) => e.type === 'fall'));
    resumeFromSave(edge, fell.sim, fell.ap);
});

test('state hash is canonical: key order and stray keys do not change it', () => {
    const world = buildWorld(getSample('S01'));
    const sim = new Sim(world), ap = new Autopilot(world);
    while (sim.checkpointTimes.length < 1) sim.step(ap.act(sim));
    for (let i = 0; i < 50; i++) sim.step(ap.act(sim));
    const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object'
        ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v);
    const plain = JSON.parse(JSON.stringify(sim.getState()));
    const sorted = sortKeys(plain);
    const extra = JSON.parse(JSON.stringify(plain));
    extra.cp.bogus = 1;
    extra.car.effects.bogus = true;
    extra.bogus = 'x';
    const h = sim.stateHash();
    for (const st of [plain, sorted, extra]) {
        assert.equal(hashState(st), h);
        const s2 = new Sim(world);
        s2.setState(st);
        assert.equal(s2.stateHash(), h);
        assert.ok(!('bogus' in s2.getState().cp));
    }
});

test('savestates carry their track, lap count and mode; impossible configurations are refused', () => {
    const w6 = buildWorld(getSample('S06'));
    const s6 = new Sim(w6);
    for (let i = 0; i < 300; i++) s6.step(GAS);
    const st = JSON.parse(JSON.stringify(s6.getState()));
    assert.equal(st.world, w6.hash);
    assert.equal(st.laps, 3);
    assert.throws(() => new Sim(w6, { laps: 1 }).setState(st), /3 lap/);
    assert.throws(() => new Sim(buildWorld(getSample('S01'))).setState(st), /another track/);
    assert.throws(() => new Sim(buildWorld(getSample('S01')), { laps: 3 }), /StartFinish/);
    assert.throws(() => new Sim(w6, { laps: 0 }), /lap count/);
    const noSpawn = buildWorld({ blocks: [{ b: 'Finish', x: 5, y: 0, z: 5 }] }, { route: false });
    assert.throws(() => new Sim(noSpawn), /no spawn/);
    assert.equal(new Sim(noSpawn, { allowNoSpawn: true }).tick, 0);
    // A replay remembers its lap count, so a laps override verifies.
    const r = runAutopilot(w6, { laps: 1, record: true });
    assert.ok(r.finished && r.replay.laps === 1);
    assert.equal(verifyReplay(w6, r.replay).ok, true);
    assert.equal(verifyReplay(w6, { ...r.replay, laps: 3 }).ok, false);
});

test('sim.respawn() is recorded like the respawn flag; nothing is recorded after the finish', () => {
    const world = buildWorld(getSample('S03'));
    const sim = new Sim(world), rec = new Recorder(), ap = new Autopilot(world);
    while (!sim.finished) {
        const a = ap.act(sim);
        if (sim.tick === 700) sim.respawn();
        sim.step(a);
        rec.push(sim.lastInput);
    }
    for (let i = 0; i < 30; i++) {
        sim.respawn();
        sim.step({ steer: 0.4, gas: true, respawn: true });
        rec.push(sim.lastInput);
    }
    assert.ok(rec.respawnTicks().includes(700));
    assert.ok(rec.respawnTicks().every((t) => t < sim.finishTimeMs / 10), 'no flags after the finish');
    const replay = rec.toReplay({ sim });
    const res = simulateReplay(world, replay, { sampleEvery: 0, stopAtFinish: false });
    assert.equal(res.sim.stateHash(), sim.stateHash());
    assert.deepEqual(res.respawnTicks, replay.respawnTicks);
    assert.equal(verifyReplay(world, replay).ok, true);
    // The respawn stays pending across a savestate.
    const s2 = new Sim(world);
    s2.respawn();
    assert.equal(s2.respawnPending, true);
    const s3 = new Sim(world);
    s3.setState(JSON.parse(JSON.stringify(s2.getState())));
    s3.step(NONE);
    assert.equal(s3.respawns, 1);
    assert.equal(s3.lastInput.respawn, true);
});

test('verifyReplay checks every claim a replay makes', () => {
    const world = buildWorld(getSample('S01'));
    const r = runAutopilot(world, { record: true });
    const rp = r.replay;
    assert.deepEqual(verifyReplay(world, rp), { ok: true, reason: null, finished: true, timeMs: r.timeMs, respawns: 0 });
    const bad = {
        'no track hash': { ...rp, trackHash: null },
        'claims unfinished': { ...rp, finished: false, timeMs: null },
        'wrong time': { ...rp, timeMs: rp.timeMs + 10 },
        'no time': { ...rp, timeMs: null },
        'wrong tick count': { ...rp, ticks: rp.ticks + 1 },
        'invented respawns': { ...rp, respawnTicks: [100] },
        'malformed inputs': { ...rp, inputs: '1:Z' },
        'not a replay': null,
    };
    for (const [why, replay] of Object.entries(bad)) assert.equal(verifyReplay(world, replay).ok, false, why);
    // A 300-tick prefix that never finishes is not a record...
    const head = { ...rp, inputs: encodeInputs(decodeInputs(rp.inputs).slice(0, 300)), ticks: 300, finished: false, timeMs: 1234, respawnTicks: [] };
    assert.equal(verifyReplay(world, head).ok, false);
    assert.equal(verifyReplay(world, { ...head, timeMs: null }).ok, false);
    // ...but it is a consistent unfinished replay.
    assert.equal(verifyReplay(world, { ...head, timeMs: null }, { requireFinish: false }).ok, true);
});

test('the rpm view is the same after a savestate restore', () => {
    const world = buildWorld(getSample('S03'));
    const sim = new Sim(world), ap = new Autopilot(world);
    let checked = 0;
    while (!sim.finished && sim.tick < 3000) {
        sim.step(ap.act(sim));
        if (sim.tick % 37 === 0 || (sim.car.airborne && sim.tick % 5 === 0)) {
            const s2 = new Sim(world);
            s2.setState(JSON.parse(JSON.stringify(sim.getState())));
            assert.equal(s2.car.rpm, sim.car.rpm, `rpm at tick ${sim.tick}`);
            assert.deepEqual(snapshotCar(s2.car), snapshotCar(sim.car));
            checked++;
        }
    }
    assert.ok(checked > 50);
});

// ---------------------------------------------------------------------------
// Physics feel

test('realignment: parked cars stay put across slopes and against snowbanks; sideways slides stay calm', () => {
    // Parked across the steepest part of SlopeUp1 (21°), no input, 20 s.
    const world = pathWorld(['Start', 'Straight*2', 'SlopeUp1', 'Straight*3', 'Finish'], [10, 0, 0, 0]);
    const r = world.route;
    let best = null;
    for (let s = 60; s < r.length - 60; s += 0.5) {
        const pt = r.pointAt(s);
        const h = world.collision.raycast([pt.point[0], pt.point[1] + 5, pt.point[2]], [0, -1, 0], 10);
        if (h && (!best || h.normal[1] < best.n[1])) best = { n: h.normal.slice(), p: h.point.slice(), t: pt.tangent.slice() };
    }
    const n = best.n;
    const right = M.vnormalize([0, 0, 0], M.vcross([0, 0, 0], best.t, n));
    const fwd = M.vneg([0, 0, 0], right);          // nose across the slope
    const q = M.qfromBasis([0, 0, 0, 1], M.vcross([0, 0, 0], fwd, n), n, fwd);
    const sim = new Sim(world);
    place(sim, { pos: M.vaddScaled([0, 0, 0], best.p, n, RIDE_HEIGHT), quat: q });
    for (let i = 0; i < 100; i++) sim.step(NONE);
    const p0 = sim.car.pos.slice();
    let maxV = 0;
    for (let i = 0; i < 2000; i++) { sim.step(NONE); maxV = Math.max(maxV, sim.car.speedKmh); }
    assert.ok(M.vdist(p0, sim.car.pos) < 0.05 && maxV < 0.5, `crept ${M.vdist(p0, sim.car.pos).toFixed(3)} m, ${maxV.toFixed(2)} km/h`);

    // A pure sideways slide no longer whips the nose round.
    for (const [surface, limit] of [['snow', 6], ['powder', 4], ['ice', 2]]) {
        const s2 = new Sim(flatWorld({ surface, half: 9000 }));
        place(s2, { pos: [0, RIDE_HEIGHT, 0], vel: [100 / KMH, 0, 0] });
        let peak = 0;
        for (let i = 0; i < 300; i++) { s2.step(NONE); peak = Math.max(peak, Math.abs(s2.car.angVel[1])); }
        assert.ok(peak < limit, `${surface} sideways at 100 km/h: ${peak.toFixed(2)} rad/s`);
    }
});

test('a car parked with a wheel at the snowbank foot rests without rocking or launching', () => {
    const world = pathWorld(['Start', 'Straight*20'], [10, 0, 0, 0]);
    const rows = [];
    for (const yawDeg of [0, -18]) {
        for (const dx of [-0.06, -0.02, 0, 0.02, 0.06, 0.12]) {
            // Road centre x = 336, deck edge (snowbank foot) on the right at x = 324.
            const x = 324 + 0.85 * M.dcos(yawDeg * M.DEG) + dx;
            const sim = new Sim(world);
            place(sim, { pos: [x, RIDE_HEIGHT, 300], yaw: yawDeg * M.DEG });
            for (let i = 0; i < 200; i++) sim.step(NONE);
            let maxW = 0, maxV = 0, flips = 0, prev = sim.car.wheels.map((w) => w.contact).join();
            const p0 = sim.car.pos.slice();
            for (let i = 0; i < 1500; i++) {
                sim.step(NONE);
                maxW = Math.max(maxW, angSpeed(sim));
                maxV = Math.max(maxV, sim.car.speedKmh);
                const c = sim.car.wheels.map((w) => w.contact).join();
                if (c !== prev) flips++;
                prev = c;
            }
            const moved = M.vdist(p0, sim.car.pos);
            rows.push(`${yawDeg}°/${dx}: ${flips} flips, ${maxW.toFixed(3)} rad/s`);
            assert.ok(flips <= 2 && maxW < 0.05 && maxV < 0.2 && moved < 0.02, `yaw ${yawDeg} dx ${dx}: ${flips} contact flips, |w| ${maxW}, ${maxV} km/h, moved ${moved}`);
        }
    }
    info(rows.join(' | '));
});

test('ice: a power slide cannot corner harder than the grip allows', () => {
    const rows = [];
    for (const steer of [0.3, 0.5, 1]) {
        const sim = new Sim(flatWorld({ surface: 'ice', half: 9000 }));
        while (sim.car.speedKmh < 100) sim.step(GAS);
        let turned = 0, prev = M.datan2(sim.car.vel[0], sim.car.vel[2]), t0 = 0;
        for (let i = 0; i < 600; i++) {
            sim.step({ steer: Math.round(steer * STEER_MAX), gas: sim.car.speedKmh < 100, brake: false });
            const hd = M.datan2(sim.car.vel[0], sim.car.vel[2]);
            if (i === 300) { turned = 0; t0 = sim.tick; }
            turned += M.wrapAngle(hd - prev);
            prev = hd;
        }
        const lat = sim.car.speed * Math.abs(turned) / ((sim.tick - t0) / 100);
        rows.push(`steer ${steer}: ${lat.toFixed(1)} m/s²`);
        assert.ok(lat < 8.5, `ice power slide at steer ${steer}: ${lat.toFixed(1)} m/s²`);
    }
    info(rows.join(' | '));
});

test('a car on its roof does not steer or spin in place', () => {
    const world = pathWorld(['Start', 'Straight*20', 'Finish'], [10, 0, 0, 0]);
    for (const inp of [NONE, { steer: STEER_MAX, gas: true, brake: false }]) {
        const sim = new Sim(world);
        place(sim, { pos: [336, 1.5, 300], quat: M.qfromAxisAngle([0, 0, 0, 1], [0, 0, 1], Math.PI) });
        for (let i = 0; i < 300; i++) sim.step(inp);
        let maxW = 0, maxV = 0;
        for (let i = 0; i < 1000; i++) { sim.step(inp); maxW = Math.max(maxW, angSpeed(sim)); maxV = Math.max(maxV, sim.car.speedKmh); }
        assert.ok(M.qup([0, 0, 0], sim.car.quat)[1] < -0.9, 'still on its roof');
        assert.ok(maxW < 0.2 && maxV < 1, `|w| ${maxW.toFixed(3)} rad/s, ${maxV.toFixed(2)} km/h`);
    }
});

test('effects: Glide keeps a reverse speed, boosts never downgrade, Thin Ice survives a kicker landing', () => {
    const z0 = -7900;
    const padWorld = (pads) => {
        const w = flatWorld({ half: 8000 });
        for (const [effect, a, b] of pads) addTrigger(w, { type: 'effect', effect, min: [-12, -1, a], max: [12, 4, b] });
        return w;
    };
    // Reversing onto a Glide pad (coasting back onto it, then flooring it).
    const g = new Sim(padWorld([['cruise', z0 - 12, z0 - 10]]));
    place(g, { pos: [0, RIDE_HEIGHT, z0], vel: [0, 0, -40 / KMH] });
    for (let i = 0; i < 150; i++) g.step(NONE);
    for (let i = 0; i < 200; i++) g.step(GAS);
    assert.ok(g.car.effects.cruise && g.car.effects.cruiseSpeed < -5, `cruise speed ${g.car.effects.cruiseSpeed}`);
    approx(g.car.forwardSpeed, g.car.effects.cruiseSpeed, 0.5, 'still reversing at the held speed');
    // Avalanche Boost, then a Frost Boost pad right after: the stronger push stays.
    const both = new Sim(padWorld([['turbo2', z0 + 3, z0 + 5], ['turbo', z0 + 30, z0 + 32]]));
    const only = new Sim(padWorld([['turbo2', z0 + 3, z0 + 5]]));
    for (let i = 0; i < 300; i++) { both.step(GAS); only.step(GAS); }
    assert.ok(both.car.speedKmh >= only.car.speedKmh - 0.5, `${both.car.speedKmh} vs ${only.car.speedKmh}`);
    // A Frost Boost late in an Avalanche Boost does refresh it.
    const late = new Sim(padWorld([['turbo2', z0 + 3, z0 + 5], ['turbo', z0 + 150, z0 + 152]]));
    let refreshed = false;
    for (let i = 0; i < 400; i++) { late.step(GAS); if (late.events.some((e) => e.type === 'boost' && e.level === 1)) refreshed = late.car.effects.turbo === 1; }
    assert.ok(refreshed, 'a weaker boost takes over once the strong one has decayed');
    // Thin Ice: a landing under CAR.fragileLanding survives, a harder one breaks.
    for (const [vy, breaks] of [[-18, false], [-24, true]]) {
        const w = padWorld([]);
        const s = new Sim(w);
        place(s, { pos: [0, RIDE_HEIGHT + 0.6, 0], vel: [0, vy, 30] });
        const st = s.getState();
        st.car.airTicks = 50;
        st.car.effects.fragile = true;
        s.setState(st);
        let broke = false;
        for (let i = 0; i < 60; i++) { s.step(GAS); if (s.events.some((e) => e.type === 'fragileBreak')) broke = true; }
        assert.equal(broke, breaks, `landing at ${-vy} m/s`);
    }
});

test('Bank3: every line is loaded at plateau speed, the centerline holds at 220 km/h', () => {
    const world = pathWorld(['Start', 'Straight*36', 'Bank3R', 'Straight*4', 'Finish'], [44, 0, 1, 0]);
    const r = world.route;
    const bank = world.blocks[37];
    const s0 = r.project([(bank.x + 1.5) * CELL, 0, bank.z * CELL]).s - 30;
    // Normal load the deck asks for along fixed lateral lines: g·n_y + v²·κn + downforce.
    for (const lat of [10, 6, 0, -6, -10]) {
        const pts = [];
        for (let s = s0; s <= s0 + 190; s += 1) {
            const pt = r.pointAt(s);
            const R = M.vcross([0, 0, 0], pt.tangent, pt.up);
            const b = M.vaddScaled([0, 0, 0], pt.point, R, lat);
            const h = world.collision.raycast([b[0], b[1] + 20, b[2]], [0, -1, 0], 40);
            pts.push({ p: h.point.slice(), n: h.normal.slice() });
        }
        const v = 285 / KMH;
        let minLoad = Infinity;
        for (let i = 3; i < pts.length - 3; i++) {
            const a = pts[i - 3].p, b = pts[i].p, c = pts[i + 3].p;
            const d1 = M.vdist(a, b), d2 = M.vdist(b, c);
            const kn = [0, 1, 2].reduce((acc, k) => acc + 2 * ((c[k] - b[k]) / d2 - (b[k] - a[k]) / d1) / (d1 + d2) * pts[i].n[k], 0);
            minLoad = Math.min(minLoad, GRAVITY * pts[i].n[1] + v * v * kn + CAR.downforce * v * v);
        }
        assert.ok(minLoad > 2, `line ${lat} m: min normal load ${minLoad.toFixed(1)} m/s² at 285 km/h`);
    }
    // Driving the centerline (no racing line) at 220 km/h: wheels stay down, no wall.
    const ap = new Autopilot(world, { racingLine: false, maxSpeed: 220 / KMH, respawn: false });
    const sim = new Sim(world);
    let air = 0, walls = 0;
    while (!sim.finished && sim.tick < 8000) {
        sim.step(ap.act(sim));
        const p = sim.car.pos;
        if (p[2] >= bank.z * CELL && p[2] <= (bank.z + 3) * CELL && p[0] >= bank.x * CELL && p[0] <= (bank.x + 3) * CELL && sim.car.airborne) air++;
        walls += sim.events.filter((e) => e.type === 'wallhit').length;
    }
    assert.ok(sim.finished && air === 0 && walls === 0, `centerline at 220: ${air} airborne ticks, ${walls} wall hits`);
});

test('loops: the speed needed at the bottom of the circle is pinned (gas held vs coasting)', () => {
    // The Loop block has 32 m of road before the circle: from a standstill at its
    // entrance, full gas reaches the bottom at ~110 km/h, so a gas-held loop always
    // completes and the coasting threshold is the one that bites (see CORE_API).
    const world = pathWorld(['Start', 'Straight*8', 'Loop', 'Straight*3', 'Finish']);
    const circleZ = world.blocks[9].z * CELL + CELL;
    const tryLoop = (entryKmh, gas) => {
        const ap = new Autopilot(world, { respawn: false, maxSpeed: entryKmh / KMH });
        const sim = new Sim(world);
        let top = false, left = false;
        while (sim.tick < 4000 && !sim.finished && !left) {
            const inp = ap.act(sim);
            if (sim.car.pos[2] >= circleZ - 3) { inp.gas = gas; inp.brake = false; inp.steer = 0; }
            sim.step(inp);
            if (sim.car.pos[1] > 25) top = true;
            if (sim.car.pos[1] > 3 && sim.car.airborne) left = true;
        }
        return sim.finished && top && !left;
    };
    assert.ok(!tryLoop(45, true) && tryLoop(95, true), 'gas held: needs ~65 km/h at the bottom');
    assert.ok(!tryLoop(130, false) && tryLoop(175, false), 'coasting: needs ~150 km/h at the bottom');
    // From a standstill at the block entrance, the run-up alone carries it round.
    const standing = pathWorld(['Start', 'Loop', 'Straight*3', 'Finish']);
    const r = runAutopilot(standing, { maxTicks: 3000 });
    assert.ok(r.finished && r.respawns === 0);
});

// ---------------------------------------------------------------------------
// Geometry, triggers and routes

test('gates stay below the next layer: a road stacked over a Finish or Checkpoint never takes it', () => {
    const upper = ['Start', 'Straight', 'SlopeUp1', 'Straight*4', 'Straight', 'Straight', 'Finish'];
    // A Finish one layer below the upper road (it validates: the route ends at either finish).
    const fin = buildWorld(trackFromPath({ id: 'f', start: [10, 0, 4, 0], pieces: upper, extra: [{ b: 'Finish', x: 10, y: 0, z: 9, r: 0 }] }));
    for (const trg of fin.triggers) {
        if (trg.type === 'effect') continue;
        const deck = fin.blocks[trg.blockIndex].y * LAYER;
        assert.ok(trg.max[1] <= deck + 7 + 1e-9, `${trg.type} box reaches ${trg.max[1] - deck} m above its deck`);
    }
    const sim = new Sim(fin);
    while (!sim.finished && sim.tick < 3000) sim.step(GAS);
    assert.ok(sim.finished && sim.car.pos[1] > 6 && sim.car.pos[2] > 13 * CELL, `finished at z ${sim.car.pos[2].toFixed(0)} y ${sim.car.pos[1].toFixed(1)}`);
    // A Checkpoint below: driving over it on the upper road does not take it.
    const cp = buildWorld(trackFromPath({ id: 'c', start: [10, 0, 4, 0], pieces: upper, extra: [{ b: 'Checkpoint', x: 10, y: 0, z: 9, r: 0 }] }), { route: false });
    const s2 = new Sim(cp);
    const seen = [];
    while (s2.tick < 900) {
        s2.step(GAS);
        for (const e of s2.events) if (e.type === 'checkpoint' || e.type === 'finish') seen.push(e.type);
    }
    assert.ok(s2.car.pos[2] > 13 * CELL, `only reached z ${s2.car.pos[2].toFixed(0)}`);
    assert.ok(!seen.includes('checkpoint'), seen.join(' '));
});

test('lap tracks route one closed lap; a Finish arch cannot end one', () => {
    const open = trackFromPath({ id: 'a', start: [10, 0, 4, 0], laps: 3, pieces: ['StartFinish', 'Straight*2', 'Finish', 'Straight*2'] });
    const v = validateTrack(open);
    assert.equal(v.ok, false);
    assert.ok(v.issues.some((i) => i.code === 'unreachableFinish'), v.errors.join('; '));
    const circuit = trackFromPath({
        id: 'b', start: [10, 0, 10, 0], laps: 3,
        pieces: ['StartFinish', 'Straight*2', 'Turn2R', 'Finish', 'Straight', 'Checkpoint', 'Turn2R', 'Straight*3', 'Turn2R', 'Straight*2', 'Checkpoint', 'Turn2R'],
    });
    assert.ok(validateTrack(circuit).ok, validateTrack(circuit).errors.join('; '));
    const w = buildWorld(circuit);
    assert.ok(w.route.closed);
    const r = runAutopilot(w);
    assert.ok(r.finished && r.lapTimes.length === 3, `laps ${r.lapTimes}`);
});

test('jumps: zero-gap kickers and drops validate, landings far above the take-off do not', () => {
    for (const pieces of [
        ['Start', 'Straight', 'RampSmall', 'Straight*5', 'Finish'],
        ['Start', 'Straight', 'RampBig', 'Straight*5', 'Finish'],
    ]) {
        for (let d = 0; d < 4; d++) {
            const start = [[20, 0, 2], [44, 0, 20], [20, 0, 44], [2, 0, 20]][d];
            const t = trackFromPath({ id: 'j', start: [...start, d], pieces });
            const v = validateTrack(t);
            assert.ok(v.ok, `${pieces[2]} heading ${d}: ${v.errors.join('; ')}`);
            if (d === 0) assert.ok(runAutopilot(buildWorld(t), { maxTicks: 3000 }).finished, pieces[2]);
        }
    }
    const drop = trackFromPath({ id: 'd', start: [10, 1, 4, 0], pieces: ['Start', 'Straight', 'Down', 'Straight*3', 'Finish'] });
    assert.ok(validateTrack(drop).ok, validateTrack(drop).errors.join('; '));
    assert.ok(runAutopilot(buildWorld(drop), { maxTicks: 3000 }).finished);
    const up = trackFromPath({ id: 'u', start: [10, 0, 4, 0], pieces: ['Start', 'Straight', 'Gap', 'Up', 'Up', 'Up', 'Up', 'Up', 'Straight', 'Finish'] });
    assert.equal(validateTrack(up).ok, false, 'a road end cannot jump 40 m up');
});

test('checkpoint order: a dead end after the nearest checkpoint backtracks to another order', () => {
    const t = trackFromPath({
        id: 'order', start: [10, 0, 5, 0],
        pieces: ['Start', 'Straight', 'CrossR', 'Straight', 'Checkpoint', 'Turn1R', 'Straight*3', 'Turn1R', 'Straight*4', 'Turn1R', 'Straight*3', 'Turn1R', 'Straight'],
        extra: [{ b: 'Checkpoint', x: 10, y: 0, z: 8, r: 0 }, { b: 'Finish', x: 10, y: 0, z: 9, r: 0 }],
    });
    const v = validateTrack(t);
    assert.ok(v.ok, v.errors.join('; '));
    const r = runAutopilot(buildWorld(t), { maxTicks: 8000 });
    assert.ok(r.finished, 'the autopilot follows the backtracked order');
    // Unreachable checkpoints are reported by id (0-based) and block.
    const lost = JSON.parse(JSON.stringify(getSample('S01')));
    lost.blocks.push({ b: 'Checkpoint', x: 40, y: 0, z: 40, r: 0 });
    const issue = validateTrack(lost).issues.find((i) => i.code === 'unreachableCheckpoint');
    assert.deepEqual([issue.checkpointIds, issue.blocks], [[2], [lost.blocks.length - 1]]);
});

test('slope tops are closed below an attached road; loop pillars meet the deck', () => {
    for (const slope of ['SlopeUp1', 'SlopeUp2', 'SlopeBig', 'PlatformRamp']) {
        const world = pathWorld(['Start', 'Straight', slope, 'Straight', 'Finish'], [5, 0, 1, 0]);
        const blk = world.blocks[2];
        const zTop = (blk.z + BLOCKS[slope].size[2]) * CELL;
        // Horizontal rays toward the top end face, below the attached road's slab (and
        // beside its pillar): they must stop on the face, not enter the hollow slope.
        const top = (BLOCKS[slope].size[1] - 1) * LAYER;
        for (let y = 0.5; y < top - 1.6; y += 1) {
            const hit = world.collision.raycast([5 * CELL + 16 + 6, y, zTop + 0.5], [0, 0, -1], 40);
            assert.ok(hit, `${slope}: no face at ${y} m`);
            approx(hit.point[2], zTop, 1e-6, `${slope}: ray at ${y} m enters the slope body`);
        }
    }
    for (const loop of ['Loop', 'LoopL']) {
        const w = buildWorld({ blocks: [{ b: loop, x: 5, y: 1, z: 7, r: 0 }] }, { route: false });
        const pillars = w.render.props.filter((p) => p.kind === 'pillar');
        assert.ok(pillars.length >= 2);
        for (const p of pillars) {
            for (const [ox, oz] of [[-0.9, -0.9], [0.9, -0.9], [0.9, 0.9], [-0.9, 0.9]]) {
                const up = w.collision.raycast([p.pos[0] + ox, p.pos[1] + p.height - 0.01, p.pos[2] + oz], [0, 1, 0], 5);
                assert.ok(up && up.t < 0.03, `${loop} pillar corner: deck ${up ? up.t.toFixed(3) : 'none'} m above`);
            }
        }
    }
});

test('twisted decks: banks and loops have small creases and no step at their seams', () => {
    const crease = (id) => {
        const { col, surf } = getBlockGeometry(id, 'snow').groups.get('main');
        const deck = [];
        for (let t = 0; t < surf.length; t++) if (surf[t] === 0) deck.push(t);
        const key = (i) => `${col[i].toFixed(4)},${col[i + 1].toFixed(4)},${col[i + 2].toFixed(4)}`;
        const edges = new Map();
        let worst = 0;
        for (const t of deck) {
            const a = [col[t * 9], col[t * 9 + 1], col[t * 9 + 2]];
            const n = M.vnormalize([0, 0, 0], M.vcross([0, 0, 0], M.vsub([0, 0, 0], [col[t * 9 + 3], col[t * 9 + 4], col[t * 9 + 5]], a), M.vsub([0, 0, 0], [col[t * 9 + 6], col[t * 9 + 7], col[t * 9 + 8]], a)));
            for (let e = 0; e < 3; e++) {
                const k = [key(t * 9 + e * 3), key(t * 9 + ((e + 1) % 3) * 3)].sort().join('|');
                const other = edges.get(k);
                if (other) worst = Math.max(worst, M.dacos(Math.min(1, M.vdot(other, n))) / M.DEG);
                else edges.set(k, n);
            }
        }
        return worst;
    };
    const rows = [];
    for (const [id, max] of [['Bank2', 8], ['Bank3', 5], ['Loop', 11], ['LoopL', 14]]) {
        const c = crease(id);
        rows.push(`${id} ${c.toFixed(1)}°`);
        assert.ok(c < max, `${id}: crease ${c.toFixed(1)}°`);
    }
    info(`largest crease between adjacent deck triangles: ${rows.join(', ')}`);
});

test('the ground is flush with level 0: rejoining the track from the snow has no step', () => {
    assert.equal(GROUND_Y, 0);
    const world = pathWorld(['Start', 'Gap', 'Gap', 'Straight', 'Finish'], [10, 0, 2, 0]);
    const sim = new Sim(world);
    let maxY = 0;
    while (!sim.finished && sim.tick < 1500) { sim.step(GAS); maxY = Math.max(maxY, sim.car.pos[1]); }
    assert.ok(sim.finished && maxY < RIDE_HEIGHT + 0.08, `hopped to ${maxY.toFixed(2)} m`);
    // A level-0 deck is still read as its own surface, never as deep snow.
    const hit = world.collision.raycast([10 * CELL + 16, 1, 5 * CELL + 16], [0, -1, 0], 3);
    assert.equal(hit.surfaceId, 'snow');
});

test('route.project with a stale hint finds the nearest segment; Cross corners report their real width', () => {
    for (const id of ['S01', 'S03', 'S05']) {
        const r = buildWorld(getSample(id)).route;
        const rng = new Rng(4);
        for (let k = 0; k < 2000; k++) {
            const p = r.pointAt(rng.range(0, r.length)).point;
            const g = r.project(p);
            const hint = Math.max(0, Math.min(r.count - 2, g.index + (rng.chance(0.5) ? 20 : -20) + rng.int(7) - 3));
            const h = r.project(p, hint);
            assert.ok(h.dist <= g.dist + 1e-6 || h.dist < 1e-6, `${id}: hinted ${h.dist} vs global ${g.dist}`);
        }
    }
    const cross = buildWorld(getSample('S05'));
    let minHw = Infinity;
    for (let i = 0; i < cross.route.count; i++) minHw = Math.min(minHw, cross.route.halfWidth[i]);
    assert.ok(minHw <= 11.5, `Cross corner half-width ${minHw}`);
});

test('share codes and hashes normalise their input exactly like normalizeTrack', () => {
    const raw = { laps: 2.5, mode: 'drag', blocks: [{ b: 'Start', x: 1.5, y: 0, z: 2.7, r: 5 }, { b: 'Finish', x: 1, y: 0, z: 3 }] };
    const back = decodeTrack(encodeTrack(raw));
    assert.deepEqual(normalizeTrack(back), normalizeTrack(raw));
    assert.equal(trackHash(raw), buildWorld(raw, { route: false }).hash);
    assert.equal(trackHash(back), trackHash(raw));
    // One byte string, one code: non-zero padding bits are rejected.
    const code = encodeTrack(getSample('S01'));
    const tail = code.slice(-1);
    const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const alt = B64[(B64.indexOf(tail) ^ 1)];
    assert.throws(() => fromBase64Url(code.slice(4, -1) + alt), /padding/);
    assert.throws(() => decodeTrack(code.slice(0, -1) + alt), /Corrupt/);
});

// ---------------------------------------------------------------------------
// Editor, renderer, AI and TAS APIs

test('editor data: triangle -> block, render ranges per block, cell lookup, structured issues', () => {
    const world = buildWorld(getSample('S03'));
    const c = world.collision;
    assert.equal(c.triBlock.length, c.triCount);
    // A ray down onto each block's first deck point hits a triangle tagged with that block.
    for (const b of world.blocks) {
        const p = getBlockGeometry(b.b, b.s).paths[0].pts;
        const xf = makeTransform(BLOCKS[b.b], b.x, b.y, b.z, b.r);
        const q = xf.point([p[3], p[4], p[5]]);
        const hit = c.raycast([q[0], q[1] + 0.5, q[2]], [0, -1, 0], 1);
        assert.ok(hit && c.triBlock[hit.tri] === b.index, `block #${b.index} (${b.b})`);
    }
    for (const m of world.render.meshes) {
        let covered = 0;
        for (const r of m.ranges) {
            assert.equal(r.start, covered, `${m.material} ranges are contiguous`);
            covered += r.count;
            assert.ok(r.blockIndex === -1 || world.blocks[r.blockIndex]);
        }
        assert.equal(covered, m.indices.length, m.material);
    }
    // The elevated landing's slab hangs into the cell below; picking by triangle still finds it.
    const landing = world.blocks.find((b) => b.y === 1);
    const side = c.raycast([(landing.x + 0.5) * CELL, landing.y * LAYER - 0.7, (landing.z + 0.5) * CELL - 40], [0, 0, 1], 60);
    assert.ok(side && c.triBlock[side.tri] === landing.index, 'side hit on an elevated slab picks its block');
    assert.equal(world.blockAt(landing.x, landing.y, landing.z), landing.index);
    assert.equal(world.blockAt(0, 0, 0), -1);
    assert.throws(() => structuredClone(world), 'worlds cannot be posted to workers (rebuild there)');
    // Structured issues.
    const t = JSON.parse(JSON.stringify(getSample('S01')));
    t.blocks.push({ ...t.blocks[3] });
    const v = validateTrack(t);
    const ov = v.issues.find((i) => i.code === 'overlap');
    assert.deepEqual(ov.blocks, [t.blocks.length - 1, 3]);
    assert.equal(ov.cell.length, 3);
    const frac = validateTrack({ blocks: [{ b: 'Start', x: 1.5, y: 0, z: 2 }] });
    assert.ok(frac.issues.some((i) => i.code === 'badCoordinate' && i.blocks[0] === 0));
    const open = validateTrack(getSample('S05'));
    assert.ok(open.issues.filter((i) => i.code === 'openEnd').every((i) => i.blocks.length === 1 && i.cell && i.dir >= 0));
    // analyzeTrack accepts a raw track.
    assert.equal(analyzeTrack({ blocks: [{ b: 'Start', x: 1, y: 0, z: 1 }] }).placements.length, 1);
});

test('editor previews: placed connectors and block previews match buildWorld', () => {
    for (const def of BLOCK_LIST) {
        for (let r = 0; r < 4; r++) {
            const w = buildWorld({ blocks: [{ b: def.id, x: 10, y: 2, z: 10, r }] }, { route: false });
            const pc = placedConnectors(def.id, 10, 2, 10, r);
            assert.deepEqual(pc.map((c) => [c.local, c.kind, c.profile, c.cell, c.dir, c.pos]),
                w.blocks[0].connectors.map((c) => [c.local, c.kind, c.profile, c.cell, c.dir, c.pos]), `${def.id} r${r}`);
            if (r === 1) {
                const prev = blockPreview(def.id, 10, 2, 10, r);
                const world = w.render.meshes.filter((m) => m.material !== 'ground');
                assert.deepEqual(prev.map((m) => [m.material, m.positions.length, m.indices.length]),
                    world.map((m) => [m.material, m.positions.length, m.indices.length]), def.id);
                for (let i = 0; i < prev.length; i++) assert.deepEqual(prev[i].positions, world[i].positions);
            }
        }
    }
    // A preview attached to a road on connector 0 drops that end's caps.
    const open = blockPreview('Straight', 3, 0, 3, 0, 'snow');
    const joined = blockPreview('Straight', 3, 0, 3, 0, 'snow', ['road', null]);
    const tris = (ms) => ms.reduce((n, m) => n + m.indices.length, 0);
    assert.ok(tris(joined) < tris(open));
});

test('trackFromPath: turtle jumps, marks, sidesteps, side decor, case-insensitive names, clear errors', () => {
    const t = trackFromPath({
        start: [10, 0, 10, 0],
        pieces: ['start', { mark: 'A' }, 'straight', { d: 'Pine', side: 'left', dist: 2 }, 'Finish',
            { at: [20, 0, 10, 0] }, 'Straight', 'Right', 'Straight', { goto: 'A' }, 'Left*3', 'Straight'],
    });
    const at = (b) => [b.b, b.x, b.z];
    assert.deepEqual(t.blocks.map(at), [['Start', 10, 10], ['Straight', 10, 11], ['Finish', 10, 12], ['Straight', 20, 10], ['Straight', 19, 11], ['Straight', 13, 11]]);
    assert.deepEqual(t.decor, [{ d: 'Pine', x: 12, y: 0, z: 12, r: 0 }]);
    assert.throws(() => trackFromPath({ start: [1, 0, 1, 0], pieces: ['Start'], extra: [{ b: 'Snowplow', x: 5, y: 0, z: 5 }] }), /extra #0: unknown block 'Snowplow'/);
    assert.throws(() => trackFromPath({ start: [1, 0, 1, 0], pieces: [{ n: 2 }] }), /piece #0 .*missing 'b'/);
    assert.throws(() => trackFromPath({ start: [1, 0, 1, 0], pieces: [{ goto: 'nowhere' }] }), /no mark 'nowhere'/);
});

test('RouteTracker: lap-aware progress that survives respawns and savestates', () => {
    const world = buildWorld(getSample('S06'));
    const sim = new Sim(world), ap = new Autopilot(world), tr = new RouteTracker(world.route);
    let prev = -Infinity, saved = null;
    while (!sim.finished) {
        sim.step(ap.act(sim));
        tr.track(sim);
        assert.ok(tr.progress >= prev - 0.5, 'progress never jumps back without a respawn');
        prev = tr.progress;
        if (sim.tick === 1500) saved = JSON.parse(JSON.stringify({ sim: sim.getState(), tr: tr.getState() }));
    }
    approx(tr.progress, 3 * world.route.length, 10, 'three laps of progress (the gate fires ~2 m before the line)');
    assert.equal(tr.lap, 3);
    // Respawn back to a checkpoint: progress steps back, the stuck timer restarts.
    const s2 = new Sim(world), t2 = new RouteTracker(world.route);
    s2.setState(saved.sim);
    t2.setState(saved.tr);
    const before = t2.progress;
    s2.step({ ...GAS, respawn: true });
    t2.track(s2);
    assert.ok(t2.progress < before && t2.bestTick === s2.tick);
});

test('edgeRays: cheap 2D road-edge sensors for AI observations', () => {
    const world = buildWorld(getSample('S01'));
    const r = world.route;
    const sim = new Sim(world);
    const right = Math.PI / 2;
    const d = r.edgeRays(sim.car.pos, [DIRS[world.spawn.dir][0], DIRS[world.spawn.dir][2]], [-right, -right / 2, 0, right / 2, right], 120);
    approx(d[0], 12, 0.05);
    approx(d[4], 12, 0.05);
    approx(d[1], 12 * Math.SQRT2, 0.1);
    assert.ok(d[2] > 60, `ahead ${d[2]}`);
    const t0 = performance.now();
    const angles = Array.from({ length: 15 }, (_, i) => -Math.PI / 2 + (i * Math.PI) / 14);
    const out = new Float64Array(15);
    let hint = -1;
    for (let i = 0; i < 2000; i++) {
        const p = r.pointAt((i * 0.5) % r.length);
        r.edgeRays(p.point, [p.tangent[0], p.tangent[2]], angles, 120, out, hint);
        hint = p.index;
    }
    info(`edgeRays: ${(2000 / ((performance.now() - t0) / 1000)).toFixed(0)} fans of 15 x 120 m per second`);
});

test('runAutopilot finishes every sample, returns a verified replay, and gives up on hopeless runs', () => {
    const rows = [];
    for (const id of ['S01', 'S02', 'S03', 'S04', 'S05', 'S06']) {
        const world = buildWorld(getSample(id));
        const r = runAutopilot(world, { record: true });
        assert.ok(r.finished && !r.gaveUp, id);
        assert.equal(verifyReplay(world, r.replay).ok, true, id);
        rows.push(`${id} ${formatTime(r.timeMs)}`);
    }
    info(rows.join(' | '));
    const stuck = pathWorld(['Start', 'Straight*3', 'Finish']);
    const r = runAutopilot(stuck, { maxTicks: 50000, giveUpAfter: 3, maxSpeed: 0 });
    assert.ok(!r.finished && r.gaveUp && r.respawns === 4, `respawns ${r.respawns}`);
    assert.throws(() => runAutopilot(buildWorld({ blocks: [{ b: 'Start', x: 1, y: 0, z: 1 }] })), /needs a route/);
});

test('renderer helpers: snapshots, interpolation, ghosts snap across respawns, wheels never spin backwards', () => {
    const world = buildWorld(getSample('S03'));
    const inputs = [];
    const sim = new Sim(world), ap = new Autopilot(world), rec = new Recorder();
    let prev = snapshotCar(sim.car);
    while (sim.tick < 900) {
        const a = sim.tick === 650 ? { ...ap.act(sim), respawn: true } : ap.act(sim);
        sim.step(a);
        rec.push(sim.lastInput);
        inputs.push(a);
        const cur = snapshotCar(sim.car);
        const mid = lerpCarSnapshot(prev, cur, 0.5);
        for (let k = 0; k < 3; k++) approx(mid.pos[k], (prev.pos[k] + cur.pos[k]) / 2, 1e-9);
        prev = cur;
    }
    const res = simulateReplay(world, rec.toReplay({ sim }), { sampleEvery: 1, stopAtFinish: false });
    const tele = res.samples.find((s) => s.teleport);
    assert.ok(tele && tele.tick === 651, 'the respawn tick is flagged');
    const pose = ghostPoseAt(res.samples, 650.5);
    assert.deepEqual(pose.pos, tele.pos, 'no glide across the respawn');
    // Wheel spin follows the distance travelled even when it wraps by more than half a turn per tick.
    const out = { pos: [0, 0, 0], quat: [0, 0, 0, 1], speedKmh: 0, wheels: [{}, {}, {}, {}] };
    const fast = res.samples.filter((s) => s.speedKmh > 200);
    const a = fast[10], b = res.samples[res.samples.indexOf(a) + 1];
    const s0 = ghostPoseAt(res.samples, a.tick, { ...out, wheels: [{}, {}, {}, {}] }).wheels[0].spin;
    const s1 = ghostPoseAt(res.samples, a.tick + 0.25, out).wheels[0].spin;
    const step = ((s1 - s0) % M.TWO_PI + M.TWO_PI) % M.TWO_PI;
    assert.ok(step > 0 && step < Math.PI, 'a quarter tick later the wheel has turned forward');
    assert.equal(inputs.length, 900);
});

test('formatTime: one race-time format for every screen', () => {
    assert.equal(formatTime(42370), '0:42.37');
    assert.equal(formatTime(42370, { style: 'long' }), '0:42.370');
    assert.equal(formatTime(42370, { style: 'short' }), '42.37');
    assert.equal(formatTime(725200), '12:05.20');
    assert.equal(formatTime(61005), '1:01.00');
    assert.equal(formatTime(-1530, { style: 'short' }), '-1.53');
    assert.equal(formatTime(530, { sign: true, style: 'short' }), '+0.53');
    assert.equal(formatTime(null), '-:--.--');
    assert.equal(formatTime(NaN, { empty: '' }), '');
});
