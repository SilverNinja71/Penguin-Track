# Penguintrack

A snowy, Trackmania-style time attack racer for the browser. You drive a penguin in a little
snow racer through icy 3D tracks with loops, ski jumps, banked turns and boost pads, and you
chase your own ghost down to the hundredth. Everything runs as plain ES modules: no build step
and no npm packages. The only third-party code is the vendored Three.js in `vendor/`, plus
PeerJS, which online rooms fetch from unpkg only when you open one.

The physics is deterministic, so the same inputs always give the same run. That one fact powers
the replays, the ghosts, the TAS tools and the AI training kit.

## Play it

Play online at https://silverninja71.github.io/Penguin-Track/.

To run it locally, serve the folder that holds this repo, so the game sits at `/Penguin-Track/`.
The game runs on its own (as a guest). Clone the hub repo [`Empire`](https://github.com/SilverNinja71/Empire) next to it if you also want the shared site account (`../Empire/shared/accounts.js`, loaded on demand) and the "All games" link:

```sh
python3 ../Empire/server.py   # or, from the folder above this repo: python3 -m http.server 8080
# then open http://localhost:8080/Penguin-Track/
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
To drift on snow or powder, tap the brake while steering hard above 40 km/h; a drift held at a
moderate angle above 110 km/h keeps its speed (a speed drift). Hold the brake in the air to
level the car for a clean landing.

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
- **Track editor.** Snap blocks together on a 48×48 snowfield with the mouse or only the
  keyboard: roads, bends, slopes, loops, jumps, pads and gates, three surfaces, decor, four
  skies. Live checks flag open road ends and missing gates. Test-drive it (or let the
  autopilot) to validate it and set its medals, then save it to My Tracks and share it as a
  `PT1.` code. See [docs/EDITOR.md](docs/EDITOR.md).
- **My Tracks.** Your tracks and imported share codes: race, edit, share or delete them.
- **TAS: Quick TAS or Pro Studio.** Quick TAS (Race & Rewind) is a normal race with
  savestates: `C` drops a marker, `R` or `Backspace` rewinds to it, `[` `]` step through
  your markers, and **Open in Pro Studio** carries the run into the frame-by-frame editor.
  Every track has three leaderboards, Pure Run, Best TAS and Best AI, and you can race any
  mix of their ghosts at once.
- **Pro TAS Studio.** Open any replay (or start from the autopilot) and edit it tick by tick:
  a piano roll for steering and pedals, a script editor, savestates, frame stepping, a
  comparison ghost, record mode at slow motion and a bruteforce search in a worker.
  Validate re-simulates the run from scratch; save it as a replay to watch or share.
  See [docs/TAS.md](docs/TAS.md).
- **AI Lab.** Train a flock of penguin drivers with neuroevolution in Web Workers and watch
  every generation drive, with their sensor rays and the network's choices. Save a driver,
  race against it, watch its run or open it in the TAS Studio. A demo driver is included.
  See [docs/AI.md](docs/AI.md).
- **Multiplayer.** Hot-seat matches for 2–8 players with a playlist and points, two-player
  split-screen (keyboard and gamepads), and online ghost rooms with friends over PeerJS
  (the host re-simulates every finish before it counts). See
  [docs/MULTIPLAYER.md](docs/MULTIPLAYER.md).
- **Gold.** With a site account signed in, a medal you earn for the first time adds gold to the
  shared profile: Emperor 60, Gold 30, Silver 15, Bronze 5.
- **Polish.**
  - Procedural snow sounds and menu music, with no audio files.
  - Four skies: day, sunset, night and aurora.
  - An attract mode drives the tracks behind the menus.
  - Gamepad and touch support, and a reduced-motion option.

## TAS quick start

Scripts are plain text, for example `0.00-5.08 press up`. A script runs headless and
re-simulates exactly, and bruteforce can search it for a faster run. See [docs/TAS.md](docs/TAS.md).

```sh
node tools/tas.mjs run tas-examples/S01-bruteforced.txt            # 0:21.07, verified
node tools/tas.mjs autopilot A01 --out a01.txt                      # a starting script
node tools/tas.mjs bruteforce A01 a01.txt --iterations 2000 --out a01-fast.txt
node tools/tas.mjs to-replay a01-fast.txt --code                    # paste into Replays > Import code
```

In the game, press TAS Studio on any replay (Replays, or the replay viewer) to edit it there.

## AI quick start

The AI kit has a gym-style environment, a neuroevolution trainer with no dependencies, and a
Python gymnasium wrapper. See [docs/AI.md](docs/AI.md) and [python/README.md](python/README.md).

```sh
node tools/train.mjs --track S01 --gens 60                          # writes models/S01-ga.json
node tools/train.mjs --eval models/demo-S01.json                    # the demo driver: 0:19.70
cd python && python3 random_agent.py --track A01                    # Python bridge smoke test
```

In the game, the AI Lab trains drivers in the browser. To bring in a driver trained here, open
AI Lab > Drivers > Import and pick the model `.json` (or a `.state.json` to keep training).
Replays > Import code also takes a model file or any replay JSON, to watch or race its run.

If `node` is not on your `PATH`, set `PENGUINTRACK_NODE=/path/to/node` for the Python side.

## Pro features

Quick TAS and the AI Lab's presets are free. Two optional one-time unlocks ($3 each, or $5 for both):

- **Pro TAS**: the frame-by-frame TAS Studio, its bruteforce optimiser, savestate slots and opening any replay in the Studio.
- **Pro AI**: unlimited generations (free: 5), up to 16 training workers (free: 1), custom sensor rays and hidden layers, mutation settings, and driver weight import / export.

Payments use Firebase (accounts, free plan), Stripe Checkout and a small Cloudflare Worker (`worker/`, free plan) that talks to Stripe. Until `js/services/config.js` holds a real Firebase project, nothing is locked. Setting it up: [docs/PAYMENTS_SETUP.md](docs/PAYMENTS_SETUP.md). On a local dev server, add `?pro=dev` to the address to unlock everything, `?pro=locked` to try the paywall, `?pro=off` to go back to normal.

## Support the game

Penguintrack is free. If you enjoy it, you can support it on [GitHub Sponsors](https://github.com/sponsors/SilverNinja71).

To switch on the menu's **Support** button (for the repo owner):

1. Go to https://github.com/sponsors, choose to get sponsored as yourself, fill in the profile, and add the bank and tax details GitHub asks for (payouts go to a bank account, so GitHub may need an adult as the account holder; its form says what's required). GitHub reviews the profile before it goes live.
2. Once https://github.com/sponsors/SilverNinja71 shows your Sponsors page, set `SUPPORT_URL` in `js/services/config.js` to that address, then commit and push.

`.github/FUNDING.yml` also puts a **Sponsor** button on this repo's GitHub page once the profile is live.

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
- `?screen=settings` opens a screen directly (`editor`, `tas`, `ai`, `mp`, `mytracks`, …).
- `?noattract=1` turns off the attract-mode drive behind the menus.
- `?screen=mp&mp=local` opens an online room without the network, with an autopilot bot.

`window.__pt` is the app object (see [docs/GAME.md](docs/GAME.md)).

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
| [EDITOR.md](docs/EDITOR.md) | the track editor |
| [TAS.md](docs/TAS.md) | TAS engine, CLI and TAS Studio |
| [AI.md](docs/AI.md) | AI kit, trainers and AI Lab |
| [MULTIPLAYER.md](docs/MULTIPLAYER.md) | hot-seat, split-screen and online rooms |
