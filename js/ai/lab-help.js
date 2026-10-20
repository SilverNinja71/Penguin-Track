// "How it works" for the AI Lab: what a penguin driver senses, what it can do,
// how it is scored and how neuroevolution improves it, plus the Python route.
import { h } from '../game/dom.js';
import { iconSvg } from '../game/icons.js';

const DIAGRAM = `<svg class="ai-diagram" viewBox="0 0 560 190" role="img" aria-label="Sensors feed a small neural network, which picks one of nine actions">
  <defs>
    <marker id="aiArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="#9db8d9"/></marker>
  </defs>
  <g stroke-linecap="round">
    <path d="M14 150h150" stroke="#eef6ff" stroke-opacity="0.35" stroke-width="2"/>
    <path d="M14 40h150" stroke="#eef6ff" stroke-opacity="0.35" stroke-width="2"/>
    <g stroke-width="2">
      <path d="M70 120L20 120" stroke="#ff6b81"/><path d="M70 120L28 78" stroke="#ffcf5a"/>
      <path d="M70 120L56 44" stroke="#7fdcff"/><path d="M70 120L100 42" stroke="#7fdcff"/>
      <path d="M70 120L150 70" stroke="#ffcf5a"/><path d="M70 120L160 120" stroke="#ff6b81"/>
    </g>
    <path d="M70 120C90 100 120 80 150 60" stroke="#ffd54a" stroke-dasharray="4 5" stroke-width="2" fill="none"/>
    <circle cx="150" cy="60" r="4" fill="#ffd54a"/>
    <rect x="58" y="112" width="24" height="30" rx="7" fill="#d61f2c" stroke="#0b1a2e" stroke-width="2"/>
    <circle cx="70" cy="122" r="5" fill="#1f2a36"/>
  </g>
  <text x="92" y="178" text-anchor="middle" class="ai-dia-t">sees: road edges, speed, curves</text>
  <path d="M176 100h40" stroke="#9db8d9" stroke-width="2" marker-end="url(#aiArrow)"/>
  <g fill="#12284d" stroke="#7fdcff" stroke-width="2">
    <circle cx="240" cy="50" r="8"/><circle cx="240" cy="80" r="8"/><circle cx="240" cy="110" r="8"/><circle cx="240" cy="140" r="8"/>
    <circle cx="300" cy="65" r="8"/><circle cx="300" cy="95" r="8"/><circle cx="300" cy="125" r="8"/>
    <circle cx="360" cy="80" r="8"/><circle cx="360" cy="110" r="8"/>
  </g>
  <g stroke="#7fdcff" stroke-opacity="0.35" stroke-width="1">
    <path d="M248 50L292 65M248 50L292 95M248 80L292 65M248 80L292 125M248 110L292 95M248 110L292 125M248 140L292 95M248 140L292 125"/>
    <path d="M308 65L352 80M308 65L352 110M308 95L352 80M308 95L352 110M308 125L352 80M308 125L352 110"/>
  </g>
  <text x="300" y="178" text-anchor="middle" class="ai-dia-t">thinks: a tiny network</text>
  <path d="M378 100h40" stroke="#9db8d9" stroke-width="2" marker-end="url(#aiArrow)"/>
  <g stroke="#7fdcff" stroke-opacity="0.5" stroke-width="1.5" fill="#12284d">
    <rect x="430" y="52" width="30" height="30" rx="5"/><rect x="464" y="52" width="30" height="30" rx="5" fill="#5cc8f5"/><rect x="498" y="52" width="30" height="30" rx="5"/>
    <rect x="430" y="86" width="30" height="30" rx="5"/><rect x="464" y="86" width="30" height="30" rx="5"/><rect x="498" y="86" width="30" height="30" rx="5"/>
    <rect x="430" y="120" width="30" height="30" rx="5"/><rect x="464" y="120" width="30" height="30" rx="5"/><rect x="498" y="120" width="30" height="30" rx="5"/>
  </g>
  <g class="ai-dia-k" text-anchor="middle"><text x="445" y="44">left</text><text x="479" y="44">straight</text><text x="513" y="44">right</text></g>
  <text x="479" y="178" text-anchor="middle" class="ai-dia-t">acts: 1 of 9 buttons</text>
</svg>`;

