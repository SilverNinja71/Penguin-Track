// The track editor screen (Trackmania-style block editor). Builds tracks on the
// 48 x 32 x 48 grid with a live 3D preview, connector snapping, undo history,
// validation by driving (test drive or autopilot), save / load / share codes.
// docs/EDITOR.md describes the controls and the data it stores.
import { BLOCKS, SURFACES } from '../core/blocks.js';
import { buildWorld } from '../core/track.js';
import { encodeTrack, decodeTrack } from '../core/codec.js';
import { runAutopilot } from '../core/autopilot.js';
import { formatTime } from '../core/format.js';
import { CELL, LAYER, MAP_Y, MOODS, DIRS } from '../core/constants.js';
import { h, isTypingTarget, copyText, loadModuleCss } from '../game/dom.js';
import { iconSvg, MOOD_LABELS } from '../game/icons.js';
import { modalOpen } from '../game/ui.js';
import { medalTargets } from '../levels/medals.js';
import {
    EditorDoc, docFromStored, newTrack, newTrackId, CATEGORIES, blocksIn, placementAt, surfaceFor, DECOR_INFO,
} from './model.js';
import { blockThumb, decorThumb } from './thumbs.js';
import { EditorView } from './view3d.js';

const DRAFT_KEY = 'editor';
const BUILD_EVERY_MS = 140;
const ROAD_SURFACES = ['snow', 'powder', 'ice'];
const DECOR_KINDS = ['Pine', 'PineCluster', 'Igloo', 'Snowman', 'PenguinCrowd', 'Penguin', 'IceCrystal', 'Rock', 'Banner', 'Lamp'];
const REASONS = { outside: 'Outside the map', overlap: 'Overlaps another block', taken: 'Decor already there', unknown: 'Unknown block' };

const SHORTCUTS = [
    ['Place', 'Left click', 'Space / Enter'],
    ['Delete', 'Right click', 'Delete / X'],
    ['Pick block (eyedropper)', 'Middle click / Alt+click', 'C'],
    ['Rotate (flip when snapped)', 'Shift+wheel', 'R / Shift+R'],
    ['Layer up / down', '', 'E / Q, PageUp / PageDown'],
    ['Move cursor / pan', 'Middle-drag pans', 'WASD / arrows'],
    ['Orbit / zoom', 'Drag, right-drag / wheel', ''],
    ['Top view / frame track', '', 'V / F'],
    ['Surface Packed Snow / Powder / Ice', '', '1 / 2 / 3'],
    ['Previous / next block', '', '[ / ]'],
    ['Blocks / decor', '', 'B'],
    ['Snap to open road ends', '', 'G'],
    ['Undo / redo', '', 'Ctrl+Z / Ctrl+Y'],
    ['Save', '', 'Ctrl+S'],
    ['Test drive', '', 'T'],
    ['This guide', '', 'H / ?'],
];

// Survives test drives: the play screen hands control back with { resume: true }.
let parked = null;

const ico = (name, size = 18) => h('span.pt-ico', { html: iconSvg(name, size) });

class EditorSession {
    constructor(app, params) {
        this.app = app;
        this.params = params;
        this.state = {
            mode: 'block', cat: 'road', blockId: 'Straight', decorId: 'Pine', r: 0, surface: 'snow',
            layer: 0, snap: true, variant: 0, cursor: null, cursorSrc: 'mouse', guide: false,
        };
        this.world = null;
        this.worldVersion = -1;
        this.needsBuild = true;
        this.lastBuild = 0;
        this.pointer = null;
        this.mouse = null;
        this.pending = null;
        this.disposed = false;
        this._draftTimer = 0;
        this._listeners = [];
    }

    // ------------------------------------------------------------------ setup

    start() {
        const { app, params } = this;
        loadModuleCss('editor');
        let resumed = false;
        let note = null;
        if (params.resume && parked) {
            this._restoreParked(parked);
            note = parked.note;
            resumed = true;
        } else if (params.track) {
            const ref = typeof params.track === 'string' ? app.catalog.getTrack(params.track) : params.track;
            if (parked && ref && parked.doc.track.id === ref.id) {
                this._restoreParked(parked);
                resumed = true;
            } else {
                this.doc = this._docFromRef(ref);
                this._offerDraft(ref);
            }
        } else {
            const draft = app.storage.get(DRAFT_KEY, null);
            if (draft && draft.doc && draft.doc.track) {
                try {
                    this.doc = EditorDoc.fromJSON(draft.doc);
                    if (this.doc.dirty) note = 'Picked up your draft where you left it';
                } catch (e) {
                    this.doc = null;
                }
            }
            if (!this.doc) this.doc = new EditorDoc(newTrack({ author: this.defaultAuthor() }), { pristine: true });
        }
        parked = null;
        this.buildDom();
        this.view = new EditorView(app.renderer);
        this.view.setLayer(this.state.layer);
        if (resumed && this._camGoal) {
            Object.assign(this.view.goal, this._camGoal, { target: this.view.goal.target.fromArray(this._camGoal.target) });
            this.view.cam.top = !!this._camGoal.top;
        } else {
            this.frameTrack(true);
        }
        this.view.snap();
        this.attachInput();
        this.selectBlock(this.state.blockId, false);
        this.view.setConnectors(this.doc.openConnectors());
        this.updateGhost();
        this.build();
        app.loop.start(null, (alpha, dt) => this.frame(dt));
        app.setMusic(false);
        if (note) app.toast(note, { icon: 'edit', kind: note.startsWith('Validated') ? 'good' : undefined, ms: 3200 });
    }

    defaultAuthor() {
        const acc = this.app.account && this.app.account();
        return (acc && acc.username) || 'Penguin';
    }

    _docFromRef(ref) {
        if (!ref) return new EditorDoc(newTrack({ author: this.defaultAuthor() }), { pristine: true });
        const all = this.app.storage.get('tracks', {}) || {};
        const stored = all[ref.id];
        if (stored && typeof stored === 'object') {
            const doc = docFromStored({ ...stored, id: ref.id });
            doc.markSaved(ref.id);
            return doc;
        }
        // Not one of ours (an official id, say): edit a copy so nothing official is overwritten.
        const official = this.app.catalog.isReserved(ref.id);
        const doc = new EditorDoc({ ...ref, id: official ? newTrackId() : ref.id, medals: null });
        return doc;
    }

    /** A dirty draft of another track would be lost: offer to go back to it. */
    _offerDraft(ref) {
        const draft = this.app.storage.get(DRAFT_KEY, null);
        if (!draft || !draft.doc || !draft.doc.track || !ref) return;
        let d;
        try {
            d = EditorDoc.fromJSON(draft.doc);
        } catch (e) {
            return;
        }
        if (!d.dirty || d.track.id === ref.id) return;
        setTimeout(async () => {
            if (this.disposed) return;
            const back = await this.app.confirm(`You have unsaved changes to "${d.track.name}". Open "${this.doc.track.name}" anyway? The other draft will be dropped.`,
                { title: 'Unsaved draft', ok: `Open ${this.doc.track.name}`, cancel: `Back to ${d.track.name}` });
            if (!back && !this.disposed) this.setDoc(d, true);
        }, 60);
    }

