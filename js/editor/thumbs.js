// Palette thumbnails: small top-down SVGs generated from the core block
// geometry (centerline paths, footprint, gates, pads), plus hand-drawn decor
// icons. Pure string output, cached per id.
import { BLOCKS, getBlockGeometry } from '../core/blocks.js';

const PAD_COLORS = {
    turbo: '#3fd8ff', turbo2: '#ff4f8b', noEngine: '#8aa1bd', noSteer: '#b07cff', noBrake: '#ff9a3c',
    slowmo: '#9c7bff', cruise: '#55e08f', fragile: '#d8f3ff', reset: '#ffd35a',
};
const GATE_COLORS = { start: '#6bffb0', finish: '#ffffff', checkpoint: '#7fdcff', startfinish: '#ffd54a' };

const cache = new Map();

const f = (n) => Math.round(n * 10) / 10;

/** Top-down SVG markup for a block id (forward = up). */
export function blockThumb(id, size = 56) {
    const k = id + '|' + size;
    if (cache.has(k)) return cache.get(k);
    const svg = makeBlockThumb(id, size);
    cache.set(k, svg);
    return svg;
}

function makeBlockThumb(id, size) {
    const def = BLOCKS[id];
    if (!def) return '';
    const [sx, sy, sz] = def.size;
    const W = sx * 32, D = sz * 32;
    const span = Math.max(W, D);
    const pad = span * 0.08;
    const vb = `${f(-pad - (span - W) / 2)} ${f(-pad - (span - D) / 2)} ${f(span + pad * 2)} ${f(span + pad * 2)}`;
    const P = (x, z) => `${f(x)},${f(D - z)}`;
    const parts = [];
    // Footprint cells.
    for (let i = 0; i < sx; i++) {
        for (let k = 0; k < sz; k++) {
            parts.push(`<rect x="${i * 32 + 1}" y="${D - (k + 1) * 32 + 1}" width="30" height="30" rx="4" fill="rgba(160,200,240,0.10)" stroke="rgba(200,230,255,0.22)" stroke-width="1"/>`);
        }
    }
    let geo = null;
    try {
        geo = getBlockGeometry(id, def.defaultSurface);
    } catch (e) { /* no geometry: footprint only */ }
    const isPlatform = def.category === 'platform';
    if (isPlatform) parts.push(`<rect x="2" y="2" width="${W - 4}" height="${D - 4}" rx="3" fill="#dcecfb"/>`);
    if (geo) {
        // Height range for the colour ramp (higher = bluer).
        let minY = Infinity, maxY = -Infinity;
        for (const p of geo.paths) for (let i = 1; i < p.pts.length; i += 3) { minY = Math.min(minY, p.pts[i]); maxY = Math.max(maxY, p.pts[i]); }
        const ramp = (y) => {
            const t = maxY - minY > 0.5 ? (y - minY) / (maxY - minY) : 0;
            const r = Math.round(236 - t * 120), g = Math.round(244 - t * 60), b = 255;
            return `rgb(${r},${g},${b})`;
        };
        const roadW = id === 'Narrow' ? 10 : 24;
        const paths = isPlatform ? [] : geo.paths.filter((p) => !(def.gate === 'startfinish' && p.a === -1));
        for (const p of paths) {
            const n = p.pts.length / 3;
            const pts = [];
            for (let i = 0; i < n; i++) pts.push(P(p.pts[i * 3], p.pts[i * 3 + 2]));
            if (id !== 'Narrow') parts.push(`<polyline points="${pts.join(' ')}" fill="none" stroke="#7fa6cc" stroke-width="${roadW + 5}" stroke-linejoin="round"/>`);
            // Colour each segment by height so slopes and banks read.
            for (let i = 0; i < n - 1; i++) {
                const y = (p.pts[i * 3 + 1] + p.pts[(i + 1) * 3 + 1]) / 2;
                const a = i * 3, b = a + 3;
                parts.push(`<line x1="${f(p.pts[a])}" y1="${f(D - p.pts[a + 2])}" x2="${f(p.pts[b])}" y2="${f(D - p.pts[b + 2])}" stroke="${ramp(y)}" stroke-width="${roadW}" stroke-linecap="round"/>`);
            }
        }
        if (id === 'Tunnel') {
            for (let z = 4; z < 32; z += 6) parts.push(`<line x1="3" y1="${D - z}" x2="29" y2="${D - z}" stroke="rgba(110,190,255,0.75)" stroke-width="2.4"/>`);
        }
        if (def.effect) {
            parts.push(`<rect x="6" y="${D - 26}" width="20" height="20" rx="3" fill="${PAD_COLORS[def.effect] || '#fff'}" opacity="0.9"/>`);
            parts.push(`<path d="M11 ${D - 10}l5-6 5 6" fill="none" stroke="#0a1830" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`);
        }
        if (def.gate) {
            const z = def.gate === 'startfinish' ? 8 : 16;
            const col = GATE_COLORS[def.gate];
            if (def.gate === 'finish' || def.gate === 'startfinish') {
                for (let i = 0; i < 6; i++) parts.push(`<rect x="${4 + i * 4}" y="${D - z - 2 - (i % 2) * 2}" width="4" height="2" fill="#0a1830"/>`);
            }
            parts.push(`<rect x="1" y="${D - z - 3}" width="30" height="6" rx="2" fill="none" stroke="${col}" stroke-width="2.5"/>`);
            parts.push(`<circle cx="2" cy="${D - z}" r="3" fill="${col}"/><circle cx="30" cy="${D - z}" r="3" fill="${col}"/>`);
        }
        if (def.category === 'stunt' && (id === 'Loop' || id === 'LoopL')) {
            parts.push(`<circle cx="${W / 2}" cy="${D / 2}" r="${W * 0.28}" fill="none" stroke="#ffd54a" stroke-width="4" stroke-dasharray="6 4"/>`);
        }
        // Exit arrows on open lips (ramps launch here).
        def.connectors.forEach((c) => {
            if (c.kind !== 'lip') return;
            parts.push(`<path d="M8 ${D - 26}L16 ${D - 34}L24 ${D - 26}" fill="none" stroke="#ffd54a" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>`);
        });
    }
    // Entry chevron at connector 0 (where the car drives in).
    const c0 = def.connectors[0];
    if (c0 && !def.spawn) {
        const cx = c0.cell[0] * 32 + 16, cz = c0.cell[2] * 32;
        parts.push(`<path d="M${cx - 6} ${f(D - cz + 1)}l6 -6 6 6" fill="none" stroke="#0a1830" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" opacity="0.55"/>`);
    }
    if (def.spawn && def.gate === 'start') {
        parts.push(`<path d="M16 ${D - 10}l-7 7h14z" transform="rotate(180 16 ${D - 10})" fill="#0a1830" opacity="0.6"/>`);
    }
    if (sy > 1 && def.category !== 'stunt') {
        const rise = def.connectors[1] ? def.connectors[1].cell[1] : 0;
        const label = def.category === 'turn' ? 'bank' : rise ? `+${rise}` : '';
        if (label) parts.push(`<text x="${W - 2}" y="${D - 3}" text-anchor="end" font-size="${span * 0.2}" font-weight="800" font-family="sans-serif" fill="#ffd54a" stroke="#0a1830" stroke-width="${span * 0.03}" paint-order="stroke">${label}</text>`);
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" width="${size}" height="${size}" aria-hidden="true">${parts.join('')}</svg>`;
}

const DECOR_SVG = {
    Pine: '<path d="M32 8L18 30h8L14 46h36L38 30h8z" fill="#3f8f6a"/><path d="M32 8l-6 10h12z" fill="#eef6ff"/><rect x="29" y="46" width="6" height="8" fill="#7a5638"/>',
    PineCluster: '<path d="M20 14L10 32h6L8 44h24L24 32h6z" fill="#2f7a58"/><path d="M42 10L30 30h7L27 44h30L47 30h7z" fill="#3f8f6a"/><path d="M42 10l-5 8h10z" fill="#eef6ff"/><rect x="18" y="44" width="4" height="6" fill="#7a5638"/><rect x="40" y="44" width="5" height="8" fill="#7a5638"/>',
    Igloo: '<path d="M8 48a24 24 0 0 1 48 0z" fill="#eef6ff"/><path d="M26 48a6 7 0 0 1 12 0z" fill="#0a1830"/><path d="M12 38h40M16 30h32M22 22h20" stroke="#9db8d9" stroke-width="1.6"/>',
    Snowman: '<circle cx="32" cy="44" r="12" fill="#eef6ff"/><circle cx="32" cy="24" r="9" fill="#eef6ff"/><path d="M32 24l9 2-9 2z" fill="#ff9a3c"/><circle cx="29" cy="21" r="1.4" fill="#0a1830"/><circle cx="35" cy="21" r="1.4" fill="#0a1830"/><rect x="25" y="10" width="14" height="6" fill="#0a1830"/>',
    PenguinCrowd: '<g fill="#0a1830"><ellipse cx="16" cy="40" rx="7" ry="11"/><ellipse cx="32" cy="36" rx="7" ry="11"/><ellipse cx="48" cy="40" rx="7" ry="11"/></g><g fill="#eef6ff"><ellipse cx="16" cy="43" rx="4" ry="7"/><ellipse cx="32" cy="39" rx="4" ry="7"/><ellipse cx="48" cy="43" rx="4" ry="7"/></g><path d="M24 54h16l-8 6z" fill="#ffd54a"/>',
    Penguin: '<ellipse cx="32" cy="36" rx="12" ry="18" fill="#0a1830"/><ellipse cx="32" cy="40" rx="7" ry="12" fill="#eef6ff"/><path d="M29 26h6l-3 4z" fill="#ff9a3c"/><circle cx="28" cy="23" r="1.6" fill="#eef6ff"/><circle cx="36" cy="23" r="1.6" fill="#eef6ff"/>',
    IceCrystal: '<path d="M32 6l10 20-10 32-10-32z" fill="#7fdcff"/><path d="M32 6l10 20-10 32z" fill="#b8f1ff"/><path d="M18 30l6 6-4 16-8-12z" fill="#5aa8ff"/>',
    Rock: '<path d="M10 48l6-18 14-8 16 6 8 20z" fill="#7d8ea3"/><path d="M16 30l14-8 16 6-12 4z" fill="#eef6ff"/>',
    Banner: '<rect x="12" y="10" width="4" height="46" fill="#9db8d9"/><rect x="48" y="10" width="4" height="46" fill="#9db8d9"/><rect x="14" y="14" width="36" height="16" rx="2" fill="#5aa8ff"/><path d="M22 22h20" stroke="#eef6ff" stroke-width="3"/>',
    Lamp: '<rect x="30" y="16" width="4" height="40" fill="#5b6b80"/><path d="M22 16h20l-4-8H26z" fill="#2a3a52"/><circle cx="32" cy="18" r="5" fill="#ffd54a"/><path d="M24 58h16" stroke="#5b6b80" stroke-width="4"/>',
};

/** Icon markup for a decor kind (unknown kinds draw a pine, like the renderer). */
export function decorThumb(kind, size = 56) {
    const body = DECOR_SVG[kind] || DECOR_SVG.Pine;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}" aria-hidden="true">${body}</svg>`;
}
