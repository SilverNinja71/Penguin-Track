#!/usr/bin/env node
// Checks every official track: it validates, builds, has a route, its baked
// author run (the Emperor ghost) re-simulates to exactly the baked author time
// on the current physics, the default autopilot finishes within bronze, ids
// and names are unique, and the bake matches the layout. Prints a table.
//
// Usage: node tools/verify-levels.mjs [ids…] [--no-drive]
//   --no-drive  skip the autopilot drive (validation + author replays only)
// Exit code 1 when anything fails. A stale bake (layout or physics changed)
// is reported with the command to re-run: node tools/bake-levels.mjs
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateTrack, buildWorld } from '../js/core/track.js';
import { BLOCKS, footprintSize } from '../js/core/blocks.js';
import { trackHash } from '../js/core/codec.js';
import { verifyReplay, simulateReplay } from '../js/core/replay.js';
import { runAutopilot } from '../js/core/autopilot.js';
import { formatTime } from '../js/core/format.js';
import * as levels from '../js/levels/index.js';
import { BAKED } from '../js/levels/baked.js';
import { medalsFromAuthor } from './bake-levels.mjs';

// Warnings an official track may carry: the run-out after a finish is an open road end.
const ALLOWED_WARNINGS = { race: ['openEnd'], platform: ['openEnd'] };
const MAX_CHECKPOINT_GAP_MS = 15000;   // "a checkpoint every ~8–12 s"; flag anything far beyond

/**
 * Verifies one track. Returns { id, ok, problems: [string], stale, row } where
 * row holds the table columns. opts: { drive = true }.
 */
export function verifyTrack(id, opts = {}) {
    const drive = opts.drive !== false;
    const problems = [];
    let stale = false;
    const track = levels.getTrack(id);
    const info = levels.trackInfo(id);
    const row = { length: null, cps: 0, maxGap: null, auto: null, autoResp: null };

    const v = validateTrack(track);
    for (const e of v.errors) problems.push(`invalid: ${e}`);
    for (const w of v.issues.filter((i) => i.level === 'warning')) {
        if (!ALLOWED_WARNINGS[track.mode].includes(w.code)) problems.push(`warning: ${w.message}`);
    }
    if (!info || info.name !== track.name) problems.push('campaign summary does not match the track');
    const used = new Set(levels.DECOR_KINDS);
    track.decor.forEach((d, i) => { if (!used.has(d.d)) problems.push(`decor #${i}: unknown kind '${d.d}'`); });
    problems.push(...decorClashes(track));

    let world;
    try {
        world = buildWorld(track);
    } catch (e) {
        problems.push(`build failed: ${e.message}`);
        return { id, ok: false, problems, stale, row };
    }
    if (!world.route) {
        problems.push(`no route: ${world.routeError}`);
        return { id, ok: false, problems, stale, row };
    }
    row.length = world.route.length * track.laps;
    row.cps = world.checkpointCount;

    const b = BAKED[id];
    if (!b) {
        stale = true;
        problems.push('not baked');
    } else {
        if (b.hash !== trackHash(track) || b.hash !== world.hash) {
            stale = true;
            problems.push(`stale bake: layout changed (baked ${b.hash}, now ${world.hash})`);
        }
        const expect = medalsFromAuthor(b.author, track.mode);
        for (const k of ['author', 'gold', 'silver', 'bronze']) {
            if (track.medals[k] !== expect[k]) problems.push(`medal ${k} is ${track.medals[k]}, the rule gives ${expect[k]}`);
        }
        const replay = levels.authorReplay(id);
        if (!stale) {
            const res = replay ? verifyReplay(world, replay) : { ok: false, reason: 'no author replay' };
            if (!res.ok) {
                stale = true;
                problems.push(`stale bake: author replay fails (${res.reason})`);
            } else if (res.timeMs !== b.author) {
                stale = true;
                problems.push(`stale bake: author replay gives ${res.timeMs} ms, baked ${b.author}`);
            } else if (track.mode === 'platform' && res.respawns !== 0) {
                problems.push(`platform author run respawns ${res.respawns} times`);
            }
            if (res.ok) {
                // Every checkpoint and lap line is a mark; the longest stretch between two is the gap.
                const sim = simulateReplay(world, replay, { sampleEvery: 0 });
                let lapEnd = 0;
                const laps = sim.lapTimes.map((t) => (lapEnd += t));
                const marks = [...sim.checkpointTimes, ...laps, sim.timeMs].sort((a, b) => a - b);
                row.maxGap = Math.max(...marks.map((t, i) => t - (i ? marks[i - 1] : 0)));
                if (row.maxGap > MAX_CHECKPOINT_GAP_MS) problems.push(`${(row.maxGap / 1000).toFixed(1)} s between checkpoints`);
            }
        }
    }

    if (drive) {
        const r = runAutopilot(world, { maxTicks: 60000 });
        row.auto = r.finished ? r.timeMs : null;
        row.autoResp = r.respawns;
        if (!r.finished) {
            problems.push(`autopilot does not finish (${r.respawns} respawns${r.gaveUp ? ', gave up' : ''})`);
        } else if (track.mode === 'platform') {
            if (track.medals.bronze != null && r.respawns > track.medals.bronze) problems.push(`autopilot respawns ${r.respawns} times, more than bronze allows`);
        } else if (track.medals.bronze != null && r.timeMs > track.medals.bronze) {
            problems.push(`autopilot ${formatTime(r.timeMs)} is slower than bronze ${formatTime(track.medals.bronze)}`);
        }
    }
    return { id, ok: problems.length === 0, problems, stale, row };
}

