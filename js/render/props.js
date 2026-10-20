// Track props drawn as models: gates (start igloo arch with countdown lights,
// checkered finish, glowing checkpoint arch, lap igloo), pillars, floating pad
// icons and banners. Gate local frame: origin on the deck centre at the line,
// +Z along the road, X across (the arch spans ±14 m). Each gate merges its
// parts per material, so a gate costs a handful of draws.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/BufferGeometryUtils.js';
import { paint, place, merge, crystalGeometry } from './models.js';
import { bannerTexture, iconAtlasTexture, ICON_ORDER } from './textures.js';

const ICE_BLOCKS = [0xffffff, 0xe3effb, 0xd2e5f6, 0xeef6fd];
const LIGHT_OFF = 0x3a1620;

/** Semi-elliptical arch of ice blocks (igloo style), pushed into `parts`. */
function iglooArch(parts, a = 13.5, b = 9.8, depth = 2.6, thick = 1.7, n = 19) {
    for (let i = 0; i < n; i++) {
        const t0 = (i / n) * Math.PI, t1 = ((i + 1) / n) * Math.PI;
        const tm = (t0 + t1) / 2;
        const x0 = a * Math.cos(t0), y0 = b * Math.sin(t0), x1 = a * Math.cos(t1), y1 = b * Math.sin(t1);
        const len = Math.hypot(x1 - x0, y1 - y0) * 0.96;
        const g = new THREE.BoxGeometry(len, thick, depth);
        place(g, { rz: Math.atan2(y1 - y0, x1 - x0), x: a * Math.cos(tm), y: b * Math.sin(tm) });
        parts.push(paint(g, ICE_BLOCKS[i % ICE_BLOCKS.length]));
    }
    // Footing blocks so the arch sits on the snowbanks.
    for (const s of [-1, 1]) parts.push(paint(place(new THREE.BoxGeometry(2.6, 1.6, 3.2), { x: s * a, y: 0.6 }), 0xd8e8f7));
}

/** Two back-to-back planes (front faces the oncoming car at -Z), as one geometry with uvs. */
function bannerPlanes(list, w, h, y, z) {
    for (const s of [-1, 1]) {
        const p = new THREE.PlaneGeometry(w, h);
        if (s < 0) p.rotateY(Math.PI);
        p.translate(0, y, s * z);
        list.push(p);
    }
}

function mergedMesh(list, mat, shadows) {
    const g = mergeGeometries(list, false);
    for (const p of list) p.dispose();
    const m = new THREE.Mesh(g, mat);
    m.castShadow = shadows;
    m.receiveShadow = shadows;
    return m;
}

/** Five round lamps on a dark panel (both faces): one geometry, colours per vertex. */
function countdownLights(solid, y, z) {
    solid.push(paint(place(new THREE.BoxGeometry(8.6, 1.5, 0.5), { y }), 0x10213d));
    for (const s of [-1, 1]) solid.push(paint(place(new THREE.BoxGeometry(0.16, 2.2, 0.16), { x: s * 3.6, y: y + 1.6 }), 0x10213d));
    const discs = [];
    const ranges = [];
    let v = 0;
    for (let i = 0; i < 5; i++) {
        const start = v;
        for (const s of [-1, 1]) {
            const d = new THREE.CircleGeometry(0.5, 14);
            if (s < 0) d.rotateY(Math.PI);
            d.translate((i - 2) * 1.65, y, s * (z + 0.02));
            const g = paint(d, 0x41ff8a);
            v += g.getAttribute('position').count;
            discs.push(g);
        }
        ranges.push([start, v]);
    }
    return { geometry: merge(discs), ranges };
}

