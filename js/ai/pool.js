// Parallel evaluator over evaluation workers (js/ai/worker.js): browser Web
// Workers in the AI Lab, worker_threads in tools/train.mjs. It implements the
// evaluator interface NeuroTrainer expects (evaluate(list, opts) -> results in
// list order), so results never depend on which worker finished first.
// Pure: workers are duck-typed (addEventListener in browsers, .on in Node).

/** Normalises a Web Worker or a Node worker_threads Worker to { post, listen, onError, terminate }. */
export function workerPort(w) {
    if (typeof w.on === 'function') {
        return {
            post: (m) => w.postMessage(m),
            listen: (h) => w.on('message', h),
            onError: (h) => w.on('error', h),
            terminate: () => w.terminate(),
        };
    }
    return {
        post: (m) => w.postMessage(m),
        listen: (h) => w.addEventListener('message', (e) => h(e.data)),
        onError: (h) => w.addEventListener('error', (e) => h(e.error || new Error(e.message || 'Worker error'))),
        terminate: () => w.terminate(),
    };
}

/**
 * Browser helper: an EvalPool of `size` module Web Workers running worker.js
 * (defaults to navigator.hardwareConcurrency - 1). Node uses worker_threads
 * instead (see tools/train.mjs).
 */
export function createWorkerPool(size = 0) {
    if (typeof Worker === 'undefined') throw new Error('createWorkerPool needs Web Workers (use worker_threads in Node)');
    const n = size > 0 ? size : Math.max(1, ((globalThis.navigator && navigator.hardwareConcurrency) || 4) - 1);
    const url = new URL('./worker.js', import.meta.url);
    return new EvalPool(Array.from({ length: n }, () => new Worker(url, { type: 'module' })));
}

export class EvalPool {
    /**
     * workers: Web Workers / worker_threads Workers running js/ai/worker.js.
     * Call init(initMessage) once, then evaluate() as often as needed.
     */
    constructor(workers) {
        if (!workers.length) throw new Error('EvalPool needs at least one worker');
        this.ports = workers.map(workerPort);
        this.size = this.ports.length;
        this._handlers = new Map();
        this._nextId = 1;
        this._broken = null;
        this.ports.forEach((p, i) => {
            p.listen((msg) => this._onMessage(i, msg));
            p.onError((err) => this._fail(err));
        });
    }

    _onMessage(i, msg) {
        const h = this._handlers.get(msg && msg.id);
        if (!h) return;
        this._handlers.delete(msg.id);
        if (msg.type === 'error') h.reject(new Error(msg.message));
        else h.resolve(msg);
    }

    _fail(err) {
        this._broken = err;
        for (const h of this._handlers.values()) h.reject(err);
        this._handlers.clear();
    }

    _send(port, msg) {
        if (this._broken) return Promise.reject(this._broken);
        const id = this._nextId++;
        return new Promise((resolve, reject) => {
            this._handlers.set(id, { resolve, reject });
            port.post({ ...msg, id });
        });
    }

    /**
     * Sends the worker init message to every worker:
     * { trackId | trackJSON | trackCode, envConfig, arch, episodes? }.
     * Resolves to the first worker's 'ready' reply.
     */
    async init(initMsg) {
        const replies = await Promise.all(this.ports.map((p) => this._send(p, { ...initMsg, type: 'init' })));
        this.ready = replies[0];
        return replies[0];
    }

    /**
     * Evaluates parameter vectors on the workers. opts: { seed, episodes,
     * replay }. Resolves to [{ fitness, info, replay? }] in list order.
     */
    evaluate(list, opts = {}) {
        const results = new Array(list.length);
        let next = 0;
        const worker = async (port) => {
            while (next < list.length) {
                const i = next++;
                const params = list[i];
                const msg = await this._send(port, {
                    type: 'evaluate', params, seed: opts.seed, episodes: opts.episodes, replay: !!opts.replay,
                });
                results[i] = { fitness: msg.fitness, info: msg.info };
                if (msg.replay) results[i].replay = msg.replay;
            }
        };
        return Promise.all(this.ports.map(worker)).then(() => results);
    }

    close() {
        for (const p of this.ports) {
            try {
                p.post({ type: 'close' });
                p.terminate();
            } catch (e) { /* already gone */ }
        }
        this._fail(new Error('EvalPool closed'));
    }
}
