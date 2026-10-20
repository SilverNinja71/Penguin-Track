// The play screen. params: { track (JSON or id), mode: 'campaign'|'custom'|'test'|'replay',
// replay?, ghosts?: [replay | { replay, label, color }], onExit?(result|null) }.
// Races run in RaceSession, replays in ReplaySession.
import { buildWorld } from '../core/track.js';
import { h } from './dom.js';
import { RaceSession, defaultExit, defaultExitParams } from './race.js';
import { ReplaySession } from './replayer.js';

const play = {
    id: 'play',
    shell: true,
    session: null,

    async enter(app, params = {}) {
        const track = app.catalog.resolve(params.track);
        const mode = params.mode || (track && app.catalog.isCampaign(track.id) ? 'campaign' : 'custom');
        const fail = (msg) => {
            app.toast(msg, { kind: 'bad', ms: 4200 });
            if (typeof params.onExit === 'function') params.onExit(null);
            else app.goto(defaultExit(mode), track ? defaultExitParams(mode, track) : {});
        };
        if (!track) return fail("That track couldn't be found.");
        if (app.renderer.isNull) {
            return fail(app.webgl ? "The 3D view couldn't start, so racing is off for now. Try reloading the page."
                : 'Racing needs a 3D view (WebGL), and this browser has it switched off.');
        }
        let world;
        try {
            world = buildWorld(track);
        } catch (e) {
            return fail(`This track can't be built: ${e.message}`);
        }
        if (!world.spawn) return fail('This track has no Start igloo yet.');
        if (!world.route) return fail(`This track can't be finished yet: ${world.routeError || 'no route to the finish'}.`);

        const el = h('div.pt-screen.play-screen.passthrough');
        app.ui.appendChild(el);
        if (mode === 'replay') {
            if (!params.replay) return fail('There is no replay to watch.');
            const s = new ReplaySession(app, el, { track, world, replay: params.replay, params });
            try {
                s.prepare();
            } catch (e) {
                return fail(`This replay can't be played: ${e.message}`);
            }
            this.session = s;
            s.start();
        } else {
            const s = new RaceSession(app, el, { track, world, mode, params });
            this.session = s;
            s.start();
        }
    },

    exit(app) {
        app.controls.setActive(false);
        if (this.session) this.session.dispose();
        this.session = null;
    },

    /** Esc while not driving: close the pause menu, or leave the replay viewer. */
    back() {
        const s = this.session;
        if (!s) return;
        if (s instanceof RaceSession) {
            if (s.state === 'paused') s.resume();
        } else {
            s.exit();
        }
    },

    onKey(e) {
        const s = this.session;
        return s && s.onKey ? s.onKey(e) : false;
    },
};

export default play;
