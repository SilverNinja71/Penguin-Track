#!/usr/bin/env node
// Headless Penguintrack environment server for external RL (Python etc.):
// one JSON request per line on stdin, one JSON reply per line on stdout.
//
//   {"cmd":"make","track":"S01","config":{"frameSkip":4},"num_envs":1,"obs_encoding":"b64"}
//   {"cmd":"reset","seed":1}
//   {"cmd":"step","action":3}
//   {"cmd":"step_batch","actions":[3,3,6,0]}      (num_envs envs, auto-reset)
//   {"cmd":"get_state"} / {"cmd":"set_state","state":{...}}
//   {"cmd":"replay"}                               (encoded inputs of the current episode)
//   {"cmd":"close"}
//
// Replies are {"ok":true,...} or {"ok":false,"error":"..."}; a request's "id"
// is echoed. Observations are base64 little-endian float32 ("b64", default)
// or plain number lists rounded to 1e-6 ("list"). Full protocol: docs/AI.md.
import { createInterface } from 'node:readline';
import { readFileSync, existsSync } from 'node:fs';
import { endianness } from 'node:os';
import { PenguinEnv, ENV_VERSION } from '../js/ai/env.js';
import { resolveTrack, listTracks } from '../js/ai/tracks.js';
import { buildWorld } from '../js/core/track.js';

const PROTOCOL = 1;
const LITTLE = endianness() === 'LE';
const MAX_ENVS = 256;

let envs = [];
let encoding = 'b64';
let spaces = null;
let lastReplays = [];

function encodeObs(obs) {
    if (encoding === 'list') {
        const out = new Array(obs.length);
        for (let i = 0; i < obs.length; i++) out[i] = Math.round(obs[i] * 1e6) / 1e6;
        return out;
    }
    let bytes = Buffer.from(obs.buffer, obs.byteOffset, obs.byteLength);
    if (!LITTLE) {
        bytes = Buffer.from(bytes);
        bytes.swap32();
    }
    return bytes.toString('base64');
}

function envAt(req) {
    if (!envs.length) throw new Error("No environment: send {\"cmd\":\"make\"} first");
    const i = req.env ?? 0;
    if (!Number.isInteger(i) || i < 0 || i >= envs.length) throw new Error(`No env ${i} (0..${envs.length - 1})`);
    return envs[i];
}

async function loadTrack(spec) {
    if (typeof spec === 'string' && spec.endsWith('.json') && existsSync(spec)) {
        return JSON.parse(readFileSync(spec, 'utf8'));
    }
    return resolveTrack(spec ?? 'S01');
}

function cleanInfo(info) {
    // Floats trimmed so replies stay short; everything else passes through.
    return {
        ...info,
        progress: Math.round(info.progress * 1000) / 1000,
        progressFrac: Math.round(info.progressFrac * 1e6) / 1e6,
        speedKmh: Math.round(info.speedKmh * 100) / 100,
        episodeReturn: Math.round(info.episodeReturn * 1e6) / 1e6,
    };
}

function stepResult(r) {
    return {
        obs: encodeObs(r.obs),
        reward: r.reward,
        terminated: r.terminated,
        truncated: r.truncated,
        info: cleanInfo(r.info),
    };
}

