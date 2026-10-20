// Neuroevolution: a simple genetic algorithm (elitism, crossover, gaussian
// mutation) and OpenAI-style evolution strategies (antithetic sampling,
// rank-normalised fitness, Adam), behind one ask/tell interface, plus the
// NeuroTrainer loop with a pluggable evaluator (in-thread, Node worker_threads
// or browser Web Workers, see pool.js / worker.js). Everything random comes
// from seeded core Rngs, so the same seed gives the same training curve.
import { MLP, roundF32, encodeF32, decodeF32, encodeF64, decodeF64 } from './nn.js';
import { PenguinEnv } from './env.js';
import { makePolicy, runEpisode } from './policy.js';
import { Rng, hashSeed } from '../core/rng.js';

export const GA_DEFAULTS = Object.freeze({
    popSize: 64,
    eliteCount: 4,           // copied unchanged into the next generation
    parentFraction: 0.25,    // parents come from this top fraction (tournament of two)
    crossover: 0.25,         // chance a child mixes two parents (neuron-wise)
    mutationRate: 1,         // fraction of genes mutated per child
    mutationStd: 0.03,
});

export const ES_DEFAULTS = Object.freeze({
    popSize: 64,             // even: popSize / 2 antithetic pairs
    sigma: 0.04,             // perturbation scale
    lr: 0.02,                // Adam step size
    l2: 0.002,               // weight decay
    beta1: 0.9,
    beta2: 0.999,
    evalMean: true,          // also evaluate the mean (reported, may become the best)
});

/** Centered ranks in [-0.5, 0.5] (ties broken by index, so the order is deterministic). */
export function centeredRanks(values) {
    const n = values.length;
    const idx = Array.from({ length: n }, (_, i) => i);
    idx.sort((a, b) => (values[a] - values[b]) || (a - b));
    const out = new Float64Array(n);
    for (let r = 0; r < n; r++) out[idx[r]] = n > 1 ? r / (n - 1) - 0.5 : 0;
    return out;
}

/** Indices sorted best (highest fitness) first; ties keep the lower index first. */
function bestFirst(fitness) {
    const idx = Array.from({ length: fitness.length }, (_, i) => i);
    idx.sort((a, b) => (fitness[b] - fitness[a]) || (a - b));
    return idx;
}

/** Neuron blocks [start, length] of an MLP parameter vector (weights row + bias of each unit). */
function neuronBlocks(sizes) {
    const rows = [];
    let k = 0;
    for (let l = 0; l + 1 < sizes.length; l++) {
        const nIn = sizes[l], nOut = sizes[l + 1];
        for (let o = 0; o < nOut; o++) rows.push({ w: k + o * nIn, n: nIn, b: k + nIn * nOut + o });
        k += nIn * nOut + nOut;
    }
    return rows;
}

export class GA {
    /**
     * opts: GA_DEFAULTS plus { paramCount, init(rng) -> Float64Array, seed,
     * arch (enables neuron-wise crossover) }.
     */
    constructor(opts) {
        this.opts = { ...GA_DEFAULTS, ...opts };
        const o = this.opts;
        if (!(o.popSize >= 2)) throw new Error('GA popSize must be at least 2');
        this.paramCount = o.paramCount;
        this.rng = new Rng(o.seed ?? 1);
        this.blocks = o.arch ? neuronBlocks(o.arch.sizes) : null;
        this.population = [];
        if (o.population) {
            this.population = o.population.map((p) => Float64Array.from(p));
        } else {
            for (let i = 0; i < o.popSize; i++) this.population.push(roundF32(Float64Array.from(o.init(this.rng))));
        }
    }

    /** Parameter vectors to evaluate this generation. */
    ask() {
        return this.population;
    }

    /** Fitness per asked vector -> breeds the next generation. */
    tell(fitness) {
        const o = this.opts, rng = this.rng, pop = this.population;
        const order = bestFirst(fitness);
        const next = [];
        const elites = Math.min(o.eliteCount, pop.length);
        for (let e = 0; e < elites; e++) next.push(Float64Array.from(pop[order[e]]));
        const nParents = Math.max(2, Math.min(pop.length, Math.round(pop.length * o.parentFraction)));
        const pick = () => {
            const a = rng.int(nParents), b = rng.int(nParents);
            return pop[order[a < b ? a : b]];
        };
        while (next.length < o.popSize) {
            const a = pick();
            const child = Float64Array.from(a);
            if (o.crossover > 0 && rng.chance(o.crossover)) this._cross(child, pick());
            this._mutate(child);
            next.push(roundF32(child));
        }
        this.population = next;
    }

