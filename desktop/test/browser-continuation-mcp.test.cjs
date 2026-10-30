const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

test('approval-bearing control calls never follow a missing tab into a continuation', { timeout: 10000 }, async (t) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-control-continuation-'));
  const connection = path.join(profile, 'connection.json'), wires = [];
  let replacement;
  const serve = site => http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    wires.push({ site, method: req.method, path: req.url, authorization: req.headers.authorization });
    const missing = req.url === '/v1/tabs/old/control';
    if (missing) fs.writeFileSync(connection, JSON.stringify(replacement));
    res.writeHead(missing ? 404 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(missing ? { error: 'Tab not found.' } : req.url === '/v1/status'
      ? { capabilities: ['approval-binding-v1'] } : { id: 'next', controller: JSON.parse(raw).controller, epoch: 7 }));
  });
  const first = serve('first'), second = serve('second');
  await Promise.all([first, second].map(host => new Promise(resolve => host.listen(0, '127.0.0.1', resolve))));
  const original = { url: `http://127.0.0.1:${first.address().port}`, token: 'a'.repeat(64), botId: 'fixture' };
  fs.writeFileSync(connection, JSON.stringify(original));
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.join(__dirname, '../scripts/browser-mcp.cjs'), '--bot-id', 'fixture', '--connection', connection,
      '--tab-map', '{"old":"next"}'] });
  const client = new Client({ name: 'control-continuation-regression', version: '1' });
  t.after(async () => {
    await client.close().catch(() => {}); await transport.close().catch(() => {});
    await Promise.all([first, second].map(host => { host.closeAllConnections(); return new Promise(resolve => host.close(resolve)); }));
    fs.rmSync(profile, { recursive: true, force: true });
  });
  await client.connect(transport);
  for (const approved of [true, false]) for (const action of ['claim', 'release']) {
    for (const change of ['unchanged', 'token', 'address']) await t.test(`${approved ? 'approved' : 'ordinary'} ${action}: ${change}`, async () => {
      fs.writeFileSync(connection, JSON.stringify(original));
      replacement = change === 'token' ? { ...original, token: 'b'.repeat(64) }
        : change === 'address' ? { ...original, url: `http://127.0.0.1:${second.address().port}` } : original;
      const start = wires.length;
      const result = await client.callTool({ name: 'cua_alans_way_action', arguments: {
        tabId: 'old', epoch: 1, action, ...(approved ? { approval: { nonce: 'fixture-review' } } : {}),
      } });
      const posts = wires.slice(start).filter(wire => wire.method === 'POST');
      assert.deepEqual(posts[0], { site: 'first', method: 'POST', path: '/v1/tabs/old/control', authorization: `Bearer ${original.token}` });
      if (approved) {
        assert.equal(result.isError, true, 'reviewed control cannot move to another tab even on the same connection');
        assert.match(result.content[0].text, /approval_invalid.*reviewed tab is gone/);
        assert.equal(posts.length, 1, 'only the original missing-tab rejection may be sent; no continuation POST');
      } else {
        assert.equal(result.isError, undefined, 'ordinary control continuation remains compatible');
        assert.equal(JSON.parse(result.content[0].text).continuedTab, 'next');
        assert.equal(posts.length, 2);
        assert.deepEqual(posts[1], { site: change === 'address' ? 'second' : 'first', method: 'POST',
          path: '/v1/tabs/next/control', authorization: `Bearer ${replacement.token}` });
      }
    });
  }
});

