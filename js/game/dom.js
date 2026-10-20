// Tiny DOM helpers shared by every shell screen.

/**
 * h('div.pt-panel.menu', { onclick, title, dataset: {…}, style: {…} }, ...children)
 * Classes and an id may ride on the tag ('button#go.pt-btn.primary'). Children may
 * be nodes, strings, numbers, arrays, or null/false (skipped). `html` sets trusted markup.
 */
export function h(tag, props, ...children) {
    const m = /^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i.exec(tag);
    const el = document.createElement((m && m[1]) || 'div');
    if (m && m[2]) {
        for (const part of m[2].match(/[.#][\w-]+/g)) {
            if (part[0] === '.') el.classList.add(part.slice(1));
            else el.id = part.slice(1);
        }
    }
    if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
        children.unshift(props);
        props = null;
    }
    if (props) {
        for (const [k, v] of Object.entries(props)) {
            if (v == null || v === false) continue;
            if (k === 'class' || k === 'className') {
                for (const c of String(v).split(/\s+/)) if (c) el.classList.add(c);
            } else if (k === 'style' && typeof v === 'object') {
                for (const [sk, sv] of Object.entries(v)) {
                    if (sk.startsWith('--')) el.style.setProperty(sk, sv);
                    else el.style[sk] = sv;
                }
            } else if (k === 'dataset') {
                Object.assign(el.dataset, v);
            } else if (k === 'html') {
                el.innerHTML = v;
            } else if (k.startsWith('on') && typeof v === 'function') {
                el.addEventListener(k.slice(2).toLowerCase(), v);
            } else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') {
                el[k] = v;
            } else {
                el.setAttribute(k, v === true ? '' : String(v));
            }
        }
    }
    append(el, children);
    return el;
}

export function append(el, children) {
    for (const c of children) {
        if (c == null || c === false || c === true) continue;
        if (Array.isArray(c)) append(el, c);
        else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
}

/** Sets textContent only when it changed (HUD updates run every frame). */
export function setText(el, text) {
    const t = String(text);
    if (el.textContent !== t) el.textContent = t;
}

export function toggleClass(el, cls, on) {
    if (el.classList.contains(cls) !== !!on) el.classList.toggle(cls, !!on);
}

/** Copies text to the clipboard; falls back to a hidden textarea. Resolves true on success. */
export async function copyText(text) {
    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch (e) { /* fall through */ }
    const ta = h('textarea', { style: { position: 'fixed', left: '-9999px', top: '0' } });
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
        ok = document.execCommand('copy');
    } catch (e) { /* ignore */ }
    ta.remove();
    return ok;
}

/** Friendly relative date: 'today', 'yesterday', '3 days ago', or a short date. */
export function niceDate(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return '';
    const day = 86400000;
    const startToday = new Date();
    startToday.setHours(0, 0, 0, 0);
    const diff = startToday.getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    if (diff <= 0) return 'today';
    if (diff <= day) return 'yesterday';
    if (diff < 7 * day) return `${Math.round(diff / day)} days ago`;
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function isTypingTarget(t) {
    if (!t || !t.tagName) return false;
    if (t.isContentEditable) return true;
    const tag = t.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag !== 'INPUT') return false;
    const type = (t.type || 'text').toLowerCase();
    return !['checkbox', 'radio', 'range', 'button', 'submit', 'reset', 'color'].includes(type);
}
