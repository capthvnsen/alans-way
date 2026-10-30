const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

for (const capable of [false, true]) test(`approved MCP dispatch requires positive host capability (${capable})`, async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-mcp-'));
  const requests = [];
  let missing = false, advertised = capable;
  const host = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    requests.push({ path: req.url, method: req.method, body: raw ? JSON.parse(raw) : null });
    let status = 200, result;
    if (req.url === '/v1/status') result = { capabilities: advertised ? ['approval-binding-v1'] : ['tabs'] };
    else if (req.url.includes('/snapshot')) result = { approvalContext: { version: 1, documentId: 'a'.repeat(32), url: 'https://fixture.example/' }, elements: [{ ref: 'e1', approvalTarget: 'b'.repeat(32) }] };
    else if (missing && req.method === 'POST') { status = 404; result = { error: 'Tab not found.' }; }
    else result = { dispatched: true };
    res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result));
  });
  await new Promise(resolve => host.listen(0, '127.0.0.1', resolve));
  const connection = path.join(temp, 'connection.json');
  fs.writeFileSync(connection, JSON.stringify({ url: `http://127.0.0.1:${host.address().port}`, token: 'fixture', botId: 'fixture' }));
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(__dirname, '../scripts/browser-mcp.cjs'), '--bot-id', 'fixture', '--connection', connection, '--tab-map', '{"old":"next"}'] });
  const client = new Client({ name: 'approval-contract', version: '1' });
  t.after(async () => {
    await client.close(); await transport.close(); host.closeAllConnections(); await new Promise(resolve => host.close(resolve)); fs.rmSync(temp, { recursive: true, force: true });
  });
  await client.connect(transport);
  const call = (name, args) => client.callTool({ name, arguments: args });
  const snapshot = JSON.parse((await call('cua_alans_way_snapshot', { tabId: 'old' })).content[0].text);
  assert.equal(!!snapshot.approvalContext, capable, 'a snapshot cannot claim proof that the host ignores');
  assert.equal(!!snapshot.elements[0].approvalTarget, capable);
  const approval = { nonce: 'fixture-receipt', binding: { version: 1 } };
  const args = { tabId: 'old', epoch: 1, action: 'click', ref: 'e1', approval };
  let start = requests.length;
  const response = await call('cua_alans_way_action', args);
  if (!capable) {
    assert.equal(response.isError, true); assert.match(response.content[0].text, /approval_binding_unavailable.*update.*fresh snapshot/i);
    assert.equal(requests.slice(start).filter(r => r.method === 'POST').length, 0, 'old hosts never receive a receipt they would ignore');
  } else {
    assert.equal(response.isError, undefined);
    assert.deepEqual(requests.at(-1).body.approval, approval, 'binding crosses the public interface intact');
    missing = true; start = requests.length;
    const continued = await call('cua_alans_way_action', args);
    assert.equal(continued.isError, true); assert.match(continued.content[0].text, /approved actions cannot continue.*fresh snapshot.*new approval/i);
    assert.deepEqual(requests.slice(start).map(r => `${r.method} ${r.path}`), ['GET /v1/status', 'POST /v1/tabs/old/actions'], 'an approved receipt is never transplanted to a continued tab');
    missing = false;
    advertised = false; start = requests.length;
    const downgraded = await call('cua_alans_way_action', args);
    assert.equal(downgraded.isError, true, 'an old backend cannot inherit cached capability at the same connection address');
    assert.match(downgraded.content[0].text, /approval_binding_unavailable/);
    assert.equal(requests.slice(start).filter(r => r.method === 'POST').length, 0);
  }
  const ordinary = await call('cua_alans_way_action', { tabId: 'old', epoch: 1, action: 'click', ref: 'e1' });
  assert.equal(ordinary.isError, undefined, 'ordinary supported operations remain usable');
});
