# Penguintrack track editor

A Trackmania-style block editor (`app.goto('editor', params)`). Build on the
48 × 32 × 48 grid with a live 3D preview, snap blocks onto open road ends, test
drive and validate, then save to My Tracks or share a `PT1.` code.

## Files

| file | what |
| --- | --- |
| `js/editor/editor.js` | the screen (`{ id, enter, exit, back }`), `EditorSession`: DOM, input, world rebuilds, dialogs, test drive / validation, save / load / share |
| `js/editor/model.js` | pure (Node-tested) document: `EditorDoc` with undo history, fit / overlap checks, connector snapping, validation runs and medals |
| `js/editor/view3d.js` | `EditorView`: three.js overlays on the shared renderer (grid, cursor, ghost block, open-end arrows, hover box) and the orbit / top camera |
| `js/editor/thumbs.js` | palette thumbnails: top-down SVGs generated from the core block geometry, decor icons |
| `css/editor.css` | styles (loaded once through `loadModuleCss` in js/game/dom.js as `<link data-pt-css="editor">`) |
| `tools/tests/editor.test.mjs` | model and thumbnail tests (`node tools/test.mjs editor`) |

## Params

| param | effect |
| --- | --- |
| `{}` | reopens the autosaved draft (storage `editor`), else a new track |
| `{ track }` | edits a track (object or id). A track in storage `tracks` opens as saved (with its validation); an official or sample id opens as a copy with a fresh id |
| `{ resume: true }` | returns from a test drive with the exact state: document, undo history, camera, layer, selection |

## Building

