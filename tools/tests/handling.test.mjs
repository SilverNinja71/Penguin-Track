// Physics 2 (Trackmania-style handling) and the physics version that keeps
// every older run on the rules it was recorded with (js/core car/sim/replay).
import assert from 'node:assert/strict';
import { test, info } from './_harness.mjs';
import { STEER_MAX } from '../../js/core/constants.js';
import * as M from '../../js/core/mathd.js';
import { CollisionMesh } from '../../js/core/collision.js';
import { buildWorld } from '../../js/core/track.js';
import { Sim, hashState, canonicalState, CHECKPOINT_AIR_HEIGHT } from '../../js/core/sim.js';
import { CAR, MAX_SPEED, PHYSICS_LEGACY, PHYSICS_LATEST } from '../../js/core/car.js';
import { Recorder, simulateReplay, verifyReplay, replayPhysics } from '../../js/core/replay.js';
import { Autopilot } from '../../js/core/autopilot.js';
import * as levels from '../../js/levels/index.js';
import { BAKED } from '../../js/levels/baked.js';
import { flatWorld, addTrigger } from '../lib/testworlds.mjs';

const GAS = { steer: 0, gas: true, brake: false };
const steerIn = (s, gas = true, brake = false) => ({ steer: Math.round(STEER_MAX * s), gas, brake });
const yawOfVel = (c) => -Math.atan2(c.vel[0], c.vel[2]) / M.DEG;

function upTo(sim, kmh) {
    while (sim.car.speedKmh < kmh) sim.step(GAS);
}

/** Accelerates to `kmh`, taps the brake with full right lock, returns whether it drifts. */
function tapAt(physics, kmh, world = flatWorld({ half: 8000 })) {
    const sim = new Sim(world, { physics });
    upTo(sim, kmh);
    for (let i = 0; i < 10; i++) sim.step(steerIn(1, false, true));
    return sim;
}

test('physics: Sims default to physics 1, replays and states only carry newer versions', () => {
    const w = flatWorld();
    assert.equal(new Sim(w).physics, PHYSICS_LEGACY);
    assert.equal(new Sim(w, { physics: 2 }).car.physics, 2);
    assert.throws(() => new Sim(w, { physics: 3 }), /Unknown physics version 3/);
    const s1 = new Sim(w), s2 = new Sim(w, { physics: PHYSICS_LATEST });
    assert.ok(!('physics' in s1.getState()), 'physics 1 states keep their old shape (and hashes)');
    assert.equal(s2.getState().physics, PHYSICS_LATEST);
    const rec = new Recorder();
    s1.step(GAS); rec.push(s1.lastInput);
    assert.ok(!('physics' in rec.toReplay({ sim: s1 })), 'physics 1 replays are byte-identical to before');
    assert.equal(rec.toReplay({ sim: s2 }).physics, PHYSICS_LATEST);
    assert.equal(replayPhysics({}), 1);
    // A state never moves between rule sets.
    assert.throws(() => s1.setState(s2.getState()), /saved with physics 2/);
    assert.throws(() => s2.setState(s1.getState()), /saved with physics 1/);
    // Unknown versions fail verification instead of simulating with the wrong rules.
    const bad = verifyReplay({ ...w, hash: 'h' }, { trackHash: 'h', inputs: '1:B', physics: 9 });
    assert.ok(!bad.ok && /physics 9/.test(bad.reason), bad.reason);
});

test('physics: without the brake, physics 2 drives bit-identically to physics 1', () => {
    const a = new Sim(flatWorld({ half: 8000, wallX: -30 })), b = new Sim(flatWorld({ half: 8000, wallX: -30 }), { physics: 2 });
    const script = [[250, GAS], [80, steerIn(1)], [60, steerIn(-0.4)], [120, steerIn(-1)], [200, steerIn(0.2, false)]];
    for (const [n, inp] of script) for (let i = 0; i < n; i++) { a.step(inp); b.step(inp); }
    assert.equal(JSON.stringify(a.car.getState()), JSON.stringify(b.car.getState()));
});

