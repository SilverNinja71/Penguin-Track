// A race on one track: countdown, 100 Hz simulation driven by the controls (or
// the core Autopilot with ?autopilot=1), input recording, ghosts, HUD, pause
// menu, respawn/restart, and the hand-off to the results screen.
import { Sim } from '../core/sim.js';
import { Recorder, snapshotCar, lerpCarSnapshot } from '../core/replay.js';
import { Autopilot } from '../core/autopilot.js';
import { formatTime } from '../core/format.js';
import { h } from './dom.js';
import { iconSvg } from './icons.js';
import { Hud } from './hud.js';
import { GhostRun, makeCarView } from './ghost.js';
import { getRecord, submitRun, awardMedalGold } from './records.js';
import { CAMERAS } from './settings.js';
import { openQuickSettings } from './settings-screen.js';
import { modalOpen } from './ui.js';

const COUNT_STEP = 50;              // ticks between 3, 2, 1 and GO (1.5 s in all, like TM)
const COUNT_TICKS = COUNT_STEP * 3;
const FINISH_HOLD = 140;            // ticks of coasting past the line before the results show
const STAGE_ORBIT_AFTER = 40;

export class RaceSession {
    constructor(app, screenEl, { track, world, mode, params }) {
        this.app = app;
        this.screenEl = screenEl;
        this.track = track;
        this.world = world;
        this.mode = mode;
        this.params = params;
        this.saves = (mode === 'campaign' || mode === 'custom') && params.saveRecords !== false;
        this.inp = { steer: 0, gas: false, brake: false, respawn: false };
        this.prev = null;
        this.cur = null;
        this.view = makeCarView();
        this.hudOpts = { ghostPositions: [] };   // reused every frame
        this.state = 'countdown';
        this.cd = 0;
        this.finishTicks = 0;
        this.respawnQueued = false;
        this.ghostsOn = true;
        this.handoff = false;
        this.disposed = false;
        this.camIndex = Math.max(0, CAMERAS.findIndex((c) => c.id === app.settings.camera));
    }

    start() {
        const { app, world, track } = this;
        const r = app.renderer;
        app.loadWorld(world, track);
        this.car = r.addCar({ kind: 'player' });
        this.sim = new Sim(world);
        this.recorder = new Recorder();
        this.pilot = app.debug.autopilot ? new Autopilot(world) : null;
        this.record = this.saves || this.mode === 'test' ? getRecord(app.storage, track.id, world.hash) : null;
        this._buildGhosts();
        this.hud = new Hud(app, {
            track, world, mode: this.mode,
            pbRecord: this.record,
            targets: app.catalog.medalTargets(track),
            medalRank: app.catalog.medalRank,
            showMinimap: app.settings.showMinimap,
            units: app.settings.units,
        });
        this.screenEl.appendChild(this.hud.el);
        if (this.pilot) this.screenEl.appendChild(h('div.play-autopilot', h('span.pt-ico', { html: iconSvg('brain', 16) }), 'Autopilot driving'));
        this.pauseEl = this._buildPause();
        this.screenEl.appendChild(this.pauseEl);
        this.cur = snapshotCar(this.sim.car);
        this.prev = snapshotCar(this.sim.car);
        this._applyCamera();
        app.setMusic(false);
        app.controls.setActive(true);
        this._onVis = () => {
            if (document.hidden && (this.state === 'racing' || this.state === 'countdown')) this.pause();
        };
        document.addEventListener('visibilitychange', this._onVis);
        this.restart(true);
        if (app.debug.fast) {
            // ?fast=N: N× game speed for headless tests (more ticks allowed per frame).
            app.loop.timeScale = app.debug.fast;
            app.loop.maxTicksPerFrame = Math.ceil(25 * app.debug.fast * 4);
        }
        app.loop.start(() => this.tick(), (a, dt) => this.frame(a, dt));
        if (typeof this.params.onStart === 'function') this.params.onStart(this);
    }

