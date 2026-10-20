// Procedural canvas textures for the renderer. Every texture is drawn once on a
// 2D canvas and cached for the page, so rebuilding a world costs no redraws.
import * as THREE from 'three';
import { Rng } from '../core/rng.js';

const cache = new Map();
let maxAniso = 1;

/** Effect colours (pads, icons, particles), matching the snow vocabulary. */
export const EFFECT_COLORS = {
    turbo: '#39d8ff',      // Frost Boost
    turbo2: '#ff2f7a',     // Avalanche Boost
    noEngine: '#8fa6c8',   // Frozen Engine
    noSteer: '#a46bff',    // Frozen Wheel
    noBrake: '#ff9a2e',    // Brake Freeze
    slowmo: '#c77dff',     // Snow Globe
    cruise: '#4fe08a',     // Glide
    fragile: '#dff3ff',    // Thin Ice
    reset: '#ffd23f',      // Thaw
};

export const SURFACE_STRIPES = { snow: '#3f95f0', powder: '#ff9f43', ice: '#ffffff' };

export function setMaxAnisotropy(n) {
    maxAniso = Math.max(1, n | 0);
    for (const t of cache.values()) {
        if (t.userData.aniso) {
            t.anisotropy = maxAniso;
            t.needsUpdate = true;
        }
    }
}

function canvas(w, h) {
    if (typeof document !== 'undefined') {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        return c;
    }
    return new OffscreenCanvas(w, h);
}

function cached(key, make) {
    let t = cache.get(key);
    if (!t) {
        t = make();
        cache.set(key, t);
    }
    return t;
}

function finish(cv, { repeat = true, color = true, aniso = true } = {}) {
    const t = new THREE.CanvasTexture(cv);
    if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
    if (color) t.colorSpace = THREE.SRGBColorSpace;
    t.userData.aniso = aniso;
    t.anisotropy = aniso ? maxAniso : 1;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    return t;
}

// ---------------------------------------------------------------------------
// Seeded helpers (textures are identical on every load)

/** Seeded uniform [0, 1) generator (the core mulberry32), as a plain function. */
export function rngOf(seed) {
    const g = new Rng(seed);
    return () => g.next();
}

/** Tileable value-noise fbm in [0, 1], w × h, base lattice of `cells` per side. */
function tileNoise(w, h, cells, octaves, seed, stretch = [1, 1]) {
    const out = new Float32Array(w * h);
    const rnd = rngOf(seed);
    let amp = 1, total = 0;
    for (let o = 0; o < octaves; o++) {
        const cx = Math.max(1, Math.round(cells * stretch[0]) << o), cy = Math.max(1, Math.round(cells * stretch[1]) << o);
        const lat = new Float32Array(cx * cy);
        for (let i = 0; i < lat.length; i++) lat[i] = rnd();
        for (let y = 0; y < h; y++) {
            const fy = (y / h) * cy, iy = Math.floor(fy), ty = fy - iy;
            const sy = ty * ty * (3 - 2 * ty);
            const y0 = iy % cy, y1 = (iy + 1) % cy;
            for (let x = 0; x < w; x++) {
                const fx = (x / w) * cx, ix = Math.floor(fx), tx = fx - ix;
                const sx = tx * tx * (3 - 2 * tx);
                const x0 = ix % cx, x1 = (ix + 1) % cx;
                const a = lat[y0 * cx + x0], b = lat[y0 * cx + x1], c = lat[y1 * cx + x0], d = lat[y1 * cx + x1];
                out[y * w + x] += amp * (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy);
            }
        }
        total += amp;
        amp *= 0.5;
    }
    for (let i = 0; i < out.length; i++) out[i] /= total;
    return out;
}

function hexRgb(hex) {
    const c = new THREE.Color(hex);
    return [c.r * 255, c.g * 255, c.b * 255];
}

