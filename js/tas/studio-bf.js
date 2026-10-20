// TAS Studio bruteforce panel: target, window, rules and seed, a Web Worker
// running BruteforceSession (bruteforce-worker.js), live progress, the best
// result and its improvement history. "Apply" replaces the timeline with the
// best run (undoable); "Ghost" shows it as the comparison car.
import { h, setText, toggleClass } from '../game/dom.js';
import { formatTime } from '../core/format.js';
import { InputTimeline } from './timeline.js';
import { bruteforceOptions, formatTick, fmtNum } from './studio-model.js';

export class BruteforcePanel {
    /**
     * studio: { track, runner, cursor, selection, laps, carPos(), applyTimeline(tl, label),
     *           setCompare(tl, label), toast(msg, opts) }.
     */
    constructor(studio) {
        this.studio = studio;
        this.worker = null;
        this.running = false;
        this.history = [];
        this.bestInputs = null;
        this.initial = null;
        const num = (name, value, attrs = {}) => h('input.pt-input.tas-num', { type: 'number', name, value, ...attrs });
        const txt = (name, value, attrs = {}) => h('input.pt-input.tas-time', { type: 'text', name, value, spellcheck: 'false', ...attrs });
        const field = (label, input, hint) => h('label.tas-field', h('span', label), input, hint ? h('small.pt-muted', hint) : null);

        this.f = {
            target: h('select.pt-input', { name: 'target' },
                h('option', { value: 'finish' }, 'Finish time'),
                h('option', { value: 'checkpoint' }, 'Checkpoint N'),
                h('option', { value: 'speed' }, 'Speed at time'),
                h('option', { value: 'position' }, 'Reach position')),
            cp: num('cp', 1, { min: 1, step: 1 }),
            at: txt('at', '5.00'),
            mode: h('select.pt-input', { name: 'mode' }, h('option', { value: 'min' }, 'closest by then'), h('option', { value: 'at' }, 'distance at that time')),
            px: num('px', 0, { step: 'any' }), py: num('py', 0, { step: 'any' }), pz: num('pz', 0, { step: 'any' }),
            from: txt('from', '', { placeholder: 'start' }),
            to: txt('to', '', { placeholder: 'end' }),
            seed: num('seed', 1, { min: 0, step: 1 }),
            iterations: num('iterations', 20000, { min: 1, step: 1000 }),
            maxChanges: num('maxChanges', 3, { min: 1, max: 20, step: 1 }),
            steerRange: num('steerRange', 8000, { min: 1, max: 131072, step: 500 }),
            steerSpan: num('steerSpan', 12, { min: 1, step: 1 }),
            shiftRange: num('shiftRange', 3, { min: 1, step: 1 }),
            wShift: num('wShift', 1, { min: 0, step: 0.5 }),
            wSteer: num('wSteer', 2, { min: 0, step: 0.5 }),
            wGas: num('wGas', 0.5, { min: 0, step: 0.5 }),
            wBrake: num('wBrake', 0.5, { min: 0, step: 0.5 }),
        };
        const f = this.f;
        this.cpRow = field('Checkpoint', f.cp);
        this.atRow = field('At time', f.at, 's or m:ss.cc');
        this.posRow = h('div.tas-field-row',
            field('x', f.px), field('y', f.py), field('z', f.pz),
            h('button.pt-btn.small', { type: 'button', title: 'Use the car position at the cursor', onclick: () => this.useCarPos() }, 'Car pos'));
        this.modeRow = field('Score', f.mode);
        f.target.addEventListener('change', () => this._targetRows());

        this.startBtn = h('button.pt-btn.primary.small', { type: 'button', onclick: () => this.start() }, 'Start');
        this.stopBtn = h('button.pt-btn.small.danger', { type: 'button', onclick: () => this.stop(), disabled: true }, 'Stop');
        this.applyBtn = h('button.pt-btn.small', { type: 'button', onclick: () => this.apply(), disabled: true }, 'Apply to timeline');
        this.ghostBtn = h('button.pt-btn.small', { type: 'button', onclick: () => this.ghost(), disabled: true }, 'Show as ghost');
        this.stats = {
            state: h('span'), iters: h('span.pt-mono'), rate: h('span.pt-mono'), best: h('span.pt-mono'), initial: h('span.pt-mono'), gain: h('span.pt-mono'),
        };
        this.histEl = h('ol.tas-history.pt-scroll', { 'aria-label': 'Improvements' });
        this.histEl.addEventListener('click', (e) => {
            const li = e.target.closest('[data-i]');
            if (li) this.apply(Number(li.dataset.i));
        });

        this.el = h('div.tas-bf',
            h('div.tas-sec', h('h3', 'Target'),
                field('Optimise', f.target),
                this.cpRow, this.atRow, this.modeRow, this.posRow),
            h('div.tas-sec', h('h3', 'Window'),
                h('div.tas-field-row', field('From', f.from), field('To', f.to)),
                h('div.pt-row.tas-tight',
                    h('button.pt-btn.small', { type: 'button', onclick: () => this.windowFromSelection() }, 'Selection'),
                    h('button.pt-btn.small', { type: 'button', onclick: () => this.windowFromCursor() }, 'From cursor'),
                    h('button.pt-btn.small', { type: 'button', onclick: () => { f.from.value = ''; f.to.value = ''; } }, 'Whole run'))),
            h('details.tas-sec', h('summary', h('h3', 'Rules')),
                h('div.tas-field-row', field('Changes / iteration', f.maxChanges), field('Seed', f.seed)),
                h('div.tas-field-row', field('Steer range ±', f.steerRange), field('Steer span', f.steerSpan, 'ticks')),
                h('div.tas-field-row', field('Shift range ±', f.shiftRange, 'ticks'), field('Iterations', f.iterations)),
                h('div.tas-field-row', field('w shift', f.wShift), field('w steer', f.wSteer), field('w gas', f.wGas), field('w brake', f.wBrake))),
            h('div.pt-row.tas-tight', this.startBtn, this.stopBtn),
            h('dl.tas-stats',
                h('dt', 'State'), h('dd', this.stats.state),
                h('dt', 'Iterations'), h('dd', this.stats.iters),
                h('dt', 'Rate'), h('dd', this.stats.rate),
                h('dt', 'Start'), h('dd', this.stats.initial),
                h('dt', 'Best'), h('dd', this.stats.best),
                h('dt', 'Gain'), h('dd', this.stats.gain)),
            h('div.pt-row.tas-tight', this.applyBtn, this.ghostBtn),
            h('h3.tas-h', 'Improvements'),
            this.histEl);
        this._targetRows();
        this._state('idle');
    }

