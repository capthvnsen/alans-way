#!/usr/bin/env node
// Summarizes eval runs (each a run.cjs --out dir: results.jsonl + meta.json) into
// results.json and results.md. See docs/benchmarks/computer-use.md.
//   node eval/report.cjs --out DIR RUN_DIR [RUN_DIR...] [--baseline LABEL]
// --baseline defaults to the first arm whose label starts with "codex"; comparisons need one.
const fs = require('node:fs');
const path = require('node:path');

// Nearest-rank percentile.
const pct = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.max(0, Math.ceil(p / 100 * s.length) - 1)]; };
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const mean = (xs) => xs.length ? sum(xs) / xs.length : null;
const nums = (rows, k) => rows.map((r) => r[k]).filter((v) => typeof v === 'number');

function load(dir) {
  const rows = fs.readFileSync(path.join(dir, 'results.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  let meta = {}; try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')); } catch {}
  return { meta, rows };
}

function stats(rows) {
  const ran = rows.filter((r) => !r.skipped), pass = ran.filter((r) => r.ok);
  const tokens = nums(ran, 'tokens'), cost = nums(ran, 'costUsd');
  return {
    runs: ran.length, skipped: rows.length - ran.length, pass: pass.length, strict: pass.filter((r) => !r.overBudget).length,
    successRate: ran.length ? pass.length / ran.length : null,
    wallP50Ms: pct(nums(ran, 'wallMs'), 50), wallP90Ms: pct(nums(ran, 'wallMs'), 90),
    toolCallsMean: mean(nums(ran, 'toolCalls')), respBytesMean: mean(nums(ran, 'respBytes')), turnsMean: mean(nums(ran, 'agentTurns')),
    // All tokens/cost spent, failed runs included, per task actually solved.
    tokensPerSolved: tokens.length && pass.length ? sum(tokens) / pass.length : null,
    costPerSolvedUsd: cost.length && pass.length ? sum(cost) / pass.length : null,
  };
}

// Sum of per-task medians over passing runs, on tasks both arms solved at least once.
function compare(tasks, arm, base) {
  const solved = (rows) => rows && rows.some((r) => r.ok);
  const common = Object.keys(tasks[arm]).filter((id) => solved(tasks[arm][id]) && solved(tasks[base][id]));
  const total = (label, k) => { const m = common.map((id) => pct(nums(tasks[label][id].filter((r) => r.ok), k), 50)); return m.length && m.every((v) => v != null) ? sum(m) : null; };
  const ratio = (a, b) => a != null && b ? a / b : null;
  const out = { arm, baseline: base, commonTasks: common.length, wallSumMs: total(arm, 'wallMs'), baselineWallSumMs: total(base, 'wallMs'), tokensSum: total(arm, 'tokens'), baselineTokensSum: total(base, 'tokens') };
  return { ...out, wallRatio: ratio(out.wallSumMs, out.baselineWallSumMs), tokensRatio: ratio(out.tokensSum, out.baselineTokensSum) };
}

function summarize(runs, baseline) {
  const all = runs.flatMap(({ meta, rows }) => rows.map((r) => ({ ...r, label: r.label || meta.label || r.mode, driver: r.driver || meta.driver || null })));
  const labels = [...new Set(all.map((r) => r.label))];
  const tasks = {}, arms = [];
  for (const label of labels) {
    const rows = all.filter((r) => r.label === label);
    tasks[label] = {};
    for (const r of rows) (tasks[label][r.id] ||= []).push(r);
    const tiers = { all: stats(rows) };
    for (const tier of [...new Set(rows.map((r) => r.tier))]) tiers[tier] = stats(rows.filter((r) => r.tier === tier));
    arms.push({ label, mode: rows[0].mode, driver: rows[0].driver, tiers });
  }
  const base = baseline || labels.find((l) => /^codex/.test(l));
  const comparisons = base && tasks[base] ? labels.filter((l) => l !== base).map((l) => compare(tasks, l, base)) : [];
  // A negative-control arm that passes anything means a check is vacuous.
  const vacuous = all.filter((r) => r.mode === 'null' && r.ok).map((r) => r.id);
  return {
    generatedAt: new Date().toISOString(), runs: runs.map((r) => r.meta), arms, comparisons, validity: { nullArmPasses: vacuous },
    tasks: Object.fromEntries(labels.map((l) => [l, Object.fromEntries(Object.entries(tasks[l]).map(([id, rows]) => [id, { tier: rows[0].tier, ...stats(rows) }]))])),
  };
}

