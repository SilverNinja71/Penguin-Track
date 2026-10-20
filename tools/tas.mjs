#!/usr/bin/env node
// Penguintrack TAS command line: run, bruteforce, compare and convert TAS
// scripts headless (usage below, reference in docs/TAS.md).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { buildWorld } from '../js/core/track.js';
import { decodeTrack, encodeTrack } from '../js/core/codec.js';
import { getSample } from '../js/core/samples.js';
import { verifyReplay } from '../js/core/replay.js';
import { runAutopilot } from '../js/core/autopilot.js';
import { formatTime } from '../js/core/format.js';
import { parse, serialize, fromReplay, replayMeta, toReplay, parseTime } from '../js/tas/script.js';
import { simulateTimeline, compareTimelines } from '../js/tas/runner.js';
import { Bruteforce, parseTargetSpec } from '../js/tas/bruteforce.js';
import { getTrack as officialTrack, isOfficial } from '../js/levels/index.js';
import { decodeReplayCodeAsync, encodeReplayCodeAsync } from '../js/game/replaycode.js';

const VALUE_FLAGS = new Set(['laps', 'max', 'replay', 'target', 'iterations', 'time', 'seed', 'window', 'changes',
    'shift', 'steer', 'span', 'weights', 'out', 'style', 'report']);

const USAGE = `Penguintrack TAS tools (docs/TAS.md)

  node tools/tas.mjs run <track> <script.txt> [--laps N] [--max SECONDS] [--replay out.json] [--json]
       (also: node tools/tas.mjs <track> <script.txt>)
  node tools/tas.mjs bruteforce <track> <script.txt> [--target finish|checkpoint:N|speed@S|position:x,y,z@S]
       [--iterations 20000] [--time SECONDS] [--seed 1] [--window 0-30] [--changes 3] [--shift 3]
       [--steer 8000] [--span 12] [--weights shift=1,steer=2,gas=0.5,brake=0.5]
       [--out better.txt] [--style ranges|events] [--report SECONDS] [--quiet]
  node tools/tas.mjs from-replay <replay.json | PTR replay code | 1:... input string> [--out script.txt]
  node tools/tas.mjs autopilot <track> [--out script.txt]
  node tools/tas.mjs to-replay <track> <script.txt> [--out replay.json] [--code]
       (--code prints a PTR replay code for the game's Replays > Import code)
  node tools/tas.mjs fmt <script.txt> [--style ranges|events] [--out script.txt]
  node tools/tas.mjs compare <track> <a.txt> <b.txt> [--laps N]

<track>: official track id, dev sample S01..S06, track .json file or PT1. share code;
optional when the script has a '# track: <id>' header.`;

function usage(code = 1) {
    (code ? console.error : console.log)(USAGE);
    process.exit(code);
}

function parseArgs(argv) {
    const pos = [], flags = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) {
            const [k, inline] = a.slice(2).split(/=(.*)/s);
            if (VALUE_FLAGS.has(k)) {
                const v = inline !== undefined ? inline : argv[++i];
                if (v === undefined) fail(`--${k} needs a value`);
                flags[k] = v;
            } else flags[k] = true;
        } else pos.push(a);
    }
    return { pos, flags };
}

function fail(msg) {
    console.error(`tas: ${msg}`);
    process.exit(1);
}

function num(v, name, { int = false, min = -Infinity } = {}) {
    const n = Number(v);
    if (!Number.isFinite(n) || (int && !Number.isInteger(n)) || n < min) fail(`--${name} expects ${int ? 'an integer' : 'a number'}${min > -Infinity ? ` >= ${min}` : ''}, got '${v}'`);
    return n;
}

/** Track id, sample id, JSON file or share code -> track JSON. */
async function resolveTrack(arg) {
    if (!arg) fail('no track given (pass one, or add "# track: <id>" to the script)');
    const s = String(arg).trim();
    if (s.startsWith('PT1.')) return decodeTrack(s);
    if (existsSync(s)) {
        const text = readFileSync(s, 'utf8').trim();
        if (text.startsWith('PT1.')) return decodeTrack(text);
        const data = JSON.parse(text);
        return data.track && data.track.blocks ? data.track : data;
    }
    const official = officialTrack(s);
    if (official) return official;
    const sample = getSample(s);
    if (sample) return sample;
    fail(`unknown track '${s}' (official id, S01..S06, a .json file or a PT1. share code)`);
    return null;
}

