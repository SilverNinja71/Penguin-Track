// Personal bests ('records'), the three-category track leaderboards ('boards'),
// saved replays ('replays') and first-time medal gold.
//
// records: { [trackId]: { bestMs, medal, respawns, replay, date, trackHash, splits, awarded } }
//   The Pure-run personal best: the only runs that earn medals and gold.
//   medal    best medal ever earned on the track (kept even if the layout changes)
//   awarded  best medal whose gold went to the shared site account
// boards: { [trackId]: { pure: [entry], tas: [entry], ai: [entry] } }, best first,
//   at most BOARD_SIZE each. entry: { timeMs, respawns, source, label, model?,
//   rewinds?, trackHash, date, replay?, splits? }. Only each board's leader keeps
//   its replay (its ghost); the rest are times, so the boards stay small.
//   pure  unassisted human runs (race.js, no savestates or TAS tools)
//   tas   Quick TAS (savestate rewinds) or Pro TAS Studio / bruteforce runs
//   ai    AI Lab drivers (js/ai) and the core autopilot
// replays: [{ id, name, trackId, trackName, track?, replay, timeMs, respawns, medal, date }]
//   `track` is embedded for custom tracks so the replay stays watchable.
import { currentAccount, addGold } from './account.js';

const MAX_REPLAYS = 120;
export const BOARD_CATEGORIES = ['pure', 'tas', 'ai'];
export const BOARD_SIZE = 5;
export const CATEGORY_INFO = {
    pure: { label: 'Pure Run', short: 'Human', hint: 'Unassisted runs: no savestates, no TAS tools.' },
    tas: { label: 'Best TAS', short: 'TAS', hint: 'Quick TAS rewinds or the Pro TAS Studio.' },
    ai: { label: 'Best AI', short: 'AI', hint: 'AI Lab drivers and the autopilot.' },
};
/** What made a run: shown on the boards, results and ghost name tags. */
export const SOURCE_LABELS = {
    race: 'Pure run', quick: 'Quick TAS', studio: 'Studio/Bruteforce', autopilot: 'Autopilot', lab: 'AI Lab',
};

export function allRecords(storage) {
    const r = storage.get('records', {});
    return r && typeof r === 'object' ? r : {};
}

/**
 * The record of a track. When `hash` is given and the stored run was made on a
 * different layout, the time is stale: the result carries `stale: true` and no
 * bestMs/replay (the medal stays earned).
 */
export function getRecord(storage, trackId, hash = null) {
    const rec = allRecords(storage)[trackId];
    if (!rec) return null;
    if (hash && rec.trackHash && rec.trackHash !== hash) {
        return { medal: rec.medal || null, awarded: rec.awarded || null, stale: true, bestMs: null, respawns: null, replay: null, splits: null };
    }
    return rec;
}

/**
 * Stores a finished run if it beats the record. run = { timeMs, respawns, replay, splits }.
 * Returns { previous, record, improved, medal, bestMedal, firstMedal }.
 */
export function submitRun(storage, cat, track, hash, run) {
    const all = allRecords(storage);
    const prevRaw = all[track.id] || null;
    const previous = prevRaw ? getRecord(storage, track.id, hash) : null;
    const medal = cat.medalFor(track, { timeMs: run.timeMs, respawns: run.respawns });
    const prevRun = previous && Number.isFinite(previous.bestMs) ? { timeMs: previous.bestMs, respawns: previous.respawns || 0 } : null;
    const improved = cat.isBetterRun(track, { timeMs: run.timeMs, respawns: run.respawns }, prevRun);
    const prevMedal = previous ? previous.medal || null : null;
    const best = cat.medalRank(medal) < cat.medalRank(prevMedal) ? medal : prevMedal;
    let record = prevRaw;
    if (improved || !prevRaw || best !== prevMedal) {
        record = improved || !prevRun
            ? {
                bestMs: run.timeMs,
                respawns: run.respawns || 0,
                medal: best,
                replay: run.replay || null,
                splits: run.splits || [],
                trackHash: hash,
                date: Date.now(),
                awarded: prevRaw ? prevRaw.awarded || null : null,
            }
            : { ...prevRaw, medal: best };
        all[track.id] = record;
        storage.set('records', all);
    }
    return {
        previous,
        record,
        improved,
        medal,
        bestMedal: best,
        firstMedal: !!medal && cat.medalRank(medal) < cat.medalRank(prevMedal),
    };
}

/**
 * Gold for medals earned on an official track for the first time: every medal
 * from the last one paid up to `medal` (Emperor 60, Gold 30, Silver 15, Bronze 5),
 * so a track pays at most 110 however it is reached. Only paid while signed in;
 * otherwise nothing is marked and a later finish can still claim it.
 * Returns { amount, total } or null.
 */
export function awardMedalGold(storage, cat, trackId, medal) {
    if (!medal || !cat.isOfficial(trackId)) return null;
    if (!currentAccount()) return null;
    const all = allRecords(storage);
    const rec = all[trackId];
    if (!rec) return null;
    const paidRank = cat.medalRank(rec.awarded || null);
    const newRank = cat.medalRank(medal);
    if (newRank >= paidRank) return null;
    let amount = 0;
    for (const m of ['emperor', 'gold', 'silver', 'bronze']) {
        const r = cat.medalRank(m);
        if (r >= newRank && r < paidRank) amount += cat.medalReward(m);
    }
    if (amount <= 0) return null;
    const total = addGold(amount);
    if (total == null) return null;
    rec.awarded = medal;
    storage.set('records', all);
    return { amount, total };
}

// ------------------------------------------------------------------ replays

