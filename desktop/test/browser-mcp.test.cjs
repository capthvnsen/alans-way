const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { calls, context, remainingMs, checkCall, READ_BUDGET_MS } = require('../src/call-budget.cjs');
const { performance } = require('node:perf_hooks');
const { createMacPermissionHelp } = require('../src/mac-permissions.cjs');

function connectorRequest(fetch) {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/browser-mcp.cjs'), 'utf8');
  return require('node:vm').runInNewContext(source.slice(source.indexOf('const connectionKey ='), source.indexOf('let hostCaps =')) + '\nrequestOnce;', {
    fs: { readFileSync: () => JSON.stringify({ url: 'http://127.0.0.1:9', token: 'fixture' }) },
    file: 'fixture', botId: 'fixture', botName: '', URL, fetch, calls, remainingMs, checkCall, READ_BUDGET_MS,
    AbortSignal: { timeout: (ms) => ({ deadline: Date.now() + ms }) },
  });
}

test('tools/list has a short protocol TTL while status and authentication stay live', { timeout: 8000 }, async (t) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-schema-cache-'));
  const connection = path.join(profile, 'connection.json');
  const seen = [];
  let online = true;
  const host = http.createServer((req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization });
    res.writeHead(online ? 200 : 401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(online ? { host: 'mac' } : { error: 'unauthorized' }));
  });
  await new Promise(resolve => host.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(connection, JSON.stringify({ url: `http://127.0.0.1:${host.address().port}`, token: 'fixture' }));
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.join(__dirname, '../scripts/browser-mcp.cjs'), '--bot-id', 'fixture', '--connection', connection] });
  const client = new Client({ name: 'schema-cache-regression', version: '1' });
  t.after(async () => {
    await client.close().catch(() => {}); await transport.close().catch(() => {});
    await new Promise(resolve => host.close(resolve)); fs.rmSync(profile, { recursive: true, force: true });
  });
  await client.connect(transport);
  const manifest = await client.listTools();
  assert.equal(manifest.ttlMs, 60_000);
  assert.equal(manifest._meta?.ttlMs, undefined);
  assert.ok(manifest.tools.length > 0);
  assert.deepEqual(seen, [], 'schema discovery does not probe or authenticate the host');
  const first = await client.callTool({ name: 'cua_alans_way_status', arguments: {} });
  assert.deepEqual(JSON.parse(first.content[0].text), { host: 'mac' });
  assert.equal(first.ttlMs, undefined);
  online = false;
  const second = await client.callTool({ name: 'cua_alans_way_status', arguments: {} });
  assert.equal(second.isError, true);
  assert.match(second.content[0].text, /unauthorized/);
  assert.equal(second.ttlMs, undefined);
  assert.deepEqual(seen, [
    { url: '/v1/status', authorization: 'Bearer fixture' },
    { url: '/v1/status', authorization: 'Bearer fixture' },
  ]);
});

for (const change of ['app version', 'desktop tool set']) test(`${change} changes expire from the schema cache within one minute`, async () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/browser-mcp.cjs'), 'utf8');
  let listTools;
  const tools = [{ name: 'workspace_computer_action' }];
  const sandbox = {
    Server: class { setRequestHandler(_schema, handler) { listTools = handler; } }, ListToolsRequestSchema: {}, tools,
  };
  require('node:vm').runInNewContext(source.slice(source.indexOf('const server = new Server('), source.indexOf('server.setRequestHandler(CallToolRequestSchema')), sandbox);
  const manifest = await listTools();
  const cached = { tools: manifest.tools, ttl_ms: manifest.ttlMs, written_at: 1000 };
  sandbox.tools = change === 'app version' ? [{ name: 'workspace_computer_action', description: 'Updated app schema' }] : [];
  // Hermes mcp_schema_cache.py:68-72 checks age only, not version or env.
  const read = now => (now - cached.written_at) * 1000 >= cached.ttl_ms ? null : cached;
  assert.equal(read(1000), cached, 'a positive TTL allows lazy startup');
  assert.equal(read(1059.999), cached, 'changes can remain stale until expiry');
  assert.equal(read(1060), null, 'the next discovery must fetch the updated manifest');
  const current = read(1060) || await listTools();
  assert.equal(current.tools, sandbox.tools);
  assert.ok(Number.isInteger(manifest.ttlMs) && manifest.ttlMs > 0 && manifest.ttlMs <= 60_000);
});

test('open optionally includes a bounded snapshot and keeps its tab receipt when the read fails', { timeout: 10000 }, async (t) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-open-observation-'));
  const seen = [];
  let failRead = false, proofSupported = true;
  const observation = { generation: 2, loading: true, text: 'Choose a country', elements: [{ ref: 'e1', role: 'select', name: 'Country', approvalTarget: { nodeId: 'fixture' } }], approvalContext: { version: 1, documentId: 'fixture' } };
  const host = http.createServer(async (req, res) => {
    for await (const _ of req) { /* consume the fixture open */ }
    seen.push(req.method + ' ' + req.url);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/status') return res.end(JSON.stringify({ capabilities: proofSupported ? ['approval-binding-v1'] : [] }));
    if (req.method === 'POST') return res.end(JSON.stringify({ id: 'fixture', epoch: 7, controller: 'agent', host: 'vm' }));
    if (failRead) { res.statusCode = 409; return res.end(JSON.stringify({ error: 'awaiting_human: inspect current control' })); }
    res.end(JSON.stringify(observation));
  });
  await new Promise(resolve => host.listen(0, '127.0.0.1', resolve));
  const connection = path.join(profile, 'connection.json');
  fs.writeFileSync(connection, JSON.stringify({ url: `http://127.0.0.1:${host.address().port}`, token: 'fixture' }));
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.join(__dirname, '../scripts/browser-mcp.cjs'), '--bot-id', 'fixture', '--connection', connection] });
  const client = new Client({ name: 'open-observation-regression', version: '1' });
  t.after(async () => {
    await client.close().catch(() => {}); await transport.close().catch(() => {});
    await new Promise(resolve => host.close(resolve)); fs.rmSync(profile, { recursive: true, force: true });
  });
  await client.connect(transport);
  const open = async snapshot => {
    const reply = await client.callTool({ name: 'cua_alans_way_open', arguments: { url: 'https://example.com', ...(snapshot === undefined ? {} : { snapshot }) } });
    assert.ok(!reply.isError, JSON.stringify(reply));
    return JSON.parse(reply.content[0].text);
  };
  assert.equal((await open()).observation, undefined);
  assert.equal(seen.filter(x => x.includes('/snapshot')).length, 0);
  const reply = await open(true);
  assert.equal(reply.id, 'fixture'); assert.equal(reply.epoch, 7); assert.equal(reply.host, 'vm');
  assert.deepEqual(reply.observation, observation);
  assert.ok(seen.includes('GET /v1/tabs/fixture/snapshot?maxChars=2000'));
  failRead = true;
  const failed = await open(true);
  assert.equal(failed.id, 'fixture'); assert.equal(failed.epoch, 7);
  assert.equal(failed.observation, undefined);
  assert.match(failed.observationError, /awaiting_human/);
  assert.equal(seen.filter(x => x === 'POST /v1/tabs').length, 3, 'a failed observation never opens another tab');
  proofSupported = false; failRead = false;
  // A fresh connector must apply the same old-host proof filtering to open as to snapshot.
  await client.close(); await transport.close();
  const oldTransport = new StdioClientTransport({ command: process.execPath,
    args: [path.join(__dirname, '../scripts/browser-mcp.cjs'), '--bot-id', 'fixture', '--connection', connection] });
  const oldClient = new Client({ name: 'old-host-observation-regression', version: '1' });
  t.after(async () => { await oldClient.close().catch(() => {}); await oldTransport.close().catch(() => {}); });
  await oldClient.connect(oldTransport);
  const oldReply = JSON.parse((await oldClient.callTool({ name: 'cua_alans_way_open', arguments: { url: 'https://example.com', snapshot: true } })).content[0].text);
  assert.equal(oldReply.observation.approvalContext, undefined);
  assert.equal(oldReply.observation.elements[0].approvalTarget, undefined);
});

