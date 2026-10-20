// Visual effects: falling snow around the camera, wheel snow spray and ice
// sparkle, skid ribbons, boost trails, landing puffs, wall-hit ice shards,
// checkpoint pulse rings, the respawn flash, finish confetti-snow and the
// player's headlights. Particles are CPU-simulated into two pooled Points
// buffers (soft and additive); randomness is seeded so frames are repeatable.
import * as THREE from 'three';
import { flakeTexture, skidTexture, EFFECT_COLORS, rngOf } from './textures.js';

const QUALITY = {
    low: { snow: 1200, particles: 900, skids: 500, spray: 0.45 },
    medium: { snow: 3000, particles: 2200, skids: 1200, spray: 0.8 },
    high: { snow: 6000, particles: 3600, skids: 2000, spray: 1 },
};
const SNOW_BOX = 90;
const SPRAY_TINTS = { powder: [1, 0.96, 0.9], ground: [0.95, 0.97, 1], other: [0.9, 0.94, 1] };
const GLINT = [0.85, 0.95, 1], BOOST_FROST = [0.4, 0.9, 1], BOOST_AVALANCHE = [1, 0.3, 0.6];
const SKID_COLORS = { snow: [0.55, 0.64, 0.78, 0.55], powder: [0.74, 0.62, 0.46, 0.5], ground: [0.66, 0.74, 0.86, 0.5], ice: [1, 1, 1, 0.55] };
const CONFETTI = [0x7fdcff, 0xff5d8f, 0xffd54a, 0x6bffb0, 0xffffff, 0xb08cff];

function setEdge(edge, a, b) {
    for (let k = 0; k < 3; k++) { edge.a[k] = a[k]; edge.b[k] = b[k]; }
    return edge;
}

const PARTICLE_VERT = /* glsl */`
attribute float size;
attribute float alpha;
attribute vec3 color;
uniform float uScale;
varying vec3 vColor;
varying float vAlpha;
void main() {
    vColor = color;
    vAlpha = alpha;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = min(200.0, size * uScale / max(0.1, -mv.z));
    gl_Position = projectionMatrix * mv;
}`;

const PARTICLE_FRAG = /* glsl */`
uniform sampler2D uMap;
varying vec3 vColor;
varying float vAlpha;
void main() {
    vec4 t = texture2D(uMap, gl_PointCoord);
    gl_FragColor = vec4(vColor, t.a * vAlpha);
    if (gl_FragColor.a < 0.01) discard;
    #include <colorspace_fragment>
}`;

const SNOW_VERT = /* glsl */`
attribute float rnd;
uniform vec3 uCam, uOffset;
uniform float uTime, uBox, uScale, uFall;
varying float vAlpha;
void main() {
    vec3 p = position * uBox + uOffset;
    p.y -= uTime * uFall * (0.7 + rnd * 0.6);
    p.x += sin(uTime * (0.6 + rnd) + rnd * 40.0) * 1.2;
    p.z += cos(uTime * (0.5 + rnd * 0.8) + rnd * 25.0) * 1.2;
    vec3 rel = mod(p - uCam + uBox * 0.5, uBox) - uBox * 0.5;
    vec4 mv = modelViewMatrix * vec4(uCam + rel, 1.0);
    float d = -mv.z;
    // Fade near the box edges (no popping) and right in front of the lens.
    float edge = 1.0 - smoothstep(0.35, 0.5, max(max(abs(rel.x), abs(rel.y)), abs(rel.z)) / uBox);
    vAlpha = edge * smoothstep(0.6, 2.5, d);
    gl_PointSize = clamp((0.09 + rnd * 0.07) * uScale / max(0.1, d), 1.0, 24.0);
    gl_Position = projectionMatrix * mv;
}`;

const SNOW_FRAG = /* glsl */`
uniform sampler2D uMap;
uniform vec3 uColor;
uniform float uOpacity;
varying float vAlpha;
void main() {
    float a = texture2D(uMap, gl_PointCoord).a * vAlpha * uOpacity;
    if (a < 0.01) discard;
    gl_FragColor = vec4(uColor, a);
    #include <colorspace_fragment>
}`;

