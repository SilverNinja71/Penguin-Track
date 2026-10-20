// The AI Lab's live view, without rendering: a generation's evaluated
// episodes replayed side by side, one tick at a time, from their recorded
// inputs (deterministic, so each car drives exactly the run its worker scored).
// Each car keeps a PenguinEnv's sim and route tracker, so the followed car can
// show what its network sees (env.observe()) and decides (net.forward()).
import { PenguinEnv } from './env.js';
import { MLP } from './nn.js';
import { replayInputs, snapshotCar } from '../core/replay.js';
import { inputToAction } from '../core/input.js';
import { STEER_MAX } from '../core/constants.js';

export const COAST_TICKS = 150;     // finishers roll on past the line
const LINGER_TICKS = 80;            // a beat at the end before the field restarts

export class FieldPlayback {
    /**
     * world: built world; envConfig: the env config the agents were trained with;
     * arch: network architecture (null: no decisions shown); entries:
     * [{ replay, params?, fitness?, info?, rank?, color?, label? }].
     */
    constructor({ world, envConfig, arch = null, entries }) {
        this.world = world;
        this.envConfig = envConfig;
        this.frameSkip = (envConfig && envConfig.frameSkip) || 4;
        this.net = arch ? new MLP({ ...arch, seed: 1 }) : null;
        this.cars = entries.map((e, i) => this._makeCar(e, i));
        this.tick = 0;
        this.focus = 0;
        this.decision = null;
        this._focusParams = null;
        this.endTick = this.cars.reduce((m, c) => Math.max(m, c.inputs.length + (c.entry.replay.finished ? COAST_TICKS : 0)), 0) + LINGER_TICKS;
        this.setFocus(0);
    }

    _makeCar(entry, i) {
        const env = new PenguinEnv({ ...this.envConfig, world: this.world, startMode: 'start' });
        env.sim.reset();
        env.tracker.reset();
        env.tracker.track(env.sim);
        const c = {
            id: i, entry, env, sim: env.sim, inputs: replayInputs(entry.replay),
            done: false, finished: false, endTick: null, events: [],
            prev: null, cur: null,
        };
        c.prev = snapshotCar(c.sim.car);
        c.cur = snapshotCar(c.sim.car);
        return c;
    }

    get over() {
        return this.tick >= this.endTick;
    }

    get focusCar() {
        return this.cars[this.focus] || null;
    }

    /** Advances every car one tick. */
    step() {
        const t = this.tick;
        for (const c of this.cars) {
            snapshotCar(c.sim.car, c.prev);
            c.events = [];
            if (t < c.inputs.length) {
                c.sim.step(c.inputs[t]);
                c.env.tracker.track(c.sim);
                c.events = c.sim.events.slice();
                if (t + 1 >= c.inputs.length) {
                    c.done = true;
                    c.finished = c.sim.finished;
                    c.endTick = t + 1;
                }
            } else if (c.finished && t < c.endTick + COAST_TICKS) {
                c.sim.step(null);
                c.events = c.sim.events.slice();
            }
            snapshotCar(c.sim.car, c.cur);
        }
        this.tick = t + 1;
        if (this.tick % this.frameSkip === 0) this._decide();
    }

    /** Runs until `tick` (fast-forward, e.g. after a focus change). */
    seek(tick) {
        while (this.tick < tick && !this.over) this.step();
    }

    /** Follows car i (an index into cars): its decisions are computed from now on. */
    setFocus(i) {
        if (!this.cars.length) return;
        this.focus = ((i % this.cars.length) + this.cars.length) % this.cars.length;
        const p = this.focusCar.entry.params;
        if (this.net && p && p.length === this.net.paramCount) {
            this.net.setParams(p);
            this._focusParams = p;
        } else {
            this._focusParams = null;
        }
        this._decide();
    }

    /**
     * What the followed car sees and does right now: { obs (Float32Array),
     * names, outputs (network outputs or null), action (the input it is
     * applying: discrete index or [steer, throttle]), steer, throttle, info }.
     */
    _decide() {
        const c = this.focusCar;
        if (!c) return;
        const env = c.env;
        const obs = env.observe();
        let outputs = null;
        if (this._focusParams) outputs = Array.from(this.net.forward(obs));
        const t = this.tick;
        const inp = t < c.inputs.length ? c.inputs[t] : null;
        const steer = inp ? inp.steer / STEER_MAX : 0;
        const throttle = inp ? (inp.brake ? -1 : inp.gas ? 1 : 0) : 0;
        this.decision = {
            carId: c.id, tick: t, obs, names: env.layout.map((f) => f.name), outputs,
            action: inp ? inputToAction(inp) : null, steer, throttle, driving: !!inp,
            info: env.info(),
        };
    }

    /** Index of the car with the highest rank (lowest rank number), else 0. */
    bestIndex() {
        let bi = 0;
        this.cars.forEach((c, i) => {
            if ((c.entry.rank ?? i) < (this.cars[bi].entry.rank ?? bi)) bi = i;
        });
        return bi;
    }

    /** Cars still driving (not crashed / ended). */
    activeCount() {
        let n = 0;
        for (const c of this.cars) if (!c.done) n++;
        return n;
    }
}

/** Observation values by name prefix: groups the overlay draws ('edge@', 'wall@', 'point@'…). */
export function obsGroup(decision, prefix) {
    const out = [];
    if (!decision) return out;
    decision.names.forEach((n, i) => {
        if (n.startsWith(prefix)) out.push({ name: n, value: decision.obs[i] });
    });
    return out;
}
