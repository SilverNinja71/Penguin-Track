// Results: the time, a medal reveal, the difference to the previous personal
// best, splits, respawns, and Retry / Next / Watch replay / Save replay / Back.
// The record itself was saved the moment the car crossed the line (race.js),
// so a quick Backspace restart never loses a personal best.
import { formatTime } from '../core/format.js';
import { h } from './dom.js';
import { iconSvg } from './icons.js';
import { saveReplay } from './records.js';
import { defaultExit, defaultExitParams } from './race.js';

const LADDER = ['bronze', 'silver', 'gold', 'emperor'];

/** Colour class of a time difference, as on the HUD: blue ahead, red behind. */
const tone = (d) => (d == null ? '' : d < 0 ? 'ahead' : d > 0 ? 'behind' : 'even');
const signed = (d) => (d == null ? '' : formatTime(d, { style: 'short', sign: true }));

const results = {
    id: 'results',
    shell: true,

    enter(app, params = {}) {
        this.app = app;
        this.params = params;
        const { track, mode, result, outcome } = params;
        if (!track || !result) {
            app.goto('menu');
            return;
        }
        this.stage = params.stage || null;
        if (this.stage) app.loop.start(this.stage.tick, this.stage.frame);
        else app.backdrop.start();
        app.setMusic(true);

        const cat = app.catalog;
        const platform = track.mode === 'platform';
        const medal = outcome ? outcome.medal : cat.medalFor(track, result);
        const prev = result.pbBefore || (outcome && outcome.previous) || null;
        const prevMs = prev && Number.isFinite(prev.bestMs) ? prev.bestMs : null;
        const improved = outcome ? outcome.improved : false;
        const nextId = mode === 'campaign' ? cat.nextTrackId(track.id) : null;
        this.saved = false;

        // ---- headline
        let diffEl = null;
        if (prevMs != null) {
            const d = result.timeMs - prevMs;
            const respD = platform ? (result.respawns || 0) - (prev.respawns || 0) : 0;
            diffEl = h('div.res-diff', { class: improved ? 'ahead' : d === 0 && respD === 0 ? 'even' : 'behind' },
                h('span.pt-mono', signed(d)),
                platform && respD !== 0 ? h('span.pt-mono', ` · ${respD > 0 ? '+' : ''}${respD} resp.`) : null,
                h('span.res-diff-label', improved ? 'New personal best!' : `PB ${formatTime(prevMs)}`));
        } else if (mode !== 'test') {
            diffEl = h('div.res-diff.first', h('span.res-diff-label', 'First finish on this track!'));
        }

        const medalName = medal ? cat.medalLabel(medal) : null;
        const hasMedals = cat.medalTargets(track).length > 0;
        const bigMedal = h('div.res-medal-big', { class: (medal || 'none') + (hasMedals ? '' : ' pt-hidden') },
            h('span.pt-medal.big', { class: medal || 'none' }),
            h('div.res-medal-name', medal ? `${medalName} medal` : 'No medal yet'));
        const ladder = h('div.res-ladder', LADDER.map((m) => {
            const tg = cat.medalTargets(track).find((t) => t.medal === m);
            if (!tg) return null;
            const got = medal && cat.medalRank(medal) <= cat.medalRank(m);
            // Platform targets read 'no respawns · 0:24.41': one line per part.
            return h('div.res-step', { class: got ? 'got' : '', dataset: { medal: m } },
                h('span.pt-medal', { class: m }),
                h('span.res-step-name', tg.label),
                tg.text.split(' · ').map((part) => h('span.res-step-time.pt-mono', part)));
        }));

        const respawnsLine = (platform || result.respawns)
            ? h('div.res-stat', h('span.pt-ico', { html: iconSvg('retry', 18) }), `${result.respawns || 0} respawn${result.respawns === 1 ? '' : 's'}`)
            : null;
        const goldLine = outcome && outcome.gold
            ? h('div.res-gold', h('span.res-coin'), `+${outcome.gold.amount} gold`, h('span.pt-muted', ` (${outcome.gold.total} total)`))
            : null;
        const autoTag = result.autopilot ? h('span.pt-tag', 'Autopilot run') : null;

        // ---- splits
        const pbSplits = prev && Array.isArray(prev.splits) ? prev.splits : null;
        const splitRows = (result.splits || []).map((t, i) => {
            const pb = pbSplits && Number.isFinite(pbSplits[i]) ? pbSplits[i] : null;
            const d = pb == null ? null : t - pb;
            return h('tr',
                h('td.pt-muted', `CP ${i + 1}`),
                h('td.pt-mono', formatTime(t)),
                h('td.pt-mono', { class: tone(d) }, signed(d)));
        });
        if (result.lapTimes && result.lapTimes.length > 1) {
            result.lapTimes.forEach((t, i) => splitRows.push(h('tr.lap', h('td.pt-muted', `Lap ${i + 1}`), h('td.pt-mono', formatTime(t)), h('td'))));
        }
        const finishD = prevMs != null ? result.timeMs - prevMs : null;
        splitRows.push(h('tr.fin',
            h('td', 'Finish'),
            h('td.pt-mono', formatTime(result.timeMs)),
            h('td.pt-mono', { class: tone(finishD) }, signed(finishD))));

        // ---- actions
        const B = (label, iconName, onclick, opts = {}) => h('button.pt-btn', {
            type: 'button', class: opts.cls || '', onclick, 'data-autofocus': opts.focus || null, 'data-sound': opts.sound || null,
        }, h('span.pt-ico', { html: iconSvg(iconName, 20) }), label, opts.kbd ? h('span.pt-kbd', opts.kbd) : null);
        this.saveBtn = B('Save replay', 'save', () => this.saveReplay());
        const pp = params.playParams || {};
        const backLabel = pp.exitLabel || (mode === 'test' ? 'Back to editor' : 'Back');
        this.canRetry = pp.retry !== false;
        const actions = h('div.res-actions',
            this.canRetry ? B('Retry', 'retry', () => this.retry(), { cls: nextId ? '' : 'primary', focus: !nextId, kbd: '⌫' }) : null,
            nextId ? B('Next track', 'next', () => app.goto('play', { track: nextId, mode: 'campaign' }), { cls: 'primary', focus: true }) : null,
            B('Watch replay', 'film', () => this.watch()),
            this.saveBtn,
            B(backLabel, 'back', () => this.back(), { cls: this.canRetry ? 'ghost' : 'primary', focus: !this.canRetry && !nextId, sound: 'back', kbd: 'Esc' }));

        const panel = h('div.res-panel.pt-panel',
            h('div.res-head',
                h('div.res-kicker', h('span.pt-ico', { html: iconSvg('flag', 18) }), 'Finish', autoTag),
                h('h1.res-track', track.name || 'Untitled Track')),
            h('div.res-body',
                h('div.res-main',
                    h('div.res-time.pt-mono', formatTime(result.timeMs)),
                    diffEl,
                    h('div.res-stats', respawnsLine, goldLine),
                    bigMedal,
                    ladder),
                h('div.res-side',
                    h('div.res-side-title', 'Splits'),
                    h('div.res-splits.pt-scroll', h('table', h('tbody', splitRows))))),
            actions);
        this.el = h('div.pt-screen.results-screen', panel);
        app.ui.appendChild(this.el);
        if (params.revisit) {
            bigMedal.classList.add('in');
            return;
        }
        this._reveal(medal, ladder, bigMedal);
        if (outcome && outcome.gold) app.toast(`+${outcome.gold.amount} gold for your ${medalName} medal!`, { kind: 'gold', icon: 'trophy', ms: 4200 });
    },

    _reveal(medal, ladder, bigMedal) {
        // Light the ladder rung by rung, then drop the medal in.
        const app = this.app;
        const rungs = [...ladder.querySelectorAll('.res-step.got')];
        const reduced = app.settings.reducedMotion;
        const step = reduced ? 0 : 260;
        this._timers = [];
        rungs.forEach((r, i) => {
            r.classList.add('wait');
            this._timers.push(setTimeout(() => {
                r.classList.remove('wait');
                r.classList.add('lit');
                app.audio.ui('hover');
            }, 300 + i * step));
        });
        bigMedal.classList.add('wait');
        this._timers.push(setTimeout(() => {
            bigMedal.classList.remove('wait');
            bigMedal.classList.add('in');
            if (medal) app.audio.ui('medal', medal);
        }, 360 + rungs.length * step));
    },

    retry() {
        const p = this.params;
        this.app.goto('play', { ...(p.playParams || {}), track: p.track, mode: p.mode });
    },

    watch() {
        const p = this.params;
        const back = { ...p, stage: null, revisit: true };
        this.app.goto('play', { track: p.track, mode: 'replay', replay: p.result.replay, onExit: () => this.app.goto('results', back) });
    },

    saveReplay() {
        if (this.saved) return;
        const { track, result } = this.params;
        const cat = this.app.catalog;
        const entry = saveReplay(this.app.storage, {
            name: `${track.name} ${formatTime(result.timeMs)}`,
            trackId: track.id,
            trackName: track.name,
            track: cat.isCampaign(track.id) ? undefined : track,
            replay: result.replay,
            timeMs: result.timeMs,
            respawns: result.respawns || 0,
            medal: cat.medalFor(track, result),
        });
        if (!entry) {
            this.app.toast('Storage is full: delete some replays first.', { kind: 'bad' });
            return;
        }
        this.saved = true;
        this.saveBtn.disabled = true;
        this.saveBtn.lastChild.textContent = 'Saved';
        this.app.toast('Replay saved', { icon: 'save' });
    },

    back() {
        const p = this.params;
        const onExit = p.playParams && p.playParams.onExit;
        if (typeof onExit === 'function') onExit(p.result);
        else this.app.goto(defaultExit(p.mode), defaultExitParams(p.mode, p.track));
    },

    onKey(e) {
        if (e.key === 'Backspace' || e.key === 'Delete') {
            if (this.canRetry) this.retry();
            return true;
        }
        return false;
    },

    exit(app) {
        for (const t of this._timers || []) clearTimeout(t);
        if (this.stage) {
            this.stage.dispose();
            this.stage = null;
            app.loop.stop();
        }
    },
};

export default results;