    _cross(child, b) {
        const rng = this.rng;
        if (this.blocks) {
            for (const blk of this.blocks) {
                if (!rng.chance(0.5)) continue;
                for (let i = 0; i < blk.n; i++) child[blk.w + i] = b[blk.w + i];
                child[blk.b] = b[blk.b];
            }
        } else {
            for (let i = 0; i < child.length; i++) if (rng.chance(0.5)) child[i] = b[i];
        }
    }

    _mutate(child) {
        const o = this.opts, rng = this.rng;
        if (o.mutationRate >= 1) {
            for (let i = 0; i < child.length; i++) child[i] += rng.normal(0, o.mutationStd);
        } else {
            for (let i = 0; i < child.length; i++) if (rng.chance(o.mutationRate)) child[i] += rng.normal(0, o.mutationStd);
        }
    }

    getState() {
        const { init, population, ...opts } = this.opts;
        return { algo: 'ga', opts, rng: this.rng.getState(), population: this.population.map((p) => encodeF32(p)) };
    }

    static fromState(st, extra = {}) {
        const ga = new GA({ ...st.opts, ...extra, population: st.population.map((s) => decodeF32(s)) });
        ga.rng.setState(st.rng);
        return ga;
    }
}

export class ES {
    /** opts: ES_DEFAULTS plus { paramCount, init(rng) -> Float64Array (the start mean), seed }. */
    constructor(opts) {
        this.opts = { ...ES_DEFAULTS, ...opts };
        const o = this.opts;
        if (!(o.popSize >= 2) || o.popSize % 2) throw new Error('ES popSize must be even (antithetic pairs)');
        this.rng = new Rng(o.seed ?? 1);
        this.theta = o.theta ? Float64Array.from(o.theta) : roundF32(Float64Array.from(o.init(this.rng)));
        this.paramCount = this.theta.length;
        this.m = new Float64Array(this.paramCount);
        this.v = new Float64Array(this.paramCount);
        this.t = 0;
        this.b1t = 1;
        this.b2t = 1;
        this._eps = [];
    }

    /** popSize antithetic candidates (θ + σε, then θ − σε), plus the mean when evalMean. */
    ask() {
        const o = this.opts, half = o.popSize / 2, n = this.paramCount, rng = this.rng;
        this._eps = [];
        for (let i = 0; i < half; i++) {
            const e = new Float64Array(n);
            for (let j = 0; j < n; j++) e[j] = rng.normal(0, 1);
            this._eps.push(e);
        }
        const out = [];
        for (const sign of [1, -1]) {
            for (const e of this._eps) {
                const c = new Float64Array(n);
                for (let j = 0; j < n; j++) c[j] = this.theta[j] + sign * o.sigma * e[j];
                out.push(roundF32(c));
            }
        }
        if (o.evalMean) out.push(roundF32(Float64Array.from(this.theta)));
        return out;
    }

    /** Fitness per asked candidate (the trailing mean entry is ignored for the gradient). */
    tell(fitness) {
        const o = this.opts, half = o.popSize / 2, n = this.paramCount;
        const ranks = centeredRanks(Array.prototype.slice.call(fitness, 0, o.popSize));
        const g = new Float64Array(n);
        for (let i = 0; i < half; i++) {
            const w = ranks[i] - ranks[i + half];
            if (w === 0) continue;
            const e = this._eps[i];
            for (let j = 0; j < n; j++) g[j] += w * e[j];
        }
        const scale = 1 / (o.popSize * o.sigma);
        this.t++;
        this.b1t *= o.beta1;
        this.b2t *= o.beta2;
        const c1 = 1 - this.b1t, c2 = 1 - this.b2t;
        for (let j = 0; j < n; j++) {
            const gj = g[j] * scale - o.l2 * this.theta[j];   // ascent direction
            this.m[j] = o.beta1 * this.m[j] + (1 - o.beta1) * gj;
            this.v[j] = o.beta2 * this.v[j] + (1 - o.beta2) * gj * gj;
            this.theta[j] += (o.lr * (this.m[j] / c1)) / (Math.sqrt(this.v[j] / c2) + 1e-8);
        }
        this._eps = [];
    }

