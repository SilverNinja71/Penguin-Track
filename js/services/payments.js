// Buying Pro with Stripe Checkout. The flow:
//   1. startCheckout(item) asks the createStripeCheckoutSession Cloud Function
//      (signed in: anonymously if need be) for a Checkout page and goes there.
//   2. Stripe takes the payment and calls the stripeWebhook Cloud Function,
//      which writes users/{uid}.entitlements[item] = true in Firestore.
//   3. Stripe sends the player back here with ?payment=success&item=…; the
//      game shows a toast and tidies the address. listenToEntitlements() sees
//      the Firestore change and the feature unlocks without a reload.
// No Stripe keys live in the game: the secret key and webhook secret are only
// in the Cloud Functions' secret storage.
import { PRODUCTS } from './config.js';
import { firebaseConfigured, initFirebase, ensureUser, onUserChanged } from './firebase.js';
import { setEntitlements, applyCachedEntitlements, onEntitlementsChange, PRO_FEATURES } from './entitlements.js';

/** Sends the player to Stripe Checkout for `item` ('pro_tas', 'pro_ai' or 'pro_bundle'). */
export async function startCheckout(item) {
    if (!PRODUCTS[item]) throw new Error(`Unknown item ${item}`);
    if (!firebaseConfigured()) throw new Error('Payments are not set up on this copy of the game yet.');
    const fb = await initFirebase();
    if (!fb) throw new Error('Could not reach the payment server. Check your connection and try again.');
    await ensureUser();
    const call = fb.sdk.functions.httpsCallable(fb.functions, 'createStripeCheckoutSession');
    const res = await call({ item, returnUrl: location.origin + location.pathname });
    const url = res && res.data && res.data.url;
    if (typeof url !== 'string' || !url.startsWith('https://checkout.stripe.com/')) throw new Error('Checkout did not start. Please try again.');
    location.assign(url);
}

/**
 * Calls cb(entitlements, { fromCache }) with users/{uid}.entitlements now and
 * on every change (Firestore onSnapshot). Returns an unsubscribe function.
 */
export function listenToEntitlements(uid, cb) {
    let off = null;
    let stopped = false;
    initFirebase().then((fb) => {
        if (stopped || !fb || !uid) return;
        const F = fb.sdk.firestore;
        off = F.onSnapshot(F.doc(fb.db, 'users', uid), { includeMetadataChanges: false },
            (snap) => cb((snap.exists() && snap.data().entitlements) || {}, { fromCache: snap.metadata.fromCache }),
            (err) => console.warn('[penguintrack] entitlements listener:', err && err.message));
    });
    return () => {
        stopped = true;
        if (off) off();
    };
}

/** { status: 'success'|'cancel', item } from ?payment=…&item=…, or null. */
export function readPaymentReturn(search) {
    const q = new URLSearchParams(search || '');
    const status = q.get('payment');
    if (status !== 'success' && status !== 'cancel') return null;
    const item = q.get('item');
    return { status, item: PRODUCTS[item] ? item : null };
}

/** The address without the payment query (other parameters and the hash kept). */
export function stripPaymentQuery(href) {
    const u = new URL(href);
    u.searchParams.delete('payment');
    u.searchParams.delete('item');
    u.searchParams.delete('session_id');
    return u.pathname + (u.searchParams.toString() ? `?${u.searchParams}` : '') + u.hash;
}

/** Shows the "thanks" toast after Stripe sends the player back, and clears the query. */
export function handlePaymentReturn(app) {
    const r = readPaymentReturn(location.search);
    if (!r) return null;
    history.replaceState(history.state, '', stripPaymentQuery(location.href));
    const name = r.item ? PRODUCTS[r.item].name : 'Pro';
    if (r.status === 'success') app.toast(`Payment received, thank you! ${name} unlocks in a moment.`, { kind: 'gold', icon: 'check', ms: 6000 });
    else app.toast('Checkout cancelled: nothing was charged.', { ms: 4000 });
    return r;
}

/**
 * Keeps the entitlements in step with the signed-in Firebase user: the cached
 * copy at once, then Firestore's live answer. Toasts when something unlocks.
 */
export function initPayments(app) {
    handlePaymentReturn(app);
    if (!firebaseConfigured()) return;
    let stop = null;
    let owned = null;
    onEntitlementsChange((s) => {
        const now = { pro_tas: s.pro_tas, pro_ai: s.pro_ai };
        if (owned && s.source === 'server') {
            for (const k of Object.keys(now)) {
                if (now[k] && !owned[k]) app.toast(`${PRO_FEATURES[k].title} unlocked. Have fun!`, { kind: 'gold', icon: 'check', ms: 5000 });
            }
        }
        owned = now;
    });
    onUserChanged((user) => {
        if (stop) stop();
        stop = null;
        if (!user) {
            setEntitlements(null, null, 'none');
            return;
        }
        applyCachedEntitlements(user.uid);
        stop = listenToEntitlements(user.uid, (ents, meta) => setEntitlements(user.uid, ents, meta.fromCache ? 'cache' : 'server'));
    });
}
