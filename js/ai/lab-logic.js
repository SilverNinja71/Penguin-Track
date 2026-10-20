// AI Lab logic without DOM: training presets and settings, run configs for the
// env / network / trainer, which agents of a generation to show, colours,
// model files in the 'ai' storage key, and import parsing. js/ai/lab.js is the
// screen on top; tools/tests/ai-lab.test.mjs covers this file in Node.
import { normalizeEnvConfig } from './env.js';
import { archFor, makeModelFile, loadModelFile, MODEL_FILE_FORMAT } from './policy.js';
import { LocalEvaluator, GA_DEFAULTS, ES_DEFAULTS } from './neuro.js';
import { decodeTrack, trackHash } from '../core/codec.js';

export const STORAGE_KEY = 'ai';
export const MAX_SHOWN = 32;

export const LOOKAHEADS = Object.freeze({
    near: Object.freeze([10, 25, 50]),
    standard: Object.freeze([10, 25, 50, 90]),
    far: Object.freeze([10, 25, 50, 90, 150]),
});

export const HIDDEN_OPTIONS = ['16', '32', '16,16', '32,32', '64,64', '64,32,16'];

const BASE = Object.freeze({
    algo: 'ga', popSize: 64, hidden: '32,32', mutation: GA_DEFAULTS.mutationStd, sigma: ES_DEFAULTS.sigma,
    lr: ES_DEFAULTS.lr, frameSkip: 4, maxSeconds: 'auto', edgeRays: 15, fov: 180, lookahead: 'standard',
    wallRays: 0, action: 'discrete', startMode: 'start', episodes: 1, generations: 100, seed: 1, workers: 0,
});

export const PRESETS = Object.freeze({
    quick: Object.freeze({
        ...BASE, label: 'Quick', blurb: 'Small brain, small flock: first laps in under a minute.',
        popSize: 32, hidden: '16', mutation: 0.05, frameSkip: 5, edgeRays: 9, generations: 30,
    }),
    balanced: Object.freeze({
        ...BASE, label: 'Balanced', blurb: 'The tools/train.mjs defaults: beats the autopilot on most tracks.',
    }),
    deep: Object.freeze({
        ...BASE, label: 'Deep', blurb: 'Big network, evolution strategies, long look-ahead. Leave it running.',
        algo: 'es', popSize: 128, hidden: '64,64', edgeRays: 21, lookahead: 'far', generations: 300,
    }),
});

export const PRESET_IDS = Object.keys(PRESETS);

const num = (v, d) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
};
const clampNum = (v, lo, hi, d) => Math.min(hi, Math.max(lo, num(v, d)));
const intIn = (v, lo, hi, d) => Math.round(clampNum(v, lo, hi, d));
const oneOf = (v, list, d) => (list.includes(v) ? v : d);

/** Parses '32,32' (or [32, 32]) into a hidden-layer list; null when malformed. */
export function parseHidden(text) {
    const parts = Array.isArray(text) ? text : String(text ?? '').split(/[\s,x×-]+/).filter(Boolean);
    const out = parts.map(Number);
    if (!out.length || out.length > 4 || !out.every((n) => Number.isInteger(n) && n >= 1 && n <= 256)) return null;
    return out;
}

/** A complete, valid settings object (unknown or bad values fall back to the preset / Balanced). */
export function sanitizeSettings(s = {}, base = PRESETS.balanced) {
    const b = { ...BASE, ...base };
    const algo = oneOf(s.algo, ['ga', 'es'], b.algo);
    let popSize = intIn(s.popSize, 4, 512, b.popSize);
    if (algo === 'es' && popSize % 2) popSize++;   // antithetic pairs
    const hidden = parseHidden(s.hidden) ? parseHidden(s.hidden).join(',') : b.hidden;
    const maxSeconds = s.maxSeconds === 'auto' || s.maxSeconds == null || s.maxSeconds === '' ? 'auto' : intIn(s.maxSeconds, 10, 600, 60);
    return {
        algo, popSize, hidden,
        mutation: clampNum(s.mutation, 0.001, 0.5, b.mutation),
        sigma: clampNum(s.sigma, 0.001, 0.5, b.sigma),
        lr: clampNum(s.lr, 0.0001, 0.5, b.lr),
        frameSkip: intIn(s.frameSkip, 1, 20, b.frameSkip),
        maxSeconds,
        edgeRays: intIn(s.edgeRays, 0, 64, b.edgeRays),
        fov: intIn(s.fov, 30, 360, b.fov),
        lookahead: oneOf(s.lookahead, Object.keys(LOOKAHEADS), b.lookahead),
        wallRays: intIn(s.wallRays, 0, 32, b.wallRays),
        action: oneOf(s.action, ['discrete', 'continuous'], b.action),
        startMode: oneOf(s.startMode, ['start', 'random-checkpoint', 'random'], b.startMode),
        episodes: intIn(s.episodes, 1, 8, b.episodes),
        generations: intIn(s.generations, 0, 100000, b.generations),
        seed: intIn(s.seed, 0, 0x7fffffff, b.seed),
        workers: intIn(s.workers, 0, 64, 0),
    };
}

