# Penguintrack renderer

`js/render/` draws a core `World` with Three.js r185: a snowy Trackmania. It never
touches the simulation. Callers feed it car snapshots (`snapshotCar`) and sim events,
once per animation frame. The binding contract is the "Renderer contract" section of
[ARCHITECTURE.md](ARCHITECTURE.md). This file documents the full API and the art.

```js
import { GameRenderer } from './render/renderer.js';

const r = new GameRenderer(canvas, { quality: 'medium', reducedMotion: false });
r.loadWorld(world, track);                     // track.mood picks the sky
const car = r.addCar({ kind: 'player' });
r.setCameraMode('chase', car);

let prev = r.snapshotCar(sim.car), cur = r.snapshotCar(sim.car);
// each tick:  r.snapshotCar(sim.car, prev) ... sim.step(input); r.snapshotCar(sim.car, cur);
//             r.handleEvents(sim.events, car);
// each frame: car.setPose(prev, cur, alpha); r.render(dt);
```

`dev/render-demo.html` runs a whole race this way (see the end of this file).

## Files

| file | contents |
| --- | --- |
| `renderer.js` | `GameRenderer`, car handles, viewports, picking, stats |
| `trackmesh.js` | track meshes from `world.render.meshes`, materials, block highlights |
| `textures.js` | procedural canvas textures (cached for the page), effect colours |
| `environment.js` | `MOODS`, sky dome shader (sun, moon, stars, clouds, aurora), fog, lights, shadow camera, reflection map |
| `cameras.js` | `CameraRig`: chase, close, cockpit, free, orbit, top |
| `carmodel.js` | the penguin snow racer |
| `scenery.js` | terrain, mountains, instanced scenery, crowds, lamps, gates, pillars, pad icons, decor |
| `props.js` | gate, pillar, pad icon and banner builders |
| `models.js` | low-poly vertex-coloured models (pine, rock, crystal, igloo, snowman, penguin, lamp, mountain) |
| `layout.js` | pure, seeded placement of the automatic scenery and the terrain height (no three.js; Node-tested) |
| `effects.js` | falling snow, particles, skid marks, rings, respawn flash, headlights |

## API

### `new GameRenderer(canvas, opts)`

| opt | default | |
| --- | --- | --- |
| `quality` | `'medium'` | `'low' \| 'medium' \| 'high'` (table below) |
| `reducedMotion` | `false` | no camera shake, no FOV widening, no respawn flash, calm crowds, slower snowfall |
| `preserveDrawingBuffer` | `false` | for screenshots / thumbnails |
| `pixelRatio` | by quality | overrides the device pixel ratio cap |

Escape hatches: `r.scene`, `r.camera` (the main `PerspectiveCamera`), `r.three` (the
`THREE` namespace), `r.webgl` (`WebGLRenderer`), `r.world`, `r.env`, `r.effects`,
`r.scenery`, `r.track`. Constants: `QUALITIES`, `CAMERA_MODES` (renderer.js),
`MOODS`, `MOOD_IDS` (environment.js).

### World

| call | |
| --- | --- |
| `loadWorld(world, track = world.track, opts = {})` | builds everything; `track.mood` sets the mood. `opts.scenery = false` skips the automatic scatter (trees, crowds, night lamps) for fast editor rebuilds; decor, gates, pillars and the landscape stay. Rebuilding with the same mood reuses the reflection map, so a rebuild costs roughly 10–40 ms. |
| `clearWorld()` | drops the world (cars stay) |
| `setMood(mood)` | `'day' \| 'sunset' \| 'night' \| 'aurora'`; unknown values fall back to day |
| `setQuality(q)` | switches quality live (rebuilds the world meshes) |
| `setReducedMotion(bool)` | live |
| `setCountdown(n)` | start gate lights: `3`, `2`, `1` fill up red, `0` all green (GO), `null` idle green |
| `get mood`, `get cameraMode` | current values |

### Cars

`addCar({ kind = 'player', color, label })` returns a handle:

| member | |
| --- | --- |
| `setPose(prev, curr, alpha)` | draws between two snapshots (`snapshotCar` / `lerpCarSnapshot` from core). `setPose(view)` or `setPose(v, v, 1)` draws one view as is, so `ghostPoseAt` poses work too (`pos`, `quat`, optional `wheels`, `speedKmh`, `effects`). A jump of more than 12 m between ticks counts as a teleport (respawn): it is drawn without blending, cameras snap behind the car, and skid marks and trails restart. |
| `setVisible(bool)`, `setColor(c)`, `setLabel(text, color?)` | |
| `teleported()` | force the snap (the renderer also calls it on a `respawn` event) |
| `object` | the `THREE.Group` (position/quaternion = the drawn pose) |
| `view` | the interpolated snapshot drawn this frame |
| `kind`, `color`, `teleportSerial` | |

Kinds: `player` (red #d61f2c by default, white racing stripes, casts shadows, owns the
night headlight spot), `ai` (tinted by `color`), `remote` (green by default, name label
sprite), `ghost` (translucent pale blue, no shadow, no particles). `removeCar(handle)`.

### Cameras

`setCameraMode(mode, targetCar, camera = r.camera)`; modes:

| mode | |
| --- | --- |
| `chase` | TM cam 1: 6.3 m behind and 2.35 m above, looks 4.5 m ahead. It smooths its **direction** (not its position), so it never falls behind at 290 km/h; it follows the velocity partly in drifts, stays level on flat roads and gentle banks, and rolls with the car through loops. FOV widens with speed (70° up to ~89°, +4° on a boost). |
| `close` | low and near (4.3 m / 1.5 m) |
| `cockpit` | the driver's eyes (the driver model is hidden), follows the car fully |
| `free` | fly: WASD / arrows move, Q/E (Ctrl/Space) down/up, Shift ×4, right-drag looks, wheel changes speed. Keys are only listened to while this mode is active (and never from inputs/textareas). |
| `orbit` | left-drag orbits, right/shift-drag pans, wheel zooms; follows the target car unless panned or given a point |
| `top` | straight down (editor): right/middle-drag pans, wheel zooms |

`r.cameraControls` is the main camera's `CameraRig`:

```js
r.cameraControls.enabled = false;              // the rig never moves r.camera (drive it yourself)
r.cameraControls.setOrbit({ target: [x, y, z], distance, yaw, pitch }); // a point: stops following the car
r.cameraControls.setFree({ position: [x, y, z], yaw, pitch });
r.cameraControls.setTop({ center: [x, z] | [x, y, z], height });
r.cameraControls.snap();                       // jump to the target pose next frame
r.cameraControls.speed = 40;                   // free-fly m/s
r.cameraControls.orbit / .free / .top          // live state objects
```

`loadWorld` points the orbit target at the spawn and fits the top view to the track.

### Split-screen

```js
const cam2 = r.createCamera('chase', car2);    // a camera with its own rig
r.setViewports([{ x: 0, y: 0, w: 0.5, h: 1, camera: r.camera }, { x: 0.5, y: 0, w: 0.5, h: 1, camera: cam2 }]);
r.setCameraMode('close', car2, cam2);          // change a created camera's mode
r.setViewports(null);                          // back to one view
r.removeCamera(cam2);
```

Rects are normalised 0..1 from the canvas' top-left corner. Every rig updates once per
frame with its viewport's aspect ratio.

### Events

`handleEvents(sim.events, car)`:

| event | effect |
| --- | --- |
| `checkpoint` | cyan pulse ring through the car, glints |
| `lap` | gold ring |
| `finish` | gold ring and a confetti-snow shower |
| `boost` | burst in Frost (cyan) / Avalanche (magenta) colours; the exhaust trail runs while `effects.turbo` is on |
| `effect` | burst in the pad's colour (non-boost pads) |
| `land` | snow puff scaled by `strength`, camera shake |
| `wallhit` | ice shards at `pos`, small shake |
| `fragileBreak` | a shower of shards |
| `respawn` | white-blue screen flash, sparkle burst at the new place, camera snap |