/** Builds one gate model. Returns { group, setLights?(hexes) , kind }. */
export function buildGate(prop, mats, shadows) {
    const group = new THREE.Group();
    group.name = 'gate:' + prop.gate;
    group.position.set(prop.pos[0], prop.pos[1], prop.pos[2]);
    group.rotation.y = -prop.dir * Math.PI / 2;
    const out = { group, kind: prop.gate, setLights: null };
    const solid = [], banners = [];
    let bannerKind = 'start';
    if (prop.gate === 'start' || prop.gate === 'startfinish') {
        iglooArch(solid);
        bannerKind = prop.gate === 'start' ? 'start' : 'lap';
        bannerPlanes(banners, 15.5, 2.5, 7.75, 1.34);
        // Snowy crown on the keystone.
        solid.push(paint(place(new THREE.SphereGeometry(1.4, 10, 5, 0, Math.PI * 2, 0, Math.PI / 2), { s: [1.6, 0.7, 1.1], y: 10.6 }), 0xffffff));
        const lights = countdownLights(solid, 5.55, 0.27);
        const lm = new THREE.Mesh(lights.geometry, mats.lights);
        group.add(lm);
        const col = lights.geometry.getAttribute('color');
        const c = new THREE.Color();
        out.setLights = (hexes) => {
            lights.ranges.forEach(([a, b], i) => {
                c.setHex(hexes[i]);
                for (let k = a; k < b; k++) col.setXYZ(k, c.r, c.g, c.b);
            });
            col.needsUpdate = true;
        };
        out.dispose = () => lights.geometry.dispose();
    } else if (prop.gate === 'finish') {
        bannerKind = 'finish';
        for (const s of [-1, 1]) {
            for (let k = 0; k < 4; k++) solid.push(paint(place(new THREE.BoxGeometry(2.2 - (k % 2) * 0.2, 2.35, 2.8 - (k % 2) * 0.2), { x: s * 13.4, y: 1.18 + k * 2.35 }), ICE_BLOCKS[(k + (s > 0 ? 1 : 0)) % 4]));
            solid.push(paint(place(new THREE.SphereGeometry(1.5, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2), { s: [1, 0.55, 1.15], x: s * 13.4, y: 11.6 }), 0xffffff));
            solid.push(paint(place(new THREE.CylinderGeometry(0.07, 0.07, 2.6, 5), { x: s * 13.4, y: 12.9 }), 0x27324d));
            // Pennant flags on top of the posts.
            const flag = new THREE.PlaneGeometry(1.8, 1.1);
            flag.rotateY(Math.PI / 2);
            flag.translate(s * 14.35, 13.3, 0);
            banners.push(flag);
            const back = new THREE.PlaneGeometry(1.8, 1.1);
            back.rotateY(-Math.PI / 2);
            back.translate(s * 14.35, 13.3, 0);
            banners.push(back);
        }
        solid.push(paint(new THREE.BoxGeometry(29.2, 2.4, 2.4).translate(0, 9.9, 0), 0x10213d));
        bannerPlanes(banners, 28.4, 2.2, 9.9, 1.22);
    } else {
        // Checkpoint: a glowing ice arch with a snowflake banner.
        bannerKind = 'checkpoint';
        const arch = new THREE.TorusGeometry(13.5, 0.6, 8, 36, Math.PI);
        arch.scale(1, 0.74, 1);
        group.add(new THREE.Mesh(arch, mats.cpIce));
        const halo = new THREE.TorusGeometry(13.5, 1.5, 6, 36, Math.PI);
        halo.scale(1, 0.74, 1.1);
        const h = new THREE.Mesh(halo, mats.cpGlow);
        h.renderOrder = 4;
        group.add(h);
        const crystals = [-1, 1].map((s) => place(crystalGeometry(), { s: 0.8, x: s * 13.5 }));
        const cm = new THREE.Mesh(merge(crystals), mats.crystal);
        cm.castShadow = shadows;
        group.add(cm);
        bannerPlanes(banners, 9.5, 1.5, 8.6, 0.06);
        solid.push(paint(place(new THREE.BoxGeometry(9.7, 1.6, 0.1), { y: 8.6 }), 0x0a2a4d));
        for (const s of [-1, 1]) solid.push(paint(place(new THREE.BoxGeometry(0.1, 0.9, 0.1), { x: s * 3.5, y: 9.65 }), 0x9fe6ff));
    }
    group.add(mergedMesh(solid, mats.solid, shadows));
    group.add(mergedMesh(banners, mats.banner(bannerKind), false));
    return out;
}

