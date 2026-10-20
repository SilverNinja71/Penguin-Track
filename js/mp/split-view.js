// Split-screen: two players on one keyboard (P1 WASD + R, P2 arrows + Enter;
// gamepads go to P1 then P2), two Sims stepped together by app.loop, two
// chase cameras, a mini HUD per view. Each player sees the other as a ghost:
// both cars exist twice (solid and ghost) and a per-viewport hook swaps them.
import { buildWorld } from '../core/track.js';
import { Autopilot } from '../core/autopilot.js';
import { formatTime } from '../core/format.js';
import { lerpCarSnapshot } from '../core/replay.js';
import { h, setText } from '../game/dom.js';
import { makeCarView } from '../game/ghost.js';
import { speedValue } from '../game/settings.js';
import { ico, trackSelect, findTrackItem, loadPrefs, savePrefs, field, swatch } from './common.js';
import { SplitInput, allSplitCodes } from './splitinput.js';
import { Racer, Countdown } from './racer.js';
import { compareRuns } from './scoring.js';

const COLORS = ['#ff5d6c', '#5aa8ff'];
const GHOST_COLORS = ['#ffc2ca', '#bcdcff'];
const RESULTS_AFTER = 140;   // ticks after the last finish, like the play screen
const LAYOUTS = {
    rows: [{ x: 0, y: 0, w: 1, h: 0.5 }, { x: 0, y: 0.5, w: 1, h: 0.5 }],
    columns: [{ x: 0, y: 0, w: 0.5, h: 1 }, { x: 0.5, y: 0, w: 0.5, h: 1 }],
};

// Wins carried from rematch to rematch while the screen lives.
const tally = { key: '', wins: [0, 0] };