const sec = (ms) => ms == null ? 'n/a' : `${(ms / 1000).toFixed(1)} s`;
const num = (v, d = 1) => v == null ? 'n/a' : v.toFixed(d);
function toMarkdown(s) {
  const out = ['| Arm | Driver | Tier | Success | Strict | Wall p50 | Wall p90 | Tool calls | Obs KB | Turns | Tokens/solved | $/solved |', '|---|---|---|---|---|---|---|---|---|---|---|---|'];
  for (const a of s.arms) for (const [tier, t] of Object.entries(a.tiers)) {
    if (!t.runs) { out.push(`| ${a.label} | ${a.driver || 'n/a'} | ${tier} | not run (${t.skipped} skipped) | | | | | | | | |`); continue; }
    out.push(`| ${a.label} | ${a.driver || 'n/a'} | ${tier} | ${t.pass}/${t.runs} | ${t.strict}/${t.runs} | ${sec(t.wallP50Ms)} | ${sec(t.wallP90Ms)} | ${num(t.toolCallsMean)} | ${t.respBytesMean == null ? 'n/a' : num(t.respBytesMean / 1024)} | ${num(t.turnsMean)} | ${t.tokensPerSolved == null ? 'n/a' : Math.round(t.tokensPerSolved)} | ${t.costPerSolvedUsd == null ? 'n/a' : '$' + t.costPerSolvedUsd.toFixed(3)} |`);
  }
  const labels = s.arms.map((a) => a.label);
  const ids = [...new Set(labels.flatMap((l) => Object.keys(s.tasks[l])))];
  out.push('', `| Task | Tier | ${labels.join(' | ')} |`, `|---|---|${labels.map(() => '---|').join('')}`);
  for (const id of ids) {
    const tier = labels.map((l) => s.tasks[l][id]?.tier).find(Boolean);
    out.push(`| ${id} | ${tier} | ${labels.map((l) => { const t = s.tasks[l][id]; return !t || !t.runs ? 'not run' : `${t.pass}/${t.runs}, ${sec(t.wallP50Ms)}, ${num(t.toolCallsMean)} calls`; }).join(' | ')} |`);
  }
  if (s.comparisons.length) {
    out.push('', '| Arm | Baseline | Tasks both solved | Sum of median wall | Baseline | Wall ratio | Tokens ratio |', '|---|---|---|---|---|---|---|');
    for (const c of s.comparisons) out.push(`| ${c.arm} | ${c.baseline} | ${c.commonTasks} | ${sec(c.wallSumMs)} | ${sec(c.baselineWallSumMs)} | ${num(c.wallRatio, 2)} | ${num(c.tokensRatio, 2)} |`);
  }
  if (s.validity.nullArmPasses.length) out.push('', `WARNING: the null arm passed ${s.validity.nullArmPasses.join(', ')}; those checks are vacuous.`);
  return out.join('\n') + '\n';
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const opt = (n) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv.splice(i, 2)[1] : undefined; };
  const outDir = opt('out'), baseline = opt('baseline');
  if (!outDir || !argv.length) { console.error('usage: node eval/report.cjs --out DIR RUN_DIR [RUN_DIR...] [--baseline LABEL]'); process.exit(2); }
  const s = summarize(argv.map(load), baseline);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(s, null, 2) + '\n');
  const md = toMarkdown(s);
  fs.writeFileSync(path.join(outDir, 'results.md'), md);
  process.stdout.write(md + `\nwrote ${path.join(outDir, 'results.json')} and results.md\n`);
}
module.exports = { summarize, toMarkdown, pct };
