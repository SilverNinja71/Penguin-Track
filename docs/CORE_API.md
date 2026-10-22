# Penguintrack core API

Reference for `js/core/`. Sections 1–8 cover units, blocks, tracks, the world,
collision, the route, share codes and deterministic math; sections 9–14 cover the
simulation: the race rules (`sim.js`), the car (`car.js`), input, replays and the
autopilot.

Everything in `js/core/` is pure: no DOM, no `three`, no `Math.random`, no clocks.
It runs unchanged in the browser, a Web Worker and Node >= 18.

```js
import { TICK, CELL, LAYER, DIRS, SURFACE_IDS, GROUND_Y, FALL_Y } from './core/constants.js';
import { BLOCKS, BLOCK_LIST, SURFACES, MATERIALS, getBlockGeometry } from './core/blocks.js';
import { buildWorld, validateTrack, trackFromPath, normalizeTrack,
         placedConnectors, blockPreview, capNeeded } from './core/track.js';
import { CollisionMesh, segmentAABB } from './core/collision.js';
import { Route, RouteTracker } from './core/route.js';
import { encodeTrack, decodeTrack, trackHash } from './core/codec.js';
import { getSamples, getSample } from './core/samples.js';        // dev fixtures
import { Sim, hashState } from './core/sim.js';
import { CAR, GRAVITY, SURFACE_PARAMS } from './core/car.js';
import { makeInput, clampSteer, NEUTRAL, ACTIONS, actionToInput } from './core/input.js';
import { Recorder, encodeInputs, decodeInputs, simulateReplay, verifyReplay,
         ghostPoseAt, snapshotCar, lerpCarSnapshot } from './core/replay.js';
import { Autopilot, runAutopilot } from './core/autopilot.js';
import { formatTime } from './core/format.js';
import * as M from './core/mathd.js';                              // dsin, dcos, vec3, quat ...
import { Rng } from './core/rng.js';
```

**Workers.** A World holds class instances and functions, so it cannot be posted to a
Worker (`postMessage` / `structuredClone` throws). Post the track JSON (or its share code)
and call `buildWorld` inside the worker: a cold build there takes ~50–250 ms (first use of
each block type), warm builds ~5–25 ms. Sim states, replays and inputs are plain JSON and
travel freely.

## 1. Conventions

### Units and axes

Metres, seconds, radians. **Y is up**, right-handed (Three.js). A cell is 32 × 8 × 32 m
(`CELL = 32`, `LAYER = 8`); cell `(x, y, z)` spans `[32x, 32x+32) × [8y, 8y+8) × [32z, 32z+32)`.
The map is 48 × 32 × 48 cells (`MAP_X`, `MAP_Y`, `MAP_Z`). A deck at level `y` has its top
surface at `Y = 8y`.

### Directions

```js
DIRS = [[0, 0, 1], [-1, 0, 0], [0, 0, -1], [1, 0, 0]]   // 0 = +Z, 1 = -X, 2 = -Z, 3 = +X
```

Headings run clockwise seen from above: turning **right** is `d -> (d + 1) % 4`, left is
`d -> (d + 3) % 4`. Facing +Z with +Y up, the right-hand side is -X, i.e.
`right = forward × up`. Everywhere in core, "right" means `tangent × up` and signed
lateral quantities are **positive to the right**.

Car-local axes (used by `spawn.quat` and `mathd` helpers): forward +Z, up +Y, right -X.
`DIR_QUATS[d]` rotates local +Z onto `DIRS[d]`; it equals a yaw of `-d·π/2`.

### Block rotation, local frame and anchor

A block definition is authored in its **local frame**: metres, origin at the min corner of
its unrotated footprint, `X ∈ [0, 32·sx]`, `Y ∈ [0, 8·sy]`, `Z ∈ [0, 32·sz]`, local
forward = +Z. Decks at the block's base sit at local `Y = 0`; deck slabs may hang down to
`Y = -DECK_THICKNESS` (into the cell below, like Trackmania).

A placed block `{ b, x, y, z, r }` turns right `r` times (`r ∈ 0..3`):

- local direction `d` becomes world direction `(d + r) % 4`; local +Z points along `DIRS[r]`;
- the **anchor** `(x, y, z)` is the **min corner of the rotated footprint**: the block
  occupies cells `[x, x+W) × [y, y+sy) × [z, z+D)` with `[W, D] = r odd ? [sz, sx] : [sx, sz]`
  (`footprintSize(def, r)`);
- local metres map to world metres as (with `SX = 32·sx`, `SZ = 32·sz`)

  | r | world x | world z |
  | --- | --- | --- |
  | 0 | `lx` | `lz` |
  | 1 | `SZ - lz` | `lx` |
  | 2 | `SX - lx` | `SZ - lz` |
  | 3 | `lz` | `SX - lx` |

  then `+ (32x, 8y, 32z)`. Local cell `[i, j, k]` lands on `anchor + rotateCell(def, r, [i, j, k])`.

`makeTransform(def, x, y, z, r)` returns `{ r, point(p, out?), vector(v, out?), dir(d) }`
implementing exactly this.

### Connectors

```js
{ cell: [i, j, k], dir, kind: 'road' | 'lip', profile: 'road' | 'tunnel' | 'platform' | null,
  pos?, tangent? }   // pos/tangent only on lips (local metres / unit vector)
```

A connector is an opening on the face of local cell `[i, j, k]` that faces outward local
direction `dir`. The deck top at the opening is at local `Y = 8j`, centred on the face.
Two connectors join when they sit on the same face from opposite sides (any profiles);
`kind: 'road'` connectors are bidirectional (a car may enter through any of them).
`kind: 'lip'` marks the open front of a ramp: exit only, never joined, the route jumps
from it (see §5).

Every `road`/`tunnel` connector carries the **standard cross-section**, so any two blocks
meet with identical geometry (verified for all 4225 connector pairs to < 1e-7 m):

| part | lateral `u` (m, + = right) | height `v` above the deck |
| --- | --- | --- |
| deck (block surface) | `-12 .. 12` (`ROAD_WIDTH = 24`) | `0` |
| snowbank inner face | `12 -> 12.3` | `0 -> 1.2` (leans outward) |
| snowbank top | `12.3 .. 14` | `1.2` (`BORDER_HEIGHT`) |
| outer face / deck side | `14` | `1.2 -> -1.5` |
| underside | `-14 .. 14` | `-1.5` (`DECK_THICKNESS`) |

A `platform` connector is a flat deck spanning the whole face (`u = -16 .. 16`) with no
snowbanks. Faces are never capped where blocks join; caps appear only where needed:

| what | drawn when the neighbour is |
| --- | --- |
| deck slab end (down to 1.5 m below the deck) | nothing (open end) |
| the rest of a solid end (the top of a slope, below the slab) | always |
| snowbank end | nothing, or a platform |
| tunnel roof ring | anything but another tunnel |
| platform side (middle 28 m) | nothing |

So there are no internal faces at seams, the deck surface is continuous across them, and
no block is ever open into its hollow body. `capNeeded(part, neighbourProfile)` (track.js)
is the rule buildWorld and `blockPreview` use.

## 2. Blocks (`blocks.js`)

```js
BLOCKS        // { [id]: def }
BLOCK_LIST    // defs in catalog order
SURFACES      // { snow, powder, ice, ground, wall } -> { id, index, name, drivable, color }
MATERIALS     // render material ids (see §3, render)
getBlockGeometry(id, surface)   // cached block-local geometry (below)
footprintSize(def, r) -> [W, H, D]
rotateCell(def, r, [i, j, k]) -> [dx, dy, dz]   // offset from the anchor
makeTransform(def, x, y, z, r)
blockSurfaces(id) -> string[]
clearGeometryCache()            // tests only
```

A definition:

```js
{
  id, name, category: 'road'|'turn'|'slope'|'special'|'gate'|'stunt'|'platform', description,
  size: [sx, sy, sz],          // cells, local
  surfaces: ['snow', 'powder', 'ice'], defaultSurface: 'snow',
  connectors: [...],           // §1
  gate: 'start'|'finish'|'checkpoint'|'startfinish'|null,
  effect: 'turbo'|...|null,    // special pads
  spawn: { pos: [x, y, z], dir } | null,   // local; Start and StartFinish
  hanging: bool,               // deck is a thin shell (the loops); others are solid to their base
  build(surface) -> { mb, paths, triggers, props }   // use getBlockGeometry instead
}
```

