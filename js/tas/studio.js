// TAS Studio screen: a 3D view of the TAS car (plus an optional comparison
// ghost) with precise state readouts, a piano-roll timeline, the script
// editor, savestates, record mode, a bruteforce panel and project management.
// One TasRunner per open project; the timeline is the source of truth and the
// script text, the roll and the 3D view all follow it.
import { buildWorld } from '../core/track.js';
import { snapshotCar, lerpCarSnapshot, verifyReplay } from '../core/replay.js';
import { runAutopilot } from '../core/autopilot.js';
import { formatTime } from '../core/format.js';
import { getSamples } from '../core/samples.js';
import { h, setText, toggleClass, copyText, loadModuleCss } from '../game/dom.js';
import { iconSvg } from '../game/icons.js';
import { modalOpen } from '../game/ui.js';
import { GhostRun, makeCarView } from '../game/ghost.js';
import { allRecords, listReplays, saveReplay } from '../game/records.js';
import { encodeReplayCodeAsync, decodeReplayText } from '../game/replaycode.js';
import { InputTimeline } from './timeline.js';
import { parse, serialize, fromReplay, toReplay } from './script.js';
import { TasRunner } from './runner.js';
import { TimelineCanvas } from './studio-timeline.js';
import { ScriptEditor } from './studio-script.js';
import { BruteforcePanel } from './studio-bf.js';
import {
    SPEEDS, SLOT_NAMES, slotFromCode, stepSpeed, quatToEuler, SURFACE_LABELS, describeEffects, fmtNum, tickTime,
    parseTickInput, formatTick, copyRange, pasteClip, clearRange, removeRange, shiftRange, nudgeRange, UndoStack,
    markersFromTrace, nextMarkerTick, listProjects, loadProject, saveProject, deleteProject, uniqueName, startTimeline,
} from './studio-model.js';

const CAMERAS = [
    { id: 'chase', label: 'Chase' },
    { id: 'close', label: 'Close' },
    { id: 'orbit', label: 'Orbit' },
    { id: 'free', label: 'Free' },
    { id: 'cockpit', label: 'Cockpit' },
    { id: 'top', label: 'Top' },
];
const COAST = 150;               // ticks the cursor may go past the finish
const RECORD_SPEEDS = [0.1, 0.25, 0.5, 1];

// The open project survives leaving the screen (Watch, menus) for this page session.
let memo = null;
// Where Back goes (params.onExit, e.g. the AI Lab or Replays); kept across Watch and back.
let exitTo = null;
const EMPTY = new InputTimeline();

// Replay names say TAS once, even for a project that started from a TAS replay.
const tasName = (name) => (/\bTAS\b/.test(name) ? name : `${name} (TAS)`);

const icon = (name, size = 16) => h('span.pt-ico', { html: iconSvg(name, size) });

class Studio {
    constructor(app) {
        this.app = app;
        this.track = null;
        this.world = null;
        this.runner = null;
        this.car = null;
        this.ghostCar = null;
        this.ghost = null;
        this.compare = null;
        this.compareLabel = '';
        this.compareResult = null;
        this.name = 'Snow run';
        this.notes = '';
        this.dirty = false;
        this.playing = false;
        this.speed = 1;
        this.recording = false;
        this.recordOpts = { onStop: 'keep', speed: 0.25 };
        this.countdown = 0;
        this.respawnQueued = false;
        this.cam = 0;
        this.tool = 'draw';
        this.selection = null;
        this.loop = { from: 0, to: 0, on: false };
        this.clip = null;
        this.undo = new UndoStack();
        this.trace = null;
        this.markers = [];
        this.endTick = 0;
        this.scriptStyle = 'ranges';
        this.meta = {};
        this._applyingScript = false;
        this._scriptTimer = 0;
        this._traceTimer = 0;
        this._shown = -1;
        this._scrubbing = false;
        this._inp = {};
        this.prev = makeCarView();
        this.cur = makeCarView();
        this.view = makeCarView();
        this._offs = [];
        this.disposed = false;
    }

    // ================================================================== UI

