// Short local protocol proof: actual Electron, actual stdio MCP, two input
// oracles, and a proxy that corrupts receipts only AFTER upstream completes.
// Run: node test/run-electron.cjs test/browser-continuation-electron.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { app, BrowserWindow, webContents } = require('electron');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { prepareFixture, quitFixture } = require('./electron-fixture.cjs');
const profile = process.env.HERMES_TEST_PROFILE || fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-continuation-'));
prepareFixture(profile);
process.env.HERMES_WORKSPACE_ALLOW_LOOPBACK = '1';
fs.writeFileSync(path.join(profile, 'preferences.json'), JSON.stringify({ onboarded: true, preview: false,
  bots: [{ id: '4242', isBot: true, name: 'Continuation fixture' }], selectedBotId: '4242' }));
require('../src/main.cjs');

const evidence = process.env.HERMES_RELIABILITY_EVIDENCE;
const connector = path.resolve(__dirname, '../scripts/browser-mcp.cjs');
const results = { scope: 'Isolated local Electron and actual stdio MCP; no native-focus assertion or remote Hermes execution',
  connectorSha256: crypto.createHash('sha256').update(fs.readFileSync(connector)).digest('hex'), wire: [], calls: [], checks: [] };
let fixture, proxy, client, transport, fault;
function save() {
  if (!evidence) return;
  fs.mkdirSync(evidence, { recursive: true });
  fs.writeFileSync(path.join(evidence, 'continuation-electron-results.json'), JSON.stringify(results, null, 2) + '\n');
}
function check(label, passed, details) { results.checks.push({ label, passed: !!passed, details }); save(); }
async function until(read, predicate, timeout = 10000) {
  const end = Date.now() + timeout;
  do { const value = await read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 40)); } while (Date.now() < end);
  throw new Error('Isolated continuation fixture setup deadline exceeded.');
}
async function call(label, name, args = {}) {
  const start = performance.now();
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 15000 });
  results.calls.push({ label, name, args, elapsedMs: Math.round(performance.now() - start), result }); save(); return result;
}
function data(result) { assert.equal(result.isError, undefined, JSON.stringify(result)); return JSON.parse(result.content[0].text); }
async function connect(connection, map) {
  transport = new StdioClientTransport({ command: process.execPath,
    args: [connector, '--bot-id', '4242', '--connection', connection, ...(map ? ['--tab-map', JSON.stringify(map)] : [])],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  client = new Client({ name: 'continuation-electron-proof', version: '1' }); await client.connect(transport);
}
async function disconnect() { await client?.close().catch(() => {}); await transport?.close().catch(() => {}); }

app.whenReady().then(async () => {
  await until(() => BrowserWindow.getAllWindows()[0], Boolean);
  const upstreamConnection = JSON.parse(await until(() => {
    try { return fs.readFileSync(path.join(profile, 'connection.json'), 'utf8'); } catch { return ''; }
  }, Boolean));
  fixture = http.createServer((_req, res) => res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }).end(`<!doctype html>
    <title>Continuation input oracle</title><style>body{font:20px system-ui;padding:35px}input{font:inherit;padding:10px}</style>
    <h1>Continuation input oracle</h1><label>Draft <input id="draft" aria-label="Draft"></label><p id="count">Input events: 0</p>
    <script>window.oracle={inputs:0,events:[]};draft.addEventListener('input',e=>{oracle.inputs++;oracle.events.push({value:draft.value,trusted:e.isTrusted});count.textContent='Input events: '+oracle.inputs})</script>`));
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${fixture.address().port}/`;
  proxy = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const used = req.url.endsWith('/actions') ? fault : null;
    if (used) fault = null;
    const wire = { method: req.method, url: req.url, request: raw ? JSON.parse(raw) : null, fault: used };
    results.wire.push(wire);
    try {
      const upstream = await fetch(new URL(req.url, upstreamConnection.url), { method: req.method,
        headers: { Authorization: `Bearer ${upstreamConnection.token}`, 'X-Hermes-Bot': '4242', 'Content-Type': 'application/json',
          ...(req.headers['x-control-epoch'] ? { 'X-Control-Epoch': req.headers['x-control-epoch'] } : {}) },
        ...(raw ? { body: raw } : {}), signal: AbortSignal.timeout(12000) });
      wire.upstreamStatus = upstream.status;
      wire.upstreamBody = JSON.parse(await upstream.text());
      wire.responseStatus = used ? used.status : upstream.status;
      wire.responseBody = used ? used.body : wire.upstreamBody;
      res.writeHead(wire.responseStatus, { 'Content-Type': 'application/json' }).end(JSON.stringify(wire.responseBody)); save();
    } catch (error) { wire.failure = error.message; save(); res.destroy(); }
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const connection = path.join(profile, 'fault-proxy.json');
  fs.writeFileSync(connection, JSON.stringify({ url: `http://127.0.0.1:${proxy.address().port}`, token: 'isolated-fixture' }));
  await connect(connection);
  const original = data(await call('open-original', 'cua_alans_way_open', { url: base + '?original' }));
  const continued = data(await call('open-continued', 'cua_alans_way_open', { url: base + '?continued' }));
  results.tabs = { original, continued };
  for (const tab of [original, continued]) data(await call('initial-snapshot-' + tab.id, 'cua_alans_way_snapshot', { tabId: tab.id }));
  const pages = await Promise.all(['original', 'continued'].map(label => until(() => webContents.getAllWebContents().find(wc => wc.getURL() === base + '?' + label), Boolean)));
  const observe = async () => ({ original: await pages[0].executeJavaScript('({value:draft.value,...JSON.parse(JSON.stringify(oracle))})'),
    continued: await pages[1].executeJavaScript('({value:draft.value,...JSON.parse(JSON.stringify(oracle))})') });
  await disconnect(); await connect(connection, { [original.id]: continued.id });
  for (const [label, status, body, batch] of [
    ['generic-502', 502, { error: 'upstream request failed' }, false],
    ['missing-502', 502, { error: 'Tab not found.' }, false],
    ['partial-batch-missing-502', 502, { error: 'Tab not found.' }, true],
    ['structured-refusal-502', 502, { error: 'Tab not found.', code: 'tab_not_found', dispatched: false }, false],
    ['stale-409-after-execution', 409, { error: 'stale_control_epoch: read the tab state and retry after a fresh snapshot.' }, true],
  ]) {
    const before = await observe(), start = results.wire.length, text = label + ' executed once';
    fault = { status, body };
    const receipt = await call(label, 'cua_alans_way_action', { tabId: original.id, epoch: original.epoch,
      ...(batch ? { action: 'batch', steps: [{ action: 'type', selector: '#draft', text }, { action: 'click', selector: '#missing' }, { action: 'type', selector: '#draft', text: 'MUST NOT RUN' }] }
        : { action: 'type', selector: '#draft', text }) });
    const after = await observe(), requests = results.wire.slice(start).filter(w => w.url.endsWith('/actions'));
    const snapshot = data(await call(label + '-recovery', 'cua_alans_way_snapshot', { tabId: original.id }));
    const message = receipt.content[0].text;
    check(label + ': explicit uncertainty and original-state recovery', receipt.isError === true && /action may have executed.*Do not repeat/i.test(message)
      && message.includes(JSON.stringify({ tabId: original.id })) && !/Mac tab is gone|Keep working in tab/.test(message)
      && receipt._meta?.browserRequest?.status === status, receipt);
    check(label + ': exactly one request/input; continuation untouched', requests.length === 1 && requests[0].url.includes(original.id)
      && after.original.inputs === before.original.inputs + 1 && after.original.value === text && after.original.events.at(-1).trusted
      && JSON.stringify(after.continued) === JSON.stringify(before.continued), { before, after, requests });
    check(label + ': snapshot recovers original value and epoch', snapshot.tab.id === original.id && snapshot.tab.epoch === original.epoch
      && snapshot.elements.some(el => el.name === 'Draft' && el.value === text));
    if (batch) check(label + ': upstream retains partial batch and stops', requests[0].upstreamBody.results?.length === 2
      && requests[0].upstreamBody.results[0].ok === true && requests[0].upstreamBody.results[1].ok === false, requests[0].upstreamBody);
  }
  // The actual host's precise refusals must remain visible, with no input.
  for (const [label, args, pattern] of [
    ['real-stale-epoch', { epoch: original.epoch + 50, action: 'type', selector: '#draft', text: 'MUST NOT RUN' }, /stale_control_epoch/],
    ['real-missing-control', { epoch: original.epoch, action: 'click', selector: '#missing' }, /missing|match|found|target/i],
    ['malicious-page-error', { epoch: original.epoch, action: 'eval', code: 'throw new Error("Tab not found.")' }, /Tab not found/],
  ]) {
    const start = results.wire.length, before = await observe();
    const receipt = await call(label, 'cua_alans_way_action', { tabId: original.id, ...args });
    check(label + ': precise error, one request, zero input', receipt.isError === true && pattern.test(receipt.content[0].text)
      && /action may have executed/i.test(receipt.content[0].text) && results.wire.slice(start).filter(w => w.url.endsWith('/actions')).length === 1
      && JSON.stringify(await observe()) === JSON.stringify(before), receipt);
  }
  const partial = data(await call('valid-partial-batch', 'cua_alans_way_action', { tabId: original.id, epoch: original.epoch, action: 'batch',
    steps: [{ action: 'type', selector: '#draft', text: 'valid partial receipt' }, { action: 'click', selector: '#missing' }, { action: 'type', selector: '#draft', text: 'MUST NOT RUN' }] }));
  check('valid partial receipt preserved', partial.dispatched === true && partial.results?.length === 2 && partial.results[0].ok === true && partial.results[1].ok === false, partial);

  // Move the destination epoch so an old original epoch cannot accidentally
  // pass. Close only our original fixture tab to obtain a real host 404.
  data(await call('release-continued', 'cua_alans_way_action', { tabId: continued.id, epoch: continued.epoch, action: 'release' }));
  const claimed = data(await call('claim-continued', 'cua_alans_way_action', { tabId: continued.id, epoch: continued.epoch, action: 'claim' }));
  assert.notEqual(claimed.epoch, original.epoch);
  data(await call('close-original', 'cua_alans_way_close', { tabId: original.id, epoch: original.epoch }));
  const read = data(await call('real-read-continuation', 'cua_alans_way_snapshot', { tabId: original.id }));
  check('real missing-tab read continues', read.continuedTab === continued.id && read.tab.id === continued.id);
  for (const batch of [false, true]) {
    const start = results.wire.length, before = await observeContinued(), text = 'safe continuation ' + (batch ? 'batch' : 'single');
    const receipt = data(await call('real-404-' + (batch ? 'batch' : 'single'), 'cua_alans_way_action', { tabId: original.id, epoch: original.epoch,
      ...(batch ? { action: 'batch', steps: [{ action: 'type', selector: '#draft', text }] } : { action: 'type', selector: '#draft', text }) }));
    const after = await observeContinued(), wire = results.wire.slice(start), actions = wire.filter(w => w.url.endsWith('/actions'));
    check('real 404 safe continuation ' + batch, actions.length === 2 && actions[0].upstreamStatus === 404
      && actions[0].upstreamBody.error === 'Tab not found.' && actions[1].upstreamStatus === 200 && actions[1].request.epoch === claimed.epoch
      && wire.some(w => w.method === 'GET' && w.url === '/v1/tabs/' + continued.id) && receipt.continuedTab === continued.id
      && receipt.continuedEpoch === claimed.epoch && after.inputs === before.inputs + 1 && after.value === text && after.events.at(-1).trusted, { before, after, wire, receipt });
  }
  async function observeContinued() { return pages[1].executeJavaScript('({value:draft.value,...JSON.parse(JSON.stringify(oracle))})'); }
  results.finalContinued = await observeContinued();
  save();
  assert.ok(results.checks.every(c => c.passed), JSON.stringify(results.checks.filter(c => !c.passed)));
  console.log(JSON.stringify({ checks: results.checks.length, passed: results.checks.filter(c => c.passed).length,
    actionRequests: results.wire.filter(w => w.url.endsWith('/actions')).length, elapsedMs: results.calls.map(c => ({ label: c.label, elapsedMs: c.elapsedMs })) }));
}).catch(error => { results.failure = { message: error.message, stack: error.stack }; save(); console.error(error); process.exitCode = 1; })
  .finally(async () => { await disconnect(); quitFixture(fixture, proxy); if (process.exitCode) app.exit(process.exitCode); });