/** A pooled particle system drawn as one Points object. */
class Particles {
    constructor(capacity, additive) {
        this.cap = capacity;
        this.n = 0;
        const f = (k) => new Float32Array(capacity * k);
        this.pos = f(3); this.vel = f(3); this.col = f(3);
        this.life = f(1); this.max = f(1); this.size0 = f(1); this.size1 = f(1); this.alpha0 = f(1);
        this.grav = f(1); this.drag = f(1);
        const g = new THREE.BufferGeometry();
        this.aPos = new THREE.BufferAttribute(f(3), 3).setUsage(THREE.DynamicDrawUsage);
        this.aCol = new THREE.BufferAttribute(f(3), 3).setUsage(THREE.DynamicDrawUsage);
        this.aSize = new THREE.BufferAttribute(f(1), 1).setUsage(THREE.DynamicDrawUsage);
        this.aAlpha = new THREE.BufferAttribute(f(1), 1).setUsage(THREE.DynamicDrawUsage);
        g.setAttribute('position', this.aPos);
        g.setAttribute('color', this.aCol);
        g.setAttribute('size', this.aSize);
        g.setAttribute('alpha', this.aAlpha);
        this.attrs = [this.aPos, this.aCol, this.aSize, this.aAlpha];
        g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
        this.uniforms = { uMap: { value: flakeTexture() }, uScale: { value: 600 } };
        this.material = new THREE.ShaderMaterial({
            uniforms: this.uniforms, vertexShader: PARTICLE_VERT, fragmentShader: PARTICLE_FRAG,
            transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
        });
        this.points = new THREE.Points(g, this.material);
        this.points.frustumCulled = false;
        this.points.renderOrder = additive ? 7 : 6;
    }

    /** o: { pos, vel, color (hex or [r,g,b]), life, size, size1, alpha, gravity, drag } */
    emit(px, py, pz, vx, vy, vz, color, life, size, size1, alpha, gravity, drag) {
        let i = this.n;
        if (i >= this.cap) {
            // Full: recycle the oldest-looking slot (cheap round robin).
            i = this._rr = ((this._rr || 0) + 1) % this.cap;
        } else {
            this.n++;
        }
        const i3 = i * 3;
        this.pos[i3] = px; this.pos[i3 + 1] = py; this.pos[i3 + 2] = pz;
        this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
        this.col[i3] = color[0]; this.col[i3 + 1] = color[1]; this.col[i3 + 2] = color[2];
        this.life[i] = 0; this.max[i] = life; this.size0[i] = size; this.size1[i] = size1;
        this.alpha0[i] = alpha; this.grav[i] = gravity; this.drag[i] = drag;
    }

    update(dt) {
        let n = this.n;
        const P = this.pos, V = this.vel;
        for (let i = 0; i < n; i++) {
            this.life[i] += dt;
            if (this.life[i] >= this.max[i]) {
                // Swap-remove with the last live particle.
                n--;
                if (i !== n) {
                    const a = i * 3, b = n * 3;
                    for (let k = 0; k < 3; k++) { P[a + k] = P[b + k]; V[a + k] = V[b + k]; this.col[a + k] = this.col[b + k]; }
                    this.life[i] = this.life[n]; this.max[i] = this.max[n]; this.size0[i] = this.size0[n]; this.size1[i] = this.size1[n];
                    this.alpha0[i] = this.alpha0[n]; this.grav[i] = this.grav[n]; this.drag[i] = this.drag[n];
                    i--;
                }
                continue;
            }
            const i3 = i * 3;
            const d = Math.exp(-this.drag[i] * dt);
            V[i3] *= d; V[i3 + 1] = V[i3 + 1] * d - this.grav[i] * dt; V[i3 + 2] *= d;
            P[i3] += V[i3] * dt; P[i3 + 1] += V[i3 + 1] * dt; P[i3 + 2] += V[i3 + 2] * dt;
        }
        this.n = n;
        const ap = this.aPos.array, ac = this.aCol.array, as = this.aSize.array, aa = this.aAlpha.array;
        for (let i = 0; i < n; i++) {
            const t = this.life[i] / this.max[i];
            const i3 = i * 3;
            ap[i3] = P[i3]; ap[i3 + 1] = P[i3 + 1]; ap[i3 + 2] = P[i3 + 2];
            ac[i3] = this.col[i3]; ac[i3 + 1] = this.col[i3 + 1]; ac[i3 + 2] = this.col[i3 + 2];
            as[i] = this.size0[i] + (this.size1[i] - this.size0[i]) * t;
            // Quick fade in, long fade out.
            aa[i] = this.alpha0[i] * Math.min(1, t * 8) * (1 - t * t);
        }
        const g = this.points.geometry;
        g.setDrawRange(0, n);
        for (const a of this.attrs) {
            a.clearUpdateRanges();
            a.addUpdateRange(0, n * a.itemSize);
            a.needsUpdate = true;
        }
    }

