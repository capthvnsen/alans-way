const { ip: fixtureTailnet, otherIp: fixtureTailnetOther } = require('./tailnet-fixture.cjs');
process.env.HERMES_WORKSPACE_ALLOW_LOOPBACK = '1';
const { resizeWindow } = require('./window-fixture.cjs');
// Real Electron Settings + main persistence/copy; external work is blocked.
// Run with: node test/run-electron.cjs test/connections-journey-electron.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const electron = require('electron');
const { captureClipboard, restoreClipboard } = require('./clipboard-fixture.cjs');
const { app, BrowserWindow, ipcMain, session, clipboard } = electron;
// A locked Mac can return incomplete accelerated surface readbacks.
// Software compositing is fixture-only and identical for both comparisons.
app.disableHardwareAcceleration();
const { prepareFixture, quitFixture } = require('./electron-fixture.cjs');
const profile = process.env.HERMES_TEST_PROFILE;
assert.ok(profile, 'Use run-electron.cjs for disposable storage.');
prepareFixture(profile);
app.getVersion = () => require('../package.json').version;
const phase = process.env.CONNECTIONS_PHASE || 'green';
const out = process.env.CONNECTIONS_OUT || path.resolve(__dirname, '../../evidence/quality/connections-journey');
fs.mkdirSync(out, { recursive: true });
const results = [], observations = {}, safety = [], calls = [], gates = [], seams = new Map();
const bots = [{ id: '74001', name: 'Journey researcher', username: 'journey_fixture_bot' }, { id: '74002', name: 'Second researcher', username: 'journey_second_bot' }];
const fixtureBots = phase === 'no-bot' ? [] : bots;
fs.writeFileSync(path.join(profile, 'preferences.json'), JSON.stringify({ onboarded: true, bots: fixtureBots, selectedBotId: fixtureBots[0]?.id || '', hidden: [], preview: false, macSshHost: '', vpsBrowser: {}, remoteUrl: '' }));
// Never activate an OS window or access a real external process/service.
app.focus = () => { safety.push({ prevented: 'app.focus' }); };
app.on('web-contents-created', (_event, contents) => { contents.focus = () => { safety.push({ prevented: 'contents.focus' }); }; });
const Module = require('node:module'), load = Module._load;
const facade = { ...electron, BrowserWindow: new Proxy(BrowserWindow, { construct(C, args) {
  const win = new C({ ...args[0], show: false });
  win.focus = () => { safety.push({ prevented: 'window.focus' }); };
  win.show = () => win.showInactive();
  setImmediate(() => { if (!win.isDestroyed()) win.showInactive(); });
  return win;
} }) };
Module._load = function(request, ...args) { return request === 'electron' ? facade : load.call(this, request, ...args); };
const cp = require('node:child_process');
for (const method of ['spawn', 'exec', 'execFile', 'execFileSync', 'spawnSync', 'execSync']) cp[method] = (...args) => { safety.push({ blockedProcess: method, command: String(args[0]) }); throw Error('Connections fixture forbids external processes.'); };
const fetch0 = global.fetch;
global.fetch = (url, ...args) => /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(String(url)) ? fetch0(url, ...args) : (safety.push({ blockedFetch: String(url) }), Promise.reject(Error('Connections fixture blocks external network.')));
app.whenReady().then(() => {
  for (const partition of [undefined, 'persist:browser', 'persist:telegram']) {
    const s = partition ? session.fromPartition(partition) : session.defaultSession;
    const register = s.webRequest.onBeforeRequest.bind(s.webRequest);
    const guard = fn => (details, done) => {
      if (/^https?:/.test(details.url) && !/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(details.url)) { safety.push({ blockedRequest: details.url }); return done({ cancel: true }); }
      return fn ? fn(details, done) : done({});
    };
    s.webRequest.onBeforeRequest = (...args) => register(guard(typeof args.at(-1) === 'function' ? args.at(-1) : null));
    register(guard(null));
  }
});
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => handle(channel, channel !== 'workspace:command' ? handler : async (event, name, value) => {
  const call = { name, value, at: Date.now() }; calls.push(call);
  if (seams.has(name)) { call.intercepted = true; return seams.get(name)(value); }
  const result = await handler(event, name, value);
  const gate = gates.find(g => !g.entered && g.match(name, value));
  if (gate) { gate.entered = true; await gate.pending; }
  call.replied = Date.now(); return result;
});
const target = process.env.CONNECTIONS_TARGET || path.resolve(__dirname, '..');
const sourceHashes = Object.fromEntries(['src/main.cjs', 'src/renderer.js', 'src/style.css', 'src/preload.bundle.cjs', 'package.json', 'package-lock.json'].map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(target, file))).digest('hex')]));
require(path.join(target, 'src/main.cjs'));
const pause = (ms = 25) => new Promise(resolve => setTimeout(resolve, ms));
async function wait(read, predicate = Boolean) { for (let i = 0; i < 200; i++) { const value = await read(); if (predicate(value)) return value; await pause(); } throw Error('Timed out waiting for Connections UI.'); }
let win, wc, server;
const holdSave = key => { let release; const gate = { match: (name, value) => name === 'settings' && key in value, pending: new Promise(resolve => { release = resolve; }), release: () => release() }; gates.push(gate); return gate; };
app.whenReady().then(async () => {
  win = await wait(() => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html')));
  wc = win.webContents;
  const js = code => wc.executeJavaScript(code);
  await wait(() => js('!!state?.api?.ready').catch(() => false));
  wc.debugger.attach('1.3'); await wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
  const frame = () => js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  const key = async (key, shift = false) => { const params = { key, code: key === ' ' ? 'Space' : key, windowsVirtualKeyCode: { Tab: 9, Enter: 13, Escape: 27, ' ': 32 }[key], modifiers: shift ? 8 : 0 }; await wc.debugger.sendCommand('Input.dispatchKeyEvent', { ...params, type: 'keyDown', ...(key === 'Enter' ? { text: '\r' } : key === ' ' ? { text: ' ' } : {}) }); await wc.debugger.sendCommand('Input.dispatchKeyEvent', { ...params, type: 'keyUp' }); await frame(); };
  const click = async selector => { const point = await js(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); if(!e)throw Error('Missing target '+${JSON.stringify(selector)}); e.scrollIntoView({block:'nearest'}); const r=e.getBoundingClientRect(); if(!r.width||!r.height)throw Error('Hidden target '+${JSON.stringify(selector)}); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`); await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 }); await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 }); await frame(); };
  const fill = async (selector, text) => { await click(selector); await js(`document.querySelector(${JSON.stringify(selector)}).select()`); await wc.debugger.sendCommand('Input.insertText', { text }); await frame(); };
  const search = text => fill('#settings-search', text);
  const call = (name, value) => js(`workspace.command(${JSON.stringify(name)},${JSON.stringify(value)})`);
  const disk = () => JSON.parse(fs.readFileSync(path.join(profile, 'preferences.json')));
  const shot = async name => { await frame(); const capture = await wc.debugger.sendCommand('Page.captureScreenshot', { format: 'png', fromSurface: true }); fs.writeFileSync(path.join(out, `${phase}-${name}.png`), Buffer.from(capture.data, 'base64')); };
  const open = async () => { await call('settings', {showBots:true}); if (await js('!!settingsSession')) await click('#modal-close'); await click(await js('document.getElementById("settings-button").getBoundingClientRect().width?"#settings-button":"#settings-fallback"')); await click('#settings-category-connections'); };
  const disclose = async id => { if (await js(`!!document.querySelector(${JSON.stringify(id)})&&!document.querySelector(${JSON.stringify(id)}).open`)) await click(`${id} > summary`); };
  const idle = selector => wait(() => js(`!document.querySelector(${JSON.stringify(selector)}).hasAttribute('aria-busy')`));
  const saveRemote = () => click('[data-settings-section=remote-desktop] .primary-button');
  const check = async (name, fn) => { if (process.env.CONNECTIONS_CASE && !name.includes(process.env.CONNECTIONS_CASE)) return; try { await open(); await fn(); results.push({ name, pass: true }); console.log('PASS:', name); } catch (error) { results.push({ name, pass: false, error: error.stack }); console.error('FAIL:', name, error.message); await shot('failure-' + results.length); } finally { for (const gate of gates) gate.release(); gates.length = 0; seams.clear(); } };
  server = http.createServer((_req, res) => res.end('<!doctype html><title>Inert loopback viewer fixture</title>'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const url = `http://127.0.0.1:${server.address().port}/vnc.html`;
  await resizeWindow(win, 1280, 800); await frame();
  await js('window.journeyInputs=[];for(const type of ["keydown","pointerdown","input"])document.addEventListener(type,e=>journeyInputs.push({type,key:e.key,trusted:e.isTrusted,id:e.target.id}),true);true');
  if (phase === 'no-bot') {
    await check('no bot keeps setup unavailable with an explicit way to choose a bot', async () => {
      assert.equal(await js('document.getElementById("settings-copy-setup-prompt").disabled'), true); assert.equal(await js('document.getElementById("settings-setup-bot").disabled'), true);
      assert.match(await js('document.getElementById("settings-content").innerText'), /Open a bot in Telegram/); assert.equal(calls.filter(c => c.name === 'agent-prompt' || c.name === 'agent-setup').length, 0); await shot('no-bot');
    });
    return;
  }
  await check('first glance separates the local computer, existing Hermes machine and optional remote desktop', async () => {
    observations.firstGlance = await js(`(() => {const p=document.getElementById('settings-content'),r=p.getBoundingClientRect();return {text:p.innerText,fields:[...p.querySelectorAll('input')].filter(e=>e.getBoundingClientRect().height&&!e.closest('details:not([open])')&&!e.closest('[hidden]')).length,buttons:[...p.querySelectorAll('button')].filter(e=>e.getBoundingClientRect().height&&!e.closest('details:not([open])')&&!e.closest('[hidden]')).map(e=>e.textContent),headings:[...p.querySelectorAll('section:not([hidden]) h3')].map(e=>({text:e.textContent,bottom:e.getBoundingClientRect().bottom,visible:e.getBoundingClientRect().bottom<=r.bottom})),scrollHeight:p.scrollHeight,height:p.clientHeight}})()`);
    await shot('first-glance');
    if (process.env.CONNECTIONS_VISUAL_PROBE) {
      const dims = await js('[innerWidth,innerHeight]');
      const full = await wc.debugger.sendCommand('Page.captureScreenshot', {format:'png',fromSurface:true,captureBeyondViewport:true,clip:{x:0,y:0,width:dims[0],height:dims[1],scale:1}}); fs.writeFileSync(path.join(out, `${phase}-full-surface-first-glance.png`), Buffer.from(full.data,'base64'));
      observations.visualProbe = await js(`['modal','modal-body','settings-navigation','settings-content-title'].map(id=>{const e=document.getElementById(id),s=getComputedStyle(e),r=e.getBoundingClientRect();return {id,classes:e.className,opacity:s.opacity,visibility:s.visibility,display:s.display,background:s.backgroundColor,rect:{x:r.x,y:r.y,width:r.width,height:r.height}}})`);
      const bounds = win.getContentSize(); await resizeWindow(win, bounds[0] + 1, bounds[1]); await frame(); await resizeWindow(win, ...bounds); await frame(); await pause(180); await frame();
      await shot('settled-first-glance');
      const cdp = await wc.debugger.sendCommand('Page.captureScreenshot', { format: 'png', fromSurface: true }); fs.writeFileSync(path.join(out, `${phase}-cdp-first-glance.png`), Buffer.from(cdp.data, 'base64'));
      await pause(200); await shot('settled-repeat-first-glance');
    }
    const route = []; await click('#settings-category-connections');
    for (let n = 0; n < 60; n++) {
      await key('Tab'); route.push(await js('document.activeElement.id||document.activeElement.getAttribute("aria-label")||document.activeElement.textContent'));
      if (await js('document.activeElement.textContent === "Copy setup prompt"')) break;
    }
    observations.firstGlance.keyboardRouteToPrompt = route;
    assert.ok(route.at(-1) === 'Copy setup prompt' || route.at(-1) === 'settings-copy-setup-prompt');
    assert.deepEqual(observations.firstGlance.headings.map(h => h.text), ['This computer', 'Agent machine', 'Remote desktop · Optional']);
    assert.equal(observations.firstGlance.fields, 0, 'Technical fields stay behind named disclosures');
    assert.ok(observations.firstGlance.headings.every(h => h.visible), 'All roles visible without scrolling at 1280x800');
    assert.deepEqual(observations.firstGlance.buttons, ['Copy setup prompt', 'Enter addresses from the agent’s reply'], 'Setup starts with the prompt and has a direct route back from the agent’s reply');
    assert.match(observations.firstGlance.text, /Paste.*Hermes chat/i);
  });
  await check('new remote URL draft survives its real pending save, completion, broadcast and explicit later save', async () => {
    await disclose('#settings-remote-details'); await fill('#remote-url', url + '?saved=one'); const gate = holdSave('remoteUrl'); await saveRemote(); await wait(() => gate.entered);
    await fill('#remote-url', url + '?unsaved=two'); await shot('remote-draft-pending'); gate.release(); await idle('[data-settings-section=remote-desktop] .primary-button');
    await call('settings', { showBots: true }); await frame();
    observations.remoteDraft = await js('({value:document.getElementById("remote-url").value,dirty:document.getElementById("remote-url").dataset.dirty,focus:document.activeElement.id})');
    await shot('remote-draft-after-broadcast'); assert.equal(observations.remoteDraft.value, url + '?unsaved=two'); assert.equal(observations.remoteDraft.dirty, 'true'); assert.equal(observations.remoteDraft.focus, 'remote-url'); assert.equal(disk().remoteUrl, url + '?saved=one');
    const before = calls.filter(c => c.name === 'settings' && 'remoteUrl' in c.value).length; await saveRemote(); await idle('[data-settings-section=remote-desktop] .primary-button'); assert.equal(disk().remoteUrl, url + '?unsaved=two'); assert.equal(calls.filter(c => c.name === 'settings' && 'remoteUrl' in c.value).length - before, 1);
  });
  await check('new SSH drafts survive a real pending address save independently for both fields', async () => {
    await disclose('#settings-agent-details'); await fill('#vps-ssh-host', `first@${fixtureTailnet}`); await fill('#mac-ssh-host', `local@${fixtureTailnet}`);
    const save = '#settings-save-addresses', selector = await js('document.querySelector("#settings-save-addresses")?"#settings-save-addresses":null') || '[data-settings-section=agent-setup] button';
    // On the original UI Save addresses is the first button in this section.
    const gate = holdSave('macSshHost'); await click(selector); await wait(() => gate.entered);
    await fill('#vps-ssh-host', `second@${fixtureTailnet}`); await fill('#mac-ssh-host', `newlocal@${fixtureTailnet}`); gate.release(); await idle(selector);
    await call('settings', { showBots: false }); await frame();
    assert.equal(await js('document.getElementById("vps-ssh-host").value'), `second@${fixtureTailnet}`); assert.equal(await js('document.getElementById("mac-ssh-host").value'), `newlocal@${fixtureTailnet}`);
    assert.equal(await js('document.getElementById("vps-ssh-host").dataset.dirty'), 'true'); assert.equal(await js('document.getElementById("mac-ssh-host").dataset.dirty'), 'true');
    assert.equal(disk().vpsBrowser.sshHost, `first@${fixtureTailnet}`); const before = calls.length; await click(selector); await idle(selector);
    assert.equal(disk().vpsBrowser.sshHost, `second@${fixtureTailnet}`); assert.equal(disk().macSshHost, `newlocal@${fixtureTailnet}`); assert.equal(calls.slice(before).filter(c => c.name === 'settings').length, 1);
  });
  await check('held successful path reply cannot verify a newly edited host (IPC-intercepted SSH result)', async () => {
    await call('settings', { macSshHost: `local@${fixtureTailnet}`, vpsBrowser: { enabled: false, sshHost: `agent@${fixtureTailnet}` } }); await disclose('#settings-agent-details'); let release, entered = false;
    seams.set('test-agent-path', () => { entered = true; return new Promise(resolve => { release = resolve; }); });
    const before = calls.filter(c => c.name === 'test-agent-path').length;
    await click('#settings-test-path'); await wait(() => entered); await key('Enter'); await click('#settings-test-path');
    await fill('#vps-ssh-host', `changed@${fixtureTailnet}`);
    release({ ok: true, detail: 'HELD_OLD_SUCCESS: fixture says the old path passed.' }); await idle('#settings-test-path');
    await call('settings', { showBots: true }); await frame();
    const text = await js('document.querySelector("[data-settings-section=agent-setup]").innerText'); await shot('stale-host-reply');
    assert.doesNotMatch(text, /HELD_OLD_SUCCESS/); assert.match(text, /changed|save.*address/i); assert.equal(calls.filter(c => c.name === 'test-agent-path').length - before, 1);
    assert.equal(await js('document.activeElement.id'), 'vps-ssh-host'); assert.equal(await js('document.getElementById("vps-ssh-host").value'), `changed@${fixtureTailnet}`);
  });
  if (phase.startsWith('red')) return;
  await check('blank and malformed addresses and viewer URLs use real validation and retain drafts', async () => {
    await disclose('#settings-agent-details');
    for (const bad of ['bad host', 'user@host;echo nope']) {
      await fill('#vps-ssh-host', bad); await click('#settings-save-addresses'); await idle('#settings-save-addresses');
      assert.equal(await js('document.getElementById("vps-ssh-host").value'), bad); assert.match(await js('document.querySelector("#settings-save-addresses + .settings-action-status").textContent'), /SSH address/); assert.notEqual(disk().vpsBrowser.sshHost, bad);
    }
    await fill('#vps-ssh-host', ''); await fill('#mac-ssh-host', ''); await click('#settings-save-addresses'); await idle('#settings-save-addresses');
    assert.equal(disk().vpsBrowser.sshHost, ''); assert.equal(disk().macSshHost, ''); assert.equal(await js('document.getElementById("settings-test-path").hidden'), true); assert.match(await js('document.getElementById("settings-agent-summary").textContent'), /No agent address saved/);
    await disclose('#settings-remote-details');
    for (const bad of ['not a URL', 'file:///tmp/viewer']) {
      await fill('#remote-url', bad); await saveRemote(); await idle('[data-settings-section=remote-desktop] .primary-button');
      assert.equal(await js('document.getElementById("remote-url").value'), bad); assert.notEqual(disk().remoteUrl, bad); assert.match(await js('document.querySelector("[data-settings-section=remote-desktop] .settings-action-status").textContent'), /http|URL/i);
    }
    await fill('#remote-url', ''); await saveRemote(); await idle('[data-settings-section=remote-desktop] .primary-button'); assert.equal(disk().remoteUrl, ''); await shot('validation-and-empty');
  });
  await check('existing configured route has one primary check and truthful retry after refused, offline and slow outcomes (IPC-intercepted)', async () => {
    await call('settings', { macSshHost: `local@${fixtureTailnet}`, vpsBrowser: { sshHost: `agent@${fixtureTailnet}` } });
    assert.equal(await js('document.querySelector("[data-settings-section=agent-setup] .primary-button").id'), 'settings-test-path');
    assert.match(await js('document.getElementById("settings-agent-summary").textContent'), /Addresses saved.*not checked/);
    for (const detail of ['Connection refused (IPC fixture).', 'Agent machine offline (IPC fixture).']) {
      seams.set('test-agent-path', async () => ({ ok: false, detail })); await click('#settings-test-path'); await idle('#settings-test-path');
      assert.equal(await js('document.querySelector("[data-settings-section=agent-setup] .connection-check-status").textContent'), detail); assert.equal(await js('document.activeElement.id'), 'settings-test-path');
    }
    seams.set('test-agent-path', async () => { throw Error('Slow path timed out (IPC fixture). Retry.'); }); await click('#settings-test-path'); await idle('#settings-test-path'); assert.match(await js('document.querySelector("[data-settings-section=agent-setup] .connection-check-status").textContent'), /timed out/);
    seams.set('test-agent-path', async () => ({ ok: true, detail: 'Synthetic success; no SSH.' })); await click('#settings-test-path'); await idle('#settings-test-path');
    assert.match(await js('document.querySelector("[data-settings-section=agent-setup] .connection-check-status").textContent'), /SSH path passed.*authentication.*not checked/); await shot('configured-ssh-only-result');
    seams.set('test-agent-path', async () => { throw Error('IPC delivery failed after previous successful fixture.'); }); await click('#settings-test-path'); await idle('#settings-test-path');
    assert.match(await js('document.getElementById("settings-agent-summary").textContent'), /not checked/);
  });
  await check('held check cannot verify a different bot and a reopened session ignores the old result (IPC-intercepted)', async () => {
    let release, entered = false; seams.set('test-agent-path', () => { entered = true; return new Promise(resolve => { release = resolve; }); });
    await click('#settings-test-path'); await wait(() => entered); await call('open-bot', { id: bots[1].id }); await frame();
    release({ ok: true, detail: 'HELD_OLD_BOT_SUCCESS' }); await idle('#settings-test-path');
    assert.equal(await js('document.getElementById("settings-setup-bot").value'), bots[1].id); assert.match(await js('document.querySelector("[data-settings-section=agent-setup] .connection-check-status").textContent'), /bot changed/);
    entered = false; await click('#settings-test-path'); await wait(() => entered); await click('#modal-close'); await open();
    release({ ok: true, detail: 'HELD_OLD_SESSION_SUCCESS' }); await frame(); assert.doesNotMatch(await js('document.getElementById("settings-content").innerText'), /passed|HELD_OLD/); await shot('bot-and-session-stale');
  });
  await check('actual copied setup payloads match the reviewed bot and clipboard is restored without setup execution', async () => {
    const before = await captureClipboard();
    const formats = before.items.flatMap(item => item.types);
    try {
      await click('#settings-copy-setup-prompt'); await idle('#settings-copy-setup-prompt'); const prompt = await clipboard.readText();
      assert.match(prompt, /https:\/\/openalan.com\/agent-prompt/); assert.match(prompt, new RegExp('BOT_ID=' + bots[1].id)); assert.ok(prompt.includes('MAC_SSH=local@' + fixtureTailnet));
      assert.match(await js('document.getElementById("settings-copy-setup-prompt").nextElementSibling.textContent'), /journey_second_bot.*Hermes chat/);
      await disclose('#settings-agent-details'); await click('#settings-copy-setup-notes'); await idle('#settings-copy-setup-notes'); const notes = await clipboard.readText();
      assert.match(notes, /BOT_ID=74002/); assert.ok(notes.includes('MAC_SSH=local@' + fixtureTailnet)); assert.match(notes, /review notes.*not shell commands/); assert.doesNotMatch(notes, /curl|raw\.githubusercontent|--restart/);
      assert.match(await js('document.getElementById("settings-copy-setup-notes").nextElementSibling.textContent'), /Review notes copied.*Hermes chat/);
      await disclose('#settings-connector-details'); await click('[data-settings-section=browser-connector] button'); await idle('[data-settings-section=browser-connector] button'); const connector = JSON.parse(await clipboard.readText());
      assert.match(connector.url, /^http:\/\/127\.0\.0\.1:/); assert.equal(typeof connector.token, 'string'); assert.ok(connector.token.length > 10);
      let release; const gate = { match: name => name === 'agent-prompt', pending: new Promise(resolve => { release = resolve; }), release: () => release() }; gates.push(gate);
      const count = calls.filter(c => c.name === 'agent-prompt').length;
      await click('#settings-copy-setup-prompt'); await wait(() => gate.entered); await key('Enter'); await click('#settings-copy-setup-prompt');
      await call('open-bot', { id: bots[0].id }); await frame(); gate.release(); await idle('#settings-copy-setup-prompt');
      assert.match(await clipboard.readText(), /BOT_ID=74002/); assert.equal(calls.filter(c => c.name === 'agent-prompt').length - count, 1);
      assert.match(await js('document.getElementById("settings-copy-setup-prompt").nextElementSibling.textContent'), /journey_second_bot.*changed.*copy again/);
      await click('#settings-copy-setup-prompt'); await idle('#settings-copy-setup-prompt'); assert.match(await clipboard.readText(), /BOT_ID=74001/);
      observations.clipboard = { actual: true, reviewedBotIds: [bots[1].id, bots[0].id], heldRealCopyWrongBotSuppressed: true, repeatedCopyDispatchedOnce: true, setupPublicURLUnchanged: true, copiedLocalTokenNotRecorded: true, initialFormats: formats };
    } finally {
      await restoreClipboard(before);
      observations.clipboard = { ...observations.clipboard, restored: true, unavailable: before.unavailable };
    }
  });
  await check('metadata search reveals advanced controls while saved secret field values are never indexed', async () => {
    for (const [query, id] of [['copy setup command', 'settings-agent-details'], ['ssh address', 'settings-agent-details'], ['connection token', 'settings-connector-details'], ['remote connection', 'settings-remote-details'], ['run setup wizard', 'settings-agent-details'], ['open app data', 'settings-connector-details'], ['remote computer runs', 'settings-remote-details']]) {
      await search(query); assert.equal(await js(`document.getElementById(${JSON.stringify(id)})?.open`), true, query);
    }
    await fill('#remote-url', url + '?token=JourneySecretMarker'); await search('JourneySecretMarker'); assert.equal(await js('document.getElementById("settings-empty").hidden'), false);
    await search('remote connection'); assert.equal(await js('document.getElementById("remote-url").value'), url + '?token=JourneySecretMarker');
    await call('settings', { showBrowser: false }); await frame(); assert.equal(await js('document.activeElement.id'), 'settings-search'); assert.equal(await js('document.getElementById("remote-url").value'), url + '?token=JourneySecretMarker');
    await shot('search-manual-controls');
  });
  for (const size of [[1280, 800], [1120, 680], [1024, 640], [840, 560]]) await check(`${size.join('x')}: collapsed and expanded keyboard routes keep full focus rings within the pane`, async () => {
    win.setMinimumSize(0, 0); await resizeWindow(win, ...size); await frame(); await click('#settings-category-connections');
    const failures = [], stops = {};
    for (const expanded of [false, true]) {
      if (expanded) for (const id of ['settings-connector-details', 'settings-agent-details', 'settings-remote-details']) await disclose('#' + id);
      await click('#settings-category-connections'); let count = 0;
      do {
        await key('Tab'); count++;
        const box = await js(`(() => {const a=document.activeElement,p=document.getElementById('settings-content'),b=a.getBoundingClientRect(),r=p.getBoundingClientRect(),c=getComputedStyle(a),ring=a===p?0:(parseFloat(c.outlineWidth)||0)+Math.max(0,parseFloat(c.outlineOffset)||0);return {id:a.id||a.textContent,inPane:p.contains(a),complete:b.top-ring>=r.top-1&&b.bottom+ring<=r.bottom+1&&b.left-ring>=r.left-1&&b.right+ring<=r.right+1,inModal:document.getElementById('modal').contains(a)}})()`);
        assert.equal(box.inModal, true); if (box.inPane && !box.complete) failures.push(box);
        if (count > 60) throw Error('Keyboard route did not cycle to Close.');
      } while (await js('document.activeElement.id') !== 'modal-close');
      stops[expanded ? 'expanded' : 'collapsed'] = count;
      await key('Tab', true); await shot(`${size.join('x')}-${expanded ? 'expanded' : 'collapsed'}-last-focus`);
    }
    observations[size.join('x')] = { stops, failures, dimensions: await js('[innerWidth,innerHeight]') }; assert.deepEqual(failures, []);
  });
  observations.input = await js('journeyInputs'); assert.ok(observations.input.length && observations.input.every(e => e.trusted));
}).catch(error => { results.push({ name: 'fixture', pass: false, error: error.stack }); console.error(error); }).finally(async () => {
  for (const gate of gates) gate.release();
  const fail = results.filter(r => !r.pass).length;
  fs.writeFileSync(path.join(out, `${phase}-results.json`), JSON.stringify({ pass: results.length - fail, fail, results, observations, calls, safety, runtime: { pid: process.pid, profile: 'disposable', nativeInput: false, softwareCompositing: true, phase, sourceHashes } }, null, 2));
  app.once('will-quit', () => app.exit(fail ? 1 : 0)); quitFixture(server);
});
