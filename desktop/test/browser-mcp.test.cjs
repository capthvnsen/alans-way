const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

test('browser MCP exposes close and reports non-JSON host errors cleanly', { timeout: 8000 }, async (t) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-browser-mcp-'));
  const bad = http.createServer((_req, res) => { res.writeHead(502, { 'Content-Type': 'text/plain' }); res.end('upstream timeout from proxy'); });
  await new Promise((resolve) => bad.listen(0, '127.0.0.1', resolve));
  const connection = { url: `http://127.0.0.1:${bad.address().port}`, token: 'fixture-token', protocol: 1 };
  fs.writeFileSync(path.join(profile, 'connection.json'), JSON.stringify(connection));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, '../scripts/browser-mcp.cjs'), '--bot-id', 'mcp-test', '--connection', path.join(profile, 'connection.json')],
    env: { ...process.env },
  });
  const client = new Client({ name: 'browser-mcp-test', version: '1' });
  t.after(async () => {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    await new Promise((resolve) => bad.close(resolve));
    fs.rmSync(profile, { recursive: true, force: true });
  });
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map((tool) => tool.name);
  assert.deepEqual(tools, [
    'cua_alans_way_status', 'cua_alans_way_tabs', 'cua_alans_way_open',
    'cua_alans_way_snapshot', 'cua_alans_way_screenshot', 'cua_alans_way_close',
    'workspace_computer_apps', 'workspace_computer_snapshot', 'workspace_computer_screenshot', 'workspace_computer_menu', 'workspace_computer_action',
    'cua_alans_way_action',
  ]);
  const result = await client.callTool({ name: 'cua_alans_way_status', arguments: {} });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Browser request failed \(502\).*upstream timeout from proxy/);
});

test('open rejects an unrecognized host instead of dropping it', { timeout: 8000 }, async (t) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-browser-mcp-'));
  const seen = [];
  const host = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    seen.push({ line: req.method + ' ' + req.url, body: raw ? JSON.parse(raw) : undefined });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"id":"t1"}');
  });
  await new Promise((resolve) => host.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(path.join(profile, 'connection.json'), JSON.stringify({ url: `http://127.0.0.1:${host.address().port}`, token: 'fixture-token', protocol: 1 }));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, '../scripts/browser-mcp.cjs'), '--bot-id', 'mcp-test', '--connection', path.join(profile, 'connection.json')],
    env: { ...process.env },
  });
  const client = new Client({ name: 'browser-mcp-test', version: '1' });
  t.after(async () => {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    await new Promise((resolve) => host.close(resolve));
    fs.rmSync(profile, { recursive: true, force: true });
  });
  await client.connect(transport);
  const open = (args) => client.callTool({ name: 'cua_alans_way_open', arguments: { url: 'https://x.example/', ...args } });
  const bad = await open({ host: 'remote-vm' });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /Use host "computer" or "vm", or omit it\./);
  assert.equal((await open({ host: 'vm' })).isError, undefined);
  assert.equal((await open({ host: 'computer' })).isError, undefined);
  assert.equal((await open({})).isError, undefined, 'an omitted host still works');
  assert.deepEqual(seen.filter((s) => s.line === 'POST /v1/tabs').map((s) => s.body.host), ['vps', 'local', undefined],
    'the bad host never reached the app');
});

test('browser tool results omit favicon images', { timeout: 8000 }, async (t) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-browser-mcp-'));
  const icon = 'data:image/png;base64,' + 'A'.repeat(5000);
  const host = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ tabs: [{ id: 't', title: 'Inbox', url: 'https://a.example/', epoch: 3, favicon: icon }] }));
  });
  await new Promise((resolve) => host.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(path.join(profile, 'connection.json'), JSON.stringify({ url: `http://127.0.0.1:${host.address().port}`, token: 'fixture-token', protocol: 1 }));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, '../scripts/browser-mcp.cjs'), '--bot-id', 'mcp-test', '--connection', path.join(profile, 'connection.json')],
    env: { ...process.env },
  });
  const client = new Client({ name: 'browser-mcp-test', version: '1' });
  t.after(async () => {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    await new Promise((resolve) => host.close(resolve));
    fs.rmSync(profile, { recursive: true, force: true });
  });
  await client.connect(transport);
  const result = await client.callTool({ name: 'cua_alans_way_tabs', arguments: {} });
  const text = result.content[0].text;
  assert.equal(result.isError, undefined);
  assert.doesNotMatch(text, /favicon|data:image/);
  assert.match(text, /Inbox/);
  assert.match(text, /"epoch":3/);
});

