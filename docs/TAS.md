# Penguintrack TAS engine

Tool-assisted runs for Penguintrack: a script language in the spirit of
TMInterface, an editable per-tick input timeline, a runner with a savestate
cache that seeks anywhere in a run at once, and a bruteforce optimiser that
runs in a loop, a Web Worker or Node. Everything here is pure (no DOM) and
built on the deterministic core (`docs/CORE_API.md`), so a TAS run is an
ordinary replay: it re-simulates bit-identically and passes `verifyReplay`.

```js
import { InputTimeline } from './tas/timeline.js';
import { parse, serialize, fromReplay, toReplay, replayMeta, parseTime, formatTick } from './tas/script.js';
import { TasRunner, simulateTimeline, compareTimelines, ghostSamples } from './tas/runner.js';
import { Bruteforce, BruteforceSession, resolveTarget, parseTargetSpec, compareScores } from './tas/bruteforce.js';
// js/tas/bruteforce-worker.js: Web Worker shell around BruteforceSession
```

| file | what |
| --- | --- |
| `js/tas/timeline.js` | `InputTimeline`: per-tick inputs in typed arrays, edits with change notifications |
| `js/tas/script.js` | the script language: `parse`, `serialize`, replay conversion |
| `js/tas/runner.js` | `TasRunner`: cursor, savestate cache, slots, record mode, trace, ghost compare |
| `js/tas/bruteforce.js` | `Bruteforce` optimiser, targets, `BruteforceSession` (worker protocol) |
| `js/tas/bruteforce-worker.js` | module Web Worker running a `BruteforceSession` |
| `tools/tas.mjs` | command line: run, bruteforce, from-replay, autopilot, to-replay, fmt, compare |
| `tas-examples/` | `S01-autopilot.txt` (the autopilot's run) and `S01-bruteforced.txt` (after bruteforce) |
| `tools/tests/tas.test.mjs` | tests (`node tools/test.mjs tas`) |

## Time model

Physics runs at 100 ticks per second. **Input `t` is the input simulated by the
step from tick `t` to tick `t + 1`**, i.e. the input held during race time
`[t·10 ms, (t+1)·10 ms)`, exactly like a replay's input list (`replay.inputs[t]`,
`respawnTicks` are input indices). A script command at `1.23` changes input 123.
A checkpoint "at 6.61" was crossed by the step that produced tick 661, i.e. while
input 660 was held.

## Script language

One command per line, `#` starts a comment, blank lines are ignored.

```
# track: S01
# name: Frosty Oval, first try

0.00 press up              # full gas from GO
1.20-1.85 press left       # full left lock from 1.20 s, released at 1.85 s
2.40 steer 21000           # analog steering (held until changed)
3.10 steer 0
4.00-4.35 brake on         # same as 4.00-4.35 press down
5.50 respawn               # Enter on that tick: back to the last checkpoint
1:02.50 rel up
```

### Times

| form | example | meaning |
| --- | --- | --- |
| seconds | `12.34`, `7`, `0.5` | race time in seconds |
| minutes | `1:02.50` | `m:ss.cc` (seconds below 60) |
| range | `0-1.5`, `1:02.50-1:03` | the command at the start, its opposite at the end |

Every time must be a whole tick (a multiple of 10 ms): `12.345` is an error,
`12.340` is fine. Times above one hour (`MAX_REPLAY_TICKS`) are refused.

### Commands

| command | effect |
| --- | --- |
| `press up` / `rel up` | gas on / off |
| `press down` / `rel down` | brake on / off (reverse when stopped, drift with steering) |
| `press left` / `rel left` | full left lock (`steer -65536`) while held |
| `press right` / `rel right` | full right lock (`steer 65536`) while held |
| `steer <n>` | analog steering, an integer `-65536 .. 65536` (+ = right), held until changed |
| `gas on` / `gas off` | same as `press up` / `rel up` |
| `brake on` / `brake off` | same as `press down` / `rel down` |
| `respawn` | respawn on that tick only (`press enter` is accepted as an alias, `rel enter` is ignored) |

`release` is accepted for `rel`; commands and keys are case-insensitive.

### Semantics

- Commands are **events**: a state holds until another command changes it, and
  after the last line everything stays as it is (the last input is held), so
  `0 press up` alone keeps the gas down for the whole run.
