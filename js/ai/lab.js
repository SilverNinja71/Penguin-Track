// AI Lab screen: pick a track and settings, train a flock of penguin drivers
// with neuroevolution in Web Workers, watch each generation drive in the 3D
// view (what the followed car senses drawn as rays), chart the progress, keep
// models in storage 'ai', race them, watch them, or open them in TAS Studio.
// Pure parts live in lab-logic.js / lab-playback.js (Node-tested).
import { h, append, setText, toggleClass, isTypingTarget, loadModuleCss } from '../game/dom.js';
import { icon, iconSvg } from '../game/icons.js';
import { modalOpen } from '../game/ui.js';
import { decodeReplayText } from '../game/replaycode.js';
import { submitBoardRun } from '../game/records.js';
import { verifyReplay } from '../core/replay.js';
import { buildWorld } from '../core/track.js';
import { getSamples } from '../core/samples.js';
import { formatTime } from '../core/format.js';
import { trackHash, decodeTrack } from '../core/codec.js';
import { ACTIONS } from '../core/input.js';
import { NeuroTrainer } from './neuro.js';
import { createWorkerPool } from './pool.js';
import { loadModelFile } from './policy.js';
import * as L from './lab-logic.js';
import { FieldPlayback } from './lab-playback.js';
import { drawChart } from './lab-chart.js';
import { PolicyOverlay } from './lab-overlay.js';
import { openHowItWorks } from './lab-help.js';
import { FREE_AI, aiWorkerCap, aiGoalCap, atFreeLimit, requireProAI, mountAiProLock } from './lab-pro.js';

const CAMS = [
    { id: 'chase', label: 'Chase' },
    { id: 'orbit', label: 'Orbit' },
    { id: 'top', label: 'Top' },
];
const SPEEDS = [0.5, 1, 2, 4];
const CAPS = [8, 16, 32];
const MAX_WORKERS = 16;

// Survives leaving the screen (racing the AI, TAS Studio) so the Lab comes
// back as it was: the trainer object itself stays in memory, paused.
const memo = {
    settings: L.presetSettings('quick'),
    trackRef: 'T01',
    run: null,        // { trainer, rc, track, goal, trainMs, best, lastStats, pending, state }
    driver: null,     // { kind: 'training'|'model'|'run', name, replay, track, file?, model?, stored? }
    view: { cam: 0, rays: true, cap: 32, speed: 1 },
    tab: 'train',
    startFrom: false,
};


const pct = (x) => `${Math.round((x || 0) * 100)}%`;
const fmtFit = (x) => (Number.isFinite(x) ? x.toFixed(2) : '–');
const fmtSecs = (ms) => {
    const s = Math.round(ms / 1000);
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
};

class Lab {
    constructor(app, params) {
        this.app = app;
        this.params = params || {};
        this.r = app.renderer;
        this.live = !this.r.isNull;
        this.pool = null;
        this.runToken = 0;
        this.state = 'idle';
        this.field = null;
        this.fieldMeta = null;
        this.cars = [];
        this.labelled = null;
        this.bestLabelled = false;
        this.focusId = 0;
        this.overlay = null;
        this.hudAt = 0;
        this.disposed = false;
        this.listeners = [];
    }

    // ------------------------------------------------------------ lifecycle

    async start() {
        loadModuleCss('ai');
        const app = this.app;
        app.audio.stopCar();
        this.build();
        if (this.live) this.overlay = new PolicyOverlay(this.r);
        if (this.overlay) this.overlay.setVisible(memo.view.rays);

        const wasRunning = memo.run && memo.run.state === 'paused' && memo.run.awayPaused;
        const ref = this.params.track || (memo.run ? memo.run.track : memo.trackRef);
        if (!this.setTrack(ref, { quiet: true }) && !this.setTrack('T01', { quiet: true })) this.setTrack(getSamples()[0].id);
        if (memo.run) {
            this.state = memo.run.state;
            this.renderChart();
            this.renderStats(memo.run.lastStats);
            if (memo.run.pending) this.showGeneration(memo.run.pending);
        }
        if (memo.driver) {
            this.renderDriver();
            if (!this.field && memo.driver.replay) this.showDriver();
        }
        this.syncControls();
        if (wasRunning) {
            memo.run.awayPaused = false;
            app.toast('Training paused while you were away. Press Resume to carry on.', { icon: 'pause', ms: 3600 });
        }

        app.loop.timeScale = memo.view.speed;
        app.loop.start(() => this.tick(), (a, dt) => this.frame(a, dt));
        this.on(window, 'keydown', (e) => this.onKey(e));
        this.on(window, 'resize', () => this.renderChart());
        // The chart's box can change after the first draw (fonts, panel scrollbar): redraw at its real size.
        if (typeof ResizeObserver === 'function' && this.ui && this.ui.chart) {
            const ro = new ResizeObserver(() => this.renderChart());
            ro.observe(this.ui.chart);
            this.listeners.push(() => ro.disconnect());
        }
        requestAnimationFrame(() => {
            if (!this.disposed) this.el.querySelector('[data-autofocus]')?.focus({ preventScroll: true });
        });
    }

    on(target, type, fn) {
        target.addEventListener(type, fn);
        this.listeners.push(() => target.removeEventListener(type, fn));
    }

    dispose() {
        this.disposed = true;
        for (const off of this.listeners) off();
        this.listeners = [];
        if (this.state === 'training' || this.state === 'starting' || this.state === 'pausing') {
            this.abortGeneration();
            memo.run.state = 'paused';
            memo.run.awayPaused = true;
        }
        this.closePool();
        this.app.loop.stop();
        this.clearCars();
        if (this.overlay) this.overlay.dispose();
        this.overlay = null;
        this.field = null;
    }

    // ------------------------------------------------------------ DOM

