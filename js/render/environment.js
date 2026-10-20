// Sky, fog, lights and moods. The sky is one dome with a gradient shader
// (sun or moon disc, procedural stars, animated aurora curtains) whose horizon
// colour equals the fog colour, so far terrain melts into it.
import * as THREE from 'three';

export const MOOD_IDS = ['day', 'sunset', 'night', 'aurora'];

// Colours are sRGB hex; light intensities are tuned for ACES tone mapping.
export const MOODS = {
    day: {
        top: 0x2f7fe0, mid: 0x7cc0f5, horizon: 0xd9eeff, below: 0xe8f3ff,
        sunDir: [0.42, 0.62, 0.66], sunColor: 0xfff3e0, sunIntensity: 3.1, sunDisc: 1, sunGlow: 0.55,
        hemiSky: 0xd7ebff, hemiGround: 0x9fb3cf, hemiIntensity: 1.35,
        fog: [0xd9eeff, 260, 3600], exposure: 1.0,
        stars: 0, aurora: 0, moon: 0, lamps: 0, headlights: 0, roadGlow: 0, clouds: 1,
    },
    sunset: {
        top: 0x2d3f8c, mid: 0xc97aa8, horizon: 0xffb48a, below: 0xf7c4a6,
        sunDir: [-0.62, 0.11, 0.78], sunColor: 0xffa66b, sunIntensity: 2.7, sunDisc: 1.2, sunGlow: 1.25,
        hemiSky: 0xffd2c0, hemiGround: 0x8a7aa8, hemiIntensity: 1.25,
        fog: [0xffb48a, 220, 3200], exposure: 1.02,
        stars: 0.1, aurora: 0, moon: 0, lamps: 0.6, headlights: 0.3, roadGlow: 0.15, clouds: 1,
    },
    night: {
        top: 0x030918, mid: 0x0b1a3d, horizon: 0x1f3868, below: 0x1a2f58,
        sunDir: [0.35, 0.55, -0.76], sunColor: 0xa9c4ff, sunIntensity: 0.95, sunDisc: 0, sunGlow: 0.25,
        hemiSky: 0x5a78b8, hemiGround: 0x1c2a4c, hemiIntensity: 1.25,
        fog: [0x1f3868, 180, 2600], exposure: 1.18,
        stars: 1, aurora: 0, moon: 1, lamps: 1, headlights: 1, roadGlow: 0.85, clouds: 0,
    },
    aurora: {
        top: 0x020a16, mid: 0x0a2236, horizon: 0x16404f, below: 0x15384a,
        sunDir: [-0.3, 0.6, 0.74], sunColor: 0xb8ffe6, sunIntensity: 0.85, sunDisc: 0, sunGlow: 0.2,
        hemiSky: 0x5fa8a8, hemiGround: 0x173040, hemiIntensity: 1.25,
        fog: [0x16404f, 180, 2600], exposure: 1.18,
        stars: 0.85, aurora: 1, moon: 0.6, lamps: 1, headlights: 1, roadGlow: 0.85, clouds: 0,
    },
};

const SKY_VERT = /* glsl */`
varying vec3 vDir;
void main() {
    vDir = position;
    vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position = p.xyww;
}`;

