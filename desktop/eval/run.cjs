#!/usr/bin/env node
// Agent-capability eval harness for the Alan's Way tools.
//   node eval/run.cjs --list
//   node eval/run.cjs --mode null     (negative control: does nothing; every check must FAIL)
//   node eval/run.cjs --mode oracle [--tasks id,id|fixture|public] [--out DIR]
//   node eval/run.cjs --mode hermes --tasks fx-shadow-nested [--model M --provider P] [--hermes-home DIR] [--plugin-dir DIR]
//   node eval/run.cjs --mode codex  --tasks fixture,public   (runs `codex exec --json` per task with the manual-mode prompt; fixtures served on 127.0.0.1)
//   node eval/run.cjs --mode manual --tasks fixture,public   (baseline: Codex or a human drives; harness prints each task, times it, runs the check)
// Options: --connection PATH  drive an already-running app/host instead of booting headless Chrome
//          --fixture-host IP  bind fixtures to and address them by IP (the shipped Mac app blocks loopback; use the LAN IP)
//          --repeat N         run each task N times (agents are noisy; use >=3 for real numbers)
// See docs/agent-eval.md for the hermes-mode requirements.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { tasks } = require('./tasks.cjs');
const { createFixtures } = require('./fixtures.cjs');
const { startStack } = require('./runtime.cjs');
const { connectTools } = require('./tools.cjs');

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const mode = opt('mode', 'oracle');
const repeat = Number(opt('repeat', 1));
const sel = opt('tasks', '');
const picked = tasks.filter((t) => !sel || sel.split(',').some((s) => s === t.id || s === t.tier));

if (argv.includes('--list')) {
  for (const t of picked) console.log(`${t.tier.padEnd(8)} ${t.id.padEnd(30)} max ${String(t.maxSteps).padStart(2)}  oracle=${t.oracle ? 'yes' : 'no '}  ${t.title}`);
  process.exit(0);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function classify(r) {
  if (r.ok) return r.overBudget ? 'over_budget' : null;
  if (r.timedOut) return 'timeout';
  if (r.crashed) return 'agent_crash';
  if (/gave up/i.test(r.answer || '')) return 'gave_up';
  if (r.httpErrors) return 'tool_error';
  if (r.overBudget) return 'over_budget';
  return r.answer ? 'wrong_answer' : 'wrong_state';
}

function hermesPrompt(task, fx) {
  const where = task.start ? `Start at ${task.start(fx)} (open it with the workspace browser).` : 'This is a macOS desktop task.';
  return `${where}\nTask: ${task.goal(fx)}\nWork on your own and do not ask questions. Use only the Alan's Way workspace tools. When done, end your reply with one line: ANSWER: <short answer, or "done">. If you cannot finish, end with: ANSWER: GAVE UP: <reason>.`;
}

function prepareHermesHome(stack) {
  const given = opt('hermes-home');
  if (given) return given;
  const home = path.join(stack.dir, 'hermes-home'); fs.mkdirSync(home, { recursive: true });
  const mcp = path.join(__dirname, '../scripts/browser-mcp.cjs');
  const model = opt('model', process.env.EVAL_MODEL), provider = opt('provider', process.env.EVAL_PROVIDER);
  fs.writeFileSync(path.join(home, 'config.yaml'),
    `${model ? `model:\n  default: ${JSON.stringify(model)}\n${provider ? `  provider: ${JSON.stringify(provider)}\n` : ''}` : ''}mcp_servers:\n  workspace_browser:\n    command: ${JSON.stringify(process.execPath)}\n    args: [${JSON.stringify(mcp)}, "--bot-id", ${JSON.stringify(stack.botId)}, "--connection", ${JSON.stringify(stack.connFile)}]\n`);
  const plugin = opt('plugin-dir', process.env.ALANS_WAY_PLUGIN_DIR);
  if (plugin) fs.cpSync(path.join(plugin, 'alans-way/skills'), path.join(home, 'skills'), { recursive: true });
  const extra = opt('extra-plugins', process.env.EVAL_EXTRA_PLUGINS);
  if (extra) fs.cpSync(extra, path.join(home, 'plugins'), { recursive: true });
  return home;
}

function runHermes(prompt, task, home, timeoutMs, stack) {
  const usageFile = path.join(stack.dir, `usage-${Date.now()}.json`);
  const args = ['-z', prompt, '--usage-file', usageFile];
  if (opt('model', process.env.EVAL_MODEL)) args.push('--model', opt('model', process.env.EVAL_MODEL));
  if (opt('provider', process.env.EVAL_PROVIDER)) args.push('--provider', opt('provider', process.env.EVAL_PROVIDER));
  if (fs.existsSync(path.join(home, 'skills/workspace-operations'))) args.push('--skills', 'workspace-operations');
  const cmd = (process.env.HERMES_CMD || 'hermes').split(' ');
  return new Promise((resolve) => {
    const child = spawn(cmd[0], [...cmd.slice(1), ...args], { env: { ...process.env, HERMES_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', timedOut = false;
    child.stdout.on('data', (c) => { out += c; }); child.stderr.on('data', (c) => { err += c; });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      let usage = {}; try { usage = JSON.parse(fs.readFileSync(usageFile, 'utf8')); } catch {}
      const answer = (/ANSWER:\s*(.*)\s*$/s.exec(out) || [])[1] || '';
      resolve({ out, err: err.slice(-500), code, timedOut, usage, answer: answer.trim(), crashed: code !== 0 && !timedOut && !usage.api_calls });
    });
  });
}

function codexPrompt(task, fx) {
  return `${task.start ? `Start at ${task.start(fx)}.\n` : ''}Task: ${task.goal(fx)}\nUse your browser/computer tools. Work on your own and do not ask questions. When done, end your reply with these lines: ANSWER: <short answer, or "done">, and (for web tasks) FINAL_URL: <URL of the page you ended on>. If you cannot finish, end with: ANSWER: GAVE UP: <reason>.`;
}

function runCodex(prompt, timeoutMs, dir) {
  return new Promise((resolve) => {
    const child = spawn(process.env.CODEX_CMD || 'codex', ['exec', '--json', '--skip-git-repo-check', '-s', 'workspace-write', '-C', dir, prompt], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', timedOut = false;
    child.stdout.on('data', (c) => { out += c; }); child.stderr.on('data', () => {});
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      const ev = out.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const done = ev.filter((e) => e.type === 'item.completed').map((e) => e.item);
      const tools = done.filter((i) => i.type === 'command_execution' || i.type === 'mcp_tool_call');
      const usage = (ev.filter((e) => e.type === 'turn.completed').pop() || {}).usage || {};
      const msg = ([...done].reverse().find((i) => i.type === 'agent_message') || {}).text || '';
      const answer = (/ANSWER:\s*(.*?)\s*(?:\n|$)/s.exec(msg) || [])[1] || '';
      const finalUrl = (/FINAL_URL:\s*(\S+)/.exec(msg) || [])[1] || '';
      const backends = [...new Set(tools.map((i) => /ego-browser/.test(i.command || '') ? 'ego-browser(shell)' : i.type === 'mcp_tool_call' ? `${i.server}.${i.tool}` : 'shell'))];
      resolve({ msg, answer: answer.trim(), finalUrl, toolCalls: tools.length, usage: { total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0), cached: usage.cached_input_tokens || 0 }, backends, timedOut, crashed: code !== 0 && !timedOut && !ev.some((e) => e.type === 'turn.completed') });
    });
  });
}

