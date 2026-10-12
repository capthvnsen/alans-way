// Run: npx electron test/auto-takeover-electron.cjs
// Uses an isolated profile and a localhost page. No Telegram sign-in required.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { app, BrowserWindow, webContents, session } = require('electron');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-workspace-auto-takeover-'));
process.env.HERMES_WORKSPACE_DATA = profile;
fs.writeFileSync(path.join(profile, 'preferences.json'), JSON.stringify({ onboarded: true, preview: false,
  bots: [{ id: '4242', isBot: true, name: 'Scout' }], selectedBotId: '4242' }));
process.env.HERMES_WORKSPACE_PORT = String(19000 + Math.floor(Math.random() * 10000));
require('../src/main.cjs');
const waitFor = async (read, predicate, timeout = 12000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (predicate(value)) return value; await new Promise(r => setTimeout(r, 50)); }
  throw new Error('Timed out waiting for takeover state.');
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
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
  const api = async (endpoint, method = 'GET', body) => {
    const res = await fetch(`${connection.url}${endpoint}`, { method, headers: { Authorization: `Bearer ${connection.token}`, 'X-Hermes-Bot': '4242',
      ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, data: await res.json() };
  };
  const banner = () => evaluate('document.getElementById("takeover-banner").classList.contains("hidden") ? "" : document.getElementById("takeover-text").textContent');
  const controller = async id => (await getState()).tabs.find(item => item.id === id).controller;

  server = http.createServer((req, res) => res.end('<title>form</title><input id="q" autofocus>'));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const tab = await invoke('create-tab', { url: `http://127.0.0.1:${server.address().port}/` });
  const pageWc = await waitFor(() => webContents.getAllWebContents().find(item => item.getURL().startsWith('http://127.0.0.1')), Boolean);
  await waitFor(() => pageWc.executeJavaScript('document.readyState === "complete"').catch(() => false), Boolean);
  assert.equal((await getState()).autoTakeover, true, 'on by default');
  const agentEpoch = (await invoke('control', { id: tab.id, controller: 'agent' })).epoch;

  // The human takes over; the bot acts with the epoch it reads. The action waits
  // out the 3 second grace after the Take over press, then runs on a fresh epoch.
  const humanEpoch = (await invoke('control', { id: tab.id, controller: 'human' })).epoch;
  assert.equal((await api(`/v1/tabs/${tab.id}`)).data.epoch, humanEpoch);
  let started = Date.now();
  const act = await api(`/v1/tabs/${tab.id}/actions`, 'POST', { action: 'read', epoch: humanEpoch });
  assert.equal(act.status, 200, JSON.stringify(act.data));
  assert.ok(Date.now() - started >= 2500, `the action waited for the human to pause (${Date.now() - started}ms)`);
  const taken = (await getState()).tabs.find(item => item.id === tab.id);
  assert.equal(taken.controller, 'agent');
  assert.equal(taken.epoch, humanEpoch + 1, 'the takeover bumps the epoch');
  assert.equal(await waitFor(banner, Boolean), 'Scout took over this tab');
  assert.equal(await evaluate('document.getElementById("takeover-take-back").textContent'), 'Take back');

  // Take back returns the tab to the human, who keeps it while typing on the page.
  await evaluate('document.getElementById("takeover-take-back").click()');
  await waitFor(() => controller(tab.id), value => value === 'human');
  assert.equal(await waitFor(banner, value => value === ''), '');
  await sleep(3100);
  pageWc.focus();
  pageWc.sendInputEvent({ type: 'keyDown', keyCode: 'a' });
  pageWc.sendInputEvent({ type: 'char', keyCode: 'a' });
  pageWc.sendInputEvent({ type: 'keyUp', keyCode: 'a' });
  await sleep(100);
  started = Date.now();
  const claimed = await api(`/v1/tabs/${tab.id}/control`, 'POST', { controller: 'agent' });
  assert.equal(claimed.status, 200, JSON.stringify(claimed.data));
  assert.ok(Date.now() - started >= 2500, `a key on the page holds the claim (${Date.now() - started}ms)`);
  assert.equal(claimed.data.controller, 'agent');

  // An epoch from before the human took over still takes the tab, then answers stale.
  await evaluate('document.getElementById("takeover-take-back").click()');
  await waitFor(() => controller(tab.id), value => value === 'human');
  await sleep(3100);
  const stale = await api(`/v1/tabs/${tab.id}/actions`, 'POST', { action: 'read', epoch: agentEpoch });
  assert.equal(stale.status, 409); assert.match(stale.data.error, /^stale_control_epoch/);
  assert.equal(await controller(tab.id), 'agent');

  // A recording keeps the tab the human's, without the grace wait.
  await invoke('control', { id: tab.id, controller: 'human' });
  await invoke('record-start', { id: tab.id });
  started = Date.now();
  const recordingClaim = await api(`/v1/tabs/${tab.id}/control`, 'POST', { controller: 'agent' });
  assert.equal(recordingClaim.status, 409); assert.match(recordingClaim.data.error, /^recording_in_progress/);
  const recordingAct = await api(`/v1/tabs/${tab.id}/actions`, 'POST', { action: 'read', epoch: (await api(`/v1/tabs/${tab.id}`)).data.epoch });
  assert.equal(recordingAct.status, 409); assert.match(recordingAct.data.error, /^recording_in_progress/);
  assert.ok(Date.now() - started < 1000, 'a refusal does not wait');
  assert.equal(await controller(tab.id), 'human');
  assert.ok((await getState()).recording, 'the recording keeps running');
  await invoke('record-stop', { save: false });

  // The setting off brings the refusal back.
  await invoke('settings', { autoTakeover: false });
  assert.equal((await getState()).autoTakeover, false);
  const refusedClaim = await api(`/v1/tabs/${tab.id}/control`, 'POST', { controller: 'agent' });
  assert.equal(refusedClaim.status, 409); assert.match(refusedClaim.data.error, /^human_has_control/);
  const refusedAct = await api(`/v1/tabs/${tab.id}/actions`, 'POST', { action: 'read', epoch: (await api(`/v1/tabs/${tab.id}`)).data.epoch });
  assert.equal(refusedAct.status, 409); assert.match(refusedAct.data.error, /^human_has_control/);
  assert.equal(await controller(tab.id), 'human');

  console.log('PASS: a bot takes a human tab back after the grace wait with a fresh epoch and a Take back banner; recording and the setting off keep it the human\'s.');
  server.close(); app.quit();
}).catch(error => { console.error(error.stack); server?.close(); app.exit(1); });
