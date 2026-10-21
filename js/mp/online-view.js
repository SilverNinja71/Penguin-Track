// Online rooms: Trackmania-server style time attack over PeerJS. The host
// gets a short room code; friends join with it. In the lobby everyone chats
// and the host picks a track (official id, or a share code for anything
// else) and the round length. During a round everyone races on their own
// with unlimited retries, sees the others as labelled ghosts (~15 Hz poses),
// and the leaderboard shows best times the host has verified by re-simulating
// each run's replay. `?mp=local` opens a room without the network, with an
// autopilot bot, for testing.
import { buildWorld } from '../core/track.js';
import { encodeTrack, decodeTrack, trackHash } from '../core/codec.js';
import { verifyReplay, lerpCarSnapshot } from '../core/replay.js';
import { Autopilot } from '../core/autopilot.js';
import { formatTime } from '../core/format.js';
import { h, setText, copyText } from '../game/dom.js';
import { Hud } from '../game/hud.js';
import { GhostRun, makeCarView } from '../game/ghost.js';
import { CAMERAS } from '../game/settings.js';
import { ico, trackSelect, findTrackItem, loadPrefs, savePrefs, field, typing } from './common.js';
import { RoomHost, RoomClient, loopbackPair, PING_MS } from './room.js';
import { parseRoomCode, cleanName, makeRoomCode, LIMITS } from './protocol.js';
import { Racer, Countdown } from './racer.js';
import { pointsFor } from './scoring.js';
import { hostPeer, joinPeer } from './net.js';
import { roomLink } from '../game/links.js';

const ROUND_CHOICES = [2, 3, 4, 5, 8];
const POSE_EVERY = 7;          // ticks: ~14 Hz
const AUTO_RETRY = 160;        // ticks after the finish before the next run starts
const REMOTE_STALE_MS = 3000;
const REMOTE_COLORS = ['#4fd18a', '#ffd54a', '#c48bff', '#ff9f4a', '#6fe3e0', '#ff7ab8', '#9cc8ff', '#f4f9ff'];

let session = null;            // the live room (survives tab switches only through the guard in mp.js)

export function onlineActive() {
    return !!(session && !session.closed);
}

/** The live room (debugging: __pt.screen.room()). */
export function onlineSession() {
    return session;
}

// ------------------------------------------------------------------ session

class OnlineSession {
    constructor(app, name) {
        this.app = app;
        this.name = name;
        this.host = null;
        this.client = null;
        this.net = null;
        this.closed = false;
        this.listeners = new Set();
        this.timers = [];
        this.worlds = new Map();     // track hash -> { track, world }
        this.bot = null;
        // Closing the tab says goodbye at once instead of waiting for a timeout.
        this._onHide = () => this.leave();
        window.addEventListener('pagehide', this._onHide);
    }

    on(f) {
        this.listeners.add(f);
        return () => this.listeners.delete(f);
    }

    _emit(type, m) {
        for (const f of [...this.listeners]) f(type, m);
    }

    /** Resolves a round's track reference into { track, world } (cached by hash). */
    resolve(ref) {
        if (!ref) throw new Error('No track');
        if (ref.hash && this.worlds.has(ref.hash)) return this.worlds.get(ref.hash);
        let track;
        if (ref.code) {
            track = decodeTrack(ref.code);
            if (track.id === 'custom' || !track.id) track.id = 'room-' + ref.hash.slice(0, 8);
        } else {
            track = this.app.catalog.getTrack(ref.id);
            if (!track) throw new Error(`You don't have the track ${ref.id}.`);
        }
        const hash = trackHash(track);
        if (ref.hash && hash !== ref.hash) throw new Error("Your copy of this track differs from the host's (another game version?).");
        const world = buildWorld(track);
        if (!world.spawn || !world.route) throw new Error("This track can't be finished.");
        const entry = { track, world };
        this.worlds.set(hash, entry);
        return entry;
    }

    /** Opens a room: on a fresh code, or on `want` (a party leader's code from a link). */
    async create(want = null) {
        const app = this.app;
        const local = app.query.get('mp') === 'local';
        let code;
        if (local) {
            code = want || makeRoomCode();
        } else {
            this.net = await hostPeer(want);
            code = this.net.code;
        }
        this.code = code;
        this.host = new RoomHost({
            code,
            // Re-simulate claimed runs a moment later, off the message handler.
            verify: (ref, replay) => new Promise((resolve) => setTimeout(() => {
                try {
                    resolve(verifyReplay(this.resolve(ref).world, replay));
                } catch (e) {
                    resolve({ ok: false, reason: e.message });
                }
            }, 0)),
            platform: (ref) => {
                try {
                    return this.resolve(ref).track.mode === 'platform';
                } catch (e) {
                    return false;
                }
            },
        });
        if (this.net) this.net.onConnection((conn) => this.host.addConnection(conn));
        const [hostEnd, mine] = loopbackPair('local', 'host');
        this.host.addConnection(hostEnd, { host: true });
        this._client(mine);
        this.timers.push(setInterval(() => this.host && this.host.update(), 400));
        if (local) this.bot = new LocalBot(this);
    }

    async join(code) {
        this.net = await joinPeer(code);
        this.code = code;
        this._client(this.net.conn);
        // No welcome within a few seconds: the far side is not a Penguintrack room.
        await new Promise((resolve, reject) => {
            const t0 = Date.now();
            const check = () => {
                if (this.client.you) return resolve();
                if (this.client.rejected || this.client.closed) return reject(new Error(this.client.rejected || 'The room closed the connection.'));
                if (Date.now() - t0 > 8000) return reject(new Error('The room did not say hello back.'));
                setTimeout(check, 100);
            };
            check();
        });
    }

