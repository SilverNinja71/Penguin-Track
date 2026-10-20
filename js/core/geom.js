// Geometry toolkit for block generators: a mesh builder that emits collision
// triangles and render buffers together, moving frames along parametric
// centerlines, and cross-section sweeps. Everything is in block-local metres.
import { dsincos, len3 } from './mathd.js';

const EPS_AREA2 = 1e-12;   // squared doubled-area below which a triangle is dropped

class Group {
    constructor() {
        this.col = [];          // collision vertices, 9 numbers per triangle
        this.surf = [];         // surface index per collision triangle
        this.mats = new Map();  // material -> { pos, nrm, uv, idx }
    }

    buf(material) {
        let b = this.mats.get(material);
        if (!b) {
            b = { pos: [], nrm: [], uv: [], idx: [] };
            this.mats.set(material, b);
        }
        return b;
    }
}

function sub(a, b) {
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot(a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function norm(a) {
    const l = Math.sqrt(dot(a, a));
    return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
}

/**
 * Accumulates geometry into named groups. 'main' is always emitted; other
 * groups ('cap:<connector>:<part>') are picked by buildWorld depending on
 * what the connector is attached to.
 */
export class MeshBuilder {
    constructor() {
        this.groups = new Map();
        this.use('main');
    }

    use(key) {
        let g = this.groups.get(key);
        if (!g) {
            g = new Group();
            this.groups.set(key, g);
        }
        this.g = g;
        return this;
    }

    /**
     * Triangle with outward hint normal `hint`. Winding is fixed to be CCW seen
     * from the outside. `ns` are per-vertex render normals (default: face normal).
     * opts: { surf, mat, collide = true, render = true }
     */
    tri(a, b, c, hint, ns, uvs, opts) {
        const n = cross(sub(b, a), sub(c, a));
        const area2 = dot(n, n);
        if (area2 < EPS_AREA2) return;
        let ia = 0, ib = 1, ic = 2;
        const pts = [a, b, c];
        if (dot(n, hint) < 0) { ib = 2; ic = 1; }
        const P = [pts[ia], pts[ib], pts[ic]];
        if (opts.collide !== false) {
            const col = this.g.col;
            for (let k = 0; k < 3; k++) col.push(P[k][0], P[k][1], P[k][2]);
            this.g.surf.push(opts.surf);
        }
        if (opts.render !== false && opts.mat) {
            const fn = norm(n);
            if (dot(fn, hint) < 0) { fn[0] = -fn[0]; fn[1] = -fn[1]; fn[2] = -fn[2]; }
            const buf = this.g.buf(opts.mat);
            const base = buf.pos.length / 3;
            const order = [ia, ib, ic];
            for (let k = 0; k < 3; k++) {
                const j = order[k];
                const p = pts[j];
                const nn = ns ? ns[j] : fn;
                buf.pos.push(p[0], p[1], p[2]);
                buf.nrm.push(nn[0], nn[1], nn[2]);
                if (uvs) buf.uv.push(uvs[j][0], uvs[j][1]);
                else buf.uv.push(0, 0);
            }
            buf.idx.push(base, base + 1, base + 2);
        }
    }

    /** Quad a-b-c-d (any winding), split along a-c. */
    quad(a, b, c, d, hint, ns, uvs, opts) {
        this.tri(a, b, c, hint, ns && [ns[0], ns[1], ns[2]], uvs && [uvs[0], uvs[1], uvs[2]], opts);
        this.tri(a, c, d, hint, ns && [ns[0], ns[2], ns[3]], uvs && [uvs[0], uvs[2], uvs[3]], opts);
    }

    /** Convex polygon as a fan with a constant normal. */
    poly(pts, normal, opts, uvAxes) {
        const ns = [normal, normal, normal];
        for (let i = 1; i + 1 < pts.length; i++) {
            const tri = [pts[0], pts[i], pts[i + 1]];
            const uvs = uvAxes ? tri.map((p) => [dot(p, uvAxes[0]), dot(p, uvAxes[1])]) : null;
            this.tri(tri[0], tri[1], tri[2], normal, ns, uvs, opts);
        }
    }

    /** Axis-aligned box. `skip` lists faces to omit: 'px','nx','py','ny','pz','nz'. */
    box(min, max, opts, skip = []) {
        const [x0, y0, z0] = min, [x1, y1, z1] = max;
        const faces = {
            px: [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], [1, 0, 0]],
            nx: [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0]],
            py: [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [0, 1, 0]],
            ny: [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0]],
            pz: [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1]],
            nz: [[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [0, 0, -1]],
        };
        for (const key of Object.keys(faces)) {
            if (skip.includes(key)) continue;
            const f = faces[key];
            const n = f[4];
            const ax = Math.abs(n[0]) > 0 ? [[0, 0, 1], [0, 1, 0]] : Math.abs(n[1]) > 0 ? [[1, 0, 0], [0, 0, 1]] : [[1, 0, 0], [0, 1, 0]];
            this.poly([f[0], f[1], f[2], f[3]], n, opts, ax);
        }
    }

    /** Freezes the builder into typed arrays (block-local). */
    finish() {
        const out = new Map();
        for (const [key, g] of this.groups) {
            const meshes = [];
            for (const [material, b] of g.mats) {
                if (b.idx.length === 0) continue;
                meshes.push({
                    material,
                    pos: new Float32Array(b.pos),
                    nrm: new Float32Array(b.nrm),
                    uv: new Float32Array(b.uv),
                    idx: new Uint32Array(b.idx),
                });
            }
            out.set(key, { col: new Float64Array(g.col), surf: new Uint8Array(g.surf), meshes });
        }
        return out;
    }
}

