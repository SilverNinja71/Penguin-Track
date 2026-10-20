// Stand-in screen for modes that are loaded on demand (editor, TAS Studio, AI
// Lab, multiplayer) when their module fails to load (offline, a bad deploy) or
// its enter() throws.
import { h } from './dom.js';
import { icon, iconSvg } from './icons.js';
import { snowfall } from './menu.js';

const INFO = {
    editor: { title: 'Track Editor', icon: 'edit', blurb: 'Snap blocks together, test-drive your track and share it with a code.' },
    tas: { title: 'TAS Studio', icon: 'tas', blurb: 'Frame-perfect runs: script inputs, rewind with savestates and bruteforce the last hundredths.' },
    ai: { title: 'AI Lab', icon: 'brain', blurb: 'Train a penguin to drive on its own and race against it.' },
    mp: { title: 'Multiplayer', icon: 'users', blurb: 'Hot-seat, split-screen and online ghost rooms with friends.' },
};

export function unavailableScreen(id, error = null) {
    const info = INFO[id] || { title: id, icon: 'snowflake', blurb: '' };
    return {
        id,
        shell: true,
        enter(app) {
            this.app = app;
            app.backdrop.start();
            app.setMusic(true);
            const broken = error && !/Failed to fetch|Importing a module script failed|error loading dynamically imported module|404/i.test(String(error.message || error));
            this.el = h('div.pt-screen.soon-screen',
                snowfall(24),
                h('div.soon-card.pt-panel',
                    h('div.soon-icon', { html: iconSvg(info.icon, 54) }),
                    h('h1.pt-title', info.title),
                    h('p.soon-lead', broken ? 'This part of Penguintrack hit a snag while loading.' : 'This part of Penguintrack is snowed in: it couldn’t be downloaded.'),
                    broken ? null : h('p.pt-muted', 'Check your connection and try again.'),
                    info.blurb ? h('p.pt-muted', info.blurb) : null,
                    broken ? h('pre.soon-error', String(error.message || error)) : null,
                    h('div.pt-row.soon-actions',
                        h('button.pt-btn.primary', { type: 'button', 'data-autofocus': true, 'data-sound': 'back', onclick: () => app.goto('menu') }, icon('back', 18), 'Back to the menu'),
                        h('button.pt-btn', { type: 'button', onclick: () => app.goto('campaign') }, icon('play', 18), 'Go racing instead'))));
            app.ui.appendChild(this.el);
            // The screen may already be gone (Esc pressed before the next frame).
            const el = this.el;
            requestAnimationFrame(() => el.isConnected && el.querySelector('[data-autofocus]').focus({ preventScroll: true }));
        },
        back() {
            this.app.goto('menu');
        },
        exit() {
            this.el = null;
        },
    };
}