    build() {
        const app = this.app;
        const B = (label, iconName, onclick, opts = {}) => h(`button.pt-btn.small${opts.cls ? '.' + opts.cls : ''}`, {
            type: 'button', onclick, title: opts.title || label, 'aria-label': opts.aria || null,
        }, iconName ? icon(iconName) : null, opts.iconOnly ? null : label);

        // Top bar
        this.titleEl = h('div.tas-title');
        this.trackEl = h('div.tas-track.pt-muted');
        this.resultEl = h('div.tas-result.pt-mono');
        const top = h('header.tas-top',
            B('Back', 'back', () => this.leave(), { cls: 'ghost' }),
            h('div.tas-titles', this.titleEl, this.trackEl),
            this.resultEl,
            h('div.pt-spacer'),
            B('Save', 'save', () => this.save(), { title: 'Save project (Ctrl+S)' }),
            B('Validate', 'check', () => this.validate(), { title: 'Re-simulate from scratch and verify as a replay' }),
            B('Watch', 'film', () => this.watch(), { title: 'Play it in the replay viewer' }),
            B('Save as replay', 'flag', () => this.saveAsReplay()),
            B('Keys', 'keyboard', () => this.showKeys(), { title: 'Keyboard shortcuts (?)' }));

        // 3D view overlay
        this.viewEl = h('div.tas-view');
        this.info = {};
        const row = (k, label) => {
            this.info[k] = h('span.pt-mono');
            return [h('dt', label), h('dd', this.info[k])];
        };
        this.infoEl = h('dl.tas-info.pt-panel',
            row('tick', 'Tick'), row('time', 'Time'), row('speed', 'Speed'), row('pos', 'Pos'), row('vel', 'Vel'),
            row('rot', 'Yaw/Pit/Rol'), row('surface', 'Surface'), row('state', 'State'), row('effects', 'Effects'), row('input', 'Input'));
        this.splitsEl = h('div.tas-splits.pt-panel');
        this.bannerEl = h('div.tas-banner.pt-hidden', { role: 'status', 'aria-live': 'polite' });
        this.viewEl.append(this.infoEl, this.splitsEl, this.bannerEl);

        // Transport
        this.playBtn = h('button.pt-btn.small.tas-play', { type: 'button', 'aria-label': 'Play or pause (Space)', onclick: () => this.togglePlay() });
        this.timeInput = h('input.pt-input.tas-time.tas-jump', { type: 'text', spellcheck: 'false', 'aria-label': 'Jump to time or t<tick>', title: 'Jump: 12.34, 1:02.50 or t1234, then Enter' });
        this.timeInput.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') {
                const r = parseTickInput(this.timeInput.value);
                if (r.error) this.toast(r.error, { kind: 'bad' });
                else { this.pause(); this.seek(r.tick); this.timeInput.blur(); }
            } else if (e.key === 'Escape') this.timeInput.blur();
        });
        this.timeInput.addEventListener('blur', () => { this._shown = -1; });
        this.speedSel = h('select.pt-input.tas-mini', { 'aria-label': 'Playback speed' },
            SPEEDS.map((s) => h('option', { value: s }, `${s}×`)));
        this.speedSel.addEventListener('change', () => this.setSpeed(Number(this.speedSel.value)));
        this.camSel = h('select.pt-input.tas-mini', { 'aria-label': 'Camera', title: 'Camera (C)' }, CAMERAS.map((c, i) => h('option', { value: i }, `cam: ${c.label}`)));
        this.camSel.addEventListener('change', () => this.setCamera(Number(this.camSel.value)));
        this.ghostSel = h('select.pt-input.tas-mini.tas-ghostsel', { 'aria-label': 'Comparison ghost', title: 'Comparison ghost (G)' });
        this.ghostSel.addEventListener('change', () => this.pickGhost(this.ghostSel.value));
        this.loopBtn = B('Loop', 'retry', () => this.toggleLoop(), { title: 'Loop the selection (L)' });
        this.recBtn = h('button.pt-btn.small.tas-rec', { type: 'button', onclick: () => this.toggleRecord(), title: 'Record live inputs from the cursor (R)' }, h('span.tas-dot'), 'Rec');
        this.recSpeed = h('select.pt-input.tas-mini', { 'aria-label': 'Recording speed', title: 'Slow motion while recording' },
            RECORD_SPEEDS.map((s) => h('option', { value: s, selected: s === this.recordOpts.speed }, `rec ${s}×`)));
        this.recSpeed.addEventListener('change', () => {
            this.recordOpts.speed = Number(this.recSpeed.value);
            if (this.recording) app.loop.timeScale = this.recordOpts.speed;
        });
        this.recStop = h('select.pt-input.tas-mini', { 'aria-label': 'When recording stops', title: 'When recording stops' },
            h('option', { value: 'keep' }, 'keep rest'), h('option', { value: 'cut' }, 'cut after'));
        this.recStop.addEventListener('change', () => { this.recordOpts.onStop = this.recStop.value; });
        const transport = h('div.tas-transport',
            h('div.pt-seg',
                B('Start', null, () => this.jumpStart(), { iconOnly: true, aria: 'Jump to start (Home)', title: 'Start (Home)' }),
                B('Previous checkpoint', null, () => this.jumpMarker(-1), { iconOnly: true, aria: 'Previous checkpoint (PageUp)', title: 'Previous checkpoint (PageUp)' }),
                B('Frame back', null, () => this.frameStep(-1), { iconOnly: true, aria: 'Frame back (,)', title: 'Frame back (, or ←)' }),
                this.playBtn,
                B('Frame forward', null, () => this.frameStep(1), { iconOnly: true, aria: 'Frame forward (.)', title: 'Frame forward (. or →)' }),
                B('Next checkpoint', null, () => this.jumpMarker(1), { iconOnly: true, aria: 'Next checkpoint (PageDown)', title: 'Next checkpoint (PageDown)' }),
                B('End', null, () => this.jumpEnd(), { iconOnly: true, aria: 'Jump to end (End)', title: 'End (End)' })),
            this.timeInput, this.speedSel, this.loopBtn,
            h('div.tas-recgroup', this.recBtn, this.recSpeed, this.recStop));
        this.viewEl.appendChild(h('div.tas-viewctl', this.camSel, this.ghostSel));
        const glyphs = ['⏮', '⇤', '◀', null, '▶', '⇥', '⏭'];
        [...transport.firstChild.children].forEach((b, i) => { if (glyphs[i]) b.textContent = glyphs[i]; });

        // Roll toolbar
        this.toolBtns = {
            draw: B('Draw', 'edit', () => this.setTool('draw'), { title: 'Draw steering, paint pedals (D)' }),
            select: B('Select', null, () => this.setTool('select'), { title: 'Drag to select a range (V; Shift-drag works in Draw too)' }),
        };
        this.selInfo = h('span.tas-selinfo.pt-mono.pt-muted');
        const rollBar = h('div.tas-rollbar',
            h('div.pt-seg', this.toolBtns.draw, this.toolBtns.select),
            h('div.tas-sep'),
            B('Copy', null, () => this.copySel(), { title: 'Copy selection (Ctrl+C)' }),
            B('Cut', null, () => this.cutSel(), { title: 'Copy and clear (Ctrl+X)' }),
            B('Paste', null, () => this.paste(false), { title: 'Paste over at the cursor (Ctrl+V); Ctrl+Shift+V inserts' }),
            B('Clear', null, () => this.clearSel(), { title: 'Neutral inputs on the selection (Delete)' }),
            B('Remove', null, () => this.removeSel(), { title: 'Remove the ticks, later inputs move earlier (Shift+Delete)' }),
            B('Insert', null, () => this.insertTick(), { title: 'Insert a tick at the cursor holding the previous input (Insert)' }),
            B('◀', null, () => this.shiftSel(-1), { title: 'Move the selection one tick earlier (Alt+←)' }),
            B('▶', null, () => this.shiftSel(1), { title: 'Move the selection one tick later (Alt+→)' }),
            B('S−', null, () => this.nudgeSel(-1024), { title: 'Steer the selection left by 1024 (-)' }),
            B('S+', null, () => this.nudgeSel(1024), { title: 'Steer the selection right by 1024 (=)' }),
            this.selInfo,
            h('div.pt-spacer'),
            h('div.tas-sep'),
            B('Undo', null, () => this.doUndo(), { title: 'Undo (Ctrl+Z)' }),
            B('Redo', null, () => this.doRedo(), { title: 'Redo (Ctrl+Shift+Z)' }),
            B('−', null, () => this.roll.zoom(1 / 1.6), { title: 'Zoom out', aria: 'Zoom out' }),
            B('+', null, () => this.roll.zoom(1.6), { title: 'Zoom in', aria: 'Zoom in' }),
            B('Fit', null, () => this.roll.fit(), { title: 'Show the whole run' }));
        this.rollHost = h('div.tas-rollhost');
        const bottom = h('div.tas-bottom.pt-panel', transport, rollBar, this.rollHost);

        // Side panel
        this.script = new ScriptEditor({
            onApply: (p, text) => this.applyScript(p, text),
            onJump: (tick) => { this.pause(); this.seek(tick); },
            onStyle: (s) => { this.scriptStyle = s; this.writeScript(true); },
        });
        this.bf = new BruteforcePanel(this);
        this.projectEl = h('div.tas-project');
        const tabs = [['script', 'Script'], ['bf', 'Bruteforce'], ['project', 'Project']];
        this.tabBtns = {};
        this.tabPanes = { script: this.script.el, bf: this.bf.el, project: this.projectEl };
        const tabBar = h('div.tas-tabs', { role: 'tablist' }, tabs.map(([id, label]) => {
            const b = h('button.tas-tab', { type: 'button', role: 'tab', id: `tas-tab-${id}`, onclick: () => this.showTab(id) }, label);
            this.tabBtns[id] = b;
            return b;
        }));
        const panes = h('div.tas-panes', tabs.map(([id]) => {
            const p = h('div.tas-pane', { role: 'tabpanel', 'aria-labelledby': `tas-tab-${id}` }, this.tabPanes[id]);
            this.tabPanes[id] = p;
            return p;
        }));
        const side = h('aside.tas-side.pt-panel', tabBar, panes);

        this.el = h('div.pt-screen.tas-screen', top, h('div.tas-main', h('div.tas-left', this.viewEl, bottom), side));
        app.ui.appendChild(this.el);
        this.roll = new TimelineCanvas(this.rollHost, this);
        this.showTab('script');
        this.setTool('draw');

        this._ro = new ResizeObserver(() => this.layoutView());
        this._ro.observe(this.viewEl);
        const onKey = (e) => this.onKey(e);
        document.addEventListener('keydown', onKey);
        this._offs.push(() => document.removeEventListener('keydown', onKey));
        const onResize = () => this.layoutView();
        window.addEventListener('resize', onResize);
        this._offs.push(() => window.removeEventListener('resize', onResize));
        const onUnload = (e) => { if (this.dirty) { e.preventDefault(); e.returnValue = ''; } };
        window.addEventListener('beforeunload', onUnload);
        this._offs.push(() => window.removeEventListener('beforeunload', onUnload));
    }

    showTab(id) {
        this.tab = id;
        for (const k of Object.keys(this.tabBtns)) {
            toggleClass(this.tabBtns[k], 'active', k === id);
            this.tabBtns[k].setAttribute('aria-selected', String(k === id));
            toggleClass(this.tabPanes[k], 'pt-hidden', k !== id);
        }
        if (id === 'project') this.renderProject();
    }

    /** Draws the 3D scene only into the free area left of the panels. */
    layoutView() {
        const r = this.viewEl.getBoundingClientRect();
        const W = window.innerWidth, H = window.innerHeight;
        if (!r.width || !r.height) return;
        const rnd = this.app.renderer;
        rnd.resize();
        rnd.setViewports([{ x: r.left / W, y: r.top / H, w: r.width / W, h: r.height / H, camera: rnd.camera }]);
        if (this.roll) this.roll.resize();
    }

    toast(msg, opts) {
        this.app.toast(msg, opts);
    }

    // ================================================================== projects

    async open(params) {
        this.build();
        if (typeof params.onExit === 'function') exitTo = params.onExit;
        else if (!params.resume) exitTo = null;
        let ok = false;
        try {
            if (params.resume && memo) ok = this.loadData(memo);
            else if (params.project) {
                const p = loadProject(this.app.storage, params.project);
                ok = p ? this.loadData(p) : false;
            } else if (params.track) {
                const track = this.app.catalog.resolve(params.track);
                if (!track) throw new Error("That track couldn't be found.");
                const replay = params.replay || null;
                if (replay) ok = this.newProject(track, { kind: 'replay', replay, name: replay.name ? `${replay.name.replace(/\s*\d+:\d\d\.\d\d\b/, '')} TAS` : null });
                else ok = this.newProject(track, { kind: params.start || 'autopilot' });
            } else if (memo) ok = this.loadData(memo);
        } catch (e) {
            this.toast(e.message, { kind: 'bad', ms: 4500 });
        }
        if (!ok) {
            // Nothing to show yet: start on the first campaign track and open the project tab.
            ok = this.newProject(this.app.catalog.getTrack('A01') || getSamples()[0], { kind: 'autopilot' });
            this.showTab('project');
        }
        this.startLoop();
    }

    /** Track list for pickers: [{ group, items: [{ id, name }] }]. */
    trackGroups() {
        const cat = this.app.catalog;
        const out = [];
        for (const c of cat.campaigns()) {
            for (const t of c.tiers) out.push({ group: c.tiers.length > 1 ? `${c.name}: ${t.name}` : `${c.name}`, items: t.tracks.map((x) => ({ id: x.id, name: `${x.id} ${x.name}` })) });
        }
        const mine = cat.customTracks();
        if (mine.length) out.push({ group: 'My tracks', items: mine.map((t) => ({ id: t.id, name: t.name || t.id })) });
        out.push({ group: 'Dev samples', items: getSamples().map((t) => ({ id: t.id, name: `${t.id} ${t.name}` })) });
        return out;
    }

    /** Start choices for a track: [{ value, label, replay? }]. */
    startChoices(track) {
        const cat = this.app.catalog;
        const out = [{ value: 'autopilot', label: 'Autopilot run' }, { value: 'empty', label: 'Empty (gas from GO)' }];
        let hash = null;
        try { hash = buildWorld(track).hash; } catch (e) { /* listed anyway */ }
        if (cat.isOfficial(track.id) && cat.authorReplay(track.id)) out.push({ value: 'emperor', label: 'Emperor ghost' });
        const rec = allRecords(this.app.storage)[track.id];
        if (rec && rec.replay && (!rec.trackHash || rec.trackHash === hash)) out.push({ value: 'pb', label: `Personal best ${formatTime(rec.bestMs)}`, replay: rec.replay });
        for (const r of listReplays(this.app.storage)) {
            if (r.trackId !== track.id || (r.replay.trackHash && hash && r.replay.trackHash !== hash)) continue;
            out.push({ value: `replay:${r.id}`, label: `Replay: ${r.name || formatTime(r.timeMs)}`, replay: r.replay });
        }
        return out;
    }

    /** Builds a project on a track. start: { kind: 'autopilot'|'empty'|'emperor'|'pb'|'replay', replay?, name? }. */
    newProject(track, start) {
        let world;
        try {
            world = buildWorld(track);
        } catch (e) {
            this.toast(`This track can't be built: ${e.message}`, { kind: 'bad' });
            return false;
        }
        if (!world.spawn || !world.route) {
            this.toast(`This track can't be raced yet: ${world.routeError || 'no start or route'}.`, { kind: 'bad' });
            return false;
        }
        let tl, label = start.kind;
        if (start.kind === 'autopilot') {
            const run = runAutopilot(world, { record: true });
            tl = fromReplay(run.replay);
            label = 'Autopilot';
        } else if (start.kind === 'emperor') {
            const rep = this.app.catalog.authorReplay(track.id);
            if (!rep) return this.newProject(track, { kind: 'autopilot' });
            tl = fromReplay(rep);
            label = 'Emperor';
        } else if (start.replay) {
            if (start.replay.trackHash && start.replay.trackHash !== world.hash) {
                this.toast('That run was recorded on an older layout of this track: it may not finish any more.', { kind: 'bad', ms: 4500 });
            }
            tl = fromReplay(start.replay);
            label = start.kind === 'pb' ? 'PB' : 'Replay';
        } else {
            tl = startTimeline('gas');
            label = 'Fresh';
        }
        const name = start.name || uniqueName(this.app.storage, `${track.name || track.id} ${label}`);
        return this.setProject({ track, world, timeline: tl, name, notes: '', slots: [], cursor: 0, script: null });
    }

    /** Loads saved / remembered project data { trackId, track?, script, notes, slots, cursor, name }. */
    loadData(p) {
        const track = p.track || this.app.catalog.getTrack(p.trackId);
        if (!track) {
            this.toast(`The track of '${p.name}' is missing (${p.trackId}).`, { kind: 'bad' });
            return false;
        }
        const world = buildWorld(track);
        const parsed = parse(p.script || '');
        if (parsed.errors.length) this.toast(`The saved script has ${parsed.errors.length} error(s); those lines were skipped.`, { kind: 'bad' });
        if (parsed.meta.hash && world.hash && parsed.meta.hash !== world.hash) this.toast('This script was made on another layout of the track.', { kind: 'bad', ms: 4000 });
        const ok = this.setProject({ track, world, timeline: parsed.timeline, name: p.name || 'Snow run', notes: p.notes || '', slots: p.slots || [], cursor: p.cursor || 0, script: p.script, meta: parsed.meta });
        this.dirty = !!p.dirty;
        this.updateTitle();
        return ok;
    }

    setProject({ track, world, timeline, name, notes, slots, cursor, script, meta }) {
        const app = this.app;
        this.stopRecording(true);
        this.pause();
        this.bf && this.bf.running && this.bf.stop();
        if (this.runner) this.runner.dispose();
        if (this._offEdit) this._offEdit();
        this.track = track;
        this.world = world;
        this.laps = world.laps || 1;
        this.name = name;
        this.notes = notes;
        this.meta = { ...(meta || {}) };
        this.runner = new TasRunner(world, timeline, { laps: this.laps });
        this._offEdit = this.runner.on('edit', (ev) => this.onEdit(ev.tick));
        this.undo.clear();
        this.setSelection(null);
        this.loop = { from: 0, to: 0, on: false };
        this.compare = null;
        this.compareResult = null;
        this.setGhost(null);

        const rnd = app.renderer;
        if (this.car) rnd.removeCar(this.car);
        app.loadWorld(world, track);
        this.car = rnd.addCar({ kind: 'player' });
        this.setCamera(this.cam);
        this.layoutView();

        this.refreshTrace();
        if (script != null) {
            this._applyingScript = true;
            this.script.setText(script);
            this._applyingScript = false;
        } else this.writeScript(true);
        for (const s of slots || []) {
            if (!SLOT_NAMES.includes(String(s.name))) continue;
            this.runner.seek(Math.min(s.tick, this.endTick));
            this.runner.save(String(s.name));
        }
        this.seek(Math.min(cursor || 0, this.endTick));
        this.fillGhostChoices();
        this.roll.fit();
        this.dirty = false;
        this.updateTitle();
        if (this.tab === 'project') this.renderProject();
        return true;
    }

    projectData() {
        const cat = this.app.catalog;
        const builtIn = cat.isOfficial(this.track.id) || getSamples().some((s) => s.id === this.track.id);
        return {
            name: this.name,
            trackId: this.track.id,
            track: builtIn ? undefined : this.track,
            script: this.scriptText(),
            notes: this.notes,
            slots: [...this.runner.slots.values()].map((s) => ({ name: s.name, tick: s.tick })),
            cursor: this.cursor,
            result: this.trace && this.trace.finished ? this.trace.finishTimeMs : null,
        };
    }

    /** The editor's text when it is in step with the timeline, else the canonical script. */
    scriptText() {
        const p = parse(this.script.ta.value);
        if (!p.errors.length && p.timeline.equals(this.runner.timeline)) return this.script.ta.value;
        return serialize(this.runner.timeline, { style: this.scriptStyle, meta: this.scriptMeta() });
    }

    scriptMeta() {
        const m = { ...this.meta, track: this.track.id, hash: this.world.hash, name: this.name };
        if (this.laps !== 1) m.laps = this.laps; else delete m.laps;
        if (this.trace && this.trace.finished) m.time = formatTime(this.trace.finishTimeMs); else delete m.time;
        return m;
    }

    save() {
        const ok = saveProject(this.app.storage, this.name, this.projectData());
        if (!ok) return this.toast('Storage is full: delete some projects or replays first.', { kind: 'bad' });
        this.dirty = false;
        this.updateTitle();
        this.toast(`Saved '${this.name}'`, { icon: 'save' });
        if (this.tab === 'project') this.renderProject();
        return undefined;
    }

    async saveAs() {
        const name = await this.app.prompt('Save project as', { value: this.name, ok: 'Save' });
        if (!name || !name.trim()) return;
        this.name = name.trim();
        this.save();
    }

    updateTitle() {
        if (!this.track) return;
        setText(this.titleEl, this.name + (this.dirty ? ' •' : ''));
        this.titleEl.title = this.dirty ? 'Unsaved changes' : '';
        setText(this.trackEl, `${this.track.name || this.track.id} · ${this.track.id}${this.laps > 1 ? ` · ${this.laps} laps` : ''}`);
        const tr = this.trace;
        setText(this.resultEl, tr ? (tr.finished ? `Finish ${formatTime(tr.finishTimeMs)}${tr.respawns ? ` · ${tr.respawns} resp.` : ''}` : 'Does not finish') : '');
        toggleClass(this.resultEl, 'bad', !!tr && !tr.finished);
    }

    renderProject() {
        const app = this.app;
        const nameIn = h('input.pt-input', { type: 'text', value: this.name, 'aria-label': 'Project name' });
        nameIn.addEventListener('change', () => { this.name = nameIn.value.trim() || this.name; this.markDirty(); this.writeScript(true); });
        const notesIn = h('textarea.pt-input', { rows: 3, 'aria-label': 'Notes', placeholder: 'Notes: routes tried, ideas…' });
        notesIn.value = this.notes;
        notesIn.addEventListener('input', () => { this.notes = notesIn.value; this.markDirty(); });
        for (const el of [nameIn, notesIn]) el.addEventListener('keydown', (e) => e.stopPropagation());

        const trackSel = h('select.pt-input', { 'aria-label': 'Track' }, this.trackGroups().map((g) => h('optgroup', { label: g.group },
            g.items.map((t) => h('option', { value: t.id, selected: t.id === this.track.id }, t.name)))));
        const startSel = h('select.pt-input', { 'aria-label': 'Start from' });
        let choices = [];
        const fillStarts = () => {
            const track = app.catalog.getTrack(trackSel.value);
            choices = track ? this.startChoices(track) : [];
            startSel.replaceChildren(...choices.map((c) => h('option', { value: c.value }, c.label)));
        };
        trackSel.addEventListener('change', fillStarts);
        fillStarts();
        const create = async () => {
            const track = app.catalog.getTrack(trackSel.value);
            const c = choices.find((x) => x.value === startSel.value);
            if (!track || !c) return;
            if (!(await this.okToDiscard())) return;
            const kind = c.value.startsWith('replay:') ? 'replay' : c.value;
            this.newProject(track, { kind, replay: c.replay });
        };

        const list = listProjects(app.storage);
        const rows = list.length ? list.map((p) => h('li.tas-proj',
            h('div.tas-proj-main', h('b', p.name), h('small.pt-muted', ` ${p.trackId}${p.result != null ? ` · ${formatTime(p.result)}` : ''}`)),
            h('button.pt-btn.small', { type: 'button', onclick: async () => { if (await this.okToDiscard()) this.loadData(loadProject(app.storage, p.name)); } }, 'Open'),
            h('button.pt-btn.small.danger', {
                type: 'button', 'aria-label': `Delete ${p.name}`,
                onclick: async () => {
                    if (!(await app.confirm(`Delete the project '${p.name}'?`, { danger: true, ok: 'Delete' }))) return;
                    deleteProject(app.storage, p.name);
                    this.renderProject();
                },
            }, icon('trash')))) : [h('li.pt-muted', 'No saved projects yet.')];

        const B = (label, fn, cls = '') => h(`button.pt-btn.small${cls}`, { type: 'button', onclick: fn }, label);
        this.projectEl.replaceChildren(
            h('div.tas-sec', h('h3', 'This project'),
                h('label.tas-field', h('span', 'Name'), nameIn),
                h('label.tas-field', h('span', 'Notes'), notesIn),
                h('div.pt-row.tas-tight', B('Save', () => this.save(), '.primary'), B('Save as…', () => this.saveAs()))),
            h('div.tas-sec', h('h3', 'New run'),
                h('label.tas-field', h('span', 'Track'), trackSel),
                h('label.tas-field', h('span', 'Start from'), startSel),
                h('div.pt-row.tas-tight', B('Create', create, '.primary'))),
            h('div.tas-sec', h('h3', 'Import / export'),
                h('div.pt-row.tas-tight',
                    B('Import script…', () => this.importScript()),
                    B('Import replay…', () => this.importReplay())),
                h('div.pt-row.tas-tight',
                    B('Export script', () => this.exportScript()),
                    B('Export replay code', () => this.exportReplay()))),
            h('div.tas-sec', h('h3', 'Saved projects'), h('ul.tas-projlist', rows)));
    }

    async okToDiscard() {
        if (!this.dirty) return true;
        return this.app.confirm(`'${this.name}' has unsaved changes. Discard them?`, { ok: 'Discard', danger: true });
    }

    markDirty() {
        if (!this.dirty) {
            this.dirty = true;
            this.updateTitle();
        }
    }

    async importScript() {
        const text = await this.app.prompt('Import a TAS script', {
            message: 'Paste a script (TMInterface-style: "1.20-1.85 press left"). A "# track:" header switches the track.',
            multiline: true, file: '.txt', ok: 'Import',
        });
        if (!text) return;
        const p = parse(text);
        if (p.errors.length) {
            this.toast(`line ${p.errors[0].line}: ${p.errors[0].message}`, { kind: 'bad', ms: 5000 });
            return;
        }
        const id = p.meta.track;
        let track = this.track;
        if (id && id !== this.track.id) {
            const t = this.app.catalog.getTrack(id);
            if (!t) this.toast(`Track '${id}' not found; using ${this.track.id}.`, { kind: 'bad' });
            else track = t;
        }
        if (track === this.track) {
            this.edit(() => this.runner.timeline.copyFrom(p.timeline));
            this.meta = { ...p.meta };
            this._applyingScript = true;
            this.script.setText(text);
            this._applyingScript = false;
            this.toast('Script imported');
        } else {
            if (!(await this.okToDiscard())) return;
            this.setProject({ track, world: buildWorld(track), timeline: p.timeline, name: uniqueName(this.app.storage, p.meta.name || `${track.name} import`), notes: '', slots: [], cursor: 0, script: text, meta: p.meta });
        }
    }

    async importReplay() {
        const text = await this.app.prompt('Import a replay', {
            message: 'Paste a replay code (PTR…) or replay JSON. Its inputs become a new project.',
            multiline: true, file: '.json,.txt', ok: 'Import',
        });
        if (!text) return;
        let data;
        try {
            data = await decodeReplayText(text);
        } catch (e) {
            this.toast(e.message, { kind: 'bad' });
            return;
        }
        const track = data.track || this.app.catalog.getTrack(data.replay.trackId);
        if (!track) {
            this.toast(`The track of that replay (${data.replay.trackId}) is not here.`, { kind: 'bad' });
            return;
        }
        if (!(await this.okToDiscard())) return;
        this.newProject(track, { kind: 'replay', replay: data.replay, name: uniqueName(this.app.storage, `${data.name || track.name} TAS`) });
    }

    exportScript() {
        const text = this.scriptText();
        this.app.showCode('TAS script', text, {
            message: 'Plain text: run it with node tools/tas.mjs run, or import it here.',
            copy: async (c) => this.toast(await copyText(c) ? 'Script copied' : 'Copy failed: select the text and copy it', { icon: 'copy' }),
        });
    }

    makeReplay() {
        const world = buildWorld(this.track);
        return toReplay(this.runner.timeline, world, { laps: this.laps, name: `${this.name}`, date: Date.now() });
    }

    async exportReplay() {
        const rep = this.makeReplay();
        if (!rep.finished) this.toast('This run does not finish; the code still carries it.', { kind: 'bad' });
        const embed = this.app.catalog.isOfficial(this.track.id) ? null : this.track;
        const code = await encodeReplayCodeAsync(rep, embed, { name: this.name, trackName: this.track.name });
        this.app.showCode('Replay code', code, {
            message: 'Paste it in Replays → Import code to watch the run or race its ghost.',
            copy: async (c) => this.toast(await copyText(c) ? 'Code copied' : 'Copy failed: select the text and copy it', { icon: 'copy' }),
        });
    }

    /** Re-simulates on a freshly built world and checks the run as a replay. */
    validate() {
        const t0 = performance.now();
        const world = buildWorld(this.track);
        const rep = toReplay(this.runner.timeline, world, { laps: this.laps, name: this.name });
        const v = verifyReplay(world, rep, { requireFinish: false });
        const ms = performance.now() - t0;
        const res = this.runner.result();
        const same = res.finished === rep.finished && (res.finishTimeMs ?? null) === (rep.timeMs ?? null);
        const ok = v.ok && same;
        this.lastValidation = { ok, finished: rep.finished, timeMs: rep.timeMs, studioMs: res.finishTimeMs, verify: v.ok, reason: v.reason, ms };
        const lines = [
            rep.finished ? `Finish ${formatTime(rep.timeMs, { style: 'long' })} (${rep.ticks} ticks${v.respawns ? `, ${v.respawns} respawns` : ''})` : `Does not finish (ran ${formatTime(rep.ticks * 10)})`,
            same ? 'Matches the studio run exactly.' : `Differs from the studio run (${formatTime(res.finishTimeMs)}).`,
            v.ok ? 'verifyReplay: ok' : `verifyReplay: ${v.reason}`,
            `${ms.toFixed(0)} ms from scratch`,
        ];
        this.app.modal((close) => h('div.pt-col',
            h('h2.pt-subtitle', ok ? (rep.finished ? 'Valid run' : 'Consistent, but no finish') : 'Validation failed'),
            h('ul.tas-validate', lines.map((l, i) => h('li', { class: i < 3 ? (i === 0 ? '' : (i === 1 ? same : v.ok) ? 'good' : 'bad') : 'pt-muted' }, l))),
            h('div.pt-row.pt-modal-actions', h('button.pt-btn.primary', { type: 'button', 'data-autofocus': true, onclick: () => close(true) }, 'OK'))), { label: 'Validation' });
        return this.lastValidation;
    }

    watch() {
        const rep = this.makeReplay();
        memo = { ...this.projectData(), dirty: this.dirty };
        this.app.goto('play', { track: this.track, mode: 'replay', replay: { ...rep, name: tasName(this.name) }, onExit: () => this.app.goto('tas', { resume: true }) });
    }

    saveAsReplay() {
        const rep = this.makeReplay();
        if (!rep.finished) return this.toast('Only finished runs can be saved as replays.', { kind: 'bad' });
        const cat = this.app.catalog;
        const entry = saveReplay(this.app.storage, {
            name: tasName(`${this.name.replace(/\s*\d+:\d\d\.\d\d\b/, '')} ${formatTime(rep.timeMs)}`), trackId: this.track.id, trackName: this.track.name,
            track: cat.isOfficial(this.track.id) ? undefined : this.track, replay: rep, timeMs: rep.timeMs, respawns: rep.respawnTicks.length,
            medal: cat.medalFor(this.track, { timeMs: rep.timeMs, respawns: rep.respawnTicks.length }),
        });
        if (!entry) return this.toast('Storage is full: delete some replays first.', { kind: 'bad' });
        return this.toast('Saved to Replays', { icon: 'save' });
    }

    async leave() {
        if (!(await this.okToDiscard())) return;
        this._forget = true;
        const to = exitTo;
        exitTo = null;
        if (to) to();
        else this.app.goto('menu');
    }

    showKeys() {
        const K = (k, d) => h('tr', h('td', h('span.pt-kbd', k)), h('td', d));
        this.app.modal((close) => h('div.pt-col',
            h('h2.pt-subtitle', 'TAS Studio keys'),
            h('div.tas-keys.pt-scroll', h('table',
                K('Space', 'Play / pause'), K(', .  or  ← →', 'Frame back / forward (Shift: 10 ticks, Ctrl: 1 s)'),
                K('Home / End', 'Start / end'), K('PgUp / PgDn', 'Previous / next checkpoint'),
                K('[ ]', 'Playback speed'), K('1 … 0', 'Load savestate'), K('Shift + 1 … 0', 'Save savestate'),
                K('R', 'Record from the cursor (again to stop)'), K('L', 'Loop the selection'), K('C', 'Next camera'), K('G', 'Ghost on / off'),
                K('D / V', 'Draw / select tool'), K('Shift-drag', 'Select a range'), K('Alt while drawing', 'Steer in 1/8 steps'),
                K('Ctrl+C / X / V', 'Copy / cut / paste over (Ctrl+Shift+V inserts)'), K('Delete', 'Clear selection to neutral'),
                K('Shift+Delete', 'Remove the selected ticks'), K('Insert', 'Insert a tick at the cursor'),
                K('Alt+← →', 'Move the selection a tick'), K('- / =', 'Steer selection left / right'),
                K('Ctrl+Z / Ctrl+Shift+Z', 'Undo / redo'), K('Ctrl+S', 'Save project'), K('Esc', 'Clear selection, stop recording'))),
            h('div.pt-row.pt-modal-actions', h('button.pt-btn.primary', { type: 'button', 'data-autofocus': true, onclick: () => close(true) }, 'Close'))), { label: 'Keys' });
    }

    // ================================================================== timeline / script sync

    get timeline() {
        return this.runner ? this.runner.timeline : EMPTY;
    }

    get cursor() {
        return this.runner ? this.runner.tick : 0;
    }

    get slots() {
        return this.runner ? [...this.runner.slots.values()] : [];
    }

    onEdit(tick) {
        this.markDirty();
        this.roll.dirty = true;
        this._shown = -1;
        if (!this.recording) {
            clearTimeout(this._traceTimer);
            this._traceTimer = setTimeout(() => this.refreshTrace(), 120);
            if (!this._applyingScript) {
                clearTimeout(this._scriptTimer);
                this._scriptTimer = setTimeout(() => this.writeScript(), 160);
            }
        }
        void tick;
    }

    refreshTrace() {
        clearTimeout(this._traceTimer);
        if (!this.runner) return;
        this.trace = this.runner.trace();
        this.markers = markersFromTrace(this.trace);
        this.endTick = this.trace.ticks + (this.trace.finished ? COAST : 0);
        if (this.compare) this.compareResult = this.runner.compare(this.compare);
        if (this.roll.autoFit) this.roll.view.fit(this.roll.total);
        this.roll.dirty = true;
        this._shown = -1;
        this.updateTitle();
        this.renderSplits();
    }

    writeScript(force = false) {
        clearTimeout(this._scriptTimer);
        if (!this.runner || (!force && this.script.focused)) return;
        const text = serialize(this.runner.timeline, { style: this.scriptStyle, meta: this.scriptMeta() });
        this._applyingScript = true;
        this.script.setText(text);
        this._applyingScript = false;
    }

    applyScript(p, text) {
        if (this._applyingScript) return;
        this.meta = { ...p.meta };
        if (p.timeline.equals(this.runner.timeline) && p.timeline.length === this.runner.timeline.length) return;
        this._applyingScript = true;
        try {
            this.edit(() => this.runner.timeline.copyFrom(p.timeline));
        } finally {
            this._applyingScript = false;
        }
        void text;
    }

    /** Runs a timeline edit with an undo point. */
    edit(fn) {
        this.undo.push(this.runner.timeline);
        fn(this.runner.timeline);
    }

    beginEdit() {
        this.undo.push(this.runner.timeline);
    }

    endEdit() {
        this.refreshTrace();
    }

    applyTimeline(tl, label) {
        this.edit((t) => t.copyFrom(tl));
        this.refreshTrace();
        this.writeScript(true);
        this.seek(Math.min(this.cursor, this.endTick));
        if (label) this.toast(label, { kind: 'good' });
    }

    doUndo() {
        if (this.undo.undo(this.runner.timeline)) this.afterHistory();
        else this.toast('Nothing to undo');
    }

    doRedo() {
        if (this.undo.redo(this.runner.timeline)) this.afterHistory();
    }

    afterHistory() {
        this.refreshTrace();
        this.writeScript(true);
        this.syncCar();
    }

    // ================================================================== selection & clipboard

    setSelection(sel) {
        this.selection = sel && sel.to > sel.from ? sel : null;
        setText(this.selInfo, this.selection ? `${formatTick(this.selection.from)}–${formatTick(this.selection.to)} (${this.selection.to - this.selection.from} t)` : '');
        this.roll.dirty = true;
    }

    _sel() {
        if (this.selection) return this.selection;
        this.toast('Select a range first: Shift-drag on the timeline, or use the Select tool.');
        return null;
    }

    copySel() {
        const s = this._sel();
        if (!s) return;
        this.clip = copyRange(this.timeline, s.from, s.to);
        this.toast(`Copied ${this.clip.length} ticks`, { icon: 'copy' });
    }

    cutSel() {
        const s = this._sel();
        if (!s) return;
        this.clip = copyRange(this.timeline, s.from, s.to);
        this.edit((tl) => clearRange(tl, s.from, s.to));
        this.endEdit();
    }

    paste(insert) {
        if (!this.clip) return this.toast('Nothing copied yet');
        const at = this.selection ? this.selection.from : this.cursor;
        this.edit((tl) => pasteClip(tl, at, this.clip, { insert }));
        this.setSelection({ from: at, to: at + this.clip.length });
        this.endEdit();
        return undefined;
    }

    clearSel() {
        const s = this._sel();
        if (!s) return;
        this.edit((tl) => clearRange(tl, s.from, s.to));
        this.endEdit();
    }

    removeSel() {
        const s = this._sel();
        if (!s) return;
        this.edit((tl) => removeRange(tl, s.from, s.to));
        this.setSelection(null);
        this.endEdit();
    }

    insertTick() {
        const at = this.selection ? this.selection.from : this.cursor;
        const n = this.selection ? this.selection.to - this.selection.from : 1;
        this.edit((tl) => tl.insertTicks(at, n));
        this.endEdit();
    }

    shiftSel(d) {
        const s = this._sel();
        if (!s) return;
        let next;
        this.edit((tl) => { next = shiftRange(tl, s.from, s.to, d); });
        this.setSelection(next);
        this.endEdit();
    }

    nudgeSel(d) {
        const s = this._sel();
        if (!s) return;
        this.edit((tl) => nudgeRange(tl, s.from, s.to, d));
        this.endEdit();
    }

    setTool(t) {
        this.tool = t;
        for (const k of Object.keys(this.toolBtns)) toggleClass(this.toolBtns[k], 'active', k === t);
        toggleClass(this.rollHost, 'select', t === 'select');
    }

    // ================================================================== transport

    startLoop() {
        this.app.loop.timeScale = this.speed;
        this.app.loop.start(() => this.tick(), (a, dt) => this.frame(a, dt));
        this.syncButtons();
    }

    seek(tick) {
        if (!this.runner) return;
        const t = Math.max(0, Math.min(Math.round(tick), Math.max(this.endTick, 0)));
        this.runner.seek(t);
        this.syncCar();
    }

    syncCar() {
        const sim = this.runner.sim;
        snapshotCar(sim.car, this.cur);
        snapshotCar(sim.car, this.prev);
        this.app.loop.resync();
        this._shown = -1;
        this.roll.dirty = true;
    }

    scrubbing(on) {
        this._scrubbing = on;
        if (on) this.pause();
    }

    togglePlay() {
        if (this.playing) this.pause();
        else this.play();
    }

    play() {
        if (this.recording) return;
        if (this.cursor >= this.endTick) this.seek(this.loop.on ? this.loop.from : 0);
        this.playing = true;
        this.roll.follow = true;
        this.app.loop.resync();
        this.syncButtons();
    }

    pause() {
        if (!this.playing) return;
        this.playing = false;
        this.app.audio.stopCar();
        this.syncButtons();
    }

    frameStep(n) {
        this.pause();
        if (n > 0) {
            this.prevSwap();
            this.runner.step(Math.min(n, Math.max(0, this.endTick - this.cursor)), (sim) => this.events(sim));
            snapshotCar(this.runner.sim.car, this.cur);
            snapshotCar(this.runner.sim.car, this.prev);
            this._shown = -1;
            this.roll.dirty = true;
        } else this.seek(this.cursor + n);
        this.roll.follow = true;
        this.roll.followCursor();
    }

    prevSwap() {
        const t = this.prev;
        this.prev = this.cur;
        this.cur = t;
    }

    jumpStart() { this.pause(); this.seek(0); this.roll.follow = true; this.roll.followCursor(); }

    jumpEnd() {
        this.pause();
        this.seek(this.trace && this.trace.finished ? this.trace.ticks : this.endTick);
        this.roll.follow = true;
        this.roll.followCursor();
    }

    jumpMarker(dir) {
        const t = nextMarkerTick(this.markers, this.cursor, dir);
        if (t === null) return this.toast(dir > 0 ? 'No checkpoint ahead' : 'No checkpoint behind');
        this.pause();
        this.seek(t);
        this.roll.follow = true;
        this.roll.followCursor();
        return undefined;
    }

    setSpeed(s) {
        this.speed = s;
        if (!this.recording) this.app.loop.timeScale = s;
        this.syncButtons();
    }

    toggleLoop() {
        if (this.loop.on) this.loop.on = false;
        else {
            const s = this.selection;
            if (s) this.loop = { from: s.from, to: s.to, on: true };
            else if (this.loop.to > this.loop.from) this.loop.on = true;
            else return this.toast('Select the range to loop first (Shift-drag on the timeline).');
        }
        this.roll.dirty = true;
        this.syncButtons();
        return undefined;
    }

    setCamera(i) {
        this.cam = (i + CAMERAS.length) % CAMERAS.length;
        if (this.car) this.app.renderer.setCameraMode(CAMERAS[this.cam].id, this.car);
        if (this.camSel) this.camSel.value = String(this.cam);
    }

    syncButtons() {
        this.playBtn.innerHTML = iconSvg(this.playing ? 'pause' : 'play', 18);
        this.speedSel.value = String(this.speed);
        toggleClass(this.loopBtn, 'active', this.loop.on);
        toggleClass(this.recBtn, 'active', this.recording);
        toggleClass(this.el, 'recording', this.recording);
    }

    // ================================================================== savestates

    saveSlot(name) {
        const s = this.runner.save(name);
        this.roll.dirty = true;
        this.toast(`Savestate ${name} at ${tickTime(s.tick)}`, { icon: 'save', ms: 1400 });
    }

    loadSlot(name) {
        if (!this.runner.slots.has(name)) return this.toast(`Savestate ${name} is empty (Shift+${name} saves)`);
        this.pause();
        const r = this.runner.load(name);
        this.syncCar();
        this.roll.follow = true;
        this.roll.followCursor();
        this.toast(`Loaded ${name} at ${tickTime(r.tick)}${r.stale ? ' (inputs before it changed: re-simulated)' : ''}`, { ms: 1600 });
        return undefined;
    }

    // ================================================================== record mode

    toggleRecord() {
        if (this.recording) this.stopRecording();
        else this.startRecording();
    }

    startRecording() {
        if (!this.runner) return;
        this.pause();
        this.undo.push(this.timeline);
        this.runner.startRecording({ truncate: false });
        this.recording = true;
        this.respawnQueued = false;
        this.countdown = 1.2;   // seconds of real time to get hands on the keys
        this.app.controls.setActive(true);
        this.app.controls.clearEdges();
        this.app.loop.timeScale = this.recordOpts.speed;
        this.banner('Recording in 3…');
        this.syncButtons();
    }

    stopRecording(silent = false) {
        if (!this.recording) return;
        this.recording = false;
        this.countdown = 0;
        this.runner.stopRecording();
        if (this.recordOpts.onStop === 'cut') this.timeline.truncate(this.cursor);
        this.app.controls.setActive(false);
        this.app.loop.timeScale = this.speed;
        this.app.audio.stopCar();
        this.banner(null);
        this.refreshTrace();
        this.writeScript(true);
        this.syncButtons();
        if (!silent) this.toast(`Recorded up to ${tickTime(this.cursor)}${this.recordOpts.onStop === 'cut' ? ', the rest cut' : ''}`);
    }

    banner(text) {
        toggleClass(this.bannerEl, 'pt-hidden', !text);
        if (text) setText(this.bannerEl, text);
    }

    // ================================================================== per tick / frame

    tick() {
        if (!this.runner || this.countdown > 0) return;
        if (this.recording) {
            const inp = this.app.controls.input(this._inp);
            if (this.respawnQueued) { inp.respawn = true; this.respawnQueued = false; }
            if (this.cursor >= 360000 - 1) return this.stopRecording();
            this.prevSwap();
            this.runner.stepLive(inp);
            snapshotCar(this.runner.sim.car, this.cur);
            this.events(this.runner.sim);
            return undefined;
        }
        if (!this.playing || this._scrubbing) return undefined;
        const cur = this.cursor;
        if (this.loop.on && (cur >= this.loop.to || cur < this.loop.from)) {
            this.seek(this.loop.from);
            return undefined;
        }
        if (cur >= this.endTick) {
            this.pause();
            return undefined;
        }
        this.prevSwap();
        this.runner.step(1, (sim) => this.events(sim));
        snapshotCar(this.runner.sim.car, this.cur);
        return undefined;
    }

    events(sim) {
        const ev = sim.events;
        if (!ev.length) return;
        for (const e of ev) {
            if (e.type === 'respawn') snapshotCar(sim.car, this.prev);
            else if (e.type === 'fall' && this.recording) this.respawnQueued = true;
        }
        this.app.renderer.handleEvents(ev, this.car);
        const s = this.recording ? this.recordOpts.speed : this.speed;
        if (s >= 0.5 && s <= 2) this.app.audio.handleEvents(ev);
    }

    frame(alpha, dt) {
        if (!this.runner) return;
        if (this.countdown > 0) {
            this.countdown -= dt;
            if (this.countdown <= 0) {
                this.banner('● REC');
                this.app.loop.resync();
            } else this.banner(`Recording in ${Math.ceil(this.countdown / 0.4)}…`);
        }
        const moving = (this.playing && !this._scrubbing) || (this.recording && this.countdown <= 0);
        const a = moving ? alpha : 1;
        lerpCarSnapshot(this.prev, this.cur, a, this.view);
        this.car.setPose(this.prev, this.cur, a);
        if (this.ghost && this.ghostCar) {
            const gt = Math.max(0, this.cursor - 1 + a);
            this.ghostCar.setPose(this.ghost.viewAt(gt));
        }
        const s = this.recording ? this.recordOpts.speed : this.speed;
        if (moving) this.app.audio.updateCar(this.view, dt * s);
        this.app.renderer.render(dt);

        const t = this.cursor;
        if (t !== this._shown) {
            this._shown = t;
            this.updateInfo();
            this.script.setCursorTick(t);
            if (document.activeElement !== this.timeInput) this.timeInput.value = formatTick(t);
            this.roll.dirty = true;
            if (moving) this.roll.followCursor();
        }
        this.roll.draw();
    }

    updateInfo() {
        const sim = this.runner.sim, car = sim.car, I = this.info;
        const rot = quatToEuler(car.quat);
        setText(I.tick, `${sim.tick}${this.trace ? ` / ${this.trace.ticks}` : ''}`);
        setText(I.time, tickTime(sim.timeMs / 10));
        setText(I.speed, `${car.speedKmh.toFixed(3)} km/h`);
        setText(I.pos, `${fmtNum(car.pos[0])} ${fmtNum(car.pos[1])} ${fmtNum(car.pos[2])}`);
        setText(I.vel, `${fmtNum(car.vel[0])} ${fmtNum(car.vel[1])} ${fmtNum(car.vel[2])}`);
        setText(I.rot, `${fmtNum(rot.yaw, 2)}° ${fmtNum(rot.pitch, 2)}° ${fmtNum(rot.roll, 2)}°`);
        const wheels = car.wheels.filter((w) => w.contact).length;
        setText(I.surface, `${car.surfaceUnder ? SURFACE_LABELS[car.surfaceUnder] || car.surfaceUnder : 'air'} · ${wheels}/4 wheels`);
        const st = [];
        if (car.airborne) st.push('airborne');
        if (car.drifting) st.push('drifting');
        if (sim.finished) st.push('finished');
        st.push(`gear ${car.gear}`, `CP ${sim.collectedCount}/${sim.checkpointCount}`);
        if (sim.laps > 1) st.push(`lap ${Math.min(sim.lap + 1, sim.laps)}/${sim.laps}`);
        setText(I.state, st.join(' · '));
        const eff = describeEffects(car.effects);
        setText(I.effects, eff.length ? eff.join(', ') : '—');
        const inp = this.timeline.get(sim.tick);
        setText(I.input, `steer ${inp.steer} ${inp.gas ? 'GAS' : '—'} ${inp.brake ? 'BRK' : '—'}${inp.respawn ? ' RESP' : ''}`);
        this.renderSplits();
    }

    renderSplits() {
        if (!this.trace || !this.splitsEl) return;
        const tr = this.trace, cmp = this.compareResult, t = this.cursor;
        const cpTicks = this.markers.filter((m) => m.kind === 'checkpoint');
        const rows = tr.checkpointTimes.map((ms, i) => {
            const d = cmp && cmp.splits[i] && cmp.splits[i].delta != null ? -cmp.splits[i].delta : null;
            const passed = cpTicks[i] && t >= cpTicks[i].tick;
            return h('tr', { class: passed ? 'passed' : '' }, h('td', `CP ${i + 1}`), h('td.pt-mono', formatTime(ms)),
                h('td.pt-mono', { class: d == null ? '' : d < 0 ? 'ahead' : d > 0 ? 'behind' : '' }, d == null ? '' : formatTime(d, { style: 'short', sign: true })));
        });
        const fd = cmp && cmp.finishDelta != null ? -cmp.finishDelta : null;
        rows.push(h('tr.fin', { class: tr.finished && t >= tr.ticks ? 'passed' : '' }, h('td', 'Finish'), h('td.pt-mono', tr.finished ? formatTime(tr.finishTimeMs, { style: 'long' }) : 'DNF'),
            h('td.pt-mono', { class: fd == null ? '' : fd < 0 ? 'ahead' : fd > 0 ? 'behind' : '' }, fd == null ? '' : formatTime(fd, { style: 'short', sign: true }))));
        const head = this.compare ? h('div.tas-splits-head.pt-muted', `vs ${this.compareLabel}`) : null;
        this.splitsEl.replaceChildren(...[head, h('table', rows)].filter(Boolean));
    }

    carPos() {
        return this.runner.sim.car.pos.slice();
    }

    // ================================================================== ghost

    fillGhostChoices() {
        const opts = [['none', 'ghost: off'], ['start', 'ghost: session start']];
        if (this.app.catalog.isOfficial(this.track.id) && this.app.catalog.authorReplay(this.track.id)) opts.push(['emperor', 'ghost: Emperor']);
        const rec = allRecords(this.app.storage)[this.track.id];
        if (rec && rec.replay && rec.trackHash === this.world.hash) opts.push(['pb', 'ghost: personal best']);
        if (loadProject(this.app.storage, this.name)) opts.push(['saved', 'ghost: last save']);
        this.ghostSel.replaceChildren(...opts.map(([v, l]) => h('option', { value: v }, l)));
        this.sessionStart = this.timeline.clone();
        this.ghostSel.value = 'none';
    }

    pickGhost(v) {
        const cat = this.app.catalog;
        let tl = null, label = '';
        try {
            if (v === 'start') { tl = this.sessionStart; label = 'start of session'; }
            else if (v === 'emperor') { tl = fromReplay(cat.authorReplay(this.track.id)); label = 'Emperor'; }
            else if (v === 'pb') { tl = fromReplay(allRecords(this.app.storage)[this.track.id].replay); label = 'personal best'; }
            else if (v === 'saved') { tl = parse(loadProject(this.app.storage, this.name).script).timeline; label = 'last save'; }
        } catch (e) {
            this.toast(`That ghost can't be loaded: ${e.message}`, { kind: 'bad' });
        }
        this.setCompare(tl, label, false);
    }

    /** Comparison run: a ghost car, a faint steer line on the roll and split deltas. */
    setCompare(tl, label, announce = true) {
        this.compare = tl;
        this.compareLabel = label || 'ghost';
        this.compareResult = tl ? this.runner.compare(tl) : null;
        this.setGhost(tl);
        if (!tl) this.ghostSel.value = 'none';
        else if (announce) {
            if (![...this.ghostSel.options].some((o) => o.value === 'custom')) this.ghostSel.appendChild(h('option', { value: 'custom' }, `ghost: ${label}`));
            this.ghostSel.value = 'custom';
            this.ghostSel.querySelector('option[value=custom]').textContent = `ghost: ${label}`;
        }
        this.roll.dirty = true;
        this.renderSplits();
    }

    setGhost(tl) {
        const rnd = this.app.renderer;
        if (this.ghostCar) rnd.removeCar(this.ghostCar);
        this.ghostCar = null;
        this.ghost = null;
        if (!tl) return;
        try {
            this.ghost = new GhostRun(this.world, { inputs: tl.encode(Math.max(1, tl.length)), laps: this.laps }, { label: this.compareLabel });
            this.ghostCar = rnd.addCar({ kind: 'ghost', label: this.compareLabel });
        } catch (e) {
            this.ghost = null;
        }
    }

    // ================================================================== keys

    onKey(e) {
        if (e.defaultPrevented || modalOpen() || this.disposed) return;
        const t = e.target;
        const typing = t && (t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || (t.tagName === 'INPUT' && !['range', 'checkbox', 'button'].includes(t.type)));
        if (typing) return;
        const ctrl = e.ctrlKey || e.metaKey;
        const k = e.key;
        const slot = slotFromCode(e.code);
        let handled = true;
        if (this.recording) {
            if (k === 'Escape' || (k.toLowerCase() === 'r' && !ctrl)) this.stopRecording();
            else handled = false;   // driving keys belong to app.controls
            if (handled) e.preventDefault();
            return;
        }
        const freeCam = CAMERAS[this.cam].id === 'free';
        if (ctrl) {
            switch (k.toLowerCase()) {
                case 'z': if (e.shiftKey) this.doRedo(); else this.doUndo(); break;
                case 'y': this.doRedo(); break;
                case 'c': this.copySel(); break;
                case 'x': this.cutSel(); break;
                case 'v': this.paste(e.shiftKey); break;
                case 's': this.save(); break;
                case 'a': this.setSelection({ from: 0, to: Math.max(1, this.timeline.length) }); break;
                case 'arrowleft': this.frameStep(-100); break;
                case 'arrowright': this.frameStep(100); break;
                default: handled = false;
            }
        } else if (slot !== null && !e.altKey) {
            if (e.shiftKey) this.saveSlot(slot); else this.loadSlot(slot);
        } else {
            switch (k) {
                case ' ': this.togglePlay(); break;
                case '.': case '>': this.frameStep(e.shiftKey ? 10 : 1); break;
                case ',': case '<': this.frameStep(e.shiftKey ? -10 : -1); break;
                case 'ArrowRight':
                    if (freeCam) { handled = false; break; }
                    if (e.altKey) this.shiftSel(e.shiftKey ? 10 : 1); else this.frameStep(e.shiftKey ? 10 : 1);
                    break;
                case 'ArrowLeft':
                    if (freeCam) { handled = false; break; }
                    if (e.altKey) this.shiftSel(e.shiftKey ? -10 : -1); else this.frameStep(e.shiftKey ? -10 : -1);
                    break;
                case 'Home': this.jumpStart(); break;
                case 'End': this.jumpEnd(); break;
                case 'PageDown': this.jumpMarker(1); break;
                case 'PageUp': this.jumpMarker(-1); break;
                case '[': this.setSpeed(stepSpeed(this.speed, -1)); break;
                case ']': this.setSpeed(stepSpeed(this.speed, 1)); break;
                case 'Delete': case 'Backspace': if (e.shiftKey) this.removeSel(); else this.clearSel(); break;
                case 'Insert': this.insertTick(); break;
                case '-': case '_': this.nudgeSel(e.shiftKey ? -8192 : -1024); break;
                case '=': case '+': this.nudgeSel(e.shiftKey ? 8192 : 1024); break;
                case 'Escape': if (this.selection) this.setSelection(null); else this.leave(); break;
                case '?': this.showKeys(); break;
                default:
                    switch (k.toLowerCase()) {
                        case 'r': this.startRecording(); break;
                        case 'l': this.toggleLoop(); break;
                        case 'c': if (freeCam) handled = false; else this.setCamera(this.cam + 1); break;
                        case 'g': this.pickGhost(this.ghost ? 'none' : 'start'); this.ghostSel.value = this.ghost ? 'start' : 'none'; break;
                        case 'd': if (freeCam) handled = false; else this.setTool('draw'); break;
                        case 'v': this.setTool('select'); break;
                        default: handled = false;
                    }
            }
        }
        if (handled) e.preventDefault();
    }

    // ================================================================== teardown

    dispose() {
        if (this.disposed) return;
        if (this._forget) memo = null;
        else if (this.runner && this.track) memo = { ...this.projectData(), dirty: this.dirty };
        this.disposed = true;
        this.stopRecording(true);
        clearTimeout(this._scriptTimer);
        clearTimeout(this._traceTimer);
        for (const off of this._offs) off();
        if (this._ro) this._ro.disconnect();
        if (this.bf) this.bf.dispose();
        if (this.script) this.script.dispose();
        if (this.roll) this.roll.dispose();
        if (this._offEdit) this._offEdit();
        if (this.runner) this.runner.dispose();
        const app = this.app, rnd = app.renderer;
        app.loop.stop();
        app.loop.timeScale = 1;
        app.controls.setActive(false);
        app.audio.stopCar();
        if (this.car) rnd.removeCar(this.car);
        if (this.ghostCar) rnd.removeCar(this.ghostCar);
        rnd.setViewports(null);
        if (this.el) this.el.remove();
    }
}

const studio = {
    id: 'tas',
    studio: null,

    async enter(app, params = {}) {
        await loadModuleCss('tas');
        app.setMusic(false);
        this.studio = new Studio(app);
        await this.studio.open(params || {});
    },

    exit() {
        if (this.studio) this.studio.dispose();
        this.studio = null;
    },

    // Gamepad B / shell back: same as the Back button (asks about unsaved changes).
    back() {
        if (this.studio) this.studio.leave();
    },
};

export default studio;
