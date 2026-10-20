"""Train a Penguintrack driver with stable-baselines3 PPO.

    pip install -r requirements.txt
    PENGUINTRACK_NODE=$(which node) python3 train_ppo.py --track S01 --steps 1000000 --n-envs 8

Saves the model (<out>.zip), evaluates it greedily from the start line and
exports the best evaluation episode as a replay (<out>-replay.json) that the
browser can load as a ghost (Replays screen / AI Lab).
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

from stable_baselines3 import PPO
from stable_baselines3.common.callbacks import CheckpointCallback
from stable_baselines3.common.vec_env import VecMonitor

from penguintrack_env import PenguinTrackEnv, make_vec_env, save_replay


def evaluate(model, track, config, episodes: int):
    """Greedy episodes from the start; returns (best, rows). Best = finished fastest, else farthest."""
    env = PenguinTrackEnv(track, config={**config, "startMode": "start"})
    best, rows = None, []
    for ep in range(episodes):
        obs, info = env.reset(seed=ep)
        done, ret = False, 0.0
        while not done:
            action, _ = model.predict(obs, deterministic=True)
            obs, reward, terminated, truncated, info = env.step(action)
            ret += reward
            done = terminated or truncated
        rows.append((ret, info))
        key = (1, -info["finishTimeMs"]) if info["finished"] else (0, info["progressFrac"])
        if best is None or key > best[0]:
            best = (key, ret, info, env.replay(name="PPO penguin"))
    env.close()
    return best, rows


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--track", default="S01", help="level id, sample id, PT1. code or track .json")
    ap.add_argument("--steps", type=int, default=1_000_000, help="total env steps")
    ap.add_argument("--n-envs", type=int, default=8)
    ap.add_argument("--vec", default="subproc", choices=["subproc", "dummy"])
    ap.add_argument("--frame-skip", type=int, default=4)
    ap.add_argument("--max-seconds", type=float, default=60)
    ap.add_argument("--start-mode", default="random-checkpoint", choices=["start", "random-checkpoint", "random"])
    ap.add_argument("--action", default="discrete", choices=["discrete", "continuous"])
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--out", default="models/ppo-penguin")
    ap.add_argument("--eval-episodes", type=int, default=3)
    ap.add_argument("--load", default=None, help="continue training from a saved .zip")
    args = ap.parse_args()

    config = {
        "frameSkip": args.frame_skip,
        "maxSeconds": args.max_seconds,
        "startMode": args.start_mode,
        "action": args.action,
    }
    venv = VecMonitor(make_vec_env(args.track, n_envs=args.n_envs, config=config, vec=args.vec))
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)

    if args.load:
        model = PPO.load(args.load, env=venv)
    else:
        model = PPO(
            "MlpPolicy", venv, seed=args.seed, verbose=1,
            n_steps=512, batch_size=1024, n_epochs=8,
            learning_rate=3e-4, gamma=0.995, gae_lambda=0.95,
            ent_coef=0.005, clip_range=0.2,
            policy_kwargs={"net_arch": [128, 128]},
        )
    t0 = time.time()
    model.learn(
        total_timesteps=args.steps,
        callback=CheckpointCallback(save_freq=max(1, 100_000 // args.n_envs), save_path=str(out.parent),
                                    name_prefix=out.name),
    )
    model.save(str(out))
    venv.close()
    print(f"trained {args.steps} steps in {time.time() - t0:.0f} s -> {out}.zip")

    best, rows = evaluate(model, args.track, config, args.eval_episodes)
    for i, (ret, info) in enumerate(rows):
        what = f"finished {info['finishTimeMs'] / 1000:.2f} s" if info["finished"] else \
            f"{info['progressFrac'] * 100:.1f}% ({info['reason']})"
        print(f"eval {i + 1}: return {ret:.3f}, {what}")
    if best:
        replay_path = f"{out}-replay.json"
        save_replay(best[3], replay_path)
        summary = {"track": args.track, "return": best[1], "info": best[2], "replay": replay_path}
        Path(f"{out}-eval.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
        print(f"best episode replay -> {replay_path}")


if __name__ == "__main__":
    main()
