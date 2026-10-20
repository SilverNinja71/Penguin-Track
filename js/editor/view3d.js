// Editor 3D overlays on the shared GameRenderer: the orbit / top camera around
// a focus point, the map grid at the current layer, the cursor cell, the ghost
// block (green fits, red does not), open-connector arrows and the hover box.
import { blockPreview } from '../core/track.js';
import { BLOCKS, footprintSize } from '../core/blocks.js';
import { CELL, LAYER, MAP_X, MAP_Z } from '../core/constants.js';

const GOOD = 0x6bffb0, BAD = 0xff6b81, ACCENT = 0x7fdcff, LIP = 0xffd54a;
const MAP_W = MAP_X * CELL, MAP_D = MAP_Z * CELL;

export class EditorView {
    constructor(renderer) {
        this.r = renderer;
        const T = this.T = renderer.three;
        this.group = new T.Group();
        this.group.name = 'editor-overlays';
        this.group.renderOrder = 5;
        renderer.scene.add(this.group);
        this._rigWasEnabled = renderer.cameraControls.enabled;
        renderer.cameraControls.enabled = false;   // the editor drives the camera itself

        this.cam = { target: new T.Vector3(24 * CELL, 0, 22 * CELL), yaw: Math.PI * 0.85, pitch: 0.62, dist: 260, top: false };
        this.goal = { target: this.cam.target.clone(), yaw: this.cam.yaw, pitch: this.cam.pitch, dist: this.cam.dist };
        this.time = 0;
        this.layer = 0;
        this._previewCache = new Map();
        this._mats = [];

        this._buildGrid();
        this._buildCursor();
        this._buildGhost();
        this._buildArrows();
        this._buildHover();
        this.setLayer(0);
    }

    _mat(Ctor, opts) {
        const m = new Ctor(opts);
        this._mats.push(m);
        return m;
    }

    // ------------------------------------------------------------ grid and cursor

    _buildGrid() {
        const T = this.T;
        const minor = [], major = [];
        // One segment per cell edge: some GL stacks drop whole map-long lines that
        // cross the camera plane, which left the grid near the camera blank.
        for (let i = 0; i <= MAP_X; i++) {
            const arr = i % 8 === 0 ? major : minor;
            for (let k = 0; k < MAP_Z; k++) arr.push(i * CELL, 0, k * CELL, i * CELL, 0, (k + 1) * CELL);
        }
        for (let k = 0; k <= MAP_Z; k++) {
            const arr = k % 8 === 0 ? major : minor;
            for (let i = 0; i < MAP_X; i++) arr.push(i * CELL, 0, k * CELL, (i + 1) * CELL, 0, k * CELL);
        }
        const line = (arr, color, opacity) => {
            const g = new T.BufferGeometry();
            g.setAttribute('position', new T.Float32BufferAttribute(arr, 3));
            const m = this._mat(T.LineBasicMaterial, { color, transparent: true, opacity, depthWrite: false });
            const l = new T.LineSegments(g, m);
            l.renderOrder = 6;
            return l;
        };
        this.grid = new T.Group();
        this.grid.add(line(minor, 0x2f6aa8, 0.32));
        this.grid.add(line(major, 0x1d4f88, 0.6));
        // Map border: flat strips (WebGL lines are always 1 px).
        const bm = this._mat(T.MeshBasicMaterial, { color: 0x1d4f88, transparent: true, opacity: 0.55, depthWrite: false, side: T.DoubleSide });
        const strip = (w, d, x, z) => {
            const m = new T.Mesh(new T.PlaneGeometry(w, d).rotateX(-Math.PI / 2), bm);
            m.position.set(x, 0, z);
            this.grid.add(m);
        };
        strip(MAP_W + 6, 3, MAP_W / 2, -1.5);
        strip(MAP_W + 6, 3, MAP_W / 2, MAP_D + 1.5);
        strip(3, MAP_D, -1.5, MAP_D / 2);
        strip(3, MAP_D, MAP_W + 1.5, MAP_D / 2);
        // A faint sheet shows which height the grid is at when it floats above the ground.
        this.sheet = new T.Mesh(new T.PlaneGeometry(MAP_W, MAP_D).rotateX(-Math.PI / 2),
            this._mat(T.MeshBasicMaterial, { color: 0x7fdcff, transparent: true, opacity: 0.07, depthWrite: false, side: T.DoubleSide }));
        this.sheet.position.set(MAP_W / 2, 0, MAP_D / 2);
        this.grid.add(this.sheet);
        this.group.add(this.grid);
    }

