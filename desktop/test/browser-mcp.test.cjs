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
    'workspace_computer_apps', 'workspace_computer_snapshot', 'workspace_computer_screenshot', 'workspace_computer_action',
    'cua_alans_way_action',
  ]);
  const result = await client.callTool({ name: 'cua_alans_way_status', arguments: {} });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Browser request failed \(502\).*upstream timeout from proxy/);
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
