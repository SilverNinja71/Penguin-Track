// GameRenderer: the Three.js view of a Penguintrack world (contract in
// docs/ARCHITECTURE.md, details in docs/RENDER.md). It never touches the
// simulation; callers feed it car snapshots and sim events.
import * as THREE from 'three';
import { snapshotCar, lerpCarSnapshot } from '../core/replay.js';
import { buildTrackMeshes } from './trackmesh.js';
import { Environment, MOODS } from './environment.js';
import { CameraRig, CAMERA_MODES } from './cameras.js';
import { buildCarModel } from './carmodel.js';
import { Scenery } from './scenery.js';
import { Effects } from './effects.js';
import { setMaxAnisotropy, labelTexture } from './textures.js';

export { snapshotCar, lerpCarSnapshot, CAMERA_MODES };
export const QUALITIES = ['low', 'medium', 'high'];

const TELEPORT_DIST2 = 12 * 12;   // a car never moves 12 m in one tick (1000 km/h = 2.8 m)
const CAR_COLORS = { player: 0xd61f2c, ai: 0x3f8ff0, remote: 0x4fd18a, ghost: 0xcfeaff };

/** One drawn car. Created by GameRenderer.addCar. */
class CarHandle {
    constructor(renderer, opts) {
        this.renderer = renderer;
        this.kind = opts.kind || 'player';
        this.color = opts.color ?? CAR_COLORS[this.kind] ?? CAR_COLORS.player;
        this.model = buildCarModel({ kind: this.kind, color: this.color, envMap: renderer.env.envMap });
        this.object = this.model.root;
        this.view = null;            // interpolated snapshot drawn this frame
        this.visible = true;
        this._lerp = null;
        this.teleportSerial = 0;     // bumps on every jump; cameras snap when it changes
        this._lastCurr = null;
        if (opts.label) this.setLabel(opts.label);
        const shadows = renderer.quality !== 'low' && this.kind !== 'ghost';
        this.object.traverse((o) => { if (o.isMesh && !shadows) o.castShadow = false; });
    }

    /**
     * Draw the car between two snapshots (alpha 0 = prev, 1 = curr). Pass one
     * view (or prev = null) to draw it as is: ghostPoseAt poses work too.
     */
    setPose(prev, curr, alpha = 1) {
        if (curr === undefined) {
            curr = prev;
            prev = null;
        }
        if (!curr) return;
        let view = curr;
        const last = this._lastCurr;
        const fresh = !last || last[0] !== curr.pos[0] || last[1] !== curr.pos[1] || last[2] !== curr.pos[2];
        const jump = prev && prev !== curr && dist2(prev.pos, curr.pos) > TELEPORT_DIST2;
        if (prev && prev !== curr && !jump && prev.wheels && curr.wheels && prev.vel && curr.vel) {
            this._lerp = lerpCarSnapshot(prev, curr, alpha, this._lerp);
            view = this._lerp;
        }
        if (fresh) {
            if (jump || (last && dist2(last, curr.pos) > TELEPORT_DIST2)) this.teleported();
            const lc = this._lastCurr || (this._lastCurr = [0, 0, 0]);
            lc[0] = curr.pos[0]; lc[1] = curr.pos[1]; lc[2] = curr.pos[2];
        }
        this.view = view;
        this.object.position.set(view.pos[0], view.pos[1], view.pos[2]);
        this.object.quaternion.set(view.quat[0], view.quat[1], view.quat[2], view.quat[3]);
    }

    /** Marks a jump (respawn): cameras snap and trails restart instead of streaking across the map. */
    teleported() {
        this.teleportSerial++;
        this.renderer.effects?.carTeleported(this);
    }

    setVisible(v) {
        this.visible = !!v;
        this.object.visible = this.visible;
    }

    setColor(c) {
        this.color = c;
        this.model.setColor(c);
    }

    setLabel(text, color) {
        this.model.setLabel(text, text ? labelTexture(String(text), color) : null);
    }

    setCockpit(on) {
        this.model.setCockpit(on);
    }

    _frame(dt) {
        this.model.update(this.view, dt);
    }

    dispose() {
        this.model.dispose();
    }
}

function dist2(a, b) {
    const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
    return dx * dx + dy * dy + dz * dz;
}

