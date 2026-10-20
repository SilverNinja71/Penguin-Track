// Hot-seat (TMNF style): set up players, a playlist and a turn limit, then pass
// the keyboard around. Each turn races in the shell's play screen; the play
// hooks (onStart / onRestart / onFinish / onExit, see docs/GAME.md) count the
// attempts and driving time and bring the result back here.
import { formatTime } from '../core/format.js';
import { h, setText } from '../game/dom.js';
import * as HS from './hotseat.js';
import { trackSelect, findTrackItem, loadPrefs, savePrefs, ico, swatch, field } from './common.js';

// The match survives the trips to the play screen and back (module scope).
let match = null;
let setup = null;

const ATTEMPT_CHOICES = [1, 2, 3, 5, 10];
const MINUTE_CHOICES = [1, 2, 3, 5, 8];

export function hasMatch() {
    return !!match && match.phase !== 'done';
}

export function createHotseatView(app, nav) {
    const view = { el: h('div.mp-view.mp-hotseat'), dispose() {}, back: () => false };
    if (!setup) {
        const prefs = loadPrefs(app);
        setup = {
            players: Array.isArray(prefs.hotseatPlayers) && prefs.hotseatPlayers.length >= 2 ? prefs.hotseatPlayers.slice(0, HS.MAX_PLAYERS) : ['Player 1', 'Player 2'],
            tracks: Array.isArray(prefs.hotseatTracks) && prefs.hotseatTracks.length ? prefs.hotseatTracks.filter((id) => findTrackItem(app, id)) : ['A01'],
            limit: HS.normalizeLimit(prefs.hotseatLimit || { type: 'attempts', count: 3 }),
        };
        if (!setup.tracks.length) setup.tracks = ['A01'];
    }
    const render = () => {
        view.el.replaceChildren(!match ? setupPanel(app, render) : match.phase === 'turn' ? turnPanel(app, render, nav) : match.phase === 'trackResults' ? trackResultsPanel(app, render) : finalPanel(app, render));
        const f = view.el.querySelector('[data-autofocus]');
        if (f) requestAnimationFrame(() => f.isConnected && f.focus({ preventScroll: true }));
    };
    render();
    return view;
}

// ------------------------------------------------------------------ setup

