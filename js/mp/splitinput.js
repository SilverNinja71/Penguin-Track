// Two players on one keyboard (P1: WASD + R, P2: arrows + Enter) plus
// gamepads, first pad to P1 and the second to P2 (pure: fed key codes and
// gamepad-like objects, Node-tested).
import { STEER_MAX } from '../core/constants.js';
import { clampSteer } from '../core/input.js';

export const KEYMAPS = [
    { gas: ['KeyW'], brake: ['KeyS'], left: ['KeyA'], right: ['KeyD'], respawn: ['KeyR'] },
    { gas: ['ArrowUp'], brake: ['ArrowDown'], left: ['ArrowLeft'], right: ['ArrowRight'], respawn: ['Enter', 'NumpadEnter'] },
];
// Shared keys: restart both, pause.
export const SHARED_KEYS = { restart: ['Backspace', 'Delete'], pause: ['Escape', 'KeyP'] };

const PAD = { A: 0, B: 1, X: 2, Y: 3, LT: 6, RT: 7, BACK: 8, START: 9, LEFT: 14, RIGHT: 15 };

/** All key codes the split-screen race uses (to preventDefault on them). */
export function allSplitCodes() {
    const s = new Set();
    for (const m of KEYMAPS) for (const list of Object.values(m)) for (const c of list) s.add(c);
    for (const list of Object.values(SHARED_KEYS)) for (const c of list) s.add(c);
    return s;
}

/** A gamepad (navigator.getGamepads() entry or a test double) → { steer, gas, brake, buttons } . */
export function readPad(gp, { deadzone = 0.12, sensitivity = 1 } = {}) {
    const b = (i) => {
        const x = gp.buttons && gp.buttons[i];
        return x ? (typeof x === 'object' ? x.value > 0.3 || !!x.pressed : x > 0.3) : false;
    };
    const ax = (gp.axes && gp.axes[0]) || 0;
    const mag = Math.abs(ax);
    let steer = 0;
    if (mag > deadzone) {
        let t = Math.min(1, (mag - deadzone) / (1 - deadzone));
        t = 0.65 * t + 0.35 * t * t;
        steer = Math.sign(ax) * Math.min(1, t * sensitivity) * STEER_MAX;
    }
    if (b(PAD.LEFT) || b(PAD.RIGHT)) steer = (b(PAD.RIGHT) ? STEER_MAX : 0) - (b(PAD.LEFT) ? STEER_MAX : 0);
    return {
        steer: clampSteer(Math.round(steer)),
        gas: b(PAD.RT) || b(PAD.A),
        brake: b(PAD.LT) || b(PAD.X),
        respawn: b(PAD.B),
        restart: b(PAD.Y) || b(PAD.BACK),
        pause: b(PAD.START),
    };
}

/** Connected pads in index order: the first drives P1, the second P2. */
export function assignPads(pads) {
    const out = [null, null];
    let k = 0;
    for (const p of pads || []) {
        if (!p || p.connected === false) continue;
        out[k++] = p;
        if (k === 2) break;
    }
    return out;
}

export class SplitInput {
    constructor(opts = {}) {
        this.codes = new Set();
        this.edges = [new Set(), new Set()];
        this.shared = new Set();
        this.pads = [null, null];      // last readPad() per player
        this._padPrev = [{}, {}];
        this.padOpts = opts;
    }

    /** Returns true when the code belongs to the race (caller then preventDefaults). */
    keydown(code, repeat = false) {
        let used = false;
        KEYMAPS.forEach((m, p) => {
            for (const [action, list] of Object.entries(m)) {
                if (!list.includes(code)) continue;
                used = true;
                this.codes.add(code);
                if (action === 'respawn' && !repeat) this.edges[p].add('respawn');
            }
        });
        for (const [action, list] of Object.entries(SHARED_KEYS)) {
            if (!list.includes(code)) continue;
            used = true;
            if (!repeat) this.shared.add(action);
        }
        return used;
    }

    keyup(code) {
        this.codes.delete(code);
    }

    releaseAll() {
        this.codes.clear();
    }

    /** Feeds the current gamepads (navigator.getGamepads()). */
    pollPads(list) {
        const pads = assignPads(list);
        for (let p = 0; p < 2; p++) {
            const r = pads[p] ? readPad(pads[p], this.padOpts) : null;
            const prev = this._padPrev[p];
            if (r) {
                if (r.respawn && !prev.respawn) this.edges[p].add('respawn');
                if (r.restart && !prev.restart) this.shared.add('restart');
                if (r.pause && !prev.pause) this.shared.add('pause');
            }
            this._padPrev[p] = r || {};
            this.pads[p] = r;
        }
        return pads;
    }

    _held(p, action) {
        for (const c of KEYMAPS[p][action]) if (this.codes.has(c)) return true;
        return false;
    }

    /** Core input for player p (0 or 1) this tick; consumes its respawn edge. */
    input(p, out = {}) {
        const pad = this.pads[p];
        const l = this._held(p, 'left'), r = this._held(p, 'right');
        out.steer = l || r ? (r ? STEER_MAX : 0) - (l ? STEER_MAX : 0) : pad ? pad.steer : 0;
        out.gas = this._held(p, 'gas') || !!(pad && pad.gas);
        out.brake = this._held(p, 'brake') || !!(pad && pad.brake);
        out.respawn = this.edges[p].delete('respawn');
        return out;
    }

    /** Consumes a shared edge ('restart' | 'pause'). */
    pressed(action) {
        return this.shared.delete(action);
    }

    clearEdges() {
        this.edges[0].clear();
        this.edges[1].clear();
        this.shared.clear();
    }
}