    _buildGhosts() {
        const { app, world, track } = this;
        for (const g of this.ghosts || []) app.renderer.removeCar(g.car);
        this.ghosts = [];
        const add = (replay, label, kind, color) => {
            if (!replay || (replay.trackHash && replay.trackHash !== world.hash)) return;
            try {
                const run = new GhostRun(world, replay, { label, kind });
                // Name tags only on other people's ghosts: your own PB and the Emperor start
                // on top of you, and their colours already tell them apart.
                const car = app.renderer.addCar({ kind: 'ghost', color, label: kind === 'extra' ? label : '' });
                this.ghosts.push({ run, car, kind });
            } catch (e) {
                console.warn('[penguintrack] ghost skipped:', e.message);
            }
        };
        if (app.settings.showGhost && this.record && this.record.replay) add(this.record.replay, 'Personal best', 'pb', '#cfeaff');
        if (app.settings.showEmperorGhost) add(app.catalog.authorReplay(track.id), 'Emperor', 'emperor', '#6fd3ff');
        for (const g of this.params.ghosts || []) {
            const replay = g && g.replay ? g.replay : g;
            add(replay, (g && g.label) || replay.name || 'Ghost', 'extra', (g && g.color) || '#ffd54a');
        }
        // Splits compare against the personal best (or the first ghost when there is no PB).
        const pbGhost = this.ghosts.find((g) => g.kind === 'pb');
        this.pbSplits = this.record && Array.isArray(this.record.splits) && this.record.splits.length
            ? this.record.splits
            : pbGhost ? pbGhost.run.checkpointTimes : this.ghosts[0] ? this.ghosts[0].run.checkpointTimes : null;
    }

    /** Back to the line with a fresh countdown (Backspace / Delete, also right after finishing). */
    restart(first = false) {
        const { app, sim } = this;
        // A host screen (hot-seat) may refuse another run, e.g. when the attempts are used up.
        if (!first && typeof this.params.onRestart === 'function' && this.params.onRestart(this) === false) return;
        if (!first && this.newRecord) {
            // A new personal best becomes the ghost to beat, like Trackmania.
            this.record = getRecord(app.storage, this.track.id, this.world.hash);
            this._buildGhosts();
            this.hud.setPb(this.record);
        }
        this.newRecord = false;
        sim.reset();
        this.recorder.clear();
        if (this.pilot) this.pilot.reset();
        this.state = 'countdown';
        this.cd = 0;
        this.finishTicks = 0;
        this.respawnQueued = false;
        this.result = null;
        this.outcome = null;
        snapshotCar(sim.car, this.cur);
        snapshotCar(sim.car, this.prev);
        this.hud.reset();
        this._hidePause();
        app.controls.setActive(true);   // also when restarting from the pause menu
        app.audio.stopCar();
        app.loop.resync();
    }

    // ------------------------------------------------------------- ticks

    tick() {
        const st = this.state;
        if (st === 'paused') return;
        if (st === 'countdown') {
            if (this.cd % COUNT_STEP === 0) {
                const n = 3 - this.cd / COUNT_STEP;
                this.app.audio.countdown(n);
                this.hud.countdown(n);
                this._gateLights(n);
            }
            this.cd++;
            if (this.cd >= COUNT_TICKS) {
                this.state = 'racing';
                this.app.audio.go();
                this.hud.countdown('GO');
                this._gateLights(0);
                setTimeout(() => this.state !== 'countdown' && this._gateLights(null), 1500);
                setTimeout(() => this.hud && this.state !== 'countdown' && this.hud.countdown(null), 700);
                this.app.controls.pressed('respawn');   // a respawn pressed during the countdown means nothing
            }
            return;
        }
        const sim = this.sim;
        let input = null;
        if (st === 'racing') {
            input = this.pilot ? this.pilot.act(sim) : this.app.controls.input(this.inp);
            if (this.respawnQueued) {
                input.respawn = true;
                this.respawnQueued = false;
            }
        }
        const tmp = this.prev;
        this.prev = this.cur;
        this.cur = tmp;
        sim.step(input);
        if (st === 'racing') this.recorder.push(sim.lastInput);
        snapshotCar(sim.car, this.cur);
        const events = sim.events;
        if (events.length) this._events(events);
        if (this.state === 'finished' || this.state === 'stage') {
            this.finishTicks++;
            if (this.finishTicks === FINISH_HOLD && this.state === 'finished') this.toResults();
        }
    }

    /** Start-gate lights: 3, 2, 1, 0 (GO) or null (idle). */
    _gateLights(n) {
        this.app.renderer.setCountdown(n);
    }

