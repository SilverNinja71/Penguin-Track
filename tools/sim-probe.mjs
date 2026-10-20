#!/usr/bin/env node
// Drives a track headless and prints a per-second log (speed, position,
// surface, effects, route progress, events). Handy for tuning physics and for
// checking that a track is drivable.
//
// Usage:
//   node tools/sim-probe.mjs <track> [options]
//     <track>          sample id (S01..S06), a share code (PT1....), a track .json
//                      file, or flat[:surface] for an endless flat field
//   --driver auto|gas|idle|script   default: auto (the Autopilot), or script when --script is given
//   --script "<seg>,<seg>,..."      seg = actions*duration, actions joined by '+':
//                      gas, brake, left, right, steer=<int>, respawn, coast;
//                      duration in seconds ("2.5s") or ticks ("40"). Example:
//                      "gas*3s,gas+right*1.2s,brake+left*0.4s,gas*5s"
//   --seconds N      stop after N seconds of race time (default 180)
//   --every N        log every N seconds (default 1; 0 = events only)
//   --events         print every event as it happens
//   --quiet          only print the summary
//   --json           print the summary as JSON
import { readFileSync, existsSync } from 'node:fs';
import { buildWorld } from '../js/core/track.js';
import { getSample } from '../js/core/samples.js';
import { decodeTrack } from '../js/core/codec.js';
import { Sim } from '../js/core/sim.js';
import { Autopilot } from '../js/core/autopilot.js';
import { STEER_MAX } from '../js/core/constants.js';
import { flatWorld } from './lib/testworlds.mjs';

function parseArgs(argv) {
    const a = { track: argv[0], driver: null, script: null, seconds: 180, every: 1, events: false, quiet: false, json: false };
    for (let i = 1; i < argv.length; i++) {
        const k = argv[i];
        if (k === '--driver') a.driver = argv[++i];
        else if (k === '--script') a.script = argv[++i];
        else if (k === '--seconds') a.seconds = Number(argv[++i]);
        else if (k === '--every') a.every = Number(argv[++i]);
        else if (k === '--events') a.events = true;
        else if (k === '--quiet') a.quiet = true;
        else if (k === '--json') a.json = true;
        else throw new Error(`unknown option ${k}`);
    }
    if (!a.driver) a.driver = a.script ? 'script' : 'auto';
    return a;
}

export function loadWorld(spec) {
    if (!spec) throw new Error('missing <track>');
    if (spec.startsWith('flat')) return { world: flatWorld({ surface: spec.split(':')[1] || 'snow', half: 8000 }), name: spec };
    let track;
    if (/^S\d\d$/i.test(spec)) track = getSample(spec.toUpperCase());
    else if (spec.startsWith('PT1.')) track = decodeTrack(spec);
    else if (existsSync(spec)) track = JSON.parse(readFileSync(spec, 'utf8'));
    if (!track) throw new Error(`cannot load track '${spec}'`);
    const world = buildWorld(track);
    if (world.errors.length) throw new Error(`track errors: ${world.errors.join('; ')}`);
    return { world, name: `${track.id} ${track.name}` };
}

/** "gas*3s,gas+right*1.5s" -> [{ input, ticks }] */
export function parseScript(text) {
    return text.split(',').map((seg) => seg.trim()).filter(Boolean).map((seg) => {
        const [acts, dur = '1s'] = seg.split('*');
        const input = { steer: 0, gas: false, brake: false };
        for (const a of acts.split('+').map((x) => x.trim())) {
            if (a === 'gas') input.gas = true;
            else if (a === 'brake') input.brake = true;
            else if (a === 'left') input.steer = -STEER_MAX;
            else if (a === 'right') input.steer = STEER_MAX;
            else if (a.startsWith('steer=')) input.steer = Math.round(Number(a.slice(6)));
            else if (a === 'respawn') input.respawn = true;
            else if (a !== 'coast' && a !== '') throw new Error(`unknown action '${a}' in '${seg}'`);
        }
        const ticks = dur.endsWith('s') ? Math.round(parseFloat(dur) * 100) : parseInt(dur, 10);
        return { input, ticks };
    });
}

