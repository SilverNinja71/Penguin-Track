// Small UI helpers shared by the multiplayer views: the stylesheet, track
// pickers (official campaign tracks and the player's own), saved preferences.
import { h, loadModuleCss } from '../game/dom.js';
import { iconSvg } from '../game/icons.js';

const PREFS_KEY = 'mp';

/** Adds css/mp.css once (the shared shell loader). */
export function ensureCss() {
    return loadModuleCss('mp');
}

export function loadPrefs(app) {
    const p = app.storage.get(PREFS_KEY, null);
    return p && typeof p === 'object' ? p : {};
}

export function savePrefs(app, patch) {
    const p = { ...loadPrefs(app), ...patch };
    app.storage.set(PREFS_KEY, p);
    return p;
}

export function ico(name, size = 20) {
    return h('span.pt-ico', { html: iconSvg(name, size) });
}

/** [{ label, items: [{ id, label, name, platform }] }]: campaign tiers, then the player's tracks. */
export function trackGroups(app) {
    const groups = [];
    for (const c of app.catalog.campaigns()) {
        for (const t of c.tiers) {
            groups.push({
                label: c.id === 'race' || t.name.includes(c.name) ? t.name : `${c.name} · ${t.name}`,
                items: t.tracks.map((x) => ({ id: x.id, name: x.name, label: `${x.id}  ${x.name}${x.mode === 'platform' ? ' (platform)' : ''}`, platform: x.mode === 'platform' })),
            });
        }
    }
    const mine = app.catalog.customTracks();
    if (mine.length) {
        groups.push({
            label: 'My tracks',
            items: mine.map((t) => ({ id: t.id, name: t.name || 'Untitled Track', label: t.name || 'Untitled Track', platform: t.mode === 'platform' })),
        });
    }
    return groups;
}

export function findTrackItem(app, id) {
    for (const g of trackGroups(app)) for (const it of g.items) if (it.id === id) return it;
    return null;
}

/** A <select> of every track; value = track id. */
export function trackSelect(app, { value = null, id = null, onchange = null } = {}) {
    const groups = trackGroups(app);
    const sel = h('select.pt-input.mp-track-select', { id, onchange: onchange ? () => onchange(sel.value) : null },
        groups.map((g) => h('optgroup', { label: g.label }, g.items.map((it) => h('option', { value: it.id }, it.label)))));
    const first = groups[0] && groups[0].items[0];
    sel.value = value && findTrackItem(app, value) ? value : first ? first.id : '';
    return sel;
}

export function field(label, control, hint = null) {
    return h('label.pt-field.mp-field', h('span', label), control, hint ? h('span.mp-hint', hint) : null);
}

export function swatch(color) {
    return h('span.mp-swatch', { style: { '--c': color }, 'aria-hidden': 'true' });
}

/** True for keys typed into a text field (the screen's own shortcuts stay off). */
export function typing(e) {
    const t = e.target;
    if (!t || !t.tagName) return false;
    if (t.isContentEditable || t.tagName === 'TEXTAREA') return true;
    if (t.tagName === 'SELECT') return e.key !== 'Escape';
    if (t.tagName !== 'INPUT') return false;
    return !['checkbox', 'radio', 'range', 'button', 'submit'].includes((t.type || 'text').toLowerCase());
}
