// Run against an open app: node test/browser-smoke.cjs
// Uses only its own local fixture. Never operates Telegram or third-party sites.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const readline = require('node:readline/promises');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const fixture = `<!doctype html><title>Workspace browser test</title><style>body{font:18px system-ui;padding:40px;background:#15151a;color:#eee}input,button{font:inherit;padding:12px;margin:6px}a{color:#aad}#result{margin:20px}</style><h1>Workspace browser test</h1><form id="form"><label>Test text <input id="text" aria-label="Test text"></label><button>Check input</button></form><div id="result">Waiting for test input</div><button id="popup">Open test popup</button><script>form.onsubmit=e=>{e.preventDefault();result.textContent='Confirmed: '+text.value};popup.onclick=()=>window.open('/popup','workspace-test-popup');document.cookie='workspace_fixture=shared;path=/';</script>`;
const fixtureServer = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end(req.url === '/popup' ? '<title>Workspace popup test</title><h1>Popup connected</h1><script>document.body.dataset.opener=!!window.opener;</script>' : req.url === '/cookie' ? `<title>Workspace cookie test</title><p>${(req.headers.cookie || '').includes('workspace_fixture=shared') ? 'Shared login profile verified' : 'No shared cookie'}</p>` : fixture);
});
const client = new Client({ name: 'workspace-smoke-test', version: '1' });
const botId = 'workspace-smoke';
let connection, created = [], rl;
async function api(route, method = 'GET', body, actor = botId, epoch) {
  const response = await fetch(new URL(route, connection.url), { method, headers: { Authorization: `Bearer ${connection.token}`, 'X-Hermes-Bot': actor, 'Content-Type': 'application/json', ...(epoch ? { 'X-Control-Epoch': String(epoch) } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, data: await response.json() };
}
async function tool(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  return result.content[0].type === 'image' ? result.content[0] : JSON.parse(result.content[0].text);
}
async function eventually(fn, predicate) {
  for (let i = 0; i < 60; i++) { const value = await fn(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 200)); }
  throw new Error('Timed out waiting for fixture state.');
}
(async () => {
  await new Promise(resolve => fixtureServer.listen(0, '127.0.0.1', resolve));
  connection = JSON.parse(fs.readFileSync(process.env.HERMES_WORKSPACE_CONNECTION || path.join(os.homedir(), 'Library/Application Support/Hermes Workspace/connection.json'), 'utf8'));
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [process.env.HERMES_WORKSPACE_MCP || path.join(__dirname, '../scripts/browser-mcp.cjs'), '--bot-id', botId], env: { ...process.env } }));
  assert.equal((await client.listTools()).tools.length, 6);
  assert.equal((await tool('cua_alans_way_status')).host, 'mac');
  const root = `http://127.0.0.1:${fixtureServer.address().port}`;
  const tab = await tool('cua_alans_way_open', { url: root }); created.push(tab.id);
  let snap = await eventually(() => tool('cua_alans_way_snapshot', { tabId: tab.id }), value => value.elements.some(el => el.name === 'Test text'));
  const input = snap.elements.find(el => el.name === 'Test text');
  await tool('cua_alans_way_action', { tabId: tab.id, epoch: tab.epoch, action: 'type', ref: input.ref, text: 'Local Chromium works' });
  snap = await tool('cua_alans_way_snapshot', { tabId: tab.id });
  assert.equal(snap.elements.find(el => el.name === 'Test text').value, 'Local Chromium works');
  const button = snap.elements.find(el => el.name === 'Check input');
  await tool('cua_alans_way_action', { tabId: tab.id, epoch: tab.epoch, action: 'click', ref: button.ref });
  snap = await eventually(() => tool('cua_alans_way_snapshot', { tabId: tab.id }), value => value.text.includes('Confirmed: Local Chromium works'));
  const screenshot = await tool('cua_alans_way_screenshot', { tabId: tab.id, format: 'png' });
  assert.equal(screenshot.mimeType, 'image/png'); assert.ok(Buffer.from(screenshot.data, 'base64').length > 1000);
  assert.equal((await api(`/v1/tabs/${tab.id}/snapshot`, 'GET', undefined, 'another-bot')).status, 403);
  assert.equal((await api(`/v1/tabs/${tab.id}/actions`, 'POST', { action: 'reload', epoch: tab.epoch + 99 })).status, 409);
  const cookieTab = await tool('cua_alans_way_open', { url: root + '/cookie', background: true }); created.push(cookieTab.id);
  await eventually(() => tool('cua_alans_way_snapshot', { tabId: cookieTab.id }), value => value.text.includes('Shared login profile verified'));
  snap = await tool('cua_alans_way_snapshot', { tabId: tab.id });
  await tool('cua_alans_way_action', { tabId: tab.id, epoch: tab.epoch, action: 'click', ref: snap.elements.find(el => el.name === 'Open test popup').ref });
  const popup = await eventually(() => tool('cua_alans_way_tabs'), value => value.tabs.some(item => item.url.endsWith('/popup')));
  const popupTab = popup.tabs.find(item => item.url.endsWith('/popup')); created.push(popupTab.id);
  await eventually(() => tool('cua_alans_way_snapshot', { tabId: popupTab.id }), value => value.text.includes('Popup connected'));
  console.log('PASS: MCP connection, snapshot, typing, click, screenshot, shared cookies, popup, bot ownership and stale epoch.');
  console.log('Select the Workspace popup test tab, then click “Take over”. Agent popups intentionally preserve your selected tab. Press Enter here afterward.');
  rl = readline.createInterface({ input: process.stdin, output: process.stdout }); await rl.question('');
  let result = await api(`/v1/tabs/${popupTab.id}/actions`, 'POST', { action: 'reload', epoch: popupTab.epoch });
  assert.equal(result.status, 409); assert.equal(result.data.error, 'human_has_control');
  console.log('PASS: human takeover blocks agent input. Click “Give to agent”, then press Enter to verify stale actions stay blocked.');
  await rl.question(''); rl.close();
  result = await api(`/v1/tabs/${popupTab.id}/actions`, 'POST', { action: 'reload', epoch: popupTab.epoch });
  assert.equal(result.status, 409); assert.match(result.data.error, /stale_control_epoch/);
  console.log('PASS: return to agent requires a new epoch.');
})().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(async () => {
  rl?.close();
  for (const id of created.reverse()) { const current = await api(`/v1/tabs/${id}`).catch(() => null); if (current?.data.controller === 'agent') await api(`/v1/tabs/${id}`, 'DELETE', undefined, botId, current.data.epoch).catch(() => {}); }
  await client.close().catch(() => {}); fixtureServer.close();
});