test('drift (physics 2): a brake tap while steering drifts from 40 km/h', () => {
    assert.ok(tapAt(2, 45).car.drifting, 'drifts at 45 km/h');
    assert.ok(!tapAt(2, 37).car.drifting, 'not below 40 km/h');
    assert.ok(!tapAt(1, 45).car.drifting, 'physics 1 still needs 70 km/h');
    assert.ok(tapAt(1, 80).car.drifting && tapAt(2, 80).car.drifting);
    assert.ok(!tapAt(2, 60, flatWorld({ surface: 'ice', half: 8000 })).car.drifting, 'ice never brake-drifts');
    // Holding the brake into the corner is still trail braking.
    const sim = new Sim(flatWorld({ half: 8000 }), { physics: 2 });
    upTo(sim, 100);
    for (let i = 0; i < 30; i++) sim.step({ steer: 0, gas: false, brake: true });
    for (let i = 0; i < 30; i++) sim.step(steerIn(1, false, true));
    assert.ok(!sim.car.drifting, 'trail braking does not drift');
});

test('drift (physics 2): the slide breaks loose, then grips; counter-steer catches it', () => {
    // The velocity lags the heading right after the tap (low grip), then grip comes back.
    const sim = tapAt(2, 150);
    let early = 0;
    for (let i = 0; i < 15; i++) { sim.step(steerIn(1)); early = Math.max(early, sim.car.slipAngle / M.DEG); }
    assert.ok(sim.car.drifting && early > 10, `slip ${early.toFixed(1)}° after the tap`);
    // Counter-steer keeps the drift alive (physics 1 would drop it) and settles it without a spin.
    sim.step(steerIn(-1));
    assert.ok(sim.car.drifting, 'still drifting while counter-steering');
    let maxYaw = 0, ticks = 0;
    while (sim.car.drifting && ticks < 200) {
        sim.step(steerIn(-1));
        maxYaw = Math.max(maxYaw, Math.abs(sim.car.angVel[1]));
        ticks++;
    }
    assert.ok(!sim.car.drifting && ticks < 100, `settled after ${ticks} ticks`);
    assert.ok(maxYaw < 2, `yaw rate stayed ${maxYaw.toFixed(2)} rad/s`);
    // A full-lock drift turns tighter than grip driving at the same speed.
    const turn = (drift) => {
        const s = new Sim(flatWorld({ half: 8000 }), { physics: 2 });
        upTo(s, 180);
        const y0 = yawOfVel(s.car);
        for (let i = 0; i < 150; i++) s.step(drift && i < 10 ? steerIn(1, false, true) : steerIn(1));
        return yawOfVel(s.car) - y0;
    };
    const grip = turn(false), drift = turn(true);
    assert.ok(drift > grip + 3, `drift turned ${drift.toFixed(0)}°, grip ${grip.toFixed(0)}° in 1.5 s`);
    info(`180 km/h, 1.5 s: drift ${drift.toFixed(0)}° vs grip ${grip.toFixed(0)}°; counter-steer settled in ${ticks} ticks`);
});

test('speed drift (physics 2): 16°-24° at speed keeps its speed, wider angles scrub', () => {
    const hold = (physics, steer) => {
        const sim = tapAt(physics, 180);
        const v0 = sim.car.speedKmh;
        let band = 0;
        for (let i = 0; i < 140; i++) {
            sim.step(steerIn(steer));
            if (sim.car.speedDrift) {
                band++;
                const a = sim.car.slipAngle;
                assert.ok(a >= CAR.speedDriftMin && a <= CAR.speedDriftMax, 'flag only inside the band');
            }
        }
        return { gain: sim.car.speedKmh - v0, band, drifting: sim.car.drifting };
    };
    const inBand = hold(2, 0.5), wide = hold(2, 1), old = hold(1, 0.5);
    assert.ok(inBand.drifting && inBand.band > 100, `in the band for ${inBand.band} ticks`);
    assert.ok(inBand.gain > 15, `speed drift gained ${inBand.gain.toFixed(1)} km/h`);
    assert.ok(wide.gain < 0 && wide.band < 50, `full lock (~27°) lost ${(-wide.gain).toFixed(1)} km/h`);
    assert.ok(old.band === 0 && old.gain < inBand.gain - 20, `physics 1 scrubs: ${old.gain.toFixed(1)} km/h`);
    // Too slow for a speed drift: same angle, no flag.
    const slow = tapAt(2, 80);
    for (let i = 0; i < 60; i++) { slow.step(steerIn(0.5)); assert.ok(!slow.car.speedDrift); }
    info(`1.4 s at half lock from 180 km/h: speed drift +${inBand.gain.toFixed(1)}, full lock ${wide.gain.toFixed(1)}, physics 1 ${old.gain.toFixed(1)} km/h`);
});