    _events(events) {
        const { app, hud, sim } = this;
        let teleport = false;
        let sound = events;
        for (const ev of events) {
            switch (ev.type) {
                case 'respawn':
                    teleport = true;
                    break;
                case 'fall':
                    if (!this.pilot && this.state === 'racing') this.respawnQueued = true;
                    break;
                case 'checkpoint': {
                    const i = sim.checkpointTimes.length - 1;
                    const pb = this.pbSplits && Number.isFinite(this.pbSplits[i]) ? this.pbSplits[i] : null;
                    hud.split(ev.timeMs, pb == null ? null : ev.timeMs - pb);
                    // Sim events are shared: hand the audio a copy carrying the split, for a brighter or duller chime.
                    if (pb != null) sound = sound.map((e) => (e === ev ? { ...ev, diff: ev.timeMs - pb } : e));
                    break;
                }
                case 'missingCheckpoints':
                    hud.banner(`${ev.missing} checkpoint${ev.missing === 1 ? '' : 's'} missing!`, 'bad');
                    break;
                case 'lap':
                    hud.banner(ev.lap + 1 === sim.laps ? 'Final lap!' : `Lap ${ev.lap + 1}/${sim.laps}`, 'lap');
                    break;
                case 'fragileBreak':
                    hud.banner('Thin Ice cracked! Press Enter to respawn', 'bad', 3000);
                    break;
                case 'finish':
                    this._finish(ev);
                    break;
                default:
            }
        }
        if (teleport) snapshotCar(sim.car, this.prev);
        app.renderer.handleEvents(events, this.car);
        if (this.state !== 'stage') app.audio.handleEvents(sound);
    }

    _finish(ev) {
        const { app, sim, track, world } = this;
        this.state = 'finished';
        this.finishTicks = 0;
        const replay = this.recorder.toReplay({ sim, name: `${track.name} ${formatTime(ev.timeMs)}`, date: Date.now() });
        this.result = {
            finished: true, timeMs: ev.timeMs, respawns: sim.respawns,
            splits: sim.checkpointTimes.slice(), lapTimes: sim.lapTimes.slice(), replay,
            autopilot: !!this.pilot,
        };
        let pbBefore = this.record;
        if (this.saves) {
            this.outcome = submitRun(app.storage, app.catalog, track, world.hash, this.result);
            pbBefore = this.outcome.previous;
            this.newRecord = this.outcome.improved;
            // Debug autopilot runs keep their records but never earn gold.
            if (this.outcome.firstMedal && !this.pilot) {
                const paid = awardMedalGold(app.storage, app.catalog, track.id, this.outcome.medal);
                if (paid) this.outcome.gold = paid;
            }
        }
        this.result.pbBefore = pbBefore;
        const diff = pbBefore && Number.isFinite(pbBefore.bestMs) ? ev.timeMs - pbBefore.bestMs : null;
        const text = diff == null ? formatTime(ev.timeMs) : `${formatTime(ev.timeMs)}  ${formatTime(diff, { style: 'short', sign: true })}`;
        this.hud.banner(text, 'finish ' + (diff == null ? '' : diff <= 0 ? 'ahead' : 'behind'), 0);
        if (typeof this.params.onFinish === 'function') this.params.onFinish(this.result, this);
    }

    /** Shows the results; the 3D view keeps running behind them (stage hand-off). */
    toResults() {
        if (this.disposed || !this.result) return;
        this.handoff = true;
        this.state = 'stage';
        this.app.audio.stopCar();
        const stage = this._makeStage();
        this.app.goto('results', {
            track: this.track, mode: this.mode, result: this.result, outcome: this.outcome,
            playParams: this.params, stage,
        });
    }

    _makeStage() {
        // The finished sim keeps coasting with an orbit camera until results close.
        let t = 0;
        const stage = {
            tick: () => {
                this.tick();
                t++;
                if (t === STAGE_ORBIT_AFTER) this.app.renderer.setCameraMode('orbit', this.car);
            },
            frame: (a, dt) => this.frame(a, dt, true),
            dispose: () => this.dispose(true),
        };
        return stage;
    }

    // ------------------------------------------------------------- frames

    frame(alpha, dt, stageOnly = false) {
        const { app, sim } = this;
        if (!stageOnly) this._edges();
        const frozen = this.state === 'countdown' || this.state === 'paused';
        const a = frozen ? (this.state === 'paused' ? this.pauseAlpha ?? 1 : 1) : alpha;
        lerpCarSnapshot(this.prev, this.cur, a, this.view);
        this.car.setPose(this.prev, this.cur, a);
        const gt = sim.tick > 0 ? sim.tick - 1 + a : 0;
        const gpos = this.hudOpts.ghostPositions;
        gpos.length = 0;
        for (const g of this.ghosts) {
            g.car.setVisible(this.ghostsOn);
            if (!this.ghostsOn) continue;
            const v = g.run.viewAt(gt);
            g.car.setPose(v, v, 1);
            gpos.push(v.pos);
        }
        if (!stageOnly) this.hud.update(sim, this.view, this.hudOpts);
        if (this.state !== 'paused' && !stageOnly) app.audio.updateCar(this.view, dt, this.state === 'racing' ? sim.lastInput : null);
        app.renderer.render(dt);
    }