`getBlockGeometry(id, surface)` returns (block-local, generated once, cached; the mesh
field names are short here; `blockPreview` (§3) gives world-space meshes shaped like
`world.render.meshes`):

```js
{
  groups: Map(key -> { col: Float64Array /* 9 per tri */, surf: Uint8Array,
                       meshes: [{ material, pos, nrm: Float32Array, uv: Float32Array, idx: Uint32Array }] }),
          // 'main' always; 'cap:<connector>:<deck|border|roof|side>' chosen with capNeeded()
  paths: [{ a, b, pts: Float64Array, ups: Float64Array, hw: Float64Array, events, spawnAt }],
          // centerline between connectors a -> b (a = -1: from the spawn), usable both ways;
          // ups = deck normal, hw = drivable half-width; events: [{ trigger, at }] (local trigger, metres)
  triggers: [{ type, effect?, min, max }],   // local AABBs
  props: [{ kind: 'gate'|'pad', ... }],      // local
}
```

Road-like blocks are **sweeps** of the standard cross-section along a parametric centerline
with a moving frame (tangent, up, right) and optional banking, sampled every ~1.6 m on
curves (8 m on straights). The deck is split in 4 panels across (8 on the twisted banks
and loops, so their triangles crease less: at most ~7° on Bank2, 4° on Bank3, 10–14° in the
loops). Solid blocks (slopes, ramps, banks, bump) drop vertical side walls to their base
(`-1.5 m`); the loops are a hanging 1.5 m shell.

### Catalog

Connectors: `index:[cell]→dir` (local). "lip" = open ramp front.

| id | name | category | size | connectors | notes |
| --- | --- | --- | --- | --- | --- |
| `Start` | Start Igloo | gate | 1×1×1 | 0:[0,0,0]→0 | spawn (16, 0, 12) heading local +Z; back is walled |
| `Finish` | Finish Arch | gate | 1×1×1 | 0:[0,0,0]→2, 1:[0,0,0]→0 | line at local z = 16 |
| `Checkpoint` | Snowflake Checkpoint | gate | 1×1×1 | 0:[0,0,0]→2, 1:[0,0,0]→0 | line at z = 16 |
| `StartFinish` | Lap Igloo | gate | 1×1×1 | 0:[0,0,0]→2, 1:[0,0,0]→0 | line at z = 8, spawn at z = 14 (past the line) |
| `Straight` | Packed Trail | road | 1×1×1 | 0:[0,0,0]→2, 1:[0,0,0]→0 | |
| `Cross` | Snow Crossing | road | 1×1×1 | connector *d* faces *d* (0..3) | 2 m snowbank stubs at each face, open corners; turning paths report half-width 11.4 (the stubs) |
| `Narrow` | Narrow Ridge | road | 1×1×2 | 0:[0,0,0]→2, 1:[0,0,1]→0 | 10 m deck, no banks; 12 m tapers at both ends |
| `Tunnel` | Ice Tunnel | road | 1×1×1 | 0→2, 1→0 (profile `tunnel`) | ice roof, inner peak 5.8 m, outer 6.4 m |
| `Turn1` | Igloo Hairpin | turn | 1×1×1 | 0:[0,0,0]→2, 1:[0,0,0]→3 | radius 16 |
| `Turn2` | Drift Bend | turn | 2×1×2 | 0:[0,0,0]→2, 1:[1,0,1]→3 | radius 48 |
| `Turn3` | Glacier Sweep | turn | 3×1×3 | 0:[0,0,0]→2, 1:[2,0,2]→3 | radius 80 |
| `Bank2` | Banked Drift | turn | 2×3×2 | as Turn2 | bank 0 → 40° → 0, inner edge stays level, outside rises 15.4 m (see below) |
| `Bank3` | Banked Glacier | turn | 3×3×3 | as Turn3 | same banking |
| `SlopeUp1` | Steep Snowslope | slope | 1×2×1 | 0:[0,0,0]→2, 1:[0,1,0]→0 | +8 m over 32 m, cosine profile, flat ends |
| `SlopeUp2` | Gentle Snowslope | slope | 1×2×2 | 0:[0,0,0]→2, 1:[0,1,1]→0 | +8 m over 64 m |
| `SlopeBig` | Mountain Slope | slope | 1×3×2 | 0:[0,0,0]→2, 1:[0,2,1]→0 | +16 m over 64 m |
| `RampSmall` | Snow Kicker | stunt | 1×1×1 | 0:[0,0,0]→2, 1: lip | circular kicker to a 15° lip, 4.2 m tall |
| `RampBig` | Ski Jump | stunt | 1×2×1 | 0:[0,0,0]→2, 1: lip | 28° lip, 8.0 m tall |
| `Loop` | Blizzard Loop | stunt | 2×4×2 | 0:[1,0,0]→2, 1:[0,0,1]→0 | radius 14 vertical loop, lands one cell to the **right** (both ways); see below |
| `LoopL` | Blizzard Loop (left) | stunt | 2×4×2 | 0:[0,0,0]→2, 1:[1,0,1]→0 | mirror: lands one cell to the left |
| `Bump` | Mogul | stunt | 1×1×1 | 0:[0,0,0]→2, 1:[0,0,0]→0 | 1.5 m cosine hump |
| `Platform` | Snowfield | platform | 1×1×1 | connector *d* faces *d* (profile `platform`) | 32 × 32 m flat, no banks |
| `PlatformRamp` | Snowfield Ramp | platform | 1×2×1 | 0→2, 1:[0,1,0]→0 (profile `platform`) | borderless SlopeUp1 |
| `Turbo` … `Reset` | see below | special | 1×1×1 | as Straight | 24 × 20 m pad (local z 6..26) |

The loop's sideways shift runs over `t ∈ [0.08, 0.92]` of the circle along a septic
smoothstep (zero slope, curvature and jerk at both ends), and the deck normal is the
centerline's principal normal, so the deck tilts up to ~13° sideways mid-climb and the
twist fades in and out instead of starting at full rate. That makes the centerline a
geodesic of the deck: a car holding the wheel straight follows the shift without steering
(it drifts ~1–3 m off-centre by the exit, so a light correction gives a clean exit). The
loop has 32 m of flat road inside the block before the circle and after it.

Banks pivot about their inner deck edge, so the outer half of the deck rises with the roll
and comes back down: its height crests mid-turn. The roll follows a cosine bump plus two
harmonics (`bankProfile`) that move curvature from that crest (−39 %) to the ends, where
the deck compresses; with the car's downforce every line from the inner edge to the outer
one stays loaded up to plateau speed (tested at 285 km/h). Bank frames are sampled more
finely near the ends, where the roll changes fastest, so the first chord's kink against
the flat neighbour stays under ~3°. Holding a line at speed is still a matter of grip:
the centerline holds at ~220 km/h; flat out you need the racing line (wide, low inside).

Specials (straight road with a pad; trigger `{ type: 'effect', effect }`): `Turbo` Frost
Boost (`turbo`), `Turbo2` Avalanche Boost (`turbo2`), `NoEngine` Frozen Engine (`noEngine`),
`NoSteer` Frozen Wheel (`noSteer`), `NoBrake` Brake Freeze (`noBrake`), `SlowMo` Snow Globe
(`slowmo`), `Cruise` Glide (`cruise`), `Fragile` Thin Ice (`fragile`), `Reset` Thaw (`reset`).

Turns are one block per size: entering connector 0 turns **left**, entering connector 1
turns **right**. Slopes go down when entered from connector 1. The path builder hides
this (`Turn2L`, `Turn2R`, `SlopeDown1`, …).

## 3. Tracks and the world (`track.js`)

The track JSON format is specified in [TRACK_FORMAT.md](TRACK_FORMAT.md).

```js
normalizeTrack(track) -> track          // new object, every field present, defaults filled
normalizeLaps(laps) -> int              // the lap rule (positive integer, else 1) shared with codes and hashes
validateTrack(track) -> { ok, errors: string[], warnings: string[], issues: Issue[] }
analyzeTrack(track) -> { track, placements, connectors, occupancy, cellKey, issues, errors, warnings }  // layout only; raw tracks are normalized first
trackFromPath(spec) -> track            // turtle builder, TRACK_FORMAT.md §Path builder
placeByConnector(blockId, entry, exit, cell, dir, surface) -> { block, next, dir }
placedConnectors(def | id, x, y, z, r) -> [{ local, kind, profile, cell, dir, pos, out }]
blockPreview(id, x, y, z, r, s?, neighbourProfiles?) -> meshes   // like world.render.meshes, one block
capNeeded(part, neighbourProfile | null) -> bool                 // which end caps a connector draws
cellKey(x, y, z)                        // key of analyzeTrack's occupancy map
PIECE_NAMES                             // block pieces trackFromPath understands
buildWorld(track, { route = true }) -> World
```