    _client(conn) {
        this.client = new RoomClient({ conn, name: this.name, onEvent: (t, m) => this._emit(t, m) });
        this.timers.push(setInterval(() => {
            const c = this.client;
            if (!c || c.closed) return;
            c.ping();
            if (c.stale()) {
                c.rejected = c.rejected || 'Lost the connection to the room.';
                c.leave();
                this._emit('closed', { reason: c.rejected });
            }
        }, PING_MS));
    }

    leave() {
        if (this.closed) return;
        this.closed = true;
        window.removeEventListener('pagehide', this._onHide);
        for (const t of this.timers) clearInterval(t);
        if (this.bot) this.bot.stop();
        if (this.client) this.client.leave();
        if (this.host) this.host.close();
        if (this.net) setTimeout(() => this.net.destroy(), 300);
        this.listeners.clear();
        if (session === this) session = null;
    }
}

/** ?mp=local: a bot that joins the room over the loopback and drives the autopilot. */
class LocalBot {
    constructor(sess) {
        this.sess = sess;
        const [hostEnd, mine] = loopbackPair('bot', 'host');
        sess.host.addConnection(hostEnd);
        this.client = new RoomClient({ conn: mine, name: 'Snowbot', onEvent: (t) => { if (t === 'round') this._round(); } });
        this.timer = setInterval(() => this._drive(), 70);
        this.pinger = setInterval(() => this.client.ping(), PING_MS);
        this.racer = null;
    }

    _round() {
        const r = this.client.round;
        this.racer = null;
        if (r.state !== 'racing') return;
        try {
            const { world } = this.sess.resolve(r.track);
            this.racer = new Racer(world, { name: 'Snowbot' });
            this.pilot = new Autopilot(world);
            this.wait = 160;   // a countdown of its own, so it starts next to the host
        } catch (e) { /* the bot sits this one out */ }
    }

    _drive() {
        const R = this.racer;
        if (!R || this.client.closed) return;
        if (this.wait > 0) {
            this.wait -= 7;
            if (this.wait <= 0) R.go();
            return;
        }
        for (let i = 0; i < 7; i++) {
            if (R.state === 'racing') R.step(this.pilot.act(R.sim));
            else R.step(null);
        }
        const c = R.sim.car;
        this.client.sendPose(R.run, R.sim.tick, c.pos, c.quat, c.speedKmh);
        if (R.state === 'finished' && !R.sent) {
            R.sent = true;
            this.client.sendFinish(R.result.replay, R.result.respawns);
        }
        if (R.state === 'finished' && R.finishTicks > 200) {
            R.reset();
            this.pilot.reset();
            R.go();
        }
    }

    stop() {
        clearInterval(this.timer);
        clearInterval(this.pinger);
        this.client.leave();
    }
}

// ------------------------------------------------------------------ view

