// The penguin snow racer: a stubby bobsled hull on four chunky chained wheels
// with cycle fenders, a rear wing, and a penguin driver (goggles, red scarf).
// Car-local axes match the core: forward +Z, up +Y, left +X. Static parts are
// merged per material (paint, vertex-coloured trim, lamps) to keep draw calls low.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/BufferGeometryUtils.js';
import { glowTexture } from './textures.js';

const WHEEL_X = 0.86, WHEEL_Z = 1.4, WHEEL_R = 0.38, TRAVEL = 0.35;

// Hull cross-sections along z: [z, halfWidth, bottom, top].
const HULL = [
    [-2.05, 0.4, 0.0, 0.34],
    [-1.85, 0.58, -0.14, 0.52],
    [-1.45, 0.64, -0.2, 0.55],
    [-1.05, 0.67, -0.22, 0.46],
    [-0.45, 0.7, -0.23, 0.3],
    [0.3, 0.68, -0.23, 0.46],
    [0.95, 0.58, -0.2, 0.54],
    [1.5, 0.46, -0.12, 0.48],
    [1.95, 0.3, 0.0, 0.38],
    [2.2, 0.1, 0.16, 0.28],
];

function hullAt(z) {
    // Catmull-Rom through the sections, clamped at the ends.
    const n = HULL.length;
    let i = 0;
    while (i < n - 2 && HULL[i + 1][0] < z) i++;
    const p0 = HULL[Math.max(0, i - 1)], p1 = HULL[i], p2 = HULL[i + 1], p3 = HULL[Math.min(n - 1, i + 2)];
    const t = Math.max(0, Math.min(1, (z - p1[0]) / (p2[0] - p1[0])));
    const out = [z, 0, 0, 0];
    for (let k = 1; k < 4; k++) {
        const a = p0[k], b = p1[k], c = p2[k], d = p3[k];
        out[k] = 0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (-a + 3 * b - 3 * c + d) * t * t * t);
    }
    return out;
}

/** Superellipse hull surface over angles [a0, a1] (0 = left side, π/2 = top), closed at the ends when full. */
function hullSurface(a0, a1, segA, segZ, grow = 0) {
    const z0 = HULL[0][0], z1 = HULL[HULL.length - 1][0];
    const pos = [], idx = [];
    const e = 2 / 3.2;   // superellipse exponent: a rounded box
    const full = a1 - a0 >= Math.PI * 2 - 1e-6;
    for (let j = 0; j <= segZ; j++) {
        const z = z0 + (z1 - z0) * (j / segZ);
        const [, hw, yb, yt] = hullAt(z);
        const yc = (yt + yb) / 2, hh = (yt - yb) / 2;
        for (let i = 0; i <= segA; i++) {
            const a = a0 + (a1 - a0) * (i / segA);
            const c = Math.cos(a), s = Math.sin(a);
            pos.push((hw + grow) * Math.sign(c) * Math.pow(Math.abs(c), e), yc + (hh + grow) * Math.sign(s) * Math.pow(Math.abs(s), e), z);
        }
    }
    const row = segA + 1;
    for (let j = 0; j < segZ; j++) {
        for (let i = 0; i < segA; i++) {
            const a = j * row + i, b = a + 1, c = a + row, d = c + 1;
            idx.push(a, c, b, b, c, d);
        }
    }
    if (full) {
        // End caps: fans to the section centres.
        for (const [j, flip] of [[0, true], [segZ, false]]) {
            const z = z0 + (z1 - z0) * (j / segZ);
            const [, , yb, yt] = hullAt(z);
            const ci = pos.length / 3;
            pos.push(0, (yb + yt) / 2, z);
            for (let i = 0; i < segA; i++) {
                const a = j * row + i, b = a + 1;
                if (flip) idx.push(ci, a, b); else idx.push(ci, b, a);
            }
        }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
}

const _col = new THREE.Color();
/** Non-indexed, uv-less geometry with a solid vertex colour, moved into place. */
function part(geo, color, { x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, s = null } = {}) {
    let g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    g.deleteAttribute('uv');
    if (s) Array.isArray(s) ? g.scale(s[0], s[1], s[2]) : g.scale(s, s, s);
    if (rx) g.rotateX(rx);
    if (ry) g.rotateY(ry);
    if (rz) g.rotateZ(rz);
    g.translate(x, y, z);
    if (color != null) {
        _col.set(color);
        const n = g.getAttribute('position').count;
        const c = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) { c[i * 3] = _col.r; c[i * 3 + 1] = _col.g; c[i * 3 + 2] = _col.b; }
        g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    }
    return g;
}

