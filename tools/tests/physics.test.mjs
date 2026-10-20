// Physics, race rules, replays and the autopilot (js/core car/sim/input/replay/autopilot).
import assert from 'node:assert/strict';
import { test, info } from './_harness.mjs';
import { STEER_MAX, TICK_MS } from '../../js/core/constants.js';
import * as M from '../../js/core/mathd.js';
import { Rng } from '../../js/core/rng.js';
import { buildWorld, trackFromPath } from '../../js/core/track.js';
import { getSamples, getSample } from '../../js/core/samples.js';
import { Sim, hashState } from '../../js/core/sim.js';
import { GRAVITY, SLOWMO_SCALES, RIDE_HEIGHT } from '../../js/core/car.js';
import {
    makeInput, clampInput, inputsEqual, digitalSteer, analogSteer, ACTIONS, actionToInput, inputToAction, NEUTRAL,
} from '../../js/core/input.js';
import { encodeInputs, decodeInputs, Recorder, simulateReplay, verifyReplay, ghostPoseAt } from '../../js/core/replay.js';
import { Autopilot } from '../../js/core/autopilot.js';
import { flatWorld, addTrigger } from '../lib/testworlds.mjs';

const GAS = { steer: 0, gas: true, brake: false };
const KMH = 3.6;

function kmh(v) {
    return (v * KMH).toFixed(0);
}

/** Straight-line test track from the turtle builder (start at x=10 heading +Z unless given). */
function pathWorld(pieces, start = [10, 0, 1, 0], extra = {}) {
    return buildWorld(trackFromPath({ id: 'T', name: 'test', start, pieces, ...extra }));
}

/** Places the car with a given heading (yaw) and velocity on a synthetic world. */
function launch(sim, { pos, yaw = 0, speed = 0, quat = null }) {
    const st = sim.getState();
    st.car.quat = quat || M.qfromYaw([0, 0, 0, 1], yaw);
    st.car.vel = [M.dsin(yaw) * speed, 0, M.dcos(yaw) * speed];
    if (pos) st.car.pos = pos.slice();
    sim.setState(st);
}

function runAutopilot(world, opts = {}, maxTicks = 20000, onTick = null) {
    const ap = new Autopilot(world, opts);
    const sim = new Sim(world);
    while (!sim.finished && sim.tick < maxTicks) {
        const inp = ap.act(sim);
        sim.step(inp);
        if (onTick) onTick(sim, inp, ap);
    }
    return { sim, ap };
}

/** Seeded pseudo-player: holds random actions for a few ticks, sometimes respawns. */
function randomInputs(seed, n) {
    const rng = new Rng(seed);
    const out = [];
    let cur = GAS, hold = 0;
    for (let i = 0; i < n; i++) {
        if (hold-- <= 0) {
            const steer = rng.chance(0.5) ? 0 : rng.int(2 * STEER_MAX + 1) - STEER_MAX;
            cur = { steer, gas: rng.chance(0.75), brake: rng.chance(0.15) };
            hold = 5 + rng.int(40);
        }
        out.push(rng.chance(0.002) ? { ...cur, respawn: true } : cur);
    }
    return out;
}

// ---------------------------------------------------------------------------
// Input

test('input helpers normalise, compare and map the discrete action table', () => {
    assert.deepEqual(makeInput(1e6, 1, 0), { steer: STEER_MAX, gas: true, brake: false });
    assert.deepEqual(makeInput(-12.6, false, true, true), { steer: -13, gas: false, brake: true, respawn: true });
    assert.deepEqual(clampInput({ steer: 'x' }), { steer: 0, gas: false, brake: false });
    assert.ok(inputsEqual(NEUTRAL, { steer: 0 }));
    assert.ok(!inputsEqual(GAS, { ...GAS, respawn: true }));
    assert.equal(digitalSteer(true, false), -STEER_MAX);
    assert.equal(digitalSteer(true, true), 0);
    assert.equal(analogSteer(0.05), 0);
    assert.equal(analogSteer(1), STEER_MAX);
    assert.equal(analogSteer(-1), -STEER_MAX);
    assert.ok(analogSteer(0.5) > 0 && analogSteer(0.5) < STEER_MAX);
    assert.equal(ACTIONS.length, 9);
    for (const a of ACTIONS) {
        assert.equal(inputToAction(actionToInput(a.index)), a.index, a.name);
        assert.ok(!(a.gas && a.brake));
    }
    assert.equal(ACTIONS[0].name, 'left+gas');
    assert.equal(ACTIONS[8].name, 'right+brake');
});

// ---------------------------------------------------------------------------
// Replays

test('input encoding round-trips and stays compact', () => {
    const inputs = randomInputs(42, 5000);
    inputs.push({ steer: 12345, gas: true, brake: true }, { steer: -1, gas: false, brake: false, respawn: true });
    const text = encodeInputs(inputs);
    const back = decodeInputs(text);
    assert.equal(back.length, inputs.length);
    for (let i = 0; i < inputs.length; i++) assert.ok(inputsEqual(back[i], clampInput(inputs[i])), `tick ${i}`);
    assert.equal(encodeInputs(back), text);
    assert.equal(encodeInputs([...Array(300).fill(GAS), ...Array(50).fill({ steer: STEER_MAX, gas: true })]), '1:B*8c.BR*1e');
    assert.deepEqual(decodeInputs('1:'), []);
    for (const bad of ['', 'B*3', '1:Z', '1:B*', '1:Bzzzzzz', '1:B!']) assert.throws(() => decodeInputs(bad), bad);
    info(`5002 random inputs -> ${text.length} chars`);
});