export function createOnlineView(app, nav) {
    const prefs = loadPrefs(app);
    const ui = {
        name: cleanName(prefs.onlineName || (app.account() && app.account().username) || ''),
        code: '',
        status: '',
        busy: false,
        hostTrack: prefs.onlineTrack && findTrackItem(app, prefs.onlineTrack) ? prefs.onlineTrack : 'A01',
        minutes: ROUND_CHOICES.includes(prefs.onlineMinutes) ? prefs.onlineMinutes : 3,
    };
    if (ui.name === 'Penguin' && !prefs.onlineName) ui.name = 'Penguin ' + Math.floor(Math.random() * 90 + 10);
    // Opened from an invite link (?room=CODE, see game/links.js): act on it once.
    let link = app.params && app.params.room ? { code: app.params.room, host: !!app.params.host } : null;
    if (link) app.params.room = null;
    let race = null;
    let off = null;
    let lastRound = 0;
    const view = {
        el: h('div.mp-view.mp-online'),
        dispose(final = false) {
            if (race) race.dispose();
            race = null;
            if (off) off();
            off = null;
            if (final && session) session.leave();
        },
        back() {
            if (race) {
                race.escape();
                return true;
            }
            return false;
        },
        onKey(e) {
            return race ? race.onKey(e) : false;
        },
    };

    const focusFirst = () => {
        const f = view.el.querySelector('[data-autofocus]');
        if (f) requestAnimationFrame(() => f.isConnected && f.focus({ preventScroll: true }));
    };

    // ---- entry: name, create, join
    const renderEntry = () => {
        const nameIn = h('input.pt-input', { value: ui.name, maxlength: LIMITS.name, 'aria-label': 'Your name', oninput: (e) => { ui.name = e.target.value; } });
        const codeIn = h('input.pt-input.mp-code-input', {
            value: ui.code, maxlength: 12, placeholder: 'ABCDE', 'aria-label': 'Room code', autocomplete: 'off', spellcheck: 'false',
            oninput: (e) => { ui.code = e.target.value; },
            onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); join(); } },
        });
        const status = h('p.mp-status', { role: 'status', class: ui.status ? '' : 'pt-hidden' }, ui.status);
        const busy = (on, text) => {
            ui.busy = on;
            ui.status = text || '';
            for (const b of view.el.querySelectorAll('button')) b.disabled = on;
            status.textContent = ui.status;
            status.classList.toggle('pt-hidden', !ui.status);
            status.classList.toggle('bad', !on && !!text);
        };
        const start = async (fn, wait) => {
            const name = cleanName(ui.name);
            ui.name = name;
            savePrefs(app, { onlineName: name });
            busy(true, wait);
            const s = new OnlineSession(app, name);
            try {
                await fn(s);
            } catch (e) {
                s.leave();
                busy(false, e.message || String(e));
                return;
            }
            session = s;
            ui.status = '';
            renderRoom();
        };
        const create = () => start((s) => s.create(), 'Opening a room…');
        const join = () => {
            const code = parseRoomCode(ui.code);
            if (!code) return busy(false, `Room codes are ${5} letters and digits, like K7QPA.`);
            start((s) => s.join(code), `Knocking on room ${code}…`);
        };
        view.el.replaceChildren(h('div.mp-columns',
            h('section.pt-panel.mp-card',
                h('h2.pt-subtitle', ico('link', 22), 'Online time attack'),
                h('p.pt-muted.mp-lead', 'Like a Trackmania server: everyone drives the same track for a few minutes with unlimited retries, sees the others as ghosts, and the best verified time wins the round.'),
                field('Your name', nameIn),
                h('div.pt-row.mp-actions',
                    h('button.pt-btn.primary.big', { type: 'button', 'data-autofocus': true, onclick: create }, ico('plus', 22), 'Create room')),
                status),
            h('section.pt-panel.mp-card',
                h('h3.mp-card-title', 'Join a friend'),
                field('Room code', codeIn),
                h('div.pt-row.mp-actions', h('button.pt-btn', { type: 'button', onclick: join }, ico('next', 20), 'Join room')),
                h('p.pt-muted.mp-small', 'Peer to peer: times and ghosts go straight between browsers (PeerJS helps you find each other). Only your name, car position, chat and your best runs are sent.'))));
        focusFirst();
        if (link && !session) {
            const l = link;
            link = null;
            const code = parseRoomCode(l.code);
            if (!code) busy(false, `That invite link's room code (${l.code}) doesn't read. Ask for a fresh link.`);
            else if (l.host) start((s) => s.create(code), `Opening room ${code}…`);
            else {
                // The host may still be opening the room (a party arrives together): keep knocking for a while.
                ui.code = code;
                codeIn.value = code;
                start(async (s) => {
                    for (let i = 0; ; i++) {
                        try {
                            return await s.join(code);
                        } catch (e) {
                            if (i >= 5 || !/No room/i.test(e.message || '')) throw e;
                            busy(true, `Waiting for room ${code} to open…`);
                            await new Promise((r) => setTimeout(r, 2500));
                        }
                    }
                }, `Knocking on room ${code}…`);
            }
        }
    };

    // ---- lobby and race
    const renderRoom = () => {
        if (!session) return renderEntry();
        if (off) off();
        const s = session;
        lastRound = s.client.round.n;
        off = s.on((type, m) => {
            if (type === 'closed') {
                const why = (m && m.reason) || 'The room closed.';
                app.toast(why, { kind: 'bad', ms: 4500 });
                view.dispose(true);
                nav.fullscreen(false);
                nav.menus();
                ui.status = why;
                renderEntry();
                return;
            }
            if (type === 'round') {
                const r = s.client.round;
                // A new round pulls everyone onto the track, like a server map change.
                if (r.state === 'racing' && r.n !== lastRound) {
                    lastRound = r.n;
                    enterRace();
                    return;
                }
                lastRound = r.n;
            }
            if (race) race.onRoom(type, m);
            else if (lobby) lobby.update(type);
        });
        if (s.client.round.state === 'racing' && !race) enterRace();
        else showLobby();
    };

    let lobby = null;
    const showLobby = () => {
        if (race) race.dispose();
        race = null;
        nav.fullscreen(false);
        nav.menus();
        lobby = buildLobby(app, session, ui, { enterRace, leave: leaveRoom });
        view.el.replaceChildren(lobby.el);
        focusFirst();
    };

    const enterRace = () => {
        const s = session;
        let entry;
        try {
            entry = s.resolve(s.client.round.track);
        } catch (e) {
            app.toast(e.message, { kind: 'bad', ms: 5000 });
            if (!race) showLobby();
            return;
        }
        if (app.renderer.isNull) {
            app.toast('Racing needs a 3D view (WebGL). You can still chat in the lobby.', { kind: 'bad' });
            if (!race) showLobby();
            return;
        }
        if (race) race.dispose();
        lobby = null;
        nav.fullscreen(true);
        race = new OnlineRace(app, s, entry, { toLobby: showLobby, leave: leaveRoom });
        view.el.replaceChildren(race.el);
        race.start();
    };

    const leaveRoom = async () => {
        if (!(await app.confirm(session && session.host ? 'Close the room? Everyone in it is sent home.' : 'Leave the room?', { ok: session && session.host ? 'Close room' : 'Leave' }))) return;
        view.dispose(true);
        nav.fullscreen(false);
        nav.menus();
        renderEntry();
    };

    if (onlineActive()) renderRoom();
    else renderEntry();
    return view;
}

// ------------------------------------------------------------------ lobby