/** A field tilted `deg` around X (descending toward +Z). */
function slopeWorld(deg) {
    const w = flatWorld({ half: 3000 });
    const half = 3000, t = M.dtan(deg * M.DEG), y = (z) => -z * t;
    const tris = [[-half, y(-half), -half], [-half, y(half), half], [half, y(half), half], [-half, y(-half), -half], [half, y(half), half], [half, y(-half), -half]];
    const positions = new Float64Array(18);
    tris.forEach((p, i) => positions.set(p, i * 3));
    w.collision = new CollisionMesh(positions, Uint8Array.from([0, 0]), {});
    w.fallY = -1e9;
    return w;
}

/** Drops a pitched and rolled car from `height`; returns its tilt to the ground at touchdown and the bounces after. */
function drop(world, physics, brake, pitchDeg, rollDeg, height = 14) {
    const sim = new Sim(world, { physics });
    const st = sim.getState();
    const qp = [M.dsin(pitchDeg * M.DEG / 2), 0, 0, M.dcos(pitchDeg * M.DEG / 2)];
    const qr = [0, 0, M.dsin(rollDeg * M.DEG / 2), M.dcos(rollDeg * M.DEG / 2)];
    st.car.quat = M.qmul([0, 0, 0, 1], qp, qr);
    const gy = world.collision.raycast([0, 1000, 0], [0, -1, 0], 5000).point[1];
    Object.assign(st.car, { pos: [0, gy + height, 0], vel: [0, 4, 40], angVel: [0, 0, 0], airTicks: 30, comp: [0, 0, 0, 0], wc: [false, false, false, false] });
    sim.setState(st);
    let touched = -1, flips = 0, wasAir = true, tilt = 0, braking = false;
    for (let i = 0; i < 400; i++) {
        sim.step({ steer: 0, gas: false, brake: brake && (touched < 0 || i - touched < 2) });
        if (sim.car.airBraking) braking = true;
        const air = sim.car.airborne;
        if (touched < 0 && !air) {
            touched = i;
            const up = M.qrotate([0, 0, 0], sim.car.quat, [0, 1, 0]);
            const n = world.collision.raycast(sim.car.pos, [0, -1, 0], 50).normal;
            tilt = Math.acos(Math.min(1, M.vdot(up, n))) / M.DEG;
        } else if (touched >= 0 && air !== wasAir) {
            flips++;
        }
        wasAir = air;
    }
    return { tilt, flips, braking };
}

test('air-brake (physics 2): brake in the air levels pitch and roll to the ground, no bounce', () => {
    const flat = flatWorld({ half: 3000 });
    const off = drop(flat, 2, false, -25, 15), on = drop(flat, 2, true, -25, 15), old = drop(flat, 1, true, -25, 15);
    assert.ok(off.tilt > 10, `no brake: lands ${off.tilt.toFixed(1)}° off`);
    assert.ok(on.braking && on.tilt < 1, `air-brake: lands ${on.tilt.toFixed(2)}° off`);
    assert.equal(on.flips, 0, 'no bounce after an air-braked landing');
    assert.ok(!old.braking && old.tilt > 10, 'physics 1 ignores the brake in the air');
    // On a downhill landing the car matches the slope, not the horizon.
    const slope = slopeWorld(15);
    const s = drop(slope, 2, true, 10, -10, 16);
    assert.ok(s.tilt < 1 && s.flips === 0, `15° slope: ${s.tilt.toFixed(2)}° off, ${s.flips} bounces`);
    info(`tilt at touchdown: ${off.tilt.toFixed(1)}° without, ${on.tilt.toFixed(2)}° with the air-brake (slope ${s.tilt.toFixed(2)}°)`);
});

