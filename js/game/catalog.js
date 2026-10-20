// One place the shell asks for tracks and medals: the official campaign
// (js/levels), the player's own tracks (storage 'tracks') and, by id only, the
// core dev samples S01–S06 (handy for ?play=S01, TAS examples and AI demos).
import { getSamples } from '../core/samples.js';
import { normalizeTrack } from '../core/track.js';
import * as levels from '../levels/index.js';
import { medalFor, medalRank, medalTargets, isBetterRun, MEDALS, MEDAL_LABELS, MEDAL_REWARDS } from '../levels/medals.js';

export function makeCatalog({ storage }) {
    const samples = new Map(getSamples().map((t) => [t.id, t]));
    const isOfficial = (id) => levels.isOfficial(id);

    const cat = {
        /** [{ id, name, tiers: [{ id, name, color, tracks: [summary…] }] }] from js/levels. */
        campaigns() {
            return levels.CAMPAIGNS;
        },
        /** Summary (as listed in campaigns) of an official track, or null. */
        info(id) {
            return levels.trackInfo(id);
        },
        isOfficial,
        /** Official ids and dev sample ids: an imported custom track never takes one. */
        isReserved(id) {
            return isOfficial(id) || samples.has(id);
        },
        /** True for tracks that race in campaign mode (records, next track, gold). */
        isCampaign(id) {
            return isOfficial(id);
        },
        /** Track JSON for an id: official, dev sample, then the player's own. Fresh copy, or null. */
        getTrack(id) {
            if (!id) return null;
            if (isOfficial(id)) return levels.getTrack(id);
            if (samples.has(id)) return JSON.parse(JSON.stringify(samples.get(id)));
            const mine = storage.get('tracks', {});
            if (mine && mine[id]) return { ...normalizeTrack(mine[id]), id };
            return null;
        },
        /** Accepts a track object or an id. */
        resolve(ref) {
            if (!ref) return null;
            return typeof ref === 'string' ? cat.getTrack(ref) : ref;
        },
        nextTrackId: (id) => levels.nextTrackId(id),
        /** The Emperor ghost replay of an official track, or null. */
        authorReplay(id) {
            try {
                return levels.authorReplay(id);
            } catch (e) {
                return null;
            }
        },
        /** Every campaign track id in order (attract mode). */
        campaignIds: () => levels.trackIds(),
        customTracks() {
            const mine = storage.get('tracks', {}) || {};
            return Object.keys(mine).filter((id) => mine[id] && typeof mine[id] === 'object')
                .map((id) => ({ ...mine[id], id }));
        },
        medals: MEDALS,
        medalFor,
        medalRank,
        isBetterRun,
        medalTargets: (track) => (track && track.medals ? medalTargets(track) : []),
        medalLabel: (m) => MEDAL_LABELS[m] || '',
        medalReward: (m) => MEDAL_REWARDS[m] || 0,
    };
    return cat;
}