function buildLobby(app, s, ui, { enterRace, leave }) {
    const c = s.client;
    const isHost = !!s.host;
    const playersEl = h('ul.mp-roster');
    const chatLog = h('div.mp-chat-log.pt-scroll', { role: 'log', 'aria-live': 'polite' });
    const chatIn = h('input.pt-input', {
        maxlength: LIMITS.chat, placeholder: 'Say something nice…', 'aria-label': 'Chat message',
        onkeydown: (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                if (c.sendChat(chatIn.value)) chatIn.value = '';
            }
        },
    });
    const roundEl = h('div.mp-round-line');
    const drawPlayers = () => {
        const ranked = rankedPlayers(c);
        playersEl.replaceChildren(...ranked.map((p) => h('li.mp-roster-row', { class: p.id === c.you ? 'me' : '' },
            h('span.mp-roster-name', p.host ? h('span.mp-crown', { title: 'Host' }, ico('trophy', 14)) : null, p.name, p.id === c.you ? h('span.pt-muted', ' (you)') : null),
            h('span.pt-mono.mp-num', p.best != null ? formatTime(p.best) : ''),
            h('span.pt-mono.mp-num.mp-pts', `${p.pts} pts`),
            isHost && !p.host ? h('button.pt-btn.small.ghost', { type: 'button', 'aria-label': `Remove ${p.name}`, onclick: async () => { if (await app.confirm(`Remove ${p.name} from the room?`, { ok: 'Remove', danger: true })) s.host.kick(p.id); } }, ico('close', 14)) : null)));
    };
    const drawChat = () => {
        chatLog.replaceChildren(...c.chat.map(chatLine));
        chatLog.scrollTop = chatLog.scrollHeight;
    };
    const drawRound = () => {
        const r = c.round;
        if (r.state === 'racing') {
            roundEl.replaceChildren(h('span', ico('flag', 18), `Round ${r.n} is on: ${r.track.name || r.track.id || 'custom track'}`),
                h('button.pt-btn.primary', { type: 'button', 'data-autofocus': !isHost || null, onclick: enterRace }, ico('play', 20), 'Join the race'));
        } else {
            roundEl.replaceChildren(h('span.pt-muted', r.n ? `Round ${r.n} is over.` : '', isHost ? ' Pick a track and start a round.' : ' Waiting for the host to start a round…'));
        }
    };

    let hostBox = null;
    if (isHost) {
        const sel = trackSelect(app, { value: ui.hostTrack, onchange: (v) => { ui.hostTrack = v; } });
        const codeIn = h('input.pt-input', { placeholder: 'or paste a PT1. share code', 'aria-label': 'Track share code', spellcheck: 'false', autocomplete: 'off' });
        const mins = h('select.pt-input', { 'aria-label': 'Round length', onchange: (e) => { ui.minutes = Number(e.target.value); } },
            ROUND_CHOICES.map((m) => h('option', { value: m }, `${m} minutes`)));
        mins.value = String(ui.minutes);
        const start = () => {
            let ref;
            try {
                ref = trackRefFor(app, s, codeIn.value.trim() || null, ui.hostTrack);
            } catch (e) {
                app.toast(e.message, { kind: 'bad', ms: 4500 });
                return;
            }
            savePrefs(app, { onlineTrack: ui.hostTrack, onlineMinutes: ui.minutes });
            s.host.startRound(ref, ui.minutes * 60000);
        };
        hostBox = h('div.mp-host-box',
            h('h3.mp-card-title', 'Next round'),
            h('div.mp-form-row', field('Track', sel), field('Length', mins)),
            codeIn,
            h('div.pt-row.mp-actions',
                h('button.pt-btn.primary', { type: 'button', 'data-autofocus': true, onclick: start }, ico('flag', 20), 'Start round'),
                c.round.state === 'racing' ? h('button.pt-btn.ghost', { type: 'button', onclick: () => s.host.endRound() }, 'End current round') : null));
    }

    const codeBtn = h('button.pt-btn.mp-room-code', {
        type: 'button', title: 'Copy the room code',
        onclick: async () => app.toast((await copyText(s.code)) ? 'Room code copied' : `Room code: ${s.code}`, { icon: 'copy' }),
    }, h('span.pt-mono', s.code), ico('copy', 18));
    const inviteBtn = h('button.pt-btn.small.mp-invite', {
        type: 'button', title: 'Copy a link that drops a friend straight into this room',
        onclick: async () => app.toast((await copyText(roomLink(s.code))) ? 'Invite link copied: paste it to your friends' : roomLink(s.code), { icon: 'link' }),
    }, ico('link', 16), 'Copy invite link');
    const el = h('div.mp-columns.mp-lobby',
        h('section.pt-panel.mp-card',
            h('div.mp-room-head',
                h('div', h('div.mp-kicker', isHost ? 'Your room' : 'Room'), h('div.pt-row.mp-code-row', codeBtn, inviteBtn)),
                h('div.pt-spacer'),
                h('button.pt-btn.small.ghost', { type: 'button', onclick: leave }, ico('back', 16), isHost ? 'Close room' : 'Leave')),
            h('p.pt-muted.mp-small', isHost ? 'Send your friends the invite link (or the code). Keep this tab open: your browser is the server.' : `Hosted by ${(c.players.find((p) => p.host) || {}).name || 'the host'}.`),
            h('h3.mp-card-title', 'Penguins here'),
            playersEl,
            roundEl,
            hostBox),
        h('section.pt-panel.mp-card.mp-chat',
            h('h3.mp-card-title', 'Chat'),
            chatLog,
            chatIn));
    drawPlayers();
    drawChat();
    drawRound();
    return {
        el,
        update(type) {
            if (type === 'players') drawPlayers();
            else if (type === 'chat') drawChat();
            else if (type === 'round') {
                drawRound();
                drawPlayers();
            }
        },
    };
}

/** The reference the host broadcasts: official ids travel as ids, anything else as a share code. */
function trackRefFor(app, s, pasted, id) {
    let track;
    if (pasted) {
        try {
            track = decodeTrack(pasted);
        } catch (e) {
            throw new Error(`That share code doesn't read: ${e.message}`);
        }
    } else {
        track = app.catalog.getTrack(id);
        if (!track) throw new Error("That track couldn't be found.");
    }
    const hash = trackHash(track);
    const world = buildWorld(track);
    if (!world.spawn || !world.route) throw new Error("That track can't be finished yet.");
    s.worlds.set(hash, { track, world });
    if (!pasted && app.catalog.isOfficial(track.id)) return { id: track.id, hash, name: track.name };
    const code = encodeTrack(track);
    if (code.length > LIMITS.trackCode) throw new Error('That track is too big to share in a room.');
    return { code, hash, name: track.name || 'Custom track' };
}

/** Up to three official tracks for the next-track vote: the next two after this one, then random picks. */
function ballotChoices(app, ref) {
    const ids = app.catalog.campaignIds();
    const cur = ref && ref.id && ids.includes(ref.id) ? ref.id : null;
    const out = [];
    const add = (id) => { if (id && id !== cur && !out.includes(id) && ids.includes(id)) out.push(id); };
    if (cur) {
        const n1 = app.catalog.nextTrackId(cur);
        add(n1);
        if (n1) add(app.catalog.nextTrackId(n1));
    }
    for (let guard = 0; out.length < 3 && guard < 60; guard++) add(ids[Math.floor(Math.random() * ids.length)]);
    return out.map((id) => ({ id, name: (app.catalog.info(id) || {}).name || id }));
}

