#!/usr/bin/env node
// computer-bench.cjs: scripted host desktop tasks against a fixed fixture app
// (test/computer-bench-app.swift), driven through the same service the app
// serves on /v1/computer. Per task it records tool calls (model round trips),
// tool latency, bytes and approximate tokens returned to the model, stale_ref
// retries, and success. macOS only.
//
// Usage: node scripts/computer-bench.cjs [--root DIR] [--mode mcp,batch,plugin]
//        [--think MS] [--runs N] [--json FILE]
// --root loads src/computer.cjs from another checkout, to bench a baseline.
// --think is the pause between reading a reply and acting on it, standing in
// for model latency (default 600ms; the fixture clock ticks every 250ms).
// Tokens are estimates: text is chars/4, an image is width*height/750.
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function arg(name, fallback) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback; }
const root = path.resolve(arg('--root', path.join(__dirname, '..')));
const modes = arg('--mode', 'mcp,batch,plugin').split(',');
const think = Number(arg('--think', 600));
const runs = Number(arg('--runs', 1));
const jsonOut = arg('--json');
if (process.platform !== 'darwin') { console.error('computer-bench runs on macOS only.'); process.exit(1); }

const { service, close } = require(path.join(root, 'src', 'computer.cjs'));
// A checkout without the wait step still runs batches, just without waits.
const canWait = (() => { try { require(path.join(root, 'src', 'computer-helper.cjs')).normalizeStep({ action: 'wait', text: 'x' }); return true; } catch { return false; } })();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const BOT = 'bench';

// One counter per task: every service call is one tool call the model makes.
let stats;
const reset = () => { stats = { calls: 0, ms: 0, textChars: 0, imageTokens: 0, imageBytes: 0, stale: 0 }; };
async function call(fn, image = false) {
  stats.calls++;
  const t0 = Date.now();
  try {
    const out = await fn();
    stats.ms += Date.now() - t0;
    if (image) {
      stats.imageBytes += Math.round(out.image.length * 3 / 4);
      stats.imageTokens += Math.round(out.imageWidth * out.imageHeight / 750);
      const { image: _, ...rest } = out;
      stats.textChars += JSON.stringify(rest).length;
    } else stats.textChars += JSON.stringify(out).length;
    return out;
  } catch (error) {
    stats.ms += Date.now() - t0;
    stats.textChars += String(error.message).length;
    if (error.code === 'stale_ref' || /stale_ref/.test(error.message)) stats.stale++;
    throw error;
  }
}

// What the model holds after each reply: a full tree, a delta, or "unchanged".
function merge(tree, reply) {
  if (Array.isArray(reply.elements)) return { generation: reply.generation, elements: reply.elements };
  if (!tree) return tree;
  let elements = tree.elements;
  if (Array.isArray(reply.removed)) elements = elements.filter((e) => !reply.removed.includes(e.ref));
  if (Array.isArray(reply.changed)) {
    const byRef = new Map(reply.changed.map((e) => [e.ref, e]));
    elements = elements.map((e) => byRef.get(e.ref) || e);
    const known = new Set(elements.map((e) => e.ref));
    elements = elements.concat(reply.changed.filter((e) => !known.has(e.ref)));
  }
  return { generation: Number.isInteger(reply.generation) ? reply.generation : tree.generation, elements };
}
const find = (tree, test) => tree && tree.elements.find((e) => typeof test === 'string' ? e.name === test : test(e));
const has = (tree, name) => Boolean(find(tree, name));

let pid = 0;
const bundle = path.join(os.tmpdir(), 'alans-way-computer-bench.app');
const BUNDLE_ID = 'app.alans-way.computer-bench';

