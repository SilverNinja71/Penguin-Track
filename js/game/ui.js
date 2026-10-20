// Toasts, modal dialogs (confirm / prompt / custom) and spatial keyboard focus
// navigation shared by every shell screen.
import { h } from './dom.js';
import { iconSvg } from './icons.js';

// ------------------------------------------------------------------ toasts

export function makeToaster(parent = document.body) {
    const wrap = h('div.pt-toast-wrap', { role: 'status', 'aria-live': 'polite' });
    parent.appendChild(wrap);
    return function toast(message, opts = {}) {
        const kind = typeof opts === 'string' ? opts : opts.kind || '';
        const ms = (typeof opts === 'object' && opts.ms) || 2600;
        const el = h('div.pt-toast', { class: kind ? `pt-toast-${kind}` : '' },
            opts.icon ? h('span.pt-ico', { html: iconSvg(opts.icon, 18) }) : null,
            h('span', message));
        wrap.appendChild(el);
        while (wrap.children.length > 4) wrap.firstChild.remove();
        setTimeout(() => {
            el.classList.add('out');
            setTimeout(() => el.remove(), 260);
        }, ms);
        return el;
    };
}

// ------------------------------------------------------------------ modals

const stack = [];

export function modalOpen() {
    return stack.length > 0;
}

export function topModal() {
    return stack[stack.length - 1] || null;
}

/**
 * Opens a modal panel. build(close) returns the panel content; close(value)
 * resolves the promise. Esc resolves with `cancelValue`. Focus is trapped and
 * restored to whatever had it before.
 */
export function openModal(build, { cancelValue = null, className = '', label = 'Dialog' } = {}) {
    return new Promise((resolve) => {
        const prevFocus = document.activeElement;
        const back = h('div.pt-modal-back', { role: 'presentation' });
        let done = false;
        const close = (value) => {
            if (done) return;
            done = true;
            const i = stack.indexOf(entry);
            if (i >= 0) stack.splice(i, 1);
            back.classList.add('out');
            setTimeout(() => back.remove(), 140);
            // Later, not now: an Enter that closed the dialog must not also press the button behind it.
            setTimeout(() => {
                if (stack.length) return;
                let target = prevFocus && prevFocus !== document.body && document.contains(prevFocus) ? prevFocus : null;
                if (!target) {
                    const ui = document.getElementById('ui');
                    target = ui && (ui.querySelector('[data-autofocus]:not([disabled])') || focusablesIn(ui)[0]);
                }
                if (target && target.focus) target.focus({ preventScroll: true });
            }, 0);
            resolve(value);
        };
        const panel = h('div.pt-panel.pt-modal', { class: className, role: 'dialog', 'aria-modal': 'true', 'aria-label': label });
        const content = build(close);
        if (content) panel.appendChild(content);
        back.appendChild(panel);
        back.addEventListener('pointerdown', (e) => {
            if (e.target === back) close(cancelValue);
        });
        const entry = { el: back, panel, close, cancel: () => close(cancelValue) };
        stack.push(entry);
        document.body.appendChild(back);
        requestAnimationFrame(() => {
            const auto = panel.querySelector('[data-autofocus]') || focusablesIn(panel)[0];
            if (auto) auto.focus({ preventScroll: true });
        });
    });
}

export function confirmDialog(message, opts = {}) {
    const { title = '', ok = 'OK', cancel = 'Cancel', danger = false } = opts;
    return openModal((close) => h('div.pt-col',
        title ? h('h2.pt-subtitle', title) : null,
        h('p.pt-modal-msg', message),
        h('div.pt-row.pt-modal-actions',
            h('button.pt-btn', { type: 'button', onclick: () => close(false) }, cancel),
            h('button.pt-btn', { type: 'button', class: danger ? 'danger' : 'primary', 'data-autofocus': true, onclick: () => close(true) }, ok))),
    { cancelValue: false, label: title || 'Confirm' });
}

/**
 * Text prompt. Resolves the entered string, or null when cancelled. opts.file
 * (an `accept` list such as '.json,.txt') adds a "Choose file" button that loads
 * a file's text into the box.
 */
