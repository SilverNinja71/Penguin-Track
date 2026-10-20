// The TAS script language (TMInterface style). One command per line:
//
//   <time> <command> [args]        0.00 press up
//   <from>-<to> <command> [args]   1.20-1.85 press left   (the opposite at <to>)
//
// Times are seconds (12.34), m:ss.cc (1:02.50) or ranges a-b, and must be
// whole ticks (multiples of 10 ms). Commands: press / rel up|down|left|right
// (up = gas, down = brake, left / right = full steering), steer <-65536..65536>
// (analog, held until changed), gas on|off, brake on|off, respawn (Enter on
// that tick). '#' starts a comment; '# key: value' lines before the first
// command are header directives (track, name, author, laps, ...).
//
// Commands are events: their state holds until changed. While left or right is
// held it wins over the analog steer value. Events on the same tick apply range
// ends first, then the rest in file order. See docs/TAS.md.
import { STEER_MAX, TICK_MS } from '../core/constants.js';
import { formatTime } from '../core/format.js';
import { Recorder } from '../core/replay.js';
import { InputTimeline, GAS, BRAKE, RESPAWN, MAX_TICKS } from './timeline.js';
import { simulateTimeline } from './runner.js';

const CHANNELS = ['gas', 'brake', 'left', 'right', 'steer', 'respawn'];
const KEY_CHANNEL = { up: 'gas', down: 'brake', left: 'left', right: 'right' };
const CHANNEL_KEY = { gas: 'up', brake: 'down', left: 'left', right: 'right' };
const TIME_RE = /^(?:(\d+):)?(\d+)(?:\.(\d*))?$/;
const HEADER_RE = /^#\s*([A-Za-z][\w-]*)\s*:\s*(.*)$/;

/**
 * Parses a time token ('12.34', '1:02.50', '7') to ticks.
 * Returns { tick } or { error }.
 */
export function parseTime(text) {
    const m = TIME_RE.exec(text);
    if (!m) return { error: `Bad time '${text}' (use seconds like 12.34 or m:ss.cc like 1:02.50)` };
    const min = m[1] !== undefined ? Number(m[1]) : 0;
    const sec = Number(m[2]);
    if (m[1] !== undefined && sec >= 60) return { error: `Bad time '${text}': seconds must be below 60 after the minutes` };
    let frac = m[3] || '';
    if (frac.length > 3) {
        if (/[^0]/.test(frac.slice(3))) return { error: `Time '${text}' is not a multiple of 10 ms (one tick)` };
        frac = frac.slice(0, 3);
    }
    const ms = (min * 60 + sec) * 1000 + Number(frac.padEnd(3, '0'));
    if (ms % TICK_MS !== 0) return { error: `Time '${text}' is not a multiple of 10 ms (one tick)` };
    const tick = ms / TICK_MS;
    if (!Number.isSafeInteger(tick) || tick >= MAX_TICKS) return { error: `Time '${text}' is past the one-hour limit` };
    return { tick };
}

/** Ticks to script time text: '12.34' under a minute, '1:02.50' above. */
export function formatTick(tick) {
    return formatTime(tick * TICK_MS, { style: 'short' });
}

/**
 * Parses a script. Returns { timeline, errors, warnings, meta, commands }:
 * errors and warnings are { line, message } (1-based lines), meta holds the
 * header directives (lower-case keys) and commands lists every valid command
 * line as { line, from, to (-1 without a range), channel, value } (editor
 * gutters, jump-to-time). Lines with errors are skipped; the rest still build
 * the timeline, so an editor can show a partial run.
 */
export function parse(text) {
    const errors = [], warnings = [];
    const meta = {};
    const events = [];
    const commands = [];
    const lines = String(text ?? '').split(/\r\n|\r|\n/);
    let seenCommand = false;
    let order = 0;
    for (let i = 0; i < lines.length; i++) {
        const lineNo = i + 1;
        const raw = lines[i];
        const trimmed = raw.trim();
        if (trimmed.startsWith('#')) {
            const h = HEADER_RE.exec(trimmed);
            if (h && !seenCommand) {
                const key = h[1].toLowerCase();
                if (key in meta) warnings.push({ line: lineNo, message: `Header '${key}' given twice; the last one counts` });
                meta[key] = h[2].trim();
            }
            continue;
        }
        const hash = raw.indexOf('#');
        const body = (hash >= 0 ? raw.slice(0, hash) : raw).trim();
        if (!body) continue;
        seenCommand = true;
        const err = (message) => errors.push({ line: lineNo, message });
        const tokens = body.split(/\s+/);
        if (tokens.length < 2) { err(`Missing command after '${tokens[0]}'`); continue; }

        // Time or range.
        let from, to = -1;
        const parts = tokens[0].split('-');
        if (parts.length > 2) { err(`Bad time range '${tokens[0]}'`); continue; }
        const a = parseTime(parts[0]);
        if (a.error) { err(a.error); continue; }
        from = a.tick;
        if (parts.length === 2) {
            const b = parseTime(parts[1]);
            if (b.error) { err(b.error); continue; }
            to = b.tick;
            if (to <= from) { err(`Range '${tokens[0]}' must end after it starts`); continue; }
        }

        const cmd = parseCommand(tokens.slice(1));
        if (cmd.error) { err(cmd.error); continue; }
        if (cmd.none) continue;
        if (to >= 0 && cmd.channel === 'respawn') { err('respawn happens on one tick; it takes a time, not a range'); continue; }
        commands.push({ line: lineNo, from, to, channel: cmd.channel, value: cmd.value });
        events.push({ tick: from, phase: 1, order: order++, line: lineNo, channel: cmd.channel, value: cmd.value });
        if (to >= 0) {
            events.push({ tick: to, phase: 0, order: order++, line: lineNo, channel: cmd.channel, value: opposite(cmd.channel, cmd.value) });
        }
    }
    events.sort((x, y) => x.tick - y.tick || x.phase - y.phase || x.order - y.order);
    const timeline = buildTimeline(events, warnings);
    return { timeline, errors, warnings, meta, commands };
}