for (const [verb, firstMs, grantedAt, retryMs, completedAt, batch = true] of [
  ['snapshot', 1000, 34000, 40000, 74000],
  ['snapshot', 19000, 34999, 39998, 74998],
  ['action', 1000, 3000, 85150, 88150],
  ['action', 3000, 3999, 85150, 89150],
  ['action', 1000, 3999, 55150, 59150, false],
]) test(`a late grant returns the ${verb === 'action' && batch ? 'batch' : verb} retry before the caller abort (${firstMs} ms first refusal)`, async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  t.mock.method(performance, 'now', () => Date.now());
  let calls = 0;
  let callerDeadline;
  const result = verb === 'action' ? { results: [{ ok: true }] } : { generation: 1, elements: [] };
  const help = createMacPermissionHelp({
    platform: 'darwin',
    systemPreferences: { isTrustedAccessibilityClient: () => Date.now() >= grantedAt },
    sleep: async (ms) => t.mock.timers.tick(ms),
  });
  const service = help.wrap({ [verb]: async () => {
    calls++;
    t.mock.timers.tick(calls === 1 ? firstMs : retryMs);
    if (calls === 1) throw Object.assign(new Error('Accessibility is off.'), { code: 'permission' });
    return result;
  } });
  const request = connectorRequest(async (_url, { signal }) => {
    callerDeadline = signal.deadline;
    const reply = await service[verb]('bot', 7, batch ? { action: 'batch', steps: [] } : { action: 'wait', text: 'Done' });
    if (Date.now() >= callerDeadline) throw new Error('caller timed out');
    return { ok: true, status: 200, text: async () => JSON.stringify(reply) };
  });
  const reply = await request(`/v1/computer/7/${verb}`, verb === 'action' ? 'POST' : 'GET');
  assert.equal(JSON.stringify(reply), JSON.stringify(result));
  assert.equal(calls, 2);
  assert.equal(Date.now(), completedAt);
  assert.equal(callerDeadline, verb === 'action' ? 90000 : 75000);
  assert.ok(Date.now() < callerDeadline);
  assert.ok(Date.now() < (verb === 'action' && batch ? 100000 : 80000), 'the router must receive the result before its ordinary/batch deadline');
});

test('only computer reads gain a longer abort; browser tab deadlines stay the same', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  t.mock.method(performance, 'now', () => Date.now());
  const deadlines = [];
  const request = connectorRequest(async (_url, { signal }) => {
    deadlines.push(signal.deadline - Date.now());
    return { ok: true, status: 200, text: async () => '{"dispatched":true}' };
  });
  for (const endpoint of ['/v1/computer/apps', '/v1/computer/7/snapshot?since=1', '/v1/computer/7/screenshot', '/v1/computer/7/menu', '/v1/computer/7/action', '/v1/tabs', '/v1/tabs/7/snapshot', '/v1/tabs/7/actions']) {
    await request(endpoint, /\/actions?$/.test(endpoint) ? 'POST' : 'GET');
  }
  assert.deepEqual(deadlines, [75000, 75000, 75000, 75000, 90000, 25000, 25000, 90000]);
});

test('capability reads and later fetches consume one budget, and expired actions never dispatch', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  t.mock.method(performance, 'now', () => Date.now());
  const deadlines = [], budgets = [];
  const request = connectorRequest(async (_url, { signal, headers }) => {
    deadlines.push(signal.deadline);
    budgets.push(Number(headers['X-Alans-Way-Remaining-Ms']));
    t.mock.timers.tick(deadlines.length === 1 ? 30 : 70);
    return { ok: true, status: 200, text: async () => '{}' };
  });
  await calls.run(context(100), async () => {
    await request('/v1/status');
    await request('/v1/computer/7/snapshot');
    await assert.rejects(request('/v1/computer/7/action', 'POST', { action: 'click' }), /timed out/);
  });
  assert.deepEqual(deadlines, [100, 100]);
  assert.deepEqual(budgets, [100, 70]);
});

for (const computer of [false, true]) for (const stop of ['deadline', 'cancel']) test(`MCP ${stop} aborts an in-flight ${computer ? 'computer' : 'browser'} fetch without replaying an action`, { timeout: 8000 }, async (t) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-call-budget-'));
  const connection = path.join(profile, 'connection.json');
  const seen = [];
  let entered, disconnected;
  const started = new Promise(resolve => { entered = resolve; });
  const closed = new Promise(resolve => { disconnected = resolve; });
  const host = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume fixture input */ }
    if (req.url === '/v1/status') return res.end(JSON.stringify({ capabilities: ['computer'] }));
    seen.push({ path: req.url, budget: Number(req.headers['x-alans-way-remaining-ms']) });
    res.on('close', disconnected);
    entered();
  });
  await new Promise(resolve => host.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(connection, JSON.stringify({ url: `http://127.0.0.1:${host.address().port}`, token: 'fixture' }));
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.join(__dirname, '../scripts/browser-mcp.cjs'), '--bot-id', 'fixture', '--connection', connection] });
  const client = new Client({ name: 'call-budget-test', version: '1' });
  t.after(async () => {
    await client.close().catch(() => {}); await transport.close().catch(() => {});
    host.closeAllConnections(); await new Promise(resolve => host.close(resolve));
    fs.rmSync(profile, { recursive: true, force: true });
  });
  await client.connect(transport);
  const controller = new AbortController();
  const result = client.callTool({ name: computer ? 'workspace_computer_action' : 'cua_alans_way_action',
    arguments: computer ? { pid: 7, action: 'click', x: 1, y: 2 } : { tabId: 'fixture', epoch: 1, action: 'read' },
    _meta: { 'alans-way/remainingMs': stop === 'deadline' ? 500 : 5000, 'future/ignored': true } }, undefined, { signal: controller.signal }).catch(error => error);
  await started;
  if (stop === 'cancel') controller.abort();
  await Promise.race([closed, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('fetch was not aborted')), 2000);
    closed.finally(() => clearTimeout(timer));
  })]);
  const reply = await result;
  if (stop === 'deadline') {
    assert.equal(reply.isError, true);
    assert.match(reply.content[0].text, /may have executed.*(?:do not repeat|check the app state)/i);
    assert.equal(reply._meta.browserRequest.uncertainOutcome, true);
  }
  assert.equal(seen.length, 1);
  assert.ok(seen[0].budget > 0 && seen[0].budget <= (stop === 'deadline' ? 500 : 5000));
});