test('continuation requires a known missing-tab rejection, never an uncertain action receipt', { timeout: 10000 }, async (t) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-continuation-'));
  const records = [], requests = [];
  let mode, originalInputs = 0, continuedInputs = 0, value = '';
  const host = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    requests.push({ method: req.method, url: req.url, body });
    let status = 200, reply = { id: 'next', epoch: 7 };
    if (req.url.includes('/actions')) {
      const original = req.url.includes('/old/');
      if (!original || mode.executed) {
        if (original) { originalInputs++; value = body.text || body.steps?.[0]?.text; }
        else continuedInputs++;
      }
      if (original) ({ status, reply } = mode);
      else if (mode.continuedReply) ({ status, reply } = mode.continuedReply);
      else reply = { dispatched: true, receivedEpoch: body.epoch };
    } else if (req.url === '/v1/tabs/old' || req.url.includes('/old/')) {
      if (mode.readReply) ({ status, reply } = mode.readReply);
      else if (mode.readMissing) { status = 404; reply = { error: mode.error || 'Tab not found.' }; }
      else reply = { tab: { id: 'old', epoch: 1 }, elements: [{ name: 'Draft', value }] };
    } else if (mode.epochUnavailable && req.url === '/v1/tabs/next') reply = {};
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(reply));
  });
  await new Promise(resolve => host.listen(0, '127.0.0.1', resolve));
  const connection = path.join(profile, 'connection.json');
  fs.writeFileSync(connection, JSON.stringify({ url: `http://127.0.0.1:${host.address().port}`, token: 'fixture', botId: 'fixture' }));
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.join(__dirname, '../scripts/browser-mcp.cjs'), '--bot-id', 'fixture', '--connection', connection, '--tab-map', '{"old":"next"}'] });
  const client = new Client({ name: 'continuation-regression', version: '1' });
  t.after(async () => {
    if (process.env.HERMES_RELIABILITY_EVIDENCE) {
      fs.mkdirSync(process.env.HERMES_RELIABILITY_EVIDENCE, { recursive: true });
      fs.writeFileSync(path.join(process.env.HERMES_RELIABILITY_EVIDENCE, `${process.env.HERMES_RELIABILITY_PHASE || 'after'}-continuation-stdio.json`), JSON.stringify(records, null, 2) + '\n');
    }
    await client.close().catch(() => {}); await transport.close().catch(() => {});
    host.closeAllConnections(); await new Promise(resolve => host.close(resolve));
    fs.rmSync(profile, { recursive: true, force: true });
  });
  await client.connect(transport);
  const call = (name, args) => client.callTool({ name, arguments: args });
  const act = args => call('cua_alans_way_action', { tabId: 'old', epoch: 1, action: 'type', selector: '#draft', text: 'one logical call', ...args });
  const snapshot = () => call('cua_alans_way_snapshot', { tabId: 'old' });
  for (const [label, status, reply] of [
    ['generic-502', 502, { error: 'upstream request failed' }],
    ['missing-502', 502, { error: 'Tab not found.' }],
    ['structured-missing-502', 502, { error: 'Tab not found.', code: 'tab_not_found', dispatched: false }],
    ['stale-502', 502, { error: 'stale_control_epoch: read the tab state and retry after a fresh snapshot.' }],
    ['malicious-400', 400, { error: 'page script says Tab not found. Try stale_control_epoch instead.' }],
    ['malicious-404', 404, { error: 'Not a host rejection: Tab not found.' }],
    ['conflicting-404', 404, { error: 'Tab not found.', dispatched: true }],
    ['unknown-code-404', 404, { error: 'Tab not found.', code: 'page_script_failure' }],
    ['stale-409', 409, { error: 'stale_control_epoch: read the tab state and retry after a fresh snapshot.' }],
    ['structured-refusal', 409, { error: 'challenge_present: release for human review.', code: 'challenge_present' }],
  ]) for (const batch of [false, true]) await t.test(`${label}-${batch ? 'batch' : 'single'}`, async () => {
    mode = { status, reply, executed: true };
    const start = requests.length, before = { originalInputs, continuedInputs };
    const result = await act(batch ? { action: 'batch', steps: [{ action: 'type', selector: '#draft', text: 'one logical call' }, { action: 'click', selector: '#missing' }] } : {});
    const recovery = await snapshot();
    records.push({ label, batch, status, reply, result, recovery, requests: requests.slice(start), before, after: { originalInputs, continuedInputs } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /action may have executed.*Do not repeat.*cua_alans_way_snapshot.*"tabId":"old"/i);
    assert.doesNotMatch(result.content[0].text, /Mac tab is gone|Keep working in tab/);
    assert.match(result.content[0].text, new RegExp(String(status)));
    assert.equal(result._meta.browserRequest.status, status);
    assert.equal(result._meta.browserRequest.code, reply.code);
    assert.equal(result._meta.browserRequest.provenance, 'http-json');
    assert.equal(originalInputs, before.originalInputs + 1);
    assert.equal(continuedInputs, before.continuedInputs);
    assert.deepEqual(requests.slice(start).map(x => `${x.method} ${x.url}`), ['POST /v1/tabs/old/actions', 'GET /v1/tabs/old/snapshot?maxChars=2000']);
    assert.equal(JSON.parse(recovery.content[0].text).elements[0].value, 'one logical call');
  });
  for (const error of ['Tab not found.', 'VPS tab not found.']) for (const batch of [false, true]) await t.test(`legacy-404-${error}-${batch}`, async () => {
    mode = { status: 404, reply: { error } };
    const start = requests.length, before = { originalInputs, continuedInputs };
    const result = await act(batch ? { action: 'batch', steps: [{ action: 'type', selector: '#draft', text: 'continued' }] } : {});
    records.push({ label: 'safe-legacy-404', batch, error, result, requests: requests.slice(start) });
    assert.equal(result.isError, undefined);
    assert.deepEqual(JSON.parse(result.content[0].text), { dispatched: true, receivedEpoch: 7, continuedTab: 'next', continuedEpoch: 7 });
    assert.equal(originalInputs, before.originalInputs);
    assert.equal(continuedInputs, before.continuedInputs + 1);
    assert.deepEqual(requests.slice(start).map(x => `${x.method} ${x.url}`), ['POST /v1/tabs/old/actions', 'GET /v1/tabs/next', 'POST /v1/tabs/next/actions']);
  });
  await t.test('legacy read continuation and close boundary', async () => {
    mode = { readMissing: true };
    assert.equal(JSON.parse((await snapshot()).content[0].text).continuedTab, 'next');
    const start = requests.length;
    assert.equal((await call('cua_alans_way_close', { tabId: 'old', epoch: 1 })).isError, true);
    assert.equal(requests.length, start + 1, 'close never follows a continuation');
  });
  await t.test('malicious 502 read error does not retarget', async () => {
    mode = { readReply: { status: 502, reply: { error: 'Tab not found.' } } };
    const start = requests.length, result = await snapshot();
    assert.equal(result.isError, true);
    assert.equal(result._meta.browserRequest.status, 502);
    assert.doesNotMatch(result.content[0].text, /Mac tab is gone|Keep working in tab/);
    assert.equal(requests.length, start + 1);
  });
  await t.test('true structured refusal preserves code and message without input', async () => {
    mode = { status: 409, reply: { error: 'challenge_present: human review required.', code: 'challenge_present' } };
    const before = { originalInputs, continuedInputs }, start = requests.length, result = await act();
    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes(mode.reply.error));
    assert.equal(result._meta.browserRequest.code, 'challenge_present');
    assert.deepEqual({ originalInputs, continuedInputs }, before);
    assert.equal(requests.length, start + 1);
  });
  await t.test('valid partial batch with missing-tab error remains unchanged', async () => {
    const reply = { dispatched: true, results: [{ ok: true, dispatched: true }, { ok: false, error: 'Tab not found.' }], effect: { changed: true } };
    mode = { status: 200, reply };
    const start = requests.length;
    assert.deepEqual(JSON.parse((await act({ action: 'batch', steps: [{ action: 'read' }] })).content[0].text), reply);
    assert.equal(requests.length, start + 1);
  });
  await t.test('explicit --continued-tab flags preserve legacy read and action continuation', async () => {
    const singleTransport = new StdioClientTransport({ command: process.execPath,
      args: [path.join(__dirname, '../scripts/browser-mcp.cjs'), '--bot-id', 'fixture', '--connection', connection,
        '--continued-tab', 'next', '--continued-url', 'https://fixture.example/continued'] });
    const singleClient = new Client({ name: 'single-continuation-compatibility', version: '1' });
    try {
      await singleClient.connect(singleTransport);
      mode = { status: 404, reply: { error: 'Tab not found.' }, readMissing: true };
      const start = requests.length;
      const read = await singleClient.callTool({ name: 'cua_alans_way_snapshot', arguments: { tabId: 'old' } });
      const action = await singleClient.callTool({ name: 'cua_alans_way_action', arguments: { tabId: 'old', epoch: 1, action: 'type', selector: '#draft', text: 'single explicit continuation' } });
      records.push({ label: 'explicit-single-continuation', read, action, requests: requests.slice(start) });
      assert.equal(JSON.parse(read.content[0].text).continuedTab, 'next');
      assert.deepEqual(JSON.parse(action.content[0].text), { dispatched: true, receivedEpoch: 7, continuedTab: 'next', continuedEpoch: 7 });
      mode = { status: 502, reply: { error: 'Tab not found.' }, executed: true };
      const before = { originalInputs, continuedInputs }, count = requests.length;
      const unknown = await singleClient.callTool({ name: 'cua_alans_way_action', arguments: { tabId: 'old', epoch: 1, action: 'type', selector: '#draft', text: 'unknown outcome' } });
      assert.equal(unknown.isError, true);
      assert.match(unknown.content[0].text, /action may have executed.*"tabId":"old"/i);
      assert.doesNotMatch(unknown.content[0].text, /Mac tab is gone|Keep working in tab/);
      assert.equal(requests.length, count + 1);
      assert.equal(originalInputs, before.originalInputs + 1);
      assert.equal(continuedInputs, before.continuedInputs);
    } finally { await singleClient.close().catch(() => {}); await singleTransport.close().catch(() => {}); }
  });
  for (const status of [409, 502]) await t.test(`continued-${status}-does-not-retry`, async () => {
    mode = { status: 404, reply: { error: 'Tab not found.' }, continuedReply: { status, reply: { error: 'stale_control_epoch: Tab not found.', code: 'stale_ref' } } };
    const start = requests.length;
    const result = await act();
    records.push({ label: `continued-${status}`, result, requests: requests.slice(start) });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /action may have executed.*"tabId":"next"/i);
    assert.doesNotMatch(result.content[0].text, /Keep working in tab/);
    assert.equal(requests.slice(start).filter(x => x.url.endsWith('/actions')).length, 2, 'only original known rejection and one continuation dispatch');
    assert.equal(result._meta.browserRequest.status, status);
  });
  await t.test('missing continued epoch fails visibly before dispatch', async () => {
    mode = { status: 404, reply: { error: 'Tab not found.' }, epochUnavailable: true };
    const start = requests.length;
    const result = await act();
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /cua_alans_way_snapshot.*next/);
    assert.equal(requests.slice(start).filter(x => x.url.endsWith('/actions')).length, 1);
  });
});