export class GameRenderer {
    /**
     * @param {HTMLCanvasElement} canvas
     * @param {{ quality?: 'low'|'medium'|'high', reducedMotion?: boolean, preserveDrawingBuffer?: boolean, pixelRatio?: number }} opts
     */
    constructor(canvas, opts = {}) {
        this.canvas = canvas;
        this.opts = opts;
        this.quality = QUALITIES.includes(opts.quality) ? opts.quality : 'medium';
        this.reducedMotion = !!opts.reducedMotion;
        this.three = THREE;
        this.webgl = new THREE.WebGLRenderer({
            canvas, antialias: this.quality !== 'low', powerPreference: 'high-performance',
            preserveDrawingBuffer: !!opts.preserveDrawingBuffer, stencil: false,
        });
        const gl = this.webgl;
        gl.outputColorSpace = THREE.SRGBColorSpace;
        gl.toneMapping = THREE.NeutralToneMapping;
        gl.shadowMap.enabled = this.quality !== 'low';
        gl.shadowMap.type = THREE.PCFShadowMap;
        gl.info.autoReset = false;
        setMaxAnisotropy(this.quality === 'low' ? 2 : Math.min(this.quality === 'high' ? 16 : 8, gl.capabilities.getMaxAnisotropy()));

        this.scene = new THREE.Scene();
        this.scene.name = 'penguintrack';
        this.camera = new THREE.PerspectiveCamera(70, 1, 0.2, 9000);
        this.env = new Environment(gl, this.scene, this.quality);
        this.env.onEnvMap = (tex) => this._applyEnvMap(tex);
        this.cameraControls = new CameraRig(this.camera, canvas, { reducedMotion: this.reducedMotion });
        this.rigs = [this.cameraControls];
        this.effects = new Effects(this);
        this.scenery = null;
        this.track = null;
        this.world = null;
        this.cars = [];
        this.viewports = null;
        this.time = 0;
        this._stats = { drawCalls: 0, triangles: 0, points: 0, lines: 0, geometries: 0, textures: 0, frameMs: 0, fps: 0 };
        this._fpsAcc = 0;
        this._fpsFrames = 0;
        this._raycaster = new THREE.Raycaster();
        this.resize();
    }

    /** Copies what the renderer reads from a live sim.car (its arrays are reused every tick). */
    snapshotCar(car, out) {
        return snapshotCar(car, out);
    }

    get mood() {
        return this.env.mood;
    }

    // -----------------------------------------------------------------------
    // World

    /**
     * Builds track meshes, props, scenery, sky and lights for track.mood.
     * opts.scenery = false skips the automatic scatter (trees, crowds, night lamps)
     * for quick editor rebuilds; decor, gates, pillars and the landscape stay.
     */
    loadWorld(world, track = world?.track, opts = {}) {
        this.clearWorld();
        if (!world) return;
        this.world = world;
        this.trackData = track || world.track;
        this.loadOpts = opts;
        this.track = buildTrackMeshes(world, this.env, this.quality);
        this.scene.add(this.track.group);
        this.scenery = new Scenery(this, world, this.quality, { auto: opts.scenery !== false });
        this.scene.add(this.scenery.group);
        this.setMood(this.trackData?.mood || world.track?.mood || 'day');
        // Start the cameras somewhere sensible (behind the spawn) before any car exists.
        const sp = world.spawn;
        if (sp) {
            const d = [[0, 0, 1], [-1, 0, 0], [0, 0, -1], [1, 0, 0]][sp.dir];
            this.camera.position.set(sp.pos[0] - d[0] * 10, sp.pos[1] + 4, sp.pos[2] - d[2] * 10);
            this.camera.lookAt(sp.pos[0] + d[0] * 10, sp.pos[1] + 1, sp.pos[2] + d[2] * 10);
            this.cameraControls.orbit.target.set(sp.pos[0], sp.pos[1], sp.pos[2]);
            this.env.focus.set(sp.pos[0], sp.pos[1], sp.pos[2]);
        }
        const b = world.bounds;
        if (b) this.cameraControls.setTop({ center: [(b.min[0] + b.max[0]) / 2, b.min[1], (b.min[2] + b.max[2]) / 2], height: Math.max(200, Math.max(b.max[0] - b.min[0], b.max[2] - b.min[2]) * 1.1) });
        this.effects.reset();
    }