test('public recovery guidance limits retries to reads and preserves uncertain mutation review', { timeout: 8000 }, async (t) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-recovery-guidance-'));
  const connection = path.join(profile, 'connection.json');
  fs.writeFileSync(connection, JSON.stringify({ url: 'http://127.0.0.1:9', token: 'fixture' }));
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.join(__dirname, '../scripts/browser-mcp.cjs'), '--bot-id', 'fixture', '--connection', connection],
    env: { ELECTRON_RUN_AS_NODE: '1' } });
  const client = new Client({ name: 'recovery-guidance-regression', version: '1' });
  t.after(async () => {
    await client.close().catch(() => {}); await transport.close().catch(() => {});
    fs.rmSync(profile, { recursive: true, force: true });
  });
  await client.connect(transport);
  const tools = (await client.listTools()).tools;
  const status = tools.find(tool => tool.name === 'cua_alans_way_status');
  assert.equal(status.annotations.readOnlyHint, true);
  assert.doesNotMatch(status.description, /on a tool error just retry|If the Mac goes offline mid-task, the connector continues/i,
    'discovery must not recommend retrying every failed call or promise unconditional continuation');
  assert.match(status.description, /retry a read-only call once/i);
  assert.match(status.description, /uncertain action or control change.*do not repeat/i);
  assert.match(status.description, /cua_alans_way_tabs.*controller and epoch.*fresh snapshot/i);
  assert.match(status.description, /confirmed pre-dispatch missing tab.*approval-bearing calls.*fresh review/i);
  const open = tools.find(tool => tool.name === 'cua_alans_way_open');
  assert.equal(open.inputSchema.properties.snapshot.type, 'boolean');
  for (const { description } of [status, open]) {
    assert.match(description, /Omit host for normal work, including work while the user is away/);
    assert.match(description, /user’s computer first; the router falls back to the VM when it is not reachable/);
    assert.match(description, /host:"vm" only when the user explicitly requests the VM or the router reports the user’s computer unreachable/);
    assert.doesNotMatch(description, /never replaced implicitly/);
  }
  assert.match(status.description, /VM status alone does not prove the user’s computer is unreachable/);
  assert.match(status.description, /An already-running VM task stays on the VM when the user’s computer returns/);
  assert.match(status.description, /Login, CAPTCHA, approval and uncertain-action errors are not outages and must not switch browsers/);
  assert.ok(status.description.endsWith('Retry a read-only call once; report a persistent failure. For an uncertain action or control change, do not repeat it: use cua_alans_way_tabs to inspect the controller and epoch, take a fresh snapshot, and follow the error’s recovery instructions. Never restart, kill, or edit connector processes to steer the host. Ordinary calls can continue the last HTTPS page in the VPS browser only after a confirmed pre-dispatch missing tab; approval-bearing calls need fresh review in the destination tab. When continuation is reported, use the named tab; if only a URL is supplied, open it and inspect before proceeding. Calls that do not run on the Mac keep going.'));
  assert.ok(open.description.endsWith('No human handoff, assignment, grant, or approval is ever needed. Shared sign-ins within a host, separate tab ownership and input. Opens in the background.'));
  for (const name of ['cua_alans_way_action', 'workspace_computer_action', 'cua_alans_way_snapshot']) {
    const description = tools.find(tool => tool.name === name).description;
    assert.match(description, /successful/i, `${name}: reuse applies to successful current state`);
    assert.match(description, /recovery.*uncertain.*fresh/i, `${name}: recovery has a local fresh-state exception`);
    assert.doesNotMatch(description, /Every reply carries effect|so do not snapshot after acting/);
  }
  assert.doesNotMatch(tools.find(tool => tool.name === 'cua_alans_way_action').description,
    /human_took_tab means[^\n]*then call again/i, 'interrupted input cannot be blindly repeated');
  const actionDescription = tools.find(tool => tool.name === 'cua_alans_way_action').description;
  assert.match(actionDescription, /latest observation.*ref or exact name/);
  assert.doesNotMatch(actionDescription, /no snapshot needed/);
  assert.doesNotMatch(actionDescription, /not held/i);
  assert.match(actionDescription, /on the user's computer and on the VM alike/);
  for (const sentence of [
    '- Consequential approval requires a fresh observed ref or unique exact name. If approval_invalid or page_changed reports a changed document/target, take a fresh snapshot, review it, and request a new approval; an old approval cannot move to a continued tab. approval_binding_unavailable requires updating the browser host/connector before approving again.',
    '- When automatic takeover is enabled and the human took over a tab on their computer, act or claim: the app hands it back to you (waiting up to 10s while they type) and shows them a Take back button. Do not ask first. An action is checked before it takes the tab, so a malformed one, an epoch or generation from before their takeover or page change (stale_control_epoch: inspect current control and epoch, then follow the current control policy) or one the page refuses (a missing control, a CAPTCHA) leaves the tab with them. human_took_tab means they grabbed it during your call: inspect completed effects and current control before deciding on another action; uncertain input is not permission to repeat it. Only awaiting_human (you handed it over), recording_in_progress (they are recording a task), human_took_back (they pressed Take back; leave it for a minute) or human_has_control (automatic takeover is off, or a VM tab) keep it theirs: open your own tab or tell them what you need. Never ask the user to hand a tab back unless a call answered human_has_control.',
    "- When only the human can continue (a CAPTCHA, a login, a 2FA code, card details, or a page they must review), release with a reason and a short note saying what to do. The app shows them a banner and a notification, and the tab stays theirs until they press Give back in Alan's Workspace or 30 minutes pass, on the user's computer and on the VM alike. Until then calls answer awaiting_human, and after the give-back human_returned: read the tab for the fresh epoch. Also tell the user in Telegram what you need.",
  ]) assert.ok(actionDescription.split('\n').includes(sentence), 'approval, takeover and handback wording stays intact');
});

