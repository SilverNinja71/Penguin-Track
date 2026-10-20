"""Gymnasium environment for Penguintrack, the snowy time-attack racer.

The simulation runs in Node: this module spawns ``tools/headless.mjs`` and
speaks its JSON-lines protocol (docs/AI.md). Works with gymnasium and numpy
when they are installed and falls back to tiny compatible stand-ins when they
are not, so the zero-dependency smoke test (random_agent.py) runs anywhere.

    from penguintrack_env import PenguinTrackEnv
    env = PenguinTrackEnv("S01", config={"frameSkip": 4, "maxSeconds": 60})
    obs, info = env.reset(seed=1)
    obs, reward, terminated, truncated, info = env.step(3)   # straight + gas

Set PENGUINTRACK_NODE to the node binary if ``node`` is not on PATH.
"""

from __future__ import annotations

import array
import base64
import json
import os
import random
import shutil
import subprocess
import sys
from pathlib import Path

try:  # optional
    import numpy as np
except ImportError:  # pragma: no cover - exercised by the zero-dep smoke test
    np = None

try:  # optional
    import gymnasium as gym
    from gymnasium import spaces as gym_spaces
except ImportError:  # pragma: no cover
    gym = None
    gym_spaces = None

ROOT = Path(__file__).resolve().parent.parent
HEADLESS = ROOT / "tools" / "headless.mjs"

# Discrete action table (core input ACTIONS): index = steer * 3 + throttle.
ACTION_NAMES = [
    "left+gas", "left+coast", "left+brake",
    "straight+gas", "straight+coast", "straight+brake",
    "right+gas", "right+coast", "right+brake",
]


class PenguintrackError(RuntimeError):
    """The env server replied with an error (or died)."""


def node_binary() -> str:
    """Node executable: $PENGUINTRACK_NODE, else `node` on PATH."""
    return os.environ.get("PENGUINTRACK_NODE") or shutil.which("node") or "node"


class HeadlessClient:
    """One `node tools/headless.mjs` process and its request/reply pipe."""

    def __init__(self, node: str | None = None, script: str | os.PathLike | None = None):
        cmd = [node or node_binary(), str(script or HEADLESS)]
        try:
            self.proc = subprocess.Popen(
                cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=None,
                text=True, encoding="utf-8", bufsize=1, cwd=str(ROOT),
            )
        except FileNotFoundError as e:
            raise PenguintrackError(
                f"Cannot start {cmd[0]!r}: install Node >= 18 or set PENGUINTRACK_NODE"
            ) from e

    def call(self, cmd: str, **fields) -> dict:
        if self.proc.poll() is not None:
            raise PenguintrackError(f"env server exited with code {self.proc.returncode}")
        msg = {"cmd": cmd}
        msg.update(fields)
        self.proc.stdin.write(json.dumps(msg, separators=(",", ":")) + "\n")
        self.proc.stdin.flush()
        line = self.proc.stdout.readline()
        if not line:
            raise PenguintrackError(f"env server closed the pipe during {cmd!r}")
        reply = json.loads(line)
        if not reply.get("ok"):
            raise PenguintrackError(reply.get("error", "unknown error"))
        return reply

    def close(self) -> None:
        if self.proc.poll() is None:
            try:
                self.call("close")
            except (PenguintrackError, OSError, ValueError):
                pass
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()


# ---------------------------------------------------------------------------
# Spaces: gymnasium's when available, minimal stand-ins otherwise.

class Box:
    """Minimal stand-in for gymnasium.spaces.Box."""

    def __init__(self, low, high, shape, dtype="float32"):
        self.low = list(low)
        self.high = list(high)
        self.shape = tuple(shape)
        self.dtype = dtype

    def sample(self):
        return [random.uniform(lo, hi) for lo, hi in zip(self.low, self.high)]

    def contains(self, x) -> bool:
        return len(x) == self.shape[0] and all(lo <= v <= hi for v, lo, hi in zip(x, self.low, self.high))

    def __repr__(self):
        return f"Box({self.shape}, {self.dtype})"


class Discrete:
    """Minimal stand-in for gymnasium.spaces.Discrete."""

    def __init__(self, n: int):
        self.n = n
        self.shape = ()

    def sample(self) -> int:
        return random.randrange(self.n)

    def contains(self, x) -> bool:
        return isinstance(x, int) and 0 <= x < self.n

    def __repr__(self):
        return f"Discrete({self.n})"


def _make_space(spec: dict):
    if spec["type"] == "discrete":
        return gym_spaces.Discrete(spec["n"]) if gym_spaces else Discrete(spec["n"])
    if gym_spaces and np is not None:
        return gym_spaces.Box(
            low=np.asarray(spec["low"], dtype=np.float32),
            high=np.asarray(spec["high"], dtype=np.float32),
            dtype=np.float32,
        )
    return Box(spec["low"], spec["high"], spec["shape"])


def decode_obs(data):
    """Observation from the wire: base64 float32 (default) or a number list."""
    if isinstance(data, list):
        return np.asarray(data, dtype=np.float32) if np is not None else data
    raw = base64.b64decode(data)
    if np is not None:
        return np.frombuffer(raw, dtype="<f4").copy()
    arr = array.array("f")
    arr.frombytes(raw)
    if sys.byteorder == "big":
        arr.byteswap()
    return arr


def encode_action(action):
    """numpy scalars / arrays -> JSON (an int for discrete, [steer, throttle] for continuous)."""
    if np is not None and isinstance(action, np.ndarray):
        if action.ndim == 0 or action.size == 1:
            value = action.reshape(-1)[0]
            return int(value) if np.issubdtype(action.dtype, np.integer) else float(value)
        return [float(v) for v in action.reshape(-1)]
    if np is not None and isinstance(action, np.generic):
        return action.item()
    if isinstance(action, (list, tuple, array.array)):
        return [float(v) for v in action]
    return action


