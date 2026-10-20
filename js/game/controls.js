// Keyboard, gamepad and touch -> one core Input per tick, plus edge-detected
// actions (respawn, restart, cameras, ghost toggle, pause, Quick TAS markers)
// and gamepad menu navigation. Bindings use KeyboardEvent.code so they work on
// every layout. Quick TAS keys only act while setTasMode(true) is on, and then
// win over the race actions they share a key with (see TAS_SHADOWED).
import { STEER_MAX } from '../core/constants.js';
import { clampSteer } from '../core/input.js';
import { ACTIONS, TAS_SHADOWED } from './settings.js';
import { h, isTypingTarget } from './dom.js';
import { iconSvg } from './icons.js';

const HOLD = ['gas', 'brake', 'left', 'right'];
const TAS_EDGE = ['tasMark', 'tasRewind', 'tasPrev', 'tasNext'];
const EDGE = ['respawn', 'restart', 'camera1', 'camera2', 'camera3', 'cameraCycle', 'ghost', 'pause', ...TAS_EDGE];

// Standard gamepad mapping (https://w3c.github.io/gamepad/#remapping).
const BTN = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, BACK: 8, START: 9, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };
const PAD_EDGES = [[BTN.B, 'respawn'], [BTN.Y, 'restart'], [BTN.BACK, 'restart'], [BTN.RB, 'cameraCycle'], [BTN.START, 'pause']];
// Quick TAS: LB marks, Y rewinds (Back still restarts), D-pad up / down cycle markers.
const PAD_EDGES_TAS = [[BTN.B, 'respawn'], [BTN.Y, 'tasRewind'], [BTN.BACK, 'restart'], [BTN.RB, 'cameraCycle'], [BTN.START, 'pause'],
    [BTN.LB, 'tasMark'], [BTN.UP, 'tasNext'], [BTN.DOWN, 'tasPrev']];
const NAV_REPEAT_DELAY = 380, NAV_REPEAT = 130;
const TAP_WINDOW_MS = 100;   // input() calls further apart than this mean ticks were not running

export class Controls {
    constructor(settings) {
        this.codes = new Set();           // keyboard codes held
        this.byCode = new Map();          // code -> [action], every binding
        this._edgeRace = new Map();       // code -> [edge action] in a normal race
        this._edgeTas = new Map();        // code -> [edge action] while Quick TAS runs
        this.tas = false;
        this.edges = new Set();           // actions pressed since last consumed
        this.touch = { gas: false, brake: false, left: false, right: false };
        // Hold controls pressed since the last tick read them: a tap shorter than a
        // frame (pressed and released between two ticks) still drives one tick.
        this.taps = { gas: false, brake: false, left: false, right: false };
        this._lastInput = -Infinity;
        this.touchPointers = new Map();   // pointerId -> action
        this.pad = { connected: false, steer: 0, gas: false, brake: false, left: false, right: false, id: '' };
        this._padPrev = [];
        this._nav = { dir: null, next: 0, edges: new Set() };
        this.active = false;
        this.lastDevice = 'keyboard';
        this.touchSeen = false;
        this.touchEl = null;
        this.onDevice = null;             // (device) => void, when the input device changes
        this._onKeyDown = this._onKeyDown.bind(this);
        this._onKeyUp = this._onKeyUp.bind(this);
        this._onBlur = this._onBlur.bind(this);
        this._onPointer = this._onPointer.bind(this);
        this.setSettings(settings);
    }

    attach(target = window) {
        target.addEventListener('keydown', this._onKeyDown, { capture: true });
        target.addEventListener('keyup', this._onKeyUp, { capture: true });
        target.addEventListener('blur', this._onBlur);
        target.addEventListener('pointerdown', this._onPointer, { capture: true, passive: true });
        this._target = target;
    }

    detach() {
        const t = this._target;
        if (!t) return;
        t.removeEventListener('keydown', this._onKeyDown, { capture: true });
        t.removeEventListener('keyup', this._onKeyUp, { capture: true });
        t.removeEventListener('blur', this._onBlur);
        t.removeEventListener('pointerdown', this._onPointer, { capture: true });
        this._target = null;
    }