    _restoreParked(p) {
        this.doc = p.doc;
        Object.assign(this.state, p.state, { cursor: null, guide: false });
        this._camGoal = p.cam;
    }

    park(note = null) {
        const g = this.view.goal;
        parked = {
            doc: this.doc,
            state: { ...this.state },
            cam: { target: g.target.toArray(), yaw: g.yaw, pitch: g.pitch, dist: g.dist, top: this.view.cam.top },
            note,
        };
    }

    // ------------------------------------------------------------------ DOM

    buildDom() {
        const app = this.app;
        const B = (label, iconName, onclick, opts = {}) => h('button.pt-btn.small', {
            type: 'button', class: opts.cls || '', onclick, title: opts.title || label, 'aria-label': opts.aria || label,
            'data-sound': opts.sound || null,
        }, ico(iconName), h('span.ed-lbl', label), opts.kbd ? h('span.pt-kbd.ed-kbd', opts.kbd) : null);

        this.undoBtn = B('Undo', 'back', () => this.undo(), { title: 'Undo (Ctrl+Z)' });
        this.redoBtn = B('Redo', 'next', () => this.redo(), { title: 'Redo (Ctrl+Y)' });
        this.saveBtn = B('Save', 'save', () => this.save(), { title: 'Save to My Tracks (Ctrl+S)' });
        this.nameBtn = h('button.ed-name', { type: 'button', title: 'Track properties', onclick: () => this.editProps() });
        this.top = h('header.ed-top.pt-panel',
            B('Menu', 'home', () => this.leave(), { sound: 'back', title: 'Back to the menu (your draft is kept)' }),
            this.nameBtn,
            h('div.ed-sep'),
            B('New', 'plus', () => this.newTrack(), { title: 'New track' }),
            B('Open', 'map', () => this.openDialog(), { title: 'Open a saved track, copy an official one, or paste a code' }),
            this.saveBtn,
            B('Share', 'export', () => this.share(), { title: 'Share code' }),
            h('div.ed-sep'),
            this.undoBtn, this.redoBtn,
            h('div.pt-spacer'),
            B('Guide', 'help', () => this.toggleGuide(), { title: 'Shortcuts (H)' }),
            B('Autopilot', 'brain', () => this.autoValidate(), { title: 'Auto-validate with the autopilot' }),
            B('Test drive', 'play', () => this.testDrive(), { cls: 'primary', title: 'Test drive and validate (T)', kbd: 'T' }));

        // Palette
        this.modeBtns = {
            block: h('button.ed-tab', { type: 'button', onclick: () => this.setMode('block') }, 'Blocks'),
            decor: h('button.ed-tab', { type: 'button', onclick: () => this.setMode('decor') }, 'Decor'),
        };
        this.catRow = h('div.ed-cats', { role: 'tablist', 'aria-label': 'Block categories' },
            CATEGORIES.map((c) => h('button.ed-chip', { type: 'button', dataset: { cat: c.id }, onclick: () => this.setCategory(c.id) }, c.name)));
        this.items = h('div.ed-items.pt-scroll', { role: 'listbox', 'aria-label': 'Blocks' });
        this.info = h('div.ed-info');
        this.surfaceRow = h('div.ed-surfaces', { role: 'radiogroup', 'aria-label': 'Surface' },
            ROAD_SURFACES.map((s, i) => h('button.ed-surf', { type: 'button', dataset: { s }, onclick: () => this.setSurface(s), title: `${SURFACES[s].name} (${i + 1})` },
                h('span.ed-swatch', { class: s }), SURFACES[s].name)));
        this.rotOut = h('span.pt-mono');
        this.layerOut = h('span.pt-mono');
        this.snapBtn = h('button.pt-btn.small.ed-toggle', { type: 'button', onclick: () => this.toggleSnap(), title: 'Snap onto open road ends (G)' }, ico('link', 16), 'Snap');
        this.topBtn = h('button.pt-btn.small.ed-toggle', { type: 'button', onclick: () => this.toggleTop(), title: 'Top view (V)' }, ico('eye', 16), 'Top view');
        this.palette = h('aside.ed-palette.pt-panel',
            h('div.ed-tabs', { role: 'tablist' }, this.modeBtns.block, this.modeBtns.decor),
            this.catRow,
            this.items,
            this.info,
            this.surfaceRow,
            h('div.ed-ctl',
                h('div.ed-ctl-row',
                    h('span.ed-ctl-label', 'Rotate'),
                    h('button.pt-btn.small', { type: 'button', onclick: () => this.rotate(-1), title: 'Rotate left (Shift+R)', 'aria-label': 'Rotate left' }, '↺'),
                    this.rotOut,
                    h('button.pt-btn.small', { type: 'button', onclick: () => this.rotate(1), title: 'Rotate right (R)', 'aria-label': 'Rotate right' }, '↻')),
                h('div.ed-ctl-row',
                    h('span.ed-ctl-label', 'Layer'),
                    h('button.pt-btn.small', { type: 'button', onclick: () => this.setLayer(this.state.layer - 1), title: 'Layer down (Q)', 'aria-label': 'Layer down' }, '▼'),
                    this.layerOut,
                    h('button.pt-btn.small', { type: 'button', onclick: () => this.setLayer(this.state.layer + 1), title: 'Layer up (E)', 'aria-label': 'Layer up' }, '▲')),
                h('div.ed-ctl-row', this.snapBtn, this.topBtn)));

        // Status
        this.valBox = h('div.ed-val');
        this.statsBox = h('div.ed-stats');
        this.issuesBox = h('div.ed-issues.pt-scroll');
        this.status = h('aside.ed-status.pt-panel', { 'aria-label': 'Track status' }, this.valBox, this.statsBox, this.issuesBox);

        this.hint = h('div.ed-hint', { role: 'status', 'aria-live': 'polite' });
        this.guide = this.buildGuide();
        this.el = h('div.pt-screen.passthrough.ed-screen', this.top, this.palette, this.status, this.hint, this.guide);
        app.ui.appendChild(this.el);
    }

    buildGuide() {
        const rows = SHORTCUTS.map(([what, mouse, keys]) => h('tr',
            h('td', what),
            h('td.pt-muted', mouse || ''),
            h('td', keys ? keys.split(', ').map((k, i) => [i ? ' ' : null, h('span.pt-kbd', k)]) : '')));
        return h('div.ed-guide.pt-panel.pt-hidden', { role: 'dialog', 'aria-label': 'Editor guide' },
            h('div.ed-guide-head', h('h2.pt-subtitle', 'Editor guide'), h('div.pt-spacer'),
                h('button.pt-btn.small.ghost', { type: 'button', onclick: () => this.toggleGuide(false), 'aria-label': 'Close guide' }, ico('close', 16))),
            h('p.pt-muted.ed-guide-tip', 'Ghost blocks show green where they fit and red where they would overlap. Blue arrows mark open road ends: put the cursor in front of one and the block snaps on, facing the right way (R flips turns and slopes). A track needs a Start igloo, a Finish arch and a road between them. Drive it to the finish to validate it: your best run becomes the Emperor time.'),
            h('table.ed-guide-table', h('thead', h('tr', h('th', 'Action'), h('th', 'Mouse'), h('th', 'Keys'))), h('tbody', rows)));
    }

