// TAS Studio script editor: a plain textarea with a line-number gutter that
// marks errors, warnings and the command playing at the cursor. Parses as you
// type (debounced); a script without errors is handed to the studio, which
// applies it to the timeline. Clicking a command's line number seeks there.
import { h, setText, toggleClass } from '../game/dom.js';
import { parse } from './script.js';

const LINE_PX = 18;

export class ScriptEditor {
    /** opts: { onApply(parsed, text), onJump(tick), onStyle(style) }. */
    constructor(opts) {
        this.opts = opts;
        this.parsed = null;
        this.text = '';
        this._timer = 0;
        this._rows = [];
        this._nowRow = -1;
        this._sorted = [];
        this.status = h('div.tas-script-status', { role: 'status', 'aria-live': 'polite' });
        this.style = h('select.pt-input.tas-mini', { 'aria-label': 'Script style', title: 'How timeline edits are written back' },
            h('option', { value: 'ranges' }, 'ranges'), h('option', { value: 'events' }, 'events'));
        this.style.addEventListener('change', () => opts.onStyle && opts.onStyle(this.style.value));
        this.gutter = h('div.tas-gutter', { 'aria-hidden': 'true' });
        this.ta = h('textarea.tas-code', {
            spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', wrap: 'off',
            'aria-label': 'TAS script', placeholder: '0.00 press up\n1.20-1.85 press left\n2.40 steer 21000',
        });
        this.ta.addEventListener('input', () => this._schedule());
        this.ta.addEventListener('scroll', () => { this.gutter.scrollTop = this.ta.scrollTop; });
        this.ta.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                this.parseNow();
            } else if (e.key === 'Escape') {
                this.ta.blur();
            }
            e.stopPropagation();
        });
        this.gutter.addEventListener('click', (e) => {
            const row = e.target.closest('[data-tick]');
            if (row) opts.onJump(Number(row.dataset.tick));
        });
        this.problems = h('ul.tas-problems.pt-scroll');
        this.problems.addEventListener('click', (e) => {
            const li = e.target.closest('[data-line]');
            if (li) this.gotoLine(Number(li.dataset.line));
        });
        this.el = h('div.tas-script',
            h('div.tas-script-head', this.status, h('div.pt-spacer'), h('label.tas-inline', 'write as ', this.style)),
            h('div.tas-editor', this.gutter, this.ta),
            this.problems);
    }

    get focused() {
        return document.activeElement === this.ta;
    }

    /** Replaces the text (from a timeline edit); keeps the scroll position. */
    setText(text) {
        if (text === this.ta.value) return;
        const top = this.ta.scrollTop;
        this.ta.value = text;
        this.ta.scrollTop = top;
        this.text = text;
        this._diagnose(parse(text));
    }

    _schedule() {
        clearTimeout(this._timer);
        this._timer = setTimeout(() => this.parseNow(), 220);
    }

    parseNow() {
        clearTimeout(this._timer);
        const text = this.ta.value;
        const p = parse(text);
        this.text = text;
        this._diagnose(p);
        if (!p.errors.length) this.opts.onApply(p, text);
    }

    _diagnose(p) {
        this.parsed = p;
        const n = this.ta.value.split('\n').length;
        const marks = new Map();
        for (const w of p.warnings) marks.set(w.line, 'warn');
        for (const e of p.errors) marks.set(e.line, 'error');
        const ticks = new Map();
        for (const c of p.commands) ticks.set(c.line, c.from);
        this._sorted = p.commands.map((c) => ({ line: c.line, tick: c.from })).sort((a, b) => a.tick - b.tick || a.line - b.line);
        const frag = document.createDocumentFragment();
        this._rows = [];
        for (let i = 1; i <= n; i++) {
            const row = document.createElement('div');
            row.className = 'tas-ln' + (marks.has(i) ? ` ${marks.get(i)}` : '');
            row.textContent = String(i);
            if (ticks.has(i)) {
                row.dataset.tick = String(ticks.get(i));
                row.title = 'Seek to this command';
            }
            frag.appendChild(row);
            this._rows.push(row);
        }
        this.gutter.replaceChildren(frag);
        this.gutter.style.setProperty('--ln-pad', `${LINE_PX * 4}px`);
        this._nowRow = -1;
        const ne = p.errors.length, nw = p.warnings.length;
        setText(this.status, ne ? `${ne} error${ne === 1 ? '' : 's'}: timeline not updated` : `${p.commands.length} commands${nw ? `, ${nw} warning${nw === 1 ? '' : 's'}` : ''}`);
        toggleClass(this.status, 'bad', ne > 0);
        toggleClass(this.status, 'warn', !ne && nw > 0);
        this.problems.replaceChildren(...p.errors.concat(p.warnings).slice(0, 50).map((d) => {
            const isErr = p.errors.includes(d);
            return h('li', { class: isErr ? 'error' : 'warn', 'data-line': d.line, tabindex: '0', role: 'button' },
                h('b', `line ${d.line}`), ' ', d.message);
        }));
        toggleClass(this.problems, 'pt-hidden', !(ne + nw));
    }

    /** Marks the command in force at `tick` in the gutter. */
    setCursorTick(tick) {
        const s = this._sorted;
        let lo = 0, hi = s.length - 1, best = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (s[mid].tick <= tick) { best = mid; lo = mid + 1; } else hi = mid - 1;
        }
        const line = best >= 0 ? s[best].line : -1;
        if (line === this._nowRow) return;
        if (this._nowRow > 0 && this._rows[this._nowRow - 1]) this._rows[this._nowRow - 1].classList.remove('now');
        this._nowRow = line;
        if (line > 0 && this._rows[line - 1]) this._rows[line - 1].classList.add('now');
    }

    gotoLine(line) {
        const lines = this.ta.value.split('\n');
        let pos = 0;
        for (let i = 0; i < line - 1 && i < lines.length; i++) pos += lines[i].length + 1;
        this.ta.focus();
        this.ta.setSelectionRange(pos, pos + (lines[line - 1] || '').length);
        this.ta.scrollTop = Math.max(0, (line - 4) * LINE_PX);
    }

    dispose() {
        clearTimeout(this._timer);
    }
}
