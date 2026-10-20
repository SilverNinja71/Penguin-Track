// Replays: saved runs plus the auto-saved personal bests. Watch (deterministic
// re-simulation), race against one as a ghost, open it in the TAS Studio, and
// share runs as PTR1 codes.
import { formatTime } from '../core/format.js';
import { trackHash } from '../core/codec.js';
import { h, niceDate, copyText } from './dom.js';
import { icon } from './icons.js';
import { listReplays, deleteReplay, renameReplay, saveReplay, allRecords } from './records.js';
import { encodeReplayCodeAsync, decodeReplayText } from './replaycode.js';
import { showCodeDialog } from './ui.js';

const replays = {
    id: 'replays',
    shell: true,

    enter(app) {
        this.app = app;
        app.backdrop.start();
        app.setMusic(true);
        this.listEl = h('div.rep-list.pt-scroll');
        this.el = h('div.pt-screen.replays-screen',
            h('header.list-head',
                h('button.pt-btn.small.ghost', { type: 'button', 'data-sound': 'back', onclick: () => this.back() }, icon('back', 18), 'Menu'),
                h('h1.pt-title', 'Replays'),
                h('div.pt-spacer'),
                h('button.pt-btn', { type: 'button', onclick: () => this.importCode() }, icon('import', 18), 'Import code')),
            h('div.list-wrap.pt-panel', this.listEl));
        app.ui.appendChild(this.el);
        this.render();
    },

    /** The track a replay belongs to (embedded for custom tracks, else by id), or null. */
    trackFor(entry) {
        if (entry.track) return entry.track;
        return this.app.catalog.getTrack(entry.trackId);
    },

    render() {
        const app = this.app;
        const cat = app.catalog;
        const saved = listReplays(app.storage);
        const recs = allRecords(app.storage);
        const pbs = Object.keys(recs).filter((id) => recs[id] && recs[id].replay && Number.isFinite(recs[id].bestMs)).map((id) => {
            const r = recs[id];
            const t = cat.getTrack(id);
            return {
                id: 'pb:' + id, pb: true, name: 'Personal best', trackId: id, trackName: t ? t.name : id,
                replay: r.replay, timeMs: r.bestMs, respawns: r.respawns || 0, medal: r.medal, date: r.date,
                stale: !t || (r.trackHash && trackHash(t) !== r.trackHash),
            };
        }).sort((a, b) => (b.date || 0) - (a.date || 0));
        this.listEl.replaceChildren();
        const section = (title, items, empty) => {
            this.listEl.appendChild(h('h2.list-section', title, h('span.pt-muted', ` ${items.length}`)));
            if (!items.length) this.listEl.appendChild(h('p.list-empty.pt-muted', empty));
            for (const it of items) this.listEl.appendChild(this.row(it));
        };
        section('Saved replays', saved, 'No saved replays yet. Finish a run and press Save replay, or import a code from a friend.');
        section('Personal bests', pbs, 'Your best run on every track is kept here automatically.');
        const first = this.listEl.querySelector('button');
        if (first) requestAnimationFrame(() => first.focus({ preventScroll: true }));
    },

    row(it) {
        const app = this.app;
        const track = this.trackFor(it);
        const missing = !track;
        const B = (label, iconName, onclick, cls = '') => h('button.pt-btn.small', { type: 'button', class: cls, onclick, disabled: missing && label !== 'Delete' && label !== 'Export' }, icon(iconName, 16), label);
        const actions = [
            B('Watch', 'play', () => this.watch(it), 'primary'),
            B('Race ghost', 'ghost', () => this.race(it)),
            B('TAS Studio', 'tas', () => app.goto('tas', { track, replay: it.replay })),
            B('Export', 'export', () => this.exportCode(it)),
        ];
        if (!it.pb) {
            actions.push(B('Rename', 'edit', () => this.rename(it)));
            actions.push(B('Delete', 'trash', () => this.remove(it), 'danger'));
        }
        const name = it.pb ? it.trackName : it.name || it.trackName;
        const trackName = it.trackName || it.trackId;
        return h('div.list-row', { class: it.stale ? 'stale' : '' },
            h('span.pt-medal', { class: it.medal || 'none' }),
            h('div.list-row-main',
                h('div.list-row-title', name),
                h('div.list-row-sub.pt-muted',
                    it.pb || name.includes(trackName) ? '' : `${trackName} · `,
                    h('span.pt-mono', Number.isFinite(it.timeMs) ? formatTime(it.timeMs) : 'did not finish'),
                    it.respawns ? ` · ${it.respawns} resp.` : '',
                    it.date ? ` · ${niceDate(it.date)}` : '',
                    missing ? ' · track not found' : it.stale ? ' · older track layout' : '')),
            h('div.list-row-actions', actions));
    },

    watch(it) {
        const track = this.trackFor(it);
        if (!track) return;
        const replay = { ...it.replay, name: it.pb ? `Personal best on ${it.trackName}` : it.name || it.replay.name };
        this.app.goto('play', { track, mode: 'replay', replay, onExit: () => this.app.goto('replays') });
    },

    race(it) {
        const track = this.trackFor(it);
        if (!track) return;
        const cat = this.app.catalog;
        this.app.goto('play', {
            track, mode: cat.isCampaign(track.id) ? 'campaign' : 'custom',
            ghosts: [{ replay: it.replay, label: it.name || 'Ghost' }],
        });
    },

    async exportCode(it) {
        const cat = this.app.catalog;
        const track = this.trackFor(it);
        const embed = track && !cat.isOfficial(track.id) ? track : null;
        const code = await encodeReplayCodeAsync(it.replay, embed, { name: it.name, trackName: it.trackName });
        showCodeDialog('Replay code', code, {
            message: 'Send this code to a friend. They can watch the run or race its ghost from their Replays screen.',
            copy: async (c) => this.app.toast(await copyText(c) ? 'Code copied' : 'Copy failed: select the text and copy it', { icon: 'copy' }),
        });
    },

    async importCode() {
        const app = this.app;
        const text = await app.prompt('Import a replay', {
            message: 'Paste a replay code (it starts with PTR), or a replay or AI model .json from the TAS and AI tools.',
            multiline: true, placeholder: 'PTR2.…', ok: 'Import', file: '.json,.txt',
        });
        if (!text) return;
        let data;
        try {
            data = await decodeReplayText(text);
        } catch (e) {
            app.toast(e.message, { kind: 'bad', ms: 4000 });
            return;
        }
        const cat = app.catalog;
        const r = data.replay;
        const track = data.track || cat.getTrack(r.trackId);
        if (!track) {
            app.toast(`This replay is for a track you don't have (${r.trackId}).`, { kind: 'bad', ms: 4000 });
            return;
        }
        if (r.trackHash && trackHash(track) !== r.trackHash) {
            app.toast('This replay was recorded on a different version of that track.', { kind: 'bad', ms: 4000 });
            return;
        }
        const respawns = (r.respawnTicks || []).length;
        const finished = r.finished && Number.isFinite(r.timeMs);
        const entry = saveReplay(app.storage, {
            name: data.name || `${track.name} ${finished ? formatTime(r.timeMs) : '(unfinished)'}`,
            trackId: track.id, trackName: track.name,
            track: cat.isOfficial(track.id) ? undefined : track,
            replay: r, timeMs: finished ? r.timeMs : null, respawns,
            medal: finished ? cat.medalFor(track, { timeMs: r.timeMs, respawns }) : null,
        });
        if (!entry) {
            app.toast('Storage is full: delete some replays first.', { kind: 'bad' });
            return;
        }
        app.toast('Replay imported', { icon: 'import' });
        this.render();
    },

    async rename(it) {
        const name = await this.app.prompt('Rename replay', { value: it.name || '', maxLength: 60, ok: 'Rename' });
        if (name == null) return;
        renameReplay(this.app.storage, it.id, name.trim() || it.name);
        this.render();
    },

    async remove(it) {
        const ok = await this.app.confirm(`Delete the replay "${it.name || it.trackName}"? This can't be undone.`, { ok: 'Delete', danger: true, title: 'Delete replay' });
        if (!ok) return;
        deleteReplay(this.app.storage, it.id);
        this.app.toast('Replay deleted', { icon: 'trash' });
        this.render();
    },

    back() {
        this.app.goto('menu');
    },

    exit() {
        this.el = null;
    },
};

export default replays;
