// Online time-attack rooms, transport-agnostic (pure, Node-tested with the
// in-memory loopback below; js/mp/net.js plugs in PeerJS). Star topology: the
// host runs RoomHost, every player (the host too, over a loopback pair) runs
// RoomClient. The host assigns player ids, relays poses and chat, checks every
// claimed finish by re-simulating its replay, keeps the leaderboard and the
// round clock. A connection is { id, send(text), onData(fn), onClose(fn), close() }.
import {
    PROTOCOL_VERSION, MAX_PLAYERS, LIMITS, encode, decode, validateClientMsg, validateHostMsg,
    cleanName, uniqueName, cleanText, packPose,
} from './protocol.js';
import { rankRuns, isBetter } from './scoring.js';
import { formatTime } from '../core/format.js';

const fmt = (ms) => formatTime(ms);

export const FINISH_GRACE_MS = 2500;   // a run crossing the line as the clock hits zero still counts
export const SILENCE_MS = 75000;       // no message for this long: the peer is gone (hidden tabs ping once a minute)
export const PING_MS = 4000;
export const POSE_MIN_MS = 45;         // ~20 Hz cap per player on what the host relays
const BUCKET_RATE = 40, BUCKET_MAX = 80;   // messages per second, burst
const CHAT_WINDOW_MS = 5000, CHAT_MAX = 4;
const STRIKES_MAX = 25;
const CHAT_KEEP = 40;

// ------------------------------------------------------------------ loopback transport

/**
 * Two connected in-memory ends. Frames are delivered asynchronously (like a
 * network) unless { sync: true }. Used for the host's own player and in tests.
 */
export function loopbackPair(idA = 'a', idB = 'b', { sync = false } = {}) {
    const mk = (id) => ({ id, open: true, sendable: true, data: [], closed: [], peer: null });
    const A = mk(idA), B = mk(idB);
    A.peer = B;
    B.peer = A;
    const later = sync ? (f) => f() : (f) => queueMicrotask(f);
    const end = (S) => ({
        id: S.peer.id,          // the id of the other side, as PeerJS reports conn.peer
        local: true,
        send(text) {
            if (!S.sendable) return;
            const target = S.peer;
            later(() => { if (target.open) for (const f of target.data) f(text); });
        },
        onData(f) { S.data.push(f); },
        onClose(f) { S.closed.push(f); },
        close() {
            // Frames already sent still arrive first, like a real channel flushing.
            S.sendable = S.peer.sendable = false;
            later(() => {
                for (const side of [S, S.peer]) {
                    if (!side.open) continue;
                    side.open = false;
                    for (const f of side.closed) f();
                }
            });
        },
    });
    return [end(A), end(B)];
}

// ------------------------------------------------------------------ host

export class RoomHost {
    /**
     * opts: { code, now = Date.now, verify(trackRef, replay) -> { ok, timeMs, respawns, reason }
     * (sync or a Promise), onChange(), maxPlayers, platform(trackRef) -> bool }
     */
    constructor(opts = {}) {
        this.code = opts.code || '';
        this.now = opts.now || (() => Date.now());
        this.verify = opts.verify || null;
        this.onChange = opts.onChange || null;
        this.maxPlayers = Math.min(MAX_PLAYERS, opts.maxPlayers || MAX_PLAYERS);
        this.platformOf = opts.platform || (() => false);
        this.peers = new Set();        // every connection state (joined or not)
        this.players = [];             // joined states, in join order
        this.chat = [];
        this.round = { n: 0, state: 'lobby', track: null, durationMs: 0, endAt: 0 };
        this.nextId = 1;
        this.closed = false;
    }

    /** Accepts a new connection (a PeerJS DataConnection wrapper, or a loopback end). */
    addConnection(conn, { host = false } = {}) {
        if (this.closed) {
            conn.close();
            return null;
        }
        const st = {
            conn, host, id: null, name: '', best: null, respawns: 0, replay: null, verified: false, pts: 0,
            driving: false, lastSeen: this.now(), tokens: BUCKET_MAX, tokenAt: this.now(), chatTimes: [],
            strikes: 0, lastPoseAt: -Infinity, gone: false,
        };
        this.peers.add(st);
        conn.onData((frame) => this._onFrame(st, frame));
        conn.onClose(() => this._drop(st, 'left'));
        return st;
    }

