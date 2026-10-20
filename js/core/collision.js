// Static triangle mesh with a uniform 3D grid for fast, allocation-free
// queries. Physics calls raycast/querySphere many times per tick, so the hot
// paths use flat typed arrays, preallocated result objects and mailboxing.
import { SURFACE_IDS } from './constants.js';

const MAX_CELLS = 1_500_000;
const GROUND_TIE = 1e-9;   // relative t within which a triangle beats the coplanar ground
// Rays through a shared vertex or edge (the route centerline runs exactly along
// deck-strip edges) must not slip between triangles because of rounding.
const BARY_EPS = 1e-9;

// Per-triangle record in `tri`: v0, e1 = v1 - v0, e2 = v2 - v0, unit normal n,
// plane offset d = n·v0.
const STRIDE = 13;

export class CollisionMesh {
    /**
     * positions: Float64Array, 9 numbers per triangle (world metres)
     * surfaces: Uint8Array, index into SURFACE_IDS per triangle
     * opts.ground: { y, minX, maxX, minZ, maxZ, surface } analytic ground slab (optional)
     * opts.cellSize: grid cell size in metres (default 4, grown for huge meshes)
     */
    constructor(positions, surfaces, opts = {}) {
        const n = surfaces.length;
        this.triCount = n;
        this.positions = positions;
        this.surfaces = surfaces;
        this.ground = opts.ground || null;
        this.normals = new Float64Array(n * 3);
        const tri = (this.tri = new Float64Array(n * STRIDE));

        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        for (let i = 0; i < n; i++) {
            const p = i * 9;
            const ax = positions[p], ay = positions[p + 1], az = positions[p + 2];
            const e1x = positions[p + 3] - ax, e1y = positions[p + 4] - ay, e1z = positions[p + 5] - az;
            const e2x = positions[p + 6] - ax, e2y = positions[p + 7] - ay, e2z = positions[p + 8] - az;
            let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
            const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
            if (l > 0) { nx /= l; ny /= l; nz /= l; }
            const t = i * STRIDE;
            tri[t] = ax; tri[t + 1] = ay; tri[t + 2] = az;
            tri[t + 3] = e1x; tri[t + 4] = e1y; tri[t + 5] = e1z;
            tri[t + 6] = e2x; tri[t + 7] = e2y; tri[t + 8] = e2z;
            tri[t + 9] = nx; tri[t + 10] = ny; tri[t + 11] = nz;
            tri[t + 12] = nx * ax + ny * ay + nz * az;
            this.normals[i * 3] = nx; this.normals[i * 3 + 1] = ny; this.normals[i * 3 + 2] = nz;
            for (let k = 0; k < 9; k += 3) {
                const x = positions[p + k], y = positions[p + k + 1], z = positions[p + k + 2];
                if (x < minX) minX = x; if (x > maxX) maxX = x;
                if (y < minY) minY = y; if (y > maxY) maxY = y;
                if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
            }
        }
        if (n === 0) { minX = minY = minZ = 0; maxX = maxY = maxZ = 1; }
        this.bounds = { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };

        // Grid with one cell of padding so boundary triangles never straddle the edge.
        let cs = opts.cellSize || 4;
        let nx, ny, nz;
        for (;;) {
            nx = Math.floor((maxX - minX) / cs) + 3;
            ny = Math.floor((maxY - minY) / cs) + 3;
            nz = Math.floor((maxZ - minZ) / cs) + 3;
            if (nx * ny * nz <= MAX_CELLS) break;
            cs *= 2;
        }
        this.cs = cs;
        this.inv = 1 / cs;
        this.ox = minX - cs; this.oy = minY - cs; this.oz = minZ - cs;
        this.nx = nx; this.ny = ny; this.nz = nz;
        this._buildGrid();

        this.stamp = new Uint32Array(n);
        this.query = 0;
        this._hit = makeHit();
        this._cp = [0, 0, 0];
    }

