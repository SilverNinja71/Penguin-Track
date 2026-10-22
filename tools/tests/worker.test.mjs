// The payments server (worker/src/index.js, a Cloudflare Worker) run in Node
// with a fake Google (its own RSA keys stand in for Firebase's token keys and
// the service account), a fake Stripe and a fake Firestore. Real Stripe and
// Cloudflare are only reachable after the setup in docs/PAYMENTS_SETUP.md.
import assert from 'node:assert/strict';
import { test } from './_harness.mjs';
import { handle, verifyStripeSignature, verifyFirebaseToken, returnUrlFor, resetCaches, ITEMS } from '../../worker/src/index.js';

const PROJECT = 'penguin-track-test';
const NOW = 1_800_000_000_000;
const APP = 'https://silverninja71.github.io/Penguin-Track/';
const WHSEC = 'whsec_test_secret';
const enc = new TextEncoder();
const b64url = (bytes) => Buffer.from(bytes).toString('base64url');
const json64 = (o) => b64url(enc.encode(JSON.stringify(o)));

const RSA = { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' };
let keysP = null;
/** Google's token key pair, a stranger's key pair, and a service account (with its own pair). */
function keys() {
    keysP ||= (async () => {
        const google = await crypto.subtle.generateKey(RSA, true, ['sign', 'verify']);
        const stranger = await crypto.subtle.generateKey(RSA, true, ['sign', 'verify']);
        const sa = await crypto.subtle.generateKey(RSA, true, ['sign', 'verify']);
        const jwk = { ...(await crypto.subtle.exportKey('jwk', google.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
        const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', sa.privateKey)).toString('base64');
        const pem = `-----BEGIN PRIVATE KEY-----\n${pkcs8.match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----\n`;
        const serviceAccount = JSON.stringify({ type: 'service_account', client_email: 'payments@penguin-track-test.iam.gserviceaccount.com', private_key: pem });
        return { google, stranger, jwk, sa, serviceAccount };
    })();
    return keysP;
}

async function signJwt(privateKey, header, claims) {
    const unsigned = `${json64(header)}.${json64(claims)}`;
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, enc.encode(unsigned));
    return `${unsigned}.${b64url(sig)}`;
}

async function idToken(over = {}, key = null) {
    const k = await keys();
    const t = NOW / 1000;
    return signJwt(key || k.google.privateKey, { alg: 'RS256', kid: 'k1', typ: 'JWT' }, {
        aud: PROJECT, iss: `https://securetoken.google.com/${PROJECT}`, sub: 'uid_123', iat: t - 60, exp: t + 3000, auth_time: t - 60, ...over,
    });
}

async function stripeHeader(body, t = NOW / 1000, secret = WHSEC) {
    const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = Buffer.from(await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${body}`))).toString('hex');
    return `t=${t},v1=${sig}`;
}

/** A fake internet: Google keys and tokens, Stripe, Firestore. Records every call. */
async function fakeNet({ owned = null, stripeFails = false, firestoreFails = false } = {}) {
    const k = await keys();
    const calls = [];
    const fetch = async (url, init = {}) => {
        const u = String(url);
        const call = { url: u, method: init.method || 'GET', headers: init.headers || {}, body: init.body };
        calls.push(call);
        const reply = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
        if (u.startsWith('https://www.googleapis.com/service_accounts/v1/jwk/')) return reply(200, { keys: [k.jwk] }, { 'cache-control': 'public, max-age=20000' });
        if (u === 'https://oauth2.googleapis.com/token') return reply(200, { access_token: 'ya29.test', expires_in: 3599, token_type: 'Bearer' });
        if (u === 'https://api.stripe.com/v1/checkout/sessions') {
            if (stripeFails) return reply(400, { error: { message: 'No such thing' } });
            return reply(200, { id: 'cs_test_123', url: 'https://checkout.stripe.com/c/pay/cs_test_123' });
        }
        if (u.startsWith('https://firestore.googleapis.com/')) {
            if (call.method === 'PATCH') return firestoreFails ? reply(503, { error: 'unavailable' }) : reply(200, { name: 'doc' });
            if (!owned) return reply(404, { error: { status: 'NOT_FOUND' } });
            const fields = Object.fromEntries(Object.entries(owned).map(([g, v]) => [g, { booleanValue: v }]));
            return reply(200, { fields: { entitlements: { mapValue: { fields } } } });
        }
        throw new Error(`unexpected fetch ${u}`);
    };
    return { fetch, calls };
}

/** Runs fn with the server's console logging muted (it writes to Cloudflare's log view). */
async function quiet(fn) {
    const { log, error } = console;
    console.log = console.error = () => {};
    try {
        return await fn();
    } finally {
        Object.assign(console, { log, error });
    }
}

async function env() {
    return { FIREBASE_PROJECT_ID: PROJECT, APP_URLS: `${APP},http://localhost:8800/Penguin-Track/`, STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: WHSEC, GOOGLE_SERVICE_ACCOUNT: (await keys()).serviceAccount };
}

async function checkout(body, { token, origin = 'https://silverninja71.github.io', net } = {}) {
    resetCaches();
    const headers = { 'content-type': 'application/json', origin };
    if (token !== null) headers.authorization = `Bearer ${token || await idToken()}`;
    const e = await env();
    const res = await quiet(() => handle(new Request('https://pay.example.workers.dev/checkout', { method: 'POST', headers, body: JSON.stringify(body) }), e, { fetch: net.fetch, now: NOW }));
    return { res, data: await res.json() };
}

async function webhook(event, { header, net, envOver = {} } = {}) {
    resetCaches();
    const body = JSON.stringify(event);
    const e = { ...(await env()), ...envOver };
    const sig = header || await stripeHeader(body);
    const res = await quiet(() => handle(new Request('https://pay.example.workers.dev/webhook', {
        method: 'POST', headers: { 'stripe-signature': sig, 'content-type': 'application/json' }, body,
    }), e, { fetch: net.fetch, now: NOW }));
    return { res, data: await res.json() };
}

const paidEvent = (item, over = {}) => ({
    id: 'evt_1', type: 'checkout.session.completed',
    data: { object: { id: 'cs_test_123', payment_status: 'paid', client_reference_id: 'uid_123', metadata: { uid: 'uid_123', item }, amount_total: ITEMS[item] ? ITEMS[item].amount : 0, currency: 'usd', ...over } },
});

test('worker: checkout makes a one-time $3 Stripe session for the signed-in player', async () => {
    const net = await fakeNet();
    const { res, data } = await checkout({ item: 'pro_tas', returnUrl: `${APP}?screen=tas` }, { net });
    assert.equal(res.status, 200, JSON.stringify(data));
    assert.equal(data.url, 'https://checkout.stripe.com/c/pay/cs_test_123');
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://silverninja71.github.io');
    const call = net.calls.find((c) => c.url.startsWith('https://api.stripe.com/'));
    assert.equal(call.headers.authorization, 'Bearer sk_test_x');
    const f = new URLSearchParams(call.body);
    assert.equal(f.get('mode'), 'payment');
    assert.equal(f.get('line_items[0][price_data][unit_amount]'), '300');
    assert.equal(f.get('line_items[0][price_data][currency]'), 'usd');
    assert.equal(f.get('client_reference_id'), 'uid_123');
    assert.equal(f.get('metadata[uid]'), 'uid_123');
    assert.equal(f.get('metadata[item]'), 'pro_tas');
    assert.equal(f.get('success_url'), `${APP}?payment=success&item=pro_tas`);
    assert.equal(f.get('cancel_url'), `${APP}?payment=cancel&item=pro_tas`);
    // The ownership check reads Firestore as the player (rules apply), never with the service account.
    const read = net.calls.find((c) => c.url.startsWith('https://firestore.googleapis.com/'));
    assert.match(read.headers.authorization, /^Bearer ey/);
    assert.ok(!net.calls.some((c) => c.url === 'https://oauth2.googleapis.com/token'));
});

test('worker: the bundle costs $5; unknown items and owned items are refused', async () => {
    let net = await fakeNet();
    let r = await checkout({ item: 'pro_bundle' }, { net });
    assert.equal(r.res.status, 200);
    assert.equal(new URLSearchParams(net.calls.find((c) => c.url.includes('stripe')).body).get('line_items[0][price_data][unit_amount]'), '500');
    net = await fakeNet();
    r = await checkout({ item: 'gold_bars' }, { net });
    assert.equal(r.res.status, 400);
    net = await fakeNet({ owned: { pro_tas: true } });
    r = await checkout({ item: 'pro_tas' }, { net });
    assert.equal(r.res.status, 409);
    assert.ok(!net.calls.some((c) => c.url.includes('stripe')), 'no second charge');
    net = await fakeNet({ owned: { pro_tas: true } });
    r = await checkout({ item: 'pro_bundle' }, { net });
    assert.equal(r.res.status, 200, 'owning one half still allows the bundle');
    net = await fakeNet({ stripeFails: true });
    r = await checkout({ item: 'pro_ai' }, { net });
    assert.equal(r.res.status, 502);
});

test('worker: checkout needs a valid Firebase ID token for this project', async () => {
    const k = await keys();
    const t = NOW / 1000;
    const cases = [
        ['no token', null],
        ['garbage', 'not.a.token'],
        ['signed by someone else', await idToken({}, k.stranger.privateKey)],
        ['another project', await idToken({ aud: 'other-project' })],
        ['wrong issuer', await idToken({ iss: 'https://evil.example' })],
        ['expired', await idToken({ exp: t - 1 })],
        ['no uid', await idToken({ sub: '' })],
    ];
    for (const [label, token] of cases) {
        const net = await fakeNet();
        const { res } = await checkout({ item: 'pro_tas' }, { token, net });
        assert.equal(res.status, 401, label);
        assert.ok(!net.calls.some((c) => c.url.includes('stripe')), `${label}: Stripe never called`);
    }
    resetCaches();
    const net = await fakeNet();
    const ok = await verifyFirebaseToken(await idToken(), PROJECT, { fetch: net.fetch, now: NOW });
    assert.equal(ok.uid, 'uid_123');
});

test('worker: return addresses and CORS stick to APP_URLS', async () => {
    const e = await env();
    assert.equal(returnUrlFor('http://localhost:8800/Penguin-Track/?x=1#y', e), 'http://localhost:8800/Penguin-Track/');
    assert.equal(returnUrlFor('https://evil.example/steal', e), APP);
    assert.equal(returnUrlFor(undefined, e), APP);
    const pre = (origin) => handle(new Request('https://pay.example.workers.dev/checkout', { method: 'OPTIONS', headers: { origin } }), e, {});
    let res = await pre('https://silverninja71.github.io');
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://silverninja71.github.io');
    assert.match(res.headers.get('access-control-allow-headers'), /authorization/);
    res = await pre('https://evil.example');
    assert.equal(res.headers.get('access-control-allow-origin'), null);
    res = await handle(new Request('https://pay.example.workers.dev/'), e, {});
    assert.equal(res.status, 200, 'a plain GET says the server is up');
});

test('worker: a paid checkout.session.completed merges the entitlements into Firestore', async () => {
    const k = await keys();
    const net = await fakeNet();
    const { res, data } = await webhook(paidEvent('pro_bundle'), { net });
    assert.equal(res.status, 200, JSON.stringify(data));
    // Signed in to Google as the service account, with a JWT its key really signed.
    const tok = net.calls.find((c) => c.url === 'https://oauth2.googleapis.com/token');
    const assertion = new URLSearchParams(String(tok.body)).get('assertion');
    const [h, c, s] = assertion.split('.');
    const pub = await crypto.subtle.exportKey('spki', k.sa.publicKey);
    const pubKey = await crypto.subtle.importKey('spki', pub, RSA, false, ['verify']);
    assert.ok(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', pubKey, Buffer.from(s, 'base64url'), enc.encode(`${h}.${c}`)));
    const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
    assert.equal(claims.scope, 'https://www.googleapis.com/auth/datastore');
    assert.equal(claims.iss, 'payments@penguin-track-test.iam.gserviceaccount.com');
    // A masked PATCH: only these fields change, the rest of the document stays.
    const w = net.calls.find((x) => x.method === 'PATCH');
    assert.equal(w.headers.authorization, 'Bearer ya29.test');
    const u = new URL(w.url);
    assert.equal(u.pathname, `/v1/projects/${PROJECT}/databases/(default)/documents/users/uid_123`);
    assert.deepEqual(u.searchParams.getAll('updateMask.fieldPaths').sort(), ['entitlements.pro_ai', 'entitlements.pro_bundle', 'entitlements.pro_tas', 'purchases.`cs_test_123`']);
    const body = JSON.parse(w.body);
    const ents = body.fields.entitlements.mapValue.fields;
    assert.deepEqual(Object.keys(ents).sort(), ['pro_ai', 'pro_bundle', 'pro_tas']);
    assert.ok(Object.values(ents).every((v) => v.booleanValue === true));
    const p = body.fields.purchases.mapValue.fields.cs_test_123.mapValue.fields;
    assert.equal(p.item.stringValue, 'pro_bundle');
    assert.equal(p.amount.integerValue, '500');
    assert.equal(p.at.timestampValue, new Date(NOW).toISOString());
});

test('worker: the webhook refuses bad signatures and ignores unpaid or other events', async () => {
    let net = await fakeNet();
    const ev = paidEvent('pro_tas');
    let r = await webhook(ev, { net, header: await stripeHeader(JSON.stringify(ev), NOW / 1000, 'whsec_wrong') });
    assert.equal(r.res.status, 400);
    r = await webhook(ev, { net, header: await stripeHeader(JSON.stringify(ev), NOW / 1000 - 3600) });
    assert.equal(r.res.status, 400, 'an old (replayed) delivery');
    r = await webhook(ev, { net, header: 't=1,v1=abc' });
    assert.equal(r.res.status, 400);
    assert.ok(!net.calls.some((c) => c.method === 'PATCH'), 'nothing written');

    net = await fakeNet();
    r = await webhook(paidEvent('pro_tas', { payment_status: 'unpaid' }), { net });
    assert.equal(r.res.status, 200);
    r = await webhook({ id: 'evt_2', type: 'payment_intent.created', data: { object: {} } }, { net });
    assert.equal(r.res.status, 200);
    r = await webhook(paidEvent('free_money'), { net });
    assert.equal(r.res.status, 200, 'unknown item: logged, not retried');
    assert.ok(!net.calls.some((c) => c.method === 'PATCH'));

    net = await fakeNet({ firestoreFails: true });
    r = await webhook(paidEvent('pro_ai'), { net });
    assert.equal(r.res.status, 500, 'Stripe retries when the write fails');
    net = await fakeNet();
    r = await webhook(paidEvent('pro_ai'), { net, envOver: { GOOGLE_SERVICE_ACCOUNT: '' } });
    assert.equal(r.res.status, 503);
    assert.match(r.data.error, /GOOGLE_SERVICE_ACCOUNT/);
});

test('worker: Stripe signature check (several v1 values, string or bytes)', async () => {
    const body = '{"id":"evt_1"}';
    const good = await stripeHeader(body);
    assert.equal(await verifyStripeSignature(body, good, WHSEC, { now: NOW }), true);
    assert.equal(await verifyStripeSignature(enc.encode(body), good, WHSEC, { now: NOW }), true);
    assert.equal(await verifyStripeSignature(`${body} `, good, WHSEC, { now: NOW }), false, 'one changed byte');
    assert.equal(await verifyStripeSignature(body, `${good},v1=00ff`, WHSEC, { now: NOW }), true, 'rolled secrets send two');
    assert.equal(await verifyStripeSignature(body, good.replace('v1=', 'v0='), WHSEC, { now: NOW }), false);
    assert.equal(await verifyStripeSignature(body, '', WHSEC, { now: NOW }), false);
    assert.equal(await verifyStripeSignature(body, good, '', { now: NOW }), false);
});
