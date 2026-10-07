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
// The fixture serves agent pages from loopback; production code only lets a
// bot navigate there through this explicit opt-in.
process.env.HERMES_WORKSPACE_ALLOW_LOOPBACK = '1';
fs.writeFileSync(path.join(profile, 'preferences.json'), JSON.stringify({ bots: [{ id: '123', name: 'Avatar test fixture', isBot: true }, { id: '456', name: 'Second fixture bot', isBot: true }], selectedBotId: '123', preview: false }));
// Occupy the configured API port: the app must retry on an ephemeral port
// and still write the real address into connection.json.
const portBlocker = http.createServer((_req, res) => res.end('occupied'));
portBlocker.listen(Number(process.env.HERMES_WORKSPACE_PORT), '127.0.0.1');
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
  assert.match(imported.dataUrl, /^hw-avatar:\/\/library\/custom-/);
  assert.equal(JSON.stringify(state).includes('base64'), false, 'broadcast state carries no image bytes');
  assert.equal(await evaluate(`(async () => { const img = new Image(); img.src = ${JSON.stringify(imported.dataUrl)}; await img.decode(); return img.naturalWidth > 0; })()`), true, 'the avatar protocol serves the imported image');
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

  const PNG_ICON = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  server = http.createServer((req, res) => {
    if (req.url === '/icon.png') { res.setHeader('Content-Type', 'image/png'); return res.end(PNG_ICON); }
    if (req.url === '/favicon-local') return res.end('<title>favicon-local</title><link rel="icon" href="/icon.png">');
    if (req.url === '/favicon-cross') return res.end(`<title>favicon-cross</title><link rel="icon" href="http://localhost:${server.address().port}/icon.png">`);
    if (req.url === '/streaming') { res.write('<title>streaming</title><h1>First half</h1>'); setTimeout(() => res.end('<p>Second half</p>'), 600); return; }
    if (req.url === '/form') return res.end('<!doctype html><title>form</title><form id="f"><input name="a" aria-label="Field A"><input name="b" aria-label="Field B"><input name="c" aria-label="Field C"><button type="submit">Send form</button></form><p id="out">idle</p><script>f.onsubmit=e=>{e.preventDefault();out.textContent=[f.a.value,f.b.value,f.c.value].join("|")}</script>');
    if (req.url === '/nav-a') return res.end('<title>nav-a</title><body>Nav A');
    if (req.url === '/nav-b') return res.end('<title>nav-b</title><body>Nav B');
    if (req.url === '/remount') return res.end('<!doctype html><title>remount</title><div id="root"><button onclick="hits.push(1)">Alpha</button><button onclick="hits.push(2)">Beta</button></div><script>window.hits=[];window.render=()=>{root.innerHTML=\'<button onclick="hits.push(1)">Alpha</button><button onclick="hits.push(2)">Beta</button>\'}</script>');
    if (req.url === '/hang-img') return res.end('<!doctype html><title>hang</title><button>Ready</button><img src="/never-answers">');
    if (req.url === '/never-answers') return;
    if (req.url === '/link') return res.end('<title>link</title><a href="/nav-b">Next page</a>');
    if (req.url === '/slow-load') return res.end('<title>slow-load</title><button>Early control</button><img src="/slow-img">');
    if (req.url === '/slow-img') return void setTimeout(() => { res.setHeader('Content-Type', 'image/png'); res.end(PNG_ICON); }, 2500);
    if (req.url === '/blocks') return res.end('<title>blocks</title><h1>Order 42</h1><ul><li>Apples <b>3</b></li><li>Pears 5</li></ul><table><tr><td>Total</td><td>8</td></tr></table><p>Due <i>today</i></p>');
    if (req.url === '/red' || req.url === '/blue') return res.end(`<style>html{background:${req.url.slice(1)}}</style><title>${req.url.slice(1)}</title><button onclick="window.open('/popup')">Open fixture popup</button>`);
    res.end('<!doctype html><title>Human focus fixture</title><input id="human" aria-label="Human input" value="Keep my draft"><script>human.focus()</script>');
  });
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
  assert.notEqual(new URL(connection.url).port, process.env.HERMES_WORKSPACE_PORT, 'The API retried onto a free port after EADDRINUSE.');
  console.log('PASS: API port collision falls back to an ephemeral port and connection.json carries the real one.');
  const apiRaw = async (route, method = 'GET', body, actor = 'capture-regression') => {
    const response = await fetch(new URL(route, connection.url), { method, headers: { Authorization: `Bearer ${connection.token}`, 'X-Hermes-Bot': actor, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  };
  const api = async (route, method = 'GET', body, actor) => {
    const { status, data } = await apiRaw(route, method, body, actor);
    assert.ok(status < 300, data.error); return data;
  };
  // Host computer use validates a request before any helper runs, so this holds without Accessibility.
  const noGeneration = await apiRaw('/v1/computer/1/action', 'POST', { action: 'press', ref: 'c1' });
  assert.equal(noGeneration.status, 409);
  assert.equal(noGeneration.data.code, 'stale_ref');
  const badComputerAction = await apiRaw('/v1/computer/1/action', 'POST', { action: 'teleport' });
  assert.equal(badComputerAction.status, 400);
  assert.equal(badComputerAction.data.code, 'bad_request');
  console.log('PASS: computer actions that use a ref need the snapshot generation, and unknown actions are refused.');
  const colored = [];
  for (const color of ['red', 'blue']) {
    const tab = await api('/v1/tabs', 'POST', { url: `http://127.0.0.1:${server.address().port}/${color}` });
    colored.push(tab);
    await waitFor(() => api(`/v1/tabs/${tab.id}/snapshot`), snap => snap.title === color);
  }
  const blocks = await api('/v1/tabs', 'POST', { url: `http://127.0.0.1:${server.address().port}/blocks` });
  const blockSnap = await waitFor(() => api(`/v1/tabs/${blocks.id}/snapshot`), snap => snap.title === 'blocks');
  assert.equal(blockSnap.text, 'Order 42\nApples 3\nPears 5\nTotal 8\nDue today', 'snapshot text keeps one line per block and inline text on its line');
  await fetch(new URL(`/v1/tabs/${blocks.id}`, connection.url), { method: 'DELETE', headers: { Authorization: `Bearer ${connection.token}`, 'X-Hermes-Bot': 'capture-regression', 'X-Control-Epoch': String(blocks.epoch) } });
  const streaming = await api('/v1/tabs', 'POST', { url: `http://127.0.0.1:${server.address().port}/streaming` });
  const streamSnap = await waitFor(() => api(`/v1/tabs/${streaming.id}/snapshot`), snap => snap.title === 'streaming');
  assert.deepEqual([streamSnap.text, streamSnap.loading], ['First half\nSecond half', false], 'a snapshot taken mid-parse waits for the rest of the document');
  await fetch(new URL(`/v1/tabs/${streaming.id}`, connection.url), { method: 'DELETE', headers: { Authorization: `Bearer ${connection.token}`, 'X-Hermes-Bot': 'capture-regression', 'X-Control-Epoch': String(streaming.epoch) } });
  // Bounded snapshots report their caps, generation, and dedupe on since.
  const bounded = await api(`/v1/tabs/${colored[0].id}/snapshot?maxChars=2000&maxElements=50`);
  assert.ok(Number.isInteger(bounded.generation) && bounded.elements.length <= 50 && bounded.truncated, 'snapshot reports generation and truncated flags');
  const deduped = await api(`/v1/tabs/${colored[0].id}/snapshot?since=${bounded.generation}`);
  assert.equal(deduped.unchanged, true, 'since=<last generation> dedupes an unchanged snapshot');
  assert.ok(deduped.generation > bounded.generation);
  // An action clears refs; an unchanged reply must not strand the ones the agent holds.
  const heldRef = bounded.elements.find(item => item.name === 'Open fixture popup').ref;
  await api(`/v1/tabs/${colored[0].id}/actions`, 'POST', { action: 'scroll', x: 0, y: 0, epoch: colored[0].epoch });
  const afterAction = await api(`/v1/tabs/${colored[0].id}/snapshot?since=${deduped.generation}`);
  assert.equal(afterAction.unchanged, true);
  const reused = await apiRaw(`/v1/tabs/${colored[0].id}/actions`, 'POST', { action: 'move', ref: heldRef, epoch: colored[0].epoch });
  assert.equal(reused.status, 200, 'a ref from the last full snapshot still works after an unchanged reply');
  assert.equal((await apiRaw(`/v1/tabs/${colored[0].id}/snapshot?maxElements=abc`, 'GET', undefined, 'overseer-bot')).status, 400, 'non-integer bounds are rejected');
  const jpeg = await api(`/v1/tabs/${colored[0].id}/screenshot`);
  assert.equal(jpeg.mimeType, 'image/jpeg', 'screenshots default to jpeg');
  // Both inactive views occupy the same hidden host. Capturing the first must
  // still return its own pixels and the complete viewport, not the top view.
  const grab = () => api(`/v1/tabs/${colored[0].id}/screenshot?format=png&maxWidth=10000`).then(shot => nativeImage.createFromBuffer(Buffer.from(shot.base64, 'base64')));
  const image = await grab();
  const redWc = webContents.getAllWebContents().find(item => item.getURL().endsWith('/red'));
  const viewport = await redWc.executeJavaScript('({width:innerWidth,height:innerHeight,scale:devicePixelRatio})');
  assert.deepEqual(image.getSize(), { width: Math.round(viewport.width * viewport.scale), height: Math.round(viewport.height * viewport.scale) });
  // A loaded runner can return a frame captured before the page's raster
  // lands; recapture until the red is actually in the pixels.
  const pixel = await waitFor(async () => (await grab()).toBitmap().subarray(0, 3), px => px[2] > 200 && px[1] < 80 && px[0] < 80);
  // BGRA; the display's color profile shifts pure sRGB red slightly.
  const [b, g, r] = pixel;
  assert.ok(r > 200 && g < 80 && b < 80, `A background screenshot contains its own red pixels (got r=${r} g=${g} b=${b}).`);
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
  // An explicit takeover through the UI seals the tab: no bot can flip it
  // back — not the owner, a grantee or the overseer — and a bot POST of
  // 'human' cannot wash the lock. Only Give to agent hands it back.
  await invoke('control', { id: colored[0].id, controller: 'human' });
  for (const actor of ['capture-regression', '456', 'overseer-bot']) {
    const attempt = await apiRaw(`/v1/tabs/${colored[0].id}/control`, 'POST', { controller: 'agent' }, actor);
    assert.equal(attempt.status, 409, `${actor} cannot reverse an explicit human takeover`);
  }
  await api(`/v1/tabs/${colored[0].id}/control`, 'POST', { controller: 'human' }, '456');
  assert.equal((await apiRaw(`/v1/tabs/${colored[0].id}/control`, 'POST', { controller: 'agent' }, '456')).status, 409, 'POSTing human again does not clear the takeover seal');
  // While sealed, bot metadata shows the origin only — not the live page.
  const sealedMeta = (await apiRaw(`/v1/tabs/${colored[0].id}`, 'GET', undefined, '456')).data;
  assert.equal(sealedMeta.url, `http://127.0.0.1:${server.address().port}`, 'A sealed tab leaks its origin only');
  assert.equal(sealedMeta.title, '', 'A sealed tab leaks no title');
  assert.equal(sealedMeta.favicon, '', 'A sealed tab leaks no favicon');
  const humanMeta = (await apiRaw(`/v1/tabs/${human.id}`, 'GET', undefined, 'overseer-bot')).data;
  assert.equal(humanMeta.url, `http://127.0.0.1:${server.address().port}`, 'The overseer sees only the origin of the human tab');
  assert.equal(humanMeta.title, '');
  await invoke('control', { id: colored[0].id, controller: 'agent' });
  assert.equal((await api(`/v1/tabs/${colored[0].id}`, 'GET', undefined, '456')).controller, 'agent', 'Give to agent hands the sealed tab back');
  console.log('PASS: explicit takeover seals control and page metadata until the human hands the tab back.');
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
  // Snapshot refs stay valid across an entire batch until navigation.
  const formTab = await api('/v1/tabs', 'POST', { url: `http://127.0.0.1:${server.address().port}/form` });
  const formNames = ['Field A', 'Field B', 'Field C', 'Send form'];
  const formSnap = await waitFor(() => api(`/v1/tabs/${formTab.id}/snapshot`), snap => snap.title === 'form' && formNames.every(name => (snap.elements || []).some(el => el.name === name)));
  await waitFor(async () => {
    try { return (await api(`/v1/tabs/${formTab.id}/actions`, 'POST', { action: 'eval', code: 'typeof f.onsubmit', epoch: formTab.epoch })).value; }
    catch { return ''; }
  }, value => value === 'function');
  const refs = formNames.map(name => formSnap.elements.find(el => el.name === name).ref);
  const filled = await api(`/v1/tabs/${formTab.id}/actions`, 'POST', { action: 'batch', epoch: formTab.epoch, steps: [
    { action: 'type', ref: refs[0], text: 'one' }, { action: 'type', ref: refs[1], text: 'two' }, { action: 'type', ref: refs[2], text: 'three' }, { action: 'click', ref: refs[3] },
  ] });
  assert.equal(filled.results.length, 4, 'batch form fill by refs completes all steps');
  assert.equal((await api(`/v1/tabs/${formTab.id}/actions`, 'POST', { action: 'eval', code: "document.getElementById('out').textContent", epoch: formTab.epoch })).value, 'one|two|three');
  assert.ok(Number.isInteger(filled.generation) && filled.url.includes('/form') && filled.title === 'form', 'action responses carry page state');
  const closed = await api('/v1/tabs', 'POST', { url: `http://127.0.0.1:${server.address().port}/nav-a` });
  await fetch(new URL(`/v1/tabs/${closed.id}`, connection.url), { method: 'DELETE', headers: { Authorization: `Bearer ${connection.token}`, 'X-Hermes-Bot': 'capture-regression', 'X-Control-Epoch': String(closed.epoch) } });
  const missing = await apiRaw(`/v1/tabs/${closed.id}/snapshot`, 'GET');
  assert.equal(missing.status, 404, 'closed Mac tab returns local 404');
  assert.equal(missing.data.error, 'Tab not found.');
  const navTab = await api('/v1/tabs', 'POST', { url: `http://127.0.0.1:${server.address().port}/nav-a` });
  const navBatch = await api(`/v1/tabs/${navTab.id}/actions`, 'POST', { action: 'batch', epoch: navTab.epoch, steps: [
    { action: 'navigate', url: `http://127.0.0.1:${server.address().port}/nav-b` },
    { action: 'wait', url: '/nav-b', timeout: 5000 },
  ] });
  assert.equal(navBatch.results.length, 2);
  assert.ok(navBatch.results[1].waited >= 0 && navBatch.url.includes('/nav-b'), 'wait after navigate evaluates the new document');
  console.log('PASS: batch refs for multi-field forms, closed-tab 404, navigate-then-wait, and action page state.');
  // Batch replies carry the tab record once, and only the steps' own output.
  assert.equal(navBatch.results[0].tab, undefined, 'batch steps do not repeat the tab record');
  assert.equal(navBatch.results[0].url, undefined, 'batch steps do not repeat page state');
  assert.equal(navBatch.tab.epoch, navTab.epoch);
  assert.equal(navBatch.tab.agentCursor, undefined);
  assert.equal(navBatch.tab.favicon, undefined);
  // navigate answers with controls once the document parsed, while the page keeps loading.
  const slowStarted = Date.now();
  const navigated = await api(`/v1/tabs/${navTab.id}/actions`, 'POST', { action: 'navigate', url: `http://127.0.0.1:${server.address().port}/slow-load`, epoch: navTab.epoch });
  assert.ok(Date.now() - slowStarted < 2300, 'navigate did not wait for the slow image');
  assert.ok(navigated.elements.some(item => item.name === 'Early control'), 'navigate returns controls after DOMContentLoaded');
  assert.equal(navigated.loading, true, 'the reply says the page is still loading');
  // A failed load names Chromium's error.
  const unresolved = await apiRaw(`/v1/tabs/${navTab.id}/actions`, 'POST', { action: 'navigate', url: 'http://no-such-host.invalid/', epoch: navTab.epoch });
  assert.equal(unresolved.status, 400);
  assert.match(unresolved.data.error, /^Navigation failed: ERR_[A-Z_]+\.$/);
  // A click that navigates answers from the new page.
  const linkTab = await api('/v1/tabs', 'POST', { url: `http://127.0.0.1:${server.address().port}/link` });
  const linkSnap = await waitFor(() => api(`/v1/tabs/${linkTab.id}/snapshot`), snap => (snap.elements || []).some(item => item.name === 'Next page'));
  const followed = await api(`/v1/tabs/${linkTab.id}/actions`, 'POST', { action: 'click', ref: linkSnap.elements.find(item => item.name === 'Next page').ref, epoch: linkTab.epoch });
  assert.deepEqual([followed.url.endsWith('/nav-b'), followed.title], [true, 'nav-b'], 'a click that navigates answers after the new document parsed');
  // An identical tree re-rendered under the agent keeps its refs usable.
  const remount = await api('/v1/tabs', 'POST', { url: `http://127.0.0.1:${server.address().port}/remount` });
  const remountSnap = await waitFor(() => api(`/v1/tabs/${remount.id}/snapshot`), snap => (snap.elements || []).some(item => item.name === 'Beta'));
  await api(`/v1/tabs/${remount.id}/actions`, 'POST', { action: 'eval', code: 'render()', epoch: remount.epoch });
  const rescanned = await api(`/v1/tabs/${remount.id}/actions`, 'POST', { action: 'scroll', y: 0, epoch: remount.epoch });
  assert.equal(rescanned.effect.changed, false, 'the re-rendered tree reads as unchanged');
  assert.equal(rescanned.elements, undefined, 'unchanged controls are not resent');
  await api(`/v1/tabs/${remount.id}/actions`, 'POST', { action: 'click', ref: remountSnap.elements.find(item => item.name === 'Beta').ref, epoch: remount.epoch });
  assert.deepEqual((await api(`/v1/tabs/${remount.id}/actions`, 'POST', { action: 'eval', code: 'hits', epoch: remount.epoch })).value, [2], 'a held ref clicks the re-rendered node');
  // A page whose image never answers still reads, evaluates and waits.
  const hang = await api('/v1/tabs', 'POST', { url: `http://127.0.0.1:${server.address().port}/hang-img` });
  const hangStarted = Date.now();
  const hangSnap = await api(`/v1/tabs/${hang.id}/snapshot`);
  assert.ok(hangSnap.elements.some(item => item.name === 'Ready'), 'snapshot does not wait for the stalled image');
  assert.equal((await api(`/v1/tabs/${hang.id}/actions`, 'POST', { action: 'eval', code: 'document.title', epoch: hang.epoch })).value, 'hang');
  assert.equal((await api(`/v1/tabs/${hang.id}/actions`, 'POST', { action: 'wait', selector: 'button', timeout: 3000, epoch: hang.epoch })).dispatched, true);
  assert.ok(Date.now() - hangStarted < 5000, 'snapshot, eval and wait finished well inside the stalled load');
  // A wait whose client hung up stops polling and frees the queue.
  const patient = (body, signal) => fetch(new URL(`/v1/tabs/${hang.id}/actions`, connection.url), { method: 'POST', signal, headers: { Authorization: `Bearer ${connection.token}`, 'X-Hermes-Bot': 'capture-regression', 'Content-Type': 'application/json' }, body: JSON.stringify({ epoch: hang.epoch, ...body }) });
  const walkAway = new AbortController();
  const longWait = patient({ action: 'wait', selector: '#nothing', timeout: 30000 }, walkAway.signal).catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 300));
  walkAway.abort(); await longWait;
  const freed = Date.now();
  assert.equal((await api(`/v1/tabs/${hang.id}/actions`, 'POST', { action: 'eval', code: '1 + 1', epoch: hang.epoch })).value, 2);
  assert.ok(Date.now() - freed < 4000, 'the queue is free again soon after the client left a long wait');
  // An action whose client already hung up never runs.
  const queueTab = await api('/v1/tabs', 'POST', { url: `http://127.0.0.1:${server.address().port}/nav-a` });
  await waitFor(() => api(`/v1/tabs/${queueTab.id}/snapshot`), snap => snap.title === 'nav-a');
  const post = (body, signal) => fetch(new URL(`/v1/tabs/${queueTab.id}/actions`, connection.url), { method: 'POST', signal, headers: { Authorization: `Bearer ${connection.token}`, 'X-Hermes-Bot': 'capture-regression', 'Content-Type': 'application/json' }, body: JSON.stringify({ epoch: queueTab.epoch, ...body }) });
  const blocker = post({ action: 'wait', text: 'never appears', timeout: 1200 });
  await new Promise(resolve => setTimeout(resolve, 150));
  const hangup = new AbortController();
  const abandoned = post({ action: 'eval', code: 'window.__abandoned = 1' }, hangup.signal).catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 150));
  hangup.abort(); await abandoned; await blocker;
  assert.equal((await api(`/v1/tabs/${queueTab.id}/actions`, 'POST', { action: 'eval', code: 'window.__abandoned === undefined', epoch: queueTab.epoch })).value, true, 'a queued action from an aborted request is skipped');
  console.log('PASS: compact batch replies, navigate controls after DOMContentLoaded, net error detail, click-initiated navigation, and aborted queue skipping.');
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
  // The cdp surface is a per-method policy, not a domain grant: cookie and
  // storage access, file pickers, request interception, persistent scripts
  // and privileged fetches are denied, and Page.navigate shares the agent
  // address check.
  for (const method of ['Network.getCookies', 'Network.getAllCookies', 'Network.setCookie', 'Network.clearBrowserCookies', 'Network.clearBrowserCache', 'Network.loadNetworkResource', 'DOM.setFileInputFiles', 'Page.setInterceptFileChooserDialog', 'Page.addScriptToEvaluateOnNewDocument', 'Page.setDownloadBehavior', 'Fetch.enable', 'Storage.getCookies']) {
    const denied = await apiRaw(`/v1/tabs/${colored[1].id}/actions`, 'POST', { action: 'cdp', method, params: {}, epoch: seizedTab.epoch }, 'overseer-bot');
    assert.equal(denied.status, 400, `cdp denies ${method}`);
  }
  assert.equal((await apiRaw(`/v1/tabs/${colored[1].id}/actions`, 'POST', { action: 'cdp', method: 'Page.navigate', params: { url: 'file:///etc/passwd' }, epoch: seizedTab.epoch }, 'overseer-bot')).status, 400, 'cdp Page.navigate cannot open file: urls');
  const cdpNav = await api(`/v1/tabs/${colored[1].id}/actions`, 'POST', { action: 'cdp', method: 'Page.navigate', params: { url: `http://127.0.0.1:${server.address().port}/blue` }, epoch: seizedTab.epoch }, 'overseer-bot');
  assert.ok(cdpNav.value.frameId, 'cdp Page.navigate still works on allowed urls');
  await waitFor(() => api(`/v1/tabs/${colored[1].id}/snapshot`, 'GET', undefined, 'overseer-bot'), snap => snap.title === 'blue');
  // Agent navigation never reaches link-local or metadata addresses, even
  // with the fixture's loopback opt-in enabled.
  for (const bad of ['http://169.254.169.254/latest/meta-data', 'http://0.0.0.0:1/']) {
    assert.equal((await apiRaw('/v1/tabs', 'POST', { url: bad, background: true })).status, 400, `bot tab create to ${bad}`);
    assert.equal((await apiRaw(`/v1/tabs/${colored[1].id}/actions`, 'POST', { action: 'navigate', url: bad, epoch: seizedTab.epoch }, 'overseer-bot')).status, 400, `navigate to ${bad}`);
  }
  console.log('PASS: cdp per-method denylist, Page.navigate address check, and link-local navigation refusal.');
  // Reads re-check control inside the queue: screenshots still pending when
  // the human takes over come back 409, and a tab holds at most 8 of them.
  const capped = await Promise.all([...Array(12)].map(() => apiRaw(`/v1/tabs/${colored[1].id}/screenshot`, 'GET', undefined, 'overseer-bot')));
  assert.ok(capped.some(r => r.status === 429), `pending reads cap at 8 (${capped.map(r => r.status)})`);
  assert.ok(capped.every(r => [200, 429].includes(r.status)));
  const swarm = Promise.all([...Array(8)].map(() => apiRaw(`/v1/tabs/${colored[1].id}/screenshot`, 'GET', undefined, 'overseer-bot')));
  await new Promise(r => setTimeout(r, 25));
  await invoke('control', { id: colored[1].id, controller: 'human' });
  const drained = await swarm;
  assert.ok(drained.some(r => r.status === 409), `queued reads re-check control after a takeover (${drained.map(r => r.status)})`);
  assert.ok(drained.every(r => [200, 409].includes(r.status)));
  console.log('PASS: pending-read cap and queued-read sealing across a takeover.');
  // A takeover mid-eval seals the result; Give to agent reopens the tab.
  await invoke('control', { id: colored[1].id, controller: 'agent' });
  const midEpoch = (await api(`/v1/tabs/${colored[1].id}`, 'GET', undefined, 'overseer-bot')).epoch;
  const slowEval = apiRaw(`/v1/tabs/${colored[1].id}/actions`, 'POST', { action: 'eval', code: 'new Promise(r => setTimeout(() => r(document.title), 800))', epoch: midEpoch }, 'overseer-bot');
  await new Promise(r => setTimeout(r, 150));
  await invoke('control', { id: colored[1].id, controller: 'human' });
  assert.equal((await slowEval).status, 409, 'a mid-flight eval is sealed by takeover');
  console.log('PASS: in-flight eval results stay sealed after a takeover.');
  // Favicons fetch only same-origin icons, without the browser session.
  const favTab = await api('/v1/tabs', 'POST', { url: `http://127.0.0.1:${server.address().port}/favicon-local`, background: true });
  await waitFor(() => api(`/v1/tabs/${favTab.id}`), tab => typeof tab.favicon === 'string' && tab.favicon.startsWith('data:image/png;base64,'), 8000);
  const crossTab = await api('/v1/tabs', 'POST', { url: `http://127.0.0.1:${server.address().port}/favicon-cross`, background: true });
  await waitFor(() => api(`/v1/tabs/${crossTab.id}`), tab => tab.title === 'favicon-cross');
  await new Promise(r => setTimeout(r, 1200));
  assert.equal((await api(`/v1/tabs/${crossTab.id}`)).favicon, '', 'a cross-origin favicon is never fetched');
  console.log('PASS: favicons come only from the page origin and fetch without browser cookies.');
  // The saved VPS ssh target is validated like the Mac one — a stored option
  // injection can no longer reach ssh argv.
  await assert.rejects(invoke('settings', { vpsBrowser: { sshHost: '-oProxyCommand=touch /tmp/hs-pwn', scriptPath: '/x' } }), /user@host/);
  console.log('PASS: settings rejects a non-host VPS SSH target.');
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
  // The toolbar bubble lists downloads like other browsers. A synthetic item
  // through the real session exercises the store, commands and menu markup.
  const downloadListeners = {};
  const fakeDownload = {
    name: 'fixture-report.pdf', url: 'https://example.com/dl', path: '', total: 2048, received: 512, state: 'progressing', paused: false,
    getFilename() { return this.name; }, getURL() { return this.url; }, getState() { return this.state; },
    getTotalBytes() { return this.total; }, getReceivedBytes() { return this.received; },
    getSavePath() { return this.path; }, isPaused() { return this.paused; }, canResume() { return this.paused; },
    pause() { this.paused = true; }, resume() { this.paused = false; },
    cancel() { this.state = 'cancelled'; (downloadListeners.done || []).forEach(fn => fn({}, 'cancelled')); },
    setSaveDialogOptions() {}, on(n, f) { (downloadListeners[n] ||= []).push(f); }, once(n, f) { this.on(n, f); },
  };
  session.fromPartition('persist:browser').emit('will-download', {}, fakeDownload);
  state = await evaluate('window.workspace.getState()');
  assert.equal(state.downloads[0]?.name, 'fixture-report.pdf');
  assert.equal(state.downloads[0]?.state, 'progressing');
  assert.equal(state.downloads[0]?.source, 'example.com');
  await evaluate('document.getElementById("downloads-button").click()');
  await waitFor(() => evaluate('document.querySelectorAll("#downloads-menu .download-row").length'), count => count >= 1);
  assert.equal(await evaluate('document.getElementById("downloads-button").getAttribute("aria-expanded")'), 'true');
  assert.equal(await evaluate('document.getElementById("downloads-button").classList.contains("active")'), true, 'An active download marks the button.');
  await invoke('pause-download', { id: state.downloads[0].id, paused: true });
  assert.equal(fakeDownload.paused, true, 'Pause reaches the live download item.');
  (downloadListeners.updated || []).forEach(fn => fn({}, 'progressing'));
  await waitFor(() => evaluate('window.workspace.getState()'), value => value.downloads[0]?.paused === true);
  fakeDownload.received = 2048; fakeDownload.state = 'completed'; fakeDownload.path = path.join(profile, 'fixture-report.pdf');
  (downloadListeners.done || []).forEach(fn => fn({}, 'completed'));
  state = await waitFor(() => evaluate('window.workspace.getState()'), value => value.downloads[0]?.state === 'completed');
  assert.equal(await waitFor(() => evaluate('document.getElementById("downloads-button").classList.contains("active")'), active => active === false), false, 'Finished downloads clear the button badge.');
  assert.ok((await evaluate('document.querySelector("#downloads-menu .download-status")?.textContent || ""')).includes('KB'), 'A finished download shows its size.');
  console.log('PASS: downloads bubble lists a live download, pauses it, then shows the finished size.');

  // The app's own page is the only thing the bridge-bearing window may show.
  const indexUrl = wc.getURL();
  await evaluate(`location.href = 'file:///etc/hosts'`).catch(() => {});
  await new Promise(r => setTimeout(r, 400));
  assert.equal(wc.getURL(), indexUrl, 'renderer-initiated navigation away from the app page is cancelled');
  const windowsBefore = BrowserWindow.getAllWindows().length;
  await evaluate(`window.open('https://example.com/'); 0`);
  await new Promise(r => setTimeout(r, 400));
  assert.equal(BrowserWindow.getAllWindows().length, windowsBefore, 'the main window cannot open windows');
  const strangerFile = path.join(profile, 'stranger.html');
  fs.writeFileSync(strangerFile, '<!doctype html><title>stranger</title>');
  await wc.loadFile(strangerFile);
  assert.equal(await evaluate('typeof window.workspace'), 'object', 'the preload bridge is present on any file page');
  assert.match(await evaluate('window.workspace.getState().then(() => "allowed", error => error.message)'), /Untrusted workspace request/, 'a dropped local file cannot use the bridge');
  await wc.loadFile(path.join(__dirname, '../src/index.html'));
  await waitFor(() => evaluate('window.workspace.getState().then(() => true, () => false)').catch(() => false), Boolean);
  console.log('PASS: app window refuses navigation and popups, and the IPC bridge trusts only the exact app page.');

  // Connector requests need a loopback Host header as well as the token.
  const connectionFile = JSON.parse(fs.readFileSync(path.join(profile, 'connection.json'), 'utf8'));
  const hostStatus = (hostHeader) => new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: new URL(connectionFile.url).port, path: '/v1/status', headers: { Authorization: `Bearer ${connectionFile.token}`, ...(hostHeader ? { Host: hostHeader } : {}) } },
      response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject); request.end();
  });
  const apiPort = new URL(connectionFile.url).port;
  assert.equal(await hostStatus(), 200);
  assert.equal(await hostStatus(`localhost:${apiPort}`), 200);
  assert.equal(await hostStatus(`rebind.example:${apiPort}`), 401, 'a non-loopback Host header is refused even with the token');
  assert.equal(await hostStatus('127.0.0.1:1'), 401);
  console.log('PASS: connector enforces a loopback Host header.');

  // Telegram keeps normal throttling, so a tray-hidden window really goes idle.
  if (telegram && !telegram.isDestroyed()) {
    win.hide();
    assert.equal(await waitFor(() => telegram.executeJavaScript('document.hidden'), value => value === true), true, 'a hidden window leaves Telegram hidden (throttling stays on)');
    win.show();
    console.log('PASS: hiding the window hides Telegram too, with throttling left on.');
  }

  // A crashed Telegram renderer is reloaded with backoff instead of staying offline.
  if (telegram && !telegram.isDestroyed()) {
    telegram.forcefullyCrashRenderer();
    await waitFor(() => evaluate('window.workspace.getState()'), value => value.telegramStatus === 'offline');
    await waitFor(() => telegram.isDestroyed() ? 'gone' : telegram.getURL(), url => url.startsWith('https://web.telegram.org'), 15000);
    console.log('PASS: crashed Telegram view is marked offline and reloaded automatically.');
  }
  server.close(); portBlocker.close(); app.quit();
}).catch(error => { console.error(error.stack); server?.close(); app.exit(1); });
