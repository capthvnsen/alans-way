'use strict';
// The real scripts/browser-mcp.cjs, spawned over stdio, against a fake loopback app.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fakeApp, writeConnection, startConnector, tempConnection, CONNECTOR } = require('./mcp-stdio-fixture.cjs');

async function rig(t, handler = (_entry, json) => json(200, { dispatched: true, ok: true }), options = {}) {
  const app = await fakeApp(handler);
  const conn = tempConnection(app);
  const connector = startConnector({ connection: conn.file, ...options });
  t.after(async () => { await connector.stop(); await app.close(); conn.cleanup(); });
  await connector.initialize();
  return { app, conn, connector };
}
const text = (result) => result.content[0].text;
const action = (extra = {}) => ({ tabId: 'tab1', epoch: 3, action: 'click', ref: 'e1', ...extra });

test('framing: partial frames, CRLF and multibyte characters split across chunks are reassembled', { timeout: 15000 }, async (t) => {
  const { connector } = await rig(t, (_e, json) => json(200, { title: 'héllo 😀 日本' }));
  const frame = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'cua_alans_way_status', arguments: {} } }) + '\r\n');
  for (let i = 0; i < frame.length; i += 3) { connector.write(frame.subarray(i, i + 3)); await new Promise((resolve) => setImmediate(resolve)); }
  const reply = await connector.reply(7);
  assert.equal(JSON.parse(text(reply.result)).title, 'héllo 😀 日本');
  const wide = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'cua_alans_way_open', arguments: { url: 'https://example.com/日本語-😀' } } }) + '\n');
  const cut = wide.indexOf(Buffer.from('😀')) + 2;
  connector.write(wide.subarray(0, cut)); await new Promise((resolve) => setTimeout(resolve, 30)); connector.write(wide.subarray(cut));
  assert.ok(!(await connector.reply(8)).result.isError);
});

test('stdout carries only JSON-RPC lines, whatever the client sends', { timeout: 15000 }, async (t) => {
  const { connector } = await rig(t);
  connector.write('{not json\n');
  connector.write('\n');
  connector.write('{"jsonrpc":"2.0","id":9,"method":"bogus/method"}\n');
  const reply = await connector.reply(9);
  assert.equal(reply.error.code, -32601);
  assert.ok(!(await connector.call('cua_alans_way_status')).isError, 'the server survives garbage between frames');
  for (const line of connector.state.lines) assert.equal(JSON.parse(line).jsonrpc, '2.0', line);
});

test('tools/list answers without touching the app and every tool has a schema', { timeout: 15000 }, async (t) => {
  const { app, connector } = await rig(t);
  const { result } = await connector.request('tools/list', {});
  assert.ok(result.tools.length >= 14);
  for (const tool of result.tools) assert.equal(tool.inputSchema.type, 'object', tool.name);
  assert.deepEqual(app.log, []);
});

