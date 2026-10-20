// The race HUD: timer, checkpoint/lap counters, splits against the personal
// best, speedometer with rpm arc and gear, active effects, medal targets,
// respawn counter (platform), banners, the 3-2-1 countdown and the minimap.
import { formatTime } from '../core/format.js';
import { h, setText, toggleClass } from './dom.js';
import { iconSvg } from './icons.js';
import { speedValue } from './settings.js';
import { Minimap } from './minimap.js';

export const EFFECT_INFO = {
    turbo: { name: 'Frost Boost', icon: 'turbo', tone: 'boost' },
    turbo2: { name: 'Avalanche Boost', icon: 'turbo2', tone: 'boost' },
    noEngine: { name: 'Frozen Engine', icon: 'noEngine', tone: 'bad' },
    noSteer: { name: 'Frozen Wheel', icon: 'noSteer', tone: 'bad' },
    noBrake: { name: 'Brake Freeze', icon: 'noBrake', tone: 'bad' },
    slowmo: { name: 'Snow Globe', icon: 'slowmo', tone: 'cool' },
    cruise: { name: 'Glide', icon: 'cruise', tone: 'cool' },
    fragile: { name: 'Thin Ice', icon: 'fragile', tone: 'warn' },
    broken: { name: 'Cracked! Respawn to repair', icon: 'broken', tone: 'bad' },
};

const SPLIT_MS = 3000;
const NO_GHOSTS = [];

export class Hud {
    /**
     * opts: { track, world, mode ('campaign'|'custom'|'test'|'replay'), pbRecord, targets
     * (medalTargets), medalRank, showSplits, showMinimap, units }
     */
    constructor(app, opts) {
        this.app = app;
        this.opts = opts;
        this.track = opts.track;
        this.world = opts.world;
        this.platform = opts.track.mode === 'platform';
        this.laps = opts.laps || opts.world.laps || 1;
        this.cpTotal = opts.world.checkpointCount || 0;
        this._last = {};
        this._splitTimer = null;
        this._bannerTimer = null;
        this.el = this._build();
    }

    _build() {
        const t = this.track;
        this.timerEl = h('div.hud-timer.pt-mono', '0:00.00');
        this.pbEl = h('div.hud-pb');
        this.cpEl = h('div.hud-chip.hud-cp');
        this.lapEl = h('div.hud-chip.hud-lap');
        this.respEl = h('div.hud-chip.hud-resp');
        this.splitEl = h('div.hud-split.pt-hidden', h('div.hud-split-time.pt-mono'), h('div.hud-split-diff.pt-mono'));
        this.bannerEl = h('div.hud-banner.pt-hidden');
        this.countEl = h('div.hud-count.pt-hidden');
        this.effectsEl = h('div.hud-effects');
        this.speedNum = h('div.hud-speed-num.pt-mono', '0');
        this.speedUnit = h('div.hud-speed-unit', this.opts.units === 'mph' ? 'mph' : 'km/h');
        this.gearEl = h('div.hud-gear.pt-mono', '1');
        this.rpmArc = null;
        const speedo = h('div.hud-speedo', {
            html: `<svg viewBox="0 0 120 120" class="hud-dial" aria-hidden="true">
                <path class="hud-dial-bg" d="M 23.2 96.8 A 52 52 0 1 1 96.8 96.8" pathLength="100"/>
                <path class="hud-dial-red" d="M 23.2 96.8 A 52 52 0 1 1 96.8 96.8" pathLength="100" stroke-dasharray="14 100" stroke-dashoffset="-86"/>
                <path class="hud-dial-rpm" d="M 23.2 96.8 A 52 52 0 1 1 96.8 96.8" pathLength="100" stroke-dasharray="0 100"/>
            </svg>`,
        }, h('div.hud-speed-read', this.speedNum, this.speedUnit), h('div.hud-gear-wrap', h('span', 'gear'), this.gearEl));
        this.rpmArc = speedo.querySelector('.hud-dial-rpm');

        this.medalsEl = h('div.hud-medals.pt-panel');

        this.minimap = this.opts.showMinimap && this.world.route ? new Minimap(this.world) : null;

        const modeTag = this.platform ? 'Platform' : this.laps > 1 ? `${this.laps} laps` : null;
        const root = h('div.pt-hud', { 'aria-hidden': 'false' },
            h('div.hud-tl',
                h('div.hud-track',
                    h('div.hud-track-name', t.name || 'Untitled Track'),
                    h('div.hud-track-sub', t.id && /^[A-Z]\d\d$/.test(t.id) ? t.id : (t.author ? `by ${t.author}` : ''), modeTag ? h('span.pt-tag', modeTag) : null)),
                this.minimap ? this.minimap.el : null),
            h('div.hud-tc', h('div.hud-chips', this.cpEl, this.lapEl, this.respEl), this.splitEl),
            h('div.hud-tr', this.medalsEl),
            this.bannerEl,
            this.countEl,
            h('div.hud-bc', this.effectsEl, this.timerEl, this.pbEl),
            h('div.hud-br', speedo));
        toggleClass(this.lapEl, 'pt-hidden', this.laps <= 1);
        toggleClass(this.respEl, 'pt-hidden', !this.platform);
        toggleClass(this.cpEl, 'pt-hidden', this.cpTotal === 0);
        this.setPb(this.opts.pbRecord);
        return root;
    }

