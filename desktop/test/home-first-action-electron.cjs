// Run: node test/run-electron.cjs test/home-first-action-electron.cjs
// Home (empty workspace) surface: the first action names the selected agent in
// visible text, hands it a real page through the existing create-tab + control
// commands, and the URL input takes keyboard focus when home appears.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { app, BrowserWindow } = require('electron');
const profile = process.env.HERMES_TEST_PROFILE || fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-workspace-home-'));
const { prepareFixture, quitFixture } = require('./electron-fixture.cjs');
prepareFixture(profile);
fs.writeFileSync(path.join(profile, 'preferences.json'), JSON.stringify({
  onboarded: true,
  bots: [{ id: '88001', name: 'Research assistant', username: 'home_research_bot' }, { id: '88002', name: 'Planning assistant', username: 'home_planning_bot' }],
  selectedBotId: '88001', order: ['88001', '88002'], hidden: [], preview: false,
}));
const calls = [];
const { ipcMain } = require('electron');
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => handle(channel, channel !== 'workspace:command' ? handler : (event, name, value) => { calls.push(name); return handler(event, name, value); });
require('../src/main.cjs');
const waitFor = async (read, predicate, timeout = 12000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (predicate(value)) return value; await new Promise(r => setTimeout(r, 50)); }
  throw new Error('Timed out waiting for home state.');
};
let server;
app.whenReady().then(async () => {
  server = http.createServer((req, res) => res.end('<title>fixture doc</title>'));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const win = await waitFor(() => BrowserWindow.getAllWindows()[0], win => !!win);
  const evaluate = code => win.webContents.executeJavaScript(code);
  await waitFor(() => evaluate('typeof window.workspace === "object"').catch(() => false), Boolean);
  const invoke = (name, value) => evaluate(`window.workspace.command(${JSON.stringify(name)}, ${JSON.stringify(value || {})})`);
  await waitFor(() => evaluate('!document.getElementById("home").classList.contains("hidden")'), Boolean);

  assert.equal(await evaluate('document.activeElement.id'), 'home-address', 'The URL input takes focus when home appears.');
  assert.match(await evaluate('document.getElementById("home-copy").textContent'), /Research assistant/, 'Home names the selected agent.');
  const agent = await evaluate('(()=>{const e=document.getElementById("home-agent");const r=e.getBoundingClientRect();return {hidden:e.classList.contains("hidden"),label:e.getAttribute("aria-label"),title:e.title,text:e.textContent.trim(),visible:r.width>0&&r.height>0}})()');
  assert.equal(agent.hidden, false, 'The agent page action shows when a bot is selected.');
  assert.match(agent.label + agent.title, /Research assistant/);
  assert.match(agent.text, /Open a page for\s+Research assistant/, 'The agent action names its target in visible text, not only a tooltip.');
  assert.ok(agent.visible, 'The labeled agent action is rendered on screen.');

  const before = calls.length;
  await evaluate('document.getElementById("home-agent").click()');
  await waitFor(() => evaluate('window.workspace.getState()'), s => s.tabs.length === 1);
  assert.deepEqual(calls.slice(before, before + 2), ['create-tab', 'control'], 'The agent action creates a tab then hands it over.');
  let tab = (await evaluate('window.workspace.getState()')).tabs[0];
  assert.equal(tab.controller, 'agent', 'The new page starts agent-controlled.');
  assert.equal(tab.botId, '88001', 'The page belongs to the selected bot.');
  assert.ok(await evaluate('document.getElementById("home").classList.contains("hidden")'), 'Home yields to the new tab.');

  await invoke('close-tab', { id: tab.id });
  await waitFor(() => evaluate('window.workspace.getState()'), s => s.tabs.length === 0);
  assert.ok(await evaluate('!document.getElementById("home").classList.contains("hidden")'), 'Closing the last tab returns home.');

  await evaluate(`document.getElementById("home-address").value="http://127.0.0.1:${server.address().port}/doc"`);
  await evaluate('document.getElementById("home-search").requestSubmit()');
  await waitFor(() => evaluate('window.workspace.getState()'), s => s.tabs.length === 1 && s.tabs[0].url.includes('/doc'));
  tab = (await evaluate('window.workspace.getState()')).tabs[0];
  assert.equal(tab.controller, 'human', 'The URL bar keeps its existing human-owned navigation.');
  await invoke('close-tab', { id: tab.id });
  await waitFor(() => evaluate('window.workspace.getState()'), s => s.tabs.length === 0);

  await invoke('open-bot', { id: '88002' });
  await waitFor(() => evaluate('document.getElementById("home-agent").title'), t => /Planning assistant/.test(t));
  assert.match(await evaluate('document.getElementById("home-agent").textContent'), /Planning assistant/, 'The visible label follows the newly selected agent.');
  assert.match(await evaluate('document.getElementById("home-copy").textContent'), /Planning assistant/, 'Copy follows the newly selected agent.');

  console.log('PASS: home names the selected agent, hands it a real page, keeps URL navigation human, focuses the input.');
  quitFixture(server);
}).catch(error => { console.error(error.stack); server?.close(); app.exit(1); });
