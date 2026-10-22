// Which Pro features this player owns: hasProTAS() / hasProAI().
//
// The real source of truth is the Firestore document users/{uid}, whose
// `entitlements` map only the stripeWebhook Cloud Function writes (security
// rules forbid players from writing it). payments.js listens to it and calls
// setEntitlements(). A copy is cached in localStorage so Pro keeps working
// offline; anyone can edit that copy, which is fine for a single-player tool
// but means nothing server-side should ever trust it.
//
// A dev flag (local dev hosts only) unlocks or locks everything for testing:
//   ?pro=dev     every Pro feature unlocked
//   ?pro=locked  the paywall on, even before Firebase is set up
//   ?pro=off     back to normal
import { PRO_GATING, PRODUCTS } from './config.js';
import { firebaseConfigured } from './firebase.js';

export const ENTITLEMENTS = ['pro_tas', 'pro_ai'];

/** What the free AI Lab allows; Pro AI lifts both. */
export const FREE_AI = Object.freeze({ generations: 5, workers: 1 });
export const PRO_AI_WORKERS = 16;

/** Paywall copy for each entitlement. */
export const PRO_FEATURES = Object.freeze({
    pro_tas: {
        title: 'Pro TAS Studio',
        item: 'pro_tas',
        features: [
            'Frame-by-frame timeline and script editor',
            'Bruteforce optimiser that hunts for faster inputs',
            'Ten savestate slots (Shift + 1 … 0 to save)',
            'Open any replay in the Studio and rework it',
        ],
        free: 'Quick TAS (Race & Rewind) stays free.',
    },
    pro_ai: {
        title: 'Pro AI Lab',
        item: 'pro_ai',
        features: [
            'Unlimited generations (free: 5)',
            `Up to ${PRO_AI_WORKERS} training workers (free: 1)`,
            'Custom sensor rays and hidden layers',
            'Mutation, noise and step-size settings',
            'Import and export driver weights',
        ],
        free: 'The free Lab trains with the presets for 5 generations on one worker.',
    },
});

const CACHE_KEY = 'penguintrack:entitlements';
const DEV_KEY = 'penguintrack:devPro';

const state = { uid: null, ents: {}, source: 'none' };
const listeners = new Set();

function ls() {
    try {
        return globalThis.localStorage || null;
    } catch (e) {
        return null;
    }
}

/** True on this machine's own dev server (localhost and friends), where the dev flag is honoured. */
export function isDevHost(loc = globalThis.location) {
    if (!loc) return false;
    if (loc.protocol === 'file:') return true;
    const host = String(loc.hostname || '');
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');
}

/** 'unlock', 'lock' or null. Only ever set on a dev host. */
export function devFlag() {
    if (!isDevHost()) return null;
    const v = ls() && ls().getItem(DEV_KEY);
    return v === 'unlock' || v === 'lock' ? v : null;
}

/** Reads ?pro=dev|locked|off from the address (dev hosts only) and remembers it. */
export function readDevFlag(search = globalThis.location ? globalThis.location.search : '') {
    if (!isDevHost() || !ls()) return devFlag();
    const q = new URLSearchParams(search).get('pro');
    if (q === 'dev') ls().setItem(DEV_KEY, 'unlock');
    else if (q === 'locked') ls().setItem(DEV_KEY, 'lock');
    else if (q === 'off') ls().removeItem(DEV_KEY);
    return devFlag();
}

/** Whether Pro features are locked at all right now (see PRO_GATING in config.js). */
export function gatingActive() {
    const dev = devFlag();
    if (dev === 'unlock') return false;
    if (dev === 'lock' || PRO_GATING === 'on') return true;
    if (PRO_GATING === 'off') return false;
    return firebaseConfigured();
}

export function hasEntitlement(name) {
    return !gatingActive() || !!state.ents[name];
}

export const hasProTAS = () => hasEntitlement('pro_tas');
export const hasProAI = () => hasEntitlement('pro_ai');

/** Turns a Firestore entitlements map into { pro_tas, pro_ai } booleans (a bundle grants both). */
export function normalizeEntitlements(raw) {
    const out = {};
    for (const k of ENTITLEMENTS) out[k] = false;
    if (!raw || typeof raw !== 'object') return out;
    for (const [item, on] of Object.entries(raw)) {
        if (on !== true || !PRODUCTS[item]) continue;
        for (const g of PRODUCTS[item].grants) out[g] = true;
    }
    return out;
}

/**
 * Records what `uid` owns. `source` is 'server' (Firestore said so: also
 * cached for offline play), 'cache' or 'none'.
 */
export function setEntitlements(uid, raw, source = 'server') {
    const ents = normalizeEntitlements(raw);
    const before = JSON.stringify([state.uid, state.ents]);
    state.uid = uid || null;
    state.ents = ents;
    state.source = uid ? source : 'none';
    if (uid && source === 'server' && ls()) {
        try {
            ls().setItem(CACHE_KEY, JSON.stringify({ uid, ents, at: Date.now() }));
        } catch (e) { /* storage full: the live copy still works */ }
    }
    if (JSON.stringify([state.uid, state.ents]) !== before) for (const cb of [...listeners]) cb(snapshot());
}

/** Uses the cached copy for `uid` until Firestore answers (or for good, offline). */
export function applyCachedEntitlements(uid) {
    let cached = null;
    try {
        cached = JSON.parse((ls() && ls().getItem(CACHE_KEY)) || 'null');
    } catch (e) { /* unreadable cache: ignore */ }
    if (cached && uid && cached.uid === uid) setEntitlements(uid, cached.ents, 'cache');
    else setEntitlements(uid, null, 'none');
}

export function snapshot() {
    return { uid: state.uid, source: state.source, gating: gatingActive(), pro_tas: hasProTAS(), pro_ai: hasProAI() };
}

/** Calls cb(snapshot) whenever what the player owns changes. Returns an unsubscribe function. */
export function onEntitlementsChange(cb) {
    listeners.add(cb);
    return () => listeners.delete(cb);
}
