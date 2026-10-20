// TAS Studio piano roll: a canvas with a time ruler (markers, savestates, loop
// region, playhead), the run's speed, the analog steering graph, gas / brake /
// respawn rows and an overview strip. Drawing tools edit the timeline through
// the studio (which keeps undo, the runner and the script in step).
import { STEER_MAX } from '../core/constants.js';
import { TimelineView, steerFromY, yFromSteer, paintSteer, paintFlag, toggleFlagSpan, tickTime, GAS, BRAKE, RESPAWN } from './studio-model.js';
import { formatTick } from './script.js';

const LEFT = 54;          // label column
const RULER = 24;
const SPEED = 30;
const FLAG = 16;
const RESP = 13;
const OVERVIEW = 12;

const C = {
    bg: '#0b1c38', lane: 'rgba(255,255,255,0.025)', laneAlt: 'rgba(255,255,255,0.05)', grid: 'rgba(200,230,255,0.08)',
    gridStrong: 'rgba(200,230,255,0.16)', text: '#9db8d9', textHi: '#eef6ff', accent: '#7fdcff', accent2: '#b8f1ff',
    gas: '#6bffb0', brake: '#ff6b81', respawn: '#ffcf5a', checkpoint: '#7fdcff', finish: '#ffd54a', lap: '#ffd54a',
    sel: 'rgba(127,220,255,0.16)', selEdge: 'rgba(127,220,255,0.7)', loop: 'rgba(255,207,90,0.22)', loopEdge: '#ffcf5a',
    playhead: '#ffffff', held: 'rgba(6,16,34,0.45)', compare: 'rgba(255,255,255,0.35)', speed: '#b8f1ff',
    air: '#b48cff', drift: '#ffa45a', slot: '#c9b8ff',
};

export class TimelineCanvas {
    /**
     * ctl: the studio's view of the run — { timeline, trace, cursor, endTick, markers, slots,
     * selection, loop, tool, compare, seek(tick), beginEdit(), endEdit(), setSelection(sel|null), scrubbing(bool) }.
     */
    constructor(host, ctl) {
        this.host = host;
        this.ctl = ctl;
        this.canvas = document.createElement('canvas');
        this.canvas.className = 'tas-roll';
        this.canvas.tabIndex = 0;
        this.canvas.setAttribute('role', 'application');
        this.canvas.setAttribute('aria-label', 'Input timeline: click the ruler to seek, draw steering and pedals, Shift-drag to select');
        host.appendChild(this.canvas);
        this.ctx = this.canvas.getContext('2d');
        this.view = new TimelineView({ scale: 3 });
        this.hover = null;          // { x, y, tick, lane }
        this.drag = null;
        this.dirty = true;
        this.cssW = 0;
        this.cssH = 0;
        this.follow = true;
        this.autoFit = true;      // refit on resize until the user zooms or scrolls
        this._on = [];
        this._listen(this.canvas, 'pointerdown', (e) => this._down(e));
        this._listen(this.canvas, 'pointermove', (e) => this._move(e));
        this._listen(this.canvas, 'pointerup', (e) => this._up(e));
        this._listen(this.canvas, 'pointercancel', (e) => this._up(e));
        this._listen(this.canvas, 'pointerleave', () => { this.hover = null; this.dirty = true; });
        this._listen(this.canvas, 'wheel', (e) => this._wheel(e), { passive: false });
        this._listen(this.canvas, 'contextmenu', (e) => e.preventDefault());
        this._ro = new ResizeObserver(() => this.resize());
        this._ro.observe(host);
        this.resize();
    }

    _listen(el, type, fn, opts) {
        el.addEventListener(type, fn, opts);
        this._on.push(() => el.removeEventListener(type, fn, opts));
    }

    dispose() {
        for (const off of this._on) off();
        this._ro.disconnect();
        this.canvas.remove();
    }

    get total() {
        return Math.max(this.ctl.endTick || 0, this.ctl.timeline.length, 100);
    }

    resize() {
        const r = this.host.getBoundingClientRect();
        const w = Math.max(200, Math.floor(r.width)), hgt = Math.max(120, Math.floor(r.height));
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        if (w === this.cssW && hgt === this.cssH && this._dpr === dpr) return;
        this.cssW = w;
        this.cssH = hgt;
        this._dpr = dpr;
        this.canvas.width = Math.round(w * dpr);
        this.canvas.height = Math.round(hgt * dpr);
        this.canvas.style.width = `${w}px`;
        this.canvas.style.height = `${hgt}px`;
        this.view.setWidth(w - LEFT, this.total);
        if (this.autoFit) this.view.fit(this.total);
        this.dirty = true;
    }

