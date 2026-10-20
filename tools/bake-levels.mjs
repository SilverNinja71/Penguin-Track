#!/usr/bin/env node
// Bakes medals and author ghosts for the official tracks into js/levels/baked.js.
//
// For every track the core autopilot drives with a sweep of its tuning options
// (coordinate descent from the defaults, then a few steering resolutions) and
// the fastest clean finish becomes the author run: its time is the Emperor
// medal and its inputs are the Emperor ghost, so the author time is provably
// achievable on the current physics. Other medals derive from it (LEVELS.md).
//
// Usage: node tools/bake-levels.mjs [ids…] [--quick]
//   ids     only re-bake these tracks (comma or space separated); others keep their bake
//   --quick a smaller sweep (iteration while designing)
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildWorld } from '../js/core/track.js';
import { Autopilot, AUTOPILOT_DEFAULTS } from '../js/core/autopilot.js';
import { Sim } from '../js/core/sim.js';
import { Recorder } from '../js/core/replay.js';
import { STEER_MAX } from '../js/core/constants.js';
import { formatTime } from '../js/core/format.js';
import * as levels from '../js/levels/index.js';
import { BAKED } from '../js/levels/baked.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BAKED_FILE = path.join(ROOT, 'js', 'levels', 'baked.js');

/** Options the sweep explores, each with the values tried (defaults first). */
export const SWEEP = [
    ['gripMargin', [AUTOPILOT_DEFAULTS.gripMargin, 0.96, 1.0, 1.04, 1.08, 1.12, 0.88]],
    ['brakeMargin', [AUTOPILOT_DEFAULTS.brakeMargin, 0.9, 1.0, 0.7]],
    ['crestFactor', [AUTOPILOT_DEFAULTS.crestFactor, 1.4, 1.6, 1.1]],
    ['lookPerSpeed', [AUTOPILOT_DEFAULTS.lookPerSpeed, 0.24, 0.32]],
    ['lineMargin', [AUTOPILOT_DEFAULTS.lineMargin, 2.0, 3.2]],
    ['jumpFactor', [AUTOPILOT_DEFAULTS.jumpFactor, 1.08, 1.25]],
    ['speedSlack', [AUTOPILOT_DEFAULTS.speedSlack, 0.8, 2.5]],
];
/** Steering resolutions tried on the best options (coarser = smaller ghosts). */
export const QUANTS = [2048, 1024, 4096];
const SHORT = {
    gripMargin: 'g', brakeMargin: 'b', crestFactor: 'c', lookPerSpeed: 'l', lineMargin: 'm', jumpFactor: 'j', speedSlack: 's',
};

/**
 * One autopilot drive (the runAutopilot loop and give-up rules) whose steering
 * is rounded to multiples of `quant`, recording what every tick simulated.
 * Returns { finished, timeMs, respawns, ticks, replay }.
 */
export function driveAuthor(world, opts = {}, quant = 2048, limits = {}) {
    const { maxTicks = 30000, maxRespawns = 40, giveUpAfter = 12 } = limits;
    const sim = new Sim(world);
    const pilot = new Autopilot(world, opts);
    const rec = new Recorder();
    let marks = 0, respawnsAtMark = 0;
    while (!sim.finished && sim.tick < maxTicks) {
        const input = pilot.act(sim);
        if (quant > 1 && input.steer !== STEER_MAX && input.steer !== -STEER_MAX) {
            input.steer = Math.round(input.steer / quant) * quant;
        }
        sim.step(input);
        rec.push(sim.lastInput);
        const progress = sim.checkpointTimes.length + sim.lapTimes.length;
        if (progress !== marks) { marks = progress; respawnsAtMark = sim.respawns; }
        if (sim.respawns > maxRespawns || sim.respawns - respawnsAtMark > giveUpAfter) break;
    }
    return {
        finished: sim.finished,
        timeMs: sim.finished ? sim.finishTimeMs : null,
        respawns: sim.respawns,
        ticks: sim.tick,
        replay: rec.toReplay({ sim, name: 'Emperor' }),
    };
}

/** Lower is better: clean finishes by time, then finishes with respawns, then the rest. */
function score(run) {
    if (!run.finished) return Infinity;
    return run.respawns * 1e7 + run.timeMs;
}

function label(opts, quant) {
    return SWEEP.map(([k]) => `${SHORT[k]}${opts[k]}`).join(' ') + ` q${quant}`;
}

/**
 * The fastest autopilot run over the option sweep:
 * { run, opts, quant, tried, pilot (label) } — run is null when nothing finished.
 */