/** Paints a base colour modulated by noise: col = mix(dark, light, n) with per-pixel grain. */
function paintNoise(ctx, w, h, dark, light, noise, grain, seed, contrast = 1) {
    const img = ctx.createImageData(w, h);
    const d = img.data;
    const A = hexRgb(dark), B = hexRgb(light);
    const rnd = rngOf(seed);
    for (let i = 0; i < w * h; i++) {
        let n = noise ? (noise[i] - 0.5) * contrast + 0.5 : 0.5;
        n = Math.min(1, Math.max(0, n));
        const g = (rnd() - 0.5) * grain;
        d[i * 4] = A[0] + (B[0] - A[0]) * n + g;
        d[i * 4 + 1] = A[1] + (B[1] - A[1]) * n + g;
        d[i * 4 + 2] = A[2] + (B[2] - A[2]) * n + g;
        d[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
}

function sparkles(ctx, w, h, count, seed, color = 'rgba(255,255,255,0.9)', size = 1.2) {
    const rnd = rngOf(seed);
    ctx.fillStyle = color;
    for (let i = 0; i < count; i++) {
        const x = rnd() * w, y = rnd() * h, s = size * (0.5 + rnd());
        ctx.fillRect(x, y, s, s);
    }
}

/** Draws fn at the 9 wrap offsets so marks crossing an edge tile seamlessly. */
function wrapped(w, h, fn) {
    for (const ox of [-w, 0, w]) for (const oy of [-h, 0, h]) fn(ox, oy);
}

// ---------------------------------------------------------------------------
// Road decks: u = lateral metres (-12..12, mapped to 0..1 by the material), v = metres along

const ROAD_PX = 512;          // across 24 m and along 24 m

function roadMarkings(ctx, w, h, stripe, glowOnly = false) {
    const m = w / 24;          // px per metre
    ctx.save();
    // Edge bands: a solid colour band and a thin white line just inside it.
    for (const side of [0, 1]) {
        const x0 = side === 0 ? 0.15 * m : w - 0.15 * m - 0.55 * m;
        ctx.fillStyle = stripe;
        ctx.fillRect(x0, 0, 0.55 * m, h);
        if (!glowOnly) {
            ctx.fillStyle = 'rgba(255,255,255,0.85)';
            const x1 = side === 0 ? x0 + 0.75 * m : x0 - 0.35 * m;
            ctx.fillRect(x1, 0, 0.14 * m, h);
        }
    }
    // Centre dashes: 4 m dash, 4 m gap (a crisp speed cue).
    ctx.globalAlpha = glowOnly ? 0.75 : 0.55;
    ctx.fillStyle = stripe;
    for (let v = 0; v < 24; v += 8) ctx.fillRect(w / 2 - 0.16 * m, v * m + 1 * m, 0.32 * m, 4 * m);
    ctx.restore();
}

function tyreGrooves(ctx, w, h, color, seed) {
    const m = w / 24;
    const rnd = rngOf(seed);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineCap = 'round';
    const lanes = [-8.2, -6.5, -1.7, 0.0, 4.6, 6.3];
    for (const u of lanes) {
        const amp = 0.15 + rnd() * 0.35, ph = rnd() * 6.28, wid = (0.18 + rnd() * 0.14) * m;
        ctx.lineWidth = wid;
        ctx.globalAlpha = 0.18 + rnd() * 0.12;
        ctx.beginPath();
        for (let y = 0; y <= h; y += 4) {
            // Integer periods along the tile keep it seamless.
            const x = w / 2 + (u + amp * Math.sin((y / h) * Math.PI * 2 * 2 + ph)) * m;
            if (y === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
    }
    ctx.restore();
}

function cracks(ctx, w, h, count, seed, color, width = 1.5) {
    const rnd = rngOf(seed);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineJoin = 'round';
    for (let i = 0; i < count; i++) {
        const pts = [[rnd() * w, rnd() * h]];
        let ang = rnd() * Math.PI * 2;
        const n = 4 + Math.floor(rnd() * 6);
        for (let k = 0; k < n; k++) {
            ang += (rnd() - 0.5) * 1.4;
            const len = 10 + rnd() * 30;
            const p = pts[pts.length - 1];
            pts.push([p[0] + Math.cos(ang) * len, p[1] + Math.sin(ang) * len]);
        }
        ctx.lineWidth = width * (0.6 + rnd());
        ctx.globalAlpha = 0.35 + rnd() * 0.45;
        wrapped(w, h, (ox, oy) => {
            ctx.beginPath();
            pts.forEach(([x, y], k) => (k ? ctx.lineTo(x + ox, y + oy) : ctx.moveTo(x + ox, y + oy)));
            ctx.stroke();
            // A short branch now and then.
            if (pts.length > 3) {
                const b = pts[2];
                ctx.beginPath();
                ctx.moveTo(b[0] + ox, b[1] + oy);
                ctx.lineTo(b[0] + ox + 14 * Math.cos(i), b[1] + oy + 14 * Math.sin(i * 1.7));
                ctx.stroke();
            }
        });
    }
    ctx.restore();
}

const DECK_STYLE = {
    snow: { dark: '#c9d8ea', light: '#f2f7fd', contrast: 1.5, grain: 9, grooves: 'rgba(120,150,190,1)' },
    powder: { dark: '#ecdfca', light: '#fffaf2', contrast: 1.8, grain: 10, grooves: 'rgba(170,135,90,1)' },
    ice: { dark: '#4fa6dc', light: '#a9e2fb', contrast: 1.7, grain: 4, grooves: null },
};

function deckBase(ctx, w, h, surface, seed) {
    const st = DECK_STYLE[surface];
    let noise;
    if (surface === 'powder') {
        // Wind-blown drifts: ripples across the road, softened by noise.
        const a = tileNoise(w, h, 3, 4, seed + 1);
        const b = tileNoise(w, h, 2, 3, seed + 2, [1, 6]);
        noise = new Float32Array(w * h);
        for (let i = 0; i < noise.length; i++) noise[i] = 0.55 * a[i] + 0.45 * b[i];
    } else if (surface === 'ice') {
        noise = tileNoise(w, h, 3, 5, seed + 3);
    } else {
        noise = tileNoise(w, h, 4, 5, seed + 4);
    }
    paintNoise(ctx, w, h, st.dark, st.light, noise, st.grain, seed + 5, st.contrast);
    if (surface === 'ice') {
        // Frozen depth: darker swirls, frost streaks and white cracks.
        const g = ctx.createLinearGradient(0, 0, w, h);
        g.addColorStop(0, 'rgba(255,255,255,0.10)');
        g.addColorStop(0.5, 'rgba(255,255,255,0)');
        g.addColorStop(1, 'rgba(255,255,255,0.10)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
        cracks(ctx, w, h, 16, seed + 6, 'rgba(240,252,255,1)', 1.6);
        cracks(ctx, w, h, 10, seed + 7, 'rgba(40,110,170,1)', 1.2);
        sparkles(ctx, w, h, 240, seed + 8, 'rgba(255,255,255,0.8)', 1.4);
    } else if (surface === 'powder') {
        sparkles(ctx, w, h, 900, seed + 9, 'rgba(255,255,255,0.95)', 1.3);
        sparkles(ctx, w, h, 300, seed + 10, 'rgba(160,120,70,0.25)', 2.2);
    } else {
        sparkles(ctx, w, h, 400, seed + 11, 'rgba(255,255,255,0.9)', 1.1);
        sparkles(ctx, w, h, 500, seed + 12, 'rgba(90,120,160,0.12)', 2.0);
    }
}

export function roadTexture(surface) {
    return cached('road_' + surface, () => {
        const w = ROAD_PX, h = ROAD_PX;
        const cv = canvas(w, h);
        const ctx = cv.getContext('2d');
        deckBase(ctx, w, h, surface, 11 + surface.length * 7);
        if (DECK_STYLE[surface].grooves) tyreGrooves(ctx, w, h, DECK_STYLE[surface].grooves, 99);
        roadMarkings(ctx, w, h, SURFACE_STRIPES[surface]);
        return finish(cv);
    });
}

/** Emissive companion of the road texture: only the markings glow (night moods). */
export function roadGlowTexture(surface) {
    return cached('roadglow_' + surface, () => {
        const w = 256, h = 256;
        const cv = canvas(w, h);
        const ctx = cv.getContext('2d');
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, w, h);
        roadMarkings(ctx, w, h, SURFACE_STRIPES[surface] === '#ffffff' ? '#bfeaff' : SURFACE_STRIPES[surface], true);
        return finish(cv);
    });
}

/** Snowfield platforms: 8 m tiles instead of lanes; u, v in metres over 32 m. */
export function platformTexture(surface) {
    return cached('platform_' + surface, () => {
        const w = 512, h = 512;
        const cv = canvas(w, h);
        const ctx = cv.getContext('2d');
        deckBase(ctx, w, h, surface, 41 + surface.length * 3);
        const m = w / 32;
        ctx.strokeStyle = surface === 'ice' ? 'rgba(235,250,255,0.55)' : 'rgba(70,120,190,0.28)';
        ctx.lineWidth = 0.18 * m;
        for (let k = 0; k <= 4; k++) {
            ctx.beginPath();
            ctx.moveTo(k * 8 * m, 0); ctx.lineTo(k * 8 * m, h);
            ctx.moveTo(0, k * 8 * m); ctx.lineTo(w, k * 8 * m);
            ctx.stroke();
        }
        // A snowflake stamp in every tile corner keeps the field readable at speed.
        ctx.fillStyle = SURFACE_STRIPES[surface] === '#ffffff' ? 'rgba(255,255,255,0.6)' : SURFACE_STRIPES[surface];
        ctx.globalAlpha = 0.5;
        for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) ctx.fillRect((i * 8 + 4) * m - 3, (j * 8 + 4) * m - 3, 6, 6);
        return finish(cv);
    });
}

// ---------------------------------------------------------------------------
// Snowbanks, deck walls, ground

export function borderTexture(striped = false) {
    return cached('border_' + striped, () => {
        const w = 256, h = 256;      // 4 m × 4 m
        const cv = canvas(w, h);
        const ctx = cv.getContext('2d');
        const n = tileNoise(w, h, 4, 4, 77);
        paintNoise(ctx, w, h, '#e2ebf6', '#ffffff', n, 5, 78, 1.3);
        sparkles(ctx, w, h, 160, 79, 'rgba(255,255,255,1)', 1.2);
        if (striped) {
            // Candy-stripe caps near gates: 1 m blue, 1 m white along the bank.
            ctx.globalAlpha = 0.92;
            for (let k = 0; k < 4; k += 2) {
                ctx.fillStyle = '#2f7fe6';
                ctx.fillRect(0, k * 64, w, 64);
            }
            ctx.globalAlpha = 0.25;
            const n2 = tileNoise(w, h, 8, 2, 80);
            const img = ctx.getImageData(0, 0, w, h);
            for (let i = 0; i < w * h; i++) {
                const f = 0.9 + n2[i] * 0.2;
                img.data[i * 4] *= f; img.data[i * 4 + 1] *= f; img.data[i * 4 + 2] = Math.min(255, img.data[i * 4 + 2] * f);
            }
            ctx.putImageData(img, 0, 0);
        }
        return finish(cv);
    });
}

/** Packed ice blocks for deck sides, undersides and pillars (4 m × 4 m tile). */
export function wallTexture() {
    return cached('wall', () => {
        const w = 256, h = 256;
        const cv = canvas(w, h);
        const ctx = cv.getContext('2d');
        ctx.fillStyle = '#e8f4ff';
        ctx.fillRect(0, 0, w, h);
        const rnd = rngOf(5);
        const bw = 128, bh = 64;
        for (let row = 0; row < 4; row++) {
            const off = row % 2 ? bw / 2 : 0;
            for (let col = -1; col < 3; col++) {
                const x = col * bw + off, y = row * bh;
                const t = rnd();
                const c0 = new THREE.Color('#7fb4e2').lerp(new THREE.Color('#b7dcf6'), t);
                const g = ctx.createLinearGradient(x, y, x + bw, y + bh);
                g.addColorStop(0, '#' + c0.clone().offsetHSL(0, 0, 0.06).getHexString());
                g.addColorStop(1, '#' + c0.clone().offsetHSL(0, 0, -0.05).getHexString());
                ctx.fillStyle = g;
                wrapped(w, h, (ox, oy) => ctx.fillRect(x + 3 + ox, y + 3 + oy, bw - 6, bh - 6));
                // A frosty highlight along the top edge of each block.
                ctx.fillStyle = 'rgba(255,255,255,0.35)';
                wrapped(w, h, (ox, oy) => ctx.fillRect(x + 6 + ox, y + 5 + oy, bw - 14, 4));
            }
        }
        cracks(ctx, w, h, 6, 9, 'rgba(255,255,255,1)', 1);
        return finish(cv);
    });
}

/** Deep snow ground: soft white with gentle blue hollows (128 m tile, low contrast so it never looks tiled). */
export function groundTexture() {
    return cached('ground', () => {
        const w = 512, h = 512;
        const cv = canvas(w, h);
        const ctx = cv.getContext('2d');
        const a = tileNoise(w, h, 2, 6, 211);
        const b = tileNoise(w, h, 7, 3, 215);
        for (let i = 0; i < a.length; i++) a[i] = a[i] * 0.75 + b[i] * 0.25;
        paintNoise(ctx, w, h, '#e1eaf5', '#ffffff', a, 5, 212, 1.5);
        sparkles(ctx, w, h, 1600, 213, 'rgba(255,255,255,1)', 1.0);
        sparkles(ctx, w, h, 200, 214, 'rgba(150,190,235,0.35)', 1.3);
        return finish(cv);
    });
}

/** Translucent tunnel ice. */
export function roofTexture() {
    return cached('roof', () => {
        const w = 256, h = 256;
        const cv = canvas(w, h);
        const ctx = cv.getContext('2d');
        const n = tileNoise(w, h, 3, 4, 301);
        paintNoise(ctx, w, h, '#7cc6ef', '#d3f1ff', n, 3, 302, 1.2);
        ctx.globalAlpha = 0.45;
        cracks(ctx, w, h, 6, 303, 'rgba(255,255,255,1)', 0.9);
        ctx.globalAlpha = 1;
        return finish(cv);
    });
}

// ---------------------------------------------------------------------------
// Line decals (uv 0..1 over the 24 m wide strip; u = 0 is the driver's right)

export function lineTexture(kind) {
    return cached('line_' + kind, () => {
        const w = 768, h = 64;
        const cv = canvas(w, h);
        const ctx = cv.getContext('2d');
        if (kind === 'finish') {
            const s = w / 24;
            for (let i = 0; i < 24; i++) {
                for (let j = 0; j < 2; j++) {
                    ctx.fillStyle = (i + j) % 2 ? '#10213d' : '#ffffff';
                    ctx.fillRect(i * s, j * (h / 2), s, h / 2);
                }
            }
        } else if (kind === 'start') {
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, w, h);
            ctx.fillStyle = '#26c4ff';
            for (let i = 0; i < 24; i += 2) ctx.fillRect(i * 32, 0, 32, h);
        } else {
            const g = ctx.createLinearGradient(0, 0, 0, h);
            g.addColorStop(0, '#4fd6ff');
            g.addColorStop(0.5, '#e4fbff');
            g.addColorStop(1, '#4fd6ff');
            ctx.fillStyle = g;
            ctx.fillRect(0, 0, w, h);
            ctx.fillStyle = 'rgba(30,140,220,0.55)';
            for (let i = 0; i < 24; i++) {
                ctx.beginPath();
                ctx.moveTo(i * 32 + 4, h / 2); ctx.lineTo(i * 32 + 16, 6); ctx.lineTo(i * 32 + 28, h / 2); ctx.lineTo(i * 32 + 16, h - 6);
                ctx.fill();
            }
        }
        return finish(cv, { repeat: false });
    });
}

// ---------------------------------------------------------------------------
// Pads and icons

function chevron(ctx, cx, cy, w, h, thick) {
    ctx.beginPath();
    ctx.moveTo(cx - w / 2, cy + h / 2);
    ctx.lineTo(cx, cy - h / 2);
    ctx.lineTo(cx + w / 2, cy + h / 2);
    ctx.lineTo(cx + w / 2 - thick, cy + h / 2);
    ctx.lineTo(cx, cy - h / 2 + thick * 1.25);
    ctx.lineTo(cx - w / 2 + thick, cy + h / 2);
    ctx.closePath();
    ctx.fill();
}

function snowflake(ctx, cx, cy, r, lw) {
    ctx.save();
    ctx.lineWidth = lw;
    ctx.lineCap = 'round';
    for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2;
        const dx = Math.cos(a), dy = Math.sin(a);
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + dx * r, cy + dy * r);
        for (const t of [0.55, 0.8]) {
            const bx = cx + dx * r * t, by = cy + dy * r * t;
            for (const s of [-1, 1]) {
                const b = a + s * 0.75;
                ctx.moveTo(bx, by);
                ctx.lineTo(bx + Math.cos(b) * r * 0.25, by + Math.sin(b) * r * 0.25);
            }
        }
        ctx.stroke();
    }
    ctx.restore();
}