function rankedPlayers(c) {
    return c.players.slice().sort((a, b) => (a.best == null) - (b.best == null) || (a.best ?? 0) - (b.best ?? 0) || b.pts - a.pts);
}

function chatLine(m) {
    if (m.sys) return h('div.mp-chat-line.sys', m.text);
    return h('div.mp-chat-line', h('b', m.name), ' ', m.text);
}

// ------------------------------------------------------------------ racing

class OnlineRace {
    constructor(app, s, { track, world }, { toLobby, leave }) {
        this.app = app;
        this.s = s;
        this.c = s.client;
        this.track = track;
        this.world = world;
        this.toLobby = toLobby;
        this.leave = leave;
        this.racer = new Racer(world, { name: s.client.name });
        this.pilot = app.debug.autopilot ? new Autopilot(world, { gripMargin: 0.8 }) : null;
        this.countdown = new Countdown();
        this.inp = { steer: 0, gas: false, brake: false, respawn: false };
        this.view = makeCarView();
        this.remote = new Map();     // id -> { car, color }
        this.best = null;            // my best result this round
        this.ghost = null;
        this.ghostsOn = true;
        this.camIndex = Math.max(0, CAMERAS.findIndex((x) => x.id === app.settings.camera));
        this.state = 'countdown';    // 'countdown' | 'racing' | 'finished' | 'menu' | 'ended'
        this.hudOpts = { ghostPositions: [] };
        this.round = s.client.round.n;
        this.disposed = false;
        this.el = this._build();
    }

    start() {
        const { app } = this;
        app.backdrop.stop();
        app.setMusic(false);
        app.loadWorld(this.world, this.track);
        this.car = app.renderer.addCar({ kind: 'player' });
        app.renderer.setCameraMode(CAMERAS[this.camIndex].id, this.car);
        app.controls.setActive(true);
        this._onVis = () => { if (document.hidden && (this.state === 'racing' || this.state === 'countdown')) this.openMenu(); };
        document.addEventListener('visibilitychange', this._onVis);
        this.drawBoard();
        this.drawChat();
        this.restart();
        if (this.c.round.state !== 'racing') this.showEnded();
        app.loop.start(() => this.tick(), (a, dt) => this.frame(a, dt));
    }

    restart() {
        const { app } = this;
        this.racer.reset();
        if (this.pilot) this.pilot.reset();
        this.countdown.reset();
        this.state = 'countdown';
        this.sentIdle = false;
        if (this.ghost) app.renderer.removeCar(this.ghost.car);
        this.ghost = null;
        if (this.best && this.best.replay) {
            try {
                this.ghost = { run: new GhostRun(this.world, this.best.replay), car: app.renderer.addCar({ kind: 'ghost', color: '#cfeaff' }) };
            } catch (e) { /* no ghost */ }
        }
        this.hud.reset();
        this.hud.setPb(this.best ? { bestMs: this.best.timeMs, respawns: this.best.respawns } : null);
        app.controls.setActive(true);
        app.controls.clearEdges();
        app.audio.stopCar();
        app.loop.resync();
    }

    // ---------------------------------------------------------- room events

    onRoom(type) {
        if (type === 'players') {
            this.drawBoard();
            this._syncRemotes();
            // Points arrive just after the round-over message.
            if (this.state === 'ended') this._endTable();
        } else if (type === 'chat') {
            this.drawChat(true);
        } else if (type === 'round') {
            const r = this.c.round;
            if (r.state === 'ended' || r.state === 'lobby') this.showEnded();
            this.drawBoard();
        } else if (type === 'ballot') {
            this._drawVote();
        }
    }

    // ---------------------------------------------------------- ticks

    tick() {
        if (this.disposed || this.state === 'menu') return;
        const { app, racer } = this;
        if (this.state === 'countdown') {
            const n = this.countdown.tick();
            if (n != null) {
                if (n === 'GO') {
                    racer.go();
                    this.state = 'racing';
                    app.audio.go();
                    app.renderer.setCountdown(0);
                    this.hud.countdown('GO');
                    setTimeout(() => !this.disposed && this.hud && this.hud.countdown(null), 700);
                    setTimeout(() => !this.disposed && this.state !== 'countdown' && app.renderer.setCountdown(null), 1500);
                    app.controls.pressed('respawn');
                } else {
                    app.audio.countdown(n);
                    app.renderer.setCountdown(n);
                    this.hud.countdown(n);
                }
            }
            return;
        }
        let input = null;
        if (racer.state === 'racing' && this.state === 'racing') input = this.pilot ? this.pilot.act(racer.sim) : app.controls.input(this.inp);
        const events = racer.step(input);
        if (events.length) this._events(events);
        // Racing (and coasting past the line) shows us to the others.
        if (this.state !== 'ended' && racer.sim.tick % POSE_EVERY === 0) {
            const car = racer.sim.car;
            this.c.sendPose(racer.run, racer.sim.tick, car.pos, car.quat, car.speedKmh);
        }
        if (racer.state === 'finished' && racer.finishTicks >= AUTO_RETRY && this.state === 'finished') this.restart();
    }

