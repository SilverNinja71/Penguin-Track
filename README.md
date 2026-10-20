# Penguintrack

A snowy, Trackmania-style time attack racer for the browser. You drive a penguin in a little
snow racer through icy 3D tracks with loops, ski jumps, banked turns and boost pads, and you
chase your own ghost down to the hundredth. Everything runs as plain ES modules: no build step
and no npm packages. The only third-party code is the vendored Three.js in `vendor/`.

The physics is deterministic, so the same inputs always give the same run. That one fact powers
the replays, the ghosts, the TAS tools and the AI training kit.

## Play it

Serve the repo root (the folder above this one) and open `/penguintrack/`:

```sh
./start.sh                     # or: python3 server.py, or: python3 -m http.server 8080
# then open http://localhost:8080/penguintrack/
```

Any static file server works. It needs a recent Chrome, Edge, Firefox or Safari with WebGL.
Without WebGL the menus still open, but you can't race.

## Controls

| action | keyboard | gamepad |
| --- | --- | --- |
| accelerate | ↑ / W | RT / A |
| brake, reverse | ↓ / S | LT / X |
| steer | ← → / A D | left stick |
| respawn at the last checkpoint | Enter | B |
| restart the run | Backspace / Delete | Y / Back |
| cameras | 1 2 3 (C cycles) | RB |
| show or hide ghosts | G | |
| pause | Esc / P | Start |

You can remap every key in Settings. On phones and tablets, touch buttons appear while you race.
To drift on snow or powder, tap the brake while steering hard above 70 km/h.

## What's in it

- **Campaign: 35 official tracks.**
  - Race: 25 tracks in five tiers (Fresh Powder, Pine Forest, Glacier, Avalanche, Polar Night).
  - Platform: 5 tracks where the fewest respawns win.
  - Training: 5 tracks.
  - Each track has Bronze, Silver, Gold and Emperor medals. The Emperor time is the author's
    run.
- **Surfaces and pads.** Packed Snow grips, Powder drifts, Ice slides, and Deep Snow slows you.
  Special pads: Frost and Avalanche boosts, Frozen Engine, Frozen Wheel, Brake Freeze, Snow
  Globe, Glide, Thin Ice and Thaw.
- **Ghosts and splits.** Your personal best races beside you, with split times at every
  checkpoint. You can also turn on the Emperor's ghost, or race any saved replay.
- **Replays.** Every personal best is kept. You can save more runs, scrub through them at 0.25×
  to 4× with four cameras, and share them as `PTR` codes. Custom tracks travel inside the code.
- **My Tracks.** Import a friend's `PT1.` share code and race it.
- **Gold.** With a site account signed in, a medal you earn for the first time adds gold to the
  shared profile: Emperor 60, Gold 30, Silver 15, Bronze 5.
- **Polish.**
  - Procedural snow sounds and menu music, with no audio files.
  - Four skies: day, sunset, night and aurora.
  - An attract mode drives the tracks behind the menus.
  - Gamepad and touch support, and a reduced-motion option.

The Track Editor, TAS Studio, AI Lab and Multiplayer menu entries are still being built. For
now they show a placeholder. The TAS and AI engines underneath them already work from the
command line (see below).

## TAS quick start

Scripts are plain text, for example `0.00-5.08 press up`. A script runs headless and
re-simulates exactly, and bruteforce can search it for a faster run. See [docs/TAS.md](docs/TAS.md).

```sh
node tools/tas.mjs run tas-examples/S01-bruteforced.txt            # 0:21.07, verified
node tools/tas.mjs autopilot A01 --out a01.txt                      # a starting script
node tools/tas.mjs bruteforce A01 a01.txt --iterations 2000 --out a01-fast.txt
node tools/tas.mjs to-replay a01-fast.txt --code                    # paste into Replays > Import code
```

## AI quick start

The AI kit has a gym-style environment, a neuroevolution trainer with no dependencies, and a
Python gymnasium wrapper. See [docs/AI.md](docs/AI.md) and [python/README.md](python/README.md).

```sh
node tools/train.mjs --track S01 --gens 60                          # writes models/S01-ga.json
node tools/train.mjs --eval models/demo-S01.json                    # the demo driver: 0:19.70
cd python && python3 random_agent.py --track A01                    # Python bridge smoke test
```

To watch a trained driver in the game, go to Replays > Import code > Choose file. Pick the model
`.json`, which carries its best run, or any replay JSON. Then press Watch or Race ghost.

If `node` is not on your `PATH`, set `PENGUINTRACK_NODE=/path/to/node` for the Python side.

## For developers

```sh
node tools/test.mjs              # all unit, determinism and integration tests
node tools/verify-levels.mjs     # every official track builds, validates and its Emperor ghost re-simulates
node tools/bake-levels.mjs       # re-bake medals and Emperor ghosts after a layout or physics change
```

You can add debug flags to the game URL:

- `?play=A01` starts straight in a race.
- `?autopilot=1` lets the built-in driver race for you.
- `?fast=4` runs four times faster.
- `?screen=settings` opens a screen directly.

Dev pages live in `dev/`: `world-viewer.html`, `render-demo.html` and `audio-demo.html`.

The docs:

| doc | covers |
| --- | --- |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | module ownership, contracts, units, controls and design tokens |
| [CORE_API.md](docs/CORE_API.md) | the deterministic simulation |
| [TRACK_FORMAT.md](docs/TRACK_FORMAT.md) | track JSON and share codes |
| [GAME.md](docs/GAME.md) | the shell |
| [RENDER.md](docs/RENDER.md) | the renderer |
| [AUDIO.md](docs/AUDIO.md) | audio |
| [LEVELS.md](docs/LEVELS.md) | the campaign |
| [TAS.md](docs/TAS.md) | TAS tools |
| [AI.md](docs/AI.md) | AI kit |