export function listReplays(storage) {
    const list = storage.get('replays', []);
    return Array.isArray(list) ? list.filter((r) => r && r.replay && r.id) : [];
}

function newId() {
    return 'r' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
}

/** Adds a replay to the saved list (newest first). Returns the stored entry, or null if storage is full. */
export function saveReplay(storage, entry) {
    const list = listReplays(storage);
    const item = { id: newId(), date: Date.now(), ...entry };
    list.unshift(item);
    if (list.length > MAX_REPLAYS) list.length = MAX_REPLAYS;
    return storage.set('replays', list) ? item : null;
}

export function deleteReplay(storage, id) {
    storage.set('replays', listReplays(storage).filter((r) => r.id !== id));
}

export function renameReplay(storage, id, name) {
    const list = listReplays(storage);
    const r = list.find((x) => x.id === id);
    if (r) {
        r.name = name;
        storage.set('replays', list);
    }
}

// ------------------------------------------------------------------ boards

function allBoards(storage) {
    const b = storage.get('boards', {});
    return b && typeof b === 'object' && !Array.isArray(b) ? b : {};
}

function cleanEntry(e) {
    return e && typeof e === 'object' && Number.isFinite(e.timeMs) ? e : null;
}

/** Display label of a board entry: 'Quick TAS', 'Studio/Bruteforce', 'ES · gen 12', 'Pure run'… */
export function entryLabel(e) {
    if (!e) return '';
    if (e.label) return e.label;
    return SOURCE_LABELS[e.source] || '';
}

/**
 * The three leaderboards of a track, best first: { pure, tas, ai }. With a
 * layout hash, runs made on another layout are left out. The Pure board also
 * lists the personal best from 'records' (runs saved before the boards existed).
 */
export function getBoards(storage, cat, track, hash = null) {
    const raw = allBoards(storage)[track.id] || {};
    const fresh = (e) => !hash || !e.trackHash || e.trackHash === hash;
    const out = {};
    for (const c of BOARD_CATEGORIES) {
        out[c] = (Array.isArray(raw[c]) ? raw[c] : []).map(cleanEntry).filter((e) => e && fresh(e));
    }
    const rec = getRecord(storage, track.id, hash);
    if (rec && Number.isFinite(rec.bestMs) && !out.pure.some((e) => e.timeMs === rec.bestMs && (e.respawns || 0) === (rec.respawns || 0))) {
        out.pure.push({
            timeMs: rec.bestMs, respawns: rec.respawns || 0, source: 'race', label: 'Pure run',
            trackHash: rec.trackHash || hash, date: rec.date || null, replay: rec.replay || null, splits: rec.splits || [],
        });
        sortBoard(cat, track, out.pure);
        if (out.pure.length > BOARD_SIZE) out.pure.length = BOARD_SIZE;
    }
    return out;
}

function sortBoard(cat, track, list) {
    list.sort((a, b) => (cat.isBetterRun(track, a, b) ? -1 : cat.isBetterRun(track, b, a) ? 1 : (a.date || 0) - (b.date || 0)));
}

/** The leader of one board with its replay (for its ghost), or null. */
export function boardLeader(storage, cat, track, hash, category) {
    const top = (getBoards(storage, cat, track, hash)[category] || [])[0];
    return top && top.replay ? top : null;
}

/**
 * Adds a finished run to a track's board. run = { timeMs, respawns, replay,
 * splits, source, label?, model?, rewinds? }. Runs from another layout are
 * dropped from the board first, and a run matching a listed one (same time,
 * respawns and source) is not listed twice. Returns { category, previous (the
 * old leader or null), improved (new leader), rank (1-based, 0 = off the
 * board), entry, saved (false when storage was full), duplicate? }.
 */
export function submitBoardRun(storage, cat, track, hash, category, run) {
    if (!BOARD_CATEGORIES.includes(category)) throw new Error(`Unknown leaderboard '${category}'`);
    const all = allBoards(storage);
    const boards = all[track.id] && typeof all[track.id] === 'object' ? all[track.id] : {};
    const current = getBoards(storage, cat, track, hash)[category];
    const previous = current[0] || null;
    const entry = {
        timeMs: run.timeMs,
        respawns: run.respawns || 0,
        source: run.source || (category === 'pure' ? 'race' : category === 'tas' ? 'studio' : 'lab'),
        label: run.label || SOURCE_LABELS[run.source] || '',
        trackHash: hash,
        date: Date.now(),
        replay: run.replay || null,
        splits: run.splits || [],
    };
    if (run.model) entry.model = String(run.model).slice(0, 60);
    if (entry.source === 'quick' && Number.isFinite(run.rewinds)) entry.rewinds = run.rewinds;
    // The same result from the same tool again (Validate twice, a replayed run) is already listed.
    const same = current.find((e) => e.timeMs === entry.timeMs && (e.respawns || 0) === entry.respawns && e.source === entry.source);
    if (same) return { category, previous, improved: false, rank: current.indexOf(same) + 1, entry: same, saved: true, duplicate: true };
    const list = current.concat([entry]);
    sortBoard(cat, track, list);
    const rank = list.indexOf(entry) + 1;
    if (list.length > BOARD_SIZE) list.length = BOARD_SIZE;
    const onBoard = rank <= BOARD_SIZE;
    // Only the leader keeps its replay (and splits): it is the ghost to race.
    const stored = list.map((e, i) => (i === 0 ? e : { ...e, replay: null, splits: undefined }));
    let saved = true;
    if (onBoard) {
        boards[category] = stored;
        all[track.id] = boards;
        saved = storage.set('boards', all) !== false;
    }
    return { category, previous, improved: rank === 1, rank: onBoard ? rank : 0, entry, saved };
}
