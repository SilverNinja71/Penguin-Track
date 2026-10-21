# Penguintrack architecture

Penguintrack is a snow-themed, Trackmania-style time-attack racer that runs in the
browser with no build step, plus TAS (tool-assisted speedrun) tools and an AI
training kit. This document is the contract every module follows. When code and
this document disagree, fix one of them so they match.

## Ground rules

- **Vanilla ES modules, no build, no npm runtime deps.** The game is served as static
  files (GitHub Pages serves the repo root; the game lives at `/Penguin-Track/`).
  The only third-party code is the vendored Three.js r185.1 in `vendor/`
  (`import * as THREE from 'three'` via the import map in `index.html`;
  addons: `three/addons/BufferGeometryUtils.js`, `three/addons/Sky.js`). The one
  exception: online rooms (`js/mp/net.js`) load PeerJS 1.5.4 from unpkg on demand.
- Relative imports always include the `.js` extension.
- Style follows the repo `.editorconfig`: 4-space indent, LF, final newline.
  Comments: short, explain *why*, match the existing density (sparse).
- **`js/core/` is pure**: no DOM, no `window`, no `three`, no `Math.random`, no
  `Date.now`, no timers. It must run unchanged in the browser main thread, a Web
  Worker and Node (>=18). Everything else may import from core; core imports only core.
- Node tooling lives in `tools/` (`*.mjs`, Node built-ins only). Python lives in `python/`.
- Snow theme everywhere: names, colours, sounds, copy. The player's vehicle is a
  penguin driving a little snow racer.

## Directory layout and ownership

```
penguintrack/
  index.html               app shell, import map, loads js/main.js            [shell]
  css/style.css            design tokens + shared components                  [shell; tokens fixed below]
  css/<module>.css         per-module styles (game.css for the shell, audio.css for the audio bench,
                           editor.css, tas.css, ai.css, mp.css: loaded with their lazy screen)
  favicon.svg
  vendor/                  three.module.min.js, three.core.min.js, addons/   [do not edit]
  js/main.js               bootstrap, App object, screen router               [shell]
  js/core/                 deterministic simulation                           [core]
    constants.js           units, tick rate, limits
    mathd.js               deterministic math (dsin/dcos/datan2/…), vec3/quat helpers
    rng.js                 seeded PRNG (mulberry32)
    geom.js                sweep toolkit used by blocks.js
    blocks.js              block catalog (geometry generators, connectors, triggers)
    track.js               track model, validation, path builder, buildWorld()
    collision.js           triangle mesh + spatial grid, raycast/sphere queries
    route.js               centerline route + progress along it
    car.js                 vehicle physics
    sim.js                 Sim: race rules, triggers, effects, respawn, savestates
    input.js               input model + helpers
    replay.js              input recording, compact encoding, ghost sampling
    codec.js               track share codes
    autopilot.js           route-following driver (validation, baselines, demo), runAutopilot()
    format.js              formatTime(): the one race-time format for every screen
    samples.js             six dev fixture tracks S01–S06 (tests, demos)
  js/levels/               official tracks + campaign index                   [levels]
    index.js               CAMPAIGNS, getTrack/trackInfo; baked.js holds the baked medals + Emperor ghosts
    build.js, scenery.js   track-building helpers; one file per tier (fresh-powder … polar-night,
                           platform, training); medals.js medal rules
  js/render/               Three.js rendering                                 [render]
    renderer.js            GameRenderer (contract in RENDER.md): world, cars, cameras, viewports
    trackmesh.js, models.js, props.js, scenery.js, environment.js, effects.js, carmodel.js,
    cameras.js, textures.js, layout.js
  js/audio/                WebAudio procedural sound (audio, synth, sfx, music, carvoice)   [audio]
  js/game/                 the shell                                          [shell]
    menu, campaign, play/race/hud/minimap, results, replays/replayer, mytracks,
    settings(-screen), help   the shell screens and the race
    catalog, records, storage, replaycode, ghost, controls, loop, backdrop, account
    dom.js                 h(), loadModuleCss() and other DOM helpers shared by every screen
    ui.js, icons.js        dialogs/toasts/code dialog; SVG icons
    stubs.js, unavailable.js  null renderer/audio; stand-in for a lazy screen that failed to load
  js/editor/               track editor (EDITOR.md)                           [editor]
    editor.js              the screen + EditorSession (DOM, input, test drive, save/share)
    model.js               pure editing model: placement, snapping, undo, validation records
    view3d.js, thumbs.js   grid/ghost/cursor overlays; palette thumbnails
  js/tas/                  TAS engine + TAS Studio (TAS.md)                   [tas]
    script.js, timeline.js, runner.js, bruteforce.js, bruteforce-worker.js   the engine
    studio.js              the TAS Studio screen
    studio-timeline.js, studio-script.js, studio-bf.js, studio-model.js       piano roll, script tab,
                           bruteforce panel, pure helpers/projects
  js/ai/                   AI kit + AI Lab (AI.md)                            [ai]
    env.js, policy.js, nn.js, neuro.js, pool.js, worker.js, tracks.js        env, networks, trainers
    lab.js                 the AI Lab screen
    lab-logic.js, lab-playback.js, lab-chart.js, lab-overlay.js, lab-help.js  pure helpers, field
                           replay, training chart, rays overlay, explainer
  js/mp/                   multiplayer (MULTIPLAYER.md)                       [mp]
    mp.js                  the screen (hot-seat / split-screen / online tabs)
    hotseat.js, hotseat-view.js; racer.js, splitinput.js, split-view.js; protocol.js, room.js,
    net.js (PeerJS, loaded on demand), online-view.js; scoring.js, common.js
  dev/                     dev-only pages (world-viewer, render-demo, audio-demo + audio-check.js); not linked from the game
  tools/                   Node CLIs: test (tests/*.test.mjs, one file per module), sim-probe,
                           verify-levels, bake-levels, headless env server, train, tas; lib/ test worlds
  python/                  gymnasium wrapper + training examples
  models/                  trained AI drivers (demo-S01.json)                  [ai]
  tas-examples/            example TAS scripts                                  [tas]
  docs/                    this file, CORE_API.md, TRACK_FORMAT.md, GAME.md, RENDER.md, AUDIO.md,
                           LEVELS.md, EDITOR.md, TAS.md, AI.md, MULTIPLAYER.md
  package.json             "type": "module", scripts only, no dependencies
  README.md
```