// ---------------------------------------------------------------------------
// Determinism

test('determinism: same inputs give identical states; savestates resume exactly', () => {
    const world = buildWorld(getSample('S03'));
    const inputs = randomInputs(7, 3000);
    const run = (from = null, upto = inputs.length) => {
        const sim = new Sim(world);
        let start = 0;
        if (from) { sim.setState(from.state); start = from.tick; }
        const hashes = [];
        for (let i = start; i < upto; i++) {
            sim.step(inputs[i]);
            if (sim.tick % 100 === 0) hashes.push(sim.stateHash());
        }
        return { sim, hashes };
    };
    const a = run(), b = run();
    assert.deepEqual(a.hashes, b.hashes);
    assert.equal(a.sim.stateHash(), b.sim.stateHash());

    // Savestate at tick 1234 through JSON, then continue.
    const head = run(null, 1234);
    const saved = JSON.parse(JSON.stringify(head.sim.getState()));
    assert.deepEqual(saved, head.sim.getState(), 'state survives a JSON round trip');
    const tail = run({ state: saved, tick: 1234 });
    assert.equal(tail.sim.stateHash(), a.sim.stateHash());
    assert.deepEqual(tail.sim.getState(), a.sim.getState());
    // Same thing on the same Sim instance (rewind).
    const sim = a.sim;
    sim.setState(saved);
    for (let i = 1234; i < inputs.length; i++) sim.step(inputs[i]);
    assert.equal(sim.stateHash(), b.sim.stateHash());
    // Nothing in the state is NaN, Infinity or a typed array.
    const walk = (v) => {
        if (typeof v === 'number') assert.ok(Number.isFinite(v));
        else if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === 'object') {
            assert.ok(Object.getPrototypeOf(v) === Object.prototype);
            Object.values(v).forEach(walk);
        }
    };
    walk(sim.getState());
    info(`3000 random ticks on S03: final hash ${a.sim.stateHash()}, respawns ${a.sim.respawns}`);
});

test('reset() returns to tick 0 exactly', () => {
    const world = buildWorld(getSample('S01'));
    const sim = new Sim(world);
    const h0 = sim.stateHash();
    for (const inp of randomInputs(3, 500)) sim.step(inp);
    sim.reset();
    assert.equal(sim.stateHash(), h0);
    assert.equal(sim.tick, 0);
    assert.equal(sim.timeMs, 0);
});

// ---------------------------------------------------------------------------
// Feel

test('feel metrics: acceleration, top speeds, braking, steering, grip', () => {
    const rows = [];
    const accel = (surface) => {
        const sim = new Sim(flatWorld({ surface, half: 8000 }));
        let t100 = 0, t200 = 0;
        while (sim.tick < 9000) {
            sim.step(GAS);
            if (!t100 && sim.car.speedKmh >= 100) t100 = sim.tick / 100;
            if (!t200 && sim.car.speedKmh >= 200) t200 = sim.tick / 100;
        }
        return { t100, t200, top: sim.car.speedKmh };
    };
    const snow = accel('snow');
    rows.push(['0-100 km/h (packed snow)', `${snow.t100.toFixed(2)} s`, '1.6-2.0 s']);
    rows.push(['0-200 km/h', `${snow.t200.toFixed(2)} s`, '5-6.5 s']);
    rows.push(['plateau (90 s full gas)', `${snow.top.toFixed(1)} km/h`, '280-310 km/h']);
    assert.ok(snow.t100 >= 1.6 && snow.t100 <= 2.0, `0-100 ${snow.t100}`);
    assert.ok(snow.t200 >= 5 && snow.t200 <= 6.5, `0-200 ${snow.t200}`);
    assert.ok(snow.top >= 280 && snow.top <= 310, `plateau ${snow.top}`);
    for (const s of ['powder', 'ice', 'ground']) {
        const r = accel(s);
        rows.push([`top speed on ${s}`, `${r.top.toFixed(1)} km/h`, s === 'ground' ? '~110 km/h' : '']);
        if (s === 'ground') assert.ok(r.top > 100 && r.top < 120, `deep snow top ${r.top}`);
    }

    // Braking 200 -> 0 and reverse.
    {
        const sim = new Sim(flatWorld({ half: 8000 }));
        while (sim.car.speedKmh < 200) sim.step(GAS);
        const t0 = sim.tick, z0 = sim.car.pos[2];
        while (sim.car.forwardSpeed > 0.1) sim.step({ steer: 0, gas: false, brake: true });
        const secs = (sim.tick - t0) / 100, dist = sim.car.pos[2] - z0;
        rows.push(['brake 200 -> 0', `${secs.toFixed(2)} s, ${dist.toFixed(0)} m`, '~2.5 s']);
        assert.ok(secs > 2.2 && secs < 2.8, `brake ${secs}`);
        for (let i = 0; i < 800; i++) sim.step({ steer: 0, gas: false, brake: true });
        const rev = -sim.car.forwardSpeed * KMH;
        rows.push(['reverse top speed', `${rev.toFixed(1)} km/h`, '<= 50 km/h']);
        assert.ok(rev > 40 && rev <= 50, `reverse ${rev}`);
    }

    // Steady circles at full lock: radius and lateral acceleration.
    const circle = (surface, targetKmh) => {
        const sim = new Sim(flatWorld({ surface, half: 8000 }));
        while (sim.car.speedKmh < targetKmh) sim.step(GAS);
        let turned = 0, prev = M.datan2(sim.car.vel[0], sim.car.vel[2]), t0 = 0;
        for (let i = 0; i < 700; i++) {
            sim.step({ steer: STEER_MAX, gas: sim.car.speedKmh < targetKmh, brake: false });
            const hd = M.datan2(sim.car.vel[0], sim.car.vel[2]);
            if (i === 400) { turned = 0; t0 = sim.tick; }
            turned += M.wrapAngle(hd - prev);
            prev = hd;
        }
        const rate = Math.abs(turned) / ((sim.tick - t0) / 100);
        return { radius: sim.car.speed / rate, lat: sim.car.speed * rate, slip: Math.abs(sim.car.slipAngle) / M.DEG, kmh: sim.car.speedKmh };
    };
    const walk = circle('snow', 5);
    rows.push(['full-lock radius at walking pace', `${walk.radius.toFixed(1)} m`, '~6 m']);
    assert.ok(walk.radius > 5 && walk.radius < 7, `walking radius ${walk.radius}`);
    const grip = {};
    for (const s of ['snow', 'powder', 'ice', 'ground']) {
        const c = circle(s, 100);
        grip[s] = c.lat;
        rows.push([`lateral grip at ${c.kmh.toFixed(0)} km/h on ${s}`, `${c.lat.toFixed(1)} m/s², slide ${c.slip.toFixed(0)}°`,
            { snow: '~30', powder: '~20', ice: '6-8 (+ big slides)', ground: '~12' }[s]]);
    }
    assert.ok(grip.snow > 27 && grip.snow < 36, `snow grip ${grip.snow}`);
    assert.ok(grip.powder > 17 && grip.powder < 25, `powder grip ${grip.powder}`);
    assert.ok(grip.ice > 5 && grip.ice < 12, `ice grip ${grip.ice}`);
    assert.ok(grip.ground > 10 && grip.ground < 15, `ground grip ${grip.ground}`);
    const fast = circle('snow', 250);
    rows.push(['lateral grip at 250 km/h on snow (downforce)', `${fast.lat.toFixed(1)} m/s²`, '']);
    rows.push(['gravity', `${GRAVITY} m/s²`, '18-22']);
    info('');
    for (const [k, v, t] of rows) info(`${k.padEnd(44)} ${v.padEnd(22)} ${t}`);
});

