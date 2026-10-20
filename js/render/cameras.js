// Camera rigs: chase (TM cam 1), close, cockpit, free fly, orbit and top.
// A rig drives one PerspectiveCamera. Follow cams smooth their *direction*
// rather than their position, so the camera never falls behind at 290 km/h,
// and they snap (no swoop) when the target car teleports on a respawn.
import * as THREE from 'three';

export const CAMERA_MODES = ['chase', 'close', 'cockpit', 'free', 'orbit', 'top'];

const FOLLOW = {
    chase: { dist: 6.3, height: 2.35, look: 1.05, ahead: 4.5, fov: 70, speedDist: 0.012, stiff: 7 },
    close: { dist: 4.3, height: 1.5, look: 0.9, ahead: 6, fov: 74, speedDist: 0.006, stiff: 10 },
};
const UP = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3(), _w = new THREE.Vector3();
const _upT = new THREE.Vector3(), _dirT = new THREE.Vector3(), _vel = new THREE.Vector3();   // per-frame scratch

function damp(k, dt) {
    return 1 - Math.exp(-k * dt);
}

export class CameraRig {
    constructor(camera, dom, opts = {}) {
        this.camera = camera;
        this.dom = dom;
        this.mode = 'chase';
        this.target = null;            // car handle
        this.enabled = true;           // false: the rig never moves the camera
        this.reducedMotion = !!opts.reducedMotion;
        this.fovBase = 70;
        this.speed = 40;               // free fly m/s (shift = ×4)
        this.shake = 0;
        this._shakeT = 0;
        // Follow state
        this._dir = new THREE.Vector3(0, 0, 1);
        this._up = new THREE.Vector3(0, 1, 0);
        this._pos = new THREE.Vector3();
        this._look = new THREE.Vector3();
        this._snap = true;
        this._fov = 70;
        // Free / orbit / top state
        this.free = { pos: new THREE.Vector3(0, 40, 0), yaw: 0, pitch: -0.3 };
        this.orbit = { target: new THREE.Vector3(), dist: 40, yaw: 0.8, pitch: 0.45, followCar: true };
        this.top = { center: new THREE.Vector3(768, 0, 768), height: 400 };
        this._keys = new Set();
        this._drag = null;
        this._listening = false;
        this._onKeyDown = (e) => {
            if (this.mode !== 'free' || e.target?.closest?.('input, textarea, select, [contenteditable]')) return;
            this._keys.add(e.code);
        };
        this._onKeyUp = (e) => this._keys.delete(e.code);
        this._onBlur = () => this._keys.clear();
        this._onPointerDown = (e) => this._pointerDown(e);
        this._onPointerMove = (e) => this._pointerMove(e);
        this._onPointerUp = () => { this._drag = null; };
        this._onWheel = (e) => this._wheel(e);
        this._onContext = (e) => { if (this._interactive()) e.preventDefault(); };
    }

    _interactive() {
        return this.enabled && (this.mode === 'free' || this.mode === 'orbit' || this.mode === 'top');
    }

    /** Switch mode; target is a car handle (follow cams, orbit) or null. */
    setMode(mode, target) {
        if (!CAMERA_MODES.includes(mode)) mode = 'chase';
        const prev = this.mode;
        if (target !== undefined) this.target = target;
        if (mode === 'free' && prev !== 'free') {
            // Start flying from wherever the camera is now.
            this.free.pos.copy(this.camera.position);
            const d = this.camera.getWorldDirection(_v);
            this.free.yaw = Math.atan2(d.x, d.z);
            this.free.pitch = Math.asin(Math.max(-1, Math.min(1, d.y)));
        }
        if (mode === 'orbit' && prev !== 'orbit' && this.target) {
            this.orbit.followCar = true;
            const d = this.camera.getWorldDirection(_v);
            this.orbit.yaw = Math.atan2(-d.x, -d.z);
        }
        this.mode = mode;
        this._snap = true;
        this._attach(this._interactive());
        // Only the car we sit in hides its driver.
        const inside = mode === 'cockpit' ? this.target : null;
        if (this._lastCockpit && this._lastCockpit !== inside) this._lastCockpit.setCockpit?.(false);
        if (inside) inside.setCockpit?.(true);
        this._lastCockpit = inside;
    }