/** Draws an effect icon centred at (cx, cy) with radius r in the current fill/stroke colour. */
export function drawEffectIcon(ctx, effect, cx, cy, r) {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const lw = r * 0.16;
    ctx.lineWidth = lw;
    switch (effect) {
        case 'turbo':
            chevron(ctx, cx, cy - r * 0.28, r * 1.2, r * 0.6, r * 0.24);
            chevron(ctx, cx, cy + r * 0.32, r * 1.2, r * 0.6, r * 0.24);
            break;
        case 'turbo2':
            for (let k = -1; k <= 1; k++) chevron(ctx, cx, cy + k * r * 0.48, r * 1.25, r * 0.5, r * 0.2);
            break;
        case 'noEngine':
            // Power symbol under frost.
            ctx.beginPath();
            ctx.arc(cx, cy + r * 0.05, r * 0.62, -Math.PI / 2 + 0.6, Math.PI * 1.5 - 0.6);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(cx, cy - r * 0.75); ctx.lineTo(cx, cy - r * 0.05);
            ctx.stroke();
            break;
        case 'noSteer':
            ctx.beginPath();
            ctx.arc(cx, cy, r * 0.7, 0, Math.PI * 2);
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(cx, cy, r * 0.16, 0, Math.PI * 2);
            ctx.fill();
            ctx.beginPath();
            ctx.moveTo(cx - r * 0.7, cy); ctx.lineTo(cx + r * 0.7, cy);
            ctx.moveTo(cx, cy); ctx.lineTo(cx, cy + r * 0.7);
            ctx.stroke();
            ctx.lineWidth = lw * 1.2;
            ctx.beginPath();
            ctx.moveTo(cx - r * 0.85, cy - r * 0.85); ctx.lineTo(cx + r * 0.85, cy + r * 0.85);
            ctx.stroke();
            break;
        case 'noBrake':
            ctx.beginPath();
            ctx.arc(cx, cy, r * 0.5, 0, Math.PI * 2);
            ctx.stroke();
            for (const s of [-1, 1]) {
                ctx.beginPath();
                ctx.arc(cx, cy, r * 0.82, s > 0 ? -0.7 : Math.PI - 0.7, s > 0 ? 0.7 : Math.PI + 0.7);
                ctx.stroke();
            }
            ctx.fillRect(cx - lw / 2, cy - r * 0.32, lw, r * 0.38);
            ctx.fillRect(cx - lw / 2, cy + r * 0.14, lw, lw);
            break;
        case 'slowmo':
            ctx.beginPath();
            ctx.arc(cx, cy - r * 0.12, r * 0.62, 0, Math.PI * 2);
            ctx.stroke();
            ctx.fillRect(cx - r * 0.55, cy + r * 0.55, r * 1.1, r * 0.28);
            snowflake(ctx, cx, cy - r * 0.12, r * 0.32, lw * 0.5);
            break;
        case 'cruise':
            ctx.beginPath();
            ctx.moveTo(cx - r * 0.75, cy + r * 0.35);
            ctx.bezierCurveTo(cx - r * 0.3, cy - r * 0.1, cx + r * 0.1, cy + r * 0.6, cx + r * 0.75, cy + r * 0.1);
            ctx.stroke();
            chevron(ctx, cx, cy - r * 0.35, r * 0.9, r * 0.45, r * 0.18);
            break;
        case 'fragile':
            ctx.beginPath();
            for (let k = 0; k < 6; k++) {
                const a = (k / 6) * Math.PI * 2 + Math.PI / 6;
                const x = cx + Math.cos(a) * r * 0.78, y = cy + Math.sin(a) * r * 0.78;
                if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y);
            }
            ctx.closePath();
            ctx.stroke();
            ctx.lineWidth = lw * 0.6;
            ctx.beginPath();
            ctx.moveTo(cx - r * 0.1, cy - r * 0.7); ctx.lineTo(cx + r * 0.08, cy - r * 0.2);
            ctx.lineTo(cx - r * 0.18, cy + r * 0.12); ctx.lineTo(cx + r * 0.05, cy + r * 0.7);
            ctx.moveTo(cx + r * 0.08, cy - r * 0.2); ctx.lineTo(cx + r * 0.5, cy - r * 0.05);
            ctx.stroke();
            break;
        case 'reset':
            ctx.beginPath();
            ctx.arc(cx, cy, r * 0.34, 0, Math.PI * 2);
            ctx.fill();
            for (let k = 0; k < 8; k++) {
                const a = (k / 8) * Math.PI * 2;
                ctx.beginPath();
                ctx.moveTo(cx + Math.cos(a) * r * 0.52, cy + Math.sin(a) * r * 0.52);
                ctx.lineTo(cx + Math.cos(a) * r * 0.82, cy + Math.sin(a) * r * 0.82);
                ctx.stroke();
            }
            break;
        default:
            snowflake(ctx, cx, cy, r * 0.8, lw * 0.6);
    }
    ctx.restore();
}