    _onFrame(st, frame) {
        if (st.gone || this.closed) return;
        const now = this.now();
        st.lastSeen = now;
        // Token bucket: a flood is dropped, a sustained flood disconnects.
        st.tokens = Math.min(BUCKET_MAX, st.tokens + ((now - st.tokenAt) / 1000) * BUCKET_RATE);
        st.tokenAt = now;
        if (st.tokens < 1) {
            this._strike(st);
            return;
        }
        st.tokens -= 1;
        const m = validateClientMsg(decode(frame));
        if (!m) {
            this._strike(st);
            return;
        }
        if (!st.id) {
            if (m.t === 'hello') this._hello(st, m);
            else this._strike(st);
            return;
        }
        switch (m.t) {
            case 'chat': return this._chat(st, m.text);
            case 'pose': return this._pose(st, m, now);
            case 'idle':
                if (st.driving) {
                    st.driving = false;
                    this._broadcast({ t: 'idle', id: st.id }, st);
                }
                return;
            case 'fin': return this._finish(st, m, now);
            case 'want': {
                const p = this.players.find((x) => x.id === m.id);
                if (p && p.replay) this._send(st, { t: 'replay', id: p.id, replay: p.replay });
                return;
            }
            case 'ping': return this._send(st, { t: 'pong', c: m.c });
            case 'bye': return this._drop(st, 'left');
            default:
        }
    }

    _strike(st) {
        st.strikes++;
        if (st.strikes > STRIKES_MAX) this._drop(st, 'kicked', 'Too many bad messages.');
    }

    _hello(st, m) {
        if (m.v !== PROTOCOL_VERSION) {
            this._reject(st, 'This room runs a different version of Penguintrack. Reload the page and try again.');
            return;
        }
        if (this.players.length >= this.maxPlayers) {
            this._reject(st, `The room is full (${this.maxPlayers} penguins).`);
            return;
        }
        st.id = `p${this.nextId++}`;
        st.name = uniqueName(cleanName(m.name), this.players.map((p) => p.name));
        this.players.push(st);
        this._send(st, { t: 'welcome', v: PROTOCOL_VERSION, you: st.id, name: st.name });
        this._send(st, this._roundMsg());
        for (const c of this.chat.slice(-12)) this._send(st, c);
        this._sys(`${st.name} slid into the room.`);
        this._players();
    }

    _reject(st, reason) {
        this._send(st, { t: 'reject', reason });
        st.gone = true;
        this.peers.delete(st);
        // Let the reject reach the peer before closing.
        setTimeout(() => st.conn.close(), 200);
    }

    _chat(st, text) {
        const now = this.now();
        st.chatTimes = st.chatTimes.filter((t) => now - t < CHAT_WINDOW_MS);
        if (st.chatTimes.length >= CHAT_MAX) return;
        st.chatTimes.push(now);
        this._pushChat({ t: 'chat', id: st.id, name: st.name, text });
    }

    _sys(text) {
        this._pushChat({ t: 'chat', sys: true, text: cleanText(text, LIMITS.chat) });
    }

    _pushChat(msg) {
        this.chat.push(msg);
        if (this.chat.length > CHAT_KEEP) this.chat.shift();
        this._broadcast(msg);
        this._changed();
    }

    _pose(st, m, now) {
        if (this.round.state !== 'racing') return;
        if (now - st.lastPoseAt < POSE_MIN_MS) return;
        st.lastPoseAt = now;
        const wasDriving = st.driving;
        st.driving = true;
        this._broadcast({ t: 'pose', id: st.id, r: m.r, k: m.k, p: m.p, q: m.q, s: m.s }, st);
        if (!wasDriving) this._players();
    }

