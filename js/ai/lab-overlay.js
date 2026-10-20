// What the followed driver senses, drawn in the 3D view: its edge rays
// (distance to the road edge, red when close, cyan when clear), optional wall
// rays, and the look-ahead points on the route it reads curvature from.
// Built on the renderer's escape hatches (r.three, r.scene); no core changes.
import { rayAngles } from './env.js';
import { qrotate, dsincos } from '../core/mathd.js';

const MAX_RAYS = 64 + 32;
const MAX_LOOK = 8;
const LIFT = 0.55;   // metres above the car's origin, so rays clear the bonnet

export class PolicyOverlay {
    constructor(renderer) {
        this.r = renderer;
        const THREE = renderer.three;
        this.ok = !!(THREE && renderer.scene);
        this.visible = true;
        if (!this.ok) return;
        this.group = new THREE.Group();
        this.group.name = 'ai-lab-overlay';
        this.group.renderOrder = 20;

        const segs = MAX_RAYS + MAX_LOOK;
        this.pos = new Float32Array(segs * 6);
        this.col = new Float32Array(segs * 6);
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
        geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
        geo.setDrawRange(0, 0);
        this.lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
            vertexColors: true, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false, toneMapped: false,
        }));
        this.lines.frustumCulled = false;
        this.lines.renderOrder = 20;

        this.dotPos = new Float32Array((MAX_RAYS + MAX_LOOK) * 3);
        this.dotCol = new Float32Array((MAX_RAYS + MAX_LOOK) * 3);
        const dg = new THREE.BufferGeometry();
        dg.setAttribute('position', new THREE.BufferAttribute(this.dotPos, 3).setUsage(THREE.DynamicDrawUsage));
        dg.setAttribute('color', new THREE.BufferAttribute(this.dotCol, 3).setUsage(THREE.DynamicDrawUsage));
        dg.setDrawRange(0, 0);
        this.dots = new THREE.Points(dg, new THREE.PointsMaterial({
            size: 7, sizeAttenuation: false, vertexColors: true, transparent: true, depthTest: false, depthWrite: false, toneMapped: false,
        }));
        this.dots.frustumCulled = false;
        this.dots.renderOrder = 21;
        this.group.add(this.lines, this.dots);
        renderer.scene.add(this.group);
        this._fwd = [0, 0, 1];
        this._right = [-1, 0, 0];
        this._sc = [0, 0];
        this._pt = { point: [0, 0, 0], tangent: [0, 0, 1], up: [0, 1, 0], index: 0, s: 0, halfWidth: 0, surface: 0, gap: 0 };
        this._angles = null;
    }

    setVisible(v) {
        this.visible = !!v;
        if (this.ok) this.group.visible = this.visible;
    }

    /**
     * pose: the drawn car view ({ pos, quat }); decision: FieldPlayback.decision;
     * env: that car's PenguinEnv (route, tracker, config).
     */
    update(pose, decision, env) {
        if (!this.ok) return;
        if (!this.visible || !pose || !decision || !env) {
            this.group.visible = false;
            return;
        }
        this.group.visible = true;
        const cfg = env.config.obs;
        const key = `${cfg.edgeRays}/${cfg.collisionRays}/${cfg.fov}`;
        if (this._key !== key) {
            this._key = key;
            this._edge = rayAngles(cfg.edgeRays, cfg.fov);
            this._wall = rayAngles(cfg.collisionRays, cfg.fov);
            this._edgeAt = decision.names.findIndex((n) => n.startsWith('edge@'));
            this._wallAt = decision.names.findIndex((n) => n.startsWith('wall@'));
        }
        const fwd = qrotate(this._fwd, pose.quat, [0, 0, 1]);
        const right = qrotate(this._right, pose.quat, [-1, 0, 0]);
        let hx = fwd[0], hz = fwd[2];
        let hl = Math.sqrt(hx * hx + hz * hz);
        if (hl < 0.2) { hx = 0; hz = 1; hl = 1; }
        hx /= hl; hz /= hl;
        const ox = pose.pos[0], oy = pose.pos[1] + LIFT, oz = pose.pos[2];
        const L = cfg.rayLength;
        let s = 0, d = 0;
        const seg = (x1, y1, z1, x2, y2, z2, c1, c2) => {
            const p = this.pos, c = this.col, k = s * 6;
            p[k] = x1; p[k + 1] = y1; p[k + 2] = z1; p[k + 3] = x2; p[k + 4] = y2; p[k + 5] = z2;
            c[k] = c1[0]; c[k + 1] = c1[1]; c[k + 2] = c1[2]; c[k + 3] = c2[0]; c[k + 4] = c2[1]; c[k + 5] = c2[2];
            s++;
        };
        const dot = (x, y, z, col) => {
            const k = d * 3;
            this.dotPos[k] = x; this.dotPos[k + 1] = y; this.dotPos[k + 2] = z;
            this.dotCol[k] = col[0]; this.dotCol[k + 1] = col[1]; this.dotCol[k + 2] = col[2];
            d++;
        };
        const obs = decision.obs;
        if (this._edgeAt >= 0) {
            for (let i = 0; i < this._edge.length && s < MAX_RAYS; i++) {
                const v = obs[this._edgeAt + i];
                dsincos(this._edge[i], this._sc);
                const dx = this._sc[1] * hx - this._sc[0] * hz, dz = this._sc[1] * hz + this._sc[0] * hx;
                const len = v * L;
                const col = rayColor(v);
                seg(ox, oy, oz, ox + dx * len, oy, oz + dz * len, [col[0] * 0.55, col[1] * 0.55, col[2] * 0.55], col);
                if (v < 0.999) dot(ox + dx * len, oy, oz + dz * len, col);
            }
        }
        if (this._wallAt >= 0) {
            const up = [fwd[1] * right[2] - fwd[2] * right[1], fwd[2] * right[0] - fwd[0] * right[2], fwd[0] * right[1] - fwd[1] * right[0]];
            for (let i = 0; i < this._wall.length && s < MAX_RAYS; i++) {
                const v = obs[this._wallAt + i];
                dsincos(this._wall[i], this._sc);
                const dx = fwd[0] * this._sc[1] + right[0] * this._sc[0];
                const dy = fwd[1] * this._sc[1] + right[1] * this._sc[0];
                const dz = fwd[2] * this._sc[1] + right[2] * this._sc[0];
                const len = v * L;
                const bx = ox - up[0] * (LIFT - 0.3), by = oy - up[1] * (LIFT - 0.3), bz = oz - up[2] * (LIFT - 0.3);
                seg(bx, by, bz, bx + dx * len, by + dy * len, bz + dz * len, WALL_DIM, WALL);
                if (v < 0.999) dot(bx + dx * len, by + dy * len, bz + dz * len, WALL);
            }
        }
        // Look-ahead: the route points the network reads curvature and grip at.
        const la = cfg.lookahead || [];
        const route = env.route, tr = env.tracker, pt = this._pt;
        let px = ox, py = oy, pz = oz;
        for (let i = 0; i < la.length && i < MAX_LOOK; i++) {
            route.pointAt(tr.s + la[i], pt);
            const x = pt.point[0], y = pt.point[1] + 0.8, z = pt.point[2];
            seg(px, py, pz, x, y, z, LOOK, LOOK);
            dot(x, y, z, LOOK);
            px = x; py = y; pz = z;
        }
        this.lines.geometry.attributes.position.needsUpdate = true;
        this.lines.geometry.attributes.color.needsUpdate = true;
        this.lines.geometry.setDrawRange(0, s * 2);
        this.dots.geometry.attributes.position.needsUpdate = true;
        this.dots.geometry.attributes.color.needsUpdate = true;
        this.dots.geometry.setDrawRange(0, d);
    }

    dispose() {
        if (!this.ok) return;
        this.r.scene.remove(this.group);
        this.lines.geometry.dispose();
        this.lines.material.dispose();
        this.dots.geometry.dispose();
        this.dots.material.dispose();
        this.ok = false;
    }
}

const WALL_DIM = [0.55, 0.34, 0.52];
const WALL = [1, 0.62, 0.95];
const LOOK = [1, 0.84, 0.29];

/** Red (edge right there) through amber to ice cyan (clear road). */
function rayColor(v) {
    const t = Math.max(0, Math.min(1, v * 3));
    return t < 0.5
        ? [1, 0.42 + t * 0.9, 0.5 - t * 0.4]
        : [1 - (t - 0.5) * 1.0, 0.87 - (t - 0.5) * 0.1, 0.3 + (t - 0.5) * 1.4];
}
