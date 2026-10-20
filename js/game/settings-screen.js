// Settings: sound, graphics, race options, gamepad and touch, and key
// remapping for every action. Every change is saved at once.
import { h } from './dom.js';
import { icon } from './icons.js';
import { ACTIONS, CAMERAS, DEFAULT_BINDINGS, cloneBindings, defaultSettings, keyLabel, bindingsConflict } from './settings.js';
import { openModal } from './ui.js';

function slider(app, label, get, set, { min = 0, max = 1, step = 0.05, fmt = (v) => `${Math.round(v * 100)}%` } = {}) {
    const out = h('span.set-value.pt-mono', fmt(get()));
    const input = h('input', { type: 'range', min, max, step, value: get(), 'aria-label': label });
    input.addEventListener('input', () => {
        set(Number(input.value));
        out.textContent = fmt(get());
        app.saveSettings();
    });
    return h('label.set-row', h('span.set-label', label), h('span.set-control', input, out));
}

function toggle(app, label, get, set, hint = '') {
    const btn = h('button.pt-switch', { type: 'button', role: 'switch', 'aria-checked': String(get()), 'aria-label': label });
    btn.addEventListener('click', () => {
        set(!get());
        btn.setAttribute('aria-checked', String(get()));
        app.saveSettings();
    });
    return h('div.set-row', h('span.set-label', label, hint ? h('span.set-hint', hint) : null), h('span.set-control', btn));
}

function segmented(app, label, options, get, set) {
    const btns = options.map((o) => h('button.pt-btn.small', {
        type: 'button', class: o.id === get() ? 'active' : '', 'aria-pressed': String(o.id === get()),
        onclick: () => {
            set(o.id);
            for (const b of btns) {
                const on = b._id === get();
                b.classList.toggle('active', on);
                b.setAttribute('aria-pressed', String(on));
            }
            app.saveSettings();
        },
    }, o.label));
    options.forEach((o, i) => { btns[i]._id = o.id; });
    return h('div.set-row', h('span.set-label', label), h('span.set-control', h('div.pt-seg', { role: 'group', 'aria-label': label }, btns)));
}

