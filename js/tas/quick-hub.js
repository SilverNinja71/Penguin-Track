// The TAS screen's two modes and the Quick TAS start page. Quick TAS (Race &
// Rewind, the default) is a normal race with savestate markers (race.js with
// params.quickTas, js/tas/quick.js); Pro TAS Studio is the frame-by-frame
// editor (studio.js). The choice is remembered under storage 'tasMode'.
import { trackHash } from '../core/codec.js';
import { h } from '../game/dom.js';
import { iconSvg } from '../game/icons.js';
import { keyLabel } from '../game/settings.js';
import { moveFocus, modalOpen } from '../game/ui.js';
import { leaderboardPanel } from '../game/leaderboard.js';

export const TAS_MODES = ['quick', 'pro'];

// The track picked last on the start page, kept while the page is open.
let lastTrack = null;

const icon = (name, size = 18) => h('span.pt-ico', { html: iconSvg(name, size) });

/** The remembered TAS mode: 'quick' (default) or 'pro'. */
export function getTasMode(storage) {
    const m = storage.get('tasMode', 'quick');
    return TAS_MODES.includes(m) ? m : 'quick';
}

/** Remembers `mode` and opens it (the Pro Studio reopens the project that was open). */
export function switchTasMode(app, mode) {
    if (!TAS_MODES.includes(mode)) return;
    app.storage.set('tasMode', mode);
    app.goto('tas', mode === 'pro' ? { pro: true } : { quick: true });
}

/** The Quick TAS / Pro TAS Studio switch shown on both pages. */
export function tasModeToggle(app, current) {
    const opt = (mode, label, sub) => h('button.tas-mode-opt', {
        type: 'button', role: 'radio', 'aria-checked': String(mode === current), class: mode === current ? 'active' : '',
        tabIndex: mode === current ? 0 : -1,
        onclick: () => { if (mode !== current) switchTasMode(app, mode); },
        onkeydown: (e) => {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
            e.preventDefault();
            e.stopPropagation();
            switchTasMode(app, current === 'quick' ? 'pro' : 'quick');
        },
    }, h('b', label), h('small', sub));
    return h('div.tas-mode', { role: 'radiogroup', 'aria-label': 'TAS mode' },
        opt('quick', 'Quick TAS', 'Race & Rewind'),
        opt('pro', 'Pro TAS Studio', 'Frame by frame'));
}

/** Track list for the picker: [{ group, items: [{ id, name }] }] (campaigns, then the player's own). */
function trackGroups(cat) {
    const out = [];
    for (const c of cat.campaigns()) {
        for (const t of c.tiers) {
            if (t.tracks.length) out.push({ group: c.tiers.length > 1 ? `${c.name}: ${t.name}` : c.name, items: t.tracks.map((x) => ({ id: x.id, name: `${x.id} ${x.name}` })) });
        }
    }
    const mine = cat.customTracks();
    if (mine.length) out.push({ group: 'My tracks', items: mine.map((t) => ({ id: t.id, name: t.name || t.id })) });
    return out;
}

export class QuickHub {
    constructor(app) {
        this.app = app;
        this.el = null;
        this._offs = [];
    }

