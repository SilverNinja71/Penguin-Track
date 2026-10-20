// Hot-seat match state (pure, JSON-safe, Node-tested): 2–8 players take turns
// on a playlist of tracks, each turn limited to K attempts or a driving-time
// budget. Best times score 10/8/6/5/4/3/2/1 per track; most points wins.
import { rankRuns, isBetter } from './scoring.js';

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 8;
export const MAX_TRACKS = 12;
export const PLAYER_COLORS = ['#ff5d6c', '#5aa8ff', '#5fd88a', '#ffd54a', '#c48bff', '#ff9f4a', '#6fe3e0', '#f4f9ff'];

/**
 * opts: { players: [name…], tracks: [{ id, name, platform? , ref }],
 *         limit: { type: 'attempts', count } | { type: 'time', ms } }
 * `ref` is whatever the caller needs to load the track (an id or the track JSON).
 */
export function createMatch(opts) {
    const names = (opts.players || []).map((n, i) => String(n || '').trim() || `Penguin ${i + 1}`);
    if (names.length < MIN_PLAYERS || names.length > MAX_PLAYERS) throw new Error(`Hot-seat needs ${MIN_PLAYERS}–${MAX_PLAYERS} players`);
    const tracks = (opts.tracks || []).slice(0, MAX_TRACKS);
    if (!tracks.length) throw new Error('Pick at least one track');
    const limit = normalizeLimit(opts.limit);
    return {
        version: 1,
        players: names.map((name, i) => ({ name, color: PLAYER_COLORS[i % PLAYER_COLORS.length] })),
        tracks: tracks.map((t) => ({ id: t.id, name: t.name || t.id, platform: !!t.platform, ref: t.ref ?? t.id })),
        limit,
        trackIndex: 0,
        turnIndex: 0,
        phase: 'turn',          // 'turn' | 'trackResults' | 'done'
        runs: tracks.map(() => names.map(() => emptyRun())),
        awarded: [],            // per finished track: points per player index
    };
}

function emptyRun() {
    return { best: null, attempts: 0, usedMs: 0, finishes: 0 };
}

export function normalizeLimit(l) {
    if (l && l.type === 'time') {
        const ms = Math.round(Number(l.ms) || 0);
        return { type: 'time', ms: Math.max(30000, Math.min(15 * 60000, ms || 120000)) };
    }
    const count = Math.round(Number(l && l.count) || 0);
    return { type: 'attempts', count: Math.max(1, Math.min(20, count || 3)) };
}

/** Player order on a track: the first driver rotates from track to track. */
export function turnOrder(m, trackIndex = m.trackIndex) {
    const n = m.players.length;
    return m.players.map((_, i) => (i + trackIndex) % n);
}

/** Index of the player whose turn it is (or -1 outside a turn). */
export function turnPlayer(m) {
    if (m.phase !== 'turn') return -1;
    return turnOrder(m)[m.turnIndex];
}

export function currentTrack(m) {
    return m.tracks[m.trackIndex] || null;
}

/** The current player's run state on the current track. */
export function turnRun(m) {
    const p = turnPlayer(m);
    return p < 0 ? null : m.runs[m.trackIndex][p];
}

/** Driving time left in this turn (time limit), or Infinity. */
export function timeLeft(m) {
    const r = turnRun(m);
    if (!r || m.limit.type !== 'time') return Infinity;
    return Math.max(0, m.limit.ms - r.usedMs);
}

export function attemptsLeft(m) {
    const r = turnRun(m);
    if (!r) return 0;
    if (m.limit.type !== 'attempts') return Infinity;
    return Math.max(0, m.limit.count - r.attempts);
}

export function canStartAttempt(m) {
    return m.phase === 'turn' && (m.limit.type === 'time' ? timeLeft(m) > 0 : attemptsLeft(m) > 0);
}

/** Counts a new run (first start or restart). Returns false when none is left. */
export function startAttempt(m) {
    if (!canStartAttempt(m)) return false;
    turnRun(m).attempts++;
    return true;
}

/** Adds driven race time to the turn (time-limit mode). */
export function addDriven(m, ms) {
    const r = turnRun(m);
    if (r && ms > 0) r.usedMs += Math.round(ms);
}

/**
 * A finished run of the current player. run: { timeMs, respawns, replay?, splits? }.
 * Returns { improved, previous }.
 */
export function submitFinish(m, run) {
    const r = turnRun(m);
    if (!r || !run || !Number.isFinite(run.timeMs)) return { improved: false, previous: null };
    r.finishes++;
    const previous = r.best;
    const cand = { timeMs: run.timeMs, respawns: run.respawns || 0, replay: run.replay || null, splits: run.splits || [] };
    const improved = isBetter(cand, previous, currentTrack(m).platform);
    if (improved) r.best = cand;
    return { improved, previous };
}

/** True when the turn is over by its limit (no attempts or time left). */
export function turnSpent(m) {
    return !canStartAttempt(m);
}

/** Ends the current turn; after the last player the track is scored. */
export function endTurn(m) {
    if (m.phase !== 'turn') return m.phase;
    m.turnIndex++;
    if (m.turnIndex >= m.players.length) {
        const ranked = trackRanking(m, m.trackIndex);
        const pts = m.players.map(() => 0);
        for (const r of ranked) pts[r.player] = r.points;
        m.awarded[m.trackIndex] = pts;
        m.phase = m.trackIndex + 1 >= m.tracks.length ? 'done' : 'trackResults';
    }
    return m.phase;
}

/** From the track results to the next track's first turn. */
export function nextTrack(m) {
    if (m.phase !== 'trackResults') return m.phase;
    m.trackIndex++;
    m.turnIndex = 0;
    m.phase = 'turn';
    return m.phase;
}

/** [{ player, name, color, run, place, points, finished }] for one track. */
export function trackRanking(m, ti = m.trackIndex) {
    const track = m.tracks[ti];
    const entries = m.players.map((p, i) => ({ player: i, name: p.name, color: p.color, run: m.runs[ti][i].best }));
    return rankRuns(entries, track && track.platform);
}

/** Overall standings: [{ player, name, color, points, wins, place }], best first (ties share a place). */
export function standings(m) {
    const rows = m.players.map((p, i) => ({ player: i, name: p.name, color: p.color, points: 0, wins: 0, finishes: 0 }));
    m.awarded.forEach((pts, ti) => {
        if (!pts) return;
        pts.forEach((v, i) => { rows[i].points += v; });
        for (const r of trackRanking(m, ti)) {
            if (r.place === 0) rows[r.player].wins++;
            if (r.finished) rows[r.player].finishes++;
        }
    });
    rows.sort((a, b) => b.points - a.points || b.wins - a.wins || a.player - b.player);
    let place = 0;
    rows.forEach((r, k) => {
        if (k > 0 && (rows[k - 1].points !== r.points || rows[k - 1].wins !== r.wins)) place = k;
        r.place = place;
    });
    return rows;
}

/** Best run on the current track so far among the other players (ghost to chase), or null. */
export function leaderRun(m, exceptPlayer = -1) {
    const ranked = trackRanking(m).filter((r) => r.finished && r.player !== exceptPlayer);
    return ranked.length ? { player: ranked[0].player, name: ranked[0].name, run: ranked[0].run } : null;
}
