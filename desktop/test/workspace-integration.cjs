// Run: npx electron test/workspace-integration.cjs
// Uses an isolated profile and localhost pages. No Telegram messages are sent.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { app, BrowserWindow, dialog, webContents, screen, nativeImage, session } = require('electron');
const { spawn } = require('node:child_process');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-workspace-integration-'));
process.env.HERMES_WORKSPACE_DATA = profile;
process.env.HERMES_WORKSPACE_PORT = String(19000 + Math.floor(Math.random() * 10000));
process.env.HERMES_OVERSEER_BOTS = 'overseer-bot';
fs.writeFileSync(path.join(profile, 'preferences.json'), JSON.stringify({ bots: [{ id: '123', name: 'Avatar test fixture', isBot: true }, { id: '456', name: 'Second fixture bot', isBot: true }], selectedBotId: '123', preview: false }));
require('../src/main.cjs');
const waitFor = async (read, predicate, timeout = 12000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (predicate(value)) return value; await new Promise(r => setTimeout(r, 50)); }
  throw new Error('Timed out waiting for integration state.');
};
let server;
app.whenReady().then(async () => {
  const win = await waitFor(() => BrowserWindow.getAllWindows()[0], win => !!win);
  const wc = win.webContents;
  // The live Telegram login screen can autofocus asynchronously. This fixture
  // tests browser input isolation and never signs in, so keep that pane inert.
  const telegram = webContents.getAllWebContents().find(item => item.session === session.fromPartition('persist:telegram'));
  if (telegram) { telegram.stop(); await telegram.loadURL('about:blank'); }
  const evaluate = code => wc.executeJavaScript(code);
  await waitFor(() => evaluate('typeof window.workspace === "object" && typeof window.HermesAvatars === "object"').catch(() => false), Boolean);
  const invoke = (name, value) => evaluate(`window.workspace.command(${JSON.stringify(name)}, ${JSON.stringify(value || {})})`);
  let state = await evaluate('window.workspace.getState()');
  assert.equal(state.avatarLibrary.length, 10);
  assert.equal(state.bots[0].activity.state, 'unknown', 'No fake work is inferred from a discovered bot.');
  const builtin = state.avatarLibrary.find(item => item.id === 'marble-hermes');
  state = await invoke('set-bot-avatar', { id: '123', selectedId: builtin.id, eyes: builtin.eyes });
  assert.equal(state.avatarPreferences['123'].selectedId, builtin.id);
  await evaluate('document.getElementById("chat-avatar").click()');
  await waitFor(() => evaluate('document.getElementById("modal-body").querySelectorAll("img").length'), count => count >= 10);
  const broken = await evaluate('Promise.all([...document.querySelectorAll("#modal-body img")].map(img => img.decode().then(() => false, () => true))).then(values => values.filter(Boolean).length)');
  assert.equal(broken, 0, 'Every avatar decodes in the real app.');
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const shot = path.join(profile, 'avatar-editor.png');
  fs.writeFileSync(shot, (await wc.capturePage()).toPNG());
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path.join(__dirname, '../assets/avatars/hermes.png')] });
  state = await invoke('import-avatars');
  const imported = state.avatarLibrary.find(item => !item.builtIn);
  assert.ok(imported.dataUrl.startsWith('data:image/png;base64,'));
  await invoke('set-bot-avatar', { id: '123', selectedId: imported.id, eyes: { enabled: false } });
  state = await invoke('remove-avatar', { avatarId: imported.id });
  assert.equal(state.avatarPreferences['123'], undefined);
  await invoke('set-bot-avatar', { id: '123', selectedId: builtin.id, eyes: builtin.eyes });
  const persisted = JSON.parse(fs.readFileSync(path.join(profile, 'preferences.json')));
  assert.equal(persisted.avatarPreferences['123'].selectedId, builtin.id);
  await evaluate('document.getElementById("modal-close").click()');
  console.log('PASS: real app avatar gallery, image decode, selection, native import, removal, persistence; screenshot ' + shot);

  // Fixture-only activity exercises the actual renderer without claiming any
  // real Telegram bot is working or writing fabricated activity to app state.
  const originalSend = wc.send.bind(wc);
  // Keep asynchronous catalog/layout state refreshes from replacing this
  // controlled renderer fixture between its two animation frames.
  wc.send = (channel, ...args) => { if (channel !== 'workspace:state' && channel !== 'workspace:pointer') originalSend(channel, ...args); };
  let gaze;
  try { gaze = await evaluate(`(async () => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const real = await window.workspace.getState();
    const fixture = { ...real, bots: real.bots.map(bot => ({ ...bot, activity: { state: 'active', expiresAt: Date.now() + 6000, label: 'Test fixture' } })) };
    const face = document.getElementById('presence-avatar');
    const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    window.HermesAvatars.update(fixture);
    window.HermesAvatars.receivePointer({ x: -500, y: 300 }); await frame();
    const left = [...face.querySelectorAll('.hermes-pupil')].map(p => p.style.transform);
    window.HermesAvatars.receivePointer({ x: innerWidth + 500, y: 300 }); await frame();
    const right = [...face.querySelectorAll('.hermes-pupil')].map(p => p.style.transform);
    const active = face.classList.contains('hermes-avatar-active');
    window.HermesAvatars.update({ ...fixture, bots: fixture.bots.map(bot => ({ ...bot, activity: { state: 'idle' } })) });
    const idle = !face.classList.contains('hermes-avatar-active');
    const neutral = [...face.querySelectorAll('.hermes-pupil')].every(p => p.style.transform === 'translate(-50%, -50%)');
    window.HermesAvatars.update(real);
    return { left, right, active, idle, neutral, reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches };
  })()`); } finally { wc.send = originalSend; }
  assert.equal(gaze.left.length, 2);
  if (!gaze.reducedMotion) assert.notDeepEqual(gaze.left, gaze.right, 'Active eyes follow the pointer.');
  assert.ok(gaze.active && gaze.idle && gaze.neutral, 'Idle avatars stop and return to neutral pupils.');
  console.log('PASS: fixture-driven live avatar gaze and immediate idle reset in the real renderer.');

  server = http.createServer((req, res) => res.end(req.url === '/red' || req.url === '/blue' ? `<style>html{background:${req.url.slice(1)}}</style><title>${req.url.slice(1)}</title><button onclick="window.open('/popup')">Open fixture popup</button>` : '<!doctype html><title>Human focus fixture</title><input id="human" aria-label="Human input" value="Keep my draft"><script>human.focus()</script>'));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const human = await invoke('create-tab', { url: `http://127.0.0.1:${server.address().port}` });
  const humanWc = await waitFor(() => webContents.getAllWebContents().find(item => item.getURL() === `http://127.0.0.1:${server.address().port}/` && item !== wc), Boolean);
  await waitFor(() => humanWc.executeJavaScript('document.getElementById("human")?.value').catch(() => ''), value => value === 'Keep my draft');
  humanWc.focus();
  await humanWc.executeJavaScript('document.getElementById("human").focus()');
  const focus = webContents.getFocusedWebContents()?.id;
  const mainWindowFocusedBefore = win.isFocused();
  const point = screen.getCursorScreenPoint();
  const assertHumanFocus = () => {
    const current = webContents.getFocusedWebContents()?.id;
    // The person running this test may keep using another app. Never focus the
    // fixture again: while our window is key, its human responder must survive;
    // while it is not key, no agent tab may become the native focused contents.
    assert.ok(current === focus || (current === undefined && !win.isFocused()), `Native focus changed inside the workspace (${focus} -> ${current}).`);
  };
  const connection = JSON.parse(fs.readFileSync(path.join(profile, 'connection.json')));
  const apiRaw = async (route, method = 'GET', body, actor = 'capture-regression') => {
    const response = await fetch(new URL(route, connection.url), { method, headers: { Authorization: `Bearer ${connection.token}`, 'X-Hermes-Bot': actor, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  };
  const api = async (route, method = 'GET', body, actor) => {
    const { status, data } = await apiRaw(route, method, body, actor);
    assert.ok(status < 300, data.error); return data;
  };
  const colored = [];
  for (const color of ['red', 'blue']) {
    const tab = await api('/v1/tabs', 'POST', { url: `http://127.0.0.1:${server.address().port}/${color}` });
    colored.push(tab);
    await waitFor(() => api(`/v1/tabs/${tab.id}/snapshot`), snap => snap.title === color);
  }
  // Bounded snapshots report their caps, generation, and dedupe on since.
  const bounded = await api(`/v1/tabs/${colored[0].id}/snapshot?maxChars=2000&maxElements=50`);
  assert.ok(Number.isInteger(bounded.generation) && bounded.elements.length <= 50 && bounded.truncated, 'snapshot reports generation and truncated flags');
  const deduped = await api(`/v1/tabs/${colored[0].id}/snapshot?since=${bounded.generation}`);
  assert.equal(deduped.unchanged, true, 'since=<last generation> dedupes an unchanged snapshot');
  assert.ok(deduped.generation > bounded.generation);
  assert.equal((await apiRaw(`/v1/tabs/${colored[0].id}/snapshot?maxElements=abc`, 'GET', undefined, 'overseer-bot')).status, 400, 'non-integer bounds are rejected');
  const jpeg = await api(`/v1/tabs/${colored[0].id}/screenshot`);
  assert.equal(jpeg.mimeType, 'image/jpeg', 'screenshots default to jpeg');
  // Both inactive views occupy the same hidden host. Capturing the first must
  // still return its own pixels and the complete viewport, not the top view.
  const image = nativeImage.createFromBuffer(Buffer.from((await api(`/v1/tabs/${colored[0].id}/screenshot?format=png&maxWidth=10000`)).base64, 'base64'));
  const redWc = webContents.getAllWebContents().find(item => item.getURL().endsWith('/red'));
  const viewport = await redWc.executeJavaScript('({width:innerWidth,height:innerHeight,scale:devicePixelRatio})');
  assert.deepEqual(image.getSize(), { width: Math.round(viewport.width * viewport.scale), height: Math.round(viewport.height * viewport.scale) });
  const pixel = image.toBitmap();
  assert.deepEqual([...pixel.subarray(0, 4)], [0, 0, 255, 255], 'A background screenshot contains its own red pixels.');
  assertHumanFocus();
  const tabsBeforeShortcuts = (await evaluate('window.workspace.getState()')).tabs.length;
  for (const key of ['l', 't', 'w']) {
    await api(`/v1/tabs/${colored[0].id}/actions`, 'POST', { action: 'press', key, modifiers: ['meta'], epoch: colored[0].epoch });
    const current = await evaluate('window.workspace.getState()');
    assert.equal(current.activeTabId, human.id, 'An agent shortcut cannot select a different human tab.');
    assert.equal(current.tabs.length, tabsBeforeShortcuts, 'An agent shortcut cannot open or close workspace tabs.');
    assertHumanFocus();
  }
  console.log('PASS: separate background capture pixels/full viewport, and agent Cmd+L/T/W shortcut isolation.');
  const popupSnapshot = await api(`/v1/tabs/${colored[0].id}/snapshot`);
  await api(`/v1/tabs/${colored[0].id}/actions`, 'POST', { action: 'click', ref: popupSnapshot.elements.find(item => item.name === 'Open fixture popup').ref, epoch: colored[0].epoch });
  await waitFor(() => api('/v1/tabs'), value => value.tabs.some(tab => tab.url.endsWith('/popup')));
  assert.equal((await evaluate('window.workspace.getState()')).activeTabId, human.id, 'Agent popup leaves the human tab selected.');
  assertHumanFocus();
  console.log('PASS: real agent click popup opens in background without taking native focus.');
  // The owning bot can release and retake control; another bot cannot.
  const released = await api(`/v1/tabs/${colored[0].id}/control`, 'POST', { controller: 'human' });
  assert.equal(released.controller, 'human', 'Owner release returns human control.');
  const foreign = await apiRaw(`/v1/tabs/${colored[0].id}/control`, 'POST', { controller: 'agent' }, 'not-the-owner');
  assert.equal(foreign.status, 403, 'A different bot cannot change control.');
  const retaken = await api(`/v1/tabs/${colored[0].id}/control`, 'POST', { controller: 'agent' });
  assert.equal(retaken.controller, 'agent', 'Owner can retake its own tab.');
  console.log('PASS: owner-only tab control release and retake.');
  // The configured overseer sees every tab and may seize or release any of
  // them; human-controlled tabs stay unreadable to all bot actors.
  const overseerTabs = await api('/v1/tabs', 'GET', undefined, 'overseer-bot');
  assert.ok(overseerTabs.tabs.some(tab => tab.id === human.id), 'Overseer sees the human-owned tab.');
  assert.ok(overseerTabs.tabs.some(tab => tab.botId === 'capture-regression'), 'Overseer sees other bots\' tabs.');
  const ownTabs = await api('/v1/tabs');
  assert.ok(ownTabs.tabs.every(tab => tab.botId === 'capture-regression' || (tab.allowedBots ?? []).includes('capture-regression')), 'A regular bot is limited to its own tabs.');
  // human.id belongs to fixture bot 123 under human control: metadata stays
  // visible but page content is sealed for owner and overseer alike.
  assert.equal((await apiRaw(`/v1/tabs/${human.id}`, 'GET', undefined, 'overseer-bot')).status, 200, 'Tab metadata stays visible to the overseer.');
  for (const actor of ['123', 'overseer-bot']) {
    for (const read of ['snapshot', 'screenshot']) {
      const blocked = await apiRaw(`/v1/tabs/${human.id}/${read}`, 'GET', undefined, actor);
      assert.equal(blocked.status, 409, `${actor} ${read} on a human tab`);
      assert.equal(blocked.data.error, 'Tab is under human control.');
    }
  }
  // A stranger cannot release; the overseer can, then reads after taking over.
  assert.equal((await apiRaw(`/v1/tabs/${colored[1].id}/control`, 'POST', { controller: 'human' }, 'not-the-owner')).status, 403);
  const releasedByOverseer = await api(`/v1/tabs/${colored[1].id}/control`, 'POST', { controller: 'human' }, 'overseer-bot');
  assert.equal(releasedByOverseer.controller, 'human', 'Overseer released another bot\'s tab.');
  assert.equal((await apiRaw(`/v1/tabs/${colored[1].id}/snapshot`, 'GET', undefined, 'overseer-bot')).status, 409, 'A released tab is sealed until control is taken.');
  const seized = await api(`/v1/tabs/${colored[1].id}/control`, 'POST', { controller: 'agent' }, 'overseer-bot');
  assert.equal(seized.controller, 'agent');
  assert.equal((await api(`/v1/tabs/${colored[1].id}/snapshot`, 'GET', undefined, 'overseer-bot')).title, 'blue', 'Overseer reads once it holds control.');
  console.log('PASS: overseer lists all tabs, releases/retakes another bot\'s tab, and human-controlled tabs reject bot reads.');
  // Agents take over work at any time: a known bot claims a shared tab and a
  // granted bot seizes a human-controlled tab it was shared with.
  const sharedTab = await api('/v1/tabs', 'POST', { url: `http://127.0.0.1:${server.address().port}/red`, background: true }, 'shared');
  assert.equal(sharedTab.botId, 'shared');
  assert.equal((await apiRaw(`/v1/tabs/${sharedTab.id}/control`, 'POST', { controller: 'agent' }, 'not-the-owner')).status, 403, 'An unknown bot cannot claim a shared tab.');
  const claimed = await api(`/v1/tabs/${sharedTab.id}/control`, 'POST', { controller: 'agent' }, '456');
  assert.equal(claimed.controller, 'agent', 'A known bot claims a shared tab.');
  assert.equal((await api(`/v1/tabs/${sharedTab.id}`, 'GET', undefined, '456')).botId, '456', 'Claiming assigns the tab to that bot.');
  await api(`/v1/tabs/${colored[0].id}/control`, 'POST', { controller: 'human' });
  await invoke('grant-tab', { id: colored[0].id, botIds: ['456'] });
  const seizedByGrantee = await api(`/v1/tabs/${colored[0].id}/control`, 'POST', { controller: 'agent' }, '456');
  assert.equal(seizedByGrantee.controller, 'agent', 'A granted bot takes over a human-controlled tab.');
  assert.equal((await api(`/v1/tabs/${colored[0].id}`, 'GET', undefined, '456')).botId, 'capture-regression', 'Grantee control does not transfer ownership.');
  console.log('PASS: shared-tab claim by a known bot and granted-bot takeover of a human tab.');
  // batch runs a multi-step sequence in one request and eval executes page JS;
  // both honor the same controller/epoch gate as single actions.
  const seizedTab = await api(`/v1/tabs/${colored[1].id}`, 'GET', undefined, 'overseer-bot');
  const batched = await api(`/v1/tabs/${colored[1].id}/actions`, 'POST', { action: 'batch', epoch: seizedTab.epoch, steps: [
    { action: 'eval', code: 'document.title' },
    { action: 'scroll', x: 0, y: 120 },
    { action: 'press', key: 'Tab' },
  ] }, 'overseer-bot');
  assert.equal(batched.results.length, 3, 'Batch returns one result per step.');
  assert.equal(batched.results[0].value, 'blue', 'eval inside batch returns the page result.');
  const evaluated = await api(`/v1/tabs/${colored[1].id}/actions`, 'POST', { action: 'eval', code: 'document.title + "!"', epoch: seizedTab.epoch }, 'overseer-bot');
  assert.equal(evaluated.value, 'blue!', 'eval returns a JSON value.');
  assert.equal((await apiRaw(`/v1/tabs/${colored[1].id}/actions`, 'POST', { action: 'eval', code: '1', epoch: 999999 }, 'overseer-bot')).status, 409, 'eval rejects a stale epoch.');
  const partial = await api(`/v1/tabs/${colored[1].id}/actions`, 'POST', { action: 'batch', epoch: seizedTab.epoch, steps: [
    { action: 'eval', code: '1' }, { action: 'bogus' }, { action: 'eval', code: '2' },
  ] }, 'overseer-bot');
  assert.equal(partial.results.length, 2, 'Batch stops at the first failing step.');
  assert.ok(partial.results[1].error, 'The failing step reports its error.');
  console.log('PASS: batch sequencing, eval page JS, epoch gate, and stop-on-error.');
  // wait resolves instantly on an existing selector, blocks until a delayed
  // element appears, and times out as a 408 step error inside a batch.
  const instant = await api(`/v1/tabs/${colored[1].id}/actions`, 'POST', { action: 'wait', selector: 'button', epoch: seizedTab.epoch }, 'overseer-bot');
  assert.ok(instant.waited < 1000, 'wait returns immediately when the selector already exists.');
  await api(`/v1/tabs/${colored[1].id}/actions`, 'POST', { action: 'eval', code: "setTimeout(() => { const el = document.createElement('div'); el.id = 'late-el'; document.body.appendChild(el); }, 400)", epoch: seizedTab.epoch }, 'overseer-bot');
  const delayed = await api(`/v1/tabs/${colored[1].id}/actions`, 'POST', { action: 'wait', selector: '#late-el', timeout: 5000, epoch: seizedTab.epoch }, 'overseer-bot');
  assert.ok(delayed.waited >= 300 && delayed.waited < 5000, `wait blocked until the element appeared (${delayed.waited}ms).`);
  const timedOut = await apiRaw(`/v1/tabs/${colored[1].id}/actions`, 'POST', { action: 'wait', selector: '#never-exists', timeout: 400, epoch: seizedTab.epoch }, 'overseer-bot');
  assert.equal(timedOut.status, 408, 'wait reports a timeout as 408.');
  const batchWithWait = await api(`/v1/tabs/${colored[1].id}/actions`, 'POST', { action: 'batch', epoch: seizedTab.epoch, steps: [
    { action: 'wait', selector: 'button' }, { action: 'eval', code: 'document.title' },
  ] }, 'overseer-bot');
  assert.equal(batchWithWait.results.length, 2, 'wait composes inside batch.');
  console.log('PASS: wait instant-resolution, delayed-element blocking, 408 timeout, and batch composition.');
  // selector targets input actions at dispatch time — self-contained batches
  // without minting snapshot refs first.
  await api(`/v1/tabs/${colored[1].id}/actions`, 'POST', { action: 'eval', code: "document.body.insertAdjacentHTML('beforeend','<input id=sel-in>')", epoch: seizedTab.epoch }, 'overseer-bot');
  const typed = await api(`/v1/tabs/${colored[1].id}/actions`, 'POST', { action: 'batch', epoch: seizedTab.epoch, steps: [
    { action: 'type', selector: '#sel-in', text: 'via selector' },
    { action: 'eval', code: "document.getElementById('sel-in').value" },
  ] }, 'overseer-bot');
  assert.equal(typed.results[1].value, 'via selector', 'type by selector produces real field input.');
  console.log('PASS: selector-targeted typing inside a self-contained batch.');
  // wait honors a visibility requirement and a url condition; clicks hit a
  // covered element through an alternate point and name the blocker when it
  // cannot be clicked at all.
  await api(`/v1/tabs/${colored[1].id}/actions`, 'POST', { action: 'eval', code: `document.body.insertAdjacentHTML('beforeend','<div id=hid style="display:none;width:10px;height:10px"></div><button id=cov onclick="window.__n=(window.__n||0)+1" style="position:fixed;left:80px;top:80px;width:140px;height:60px;z-index:1">x</button><div id=blk style="position:fixed;left:120px;top:90px;width:60px;height:40px;z-index:9;background:#000"></div>')`, epoch: seizedTab.epoch }, 'overseer-bot');
  assert.equal((await apiRaw(`/v1/tabs/${colored[1].id}/actions`, 'POST', { action: 'wait', selector: '#hid', visible: true, timeout: 400, epoch: seizedTab.epoch }, 'overseer-bot')).status, 408, 'visible wait rejects a display:none element.');
  const visibleWait = await api(`/v1/tabs/${colored[1].id}/actions`, 'POST', { action: 'batch', epoch: seizedTab.epoch, steps: [
    { action: 'eval', code: "setTimeout(() => document.getElementById('hid').style.display='block', 300), 1" },
    { action: 'wait', selector: '#hid', visible: true, timeout: 5000 },
  ] }, 'overseer-bot');
  assert.ok(visibleWait.results[1].waited >= 250, `wait observed the element becoming visible (${visibleWait.results[1].waited}ms).`);
  const urlWait = await api(`/v1/tabs/${colored[1].id}/actions`, 'POST', { action: 'wait', url: '/blue', timeout: 3000, epoch: seizedTab.epoch }, 'overseer-bot');
  assert.ok(urlWait.waited < 1000, 'url wait resolves on the current location.');
  const covered = await api(`/v1/tabs/${colored[1].id}/actions`, 'POST', { action: 'click', selector: '#cov', epoch: seizedTab.epoch }, 'overseer-bot');
  assert.equal(covered.dispatched, true, 'Click lands on an uncovered point of a partially covered element.');
  assert.equal((await api(`/v1/tabs/${colored[1].id}/actions`, 'POST', { action: 'eval', code: 'window.__n', epoch: seizedTab.epoch }, 'overseer-bot')).value, 1, 'The covered-button click registered.');
  const blocked = await apiRaw(`/v1/tabs/${colored[1].id}/actions`, 'POST', { action: 'click', selector: '#nonexistent', epoch: seizedTab.epoch }, 'overseer-bot');
  assert.equal(blocked.status, 400, 'A missing element reports a named failure.');
  console.log('PASS: wait visible/url conditions and covered-element clicks via alternate points.');
  // viewport overrides the tab layout size for breakpoint-sensitive pages;
  // cdp exposes raw DevTools commands inside the same epoch gate.
  const resized = await api(`/v1/tabs/${colored[1].id}/actions`, 'POST', { action: 'viewport', width: 1440, height: 900, epoch: seizedTab.epoch }, 'overseer-bot');
  assert.deepEqual(resized.viewport, { width: 1440, height: 900, scale: 1 });
  const measured = await api(`/v1/tabs/${colored[1].id}/actions`, 'POST', { action: 'eval', code: '({w:innerWidth,h:innerHeight})', epoch: seizedTab.epoch }, 'overseer-bot');
  assert.deepEqual(measured.value, { w: 1440, h: 900 }, 'viewport override changes the page layout size.');
  const cleared = await api(`/v1/tabs/${colored[1].id}/actions`, 'POST', { action: 'viewport', clear: true, epoch: seizedTab.epoch }, 'overseer-bot');
  assert.equal(cleared.viewport, null, 'clear removes the viewport override.');
  const cdpResult = await api(`/v1/tabs/${colored[1].id}/actions`, 'POST', { action: 'cdp', method: 'Runtime.evaluate', params: { expression: '21*2', returnByValue: true }, epoch: seizedTab.epoch }, 'overseer-bot');
  assert.equal(cdpResult.value.result.value, 42, 'cdp Runtime.evaluate returns the result.');
  assert.equal((await apiRaw(`/v1/tabs/${colored[1].id}/actions`, 'POST', { action: 'cdp', method: 'Target.createTarget', params: {}, epoch: seizedTab.epoch }, 'overseer-bot')).status, 400, 'cdp rejects out-of-scope domains.');
  console.log('PASS: viewport override, clear, raw cdp command, and domain allowlist.');
  // The designated primary bot pins to the top of the sidebar with a PRIMARY
  // badge; with no explicit pick the overseer bot is the primary.
  state = await invoke('settings', { primaryBotId: '123' });
  assert.equal(state.primaryBotId, '123');
  await waitFor(() => evaluate('document.querySelector("#bot-list .bot-row.primary .primary-badge")?.textContent'), value => value === 'PRIMARY');
  assert.equal(await evaluate('document.querySelector("#bot-list .bot-row")?.dataset.botId'), '123', 'Primary bot pins to the top of the sidebar.');
  state = await invoke('settings', { primaryBotId: '' });
  assert.equal(state.primaryBotId, 'overseer-bot', 'With no explicit pick the overseer bot is the primary.');
  console.log('PASS: primary bot pins to the top with a PRIMARY badge, defaulting to the overseer.');
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'background-browser.cjs')], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HERMES_WORKSPACE_CONNECTION: path.join(profile, 'connection.json') }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
    child.on('error', reject); child.on('exit', code => code === 0 ? (console.log(output.trim()), resolve()) : reject(new Error(output)));
  });
  state = await evaluate('window.workspace.getState()');
  assert.equal(state.activeTabId, human.id, 'Agent left the selected human tab unchanged.');
  assert.equal(await humanWc.executeJavaScript('document.activeElement.id'), 'human');
  assert.equal(await humanWc.executeJavaScript('document.getElementById("human").value'), 'Keep my draft');
  assertHumanFocus();
  const afterPoint = screen.getCursorScreenPoint();
  const mainWindowFocusedAfter = win.isFocused(), nativeFocusMeasured = mainWindowFocusedBefore && mainWindowFocusedAfter;
  console.log(JSON.stringify({ humanTabPreserved: true, humanDraftPreserved: true, nativeFocusPreserved: nativeFocusMeasured ? webContents.getFocusedWebContents()?.id === focus : null,
    mainWindowFocusedBefore, mainWindowFocusedAfter, nativeFocusMeasured,
    systemPointerUnchangedDuringTest: point.x === afterPoint.x && point.y === afterPoint.y }));
  console.log('PASS: full app MCP background typing, clicking, screenshots, Enter, and human focus isolation.');
  server.close(); app.quit();
}).catch(error => { console.error(error.stack); server?.close(); app.exit(1); });