`validateTrack` errors: malformed input, coordinates or rotations that are not integers,
a bad lap count, unknown block id, surface not allowed, footprint outside the map,
overlapping footprints, no / several spawn blocks (Start or StartFinish), no Finish or
StartFinish, `laps > 1` without StartFinish, no route through every checkpoint to a finish
(on lap tracks: back to the StartFinish line, one closed lap). Warnings: each open road end,
StartFinish with 1 lap, Finish arches on a lap track, medal order, decor outside the map.

Each **issue** is data the editor can act on:

```js
{ level: 'error' | 'warning', code, message, blocks: [blockIndex…],
  cell?: [x, y, z], dir?, connector?, checkpointIds?: [id…], decor? }
```

| code | level | extra fields |
| --- | --- | --- |
| `malformed`, `badCoordinate`, `badLaps` | error | `blocks` (bad ones) |
| `unknownBlock`, `surface`, `outside` | error | `blocks`, `cell` (outside) |
| `overlap` | error | `blocks: [new, existing]`, `cell` |
| `noSpawn`, `multiSpawn`, `noFinish`, `lapsNoStartFinish` | error | `blocks` (multiSpawn) |
| `unreachableCheckpoint` | error | `checkpointIds` (0-based, = trigger ids), `blocks` |
| `unreachableFinish`, `lapNotClosed`, `routeSearch` | error | |
| `openEnd` | warning | `blocks`, `cell`, `dir`, `connector` (local index) |
| `startFinishOneLap`, `finishOnLapTrack`, `medalOrder` (race tracks only), `decorOutside` | warning | `blocks` / `decor` |

`placeByConnector`'s `cell` is the turtle cell: the cell just past an open face, i.e. for
snapping onto connector `c` of a placed block, `c.cell + DIRS[c.dir]` with `dir = c.dir`;
`entry` is the local connector the car enters through (`null` places a spawn block).

### World

`buildWorld` is deterministic (bit-identical on every run and engine we test) and caches
block geometry per `(id, surface)`; a 150-block track builds in ~20 ms warm, ~40–90 ms cold.
It throws only for unknown block ids; other problems land in `errors` / `issues` and
`route` is `null` (with `routeError`), so the editor can still preview broken tracks.

```js
World = {
  track,                 // normalized
  hash,                  // trackHash(track)
  laps, mode,
  collision,             // CollisionMesh (§4), includes pillars and the ground
  triggers: [{
    index, type: 'start'|'checkpoint'|'finish'|'startfinish'|'effect',
    id,                  // per type, in block order: checkpoint ids are 0..checkpointCount-1
    effect?,             // for type 'effect'
    min: [x,y,z], max: [x,y,z], center, dir /* world heading of the block */, blockIndex,
  }],
  checkpointCount,
  spawn: { pos: [x,y,z], dir, quat: [x,y,z,w], blockIndex } | null,
                         // pos is ON the deck surface under the car's centre; quat maps car +Z to DIRS[dir]
  route,                 // Route (§5) or null
  routeError,            // string | null
  errors, warnings,      // from layout analysis (strings)
  issues,                // layout issues plus the route issue, as objects (above)
  render: { meshes, props },
  bounds: { min, max },  // world AABB of all collision triangles (not the ground)
  groundY: 0,            // GROUND_Y: deep-snow ground over the whole map, flush with level-0 decks
  fallY: -40,            // FALL_Y: below this the car is out
  mapSize: [1536, 256, 1536],
  occupancy,             // Map(cellKey(x, y, z) -> block index) of every footprint cell
  blockAt(x, y, z),      // block index whose footprint holds that cell, or -1
  blocks: [{ index, b, x, y, z, r, s, size,
             connectors: [{ local, kind, profile, cell, dir, pos, match: { block, connector } | null }] }],
}
```

`collision.triBlock` (Int32Array, one per collision triangle) names the block each
triangle belongs to (pillars carry their block too; the analytic ground is `hit.tri === -1`),
so `world.collision.triBlock[hit.tri]` picks the block under the cursor, including an
elevated deck's slab hanging into the cell below.

Triggers are world AABBs (all rotations are multiples of 90°). Gate triggers span the deck
and snowbanks (28 m), from 1 m below the deck to 7 m above it (below a car on the next
layer up, whose centre rides at +8.65 m, so a road stacked over a gate never takes it),
and 4 m along the road, so a car flying high over a gate misses it (like Trackmania).
Effect triggers cover the pad (24 × 20 m, up to 4 m high). At 100 Hz even 110 m/s moves
1.1 m per tick, but use `segmentAABB(prevPos, pos, trigger)` for exact crossing ticks.

Elevated blocks get **pillars** (2 × 2 m, collidable, surface `wall`) under each footprint
column the deck crosses (loops: only where the deck is at base height), on the centerline,
from the ground to `8y - 1.5`, unless another block occupies that column below.

**Ground**: an analytic slab at `Y = 0` covering the map (`0..1536` in X and Z), surface
`ground` (Deep Snow), flush with level-0 decks (their slabs are buried), so a car leaving
or rejoining the track at level 0 meets no step. It behaves as a half-space, so anything
that sinks below it is pushed up. A ray hitting a level-0 deck and the ground at the same
distance reports the deck. There is no ground outside the map.

### Render data

```js
render.meshes: [{ material, positions: Float32Array, normals: Float32Array,
                  uvs: Float32Array /* metres: u across, v along the road */, indices: Uint32Array,
                  ranges: [{ blockIndex, start, count }] }]
render.props:  [{ kind, pos, dir, blockIndex, ... }]
```

Meshes are merged per material, sorted by id; triangles are CCW seen from outside.
`ranges` slice `indices` per block (start and count in indices), so the editor can
highlight or hide one block with a draw range or a second index buffer; re-uploading only
one block's geometry needs `blockPreview` (same layout) plus a rebuild of the merged
buffers. The ground quad (`blockIndex -1`) lies exactly at `GROUND_Y`, coplanar with
level-0 decks: draw it with a polygon offset (e.g. `polygonOffset: true,
polygonOffsetFactor: 1, polygonOffsetUnits: 4`) or a few centimetres lower. Materials:
`road_snow|powder|ice`, `platform_snow|powder|ice`, `border` (snowbanks), `wall` (deck sides,
undersides, caps), `roof_ice` (tunnel shell), `line_start|finish|checkpoint` and
`pad_<effect>` (decals 3 cm above the deck, render-only), `ground` (one quad over the map).

Props:

| kind | fields |
| --- | --- |
| `gate` | `gate`, `pos` (deck centre on the line), `dir`, `width` 28, `height` 9 |
| `pad` | `effect`, `pos` (pad centre), `dir`, `size: [24, 20]` |
| `pillar` | `pos` (bottom centre, on the ground), `height`, `size` 2 |
| `spawn` | `pos`, `dir` |
| `decor` | `decor` (e.g. `'Pine'`), `pos` (cell centre at level y), `dir`, `decorIndex` |

## 4. Collision (`collision.js`)

```js
const mesh = new CollisionMesh(positions /* Float64Array, 9 per tri */, surfaces /* Uint8Array */,
                               { ground: { y, minX, maxX, minZ, maxZ, surface }, cellSize: 4 });
mesh.triCount; mesh.positions; mesh.normals /* unit, outward, 3 per tri */; mesh.surfaces; mesh.bounds
mesh.raycast(origin, dir, maxDist, out?) -> Hit | null
mesh.querySphere(center, radius, outArray, { merge = true }?) -> count
mesh.sweepSphere(a, b, radius, scratch?) -> t in [0, 1] | -1
mesh.surfaceName(index) -> 'snow' | ...
segmentAABB(a, b, box) -> entry fraction in [0, 1] | -1
pointInAABB(p, box) -> bool
```

Surfaces are indices into `SURFACE_IDS = ['snow', 'powder', 'ice', 'ground', 'wall']`
(`SURFACE_INDEX` maps back). Decks carry the block surface; snowbanks, deck sides,
undersides and pillars are `wall`; the tunnel roof is `ice`; the ground is `ground`.

