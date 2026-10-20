// Personal bests ('records'), saved replays ('replays') and first-time medal gold.
//
// records: { [trackId]: { bestMs, medal, respawns, replay, date, trackHash, splits, awarded } }
//   medal    best medal ever earned on the track (kept even if the layout changes)
//   awarded  best medal whose gold went to the shared site account
// replays: [{ id, name, trackId, trackName, track?, replay, timeMs, respawns, medal, date }]
//   `track` is embedded for custom tracks so the replay stays watchable.
import { currentAccount, addGold } from './account.js';

const MAX_REPLAYS = 120;

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