- **Cursor.** The mouse picks the grid cell on the plane of the current layer.
  A block is placed so the cell of its *entry* (connector 0; a Start's own cell)
  is under the cursor, so "the car drives in here" whatever the block's size.
  Arrow keys / WASD move the cursor cell by cell (relative to the view) and the
  camera follows it.
- **Ghost.** A translucent copy of the block (core `blockPreview`, cached per
  block, rotation and surface) with its footprint box: green when it fits, red
  when it overlaps a block or leaves the map (the hint bar says which).
- **Snapping** (on by default, `G`). Blue arrows mark open road ends, gold ones
  ramp lips. With the cursor on the cell in front of an open end (any layer up
  to two away), the block snaps on through core `placeByConnector`, facing the
  right way; `R` cycles the variants (a turn left or right, a slope up or down;
  symmetric blocks have one). After a snapped placement the layer follows the
  block's exit, so a slope up moves building to the next layer.
- **Keyboard chaining.** `Space` / `Enter` places at the cursor and moves it to
  where the new block ends, so a whole track can be laid with the keyboard.
- A second Start (or Lap Igloo) replaces the old one: a track has one spawn.
- **Decor** (`B` or the Decor tab): Pine, PineCluster, Igloo, Snowman,
  PenguinCrowd, Penguin, IceCrystal, Rock, Banner, Lamp, one per cell, never
  inside a block; `R` turns crowds and banners.
- **Undo / redo**: every edit (blocks, decor, properties) is one step; up to
  2000 steps, kept across test drives.

## Controls

| action | mouse | keys |
| --- | --- | --- |
| place | left click | Space / Enter |
| delete | right click | Delete / Backspace / X |
| pick block (eyedropper) | middle click, Alt+click | C |
| rotate (cycles snapped variants) | Shift+wheel | R / Shift+R |
| layer up / down | | E / Q, PageUp / PageDown |
| move cursor / pan | middle-drag pans | WASD / arrows |
| orbit / zoom | left- or right-drag / wheel | |
| top view / frame the track | | V / F |
| surface Packed Snow / Powder / Ice | | 1 / 2 / 3 |
| previous / next block | | [ / ] |
| blocks / decor | | B |
| snapping on / off | | G |
| undo / redo | | Ctrl+Z / Ctrl+Y (Ctrl+Shift+Z) |
| save | | Ctrl+S |
| test drive | | T |
| guide overlay | | H / ? / F1 |
| back to the menu (draft kept) | | Esc |

A click that drags more than 5 px orbits instead of placing. Mouse clicks on panel
buttons drop focus, so Space keeps placing blocks; keyboard users Tab through the
panels as usual (arrows on a focused button are left to the browser).

## Live checks

The world is rebuilt with `buildWorld` and `renderer.loadWorld(world, track,
{ scenery: false })` at most every 140 ms after a change. Blocks named by error
issues (overlaps, unreachable checkpoints, …) pulse red (`setTrackHighlight`). The
status panel shows the validation state and medals, block / decor / checkpoint
counts, the route length, and the issues (errors first; open road ends are listed
from the document's connectors since `buildWorld` leaves them to `validateTrack`).
Clicking an issue moves the cursor and camera to it.

## Validation and medals

Trackmania rules: a track is **validated** only when its *current layout*
(`trackHash`: blocks, laps, mode) has a finished run. Every finished test drive
(`app.goto('play', { track, mode: 'test', onFinish, onExit })`) and the
**Autopilot** button (core `runAutopilot`, recorded) count; the best run per layout
is kept (`EditorDoc.validations[hash]`), so undoing an edit brings its validation
back. Renaming or changing the mood keeps it; any block, lap or mode change needs a
new run. Medals come from the best run, with the bake formulas:

| mode | Emperor | Gold | Silver | Bronze |
| --- | --- | --- | --- | --- |
| race | author time | `ceil(author × 1.06 / 100 ms) × 100 ms` | `ceil(author × 1.2 / 1 s) × 1 s` | `ceil(author × 1.5 / 1 s) × 1 s` |
| platform, clean run | author ms, 0 respawns | 0 respawns | ≤ 3 | ≤ 10 |
| platform, run with *r* respawns | `{ respawns: r, ms }` | ≤ r | ≤ r + 3 | ≤ r + 10 |

An unvalidated track saves and shares with all medals `null`.

## Storage

| key | contents |
| --- | --- |
| `tracks[id]` | the track JSON (medals as above) plus `updated` (ms) and, when validated, `validation: { hash, timeMs, respawns, by: 'driver'\|'autopilot', date, replay }` |
| `editor` | the autosaved draft `{ doc: { track, validations, savedId, savedSnap }, date }`, written 0.7 s after each change and on exit (only the current layout's validation keeps its replay) |

Saving uses the track's id (official / sample ids get a fresh `c…` id). The Open
dialog lists My Tracks, copies any official track (fresh id, medals cleared) and
pastes `PT1.` codes. Leaving with unsaved changes keeps them in the draft; opening
another track over a dirty draft asks first.

## Shell hooks used

- `play` params `onFinish(result)` (called on the finish tick, added to race.js
  with the multiplayer work) and `onExit(result | null)`.
- `#ui > *` re-enables pointer events with id specificity, so `css/editor.css`
  sets `#ui > .ed-screen { pointer-events: none }` itself for the canvas to get
  the mouse between the panels.
- The renderer's camera rig is disabled (`cameraControls.enabled = false`) while
  the editor drives the camera, and re-enabled on exit.

## Testing

`node tools/test.mjs editor`: placement anchors at every rotation, fit and map
edges, snapping variants, the Start rule, full undo / redo, decor, medal formulas
against the official bake, validation by layout hash (edit, undo, stored form,
share codes), draft round trips, official copies, thumbnails.

Checked in headless Chrome (SwiftShader) at 1280×720 and 1024×600: building a
12-block track with mouse clicks and keyboard chaining (bend flipped with R,
slope up to layer 1 and back down), autopilot test drive → results → Back to
editor → validated with medals, Ctrl+S, My Tracks → Edit reopens it validated
and clean; manual test drive → pause → Back to editor (history kept); Esc → menu
→ Editor restores the draft; Open → copy of A03; decor, middle-click eyedropper,
right-click delete, Ctrl+Z; properties (name, night mood); share code.
