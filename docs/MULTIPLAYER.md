# Penguintrack multiplayer

`js/mp/` is the **Multiplayer** screen (`app.goto('mp', { view? })`): hot-seat turns,
two-player split-screen on one keyboard, and online time-attack rooms over PeerJS.
Like Trackmania, cars never collide: every rival is a ghost and the fastest time wins.

```
app.goto('mp')                       // last used tab (or the running hot-seat match / online room)
app.goto('mp', { view: 'hotseat' })  // 'hotseat' | 'split' | 'online'
```

## Files

| file | what | tested |
| --- | --- | --- |
| `mp.js` | the screen: header, three tabs, keyboard (arrows move focus, Q / E switch tabs, Esc back) | browser |
| `common.js` | stylesheet injection (`css/mp.css`), track pickers, saved preferences (`penguintrack:mp`) | browser |
| `scoring.js` | `POINTS` 10/8/6/5/4/3/2/1, `compareRuns`, `rankRuns` (ties share the better place) | Node |
| `hotseat.js` | the hot-seat match state (pure, JSON-safe) | Node |
| `hotseat-view.js` | hot-seat setup, turn card, track results, podium; drives the play screen | browser |
| `racer.js` | `Racer` (one car: Sim, Recorder, snapshots, queued respawns, result) and `Countdown` | Node |
| `splitinput.js` | P1 / P2 keyboard maps and gamepad assignment → two core Inputs | Node |
| `split-view.js` | split-screen setup, race loop, mini HUDs, results | browser |
| `protocol.js` | online wire protocol: framing, validation, room codes, name / text cleaning | Node |
| `room.js` | `RoomHost`, `RoomClient`, `PoseBuffer`, the in-memory `loopbackPair` transport | Node |
| `net.js` | PeerJS loading and DataConnection wrappers | browser |
| `online-view.js` | online entry, lobby, chat, race, round results | browser |

`node tools/test.mjs mp` runs `tools/tests/mp.test.mjs` (scoring, hot-seat, split input,
the race runner, the protocol validators and whole rooms over the loopback transport).

## Hot-seat

2–8 named players, a playlist of 1–12 tracks (any official or own track), and a turn
limit: **K attempts** (1–10) or a **driving-time budget** (1–8 minutes). On each track
every player takes one turn; the first driver rotates from track to track. After the
last turn the track is scored (best time: 10, 8, 6, 5, 4, 3, 2, 1; platform tracks
rank by respawns first; ties share the better place; no finish scores 0). After the
last track a podium and the standings (points, then wins) close the match.

A turn is a normal race on the shell's play screen (`mode: 'custom'`), so the HUD,
pause menu, results screen, replays and ghosts all work as usual. The turn card offers
the current leader's best run as a ghost, and from the second attempt on the player's
own best of the match too. The hooks it passes (see `docs/GAME.md`):

| param | used for |
| --- | --- |
| `saveRecords: false` | hot-seat runs do not touch the device's personal bests or medal gold |
| `onStart(session)` | counts the first attempt and adds the turn chip (name, attempts or time left) to `session.screenEl` |
| `onRestart(session) → false` | Backspace / Retry inside the race counts an attempt; refused when the limit is spent |
| `onFinish(result, session)` | records the run; sets `result.pbBefore` to the player's previous best of the match, so the results screen compares against it; hides Retry when the turn is spent |
| `retry: false` | results screen without Retry |
| `exitLabel: 'End turn'` | pause-menu Quit and results Back read "End turn" |
| `onExit()` | ends the turn and returns to `mp` |

