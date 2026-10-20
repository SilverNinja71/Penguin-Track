// Policies on top of the MLP (argmax over discrete logits, tanh for the
// continuous [steer, throttle] head), the episode runner, and the model file
// format shared by the trainers, the headless tools and the AI Lab.
import { MLP } from './nn.js';
import { normalizeEnvConfig, observationLayout } from './env.js';
import { ACTIONS } from '../core/input.js';
import { encodeTrack, trackHash } from '../core/codec.js';

export const MODEL_FILE_FORMAT = 'penguintrack-ai-model';

/**
 * Network architecture for an env config: [obs, ...hidden, actions], tanh
 * hidden layers by default, linear logits (discrete) or a tanh head
 * (continuous, outputs already in -1..1).
 */
export function archFor(envConfig, hidden = [32, 32], activation = 'tanh') {
    const c = normalizeEnvConfig(envConfig);
    const obsSize = observationLayout(c).length;
    const discrete = c.action === 'discrete';
    return {
        sizes: [obsSize, ...hidden, discrete ? ACTIONS.length : 2],
        activation,
        output: discrete ? 'linear' : 'tanh',
    };
}

export class DiscretePolicy {
    constructor(net) {
        this.net = net;
        this.kind = 'discrete';
    }

    /** Index of the largest logit (the first one on ties). */
    act(obs) {
        const y = this.net.forward(obs);
        let best = 0;
        for (let i = 1; i < y.length; i++) if (y[i] > y[best]) best = i;
        return best;
    }
}

export class ContinuousPolicy {
    constructor(net) {
        this.net = net;
        this.kind = 'continuous';
        this._a = [0, 0];
    }

    /** [steer, throttle] in -1..1 (a linear head is squashed here; a tanh head passes through). */
    act(obs) {
        const y = this.net.forward(obs);
        const squash = this.net.output !== 'tanh';
        for (let i = 0; i < 2; i++) {
            const v = y[i];
            this._a[i] = squash ? (v > 1 ? 1 : v < -1 ? -1 : v) : v;
        }
        return this._a;
    }
}

/** Policy for a net and an action kind ('discrete' | 'continuous'). */
export function makePolicy(net, action = 'discrete') {
    return action === 'continuous' ? new ContinuousPolicy(net) : new DiscretePolicy(net);
}

/**
 * Runs one episode. policy: anything with act(obs) (or a function obs ->
 * action). opts: { seed, maxSteps = Infinity, replay = true, onStep(result,
 * action) }. Returns { return, steps, info, replay } where replay is the
 * env's full run (core replay object, encoded inputs + time).
 */
export function runEpisode(env, policy, opts = {}) {
    const act = typeof policy === 'function' ? policy : (o) => policy.act(o);
    let obs = env.reset(opts.seed);
    let ret = 0, steps = 0, r = null;
    const max = opts.maxSteps ?? Infinity;
    while (steps < max) {
        const a = act(obs);
        r = env.step(a);
        ret += r.reward;
        steps++;
        if (opts.onStep) opts.onStep(r, a);
        obs = r.obs;
        if (r.terminated || r.truncated) break;
    }
    return {
        return: ret,
        steps,
        info: r ? r.info : env.info(),
        replay: opts.replay === false ? null : env.replay({ name: opts.name }),
    };
}

/**
 * A self-contained model file: architecture + weights, the exact env config
 * the policy was trained with, the track (id, hash and share code), training
 * stats and the best run as a replay (ghost).
 */
export function makeModelFile({ name, track, world, envConfig, net, stats = {}, replay = null, date = null }) {
    const t = track || (world && world.track);
    return {
        format: MODEL_FILE_FORMAT,
        version: 1,
        name: name || 'Penguin driver',
        trackId: t ? t.id ?? null : null,
        trackName: t ? t.name ?? null : null,
        trackHash: world ? world.hash : t ? trackHash(t) : null,
        trackCode: t ? encodeTrack(t) : null,
        date,
        env: normalizeEnvConfig(envConfig),
        net: net.toJSON(),
        stats,
        replay,
    };
}

/** Parses a model file: { net, policy, envConfig, file }. Throws when malformed. */
export function loadModelFile(file) {
    const json = typeof file === 'string' ? JSON.parse(file) : file;
    if (!json || json.format !== MODEL_FILE_FORMAT) throw new Error('Not a Penguintrack AI model file');
    const envConfig = normalizeEnvConfig(json.env || {});
    const net = MLP.fromJSON(json.net);
    const expect = observationLayout(envConfig).length;
    if (net.inputSize !== expect) {
        throw new Error(`Model expects ${net.inputSize} observations but its env config gives ${expect}`);
    }
    return { net, policy: makePolicy(net, envConfig.action), envConfig, file: json };
}