test('control changes require a controller and epoch receipt and never replay uncertain replies', { timeout: 10000 }, async (t) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-control-receipts-'));
  const connection = path.join(profile, 'connection.json'), seen = [];
  let status = 200, reply = '{}', loseBody = false;
  const host = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume a control before replying or disconnecting */ }
    seen.push(req.method + ' ' + req.url);
    res.writeHead(req.method === 'POST' ? status : 200, { 'Content-Type': 'application/json' });
    if (req.method !== 'POST') return res.end('{"tabs":[{"id":"next","controller":"human","epoch":7}]}');
    if (loseBody) { res.write('{"controller":'); setTimeout(() => res.destroy(), 10); }
    else res.end(reply);
  });
  await new Promise(resolve => host.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(connection, JSON.stringify({ url: `http://127.0.0.1:${host.address().port}`, token: 'fixture' }));
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.join(__dirname, '../scripts/browser-mcp.cjs'), '--bot-id', 'fixture', '--connection', connection,
      '--tab-map', '{"old":"next"}'] });
  const client = new Client({ name: 'control-receipts-regression', version: '1' });
  t.after(async () => {
    await client.close().catch(() => {}); await transport.close().catch(() => {});
    host.closeAllConnections(); await new Promise(resolve => host.close(resolve));
    fs.rmSync(profile, { recursive: true, force: true });
  });
  await client.connect(transport);
  for (const action of ['claim', 'release']) {
    const controller = action === 'claim' ? 'agent' : 'human';
    for (const [label, value] of Object.entries({
      empty: '', null: 'null', array: '[]', object: '{}', boolean: 'true',
      'action-only': '{"dispatched":true}', 'missing-epoch': JSON.stringify({ id: 'old', controller }),
      'missing-controller': '{"id":"old","epoch":7}', 'wrong-controller': JSON.stringify({ id: 'old', controller: controller === 'human' ? 'agent' : 'human', epoch: 7 }),
      'missing-id': JSON.stringify({ controller, epoch: 7 }), 'wrong-id': JSON.stringify({ id: 'another', controller, epoch: 7 }),
      'number-id': JSON.stringify({ id: 1, controller, epoch: 7 }),
      'string-epoch': JSON.stringify({ id: 'old', controller, epoch: '7' }), 'negative-epoch': JSON.stringify({ id: 'old', controller, epoch: -1 }),
      'unsafe-epoch': JSON.stringify({ id: 'old', controller, epoch: Number.MAX_SAFE_INTEGER + 1 }),
      'explicit-refusal': JSON.stringify({ id: 'old', controller, epoch: 7, error: 'Control was refused.', code: 'control_refused' }),
      'failure-after-mutation': JSON.stringify({ id: 'old', controller, epoch: 7, error: 'Control failed after mutation', code: 'receipt_conflict' }),
      'failure-code': JSON.stringify({ id: 'old', controller, epoch: 7, code: 'control_refused' }),
      'not-dispatched': JSON.stringify({ id: 'old', controller, epoch: 7, dispatched: false }),
      'not-ok': JSON.stringify({ id: 'old', controller, epoch: 7, ok: false }),
      'not-successful': JSON.stringify({ id: 'old', controller, epoch: 7, success: false }),
      'explicit-error': JSON.stringify({ id: 'old', controller, epoch: 7, isError: true }),
      truncated: '{"controller":', html: '<html>failure</html>',
      'empty-204': '', 'error-502': '{"error":"Tab not found."}',
      'contradictory-404': '{"error":"Tab not found.","dispatched":true}', 'lost-body': '',
    })) await t.test(`${action}: ${label}`, async () => {
      reply = value; status = label === 'empty-204' ? 204 : label === 'error-502' ? 502 : label === 'contradictory-404' ? 404 : 200;
      loseBody = label === 'lost-body';
      const start = seen.length;
      const result = await client.callTool({ name: 'cua_alans_way_action', arguments: { tabId: 'old', epoch: 1, action } });
      assert.equal(result.isError, true, 'a missing, invalid or lost control receipt cannot imply success');
      assert.equal(result._meta?.browserRequest?.uncertainOutcome, true);
      assert.match(result.content[0].text, /control change may have executed.*do not repeat.*cua_alans_way_tabs/i);
      const state = await client.callTool({ name: 'cua_alans_way_tabs', arguments: {} });
      assert.equal(JSON.parse(state.content[0].text).tabs[0].epoch, 7);
      assert.deepEqual(seen.slice(start), ['POST /v1/tabs/old/control', 'GET /v1/tabs'], 'one control attempt, then an explicit read; no continuation/replay');
    });
    for (const receipt of [{ id: 'old', controller, epoch: 0 }, { id: 'old', controller, epoch: 7, note: 'Current host details' },
      { id: 'old', controller, epoch: 8, loading: false, error: 'ERR_NAME_NOT_RESOLVED' }]) {
      reply = JSON.stringify(receipt); status = 200; loseBody = false;
      const result = await client.callTool({ name: 'cua_alans_way_action', arguments: { tabId: 'old', epoch: 1, action } });
      assert.equal(result.isError, undefined);
      assert.deepEqual(JSON.parse(result.content[0].text), receipt, 'valid old/current host control details remain intact');
    }
  }
  reply = '{}'; status = 200; loseBody = false;
  for (const [label, tabId] of Object.entries({ empty: '', whitespace: ' \t ', missing: undefined, null: null, number: 0, array: [], object: {} })) {
    for (const [tool, extra] of [
      ['snapshot', {}], ['screenshot', {}], ['close', {}], ['action', { action: 'claim' }], ['action', { action: 'release' }],
    ]) await t.test(`${tool} ${extra.action || ''}: ${label} tab ID`, async () => {
      const start = seen.length;
      const result = await client.callTool({ name: 'cua_alans_way_' + tool, arguments: { tabId, epoch: 1, ...extra } });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /nonempty tabId.*cua_alans_way_tabs/);
      assert.deepEqual(seen.slice(start), [], 'invalid tab IDs are refused before any capability or route request');
    });
  }
});

for (const action of ['claim', 'release']) test(`approval-bearing ${action} pins the checked connection before control`, { timeout: 8000 }, async (t) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-browser-control-identity-'));
  const connection = path.join(profile, 'connection.json'), seen = [];
  let replacement;
  const host = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume any fixture control body */ }
    seen.push({ method: req.method, path: req.url, authorization: req.headers.authorization });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url === '/v1/status') {
      fs.writeFileSync(connection, JSON.stringify(replacement));
      res.end('{"capabilities":["approval-binding-v1"]}');
    } else res.end('{"controller":"human","epoch":2}');
  });
  await new Promise(resolve => host.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${host.address().port}`;
  const token = 'a'.repeat(64);
  fs.writeFileSync(connection, JSON.stringify({ url, token }));
  replacement = { url, token: 'b'.repeat(64) };
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.join(__dirname, '../scripts/browser-mcp.cjs'), '--bot-id', 'mcp-test', '--connection', connection] });
  const client = new Client({ name: 'control-identity-regression', version: '1' });
  t.after(async () => {
    await client.close().catch(() => {}); await transport.close().catch(() => {});
    host.closeAllConnections(); await new Promise(resolve => host.close(resolve));
    fs.rmSync(profile, { recursive: true, force: true });
  });
  await client.connect(transport);
  const result = await client.callTool({ name: 'cua_alans_way_action', arguments: {
    tabId: 't1', epoch: 1, action, approval: { nonce: 'fixture-review' },
  } });
  assert.equal(result.isError, true, 'control must not move to a changed connection after its status check');
  assert.match(result.content[0].text, /browser connection changed after review/);
  assert.deepEqual(seen, [{ method: 'GET', path: '/v1/status', authorization: `Bearer ${token}` }]);
});

test('approved forwarding distinguishes URL and token pairs containing separators', { timeout: 8000 }, async (t) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-browser-identity-'));
  const connection = path.join(profile, 'connection.json'), seen = [];
  let replacement;
  const host = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume any fixture action */ }
    seen.push({ method: req.method, authorization: req.headers.authorization });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url === '/v1/status') {
      fs.writeFileSync(connection, JSON.stringify(replacement));
      res.end('{"capabilities":["approval-binding-v1"]}');
    } else res.end('{"dispatched":true}');
  });
  await new Promise(resolve => host.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${host.address().port}`;
  fs.writeFileSync(connection, JSON.stringify({ url: `${origin}/a`, token: 'b|c' }));
  replacement = { url: `${origin}/a|b`, token: 'c' };
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.join(__dirname, '../scripts/browser-mcp.cjs'), '--bot-id', 'mcp-test', '--connection', connection] });
  const client = new Client({ name: 'connection-identity-regression', version: '1' });
  t.after(async () => {
    await client.close().catch(() => {}); await transport.close().catch(() => {});
    host.closeAllConnections(); await new Promise(resolve => host.close(resolve));
    fs.rmSync(profile, { recursive: true, force: true });
  });
  await client.connect(transport);
  const result = await client.callTool({ name: 'cua_alans_way_action', arguments: {
    tabId: 't1', epoch: 1, action: 'click', ref: 'e1', approval: { nonce: 'fixture-review' },
  } });
  assert.equal(result.isError, true, 'a changed credential must not inherit the earlier status result');
  assert.match(result.content[0].text, /browser connection changed after review/);
  assert.deepEqual(seen, [{ method: 'GET', authorization: 'Bearer b|c' }], 'no approved POST reaches the changed connection');
});