    _buildCursor() {
        const T = this.T;
        this.cursor = new T.Group();
        const m = this._mat(T.MeshBasicMaterial, { color: ACCENT, transparent: true, opacity: 0.95, depthWrite: false, depthTest: false });
        const bar = (w, d, x, z) => {
            const b = new T.Mesh(new T.PlaneGeometry(w, d).rotateX(-Math.PI / 2), m);
            b.position.set(x, 0, z);
            b.renderOrder = 9;
            this.cursor.add(b);
        };
        bar(CELL, 1.4, CELL / 2, 0.7);
        bar(CELL, 1.4, CELL / 2, CELL - 0.7);
        bar(1.4, CELL, 0.7, CELL / 2);
        bar(1.4, CELL, CELL - 0.7, CELL / 2);
        // Pole down to the ground so a raised cursor still reads in 3D.
        const pg = new T.BufferGeometry();
        pg.setAttribute('position', new T.Float32BufferAttribute([CELL / 2, 0, CELL / 2, CELL / 2, -1, CELL / 2], 3));
        this.pole = new T.Line(pg, this._mat(T.LineBasicMaterial, { color: ACCENT, transparent: true, opacity: 0.6, depthWrite: false }));
        this.cursor.add(this.pole);
        this.group.add(this.cursor);
    }

    setLayer(layer) {
        this.layer = layer;
        const y = layer * LAYER;
        this.grid.position.y = y + (layer === 0 ? 0.12 : 0.05);
        this.sheet.visible = layer > 0;
    }

    /** Cursor cell [x, y, z] or null to hide it. */
    setCursor(cell) {
        if (!cell) {
            this.cursor.visible = false;
            return;
        }
        this.cursor.visible = true;
        this.cursor.position.set(cell[0] * CELL, cell[1] * LAYER + 0.2, cell[2] * CELL);
        const h = cell[1] * LAYER + 0.2;
        this.pole.scale.y = h;
        this.pole.visible = cell[1] > 0;
    }

    // ------------------------------------------------------------ ghost

    _buildGhost() {
        const T = this.T;
        this.ghost = new T.Group();
        this.ghostMat = this._mat(T.MeshLambertMaterial, { color: GOOD, emissive: GOOD, emissiveIntensity: 0.35, transparent: true, opacity: 0.55, depthWrite: false, side: T.DoubleSide });
        this.ghostMesh = new T.Mesh(new T.BufferGeometry(), this.ghostMat);
        this.ghostMesh.renderOrder = 8;
        this.ghost.add(this.ghostMesh);
        this.ghostBoxMat = this._mat(T.LineBasicMaterial, { color: GOOD, transparent: true, opacity: 0.9, depthWrite: false });
        this.ghostBox = new T.LineSegments(new T.EdgesGeometry(new T.BoxGeometry(1, 1, 1).translate(0.5, 0.5, 0.5)), this.ghostBoxMat);
        this.ghostBox.renderOrder = 9;
        this.ghost.add(this.ghostBox);
        // Decor stand-in: a little pine-ish cone on a base.
        const cone = new T.ConeGeometry(6, 14, 7).translate(0, 9, 0);
        const base = new T.CylinderGeometry(7, 7, 2, 10).translate(0, 1, 0);
        this.decorMesh = new T.Group();
        this.decorMesh.add(new T.Mesh(cone, this.ghostMat), new T.Mesh(base, this.ghostMat));
        const arrow = new T.Mesh(new T.ConeGeometry(2.4, 6, 4).rotateX(Math.PI / 2).translate(0, 1.5, 11), this.ghostMat);
        this.decorMesh.add(arrow);
        this.ghost.add(this.decorMesh);
        this.ghost.visible = false;
        this.group.add(this.ghost);
    }

