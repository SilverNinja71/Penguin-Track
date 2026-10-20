# Penguintrack AI training kit

Train penguin drivers on any Penguintrack track: a gym-style environment around the
deterministic core, a small MLP, neuroevolution trainers (GA and OpenAI-style ES) that run
in Node worker threads or browser Web Workers, a JSON-lines env server for Python, and a
gymnasium wrapper with a stable-baselines3 PPO example. Everything an agent does is
recorded as ordinary core inputs, so every run is a replay the game can show as a ghost.

| file | what |
| --- | --- |
| `js/ai/env.js` | `PenguinEnv`: reset / step, observations, reward, termination, savestates, replays |
| `js/ai/nn.js` | `MLP` (dense, tanh/relu), deterministic init, flat params, JSON |
| `js/ai/policy.js` | policies (argmax / tanh), `runEpisode`, model files |
| `js/ai/neuro.js` | `GA`, `ES`, `NeuroTrainer`, `LocalEvaluator`, `evaluateParams`, `raceFitness` |
| `js/ai/pool.js` | `EvalPool` (parallel evaluator over workers), `createWorkerPool` (browser) |
| `js/ai/worker.js` | evaluation worker (browser module worker and Node worker_threads) |
| `js/ai/tracks.js` | track lookup: level ids, samples, share codes, JSON |
| `tools/train.mjs` | CLI trainer (worker_threads pool, progress table, saves model + ghost, resume) |
| `tools/headless.mjs` | JSON-lines env server on stdin/stdout |
| `python/` | `penguintrack_env.py` (gymnasium env), `random_agent.py`, `train_ppo.py` |
| `models/demo-S01.json` | pre-trained demo driver for the AI Lab |
| `js/ai/lab*.js`, `css/ai.css` | the in-game AI Lab ([below](#ai-lab-jsailabjs-cssaicss)) |
| `tools/tests/ai.test.mjs` | tests (`node tools/test.mjs "ai >"`) |

Everything in `js/ai/` except `worker.js` (and `createWorkerPool`, which needs `Worker`) and
the AI Lab's UI files (`lab.js`, `lab-chart.js`, `lab-overlay.js`, `lab-help.js`) is pure (no
DOM): it runs in the page, in Web Workers and in Node.

## Quick start

```sh
node tools/train.mjs --track S01 --algo ga --gens 60            # ~30 s on 8 threads, beats the autopilot
node tools/train.mjs --eval models/S01-ga.json --replay-out run.json
cd python && python3 random_agent.py --track S01                # zero-dependency Python smoke test
```

To watch a trained driver in the game, open Replays → Import code → Choose file and pick
the model file (it carries its ghost) or any replay JSON; then Watch it or Race ghost.

```js
import { PenguinEnv } from './js/ai/env.js';
import { getSample } from './js/core/samples.js';

const env = new PenguinEnv({ track: getSample('S01'), frameSkip: 4, maxSeconds: 60 });
let obs = env.reset(1);
for (;;) {
    const { obs: next, reward, terminated, truncated, info } = env.step(3);   // straight + gas
    obs = next;
    if (terminated || truncated) { console.log(info.reason, info.progressFrac); break; }
}
const ghost = env.replay();     // core replay object: { inputs: '1:…', timeMs, finished, trackHash, … }
```

## PenguinEnv (`js/ai/env.js`)

```js
const env = new PenguinEnv({ track | world, ...config });
env.reset(seed?) -> Float32Array                       // gym semantics: no seed continues the RNG stream
env.step(action) -> { obs, reward, terminated, truncated, info }
env.observationSpace   // { type: 'box', shape: [N], dtype: 'float32', low: [...], high: [...], names: [...] }
env.actionSpace        // { type: 'discrete', n: 9, names } | { type: 'box', shape: [2], low: [-1,-1], high: [1,1], names }
env.obsSize, env.actionSize, env.layout                // layout: [{ name, low, high }] per observation index
env.getState({ inputs = true }) / env.setState(state) -> obs   // exact, plain JSON (sim + tracker + counters + inputs)
env.replay({ name }) -> replay                          // the episode as a core replay (always a whole run from GO)
env.info()                                              // the info object of the current state
env.observe()                                           // observation of the current state
env.actionToInput(action) -> { steer, gas, brake }      // what an action means
env.sim, env.world, env.route, env.tracker, env.recorder, env.config, env.lastEvents
normalizeEnvConfig(cfg), observationLayout(cfg), ENV_DEFAULTS, rayAngles(n, fov)
```

`track` is a track JSON (build once and pass `world` to share it between envs). The track
needs a route (every valid track has one).

### Config

| key | default | meaning |
| --- | --- | --- |
| `frameSkip` | 4 | ticks per step (the action repeats; 4 = 25 decisions per second) |
| `maxSeconds` | 120 | episode budget, counted from the episode start (then `truncated`, reason `time`) |
| `action` | `'discrete'` | `'discrete'` (9 actions) or `'continuous'` (`[steer, throttle]`) |
| `startMode` | `'start'` | `'start'`, `'random-checkpoint'` or `'random'` (below) |
| `laps` | track's | lap count override |
| `onFall` | `'terminate'` | `'terminate'` or `'respawn'` (TM-style, back to the last checkpoint, `fall` penalty) |
| `stuckSeconds` | 3 | no new progress for this long: terminated, `stuck` |
| `wrongWayMeters` | 25 | this far behind the best progress: terminated, `wrong-way` |
| `offRouteMargin` | 5 | metres beyond the road half-width (27 over jumps / in the air) that count as off the route; also more than this below the deck (27 over jumps) or 40 m above it |
| `offRouteSeconds` | 0.5 | off the route this long: terminated, `off-route` |
| `seed` | 0 | RNG seed for random starts when `reset()` gets no seed |
| `obs.edgeRays` | 15 | route edge sensors (`route.edgeRays`, cheap) |
| `obs.fov` | 180 | degrees the edge / wall rays spread over, centred on the heading |
| `obs.rayLength` | 120 | metres |
| `obs.lookahead` | `[10, 25, 50, 90]` | metres ahead along the route for curvature, grip and route-point features |
| `obs.collisionRays` | 0 | optional real raycasts against the collision mesh (walls, snowbanks; ~3× slower per step) |
| `reward.*` | below | reward weights |

**Start modes.** `'start'`: every episode starts on the start line (deterministic: the
seed does not matter). `'random-checkpoint'`: the env drives the track once with the core
autopilot (lazily, on the first reset) and snapshots the race at every checkpoint (and lap
line); each reset picks the start or one of those snapshots with the seeded RNG.
`'random'`: as random-checkpoint plus a snapshot every 2 s of that drive. A random start
keeps the autopilot's inputs as the episode's prefix, so `env.replay()` is still a whole
run from GO that `verifyReplay` accepts. `info.ticks` and `maxSeconds` count from the
episode start; `info.timeMs` is the race clock.

### Info

```js
{ progress,        // metres along the route (RouteTracker, lap-aware: lap k adds k × length)
  progressFrac,    // progress / (route length × laps)
  timeMs,          // race clock (sim.timeMs)
  finished, finishTimeMs,
  speedKmh, checkpoints /* crossings this run */, lap, respawns,
  steps, ticks /* since the episode start */, episodeReturn,
  reason }         // null while running, else 'finish' | 'fall' | 'stuck' | 'wrong-way' | 'off-route' | 'time'
```

### Observations (default config: 75 floats)

Car-frame quantities use the core convention: + = right, forward, up. "Clip" is the
`[low, high]` the value is clipped to (also `observationSpace.low/high`).

| index | name | value | clip |
| --- | --- | --- | --- |
| 0 | `speed.forward` | velocity along the car's nose / 100 m/s | -1..3 |
| 1 | `speed.right` | sideways velocity (+ right) / 30 m/s | -3..3 |
| 2 | `speed.up` | velocity along the car's up / 30 m/s | -3..3 |
| 3 | `yawRate` | rotation about the car's up, + = turning right, / 3 rad/s | -3..3 |
| 4 | `pitch` | world Y of the nose direction (+ nose up) | -1..1 |
| 5 | `roll` | −(world Y of the right vector), + = leaning right | -1..1 |
| 6 | `up.y` | world Y of the car's up (1 upright, −1 upside down) | -1..1 |
| 7 | `steer` | smoothed steering −1..1 (+ right) | -1..1 |
| 8–11 | `contact.FL/FR/RL/RR` | wheel touching the ground (0/1) | 0..1 |
| 12 | `airborne` | 0/1 | 0..1 |
| 13 | `drifting` | 0/1 | 0..1 |
| 14 | `slipAngle` | slip angle / 0.5 rad | -2..2 |
| 15–19 | `surface.snow/powder/ice/ground/wall` | one-hot surface under the car (all 0 in the air) | 0..1 |
| 20 | `route.headingError` | angle from the route tangent to the nose (in the deck plane), + = nose right of the route, / π | -1..1 |
| 21 | `route.lateral` | offset from the centerline / road half-width, + = right | -3..3 |
| 22 | `route.vertical` | height above the deck along its normal / 10 m (0.065 when resting) | -3..3 |
| 23 | `route.halfWidth` | drivable half-width / 16 m (0.75 road, 0.31 narrow, 1 platform) | 0..2 |
| 24 | `route.gap` | 1 while over a jump segment | 0..1 |
| 25 | `route.speed` | velocity along the route tangent / 100 m/s | -1..3 |
| 26–29 | `curv@10/25/50/90` | lateral route curvature × 16 m at s + d (+ = right turn; 1 = the Igloo Hairpin) | -2..2 |
| 30–33 | `vcurv@10/25/50/90` | vertical curvature × 16 m at s + d (+ = compression: loops, valleys; − = crests) | -2..2 |
| 34–37 | `grip@10/25/50/90` | surface grip at s + d relative to packed snow (ice 0.24, powder 0.67; 0 over a jump) | 0..1 |
| 38–49 | `point@d.right/up/forward` | route point at s + d in the car frame, divided by d (3 per lookahead: 38–40 at 10 m, 41–43 at 25, 44–46 at 50, 47–49 at 90) | -2..2 |
| 50–64 | `edge@-90 … edge@90` | distance to the road edge along 15 rays from −90° (left) to +90° (right), every 12.86°, / 120 m (1 = no edge in range) | 0..1 |
| 65 | `effect.boost` | boost level × remaining boost time / 4 (1 = fresh Avalanche Boost) | 0..1 |
| 66–72 | `effect.noEngine/noSteer/noBrake/slowmo/cruise/fragile/broken` | flags (slowmo = stacks / 3) | 0..1 |
| 73 | `progress` | `progressFrac` | -0.5..1.5 |
| 74 | `checkpoints` | checkpoints taken this lap / checkpoint count | 0..1 |

With another config the groups keep this order and resize: `curv`, `vcurv`, `grip` have one
entry per lookahead distance and `point@` three; `edge@<deg>` has `obs.edgeRays` entries;
`wall@<deg>` (`obs.collisionRays` entries, distance / rayLength from 0.3 m above the car's
centre in the car's floor plane) comes right after the edge rays. `observationSpace.names`
always lists the exact layout.

### Actions

Discrete (`ACTIONS` from core `input.js`, index = steer × 3 + throttle):

| | gas | coast | brake / reverse |
| --- | --- | --- | --- |
| left | 0 | 1 | 2 |
| straight | 3 | 4 | 5 |
| right | 6 | 7 | 8 |

Continuous: `[steer, throttle]`, steer −1..1 (× 65536, rounded by the core), throttle
≥ 0.5 = gas, ≤ −0.5 = brake (reverse when stopped), else coast. `step` also accepts a core
input object `{ steer, gas, brake }` in either mode (the autopilot can drive the env:
`env.step(pilot.act(env.sim))`), a one-element array `[index]` and numeric strings.

### Reward

Per step (`reward.*` weights, defaults in brackets):

```
+ progress (0.01) × new metres of route progress      (only ground never covered before in this
                                                        episode; capped at speed × dt + 2 m)
+ speed (0.1)     × max(0, velocity along the route) / 100 m/s × seconds
− time (0.05)     × seconds
− wallHit (0.05)  × Σ min(intensity / 10 m/s, 3) over wall hits
on finish:  + finish (10) + finishTime (10) × max(0, 1 − raceTime / refSeconds (= maxSeconds))
on a fall:  − fall (5)          (terminates, or respawns with onFall: 'respawn')
on stuck / wrong-way / off-route termination:  − crash (2)
```

"New ground only" makes the reward immune to driving back and forth and to respawn
loops; the cap ignores projection jumps (e.g. dropping onto a lower part of the route).
A clean S01 run returns about 26–28 (the autopilot's 22.14 s run: 28.3 with `maxSeconds`
120).

### Termination

`terminated` on finish, fall (below `world.fallY`, `onFall: 'terminate'`), `stuck` (no new
progress for `stuckSeconds`), `wrong-way` (`wrongWayMeters` behind the best progress) and
`off-route` (off the road for `offRouteSeconds`: beyond the half-width + margin, under the
deck after falling off an elevated road, or far above it). `truncated` when `maxSeconds`
run out. Stepping a finished episode throws: call `reset()`.

### Savestates

`getState()` returns `{ v: 1, sim, tracker, env: { startTick, steps, rewardBest, offTicks,
episodeReturn, done, reason, rng }, inputs }` (plain JSON; `inputs` is the encoded episode so
far, omit it with `getState({ inputs: false })`). `setState` restores everything, so search
agents (beam search, MCTS, TAS bruteforce) can branch: the same actions from a restored
state give bit-identical rewards and observations (tested through `JSON.stringify`).

## MLP (`js/ai/nn.js`)

```js
const net = new MLP({ sizes: [75, 32, 32, 9], activation: 'tanh' | 'relu', output: 'linear' | 'tanh' | 'relu', seed: 1 });
net.forward(input) -> Float64Array (reused buffer)    // any array-like input
net.paramCount; net.getParams() / net.setParams(flat); net.arch; net.clone()
net.toJSON({ encoding: 'f32' | 'array' }) / MLP.fromJSON(json)
MLP.randomParams(arch, seed | rng, outputScale = 0.5) -> Float64Array
dtanh(x); countParams(sizes); encodeF32 / decodeF32 / encodeF64 / decodeF64; roundF32(params)
```

Flat layout: layer by layer, weights row-major `[out][in]` then biases. Init: N(0, gain /
√fanIn) (gain √2 for relu), output layer × `outputScale`, biases 0, every weight rounded to
float32. `tanh` is `dtanh` (mathd's polynomial exp), so a network gives bit-identical outputs
in every JS engine, like the core. JSON: `{ format: 'penguintrack-mlp', version: 1, sizes,
activation, output, paramCount, weights: { encoding: 'f32', data: <base64url little-endian
float32> } }` (or `params: [...]`). The trainers keep every evaluated vector float32-exact,
so the compact encoding loses nothing.

## Policies and model files (`js/ai/policy.js`)

```js
archFor(envConfig, hidden = [32, 32], activation = 'tanh') -> { sizes, activation, output }
makePolicy(net, 'discrete' | 'continuous') -> { act(obs) }   // argmax (first max on ties) / [steer, throttle]
runEpisode(env, policy, { seed, maxSteps, replay = true, onStep(result, action), name })
    -> { return, steps, info, replay }
makeModelFile({ name, track | world, envConfig, net, stats, replay, date }) -> file
loadModelFile(file | text) -> { net, policy, envConfig, file }
```

A model file is self-contained JSON:

```js
{ format: 'penguintrack-ai-model', version: 1, name,
  trackId, trackName, trackHash, trackCode /* PT1. share code: rebuild the track anywhere */,
  date, env /* normalized env config: the exact observations it was trained on */,
  net /* MLP JSON */, stats /* algo, seed, generations, evaluations, popSize, hidden, bestFitness,
  bestGeneration, return, finished, timeMs, progressFrac, reason, trainSeconds,
  history: [[generation, best, mean, finishRate, bestTimeMs], ...] */,
  replay /* core replay of the best weights driven from the start: a ghost */ }
```

For the `ai` storage key (`{ [name]: { trackId, arch, weights, stats } }`) store the model
file itself under its name: `net` carries the architecture and the weights.

## Neuroevolution (`js/ai/neuro.js`)

Both optimizers use one ask / tell interface over flat parameter vectors:

```js
const ga = new GA({ paramCount, init: (rng) => Float64Array, seed, arch?, popSize: 64, eliteCount: 4,
                    parentFraction: 0.25, crossover: 0.25, mutationRate: 1, mutationStd: 0.03 });
const es = new ES({ paramCount, init, seed, popSize: 64, sigma: 0.04, lr: 0.02, l2: 0.002,
                    beta1: 0.9, beta2: 0.999, evalMean: true });
const cands = opt.ask();  /* evaluate */  opt.tell(fitnesses);
opt.getState() / GA.fromState(st, { init, arch }) / ES.fromState(st, { init })
```

- **GA**: elites copied unchanged; parents by a two-way tournament inside the top
  `parentFraction`; with probability `crossover` a child takes each neuron (its incoming
  weights and bias) from either parent; gaussian mutation of `mutationRate` of the genes
  with `mutationStd`.
- **ES** (Salimans et al. 2017): `popSize / 2` antithetic pairs θ ± σε, centered-rank
  fitness shaping, gradient `Σ (r⁺ − r⁻) ε / (popSize σ)` minus `l2 θ`, Adam ascent. With
  `evalMean` the mean θ is evaluated as an extra candidate (reported, may become the best).

The training loop:

```js
const trainer = new NeuroTrainer({ algo: 'ga' | 'es', arch, seed: 1, popSize: 64, evaluator,
                                   ga: {...}, es: {...}, initParams? });
const stats = await trainer.step();   // one generation
// stats: { generation, best, mean, bestEver, finishRate, bestTimeMs, bestProgress,
//          bestEverTimeMs, evaluations, evalMs }
await trainer.run({ generations, onGeneration(stats, trainer), shouldStop(stats, trainer) });
trainer.best          // { params: Float64Array, fitness, info, generation } (best ever)
trainer.history       // every stats row
trainer.getState()    // JSON; new NeuroTrainer({ state, evaluator }) resumes exactly
```

**Evaluators** implement `evaluate(paramsList, { seed, generation }) -> Promise<[{ fitness,
info, replay? }]>` in list order. `LocalEvaluator({ track | world, envConfig, arch, episodes,
fitness })` runs in the calling thread; `EvalPool` (below) runs on workers. Both call
`evaluateParams(env, net, policy, params, { seed, episodes, replay, fitness })`: the mean
score over `episodes` (seeds `seed`, `seed + 1`, …); info = the first episode's info
(+ `finishRate` with several episodes).

**Fitness.** `'race'` (default, `raceFitness(info, maxSeconds)`): 100 × the share of the
route driven, and for a finish 100 + the seconds left of the episode budget (so 150.30 on a
70 s budget = a 19.70 s run). Any finish beats any crash and every 10 ms counts; it gave
faster drivers than the shaped reward (S01: 19.70 s vs 19.94 s, same budget). `'return'`:
the env's reward sum (the RL signal, shaped by speed, walls and time).

**Determinism.** All randomness comes from seeded core `Rng`s (`hashSeed` for per-generation
episode seeds: every candidate of a generation sees the same starts), the env and the MLP
are deterministic, ranks break ties by index, and pools return results in list order: the
same seed and settings give the same training curve with any number of workers (tested,
including a save/resume in the middle).

## Workers (`js/ai/worker.js`, `js/ai/pool.js`)

`worker.js` runs as a browser module worker or a Node worker_threads worker. Messages may
carry an `id`, echoed in the reply; a worker handles messages one at a time, in order.

| request | reply |
| --- | --- |
| `{ type: 'init', trackId \| trackJSON \| trackCode, envConfig, arch, episodes?, fitness? }` | `{ type: 'ready', obsSize, actionSize, paramCount, trackId, trackHash }` |
| `{ type: 'evaluate', params, seed?, episodes?, replay? }` | `{ type: 'result', fitness, info, replay? }` |
| `{ type: 'close' }` | (the worker exits) |
| anything that fails | `{ type: 'error', message }` |

`params` is a Float64Array (or a number array) of `paramCount` values. Post the track JSON
(`trackJSON`) when you have it: a `trackId` makes the worker load `js/levels/index.js`
(falling back to the samples). Build happens once per init (~50–250 ms cold).

```js
import { createWorkerPool, EvalPool } from './js/ai/pool.js';
const pool = createWorkerPool(navigator.hardwareConcurrency - 1);  // browser; Node: new EvalPool(workerThreads)
await pool.init({ trackJSON, envConfig, arch });
const results = await pool.evaluate(paramsList, { seed });          // [{ fitness, info }] in order
const [best] = await pool.evaluate([params], { replay: true });     // with best.replay
pool.close();
```

## Tracks (`js/ai/tracks.js`)

```js
await resolveTrack('A01' | 'S01' | 'PT1.…' | '{"format":1,…}' | trackObject) -> track JSON  // throws when unknown
resolveTrackSync(spec) -> track | null      // everything but official level ids
await listTracks() -> [{ id, name, source: 'levels' | 'sample' }]
await loadLevels() -> js/levels/index.js module | null (cached)
```

Official ids come from `getTrack` / `trackIds` / `trackInfo` in `js/levels/index.js`; when
that module is missing the six core samples (S01–S06) still resolve.

## Headless env server (`tools/headless.mjs`)

`node tools/headless.mjs` reads one JSON request per line on stdin and writes one JSON reply
per line on stdout (nothing else). Replies are `{ "ok": true, ... }` or `{ "ok": false,
"error": "message", "cmd": ... }`; a request's `id` is echoed. Bad JSON, unknown commands,
bad actions and stepping before `make` all come back as errors; the server keeps running.
It exits on `close` or when stdin closes.

| request | reply fields |
| --- | --- |
| `{"cmd":"make","track":"S01","config":{...},"num_envs":1,"obs_encoding":"b64"}` | `observation_space`, `action_space` (as on the env, with `names`), `track: {id, name, hash, length, laps, checkpoints}`, `num_envs`, `obs_encoding`, `env_config` |
| `{"cmd":"reset","seed":1,"env":0}` | `obs`, `info` |
| `{"cmd":"step","action":3,"env":0}` | `obs`, `reward`, `terminated`, `truncated`, `info` |
| `{"cmd":"step_batch","actions":[a0,…]}` | `obs[]`, `reward[]`, `terminated[]`, `truncated[]`, `info[]` (one per env) |
| `{"cmd":"reset_all","seed":1}` | `obs[]` (env i gets seed + i) |
| `{"cmd":"get_state","env":0,"inputs":true}` | `state` (`env.getState()`) |
| `{"cmd":"set_state","state":{...},"env":0}` | `obs`, `info` |
| `{"cmd":"replay","env":0,"last":false,"name":"…"}` | `replay` (current episode; `last: true`: the env's last episode ended by `step_batch`) |
| `{"cmd":"spaces"}` | the `make` reply |
| `{"cmd":"tracks"}` | `tracks: [{ id, name, source }]` |
| `{"cmd":"ping"}` | `pong`, `protocol` (1), `envVersion` |
| `{"cmd":"close"}` | `{}`, then exit |

- `track`: level id, sample id, `PT1.` code, track JSON object, or a path to a `.json` file
  (relative to the server's working directory). `config`: the PenguinEnv config. With
  `num_envs` > 1 the envs share one built world; env i uses `config.seed + i`.
- **Observations**: `"b64"` (default) is the float32 observation as standard base64 of its
  little-endian bytes (exact, ~400 characters for 75 floats; numpy:
  `np.frombuffer(base64.b64decode(s), '<f4')`, stdlib: `array('f').frombytes(...)`);
  `"list"` gives plain numbers rounded to 1e-6. `info` floats are trimmed (progress to
  1 mm, speed to 0.01 km/h).
- `step_batch` steps every env once with auto-reset: an env that ends is reset at once, its
  `obs` entry is the new episode's first observation and `info[i].final_obs` holds the
  terminal one (gymnasium / SB3 vector-env semantics).
- Actions: an integer (discrete), `[steer, throttle]` (continuous), or
  `{"steer":…, "gas":…, "brake":…}`.

Throughput: ~4–5k steps/s through one pipe from Python (round trip per step), ~20k env
steps/s per process inside Node at frame skip 4.

## CLI trainer (`tools/train.mjs`)

```
node tools/train.mjs --track S01 --algo ga|es --pop 64 --gens 200 --hidden 32,32 --seed 1
                     --workers N --frame-skip 4 --max-seconds auto --action discrete
                     --start-mode start --episodes 1 --fitness race --out models/<track>-<algo>.json
node tools/train.mjs --resume models/S01-ga.json --gens 400        # continue (total generations)
node tools/train.mjs --init models/demo-S01.json --track A01 ...    # fine-tune from a model
node tools/train.mjs --eval models/demo-S01.json --replay-out run.json
node tools/train.mjs --help                                         # every option
```

Defaults: GA, population 64, 200 generations, 32-32 tanh, race fitness, workers = CPUs − 1
(max 12), `--max-seconds auto` (route length / 15 m/s, at least 30 s, in steps of 10),
`--time-limit` minutes to stop early. Each generation prints:

```
  gen       best       mean  best-ever  finish  gen-time   best-time   route   evals/s  elapsed
```

`best` / `mean`: fitness this generation (race fitness: 100 = finished, + seconds under the
budget); `finish`: share of the
population that finished; `gen-time`: fastest finish this generation; `best-time`: the
best-fitness model's time; `route`: farthest progress this generation.

Files: `--out` gets the model file (best weights, env config, stats with the curve, and the
best weights' run re-driven from the start as a verified replay/ghost); `<out>.state.json`
holds the trainer state for `--resume`. Saved every `--save-every` generations (10), on
every new best that finishes, at the end and on Ctrl+C (first Ctrl+C finishes the current
generation and saves).

## Python (`python/`)

See [`python/README.md`](../python/README.md). `PenguinTrackEnv(track, config)` is a
`gymnasium.Env` (a minimal stand-in base class and spaces when gymnasium / numpy are
missing) that spawns `node tools/headless.mjs` (`PENGUINTRACK_NODE` picks the binary),
plus `get_state` / `set_state` / `replay`. `PenguinTrackVecEnv` batches n envs in one Node
process (`step_batch`); `make_vec_env(track, n, config, vec='subproc'|'dummy'|'batch')`.
`random_agent.py` is the zero-dependency smoke test; `train_ppo.py` trains
stable-baselines3 PPO (SubprocVecEnv, random-checkpoint starts), saves the model,
evaluates it greedily and exports the best episode as a replay JSON for the browser.

## Results

Measured on an M-series laptop (12 cores, shared with other jobs) with the
`tools/train.mjs` defaults (GA, population 64, 32-32 tanh, frame skip 4, discrete actions,
race fitness, seed 1). Times are verified replays; the autopilot is the core's
route-following driver. Official tracks were still being tuned when these ran.

**The demo driver** (`models/demo-S01.json`, 27 kB with its ghost and curve): S01 Frosty
Oval, 150 generations, 9600 evaluations, 1:34 on 8 workers (2:19 on 6):

| generation | best fitness | mean | finished | fastest |
| --- | --- | --- | --- | --- |
| 1 | 145.43 | 20.5 | 9 % | 24.57 s |
| 3 | 146.83 | 55.5 | 30 % | 23.17 s |
| 5 | 149.16 | 88.4 | 55 % | 20.84 s |
| 12 | 149.55 | 114.9 | 75 % | 20.45 s |
| 42 | 150.05 | 139.4 | 95 % | 19.95 s |
| 125 | 150.30 | 121.9 | 80 % | **19.70 s** |

(fitness 100 = finished, + seconds under the 70 s budget; autopilot 22.14 s). Rerunning
with 6 instead of 8 workers printed the identical 150-row curve.

From scratch on a harder sample, S02 Snowdrift Hills (slopes, banks, an elevated narrow
ridge, a tunnel): generation 1 reaches 49 % of the route, generation 5 finishes in 33.86 s,
generation 15 in 26.62 s, generation 100 in **23.53 s** (autopilot 23.58 s), 50 s of
training.

| track | generations | time | best | autopilot |
| --- | --- | --- | --- | --- |
| S01 Frosty Oval, ES | 100 | 1:27 | 19.89 s | 22.14 s |
| S01 Frosty Oval, continuous actions | 100 | 1:40 | 20.08 s | 22.14 s |
| S03 Penguin Air Show (loops, jumps), reward fitness | 60 | 0:42 | 24.43 s | 24.39 s |
| S05 Ice & Powder Run, reward fitness | 60 | 0:26 | 19.64 s | 24.71 s |
| A01 First Flakes | 100 | 1:12 | 23.04 s | 24.97 s |
| B02 Banked Hollow | 100 | 1:50 | 31.84 s | 28.44 s |
| C02 Looping Floes | 100 | 2:47 | 38.27 s | 35.61 s |
| T01 Oval (2 laps) | 100 | 2:01 | 31.51 s | 34.42 s |

The AI drivers stay on the road (checked: never beyond the half-width); they win on
grip-limited sections (ice, powder) where the autopilot's speed plan is conservative, and
lose on banks and loops, which need more generations. `--init models/demo-S01.json`
transfers: the S01 driver finishes 15 of 41 tracks zero-shot (A01 in 24.37 s, A05 23.27 s
vs the autopilot's 28.11 s) and fine-tuning on A01 reaches 23.97 s in two generations.

Throughput: ~20k env steps/s (80k ticks/s) per thread with random actions; an S01
episode is ~500 steps, so 8 workers evaluate 100–200 episodes per second.

## AI Lab (`js/ai/lab*.js`, `css/ai.css`)

The in-game trainer: Menu → AI Lab (`app.goto('ai')`, `?screen=ai`). Pick a track, train
a flock in Web Workers, watch every generation drive, keep the best driver, race it.

| file | what |
| --- | --- |
| `js/ai/lab.js` | the screen (`{ id: 'ai', enter, exit, back }`): DOM, training loop, live view, drivers, keys |
| `js/ai/lab-logic.js` | pure: presets, settings → env config / network / trainer options, which agents to show, colours, model files in storage `ai`, imports |
| `js/ai/lab-playback.js` | pure: `FieldPlayback`, a generation's episodes replayed side by side with the followed car's observations and network outputs |
| `js/ai/lab-chart.js` | the training curve (canvas 2D) |
| `js/ai/lab-overlay.js` | sensor rays and look-ahead points of the followed car (three.js lines through `renderer.three` / `renderer.scene`) |
| `js/ai/lab-help.js` | the "How it works" explainer (diagram, plain-language sections, Python / Node commands) |
| `css/ai.css` | Lab styles (loaded by the screen with a `<link>` on first entry) |
| `tools/tests/ai-lab.test.mjs` | Node tests for the pure parts (`node tools/test.mjs ai-lab`) |

**Layout.** Left: Train / Drivers tabs, with Train · Pause · Stop pinned at the bottom.
Right: progress tiles (best score, best time, finish rate, average, runs per second, training
time), the chart and the Driver card. Middle: the 3D field, the followed driver's decision
panel and the view bar. Works at 1280×720 and 1024×600; narrower than 820 px it stacks.

**Training.** Settings (the Quick / Balanced / Deep presets, or anything custom):

| setting | Quick | Balanced | Deep |
| --- | --- | --- | --- |
| algorithm | GA | GA | ES |
| population | 32 | 64 | 128 |
| hidden layers | 16 | 32 × 32 | 64 × 64 |
| mutation (GA std) / noise σ, step (ES) | 0.05 | 0.03 | 0.04 / 0.02 |
| frame skip | 5 | 4 | 4 |
| edge rays / look-ahead | 9 / 4 points | 15 / 4 | 21 / 5 (to 150 m) |
| generations (0 = no limit) | 30 | 100 | 300 |

Also: episode length (auto = route / 15 m/s like `tools/train.mjs`), ray fan, wall rays,
actions (9 buttons or analog), start (start line, any checkpoint, anywhere) and the seed.
`runConfig(settings, world, fromModel?)` turns them into `{ envConfig, arch, trainer,
workerInit }`; with "Start from the loaded driver's brain" the env config and network come
from the loaded model and its weights seed the population (GA) or the mean (ES).

The pool is `createWorkerPool(min(16, hardwareConcurrency − 1))`; each generation is one
`trainer.step()` whose evaluator asks the pool for every candidate's replay (a few kB of
run-length inputs each). The main thread only renders, so the page stays responsive. Pause
finishes the generation in flight and keeps the workers; Stop drops it at once (the GA has
not changed yet; for ES the RNG is rewound, so Continue asks the same generation again) and
closes the workers. Leaving the screen (racing the AI, TAS Studio, the menu) stops like that
too, but the trainer object stays in memory: back in the Lab it shows "Paused" with its curve
and Resume carries on. The trainer is the same `NeuroTrainer` as `tools/train.mjs`, so the
same seed and settings give the same curve as the CLI.

**Live view.** `pickShown(fitness, cap)` picks up to 32 (8 / 16 / 32) candidates spread
evenly over the ranking (always the best and the worst). `FieldPlayback` replays their
recorded inputs on one `PenguinEnv` sim + route tracker each (deterministic: every car
drives exactly the run its worker scored; the test checks end ticks, progress and the
network's argmax against the recorded actions). The best is an opaque gold car, the rest
are ghosts tinted by rank (ice cyan → violet → rose) that fade when they crash. Training
runs faster than real time, so a finished field moves on to the newest generation (or press
Latest). Cameras: chase / orbit follow the selected car, top shows the whole track.
For the followed car the overlay draws the edge rays (red = edge close, cyan = clear),
wall rays when enabled and the gold look-ahead points; the panel below shows the 3×3
action grid (brightness = softmax of the network's outputs, outline = the button pressed),
steer and throttle, the curvature ahead and the edge distances.

**Drivers.** Storage `ai` is `{ [name]: modelFile }`, the exact `makeModelFile` format
(`listModels` / `saveModel` / `deleteModel`). Saving a training run re-drives the best
weights from the start line (`buildModelFile`, like `tools/train.mjs`), so the stored replay
is a clean ghost and the file loads in the CLI (`--eval`, `--init`). Import accepts model
files (CLI, Lab exports), `tools/train.mjs` `.state.json` files (the run continues in the
browser: Continue) and anything the replay-code decoder reads (replay JSON from
`python/train_ppo.py` or TAS, `PTR` codes): those can be watched, raced and opened in TAS
Studio but have no network. Export downloads the model JSON. "Demo driver" fetches
`models/demo-S01.json`. A model's track is the catalog's when the layout hash matches, else
its embedded share code.

**Race / watch / TAS.** Race the AI: `app.goto('play', { track, ghosts: [{ replay, label,
color: '#ffd54a' }], onExit: () => app.goto('ai') })` (records and medals count as usual on
official tracks); Watch: the same with `mode: 'replay'`; TAS Studio: `app.goto('tas', {
track, replay, onExit })`, so the studio's Back returns to the Lab. `track` is the id when the catalog has that exact layout, else the JSON.

**Keys.** Space train / pause / resume (when no button has focus), Esc menu, C camera,
`[` `]` previous / next car, B follow the best, R rays, `-` `+` playback speed, H how it
works. Everything is a real button / input, so Tab and the gamepad's menu navigation work.

**Checked in headless Chrome** (SwiftShader): Quick on T01 reaches generation 23 in ~30 s
on 5 workers with 84 % of the flock finishing and a best of 31.79 s (autopilot 34.42 s);
the chart, 32 tinted cars, rays and the decision panel update; save → Drivers list →
Race the AI (gold "AI …" ghost in the race) → back to a paused Lab → Resume → Stop;
demo driver; ES with analog actions; importing a CLI model and a CLI `.state.json`
(continued from generation 3); 1280×720 and 1024×600.