    open(params = {}) {
        const app = this.app, cat = app.catalog;
        app.backdrop.start();
        const groups = trackGroups(cat);
        const ids = groups.flatMap((g) => g.items.map((t) => t.id));
        const want = typeof params.select === 'string' ? params.select : params.select && params.select.id;
        this.trackId = [want, lastTrack, ids[0]].find((id) => id && ids.includes(id)) || null;

        const k = (action) => {
            const keys = app.settings.bindings[action] || [];
            return keys.length ? keys.map((c) => h('span.pt-kbd', keyLabel(c))) : h('span.pt-kbd', 'unbound');
        };
        const step = (n, title, text, keys) => h('li.qh-step', h('span.qh-num', String(n)),
            h('div', h('b', title), h('p.pt-muted', text), keys ? h('div.qh-keys', keys) : null));

        this.picker = h('select.pt-input.qh-track', { 'aria-label': 'Track' }, groups.map((g) => h('optgroup', { label: g.group },
            g.items.map((t) => h('option', { value: t.id, selected: t.id === this.trackId }, t.name)))));
        this.picker.addEventListener('change', () => this.pick(this.picker.value));
        this.boardHost = h('div.qh-board');
        this.startBtn = h('button.pt-btn.primary.big.qh-start', { type: 'button', 'data-autofocus': true, onclick: () => this.start() },
            icon('play', 24), 'Start Quick TAS');

        this.el = h('div.pt-screen.tas-hub',
            h('header.qh-top',
                h('button.pt-btn.small.ghost', { type: 'button', 'data-sound': 'back', onclick: () => this.back() }, icon('back'), 'Menu'),
                h('h1.pt-title', 'TAS'),
                tasModeToggle(app, 'quick')),
            h('div.qh-main',
                h('section.qh-how.pt-panel',
                    h('h2.pt-subtitle', icon('tas', 22), 'Quick TAS: Race & Rewind'),
                    h('p.qh-lead', 'Drive the track normally. Every input is recorded in the background, and you can save the exact moment you are in and jump back to it as often as you like, until the run is perfect.'),
                    h('ol.qh-steps',
                        step(1, 'Drop a marker', 'Saves a savestate: position, speed, spin, wheels and the race clock, plus a flag on the track.', k('tasMark')),
                        step(2, 'Rewind', 'Jumps back to your newest marker instantly. Everything after it is cut and the recording carries on.', k('tasRewind')),
                        step(3, 'Pick a marker', 'Step back to an earlier marker to retry a corner. Later markers stay until you drop a new one after an earlier marker.', [k('tasPrev'), k('tasNext')]),
                        step(4, 'Fine-tune', 'Pause (or finish) and choose Open in Pro Studio to polish the same inputs frame by frame.', null)),
                    h('p.qh-note.pt-muted', 'A run with no markers and no rewinds still counts as a Pure run. Use a marker or a rewind and it goes on the Best TAS board instead.')),
                h('section.qh-side.pt-panel',
                    h('label.qh-field', h('span', 'Track'), this.picker),
                    this.boardHost,
                    this.startBtn)));
        app.ui.appendChild(this.el);
        this.renderBoard();

        const onKey = (e) => this.onKey(e);
        document.addEventListener('keydown', onKey);
        this._offs.push(() => document.removeEventListener('keydown', onKey));
        requestAnimationFrame(() => this.startBtn.focus({ preventScroll: true }));
    }

    pick(id) {
        this.trackId = id;
        lastTrack = id;
        this.renderBoard();
    }

    renderBoard() {
        const track = this.trackId ? this.app.catalog.getTrack(this.trackId) : null;
        this.startBtn.disabled = !track;
        if (!track) {
            this.boardHost.replaceChildren(h('p.pt-muted', 'No tracks to race yet.'));
            return;
        }
        let hash = null;
        try { hash = trackHash(track); } catch (e) { /* the board lists every layout */ }
        this.boardHost.replaceChildren(leaderboardPanel(this.app, track, hash, { tab: 'tas' }));
    }

    start() {
        const app = this.app, id = this.trackId;
        if (!id) return;
        lastTrack = id;
        app.goto('play', {
            track: id, mode: app.catalog.isCampaign(id) ? 'campaign' : 'custom', quickTas: true, exitLabel: 'Back to TAS',
            onExit: () => app.goto('tas', { quick: true, select: id }),
        });
    }

    back() {
        this.app.goto('menu');
    }

    onKey(e) {
        if (e.defaultPrevented || modalOpen()) return;
        const tag = e.target && e.target.tagName;
        if (e.key === 'Escape' || (e.key === 'Backspace' && tag !== 'INPUT' && tag !== 'TEXTAREA')) {
            e.preventDefault();
            this.app.audio.ui('back');
            this.back();
            return;
        }
        const dir = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }[e.key];
        if (dir && tag !== 'SELECT' && moveFocus(this.el, dir)) {
            e.preventDefault();
            this.app.audio.ui('hover');
        }
    }

    dispose() {
        for (const off of this._offs) off();
        this._offs.length = 0;
        if (this.el) this.el.remove();
        this.el = null;
    }
}
