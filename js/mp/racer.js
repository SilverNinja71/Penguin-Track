// One car's run for the multiplayer race loops (split-screen, online): a Sim,
// its Recorder, the two snapshots the renderer blends, queued respawns after a
// fall, and the finish result. DOM-free, so it is Node-tested; the shared
// countdown lives in Countdown below.
import { Sim } from '../core/sim.js';
import { Recorder, snapshotCar, verifyReplay } from '../core/replay.js';
import { PHYSICS_LATEST, PHYSICS_LEGACY } from '../core/car.js';

/**
 * The handling every room races with. Finish replays travel without a physics
 * field (the protocol strips unknown keys), so hosts verify with this version
 * and fall back to physics 1 for guests on an older build.
 */
export const ROOM_PHYSICS = PHYSICS_LATEST;

/** verifyReplay for a room finish: ROOM_PHYSICS, else a physics 1 run from a guest on an older build. */
export function verifyRoomReplay(world, replay) {
    const res = verifyReplay(world, replay, { physics: ROOM_PHYSICS });
    if (res.ok || ROOM_PHYSICS === PHYSICS_LEGACY) return res;
    const old = verifyReplay(world, replay, { physics: PHYSICS_LEGACY });
    return old.ok ? old : res;
}

export const COUNT_STEP = 50;              // 3, 2, 1, GO every 0.5 s, like the play screen
export const COUNT_TICKS = COUNT_STEP * 3;

export class Racer {
    constructor(world, { name = '' } = {}) {
        this.world = world;
        this.name = name;
        this.sim = new Sim(world, { physics: ROOM_PHYSICS });
        this.recorder = new Recorder();
        this.prev = snapshotCar(this.sim.car);
        this.cur = snapshotCar(this.sim.car);
        this.run = 0;            // bumps on every restart (remote ghosts snap on it)
        this.reset();
    }

    reset() {
        this.sim.reset();
        this.recorder.clear();
        this.state = 'ready';    // 'ready' (countdown) | 'racing' | 'finished'
        this.respawnQueued = false;
        this.result = null;
        this.finishTicks = 0;
        this.run++;
        snapshotCar(this.sim.car, this.cur);
        snapshotCar(this.sim.car, this.prev);
    }

    go() {
        if (this.state === 'ready') this.state = 'racing';
    }

    /**
     * One tick. input: core Input while racing (ignored otherwise; the car
     * coasts after the finish). Returns the sim events of this tick.
     */
    step(input) {
        if (this.state === 'ready') return NO_EVENTS;
        const racing = this.state === 'racing';
        let inp = null;
        if (racing) {
            inp = input || NEUTRAL_INPUT;
            if (this.respawnQueued) {
                inp = { ...inp, respawn: true };
                this.respawnQueued = false;
            }
        }
        const t = this.prev;
        this.prev = this.cur;
        this.cur = t;
        this.sim.step(inp);
        if (racing) this.recorder.push(this.sim.lastInput);
        snapshotCar(this.sim.car, this.cur);
        const events = this.sim.events;
        let teleport = false;
        for (const ev of events) {
            if (ev.type === 'fall' && this.state === 'racing') this.respawnQueued = true;
            else if (ev.type === 'respawn') teleport = true;
            else if (ev.type === 'finish' && this.state === 'racing') this._finish(ev);
        }
        if (teleport) snapshotCar(this.sim.car, this.prev);
        if (this.state === 'finished') this.finishTicks++;
        return events;
    }

    _finish(ev) {
        const sim = this.sim;
        this.state = 'finished';
        this.finishTicks = 0;
        this.result = {
            finished: true,
            timeMs: ev.timeMs,
            respawns: sim.respawns,
            splits: sim.checkpointTimes.slice(),
            lapTimes: sim.lapTimes.slice(),
            replay: this.recorder.toReplay({ sim, name: this.name }),
        };
    }

    /** Race time to show: frozen at the finish. */
    get timeMs() {
        return this.result ? this.result.timeMs : this.sim.timeMs;
    }
}

/** The shared 3-2-1-GO: tick() returns 3, 2, 1, 'GO' on the ticks they appear, else null. */
export class Countdown {
    constructor() {
        this.t = 0;
        this.done = false;
    }

    reset() {
        this.t = 0;
        this.done = false;
    }

    tick() {
        if (this.done) return null;
        let out = null;
        if (this.t % COUNT_STEP === 0 && this.t < COUNT_TICKS) out = 3 - this.t / COUNT_STEP;
        this.t++;
        if (this.t >= COUNT_TICKS) {
            this.done = true;
            out = 'GO';
        }
        return out;
    }
}

const NO_EVENTS = Object.freeze([]);
const NEUTRAL_INPUT = Object.freeze({ steer: 0, gas: false, brake: false, respawn: false });