    // ------------------------------------------------------------------ palette and UI state

    setMode(mode) {
        this.state.mode = mode;
        this.renderPalette();
        this.updateGhost();
    }

    setCategory(cat) {
        this.state.cat = cat;
        this.state.mode = 'block';
        const list = blocksIn(cat);
        if (!list.some((d) => d.id === this.state.blockId) && list.length) this.state.blockId = list[0].id;
        this.renderPalette();
        this.updateGhost();
    }

    selectBlock(id, focus = true) {
        if (!BLOCKS[id]) return;
        this.state.mode = 'block';
        this.state.blockId = id;
        this.state.cat = BLOCKS[id].category;
        this.state.variant = 0;
        this.renderPalette(focus);
        this.updateGhost();
    }

    selectDecor(id) {
        this.state.mode = 'decor';
        this.state.decorId = id;
        this.renderPalette();
        this.updateGhost();
    }

    renderPalette(focusSelected = false) {
        const s = this.state;
        const decor = s.mode === 'decor';
        for (const [m, b] of Object.entries(this.modeBtns)) {
            b.classList.toggle('active', m === s.mode);
            b.setAttribute('aria-selected', String(m === s.mode));
        }
        this.catRow.classList.toggle('pt-hidden', decor);
        this.surfaceRow.classList.toggle('pt-hidden', decor);
        for (const c of this.catRow.children) c.classList.toggle('active', c.dataset.cat === s.cat);
        this.items.replaceChildren();
        let sel = null;
        if (decor) {
            for (const k of DECOR_KINDS) {
                const on = k === s.decorId;
                const b = h('button.ed-item', { type: 'button', role: 'option', 'aria-selected': String(on), class: on ? 'active' : '', title: DECOR_INFO[k] || k, onclick: () => this.selectDecor(k) },
                    h('span.ed-thumb', { html: decorThumb(k, 46) }), h('span.ed-item-name', k.replace(/([a-z])([A-Z])/g, '$1 $2')));
                if (on) sel = b;
                this.items.appendChild(b);
            }
            this.info.replaceChildren(h('b', s.decorId.replace(/([a-z])([A-Z])/g, '$1 $2')), h('span.pt-muted', DECOR_INFO[s.decorId] || 'Scenery.'));
        } else {
            for (const d of blocksIn(s.cat)) {
                const on = d.id === s.blockId;
                const b = h('button.ed-item', { type: 'button', role: 'option', 'aria-selected': String(on), class: on ? 'active' : '', title: `${d.name}: ${d.description}`, onclick: () => this.selectBlock(d.id, false) },
                    h('span.ed-thumb', { html: blockThumb(d.id, 46) }), h('span.ed-item-name', d.name));
                if (on) sel = b;
                this.items.appendChild(b);
            }
            const def = BLOCKS[s.blockId];
            this.info.replaceChildren(h('b', def.name), h('span.pt-muted', def.description));
            const allowed = def.surfaces;
            for (const btn of this.surfaceRow.children) {
                btn.disabled = !allowed.includes(btn.dataset.s);
                btn.classList.toggle('active', surfaceFor(def.id, s.surface) === btn.dataset.s);
                btn.setAttribute('aria-checked', String(surfaceFor(def.id, s.surface) === btn.dataset.s));
            }
        }
        if (sel) {
            sel.scrollIntoView({ block: 'nearest' });
            if (focusSelected) sel.focus({ preventScroll: true });
        }
        this.updateControls();
    }

    cycleItem(step) {
        const s = this.state;
        if (s.mode === 'decor') {
            const i = DECOR_KINDS.indexOf(s.decorId);
            this.selectDecor(DECOR_KINDS[(i + step + DECOR_KINDS.length) % DECOR_KINDS.length]);
            return;
        }
        // Walk the whole catalog in palette order, crossing categories.
        const all = CATEGORIES.flatMap((c) => blocksIn(c.id).map((d) => d.id));
        const i = all.indexOf(s.blockId);
        this.selectBlock(all[(i + step + all.length) % all.length], false);
    }

    setSurface(s) {
        this.state.surface = s;
        this.renderPalette();
        this.updateGhost();
    }

    rotate(step) {
        const s = this.state;
        if (this.pending && this.pending.snapped && this.pending.variants > 1) {
            s.variant = (s.variant + (step > 0 ? 1 : this.pending.variants - 1)) % this.pending.variants;
        } else {
            s.r = (s.r + step + 4) & 3;
        }
        this.updateGhost();
        this.updateControls();
    }

    setLayer(layer) {
        const s = this.state;
        s.layer = Math.max(0, Math.min(MAP_Y - 1, layer));
        this.view.setLayer(s.layer);
        if (s.cursor) {
            if (s.cursorSrc === 'mouse' && this.mouse) s.cursor = this.view.cellAt(this.mouse.x, this.mouse.y, s.layer);
            else s.cursor = [s.cursor[0], s.layer, s.cursor[2]];
        }
        if (s.cursorSrc === 'keys' && s.cursor) this.view.goal.target.y = s.layer * LAYER;
        this.updateGhost();
        this.updateControls();
    }

    toggleSnap() {
        this.state.snap = !this.state.snap;
        this.app.toast(this.state.snap ? 'Snapping on: blocks join open road ends' : 'Snapping off: free rotation', { icon: 'link', ms: 1800 });
        this.updateGhost();
        this.updateControls();
    }

    toggleTop() {
        this.view.setTop(!this.view.cam.top);
        this.updateControls();
    }

    toggleGuide(on = !this.state.guide) {
        this.state.guide = on;
        this.guide.classList.toggle('pt-hidden', !on);
        if (on) this.guide.querySelector('button')?.focus({ preventScroll: true });
    }

    updateControls() {
        const s = this.state;
        if (!this.rotOut) return;
        const r = this.pending && this.pending.block ? this.pending.block.r : s.r;
        this.rotOut.textContent = `${r * 90}°`;
        this.layerOut.textContent = String(s.layer);
        this.snapBtn.classList.toggle('active', s.snap);
        this.snapBtn.setAttribute('aria-pressed', String(s.snap));
        this.topBtn.classList.toggle('active', !!this.view?.cam.top);
        this.topBtn.setAttribute('aria-pressed', String(!!this.view?.cam.top));
        this.undoBtn.disabled = !this.doc.canUndo;
        this.redoBtn.disabled = !this.doc.canRedo;
        this.undoBtn.title = this.doc.canUndo ? `Undo ${this.doc.undoStack[this.doc.undoStack.length - 1].label} (Ctrl+Z)` : 'Nothing to undo';
        this.redoBtn.title = this.doc.canRedo ? `Redo ${this.doc.redoStack[this.doc.redoStack.length - 1].label} (Ctrl+Y)` : 'Nothing to redo';
        this.saveBtn.classList.toggle('ed-dirty', this.doc.dirty);
        const t = this.doc.track;
        this.nameBtn.replaceChildren(
            h('span.ed-name-main', t.name, this.doc.dirty ? h('span.ed-dot', { title: 'Unsaved changes' }, '•') : null),
            h('span.ed-name-sub.pt-muted', `by ${t.author} · ${MOOD_LABELS[t.mood] || t.mood}${t.mode === 'platform' ? ' · platform' : ''}${t.laps > 1 ? ` · ${t.laps} laps` : ''}`));
    }

