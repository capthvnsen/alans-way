// A remote agent's path end to end with local fakes: an MCP client (standing in
// for Grok Bot or any connector client) -> optionally the VM router ->
// browser-mcp.cjs -> the app's real /v1/computer routes, lease and approval
// gate -> a fake desktop driver. No VM, SSH or Mac helper is involved.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { createDesktopApproval } = require('../src/desktop-approval.cjs');
const { computerRoutes } = require('./computer-routes-fixture.cjs');

const connector = path.join(__dirname, '../scripts/browser-mcp.cjs');

async function fakeApp(t, { answers = [], driver = {} } = {}) {
  const asked = [];
  const approval = createDesktopApproval({
    trusted: (id) => id === 'hermes',
    ask: async (name) => { asked.push(name); return answers.shift() ?? null; },
  });
  const { route, seen } = computerRoutes(driver, { approval });
  const host = http.createServer(async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.headers.authorization !== 'Bearer fixture') return send(401, { error: 'Unauthorized' });
    if (req.url === '/v1/status')
      return send(200, { host: 'mac', hosts: { mac: 'connected' }, capabilities: ['computer', 'computer-v2', 'computer-window-v1', 'computer-launch-v1', 'tabs'] });
    if (!req.url.startsWith('/v1/computer/')) return send(404, { error: 'Tab not found.' });
    let raw = '';
    for await (const chunk of req) raw += chunk;
    try {
      const { status, body } = await route({ url: req.url, method: req.method, headers: req.headers, body: raw ? JSON.parse(raw) : {} }, res);
      send(status, body);
    } catch (error) { send(400, { error: error.message, ...(error.code ? { code: error.code } : {}) }); }
  });
  await new Promise(resolve => host.listen(0, '127.0.0.1', resolve));
  t.after(() => host.close());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-agent-e2e-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const connection = path.join(dir, 'connection.json');
  fs.writeFileSync(connection, JSON.stringify({ url: `http://127.0.0.1:${host.address().port}`, token: 'fixture' }));
  return { asked, seen, connection, dir };
}

async function connect(t, command, args, env = {}) {
  const transport = new StdioClientTransport({ command, args, env: { ...process.env, ...env }, stderr: 'ignore' });
  const client = new Client({ name: 'remote-agent-e2e', version: '1.0.0' });
  await client.connect(transport);
  t.after(() => client.close());
  const call = async (name, args = {}) => {
    const reply = await client.callTool({ name, arguments: args });
    return { error: reply.isError === true, text: reply.content.map(item => item.text || '').join('\n') };
  };
  return { client, call };
}

const direct = (t, app, botId, botName) => connect(t, process.execPath,
  [connector, '--bot-id', botId, ...(botName ? ['--bot-name', botName] : [])], { HERMES_WORKSPACE_CONNECTION: app.connection });

test('a raw connector client sees client-neutral tools that advertise expect_host', { timeout: 15000 }, async t => {
  const app = await fakeApp(t);
  const { client } = await direct(t, app, 'grok', 'Grok Bot');
  const { tools } = await client.listTools();
  const byName = Object.fromEntries(tools.map(tool => [tool.name, tool]));
  for (const name of ['workspace_computer_launch', 'workspace_computer_action'])
    assert.deepEqual(byName[name].inputSchema.properties.expect_host.enum, ['computer', 'vm']);
  for (const tool of tools) assert.doesNotMatch(tool.description, /Telegram|MEDIA:|Hermes delivers/, tool.name);
  assert.match(byName.cua_alans_way_recordings.description, /If your client has skill tools/);
});

test('desktop input waits for the user to allow the agent, and an unanswered prompt sends nothing', { timeout: 15000 }, async t => {
  const app = await fakeApp(t, { answers: [null, true] });
  const { call } = await direct(t, app, 'grok', 'Grok Bot');
  const first = await call('workspace_computer_action', { pid: 7, action: 'key', key: 'return' });
  assert.equal(first.error, true);
  assert.match(first.text, /^desktop_approval_required: /);
  assert.match(first.text, /Allow/);
  assert.match(first.text, /Nothing was sent/);
  assert.deepEqual(app.seen, []);
  assert.equal((await call('workspace_computer_apps')).error, false, 'reads need no approval');
  const second = await call('workspace_computer_action', { pid: 7, action: 'key', key: 'return' });
  assert.equal(second.error, false, second.text);
  assert.equal((await call('workspace_computer_launch', { app: 'Calculator' })).error, false);
  assert.deepEqual(app.asked, ['Grok Bot', 'Grok Bot'], 'one grant covers later input');
  assert.deepEqual(app.seen, ['apps', 'action', 'launch']);
});

