// Race-time text shared by the HUD, results, replays, TAS and the AI lab, so
// every screen shows the same digits. Race times are whole ticks (multiples of
// 10 ms); digits are truncated, never rounded up, like Trackmania.

/**
 * formatTime(ms, { style = 'race', sign = false, empty = '-:--.--' })
 *   style 'race'  m:ss.cc    0:42.37   12:05.20
 *         'long'  m:ss.ccc   0:42.370  (milliseconds, the trailing 0 included)
 *         'short' ss.cc under a minute (42.37), m:ss.cc above
 *   sign: prefix '+' for times >= 0 (deltas and splits); negatives always get '-'.
 *   empty: returned for null, undefined, NaN or Infinity.
 */
export function formatTime(ms, opts = {}) {
    const { style = 'race', sign = false, empty = '-:--.--' } = opts;
    if (ms === null || ms === undefined || !Number.isFinite(ms)) return empty;
    const neg = ms < 0;
    const t = Math.floor(neg ? -ms : ms);
    const min = Math.floor(t / 60000);
    const sec = Math.floor(t / 1000) % 60;
    const frac = style === 'long' ? pad(t % 1000, 3) : pad(Math.floor((t % 1000) / 10), 2);
    const body = style === 'short' && min === 0 ? `${sec}.${frac}` : `${min}:${pad(sec, 2)}.${frac}`;
    return (neg ? '-' : sign ? '+' : '') + body;
}

function pad(n, w) {
    return String(n).padStart(w, '0');
}
