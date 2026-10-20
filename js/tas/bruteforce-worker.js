// Web Worker shell around BruteforceSession (message protocol in
// js/tas/bruteforce.js and docs/TAS.md). Start it as a module worker:
//   const w = new Worker(new URL('./bruteforce-worker.js', import.meta.url), { type: 'module' });
//   w.postMessage({ type: 'start', track, inputs, options: { target: 'finish', seed: 1 } });
import { BruteforceSession } from './bruteforce.js';

const session = new BruteforceSession((msg) => self.postMessage(msg));
self.onmessage = (e) => session.handle(e.data);