    _buildMedals() {
        const targets = this.opts.targets || [];
        this.medalsEl.replaceChildren();
        toggleClass(this.medalsEl, 'pt-hidden', !targets.length);
        if (!targets.length) return;
        const rank = this.opts.medalRank || (() => 4);
        const have = this.opts.pbRecord ? this.opts.pbRecord.medal || null : null;
        const haveRank = rank(have);
        let next = null;
        for (let i = targets.length - 1; i >= 0; i--) {
            if (rank(targets[i].medal) < haveRank) {
                next = targets[i].medal;
                break;
            }
        }
        for (const tg of targets) {
            const got = rank(tg.medal) >= haveRank;
            this.medalsEl.appendChild(h('div.hud-medal-row', { class: (got ? 'got' : '') + (tg.medal === next ? ' next' : '') },
                h('span.pt-medal', { class: tg.medal }),
                h('span.hud-medal-label', tg.label),
                h('span.hud-medal-time', tg.text),
                got ? h('span.hud-medal-check', { html: iconSvg('check', 14) }) : null));
        }
    }

    /** The personal-best record: the PB line under the timer and the medal list (earned / next). */
    setPb(rec) {
        this.opts.pbRecord = rec;
        this._buildMedals();
        this.pb = rec && Number.isFinite(rec.bestMs) ? rec : null;
        if (this.pb) {
            const resp = this.platform ? ` · ${this.pb.respawns || 0} resp.` : '';
            setText(this.pbEl, `PB ${formatTime(this.pb.bestMs)}${resp}`);
        } else {
            setText(this.pbEl, '');
        }
        toggleClass(this.pbEl, 'pt-hidden', !this.pb);
    }

    reset() {
        this._last = {};
        this.hideSplit();
        this.hideBanner();
        this.countdown(null);
    }

    /** Per-frame refresh. view: interpolated car view; sim: the live sim. */
    update(sim, view, opts = {}) {
        const L = this._last;
        const time = opts.timeMs ?? sim.timeMs;
        if (L.time !== time) {
            L.time = time;
            setText(this.timerEl, formatTime(time));
        }
        const units = this.app.settings.units;
        const spd = Math.round(speedValue(Math.abs(view.speedKmh || 0), units));
        if (L.spd !== spd) {
            L.spd = spd;
            setText(this.speedNum, spd);
        }
        if (L.units !== units) {
            L.units = units;
            setText(this.speedUnit, units === 'mph' ? 'mph' : 'km/h');
        }
        const rpm = Math.round(Math.max(0, Math.min(1, view.rpm || 0)) * 100);
        if (L.rpm !== rpm) {
            L.rpm = rpm;
            this.rpmArc.setAttribute('stroke-dasharray', `${rpm} 100`);
            toggleClass(this.rpmArc, 'hot', rpm > 86);
        }
        // Compare numbers first: strings are only built when something changed.
        const gear = view.forwardSpeed < -0.5 ? -1 : view.gear || 1;
        if (L.gear !== gear) {
            L.gear = gear;
            setText(this.gearEl, gear < 0 ? 'R' : gear);
        }
        if (this.cpTotal && L.cp !== sim.collectedCount) {
            L.cp = sim.collectedCount;
            this.cpEl.innerHTML = `${iconSvg('snowflake', 16)}<span class="pt-mono">${L.cp}/${this.cpTotal}</span>`;
        }
        if (this.laps > 1) {
            const lap = Math.min(sim.lap, this.laps);
            if (L.lap !== lap) {
                L.lap = lap;
                setText(this.lapEl, `Lap ${lap}/${this.laps}`);
            }
        }
        if (this.platform && L.resp !== sim.respawns) {
            L.resp = sim.respawns;
            this.respEl.innerHTML = `${iconSvg('retry', 16)}<span class="pt-mono">${sim.respawns}</span>`;
        }
        if (view.effects) this._effects(view.effects);
        if (this.minimap) this.minimap.draw(view.pos, view.quat, opts.ghostPositions || NO_GHOSTS, opts.ghostColors || NO_GHOSTS, opts.markers || NO_GHOSTS);
    }

