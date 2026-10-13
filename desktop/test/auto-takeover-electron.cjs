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
  bots: [{ id: '4242', isBot: true, name: 'Scout' }, { id: '5151', isBot: true, name: 'Other' }], selectedBotId: '4242' }));
process.env.HERMES_WORKSPACE_PORT = String(19000 + Math.floor(Math.random() * 10000));
process.env.HERMES_WORKSPACE_ALLOW_LOOPBACK = '1';
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
  // Every bot reply is recorded so the run can prove human_has_control never reached the bot.
  const replies = [];
  const api = async (endpoint, method = 'GET', body, bot = '4242', epoch) => {
    const res = await fetch(`${connection.url}${endpoint}`, { method, headers: { Authorization: `Bearer ${connection.token}`, 'X-Hermes-Bot': bot,
      ...(epoch !== undefined ? { 'X-Control-Epoch': String(epoch) } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const reply = { status: res.status, data: await res.json() };
    replies.push(JSON.stringify(reply.data));
    return reply;
  };
  const banner = () => evaluate('document.getElementById("takeover-banner").classList.contains("hidden") ? "" : document.getElementById("takeover-text").textContent');
  const controller = async id => (await getState()).tabs.find(item => item.id === id).controller;
  const humanTypes = async (pageWc, text) => {
    pageWc.focus();
    for (const key of text) { pageWc.sendInputEvent({ type: 'keyDown', keyCode: key }); pageWc.sendInputEvent({ type: 'char', keyCode: key }); pageWc.sendInputEvent({ type: 'keyUp', keyCode: key }); }
    await sleep(100);
  };

  server = http.createServer((req, res) => res.end(`<title>${req.url.slice(1) || 'form'}</title><input id="q" autofocus>`));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await getState()).autoTakeover, true, 'on by default');

  // The owner's case: the bot works in a Notion tab, the human takes it over
  // and types, and later asks the bot to do something there. The bot acts with
  // the epoch it last held; the app takes the tab back and shows the banner,
  // and the bot carries on after one tab read. No human_has_control on the way.
  const notion = (await api('/v1/tabs', 'POST', { url: `${base}/notion`, background: false })).data;
  const notionWc = await waitFor(() => webContents.getAllWebContents().find(item => item.getURL().endsWith('/notion')), Boolean);
  await waitFor(() => notionWc.executeJavaScript('document.readyState === "complete"').catch(() => false), Boolean);
  await waitFor(getState, state => state.activeTabId === notion.id);
  assert.equal((await api(`/v1/tabs/${notion.id}/actions`, 'POST', { action: 'type', selector: '#q', text: 'Plan', epoch: notion.epoch })).status, 200);
  await invoke('control', { id: notion.id, controller: 'human' });
  await humanTypes(notionWc, 'X');
  assert.match(await notionWc.executeJavaScript('document.getElementById("q").value'), /X/, 'the human typed in the tab');
  await sleep(3100);
  const asked = await api(`/v1/tabs/${notion.id}/actions`, 'POST', { action: 'type', selector: '#q', text: ' (bot)', epoch: notion.epoch });
  assert.equal(asked.status, 409); assert.match(asked.data.error, /^stale_control_epoch: you took this tab back from the human/);
  assert.equal(await controller(notion.id), 'agent', 'the app handed the tab to the bot');
  assert.equal(await waitFor(banner, Boolean), 'Scout took over this tab');
  const fresh = (await api(`/v1/tabs/${notion.id}`)).data;
  const carried = await api(`/v1/tabs/${notion.id}/actions`, 'POST', { action: 'type', selector: '#q', text: ' (bot)', epoch: fresh.epoch });
  assert.equal(carried.status, 200, JSON.stringify(carried.data));
  assert.equal(await notionWc.executeJavaScript('document.getElementById("q").value'), ' (bot)', 'the bot carries on in the tab');
  // The same case through a claim: the human takes the tab back, and the bot claims and acts.
  await evaluate('document.getElementById("takeover-take-back").click()');
  await waitFor(() => controller(notion.id), value => value === 'human');
  await sleep(3100);
  const reclaimed = await api(`/v1/tabs/${notion.id}/control`, 'POST', { controller: 'agent' });
  assert.equal(reclaimed.status, 200, JSON.stringify(reclaimed.data));
  assert.equal((await api(`/v1/tabs/${notion.id}/actions`, 'POST', { action: 'read', epoch: reclaimed.data.epoch })).status, 200);
  assert.equal(replies.some(reply => reply.includes('human_has_control')), false, 'human_has_control never reached the bot');

  const tab = await invoke('create-tab', { url: `${base}/` });
  const pageWc = await waitFor(() => webContents.getAllWebContents().find(item => item.getURL() === `${base}/`), Boolean);
  await waitFor(() => pageWc.executeJavaScript('document.readyState === "complete"').catch(() => false), Boolean);
  const agentEpoch = (await invoke('control', { id: tab.id, controller: 'agent' })).epoch;

  // The human takes over; the bot acts with the epoch it reads. The action waits
  // out the 3 second grace after the Take over press, then runs on a fresh epoch.
  const humanEpoch = (await invoke('control', { id: tab.id, controller: 'human' })).epoch;
  assert.equal((await api(`/v1/tabs/${tab.id}`)).data.epoch, humanEpoch);
  // Another bot, and a malformed action, never take the human's tab.
  assert.equal((await api(`/v1/tabs/${tab.id}/actions`, 'POST', { action: 'read', epoch: humanEpoch }, '5151')).status, 403);
  assert.equal((await api(`/v1/tabs/${tab.id}/control`, 'POST', { controller: 'agent' }, '5151')).status, 403);
  assert.equal((await api(`/v1/tabs/${tab.id}/actions`, 'POST', { epoch: humanEpoch })).status, 400);
  assert.equal(await controller(tab.id), 'human');
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
  await humanTypes(pageWc, 'a');
  started = Date.now();
  const claimed = await api(`/v1/tabs/${tab.id}/control`, 'POST', { controller: 'agent' });
  assert.equal(claimed.status, 200, JSON.stringify(claimed.data));
  assert.ok(Date.now() - started >= 2500, `a key on the page holds the claim (${Date.now() - started}ms)`);
  assert.equal(claimed.data.controller, 'agent');

  // A tab the bot released and nobody touched comes back without a banner.
  await api(`/v1/tabs/${tab.id}/control`, 'POST', { controller: 'human' });
  await sleep(3100);
  await waitFor(banner, value => value === '');
  assert.equal((await api(`/v1/tabs/${tab.id}/control`, 'POST', { controller: 'agent' })).status, 200);
  await sleep(300);
  assert.equal(await banner(), '', 'no banner for a tab the human never had');

  // An epoch from before the human took over still takes the tab, then answers stale.
  await invoke('control', { id: tab.id, controller: 'human' });
  await sleep(3100);
  const stale = await api(`/v1/tabs/${tab.id}/actions`, 'POST', { action: 'read', epoch: agentEpoch });
  assert.equal(stale.status, 409); assert.match(stale.data.error, /^stale_control_epoch/);
  assert.equal(await controller(tab.id), 'agent');

  // A tab the bot handed to the human stays theirs.
  const handed = await api(`/v1/tabs/${tab.id}/control`, 'POST', { controller: 'human', reason: 'captcha' });
  const waiting = await api(`/v1/tabs/${tab.id}/actions`, 'POST', { action: 'read', epoch: handed.data.epoch });
  assert.equal(waiting.status, 409); assert.match(waiting.data.error, /^awaiting_human/);
  assert.equal((await api(`/v1/tabs/${tab.id}/control`, 'POST', { controller: 'agent' })).status, 409);
  await invoke('control', { id: tab.id, controller: 'agent' });

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
  assert.equal(replies.some(reply => reply.includes('human_has_control')), false, 'human_has_control only comes with the setting off');

  // The setting off brings the refusal back.
  await invoke('settings', { autoTakeover: false });
  assert.equal((await getState()).autoTakeover, false);
  const refusedClaim = await api(`/v1/tabs/${tab.id}/control`, 'POST', { controller: 'agent' });
  assert.equal(refusedClaim.status, 409); assert.match(refusedClaim.data.error, /^human_has_control/);
  const humanNow = (await api(`/v1/tabs/${tab.id}`)).data.epoch;
  const refusedAct = await api(`/v1/tabs/${tab.id}/actions`, 'POST', { action: 'read', epoch: humanNow });
  assert.equal(refusedAct.status, 409); assert.match(refusedAct.data.error, /^human_has_control/);
  assert.equal((await api(`/v1/tabs/${tab.id}`, 'DELETE', undefined, '4242', humanNow)).status, 409);
  assert.equal(await controller(tab.id), 'human');

  // With the setting on, closing a tab the human holds takes it back first.
  await invoke('settings', { autoTakeover: true });
  await sleep(3100);
  const closed = await api(`/v1/tabs/${tab.id}`, 'DELETE', undefined, '4242', humanNow);
  assert.equal(closed.status, 200, JSON.stringify(closed.data));

  console.log('PASS: a bot takes a human tab back after the grace wait with a fresh epoch and a Take back banner (the Notion case carries on without human_has_control); handbacks, recording and the setting off keep it the human\'s.');
  server.close(); app.quit();
}).catch(error => { console.error(error.stack); server?.close(); app.exit(1); });
