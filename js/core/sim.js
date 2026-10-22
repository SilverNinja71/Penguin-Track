// The race simulation: one car on one world, advanced one 10 ms tick at a
// time. Owns the race rules (checkpoints in any order, laps, finish), trigger
// detection, pad effects, respawns and exact savestates. Deterministic: the
// same world and inputs give bit-identical states on every engine.
import { TICK_MS, FALL_Y } from './constants.js';
import { segmentAABB, pointInAABB } from './collision.js';
import { Car, carStateFrom, PHYSICS_LEGACY, PHYSICS_VERSIONS } from './car.js';
import { normalizeInto } from './input.js';

const EMPTY = Object.freeze([]);
const NEUTRAL_INPUT = Object.freeze({ steer: 0, gas: false, brake: false });
export const STATE_VERSION = 2;
/**
 * Physics 2: a checkpoint also counts when an airborne car crosses the column
 * this high above its trigger box (same footprint), so a jump over the arch on
 * a shortcut takes it. Checkpoints themselves do not move.
 */
export const CHECKPOINT_AIR_HEIGHT = 24;

export class Sim {
    /**
     * world: from buildWorld (or any object with collision, triggers, spawn,
     * checkpointCount, fallY). opts.laps overrides world.laps; opts.allowNoSpawn
     * lets synthetic worlds without a spawn start the car at the origin.
     * opts.physics picks the rule set (car.js PHYSICS_*): default 1, the rules
     * every run without a version was recorded with; live play passes
     * PHYSICS_LATEST. Throws on configurations that can never finish.
     */
    constructor(world, opts = {}) {
        this.world = world;
        this.worldHash = world.hash ?? null;
        this.collision = world.collision;
        const laps = opts.laps ?? world.laps ?? 1;
        if (!Number.isInteger(laps) || laps < 1) throw new Error(`Bad lap count ${laps}`);
        this.laps = laps;
        this.mode = world.mode || 'race';
        this.triggers = world.triggers || [];
        if (laps > 1 && !this.triggers.some((t) => t.type === 'startfinish')) {
            throw new Error(`${laps} laps need a StartFinish line, and this track has none`);
        }
        if (!world.spawn && !opts.allowNoSpawn) throw new Error('This world has no spawn (no Start or StartFinish block)');
        this.checkpointCount = world.checkpointCount || 0;
        this.fallY = world.fallY != null ? world.fallY : FALL_Y;
        this.spawn = world.spawn || { pos: [0, 0, 0], quat: [0, 0, 0, 1], dir: 0 };
        const physics = opts.physics ?? PHYSICS_LEGACY;
        if (!PHYSICS_VERSIONS.includes(physics)) throw new Error(`Unknown physics version ${physics} (this game knows ${PHYSICS_VERSIONS.join(', ')})`);
        this.physics = physics;
        this.car = new Car(physics);
        this.events = EMPTY;
        // The input the last step actually simulated: normalised, `respawn` true when
        // the tick began with a respawn (flag or respawn()), neutral after the finish.
        // Recorders store this, so replays reproduce runs exactly. Reused every tick.
        this.lastInput = { steer: 0, gas: false, brake: false, respawn: false };
        this._inside = new Uint8Array(this.triggers.length);
        // Physics 2: the air column above each checkpoint (null for other triggers) and whether
        // the car's last segment touched it. Physics 1 never reads these.
        this._air = this.triggers.map((t) => (physics >= 2 && t.type === 'checkpoint'
            ? { min: [t.min[0], t.max[1], t.min[2]], max: [t.max[0], t.max[1] + CHECKPOINT_AIR_HEIGHT, t.max[2]] } : null));
        this._insideAir = new Uint8Array(this.triggers.length);
        this._entered = [];
        this._enteredT = [];
        this._prev = [0, 0, 0];
        this._emit = (type, data) => this._push(type, data);
        this.reset();
    }