// Codex's browser is not on our host, so tab/DOM checks fall back to what it reports (FINAL_URL, ANSWER); DOM-only checks cannot be verified.
function codexStack(a) {
  return { tabs: async () => [{ url: a.finalUrl || '' }], pageEval: async () => { if (a.answer && /eval-42/.test(a.answer)) return 'eval-42'; throw new Error('unverifiable: DOM state of the external browser is not observable'); } };
}

async function manual(picked, outDir) {
  const lines = require('node:readline').createInterface({ input: process.stdin })[Symbol.asyncIterator]();
  const rl = { question: async (q) => { process.stdout.write(q); const n = await lines.next(); return n.done ? '' : n.value; }, close() {} };
  const fixtures = await createFixtures(opt('fixture-host')); const rows = [];
  console.log(`Fixture server on http://127.0.0.1:${fixtures.port}. Run each task in a FRESH browser/session of the tool under test.`);
  for (const task of picked) {
    if (task.tier === 'desktop') task.setup?.();
    fixtures.reset(); const fx = Object.assign(fixtures.state, { port: fixtures.port, host: opt('fixture-host', '127.0.0.1') });
    console.log(`\n=== ${task.id} (${task.title}) ===\n${task.start ? 'Start: ' + task.start(fx) + '\n' : ''}Prompt: ${task.goal(fx)}`);
    await rl.question('Press Enter when you start the tool... '); const t0 = Date.now();
    const turns = await rl.question('Press Enter when it stops, then enter agent turns/tool calls as "turns calls" (or blank): ');
    const wallMs = Date.now() - t0;
    const answer = await rl.question('Final answer the tool gave (blank if none): ');
    const stack = { tabs: async () => [], pageEval: async () => undefined };
    const res = await task.check({ answer, fx: fixtures.state, stack });
    const [agentTurns, toolCalls] = turns.split(/\s+/).map(Number);
    rows.push({ id: task.id, tier: task.tier, mode: 'manual', ok: !!res.ok, why: res.why, answer, wallMs, agentTurns: agentTurns || null, toolCalls: toolCalls || null, maxSteps: task.maxSteps });
    console.log(res.ok ? 'PASS' : 'FAIL', res.why);
  }
  fs.writeFileSync(path.join(outDir, 'results.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  fixtures.close(); rl.close(); process.exit(0);
}

(async () => {
  const outDir = opt('out', path.join(os.tmpdir(), 'alans-eval-results', new Date().toISOString().replace(/[:.]/g, '-')));
  fs.mkdirSync(outDir, { recursive: true });
  if (mode === 'manual') return manual(picked, outDir);
  const fixtures = await createFixtures(opt('fixture-host'));
  const stack = await startStack({ connection: opt('connection'), fixturePort: fixtures.port });
  const rows = [];
  let tools = null;
  try {
    const home = mode === 'hermes' ? prepareHermesHome(stack) : null;
    if (mode !== 'hermes' && mode !== 'codex') tools = await connectTools(stack);
    for (const task of picked) for (let rep = 0; rep < repeat; rep++) {
      if (mode !== 'hermes' && mode !== 'codex' && (!task.oracle || task.tier === 'desktop')) { rows.push({ id: task.id, tier: task.tier, skipped: task.tier === 'desktop' ? 'desktop needs a Mac with grants' : 'no oracle yet' }); continue; }
      if (mode === 'hermes' && task.tier === 'desktop' && !opt('hermes-home') && !opt('connection')) { rows.push({ id: task.id, tier: task.tier, skipped: 'desktop needs --hermes-home with computer_use + a real app connection' }); continue; }
      fixtures.reset(); await stack.closeTabs(); stack.proxy.takeLog(); task.setup?.();
      const fx = Object.assign(fixtures.state, { port: fixtures.port, ...(opt('connection') || mode === 'codex' ? { host: opt('fixture-host', '127.0.0.1') } : {}) });
      const t0 = Date.now();
      let answer = '', error = '', agent = {};
      if (mode === 'codex') {
        const cdir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-eval-'));
        agent = await runCodex(codexPrompt(task, fx), Math.max(180000, task.maxSteps * 30000), cdir);
        answer = agent.answer; fs.rmSync(cdir, { recursive: true, force: true });
      } else if (mode !== 'hermes') {
        tools.resetMetrics(); tools.tab = null;
        try { if (task.start) await tools.open(task.start(fx)); answer = (mode === 'null' ? '' : await task.oracle(tools, fx, stack)) || ''; } catch (e) { error = e.message; }
      } else {
        agent = await runHermes(hermesPrompt(task, fx), task, home, Math.max(120000, task.maxSteps * 30000), stack);
        answer = agent.answer;
      }
      const wallMs = Date.now() - t0;
      await wait(300);
      const log = stack.proxy.takeLog();
      let res; try { res = await task.check({ answer, fx: fixtures.state, stack: mode === 'codex' ? codexStack(agent) : stack }); } catch (e) { res = { ok: false, why: 'check threw: ' + e.message }; }
      const toolCalls = mode === 'codex' ? agent.toolCalls : mode !== 'hermes' ? tools.metrics.calls : log.length;
      const row = {
        id: task.id, tier: task.tier, mode, rep, ok: !!res.ok, why: String(res.why).slice(0, 200), answer: String(answer).slice(0, 200), reply: String(agent.out || agent.msg || '').slice(-400), error,
        wallMs, toolCalls, maxSteps: task.maxSteps, overBudget: toolCalls > task.maxSteps,
        httpCalls: log.length, httpErrors: log.filter((l) => l.status >= 400).length, respBytes: log.reduce((a, l) => a + l.bytes, 0),
        byTool: tools ? { ...tools.metrics.byTool } : undefined,
        agentTurns: agent.usage?.api_calls ?? null, backends: agent.backends, tokens: agent.usage?.total_tokens ?? null, costUsd: agent.usage?.estimated_cost_usd ?? null,
        timedOut: agent.timedOut, crashed: agent.crashed,
      };
      row.failure = classify(row);
      rows.push(row);
      console.log(`${row.ok ? 'PASS' : 'FAIL'} ${task.id.padEnd(28)} ${String(wallMs).padStart(6)}ms tools=${toolCalls}/${task.maxSteps}${row.failure ? ' [' + row.failure + ']' : ''}${row.ok ? '' : ' :: ' + (error || row.why)}`);
    }
  } finally {
    fs.writeFileSync(path.join(outDir, 'results.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    await tools?.close().catch(() => {}); fixtures.close(); await stack.stop();
  }
  const ran = rows.filter((r) => !r.skipped), pass = ran.filter((r) => r.ok);
  const sum = (k) => ran.reduce((a, r) => a + (r[k] || 0), 0);
  console.log(`\nsuccess ${pass.length}/${ran.length}  strict(within budget) ${pass.filter((r) => !r.overBudget).length}/${ran.length}  skipped ${rows.length - ran.length}`);
  if (ran.length) console.log(`mean wall ${Math.round(sum('wallMs') / ran.length)}ms  mean tool calls ${(sum('toolCalls') / ran.length).toFixed(1)}  mean resp ${Math.round(sum('respBytes') / ran.length)}B${mode === 'hermes' ? `  turns ${sum('agentTurns')}  tokens ${sum('tokens')}` : ''}`);
  console.log('results: ' + path.join(outDir, 'results.jsonl'));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
