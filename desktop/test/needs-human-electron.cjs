require('./window-fixture.cjs');
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
Notification.prototype.close = function close() { this.closed = true; };
// VM transport and version probes are fixtures; the window, renderer and command route are real.
require('../src/vm-update.cjs').createVmUpdater = () => ({ checkVm: async () => ({ ok: false, error: 'Fixture has no update target.' }) });
const remoteCalls = [], remoteDeletes = [];
let remoteTab = { id: 'vm-sign-in', botId: '4242', host: 'vps', controller: 'human', epoch: 7,
  url: 'https://login.example/', title: 'Sign in', handback: { state: 'awaiting_human', reason: 'login', note: 'Sign in', botId: '4242', since: Date.now() } };
const remoteTabs = new Map([[remoteTab.id, remoteTab]]), activationGates = new Map();
const vpsModule = require('../src/vps-browser.cjs');
vpsModule.createVpsBrowser = () => ({ request: async (route, method, body, options) => {
  if (route === '/v1/tabs' && method === 'GET') return { tabs: [...remoteTabs.values()] };
  if (route === '/v1/tabs' && method === 'POST') return remoteTabs.get(body.fixtureId || remoteTab.id);
  const id = route.split('/')[3];
  if (method === 'DELETE') { remoteDeletes.push(id); remoteTabs.delete(id); return { ok: true }; }
  let tab = remoteTabs.get(id);
  if (route.endsWith('/activate')) {
    const gate = activationGates.get(id);
    if (gate) { gate.enter(); await gate.wait; }
  }
  if (route.endsWith('/control')) {
    remoteCalls.push({ id, body, human: options.human });
    if (body.giveBack && body.epoch !== tab.epoch) return { ...tab, ...(tab.controller === 'human' && tab.handback?.state === 'awaiting_human' ? { refused: 'stale' } : {}) };
    tab = { ...tab, controller: 'agent', epoch: tab.epoch + 1, handback: { ...tab.handback, state: 'human_returned' } };
    remoteTabs.set(id, tab);
  }
  return tab;
} });
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

  const heldBeforeStale = (await api(`/v1/tabs/${tab.id}`)).data;
  const refusedLocal = await invoke('control', { id: tab.id, host: tab.host, controller: 'agent', giveBack: true, epoch: releasedEpoch - 1 });
  assert.equal(refusedLocal.refused, 'stale', 'a stale local click signals refusal while the human has the tab');
  assert.equal(refusedLocal.epoch, heldBeforeStale.epoch);
  assert.deepEqual(refusedLocal.handback, heldBeforeStale.handback);
  assert.deepEqual((await api(`/v1/tabs/${tab.id}`)).data, heldBeforeStale, 'a stale local click preserves the hold and epoch');

  // Give back: the bot hears human_returned, then claims with a fresh epoch.
  await evaluate('document.getElementById("needs-you-give-back").click()');
  await waitFor(getState, state => state.tabs.find(item => item.id === tab.id).controller === 'agent');
  await waitFor(() => evaluate('document.getElementById("needs-you-banner").classList.contains("hidden")'), Boolean);
  assert.equal(await evaluate('document.querySelectorAll("#tabs .needs-you-badge").length'), 0);
  const stale = await api(`/v1/tabs/${tab.id}/actions`, 'POST', { action: 'read', epoch: releasedEpoch });
  assert.equal(stale.status, 409); assert.match(stale.data.error, /^human_returned/);
  const returned = (await api(`/v1/tabs/${tab.id}`)).data;
  assert.equal(returned.handback.state, 'human_returned');
  const duplicate = await invoke('control', { id: tab.id, controller: 'agent', giveBack: true, epoch: releasedEpoch });
  assert.deepEqual(duplicate, returned, 'a completed local Give back does not ask the person to retry');
  assert.deepEqual((await api(`/v1/tabs/${tab.id}`)).data, returned, 'a duplicate local give-back is a no-op');
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

  // A reasoned release on a tab the human took over says the hold was ignored.
  await invoke('control', { id: tab.id, controller: 'human' });
  const ignored = await api(`/v1/tabs/${tab.id}/control`, 'POST', { controller: 'human', reason: 'captcha', note });
  assert.equal(ignored.status, 200, JSON.stringify(ignored.data));
  assert.equal(ignored.data.handback, null, 'no hold is recorded on a taken-over tab');
  assert.match(ignored.data.note || '', /ignored/i, 'the reply notes the hold was ignored');
  assert.equal(shown.length, 1, 'a release on a taken-over tab does not notify');

  // Closing a tab clears its handback notice.
  const second = await invoke('create-tab', { url: `http://127.0.0.1:${server.address().port}/` });
  await invoke('control', { id: second.id, controller: 'agent' });
  const secondRelease = await api(`/v1/tabs/${second.id}/control`, 'POST', { controller: 'human', reason: 'login' });
  assert.equal(secondRelease.data.handback.state, 'awaiting_human');
  assert.equal(shown.length, 2);
  await invoke('close-tab', { id: second.id });
  assert.equal(shown[1].closed, true, 'closing the tab dismisses its notification');

  const refreshVm = async () => {
    await invoke('settings', { vpsBrowser: { sshHost: 'fixture@192.0.2.1' } });
    return getState();
  };
  remoteTabs.set(remoteTab.id, { ...remoteTab, handback: null, controller: 'agent' });
  await refreshVm();
  assert.equal(shown.length, 2, 'an idle VM tab does not notify');
  remoteTabs.set(remoteTab.id, remoteTab);
  await api('/v1/tabs', 'POST', { host: 'vm', fixtureId: remoteTab.id });
  await refreshVm();
  assert.equal(shown.length, 3, 'a VM tab entering awaiting_human notifies once even when an API reply warmed the cache');
  await refreshVm();
  assert.equal(shown.length, 3, 'a second refresh of the same hold does not notify');
  remoteTabs.set(remoteTab.id, { ...remoteTab, handback: null, controller: 'agent' });
  await refreshVm();
  remoteTabs.set(remoteTab.id, remoteTab);
  await refreshVm();
  assert.equal(shown.length, 4, 'leaving and re-entering awaiting_human notifies again');
  assert.equal((await getState()).activeVpsTabId, '');
  await invoke('toggle-vps-view');
  assert.equal((await getState()).activeVpsTabId, remoteTab.id, 'opening the VM selects the waiting tab');
  await waitFor(() => evaluate('!!document.getElementById("needs-you-banner").offsetParent && !!document.getElementById("needs-you-give-back").offsetParent'), Boolean);
  await invoke('activate', { id: tab.id, host: tab.host });
  await invoke('settings', { showBrowser: false });
  shown.at(-1).emit('click');
  await waitFor(getState, state => state.activeTabId === 'vps' && state.activeVpsTabId === remoteTab.id && state.showBrowser === true);
  await waitFor(() => evaluate('!document.getElementById("needs-you-banner").classList.contains("hidden")'), Boolean);

  const idleVm = { ...remoteTab, id: 'vm-idle', botId: 'other-bot', handback: null, controller: 'agent' };
  remoteTabs.set(idleVm.id, idleVm);
  await refreshVm();
  await invoke('activate', { id: tab.id, host: tab.host });
  assert.equal(await evaluate('document.querySelectorAll("#tabs .tab[data-tab-id=vm-idle]").length'), 0, 'idle VM tabs stay out of the Mac strip');
  assert.equal(await evaluate('document.querySelectorAll("#tabs .tab[data-tab-id=vm-sign-in][data-host=vps]").length'), 1, 'waiting VM tabs stay findable in the Mac strip');
  assert.equal(await evaluate('document.querySelectorAll("#tabs .tab[data-host=vps] .tab-close").length'), 0, 'VM strip entries have no close button');
  assert.ok((await api('/v1/tabs')).data.tabs.some(item => item.id === remoteTab.id), 'the bot-facing list still includes VM tabs');
  assert.ok((await getState()).tabs.some(item => item.id === idleVm.id), 'idle VM tabs remain in state for the VM UI');
  await evaluate(`(() => {
    const select = document.querySelector('#tabs .tab[data-tab-id=vm-sign-in][data-host=vps] .tab-select');
    select.focus(); select.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
  })()`);
  assert.ok((await getState()).tabs.some(item => item.id === remoteTab.id), 'Delete preserves the waiting VM tab');
  assert.deepEqual(remoteDeletes, [], 'Delete sends no VM close request');
  const panel = await evaluate(`(() => {
    document.getElementById('tabs-menu').click();
    return { idle: document.querySelectorAll('#tabs-panel .tabs-panel-row[data-tab-id=vm-idle]').length,
      waiting: document.querySelectorAll('#tabs-panel .tabs-panel-row[data-tab-id=vm-sign-in]').length,
      close: document.querySelectorAll('#tabs-panel .tabs-panel-row[data-host=vps] .tabs-panel-close').length };
  })()`);
  assert.deepEqual(panel, { idle: 0, waiting: 1, close: 0 }, 'the strip overflow menu has the same VM protections');
  await evaluate('document.getElementById("tabs-menu").click(); document.querySelector("#tabs .tab[data-tab-id=vm-sign-in][data-host=vps] .tab-select").click()');
  await waitFor(getState, state => state.activeTabId === 'vps' && state.activeVpsTabId === remoteTab.id);
  await waitFor(() => evaluate('!!document.getElementById("needs-you-give-back").offsetParent'), Boolean);
  await invoke('activate', { id: idleVm.id, host: 'vps' });
  await invoke('toggle-vps-view');
  await invoke('toggle-vps-view');
  assert.equal((await getState()).activeVpsTabId, idleVm.id, 'a valid VM selection is preserved');
  remoteTabs.delete(idleVm.id);
  await refreshVm();
  await invoke('toggle-vps-view');
  await invoke('toggle-vps-view');
  assert.equal((await getState()).activeVpsTabId, remoteTab.id, 'a gone VM selection falls back to the waiting tab');

  const vmTab = (await api('/v1/tabs', 'POST', { host: 'vm', url: 'https://login.example/' })).data;
  await invoke('activate', { id: vmTab.id });
  await waitFor(() => evaluate('document.getElementById("needs-you-banner").classList.contains("hidden")'), hidden => !hidden);
  remoteTabs.set(vmTab.id, { ...remoteTabs.get(vmTab.id), epoch: 8 });
  await evaluate('document.getElementById("needs-you-give-back").click()');
  await waitFor(() => evaluate('document.getElementById("toast").textContent'), text => text === 'That changed while you were looking. Press Give back again.');
  assert.equal(await evaluate('document.getElementById("toast").classList.contains("hidden")'), false);
  assert.equal(remoteTabs.get(vmTab.id).handback.state, 'awaiting_human', 'a stale VM Give back preserves the hold');
  assert.equal(remoteTabs.get(vmTab.id).epoch, 8, 'a stale VM Give back preserves the epoch');
  remoteCalls.length = 0;
  await evaluate('document.getElementById("needs-you-give-back").click()');
  await waitFor(() => remoteCalls.length, count => count === 1);
  assert.deepEqual(remoteCalls[0], { id: vmTab.id, body: { controller: 'agent', giveBack: true, epoch: 8 }, human: true }, 'the second click routes the fresh guarded give-back to the VM');
  assert.equal((await getState()).tabs.find(item => item.id === vmTab.id).handback.state, 'human_returned');

  const failures = [];
  const check = async (name, run) => { try { await run(); console.log('PASS:', name); } catch (error) { failures.push(error); console.error('FAIL:', name, error.message); } };
  await check('superseded VM activation cannot retarget Give back', async () => {
    for (const [id, note] of [['vm-a', 'VM A sign-in'], ['vm-b', 'VM B sign-in']]) {
      remoteTabs.set(id, { ...remoteTab, id, epoch: 20, handback: { ...remoteTab.handback, note } });
      await api('/v1/tabs', 'POST', { host: 'vm', fixtureId: id });
    }
    let enter, release;
    const entered = new Promise(resolve => { enter = resolve; });
    activationGates.set('vm-a', { enter, wait: new Promise(resolve => { release = resolve; }) });
    const first = invoke('activate', { id: 'vm-a', host: 'vps' });
    await entered;
    await invoke('activate', { id: 'vm-b', host: 'vps' });
    release(); await first;
    assert.equal((await getState()).activeVpsTabId, 'vm-b', 'a delayed response cannot replace the newer selection');
    await waitFor(() => evaluate('document.getElementById("needs-you-text").textContent'), text => text.includes('VM B sign-in'));
    await evaluate('document.getElementById("needs-you-give-back").click()');
    await waitFor(() => remoteCalls.length, count => count === 2);
    assert.deepEqual(remoteCalls[1], { id: 'vm-b', body: { controller: 'agent', giveBack: true, epoch: 20 }, human: true });
    assert.equal(remoteTabs.get('vm-a').controller, 'human');
  });
  await check('same-id local and VM handbacks keep their host and epoch', async () => {
    await refreshVm();
    const local = await invoke('create-tab');
    await invoke('control', { id: local.id, controller: 'agent' });
    const held = (await api(`/v1/tabs/${local.id}/control`, 'POST', { controller: 'human', reason: 'login', note: 'Local sign-in' })).data;
    remoteTabs.set(local.id, { ...remoteTab, id: local.id, epoch: 100, handback: { ...remoteTab.handback, since: held.handback.since, note: 'VM collision sign-in' } });
    await api('/v1/tabs', 'POST', { host: 'vm', fixtureId: local.id });
    const noticesBeforeVm = shown.length;
    await refreshVm();
    assert.equal(shown.length, noticesBeforeVm + 1, 'same-id, same-time handbacks notify separately for each computer');
    const vmNotice = shown.at(-1);
    await waitFor(() => evaluate(`!!document.querySelector('.tab[data-tab-id="${local.id}"][data-host="vps"] .tab-select')`), Boolean);
    await evaluate(`document.querySelector('.tab[data-tab-id="${local.id}"][data-host="vps"] .tab-select').click()`);
    await waitFor(() => evaluate('document.getElementById("needs-you-text").textContent'), text => text.includes('VM collision sign-in'));
    const before = remoteCalls.length;
    assert.match(await evaluate(`window.workspace.command('control', ${JSON.stringify({ id: local.id, controller: 'agent', giveBack: true, epoch: 100 })}).then(() => '', error => error.message)`), /Choose the tab and its computer/);
    assert.match(await evaluate(`window.workspace.command('control', ${JSON.stringify({ id: local.id, host: 'unknown', controller: 'agent', giveBack: true, epoch: 100 })}).then(() => '', error => error.message)`), /Unknown tab computer/);
    assert.equal(remoteCalls.length, before);
    await evaluate('document.getElementById("needs-you-give-back").click()');
    await waitFor(() => remoteCalls.length, count => count === before + 1);
    assert.deepEqual(remoteCalls.at(-1), { id: local.id, body: { controller: 'agent', giveBack: true, epoch: 100 }, human: true });
    assert.equal((await api(`/v1/tabs/${local.id}`)).data.handback.state, 'awaiting_human');
    await evaluate(`document.querySelector('.tab[data-tab-id="${local.id}"][data-host="${local.host}"] .tab-select').click()`);
    await waitFor(() => evaluate('document.getElementById("needs-you-text").textContent'), text => text.includes('Local sign-in'));
    await evaluate('document.getElementById("needs-you-give-back").click()');
    await waitFor(async () => (await api(`/v1/tabs/${local.id}`)).data, tab => tab.handback.state === 'human_returned');
    assert.equal(remoteCalls.length, before + 1, 'a local give-back never routes to the same-id VM');
    assert.ok((await api(`/v1/tabs/${local.id}`)).data.epoch > held.epoch);
    await invoke('close-tab', { id: local.id, host: local.host });
    assert.notEqual(vmNotice.closed, true, 'closing a local tab cannot dismiss the same-id VM notification');
  });
  assert.equal(failures.length, 0, failures.map(error => error.stack).join('\n'));

  console.log('PASS: a release with a reason badges the tab, shows an escaped banner, notifies once, and holds the tab until the human gives it back.');
  server.close(); app.quit();
}).catch(error => { console.error(error.stack); server?.close(); app.exit(1); });
