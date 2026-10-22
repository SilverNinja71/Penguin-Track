// The Pro paywall dialog: what Pro adds, "Unlock for $3" (Stripe Checkout),
// "Restore purchase / Sign in" (Google, so a purchase follows the player to
// other devices) and "Not now". Focus stays inside the dialog while it is open.
import { h } from './dom.js';
import { iconSvg } from './icons.js';
import { focusablesIn } from './ui.js';
import { PRODUCTS } from '../services/config.js';
import { firebaseConfigured, signInWithGoogle } from '../services/firebase.js';
import { PRO_FEATURES, hasEntitlement, onEntitlementsChange } from '../services/entitlements.js';
import { startCheckout } from '../services/payments.js';

const icon = (name, size = 18) => h('span.pt-ico', { html: iconSvg(name, size) });

/** Tab and Shift+Tab cycle inside `root` instead of leaving the dialog. */
export function trapFocus(root) {
    root.addEventListener('keydown', (e) => {
        if (e.key !== 'Tab') return;
        const items = focusablesIn(root);
        if (!items.length) return;
        const i = items.indexOf(document.activeElement);
        const next = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : (i === items.length - 1 ? 0 : i + 1);
        e.preventDefault();
        e.stopPropagation();
        items[next].focus();
    });
}

/**
 * Opens the paywall for 'pro_tas' or 'pro_ai'. `reason` says what was tried
 * ("Bruteforce needs Pro TAS."). Resolves true when the player owns it by the
 * time the dialog closes.
 */
export function openPaywall(app, ent, { reason = '' } = {}) {
    const info = PRO_FEATURES[ent];
    if (!info) return Promise.resolve(false);
    const product = PRODUCTS[info.item];
    const bundle = PRODUCTS.pro_bundle;
    const live = firebaseConfigured();
    let off = null;

    const done = app.modal((close) => {
        const status = h('p.pw-status.pt-muted', { role: 'status', 'aria-live': 'polite' });
        const say = (msg, bad = false) => {
            status.textContent = msg;
            status.classList.toggle('bad', bad);
        };
        const busy = (btn, label) => {
            const keep = btn.innerHTML;
            btn.disabled = true;
            btn.textContent = label;
            return () => {
                btn.disabled = false;
                btn.innerHTML = keep;
            };
        };
        const buy = async (btn, item) => {
            if (!live) {
                say('Payments are not set up on this copy of the game yet (see docs/PAYMENTS_SETUP.md).', true);
                return;
            }
            const undo = busy(btn, 'Opening checkout…');
            say('Taking you to Stripe’s secure checkout…');
            try {
                await startCheckout(item);
            } catch (e) {
                undo();
                say(e && e.message ? e.message : 'Checkout did not start. Please try again.', true);
            }
        };
        const restore = async (btn) => {
            if (!live) {
                say('Sign-in is not set up on this copy of the game yet.', true);
                return;
            }
            const undo = busy(btn, 'Signing in…');
            try {
                await signInWithGoogle();
                say('Signed in. Checking your purchases…');
                // Owned: the entitlements listener closes the dialog. Otherwise say so.
                setTimeout(() => {
                    if (!hasEntitlement(ent) && root.isConnected) say(`No ${product.name} purchase on this account yet.`);
                }, 4000);
            } catch (e) {
                say(e && e.code === 'auth/popup-closed-by-user' ? 'Sign-in was cancelled.' : `Could not sign in: ${(e && e.message) || e}`, true);
            }
            undo();
        };
        // Closes on its own when the purchase lands (or a sign-in restores it).
        off = onEntitlementsChange(() => {
            if (hasEntitlement(ent)) close(true);
        });

        const unlock = h('button.pt-btn.primary.big.pw-buy', { type: 'button', 'data-autofocus': true, onclick: (e) => buy(e.currentTarget, info.item) },
            icon('lock', 20), `Unlock for ${product.price}`);
        const both = bundle ? h('button.pt-btn.pw-bundle', { type: 'button', onclick: (e) => buy(e.currentTarget, 'pro_bundle') },
            `Get TAS + AI for ${bundle.price}`) : null;
        const signIn = h('button.pt-btn.pw-restore', { type: 'button', onclick: (e) => restore(e.currentTarget) }, icon('users'), 'Restore purchase / Sign in');
        const later = h('button.pt-btn.ghost', { type: 'button', 'data-sound': 'back', onclick: () => close(false) }, 'Not now');

        const root = h('div.pt-col.pw',
            h('div.pw-head',
                h('span.pw-badge', 'PRO'),
                h('h2.pt-subtitle.pw-title', { id: 'pw-title' }, info.title),
                h('span.pw-price', `${product.price}`, h('small', ' one-time'))),
            reason ? h('p.pt-modal-msg.pw-reason', reason) : null,
            h('ul.pw-list', info.features.map((f) => h('li', icon('check', 16), h('span', f)))),
            h('p.pw-free.pt-muted', info.free),
            h('div.pw-actions', unlock, both),
            h('div.pt-row.pw-actions-2', signIn, h('div.pt-spacer'), later),
            status,
            h('p.pw-fine.pt-muted', 'Payments go through Stripe; Penguintrack never sees your card. One-time purchase, no subscription.'));
        trapFocus(root);
        return root;
    }, { className: 'pw-modal', label: `${info.title}: unlock` });

    return done.then((v) => {
        if (off) off();
        return !!v || hasEntitlement(ent);
    });
}

/** hasEntitlement(ent), or the paywall when it is missing. Resolves true when the player may go on. */
export async function requirePro(app, ent, reason) {
    if (hasEntitlement(ent)) return true;
    return openPaywall(app, ent, { reason });
}