/** Every pillar as stacked ice and stone blocks, merged into one mesh. */
export function buildPillars(props, mat, shadows) {
    const parts = [];
    for (const p of props) {
        if (p.kind !== 'pillar' || p.height <= 0.2) continue;
        const n = Math.max(1, Math.round(p.height / 2.7));
        const h = p.height / n;
        for (let k = 0; k < n; k++) {
            const w = p.size + (k % 2 ? 0.25 : 0.5);
            const g = new THREE.BoxGeometry(w, h * 0.98, w);
            g.translate(p.pos[0], p.pos[1] + h * (k + 0.5), p.pos[2]);
            parts.push(paint(g, k % 2 ? 0xb4d6ef : 0x8d9bb2));
        }
        // A snow drift at the foot.
        const d = new THREE.SphereGeometry(p.size * 1.4, 8, 3, 0, Math.PI * 2, 0, Math.PI / 2);
        d.scale(1, 0.4, 1);
        d.translate(p.pos[0], p.pos[1], p.pos[2]);
        parts.push(paint(d, 0xf4f8fd));
    }
    if (!parts.length) return null;
    const m = new THREE.Mesh(merge(parts), mat);
    m.name = 'pillars';
    m.castShadow = shadows;
    m.receiveShadow = shadows;
    return m;
}

const ICON_VERT = /* glsl */`
attribute float icon;
attribute float phase;
uniform float uTime, uScale;
varying float vIcon;
varying float vFade;
void main() {
    vIcon = icon;
    vec3 p = position;
    p.y += sin(uTime * 2.2 + phase) * 0.35;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    float d = -mv.z;
    // Fade out as the car drives under an icon instead of filling the screen.
    vFade = smoothstep(6.0, 16.0, d);
    gl_PointSize = min(4.4 * uScale / max(0.5, d), 180.0);
    gl_Position = projectionMatrix * mv;
}`;

const ICON_FRAG = /* glsl */`
uniform sampler2D uMap;
varying float vIcon;
varying float vFade;
void main() {
    if (vFade < 0.01) discard;
    float col = mod(vIcon, 3.0), row = floor(vIcon / 3.0);
    vec2 uv = vec2((col + gl_PointCoord.x) / 3.0, 1.0 - (row + gl_PointCoord.y) / 3.0);
    vec4 t = texture2D(uMap, uv);
    t.a *= vFade;
    if (t.a < 0.02) discard;
    gl_FragColor = t;
    #include <colorspace_fragment>
}`;

/** Floating icons over special pads: one Points draw with an icon atlas. */
export function buildPadIcons(props) {
    const pos = [], icon = [], phase = [];
    for (const p of props) {
        if (p.kind !== 'pad') continue;
        pos.push(p.pos[0], p.pos[1] + 5.2, p.pos[2]);
        icon.push(Math.max(0, ICON_ORDER.indexOf(p.effect)));
        phase.push((p.pos[0] * 0.13 + p.pos[2] * 0.07) % 6.28);
    }
    if (!icon.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('icon', new THREE.Float32BufferAttribute(icon, 1));
    g.setAttribute('phase', new THREE.Float32BufferAttribute(phase, 1));
    g.computeBoundingSphere();
    g.boundingSphere.radius += 3;
    const uniforms = { uMap: { value: iconAtlasTexture() }, uTime: { value: 0 }, uScale: { value: 600 } };
    const mat = new THREE.ShaderMaterial({ uniforms, vertexShader: ICON_VERT, fragmentShader: ICON_FRAG, transparent: true, depthWrite: false });
    const pts = new THREE.Points(g, mat);
    pts.name = 'pad-icons';
    pts.renderOrder = 5;
    return { points: pts, uniforms };
}

/** Banner decor: two poles and a cloth banner facing DIRS[r] (toward the road). */
export function buildBannerDecor(prop, mats, shadows) {
    const g = new THREE.Group();
    g.position.set(prop.pos[0], prop.pos[1], prop.pos[2]);
    g.rotation.y = -((prop.dir || 0) + 2) * Math.PI / 2;
    g.add(mergedMesh([-6.3, 6.3].map((x) => paint(place(new THREE.CylinderGeometry(0.14, 0.18, 7.5, 6), { x, y: 3.75 }), 0x27324d)), mats.solid, shadows));
    const planes = [];
    bannerPlanes(planes, 12.4, 2.6, 5.6, 0.02);
    g.add(mergedMesh(planes, mats.banner('start'), false));
    return g;
}

export function bannerMaterialFactory() {
    const cache = new Map();
    const fn = (kind) => {
        if (!cache.has(kind)) {
            cache.set(kind, new THREE.MeshStandardMaterial({
                map: bannerTexture(kind), roughness: 0.7,
                emissive: new THREE.Color(0xffffff), emissiveMap: bannerTexture(kind), emissiveIntensity: 0.15,
            }));
        }
        return cache.get(kind);
    };
    fn.all = () => [...cache.values()];
    return fn;
}

export { LIGHT_OFF };