    /** Orbit around a point (editor) or the target car when point is omitted. */
    setOrbit({ target, distance, yaw, pitch } = {}) {
        if (target) {
            this.orbit.target.set(target[0], target[1], target[2]);
            this.orbit.followCar = false;
        }
        if (distance != null) this.orbit.dist = distance;
        if (yaw != null) this.orbit.yaw = yaw;
        if (pitch != null) this.orbit.pitch = pitch;
    }

    setFree({ position, yaw, pitch } = {}) {
        if (position) this.free.pos.set(position[0], position[1], position[2]);
        if (yaw != null) this.free.yaw = yaw;
        if (pitch != null) this.free.pitch = pitch;
    }

    setTop({ center, height } = {}) {
        if (center) this.top.center.set(center[0], center.length > 2 ? center[1] : 0, center.length > 2 ? center[2] : center[1]);
        if (height != null) this.top.height = height;
    }

    /** Jump to the desired pose next update (no smoothing). */
    snap() {
        this._snap = true;
    }

    addShake(amount) {
        if (this.reducedMotion) return;
        this.shake = Math.min(1, this.shake + amount);
    }

    _attach(on) {
        if (on === this._listening || !this.dom) return;
        this._listening = on;
        const d = this.dom;
        const fn = on ? 'addEventListener' : 'removeEventListener';
        d[fn]('pointerdown', this._onPointerDown);
        window[fn]('pointermove', this._onPointerMove);
        window[fn]('pointerup', this._onPointerUp);
        d[fn]('wheel', this._onWheel, { passive: false });
        d[fn]('contextmenu', this._onContext);
        window[fn]('keydown', this._onKeyDown);
        window[fn]('keyup', this._onKeyUp);
        window[fn]('blur', this._onBlur);
        if (!on) {
            this._keys.clear();
            this._drag = null;
        }
    }

    _pointerDown(e) {
        if (!this._interactive()) return;
        // Free: right-drag looks. Orbit: left orbits, right pans. Top: right/middle pans.
        if (this.mode === 'free' && e.button !== 2) return;
        if (this.mode === 'top' && e.button === 0) return;
        this._drag = { x: e.clientX, y: e.clientY, button: e.button, shift: e.shiftKey };
    }

    _pointerMove(e) {
        const g = this._drag;
        if (!g || !this._interactive()) return;
        const dx = e.clientX - g.x, dy = e.clientY - g.y;
        g.x = e.clientX;
        g.y = e.clientY;
        if (this.mode === 'free') {
            this.free.yaw -= dx * 0.004;
            this.free.pitch = Math.max(-1.5, Math.min(1.5, this.free.pitch - dy * 0.004));
        } else if (this.mode === 'orbit') {
            if (g.button === 0 && !g.shift) {
                this.orbit.yaw -= dx * 0.006;
                this.orbit.pitch = Math.max(-0.2, Math.min(1.53, this.orbit.pitch + dy * 0.006));
            } else {
                this._pan(this.orbit.target, dx, dy, this.orbit.dist / 700);
                this.orbit.followCar = false;
            }
        } else if (this.mode === 'top') {
            const s = this.top.height / 600;
            this.top.center.x -= dx * s;
            this.top.center.z -= dy * s;
        }
    }

    _pan(target, dx, dy, s) {
        const right = _v.setFromMatrixColumn(this.camera.matrixWorld, 0);
        right.y = 0;
        right.normalize();
        const fwd = _w.set(-right.z, 0, right.x);
        target.addScaledVector(right, -dx * s).addScaledVector(fwd, dy * s);
    }