    /** Back to tick 0: car at the spawn, standing still, race state cleared. */
    reset() {
        this.tick = 0;
        this.finished = false;
        this.finishTimeMs = null;
        this.lap = 1;
        this.lapStartTick = 0;
        this.lapTimes = [];
        this.checkpointTimes = [];
        this.collected = new Array(this.checkpointCount).fill(0);
        this.collectedCount = 0;
        this.respawns = 0;
        this.fallen = false;
        this.lastCheckpoint = -1;
        this._pendingRespawn = false;
        this._cp = null;
        this.events = EMPTY;
        normalizeInto(this.lastInput, null);
        this.car.place(this.spawn.pos, this.spawn.quat);
        this._refreshInside();
    }

    /** Race time: frozen at the finish time once finished. */
    get timeMs() {
        return this.finished ? this.finishTimeMs : this.tick * TICK_MS;
    }

    /**
     * Advances one tick. input = { steer, gas, brake, respawn? }, normalised with
     * the same rule the Recorder uses (see input.js). A truthy `respawn` (or a
     * pending respawn()) respawns before the tick is simulated, so recorded inputs
     * reproduce respawns exactly. After the finish the car coasts (input ignored).
     */
    step(input = NEUTRAL_INPUT) {
        this.events = EMPTY;
        const inp = this.lastInput;
        if (this.finished) {
            normalizeInto(inp, null);
            this._pendingRespawn = false;
        } else {
            normalizeInto(inp, input);
            if (this._pendingRespawn) inp.respawn = true;
            this._pendingRespawn = false;
            if (inp.respawn) this._respawnNow();
        }
        const car = this.car;
        const p = this._prev;
        p[0] = car.pos[0]; p[1] = car.pos[1]; p[2] = car.pos[2];
        car.step(inp, this.collision, this._emit);
        this.tick++;
        // Events of this step (a respawn included) belong to the tick just simulated.
        if (this.events !== EMPTY) for (const ev of this.events) ev.tick = this.tick;

        const ok = Number.isFinite;
        if (!(ok(car.pos[0]) && ok(car.pos[1]) && ok(car.pos[2]) && ok(car.vel[0]) && ok(car.vel[1]) && ok(car.vel[2]))) {
            // Should never happen; recover deterministically rather than poison the run.
            this._push('fall', { reason: 'invalid' });
            this._respawnNow();
            return;
        }
        this._triggers(p, car.pos);
        if (!this.fallen && car.pos[1] < this.fallY) {
            this.fallen = true;
            this._push('fall', {});
        }
    }

    /**
     * Requests a respawn at the start of the next step(), exactly as if that
     * step's input had `respawn: true` (and `lastInput.respawn` reports it, so a
     * recorder storing lastInput captures it). Ignored once finished.
     */
    respawn() {
        if (!this.finished) this._pendingRespawn = true;
    }

    /** True when respawn() was called and the next step will respawn. */
    get respawnPending() {
        return this._pendingRespawn;
    }

    /**
     * Back to the state captured at the last checkpoint (or lap line): same
     * position, speed, heading and effects, TM style, with the engine repaired.
     * Before any checkpoint it returns to the start standing still while the
     * race clock keeps running (use reset() for a fresh run).
     */
    _respawnNow() {
        this.respawns++;
        const car = this.car;
        if (this._cp) {
            car.setState(this._cp);
            car.effects.noEngine = false;
            car.effects.broken = false;
            car.refreshView();
        } else {
            car.place(this.spawn.pos, this.spawn.quat);
        }
        this.fallen = false;
        this._refreshInside();
        this._push('respawn', { checkpoint: this._cp ? this.lastCheckpoint : -1 });
    }

    _push(type, data) {
        if (this.events === EMPTY) this.events = [];
        const ev = { type, tick: this.tick };
        if (data) Object.assign(ev, data);
        this.events.push(ev);
    }

    _refreshInside() {
        const pos = this.car.pos;
        for (let i = 0; i < this.triggers.length; i++) this._inside[i] = pointInAABB(pos, this.triggers[i]) ? 1 : 0;
        if (this.physics >= 2) {
            for (let i = 0; i < this.triggers.length; i++) this._insideAir[i] = this._air[i] && pointInAABB(pos, this._air[i]) ? 1 : 0;
        }
    }