test('snapshot proof recovers from an initially unsupported host without restarting the connector', { timeout: 8000 }, async (t) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-browser-capability-recovery-'));
  let capabilities = ['tabs', 'snapshot'], statusReads = 0, actionPosts = 0;
  const proof = { version: 1, documentId: 'fixture-document', url: 'https://example.com/review' };
  const page = { tabId: 't1', epoch: 1, generation: 1, approvalContext: proof,
    elements: [{ ref: 'e1', role: 'button', name: 'Pay', approvalTarget: 'fixture-target' }] };
  const host = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* fixture consumes any action body */ }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url === '/v1/status') { statusReads++; res.end(JSON.stringify({ capabilities })); }
    else if (req.method === 'POST') { actionPosts++; res.end('{"dispatched":true}'); }
    else res.end(JSON.stringify(page));
  });
  await new Promise(resolve => host.listen(0, '127.0.0.1', resolve));
  const connection = path.join(profile, 'connection.json');
  fs.writeFileSync(connection, JSON.stringify({ url: `http://127.0.0.1:${host.address().port}`, token: 'fixture-token', protocol: 1 }));
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.join(__dirname, '../scripts/browser-mcp.cjs'), '--bot-id', 'mcp-test', '--connection', connection] });
  const client = new Client({ name: 'capability-recovery-regression', version: '1' });
  t.after(async () => {
    await client.close().catch(() => {}); await transport.close().catch(() => {});
    host.closeAllConnections(); await new Promise(resolve => host.close(resolve));
    fs.rmSync(profile, { recursive: true, force: true });
  });
  await client.connect(transport);
  const snapshot = async () => JSON.parse((await client.callTool({ name: 'cua_alans_way_snapshot', arguments: { tabId: 't1' } })).content[0].text);
  const unsupported = await snapshot();
  assert.equal(unsupported.approvalContext, undefined);
  assert.equal(unsupported.elements[0].approvalTarget, undefined);
  assert.equal(statusReads, 1);
  capabilities = ['tabs', 'snapshot', 'approval-binding-v1'];
  const recovered = await snapshot();
  assert.deepEqual(recovered.approvalContext, proof, 'a fresh snapshot learns restored support at the same address/token');
  assert.equal(recovered.elements[0].approvalTarget, 'fixture-target');
  assert.equal(statusReads, 2, 'only the missing capability answer is refreshed');
  await snapshot();
  assert.equal(statusReads, 2, 'supported ordinary snapshot reads retain the feature cache');
  capabilities = ['tabs', 'snapshot'];
  const refused = await client.callTool({ name: 'cua_alans_way_action', arguments: {
    tabId: 't1', epoch: 1, action: 'click', ref: 'e1', approval: { nonce: 'fixture-nonce' },
  } });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /approval_binding_unavailable/);
  assert.equal(actionPosts, 0, 'cached positive discovery never authorizes an unsupported approved forward');
});

test('browser MCP rejects unusable action receipts as uncertain without replay', { timeout: 8000 }, async (t) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-browser-receipt-'));
  const seen = [], records = [];
  let responseBody = '', responseStatus = 200;
  const host = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* action accepted before its receipt is lost */ }
    seen.push(req.method + ' ' + req.url);
    res.writeHead(req.method === 'POST' ? responseStatus : 200, { 'Content-Type': 'application/json' });
    res.end(req.method === 'POST' ? responseBody : JSON.stringify({ epoch: 1, elements: [{ name: 'Draft', value: 'ran once' }] }));
  });
  await new Promise(resolve => host.listen(0, '127.0.0.1', resolve));
  const connection = path.join(profile, 'connection.json');
  fs.writeFileSync(connection, JSON.stringify({ url: `http://127.0.0.1:${host.address().port}`, token: 'fixture-token', protocol: 1 }));
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.join(__dirname, '../scripts/browser-mcp.cjs'), '--bot-id', 'mcp-test', '--connection', connection, '--tab-map', '{"t1":"vm1"}'] });
  const client = new Client({ name: 'browser-receipt-regression', version: '1' });
  t.after(async () => {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    host.closeAllConnections();
    await new Promise(resolve => host.close(resolve));
    fs.rmSync(profile, { recursive: true, force: true });
  });
  await client.connect(transport);
  for (const [label, body] of Object.entries({
    empty: '', whitespace: '  ', null: 'null', string: '"receipt"', number: '1', boolean: 'true',
    array: '[]', 'array-with-marker': '[{"dispatched":true}]', object: '{}',
    'wrong-marker': '{"dispatched":"true"}', 'false-marker': '{"dispatched":false}',
    'effect-only': '{"effect":{"changed":true}}', 'error-only': '{"error":"Tab not found."}',
    truncated: '{"dispatched":', html: '<html>Tab not found</html>',
    'empty-204': '', 'empty-502': '', 'null-502': 'null', 'object-502': '{}',
  })) {
    await t.test(label, async () => {
      responseBody = body;
      responseStatus = label.endsWith('-502') ? 502 : label.endsWith('-204') ? 204 : 200;
      const before = seen.length;
      const started = performance.now();
      const receipt = await client.callTool({ name: 'cua_alans_way_action', arguments: { tabId: 't1', epoch: 1, action: 'type', selector: '#draft', text: 'ran once' } });
      const elapsedMs = performance.now() - started;
      const recovery = await client.callTool({ name: 'cua_alans_way_snapshot', arguments: { tabId: 't1' } });
      records.push({ label, body, responseStatus, receipt, elapsedMs, recovery, seen: seen.slice(before) });
      assert.equal(receipt.isError, true);
      assert.match(receipt.content[0].text, /action may have executed/i);
      assert.match(receipt.content[0].text, /do not repeat.*cua_alans_way_snapshot.*"tabId":"t1"/i);
      assert.doesNotMatch(receipt.content[0].text, /cancelled|canceled/i);
      assert.equal(recovery.isError, undefined);
      assert.deepEqual(JSON.parse(recovery.content[0].text), { epoch: 1, elements: [{ name: 'Draft', value: 'ran once' }] });
      assert.deepEqual(seen.slice(before), ['POST /v1/tabs/t1/actions', 'GET /v1/tabs/t1/snapshot?maxChars=2000']);
    });
  }
  if (process.env.HERMES_RELIABILITY_EVIDENCE) {
    const dir = process.env.HERMES_RELIABILITY_EVIDENCE;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${process.env.HERMES_RELIABILITY_PHASE || 'after'}-receipt-matrix-stdio.json`), JSON.stringify(records, null, 2) + '\n');
  }
});

test('browser MCP reports a response-body disconnect without replaying uncertain input', { timeout: 8000 }, async (t) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-browser-mcp-'));
  const seen = [];
  let disconnect = true;
  const host = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume the action before losing its reply */ }
    seen.push(req.method + ' ' + req.url);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (disconnect) {
      res.write('{"dispatched":');
      setTimeout(() => res.destroy(), 20);
    } else res.end('{"tabs":[]}');
  });
  await new Promise(resolve => host.listen(0, '127.0.0.1', resolve));
  const connectionFile = path.join(profile, 'connection.json');
  fs.writeFileSync(connectionFile, JSON.stringify({ url: `http://127.0.0.1:${host.address().port}`, token: 'fixture-token', protocol: 1 }));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, '../scripts/browser-mcp.cjs'), '--bot-id', 'mcp-test', '--connection', connectionFile],
    env: { ...process.env },
  });
  const client = new Client({ name: 'browser-mcp-test', version: '1' });
  t.after(async () => {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    host.closeAllConnections();
    await new Promise(resolve => host.close(resolve));
    fs.rmSync(profile, { recursive: true, force: true });
  });
  await client.connect(transport);
  const started = performance.now();
  const result = await client.callTool({ name: 'cua_alans_way_action', arguments: { tabId: 't1', epoch: 1, action: 'type', ref: 'e1', text: 'fixture input' } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /action may have executed.*Do not repeat.*cua_alans_way_snapshot.*"tabId":"t1"/i);
  assert.ok(performance.now() - started < 2000, 'a closed response must fail promptly');
  assert.deepEqual(seen, ['POST /v1/tabs/t1/actions'], 'an uncertain action must never be replayed');
  disconnect = false;
  assert.deepEqual(JSON.parse((await client.callTool({ name: 'cua_alans_way_tabs', arguments: {} })).content[0].text), { tabs: [] }, 'the same connector can recover with a fresh read');
});

