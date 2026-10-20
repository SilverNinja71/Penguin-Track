# Penguintrack official tracks

`js/levels/` holds every official track: the 25-track race campaign, five
platform tracks and five training tracks for the AI lab and TAS studio. Tracks
are authored as path-builder specs (`trackFromPath`, see
[TRACK_FORMAT.md](TRACK_FORMAT.md)); medals and the author ghosts are baked by
`tools/bake-levels.mjs` into `js/levels/baked.js` and checked by
`tools/verify-levels.mjs`.

## Files

| file | contents |
| --- | --- |
| `index.js` | campaign index and the public API (below) |
| `medals.js` | medal rules shared by every screen (below) |
| `fresh-powder.js` … `polar-night.js` | race tiers A–E, five specs each |
| `platform.js`, `training.js` | P01–P05, T01–T05 |
| `build.js` | spec → track JSON: path builder, `fill` areas, scenery |
| `scenery.js` | seeded decor around the road (crowds, banners, trees, lamps…) |
| `baked.js` | **generated**: per track hash, medals, author run (never edit by hand) |

## API (`js/levels/index.js`)

```js
import { CAMPAIGNS, getTrack, allTracks, trackIds, trackInfo, authorReplay,
         nextTrackId, tierOf, isOfficial, DECOR_KINDS } from './levels/index.js';

CAMPAIGNS = [
  { id: 'race', name: 'Campaign', tiers: [
      { id: 'white', name: 'Fresh Powder', color: 'var(--tier-white)', tracks: [summary, …] },
      { id: 'green', name: 'Pine Forest',  color: 'var(--tier-green)', … },
      { id: 'blue',  name: 'Glacier',      color: 'var(--tier-blue)',  … },
      { id: 'red',   name: 'Avalanche',    color: 'var(--tier-red)',   … },
      { id: 'black', name: 'Polar Night',  color: 'var(--tier-black)', … } ] },
  { id: 'platform', name: 'Platform', tiers: [{ id: 'platform', name: 'Ice Steps', … }] },
  { id: 'training', name: 'Training', tiers: [{ id: 'training', name: 'Training Grounds', … }] },
]
summary = { id, name, description, mood, mode, laps, medals, campaign, tier, tierName, color, index }

getTrack(id)      // full track JSON (normalized, medals merged, decor included); a fresh copy per call; null if unknown
allTracks()       // every track JSON in campaign order
trackIds()        // ids in campaign order: A01…E05, P01…P05, T01…T05
trackInfo(id)     // the summary object above
authorReplay(id)  // the Emperor ghost as a replay object (verifyReplay/simulateReplay ready),
                  // or null when the bake is missing or stale (layout changed since the bake)
nextTrackId(id)   // next track in the same campaign, across tiers; null at the end
tierOf(id)        // { campaign, tier }
isOfficial(id)
DECOR_KINDS       // decor model ids the tracks use (below)
```

`getTrack` builds lazily and caches; building all 35 takes a few milliseconds
(no `buildWorld`). The medal helpers are re-exported from `medals.js`.

## Medals (`js/levels/medals.js`)

```js
MEDALS = ['emperor', 'gold', 'silver', 'bronze']        // best first; track.medals.author is the Emperor
medalFor(track, { timeMs, respawns }) -> medal | null    // best medal a finished run earns
medalTargets(track) -> [{ medal, label, value, respawns, ms, kind: 'time'|'respawns'|'both', text }]
formatMedalTarget(target)  or  formatMedalTarget(track, medal) -> '0:42.37' | 'no respawns' | '≤ 3 respawns' | …
isBetterRun(track, a, b)   // records: race = lower time; platform = fewer respawns, then lower time
nextMedalTarget(track, currentMedal) -> the next target to chase, or null
medalRank(m), bestMedal(a, b), MEDAL_LABELS, MEDAL_REWARDS (shared-profile gold 60/30/15/5)
```

**Race tracks** — every medal is a time in ms, the run's respawns do not matter:

| medal | rule |
| --- | --- |
| Emperor (`author`) | the baked author run's time (fastest autopilot drive over the option sweep) |
| Gold | `ceil(author × 1.06 / 100 ms) × 100 ms` |
| Silver | `ceil(author × 1.2 / 1 s) × 1 s` |
| Bronze | `ceil(author × 1.5 / 1 s) × 1 s` |

**Platform tracks** (`mode: 'platform'`, ranked by fewest respawns, then time):

