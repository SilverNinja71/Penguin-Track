// A small multilayer perceptron for driving policies: dense layers with tanh
// or relu, deterministic seeded initialisation and a flat parameter vector
// that neuroevolution can mutate directly. Pure: runs in the browser, Web
// Workers and Node, and gives bit-identical outputs everywhere (tanh goes
// through mathd's polynomial exp, never Math.tanh).
import { dexp } from '../core/mathd.js';
import { Rng } from '../core/rng.js';
import { toBase64Url, fromBase64Url } from '../core/codec.js';

export const MODEL_FORMAT = 'penguintrack-mlp';
const ACTIVATIONS = ['tanh', 'relu', 'linear'];

/** Deterministic tanh (mathd exp), saturating cleanly beyond |x| = 20. */
export function dtanh(x) {
    if (x > 20) return 1;
    if (x < -20) return -1;
    if (x >= 0) return 1 - 2 / (dexp(2 * x) + 1);
    return 2 / (dexp(-2 * x) + 1) - 1;
}

function activate(kind, x) {
    if (kind === 'tanh') return dtanh(x);
    if (kind === 'relu') return x > 0 ? x : 0;
    return x;
}

/** Number of weights + biases of a layer-size list. */
export function countParams(sizes) {
    let n = 0;
    for (let l = 0; l + 1 < sizes.length; l++) n += sizes[l] * sizes[l + 1] + sizes[l + 1];
    return n;
}

function checkSpec(spec) {
    const sizes = spec.sizes;
    if (!Array.isArray(sizes) || sizes.length < 2 || !sizes.every((n) => Number.isInteger(n) && n > 0)) {
        throw new Error(`MLP sizes must be a list of positive integers, got ${JSON.stringify(sizes)}`);
    }
    const activation = spec.activation || 'tanh';
    const output = spec.output || 'linear';
    if (!ACTIVATIONS.includes(activation)) throw new Error(`Unknown activation '${activation}'`);
    if (!ACTIVATIONS.includes(output)) throw new Error(`Unknown output activation '${output}'`);
    return { sizes: sizes.slice(), activation, output };
}

export class MLP {
    /**
     * spec: { sizes: [in, hidden..., out], activation = 'tanh' | 'relu',
     * output = 'linear' | 'tanh' | 'relu', seed = 1, outputScale = 0.5 }.
     * Weights start as N(0, gain / sqrt(fanIn)) from the seeded core Rng
     * (gain √2 for relu), the output layer scaled by outputScale; biases 0.
     */
    constructor(spec) {
        const s = checkSpec(spec);
        this.sizes = s.sizes;
        this.activation = s.activation;
        this.output = s.output;
        this.paramCount = countParams(this.sizes);
        this.params = new Float64Array(this.paramCount);
        let widest = 0;
        for (const n of this.sizes) if (n > widest) widest = n;
        this._a = new Float64Array(widest);
        this._b = new Float64Array(widest);
        this._out = new Float64Array(this.sizes[this.sizes.length - 1]);
        if (spec.params) this.setParams(spec.params);
        else this.randomize(spec.seed ?? 1, spec.outputScale);
    }

    get inputSize() {
        return this.sizes[0];
    }

    get outputSize() {
        return this.sizes[this.sizes.length - 1];
    }

    /** Architecture only (what a worker needs to rebuild the net). */
    get arch() {
        return { sizes: this.sizes.slice(), activation: this.activation, output: this.output };
    }

    /** Fresh seeded weights. seed: number or a core Rng (consumed). */
    randomize(seed = 1, outputScale = 0.5) {
        MLP.randomParams(this.arch, seed, outputScale, this.params);
        return this;
    }

    /**
     * A random parameter vector for an architecture, rounded to float32 so it
     * survives the compact model encoding exactly.
     */
    static randomParams(arch, seed = 1, outputScale = 0.5, out = null) {
        const sizes = arch.sizes;
        const p = out || new Float64Array(countParams(sizes));
        const rng = typeof seed === 'object' && seed ? seed : new Rng(seed);
        const gain = arch.activation === 'relu' ? Math.SQRT2 : 1;
        let k = 0;
        for (let l = 0; l + 1 < sizes.length; l++) {
            const nIn = sizes[l], nOut = sizes[l + 1];
            const last = l + 2 === sizes.length;
            const std = (gain / Math.sqrt(nIn)) * (last ? outputScale : 1);
            for (let i = 0; i < nIn * nOut; i++) p[k++] = Math.fround(rng.normal(0, std));
            for (let i = 0; i < nOut; i++) p[k++] = 0;
        }
        return p;
    }