    setSettings(s) {
        this.settings = s;
        this.byCode.clear();
        this._edgeRace.clear();
        this._edgeTas.clear();
        for (const a of ACTIONS) {
            for (const code of s.bindings[a.id] || []) {
                if (!this.byCode.has(code)) this.byCode.set(code, []);
                this.byCode.get(code).push(a.id);
            }
        }
        for (const [code, actions] of this.byCode) {
            const race = actions.filter((a) => EDGE.includes(a) && !TAS_EDGE.includes(a));
            const tas = actions.filter((a) => TAS_EDGE.includes(a));
            // A TAS key only takes over race actions it may shadow; a key that also
            // drives, respawns or pauses keeps doing that instead.
            const keepsRace = actions.some((a) => !TAS_EDGE.includes(a) && !TAS_SHADOWED.includes(a));
            const inTas = tas.length && !keepsRace ? tas : race;
            if (race.length) this._edgeRace.set(code, race);
            if (inTas.length) this._edgeTas.set(code, inTas);
        }
        this._updateTouchVisibility();
    }

    /** Quick TAS key context on or off (the marker keys, pad buttons and touch buttons). */
    setTasMode(on) {
        this.tas = !!on;
        for (const a of TAS_EDGE) this.edges.delete(a);
        if (this.touchEl) this.touchEl.classList.toggle('tas', this.tas);
    }

    /** In play: game keys stop scrolling/navigating the page and the touch pad shows. */
    setActive(on) {
        this.active = !!on;
        this.edges.clear();
        this._clearTaps();
        this._updateTouchVisibility();
    }

    // ---------------------------------------------------------------- queries

    /** True while an action is held on any device. */
    down(action) {
        if (this.touch[action]) return true;
        if (this.pad[action]) return true;
        const keys = this.settings.bindings[action];
        if (keys) for (const k of keys) if (this.codes.has(k)) return true;
        return false;
    }

    /** Consumes an edge: true once per press of a respawn/restart/camera/ghost/pause control. */
    pressed(action) {
        if (!this.edges.has(action)) return false;
        this.edges.delete(action);
        return true;
    }

    clearEdges() {
        this.edges.clear();
    }

    /**
     * The core Input for one tick. Keyboard steering is digital (full lock); the
     * stick is analog with the dead zone and sensitivity from settings. Consumes
     * the respawn edge into `respawn`.
     */
    input(out = {}) {
        // Taps only count while ticks keep reading input: one left over from the
        // countdown or a pause must not reach the first tick after it.
        const now = performance.now();
        const t = this.taps, live = now - this._lastInput < TAP_WINDOW_MS;
        this._lastInput = now;
        const kl = this._keyDown('left') || this.touch.left || this.pad.left || (live && t.left);
        const kr = this._keyDown('right') || this.touch.right || this.pad.right || (live && t.right);
        let steer = 0;
        if (kl || kr) steer = (kr ? STEER_MAX : 0) - (kl ? STEER_MAX : 0);
        else steer = this.pad.steer;
        out.steer = clampSteer(steer);
        out.gas = this._keyDown('gas') || this.touch.gas || this.pad.gas || (live && t.gas);
        out.brake = this._keyDown('brake') || this.touch.brake || this.pad.brake || (live && t.brake);
        out.respawn = this.pressed('respawn');
        this._clearTaps();
        return out;
    }

    _clearTaps() {
        const t = this.taps;
        t.gas = t.brake = t.left = t.right = false;
    }

    _keyDown(action) {
        const keys = this.settings.bindings[action];
        if (keys) for (const k of keys) if (this.codes.has(k)) return true;
        return false;
    }

    // ---------------------------------------------------------------- keyboard

