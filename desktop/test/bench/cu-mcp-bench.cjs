#!/usr/bin/env node
// cu-mcp-bench.cjs: Alan's CU MCP speed benchmark. Ten fixed tasks, six in the
// browser and four in a Mac app, all driven through the shipped MCP server
// (scripts/browser-mcp.cjs) over stdio, the way a model drives it. Every tool
// call is logged with its latency, reply bytes and error, so a run shows per
// task: success, round trips, tool time and bytes, and per tool: p50/p95.
//
// Browser: headless Chrome + scripts/vps-browser-host.cjs from --root, with the
//   fixtures and emulated agent loop of scripts/browser-bench.cjs.
// Mac: test/computer-bench-app.swift, opened in the background, driven through
//   a host that serves computer use. Accessibility belongs to the app, not this
//   terminal, so pass one of:
//     --mac-app /Applications/alans-way-localapp.app   runs the checkout's computer code under that app's grant
//     --computer-connection FILE                       a running app's own (bundled) computer code
//   Without either the Mac tasks are reported as skipped.
//
// Usage: node test/bench/cu-mcp-bench.cjs [--mac-app APP | --computer-connection FILE]
//        [--runs N] [--root DIR] [--json FILE]
// --root benches another checkout's MCP server and VM host (a baseline).
// Docs and recorded numbers: docs/cu-mcp-benchmarks.md.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback; };
// Tool time is what is measured; model think time is not part of this bench.
if (!process.argv.includes('--think')) process.argv.push('--think', '0');
const bench = require('../../scripts/browser-bench.cjs');
const root = path.resolve(arg('--root', path.join(__dirname, '..', '..')));
const runs = Number(arg('--runs', 3));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms, what) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) { const v = await fn(); if (v) return v; } throw new Error('timed out waiting for ' + what); };

const BROWSER_TASKS = ['search-open', 'form-multifield', 'cookie-modal', 'popup-tab', 'confirm-dialog', 'spa-rerender'];

// Every MCP call, tagged with the task running at the time.
const calls = [];
let current = null;
function recorded(client) {
  return {
    listTools: (...a) => client.listTools(...a),
    async callTool(req, ...rest) {
      const t0 = performance.now();
      let r, thrown;
      try { r = await client.callTool(req, ...rest); } catch (e) { thrown = e; }
      const ms = performance.now() - t0;
      let bytes = 0, text = '';
      for (const c of r?.content || []) {
        if (c.type === 'text') { text += c.text; bytes += Buffer.byteLength(c.text); }
        else if (c.type === 'image') bytes += Buffer.from(c.data, 'base64').length;
      }
      let data; try { data = JSON.parse(text); } catch { data = null; }
      const failed = thrown || r?.isError ? String(thrown?.message || text) : Array.isArray(data?.results) ? data.results.find((x) => x && !x.ok && x.error)?.error : undefined;
      calls.push({ ...current, tool: req.name.replace(/^(cua_alans_way_|workspace_computer_)/, ''), action: req.arguments?.action, ms: Math.round(ms), bytes, error: failed ? String(failed).slice(0, 200) : undefined });
      if (thrown) throw thrown;
      return r;
    },
  };
}
const parse = (r) => { const t = (r.content || []).filter((c) => c.type === 'text').map((c) => c.text).join(''); try { return JSON.parse(t); } catch { return { error: t }; } };

// ---------------------------------------------------------------- Mac host
// --mac-app re-runs this bench under the app's Electron as Node, launched by
// open: LaunchServices makes the app the responsible process, so its
// Accessibility grant covers the helper, and the checkout's computer code runs
// in-process in browser-mcp.cjs (the local driver), not the app's bundled copy.
function reexecUnderApp(app) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-mcp-bench-'));
  const out = path.join(dir, 'out.txt');
  const rest = process.argv.slice(2).filter((x, i, a) => x !== '--mac-app' && a[i - 1] !== '--mac-app');
  // If the app ignores ELECTRON_RUN_AS_NODE and starts its window, it uses a throwaway profile, not the person's connection.json.
  spawnSync('open', ['-W', '-n', '-g', '--env', 'ELECTRON_RUN_AS_NODE=1', '--env', 'CU_MCP_BENCH_IN_APP=1', '--env', `HERMES_WORKSPACE_DATA=${path.join(dir, 'profile')}`, '--stdout', out, '--stderr', out, app, '--args', __filename, ...rest]);
  const text = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : 'no output from the app run';
  fs.rmSync(dir, { recursive: true, force: true });
  process.stdout.write(text.split('\n').filter((l) => !/codesign_util|Legacy broker credential/.test(l)).join('\n'));
  process.exit(/^\| \*\*Total\*\* .*\*\*(\d+)\/\1\*\*/m.test(text) ? 0 : 1);
}