function merged(list) {
    const g = mergeGeometries(list, false);
    for (const p of list) p.dispose();
    g.computeBoundingSphere();
    return g;
}

function mesh(geo, mat, shadow = true) {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = shadow;
    return m;
}

const BLACK = 0x1b1f2d, WHITE = 0xf7fbff, NAVY = 0x16243e, DARK = 0x2c3446, ORANGE = 0xff9a1f;

function buildWheel(mats, left, opts = {}) {
    const steer = new THREE.Group();     // steering pivot (moves with the suspension)
    const spin = new THREE.Group();
    steer.add(spin);
    const side = left ? 1 : -1;
    const parts = [
        part(new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, 0.36, 20), 0x262d3d, { rz: Math.PI / 2 }),
        part(new THREE.TorusGeometry(WHEEL_R - 0.02, 0.05, 6, 20), 0x1c2230, { ry: Math.PI / 2, x: 0.17 }),
        part(new THREE.TorusGeometry(WHEEL_R - 0.02, 0.05, 6, 20), 0x1c2230, { ry: Math.PI / 2, x: -0.17 }),
        part(new THREE.CylinderGeometry(0.21, 0.23, 0.38, 12), WHITE, { rz: Math.PI / 2 }),
        part(new THREE.BoxGeometry(0.39, 0.06, 0.4), 0x3a4660, {}),
        part(new THREE.BoxGeometry(0.39, 0.4, 0.06), 0x3a4660, {}),
        part(new THREE.CylinderGeometry(0.08, 0.08, 0.4, 6), 0xe0202f, { rz: Math.PI / 2 }),
    ];
    // Snow-chain cross links and diagonals: they make the spin readable.
    for (let k = 0; k < 10; k++) {
        const a = (k / 10) * Math.PI * 2;
        const l = part(new THREE.BoxGeometry(0.4, 0.03, 0.06), 0x9fb0c6, { y: WHEEL_R + 0.006 });
        l.rotateX(a);
        parts.push(l);
        const d = part(new THREE.BoxGeometry(0.025, 0.03, 0.26), 0x8b9cb3, { ry: k % 2 ? 0.7 : -0.7, y: WHEEL_R + 0.004 });
        d.rotateX(a + Math.PI / 10);
        parts.push(d);
    }
    spin.add(mesh(merged(parts), mats.trim));
    // Cycle fender: a long arc over the front wheels (turning with them), a short cap at the back.
    const front = !!opts.front;
    const fender = front
        ? new THREE.CylinderGeometry(0.5, 0.5, 0.42, 16, 1, true, 0.15, Math.PI * 0.95)
        : new THREE.CylinderGeometry(0.5, 0.5, 0.42, 10, 1, true, Math.PI * 0.32, Math.PI * 0.42);
    fender.rotateZ(Math.PI / 2);
    steer.add(mesh(fender, mats.paintSide));
    const axle = part(new THREE.CylinderGeometry(0.05, 0.05, 0.4, 6), DARK, { rz: Math.PI / 2, x: -side * 0.22 });
    steer.add(mesh(axle, mats.trim, false));
    return { steer, spin };
}