function parseCommand(args) {
    const name = args[0].toLowerCase();
    const arg = args[1] !== undefined ? args[1].toLowerCase() : undefined;
    const extra = args.length > 2 ? `Unexpected '${args.slice(2).join(' ')}' after '${args[0]} ${args[1]}'` : null;
    switch (name) {
        case 'press':
        case 'rel':
        case 'release': {
            const on = name === 'press';
            if (arg === undefined) return { error: `'${name}' needs a key: up, down, left or right` };
            if (extra) return { error: extra };
            if (arg === 'enter') return on ? { channel: 'respawn', value: true } : { none: true };
            const ch = KEY_CHANNEL[arg];
            if (!ch) return { error: `Unknown key '${args[1]}' (use up, down, left or right)` };
            return { channel: ch, value: on };
        }
        case 'gas':
        case 'brake': {
            if (arg !== 'on' && arg !== 'off') return { error: `'${name}' takes on or off` };
            if (extra) return { error: extra };
            return { channel: name, value: arg === 'on' };
        }
        case 'steer': {
            if (arg === undefined) return { error: `'steer' needs a value from ${-STEER_MAX} to ${STEER_MAX}` };
            if (extra) return { error: extra };
            if (!/^[+-]?\d+$/.test(arg)) return { error: `Steer '${args[1]}' must be a whole number from ${-STEER_MAX} to ${STEER_MAX}` };
            const v = Number(arg);
            if (v < -STEER_MAX || v > STEER_MAX) return { error: `Steer ${arg} is out of range (${-STEER_MAX} to ${STEER_MAX})` };
            return { channel: 'steer', value: v + 0 };
        }
        case 'respawn':
            if (args.length > 1) return { error: `'respawn' takes no arguments` };
            return { channel: 'respawn', value: true };
        default:
            return { error: `Unknown command '${args[0]}' (use press, rel, steer, gas, brake or respawn)` };
    }
}

function opposite(channel, value) {
    return channel === 'steer' ? 0 : !value;
}

function isOff(channel, value) {
    return channel === 'steer' ? value === 0 : value === false;
}

function buildTimeline(events, warnings) {
    if (!events.length) return new InputTimeline();
    const last = events[events.length - 1].tick;
    const tl = new InputTimeline(last + 1);
    const st = { gas: false, brake: false, left: false, right: false, steer: 0 };
    let k = 0;
    while (k < events.length) {
        const tick = events[k].tick;
        let respawn = false;
        const setBy = {};
        for (; k < events.length && events[k].tick === tick; k++) {
            const ev = events[k];
            if (ev.channel === 'respawn') {
                if (respawn) warnings.push({ line: ev.line, message: `Second respawn at ${formatTick(tick)} (one respawn per tick)` });
                respawn = true;
                continue;
            }
            const prev = setBy[ev.channel];
            if (prev && prev.phase === ev.phase && prev.value !== ev.value) {
                warnings.push({ line: ev.line, message: `Overrides line ${prev.line}: both set ${ev.channel} at ${formatTick(tick)}` });
            }
            setBy[ev.channel] = ev;
            st[ev.channel] = ev.value;
        }
        const next = k < events.length ? events[k].tick : last + 1;
        const steer = st.left || st.right ? (st.right ? STEER_MAX : 0) - (st.left ? STEER_MAX : 0) : st.steer;
        const flags = (st.gas ? GAS : 0) | (st.brake ? BRAKE : 0);
        tl.steer.fill(steer, tick, next);
        tl.flags.fill(flags, tick, next);
        if (respawn) tl.flags[tick] |= RESPAWN;
    }
    return tl;
}

/**
 * Canonical minimal script for a timeline. opts: { style: 'ranges' | 'events'
 * (default 'ranges'), meta: { track, name, ... } header directives, comment:
 * extra header comment lines }. parse(serialize(t)) gives a timeline equal to
 * t on every tick, and serialize is idempotent through parse.
 */