const BUNDLE = path.join(os.tmpdir(), 'alans-way-computer-bench.app');
const BUNDLE_ID = 'app.alans-way.computer-bench';
function buildFixtureApp() {
  const source = path.join(__dirname, '..', 'computer-bench-app.swift');
  const binary = path.join(BUNDLE, 'Contents', 'MacOS', 'computer-bench');
  if (fs.existsSync(binary) && fs.statSync(binary).mtimeMs >= fs.statSync(source).mtimeMs) return;
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(path.join(BUNDLE, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
<key>CFBundleExecutable</key><string>computer-bench</string><key>CFBundleName</key><string>Computer Bench</string>
<key>CFBundlePackageType</key><string>APPL</string></dict></plist>`);
  const built = spawnSync('swiftc', ['-O', '-o', binary, source], { encoding: 'utf8' });
  if (built.status !== 0) throw new Error(built.stderr);
}

// What the model holds after each reply: a full tree, patched by deltas.
function merge(tree, reply) {
  if (!reply || reply.error) return tree;
  if (Array.isArray(reply.elements)) return reply;
  if (!tree) return tree;
  let elements = tree.elements;
  if (Array.isArray(reply.removed)) elements = elements.filter((e) => !reply.removed.includes(e.ref));
  if (Array.isArray(reply.changed)) {
    const byRef = new Map(reply.changed.map((e) => [e.ref, e]));
    elements = elements.map((e) => byRef.get(e.ref) || e);
    const known = new Set(elements.map((e) => e.ref));
    elements = elements.concat(reply.changed.filter((e) => !known.has(e.ref)));
  }
  return { ...tree, generation: Number.isInteger(reply.generation) ? reply.generation : tree.generation, elements };
}
const shows = (tree, text) => !!tree?.elements?.some((e) => (e.name || '').includes(text) || String(e.value ?? '').includes(text));
const refOf = (tree, test) => { const hit = tree?.elements?.find(test); if (!hit) throw new Error('no such control in the tree'); return hit.ref; };
const named = (name) => (e) => e.name === name || (e.name || '').startsWith(name + ' ');

// A model acts on what it holds, reads the result from the reply, and only
// snapshots again when the reply does not carry enough state to tell.
class MacAgent {
  constructor(client, pid, windowId) { Object.assign(this, { client, pid, windowId, tree: null }); }
  async snapshot() {
    const r = parse(await this.client.callTool({ name: 'workspace_computer_snapshot', arguments: { pid: this.pid, windowId: this.windowId, ...(this.tree ? { since: this.tree.generation, delta: true } : {}) } }));
    if (r.error) throw new Error(r.error);
    if (!r.unchanged) this.tree = merge(this.tree, r);
    return this.tree;
  }
  async act(body) {
    const r = parse(await this.client.callTool({ name: 'workspace_computer_action', arguments: { pid: this.pid, windowId: this.windowId, generation: this.tree?.generation, ...body } }));
    if (r.error) throw new Error(r.error);
    const failed = (r.results || []).find((x) => x && !x.ok);
    if (failed) throw new Error(failed.error || 'step failed');
    this.tree = merge(this.tree, r);
    return r;
  }
  async confirm(text) { return shows(this.tree, text) || shows(await this.snapshot(), text); }
}

const MAC_TASKS = [
  { id: 'mac-press-x3', what: 'press Increment three times and confirm the count',
    async run(a) { await a.snapshot(); const ref = refOf(a.tree, named('Increment'));
      await a.act({ action: 'batch', steps: [{ action: 'press', ref }, { action: 'press', ref }, { action: 'press', ref }, { action: 'wait', text: 'Count: 3', timeout: 3000 }] });
      return a.confirm('Count: 3'); } },
  { id: 'mac-type-submit', what: 'type a name, submit, read the result',
    async run(a) { await a.snapshot();
      await a.act({ action: 'batch', steps: [{ action: 'type', ref: refOf(a.tree, (e) => e.role === 'AXTextField' && e.name === 'Name'), text: 'Ada' },
        { action: 'press', ref: refOf(a.tree, named('Submit')) }, { action: 'wait', text: 'Result: Ada', timeout: 3000 }] });
      return a.confirm('Result: Ada'); } },
  { id: 'mac-other-window', what: 'in the second window, copy the name and read it back', window: 'notes',
    async run(a) { await a.snapshot();
      await a.act({ action: 'batch', steps: [{ action: 'press', ref: refOf(a.tree, named('Copy name')) }, { action: 'wait', text: 'Copied: Ada', timeout: 3000 }] });
      return a.confirm('Copied: Ada'); } },
  // Not a menu task: menus need the app frontmost, which would take focus from whoever uses the Mac.
  { id: 'mac-scroll-list', what: 'scroll a long list until rows past 10 are on screen',
    async run(a) { await a.snapshot();
      await a.act({ action: 'scroll', ref: refOf(a.tree, (e) => e.role === 'AXRow' || e.role === 'AXCell'), direction: 'down', amount: 2 });
      return a.tree.elements.some((e) => /\bRow (1\d|[2-9]\d)\b/.test(e.name || '')) || (await a.snapshot()).elements.some((e) => /\bRow (1\d|[2-9]\d)\b/.test(e.name || '')); } },
];

async function runMac(connFile, run) {
  const client = await bench.connectMcp(connFile);
  buildFixtureApp();
  const ids = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cu-mcp-bench-')), 'windows.json');
  // --visible: hosts without Screen Recording only enumerate on-screen windows. The panels never take focus.
  spawnSync('open', ['-g', '-n', BUNDLE, '--args', '--window-ids', ids, '--visible']);
  let pid;
  try {
    const app = await until(async () => (parse(await client.callTool({ name: 'workspace_computer_apps', arguments: {} })).apps || []).find((x) => x.bundleId === BUNDLE_ID), 15000, 'bench app');
    pid = app.pid;
    const windows = await until(() => { try { return JSON.parse(fs.readFileSync(ids, 'utf8')); } catch { return null; } }, 10000, 'window ids');
    const tracked = recorded(client);
    for (const task of MAC_TASKS) {
      current = { task: task.id, kind: 'mac', run };
      const t0 = performance.now();
      let ok = false, err;
      try { ok = !!(await task.run(new MacAgent(tracked, pid, windows[task.window || 'form']))); } catch (e) { err = e.message; }
      results.push({ task: task.id, kind: 'mac', run, ok, wallMs: Math.round(performance.now() - t0), err: err?.slice(0, 200) });
      log(results.at(-1));
    }
  } finally {
    if (pid) { try { process.kill(pid); } catch { /* gone */ } }
    await client.close().catch(() => {});
    fs.rmSync(path.dirname(ids), { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- browser
async function runBrowser(run, mac) {
  const eng = await bench.startEngine('vm');
  const fixtures = await bench.startFixtures(eng.bind);
  const fx = fixtures.state;
  fx.main = eng.main(fx.port); fx.widget = eng.widget(fx.port);
  fx.pages = bench.pages(fx);
  fx.url = (p) => fx.main + p;
  const conn = JSON.parse(fs.readFileSync(eng.connFile, 'utf8'));
  const raw = (route, method = 'GET', epoch) => fetch(conn.url + route, { method, headers: { Authorization: `Bearer ${conn.token}`, 'X-Hermes-Bot': 'bench', ...(epoch != null ? { 'X-Control-Epoch': String(epoch) } : {}) } }).then((r) => r.json().catch(() => ({})));
  const closeAll = async () => { const t = await raw('/v1/tabs'); for (const x of Array.isArray(t) ? t : t.tabs || []) await raw(`/v1/tabs/${x.id}`, 'DELETE', x.epoch).catch(() => {}); };
  const client = await bench.connectMcp(eng.connFile);
  try {
    const tools = (await client.listTools()).tools;
    const props = tools.find((t) => t.name === 'cua_alans_way_action')?.inputSchema?.properties || {};
    const openSnapshot = !!tools.find((t) => t.name === 'cua_alans_way_open')?.inputSchema?.properties?.snapshot;
    const tracked = recorded(client);
    for (const id of BROWSER_TASKS) {
      const task = bench.tasks.find((t) => t.id === id);
      fixtures.reset(); await closeAll();
      current = { task: id, kind: 'browser', run };
      const a = new bench.Agent(tracked, { generation: !!props.generation, names: !!props.name, listRead: !!props.list, openSnapshot, fixtureApproval: new URL(fx.main).origin });
      const t0 = performance.now();
      let ans = '', err;
      try { ans = String(await task.run(a, fx) || ''); } catch (e) { err = e.message; }
      const wallMs = Math.round(performance.now() - t0);
      await sleep(300);
      const ok = !err && !!(await task.check(fx, ans));
      results.push({ task: id, kind: 'browser', run, ok, wallMs, err: (err || (ok ? undefined : ans))?.slice(0, 200) });
      log(results.at(-1));
    }
    // 'vm': the Mac tasks reach the checkout's computer code through this VM host's MCP server (no computer capability there).
    if (mac) await runMac(mac === 'vm' ? eng.connFile : mac, run);
  } finally {
    await closeAll().catch(() => {});
    await client.close().catch(() => {});
    fixtures.close(); await eng.stop();
  }
}

// ---------------------------------------------------------------- report
const results = [];
function log(r) {
  const mine = calls.filter((c) => c.task === r.task && c.run === r.run);
  console.log(`${r.kind.padEnd(7)} ${r.task.padEnd(17)} ${r.ok ? 'PASS' : 'FAIL'} calls=${mine.length} toolMs=${mine.reduce((s, c) => s + c.ms, 0)} bytes=${mine.reduce((s, c) => s + c.bytes, 0)}${r.err ? ' :: ' + r.err : ''}`);
}
const pct = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.max(0, Math.ceil(s.length * q) - 1)] : 0; };
function report(macSkipped) {
  const out = ['', `root: ${root}  runs: ${runs}  ${new Date().toISOString()}`, '',
    '| Task | Kind | Pass | Round trips | Tool ms | ms/call p50 | KB returned | Errors |', '|---|---|---|---|---|---|---|---|'];
  const ids = [...BROWSER_TASKS, ...MAC_TASKS.map((t) => t.id)];
  const tot = { pass: 0, n: 0, calls: 0, ms: 0, bytes: 0, errors: 0 };
  for (const id of ids) {
    const rs = results.filter((r) => r.task === id);
    if (!rs.length) { out.push(`| ${id} | mac | skipped | | | | | |`); continue; }
    const per = rs.map((r) => calls.filter((c) => c.task === id && c.run === r.run));
    const med = (f) => pct(per.map(f), 0.5);
    const line = { pass: rs.filter((r) => r.ok).length, n: rs.length, calls: med((c) => c.length), ms: med((c) => c.reduce((s, x) => s + x.ms, 0)),
      bytes: med((c) => c.reduce((s, x) => s + x.bytes, 0)), errors: med((c) => c.filter((x) => x.error).length) };
    out.push(`| ${id} | ${rs[0].kind} | ${line.pass}/${line.n} | ${line.calls} | ${line.ms} | ${pct(per.flat().map((c) => c.ms), 0.5)} | ${(line.bytes / 1024).toFixed(1)} | ${line.errors} |`);
    for (const k of Object.keys(tot)) tot[k] += line[k];
  }
  out.push(`| **Total** (sum of medians) | | **${tot.pass}/${tot.n}** | **${tot.calls}** | **${tot.ms}** | ${pct(calls.map((c) => c.ms), 0.5)} | **${(tot.bytes / 1024).toFixed(1)}** | **${tot.errors}** |`);
  out.push('', '| Tool (action) | Calls | p50 ms | p95 ms | Mean KB | Errors |', '|---|---|---|---|---|---|');
  const byTool = new Map();
  for (const c of calls) { const k = c.tool + (c.action ? ` (${c.action})` : ''); byTool.set(k, [...(byTool.get(k) || []), c]); }
  for (const [k, cs] of [...byTool].sort((a, b) => b[1].reduce((s, c) => s + c.ms, 0) - a[1].reduce((s, c) => s + c.ms, 0))) {
    out.push(`| ${k} | ${cs.length} | ${pct(cs.map((c) => c.ms), 0.5)} | ${pct(cs.map((c) => c.ms), 0.95)} | ${(cs.reduce((s, c) => s + c.bytes, 0) / cs.length / 1024).toFixed(1)} | ${cs.filter((c) => c.error).length} |`);
  }
  const errs = [...new Set(calls.filter((c) => c.error).map((c) => `${c.task}: ${c.tool}${c.action ? ' ' + c.action : ''}: ${c.error.slice(0, 140)}`))];
  if (errs.length) out.push('', 'Tool errors seen (deduplicated):', ...errs.map((e) => '- ' + e));
  if (macSkipped) out.push('', 'Mac tasks skipped: pass --mac-app or --computer-connection.');
  console.log(out.join('\n'));
  if (arg('--json')) fs.writeFileSync(arg('--json'), JSON.stringify({ root, runs, results, calls }, null, 1));
}

async function main() {
  if (arg('--mac-app') && !process.env.CU_MCP_BENCH_IN_APP) return reexecUnderApp(arg('--mac-app'));
  const conn = arg('--computer-connection');
  const mac = conn ? path.resolve(conn) : process.env.CU_MCP_BENCH_IN_APP ? 'vm' : null;
  for (let run = 0; run < runs; run++) await runBrowser(run, mac);
  report(!mac);
  process.exit(results.some((r) => !r.ok) ? 1 : 0);
}
main().catch((e) => { console.error('bench failed:', e.stack || e.message); process.exit(1); });
