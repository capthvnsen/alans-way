// Run: npx electron test/newtab-electron.cjs
// Uses an isolated profile and a localhost page. No Telegram sign-in required.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { app, BrowserWindow, webContents, session, nativeImage } = require('electron');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-workspace-newtab-'));
process.env.HERMES_WORKSPACE_DATA = profile;
process.env.HERMES_WORKSPACE_PORT = String(19000 + Math.floor(Math.random() * 10000));
require('../src/main.cjs');
const waitFor = async (read, predicate, timeout = 12000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (predicate(value)) return value; await new Promise(r => setTimeout(r, 50)); }
  throw new Error('Timed out waiting for new-tab state.');
};
let server;
app.whenReady().then(async () => {
  const win = await waitFor(() => BrowserWindow.getAllWindows()[0], win => !!win);
  const wc = win.webContents;
  const telegram = webContents.getAllWebContents().find(item => item.session === session.fromPartition('persist:telegram'));
  if (telegram) { telegram.stop(); await telegram.loadURL('about:blank'); }
  const evaluate = code => wc.executeJavaScript(code);
  await waitFor(() => evaluate('typeof window.workspace === "object"').catch(() => false), Boolean);
  const invoke = (name, value) => evaluate(`window.workspace.command(${JSON.stringify(name)}, ${JSON.stringify(value || {})})`);

  await waitFor(() => evaluate('!document.getElementById("home").classList.contains("hidden")'), Boolean);
  assert.equal(await evaluate('document.querySelectorAll("#tabs .tab").length'), 0, 'An empty workspace renders no Start chip.');
  assert.ok((await evaluate('getComputedStyle(document.getElementById("home")).backgroundImage')).includes('newtab-backdrop.png'), 'The empty state keeps the backdrop image.');

  const tab = await invoke('create-tab');
  const newtabWc = await waitFor(() => webContents.getAllWebContents().find(item => item !== wc && item.getURL().endsWith('/newtab.html')), Boolean);
  await waitFor(() => newtabWc.executeJavaScript('document.readyState === "complete"').catch(() => false), Boolean);
  let state = await evaluate('window.workspace.getState()');
  const current = state.tabs.find(item => item.id === tab.id);
  assert.ok(current.url.endsWith('/newtab.html'), `New tab loads the bundled page, got ${current.url}`);
  assert.equal(current.internal, true);
  assert.equal(current.title, 'New tab');
  await waitFor(() => evaluate('document.querySelectorAll("#tabs .tab").length'), count => count === 1);
  assert.ok(!(await evaluate('[...document.querySelectorAll("#tabs .tab-title")].some(el => el.textContent === "Start")')), 'No Start chip beside real tabs.');
  assert.equal(await evaluate('document.getElementById("address").value'), '', 'The address bar stays empty on the backdrop.');
  assert.ok(await evaluate('document.getElementById("home").classList.contains("hidden")'), 'The home empty state hides behind a real tab.');
  await invoke('control', { id: tab.id, controller: 'agent' });
  const connection = JSON.parse(fs.readFileSync(path.join(profile, 'connection.json')));
  const shot = await fetch(`${connection.url}/v1/tabs/${tab.id}/screenshot`, { headers: { Authorization: `Bearer ${connection.token}`, 'X-Hermes-Bot': 'shared' } });
  assert.equal(shot.status, 200, await shot.clone().text());
  const bitmap = nativeImage.createFromBuffer(Buffer.from((await shot.json()).base64, 'base64')).toBitmap();
  let bright = 0;
  for (let i = 0; i < bitmap.length; i += 4) if (bitmap[i] > 100) bright++;
  assert.ok(bright > 500, `The backdrop image renders inside the tab (${bright} bright pixels).`);

  server = http.createServer((req, res) => res.end('<title>fixture</title>'));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const httpTab = await invoke('create-tab', { url: `http://127.0.0.1:${server.address().port}` });
  const httpWc = await waitFor(() => webContents.getAllWebContents().find(item => item !== wc && item.getURL().startsWith('http://127.0.0.1')), Boolean);
  await invoke('navigate', { id: httpTab.id, url: 'about:blank' });
  await waitFor(() => httpWc.getURL(), url => url.endsWith('/newtab.html'));
  state = await evaluate('window.workspace.getState()');
  assert.equal(state.tabs.find(item => item.id === httpTab.id).internal, true, 'Navigating to about:blank resolves to the backdrop.');

  await invoke('close-tab', { id: httpTab.id });
  await invoke('close-tab', { id: tab.id });
  state = await evaluate('window.workspace.getState()');
  assert.equal(state.activeTabId, 'home', 'Closing the last tab returns to the empty backdrop state.');
  assert.equal(await evaluate('document.querySelectorAll("#tabs .tab").length'), 0);

  // Workspace chrome: compact header, equal-size caption controls, no removed labels.
  assert.equal(await evaluate('document.querySelectorAll(".workspace-header, .agent-browser-row, #restore-bots, .side-footnote, .workspace-label").length'), 0, 'Removed labels and the restore control are gone.');
  assert.ok(await evaluate('!!document.getElementById("browser-collapse") && !!document.getElementById("vm-toggle")'), 'Collapse and VM buttons exist.');
  assert.equal(await evaluate('document.getElementById("browser-collapse").parentElement.className'), 'pane-actions', 'Collapse sits beside VM in the tab bar actions.');
  assert.equal(await evaluate('document.getElementById("vm-toggle").parentElement.className'), 'pane-actions');
  const caps = await evaluate('["search-toggle","add-bot","sort-bots","bot-count"].map(id => { const r = document.getElementById(id).getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })');
  assert.ok(caps.every(size => size.w === caps[0].w && size.h === caps[0].h), `Caption controls share one size: ${JSON.stringify(caps)}`);
  assert.equal(await evaluate('document.getElementById("settings-button").closest(".agent-presence")?.id'), 'agent-presence', 'The settings gear lives inside the bot tile.');

  await invoke('settings', { showBrowser: false });
  await waitFor(() => evaluate('document.getElementById("shell").classList.contains("browser-hidden")'), Boolean);
  assert.equal((await evaluate('window.workspace.getState()')).showBrowser, false);
  assert.equal(await evaluate('document.querySelector(".workspace-pane").getBoundingClientRect().width'), 0, 'Hiding the browser collapses the workspace pane.');
  assert.ok(await evaluate('document.getElementById("browser-collapse").getBoundingClientRect().width > 0'), 'The collapse button stays pinned when hidden.');
  assert.ok(await evaluate('document.getElementById("vm-toggle").getBoundingClientRect().width > 0'), 'The VM button stays pinned when hidden.');
  assert.ok(await evaluate('document.querySelector(".chat-pane").getBoundingClientRect().width > innerWidth - 320'), 'The chat pane expands into the freed space.');

  // Collapsing the bot list while the browser is hidden must not break the grid.
  await invoke('settings', { showBots: false });
  await waitFor(() => evaluate('document.getElementById("shell").classList.contains("bots-hidden")'), Boolean);
  assert.ok(await evaluate('document.querySelector(".chat-pane").getBoundingClientRect().width > innerWidth - 100'), 'Both collapses together leave chat full-width.');
  assert.ok(await evaluate('document.getElementById("browser-collapse").getBoundingClientRect().width > 0'), 'Pinned controls survive the combined collapse.');
  await invoke('settings', { showBots: true });

  await evaluate('document.getElementById("browser-collapse").click()');
  await waitFor(() => evaluate('!document.getElementById("shell").classList.contains("browser-hidden")'), Boolean);
  assert.equal((await evaluate('window.workspace.getState()')).showBrowser, true, 'The pinned button restores the browser pane.');

  // A page that closes itself (OAuth popups end with window.close()) must drop
  // its tab instead of leaving a zombie that crashes the next savePreferences.
  const doomed = await invoke('create-tab');
  const doomedWc = await waitFor(() => webContents.getAllWebContents().find(item => item !== wc && item.getURL().endsWith('/newtab.html')), Boolean);
  doomedWc.destroy();
  state = await waitFor(() => evaluate('window.workspace.getState()'), s => s.tabs.every(t => t.id !== doomed.id));
  assert.equal(state.activeTabId, 'home', 'A self-closed page drops its tab cleanly.');
  const saved = JSON.parse(fs.readFileSync(path.join(profile, 'preferences.json'), 'utf8'));
  assert.equal(saved.savedTabs.length, 0, 'Destroyed tabs are not persisted.');

  console.log('PASS: new tabs open on the Hermes backdrop, no Start chip, empty state keeps the image, workspace chrome is compact.');
  server.close(); app.quit();
}).catch(error => { console.error(error.stack); server?.close(); app.exit(1); });
