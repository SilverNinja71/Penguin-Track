// Input model: one input per 10 ms tick.
//   { steer, gas, brake, respawn? }
// steer is an integer in [-STEER_MAX, STEER_MAX] (negative = left, positive =
// right; keyboard gives the extremes), gas and brake are booleans, and the
// optional respawn flag makes Sim.step respawn before simulating the tick (so a
// recorded run reproduces its respawns).
//
// clampSteer is THE normalisation rule: Sim.step, the Recorder and the replay
// encoder all apply it, so a live run and its replay see the same value
// whatever a caller passes (fractions round, out-of-range values clamp, NaN and
// garbage become 0).
import { STEER_MAX } from './constants.js';

export { STEER_MAX };

export const NEUTRAL = Object.freeze({ steer: 0, gas: false, brake: false });

/** Builds a normalized input (steer rounded and clamped, booleans coerced). */
export function makeInput(steer = 0, gas = false, brake = false, respawn = false) {
    const inp = { steer: clampSteer(steer), gas: !!gas, brake: !!brake };
    if (respawn) inp.respawn = true;
    return inp;
}

/** Rounds to the nearest integer and clamps to ±STEER_MAX; NaN and non-numbers give 0. */
export function clampSteer(steer) {
    const n = typeof steer === 'number' ? steer : Number(steer);
    if (n !== n) return 0;   // NaN
    const s = Math.round(n);
    return s > STEER_MAX ? STEER_MAX : s < -STEER_MAX ? -STEER_MAX : s + 0;
}

/** Returns a normalized copy of any input-like object (missing fields are neutral). */
export function clampInput(inp) {
    if (!inp) return { steer: 0, gas: false, brake: false };
    return makeInput(inp.steer, inp.gas, inp.brake, inp.respawn);
}

/**
 * Allocation-free normalisation into `out` (Sim.step uses it every tick).
 * Unlike makeInput, `out.respawn` is always present as a boolean.
 */
export function normalizeInto(out, inp) {
    if (!inp) {
        out.steer = 0; out.gas = false; out.brake = false; out.respawn = false;
        return out;
    }
    out.steer = clampSteer(inp.steer);
    out.gas = !!inp.gas;
    out.brake = !!inp.brake;
    out.respawn = !!inp.respawn;
    return out;
}

/** Equal after normalisation (i.e. the simulation would see the same input). */
export function inputsEqual(a, b) {
    return clampSteer(a.steer) === clampSteer(b.steer) && !!a.gas === !!b.gas && !!a.brake === !!b.brake
        && !!a.respawn === !!b.respawn;
}

/** Keyboard-style steering: left/right booleans to -STEER_MAX / 0 / STEER_MAX. */
export function digitalSteer(left, right) {
    return (right ? STEER_MAX : 0) - (left ? STEER_MAX : 0);
}

/**
 * Analog axis (-1..1, e.g. a gamepad stick) to an integer steer value with a
 * dead zone and the remaining range rescaled to full lock.
 */
export function analogSteer(x, deadZone = 0.12) {
    const v = Number(x) || 0;
    const a = v < 0 ? -v : v;
    if (a <= deadZone) return 0;
    const t = Math.min(1, (a - deadZone) / (1 - deadZone));
    return clampSteer((v < 0 ? -t : t) * STEER_MAX);
}

/** { left, right, up, down } booleans (arrows / WASD) to an input. */
export function fromDigital(keys) {
    return makeInput(digitalSteer(keys.left, keys.right), keys.up, keys.down, false);
}

/**
 * Discrete action table for AI agents: steer {left, straight, right} ×
 * throttle {gas, coast, brake}. Index = steerIndex * 3 + throttleIndex.
 *
 *   0 left+gas      1 left+coast      2 left+brake
 *   3 straight+gas  4 straight+coast  5 straight+brake
 *   6 right+gas     7 right+coast     8 right+brake
 */
export const ACTIONS = Object.freeze([-STEER_MAX, 0, STEER_MAX].flatMap((steer, si) =>
    [[true, false], [false, false], [false, true]].map(([gas, brake], ti) => Object.freeze({
        index: si * 3 + ti,
        name: `${['left', 'straight', 'right'][si]}+${['gas', 'coast', 'brake'][ti]}`,
        steer, gas, brake,
    }))));

export const ACTION_COUNT = ACTIONS.length;

/** Input for a discrete action index (0..8). */
export function actionToInput(index) {
    const a = ACTIONS[index];
    if (!a) throw new RangeError(`Unknown action ${index}`);
    return { steer: a.steer, gas: a.gas, brake: a.brake };
}

/** Nearest discrete action for an input (steer split at ±STEER_MAX/3; brake wins over gas). */
export function inputToAction(inp) {
    const s = clampSteer(inp.steer);
    const si = s < -STEER_MAX / 3 ? 0 : s > STEER_MAX / 3 ? 2 : 1;
    const ti = inp.brake ? 2 : inp.gas ? 0 : 1;
    return si * 3 + ti;
}
