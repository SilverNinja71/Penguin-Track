// Main menu: the snowy wordmark over the attract-mode track, every mode of the
// game, the signed-in site account and a way back to the site launcher.
import { h } from './dom.js';
import { icon, iconSvg, penguinSvg } from './icons.js';
import { currentAccount, accountsAvailable } from './account.js';

const ITEMS = [
    { id: 'editor', label: 'Editor', icon: 'edit', hint: 'Build a track' },
    { id: 'mytracks', label: 'My Tracks', icon: 'map', hint: 'Your tracks and share codes' },
    { id: 'replays', label: 'Replays', icon: 'film', hint: 'Watch and share runs' },
    { id: 'tas', label: 'TAS', icon: 'tas', hint: 'Quick TAS rewinds or the Pro Studio' },
    { id: 'ai', label: 'AI Lab', icon: 'brain', hint: 'Train a driver' },
    { id: 'mp', label: 'Multiplayer', icon: 'users', hint: 'Hot-seat and ghost rooms' },
    { id: 'settings', label: 'Settings', icon: 'gear', hint: 'Sound, graphics, keys' },
    { id: 'help', label: 'Help', icon: 'help', hint: 'Controls and tips' },
];

export function snowfall(count = 36) {
    const flakes = [];
    for (let i = 0; i < count; i++) {
        const size = 2 + Math.random() * 4;
        flakes.push(h('span', {
            style: {
                left: `${Math.random() * 100}%`,
                width: `${size}px`,
                height: `${size}px`,
                opacity: String(0.35 + Math.random() * 0.5),
                animationDuration: `${7 + Math.random() * 9}s, ${3 + Math.random() * 3}s`,
                animationDelay: `${-Math.random() * 16}s, ${-Math.random() * 6}s`,
            },
        }));
    }
    return h('div.pt-snowfall', { 'aria-hidden': 'true' }, flakes);
}

export function logo() {
    return h('div.pt-logo', { role: 'img', 'aria-label': 'Penguintrack' },
        h('div.pt-logo-penguin', { html: penguinSvg(132) }),
        h('div.pt-logo-word', h('span.pt-logo-a', { 'data-snow': 'PENGUIN' }, 'PENGUIN'), h('span.pt-logo-b', { 'data-snow': 'TRACK' }, 'TRACK')));
}

function accountChip() {
    const acc = currentAccount();
    if (acc) {
        return h('div.menu-account.pt-panel', { title: 'Signed in with your site account' },
            h('span.menu-avatar', acc.username.slice(0, 1).toUpperCase()),
            h('div.menu-account-text', h('div.menu-account-name', acc.username), h('div.menu-account-gold', h('span.res-coin'), `${acc.gold} gold`)));
    }
    return h('div.menu-account.guest.pt-panel',
        h('span.menu-avatar', { html: iconSvg('penguin', 20) }),
        h('div.menu-account-text',
            h('div.menu-account-name', 'Playing as a guest'),
            h('div.menu-account-gold', accountsAvailable() ? 'Sign in on the site to earn gold for medals' : 'Medals still count on this device')));
}

const menu = {
    id: 'menu',
    shell: true,

    enter(app) {
        app.backdrop.start();
        app.setMusic(true);
        const play = h('button.pt-btn.primary.big.menu-play', {
            type: 'button', 'data-autofocus': true, onclick: () => app.goto('campaign'),
        }, h('span.pt-ico', { html: iconSvg('play', 26) }), 'Play');
        const grid = h('div.menu-grid', ITEMS.map((it) => h('button.pt-btn.menu-item', {
            type: 'button', onclick: () => app.goto(it.id), title: it.hint,
        }, icon(it.icon, 22), h('span.menu-item-text', h('span.menu-item-label', it.label), h('span.menu-item-hint', it.hint)))));
        const showing = app.backdrop.track ? h('div.menu-showing.pt-muted', icon('eye', 16), `Now showing: ${app.backdrop.track.name}`) : null;
        this.el = h('div.pt-screen.menu-screen',
            snowfall(),
            h('div.menu-top',
                h('a.pt-btn.small.ghost.menu-site', { href: '../', 'data-sound': 'back' }, icon('home', 18), 'All games'),
                h('div.pt-spacer'),
                accountChip()),
            h('div.menu-main',
                logo(),
                h('p.menu-tag', 'Snowy time attack. Chase the Emperor medal.'),
                h('nav.menu-nav', { 'aria-label': 'Main menu' }, play, grid)),
            h('div.menu-foot',
                h('div.menu-keys.pt-muted', h('span.pt-kbd', '↑↓←→'), ' move  ', h('span.pt-kbd', 'Enter'), ' select  ', h('span.pt-kbd', 'Esc'), ' back'),
                h('div.pt-spacer'),
                showing));
        app.ui.appendChild(this.el);
        requestAnimationFrame(() => play.focus({ preventScroll: true }));
    },

    exit() {
        this.el = null;
    },
};

export default menu;
