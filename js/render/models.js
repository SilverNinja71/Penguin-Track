// Low-poly scenery models as merged, vertex-coloured geometries (one draw per
// kind when instanced). Every model stands on y = 0, faces +Z, 1 unit = 1 m.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/BufferGeometryUtils.js';

const _c = new THREE.Color();

/** Non-indexed copy with a solid colour (or fn(x, y, z, nx, ny, nz) -> hex per face). */
export function paint(geo, color) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    g.deleteAttribute('uv');
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    const pos = g.getAttribute('position');
    const n = pos.count;
    const col = new Float32Array(n * 3);
    const fn = typeof color === 'function' ? color : null;
    if (!fn) _c.set(color);
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), fnm = new THREE.Vector3();
    for (let i = 0; i < n; i += 3) {
        if (fn) {
            a.fromBufferAttribute(pos, i); b.fromBufferAttribute(pos, i + 1); c.fromBufferAttribute(pos, i + 2);
            fnm.subVectors(c, b).cross(a.clone().sub(b)).normalize();
            const cx = (a.x + b.x + c.x) / 3, cy = (a.y + b.y + c.y) / 3, cz = (a.z + b.z + c.z) / 3;
            _c.set(fn(cx, cy, cz, fnm.x, fnm.y, fnm.z));
        }
        for (let k = 0; k < 3; k++) {
            col[(i + k) * 3] = _c.r; col[(i + k) * 3 + 1] = _c.g; col[(i + k) * 3 + 2] = _c.b;
        }
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return g;
}

/** Moves a geometry in place (rotation order X, Y, Z, then scale, then translation). */
export function place(g, { x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, s = null } = {}) {
    if (s) Array.isArray(s) ? g.scale(s[0], s[1], s[2]) : g.scale(s, s, s);
    if (rx) g.rotateX(rx);
    if (ry) g.rotateY(ry);
    if (rz) g.rotateZ(rz);
    g.translate(x, y, z);
    return g;
}

export function merge(list) {
    const g = mergeGeometries(list, false);
    for (const p of list) p.dispose();
    g.computeBoundingSphere();
    return g;
}

/** Deterministic hash of a position: the same vertex always jitters the same way. */
function hash3(x, y, z) {
    let h = Math.imul(Math.round(x * 1000) | 0, 73856093) ^ Math.imul(Math.round(y * 1000) | 0, 19349663) ^ Math.imul(Math.round(z * 1000) | 0, 83492791);
    h = Math.imul(h ^ (h >>> 13), 0x5bd1e995);
    return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

function jitter(g, amount) {
    const p = g.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
        const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
        p.setXYZ(i, x + (hash3(x, y, z) - 0.5) * amount, y + (hash3(y, z, x) - 0.5) * amount, z + (hash3(z, x, y) - 0.5) * amount);
    }
    g.computeVertexNormals();
    return g;
}

// ---------------------------------------------------------------------------

/** Snowy pine, ~12 m tall: trunk, three green tiers, each with a snow cap. */
export function pineGeometry() {
    const parts = [paint(place(new THREE.CylinderGeometry(0.32, 0.55, 2.8, 5, 1, true), { y: 1.4 }), 0x6b4a32)];
    const tiers = [[1.7, 5.6, 4.1, 0x2d6b4e], [4.5, 4.8, 3.2, 0x2a6448], [7.1, 4.4, 2.2, 0x347856]];
    tiers.forEach(([y, h, r, col], i) => {
        parts.push(paint(place(new THREE.ConeGeometry(r, h, 7, 1, i > 0), { y: y + h / 2, ry: i * 0.4 }), (x, yy) => {
            // Darker underside, lighter toward the top.
            const t = (yy - y) / h;
            return new THREE.Color(col).offsetHSL(0, 0, -0.06 + t * 0.08).getHex();
        }));
        const sh = h * 0.56, sr = r * 0.56 * 1.06;
        parts.push(paint(place(new THREE.ConeGeometry(sr, sh, 7, 1, true), { y: y + h - sh / 2 + 0.1, ry: i * 0.4 + Math.PI / 7 }), 0xf4f8ff));
    });
    // A drift of snow around the foot of the tree.
    parts.push(paint(new THREE.ConeGeometry(1.8, 0.7, 7, 1, true), 0xf2f7fd));
    return merge(parts);
}