    /** Lane rectangles (CSS px). */
    lanes() {
        const h = this.cssH;
        const steerH = Math.max(40, h - RULER - SPEED - FLAG * 2 - RESP - OVERVIEW - 4);
        let y = RULER;
        const lane = (id, height, label) => {
            const l = { id, y, h: height, label };
            y += height;
            return l;
        };
        const L = {
            ruler: { id: 'ruler', y: 0, h: RULER, label: '' },
            speed: lane('speed', SPEED, 'Speed'),
            steer: lane('steer', steerH, 'Steer'),
            gas: lane('gas', FLAG, 'Gas'),
            brake: lane('brake', FLAG, 'Brake'),
            respawn: lane('respawn', RESP, 'Resp.'),
        };
        y += 4;
        L.overview = { id: 'overview', y, h: OVERVIEW, label: '' };
        return L;
    }

    laneAt(y) {
        const L = this.lanes();
        for (const k of Object.keys(L)) if (y >= L[k].y && y < L[k].y + L[k].h) return k;
        return null;
    }

    fit() {
        this.view.fit(this.total);
        this.autoFit = true;
        this.dirty = true;
    }

    zoom(factor) {
        const cx = this.view.xAt(this.ctl.cursor);
        const anchor = cx >= 0 && cx <= this.view.width ? cx : this.view.width / 2;
        this.view.zoom(factor, anchor, this.total);
        this.autoFit = false;
        this.dirty = true;
    }

    /** Keeps the playhead visible (while playing / stepping). */
    followCursor() {
        if (this.follow && this.view.follow(this.ctl.cursor, this.total)) this.dirty = true;
    }

    // ------------------------------------------------------------------ input