/** Pad decal: 24 × 20 m, forward (v = 1) is the top of the canvas. */
export function padTexture(effect) {
    return cached('pad_' + effect, () => {
        const w = 512, h = 428;
        const cv = canvas(w, h);
        const ctx = cv.getContext('2d');
        const col = EFFECT_COLORS[effect] || '#ffffff';
        const c = new THREE.Color(col);
        const bg = new THREE.Color('#0d2748').lerp(c, 0.28);
        ctx.fillStyle = '#' + bg.getHexString();
        ctx.fillRect(0, 0, w, h);
        // Diagonal hazard-like bands make the pad readable from far away.
        ctx.save();
        ctx.globalAlpha = 0.16;
        ctx.fillStyle = col;
        for (let k = -h; k < w; k += 56) {
            ctx.beginPath();
            ctx.moveTo(k, h); ctx.lineTo(k + 28, h); ctx.lineTo(k + 28 + h, 0); ctx.lineTo(k + h, 0);
            ctx.fill();
        }
        ctx.restore();
        ctx.strokeStyle = col;
        ctx.lineWidth = 18;
        ctx.strokeRect(14, 14, w - 28, h - 28);
        ctx.fillStyle = col;
        const boosty = effect === 'turbo' || effect === 'turbo2' || effect === 'cruise';
        if (boosty) {
            const n = effect === 'turbo2' ? 4 : 3;
            for (let k = 0; k < n; k++) chevron(ctx, w / 2, h - 80 - k * ((h - 120) / n), w * 0.55, 74, 30);
        } else {
            ctx.strokeStyle = col;
            drawEffectIcon(ctx, effect, w / 2, h / 2, 120);
            ctx.globalAlpha = 0.7;
            chevron(ctx, w * 0.14, h / 2, 60, 34, 12);
            chevron(ctx, w * 0.86, h / 2, 60, 34, 12);
        }
        return finish(cv, { repeat: false });
    });
}