/** Boulder with snow on its upward faces, ~3.4 × 2 × 2.8 m. */
export function rockGeometry() {
    const g = jitter(new THREE.IcosahedronGeometry(1, 1), 0.38);
    place(g, { s: [1.7, 1.05, 1.4], y: 0.55 });
    return merge([paint(g, (x, y, z, nx, ny) => (ny > 0.55 ? 0xf3f7fc : ny > 0.25 ? 0xa9b6c9 : (hash3(x, y, z) > 0.5 ? 0x6f7f98 : 0x7d8ca4)))]);
}

/** Cluster of ice crystals, ~5 m tall; tips glow white. */
export function crystalGeometry() {
    const spikes = [[0, 0, 0, 1, 0, 0], [1.1, 0, 0.4, 0.7, 0.35, 0.9], [-0.9, 0, 0.6, 0.62, -0.3, 2.1], [0.2, 0, -1.0, 0.8, 0.25, 3.7], [-0.5, 0, -0.5, 0.5, -0.45, 5]];
    const parts = spikes.map(([x, y, z, s, tilt, yaw]) => {
        const g = new THREE.OctahedronGeometry(1, 0);
        place(g, { s: [0.55 * s, 2.6 * s, 0.55 * s], rz: tilt, ry: yaw });
        g.translate(x, y + 1.6 * s, z);
        return paint(g, (cx, cy) => new THREE.Color(0x3a8fd8).lerp(new THREE.Color(0xeafcff), Math.min(1, cy / 4.2)).getHex());
    });
    return merge(parts);
}

/** Igloo: a blocky dome with an entrance tunnel and a dark doorway. */
export function iglooGeometry() {
    const R = 5.2;
    const dome = paint(new THREE.SphereGeometry(R, 14, 6, 0, Math.PI * 2, 0, Math.PI / 2), (x, y, z) => {
        const row = Math.floor((Math.asin(Math.min(1, y / R)) / (Math.PI / 2)) * 6);
        const col = Math.floor(((Math.atan2(z, x) + Math.PI) / (Math.PI * 2)) * 14 + row * 0.5);
        return (row + col) % 2 ? 0xffffff : (row % 3 ? 0xe2eefa : 0xd5e6f7);
    });
    const tunnel = paint(place(new THREE.CylinderGeometry(2.0, 2.0, 3.2, 10, 1, false, Math.PI / 2, Math.PI), { rx: Math.PI / 2, z: R - 0.2 }), (x, y, z) => (Math.floor(z) % 2 ? 0xf8fbff : 0xdfeaf7));
    const door = paint(place(new THREE.CircleGeometry(1.45, 12, 0, Math.PI), { z: R + 1.42, y: 0.02 }), 0x1a2a46);
    return merge([dome, tunnel, door]);
}

/** Snowman with a carrot nose, coal eyes, a top hat and a red scarf (~6.6 m). */
export function snowmanGeometry() {
    const white = 0xf6f9fe;
    const parts = [
        paint(place(new THREE.IcosahedronGeometry(1.6, 1), { y: 1.4 }), white),
        paint(place(new THREE.IcosahedronGeometry(1.15, 1), { y: 3.55 }), white),
        paint(place(new THREE.IcosahedronGeometry(0.82, 1), { y: 5.05 }), white),
        paint(place(new THREE.ConeGeometry(0.16, 0.9, 6), { rx: Math.PI / 2, y: 5.0, z: 1.15 }), 0xff8a1f),
        paint(place(new THREE.CylinderGeometry(0.55, 0.55, 0.95, 10), { y: 6.2 }), 0x1b1f2d),
        paint(place(new THREE.CylinderGeometry(0.9, 0.9, 0.1, 12), { y: 5.75 }), 0x1b1f2d),
        paint(place(new THREE.CylinderGeometry(0.57, 0.57, 0.18, 10), { y: 5.9 }), 0xe02a3a),
        paint(place(new THREE.TorusGeometry(0.85, 0.2, 6, 12), { rx: Math.PI / 2, y: 4.35 }), 0xe02a3a),
        paint(place(new THREE.BoxGeometry(0.35, 1.1, 0.12), { x: 0.5, y: 3.7, z: 0.95, rz: 0.2 }), 0xe02a3a),
    ];
    for (const s of [-1, 1]) {
        parts.push(paint(place(new THREE.IcosahedronGeometry(0.1, 0), { x: s * 0.3, y: 5.3, z: 0.72 }), 0x14161f));
        parts.push(paint(place(new THREE.CylinderGeometry(0.06, 0.08, 2.2, 5), { rz: s * 1.0, x: s * 1.8, y: 4.0 }), 0x6b4a32));
    }
    for (let k = 0; k < 3; k++) parts.push(paint(place(new THREE.IcosahedronGeometry(0.12, 0), { y: 3.2 + k * 0.42, z: 1.08 - Math.abs(k - 1) * 0.06 }), 0x14161f));
    return merge(parts);
}

