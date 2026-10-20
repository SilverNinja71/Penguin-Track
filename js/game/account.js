// The shared site account (../shared/accounts.js, window.GameAccounts) is
// optional. When a player is signed in, the profile everyone plays with lives
// in localStorage under 'spear_mace_user_profile'; first-time medals add gold to it.
const PROFILE_KEY = 'spear_mace_user_profile';

function readProfile() {
    try {
        const raw = localStorage.getItem(PROFILE_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch (e) {
        return null;
    }
}

/** { username, gold } for the signed-in player, or null (guest, or accounts not loaded). */
export function currentAccount() {
    const A = window.GameAccounts;
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
    return !!(window.GameAccounts && typeof window.GameAccounts.current === 'function');
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