    _targetRows() {
        const t = this.f.target.value;
        toggleClass(this.cpRow, 'pt-hidden', t !== 'checkpoint');
        toggleClass(this.atRow, 'pt-hidden', t !== 'speed' && t !== 'position');
        toggleClass(this.modeRow, 'pt-hidden', t !== 'position');
        toggleClass(this.posRow, 'pt-hidden', t !== 'position');
        if ((t === 'speed' || t === 'position') && !this.f.at.value) this.f.at.value = formatTick(this.studio.cursor);
    }

    _state(s) {
        setText(this.stats.state, { idle: 'Idle', running: 'Searching…', done: 'Finished', stopped: 'Stopped', error: 'Error' }[s] || s);
        toggleClass(this.stats.state, 'tas-live', s === 'running');
    }

    useCarPos() {
        const p = this.studio.carPos();
        this.f.px.value = p[0].toFixed(2);
        this.f.py.value = p[1].toFixed(2);
        this.f.pz.value = p[2].toFixed(2);
        this.f.at.value = formatTick(this.studio.cursor);
    }

    windowFromSelection() {
        const s = this.studio.selection;
        if (!s) return this.studio.toast('Select a range on the timeline first (Shift-drag).');
        this.f.from.value = formatTick(s.from);
        this.f.to.value = formatTick(s.to);
        return undefined;
    }

    windowFromCursor() {
        this.f.from.value = formatTick(this.studio.cursor);
        this.f.to.value = '';
    }

    /** Form values (for tests and project saves). */
    values() {
        const f = this.f;
        return {
            target: f.target.value, cp: f.cp.value, at: f.at.value, mode: f.mode.value,
            point: [f.px.value, f.py.value, f.pz.value], from: f.from.value, to: f.to.value, seed: f.seed.value,
            maxChanges: f.maxChanges.value, steerRange: f.steerRange.value, steerSpan: f.steerSpan.value,
            shiftRange: f.shiftRange.value, wShift: f.wShift.value, wSteer: f.wSteer.value, wGas: f.wGas.value, wBrake: f.wBrake.value,
            laps: this.studio.laps,
        };
    }