function readScript(file) {
    if (!existsSync(file)) fail(`no such script '${file}'`);
    const text = readFileSync(file, 'utf8');
    const res = parse(text);
    for (const w of res.warnings) console.error(`${file}:${w.line}: warning: ${w.message}`);
    if (res.errors.length) {
        for (const e of res.errors) console.error(`${file}:${e.line}: error: ${e.message}`);
        fail(`${res.errors.length} error(s) in ${file}`);
    }
    return res;
}

/** [track, script] positionals; the track may come from the script header. */
async function trackAndScript(pos) {
    let trackArg, file;
    if (pos.length >= 2) [trackArg, file] = pos;
    else if (pos.length === 1) file = pos[0];
    else fail('expected <track> <script.txt>');
    const script = readScript(file);
    const track = await resolveTrack(trackArg ?? script.meta.track);
    const world = buildWorld(track);
    if (!world.route && world.errors.length) console.error(`warning: track has errors: ${world.errors.join('; ')}`);
    if (script.meta.hash && script.meta.hash !== world.hash) {
        console.error(`warning: script was written for layout ${script.meta.hash}, this track is ${world.hash}`);
    }
    return { track, world, script, file };
}

function lapsOf(flags) {
    return flags.laps !== undefined ? num(flags.laps, 'laps', { int: true, min: 1 }) : undefined;
}

function writeOut(file, text) {
    writeFileSync(file, text.endsWith('\n') ? text : text + '\n');
}

function splitsText(cps, finishMs) {
    const lines = [];
    let prev = 0;
    cps.forEach((t, i) => {
        lines.push(`  CP ${String(i + 1).padEnd(3)} ${formatTime(t).padStart(9)}   (+${formatTime(t - prev, { style: 'short' })})`);
        prev = t;
    });
    if (finishMs != null) lines.push(`  Finish ${formatTime(finishMs).padStart(9)}   (+${formatTime(finishMs - prev, { style: 'short' })})`);
    return lines.join('\n');
}

// ---------------------------------------------------------------------------

async function cmdRun(pos, flags) {
    const { track, world, script, file } = await trackAndScript(pos);
    const laps = lapsOf(flags);
    const maxTicks = flags.max !== undefined ? Math.round(num(flags.max, 'max', { min: 0 }) * 100) : undefined;
    const t0 = performance.now();
    const res = simulateTimeline(world, script.timeline, { laps, maxTicks });
    const ms = performance.now() - t0;
    const replay = toReplay(script.timeline, world, { laps, maxTicks, name: script.meta.name || path.basename(file) });
    const check = res.finished ? verifyReplay(world, replay) : { ok: false, reason: 'did not finish' };
    if (flags.replay) writeOut(flags.replay, JSON.stringify(replay));
    if (flags.json) {
        const { sim: _s, ...summary } = res;
        console.log(JSON.stringify({ track: track.id, hash: world.hash, ...summary, valid: check.ok, reason: check.reason }));
        return;
    }
    console.log(`Track   ${track.id || '?'} ${track.name || ''} (layout ${world.hash}, ${res.sim.laps} lap${res.sim.laps > 1 ? 's' : ''})`);
    console.log(`Script  ${file}: ${script.timeline.length} ticks of input, simulated ${res.ticks} ticks in ${ms.toFixed(0)} ms`);
    console.log(splitsText(res.checkpointTimes, res.finishTimeMs));
    if (res.lapTimes.length > 1) console.log(`  Laps   ${res.lapTimes.map((t) => formatTime(t)).join(' / ')}`);
    if (!res.finished) console.log(`  Not finished after ${formatTime(res.timeMs)} (${res.checkpointTimes.length} of ${world.checkpointCount} checkpoints)`);
    console.log(`  Respawns ${res.respawns}`);
    console.log(`Valid   ${check.ok ? 'yes (replay re-simulated and verified)' : `no: ${check.reason}`}`);
    if (flags.replay) console.log(`Replay  written to ${flags.replay}`);
    if (!res.finished) process.exitCode = 2;
}