    // ------------------------------------------------------------------ ghost / cursor

    /** Recomputes what a click would place at the cursor. */
    updateGhost() {
        const s = this.state;
        const doc = this.doc;
        const c = s.cursor;
        this.pending = null;
        if (!this.view) return;
        this.view.setCursor(c);
        if (!c) {
            this.view.setGhost(null);
            this.view.setHover(null);
            this.setHint();
            return;
        }
        if (s.mode === 'decor') {
            const d = { d: s.decorId, x: c[0], y: s.layer, z: c[2], r: s.r };
            const fit = doc.fitsDecor(d);
            this.pending = { decor: d, ok: fit.ok, reason: fit.reason };
            this.view.setGhost({ decor: d, ok: fit.ok });
            const di = doc.decorAt(c[0], s.layer, c[2]);
            this.view.setHover(null);
            this.pending.targetDecor = di;
        } else {
            let block = null, snapped = false, next = null, variants = 0;
            if (s.snap) {
                const vs = doc.snapVariants(s.blockId, c, s.surface);
                if (vs.length) {
                    const v = vs[s.variant % vs.length];
                    block = v.block;
                    next = v.next;
                    snapped = true;
                    variants = vs.length;
                }
            }
            if (!block) block = placementAt(s.blockId, c, s.r, s.surface);
            const fit = doc.fits(block);
            this.pending = { block, ok: fit.ok, reason: fit.reason, overlaps: fit.overlaps, snapped, next, variants };
            this.view.setGhost({ block, ok: fit.ok });
            const target = this.targetBlock();
            this.view.setHover(target >= 0 ? doc.blocks[target] : null, fit.ok ? 0xffffff : 0xff6b81);
        }
        this.setHint();
        this.updateControls();
    }

    /** Block a delete / eyedropper would act on: under the mouse, else on the cursor cell. */
    targetBlock() {
        const s = this.state, doc = this.doc;
        if (s.cursorSrc === 'mouse' && this.mouse && this.worldVersion === doc.version) {
            const hit = this.app.renderer.pick(this.mouse.x, this.mouse.y);
            if (hit && hit.blockIndex >= 0 && hit.blockIndex < doc.blocks.length) return hit.blockIndex;
        }
        if (!s.cursor) return -1;
        return doc.blockAt(s.cursor[0], s.layer, s.cursor[2]);
    }

    setHint() {
        const s = this.state, p = this.pending;
        let text;
        if (!s.cursor) {
            text = 'Point at the grid to place blocks. Drag to orbit, wheel to zoom, H for the guide.';
        } else if (s.mode === 'decor') {
            text = `${s.decorId} · cell ${s.cursor[0]}, ${s.cursor[2]} · layer ${s.layer}`;
            if (p && !p.ok) text += ` · ${REASONS[p.reason] || ''}`;
            if (p && p.targetDecor >= 0) text += ' · right click removes the decor here';
        } else {
            const def = BLOCKS[s.blockId];
            const b = p && p.block;
            text = `${def.name} · ${SURFACES[surfaceFor(def.id, s.surface)].name} · ${b ? b.r * 90 : 0}° · layer ${s.layer}`;
            if (p && p.snapped) text += p.variants > 1 ? ' · snapped to an open road end (R flips)' : ' · snapped to an open road end';
            if (p && !p.ok) {
                const o = p.overlaps && p.overlaps.length ? this.doc.blocks[p.overlaps[0]] : null;
                text += ` · ${p.reason === 'overlap' && o ? `Overlaps ${BLOCKS[o.b].name}` : REASONS[p.reason] || ''}`;
            }
        }
        this.hint.textContent = text;
        this.hint.classList.toggle('bad', !!(p && !p.ok));
    }

    moveCursorKeys(dir) {
        const s = this.state;
        let c = s.cursor;
        if (!c) {
            const t = this.view.goal.target;
            c = [Math.floor(t.x / CELL), s.layer, Math.floor(t.z / CELL)];
        }
        const [dx, dz] = this.view.gridStep(dir);
        c = [Math.max(0, Math.min(47, c[0] + dx)), s.layer, Math.max(0, Math.min(47, c[2] + dz))];
        this.setKeyCursor(c);
    }

    setKeyCursor(c) {
        const s = this.state;
        if (!s.cursor || s.cursor[0] !== c[0] || s.cursor[2] !== c[2]) s.variant = 0;
        s.cursor = c;
        s.cursorSrc = 'keys';
        this.view.focusOn((c[0] + 0.5) * CELL, c[1] * LAYER, (c[2] + 0.5) * CELL);
        this.updateGhost();
    }

    // ------------------------------------------------------------------ edits

    placeAtCursor() {
        const p = this.pending, s = this.state;
        if (!p) return;
        if (!p.ok) {
            this.app.audio.ui('error');
            return;
        }
        if (p.decor) {
            if (this.doc.placeDecor(p.decor)) this.afterChange();
            return;
        }
        const replacedSpawn = BLOCKS[p.block.b].spawn && this.doc.blocks.some((b) => BLOCKS[b.b] && BLOCKS[b.b].spawn);
        if (!this.doc.place(p.block)) return;
        this.app.audio.ui('click');
        if (replacedSpawn) this.app.toast('Moved the start: a track has one Start igloo', { icon: 'flag', ms: 2200 });
        // Chain building: the next piece goes where this one ends.
        let next = p.next ? [p.next[0], p.next[1], p.next[2]] : null;
        if (!next) {
            const idx = this.doc.blocks.length - 1;   // place() appends
            const open = this.doc.openConnectors().road.filter((c) => c.block === idx);
            const o = open.find((c) => c.local !== 0) || open[0];
            if (o) next = [o.cell[0] + DIRS[o.dir][0], o.cell[1], o.cell[2] + DIRS[o.dir][2]];
        }
        if (next && next[1] !== s.layer) {
            s.layer = Math.max(0, Math.min(MAP_Y - 1, next[1]));
            this.view.setLayer(s.layer);
        }
        if (s.cursorSrc === 'keys' && next) {
            this.setKeyCursor([Math.max(0, Math.min(47, next[0])), s.layer, Math.max(0, Math.min(47, next[2]))]);
        } else if (s.cursorSrc === 'mouse' && this.mouse) {
            s.cursor = this.view.cellAt(this.mouse.x, this.mouse.y, s.layer);
        }
        this.afterChange();
    }

    deleteAtCursor() {
        const s = this.state, doc = this.doc;
        if (s.mode === 'decor' || this.targetBlock() < 0) {
            const c = s.cursor;
            const di = c ? doc.decorAt(c[0], s.layer, c[2]) : -1;
            if (di >= 0) {
                doc.removeDecor(di);
                this.afterChange();
                return;
            }
            if (s.mode === 'decor') return;
        }
        const i = this.targetBlock();
        if (i < 0) return;
        if (doc.remove(i)) {
            this.app.audio.ui('back');
            this.afterChange();
        }
    }

