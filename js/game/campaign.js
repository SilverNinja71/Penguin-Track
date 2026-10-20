// Campaign: Race / Platform / Training tabs, tier rows in their colours and a
// card per track (id, name, mood, personal best, medal). The detail panel shows
// the medal targets of the hovered or focused track, its three-category
// leaderboard (Pure Run / Best TAS / Best AI) and Race / Quick TAS buttons.
import { formatTime } from '../core/format.js';
import { trackHash } from '../core/codec.js';
import { h } from './dom.js';
import { icon, iconSvg, MOOD_LABELS } from './icons.js';
import { allRecords } from './records.js';
import { leaderboardPanel } from './leaderboard.js';

const TAB_LABELS = { race: 'Race', platform: 'Platform', training: 'Training' };
const TAB_ICONS = { race: 'flag', platform: 'snowflake', training: 'penguin' };

const campaign = {
    id: 'campaign',
    shell: true,
    tab: null,

    enter(app, params = {}) {
        this.app = app;
        app.backdrop.start();
        app.setMusic(true);
        const cat = app.catalog;
        this.campaigns = cat.campaigns();
        this.records = allRecords(app.storage);
        this.hashes = new Map();
        const want = params.select ? cat.info(params.select) : null;
        if (want) this.tab = want.campaign;
        if (!this.tab || !this.campaigns.some((c) => c.id === this.tab)) this.tab = this.campaigns[0] ? this.campaigns[0].id : 'race';

        this.tabsEl = h('div.camp-tabs', { role: 'tablist', 'aria-label': 'Campaigns' });
        this.bodyEl = h('div.camp-body.pt-scroll');
        this.detailEl = h('aside.camp-detail.pt-panel', { 'aria-live': 'polite' });
        this.el = h('div.pt-screen.campaign-screen',
            h('header.camp-head',
                h('button.pt-btn.small.ghost', { type: 'button', 'data-sound': 'back', onclick: () => this.back() }, icon('back', 18), 'Menu'),
                h('h1.pt-title', 'Play'),
                this.tabsEl,
                h('div.pt-spacer'),
                h('div.camp-keys.pt-muted', h('span.pt-kbd', 'Q'), h('span.pt-kbd', 'E'), ' switch tabs')),
            h('div.camp-main', this.bodyEl, this.detailEl));
        app.ui.appendChild(this.el);
        this.renderTabs();
        this.renderBody(params.select);
    },

    renderTabs() {
        this.tabsEl.replaceChildren(...this.campaigns.map((c) => h('button.pt-btn.camp-tab', {
            type: 'button', role: 'tab', 'aria-selected': String(c.id === this.tab), class: c.id === this.tab ? 'active' : '',
            onclick: () => this.setTab(c.id),
        }, icon(TAB_ICONS[c.id] || 'flag', 18), TAB_LABELS[c.id] || c.name)));
    },

    setTab(id, focus = true) {
        if (id === this.tab) return;
        this.tab = id;
        this.renderTabs();
        this.renderBody();
        if (focus) {
            const first = this.bodyEl.querySelector('.camp-card');
            if (first) first.focus({ preventScroll: true });
        }
    },

    _hash(id) {
        if (!this.hashes.has(id)) {
            const t = this.app.catalog.getTrack(id);
            this.hashes.set(id, t ? trackHash(t) : null);
        }
        return this.hashes.get(id);
    },

    _record(id) {
        const r = this.records[id];
        if (!r) return null;
        const stale = r.trackHash && r.trackHash !== this._hash(id);
        return { medal: r.medal || null, bestMs: stale ? null : r.bestMs, respawns: stale ? null : r.respawns };
    },

    renderBody(selectId = null) {
        const camp = this.campaigns.find((c) => c.id === this.tab);
        this.bodyEl.replaceChildren();
        let focusCard = null;
        const tiers = camp ? camp.tiers.filter((t) => t.tracks.length) : [];
        for (const tier of tiers) {
            let medals = 0;
            const cards = tier.tracks.map((info) => {
                const rec = this._record(info.id);
                if (rec && rec.medal) medals++;
                const card = this._card(info, rec);
                if (info.id === selectId) focusCard = card;
                return card;
            });
            this.bodyEl.appendChild(h('section.camp-tier', { style: { '--tier': tier.color } },
                h('div.camp-tier-head',
                    h('span.camp-tier-swatch'),
                    h('h2.camp-tier-name', tier.name),
                    h('span.camp-tier-progress.pt-muted', `${medals}/${tier.tracks.length} medals`)),
                h('div.camp-cards', cards)));
        }
        const target = focusCard || this.bodyEl.querySelector('.camp-card');
        if (target) {
            this.showDetail(target._info);
            requestAnimationFrame(() => {
                target.focus({ preventScroll: true });
                target.scrollIntoView({ block: 'nearest' });
            });
        }
    },

    _card(info, rec) {
        const cat = this.app.catalog;
        const medal = rec ? rec.medal : null;
        const pb = rec && Number.isFinite(rec.bestMs) ? formatTime(rec.bestMs) : '—';
        const tags = [];
        if (info.laps > 1) tags.push(h('span.pt-tag', `${info.laps} laps`));
        if (info.mode === 'platform' && rec && Number.isFinite(rec.respawns)) tags.push(h('span.pt-tag', `${rec.respawns} resp.`));
        const card = h('button.camp-card', {
            type: 'button',
            class: medal ? `has-${medal}` : '',
            'aria-label': `${info.id} ${info.name}. Best ${pb}. ${medal ? cat.medalLabel(medal) + ' medal' : 'No medal'}.`,
            onclick: () => this.play(info.id),
            onfocus: () => this.showDetail(info),
            onmouseenter: () => this.showDetail(info),
        },
        h('div.camp-card-top',
            h('span.camp-card-id.pt-mono', info.id),
            h('span.camp-card-mood', { title: MOOD_LABELS[info.mood] || info.mood, html: iconSvg(info.mood || 'day', 18) })),
        h('div.camp-card-name', info.name),
        h('div.camp-card-foot',
            h('span.pt-medal', { class: medal || 'none' }),
            h('span.camp-card-pb.pt-mono', pb),
            tags));
        card._info = info;
        return card;
    },

    showDetail(info) {
        const app = this.app;
        const cat = app.catalog;
        const el = this.detailEl;
        el.replaceChildren();
        if (!info) {
            el.classList.add('empty');
            return;
        }
        el.classList.remove('empty');
        this.selected = info.id;
        const rec = this._record(info.id);
        const targets = cat.medalTargets(info);
        const haveRank = cat.medalRank(rec ? rec.medal : null);
        let next = null;
        for (let i = targets.length - 1; i >= 0; i--) {
            if (cat.medalRank(targets[i].medal) < haveRank) {
                next = targets[i].medal;
                break;
            }
        }
        el.append(
            h('div.camp-detail-head', { style: { '--tier': info.color } },
                h('span.camp-card-id.pt-mono', info.id),
                h('span.camp-detail-tier', info.tierName || '')),
            h('h2.camp-detail-name', info.name),
            info.description ? h('p.camp-detail-desc.pt-muted', info.description) : null,
            h('div.camp-detail-meta',
                h('span.pt-tag', { html: iconSvg(info.mood || 'day', 14) + (MOOD_LABELS[info.mood] || info.mood) }),
                info.mode === 'platform' ? h('span.pt-tag', 'Platform: fewest respawns') : null,
                info.laps > 1 ? h('span.pt-tag', `${info.laps} laps`) : null),
            h('div.camp-detail-pb',
                h('span.pt-muted', 'Personal best'),
                h('span.pt-mono', rec && Number.isFinite(rec.bestMs) ? formatTime(rec.bestMs) : '—'),
                rec && rec.medal ? h('span.pt-medal', { class: rec.medal }) : null),
            targets.length
                ? h('div.camp-targets', targets.map((t) => h('div.camp-target', {
                    class: (cat.medalRank(t.medal) >= haveRank ? 'got' : '') + (t.medal === next ? ' next' : ''),
                }, h('span.pt-medal', { class: t.medal }), h('span', t.label), h('span.camp-target-text', t.text),
                t.medal === next ? h('span.camp-next', 'next') : null)))
                : h('p.pt-muted', 'No medal times for this track.'),
            leaderboardPanel(app, info, this._hash(info.id)),
            h('div.camp-actions',
                h('button.pt-btn.primary.camp-go', { type: 'button', onclick: () => this.play(info.id) }, icon('play', 20), 'Race'),
                h('button.pt-btn.camp-quick', {
                    type: 'button', title: 'Quick TAS: race with savestates (C mark, R rewind)', onclick: () => this.quickTas(info.id),
                }, icon('tas', 20), 'Quick TAS')));
    },

    play(id) {
        this.app.goto('play', { track: id, mode: 'campaign' });
    },

    quickTas(id) {
        const app = this.app;
        app.goto('play', {
            track: id, mode: 'campaign', quickTas: true, exitLabel: 'Back to tracks',
            onExit: () => app.goto('campaign', { select: id }),
        });
    },

    onKey(e) {
        const ids = this.campaigns.map((c) => c.id);
        const i = ids.indexOf(this.tab);
        if (e.key === 'q' || e.key === 'Q' || e.key === 'PageUp') {
            this.setTab(ids[(i + ids.length - 1) % ids.length]);
            return true;
        }
        if (e.key === 'e' || e.key === 'E' || e.key === 'PageDown') {
            this.setTab(ids[(i + 1) % ids.length]);
            return true;
        }
        return false;
    },

    back() {
        this.app.goto('menu');
    },

    exit() {
        this.el = null;
    },
};

export default campaign;