async function cmdBruteforce(pos, flags) {
    const { track, world, script, file } = await trackAndScript(pos);
    const target = parseTargetSpecOrFail(flags.target || 'finish');
    const rules = {};
    if (flags.changes !== undefined) rules.maxChanges = num(flags.changes, 'changes', { int: true, min: 1 });
    if (flags.shift !== undefined) rules.shift = { range: num(flags.shift, 'shift', { int: true, min: 1 }) };
    if (flags.steer !== undefined) rules.steer = { range: num(flags.steer, 'steer', { int: true, min: 1 }) };
    if (flags.span !== undefined) {
        const span = num(flags.span, 'span', { int: true, min: 1 });
        rules.steer = { ...(rules.steer || {}), span };
        rules.gas = { span };
        rules.brake = { span };
    }
    if (flags.weights) {
        for (const part of String(flags.weights).split(',')) {
            const [k, v] = part.split('=');
            if (!['shift', 'steer', 'gas', 'brake'].includes(k)) fail(`unknown weight '${k}' (shift, steer, gas, brake)`);
            rules[k] = { ...(rules[k] || {}), weight: num(v, `weights ${k}`, { min: 0 }) };
        }
    }
    let window = null;
    if (flags.window) {
        const [a, b] = String(flags.window).split('-');
        const from = parseTime(a), to = b !== undefined && b !== '' ? parseTime(b) : null;
        if (from.error) fail(`--window: ${from.error}`);
        if (to && to.error) fail(`--window: ${to.error}`);
        window = { from: from.tick, to: to ? to.tick : undefined };
    }
    const iterations = flags.iterations !== undefined ? num(flags.iterations, 'iterations', { int: true, min: 1 }) : (flags.time ? Infinity : 20000);
    const timeLimit = flags.time !== undefined ? num(flags.time, 'time', { min: 0 }) * 1000 : Infinity;
    const seed = flags.seed !== undefined ? num(flags.seed, 'seed', { int: true, min: 0 }) : 1;
    const style = flags.style || 'ranges';
    const reportMs = flags.report !== undefined ? num(flags.report, 'report', { min: 0.1 }) * 1000 : 5000;

    const bf = new Bruteforce(world, script.timeline, { target, window, rules, seed, laps: lapsOf(flags) });
    const startText = bf.describe();
    const startTime = bf.bestTimeMs();
    console.log(`Track   ${track.id || '?'} ${track.name || ''}; base ${file}: ${startText}`);
    console.log(`Target  ${bf.target.name}; window ${formatTime(bf.window.from * 10)}-${formatTime(bf.window.to * 10)}; seed ${seed}; `
        + `${iterations === Infinity ? '' : `${iterations} iterations`}${timeLimit < Infinity ? ` ${timeLimit / 1000} s` : ''}`);

    const save = () => {
        if (!flags.out) return;
        const tl = bf.bestTimeline();
        const t = bf.bestTimeMs();
        const meta = { track: track.id, hash: world.hash, name: `Bruteforce of ${path.basename(file)}` };
        if (t != null && bf.target.name === 'finish') meta.time = formatTime(t);
        writeOut(flags.out, serialize(tl, {
            style, meta,
            comment: [`bruteforce: ${bf.target.name}, ${startText} -> ${bf.describe()}`,
                `${bf.iterations} iterations, seed ${seed}, window ${formatTime(bf.window.from * 10)}-${formatTime(bf.window.to * 10)}`],
        }));
    };
    let stopping = false;
    process.on('SIGINT', () => { stopping = true; });

    const t0 = performance.now();
    let lastReport = t0, timeUp = false;
    while (bf.iterations < iterations && !stopping && !timeUp) {
        // Work in ~100 ms slices and yield, so Ctrl-C can stop the run and keep the best script.
        const sliceEnd = performance.now() + 100;
        while (bf.iterations < iterations) {
            const r = bf.step();
            if (r) {
                if (!flags.quiet) console.log(`  #${r.iteration}  ${r.text}  (first change ${formatTime(r.firstTick * 10)})`);
                save();
            }
            const now = performance.now();
            if (now - t0 >= timeLimit) { timeUp = true; break; }
            if (now >= sliceEnd) break;
        }
        const now = performance.now();
        if (now - lastReport >= reportMs) {
            lastReport = now;
            const rate = bf.iterations / ((now - t0) / 1000);
            console.log(`  .. ${bf.iterations} iterations, ${rate.toFixed(0)}/s, ${bf.improvements.length} improvements, best ${bf.describe()}`);
        }
        await new Promise((resolve) => setImmediate(resolve));
    }
    const el = (performance.now() - t0) / 1000;
    save();
    console.log(`Done    ${bf.iterations} iterations in ${el.toFixed(1)} s (${(bf.iterations / el).toFixed(0)}/s, ${(bf.ticksSimulated / el / 1000).toFixed(0)}k ticks/s)${stopping ? ', interrupted' : ''}`);
    console.log(`Best    ${bf.describe()}`);
    if (startTime != null && bf.bestTimeMs() != null) console.log(`Gain    ${formatTime(startTime - bf.bestTimeMs(), { style: 'short' })} s`);
    if (bf.target.name === 'finish') {
        const replay = toReplay(bf.bestTimeline(), world, { laps: lapsOf(flags) });
        const check = verifyReplay(world, replay);
        console.log(`Valid   ${check.ok ? `yes (verified replay ${formatTime(check.timeMs)})` : `no: ${check.reason}`}`);
    }
    if (flags.out) console.log(`Script  written to ${flags.out}`);
}