test('browser MCP preserves supported action receipts, API errors and empty read results', { timeout: 8000 }, async (t) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-browser-receipt-'));
  let status = 200, reply = {};
  const host = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume before responding */ }
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(reply === undefined ? '' : JSON.stringify(reply));
  });
  await new Promise(resolve => host.listen(0, '127.0.0.1', resolve));
  const connection = path.join(profile, 'connection.json');
  fs.writeFileSync(connection, JSON.stringify({ url: `http://127.0.0.1:${host.address().port}`, token: 'fixture-token', protocol: 1 }));
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.join(__dirname, '../scripts/browser-mcp.cjs'), '--bot-id', 'mcp-test', '--connection', connection] });
  const client = new Client({ name: 'browser-receipt-compatibility', version: '1' });
  t.after(async () => {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    host.closeAllConnections();
    await new Promise(resolve => host.close(resolve));
    fs.rmSync(profile, { recursive: true, force: true });
  });
  await client.connect(transport);
  for (const [action, expected] of [
    ['type', { dispatched: true }],
    ['move', { dispatched: true, effect: { navigated: false, changed: false, text: '' } }],
    ['eval', { dispatched: true, value: null }],
    ['eval', { dispatched: true }], // undefined JS result is omitted by JSON
    ['cdp', { dispatched: true, value: {} }],
    ['viewport', { dispatched: true, viewport: null }],
    ['read', { dispatched: true, text: '' }],
    ['wait', { dispatched: true, waited: 0 }],
    ['batch', { dispatched: true, results: [{ ok: true, dispatched: true }, { ok: false, error: 'Missing control.' }] }],
    ['type', { dispatched: true, effect: { navigated: false, changed: false, text: '' }, error: 'The page returned no state.' }],
  ]) {
    reply = expected;
    const result = await client.callTool({ name: 'cua_alans_way_action', arguments: { tabId: 't1', epoch: 1, action } });
    assert.equal(result.isError, undefined, action);
    assert.deepEqual(JSON.parse(result.content[0].text), expected, action);
  }
  for (const expected of [undefined, null, {}, { tabs: [] }, { unchanged: true }]) {
    reply = expected;
    const result = await client.callTool({ name: 'cua_alans_way_snapshot', arguments: { tabId: 't1' } });
    assert.equal(result.isError, undefined);
    assert.deepEqual(JSON.parse(result.content[0].text), expected === undefined ? {} : expected);
  }
  status = 409; reply = { error: 'stale_control_epoch: read, then act.' };
  const rejected = await client.callTool({ name: 'cua_alans_way_action', arguments: { tabId: 't1', epoch: 1, action: 'type', text: 'refused' } });
  assert.equal(rejected.isError, true);
  assert.ok(rejected.content[0].text.includes(reply.error), 'an API error keeps its precise explanation');
  assert.match(rejected.content[0].text, /action may have executed.*cua_alans_way_snapshot/i,
    'legacy stale epochs can also follow input; inspect state before another dispatch');
  assert.equal(rejected._meta.browserRequest.status, 409);
});

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
    'workspace_computer_apps', 'workspace_computer_launch', 'workspace_computer_snapshot', 'workspace_computer_screenshot', 'workspace_computer_menu', 'workspace_computer_action',
    'cua_alans_way_action', 'cua_alans_way_recordings',
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

test('the recordings tool is read-only and asks the app for this bot only', { timeout: 8000 }, async (t) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-browser-mcp-'));
  const seen = [];
  const host = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url} ${req.headers['x-hermes-bot']}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(req.url === '/v1/recordings' ? '{"recordings":[]}' : '{"id":"rec-12345678","steps":[]}');
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
  const tool = (await client.listTools()).tools.find((item) => item.name === 'cua_alans_way_recordings');
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.deepEqual(tool.inputSchema.properties.action.enum, ['list', 'get']);
  assert.match(tool.description, /skill_manage/);
  const call = (args) => client.callTool({ name: 'cua_alans_way_recordings', arguments: args });
  assert.equal((await call({ action: 'list' })).isError, undefined);
  assert.equal((await call({ action: 'get', id: 'rec-12345678' })).isError, undefined);
  assert.equal((await call({ action: 'get' })).isError, true);
  assert.deepEqual(seen, ['GET /v1/recordings mcp-test', 'GET /v1/recordings/rec-12345678 mcp-test']);
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
    res.end(JSON.stringify(req.url.endsWith('/control') ? { id: 't', controller: received.controller, epoch: 3 } : { dispatched: true }));
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
  assert.deepEqual(action.reason.enum, ['captcha', 'login', 'two_factor', 'payment_details', 'review', 'other']);
  const released = await client.callTool({ name: 'cua_alans_way_action', arguments: { tabId: 't', epoch: 2, action: 'release', reason: 'login', note: 'Sign in please' } });
  assert.equal(released.isError, undefined);
  assert.deepEqual(received, { controller: 'human', reason: 'login', note: 'Sign in please' });
  const claimed = await client.callTool({ name: 'cua_alans_way_action', arguments: { tabId: 't', epoch: 2, action: 'claim', reason: 'login' } });
  assert.equal(claimed.isError, undefined);
  assert.deepEqual(received, { controller: 'agent' });
});

test('a named action on a host without name-targets is refused before it is sent', { timeout: 8000 }, async (t) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-browser-mcp-'));
  const seen = [];
  const host = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    seen.push({ line: req.method + ' ' + req.url, body: raw ? JSON.parse(raw) : undefined });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(req.url === '/v1/status' ? '{"capabilities":["tabs","snapshot"]}' : '{"dispatched":true}');
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
  const action = (args) => client.callTool({ name: 'cua_alans_way_action', arguments: { tabId: 't', epoch: 2, ...args } });
  const press = await action({ action: 'press', name: 'Go', key: 'Enter' });
  assert.equal(press.isError, true);
  assert.match(press.content[0].text, /does not take name targets yet.*Act by ref/);
  const batch = await action({ action: 'batch', steps: [{ action: 'scroll', name: 'More' }] });
  assert.equal(batch.isError, true);
  assert.ok(!seen.some((entry) => entry.line === 'POST /v1/tabs/t/actions'), 'the named step never reached the host');
  const byRef = await action({ action: 'press', ref: 'e1', key: 'Enter' });
  assert.equal(byRef.isError, undefined, 'ref actions need no capability');
  assert.equal(seen.filter((entry) => entry.line === 'GET /v1/status').length, 1, 'the capability answer is cached');
});