test('cornering speeds via the autopilot, loop entry speed, Bank3 flat out', () => {
    const rows = [];
    for (const n of [1, 2, 3]) {
        const world = pathWorld(['Start', 'Straight*10', `Turn${n}R`, 'Straight*4', 'Finish'], [40, 0, 1, 0]);
        const turn = world.blocks[11];
        let minV = Infinity;
        const { sim } = runAutopilot(world, {}, 6000, (s) => {
            const p = s.car.pos;
            if (p[2] >= turn.z * 32 && p[2] <= (turn.z + n) * 32 && p[0] >= turn.x * 32 && p[0] <= (turn.x + n) * 32) minV = Math.min(minV, s.car.speedKmh);
        });
        assert.ok(sim.finished && sim.respawns === 0, `Turn${n}`);
        rows.push([`Turn${n} (radius ${32 * n - 16} m) cornering speed`, `${minV.toFixed(0)} km/h`]);
    }

    // Loop: hold the wheel straight with full gas from the bottom of the circle.
    const loopWorld = pathWorld(['Start', 'Straight*8', 'Loop', 'Straight*3', 'Finish']);
    const circleZ = loopWorld.blocks[9].z * 32 + 32;
    // Success: over the top (y > 25 m) without ever leaving the deck, then on to the finish.
    const tryLoop = (entryKmh, gas = true) => {
        const ap = new Autopilot(loopWorld, { respawn: false, maxSpeed: entryKmh / KMH });
        const sim = new Sim(loopWorld);
        let bottom = 0, top = false, left = false;
        while (sim.tick < 4000 && !sim.finished && !left) {
            const inp = ap.act(sim);
            if (sim.car.pos[2] >= circleZ - 3) {
                if (!bottom) bottom = sim.car.speedKmh;
                inp.gas = gas; inp.brake = false; inp.steer = 0;
            }
            sim.step(inp);
            if (sim.car.pos[1] > 25) top = true;
            if (sim.car.pos[1] > 3 && sim.car.airborne) left = true;
        }
        return { ok: sim.finished && top && !left, bottom };
    };
    const threshold = (gas) => {
        let lo = 30, hi = 200;
        assert.ok(!tryLoop(lo, gas).ok, 'too slow falls off the top');
        for (let i = 0; i < 7; i++) {
            const mid = (lo + hi) / 2;
            if (tryLoop(mid, gas).ok) hi = mid; else lo = mid;
        }
        return tryLoop(hi, gas).bottom;
    };
    rows.push(['Loop: speed needed at the bottom, gas held, hands off', `${threshold(true).toFixed(0)} km/h`]);
    rows.push(['Loop: speed needed at the bottom, coasting, hands off', `${threshold(false).toFixed(0)} km/h`]);
    for (const k of [140, 200, 290]) assert.ok(tryLoop(k).ok, `loop at ${k}`);
    for (const k of [200, 290]) assert.ok(tryLoop(k, false).ok, `coasting loop at ${k}`);
    assert.ok(!tryLoop(120, false).ok, 'coasting at 120 km/h falls off the top');

    // Bank3 at plateau speed with the throttle pinned.
    const bankWorld = pathWorld(['Start', 'Straight*36', 'Bank3R', 'Straight*4', 'Finish'], [44, 0, 1, 0]);
    const bank = bankWorld.blocks[37];
    let entry = 0, minV = Infinity, walls = 0;
    const { sim } = runAutopilot(bankWorld, { fullThrottle: true }, 6000, (s) => {
        const p = s.car.pos;
        const inside = p[2] >= bank.z * 32 && p[2] <= (bank.z + 3) * 32 && p[0] >= bank.x * 32 - 2 && p[0] <= (bank.x + 3) * 32 + 2;
        if (inside && !entry) entry = s.car.speedKmh;
        if (inside) minV = Math.min(minV, s.car.speedKmh);
        walls += s.events.filter((e) => e.type === 'wallhit').length;
    });
    rows.push(['Bank3 flat out: entry / slowest in the bank', `${entry.toFixed(0)} / ${minV.toFixed(0)} km/h`]);
    assert.ok(sim.finished && sim.respawns === 0 && walls === 0, 'Bank3 flat out');
    assert.ok(entry > 270 && minV > entry - 15, `bank ${entry} ${minV}`);
    info('');
    for (const [k, v] of rows) info(`${k.padEnd(56)} ${v}`);
});

