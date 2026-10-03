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
fs.writeFileSync(path.join(profile, 'preferences.json'), JSON.stringify({ bots: [{ id: '123', name: 'Avatar test fixture', isBot: true }], selectedBotId: '123', preview: false }));
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
  const api = async (route, method = 'GET', body) => {
    const response = await fetch(new URL(route, connection.url), { method, headers: { Authorization: `Bearer ${connection.token}`, 'X-Hermes-Bot': 'capture-regression', 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await response.json(); assert.ok(response.ok, data.error); return data;
  };
  const colored = [];
  for (const color of ['red', 'blue']) {
    const tab = await api('/v1/tabs', 'POST', { url: `http://127.0.0.1:${server.address().port}/${color}` });
    colored.push(tab);
    await waitFor(() => api(`/v1/tabs/${tab.id}/snapshot`), snap => snap.title === color);
  }
  // Both inactive views occupy the same hidden host. Capturing the first must
  // still return its own pixels and the complete viewport, not the top view.
  const image = nativeImage.createFromBuffer(Buffer.from((await api(`/v1/tabs/${colored[0].id}/screenshot`)).base64, 'base64'));
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