    eyedrop() {
        const s = this.state, doc = this.doc;
        const i = this.targetBlock();
        if (i >= 0) {
            const b = doc.blocks[i];
            s.r = b.r;
            s.surface = b.s;
            s.layer = b.y;
            this.view.setLayer(s.layer);
            this.selectBlock(b.b, false);
            this.app.toast(`Picked ${BLOCKS[b.b].name}`, { icon: 'edit', ms: 1400 });
            return;
        }
        const c = s.cursor;
        const di = c ? doc.decorAt(c[0], s.layer, c[2]) : -1;
        if (di >= 0) {
            s.r = doc.decor[di].r;
            this.selectDecor(doc.decor[di].d);
        }
    }

    undo() {
        const label = this.doc.undo();
        if (label == null) return;
        this.app.toast(`Undid: ${label}`, { icon: 'back', ms: 1200 });
        this.afterChange();
    }

    redo() {
        const label = this.doc.redo();
        if (label == null) return;
        this.app.toast(`Redid: ${label}`, { icon: 'next', ms: 1200 });
        this.afterChange();
    }

    afterChange() {
        this.needsBuild = true;
        this.view.setConnectors(this.doc.openConnectors());
        this.updateGhost();
        this.updateControls();
        this.scheduleDraft();
    }

    scheduleDraft() {
        clearTimeout(this._draftTimer);
        this._draftTimer = setTimeout(() => this.saveDraft(), 700);
    }

    saveDraft() {
        clearTimeout(this._draftTimer);
        const j = this.doc.toJSON();
        // Keep the draft small: only the current layout's validation keeps its replay.
        const cur = this.doc.hash();
        const validations = {};
        for (const [k, v] of Object.entries(j.validations)) validations[k] = k === cur ? v : { ...v, replay: null };
        this.app.storage.set(DRAFT_KEY, { doc: { ...j, validations }, date: Date.now() });
    }

    setDoc(doc, frame = true) {
        this.doc = doc;
        this.state.variant = 0;
        this.needsBuild = true;
        if (frame) this.frameTrack();
        this.afterChange();
        this.saveDraft();
    }

    // ------------------------------------------------------------------ world

    build() {
        const doc = this.doc;
        const track = doc.toTrack();
        let world = null;
        try {
            world = buildWorld(track);
        } catch (e) {
            this.world = null;
            this.buildError = e.message;
            this.worldVersion = doc.version;
            this.needsBuild = false;
            this.renderStatus();
            return;
        }
        this.buildError = null;
        this.world = world;
        this.worldVersion = doc.version;
        this.needsBuild = false;
        this.lastBuild = performance.now();
        this.app.renderer.loadWorld(world, track, { scenery: false });
        const bad = new Set();
        for (const is of world.issues || []) if (is.level === 'error' && is.blocks) for (const i of is.blocks) bad.add(i);
        this.app.renderer.setTrackHighlight(bad.size ? [...bad] : null, 0xff3355);
        this.view.setConnectors(doc.openConnectors());
        this.renderStatus();
    }

    frame(dt) {
        if (this.disposed) return;
        if (this.needsBuild && performance.now() - this.lastBuild > BUILD_EVERY_MS) this.build();
        this.view.update(dt);
        this.app.renderer.render(dt);
    }

    frameTrack(instant = false) {
        const blocks = this.doc.blocks;
        if (!blocks.length) {
            this.view.focusOn(24 * CELL, 0, 24 * CELL, 700);
            return;
        }
        let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity, y0 = Infinity;
        for (const b of blocks) {
            x0 = Math.min(x0, b.x); z0 = Math.min(z0, b.z); y0 = Math.min(y0, b.y);
            x1 = Math.max(x1, b.x + 1); z1 = Math.max(z1, b.z + 1);
        }
        const ext = Math.max(x1 - x0, z1 - z0) * CELL;
        this.view.focusOn((x0 + x1) / 2 * CELL, y0 * LAYER, (z0 + z1) / 2 * CELL, Math.max(180, ext * 1.15 + 80));
        if (instant) this.view.snap();
    }

    focusIssue(is) {
        const doc = this.doc;
        let cell = is.cell || null;
        if (!cell && is.blocks && is.blocks.length) {
            const b = doc.blocks[is.blocks[0]];
            if (b) cell = [b.x, b.y, b.z];
        }
        if (!cell) return;
        this.state.layer = Math.max(0, Math.min(MAP_Y - 1, cell[1]));
        this.view.setLayer(this.state.layer);
        this.setKeyCursor([Math.max(0, Math.min(47, cell[0])), this.state.layer, Math.max(0, Math.min(47, cell[2]))]);
        this.view.goal.dist = Math.min(this.view.goal.dist, 260);
    }

    renderStatus() {
        const doc = this.doc, w = this.world;
        const track = doc.toTrack();
        const v = doc.validation();
        const raceable = !!(w && w.spawn && w.route);
        const box = [];
        if (v) {
            const targets = medalTargets(track);
            box.push(h('div.ed-val-head.good', ico('check', 18), 'Validated',
                h('span.pt-muted.ed-val-by', v.by === 'autopilot' ? ' by the autopilot' : ' by driving')),
            h('div.ed-medals', targets.map((t) => h('div.ed-medal', h('span.pt-medal', { class: t.medal }), h('span', t.label), h('span.pt-mono', t.text)))));
        } else if (raceable) {
            box.push(h('div.ed-val-head.warn', ico('flag', 18), 'Not validated'),
                h('p.pt-muted.ed-val-msg', 'Drive it to the finish (Test drive) to validate. Your best run sets the Emperor time and the medals.'));
        } else {
            box.push(h('div.ed-val-head.bad', ico('close', 18), 'Not raceable yet'),
                h('p.pt-muted.ed-val-msg', this.buildError || (w && !w.spawn ? 'Place a Start igloo.' : (w && w.routeError) || 'Connect the Start to a Finish.')));
        }
        this.valBox.replaceChildren(...box);

        const cps = w ? w.checkpointCount : 0;
        const stat = (label, value, cls = '') => h('div.ed-stat', h('span.pt-muted', label), h('b', { class: cls }, value));
        this.statsBox.replaceChildren(
            stat('Blocks', String(doc.blocks.length)),
            stat('Decor', String(doc.decor.length)),
            stat('Checkpoints', String(cps)),
            stat('Route', w && w.route ? `${Math.round(w.route.length)} m` : 'none', w && w.route ? 'good' : 'bad'));

        const issues = ((w ? w.issues : []) || []).slice();
        // buildWorld leaves open road ends to validateTrack; list them like it does without a second route search.
        if (!issues.some((i) => i.code === 'openEnd')) {
            for (const c of doc.openConnectors().road) issues.push({ level: 'warning', code: 'openEnd', blocks: [c.block], cell: c.cell, dir: c.dir, connector: c.local });
        }
        const errors = issues.filter((i) => i.level === 'error');
        const warns = issues.filter((i) => i.level !== 'error');
        const list = [...errors, ...warns];
        const rows = list.slice(0, 12).map((is) => {
            const clickable = !!(is.cell || (is.blocks && is.blocks.length));
            return h('button.ed-issue', { type: 'button', class: is.level === 'error' ? 'error' : 'warning', disabled: !clickable, title: clickable ? 'Show me' : '', onclick: () => this.focusIssue(is) },
                h('span.ed-issue-dot'), h('span', friendlyIssue(is, doc)));
        });
        if (list.length > 12) rows.push(h('div.pt-muted.ed-more', `+${list.length - 12} more`));
        this.issuesBox.replaceChildren(
            h('div.ed-issues-head', `${errors.length} error${errors.length === 1 ? '' : 's'} · ${warns.length} warning${warns.length === 1 ? '' : 's'}`),
            ...(rows.length ? rows : [h('div.pt-muted.ed-more', 'All clear. Snowy roads ahead.')]));
        this.updateControls();
    }

