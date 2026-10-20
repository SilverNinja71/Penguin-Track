// Ranking and points shared by hot-seat, split-screen and online rooms (pure,
// Node-tested). Trackmania round points: 10/8/6/5/4/3/2/1, ties share the
// better place, no finish scores nothing.

export const POINTS = [10, 8, 6, 5, 4, 3, 2, 1];

/** Points for a 0-based place (ties already resolved to the shared place). */
export function pointsFor(place) {
    return place >= 0 && place < POINTS.length ? POINTS[place] : 0;
}

/**
 * Compares two runs { timeMs, respawns }: negative when a is better. Platform
 * tracks rank by respawns first. Runs without a time sort last.
 */
export function compareRuns(a, b, platform = false) {
    const fa = a && Number.isFinite(a.timeMs), fb = b && Number.isFinite(b.timeMs);
    if (!fa || !fb) return fa === fb ? 0 : fa ? -1 : 1;
    if (platform) {
        const d = (a.respawns || 0) - (b.respawns || 0);
        if (d) return d;
    }
    return a.timeMs - b.timeMs;
}

/** True when run a beats run b (or b is missing). */
export function isBetter(a, b, platform = false) {
    if (!a || !Number.isFinite(a.timeMs)) return false;
    return compareRuns(a, b, platform) < 0;
}

/**
 * Ranks entries [{ ...any, run: { timeMs, respawns } | null }] and returns new
 * objects in order with { place (0-based, ties share it), points, finished }.
 * The input order breaks ties for display only (earlier first).
 */
export function rankRuns(entries, platform = false) {
    const list = entries.map((e, i) => ({ e, i }));
    list.sort((x, y) => compareRuns(x.e.run, y.e.run, platform) || x.i - y.i);
    const out = [];
    let place = 0;
    for (let k = 0; k < list.length; k++) {
        const { e } = list[k];
        const finished = !!(e.run && Number.isFinite(e.run.timeMs));
        if (k > 0 && compareRuns(list[k - 1].e.run, e.run, platform) !== 0) place = k;
        out.push({ ...e, place: finished ? place : -1, points: finished ? pointsFor(place) : 0, finished });
    }
    return out;
}
