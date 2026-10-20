// Evaluation worker for neuroevolution: builds the track's env once, then
// scores parameter vectors. The same file runs as a browser module worker
// (new Worker(url, { type: 'module' })) and as a Node worker_threads worker.
//
// Protocol (every message may carry an `id`, echoed in the reply):
//   -> { type: 'init', trackId | trackJSON | trackCode, envConfig, arch, episodes?, fitness? }
//   <- { type: 'ready', obsSize, actionSize, paramCount, trackId, trackHash }
//   -> { type: 'evaluate', params, seed?, episodes?, replay? }
//   <- { type: 'result', fitness, info, replay? }
//   -> { type: 'close' }
//   <- { type: 'error', message } for anything that went wrong
import { PenguinEnv } from './env.js';
import { MLP } from './nn.js';
import { makePolicy } from './policy.js';
import { evaluateParams } from './neuro.js';
import { resolveTrack } from './tracks.js';

let state = null;
let post = null;
let closeSelf = () => {};

async function handle(msg) {
    const id = msg && msg.id;
    try {
        if (!msg || typeof msg !== 'object') throw new Error('Bad message');
        if (msg.type === 'init') {
            const track = await resolveTrack(msg.trackJSON || msg.trackCode || msg.trackId);
            const env = new PenguinEnv({ ...(msg.envConfig || {}), track });
            const net = new MLP({ ...msg.arch, seed: 1 });
            if (net.inputSize !== env.obsSize || net.outputSize !== env.actionSize) {
                throw new Error(`Network ${net.sizes.join('-')} does not fit the env (${env.obsSize} observations, ${env.actionSize} actions)`);
            }
            state = { env, net, policy: makePolicy(net, env.config.action), episodes: msg.episodes || 1, fitness: msg.fitness || 'race' };
            post({
                type: 'ready', id, obsSize: env.obsSize, actionSize: env.actionSize, paramCount: net.paramCount,
                trackId: env.world.track.id ?? null, trackHash: env.world.hash,
            });
        } else if (msg.type === 'evaluate') {
            if (!state) throw new Error('Worker not initialised (send init first)');
            const r = evaluateParams(state.env, state.net, state.policy, msg.params, {
                seed: msg.seed ?? 0, episodes: msg.episodes || state.episodes, fitness: state.fitness, replay: !!msg.replay,
            });
            const reply = { type: 'result', id, fitness: r.fitness, info: r.info };
            if (r.replay) reply.replay = r.replay;
            post(reply);
        } else if (msg.type === 'close') {
            closeSelf();
        } else {
            throw new Error(`Unknown message type '${msg.type}'`);
        }
    } catch (e) {
        post({ type: 'error', id, message: String((e && e.message) || e) });
    }
}

// Messages are handled one at a time, in order (init is async: it may load the levels module).
let chain = Promise.resolve();
const enqueue = (msg) => {
    chain = chain.then(() => handle(msg));
};

if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof process === 'undefined') {
    post = (m) => self.postMessage(m);
    closeSelf = () => self.close();
    self.addEventListener('message', (e) => enqueue(e.data));
} else {
    const { parentPort } = await import('node:worker_threads');
    if (parentPort) {
        post = (m) => parentPort.postMessage(m);
        closeSelf = () => parentPort.close();
        parentPort.on('message', enqueue);
    }
}