    _wheel(e) {
        if (!this._interactive()) return;
        e.preventDefault();
        const k = Math.exp(e.deltaY * 0.001);
        if (this.mode === 'orbit') this.orbit.dist = Math.max(4, Math.min(3000, this.orbit.dist * k));
        else if (this.mode === 'top') this.top.height = Math.max(30, Math.min(4000, this.top.height * k));
        else if (this.mode === 'free') this.speed = Math.max(5, Math.min(600, this.speed / k));
    }

    /** Advance the camera. aspect: viewport aspect ratio. */
    update(dt, aspect) {
        const cam = this.camera;
        if (aspect && Math.abs(cam.aspect - aspect) > 1e-6) {
            cam.aspect = aspect;
            cam.updateProjectionMatrix();
        }
        if (!this.enabled) return;
        dt = Math.min(dt, 0.1);
        const t = this.target;
        if (t && t.teleportSerial !== this._seenSerial) {
            this._seenSerial = t.teleportSerial;
            this._snap = true;
        }
        let fov = this.fovBase;
        switch (this.mode) {
            case 'chase':
            case 'close':
                if (t) fov = this._follow(dt, FOLLOW[this.mode], t);
                break;
            case 'cockpit':
                if (t) fov = this._cockpit(dt, t);
                break;
            case 'free':
                this._freeUpdate(dt);
                break;
            case 'orbit':
                this._orbitUpdate(dt, t);
                break;
            case 'top':
                cam.up.set(0, 0, -1);
                cam.position.set(this.top.center.x, this.top.center.y + this.top.height, this.top.center.z + 0.001);
                cam.lookAt(this.top.center);
                fov = 50;
                break;
        }
        // Landing shake: a short decaying wobble (off with reduced motion).
        if (this.shake > 0.001 && (this.mode === 'chase' || this.mode === 'close' || this.mode === 'cockpit')) {
            this._shakeT += dt;
            const a = this.shake * this.shake * 0.35;
            cam.position.x += Math.sin(this._shakeT * 71) * a;
            cam.position.y += Math.sin(this._shakeT * 89 + 1.3) * a;
            cam.position.z += Math.sin(this._shakeT * 63 + 2.1) * a * 0.6;
        }
        this.shake *= Math.exp(-dt * 6);
        if (this._snap) this._fov = fov;
        this._fov += (fov - this._fov) * damp(4, dt);
        if (Math.abs(cam.fov - this._fov) > 0.01) {
            cam.fov = this._fov;
            cam.updateProjectionMatrix();
        }
        this._snap = false;
    }

    _follow(dt, p, car) {
        const cam = this.camera;
        const v = car.view;
        const pos = car.object.position;
        // Car axes.
        const q = car.object.quaternion;
        const fwd = _v.set(0, 0, 1).applyQuaternion(q);
        const carUp = _w.set(0, 1, 0).applyQuaternion(q);
        // Upright on flat roads and gentle banks; follows the car through loops.
        const tilt = 1 - carUp.dot(UP);
        const follow = THREE.MathUtils.smoothstep(tilt, 0.25, 0.75);
        const upT = _upT.copy(UP).lerp(carUp, follow).normalize();
        // Heading: mostly where the car points, partly where it goes (drifts, slides).
        const dirT = _dirT.copy(fwd);
        const speed = v ? Math.hypot(v.vel[0], v.vel[1], v.vel[2]) : 0;
        if (v && speed > 4 && !v.airborne) {
            const vel = _vel.set(v.vel[0], v.vel[1], v.vel[2]).divideScalar(speed);
            if (vel.dot(fwd) > 0) dirT.multiplyScalar(0.55).addScaledVector(vel, 0.45);
        }
        dirT.addScaledVector(upT, -dirT.dot(upT)).normalize();
        if (dirT.lengthSq() < 1e-6) dirT.copy(this._dir);
        if (this._snap) {
            this._dir.copy(dirT);
            this._up.copy(upT);
        } else {
            this._dir.lerp(dirT, damp(p.stiff, dt)).normalize();
            this._up.lerp(upT, damp(4, dt)).normalize();
        }
        const dist = p.dist + Math.min(speed, 110) * p.speedDist;
        cam.position.copy(pos).addScaledVector(this._dir, -dist).addScaledVector(this._up, p.height);
        this._look.copy(pos).addScaledVector(this._up, p.look).addScaledVector(this._dir, p.ahead);
        cam.up.copy(this._up);
        cam.lookAt(this._look);
        // Speed sensation: the field of view opens up with speed.
        const kmh = v ? v.speedKmh : 0;
        const boost = v?.effects?.turbo ? 4 : 0;
        return p.fov + (this.reducedMotion ? 0 : Math.min(15, Math.max(0, kmh - 60) * 0.065) + boost);
    }