/** Settings of a preset id. */
export function presetSettings(id) {
    const p = PRESETS[id] || PRESETS.balanced;
    return sanitizeSettings(p, p);
}

/** Which preset the settings equal (ignoring seed and workers), or null. */
export function matchPreset(s) {
    const a = sanitizeSettings(s);
    for (const id of PRESET_IDS) {
        const p = presetSettings(id);
        if (Object.keys(p).every((k) => k === 'seed' || k === 'workers' || p[k] === a[k])) return id;
    }
    return null;
}

/** Episode budget for a world, like tools/train.mjs --max-seconds auto: route / 15 m/s, >= 30 s, steps of 10. */
export function autoSeconds(world) {
    const r = world.route;
    if (!r) return 60;
    const total = r.length * (r.closed ? world.laps || 1 : 1);
    return Math.max(30, Math.ceil(total / 15 / 10) * 10);
}

/** Normalized env config for settings on a world. */
export function envConfigFor(settings, world) {
    const s = sanitizeSettings(settings);
    return normalizeEnvConfig({
        frameSkip: s.frameSkip,
        maxSeconds: s.maxSeconds === 'auto' ? autoSeconds(world) : s.maxSeconds,
        action: s.action,
        startMode: s.startMode,
        obs: { edgeRays: s.edgeRays, fov: s.fov, rayLength: 120, lookahead: LOOKAHEADS[s.lookahead].slice(), collisionRays: s.wallRays },
    });
}

/**
 * Everything a training run needs: { envConfig, arch, trainer: NeuroTrainer
 * options without the evaluator, generations, episodes, workerInit }. With
 * `from` (a loaded model) the env config and network come from the model, so
 * training continues from its weights.
 */
export function runConfig(settings, world, from = null) {
    const s = sanitizeSettings(settings);
    const envConfig = from ? normalizeEnvConfig({ ...from.envConfig, startMode: s.startMode }) : envConfigFor(s, world);
    const arch = from ? from.net.arch : archFor(envConfig, parseHidden(s.hidden));
    const trainer = {
        algo: s.algo, arch, seed: s.seed, popSize: s.popSize,
        ga: { mutationStd: s.mutation },
        es: { sigma: s.sigma, lr: s.lr },
        initParams: from ? Array.from(from.net.getParams()) : null,
    };
    return {
        envConfig, arch, trainer, generations: s.generations, episodes: s.episodes,
        workerInit: { trackJSON: world.track, envConfig, arch, episodes: s.episodes, fitness: 'race' },
    };
}

/** Network label: '75-32-32-9'. */
export function archLabel(arch) {
    return arch && arch.sizes ? arch.sizes.join('-') : '?';
}

/** Weights in an architecture. */
export function paramCountOf(arch) {
    let n = 0;
    for (let i = 0; i + 1 < arch.sizes.length; i++) n += arch.sizes[i] * arch.sizes[i + 1] + arch.sizes[i + 1];
    return n;
}

/** Candidate indices sorted best first (ties: lower index first). */
export function rankOrder(fitness) {
    const idx = fitness.map((_, i) => i);
    idx.sort((a, b) => (fitness[b] - fitness[a]) || (a - b));
    return idx;
}