    _finish(st, m, now) {
        const r = this.round;
        if (r.state !== 'racing' || m.round !== r.n || now > r.endAt + FINISH_GRACE_MS) return;
        if (r.track.hash && m.replay.trackHash !== r.track.hash) return;
        const platform = this.platformOf(r.track);
        const cand = { timeMs: m.timeMs, respawns: m.respawns };
        if (!isBetter(cand, st.best == null ? null : { timeMs: st.best, respawns: st.respawns }, platform)) return;
        const roundN = r.n;
        const accept = (res) => {
            if (st.gone || this.round.n !== roundN || this.closed) return;
            if (res && res.ok === false) {
                this._send(st, { t: 'chat', sys: true, text: `Your ${fmt(m.timeMs)} could not be verified (${cleanText(res.reason || 'replay mismatch', 80)}).` });
                return;
            }
            const verified = !!(res && res.ok && res.timeMs === m.timeMs);
            if (res && res.ok && res.timeMs !== m.timeMs) return;
            // Another, better finish may have been verified meanwhile.
            if (!isBetter(cand, st.best == null ? null : { timeMs: st.best, respawns: st.respawns }, platform)) return;
            st.best = m.timeMs;
            st.respawns = m.respawns;
            st.replay = m.replay;
            st.verified = verified;
            this._players();
        };
        if (!this.verify) {
            accept(null);
            return;
        }
        let res;
        try {
            res = this.verify(r.track, m.replay);
        } catch (e) {
            res = { ok: false, reason: e.message };
        }
        if (res && typeof res.then === 'function') res.then(accept, (e) => accept({ ok: false, reason: e && e.message }));
        else accept(res);
    }

    // ---------------------------------------------------------- host controls

    /** Starts a round: trackRef { id, hash?, name } or { code, hash, name }; everyone's best resets. */
    startRound(trackRef, durationMs) {
        const d = Math.max(LIMITS.roundMs[0], Math.min(LIMITS.roundMs[1], Math.round(durationMs)));
        this.round = { n: this.round.n + 1, state: 'racing', track: trackRef, durationMs: d, endAt: this.now() + d };
        for (const p of this.players) {
            p.best = null;
            p.respawns = 0;
            p.replay = null;
            p.verified = false;
            p.driving = false;
        }
        this._broadcast(this._roundMsg());
        this._sys(`Round ${this.round.n}: ${trackRef.name || trackRef.id || 'a custom track'}, ${Math.round(d / 60000 * 10) / 10} min. Go go go!`);
        this._players();
    }

    /** Ends the running round now: points by rank (10/8/6/…). */
    endRound() {
        const r = this.round;
        if (r.state !== 'racing') return null;
        r.state = 'ended';
        const ranked = this.ranking();
        for (const e of ranked) e.player.pts += e.points;
        for (const p of this.players) p.driving = false;
        this._broadcast(this._roundMsg());
        const win = ranked.find((e) => e.place === 0);
        this._sys(win ? `Round over! ${win.player.name} takes it with ${fmt(win.run.timeMs)}.` : 'Round over! Nobody reached the finish.');
        this._players();
        return ranked;
    }

    toLobby() {
        this.round = { ...this.round, state: 'lobby', track: null, durationMs: 0, endAt: 0 };
        this._broadcast(this._roundMsg());
        this._players();
    }

    kick(id) {
        const p = this.players.find((x) => x.id === id);
        if (p && !p.host) this._drop(p, 'kicked', 'The host removed you from the room.');
    }

    /** Leaderboard of this round: [{ player, run, place, points, finished }]. */
    ranking() {
        const platform = this.round.track ? this.platformOf(this.round.track) : false;
        return rankRuns(this.players.map((p) => ({ player: p, run: p.best == null ? null : { timeMs: p.best, respawns: p.respawns } })), platform);
    }

    /** Call a few times a second: ends rounds on time and drops silent peers. */
    update() {
        if (this.closed) return;
        const now = this.now();
        if (this.round.state === 'racing' && now >= this.round.endAt) this.endRound();
        for (const st of [...this.peers]) {
            if (!st.host && now - st.lastSeen > SILENCE_MS) this._drop(st, 'timeout');
        }
    }

    close() {
        if (this.closed) return;
        for (const st of [...this.peers]) {
            if (!st.host) this._send(st, { t: 'reject', reason: 'The host closed the room.' });
        }
        this.closed = true;
        for (const st of [...this.peers]) st.conn.close();
        this.peers.clear();
        this.players = [];
    }

    // ---------------------------------------------------------- plumbing

    _drop(st, why, reason = null) {
        if (st.gone) return;
        st.gone = true;
        if (reason) this._send(st, { t: 'reject', reason });
        this.peers.delete(st);
        const i = this.players.indexOf(st);
        if (i >= 0) {
            this.players.splice(i, 1);
            if (!this.closed) {
                this._broadcast({ t: 'idle', id: st.id });
                this._sys(why === 'kicked' ? `${st.name} was removed.` : why === 'timeout' ? `${st.name} lost the connection.` : `${st.name} left.`);
                this._players();
            }
        }
        try {
            if (reason) setTimeout(() => st.conn.close(), 200);
            else st.conn.close();
        } catch (e) { /* already closed */ }
    }