async function computerHost(t, capabilities, hostLabel) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-browser-mcp-'));
  const seen = [];
  const host = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    seen.push({ line: req.method + ' ' + req.url, bot: req.headers['x-hermes-bot'], body: raw ? JSON.parse(raw) : undefined });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(req.url === '/v1/status' ? JSON.stringify({ capabilities, ...(hostLabel ? { host: hostLabel } : {}) })
      : req.url === '/v1/computer/apps' ? JSON.stringify({ apps: [{ pid: 7, name: 'app-api-marker' }] })
      : req.url.includes('/screenshot') ? JSON.stringify({ image: 'AAAA', imageWidth: 1, imageHeight: 1, windowX: 0, windowY: 0, windowWidth: 1, windowHeight: 1, note: 'Read only: elsewhere.' })
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
  return { client, seen, profile };
}

test('the app list names the machine the apps run on', { timeout: 8000 }, async (t) => {
  const { client } = await computerHost(t, ['computer', 'tabs'], 'mac');
  const reply = JSON.parse((await client.callTool({ name: 'workspace_computer_apps', arguments: {} })).content[0].text);
  assert.equal(reply.host, 'mac');
  assert.equal(reply.apps[0].name, 'app-api-marker');
});

test('Mac launch goes through the advertised app API and old hosts refuse it', { timeout: 8000 }, async (t) => {
  const { client, seen } = await computerHost(t, ['computer', 'computer-launch-v1'], 'mac');
  const tools = (await client.listTools()).tools;
  assert.ok(tools.find(tool => tool.name === 'workspace_computer_launch'));
  assert.ok(tools.find(tool => tool.name === 'workspace_computer_action').inputSchema.properties.action.enum.includes('activate'));
  const reply = await client.callTool({ name: 'workspace_computer_launch', arguments: { app: 'Calculator' } });
  assert.equal(reply.isError, undefined, JSON.stringify(reply));
  assert.deepEqual(seen.find(item => item.line === 'POST /v1/computer/launch').body, { app: 'Calculator' });
  const opened = await client.callTool({ name: 'workspace_computer_launch', arguments: { path: '/tmp/task/edit.txt' } });
  assert.equal(opened.isError, undefined, JSON.stringify(opened));
  assert.deepEqual(seen.filter(item => item.line === 'POST /v1/computer/launch')[1].body, { path: '/tmp/task/edit.txt' });
  assert.equal((await client.callTool({ name: 'workspace_computer_launch', arguments: {} })).isError, true);
  const old = await computerHost(t, ['computer'], 'windows');
  const refused = await old.client.callTool({ name: 'workspace_computer_launch', arguments: { app: 'Calculator' } });
  assert.equal(refused.isError, true);
  assert.ok(!old.seen.some(item => item.line.includes('/launch')));
});

test('computer tools go through the app API when the connected app advertises computer use', { timeout: 8000 }, async (t) => {
  const { client, seen } = await computerHost(t, ['computer', 'computer-v2', 'tabs']);
  const call = async (name, args) => (await client.callTool({ name, arguments: args })).content[0].text;
  assert.match(await call('workspace_computer_apps', {}), /app-api-marker/);
  assert.match(await call('workspace_computer_snapshot', { pid: 7, since: 3, menubar: true }), /app-api-marker/);
  assert.match(await call('workspace_computer_menu', { pid: 7, path: ['File'] }), /app-api-marker/);
  assert.match(await call('workspace_computer_action', { pid: 7, action: 'batch', generation: 4, menubar: true, steps: [{ action: 'press', ref: 'a1' }] }), /app-api-marker/);
  const shot = await client.callTool({ name: 'workspace_computer_screenshot', arguments: { pid: 7, maxWidth: 640 } });
  assert.equal(shot.isError, undefined);
  assert.match(JSON.parse(shot.content[1].text).note, /^Read only: elsewhere\. Click coordinates stay/);
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
  assert.match(text, /"agentDesktop":""/);
  assert.match((await client.callTool({ name: 'workspace_computer_action', arguments: { pid: 1, action: 'press', ref: 'a', generation: 1 } })).content[0].text, /in-process-marker/);
  assert.ok(seen.every((entry) => !entry.line.startsWith('GET /v1/computer') && !entry.line.startsWith('POST /v1/computer')));
});

test('the in-process driver is told it owns the desktop when the host says agent-desktop', { timeout: 8000 }, async (t) => {
  const { client } = await computerHost(t, ['tabs', 'agent-desktop']);
  assert.match((await client.callTool({ name: 'workspace_computer_apps', arguments: {} })).content[0].text, /"agentDesktop":"1"/);
});

test('the agent-desktop flag follows the host and restarts the helper when it changes', { timeout: 8000 }, async (t) => {
  const capabilities = ['tabs', 'agent-desktop'];
  const { client, profile } = await computerHost(t, capabilities);
  const apps = async () => JSON.parse((await client.callTool({ name: 'workspace_computer_apps', arguments: {} })).content[0].text).apps[0];
  assert.equal((await apps()).agentDesktop, '1');
  capabilities.length = 0;
  capabilities.push('tabs');
  const connection = JSON.parse(fs.readFileSync(path.join(profile, 'connection.json'), 'utf8'));
  fs.writeFileSync(path.join(profile, 'connection.json'), JSON.stringify({ ...connection, token: 'other-token' }));
  const after = await apps();
  assert.equal(after.agentDesktop, '');
  assert.equal(after.closed, '1');
});

test('a named step sent to a host from before name targets says to act by ref', { timeout: 8000 }, async (t) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-browser-mcp-'));
  const old = http.createServer((_req, res) => { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Provide a fresh element reference, selector, or viewport x and y coordinates.' })); });
  await new Promise((resolve) => old.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(path.join(profile, 'connection.json'), JSON.stringify({ url: `http://127.0.0.1:${old.address().port}`, token: 'fixture-token', protocol: 1 }));
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(__dirname, '../scripts/browser-mcp.cjs'), '--bot-id', 'mcp-test', '--connection', path.join(profile, 'connection.json')], env: { ...process.env } });
  const client = new Client({ name: 'browser-mcp-test', version: '1' });
  t.after(async () => { await client.close().catch(() => {}); await transport.close().catch(() => {}); await new Promise((resolve) => old.close(resolve)); fs.rmSync(profile, { recursive: true, force: true }); });
  await client.connect(transport);
  const act = (args) => client.callTool({ name: 'cua_alans_way_action', arguments: { tabId: 't1', epoch: 1, ...args } });
  const named = await act({ action: 'click', name: 'Next' });
  assert.equal(named.isError, true);
  assert.match(named.content[0].text, /does not take name targets yet .*Act by ref/);
  const inBatch = await act({ action: 'batch', steps: [{ action: 'click', name: 'Next' }] });
  assert.match(inBatch.content[0].text, /does not take name targets yet/);
  const plain = await act({ action: 'click', x: 5, y: 5 });
  assert.doesNotMatch(plain.content[0].text, /name targets/, 'an unnamed failure keeps its own message');
});