export function createSplitView(app, nav) {
    const prefs = loadPrefs(app);
    const cfg = {
        track: prefs.splitTrack && findTrackItem(app, prefs.splitTrack) ? prefs.splitTrack : 'A01',
        names: Array.isArray(prefs.splitNames) && prefs.splitNames.length === 2 ? prefs.splitNames.slice() : ['Player 1', 'Player 2'],
        layout: prefs.splitLayout === 'columns' ? 'columns' : 'rows',
    };
    let race = null;
    const view = {
        el: h('div.mp-view.mp-split'),
        dispose() {
            if (race) race.dispose();
            race = null;
        },
        back() {
            if (race) {
                race.togglePause();
                return true;
            }
            return false;
        },
        onKey(e) {
            return race ? race.onKey(e) : false;
        },
    };

    const startRace = () => {
        const track = app.catalog.getTrack(cfg.track);
        if (!track) return app.toast("That track couldn't be found.", { kind: 'bad' });
        if (app.renderer.isNull) return app.toast('Split-screen needs a 3D view (WebGL).', { kind: 'bad' });
        let world;
        try {
            world = buildWorld(track);
        } catch (e) {
            return app.toast(`This track can't be built: ${e.message}`, { kind: 'bad' });
        }
        if (!world.spawn || !world.route) return app.toast("This track can't be finished yet.", { kind: 'bad' });
        const key = `${cfg.track}|${cfg.names.join('|')}`;
        if (tally.key !== key) Object.assign(tally, { key, wins: [0, 0] });
        nav.fullscreen(true);
        race = new SplitRace(app, {
            track, world, names: cfg.names.slice(), layout: cfg.layout,
            onQuit: () => {
                race.dispose();
                race = null;
                nav.fullscreen(false);
                nav.menus();
                render();
            },
        });
        view.el.replaceChildren(race.el);
        race.start();
    };

    const render = () => {
        const names = cfg.names.map((n, i) => h('div.mp-player-row',
            swatch(COLORS[i]),
            h('input.pt-input', { value: n, maxlength: 16, 'aria-label': `Player ${i + 1} name`, oninput: (e) => { cfg.names[i] = e.target.value; } })));
        const sel = trackSelect(app, { value: cfg.track, onchange: (v) => { cfg.track = v; } });
        const layout = h('select.pt-input', { 'aria-label': 'Screen split', onchange: (e) => { cfg.layout = e.target.value; } },
            h('option', { value: 'rows' }, 'Top / bottom'),
            h('option', { value: 'columns' }, 'Left / right'));
        layout.value = cfg.layout;
        const pads = h('div.mp-pads.pt-muted');
        const go = () => {
            cfg.names = cfg.names.map((n, i) => n.trim().slice(0, 16) || `Player ${i + 1}`);
            savePrefs(app, { splitTrack: cfg.track, splitNames: cfg.names, splitLayout: cfg.layout });
            startRace();
        };
        view.el.replaceChildren(h('div.mp-columns',
            h('section.pt-panel.mp-card',
                h('h2.pt-subtitle', ico('gamepad', 22), 'Two penguins, one screen'),
                h('p.pt-muted.mp-lead', 'Race side by side from the same countdown. You never bump into each other: your rival is a ghost on your half of the screen.'),
                names,
                h('div.mp-form-row', field('Track', sel), field('Split', layout)),
                h('div.pt-row.mp-actions', h('button.pt-btn.primary.big', { type: 'button', 'data-autofocus': true, onclick: go }, ico('flag', 22), 'Start race'))),
            h('section.pt-panel.mp-card',
                h('h3.mp-card-title', 'Controls'),
                h('table.mp-table.mp-keys-table', h('tbody',
                    h('tr', h('th'), h('th', swatch(COLORS[0]), 'Player 1'), h('th', swatch(COLORS[1]), 'Player 2')),
                    h('tr', h('td.pt-muted', 'Gas / brake'), h('td', kbd('W'), kbd('S')), h('td', kbd('↑'), kbd('↓'))),
                    h('tr', h('td.pt-muted', 'Steer'), h('td', kbd('A'), kbd('D')), h('td', kbd('←'), kbd('→'))),
                    h('tr', h('td.pt-muted', 'Respawn'), h('td', kbd('R')), h('td', kbd('Enter'))),
                    h('tr', h('td.pt-muted', 'Both'), h('td', { colspan: 2 }, kbd('⌫'), ' restart  ', kbd('Esc'), ' pause')))),
                pads)));
        const showPads = () => {
            if (!pads.isConnected) return;
            const list = navigator.getGamepads ? [...navigator.getGamepads()].filter((p) => p && p.connected) : [];
            setText(pads, list.length ? `Gamepads: ${list.slice(0, 2).map((p, i) => `P${i + 1} ← ${p.id.split('(')[0].trim().slice(0, 28)}`).join(', ')}` : 'Gamepads join automatically: the first one drives Player 1, the second Player 2.');
            setTimeout(showPads, 1000);
        };
        showPads();
        const f = view.el.querySelector('[data-autofocus]');
        requestAnimationFrame(() => f && f.isConnected && f.focus({ preventScroll: true }));
    };
    render();
    return view;
}

const kbd = (k) => h('span.pt-kbd', k);

class SplitRace {
    constructor(app, { track, world, names, layout, onQuit }) {
        this.app = app;
        this.track = track;
        this.world = world;
        this.names = names;
        this.layout = layout;
        this.onQuit = onQuit;
        this.input = new SplitInput({ deadzone: app.settings.padDeadzone, sensitivity: app.settings.padSensitivity });
        this.codes = allSplitCodes();
        this.racers = names.map((n) => new Racer(world, { name: n }));
        // ?autopilot=1 drives both cars (headless checks), like the play screen.
        this.pilots = app.debug.autopilot ? names.map((_, i) => new Autopilot(world, i ? { gripMargin: 0.85 } : {})) : null;
        this.countdown = new Countdown();
        this.state = 'countdown';     // 'countdown' | 'racing' | 'paused' | 'results'
        this.views = [makeCarView(), makeCarView()];
        this.inps = [{}, {}];
        this.after = 0;
        this.disposed = false;
        this.el = this._build();
    }

