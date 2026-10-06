// Regression: an agent must type, click and capture without selecting its tab.
// Operates only a temporary localhost page and closes only its own tab.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const client = new Client({ name: 'background-browser-regression', version: '1' });
const actor = 'background-browser-regression';
const server = http.createServer((_req, res) => res.end(`<!doctype html><title>Background browser regression</title><style>body{font:20px system-ui;padding:40px}input,button{font:inherit;padding:12px}</style><form id="form"><label>Test phrase<input id="phrase" aria-label="Test phrase"></label><button>Confirm test</button></form><p id="result">Waiting</p><script>form.onsubmit=e=>{e.preventDefault();result.textContent='Confirmed: '+phrase.value}</script>`));
let tab, connection;
async function tool(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(!result.isError, result.content[0]?.text);
  return result.content[0].type === 'image' ? result.content[0] : JSON.parse(result.content[0].text);
}
async function snapshot() { return tool('cua_alans_way_snapshot', { tabId: tab.id }); }
async function poll(predicate) {
  for (let i = 0; i < 20; i++) { const snap = await snapshot(); if (predicate(snap)) return snap; await new Promise(r => setTimeout(r, 100)); }
  return snapshot();
}
(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  connection = JSON.parse(fs.readFileSync(process.env.HERMES_WORKSPACE_CONNECTION || path.join(os.homedir(), 'Library/Application Support/Hermes Workspace/connection.json'), 'utf8'));
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(__dirname, '../scripts/browser-mcp.cjs'), '--bot-id', actor], env: { ...process.env } }));
  tab = await tool('cua_alans_way_open', { url: `http://127.0.0.1:${server.address().port}`, background: true });
  let snap = await poll(s => s.elements.some(el => el.name === 'Test phrase'));
  for (const text of ['Discard this value', 'Background input works']) {
    await tool('cua_alans_way_action', { tabId: tab.id, epoch: tab.epoch, action: 'type', ref: snap.elements.find(el => el.name === 'Test phrase').ref, text });
    snap = await snapshot();
  }
  const typed = snap.elements.find(el => el.name === 'Test phrase').value;
  await tool('cua_alans_way_action', { tabId: tab.id, epoch: tab.epoch, action: 'click', ref: snap.elements.find(el => el.name === 'Confirm test').ref });
  snap = await poll(s => s.text.includes('Confirmed: Background input works'));
  let screenshot = false, screenshotError = '';
  try { const shot = await tool('cua_alans_way_screenshot', { tabId: tab.id, format: 'png' }); screenshot = shot.mimeType === 'image/png' && Buffer.from(shot.data, 'base64').length > 1000; }
  catch (error) { screenshotError = error.message; }
  const verdict = { replacementTyping: typed === 'Background input works', click: snap.text.includes('Confirmed: Background input works'), screenshot, screenshotError };
  console.log(JSON.stringify(verdict));
  assert.ok(verdict.replacementTyping && verdict.click && verdict.screenshot, 'Background browser actions failed');
  await tool('cua_alans_way_action', { tabId: tab.id, epoch: tab.epoch, action: 'type', ref: snap.elements.find(el => el.name === 'Test phrase').ref, text: 'Keyboard input works' });
  await tool('cua_alans_way_action', { tabId: tab.id, epoch: tab.epoch, action: 'press', key: 'Enter' });
  snap = await poll(s => s.text.includes('Confirmed: Keyboard input works'));
  assert.ok(snap.text.includes('Confirmed: Keyboard input works'), 'Background Enter key did not submit the form');
  console.log('PASS: background replacement typing, click, screenshot and Enter key through real MCP.');
})().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(async () => {
  if (tab) await fetch(new URL(`/v1/tabs/${tab.id}`, connection.url), { method: 'DELETE', headers: { Authorization: `Bearer ${connection.token}`, 'X-Hermes-Bot': actor, 'X-Control-Epoch': String(tab.epoch) } }).catch(() => {});
  await client.close().catch(() => {}); server.close();
});