// ---------------------------------------------------------------------------
// Frames: { p, T, S, U, d } — position, unit tangent, unit right (T x U),
// unit up, distance along the base curve. Right-handed: S = T x U.

const sc = [0, 0];

/**
 * Samples a parametric curve into n+1 frames.
 * curve(t, p, dp) writes position and derivative for t in [0, 1].
 * opts.up(t, T, p) -> unit up perpendicular to T (default: world up, no roll)
 * opts.bank(t) -> roll angle (positive raises the right side)
 * opts.pivot -> lateral offset of the roll axis (e.g. -12 keeps the left deck edge in place)
 * opts.d0 -> starting distance
 */
export function curveFrames(n, curve, opts = {}) {
    const frames = [];
    const p = [0, 0, 0], dp = [0, 0, 0];
    let d = opts.d0 || 0;
    let prev = null;
    for (let i = 0; i <= n; i++) {
        const t = i / n;
        curve(t, p, dp);
        const T = norm(dp);
        let U;
        if (opts.up) {
            U = opts.up(t, T, p);
        } else {
            // World up with the tangent component removed: no roll.
            const k = T[1];
            U = norm([-T[0] * k, 1 - T[1] * k, -T[2] * k]);
        }
        let S = cross(T, U);
        const base = [p[0], p[1], p[2]];
        if (prev) d += len3(base[0] - prev[0], base[1] - prev[1], base[2] - prev[2]);
        prev = base;
        let P = base;
        const phi = opts.bank ? opts.bank(t) : 0;
        if (phi !== 0) {
            dsincos(phi, sc);
            const s = sc[0], c = sc[1];
            const S2 = [c * S[0] + s * U[0], c * S[1] + s * U[1], c * S[2] + s * U[2]];
            const U2 = [c * U[0] - s * S[0], c * U[1] - s * S[1], c * U[2] - s * S[2]];
            const pv = opts.pivot || 0;
            P = [base[0] + pv * (S[0] - S2[0]), base[1] + pv * (S[1] - S2[1]), base[2] + pv * (S[2] - S2[2])];
            S = S2;
            U = U2;
        }
        frames.push({ p: P, T, S, U, d, t });
    }
    return frames;
}

/** Straight segment frames from a to b with roughly `step` spacing. */
export function lineFrames(a, b, step, d0 = 0) {
    const L = len3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const n = Math.max(1, Math.ceil(L / step - 1e-9));
    return curveFrames(n, (t, p, dp) => {
        p[0] = a[0] + (b[0] - a[0]) * t;
        p[1] = a[1] + (b[1] - a[1]) * t;
        p[2] = a[2] + (b[2] - a[2]) * t;
        dp[0] = b[0] - a[0]; dp[1] = b[1] - a[1]; dp[2] = b[2] - a[2];
    }, { d0 });
}

/** Joins frame runs, dropping the duplicated joint frame. */
export function joinFrames(...runs) {
    const out = [];
    for (const run of runs) {
        const start = out.length ? 1 : 0;
        const offset = out.length ? out[out.length - 1].d - run[0].d : 0;
        for (let i = start; i < run.length; i++) {
            const f = run[i];
            out.push({ ...f, d: f.d + offset });
        }
    }
    return out;
}

/**
 * Sweeps a K-point cross-section along frames.
 * section(frame, i, pts) fills pts[k] = [x, y, z].
 * panels: [{ a, b, surf, mat, lat, collide, render }] — a/b are profile indices
 * in clockwise order seen along T, so cross(B - A, T) points outward.
 * Returns the sampled rows (rows[i][k]) for caps and paths.
 */
export function sweep(mb, frames, K, section, panels) {
    const rows = frames.map((f, i) => {
        const pts = [];
        for (let k = 0; k < K; k++) pts.push([0, 0, 0]);
        section(f, i, pts);
        return pts;
    });
    for (const pn of panels) {
        let prevN = null;
        for (let i = 0; i + 1 < frames.length; i++) {
            const f0 = frames[i], f1 = frames[i + 1];
            const A0 = rows[i][pn.a], B0 = rows[i][pn.b], A1 = rows[i + 1][pn.a], B1 = rows[i + 1][pn.b];
            let n0 = norm(cross(sub(B0, A0), f0.T));
            let n1 = norm(cross(sub(B1, A1), f1.T));
            // A collapsed panel edge has no normal of its own; borrow the neighbour's.
            if (dot(n0, n0) === 0) n0 = dot(n1, n1) > 0 ? n1 : (prevN || [0, 1, 0]);
            if (dot(n1, n1) === 0) n1 = n0;
            prevN = n1;
            const hint = norm([n0[0] + n1[0], n0[1] + n1[1], n0[2] + n1[2]]);
            let uvs;
            if (pn.lat) {
                const ua0 = dot(sub(A0, f0.p), f0.S), ub0 = dot(sub(B0, f0.p), f0.S);
                const ua1 = dot(sub(A1, f1.p), f1.S), ub1 = dot(sub(B1, f1.p), f1.S);
                uvs = [[ua0, f0.d], [ub0, f0.d], [ub1, f1.d], [ua1, f1.d]];
            } else {
                const l0 = Math.sqrt(dot(sub(B0, A0), sub(B0, A0)));
                const l1 = Math.sqrt(dot(sub(B1, A1), sub(B1, A1)));
                uvs = [[0, f0.d], [l0, f0.d], [l1, f1.d], [0, f1.d]];
            }
            mb.quad(A0, B0, B1, A1, hint, [n0, n0, n1, n1], uvs, pn);
        }
    }
    return rows;
}
