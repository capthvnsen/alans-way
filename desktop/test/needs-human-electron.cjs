// Run: npx electron test/needs-human-electron.cjs
// Uses an isolated profile and a localhost page. No Telegram sign-in required.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { app, BrowserWindow, webContents, session, Notification } = require('electron');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-workspace-needs-human-'));
process.env.HERMES_WORKSPACE_DATA = profile;
fs.writeFileSync(path.join(profile, 'preferences.json'), JSON.stringify({ onboarded: true, preview: false,
  bots: [{ id: '4242', isBot: true, name: 'Scout' }], selectedBotId: '4242' }));
process.env.HERMES_WORKSPACE_PORT = String(19000 + Math.floor(Math.random() * 10000));
// Notifications are recorded instead of shown, so the run never touches the OS notification center.
const shown = [];
Notification.prototype.show = function show() { shown.push(this); };
require('../src/main.cjs');
const waitFor = async (read, predicate, timeout = 12000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (predicate(value)) return value; await new Promise(r => setTimeout(r, 50)); }
  throw new Error('Timed out waiting for needs-human state.');
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
  const getState = () => evaluate('window.workspace.getState()');
  const connection = JSON.parse(await waitFor(() => { try { return fs.readFileSync(path.join(profile, 'connection.json'), 'utf8'); } catch { return ''; } }, Boolean));
  const api = async (endpoint, method = 'GET', body, epoch) => {
    const res = await fetch(`${connection.url}${endpoint}`, { method, headers: { Authorization: `Bearer ${connection.token}`, 'X-Hermes-Bot': '4242',
      ...(epoch !== undefined ? { 'X-Control-Epoch': String(epoch) } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, data: await res.json() };
  };

  server = http.createServer((req, res) => res.end('<title>checkout</title><p>Prove you are human</p>'));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const tab = await invoke('create-tab', { url: `http://127.0.0.1:${server.address().port}/` });
  const pageWc = await waitFor(() => webContents.getAllWebContents().find(item => item.getURL().startsWith('http://127.0.0.1')), Boolean);
  await waitFor(() => pageWc.executeJavaScript('document.readyState === "complete"').catch(() => false), Boolean);
  await invoke('control', { id: tab.id, controller: 'agent' });
  const other = await invoke('create-tab');
  assert.equal((await getState()).activeTabId, other.id);

  const note = '<img src=x onerror="window.pwned=1">Solve the puzzle';
  assert.equal((await api(`/v1/tabs/${tab.id}/control`, 'POST', { controller: 'human', reason: 'bogus' })).status, 400, 'an unknown reason is refused');
  const released = await api(`/v1/tabs/${tab.id}/control`, 'POST', { controller: 'human', reason: 'captcha', note });
  assert.equal(released.status, 200, JSON.stringify(released.data));
  assert.equal(released.data.handback.state, 'awaiting_human');
  const releasedEpoch = released.data.epoch;

  // One notification; the tab strip badges the tab the human is not looking at.
  assert.equal(shown.length, 1, 'the release fires one notification');
  assert.equal(shown[0].title, 'Scout needs you');
  assert.equal(shown[0].body, note, 'the notification carries the note as plain text');
  await waitFor(() => evaluate('document.querySelectorAll("#tabs .needs-you-badge").length'), count => count === 1);
  assert.ok(await evaluate('document.getElementById("needs-you-banner").classList.contains("hidden")'), 'the banner belongs to the tab on screen');

  // While the human has it, the bot cannot claim, read or act.
  const claim = await api(`/v1/tabs/${tab.id}/control`, 'POST', { controller: 'agent' });
  assert.equal(claim.status, 409); assert.match(claim.data.error, /^awaiting_human/);
  const read = await api(`/v1/tabs/${tab.id}/snapshot`);
  assert.equal(read.status, 409); assert.match(read.data.error, /^awaiting_human/);
  const act = await api(`/v1/tabs/${tab.id}/actions`, 'POST', { action: 'read', epoch: releasedEpoch });
  assert.equal(act.status, 409); assert.match(act.data.error, /^awaiting_human/);
  assert.equal((await api(`/v1/tabs/${tab.id}/control`, 'POST', { controller: 'human' })).data.handback.state, 'awaiting_human', 'a plain release cannot lift the hold');
  await api(`/v1/tabs/${tab.id}/control`, 'POST', { controller: 'human', reason: 'captcha', note });
  assert.equal(shown.length, 1, 'repeating the release does not notify again');

  // Clicking the notification brings that tab forward with the banner in the
  // app chrome, reopening a collapsed browser pane.
  await invoke('settings', { showBrowser: false });
  shown[0].emit('click');
  await waitFor(getState, state => state.activeTabId === tab.id && state.showBrowser === true);
  await waitFor(() => evaluate('!document.getElementById("needs-you-banner").classList.contains("hidden")'), Boolean);
  assert.equal(await evaluate('document.getElementById("needs-you-text").textContent'), `Scout needs you: ${note}`);
  assert.equal(await evaluate('document.querySelectorAll("#needs-you-banner img").length'), 0, 'the note is escaped, not parsed as HTML');
  assert.equal(await evaluate('window.pwned'), undefined);
  assert.equal(await pageWc.executeJavaScript('document.body.innerText.includes("needs you")'), false, 'nothing is injected into the page');
  assert.equal(await evaluate('document.getElementById("needs-you-give-back").textContent'), 'Give back to agent');

  // Give back: the bot hears human_returned, then claims with a fresh epoch.
  await evaluate('document.getElementById("needs-you-give-back").click()');
  await waitFor(getState, state => state.tabs.find(item => item.id === tab.id).controller === 'agent');
  await waitFor(() => evaluate('document.getElementById("needs-you-banner").classList.contains("hidden")'), Boolean);
  assert.equal(await evaluate('document.querySelectorAll("#tabs .needs-you-badge").length'), 0);
  const stale = await api(`/v1/tabs/${tab.id}/actions`, 'POST', { action: 'read', epoch: releasedEpoch });
  assert.equal(stale.status, 409); assert.match(stale.data.error, /^human_returned/);
  assert.equal((await api(`/v1/tabs/${tab.id}`)).data.handback.state, 'human_returned');
  const reclaimed = await api(`/v1/tabs/${tab.id}/control`, 'POST', { controller: 'agent' });
  assert.equal(reclaimed.status, 200, JSON.stringify(reclaimed.data));
  assert.ok(reclaimed.data.epoch > releasedEpoch + 1, 'the claim returns a fresh epoch');
  assert.equal(reclaimed.data.handback, null);
  const fresh = await api(`/v1/tabs/${tab.id}/actions`, 'POST', { action: 'read', epoch: reclaimed.data.epoch });
  assert.equal(fresh.status, 200, JSON.stringify(fresh.data));

  // A plain release stays retakeable, as before.
  await api(`/v1/tabs/${tab.id}/control`, 'POST', { controller: 'human' });
  assert.equal((await api(`/v1/tabs/${tab.id}/control`, 'POST', { controller: 'agent' })).status, 200);
  assert.equal(shown.length, 1);

  console.log('PASS: a release with a reason badges the tab, shows an escaped banner, notifies once, and holds the tab until the human gives it back.');
  server.close(); app.quit();
}).catch(error => { console.error(error.stack); server?.close(); app.exit(1); });
