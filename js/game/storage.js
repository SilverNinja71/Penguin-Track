// Local saves for Penguintrack. Every key is namespaced so the other games on
// this site never collide with ours. Keys in use: settings, records (Pure-run
// personal bests and medals), boards (the Pure / TAS / AI leaderboards),
// replays, tracks, tas (TAS Studio projects), tasMode (Quick TAS or Pro Studio)
// and the AI Lab's saved drivers.
// A value that does not fit (quota) is kept in memory for the rest of the
// session, and reads prefer it, so a full disk never shows an older save.
const PREFIX = 'penguintrack:';

function backend() {
    try {
        return globalThis.localStorage || null;
    } catch (e) {
        return null;
    }
}

const memory = new Map();

export function get(key, fallback = null) {
    const ls = backend();
    try {
        const raw = memory.has(key) || !ls ? memory.get(key) : ls.getItem(PREFIX + key);
        return raw == null ? fallback : JSON.parse(raw);
    } catch (e) {
        return fallback;
    }
}

export function set(key, value) {
    const raw = JSON.stringify(value);
    const ls = backend();
    try {
        if (ls) {
            ls.setItem(PREFIX + key, raw);
            memory.delete(key);
        } else {
            memory.set(key, raw);
        }
        return true;
    } catch (e) {
        // Quota exceeded or storage disabled: keep it for this session at least.
        memory.set(key, raw);
        return false;
    }
}

export function update(key, fallback, fn) {
    const value = fn(get(key, fallback));
    set(key, value);
    return value;
}

export function remove(key) {
    const ls = backend();
    try {
        if (ls) ls.removeItem(PREFIX + key);
    } catch (e) { /* ignore */ }
    memory.delete(key);
}

export default { get, set, update, remove };