test('walls: glancing hits keep speed, head-on stops, resting is jitter-free', () => {
    const rows = [];
    for (const ang of [5, 15, 30, 45, 90]) {
        const sim = new Sim(flatWorld({ wallX: -10 }));
        const yaw = -ang * M.DEG;
        launch(sim, { pos: [-8.8 + 6 * M.dsin(ang * M.DEG), RIDE_HEIGHT, -2900], yaw, speed: 150 / KMH });
        let hit = 0, maxStep = 0, prevX = null;
        let after = 0;
        for (let i = 0; i < 300; i++) {
            sim.step({ steer: 0, gas: false, brake: false });
            for (const e of sim.events) if (e.type === 'wallhit') hit = Math.max(hit, e.intensity);
            if (i === 60) after = sim.car.speedKmh;
            if (i > 150) {
                if (prevX !== null) maxStep = Math.max(maxStep, Math.abs(sim.car.pos[0] - prevX));
                prevX = sim.car.pos[0];
            }
        }
        rows.push(`${String(ang).padStart(2)}°: impact ${hit.toFixed(1)} m/s, 0.6 s later ${after.toFixed(0)} km/h`);
        assert.ok(sim.car.pos[0] > -10, 'never through the wall');
        assert.ok(maxStep < 1e-3, `resting against the wall jitters (${maxStep})`);
        if (ang <= 15) assert.ok(after > 0.85 * 150 - 10, `glancing ${ang}° kept ${after}`);
        if (ang === 90) assert.ok(after < 10, `head-on kept ${after}`);
        assert.ok(hit > 0.8 * (150 / KMH) * M.dsin(ang * M.DEG) && hit < 1.2 * (150 / KMH) * M.dsin(ang * M.DEG) + 1, `intensity ${hit}`);
    }
    info(rows.join(' | '));
});

test('snowbanks: a hit bounces off or slides along, never climbs; pushing into one is calm', () => {
    const world = buildWorld(getSample('S01'));
    const sim = new Sim(world);
    const script = [[300, GAS], [60, { steer: STEER_MAX, gas: true, brake: false }], [200, GAS]];
    let maxY = 0, hits = 0;
    for (const [n, inp] of script) {
        for (let i = 0; i < n; i++) {
            sim.step(inp);
            if (sim.tick > 300) maxY = Math.max(maxY, sim.car.pos[1]);
            hits += sim.events.filter((e) => e.type === 'wallhit').length;
        }
    }
    assert.ok(hits > 0, 'hit the snowbank');
    assert.ok(maxY < 1.0, `climbed to ${maxY.toFixed(2)} m`);
    assert.ok(sim.car.speedKmh > 100, `kept speed (${sim.car.speedKmh.toFixed(0)} km/h)`);
    // Nose into the bank with the throttle held: the car settles, no shaking.
    for (let i = 0; i < 150; i++) sim.step({ steer: -STEER_MAX, gas: true, brake: false });
    let maxStep = 0;
    const prev = sim.car.pos.slice();
    for (let i = 0; i < 300; i++) {
        sim.step({ steer: -STEER_MAX, gas: true, brake: false });
        maxStep = Math.max(maxStep, M.vdist(prev, sim.car.pos) - sim.car.speed * 0.01);
        M.vcopy(prev, sim.car.pos);
    }
    assert.ok(sim.car.pos[1] < 1.0 && maxStep < 0.05, `y ${sim.car.pos[1].toFixed(2)}, jitter ${maxStep.toFixed(3)}`);
});