    // ------------------------------------------------------------------ input

    on(target, type, fn, opts) {
        target.addEventListener(type, fn, opts);
        this._listeners.push(() => target.removeEventListener(type, fn, opts));
    }

    attachInput() {
        const canvas = this.app.canvas || this.app.renderer.canvas;
        this.canvas = canvas;
        this.on(canvas, 'pointerdown', (e) => this.onPointerDown(e));
        // Mouse clicks on panel buttons drop focus, so Space / Enter place blocks
        // instead of pressing the last clicked button again (keyboard clicks keep it).
        this.on(this.el, 'click', (e) => {
            if (e.detail > 0 && e.target.closest && e.target.closest('.ed-palette, .ed-top') && document.activeElement && document.activeElement.blur) document.activeElement.blur();
        });
        this.on(window, 'pointermove', (e) => this.onPointerMove(e));
        this.on(window, 'pointerup', (e) => this.onPointerUp(e));
        this.on(canvas, 'pointerleave', () => {
            if (this.pointer) return;
            this.mouse = null;
            if (this.state.cursorSrc === 'mouse') {
                this.state.cursor = null;
                this.updateGhost();
            }
        });
        this.on(canvas, 'wheel', (e) => this.onWheel(e), { passive: false });
        this.on(canvas, 'contextmenu', (e) => e.preventDefault());
        this.on(canvas, 'auxclick', (e) => e.preventDefault());
        this.on(window, 'keydown', (e) => this.onKeyDown(e));
    }

    onPointerDown(e) {
        if (e.target !== this.canvas) return;
        // A focused palette button would otherwise eat the next Space / Enter.
        if (document.activeElement && document.activeElement !== document.body && this.el.contains(document.activeElement)) document.activeElement.blur();
        this.pointer = { x: e.clientX, y: e.clientY, button: e.button, moved: false, alt: e.altKey, id: e.pointerId };
        if (e.button === 1) e.preventDefault();
        try {
            this.canvas.setPointerCapture(e.pointerId);
        } catch (err) { /* synthetic events have no capture */ }
    }

    onPointerMove(e) {
        const p = this.pointer;
        if (p) {
            const dx = e.clientX - p.x, dy = e.clientY - p.y;
            if (!p.moved && dx * dx + dy * dy > 25) p.moved = true;
            if (p.moved) {
                if (p.button === 1) {
                    const k = this.view.cam.dist * 0.0018;
                    this.view.panBy(-dx * k, dy * k);
                } else {
                    this.view.orbitBy(-dx * 0.006, dy * 0.005);
                }
                p.x = e.clientX;
                p.y = e.clientY;
                return;
            }
        }
        if (e.target !== this.canvas && !p) {
            return;
        }
        this.mouse = { x: e.clientX, y: e.clientY };
        const c = this.view.cellAt(e.clientX, e.clientY, this.state.layer);
        const s = this.state;
        if (!c || !s.cursor || c[0] !== s.cursor[0] || c[2] !== s.cursor[2] || s.cursorSrc !== 'mouse') s.variant = 0;
        s.cursor = c && c[0] >= -4 && c[2] >= -4 && c[0] < 52 && c[2] < 52 ? c : null;
        s.cursorSrc = 'mouse';
        this.updateGhost();
    }

    onPointerUp(e) {
        const p = this.pointer;
        if (!p || (p.id != null && e.pointerId !== p.id)) return;
        this.pointer = null;
        try {
            this.canvas.releasePointerCapture(e.pointerId);
        } catch (err) { /* ignore */ }
        if (p.moved) return;
        this.mouse = { x: e.clientX, y: e.clientY };
        if (p.button === 0 && (p.alt || e.altKey)) this.eyedrop();
        else if (p.button === 0) this.placeAtCursor();
        else if (p.button === 2) this.deleteAtCursor();
        else if (p.button === 1) this.eyedrop();
    }

    onWheel(e) {
        e.preventDefault();
        if (e.shiftKey) {
            const d = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
            const now = performance.now();
            // Trackpads send many small wheel events: one rotation per notch.
            if (now - (this._lastWheelRot || 0) < 120) return;
            this._lastWheelRot = now;
            this.rotate(d > 0 ? 1 : -1);
            return;
        }
        const scale = e.deltaMode === 1 ? 30 : 1;
        this.view.zoomBy(Math.exp(e.deltaY * scale * 0.0012));
    }

    onKeyDown(e) {
        if (this.disposed || modalOpen() || e.defaultPrevented) return;
        if (isTypingTarget(e.target)) return;
        const k = e.key;
        const ctrl = e.ctrlKey || e.metaKey;
        const lower = k.length === 1 ? k.toLowerCase() : k;
        const onButton = e.target && e.target.tagName === 'BUTTON';
        if (this.state.guide && (k === 'Escape' || lower === 'h' || k === '?')) {
            e.preventDefault();
            this.toggleGuide(false);
            return;
        }
        if (ctrl) {
            if (lower === 'z' && !e.shiftKey) this.undo();
            else if (lower === 'y' || (lower === 'z' && e.shiftKey)) this.redo();
            else if (lower === 's') this.save();
            else return;
            e.preventDefault();
            return;
        }
        if (e.altKey) return;
        const ARROWS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', w: 'up', s: 'down', a: 'left', d: 'right' };
        if (ARROWS[lower]) {
            // Arrows on a focused palette button move between buttons instead.
            if (onButton && k.startsWith('Arrow')) return;
            e.preventDefault();
            this.moveCursorKeys(ARROWS[lower]);
            return;
        }
        let handled = true;
        switch (lower) {
            case ' ':
            case 'Enter':
                if (onButton) return;
                this.placeAtCursorFromKeys();
                break;
            case 'Delete':
            case 'Backspace':
            case 'x':
                this.deleteAtCursor();
                break;
            case 'r':
                this.rotate(e.shiftKey ? -1 : 1);
                break;
            case 'q':
            case 'PageDown':
                this.setLayer(this.state.layer - 1);
                break;
            case 'e':
            case 'PageUp':
                this.setLayer(this.state.layer + 1);
                break;
            case 'c':
            case 'i':
                this.eyedrop();
                break;
            case 'v':
                this.toggleTop();
                break;
            case 'f':
                this.frameTrack();
                break;
            case 'g':
                this.toggleSnap();
                break;
            case 't':
                this.testDrive();
                break;
            case 'b':
                this.setMode(this.state.mode === 'block' ? 'decor' : 'block');
                break;
            case 'h':
            case '?':
            case 'F1':
                this.toggleGuide();
                break;
            case '1': case '2': case '3':
                this.setSurface(ROAD_SURFACES[Number(lower) - 1]);
                break;
            case '[':
                this.cycleItem(-1);
                break;
            case ']':
                this.cycleItem(1);
                break;
            case 'Escape':
                this.leave();
                break;
            default:
                handled = false;
        }
        if (handled) e.preventDefault();
    }

