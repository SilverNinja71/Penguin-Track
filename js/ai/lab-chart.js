// Training curve for the AI Lab: best and mean fitness per generation (left
// axis), the fastest finish of each generation (right axis, seconds) and the
// share of the flock that finished (bars along the bottom). Plain canvas 2D.
import { niceRange } from './lab-logic.js';

const COLORS = {
    best: '#7fdcff', mean: '#9db8d9', time: '#ffd54a', finish: 'rgba(107, 255, 176, 0.28)',
    grid: 'rgba(200, 230, 255, 0.12)', text: '#9db8d9', mark: '#ffffff',
};

export function drawChart(canvas, rows) {
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const w = Math.max(10, canvas.clientWidth), hgt = Math.max(10, canvas.clientHeight);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hgt * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(hgt * dpr);
    }
    const g = canvas.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, hgt);
    g.font = '600 10px ui-monospace, Menlo, monospace';
    const L = 34, R = 34, T = 8, B = 16;
    const pw = w - L - R, ph = hgt - T - B;
    if (!rows.length) {
        g.fillStyle = COLORS.text;
        g.textAlign = 'center';
        const msg = 'The curve appears after the first generation';
        if (g.measureText(msg).width < w - 12) g.fillText(msg, w / 2, hgt / 2);
        else {
            g.fillText('The curve appears after', w / 2, hgt / 2 - 7);
            g.fillText('the first generation', w / 2, hgt / 2 + 7);
        }
        return;
    }
    const n = rows.length;
    const g0 = rows[0].generation, g1 = rows[n - 1].generation;
    const xOf = (gen) => L + (g1 > g0 ? ((gen - g0) / (g1 - g0)) * pw : pw / 2);
    const [flo, fhi] = niceRange(rows.flatMap((r) => [r.best, r.mean]));
    const yF = (v) => T + ph - ((v - flo) / (fhi - flo)) * ph;
    const times = rows.map((r) => (r.bestTimeMs != null ? r.bestTimeMs / 1000 : null)).filter((v) => v != null);
    const [tlo, thi] = niceRange(times);
    const yT = (v) => T + ph - ((v - tlo) / (thi - tlo)) * ph;

    // Grid and left labels.
    g.strokeStyle = COLORS.grid;
    g.lineWidth = 1;
    g.fillStyle = COLORS.text;
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
        const v = flo + ((fhi - flo) * i) / 4;
        const y = Math.round(yF(v)) + 0.5;
        g.beginPath();
        g.moveTo(L, y);
        g.lineTo(L + pw, y);
        g.stroke();
        g.fillText(v.toFixed(0), L - 4, y);
    }
    if (times.length) {
        g.textAlign = 'left';
        g.fillStyle = COLORS.time;
        for (let i = 0; i <= 4; i += 2) {
            const v = tlo + ((thi - tlo) * i) / 4;
            g.fillText(`${v.toFixed(1)}s`, L + pw + 4, yT(v));
        }
    }
    g.textAlign = 'center';
    g.textBaseline = 'top';
    g.fillStyle = COLORS.text;
    g.fillText(`gen ${g0 + 1}`, L + 14, T + ph + 4);
    if (g1 > g0) g.fillText(`gen ${g1 + 1}`, L + pw - 14, T + ph + 4);

    // Finish rate bars (full height = everyone finished).
    const bw = Math.max(1, pw / Math.max(1, n) - 1);
    g.fillStyle = COLORS.finish;
    for (const r of rows) {
        if (!(r.finishRate > 0)) continue;
        const bh = r.finishRate * ph * 0.35;
        g.fillRect(xOf(r.generation) - bw / 2, T + ph - bh, bw, bh);
    }

    const line = (pick, y, color, width, dash) => {
        g.strokeStyle = color;
        g.lineWidth = width;
        g.setLineDash(dash || []);
        g.beginPath();
        let started = false;
        for (const r of rows) {
            const v = pick(r);
            if (v == null || !Number.isFinite(v)) {
                started = false;
                continue;
            }
            const x = xOf(r.generation), yy = y(v);
            if (started) g.lineTo(x, yy);
            else g.moveTo(x, yy);
            started = true;
        }
        g.stroke();
        g.setLineDash([]);
    };
    line((r) => r.mean, yF, COLORS.mean, 1.5, [4, 3]);
    if (times.length) line((r) => (r.bestTimeMs != null ? r.bestTimeMs / 1000 : null), yT, COLORS.time, 1.5);
    line((r) => r.best, yF, COLORS.best, 2.2);

    // Latest point.
    const last = rows[n - 1];
    g.fillStyle = COLORS.mark;
    g.beginPath();
    g.arc(xOf(last.generation), yF(last.best), 3, 0, Math.PI * 2);
    g.fill();
}

export const CHART_COLORS = COLORS;