    _cellRange(i, out) {
        const p = i * 9, pos = this.positions;
        let x0 = pos[p], x1 = x0, y0 = pos[p + 1], y1 = y0, z0 = pos[p + 2], z1 = z0;
        for (let k = 3; k < 9; k += 3) {
            const x = pos[p + k], y = pos[p + k + 1], z = pos[p + k + 2];
            if (x < x0) x0 = x; if (x > x1) x1 = x;
            if (y < y0) y0 = y; if (y > y1) y1 = y;
            if (z < z0) z0 = z; if (z > z1) z1 = z;
        }
        const inv = this.inv;
        out[0] = Math.floor((x0 - this.ox) * inv); out[1] = Math.floor((x1 - this.ox) * inv);
        out[2] = Math.floor((y0 - this.oy) * inv); out[3] = Math.floor((y1 - this.oy) * inv);
        out[4] = Math.floor((z0 - this.oz) * inv); out[5] = Math.floor((z1 - this.oz) * inv);
    }

    _buildGrid() {
        const { nx, ny, nz } = this;
        const cellCount = nx * ny * nz;
        const counts = new Int32Array(cellCount + 1);
        const r = [0, 0, 0, 0, 0, 0];
        for (let i = 0; i < this.triCount; i++) {
            this._cellRange(i, r);
            for (let z = r[4]; z <= r[5]; z++)
                for (let y = r[2]; y <= r[3]; y++)
                    for (let x = r[0]; x <= r[1]; x++) counts[(z * ny + y) * nx + x + 1]++;
        }
        for (let c = 0; c < cellCount; c++) counts[c + 1] += counts[c];
        const start = counts;
        const fill = start.slice(0, cellCount);
        const items = new Int32Array(start[cellCount]);
        for (let i = 0; i < this.triCount; i++) {
            this._cellRange(i, r);
            for (let z = r[4]; z <= r[5]; z++)
                for (let y = r[2]; y <= r[3]; y++)
                    for (let x = r[0]; x <= r[1]; x++) items[fill[(z * ny + y) * nx + x]++] = i;
        }
        this.cellStart = start;
        this.cellItems = items;
    }

    _nextQuery() {
        this.query = (this.query + 1) >>> 0;
        if (this.query === 0) {
            this.stamp.fill(0);
            this.query = 1;
        }
        return this.query;
    }

    /** Surface id string for a surface index. */
    surfaceName(index) {
        return SURFACE_IDS[index];
    }