    _edges() {
        const c = this.app.controls;
        // Keys aimed at a dialog (Esc closing the quick settings) must not also drive the race.
        if (modalOpen()) {
            c.clearEdges();
            return;
        }
        if (c.pressed('pause')) {
            if (this.state === 'paused') this.resume();
            else this.pause();
            return;
        }
        if (this.state === 'paused') {
            c.clearEdges();
            return;
        }
        if (c.pressed('restart')) {
            this.restart();
            return;
        }
        if (this.state === 'finished' && c.pressed('respawn')) {
            this.toResults();
            return;
        }
        if (this.state === 'countdown') c.pressed('respawn');
        if (c.pressed('camera1')) this._setCamera(0);
        if (c.pressed('camera2')) this._setCamera(1);
        if (c.pressed('camera3')) this._setCamera(2);
        if (c.pressed('cameraCycle')) this._setCamera((this.camIndex + 1) % CAMERAS.length);
        if (c.pressed('ghost')) {
            this.ghostsOn = !this.ghostsOn;
            this.app.toast(this.ghostsOn ? 'Ghosts on' : 'Ghosts off', { icon: 'ghost', ms: 1200 });
        }
    }

    _setCamera(i) {
        this.camIndex = i;
        this._applyCamera();
    }

    _applyCamera() {
        this.app.renderer.setCameraMode(CAMERAS[this.camIndex].id, this.car);
    }

    // ------------------------------------------------------------- pause

    pause() {
        if (this.state === 'paused' || this.state === 'stage') return;
        this.pausedFrom = this.state;
        this.pauseAlpha = Math.min(1, this.app.loop.acc / 0.01);
        this.state = 'paused';
        this.app.controls.setActive(false);
        this.app.audio.stopCar();
        this.pauseEl.classList.remove('pt-hidden');
        const first = this.pauseEl.querySelector('[data-autofocus]');
        if (first) first.focus({ preventScroll: true });
    }

    resume() {
        if (this.state !== 'paused') return;
        this.state = this.pausedFrom || 'racing';
        this._hidePause();
        this.app.controls.setActive(true);
        this.app.loop.resync();
    }

    _hidePause() {
        if (this.pauseEl) this.pauseEl.classList.add('pt-hidden');
        if (document.activeElement && this.pauseEl && this.pauseEl.contains(document.activeElement)) document.activeElement.blur();
    }

    _buildPause() {
        const quitLabel = this.params.exitLabel || (this.mode === 'test' ? 'Back to editor' : 'Quit');
        const btn = (label, iconName, onclick, cls = '', keys = null) => h('button.pt-btn.big', { type: 'button', class: cls, onclick, 'data-autofocus': cls === 'primary' || null },
            h('span.pt-ico', { html: iconSvg(iconName, 22) }), label, keys ? h('span.pt-kbd', keys) : null);
        return h('div.play-pause.pt-hidden', { role: 'dialog', 'aria-label': 'Paused' },
            h('div.pt-panel.play-pause-panel',
                h('div.play-pause-head', h('h2.pt-title', 'Paused'), h('div.pt-muted', this.track.name)),
                h('div.pt-col',
                    btn('Resume', 'play', () => this.resume(), 'primary', 'Esc'),
                    btn('Restart', 'retry', () => this.restart(), '', '⌫'),
                    btn('Settings', 'gear', () => openQuickSettings(this.app)),
                    btn(quitLabel, 'back', () => this.quit(), 'ghost')),
                h('div.play-pause-hint.pt-muted',
                    h('span.pt-kbd', 'Enter'), ' respawn  ', h('span.pt-kbd', '1 2 3'), ' cameras  ', h('span.pt-kbd', 'G'), ' ghosts')));
    }

    /** Leaves the race (pause menu Quit): onExit when given, else back where it came from. */
    quit() {
        const { app, params } = this;
        if (typeof params.onExit === 'function') {
            this.state = 'paused';
            params.onExit(null);
            return;
        }
        app.goto(defaultExit(this.mode), defaultExitParams(this.mode, this.track));
    }

    dispose(force = false) {
        if (this.disposed) return;
        if (this.handoff && !force) return;   // the results screen owns the stage now
        this.disposed = true;
        document.removeEventListener('visibilitychange', this._onVis);
        const r = this.app.renderer;
        for (const g of this.ghosts || []) r.removeCar(g.car);
        if (this.car) r.removeCar(this.car);
        this.app.audio.stopCar();
        if (this.hud) this.hud.dispose();
        this.hud = null;
    }
}

export function defaultExit(mode) {
    return mode === 'campaign' ? 'campaign' : mode === 'test' ? 'editor' : mode === 'replay' ? 'replays' : 'mytracks';
}

export function defaultExitParams(mode, track) {
    if (mode === 'campaign') return { select: track.id };
    if (mode === 'test') return { track };
    if (mode === 'custom') return { select: track.id };
    return {};
}