    _onKeyDown(e) {
        if (isTypingTarget(e.target)) return;
        if (e.metaKey || e.ctrlKey || e.altKey) return;   // leave browser shortcuts alone
        this._setDevice('keyboard');
        if (!this.byCode.has(e.code)) return;
        this.codes.add(e.code);
        if (!e.repeat) for (const a of this.byCode.get(e.code)) if (Object.hasOwn(this.taps, a)) this.taps[a] = true;
        const edges = (this.tas ? this._edgeTas : this._edgeRace).get(e.code);
        if (edges && !e.repeat) for (const a of edges) this.edges.add(a);
        // Only in play: menus keep arrows/Enter/Backspace for navigation and text.
        if (this.active) e.preventDefault();
    }

    _onKeyUp(e) {
        this.codes.delete(e.code);
        if (this.active && this.byCode.has(e.code)) e.preventDefault();
    }

    _onBlur() {
        // Keys released while the window was in the background never send keyup.
        this.codes.clear();
        for (const k of Object.keys(this.touch)) this.touch[k] = false;
        this._clearTaps();
    }

    _onPointer(e) {
        if (e.pointerType === 'touch') {
            this._setDevice('touch');
            if (!this.touchSeen) {
                this.touchSeen = true;
                this._updateTouchVisibility();
            }
        } else if (e.pointerType === 'mouse') {
            this._setDevice('mouse');
        }
    }

    _setDevice(d) {
        if (this.lastDevice === d) return;
        this.lastDevice = d;
        if (this.onDevice) this.onDevice(d);
    }

    // ---------------------------------------------------------------- gamepad

    /** Reads the first connected gamepad; call once per frame (play and menus). */
    poll(now = performance.now()) {
        const pads = navigator.getGamepads ? navigator.getGamepads() : [];
        let gp = null;
        for (const p of pads || []) if (p && p.connected) { gp = p; break; }
        const pad = this.pad;
        if (!gp) {
            if (pad.connected) Object.assign(pad, { connected: false, steer: 0, gas: false, brake: false, left: false, right: false });
            this._nav.dir = null;
            return;
        }
        pad.connected = true;
        pad.id = gp.id;
        const b = (i) => {
            const x = gp.buttons[i];
            return x ? (typeof x === 'object' ? x.value > 0.3 || x.pressed : x > 0.3) : false;
        };
        const ax = gp.axes[0] || 0;
        const dz = this.settings.padDeadzone;
        const mag = Math.abs(ax);
        let steer = 0;
        if (mag > dz) {
            let t = Math.min(1, (mag - dz) / (1 - dz));
            t = 0.65 * t + 0.35 * t * t;   // a little finer near the centre
            steer = Math.sign(ax) * Math.min(1, t * this.settings.padSensitivity) * STEER_MAX;
        }
        pad.steer = steer;
        pad.left = b(BTN.LEFT);
        pad.right = b(BTN.RIGHT);
        pad.gas = b(BTN.RT) || b(BTN.A);
        pad.brake = b(BTN.LT) || b(BTN.X);
        let any = mag > 0.5 || pad.gas || pad.brake;
        for (let i = 0; i < gp.buttons.length; i++) {
            const now2 = b(i);
            const was = !!this._padPrev[i];
            if (now2 && !was) {
                any = true;
                for (const [btn, action] of this.tas ? PAD_EDGES_TAS : PAD_EDGES) if (btn === i) this.edges.add(action);
                if (i === BTN.A) this._nav.edges.add('accept');
                if (i === BTN.B) this._nav.edges.add('back');
            }
            this._padPrev[i] = now2;
        }
        if (any) this._setDevice('gamepad');
        // Menu navigation: D-pad or left stick, with key-like auto repeat.
        const ay = gp.axes[1] || 0;
        let dir = null;
        if (b(BTN.UP) || ay < -0.6) dir = 'up';
        else if (b(BTN.DOWN) || ay > 0.6) dir = 'down';
        else if (b(BTN.LEFT) || ax < -0.6) dir = 'left';
        else if (b(BTN.RIGHT) || ax > 0.6) dir = 'right';
        const nav = this._nav;
        if (dir !== nav.dir) {
            nav.dir = dir;
            if (dir) {
                nav.edges.add(dir);
                nav.next = now + NAV_REPEAT_DELAY;
            }
        } else if (dir && now >= nav.next) {
            nav.edges.add(dir);
            nav.next = now + NAV_REPEAT;
        }
    }