const PY = `cd penguintrack/python
python3 random_agent.py --track T01            # no installs needed: a random penguin
pip install -r requirements.txt                # gymnasium, numpy, stable-baselines3, torch
python3 train_ppo.py --track T01 --steps 1000000 --n-envs 8 --out models/ppo-t01
# then import models/ppo-t01-replay.json here (Drivers > Import) to watch or race it`;

const NODE = `node tools/train.mjs --track T01 --algo ga --gens 100     # same trainer, all CPU cores
node tools/train.mjs --init models/demo-S01.json --track A01   # fine-tune a saved driver`;

export function openHowItWorks(app) {
    return app.modal((close) => h('div.ai-help',
        h('div.pt-row',
            h('h2.pt-subtitle', 'How a penguin learns to drive'),
            h('div.pt-spacer'),
            h('button.pt-btn.small.ghost', { type: 'button', 'aria-label': 'Close', onclick: () => close(null) }, h('span.pt-ico', { html: iconSvg('close', 18) }))),
        h('div.ai-help-body.pt-scroll',
            h('div', { html: DIAGRAM }),
            h('section',
                h('h3', '1. What it sees'),
                h('p', 'Every 4 ticks (25 times a second) the driver gets a list of about 75 numbers. The most important ones:'),
                h('ul',
                    h('li', h('b', 'Edge rays'), ' (whiskers): imagine 15 laser pointers fanned out from the nose. Each one says how far away the edge of the road is in that direction. In the 3D view they are the coloured lines: red means the edge is close, cyan means clear road.'),
                    h('li', h('b', 'Speed and slide'), ': how fast it goes forward and sideways, how it is spinning, and whether the wheels touch the snow.'),
                    h('li', h('b', 'The road ahead'), ': how sharply the track bends 10, 25, 50 and 90 metres ahead, whether that part is ice or powder, and where those points are (the gold dots).'),
                    h('li', h('b', 'Progress'), ': how much of the lap is done and which checkpoints are taken.'))),
            h('section',
                h('h3', '2. What it can do'),
                h('p', 'Nine buttons, like a keyboard player: steer left, straight or right, combined with gas, coast or brake. (The "continuous" option lets it steer smoothly instead.) The panel under the view lights up the button it is pressing.')),
            h('section',
                h('h3', '3. How it is scored'),
                h('p', 'A run scores up to 100 points for how much of the route it drove before it crashed, fell, got stuck or turned back. A finish scores 100 plus every second left on the clock, so any finish beats any crash and a faster finish beats a slower one.')),
            h('section',
                h('h3', '4. How it gets better: neuroevolution'),
                h('p', 'The driver\'s brain is a tiny neural network: a few thousand numbers (weights) that turn the 75 inputs into the 9 button scores. Nobody programs them. Instead:'),
                h('ol',
                    h('li', 'Hatch a flock (the population) of drivers with random weights.'),
                    h('li', 'Let every one of them drive the track once. Web Workers do this on all your CPU cores at the same time.'),
                    h('li', h('b', 'GA'), ' (genetic algorithm): keep the best few unchanged, breed the rest from the top quarter with a little random mutation. ', h('b', 'ES'), ' (evolution strategies): nudge one central driver in the direction that the better-scoring random variations pointed.'),
                    h('li', 'Repeat. That is one generation. The chart shows the best and average score of each one.')),
                h('p.pt-muted', 'It is like breeding faster and faster sledge dogs, except every pup is a list of numbers. The same seed and settings always give the same result.')),
            h('section',
                h('h3', '5. Train with Python or Node'),
                h('p', 'The same environment runs outside the browser. The gymnasium wrapper speaks to the game physics through Node, so any reinforcement-learning library (PPO, DQN…) can train a penguin:'),
                h('pre.ai-code', PY),
                h('pre.ai-code', NODE),
                h('p', 'Every observation, the reward and the protocol are documented in ',
                    h('a', { href: new URL('../../docs/AI.md', import.meta.url).href, target: '_blank', rel: 'noopener' }, 'docs/AI.md'),
                    '. Model files from tools/train.mjs import straight into the Drivers tab.'))),
        h('div.pt-row.pt-modal-actions',
            h('button.pt-btn.primary', { type: 'button', 'data-autofocus': true, onclick: () => close(null) }, 'Got it'))),
    { className: 'ai-help-modal', label: 'How the AI Lab works' });
}