export function bestAuthorRun(world, { quick = false } = {}) {
    const opts = {};
    for (const [k, vals] of SWEEP) opts[k] = vals[0];
    const seen = new Map();
    const tryRun = (o, q) => {
        const key = label(o, q);
        if (!seen.has(key)) seen.set(key, driveAuthor(world, o, q));
        return seen.get(key);
    };
    let quant = QUANTS[0];
    let best = tryRun(opts, quant);
    const passes = quick ? 1 : 2;
    for (let pass = 0; pass < passes; pass++) {
        let improved = false;
        for (const [k, vals] of SWEEP) {
            if (quick && (k === 'speedSlack' || k === 'lineMargin')) continue;
            for (const v of vals) {
                if (v === opts[k]) continue;
                const o = { ...opts, [k]: v };
                const r = tryRun(o, quant);
                if (score(r) < score(best)) { best = r; opts[k] = v; improved = true; }
            }
        }
        if (!improved) break;
    }
    if (!quick) {
        for (const q of QUANTS.slice(1)) {
            const r = tryRun(opts, q);
            if (score(r) < score(best)) { best = r; quant = q; }
        }
    }
    return { run: best.finished ? best : null, opts, quant, tried: seen.size, pilot: label(opts, quant) };
}

/** Medals from an author time (ms). Platform: author time with 0 respawns plus respawn caps. */
export function medalsFromAuthor(authorMs, mode = 'race') {
    if (mode === 'platform') return { author: authorMs, gold: 0, silver: 3, bronze: 10 };
    // Integer arithmetic, so a round author time never picks up a float ulp (10000 * 1.06 > 10600).
    return {
        author: authorMs,
        gold: Math.ceil((authorMs * 106) / 10000) * 100,
        silver: Math.ceil((authorMs * 12) / 10000) * 1000,
        bronze: Math.ceil((authorMs * 15) / 10000) * 1000,
    };
}

function entryText(id, e) {
    const fields = [
        `hash: '${e.hash}'`,
        `author: ${e.author}`, `gold: ${e.gold}`, `silver: ${e.silver}`, `bronze: ${e.bronze}`,
    ];
    if (e.respawnTicks && e.respawnTicks.length) fields.push(`respawnTicks: [${e.respawnTicks.join(', ')}]`);
    fields.push(`pilot: '${e.pilot}'`);
    return `    ${id}: {\n        ${fields.join(', ')},\n        inputs: '${e.inputs}',\n    },\n`;
}

/** Writes baked.js with entries in campaign order (stable output for stable inputs). */
export function writeBaked(entries, order, file = BAKED_FILE) {
    let out = '// GENERATED by tools/bake-levels.mjs — do not edit by hand.\n'
        + '// Per track: layout hash, medals (ms; platform: author ms + respawn caps), the\n'
        + '// autopilot options of the author run, and that run (the Emperor ghost) as encoded inputs.\n'
        + 'export const BAKED = {\n';
    for (const id of order) if (entries[id]) out += entryText(id, entries[id]);
    out += '};\n';
    writeFileSync(file, out);
}

function main() {
    const args = process.argv.slice(2);
    const quick = args.includes('--quick');
    const only = new Set(args.filter((a) => !a.startsWith('--')).flatMap((a) => a.split(',')).filter(Boolean));
    const ids = levels.trackIds();
    for (const id of only) if (!ids.includes(id)) throw new Error(`Unknown track id ${id}`);
    const entries = {};
    for (const id of ids) if (BAKED[id]) entries[id] = { ...BAKED[id] };
    let failures = 0;
    const t0 = performance.now();
    for (const id of ids) {
        if (only.size && !only.has(id)) continue;
        const track = levels.getTrack(id);
        const world = buildWorld(track);
        if (!world.route) {
            console.log(`${id}  NO ROUTE: ${world.routeError}`);
            failures++;
            continue;
        }
        const ts = performance.now();
        const best = bestAuthorRun(world, { quick });
        const secs = ((performance.now() - ts) / 1000).toFixed(1);
        if (!best.run || (track.mode === 'platform' && best.run.respawns > 0)) {
            console.log(`${id}  NO CLEAN FINISH after ${best.tried} drives (${secs} s)`);
            failures++;
            continue;
        }
        const r = best.run;
        const medals = medalsFromAuthor(r.timeMs, track.mode);
        entries[id] = {
            hash: world.hash, ...medals, respawnTicks: r.replay.respawnTicks,
            pilot: best.pilot, inputs: r.replay.inputs,
        };
        const gold = track.mode === 'platform' ? `≤${medals.gold} resp` : formatTime(medals.gold);
        const warn = r.respawns ? `  (${r.respawns} respawns!)` : '';
        console.log(`${id.padEnd(4)} ${track.name.padEnd(24)} author ${formatTime(r.timeMs)}  gold ${gold}${warn}`
            + `  ${best.tried} drives ${secs} s  [${best.pilot}]  ${r.replay.inputs.length} chars`);
    }
    writeBaked(entries, ids);
    const total = ((performance.now() - t0) / 1000).toFixed(1);
    console.log(`\nWrote ${path.relative(process.cwd(), BAKED_FILE)} (${Object.keys(entries).length} tracks) in ${total} s`);
    if (failures) {
        console.log(`${failures} track(s) failed to bake`);
        process.exitCode = 1;
    }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main();