    _events(events) {
        const { app, racer, hud } = this;
        app.renderer.handleEvents(events, this.car);
        app.audio.handleEvents(events);
        for (const ev of events) {
            if (ev.type === 'checkpoint') {
                const k = racer.sim.checkpointTimes.length - 1;
                const pb = this.best && Number.isFinite(this.best.splits[k]) ? this.best.splits[k] : null;
                hud.split(ev.timeMs, pb == null ? null : ev.timeMs - pb);
            } else if (ev.type === 'missingCheckpoints') {
                hud.banner(`${ev.missing} checkpoint${ev.missing === 1 ? '' : 's'} missing!`, 'bad');
            } else if (ev.type === 'lap') {
                hud.banner(`Lap ${ev.lap + 1}/${racer.sim.laps}`, 'lap');
            } else if (ev.type === 'finish') {
                this._finish(racer.result);
            }
        }
    }

    _finish(res) {
        this.state = 'finished';
        const platform = this.track.mode === 'platform';
        const prev = this.best;
        const better = !prev || (platform && res.respawns !== prev.respawns ? res.respawns < prev.respawns : res.timeMs < prev.timeMs);
        const diff = prev ? res.timeMs - prev.timeMs : null;
        this.hud.banner(diff == null ? formatTime(res.timeMs) : `${formatTime(res.timeMs)}  ${formatTime(diff, { style: 'short', sign: true })}`,
            'finish ' + (diff == null ? '' : diff <= 0 ? 'ahead' : 'behind'), 2400);
        if (better) {
            this.best = res;
            if (this.c.round.state === 'racing') this.c.sendFinish(res.replay, res.respawns);
        }
    }

    // ---------------------------------------------------------- frames

    frame(alpha, dt) {
        if (this.disposed) return;
        const { app, racer } = this;
        this._edges();
        const frozen = this.state === 'countdown' || this.state === 'menu';
        const a = frozen ? 1 : alpha;
        lerpCarSnapshot(racer.prev, racer.cur, a, this.view);
        this.car.setPose(racer.prev, racer.cur, a);
        const gpos = this.hudOpts.ghostPositions;
        gpos.length = 0;
        if (this.ghost) {
            this.ghost.car.setVisible(this.ghostsOn);
            const v = this.ghost.run.viewAt(racer.sim.tick > 0 ? racer.sim.tick - 1 + a : 0);
            this.ghost.car.setPose(v, v, 1);
        }
        const now = Date.now();
        for (const [id, rc] of this.remote) {
            const buf = this.c.remotes.get(id);
            const pose = buf && now - buf.lastAt < REMOTE_STALE_MS ? buf.sample(now) : null;
            rc.car.setVisible(!!pose && this.ghostsOn);
            if (pose) {
                if (rc.run !== pose.run) {
                    rc.run = pose.run;
                    rc.car.teleported();
                }
                rc.car.setPose(pose, pose, 1);
                gpos.push(pose.pos);
            }
        }
        if (this.c.remotes.size !== this._remoteCount) this._syncRemotes();
        this.hud.update(racer.sim, this.view, this.hudOpts);
        this._clock();
        if (this.state === 'racing') app.audio.updateCar(this.view, dt, racer.sim.lastInput);
        app.renderer.render(dt);
    }

    _edges() {
        const c = this.app.controls;
        if (this.state === 'menu' || this.state === 'ended' || this.chatOpen) {
            c.clearEdges();
            return;
        }
        if (c.pressed('pause')) return this.openMenu();
        if (c.pressed('restart')) return this.restart();
        if (this.state === 'finished' && c.pressed('respawn')) return this.restart();
        if (this.state === 'countdown') c.pressed('respawn');
        if (c.pressed('camera1')) this._camera(0);
        if (c.pressed('camera2')) this._camera(1);
        if (c.pressed('camera3')) this._camera(2);
        if (c.pressed('cameraCycle')) this._camera((this.camIndex + 1) % CAMERAS.length);
        if (c.pressed('ghost')) {
            this.ghostsOn = !this.ghostsOn;
            this.app.toast(this.ghostsOn ? 'Ghosts on' : 'Ghosts off', { icon: 'ghost', ms: 1200 });
        }
    }

    _camera(i) {
        this.camIndex = i;
        this.app.renderer.setCameraMode(CAMERAS[i].id, this.car);
    }

    /** Remote ghost cars follow the room's player list. */
    _syncRemotes() {
        const r = this.app.renderer;
        const ids = new Set(this.c.players.filter((p) => p.id !== this.c.you).map((p) => p.id));
        for (const [id, rc] of this.remote) {
            if (!ids.has(id)) {
                r.removeCar(rc.car);
                this.remote.delete(id);
            }
        }
        this.c.players.forEach((p, i) => {
            if (p.id === this.c.you || this.remote.has(p.id)) return;
            const color = REMOTE_COLORS[i % REMOTE_COLORS.length];
            const car = r.addCar({ kind: 'remote', color, label: p.name });
            car.setVisible(false);
            this.remote.set(p.id, { car, color, run: null });
        });
        this._remoteCount = this.c.remotes.size;
    }

    _clock() {
        const r = this.c.round;
        const left = this.c.timeLeft();
        const sec = Math.ceil(left / 1000);
        if (sec !== this._lastSec) {
            this._lastSec = sec;
            setText(this.clockEl, r.state === 'racing' ? `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}` : 'Round over');
            this.clockEl.classList.toggle('low', r.state === 'racing' && sec <= 30);
        }
    }

    // ---------------------------------------------------------- panels

    drawBoard() {
        const c = this.c;
        const r = c.round;
        setText(this.boardTitle, `Round ${r.n} · ${this.track.name}`);
        const rows = rankedPlayers(c);
        let place = 0;
        this.boardEl.replaceChildren(...rows.map((p, k) => {
            if (k > 0 && rows[k - 1].best !== p.best) place = k;
            return h('div.mp-lb-row', { class: (p.id === c.you ? 'me' : '') + (p.driving ? ' driving' : '') },
                h('span.mp-lb-place', p.best != null ? String(place + 1) : '–'),
                h('span.mp-lb-name', p.name),
                h('span.mp-lb-time.pt-mono', p.best != null ? formatTime(p.best) : ''),
                h('span.mp-lb-ok', { title: p.verified ? 'Verified: the host re-ran the replay' : '' }, p.best != null && p.verified ? ico('check', 14) : null));
        }));
    }