_Base = gym.Env if gym is not None else object


class PenguinTrackEnv(_Base):
    """gymnasium.Env over one headless env server.

    track:   level id (T01), sample id (S01..S06), PT1. share code, track JSON
             dict, or a path to a track .json file.
    config:  PenguinEnv config (frameSkip, maxSeconds, action, startMode,
             obs {...}, reward {...}); see docs/AI.md.
    """

    metadata = {"render_modes": []}

    def __init__(self, track="S01", config: dict | None = None, node: str | None = None,
                 obs_encoding: str = "b64", render_mode=None):
        self.client = HeadlessClient(node)
        spec = self.client.call("make", track=track, config=config or {}, obs_encoding=obs_encoding)
        self.spec_reply = spec
        self.track_info = spec["track"]
        self.env_config = spec["env_config"]
        self.observation_names = spec["observation_space"]["names"]
        self.observation_space = _make_space(spec["observation_space"])
        self.action_space = _make_space(spec["action_space"])
        self.render_mode = render_mode
        self.last_info: dict = {}

    def reset(self, *, seed: int | None = None, options: dict | None = None):
        if gym is not None:
            super().reset(seed=seed)
        reply = self.client.call("reset", seed=seed)
        self.last_info = reply["info"]
        return decode_obs(reply["obs"]), reply["info"]

    def step(self, action):
        reply = self.client.call("step", action=encode_action(action))
        self.last_info = reply["info"]
        return (decode_obs(reply["obs"]), float(reply["reward"]), bool(reply["terminated"]),
                bool(reply["truncated"]), reply["info"])

    def get_state(self, inputs: bool = True) -> dict:
        """Exact savestate (sim + progress tracker + recorded inputs), plain JSON."""
        return self.client.call("get_state", inputs=inputs)["state"]

    def set_state(self, state: dict):
        """Restores get_state(); returns (obs, info)."""
        reply = self.client.call("set_state", state=state)
        return decode_obs(reply["obs"]), reply["info"]

    def replay(self, name: str = "Python driver") -> dict:
        """The episode so far as a Penguintrack replay (encoded inputs + time), ghost-ready when finished."""
        return self.client.call("replay", name=name)["replay"]

    def render(self):
        return None

    def close(self):
        self.client.close()

    def __del__(self):
        try:
            self.close()
        except Exception:
            pass


class PenguinTrackVecEnv:
    """n envs in ONE node process (step_batch), auto-reset, zero dependencies.

    step(actions) -> (obs_list, rewards, terminateds, truncateds, infos); an env
    that ends is reset at once: its obs is the new episode's first observation
    and infos[i]["final_obs"] holds the terminal one (SB3 / gymnasium style).
    """

    def __init__(self, track="S01", n_envs: int = 4, config: dict | None = None,
                 node: str | None = None, obs_encoding: str = "b64"):
        self.client = HeadlessClient(node)
        spec = self.client.call("make", track=track, config=config or {}, num_envs=n_envs,
                                obs_encoding=obs_encoding)
        self.num_envs = n_envs
        self.track_info = spec["track"]
        self.observation_space = _make_space(spec["observation_space"])
        self.action_space = _make_space(spec["action_space"])

    def reset(self, seed: int | None = None):
        return [decode_obs(o) for o in self.client.call("reset_all", seed=seed)["obs"]]

    def step(self, actions):
        reply = self.client.call("step_batch", actions=[encode_action(a) for a in actions])
        infos = reply["info"]
        for info in infos:
            if "final_obs" in info:
                info["final_obs"] = decode_obs(info["final_obs"])
        return ([decode_obs(o) for o in reply["obs"]], reply["reward"], reply["terminated"],
                reply["truncated"], infos)

    def last_replay(self, env: int) -> dict | None:
        """Replay of env's last finished episode."""
        return self.client.call("replay", env=env, last=True)["replay"]

    def close(self):
        self.client.close()


def make_env(track="S01", config: dict | None = None, rank: int = 0, **kwargs):
    """Env factory for vector-env wrappers (one node process per env; rank offsets the start seed)."""

    def _init():
        cfg = dict(config or {})
        cfg["seed"] = int(cfg.get("seed", 0)) + rank
        return PenguinTrackEnv(track, config=cfg, **kwargs)

    return _init


def make_vec_env(track="S01", n_envs: int = 4, config: dict | None = None, vec: str = "auto", **kwargs):
    """A vector env.

    vec="subproc": stable-baselines3 SubprocVecEnv (one Python + node process per env).
    vec="dummy":   stable-baselines3 DummyVecEnv (one Python process, n node processes).
    vec="batch":   PenguinTrackVecEnv (one node process, zero dependencies).
    vec="auto":    subproc when stable-baselines3 is installed, else batch.
    """
    if vec == "auto":
        try:
            import stable_baselines3  # noqa: F401
            vec = "subproc"
        except ImportError:
            vec = "batch"
    if vec == "batch":
        return PenguinTrackVecEnv(track, n_envs=n_envs, config=config, **kwargs)
    from stable_baselines3.common.vec_env import DummyVecEnv, SubprocVecEnv
    fns = [make_env(track, config, rank=i, **kwargs) for i in range(n_envs)]
    return SubprocVecEnv(fns) if vec == "subproc" else DummyVecEnv(fns)


def save_replay(replay: dict, path: str | os.PathLike) -> None:
    """Writes a replay JSON the browser (replays / ghosts) can load."""
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(replay) + "\n", encoding="utf-8")


if gym is not None:
    try:
        gym.register(id="Penguintrack-v0", entry_point="penguintrack_env:PenguinTrackEnv")
    except Exception:  # already registered
        pass