    _roundMsg() {
        const r = this.round;
        if (r.state === 'lobby') return { t: 'round', n: r.n, state: 'lobby' };
        return { t: 'round', n: r.n, state: r.state, track: r.track, durationMs: r.durationMs, leftMs: r.state === 'racing' ? Math.max(0, Math.round(r.endAt - this.now())) : 0 };
    }

    _playersMsg() {
        return {
            t: 'players',
            list: this.players.map((p) => ({ id: p.id, name: p.name, host: p.host, best: p.best, respawns: p.respawns, verified: p.verified, pts: p.pts, driving: p.driving })),
        };
    }

    _players() {
        this._broadcast(this._playersMsg());
        this._changed();
    }

    _send(st, msg) {
        try {
            st.conn.send(encode(msg));
        } catch (e) { /* a closing channel */ }
    }

    _broadcast(msg, except = null) {
        const text = encode(msg);
        for (const p of this.players) {
            if (p === except || p.gone) continue;
            try {
                p.conn.send(text);
            } catch (e) { /* ignore */ }
        }
    }

    _changed() {
        if (this.onChange) this.onChange();
    }
}

// ------------------------------------------------------------------ client

/**
 * One player's view of the room. Events go to onEvent(type, data):
 * 'welcome', 'players', 'chat', 'round', 'pose', 'idle', 'replay', 'pong', 'reject', 'closed'.
 */
export class RoomClient {
    constructor({ conn, name, now = () => Date.now(), onEvent = null }) {
        this.conn = conn;
        this.now = now;
        this.onEvent = onEvent;
        this.name = cleanName(name);
        this.you = null;
        this.players = [];
        this.chat = [];
        this.round = { n: 0, state: 'lobby', track: null, durationMs: 0, leftMs: 0, endAt: 0 };
        this.remotes = new Map();   // id -> PoseBuffer
        this.closed = false;
        this.rejected = null;
        this.lastHeard = now();
        this.rtt = null;
        conn.onData((frame) => this._onFrame(frame));
        conn.onClose(() => this._closed());
        this._send({ t: 'hello', v: PROTOCOL_VERSION, name: this.name });
    }

    _onFrame(frame) {
        if (this.closed) return;
        const m = validateHostMsg(decode(frame));
        if (!m) return;
        this.lastHeard = this.now();
        switch (m.t) {
            case 'welcome':
                this.you = m.you;
                this.name = m.name;
                break;
            case 'reject':
                this.rejected = m.reason;
                break;
            case 'players':
                this.players = m.list;
                for (const id of [...this.remotes.keys()]) if (!m.list.some((p) => p.id === id)) this.remotes.delete(id);
                break;
            case 'chat':
                this.chat.push(m);
                if (this.chat.length > CHAT_KEEP) this.chat.shift();
                break;
            case 'round':
                if (m.n !== this.round.n || m.state !== 'racing') this.remotes.clear();
                this.round = { ...m, endAt: this.now() + m.leftMs };
                break;
            case 'pose': {
                if (m.id === this.you) return;
                let b = this.remotes.get(m.id);
                if (!b) this.remotes.set(m.id, (b = new PoseBuffer()));
                b.push(m, this.now());
                break;
            }
            case 'idle':
                this.remotes.delete(m.id);
                break;
            case 'pong':
                this.rtt = Math.max(0, this.now() - m.c);
                break;
            default:
        }
        if (this.onEvent) this.onEvent(m.t, m);
    }

    _closed() {
        if (this.closed) return;
        this.closed = true;
        if (this.onEvent) this.onEvent('closed', { reason: this.rejected });
    }

    _send(msg) {
        if (this.closed) return;
        try {
            this.conn.send(encode(msg));
        } catch (e) { /* ignore */ }
    }

    get me() {
        return this.players.find((p) => p.id === this.you) || null;
    }

    get isHostPlayer() {
        const me = this.me;
        return !!(me && me.host);
    }

    /** Milliseconds left in the running round (0 when not racing). */
    timeLeft() {
        return this.round.state === 'racing' ? Math.max(0, this.round.endAt - this.now()) : 0;
    }

    sendChat(text) {
        const t = cleanText(text, LIMITS.chat);
        if (t) this._send({ t: 'chat', text: t });
        return !!t;
    }

