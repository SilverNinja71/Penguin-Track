// Help: controls (live from the key bindings), medals, surfaces and special
// pads in the snow vocabulary (names and descriptions straight from the block
// catalog), and driving tips.
import { BLOCK_LIST, SURFACES } from '../core/blocks.js';
import { h } from './dom.js';
import { icon, iconSvg } from './icons.js';
import { ACTIONS, keyLabel } from './settings.js';
import { EFFECT_INFO } from './hud.js';

const PAD = {
    gas: 'RT / A', brake: 'LT / X', left: 'Left stick', right: 'Left stick', respawn: 'B', restart: 'Y / Back',
    camera1: '—', camera2: '—', camera3: '—', cameraCycle: 'RB', ghost: '—', pause: 'Start',
    tasMark: 'LB', tasRewind: 'Y', tasPrev: 'D-pad ↓', tasNext: 'D-pad ↑',
};

const SURFACE_TEXT = {
    snow: 'Grippy and predictable: the road most tracks are built from. Tap the brake while steering to drift.',
    powder: 'Loose and drifty. The car slides wide, so turn in early and let it swing.',
    ice: 'Almost no grip and weak brakes. Steer gently, brake early, and never panic.',
    ground: 'Slow and draggy off the road. Cutting across costs more than it saves, usually.',
};

const SURFACE_SWATCH = { snow: '#eef4fb', powder: '#d8c7a5', ice: '#a8dcf5', ground: '#f7fbff' };

const TIPS = [
    ['Drift', 'Above 70 km/h on snow or powder, tap the brake while steering hard to start a drift. Release the brake and hold the wheel into the turn to keep it; centre the wheel to end it.'],
    ['Respawn', 'Enter puts you back at the last checkpoint with the speed you had there, but the clock keeps running. Backspace restarts the whole run instantly.'],
    ['Loops', 'Keep the gas held all the way round. A loop only fails when you arrive slow and lift.'],
    ['Jumps', 'Land straight: touching down nose-first throws away speed. Steering works a little in the air.'],
    ['Banked turns', 'The low inside line is the fast one; at full speed you need the whole width.'],
    ['Ghosts', 'Your personal best runs alongside you as a ghost (G hides it). Splits at each checkpoint show blue when you are ahead, red when behind. In Settings or the pause menu you can also race the best TAS run (pink) and the best AI run (green) at the same time.'],
    ['Quick TAS', 'TAS → Quick TAS lets you race and rewind: C drops a savestate marker, R or Backspace jumps back to it, and [ ] step through your markers. The run lands on the Best TAS leaderboard, and Open in Pro Studio carries the inputs into the frame-by-frame editor.'],
    ['Platform tracks', 'Fewest respawns wins, then time. Take it slow where it matters.'],
];

function controlsTable(app) {
    const b = app.settings.bindings;
    return h('table.help-table',
        h('thead', h('tr', h('th', 'Action'), h('th', 'Keyboard'), h('th', 'Gamepad'))),
        h('tbody', ACTIONS.map((a) => h('tr',
            h('td', a.label),
            h('td', (b[a.id] || []).length ? (b[a.id] || []).map((k) => h('span.pt-kbd', keyLabel(k))) : h('span.pt-muted', 'unbound')),
            h('td.pt-muted', PAD[a.id] || '—')))));
}

const help = {
    id: 'help',
    shell: true,

    enter(app) {
        this.app = app;
        app.backdrop.start();
        app.setMusic(true);
        const specials = BLOCK_LIST.filter((d) => d.category === 'special');
        const surfaces = ['snow', 'powder', 'ice', 'ground'].map((id) => SURFACES[id]).filter(Boolean);
        const sec = (title, iconName, ...body) => h('section.help-section.pt-panel', h('h2.set-title', icon(iconName, 20), title), ...body);
        const body = h('div.help-body.pt-scroll',
            h('div.help-grid',
                sec('Controls', 'keyboard',
                    controlsTable(app),
                    h('p.pt-muted.help-small', 'Keys can be changed in Settings. On a phone or tablet, on-screen buttons appear while racing.')),
                sec('Medals', 'trophy',
                    h('p', 'Every official track has four medal times. Beat one to earn it for good:'),
                    h('div.help-medals',
                        ['emperor', 'gold', 'silver', 'bronze'].map((m) => h('div.help-medal',
                            h('span.pt-medal', { class: m }),
                            h('b', app.catalog.medalLabel(m)),
                            h('span.pt-muted', { emperor: 'the author time', gold: 'fast', silver: 'solid', bronze: 'finished well' }[m]),
                            h('span.help-gold', `+${app.catalog.medalReward(m)} gold`)))),
                    h('p.pt-muted.help-small', 'On platform tracks medals are about respawns first: the Emperor needs a clean run under the author time. Gold for medals goes to your site account the first time you earn each medal on a campaign track, when you are signed in.')),
                sec('Surfaces', 'snowflake',
                    h('div.help-list', surfaces.map((s) => h('div.help-item',
                        h('span.help-swatch', { style: { background: SURFACE_SWATCH[s.id] || s.color } }),
                        h('div', h('b', s.name), h('p.pt-muted', SURFACE_TEXT[s.id] || '')))))),
                sec('Special pads', 'turbo',
                    h('div.help-list', specials.map((d) => {
                        const info = EFFECT_INFO[d.effect];
                        return h('div.help-item',
                            h('span.help-pad', { class: info ? info.tone : 'cool', html: iconSvg(info ? info.icon : 'reset', 20) }),
                            h('div', h('b', d.name), h('p.pt-muted', d.description)));
                    }))),
                sec('Tips', 'penguin',
                    h('div.help-list', TIPS.map(([t, d]) => h('div.help-item.tip', h('div', h('b', t), h('p.pt-muted', d))))))));
        this.el = h('div.pt-screen.help-screen',
            h('header.list-head',
                h('button.pt-btn.small.ghost', { type: 'button', 'data-sound': 'back', 'data-autofocus': true, onclick: () => this.back() }, icon('back', 18), 'Menu'),
                h('h1.pt-title', 'Help'),
                h('div.pt-spacer'),
                h('button.pt-btn.small', { type: 'button', onclick: () => app.goto('campaign') }, icon('play', 16), 'Play')),
            body);
        app.ui.appendChild(this.el);
        this.body = body;
        // The screen may already be gone (Esc pressed before the next frame).
        const el = this.el;
        requestAnimationFrame(() => el.isConnected && el.querySelector('[data-autofocus]').focus({ preventScroll: true }));
    },

    onKey(e) {
        // The help page is mostly text: arrows scroll it instead of hopping between two buttons.
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'PageDown' || e.key === 'PageUp') {
            const d = (e.key.startsWith('Page') ? this.body.clientHeight * 0.85 : 60) * (e.key.endsWith('Up') ? -1 : 1);
            this.body.scrollBy({ top: d, behavior: this.app.settings.reducedMotion ? 'auto' : 'smooth' });
            return true;
        }
        return false;
    },

    back() {
        this.app.goto('menu');
    },

    exit() {
        this.el = null;
    },
};

export default help;
