// Settings for accounts and payments. Everything here is safe to publish:
// a Firebase web config only names the project (Firestore security rules and
// the Cloud Functions decide what anyone may do). The Stripe secret key and
// webhook secret never belong in this file or anywhere in the game: they live
// in Firebase Secret Manager and only the Cloud Functions read them.
// docs/PAYMENTS_SETUP.md walks through filling this in.

/** Paste the web app config from Firebase console → Project settings → Your apps. */
export const FIREBASE_CONFIG = {
    apiKey: 'YOUR_FIREBASE_API_KEY',
    authDomain: 'YOUR_PROJECT_ID.firebaseapp.com',
    projectId: 'YOUR_PROJECT_ID',
    storageBucket: 'YOUR_PROJECT_ID.appspot.com',
    messagingSenderId: 'YOUR_SENDER_ID',
    appId: 'YOUR_APP_ID',
};

/** Firebase JS SDK version, loaded from gstatic.com only once the config above is filled in. */
export const FIREBASE_SDK_VERSION = '10.14.1';

/** Region the Cloud Functions are deployed to (functions/index.js uses the same). */
export const FUNCTIONS_REGION = 'us-central1';

/**
 * Pro products. `grants` lists the entitlements a purchase turns on; prices are
 * only shown here, the real amount is set by the createStripeCheckoutSession
 * Cloud Function.
 */
export const PRODUCTS = Object.freeze({
    pro_tas: { name: 'Pro TAS', price: '$3', grants: ['pro_tas'] },
    pro_ai: { name: 'Pro AI', price: '$3', grants: ['pro_ai'] },
    pro_bundle: { name: 'Pro bundle (TAS + AI)', price: '$5', grants: ['pro_tas', 'pro_ai'] },
});

/**
 * When the Pro features are locked:
 *   'auto' - only once FIREBASE_CONFIG is filled in, so nothing is taken away
 *            from players before payments can actually work (the default);
 *   'on'   - always (handy to try the paywall locally);
 *   'off'  - never.
 */
export const PRO_GATING = 'auto';

/**
 * The hub's shared site account (gold for medals, shared with the other games).
 * Optional: the game plays as a guest when it is missing. null skips it.
 */
export const SITE_ACCOUNTS_URL = '../Empire/shared/accounts.js';
