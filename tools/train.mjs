#!/usr/bin/env node
// Zero-dependency neuroevolution trainer for Penguintrack drivers.
//
//   node tools/train.mjs --track S01 --algo ga --pop 64 --gens 200 --hidden 32,32 --seed 1
//   node tools/train.mjs --track T01 --algo es --workers 8 --out models/t01-es.json
//   node tools/train.mjs --resume models/t01-es.json --gens 400     (continue a run)
//   node tools/train.mjs --eval models/demo-S01.json [--replay-out run.json]
//
// Evaluations run in a worker_threads pool (js/ai/worker.js, the same worker the
// browser AI Lab uses). Every generation prints a progress row; the best model
// (weights, env config, stats and its run as a replay the browser can show as a
// ghost) is saved to --out, the trainer state next to it (<out>.state.json) for
// --resume. See docs/AI.md.
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { availableParallelism, cpus } from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { NeuroTrainer, LocalEvaluator, GA_DEFAULTS, ES_DEFAULTS } from '../js/ai/neuro.js';
import { EvalPool } from '../js/ai/pool.js';
import { archFor, makeModelFile, loadModelFile, runEpisode } from '../js/ai/policy.js';
import { normalizeEnvConfig, PenguinEnv } from '../js/ai/env.js';
import { resolveTrack } from '../js/ai/tracks.js';
import { buildWorld } from '../js/core/track.js';
import { decodeTrack } from '../js/core/codec.js';
import { formatTime } from '../js/core/format.js';
import { verifyReplay } from '../js/core/replay.js';

const WORKER_URL = new URL('../js/ai/worker.js', import.meta.url);

const HELP = `Penguintrack neuroevolution trainer

  --track ID|file|code   track: level id (A01), sample (S01..S06), track .json, PT1. code   [S01]
  --algo ga|es           genetic algorithm or evolution strategies                        [ga]
  --pop N                population size (ES: even)                                       [64]
  --gens N               generations to run (total, counting resumed ones)                [200]
  --hidden 32,32         hidden layer sizes                                               [32,32]
  --activation tanh|relu hidden activation                                                [tanh]
  --seed N               training seed (same seed => same training curve)                 [1]
  --workers N            evaluation threads                                               [cpus - 1, max 12]
  --frame-skip N         ticks per action                                                 [4]
  --max-seconds S|auto   episode time budget (auto: route length / 15 m/s, at least 30)   [auto]
  --action discrete|continuous                                                            [discrete]
  --start-mode start|random-checkpoint|random                                             [start]
  --episodes N           episodes per evaluation (only useful with random starts)         [1]
  --fitness race|return  race: 100 x route share, finished 100 + seconds under budget;
                         return: the env's reward sum                                     [race]
  --mutation STD         GA mutation std                                                  [${GA_DEFAULTS.mutationStd}]
  --elite N              GA elites                                                        [${GA_DEFAULTS.eliteCount}]
  --crossover P          GA crossover chance                                              [${GA_DEFAULTS.crossover}]
  --sigma S --lr LR      ES noise scale and Adam step                                     [${ES_DEFAULTS.sigma}, ${ES_DEFAULTS.lr}]
  --init model.json      start from a model's weights (fine-tuning; same architecture)
  --out file.json        model file to write                                              [./models/<track>-<algo>.json]
  --name NAME            model name                                                       [file name]
  --resume [file.json]   continue from <file>.state.json (default: --out)
  --time-limit MIN       stop after this many minutes
  --save-every N         save every N generations (and on a new best finish)             [10]
  --eval model.json      evaluate a model instead of training (--replay-out run.json)
  --quiet                only print the final summary
`;

function parseArgs(argv) {
    const a = {};
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        if (!k.startsWith('--')) throw new Error(`Unexpected argument '${k}'`);
        const key = k.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) a[key] = true;
        else { a[key] = next; i++; }
    }
    return a;
}

const num = (v, d) => (v === undefined || v === true ? d : Number(v));

async function loadTrack(spec) {
    if (typeof spec === 'string' && spec.endsWith('.json') && existsSync(spec)) {
        const json = JSON.parse(readFileSync(spec, 'utf8'));
        if (json.format === 'penguintrack-ai-model') return decodeTrack(json.trackCode);
        return json;
    }
    return resolveTrack(spec);
}

function pct(x) {
    return `${(x * 100).toFixed(0)}%`;
}

function clock(ms) {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function writeJson(file, obj) {
    mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(obj) + '\n');
    renameSync(tmp, file);
}

function statePath(out) {
    return out.replace(/\.json$/i, '') + '.state.json';
}

