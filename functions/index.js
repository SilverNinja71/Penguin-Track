// Penguintrack Cloud Functions: one-time Stripe Checkout payments for the Pro
// tiers ($3 Pro TAS, $3 Pro AI, $5 for both).
//
//   createStripeCheckoutSession (callable, signed-in players only)
//       → a Stripe Checkout page for one item; the game redirects there.
//   stripeWebhook (HTTPS endpoint Stripe calls)
//       → checks Stripe's signature on the raw body, and on
//         checkout.session.completed merges users/{uid}.entitlements[item] = true.
//
// The Stripe secret key and webhook signing secret are Firebase secrets
// (firebase functions:secrets:set …), never in this file or the game.
// docs/PAYMENTS_SETUP.md has the full setup.
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const { defineSecret, defineString } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const Stripe = require('stripe');

admin.initializeApp();
const db = admin.firestore();

// Keep in step with FUNCTIONS_REGION in js/services/config.js.
setGlobalOptions({ region: 'us-central1', maxInstances: 10 });

const STRIPE_SECRET_KEY = defineSecret('STRIPE_SECRET_KEY');
const STRIPE_WEBHOOK_SECRET = defineSecret('STRIPE_WEBHOOK_SECRET');
// The game's address(es) Checkout may send players back to, comma-separated.
// The first one is the default. Add http://localhost:8080/Penguin-Track/ (or
// similar) while testing locally.
const APP_URLS = defineString('APP_URLS', { default: 'https://silverninja71.github.io/Penguin-Track/' });

/** What can be bought. Amounts are in cents; `grants` are the entitlements turned on. */
const ITEMS = {
    pro_tas: { name: 'Penguintrack Pro TAS', amount: 300, grants: ['pro_tas'] },
    pro_ai: { name: 'Penguintrack Pro AI', amount: 300, grants: ['pro_ai'] },
    pro_bundle: { name: 'Penguintrack Pro bundle (TAS + AI)', amount: 500, grants: ['pro_tas', 'pro_ai'] },
};

let stripe = null;
function stripeClient() {
    if (!stripe) stripe = new Stripe(STRIPE_SECRET_KEY.value());
    return stripe;
}

/** `requested` when it is one of APP_URLS (query and hash ignored), else the first APP_URL. */
function returnUrlFor(requested) {
    const allowed = APP_URLS.value().split(',').map((s) => s.trim()).filter(Boolean);
    let clean = null;
    try {
        const u = new URL(String(requested || ''));
        clean = u.origin + u.pathname;
    } catch (e) { /* not a URL: use the default */ }
    return clean && allowed.includes(clean) ? clean : allowed[0];
}

exports.createStripeCheckoutSession = onCall({ secrets: [STRIPE_SECRET_KEY] }, async (request) => {
    if (!request.auth || !request.auth.uid) throw new HttpsError('unauthenticated', 'Sign in before buying.');
    const uid = request.auth.uid;
    const data = request.data || {};
    const item = String(data.item || '');
    const product = ITEMS[item];
    if (!product) throw new HttpsError('invalid-argument', 'Unknown item.');

    const snap = await db.doc(`users/${uid}`).get();
    const owned = (snap.exists && snap.get('entitlements')) || {};
    if (product.grants.every((g) => owned[g] === true)) throw new HttpsError('already-exists', 'You already own this. Enjoy!');

    const base = returnUrlFor(data.returnUrl);
    const back = (status) => `${base}?payment=${status}&item=${item}`;
    const session = await stripeClient().checkout.sessions.create({
        mode: 'payment',
        line_items: [{
            quantity: 1,
            price_data: { currency: 'usd', unit_amount: product.amount, product_data: { name: product.name } },
        }],
        client_reference_id: uid,
        metadata: { uid, item },
        payment_intent_data: { metadata: { uid, item } },
        success_url: back('success'),
        cancel_url: back('cancel'),
    });
    logger.info('checkout session created', { uid, item, session: session.id });
    return { url: session.url, id: session.id };
});

/** Turns on the entitlements a paid Checkout session bought (safe to repeat: Stripe may retry). */
async function grantPurchase(session, eventId) {
    const uid = session.client_reference_id || (session.metadata && session.metadata.uid);
    const item = session.metadata && session.metadata.item;
    const product = ITEMS[item];
    if (!uid || !product) {
        logger.error('paid session without a uid or a known item', { session: session.id, uid, item });
        return;
    }
    const entitlements = { [item]: true };
    for (const g of product.grants) entitlements[g] = true;
    await db.doc(`users/${uid}`).set({
        entitlements,
        purchases: {
            [session.id]: {
                item,
                amount: session.amount_total,
                currency: session.currency,
                eventId,
                at: admin.firestore.FieldValue.serverTimestamp(),
            },
        },
    }, { merge: true });
    logger.info('entitlement granted', { uid, item, session: session.id });
}

exports.stripeWebhook = onRequest({ secrets: [STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET] }, async (req, res) => {
    if (req.method !== 'POST') {
        res.set('Allow', 'POST').status(405).send('Method not allowed');
        return;
    }
    let event;
    try {
        // The signature covers the exact bytes Stripe sent, so check the raw body, not the parsed JSON.
        event = stripeClient().webhooks.constructEvent(req.rawBody, req.get('stripe-signature'), STRIPE_WEBHOOK_SECRET.value());
    } catch (err) {
        logger.warn('webhook signature check failed', { message: err.message });
        res.status(400).send('Signature check failed');
        return;
    }
    try {
        if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
            const session = event.data.object;
            if (session.payment_status === 'paid') await grantPurchase(session, event.id);
        }
    } catch (err) {
        // A 500 makes Stripe retry later.
        logger.error('webhook handling failed', { event: event.id, message: err.message });
        res.status(500).send('Could not record the purchase');
        return;
    }
    res.json({ received: true });
});
