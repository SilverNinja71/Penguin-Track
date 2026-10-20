// The three-category leaderboard of one track as a tabbed panel: Pure Run
// (unassisted), Best TAS (Quick TAS or the Studio) and Best AI (AI Lab and the
// autopilot). Each tab lists that board's top runs and what made them, and has
// a switch to race the board leader's ghost (any mix of the three at once).
import { formatTime } from '../core/format.js';
import { h, toggleClass } from './dom.js';
import { BOARD_CATEGORIES, CATEGORY_INFO, getBoards, entryLabel } from './records.js';
import { CATEGORY_GHOSTS } from './ghost.js';

const EMPTY_HINTS = {
    pure: 'No runs yet: race the track!',
    tas: 'No TAS runs yet: try Quick TAS (TAS in the menu) and rewind your way to a perfect run.',
    ai: 'No AI runs yet: train a driver in the AI Lab.',
};

// The tab last looked at, kept while the page is open.
let lastTab = 'pure';

function fmtDate(ms) {
    if (!ms) return '';
    try {
        return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } catch (e) {
        return '';
    }
}

/**
 * The panel for `track` (catalog info or track JSON with an id) on the layout
 * `hash`. opts.onGhosts() runs after a ghost switch changed the settings.
 */
export function leaderboardPanel(app, track, hash, opts = {}) {
    const boards = getBoards(app.storage, app.catalog, track, hash);
    const platform = track.mode === 'platform';
    const settings = app.settings;
    const tabs = {}, panes = {};
    const tablist = h('div.lb-tabs', { role: 'tablist', 'aria-label': 'Leaderboard' });
    const root = h('section.lb', { 'aria-label': `${track.name || track.id} leaderboard` }, tablist);

    const show = (c) => {
        lastTab = c;
        for (const k of BOARD_CATEGORIES) {
            const on = k === c;
            toggleClass(tabs[k], 'active', on);
            tabs[k].setAttribute('aria-selected', String(on));
            tabs[k].tabIndex = on ? 0 : -1;
            toggleClass(panes[k], 'pt-hidden', !on);
        }
    };

    for (const c of BOARD_CATEGORIES) {
        const info = CATEGORY_INFO[c], ghost = CATEGORY_GHOSTS[c];
        const list = boards[c];
        const id = `lb-${c}-${Math.random().toString(36).slice(2, 8)}`;
        tabs[c] = h('button.lb-tab', {
            type: 'button', role: 'tab', id: `${id}-tab`, 'aria-controls': id, style: { '--ghost': ghost.color },
            onclick: () => show(c),
            onkeydown: (e) => {
                if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
                e.preventDefault();
                e.stopPropagation();
                const i = BOARD_CATEGORIES.indexOf(c) + (e.key === 'ArrowRight' ? 1 : -1);
                const next = BOARD_CATEGORIES[(i + BOARD_CATEGORIES.length) % BOARD_CATEGORIES.length];
                show(next);
                tabs[next].focus();
            },
        }, h('span.lb-dot'), info.label, list.length ? h('span.lb-best.pt-mono', formatTime(list[0].timeMs)) : null);
        tablist.appendChild(tabs[c]);

        const row = (e, i) => {
            const what = entryLabel(e) + (e.model ? ` · ${e.model}` : '')
                + (Number.isFinite(e.rewinds) ? ` · ${e.rewinds} rewind${e.rewinds === 1 ? '' : 's'}` : '');
            return h('li.lb-row', { class: i === 0 ? 'lead' : '' },
                h('span.lb-rank.pt-mono', `${i + 1}`),
                h('span.lb-time.pt-mono', formatTime(e.timeMs)),
                h('span.lb-label', { title: what }, what),
                platform || e.respawns ? h('span.lb-resp.pt-muted', `${e.respawns || 0} resp.`) : null,
                h('span.lb-date.pt-muted', fmtDate(e.date)));
        };
        const rows = list.length ? h('ol.lb-list', list.map(row)) : h('p.lb-empty.pt-muted', EMPTY_HINTS[c]);
        const has = list.length && list[0].replay;
        const ghostBtn = h('button.pt-btn.small.lb-ghost', {
            type: 'button', 'aria-pressed': String(!!settings[ghost.setting]), style: { '--ghost': ghost.color },
            title: has ? `Race the ${info.label} ghost` : 'The ghost shows once this board has a run',
            onclick: () => {
                settings[ghost.setting] = !settings[ghost.setting];
                ghostBtn.setAttribute('aria-pressed', String(settings[ghost.setting]));
                app.saveSettings();
                if (opts.onGhosts) opts.onGhosts();
            },
        }, h('span.lb-dot'), `${ghost.label} ghost`);
        panes[c] = h('div.lb-pane', { role: 'tabpanel', id, 'aria-labelledby': `${id}-tab` },
            h('p.lb-hint.pt-muted', info.hint),
            rows,
            h('div.lb-foot', ghostBtn));
        root.appendChild(panes[c]);
    }
    show(BOARD_CATEGORIES.includes(opts.tab) ? opts.tab : lastTab);
    return root;
}