```js
medals = { author: <ms>, gold: 0, silver: 3, bronze: 10 }
```

`author` is a time in ms that must be reached with **0 respawns** (the Emperor).
`gold`, `silver` and `bronze` are the **most respawns allowed** for that medal,
whatever the time: Gold = a clean run, Silver ≤ 3 respawns, Bronze ≤ 10.
`validateTrack` skips its medal-order check on platform tracks for this reason.
`medals.js` also accepts
the track-format object form `{ respawns, ms }` for any medal (custom platform
tracks), so always ask `medalFor` / `medalTargets` instead of reading
`track.medals` directly.

## The campaign

Times are the baked medals (`node tools/verify-levels.mjs` prints the live
table). Every race track has checkpoints roughly every 8–12 s of driving and
scenery (penguin crowds and banners at the start and finish).

| id | name | focus | mood | laps | length | Emperor | Gold | Silver | Bronze | CPs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **Fresh Powder** | | | | | | | | | | |
| A01 | First Flakes | basic road, sweepers | day | 1 | 1404 m | 0:24.41 | 0:25.90 | 0:30.00 | 0:37.00 | 2 |
| A02 | Mitten Curves | every bend size | day | 1 | 1121 m | 0:23.56 | 0:25.00 | 0:29.00 | 0:36.00 | 2 |
| A03 | Sledhill Rise | slopes, crests, bridge | sunset | 1 | 1219 m | 0:26.65 | 0:28.30 | 0:32.00 | 0:40.00 | 2 |
| A04 | Frostbite Express | Frost Boost | day | 1 | 1246 m | 0:20.98 | 0:22.30 | 0:26.00 | 0:32.00 | 2 |
| A05 | Skating Pond | first ice | night | 1 | 1046 m | 0:26.82 | 0:28.50 | 0:33.00 | 0:41.00 | 2 |
| **Pine Forest** | | | | | | | | | | |
| B01 | Pinecone Powder | powder drifts | sunset | 1 | 1455 m | 0:30.62 | 0:32.50 | 0:37.00 | 0:46.00 | 2 |
| B02 | Banked Hollow | banked turns | day | 1 | 1533 m | 0:27.58 | 0:29.30 | 0:34.00 | 0:42.00 | 2 |
| B03 | Kicker Glade | kickers, ski jump | day | 1 | 1426 m | 0:28.42 | 0:30.20 | 0:35.00 | 0:43.00 | 2 |
| B04 | Timber Tunnel | tunnels, bridge | night | 1 | 2115 m | 0:37.69 | 0:40.00 | 0:46.00 | 0:57.00 | 4 |
| B05 | Evergreen Relay | checkpoint flow | sunset | 1 | 1859 m | 0:36.52 | 0:38.80 | 0:44.00 | 0:55.00 | 3 |
| **Glacier** | | | | | | | | | | |
| C01 | Crevasse Run | ice slabs | day | 1 | 1653 m | 0:41.30 | 0:43.80 | 0:50.00 | 1:02.00 | 4 |
| C02 | Looping Floes | loops | aurora | 1 | 2240 m | 0:39.21 | 0:41.60 | 0:48.00 | 0:59.00 | 4 |
| C03 | Snowfield Steps | snowfields, crossings | sunset | 1 | 1670 m | 0:40.59 | 0:43.10 | 0:49.00 | 1:01.00 | 4 |
| C04 | Frozen Wheel Pass | Frozen Wheel | night | 1 | 1908 m | 0:36.06 | 0:38.30 | 0:44.00 | 0:55.00 | 3 |
| C05 | Glide Glacier | Glide, banks | day | 1 | 2296 m | 0:40.51 | 0:43.00 | 0:49.00 | 1:01.00 | 4 |
| **Avalanche** | | | | | | | | | | |
| D01 | Avalanche Chute | Avalanche Boost, ski jump | sunset | 1 | 2269 m | 0:44.62 | 0:47.30 | 0:54.00 | 1:07.00 | 5 |
| D02 | Sleet Switchbacks | powder hairpins, ice descent | day | 1 | 2207 m | 0:48.37 | 0:51.30 | 0:59.00 | 1:13.00 | 6 |
| D03 | Brakeless Descent | Brake Freeze, Thin Ice | night | 1 | 2265 m | 0:43.05 | 0:45.70 | 0:52.00 | 1:05.00 | 4 |
| D04 | Snow Globe Summit | Snow Globe jumps | aurora | 1 | 2053 m | 0:43.29 | 0:45.90 | 0:52.00 | 1:05.00 | 4 |
| D05 | Iceberg Circuit | multilap circuit | sunset | 2 | 2215 m | 0:42.98 | 0:45.60 | 0:52.00 | 1:05.00 | 2 |
| **Polar Night** | | | | | | | | | | |
| E01 | Whiteout Wastes | powder, tunnels, snowfield, loop | night | 1 | 2535 m | 0:50.20 | 0:53.30 | 1:01.00 | 1:16.00 | 6 |
| E02 | Frostfire Ridge | narrow ridge, loop, ski jump | night | 1 | 2916 m | 0:58.01 | 1:01.50 | 1:10.00 | 1:28.00 | 7 |
| E03 | Aurora Ring | figure-eight bridge, multilap | aurora | 2 | 4261 m | 1:14.71 | 1:19.20 | 1:30.00 | 1:53.00 | 4 |
| E04 | Permafrost Gauntlet | every effect | night | 1 | 3060 m | 0:55.13 | 0:58.50 | 1:07.00 | 1:23.00 | 7 |
| E05 | Emperor's Crown | grand finale | aurora | 1 | 3789 m | 1:14.44 | 1:19.00 | 1:30.00 | 1:52.00 | 9 |
| **Ice Steps** | | | | | | | | | | |
| P01 | Penguin Steps | snowfield steps | day | 1 | 923 m | 0:24.41 | ≤ 0 resp. | ≤ 3 resp. | ≤ 10 resp. | 3 |
| P02 | Narrow Ridges | narrow ridges | sunset | 1 | 1585 m | 0:33.25 | ≤ 0 resp. | ≤ 3 resp. | ≤ 10 resp. | 5 |
| P03 | Ice Floe Hop | ice floes, kickers, drops | night | 1 | 1230 m | 0:25.96 | ≤ 0 resp. | ≤ 3 resp. | ≤ 10 resp. | 5 |
| P04 | Glacier Stairs | stairs and drops | aurora | 1 | 868 m | 0:26.88 | ≤ 0 resp. | ≤ 3 resp. | ≤ 10 resp. | 4 |
| P05 | Summit Scramble | all of it | day | 1 | 1968 m | 0:45.86 | ≤ 0 resp. | ≤ 3 resp. | ≤ 10 resp. | 8 |
| **Training Grounds** | | | | | | | | | | |
| T01 | Oval | oval | day | 2 | 1901 m | 0:33.81 | 0:35.90 | 0:41.00 | 0:51.00 | 1 |
| T02 | Figure Eight | crossing figure eight | day | 2 | 2660 m | 0:45.05 | 0:47.80 | 0:55.00 | 1:08.00 | 2 |
| T03 | Slalom | S-bends | day | 1 | 863 m | 0:17.83 | 0:18.90 | 0:22.00 | 0:27.00 | 1 |
| T04 | Ice Rink | ice circuit | night | 2 | 1115 m | 0:44.27 | 0:47.00 | 0:54.00 | 1:07.00 | 1 |
| T05 | Jump Lab | kickers, ski jump | sunset | 1 | 1129 m | 0:23.08 | 0:24.50 | 0:28.00 | 0:35.00 | 2 |

