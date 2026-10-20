#!/usr/bin/env node
// Runs every tools/tests/*.test.mjs (zero dependencies, node:assert style).
// Usage: node tools/test.mjs [filter]   — filter matches "file > test name".
// Add a test group by dropping a new <name>.test.mjs into tools/tests/.
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { _setFile, _tests } from './tests/_harness.mjs';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tests');
const filter = (process.argv[2] || '').toLowerCase();
const files = readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).sort();

for (const f of files) {
    _setFile(f.replace(/\.test\.mjs$/, ''));
    await import(pathToFileURL(path.join(dir, f)).href);
}

const tests = _tests().filter((t) => !filter || `${t.file} > ${t.name}`.toLowerCase().includes(filter));
let passed = 0;
const failed = [];
const t0 = performance.now();
let lastFile = null;
for (const t of tests) {
    if (t.file !== lastFile) {
        console.log(`\n${t.file}`);
        lastFile = t.file;
    }
    const start = performance.now();
    try {
        await t.fn();
        passed++;
        console.log(`  ok   ${t.name} (${(performance.now() - start).toFixed(0)} ms)`);
    } catch (e) {
        failed.push({ t, e });
        console.log(`  FAIL ${t.name}\n       ${String(e && e.stack || e).split('\n').slice(0, 6).join('\n       ')}`);
    }
}
const secs = ((performance.now() - t0) / 1000).toFixed(1);
console.log(`\n${passed} passed, ${failed.length} failed (${tests.length} tests, ${secs} s)`);
if (failed.length) {
    for (const { t } of failed) console.log(`  - ${t.file} > ${t.name}`);
    process.exitCode = 1;
}
