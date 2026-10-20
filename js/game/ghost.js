// Ghost cars: a replay re-simulated once (deterministic, so it is exactly the
// recorded run), sampled every tick and turned back into a car view the
// renderer's setPose() understands.
import { simulateReplay, ghostPoseAt } from '../core/replay.js';
import { CAR, WHEEL_MOUNTS } from '../core/car.js';
import { qrotate } from '../core/mathd.js';

const COAST_TICKS = 300;   // keep the ghost rolling past the line instead of freezing on it
const UP = [0, 1, 0];

/**
 * The three leaderboard ghosts (records.js boards), each with its own colour on
 * the track and the minimap and its own on/off setting, so any mix of them can
 * race you at once.
 */
export const CATEGORY_GHOSTS = {
    pure: { label: 'Best human', color: '#cfeaff', setting: 'showGhost' },
    tas: { label: 'Best TAS', color: '#ff7ad9', setting: 'showTasGhost' },
    ai: { label: 'Best AI', color: '#7dffa0', setting: 'showAiGhost' },
};
export const EMPEROR_GHOST = { label: 'Emperor', color: '#6fd3ff' };

/**
 * Ghosts to race from the board leaders ({ pure, tas, ai }: an entry with a
 * replay, or null), for the categories switched on in `settings`:
 * [{ category, replay, label, color }], in pure, tas, ai order.
 */
export function categoryGhosts(settings, leaders) {
    const out = [];
    for (const category of Object.keys(CATEGORY_GHOSTS)) {
        const g = CATEGORY_GHOSTS[category];
        const lead = leaders && leaders[category];
        if (!settings[g.setting] || !lead || !lead.replay) continue;
        const what = lead.label && category !== 'pure' ? ` · ${lead.label}` : '';
        out.push({ category, replay: lead.replay, label: `${g.label}${what}`, color: g.color });
    }
    return out;
}

function sampleOf(sim, teleport) {
    const c = sim.car;
    return {
        tick: sim.tick, pos: c.pos.slice(), quat: c.quat.slice(), vel: c.vel.slice(), speedKmh: c.speedKmh,
        steer: c.steer, airborne: c.airborne, drifting: c.drifting, teleport,
        wheels: c.wheels.map((w) => ({ compression: w.compression, steer: w.steer, spin: w.spin, contact: w.contact })),
    };
}

export function makeCarView() {
    const wheel = () => ({ contact: false, surface: null, compression: 0, steer: 0, spin: 0, pos: [0, 0, 0], slip: 0 });
    return {
        pos: [0, 0, 0], quat: [0, 0, 0, 1], vel: [0, 0, 0], angVel: [0, 0, 0],
        speed: 0, speedKmh: 0, forwardSpeed: 0, steer: 0, rpm: 0, gear: 1,
        airborne: false, drifting: false, slipAngle: 0, surfaceUnder: null,
        wheels: [wheel(), wheel(), wheel(), wheel()],
        effects: { turbo: 0, turboTime: 0, noEngine: false, noSteer: false, noBrake: false, slowmo: 0, cruise: false, cruiseSpeed: 0, fragile: false, broken: false },
    };
}

export class GhostRun {
    /**
     * world: the built world; replay: a replay object for that world.
     * Throws when the replay cannot be simulated (corrupt inputs).
     */
    constructor(world, replay, { label = 'Ghost', kind = 'pb' } = {}) {
        this.label = label;
        this.kind = kind;
        this.replay = replay;
        const res = simulateReplay(world, replay, { sampleEvery: 1, stopAtFinish: true });
        this.finished = res.finished;
        this.timeMs = res.timeMs;
        this.respawns = res.respawns;
        this.checkpointTimes = res.checkpointTimes;
        this.lapTimes = res.lapTimes;
        this.samples = res.samples;
        if (res.finished) {
            for (let i = 0; i < COAST_TICKS; i++) {
                res.sim.step(null);
                this.samples.push(sampleOf(res.sim, false));
            }
        }
        this.lastTick = this.samples.length ? this.samples[this.samples.length - 1].tick : 0;
        this.pose = { pos: [0, 0, 0], quat: [0, 0, 0, 1], speedKmh: 0, wheels: [0, 1, 2, 3].map(() => ({ compression: 0, steer: 0, spin: 0, contact: false })) };
        this.view = makeCarView();
        this._rv = [0, 0, 0];
        this._up = [0, 0, 0];
    }

    /** Car view at a fractional tick (0 = the start line at GO). */
    viewAt(tick) {
        const p = ghostPoseAt(this.samples, tick, this.pose);
        const v = this.view;
        if (!p) return v;
        for (let k = 0; k < 3; k++) v.pos[k] = p.pos[k];
        for (let k = 0; k < 4; k++) v.quat[k] = p.quat[k];
        v.speedKmh = p.speedKmh;
        v.speed = p.speedKmh / 3.6;
        v.forwardSpeed = v.speed;
        qrotate(this._up, v.quat, UP);
        const up = this._up, rv = this._rv;
        let air = true;
        for (let i = 0; i < 4; i++) {
            const w = v.wheels[i], pw = p.wheels[i];
            w.compression = pw.compression;
            w.steer = pw.steer;
            w.spin = pw.spin;
            w.contact = pw.contact;
            if (pw.contact) air = false;
            qrotate(rv, v.quat, WHEEL_MOUNTS[i]);
            const drop = CAR.travel - (pw.contact ? pw.compression : 0);
            for (let k = 0; k < 3; k++) w.pos[k] = v.pos[k] + rv[k] - up[k] * drop;
        }
        v.airborne = air;
        return v;
    }

    /** Ghost position only (minimap), at a whole tick. */
    posAt(tick) {
        const p = ghostPoseAt(this.samples, tick, this.pose);
        return p ? p.pos : null;
    }
}
