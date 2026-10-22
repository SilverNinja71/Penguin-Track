// Replay viewer (play screen, mode 'replay'): re-simulates a recorded run
// deterministically, with a timeline scrubber backed by savestates every
// second, playback speeds 0.25x-4x and chase / orbit / free / cockpit cameras.
import { Sim } from '../core/sim.js';
import { replayInputs, replayPhysics, snapshotCar, lerpCarSnapshot } from '../core/replay.js';
import { formatTime } from '../core/format.js';
import { h, setText, toggleClass, niceDate } from './dom.js';
import { iconSvg } from './icons.js';
import { Hud } from './hud.js';
import { makeCarView } from './ghost.js';

const SAVE_EVERY = 100;    // ticks between savestates: one second
const COAST = 200;         // ticks shown after the finish line
const SPEEDS = [0.25, 0.5, 1, 2, 4];
const CAMS = [
    { id: 'chase', label: 'Chase' },
    { id: 'orbit', label: 'Orbit' },
    { id: 'free', label: 'Free' },
    { id: 'cockpit', label: 'Cockpit' },
];

export class ReplaySession {
    constructor(app, screenEl, { track, world, replay, params }) {
        this.app = app;
        this.screenEl = screenEl;
        this.track = track;
        this.world = world;
        this.replay = replay;
        this.params = params;
        this.view = makeCarView();
        this.playing = true;
        this.speed = 1;
        this.cam = 0;
        this.dragging = false;
        this.disposed = false;
    }

    /** Throws a friendly Error when the replay does not fit this track. */
    prepare() {
        const { world, replay } = this;
        if (replay.trackHash && world.hash && replay.trackHash !== world.hash) {
            throw new Error('This replay was recorded on a different version of the track.');
        }
        this.inputs = replayInputs(replay);
        const laps = Number.isInteger(replay.laps) && replay.laps > 0 ? replay.laps : world.laps;
        const sim = new Sim(world, { laps, physics: replayPhysics(replay) });
        this.sim = sim;
        this.states = [];
        this.markers = [];
        this.finishTick = null;
        const total = this.inputs.length;
        for (;;) {
            if (sim.tick % SAVE_EVERY === 0) this.states.push(sim.getState());
            if (sim.finished ? sim.tick - this.finishTick >= COAST : sim.tick >= total) break;
            sim.step(sim.tick < total ? this.inputs[sim.tick] : null);
            for (const ev of sim.events) {
                if (ev.type === 'checkpoint') this.markers.push({ tick: sim.tick, kind: 'cp' });
                else if (ev.type === 'respawn') this.markers.push({ tick: sim.tick, kind: 'respawn' });
                else if (ev.type === 'lap') this.markers.push({ tick: sim.tick, kind: 'lap' });
                else if (ev.type === 'finish') {
                    this.finishTick = sim.tick;
                    this.markers.push({ tick: sim.tick, kind: 'finish' });
                }
            }
        }
        this.endTick = sim.tick;
        this.finishMs = sim.finished ? sim.finishTimeMs : null;
        this.respawns = sim.respawns;
        this.totalText = formatTime(this.finishMs ?? this.endTick * 10);
        sim.setState(this.states[0]);
    }

    start() {
        const { app, world, track, sim } = this;
        app.loadWorld(world, track);
        this.car = app.renderer.addCar({ kind: 'player' });
        this.cur = snapshotCar(sim.car);
        this.prev = snapshotCar(sim.car);
        this.hud = new Hud(app, {
            track, world, mode: 'replay', pbRecord: null,
            targets: app.catalog.medalTargets(track), medalRank: app.catalog.medalRank,
            showMinimap: app.settings.showMinimap, units: app.settings.units, laps: sim.laps,
        });
        this.hud.el.classList.add('replay');
        this.screenEl.appendChild(this.hud.el);
        this.screenEl.appendChild(this._buildBar());
        this._applyCamera();
        app.setMusic(false);
        app.loop.timeScale = this.speed;
        app.loop.start(() => this.tick(), (a, dt) => this.frame(a, dt));
        this._sync();
    }