    drawChat(fresh = false) {
        const lines = this.c.chat.slice(-4);
        this.chatEl.replaceChildren(...lines.map(chatLine));
        if (fresh) {
            this.chatEl.classList.remove('faded');
            clearTimeout(this._chatTimer);
            this._chatTimer = setTimeout(() => this.chatEl && this.chatEl.classList.add('faded'), 9000);
        }
        if (this.menuChat) {
            this.menuChat.replaceChildren(...this.c.chat.map(chatLine));
            this.menuChat.scrollTop = this.menuChat.scrollHeight;
        }
    }

    openMenu() {
        if (this.state === 'menu' || this.state === 'ended') return;
        this.menuFrom = this.state;
        this.state = 'menu';
        this.app.audio.stopCar();
        this.app.controls.setActive(false);
        this.c.sendIdle();
        this.menuEl.classList.remove('pt-hidden');
        this.drawChat();
        this.menuEl.querySelector('[data-autofocus]').focus({ preventScroll: true });
    }

    closeMenu() {
        if (this.state !== 'menu') return;
        this.state = this.menuFrom || 'racing';
        this.menuEl.classList.add('pt-hidden');
        if (document.activeElement && this.menuEl.contains(document.activeElement)) document.activeElement.blur();
        this.app.controls.setActive(true);
        this.app.controls.clearEdges();
        this.app.loop.resync();
    }

    showEnded() {
        this.state = 'ended';
        this.app.audio.stopCar();
        this.app.controls.setActive(false);
        this.menuEl.classList.add('pt-hidden');
        const isHost = !!this.s.host;
        const r = this.c.round;
        this.endBody = h('tbody');
        this.podiumEl = h('div.mp-podium-wrap');
        this.voteEl = h('div.mp-vote');
        this._endTable();
        // the host opens a next-track vote as soon as the round is over
        if (isHost && r.state === 'ended' && !this.s.host.ballot) this.s.host.openBallot(ballotChoices(this.app, r.track));
        this.endEl.replaceChildren(h('div.pt-panel.mp-end-panel', { role: 'dialog', 'aria-label': 'Round over' },
            h('div.mp-kicker', `Round ${r.n} over`),
            h('h2.mp-turn-track', this.track.name),
            this.podiumEl,
            h('table.mp-table.big', this.endBody),
            this.voteEl,
            h('div.pt-row.mp-actions',
                isHost ? h('button.pt-btn.primary', { type: 'button', 'data-autofocus': true, onclick: () => this.s.host.startRound(r.track, r.durationMs) }, ico('retry', 20), 'Another round here') : h('span.pt-muted', 'Waiting for the host…'),
                h('button.pt-btn', { type: 'button', 'data-autofocus': isHost ? null : true, onclick: () => this.toLobby() }, ico('users', 20), isHost ? 'Lobby: change track' : 'Lobby and chat'))));
        this.endEl.classList.remove('pt-hidden');
        const f = this.endEl.querySelector('[data-autofocus]');
        if (f) requestAnimationFrame(() => f.isConnected && f.focus({ preventScroll: true }));
    }

    /** Next-track vote: everyone taps a track; the host starts the winner. */
    _drawVote() {
        const el = this.voteEl, c = this.c, b = c.ballot;
        if (!el) return;
        if (!b) {
            el.replaceChildren();
            return;
        }
        el.replaceChildren(
            h('div.mp-kicker', 'Vote for the next track'),
            h('div.mp-vote-row', b.choices.map((ch, i) => h('button.pt-btn.mp-vote-btn', {
                type: 'button', class: c.vote === ch.id ? 'on' : '', 'aria-pressed': c.vote === ch.id ? 'true' : 'false',
                onclick: () => { c.sendVote(c.vote === ch.id ? '' : ch.id); this._drawVote(); },
            }, h('span.mp-vote-name', h('span.pt-mono', ch.id), ' ', ch.name), h('b.mp-vote-n.pt-mono', String(b.tally[i]))))),
            this.s.host
                ? h('button.pt-btn.primary', { type: 'button', onclick: () => this._playVoted() }, ico('flag', 20), 'Play the winner')
                : h('p.pt-muted.mp-small', 'The host starts the most-voted track.'));
    }

    _playVoted() {
        const w = this.s.host && this.s.host.ballotWinner();
        if (!w) return;
        let ref;
        try {
            ref = trackRefFor(this.app, this.s, null, w.id);
        } catch (e) {
            this.app.toast(e.message, { kind: 'bad' });
            return;
        }
        this.s.host.startRound(ref, this.c.round.durationMs || 180000);
    }

    /** Top three on blocks of 2-1-3 with their time and the medal it would earn. */
    _drawPodium() {
        if (!this.podiumEl) return;
        const top = rankedPlayers(this.c).filter((p) => p.best != null).slice(0, 3);
        if (!top.length) {
            this.podiumEl.replaceChildren(h('p.pt-muted', 'Nobody reached the finish this round.'));
            return;
        }
        this.podiumEl.replaceChildren(h('div.mp-podium', [1, 0, 2].filter((i) => top[i]).map((i) => {
            const p = top[i];
            let medal = null;
            try {
                medal = this.track.medals ? this.app.catalog.medalFor(this.track, { timeMs: p.best, respawns: p.respawns }) : null;
            } catch (e) { /* no medal */ }
            return h('div.mp-pod', { class: `p${i + 1}${p.id === this.c.you ? ' me' : ''}` },
                h('div.mp-pod-name', p.name),
                h('div.mp-pod-time.pt-mono', formatTime(p.best), medal ? h('span.pt-medal', { class: medal, title: this.app.catalog.medalLabel(medal) }) : null),
                h('div.mp-pod-step', String(i + 1)));
        })));
    }