/** Spectator penguin, ~1.35 m tall (a bit larger than life so crowds read from the car). */
export function penguinGeometry() {
    const black = 0x1d2233, white = 0xf7fbff, orange = 0xff9a1f;
    const ell = (sx, sy, sz, opts, col, w = 6, h = 4) => paint(place(new THREE.SphereGeometry(1, w, h), { s: [sx, sy, sz], ...opts }), col);
    const parts = [
        ell(0.42, 0.56, 0.38, { y: 0.58 }, black, 7, 5),
        ell(0.31, 0.44, 0.2, { y: 0.55, z: 0.21 }, white),
        ell(0.28, 0.27, 0.28, { y: 1.15 }, black),
        ell(0.18, 0.15, 0.11, { y: 1.12, z: 0.19 }, white, 5, 3),
        paint(place(new THREE.ConeGeometry(0.07, 0.22, 4, 1, true), { rx: Math.PI / 2, y: 1.1, z: 0.36 }), orange),
    ];
    for (const s of [-1, 1]) {
        parts.push(ell(0.13, 0.05, 0.19, { x: s * 0.14, y: 0.04, z: 0.12 }, orange, 4, 2));
        parts.push(ell(0.07, 0.33, 0.14, { x: s * 0.41, y: 0.66, rz: s * 0.35 }, black, 4, 3));
    }
    return merge(parts);
}

/** Lamp post with a lantern on top (bulb drawn separately so it can glow). */
export function lampGeometry() {
    const navy = 0x27324d;
    return merge([
        paint(place(new THREE.CylinderGeometry(0.42, 0.55, 0.5, 8), { y: 0.25 }), navy),
        paint(place(new THREE.CylinderGeometry(0.11, 0.15, 6.4, 6), { y: 3.4 }), navy),
        paint(place(new THREE.CylinderGeometry(0.5, 0.32, 0.16, 6), { y: 6.62 }), navy),
        paint(place(new THREE.ConeGeometry(0.62, 0.5, 6), { y: 7.55 }), navy),
        paint(place(new THREE.ConeGeometry(0.66, 0.26, 6), { y: 7.72 }), 0xf4f8ff),
    ]);
}
export const LAMP_BULB_Y = 7.05;

/** Low-poly mountain with snow above the tree line; `seed` varies the shape. */
export function mountainGeometry(radius, height, seed) {
    const rings = 7, segs = 20;
    const rnd = (i, j) => hash3(i * 1.37 + seed % 997, j * 2.11, seed % 389);
    const pts = [];
    for (let k = 0; k <= rings; k++) {
        const row = [];
        for (let j = 0; j < segs; j++) {
            // Jitter stays below half the ring spacing so the surface never folds over itself.
            const a = (j / segs) * Math.PI * 2 + (k ? (rnd(k, j) - 0.5) * 0.12 : 0);
            const t = k / rings;
            const r = radius * (k ? k + (rnd(j, k) - 0.5) * 0.6 : 0) / rings;
            let h = height * Math.pow(1 - t, 1.3) * (0.88 + rnd(k + 9, j) * 0.24);
            if (k === rings) h = -30;
            row.push(new THREE.Vector3(Math.cos(a) * r, k === 0 ? height : h, Math.sin(a) * r));
        }
        pts.push(row);
    }
    const pos = [];
    const push = (...v) => { for (const p of v) pos.push(p.x, p.y, p.z); };
    for (let k = 0; k < rings; k++) {
        for (let j = 0; j < segs; j++) {
            const a = pts[k][j], b = pts[k][(j + 1) % segs], c = pts[k + 1][j], d = pts[k + 1][(j + 1) % segs];
            if (k === 0) push(a, d, c);
            else push(a, b, c, b, d, c);
        }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    const snowLine = height * (0.42 + (seed % 7) * 0.03);
    return paint(g, (x, y, z, nx, ny) => {
        const n = hash3(x * 0.01, y * 0.01, z * 0.01);
        if (y > snowLine - n * height * 0.15 && ny > 0.35) return n > 0.3 ? 0xf3f7fd : 0xdbe7f5;
        if (ny > 0.72) return 0xe9f1fb;
        return n > 0.5 ? 0x5d6f8c : 0x6d7f9b;
    });
}