- **Digital steering wins**: while `left` or `right` is held the steer is full
  lock (both held: 0); when neither is held the last analog `steer` value applies.
  `press left` does not forget the analog value.
- A **range** `a-b cmd` runs `cmd` at `a` and its opposite at `b`: `press`↔`rel`,
  `on`↔`off`, and `steer n` returns to `steer 0`. `respawn` takes no range.
- **Same tick**: range ends apply first, then the other commands in file order.
  So `0-1 press up` followed by `1 press up` (in either order) keeps the gas down;
  two lines that set the same control to different values on the same tick
  produce a warning and the later line wins.
- Lines need not be in time order.

### Header directives

`# key: value` comment lines **before the first command** are header directives,
returned as `meta` (lower-case keys). The tools write and read `track` (track id
used when the CLI is given no track), `hash` (the layout hash the script was made
on: the CLI warns on a mismatch), `name`, `time`, `laps`. Other keys are kept as is.

### Errors and warnings

`parse(text)` → `{ timeline, errors, warnings, meta, commands }`. Errors and
warnings are `{ line, message }` with 1-based line numbers, e.g.
`line 2: Time '1.005' is not a multiple of 10 ms (one tick)`. A line with an error
is skipped; the others still build the timeline, so an editor can show the
partial run. `commands` lists every valid command line as
`{ line, from, to (-1 without a range), channel, value }` for gutters and
jump-to-time.

### Canonical form

`serialize(timeline, { style, meta, comment })` writes the minimal script for a
timeline: one line per change of each control. Full lock is written as
`press left/right`, other steering as `steer n`.

- `style: 'ranges'` (default): a value followed by its "off" (gas, brake,
  left/right released, steer back to 0) becomes one range line `a-b cmd`.
- `style: 'events'`: one line per change (`press` and `rel` separately).

`parse(serialize(t)).timeline` equals `t` on every tick and
`serialize(parse(serialize(t)))` is the same text (tested on random timelines and
autopilot runs). Times are written `12.34` below a minute and `1:02.50` above.

### Replays

```js
const tl = fromReplay(replay);                  // replay object, '1:...' string or input array
const text = serialize(tl, { meta: replayMeta(replay) });   // # track/hash/name/time header
const rep = toReplay(tl, world, { laps, name }); // simulate to the finish (or timeline + 60 s) and record
verifyReplay(world, rep).ok                       // true for finished runs
```

`toReplay` records `sim.lastInput` every tick, so the replay holds exactly what
was simulated and stops at the finish.

## InputTimeline

Two typed arrays (`steer: Int32Array`, `flags: Uint8Array` with gas 1, brake 2,
respawn 4) and a length. Past the end the last input is held, minus its respawn
flag. All edits normalise steer like the sim (`clampSteer`).

```js
const tl = new InputTimeline();                 // or InputTimeline.fromInputs(arr) / .decode('1:...')
tl.length; tl.get(t, out?); tl.steerAt(t); tl.flagsAt(t)
tl.set(t, input)                                // replace one tick (grows with the held input)
tl.patch(t, { gas: false })                     // change some fields of one tick
tl.setRange(from, to, input); tl.patchRange(from, to, fields); tl.nudgeSteer(from, to, delta)
tl.insertTicks(at, count, fill?)                // later inputs move later (fill: the previous input)
tl.deleteTicks(at, count)                       // later inputs move earlier
tl.truncate(n); tl.clear(); tl.copyFrom(other); tl.materialize(n); tl.compact()
tl.clone(); tl.equals(other); tl.firstDifference(other, from?, to?); tl.diff(other) // [{ from, to }]
tl.changePoints(from?, to?); tl.respawnTicks(); tl.toInputs(n?); tl.encode(n?); tl.hash()
const off = tl.onChange((lowestTick, tl) => ...); tl.batch(() => { ...several edits... }); tl.version
```

Listeners hear the **lowest tick whose input changed** (no call when an edit
changes nothing, one call per `batch`). That tick is what caches invalidate from.

## TasRunner: seek and savestates