/** Scarf tails: a dynamic ribbon (two tails × 5 points) updated every frame. */
function scarfRibbon(mat) {
    const N = 5;
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(2 * N * 2 * 3);
    const col = new Float32Array(2 * N * 2 * 3);
    _col.set(0xe02a3a);
    for (let i = 0; i < col.length / 3; i++) { col[i * 3] = _col.r; col[i * 3 + 1] = _col.g; col[i * 3 + 2] = _col.b; }
    const idx = [];
    for (let t = 0; t < 2; t++) {
        for (let k = 0; k < N - 1; k++) {
            const a = (t * N + k) * 2;
            idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
        }
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(idx);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.8, -0.6), 2);
    const m = new THREE.Mesh(g, mat);
    m.frustumCulled = false;
    return {
        mesh: m,
        update(t, s) {
            const p = g.getAttribute('position');
            for (let tail = 0; tail < 2; tail++) {
                const side = tail ? -1 : 1;
                let x = side * 0.09, y = 0.76, z = -0.2;
                for (let k = 0; k < N; k++) {
                    const i = (tail * N + k) * 2;
                    const w = 0.06 - k * 0.006;
                    p.setXYZ(i, x - w, y, z);
                    p.setXYZ(i + 1, x + w, y, z);
                    // Each segment streams back; speed lifts it and makes it flap faster.
                    const flap = Math.sin(t * (7 + 20 * s) - k * 1.2 + tail * 1.7) * (0.04 + 0.1 * s) * k;
                    const droop = (1 - s) * 0.12;
                    z -= 0.17;
                    y += -droop + flap * 0.6 + s * 0.012;
                    x += side * 0.02 + flap * 0.5;
                }
            }
            p.needsUpdate = true;
            g.computeVertexNormals();
        },
    };
}

/**
 * Builds a car model. kind: 'player' | 'ghost' | 'ai' | 'remote'.
 * Returns { root, update(view, dt), setColor, setHeadlights(k), setCockpit(on), setLabel, dispose }.
 */