    sendPose(run, tick, pos, quat, speedKmh) {
        this._send(packPose(run, tick, pos, quat, speedKmh));
    }

    sendIdle() {
        this._send({ t: 'idle' });
    }

    /** A finished run of this round; the host re-simulates the replay before it counts. */
    sendFinish(replay, respawns = 0) {
        if (this.round.state !== 'racing') return false;
        this._send({ t: 'fin', round: this.round.n, timeMs: replay.timeMs, respawns, replay: slimReplay(replay) });
        return true;
    }

    requestReplay(id) {
        this._send({ t: 'want', id });
    }

    ping() {
        this._send({ t: 'ping', c: this.now() });
    }

    /** True when the host has been silent too long. */
    stale() {
        return this.now() - this.lastHeard > SILENCE_MS;
    }

    leave() {
        if (this.closed) return;
        this._send({ t: 'bye' });
        this.closed = true;
        try {
            this.conn.close();
        } catch (e) { /* ignore */ }
    }
}

/** Only the fields verifyReplay needs travel. */
export function slimReplay(r) {
    return {
        trackId: r.trackId, trackHash: r.trackHash, laps: r.laps || 1, inputs: r.inputs, ticks: r.ticks,
        timeMs: r.timeMs, finished: true, respawnTicks: r.respawnTicks || [], name: r.name || '',
    };
}

// ------------------------------------------------------------------ remote poses

/**
 * Smooths ~15 Hz pose updates into a continuous pose: samples are placed on
 * the sender's tick clock, mapped to local time with a slowly adapting offset,
 * and drawn `delayMs` in the past so there is (almost) always a later sample
 * to blend toward. A new run id (restart) or a big jump snaps.
 */
export class PoseBuffer {
    constructor(delayMs = 110) {
        this.delay = delayMs;
        this.samples = [];
        this.offset = null;
        this.lastAt = -Infinity;
        this.out = { pos: [0, 0, 0], quat: [0, 0, 0, 1], speedKmh: 0, run: 0, teleport: false };
        this._run = null;
    }

    push(m, at) {
        if (this._run !== m.r) {
            this.samples.length = 0;
            this.offset = null;
            this._run = m.r;
        }
        const last = this.samples[this.samples.length - 1];
        if (last && m.k <= last.k) return;   // out of order
        const est = at - m.k * 10;
        if (this.offset == null || est < this.offset) this.offset = est;
        else this.offset += (est - this.offset) * 0.02;
        this.samples.push({ k: m.k, p: m.p, q: m.q, s: m.s });
        if (this.samples.length > 8) this.samples.shift();
        this.lastAt = at;
    }

    /** Last time a sample arrived (local ms). */
    get age() {
        return this.lastAt;
    }

    /** Pose to draw at local time `now`, or null before the first sample. */
    sample(now) {
        const S = this.samples;
        if (!S.length) return null;
        const o = this.out;
        o.run = this._run;
        const tick = (now - this.delay - this.offset) / 10;
        let a = S[0], b = S[0], f = 0;
        if (tick >= S[S.length - 1].k) {
            a = b = S[S.length - 1];
        } else if (tick > S[0].k) {
            for (let i = 1; i < S.length; i++) {
                if (S[i].k >= tick) {
                    a = S[i - 1];
                    b = S[i];
                    f = (tick - a.k) / Math.max(1, b.k - a.k);
                    break;
                }
            }
        }
        const dx = b.p[0] - a.p[0], dy = b.p[1] - a.p[1], dz = b.p[2] - a.p[2];
        // More than ~40 m between samples is a respawn: no gliding across the map.
        if (dx * dx + dy * dy + dz * dz > 1600) f = f < 0.5 ? 0 : 1;
        for (let k = 0; k < 3; k++) o.pos[k] = a.p[k] + (b.p[k] - a.p[k]) * f;
        nlerpQuat(a.q, b.q, f, o.quat);
        o.speedKmh = a.s + (b.s - a.s) * f;
        return o;
    }
}

function nlerpQuat(a, b, t, out) {
    const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
    const s = dot < 0 ? -1 : 1;
    let l = 0;
    for (let k = 0; k < 4; k++) {
        out[k] = a[k] + (s * b[k] - a[k]) * t;
        l += out[k] * out[k];
    }
    l = Math.sqrt(l) || 1;
    for (let k = 0; k < 4; k++) out[k] /= l;
    return out;
}