/** Round floating icon sprite for a pad. */
export function iconTexture(effect) {
    return cached('icon_' + effect, () => {
        const s = 256;
        const cv = canvas(s, s);
        const ctx = cv.getContext('2d');
        const col = EFFECT_COLORS[effect] || '#ffffff';
        const g = ctx.createRadialGradient(s / 2, s / 2, s * 0.3, s / 2, s / 2, s / 2);
        g.addColorStop(0, col);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.globalAlpha = 0.55;
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, s, s);
        ctx.globalAlpha = 1;
        ctx.beginPath();
        ctx.arc(s / 2, s / 2, s * 0.34, 0, Math.PI * 2);
        ctx.fillStyle = '#0c2446';
        ctx.fill();
        ctx.lineWidth = s * 0.05;
        ctx.strokeStyle = col;
        ctx.stroke();
        ctx.fillStyle = col;
        ctx.strokeStyle = col;
        drawEffectIcon(ctx, effect, s / 2, s / 2, s * 0.24);
        return finish(cv, { repeat: false, aniso: false });
    });
}

/** Order of the icons in iconAtlasTexture (3 × 3 cells, row by row from the top). */
export const ICON_ORDER = ['turbo', 'turbo2', 'noEngine', 'noSteer', 'noBrake', 'slowmo', 'cruise', 'fragile', 'reset'];