    start() {
        if (this.running) return;
        const { options, error } = bruteforceOptions(this.values());
        if (error) {
            this.studio.toast(error, { kind: 'bad' });
            return;
        }
        this._kill();
        let w;
        try {
            w = new Worker(new URL('./bruteforce-worker.js', import.meta.url), { type: 'module' });
        } catch (e) {
            this.studio.toast(`Could not start the bruteforce worker: ${e.message}`, { kind: 'bad' });
            return;
        }
        this.worker = w;
        this.history = [];
        this.bestInputs = null;
        this.histEl.replaceChildren();
        this.running = true;
        this.startBtn.disabled = true;
        this.stopBtn.disabled = false;
        this.applyBtn.disabled = true;
        this.ghostBtn.disabled = true;
        setText(this.stats.iters, '0');
        setText(this.stats.rate, '—');
        setText(this.stats.gain, '—');
        this._state('running');
        w.onmessage = (e) => this._msg(e.data);
        w.onerror = (e) => this._msg({ type: 'error', message: e.message || 'worker failed' });
        const tl = this.studio.runner.timeline;
        w.postMessage({
            type: 'start', track: this.studio.track, inputs: tl.encode(Math.max(1, tl.length)), options,
            maxIterations: Math.max(1, Math.floor(Number(this.f.iterations.value) || 20000)), reportMs: 200,
        });
    }

    stop() {
        if (this.worker && this.running) this.worker.postMessage({ type: 'stop' });
    }

    _msg(m) {
        switch (m.type) {
            case 'ready':
                this.initial = m.best;
                setText(this.stats.initial, m.best.text);
                setText(this.stats.best, m.best.text);
                break;
            case 'improvement':
                this.bestInputs = m.inputs;
                this.history.push({ iteration: m.iteration, text: m.best.text, timeMs: m.best.timeMs, score: m.best.score, inputs: m.inputs, firstTick: m.firstTick });
                this._showBest(m.best);
                this._addHistory(this.history.length - 1);
                this.applyBtn.disabled = false;
                this.ghostBtn.disabled = false;
                break;
            case 'progress':
                setText(this.stats.iters, String(m.iterations));
                setText(this.stats.rate, `${m.rate.toFixed(0)} it/s · ${(m.elapsedMs / 1000).toFixed(1)} s`);
                break;
            case 'done':
                setText(this.stats.iters, String(m.iterations));
                if (m.inputs && this.history.length) this.bestInputs = m.inputs;
                this._finish(m.reason === 'stopped' ? 'stopped' : 'done');
                if (this.history.length) this.studio.toast(`Bruteforce: ${this.history.length} improvement${this.history.length === 1 ? '' : 's'}, best ${m.best.text}`, { kind: 'good' });
                break;
            case 'error':
                this.studio.toast(`Bruteforce stopped: ${m.message}`, { kind: 'bad', ms: 4500 });
                this._finish('error');
                break;
            default:
        }
    }

    _showBest(best) {
        setText(this.stats.best, best.text);
        const a = this.initial;
        if (a && a.timeMs != null && best.timeMs != null) setText(this.stats.gain, formatTime(best.timeMs - a.timeMs, { style: 'short', sign: true }));
        else if (a && Array.isArray(a.score) && Array.isArray(best.score)) setText(this.stats.gain, fmtNum(best.score[0] - a.score[0], 4).trim());
    }

    _addHistory(i) {
        const it = this.history[i];
        const li = h('li', { 'data-i': i, tabindex: '0', role: 'button', title: 'Apply this version to the timeline' },
            h('span.pt-mono', `#${it.iteration}`), ' ', it.text, h('small.pt-muted', ` from ${formatTick(it.firstTick)}`));
        this.histEl.prepend(li);
        while (this.histEl.children.length > 200) this.histEl.lastChild.remove();
    }

    _finish(state) {
        this.running = false;
        this.startBtn.disabled = false;
        this.stopBtn.disabled = true;
        this._state(state);
        this._kill();
    }

    _kill() {
        if (this.worker) {
            this.worker.onmessage = null;
            this.worker.terminate();
        }
        this.worker = null;
    }

    _inputs(i) {
        return i != null && this.history[i] ? this.history[i].inputs : this.bestInputs;
    }

    apply(i) {
        const inputs = this._inputs(i);
        if (!inputs) return;
        const it = i != null ? this.history[i] : this.history[this.history.length - 1];
        this.studio.applyTimeline(InputTimeline.decode(inputs), `Applied bruteforce result${it ? ` (${it.text})` : ''}`);
    }

    ghost() {
        const inputs = this._inputs();
        if (inputs) this.studio.setCompare(InputTimeline.decode(inputs), 'Bruteforce best');
    }

    dispose() {
        if (this.worker && this.running) this.worker.postMessage({ type: 'stop' });
        this._kill();
        this.running = false;
    }
}
