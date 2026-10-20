// The route: one dense centerline polyline from the spawn through every
// checkpoint to the finish (or one lap for StartFinish tracks). Autopilot, AI
// rewards, progress bars and the minimap all measure progress along it.
import { datan2, len3, dsincos } from './mathd.js';
import { LAYER } from './constants.js';

export const ROUTE_STEP = 2;            // target spacing of route points (m)
export const GAP_LOOKAHEAD_CELLS = 8;   // how far a jump may land from its lip
const LOCAL_BACK = 10, LOCAL_AHEAD = 30;
const LOCAL_SLACK = 6;   // metres beyond the road half-width a hinted projection may be
export const NO_SURFACE = 255;

// ---------------------------------------------------------------------------
// Graph search

const MAX_SEARCH = 2000;    // Dijkstra runs the checkpoint-order search may spend before giving up
const DROP_SLACK = 0.5;     // a road end may "jump" onto a landing at most this much higher
const LIP_RISE = LAYER;     // a ramp lip may throw the car at most one layer above the lip

/** An Error carrying a structured validation issue (see track.js validateTrack). */
function routeError(message, issue) {
    const e = new Error(message);
    e.issue = { ...issue, message };
    return e;
}

/**
 * Builds the route from the block connectivity graph.
 * input = {
 *   connectors: [{ block, kind: 'road'|'lip', match: index | -1, pos: [x,y,z], dir: [x,y,z] }],
 *       pos: face centre at deck level (lip: lip edge); dir: outward unit vector (lip: launch tangent)
 *   paths: [{ block, a: connector | -1 (spawn), b: connector, pts, ups, hw (typed arrays, world),
 *             surface, events: [{ type, id, at }], spawnAt }],
 *   checkpointCount,
 *   checkpointBlocks: block index per checkpoint id (for error messages),
 *   laps: lap count (> 1: the route must be one closed lap to a StartFinish line),
 * }
 * Throws an Error describing what could not be reached (with `.issue`).
 */
export function buildRoute(input) {
    const { connectors, paths, checkpointCount } = input;
    const laps = input.laps || 1;
    const cpBlocks = input.checkpointBlocks || [];
    const N = connectors.length;
    const SPAWN = 2 * N;
    const V = 2 * N + 1;
    const edges = [];
    const adj = [];
    for (let i = 0; i < V; i++) adj.push([]);
    const addEdge = (e) => {
        e.index = edges.length;
        edges.push(e);
        adj[e.from].push(e);
    };
    const exitNode = (c) => (connectors[c].match >= 0 ? connectors[c].match : N + c);

    paths.forEach((p, pi) => {
        const len = polylineLength(p.pts);
        p.length = len;
        const from = p.a < 0 ? SPAWN : p.a;
        addEdge({ from, to: exitNode(p.b), path: pi, rev: false, len, events: p.events });
        // Paths are bidirectional, except out of a lip (exit only) or from the spawn.
        if (p.a >= 0 && connectors[p.b].kind !== 'lip') {
            const events = p.events.map((ev) => ({ ...ev, at: len - ev.at }));
            addEdge({ from: p.b, to: exitNode(p.a), path: pi, rev: true, len, events });
        }
    });

    // Jumps: a dangling exit may land on any dangling entry roughly straight ahead,
    // never higher than it could plausibly fly.
    const maxAhead = GAP_LOOKAHEAD_CELLS * 32;
    for (let e = 0; e < N; e++) {
        const ce = connectors[e];
        if (ce.match >= 0) continue;
        const hx0 = ce.dir[0], hz0 = ce.dir[2];
        const hl = Math.sqrt(hx0 * hx0 + hz0 * hz0);
        if (hl < 1e-6) continue;
        const hx = hx0 / hl, hz = hz0 / hl;
        const maxRise = ce.kind === 'lip' ? LIP_RISE : DROP_SLACK;
        for (let c = 0; c < N; c++) {
            const cc = connectors[c];
            if (c === e || cc.match >= 0 || cc.kind !== 'road' || cc.block === ce.block) continue;
            // Entering through c means heading against its outward direction.
            if (-(cc.dir[0] * hx + cc.dir[2] * hz) < 0.99) continue;
            const vx = cc.pos[0] - ce.pos[0], vy = cc.pos[1] - ce.pos[1], vz = cc.pos[2] - ce.pos[2];
            const ahead = vx * hx + vz * hz;
            const side = Math.abs(vx * hz - vz * hx);
            if (ahead < -1e-6 || ahead > maxAhead || side > 32 + 1e-6) continue;
            // A landing on the very face of the exit (a kicker or a drop straight onto
            // the next road) only counts directly in front of it.
            if (ahead <= 1e-6 && side > 1e-6) continue;
            if (vy > maxRise) continue;
            addEdge({
                from: N + e, to: c, path: -1, rev: false,
                len: Math.sqrt(vx * vx + vy * vy + vz * vz), events: [], gap: [e, c],
            });
        }
    }

    const finalHit = laps > 1
        ? (ev) => ev.type === 'startfinish'
        : (ev) => ev.type === 'finish' || ev.type === 'startfinish';
    const chosen = searchRoute(V, adj, SPAWN, checkpointCount, finalHit, laps, cpBlocks);
    return assemble(chosen, input);
}