test('a --tab-map retargets each missing Mac tab onto its own VM tab', { timeout: 8000 }, async (t) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-browser-mcp-'));
  const seen = [];
  const host = http.createServer((req, res) => {
    seen.push(req.method + ' ' + req.url);
    const known = /^\/v1\/tabs\/(vm-1|vm-2)\//.test(req.url);
    res.writeHead(known ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(known ? { url: 'https://vm.example/', elements: [] } : { error: 'Tab not found.' }));
  });
  await new Promise((resolve) => host.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(path.join(profile, 'connection.json'), JSON.stringify({ url: `http://127.0.0.1:${host.address().port}`, token: 'fixture-token', protocol: 1 }));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, '../scripts/browser-mcp.cjs'), '--bot-id', 'mcp-test', '--connection', path.join(profile, 'connection.json'),
      '--tab-map', JSON.stringify({ 'mac-a': 'vm-1', 'mac-b': 'vm-2', 'bad id': 'vm-3', 'mac-c': '../x' })],
    env: { ...process.env },
  });
  const client = new Client({ name: 'browser-mcp-test', version: '1' });
  t.after(async () => {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    await new Promise((resolve) => host.close(resolve));
    fs.rmSync(profile, { recursive: true, force: true });
  });
  await client.connect(transport);
  const snapshot = (tabId) => client.callTool({ name: 'cua_alans_way_snapshot', arguments: { tabId } });
  assert.match((await snapshot('mac-a')).content[0].text, /"continuedTab":"vm-1"/);
  assert.match((await snapshot('mac-b')).content[0].text, /"continuedTab":"vm-2"/);
  const unmapped = await snapshot('mac-z');
  assert.equal(unmapped.isError, true, 'an id outside the map is not sent to another tab');
  assert.ok(!seen.some((line) => /vm-3|\.\.|bad/.test(line)));
  assert.equal((await snapshot('mac-c')).isError, true, 'malformed map entries are dropped');
  assert.match(unmapped.content[0].text, /vm-1.*vm-2|mac-a/);
});

async function statusFromLinuxConnection(t, configure) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-linux-home-'));
  const host = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ name: 'linux-host-marker' })); });
  await new Promise((resolve) => host.listen(0, '127.0.0.1', resolve));
  const env = { ...process.env, HOME: home };
  delete env.HERMES_WORKSPACE_CONNECTION;
  delete env.XDG_CONFIG_HOME;
  const base = configure({ home, env });
  fs.mkdirSync(path.join(base, 'Hermes Workspace'), { recursive: true });
  fs.writeFileSync(path.join(base, 'Hermes Workspace', 'connection.json'), JSON.stringify({ url: `http://127.0.0.1:${host.address().port}`, token: 'fixture-token', protocol: 1 }));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['-r', path.join(__dirname, 'fake-linux-platform.cjs'), path.join(__dirname, '../scripts/browser-mcp.cjs'), '--bot-id', 'mcp-test'],
    env,
  });
  const client = new Client({ name: 'browser-mcp-test', version: '1' });
  t.after(async () => {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    await new Promise((resolve) => host.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  });
  await client.connect(transport);
  return (await client.callTool({ name: 'cua_alans_way_status', arguments: {} })).content[0].text;
}

test('a Linux connector finds the app connection file under ~/.config', { timeout: 8000 }, async (t) => {
  const text = await statusFromLinuxConnection(t, ({ home }) => path.join(home, '.config'));
  assert.match(text, /linux-host-marker/);
});

test('a Linux connector honours XDG_CONFIG_HOME', { timeout: 8000 }, async (t) => {
  const text = await statusFromLinuxConnection(t, ({ home, env }) => {
    env.XDG_CONFIG_HOME = path.join(home, 'xdg');
    return env.XDG_CONFIG_HOME;
  });
  assert.match(text, /linux-host-marker/);
});

test('browser MCP exposes select, double click, right click and drag, and forwards their fields', { timeout: 8000 }, async (t) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-browser-mcp-'));
  let received;
  const host = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    received = JSON.parse(raw);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"dispatched":true}');
  });
  await new Promise((resolve) => host.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(path.join(profile, 'connection.json'), JSON.stringify({ url: `http://127.0.0.1:${host.address().port}`, token: 'fixture-token', protocol: 1 }));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, '../scripts/browser-mcp.cjs'), '--bot-id', 'mcp-test', '--connection', path.join(profile, 'connection.json')],
    env: { ...process.env },
  });
  const client = new Client({ name: 'browser-mcp-test', version: '1' });
  t.after(async () => {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    await new Promise((resolve) => host.close(resolve));
    fs.rmSync(profile, { recursive: true, force: true });
  });
  await client.connect(transport);
  const action = (await client.listTools()).tools.find((tool) => tool.name === 'cua_alans_way_action').inputSchema.properties;
  for (const name of ['double_click', 'right_click', 'drag', 'select']) assert.ok(action.action.enum.includes(name), name);
  for (const field of ['toRef', 'toSelector', 'toX', 'toY', 'value', 'label']) assert.ok(action[field], field);
  const result = await client.callTool({ name: 'cua_alans_way_action', arguments: { tabId: 't', epoch: 2, action: 'drag', ref: 's1-1', toRef: 's1-2' } });
  assert.equal(result.isError, undefined);
  assert.deepEqual(received, { epoch: 2, action: 'drag', ref: 's1-1', toRef: 's1-2' });
});

