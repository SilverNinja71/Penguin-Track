# Penguintrack track format

A track is plain JSON. Official tracks live in `js/levels/`, custom ones in
`localStorage['penguintrack:tracks']`, and both travel as share codes (`PT1.…`).
Conventions (axes, `DIRS`, rotations, anchors) are defined in
[CORE_API.md §1](CORE_API.md#1-conventions).

## JSON

```js
{
  format: 1,
  id: 'A01',                         // unique per track; custom tracks use any string
  name: 'First Flakes',
  author: 'Penguintrack',
  mood: 'day',                       // 'day' | 'sunset' | 'night' | 'aurora' (sky and light)
  mode: 'race',                      // 'race' | 'platform' (fewest respawns, then time)
  laps: 1,                           // > 1 needs a StartFinish block
  medals: { author: 41230, gold: 44000, silver: 50000, bronze: 58000 },
  blocks: [ { b: 'Start', x: 6, y: 0, z: 4, r: 3, s: 'snow' }, ... ],
  decor:  [ { d: 'Pine', x: 8, y: 0, z: 7, r: 0 } ],
}
```

| field | type | default | notes |
| --- | --- | --- | --- |
| `format` | int | `1` | |
| `id` | string | `'custom'` | |
| `name` | string | `'Untitled Track'` | |
| `author` | string | `'Anonymous'` | |
| `mood` | string | `'day'` | unknown values fall back to `day` |
| `mode` | string | `'race'` | |
| `laps` | int ≥ 1 | `1` | |
| `medals` | object | all `null` | each of `author` (the **Emperor** medal), `gold`, `silver`, `bronze` is a time in ms, `null`, or (platform mode) an object of integers such as `{ respawns: 2, ms: 50000 }` |
| `blocks` | array | `[]` | **order matters**: checkpoint and finish ids are assigned in block order |
| `decor` | array | `[]` | scenery only, never collidable |

`normalizeTrack(track)` returns a copy with every field present and defaults filled in.

### Blocks

```js
{ b: 'Turn2', x: 9, y: 0, z: 11, r: 3, s: 'ice' }
```

| key | meaning |
| --- | --- |
| `b` | block id from the catalog (`BLOCKS`, see CORE_API.md §2) |
| `x, y, z` | **anchor cell** = min corner of the rotated footprint; the block fills `[x, x+W) × [y, y+H) × [z, z+D)` |
| `r` | rotation 0..3: number of right turns; local +Z (the block's forward) points along `DIRS[r]` |
| `s` | surface: `'snow'` (Packed Snow), `'powder'`, `'ice'`; default is the block's `defaultSurface` |

`[W, H, D]` is the block's `size` with X and Z swapped for odd `r` (`footprintSize`).
`x`, `y`, `z` must be integers (and `r`, when given); validation reports anything else
instead of silently truncating it. Coordinates must keep the whole footprint inside the
48 × 32 × 48 map. A block at level `y` has its deck top at `Y = 8y` metres; level-0 decks
are flush with the deep-snow ground (`Y = 0`), so cars can leave and rejoin the track
there. Elevated blocks get pillars automatically.

Blocks connect when connectors meet on a shared cell face; nothing else links them, so
two roads side by side are just neighbours. Trackmania-style jumps work by leaving a gap:
the route bridges a dangling exit (a ramp lip or an open road end) to a dangling entry up
to 8 cells ahead (at most one cell sideways), or directly in front of the exit with no gap
at all (a kicker straight onto road, a drop onto the road below). A road end cannot jump
up (at most 0.5 m higher); a ramp lip can throw the car at most one layer above its lip.
Jumps are not checked for obstacles in between, so make sure the flight path is clear;
`runAutopilot` (CORE_API §13) proves a layout by driving it.

Gate triggers reach 7 m above their deck, below a car on the next layer up, so a road may
pass over a Checkpoint or Finish one layer below without taking it.

### Decor

```js
{ d: 'Pine', x, y, z, r }
```

`d` is a renderer-defined model id (e.g. `Pine`, `Igloo`, `Snowman`); it is placed at the
centre of cell `(x, z)` on level `y`, facing `DIRS[r]`. Decor never affects physics, the
route or the track hash.

## Validation

`validateTrack(track) → { ok, errors, warnings, issues }` (`issues` are the same findings as
objects with a `code` and the block indices involved, see CORE_API §3). A playable track has:

- integer coordinates and rotations, a positive integer lap count;
- only known block ids, allowed surfaces, footprints inside the map, no overlapping footprints;
- exactly one spawn block: `Start` or `StartFinish`;
- at least one `Finish` or `StartFinish`;
- `laps > 1` only with a `StartFinish`;
- a route from the spawn through every checkpoint (in some order) to a finish line; with
  `laps > 1`, one closed lap back to the StartFinish line (a Finish arch on a lap track only
  ends the last lap and cannot replace the lap line).

Warnings (still playable): each open road end (with its block, cell and direction), a
StartFinish track with 1 lap, Finish arches on a lap track, medals out of order, decor
outside the map.

Under Thin Ice (`Fragile`) a landing harder than 20 m/s breaks the car: a kicker gap
survives, a ski jump onto flat ground does not, so put a Thaw before big jumps.

## Path builder

`trackFromPath(spec)` lays pieces end to end like a turtle, which is how the official
tracks and samples are written:

```js
trackFromPath({
  id: 'S03', name: 'Penguin Air Show', author: 'Penguintrack', mood: 'aurora', mode: 'race',
  laps: 1, medals: { ... },
  start: [10, 0, 2, 0],              // turtle cell x, y, z and heading (DIRS index)
  surface: 'snow',                   // default surface for pieces that allow it
  pieces: ['Start', 'Straight*2', 'Turbo', 'Loop', 'RampBig', 'Gap*2', 'Up', 'Straight', 'SlopeDown2', 'Finish'],
  extra: [{ b: 'Straight', x: 12, y: 0, z: 26, r: 0 }],   // explicit blocks added as-is
  decor: [{ d: 'Pine', x: 8, y: 0, z: 7 }],
});
```

The turtle stands on the cell the next piece starts in, facing its heading. Each piece
places one block so that the car enters it in the turtle's heading, then moves the turtle
to the cell after the block's exit.

Piece grammar: `Name[*count][:surface]`, e.g. `'Straight*3:ice'` (names are not case
sensitive), or an object `{ b: 'Turn2R', n: 2, s: 'powder' }`, or explicit connectors of
any block `{ b: 'Cross', entry: 2, exit: 1 }` (entry `null` = spawn blocks). Turtle
controls for branches and layouts that are not one chain:

| object piece | effect |
| --- | --- |
| `{ at: [x, y, z, dir] }` | move the turtle (no block) |
| `{ mark: 'A' }` / `{ goto: 'A' }` | remember the turtle (cell and heading) / return to it, e.g. to lay a second branch from a Cross |
| `{ d: 'Pine', side: 'left' \| 'right', dist = 1, r = 0 }` | decor `dist` cells beside the turtle cell (turtle stays) |

| piece | block | effect on the turtle |
| --- | --- | --- |
| `Start` | Start | placed on the turtle cell facing the heading |
| `StartFinish`, `Finish`, `Checkpoint`, `Straight`, `Narrow`, `Tunnel`, `Bump`, specials (`Turbo` … `Reset`) | same id | straight on |
| `Turn1L` `Turn1R` `Turn2L` `Turn2R` `Turn3L` `Turn3R` | TurnN | 90° left / right |
| `Bank2L` `Bank2R` `Bank3L` `Bank3R` | BankN | banked 90° left / right |
| `SlopeUp1` `SlopeDown1` `SlopeUp2` `SlopeDown2` | SlopeUpN | ±1 level |
| `SlopeBigUp` (`SlopeBig`) `SlopeBigDown` | SlopeBig | ±2 levels |
| `RampSmall` `RampBig` | ramps | turtle moves to the cell in front of the lip, same level as the ramp's base |
| `Loop` (`LoopR`) / `LoopL` | Loop / LoopL | loop, then one cell to the right / left |
| `Cross` `CrossL` `CrossR` | Cross | through the intersection: straight / left / right |
| `Platform` `PlatformL` `PlatformR` | Platform | across a snowfield: straight / left / right |
| `PlatformRampUp` (`PlatformRamp`) `PlatformRampDown` | PlatformRamp | ±1 level |
| `Gap*n` | — | skip `n` cells (after ramps) |
| `Up*n` / `Down*n` | — | change level without placing (for elevated landings) |
| `Left*n` / `Right*n` | — | sidestep `n` cells to the left / right, same heading |

Errors name the piece: `piece #4 'Turn1L' (Turn1) overlaps piece #0 'Start' (Start) at 1,0,1`,
`piece #1 'Straight*3' (Straight) at 1,0,-1 r2 leaves the map`, `unknown piece 'Wobble'`,
`piece #0 '{"n":2}': missing 'b'`, `no mark 'X'`, `extra #0: unknown block 'Snowplow'`.

## Share codes

`encodeTrack(track)` → `'PT1.' + base64url(bytes)` (no padding); it normalises its input like
`normalizeTrack` (integer coordinates, rotations 0..3, the lap rule). `decodeTrack(code)`
throws `Error('Corrupt track code: …')` on a bad prefix, bad characters, non-zero padding
bits, checksum mismatch, truncation or trailing bytes, so every track has exactly one code.
A 25-block track is about 380 characters.

Byte layout (varint = unsigned LEB128; zigzag = signed varint; str = varint byte length + UTF-8):

```
u8      binary version (1)
str     id, name, author
u8      mood index  (day, sunset, night, aurora)
u8      mode index  (race, platform)
varint  laps
4 ×     medal (author, gold, silver, bronze):
          u8 tag: 0 = null | 1 = varint ms | 2 = varint count, then count × (str key, varint value)
varint  block id table size, then str per id (first-use order)
varint  surface table size, then str per surface
varint  block count, then per block:
          varint id index, zigzag dx, zigzag dy, zigzag dz (delta from the previous block),
          u8 r | (surface index << 2)
varint  decor id table size, then str per id
varint  decor count, then per decor: varint id index, zigzag dx, dy, dz, u8 r
u32 LE  FNV-1a checksum of everything above
```

Block order is preserved. Fields outside this format (editor metadata and the like) are not
carried.

## Track hash

`trackHash(track)` is 16 hex characters: two FNV-1a lanes over
`v1|<laps>|<mode>;<b>,<x>,<y>,<z>,<r>,<s>;…` (blocks in order, coordinates truncated to
integers, rotations normalized to 0..3, missing surfaces resolved to the block default,
laps and mode normalized like `normalizeTrack`, so `trackHash(raw)` equals the world's hash). Replays store it and are only
offered on a track with the same hash. Name, author, mood, medals and decor do not affect
it; any change to blocks, laps or mode does.
