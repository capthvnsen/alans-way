// Run: node test/run-electron.cjs test/browser-reliability-electron.cjs
// Real app + stdio MCP, isolated profile, localhost fixture and fault proxy only.
// Optional HERMES_RELIABILITY_EVIDENCE directory saves tool receipts/benchmarks.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { app, BrowserWindow, webContents } = require('electron');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { prepareFixture, quitFixture } = require('./electron-fixture.cjs');
const profile = process.env.HERMES_TEST_PROFILE || fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-browser-reliability-'));
prepareFixture(profile);
process.env.HERMES_WORKSPACE_ALLOW_LOOPBACK = '1';
fs.writeFileSync(path.join(profile, 'preferences.json'), JSON.stringify({ onboarded: true, preview: false,
  bots: [{ id: '4242', isBot: true, name: 'Reliability fixture' }], selectedBotId: '4242' }));
require('../src/main.cjs');

const evidence = process.env.HERMES_RELIABILITY_EVIDENCE;
const phase = process.env.HERMES_RELIABILITY_PHASE === 'before' ? 'before' : 'after';
const receipts = [], measurements = [], checks = [];
let evidenceState = {};
let fixture, proxy, client, transport, human;
const waitFor = async (read, predicate, timeout = 12000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error('Timed out waiting for isolated reliability fixture.');
};
async function call(name, args = {}, label = name) {
  const started = performance.now();
  // Observe the connector's own 90s action deadline, beyond the SDK default.
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 105000 });
  const elapsedMs = Math.round((performance.now() - started) * 100) / 100;
  measurements.push({ operation: label, elapsedMs, isError: result.isError === true });
  receipts.push({ operation: label, result });
  return result;
}
function check(label, passed, detail) {
  checks.push({ label, passed: !!passed, detail });
  saveEvidence();
}
function data(result) {
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  return JSON.parse(result.content[0].text);
}
function saveEvidence(extra) {
  if (!evidence) return;
  evidenceState = { ...evidenceState, ...extra };
  fs.mkdirSync(evidence, { recursive: true });
  fs.writeFileSync(path.join(evidence, `${phase}-tools.json`), JSON.stringify(receipts, null, 2) + '\n');
  fs.writeFileSync(path.join(evidence, `${phase}-benchmark.json`), JSON.stringify({
    scope: 'Local isolated Electron app and actual stdio MCP; not authenticated remote Hermes execution',
    phase, measurements, checks, ...evidenceState,
  }, null, 2) + '\n');
}