function setupPanel(app, render) {
    const playersEl = h('div.mp-players');
    const tracksEl = h('ol.mp-playlist');
    const drawPlayers = () => {
        playersEl.replaceChildren(...setup.players.map((name, i) => h('div.mp-player-row',
            swatch(HS.PLAYER_COLORS[i]),
            h('input.pt-input', {
                value: name, maxlength: 16, 'aria-label': `Player ${i + 1} name`,
                oninput: (e) => { setup.players[i] = e.target.value; },
            }),
            h('button.pt-btn.small.ghost', {
                type: 'button', 'aria-label': `Remove ${name || 'player'}`, disabled: setup.players.length <= HS.MIN_PLAYERS,
                onclick: () => { setup.players.splice(i, 1); drawPlayers(); },
            }, ico('close', 16)))));
        addPlayer.disabled = setup.players.length >= HS.MAX_PLAYERS;
    };
    const addPlayer = h('button.pt-btn.small', {
        type: 'button',
        onclick: () => {
            if (setup.players.length >= HS.MAX_PLAYERS) return;
            setup.players.push(`Player ${setup.players.length + 1}`);
            drawPlayers();
            const inputs = playersEl.querySelectorAll('input');
            inputs[inputs.length - 1].select();
        },
    }, ico('plus', 16), 'Add player');
    const drawTracks = () => {
        tracksEl.replaceChildren(...setup.tracks.map((id, i) => {
            const it = findTrackItem(app, id);
            return h('li.mp-playlist-row',
                h('span.mp-playlist-n', String(i + 1)),
                h('span.mp-playlist-name', it ? it.label : id),
                h('button.pt-btn.small.ghost', {
                    type: 'button', 'aria-label': `Remove ${it ? it.name : id}`, disabled: setup.tracks.length <= 1,
                    onclick: () => { setup.tracks.splice(i, 1); drawTracks(); },
                }, ico('close', 16)));
        }));
    };
    const sel = trackSelect(app, { value: setup.tracks[setup.tracks.length - 1] });
    const addTrack = h('button.pt-btn.small', {
        type: 'button',
        onclick: () => {
            if (setup.tracks.length >= HS.MAX_TRACKS) return app.toast(`A playlist holds up to ${HS.MAX_TRACKS} tracks.`);
            setup.tracks.push(sel.value);
            drawTracks();
        },
    }, ico('plus', 16), 'Add to playlist');

    const limitType = h('select.pt-input', { 'aria-label': 'Turn limit' },
        h('option', { value: 'attempts' }, 'Attempts per turn'),
        h('option', { value: 'time' }, 'Driving time per turn'));
    const limitValue = h('select.pt-input', { 'aria-label': 'Limit value' });
    const fillValues = () => {
        const t = limitType.value;
        const choices = t === 'time' ? MINUTE_CHOICES : ATTEMPT_CHOICES;
        limitValue.replaceChildren(...choices.map((v) => h('option', { value: v }, t === 'time' ? `${v} min` : `${v} ${v === 1 ? 'attempt' : 'attempts'}`)));
        const cur = setup.limit.type === t ? (t === 'time' ? Math.round(setup.limit.ms / 60000) : setup.limit.count) : choices[2];
        limitValue.value = String(choices.includes(cur) ? cur : choices[2]);
    };
    limitType.value = setup.limit.type;
    limitType.onchange = () => {
        setup.limit = limitType.value === 'time' ? { type: 'time', ms: 3 * 60000 } : { type: 'attempts', count: 3 };
        fillValues();
    };
    fillValues();

    const start = () => {
        const v = Number(limitValue.value);
        setup.limit = HS.normalizeLimit(limitType.value === 'time' ? { type: 'time', ms: v * 60000 } : { type: 'attempts', count: v });
        setup.players = setup.players.map((n, i) => n.trim().slice(0, 16) || `Player ${i + 1}`);
        savePrefs(app, { hotseatPlayers: setup.players, hotseatTracks: setup.tracks, hotseatLimit: setup.limit });
        match = newMatch(app);
        if (match) render();
    };
    drawPlayers();
    drawTracks();
    return h('div.mp-columns',
        h('section.pt-panel.mp-card',
            h('h2.pt-subtitle', ico('users', 22), 'Penguins'),
            h('p.pt-muted.mp-lead', 'Two to eight drivers take turns on one keyboard or pad. Best time on each track scores 10, 8, 6, 5, 4, 3, 2, 1.'),
            playersEl,
            h('div.pt-row', addPlayer)),
        h('section.pt-panel.mp-card',
            h('h2.pt-subtitle', ico('map', 22), 'Playlist'),
            h('div.pt-row.mp-add-row', sel, addTrack),
            tracksEl,
            h('div.mp-form-row',
                field('Each turn', limitType),
                field('Limit', limitValue)),
            h('div.pt-row.mp-actions',
                h('button.pt-btn.primary.big', { type: 'button', 'data-autofocus': true, onclick: start }, ico('flag', 22), 'Start match'))));
}

function newMatch(app) {
    try {
        return HS.createMatch({
            players: setup.players,
            tracks: setup.tracks.map((id) => {
                const it = findTrackItem(app, id);
                return { id, name: it ? it.name : id, platform: it ? it.platform : false, ref: id };
            }),
            limit: setup.limit,
        });
    } catch (e) {
        app.toast(e.message, { kind: 'bad' });
        return null;
    }
}

// ------------------------------------------------------------------ a turn

function limitText(m) {
    return m.limit.type === 'time' ? `${formatTime(m.limit.ms).replace(/\.00$/, '')} of driving` : `${m.limit.count} ${m.limit.count === 1 ? 'attempt' : 'attempts'}`;
}

function turnPanel(app, render, nav) {
    const m = match;
    const p = HS.turnPlayer(m);
    const player = m.players[p];
    const track = HS.currentTrack(m);
    const leader = HS.leaderRun(m, p);
    const go = h('button.pt-btn.primary.big', { type: 'button', 'data-autofocus': true, onclick: () => launchTurn(app) }, ico('play', 24), `Drive, ${player.name}!`);
    return h('div.mp-columns',
        h('section.pt-panel.mp-card.mp-turn', { style: { '--c': player.color } },
            h('div.mp-kicker', `Track ${m.trackIndex + 1} of ${m.tracks.length} · turn ${m.turnIndex + 1} of ${m.players.length}`),
            h('h2.mp-turn-track', track.name),
            h('div.mp-turn-who', swatch(player.color), h('span', `${player.name}'s turn`)),
            h('p.pt-muted', `Pass the keyboard (or pad) to ${player.name}. ${limitText(m)}, unlimited respawns.`),
            leader ? h('p.mp-turn-leader', ico('ghost', 18), `Chase ${leader.name}'s ghost: ${formatTime(leader.run.timeMs)}`) : h('p.mp-turn-leader.pt-muted', ico('snowflake', 18), 'Fresh snow: nobody has set a time here yet.'),
            h('div.pt-row.mp-actions',
                go,
                h('button.pt-btn.ghost', {
                    type: 'button',
                    onclick: async () => {
                        if (await app.confirm(`Skip ${player.name}'s turn? They score no time on this track.`, { ok: 'Skip turn' })) {
                            HS.endTurn(m);
                            render();
                        }
                    },
                }, 'Skip turn')),
            h('div.mp-keys.pt-muted', h('span.pt-kbd', 'Enter'), ' respawn  ', h('span.pt-kbd', '⌫'), ' next attempt  ', h('span.pt-kbd', 'Esc'), ' pause / end turn')),
        h('section.pt-panel.mp-card',
            h('h3.mp-card-title', 'This track'),
            boardTable(m, p),
            h('h3.mp-card-title', 'Standings'),
            standingsTable(m),
            h('div.pt-row.mp-actions',
                h('button.pt-btn.small.danger', {
                    type: 'button',
                    onclick: async () => {
                        if (await app.confirm('End this match? The scores so far are lost.', { ok: 'End match', danger: true })) {
                            match = null;
                            render();
                        }
                    },
                }, 'End match'))));
}