test('closing stdin mid-call aborts the request to the app and exits promptly', { timeout: 15000 }, async (t) => {
  let release;
  const { app, connector } = await rig(t, (_e, json, res) => new Promise((resolve) => { release = () => { json(200, { dispatched: true }); resolve(); }; res.on('close', resolve); }));
  connector.callAsync('cua_alans_way_action', action());
  for (let i = 0; i < 100 && !app.log.length; i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(app.log.length, 1, 'the action reached the app');
  const started = Date.now();
  connector.child.stdin.end();
  const exit = await Promise.race([connector.exited, new Promise((resolve) => setTimeout(() => resolve('still running'), 2500))]);
  assert.notEqual(exit, 'still running', 'the connector must not linger for the request timeout after the client is gone');
  assert.ok(Date.now() - started < 2500);
  release?.();
});

for (const signal of ['SIGTERM', 'SIGINT']) test(`${signal} exits cleanly even with a call in flight`, { timeout: 15000 }, async (t) => {
  const { app, connector } = await rig(t, (_e, _json, res) => new Promise((resolve) => res.on('close', resolve)));
  connector.callAsync('cua_alans_way_snapshot', { tabId: 'tab1' });
  for (let i = 0; i < 100 && !app.log.length; i++) await new Promise((resolve) => setTimeout(resolve, 20));
  connector.child.kill(signal);
  const exit = await Promise.race([connector.exited, new Promise((resolve) => setTimeout(() => resolve(null), 2500))]);
  assert.ok(exit, 'exited');
});

test('concurrent calls resolve independently, each with its own deadline and answer', { timeout: 20000 }, async (t) => {
  const { app, connector } = await rig(t, async (entry, json) => {
    const tab = /tabs\/(\w+)/.exec(entry.url)?.[1] || '';
    await new Promise((resolve) => setTimeout(resolve, tab === 'slow' ? 300 : 5));
    json(200, { tab });
  });
  const pending = [connector.callAsync('cua_alans_way_snapshot', { tabId: 'slow' }),
    ...Array.from({ length: 30 }, (_, i) => connector.callAsync('cua_alans_way_snapshot', { tabId: 'fast' + i }))];
  const replies = await Promise.all(pending.map((p) => p.reply()));
  assert.deepEqual(replies.map((r) => JSON.parse(text(r.result)).tab), ['slow', ...Array.from({ length: 30 }, (_, i) => 'fast' + i)]);
  assert.equal(app.log.length, 31);
});

test('a cancelled call aborts its request and never answers', { timeout: 15000 }, async (t) => {
  const { app, connector } = await rig(t, (entry, json, res) => entry.url.includes('/snapshot') ? new Promise((resolve) => res.on('close', resolve)) : json(200, { tabs: [] }));
  const pending = connector.callAsync('cua_alans_way_snapshot', { tabId: 'tab1' });
  for (let i = 0; i < 100 && !app.log.length; i++) await new Promise((resolve) => setTimeout(resolve, 20));
  connector.write({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: pending.id, reason: 'user' } });
  for (let i = 0; i < 100 && !app.log[0].closed; i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(app.log[0].closed, true, 'the app saw the request abandoned');
  assert.ok(!(await connector.call('cua_alans_way_tabs')).isError, 'the connector keeps serving after a cancel');
  assert.ok(!connector.state.lines.some((line) => JSON.parse(line).id === pending.id), 'no answer to a cancelled request');
});

test('the caller deadline reaches the app, whole or fractional, and an expired budget sends nothing', { timeout: 15000 }, async (t) => {
  const { app, connector } = await rig(t);
  await connector.call('cua_alans_way_snapshot', { tabId: 'tab1' }, { 'alans-way/remainingMs': 20000 });
  const ms = (entry) => Number(entry.headers['x-alans-way-remaining-ms']);
  assert.ok(ms(app.log[0]) > 15000 && ms(app.log[0]) <= 20000);
  await connector.call('cua_alans_way_snapshot', { tabId: 'tab1' }, { 'alans-way/remainingMs': 12345.7 });
  assert.ok(ms(app.log[1]) > 10000 && ms(app.log[1]) <= 12346, 'a fractional budget is honoured, not dropped');
  const before = app.log.length;
  const expired = await connector.call('cua_alans_way_action', action(), { 'alans-way/remainingMs': 0 });
  assert.equal(expired.isError, true);
  assert.equal(app.log.length, before, 'an expired call never dispatches');
});

test('a connector file replaced on disk waits for other in-flight calls before exiting', { timeout: 20000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-reload-'));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.symlinkSync(path.join(__dirname, '../src'), path.join(root, 'src'));
  fs.symlinkSync(path.join(__dirname, '../node_modules'), path.join(root, 'node_modules'));
  const script = path.join(root, 'scripts', 'browser-mcp.cjs');
  fs.copyFileSync(CONNECTOR, script);
  let release;
  const app = await fakeApp((entry, json, res) => entry.url.includes('slow')
    ? new Promise((resolve) => { release = () => { json(200, { tab: 'slow' }); resolve(); }; res.on('close', resolve); })
    : json(200, { tab: 'fast' }));
  const conn = tempConnection(app);
  const connector = startConnector({ connection: conn.file, script });
  t.after(async () => { await connector.stop(); await app.close(); conn.cleanup(); fs.rmSync(root, { recursive: true, force: true }); });
  await connector.initialize();
  const slow = connector.callAsync('cua_alans_way_snapshot', { tabId: 'slow' });
  for (let i = 0; i < 100 && !app.log.length; i++) await new Promise((resolve) => setTimeout(resolve, 20));
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(script, later, later);
  assert.ok(!(await connector.call('cua_alans_way_snapshot', { tabId: 'fast' })).isError);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(connector.state.exited, null, 'a call is still running, so the connector stays');
  release();
  const reply = await slow.reply();
  assert.equal(JSON.parse(text(reply.result)).tab, 'slow', 'the slow call finished instead of being cut off');
  const exit = await Promise.race([connector.exited, new Promise((resolve) => setTimeout(() => resolve(null), 3000))]);
  assert.ok(exit, 'once idle it exits so the replacement loads');
});

test('a frame over the 10 MB limit closes the server with a reason on stderr instead of hanging', { timeout: 15000 }, async (t) => {
  const { app, connector } = await rig(t);
  connector.child.stdin.on('error', () => {});
  connector.write(JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'cua_alans_way_action', arguments: { ...action(), text: 'x'.repeat(11 * 1024 * 1024) } } }) + '\n');
  const exit = await Promise.race([connector.exited, new Promise((resolve) => setTimeout(() => resolve(null), 4000))]);
  assert.ok(exit, 'the connector exits');
  assert.match(connector.state.stderr, /over 10 MB/);
  assert.deepEqual(app.log, []);
});

test('a client that stops reading stdout does not crash the server with a stack trace', { timeout: 15000 }, async (t) => {
  const { connector } = await rig(t);
  connector.child.stdout.destroy();
  connector.callAsync('cua_alans_way_tabs');
  const exit = await Promise.race([connector.exited, new Promise((resolve) => setTimeout(() => resolve(null), 4000))]);
  assert.ok(exit, 'the connector exits');
  assert.doesNotMatch(connector.state.stderr, /EPIPE\n\s+at /);
  assert.equal(exit.code, 0);
});