    build() {
        const app = this.app;
        const btn = (cls, label, iconName, onclick, extra = {}) => h(`button.pt-btn${cls}`, { type: 'button', onclick, ...extra },
            iconName ? h('span.pt-ico', { html: iconSvg(iconName, 18) }) : null, label);
        this.ui = {};
        const u = this.ui;

        // Top bar
        u.status = h('span.ai-status', 'Idle');
        u.gen = h('span.ai-gen.pt-mono', '–');
        const top = h('header.ai-top.pt-panel',
            btn('.small.ghost', 'Menu', 'back', () => this.back(), { 'data-sound': 'back', title: 'Back to the menu (Esc)' }),
            h('div.ai-brand', h('span.pt-ico', { html: iconSvg('brain', 24) }), h('h1', 'AI Lab')),
            h('div.ai-top-gen', h('span.pt-muted', 'Generation'), u.gen),
            u.status,
            h('div.pt-spacer'),
            btn('.small', 'How it works', 'help', () => openHowItWorks(app), { title: 'How it works (H)' }));

        // Left: train / drivers tabs
        u.tabTrain = h('button.ai-tab', { type: 'button', role: 'tab', onclick: () => this.setTab('train') }, 'Train');
        u.tabDrivers = h('button.ai-tab', { type: 'button', role: 'tab', onclick: () => this.setTab('drivers') }, 'Drivers');
        u.trainPane = this.buildTrainPane(btn);
        u.driversPane = this.buildDriversPane(btn);
        const left = h('aside.ai-left.pt-panel',
            h('div.ai-tabs', { role: 'tablist' }, u.tabTrain, u.tabDrivers),
            h('div.ai-pane.pt-scroll', u.trainPane, u.driversPane),
            // Train / pause / stop stay in reach whatever the tab or scroll position.
            h('div.ai-left-foot', u.trainBtn, u.stopBtn));

        // Right: progress + driver card
        u.chart = h('canvas.ai-chart', { role: 'img', 'aria-label': 'Training curve' });
        u.stats = {};
        const stat = (key, label) => h('div.ai-stat', h('span.pt-muted', label), u.stats[key] = h('b.pt-mono', '–'));
        u.driverCard = h('div.ai-driver');
        const right = h('aside.ai-right.pt-panel.pt-scroll',
            h('h2.ai-h', 'Progress'),
            h('div.ai-stats',
                stat('best', 'Best score'), stat('time', 'Best time'), stat('finish', 'Finished'),
                stat('mean', 'Average'), stat('speed', 'Runs / s'), stat('elapsed', 'Training')),
            u.chart,
            h('div.ai-legend',
                h('span.k-best', 'best score'), h('span.k-mean', 'average'), h('span.k-time', 'fastest finish'), h('span.k-fin', 'finish rate')),
            h('h2.ai-h', 'Driver'),
            u.driverCard);

        // Bottom: live view controls + what the followed car does
        u.camBtns = CAMS.map((c, i) => h('button.pt-btn.small', { type: 'button', onclick: () => this.setCam(i) }, c.label));
        u.speedBtn = h('button.pt-btn.small', { type: 'button', title: 'Playback speed (- / +)', onclick: () => this.cycleSpeed(1) }, '1×');
        u.capSel = h('select.pt-input.ai-cap', { 'aria-label': 'Cars shown', onchange: () => this.setCap(Number(u.capSel.value)) },
            CAPS.map((n) => h('option', { value: String(n) }, `${n} cars`)));
        u.raysBtn = h('button.pt-btn.small', { type: 'button', 'aria-pressed': 'true', title: 'Sensor rays (R)', onclick: () => this.toggleRays() }, 'Rays');
        u.fieldInfo = h('span.ai-field-info');
        u.latestBtn = btn('.small.pt-hidden', 'Latest', 'forward', () => this.jumpLatest(), { title: 'Jump to the newest generation' });
        const viewBar = h('div.ai-viewbar',
            h('div.ai-seg', { role: 'group', 'aria-label': 'Camera' }, u.camBtns),
            btn('.small', '', 'back', () => this.cycleFocus(-1), { title: 'Previous car ([)', 'aria-label': 'Previous car' }),
            btn('.small', 'Best', 'trophy', () => this.focusBest(), { title: 'Follow the best (B)' }),
            btn('.small', '', 'next', () => this.cycleFocus(1), { title: 'Next car (])', 'aria-label': 'Next car' }),
            u.speedBtn, u.capSel, u.raysBtn, u.latestBtn, u.fieldInfo);
        u.policy = this.buildPolicyHud();
        u.empty = h('div.ai-empty.pt-panel',
            h('span.pt-ico', { html: iconSvg('penguin', 34) }),
            h('p', 'Press ', h('b', 'Train'), ' to hatch a flock of penguin drivers, or load the demo driver from the ', h('b', 'Drivers'), ' tab.'));
        const bottom = h('section.ai-bottom', u.empty, u.policy, h('div.pt-panel.ai-viewpanel', viewBar));

        this.el = h('div.pt-screen.ai-lab', top, left, h('div.ai-center'), right, bottom);
        app.ui.appendChild(this.el);
        u.capSel.value = String(memo.view.cap);
        this.setTab(memo.tab);
        this.syncView();
        this.renderModels();
        this.renderDriver();
        this.renderStats(null);
        this.renderChart();
    }

    buildTrainPane(btn) {
        const u = this.ui;
        const s = memo.settings;
        // Track picker: training grounds first, then the campaign, samples, the player's own.
        u.trackSel = h('select.pt-input', { id: 'ai-track', onchange: () => this.onTrackPick() });
        this.fillTracks();

        u.presetBtns = L.PRESET_IDS.map((id) => h('button.pt-btn.small', {
            type: 'button', title: L.PRESETS[id].blurb, onclick: () => this.applyPreset(id),
        }, L.PRESETS[id].label));
        u.presetBlurb = h('p.ai-blurb.pt-muted');

        const field = (label, input, hint) => h('label.pt-field', h('span', label, hint ? h('small', ` ${hint}`) : null), input);
        const numIn = (key, min, max, step = 1) => {
            const el = h('input', { type: 'number', min, max, step, value: s[key] });
            el.addEventListener('change', () => this.readSettings());
            u.inputs[key] = el;
            return el;
        };
        const sel = (key, opts) => {
            const el = h('select', { onchange: () => this.readSettings() }, opts.map(([v, t]) => h('option', { value: String(v) }, t)));
            el.value = String(s[key]);
            u.inputs[key] = el;
            return el;
        };
        u.inputs = {};
        u.algoGa = h('button.pt-btn.small', { type: 'button', onclick: () => this.setAlgo('ga'), title: 'Genetic algorithm: keep the best, breed and mutate' }, 'GA');
        u.algoEs = h('button.pt-btn.small', { type: 'button', onclick: () => this.setAlgo('es'), title: 'Evolution strategies: follow the average of the good variations' }, 'ES');
        u.mutField = field('Mutation', numIn('mutation', 0.001, 0.5, 0.005), 'std');
        u.sigmaField = field('Noise σ', numIn('sigma', 0.001, 0.5, 0.005));
        u.lrField = field('Step size', numIn('lr', 0.0001, 0.5, 0.005));
        u.startFrom = h('input', { type: 'checkbox', onchange: () => { memo.startFrom = u.startFrom.checked; this.syncControls(); } });
        u.startFromRow = h('label.ai-check.pt-hidden', u.startFrom, h('span', 'Start from the loaded driver’s brain'));

        u.settingsBox = h('fieldset.ai-settings',
            h('legend.pt-hidden', 'Training settings'),
            h('div.ai-seg', { role: 'group', 'aria-label': 'Algorithm' }, u.algoGa, u.algoEs),
            h('div.ai-grid2',
                field('Population', numIn('popSize', 4, 512)),
                field('Hidden layers', sel('hidden', L.HIDDEN_OPTIONS.map((o) => [o, o.replace(/,/g, ' × ')])))),
            h('div.ai-grid2', u.mutField, u.sigmaField, u.lrField),
            h('div.ai-grid2',
                field('Frame skip', numIn('frameSkip', 1, 20), 'ticks'),
                field('Episode', sel('maxSeconds', [['auto', 'Auto'], [30, '30 s'], [45, '45 s'], [60, '60 s'], [90, '90 s'], [120, '120 s'], [180, '180 s']]))),
            h('details.ai-more',
                h('summary', 'Sensors and actions'),
                h('div.ai-grid2',
                    field('Edge rays', sel('edgeRays', [[0, 'None'], [5, '5'], [9, '9'], [15, '15'], [21, '21'], [31, '31']])),
                    field('Ray fan', sel('fov', [[120, '120°'], [180, '180°'], [240, '240°']])),
                    field('Look ahead', sel('lookahead', [['near', 'Near (3)'], ['standard', 'Standard (4)'], ['far', 'Far (5)']])),
                    field('Wall rays', sel('wallRays', [[0, 'Off'], [5, '5'], [9, '9']]), 'slower'),
                    field('Actions', sel('action', [['discrete', '9 buttons'], ['continuous', 'Analog']])),
                    field('Start', sel('startMode', [['start', 'Start line'], ['random-checkpoint', 'Any checkpoint'], ['random', 'Anywhere']])))),
            h('div.ai-grid2',
                field('Generations', numIn('generations', 0, 100000), '0 = ∞'),
                field('Seed', numIn('seed', 0, 2147483647))),
            u.startFromRow);

        u.trainBtn = btn('.primary', 'Train', 'play', () => this.primary(), { 'data-autofocus': true, title: 'Train / pause / resume (Space)' });
        u.stopBtn = btn('', 'Stop', 'close', () => this.secondary());
        u.workersNote = h('p.ai-note.pt-muted');
        this.listeners.push(mountAiProLock(this.app, u.inputs, u.settingsBox, () => this.updateWorkersNote()));
        return h('div.ai-train',
            h('label.pt-field', h('span', 'Track'), u.trackSel),
            h('div.pt-field', h('span', 'Preset'), h('div.ai-seg', { role: 'group', 'aria-label': 'Preset' }, u.presetBtns)),
            u.presetBlurb,
            u.settingsBox,
            u.workersNote);
    }