test('a cropped browser screenshot reaches the host and returns its coordinate mapping', { timeout: 8000 }, async (t) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-crop-'));
  const viewport = { width: 1000, height: 800, pageLeft: 0, pageTop: 3000, deviceScaleFactor: 2 };
  const crop = { x: 40, y: 60, width: 200, height: 120 };
  const seen = [];
  const host = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture.example');
    const region = url.searchParams.has('crop') ? JSON.parse(url.searchParams.get('crop')) : undefined;
    seen.push({ path: url.pathname, crop: region, format: url.searchParams.get('format'), maxWidth: url.searchParams.get('maxWidth'), quality: url.searchParams.get('quality') });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ base64: 'AQID', mimeType: 'image/png', viewport, ...(region ? { crop: region } : {}) }));
  });
  await new Promise(resolve => host.listen(0, '127.0.0.1', resolve));
  const connection = path.join(profile, 'connection.json');
  fs.writeFileSync(connection, JSON.stringify({ url: `http://127.0.0.1:${host.address().port}`, token: 'fixture-token', protocol: 1 }));
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.join(__dirname, '../scripts/browser-mcp.cjs'), '--bot-id', 'crop-test', '--connection', connection] });
  const client = new Client({ name: 'browser-crop-test', version: '1' });
  t.after(async () => {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    host.closeAllConnections();
    await new Promise(resolve => host.close(resolve));
    fs.rmSync(profile, { recursive: true, force: true });
  });
  await client.connect(transport);
  const result = await client.callTool({ name: 'cua_alans_way_screenshot', arguments: { tabId: 't1', format: 'png', maxWidth: 100, crop } });
  assert.deepEqual(seen, [{ path: '/v1/tabs/t1/screenshot', crop, format: 'png', maxWidth: '100', quality: '50' }]);
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.content[0], { type: 'image', data: 'AQID', mimeType: 'image/png' });
  const mapping = JSON.parse(result.content[1].text);
  assert.deepEqual(mapping.viewport, viewport);
  assert.deepEqual(mapping.crop, crop);
  assert.match(mapping.note, /x = crop\.x \+ px \* crop\.width \/ image width/);
  assert.match(mapping.note, /y = crop\.y \+ py \* crop\.height \/ image height/);
  const tool = (await client.listTools()).tools.find(tool => tool.name === 'cua_alans_way_screenshot');
  assert.match(tool.description, /MEDIA:<path>/);
  assert.match(tool.description, /vision step/);
  assert.match(tool.description, /Defaults to compact jpeg; png keeps alpha/);
  assert.deepEqual(tool.inputSchema.properties.crop.required, ['x', 'y', 'width', 'height']);
  assert.equal(tool.inputSchema.properties.crop.additionalProperties, false);
  const full = await client.callTool({ name: 'cua_alans_way_screenshot', arguments: { tabId: 't1' } });
  const fullMapping = JSON.parse(full.content[1].text);
  assert.deepEqual(fullMapping.viewport, viewport);
  assert.equal(fullMapping.crop, undefined);
  assert.match(fullMapping.note, /viewport.width \/ image width/);
  assert.deepEqual(seen[1], { path: '/v1/tabs/t1/screenshot', crop: undefined, format: null, maxWidth: '960', quality: '50' });
});

test('window selection reaches every computer API and old hosts refuse it', { timeout: 8000 }, async (t) => {
  const { client, seen } = await computerHost(t, ['computer', 'computer-window-v1']);
  for (const [name, args] of [
    ['workspace_computer_snapshot', { pid: 7, windowId: 42 }],
    ['workspace_computer_screenshot', { pid: 7, windowId: 42 }],
    ['workspace_computer_action', { pid: 7, windowId: 42, action: 'click', x: 1, y: 2 }],
  ]) assert.equal((await client.callTool({ name, arguments: args })).isError, undefined);
  assert.ok(seen.some((entry) => entry.line === 'GET /v1/computer/7/snapshot?windowId=42'));
  assert.ok(seen.some((entry) => entry.line === 'GET /v1/computer/7/screenshot?windowId=42'));
  assert.equal(seen.find((entry) => entry.line.endsWith('/action')).body.windowId, 42);
  const old = await computerHost(t, ['computer']);
  const reply = await old.client.callTool({ name: 'workspace_computer_action', arguments: { pid: 7, windowId: 42, action: 'click', x: 1, y: 2 } });
  assert.equal(reply.isError, true);
  assert.deepEqual(old.seen.map((entry) => entry.line), ['GET /v1/status']);
});

test('browser guidance shows batching an observed search ref', { timeout: 8000 }, async (t) => {
  const { client } = await computerHost(t, ['tabs']);
  const action = (await client.listTools()).tools.find(tool => tool.name === 'cua_alans_way_action');
  assert.ok(action.description.includes('- Observed search ref: batch[type(ref,"query"),press(Enter)].'));
});

test('list reads add at most 120 estimated schema tokens and keep typed field guidance', { timeout: 8000 }, async (t) => {
  const { client } = await computerHost(t, ['tabs']);
  const action = (await client.listTools()).tools.find(tool => tool.name === 'cua_alans_way_action');
  const baseline = structuredClone(action);
  delete baseline.inputSchema.properties.list;
  delete baseline.inputSchema.properties.steps.items.properties.list;
  baseline.description = baseline.description.replace(/ read with list:[^\n]*? items\./, '');
  baseline.inputSchema.properties.maxChars.description = 'For read: cap on returned page text, default 600, max 20000.';
  const addedChars = JSON.stringify(action).length - JSON.stringify(baseline).length;
  assert.ok(addedChars <= 480, `${addedChars} added characters exceed 120 estimated tokens`);
  assert.match(action.description, /read with list:.*fields:.*type:.*text.*href.*items/);
  assert.deepEqual(Object.keys(action.inputSchema.properties.list.properties), ['selector', 'fields']);
});

test('snapshot delta opt-in is documented and forwarded only when enabled', { timeout: 8000 }, async (t) => {
  const { client, seen } = await computerHost(t, ['computer']);
  const tool = (await client.listTools()).tools.find((tool) => tool.name === 'workspace_computer_snapshot');
  assert.equal(tool.inputSchema.properties.delta.type, 'boolean');
  assert.match(tool.description, /delta:true/);
  assert.match(tool.description, /changed.*removed/);
  for (const delta of [undefined, false, true]) {
    const reply = await client.callTool({ name: 'workspace_computer_snapshot', arguments: { pid: 7, since: 3, ...(delta === undefined ? {} : { delta }) } });
    assert.equal(reply.isError, undefined);
  }
  assert.deepEqual(seen.filter((item) => item.line.includes('/snapshot')).map((item) => item.line), [
    'GET /v1/computer/7/snapshot?since=3',
    'GET /v1/computer/7/snapshot?since=3',
    'GET /v1/computer/7/snapshot?since=3&delta=1',
  ]);
});


test('Mac text selection and advertised actions have schemas and reach the computer API', { timeout: 8000 }, async (t) => {
  const { client, seen } = await computerHost(t, ['computer', 'computer-window-v1']);
  const tool = (await client.listTools()).tools.find((tool) => tool.name === 'workspace_computer_action');
  assert.ok(tool.inputSchema.properties.action.enum.includes('select_text'));
  assert.ok(tool.inputSchema.properties.action.enum.includes('secondary_action'));
  assert.deepEqual(tool.inputSchema.properties.selection.enum, ['text', 'cursor_before', 'cursor_after']);
  assert.ok(tool.inputSchema.properties.secondaryAction.enum.includes('AXShowMenu'));
  for (const step of [
    { action: 'select_text', ref: 'c1', text: 'word', prefix: 'second ', suffix: '.', selection: 'text' },
    { action: 'secondary_action', ref: 'c2', secondaryAction: 'AXShowMenu' },
  ]) {
    const body = { pid: 7, windowId: 42, generation: 3, ...step };
    assert.equal((await client.callTool({ name: 'workspace_computer_action', arguments: body })).isError, undefined);
    const { pid, ...forwarded } = body;
    assert.deepEqual(seen.filter((entry) => entry.line.endsWith('/action')).at(-1).body, forwarded);
  }
});