export function promptDialog(title, opts = {}) {
    const { message = '', value = '', placeholder = '', ok = 'OK', multiline = false, maxLength = 100000, file = null } = opts;
    return openModal((close) => {
        const input = multiline
            ? h('textarea.pt-input', { rows: 5, placeholder, maxlength: maxLength, spellcheck: 'false', 'data-autofocus': true })
            : h('input.pt-input', { type: 'text', placeholder, maxlength: maxLength, 'data-autofocus': true });
        input.value = value;
        const submit = () => close(input.value);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (!multiline || e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                submit();
            }
        });
        let picker = null;
        if (file) {
            picker = h('input.pt-hidden', { type: 'file', accept: file, tabindex: '-1', 'aria-hidden': 'true' });
            picker.addEventListener('change', async () => {
                const f = picker.files && picker.files[0];
                if (!f) return;
                input.value = (await f.text()).trim();
                input.focus();
            });
        }
        return h('div.pt-col',
            h('h2.pt-subtitle', title),
            message ? h('p.pt-modal-msg', message) : null,
            input,
            h('div.pt-row.pt-modal-actions',
                picker ? h('button.pt-btn.ghost', { type: 'button', onclick: () => picker.click() }, h('span.pt-ico', { html: iconSvg('import', 18) }), 'Choose file') : null,
                picker,
                picker ? h('div.pt-spacer') : null,
                h('button.pt-btn', { type: 'button', onclick: () => close(null) }, 'Cancel'),
                h('button.pt-btn.primary', { type: 'button', onclick: submit }, ok)));
    }, { cancelValue: null, label: title });
}

/** Shows a read-only code with a Copy button (share codes, replay codes). */
export function showCodeDialog(title, code, { message = '', copy } = {}) {
    return openModal((close) => {
        const ta = h('textarea.pt-input.pt-code', { rows: 4, readonly: true, spellcheck: 'false' });
        ta.value = code;
        ta.addEventListener('focus', () => ta.select());
        return h('div.pt-col',
            h('h2.pt-subtitle', title),
            message ? h('p.pt-modal-msg', message) : null,
            ta,
            h('div.pt-row.pt-modal-actions',
                h('button.pt-btn', { type: 'button', onclick: () => close(null) }, 'Close'),
                h('button.pt-btn.primary', {
                    type: 'button', 'data-autofocus': true,
                    onclick: async () => {
                        if (copy) await copy(code);
                        close(true);
                    },
                }, h('span.pt-ico', { html: iconSvg('copy', 18) }), 'Copy')));
    }, { label: title });
}

// ------------------------------------------------------------------ focus navigation

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function focusablesIn(root) {
    return [...root.querySelectorAll(FOCUSABLE)].filter((el) => !el.disabled && el.offsetParent !== null
        && !el.closest('.pt-hidden') && el.getAttribute('aria-hidden') !== 'true');
}

/**
 * Moves focus to the nearest focusable element of `root` in a direction
 * ('up'|'down'|'left'|'right'), scoring by distance along the direction plus
 * a penalty for sideways offset. Returns true when focus moved.
 */
export function moveFocus(root, dir) {
    const items = focusablesIn(root);
    if (!items.length) return false;
    const cur = document.activeElement;
    if (!cur || !root.contains(cur) || cur === root) {
        const first = root.querySelector('[data-autofocus]:not([disabled])') || items[0];
        first.focus();
        scrollIntoViewIfNeeded(first);
        return true;
    }
    const a = cur.getBoundingClientRect();
    const ax = a.left + a.width / 2, ay = a.top + a.height / 2;
    let best = null, bestScore = Infinity;
    for (const el of items) {
        if (el === cur) continue;
        const b = el.getBoundingClientRect();
        const bx = b.left + b.width / 2, by = b.top + b.height / 2;
        let main, side;
        if (dir === 'down' || dir === 'up') {
            main = dir === 'down' ? b.top - a.bottom : a.top - b.bottom;
            if ((dir === 'down' ? by - ay : ay - by) <= 4) continue;
            side = Math.max(0, Math.max(a.left, b.left) - Math.min(a.right, b.right)) ? Math.abs(bx - ax) : Math.abs(bx - ax) * 0.25;
        } else {
            main = dir === 'right' ? b.left - a.right : a.left - b.right;
            if ((dir === 'right' ? bx - ax : ax - bx) <= 4) continue;
            side = Math.max(0, Math.max(a.top, b.top) - Math.min(a.bottom, b.bottom)) ? Math.abs(by - ay) : Math.abs(by - ay) * 0.25;
        }
        const score = Math.max(0, main) + side * 2.2;
        if (score < bestScore) {
            bestScore = score;
            best = el;
        }
    }
    if (!best) return false;
    best.focus();
    scrollIntoViewIfNeeded(best);
    return true;
}

function scrollIntoViewIfNeeded(el) {
    try {
        el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    } catch (e) { /* ignore */ }
}
