// Official tracks and the campaign index. Tracks are authored as path-builder
// specs (one file per tier); medals, author ghosts and layout hashes come from
// baked.js, which tools/bake-levels.mjs regenerates. See docs/LEVELS.md.
import { countInputs } from '../core/replay.js';
import { trackHash } from '../core/codec.js';
import { FRESH_POWDER } from './fresh-powder.js';
import { PINE_FOREST } from './pine-forest.js';
import { GLACIER } from './glacier.js';
import { AVALANCHE } from './avalanche.js';
import { POLAR_NIGHT } from './polar-night.js';
import { PLATFORM } from './platform.js';
import { TRAINING } from './training.js';
import { BAKED } from './baked.js';
import { buildOfficial, AUTHOR } from './build.js';

export { MEDALS, medalFor, medalTargets, formatMedalTarget, isBetterRun } from './medals.js';

export { AUTHOR };

/** Decor model ids the official tracks use (the renderer draws each one). */
export const DECOR_KINDS = ['Pine', 'PineCluster', 'Igloo', 'Snowman', 'PenguinCrowd', 'IceCrystal', 'Rock', 'Banner', 'Lamp'];

const CAMPAIGN_DEFS = [
    {
        id: 'race', name: 'Campaign', tiers: [
            { id: 'white', name: 'Fresh Powder', color: 'var(--tier-white)', specs: FRESH_POWDER,
                scenery: { kinds: { Pine: 5, Snowman: 1, Igloo: 1 }, density: 0.22 } },
            { id: 'green', name: 'Pine Forest', color: 'var(--tier-green)', specs: PINE_FOREST,
                scenery: { kinds: { Pine: 9, PineCluster: 4, Igloo: 1, Snowman: 1 }, density: 0.4, far: 4 } },
            { id: 'blue', name: 'Glacier', color: 'var(--tier-blue)', specs: GLACIER,
                scenery: { kinds: { IceCrystal: 5, Pine: 2, Igloo: 1 }, density: 0.2 } },
            { id: 'red', name: 'Avalanche', color: 'var(--tier-red)', specs: AVALANCHE,
                scenery: { kinds: { Pine: 4, Rock: 3, IceCrystal: 2, Snowman: 1 }, density: 0.25 } },
            { id: 'black', name: 'Polar Night', color: 'var(--tier-black)', specs: POLAR_NIGHT,
                scenery: { kinds: { IceCrystal: 4, Pine: 2, Rock: 2, Igloo: 1 }, density: 0.2 } },
        ],
    },
    {
        id: 'platform', name: 'Platform', tiers: [
            { id: 'platform', name: 'Ice Steps', color: 'var(--accent)', specs: PLATFORM,
                scenery: { kinds: { IceCrystal: 3, Snowman: 1 }, density: 0.12 } },
        ],
    },
    {
        id: 'training', name: 'Training', tiers: [
            { id: 'training', name: 'Training Grounds', color: 'var(--muted)', specs: TRAINING,
                scenery: { kinds: { Pine: 1 }, density: 0.06, crowds: false } },
        ],
    },
];

const SPECS = new Map();      // id -> spec
const SCENERY = new Map();    // id -> scenery options (tier default, spec override)
const ORDER = [];             // ids in campaign order
const INFO = new Map();       // id -> summary (the objects listed in CAMPAIGNS)

function medalsOf(spec) {
    const b = BAKED[spec.id];
    if (!b) return { author: null, gold: null, silver: null, bronze: null };
    return { author: b.author, gold: b.gold, silver: b.silver, bronze: b.bronze };
}

/**
 * [{ id, name, tiers: [{ id, name, color, tracks: [summary…] }] }]
 * A summary is { id, name, description, mood, mode, laps, medals, campaign,
 * tier, tierName, color, index } (index = position within its campaign); call
 * getTrack(id) for the playable track JSON.
 */