**raycast** (Möller–Trumbore, two-sided, 3D-DDA through a uniform grid, nearest hit; ties
go to the lower triangle index so results never depend on traversal order). `dir` need
not be unit (then `t` is in units of `|dir|`). Rays through shared edges or vertices do not
slip between triangles.

```js
Hit = { t, point: [3], normal: [3] /* triangle's outward normal */, surface, surfaceId,
        tri /* -1 = ground */, backface /* ray hit the back side */, u, v }
```

Pass `out` (a Hit you own) to avoid allocation; the same object is returned on a hit.

**querySphere** fills `outArray` (reused; it only grows) and returns the contact count:

```js
Contact = { point: [3] /* closest point on the surface */, normal: [3] /* from surface to centre: push direction */,
            faceNormal: [3], depth /* radius - distance */, surface, surfaceId, tri, feature /* 0 face, 1 edge, 2 vertex */ }
```

With `merge` (default) the result is clean for physics: edge/vertex contacts lying in the
plane of a face contact (quad diagonals, block seams, coplanar neighbours) are dropped,
then contacts whose normals agree within ~2.5° collapse to the deepest. A wheel resting on
a seam gets exactly one contact; a wheel pressed into the deck/snowbank corner gets two.
Order is deterministic.

**sweepSphere** marches a sphere from `a` to `b` (steps of half the radius, then bisection
to ~1 cm) and returns the first touching fraction, for tunnelling checks.

Performance (150-block track, ~48k triangles, 4 m grid, Node 24, M-series laptop): ~2.6 M
short wheel rays/s and ~1.3 M sphere queries/s, so 20 queries per tick leaves room for
well over 20k ticks/s. **Long rays are much slower**: a ray along a road walks many 4 m
cells full of deck triangles, ~0.4 M rays/s for 30–300 m. A fan of 15 rays of 120 m per
tick for AI observations costs more than the simulation itself (~27k ticks/s on S01);
use `route.edgeRays` (§5) for road-edge sensors instead (~60k fans/s).

`collision.triBlock[tri]` is the block index of each triangle (set by buildWorld).

## 5. Route (`route.js`)

The world's route is one dense polyline: spawn → every checkpoint → finish line. For
StartFinish tracks it is one closed lap that **starts on the line** (`spawnS` = 6 m, the
spawn sits just past it) and ends on it, so lap progress is `s` in `[0, length)`.

How it is found: nodes are connectors ("entering block K through connector a"); edges are
block centerline paths (both directions, never U-turning inside a block) plus **gap edges**
from every dangling exit (ramp lips, open road ends) to every dangling road entry heading
the same way up to 8 cells ahead and at most one cell sideways (cost = straight distance).
A landing on the very face of the exit (a kicker followed directly by road, a drop onto
the road below) counts only directly in front of it. A road end may not "jump" more than
0.5 m up; a lip may throw the car at most one layer (8 m) above the lip. Jump edges are
not tested for obstacles in between.

The search goes to the nearest unvisited checkpoint (checkpoints count in any order and
either direction, like Trackmania) until none are left, then to the nearest finish line
(on lap tracks the StartFinish line only, so the route is one closed lap), where the route
is cut. When the nearest checkpoint leads into a dead end it backtracks and tries the next
nearest (depth-first, bounded), so any valid order is found. The result is resampled every
~2 m (`ROUTE_STEP`).

```js
route.count, route.length
route.points    // Float64Array, 3 per point
route.ups       // Float64Array, unit deck normal per point (banked/looping roads included)
route.tangents  // Float64Array, unit, central difference per point
route.s         // Float64Array, cumulative distance
route.halfWidth // Float64Array, drivable half-width (12 road, 5 narrow, 16 platform)
route.surface   // Uint8Array, SURFACE index, 255 (NO_SURFACE) over jumps
route.gap       // Uint8Array, 1 on jump segments (airborne)
route.curvature // Float64Array, lateral curvature 1/m in the road frame, + = right turn
route.vcurvature// Float64Array, vertical curvature, + = compression (loop, valley), - = crest (air time)
route.segDirs, route.segLens
route.checkpoints  // [{ id, s }] in route order (first crossing of each checkpoint)
route.finishS      // = length
route.spawnS       // 0, or 6 on lap tracks
route.closed       // true for lap routes

route.project(pos, hintIndex = -1, out?) -> { s, index, t, point, tangent, up, lateral, vertical, dist, halfWidth }
route.pointAt(s, out?) -> { point, tangent, up, index, s, halfWidth, surface, gap }
route.indexAt(s); route.wrapS(s)        // closed routes wrap s
route.curvatureAt(s)                    // interpolated lateral curvature
route.headingChange(s0, s1)             // signed heading change (rad), + = right
route.maxCurvature(s0, s1)
route.headingAt(s)                      // yaw = datan2(x, z): 0 = +Z, +π/2 = +X (left!); a right turn makes it DEcrease
route.remaining(s)
route.edgeRays(pos, heading [x, z], angles, maxDist, out?, hint?, back = 20) -> distances
```

Note the sign conventions: `curvature`, `headingChange` and `lateral` are **+ = right**,
while `headingAt` is a plain yaw angle (`yawOf` in mathd), which grows to the left.