app.whenReady().then(async () => {
  await waitFor(() => BrowserWindow.getAllWindows()[0], Boolean);
  const connection = JSON.parse(await waitFor(() => {
    try { return fs.readFileSync(path.join(profile, 'connection.json'), 'utf8'); } catch { return ''; }
  }, Boolean));
  fixture = http.createServer((_req, res) => res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }).end(`<!doctype html>
    <title>Browser reliability fixture</title><style>body{font:20px system-ui;padding:32px;background:#f5f7fb;color:#152233}input{font:inherit;padding:10px;width:430px}</style>
    <h1>Browser reliability fixture</h1><label>Draft <input id="draft" aria-label="Draft"></label>
    <p id="count">Input events: 0</p><p>Local fixture only. No submission.</p>
    <script>window.inputEvents=0;window.events=[];draft.addEventListener('input',e=>{events.push({value:draft.value,trusted:e.isTrusted});count.textContent='Input events: '+(++inputEvents)})</script>`));
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const fixtureUrl = `http://127.0.0.1:${fixture.address().port}/`;
  let fault = null;
  const actionRequests = [], forwarded = [];
  proxy = http.createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      if (req.url.endsWith('/actions')) actionRequests.push(JSON.parse(raw));
      const mode = fault;
      fault = null;
      if (mode === 'headers-reset') return res.destroy();
      const upstream = await fetch(new URL(req.url, connection.url), {
        method: req.method, headers: {
          Authorization: `Bearer ${connection.token}`, 'X-Hermes-Bot': '4242',
          'Content-Type': 'application/json', ...(req.headers['x-control-epoch'] ? { 'X-Control-Epoch': req.headers['x-control-epoch'] } : {}),
        }, ...(raw ? { body: raw } : {}), signal: AbortSignal.timeout(35000),
      });
      const body = await upstream.text();
      if (req.url.endsWith('/actions')) forwarded.push({ body: JSON.parse(raw), status: upstream.status, receipt: JSON.parse(body) });
      if (mode === 'transport-disconnect') return res.destroy();
      res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
      if (mode === 'empty') return res.end();
      if (mode === 'null') return res.end('null');
      if (mode === 'truncated') return res.end(body.slice(0, Math.max(1, Math.floor(body.length / 2))));
      if (mode === 'html') return res.end('<html>gateway receipt missing</html>');
      if (mode === 'body-reset' || mode === 'body-stall') {
        // The actual app has already completed the request; only its receipt
        // is lost. This distinguishes an uncertain action from one not run.
        res.write(body.slice(0, Math.max(1, Math.floor(body.length / 2))));
        if (mode === 'body-reset') setTimeout(() => res.destroy(), 20);
        return;
      }
      res.end(body);
    } catch (error) { res.destroy(error); }
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const proxyConnection = path.join(profile, 'fault-proxy.json');
  fs.writeFileSync(proxyConnection, JSON.stringify({ url: `http://127.0.0.1:${proxy.address().port}`, token: 'isolated-fixture-token', protocol: 1 }));
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [process.env.HERMES_RELIABILITY_CONNECTOR || path.join(__dirname, '../scripts/browser-mcp.cjs'), '--bot-id', '4242', '--connection', proxyConnection],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  client = new Client({ name: 'isolated-browser-reliability', version: '1' });
  await client.connect(transport);
  data(await call('cua_alans_way_status'));
  const tab = data(await call('cua_alans_way_open', { url: fixtureUrl }));
  let snapshot = data(await call('cua_alans_way_snapshot', { tabId: tab.id }));
  assert.ok(snapshot.elements.find(el => el.name === 'Draft'), 'real Chromium snapshot must issue the input ref');
  const page = await waitFor(() => webContents.getAllWebContents().find(wc => wc.getURL() === fixtureUrl), Boolean);
  const observe = () => page.executeJavaScript('({ value: draft.value, inputEvents, events: JSON.parse(JSON.stringify(events)) })');
  human = new BrowserWindow({ width: 650, height: 280, show: true });
  await human.loadURL('data:text/html,<title>Round2 human focus sentinel</title><h1>Human draft must remain intact</h1><input id="human" value="human private draft">');
  human.focus(); human.webContents.focus();
  await human.webContents.executeJavaScript('human.focus();human.setSelectionRange(2,6)');
  const humanState = () => human.webContents.executeJavaScript('({value:human.value,focus:document.activeElement.id,start:human.selectionStart,end:human.selectionEnd})');
  const initialHuman = await humanState();
  const focusObservations = [];
  const humanIntact = async () => {
    const state = await humanState();
    const focusedContentsId = webContents.getFocusedWebContents()?.id ?? null;
    focusObservations.push({ focusedContentsId, expectedContentsId: human.webContents.id,
      focusedWindowId: BrowserWindow.getFocusedWindow()?.id ?? null, sentinelWindowId: human.id, state });
    saveEvidence({ focusObservations });
    return focusedContentsId === human.webContents.id && JSON.stringify(state) === JSON.stringify(initialHuman);
  };
  const captureFixture = async (name) => {
    const shot = await call('cua_alans_way_screenshot', { tabId: tab.id, format: 'png' }, name);
    assert.equal(shot.isError, undefined, JSON.stringify(shot.content));
    fs.writeFileSync(path.join(evidence, `${phase}-${name}.png`), Buffer.from(shot.content.find(item => item.type === 'image').data, 'base64'));
  };
  check('native human focus established', await humanIntact());
  if (evidence) {
    fs.mkdirSync(evidence, { recursive: true });
    await captureFixture('fixture-initial');
  }
  for (const mode of ['empty', 'null', 'truncated', 'html', 'body-reset', 'transport-disconnect', 'body-stall']) {
    const before = await observe(), requestsBefore = actionRequests.length, forwardedBefore = forwarded.length;
    const text = `Receipt ${mode}; input ran once`;
    fault = mode;
    const pending = call('cua_alans_way_action', { tabId: tab.id, epoch: snapshot.tab.epoch,
      action: 'type', selector: '#draft', text }, `executed-action-${mode}`);
    if (mode === 'body-stall') {
      await waitFor(() => forwarded.length, count => count === forwardedBefore + 1);
      const concurrent = data(await call('cua_alans_way_snapshot', { tabId: tab.id }, 'snapshot-during-stalled-action'));
      check('concurrent snapshot recovers executed stalled input', concurrent.elements.find(el => el.name === 'Draft')?.value === text && concurrent.tab.epoch === snapshot.tab.epoch);
      saveEvidence({ actionRequests, forwarded, observed: await observe() });
    }
    const receipt = await pending;
    snapshot = data(await call('cua_alans_way_snapshot', { tabId: tab.id }, `snapshot-after-${mode}`));
    const observed = await observe();
    const errorText = receipt.content?.find(item => item.type === 'text')?.text || '';
    check(`${mode}: honest uncertain error`, receipt.isError === true && /action may have executed/i.test(errorText) && /do not repeat/i.test(errorText) && errorText.includes('cua_alans_way_snapshot') && errorText.includes(JSON.stringify({ tabId: tab.id })) && !/cancelled|canceled/i.test(errorText), receipt);
    check(`${mode}: one trusted input and no replay`, observed.value === text && observed.inputEvents === before.inputEvents + 1 && observed.events.at(-1).trusted && actionRequests.length === requestsBefore + 1 && forwarded.length === forwardedBefore + 1, { observed, requests: actionRequests.length - requestsBefore, forwarded: forwarded.length - forwardedBefore });
    check(`${mode}: snapshot recovers value and epoch`, snapshot.elements.find(el => el.name === 'Draft')?.value === text && Number.isInteger(snapshot.tab.epoch) && snapshot.tab.epoch === tab.epoch);
    check(`${mode}: human focus and draft preserved`, await humanIntact());
    const elapsedMs = measurements.find(item => item.operation === `executed-action-${mode}`).elapsedMs;
    check(`${mode}: response deadline bounded`, mode === 'body-stall' ? elapsedMs >= 89000 && elapsedMs < 95000 : elapsedMs < 5000, { elapsedMs });
    saveEvidence({ observed, actionRequests, forwarded });
  }
  if (evidence) {
    await captureFixture('fixture');
    fs.writeFileSync(path.join(evidence, `${phase}-human-focus.png`), (await human.webContents.capturePage()).toPNG());
    check('screenshots preserve native human focus', await humanIntact());
  }
  fault = 'headers-reset';
  const unavailable = await call('cua_alans_way_status', {}, 'disconnect-before-headers');
  fault = 'body-stall';
  const timeout = await call('cua_alans_way_status', {}, 'stalled-response-body-25s-deadline');
  data(await call('cua_alans_way_status', {}, 'read-after-timeout'));
  saveEvidence({ observed: await observe(), actionRequests, forwarded });
  // Keep the assertions after capture so fail-before evidence includes the
  // exact tool errors, actual page effect, recovery and elapsed deadline.
  for (const result of [unavailable, timeout]) {
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Configured browser unavailable or timed out\. Inspect existing task state before retrying an action\./);
  }
  for (const label of ['disconnect-before-headers', 'read-after-timeout']) {
    assert.ok(measurements.find(m => m.operation === label).elapsedMs < 5000, `${label} must return promptly`);
  }
  const deadlineMs = measurements.find(m => m.operation === 'stalled-response-body-25s-deadline').elapsedMs;
  assert.ok(deadlineMs >= 24000 && deadlineMs < 30000, `25s read deadline took ${deadlineMs}ms`);
  assert.ok(checks.every(item => item.passed), JSON.stringify(checks.filter(item => !item.passed)));
  console.log('PASS: seven executed-action receipt faults report explicit uncertainty, input runs once per fault, snapshots recover, native human focus stays intact, and 25s/90s deadlines remain bounded.');
  console.log(JSON.stringify({ measurements, observed: await observe(), actionRequests: actionRequests.length, forwarded: forwarded.length, checks }));
}).catch(error => {
  saveEvidence({ failure: error.message });
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  await client?.close().catch(() => {});
  await transport?.close().catch(() => {});
  human?.destroy();
  quitFixture(fixture, proxy);
  if (process.exitCode) app.exit(process.exitCode);
});