export function serialize(timeline, opts = {}) {
    const style = opts.style || 'ranges';
    if (style !== 'ranges' && style !== 'events') throw new Error(`Unknown script style '${style}'`);
    const out = [];
    for (const [k, v] of Object.entries(opts.meta || {})) {
        if (v === undefined || v === null || v === '') continue;
        if (!/^[A-Za-z][\w-]*$/.test(k)) continue;
        out.push(`# ${k}: ${String(v).replace(/[\r\n]+/g, ' ')}`);
    }
    for (const c of [].concat(opts.comment || [])) out.push(`# ${c}`);
    if (out.length) out.push('');

    const ev = channelEvents(timeline);
    const lines = [];
    for (const ch of CHANNELS) {
        const list = ev[ch];
        if (ch === 'respawn') {
            for (const e of list) lines.push({ tick: e.tick, ch, text: `${formatTick(e.tick)} respawn` });
            continue;
        }
        for (let i = 0; i < list.length; i++) {
            const e = list[i];
            const cmd = ch === 'steer' ? `steer ${e.value}` : `${e.value ? 'press' : 'rel'} ${CHANNEL_KEY[ch]}`;
            if (style === 'ranges' && i + 1 < list.length && isOff(ch, list[i + 1].value) && !isOff(ch, e.value)) {
                // A value followed by its "off" event becomes one range line.
                lines.push({ tick: e.tick, ch, text: `${formatTick(e.tick)}-${formatTick(list[i + 1].tick)} ${cmd}` });
                i++;
                continue;
            }
            lines.push({ tick: e.tick, ch, text: `${formatTick(e.tick)} ${cmd}` });
        }
    }
    lines.sort((a, b) => a.tick - b.tick || CHANNELS.indexOf(a.ch) - CHANNELS.indexOf(b.ch));
    for (const l of lines) out.push(l.text);
    return out.join('\n') + '\n';
}

/**
 * Per-channel change events of a timeline, as a script would write them:
 * { gas, brake, left, right, steer, respawn: [{ tick, value }] }. Full lock
 * becomes left / right held (the analog value is kept underneath).
 */
export function channelEvents(timeline) {
    const ev = { gas: [], brake: [], left: [], right: [], steer: [], respawn: [] };
    const st = { gas: false, brake: false, left: false, right: false, steer: 0 };
    const n = timeline.length;
    const put = (ch, tick, value) => {
        if (st[ch] !== value) { st[ch] = value; ev[ch].push({ tick, value }); }
    };
    for (let t = 0; t < n; t++) {
        const s = timeline.steer[t], f = timeline.flags[t];
        put('gas', t, (f & GAS) !== 0);
        put('brake', t, (f & BRAKE) !== 0);
        if (s === STEER_MAX || s === -STEER_MAX) {
            put('left', t, s < 0);
            put('right', t, s > 0);
        } else {
            put('left', t, false);
            put('right', t, false);
            put('steer', t, s);
        }
        if (f & RESPAWN) ev.respawn.push({ tick: t, value: true });
    }
    return ev;
}

/** Input timeline of a replay (object with encoded `inputs`, an input array, or an encoded '1:...' string). */
export function fromReplay(replay) {
    if (typeof replay === 'string') return InputTimeline.decode(replay.trim());
    if (!replay || typeof replay !== 'object') throw new Error('Not a replay');
    if (typeof replay.inputs === 'string') return InputTimeline.decode(replay.inputs);
    if (Array.isArray(replay.inputs)) return InputTimeline.fromInputs(replay.inputs);
    if (Array.isArray(replay)) return InputTimeline.fromInputs(replay);
    throw new Error('Replay has no inputs');
}

/** Header directives describing a replay (for serialize's meta). */
export function replayMeta(replay) {
    if (!replay || typeof replay !== 'object' || Array.isArray(replay)) return {};
    const meta = {};
    if (replay.trackId) meta.track = replay.trackId;
    if (replay.trackHash) meta.hash = replay.trackHash;
    if (replay.laps && replay.laps !== 1) meta.laps = replay.laps;
    if (replay.name) meta.name = replay.name;
    if (replay.finished && replay.timeMs != null) meta.time = formatTime(replay.timeMs);
    return meta;
}

/**
 * Simulates a timeline on a world and records it as a core replay (verifies
 * with verifyReplay when it finishes). opts: { laps, name, date, maxTicks }:
 * the run stops at the finish, or after maxTicks (default: the timeline plus
 * 60 s of its held last input).
 */
export function toReplay(timeline, world, opts = {}) {
    const rec = new Recorder();
    const res = simulateTimeline(world, timeline, { ...opts, onTick: (sim) => rec.push(sim.lastInput) });
    return rec.toReplay({ sim: res.sim, name: opts.name ?? 'TAS', date: opts.date ?? null });
}