test('drift: brake tap while steering drifts, steering holds it, letting go realigns', () => {
    const sim = new Sim(flatWorld({ half: 8000 }));
    while (sim.car.speedKmh < 150) sim.step(GAS);
    for (let i = 0; i < 12; i++) sim.step({ steer: STEER_MAX, gas: false, brake: true });
    assert.ok(sim.car.drifting, 'drifting after the tap');
    const v0 = sim.car.speedKmh;
    for (let i = 0; i < 100; i++) sim.step({ steer: STEER_MAX, gas: true, brake: false });
    assert.ok(sim.car.drifting, 'drift held while steering');
    const slip = sim.car.slipAngle / M.DEG;
    assert.ok(slip > 15 && slip < 35, `drift angle ${slip}`);
    const loss = v0 - sim.car.speedKmh;
    assert.ok(loss > 0 && loss < 25, `speed lost in 1 s of full-lock drift: ${loss}`);
    for (let i = 0; i < 60; i++) sim.step(GAS);
    assert.ok(!sim.car.drifting && Math.abs(sim.car.slipAngle) < 2 * M.DEG, 'realigned');
    // Holding the brake into a corner is trail braking, not a drift.
    const s2 = new Sim(flatWorld({ half: 8000 }));
    while (s2.car.speedKmh < 150) s2.step(GAS);
    for (let i = 0; i < 30; i++) s2.step({ steer: 0, gas: false, brake: true });
    for (let i = 0; i < 30; i++) s2.step({ steer: STEER_MAX, gas: false, brake: true });
    assert.ok(!s2.car.drifting, 'trail braking does not drift');
    // Ice never brake-drifts (it slides anyway).
    const s3 = new Sim(flatWorld({ surface: 'ice', half: 8000 }));
    while (s3.car.speedKmh < 120) s3.step(GAS);
    for (let i = 0; i < 12; i++) s3.step({ steer: STEER_MAX, gas: false, brake: true });
    assert.ok(!s3.car.drifting);
    info(`full-lock drift: ${slip.toFixed(0)}° slip, ${loss.toFixed(0)} km/h lost in 1 s with gas`);
});

test('landings: wheels down, nose-first loses speed, events carry the impact', () => {
    const land = (pitchDeg) => {
        const sim = new Sim(flatWorld({}));
        launch(sim, { pos: [0, 4, -2800], quat: M.qfromAxisAngle([0, 0, 0, 1], [1, 0, 0], -pitchDeg * M.DEG) });
        const st = sim.getState();
        st.car.vel = [0, 0, 40];
        st.car.airTicks = 50;
        sim.setState(st);
        let strength = 0;
        for (let i = 0; i < 150; i++) {
            sim.step(NEUTRAL);
            for (const e of sim.events) if (e.type === 'land') strength = Math.max(strength, e.strength);
        }
        const up = M.qup([0, 0, 0], sim.car.quat);
        return { strength, v: sim.car.forwardSpeed, up: up[1] };
    };
    const flat = land(0), nose = land(-40);
    assert.ok(flat.strength > 8 && flat.strength < 14, `impact ${flat.strength}`);
    assert.ok(flat.up > 0.99 && nose.up > 0.99, 'back on the wheels');
    assert.ok(nose.v < flat.v - 3, `nose first ${kmh(nose.v)} vs flat ${kmh(flat.v)} km/h`);
    info(`after a 4 m drop at 144 km/h: flat ${kmh(flat.v)} km/h, nose-first (40°) ${kmh(nose.v)} km/h, impact ${flat.strength.toFixed(1)} m/s`);
});

// ---------------------------------------------------------------------------
// Effects and triggers

/** Flat world with effect pads at the given z ranges along x = 0 (car drives +Z). */
function padWorld(pads, surface = 'snow') {
    const w = flatWorld({ surface, half: 8000 });
    for (const [effect, z0, z1] of pads) {
        addTrigger(w, { type: 'effect', effect, min: [-12, -1, z0], max: [12, 4, z1] });
    }
    return w;
}

