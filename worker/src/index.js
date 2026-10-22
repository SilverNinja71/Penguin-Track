// Penguintrack payments server: a Cloudflare Worker (free plan, no card
// needed). It does the job Firebase Cloud Functions would, so the Firebase
// project can stay on the free Spark plan (Auth and Firestore are free there).
//
//   POST /checkout   from the game, with "Authorization: Bearer <Firebase ID token>"
//       body { item, returnUrl } → { url } of a one-time Stripe Checkout page.
//   POST /webhook    from Stripe
//       checks the Stripe-Signature header against the raw body, and on
//       checkout.session.completed merges users/{uid}.entitlements[item] = true
//       in Firestore, as a Google service account (which skips the security
//       rules that stop players from writing it themselves).
//
// Settings (worker/wrangler.toml [vars]): FIREBASE_PROJECT_ID, APP_URLS.
// Secrets (npx wrangler secret put NAME): STRIPE_SECRET_KEY,
// STRIPE_WEBHOOK_SECRET, GOOGLE_SERVICE_ACCOUNT (the service account's whole
// JSON key file). No libraries: Stripe, Google and Firestore are plain fetch()
// calls and the signatures are checked with the Web Crypto API Workers have.

/** What can be bought. Amounts are in cents; `grants` are the entitlements turned on. */
export const ITEMS = Object.freeze({
    pro_tas: { name: 'Penguintrack Pro TAS', amount: 300, grants: ['pro_tas'] },
    pro_ai: { name: 'Penguintrack Pro AI', amount: 300, grants: ['pro_ai'] },
    pro_bundle: { name: 'Penguintrack Pro bundle (TAS + AI)', amount: 500, grants: ['pro_tas', 'pro_ai'] },
});

const GOOGLE_JWKS = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const STRIPE_SESSIONS = 'https://api.stripe.com/v1/checkout/sessions';
const PAID_EVENTS = new Set(['checkout.session.completed', 'checkout.session.async_payment_succeeded']);

const enc = new TextEncoder();
const dec = new TextDecoder();

class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

// ------------------------------------------------------------------ bytes

function b64urlToBytes(s) {
    let b = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (b.length % 4) b += '=';
    return Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
}