## Authoring a track

A spec is a `trackFromPath` spec plus a few extras:

```js
{
  id: 'C03', name: 'Snowfield Steps', mood: 'sunset',        // mode: 'platform', laps: 3 when needed
  description: 'One line for the campaign screen.',
  start: [14, 0, 4, 0],                                      // turtle x, y, z, heading
  surface: 'ice',                                            // optional default surface
  pieces: ['Start', 'Straight*3', 'Platform*2', 'PlatformRampUp', …, 'Finish', 'Straight*2'],
  fill: [{ b: 'Platform', from: [13, 1, 11], to: [15, 1, 15] }],   // optional: widen snowfields
  decor: [{ d: 'Igloo', x: 9, y: 0, z: 7 }],                 // optional hand-placed decor
  scenery: { kinds: { Pine: 4 }, density: 0.3 } | false,     // optional: override the tier's scenery
}
```

- `fill` places the block on every free cell of a rectangle (the path's own cells
  are skipped), so a path through it gets borderless neighbours. Fills join the
  route graph: a wide field lets the route cut corners, so do not put a fill
  next to a turn you want driven.
- **Scenery** (`scenery.js`): each tier sets models and density (Pine Forest is
  dense pines, Glacier ice crystals, …); night tracks also get lamps along the
  ground-level road; every gate on the ground gets penguin crowds (and a banner
  at the start). It is seeded by the track id, never touches a road cell, and
  decor never changes physics or the track hash.