/**
 * Which candidates of a generation to draw: all when they fit, else `cap`
 * spread evenly over the ranking (always the best and the worst), so the field
 * shows the whole flock and not only the leaders. Returns
 * [{ index, rank }] best first.
 */
export function pickShown(fitness, cap = MAX_SHOWN) {
    const order = rankOrder(fitness);
    const n = order.length;
    if (n <= cap) return order.map((index, rank) => ({ index, rank }));
    const out = [];
    const seen = new Set();
    for (let k = 0; k < cap; k++) {
        const rank = Math.round((k * (n - 1)) / (cap - 1));
        if (seen.has(rank)) continue;
        seen.add(rank);
        out.push({ index: order[rank], rank });
    }
    return out;
}

/** Car colour for a rank among n: gold for the best, then ice cyan through violet to rose. */
export function rankColor(rank, n) {
    if (rank === 0) return '#ffd54a';
    const f = n > 2 ? (rank - 1) / (n - 2) : 0;
    return hslHex(190 + f * 150, 0.85, 0.62 - f * 0.08);
}

function hslHex(hDeg, s, l) {
    const h = ((hDeg % 360) + 360) % 360 / 360;
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    const ch = (t) => {
        t = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
        const v = t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
        return Math.round(v * 255).toString(16).padStart(2, '0');
    };
    return `#${ch(h + 1 / 3)}${ch(h)}${ch(h - 1 / 3)}`;
}

/** Trainer stats rows (objects) and model-file rows ([g, best, mean, finish, time]) as chart points. */
export function historyRows(history) {
    return (history || []).map((r) => (Array.isArray(r)
        ? { generation: r[0], best: r[1], mean: r[2], finishRate: r[3], bestTimeMs: r[4] ?? null }
        : { generation: r.generation, best: r.best, mean: r.mean, finishRate: r.finishRate, bestTimeMs: r.bestTimeMs ?? null }));
}

/** Model-file history rows ([g, best, mean, finish, time], rounded like tools/train.mjs). */
export function compactHistory(history) {
    const r3 = (x) => Math.round(x * 1000) / 1000;
    return historyRows(history).map((h) => [h.generation, r3(h.best), r3(h.mean), r3(h.finishRate), h.bestTimeMs]);
}

/** Axis range with a little headroom and round-ish ends. */
export function niceRange(values, pad = 0.06) {
    const v = values.filter((x) => Number.isFinite(x));
    if (!v.length) return [0, 1];
    let lo = Math.min(...v), hi = Math.max(...v);
    if (hi - lo < 1e-9) {
        lo -= 1;
        hi += 1;
    }
    const span = hi - lo;
    return [lo - span * pad, hi + span * pad];
}

/**
 * Drives weights once from the start line (startMode 'start'): { r: { fitness,
 * info, replay }, net (holding the weights) }. Random-start training episodes
 * begin with an autopilot prefix; this is the clean run used for ghosts.
 */
export function redrive({ world, envConfig, arch, params }) {
    const ev = new LocalEvaluator({ world, envConfig: { ...envConfig, startMode: 'start' }, arch, episodes: 1, fitness: 'race' });
    const r = ev.evaluateOne(params, { seed: 0, replay: true });
    ev.net.setParams(params);
    return { r, net: ev.net };
}

/**
 * A model file from a training run, exactly like tools/train.mjs writes it:
 * the best weights are driven once more from the start line (startMode
 * 'start') so the stored replay is a proper ghost. run: { algo, seed,
 * generation, evaluations, popSize, history, best: { params, fitness,
 * generation } }.
 */
export function buildModelFile({ name, world, envConfig, arch, run, trainSeconds = 0, date = null }) {
    const { r, net } = redrive({ world, envConfig, arch, params: run.best.params });
    const stats = {
        algo: run.algo, fitness: 'race', seed: run.seed, generations: run.generation, evaluations: run.evaluations,
        popSize: run.popSize, hidden: arch.sizes.slice(1, -1), bestFitness: run.best.fitness,
        bestGeneration: run.best.generation, return: r.info.episodeReturn, finished: r.info.finished,
        timeMs: r.info.finished ? r.info.finishTimeMs : null, progressFrac: r.info.progressFrac,
        reason: r.info.reason, trainSeconds: Math.round(trainSeconds), history: compactHistory(run.history),
    };
    return makeModelFile({
        name, world, envConfig, net, stats, date,
        replay: { ...r.replay, name: `${name} (AI)` },
    });
}

