'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { shouldCompact, CACHE_TTL_MS, HIGH_FRACTION, STALE_MIN_TOKENS, STALE_MIN_FRACTION } = require('../src/compact-policy.cjs');

const WINDOW = 200000, MIN = 60 * 1000;

test('the four numbers are the documented defaults', () => {
  assert.deepEqual([HIGH_FRACTION, CACHE_TTL_MS, STALE_MIN_TOKENS, STALE_MIN_FRACTION], [0.75, 5 * MIN, 40000, 0.25]);
});

test('high: at or past 75% of the window compacts even with a warm cache', () => {
  assert.equal(shouldCompact({ usedTokens: 150000, windowTokens: WINDOW, idleMs: 0 }), 'high');
  assert.equal(shouldCompact({ usedTokens: 149999, windowTokens: WINDOW, idleMs: 0 }), null);
  assert.equal(shouldCompact({ usedTokens: 190000, windowTokens: WINDOW, idleMs: 1000 }), 'high');
});

test('stale: idle past the cache lifetime with a big enough context', () => {
  assert.equal(shouldCompact({ usedTokens: 40000, windowTokens: WINDOW, idleMs: 5 * MIN + 1 }), 'stale');
  assert.equal(shouldCompact({ usedTokens: 40000, windowTokens: WINDOW, idleMs: 5 * MIN }), null, 'exactly the lifetime is still warm');
  assert.equal(shouldCompact({ usedTokens: 39999, windowTokens: WINDOW, idleMs: 60 * MIN }), null, 'a small context is not worth a summary');
});

test('stale: the size floor is the smaller of 40,000 tokens and 25% of the window', () => {
  assert.equal(shouldCompact({ usedTokens: 25000, windowTokens: 100000, idleMs: 6 * MIN }), 'stale', '25% of a 100k window');
  assert.equal(shouldCompact({ usedTokens: 24999, windowTokens: 100000, idleMs: 6 * MIN }), null);
  assert.equal(shouldCompact({ usedTokens: 40000, windowTokens: 1000000, idleMs: 6 * MIN }), 'stale', '40k beats 25% of a 1M window');
  assert.equal(shouldCompact({ usedTokens: 39999, windowTokens: 1000000, idleMs: 6 * MIN }), null);
});

test('a warm cache below the limit never compacts', () => {
  assert.equal(shouldCompact({ usedTokens: 100000, windowTokens: WINDOW, idleMs: 4 * MIN }), null);
});

test('high wins over stale when both apply', () => {
  assert.equal(shouldCompact({ usedTokens: 180000, windowTokens: WINDOW, idleMs: 30 * MIN }), 'high');
});

test('a reported cache lifetime replaces the 5 minute default', () => {
  const base = { usedTokens: 60000, windowTokens: WINDOW };
  assert.equal(shouldCompact({ ...base, idleMs: 30 * MIN, cacheTtlMs: 60 * MIN }), null);
  assert.equal(shouldCompact({ ...base, idleMs: 61 * MIN, cacheTtlMs: 60 * MIN }), 'stale');
  assert.equal(shouldCompact({ ...base, idleMs: 6 * MIN, cacheTtlMs: 0 }), 'stale', 'a bad lifetime falls back to the default');
});

test('unknown usage, window or idle time never triggers', () => {
  for (const bad of [undefined, null, NaN, 0, -5, '90000', Infinity]) {
    assert.equal(shouldCompact({ usedTokens: bad, windowTokens: WINDOW, idleMs: 60 * MIN }), null, `used ${String(bad)}`);
    assert.equal(shouldCompact({ usedTokens: 190000, windowTokens: bad, idleMs: 60 * MIN }), null, `window ${String(bad)}`);
  }
  assert.equal(shouldCompact({ usedTokens: 60000, windowTokens: WINDOW }), null, 'no idle time: stale cannot fire');
  assert.equal(shouldCompact({ usedTokens: 60000, windowTokens: WINDOW, idleMs: NaN }), null);
  assert.equal(shouldCompact({ usedTokens: 160000, windowTokens: WINDOW }), 'high', 'high needs no idle time');
  assert.equal(shouldCompact(), null);
});