    clearWorld() {
        if (this.track) {
            this.scene.remove(this.track.group);
            this.track.dispose();
            this.track = null;
        }
        if (this.scenery) {
            this.scene.remove(this.scenery.group);
            this.scenery.dispose();
            this.scenery = null;
        }
        this.world = null;
        this.effects.reset();
    }

    setMood(mood) {
        if (!MOODS[mood]) mood = 'day';
        this.env.setMood(mood);
        const p = this.env.preset;
        this.track?.setGlow(p.roadGlow);
        this.scenery?.setMood(mood, p);
        for (const c of this.cars) c.model.setHeadlights(c.kind === 'ghost' ? 0 : p.headlights);
        this.effects.setMood(mood, p);
    }

    setQuality(q) {
        if (!QUALITIES.includes(q) || q === this.quality) return;
        this.quality = q;
        this.webgl.shadowMap.enabled = q !== 'low';
        this.env.setQuality(q);
        setMaxAnisotropy(q === 'low' ? 2 : Math.min(q === 'high' ? 16 : 8, this.webgl.capabilities.getMaxAnisotropy()));
        this.resize();
        this.effects.setQuality(q);
        // Shadow flags and scenery density depend on quality: rebuild the world.
        if (this.world) this.loadWorld(this.world, this.trackData, this.loadOpts);
        for (const c of this.cars) c.object.traverse((o) => { if (o.isMesh) o.castShadow = q !== 'low' && c.kind !== 'ghost' && !o.material.transparent; });
        // Material programs change with shadows on/off.
        this.scene.traverse((o) => { if (o.material) for (const m of [].concat(o.material)) m.needsUpdate = true; });
    }

    setReducedMotion(on) {
        this.reducedMotion = !!on;
        for (const r of this.rigs) r.reducedMotion = this.reducedMotion;
        this.effects.reducedMotion = this.reducedMotion;
    }

    _applyEnvMap(tex) {
        const apply = (m) => {
            if (m && 'envMap' in m && m.userData.noEnv !== true) {
                m.envMap = tex;
                m.needsUpdate = true;
            }
        };
        this.track?.materials.forEach(apply);
        this.scenery?.materials.forEach(apply);
        for (const c of this.cars) Object.values(c.model.mats).forEach(apply);
    }

    // -----------------------------------------------------------------------
    // Cars

    /** opts: { kind: 'player'|'ghost'|'ai'|'remote', color, label } → handle. */
    addCar(opts = {}) {
        const h = new CarHandle(this, opts);
        h.model.setHeadlights(h.kind === 'ghost' ? 0 : this.env.preset.headlights);
        this.scene.add(h.object);
        this.cars.push(h);
        if (h.kind === 'player' && this.effects.headlightCar == null) this.effects.attachHeadlight(h);
        return h;
    }

    removeCar(h) {
        const i = this.cars.indexOf(h);
        if (i < 0) return;
        this.cars.splice(i, 1);
        this.scene.remove(h.object);
        this.effects.carRemoved(h);
        for (const r of this.rigs) {
            if (r.target === h) r.target = null;
            if (r._lastCockpit === h) r._lastCockpit = null;
        }
        h.dispose();
    }

    // -----------------------------------------------------------------------
    // Cameras and viewports

    setCameraMode(mode, targetCar, camera) {
        const rig = camera ? this._rigOf(camera) : this.cameraControls;
        if (!rig) return;
        rig.setMode(mode, targetCar === undefined ? rig.target : targetCar);
    }

    get cameraMode() {
        return this.cameraControls.mode;
    }

    /** Extra camera with its own rig (split-screen). */
    createCamera(mode = 'chase', targetCar = null) {
        const cam = new THREE.PerspectiveCamera(70, 1, 0.2, 9000);
        const rig = new CameraRig(cam, null, { reducedMotion: this.reducedMotion });
        rig.setMode(mode, targetCar);
        cam.userData.rig = rig;
        this.rigs.push(rig);
        return cam;
    }

    removeCamera(cam) {
        const rig = this._rigOf(cam);
        if (!rig || rig === this.cameraControls) return;
        rig.dispose();
        this.rigs.splice(this.rigs.indexOf(rig), 1);
        if (this.viewports) this.viewports = this.viewports.filter((v) => v.camera !== cam);
    }

