# Penguintrack for Python

A [gymnasium](https://gymnasium.farama.org/) environment for Penguintrack, the snowy
Trackmania-style racer. The physics runs in Node (`tools/headless.mjs`, the same
deterministic core the browser game uses); `penguintrack_env.py` spawns it and talks
JSON lines over a pipe. Full reference (observations, reward, protocol):
[`../docs/AI.md`](../docs/AI.md).

## Requirements

- Node >= 18. If `node` is not on your `PATH`, set `PENGUINTRACK_NODE=/path/to/node`.
- Python >= 3.9. The env itself needs **nothing else**: without numpy/gymnasium it
  returns `array('f')` observations and minimal `Box` / `Discrete` spaces.
- For PPO training: `pip install -r requirements.txt` (gymnasium, numpy,
  stable-baselines3, torch).

## Smoke test (zero dependencies)

```sh
cd penguintrack/python
python3 random_agent.py --track S01 --episodes 3 --replay-out /tmp/random-run.json
```

It drives a gas-happy random penguin, checks that savestates restore exactly, steps the
batched vector env and writes the best episode's replay.

## Use

```python
from penguintrack_env import PenguinTrackEnv

env = PenguinTrackEnv("S01", config={"frameSkip": 4, "maxSeconds": 60})
obs, info = env.reset(seed=1)
done = False
while not done:
    obs, reward, terminated, truncated, info = env.step(3)   # straight + gas
    done = terminated or truncated
print(info["reason"], info["progressFrac"], info["timeMs"])
replay = env.replay()          # a ghost the browser can load
state = env.get_state()        # exact savestate; env.set_state(state) restores it
env.close()
```

- `track`: an official level id (`A01`…), a dev sample (`S01`…`S06`), a `PT1.` share
  code, a track JSON dict, or a path to a track `.json`.
- `config`: `frameSkip`, `maxSeconds`, `action` (`"discrete"`: 9 actions, or
  `"continuous"`: `[steer, throttle]` in −1..1, throttle ≥ 0.5 gas, ≤ −0.5 brake),
  `startMode` (`"start"`, `"random-checkpoint"`, `"random"`), `obs` and `reward`
  overrides. See docs/AI.md for every field.
- `env.observation_names` lists what each observation index means.
- With gymnasium installed the env is also registered as `Penguintrack-v0`
  (`gym.make("Penguintrack-v0", track="S01")`).

Vector envs: `make_vec_env(track, n_envs, config, vec=...)` gives a stable-baselines3
`SubprocVecEnv` / `DummyVecEnv`, or `PenguinTrackVecEnv` (`vec="batch"`): n envs inside
one Node process stepped together with auto-reset, no dependencies.

## PPO

```sh
pip install -r requirements.txt
python3 train_ppo.py --track S01 --steps 1000000 --n-envs 8 --out models/ppo-s01
```

Saves `models/ppo-s01.zip`, then evaluates greedily from the start line and writes the
best episode to `models/ppo-s01-replay.json` (in the game: Replays → Import code →
Choose file, then Watch or Race ghost). Random
checkpoint starts (`--start-mode random-checkpoint`, the default here) help on long
tracks: episodes begin at the start or at any checkpoint the built-in autopilot
reaches, and the replay still covers the whole run from the start line.

No GPU needed: the network is tiny and the bottleneck is the simulation
(~20k env steps/s per Node process at frame skip 4, ~4k steps/s through one pipe).
