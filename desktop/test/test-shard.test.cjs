const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { shards, unitFiles } = require('../scripts/test-shard.cjs');

const testDir = __dirname;
const weights = JSON.parse(fs.readFileSync(path.join(testDir, 'shard-weights.json'), 'utf8'));

test('every unit test file runs in exactly one shard for any shard count', () => {
  const files = unitFiles(testDir);
  for (let total = 1; total <= 8; total++) {
    const all = shards(files, weights, total).flat().sort();
    assert.deepEqual(all, files, `${total} shards`);
  }
});

test('shards are balanced by recorded time: none carries more than its fair share plus the heaviest file', () => {
  const files = unitFiles(testDir);
  const sum = files.reduce((acc, f) => acc + (weights[f] ?? 1), 0);
  const heaviest = Math.max(...files.map((f) => weights[f] ?? 1));
  for (const bin of shards(files, weights, 3)) {
    const load = bin.reduce((acc, f) => acc + (weights[f] ?? 1), 0);
    assert.ok(load <= sum / 3 + heaviest, `${load}s vs fair ${sum / 3}s`);
  }
});

test('a file with no recorded time is still assigned, and the split is deterministic', () => {
  const files = [...unitFiles(testDir), 'brand-new.test.cjs'];
  const first = shards(files, weights, 3);
  assert.deepEqual(first, shards(files, weights, 3));
  assert.equal(first.flat().filter((f) => f === 'brand-new.test.cjs').length, 1);
});

test('weights name only files that exist, so a deleted test is noticed', () => {
  const files = new Set(unitFiles(testDir));
  assert.deepEqual(Object.keys(weights).filter((f) => !files.has(f)), []);
});