    start() {
        const { app, world, track } = this;
        app.backdrop.stop();
        app.setMusic(false);
        app.loadWorld(world, track);
        const r = app.renderer;
        this.solid = [r.addCar({ kind: 'player', color: COLORS[0] }), r.addCar({ kind: 'ai', color: COLORS[1] })];
        this.ghost = this.names.map((n, i) => r.addCar({ kind: 'ghost', color: GHOST_COLORS[i], label: n }));
        r.setCameraMode('chase', this.solid[0]);
        this.cam2 = r.createCamera('chase', this.solid[1]);
        const rects = LAYOUTS[this.layout];
        r.setViewports(rects.map((rc, i) => ({ ...rc, camera: i === 0 ? r.camera : this.cam2, before: () => this._showFor(i) })));
        this._onDown = (e) => {
            if (e.metaKey || e.ctrlKey || e.altKey || this.state === 'results' || this.state === 'paused') return;
            if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
            if (this.codes.has(e.code)) {
                this.input.keydown(e.code, e.repeat);
                e.preventDefault();
                e.stopPropagation();
            }
        };
        this._onUp = (e) => this.input.keyup(e.code);
        this._onBlur = () => this.input.releaseAll();
        this._onVis = () => { if (document.hidden && this.state !== 'paused' && this.state !== 'results') this.pause(); };
        window.addEventListener('keydown', this._onDown, true);
        window.addEventListener('keyup', this._onUp, true);
        window.addEventListener('blur', this._onBlur);
        document.addEventListener('visibilitychange', this._onVis);
        // The shell's gamepad menu navigation stays quiet while controls are active.
        app.controls.setActive(true);
        this.restart();
        if (app.debug.fast) {
            app.loop.timeScale = app.debug.fast;
            app.loop.maxTicksPerFrame = Math.ceil(25 * app.debug.fast * 4);
        }
        app.loop.start(() => this.tick(), (a, dt) => this.frame(a, dt));
    }

    _showFor(i) {
        this.solid[i].setVisible(true);
        this.ghost[i].setVisible(false);
        this.solid[1 - i].setVisible(false);
        this.ghost[1 - i].setVisible(true);
    }

    restart() {
        for (const r of this.racers) r.reset();
        if (this.pilots) for (const p of this.pilots) p.reset();
        this.countdown.reset();
        this.state = 'countdown';
        this.after = 0;
        this.input.clearEdges();
        for (const hud of this.huds) hud.reset();
        this.resultsEl.classList.add('pt-hidden');
        this.pauseEl.classList.add('pt-hidden');
        this.app.controls.setActive(true);
        this.app.audio.stopCar();
        this.app.loop.resync();
    }

    // ---------------------------------------------------------- ticks

    tick() {
        if (this.state === 'paused' || this.disposed) return;
        const { app } = this;
        if (this.state === 'countdown') {
            const n = this.countdown.tick();
            if (n != null) {
                if (n === 'GO') {
                    app.audio.go();
                    app.renderer.setCountdown(0);
                    for (const r of this.racers) r.go();
                    this.state = 'racing';
                    this.input.clearEdges();
                    setTimeout(() => !this.disposed && this.state !== 'countdown' && app.renderer.setCountdown(null), 1500);
                } else {
                    app.audio.countdown(n);
                    app.renderer.setCountdown(n);
                }
                this._count(n);
            }
            return;
        }
        this.racers.forEach((racer, i) => {
            let inp = null;
            if (racer.state === 'racing' && this.state === 'racing') inp = this.pilots ? this.pilots[i].act(racer.sim) : this.input.input(i, this.inps[i]);
            const events = racer.step(inp);
            if (events.length) this._events(i, events);
        });
        if (this.state === 'racing' && this.racers.every((r) => r.state === 'finished')) {
            if (++this.after >= RESULTS_AFTER) this.showResults();
        }
    }