    buildDriversPane(btn) {
        const u = this.ui;
        u.modelList = h('div.ai-models');
        return h('div.ai-drivers',
            h('div.ai-actions',
                btn('.small', 'Demo driver', 'penguin', () => this.loadDemo(), { title: 'Load models/demo-S01.json' }),
                btn('.small', 'Import', 'import', () => this.importDriver())),
            h('p.ai-note.pt-muted', 'Saved drivers live in this browser. Model files from tools/train.mjs, the Lab’s own exports and replay JSON from Python all import here.'),
            u.modelList);
    }

    buildPolicyHud() {
        const u = this.ui;
        u.actCells = ACTIONS.map((a) => h('div.ai-act', { title: a.name }));
        // Grid rows: gas / coast / brake; columns: left / straight / right.
        const grid = h('div.ai-actgrid');
        for (const ti of [0, 1, 2]) for (const si of [0, 1, 2]) grid.appendChild(u.actCells[si * 3 + ti]);
        u.steerBar = h('i');
        u.throttleBar = h('i');
        u.focusName = h('b');
        u.focusFacts = h('span.pt-muted');
        u.curves = [0, 1, 2, 3].map(() => h('i'));
        u.edgeText = h('span.pt-mono');
        return h('div.ai-policy.pt-panel.pt-hidden', { 'aria-live': 'off' },
            h('div.ai-policy-head', h('span.ai-dot'), u.focusName, u.focusFacts),
            h('div.ai-policy-body',
                h('div.ai-actbox', h('div.ai-actlabels', h('span', '←'), h('span', '↑'), h('span', '→')), grid,
                    h('div.ai-actside', h('span', 'gas'), h('span', 'coast'), h('span', 'brake'))),
                h('div.ai-bars',
                    h('div.ai-bar.steer', h('span', 'steer'), h('div', u.steerBar)),
                    h('div.ai-bar.throttle', h('span', 'throttle'), h('div', u.throttleBar)),
                    h('div.ai-curves', h('span', 'curve ahead'), h('div', u.curves)),
                    h('div.ai-edge', h('span', 'road edge'), u.edgeText))));
    }

    fillTracks() {
        const app = this.app, sel = this.ui.trackSel;
        sel.replaceChildren();
        const camps = app.catalog.campaigns();
        const group = (label, list) => {
            if (!list.length) return;
            sel.appendChild(h('optgroup', { label }, list.map((t) => h('option', { value: t.id }, `${t.id}  ${t.name}`))));
        };
        const byId = (id) => camps.find((c) => c.id === id);
        const tr = byId('training');
        if (tr) for (const t of tr.tiers) group(`Training · ${t.name}`, t.tracks);
        for (const c of camps) {
            if (c.id === 'training') continue;
            for (const t of c.tiers) group(`${c.name} · ${t.name}`, t.tracks);
        }
        group('Dev samples', getSamples());
        group('My tracks', app.catalog.customTracks());
        if (this.extraTrack) group('From a driver file', [this.extraTrack]);
    }

    // ------------------------------------------------------------ track

    /** Shows a track (id or JSON). Returns false when it cannot be driven. */
    setTrack(ref, { quiet = false } = {}) {
        const app = this.app;
        let track = null;
        if (ref && typeof ref === 'object') {
            track = ref;
            if (!app.catalog.getTrack(track.id) || trackHash(app.catalog.getTrack(track.id)) !== trackHash(track)) {
                this.extraTrack = { ...track, id: track.id || 'custom' };
                track = this.extraTrack;
            }
        } else {
            track = app.catalog.getTrack(ref);
            if (!track && this.extraTrack && this.extraTrack.id === ref) track = this.extraTrack;
        }
        if (!track) {
            if (!quiet) app.toast("That track couldn't be found.", { kind: 'bad' });
            return false;
        }
        let world;
        try {
            world = buildWorld(track);
        } catch (e) {
            if (!quiet) app.toast(`This track can't be built: ${e.message}`, { kind: 'bad' });
            return false;
        }
        if (!world.route) {
            if (!quiet) app.toast('This track has no route to the finish yet.', { kind: 'bad' });
            return false;
        }
        this.track = track;
        this.world = world;
        memo.trackRef = this.extraTrack === track ? track : track.id;
        this.fillTracks();
        this.ui.trackSel.value = track.id;
        this.clearCars();
        this.field = null;
        this.fieldMeta = null;
        app.loadWorld(world, track);
        this.r.setCameraMode('orbit', null);
        this.syncView();
        this.updateWorkersNote();
        return true;
    }

    async onTrackPick() {
        const id = this.ui.trackSel.value;
        if (memo.run && this.track && id !== this.track.id) {
            const ok = await this.app.confirm('Switching tracks ends the current training run. Its best driver stays in the Driver card until you train again.', { title: 'New track?', ok: 'Switch track', danger: true });
            if (!ok) {
                this.ui.trackSel.value = this.track.id;
                return;
            }
            this.endRun();
        }
        this.setTrack(id);
    }

    // ------------------------------------------------------------ settings

    setTab(tab) {
        memo.tab = tab === 'drivers' ? 'drivers' : 'train';
        const u = this.ui;
        const train = memo.tab === 'train';
        toggleClass(u.trainPane, 'pt-hidden', !train);
        toggleClass(u.driversPane, 'pt-hidden', train);
        toggleClass(u.tabTrain, 'active', train);
        toggleClass(u.tabDrivers, 'active', !train);
        u.tabTrain.setAttribute('aria-selected', String(train));
        u.tabDrivers.setAttribute('aria-selected', String(!train));
    }

    applyPreset(id) {
        if (memo.run) return;
        memo.settings = { ...L.presetSettings(id), seed: memo.settings.seed };
        this.writeSettings();
    }

    setAlgo(algo) {
        if (memo.run) return;
        memo.settings = L.sanitizeSettings({ ...memo.settings, algo });
        this.writeSettings();
    }

    readSettings() {
        const raw = { ...memo.settings };
        for (const [k, el] of Object.entries(this.ui.inputs)) raw[k] = el.value;
        memo.settings = L.sanitizeSettings(raw);
        this.writeSettings();
    }

    writeSettings() {
        const s = memo.settings, u = this.ui;
        for (const [k, el] of Object.entries(u.inputs)) if (document.activeElement !== el || el.tagName === 'SELECT') el.value = String(s[k]);
        const preset = L.matchPreset(s);
        u.presetBtns.forEach((b, i) => {
            toggleClass(b, 'active', L.PRESET_IDS[i] === preset);
            b.setAttribute('aria-pressed', String(L.PRESET_IDS[i] === preset));
        });
        setText(u.presetBlurb, preset ? L.PRESETS[preset].blurb : 'Custom settings.');
        toggleClass(u.algoGa, 'active', s.algo === 'ga');
        toggleClass(u.algoEs, 'active', s.algo === 'es');
        u.algoGa.setAttribute('aria-pressed', String(s.algo === 'ga'));
        u.algoEs.setAttribute('aria-pressed', String(s.algo === 'es'));
        toggleClass(u.mutField, 'pt-hidden', s.algo !== 'ga');
        toggleClass(u.sigmaField, 'pt-hidden', s.algo !== 'es');
        toggleClass(u.lrField, 'pt-hidden', s.algo !== 'es');
        this.updateWorkersNote();
    }