    clear() {
        this.n = 0;
        this.points.geometry.setDrawRange(0, 0);
    }

    dispose() {
        this.points.geometry.dispose();
        this.material.dispose();
    }
}

/** Ring buffer of skid quads; each car wheel draws a ribbon while it slides. */
class Skids {
    constructor(capacity) {
        this.cap = capacity;
        this.next = 0;
        this.count = 0;
        const pos = new Float32Array(capacity * 4 * 3), col = new Float32Array(capacity * 4 * 4), uv = new Float32Array(capacity * 4 * 2);
        const idx = new Uint32Array(capacity * 6);
        for (let i = 0; i < capacity; i++) {
            const v = i * 4;
            idx.set([v, v + 2, v + 1, v + 1, v + 2, v + 3], i * 6);
            uv.set([0, 0, 1, 0, 0, 1, 1, 1], i * 8);
        }
        const g = new THREE.BufferGeometry();
        this.aPos = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
        this.aCol = new THREE.BufferAttribute(col, 4).setUsage(THREE.DynamicDrawUsage);
        g.setAttribute('position', this.aPos);
        g.setAttribute('color', this.aCol);
        g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
        g.setIndex(new THREE.BufferAttribute(idx, 1));
        g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
        this.material = new THREE.MeshBasicMaterial({
            map: skidTexture(), vertexColors: true, transparent: true, depthWrite: false,
            polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -6,
        });
        this.mesh = new THREE.Mesh(g, this.material);
        this.mesh.frustumCulled = false;
        this.mesh.renderOrder = 1;
        this.age = new Float32Array(capacity);
        this.base = new Float32Array(capacity);
    }

    /** Quad from (a0, a1) to (b0, b1): the previous and the new edge of a ribbon. */
    add(a0, a1, b0, b1, rgba) {
        const i = this.next;
        this.next = (this.next + 1) % this.cap;
        this.count = Math.min(this.cap, this.count + 1);
        const p = this.aPos.array, c = this.aCol.array;
        const v = i * 12;
        p.set(a0, v); p.set(a1, v + 3); p.set(b0, v + 6); p.set(b1, v + 9);
        for (let k = 0; k < 4; k++) c.set(rgba, i * 16 + k * 4);
        this.age[i] = 0;
        this.base[i] = rgba[3];
        this.aPos.needsUpdate = true;
        this.aCol.needsUpdate = true;
    }

    update(dt) {
        // Marks fade away after ~8 s.
        const c = this.aCol.array;
        let dirty = false;
        for (let i = 0; i < this.count; i++) {
            const a0 = this.age[i];
            if (a0 > 12) continue;
            const a = this.age[i] = a0 + dt;
            if (a > 6) {
                const k = this.base[i] * Math.max(0, 1 - (a - 6) / 4);
                for (let j = 0; j < 4; j++) c[i * 16 + j * 4 + 3] = k;
                dirty = true;
            }
        }
        if (dirty) this.aCol.needsUpdate = true;
    }

    clear() {
        this.aCol.array.fill(0);
        this.aCol.needsUpdate = true;
        this.count = 0;
        this.next = 0;
    }

    dispose() {
        this.mesh.geometry.dispose();
        this.material.dispose();
    }
}