/**
 * Picks the checkpoint order: nearest unvisited checkpoint first (Trackmania
 * players take them in any order), backtracking to the next-nearest choice
 * when a greedy pick leads into a dead end, then the nearest finish line.
 * Returns [{ edge, cut }] (cut = distance along the edge where the route stops).
 */
function searchRoute(V, adj, SPAWN, checkpointCount, finalHit, laps, cpBlocks) {
    const describe = (ids) => ids.map((id) => `checkpoint ${id}${cpBlocks[id] != null ? ` (block #${cpBlocks[id]})` : ''}`).join(', ');
    const finishError = () => routeError(
        `No route to ${laps > 1 ? 'the StartFinish line (a lap track must loop back to it)' : 'a finish line'}: it is unreachable from the start`,
        { code: 'unreachableFinish', blocks: [] });
    const checkpointError = (missing) => routeError(`No route through every checkpoint (unreachable: ${describe(missing)})`, {
        code: 'unreachableCheckpoint', checkpointIds: missing, blocks: missing.map((id) => cpBlocks[id]).filter((b) => b != null),
    });

    // Cheap verdicts first, so a broken layout (the editor validates on every edit)
    // never sends the order search through every permutation.
    const reach = reachable(V, adj, SPAWN);
    const seen = new Uint8Array(checkpointCount);
    let finishSeen = false;
    for (let u = 0; u < V; u++) {
        if (!reach[u]) continue;
        for (const e of adj[u]) {
            for (const ev of e.events) {
                if (ev.type === 'checkpoint') seen[ev.id] = 1;
                if (finalHit(ev)) finishSeen = true;
            }
        }
    }
    const never = [];
    for (let i = 0; i < checkpointCount; i++) if (!seen[i]) never.push(i);
    if (never.length) throw checkpointError(never);
    if (!finishSeen) throw finishError();

    let budget = MAX_SEARCH;
    let firstFailure = null;
    const deadEnds = new Set();   // "node|visited" states already known to fail
    const fail = (err) => {
        if (!firstFailure) firstFailure = err;
        return null;
    };
    const dfs = (src, visited, remaining) => {
        const key = `${src}|${visited.join('')}`;
        if (deadEnds.has(key)) return null;
        if (budget-- <= 0) return fail(routeError('No route found: the checkpoint layout is too ambiguous to search', { code: 'routeSearch', blocks: [] }));
        if (remaining === 0) {
            const res = dijkstra(V, adj, src, (e) => {
                let best = -1;
                for (const ev of e.events) if (finalHit(ev) && (best < 0 || ev.at < best)) best = ev.at;
                return best;
            });
            if (!res) {
                deadEnds.add(key);
                return fail(finishError());
            }
            return res.edges.map((edge, i) => ({ edge, cut: i === res.edges.length - 1 ? res.at : -1 }));
        }
        const cands = nearestCheckpoints(V, adj, src, visited);
        if (cands.length === 0) {
            const missing = [];
            for (let i = 0; i < checkpointCount; i++) if (!visited[i]) missing.push(i);
            deadEnds.add(key);
            return fail(checkpointError(missing));
        }
        for (const cand of cands) {
            const next = visited.slice();
            let left = remaining;
            for (const e of cand.edges) {
                for (const ev of e.events) if (ev.type === 'checkpoint' && !next[ev.id]) { next[ev.id] = 1; left--; }
            }
            const rest = dfs(cand.edges[cand.edges.length - 1].to, next, left);
            if (rest) return cand.edges.map((edge) => ({ edge, cut: -1 })).concat(rest);
            if (budget <= 0) return null;
        }
        deadEnds.add(key);
        return null;
    };
    const chosen = dfs(SPAWN, new Uint8Array(checkpointCount), checkpointCount);
    if (!chosen) throw firstFailure;
    return chosen;
}

/** Nodes reachable from src (1 = yes). */
function reachable(V, adj, src) {
    const seen = new Uint8Array(V);
    const stack = [src];
    seen[src] = 1;
    while (stack.length) {
        const u = stack.pop();
        for (const e of adj[u]) if (!seen[e.to]) { seen[e.to] = 1; stack.push(e.to); }
    }
    return seen;
}

/**
 * One Dijkstra run from src: for every unvisited checkpoint, the cheapest way to
 * cross it. Returns candidates sorted by cost (ties: discovery order, which
 * reproduces a single-target search), each { id, cost, edges }.
 */
function nearestCheckpoints(V, adj, src, visited) {
    const dist = new Float64Array(V).fill(Infinity);
    const prev = new Array(V).fill(null);
    const heap = new MinHeap();
    const found = new Map();   // id -> { cost, edge, order }
    let order = 0;
    dist[src] = 0;
    heap.push(0, src);
    while (heap.size) {
        const d = heap.topKey(), u = heap.pop();
        if (d > dist[u]) continue;
        for (const e of adj[u]) {
            for (const ev of e.events) {
                if (ev.type !== 'checkpoint' || visited[ev.id]) continue;
                const cost = d + ev.at;
                const cur = found.get(ev.id);
                if (!cur || cost < cur.cost) found.set(ev.id, { id: ev.id, cost, edge: e, order: order++ });
            }
            const nd = d + e.len;
            if (nd < dist[e.to]) {
                dist[e.to] = nd;
                prev[e.to] = e;
                heap.push(nd, e.to);
            }
        }
    }
    const list = [...found.values()].sort((a, b) => a.cost - b.cost || a.order - b.order);
    return list.map((c) => {
        const edges = [c.edge];
        let n = c.edge.from;
        while (n !== src) {
            const e = prev[n];
            edges.push(e);
            n = e.from;
        }
        edges.reverse();
        return { id: c.id, cost: c.cost, edges };
    });
}

function dijkstra(V, adj, src, target) {
    const dist = new Float64Array(V).fill(Infinity);
    const prev = new Array(V).fill(null);
    const heap = new MinHeap();
    dist[src] = 0;
    heap.push(0, src);
    let bestCost = Infinity, bestEdge = null, bestAt = 0;
    while (heap.size) {
        const d = heap.topKey(), u = heap.pop();
        if (d > dist[u]) continue;
        if (d >= bestCost) break;
        for (const e of adj[u]) {
            const at = target(e);
            if (at >= 0 && d + at < bestCost) {
                bestCost = d + at; bestEdge = e; bestAt = at;
            }
            const nd = d + e.len;
            if (nd < dist[e.to]) {
                dist[e.to] = nd;
                prev[e.to] = e;
                heap.push(nd, e.to);
            }
        }
    }
    if (!bestEdge) return null;
    const edges = [bestEdge];
    let n = bestEdge.from;
    while (n !== src) {
        const e = prev[n];
        edges.push(e);
        n = e.from;
    }
    edges.reverse();
    return { edges, at: bestAt };
}

class MinHeap {
    constructor() {
        this.keys = [];
        this.vals = [];
    }

    get size() {
        return this.keys.length;
    }

    topKey() {
        return this.keys[0];
    }

    less(i, j) {
        const a = this.keys[i], b = this.keys[j];
        return a < b || (a === b && this.vals[i] < this.vals[j]);
    }

    swap(i, j) {
        const k = this.keys[i]; this.keys[i] = this.keys[j]; this.keys[j] = k;
        const v = this.vals[i]; this.vals[i] = this.vals[j]; this.vals[j] = v;
    }

    push(key, val) {
        this.keys.push(key);
        this.vals.push(val);
        let i = this.keys.length - 1;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (!this.less(i, p)) break;
            this.swap(i, p);
            i = p;
        }
    }

    pop() {
        const top = this.vals[0];
        const lastK = this.keys.pop(), lastV = this.vals.pop();
        if (this.keys.length) {
            this.keys[0] = lastK;
            this.vals[0] = lastV;
            let i = 0;
            for (;;) {
                const l = 2 * i + 1, r = l + 1;
                let m = i;
                if (l < this.keys.length && this.less(l, m)) m = l;
                if (r < this.keys.length && this.less(r, m)) m = r;
                if (m === i) break;
                this.swap(i, m);
                i = m;
            }
        }
        return top;
    }
}

function polylineLength(pts) {
    let L = 0;
    for (let i = 3; i < pts.length; i += 3) {
        const dx = pts[i] - pts[i - 3], dy = pts[i + 1] - pts[i - 2], dz = pts[i + 2] - pts[i - 1];
        L += Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    return L;
}

// ---------------------------------------------------------------------------
// Polyline assembly

function assemble(chosen, input) {
    const { connectors, paths } = input;
    // Raw polyline: points plus per-segment flags.
    const P = [], UP = [], HW = [];
    const segSurf = [], segGap = [];
    const events = [];
    let s = 0;
    let spawnS = 0;
    const pushPoint = (x, y, z, ux, uy, uz, hw, surf, gap) => {
        const n = P.length / 3;
        if (n > 0) {
            const dx = x - P[P.length - 3], dy = y - P[P.length - 2], dz = z - P[P.length - 1];
            const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (d < 1e-6) return;
            s += d;
            segSurf.push(surf);
            segGap.push(gap);
        }
        P.push(x, y, z);
        UP.push(ux, uy, uz);
        HW.push(hw);
    };

    chosen.forEach(({ edge, cut }, k) => {
        if (edge.path < 0) {
            gapCurve(connectors[edge.gap[0]], connectors[edge.gap[1]], pushPoint);
            return;
        }
        const p = paths[edge.path];
        const n = p.pts.length / 3;
        const startS = s;
        if (k === 0) spawnS = p.spawnAt || 0;
        let along = 0;
        for (let j = 0; j < n; j++) {
            const i = edge.rev ? n - 1 - j : j;
            const x = p.pts[i * 3], y = p.pts[i * 3 + 1], z = p.pts[i * 3 + 2];
            if (j > 0) {
                const q = edge.rev ? i + 1 : i - 1;
                const seg = len3(x - p.pts[q * 3], y - p.pts[q * 3 + 1], z - p.pts[q * 3 + 2]);
                if (cut >= 0 && along + seg >= cut) {
                    // Stop exactly on the finish line.
                    const f = seg > 0 ? (cut - along) / seg : 0;
                    const px = p.pts[q * 3], py = p.pts[q * 3 + 1], pz = p.pts[q * 3 + 2];
                    pushPoint(px + (x - px) * f, py + (y - py) * f, pz + (z - pz) * f,
                        p.ups[i * 3], p.ups[i * 3 + 1], p.ups[i * 3 + 2], p.hw[i], p.surface, 0);
                    break;
                }
                along += seg;
            }
            pushPoint(x, y, z, p.ups[i * 3], p.ups[i * 3 + 1], p.ups[i * 3 + 2], p.hw[i], p.surface, 0);
        }
        for (const ev of edge.events) {
            if (cut >= 0 && ev.at > cut + 1e-9) continue;
            events.push({ type: ev.type, id: ev.id, s: startS + ev.at });
        }
    });

    const raw = { P, UP, HW, segSurf, segGap, length: s };
    const route = resample(raw, ROUTE_STEP);
    const mapS = (rs) => route.sFromRaw(rs);
    const seen = new Set();
    const checkpoints = [];
    let finishS = route.length;
    for (const ev of events) {
        if (ev.type === 'checkpoint' && !seen.has(ev.id)) {
            seen.add(ev.id);
            checkpoints.push({ id: ev.id, s: mapS(ev.s) });
        }
    }
    checkpoints.sort((a, b) => a.s - b.s || a.id - b.id);
    route.checkpoints = checkpoints;
    route.finishS = finishS;
    route.spawnS = mapS(spawnS);
    const n = route.count;
    const dx = route.points[0] - route.points[(n - 1) * 3];
    const dy = route.points[1] - route.points[(n - 1) * 3 + 1];
    const dz = route.points[2] - route.points[(n - 1) * 3 + 2];
    route.closed = dx * dx + dy * dy + dz * dz < 1;
    return route;
}

/** Hermite arc across a jump, from a dangling exit to the landing entry. */
function gapCurve(from, to, pushPoint) {
    const a = from.pos, b = to.pos;
    const ta = from.dir;
    const tb = [-to.dir[0], -to.dir[1], -to.dir[2]];
    const L = len3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const n = Math.max(2, Math.ceil(L / ROUTE_STEP));
    for (let i = 0; i <= n; i++) {
        const t = i / n;
        const t2 = t * t, t3 = t2 * t;
        const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
        const x = h00 * a[0] + h10 * L * ta[0] + h01 * b[0] + h11 * L * tb[0];
        const y = h00 * a[1] + h10 * L * ta[1] + h01 * b[1] + h11 * L * tb[1];
        const z = h00 * a[2] + h10 * L * ta[2] + h01 * b[2] + h11 * L * tb[2];
        pushPoint(x, y, z, 0, 1, 0, 12, NO_SURFACE, 1);
    }
}

function resample(raw, step) {
    const { P, UP, HW, segSurf, segGap, length } = raw;
    const rawN = P.length / 3;
    const n = Math.max(1, Math.ceil(length / step - 1e-9));
    const count = n + 1;
    const pts = new Float64Array(count * 3), ups = new Float64Array(count * 3);
    const hw = new Float64Array(count), surface = new Uint8Array(count), gap = new Uint8Array(count);
    const rawS = new Float64Array(count);
    let seg = 0, segStart = 0;
    const segLen = (i) => len3(P[i * 3 + 3] - P[i * 3], P[i * 3 + 4] - P[i * 3 + 1], P[i * 3 + 5] - P[i * 3 + 2]);
    let curLen = rawN > 1 ? segLen(0) : 0;
    for (let k = 0; k < count; k++) {
        const target = k === n ? length : (length * k) / n;
        while (seg < rawN - 2 && segStart + curLen < target) {
            segStart += curLen;
            seg++;
            curLen = segLen(seg);
        }
        const f = curLen > 0 ? Math.min(1, Math.max(0, (target - segStart) / curLen)) : 0;
        const i0 = seg, i1 = Math.min(seg + 1, rawN - 1);
        for (let c = 0; c < 3; c++) {
            pts[k * 3 + c] = P[i0 * 3 + c] + (P[i1 * 3 + c] - P[i0 * 3 + c]) * f;
            ups[k * 3 + c] = UP[i0 * 3 + c] + (UP[i1 * 3 + c] - UP[i0 * 3 + c]) * f;
        }
        const ul = len3(ups[k * 3], ups[k * 3 + 1], ups[k * 3 + 2]) || 1;
        ups[k * 3] /= ul; ups[k * 3 + 1] /= ul; ups[k * 3 + 2] /= ul;
        hw[k] = HW[i0] + (HW[i1] - HW[i0]) * f;
        surface[k] = rawN > 1 ? segSurf[Math.min(seg, segSurf.length - 1)] : NO_SURFACE;
        gap[k] = rawN > 1 ? segGap[Math.min(seg, segGap.length - 1)] : 0;
        rawS[k] = target;
    }
    return new Route(pts, ups, hw, surface, gap, rawS);
}

// ---------------------------------------------------------------------------
// Route

export class Route {
    /**
     * points/ups: Float64Array (3 per point); halfWidth: Float64Array; surface:
     * Uint8Array (255 = airborne gap); gap: Uint8Array (1 = jump segment).
     */
    constructor(points, ups, halfWidth, surface, gap, rawS = null) {
        const n = halfWidth.length;
        this.count = n;
        this.points = points;
        this.ups = ups;
        this.halfWidth = halfWidth;
        this.surface = surface;
        this.gap = gap;
        this.s = new Float64Array(n);
        this.tangents = new Float64Array(n * 3);   // per point, central difference
        this.segDirs = new Float64Array(Math.max(1, n - 1) * 3);
        this.segLens = new Float64Array(Math.max(1, n - 1));
        for (let i = 0; i + 1 < n; i++) {
            const dx = points[i * 3 + 3] - points[i * 3];
            const dy = points[i * 3 + 4] - points[i * 3 + 1];
            const dz = points[i * 3 + 5] - points[i * 3 + 2];
            const l = Math.sqrt(dx * dx + dy * dy + dz * dz);
            this.segLens[i] = l;
            const inv = l > 0 ? 1 / l : 0;
            this.segDirs[i * 3] = dx * inv; this.segDirs[i * 3 + 1] = dy * inv; this.segDirs[i * 3 + 2] = dz * inv;
            this.s[i + 1] = this.s[i] + l;
        }
        this.length = this.s[n - 1];
        for (let i = 0; i < n; i++) {
            const a = Math.max(0, i - 1), b = Math.min(n - 2, i);
            let tx = this.segDirs[a * 3] + this.segDirs[b * 3];
            let ty = this.segDirs[a * 3 + 1] + this.segDirs[b * 3 + 1];
            let tz = this.segDirs[a * 3 + 2] + this.segDirs[b * 3 + 2];
            const l = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
            this.tangents[i * 3] = tx / l; this.tangents[i * 3 + 1] = ty / l; this.tangents[i * 3 + 2] = tz / l;
        }
        // Curvature in the road frame: lateral (steering, + = right turn) and
        // vertical (+ = compression like a loop or valley, - = crest: airtime).
        this.curvature = new Float64Array(n);
        this.vcurvature = new Float64Array(n);
        for (let i = 1; i + 1 < n; i++) {
            const ds = (this.segLens[i - 1] + this.segLens[i]) / 2;
            if (ds <= 0) continue;
            const dTx = this.segDirs[i * 3] - this.segDirs[i * 3 - 3];
            const dTy = this.segDirs[i * 3 + 1] - this.segDirs[i * 3 - 2];
            const dTz = this.segDirs[i * 3 + 2] - this.segDirs[i * 3 - 1];
            const T = this.tangents, U = ups;
            // right = T x U
            const rx = T[i * 3 + 1] * U[i * 3 + 2] - T[i * 3 + 2] * U[i * 3 + 1];
            const ry = T[i * 3 + 2] * U[i * 3] - T[i * 3] * U[i * 3 + 2];
            const rz = T[i * 3] * U[i * 3 + 1] - T[i * 3 + 1] * U[i * 3];
            this.curvature[i] = (dTx * rx + dTy * ry + dTz * rz) / ds;
            this.vcurvature[i] = (dTx * U[i * 3] + dTy * U[i * 3 + 1] + dTz * U[i * 3 + 2]) / ds;
        }
        this._rawS = rawS;
        this.checkpoints = [];
        this.finishS = this.length;
        this.spawnS = 0;
        this.closed = false;
    }

    /** Maps a distance along the pre-resampling polyline to this route's s. */
    sFromRaw(rs) {
        const raw = this._rawS;
        if (!raw) return rs;
        const n = this.count;
        if (rs <= raw[0]) return 0;
        if (rs >= raw[n - 1]) return this.length;
        let lo = 0, hi = n - 1;
        while (hi - lo > 1) {
            const m = (lo + hi) >> 1;
            if (raw[m] <= rs) lo = m; else hi = m;
        }
        const f = (rs - raw[lo]) / (raw[hi] - raw[lo]);
        return this.s[lo] + (this.s[hi] - this.s[lo]) * f;
    }

    /** Segment index containing distance s (clamped, or wrapped on closed routes). */
    indexAt(s) {
        s = this.wrapS(s);
        const S = this.s;
        let lo = 0, hi = this.count - 1;
        if (s <= 0) return 0;
        if (s >= S[hi]) return Math.max(0, hi - 1);
        while (hi - lo > 1) {
            const m = (lo + hi) >> 1;
            if (S[m] <= s) lo = m; else hi = m;
        }
        return lo;
    }

    wrapS(s) {
        if (!this.closed || this.length <= 0) return s;
        const L = this.length;
        return s - L * Math.floor(s / L);
    }

    /**
     * Point at distance s. Returns out = { point, tangent, up, index, s, halfWidth, surface, gap }.
     */
    pointAt(s, out = null) {
        const o = out || makeSample();
        s = this.wrapS(s);
        const n = this.count;
        if (n === 1) {
            o.point[0] = this.points[0]; o.point[1] = this.points[1]; o.point[2] = this.points[2];
            return o;
        }
        const i = this.indexAt(s);
        const L = this.segLens[i];
        let f = L > 0 ? (s - this.s[i]) / L : 0;
        if (f < 0) f = 0; else if (f > 1) f = 1;
        const P = this.points, U = this.ups;
        for (let c = 0; c < 3; c++) {
            o.point[c] = P[i * 3 + c] + (P[i * 3 + 3 + c] - P[i * 3 + c]) * f;
            o.tangent[c] = this.segDirs[i * 3 + c];
            o.up[c] = U[i * 3 + c] + (U[i * 3 + 3 + c] - U[i * 3 + c]) * f;
        }
        const ul = len3(o.up[0], o.up[1], o.up[2]) || 1;
        o.up[0] /= ul; o.up[1] /= ul; o.up[2] /= ul;
        o.index = i;
        o.s = this.s[i] + L * f;
        o.halfWidth = this.halfWidth[i] + (this.halfWidth[i + 1] - this.halfWidth[i]) * f;
        o.surface = this.surface[i];
        o.gap = this.gap[i];
        return o;
    }

    /**
     * Nearest point on the route. Searches around `hint` (a previous result's
     * index) first and falls back to a global scan when that is far off.
     * Returns out = { s, index, t, point, tangent, up, lateral, vertical, dist, halfWidth }.
     * lateral > 0 means right of the centerline (right = tangent x up).
     */
    project(pos, hint = -1, out = null) {
        const o = out || makeProjection();
        const n = this.count;
        const segs = n - 1;
        let best = Infinity, bi = 0, bt = 0;
        if (segs <= 0) {
            bi = 0; bt = 0;
        } else {
            let edge = true;
            if (hint >= 0 && hint < segs) {
                let bk = 0, kLo = Infinity, kHi = -Infinity;
                for (let k = -LOCAL_BACK; k <= LOCAL_AHEAD; k++) {
                    let i = hint + k;
                    if (this.closed) i = ((i % segs) + segs) % segs;
                    else if (i < 0 || i >= segs) continue;
                    if (k < kLo) kLo = k;
                    if (k > kHi) kHi = k;
                    const r = this._segDist2(pos, i);
                    if (r < best) { best = r; bi = i; bt = this._t; bk = k; }
                }
                // A best segment on the window's edge (not a route end), or one well off the
                // road, means the true nearest may lie elsewhere: a stale hint after a respawn
                // or rewind. Then scan everything.
                const lim = (this.halfWidth[bi] + LOCAL_SLACK) * (this.halfWidth[bi] + LOCAL_SLACK);
                edge = (bk === kLo && kLo === -LOCAL_BACK) || (bk === kHi && kHi === LOCAL_AHEAD) || best > lim;
            }
            if (edge) {
                best = Infinity;
                for (let i = 0; i < segs; i++) {
                    const r = this._segDist2(pos, i);
                    if (r < best) { best = r; bi = i; bt = this._t; }
                }
            }
        }
        const P = this.points, U = this.ups;
        const i1 = Math.min(bi + 1, n - 1);
        for (let c = 0; c < 3; c++) {
            o.point[c] = P[bi * 3 + c] + (P[i1 * 3 + c] - P[bi * 3 + c]) * bt;
            o.tangent[c] = segs > 0 ? this.segDirs[bi * 3 + c] : 0;
            o.up[c] = U[bi * 3 + c] + (U[i1 * 3 + c] - U[bi * 3 + c]) * bt;
        }
        const ul = len3(o.up[0], o.up[1], o.up[2]) || 1;
        o.up[0] /= ul; o.up[1] /= ul; o.up[2] /= ul;
        const T = o.tangent, Up = o.up;
        const rx = T[1] * Up[2] - T[2] * Up[1], ry = T[2] * Up[0] - T[0] * Up[2], rz = T[0] * Up[1] - T[1] * Up[0];
        const dx = pos[0] - o.point[0], dy = pos[1] - o.point[1], dz = pos[2] - o.point[2];
        o.lateral = dx * rx + dy * ry + dz * rz;
        o.vertical = dx * Up[0] + dy * Up[1] + dz * Up[2];
        o.dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        o.index = bi;
        o.t = bt;
        o.s = this.s[bi] + (segs > 0 ? this.segLens[bi] * bt : 0);
        o.halfWidth = this.halfWidth[bi] + (this.halfWidth[i1] - this.halfWidth[bi]) * bt;
        return o;
    }

    _segDist2(p, i) {
        const P = this.points;
        const ax = P[i * 3], ay = P[i * 3 + 1], az = P[i * 3 + 2];
        const dx = P[i * 3 + 3] - ax, dy = P[i * 3 + 4] - ay, dz = P[i * 3 + 5] - az;
        const l2 = dx * dx + dy * dy + dz * dz;
        let t = l2 > 0 ? ((p[0] - ax) * dx + (p[1] - ay) * dy + (p[2] - az) * dz) / l2 : 0;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        this._t = t;
        const ex = ax + dx * t - p[0], ey = ay + dy * t - p[1], ez = az + dz * t - p[2];
        return ex * ex + ey * ey + ez * ez;
    }

    /** Lateral curvature (1/m, + = right) at distance s, interpolated. */
    curvatureAt(s) {
        const i = this.indexAt(s);
        const L = this.segLens[i] || 1;
        const f = Math.min(1, Math.max(0, (this.wrapS(s) - this.s[i]) / L));
        const c = this.curvature;
        return c[i] + (c[Math.min(i + 1, this.count - 1)] - c[i]) * f;
    }

    /** Signed heading change (rad, + = right) accumulated between s0 and s1 (s1 > s0). */
    headingChange(s0, s1) {
        let sum = 0;
        const step = ROUTE_STEP;
        for (let s = s0; s < s1; s += step) {
            const ds = Math.min(step, s1 - s);
            sum += this.curvatureAt(s + ds / 2) * ds;
        }
        return sum;
    }

    /** Largest |lateral curvature| between s0 and s1. */
    maxCurvature(s0, s1) {
        let m = 0;
        for (let s = s0; s <= s1; s += ROUTE_STEP / 2) {
            const c = Math.abs(this.curvatureAt(s));
            if (c > m) m = c;
        }
        return m;
    }

    /** Horizontal heading (yaw, 0 = +Z, - = toward -X/right) of the route at s. */
    headingAt(s) {
        const i = this.indexAt(s);
        return datan2(this.segDirs[i * 3], this.segDirs[i * 3 + 2]);
    }

    /** Distance remaining to the finish line from s (one lap on closed routes). */
    remaining(s) {
        return Math.max(0, this.finishS - s);
    }

    /**
     * Cheap 2D road-edge sensors for AI observations. From `pos`, casts one ray per
     * entry of `angles` (radians from `heading`, + = right; heading = a unit
     * horizontal [x, z] direction) against the left and right road edges
     * (centerline ± halfWidth along the deck's right vector, seen from above) of
     * the route segments within `back` metres behind and `maxDist + back` ahead of
     * the car's projection, ignoring jumps and edges more than 6 m above or below
     * the car. Writes the distance to the first edge (or maxDist) into out[i].
     * O(rays × segments in the window), with no 3D grid walk: far cheaper than
     * long CollisionMesh raycasts. Pass the previous projection index as hint.
     */
    edgeRays(pos, heading, angles, maxDist, out = null, hint = -1, back = 20) {
        const res = out || new Float64Array(angles.length);
        const pr = this.project(pos, hint, this._edgeProj || (this._edgeProj = makeProjection()));
        const n = this.count, segs = n - 1;
        const hx = heading[0], hz = heading[1];
        const sc = this._sc || (this._sc = [0, 0]);
        const dirs = this._rayDirs && this._rayDirs.length >= angles.length * 2 ? this._rayDirs : (this._rayDirs = new Float64Array(angles.length * 2));
        for (let k = 0; k < angles.length; k++) {
            dsincos(angles[k], sc);
            // Rotate the heading toward its right-hand side (-hz, hx) by the angle.
            dirs[2 * k] = sc[1] * hx - sc[0] * hz;
            dirs[2 * k + 1] = sc[1] * hz + sc[0] * hx;
            res[k] = maxDist;
        }
        if (segs <= 0) return res;
        const P = this.points, U = this.ups, T = this.tangents, HW = this.halfWidth;
        const px = pos[0], py = pos[1], pz = pos[2];
        // Walk segments from `back` metres behind to maxDist + back ahead.
        let i = pr.index;
        for (let d = 0; d < back;) {
            if (i === 0) {
                if (!this.closed) break;
                i = segs;
            }
            i--;
            d += this.segLens[i];
        }
        let travelled = 0;
        const limit = maxDist + 2 * back;
        for (let step = 0; step < segs && travelled < limit; step++) {
            const j = i + 1;
            if (!this.gap[i] && !this.gap[j]) {
                const y = (P[i * 3 + 1] + P[j * 3 + 1]) / 2;
                if (y - py < 6 && py - y < 6) {
                    for (let side = -1; side <= 1; side += 2) {
                        const ax = P[i * 3] + side * HW[i] * rightX(T, U, i), az = P[i * 3 + 2] + side * HW[i] * rightZ(T, U, i);
                        const bx = P[j * 3] + side * HW[j] * rightX(T, U, j), bz = P[j * 3 + 2] + side * HW[j] * rightZ(T, U, j);
                        const ex = bx - ax, ez = bz - az;
                        for (let k = 0; k < angles.length; k++) {
                            const dx = dirs[2 * k], dz = dirs[2 * k + 1];
                            const den = dx * ez - dz * ex;
                            if (den > -1e-12 && den < 1e-12) continue;
                            const qx = ax - px, qz = az - pz;
                            const t = (qx * ez - qz * ex) / den;
                            const u = (qx * dz - qz * dx) / den;
                            if (t >= 0 && t < res[k] && u >= 0 && u <= 1) res[k] = t;
                        }
                    }
                }
            }
            travelled += this.segLens[i];
            i++;
            if (i >= segs) {
                if (!this.closed) break;
                i = 0;
            }
        }
        return res;
    }
}

/** X and Z of the right vector (tangent x up) at route point i. */
function rightX(T, U, i) {
    return T[i * 3 + 1] * U[i * 3 + 2] - T[i * 3 + 2] * U[i * 3 + 1];
}

function rightZ(T, U, i) {
    return T[i * 3] * U[i * 3 + 1] - T[i * 3 + 1] * U[i * 3];
}

/**
 * Lap-aware progress along a route for everyone who needs it (AI rewards, HUD,
 * TAS fitness, standings, the autopilot): keeps the projection hint, unwraps
 * closed routes, handles respawns (the car only ever jumps back), and keeps the
 * best progress and when it was reached (a "stuck" timer).
 *
 *   const tr = new RouteTracker(world.route);
 *   sim.step(input); tr.track(sim);     // or tr.update(pos, tick, respawned)
 *   tr.progress; tr.lap; tr.s; tr.lateral; tr.dist; tr.halfWidth; tr.gap; tr.best; tr.bestTick
 *
 * track(sim) notices respawns from sim.respawns (sim state, not events), so a
 * tracker restored with getState/setState next to a sim savestate resumes the same.
 */
export class RouteTracker {
    constructor(route) {
        this.route = route;
        this._proj = makeProjection();
        this.reset();
    }

    reset() {
        this.hint = -1;
        this.lastS = null;
        this.seenRespawns = 0;
        this.progress = 0;     // unwrapped metres along the route (closed routes keep counting)
        this.best = 0;
        this.bestTick = 0;
        this.s = 0; this.index = 0; this.lateral = 0; this.vertical = 0; this.dist = 0; this.halfWidth = 0; this.gap = 0;
        this.lap = 1;
    }

    /** Projects pos; `respawned` = the car was teleported back this tick (respawn, rewind). */
    update(pos, tick = 0, respawned = false) {
        const r = this.route;
        if (respawned) this.hint = -1;
        const pr = r.project(pos, this.hint, this._proj);
        this.hint = pr.index;
        const s = pr.s;
        if (this.lastS === null) {
            this.progress = s;
            this.best = s;
            this.bestTick = tick;
        } else {
            let d = s - this.lastS;
            if (r.closed) {
                const L = r.length;
                if (respawned) { if (d > 0) d -= L; }   // a respawn never moves the car forward
                else if (d < -L / 2) d += L;
                else if (d > L / 2) d -= L;
            }
            this.progress += d;
            if (respawned) {
                this.best = this.progress;
                this.bestTick = tick;
            }
        }
        this.lastS = s;
        if (this.progress > this.best + 1) {
            this.best = this.progress;
            this.bestTick = tick;
        }
        this.s = s; this.index = pr.index; this.lateral = pr.lateral; this.vertical = pr.vertical;
        this.dist = pr.dist; this.halfWidth = pr.halfWidth; this.gap = r.gap[pr.index];
        this.lap = r.closed && r.length > 0 ? 1 + Math.floor(this.progress / r.length) : 1;
        return this;
    }

    /** update() from a Sim (call it after each step, or before deciding the next input). */
    track(sim) {
        const respawned = sim.respawns !== this.seenRespawns;
        this.seenRespawns = sim.respawns;
        return this.update(sim.car.pos, sim.tick, respawned);
    }

    getState() {
        return {
            hint: this.hint, lastS: this.lastS, progress: this.progress + 0, best: this.best + 0,
            bestTick: this.bestTick, seenRespawns: this.seenRespawns,
        };
    }

    setState(st) {
        this.hint = st.hint; this.lastS = st.lastS; this.progress = st.progress; this.best = st.best;
        this.bestTick = st.bestTick; this.seenRespawns = st.seenRespawns;
    }
}

function makeSample() {
    return { point: [0, 0, 0], tangent: [0, 0, 1], up: [0, 1, 0], index: 0, s: 0, halfWidth: 0, surface: 0, gap: 0 };
}

function makeProjection() {
    return { s: 0, index: 0, t: 0, point: [0, 0, 0], tangent: [0, 0, 1], up: [0, 1, 0], lateral: 0, vertical: 0, dist: 0, halfWidth: 0 };
}
