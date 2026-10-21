// Links friends can open: an invite into an online room (?room=CODE) and a
// whole custom track packed into the address (#track=PT1.…). The track rides in
// the #hash so it never reaches a server and has no length limit from one.

/** The game's own address without any query or hash. */
function base() {
    return location.origin + location.pathname;
}

/** Invite into an online room. `host` makes the opener open the room with that code (party leaders). */
export function roomLink(code, host = false) {
    return `${base()}?room=${encodeURIComponent(code)}${host ? '&host=1' : ''}`;
}

/** A custom track as a link; opening it imports the track into My Tracks. */
export function trackLink(code) {
    return `${base()}#track=${code}`;
}

/**
 * What the page was opened with: { room, host } for an invite, { track } for a
 * track link, or null. A track link is read once: the hash is cleared so a
 * reload doesn't import it again.
 */
export function readLaunchLink(query = new URLSearchParams(location.search)) {
    const room = (query.get('room') || '').trim();
    if (room) return { room, host: query.get('host') === '1' };
    const m = /^#track=(PT1\.[A-Za-z0-9_-]+)$/.exec(location.hash || '');
    if (m) {
        try {
            history.replaceState(null, '', base() + location.search);
        } catch (e) { /* ignore */ }
        return { track: m[1] };
    }
    return null;
}
