// Multiplayer screen: hot-seat turns, two-player split-screen on one keyboard,
// and online time-attack rooms over PeerJS. Cars never collide: everyone else
// is a ghost, the fastest time wins. Params: { view?: 'hotseat'|'split'|'online' }.
import { h } from '../game/dom.js';
import { moveFocus, modalOpen } from '../game/ui.js';
import { ensureCss, ico, typing, savePrefs, loadPrefs } from './common.js';
import { createHotseatView, hasMatch } from './hotseat-view.js';
import { createSplitView } from './split-view.js';
import { createOnlineView, onlineActive, onlineSession } from './online-view.js';

const TABS = [
    { id: 'hotseat', label: 'Hot-seat', icon: 'users', blurb: 'Take turns, pass the pad' },
    { id: 'split', label: 'Split-screen', icon: 'gamepad', blurb: 'Two penguins, one keyboard' },
    { id: 'online', label: 'Online rooms', icon: 'link', blurb: 'Time attack with friends' },
];

const screen = {
    id: 'mp',
    view: null,

    enter(app, params = {}) {
        ensureCss();
        this.app = app;
        this.tab = params.view || (onlineActive() ? 'online' : hasMatch() ? 'hotseat' : loadPrefs(app).tab) || 'hotseat';
        if (!TABS.some((t) => t.id === this.tab)) this.tab = 'hotseat';
        this.tabBtns = new Map();
        const tabs = h('div.mp-tabs', { role: 'tablist', 'aria-label': 'Multiplayer modes' }, TABS.map((t) => {
            const b = h('button.pt-btn.mp-tab', {
                type: 'button', role: 'tab', id: `mp-tab-${t.id}`, 'aria-controls': 'mp-body',
                onclick: () => this.show(t.id),
            }, ico(t.icon, 22), h('span.mp-tab-text', h('span.mp-tab-label', t.label), h('span.mp-tab-blurb', t.blurb)));
            this.tabBtns.set(t.id, b);
            return b;
        }));
        this.body = h('div.mp-body.pt-scroll', { id: 'mp-body', role: 'tabpanel' });
        this.head = h('header.mp-head',
            h('button.pt-btn.small.ghost', { type: 'button', 'data-sound': 'back', onclick: () => this.back() }, ico('back', 18), 'Menu'),
            h('h1.pt-title', 'Multiplayer'),
            h('div.pt-spacer'),
            h('span.mp-head-note.pt-muted', ico('ghost', 16), 'No collisions: rivals are ghosts'));
        this.el = h('div.pt-screen.mp-screen', this.head, tabs, this.body);
        app.ui.appendChild(this.el);
        this._onKey = (e) => this.onKey(e);
        document.addEventListener('keydown', this._onKey);
        this.nav = {
            // A view that takes over the whole screen (racing) hides the hub chrome.
            fullscreen: (on) => this.el.classList.toggle('mp-fullscreen', !!on),
            menus: () => this.menus(),
        };
        this.menus();
        this.show(this.tab, true);
    },

    /** The attract track behind the menus, music on. */
    menus() {
        const app = this.app;
        app.backdrop.start();
        app.setMusic(true);
    },

    async show(tab, first = false) {
        if (!first && tab === this.tab && this.view) return;
        if (!first && this.tab === 'online' && onlineActive()) {
            if (!(await this.app.confirm('Leave the room to switch modes?', { ok: 'Leave room' }))) return;
            if (!this.el) return;
            this.view.dispose(true);
        } else if (this.view) this.view.dispose();
        this.view = null;
        this.tab = tab;
        savePrefs(this.app, { tab });
        for (const [id, b] of this.tabBtns) {
            b.classList.toggle('active', id === tab);
            b.setAttribute('aria-selected', id === tab ? 'true' : 'false');
        }
        this.el.classList.remove('mp-fullscreen');
        const make = tab === 'split' ? createSplitView : tab === 'online' ? createOnlineView : createHotseatView;
        this.view = make(this.app, this.nav);
        this.body.replaceChildren(this.view.el);
        if (!first) this.tabBtns.get(tab).focus({ preventScroll: true });
        else {
            const f = this.body.querySelector('[data-autofocus]') || this.tabBtns.get(tab);
            requestAnimationFrame(() => f.isConnected && f.focus({ preventScroll: true }));
        }
    },

    async back() {
        if (this.view && this.view.back && this.view.back() === true) return;
        if (onlineActive() && !(await this.app.confirm('Leave the room? Your friends keep racing without you.', { ok: 'Leave room' }))) return;
        this.app.goto('menu');
    },

    onKey(e) {
        if (modalOpen() || e.defaultPrevented) return;
        if (this.view && this.view.onKey && this.view.onKey(e) === true) {
            e.preventDefault();
            return;
        }
        if (typing(e)) {
            if (e.key === 'Escape') e.target.blur();
            return;
        }
        if (e.key === 'Escape') {
            e.preventDefault();
            this.app.audio.ui('back');
            this.back();
            return;
        }
        const dir = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }[e.key];
        if (dir && !(e.target && e.target.type === 'range')) {
            e.preventDefault();
            if (moveFocus(this.el, dir)) this.app.audio.ui('hover');
        }
        if ((e.key === 'q' || e.key === 'e' || e.key === 'PageUp' || e.key === 'PageDown') && !e.repeat) {
            const i = TABS.findIndex((t) => t.id === this.tab);
            const d = e.key === 'q' || e.key === 'PageUp' ? -1 : 1;
            this.show(TABS[(i + d + TABS.length) % TABS.length].id);
        }
    },

    /** Debugging: the live online room ({ host, client, code }) or null. */
    room() {
        return onlineSession();
    },

    exit() {
        document.removeEventListener('keydown', this._onKey);
        if (this.view) this.view.dispose(true);
        this.view = null;
        this.el = null;
    },
};

export default screen;