The results screen's Retry starts the next attempt (a new play session; `onStart`
counts it). Driving time counts race time (`sim.timeMs` up to the finish), not menus
or countdowns. When the time budget runs out mid-run, that run still counts if it
finishes (like a server's last lap), but no new run starts. The match lives in module
scope, so it survives the trips to the play screen and back; leaving the screen keeps
it until "End match".

## Split-screen

Two players race the same track from one countdown in two viewports (top / bottom,
or left / right). Each player drives a `Racer` (own `Sim`) stepped by `app.loop` at
100 Hz; the renderer draws the world once per viewport with two chase cameras
(`r.camera` and `r.createCamera('chase', car2)`).

Each player sees the other as a **ghost**: both cars exist twice (a solid car and a
ghost car with a name label), and the viewport hook `before` (see `docs/RENDER.md`)
shows the solid car of that view's player and the ghost of the other.

| | Player 1 | Player 2 |
| --- | --- | --- |
| gas / brake | W / S | ↑ / ↓ |
| steer | A / D | ← / → |
| respawn | R | Enter |
| both | Backspace restart, Esc / P pause | |

Gamepads are assigned in index order: the first connected pad drives Player 1, the
second Player 2 (both still have their keys). Analog steering uses the dead zone and
sensitivity from Settings. Each viewport has a mini HUD (name, checkpoints / laps,
time, speed, a flash for splits against the rival at the same checkpoint and the
finish). When both have finished (or "End race" from the pause menu) the results
compare finish and checkpoint times; wins are tallied across rematches. Engine sound
follows Player 1; checkpoint and finish sounds play for both.

## Online rooms

Trackmania-server style time attack. One player **creates a room** and gets a short
code (5 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`; the PeerJS id is
`penguintrack-<code>`). Friends **join by code**. The lobby shows the code (click to
copy), the players with their points, and a chat. The host picks a track (official
tracks travel as their id; anything else, or a pasted `PT1.` share code, travels as a
share code) and a round length (2–8 minutes), then starts the round. Everyone is
pulled onto the track and races on their own with unlimited retries (auto retry
after each finish; Backspace restarts, Enter respawns). Other players are drawn as
`remote` cars with name labels from ~14 Hz pose updates; the leaderboard (top right)
shows each player's best time of the round and a check mark once the host has
verified it. When the clock runs out the round ends with points (10/8/6/…) added to
everyone's total; the host can run another round or go back to the lobby. T opens
chat while racing, Esc opens the room menu (the round clock keeps running).

PeerJS 1.5.4 is loaded on demand from `https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js`
(the same build the site's Penguin Life uses). If it cannot load, or the matchmaking
server is unreachable, the screen says so; hot-seat and split-screen work offline.

### Topology and trust

A star: the host's browser runs `RoomHost`; every player, the host included (over an
in-memory `loopbackPair`), runs a `RoomClient`. The host assigns player ids (`p1`, `p2`,
…; PeerJS ids are never shown or relayed), relays poses and chat, keeps the round clock
and the leaderboard.

Nothing from the network is trusted:

- Frames are JSON text (`serialization: 'raw'`); `decode` refuses anything over 96 kB
  before parsing, and `validateClientMsg` / `validateHostMsg` rebuild every message
  field by field (types, integer ranges, finite numbers, array lengths, string lengths,
  id and code character sets). Unknown messages and fields are dropped. Clients
  validate the host's messages the same way.
- Names (16 characters) and chat (200) lose control, bidi-override and zero-width
  characters; names are made unique. The UI only ever sets them as text.
- Per connection: a token bucket (40 messages/s, burst 80), chat at most 4 lines per
  5 s, poses relayed at most every 45 ms, 25 bad messages disconnect. Rooms hold 8.
- **Finishes are verified.** A finish carries the run's replay (inputs, tick count,
  time, respawn ticks, track hash). The host accepts it only during the round (plus a
  2.5 s grace), for the round's track hash, and only if it beats that player's best;
  it then re-simulates the replay with core `verifyReplay` and records the time only
  when the simulation reproduces it exactly. Forged times are refused with a private
  note to the sender. Verified bests can be fetched (`want` → `replay`) and are
  re-verified by the receiver before use.
- Track codes are decoded with `decodeTrack` (checksummed), their `trackHash` must match
  the round's hash, and they must build and have a route before anyone races.
- Peers that stay silent for 75 s are dropped (clients ping every 4 s; hidden tabs are
  throttled to about once a minute). Closing the room tells everyone why.

### Messages

Client → host: `hello { v, name }`, `chat { text }`, `pose { r, k, p[3], q[4], s }`
(run serial, sim tick, position in cm, quaternion to 1e-4, km/h), `idle`,
`fin { round, respawns, replay }`, `want { id }`, `ping { c }`, `bye`.

Host → client: `welcome { v, you, name }`, `reject { reason }`,
`players { list: [{ id, name, host, best, respawns, verified, pts, driving }] }`,
`chat { id, name, text } | { sys, text }`, `round { n, state: 'lobby'|'racing'|'ended',
track: { id, hash, name } | { code, hash, name }, durationMs, leftMs }`,
`pose { id, … }`, `idle { id }`, `replay { id, replay }`, `pong { c }`.

Round times travel as "time left" and every client runs its own clock from there, so
no clock sync is needed. Remote poses are smoothed by `PoseBuffer`: samples sit on the
sender's tick clock, mapped to local time with a slowly adapting offset, drawn 110 ms
in the past; a new run serial (restart) or a jump of more than 40 m snaps.

### Testing

- Node: `tools/tests/mp.test.mjs` runs complete rooms (host + clients) over the
  loopback transport: joining, unique names, full rooms and version mismatches, chat
  relay and rate limits, pose relay and throttling, flood / garbage disconnects, real
  replays verified (and forged, wrong-track and late ones refused), the round clock and
  points, timeouts and closing.
- Browser without the network: `?screen=mp&mp=local` opens a room without PeerJS and
  adds **Snowbot**, an autopilot that joins over the loopback, drives every round and
  posts verified times. `__pt.screen.room()` returns the live room
  (`{ host, client, code }`), e.g. `__pt.screen.room().host.endRound()`.
- `?autopilot=1` (with `&fast=N`) also drives the split-screen cars and your own car in
  online rounds, for headless runs.