    /** Gamepad menu edges since the last call: 'up'|'down'|'left'|'right'|'accept'|'back'. */
    navEdges() {
        const out = [...this._nav.edges];
        this._nav.edges.clear();
        return out;
    }

    // ---------------------------------------------------------------- touch

    touchEnabled() {
        const mode = this.settings.touchControls;
        if (mode === 'on') return true;
        if (mode === 'off') return false;
        let coarse = false;
        try {
            coarse = window.matchMedia('(pointer: coarse)').matches;
        } catch (e) { /* ignore */ }
        return coarse || this.touchSeen;
    }

    /** Builds the on-screen pad (once) into `parent`; it shows only in play on touch devices. */
    mountTouch(parent = document.body) {
        if (this.touchEl) return this.touchEl;
        const btn = (action, label, iconName, cls) => h('button.pt-touch-btn', {
            class: cls, type: 'button', 'aria-label': label, dataset: { action },
            html: iconName ? iconSvg(iconName, 30) : '',
        }, iconName ? null : label);
        const el = h('div.pt-touch.pt-hidden', { 'aria-hidden': 'true' },
            h('div.pt-touch-left',
                btn('left', 'Steer left', 'back', 'steer'),
                btn('right', 'Steer right', 'next', 'steer')),
            h('div.pt-touch-right',
                h('div.pt-touch-col',
                    btn('respawn', 'Respawn', 'retry', 'small'),
                    btn('brake', 'Brake', null, 'brake')),
                btn('gas', 'Gas', null, 'gas')),
            h('div.pt-touch-top',
                btn('cameraCycle', 'Camera', 'camera', 'small'),
                btn('pause', 'Pause', 'pause', 'small')),
            h('div.pt-touch-tas',
                btn('tasPrev', 'Previous marker', 'back', 'small'),
                btn('tasMark', 'Drop marker', 'flag', 'small'),
                btn('tasRewind', 'Rewind to marker', 'rewind', 'small'),
                btn('tasNext', 'Next marker', 'next', 'small')));
        el.classList.toggle('tas', this.tas);
        el.addEventListener('pointerdown', (e) => {
            const b = e.target.closest('.pt-touch-btn');
            if (!b) return;
            e.preventDefault();
            const action = b.dataset.action;
            try {
                b.setPointerCapture(e.pointerId);
            } catch (err) { /* ignore */ }
            this.touchPointers.set(e.pointerId, action);
            b.classList.add('down');
            if (HOLD.includes(action)) this.touch[action] = this.taps[action] = true;
            else this.edges.add(action);
        });
        const release = (e) => {
            const action = this.touchPointers.get(e.pointerId);
            if (!action) return;
            this.touchPointers.delete(e.pointerId);
            if (HOLD.includes(action)) {
                // Another finger may still hold the same control.
                this.touch[action] = [...this.touchPointers.values()].includes(action);
            }
            for (const b of el.querySelectorAll(`[data-action="${action}"]`)) {
                if (![...this.touchPointers.values()].includes(action)) b.classList.remove('down');
            }
        };
        el.addEventListener('pointerup', release);
        el.addEventListener('pointercancel', release);
        el.addEventListener('lostpointercapture', release);
        el.addEventListener('contextmenu', (e) => e.preventDefault());
        parent.appendChild(el);
        this.touchEl = el;
        this._updateTouchVisibility();
        return el;
    }

    _updateTouchVisibility() {
        if (!this.touchEl) return;
        const show = this.active && this.touchEnabled();
        this.touchEl.classList.toggle('pt-hidden', !show);
        document.documentElement.classList.toggle('pt-touch-on', show);
        if (!show) {
            this.touchPointers.clear();
            for (const k of Object.keys(this.touch)) this.touch[k] = false;
            for (const b of this.touchEl.querySelectorAll('.down')) b.classList.remove('down');
        }
    }
}
