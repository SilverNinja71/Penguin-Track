// Medal rules shared by the campaign screens, results, records and tools.
//
// Race tracks: every medal is a time in ms; a run earns the best medal whose
// time it beats or equals (respawns do not matter, the clock already paid).
// Platform tracks rank by respawns first, then time:
//   medals = { author: ms, gold: 0, silver: 3, bronze: 10 }
// where `author` (the Emperor) is a time that must be reached with 0 respawns
// and gold / silver / bronze are the MOST respawns allowed for that medal.
// Custom platform tracks may also use the track-format object form
// { respawns, ms } for any medal; both shapes are understood here.
import { formatTime } from '../core/format.js';

/** Best first. `author` in track.medals is the Emperor medal. */
export const MEDALS = ['emperor', 'gold', 'silver', 'bronze'];

export const MEDAL_LABELS = { emperor: 'Emperor', gold: 'Gold', silver: 'Silver', bronze: 'Bronze' };

/** Shared-profile gold for a medal earned for the first time (ARCHITECTURE.md, Storage). */
export const MEDAL_REWARDS = { emperor: 60, gold: 30, silver: 15, bronze: 5 };

const KEY = { emperor: 'author', gold: 'gold', silver: 'silver', bronze: 'bronze' };

/** 0 = Emperor ... 3 = Bronze, 4 = no medal. Lower is better. */
export function medalRank(medal) {
    const i = MEDALS.indexOf(medal);
    return i < 0 ? MEDALS.length : i;
}

/** The better of two medals (either may be null). */
export function bestMedal(a, b) {
    return medalRank(a) <= medalRank(b) ? (a || null) : (b || null);
}

function isPlatform(track) {
    return !!track && track.mode === 'platform';
}

/**
 * The requirement of one medal as { respawns, ms } (either may be null = no
 * limit), or null when the track has no such medal.
 */
export function medalRequirement(track, medal) {
    const v = track && track.medals ? track.medals[KEY[medal]] : null;
    if (v == null) return null;
    if (typeof v === 'object') {
        const respawns = Number.isFinite(v.respawns) ? v.respawns : null;
        const ms = Number.isFinite(v.ms) ? v.ms : null;
        return respawns === null && ms === null ? null : { respawns, ms };
    }
    if (!Number.isFinite(v)) return null;
    if (!isPlatform(track)) return { respawns: null, ms: v };
    // Platform shorthand: the Emperor is a clean run's time, the rest are respawn caps.
    return medal === 'emperor' ? { respawns: 0, ms: v } : { respawns: v, ms: null };
}

/**
 * Best medal a finished run earns: 'emperor' | 'gold' | 'silver' | 'bronze' | null.
 * run = { timeMs, respawns }.
 */
export function medalFor(track, run) {
    if (!run || !Number.isFinite(run.timeMs)) return null;
    const respawns = Number.isFinite(run.respawns) ? run.respawns : 0;
    for (const m of MEDALS) {
        const req = medalRequirement(track, m);
        if (!req) continue;
        if (req.respawns !== null && respawns > req.respawns) continue;
        if (req.ms !== null && run.timeMs > req.ms) continue;
        return m;
    }
    return null;
}

/**
 * True when run `a` beats run `b` (null/unfinished b always loses). Race: lower
 * time. Platform: fewer respawns, then lower time.
 */
export function isBetterRun(track, a, b) {
    if (!a || !Number.isFinite(a.timeMs)) return false;
    if (!b || !Number.isFinite(b.timeMs)) return true;
    if (isPlatform(track)) {
        const ra = a.respawns || 0, rb = b.respawns || 0;
        if (ra !== rb) return ra < rb;
    }
    return a.timeMs < b.timeMs;
}

/** Text for one requirement, e.g. '0:42.37', '0 respawns', '≤ 3 respawns', '0 respawns · 0:31.20'. */
export function formatRequirement(req) {
    if (!req) return '—';
    const parts = [];
    if (req.respawns !== null) {
        parts.push(req.respawns === 0 ? 'no respawns' : `≤ ${req.respawns} respawn${req.respawns === 1 ? '' : 's'}`);
    }
    if (req.ms !== null) parts.push(formatTime(req.ms));
    return parts.join(' · ');
}

/**
 * Every medal of a track, best first:
 * [{ medal, label, value, respawns, ms, kind: 'time' | 'respawns' | 'both', text }].
 * `value` is the stored number (ms for time medals, the respawn cap otherwise).
 */
export function medalTargets(track) {
    const out = [];
    for (const m of MEDALS) {
        const req = medalRequirement(track, m);
        if (!req) continue;
        const kind = req.ms !== null && req.respawns !== null && req.respawns > 0 ? 'both'
            : req.ms !== null ? 'time' : 'respawns';
        const raw = track.medals[KEY[m]];
        out.push({
            medal: m,
            label: MEDAL_LABELS[m],
            value: typeof raw === 'object' ? (req.ms ?? req.respawns) : raw,
            respawns: req.respawns,
            ms: req.ms,
            kind,
            text: formatRequirement(req),
        });
    }
    return out;
}

/** Display text for one entry of medalTargets(), or for (track, medal). */
export function formatMedalTarget(target, medal) {
    if (target && typeof target === 'object' && 'medal' in target && 'text' in target) return target.text;
    // formatMedalTarget(track, 'gold')
    return formatRequirement(medalRequirement(target, medal));
}

/**
 * The next medal to chase after `current` (null = none yet): its target entry,
 * or null when the Emperor is already won or the track has no medals.
 */
export function nextMedalTarget(track, current) {
    const targets = medalTargets(track);
    const rank = medalRank(current);
    for (let i = targets.length - 1; i >= 0; i--) {
        if (medalRank(targets[i].medal) < rank) return targets[i];
    }
    return null;
}