function boardTable(m, current = -1) {
    const ranked = HS.trackRanking(m);
    const order = HS.turnOrder(m);
    const played = new Set(order.slice(0, m.phase === 'turn' ? m.turnIndex : order.length));
    return h('table.mp-table', h('tbody', ranked.map((r) => {
        const run = m.runs[m.trackIndex][r.player];
        const status = r.finished ? formatTime(r.run.timeMs) + (r.run.respawns && HS.currentTrack(m).platform ? ` · ${r.run.respawns} resp.` : '')
            : played.has(r.player) ? 'no finish' : r.player === current ? 'driving next' : 'waiting';
        return h('tr', { class: r.player === current ? 'me' : '' },
            h('td.mp-place', r.finished ? String(r.place + 1) : '–'),
            h('td', swatch(r.color), r.name),
            h('td.pt-mono.mp-num', status),
            h('td.pt-muted.mp-num', run.attempts ? `${run.attempts}×` : ''));
    })));
}

function standingsTable(m, final = false) {
    const rows = HS.standings(m);
    return h('table.mp-table', h('tbody', rows.map((r) => h('tr', { class: final && r.place === 0 ? 'win' : '' },
        h('td.mp-place', String(r.place + 1)),
        h('td', swatch(r.color), r.name),
        h('td.pt-mono.mp-num', `${r.points} pts`),
        h('td.pt-muted.mp-num', r.wins ? `${r.wins} win${r.wins === 1 ? '' : 's'}` : '')))));
}

/** Sends the current player to the play screen with the attempt bookkeeping hooks. */
function launchTurn(app) {
    const m = match;
    const p = HS.turnPlayer(m);
    const player = m.players[p];
    const track = HS.currentTrack(m);
    const mine = HS.turnRun(m).best;
    const leader = HS.leaderRun(m, p);
    const ghosts = [];
    if (leader) ghosts.push({ replay: leader.run.replay, label: leader.name, color: m.players[leader.player].color });
    if (mine && mine.replay) ghosts.push({ replay: mine.replay, label: 'Your best', color: '#cfeaff' });
    let counted = 0;      // race ticks of the live run already charged to the turn
    let overlay = null;
    const runMs = (s) => (s.sim.finished ? s.sim.finishTimeMs : s.sim.timeMs);
    const charge = (s) => {
        const ms = runMs(s);
        HS.addDriven(m, ms - counted);
        counted = ms;
    };
    const params = {
        track: track.ref,
        mode: 'custom',
        saveRecords: false,
        exitLabel: 'End turn',
        ghosts,
        onStart(s) {
            counted = 0;
            HS.startAttempt(m);
            if (HS.turnSpent(m) && m.limit.type === 'attempts') params.retry = false;
            overlay = turnOverlay(app, s, m, p, () => counted);
        },
        onRestart(s) {
            charge(s);
            if (!HS.startAttempt(m)) {
                app.toast(m.limit.type === 'time' ? "Time's up! Finish this run, or press Esc to end your turn." : 'That was your last attempt: finish it, or press Esc to end your turn.', { kind: 'bad', ms: 3600 });
                return false;
            }
            counted = 0;
            if (HS.turnSpent(m) && m.limit.type === 'attempts') params.retry = false;
            if (overlay) overlay.refresh();
            return true;
        },
        onFinish(result, s) {
            charge(s);
            const { previous } = HS.submitFinish(m, result);
            // The results screen compares against this player's own best of the match.
            result.pbBefore = previous ? { bestMs: previous.timeMs, respawns: previous.respawns, splits: previous.splits } : null;
            if (HS.turnSpent(m)) params.retry = false;
            if (overlay) overlay.refresh();
        },
        onExit() {
            const s = app.screen && app.screen.session;
            if (s && s.sim && !s.sim.finished) charge(s);
            HS.endTurn(m);
            app.goto('mp', { view: 'hotseat' });
        },
    };
    app.goto('play', params);
    return player;
}