    getState() {
        const { init, theta, ...opts } = this.opts;
        return {
            algo: 'es', opts, rng: this.rng.getState(), t: this.t, b1t: this.b1t, b2t: this.b2t,
            theta: encodeF64(this.theta), m: encodeF64(this.m), v: encodeF64(this.v),
        };
    }

    static fromState(st, extra = {}) {
        const es = new ES({ ...st.opts, ...extra, theta: decodeF64(st.theta) });
        es.rng.setState(st.rng);
        es.t = st.t; es.b1t = st.b1t; es.b2t = st.b2t;
        es.m = decodeF64(st.m); es.v = decodeF64(st.v);
        return es;
    }
}

export const FITNESS_KINDS = ['race', 'return'];

/**
 * Time-attack score of an episode: 100 × the share of the route driven, and
 * once finished 100 + the seconds left of the env's time budget. Any finish
 * beats any crash, and among finishers every 10 ms counts.
 */
export function raceFitness(info, maxSeconds) {
    if (info.finished) return 100 + maxSeconds - info.finishTimeMs / 1000;
    const p = info.progressFrac > 0 ? info.progressFrac : 0;
    return 100 * (p < 0.9999 ? p : 0.9999);
}

/**
 * Runs `episodes` episodes of one parameter vector on an env (the same code
 * path in-thread and in workers). Fitness is the mean episode score: the
 * time-attack raceFitness (fitness: 'race', default) or the env's reward sum
 * ('return'). opts: { seed = 0, episodes = 1, replay = false, fitness }.
 * Returns { fitness, info, replay? }.
 */
export function evaluateParams(env, net, policy, params, opts = {}) {
    net.setParams(params);
    const episodes = Math.max(1, opts.episodes || 1);
    const seed = opts.seed ?? 0;
    const kind = opts.fitness || 'race';
    if (!FITNESS_KINDS.includes(kind)) throw new Error(`Unknown fitness '${kind}' (race | return)`);
    let total = 0, finished = 0, first = null;
    for (let e = 0; e < episodes; e++) {
        const r = runEpisode(env, policy, { seed: (seed + e) >>> 0, replay: !!opts.replay && e === 0 });
        total += kind === 'race' ? raceFitness(r.info, env.config.maxSeconds) : r.return;
        if (r.info.finished) finished++;
        if (!first) first = r;
    }
    const info = { ...first.info };
    if (episodes > 1) info.finishRate = finished / episodes;
    const out = { fitness: total / episodes, info };
    if (opts.replay) out.replay = first.replay;
    return out;
}

/** In-thread evaluator: one env, evaluated sequentially. */
export class LocalEvaluator {
    /** opts: { track | world, envConfig, arch, episodes = 1, fitness = 'race' } */
    constructor(opts) {
        this.env = new PenguinEnv({ ...(opts.envConfig || {}), track: opts.track, world: opts.world });
        this.net = new MLP({ ...opts.arch, seed: 1 });
        if (this.net.inputSize !== this.env.obsSize || this.net.outputSize !== this.env.actionSize) {
            throw new Error(`Network ${this.net.sizes.join('-')} does not fit the env (${this.env.obsSize} observations, ${this.env.actionSize} actions)`);
        }
        this.policy = makePolicy(this.net, this.env.config.action);
        this.episodes = opts.episodes || 1;
        this.fitness = opts.fitness || 'race';
    }

    evaluateOne(params, opts = {}) {
        return evaluateParams(this.env, this.net, this.policy, params, { episodes: this.episodes, fitness: this.fitness, ...opts });
    }

    async evaluate(list, opts = {}) {
        return list.map((p) => this.evaluateOne(p, opts));
    }

    close() {}
}

/** Episode seed of a generation: every candidate of a generation sees the same starts. */
export function generationSeed(seed, generation) {
    return hashSeed(`penguintrack:${seed >>> 0}:${generation}`);
}

/**
 * The training loop. opts: { algo: 'ga' | 'es', arch, seed = 1, popSize,
 * evaluator (evaluate(list, { seed, generation }) -> Promise<[{ fitness, info }]>),
 * ga: {...}, es: {...}, initParams? (start from these weights) }.
 *
 *   const trainer = new NeuroTrainer({ algo: 'es', arch, seed: 1, evaluator });
 *   for (let g = 0; g < 100; g++) console.log(await trainer.step());
 *   trainer.best   // { params, fitness, info, generation }
 */