const SKY_FRAG = /* glsl */`
uniform vec3 uTop, uMid, uHorizon, uBelow, uSunColor, uSunDir, uMoonDir;
uniform float uSunDisc, uSunGlow, uStars, uAurora, uMoon, uTime, uClouds;
varying vec3 vDir;

float hash13(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
}
float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}
float noise2(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
    float a = 0.5, s = 0.0;
    for (int i = 0; i < 4; i++) { s += a * noise2(p); p *= 2.03; a *= 0.5; }
    return s;
}

void main() {
    vec3 d = normalize(vDir);
    float h = d.y;
    vec3 col = mix(uHorizon, uMid, smoothstep(0.0, 0.28, h));
    col = mix(col, uTop, smoothstep(0.22, 0.95, h));
    col = mix(col, uBelow, smoothstep(0.0, -0.12, h));

    // Sun: disc, halo and a broad warm glow along the horizon.
    float sd = max(dot(d, normalize(uSunDir)), 0.0);
    col += uSunColor * uSunDisc * smoothstep(0.9994, 0.9997, sd) * 2.0;
    col += uSunColor * uSunGlow * (pow(sd, 12.0) * 0.45 + pow(sd, 90.0) * 0.6);
    col += uSunColor * uSunGlow * 0.18 * pow(sd, 3.0) * (1.0 - smoothstep(0.0, 0.35, h));

    // Moon.
    float md = max(dot(d, normalize(uMoonDir)), 0.0);
    col += vec3(0.92, 0.96, 1.0) * uMoon * smoothstep(0.99955, 0.9998, md);
    col += vec3(0.5, 0.6, 0.85) * uMoon * pow(md, 60.0) * 0.35;

    // Soft clouds (day / sunset), in a band above the horizon.
    if (uClouds > 0.0 && h > 0.0) {
        vec2 cp = d.xz / (h + 0.18) * 1.6 + vec2(uTime * 0.004, 0.0);
        float c = smoothstep(0.52, 0.8, fbm(cp));
        float band = smoothstep(0.02, 0.12, h) * (1.0 - smoothstep(0.35, 0.8, h));
        vec3 cc = mix(uHorizon, vec3(1.0), 0.6) + uSunColor * pow(sd, 6.0) * 0.25;
        col = mix(col, cc, c * band * 0.75 * uClouds);
    }

    // Stars: one per cell of a direction grid, twinkling.
    if (uStars > 0.0 && h > 0.0) {
        vec3 p = d * 220.0;
        vec3 cell = floor(p);
        float r = hash13(cell);
        if (r > 0.965) {
            vec3 c = cell + 0.5 + (vec3(hash13(cell + 1.7), hash13(cell + 3.1), hash13(cell + 5.3)) - 0.5) * 0.6;
            float dist = length(p - c);
            float tw = 0.65 + 0.35 * sin(uTime * (1.5 + r * 6.0) + r * 40.0);
            col += vec3(0.85, 0.92, 1.0) * smoothstep(0.16, 0.0, dist) * uStars * tw * smoothstep(0.0, 0.2, h) * (r - 0.965) * 30.0;
        }
    }

    // Aurora curtains: wavy bands with vertical rays, green at the hem, violet at the top.
    if (uAurora > 0.0 && h > 0.02) {
        float az = atan(d.z, d.x);
        vec3 acc = vec3(0.0);
        for (int i = 0; i < 3; i++) {
            float fi = float(i);
            float base = 0.16 + 0.07 * fi + 0.05 * sin(az * (2.0 + fi) + uTime * (0.07 + 0.03 * fi) + fi * 2.1)
                + 0.025 * sin(az * 9.0 - uTime * 0.21 + fi);
            float above = h - base;
            float hem = smoothstep(-0.015, 0.0, above) * exp(-max(above, 0.0) * (7.0 - fi));
            float rays = 0.55 + 0.45 * sin(az * 70.0 + 6.0 * fbm(vec2(az * 6.0 + fi, uTime * 0.12)));
            float pres = smoothstep(0.25, 0.75, fbm(vec2(az * 1.6 + fi * 3.0, uTime * 0.03 + fi)));
            vec3 c = mix(vec3(0.15, 1.0, 0.55), vec3(0.55, 0.3, 1.0), smoothstep(0.0, 0.22, above));
            acc += c * hem * rays * pres;
        }
        col += acc * uAurora * 0.75;
    }
    gl_FragColor = vec4(col, 1.0);
}`;

/** sRGB components of a hex colour: the sky shader skips colour management on purpose. */
function rgbOf(hex) {
    return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}

export class Environment {
    constructor(renderer, scene, quality) {
        this.renderer = renderer;
        this.scene = scene;
        this.quality = quality;
        this.mood = 'day';
        this.preset = MOODS.day;
        this.time = 0;
        this.envMap = null;

        this.uniforms = {
            uTop: { value: new THREE.Vector3() }, uMid: { value: new THREE.Vector3() },
            uHorizon: { value: new THREE.Vector3() }, uBelow: { value: new THREE.Vector3() },
            uSunColor: { value: new THREE.Vector3() }, uSunDir: { value: new THREE.Vector3(0, 1, 0) },
            uMoonDir: { value: new THREE.Vector3(0, 1, 0) },
            uSunDisc: { value: 1 }, uSunGlow: { value: 0.5 }, uStars: { value: 0 }, uAurora: { value: 0 },
            uMoon: { value: 0 }, uTime: { value: 0 }, uClouds: { value: 1 },
        };
        const skyMat = new THREE.ShaderMaterial({
            uniforms: this.uniforms, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG,
            side: THREE.BackSide, depthWrite: false, depthTest: true, fog: false, toneMapped: false,
        });
        this.sky = new THREE.Mesh(new THREE.SphereGeometry(5000, 48, 24), skyMat);
        this.sky.name = 'sky';
        this.sky.renderOrder = -10;
        this.sky.frustumCulled = false;
        scene.add(this.sky);

        this.hemi = new THREE.HemisphereLight(0xffffff, 0x888888, 1);
        scene.add(this.hemi);
        this.sun = new THREE.DirectionalLight(0xffffff, 2);
        this.sun.name = 'sun';
        scene.add(this.sun);
        scene.add(this.sun.target);
        this.focus = new THREE.Vector3(768, 0, 768);
        scene.fog = new THREE.Fog(0xffffff, 300, 3000);
        this.setQuality(quality);
        this.setMood('day');
    }