    _pos(e) {
        const r = this.canvas.getBoundingClientRect();
        return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    _tickAtX(x) {
        return Math.max(0, this.view.tickAt(x - LEFT));
    }

    _down(e) {
        if (e.button === 1) return;
        this.canvas.focus({ preventScroll: true });
        const { x, y } = this._pos(e);
        const lane = this.laneAt(y);
        if (!lane) return;
        const ctl = this.ctl;
        const tick = this._tickAtX(x);
        this.canvas.setPointerCapture(e.pointerId);
        if (lane === 'overview') {
            this.drag = { kind: 'overview' };
            this._overviewTo(x);
            return;
        }
        if (x < LEFT) return;
        if (lane === 'ruler' || lane === 'speed' || e.button === 2) {
            this.drag = { kind: 'scrub' };
            ctl.scrubbing(true);
            ctl.seek(Math.min(tick, ctl.endTick));
            return;
        }
        if (e.shiftKey || ctl.tool === 'select') {
            const sel = ctl.selection;
            const anchor = e.shiftKey && sel ? (Math.abs(tick - sel.from) < Math.abs(tick - sel.to) ? sel.to : sel.from) : tick;
            this.drag = { kind: 'select', anchor };
            ctl.setSelection({ from: Math.min(anchor, tick), to: Math.max(anchor, tick) + 1 });
            return;
        }
        const tl = ctl.timeline;
        const L = this.lanes();
        ctl.beginEdit();
        if (lane === 'steer') {
            const v = steerFromY(y, L.steer.y, L.steer.h, { quantize: e.altKey ? 8192 : 0 });
            paintSteer(tl, tick, v, tick, v);
            this.drag = { kind: 'steer', tick, v };
        } else if (lane === 'gas' || lane === 'brake') {
            const bit = lane === 'gas' ? GAS : BRAKE;
            const on = !(tl.flagsAt(tick) & bit);
            this.drag = { kind: 'flag', bit, on, anchor: tick, base: tl.clone() };
            paintFlag(tl, tick, tick + 1, bit, on);
        } else if (lane === 'respawn') {
            toggleFlagSpan(tl, tick, tick + 1, RESPAWN);
            this.drag = { kind: 'none' };
        }
        this.dirty = true;
    }

    _move(e) {
        const { x, y } = this._pos(e);
        const tick = this._tickAtX(x);
        this.hover = { x, y, tick, lane: this.laneAt(y) };
        this.dirty = true;
        const d = this.drag;
        if (!d) return;
        const ctl = this.ctl;
        const tl = ctl.timeline;
        if (d.kind === 'overview') this._overviewTo(x);
        else if (d.kind === 'scrub') ctl.seek(Math.min(tick, ctl.endTick));
        else if (d.kind === 'select') ctl.setSelection({ from: Math.min(d.anchor, tick), to: Math.max(d.anchor, tick) + 1 });
        else if (d.kind === 'steer') {
            const L = this.lanes();
            const v = steerFromY(y, L.steer.y, L.steer.h, { quantize: e.altKey ? 8192 : 0 });
            paintSteer(tl, d.tick, d.v, tick, v);
            d.tick = tick;
            d.v = v;
        } else if (d.kind === 'flag') {
            // Re-apply from the snapshot so shrinking the drag restores what was there.
            const from = Math.min(d.anchor, tick), to = Math.max(d.anchor, tick) + 1;
            tl.batch(() => {
                tl.copyFrom(d.base);
                paintFlag(tl, from, to, d.bit, d.on);
            });
        }
    }

    _up(e) {
        const d = this.drag;
        this.drag = null;
        try {
            this.canvas.releasePointerCapture(e.pointerId);
        } catch (err) { /* not captured */ }
        if (!d) return;
        if (d.kind === 'scrub') this.ctl.scrubbing(false);
        if (d.kind === 'steer' || d.kind === 'flag' || d.kind === 'none') this.ctl.endEdit();
        this.dirty = true;
    }

    _overviewTo(x) {
        const span = this.view.width / this.view.scale;
        const t = ((x - LEFT) / Math.max(1, this.cssW - LEFT)) * this.total;
        this.view.start = t - span / 2;
        this.view.clamp(this.total);
        this.follow = false;
        this.autoFit = false;
        this.dirty = true;
    }

    _wheel(e) {
        e.preventDefault();
        const { x } = this._pos(e);
        const horizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey;
        if (horizontal) {
            this.view.scrollBy(e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX, this.total);
            this.follow = false;
        } else {
            this.view.zoom(Math.exp(-e.deltaY * 0.0022), Math.max(0, x - LEFT), this.total);
        }
        this.autoFit = false;
        this.dirty = true;
    }

    // ------------------------------------------------------------------ drawing

    draw() {
        if (!this.dirty) return;
        this.dirty = false;
        const ctx = this.ctx, dpr = this._dpr, W = this.cssW, H = this.cssH;
        const ctl = this.ctl, tl = ctl.timeline, v = this.view;
        const L = this.lanes();
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = C.bg;
        ctx.fillRect(0, 0, W, H);
        ctx.font = '11px ui-monospace, "SF Mono", Menlo, monospace';
        ctx.textBaseline = 'middle';

        // Lanes
        const laneIds = ['speed', 'steer', 'gas', 'brake', 'respawn'];
        laneIds.forEach((id, i) => {
            const l = L[id];
            ctx.fillStyle = i % 2 ? C.laneAlt : C.lane;
            ctx.fillRect(LEFT, l.y, W - LEFT, l.h);
        });

        ctx.save();
        ctx.beginPath();
        ctx.rect(LEFT, 0, W - LEFT, H);
        ctx.clip();
        ctx.translate(LEFT, 0);
        const { from, to } = v.visible();
        const len = tl.length;

        // Grid + ruler labels
        const step = v.labelStep(74);
        const minor = step >= 10 ? step / (step % 3 === 0 ? 3 : 5) : step;
        ctx.fillStyle = C.text;
        for (let t = Math.floor(from / minor) * minor; t <= to; t += minor) {
            const x = Math.round(v.xAt(t)) + 0.5;
            const major = t % step === 0;
            ctx.strokeStyle = major ? C.gridStrong : C.grid;
            ctx.beginPath();
            ctx.moveTo(x, major ? 12 : 17);
            ctx.lineTo(x, L.respawn.y + L.respawn.h);
            ctx.stroke();
            if (major) ctx.fillText(step < 100 ? formatTick(t) : formatTick(t).replace(/\.00$/, ''), x + 3, 7);
        }

        // Held tail (past the timeline's explicit end)
        const xEnd = v.xAt(len);
        if (xEnd < W) {
            ctx.fillStyle = C.held;
            ctx.fillRect(Math.max(0, xEnd), RULER, W, L.respawn.y + L.respawn.h - RULER);
        }

        // Loop region and selection
        const loop = ctl.loop;
        if (loop && loop.to > loop.from) {
            const a = v.xAt(loop.from), b = v.xAt(loop.to);
            ctx.fillStyle = loop.on ? C.loop : 'rgba(255,207,90,0.08)';
            ctx.fillRect(a, 0, b - a, RULER);
            ctx.fillStyle = loop.on ? 'rgba(255,207,90,0.06)' : 'rgba(255,207,90,0.025)';
            ctx.fillRect(a, RULER, b - a, L.respawn.y + L.respawn.h - RULER);
            ctx.fillStyle = C.loopEdge;
            ctx.fillRect(a - 1, 0, 2, RULER);
            ctx.fillRect(b - 1, 0, 2, RULER);
        }
        const sel = ctl.selection;
        if (sel && sel.to > sel.from) {
            const a = v.xAt(sel.from), b = v.xAt(sel.to);
            ctx.fillStyle = C.sel;
            ctx.fillRect(a, RULER, Math.max(1, b - a), L.respawn.y + L.respawn.h - RULER);
            ctx.strokeStyle = C.selEdge;
            ctx.strokeRect(a + 0.5, RULER + 0.5, Math.max(1, b - a) - 1, L.respawn.y + L.respawn.h - RULER - 1);
        }

        this._drawSpeed(ctx, L.speed, from, to);
        this._drawSteer(ctx, L.steer, from, to);
        this._drawFlags(ctx, L.gas, GAS, C.gas, from, to);
        this._drawFlags(ctx, L.brake, BRAKE, C.brake, from, to);
        this._drawRespawns(ctx, L.respawn, from, to);

        // Markers through every lane
        for (const m of ctl.markers) {
            if (m.tick < from - 1 || m.tick > to + 1) continue;
            const x = Math.round(v.xAt(m.tick)) + 0.5;
            const col = C[m.kind] || C.text;
            ctx.strokeStyle = col;
            ctx.globalAlpha = 0.75;
            ctx.setLineDash(m.kind === 'respawn' ? [3, 3] : []);
            ctx.beginPath();
            ctx.moveTo(x, 12);
            ctx.lineTo(x, L.respawn.y + L.respawn.h);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.globalAlpha = 1;
            if (m.kind !== 'respawn') {
                ctx.fillStyle = col;
                ctx.beginPath();
                ctx.moveTo(x - 4, 12);
                ctx.lineTo(x + 4, 12);
                ctx.lineTo(x, 18);
                ctx.fill();
                ctx.fillText(m.kind === 'finish' ? 'FIN' : m.label.replace('CP ', 'CP'), x + 5, 18);
            }
        }

        // Savestate slots
        for (const s of ctl.slots) {
            const x = Math.round(v.xAt(s.tick)) + 0.5;
            if (x < -10 || x > W) continue;
            ctx.globalAlpha = s.stale ? 0.45 : 1;
            ctx.fillStyle = C.slot;
            ctx.fillRect(x - 6, RULER - 11, 12, 11);
            ctx.fillStyle = '#1a1240';
            ctx.textAlign = 'center';
            ctx.fillText(s.name, x, RULER - 5);
            ctx.textAlign = 'left';
            ctx.globalAlpha = 1;
        }

        // Hover line
        const hv = this.hover;
        if (hv && hv.x >= LEFT && !this.drag) {
            const x = Math.round(v.xAt(hv.tick)) + 0.5;
            ctx.strokeStyle = 'rgba(255,255,255,0.25)';
            ctx.beginPath();
            ctx.moveTo(x, RULER);
            ctx.lineTo(x, L.respawn.y + L.respawn.h);
            ctx.stroke();
        }

        // Playhead
        const px = Math.round(v.xAt(ctl.cursor)) + 0.5;
        ctx.strokeStyle = C.playhead;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(px, 0);
        ctx.lineTo(px, L.respawn.y + L.respawn.h);
        ctx.stroke();
        ctx.lineWidth = 1;
        ctx.fillStyle = C.playhead;
        ctx.beginPath();
        ctx.moveTo(px - 5, 0);
        ctx.lineTo(px + 5, 0);
        ctx.lineTo(px, 7);
        ctx.fill();
        ctx.restore();

        // Labels column
        ctx.fillStyle = '#0d2244';
        ctx.fillRect(0, 0, LEFT, H);
        ctx.fillStyle = C.text;
        for (const id of laneIds) {
            const l = L[id];
            ctx.fillText(l.label, 6, l.y + l.h / 2);
        }
        ctx.fillStyle = C.textHi;
        ctx.fillText('t ' + ctl.cursor, 6, RULER / 2);
        ctx.fillStyle = C.text;
        ctx.font = '9px ui-monospace, Menlo, monospace';
        ctx.fillText('R', LEFT - 10, L.steer.y + 7);
        ctx.fillText('L', LEFT - 10, L.steer.y + L.steer.h - 7);

        this._drawOverview(ctx, L.overview, W);
        this._drawHoverInfo(ctx, W);
    }

    _drawSpeed(ctx, lane, from, to) {
        const tr = this.ctl.trace, v = this.view;
        if (!tr) return;
        const sp = tr.speedKmh, st = tr.state;
        let max = 100;
        for (let i = 0; i < sp.length; i += 7) if (sp[i] > max) max = sp[i];
        max *= 1.08;
        const y0 = lane.y + lane.h - 3;
        const k = (lane.h - 6) / max;
        const a = Math.max(0, from), b = Math.min(sp.length - 1, to);
        // Airborne / drifting strip
        for (let t = a; t <= b; t++) {
            const s = st[t];
            if (!(s & 3)) continue;
            ctx.fillStyle = s & 1 ? C.air : C.drift;
            ctx.fillRect(v.xAt(t), lane.y + lane.h - 3, Math.max(1, v.scale), 3);
        }
        ctx.strokeStyle = C.speed;
        ctx.globalAlpha = 0.85;
        ctx.beginPath();
        const stride = Math.max(1, Math.floor(1 / Math.max(v.scale, 1e-6)));
        for (let t = a; t <= b; t += stride) {
            const x = v.xAt(t), y = y0 - sp[t] * k;
            if (t === a) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.globalAlpha = 1;
    }

    _drawSteer(ctx, lane, from, to) {
        const tl = this.ctl.timeline, v = this.view;
        const mid = lane.y + lane.h / 2;
        ctx.strokeStyle = C.gridStrong;
        ctx.beginPath();
        ctx.moveTo(0, Math.round(mid) + 0.5);
        ctx.lineTo(v.width, Math.round(mid) + 0.5);
        ctx.stroke();
        ctx.setLineDash([2, 4]);
        for (const s of [STEER_MAX / 2, -STEER_MAX / 2]) {
            const y = Math.round(yFromSteer(s, lane.y, lane.h)) + 0.5;
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(v.width, y);
            ctx.stroke();
        }
        ctx.setLineDash([]);

        const cmp = this.ctl.compare;
        if (cmp) this._steerPath(ctx, cmp, lane, from, to, C.compare, false);
        this._steerPath(ctx, tl, lane, from, to, C.accent, true);
    }

    _steerPath(ctx, tl, lane, from, to, color, fill) {
        const v = this.view;
        const mid = lane.y + lane.h / 2;
        if (v.scale >= 1) {
            ctx.beginPath();
            ctx.moveTo(v.xAt(from), mid);
            for (let t = from; t <= to; t++) {
                const y = yFromSteer(tl.steerAt(t), lane.y, lane.h);
                ctx.lineTo(v.xAt(t), y);
                ctx.lineTo(v.xAt(t + 1), y);
            }
            ctx.lineTo(v.xAt(to + 1), mid);
            if (fill) {
                ctx.fillStyle = 'rgba(127,220,255,0.18)';
                ctx.fill();
            }
            ctx.strokeStyle = color;
            ctx.stroke();
            return;
        }
        // Zoomed out: min / max per pixel column.
        const per = 1 / v.scale;
        ctx.fillStyle = fill ? 'rgba(127,220,255,0.55)' : color;
        for (let x = 0; x < v.width; x++) {
            const a = Math.floor(v.start + x * per), b = Math.floor(v.start + (x + 1) * per);
            if (b < 0) continue;
            let lo = Infinity, hi = -Infinity;
            for (let t = Math.max(0, a); t <= b; t++) {
                const s = tl.steerAt(t);
                if (s < lo) lo = s;
                if (s > hi) hi = s;
            }
            if (lo === Infinity) continue;
            const y1 = yFromSteer(hi, lane.y, lane.h), y2 = yFromSteer(lo, lane.y, lane.h);
            if (fill) {
                const top = Math.min(y1, mid), bot = Math.max(y2, mid);
                ctx.globalAlpha = 0.35;
                ctx.fillRect(x, top, 1, bot - top);
                ctx.globalAlpha = 1;
            }
            ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1));
        }
    }