export class Effects {
    constructor(renderer) {
        this.renderer = renderer;
        this.reducedMotion = renderer.reducedMotion;
        this.quality = renderer.quality;
        this.q = QUALITY[this.quality];
        this.group = new THREE.Group();
        this.group.name = 'effects';
        renderer.scene.add(this.group);
        this.rand = rngOf(0xC0FFEE);
        this.time = 0;
        this.trails = new Map();      // car -> per-wheel ribbon state
        this._exhaust = new Map();    // car -> last exhaust positions (boost trail)
        this.headlightCar = null;
        this._build();
    }

    _build() {
        const q = this.q;
        this.soft = new Particles(q.particles, false);
        this.glow = new Particles(Math.round(q.particles * 0.6), true);
        this.skids = new Skids(q.skids);
        this.group.add(this.skids.mesh, this.soft.points, this.glow.points);

        // Falling snow, wrapped around the camera on the GPU.
        const n = q.snow;
        const pos = new Float32Array(n * 3), rnd = new Float32Array(n);
        const r = rngOf(7);
        for (let i = 0; i < n; i++) {
            pos[i * 3] = r(); pos[i * 3 + 1] = r(); pos[i * 3 + 2] = r();
            rnd[i] = r();
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        g.setAttribute('rnd', new THREE.BufferAttribute(rnd, 1));
        g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
        this.snowUniforms = {
            uMap: { value: flakeTexture() }, uCam: { value: new THREE.Vector3() }, uTime: { value: 0 },
            uBox: { value: SNOW_BOX }, uScale: { value: 600 }, uFall: { value: 2.2 }, uOffset: { value: new THREE.Vector3() },
            uColor: { value: new THREE.Color(1, 1, 1) }, uOpacity: { value: 0.9 },
        };
        this.snow = new THREE.Points(g, new THREE.ShaderMaterial({
            uniforms: this.snowUniforms, vertexShader: SNOW_VERT, fragmentShader: SNOW_FRAG,
            transparent: true, depthWrite: false,
        }));
        this.snow.frustumCulled = false;
        this.snow.renderOrder = 8;
        this.group.add(this.snow);

        // Pulse rings (checkpoints, laps) and the respawn flash.
        this.rings = [];
        this.ringGeo = new THREE.RingGeometry(0.86, 1, 48);
        this.flash = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({
            color: 0xdff6ff, transparent: true, opacity: 0, depthTest: false, depthWrite: false, toneMapped: false,
        }));
        this.flash.frustumCulled = false;
        this.flash.renderOrder = 1000;
        this.flash.visible = false;
        this.group.add(this.flash);
        this.flashT = 0;

        // Player headlights (night moods).
        this.spot = new THREE.SpotLight(0xfff1d6, 0, 80, 0.48, 0.65, 1.5);
        this.spot.visible = false;
        this.spotTarget = new THREE.Object3D();
        this.spot.target = this.spotTarget;
    }

    setQuality(q) {
        if (q === this.quality) return;
        this.quality = q;
        this.q = QUALITY[q];
        const car = this.headlightCar;
        this.dispose(true);
        this._build();
        if (car) this.attachHeadlight(car);
        this.setMood(this.mood, this.preset);
    }

    setMood(mood, preset) {
        this.mood = mood;
        this.preset = preset;
        if (!preset) return;
        const night = mood === 'night' || mood === 'aurora';
        const u = this.snowUniforms;
        u.uOpacity.value = night ? 0.85 : mood === 'sunset' ? 0.7 : 0.8;
        u.uColor.value.setHex(night ? 0xdbe8ff : 0xffffff);
        u.uFall.value = this.reducedMotion ? 1.2 : 2.2;
        this.spot.visible = preset.headlights > 0.5 && !!this.headlightCar;
        this.spot.intensity = 110 * preset.headlights;
    }

    attachHeadlight(car) {
        this.headlightCar = car;
        car.object.add(this.spot, this.spotTarget);
        this.spot.position.set(0, 0.45, 1.9);
        this.spotTarget.position.set(0, -0.8, 22);
        if (this.preset) this.setMood(this.mood, this.preset);
    }

    carRemoved(car) {
        this.trails.delete(car);
        if (this.headlightCar === car) {
            car.object.remove(this.spot, this.spotTarget);
            this.headlightCar = null;
            this.spot.visible = false;
            const next = this.renderer.cars.find((c) => c.kind === 'player' && c !== car);
            if (next) this.attachHeadlight(next);
        }
    }