    _rigOf(cam) {
        if (cam === this.camera) return this.cameraControls;
        return cam?.userData?.rig || null;
    }

    /**
     * Split-screen. rects: [{ x, y, w, h, camera }] normalised 0..1 from the
     * top-left corner of the canvas; null or [] restores one full view.
     */
    setViewports(rects) {
        this.viewports = rects && rects.length ? rects.map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h, camera: r.camera || this.camera, before: typeof r.before === 'function' ? r.before : null })) : null;
    }

    // -----------------------------------------------------------------------
    // Events and effects

    /** Sim events of one car: particles, rings, shake. */
    handleEvents(events, car) {
        if (!events || !events.length) return;
        for (const e of events) {
            this.effects.event(e, car);
            if (e.type === 'land' && car) {
                for (const r of this.rigs) if (r.target === car) r.addShake(Math.min(1, (e.strength || 0) / 22));
            } else if (e.type === 'wallhit' && car) {
                for (const r of this.rigs) if (r.target === car) r.addShake(Math.min(0.7, (e.intensity || 0) / 30));
            } else if (e.type === 'respawn' && car) {
                car.teleported();
            }
        }
    }

    /** Quick TAS savestate flags on the track: [{ pos, quat, current }]; null or [] hides them. */
    setTasMarkers(list) {
        this.effects.setMarkers(list);
    }

    /**
     * Clears particles, skid marks, trails and flashes left by the last moments
     * (a savestate rewind) without rebuilding anything.
     */
    resetEffects() {
        this.effects.clearTransient();
    }

    /** Start-gate countdown lights: 3, 2, 1 (red), 0 (green, GO) or null (idle). */
    setCountdown(n) {
        this.scenery?.setCountdown(n);
    }

    // -----------------------------------------------------------------------
    // Frame

    /** Advances cars, cameras, sky and effects by dt seconds without drawing. */
    update(dt = 1 / 60) {
        dt = Math.max(0, Math.min(dt, 0.25));
        this.time += dt;
        for (const c of this.cars) c._frame(dt);
        let focusCar = this.cameraControls.target;
        if (!focusCar) for (const c of this.cars) if (c.kind === 'player') { focusCar = c; break; }
        focusCar = focusCar || this.cars[0];
        const focus = focusCar && focusCar.view ? focusCar.object.position : null;
        this.track?.update(dt);
        this.scenery?.update(dt, this.camera);
        const size = this.webgl.getSize(this._size || (this._size = new THREE.Vector2()));
        const vps = this._vps();
        // Rigs update once per frame even if their camera is not in a viewport.
        for (const r of this.rigs) {
            let vp = null;
            for (const v of vps) if (v.camera === r.camera) { vp = v; break; }
            const aspect = vp ? (vp.w * size.x) / Math.max(1, vp.h * size.y) : size.x / Math.max(1, size.y);
            r.update(dt, aspect);
        }
        this.env.update(dt, vps[0].camera, focus);
        this.effects.update(dt, vps[0].camera);
    }

    _vps() {
        return this.viewports || this._fullView || (this._fullView = [{ x: 0, y: 0, w: 1, h: 1, camera: this.camera }]);
    }

    /** Call once per animation frame: update(dt), then draw every viewport. */
    render(dt = 1 / 60) {
        const t0 = performance.now();
        this.update(dt);
        const gl = this.webgl;
        gl.info.reset();
        const size = this._size;
        const vps = this._vps();
        if (vps.length === 1 && vps[0].x === 0 && vps[0].y === 0 && vps[0].w === 1 && vps[0].h === 1) {
            gl.setScissorTest(false);
            gl.setViewport(0, 0, size.x, size.y);
            this._renderView(vps[0].camera, 1);
        } else {
            gl.setScissorTest(true);
            for (const v of vps) {
                const x = Math.round(v.x * size.x), w = Math.round(v.w * size.x);
                const h = Math.round(v.h * size.y), y = Math.round((1 - v.y - v.h) * size.y);
                gl.setViewport(x, y, w, h);
                gl.setScissor(x, y, w, h);
                if (v.before) v.before(v);   // per-view tweaks, e.g. split-screen shows the other player as a ghost
                this._renderView(v.camera, v.h);
            }
            gl.setScissorTest(false);
        }
        const info = gl.info;
        const s = this._stats;
        s.drawCalls = info.render.calls;
        s.triangles = info.render.triangles;
        s.points = info.render.points;
        s.lines = info.render.lines;
        s.geometries = info.memory.geometries;
        s.textures = info.memory.textures;
        s.frameMs = performance.now() - t0;
        this._fpsAcc += Math.max(0, Math.min(dt, 0.25));
        this._fpsFrames++;
        if (this._fpsAcc >= 0.5) {
            s.fps = this._fpsFrames / this._fpsAcc;
            this._fpsAcc = 0;
            this._fpsFrames = 0;
        }
    }

    _renderView(camera, hFrac) {
        // The sky follows whichever camera is drawing.
        this.env.sky.position.copy(camera.position);
        const h = this.webgl.getDrawingBufferSize(this._dbs || (this._dbs = new THREE.Vector2())).y * hFrac;
        this.effects.beforeRender(camera, h);
        this.scenery?.beforeRender(camera, h);
        this.webgl.render(this.scene, camera);
    }

    /** Last frame: { drawCalls, triangles, points, lines, geometries, textures, frameMs, fps }. */
    stats() {
        return { ...this._stats, cars: this.cars.length, quality: this.quality, mood: this.env.mood, camera: this.cameraControls.mode };
    }

    resize() {
        const c = this.canvas;
        const w = Math.max(1, c.clientWidth || c.width || 1), h = Math.max(1, c.clientHeight || c.height || 1);
        const pr = this.opts.pixelRatio ?? (this.quality === 'low' ? 1 : Math.min(this.quality === 'high' ? 2 : 1.25, window.devicePixelRatio || 1));
        this.webgl.setPixelRatio(pr);
        this.webgl.setSize(w, h, false);
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
    }

    // -----------------------------------------------------------------------
    // Editor helpers

    /** World ray under a screen point: { origin:[3], dir:[3] (unit) } or null outside the canvas. */
    screenRay(clientX, clientY) {
        const rect = this.canvas.getBoundingClientRect();
        let nx = (clientX - rect.left) / rect.width, ny = (clientY - rect.top) / rect.height;
        if (nx < 0 || ny < 0 || nx > 1 || ny > 1) return null;
        let camera = this.camera;
        if (this.viewports) {
            const v = this.viewports.find((r) => nx >= r.x && nx <= r.x + r.w && ny >= r.y && ny <= r.y + r.h);
            if (!v) return null;
            camera = v.camera;
            nx = (nx - v.x) / v.w;
            ny = (ny - v.y) / v.h;
        }
        camera.updateMatrixWorld();
        this._raycaster.setFromCamera(new THREE.Vector2(nx * 2 - 1, 1 - ny * 2), camera);
        const r = this._raycaster.ray;
        return { origin: [r.origin.x, r.origin.y, r.origin.z], dir: [r.direction.x, r.direction.y, r.direction.z] };
    }

    /**
     * Track (or ground) under a screen point via world.collision.raycast:
     * { point, normal, blockIndex (-1 = ground), surface, distance } or null.
     */
    pick(clientX, clientY, maxDist = 6000) {
        if (!this.world) return null;
        const ray = this.screenRay(clientX, clientY);
        if (!ray) return null;
        const hit = this.world.collision.raycast(ray.origin, ray.dir, maxDist);
        if (!hit) return null;
        const tb = this.world.collision.triBlock;
        return {
            point: hit.point.slice(), normal: hit.normal.slice(),
            blockIndex: hit.tri >= 0 && tb ? tb[hit.tri] : -1,
            surface: hit.surfaceId, distance: hit.t,
        };
    }

    /** Highlights one block, several (array) or none (null) using the render mesh ranges. */
    setTrackHighlight(blockIndex, color) {
        this.track?.setHighlight(blockIndex, color);
    }

    dispose() {
        this.clearWorld();
        for (const c of this.cars.slice()) this.removeCar(c);
        for (const r of this.rigs) r.dispose();
        this.effects.dispose();
        this.env.dispose();
        this.webgl.dispose();
    }
}