    /** Forward pass. Returns an internal Float64Array (copy it to keep it). */
    forward(input) {
        const sizes = this.sizes, P = this.params, L = sizes.length - 1;
        let src = this._a, dst = this._b;
        const n0 = sizes[0];
        if (input.length < n0) throw new Error(`MLP expects ${n0} inputs, got ${input.length}`);
        for (let i = 0; i < n0; i++) src[i] = input[i];
        let k = 0;
        for (let l = 0; l < L; l++) {
            const nIn = sizes[l], nOut = sizes[l + 1];
            const act = l + 1 === L ? this.output : this.activation;
            const bias = k + nIn * nOut;
            for (let o = 0; o < nOut; o++) {
                let sum = P[bias + o];
                const row = k + o * nIn;
                for (let i = 0; i < nIn; i++) sum += P[row + i] * src[i];
                dst[o] = activate(act, sum);
            }
            k = bias + nOut;
            const t = src; src = dst; dst = t;
        }
        const out = this._out;
        for (let o = 0; o < out.length; o++) out[o] = src[o];
        return out;
    }

    /** Copy of the flat parameters (layer by layer: weights row-major [out][in], then biases). */
    getParams(out = null) {
        const p = out || new Float64Array(this.paramCount);
        p.set(this.params);
        return p;
    }

    setParams(flat) {
        if (!flat || flat.length !== this.paramCount) {
            throw new Error(`Expected ${this.paramCount} parameters, got ${flat ? flat.length : 0}`);
        }
        for (let i = 0; i < this.paramCount; i++) this.params[i] = Number(flat[i]);
        return this;
    }

    clone() {
        return new MLP({ ...this.arch, params: this.params });
    }

    /**
     * Plain JSON. encoding 'f32' (default) stores the weights as base64url
     * little-endian float32 (4 bytes per weight; exact for float32-rounded
     * params such as the trainers produce); 'array' stores plain numbers (exact
     * for any float64).
     */
    toJSON(opts = {}) {
        const encoding = opts.encoding || 'f32';
        const json = { format: MODEL_FORMAT, version: 1, ...this.arch, paramCount: this.paramCount };
        if (encoding === 'array') json.params = Array.from(this.params);
        else json.weights = { encoding: 'f32', data: encodeF32(this.params) };
        return json;
    }

    static fromJSON(json) {
        if (!json || json.format !== MODEL_FORMAT) throw new Error('Not a Penguintrack MLP');
        let params;
        if (Array.isArray(json.params)) params = json.params;
        else if (json.weights && json.weights.encoding === 'f32') params = decodeF32(json.weights.data);
        else throw new Error('MLP JSON has no weights');
        return new MLP({ sizes: json.sizes, activation: json.activation, output: json.output, params });
    }
}

/** Float array -> base64url of little-endian float32 values. */
export function encodeF32(values) {
    const bytes = new Uint8Array(values.length * 4);
    const dv = new DataView(bytes.buffer);
    for (let i = 0; i < values.length; i++) dv.setFloat32(i * 4, values[i], true);
    return toBase64Url(bytes);
}

/** base64url little-endian float32 -> Float64Array. */
export function decodeF32(text) {
    const bytes = fromBase64Url(text);
    if (bytes.length % 4) throw new Error('Corrupt float32 weights');
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const out = new Float64Array(bytes.length / 4);
    for (let i = 0; i < out.length; i++) out[i] = dv.getFloat32(i * 4, true);
    return out;
}

/** Float array -> base64url of little-endian float64 values (exact; trainer states). */
export function encodeF64(values) {
    const bytes = new Uint8Array(values.length * 8);
    const dv = new DataView(bytes.buffer);
    for (let i = 0; i < values.length; i++) dv.setFloat64(i * 8, values[i], true);
    return toBase64Url(bytes);
}

/** base64url little-endian float64 -> Float64Array. */
export function decodeF64(text) {
    const bytes = fromBase64Url(text);
    if (bytes.length % 8) throw new Error('Corrupt float64 data');
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const out = new Float64Array(bytes.length / 8);
    for (let i = 0; i < out.length; i++) out[i] = dv.getFloat64(i * 8, true);
    return out;
}

/** Rounds every entry to float32 precision in place (keeps params encodable exactly). */
export function roundF32(params) {
    for (let i = 0; i < params.length; i++) params[i] = Math.fround(params[i]);
    return params;
}