async function computerHost(t, capabilities) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-browser-mcp-'));
  const seen = [];
  const host = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    seen.push({ line: req.method + ' ' + req.url, bot: req.headers['x-hermes-bot'], body: raw ? JSON.parse(raw) : undefined });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(req.url === '/v1/status' ? JSON.stringify({ capabilities })
      : req.url === '/v1/computer/apps' ? JSON.stringify({ apps: [{ pid: 7, name: 'app-api-marker' }] })
      : req.url.includes('/screenshot') ? JSON.stringify({ image: 'AAAA', imageWidth: 1, imageHeight: 1, windowX: 0, windowY: 0, windowWidth: 1, windowHeight: 1 })
      : JSON.stringify({ generation: 4, via: 'app-api-marker' }));
  });
  await new Promise((resolve) => host.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(path.join(profile, 'connection.json'), JSON.stringify({ url: `http://127.0.0.1:${host.address().port}`, token: 'fixture-token', protocol: 1 }));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['-r', path.join(__dirname, 'fake-computer-service.cjs'), path.join(__dirname, '../scripts/browser-mcp.cjs'), '--bot-id', 'mcp-test', '--connection', path.join(profile, 'connection.json')],
    env: { ...process.env },
  });
  const client = new Client({ name: 'browser-mcp-test', version: '1' });
  t.after(async () => {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    await new Promise((resolve) => host.close(resolve));
    fs.rmSync(profile, { recursive: true, force: true });
  });
  await client.connect(transport);
  return { client, seen };
}

test('computer tools go through the app API when the connected app advertises computer use', { timeout: 8000 }, async (t) => {
  const { client, seen } = await computerHost(t, ['computer', 'computer-v2', 'tabs']);
  const call = async (name, args) => (await client.callTool({ name, arguments: args })).content[0].text;
  assert.match(await call('workspace_computer_apps', {}), /app-api-marker/);
  assert.match(await call('workspace_computer_snapshot', { pid: 7, since: 3, menubar: true }), /app-api-marker/);
  assert.match(await call('workspace_computer_menu', { pid: 7, path: ['File'] }), /app-api-marker/);
  assert.match(await call('workspace_computer_action', { pid: 7, action: 'batch', generation: 4, menubar: true, steps: [{ action: 'press', ref: 'a1' }] }), /app-api-marker/);
  const shot = await client.callTool({ name: 'workspace_computer_screenshot', arguments: { pid: 7, maxWidth: 640 } });
  assert.equal(shot.isError, undefined);
  const lines = seen.map((entry) => entry.line);
  assert.deepEqual(lines.filter((line) => line !== 'GET /v1/status'), [
    'GET /v1/computer/apps',
    'GET /v1/computer/7/snapshot?since=3&menubar=1',
    'GET /v1/computer/7/menu?path=%5B%22File%22%5D',
    'POST /v1/computer/7/action',
    'GET /v1/computer/7/screenshot?maxWidth=640',
  ]);
  assert.equal(lines.filter((line) => line === 'GET /v1/status').length, 1, 'the decision is cached');
  assert.deepEqual(seen.find((entry) => entry.line === 'POST /v1/computer/7/action').body, { action: 'batch', generation: 4, menubar: true, steps: [{ action: 'press', ref: 'a1' }] });
  assert.ok(seen.every((entry) => entry.bot === 'mcp-test'));
});

test('computer tools use the in-process driver when the connected host has no computer endpoint', { timeout: 8000 }, async (t) => {
  const { client, seen } = await computerHost(t, ['tabs', 'snapshot']);
  const text = (await client.callTool({ name: 'workspace_computer_apps', arguments: {} })).content[0].text;
  assert.match(text, /in-process-marker/);
  assert.doesNotMatch(text, /app-api-marker/);
  assert.match((await client.callTool({ name: 'workspace_computer_action', arguments: { pid: 1, action: 'press', ref: 'a', generation: 1 } })).content[0].text, /in-process-marker/);
  assert.ok(seen.every((entry) => !entry.line.startsWith('GET /v1/computer') && !entry.line.startsWith('POST /v1/computer')));
});