    _effects(e) {
        // A number per combination of effects (and the Snow Globe level), so a quiet frame allocates nothing.
        const key = (e.turbo ? (e.turbo === 2 ? 2 : 1) : 0) | (e.noEngine ? 4 : 0) | (e.noSteer ? 8 : 0) | (e.noBrake ? 16 : 0)
            | (e.cruise ? 32 : 0) | (e.fragile && !e.broken ? 64 : 0) | (e.broken ? 128 : 0) | ((e.slowmo || 0) << 8);
        if (this._last.fx === key) return;
        this._last.fx = key;
        const list = [];
        if (e.turbo) list.push(e.turbo === 2 ? 'turbo2' : 'turbo');
        if (e.noEngine) list.push('noEngine');
        if (e.noSteer) list.push('noSteer');
        if (e.noBrake) list.push('noBrake');
        if (e.slowmo) list.push('slowmo');
        if (e.cruise) list.push('cruise');
        if (e.fragile && !e.broken) list.push('fragile');
        if (e.broken) list.push('broken');
        this.effectsEl.replaceChildren(...list.map((id) => {
            const info = EFFECT_INFO[id];
            const name = id === 'slowmo' && e.slowmo > 1 ? `${info.name} ×${e.slowmo}` : info.name;
            return h('div.hud-effect', { class: info.tone, html: iconSvg(info.icon, 18) }, h('span', name));
        }));
    }

    /** A checkpoint split: time, and the difference to the PB at the same checkpoint (or null). */
    split(timeMs, diffMs) {
        if (!this.app.settings.showSplits) return;
        const [timeEl, diffEl] = this.splitEl.children;
        setText(timeEl, formatTime(timeMs));
        if (diffMs == null) {
            setText(diffEl, '');
            diffEl.className = 'hud-split-diff pt-mono';
        } else {
            setText(diffEl, formatTime(diffMs, { style: 'short', sign: true }));
            diffEl.className = 'hud-split-diff pt-mono ' + (diffMs < 0 ? 'ahead' : diffMs > 0 ? 'behind' : 'even');
        }
        this.splitEl.classList.remove('pt-hidden', 'pop');
        void this.splitEl.offsetWidth;
        this.splitEl.classList.add('pop');
        clearTimeout(this._splitTimer);
        this._splitTimer = setTimeout(() => this.hideSplit(), SPLIT_MS);
    }

    hideSplit() {
        clearTimeout(this._splitTimer);
        this.splitEl.classList.add('pt-hidden');
    }

    banner(text, kind = '', ms = 2200) {
        this.bannerEl.className = 'hud-banner ' + kind;
        setText(this.bannerEl, text);
        void this.bannerEl.offsetWidth;
        this.bannerEl.classList.add('pop');
        clearTimeout(this._bannerTimer);
        if (ms > 0) this._bannerTimer = setTimeout(() => this.hideBanner(), ms);
    }

    hideBanner() {
        clearTimeout(this._bannerTimer);
        this.bannerEl.classList.add('pt-hidden');
    }

    /** n: 3 | 2 | 1 | 'GO' | null (hide). */
    countdown(n) {
        if (n == null) {
            this.countEl.classList.add('pt-hidden');
            return;
        }
        this.countEl.className = 'hud-count ' + (n === 'GO' ? 'go' : 'n');
        setText(this.countEl, n === 'GO' ? 'GO!' : String(n));
        void this.countEl.offsetWidth;
        this.countEl.classList.add('pop');
    }

    dispose() {
        clearTimeout(this._splitTimer);
        clearTimeout(this._bannerTimer);
        if (this.minimap) this.minimap.dispose();
        this.el.remove();
    }
}