    placeAtCursorFromKeys() {
        if (!this.state.cursor) {
            this.moveCursorKeys('up');
            return;
        }
        // A keyboard placement chains: the cursor moves on to where the new block ends.
        this.state.cursorSrc = 'keys';
        this.placeAtCursor();
    }

    // ------------------------------------------------------------------ track actions

    async editProps() {
        const app = this.app, t = this.doc.track;
        const name = h('input', { type: 'text', value: t.name, maxlength: 48, 'data-autofocus': true });
        const author = h('input', { type: 'text', value: t.author, maxlength: 32 });
        const mood = h('select', MOODS.map((m) => h('option', { value: m, selected: m === t.mood }, MOOD_LABELS[m] || m)));
        const mode = h('select', h('option', { value: 'race', selected: t.mode === 'race' }, 'Race (fastest time)'),
            h('option', { value: 'platform', selected: t.mode === 'platform' }, 'Platform (fewest respawns)'));
        const laps = h('input', { type: 'number', min: 1, max: 20, step: 1, value: t.laps });
        const res = await app.modal((close) => {
            const submit = () => close({ name: name.value, author: author.value, mood: mood.value, mode: mode.value, laps: Number(laps.value) });
            for (const el of [name, author, laps]) el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
            return h('div.pt-col.ed-props',
                h('h2.pt-subtitle', 'Track properties'),
                h('label.pt-field', 'Name', name),
                h('label.pt-field', 'Author', author),
                h('div.ed-props-row',
                    h('label.pt-field', 'Mood', mood),
                    h('label.pt-field', 'Mode', mode),
                    h('label.pt-field', 'Laps', laps)),
                h('p.pt-muted.ed-props-note', 'More than one lap needs a Lap Igloo (StartFinish). Changing laps or mode needs a new validation run.'),
                h('div.pt-row.pt-modal-actions',
                    h('button.pt-btn', { type: 'button', onclick: () => close(null) }, 'Cancel'),
                    h('button.pt-btn.primary', { type: 'button', onclick: submit }, 'Apply')));
        }, { label: 'Track properties' });
        if (!res || this.disposed) return;
        if (this.doc.setProps(res)) this.afterChange();
    }

    async newTrack() {
        if (this.doc.dirty && !(await this.app.confirm(`Start a new track? Unsaved changes to "${this.doc.track.name}" will be lost.`, { title: 'New track', ok: 'Start fresh', danger: true }))) return;
        if (this.disposed) return;
        this.state.layer = 0;
        this.view.setLayer(0);
        this.setDoc(new EditorDoc(newTrack({ author: this.defaultAuthor() }), { pristine: true }));
        this.app.toast('Fresh snow! Build from the Start igloo.', { icon: 'snowflake' });
    }

    save() {
        const app = this.app, doc = this.doc;
        let id = doc.track.id;
        if (!id || app.catalog.isReserved(id)) id = newTrackId();
        doc.track.id = id;
        const stored = doc.toStored();
        const all = app.storage.get('tracks', {}) || {};
        all[id] = stored;
        if (!app.storage.set('tracks', all)) {
            app.toast('Storage is full: delete some replays or tracks first.', { kind: 'bad', ms: 4000 });
            return false;
        }
        doc.markSaved(id);
        this.saveDraft();
        this.updateControls();
        app.toast(doc.validated ? `Saved "${doc.track.name}"` : `Saved "${doc.track.name}" (not validated yet)`, { icon: 'save', kind: doc.validated ? 'good' : undefined });
        return true;
    }

    async share() {
        const app = this.app, doc = this.doc;
        let code;
        try {
            code = encodeTrack(doc.toTrack());
        } catch (e) {
            app.toast(`Can't make a code: ${e.message}`, { kind: 'bad' });
            return;
        }
        app.showCode('Share code', code, {
            message: doc.validated
                ? `Friends can paste this into My Tracks → Import code to race "${doc.track.name}" (medals included).`
                : `Friends can paste this into My Tracks → Import code. Validate first if you want medals in it.`,
            copy: async (c) => app.toast(await copyText(c) ? 'Share code copied' : 'Copy failed: select the text and copy it', { icon: 'copy' }),
        });
    }

    async openDialog() {
        const app = this.app;
        const all = app.storage.get('tracks', {}) || {};
        const mine = Object.keys(all).filter((id) => all[id] && typeof all[id] === 'object')
            .map((id) => ({ id, t: all[id] }))
            .sort((a, b) => (b.t.updated || 0) - (a.t.updated || 0));
        const official = [];
        for (const c of app.levels.CAMPAIGNS) for (const tier of c.tiers) for (const t of tier.tracks) official.push({ ...t, group: tier.name });
        const choice = await app.modal((close) => {
            const list = h('div.ed-open-list.pt-scroll',
                mine.length ? mine.map(({ id, t }) => h('button.ed-open-row', { type: 'button', onclick: () => close({ kind: 'mine', id }) },
                    h('span.ed-open-name', t.name || 'Untitled Track'),
                    h('span.pt-muted', `${(t.blocks || []).length} blocks${t.validation ? ' · validated' : ''}`)))
                    : h('p.pt-muted', 'No saved tracks yet.'));
            const sel = h('select', { 'aria-label': 'Official track' },
                official.map((t) => h('option', { value: t.id }, `${t.id} · ${t.name} (${t.group})`)));
            return h('div.pt-col.ed-open',
                h('h2.pt-subtitle', 'Open a track'),
                h('div.ed-open-sec', 'My tracks'), list,
                h('div.ed-open-sec', 'Copy an official track'),
                h('div.pt-row', sel, h('button.pt-btn.small', { type: 'button', onclick: () => close({ kind: 'official', id: sel.value }) }, ico('copy', 16), 'Open copy')),
                h('div.ed-open-sec', 'Share code'),
                h('div.pt-row', h('button.pt-btn.small', { type: 'button', onclick: () => close({ kind: 'code' }) }, ico('import', 16), 'Paste a PT1 code…')),
                h('div.pt-row.pt-modal-actions', h('button.pt-btn', { type: 'button', 'data-autofocus': true, onclick: () => close(null) }, 'Close')));
        }, { label: 'Open a track', className: 'ed-open-modal' });
        if (!choice || this.disposed) return;
        let doc = null;
        if (choice.kind === 'mine') {
            const t = all[choice.id];
            doc = docFromStored({ ...t, id: choice.id });
            doc.markSaved(choice.id);
        } else if (choice.kind === 'official') {
            const t = app.levels.getTrack(choice.id);
            if (!t) return;
            doc = new EditorDoc({ ...t, id: newTrackId(), name: `${t.name} (copy)`.slice(0, 48), author: this.defaultAuthor(), medals: null });
        } else if (choice.kind === 'code') {
            const text = await app.prompt('Paste a share code', { message: 'A track code starts with PT1.', multiline: true, placeholder: 'PT1.…', ok: 'Open' });
            if (!text || this.disposed) return;
            let t;
            try {
                t = decodeTrack(text.trim());
            } catch (e) {
                app.toast('That share code is damaged. Copy the whole code and try again.', { kind: 'bad', ms: 4000 });
                return;
            }
            const taken = app.catalog.isReserved(t.id) || !!all[t.id];
            doc = new EditorDoc({ ...t, id: taken ? newTrackId() : t.id });
        }
        if (!doc) return;
        if (this.doc.dirty && !(await app.confirm(`Open "${doc.track.name}"? Unsaved changes to "${this.doc.track.name}" will be lost.`, { title: 'Unsaved changes', ok: 'Open', danger: true }))) return;
        if (this.disposed) return;
        this.state.layer = 0;
        this.view.setLayer(0);
        this.setDoc(doc);
        app.toast(`Opened "${doc.track.name}"`, { icon: 'map' });
    }