    /**
     * Nearest hit along origin + t * dir for t in [0, maxDist]. dir need not be
     * unit length (t is then in units of |dir|). Two-sided. Returns `out`
     * (or a fresh object) filled as { t, point, normal, surface, surfaceId, tri,
     * backface }, or null. normal is the triangle's outward normal.
     */
    raycast(origin, dir, maxDist, out = null) {
        const ox = origin[0], oy = origin[1], oz = origin[2];
        const dx = dir[0], dy = dir[1], dz = dir[2];
        let best = maxDist;
        let bestTri = -1;
        let bestU = 0, bestV = 0;
        const q = this._nextQuery();
        const stamp = this.stamp, tri = this.tri, start = this.cellStart, items = this.cellItems;

        // Clip the ray against the grid box.
        let t0 = 0, t1 = maxDist;
        const gx0 = this.ox, gy0 = this.oy, gz0 = this.oz;
        const gx1 = gx0 + this.nx * this.cs, gy1 = gy0 + this.ny * this.cs, gz1 = gz0 + this.nz * this.cs;
        let ok = true;
        if (dx !== 0) {
            let a = (gx0 - ox) / dx, b = (gx1 - ox) / dx;
            if (a > b) { const s = a; a = b; b = s; }
            if (a > t0) t0 = a; if (b < t1) t1 = b;
        } else if (ox < gx0 || ox > gx1) ok = false;
        if (dy !== 0) {
            let a = (gy0 - oy) / dy, b = (gy1 - oy) / dy;
            if (a > b) { const s = a; a = b; b = s; }
            if (a > t0) t0 = a; if (b < t1) t1 = b;
        } else if (oy < gy0 || oy > gy1) ok = false;
        if (dz !== 0) {
            let a = (gz0 - oz) / dz, b = (gz1 - oz) / dz;
            if (a > b) { const s = a; a = b; b = s; }
            if (a > t0) t0 = a; if (b < t1) t1 = b;
        } else if (oz < gz0 || oz > gz1) ok = false;

        if (ok && t0 <= t1 && this.triCount > 0) {
            const cs = this.cs, inv = this.inv, nx = this.nx, ny = this.ny, nz = this.nz;
            const px = ox + dx * t0, py = oy + dy * t0, pz = oz + dz * t0;
            let cx = Math.floor((px - gx0) * inv), cy = Math.floor((py - gy0) * inv), cz = Math.floor((pz - gz0) * inv);
            if (cx < 0) cx = 0; else if (cx >= nx) cx = nx - 1;
            if (cy < 0) cy = 0; else if (cy >= ny) cy = ny - 1;
            if (cz < 0) cz = 0; else if (cz >= nz) cz = nz - 1;
            const sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
            const tdx = dx !== 0 ? cs / Math.abs(dx) : Infinity;
            const tdy = dy !== 0 ? cs / Math.abs(dy) : Infinity;
            const tdz = dz !== 0 ? cs / Math.abs(dz) : Infinity;
            let tmx = dx !== 0 ? (gx0 + (cx + (dx > 0 ? 1 : 0)) * cs - ox) / dx : Infinity;
            let tmy = dy !== 0 ? (gy0 + (cy + (dy > 0 ? 1 : 0)) * cs - oy) / dy : Infinity;
            let tmz = dz !== 0 ? (gz0 + (cz + (dz > 0 ? 1 : 0)) * cs - oz) / dz : Infinity;
            for (;;) {
                const c = (cz * ny + cy) * nx + cx;
                for (let k = start[c], e = start[c + 1]; k < e; k++) {
                    const i = items[k];
                    if (stamp[i] === q) continue;
                    stamp[i] = q;
                    // Möller–Trumbore
                    const b = i * STRIDE;
                    const e1x = tri[b + 3], e1y = tri[b + 4], e1z = tri[b + 5];
                    const e2x = tri[b + 6], e2y = tri[b + 7], e2z = tri[b + 8];
                    const pvx = dy * e2z - dz * e2y, pvy = dz * e2x - dx * e2z, pvz = dx * e2y - dy * e2x;
                    const det = e1x * pvx + e1y * pvy + e1z * pvz;
                    if (det > -1e-14 && det < 1e-14) continue;
                    const id = 1 / det;
                    const tvx = ox - tri[b], tvy = oy - tri[b + 1], tvz = oz - tri[b + 2];
                    const u = (tvx * pvx + tvy * pvy + tvz * pvz) * id;
                    if (u < -BARY_EPS || u > 1 + BARY_EPS) continue;
                    const qvx = tvy * e1z - tvz * e1y, qvy = tvz * e1x - tvx * e1z, qvz = tvx * e1y - tvy * e1x;
                    const v = (dx * qvx + dy * qvy + dz * qvz) * id;
                    if (v < -BARY_EPS || u + v > 1 + BARY_EPS) continue;
                    const t = (e2x * qvx + e2y * qvy + e2z * qvz) * id;
                    if (t < 0 || t > best) continue;
                    // Ties (shared edges) resolve to the lower index so results never depend on traversal order.
                    if (t === best && bestTri >= 0 && i > bestTri) continue;
                    best = t; bestTri = i; bestU = u; bestV = v;
                }
                // Stop once the best hit lies before the far side of this cell.
                const tNext = tmx < tmy ? (tmx < tmz ? tmx : tmz) : (tmy < tmz ? tmy : tmz);
                if (tNext > t1 || (bestTri >= 0 && best <= tNext)) break;
                if (tmx === tNext) { cx += sx; tmx += tdx; if (cx < 0 || cx >= nx) break; }
                else if (tmy === tNext) { cy += sy; tmy += tdy; if (cy < 0 || cy >= ny) break; }
                else { cz += sz; tmz += tdz; if (cz < 0 || cz >= nz) break; }
            }
        }

        // Analytic ground slab. Level-0 decks are coplanar with it: a triangle hit within
        // rounding of the ground wins, so the deck surface is never read as deep snow.
        let groundHit = false;
        const g = this.ground;
        if (g && dy !== 0) {
            const t = (g.y - oy) / dy;
            if (t >= 0 && t <= best && !(bestTri >= 0 && t >= best - GROUND_TIE * (best > 1 ? best : 1))) {
                const hx = ox + dx * t, hz = oz + dz * t;
                if (hx >= g.minX && hx <= g.maxX && hz >= g.minZ && hz <= g.maxZ) {
                    best = t;
                    groundHit = true;
                }
            }
        }
        if (!groundHit && bestTri < 0) return null;

        const h = out || makeHit();
        h.t = best;
        h.point[0] = ox + dx * best; h.point[1] = oy + dy * best; h.point[2] = oz + dz * best;
        if (groundHit) {
            h.normal[0] = 0; h.normal[1] = 1; h.normal[2] = 0;
            h.surface = g.surface; h.tri = -1; h.backface = dy > 0;
        } else {
            const b = bestTri * STRIDE;
            h.normal[0] = tri[b + 9]; h.normal[1] = tri[b + 10]; h.normal[2] = tri[b + 11];
            h.surface = this.surfaces[bestTri];
            h.tri = bestTri;
            h.backface = tri[b + 9] * dx + tri[b + 10] * dy + tri[b + 11] * dz > 0;
            h.u = bestU; h.v = bestV;
        }
        h.surfaceId = SURFACE_IDS[h.surface];
        return h;
    }