    _buildBar() {
        const r = this.replay;
        this.playBtn = h('button.pt-btn.replay-play', { type: 'button', 'aria-label': 'Play or pause (Space)', onclick: () => this.toggle() });
        this.timeEl = h('div.replay-time.pt-mono');
        this.scrub = h('input.replay-scrub', { type: 'range', min: 0, max: this.endTick, step: 1, value: 0, 'aria-label': 'Timeline' });
        this.scrub.addEventListener('input', () => {
            this.dragging = true;
            this.seek(Number(this.scrub.value));
        });
        this.scrub.addEventListener('change', () => {
            this.dragging = false;
        });
        const marks = h('div.replay-marks', { 'aria-hidden': 'true' },
            this.markers.map((m) => h('span.replay-mark', { class: m.kind, style: { left: `${(m.tick / Math.max(1, this.endTick)) * 100}%` } })));
        this.speedBtns = SPEEDS.map((s) => h('button.pt-btn.small', { type: 'button', onclick: () => this.setSpeed(s) }, `${s}×`));
        this.camBtns = CAMS.map((c, i) => h('button.pt-btn.small', { type: 'button', onclick: () => this.setCamera(i) }, c.label));
        const title = r.name || this.track.name;
        // Saved replays are usually named '<track> <time>': only repeat what the title lacks.
        const sub = [];
        if (!title.includes(this.track.name)) sub.push(this.track.name);
        const time = this.finishMs != null ? formatTime(this.finishMs) : 'did not finish';
        if (!title.includes(time)) sub.push(time);
        if (this.respawns) sub.push(`${this.respawns} respawn${this.respawns === 1 ? '' : 's'}`);
        if (r.date) sub.push(niceDate(r.date));
        const info = h('div.replay-info.pt-panel',
            h('div.replay-badge', h('span.pt-ico', { html: iconSvg('film', 18) }), 'Replay'),
            h('div.replay-title', title),
            sub.length ? h('div.pt-muted', sub.join(' · ')) : null);
        const tas = h('button.pt-btn.small', {
            type: 'button', title: 'Open this run in the TAS Studio',
            onclick: () => this.app.goto('tas', { track: this.track, replay: this.replay }),
        }, h('span.pt-ico', { html: iconSvg('tas', 16) }), 'TAS Studio');
        const race = h('button.pt-btn.small', {
            type: 'button', title: 'Race against this run as a ghost',
            onclick: () => this.app.goto('play', {
                track: this.track,
                mode: this.app.catalog.isCampaign(this.track.id) ? 'campaign' : 'custom',
                ghosts: [{ replay: this.replay, label: this.replay.name || 'Replay ghost' }],
            }),
        }, h('span.pt-ico', { html: iconSvg('ghost', 16) }), 'Race ghost');
        const back = h('button.pt-btn.small.ghost', { type: 'button', 'data-sound': 'back', onclick: () => this.exit() },
            h('span.pt-ico', { html: iconSvg('back', 16) }), 'Back');
        const bar = h('div.replay-bar.pt-panel',
            h('div.replay-row',
                this.playBtn,
                h('button.pt-btn.small', { type: 'button', 'aria-label': 'Back 5 seconds', onclick: () => this.seek(this.sim.tick - 500) }, h('span.pt-ico', { html: iconSvg('rewind', 16) })),
                h('button.pt-btn.small', { type: 'button', 'aria-label': 'Forward 5 seconds', onclick: () => this.seek(this.sim.tick + 500) }, h('span.pt-ico', { html: iconSvg('forward', 16) })),
                this.timeEl,
                h('div.replay-track', marks, this.scrub)),
            h('div.replay-row.wrap',
                h('div.pt-seg', { role: 'group', 'aria-label': 'Playback speed' }, this.speedBtns),
                h('div.pt-seg', { role: 'group', 'aria-label': 'Camera' }, this.camBtns),
                h('div.pt-spacer'),
                race, tas, back));
        return h('div.replay-ui', info, bar);
    }

    _sync() {
        this.playBtn.innerHTML = iconSvg(this.playing ? 'pause' : 'play', 22);
        SPEEDS.forEach((s, i) => toggleClass(this.speedBtns[i], 'active', s === this.speed));
        CAMS.forEach((c, i) => toggleClass(this.camBtns[i], 'active', i === this.cam));
    }

    toggle() {
        if (!this.playing && this.sim.tick >= this.endTick) this.seek(0);
        this.playing = !this.playing;
        if (!this.playing) this.app.audio.stopCar();
        this.app.loop.resync();
        this._sync();
    }

    setSpeed(s) {
        this.speed = s;
        this.app.loop.timeScale = s;
        this._sync();
    }

    setCamera(i) {
        this.cam = (i + CAMS.length) % CAMS.length;
        this._applyCamera();
        this._sync();
    }

    _applyCamera() {
        this.app.renderer.setCameraMode(CAMS[this.cam].id, this.car);
    }

