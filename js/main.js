// Penguintrack bootstrap: builds the App (renderer, audio, storage, settings,
// controls, levels, loop, UI helpers), routes between screens, and loads the
// editor / TAS Studio / AI Lab / multiplayer screens on demand.
import * as storage from './game/storage.js';
import { sanitizeSettings } from './game/settings.js';
import { Controls } from './game/controls.js';
import { Loop } from './game/loop.js';
import { makeToaster, openModal, confirmDialog, promptDialog, showCodeDialog, modalOpen, topModal, moveFocus, focusablesIn } from './game/ui.js';
import { makeCatalog } from './game/catalog.js';
import { readLaunchLink } from './game/links.js';
import * as levels from './levels/index.js';
import { NullRenderer, NullAudio, hardenRenderer, hardenAudio } from './game/stubs.js';
import { Backdrop } from './game/backdrop.js';
import { h, isTypingTarget, loadModuleCss } from './game/dom.js';
import { iconSvg } from './game/icons.js';
import { currentAccount, identity, initAccounts } from './game/account.js';
import { readDevFlag } from './services/entitlements.js';
import { initPayments } from './services/payments.js';
import menu from './game/menu.js';
import campaign from './game/campaign.js';
import play from './game/play.js';
import results from './game/results.js';
import replays from './game/replays.js';
import mytracks from './game/mytracks.js';
import settingsScreen from './game/settings-screen.js';
import help from './game/help.js';
import { unavailableScreen } from './game/unavailable.js';

const SHELL_SCREENS = { menu, campaign, play, results, replays, mytracks, settings: settingsScreen, help };
const LAZY_SCREENS = { editor: './editor/editor.js', tas: './tas/studio.js', ai: './ai/lab.js', mp: './mp/mp.js' };
// Screens that show the attract-mode track behind them; moving between two of
// them keeps it flying instead of reloading.
const BACKDROP_SCREENS = new Set(['menu', 'campaign', 'replays', 'mytracks', 'settings', 'help', 'results']);
const ARROWS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

function hasWebGL() {
    try {
        const c = document.createElement('canvas');
        const gl = window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl'));
        // Give the probe context back right away: browsers cap live WebGL contexts.
        if (gl) gl.getExtension('WEBGL_lose_context')?.loseContext();
        return !!gl;
    } catch (e) {
        return false;
    }
}

async function tryImport(path) {
    try {
        return await import(path);
    } catch (e) {
        console.warn(`[penguintrack] ${path} not available:`, e.message);
        return null;
    }
}

class App {
    constructor() {
        const q = new URLSearchParams(location.search);
        this.debug = {
            autopilot: q.get('autopilot') === '1',
            attract: q.get('attract') || null,
            noBackdrop: q.get('noattract') === '1',
            fast: Number(q.get('fast')) > 0 ? Number(q.get('fast')) : 0,
        };
        this.query = q;
        this.storage = storage;
        this.settings = sanitizeSettings(storage.get('settings', null));
        this.canvas = document.getElementById('view');
        this.ui = document.getElementById('ui');
        this.loop = new Loop();
        this.controls = new Controls(this.settings);
        this.toast = makeToaster(document.body);
        this.screen = null;
        this.screenId = null;
        this.params = null;
        this._chain = Promise.resolve();
        this._lazy = new Map();
        this.webgl = hasWebGL();
        this.renderer = new NullRenderer();
        this.audio = new NullAudio();
        this.levels = levels;
        this.catalog = makeCatalog({ storage });
    }

    async init() {
        // Accounts load alongside the 3D engine: the hub's site account if it is
        // there, Firebase (purchases) once config.js is filled in.
        readDevFlag();
        const accounts = initAccounts().catch((e) => console.warn('[penguintrack] accounts:', e && e.message));
        this.controls.attach(window);
        this.controls.mountTouch(document.body);
        this.loop.onError = () => {
            this.toast('Something slipped on the ice. Back to the menu.', { kind: 'bad', ms: 4000 });
            this.goto('menu');
        };

        // Three.js is only fetched when there is WebGL to draw with; either module
        // failing to load leaves a silent stand-in so the menus still work.
        const [renderMod, audioMod] = await Promise.all([
            this.webgl ? tryImport('./render/renderer.js') : null,
            tryImport('./audio/audio.js'),
        ]);

        if (renderMod && renderMod.GameRenderer) {
            try {
                this.renderer = new renderMod.GameRenderer(this.canvas, { quality: this.settings.quality, reducedMotion: this.settings.reducedMotion });
            } catch (e) {
                console.error('[penguintrack] renderer failed to start', e);
                this.renderer = new NullRenderer();
                if (this.webgl) this.webgl = false;
            }
        }
        hardenRenderer(this.renderer);
        if (audioMod && audioMod.AudioEngine) {
            try {
                this.audio = new audioMod.AudioEngine();
            } catch (e) {
                console.error('[penguintrack] audio failed to start', e);
                this.audio = new NullAudio();
            }
        }
        hardenAudio(this.audio);
        this.backdrop = new Backdrop(this);
        this._applySettings();

        window.addEventListener('resize', () => this.renderer.resize());
        document.addEventListener('keydown', (e) => this._onKey(e));
        // Browsers only start audio after a gesture; this keeps trying until one counts.
        this.audio.autoUnlock(window);
        // A tactile click on every press (tabs and switches included).
        document.addEventListener('click', (e) => {
            const b = e.target.closest && e.target.closest('button, a.pt-btn, [role="tab"], [role="switch"], summary');
            if (b && !b.disabled) this.audio.ui(b.dataset.sound || 'click');
        }, true);
        this.controls.onDevice = (d) => document.documentElement.setAttribute('data-input', d);
        document.documentElement.setAttribute('data-input', 'keyboard');
        this._padFrame = this._padFrame.bind(this);
        requestAnimationFrame(this._padFrame);

        const boot = document.getElementById('boot');
        if (boot) {
            boot.classList.add('out');
            setTimeout(() => boot.remove(), 400);
        }
        await accounts;
        initPayments(this);
        await this._start();
        if (!this.webgl) this._noWebGL();
    }

