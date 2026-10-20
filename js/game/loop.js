// Fixed-timestep driver: onTick() at 100 Hz from an accumulator (at most
// maxTicksPerFrame per animation frame, so a slow machine slows the game down
// instead of spiralling), onFrame(alpha, dt) once per frame for drawing.
import { TICK } from '../core/constants.js';

export class Loop {
    constructor() {
        this.timeScale = 1;
        this.maxTicksPerFrame = 25;
        this.running = false;
        this.onTick = null;
        this.onFrame = null;
        this.acc = 0;
        this.last = 0;
        this.frames = 0;
        this.ticks = 0;
        this._raf = 0;
        this._gen = 0;
        this._frame = this._frame.bind(this);
    }

    /** Replaces the callbacks and runs (restarting the accumulator). */
    start(onTick, onFrame) {
        this.onTick = onTick || null;
        this.onFrame = onFrame || null;
        this.acc = 0;
        this.last = performance.now();
        this._gen++;
        if (!this.running) {
            this.running = true;
            this._raf = requestAnimationFrame(this._frame);
        }
    }

    stop() {
        this.running = false;
        this.onTick = null;
        this.onFrame = null;
        this._gen++;
        cancelAnimationFrame(this._raf);
    }

    /** Drops the time owed (after a pause or a long load) so nothing fast-forwards. */
    resync() {
        this.acc = 0;
        this.last = performance.now();
    }

    _frame(now) {
        if (!this.running) return;
        this._raf = requestAnimationFrame(this._frame);
        const gen = this._gen;
        // A background tab gets no frames; never try to catch up seconds at once.
        const dt = Math.min(0.25, Math.max(0, (now - this.last) / 1000));
        this.last = now;
        this.frames++;
        try {
            if (this.onTick) {
                this.acc += dt * this.timeScale;
                let n = 0;
                while (this.acc >= TICK && n < this.maxTicksPerFrame) {
                    this.onTick();
                    this.ticks++;
                    n++;
                    this.acc -= TICK;
                    if (gen !== this._gen) return;   // a callback stopped or restarted the loop
                }
                if (n >= this.maxTicksPerFrame && this.acc >= TICK) this.acc = this.acc % TICK;
            }
            if (this.onFrame) this.onFrame(this.onTick ? Math.min(1, this.acc / TICK) : 1, dt);
        } catch (e) {
            console.error('[penguintrack] loop callback failed', e);
            this.stop();
            if (this.onError) this.onError(e);
        }
    }
}
