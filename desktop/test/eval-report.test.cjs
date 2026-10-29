const test = require('node:test');
const assert = require('node:assert/strict');
const { summarize, toMarkdown, pct } = require('../eval/report.cjs');

const row = (o) => ({ tier: 'fixture', mode: 'hermes', label: 'hermes-remote', driver: 'remote', ok: true, overBudget: false, wallMs: 1000, toolCalls: 4, respBytes: 2048, ...o });

test('nearest-rank percentile', () => {
  assert.equal(pct([], 50), null);
  assert.equal(pct([3, 1, 2], 50), 2);
  assert.equal(pct([1, 2, 3, 4], 50), 2);
  assert.equal(pct([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9);
});

test('per-arm stats count failures in cost per solved task and keep skipped rows out', () => {
  const s = summarize([{ meta: {}, rows: [
    row({ id: 'a', tokens: 1000, costUsd: 0.01 }),
    row({ id: 'a', ok: false, tokens: 3000, costUsd: 0.03 }),
    row({ id: 'b', wallMs: 3000, overBudget: true, tokens: 2000, costUsd: 0.02 }),
    { id: 'dk', tier: 'desktop', mode: 'hermes', label: 'hermes-remote', skipped: 'needs a Mac' },
  ] }]);
  const all = s.arms[0].tiers.all;
  assert.deepEqual([all.runs, all.skipped, all.pass, all.strict], [3, 1, 2, 1]);
  assert.equal(all.tokensPerSolved, 3000);
  assert.ok(Math.abs(all.costPerSolvedUsd - 0.03) < 1e-9);
  assert.equal(all.wallP50Ms, 1000);
  assert.equal(s.arms[0].tiers.desktop.runs, 0);
  assert.match(toMarkdown(s), /\| hermes-remote \| remote \| desktop \| not run \(1 skipped\)/);
});

test('says when runs lack usage and when one label mixes modes', () => {
  const s = summarize([{ meta: {}, rows: [row({ id: 'a', tokens: 1000 }), row({ id: 'b', ok: false, crashed: true }), row({ id: 'c', mode: 'codex', tokens: 10 })] }]);
  assert.equal(s.arms[0].tiers.all.usageMissing, 1);
  assert.deepEqual(s.validity.mixedLabels, ['hermes-remote']);
  const md = toMarkdown(s);
  assert.match(md, /505 \(1 runs without usage\)/);
  assert.match(md, /WARNING: hermes-remote mixes several modes/);
});

test('comparison uses only tasks both arms solved, on medians of passing runs', () => {
  const s = summarize([
    { meta: { label: 'codex-local' }, rows: [row({ id: 'a', mode: 'codex', label: undefined, wallMs: 4000, tokens: 800 }), row({ id: 'b', mode: 'codex', label: undefined, ok: false, wallMs: 9000 })] },
    { meta: {}, rows: [row({ id: 'a', wallMs: 2000, tokens: 400 }), row({ id: 'a', wallMs: 90000, ok: false, tokens: 9000 }), row({ id: 'b', wallMs: 1000 })] },
  ]);
  assert.equal(s.arms[0].label, 'codex-local');
  const [c] = s.comparisons;
  assert.deepEqual([c.arm, c.baseline, c.commonTasks, c.wallSumMs, c.baselineWallSumMs, c.wallRatio, c.tokensRatio], ['hermes-remote', 'codex-local', 1, 2000, 4000, 0.5, 0.5]);
  const md = toMarkdown(s);
  assert.match(md, /\| hermes-remote \| codex-local \| 1 \| 2\.0 s \| 4\.0 s \| 0\.50 \| 0\.50 \|/);
  assert.match(md, /\| b \| fixture \| 0\/1, 9\.0 s, 4\.0 calls \| 1\/1, 1\.0 s, 4\.0 calls \|/);
});

test('flags a null arm that passes a check, and leaves absent metrics as n/a', () => {
  const s = summarize([{ meta: {}, rows: [row({ id: 'a', mode: 'null', label: 'null-local', respBytes: undefined })] }]);
  assert.deepEqual(s.validity.nullArmPasses, ['a']);
  assert.equal(s.comparisons.length, 0);
  const md = toMarkdown(s);
  assert.match(md, /WARNING: the null arm passed a/);
  assert.match(md, /\| null-local \| remote \| all \| 1\/1 \| 1\/1 \| 1\.0 s \| 1\.0 s \| 4\.0 \| n\/a \| n\/a \| n\/a \| n\/a \|/);
});