    /**
     * Swept-segment trigger detection: a pad fires once per entry, in crossing
     * order. The tick's whole path is tested, so no speed can skip a box.
     * Physics 2 also fires a checkpoint when an airborne car enters its air column.
     */
    _triggers(a, b) {
        const trg = this.triggers, inside = this._inside;
        const ent = this._entered, entT = this._enteredT;
        const air = this.physics >= 2 ? this._air : null, insideAir = this._insideAir;
        const flying = this.car.airTicks > 0;
        let m = 0;
        for (let i = 0; i < trg.length; i++) {
            let t = segmentAABB(a, b, trg[i]);
            const now = t >= 0 ? 1 : 0;
            let enter = now && !inside[i];
            inside[i] = now;
            if (air && air[i]) {
                const ta = segmentAABB(a, b, air[i]);
                const nowAir = ta >= 0 ? 1 : 0;
                if (nowAir && !insideAir[i] && flying && (!enter || ta < t)) { enter = true; t = ta; }
                insideAir[i] = nowAir;
            }
            if (enter) {
                // Insertion by (t, index) keeps the order deterministic.
                let k = m++;
                while (k > 0 && entT[k - 1] > t) { ent[k] = ent[k - 1]; entT[k] = entT[k - 1]; k--; }
                ent[k] = i; entT[k] = t;
            }
        }
        for (let k = 0; k < m; k++) this._fire(trg[ent[k]]);
    }

    _fire(t) {
        switch (t.type) {
            case 'checkpoint':
                if (this.finished || this.collected[t.id]) return;
                this.collected[t.id] = 1;
                this.collectedCount++;
                this.checkpointTimes.push(this.tick * TICK_MS);
                this.lastCheckpoint = t.id;
                this._cp = this.car.getState();
                this._push('checkpoint', {
                    id: t.id, count: this.collectedCount, total: this.checkpointCount,
                    timeMs: this.tick * TICK_MS, lap: this.lap,
                });
                return;
            case 'finish':
                if (this.finished) return;
                if (this.collectedCount < this.checkpointCount) {
                    this._push('missingCheckpoints', { missing: this.checkpointCount - this.collectedCount });
                    return;
                }
                if (this.lap < this.laps) return;   // a Finish arch on a lap track only ends the last lap
                this._finish();
                return;
            case 'startfinish':
                if (this.finished) return;
                if (this.collectedCount < this.checkpointCount) {
                    this._push('missingCheckpoints', { missing: this.checkpointCount - this.collectedCount });
                    return;
                }
                if (this.lap >= this.laps) {
                    this._finish();
                    return;
                }
                this.lapTimes.push((this.tick - this.lapStartTick) * TICK_MS);
                this.lap++;
                this.lapStartTick = this.tick;
                this.collected.fill(0);
                this.collectedCount = 0;
                this.lastCheckpoint = -1;
                this._cp = this.car.getState();
                this._push('lap', { lap: this.lap - 1, timeMs: this.tick * TICK_MS, lapTimeMs: this.lapTimes[this.lapTimes.length - 1] });
                return;
            case 'effect':
                this.car.applyEffect(t.effect, this._emit);
                return;
            default:
        }
    }

    _finish() {
        this.finished = true;
        this.finishTimeMs = this.tick * TICK_MS;
        this.lapTimes.push((this.tick - this.lapStartTick) * TICK_MS);
        this._pendingRespawn = false;
        this._push('finish', { timeMs: this.finishTimeMs, respawns: this.respawns, lap: this.lap });
    }

    // -------------------------------------------------------------------
    // Savestates

    /**
     * Plain JSON-safe snapshot of everything that influences future ticks,
     * including which world (its hash), lap count and mode it belongs to.
     */
    getState() {
        return {
            v: STATE_VERSION,
            world: this.worldHash,
            laps: this.laps,
            mode: this.mode,
            ...(this.physics !== PHYSICS_LEGACY ? { physics: this.physics, insideAir: Array.from(this._insideAir) } : null),
            tick: this.tick,
            finished: this.finished,
            finishTimeMs: this.finishTimeMs,
            lap: this.lap,
            lapStartTick: this.lapStartTick,
            lapTimes: this.lapTimes.slice(),
            checkpointTimes: this.checkpointTimes.slice(),
            collected: this.collected.slice(),
            collectedCount: this.collectedCount,
            respawns: this.respawns,
            fallen: this.fallen,
            lastCheckpoint: this.lastCheckpoint,
            pendingRespawn: this._pendingRespawn,
            inside: Array.from(this._inside),
            cp: this._cp ? carStateFrom(this._cp) : null,
            car: this.car.getState(),
        };
    }