    _drawFlags(ctx, lane, bit, color, from, to) {
        const tl = this.ctl.timeline, v = this.view;
        ctx.fillStyle = color;
        let start = -1;
        for (let t = from; t <= to + 1; t++) {
            const on = t <= to && (tl.flagsAt(t) & bit);
            if (on && start < 0) start = t;
            else if (!on && start >= 0) {
                const a = v.xAt(start), b = v.xAt(t);
                ctx.globalAlpha = 0.85;
                ctx.fillRect(a, lane.y + 3, Math.max(1, b - a - (v.scale > 4 ? 1 : 0)), lane.h - 6);
                ctx.globalAlpha = 1;
                start = -1;
            }
        }
    }

    _drawRespawns(ctx, lane, from, to) {
        const tl = this.ctl.timeline, v = this.view;
        ctx.fillStyle = C.respawn;
        const end = Math.min(to, tl.length - 1);
        for (let t = Math.max(0, from); t <= end; t++) {
            if (!(tl.flags[t] & RESPAWN)) continue;
            const x = v.xAt(t) + Math.max(1, v.scale) / 2, y = lane.y + lane.h / 2;
            ctx.beginPath();
            ctx.moveTo(x, y - 5);
            ctx.lineTo(x + 4, y);
            ctx.lineTo(x, y + 5);
            ctx.lineTo(x - 4, y);
            ctx.fill();
        }
    }