    /** Jumps to a tick: restore the savestate at or before it, then simulate forward. */
    seek(tick) {
        const t = Math.max(0, Math.min(this.endTick, Math.round(tick)));
        const sim = this.sim;
        if (t < sim.tick || t - sim.tick > SAVE_EVERY) {
            const k = Math.min(this.states.length - 1, Math.floor(t / SAVE_EVERY));
            sim.setState(this.states[k]);
        }
        while (sim.tick < t) sim.step(sim.tick < this.inputs.length ? this.inputs[sim.tick] : null);
        snapshotCar(sim.car, this.cur);
        snapshotCar(sim.car, this.prev);
        this.hud.hideSplit();
        this.hud.hideBanner();
        this.app.loop.resync();
    }

    tick() {
        if (!this.playing || this.dragging) return;
        const sim = this.sim;
        if (sim.tick >= this.endTick) {
            this.playing = false;
            this.app.audio.stopCar();
            this._sync();
            return;
        }
        const tmp = this.prev;
        this.prev = this.cur;
        this.cur = tmp;
        sim.step(sim.tick < this.inputs.length ? this.inputs[sim.tick] : null);
        snapshotCar(sim.car, this.cur);
        const events = sim.events;
        if (!events.length) return;
        for (const ev of events) {
            if (ev.type === 'respawn') snapshotCar(sim.car, this.prev);
            else if (ev.type === 'checkpoint') this.hud.split(ev.timeMs, null);
            else if (ev.type === 'finish') this.hud.banner(formatTime(ev.timeMs), 'finish', 2500);
            else if (ev.type === 'lap') this.hud.banner(`Lap ${ev.lap + 1}/${sim.laps}`, 'lap');
        }
        this.app.renderer.handleEvents(events, this.car);
        if (this.speed >= 0.5 && this.speed <= 2) this.app.audio.handleEvents(events);
    }

    frame(alpha, dt) {
        const a = this.playing && !this.dragging ? alpha : 1;
        lerpCarSnapshot(this.prev, this.cur, a, this.view);
        this.car.setPose(this.prev, this.cur, a);
        this.hud.update(this.sim, this.view);
        const t = this.sim.tick;
        if (this._shownTick !== t) {
            this._shownTick = t;
            if (!this.dragging) this.scrub.value = String(t);
            setText(this.timeEl, `${formatTime(this.sim.timeMs)} / ${this.totalText}`);
        }
        if (this.playing) this.app.audio.updateCar(this.view, dt * this.speed);
        this.app.renderer.render(dt);
    }

    onKey(e) {
        if (e.target && e.target.tagName === 'INPUT' && e.target.type === 'range' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return false;
        const step = e.shiftKey ? 500 : 100;
        switch (e.key) {
            case ' ':
            case 'k':
                if (e.target && e.target.tagName === 'BUTTON' && e.key === ' ') return false;
                this.toggle();
                return true;
            case 'ArrowLeft':
            case 'j':
                this.seek(this.sim.tick - step);
                return true;
            case 'ArrowRight':
            case 'l':
                this.seek(this.sim.tick + step);
                return true;
            case ',':
                if (this.playing) this.toggle();
                this.seek(this.sim.tick - 1);
                return true;
            case '.':
                if (this.playing) this.toggle();
                this.seek(this.sim.tick + 1);
                return true;
            case 'Home':
                this.seek(0);
                return true;
            case 'End':
                this.seek(this.endTick);
                return true;
            case '[':
            case '-': {
                const i = SPEEDS.indexOf(this.speed);
                this.setSpeed(SPEEDS[Math.max(0, i - 1)]);
                return true;
            }
            case ']':
            case '=':
            case '+': {
                const i = SPEEDS.indexOf(this.speed);
                this.setSpeed(SPEEDS[Math.min(SPEEDS.length - 1, i + 1)]);
                return true;
            }
            case 'c':
            case 'C':
                this.setCamera(this.cam + 1);
                return true;
            case '1': case '2': case '3': case '4':
                this.setCamera(Number(e.key) - 1);
                return true;
            default:
                return false;
        }
    }

    exit() {
        const onExit = this.params.onExit;
        if (typeof onExit === 'function') onExit(null);
        else this.app.goto('replays');
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this.app.loop.timeScale = 1;
        if (this.car) this.app.renderer.removeCar(this.car);
        this.app.audio.stopCar();
        if (this.hud) this.hud.dispose();
    }
}
