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
    'workspace_browser_status', 'workspace_browser_tabs', 'workspace_browser_open',
    'workspace_browser_snapshot', 'workspace_browser_screenshot', 'workspace_browser_close', 'workspace_browser_action',
  ]);
  const result = await client.callTool({ name: 'workspace_browser_status', arguments: {} });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Browser request failed \(502\).*upstream timeout from proxy/);
});
