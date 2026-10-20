# Penguintrack audio

Everything you hear is synthesised with WebAudio at run time: no sound files. The
module lives in `js/audio/` and implements the audio contract of
[ARCHITECTURE.md](ARCHITECTURE.md).

| file | what |
| --- | --- |
| `audio.js` | `AudioEngine` (the public API), `buildMix()` (buses, reverb, limiter), `taper()` |
| `carvoice.js` | `carSoundParams()` (pure: car view -> synth targets, tested in Node) and `CarVoice` (the car's WebAudio graph) |
| `sfx.js` | `SFX`: every one-shot voice, `(bus, t, opts) -> endTime`; `EFFECT_SOUNDS` (pad effect -> voice) |
| `music.js` | `MusicBox`: the generative menu music |
| `synth.js` | building blocks: noise / crunch / reverb buffers, envelopes, bells, tones, noise bursts, sleigh bells |

Every voice takes a `BaseAudioContext`, so the same code plays live and renders in an
`OfflineAudioContext` (that is how it is tested, see below).

## API

```js
import { AudioEngine } from './audio/audio.js';

const a = new AudioEngine({ volume: { master, sfx, music } });   // creates nothing yet
a.autoUnlock(window);            // optional: unlock on the first pointer / key / touch
await a.unlock();                // create / resume the AudioContext; call from a user gesture
                                 // -> Promise<boolean> (true when running)
a.unlocked;                      // context exists and is running
a.available;                     // WebAudio exists (false in Node or very old browsers)

a.setVolume({ master, sfx, music });   // 0..1 each, any subset; squared to gain (0.5 is about -12 dB)
a.volume;                              // current { master, sfx, music }

a.updateCar(carView, dt, input?);      // every frame (or tick) while driving
a.stopCar();                           // fade the car out and free its nodes
a.handleEvents(sim.events, opts?);     // every tick; opts.checkpointDiff (below)
a.countdown(n);                        // 3, 2, 1: low beep (once per number, repeats are ignored)
a.go();                                // GO: high beep
a.chime('good' | 'bad' | 'neutral');   // a checkpoint chime on its own
a.ui('click' | 'hover' | 'back' | 'error' | 'medal', tier?);  // tier: 'bronze'|'silver'|'gold'|'emperor' ('author' = emperor)
a.music(on);                           // gentle generative menu loop, fades in / out
a.play(name, opts?);                   // any SFX voice by name -> duration in s (0 when dropped)
a.suspend(); a.resume();               // pause / unpause all audio (the context is suspended)
a.dispose();                           // stop everything, close the context
```

- `carView` is `sim.car` or a `snapshotCar()` / `lerpCarSnapshot()` copy. `dt` is the
  seconds since the last call. Pass `sim.lastInput` as `input` for the exact throttle;
  without it the engine uses the live car's `gasHeld`, else estimates the throttle from
  the acceleration (good enough for ghosts and replays).
- `handleEvents` accepts any array of core events (§9 of CORE_API.md). Checkpoint chimes
  can reflect the split against the best run: pass `{ checkpointDiff: ms }` or
  `{ checkpointDiff: (ev) => ms | null }` (negative = ahead -> a brighter rising chime,
  positive = behind -> a softer falling one). Core events must not be mutated, but an
  event object of your own carrying `diff` (ms) or `ahead` (bool) works as well.
- Unknown event types, effect names, UI kinds and voice names are ignored.

### Shell integration

```js
app.audio = new AudioEngine({ volume: settings.volume });
app.audio.autoUnlock(window);                  // or call app.audio.unlock() in your first click handler
// menus
app.audio.music(true);                         // remembered before the unlock, starts on it
button.onmouseenter = () => app.audio.ui('hover'); button.onclick = () => app.audio.ui('click');
// play screen
app.audio.music(false);
app.audio.countdown(3); … app.audio.go();
app.loop.start(() => {                          // 100 Hz
    sim.step(input);
    app.audio.handleEvents(sim.events, { checkpointDiff: splitFor });
}, (alpha, dt) => {
    app.audio.updateCar(snapshotCar(sim.car, snap), dt, sim.lastInput);
});
// pause: app.audio.suspend() / resume(); leaving play or results: app.audio.stopCar()
// results: app.audio.ui('medal', 'gold')
```

## Robustness

- **Unavailable or locked.** Nothing touches WebAudio before `unlock()`. Without
  WebAudio, or while the context is suspended (no gesture yet, `suspend()`, hidden page),
  every call returns at once: one-shots are dropped, never queued, so nothing bursts out
  when the context starts. Only the wish for menu music is remembered.
- **Hidden page.** On `visibilitychange` the master fades to 0, the car voice is
  released and the context is suspended; it resumes (and the music clock resyncs) when
  the page is visible again.
- **No throws.** Every value reaching an AudioParam is checked (`fin`, `clamp`), voices
  never exponential-ramp to 0, and the public methods catch and log (once) anything
  unexpected.
- **Pile-ups.** At most 28 one-shots sound at once (extra ones are dropped). Hover, click,
  wall hits (one per 70 ms unless much harder), landings, respawns, countdown beeps and
  the missing-checkpoints buzz are rate-limited.

## Mix and loudness

```
voices ─► sfxVol ──────────────┐
      └─► sfxWet ─► reverb ─► 0.5 ┤
car voice ─► car ─► sfxVol      ├─► master ─► compressor ─► trim 0.8 ─► soft clip (<0.95) ─► out
music ─► musicFade ─► musicVol ─┤
                    └─► send 0.4 ─► reverb
```

- One shared convolution reverb (a 2.2 s darkening snowy hall, generated).
- Gentle compressor (threshold -14 dB, ratio 4) for glue; a WaveShaper soft clipper,
  linear below 0.7 and asymptotic to 0.95, is the hard cap. The voices themselves are
  mixed to stay well under it (see the measured peaks below).
- Slider values are squared (an audio taper). Defaults: master 0.8, sfx 0.9, music 0.55.
- Parameter changes glide with `setTargetAtTime` (pitch 35 ms, levels 50 ms, wind 150 ms).

## The car

`carSoundParams(view, dt, state, input?, out?)` maps a car view to targets that
`CarVoice.set(params, time)` glides to:

| layer | sound | driven by |
| --- | --- | --- |
| engine | two saws an octave apart + a quiet sub sine, lowpass, soft clip, slow 6.7 Hz wobble | pitch `56 Hz · 2^(speed/290 + 0.26 · rev)` where rev is `car.rpm` within the gear, so each upshift dips ~3 semitones; 0.11 s throttle lift (quieter, darker) on upshifts; load from the throttle opens the filter and adds level; 62 % level and darker in the air |
| rumble | brown noise, bandpassed at 1.5 f0, pulsed at f0/2 | louder when coasting (burble) |
| Frozen Engine / broken Thin Ice | engine at 12 %, pitch below idle | `effects.noEngine`, `effects.broken` |
| boost whine | sine 1.5–2.8 kHz | `effects.turbo` and `turboTime` (fades with the boost; Avalanche louder and higher) |
| Snow Globe | the car's pitch drops to 0.93 / 0.86 / 0.78 | `effects.slowmo` |
| drift squeal | pink noise through two resonant bandpasses (900 / 1450 Hz, wobbling) | `car.drifting` or wheel slip > 0.5, above 20 km/h, on packed snow / powder / deep snow |
| ice hiss | white noise, 3.2 kHz band, lowpassed at 6.5 kHz | wheels on ice, speed, louder when sliding (ice never squeals) |
| powder crunch | a looped granular snow-crunch texture, playback rate following speed | wheels on powder |
| deep snow | low brown-noise rumble + the crunch texture muffled at 480 Hz | wheels on the ground |
| rolling | pink noise lowpassed at 380 Hz | packed snow / powder, speed |
| wind | pink noise, band 380 Hz–1.7 kHz rising with speed, slow gusts | speed^1.7, a little more in the air |

Surfaces are weighted by the wheels in contact (`wheels[i].contact/surface/slip`), falling
back to `surfaceUnder`. In the air every tyre layer is silent.

## Sound list

| trigger | voice | design |
| --- | --- | --- |
| `checkpoint` | `checkpoint` | two handbell notes A5 -> D6; `good`: D6 -> A6 (+ D7 sparkle), `bad`: A5 -> F5, softer |
| `lap` | `lap` | D6 F#6 A6 D7 bell arpeggio + short sleigh bells |
| `finish` | `finish` | rising bell run, timpani thump, brassy D major chord, bell chord, 1.6 s sleigh-bell shimmer |
| `countdown(n)` / `go()` | `countdown`, `go` | A4 triangle beep (soft edges) / A5, longer, with a bell sparkle |
| `respawn` | `respawn` | pink-noise swoosh sweeping 2.6 kHz -> 450 Hz + falling sine + soft bell |
| `fall` | `fall` | cartoon slide whistle down |
| `boost` level 1 / 2 | `boost` | Frost: noise whoosh 400 Hz -> 3 kHz, rising whistle, light thump; Avalanche: wider (250 Hz -> 4.2 kHz), longer, a low snow rumble and two whistles |
| `effect` noEngine / noSteer / noBrake | `frozen` (pitch 0.8 / 1 / 1.2) | descending icy glide with crystal bells and frost crackle |
| `effect` reset | `thaw` | warm rising fifths into a bell |
| `effect` slowmo | `globe` | dreamy falling music-box line over a low swell |
| `effect` cruise | `glide` | airy whistle settling on a fifth |
| `effect` fragile | `thinIce` | delicate glassy creak |
| `effect` turbo / turbo2 | — | sounds through its `boost` event |
| `land` | `land` | pitch-dropping thump + snow puff, scaled by `strength`; a crunch above ~8 m/s; ignored below 1.2 m/s |
| `wallhit` | `wallhit` | crack + crunch texture + thud + ice shards, scaled by `intensity`, panned to the side of the hit |
| `fragileBreak` | `fragileBreak` | sharp crack, falling glass shards, a descending shard tone |
| `missingCheckpoints` | `missing` | two soft low lowpassed buzzes |
| `ui('click' / 'hover' / 'back' / 'error')` | same names | ice tick / a very quiet tick / two falling blips / a softer double buzz |
| `ui('medal', tier)` | `medal` | bronze: 3-note arpeggio; silver: 4 + sleigh bells; gold: 6-note run, bell chord, shimmer; emperor: an 11-note pentatonic run, thump, brass chord, long bell chord, high twinkles and 1.8 s of sleigh bells |

## Menu music

`MusicBox` (seeded `Rng`) plays D major pentatonic at 72 bpm in 8th-note steps: a
four-chord loop (Dadd9, Bm7, Gmaj7, Asus2, two bars each) on a soft detuned-triangle pad,
a gentle bass at each chord, and a sparse music-box melody (random walk on the scale, bar
starts lean on chord tones, an occasional grace note). Melody density changes per 27 s
loop (0.1–0.36 notes per step: sometimes almost silent), a shaker whispers on the
off-beats of every other loop, and loops sometimes open with a wind-chime glissando. It
is scheduled 0.35 s ahead of the AudioContext clock by a 60 ms pump; after a stall the
clock skips ahead instead of bursting the missed notes. Fade in ~2.5 s, out ~1 s.

## Testing

- `node tools/test.mjs audio` (`tools/tests/audio.test.mjs`): the car mapping on autopilot
  drives of every sample (finite, in range, tyres silent in the air, wind, boost, ice and
  powder where expected), the gearbox (five upshifts, each a 3.1-semitone dip, top pitch
  2.15x idle), throttle load and its estimate, drift squeal / ice hiss / deep snow /
  powder on flat worlds, Frozen Engine and boosts, garbage input; then every voice, the
  music and the whole engine (a full S03 race, every event type, UI, voice cap,
  suspend / resume, dispose) against a strict WebAudio mock that throws wherever
  browsers throw; a locked context (resume refused) that must schedule nothing; split
  chimes, gated countdown and prototype-name lookups.
- `dev/audio-demo.html`: buttons for every sound, volume sliders, a manual car (speed,
  rpm, gear, slip, surface, drift, air, boost, Frozen Engine, Snow Globe) and **Drive sim**,
  which runs the core `Sim` with the `Autopilot` in real time (countdown first) and feeds
  `updateCar` and `handleEvents`, with a minimap and event log.
- `dev/audio-demo.html?check=1` (optionally `&filter=car&w=900&h=260`) renders every voice
  variant, four synthetic car drives (each surface, slides), two real autopilot drives
  with their events (S03, S05) and 40 s of music twice, with `OfflineAudioContext`, both
  raw and through the full mix at full volume, and asserts: no NaN, raw peak < 0.9, mix
  peak < 0.95, loudness in range (loudest 50 ms window for one-shots, RMS otherwise),
  silence at the end of every one-shot, no DC; plus relations (hover << click, Avalanche >
  Frost, landings and wall hits scale, medals grow, GO above the beeps, music under the
  car). Each row draws the waveform and a log-frequency spectrogram. Results land in
  `window.__audioCheck`. Last run: all 41 renders and 7 relations pass; loudest raw peak
  0.59 (emperor medal), car RMS 0.07–0.09, music RMS 0.044.

## Adding a sound

Add a voice to `SFX` in `sfx.js` (`(bus, t, opts) => endTime`, built from `synth.js`
helpers, peaking around 0.2–0.5), map its trigger in `AudioEngine._event` or call it
with `a.play(name)`, then add a case to `checkCases()` in `dev/audio-check.js`.