    setQuality(q) {
        this.quality = q;
        const s = this.sun;
        const on = q !== 'low';
        s.castShadow = on;
        if (on) {
            const size = q === 'high' ? 2048 : 1024;
            const half = q === 'high' ? 70 : 55;
            s.shadow.mapSize.set(size, size);
            const c = s.shadow.camera;
            c.left = -half; c.right = half; c.top = half; c.bottom = -half;
            c.near = 10; c.far = 600;
            c.updateProjectionMatrix();
            s.shadow.bias = -0.0004;
            s.shadow.normalBias = 0.04;
            s.shadow.radius = 2;
            if (s.shadow.map) {
                s.shadow.map.dispose();
                s.shadow.map = null;
            }
        }
    }

    setMood(mood) {
        if (!MOODS[mood]) mood = 'day';
        const same = mood === this.mood && this.envMap;
        this.mood = mood;
        const p = this.preset = MOODS[mood];
        const u = this.uniforms;
        u.uTop.value.set(...rgbOf(p.top));
        u.uMid.value.set(...rgbOf(p.mid));
        u.uHorizon.value.set(...rgbOf(p.horizon));
        u.uBelow.value.set(...rgbOf(p.below));
        u.uSunColor.value.set(...rgbOf(p.sunColor));
        const sd = new THREE.Vector3(...p.sunDir).normalize();
        u.uSunDir.value.copy(sd);
        u.uMoonDir.value.copy(sd);
        u.uSunDisc.value = p.sunDisc;
        u.uSunGlow.value = p.sunGlow;
        u.uStars.value = p.stars;
        u.uAurora.value = p.aurora;
        u.uMoon.value = p.moon;
        u.uClouds.value = p.clouds;
        this.sunDir = sd;
        this.sun.color.setHex(p.sunColor);
        this.sun.intensity = p.sunIntensity;
        this.hemi.color.setHex(p.hemiSky);
        this.hemi.groundColor.setHex(p.hemiGround);
        this.hemi.intensity = p.hemiIntensity;
        this.scene.fog.color.setHex(p.fog[0]);
        this.scene.fog.near = p.fog[1];
        this.scene.fog.far = p.fog[2];
        this.renderer.toneMappingExposure = p.exposure;
        // The prefiltered reflection map only depends on the mood (editor rebuilds skip it).
        if (!same) this._buildEnvMap();
    }

    /** Reflection map for ice and paint: the sky dome (plus a white ground) prefiltered. */
    _buildEnvMap() {
        const pm = new THREE.PMREMGenerator(this.renderer);
        const s = new THREE.Scene();
        const sky = new THREE.Mesh(new THREE.SphereGeometry(100, 32, 16), this.sky.material.clone());
        sky.material.uniforms = this.uniforms;
        s.add(sky);
        const p = this.preset;
        const ground = new THREE.Mesh(new THREE.CircleGeometry(100, 24), new THREE.MeshBasicMaterial({ color: new THREE.Color(p.below).lerp(new THREE.Color(0xffffff), 0.35), side: THREE.DoubleSide }));
        ground.rotation.x = -Math.PI / 2;
        ground.position.y = -6;
        s.add(ground);
        const rt = pm.fromScene(s, 0, 0.1, 400);
        sky.geometry.dispose();
        sky.material.dispose();
        ground.geometry.dispose();
        ground.material.dispose();
        pm.dispose();
        const old = this._envRT;
        this._envRT = rt;
        this.envMap = rt.texture;
        if (this.onEnvMap) this.onEnvMap(this.envMap);
        if (old) old.dispose();
    }

    /** Each frame: animate the sky, keep it centred on the camera, shadows on the focus. */
    update(dt, camera, focus) {
        this.time += dt;
        this.uniforms.uTime.value = this.time;
        this.sky.position.copy(camera.position);
        if (focus) this.focus.copy(focus);
        const f = this.focus;
        const d = this.sunDir;
        // Snap the shadow camera to texels so shadows do not shimmer while driving.
        const c = this.sun.shadow.camera;
        const texel = (c.right - c.left) / this.sun.shadow.mapSize.x;
        const fx = Math.round(f.x / texel) * texel, fz = Math.round(f.z / texel) * texel;
        this.sun.position.set(fx + d.x * 250, f.y + d.y * 250, fz + d.z * 250);
        this.sun.target.position.set(fx, f.y, fz);
        this.sun.target.updateMatrixWorld();
    }

    dispose() {
        this.scene.remove(this.sky, this.hemi, this.sun, this.sun.target);
        this.sky.geometry.dispose();
        this.sky.material.dispose();
        if (this._envRT) this._envRT.dispose();
        this.sun.shadow.map?.dispose();
    }
}