    carTeleported(car) {
        // Break the skid ribbons and trails so they never streak across the map.
        this.trails.delete(car);
        this._exhaust.delete(car);
    }

    reset() {
        this.soft.clear();
        this.glow.clear();
        this.skids.clear();
        this.trails.clear();
        this._exhaust.clear();
        for (const r of this.rings) r.mesh.visible = false;
        this.flashT = 0;
        this.flash.visible = false;
    }

    // -----------------------------------------------------------------------

    _color(hex, out = [0, 0, 0]) {
        const c = this._c || (this._c = new THREE.Color());
        c.setHex(hex);
        out[0] = c.r; out[1] = c.g; out[2] = c.b;
        return out;
    }

    burst(pos, n, { color = 0xffffff, speed = 6, up = 3, life = 0.9, size = 0.6, size1 = 1.6, alpha = 0.85, gravity = 6, drag = 2, glow = false, spread = 0.6, colors = null } = {}) {
        const r = this.rand;
        const sys = glow ? this.glow : this.soft;
        const col = this._color(color, []);
        for (let i = 0; i < n; i++) {
            const a = r() * Math.PI * 2, s = speed * (0.4 + r() * 0.8);
            const c = colors ? this._color(colors[Math.floor(r() * colors.length)], []) : col;
            sys.emit(
                pos[0] + (r() - 0.5) * spread, pos[1] + (r() - 0.5) * spread * 0.5, pos[2] + (r() - 0.5) * spread,
                Math.cos(a) * s, up * (0.5 + r()), Math.sin(a) * s,
                c, life * (0.6 + r() * 0.8), size * (0.7 + r() * 0.6), size1 * (0.7 + r() * 0.6), alpha, gravity, drag,
            );
        }
    }

    ring(car, color, scale = 16) {
        let r = this.rings.find((x) => !x.mesh.visible);
        if (!r) {
            const mat = new THREE.MeshBasicMaterial({
                color, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false,
                side: THREE.DoubleSide, toneMapped: false,
            });
            r = { mesh: new THREE.Mesh(this.ringGeo, mat), t: 0 };
            r.mesh.renderOrder = 9;
            this.rings.push(r);
            this.group.add(r.mesh);
        }
        r.mesh.material.color.setHex(color);
        r.mesh.visible = true;
        r.mesh.position.copy(car.object.position);
        r.mesh.quaternion.copy(car.object.quaternion);
        r.t = 0;
        r.scale = scale;
        r.car = car;
    }

    /** One sim event of `car`. */
    event(e, car) {
        if (!car || !car.view) return;
        const p = car.object.position;
        const pos = [p.x, p.y, p.z];
        switch (e.type) {
            case 'checkpoint':
                this.ring(car, 0x5fe3ff);
                this.burst(pos, 26, { color: 0x9fefff, glow: true, speed: 9, up: 4, life: 0.8, size: 0.35, size1: 0.1, gravity: 2 });
                break;
            case 'lap':
                this.ring(car, 0xffd54a, 18);
                this.burst(pos, 40, { color: 0xffe08a, glow: true, speed: 10, up: 5, life: 1, size: 0.4, size1: 0.1, gravity: 3 });
                break;
            case 'finish':
                this.ring(car, 0xffd54a, 22);
                this.confetti(car);
                break;
            case 'boost':
                this.burst(pos, e.level === 2 ? 40 : 26, { color: e.level === 2 ? 0xff3f8a : 0x5fe3ff, glow: true, speed: 7, up: 2, life: 0.6, size: 0.5, size1: 0.1, gravity: 0 });
                break;
            case 'effect':
                if (e.effect !== 'turbo' && e.effect !== 'turbo2') {
                    this.burst(pos, 22, { color: parseInt((EFFECT_COLORS[e.effect] || '#ffffff').slice(1), 16), glow: true, speed: 6, up: 3, life: 0.7, size: 0.45, size1: 0.1, gravity: 1 });
                }
                break;
            case 'land': {
                const s = Math.min(1, (e.strength || 0) / 20);
                this.burst([p.x, p.y - 0.5, p.z], Math.round(14 + 50 * s), { color: 0xeef5ff, speed: 3 + 7 * s, up: 2 + 2 * s, life: 0.9, size: 0.8, size1: 2.6, alpha: 0.75, gravity: 4, drag: 2.5, spread: 2.4 });
                break;
            }
            case 'wallhit': {
                const s = Math.min(1, (e.intensity || 0) / 25);
                const at = e.pos || pos;
                this.burst(at, Math.round(10 + 30 * s), { color: 0xbfe9ff, speed: 6 + 8 * s, up: 4, life: 0.7, size: 0.25, size1: 0.12, alpha: 0.95, gravity: 16, drag: 0.6, spread: 0.6 });
                this.burst(at, Math.round(6 + 12 * s), { color: 0xffffff, glow: true, speed: 5, up: 3, life: 0.4, size: 0.3, size1: 0.05, gravity: 8 });
                break;
            }
            case 'fragileBreak':
                this.burst(pos, 40, { color: 0xdff3ff, speed: 9, up: 6, life: 1, size: 0.3, size1: 0.15, alpha: 1, gravity: 16, drag: 0.5, spread: 1.4 });
                break;
            case 'respawn':
                // The car is drawn at its new place from the next frame: burst there.
                if (!this.reducedMotion) this.flashT = 0.35;
                (this.pendingRespawn || (this.pendingRespawn = new Set())).add(car);
                break;
        }
    }

