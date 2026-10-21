// My Tracks: the player's own tracks (storage 'tracks'): race, edit, share as a
// PT1 code, delete, start a new one, or import a friend's share code.
import { formatTime } from '../core/format.js';
import { encodeTrack, decodeTrack, trackHash } from '../core/codec.js';
import { validateTrack, normalizeTrack } from '../core/track.js';
import { h, niceDate, copyText } from './dom.js';
import { icon, iconSvg, MOOD_LABELS } from './icons.js';
import { allRecords } from './records.js';
import { showCodeDialog } from './ui.js';
import { trackLink } from './links.js';

function newTrackId() {
    return 'c' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36);
}

const mytracks = {
    id: 'mytracks',
    shell: true,

    enter(app, params = {}) {
        this.app = app;
        app.backdrop.start();
        app.setMusic(true);
        this.listEl = h('div.rep-list.pt-scroll');
        this.el = h('div.pt-screen.mytracks-screen',
            h('header.list-head',
                h('button.pt-btn.small.ghost', { type: 'button', 'data-sound': 'back', onclick: () => this.back() }, icon('back', 18), 'Menu'),
                h('h1.pt-title', 'My Tracks'),
                h('div.pt-spacer'),
                h('button.pt-btn', { type: 'button', onclick: () => this.importCode() }, icon('import', 18), 'Import code'),
                h('button.pt-btn.primary', { type: 'button', onclick: () => app.goto('editor', {}) }, icon('plus', 18), 'New track')),
            h('div.list-wrap.pt-panel', this.listEl));
        app.ui.appendChild(this.el);
        this.render(params.select);
        // Opened from a track link (#track=PT1.…)
        if (params.importCode) this.importText(params.importCode);
    },

    tracks() {
        const all = this.app.storage.get('tracks', {}) || {};
        return Object.keys(all).filter((id) => all[id] && typeof all[id] === 'object')
            .map((id) => ({ ...normalizeTrack(all[id]), id, updated: all[id].updated || all[id].date || 0 }))
            .sort((a, b) => (b.updated || 0) - (a.updated || 0) || a.name.localeCompare(b.name));
    },

    render(selectId = null) {
        const list = this.tracks();
        const recs = allRecords(this.app.storage);
        this.listEl.replaceChildren();
        if (!list.length) {
            this.listEl.appendChild(h('div.list-blank',
                h('div.list-blank-icon', { html: iconSvg('map', 44) }),
                h('h2.pt-subtitle', 'No tracks of your own yet'),
                h('p.pt-muted', 'Build one in the editor, or paste a share code (PT1.…) from a friend.'),
                h('div.pt-row',
                    h('button.pt-btn.primary', { type: 'button', onclick: () => this.app.goto('editor', {}) }, icon('plus', 18), 'New track'),
                    h('button.pt-btn', { type: 'button', onclick: () => this.importCode() }, icon('import', 18), 'Import code'))));
            return;
        }
        let focus = null;
        for (const t of list) {
            const row = this.row(t, recs[t.id]);
            if (t.id === selectId) focus = row;
            this.listEl.appendChild(row);
        }
        const target = (focus || this.listEl).querySelector('button');
        if (target) requestAnimationFrame(() => target.focus({ preventScroll: true }));
    },

    row(t, rec) {
        const app = this.app;
        const hash = trackHash(t);
        const fresh = rec && (!rec.trackHash || rec.trackHash === hash);
        const pb = fresh && Number.isFinite(rec.bestMs) ? formatTime(rec.bestMs) : '—';
        const medal = rec ? rec.medal : null;
        const B = (label, iconName, onclick, cls = '') => h('button.pt-btn.small', { type: 'button', class: cls, onclick }, icon(iconName, 16), label);
        return h('div.list-row',
            h('span.list-row-mood', { title: MOOD_LABELS[t.mood], html: iconSvg(t.mood, 22) }),
            h('div.list-row-main',
                h('div.list-row-title', t.name, medal ? h('span.pt-medal', { class: medal }) : null),
                h('div.list-row-sub.pt-muted',
                    `by ${t.author} · ${t.blocks.length} blocks`,
                    t.mode === 'platform' ? ' · platform' : '',
                    t.laps > 1 ? ` · ${t.laps} laps` : '',
                    ' · best ', h('span.pt-mono', pb),
                    t.updated ? ` · ${niceDate(t.updated)}` : '')),
            h('div.list-row-actions',
                B('Play', 'play', () => this.play(t), 'primary'),
                B('Edit', 'edit', () => app.goto('editor', { track: t })),
                B('Copy link', 'link', () => this.copyLink(t)),
                B('Share code', 'copy', () => this.share(t)),
                B('Delete', 'trash', () => this.remove(t), 'danger')));
    },

    play(t) {
        const v = validateTrack(t);
        if (!v.ok) {
            this.app.toast(`Not raceable yet: ${v.errors[0]}`, { kind: 'bad', ms: 4200 });
            return;
        }
        this.app.goto('play', { track: t.id, mode: 'custom' });
    },

    share(t) {
        let code;
        try {
            code = encodeTrack(t);
        } catch (e) {
            this.app.toast(`Can't make a code: ${e.message}`, { kind: 'bad' });
            return;
        }
        showCodeDialog('Share code', code, {
            message: `Send the link: opening it adds "${t.name}" to your friend's My Tracks. The code works too, through My Tracks → Import code.`,
            copy: async (c) => this.app.toast(await copyText(c) ? 'Share code copied' : 'Copy failed: select the text and copy it', { icon: 'copy' }),
            link: trackLink(code),
            copyLink: async (l) => this.app.toast(await copyText(l) ? 'Track link copied' : 'Copy failed: select the text and copy it', { icon: 'link' }),
        });
    },

    /** One click: the whole track as a link on the clipboard. */
    async copyLink(t) {
        let code;
        try {
            code = encodeTrack(t);
        } catch (e) {
            this.app.toast(`Can't make a link: ${e.message}`, { kind: 'bad' });
            return;
        }
        const ok = await copyText(trackLink(code));
        this.app.toast(ok ? `Link to "${t.name}" copied: paste it to a friend` : 'Copy failed: use Share code instead', { icon: 'link', kind: ok ? undefined : 'bad' });
    },

    async remove(t) {
        const ok = await this.app.confirm(`Delete "${t.name}"? Its personal best stays, but the track itself is gone for good.`, { title: 'Delete track', ok: 'Delete', danger: true });
        if (!ok) return;
        this.app.storage.update('tracks', {}, (all) => {
            delete all[t.id];
            return all;
        });
        this.app.toast('Track deleted', { icon: 'trash' });
        this.render();
    },

    async importCode() {
        const app = this.app;
        const text = await app.prompt('Import a track', { message: 'Paste a share code (it starts with PT1.) or a track link.', multiline: true, placeholder: 'PT1.…', ok: 'Import' });
        if (!text) return;
        this.importText(text);
    },

    /** Imports a share code (or a track link holding one) into My Tracks. */
    importText(text) {
        const app = this.app;
        const inLink = /#track=(PT1\.[A-Za-z0-9_-]+)/.exec(text);
        if (inLink) text = inLink[1];
        let track;
        try {
            track = decodeTrack(text.trim());
        } catch (e) {
            app.toast("That share code is damaged. Copy the whole code and try again.", { kind: 'bad', ms: 4000 });
            return;
        }
        const all = app.storage.get('tracks', {}) || {};
        const hash = trackHash(track);
        const same = Object.keys(all).find((id) => {
            try {
                return trackHash(all[id]) === hash && all[id].name === track.name;
            } catch (e) {
                return false;
            }
        });
        if (same) {
            app.toast(`You already have "${track.name}"`, { icon: 'map' });
            this.render(same);
            return;
        }
        // Official ids and ids already in use get a fresh one, so nothing is overwritten.
        if (!track.id || all[track.id] || app.catalog.isReserved(track.id) || track.id === 'custom') track.id = newTrackId();
        track.updated = Date.now();
        all[track.id] = track;
        if (!app.storage.set('tracks', all)) {
            app.toast('Storage is full: delete a track or some replays first.', { kind: 'bad' });
            return;
        }
        const v = validateTrack(track);
        app.toast(v.ok ? `Imported "${track.name}"` : `Imported "${track.name}" (needs fixing before it can be raced)`, { icon: 'import', ms: 3200 });
        this.render(track.id);
    },

    back() {
        this.app.goto('menu');
    },

    exit() {
        this.el = null;
    },
};

export default mytracks;
