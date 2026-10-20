// Everything around the road: snowy terrain beyond the map, a ring of
// mountains, instanced pines / rocks / crystals / igloos / snowmen, wobbling
// penguin crowds, lamps (glowing at night), gates, pillars, pad icons and the
// track's own decor. Placement comes from layout.js (seeded by the track hash).
import * as THREE from 'three';
import { planScenery, terrainHeight } from './layout.js';
import {
    pineGeometry, rockGeometry, crystalGeometry, iglooGeometry, snowmanGeometry, penguinGeometry,
    lampGeometry, LAMP_BULB_Y, mountainGeometry, merge,
} from './models.js';
import { buildGate, buildPillars, buildPadIcons, buildBannerDecor, bannerMaterialFactory, LIGHT_OFF } from './props.js';
import { groundTexture, glowTexture } from './textures.js';
import { CELL, MAP_X, MAP_Z, DIRS } from '../core/constants.js';

const MAP_W = MAP_X * CELL, MAP_D = MAP_Z * CELL;
const CHUNK = 384;
const DENSITY = { low: 0.45, medium: 0.8, high: 1 };

// Geometries are shared by every Scenery (built once per page).
let GEO = null;
function geometries() {
    if (!GEO) {
        GEO = {
            pine: pineGeometry(), rock: rockGeometry(), crystal: crystalGeometry(), igloo: iglooGeometry(),
            snowman: snowmanGeometry(), penguin: penguinGeometry(), lamp: lampGeometry(),
            bulb: new THREE.SphereGeometry(0.34, 10, 8),
        };
    }
    return GEO;
}

const DECOR_MAP = {
    Pine: 'pine', PineCluster: 'cluster', Igloo: 'igloo', Snowman: 'snowman', IceCrystal: 'crystal',
    Crystal: 'crystal', Rock: 'rock', PenguinCrowd: 'crowd', Penguin: 'penguin', Banner: 'banner', Lamp: 'lamp',
};

