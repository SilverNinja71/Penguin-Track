// Who is playing. Two optional sources, and a guest when neither is there:
//  - Firebase (js/services/firebase.js): a uid (anonymous or Google) that
//    purchases and Pro entitlements belong to.
//  - The hub's shared site account (SITE_ACCOUNTS_URL, window.GameAccounts),
//    loaded on demand instead of a hard <script> tag, so the game no longer
//    needs the Empire repo next to it. When a player is signed in there, the
//    profile everyone plays with lives in localStorage under
//    'spear_mace_user_profile'; first-time medals add gold to it. The hub's
//    script and keys are untouched, so the other games keep sharing it.
import { SITE_ACCOUNTS_URL } from '../services/config.js';
import { firebaseConfigured, onUserChanged } from '../services/firebase.js';

const PROFILE_KEY = 'spear_mace_user_profile';

let fbUser = null;          // { uid, name, isAnonymous } once Firebase reports a user
const listeners = new Set();

function readProfile() {
    try {
        const raw = localStorage.getItem(PROFILE_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch (e) {
        return null;
    }
}

function notify() {
    const id = identity();
    for (const cb of [...listeners]) cb(id);
}

/** Loads the hub's accounts script (when configured and not already there); resolves true when it is available. */
export function loadSiteAccounts(url = SITE_ACCOUNTS_URL, timeoutMs = 2500) {
    if (accountsAvailable()) return Promise.resolve(true);
    if (!url || typeof document === 'undefined') return Promise.resolve(false);
    return new Promise((resolve) => {
        const s = document.createElement('script');
        s.src = url;
        s.async = true;
        // A late load still counts: the menu refreshes when it lands.
        const timer = setTimeout(() => resolve(false), timeoutMs);
        s.onload = () => {
            clearTimeout(timer);
            resolve(accountsAvailable());
            notify();
        };
        s.onerror = () => {
            clearTimeout(timer);
            s.remove();
            resolve(false);
        };
        document.head.appendChild(s);
    });
}

/**
 * Starts both account sources. Waits (briefly) for the site account only;
 * Firebase reports its user later through onIdentityChange.
 */
export async function initAccounts() {
    if (firebaseConfigured()) {
        onUserChanged((user) => {
            fbUser = user ? { uid: user.uid, name: user.displayName || null, isAnonymous: !!user.isAnonymous } : null;
            notify();
        });
    }
    await loadSiteAccounts();
}

/** { username, gold } for the signed-in site account, or null (guest, or accounts not loaded). */
export function currentAccount() {
    const A = globalThis.window && window.GameAccounts;
    if (!A || typeof A.current !== 'function') return null;
    let cur = null;
    try {
        cur = A.current();
    } catch (e) {
        return null;
    }
    if (!cur) return null;
    const p = readProfile();
    const gold = p && Number.isFinite(p.gold) ? p.gold : 0;
    return { username: cur.username || (p && p.username) || 'Penguin', gold };
}

export function accountsAvailable() {
    return !!(globalThis.window && window.GameAccounts && typeof window.GameAccounts.current === 'function');
}

/**
 * Everything the game knows about the player:
 * { name, uid, provider: 'google' | 'anonymous' | 'site' | 'guest', site, firebase }.
 * `uid` is the Firebase uid (null without Firebase); `site` is currentAccount().
 */
export function identity() {
    const site = currentAccount();
    const fb = fbUser;
    let provider = 'guest';
    if (fb && !fb.isAnonymous) provider = 'google';
    else if (site) provider = 'site';
    else if (fb) provider = 'anonymous';
    const name = (site && site.username) || (fb && fb.name) || null;
    return { name, uid: fb ? fb.uid : null, provider, site, firebase: fb };
}

/** Calls cb(identity()) whenever the Firebase user or the site account changes. Returns an unsubscribe function. */
export function onIdentityChange(cb) {
    listeners.add(cb);
    return () => listeners.delete(cb);
}

/** Adds gold to the signed-in profile. Returns the new balance, or null when nobody is signed in. */
export function addGold(amount) {
    if (!currentAccount() || !(amount > 0)) return null;
    const p = readProfile();
    if (!p) return null;
    p.gold = (Number.isFinite(p.gold) ? p.gold : 0) + Math.round(amount);
    try {
        localStorage.setItem(PROFILE_KEY, JSON.stringify(p));
    } catch (e) {
        return null;
    }
    return p.gold;
}