    confetti(car) {
        // Confetti-snow: a shower of coloured flakes over and ahead of the car.
        const p = car.object.position, v = car.view?.vel || [0, 0, 0];
        const r = this.rand;
        const n = this.reducedMotion ? 160 : 420;
        for (let i = 0; i < n; i++) {
            const c = this._color(CONFETTI[i % CONFETTI.length], []);
            const ahead = r() * 1.6;
            this.soft.emit(
                p.x + (r() - 0.5) * 18 + v[0] * ahead, p.y + 2 + r() * 9, p.z + (r() - 0.5) * 18 + v[2] * ahead,
                (r() - 0.5) * 4 + v[0] * 0.15, 2 + r() * 5, (r() - 0.5) * 4 + v[2] * 0.15,
                c, 3 + r() * 2.5, 0.55, 0.45, 1, 1.6, 0.8,
            );
        }
    }

    // -----------------------------------------------------------------------

    update(dt, camera) {
        this.time += dt;
        const u = this.snowUniforms;
        u.uTime.value = this.time % 1000;
        u.uCam.value.copy(camera.position);
        // Wind: a steady breeze plus a headwind that grows with the focus car's speed.
        const focus = this.renderer.cameraControls.target;
        const fv = focus?.view?.vel;
        const wind = this._wind || (this._wind = new THREE.Vector3());
        wind.set(1.2, 0, 0.6);
        if (fv && !this.reducedMotion) wind.addScaledVector(this._v3 || (this._v3 = new THREE.Vector3()).set(fv[0], fv[1], fv[2]), -0.12);
        const off = u.uOffset.value.addScaledVector(wind, dt);
        off.set(off.x % SNOW_BOX, off.y % SNOW_BOX, off.z % SNOW_BOX);
        if (this.pendingRespawn?.size) {
            for (const car of this.pendingRespawn) {
                const p = car.object.position;
                this.burst([p.x, p.y, p.z], 30, { color: 0xbfefff, glow: true, speed: 4, up: 3, life: 0.6, size: 0.6, size1: 0.1, gravity: 0, spread: 2.5 });
            }
            this.pendingRespawn.clear();
        }
        if (dt > 0) {
            for (const car of this.renderer.cars) if (car.visible && car.view && car.kind !== 'ghost') this._carFx(car, dt);
        }
        this.soft.update(dt);
        this.glow.update(dt);
        this.skids.update(dt);
        for (const r of this.rings) {
            if (!r.mesh.visible) continue;
            r.t += dt;
            const k = r.t / 0.7;
            if (k >= 1) {
                r.mesh.visible = false;
                continue;
            }
            const s = 3 + r.scale * (1 - (1 - k) * (1 - k));
            r.mesh.scale.setScalar(s);
            r.mesh.material.opacity = 0.85 * (1 - k);
            if (r.car?.object) r.mesh.position.lerp(r.car.object.position, 0.5);
        }
        if (this.flashT > 0) this.flashT = Math.max(0, this.flashT - dt);
    }