/** Flat field with one checkpoint gate (28 m wide, trigger 8 m tall, 4 m deep) at z = zc on a deck at y. */
function gateWorld(y = 0, zc = -2700) {
    const w = flatWorld({ half: 3000, y });
    addTrigger(w, { type: 'checkpoint', min: [-14, -1, zc - 2], max: [14, 7, zc + 2] });
    return w;
}

/** Launches the car at height `y` (+ deck) flying at `speed` m/s along +Z; returns the checkpoint events. */
function flyOver(world, physics, y, speed = 60, ticks = 300) {
    const sim = new Sim(world, { physics });
    const st = sim.getState();
    Object.assign(st.car, { pos: [0, y, -2730], vel: [0, 2, speed], airTicks: 40, comp: [0, 0, 0, 0], wc: [false, false, false, false] });
    sim.setState(st);
    const got = [];
    for (let i = 0; i < ticks && !got.length; i++) {
        sim.step(GAS);
        for (const e of sim.events) if (e.type === 'checkpoint') got.push({ ...e, air: sim.car.airborne });
    }
    return got;
}

test('checkpoints (physics 2): flying over the gate on a shortcut counts, the gate stays put', () => {
    const top = 7;   // gateWorld trigger top
    // 12 m up: above the 7 m trigger box, so physics 1 misses it; physics 2 takes it in the air.
    assert.equal(flyOver(gateWorld(), 1, 12).length, 0, 'physics 1 misses a jump over the box');
    const air = flyOver(gateWorld(), 2, 12);
    assert.equal(air.length, 1);
    assert.ok(air[0].air, 'collected in mid-air');
    // The column has a ceiling.
    assert.equal(flyOver(gateWorld(), 2, top + CHECKPOINT_AIR_HEIGHT + 6).length, 0, 'far above the column: no');
    // Driving on a road that passes above the checkpoint (inside the column) does not take it.
    const upper = gateWorld(15);
    upper.triggers[0].min[1] = -1; upper.triggers[0].max[1] = 7;   // gate on the level below the deck at y = 15
    const sim = new Sim(upper, { physics: 2 });
    let cps = 0;
    for (let i = 0; i < 900; i++) { sim.step(GAS); cps += sim.events.filter((e) => e.type === 'checkpoint').length; }
    assert.ok(sim.car.pos[2] > -2690 && !sim.car.airborne, 'drove across the column on the upper deck');
    assert.equal(cps, 0, 'a grounded car above the gate does not collect it');
    // Through the box itself at top speed: swept tests never skip it (both versions).
    for (const ph of [1, 2]) assert.equal(flyOver(gateWorld(), ph, 1.5, MAX_SPEED, 50).length, 1, `1000 km/h, physics ${ph}`);
});