    _events(i, events) {
        const { app } = this;
        app.renderer.handleEvents(events, this.solid[i]);
        app.audio.handleEvents(events);
        const hud = this.huds[i];
        const me = this.racers[i], other = this.racers[1 - i];
        for (const ev of events) {
            if (ev.type === 'checkpoint') {
                // Splits against the rival at the same checkpoint, when they got there first.
                const k = me.sim.checkpointTimes.length - 1;
                const theirs = other.sim.checkpointTimes[k];
                hud.flash(formatTime(ev.timeMs), Number.isFinite(theirs) ? ev.timeMs - theirs : null);
            } else if (ev.type === 'missingCheckpoints') {
                hud.flash(`${ev.missing} checkpoint${ev.missing === 1 ? '' : 's'} missing!`, null, 'bad');
            } else if (ev.type === 'finish') {
                const theirs = other.result ? other.result.timeMs : null;
                hud.finish(ev.timeMs, theirs == null ? null : ev.timeMs - theirs, theirs == null && other.state === 'racing');
            }
        }
    }

    _count(n) {
        const el = this.countEl;
        el.className = 'mp-split-count ' + (n === 'GO' ? 'go' : '');
        setText(el, n === 'GO' ? 'GO!' : String(n));
        el.classList.remove('pt-hidden');
        void el.offsetWidth;
        el.classList.add('pop');
        if (n === 'GO') setTimeout(() => el.classList.add('pt-hidden'), 700);
    }

    // ---------------------------------------------------------- frames

    frame(alpha, dt) {
        if (this.disposed) return;
        const { app } = this;
        this.input.pollPads(navigator.getGamepads ? navigator.getGamepads() : []);
        if (this.state !== 'results') {
            if (this.input.pressed('pause')) this.togglePause();
            else if (this.input.pressed('restart') && this.state !== 'paused') this.restart();
        } else {
            this.input.clearEdges();
        }
        const frozen = this.state === 'countdown' || this.state === 'paused';
        const a = frozen ? 1 : alpha;
        this.racers.forEach((r, i) => {
            const v = lerpCarSnapshot(r.prev, r.cur, a, this.views[i]);
            this.solid[i].setPose(r.prev, r.cur, a);
            this.ghost[i].setPose(r.prev, r.cur, a);
            this.huds[i].update(r, v);
        });
        if (this.state === 'racing') app.audio.updateCar(this.views[0], dt, this.racers[0].sim.lastInput);
        app.renderer.render(dt);
    }

    // ---------------------------------------------------------- pause / results

    togglePause() {
        if (this.state === 'results') return;
        if (this.state === 'paused') this.resume();
        else this.pause();
    }

    pause() {
        if (this.state === 'paused' || this.state === 'results') return;
        this.pausedFrom = this.state;
        this.state = 'paused';
        this.input.releaseAll();
        this.app.audio.stopCar();
        this.pauseEl.classList.remove('pt-hidden');
        this.pauseEl.querySelector('[data-autofocus]').focus({ preventScroll: true });
    }

    resume() {
        if (this.state !== 'paused') return;
        this.state = this.pausedFrom || 'racing';
        this.pauseEl.classList.add('pt-hidden');
        if (document.activeElement && this.pauseEl.contains(document.activeElement)) document.activeElement.blur();
        this.input.clearEdges();
        this.app.loop.resync();
    }