/** Every pad icon in one 3 × 3 atlas (one draw for all floating icons). */
export function iconAtlasTexture() {
    return cached('icon_atlas', () => {
        const s = 256;
        const cv = canvas(s * 3, s * 3);
        const ctx = cv.getContext('2d');
        ICON_ORDER.forEach((e, i) => {
            const t = iconTexture(e);
            ctx.drawImage(t.image, (i % 3) * s, Math.floor(i / 3) * s, s, s);
        });
        return finish(cv, { repeat: false, aniso: false });
    });
}

// ---------------------------------------------------------------------------
// Banners, particles, glows, labels

export function bannerTexture(kind) {
    return cached('banner_' + kind, () => {
        const w = 1024, h = 160;
        const cv = canvas(w, h);
        const ctx = cv.getContext('2d');
        if (kind === 'finish' || kind === 'lap') {
            const s = h / 4;
            for (let i = 0; i < w / s; i++) {
                for (let j = 0; j < 4; j++) {
                    ctx.fillStyle = (i + j) % 2 ? '#0f1f3a' : '#ffffff';
                    ctx.fillRect(i * s, j * s, s, s);
                }
            }
            const label = kind === 'finish' ? 'FINISH' : 'LAP';
            ctx.fillStyle = 'rgba(10,24,48,0.85)';
            const tw = kind === 'finish' ? 420 : 260;
            ctx.fillRect(w / 2 - tw / 2, 18, tw, h - 36);
            ctx.font = 'bold 96px "Baloo 2", "Arial Black", "Trebuchet MS", sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillStyle = '#ffffff';
            ctx.fillText(label, w / 2, h / 2 + 6);
        } else if (kind === 'checkpoint') {
            const g = ctx.createLinearGradient(0, 0, 0, h);
            g.addColorStop(0, '#0f5d9c');
            g.addColorStop(1, '#063461');
            ctx.fillStyle = g;
            ctx.fillRect(0, 0, w, h);
            ctx.strokeStyle = '#bff3ff';
            snowflake(ctx, 110, h / 2, 56, 9);
            snowflake(ctx, w - 110, h / 2, 56, 9);
            ctx.font = 'bold 84px "Baloo 2", "Arial Black", "Trebuchet MS", sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillStyle = '#e8fbff';
            ctx.fillText('CHECKPOINT', w / 2, h / 2 + 6);
        } else {
            const g = ctx.createLinearGradient(0, 0, 0, h);
            g.addColorStop(0, '#1c5fae');
            g.addColorStop(1, '#0b2f63');
            ctx.fillStyle = g;
            ctx.fillRect(0, 0, w, h);
            ctx.fillStyle = 'rgba(255,255,255,0.12)';
            for (let i = 0; i < 40; i++) ctx.fillRect((i * 97) % w, (i * 53) % h, 6, 6);
            ctx.font = 'bold 100px "Baloo 2", "Arial Black", "Trebuchet MS", sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.lineWidth = 10;
            ctx.strokeStyle = '#0a1830';
            ctx.strokeText('PENGUINTRACK', w / 2, h / 2 + 8);
            ctx.fillStyle = '#ffffff';
            ctx.fillText('PENGUINTRACK', w / 2, h / 2 + 8);
            ctx.fillStyle = '#7fdcff';
            ctx.fillRect(40, h - 22, w - 80, 8);
        }
        return finish(cv, { repeat: false });
    });
}