    _drawOverview(ctx, lane, W) {
        const total = this.total, v = this.view;
        const w = W - LEFT;
        ctx.fillStyle = 'rgba(255,255,255,0.05)';
        ctx.fillRect(LEFT, lane.y, w, lane.h);
        const k = w / total;
        for (const m of this.ctl.markers) {
            if (m.kind === 'respawn') continue;
            ctx.fillStyle = C[m.kind];
            ctx.fillRect(LEFT + m.tick * k, lane.y, 1, lane.h);
        }
        ctx.strokeStyle = C.accent;
        ctx.strokeRect(LEFT + v.start * k + 0.5, lane.y + 0.5, Math.max(3, (v.width / v.scale) * k) - 1, lane.h - 1);
        ctx.fillStyle = C.playhead;
        ctx.fillRect(LEFT + this.ctl.cursor * k, lane.y, 1.5, lane.h);
    }

    _drawHoverInfo(ctx, W) {
        const hv = this.hover;
        if (!hv || hv.x < LEFT || !hv.lane || hv.lane === 'overview') return;
        const tl = this.ctl.timeline, tr = this.ctl.trace;
        const t = hv.tick;
        let text = `${tickTime(t)}  t${t}`;
        if (hv.lane === 'steer') {
            const L = this.lanes();
            text += `  steer ${tl.steerAt(t)}  (draw → ${steerFromY(hv.y, L.steer.y, L.steer.h)})`;
        } else if (hv.lane === 'speed' && tr && t < tr.speedKmh.length) {
            text += `  ${tr.speedKmh[t].toFixed(3)} km/h`;
        } else if (hv.lane === 'gas' || hv.lane === 'brake') {
            const f = tl.flagsAt(t);
            text += `  gas ${f & GAS ? 'on' : 'off'}  brake ${f & BRAKE ? 'on' : 'off'}`;
        }
        ctx.font = '11px ui-monospace, "SF Mono", Menlo, monospace';
        const w = ctx.measureText(text).width + 12;
        const x = Math.min(W - w - 4, Math.max(LEFT + 4, hv.x + 12));
        ctx.fillStyle = 'rgba(6,16,34,0.92)';
        ctx.fillRect(x, 1, w, 18);
        ctx.fillStyle = C.textHi;
        ctx.fillText(text, x + 6, 10);
    }
}