    showResults() {
        if (this.state === 'results') return;
        this.state = 'results';
        this.pauseEl.classList.add('pt-hidden');
        this.app.audio.stopCar();
        this.app.controls.setActive(false);
        const runs = this.racers.map((r) => (r.result ? { timeMs: r.result.timeMs, respawns: r.result.respawns } : null));
        const platform = this.track.mode === 'platform';
        const c = compareRuns(runs[0], runs[1], platform);
        const winner = !runs[0] && !runs[1] ? -1 : c < 0 ? 0 : c > 0 ? 1 : 2;
        if (winner === 0 || winner === 1) tally.wins[winner]++;
        const cps = Math.max(...this.racers.map((r) => r.sim.checkpointTimes.length));
        const rows = [];
        for (let k = 0; k < cps; k++) {
            const t = this.racers.map((r) => r.sim.checkpointTimes[k]);
            const d = Number.isFinite(t[0]) && Number.isFinite(t[1]) ? t[0] - t[1] : null;
            rows.push(h('tr', h('td.pt-muted', `CP ${k + 1}`), h('td.pt-mono', formatTime(t[0])), h('td.pt-mono', formatTime(t[1])),
                h('td.pt-mono', { class: d == null ? '' : d < 0 ? 'p1' : d > 0 ? 'p2' : '' }, d == null ? '' : formatTime(Math.abs(d), { style: 'short' }))));
        }
        rows.push(h('tr.fin', h('td', 'Finish'), ...runs.map((r) => h('td.pt-mono', r ? formatTime(r.timeMs) : 'DNF')),
            h('td.pt-mono', { class: winner === 0 ? 'p1' : winner === 1 ? 'p2' : '' }, runs[0] && runs[1] ? formatTime(Math.abs(runs[0].timeMs - runs[1].timeMs), { style: 'short' }) : '')));
        const title = winner === 2 ? 'Dead heat!' : winner < 0 ? 'Nobody made it to the finish' : `${this.names[winner]} wins!`;
        this.resultsEl.replaceChildren(h('div.pt-panel.mp-split-results-panel', { role: 'dialog', 'aria-label': 'Race results' },
            h('div.mp-kicker', this.track.name),
            h('h2.mp-turn-track', winner >= 0 && winner < 2 ? h('span', swatch(COLORS[winner]), title) : title),
            h('table.mp-table.mp-split-table', h('thead', h('tr', h('th'), ...this.names.map((n, i) => h('th', swatch(COLORS[i]), n)), h('th', 'gap'))), h('tbody', rows)),
            h('div.mp-tally', 'Wins this session: ', this.names[0], ' ', h('b.pt-mono', `${tally.wins[0]} – ${tally.wins[1]}`), ' ', this.names[1]),
            h('div.pt-row.mp-actions',
                h('button.pt-btn.primary', { type: 'button', 'data-autofocus': true, onclick: () => this.restart() }, ico('retry', 20), 'Rematch', h('span.pt-kbd', '⌫')),
                h('button.pt-btn.ghost', { type: 'button', 'data-sound': 'back', onclick: () => this.onQuit() }, ico('back', 20), 'Change track'))));
        this.resultsEl.classList.remove('pt-hidden');
        const f = this.resultsEl.querySelector('[data-autofocus]');
        requestAnimationFrame(() => f.isConnected && f.focus({ preventScroll: true }));
    }

    onKey(e) {
        if (this.state === 'results' && (e.key === 'Backspace' || e.key === 'Delete')) {
            this.restart();
            return true;
        }
        if (e.key === 'Escape') {
            if (this.state === 'results') this.onQuit();
            else if (this.state === 'paused') this.resume();
            return true;
        }
        // Racing keys were handled (and stopped) by the capture listener.
        return this.state === 'racing' || this.state === 'countdown';
    }

    // ---------------------------------------------------------- DOM

    _build() {
        const rects = LAYOUTS[this.layout];
        this.huds = this.names.map((n, i) => new MiniHud(this.app, n, COLORS[i], rects[i], this.world.checkpointCount || 0, this.track));
        this.countEl = h('div.mp-split-count.pt-hidden', { 'aria-live': 'assertive' });
        const btn = (label, icon, onclick, cls = '', autofocus = false) => h('button.pt-btn.big', { type: 'button', class: cls, onclick, 'data-autofocus': autofocus || null }, ico(icon, 22), label);
        this.pauseEl = h('div.mp-split-pause.pt-hidden', { role: 'dialog', 'aria-label': 'Paused' },
            h('div.pt-panel.mp-split-pause-panel',
                h('h2.pt-title', 'Paused'),
                h('div.pt-col',
                    btn('Resume', 'play', () => this.resume(), 'primary', true),
                    btn('Restart both', 'retry', () => this.restart()),
                    btn('End race', 'flag', () => this.showResults()),
                    btn('Change track', 'back', () => this.onQuit(), 'ghost'))));
        this.resultsEl = h('div.mp-split-results.pt-hidden');
        return h('div.mp-split-stage', { class: this.layout }, this.huds.map((x) => x.el), this.countEl, this.pauseEl, this.resultsEl);
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        const { app } = this;
        window.removeEventListener('keydown', this._onDown, true);
        window.removeEventListener('keyup', this._onUp, true);
        window.removeEventListener('blur', this._onBlur);
        document.removeEventListener('visibilitychange', this._onVis);
        app.loop.stop();
        app.loop.timeScale = 1;
        app.loop.maxTicksPerFrame = 25;
        const r = app.renderer;
        r.setViewports(null);
        if (this.cam2) r.removeCamera(this.cam2);
        for (const c of [...(this.solid || []), ...(this.ghost || [])]) r.removeCar(c);
        r.setCountdown(null);
        app.audio.stopCar();
        app.controls.setActive(false);
        for (const hud of this.huds) hud.dispose();
    }
}