    _endTable() {
        this._drawPodium();
        this._drawVote();
        const c = this.c;
        const rows = rankedPlayers(c);
        let place = 0;
        this.endBody.replaceChildren(...rows.map((p, k) => {
            if (k > 0 && rows[k - 1].best !== p.best) place = k;
            const got = p.best != null ? pointsFor(place) : 0;
            return h('tr', { class: p.id === c.you ? 'me' : '' },
                h('td.mp-place', p.best != null ? String(place + 1) : '–'),
                h('td', p.name),
                h('td.pt-mono.mp-num', p.best != null ? formatTime(p.best) : 'no finish'),
                h('td.pt-mono.mp-num.mp-pts', got ? `+${got}` : ''),
                h('td.pt-mono.mp-num.pt-muted', `${p.pts} pts`));
        }));
    }

    /** Esc from the screen: open the menu, or close it. */
    escape() {
        if (this.chatOpen) return this.closeChat();
        if (this.state === 'menu') this.closeMenu();
        else if (this.state === 'ended') this.toLobby();
        else this.openMenu();
    }

    openChat() {
        if (this.chatOpen) return;
        this.chatOpen = true;
        this.app.controls.setActive(false);
        this.chatInput.classList.remove('pt-hidden');
        this.chatEl.classList.remove('faded');
        this.chatInput.focus();
    }

    closeChat() {
        this.chatOpen = false;
        this.chatInput.value = '';
        this.chatInput.classList.add('pt-hidden');
        this.chatInput.blur();
        if (this.state !== 'menu' && this.state !== 'ended') this.app.controls.setActive(true);
        this.app.controls.clearEdges();
    }

    onKey(e) {
        if (this.chatOpen) {
            if (e.key === 'Escape') {
                this.closeChat();
                return true;
            }
            return false;
        }
        if (typing(e)) return false;
        if ((e.key === 't' || e.key === 'T') && (this.state === 'racing' || this.state === 'countdown' || this.state === 'finished')) {
            this.openChat();
            return true;
        }
        if (e.key === 'Escape') {
            if (this.state === 'menu') this.closeMenu();
            else if (this.state === 'ended') this.toLobby();
            return true;
        }
        return this.state !== 'menu' && this.state !== 'ended';
    }

    _build() {
        this.hud = new Hud(this.app, {
            track: this.track, world: this.world, mode: 'custom', pbRecord: null, targets: [],
            medalRank: this.app.catalog.medalRank, showMinimap: this.app.settings.showMinimap, units: this.app.settings.units,
        });
        this.clockEl = h('div.mp-clock.pt-mono', '');
        this.boardTitle = h('div.mp-lb-title');
        this.boardEl = h('div.mp-lb-rows');
        this.chatEl = h('div.mp-feed', { 'aria-live': 'polite' });
        this.chatInput = h('input.pt-input.mp-feed-input.pt-hidden', {
            maxlength: LIMITS.chat, placeholder: 'Chat (Enter to send, Esc to close)', 'aria-label': 'Chat message',
            onkeydown: (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    this.c.sendChat(this.chatInput.value);
                    this.closeChat();
                }
            },
        });
        this.menuChat = h('div.mp-chat-log.pt-scroll', { role: 'log' });
        const menuChatIn = h('input.pt-input', {
            maxlength: LIMITS.chat, placeholder: 'Say something…', 'aria-label': 'Chat message',
            onkeydown: (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    if (this.c.sendChat(menuChatIn.value)) menuChatIn.value = '';
                }
            },
        });
        const btn = (label, icon, onclick, cls = '', autofocus = false) => h('button.pt-btn', { type: 'button', class: cls, onclick, 'data-autofocus': autofocus || null }, ico(icon, 20), label);
        this.menuEl = h('div.mp-race-menu.pt-hidden', { role: 'dialog', 'aria-label': 'Room menu' },
            h('div.pt-panel.mp-race-menu-panel',
                h('div.pt-col',
                    h('h2.pt-title', 'Room ', h('span.pt-mono', this.s.code)),
                    h('p.pt-muted.mp-small', 'The round clock keeps running while you are here.'),
                    btn('Back to the race', 'play', () => this.closeMenu(), 'primary', true),
                    btn('Restart run', 'retry', () => { this.closeMenu(); this.restart(); }),
                    btn('Lobby', 'users', () => this.toLobby()),
                    btn(this.s.host ? 'Close room' : 'Leave room', 'back', () => this.leave(), 'ghost')),
                h('div.pt-col.mp-race-menu-chat', h('h3.mp-card-title', 'Chat'), this.menuChat, menuChatIn)));
        this.endEl = h('div.mp-race-end.pt-hidden');
        return h('div.mp-race-stage',
            this.hud.el,
            h('div.mp-lb.pt-panel', h('div.mp-lb-head', this.boardTitle, this.clockEl), this.boardEl),
            h('div.mp-feed-wrap', this.chatEl, this.chatInput, h('div.mp-feed-hint.pt-muted', h('span.pt-kbd', 'T'), ' chat  ', h('span.pt-kbd', 'Esc'), ' room menu')),
            this.menuEl,
            this.endEl);
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        const { app } = this;
        document.removeEventListener('visibilitychange', this._onVis);
        clearTimeout(this._chatTimer);
        app.loop.stop();
        this.c.sendIdle();
        const r = app.renderer;
        if (this.car) r.removeCar(this.car);
        if (this.ghost) r.removeCar(this.ghost.car);
        for (const rc of this.remote.values()) r.removeCar(rc.car);
        this.remote.clear();
        r.setCountdown(null);
        app.audio.stopCar();
        app.controls.setActive(false);
        if (this.hud) this.hud.dispose();
        this.hud = null;
    }
}