function hashF(x, z, k = 0) {
    let h = Math.imul((x * 73.1) | 0, 374761393) ^ Math.imul((z * 91.7) | 0, 668265263) ^ Math.imul(k + 1, 2246822519);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Ground beyond the map: a grid with the map square cut out, rising into hills. */
function terrainGeometry() {
    const out = [0];
    for (let d = 40; d < 4600; d *= 1.32) out.push(Math.round(d));
    const neg = out.slice(1).map((d) => -d).reverse();
    const xs = [...neg, 0, MAP_W, ...out.slice(1).map((d) => MAP_W + d)];
    const zs = [...neg, 0, MAP_D, ...out.slice(1).map((d) => MAP_D + d)];
    const pos = [], uv = [], idx = [];
    const vid = new Map();
    const vert = (i, j) => {
        const k = i * 1000 + j;
        if (vid.has(k)) return vid.get(k);
        const x = xs[i], z = zs[j];
        pos.push(x, terrainHeight(x, z), z);
        uv.push(x, z);
        vid.set(k, pos.length / 3 - 1);
        return pos.length / 3 - 1;
    };
    for (let i = 0; i + 1 < xs.length; i++) {
        for (let j = 0; j + 1 < zs.length; j++) {
            if (xs[i] >= 0 && xs[i + 1] <= MAP_W && zs[j] >= 0 && zs[j + 1] <= MAP_D) continue;
            const a = vert(i, j), b = vert(i + 1, j), c = vert(i + 1, j + 1), d = vert(i, j + 1);
            idx.push(a, c, b, a, d, c);
        }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
}

export class Scenery {
    constructor(renderer, world, quality, opts = {}) {
        this.renderer = renderer;
        this.world = world;
        this.quality = quality;
        this.group = new THREE.Group();
        this.group.name = 'scenery';
        this.materials = [];
        this.disposables = [];
        this.lampSets = [];
        this.time = 0;
        this.gates = [];
        this.countdown = null;
        const shadows = quality !== 'low';
        const env = renderer.env.envMap;
        const decorCount = (world.track?.decor || []).length;
        // Hand-dressed tracks (official levels) get a lighter automatic scatter.
        const density = DENSITY[quality] * (decorCount > 25 ? 0.45 : 1);
        const plan = this.plan = planScenery(world, { density });
        if (opts.auto === false) {
            plan.items = [];
            plan.crowds = [];
            plan.lamps = [];
        }

        const mat = (o) => {
            const m = new THREE.MeshStandardMaterial(o);
            this.materials.push(m);
            return m;
        };
        this.mats = {
            solid: mat({ vertexColors: true, roughness: 0.82, flatShading: true, envMap: env, envMapIntensity: 0.25 }),
            crystal: mat({
                vertexColors: true, roughness: 0.1, metalness: 0.1, flatShading: true, envMap: env, envMapIntensity: 1.3,
                emissive: new THREE.Color(0x2a8fd0), emissiveIntensity: 0.35,
            }),
            mountain: mat({ vertexColors: true, roughness: 1, flatShading: true }),
            terrain: mat({ map: this._groundMap(), roughness: 0.95 }),
            cpIce: mat({
                color: 0x9debff, emissive: new THREE.Color(0x35c6ff), emissiveIntensity: 0.9, roughness: 0.1,
                transparent: true, opacity: 0.88, envMap: env, envMapIntensity: 1.2,
            }),
        };
        this.mats.cpGlow = new THREE.MeshBasicMaterial({
            color: 0x52d6ff, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
        });
        this.mats.bulb = new THREE.MeshBasicMaterial({ color: 0xffe3a6, toneMapped: false });
        this.mats.lights = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
        this.mats.banner = bannerMaterialFactory();
        this.disposables.push(this.mats.cpGlow, this.mats.bulb, this.mats.lights);

        // Terrain and mountains.
        const terrain = new THREE.Mesh(terrainGeometry(), this.mats.terrain);
        terrain.name = 'terrain';
        terrain.receiveShadow = shadows;
        this.group.add(terrain);
        this.disposables.push(terrain.geometry);
        const mts = merge(plan.mountains.map((m) => {
            const g = mountainGeometry(m.radius, m.height, m.seed);
            g.translate(m.x, terrainHeight(m.x, m.z) - 10, m.z);
            return g;
        }));
        const mtMesh = new THREE.Mesh(mts, this.mats.mountain);
        mtMesh.name = 'mountains';
        this.group.add(mtMesh);
        this.disposables.push(mts);

        // Instanced scenery: auto plan plus the track's decor.
        const items = plan.items.slice();
        const crowd = plan.crowds.slice();
        const decorLamps = [];
        const banners = [];
        for (const p of world.render.props) {
            if (p.kind !== 'decor') continue;
            const kind = DECOR_MAP[p.decor] || 'pine';
            const [x, y, z] = p.pos;
            const yaw = -(p.dir || 0) * Math.PI / 2;
            const h = (k) => hashF(x, z, k);
            if (kind === 'cluster') {
                for (let k = 0; k < 5; k++) items.push({ kind: 'pine', x: x + (h(k) - 0.5) * 22, y, z: z + (h(k + 9) - 0.5) * 22, rot: h(k + 3) * 6.28, scale: 0.8 + h(k + 5) * 0.5, tint: h(k + 7) });
            } else if (kind === 'crowd') {
                // Rows of penguins on the road side of the cell, facing DIRS[r].
                const f = DIRS[p.dir || 0], r = [-f[2], 0, f[0]];
                for (let row = 0; row < 3; row++) {
                    for (let k = 0; k < 7; k++) {
                        const lat = (k - 3) * 2.4 + (h(row * 10 + k) - 0.5) * 0.8;
                        const fw = 9 - row * 2.3 + (h(row * 10 + k + 50) - 0.5) * 0.6;
                        crowd.push({ x: x + f[0] * fw + r[0] * lat, y, z: z + f[2] * fw + r[2] * lat, rot: Math.atan2(f[0], f[2]) + (h(k + row) - 0.5) * 0.6, scale: 0.95 + h(k * 3 + row) * 0.3, phase: h(k + 77) * 6.28 });
                    }
                }
            } else if (kind === 'penguin') {
                crowd.push({ x, y, z, rot: Math.atan2(DIRS[p.dir || 0][0], DIRS[p.dir || 0][2]), scale: 1.1, phase: h(1) * 6.28 });
            } else if (kind === 'banner') {
                banners.push(p);
            } else if (kind === 'lamp') {
                decorLamps.push({ x, y, z });
            } else {
                items.push({ kind, x: x + (h(1) - 0.5) * 6, y, z: z + (h(2) - 0.5) * 6, rot: yaw + (h(3) - 0.5) * 0.8, scale: kind === 'pine' ? 0.9 + h(4) * 0.4 : 1 + h(4) * 0.3, tint: h(5) });
            }
        }
        this._instances(items, shadows);
        // Low quality thins the crowds out.
        this._crowd(quality === 'low' ? crowd.filter((c, i) => i % 2 === 0) : crowd, shadows);
        this._lampSet(decorLamps, shadows, false);
        this._lampSet(plan.lamps, shadows, true);
        for (const b of banners) this.group.add(buildBannerDecor(b, this.mats, shadows));

        // Gates, pillars, pad icons.
        for (const p of world.render.props) {
            if (p.kind !== 'gate') continue;
            const g = buildGate(p, this.mats, shadows);
            this.group.add(g.group);
            this.gates.push(g);
        }
        const pil = buildPillars(world.render.props, this.mats.solid, shadows);
        if (pil) {
            this.group.add(pil);
            this.disposables.push(pil.geometry);
        }
        this.icons = buildPadIcons(world.render.props);
        if (this.icons) {
            this.group.add(this.icons.points);
            this.disposables.push(this.icons.points.geometry, this.icons.points.material);
        }
        this.setCountdown(null);
    }

    _groundMap() {
        const t = groundTexture().clone();
        t.repeat.set(1 / 128, 1 / 128);
        t.needsUpdate = true;
        this.disposables.push(t);
        return t;
    }

    _instances(items, shadows) {
        const G = geometries();
        const byKey = new Map();
        for (const it of items) {
            const inside = it.x >= -64 && it.z >= -64 && it.x <= MAP_W + 64 && it.z <= MAP_D + 64;
            const key = `${it.kind}:${Math.floor(it.x / CHUNK)}:${Math.floor(it.z / CHUNK)}:${inside ? 1 : 0}`;
            if (!byKey.has(key)) byKey.set(key, []);
            byKey.get(key).push(it);
        }
        const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3();
        const col = new THREE.Color();
        const UP = new THREE.Vector3(0, 1, 0);
        for (const [key, list] of byKey) {
            const [kind, , , inside] = key.split(':');
            const geo = G[kind] || G.pine;
            const material = kind === 'crystal' ? this.mats.crystal : this.mats.solid;
            const im = new THREE.InstancedMesh(geo, material, list.length);
            im.name = 'scenery:' + kind;
            list.forEach((it, i) => {
                p.set(it.x, it.y, it.z);
                q.setFromAxisAngle(UP, it.rot);
                s.setScalar(it.scale);
                if (kind === 'rock') s.set(it.scale * (0.8 + it.tint * 0.6), it.scale * (0.7 + (1 - it.tint) * 0.5), it.scale);
                m4.compose(p, q, s);
                im.setMatrixAt(i, m4);
                const k = kind === 'pine' ? 0.86 + it.tint * 0.22 : 0.94 + it.tint * 0.1;
                im.setColorAt(i, col.setRGB(k, k, k));
            });
            im.instanceMatrix.needsUpdate = true;
            if (im.instanceColor) im.instanceColor.needsUpdate = true;
            im.computeBoundingSphere();
            im.castShadow = shadows && inside === '1';
            im.receiveShadow = shadows && kind !== 'crystal';
            this.group.add(im);
            this.disposables.push(im);
        }
    }

    _crowd(list, shadows) {
        this.crowdList = list;
        if (!list.length) return;
        const im = new THREE.InstancedMesh(geometries().penguin, this.mats.solid, list.length);
        im.name = 'scenery:penguins';
        im.castShadow = shadows;
        im.receiveShadow = shadows;
        im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.crowd = im;
        this.group.add(im);
        this.disposables.push(im);
        this._poseCrowd(0);
        im.computeBoundingSphere();
        im.boundingSphere.radius += 2;     // room for hops
    }

    _poseCrowd(t) {
        const im = this.crowd;
        if (!im) return;
        const m4 = this._m4 || (this._m4 = new THREE.Matrix4());
        const e = this._e || (this._e = new THREE.Euler(0, 0, 0, 'YXZ'));
        const q = this._q || (this._q = new THREE.Quaternion());
        const p = this._p || (this._p = new THREE.Vector3());
        const s = this._s || (this._s = new THREE.Vector3());
        const calm = this.renderer.reducedMotion;
        const list = this.crowdList;
        for (let i = 0; i < list.length; i++) {
            const c = list[i];
            const ph = c.phase || 0;
            // A waddle for everyone, hops for the most excited fans.
            const hop = calm ? 0 : Math.max(0, Math.sin(t * 7 + ph * 3)) * (ph > 4.2 ? 0.3 : 0);
            e.set(0, c.rot + (calm ? 0 : Math.sin(t * 1.3 + ph) * 0.15), calm ? 0 : Math.sin(t * 4 + ph) * 0.09);
            q.setFromEuler(e);
            p.set(c.x, c.y + hop, c.z);
            s.setScalar(c.scale);
            m4.compose(p, q, s);
            im.setMatrixAt(i, m4);
        }
        im.instanceMatrix.needsUpdate = true;
    }

    /** Posts, bulbs, glow halos and warm light pools for a list of lamps. */
    _lampSet(list, shadows, auto) {
        if (!list.length) return;
        const G = geometries();
        const group = new THREE.Group();
        group.name = auto ? 'lamps:auto' : 'lamps:decor';
        const posts = new THREE.InstancedMesh(G.lamp, this.mats.solid, list.length);
        const bulbs = new THREE.InstancedMesh(G.bulb, this.mats.bulb, list.length);
        const m4 = new THREE.Matrix4();
        const glowPos = [], poolPos = [], poolUv = [], poolIdx = [];
        list.forEach((l, i) => {
            m4.makeTranslation(l.x, l.y, l.z);
            posts.setMatrixAt(i, m4);
            m4.makeTranslation(l.x, l.y + LAMP_BULB_Y, l.z);
            bulbs.setMatrixAt(i, m4);
            glowPos.push(l.x, l.y + LAMP_BULB_Y, l.z);
            const c = l.road || [l.x, l.y, l.z];
            const r = l.road ? 13 : 15, y = c[1] + 0.07, b = poolPos.length / 3;
            poolPos.push(c[0] - r, y, c[2] - r, c[0] + r, y, c[2] - r, c[0] + r, y, c[2] + r, c[0] - r, y, c[2] + r);
            poolUv.push(0, 0, 1, 0, 1, 1, 0, 1);
            poolIdx.push(b, b + 2, b + 1, b, b + 3, b + 2);
        });
        posts.castShadow = shadows;
        posts.computeBoundingSphere();
        bulbs.computeBoundingSphere();
        const gg = new THREE.BufferGeometry();
        gg.setAttribute('position', new THREE.Float32BufferAttribute(glowPos, 3));
        const glowMat = new THREE.PointsMaterial({
            map: glowTexture(), color: 0xffd38a, size: 9, sizeAttenuation: true, transparent: true,
            blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
        });
        const glow = new THREE.Points(gg, glowMat);
        const pg = new THREE.BufferGeometry();
        pg.setAttribute('position', new THREE.Float32BufferAttribute(poolPos, 3));
        pg.setAttribute('uv', new THREE.Float32BufferAttribute(poolUv, 2));
        pg.setIndex(poolIdx);
        const poolMat = new THREE.MeshBasicMaterial({
            map: glowTexture(), color: 0xffc77a, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending,
            depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6,
        });
        const pool = new THREE.Mesh(pg, poolMat);
        pool.renderOrder = 1;
        group.add(posts, bulbs, glow, pool);
        this.group.add(group);
        this.disposables.push(posts, bulbs, gg, pg, glowMat, poolMat);
        this.lampSets.push({ group, auto, glow, pool, glowMat, poolMat });
    }

    setMood(mood, preset) {
        const k = preset.lamps;
        for (const s of this.lampSets) {
            // Automatic lamps line the road only at night; decor lamps always stand.
            s.group.visible = !s.auto || k > 0.5;
            s.glow.visible = s.pool.visible = k > 0.05;
            s.glowMat.opacity = Math.min(1, k);
            s.poolMat.opacity = 0.42 * k;
        }
        this.mats.bulb.color.setHex(k > 0.05 ? 0xffe3a6 : 0xcfd8e6);
        const night = mood === 'night' || mood === 'aurora';
        this.night = night;
        this.mats.crystal.emissiveIntensity = night ? 0.8 : 0.35;
        this.mats.cpGlow.opacity = night ? 0.4 : 0.22;
        for (const m of this.mats.banner.all()) m.emissiveIntensity = night ? 0.55 : 0.15;
    }

    /** 3, 2, 1: red lights fill up; 0: all green (GO); null: idle green. */
    setCountdown(n) {
        this.countdown = n;
        const lit = n >= 3 ? 2 : n === 2 ? 4 : 5;
        const hexes = [0, 1, 2, 3, 4].map((i) => (n == null || n <= 0 ? (n === 0 ? 0x41ff8a : 0x2fd27a) : i < lit ? 0xff3b4f : LIGHT_OFF));
        for (const g of this.gates) if (g.setLights) g.setLights(hexes);
    }

    /** Per-camera setup before a draw (point sizes in world units). */
    beforeRender(camera, heightPx) {
        if (this.icons) this.icons.uniforms.uScale.value = heightPx / (2 * Math.tan((camera.fov * Math.PI) / 360));
    }

    update(dt) {
        this.time += dt;
        const t = this.time;
        if (this.crowd) this._poseCrowd(t);
        if (this.icons) this.icons.uniforms.uTime.value = t;
        // Checkpoint arches shimmer.
        this.mats.cpIce.emissiveIntensity = (this.night ? 1.3 : 0.85) + 0.3 * Math.sin(t * 3);
    }

    dispose() {
        const shared = new Set(Object.values(GEO || {}));
        this.group.traverse((o) => {
            if ((o.isMesh || o.isPoints) && !o.isInstancedMesh && o.geometry && !shared.has(o.geometry)) o.geometry.dispose();
            if (o.isSprite) o.material.dispose();
        });
        for (const d of this.disposables) d.dispose?.();
        for (const m of this.materials) m.dispose();
        for (const m of this.mats.banner.all()) m.dispose();
        for (const g of this.gates) g.dispose?.();
    }
}