Continuous effects come from the car views: snow spray from the wheels (heavy on powder
and deep snow, light on packed snow unless sliding), ice glints, skid ribbons (rear
wheels while drifting or slipping; blue-grey ruts on snow, tan on powder, white
scratches on ice; they fade after ~8 s), the boost trail, falling snow that blows toward
the camera faster as the car speeds up.

### Frame

| call | |
| --- | --- |
| `render(dt)` | once per animation frame: `update(dt)` then draw every viewport |
| `update(dt)` | advance cars, cameras, sky, scenery and effects without drawing (deterministic warm-ups, tests) |
| `resize()` | after the canvas size changes |
| `stats()` | last frame: `{ drawCalls, triangles, points, lines, geometries, textures, frameMs, fps, cars, quality, mood, camera }` |
| `dispose()` | frees everything (shared textures stay cached for the page) |

### Editor helpers

| call | |
| --- | --- |
| `pick(clientX, clientY, maxDist = 6000)` | `world.collision.raycast` under a screen point: `{ point, normal, blockIndex (-1 = ground), surface, distance }` or `null` (works per viewport) |
| `screenRay(clientX, clientY)` | `{ origin, dir }` (unit) for your own plane picks, or `null` outside the canvas |
| `setTrackHighlight(index \| [indices] \| null, color = 0x7fdcff)` | pulsing additive overlay on those blocks, built from `render.meshes[].ranges` (no geometry copy) |

## Art notes

**Look.** Bright, readable, low-poly. Neutral tone mapping (`THREE.NeutralToneMapping`)
keeps the whites white and the team colours saturated; the sky shader writes sRGB
directly and its horizon is exactly the fog colour, so far terrain melts into it.

**Track materials** (`world.render.meshes`, one draw each):

| material | look |
| --- | --- |
| `road_snow` | compacted white-blue snow, faint tyre grooves, blue edge bands with a thin white line, light-blue centre dashes (4 m on, 4 m off: a speed cue) |
| `road_powder` | cream fresh snow with wind ripples and sparkles, amber markings |
| `road_ice` | glossy blue (roughness 0.32, sky reflections) with white and deep-blue cracks, white markings |
| `platform_*` | same surfaces in 8 m tiles with snowflake studs |
| `Cross` decks | split out of `road_*` by block ranges and drawn as tiles (lane stripes would cut across the side openings) |
| markings at night | an emissive companion texture makes the lane markings glow (`roadGlow` per mood) |
| `border` | soft white snowbanks (normals bent toward the sky so they read as mounds) |
| `border` on gate blocks | blue / white candy stripes (split out by block ranges) |
| `wall` | packed ice-blue blocks (deck sides, undersides, pillars use stacked ice/stone) |
| `roof_ice` | translucent tunnel ice |
| `line_start / finish / checkpoint` | cyan-white dashes, checkers, glowing cyan bar |
| `pad_<effect>` | glowing decals with chevrons (boosts, Glide) or the effect icon, breathing emissive |
| `ground` | soft deep snow, 128 m tile, low contrast (polygon offset under level-0 decks) |

Pads and icons use the effect colours in `textures.js` `EFFECT_COLORS`: Frost Boost cyan,
Avalanche Boost magenta-red, Frozen Engine grey-blue, Frozen Wheel purple, Brake Freeze
orange, Snow Globe violet, Glide green, Thin Ice pale, Thaw warm yellow. A floating
icon bobs over every pad (one draw for all, from an atlas; it fades as you drive under).

**Gates.** Start: an igloo arch of ice blocks with a *PENGUINTRACK* banner and five
countdown lights. Finish: ice-block posts, a navy beam with a checkered *FINISH*
banner and pennants. Checkpoint: a glowing cyan ice arch with a halo, crystal feet and
a *CHECKPOINT* banner. StartFinish: the igloo arch with a checkered *LAP* banner.

**Decor** (`track.decor`): `Pine`, `PineCluster` (5 pines), `Igloo`, `Snowman`,
`IceCrystal` (`Crystal`), `Rock`, `PenguinCrowd` (3 rows of 7 on the road side of the
cell, facing `DIRS[r]`), `Penguin`, `Banner` (faces `DIRS[r]`), `Lamp`. Unknown ids draw
a pine.