    workerCount() {
        const s = memo.settings;
        const hc = (navigator.hardwareConcurrency || 4) - 1;
        return aiWorkerCap(Math.max(1, Math.min(MAX_WORKERS, s.workers > 0 ? s.workers : hc)));
    }

    updateWorkersNote() {
        const u = this.ui;
        if (!u || !u.workersNote || !this.world) return;
        let arch = null;
        try {
            arch = L.runConfig(memo.settings, this.world, this.startFromModel()).arch;
        } catch (e) { /* settings mid-edit */ }
        const net = arch ? `network ${L.archLabel(arch)} (${L.paramCountOf(arch).toLocaleString()} weights)` : '';
        const n = this.workerCount();
        setText(u.workersNote, `${n} worker thread${n === 1 ? '' : 's'} · ${net}`);
    }

    startFromModel() {
        const d = memo.driver;
        return memo.startFrom && d && d.model ? d.model : null;
    }

    // ------------------------------------------------------------ training

    primary() {
        const st = this.state;
        if (st === 'idle') this.train();
        else if (st === 'training') this.pause();
        else if (st === 'paused' || st === 'stopped' || st === 'done') this.resume();
    }

    secondary() {
        const st = this.state;
        if (st === 'training' || st === 'starting' || st === 'pausing' || st === 'paused') this.stop();
        else if (st === 'stopped' || st === 'done') this.newRun();
    }

    setState(st) {
        this.state = st;
        if (memo.run) memo.run.state = st;
        this.syncControls();
    }

    syncControls() {
        const u = this.ui, st = this.state;
        const labels = {
            idle: 'Idle', starting: 'Waking the flock…', training: 'Training', pausing: 'Pausing after this generation…',
            paused: 'Paused', stopped: 'Stopped', done: 'Done',
        };
        setText(u.status, labels[st] || st);
        u.status.dataset.state = st;
        const primary = { idle: ['Train', 'play'], starting: ['Pause', 'pause'], training: ['Pause', 'pause'], pausing: ['Pausing…', 'pause'], paused: ['Resume', 'play'], stopped: ['Continue', 'play'], done: ['Train more', 'play'] }[st];
        u.trainBtn.replaceChildren(h('span.pt-ico', { html: iconSvg(primary[1], 18) }), primary[0]);
        u.trainBtn.disabled = st === 'starting' || st === 'pausing';
        const second = st === 'stopped' || st === 'done' ? ['New run', 'plus'] : ['Stop', 'close'];
        u.stopBtn.replaceChildren(h('span.pt-ico', { html: iconSvg(second[1], 18) }), second[0]);
        u.stopBtn.disabled = st === 'idle';
        const locked = !!memo.run;
        u.settingsBox.disabled = locked;
        for (const b of u.presetBtns) b.disabled = locked;
        u.trackSel.disabled = st === 'training' || st === 'starting' || st === 'pausing';
        const canStartFrom = !locked && memo.driver && memo.driver.model;
        toggleClass(u.startFromRow, 'pt-hidden', !canStartFrom);
        u.startFrom.checked = !!memo.startFrom;
        this.writeSettings();
        this.renderDriver();
    }

    async train() {
        if (memo.run || !this.world) return;
        const from = this.startFromModel();
        let rc;
        try {
            rc = L.runConfig(memo.settings, this.world, from);
        } catch (e) {
            this.app.toast(e.message, { kind: 'bad' });
            return;
        }
        const trainer = new NeuroTrainer({ ...rc.trainer, evaluator: null });
        memo.run = {
            trainer, rc, track: memo.trackRef, goal: aiGoalCap(rc.generations || 0), trainMs: 0,
            best: null, lastStats: null, pending: null, state: 'idle', name: from ? memo.driver.name : null,
        };
        this.renderChart();
        await this.runLoop();
    }

    resume() {
        const run = memo.run;
        if (!run) return;
        if (atFreeLimit(run.trainer.generation)) {
            requireProAI(this.app, `The free Lab trains up to ${FREE_AI.generations} generations.`).then((ok) => { if (ok && !this.disposed) this.resume(); });
            return;
        }
        if (this.state === 'done' || (run.goal && run.trainer.generation >= run.goal)) {
            run.goal = run.trainer.generation + (memo.settings.generations || 50);
        }
        run.goal = aiGoalCap(run.goal);
        if (this.state === 'paused' && this.pool) {
            this.setState('training');
            this.loop();
            return;
        }
        this.runLoop();
    }

    async runLoop() {
        const run = memo.run;
        this.setState('starting');
        const token = ++this.runToken;
        if (!this.pool) {
            try {
                this.pool = createWorkerPool(this.workerCount());
                await this.pool.init(run.rc.workerInit);
            } catch (e) {
                if (token !== this.runToken) return;
                console.error('[ai-lab] workers failed', e);
                this.closePool();
                this.app.toast(`The training workers could not start: ${e.message}`, { kind: 'bad', ms: 5000 });
                this.setState(run.trainer.generation ? 'paused' : 'idle');
                if (!run.trainer.generation) memo.run = null;
                this.syncControls();
                return;
            }
            if (token !== this.runToken) return;
        }
        run.trainer.evaluator = { evaluate: (list, opts) => this.evaluate(list, opts) };
        this.setState('training');
        this.loop();
    }

    /** Runs generations until paused, stopped, done or the screen is left. */
    async loop() {
        const run = memo.run;
        const token = ++this.runToken;
        const tr = run.trainer;
        run.clockAt = performance.now();
        while (token === this.runToken && memo.run === run) {
            if (run.goal && tr.generation >= run.goal) {
                this.setState('done');
                this.closePool();
                this.app.toast(`Training finished: ${tr.generation} generations.`, { kind: 'good', icon: 'check' });
                return;
            }
            // ES draws its noise in ask(): keep the RNG so an aborted generation can be asked again identically.
            run.rngBefore = tr.algo === 'es' ? tr.opt.rng.getState() : null;
            let stats;
            try {
                stats = await tr.step();
            } catch (e) {
                if (token !== this.runToken) return;
                console.error('[ai-lab] generation failed', e);
                this.app.toast(`Training hit a snag: ${e.message}`, { kind: 'bad', ms: 5000 });
                this.closePool();
                this.setState('paused');
                return;
            }
            run.rngBefore = null;
            if (token !== this.runToken || this.disposed) return;
            // Wall-clock training time (including the breather between generations).
            const now = performance.now();
            run.trainMs += now - run.clockAt;
            run.clockAt = now;
            this.onGeneration(stats);
            if (this.state === 'pausing') {
                this.setState('paused');
                return;
            }
            // Let the page breathe between generations (input, frames).
            await new Promise((r) => setTimeout(r, 0));
        }
    }

    async evaluate(list, opts) {
        const pool = this.pool;
        if (!pool) throw new Error('Training workers are not running');
        const results = await pool.evaluate(list, { ...opts, replay: true });
        this.lastEval = { list, results, generation: opts.generation };
        return results;
    }

    pause() {
        if (this.state === 'training') this.setState('pausing');
    }

    stop() {
        this.abortGeneration();
        this.closePool();
        this.setState('stopped');
    }

    /** Drops the generation in flight (its results never arrive); the trainer stays as it was before it. */
    abortGeneration() {
        this.runToken++;
        const run = memo.run;
        if (run && run.rngBefore != null) {
            run.trainer.opt.rng.setState(run.rngBefore);
            run.rngBefore = null;
        }
        this.closePool();
    }

    closePool() {
        if (this.pool) {
            try {
                this.pool.close();
            } catch (e) { /* already gone */ }
        }
        this.pool = null;
    }

    newRun() {
        this.endRun();
        this.syncControls();
    }

    endRun() {
        this.abortGeneration();
        memo.run = null;
        this.state = 'idle';
        this.renderChart();
        this.renderStats(null);
        this.syncControls();
    }

