// Firebase for accounts and purchases: Auth (anonymous and Google) and
// Firestore. The SDK is only fetched (from gstatic.com) once config.js holds
// a real project; until then everything here quietly reports "not configured"
// and the game plays exactly as before, as a guest.
import { FIREBASE_CONFIG, FIREBASE_SDK_VERSION, FUNCTIONS_REGION } from './config.js';

/** True once config.js holds a real Firebase project (not the YOUR_… placeholders). */
export function firebaseConfigured(cfg = FIREBASE_CONFIG) {
    const real = (v) => typeof v === 'string' && v.length > 0 && !v.startsWith('YOUR_');
    return !!cfg && real(cfg.apiKey) && real(cfg.projectId) && real(cfg.appId);
}

let ready = null;

/**
 * Loads and starts Firebase once. Resolves { app, auth, db, functions, sdk }
 * or null (not configured, offline, or blocked). A failed load is retried on
 * the next call.
 */
export function initFirebase() {
    if (!firebaseConfigured()) return Promise.resolve(null);
    if (!ready) {
        ready = load().catch((e) => {
            console.warn('[penguintrack] Firebase could not start:', e && e.message);
            ready = null;
            return null;
        });
    }
    return ready;
}

async function load() {
    const base = `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/`;
    const [appSdk, authSdk, storeSdk, fnSdk] = await Promise.all(
        ['firebase-app.js', 'firebase-auth.js', 'firebase-firestore.js', 'firebase-functions.js'].map((f) => import(base + f)));
    const app = appSdk.initializeApp(FIREBASE_CONFIG);
    const auth = authSdk.getAuth(app);
    const db = storeSdk.getFirestore(app);
    const functions = fnSdk.getFunctions(app, FUNCTIONS_REGION);
    const fb = { app, auth, db, functions, sdk: { auth: authSdk, firestore: storeSdk, functions: fnSdk } };
    // Finishes a Google sign-in that went through a full-page redirect.
    try {
        await authSdk.getRedirectResult(auth);
    } catch (e) {
        await recoverFromLinkError(fb, e).catch((err) => console.warn('[penguintrack] Google sign-in failed:', err && err.message));
    }
    return fb;
}

/** Calls cb(user | null) now and whenever the signed-in Firebase user changes. Returns an unsubscribe function. */
export function onUserChanged(cb) {
    let off = null;
    let stopped = false;
    initFirebase().then((fb) => {
        if (stopped) return;
        if (!fb) {
            cb(null);
            return;
        }
        off = fb.sdk.auth.onAuthStateChanged(fb.auth, cb);
    });
    return () => {
        stopped = true;
        if (off) off();
    };
}

/** The signed-in user, signing in anonymously first when nobody is (purchases need a uid). */
export async function ensureUser() {
    const fb = await initFirebase();
    if (!fb) throw new Error('Accounts are not set up on this copy of the game yet.');
    if (fb.auth.currentUser) return fb.auth.currentUser;
    const cred = await fb.sdk.auth.signInAnonymously(fb.auth);
    return cred.user;
}

/**
 * Google sign-in. An anonymous player is linked instead, so the uid (and
 * anything bought as a guest) carries over. Tries a popup and falls back to a
 * full-page redirect when the browser blocks popups.
 */
export async function signInWithGoogle({ redirect = false } = {}) {
    const fb = await initFirebase();
    if (!fb) throw new Error('Accounts are not set up on this copy of the game yet.');
    const A = fb.sdk.auth;
    const provider = new A.GoogleAuthProvider();
    const cur = fb.auth.currentUser;
    try {
        if (cur && cur.isAnonymous) {
            if (redirect) return await A.linkWithRedirect(cur, provider);
            return (await A.linkWithPopup(cur, provider)).user;
        }
        if (redirect) return await A.signInWithRedirect(fb.auth, provider);
        return (await A.signInWithPopup(fb.auth, provider)).user;
    } catch (e) {
        const code = e && e.code;
        if (!redirect && (code === 'auth/popup-blocked' || code === 'auth/operation-not-supported-in-environment')) {
            return signInWithGoogle({ redirect: true });
        }
        const user = await recoverFromLinkError(fb, e);
        if (user) return user;
        throw e;
    }
}

/**
 * That Google account already has its own uid (it bought or signed in on
 * another device): switch to it instead of linking. Returns the user, or null
 * when `e` is some other error.
 */
async function recoverFromLinkError(fb, e) {
    if (!e || e.code !== 'auth/credential-already-in-use') {
        if (e) throw e;
        return null;
    }
    const cred = fb.sdk.auth.GoogleAuthProvider.credentialFromError(e);
    if (!cred) throw e;
    return (await fb.sdk.auth.signInWithCredential(fb.auth, cred)).user;
}

export async function signOutFirebase() {
    const fb = await initFirebase();
    if (fb) await fb.sdk.auth.signOut(fb.auth);
}
