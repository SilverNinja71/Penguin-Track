# Penguintrack game shell

The shell is everything between the page loading and the other modules: the App
object and screen router (`js/main.js`), the menus, campaign, race, HUD, results,
replays, the player's tracks, settings and help (`js/game/*`), and their styles
(`css/game.css`, on top of the tokens in `css/style.css`). The contract it fulfils
is in [ARCHITECTURE.md](ARCHITECTURE.md#app-and-screens-contract-jsmainjs-owned-by-shell).

## Files

| file | what |
| --- | --- |
| `index.html` | import map (`three`, `three/addons/`), `<canvas id="view">`, `<div id="ui">`, Baloo 2, the optional `../shared/accounts.js`, boot card, `js/main.js` |
| `js/main.js` | `App`: services, routing, lazy screens, global keyboard / gamepad menu navigation; `window.__pt` |
| `js/game/storage.js` | `penguintrack:`-prefixed JSON in localStorage (`get / set / update / remove`) |
| `js/game/settings.js` | defaults, validation, key names, the action list |
| `js/game/controls.js` | keyboard + gamepad + touch → one core Input per tick, edge-detected actions |
| `js/game/loop.js` | fixed 100 Hz driver (`start(onTick, onFrame)`, `stop`, `timeScale`, `resync`) |
| `js/game/catalog.js` | tracks: official (`js/levels`), the player's own, dev samples S01–S06 by id; medal helpers (`js/levels/medals.js`) |
| `js/game/records.js` | personal bests, saved replays, first-time medal gold |
| `js/game/account.js` | the shared site account (`window.GameAccounts`, `spear_mace_user_profile`) |
| `js/game/replaycode.js` | `PTR2.` / `PTR1.` replay share codes |
| `js/game/ghost.js` | `GhostRun`: a replay re-simulated into car views for the renderer |
| `js/game/race.js` | `RaceSession`: countdown, simulation, recording, ghosts, pause, hand-off to results |
| `js/game/replayer.js` | `ReplaySession`: replay viewer with savestate timeline |
| `js/game/hud.js`, `minimap.js` | race HUD and the minimap canvas |
| `js/game/backdrop.js` | attract mode behind the menus (Autopilot driving a campaign track) |
| `js/game/ui.js` | toasts, modal dialogs, spatial focus navigation |
| `js/game/dom.js`, `icons.js` | `h()` element helper, inline SVG icons, the penguin mascot |
| `js/game/stubs.js` | silent renderer / audio stand-ins and the "harden" wrapper |
| screens | `menu.js`, `campaign.js`, `play.js`, `results.js`, `replays.js`, `mytracks.js`, `settings-screen.js`, `help.js`, `unavailable.js` |

## The App (`window.__pt`)

```js
app.goto(id, params)        // switch screens; serialised (a goto during a transition runs after it).
                            // Do not await goto() inside a screen's enter().
app.screen, app.screenId, app.params
app.renderer                // GameRenderer on #view (a NullRenderer when WebGL is missing; r.isNull)
                            // every call is hardened: a throwing method is logged once, not fatal
app.loadWorld(world, track) // renderer.loadWorld (renderer.world tells the attract mode what is shown)
app.audio                   // AudioEngine (NullAudio if js/audio fails); unlocked by autoUnlock(window)
app.storage                 // js/game/storage.js
app.settings                // live settings; app.saveSettings() persists and applies them
app.controls                // js/game/controls.js
app.ui                      // overlay root; cleared on every goto
app.toast(msg, { kind: 'good'|'bad'|'gold', icon, ms })
app.confirm(msg, { title, ok, cancel, danger }) -> Promise<bool>
app.prompt(title, { message, value, placeholder, multiline, ok }) -> Promise<string|null>
app.modal(build(close), opts) -> Promise<value>      // any custom dialog
app.showCode(title, code, { message, copy })
app.levels                  // the js/levels/index.js module
app.catalog                 // getTrack(id), resolve(idOrTrack), info, isOfficial, isCampaign, isReserved,
                            // nextTrackId, authorReplay, campaigns(), customTracks(),
                            // medalFor, medalTargets, medalRank, isBetterRun, medalLabel, medalReward
app.loop                    // start(onTick, onFrame) / stop() / timeScale / maxTicksPerFrame / resync()
app.backdrop                // attract mode: start() / stop() (shell menus only)
app.setMusic(on)            // menu music (the engine remembers the wish until a gesture unlocks audio)
app.account()               // { username, gold } when signed in to the site, else null
app.debug                   // { autopilot, fast, attract, noBackdrop } (see Debug flags)
app.webgl                   // false when the browser has no WebGL
```

### Screens

A screen is `{ id, enter(app, params), exit(app) }` (either may be async). Optional
extras the shell understands:

- `shell: true` — the global keyboard handler drives it: arrows move focus spatially
  (`moveFocus`), Enter presses the focused button, Esc (and Backspace outside play) calls
  `back(app)`, and `onKey(e, app)` gets first look at every key (return `true` to consume
  it). Screens without `shell` (editor, TAS, AI, multiplayer) handle their own keys; the
  shell leaves them alone except for gamepad menu navigation.
- `back(app)` — Esc / gamepad B.

On every `goto` the shell: runs the old screen's `exit`, cancels open dialogs, stops
`app.loop` (resetting `timeScale` and `maxTicksPerFrame`) unless both screens show the
attract backdrop, removes the backdrop car when the new screen is not a menu, sets
`app.controls` inactive, empties `app.ui`, then calls `enter`. A screen that wants the
3D view running starts `app.loop` itself.

The editor, TAS Studio, AI Lab and multiplayer are imported on first use from
`js/editor/editor.js`, `js/tas/studio.js`, `js/ai/lab.js` and `js/mp/mp.js` (default
export = the screen object), together with their stylesheet `css/<id>.css`
(`loadModuleCss(name)` in `js/game/dom.js` adds a `link[data-pt-css=name]` once; the
screens call it too, so they work when entered any other way). If the import fails (offline, or a syntax error),
a "couldn't load" panel (`js/game/unavailable.js`) stands in, and the next visit tries again. If a lazily
loaded screen's `enter` throws, the same panel shows the error.

| id | params |
| --- | --- |
| `menu` | — |
| `campaign` | `{ select?: trackId }` (opens its tab and focuses its card) |
| `play` | `{ track: id | TrackJSON, mode: 'campaign'|'custom'|'test'|'replay', replay?, ghosts?: [replay | { replay, label, color }], onExit?(result|null), onStart?, onRestart?, onFinish?, saveRecords?, retry?, exitLabel? }` |
| `results` | set by the race: `{ track, mode, result, outcome, playParams, stage }` |
| `replays` | — |
| `mytracks` | `{ select?: trackId }` |
| `settings`, `help` | — |
| `editor`, `tas`, `ai`, `mp` | whatever those modules define; the shell sends `editor { track? }`, `tas { track, replay, onExit? }`; `mp { view?: 'hotseat'|'split'|'online' }` ([MULTIPLAYER.md](MULTIPLAYER.md)) |

### play

- `mode` defaults to `campaign` for official tracks and `custom` otherwise. `campaign` and
  `custom` runs save records; `test` (the editor's test drive) and `replay` never do.
- `onExit(result)`: called instead of the default navigation when the player quits from
  the pause menu (`null`) or presses Back on the results screen (`result`, below). The
  callback navigates (e.g. `app.goto('editor', { track })`). Default exits: campaign →
  `campaign`, custom → `mytracks`, test → `editor`, replay → `replays`.
- `result` = `{ finished, timeMs, respawns, splits /* checkpoint times, all laps */,
  lapTimes, replay /* core replay object */, autopilot, pbBefore }`.
- Hooks for screens that run races of their own design (multiplayer hot-seat, see
  [MULTIPLAYER.md](MULTIPLAYER.md)); all optional:
  - `onStart(session)`: once the `RaceSession` runs (`session.screenEl` takes overlays,
    `session.sim`, `session.state`, `session.params`).
  - `onRestart(session) → false`: before every restart after the first (Backspace,
    pause-menu Restart); returning `false` refuses it and the run goes on.
  - `onFinish(result, session)`: on the finish tick, after the record is saved; the
    callback may adjust `result` (e.g. `result.pbBefore`) before the results screen.
  - `saveRecords: false`: `custom` / `campaign` runs save no record and pay no gold.
  - `retry: false`: the results screen has no Retry (and ignores Backspace). It is read
    when the results open, so `onFinish` may set it on the params object.
  - `exitLabel`: text of the pause menu's Quit and the results screen's Back button.
- `ghosts`: extra ghost runs (for example "race this replay"). The personal-best ghost
  (setting `showGhost`) and the Emperor ghost (`showEmperorGhost`, from
  `levels.authorReplay(id)`) are added automatically. A ghost whose `trackHash` differs
  from the world is skipped.

A race: the world is built (`buildWorld`), a `Sim` and a `Recorder` are created, the
3-2-1-GO countdown runs for 150 ticks (car frozen, gate lights via
`renderer.setCountdown`, `audio.countdown(n)` / `audio.go()`), then each
tick reads `app.controls.input()` (or `Autopilot.act` with `?autopilot=1`), steps the
sim and pushes `sim.lastInput` to the recorder. A `fall` event queues a respawn for
the next tick. The record is saved on the finish tick, so an instant Backspace restart
keeps a new personal best, and the next attempt races the new PB ghost. About 1.4 s
after the line (or on Enter) the results screen takes over the still-running scene
(an orbit camera on the coasting car) through `params.stage`.

### Replays

`mode: 'replay'` re-simulates the replay once up front, keeping a savestate every
100 ticks; seeking restores the nearest earlier savestate and simulates forward, so any
point is at most one second of simulation away. Controls: Space / K play-pause,
← → (J / L) ±1 s (Shift ±5 s), `,` `.` single ticks, Home / End, `[` `]` (or `-` `+`)
speed 0.25×–4×, 1–4 / C cameras (chase, orbit, free, cockpit; the free and orbit
cameras use the renderer's mouse / WASD controls), Esc back. The bar also has "Race
ghost" and "TAS Studio" (`app.goto('tas', { track, replay })`).

## Controls

Keyboard (remappable in Settings; stored as `KeyboardEvent.code`, so layouts do not matter):

| action | default keys | gamepad |
| --- | --- | --- |
| accelerate | ↑, W | RT, A |
| brake / reverse | ↓, S | LT, X |
| steer | ←, → / A, D | left stick (analog, dead zone + sensitivity), D-pad |
| respawn at checkpoint | Enter | B |
| restart run | Backspace, Delete | Y, Back |
| camera 1 / 2 / 3 | 1, 2, 3 (chase, close, cockpit) | — |
| cycle camera | C | RB |
| toggle ghosts | G | — |
| pause / menu | Esc, P | Start |

- Keyboard steering is digital (full lock); the stick goes through a dead zone (default
  0.12), a gentle response curve (finer near the centre) and a sensitivity gain (0.5–2).
- Respawn, restart, cameras, ghosts and pause are edge-detected: one press, one action
  (key repeat ignored). Keys typed into inputs are ignored; while racing, bound keys call
  `preventDefault` (no page scrolling, no Backspace navigation); in menus they do not.
- Touch: on coarse-pointer devices (or after a touch, or Settings → On) an on-screen pad
  appears while racing: steer left / right, gas, brake, respawn, camera and pause.
- Menus: arrows / D-pad / stick move focus to the nearest control in that direction,
  Enter / A presses, Esc / B goes back, Q / E (PageUp / PageDown) switch campaign tabs.

## Storage

All keys are prefixed `penguintrack:` (`js/game/storage.js`).

| key | shape |
| --- | --- |
| `settings` | `{ volume: { master, sfx, music }, quality, reducedMotion, camera, showGhost, showTasGhost, showAiGhost, showEmperorGhost, showSplits, showMinimap, units: 'kmh'|'mph', touchControls: 'auto'|'on'|'off', padSensitivity, padDeadzone, bindings: { [action]: [code, code?] } }` |
| `records` | `{ [trackId]: { bestMs, respawns, medal, replay, splits, trackHash, date, awarded } }`: the Pure-run personal best |
| `boards` | `{ [trackId]: { pure: [entry], tas: [entry], ai: [entry] } }`, best first, at most 5 each. `entry: { timeMs, respawns, source: 'race'|'quick'|'studio'|'autopilot'|'lab', label, model?, rewinds?, trackHash, date, replay?, splits? }`; only each board's leader keeps its replay (its ghost) |
| `tasMode` | `'quick'` (default) or `'pro'`: which TAS page the menu opens |
| `replays` | `[{ id, name, trackId, trackName, track? /* custom tracks are embedded */, replay, timeMs, respawns, medal, date }]` (newest first, at most 120) |
| `tracks` | `{ [id]: TrackJSON }` — the key is the track id (the editor writes these; My Tracks imports codes into it with a fresh id when needed, and reads an optional `updated` timestamp) |

- **Three leaderboards per track** (`records.js` `submitBoardRun` / `getBoards`, shown by
  `leaderboard.js` in the campaign detail panel and on the Quick TAS page):
  **Pure Run** (unassisted races; the only runs that set `records`, medals and gold),
  **Best TAS** (Quick TAS runs that used a marker or a rewind, labelled `Quick TAS`, and
  validated Pro Studio runs, labelled `Studio/Bruteforce`) and **Best AI** (AI Lab
  generations driven from the start line, labelled with the algorithm, generation and
  network size, and `?autopilot=1` runs, labelled `Autopilot`). The Pure board also lists
  the `records` personal best, so runs saved before the boards existed still show. A run
  with the same time, respawns and source as a listed one is not listed twice.
- **Ghosts**: `showGhost` (best human), `showTasGhost` and `showAiGhost` switch the three
  board leaders' ghosts on independently (Settings, the pause menu, or the leaderboard's
  ghost button); each has its own colour on the track and the minimap
  (`ghost.js` `CATEGORY_GHOSTS`).
- A record is replaced when the run is better (`isBetterRun`: time; platform: respawns,
  then time). `medal` is the best medal ever earned there and survives layout changes;
  a record whose `trackHash` differs from the current layout is shown as stale (no time,
  no ghost).
- **Gold**: on official campaign tracks, when a signed-in player (site account via
  `window.GameAccounts`) earns a medal for the first time, gold is added to
  `localStorage.spear_mace_user_profile.gold`: Emperor 60, Gold 30, Silver 15, Bronze 5,
  each tier paid once (going straight to the Emperor pays 110). `awarded` remembers what
  was paid. Guests get nothing marked, so a later run while signed in can still claim it.
  Custom tracks and `?autopilot=1` runs never pay (autopilot runs go to the Best AI board).

### Replay codes

`PTR2.` + base64url(deflate-raw(JSON)) when the browser has `CompressionStream`, else
`PTR1.` + base64url(JSON). The JSON is `{ v: 1, replay, name, trackName, track? }` where
`track` is the track's `PT1.` share code for anything that is not an official track.
Imports check the inputs (`countInputs`) and the layout hash before saving.

## Settings, accessibility, layout

- Volumes go to `audio.setVolume`, quality to `renderer.setQuality` (live), reduced motion
  to `renderer.setReducedMotion`, the `pt-reduce-motion` class (no snowfall, no CSS
  animation) and a calm attract camera.
- Every control is a real `<button>` / `<input>` with a visible `:focus-visible` ring.
- Layout works from phone landscape (~740×360) up; at ≤ 900 px wide the campaign detail
  panel hides, at ≤ 640 px tall and ≤ 460 px tall the menu, HUD and results compact.
- No WebGL: a dialog explains it on start; menus, tracks, replay codes and settings still
  work, racing shows a toast instead of a blank screen.

## Debug flags

| flag | effect |
| --- | --- |
| `?autopilot=1` (or `__pt.debug.autopilot = true`) | the core Autopilot drives the player car (records are saved, gold is not) |
| `?fast=N` | races run at N× speed (more ticks per frame) for headless tests |
| `?play=A01&mode=campaign` | start straight in a race |
| `?screen=settings` | start on a screen |
| `?attract=S03` | attract mode on one track; `?noattract=1` turns it off |

`window.__pt` is the App; `__pt.screen.session` is the live `RaceSession` /
`ReplaySession` (`sim`, `recorder`, `ghosts`, `state`, `hud`, `pause()`, `restart()`,
`seek()`, …).

## Testing

- `node tools/test.mjs shell` — settings validation, controls → Input (keyboard, gamepad
  dead zone / sensitivity, edges), the loop's accumulator, records and medal gold,
  replay codes (both forms), ghost determinism, the catalog.
- In a browser (or headless Chrome): serve the repo root, open `/penguintrack/`.
  Checked end to end: menu → campaign → A01 with ArrowUp held (timer and speed rise),
  pause / resume, restart, `?autopilot=1&fast=3&play=A01` → results with a medal →
  Retry with the PB ghost, replays → watch / seek / speed / orbit, export / import codes,
  My Tracks import → custom race → results → back, test mode `onExit`, settings and key
  remaps persisting across reloads, platform (respawn counter) and lap HUDs, effect chips
  (S04), signed-in account chip, no-WebGL fallback, 1280×720, 1024×600 and 844×390 touch.