/** Sections shared by the settings screen and the in-race quick settings. */
export function buildSettings(app, { compact = false } = {}) {
    const s = app.settings;
    const sections = [];
    sections.push(h('section.set-section',
        h('h2.set-title', icon('volume', 20), 'Sound'),
        slider(app, 'Master volume', () => s.volume.master, (v) => { s.volume.master = v; }),
        slider(app, 'Effects', () => s.volume.sfx, (v) => { s.volume.sfx = v; }),
        slider(app, 'Music', () => s.volume.music, (v) => { s.volume.music = v; })));
    sections.push(h('section.set-section',
        h('h2.set-title', icon('flag', 20), 'Race'),
        segmented(app, 'Default camera', CAMERAS, () => s.camera, (v) => { s.camera = v; }),
        toggle(app, 'Best human ghost', () => s.showGhost, (v) => { s.showGhost = v; }, 'your personal best Pure run'),
        toggle(app, 'Best TAS ghost', () => s.showTasGhost, (v) => { s.showTasGhost = v; }, 'fastest Quick TAS or Studio run'),
        toggle(app, 'Best AI ghost', () => s.showAiGhost, (v) => { s.showAiGhost = v; }, 'fastest AI Lab or autopilot run'),
        toggle(app, 'Emperor ghost', () => s.showEmperorGhost, (v) => { s.showEmperorGhost = v; }, 'the author run, when the track has one'),
        toggle(app, 'Checkpoint splits', () => s.showSplits, (v) => { s.showSplits = v; }),
        toggle(app, 'Minimap', () => s.showMinimap, (v) => { s.showMinimap = v; }),
        segmented(app, 'Speed units', [{ id: 'kmh', label: 'km/h' }, { id: 'mph', label: 'mph' }], () => s.units, (v) => { s.units = v; })));
    if (compact) {
        sections.push(h('p.set-note.pt-muted', 'Ghost and minimap changes apply from the next run.'));
        return sections;
    }
    sections.push(h('section.set-section',
        h('h2.set-title', icon('eye', 20), 'Graphics'),
        segmented(app, 'Quality', [{ id: 'low', label: 'Low' }, { id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' }], () => s.quality, (v) => {
            s.quality = v;
            app.applyQuality();
        }),
        toggle(app, 'Reduced motion', () => s.reducedMotion, (v) => { s.reducedMotion = v; }, 'calmer cameras, no shake or flashes')));
    sections.push(h('section.set-section',
        h('h2.set-title', icon('gamepad', 20), 'Gamepad and touch'),
        slider(app, 'Stick steering sensitivity', () => s.padSensitivity, (v) => { s.padSensitivity = v; }, { min: 0.5, max: 2, step: 0.05, fmt: (v) => `${v.toFixed(2)}×` }),
        slider(app, 'Stick dead zone', () => s.padDeadzone, (v) => { s.padDeadzone = v; }, { min: 0, max: 0.4, step: 0.01 }),
        segmented(app, 'On-screen touch controls', [{ id: 'auto', label: 'Auto' }, { id: 'on', label: 'On' }, { id: 'off', label: 'Off' }], () => s.touchControls, (v) => { s.touchControls = v; })));
    sections.push(keySection(app));
    sections.push(h('section.set-section',
        h('h2.set-title', icon('retry', 20), 'Reset'),
        h('div.set-row', h('span.set-label', 'All settings back to their defaults', h('span.set-hint', 'records, replays and tracks are kept')),
            h('span.set-control', h('button.pt-btn.small.danger', {
                type: 'button',
                onclick: async () => {
                    if (!await app.confirm('Reset every setting, including key bindings?', { title: 'Reset settings', ok: 'Reset', danger: true })) return;
                    const fresh = defaultSettings();
                    for (const k of Object.keys(fresh)) app.settings[k] = fresh[k];
                    app.saveSettings();
                    app.applyQuality();
                    app.toast('Settings reset');
                    app.goto('settings');
                },
            }, 'Reset settings')))));
    return sections;
}

let stopActiveCapture = null;

function keySection(app) {
    const s = app.settings;
    const rows = h('div.set-keys');
    let capture = null;

    const stopCapture = () => {
        if (!capture) return;
        window.removeEventListener('keydown', capture.handler, true);
        capture.btn.classList.remove('capturing');
        capture = null;
        stopActiveCapture = null;
    };

    const render = () => {
        stopCapture();
        rows.replaceChildren(...ACTIONS.map((a) => {
            const keys = s.bindings[a.id] || [];
            const slot = (i) => {
                const code = keys[i];
                const btn = h('button.pt-btn.small.set-key', { type: 'button', 'aria-label': `${a.label}: ${code ? keyLabel(code) : 'unbound'}. Press to change.` },
                    code ? keyLabel(code) : '+');
                btn.addEventListener('click', () => startCapture(a.id, i, btn));
                return btn;
            };
            const clear = keys.length ? h('button.pt-btn.small.ghost.set-key-clear', {
                type: 'button', 'aria-label': `Clear ${a.label}`, title: 'Clear',
                onclick: () => {
                    s.bindings[a.id] = [];
                    app.saveSettings();
                    render();
                },
            }, icon('close', 14)) : null;
            return h('div.set-row.set-key-row', h('span.set-label', a.label), h('span.set-control', slot(0), slot(1), clear));
        }));
    };

    const startCapture = (action, index, btn) => {
        stopCapture();
        btn.classList.add('capturing');
        btn.textContent = 'Press a key…';
        const handler = (e) => {
            e.preventDefault();
            e.stopImmediatePropagation();
            if (e.code === 'Escape' && action !== 'pause') {
                render();
                return;
            }
            const code = e.code;
            if (!code) return;
            // A key does one thing: take it away from any other action first (Quick TAS
            // keys may share with the race actions they replace while Quick TAS runs).
            for (const other of ACTIONS) {
                if (!bindingsConflict(action, other.id)) continue;
                const list = s.bindings[other.id] || [];
                if (list.includes(code)) {
                    s.bindings[other.id] = list.filter((k) => k !== code);
                    app.toast(`${keyLabel(code)} moved from "${other.label}"`, { icon: 'keyboard' });
                }
            }
            const list = (s.bindings[action] || []).slice();
            const dup = list.indexOf(code);
            if (dup >= 0) list.splice(dup, 1);
            list[Math.min(index, list.length)] = code;
            s.bindings[action] = list.filter(Boolean).slice(0, 2);
            app.saveSettings();
            render();
            const again = rows.querySelectorAll('.set-key-row')[ACTIONS.findIndex((a) => a.id === action)];
            if (again) again.querySelector('.set-key').focus({ preventScroll: true });
        };
        capture = { handler, btn };
        stopActiveCapture = stopCapture;
        window.addEventListener('keydown', handler, true);
    };

    render();
    return h('section.set-section',
        h('h2.set-title', icon('keyboard', 20), 'Keys'),
        h('p.set-note.pt-muted', 'Click a key slot, then press the new key (Esc cancels). Each action can have two keys.'),
        rows,
        h('div.set-row', h('span.set-label'), h('span.set-control', h('button.pt-btn.small', {
            type: 'button',
            onclick: () => {
                s.bindings = cloneBindings(DEFAULT_BINDINGS);
                app.saveSettings();
                render();
                app.toast('Keys reset to the Trackmania defaults', { icon: 'keyboard' });
            },
        }, icon('retry', 16), 'Default keys'))));
}

/** Two balanced columns (sound, race, graphics | keys, gamepad, reset); they stack when narrow. */
function settingsColumns(sections) {
    const [sound, race, graphics, pad, keys, reset] = sections;
    return [h('div.set-col', sound, race, graphics), h('div.set-col', keys, pad, reset)];
}

/** The pause menu's settings: a modal with the race-relevant options. */
export function openQuickSettings(app) {
    return openModal((close) => h('div.pt-col.set-quick',
        h('div.pt-row', h('h2.pt-subtitle', 'Settings'), h('div.pt-spacer'),
            h('button.pt-btn.small', { type: 'button', 'data-autofocus': true, onclick: () => close(true) }, icon('check', 16), 'Done')),
        h('div.set-quick-body.pt-scroll', buildSettings(app, { compact: true }))), { label: 'Settings', className: 'set-modal' });
}

const settingsScreen = {
    id: 'settings',
    shell: true,

    enter(app) {
        this.app = app;
        app.backdrop.start();
        app.setMusic(true);
        this.el = h('div.pt-screen.settings-screen',
            h('header.list-head',
                h('button.pt-btn.small.ghost', { type: 'button', 'data-sound': 'back', onclick: () => this.back() }, icon('back', 18), 'Menu'),
                h('h1.pt-title', 'Settings'),
                h('div.pt-spacer'),
                h('span.pt-muted.set-saved', icon('check', 16), 'Saved automatically')),
            h('div.list-wrap.pt-panel', h('div.set-body.pt-scroll', settingsColumns(buildSettings(app)))));
        app.ui.appendChild(this.el);
        const first = this.el.querySelector('.set-body input, .set-body button');
        if (first) requestAnimationFrame(() => first.focus({ preventScroll: true }));
    },

    back() {
        this.app.goto('menu');
    },

    exit() {
        // A key capture still listening must not outlive the screen.
        if (stopActiveCapture) stopActiveCapture();
        this.el = null;
    },
};

export default settingsScreen;