function parseTargetSpecOrFail(text) {
    try {
        return parseTargetSpec(text);
    } catch (e) {
        return fail(e.message);
    }
}

/** A replay from a JSON file / text, a core input string or a PTR replay share code -> { replay, trackCode? }. */
async function readReplayArg(arg) {
    if (!arg) fail('expected <replay.json | PTR replay code | 1:... input string>');
    let text = arg;
    if (existsSync(arg)) text = readFileSync(arg, 'utf8');
    text = text.trim();
    if (text.startsWith('1:')) return { replay: text };
    if (text.startsWith('PTR')) {
        try {
            const dec = await decodeReplayCodeAsync(text);
            // Custom tracks travel inside the code; keep them so 'run' can find the track again.
            return { replay: dec.replay, trackCode: dec.track ? encodeTrack(dec.track) : null };
        } catch (e) {
            return fail(e.message);
        }
    }
    try {
        const data = JSON.parse(text);
        return { replay: data.replay && data.replay.inputs ? data.replay : data };
    } catch (e) {
        return fail(`'${arg}' is neither a replay JSON, a PTR replay code nor an input string (1:...)`);
    }
}

async function cmdFromReplay(pos, flags) {
    const { replay, trackCode } = await readReplayArg(pos[0]);
    const tl = fromReplay(replay);
    const meta = replayMeta(replay);
    if (trackCode) meta.track = trackCode;
    const text = serialize(tl, { style: flags.style || 'ranges', meta });
    if (flags.out) {
        writeOut(flags.out, text);
        console.log(`Script  ${tl.length} ticks written to ${flags.out}`);
    } else process.stdout.write(text);
}

async function cmdAutopilot(pos, flags) {
    const track = await resolveTrack(pos[0]);
    const world = buildWorld(track);
    const res = runAutopilot(world, { record: true, laps: lapsOf(flags) });
    if (!res.finished) fail(`the autopilot did not finish ${track.id} (${res.gaveUp ? 'gave up' : 'out of time'})`);
    const tl = fromReplay(res.replay);
    const text = serialize(tl, {
        style: flags.style || 'ranges',
        meta: { track: track.id, hash: world.hash, name: 'Autopilot', time: formatTime(res.timeMs), laps: res.sim.laps > 1 ? res.sim.laps : undefined },
        comment: `autopilot run: ${res.respawns} respawns, checkpoints ${res.checkpointTimes.map((t) => formatTime(t)).join(' ')}`,
    });
    if (flags.out) {
        writeOut(flags.out, text);
        console.log(`Autopilot ${formatTime(res.timeMs)} on ${track.id}; script written to ${flags.out}`);
    } else process.stdout.write(text);
}