    /** Spray, sparkle, skid ribbons and boost trail of one car. */
    _carFx(car, dt) {
        const v = car.view;
        const W = v.wheels;
        if (!W || !W[0].pos) return;
        const r = this.rand;
        const q = this.q;
        const speed = v.speed ?? (v.speedKmh || 0) / 3.6;
        const vel = v.vel || [0, 0, 0];
        const o = car.object;
        const up = this._up || (this._up = new THREE.Vector3());
        up.set(0, 1, 0).applyQuaternion(o.quaternion);
        const right = this._right || (this._right = new THREE.Vector3());
        right.set(-1, 0, 0).applyQuaternion(o.quaternion);
        let tr = this.trails.get(car);
        if (!tr) {
            tr = [null, null, null, null];
            this.trails.set(car, tr);
        }
        const skidding = v.drifting || Math.abs(v.slipAngle || 0) > 0.16;
        for (let i = 0; i < 4; i++) {
            const w = W[i];
            const cx = w.pos[0] - up.x * 0.36, cy = w.pos[1] - up.y * 0.36, cz = w.pos[2] - up.z * 0.36;
            if (!w.contact || !w.surface) {
                tr[i] = null;
                continue;
            }
            const surf = w.surface;
            const slip = w.slip || 0;
            // Snow spray: powder and deep snow throw a lot, packed snow only when sliding.
            let rate = 0;
            if (speed > 3) {
                const base = surf === 'powder' ? 34 : surf === 'ground' ? 46 : surf === 'snow' ? 4 : surf === 'ice' ? 0 : 0;
                rate = (base * Math.min(1, speed / 30) + (surf !== 'ice' ? 70 * slip + (skidding ? 30 : 0) : 0)) * q.spray;
                if (i < 2) rate *= 0.4;
            }
            let n = rate * dt;
            while (n > 0 && (n >= 1 || r() < n)) {
                n -= 1;
                const tint = SPRAY_TINTS[surf] || SPRAY_TINTS.other;
                const k = 0.25 + r() * 0.35;
                this.soft.emit(
                    cx + (r() - 0.5) * 0.4, cy + 0.05, cz + (r() - 0.5) * 0.4,
                    vel[0] * k + up.x * (1.5 + r() * 2.5) + right.x * (r() - 0.5) * 3,
                    vel[1] * k + up.y * (1.5 + r() * 2.5) + right.y * (r() - 0.5) * 3,
                    vel[2] * k + up.z * (1.5 + r() * 2.5) + right.z * (r() - 0.5) * 3,
                    tint, 0.5 + r() * 0.6, 0.35, 1.3 + Math.min(1, speed / 40), 0.7, 7, 3,
                );
            }
            // Ice: little glints kicked up behind the wheels.
            if (surf === 'ice' && speed > 8 && r() < dt * (8 + 40 * slip) * q.spray) {
                this.glow.emit(cx, cy + 0.08, cz, vel[0] * 0.5 + (r() - 0.5) * 2, 1 + r() * 2, vel[2] * 0.5 + (r() - 0.5) * 2,
                    GLINT, 0.35 + r() * 0.3, 0.22, 0.05, 1, 4, 1);
            }
            // Skid ribbons from the rear wheels (and the fronts in big slides).
            const marks = (i >= 2 || slip > 0.6) && (skidding || slip > 0.35 || (surf === 'ice' && slip > 0.2));
            if (marks && speed > 4) {
                const hw = 0.17;
                // Scratch edge; the ribbon's last edge is copied into a per-wheel slot (no garbage per frame).
                const a = this._skidA || (this._skidA = [0, 0, 0]), b = this._skidB || (this._skidB = [0, 0, 0]);
                a[0] = cx + right.x * hw + up.x * 0.035; a[1] = cy + right.y * hw + up.y * 0.035; a[2] = cz + right.z * hw + up.z * 0.035;
                b[0] = cx - right.x * hw + up.x * 0.035; b[1] = cy - right.y * hw + up.y * 0.035; b[2] = cz - right.z * hw + up.z * 0.035;
                const prev = tr[i];
                if (prev) {
                    const dx = a[0] - prev.a[0], dz = a[2] - prev.a[2], dy = a[1] - prev.a[1];
                    if (dx * dx + dy * dy + dz * dz > 0.36) {
                        this.skids.add(prev.a, prev.b, a, b, SKID_COLORS[surf] || SKID_COLORS.snow);
                        setEdge(prev, a, b);
                    }
                } else {
                    tr[i] = setEdge({ a: [0, 0, 0], b: [0, 0, 0] }, a, b);
                }
            } else {
                tr[i] = null;
            }
        }
        // Boost trail: glowing sparks spread along the path the exhaust moved this frame.
        const fx = v.effects;
        const back = this._back || (this._back = new THREE.Vector3());
        let last = this._exhaust.get(car);
        if (fx && fx.turbo) {
            const col = fx.turbo === 2 ? BOOST_AVALANCHE : BOOST_FROST;
            const fade = Math.min(1, (fx.turboTime ?? 2) / 1.2 + 0.25);
            const fresh = !last;
            if (fresh) this._exhaust.set(car, last = [[0, 0, 0], [0, 0, 0]]);
            for (let k = 0; k < 2; k++) {
                back.set((k ? -1 : 1) * 0.22, 0.12, -2.25).applyQuaternion(o.quaternion).add(o.position);
                const p = last[k];
                const x0 = fresh ? back.x : p[0], y0 = fresh ? back.y : p[1], z0 = fresh ? back.z : p[2];
                const dx = back.x - x0, dy = back.y - y0, dz = back.z - z0;
                const gap = Math.sqrt(dx * dx + dy * dy + dz * dz);
                const n = Math.min(32, Math.max(1, Math.ceil(gap / (0.11 / q.spray))));
                for (let j = 0; j < n; j++) {
                    const f = (j + r()) / n;
                    this.glow.emit(
                        x0 + dx * f, y0 + dy * f, z0 + dz * f,
                        (r() - 0.5) * 0.8, (r() - 0.5) * 0.8 + 0.3, (r() - 0.5) * 0.8,
                        col, 0.16 + r() * 0.1, 0.34 * fade, 0.06, 0.5, 0, 2);
                }
                p[0] = back.x; p[1] = back.y; p[2] = back.z;
            }
        } else if (last) {
            this._exhaust.delete(car);
        }
    }