    /** Restores a getState() snapshot; throws if it belongs to another track, lap count or mode. */
    setState(s) {
        if (!s || s.v !== STATE_VERSION) throw new Error(`Incompatible sim state (version ${s && s.v}, expected ${STATE_VERSION})`);
        if (s.world !== this.worldHash) throw new Error('This state belongs to another track (world hash differs)');
        if (s.laps !== this.laps || s.mode !== this.mode) {
            throw new Error(`This state was saved for ${s.laps} lap(s) in ${s.mode} mode; this Sim runs ${this.laps} in ${this.mode} mode`);
        }
        if ((s.physics ?? PHYSICS_LEGACY) !== this.physics) {
            throw new Error(`This state was saved with physics ${s.physics ?? PHYSICS_LEGACY}; this Sim runs physics ${this.physics}`);
        }
        if (!Array.isArray(s.inside) || s.inside.length !== this.triggers.length || !Array.isArray(s.collected)
            || s.collected.length !== this.checkpointCount) {
            throw new Error("This state does not match the world's triggers");
        }
        this.tick = s.tick;
        this.finished = !!s.finished;
        this.finishTimeMs = s.finishTimeMs;
        this.lap = s.lap;
        this.lapStartTick = s.lapStartTick;
        this.lapTimes = s.lapTimes.slice();
        this.checkpointTimes = s.checkpointTimes.slice();
        this.collected = s.collected.map((x) => (x ? 1 : 0));
        this.collectedCount = s.collectedCount;
        this.respawns = s.respawns;
        this.fallen = !!s.fallen;
        this.lastCheckpoint = s.lastCheckpoint;
        this._pendingRespawn = !!s.pendingRespawn;
        for (let i = 0; i < this._inside.length; i++) this._inside[i] = s.inside[i] ? 1 : 0;
        for (let i = 0; i < this._insideAir.length; i++) this._insideAir[i] = s.insideAir && s.insideAir[i] ? 1 : 0;
        this._cp = s.cp ? carStateFrom(s.cp) : null;
        this.car.setState(s.car);
        this.events = EMPTY;
        normalizeInto(this.lastInput, null);
    }

    /** Short hash of the current state (determinism checks, TAS sync). */
    stateHash() {
        return hashJson(JSON.stringify(this.getState()));
    }
}

/**
 * A savestate rebuilt in getState's exact shape and key order (unknown keys
 * dropped), so states that went through another serializer hash the same.
 */
export function canonicalState(s) {
    if (!s || s.v !== STATE_VERSION) return s;
    return {
        v: s.v,
        world: s.world ?? null,
        laps: s.laps,
        mode: s.mode,
        ...((s.physics ?? PHYSICS_LEGACY) !== PHYSICS_LEGACY
            ? { physics: s.physics, insideAir: (s.insideAir || []).map((x) => (x ? 1 : 0)) } : null),
        tick: s.tick,
        finished: !!s.finished,
        finishTimeMs: s.finishTimeMs ?? null,
        lap: s.lap,
        lapStartTick: s.lapStartTick,
        lapTimes: s.lapTimes.slice(),
        checkpointTimes: s.checkpointTimes.slice(),
        collected: s.collected.map((x) => (x ? 1 : 0)),
        collectedCount: s.collectedCount,
        respawns: s.respawns,
        fallen: !!s.fallen,
        lastCheckpoint: s.lastCheckpoint,
        pendingRespawn: !!s.pendingRespawn,
        inside: s.inside.map((x) => (x ? 1 : 0)),
        cp: s.cp ? carStateFrom(s.cp) : null,
        car: carStateFrom(s.car),
    };
}

/** 16 hex chars: two FNV-1a variants over the canonical JSON text of a state. */
export function hashState(state) {
    return hashJson(JSON.stringify(canonicalState(state)));
}

function hashJson(s) {
    let h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0x5bd1e995;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        h1 = Math.imul(h1 ^ c, 0x01000193);
        h2 = Math.imul(h2 ^ c, 0x5bd1e995) ^ (h2 >>> 15);
    }
    return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}