// A real .app opened with `open -g`, so macOS launches it in the background:
// a bare binary run from a shell can be activated and take the user's focus.
function buildApp() {
  const source = path.join(__dirname, '..', 'test', 'computer-bench-app.swift');
  const binary = path.join(bundle, 'Contents', 'MacOS', 'computer-bench');
  if (fs.existsSync(binary) && fs.statSync(binary).mtimeMs >= fs.statSync(source).mtimeMs) return;
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(path.join(bundle, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
<key>CFBundleExecutable</key><string>computer-bench</string><key>CFBundleName</key><string>Computer Bench</string>
<key>CFBundlePackageType</key><string>APPL</string></dict></plist>`);
  const built = spawnSync('swiftc', ['-O', '-o', binary, source], { encoding: 'utf8' });
  if (built.status !== 0) throw new Error(built.stderr);
}

function quit() {
  if (pid) { try { process.kill(pid); } catch { /* gone */ } }
  pid = 0;
}

async function launch() {
  buildApp();
  const t0 = Date.now();
  spawnSync('open', ['-g', '-n', bundle]);
  for (;;) {
    const app = (await service.apps()).find((a) => a.bundleId === BUNDLE_ID);
    if (app) {
      const tree = await service.snapshot(BOT, app.pid).catch(() => null);
      if (tree && tree.elements && tree.elements.length) { pid = app.pid; return Date.now() - t0; }
    }
    if (Date.now() - t0 > 15000) throw new Error('bench app did not appear');
    await sleep(50);
  }
}

// --- agent loops ---------------------------------------------------------
// A plan is a list of steps: {do: (tree) => action body} or {wait: (tree) => bool}.
// mcp: the model snapshots once, then acts one call at a time, reading the
//      state from each action reply. A stale_ref costs a snapshot and a retry.
// batch: one snapshot, then the whole plan in one batch call.
// plugin: the alans-way-computer provider. Captures are snapshot + screenshot;
//      action replies carry no state, so the model captures again to read the
//      result, and a ref action reuses the generation of the last capture.

async function snapshotTree(tree) {
  const reply = await call(() => service.snapshot(BOT, pid, tree ? { since: tree.generation } : {}));
  return reply.unchanged ? tree : merge(tree, reply);
}

async function act(tree, body) {
  await sleep(think);
  return call(() => service.action(BOT, pid, { ...body, generation: tree.generation }));
}

async function runMcp(plan, check) {
  let tree = await snapshotTree(null);
  for (const step of plan) {
    if (step.wait) continue; // the action reply already is the re-observation
    for (let attempt = 0; ; attempt++) {
      const body = step.do(tree);
      try { tree = merge(tree, await act(tree, body)); break; }
      catch (error) {
        if (attempt || !/stale_ref/.test(error.message)) throw error;
        tree = await snapshotTree(tree);
      }
    }
  }
  return check(tree);
}

async function runBatch(plan, check) {
  let tree = await snapshotTree(null);
  for (let attempt = 0; ; attempt++) {
    const steps = plan.map((step) => step.wait ? (canWait ? step.waitStep : null) : step.do(tree)).filter(Boolean);
    try {
      const reply = await act(tree, { action: 'batch', steps });
      const failed = (reply.results || []).find((r) => r.error);
      if (failed) throw Object.assign(new Error(failed.error), { code: failed.code });
      tree = merge(tree, reply);
      break;
    } catch (error) {
      if (attempt || !/stale_ref/.test(error.message)) throw error;
      tree = await snapshotTree(tree);
    }
  }
  return check(tree);
}

async function capture(tree) {
  const [next] = await Promise.all([snapshotTree(tree), call(() => service.screenshot(pid), true)]);
  return next;
}

async function runPlugin(plan, check) {
  let tree = await capture(null);
  for (const step of plan) {
    if (step.wait) continue;
    for (let attempt = 0; ; attempt++) {
      try { await act(tree, step.do(tree)); break; }
      catch (error) {
        if (attempt || !/stale_ref/.test(error.message)) throw error;
        tree = await capture(tree);
      }
    }
  }
  tree = await capture(tree);
  return check(tree);
}

// --- tasks ---------------------------------------------------------------
const ref = (name) => (tree) => {
  const hit = find(tree, typeof name === 'function' ? name : (e) => e.name === name || e.name.startsWith(`${name} `));
  if (!hit) throw new Error(`no element ${typeof name === 'function' ? '' : name} in the tree`);
  return hit.ref;
};
const press = (name) => ({ do: (tree) => ({ action: 'press', ref: ref(name)(tree) }) });
const waitFor = (text) => ({ wait: true, waitStep: { action: 'wait', text, timeout: 3000 } });
const field = (tree) => ref((e) => e.role === 'AXTextField' && e.name === 'Name')(tree);
const menuReset = { do: () => ({ action: 'menu', path: ['Bench', 'Reset'] }) };

const tasks = [
  { name: 'find + click x3', plan: [press('Increment'), press('Increment'), press('Increment'), waitFor('Count: 3')],
    check: (t) => has(t, 'Count: 3') },
  { name: 'type + submit + read', plan: [{ do: (t) => ({ action: 'type', ref: field(t), text: 'Ada' }) }, press('Submit'), waitFor('Result: Ada')],
    check: (t) => has(t, 'Result: Ada') },
  { name: 'switch window', plan: [press('Copy name'), waitFor('Copied: Ada')],
    check: (t) => Boolean(find(t, (e) => e.role === 'AXTextArea' && e.value === 'Copied: Ada')) },
  { name: 'read list + select', plan: [press((e) => e.role === 'AXRow' && /\bRow 3\b/.test(e.name))],
    check: (t) => has(t, 'Count: 3') && Boolean(find(t, (e) => /\bRow 3\b/.test(e.name))) },
  { name: 'scroll list', plan: [{ do: (t) => ({ action: 'scroll', ref: ref((e) => e.role === 'AXRow' || e.role === 'AXCell')(t), direction: 'down', amount: 2 }) }],
    check: (t) => Boolean(find(t, (e) => /\bRow ([2-9]\d)\b/.test(e.name))) },
  { name: 'menu reset', plan: [menuReset, waitFor('Count: 0')], check: (t) => has(t, 'Count: 0') && has(t, 'Result: none') },
  { name: 'click under live churn', setup: ['Start clock'], teardown: ['Stop clock'],
    plan: [press('Increment'), press('Increment'), waitFor('Count: 2')], check: (t) => has(t, 'Count: 2') },
];

async function pressOnce(name) {
  const tree = await service.snapshot(BOT, pid);
  const hit = tree.elements.find((e) => e.name === name);
  if (hit) await service.action(BOT, pid, { action: 'press', ref: hit.ref, generation: tree.generation });
}

async function main() {
  const rows = [];
  const runners = { mcp: runMcp, batch: runBatch, plugin: runPlugin };
  for (let run = 0; run < runs; run++) {
    for (const mode of modes) {
      if (pid) { quit(); await sleep(300); }
      reset();
      const launchMs = await launch();
      rows.push({ run, mode, task: 'open + first snapshot', ok: true, calls: 1, ms: launchMs, textTokens: 0, imageTokens: 0, imageBytes: 0, stale: 0 });
      for (const task of tasks) {
        for (const name of task.setup || []) await pressOnce(name);
        reset();
        let ok = false, err;
        try { ok = Boolean(await runners[mode](task.plan, task.check)); }
        catch (error) { err = String(error.message).slice(0, 140); }
        for (const name of task.teardown || []) await pressOnce(name).catch(() => {});
        rows.push({ run, mode, task: task.name, ok, err, calls: stats.calls, ms: stats.ms, textTokens: Math.round(stats.textChars / 4),
          imageTokens: stats.imageTokens, imageBytes: stats.imageBytes, stale: stats.stale });
      }
    }
  }
  quit();
  close();
  console.log(`\n  root: ${root}  think: ${think}ms  runs: ${runs}`);
  console.log('  mode    task                       ok    calls  stale   tool ms  text tok  img tok');
  console.log('  ' + '─'.repeat(86));
  for (const r of rows) {
    console.log(`  ${r.mode.padEnd(7)} ${r.task.padEnd(26)} ${(r.ok ? 'PASS' : 'FAIL').padEnd(5)} ${String(r.calls).padStart(5)} ${String(r.stale).padStart(6)} ${String(r.ms).padStart(9)} ${String(r.textTokens).padStart(9)} ${String(r.imageTokens).padStart(8)}${r.err ? '  ' + r.err : ''}`);
  }
  for (const mode of modes) {
    const mine = rows.filter((r) => r.mode === mode && r.task !== 'open + first snapshot');
    const sum = (key) => mine.reduce((total, r) => total + r[key], 0);
    console.log(`  ${mode.padEnd(7)} TOTAL ${String(mine.filter((r) => r.ok).length).padStart(2)}/${mine.length} pass  calls ${sum('calls')}  stale ${sum('stale')}  tool ${sum('ms')}ms  text ${sum('textTokens')} tok  image ${sum('imageTokens')} tok (${Math.round(sum('imageBytes') / 1024)} KB)`);
  }
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(rows, null, 2));
}

main().catch((error) => { quit(); close(); console.error('bench failed:', error.stack || error.message); process.exit(1); });