/** Time, checkpoints and speed for one half of the screen. */
class MiniHud {
    constructor(app, name, color, rect, cpTotal, track) {
        this.app = app;
        this.cpTotal = cpTotal;
        this.laps = track.laps || 1;
        this.timeEl = h('div.mp-mh-time.pt-mono', '0:00.00');
        this.cpEl = h('div.mp-mh-cp.pt-mono');
        this.speedEl = h('div.mp-mh-speed.pt-mono', '0');
        this.unitEl = h('span.mp-mh-unit', app.settings.units === 'mph' ? 'mph' : 'km/h');
        this.flashEl = h('div.mp-mh-flash.pt-hidden');
        this.el = h('div.mp-mh', {
            style: { left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%`, '--c': color },
        },
        h('div.mp-mh-name', swatch(color), name),
        h('div.mp-mh-tc', this.cpEl),
        this.flashEl,
        h('div.mp-mh-bc', this.timeEl),
        h('div.mp-mh-br', this.speedEl, this.unitEl));
        this._last = {};
        this._timer = 0;
    }

    reset() {
        this._last = {};
        clearTimeout(this._timer);
        this.flashEl.classList.add('pt-hidden');
        this.el.classList.remove('done');
    }

    update(racer, view) {
        const L = this._last;
        const t = racer.timeMs;
        if (L.t !== t) setText(this.timeEl, formatTime((L.t = t)));
        const spd = Math.round(speedValue(Math.abs(view.speedKmh || 0), this.app.settings.units));
        if (L.s !== spd) setText(this.speedEl, (L.s = spd));
        const cp = racer.sim.collectedCount;
        const lap = Math.min(racer.sim.lap, this.laps);
        if (L.cp !== cp || L.lap !== lap) {
            L.cp = cp;
            L.lap = lap;
            const parts = [];
            if (this.cpTotal) parts.push(`CP ${cp}/${this.cpTotal}`);
            if (this.laps > 1) parts.push(`Lap ${lap}/${this.laps}`);
            setText(this.cpEl, parts.join('  ·  '));
            this.cpEl.classList.toggle('pt-hidden', !parts.length);
        }
    }

    flash(text, diff = null, kind = '') {
        const d = diff == null ? '' : ` ${formatTime(diff, { style: 'short', sign: true })}`;
        this.flashEl.className = 'mp-mh-flash ' + kind + (diff == null ? '' : diff < 0 ? ' ahead' : diff > 0 ? ' behind' : '');
        setText(this.flashEl, text + d);
        clearTimeout(this._timer);
        this._timer = setTimeout(() => this.flashEl.classList.add('pt-hidden'), 2600);
    }

    finish(ms, diff, waiting) {
        this.flash(`Finish ${formatTime(ms)}`, diff, 'finish');
        clearTimeout(this._timer);
        this.el.classList.add('done');
        if (waiting) {
            this._timer = setTimeout(() => setText(this.flashEl, `${formatTime(ms)} · waiting for your rival`), 2200);
        }
    }

    dispose() {
        clearTimeout(this._timer);
    }
}