    _start() {
        const q = this.query;
        // Invite links drop straight into the online room; track links into My Tracks.
        const link = readLaunchLink(q);
        if (link && link.room) return this.goto('mp', { view: 'online', room: link.room, host: link.host });
        if (link && link.track) return this.goto('mytracks', { importCode: link.track });
        const playId = q.get('play');
        const screen = q.get('screen');
        if (playId) return this.goto('play', { track: playId, mode: q.get('mode') || undefined });
        if (screen && (SHELL_SCREENS[screen] || LAZY_SCREENS[screen])) return this.goto(screen, {});
        return this.goto('menu');
    }

    _noWebGL() {
        openModal((close) => h('div.pt-col',
            h('div.nogl-icon', { html: iconSvg('snowflake', 46) }),
            h('h2.pt-subtitle', 'No 3D on this device'),
            h('p.pt-modal-msg', 'Penguintrack draws its tracks with WebGL, and this browser (or its settings) has it switched off. Try a recent Chrome, Edge, Firefox or Safari, or turn on hardware acceleration. The menus and your saved tracks still work here.'),
            h('div.pt-row.pt-modal-actions',
                h('a.pt-btn', { href: '../Empire/' }, 'Back to the site'),
                h('button.pt-btn.primary', { type: 'button', 'data-autofocus': true, onclick: () => close(true) }, 'Look around anyway'))), { label: 'WebGL unavailable' });
    }

    // ------------------------------------------------------------- routing

    /** Switches screens (serialised: a goto issued during a transition runs after it). */
    goto(id, params = {}) {
        this._chain = this._chain.then(() => this._goto(id, params)).catch((e) => console.error('[penguintrack] navigation failed', e));
        return this._chain;
    }

    async _goto(id, params) {
        const prev = this.screen;
        const prevId = this.screenId;
        if (prev) {
            try {
                await prev.exit?.(this);
            } catch (e) {
                console.error(`[penguintrack] ${prevId}.exit failed`, e);
            }
        }
        while (modalOpen()) topModal().cancel();
        const keepBackdrop = BACKDROP_SCREENS.has(prevId) && BACKDROP_SCREENS.has(id) && this.backdrop.running;
        if (!keepBackdrop) {
            this.loop.stop();
            this.loop.timeScale = 1;
            this.loop.maxTicksPerFrame = 25;
        }
        if (!BACKDROP_SCREENS.has(id)) this.backdrop.stop();
        this.controls.setActive(false);
        this.ui.replaceChildren();
        this.ui.dataset.screen = id;
        let screen = SHELL_SCREENS[id] || null;
        if (!screen && LAZY_SCREENS[id]) screen = await this._loadLazy(id);
        if (!screen) {
            console.warn(`[penguintrack] unknown screen '${id}'`);
            screen = menu;
            id = 'menu';
        }
        this.screen = screen;
        this.screenId = id;
        this.params = params;
        document.documentElement.setAttribute('data-screen', id);
        try {
            await screen.enter(this, params || {});
        } catch (e) {
            console.error(`[penguintrack] ${id}.enter failed`, e);
            if (!screen.shell || id === 'menu') {
                this.screen = unavailableScreen(id, e);
                this.ui.replaceChildren();
                await this.screen.enter(this, {});
            } else {
                this.toast('Something slipped on the ice. Back to the menu.', { kind: 'bad', ms: 4000 });
                this.goto('menu');
            }
        }
    }