    /** Test drive: every finished run validates the layout it was driven on. */
    testDrive() {
        const app = this.app;
        if (this.needsBuild) this.build();
        const w = this.world;
        if (!w || !w.spawn) {
            app.toast('Place a Start igloo first.', { kind: 'bad' });
            return;
        }
        if (!w.route) {
            app.toast(`Not raceable yet: ${w.routeError || 'connect the Start to a Finish'}`, { kind: 'bad', ms: 4200 });
            return;
        }
        this.saveDraft();
        const doc = this.doc;
        let note = null;
        const record = (res) => {
            if (!res || !res.finished) return;
            const before = doc.validation();
            if (doc.recordRun({ ...res, by: res.autopilot ? 'autopilot' : 'driver' })) {
                note = before ? `New author time: ${formatTime(res.timeMs)}` : `Validated! Emperor time ${formatTime(res.timeMs)}`;
                if (parked) parked.note = note;
            }
        };
        this.park();
        const track = doc.toTrack();
        app.goto('play', {
            track, mode: 'test',
            onFinish: record,
            onExit: (res) => {
                record(res);
                if (parked) parked.note = note;
                app.goto('editor', { resume: true });
            },
        });
    }

    autoValidate() {
        const app = this.app;
        if (this.needsBuild) this.build();
        const w = this.world;
        if (!w || !w.route) {
            app.toast(`The autopilot needs a finished road: ${w ? (w.routeError || 'no route') : 'no Start'}`, { kind: 'bad', ms: 4000 });
            return;
        }
        app.toast('The autopilot is driving…', { icon: 'brain', ms: 1500 });
        const doc = this.doc;
        const version = doc.version;
        // Let the toast paint before a few hundred ms of simulation.
        setTimeout(() => {
            if (this.disposed || doc !== this.doc || doc.version !== version) return;
            let r;
            try {
                r = runAutopilot(buildWorld(doc.toTrack()), { record: true });
            } catch (e) {
                app.toast(`The autopilot couldn't drive it: ${e.message}`, { kind: 'bad', ms: 4000 });
                return;
            }
            if (!r.finished) {
                app.toast(r.gaveUp ? 'The autopilot gave up: try a smoother line or more landing room.' : 'The autopilot ran out of time.', { kind: 'bad', ms: 4200 });
                return;
            }
            const before = doc.validation();
            const improved = doc.recordRun({ finished: true, timeMs: r.timeMs, respawns: r.respawns, replay: r.replay, by: 'autopilot' });
            const resp = r.respawns ? ` with ${r.respawns} respawn${r.respawns === 1 ? '' : 's'}` : '';
            if (improved) app.toast(`${before ? 'New author time' : 'Validated by the autopilot'}: ${formatTime(r.timeMs)}${resp}`, { kind: 'good', icon: 'check', ms: 3600 });
            else app.toast(`The autopilot finished in ${formatTime(r.timeMs)}${resp}, slower than the author time.`, { icon: 'brain', ms: 3600 });
            this.renderStatus();
            this.scheduleDraft();
        }, 60);
    }

    leave() {
        this.saveDraft();
        if (this.doc.dirty) this.app.toast('Draft kept: the editor picks it up next time', { icon: 'save', ms: 2400 });
        this.app.goto('menu');
    }

    // ------------------------------------------------------------------ teardown

    dispose() {
        if (this.disposed) return;
        this.saveDraft();
        this.disposed = true;
        clearTimeout(this._draftTimer);
        for (const off of this._listeners) off();
        this._listeners = [];
        this.app.loop.stop();
        try {
            this.app.renderer.setTrackHighlight(null);
        } catch (e) { /* hardened renderer */ }
        if (this.view) this.view.dispose();
        this.view = null;
        if (this.el) this.el.remove();
    }
}

/** Short, friendly text for a validation issue. */
export function friendlyIssue(is, doc) {
    const name = (i) => {
        const b = doc.blocks[i];
        return b && BLOCKS[b.b] ? BLOCKS[b.b].name : 'a block';
    };
    switch (is.code) {
        case 'openEnd': return `Open road end on ${name(is.blocks[0])}`;
        case 'overlap': return `${name(is.blocks[0])} overlaps ${name(is.blocks[1])}`;
        case 'outside': return `${name(is.blocks[0])} pokes out of the map`;
        case 'noSpawn': return 'No Start igloo';
        case 'multiSpawn': return 'More than one Start igloo';
        case 'noFinish': return 'No Finish arch';
        case 'lapsNoStartFinish': return 'Laps need a Lap Igloo (StartFinish)';
        case 'unreachableCheckpoint': return 'A checkpoint cannot be reached';
        case 'unreachableFinish': return 'No road from the Start to the Finish';
        case 'lapNotClosed': return 'The lap does not come back to the Lap Igloo';
        case 'startFinishOneLap': return 'Lap Igloo on a 1-lap track';
        case 'finishOnLapTrack': return 'Finish arch on a lap track only counts on the last lap';
        default: return is.message;
    }
}

const editor = {
    id: 'editor',
    session: null,

    enter(app, params = {}) {
        if (app.renderer.isNull) {
            loadModuleCss('editor');
            const el = h('div.pt-screen.ed-nogl', h('div.pt-panel.pt-col',
                h('h2.pt-subtitle', 'The editor needs a 3D view'),
                h('p.pt-muted', 'This browser has WebGL switched off, so blocks cannot be drawn. Your saved tracks are safe in My Tracks.'),
                h('div.pt-row', h('button.pt-btn.primary', { type: 'button', 'data-autofocus': true, onclick: () => app.goto('menu') }, 'Back to the menu'))));
            app.ui.appendChild(el);
            return;
        }
        this.session = new EditorSession(app, params || {});
        this.session.start();
    },

    exit(app) {
        if (this.session) this.session.dispose();
        this.session = null;
    },

    back(app) {
        if (this.session) this.session.leave();
        else app.goto('menu');
    },
};

export default editor;