async function evalModel(args) {
    const file = JSON.parse(readFileSync(args.eval, 'utf8'));
    const { policy, envConfig } = loadModelFile(file);
    const track = args.track ? await loadTrack(args.track) : decodeTrack(file.trackCode);
    const env = new PenguinEnv({ ...envConfig, startMode: 'start', track });
    const t0 = performance.now();
    const r = runEpisode(env, policy, { seed: num(args.seed, 0), name: file.name });
    const ms = performance.now() - t0;
    const v = r.info.finished ? verifyReplay(env.world, r.replay) : { ok: false, reason: 'not finished' };
    console.log(`${file.name} on ${track.id || track.name}: ${r.info.finished ? `finished in ${formatTime(r.info.finishTimeMs)}` : `did not finish (${r.info.reason}, ${pct(r.info.progressFrac)} of the route)`}`);
    console.log(`return ${r.return.toFixed(3)}, ${r.steps} steps, ${r.info.respawns} respawns, ${ms.toFixed(0)} ms; replay ${v.ok ? 'verified' : `not verified (${v.reason})`}`);
    if (args['replay-out']) {
        writeJson(args['replay-out'], r.replay);
        console.log(`replay written to ${args['replay-out']}`);
    }
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help || args.h) {
        process.stdout.write(HELP);
        return;
    }
    if (args.eval) return evalModel(args);

    const algo = args.algo || 'ga';
    const out = typeof args.out === 'string' ? args.out : null;
    let resumeFile = null;
    if (args.resume) resumeFile = statePath(typeof args.resume === 'string' ? args.resume : out || '');
    let resumed = null;
    if (resumeFile) {
        if (!existsSync(resumeFile)) throw new Error(`Nothing to resume: ${resumeFile} does not exist`);
        resumed = JSON.parse(readFileSync(resumeFile, 'utf8'));
    }

    const trackSpec = resumed ? resumed.trackCode : args.track || 'S01';
    const track = resumed ? decodeTrack(resumed.trackCode) : await loadTrack(trackSpec);
    const world = buildWorld(track);
    if (!world.route) throw new Error(`Track ${track.id || ''} has no route: ${world.routeError}`);
    const envConfig = resumed ? resumed.envConfig : normalizeEnvConfig({
        frameSkip: num(args['frame-skip'], 4),
        maxSeconds: args['max-seconds'] && args['max-seconds'] !== 'auto' ? Number(args['max-seconds']) : autoSeconds(world),
        action: args.action || 'discrete',
        startMode: args['start-mode'] || 'start',
    });
    const hidden = String(args.hidden || '32,32').split(',').filter(Boolean).map(Number);
    let initModel = null;
    if (args.init) initModel = loadModelFile(JSON.parse(readFileSync(args.init, 'utf8')));
    const arch = resumed ? resumed.trainer.arch : initModel ? initModel.net.arch : archFor(envConfig, hidden, args.activation || 'tanh');
    const episodes = resumed ? resumed.episodes : num(args.episodes, 1);
    const fitness = resumed ? resumed.fitness || 'race' : args.fitness || 'race';
    const trackKey = (track.id || 'track').replace(/[^\w-]+/g, '_');
    const outFile = resumed ? resumed.out : out || path.join('models', `${trackKey}-${algo}.json`);
    const name = args.name || (resumed && resumed.name) || path.basename(outFile, '.json');
    const generations = num(args.gens, 200);
    const timeLimitMs = num(args['time-limit'], 0) * 60000;
    const saveEvery = num(args['save-every'], 10);
    const quiet = !!args.quiet;

    const nWorkers = Math.max(1, Math.min(num(args.workers, Math.min(12, (availableParallelism?.() ?? cpus().length) - 1)), 64));
    const workers = Array.from({ length: nWorkers }, () => new Worker(WORKER_URL));
    const pool = new EvalPool(workers);
    const ready = await pool.init({ trackJSON: track, envConfig, arch, episodes, fitness });

    const trainer = resumed
        ? new NeuroTrainer({ state: resumed.trainer, evaluator: pool })
        : new NeuroTrainer({
            algo, arch, seed: num(args.seed, 1), evaluator: pool, popSize: num(args.pop, 64),
            initParams: initModel ? initModel.net.params : null,
            ga: {
                mutationStd: num(args.mutation, GA_DEFAULTS.mutationStd),
                eliteCount: num(args.elite, GA_DEFAULTS.eliteCount),
                crossover: num(args.crossover, GA_DEFAULTS.crossover),
            },
            es: { sigma: num(args.sigma, ES_DEFAULTS.sigma), lr: num(args.lr, ES_DEFAULTS.lr) },
        });
    const replayEval = new LocalEvaluator({ world, envConfig: { ...envConfig, startMode: 'start' }, arch, episodes: 1, fitness });
    const trainMsBefore = resumed ? resumed.trainSeconds * 1000 : 0;

    if (!quiet) {
        console.log(`Training ${trainer.algo.toUpperCase()} on ${track.id || ''} ${track.name || ''} | net ${arch.sizes.join('-')} (${trainer.paramCount} weights, ${arch.activation})`
            + ` | pop ${trainer.opt.opts.popSize} | ${nWorkers} workers | frame skip ${envConfig.frameSkip} | ${envConfig.action} | ${fitness} fitness | ${envConfig.maxSeconds} s | seed ${trainer.seed}`
            + (resumed ? ` | resumed at generation ${trainer.generation}` : ''));
        console.log(`obs ${ready.obsSize}, actions ${ready.actionSize}; saving to ${outFile}`);
        console.log('  gen       best       mean  best-ever  finish  gen-time   best-time   route   evals/s  elapsed');
    }

    const t0 = Date.now();
    let lastSavedGen = -1, savedBest = null;
    const save = (final = false) => {
        const best = trainer.best;
        if (!best) return null;
        // Re-run the best weights from the start (a proper ghost) and store that run.
        const ev = replayEval.evaluateOne(best.params, { seed: 0, replay: true });
        const net = replayEval.net;
        net.setParams(best.params);
        const stats = {
            algo: trainer.algo, fitness, seed: trainer.seed, generations: trainer.generation, evaluations: trainer.evaluations,
            popSize: trainer.opt.opts.popSize, hidden: arch.sizes.slice(1, -1), bestFitness: best.fitness,
            bestGeneration: best.generation, return: ev.info.episodeReturn, finished: ev.info.finished,
            timeMs: ev.info.finished ? ev.info.finishTimeMs : null, progressFrac: ev.info.progressFrac,
            reason: ev.info.reason, trainSeconds: Math.round((trainMsBefore + Date.now() - t0) / 1000),
            history: trainer.history.map((h) => [h.generation, round3(h.best), round3(h.mean), round3(h.finishRate), h.bestTimeMs]),
        };
        const file = makeModelFile({
            name, world, envConfig, net, stats, date: new Date().toISOString(),
            replay: { ...ev.replay, name: `${name} (AI)` },
        });
        writeJson(outFile, file);
        writeJson(statePath(outFile), {
            format: 'penguintrack-train-run', version: 1, name, out: outFile, trackCode: file.trackCode, envConfig,
            episodes, fitness, trainSeconds: stats.trainSeconds, trainer: trainer.getState(),
        });
        lastSavedGen = trainer.generation;
        savedBest = best;
        if (final || !quiet) {
            const what = ev.info.finished ? `finishes in ${formatTime(ev.info.finishTimeMs)}` : `${pct(ev.info.progressFrac)} of the route (${ev.info.reason})`;
            console.log(`  saved ${final ? outFile : path.basename(outFile)}: best fitness ${best.fitness.toFixed(3)} (gen ${best.generation + 1}), ${what}`);
        }
        return ev;
    };

    let stop = false;
    process.on('SIGINT', () => {
        if (stop) process.exit(130);
        stop = true;
        console.log('\n  stopping after this generation (Ctrl+C again to quit now)');
    });

    let prevEvals = trainer.evaluations;
    while (trainer.generation < generations && !stop) {
        const s = await trainer.step();
        const elapsed = trainMsBefore + Date.now() - t0;
        if (!quiet) {
            const evalsPerSec = s.evalMs > 0 ? ((s.evaluations - prevEvals) * 1000) / s.evalMs : 0;
            console.log(
                `${String(s.generation + 1).padStart(5)} ${s.best.toFixed(3).padStart(10)} ${s.mean.toFixed(3).padStart(10)} ${s.bestEver.toFixed(3).padStart(10)}`
                + ` ${pct(s.finishRate).padStart(7)} ${(s.bestTimeMs != null ? formatTime(s.bestTimeMs) : '-').padStart(9)}`
                + ` ${(s.bestEverTimeMs != null ? formatTime(s.bestEverTimeMs) : '-').padStart(11)} ${pct(s.bestProgress).padStart(7)}`
                + ` ${evalsPerSec.toFixed(0).padStart(9)} ${clock(elapsed).padStart(8)}`,
            );
        }
        prevEvals = s.evaluations;
        const newBest = trainer.best !== savedBest && trainer.best.generation === s.generation && trainer.best.info.finished;
        if ((saveEvery > 0 && trainer.generation - lastSavedGen >= saveEvery) || newBest) save();
        if (timeLimitMs > 0 && Date.now() - t0 >= timeLimitMs) {
            if (!quiet) console.log(`  time limit reached (${args['time-limit']} min)`);
            break;
        }
    }
    const ev = save(true);
    pool.close();
    if (ev) {
        const v = ev.info.finished ? verifyReplay(world, ev.replay) : { ok: false };
        console.log(`done: ${trainer.generation} generations, ${trainer.evaluations} evaluations, ${clock(trainMsBefore + Date.now() - t0)}; `
            + `best ${ev.info.finished ? `finishes in ${formatTime(ev.info.finishTimeMs)}${v.ok ? ' (replay verified)' : ''}` : `reaches ${pct(ev.info.progressFrac)} (${ev.info.reason})`}`);
    }
}

/** Episode budget from the route: about 15 m/s average, 30 s at least, in steps of 10 s. */
function autoSeconds(world) {
    const total = world.route.length * (world.route.closed ? world.laps : 1);
    return Math.max(30, Math.ceil(total / 15 / 10) * 10);
}

function round3(x) {
    return Math.round(x * 1000) / 1000;
}

main().catch((e) => {
    console.error(`train: ${e && e.message ? e.message : e}`);
    process.exit(1);
});