    /** Per-camera setup right before a draw: point sizes and the flash quad. */
    beforeRender(camera, heightPx) {
        const h = heightPx || this.renderer.webgl.getDrawingBufferSize(this._sz || (this._sz = new THREE.Vector2())).y;
        const scale = h / (2 * Math.tan((camera.fov * Math.PI) / 360));
        this.soft.uniforms.uScale.value = scale;
        this.glow.uniforms.uScale.value = scale;
        this.snowUniforms.uScale.value = scale;
        this.snowUniforms.uCam.value.copy(camera.position);
        const f = this.flash;
        if (this.flashT > 0) {
            f.visible = true;
            f.material.opacity = (this.flashT / 0.35) * 0.55;
            // A quad just in front of the lens covering the view.
            f.position.set(0, 0, -0.5).applyMatrix4(camera.matrixWorld);
            f.quaternion.copy(camera.quaternion);
            const s = Math.tan((camera.fov * Math.PI) / 360) * 0.5 * 1.05;
            f.scale.set(s * camera.aspect, s, 1);
        } else {
            f.visible = false;
        }
    }

    dispose(keepGroup = false) {
        this.soft.dispose();
        this.glow.dispose();
        this.skids.dispose();
        this.snow.geometry.dispose();
        this.snow.material.dispose();
        for (const r of this.rings) r.mesh.material.dispose();
        this.ringGeo.dispose();
        this.flash.geometry.dispose();
        this.flash.material.dispose();
        if (this.headlightCar) this.headlightCar.object.remove(this.spot, this.spotTarget);
        this.spot.dispose();
        this.group.clear();
        if (!keepGroup) this.renderer.scene.remove(this.group);
    }
}