A module owner edits only its own folder plus the files marked for it. Cross-module
changes go through the interfaces below.

## Units, axes, time

- Metres, seconds, radians. **Y is up**, right-handed (Three.js convention).
- Block grid: one cell is **32 m × 8 m × 32 m** (X × Y × Z). Cell `(x, y, z)` spans
  world `[32x, 32x+32) × [8y, 8y+8) × [32z, 32z+32)`. Track floor at height level
  `y` sits at world `Y = 8*y`. Level 0 is the snowy ground plane (drivable deep snow,
  `Y = 0`, flush with level-0 decks).
- Map size: up to 48 × 32 × 48 cells (x, z in `0..47`, y in `0..31`).
- Directions (cardinal headings, clockwise seen from above):
  `DIRS = [[0,0,1], [-1,0,0], [0,0,-1], [1,0,0]]` (0 = +Z, 1 = −X, 2 = −Z, 3 = +X).
  Turning **right** while driving is `d → (d+1)%4`, left is `d → (d+3)%4`.
  (Facing +Z with Y up, the driver's right-hand side is −X.)
- Physics runs at a fixed **100 ticks per second** (`TICK = 0.01 s`). Race time is
  `ticks * 10` ms, so every time is a multiple of 10 ms, shown as `m:ss.cc`
  (or `ss.ccc` style with the trailing 0, e.g. `42.370`).
- Rendering interpolates between the previous and current tick.

## Determinism (non-negotiable)

Replays, ghosts, TAS scripts and AI training all rely on bit-identical results for
the same inputs on every JS engine.

- Core physics uses only `+ - * /`, `Math.sqrt`, `Math.abs`, `Math.min/max`,
  `Math.floor/ceil/round/sign`, `Math.fround` is not used. Trig and other
  transcendental functions go through `mathd.js` (polynomial implementations).
  **Never** call `Math.sin/cos/tan/atan2/exp/pow/hypot/log` in core.
- No iteration over object keys in physics-relevant code where order could vary;
  use arrays.
- `Sim.getState()` returns a plain JSON-safe object that fully captures everything
  that influences future ticks; `Sim.setState(s)` restores it exactly.
  `JSON.parse(JSON.stringify(state))` must round-trip (no NaN/Infinity, no typed
  arrays in state).
- Tests in `tools/test.mjs` check: same inputs ⇒ identical state hash; savestate
  mid-run + resume ⇒ identical to uninterrupted run.

## Core API (summary — `docs/CORE_API.md` is the full reference written by core)

```js
import { TICK, TICK_MS, CELL, LAYER, STEER_MAX, DIRS } from './core/constants.js';
import { BLOCKS, BLOCK_LIST, SURFACES } from './core/blocks.js';
import { buildWorld, validateTrack, trackFromPath, normalizeTrack } from './core/track.js';
import { Sim } from './core/sim.js';
import { encodeInputs, decodeInputs, Recorder } from './core/replay.js';
import { encodeTrack, decodeTrack } from './core/codec.js';
import { Autopilot } from './core/autopilot.js';
```

- **Input** (one per tick): `{ steer, gas, brake, respawn? }` — `steer` is an integer in
  `[-65536, 65536]` (negative = left, positive = right; keyboard gives ±65536),
  `gas` and `brake` are booleans. `STEER_MAX = 65536`.
- **Track JSON** (see `docs/TRACK_FORMAT.md`):
  ```js
  {
    format: 1, id: 'A01', name: 'First Flakes', author: 'Penguintrack',
    mood: 'day' | 'sunset' | 'night' | 'aurora',   // sky/lighting preset
    mode: 'race' | 'platform',                     // platform = fewest respawns wins
    laps: 1,                                        // >1 only with a StartFinish block
    medals: { author, gold, silver, bronze },       // ms (platform: respawn counts + time)
    blocks: [ { b: 'Straight', x, y, z, r, s } ],   // b block id, r rotation 0..3, s surface id
    decor:  [ { d: 'Pine', x, y, z, r } ],          // optional scenery, never collidable for physics routes
  }
  ```
- `buildWorld(track)` → `World`:
  - `collision` — triangle mesh with spatial grid: `raycast(origin, dir, maxDist)`
    returns `{ t, point, normal, surface, surfaceId, tri } | null` (`surface` is an index
    into `SURFACE_IDS`, `surfaceId` the string); sphere queries for the car;
    `collision.triBlock[tri]` is the block index of a triangle.
  - `triggers` — checkpoints, finish, start, special pads (axis-aligned/oriented boxes).
  - `spawn` — `{ pos:[x,y,z], dir }` start position/heading.
  - `route` — centerline polyline start→finish through all checkpoints, with
    `length`, `project(pos, hintIndex) → { s, index, lateral, point, tangent }`
    and `pointAt(s)`, used by autopilot, AI rewards and the HUD minimap.
  - `render` — data for the renderer, no Three.js types:
    `meshes: [{ material, positions, normals, uvs, indices, ranges }]` (typed arrays;
    `ranges` slice indices per block) grouped by material id: `road_snow|powder|ice`,
    `platform_snow|powder|ice`, `border` (snowbanks), `wall` (deck sides/undersides/caps),
    `roof_ice` (tunnel), `line_start|finish|checkpoint` and `pad_<effect>` decals, `ground`;
    and `props: [{ kind, pos, dir, blockIndex, … }]` with kinds `gate`, `pad`, `pillar`,
    `spawn`, `decor` that the renderer draws as models (see CORE_API.md §3 Render data).
  - `bounds` — world AABB of the track; `fallY` — below this the car is out (respawn).
- **Sim**:
  ```js
  const sim = new Sim(world, { laps });     // tick 0 = the instant the race starts ("GO")
  sim.step(input);                           // advance one tick
  sim.tick; sim.timeMs; sim.finished; sim.finishTimeMs; sim.lap;
  sim.checkpointTimes;                       // ms per checkpoint crossed (this run)
  sim.respawns;                              // count (platform mode)
  sim.car                                    // read-only view: pos, quat [x,y,z,w], vel, angVel,
                                             // speed (m/s), speedKmh, forwardSpeed, rpm (0..1), gear,
                                             // wheels[4] { contact, surface, compression, steer, spin, pos, slip },
                                             // effects { turbo, noEngine, noSteer, noBrake, slowmo, cruise, fragile },
                                             // airborne, drifting, surfaceUnder
  sim.events                                 // events emitted during the last step:
                                             // { type: 'checkpoint'|'missingCheckpoints'|'lap'|'finish'|'respawn'|'boost'|'effect'|'land'|'wallhit'|'fall'|'fragileBreak', … }
  sim.lastInput                              // the normalised input the last tick simulated (record this)
  sim.respawn();                             // request a respawn at the start of the next step (prefer input.respawn = true)
  sim.getState(); sim.setState(state);       // exact savestates
  sim.reset();                               // back to tick 0
  ```
- **Replays**: `Recorder` collects inputs per tick; `encodeInputs(arr)` → compact
  string (run-length), `decodeInputs(str)`. A replay is
  `{ trackId, trackHash, inputs: '<encoded>', timeMs, respawnTicks: [...], date, name }`.
  Ghosts are produced by re-simulating a replay (deterministic) and sampling poses.
- **Autopilot**: `new Autopilot(world, opts).act(sim) → input`; follows the route with
  look-ahead steering and curvature-based speed control. Used to prove every
  official track is finishable and to produce medal baselines.

## Renderer contract (`js/render/`, owned by render)

```js
import { GameRenderer } from './render/renderer.js';
const r = new GameRenderer(canvasElement, { quality: 'low'|'medium'|'high', reducedMotion });
r.loadWorld(world, track);              // build track meshes, scenery, sky, lights for track.mood
r.setMood(mood);                        // 'day' | 'sunset' | 'night' | 'aurora'
const car = r.addCar({ kind: 'player'|'ghost'|'ai'|'remote', color, label });
car.setPose(prevCarView, currCarView, alpha); // interpolate between two sim.car snapshots
                                              // (use r.snapshotCar(sim.car) to copy one)
car.setVisible(bool); r.removeCar(car);
r.setCameraMode('chase'|'close'|'cockpit'|'free'|'orbit'|'top', targetCar);
r.cameraControls                        // free/orbit camera: mouse drag + WASD/QE when mode is free/orbit
r.handleEvents(sim.events, car)         // particles/shake for boost, land, wallhit, checkpoint, finish
r.setViewports([{ x, y, w, h, camera }]) // split-screen (normalised 0..1 rects)
r.render(dtSeconds);                    // call once per animation frame
r.resize(); r.dispose();
r.scene, r.camera, r.three             // escape hatches for editor/TAS overlays (THREE namespace in r.three)
```

## App and screens contract (`js/main.js`, owned by shell)

Every screen is a module exporting `{ id, enter(app, params), exit(app) }`
(both may be async). `enter` builds its DOM inside `app.ui` (the overlay `<div>`).
Screens never touch other screens' DOM.

```js
app.goto(screenId, params)     // 'menu', 'campaign', 'play', 'results', 'editor', 'mytracks',
                               // 'replays', 'tas', 'ai', 'mp', 'settings', 'help'
app.renderer                   // single shared GameRenderer bound to the main canvas
app.audio                      // shared audio engine (see below)
app.storage                    // js/game/storage.js
app.settings                   // live settings object (save via app.saveSettings())
app.controls                   // keyboard/gamepad → Input (js/game/controls.js)
app.ui                         // overlay root element; app.toast(msg); app.confirm(msg) → Promise<bool>
app.levels                     // campaign index from js/levels/index.js
app.loop                       // fixed-timestep driver: app.loop.start(onTick, onFrame), app.loop.stop()
                               // onTick() called at 100 Hz (accumulator, max 25 ticks per frame),
                               // onFrame(alpha, dt) once per animation frame; app.loop.timeScale for slow-mo
```

Screen ids and owners: menu, campaign, play, results, mytracks, replays, settings,
help → shell; editor → editor; tas → tas; ai → ai; mp → mp. The shell registers
every screen in `js/main.js` from these paths:
`js/editor/editor.js`, `js/tas/studio.js`, `js/ai/lab.js`, `js/mp/mp.js` (each
default-exports its screen object).

`play` accepts `{ track, mode: 'campaign'|'custom'|'test'|'replay', replay?, ghosts?, onExit? }`
so the editor can test-drive and the TAS/AI screens can open a run.

## Audio contract (`js/audio/`, owned by audio)

```js
import { AudioEngine } from './audio/audio.js';
const a = new AudioEngine();     // lazily creates AudioContext on first user gesture: a.unlock()
a.setVolume({ master, sfx, music });
a.updateCar(carView, dt);        // engine pitch/volume, ice hiss, wind, drift squeal
a.handleEvents(sim.events);      // checkpoint chime, boost whoosh, land thump, wall hit, finish fanfare, respawn
a.countdown(n);                  // 3,2,1 beeps; a.go()
a.ui('click'|'hover'|'back'|'medal'|'error');
a.music(on);                     // gentle procedural snowy loop for menus
a.stopCar();                     // silence engine (menus/pause)
```

## Storage (`js/game/storage.js`)

All keys are prefixed `penguintrack:`. Values are JSON.

| key | contents |
| --- | --- |
| `settings` | volumes, quality, camera, controls bindings, ghost toggle, units |
| `records` | `{ [trackId]: { bestMs, medal, respawns, replay, date } }` |
| `tracks` | custom tracks `{ [id]: TrackJSON }` |
| `replays` | saved replays (list) |
| `tas` | saved TAS projects `{ [name]: { trackId, script, notes } }` |
| `ai` | saved AI models `{ [name]: { trackId, arch, weights, stats } }` |

The shared site account (`../Empire/shared/accounts.js`, `window.GameAccounts`) is optional:
when a player is signed in, first-time medals add gold to the shared profile
(`spear_mace_user_profile.gold`) — Emperor 60, Gold 30, Silver 15, Bronze 5.

## Controls (Trackmania defaults)

| action | keys | gamepad |
| --- | --- | --- |
| accelerate | ↑ / W | RT / A |
| brake / reverse | ↓ / S | LT / X |
| steer | ← → / A D | left stick (analog) |
| respawn at checkpoint | Enter | B |
| restart run | Backspace / Delete | Y / Back |
| camera 1/2/3 | 1 2 3 (C cycles) | RB |
| toggle ghost | G | — |
| pause / menu | Esc | Start |

## Snow vocabulary

| Trackmania | Penguintrack |
| --- | --- |
| tarmac road | **Packed Snow** (`snow`) — grippy |
| dirt | **Powder** (`powder`) — loose, drifty |
| ice | **Ice** (`ice`) — very low grip |
| grass / ground | **Deep Snow** (ground) — slow and draggy |
| Turbo / Super Turbo | **Frost Boost** / **Avalanche Boost** |
| Engine off | **Frozen Engine** |
| No steering | **Frozen Wheel** |
| No brakes | **Brake Freeze** |
| Slow motion | **Snow Globe** |
| Cruise control | **Glide** |
| Fragile | **Thin Ice** |
| Reset | **Thaw** |
| Author medal | **Emperor** medal |
| Campaign tiers White/Green/Blue/Red/Black | **Fresh Powder / Pine Forest / Glacier / Avalanche / Polar Night** |

## Design tokens (`css/style.css`)

```css
--bg: #0a1830; --bg-2: #10264a; --panel: rgba(12, 30, 60, 0.82); --panel-solid: #12284d;
--line: rgba(200, 230, 255, 0.18); --text: #eef6ff; --muted: #9db8d9; --accent: #7fdcff;
--accent-2: #b8f1ff; --warn: #ffcf5a; --bad: #ff6b81; --good: #6bffb0;
--emperor: #6fd3ff; --gold: #ffd54a; --silver: #d7e3ef; --bronze: #e0a070;
--tier-white: #f4f9ff; --tier-green: #5fd88a; --tier-blue: #5aa8ff; --tier-red: #ff5d6c; --tier-black: #2a2f45;
--radius: 14px; --font: "Baloo 2", "Trebuchet MS", sans-serif; --mono: ui-monospace, "SF Mono", Menlo, monospace;
```
Shared classes: `.pt-screen` (full overlay), `.pt-panel`, `.pt-btn` (+ `.primary`, `.ghost`,
`.danger`, `.small`), `.pt-title`, `.pt-grid`, `.pt-row`, `.pt-field`, `.pt-tag`, `.pt-medal`
(+ `.emperor|.gold|.silver|.bronze|.none`), `.pt-kbd`, `.pt-scroll`, `.pt-hidden`.

## Tooling

- Run locally: `python3 ../Empire/server.py` (the hub repo cloned next to this one), open
  `http://localhost:8080/Penguin-Track/`.
- `node tools/test.mjs` — core unit + determinism tests.
- `node tools/verify-levels.mjs` — every official track validates, builds, and the
  autopilot finishes within its bronze time; reports times.
- `node tools/headless.mjs` — JSON-lines environment server (AI, see `docs/AI.md`).
- `node tools/train.mjs` — neuroevolution trainer without Python.
- `node tools/tas.mjs run <track> <script>` — run a TAS script headless, print result
  (also `bruteforce`, `from-replay`, `autopilot`, `compare`; see `docs/TAS.md`).
- `node tools/bake-levels.mjs` — re-bake medals and Emperor ghosts after a layout or physics change.