/** Soft round dot for particles (white; tinted per particle). */
export function flakeTexture() {
    return cached('flake', () => {
        const s = 64;
        const cv = canvas(s, s);
        const ctx = cv.getContext('2d');
        const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
        g.addColorStop(0, 'rgba(255,255,255,1)');
        g.addColorStop(0.45, 'rgba(255,255,255,0.85)');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, s, s);
        return finish(cv, { repeat: false, color: false, aniso: false });
    });
}

/** Additive glow halo (lamps, headlights, exhaust). */
export function glowTexture() {
    return cached('glow', () => {
        const s = 128;
        const cv = canvas(s, s);
        const ctx = cv.getContext('2d');
        const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
        g.addColorStop(0, 'rgba(255,255,255,1)');
        g.addColorStop(0.2, 'rgba(255,255,255,0.55)');
        g.addColorStop(0.5, 'rgba(255,255,255,0.12)');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, s, s);
        return finish(cv, { repeat: false, aniso: false });
    });
}

/** Skid marks: dark compacted ruts with soft edges (u across, v along). */
export function skidTexture() {
    return cached('skid', () => {
        const w = 64, h = 64;
        const cv = canvas(w, h);
        const ctx = cv.getContext('2d');
        const g = ctx.createLinearGradient(0, 0, w, 0);
        g.addColorStop(0, 'rgba(255,255,255,0)');
        g.addColorStop(0.2, 'rgba(255,255,255,0.9)');
        g.addColorStop(0.8, 'rgba(255,255,255,0.9)');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        for (let y = 0; y < h; y += 8) ctx.fillRect(8, y, w - 16, 3);
        return finish(cv, { color: false, aniso: false });
    });
}

/** Text label sprite texture (remote players). Not cached: names vary. */
export function labelTexture(text, color = '#7fdcff') {
    const w = 512, h = 128;
    const cv = canvas(w, h);
    const ctx = cv.getContext('2d');
    ctx.font = 'bold 64px "Baloo 2", "Trebuchet MS", sans-serif';
    const tw = Math.min(w - 24, ctx.measureText(text).width + 56);
    ctx.fillStyle = 'rgba(10,24,48,0.78)';
    const x = (w - tw) / 2, r = 40;
    ctx.beginPath();
    ctx.moveTo(x + r, 12); ctx.lineTo(x + tw - r, 12); ctx.arc(x + tw - r, 64, 52, -Math.PI / 2, Math.PI / 2);
    ctx.lineTo(x + r, 116); ctx.arc(x + r, 64, 52, Math.PI / 2, Math.PI * 1.5);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 6;
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, w / 2, 68, w - 60);
    return finish(cv, { repeat: false, aniso: false });
}
