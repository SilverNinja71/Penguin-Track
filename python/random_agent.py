"""Zero-dependency smoke test for the Penguintrack Python bridge.

Drives a few episodes with a random (gas-biased) policy, checks that
savestates restore exactly, steps a batched vector env and optionally writes
the best episode's replay for the browser.

    PENGUINTRACK_NODE=/path/to/node python3 random_agent.py --track S01 --episodes 3
"""

from __future__ import annotations

import argparse
import random
import sys
import time

from penguintrack_env import PenguinTrackEnv, PenguinTrackVecEnv, save_replay

GAS_ACTIONS = [0, 3, 3, 3, 6]   # left+gas, straight+gas (likely), right+gas


def policy(rng: random.Random, n_actions: int, continuous: bool):
    if continuous:
        return [rng.uniform(-1, 1), rng.uniform(0, 1)]
    return rng.choice(GAS_ACTIONS) if rng.random() < 0.8 else rng.randrange(n_actions)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--track", default="S01")
    ap.add_argument("--episodes", type=int, default=3)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--continuous", action="store_true")
    ap.add_argument("--replay-out", default=None, help="write the best episode's replay JSON here")
    args = ap.parse_args()

    rng = random.Random(args.seed)
    config = {"frameSkip": 4, "maxSeconds": 30, "action": "continuous" if args.continuous else "discrete"}
    env = PenguinTrackEnv(args.track, config=config)
    n_actions = getattr(env.action_space, "n", 2)
    print(f"track {env.track_info['id']} {env.track_info['name']}: {env.track_info['length']:.0f} m, "
          f"obs {env.observation_space.shape}, actions {env.action_space}")

    best = None
    t0 = time.time()
    total_steps = 0
    for ep in range(args.episodes):
        obs, info = env.reset(seed=args.seed + ep)
        assert len(obs) == env.observation_space.shape[0], "observation size mismatch"
        ret, done = 0.0, False
        while not done:
            obs, reward, terminated, truncated, info = env.step(policy(rng, n_actions, args.continuous))
            ret += reward
            total_steps += 1
            done = terminated or truncated
        print(f"episode {ep + 1}: return {ret:8.3f}  progress {info['progressFrac'] * 100:5.1f}%  "
              f"time {info['timeMs'] / 1000:6.2f} s  end: {info['reason']}")
        if best is None or ret > best[0]:
            best = (ret, env.replay(name=f"Random penguin {ep + 1}"))
    secs = time.time() - t0
    print(f"{total_steps} steps in {secs:.2f} s ({total_steps / max(secs, 1e-9):.0f} steps/s through the pipe)")

    # Savestates: the same actions from a restored state give the same rewards.
    env.reset(seed=7)
    for _ in range(25):
        env.step(3)
    state = env.get_state()
    plan = [rng.choice(GAS_ACTIONS) for _ in range(40)] if not args.continuous else \
        [[rng.uniform(-1, 1), 1.0] for _ in range(40)]
    first = [env.step(a)[1] for a in plan]
    env.set_state(state)
    second = [env.step(a)[1] for a in plan]
    assert first == second, "set_state did not restore the episode exactly"
    print("savestate round trip: identical rewards over 40 steps")

    vec = PenguinTrackVecEnv(args.track, n_envs=4, config=config)
    vec.reset(seed=args.seed)
    ends = 0
    for _ in range(200):
        _, _, term, trunc, _ = vec.step([policy(rng, n_actions, args.continuous) for _ in range(4)])
        ends += sum(1 for a, b in zip(term, trunc) if a or b)
    vec.close()
    print(f"batched vector env: 4 envs x 200 steps, {ends} episode ends (auto-reset)")

    if args.replay_out and best:
        save_replay(best[1], args.replay_out)
        print(f"best replay ({best[0]:.3f}) written to {args.replay_out}")
    env.close()
    print("ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