function bytesToB64url(bytes) {
    let bin = '';
    for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const jsonB64url = (o) => bytesToB64url(enc.encode(JSON.stringify(o)));
const toHex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

function concatBytes(a, b) {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
}

/** Compares two strings in time that does not depend on where they differ. */
function sameString(a, b) {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

// Keys and tokens fetched from Google, kept between requests while valid.
let jwksCache = { keys: null, until: 0 };
let accessCache = { token: null, until: 0, email: null };

/** Forgets the cached Google keys and access token (tests). */
export function resetCaches() {
    jwksCache = { keys: null, until: 0 };
    accessCache = { token: null, until: 0, email: null };
}

// ------------------------------------------------------------------ Stripe signature

/**
 * True when `header` (Stripe-Signature: t=…,v1=…) signs `payload` (the raw
 * body, string or bytes) with `secret`, at most `tolerance` seconds ago.
 */
export async function verifyStripeSignature(payload, header, secret, { now = Date.now(), tolerance = 300 } = {}) {
    if (!header || !secret) return false;
    let t = null;
    const sigs = [];
    for (const part of String(header).split(',')) {
        const i = part.indexOf('=');
        const k = part.slice(0, i).trim();
        const v = part.slice(i + 1).trim();
        if (k === 't') t = v;
        else if (k === 'v1') sigs.push(v);
    }
    if (!t || !/^\d+$/.test(t) || !sigs.length) return false;
    if (Math.abs(now / 1000 - Number(t)) > tolerance) return false;
    const body = typeof payload === 'string' ? enc.encode(payload) : payload;
    const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const expected = toHex(await crypto.subtle.sign('HMAC', key, concatBytes(enc.encode(`${t}.`), body)));
    return sigs.some((s) => sameString(s, expected));
}

// ------------------------------------------------------------------ Firebase ID tokens

async function googleKeys(fetchFn, now) {
    if (jwksCache.keys && now < jwksCache.until) return jwksCache.keys;
    const res = await fetchFn(GOOGLE_JWKS);
    if (!res.ok) throw new Error(`Google keys: HTTP ${res.status}`);
    const { keys } = await res.json();
    const maxAge = /max-age=(\d+)/.exec(res.headers.get('cache-control') || '');
    jwksCache = { keys, until: now + (maxAge ? Number(maxAge[1]) : 3600) * 1000 };
    return keys;
}

/** Checks a Firebase Auth ID token for `projectId`. Resolves { uid, claims }; throws a 401 otherwise. */
export async function verifyFirebaseToken(token, projectId, { fetch: fetchFn = fetch, now = Date.now() } = {}) {
    const bad = () => new HttpError(401, 'Sign in again, then try once more.');
    const parts = String(token || '').split('.');
    if (parts.length !== 3 || !projectId) throw bad();
    let header;
    let claims;
    try {
        header = JSON.parse(dec.decode(b64urlToBytes(parts[0])));
        claims = JSON.parse(dec.decode(b64urlToBytes(parts[1])));
    } catch (e) {
        throw bad();
    }
    if (header.alg !== 'RS256' || !header.kid) throw bad();
    const jwk = (await googleKeys(fetchFn, now)).find((k) => k.kid === header.kid);
    if (!jwk) throw bad();
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const signed = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlToBytes(parts[2]), enc.encode(`${parts[0]}.${parts[1]}`));
    const t = Math.floor(now / 1000);
    const ok = signed
        && claims.aud === projectId
        && claims.iss === `https://securetoken.google.com/${projectId}`
        && claims.exp > t
        && claims.iat <= t + 300
        && typeof claims.sub === 'string' && claims.sub.length > 0 && claims.sub.length <= 128;
    if (!ok) throw bad();
    return { uid: claims.sub, claims };
}

// ------------------------------------------------------------------ Firestore as the service account

function pemToBytes(pem) {
    const b64 = String(pem).replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/** An OAuth access token for Firestore, signed with the service account's private key. */
export async function googleAccessToken(serviceAccount, { fetch: fetchFn = fetch, now = Date.now() } = {}) {
    let sa;
    try {
        sa = typeof serviceAccount === 'string' ? JSON.parse(serviceAccount) : serviceAccount;
    } catch (e) {
        throw new Error('GOOGLE_SERVICE_ACCOUNT is not valid JSON');
    }
    if (!sa || !sa.client_email || !sa.private_key) throw new Error('GOOGLE_SERVICE_ACCOUNT is missing client_email or private_key');
    if (accessCache.token && accessCache.email === sa.client_email && now < accessCache.until) return accessCache.token;
    const iat = Math.floor(now / 1000);
    const unsigned = `${jsonB64url({ alg: 'RS256', typ: 'JWT' })}.${jsonB64url({
        iss: sa.client_email, scope: 'https://www.googleapis.com/auth/datastore', aud: GOOGLE_TOKEN, iat, exp: iat + 3600,
    })}`;
    const key = await crypto.subtle.importKey('pkcs8', pemToBytes(sa.private_key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(unsigned));
    const res = await fetchFn(GOOGLE_TOKEN, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${bytesToB64url(sig)}` }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) throw new Error(`Google token: HTTP ${res.status} ${data.error || ''}`);
    accessCache = { token: data.access_token, until: now + ((data.expires_in || 3600) - 60) * 1000, email: sa.client_email };
    return data.access_token;
}

/** A plain value as a Firestore REST value. */
function fsValue(v) {
    if (v === null || v === undefined) return { nullValue: null };
    if (typeof v === 'boolean') return { booleanValue: v };
    if (Number.isInteger(v)) return { integerValue: String(v) };
    if (typeof v === 'number') return { doubleValue: v };
    if (v instanceof Date) return { timestampValue: v.toISOString() };
    if (typeof v === 'object') return { mapValue: { fields: fsFields(v) } };
    return { stringValue: String(v) };
}

function fsFields(o) {
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, fsValue(v)]));
}

const docUrl = (projectId, uid) => `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/users/${encodeURIComponent(uid)}`;

/**
 * Turns on what a paid Checkout session bought: merges
 * users/{uid}.entitlements and records the purchase. Safe to repeat (Stripe
 * retries). Returns false for a session without a uid or a known item.
 */
export async function grantPurchase(env, session, eventId, deps) {
    const uid = session.client_reference_id || (session.metadata && session.metadata.uid);
    const item = session.metadata && session.metadata.item;
    const product = ITEMS[item];
    if (!uid || !product || !/^[\w-]+$/.test(String(session.id || ''))) {
        console.error('paid session without a uid, a known item or an id', session.id, uid, item);
        return false;
    }
    const entitlements = { [item]: true };
    for (const g of product.grants) entitlements[g] = true;
    const purchase = { item, amount: session.amount_total ?? null, currency: session.currency || null, eventId: eventId || null, at: new Date(deps.now) };
    const mask = [...Object.keys(entitlements).map((k) => `entitlements.${k}`), `purchases.\`${session.id}\``];
    const token = await googleAccessToken(env.GOOGLE_SERVICE_ACCOUNT, deps);
    const url = `${docUrl(env.FIREBASE_PROJECT_ID, uid)}?${mask.map((f) => `updateMask.fieldPaths=${encodeURIComponent(f)}`).join('&')}`;
    const res = await deps.fetch(url, {
        method: 'PATCH',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ fields: fsFields({ entitlements, purchases: { [session.id]: purchase } }) }),
    });
    if (!res.ok) throw new Error(`Firestore write: HTTP ${res.status} ${await res.text().catch(() => '')}`);
    console.log('entitlement granted', uid, item, session.id);
    return true;
}

/** True when users/{uid} already has every entitlement `product` grants (read with the player's own token). */
async function alreadyOwns(env, uid, idToken, product, deps) {
    try {
        const res = await deps.fetch(docUrl(env.FIREBASE_PROJECT_ID, uid), { headers: { authorization: `Bearer ${idToken}` } });
        if (!res.ok) return false;
        const doc = await res.json();
        const owned = (doc.fields && doc.fields.entitlements && doc.fields.entitlements.mapValue && doc.fields.entitlements.mapValue.fields) || {};
        return product.grants.every((g) => owned[g] && owned[g].booleanValue === true);
    } catch (e) {
        return false;
    }
}

// ------------------------------------------------------------------ routes

const appUrls = (env) => String(env.APP_URLS || '').split(',').map((s) => s.trim()).filter(Boolean);

/** `requested` when it is one of APP_URLS (query and hash ignored), else the first APP_URL. */
export function returnUrlFor(requested, env) {
    const allowed = appUrls(env);
    let clean = null;
    try {
        const u = new URL(String(requested || ''));
        clean = u.origin + u.pathname;
    } catch (e) { /* not a URL: use the default */ }
    return clean && allowed.includes(clean) ? clean : allowed[0];
}

function corsHeaders(request, env) {
    const h = {
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers': 'authorization, content-type',
        'access-control-max-age': '86400',
        vary: 'Origin',
    };
    const origin = request.headers.get('origin');
    const origins = appUrls(env).map((u) => {
        try {
            return new URL(u).origin;
        } catch (e) {
            return null;
        }
    });
    if (origin && origins.includes(origin)) h['access-control-allow-origin'] = origin;
    return h;
}

function json(body, status = 200, headers = {}) {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function needSettings(env, names) {
    const missing = names.filter((n) => !env[n] || String(env[n]).startsWith('YOUR_'));
    if (missing.length) throw new HttpError(503, `The payments server is missing ${missing.join(', ')}.`);
}

async function checkout(request, env, deps) {
    needSettings(env, ['FIREBASE_PROJECT_ID', 'APP_URLS', 'STRIPE_SECRET_KEY']);
    const m = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') || '');
    if (!m) throw new HttpError(401, 'Sign in before buying.');
    const { uid } = await verifyFirebaseToken(m[1], env.FIREBASE_PROJECT_ID, deps);
    let data;
    try {
        data = await request.json();
    } catch (e) {
        throw new HttpError(400, 'Bad request.');
    }
    const item = String((data && data.item) || '');
    const product = ITEMS[item];
    if (!product) throw new HttpError(400, 'Unknown item.');
    if (await alreadyOwns(env, uid, m[1], product, deps)) throw new HttpError(409, 'You already own this. Enjoy!');

    const base = returnUrlFor(data.returnUrl, env);
    const back = (status) => `${base}?payment=${status}&item=${item}`;
    const form = new URLSearchParams({
        mode: 'payment',
        'line_items[0][quantity]': '1',
        'line_items[0][price_data][currency]': 'usd',
        'line_items[0][price_data][unit_amount]': String(product.amount),
        'line_items[0][price_data][product_data][name]': product.name,
        client_reference_id: uid,
        'metadata[uid]': uid,
        'metadata[item]': item,
        'payment_intent_data[metadata][uid]': uid,
        'payment_intent_data[metadata][item]': item,
        success_url: back('success'),
        cancel_url: back('cancel'),
    });
    const res = await deps.fetch(STRIPE_SESSIONS, {
        method: 'POST',
        headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: form,
    });
    const session = await res.json().catch(() => ({}));
    if (!res.ok || !session.url) {
        console.error('stripe checkout failed', res.status, session.error && session.error.message);
        throw new HttpError(502, 'Checkout could not start. Please try again.');
    }
    console.log('checkout session created', uid, item, session.id);
    return { url: session.url, id: session.id };
}

async function webhook(request, env, deps) {
    needSettings(env, ['FIREBASE_PROJECT_ID', 'STRIPE_WEBHOOK_SECRET', 'GOOGLE_SERVICE_ACCOUNT']);
    // The signature covers the exact bytes Stripe sent: check the raw body, not re-encoded JSON.
    const body = new Uint8Array(await request.arrayBuffer());
    const ok = await verifyStripeSignature(body, request.headers.get('stripe-signature'), env.STRIPE_WEBHOOK_SECRET, { now: deps.now });
    if (!ok) throw new HttpError(400, 'Signature check failed');
    const event = JSON.parse(dec.decode(body));
    const session = event.data && event.data.object;
    if (PAID_EVENTS.has(event.type) && session && session.payment_status === 'paid') {
        await grantPurchase(env, session, event.id, deps);   // a failure answers 500, so Stripe retries
    }
    return { received: true };
}

/** Handles one request. `deps` swaps fetch and the clock (tests). */
export async function handle(request, env, deps = {}) {
    const d = { fetch: deps.fetch || ((...a) => fetch(...a)), now: deps.now ?? Date.now() };
    const path = new URL(request.url).pathname.replace(/\/+$/, '') || '/';
    const cors = path === '/checkout' ? corsHeaders(request, env) : {};
    try {
        if (path === '/checkout') {
            if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
            if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed');
            return json(await checkout(request, env, d), 200, cors);
        }
        if (path === '/webhook') {
            if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed');
            return json(await webhook(request, env, d));
        }
        if (path === '/' && request.method === 'GET') return new Response('Penguintrack payments server is running.\n', { headers: { 'content-type': 'text/plain' } });
        throw new HttpError(404, 'Not found');
    } catch (e) {
        if (e instanceof HttpError) return json({ error: e.message }, e.status, cors);
        console.error('payments server error', e && e.stack ? e.stack : e);
        return json({ error: 'Something went wrong on the payments server.' }, 500, cors);
    }
}

export default {
    fetch: (request, env) => handle(request, env),
};