export const CAMPAIGNS = CAMPAIGN_DEFS.map((c) => {
    let index = 0;
    return {
        id: c.id,
        name: c.name,
        tiers: c.tiers.map((t) => ({
            id: t.id,
            name: t.name,
            color: t.color,
            tracks: t.specs.map((spec) => {
                if (SPECS.has(spec.id)) throw new Error(`Duplicate track id ${spec.id}`);
                SPECS.set(spec.id, spec);
                SCENERY.set(spec.id, sceneryOptions(t.scenery, spec));
                ORDER.push(spec.id);
                const info = Object.freeze({
                    id: spec.id,
                    name: spec.name,
                    description: spec.description || '',
                    mood: spec.mood || 'day',
                    mode: spec.mode || 'race',
                    laps: spec.laps || 1,
                    medals: Object.freeze(medalsOf(spec)),
                    campaign: c.id,
                    tier: t.id,
                    tierName: t.name,
                    color: t.color,
                    index: index++,
                });
                INFO.set(spec.id, info);
                return info;
            }),
        })),
    };
});

/** Tier scenery, overridden per track by spec.scenery (false = none); night tracks get lamps. */
function sceneryOptions(tier, spec) {
    if (spec.scenery === false) return null;
    const o = { ...(tier || {}), ...(spec.scenery || {}) };
    if (o.lamps === undefined && spec.mood === 'night') o.lamps = 3;
    return o;
}

const cache = new Map();

function build(id) {
    if (!cache.has(id)) {
        const spec = SPECS.get(id);
        if (!spec) return null;
        cache.set(id, buildOfficial(spec, { medals: medalsOf(spec), scenery: SCENERY.get(id) }));
    }
    return cache.get(id);
}

/** Full track JSON for an official track id (a fresh copy each call), or null. */
export function getTrack(id) {
    const t = build(id);
    return t ? JSON.parse(JSON.stringify(t)) : null;
}

/** Summary of one track (as listed in CAMPAIGNS), or null. */
export function trackInfo(id) {
    return INFO.get(id) || null;
}

/** Every official track id in campaign order (race, platform, training). */
export function trackIds() {
    return ORDER.slice();
}

/** Every official track as full JSON, in campaign order. */
export function allTracks() {
    return ORDER.map((id) => getTrack(id));
}

/** Whether an id names an official track. */
export function isOfficial(id) {
    return SPECS.has(id);
}

/**
 * The Emperor ghost: the baked author run as a replay object (verifyReplay /
 * simulateReplay ready), or null when the track has no bake or the bake is
 * stale (the layout changed since tools/bake-levels.mjs last ran).
 */
export function authorReplay(id) {
    const b = BAKED[id];
    const t = build(id);
    if (!b || !t || !b.inputs || b.hash !== trackHash(t)) return null;
    return {
        format: 1,
        trackId: id,
        trackHash: b.hash,
        laps: t.laps,
        inputs: b.inputs,
        ticks: countInputs(b.inputs),
        timeMs: b.author,
        finished: true,
        respawnTicks: (b.respawnTicks || []).slice(),
        date: null,
        name: 'Emperor',
    };
}

/** The track after `id` in its campaign (crossing tiers), or null at the end. */
export function nextTrackId(id) {
    const info = INFO.get(id);
    if (!info) return null;
    const camp = CAMPAIGNS.find((c) => c.id === info.campaign);
    const ids = camp.tiers.flatMap((t) => t.tracks.map((x) => x.id));
    const i = ids.indexOf(id);
    return i >= 0 && i + 1 < ids.length ? ids[i + 1] : null;
}

/** The campaign tier holding a track: { campaign, tier } or null. */
export function tierOf(id) {
    const info = INFO.get(id);
    if (!info) return null;
    const campaign = CAMPAIGNS.find((c) => c.id === info.campaign);
    return { campaign, tier: campaign.tiers.find((t) => t.id === info.tier) };
}

/** The raw path-builder spec of a track (tools only). */
export function trackSpec(id) {
    return SPECS.get(id) || null;
}
