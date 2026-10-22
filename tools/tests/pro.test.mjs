// Pro tiers: entitlements and the dev flag (js/services/entitlements.js), the
// payment return URL (js/services/payments.js), the AI Lab's free limits
// (js/ai/lab-pro.js) and the Firebase "configured?" check. The Firebase SDK,
// Stripe and the paywall dialog need a browser and real accounts (docs/PAYMENTS_SETUP.md).
import assert from 'node:assert/strict';
import { test } from './_harness.mjs';
import { firebaseConfigured } from '../../js/services/firebase.js';
import { FIREBASE_CONFIG, PRODUCTS } from '../../js/services/config.js';
import {
    hasProTAS, hasProAI, gatingActive, readDevFlag, devFlag, isDevHost, setEntitlements, applyCachedEntitlements,
    normalizeEntitlements, onEntitlementsChange, FREE_AI,
} from '../../js/services/entitlements.js';
import { readPaymentReturn, stripPaymentQuery } from '../../js/services/payments.js';
import { aiGoalCap, aiWorkerCap, atFreeLimit, AI_PRO_SETTINGS } from '../../js/ai/lab-pro.js';

/** Runs fn as if the page were at `href` with an empty localStorage; puts the globals back after. */
function atPage(href, fn) {
    const had = { location: globalThis.location, localStorage: globalThis.localStorage };
    const ls = new Map();
    globalThis.localStorage = {
        getItem: (k) => (ls.has(k) ? ls.get(k) : null),
        setItem: (k, v) => ls.set(k, String(v)),
        removeItem: (k) => ls.delete(k),
    };
    globalThis.location = new URL(href);
    try {
        return fn(ls);
    } finally {
        setEntitlements(null, null, 'none');
        if (had.location === undefined) delete globalThis.location; else globalThis.location = had.location;
        if (had.localStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = had.localStorage;
    }
}

test('pro: the placeholder Firebase config counts as not set up', () => {
    assert.equal(firebaseConfigured(), false);
    assert.equal(firebaseConfigured(FIREBASE_CONFIG), false);
    assert.equal(firebaseConfigured({ apiKey: 'AIzaReal', projectId: 'penguin-track', appId: '1:2:web:3' }), true);
    assert.equal(firebaseConfigured({ apiKey: 'AIzaReal', projectId: 'YOUR_PROJECT_ID', appId: '1:2:web:3' }), false);
    assert.equal(firebaseConfigured(null), false);
});

test('pro: nothing is locked until Firebase is set up (PRO_GATING auto)', () => {
    assert.equal(gatingActive(), false);
    assert.equal(hasProTAS(), true);
    assert.equal(hasProAI(), true);
    atPage('https://silverninja71.github.io/Penguin-Track/', () => {
        assert.equal(gatingActive(), false);
        assert.equal(hasProTAS(), true);
    });
});

test('pro: the dev flag works on dev hosts only', () => {
    atPage('https://silverninja71.github.io/Penguin-Track/?pro=locked', (ls) => {
        assert.equal(isDevHost(), false);
        assert.equal(readDevFlag(), null);
        assert.equal(ls.size, 0, 'nothing stored on the live site');
        assert.equal(hasProTAS(), true);
    });
    atPage('http://localhost:8799/Penguin-Track/?pro=locked', (ls) => {
        assert.equal(isDevHost(), true);
        assert.equal(readDevFlag(), 'lock');
        assert.equal(gatingActive(), true);
        assert.equal(hasProTAS(), false);
        assert.equal(hasProAI(), false);
        // Remembered without the query, until ?pro=dev or ?pro=off.
        globalThis.location = new URL('http://localhost:8799/Penguin-Track/');
        assert.equal(readDevFlag(), 'lock');
        globalThis.location = new URL('http://localhost:8799/Penguin-Track/?pro=dev');
        assert.equal(readDevFlag(), 'unlock');
        assert.equal(gatingActive(), false);
        assert.equal(hasProTAS(), true);
        assert.equal(hasProAI(), true);
        globalThis.location = new URL('http://localhost:8799/Penguin-Track/?pro=off');
        assert.equal(readDevFlag(), null);
        assert.equal(ls.has('penguintrack:devPro'), false);
    });
    atPage('http://127.0.0.1:8080/?pro=dev', () => assert.equal(readDevFlag(), 'unlock'));
});

test('pro: entitlements unlock per item; a bundle unlocks both', () => {
    atPage('http://localhost/?pro=locked', () => {
        readDevFlag();
        const seen = [];
        const off = onEntitlementsChange((s) => seen.push(s));
        setEntitlements('u1', { pro_tas: true }, 'server');
        assert.equal(hasProTAS(), true);
        assert.equal(hasProAI(), false);
        setEntitlements('u1', { pro_bundle: true }, 'server');
        assert.equal(hasProTAS(), true);
        assert.equal(hasProAI(), true);
        setEntitlements('u1', { pro_bundle: true }, 'server');   // unchanged: no event
        off();
        assert.equal(seen.length, 2);
        assert.equal(seen[1].pro_ai, true);
        assert.equal(seen[1].source, 'server');
    });
});

test('pro: normalizeEntitlements ignores unknown items and anything but true', () => {
    assert.deepEqual(normalizeEntitlements(null), { pro_tas: false, pro_ai: false });
    assert.deepEqual(normalizeEntitlements({ pro_ai: true, pro_tas: 'yes', hack: true }), { pro_tas: false, pro_ai: true });
    assert.deepEqual(normalizeEntitlements({ pro_bundle: true }), { pro_tas: true, pro_ai: true });
    for (const id of Object.keys(PRODUCTS)) assert.ok(PRODUCTS[id].grants.length > 0, id);
});

test('pro: the offline cache belongs to one uid', () => {
    atPage('http://localhost/?pro=locked', (ls) => {
        readDevFlag();
        setEntitlements('u1', { pro_ai: true }, 'server');
        assert.ok(ls.get('penguintrack:entitlements').includes('"u1"'));
        setEntitlements(null, null, 'none');
        assert.equal(hasProAI(), false);
        applyCachedEntitlements('u1');
        assert.equal(hasProAI(), true, 'cached copy used offline');
        applyCachedEntitlements('someone-else');
        assert.equal(hasProAI(), false, 'another player on this browser gets nothing');
        // Only the server's answer is cached, never a cached one re-saved.
        const before = ls.get('penguintrack:entitlements');
        setEntitlements('u2', { pro_tas: true }, 'cache');
        assert.equal(ls.get('penguintrack:entitlements'), before);
    });
});

test('pro: the AI Lab free tier caps generations and workers', () => {
    assert.equal(aiGoalCap(0), 0, 'ungated: unlimited stays unlimited');
    assert.equal(aiWorkerCap(12), 12);
    assert.equal(atFreeLimit(500), false);
    atPage('http://localhost/?pro=locked', () => {
        readDevFlag();
        assert.equal(aiGoalCap(0), FREE_AI.generations, '"0 = ∞" becomes the free limit');
        assert.equal(aiGoalCap(300), FREE_AI.generations);
        assert.equal(aiGoalCap(3), 3);
        assert.equal(aiWorkerCap(12), FREE_AI.workers);
        assert.equal(atFreeLimit(FREE_AI.generations - 1), false);
        assert.equal(atFreeLimit(FREE_AI.generations), true);
        setEntitlements('u1', { pro_ai: true }, 'server');
        assert.equal(aiGoalCap(0), 0);
        assert.equal(aiWorkerCap(40), 16, 'Pro: up to 16 workers');
        assert.equal(atFreeLimit(500), false);
    });
    assert.deepEqual(AI_PRO_SETTINGS.slice().sort(), ['edgeRays', 'fov', 'hidden', 'lr', 'mutation', 'sigma', 'wallRays']);
});

test('pro: the payment return is read and cleared from the address', () => {
    assert.deepEqual(readPaymentReturn('?payment=success&item=pro_tas'), { status: 'success', item: 'pro_tas' });
    assert.deepEqual(readPaymentReturn('?payment=cancel&item=pro_ai'), { status: 'cancel', item: 'pro_ai' });
    assert.deepEqual(readPaymentReturn('?payment=success&item=free_money'), { status: 'success', item: null });
    assert.equal(readPaymentReturn('?payment=maybe'), null);
    assert.equal(readPaymentReturn(''), null);
    assert.equal(stripPaymentQuery('https://x.io/Penguin-Track/?payment=success&item=pro_tas'), '/Penguin-Track/');
    assert.equal(stripPaymentQuery('https://x.io/Penguin-Track/?screen=tas&payment=success&item=pro_tas#top'), '/Penguin-Track/?screen=tas#top');
});

test('pro: no Stripe secrets in the game', async () => {
    const { readFileSync, readdirSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const root = new URL('../../js/', import.meta.url).pathname;
    const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
    for (const f of walk(root).filter((f) => f.endsWith('.js'))) {
        const src = readFileSync(f, 'utf8');
        assert.ok(!/\bsk_(live|test)_[0-9a-zA-Z]{8,}/.test(src), `${f} holds a Stripe secret key`);
        assert.ok(!/\bwhsec_[0-9a-zA-Z]{8,}/.test(src), `${f} holds a webhook secret`);
    }
    assert.equal(devFlag(), null);
});
