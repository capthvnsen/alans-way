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
  assert.equal(shot.status, 200);
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
  console.log('PASS: new tabs open on the Hermes backdrop, no Start chip, empty state keeps the image.');
  server.close(); app.quit();
}).catch(error => { console.error(error.stack); server?.close(); app.exit(1); });