    async _loadLazy(id) {
        if (this._lazy.has(id)) return this._lazy.get(id);
        let screen;
        try {
            // The stylesheet loads alongside the code so the screen never flashes unstyled.
            const [mod] = await Promise.all([import(LAZY_SCREENS[id]), loadModuleCss(id)]);
            screen = mod.default || mod.screen;
            if (!screen || typeof screen.enter !== 'function') throw new Error(`${LAZY_SCREENS[id]} has no default screen export`);
        } catch (e) {
            console.warn(`[penguintrack] ${id} screen not available:`, e.message);
            return unavailableScreen(id, e);   // not cached: it may land later in this session
        }
        this._lazy.set(id, screen);
        return screen;
    }

    // ------------------------------------------------------------- services

    /** Shows a built world (renderer.world tells the attract mode what is on screen). */
    loadWorld(world, track) {
        this.renderer.loadWorld(world, track);
    }

    saveSettings() {
        storage.set('settings', this.settings);
        this._applySettings();
    }

    _applySettings() {
        const s = this.settings;
        this.audio.setVolume({ ...s.volume });
        this.controls.setSettings(s);
        document.documentElement.classList.toggle('pt-reduce-motion', !!s.reducedMotion);
        this.renderer.setReducedMotion(!!s.reducedMotion);
    }

    /** Applies settings.quality to the live renderer (it rebuilds the shown world). */
    applyQuality() {
        this.renderer.setQuality(this.settings.quality);
    }

    /** Menu music on or off (the engine remembers the wish until a gesture unlocks audio). */
    setMusic(on) {
        this.audio.music(!!on);
    }

    confirm(message, opts) {
        return confirmDialog(message, opts);
    }

    prompt(title, opts) {
        return promptDialog(title, opts);
    }

    modal(build, opts) {
        return openModal(build, opts);
    }

    showCode(title, code, opts) {
        return showCodeDialog(title, code, opts);
    }

    account() {
        return currentAccount();
    }

    /** { name, uid, provider, site, firebase }: see game/account.js. */
    identity() {
        return identity();
    }

    // ------------------------------------------------------------- input

    _onKey(e) {
        if (e.defaultPrevented) return;
        const dir = ARROWS[e.key];
        if (modalOpen()) {
            // Keys meant for a dialog never reach the race (the controls saw this key first).
            this.controls.clearEdges();
            const m = topModal();
            if (e.key === 'Escape') {
                e.preventDefault();
                m.cancel();
            } else if (dir && !isTypingTarget(e.target) && !(e.target.type === 'range' && (dir === 'left' || dir === 'right'))) {
                e.preventDefault();
                if (moveFocus(m.panel, dir)) this.audio.ui('hover');
            } else if (e.key === 'Tab') {
                // Keep Tab inside the dialog.
                const items = focusablesIn(m.panel);
                if (!items.length) return;
                const i = items.indexOf(document.activeElement);
                const next = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : (i + 1) % items.length;
                e.preventDefault();
                items[next].focus();
            }
            return;
        }
        if (this.controls.active) return;   // racing: the play screen reads its own controls
        const s = this.screen;
        if (!s || !s.shell) return;          // editor, TAS, AI and multiplayer handle their own keys
        if (isTypingTarget(e.target)) {
            if (e.key === 'Escape') e.target.blur();
            return;
        }
        if (s.onKey && s.onKey(e, this) === true) {
            e.preventDefault();
            return;
        }
        if (e.key === 'Escape' || (e.key === 'Backspace' && this.screenId !== 'play')) {
            if (s.back) {
                e.preventDefault();
                this.audio.ui('back');
                s.back(this);
            }
            return;
        }
        if (dir) {
            if (e.target.type === 'range' && (dir === 'left' || dir === 'right')) return;
            e.preventDefault();
            if (moveFocus(this.ui, dir)) this.audio.ui('hover');
        }
    }

    _padFrame(now) {
        requestAnimationFrame(this._padFrame);
        this.controls.poll(now);
        const edges = this.controls.navEdges();
        if (!edges.length) return;
        if (this.controls.active && !modalOpen()) return;
        const root = modalOpen() ? topModal().panel : this.ui;
        for (const e of edges) {
            if (e === 'accept') {
                const el = document.activeElement;
                if (el && root.contains(el) && el !== document.body) el.click();
                else moveFocus(root, 'down');
            } else if (e === 'back') {
                if (modalOpen()) topModal().cancel();
                else if (this.screen && this.screen.back) this.screen.back(this);
            } else if (moveFocus(root, e)) {
                this.audio.ui('hover');
            }
        }
    }
}

const app = new App();
window.__pt = app;
app.init().catch((e) => {
    console.error('[penguintrack] failed to start', e);
    const msg = document.querySelector('#boot .pt-boot-msg');
    if (msg) msg.textContent = 'Penguintrack could not start: ' + (e && e.message ? e.message : e);
});

export default app;