/** The chip on the play screen: whose turn, attempts or time left, the match leader. */
function turnOverlay(app, s, m, p, countedFn) {
    const player = m.players[p];
    const info = h('span.mp-chip-info.pt-mono');
    const el = h('div.mp-play-chip', { style: { '--c': player.color } },
        swatch(player.color), h('span.mp-chip-name', player.name), info);
    s.screenEl.appendChild(el);
    let raf = 0;
    let warned = false;
    const refresh = () => {
        if (!el.isConnected) return;
        if (m.limit.type === 'attempts') {
            const r = m.runs[m.trackIndex][p];
            setText(info, `Attempt ${Math.min(r.attempts, m.limit.count)}/${m.limit.count}`);
        } else {
            const live = s.sim && s.state !== 'countdown' ? (s.sim.finished ? s.sim.finishTimeMs : s.sim.timeMs) - countedFn() : 0;
            const left = Math.max(0, HS.timeLeft(m) - Math.max(0, live));
            setText(info, `${formatTime(left).replace(/\.\d\d$/, '')} left`);
            el.classList.toggle('low', left < 15000);
            if (left === 0 && !warned) {
                warned = true;
                s.params.retry = false;
                if (s.state === 'racing') app.toast("Time's up! This run still counts if you finish it.", { ms: 3600 });
            }
        }
    };
    const loop = () => {
        if (!el.isConnected) return;
        refresh();
        raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    refresh();
    return { refresh, stop: () => cancelAnimationFrame(raf) };
}

// ------------------------------------------------------------------ results

function trackResultsPanel(app, render) {
    const m = match;
    const ti = m.trackIndex;
    const next = HS.currentTrack({ ...m, trackIndex: ti + 1 });
    return h('div.mp-columns',
        h('section.pt-panel.mp-card',
            h('div.mp-kicker', `Track ${ti + 1} of ${m.tracks.length} done`),
            h('h2.mp-turn-track', m.tracks[ti].name),
            pointsTable(m, ti),
            h('div.pt-row.mp-actions',
                h('button.pt-btn.primary.big', { type: 'button', 'data-autofocus': true, onclick: () => { HS.nextTrack(m); render(); } }, ico('next', 22), `Next: ${next ? next.name : ''}`))),
        h('section.pt-panel.mp-card',
            h('h3.mp-card-title', 'Standings'),
            standingsTable(m)));
}

function pointsTable(m, ti) {
    return h('table.mp-table.big', h('tbody', HS.trackRanking(m, ti).map((r) => h('tr',
        h('td.mp-place', r.finished ? String(r.place + 1) : '–'),
        h('td', swatch(r.color), r.name),
        h('td.pt-mono.mp-num', r.finished ? formatTime(r.run.timeMs) : 'no finish'),
        h('td.pt-mono.mp-num.mp-pts', r.points ? `+${r.points}` : '')))));
}

function finalPanel(app, render) {
    const m = match;
    const rows = HS.standings(m);
    const step = (place) => {
        const r = rows.filter((x) => x.place === place);
        if (!r.length) return h('div.mp-podium-step.empty', { class: `p${place + 1}` });
        return h('div.mp-podium-step', { class: `p${place + 1}` },
            h('div.mp-podium-names', r.map((x) => h('div.mp-podium-name', swatch(x.color), x.name))),
            h('div.mp-podium-block', h('span.mp-podium-n', String(place + 1)), h('span.mp-podium-pts.pt-mono', `${r[0].points} pts`)));
    };
    const winners = rows.filter((r) => r.place === 0).map((r) => r.name);
    return h('div.mp-final',
        h('section.pt-panel.mp-card.mp-final-card',
            h('div.mp-kicker', 'Match over'),
            h('h2.mp-turn-track', winners.length > 1 ? `${winners.join(' & ')} share the summit!` : `${winners[0]} wins!`),
            h('div.mp-podium', step(1), step(0), step(2)),
            standingsTable(m, true),
            h('details.mp-details', h('summary', 'Every track'),
                m.tracks.map((t, ti) => h('div.mp-track-sum', h('h4', `${ti + 1}. ${t.name}`), pointsTable(m, ti)))),
            h('div.pt-row.mp-actions',
                h('button.pt-btn.primary', { type: 'button', 'data-autofocus': true, onclick: () => { match = newMatch(app); render(); } }, ico('retry', 20), 'Rematch'),
                h('button.pt-btn', { type: 'button', onclick: () => { match = null; render(); } }, ico('edit', 20), 'New match'))));
}
