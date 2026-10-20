// Attract mode behind the menus: the core Autopilot drives a campaign track
// while the camera alternates between a chase view and a slow orbit. The run
// restarts (or moves to another track) after the finish or when it gets stuck.
import { buildWorld } from '../core/track.js';
import { Sim } from '../core/sim.js';
import { Autopilot } from '../core/autopilot.js';
import { snapshotCar } from '../core/replay.js';

const SHOT_TICKS = 900;          // camera cut every 9 s
const AFTER_FINISH = 260;
const MAX_TICKS = 100 * 150;     // give up on a run after 2.5 minutes

export class Backdrop {
    constructor(app) {
        this.app = app;
        this.world = null;
        this.car = null;
        this.running = false;
        this.order = null;
        this._tick = this._tick.bind(this);
        this._frame = this._frame.bind(this);
    }

    /** Starts (or keeps) the attract loop; idempotent. */
    start() {
        const app = this.app;
        if (app.renderer.isNull || app.debug.noBackdrop) return;
        if (this.running && app.loop.onTick === this._tick) return;
        try {
            if (!this.world) this._load(this._pick());
            else if (app.renderer.world !== this.world) app.loadWorld(this.world, this.track);
            if (!this.car) {
                this.car = app.renderer.addCar({ kind: 'ai', color: '#ff5d6c', label: '' });
                this._shot(true);
            }
        } catch (e) {
            console.warn('[penguintrack] attract mode unavailable:', e.message);
            return;
        }
        this.running = true;
        app.loop.timeScale = 1;
        app.loop.start(this._tick, this._frame);
    }

    /** Stops driving and removes the car (the world stays loaded until someone replaces it). */
    stop() {
        if (!this.running && !this.car) return;
        this.running = false;
        if (this.app.loop.onTick === this._tick) this.app.loop.stop();
        if (this.car) {
            this.app.renderer.removeCar(this.car);
            this.car = null;
        }
    }

    _pick() {
        const app = this.app;
        const forced = app.debug.attract;
        if (forced && app.catalog.getTrack(forced)) return forced;
        if (!this.order) {
            const ids = app.catalog.campaignIds().filter((id) => {
                const info = app.catalog.info(id);
                return !info || info.mode !== 'platform';
            });
            // Shuffled once per session so every visit to the menu shows somewhere new.
            this.order = ids.sort(() => Math.random() - 0.5);
            this.next = 0;
        }
        if (!this.order.length) return null;
        const id = this.order[this.next % this.order.length];
        this.next++;
        return id;
    }

    _load(id) {
        const track = id ? this.app.catalog.getTrack(id) : null;
        if (!track) throw new Error('no campaign track to show');
        const world = buildWorld(track);
        if (!world.route || !world.spawn) throw new Error(`track ${id} has no route`);
        this.track = track;
        this.world = world;
        this.sim = new Sim(world);
        this.pilot = new Autopilot(world);
        this.prev = snapshotCar(this.sim.car);
        this.cur = snapshotCar(this.sim.car);
        this.finishedFor = 0;
        this.shotTicks = 0;
        this.shotIndex = 0;
        this.app.loadWorld(world, track);
        if (this.car) {
            this.app.renderer.removeCar(this.car);
            this.car = null;
        }
    }

    _next() {
        const id = this.app.debug.attract ? null : this._pick();
        if (id && id !== this.track.id) {
            this._load(id);
            this.car = this.app.renderer.addCar({ kind: 'ai', color: '#ff5d6c', label: '' });
            this._shot(true);
        } else {
            this.sim.reset();
            this.pilot.reset();
            snapshotCar(this.sim.car, this.prev);
            snapshotCar(this.sim.car, this.cur);
            this.finishedFor = 0;
        }
    }

    _shot(first = false) {
        const reduced = this.app.settings.reducedMotion;
        if (!first) this.shotIndex++;
        // Reduced motion: one calm orbit, no cuts.
        const mode = reduced ? 'orbit' : ['chase', 'orbit'][this.shotIndex % 2];
        this.app.renderer.setCameraMode(mode, this.car);
        this.shotTicks = 0;
    }

    _tick() {
        const sim = this.sim;
        const input = this.pilot.act(sim);
        const tmp = this.prev;
        this.prev = this.cur;
        this.cur = tmp;
        sim.step(input);
        snapshotCar(sim.car, this.cur);
        if (sim.events.length) {
            for (const ev of sim.events) if (ev.type === 'respawn') snapshotCar(sim.car, this.prev);
            this.app.renderer.handleEvents(sim.events, this.car);
        }
        if (++this.shotTicks >= SHOT_TICKS && !this.app.settings.reducedMotion) this._shot();
        if (sim.finished) this.finishedFor++;
        if (this.finishedFor > AFTER_FINISH || sim.tick > MAX_TICKS || this.pilot.respawnCount > 25) this._next();
    }

    _frame(alpha, dt) {
        if (this.car) this.car.setPose(this.prev, this.cur, alpha);
        this.app.renderer.render(dt);
    }
}