test('effects: turbo, engine/steer/brake freezes, slow motion, cruise, fragile, reset', () => {
    const z0 = -7900;
    const speedAfter = (pads, ticks, input = GAS, setup = null) => {
        const sim = new Sim(padWorld(pads));
        if (setup) setup(sim);
        for (let i = 0; i < ticks; i++) sim.step(input);
        return sim;
    };
    // Turbo: extra push decaying over 2 s; the Avalanche Boost is stronger.
    const base = speedAfter([], 200).car.speedKmh;
    const t1 = speedAfter([['turbo', z0 + 3, z0 + 5]], 200);
    const t2 = speedAfter([['turbo2', z0 + 3, z0 + 5]], 200);
    assert.ok(t1.car.speedKmh > base + 25 && t2.car.speedKmh > t1.car.speedKmh + 25, `turbo ${base} ${t1.car.speedKmh} ${t2.car.speedKmh}`);
    info(`2 s of full gas from a standstill: ${base.toFixed(0)} km/h, Frost Boost ${t1.car.speedKmh.toFixed(0)}, Avalanche Boost ${t2.car.speedKmh.toFixed(0)}`);
    assert.ok(t1.car.effects.turbo === 1 && t1.car.effects.turboTime > 0);
    for (let i = 0; i < 100; i++) t1.step(GAS);
    assert.equal(t1.car.effects.turbo, 0, 'the boost runs out after 2 s');

    // Frozen engine until a Thaw (reset) pad; the brakes still work.
    {
        const sim = new Sim(padWorld([['noEngine', z0 + 40, z0 + 60], ['reset', z0 + 300, z0 + 320]]));
        launch(sim, { pos: [0, RIDE_HEIGHT, z0 + 30], speed: 30 });
        let v = 0, events = [];
        for (let i = 0; i < 100; i++) { sim.step(GAS); events.push(...sim.events.map((e) => e.type)); }
        assert.ok(sim.car.effects.noEngine && events.includes('effect'));
        v = sim.car.speed;
        for (let i = 0; i < 100; i++) sim.step(GAS);
        assert.ok(sim.car.speed < v, 'coasting without an engine');
        while (sim.car.pos[2] < z0 + 330 && sim.tick < 3000) sim.step(GAS);
        assert.ok(!sim.car.effects.noEngine, 'thawed');
        v = sim.car.speed;
        for (let i = 0; i < 50; i++) sim.step(GAS);
        assert.ok(sim.car.speed > v, 'engine back');
    }
    // Frozen wheel ignores steering; brake freeze ignores the brake.
    {
        const sim = new Sim(padWorld([['noSteer', z0 + 1, z0 + 3]]));
        for (let i = 0; i < 60; i++) sim.step(GAS);
        assert.ok(sim.car.effects.noSteer);
        for (let i = 0; i < 150; i++) sim.step({ steer: STEER_MAX, gas: true, brake: false });
        assert.ok(Math.abs(sim.car.pos[0]) < 1e-6, `went straight (${sim.car.pos[0]})`);
        const nb = new Sim(padWorld([['noBrake', z0 + 1, z0 + 3]]));
        launch(nb, { pos: [0, RIDE_HEIGHT, z0 - 1], speed: 30 });
        for (let i = 0; i < 100; i++) nb.step({ steer: 0, gas: false, brake: true });
        assert.ok(nb.car.effects.noBrake);
        assert.ok(nb.car.forwardSpeed > 25, `brakes frozen: ${nb.car.forwardSpeed}`);
    }
    // Snow globes stack 1 -> 0.85 -> 0.7 -> 0.55 and stop there.
    {
        const pads = [0, 1, 2, 3].map((k) => ['slowmo', z0 + 20 + 40 * k, z0 + 30 + 40 * k]);
        const sim = new Sim(padWorld(pads));
        launch(sim, { pos: [0, RIDE_HEIGHT, z0], speed: 40 });
        const scales = [];
        for (let i = 0; i < 600; i++) {
            sim.step(GAS);
            if (sim.events.some((e) => e.type === 'effect')) scales.push(sim.car.tickDt() / 0.01);
        }
        assert.deepEqual(scales.map((x) => +x.toFixed(2)), [0.85, 0.7, 0.55, 0.55]);
        assert.deepEqual(SLOWMO_SCALES, [1, 0.85, 0.7, 0.55]);
    }
    // Glide holds the speed it was entered with, ignoring gas and brake but not steering.
    {
        const sim = new Sim(padWorld([['cruise', z0 + 20, z0 + 30]]));
        launch(sim, { pos: [0, RIDE_HEIGHT, z0], speed: 25 });
        for (let i = 0; i < 120; i++) sim.step(NEUTRAL);
        const held = sim.car.effects.cruiseSpeed;
        assert.ok(sim.car.effects.cruise && held > 20);
        for (let i = 0; i < 150; i++) sim.step({ steer: 0, gas: false, brake: true });
        assert.ok(Math.abs(sim.car.forwardSpeed - held) < 0.5, 'brake ignored');
        for (let i = 0; i < 150; i++) sim.step({ steer: STEER_MAX, gas: true, brake: false });
        assert.ok(Math.abs(sim.car.speed - held) < 1.5 && sim.car.pos[0] < -5, 'steers at the held speed');
    }
    // Thin ice: a hard wall hit breaks the car (engine off) until a respawn.
    {
        const w = flatWorld({ wallX: -10 });
        addTrigger(w, { type: 'effect', effect: 'fragile', min: [-12, -1, -2899], max: [12, 4, -2895] });
        const sim = new Sim(w);
        launch(sim, { pos: [0, RIDE_HEIGHT, -2900], yaw: -45 * M.DEG, speed: 30 });
        let broke = false;
        for (let i = 0; i < 100; i++) {
            sim.step({ steer: 0, gas: true, brake: false });
            if (sim.events.some((e) => e.type === 'fragileBreak')) broke = true;
        }
        assert.ok(sim.car.effects.fragile && broke && sim.car.effects.broken);
        sim.step({ ...GAS, respawn: true });
        assert.ok(!sim.car.effects.broken, 'respawn repairs the car');
    }
    // Thaw clears everything.
    {
        const sim = new Sim(padWorld([['noSteer', z0 + 10, z0 + 12], ['slowmo', z0 + 20, z0 + 22], ['fragile', z0 + 30, z0 + 32], ['reset', z0 + 60, z0 + 62]]));
        launch(sim, { pos: [0, RIDE_HEIGHT, z0], speed: 30 });
        const e = sim.car.effects;
        while (sim.car.pos[2] < z0 + 50) sim.step(GAS);
        assert.ok(e.noSteer && e.slowmo === 1 && e.fragile, 'effects active');
        while (sim.car.pos[2] < z0 + 70) sim.step(GAS);
        assert.ok(!e.noSteer && e.slowmo === 0 && !e.fragile && !e.turbo && !e.cruise, 'all thawed');
    }
});