    /**
     * All triangles within `radius` of `center`. Fills `out` (an array reused
     * across calls; contact objects are created only when it needs to grow) and
     * returns the contact count. Each contact:
     *   { point, normal, depth, surface, surfaceId, tri, feature, faceNormal }
     * normal points from the surface toward the sphere centre (push direction),
     * depth = radius - distance, feature 0 = face, 1 = edge, 2 = vertex.
     * With opts.merge (default true) internal-edge contacts are pruned and
     * contacts whose normals agree within ~2.5° are merged (deepest kept), so a
     * sphere resting on a seam or a quad diagonal yields exactly one contact.
     */
    querySphere(center, radius, out, opts = DEFAULT_SPHERE_OPTS) {
        const cx = center[0], cy = center[1], cz = center[2];
        const r2 = radius * radius;
        let count = 0;
        const q = this._nextQuery();
        const stamp = this.stamp, tri = this.tri, start = this.cellStart, items = this.cellItems;
        const inv = this.inv, nx = this.nx, ny = this.ny, nz = this.nz;
        let x0 = Math.floor((cx - radius - this.ox) * inv), x1 = Math.floor((cx + radius - this.ox) * inv);
        let y0 = Math.floor((cy - radius - this.oy) * inv), y1 = Math.floor((cy + radius - this.oy) * inv);
        let z0 = Math.floor((cz - radius - this.oz) * inv), z1 = Math.floor((cz + radius - this.oz) * inv);
        if (x0 < 0) x0 = 0; if (y0 < 0) y0 = 0; if (z0 < 0) z0 = 0;
        if (x1 >= nx) x1 = nx - 1; if (y1 >= ny) y1 = ny - 1; if (z1 >= nz) z1 = nz - 1;
        const cp = this._cp;
        for (let gz = z0; gz <= z1; gz++) {
            for (let gy = y0; gy <= y1; gy++) {
                for (let gx = x0; gx <= x1; gx++) {
                    const c = (gz * ny + gy) * nx + gx;
                    for (let k = start[c], e = start[c + 1]; k < e; k++) {
                        const i = items[k];
                        if (stamp[i] === q) continue;
                        stamp[i] = q;
                        const b = i * STRIDE;
                        const pd = tri[b + 9] * cx + tri[b + 10] * cy + tri[b + 11] * cz - tri[b + 12];
                        if (pd > radius || pd < -radius) continue;
                        const feature = closestOnTri(tri, b, cx, cy, cz, cp);
                        const ddx = cx - cp[0], ddy = cy - cp[1], ddz = cz - cp[2];
                        const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
                        if (d2 >= r2) continue;
                        const d = Math.sqrt(d2);
                        const ct = contactAt(out, count++);
                        ct.point[0] = cp[0]; ct.point[1] = cp[1]; ct.point[2] = cp[2];
                        if (d > 1e-9) {
                            ct.normal[0] = ddx / d; ct.normal[1] = ddy / d; ct.normal[2] = ddz / d;
                        } else {
                            ct.normal[0] = tri[b + 9]; ct.normal[1] = tri[b + 10]; ct.normal[2] = tri[b + 11];
                        }
                        ct.faceNormal[0] = tri[b + 9]; ct.faceNormal[1] = tri[b + 10]; ct.faceNormal[2] = tri[b + 11];
                        ct.depth = radius - d;
                        ct.surface = this.surfaces[i];
                        ct.surfaceId = SURFACE_IDS[ct.surface];
                        ct.tri = i;
                        ct.feature = feature;
                    }
                }
            }
        }
        const g = this.ground;
        if (g && cy - radius < g.y) {
            // The ground is a half-space under the map rectangle: deep penetration still pushes up.
            const px = cx < g.minX ? g.minX : cx > g.maxX ? g.maxX : cx;
            const pz = cz < g.minZ ? g.minZ : cz > g.maxZ ? g.maxZ : cz;
            const inside = px === cx && pz === cz;
            const ddx = cx - px, ddz = cz - pz, ddy = cy - g.y;
            const d2 = ddx * ddx + ddz * ddz + (inside ? 0 : ddy * ddy);
            if (inside || d2 < r2) {
                const ct = contactAt(out, count++);
                ct.point[0] = px; ct.point[1] = g.y; ct.point[2] = pz;
                if (inside) {
                    ct.normal[0] = 0; ct.normal[1] = 1; ct.normal[2] = 0;
                    ct.depth = g.y - (cy - radius);
                    ct.feature = 0;
                } else {
                    const d = Math.sqrt(d2);
                    ct.normal[0] = ddx / d; ct.normal[1] = ddy / d; ct.normal[2] = ddz / d;
                    ct.depth = radius - d;
                    ct.feature = 1;
                }
                ct.faceNormal[0] = 0; ct.faceNormal[1] = 1; ct.faceNormal[2] = 0;
                ct.surface = g.surface;
                ct.surfaceId = SURFACE_IDS[g.surface];
                ct.tri = -1;
            }
        }
        if (opts.merge !== false && count > 1) count = mergeContacts(out, count);
        return count;
    }