test('a declined agent is told not to retry', { timeout: 15000 }, async t => {
  const app = await fakeApp(t, { answers: [false] });
  const { call } = await direct(t, app, 'grok', 'Grok Bot');
  const reply = await call('workspace_computer_launch', { app: 'Calculator' });
  assert.equal(reply.error, true);
  assert.match(reply.text, /^desktop_approval_denied: .*Do not retry/);
});

test('a second agent gets desktop_busy with the holder name and what to do next', { timeout: 15000 }, async t => {
  const app = await fakeApp(t, { answers: [true] });
  const grok = await direct(t, app, 'grok', 'Grok Bot');
  const hermes = await direct(t, app, 'hermes');
  assert.equal((await grok.call('workspace_computer_action', { pid: 7, action: 'key', key: 'a' })).error, false);
  const busy = await hermes.call('workspace_computer_action', { pid: 7, action: 'key', key: 'b' });
  assert.equal(busy.error, true);
  assert.match(busy.text, /^desktop_busy: The Mac is being used by Grok Bot; try again in 20 s\./);
  assert.match(busy.text, /fresh workspace_computer_snapshot/);
  assert.equal((await hermes.call('workspace_computer_apps')).error, false, 'reads stay open');
});

test('desktop driver errors carry recovery guidance', { timeout: 15000 }, async t => {
  const app = await fakeApp(t, { answers: [true], driver: { action: async () => { throw Object.assign(new Error('Calculator is in front and the user is typing.'), { code: 'in_front' }); } } });
  const { call } = await direct(t, app, 'grok', 'Grok Bot');
  const reply = await call('workspace_computer_action', { pid: 7, action: 'key', key: 'a' });
  assert.equal(reply.error, true);
  assert.match(reply.text, /^Calculator is in front and the user is typing\. The user is using this app right now: wait a few seconds and retry once/);
});

// The router lives in the alans-way-agents repo. Point ALANS_WAY_ROUTER at its
// workspace-router.cjs to run the same path through it: with no Mac SSH
// configured it serves this connector locally, as on a VM.
const router = process.env.ALANS_WAY_ROUTER;
test('through the VM router: approval, host binding and guidance reach the client', { timeout: 30000, skip: router ? false : 'set ALANS_WAY_ROUTER to workspace-router.cjs' }, async t => {
  const app = await fakeApp(t, { answers: [null, true] });
  const { client, call } = await connect(t, process.execPath,
    [router, '--bot-id', 'grok', '--bot-name', 'Grok Bot', '--vps-script', connector, '--vps-connection', app.connection],
    { HERMES_WORKSPACE_ALLOW_DESKTOP_ACTIONS: '1', HERMES_MAC_STATE_FILE: path.join(app.dir, 'mac-state.json'), HERMES_WORKSPACE_MAC_SSH: '' });
  const { tools } = await client.listTools();
  assert.ok(tools.some(tool => tool.name === 'workspace_computer_action'), 'desktop input is exposed when the operator allows it');
  const refused = await call('workspace_computer_action', { pid: 7, action: 'key', key: 'a' });
  assert.match(refused.text, /desktop_approval_required: .*Allow/);
  const mismatch = await call('workspace_computer_action', { pid: 7, action: 'key', key: 'a', expect_host: 'computer' });
  assert.equal(mismatch.error, true, 'the router refuses input meant for another host');
  assert.deepEqual(app.seen, []);
  const ok = await call('workspace_computer_action', { pid: 7, action: 'key', key: 'a', expect_host: 'vm' });
  assert.equal(ok.error, false, ok.text);
  assert.deepEqual(app.seen, ['action']);
});