test('a pad fires once per entry; triggers are swept so 1000 km/h never skips them', () => {
    const w = flatWorld({ half: 8000, wallX: null });
    const cp = addTrigger(w, { type: 'checkpoint', min: [-14, -1, -6000], max: [14, 10, -5999.9] });
    addTrigger(w, { type: 'effect', effect: 'turbo', min: [-12, -1, -5000], max: [12, 4, -4999.9] });
    const sim = new Sim(w);
    launch(sim, { pos: [0, RIDE_HEIGHT, -6010], speed: 1000 / KMH });
    const seen = [];
    for (let i = 0; i < 500; i++) {
        sim.step(GAS);
        for (const e of sim.events) seen.push(`${e.type}@${e.tick}`);
    }
    assert.ok(seen.includes('checkpoint@4') && seen.some((x) => x.startsWith('boost@')), seen.join(' '));
    assert.equal(sim.collected[cp.id], 1);
    // The hard cap.
    const cap = new Sim(flatWorld({ half: 8000 }));
    launch(cap, { pos: [0, RIDE_HEIGHT, -7000], speed: 2000 / KMH });
    cap.step(GAS);
    assert.ok(cap.car.speedKmh <= 1000 + 1e-9 && cap.car.speedKmh > 990, `cap ${cap.car.speedKmh}`);
    // Resting on a pad does not refire; leaving and coming back does.
    const pw = padWorld([['turbo', -7900, -7880]]);
    const ps = new Sim(pw);
    launch(ps, { pos: [0, RIDE_HEIGHT, -7890] });
    let boosts = 0;
    for (let i = 0; i < 100; i++) { ps.step(NEUTRAL); boosts += ps.events.filter((e) => e.type === 'boost').length; }
    assert.equal(boosts, 0, 'spawned inside: nothing fires');
    launch(ps, { pos: [0, RIDE_HEIGHT, -7920], speed: 20 });
    for (let i = 0; i < 300; i++) { ps.step(GAS); boosts += ps.events.filter((e) => e.type === 'boost').length; }
    assert.equal(boosts, 1);
    // No tunnelling: a thin wall stops the car even at 1000 km/h.
    const ww = flatWorld({ wallX: -10 });
    const ws = new Sim(ww);
    launch(ws, { pos: [20, RIDE_HEIGHT, -2900], yaw: -M.HALF_PI, speed: 1000 / KMH });
    for (let i = 0; i < 50; i++) ws.step(NEUTRAL);
    assert.ok(ws.car.pos[0] > -10, `stayed on its side of the wall (x ${ws.car.pos[0].toFixed(2)})`);
});

// ---------------------------------------------------------------------------
// Race rules

test('race rules: checkpoints in any order, finish timing, respawns, falls', () => {
    // Two checkpoints behind each other then a finish line; a second finish line before them.
    const w = flatWorld({ half: 8000 });
    addTrigger(w, { type: 'finish', min: [-14, -1, -7880], max: [14, 10, -7876] });
    addTrigger(w, { type: 'checkpoint', min: [-14, -1, -7800], max: [14, 10, -7796] });
    addTrigger(w, { type: 'checkpoint', min: [-14, -1, -7700], max: [14, 10, -7696] });
    const sim = new Sim(w);
    let events = [];
    const drive = (n, inp = GAS) => {
        for (let i = 0; i < n; i++) { sim.step(inp); events.push(...sim.events); }
    };
    // Crossing the finish without checkpoints does not finish.
    drive(300);
    assert.ok(events.some((e) => e.type === 'missingCheckpoints' && e.missing === 2));
    assert.ok(!sim.finished);
    // Checkpoints, then come back through the finish line (reverse direction counts).
    drive(400);
    assert.equal(sim.collectedCount, 2);
    assert.equal(sim.checkpointTimes.length, 2);
    // Respawn: same position and speed as when the last checkpoint was crossed.
    const cpEvent = events.filter((e) => e.type === 'checkpoint').pop();
    const before = sim.tick;
    sim.step({ ...NEUTRAL, respawn: true });
    assert.equal(sim.respawns, 1);
    assert.equal(sim.tick, before + 1, 'race time keeps running');
    assert.ok(Math.abs(sim.car.pos[2] - (-7700)) < 6 && sim.car.speedKmh > 100, `respawned at the checkpoint ${sim.car.pos[2]} ${sim.car.speedKmh}`);
    assert.ok(cpEvent.timeMs > 0);
    // Turn around and finish: finish time = tick of the crossing × 10 ms, then the clock stops.
    const turn = new Sim(w);
    turn.setState(sim.getState());
    events = [];
    const st = turn.getState();
    st.car.quat = M.qfromYaw([0, 0, 0, 1], M.PI);
    st.car.vel = [0, 0, -40];
    turn.setState(st);
    let finishTick = 0;
    for (let i = 0; i < 600 && !finishTick; i++) {
        turn.step(GAS);
        if (turn.events.some((e) => e.type === 'finish')) finishTick = turn.tick;
    }
    assert.ok(turn.finished && turn.finishTimeMs === finishTick * TICK_MS);
    const t = turn.timeMs;
    for (let i = 0; i < 100; i++) turn.step({ ...GAS, respawn: true });
    assert.equal(turn.timeMs, t, 'timer stopped');
    assert.ok(turn.tick === finishTick + 100, 'sim keeps running');

    // Respawn before any checkpoint: back to the start, standing still.
    const fresh = new Sim(w);
    for (let i = 0; i < 100; i++) fresh.step(GAS);
    fresh.step({ ...NEUTRAL, respawn: true });
    assert.ok(fresh.car.speed < 0.5 && Math.abs(fresh.car.pos[2] - w.spawn.pos[2]) < 0.5 && fresh.tick === 101);
    // Falling below fallY emits 'fall' once.
    const drop = new Sim(w);
    launch(drop, { pos: [9000, 0, 0] });
    let falls = 0;
    for (let i = 0; i < 400; i++) { drop.step(NEUTRAL); falls += drop.events.filter((e) => e.type === 'fall').length; }
    assert.equal(falls, 1);
});