    _cockpit(dt, car) {
        const cam = this.camera;
        const o = car.object;
        const eye = _v.set(0, 1.3, -0.3).applyQuaternion(o.quaternion).add(o.position);
        cam.position.copy(eye);
        const fwd = _w.set(0, -0.09, 1).normalize().applyQuaternion(o.quaternion);
        const up = _upT.set(0, 1, 0).applyQuaternion(o.quaternion);
        if (this._snap) this._up.copy(up);
        else this._up.lerp(up, damp(10, dt)).normalize();
        cam.up.copy(this._up);
        this._look.copy(eye).add(fwd);
        cam.lookAt(this._look);
        const kmh = car.view ? car.view.speedKmh : 0;
        return 78 + (this.reducedMotion ? 0 : Math.min(12, Math.max(0, kmh - 60) * 0.05));
    }

    _freeUpdate(dt) {
        const cam = this.camera;
        const f = this.free;
        const k = this._keys;
        const fwd = _v.set(Math.sin(f.yaw) * Math.cos(f.pitch), Math.sin(f.pitch), Math.cos(f.yaw) * Math.cos(f.pitch));
        const right = _w.set(-Math.cos(f.yaw), 0, Math.sin(f.yaw));
        const s = this.speed * (k.has('ShiftLeft') || k.has('ShiftRight') ? 4 : 1) * dt;
        if (k.has('KeyW') || k.has('ArrowUp')) f.pos.addScaledVector(fwd, s);
        if (k.has('KeyS') || k.has('ArrowDown')) f.pos.addScaledVector(fwd, -s);
        if (k.has('KeyD') || k.has('ArrowRight')) f.pos.addScaledVector(right, s);
        if (k.has('KeyA') || k.has('ArrowLeft')) f.pos.addScaledVector(right, -s);
        if (k.has('KeyE') || k.has('Space')) f.pos.y += s;
        if (k.has('KeyQ') || k.has('ControlLeft')) f.pos.y -= s;
        cam.position.copy(f.pos);
        cam.up.set(0, 1, 0);
        this._look.copy(f.pos).add(fwd);
        cam.lookAt(this._look);
    }

    _orbitUpdate(dt, car) {
        const cam = this.camera;
        const o = this.orbit;
        if (o.followCar && car) {
            const p = car.object.position;
            if (this._snap) o.target.copy(p);
            else o.target.lerp(p, damp(12, dt));
        }
        const cp = Math.cos(o.pitch), sp = Math.sin(o.pitch);
        cam.position.set(o.target.x + o.dist * cp * Math.sin(o.yaw), o.target.y + 1 + o.dist * sp, o.target.z + o.dist * cp * Math.cos(o.yaw));
        cam.up.set(0, 1, 0);
        this._look.set(o.target.x, o.target.y + 1, o.target.z);
        cam.lookAt(this._look);
    }

    dispose() {
        this._attach(false);
    }
}