const handlers = {
    ping() {
        return { pong: true, protocol: PROTOCOL, envVersion: ENV_VERSION };
    },

    async tracks() {
        return { tracks: await listTracks() };
    },

    async make(req) {
        const n = req.num_envs ?? 1;
        if (!Number.isInteger(n) || n < 1 || n > MAX_ENVS) throw new Error(`num_envs must be 1..${MAX_ENVS}`);
        const enc = req.obs_encoding ?? 'b64';
        if (enc !== 'b64' && enc !== 'list') throw new Error("obs_encoding must be 'b64' or 'list'");
        const track = await loadTrack(req.track);
        const world = buildWorld(track);
        const config = req.config || {};
        const made = [];
        for (let i = 0; i < n; i++) made.push(new PenguinEnv({ ...config, seed: (config.seed ?? 0) + i, world }));
        envs = made;
        encoding = enc;
        lastReplays = new Array(n).fill(null);
        const e = envs[0];
        spaces = {
            observation_space: e.observationSpace,
            action_space: e.actionSpace,
            track: {
                id: world.track.id ?? null, name: world.track.name ?? null, hash: world.hash,
                length: world.route.length, laps: e.laps, checkpoints: world.checkpointCount,
            },
            num_envs: n,
            obs_encoding: encoding,
            env_config: e.config,
        };
        return spaces;
    },

    spaces() {
        if (!spaces) throw new Error('No environment yet');
        return spaces;
    },

    reset(req) {
        const env = envAt(req);
        const obs = env.reset(req.seed ?? undefined);
        return { obs: encodeObs(obs), info: cleanInfo(env.info()) };
    },

    step(req) {
        return stepResult(envAt(req).step(req.action));
    },

    // Steps every env once (actions[i] for env i). Envs that end are reset at once:
    // their reply carries the new episode's first obs, with the terminal obs in
    // info.final_obs (gymnasium / SB3 vector-env semantics).
    step_batch(req) {
        if (!envs.length) throw new Error('No environment: send make first');
        const acts = req.actions;
        if (!Array.isArray(acts) || acts.length !== envs.length) throw new Error(`step_batch needs ${envs.length} actions`);
        const out = { obs: [], reward: [], terminated: [], truncated: [], info: [] };
        for (let i = 0; i < envs.length; i++) {
            const env = envs[i];
            if (env.done) env.reset();
            const r = env.step(acts[i]);
            let obs = r.obs;
            const info = cleanInfo(r.info);
            if (r.terminated || r.truncated) {
                info.final_obs = encodeObs(r.obs);
                lastReplays[i] = env.replay();
                obs = env.reset();
            }
            out.obs.push(encodeObs(obs));
            out.reward.push(r.reward);
            out.terminated.push(r.terminated);
            out.truncated.push(r.truncated);
            out.info.push(info);
        }
        return out;
    },

    reset_all(req) {
        if (!envs.length) throw new Error('No environment: send make first');
        const seed = req.seed;
        const obs = envs.map((e, i) => encodeObs(e.reset(seed == null ? undefined : seed + i)));
        return { obs };
    },

    get_state(req) {
        return { state: envAt(req).getState({ inputs: req.inputs !== false }) };
    },

    set_state(req) {
        const env = envAt(req);
        const obs = env.setState(req.state);
        return { obs: encodeObs(obs), info: cleanInfo(env.info()) };
    },

    replay(req) {
        const env = envAt(req);
        if (req.last) return { replay: lastReplays[req.env ?? 0] };
        return { replay: env.replay({ name: req.name }) };
    },
};

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
let chain = Promise.resolve();
let closing = false;

function reply(obj) {
    process.stdout.write(JSON.stringify(obj) + '\n');
}

async function handleLine(line) {
    if (closing) return;
    const text = line.trim();
    if (!text) return;
    let req;
    try {
        req = JSON.parse(text);
    } catch (e) {
        reply({ ok: false, error: `Bad JSON: ${e.message}` });
        return;
    }
    const id = req && req.id;
    const cmd = req && req.cmd;
    if (cmd === 'close') {
        closing = true;
        process.stdout.write(JSON.stringify(id !== undefined ? { ok: true, id } : { ok: true }) + '\n', () => process.exit(0));
        return;
    }
    const h = typeof cmd === 'string' && Object.hasOwn(handlers, cmd) ? handlers[cmd] : null;
    try {
        if (!h) throw new Error(`Unknown cmd '${cmd}' (make, reset, step, step_batch, reset_all, get_state, set_state, replay, spaces, tracks, ping, close)`);
        const res = await h(req);
        reply(id !== undefined ? { ok: true, id, ...res } : { ok: true, ...res });
    } catch (e) {
        const err = { ok: false, error: String((e && e.message) || e), cmd: cmd ?? null };
        if (id !== undefined) err.id = id;
        reply(err);
    }
}

rl.on('line', (line) => {
    chain = chain.then(() => handleLine(line));
});
// When stdin closes, queued requests still run, replies flush and the process ends on its own.