**Automatic scenery** (`layout.js`, seeded by `world.hash`): on map cells whose column
has no block in the lowest four layers and that the route never crosses (jump gaps
stay clear), keeping off decor cells. Next to the road only small pines, rocks and
crystals, pushed away from the road; further out pines, groups, igloos, crystals and
snowmen, thickening into forest. Penguin crowds stand beside level-0 gates facing the
road (hopping, waddling). Night and aurora add lamps every ~90 m of flat road with
warm light pools. Beyond the map: rolling snow hills, a forest belt and a ring of 22
low-poly mountains with snow above a ragged snow line. Tracks with more than 25 decor
items (the official levels) get a thinner automatic scatter.

**Moods**

| mood | sky | light | extras |
| --- | --- | --- | --- |
| day | deep blue to pale horizon, sun disc, clouds | warm sun 3.1, cool hemisphere | |
| sunset | indigo → pink → peach, low orange sun | orange sun, pink fill | lamps glow softly, clouds lit |
| night | navy, twinkling stars, moon | cool moonlight | lamps, light pools, glowing road markings, headlights |
| aurora | night with green / violet animated curtains | teal moonlight | as night, crystals glow |

**The car** is a stubby bobsled hull (team paint, two white racing stripes, navy skirt),
a rear wing, cycle fenders over the front wheels that steer with them, chunky tyres with
snow chains (their links make the spin readable), white hubs, head and tail lights and
twin exhausts that glow on a boost. The penguin driver wears blue goggles, a team
beanie and a red scarf whose tails stream back and flap faster with speed; the steering
wheel turns with the input. Wheels steer, spin and compress from `view.wheels`.

## Quality and performance

| | low | medium | high |
| --- | --- | --- | --- |
| pixel ratio cap | 1 | 1.25 | 2 |
| antialias | no | yes | yes |
| shadows | none | 1024², ±55 m around the focus car | 2048², ±70 m |
| scenery density | 0.45 | 0.8 | 1 |
| crowds | half | full | full |
| falling snow / particles / skid quads | 1200 / 900 / 500 | 3000 / 2200 / 1200 | 6000 / 3600 / 2000 |
| anisotropy | 2 | 8 | 16 |

Everything static is merged per material (track, gates, pillars, terrain, mountains) or
instanced in 384 m chunks (pines, rocks, crystals, igloos, snowmen) so frustum culling
works; the car is ~20 draws. Measured with `r.stats()` in the demo (medium, 1280×720,
chase cam, shadow pass included): sample tracks 90–160 draws and 160–260 k triangles;
the 78-block official E05 about 160–200 draws and ~300 k triangles. Draw calls scale
with gates and scenery chunks, not with block count; a 150-block track lands around
200–250 draws. On low, the same views run at ~80 draws and ~90 k triangles.

## Dev page

`dev/render-demo.html?track=S01..S06|<level id>&mood=&cam=&quality=&t=<s>&reduced=1&split=1&ghost=1|rival=ai|remote`

It drives the core `Autopilot` on a fixed 100 Hz loop and renders with the chase cam.
With `t` it simulates to `t` seconds (the last second frame by frame, so effects and
cameras are warm), draws one frame and pauses: screenshots are repeatable. Keys: 1–6
cameras, M mood, Q quality, P pause, R restart, H highlight a block. It sets
`window.__demo = { ready, frames, renderer, sim, world, track, car }`.

## Tests

`node tools/test.mjs render` (`tools/tests/render.test.mjs`): the layout is deterministic
and keeps clear of roads, jump gaps and decor; crowds and lamps sit where they should;
the terrain is flat on the map; model triangle budgets; mountains face up; the chase
camera sits behind/above, snaps on teleports and rolls through loops; renderer.js links
and exposes the contract. The three.js parts load `vendor/` through a `module.registerHooks`
resolver (Node ≥ 22.15; older Node skips them).