function fmt(n, d = 1) {
    return (n >= 0 ? ' ' : '') + n.toFixed(d);
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const { world, name } = loadWorld(args.track);
    const sim = new Sim(world);
    const pilot = world.route ? new Autopilot(world) : null;
    const script = args.script ? parseScript(args.script) : [];
    let seg = 0, segTick = 0;
    const maxTicks = Math.round(args.seconds * 100);
    const every = Math.round(args.every * 100);
    const counts = {};
    let topKmh = 0;
    const proj = { s: 0, index: 0, t: 0, point: [0, 0, 0], tangent: [0, 0, 1], up: [0, 1, 0], lateral: 0, vertical: 0, dist: 0, halfWidth: 0 };
    let hint = -1;
    const pending = [];
    const log = (...x) => { if (!args.quiet && !args.json) console.log(...x); };

    log(`${name} — driver ${args.driver}${world.route ? `, route ${world.route.length.toFixed(0)} m, ${world.checkpointCount} CP, ${world.laps} lap(s)` : ''}`);
    log('  time   km/h   fwd      x        y        z     surf    air drift  route-s  lat   effects / events');
    const t0 = performance.now();
    while (sim.tick < maxTicks) {
        let input;
        if (args.driver === 'auto' && pilot) input = pilot.act(sim);
        else if (args.driver === 'gas') input = { steer: 0, gas: true, brake: false };
        else if (args.driver === 'script') {
            while (seg < script.length && segTick >= script[seg].ticks) { seg++; segTick = 0; }
            input = seg < script.length ? script[seg].input : { steer: 0, gas: false, brake: false };
            segTick++;
        } else input = { steer: 0, gas: false, brake: false };
        sim.step(input);
        const c = sim.car;
        if (c.speedKmh > topKmh) topKmh = c.speedKmh;
        for (const ev of sim.events) {
            counts[ev.type] = (counts[ev.type] || 0) + 1;
            const extra = ev.type === 'land' ? `(${ev.strength.toFixed(1)})` : ev.type === 'wallhit' ? `(${ev.intensity.toFixed(1)})`
                : ev.type === 'checkpoint' ? `#${ev.id}@${ev.timeMs}` : ev.type === 'effect' ? `:${ev.effect}` : ev.type === 'finish' ? `@${ev.timeMs}` : '';
            pending.push(ev.type + extra);
            if (args.events) log(`         ${(sim.tick / 100).toFixed(2)}s event ${ev.type}${extra}`);
        }
        const tickLog = every > 0 && sim.tick % every === 0;
        if (tickLog || (sim.finished && sim.events.some((e) => e.type === 'finish'))) {
            let rs = '     -', lat = '    -';
            if (world.route) {
                world.route.project(c.pos, hint, proj);
                hint = proj.index;
                rs = proj.s.toFixed(0).padStart(6);
                lat = fmt(proj.lateral, 1).padStart(5);
            }
            const fx = Object.entries(c.effects).filter(([k, v]) => v && k !== 'turboTime' && k !== 'cruiseSpeed').map(([k, v]) => (v === true ? k : `${k}${v}`)).join(' ');
            log(`${(sim.tick / 100).toFixed(2).padStart(6)} ${c.speedKmh.toFixed(0).padStart(6)} ${fmt(c.forwardSpeed * 3.6, 0).padStart(5)} ${c.pos.map((v) => v.toFixed(1).padStart(8)).join(' ')} ${(c.surfaceUnder || '-').padEnd(7)} ${c.airborne ? 'air' : '   '} ${c.drifting ? 'drift' : '     '} ${rs} ${lat}   ${fx}${fx && pending.length ? ' | ' : ''}${pending.join(' ')}`);
            pending.length = 0;
        }
        if (sim.finished && sim.tick > sim.finishTimeMs / 10 + 100) break;
    }
    const ms = performance.now() - t0;
    const summary = {
        track: name, driver: args.driver, finished: sim.finished, timeMs: sim.finished ? sim.finishTimeMs : null,
        ticks: sim.tick, respawns: sim.respawns, checkpoints: sim.checkpointTimes, lapTimes: sim.lapTimes,
        topKmh: Math.round(topKmh), events: counts, ticksPerSec: Math.round(sim.tick / (ms / 1000)),
    };
    if (args.json) console.log(JSON.stringify(summary));
    else console.log(`${summary.finished ? `FINISHED ${(summary.timeMs / 1000).toFixed(2)} s` : 'DNF'} — respawns ${summary.respawns}, top ${summary.topKmh} km/h, CPs [${summary.checkpoints.join(', ')}], laps [${summary.lapTimes.join(', ')}], ${summary.ticksPerSec} ticks/s, events ${JSON.stringify(counts)}`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) main();