    /**
     * Sweeps a sphere from a to b and returns the first fraction in [0, 1]
     * where it touches geometry (within ~1 cm), or -1 if the path is clear.
     * Conservative stepping plus bisection; fine for tunnelling checks.
     */
    sweepSphere(a, b, radius, scratch = []) {
        const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const p = [a[0], a[1], a[2]];
        const at = (t) => { p[0] = a[0] + dx * t; p[1] = a[1] + dy * t; p[2] = a[2] + dz * t; return p; };
        const opts = NO_MERGE;
        if (this.querySphere(at(0), radius, scratch, opts) > 0) return 0;
        const steps = Math.max(1, Math.ceil(len / (radius * 0.5)));
        let prev = 0;
        for (let s = 1; s <= steps; s++) {
            const t = s / steps;
            if (this.querySphere(at(t), radius, scratch, opts) > 0) {
                let lo = prev, hi = t;
                for (let k = 0; k < 12 && (hi - lo) * len > 0.01; k++) {
                    const mid = (lo + hi) / 2;
                    if (this.querySphere(at(mid), radius, scratch, opts) > 0) hi = mid;
                    else lo = mid;
                }
                return hi;
            }
            prev = t;
        }
        return -1;
    }

    /** Number of grid entries (diagnostics). */
    get gridEntries() {
        return this.cellItems.length;
    }
}

const DEFAULT_SPHERE_OPTS = { merge: true };
const NO_MERGE = { merge: false };

function makeHit() {
    return { t: 0, point: [0, 0, 0], normal: [0, 1, 0], surface: 0, surfaceId: 'snow', tri: -1, backface: false, u: 0, v: 0 };
}

function makeContact() {
    return { point: [0, 0, 0], normal: [0, 1, 0], faceNormal: [0, 1, 0], depth: 0, surface: 0, surfaceId: 'snow', tri: -1, feature: 0, covered: false };
}

function contactAt(out, i) {
    if (i >= out.length) out.push(makeContact());
    return out[i];
}

const MERGE_DOT = 0.999;
const PLANE_EPS = 1e-4;

/**
 * Removes internal-edge artefacts, then merges duplicates.
 * 1. An edge/vertex contact whose point lies in the plane of a face contact is
 *    the shared edge of a coplanar neighbour (quad diagonal, block seam): the
 *    face contact already covers it, and its tilted normal would feel like a bump.
 * 2. Contacts with (nearly) the same normal collapse to the deepest one.
 */
