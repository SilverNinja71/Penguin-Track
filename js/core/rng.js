// Seeded PRNG (mulberry32). Integer-only state, so sequences are identical on
// every engine and the state fits in a savestate as a plain number.
import { dcos, dlog, TWO_PI } from './mathd.js';

export class Rng {
    constructor(seed = 1) {
        this.state = seed >>> 0;
    }

    /** Uniform float in [0, 1). */
    next() {
        let t = (this.state = (this.state + 0x6D2B79F5) >>> 0);
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }

    /** Uniform 32-bit unsigned integer. */
    nextU32() {
        return Math.floor(this.next() * 4294967296) >>> 0;
    }

    /** Uniform float in [a, b). */
    range(a, b) {
        return a + (b - a) * this.next();
    }

    /** Uniform integer in [0, n). */
    int(n) {
        return Math.floor(this.next() * n);
    }

    pick(arr) {
        return arr[this.int(arr.length)];
    }

    /** True with probability p. */
    chance(p) {
        return this.next() < p;
    }

    /** Standard normal sample (Box-Muller on deterministic math). */
    normal(mean = 0, std = 1) {
        let u = this.next();
        if (u < 1e-300) u = 1e-300;
        const v = this.next();
        return mean + std * Math.sqrt(-2 * dlog(u)) * dcos(TWO_PI * v);
    }

    /** In-place Fisher-Yates shuffle. */
    shuffle(arr) {
        for (let i = arr.length - 1; i > 0; i--) {
            const j = this.int(i + 1);
            const t = arr[i];
            arr[i] = arr[j];
            arr[j] = t;
        }
        return arr;
    }

    /** Independent generator derived from this one (consumes one draw). */
    fork() {
        return new Rng(this.nextU32() ^ 0x9E3779B9);
    }

    getState() {
        return this.state;
    }

    setState(s) {
        this.state = s >>> 0;
    }
}

/** 32-bit FNV-1a of a string, handy for turning names into seeds. */
export function hashSeed(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}