/** Decor standing on or inside a block (same column, at or just under its level). */
function decorClashes(track) {
    const occ = new Map();
    for (const b of track.blocks) {
        const [W, H, D] = footprintSize(BLOCKS[b.b], b.r);
        for (let x = b.x; x < b.x + W; x++) {
            for (let z = b.z; z < b.z + D; z++) {
                const k = `${x},${z}`;
                if (!occ.has(k)) occ.set(k, []);
                occ.get(k).push([b.y, b.y + H]);
            }
        }
    }
    const out = [];
    track.decor.forEach((d, i) => {
        const spans = occ.get(`${d.x},${d.z}`) || [];
        // Decor stands ~2 levels tall; it clashes with any block from its own level up to two above.
        if (spans.some(([y0, y1]) => y1 > d.y && y0 <= d.y + 2)) out.push(`decor #${i} (${d.d}) at ${d.x},${d.y},${d.z} clashes with a block`);
    });
    return out;
}

function medalText(track, k) {
    const v = track.medals[k];
    if (v == null) return '-';
    if (track.mode === 'platform' && k !== 'author') return `≤${v} resp`;
    return formatTime(v);
}

// Table columns: [title, width, right-aligned, cell(track, row)].
const COLUMNS = [
    ['id', 4, false, (t) => t.id],
    ['name', 24, false, (t) => t.name],
    ['mood', 6, false, (t) => t.mood],
    ['laps', 4, true, (t) => t.laps],
    ['length', 7, true, (t, r) => (r.length != null ? `${Math.round(r.length)} m` : '-')],
    ['author', 8, true, (t) => medalText(t, 'author')],
    ['gold', 8, true, (t) => medalText(t, 'gold')],
    ['silver', 9, true, (t) => medalText(t, 'silver')],
    ['bronze', 9, true, (t) => medalText(t, 'bronze')],
    ['cps', 3, true, (t, r) => r.cps],
    ['gap', 5, true, (t, r) => (r.maxGap != null ? (r.maxGap / 1000).toFixed(1) : '-')],
];
const DRIVE_COLUMN = ['autopilot', 13, true, (t, r) => (r.auto != null ? `${formatTime(r.auto)}${r.autoResp ? ` r${r.autoResp}` : ''}` : 'DNF')];

function tableLine(columns, cell) {
    return columns.map(([title, w, right, fn]) => {
        const s = String(cell(title, fn));
        return right ? s.padStart(w) : s.padEnd(w);
    }).join('  ');
}

function main() {
    const args = process.argv.slice(2);
    const drive = !args.includes('--no-drive');
    const only = new Set(args.filter((a) => !a.startsWith('--')).flatMap((a) => a.split(',')).filter(Boolean));
    const ids = levels.trackIds().filter((id) => !only.size || only.has(id));
    const problems = [];
    let stale = 0;

    // Unique ids and names across every campaign.
    const names = new Map();
    for (const id of levels.trackIds()) {
        const n = levels.trackInfo(id).name.toLowerCase();
        if (names.has(n)) problems.push(`${id}: name '${levels.trackInfo(id).name}' is also used by ${names.get(n)}`);
        names.set(n, id);
    }

    const columns = drive ? [...COLUMNS, DRIVE_COLUMN] : COLUMNS;
    console.log(tableLine(columns, (title) => title));
    const t0 = performance.now();
    for (const id of ids) {
        const res = verifyTrack(id, { drive });
        const t = levels.getTrack(id);
        console.log(tableLine(columns, (title, fn) => fn(t, res.row)) + (res.ok ? '' : '  FAIL'));
        for (const p of res.problems) problems.push(`${id}: ${p}`);
        if (res.stale) stale++;
    }
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    if (problems.length) {
        console.log(`\n${problems.length} problem(s):`);
        for (const p of problems) console.log(`  - ${p}`);
        if (stale) console.log(`\n${stale} track(s) have a stale or missing bake: run  node tools/bake-levels.mjs  (ids to re-bake only those).`);
        process.exitCode = 1;
    } else {
        console.log(`\nAll ${ids.length} tracks OK (${secs} s).`);
    }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main();