- **Decor models** (`DECOR_KINDS`): `Pine`, `PineCluster`, `Igloo`, `Snowman`, `PenguinCrowd`,
  `IceCrystal`, `Rock`, `Banner`, `Lamp` (all drawn by js/render/scenery.js). Decor stands at the centre of its cell at
  `Y = 8·y`; scenery always uses `y = 0` (the ground).
- Run-outs: every finish is followed by one or two straights so the car can
  stop; that open end is the expected `openEnd` warning (jump landings add one
  too).

### Design rules (what verify and the autopilot drives check)

- **Natural speed.** A jump must land at whatever speed the approach naturally
  gives. Put ski jumps (`RampBig`) after a bend, never right after a boost, and
  land them on a downslope (`Gap*2..3`, `Up`, `SlopeBigDown`); kickers
  (`RampSmall`, `Gap`) need 4–5 cells of landing at level 0. Elevated landings
  must be long: overshooting an elevated landing is a fall.
- **Crests launch.** A `SlopeDown2` crest lifts off above ~165 km/h, `SlopeBig`
  above ~115, `SlopeDown1`/`PlatformRampDown` above ~80. Leave two straights
  between a down-slope and a bend, never put two down-slopes back to back at
  speed, and never put a crest directly in front of a narrow ridge.
- **Effects last until a Thaw** (`Reset`). Frozen Wheel only on straight road
  that is aligned before the pad; Brake Freeze only before bends you can take
  flat (banks); put the Thaw early enough to brake for the next bend; Glide
  holds the pad speed, so only banks and sweepers follow it; Thin Ice: kickers
  are fine, ski jumps onto flat are not; put a Thaw before them.
- **Ice** brakes at 30 %: brake on snow before an ice section, avoid turning
  platforms (no walls) on ice.
- **Checkpoints** every ~8–12 s. On lap tracks the route takes the nearest
  checkpoint first, so on a figure eight put the first checkpoint straight after
  the crossing (otherwise the shortest "lap" turns at the crossing).
- No blind drops: every drop (`Down`) is visible from the approach and lands on
  a platform at least two cells long before the next turn.

`trackFromPath` errors name the piece (`piece #12 'Turn3L' … overlaps …`).
The dev world viewer shows any official track:
`dev/world-viewer.html?level=C03&view=top` (also `iso`, `render=1`, `pitch`,
`yaw`, `dist`, `focus`).

## Workflow

```sh
node tools/verify-levels.mjs C03          # validate + replay + drive one track (reports a stale bake)
node tools/bake-levels.mjs C03            # re-bake only C03 (others keep their bake)
node tools/bake-levels.mjs                # re-bake everything (~2 min); output is deterministic
node tools/verify-levels.mjs              # the full table; exit code 1 on any problem
node tools/test.mjs levels                # the fast subset (tools/tests/levels.test.mjs)
```

Re-bake whenever a layout changes **or the physics changes**: verify replays
every author ghost and reports `stale bake` when the time no longer matches.

### What the bake does

For each track `bake-levels.mjs` drives the core `Autopilot` (the
`runAutopilot` loop and give-up rules) with a coordinate-descent sweep of its
options from the defaults — `gripMargin`, `brakeMargin`, `crestFactor`,
`lookPerSpeed`, `lineMargin`, `jumpFactor`, `speedSlack` — then tries a few
steering resolutions, and keeps the fastest finish (fewest respawns first;
platform tracks require 0). Steering is rounded to multiples of 2048/65536
(1024–4096 in the sweep) before each tick, which shrinks the ghosts about five
times and barely changes times; the recorded inputs are exactly what the sim
ran, so the replay verifies. The winning options are stored as `pilot`.
`baked.js` is written in campaign order with no dates, so the same tracks and
physics always produce the same file.

### What verify checks

Per track: `validateTrack` has no errors and no warnings beyond the expected
`openEnd`; decor uses known models and
stands off the road; the world builds with a route; the bake exists and its hash
matches the layout; the medals follow the rules above; the author ghost
re-simulates (`verifyReplay`) to exactly the baked time (0 respawns on platform
tracks); no stretch between checkpoints or lap lines is longer than 15 s; the
default autopilot finishes within bronze (platform: within the bronze respawn
cap). Across tracks: ids and names are unique. It prints the table above.