export function buildCarModel({ kind = 'player', color = 0xe0202f, envMap = null } = {}) {
    const ghost = kind === 'ghost';
    const paintColor = new THREE.Color(color);
    const mats = {
        paint: new THREE.MeshStandardMaterial({ color: paintColor, roughness: 0.38, metalness: 0, envMap, envMapIntensity: 0.45 }),
        paintSide: new THREE.MeshStandardMaterial({ color: paintColor, roughness: 0.38, metalness: 0, envMap, envMapIntensity: 0.45, side: THREE.DoubleSide }),
        trim: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.05, envMap, envMapIntensity: 0.7 }),
        scarf: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, side: THREE.DoubleSide }),
        lamp: new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }),
    };
    const root = new THREE.Group();
    root.name = 'car:' + kind;
    const body = new THREE.Group();
    root.add(body);

    // Painted hull, rear wing and beanie.
    body.add(mesh(merged([
        part(hullSurface(0, Math.PI * 2, 40, 36), null),
        part(new THREE.BoxGeometry(1.74, 0.08, 0.44), null, { y: 0.92, z: -1.82 }),
    ]), mats.paint));

    // Everything else that never moves, in vertex colours.
    const trim = [];
    for (const c of [Math.PI / 2 - 0.2, Math.PI / 2 + 0.2]) trim.push(part(hullSurface(c - 0.075, c + 0.075, 3, 36, 0.012), WHITE));
    trim.push(part(hullSurface(Math.PI * 1.08, Math.PI * 1.92, 10, 36, 0.01), NAVY));
    // Cockpit tub and its white rim.
    trim.push(part(new THREE.CircleGeometry(1, 24), 0x0b1426, { rx: -Math.PI / 2, s: [0.56, 0.78, 1], y: 0.31, z: -0.42 }));
    const rim = part(new THREE.TorusGeometry(1, 0.05, 6, 28), WHITE, { rx: Math.PI / 2 });
    rim.scale(0.58, 1, 0.8);
    rim.translate(0, 0.33, -0.42);
    trim.push(rim);
    trim.push(part(new THREE.BoxGeometry(1.76, 0.085, 0.1), WHITE, { y: 0.92, z: -1.7 }));
    for (const s of [-1, 1]) {
        trim.push(part(new THREE.BoxGeometry(0.06, 0.44, 0.2), DARK, { x: s * 0.45, y: 0.68, z: -1.8 }));
        trim.push(part(new THREE.BoxGeometry(0.05, 0.36, 0.56), WHITE, { x: s * 0.89, y: 0.88, z: -1.82 }));
        trim.push(part(new THREE.CylinderGeometry(0.075, 0.09, 0.32, 10), DARK, { rx: Math.PI / 2, x: s * 0.22, y: 0.12, z: -2.0 }));
        trim.push(part(new THREE.CylinderGeometry(0.05, 0.05, 0.02, 10), 0x0a0d14, { rx: Math.PI / 2, x: s * 0.22, y: 0.12, z: -2.17 }));
    }
    // Number roundel on the nose.
    trim.push(part(new THREE.CircleGeometry(0.17, 18), WHITE, { rx: -Math.PI / 2 + 0.35, y: 0.5, z: 1.25 }));
    body.add(mesh(merged(trim), mats.trim));

    // Head and tail lights.
    const lampParts = [];
    const lamps = [];
    for (const s of [-1, 1]) {
        lampParts.push(part(new THREE.SphereGeometry(0.09, 10, 8), 0xfff6d8, { s: [1.3, 0.8, 0.6], x: s * 0.3, y: 0.31, z: 1.86 }));
        lamps.push(new THREE.Vector3(s * 0.3, 0.31, 1.96));
        lampParts.push(part(new THREE.BoxGeometry(0.26, 0.07, 0.03), 0xff2b3d, { x: s * 0.27, y: 0.3, z: -2.05 }));
    }
    body.add(mesh(merged(lampParts), mats.lamp, false));

    // Steering wheel (turns with the input).
    const wheelPivot = new THREE.Group();
    wheelPivot.position.set(0, 0.62, 0.12);
    wheelPivot.rotation.x = -0.9;
    const steeringWheel = new THREE.Group();
    steeringWheel.add(mesh(merged([
        part(new THREE.TorusGeometry(0.16, 0.025, 6, 18), DARK),
        part(new THREE.BoxGeometry(0.3, 0.03, 0.03), DARK),
    ]), mats.trim, false));
    wheelPivot.add(steeringWheel);
    body.add(wheelPivot);

    // Penguin driver.
    const driver = new THREE.Group();
    driver.name = 'driver';
    driver.position.set(0, 0.06, -0.45);
    const sph = (sx, sy, sz, o, c, w = 14, h = 10) => part(new THREE.SphereGeometry(1, w, h), c, { s: [sx, sy, sz], ...o });
    const dparts = [
        sph(0.34, 0.46, 0.31, { y: 0.42 }, BLACK),
        sph(0.26, 0.36, 0.16, { y: 0.4, z: 0.17 }, WHITE),
        sph(0.25, 0.24, 0.25, { y: 0.92, z: 0.02 }, BLACK),
        sph(0.17, 0.15, 0.08, { y: 0.88, z: 0.21 }, WHITE),
        part(new THREE.ConeGeometry(0.07, 0.24, 8), ORANGE, { rx: Math.PI / 2, y: 0.86, z: 0.34 }),
        part(new THREE.TorusGeometry(0.245, 0.025, 6, 20), 0x22314d, { rx: Math.PI / 2, y: 0.98, z: 0.02 }),
        part(new THREE.TorusGeometry(0.2, 0.06, 8, 18), 0xe02a3a, { rx: Math.PI / 2, y: 0.74 }),
        sph(0.07, 0.07, 0.07, { y: 1.25, z: 0.0 }, WHITE, 8, 6),
    ];
    for (const s of [-1, 1]) {
        dparts.push(part(new THREE.CylinderGeometry(0.075, 0.075, 0.05, 14), 0x46b4ff, { rx: Math.PI / 2, x: s * 0.095, y: 0.98, z: 0.24 }));
        // Flippers reach for the steering wheel.
        const f = sph(0.07, 0.26, 0.11, { y: -0.2 }, BLACK, 8, 6);
        f.rotateX(-1.1);
        f.rotateZ(s * 0.35);
        f.translate(s * 0.3, 0.62, 0.06);
        dparts.push(f);
    }
    driver.add(mesh(merged(dparts), mats.trim));
    const beanie = part(new THREE.SphereGeometry(0.2, 12, 8), null, { s: [1.1, 0.7, 1.1], y: 1.08, z: 0.0 });
    driver.add(mesh(beanie, mats.paint));
    const scarf = scarfRibbon(mats.scarf);
    driver.add(scarf.mesh);
    body.add(driver);

    const wheels = [];
    for (let i = 0; i < 4; i++) {
        const left = i % 2 === 0;
        const w = buildWheel(mats, left, { front: i < 2 });
        w.steer.position.set(left ? WHEEL_X : -WHEEL_X, -0.27, i < 2 ? WHEEL_Z : -WHEEL_Z);
        root.add(w.steer);
        wheels.push(w);
    }

    // Glows: headlights (night) and the exhaust (boost).
    const glowMat = (c) => new THREE.SpriteMaterial({
        map: glowTexture(), color: c, transparent: true, blending: THREE.AdditiveBlending,
        depthWrite: false, toneMapped: false, opacity: 0,
    });
    const hgMat = glowMat(0xfff1c8);
    for (const p of lamps) {
        const s = new THREE.Sprite(hgMat);
        s.position.copy(p);
        s.scale.setScalar(0.9);
        body.add(s);
    }
    const exMat = glowMat(0x5fe3ff);
    const exhaustGlow = [];
    for (const s of [-1, 1]) {
        const e = new THREE.Sprite(exMat);
        e.position.set(s * 0.22, 0.12, -2.3);
        e.scale.setScalar(0.9);
        body.add(e);
        exhaustGlow.push(e);
    }

    if (ghost) {
        const gm = new THREE.MeshStandardMaterial({
            color: 0xcfeaff, emissive: new THREE.Color(0x6fc4ff), emissiveIntensity: 0.6, roughness: 0.4,
            transparent: true, opacity: 0.38, depthWrite: false,
        });
        root.traverse((o) => {
            if (o.isMesh) {
                o.material = gm;
                o.castShadow = false;
                o.renderOrder = 3;
            }
        });
        mats.ghost = gm;
    }

    let headK = 0, cockpit = false, label = null;
    let time = 0;
    const model = {
        root, kind, mats, driver, wheels,
        update(view, dt) {
            time += dt;
            if (!view) return;
            const W = view.wheels;
            if (W) {
                for (let i = 0; i < 4; i++) {
                    const w = W[i], m = wheels[i];
                    if (!w) continue;
                    const c = Math.max(0, Math.min(TRAVEL + 0.05, w.compression || 0));
                    m.steer.position.y = -TRAVEL + c;
                    m.steer.rotation.y = -(w.steer || 0);
                    m.spin.rotation.x = w.spin || 0;
                }
            }
            const steer = view.steer ?? (W ? (W[0].steer + W[1].steer) * 1.5 : 0);
            steeringWheel.rotation.z = -steer * 1.6;
            const kmh = view.speedKmh || 0;
            const s = Math.min(1, kmh / 160);
            if (!cockpit && driver.visible) scarf.update(time, s);
            // The driver leans into corners a little.
            driver.rotation.z = steer * 0.1;
            const fx = view.effects || {};
            const boost = fx.turbo ? Math.min(1, (fx.turboTime ?? 1) / 2 + 0.3) : 0;
            exMat.color.setHex(fx.turbo === 2 ? 0xff3f8a : 0x5fe3ff);
            const flick = 0.85 + 0.15 * Math.sin(time * 60);
            exMat.opacity = Math.max(boost * flick * 0.85, headK * 0.25 * (0.6 + 0.4 * (view.rpm || 0)));
            for (const e of exhaustGlow) e.scale.setScalar(0.5 + boost * 0.8 * flick);
        },
        setColor(c) {
            mats.paint.color.set(c);
            mats.paintSide.color.set(c);
        },
        setHeadlights(k) {
            headK = k;
            hgMat.opacity = k * 0.7;
        },
        setCockpit(on) {
            cockpit = on;
            driver.visible = !on;
        },
        setLabel(text, texture) {
            if (label) {
                root.remove(label);
                label.material.map?.dispose();
                label.material.dispose();
                label = null;
            }
            if (!text || !texture) return;
            label = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false }));
            label.position.set(0, 2.4, 0);
            label.scale.set(3.2, 0.8, 1);
            label.renderOrder = 10;
            root.add(label);
        },
        dispose() {
            root.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
            for (const m of Object.values(mats)) m.dispose();
            hgMat.dispose();
            exMat.dispose();
            if (label) {
                label.material.map?.dispose();
                label.material.dispose();
            }
        },
    };
    return model;
}