    onGeneration(stats) {
        const run = memo.run, tr = run.trainer, ev = this.lastEval;
        run.lastStats = stats;
        if (ev && ev.generation === stats.generation) {
            const fit = ev.results.map((r) => (Number.isFinite(r.fitness) ? r.fitness : -1e9));
            const shown = L.pickShown(fit, shownCap(memo.view.cap));
            const entries = shown.map(({ index, rank }) => ({
                replay: ev.results[index].replay, params: ev.list[index], rank, fitness: fit[index],
                info: ev.results[index].info, color: L.rankColor(rank, fit.length),
            }));
            run.pending = { generation: stats.generation, entries, total: fit.length, envConfig: run.rc.envConfig, arch: run.rc.arch };
            if (tr.best && tr.best.generation === stats.generation) {
                const bi = L.rankOrder(fit)[0];
                run.best = { params: tr.best.params, fitness: tr.best.fitness, info: tr.best.info, generation: stats.generation, replay: ev.results[bi].replay };
                memo.driver = {
                    kind: 'training', name: `${this.track.name || this.track.id} · gen ${stats.generation + 1}`,
                    replay: run.best.replay, track: memo.trackRef, run,
                };
                if (run.rc.envConfig.startMode === 'start') {
                    this.submitAiRun(run.best.replay, `${String(tr.algo || 'AI').toUpperCase()} · gen ${stats.generation + 1}`, `${L.archLabel(run.rc.arch)} net`);
                }
            }
            const f = this.fieldMeta;
            if (!this.field || f.source !== 'training' || this.field.over) this.showGeneration(run.pending);
        }
        setText(this.ui.gen, String(tr.generation));
        this.renderStats(stats);
        this.renderChart();
        this.renderDriver();
        this.syncView();
    }

    renderStats(stats) {
        const u = this.ui, run = memo.run;
        const S = u.stats;
        if (!run || !stats) {
            for (const el of Object.values(S)) setText(el, '–');
            setText(u.gen, run ? String(run.trainer.generation) : '–');
            return;
        }
        const tr = run.trainer;
        setText(u.gen, String(tr.generation));
        setText(S.best, fmtFit(stats.bestEver));
        setText(S.time, stats.bestEverTimeMs != null ? formatTime(stats.bestEverTimeMs) : `${pct(tr.best ? tr.best.info.progressFrac : 0)} route`);
        setText(S.finish, pct(stats.finishRate));
        setText(S.mean, fmtFit(stats.mean));
        const n = run.pending ? run.pending.total : 0;
        setText(S.speed, stats.evalMs > 0 ? ((n * 1000) / stats.evalMs).toFixed(0) : '–');
        setText(S.elapsed, fmtSecs(run.trainMs));
    }

    renderChart() {
        const u = this.ui;
        if (!u || !u.chart) return;
        let rows = [];
        if (memo.run) rows = L.historyRows(memo.run.trainer.history);
        else if (memo.driver && memo.driver.file) rows = L.historyRows(memo.driver.file.stats && memo.driver.file.stats.history);
        drawChart(u.chart, rows);
        u.chart.setAttribute('aria-label', rows.length
            ? `Training curve over ${rows.length} generations: best score ${fmtFit(rows[rows.length - 1].best)}, average ${fmtFit(rows[rows.length - 1].mean)}`
            : 'Training curve (empty)');
    }

    // ------------------------------------------------------------ live view

    clearCars() {
        for (const c of this.cars) this.r.removeCar(c);
        this.cars = [];
        this.labelled = null;
        this.bestLabelled = false;
    }

    /** Shows a training generation's field. */
    showGeneration(p) {
        const pb = this.makeField(p.entries, p.envConfig, p.arch);
        if (!pb) return;
        this.setField(pb, { source: 'training', generation: p.generation, total: p.total, again: p });
    }

    /** Shows the current driver alone (a loaded model or an imported run). */
    showDriver() {
        const d = memo.driver;
        if (!d || !d.replay || !this.world) return;
        if (d.replay.trackHash && d.replay.trackHash !== this.world.hash) return;
        const env = d.model ? d.model.envConfig : (d.run ? d.run.rc.envConfig : { frameSkip: 4 });
        const arch = d.model ? d.model.net.arch : d.run ? d.run.rc.arch : null;
        const params = d.model ? d.model.net.getParams() : d.run && d.run.best ? d.run.best.params : null;
        const pb = this.makeField([{ replay: d.replay, params, rank: 0, color: '#ffd54a' }], env, arch);
        if (pb) this.setField(pb, { source: 'driver', name: d.name });
    }

    makeField(entries, envConfig, arch) {
        try {
            return new FieldPlayback({ world: this.world, envConfig, arch, entries });
        } catch (e) {
            console.error('[ai-lab] playback failed', e);
            this.app.toast(`Can't show these runs: ${e.message}`, { kind: 'bad' });
            return null;
        }
    }

    setField(pb, meta) {
        this.field = pb;
        this.fieldMeta = meta;
        if (this.live) {
            // Car 0 is the best (opaque, labelled); the rest are tinted ghosts. Handles are reused between fields.
            while (this.cars.length < pb.cars.length) {
                const i = this.cars.length;
                this.cars.push(this.r.addCar(i === 0 ? { kind: 'ai', color: '#ffd54a' } : { kind: 'ghost' }));
            }
            this.cars.forEach((car, i) => {
                const c = pb.cars[i];
                car.setVisible(!!c);
                if (!c) return;
                if (i > 0) tintGhost(car, c.entry.color || '#7fdcff', 1);
                car.setPose(c.cur);
                car.teleported();
            });
        }
        this.setFocus(pb.bestIndex());
        this.syncView();
    }

    /** When a field has finished: the newest generation if there is one, else the same runs again. */
    nextField() {
        const run = memo.run, f = this.fieldMeta;
        if (!f) return;
        if (f.source === 'training') this.showGeneration(run && run.pending ? run.pending : f.again);
        else this.showDriver();
    }

    jumpLatest() {
        if (memo.run && memo.run.pending) this.showGeneration(memo.run.pending);
    }

    setFocus(i) {
        const pb = this.field;
        if (!pb) return;
        pb.setFocus(i);
        this.focusId = pb.focus;
        if (this.live) {
            // Name tags only help when following someone else: a tag on the followed car hides the road.
            if (this.labelled) this.labelled.setLabel('');
            this.labelled = null;
            const car = this.cars[pb.focus];
            if (this.cars[0] && pb.focus !== 0 && pb.cars.length > 1) {
                this.cars[0].setLabel('Best');
                this.bestLabelled = true;
            } else if (this.cars[0] && this.bestLabelled) {
                this.cars[0].setLabel('');
                this.bestLabelled = false;
            }
            this.r.setCameraMode(CAMS[memo.view.cam].id, CAMS[memo.view.cam].id === 'top' ? null : car);
        }
        this.updateHud(true);
    }

    cycleFocus(d) {
        if (this.field) this.setFocus(this.field.focus + d);
    }

    focusBest() {
        if (this.field) this.setFocus(this.field.bestIndex());
    }

    setCam(i) {
        memo.view.cam = (i + CAMS.length) % CAMS.length;
        const car = this.field ? this.cars[this.field.focus] : null;
        const mode = CAMS[memo.view.cam].id;
        if (this.live) this.r.setCameraMode(mode, mode === 'top' ? null : car || null);
        this.syncView();
    }