```js
const runner = new TasRunner(world, timeline, { laps, interval: 50, maxTicks });
runner.seek(tick)            // cursor to exactly that tick -> info()
runner.step(n, onTick?)      // n ticks forward, onTick(sim) after each (sim.events for effects/sounds)
runner.playTo(tick, onTick?) // forward with callbacks, or seek back
runner.playToFinish(onTick?)
runner.tick; runner.sim; runner.info(); runner.nextInput
runner.save(name); runner.load(name) -> { ...info, stale }; runner.slots; runner.deleteSlot(name)
runner.startRecording({ truncate = true }); runner.stepLive(input); runner.stopRecording()
runner.result()              // whole-run race result, cached until the next edit
runner.trace()               // whole-run per-tick arrays (speed, pos, progress, state flags, events)
runner.ghost(otherTimeline?) // simulateReplay samples for ghostPoseAt
runner.compare(otherTimeline)
runner.on('edit', ({ tick }) => ...); runner.on('seek', ({ tick }) => ...)
runner.setTimeline(tl); runner.dispose()
```

**Model.** The runner keeps exact `Sim.getState()` savestates (plus the route
tracker's state) every `interval` ticks, filled as ticks are simulated by the
cursor or by `trace()`/`result()`. `seek(t)` restores the nearest cached state at
or before `t` (or keeps stepping the live sim when it is already closer) and steps
at most `interval` ticks. The state at tick `T` depends only on inputs `0..T-1`,
so an edit at input `e` drops exactly the states after `e`; if the cursor is past
`e` it is re-simulated lazily on the next read, so it always shows the edited run.
A 2-minute run costs ~240 cached states of ~2 kB each.

Measured (Node 24, M-series, tests): a cold seek to 2:00 takes ~190 ms (it
simulates the run once), every seek after that ~0.4 ms; after an edit at 12 s of
S01, `trace()` rebuilds in ~30 ms (only the ticks after the edit).

**Savestate slots** are TMInterface's save/load state. A slot holds the exact
state; when the timeline is edited before the slot's tick the slot becomes
**stale**, and loading it re-simulates to its tick with the current inputs (the
result says `stale: true`), so the cursor never shows a state the timeline cannot
reproduce.

**Record mode**: `startRecording()` cuts the timeline at the cursor (pass
`{ truncate: false }` to overwrite tick by tick and keep the rest); each
`stepLive(input)` writes the live input at the cursor and steps. Without
recording, `stepLive` plays the timeline.

**trace()** (index `i` = state after `i` ticks): `{ ticks, speedKmh, pos (xyz),
progress (route metres, unwrapped over laps), state (1 airborne, 2 drifting, 4 a
wheel on the ground), events [{ tick, type, ... }], finished, finishTimeMs,
respawns, checkpointTimes, lapTimes }`. It runs to the finish or to the timeline
plus 60 s and is rebuilt from the lowest edited tick only.

**Ghost compare**: `compareTimelines(world, a, b, { laps })` → `{ a, b (race
results), firstInputDifference, divergeTick (first tick the cars are > 1 mm
apart), maxGap, maxGapTick, splits [{ index, a, b, delta (b - a, ms) }],
finishDelta }`. Both runs share the simulation up to the first differing input.

`simulateTimeline(world, timeline, { laps, maxTicks, state, sim, onTick })` is the
one-shot runner the other tools use (`maxTicks` is an absolute tick; default the
timeline plus 60 s of held input).

## Bruteforce

```js
const bf = new Bruteforce(world, baseTimeline, {
    target: 'finish',                    // see Targets
    window: { from: 0, to: 3000 },       // ticks whose inputs may change (to exclusive); default the whole run
    seed: 1,
    laps, maxTicks,
    cacheEvery: 4,                       // base-run savestate spacing (restart granularity)
    rules: {
        maxChanges: 3,                               // modifications per candidate: 1..maxChanges
        shift: { weight: 1, range: 3 },              // move one input change ±1..range ticks
        steer: { weight: 2, range: 8000, span: 12 }, // add ±1..range to the steering of 1..span ticks
        gas:   { weight: 0.5, span: 10 },            // toggle gas on 1..span ticks
        brake: { weight: 0.5, span: 10 },            // toggle brake on 1..span ticks
    },
});
bf.best          // { score, ticks, iteration, firstTick }; bf.initial: the base's
bf.describe()    // 'finish 0:21.42 (precise 21.41532 s)'
bf.bestTimeMs()  // finish / checkpoint targets
bf.step()        // one iteration -> improvement record or null
bf.run(n); bf.runFor(ms)   // -> improvements found
bf.improvements  // [{ iteration, score, text, timeMs, firstTick, timeline }]
bf.bestTimeline()// copy; cut at the finish for the finish target
bf.stats()
```

**One iteration**: copy the best timeline, apply 1..`maxChanges` random
modifications inside the window (kind picked by weight), find the first tick that
really changed (changes may cancel out: then the iteration is a no-op), restore
the base run's savestate at or before that tick, and simulate until the target
stops. Respawn flags are never touched.

- `shift` picks an input change in the window (steer, gas or brake changing
  value) and moves it earlier or later by up to `range` ticks, only over the
  neighbouring run of that control (TMInterface's "input timing").
- `steer` adds a random offset to a stretch of ticks (clamped to full lock),
  keeping the shape of analog steering (TMInterface's "steering modification").
- `gas` / `brake` flip the pedal on a stretch of ticks.

**Accepting**: a candidate replaces the best only when its score is **strictly
lower** (scores are arrays compared lexicographically). Ties are rejected, so the
base wins ties and the search never drifts sideways. On acceptance the base cache
is rebuilt from the first changed tick.

**Early abandon**: for the finish and checkpoint targets a candidate still
racing at the best run's finish (checkpoint) tick cannot win and stops there.
With the savestate restart this makes late changes cheap: S01 runs ~60–80
iterations/s on one core (~130k ticks/s).

**Determinism**: the RNG is seeded (`Rng`, mulberry32) and only the iteration
count matters, not how the iterations were batched: same world, base, options and
seed give the same improvements in Node, the browser and a worker.

### Targets

| spec | CLI | score (lower is better) |
| --- | --- | --- |
| `'finish'` | `finish` | finished: `[0, respawns (platform mode only), finish tick, sub-tick crossing]`; not finished: `[1, -checkpoints, -route metres]` |
| `{ type: 'checkpoint', index: N }` | `checkpoint:N` | N-th checkpoint crossing of the run: `[0, tick, sub-tick]`, else `[1, -checkpoints, -metres]` |
| `{ type: 'speed', tick: T }` | `speed@12.5` | `[-speed (m/s) at tick T]` |
| `{ type: 'position', point: [x,y,z], tick: T, mode: 'min' }` | `position:x,y,z@12.5` | `[closest distance reached by T, tick of it]` |
| `{ ..., mode: 'at' }` | `position-at:x,y,z@12.5` | `[distance at tick T]` |
| custom evaluator | (API only) | whatever it returns |

**Tie-break on time targets: the precise time.** Race times are whole ticks,
so most changes leave the finish tick as is. Like TMInterface's "precise time",
the score adds the fraction of the finishing tick at which the car's swept segment
entered the finish box (`segmentAABB`), i.e. the precise time
`(tick - 1 + fraction) · 10 ms`. The tick still ranks first; the fraction only
breaks ties, which lets the search creep towards the next whole tick. A run that
does not finish ranks behind every finishing run, by checkpoints taken and then by
distance along the route, so a broken base can be repaired too. In platform mode
fewer respawns beat any time.

**Custom evaluators** are objects (plain-JSON `acc` so it can sit in savestates):

```js
const target = {
    name: 'highest jump',
    stopTick: 900,                            // simulate to this tick (default: finish / run limit)
    stopAtFinish: true,
    begin: (sim) => ({ top: 0 }),             // accumulator at tick 0
    tick: (sim, acc, prevPos) => { acc.top = Math.max(acc.top, sim.car.pos[1]); },  // return true to stop
    score: (sim, acc) => -acc.top,            // number or array, lower is better
    bound: (bestScore) => Infinity,           // optional: tick a candidate must not reach unfinished
    describe: (score) => `${(-score).toFixed(2)} m`,
};
```

A bare function `(sim) => score` is evaluated at the stop point. In a worker,
pass `{ type: 'custom', source: '<JS source of such an object or function>' }`
(compiled with `new Function` in the worker; it is the user's own code).

### Web Worker protocol

```js
const w = new Worker(new URL('./tas/bruteforce-worker.js', import.meta.url), { type: 'module' });
w.postMessage({ type: 'start', track /* JSON */ /* or code: 'PT1...' */, inputs: tl.encode() /* or script: text */,
                options: { target: 'finish', seed: 1, window: { from: 0, to: 3000 }, rules: {...} },
                maxIterations: 20000, timeLimitMs: 300000, sliceMs: 40, reportMs: 250 });
w.onmessage = ({ data }) => { ... };
w.postMessage({ type: 'pause' }); w.postMessage({ type: 'resume' }); w.postMessage({ type: 'stop' });
```

| message out | fields |
| --- | --- |
| `ready` | `best { score, text, timeMs }`, `window`, `cacheEvery` |
| `improvement` | `iteration`, `best`, `firstTick`, `inputs` (core encoding of the new best) |
| `progress` | `iterations`, `evaluated`, `improvements`, `rate` (it/s), `elapsedMs`, `best` (every `reportMs`) |
| `done` | `reason: 'iterations' \| 'time' \| 'stopped'`, `iterations`, `best`, `inputs` |
| `error` | `message` |

The worker builds the world itself (Worlds cannot be posted). It runs in slices of
`sliceMs` so `pause`/`stop` are handled promptly. `BruteforceSession(post, {
schedule })` is the same machine without a worker (Node, tests).

### Tips

- Bruteforce a window at a time (`--window 8-12`): every candidate then
  re-simulates only from inside the window, and the changes stay local.
- Small `steer.range` (2000–4000) polishes a good line; large ranges explore.
  Raise `gas`/`brake` weights on runs with lots of braking.
- Seeds explore differently: run a few in parallel workers and keep the best.
- The speed and position targets are for setting up a section (exit speed of a
  turn, landing spot of a jump) before bruteforcing the finish.

## Command line

```
node tools/tas.mjs run <track> <script.txt> [--laps N] [--max SECONDS] [--replay out.json] [--json]
node tools/tas.mjs <track> <script.txt>          # same as run (the short form in ARCHITECTURE.md)
node tools/tas.mjs bruteforce <track> <script.txt> [--target finish|checkpoint:N|speed@S|position:x,y,z@S]
     [--iterations 20000] [--time SECONDS] [--seed 1] [--window 0-30] [--changes 3] [--shift 3]
     [--steer 8000] [--span 12] [--weights shift=1,steer=2,gas=0.5,brake=0.5]
     [--out better.txt] [--style ranges|events] [--report SECONDS] [--quiet]
node tools/tas.mjs from-replay <replay.json | PTR replay code | 1:... input string> [--out script.txt]
node tools/tas.mjs autopilot <track> [--out script.txt]
node tools/tas.mjs to-replay <track> <script.txt> [--out replay.json] [--code]
node tools/tas.mjs fmt <script.txt> [--style ranges|events] [--out script.txt]
node tools/tas.mjs compare [<track>] <a.txt> <b.txt> [--laps N]
```

`<track>` is an official track id (`js/levels/index.js` `getTrack`), a dev sample
`S01`–`S06`, a track JSON file (or `{ track }`) or a `PT1.` share code; it may be
left out when the script has a `# track:` header (`from-replay` of a `PTR1.` /
`PTR2.` replay share code of a custom track writes the track's `PT1.` code there).
`to-replay --code` prints a replay code instead of JSON: paste it into the game's
Replays → Import code to watch the run or race it as a ghost (the game also accepts
the replay JSON itself). `run` prints checkpoint splits,
the finish time, respawns and validity (the run is recorded as a replay and
checked with `verifyReplay`); exit code 2 when the run does not finish, 1 on script
errors (printed as `file:line: error: ...`). `bruteforce` writes `--out` on every
improvement and on Ctrl-C, so a long run can be stopped at any time. `compare`
is the ghost compare: where the inputs and the cars part, and split deltas.

## Worked example: S01 Frosty Oval

```
node tools/tas.mjs autopilot S01 --out tas-examples/S01-autopilot.txt
node tools/tas.mjs bruteforce S01 tas-examples/S01-autopilot.txt --iterations 20000 --seed 1 --out pass1.txt
node tools/tas.mjs bruteforce S01 pass1.txt --iterations 8000 --seed 2 --steer 3000 --span 25 \
     --weights shift=1,steer=2,gas=1,brake=1 --out tas-examples/S01-bruteforced.txt
node tools/tas.mjs run tas-examples/S01-bruteforced.txt
node tools/tas.mjs compare tas-examples/S01-autopilot.txt tas-examples/S01-bruteforced.txt
```

| run | finish | CP 1 | CP 2 | iterations | wall time (one core, shared machine) |
| --- | --- | --- | --- | --- | --- |
| autopilot (`S01-autopilot.txt`) | 0:22.14 | 0:06.61 | 0:14.48 | | |
| pass 1, default rules, seed 1 | 0:21.39 | 0:06.67 | 0:14.47 | 20000 (536 improvements) | 399 s |
| pass 2, finer steering, longer pedal spans, seed 2 (`S01-bruteforced.txt`) | **0:21.07** | 0:06.68 | 0:14.42 | 8000 (~140 improvements) | 149 s |

**−1.07 s** (4.8 %) over the autopilot in about nine minutes of one core; both
scripts re-simulate as replays that pass `verifyReplay`. Almost all of the gain
is in the last sector (7.66 s → 6.65 s): the autopilot brakes for 1.52 s there and
slows to 92 km/h, the bruteforced run brakes for 0.38 s, never drops below
127 km/h and spends 0.38 s of it in a brake drift (the autopilot never
drifts). It gives up 0.07 s to the first checkpoint for that. Both passes are
deterministic, so the commands above reproduce the runs exactly (the shipped
file only has a hand-written header). The first
pass found most of its gain in its first 3000 iterations (0:21.52); later gains
come in hundredths, which is when changing the rules (smaller steering offsets,
longer pedal edits) or bruteforcing one window at a time pays off.

## TMInterface comparison

| | TMInterface (Trackmania) | Penguintrack TAS |
| --- | --- | --- |
| tick | 10 ms | 10 ms, times must be whole ticks (error otherwise) |
| time format | ms or `m:ss.cc` | seconds `12.34`, `m:ss.cc`, ranges `a-b` |
| keys | `press/rel up/down/left/right` | same, plus `gas on/off`, `brake on/off` aliases |
| analog steer | `steer n` (±65536) | same; held digital steering wins over the analog value |
| analog gas | `gas n` | no: gas and brake are on/off in Penguintrack's input model |
| respawn | `press enter` | `respawn` (or `press enter`) on one tick |
| range end | opposite action | same; same-tick rule: range ends first, then file order |
| after the last command | inputs stay as they are | same (the last input is held) |
| savestates | save/load state slots | exact `Sim` states, slots go stale when inputs before them change |
| rewind / seek | load state + replay | savestate cache every 50 ticks, ~0.4 ms seeks, invalidated from the lowest edited tick |
| bruteforce targets | finish, checkpoint, trigger, custom scripts | finish, checkpoint N, speed at T, position (closest or at T), custom JS evaluators |
| precise time | interpolated finish crossing | swept-segment entry fraction in the finish box (same idea) |
| modifications | input timing shift, steering, fill | shift ±k ticks, steer offset over a span, gas / brake toggles, weighted |
| restart point | savestate before the first changed input | same (base run states every 4 ticks) |
| acceptance | improvement only | strictly better score; ties keep the base |
| determinism | game-version dependent | bit-identical on every JS engine; seeded RNG, batching-independent |
| where it runs | inside the game | browser main thread, Web Worker, Node CLI |
| validity | the game's replay validation | every result is a core replay that passes `verifyReplay` |

## For the TAS Studio (`js/tas/studio.js`)

- Keep one `TasRunner` per open project; draw the cursor from `runner.sim.car` (or
  `snapshotCar`) and the whole run from `runner.trace()` (speed graph, minimap
  line, event markers). Call `trace()` after edits (debounced): it only re-runs from
  the edited tick and also fills the seek cache.
- Edit through the timeline (`set`, `patchRange`, `insertTicks`, ...) or re-parse
  the script text; on re-parse, `runner.timeline.copyFrom(parsed.timeline)`
  notifies once with the first changed tick, so the cache survives everything
  before it.
- `parse().commands` maps script lines to ticks (gutter markers, jump to time);
  `errors`/`warnings` carry line numbers for the editor.
- Playback: `runner.step(1, (sim) => { renderer.handleEvents(sim.events); audio.handleEvents(sim.events); })`
  from `app.loop`'s `onTick`; recording: `runner.startRecording()` then
  `runner.stepLive(app.controls input)` per tick.
- Ghost of another version: `runner.ghost(otherTimeline)` and `ghostPoseAt`;
  numbers from `runner.compare(otherTimeline)`.
- Bruteforce in `bruteforce-worker.js`; on `improvement`, offer
  `InputTimeline.decode(msg.inputs)` as a new version (serialize it to show the script).
- Save projects as `{ trackId, script, notes }` under the `tas` storage key.

## TAS Studio (the screen)

The in-game studio (menu → TAS Studio, or **TAS Studio** on a replay) is built on the
engine above. Files:

| file | what |
| --- | --- |
| `js/tas/studio.js` | the screen (`{ id: 'tas', enter, exit }`): layout, project lifecycle, transport, savestates, record mode, ghost, keys |
| `js/tas/studio-timeline.js` | `TimelineCanvas`: the piano roll (ruler, speed, steering graph, gas / brake / respawn rows, overview) |
| `js/tas/studio-script.js` | `ScriptEditor`: textarea + line gutter with live parse, errors / warnings, the command at the cursor |
| `js/tas/studio-bf.js` | `BruteforcePanel`: form, worker, progress, improvement history, apply / ghost |
| `js/tas/studio-model.js` | pure logic (Node-tested in `tools/tests/tas-studio.test.mjs`): view maths, edits, undo, markers, readouts, bruteforce form → options, projects |
| `css/tas.css` | styles (loaded with the screen through `loadModuleCss`) |

**Params.** `app.goto('tas', params)`:

| params | opens |
| --- | --- |
| `{ track, replay }` | a new project from that run (the Replays screen and the replay viewer send this) |
| `{ track, start? }` | a new project on `track` (id or JSON); `start`: `'autopilot'` (default), `'empty'`, `'emperor'` |
| `{ project: name }` | a saved project |
| `{ resume: true }` or `{}` | the project open when the studio was last left (kept in memory for the page session; Watch comes back through it); with nothing remembered, A01 from the autopilot and the Project tab |

Any of these may add `onExit()`: Back calls it instead of going to the menu (the AI
Lab and Replays send one so Back returns there). It is kept across Watch and back.

**Model.** One `TasRunner` per project; the timeline is the truth. Every edit (roll,
script, bruteforce apply, recording, undo) goes through the timeline; the runner drops
only the states after the edited tick, `trace()` is rebuilt 120 ms after the last edit
(markers, speed row, splits, end of run), and the script text is re-serialised 160 ms
later unless the script editor has focus. A script that parses **without errors** is
applied with `timeline.copyFrom` (one notification from the first changed tick); a
script with errors leaves the timeline alone and lists the problems by line.
Re-serialising keeps the header directives (`track`, `hash`, `name`, `time` are rewritten)
but not free comments between commands: the canonical form is what comes back.

**3D view.** The scene is drawn only in the free area (`renderer.setViewports` with the
view element's rectangle; reset on exit). Cameras: chase, close, orbit, free, cockpit,
top. The overlay shows tick, race time (ms), speed (km/h, 3 decimals), position,
velocity, yaw / pitch / roll (degrees; yaw 0 = +Z, + = towards +X; pitch + = nose up;
roll + = right side down), surface and wheels on the ground, state (airborne,
drifting, gear, checkpoints, lap), pad effects and the input at the cursor. The splits
box lists checkpoint times and, with a ghost, the delta against it (`compareTimelines`).

**Ghost.** Off, the run as the session started, the Emperor run, the personal best, the
last save, or the bruteforce best ("Show as ghost"). It is a `GhostRun` drawn as a
ghost car, a faint second steering line on the roll and split deltas.

**Piano roll.** Click / drag the ruler or the speed row to seek (scrub). Draw tool:
drag in the steering row to draw analog steering (snaps to 0 and full lock near them,
Alt = 1/8 steps), click / drag in the gas or brake row to paint the pedal (the first
tick decides on or off), click the respawn row to toggle a respawn. Select tool (or
Shift-drag with any tool) selects a range. Wheel zooms around the pointer, Shift-wheel
or a horizontal swipe scrolls, the overview strip drags the view. Markers: checkpoints
(cyan), laps and finish (gold), respawns (dashed), savestate slots (numbered flags,
dim when stale), the loop region (amber). The darker area after the timeline's end is
the held last input.

**Edits** (undoable, 80 steps): copy, cut (copy + clear), paste over at the selection
or cursor, paste-insert, clear to neutral, remove ticks (later inputs move earlier),
insert ticks holding the previous input, move the selection a tick (the gap holds the
neighbouring input), steer the selection ±1024 (Shift ±8192).

**Transport.** Play / pause, frame forward (steps with events, so particles and sounds
play), frame back (a seek: the cache keeps it ~0.4 ms), ±10 ticks with Shift, ±1 s with
Ctrl, start / end, previous / next checkpoint, jump to a typed time (`12.34`,
`1:02.50` or `t1234`), speed 0.05×–4× (`loop.timeScale`), loop the selection. The
cursor may run 1.5 s past the finish so the line can be inspected.

**Savestates.** Shift+1…0 saves the cursor's exact state, 1…0 loads it
(`runner.save/load`, so a slot whose earlier inputs changed re-simulates). Slot ticks
are saved with the project and rebuilt on load.

**Record mode** (R): after a short "get ready" the live input from `app.controls`
(keyboard, gamepad analog stick, touch) overwrites the timeline tick by tick from the
cursor, at a chosen slow motion (0.1×–1×). A fall queues a respawn on the next tick as
in a race; Enter respawns. R or Esc stops; "keep rest" keeps the inputs after the stop
point, "cut after" truncates there. The whole take is one undo step.

**Bruteforce tab.** Target (finish, checkpoint N, speed at a time, reach a position —
closest by a time or distance at it, "Car pos" fills it from the cursor), window
(from / to times, from the selection or the cursor), rules (changes per iteration,
seed, steer range / span, shift range, weights, iterations), Start / Stop in
`bruteforce-worker.js`, live iterations and rate, start and best scores, gain, and the
improvement history (click one to apply that version). **Apply to timeline** replaces
the timeline with the best run (undoable); the worker runs on a copy of the timeline as
it was at Start.

**Project tab.** Name and notes, new run (track picker: campaign, platform, training,
your tracks, dev samples; start from autopilot, empty, Emperor, personal best or a saved
replay of that track), import a script (a `# track:` header switches track) or a replay
code / JSON, export the script or a replay code, saved projects (open / delete).
Projects live in storage `tas` as `{ [name]: { trackId, track? (custom tracks are
embedded), script, notes, slots: [{ name, tick }], cursor, result, updated } }`.

**Top bar.** Save (Ctrl+S), **Validate** (builds a fresh world, records the timeline
with `toReplay`, checks it with `verifyReplay` and compares with the studio's run:
final time, tick count, match), **Watch** (the replay viewer; Back returns to the
studio), **Save as replay** (into Replays, finished runs only), **Keys** (shortcut list).

### Keys

| key | |
| --- | --- |
| Space | play / pause |
| `,` `.` (← → unless the free camera is on) | frame back / forward; Shift ×10, Ctrl ±1 s |
| Home / End, PageUp / PageDown | start / end, previous / next checkpoint |
| `[` `]` | speed |
| 1…0 / Shift+1…0 | load / save savestate |
| R, L, C, G | record, loop selection, next camera, ghost on / off |
| D / V | draw / select tool |
| Ctrl+C / X / V, Ctrl+Shift+V | copy / cut / paste over, paste insert |
| Delete, Shift+Delete, Insert | clear, remove ticks, insert ticks |
| Alt+← → | move the selection a tick (Shift ×10) |
| `-` `=` | steer the selection left / right |
| Ctrl+Z, Ctrl+Shift+Z / Ctrl+Y | undo, redo |
| Ctrl+A, Esc | select the whole timeline, clear selection / stop recording (with nothing selected, Esc is Back) |
| Ctrl+Enter in the script | parse now |

Keys typed into the script, time box and form fields stay there.

### Checked in headless Chrome

A01 from the autopilot (0:24.97), drawing steering (cache dropped from the edit, finish
recomputed, script re-serialised, undo restores 0:24.97), seeks (~0.4 ms after the trace),
frame advance / back, savestates by key and API, 400 bruteforce iterations from 18.00 in
the worker (~130 it/s under SwiftShader, 0:24.97 → 0:24.86) and Apply, Validate (fresh
world, `verifyReplay` ok, matches), save / reload a project with its slot, Watch and
back (resume), a project from a replay, Save as replay, record mode at 0.25× with
ArrowUp held, the Emperor ghost with split deltas, loop playback, script errors by
line, 1280×720 and 1024×600.