test('determinism (physics 2): live run = replay = savestate restore, and old replays keep physics 1', () => {
    const t = levels.getTrack('A03');
    const world = buildWorld(t);
    const live = new Sim(world, { physics: 2 });
    const pilot = new Autopilot(world);
    const rec = new Recorder();
    let mid = null, drifts = 0, airBrakes = 0, speedDrifts = 0;
    while (!live.finished && live.tick < 8000) {
        const inp = pilot.act(live);
        // Mix in what physics 2 adds: brake taps into corners and the air-brake.
        if (live.car.airborne && live.car.airTicks > 5) inp.brake = true;
        else if (live.tick % 400 < 6 && Math.abs(inp.steer) > STEER_MAX * 0.4) { inp.brake = true; inp.gas = false; }
        live.step(inp);
        rec.push(live.lastInput);
        if (live.car.drifting) drifts++;
        if (live.car.airBraking) airBrakes++;
        if (live.car.speedDrift) speedDrifts++;
        if (live.tick === 1500) mid = JSON.parse(JSON.stringify(live.getState()));
    }
    assert.ok(drifts > 0 && airBrakes > 0, `the run drifts (${drifts} ticks) and air-brakes (${airBrakes} ticks)`);
    const replay = JSON.parse(JSON.stringify(rec.toReplay({ sim: live })));
    assert.equal(replay.physics, 2);
    const res = simulateReplay(world, replay, { sampleEvery: 0, stopAtFinish: false });
    assert.equal(res.sim.stateHash(), live.stateHash(), 'replay reproduces the live run bit for bit');
    if (live.finished) assert.ok(verifyReplay(world, replay).ok, 'physics 2 replay verifies');
    else assert.ok(verifyReplay(world, replay, { requireFinish: false }).ok);
    // Savestate (JSON round trip, keys shuffled) restores and continues identically.
    const shuffled = Object.fromEntries(Object.entries(mid).reverse());
    assert.equal(hashState(shuffled), hashState(mid));
    assert.deepEqual(canonicalState(shuffled), canonicalState(mid));
    const resumed = new Sim(world, { physics: 2 });
    resumed.setState(shuffled);
    const inputs = rec.inputs;
    for (let i = 1500; i < inputs.length; i++) resumed.step(inputs[i]);
    assert.equal(resumed.stateHash(), live.stateHash(), 'savestate resume matches');
    info(`A03 physics 2 run: ${live.finished ? live.finishTimeMs + ' ms' : 'unfinished'}, ${drifts} drift / ${speedDrifts} speed-drift / ${airBrakes} air-brake ticks`);
});

test('old replays: every baked author run still verifies with physics 1', () => {
    let n = 0, broken = 0;
    for (const id of Object.keys(BAKED)) {
        const replay = levels.authorReplay(id);
        if (!replay) continue;
        assert.ok(!('physics' in replay), `${id}: author replays carry no version (physics 1)`);
        const world = buildWorld(levels.getTrack(id));
        const res = verifyReplay(world, replay);
        assert.ok(res.ok, `${id}: ${res.reason}`);
        assert.equal(res.timeMs, levels.getTrack(id).medals.author, `${id} author time`);
        // The version matters: some of these inputs do not even finish with the new rules.
        if (id === 'A03') broken = verifyReplay(world, replay, { physics: 2 }).ok ? 0 : 1;
        n++;
    }
    assert.ok(n >= 30, `${n} author runs checked`);
    assert.equal(broken, 1, 'A03 author inputs fail under physics 2, so old runs must keep physics 1');
});

test('multiplayer: room runs use the latest physics; finishes verify after the protocol strips the version', async () => {
    const { Racer, ROOM_PHYSICS, verifyRoomReplay } = await import('../../js/mp/racer.js');
    const { cleanReplay } = await import('../../js/mp/protocol.js');
    assert.equal(ROOM_PHYSICS, PHYSICS_LATEST);
    const world = buildWorld(levels.getTrack('A01'));
    const r = new Racer(world, { name: 'p' });
    assert.equal(r.sim.physics, ROOM_PHYSICS);
    const pilot = new Autopilot(world);
    r.go();
    while (r.state === 'racing' && r.sim.tick < 6000) {
        const inp = pilot.act(r.sim);
        if (r.sim.car.airborne) inp.brake = true;   // physics 2 only
        r.step(inp);
    }
    assert.equal(r.state, 'finished');
    const wire = cleanReplay(JSON.parse(JSON.stringify(r.result.replay)));
    assert.ok(wire && !('physics' in wire), 'the payload is unchanged: no physics field travels');
    const v = verifyRoomReplay(world, wire);
    assert.ok(v.ok && v.timeMs === r.result.timeMs, v.reason);
    // A guest on an older build (physics 1) is still verified as the run it was.
    const author = cleanReplay(levels.authorReplay('A01'));
    const va = verifyRoomReplay(world, author);
    assert.ok(va.ok && va.timeMs === levels.getTrack('A01').medals.author, va.reason);
});
