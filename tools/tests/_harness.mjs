// Minimal test registry shared by tools/test.mjs and every tools/tests/*.test.mjs.
// A test file registers tests at import time:
//
//   import { test, approx } from './_harness.mjs';
//   test('adds', () => { assert.equal(1 + 1, 2); });
//
// Tests run sequentially in file order (files sorted by name); async tests are awaited.

const registry = [];
let currentFile = '';

export function test(name, fn) {
    registry.push({ file: currentFile, name, fn });
}

/** Asserts |a - b| <= eps. */
export function approx(a, b, eps = 1e-9, msg = '') {
    if (!(Math.abs(a - b) <= eps)) {
        throw new Error(`${msg ? msg + ': ' : ''}expected ${b} ± ${eps}, got ${a} (diff ${Math.abs(a - b)})`);
    }
}

/** Prints an informational line under the current test (benchmarks, sizes). */
export function info(...args) {
    console.log('      ' + args.join(' '));
}

export function _setFile(name) {
    currentFile = name;
}

export function _tests() {
    return registry;
}
