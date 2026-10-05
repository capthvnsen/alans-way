#!/usr/bin/env node
// browser-bench.cjs — measures real task completion through the workspace
// browser API: wall time, HTTP call count, and success per task. Runs the same
// task once per action-call and once batched to quantify the round-trip win.
//
// Usage: node scripts/browser-bench.cjs [--connection PATH] [--bot-id ID]
//        [--mode both|per-action|batch]
// Connection defaults to the app's connection.json (HERMES_WORKSPACE_CONNECTION
// env wins). Requires a reachable workspace browser host.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function arg(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; }
const connPath = arg('--connection') || process.env.HERMES_WORKSPACE_CONNECTION ||
  path.join(os.homedir(), 'Library', 'Application Support', 'Hermes Workspace', 'connection.json');
const botId = arg('--bot-id') || process.env.HERMES_WORKSPACE_BOT_ID || 'bench';
const mode = arg('--mode') || 'both';
const connection = JSON.parse(fs.readFileSync(connPath, 'utf8'));
let calls = 0;
async function api(endpoint, method = 'GET', body, extra = {}) {
  calls++;
  const r = await fetch(new URL(endpoint, connection.url), {
    method,
    headers: { Authorization: `Bearer ${connection.token}`, 'X-Hermes-Bot': botId, 'Content-Type': 'application/json', ...extra },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, ...data };
}
async function newTab() {
  const t = await api('/v1/tabs', 'POST', { url: 'about:blank', background: true });
  return t;
}
async function closeTab(id, epoch) { await api(`/v1/tabs/${id}`, 'DELETE', undefined, { 'x-control-epoch': String(epoch) }); }
const act = (id, epoch, body) => api(`/v1/tabs/${id}/actions`, 'POST', { ...body, epoch });

// A real multi-step flow: navigate, wait for the form, fill two fields, read
// back the DOM state to verify. Same steps in both modes.
const FORM_STEPS = () => [
  { action: 'navigate', url: 'https://httpbin.org/forms/post' },
  { action: 'wait', selector: 'input[name=custname]', timeout: 10000 },
  { action: 'type', selector: 'input[name=custname]', text: 'Ada Lovelace' },
  { action: 'type', selector: 'textarea[name=comments]', text: 'first programmer' },
  { action: 'eval', code: '({name:document.querySelector("[name=custname]")?.value, comments:document.querySelector("[name=comments]")?.value})' },
];
const verify = (v) => v && v.name === 'Ada Lovelace' && v.comments === 'first programmer';

const tasks = [
  {
    name: 'form fill + readback',
    async perAction(tab) {
      let last;
      for (const step of FORM_STEPS()) { last = await act(tab.id, tab.epoch, step); if (last.error) return { ok: false, err: last.error }; }
      return { ok: verify(last.value) };
    },
    async batched(tab) {
      const r = await act(tab.id, tab.epoch, { action: 'batch', steps: FORM_STEPS() });
      const last = r.results?.at(-1);
      return { ok: r.results?.length === 5 && verify(last?.value) };
    },
  },
  {
    name: 'navigate + extract',
    async perAction(tab) {
      await act(tab.id, tab.epoch, { action: 'navigate', url: 'https://httpbin.org/html' });
      const r = await act(tab.id, tab.epoch, { action: 'eval', code: 'document.querySelector("h1")?.textContent' });
      return { ok: r.value === 'Herman Melville - Moby-Dick' };
    },
    async batched(tab) {
      const r = await act(tab.id, tab.epoch, { action: 'batch', steps: [
        { action: 'navigate', url: 'https://httpbin.org/html' },
        { action: 'eval', code: 'document.querySelector("h1")?.textContent' },
      ] });
      return { ok: r.results?.[1]?.value === 'Herman Melville - Moby-Dick' };
    },
  },
  {
    name: 'multi-step wait chain',
    async perAction(tab) {
      await act(tab.id, tab.epoch, { action: 'navigate', url: 'https://httpbin.org/links/200/0' });
      const c = await act(tab.id, tab.epoch, { action: 'click', selector: 'a' });
      if (c.error) return { ok: false, err: c.error };
      const w = await act(tab.id, tab.epoch, { action: 'wait', url: '/links/200/1', timeout: 8000 });
      if (w.error) return { ok: false, err: w.error };
      const v = await act(tab.id, tab.epoch, { action: 'eval', code: 'location.pathname' });
      return { ok: v.value === '/links/200/1' };
    },
    async batched(tab) {
      const r = await act(tab.id, tab.epoch, { action: 'batch', steps: [
        { action: 'navigate', url: 'https://httpbin.org/links/200/0' },
        { action: 'click', selector: 'a' },
        { action: 'wait', url: '/links/200/1', timeout: 8000 },
        { action: 'eval', code: 'location.pathname' },
      ] });
      return { ok: r.results?.[3]?.value === '/links/200/1' };
    },
  },
  {
    name: 'viewport + responsive check',
    async perAction(tab) {
      await act(tab.id, tab.epoch, { action: 'navigate', url: 'https://example.com' });
      await act(tab.id, tab.epoch, { action: 'viewport', width: 1440, height: 900 });
      const r = await act(tab.id, tab.epoch, { action: 'eval', code: 'innerWidth' });
      return { ok: r.value === 1440 };
    },
    async batched(tab) {
      const r = await act(tab.id, tab.epoch, { action: 'batch', steps: [
        { action: 'navigate', url: 'https://example.com' },
        { action: 'viewport', width: 1440, height: 900 },
        { action: 'eval', code: 'innerWidth' },
      ] });
      return { ok: r.results?.[2]?.value === 1440 };
    },
  },
];

async function main() {
  const rows = [];
  for (const task of tasks) {
    for (const variant of ['perAction', 'batched']) {
      if (mode === 'per-action' && variant === 'batched') continue;
      if (mode === 'batch' && variant === 'perAction') continue;
      const tab = await newTab();
      calls = 0;
      const t0 = Date.now();
      let result;
      try { result = await task[variant](tab); }
      catch (e) { result = { ok: false, err: e.message }; }
      const ms = Date.now() - t0;
      rows.push({ task: task.name, mode: variant === 'batched' ? 'batch' : 'per-action', ok: !!result.ok, ms, calls });
      const fresh = await api(`/v1/tabs/${tab.id}`);
      await closeTab(tab.id, fresh.epoch ?? tab.epoch);
    }
  }
  console.log('\n  task                         mode        ok   calls    wall');
  console.log('  ' + '─'.repeat(64));
  for (const r of rows) console.log(`  ${r.task.padEnd(28)} ${r.mode.padEnd(11)} ${r.ok ? 'PASS' : 'FAIL'}  ${String(r.calls).padStart(5)}  ${String(r.ms).padStart(6)}ms`);
  const fails = rows.filter(r => !r.ok);
  console.log(`\n${rows.length - fails.length}/${rows.length} tasks passed${fails.length ? ' — failures: ' + fails.map(f => f.task + '/' + f.mode).join(', ') : ''}`);
  process.exit(fails.length ? 1 : 0);
}
main().catch(e => { console.error('bench failed:', e.message); process.exit(1); });