`project` searches segments `hint-10 .. hint+30` first (pass the previous result's `index`)
and falls back to a global scan when the best local segment is on the window's edge or more
than `halfWidth + 6` m away (a stale hint after a respawn or a rewind; `RouteTracker` passes
`-1` after one anyway). `lateral` is measured
against the nearest segment (`+` = right of the centerline), `vertical` along the deck
normal. Curvature is measured in the deck frame, so on a 40° bank the lateral curvature is
`cos 40°` of the plan curvature and the rest shows up as `vcurvature`; a vertical loop is
almost pure `vcurvature`. A speed budget for an autopilot is e.g.
`v_max = sqrt(grip · g / |curvature|)`.

**edgeRays** are cheap 2D road-edge sensors for AI observations: from `pos`, one ray per
entry of `angles` (radians from `heading`, + = right) against the left and right road edges
(centerline ± halfWidth along the deck's right vector, seen from above) of the route
segments from `back` metres behind to `maxDist + back` ahead of the car's projection,
ignoring jumps and edges more than 6 m above or below the car. `out[i]` is the distance to
the first edge, or `maxDist`. Cost is rays × segments in the window, no 3D grid walk.

**RouteTracker** is the lap-aware progress everyone needs (AI rewards, HUD progress bar,
TAS fitness, standings, the autopilot), so nobody re-implements the wrap and respawn logic:

```js
const tr = new RouteTracker(world.route);
sim.step(input); tr.track(sim);         // or tr.update(pos, tick, respawned)
tr.progress   // unwrapped metres (closed routes keep counting: lap k adds k · length)
tr.lap        // 1 + floor(progress / length) on lap routes, else 1
tr.s, tr.index, tr.lateral, tr.vertical, tr.dist, tr.halfWidth, tr.gap
tr.best, tr.bestTick                    // best progress and when it was reached (stuck timer)
tr.getState(); tr.setState(s); tr.reset();
```

`track(sim)` notices respawns from `sim.respawns` (sim state, not events), re-projects
globally, never moves progress forward on a respawn and restarts the stuck timer there, so a
tracker restored next to a sim savestate resumes identically.

## 6. Share codes and track hash (`codec.js`)

```js
encodeTrack(track) -> 'PT1.<base64url>'
decodeTrack(code) -> track          // throws Error('Corrupt track code: ...')
trackHash(track) -> 16 hex chars    // laps, mode and the exact block list only
CODE_PREFIX                         // 'PT1.'
toBase64Url(bytes), fromBase64Url(str)
```

The binary layout is in [TRACK_FORMAT.md](TRACK_FORMAT.md). Replays store `trackHash` so a
ghost never plays on a track whose layout changed; renaming, medals and decor do not change it.
`encodeTrack` and `trackHash` normalise exactly like `normalizeTrack` (integer coordinates,
rotations 0..3, the lap rule, unknown modes → race), so a code always decodes to the track
`buildWorld` builds and `trackHash(raw) === buildWorld(raw).hash`. `fromBase64Url` rejects
non-zero padding bits, so one byte string has exactly one code.

## 7. Deterministic math (`mathd.js`) and RNG (`rng.js`)

Only `+ - * /` and `Math.sqrt/abs/floor/min/max` (and integer `Math.imul` in hashing) are
used. Never use `Math.sin`, `Math.pow`, `**`, `Math.hypot` … in core; use these:

| function | notes |
| --- | --- |
| `dsin, dcos, dtan, dsincos(x, out)` | Cody–Waite reduction to [-π/4, π/4] + Taylor to degree 19/18, error ~1e-16 for \|x\| < 1e5 |
| `datan, datan2(y, x), dasin, dacos` | table-shifted series, error ~2e-16, `datan2` signs match `Math.atan2` |
| `dexp, dlog, dpow(x, y)` | relative error ~2e-16; integer `y` uses exact squaring |
| `dsqrt, dhypot, len3(x,y,z), sq(x)` | |
| `clamp, lerp, smoothstep, smootherstep, sign, wrapAngle, approach` | |
| constants | `PI, TWO_PI, HALF_PI, QUARTER_PI, DEG` |

vec3 helpers take `out` first and may alias inputs: `vec3, vset, vcopy, vadd, vsub, vscale,
vaddScaled(out, a, b, s) /* a + b·s */, vneg, vdot, vcross, vlen, vlen2, vdist, vdist2,
vnormalize, vlerp, vreject`.

Quaternions `[x, y, z, w]` (Hamilton, `rotate(v) = q v q*`): `quat, qset, qcopy, qidentity,
qmul, qconj, qnormalize, qrotate, qrotateInv, qfromAxisAngle, qfromYaw, qfromBasis(out,
right, up, forward), qintegrate(out, q, worldAngVel, dt), qnlerp, qforward, qup, qright,
DIR_QUATS, yawOf(dx, dz)`.

`new Rng(seed)` (mulberry32): `next()` in [0, 1), `nextU32()`, `range(a, b)`, `int(n)`,
`pick(arr)`, `chance(p)`, `normal(mean, std)`, `shuffle(arr)`, `fork()`,
`getState()/setState(s)` (a plain uint32, savestate friendly). `hashSeed(str)` turns names
into seeds.

## 8. Dev fixtures, tests and the world viewer

`samples.js`: `SAMPLE_SPECS` (path-builder specs), `getSamples()`, `getSample(id)`.
Together they use every block:

| id | name | covers |
| --- | --- | --- |
| S01 | Frosty Oval | Turn1/2/3 left and right, flat |
| S02 | Snowdrift Hills | slopes up/down, Bank2/Bank3, Bump, elevated Narrow, Tunnel, pillars |
| S03 | Penguin Air Show | Loop, LoopL, RampBig onto an elevated landing, RampSmall gap, Turbo |
| S04 | Special Delivery | every special pad (each lasting effect is cleared by a Thaw before the next turn) |
| S05 | Ice & Powder Run | ice/powder sections, Cross (straight and turning), Platform, PlatformRamp |
| S06 | Igloo Circuit | StartFinish, 3 laps |

Tests: `node tools/test.mjs [filter]` runs every `tools/tests/*.test.mjs`. A test file
registers tests at import time:

```js
import assert from 'node:assert/strict';
import { test, approx, info } from './_harness.mjs';
test('my thing', async () => { assert.equal(1 + 1, 2); });
```

`tools/tests/geometry.test.mjs` covers math accuracy, every block at every rotation /
height / surface, deck normals, raycasts onto every path point, connector continuity for
all pairs, collision queries, routes of all samples, validation, the path builder, codec
round trips, build speed and determinism, and a collision benchmark.

World viewer: `dev/world-viewer.html?track=S01&view=iso|top` (or
`?block=Loop&r=1&y=2&s=ice` for one block). Extra params: `render=1` (render materials
instead of collision surfaces), `wire=1`, `yaw`, `pitch`, `dist`, `focus=x,y,z`. It shows
collision triangles coloured by surface, trigger boxes, the route (magenta, jumps
yellow), checkpoint markers, pillars, gates, spawn and decor, and sets
`window.__viewer = { ready, world, track, buildMs }` for headless checks.

<!-- Simulation half (car.js, sim.js, input.js, replay.js, autopilot.js), written by the physics owner. -->

## 9. Simulation (`sim.js`)

```js
import { Sim, hashState, canonicalState } from './core/sim.js';
const sim = new Sim(world, { laps, allowNoSpawn, physics });   // laps defaults to world.laps; tick 0 = the instant of "GO"
sim.step({ steer, gas, brake, respawn? });            // advance one 10 ms tick
sim.lastInput                                         // what that tick simulated (record this)
```

The constructor throws on configurations that can never finish: a lap count that is not a
positive integer, `laps > 1` on a track without a StartFinish line, or a world without a
spawn (pass `allowNoSpawn: true` for synthetic test worlds; the car then starts at the
origin).

**Physics versions** (`car.js`: `PHYSICS_LEGACY = 1`, `PHYSICS_LATEST = 2`). `physics`
picks the rule set and defaults to 1, the rules every run without a version was recorded
with (replays, author runs, TAS scripts, savestates). Live play (`race.js`, `mp/racer.js`
`ROOM_PHYSICS`) passes `PHYSICS_LATEST`. Physics 1 code paths are frozen bit-for-bit;
physics 2 adds the Trackmania-style handling (below) and mid-air checkpoints:
an airborne car entering the column `CHECKPOINT_AIR_HEIGHT` (24 m) above a checkpoint's
trigger box (same footprint) takes it. A physics 2 state carries `physics` and `insideAir`;
`setState` refuses a state from another physics version. Unknown versions throw.

| field | meaning |
| --- | --- |
| `tick` | ticks simulated since GO (also after the finish) |
| `timeMs` | race time: `tick * 10`, frozen at `finishTimeMs` once finished |
| `finished`, `finishTimeMs` | `finishTimeMs` is `null` until the finish |
| `lap`, `laps`, `lapTimes` | `lap` is the lap being driven (1-based); `lapTimes` are completed laps in ms |
| `checkpointTimes` | race time (ms) of every checkpoint crossing this run, in order (all laps) |
| `collected`, `collectedCount`, `checkpointCount` | checkpoints taken in the current lap (array of 0/1 by checkpoint id) |
| `lastCheckpoint` | id of the checkpoint the next respawn returns to (-1: the start) |
| `respawns` | respawn count (platform mode ranks by it) |
| `fallen` | the car is below `world.fallY` and has not respawned yet |
| `car` | the live car (below): read it, never write it |
| `events` | events emitted by the last `step` (a fresh array when there are any; do not mutate) |
| `lastInput` | `{ steer, gas, brake, respawn }` the last step simulated: normalised (§11), `respawn` true when the tick began with a respawn (flag or `respawn()`), neutral after the finish. Reused every tick: copy it to keep it (`Recorder.push` copies) |
| `respawnPending` | `respawn()` was called and the next step will respawn |

**Race rules.**

- Checkpoints count once per lap, in any order and either direction. A Finish (or the
  StartFinish line on the last lap) with checkpoints missing emits
  `{ type: 'missingCheckpoints', missing }` and does not finish.
- Lap tracks: crossing StartFinish with every checkpoint taken completes a lap (`lap`
  event, checkpoints reset, the line becomes the respawn point); on the last lap it finishes.
  A Finish arch on a lap track only counts on the last lap.
- **Timing rule**: triggers are tested against the segment the car's centre swept during
  the tick (`segmentAABB(prevPos, pos)`), so nothing is skipped even at 1000 km/h. A gate
  counts on the tick whose swept segment first enters its box, and the time is that tick's
  number × 10 ms (`finishTimeMs = tick * 10`, rounded up to the tick, never interpolated).
  Gate boxes are 4 m deep around the line, so the clock stops ~2 m before the painted line.
- After the finish the sim keeps running: inputs are ignored (the car coasts), the clock
  stays at `finishTimeMs`, and respawn flags are ignored.
- A pad (or gate) fires once per entry: the car must leave its box before it can fire again.
  A car spawned or respawned inside a box does not fire it.

**Respawn** (`respawn: true` in the tick's input, or `sim.respawn()`, which requests the
same for the start of the next `step()`, so both are recorded identically through
`lastInput`): back to the car state captured when the last checkpoint (or lap line) was
crossed: same position, velocity, orientation and effects, TM style, with the engine
repaired (`noEngine` and a broken Thin Ice car are cleared). Before the first checkpoint it
returns to the spawn standing still, and **the race clock keeps running** (TM parity;
`reset()` is the "restart run" action). `respawns` increments either way. Falling below
`world.fallY` (-40 m) emits `fall` once and sets `fallen`; the game and the autopilot
respawn on it.

**Savestates.** `getState()` returns a plain JSON object (`v: 2`, numbers, booleans,
strings and arrays only, no NaN/Infinity, -0 normalised to 0) holding everything that
affects future ticks: which world it belongs to (`world: world.hash`), `laps` and `mode`,
the race state, a pending respawn, the trigger-inside flags, the checkpoint snapshot and the
car. `setState(s)` restores it exactly and throws when the state belongs to another track,
lap count or mode (or another state version); `JSON.parse(JSON.stringify(state))` resumes
bit-identically (tested). `reset()` returns to tick 0. `stateHash()` / `hashState(state)`
give 16 hex chars for sync checks; `hashState` hashes `canonicalState(state)` (getState's
exact shape and key order, unknown keys dropped), so a state that went through another
serializer (Python's `sort_keys`, extra fields) hashes and restores the same.

### Events

Every event has `type` and `tick`.

| type | fields | when |
| --- | --- | --- |
| `checkpoint` | `id, count, total, timeMs, lap` | a new checkpoint of this lap is crossed |
| `missingCheckpoints` | `missing` | a finish / lap line crossed with checkpoints missing |
| `lap` | `lap` (just completed), `timeMs`, `lapTimeMs` | a lap other than the last is completed |
| `finish` | `timeMs, respawns, lap` | the race is over |
| `respawn` | `checkpoint` (-1 = start) | a respawn happened (start of the tick) |
| `fall` | `reason?` | the car dropped below `fallY` (`reason: 'invalid'` = numeric recovery with an immediate respawn, never expected) |
| `effect` | `effect` | a pad applied its effect (`turbo`, `turbo2`, … `reset`) |
| `boost` | `level` 1 \| 2 | Frost / Avalanche Boost (also emits `effect`) |
| `land` | `strength` (m/s into the ground), `airTime` (s) | first touchdown after ≥ 0.08 s in the air |
| `wallhit` | `intensity` (m/s into the wall), `pos` | a new wall contact above 2.5 m/s, or any above 6 m/s |
| `fragileBreak` | `cause`: `'wall'` \| `'landing'` | a Thin Ice car broke (engine dead until respawn) |

## 10. The car (`car.js`)

`sim.car` is the live `Car` object, including its internal state (`comp`, `brakeTicks`,
`driftDir`, …): **read it, never write it** (writing changes the simulation; use
`sim.setState` to place a car):

```js
car.pos [x,y,z]          // centre of mass, world metres (0.65 m above flat ground at rest)
car.quat [x,y,z,w]       // car-local forward +Z, up +Y, right -X
car.vel, car.angVel      // m/s, rad/s (world)
car.speed, car.speedKmh, car.forwardSpeed   // forwardSpeed < 0 when reversing
car.steer                // smoothed steering -1..1 (+ = right)
car.rpm (0..1), car.gear (1..6)   // synthetic gearbox for audio
car.airborne, car.drifting, car.slipAngle (rad), car.surfaceUnder ('snow'|'powder'|'ice'|'ground'|'wall'|null)
car.wheels[4]            // FL, FR, RL, RR: { contact, surface (id or null), compression (m),
                         //   steer (rad), spin (rad, 0..2π), pos (wheel centre, world), slip (0..1) }
car.effects              // { turbo: 0|1|2, turboTime, noEngine, noSteer, noBrake,
                         //   slowmo: 0..3, cruise, cruiseSpeed (signed), fragile, broken }
```

**Wheels for renderers.** Left is car-local +X (FL, RL at `+0.85`), so FL/RL are on the
+X side. `wheel.pos` is the wheel centre (one `wheelRadius` = 0.38 m above the contact
point). `wheel.steer` is + = right, i.e. a rotation of **−steer about the car's +Y** in
Three.js terms. `wheel.spin` rotates about car-local +X and increases when rolling
forward; it is wrapped to [0, 2π), so interpolate it by the distance travelled, not by
the wrapped difference (above ~430 km/h a wheel turns more than π per tick):
`lerpCarSnapshot` and `ghostPoseAt` (§12) do that.

`snapshotCar(sim.car, out?)` (replay.js) copies everything a renderer or the audio engine
reads (the car's arrays are reused every tick); `lerpCarSnapshot(prev, cur, alpha, out?)`
interpolates two snapshots for drawing between ticks (after a respawn draw `cur` as is).
Useful exports: `CAR` (all tuning constants), `SURFACE_PARAMS`, `ENGINE_CURVE`, `GRAVITY`,
`MAX_SPEED`, `SLOWMO_SCALES`, `RIDE_HEIGHT`, `engineAccel(v)`, `steerAngleMax(v)`,
`carStateFrom(obj)` (the canonical car state shape).

### Model

- **Gravity 20 m/s²** (about 2 g: short, snappy jumps). Mass is normalised to 1, so every
  force is an acceleration.
- **Rigid body** (position, velocity, quaternion, angular velocity) with inertia
  [1.5, 1.8, 0.75] m² (pitch, yaw, roll), integrated with semi-implicit Euler in
  **substeps**: `ceil(speed · dt / 0.35 m)`, 1–10 per tick (3+ while a spring is near the end
  of its travel), so the car never moves more than 0.35 m per substep and cannot tunnel
  through a 1.5 m deck or a thin wall even at the 1000 km/h hard cap.
- **Four raycast wheels** (wheelbase 2.8 m, track 1.7 m, radius 0.38 m, 0.35 m travel):
  progressive spring (60·x + 720·x³ per wheel), damper 5 / 4 (bump / rebound) measured
  against the hit normal, and a stiff frictionless bump stop beyond the travel so 300 km/h
  loops stay on the wheels. Rays ignore back faces, faces steeper than ~63° to the car floor,
  and steep `wall` faces, so the car never drives on walls. Tyres are 0.3 m wide: when the
  centre ray misses the road (a deck edge, the foot of a leaning snowbank) a second ray from
  the tyre's inner edge may still find it, so a car parked against a snowbank rests instead
  of rocking on and off its outer wheels.
- **Six body spheres** (corners plus cabin sides, ~2.0 × 3.9 m) collide with the mesh: they
  are pushed out of penetration and get an impulse with restitution 0.1 (0 below 3 m/s) and
  friction 0.08 on walls (glancing hits slide along) or 0.4 on the road (belly scraping).
  Wall-surface normals are flattened into the car's floor plane first, so the outward-leaning
  snowbanks bounce the car sideways and never launch it onto the bank. While the body rests on
  something other than a wall (on its roof, high-centred on a lip) the car is not "flying":
  no air steering and no self-righting.
- **Tyres at the velocity level.** In the ground frame (load-weighted wheel normal N,
  heading H, right R = H × N):
  - **downforce** `0.002 · v²` (≈ 12 m/s² at 280 km/h) presses a grounded car onto the deck
    along N, so fast lines over crests and banks stay loaded (it does nothing in the air);
  - the lateral grip budget is `G = grip(surface) · suspension load`, i.e. about 30 m/s² on
    packed snow at 100 km/h, rising with downforce (≈ 37 at 200, 42 at 250 km/h) and with
    compression (banks, loops);
  - lateral velocity is cancelled within G per second; while sliding, the drive force along
    the heading also turns the velocity (by `aLong · sin slip`), and that share comes out of
    the same budget, so a power slide (ice) cannot corner harder than the grip allows;
  - the yaw rate follows a bicycle model `v · tan(δ) / wheelbase`, capped at
    `G · yawGrip / v`, plus a realignment `align · v_lat / max(|v|, 5)` (faded out below
    3 m/s) that swings the nose back toward the velocity when sliding: at most `align`
    rad/s, never a spike in a sideways slide, and a parked car never yaws itself downhill.
    `yawGrip > 1` lets the heading outrun the velocity (powder slides, ice spins); packed
    snow (0.96) never slides on its own.
  - The steering angle is `27° / (1 + (v / 23 m/s)²)`, slewed at 14 full locks per second:
    twitchy at walking pace (full-lock radius ~6 m), calm at speed, and full lock always
    reaches the grip limit above ~60 km/h.
- **Engine** `ENGINE_CURVE` (16 m/s² up to 50 km/h, fading to 3.75 at 300 km/h) against aero
  drag `0.00055 · v²` and 0.3 m/s² rolling resistance gives the ~290 km/h plateau. Brakes
  22 m/s²; holding the brake when (nearly) stopped reverses at up to 50 km/h; coasting
  engine-brakes 1.2 m/s². Traction scales with the surface (`engine`, `brake`).
- **Drift**: pressing the brake (within 0.15 s of the press) while steering more than 35 %
  above 70 km/h on packed snow, powder or deep snow starts a drift. The heading then
  leads the velocity by a slip angle set by the steering (14° light, 26° full lock). In a
  drift the brake itself adds only 4 m/s², but the slide scrubs speed on its own: a 1 s
  full-lock drift from 150 km/h loses ~4 m/s² with gas, ~14 coasting and ~17 with the brake
  held (from 250: 11 / 18 / 20). Releasing the brake while steering into the turn holds the
  drift; centring or counter-steering ends it and the car realigns in ~0.2 s. The press must
  come with the steering: holding the brake from a straight into the corner (more than
  0.15 s before the wheel passes 35 %) is ordinary trail braking and does not drift. Ice
  never brake-drifts (it slides anyway). `car.drifting` reports the state.
- **Physics 2 drift**: starts from 40 km/h. Lateral grip drops to 0.7 at the tap (the velocity
  keeps its own line while the nose swings) and recovers to 1.1 over 0.5 s of drift, so a held
  drift turns tighter than grip driving (180 km/h, 1.5 s full lock: ~66° vs ~57°). Counter-
  steer keeps the drift alive, eases the angle toward 0 (never flips it) and runs the recovery
  up to 3× faster; centring without the brake ends it. **Speed drift**: a slip angle held in
  16°–24° above 110 km/h turns the velocity without scrubbing speed plus 1.5 m/s² along it
  (`car.speedDrift`); wider angles scrub as before. **Air-brake**: the brake in the air keeps
  the air steering and swings pitch/roll toward the ground plane below (a 40 m ray; level when
  none) (`car.airBraking`); still held at touchdown, the impact into the deck and the
  pitch/roll rate are absorbed, so the car does not bounce.
- **Air**: steering yaws up to 1.6 rad/s about world up; after 0.1 s of flight a gentle
  torque (easing in over 0.3 s) rights pitch/roll toward "level, nose partly along the flight
  path" and damps them, so most landings are on the wheels. Landing nose-first (car pitch
  more than ~9° off the surface) costs up to 50 % of the forward speed.

| surface | grip ×g | yawGrip | align | yaw resp | engine | brake | drag 1/s | drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| snow (Packed Snow) | 1.5 | 0.96 | 3 | 30 | 1.0 | 1.0 | 0 | yes |
| powder | 1.0 | 1.4 | 1.5 | 18 | 0.9 | 0.8 | 0.02 | yes |
| ice | 0.36 | 4.5 | 0.8 | 3.5 | 0.6 | 0.3 | 0 | no |
| ground (Deep Snow) | 0.6 | 1.3 | 1.5 | 14 | 0.75 | 0.7 | 0.26 | yes |
| wall (snowbank tops) | 0.25 | 0.5 | 1 | 3 | 0.3 | 0.3 | 0.1 | no |

### Effects (TM2020 semantics)

| effect | pad | behaviour | ends |
| --- | --- | --- | --- |
| `turbo` | Frost Boost | +12 m/s² along the heading on the ground, decaying linearly over 2 s (car time) | after 2 s, Thaw |
| `turbo2` | Avalanche Boost | +24 m/s², same decay; a pad never weakens a running boost (the one pushing harder right now wins) | after 2 s, Thaw |
| `noEngine` | Frozen Engine | no engine force (no gas, no reverse); brakes and steering work | Thaw, respawn |
| `noSteer` | Frozen Wheel | steering input ignored (wheels return to centre) | Thaw |
| `noBrake` | Brake Freeze | brake input ignored (no braking, no reverse, no drift) | Thaw |
| `slowmo` | Snow Globe | car time runs at 0.85 → 0.7 → 0.55 per pad (stacks, max 3); the race clock does not slow | Thaw |
| `cruise` | Glide | holds the (signed) forward speed it had on the pad, so reversing onto it keeps reversing; gas and brake ignored, steering works | Thaw |
| `fragile` | Thin Ice | a wall impact above 11 m/s or a landing above 20 m/s breaks the car: engine off (`broken`), `fragileBreak`. A kicker gap (~19 m/s into flat ground) survives; a ski jump onto flat ground (~25 m/s) does not, so put a Thaw before big jumps | Thaw clears Thin Ice; respawn repairs a break |
| `reset` | Thaw | clears every effect | |

A respawn restores the effects captured with the checkpoint, then repairs the engine.

### Measured feel (`node tools/test.mjs physics`)

| metric | value |
| --- | --- |
| 0–100 / 0–200 km/h on packed snow | 1.95 s / 5.69 s |
| plateau (full gas, flat) | 290 km/h; powder 251, ice 249, deep snow 109 |
| braking 200 → 0 | 2.52 s, 68 m |
| reverse | 47.5 km/h after 8 s (50 km/h cap) |
| full-lock radius at walking pace | 5.9 m |
| lateral grip at 100 km/h (targets are at 100 km/h) | snow 30, powder 21 (14° slide), deep snow 13, ice 7.5 m/s² (also when power-sliding: big slides, no extra grip) |
| lateral grip rising with downforce (snow) | 37 at 200, 42 m/s² at 250 km/h |
| cornering speed with the autopilot | Turn1 108, Turn2 170, Turn3 216 km/h |
| Loop, speed needed at the bottom of the circle, hands off | ~70 km/h with gas held, ~150 km/h coasting (below) |
| Bank3 with the throttle pinned (racing line) | entered at 282 km/h, slowest point 281 km/h, no wall contact |
| Bank3 on the centerline | clean at 220 km/h; flat out it runs wide (grip, not lift) |
| walls at 150 km/h (coasting, 0.6 s after) | 5° / 15° glancing keep 94 % / 87 %, 30° 69 %, 45° 48 %, head-on stops |
| drift at full lock from 150 km/h | ~27° slip, ~12 km/h lost per second with gas |
| parked across a 21° slope / against a snowbank, 20 s | moves < 2 cm |
| `Sim.step` speed (S03, Node 24, M-series) | ~140–165 k ticks/s (~110–130 k with the autopilot) |

**Loops.** What decides a loop is the speed at the bottom of the circle: ~70 km/h with the
gas held, ~150 km/h coasting (the engine pulls about as hard as gravity's average along the
climb, 2g/π ≈ 12.7 m/s², at loop speeds, which the 0–100 / 0–200 targets require). The Loop
block has 32 m of road before the circle, and full gas from a standstill at its entrance
reaches the bottom at ~110 km/h, so **a loop taken with the gas held always makes it**; it
fails when you arrive slow and lift or brake, or arrive far off-line.

## 11. Input (`input.js`)

```js
{ steer, gas, brake, respawn? }          // one per tick; steer integer in [-65536, 65536], + = right
makeInput(steer, gas, brake, respawn?)   // normalised (rounded, clamped, booleans)
clampSteer(x)                            // THE normalisation rule (below)
clampInput(anything) ; normalizeInto(out, input) ; inputsEqual(a, b) ; NEUTRAL
digitalSteer(left, right) -> -65536 | 0 | 65536
analogSteer(x in -1..1, deadZone = 0.12) -> integer steer
fromDigital({ left, right, up, down }) -> input
ACTIONS, ACTION_COUNT (9), actionToInput(i), inputToAction(input)
```

**Steer is normalised once, the same way everywhere.** `Sim.step`, `Recorder.push` and
`encodeInputs` all apply `clampSteer`: round to the nearest integer (`Math.round`), clamp to
±65536, NaN and non-numbers become 0. So fractional values from an AI policy or
interpolated TAS steering, `Infinity` from a disconnected gamepad or values past ±2³¹ are
simulated live exactly as the replay stores them. Steer is in units of 1/65536 of full
lock: a -1..1 value must be multiplied by `STEER_MAX` (0.9 rounds to 1, i.e. no steering).

Discrete actions for AI agents, index = `steerIndex * 3 + throttleIndex`:

| | gas | coast | brake |
| --- | --- | --- | --- |
| left | 0 `left+gas` | 1 | 2 |
| straight | 3 | 4 | 5 |
| right | 6 | 7 | 8 `right+brake` |

## 12. Replays (`replay.js`)

```js
const rec = new Recorder();
sim.step(input); rec.push(sim.lastInput);  // once per tick: exactly what the tick simulated
rec.truncate(ticks); rec.clear(); rec.respawnTicks();
const replay = rec.toReplay({ sim, name, date });   // or { world | trackId + trackHash, laps, timeMs, finished, ... }
// { format: 1, trackId, trackHash, laps, physics?, inputs: '1:…', ticks, timeMs, finished, respawnTicks, date, name }
// physics is only written when it is not 1; replayPhysics(replay) reads it (1 when absent)
encodeInputs(inputs) -> '1:<runs>'
decodeInputs(text, { maxTicks = MAX_REPLAY_TICKS }) -> inputs     // throws on malformed or non-canonical text
countInputs(text) -> ticks                                       // validates without expanding
MAX_REPLAY_TICKS                                                 // 360000: one hour
simulateReplay(world, replay, { sampleEvery = 1, stopAtFinish = true, laps, physics, maxTicks, onTick })
    -> { finished, timeMs, ticks, respawns, respawnTicks, checkpointTimes, lapTimes, samples, sim }
verifyReplay(world, replay, { requireFinish = true, physics }) -> { ok, reason, finished, timeMs, respawns }
ghostPoseAt(samples, fractionalTick, out?) -> { pos, quat, speedKmh, wheels? }   // interpolated ghost pose
snapshotCar(car, out?) ; lerpCarSnapshot(a, b, alpha, out?)                     // renderer helpers (§10)
```

**Record `sim.lastInput`.** Pushing the input you passed works too (the Recorder applies the
same normalisation as the sim), but only `lastInput` also captures respawns requested with
`sim.respawn()` and drops inputs after the finish. `toReplay({ sim })` takes the world, lap
count, finish flag and time from the sim.

Encoding: runs joined by `.`; each run is `<flags><steer>[*<count base 36>]` where flags is
`'A' + (gas | brake << 1 | respawn << 2)` and steer is empty for 0, `L` / `R` for full lock,
otherwise a signed base-36 integer. Three seconds of straight full gas then half a second
of full right: `1:B*8c.BR*1e`. The encoding is canonical and `decodeInputs` accepts only
canonical text: lowercase base 36 without leading zeros, no `0`, `-0` or ±65536 as numbers
(full lock is `R` / `L`), no `*1`, no two equal runs in a row, nothing after a count. So one
input list has exactly one string (dedup, integrity checks), and a run count is checked
against `maxTicks` before anything is allocated (`'1:B*zzzzzz'` claims 2 billion ticks and
is refused at once). An autopilot run of S03 (2439 ticks, analog steering every tick) is
~11 kB; keyboard play is much shorter.

`samples` hold `{ tick, pos, quat, vel, speedKmh, steer, airborne, drifting, teleport,
wheels[{ compression, steer, spin, contact }] }` for ghost cars; `teleport` is true when a
respawn happened since the previous sample, and `ghostPoseAt` then snaps to the later sample
instead of gliding across the map. Give `out.wheels` (four objects) to `ghostPoseAt` to get
wheel compression, steer, contact and spin (advanced by the distance travelled, never
backwards).

`verifyReplay` checks every claim against a re-simulation: the replay must carry the
world's `trackHash` (missing counts as wrong), `ticks` must match the inputs, the run must
reach the finish (unless `requireFinish: false`), `finished` and `timeMs` must match the
simulation exactly (a finished replay without a time fails), and `respawnTicks` must equal
the ticks where the simulation respawned (inputs after the finish are ignored). The lap
count is the replay's `laps` (else the world's).

## 13. Autopilot (`autopilot.js`)

```js
const pilot = new Autopilot(world, opts);
const input = pilot.act(sim);            // call once per tick, before sim.step(input)
pilot.progress; pilot.respawnCount; pilot.targetSpeed; pilot.tracker /* RouteTracker */; pilot.jumpSpeed;
pilot.getState(); pilot.setState(s);     // driver memory, for savestates next to sim.getState()
pilot.reset();

runAutopilot(world, { maxTicks = 60000, record = false, maxRespawns = 40, giveUpAfter = 12, laps, ...opts })
    -> { finished, timeMs, ticks, respawns, checkpointTimes, lapTimes, gaveUp, replay, sim, pilot }
```

`runAutopilot` is the one runner for "can this track be finished?" (levels, verify scripts,
the editor's validate-by-driving, author ghosts with `record: true`; the replay verifies).
It gives up after `maxRespawns` respawns or `giveUpAfter` respawns without reaching a new
checkpoint, lap or the finish, and throws when the world has no route.

- **Racing line**: a minimum-curvature band (each point moves to
  `(-L[i-2] + 4 L[i-1] + 4 L[i+1] - L[i+2]) / 6`, projected on its lateral axis and clamped
  2.6 m inside the road edge, coarse to fine). Wide entries, inside apexes, and the low inner
  line through banks. Straight and centred for 40 m before jumps and 30 m before loops.
- **Speed plan**: per point, the highest speed where the tyres can supply the line's
  curvature, counting bank help, compression and downforce (`grip · margin`); crests
  (negative vertical curvature) are limited to 1.25 × the speed at which gravity plus
  downforce just keep the wheels down (not at a ramp lip, which is the launch). **Jumps**:
  the launch point gets the speed that carries the gap (projectile from the launch tangent
  to the landing) × `jumpFactor` (1.15), so the car lands just past the landing edge
  instead of far down the track; a gap that cannot be reached keeps full gas, and a landing
  right below the launch (< 8 m away) needs no plan. At run time the target is the minimum
  of `sqrt(v_i² + 2 · decel · d_i)` over 260 m ahead, using the current surface's brakes (or
  coasting under Brake Freeze / Glide).
- **Driving**: pure pursuit toward the line at `6 m + 0.28 s · speed` (max 36 m, 9 m in
  loops). Full gas in the air and in loops. It avoids starting accidental drifts (the brake
  is pressed with a light hand on the wheel, then trail-braked).
- **Respawns**: when the sim says `fallen` or the car is `broken` (state, not events, so a
  savestate taken on that tick resumes the same), after 3 s without progress, or after 0.8 s
  more than 9 m off the road (27 m when airborne or over a gap). Progress comes from a
  `RouteTracker`, which restarts the stuck timer after every respawn (also ones the pilot did
  not ask for).
- Options (`AUTOPILOT_DEFAULTS`): `lookBase, lookPerSpeed, lookMax, lookLoop, racingLine,
  lineMargin, gripMargin (0.92), crestFactor (1.25), brakeMargin (0.8), speedSlack,
  stuckTicks, offRouteTicks, offRouteMargin, respawn, maxSpeed, fullThrottle, jumpFactor (1.15)`.

Sample times (0 respawns each): S01 22.14 s, S02 23.58 s, S03 24.39 s, S04 21.49 s,
S05 24.71 s, S06 39.68 s (3 laps: 14.50 / 12.59 / 12.59 s).

## 14. Time text and tools

`formatTime(ms, { style = 'race' | 'long' | 'short', sign = false, empty = '-:--.--' })`
(`format.js`) is the one race-time format for every screen: `0:42.37`, `0:42.370` (long),
`42.37` (short, under a minute), `+0.53` / `-1.53` for splits; digits are truncated like
Trackmania; null/NaN give `empty`.

- `node tools/sim-probe.mjs <S01..S06 | PT1.code | track.json | flat[:surface]> [--driver auto|gas|idle|script]
  [--script "gas*3s,gas+right*1.5s,brake+left*0.4s"] [--seconds N] [--every N] [--events] [--quiet] [--json]`
  drives a track and prints a per-second log (speed, position, surface, air/drift, route
  progress and lateral offset, effects, events) plus a summary.
- `tools/lib/testworlds.mjs`: `flatWorld({ surface, half, y, wallX })` (an endless flat
  field, optionally with a long wall) and `addTrigger(world, box)` for synthetic physics
  tests.
- `tools/tests/physics.test.mjs`: determinism (repeat runs, JSON savestates, autopilot
  savestates), feel metrics, cornering / loop / bank checks, walls, drift, landings, every
  effect, swept triggers at 1000 km/h, race rules, laps, replays, the autopilot on every
  sample, and `Sim.step` throughput.
- `tools/tests/regressions.test.mjs`: one test per audit finding fixed in the core
  (input normalisation, replay limits and claims, savestates on event ticks, canonical
  hashes, state config, slope caps, gates under stacked roads, jump and lap routes,
  checkpoint order, banks, loops, resting cars, ice, effects, editor / AI / TAS / renderer
  helpers).