test('laps: StartFinish counts laps after every checkpoint (S06, 3 laps)', () => {
    const world = buildWorld(getSample('S06'));
    const laps = [];
    const { sim } = runAutopilot(world, {}, 20000, (s) => {
        for (const e of s.events) if (e.type === 'lap' || e.type === 'finish') laps.push(e);
    });
    assert.ok(sim.finished);
    assert.equal(laps.length, 3);
    assert.equal(sim.lapTimes.length, 3);
    assert.equal(sim.lapTimes.reduce((a, b) => a + b, 0), sim.finishTimeMs);
    assert.equal(sim.checkpointTimes.length, 3 * world.checkpointCount);
    info(`laps ${sim.lapTimes.join(' / ')} ms`);
});

// ---------------------------------------------------------------------------
// Replays and the autopilot

test('replay: recorded autopilot run verifies, resimulates and samples ghosts', () => {
    const world = buildWorld(getSample('S03'));
    const rec = new Recorder();
    const { sim } = runAutopilot(world, {}, 20000, (s, inp) => rec.push(inp));
    assert.ok(sim.finished);
    const replay = rec.toReplay({ world, timeMs: sim.finishTimeMs, finished: true, name: 'pilot', date: '2026-01-01' });
    assert.equal(replay.trackHash, world.hash);
    assert.deepEqual(JSON.parse(JSON.stringify(replay)), replay);
    assert.deepEqual(verifyReplay(world, replay), { ok: true, reason: null, finished: true, timeMs: sim.finishTimeMs, respawns: sim.respawns });
    const res = simulateReplay(world, replay, { sampleEvery: 10 });
    assert.equal(res.timeMs, sim.finishTimeMs);
    assert.ok(res.samples.length >= sim.tick / 10);
    const pose = ghostPoseAt(res.samples, 1234.5);
    assert.ok(pose && Number.isFinite(pose.pos[0]));
    assert.equal(verifyReplay(world, { ...replay, timeMs: replay.timeMs - 10 }).ok, false);
    assert.equal(verifyReplay(buildWorld(getSample('S01')), replay).ok, false);
    // Respawns recorded as flags reproduce exactly.
    const inputs = randomInputs(11, 2000);
    const live = new Sim(world);
    const r2 = new Recorder();
    for (const inp of inputs) { live.step(inp); r2.push(inp); }
    const again = simulateReplay(world, r2.toReplay({ world }), { sampleEvery: 0, stopAtFinish: false });
    assert.equal(again.sim.stateHash(), live.stateHash());
    assert.deepEqual(r2.respawnTicks(), inputs.flatMap((x, i) => (x.respawn ? [i] : [])));
    info(`S03 replay: ${replay.inputs.length} chars for ${replay.ticks} ticks`);
});

test('autopilot finishes every sample track', () => {
    const rows = [];
    for (const track of getSamples()) {
        const world = buildWorld(track);
        const t0 = performance.now();
        const { sim, ap } = runAutopilot(world, {}, 30000);
        assert.ok(sim.finished, `${track.id} not finished`);
        rows.push(`${track.id} ${(sim.finishTimeMs / 1000).toFixed(2)} s (${ap.respawnCount} respawns, ${(performance.now() - t0).toFixed(0)} ms)`);
    }
    info(rows.join(' | '));
});

test('autopilot savestates resume the same drive', () => {
    const world = buildWorld(getSample('S02'));
    const a = runAutopilot(world, {}, 20000);
    const ap = new Autopilot(world);
    const sim = new Sim(world);
    for (let i = 0; i < 900; i++) sim.step(ap.act(sim));
    const saved = JSON.parse(JSON.stringify({ sim: sim.getState(), ap: ap.getState() }));
    const ap2 = new Autopilot(world);
    const sim2 = new Sim(world);
    sim2.setState(saved.sim);
    ap2.setState(saved.ap);
    while (!sim2.finished && sim2.tick < 20000) sim2.step(ap2.act(sim2));
    assert.equal(sim2.finishTimeMs, a.sim.finishTimeMs);
    assert.equal(sim2.stateHash(), a.sim.stateHash());
});

test('performance: Sim.step ticks per second', () => {
    const world = buildWorld(getSample('S03'));
    const inputs = [];
    runAutopilot(world, {}, 20000, (s, inp) => inputs.push(inp));
    const sim = new Sim(world);
    for (const inp of inputs) sim.step(inp);   // warm up
    let ticks = 0;
    const t0 = performance.now();
    while (performance.now() - t0 < 600) {
        sim.reset();
        for (const inp of inputs) sim.step(inp);
        ticks += inputs.length;
    }
    const rate = ticks / ((performance.now() - t0) / 1000);
    const pilot = new Autopilot(world);
    const s2 = new Sim(world);
    const t1 = performance.now();
    while (!s2.finished) s2.step(pilot.act(s2));
    const pRate = s2.tick / ((performance.now() - t1) / 1000);
    info(`Sim.step on S03: ${Math.round(rate).toLocaleString('en')} ticks/s; with the autopilot: ${Math.round(pRate).toLocaleString('en')} ticks/s`);
    assert.ok(rate > 25000, `too slow: ${rate}`);
});

test('state hash helper is stable', () => {
    const sim = new Sim(buildWorld(getSample('S01')));
    assert.equal(hashState(sim.getState()), sim.stateHash());
    assert.match(sim.stateHash(), /^[0-9a-f]{16}$/);
});