    cycleSpeed(d) {
        const i = SPEEDS.indexOf(memo.view.speed);
        memo.view.speed = SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, (i < 0 ? 1 : i) + d))];
        this.app.loop.timeScale = memo.view.speed;
        this.syncView();
    }

    setCap(n) {
        memo.view.cap = CAPS.includes(n) ? n : 32;
        this.syncView();
    }

    toggleRays() {
        memo.view.rays = !memo.view.rays;
        if (this.overlay) this.overlay.setVisible(memo.view.rays);
        this.syncView();
    }

    syncView() {
        const u = this.ui;
        if (!u) return;
        u.camBtns.forEach((b, i) => {
            toggleClass(b, 'active', i === memo.view.cam);
            b.setAttribute('aria-pressed', String(i === memo.view.cam));
        });
        setText(u.speedBtn, `${memo.view.speed}×`);
        toggleClass(u.raysBtn, 'active', memo.view.rays);
        u.raysBtn.setAttribute('aria-pressed', String(memo.view.rays));
        const f = this.fieldMeta;
        let info = this.live ? '' : 'No 3D view in this browser: training still works.';
        if (f && f.source === 'training') info = `Gen ${f.generation + 1} · ${this.field.cars.length} of ${f.total} drivers`;
        else if (f && f.source === 'driver') info = f.name;
        setText(u.fieldInfo, info);
        const behind = !!(f && f.source === 'training' && memo.run && memo.run.pending && memo.run.pending.generation > f.generation);
        toggleClass(u.latestBtn, 'pt-hidden', !behind);
        toggleClass(u.empty, 'pt-hidden', !!this.field);
        toggleClass(u.policy, 'pt-hidden', !this.field);
    }

    tick() {
        const pb = this.field;
        if (!pb) return;
        pb.step();
        if (this.live) {
            const fc = pb.focusCar;
            if (fc && fc.events.length) this.r.handleEvents(fc.events, this.cars[pb.focus]);
        }
        if (pb.over) this.nextField();
    }

    frame(alpha, dt) {
        const pb = this.field;
        if (pb && this.live) {
            for (let i = 0; i < pb.cars.length; i++) {
                const c = pb.cars[i], car = this.cars[i];
                if (!car) continue;
                car.setPose(c.prev, c.cur, alpha);
                // Crashed drivers fade; finishers stay bright.
                if (i > 0) tintGhost(car, null, c.done && !c.finished ? 0.35 : 1);
            }
            const fc = pb.focusCar;
            if (this.overlay && fc) this.overlay.update(this.cars[pb.focus] && this.cars[pb.focus].view, pb.decision, fc.env);
        }
        const now = performance.now();
        if (now - this.hudAt > 90) {
            this.hudAt = now;
            this.updateHud(false);
            if (this.fieldMeta && this.fieldMeta.source === 'training') this.syncView();
        }
        this.r.render(dt);
    }

    updateHud() {
        const pb = this.field, u = this.ui;
        if (!pb || !pb.decision) return;
        const d = pb.decision, c = pb.focusCar, e = c.entry;
        const total = this.fieldMeta && this.fieldMeta.total;
        const rank = (e.rank ?? pb.focus) + 1;
        setText(u.focusName, this.fieldMeta && this.fieldMeta.source === 'driver' ? this.fieldMeta.name : rank === 1 ? 'Best driver' : `Driver #${rank}${total ? ` of ${total}` : ''}`);
        u.policy.style.setProperty('--dot', e.color || '#ffd54a');
        const facts = [`${Math.round(c.sim.car.speedKmh)} km/h`, `${pct(d.info.progressFrac)} of the route`];
        if (c.done) facts.push(c.finished ? `finished in ${formatTime(c.sim.finishTimeMs)}` : L.reasonLabel(e.info ? e.info.reason : null));
        else if (Number.isFinite(e.fitness)) facts.push(`score ${fmtFit(e.fitness)}`);
        setText(u.focusFacts, facts.join(' · '));

        // Action grid: brightness = the network's preference (softmax), outline = the button pressed.
        const out = d.outputs && d.outputs.length === 9 ? d.outputs : null;
        let probs = null;
        if (out) {
            const m = Math.max(...out);
            const ex = out.map((v) => Math.exp(v - m));
            const sum = ex.reduce((a, b) => a + b, 0);
            probs = ex.map((v) => v / sum);
        }
        u.actCells.forEach((cell, i) => {
            cell.style.setProperty('--p', probs ? probs[i].toFixed(3) : '0');
            toggleClass(cell, 'on', d.driving && d.action === i);
        });
        u.steerBar.style.setProperty('--v', String(d.steer));
        u.throttleBar.style.setProperty('--v', String(d.throttle));
        const curv = d.names.reduce((a, n, i) => (n.startsWith('curv@') ? a.concat(d.obs[i]) : a), []);
        u.curves.forEach((bar, i) => {
            const v = curv[i] ?? 0;
            bar.style.setProperty('--v', String(Math.max(-1, Math.min(1, v))));
            bar.title = `${d.names.filter((n) => n.startsWith('curv@'))[i] || ''}: ${v.toFixed(2)}`;
        });
        const edges = d.names.reduce((a, n, i) => (n.startsWith('edge@') ? a.concat(d.obs[i]) : a), []);
        if (edges.length) {
            const L0 = c.env.config.obs.rayLength;
            const left = edges[0] * L0, right = edges[edges.length - 1] * L0, ahead = edges[(edges.length - 1) >> 1] * L0;
            setText(u.edgeText, `L ${left.toFixed(0)} m · ahead ${ahead >= L0 - 0.5 ? `${L0}+` : ahead.toFixed(0)} m · R ${right.toFixed(0)} m`);
        } else {
            setText(u.edgeText, 'no edge rays');
        }
    }

    // ------------------------------------------------------------ drivers

    renderDriver() {
        const u = this.ui, d = memo.driver;
        if (!u || !u.driverCard) return;
        const card = u.driverCard;
        card.replaceChildren();
        if (!d) {
            card.appendChild(h('p.pt-muted', 'Train a flock or load a driver: the best one shows up here, ready to race.'));
            return;
        }
        const r = d.replay;
        const finished = r && r.finished;
        const btn = (label, iconName, onclick, cls = '', disabled = false) => h(`button.pt-btn.small${cls}`, { type: 'button', onclick, disabled },
            h('span.pt-ico', { html: iconSvg(iconName, 16) }), label);
        const kind = { training: 'Best of this run', model: d.stored ? 'Saved driver' : 'Model file', run: 'Imported run' }[d.kind];
        const trackName = this.track ? this.track.name : '';
        const facts = [];
        if (d.kind === 'training' && d.run && d.run.best) facts.push(`score ${fmtFit(d.run.best.fitness)}`);
        if (d.model) facts.push(`net ${L.archLabel(d.model.net.arch)}`);
        const onTrack = !r || !r.trackHash || (this.world && r.trackHash === this.world.hash);
        append(card, [
            h('div.ai-driver-head', h('span.ai-badge', kind), h('b', d.name)),
            h('div.ai-driver-facts',
                h('span.pt-mono', finished ? formatTime(r.timeMs) : r ? `${pct(d.kind === 'training' && d.run && d.run.best ? d.run.best.info.progressFrac : (d.file && d.file.stats && d.file.stats.progressFrac) || 0)} of the route` : '–'),
                h('span.pt-muted', [trackName, ...facts].filter(Boolean).join(' · '))),
            !onTrack ? h('p.ai-note.pt-muted', 'This run belongs to another track: load it again from the Drivers tab.') : null,
            h('div.ai-driver-actions',
                btn('Race the AI', 'flag', () => this.raceDriver(), '.primary', !onTrack || !r),
                btn('Watch', 'film', () => this.watchDriver(), '', !onTrack || !r),
                btn('TAS Studio', 'tas', () => this.tasDriver(), '', !onTrack || !r),
                d.kind === 'training' || (d.kind === 'model' && !d.stored) ? btn('Save', 'save', () => this.saveDriver(), '', d.kind === 'training' && !(d.run && d.run.best)) : null,
                d.kind !== 'run' ? btn('Export', 'export', () => this.exportDriver()) : null,
                this.fieldMeta && this.fieldMeta.source === 'training' && onTrack ? btn('Show alone', 'eye', () => this.showDriver()) : null)]);
    }

    renderModels() {
        const u = this.ui;
        const list = L.listModels(this.app.storage);
        u.modelList.replaceChildren();
        if (!list.length) {
            u.modelList.appendChild(h('p.pt-muted.ai-note', 'No saved drivers yet. Train one and press Save, or try the demo driver.'));
            return;
        }
        for (const { name, file } of list) {
            const s = L.modelSummary(file);
            u.modelList.appendChild(h('div.ai-model',
                h('div.ai-model-main',
                    h('b', name),
                    h('span.pt-muted', `${s.trackId || '?'} ${s.trackName && s.trackName !== s.trackId ? s.trackName : ''} · ${s.arch}${s.algo ? ` · ${s.algo}` : ''}${s.generations ? ` · ${s.generations} gens` : ''}`),
                    h('span.pt-mono', s.finished && s.timeMs != null ? formatTime(s.timeMs) : s.progressFrac != null ? `${pct(s.progressFrac)} of the route` : '')),
                h('div.ai-model-actions',
                    h('button.pt-btn.small', { type: 'button', onclick: () => this.loadDriverFile(file, { stored: true }) }, 'Load'),
                    h('button.pt-btn.small', { type: 'button', title: 'Export JSON', 'aria-label': `Export ${name}`, onclick: () => this.download(file) }, h('span.pt-ico', { html: iconSvg('export', 16) })),
                    h('button.pt-btn.small.danger', { type: 'button', title: 'Delete', 'aria-label': `Delete ${name}`, onclick: () => this.deleteDriver(name) }, h('span.pt-ico', { html: iconSvg('trash', 16) })))));
        }
    }

    busyTraining() {
        if (this.state === 'training' || this.state === 'starting' || this.state === 'pausing') {
            this.app.toast('Pause or stop training first.', { icon: 'pause' });
            return true;
        }
        return false;
    }

    /** Loads a model file as the current driver: its track, its ghost and its curve. */
    async loadDriverFile(file, { stored = false } = {}) {
        if (this.busyTraining()) return false;
        let model;
        try {
            model = loadModelFile(file);
        } catch (e) {
            this.app.toast(e.message, { kind: 'bad', ms: 4000 });
            return false;
        }
        const track = L.trackForFile(file, (id) => this.app.catalog.getTrack(id));
        if (!track) {
            this.app.toast("This driver's track couldn't be found.", { kind: 'bad' });
            return false;
        }
        if (memo.run && this.track && trackHash(track) !== this.world.hash) {
            const ok = await this.app.confirm('This driver races on another track, so the current training run ends.', { title: 'Load driver?', ok: 'Load', danger: true });
            if (!ok) return false;
            this.endRun();
        }
        if (!this.world || trackHash(track) !== this.world.hash) {
            if (!this.setTrack(track)) return false;
        }
        memo.driver = { kind: 'model', name: file.name || 'Penguin driver', file, model, replay: file.replay || null, track: memo.trackRef, stored };
        this.showDriver();
        this.renderChart();
        this.syncControls();
        this.app.toast(`${memo.driver.name} is on the ice`, { icon: 'penguin' });
        return true;
    }

    async loadDemo() {
        try {
            const res = await fetch(new URL('../../models/demo-S01.json', import.meta.url));
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const file = await res.json();
            await this.loadDriverFile(file);
        } catch (e) {
            this.app.toast(`The demo driver couldn't be loaded: ${e.message}`, { kind: 'bad' });
        }
    }

    async importDriver() {
        const app = this.app;
        if (!(await requireProAI(app, 'Importing driver weights needs Pro AI.'))) return;
        const text = await app.prompt('Import a driver', {
            message: 'Paste or choose a model .json (from tools/train.mjs or the Lab), a tools/train.mjs .state.json to keep training, or a replay JSON / PTR code (for example from Python).',
            multiline: true, placeholder: '{"format":"penguintrack-ai-model", …}', ok: 'Import', file: '.json,.txt',
        });
        if (!text) return;
        let kind;
        try {
            kind = L.classifyImport(text);
        } catch (e) {
            app.toast(e.message, { kind: 'bad', ms: 4000 });
            return;
        }
        if (kind.kind === 'model') {
            const file = { ...kind.file, name: L.uniqueName(kind.file.name, L.listModels(app.storage).map((m) => m.name)) };
            if (!L.saveModel(app.storage, file)) app.toast('Storage is full: the driver is loaded but not saved.', { kind: 'bad' });
            this.renderModels();
            await this.loadDriverFile(file, { stored: true });
        } else if (kind.kind === 'train-run') {
            await this.importTrainRun(kind.run);
        } else {
            let data;
            try {
                data = await decodeReplayText(text);
            } catch (e) {
                app.toast(e.message, { kind: 'bad', ms: 4000 });
                return;
            }
            if (this.busyTraining()) return;
            const r = data.replay;
            const track = data.track || app.catalog.getTrack(r.trackId);
            if (!track || (r.trackHash && trackHash(track) !== r.trackHash)) {
                app.toast("This run's track couldn't be found (or its layout changed).", { kind: 'bad', ms: 4000 });
                return;
            }
            if (memo.run && trackHash(track) !== this.world.hash) this.endRun();
            if (trackHash(track) !== this.world.hash && !this.setTrack(track)) return;
            memo.driver = { kind: 'run', name: data.name || r.name || 'Imported run', replay: r, track: memo.trackRef };
            this.showDriver();
            this.syncControls();
            app.toast('Run imported: race it, watch it, or open it in TAS Studio.', { icon: 'import' });
        }
    }

    /** A tools/train.mjs state file: rebuild the trainer and carry on in the browser. */
    async importTrainRun(st) {
        if (this.busyTraining()) return;
        try {
            const track = decodeTrack(st.trackCode);
            const byId = track.id ? this.app.catalog.getTrack(track.id) : null;
            const ref = byId && trackHash(byId) === trackHash(track) ? byId.id : track;
            if (memo.run) this.endRun();
            if (!this.setTrack(ref)) return;
            const trainer = new NeuroTrainer({ state: st.trainer, evaluator: null });
            const rc = {
                envConfig: st.envConfig, arch: trainer.arch, generations: 0, episodes: st.episodes || 1,
                workerInit: { trackJSON: this.track, envConfig: st.envConfig, arch: trainer.arch, episodes: st.episodes || 1, fitness: st.fitness || 'race' },
            };
            memo.run = { trainer, rc, track: memo.trackRef, goal: trainer.generation + 50, trainMs: (st.trainSeconds || 0) * 1000, best: null, lastStats: trainer.history.at(-1) || null, pending: null, state: 'stopped', name: st.name };
            if (trainer.best) {
                const { r } = L.redrive({ world: this.world, envConfig: rc.envConfig, arch: rc.arch, params: trainer.best.params });
                memo.run.best = { ...trainer.best, replay: r.replay };
                memo.driver = { kind: 'training', name: st.name || 'Imported run', replay: r.replay, track: memo.trackRef, run: memo.run };
                this.showDriver();
            }
            this.state = 'stopped';
            this.renderChart();
            this.renderStats(memo.run.lastStats);
            this.syncControls();
            this.app.toast(`Training run loaded at generation ${trainer.generation}: press Continue.`, { icon: 'import' });
        } catch (e) {
            this.app.toast(`That training state can't be resumed: ${e.message}`, { kind: 'bad', ms: 4000 });
        }
    }

    /** The driver as a model file (training runs: the best weights re-driven from the start). */
    driverFile(name) {
        const d = memo.driver;
        if (!d) return null;
        if (d.file) return name ? { ...d.file, name } : d.file;
        const run = d.run;
        if (!run || !run.best) return null;
        const tr = run.trainer;
        return L.buildModelFile({
            name: name || d.name, world: this.world, envConfig: run.rc.envConfig, arch: run.rc.arch,
            trainSeconds: run.trainMs / 1000, date: new Date().toISOString(),
            run: { algo: tr.algo, seed: tr.seed, generation: tr.generation, evaluations: tr.evaluations, popSize: tr.opt.opts.popSize, history: tr.history, best: run.best },
        });
    }

    async saveDriver() {
        const app = this.app, d = memo.driver;
        if (!d) return;
        const taken = L.listModels(app.storage).map((m) => m.name);
        const base = d.kind === 'training' ? `${this.track.id} ${memo.run ? memo.run.trainer.algo.toUpperCase() : ''} gen ${d.run && d.run.best ? d.run.best.generation + 1 : ''}`.replace(/\s+/g, ' ').trim() : d.name;
        const name = await app.prompt('Save driver', { message: 'Give your penguin a name.', value: L.uniqueName(base, taken), ok: 'Save', maxLength: 60 });
        if (!name || !name.trim()) return;
        const clean = name.trim().slice(0, 60);
        if (taken.includes(clean) && !(await app.confirm(`Replace the saved driver "${clean}"?`, { ok: 'Replace', danger: true }))) return;
        const file = this.driverFile(clean);
        if (!file) return;
        if (!L.saveModel(app.storage, file)) {
            app.toast('Storage is full: export the driver as a file instead.', { kind: 'bad', ms: 4000 });
            return;
        }
        d.name = clean;
        if (d.kind === 'model') {
            d.stored = true;
            d.file = file;
        }
        this.renderModels();
        this.renderDriver();
        const t = file.replay && file.replay.finished ? ` (${formatTime(file.replay.timeMs)})` : '';
        app.toast(`Saved ${clean}${t}`, { kind: 'good', icon: 'save' });
    }

    exportDriver() {
        const file = this.driverFile();
        if (file) this.download(file);
    }

    async download(file) {
        if (!(await requireProAI(this.app, 'Exporting driver weights needs Pro AI.'))) return;
        const blob = new Blob([JSON.stringify(file)], { type: 'application/json' });
        const a = h('a', { href: URL.createObjectURL(blob), download: `${String(file.name || 'driver').replace(/[^\w.-]+/g, '_')}.json` });
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }

    async deleteDriver(name) {
        const ok = await this.app.confirm(`Delete the saved driver "${name}"? This can't be undone.`, { title: 'Delete driver?', ok: 'Delete', danger: true });
        if (!ok) return;
        L.deleteModel(this.app.storage, name);
        if (memo.driver && memo.driver.kind === 'model' && memo.driver.stored && memo.driver.name === name) memo.driver.stored = false;
        this.renderModels();
        this.renderDriver();
    }

    /**
     * A finished AI run from the start line on the track's Best AI board, after
     * re-simulating it (label: algorithm and generation, model: network size).
     */
    submitAiRun(replay, label, model) {
        if (!replay || !replay.finished || !this.track || !this.track.id || !this.world) return null;
        const v = verifyReplay(this.world, replay);
        if (!v.ok) return null;
        const out = submitBoardRun(this.app.storage, this.app.catalog, this.track, this.world.hash, 'ai', {
            timeMs: v.timeMs, respawns: v.respawns, replay: { ...replay, name: `${this.track.name || this.track.id} ${label}` }, splits: [],
            source: 'lab', label, model,
        });
        if (out.improved) this.app.toast(`New Best AI on ${this.track.name || this.track.id}: ${formatTime(v.timeMs)}`, { kind: 'good', icon: 'trophy' });
        return out;
    }

    /** The replay to hand to other screens: training runs are re-driven from the start line. */
    driverReplay() {
        const d = memo.driver;
        if (!d) return null;
        if (d.kind === 'training' && d.run && d.run.rc.envConfig.startMode !== 'start' && d.run.best) {
            const { r } = L.redrive({ world: this.world, envConfig: d.run.rc.envConfig, arch: d.run.rc.arch, params: d.run.best.params });
            return { ...r.replay, name: d.name };
        }
        return d.replay ? { ...d.replay, name: d.replay.name || d.name } : null;
    }

    /** Track reference for other screens: its id when the catalog has this exact layout, else the JSON. */
    trackRef() {
        const t = this.track;
        const byId = t.id ? this.app.catalog.getTrack(t.id) : null;
        return byId && trackHash(byId) === this.world.hash ? t.id : t;
    }

    raceDriver() {
        const replay = this.driverReplay();
        if (!replay) return;
        const name = memo.driver.name;
        this.app.goto('play', {
            track: this.trackRef(),
            ghosts: [{ replay, label: `AI ${name}`.slice(0, 28), color: '#ffd54a' }],
            onExit: () => this.app.goto('ai', {}),
        });
    }

    watchDriver() {
        const replay = this.driverReplay();
        if (!replay) return;
        this.app.goto('play', { track: this.trackRef(), mode: 'replay', replay, onExit: () => this.app.goto('ai', {}) });
    }

    tasDriver() {
        const replay = this.driverReplay();
        if (!replay) return;
        this.app.goto('tas', { track: this.trackRef(), replay, onExit: () => this.app.goto('ai', {}) });
    }

    // ------------------------------------------------------------ keys

    async back() {
        if (this.state === 'training' || this.state === 'starting' || this.state === 'pausing') {
            const ok = await this.app.confirm('Training pauses while you are away; come back to the AI Lab to resume it.', { title: 'Leave the AI Lab?', ok: 'Leave' });
            if (!ok) return;
        }
        this.app.goto('menu');
    }

    onKey(e) {
        if (e.defaultPrevented || modalOpen() || e.ctrlKey || e.metaKey || e.altKey) return;
        const t = e.target;
        if (isTypingTarget(t)) {
            if (e.key === 'Escape') t.blur();
            return;
        }
        const onControl = t && (t.tagName === 'BUTTON' || t.tagName === 'SUMMARY' || t.tagName === 'A' || t.type === 'checkbox');
        const k = e.key;
        let used = true;
        if (k === 'Escape') this.back();
        else if (k === ' ' && !onControl) this.primary();
        else if (k === 'c' || k === 'C') this.setCam(memo.view.cam + 1);
        else if (k === '[') this.cycleFocus(-1);
        else if (k === ']') this.cycleFocus(1);
        else if (k === 'b' || k === 'B') this.focusBest();
        else if (k === 'r' || k === 'R') this.toggleRays();
        else if (k === 'h' || k === 'H' || k === '?') openHowItWorks(this.app);
        else if (k === '-' || k === '_') this.cycleSpeed(-1);
        else if (k === '=' || k === '+') this.cycleSpeed(1);
        else used = false;
        if (used) e.preventDefault();
    }
}

function shownCap(cap) {
    return Math.max(1, Math.min(L.MAX_SHOWN, cap || L.MAX_SHOWN));
}

/** Tints a ghost car (the renderer's ghost material is one shared material per car). */
function tintGhost(car, color, alpha) {
    const m = car.model && car.model.mats && car.model.mats.ghost;
    if (!m) return;
    if (color && car._tint !== color) {
        car._tint = color;
        m.color.set(color);
        m.emissive.set(color);
        m.emissiveIntensity = 0.35;
    }
    const op = 0.42 * alpha;
    if (m.opacity !== op) m.opacity = op;
}

const screen = {
    id: 'ai',
    lab: null,

    async enter(app, params = {}) {
        this.lab = new Lab(app, params);
        await this.lab.start();
    },

    exit() {
        if (this.lab) this.lab.dispose();
        this.lab = null;
    },

    back() {
        if (this.lab) this.lab.back();
    },
};

export default screen;
