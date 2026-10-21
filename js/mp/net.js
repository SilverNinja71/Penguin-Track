// PeerJS glue for online rooms: loads the library on demand (the same pinned
// build the site's Penguin Life uses), opens host / client peers and wraps
// DataConnections into the { id, send, onData, onClose, close } shape room.js
// speaks. Frames are plain JSON text ('raw' serialization), so room.js can
// measure them before parsing.
import { PEER_PREFIX, peerIdFor, makeRoomCode } from './protocol.js';

export const PEERJS_URL = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';
const LOAD_TIMEOUT_MS = 12000;
const OPEN_TIMEOUT_MS = 15000;

let loading = null;

/** Resolves window.Peer, loading PeerJS once. Rejects with a friendly message when offline. */
export function loadPeerJS() {
    if (window.Peer) return Promise.resolve(window.Peer);
    if (loading) return loading;
    loading = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = PEERJS_URL;
        s.async = true;
        s.crossOrigin = 'anonymous';
        const fail = (why) => {
            clearTimeout(timer);
            s.remove();
            loading = null;
            reject(new Error(why));
        };
        const timer = setTimeout(() => fail('The online service took too long to load. Check your connection and try again.'), LOAD_TIMEOUT_MS);
        s.onload = () => {
            clearTimeout(timer);
            if (window.Peer) resolve(window.Peer);
            else fail('The online service loaded but did not start.');
        };
        s.onerror = () => fail("Couldn't reach the online service (unpkg.com). You may be offline, or a blocker stopped it. Hot-seat and split-screen still work.");
        document.head.appendChild(s);
    });
    return loading;
}

/** Wraps a PeerJS DataConnection for room.js. */
export function wrapConnection(dc) {
    const data = [], closed = [];
    let open = true;
    const done = () => {
        if (!open) return;
        open = false;
        for (const f of closed) f();
    };
    dc.on('data', (d) => { for (const f of data) f(d); });
    dc.on('close', done);
    dc.on('error', done);
    // Some browsers only report a dead ICE link through the peer connection.
    const pc = dc.peerConnection;
    if (pc) {
        pc.addEventListener('iceconnectionstatechange', () => {
            if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'closed') done();
        });
    }
    return {
        id: dc.peer,
        send(text) {
            if (open && dc.open) dc.send(text);
        },
        onData(f) { data.push(f); },
        onClose(f) { closed.push(f); },
        close() {
            try {
                dc.close();
            } catch (e) { /* ignore */ }
            done();
        },
    };
}

function friendly(err) {
    const t = err && err.type;
    if (t === 'peer-unavailable') return 'No room with that code. Check the code with your friend.';
    if (t === 'unavailable-id') return 'That room code is taken.';
    if (t === 'network' || t === 'server-error' || t === 'socket-error' || t === 'socket-closed') return "Couldn't reach the matchmaking server. Check your connection and try again.";
    if (t === 'browser-incompatible') return "This browser can't do peer-to-peer connections (WebRTC).";
    if (t === 'ssl-unavailable') return 'Online rooms need the page served over HTTPS.';
    return (err && err.message) || 'The connection failed.';
}

function openPeer(Peer, id) {
    return new Promise((resolve, reject) => {
        let peer;
        try {
            peer = id ? new Peer(id, { debug: 0 }) : new Peer({ debug: 0 });
        } catch (e) {
            reject(e);
            return;
        }
        const timer = setTimeout(() => {
            peer.destroy();
            reject(new Error("Couldn't reach the matchmaking server in time."));
        }, OPEN_TIMEOUT_MS);
        peer.once('open', () => {
            clearTimeout(timer);
            resolve(peer);
        });
        peer.once('error', (e) => {
            clearTimeout(timer);
            peer.destroy();
            const err = new Error(friendly(e));
            err.type = e && e.type;
            reject(err);
        });
    });
}

/**
 * Opens a host peer on a fresh room code (retrying taken codes), or on exactly
 * `want` when given (no retry: a taken code is an error).
 * Returns { peer, code, onConnection(fn), destroy() }.
 */
export async function hostPeer(want = null) {
    const Peer = await loadPeerJS();
    let lastErr = null;
    for (let i = 0; i < (want ? 1 : 4); i++) {
        const code = want || makeRoomCode();
        try {
            const peer = await openPeer(Peer, peerIdFor(code));
            const handlers = [];
            peer.on('connection', (dc) => {
                // Only data channels in our own format; everything else is turned away.
                if (dc.serialization !== 'raw' || !String(dc.peer || '').length) {
                    dc.close();
                    return;
                }
                dc.on('open', () => { for (const f of handlers) f(wrapConnection(dc)); });
            });
            // The signalling link may drop while rooms stay up over WebRTC; ask it back.
            peer.on('disconnected', () => { if (!peer.destroyed) setTimeout(() => !peer.destroyed && peer.reconnect(), 1500); });
            peer.on('error', (e) => console.warn('[penguintrack] room peer:', e && e.type));
            return { peer, code, onConnection: (f) => handlers.push(f), destroy: () => peer.destroy() };
        } catch (e) {
            lastErr = e;
            if (e.type !== 'unavailable-id') break;
        }
    }
    throw lastErr || new Error('Could not open a room.');
}

/** Connects to a room. Returns { peer, conn (wrapped), destroy() }. */
export async function joinPeer(code) {
    const Peer = await loadPeerJS();
    const peer = await openPeer(Peer, null);
    return new Promise((resolve, reject) => {
        let settled = false;
        const dc = peer.connect(peerIdFor(code), { reliable: true, serialization: 'raw' });
        const fail = (msg) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            peer.destroy();
            reject(new Error(msg));
        };
        const timer = setTimeout(() => fail('The room did not answer. Check the code, or ask the host to keep the game open.'), OPEN_TIMEOUT_MS);
        dc.on('open', () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ peer, conn: wrapConnection(dc), destroy: () => peer.destroy() });
        });
        // Errors after joining (a signalling hiccup) leave the data channel alone.
        peer.on('error', (e) => fail(friendly(e)));
        peer.on('disconnected', () => { if (settled && !peer.destroyed) peer.reconnect(); });
    });
}

export { PEER_PREFIX };