/** One-line facts about a model file for lists. */
export function modelSummary(file) {
    const st = file.stats || {};
    const sizes = file.net && file.net.sizes;
    return {
        name: file.name || 'Penguin driver',
        trackId: file.trackId || null,
        trackName: file.trackName || file.trackId || 'Unknown track',
        arch: sizes ? sizes.join('-') : '?',
        algo: st.algo ? String(st.algo).toUpperCase() : null,
        generations: st.generations ?? null,
        finished: !!(st.finished ?? (file.replay && file.replay.finished)),
        timeMs: st.timeMs ?? (file.replay && file.replay.finished ? file.replay.timeMs : null),
        progressFrac: st.progressFrac ?? null,
        date: file.date || null,
    };
}

/** Saved models, newest first: [{ name, file }]. */
export function listModels(storage) {
    const all = storage.get(STORAGE_KEY, {}) || {};
    return Object.keys(all)
        .filter((k) => all[k] && all[k].format === MODEL_FILE_FORMAT)
        .map((name) => ({ name, file: all[name] }))
        .sort((a, b) => String(b.file.date || '').localeCompare(String(a.file.date || '')) || a.name.localeCompare(b.name));
}

/** Stores a model file under its name (replacing one with that name). Returns false when storage is full. */
export function saveModel(storage, file) {
    const all = { ...(storage.get(STORAGE_KEY, {}) || {}) };
    all[file.name] = file;
    return storage.set(STORAGE_KEY, all) !== false;
}

export function deleteModel(storage, name) {
    const all = { ...(storage.get(STORAGE_KEY, {}) || {}) };
    if (!(name in all)) return false;
    delete all[name];
    storage.set(STORAGE_KEY, all);
    return true;
}

/** `base`, or `base (2)`, `base (3)`… not in `taken`. */
export function uniqueName(base, taken) {
    const set = new Set(taken);
    const b = String(base || 'Penguin driver').trim().slice(0, 60) || 'Penguin driver';
    if (!set.has(b)) return b;
    for (let i = 2; ; i++) if (!set.has(`${b} (${i})`)) return `${b} (${i})`;
}

/**
 * What an imported text is: { kind: 'model', file } (tools/train.mjs, the Lab),
 * { kind: 'train-run', run } (a tools/train.mjs .state.json: resumable),
 * { kind: 'other' } for anything else (replay JSON from Python / TAS, PTR codes:
 * the caller hands those to the replay-code decoder). Throws on broken models.
 */
export function classifyImport(text) {
    const clean = String(text || '').trim();
    if (!clean.startsWith('{')) return { kind: 'other' };
    let data;
    try {
        data = JSON.parse(clean);
    } catch (e) {
        throw new Error("That file isn't valid JSON.");
    }
    if (data && data.format === MODEL_FILE_FORMAT) {
        loadModelFile(data);   // throws when the network does not fit its env config
        return { kind: 'model', file: data };
    }
    if (data && data.format === 'penguintrack-train-run' && data.trainer && data.trackCode) return { kind: 'train-run', run: data };
    return { kind: 'other' };
}

/**
 * The track a model (or train-run) belongs to: the catalog's track when its
 * layout hash matches, else the embedded share code. getTrack(id) -> JSON | null.
 */
export function trackForFile(file, getTrack) {
    const byId = file.trackId ? getTrack(file.trackId) : null;
    if (byId && (!file.trackHash || trackHash(byId) === file.trackHash)) return byId;
    if (file.trackCode) {
        const t = decodeTrack(file.trackCode);
        if (file.trackId && !t.id) t.id = file.trackId;
        return t;
    }
    return byId;
}

/** Plain-language end of an episode. */
export function reasonLabel(reason) {
    return {
        finish: 'finished', fall: 'fell off', stuck: 'got stuck', 'wrong-way': 'turned back',
        'off-route': 'left the road', time: 'ran out of time',
    }[reason] || (reason ? String(reason) : 'driving');
}