async function cmdToReplay(pos, flags) {
    const { world, script, file } = await trackAndScript(pos);
    const replay = toReplay(script.timeline, world, { laps: lapsOf(flags), name: script.meta.name || path.basename(file), date: new Date().toISOString() });
    if (flags.code) {
        // Official tracks travel by id; anything else rides inside the code.
        const track = isOfficial(world.track.id) ? null : world.track;
        console.log(await encodeReplayCodeAsync(replay, track, { name: replay.name }));
        return;
    }
    const json = JSON.stringify(replay);
    if (flags.out) {
        writeOut(flags.out, json);
        console.log(`Replay  ${replay.finished ? formatTime(replay.timeMs) : 'not finished'}, ${replay.ticks} ticks written to ${flags.out}`);
    } else console.log(json);
}

async function cmdCompare(pos, flags) {
    let trackArg = null, files = pos;
    if (pos.length >= 3) [trackArg, ...files] = pos;
    if (files.length !== 2) fail('expected [<track>] <a.txt> <b.txt>');
    const a = readScript(files[0]), b = readScript(files[1]);
    const track = await resolveTrack(trackArg ?? a.meta.track ?? b.meta.track);
    const world = buildWorld(track);
    const cmp = compareTimelines(world, a.timeline, b.timeline, { laps: lapsOf(flags) });
    const t = (ms) => (ms == null ? '-'.padStart(9) : formatTime(ms).padStart(9));
    const d = (ms) => (ms == null ? '' : formatTime(ms, { style: 'short', sign: true }));
    console.log(`Track   ${track.id || '?'} ${track.name || ''}`);
    console.log(`A       ${files[0]}\nB       ${files[1]}`);
    if (cmp.firstInputDifference < 0) { console.log('Same inputs on every tick.'); return; }
    console.log(`Inputs differ from ${formatTime(cmp.firstInputDifference * 10)}; the cars part at ${cmp.divergeTick < 0 ? 'never' : formatTime(cmp.divergeTick * 10)}`
        + `, widest gap ${cmp.maxGap.toFixed(2)} m at ${formatTime(cmp.maxGapTick * 10)}`);
    console.log('          A          B      B - A');
    for (const sp of cmp.splits) console.log(`  CP ${String(sp.index).padEnd(3)}${t(sp.a)}  ${t(sp.b)}  ${d(sp.delta)}`);
    console.log(`  Finish${t(cmp.a.finishTimeMs)}  ${t(cmp.b.finishTimeMs)}  ${d(cmp.finishDelta)}`);
}

function cmdFmt(pos, flags) {
    if (!pos[0]) fail('expected <script.txt>');
    const res = readScript(pos[0]);
    const text = serialize(res.timeline, { style: flags.style || 'ranges', meta: res.meta });
    if (flags.out) writeOut(flags.out, text);
    else process.stdout.write(text);
}

const { pos, flags } = parseArgs(process.argv.slice(2));
const cmd = pos.shift();
if (!cmd || flags.help || cmd === 'help') usage(cmd ? 0 : 1);
switch (cmd) {
    case 'run': await cmdRun(pos, flags); break;
    case 'bruteforce': case 'bf': await cmdBruteforce(pos, flags); break;
    case 'from-replay': await cmdFromReplay(pos, flags); break;
    case 'autopilot': await cmdAutopilot(pos, flags); break;
    case 'to-replay': await cmdToReplay(pos, flags); break;
    case 'fmt': cmdFmt(pos, flags); break;
    case 'compare': await cmdCompare(pos, flags); break;
    default:
        // The short form from ARCHITECTURE.md: tas.mjs <track> <script> (or just <script>) means run.
        if (pos.length <= 1 && existsSync(pos.length ? pos[0] : cmd)) await cmdRun([cmd, ...pos], flags);
        else fail(`unknown command '${cmd}' (run, bruteforce, from-replay, autopilot, to-replay, fmt, compare)`);
}
