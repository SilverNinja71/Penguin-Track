// Small top-down map: the route polyline (drawn once to an offscreen canvas),
// checkpoints, start and finish, then Quick TAS markers, the ghosts (each in
// its own colour) and the player car per frame.
// North-up: screen x = world x, screen y = world z.
import { h } from './dom.js';

const SIZE = 150;   // CSS pixels
const PAD = 12;
const GHOST_FILL = 'rgba(184, 241, 255, 0.55)';
const NONE = [];

export class Minimap {
    constructor(world, { size = SIZE } = {}) {
        this.world = world;
        this.size = size;
        this.dpr = Math.min(2, window.devicePixelRatio || 1);
        this.el = h('canvas.hud-minimap', { width: Math.round(size * this.dpr), height: Math.round(size * this.dpr), 'aria-hidden': 'true' });
        this.el.style.width = this.el.style.height = size + 'px';
        this.ctx = this.el.getContext('2d');
        this.base = document.createElement('canvas');
        this.base.width = this.el.width;
        this.base.height = this.el.height;
        this._fit();
        this._drawBase();
    }

    _fit() {
        const r = this.world.route;
        let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
        for (let i = 0; i < r.count; i++) {
            const x = r.points[i * 3], z = r.points[i * 3 + 2];
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (z < minZ) minZ = z;
            if (z > maxZ) maxZ = z;
        }
        const span = Math.max(40, maxX - minX, maxZ - minZ);
        this.scale = ((this.size - PAD * 2) / span) * this.dpr;
        const half = (this.size * this.dpr) / 2;
        this.ox = half - ((minX + maxX) / 2) * this.scale;
        this.oz = half - ((minZ + maxZ) / 2) * this.scale;
    }

    _x(x) {
        return this.ox + x * this.scale;
    }

    _y(z) {
        return this.oz + z * this.scale;
    }

    _drawBase() {
        const c = this.base.getContext('2d');
        const r = this.world.route, d = this.dpr;
        c.clearRect(0, 0, this.base.width, this.base.height);
        c.lineJoin = 'round';
        c.lineCap = 'round';
        const path = () => {
            c.beginPath();
            let pen = false;
            for (let i = 0; i < r.count; i++) {
                const x = this._x(r.points[i * 3]), y = this._y(r.points[i * 3 + 2]);
                // Jumps are drawn as gaps, like the air they are.
                if (!pen || (i > 0 && r.gap[i - 1])) c.moveTo(x, y);
                else c.lineTo(x, y);
                pen = true;
            }
        };
        path();
        c.strokeStyle = 'rgba(4, 16, 36, 0.85)';
        c.lineWidth = 7 * d;
        c.stroke();
        path();
        c.strokeStyle = 'rgba(232, 244, 255, 0.92)';
        c.lineWidth = 3.2 * d;
        c.stroke();
        const dot = (x, z, color, rad) => {
            c.beginPath();
            c.arc(this._x(x), this._y(z), rad * d, 0, Math.PI * 2);
            c.fillStyle = color;
            c.fill();
            c.lineWidth = 1.5 * d;
            c.strokeStyle = 'rgba(4, 16, 36, 0.9)';
            c.stroke();
        };
        for (const t of this.world.triggers) {
            const x = (t.min[0] + t.max[0]) / 2, z = (t.min[2] + t.max[2]) / 2;
            if (t.type === 'checkpoint') dot(x, z, '#5aa8ff', 3.6);
            else if (t.type === 'finish') dot(x, z, '#ff6b81', 4.2);
            else if (t.type === 'startfinish') dot(x, z, '#ffcf5a', 4.2);
        }
        const sp = this.world.spawn;
        if (sp) dot(sp.pos[0], sp.pos[2], '#6bffb0', 3.6);
    }

    /**
     * pos: [x, y, z]; quat: car orientation; ghosts: [[x, y, z] | null];
     * colors: CSS colour per ghost (optional); markers: Quick TAS savestate
     * markers [{ pos, current }] (optional).
     */
    draw(pos, quat, ghosts, colors = NONE, markers = NONE) {
        const c = this.ctx, d = this.dpr;
        c.clearRect(0, 0, this.el.width, this.el.height);
        c.drawImage(this.base, 0, 0);
        for (let i = 0; i < markers.length; i++) {
            const m = markers[i];
            const x = this._x(m.pos[0]), y = this._y(m.pos[2]), r = (m.current ? 4.2 : 3.2) * d;
            c.beginPath();
            c.moveTo(x, y - r);
            c.lineTo(x + r, y);
            c.lineTo(x, y + r);
            c.lineTo(x - r, y);
            c.closePath();
            c.fillStyle = m.current ? '#ffd54a' : '#7fdcff';
            c.fill();
            c.lineWidth = 1.2 * d;
            c.strokeStyle = 'rgba(4, 16, 36, 0.9)';
            c.stroke();
        }
        for (let i = 0; i < ghosts.length; i++) {
            const g = ghosts[i];
            if (!g) continue;
            c.beginPath();
            c.arc(this._x(g[0]), this._y(g[2]), 3.4 * d, 0, Math.PI * 2);
            c.globalAlpha = colors[i] ? 0.85 : 1;
            c.fillStyle = colors[i] || GHOST_FILL;
            c.fill();
            c.globalAlpha = 1;
        }
        if (!pos) return;
        // Heading: car-local +Z rotated by quat, projected on the ground.
        const [qx, qy, qz, qw] = quat;
        const fx = 2 * (qx * qz + qw * qy), fz = 1 - 2 * (qx * qx + qy * qy);
        const a = Math.atan2(fz, fx);
        const x = this._x(pos[0]), y = this._y(pos[2]);
        c.save();
        c.translate(x, y);
        c.rotate(a);
        c.beginPath();
        c.moveTo(7 * d, 0);
        c.lineTo(-4.5 * d, 4.5 * d);
        c.lineTo(-2.5 * d, 0);
        c.lineTo(-4.5 * d, -4.5 * d);
        c.closePath();
        c.fillStyle = '#ffd54a';
        c.fill();
        c.lineWidth = 1.6 * d;
        c.strokeStyle = 'rgba(4, 16, 36, 0.95)';
        c.stroke();
        c.restore();
    }

    dispose() {
        this.el.remove();
    }
}