    _previewGeometry(id, r, s) {
        const k = `${id}|${r}|${s}`;
        let g = this._previewCache.get(k);
        if (g) return g;
        const T = this.T;
        const meshes = blockPreview(id, 0, 0, 0, r, s);
        let nv = 0, ni = 0;
        for (const m of meshes) {
            if (m.material.startsWith('line_')) continue;
            nv += m.positions.length / 3;
            ni += m.indices.length;
        }
        const pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3), idx = new Uint32Array(ni);
        let v = 0, i = 0;
        for (const m of meshes) {
            if (m.material.startsWith('line_')) continue;
            pos.set(m.positions, v * 3);
            nrm.set(m.normals, v * 3);
            for (let j = 0; j < m.indices.length; j++) idx[i + j] = m.indices[j] + v;
            v += m.positions.length / 3;
            i += m.indices.length;
        }
        g = new T.BufferGeometry();
        g.setAttribute('position', new T.BufferAttribute(pos, 3));
        g.setAttribute('normal', new T.BufferAttribute(nrm, 3));
        g.setIndex(new T.BufferAttribute(idx, 1));
        g.computeBoundingSphere();
        if (this._previewCache.size > 80) {
            const first = this._previewCache.keys().next().value;
            this._previewCache.get(first).dispose();
            this._previewCache.delete(first);
        }
        this._previewCache.set(k, g);
        return g;
    }

    /**
     * ghost = { block, ok } | { decor, ok } | null. Ghost geometry is built at
     * the origin once per (id, rotation, surface) and moved, since a placement is
     * a pure translation of it.
     */
    setGhost(ghost) {
        if (!ghost) {
            this.ghost.visible = false;
            return;
        }
        const color = ghost.ok ? GOOD : BAD;
        this.ghostMat.color.setHex(color);
        this.ghostMat.emissive.setHex(color);
        this.ghostBoxMat.color.setHex(color);
        this.ghost.visible = true;
        if (ghost.block) {
            const b = ghost.block;
            const def = BLOCKS[b.b];
            this.ghostMesh.visible = true;
            this.decorMesh.visible = false;
            this.ghostMesh.geometry = this._previewGeometry(b.b, b.r & 3, b.s || def.defaultSurface);
            this.ghostMesh.position.set(b.x * CELL, b.y * LAYER, b.z * CELL);
            const [w, hgt, d] = footprintSize(def, b.r & 3);
            this.ghostBox.visible = true;
            this.ghostBox.position.set(b.x * CELL, b.y * LAYER - 1.5, b.z * CELL);
            this.ghostBox.scale.set(w * CELL, hgt * LAYER + 1.5, d * CELL);
        } else if (ghost.decor) {
            const d = ghost.decor;
            this.ghostMesh.visible = false;
            this.ghostBox.visible = false;
            this.decorMesh.visible = true;
            this.decorMesh.position.set((d.x + 0.5) * CELL, d.y * LAYER, (d.z + 0.5) * CELL);
            this.decorMesh.rotation.y = -(d.r & 3) * Math.PI / 2;
        }
    }

    // ------------------------------------------------------------ connector arrows

    _buildArrows() {
        const T = this.T;
        this.arrowGeo = new T.ConeGeometry(2.6, 7, 6).rotateX(Math.PI / 2);   // points +Z
        this.arrowMat = this._mat(T.MeshBasicMaterial, { color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false });
        this.arrows = null;
        this.arrowGroup = new T.Group();
        this.group.add(this.arrowGroup);
    }

    /** open = { road: [{ pos, out }], lips: [...] } from EditorDoc.openConnectors(). */
    setConnectors(open) {
        const T = this.T;
        const list = [...open.road.map((c) => [c, ACCENT]), ...open.lips.map((c) => [c, LIP])];
        if (!this.arrows || this.arrows.count < list.length || this.arrows.instanceMatrix.count < list.length) {
            if (this.arrows) {
                this.arrowGroup.remove(this.arrows);
                this.arrows.dispose();
            }
            const cap = Math.max(32, list.length * 2);
            this.arrows = new T.InstancedMesh(this.arrowGeo, this.arrowMat, cap);
            this.arrows.renderOrder = 9;
            this.arrows.frustumCulled = false;
            this.arrowGroup.add(this.arrows);
        }
        const m = new T.Matrix4(), q = new T.Quaternion(), p = new T.Vector3(), s = new T.Vector3(1, 1, 1);
        const fwd = new T.Vector3(0, 0, 1), dir = new T.Vector3(), col = new T.Color();
        list.forEach(([c, color], i) => {
            dir.set(c.out[0], 0, c.out[2]);
            if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
            dir.normalize();
            q.setFromUnitVectors(fwd, dir);
            p.set(c.pos[0] + dir.x * 5, c.pos[1] + 3.5, c.pos[2] + dir.z * 5);
            m.compose(p, q, s);
            this.arrows.setMatrixAt(i, m);
            this.arrows.setColorAt(i, col.setHex(color));
        });
        this.arrows.count = list.length;
        this.arrows.instanceMatrix.needsUpdate = true;
        if (this.arrows.instanceColor) this.arrows.instanceColor.needsUpdate = true;
    }

    // ------------------------------------------------------------ hover box

    _buildHover() {
        const T = this.T;
        this.hoverMat = this._mat(T.LineBasicMaterial, { color: 0xffffff, transparent: true, opacity: 0.95, depthWrite: false, depthTest: false });
        this.hover = new T.LineSegments(new T.EdgesGeometry(new T.BoxGeometry(1, 1, 1).translate(0.5, 0.5, 0.5)), this.hoverMat);
        this.hover.renderOrder = 10;
        this.hover.visible = false;
        this.group.add(this.hover);
    }

    /** Outlines a block (delete / pick target), or hides the box. */
    setHover(blk, color = 0xffffff) {
        if (!blk || !BLOCKS[blk.b]) {
            this.hover.visible = false;
            return;
        }
        const [w, hgt, d] = footprintSize(BLOCKS[blk.b], blk.r & 3);
        this.hoverMat.color.setHex(color);
        this.hover.visible = true;
        this.hover.position.set(blk.x * CELL - 0.5, blk.y * LAYER - 2, blk.z * CELL - 0.5);
        this.hover.scale.set(w * CELL + 1, hgt * LAYER + 2.5, d * CELL + 1);
    }

    // ------------------------------------------------------------ camera

    orbitBy(dYaw, dPitch) {
        const g = this.goal;
        g.yaw += dYaw;
        if (!this.cam.top) g.pitch = Math.max(0.12, Math.min(1.5, g.pitch + dPitch));
    }

    zoomBy(k) {
        this.goal.dist = Math.max(40, Math.min(1800, this.goal.dist * k));
    }

    /** Moves the focus by (right, forward) metres relative to the view. */
    panBy(right, forward) {
        const yaw = this.goal.yaw;
        // Camera sits at +sin/cos(yaw) from the target, so "forward" is the opposite way.
        const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
        const rx = -fz, rz = fx;
        const t = this.goal.target;
        t.x = Math.max(-64, Math.min(MAP_W + 64, t.x + rx * right + fx * forward));
        t.z = Math.max(-64, Math.min(MAP_D + 64, t.z + rz * right + fz * forward));
    }

    /** Screen-relative unit step on the grid: [dx, dz] for 'up' | 'down' | 'left' | 'right'. */
    gridStep(dir) {
        const yaw = this.goal.yaw;
        const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
        let vx, vz;
        if (dir === 'up') [vx, vz] = [fx, fz];
        else if (dir === 'down') [vx, vz] = [-fx, -fz];
        else if (dir === 'right') [vx, vz] = [-fz, fx];
        else [vx, vz] = [fz, -fx];
        return Math.abs(vx) > Math.abs(vz) ? [Math.sign(vx), 0] : [0, Math.sign(vz)];
    }

    focusOn(x, y, z, dist) {
        this.goal.target.set(x, y, z);
        if (dist) this.goal.dist = dist;
    }

    setTop(on) {
        this.cam.top = !!on;
        if (on) {
            this._pitchBefore = this.goal.pitch;
            this.goal.pitch = 1.553;
            // Snap the view to the nearest axis so grid rows stay square on screen.
            this.goal.yaw = Math.round(this.goal.yaw / (Math.PI / 2)) * (Math.PI / 2);
        } else {
            this.goal.pitch = this._pitchBefore || 0.62;
        }
    }

    snap() {
        const c = this.cam, g = this.goal;
        c.target.copy(g.target);
        c.yaw = g.yaw;
        c.pitch = g.pitch;
        c.dist = g.dist;
    }

    update(dt) {
        this.time += dt;
        const c = this.cam, g = this.goal;
        const k = 1 - Math.exp(-dt * 14);
        c.target.lerp(g.target, k);
        c.yaw += (g.yaw - c.yaw) * k;
        c.pitch += (g.pitch - c.pitch) * k;
        c.dist += (g.dist - c.dist) * k;
        const cam = this.r.camera;
        const cp = Math.cos(c.pitch);
        cam.position.set(
            c.target.x + c.dist * cp * Math.sin(c.yaw),
            c.target.y + c.dist * Math.sin(c.pitch),
            c.target.z + c.dist * cp * Math.cos(c.yaw));
        cam.up.set(0, 1, 0);
        cam.lookAt(c.target);
        if (this.r.env && this.r.env.focus) this.r.env.focus.copy(c.target);
        // Arrows bob gently so open road ends catch the eye.
        this.arrowGroup.position.y = Math.sin(this.time * 3) * 0.8;
        this.arrowMat.opacity = 0.7 + 0.25 * Math.sin(this.time * 3);
    }

    /** Grid cell under a screen point on the plane of `layer`, or null. */
    cellAt(clientX, clientY, layer = this.layer) {
        const ray = this.r.screenRay(clientX, clientY);
        if (!ray) return null;
        const y = layer * LAYER;
        if (Math.abs(ray.dir[1]) < 1e-6) return null;
        const t = (y - ray.origin[1]) / ray.dir[1];
        if (t <= 0) return null;
        const x = ray.origin[0] + ray.dir[0] * t, z = ray.origin[2] + ray.dir[2] * t;
        return [Math.floor(x / CELL), layer, Math.floor(z / CELL)];
    }

    dispose() {
        this.r.scene.remove(this.group);
        const cached = new Set(this._previewCache.values());
        this.group.traverse((o) => {
            if (o.geometry && !cached.has(o.geometry)) o.geometry.dispose();
        });
        for (const g of this._previewCache.values()) g.dispose();
        this._previewCache.clear();
        this.arrowGeo.dispose();
        if (this.arrows) this.arrows.dispose();
        for (const m of this._mats) m.dispose();
        this.r.cameraControls.enabled = this._rigWasEnabled !== false;
    }
}