function mergeContacts(out, count) {
    let n = 0;
    for (let i = 0; i < count; i++) {
        const c = out[i];
        let covered = false;
        if (c.feature !== 0) {
            for (let j = 0; j < count; j++) {
                const f = out[j];
                if (f.feature !== 0 || j === i) continue;
                const d = (c.point[0] - f.point[0]) * f.faceNormal[0] + (c.point[1] - f.point[1]) * f.faceNormal[1]
                    + (c.point[2] - f.point[2]) * f.faceNormal[2];
                if (d < PLANE_EPS && d > -PLANE_EPS) { covered = true; break; }
            }
        }
        c.covered = covered;
    }
    for (let i = 0; i < count; i++) {
        const c = out[i];
        if (c.covered) continue;
        let merged = false;
        for (let j = 0; j < n; j++) {
            const m = out[j];
            const dot = c.normal[0] * m.normal[0] + c.normal[1] * m.normal[1] + c.normal[2] * m.normal[2];
            if (dot > MERGE_DOT) {
                // Keep the deepest; on ties prefer the face contact over edge/vertex ones.
                if (c.depth > m.depth + 1e-12 || (Math.abs(c.depth - m.depth) <= 1e-12 && c.feature < m.feature)) swapContact(out, j, i);
                merged = true;
                break;
            }
        }
        if (!merged) {
            if (n !== i) swapContact(out, n, i);
            n++;
        }
    }
    return n;
}

function swapContact(out, i, j) {
    const t = out[i];
    out[i] = out[j];
    out[j] = t;
}

/**
 * Closest point on triangle (record at tri[b]) to p; writes it to out and
 * returns the feature (0 face, 1 edge, 2 vertex). Ericson, RTCD 5.1.5.
 */
function closestOnTri(tri, b, px, py, pz, out) {
    const ax = tri[b], ay = tri[b + 1], az = tri[b + 2];
    const abx = tri[b + 3], aby = tri[b + 4], abz = tri[b + 5];
    const acx = tri[b + 6], acy = tri[b + 7], acz = tri[b + 8];
    const apx = px - ax, apy = py - ay, apz = pz - az;
    const d1 = abx * apx + aby * apy + abz * apz;
    const d2 = acx * apx + acy * apy + acz * apz;
    if (d1 <= 0 && d2 <= 0) { out[0] = ax; out[1] = ay; out[2] = az; return 2; }
    const bpx = apx - abx, bpy = apy - aby, bpz = apz - abz;
    const d3 = abx * bpx + aby * bpy + abz * bpz;
    const d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) { out[0] = ax + abx; out[1] = ay + aby; out[2] = az + abz; return 2; }
    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const v = d1 / (d1 - d3);
        out[0] = ax + abx * v; out[1] = ay + aby * v; out[2] = az + abz * v;
        return 1;
    }
    const cpx = apx - acx, cpy = apy - acy, cpz = apz - acz;
    const d5 = abx * cpx + aby * cpy + abz * cpz;
    const d6 = acx * cpx + acy * cpy + acz * cpz;
    if (d6 >= 0 && d5 <= d6) { out[0] = ax + acx; out[1] = ay + acy; out[2] = az + acz; return 2; }
    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) {
        const w = d2 / (d2 - d6);
        out[0] = ax + acx * w; out[1] = ay + acy * w; out[2] = az + acz * w;
        return 1;
    }
    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
        const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
        out[0] = ax + abx + (acx - abx) * w;
        out[1] = ay + aby + (acy - aby) * w;
        out[2] = az + abz + (acz - abz) * w;
        return 1;
    }
    const denom = 1 / (va + vb + vc);
    const v = vb * denom, w = vc * denom;
    out[0] = ax + abx * v + acx * w;
    out[1] = ay + aby * v + acy * w;
    out[2] = az + abz * v + acz * w;
    return 0;
}

/**
 * Segment a->b against an axis-aligned box { min, max }. Returns the entry
 * fraction in [0, 1] or -1. Use it for trigger crossing between two ticks so
 * fast cars cannot skip a thin gate.
 */
export function segmentAABB(a, b, box) {
    let t0 = 0, t1 = 1;
    for (let k = 0; k < 3; k++) {
        const d = b[k] - a[k];
        const lo = box.min[k], hi = box.max[k];
        if (d === 0) {
            if (a[k] < lo || a[k] > hi) return -1;
        } else {
            let ta = (lo - a[k]) / d, tb = (hi - a[k]) / d;
            if (ta > tb) { const s = ta; ta = tb; tb = s; }
            if (ta > t0) t0 = ta;
            if (tb < t1) t1 = tb;
            if (t0 > t1) return -1;
        }
    }
    return t0;
}

/** Point inside an axis-aligned box { min, max }. */
export function pointInAABB(p, box) {
    return p[0] >= box.min[0] && p[0] <= box.max[0]
        && p[1] >= box.min[1] && p[1] <= box.max[1]
        && p[2] >= box.min[2] && p[2] <= box.max[2];
}