export class NeuroTrainer {
    constructor(opts) {
        this.algo = opts.algo || 'ga';
        if (this.algo !== 'ga' && this.algo !== 'es') throw new Error(`Unknown algorithm '${this.algo}' (ga | es)`);
        this.arch = opts.arch;
        this.seed = opts.seed ?? 1;
        this.evaluator = opts.evaluator;
        this.generation = 0;
        this.evaluations = 0;
        this.history = [];
        this.best = null;
        if (opts.state) {
            this._restore(opts.state);
            this.paramCount = this.opt.paramCount;
            return;
        }
        this.paramCount = new MLP({ ...this.arch, seed: 1 }).paramCount;
        const initParams = opts.initParams ? Float64Array.from(opts.initParams) : null;
        let nInit = 0;
        const init = (rng) => {
            // The first individual (or the ES mean) may start from given weights.
            if (initParams && nInit++ === 0) return initParams;
            return MLP.randomParams(this.arch, rng);
        };
        const common = { paramCount: this.paramCount, init, seed: this.seed, arch: this.arch };
        if (opts.popSize) common.popSize = opts.popSize;
        this.opt = this.algo === 'ga' ? new GA({ ...(opts.ga || {}), ...common }) : new ES({ ...(opts.es || {}), ...common });
    }

    /** One generation: ask, evaluate, tell. Returns its stats row. */
    async step() {
        const g = this.generation;
        const cands = this.opt.ask();
        const t0 = now();
        const results = await this.evaluator.evaluate(cands, { seed: generationSeed(this.seed, g), generation: g });
        const ms = now() - t0;
        if (!results || results.length !== cands.length) throw new Error('Evaluator returned the wrong number of results');
        const fitness = results.map((r) => (Number.isFinite(r.fitness) ? r.fitness : -1e9));
        let bi = 0, sum = 0, fin = 0, bestTime = null, bestProg = -Infinity;
        for (let i = 0; i < fitness.length; i++) {
            sum += fitness[i];
            if (fitness[i] > fitness[bi]) bi = i;
            const info = results[i].info || {};
            if (info.finished) {
                fin++;
                if (bestTime === null || info.finishTimeMs < bestTime) bestTime = info.finishTimeMs;
            }
            if (info.progressFrac > bestProg) bestProg = info.progressFrac;
        }
        if (!this.best || fitness[bi] > this.best.fitness) {
            this.best = { params: Float64Array.from(cands[bi]), fitness: fitness[bi], info: results[bi].info || {}, generation: g };
        }
        this.opt.tell(fitness);
        this.generation++;
        this.evaluations += cands.length;
        const stats = {
            generation: g,
            best: fitness[bi],
            mean: sum / fitness.length,
            bestEver: this.best.fitness,
            finishRate: fin / fitness.length,
            bestTimeMs: bestTime,
            bestProgress: bestProg,
            bestEverTimeMs: this.best.info.finished ? this.best.info.finishTimeMs : null,
            evaluations: this.evaluations,
            evalMs: Math.round(ms),
        };
        this.history.push(stats);
        return stats;
    }

    /** Runs generations until `generations` total or shouldStop(stats) is true. */
    async run({ generations = 100, onGeneration, shouldStop } = {}) {
        while (this.generation < generations) {
            const stats = await this.step();
            if (onGeneration) await onGeneration(stats, this);
            if (shouldStop && shouldStop(stats, this)) break;
        }
        return this.best;
    }

    /** JSON-safe trainer state for --resume / the Lab's save slots. */
    getState() {
        return {
            format: 'penguintrack-neuro-state', version: 1,
            algo: this.algo, arch: this.arch, seed: this.seed,
            generation: this.generation, evaluations: this.evaluations,
            history: this.history,
            best: this.best && { ...this.best, params: encodeF32(this.best.params) },
            opt: this.opt.getState(),
        };
    }

    _restore(st) {
        if (!st || st.format !== 'penguintrack-neuro-state') throw new Error('Not a Penguintrack trainer state');
        this.algo = st.algo;
        this.arch = st.arch;
        this.seed = st.seed;
        this.generation = st.generation;
        this.evaluations = st.evaluations;
        this.history = st.history || [];
        this.best = st.best ? { ...st.best, params: decodeF32(st.best.params) } : null;
        const init = (rng) => MLP.randomParams(this.arch, rng);
        this.opt = st.algo === 'ga' ? GA.fromState(st.opt, { init, arch: this.arch }) : ES.fromState(st.opt, { init });
    }
}

function now() {
    return typeof performance !== 'undefined' ? performance.now() : 0;
}
