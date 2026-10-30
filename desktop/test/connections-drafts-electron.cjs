const { ip: fixtureTailnet, otherIp: fixtureTailnetOther } = require('./tailnet-fixture.cjs');
process.env.HERMES_WORKSPACE_ALLOW_LOOPBACK = '1';
const { resizeWindow } = require('./window-fixture.cjs');
// Real Electron Settings + main persistence/copy; external work is blocked.
// Run with: node test/run-electron.cjs test/connections-round2-electron.cjs
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
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
const { prepareFixture, quitFixture } = require('./electron-fixture.cjs');
const profile = process.env.HERMES_TEST_PROFILE;
assert.ok(profile, 'Use run-electron.cjs for disposable storage.');
prepareFixture(profile);
app.getVersion = () => require('../package.json').version;
const phase = process.env.CONNECTIONS_PHASE || 'green';
const out = process.env.CONNECTIONS_OUT || path.resolve(__dirname, '../../evidence/quality/connections-round2');
fs.mkdirSync(out, { recursive: true });
const results = [], observations = {}, safety = [], calls = [], gates = [], seams = new Map();
const bots = [{ id: '74001', name: 'Journey researcher', username: 'journey_fixture_bot' }, { id: '74002', name: 'Second researcher', username: 'journey_second_bot' }];
const fixtureBots = bots;
fs.writeFileSync(path.join(profile, 'preferences.json'), JSON.stringify({ onboarded: true, bots: fixtureBots, selectedBotId: fixtureBots[0]?.id || '', hidden: [], preview: false, macSshHost: '', vpsBrowser: {}, remoteUrl: '' }));
// Never activate an OS window or access a real external process/service.
app.focus = () => { safety.push({ prevented: 'app.focus' }); };
app.on('web-contents-created', (_event, contents) => { contents.focus = () => { safety.push({ prevented: 'contents.focus' }); }; });
const Module = require('node:module'), load = Module._load;
const facade = { ...electron, BrowserWindow: new Proxy(BrowserWindow, { construct(C, args) {
  const win = new C({ ...args[0], show: false, focusable: false });
  win.focus = () => { safety.push({ prevented: 'window.focus' }); };
  win.show = () => win.showInactive();
  setImmediate(() => { if (!win.isDestroyed()) win.showInactive(); });
  return win;
} }) };
Module._load = function(request, ...args) { return request === 'electron' ? facade : load.call(this, request, ...args); };
const cp = require('node:child_process');
for (const method of ['spawn', 'fork', 'exec', 'execFile', 'execFileSync', 'spawnSync', 'execSync']) cp[method] = (...args) => { safety.push({ blockedProcess: method, command: String(args[0]) }); throw Error('Connections fixture forbids external processes.'); };
for (const method of ['openExternal', 'openPath', 'showItemInFolder', 'trashItem']) electron.shell[method] = () => { throw Error('Fixture forbids shell.' + method); };
for (const method of ['askForMediaAccess', 'isTrustedAccessibilityClient', 'getMediaAccessStatus']) electron.systemPreferences[method] = () => { throw Error('Fixture forbids native permission API.'); };
const https = require('node:https');
https.request = https.get = () => { throw Error('Fixture forbids external HTTPS.'); };
electron.net.request = electron.net.fetch = () => { throw Error('Fixture forbids Electron network.'); };
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
  if (!['settings', 'settings-write-status', 'open-bot', 'agent-prompt', 'remote-status', 'remote-control'].includes(name)) throw Error('Unapproved fixture command: ' + name);
  const result = await handler(event, name, value);
  const gate = gates.find(g => !g.entered && g.match(name, value));
  if (gate) { gate.entered = true; await gate.pending; if (gate.error) throw Error(gate.error); }
  if (name === 'settings-write-status') call.resultStatus = result?.settingsWrite?.status;
  call.replied = Date.now(); return result;
});
const target = process.env.CONNECTIONS_TARGET || path.resolve(__dirname, '..');
const sourceHashes = Object.fromEntries(['src/main.cjs', 'src/renderer.js', 'src/style.css', 'src/preload.bundle.cjs', 'package.json', 'package-lock.json'].map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(target, file))).digest('hex')]));
require(path.join(target, 'src/main.cjs'));
const pause = (ms = 25) => new Promise(resolve => setTimeout(resolve, ms));
async function wait(read, predicate = Boolean) { for (let i = 0; i < 200; i++) { const value = await read(); if (predicate(value)) return value; await pause(); } throw Error('Timed out waiting for Connections UI.'); }
let win, wc, server;
const holdSave = key => { let release; const gate = { match: (name, value) => name === 'settings' && key in value, pending: new Promise(resolve => { release = resolve; }), release: error => { gate.error = error; release(); } }; gates.push(gate); return gate; };
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
  const shot = async name => { await frame(); fs.writeFileSync(path.join(out, `${phase}-${name}-capturePage.png`), (await wc.capturePage()).toPNG()); const capture = await wc.debugger.sendCommand('Page.captureScreenshot', { format: 'png', fromSurface: true }); fs.writeFileSync(path.join(out, `${phase}-${name}.png`), Buffer.from(capture.data, 'base64')); };
  const open = async () => { await call('settings', {showBots:true}); if (await js('!!settingsSession')) await click('#modal-close'); await click(await js('document.getElementById("settings-button").getBoundingClientRect().width?"#settings-button":"#settings-fallback"')); await click('#settings-category-connections'); };
  const disclose = async id => { if (await js(`!!document.querySelector(${JSON.stringify(id)})&&!document.querySelector(${JSON.stringify(id)}).open`)) await click(`${id} > summary`); };
  const idle = selector => wait(() => js(`!document.querySelector(${JSON.stringify(selector)}).hasAttribute('aria-busy')`));
  const addressWrites = () => calls.filter(c => c.name === 'settings' && c.value?._settingsWrite?.slot === 'addresses').length;
  const savedStateChecks = () => calls.filter(c => c.name === 'settings-write-status');
  const addressRecovery = async expected => {
    await wait(() => js('!!document.getElementById("mac-ssh-host-check-save") && !document.getElementById("mac-ssh-host-check-save").hidden'));
    const before = savedStateChecks().length;
    await click('#mac-ssh-host-check-save'); await idle('#settings-save-addresses');
    assert.equal(savedStateChecks().length, before + 1);
    assert.equal(savedStateChecks().at(-1).resultStatus, expected);
  };
  const saveRemote = () => click('[data-settings-section=remote-desktop] .primary-button');
  const check = async (name, fn) => { if (process.env.CONNECTIONS_CASE && !name.includes(process.env.CONNECTIONS_CASE)) return; try { await call('settings', { macSshHost: `local${results.length}@${fixtureTailnet}`, vpsBrowser: { enabled: false, sshHost: `agent${results.length}@${fixtureTailnet}` }, remoteUrl: '', preview: false }); await call('open-bot', { id: bots[0].id }); await open(); await fn(); results.push({ name, pass: true }); console.log('PASS:', name); } catch (error) { results.push({ name, pass: false, error: error.stack }); console.error('FAIL:', name, error.message); await shot('failure-' + results.length); } finally { for (const gate of gates) gate.release(); gates.length = 0; seams.clear(); await frame(); } };
  server = http.createServer((_req, res) => res.end('<!doctype html><title>Inert loopback viewer fixture</title>'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const url = `http://127.0.0.1:${server.address().port}/vnc.html`;
  await resizeWindow(win, 1280, 800); await frame();
  await js('window.journeyInputs=[];for(const type of ["keydown","pointerdown","input"])document.addEventListener(type,e=>journeyInputs.push({type,key:e.key,trusted:e.isTrusted,id:e.target.id}),true);true');
  await check('close and reopen retains an unsaved address without auto-saving', async () => {
    await disclose('#settings-agent-details');
    const before = disk().macSshHost;
    await fill('#mac-ssh-host', `unsaved@${fixtureTailnet}`);
    await click('#modal-close'); await open(); await disclose('#settings-agent-details');
    assert.equal(await js('document.getElementById("mac-ssh-host").value'), `unsaved@${fixtureTailnet}`);
    assert.equal(await js('document.getElementById("mac-ssh-host").dataset.dirty'), 'true');
    assert.equal(disk().macSshHost, before);
    await click('#mac-ssh-host'); await shot('retained-draft');
  });

  await check('category and metadata search retain private drafts; explicit discard survives reopen', async () => {
    await disclose('#settings-agent-details'); const saved = disk().macSshHost;
    await fill('#mac-ssh-host', `private-round2@${fixtureTailnet}`);
    await click('#settings-category-general'); await search('ssh address');
    assert.equal(await js('document.getElementById("mac-ssh-host").value'), `private-round2@${fixtureTailnet}`);
    await search('private-round2'); assert.equal(await js('document.getElementById("settings-empty").hidden'), false);
    await search('ssh address'); await click('#settings-discard-addresses');
    assert.equal(await js('document.getElementById("mac-ssh-host").value'), saved);
    assert.match(await js('document.querySelector("#settings-save-addresses + p").textContent'), /discarded.*unchanged/);
    await open(); await disclose('#settings-agent-details');
    assert.equal(await js('document.getElementById("mac-ssh-host").value'), saved);
    assert.notEqual(await js('document.getElementById("mac-ssh-host").dataset.dirty'), 'true');
  });
  await check('close/reopen during actual Save blocks repeats, retains later per-field revisions and permits one explicit later save', async () => {
    await disclose('#settings-agent-details'); await fill('#mac-ssh-host', `submitted@${fixtureTailnet}`); await fill('#vps-ssh-host', `agent-submitted@${fixtureTailnet}`);
    const gate = holdSave('macSshHost'); await click('#settings-save-addresses'); await wait(() => gate.entered);
    await fill('#mac-ssh-host', `later@${fixtureTailnet}`);
    // Same value, new input revision must remain dirty as in the inherited guard.
    await fill('#vps-ssh-host', `agent-submitted@${fixtureTailnet}`);
    await click('#modal-close'); await open(); await disclose('#settings-agent-details');
    assert.equal(await js('document.getElementById("mac-ssh-host").value'), `later@${fixtureTailnet}`);
    assert.equal(await js('document.getElementById("settings-save-addresses").getAttribute("aria-busy")'), 'true');
    const before = calls.filter(c => c.name === 'settings' && 'macSshHost' in c.value).length;
    await click('#settings-save-addresses'); await key('Enter'); await click('#settings-discard-addresses');
    assert.equal(calls.filter(c => c.name === 'settings' && 'macSshHost' in c.value).length, before);
    gate.release(); await idle('#settings-save-addresses');
    assert.equal(disk().macSshHost, `submitted@${fixtureTailnet}`);
    for (const id of ['mac-ssh-host', 'vps-ssh-host']) assert.equal(await js(`document.getElementById(${JSON.stringify(id)}).dataset.dirty`), 'true');
    assert.match(await js('document.querySelector("#settings-save-addresses + p").textContent'), /Newer edits are not saved/);
    await shot('pending-reopen-later-edits');
    await click('#settings-save-addresses'); await idle('#settings-save-addresses');
    assert.equal(disk().macSshHost, `later@${fixtureTailnet}`);
    assert.equal(calls.filter(c => c.name === 'settings' && 'macSshHost' in c.value).length, before + 1);
    await open(); await disclose('#settings-agent-details');
    assert.notEqual(await js('document.getElementById("mac-ssh-host").dataset.dirty'), 'true');
    assert.match(await js('document.querySelector("#settings-save-addresses + p").textContent'), /Addresses saved/);
  });
  await check('save completes while closed; submitted fields become saved without clearing a later edit', async () => {
    await disclose('#settings-agent-details'); await fill('#mac-ssh-host', `closed-save@${fixtureTailnet}`);
    const gate = holdSave('macSshHost'); await click('#settings-save-addresses'); await wait(() => gate.entered);
    await fill('#vps-ssh-host', `closed-later@${fixtureTailnet}`); await click('#modal-close');
    gate.release(); await pause(100); await open(); await disclose('#settings-agent-details');
    assert.equal(await js('document.getElementById("mac-ssh-host").value'), `closed-save@${fixtureTailnet}`);
    assert.notEqual(await js('document.getElementById("mac-ssh-host").dataset.dirty'), 'true');
    assert.equal(await js('document.getElementById("vps-ssh-host").value'), `closed-later@${fixtureTailnet}`);
    assert.equal(await js('document.getElementById("vps-ssh-host").dataset.dirty'), 'true');
  });
  await check('rejected delivery preserves the reopened draft and checks saved truth before the next explicit save', async () => {
    await disclose('#settings-agent-details'); await fill('#mac-ssh-host', `persisted-rejected@${fixtureTailnet}`);
    const gate = holdSave('macSshHost'); await click('#settings-save-addresses'); await wait(() => gate.entered);
    await fill('#mac-ssh-host', `after-rejection@${fixtureTailnet}`); await open(); await disclose('#settings-agent-details');
    gate.release('Fixture: IPC reply rejected after actual persistence.');
    await wait(() => js('!document.getElementById("mac-ssh-host-check-save").hidden'));
    assert.equal(disk().macSshHost, `persisted-rejected@${fixtureTailnet}`);
    assert.equal(await js('document.getElementById("mac-ssh-host").value'), `after-rejection@${fixtureTailnet}`);
    assert.match(await js('document.querySelector("#settings-save-addresses + p").textContent'), /could not be confirmed.*later edits are kept/);
    const writes = addressWrites();
    await click('#settings-save-addresses'); await click('#settings-discard-addresses');
    assert.equal(addressWrites(), writes);
    assert.equal(await js('document.getElementById("mac-ssh-host").value'), `after-rejection@${fixtureTailnet}`);
    await addressRecovery('saved');
    assert.equal(addressWrites(), writes);
    assert.equal(disk().macSshHost, `persisted-rejected@${fixtureTailnet}`);
    assert.equal(await js('document.getElementById("mac-ssh-host").value'), `after-rejection@${fixtureTailnet}`);
    assert.equal(await js('document.getElementById("mac-ssh-host").dataset.dirty'), 'true');
    await shot('rejected-save-recovery'); await click('#settings-save-addresses'); await idle('#settings-save-addresses');
    assert.equal(disk().macSshHost, `after-rejection@${fixtureTailnet}`);
    assert.equal(addressWrites(), writes + 1);
  });
  await check('pre-write rejection and malformed input retain drafts without writing saved addresses', async () => {
    await disclose('#settings-agent-details'); const before = disk().macSshHost;
    await fill('#mac-ssh-host', 'invalid host'); await click('#settings-save-addresses'); await idle('#settings-save-addresses');
    assert.equal(disk().macSshHost, before); await open(); await disclose('#settings-agent-details');
    assert.equal(await js('document.getElementById("mac-ssh-host").value'), 'invalid host');
    await fill('#mac-ssh-host', `unwritten@${fixtureTailnet}`);
    let release, entered = false;
    seams.set('settings', () => { entered = true; return new Promise((_resolve, reject) => { release = () => reject(Error('Fixture: not delivered to main.')); }); });
    await click('#settings-save-addresses'); await wait(() => entered); await click('#modal-close');
    release(); seams.delete('settings'); await pause(50); await open(); await disclose('#settings-agent-details');
    assert.equal(await js('document.getElementById("mac-ssh-host").value'), `unwritten@${fixtureTailnet}`);
    assert.equal(disk().macSshHost, before);
    await wait(() => js('!document.getElementById("mac-ssh-host-check-save").hidden'));
    const writes = addressWrites();
    await click('#settings-discard-addresses');
    assert.equal(await js('document.getElementById("mac-ssh-host").value'), `unwritten@${fixtureTailnet}`);
    assert.equal(addressWrites(), writes);
    await addressRecovery('not-applied');
    assert.equal(addressWrites(), writes);
    assert.equal(disk().macSshHost, before);
    assert.match(await js('document.querySelector("#settings-save-addresses + p").textContent'), /save was not applied/);
    await click('#settings-discard-addresses'); assert.equal(await js('document.getElementById("mac-ssh-host").value'), before);
  });
  const selectReviewed = async id => { await js(`document.getElementById('settings-setup-bot').value=${JSON.stringify(id)};document.getElementById('settings-setup-bot').dispatchEvent(new Event('change',{bubbles:true}));true`); await frame(); };
  await check('scripted bot selection and saved-host changes isolate drafts and restore only their original context', async () => {
    await disclose('#settings-agent-details'); const original = disk();
    await fill('#mac-ssh-host', `bot-one-only@${fixtureTailnet}`); await selectReviewed(bots[1].id);
    assert.equal(await js('document.getElementById("mac-ssh-host").value'), original.macSshHost);
    await fill('#mac-ssh-host', `bot-two-only@${fixtureTailnet}`); await selectReviewed(bots[0].id);
    assert.equal(await js('document.getElementById("mac-ssh-host").value'), `bot-one-only@${fixtureTailnet}`);
    await call('settings', { macSshHost: `external-local@${fixtureTailnet}`, vpsBrowser: { enabled: false, sshHost: `external-agent@${fixtureTailnet}` } }); await frame();
    assert.equal(await js('document.getElementById("mac-ssh-host").value'), `external-local@${fixtureTailnet}`);
    await call('settings', { macSshHost: original.macSshHost, vpsBrowser: original.vpsBrowser }); await frame();
    assert.equal(await js('document.getElementById("mac-ssh-host").value'), `bot-one-only@${fixtureTailnet}`);
    await call('open-bot', { id: bots[1].id }); await frame();
    assert.equal(await js('document.getElementById("mac-ssh-host").value'), `bot-two-only@${fixtureTailnet}`);
    await open(); await disclose('#settings-agent-details');
    assert.equal(await js('document.getElementById("mac-ssh-host").value'), `bot-two-only@${fixtureTailnet}`);
  });
  await check('late older Save cannot overwrite newer UI state or place its draft into another saved host context', async () => {
    await disclose('#settings-agent-details'); await fill('#mac-ssh-host', `old-save@${fixtureTailnet}`);
    const gate = holdSave('macSshHost'); await click('#settings-save-addresses'); await wait(() => gate.entered);
    await fill('#mac-ssh-host', `old-context-draft@${fixtureTailnet}`);
    await call('settings', { macSshHost: `new-context@${fixtureTailnet}`, preview: true }); await frame();
    const revision = await js('state.uiStateRevision'); await open(); await disclose('#settings-agent-details');
    assert.equal(await js('document.getElementById("mac-ssh-host").value'), `new-context@${fixtureTailnet}`);
    gate.release(); await pause(100); await frame();
    assert.equal(await js('state.macSshHost'), `new-context@${fixtureTailnet}`); assert.equal(await js('state.preview'), true);
    assert.ok(await js('state.uiStateRevision') >= revision);
    assert.equal(await js('document.getElementById("mac-ssh-host").value'), `new-context@${fixtureTailnet}`);
    await call('settings', { macSshHost: `old-save@${fixtureTailnet}`, preview: false }); await frame();
    assert.equal(await js('document.getElementById("mac-ssh-host").value'), `old-context-draft@${fixtureTailnet}`);
    assert.equal(await js('document.getElementById("mac-ssh-host").dataset.dirty'), 'true');
  });
  await check('viewer draft and pending save survive reopen, later edits, explicit save and discard', async () => {
    await disclose('#settings-remote-details'); await fill('#remote-url', url + '?first');
    const gate = holdSave('remoteUrl'); await saveRemote(); await wait(() => gate.entered);
    await fill('#remote-url', url + '?later'); await open(); await disclose('#settings-remote-details');
    assert.equal(await js('document.getElementById("remote-url").value'), url + '?later');
    gate.release(); await idle('[data-settings-section=remote-desktop] .primary-button');
    assert.equal(disk().remoteUrl, url + '?first'); await saveRemote(); await idle('[data-settings-section=remote-desktop] .primary-button');
    assert.equal(disk().remoteUrl, url + '?later'); await fill('#remote-url', 'bad URL'); await open(); await disclose('#settings-remote-details');
    await click('#settings-discard-viewer'); assert.equal(await js('document.getElementById("remote-url").value'), url + '?later');
  });
  await check('actual copied prompt and visible request, expected reply and continuation agree; clipboard restored', async () => {
    const saved = await captureClipboard();
    try {
      const custom = 'web application/x-alans-way-fixture';
      for (const initial of ['current', 'empty', 'custom', 'native-url']) {
        if (initial === 'empty') {
          clipboard.clear();
          // Electron includes the separate macOS find pasteboard in read().
          if (process.platform === 'darwin') await clipboard.write([new electron.ClipboardItem({ 'electron application/findtext': '' })]);
        }
        if (initial === 'custom') await clipboard.write([new electron.ClipboardItem({
          'text/plain': 'Connections clipboard fixture', 'text/html': '<b>Connections clipboard fixture</b>', [custom]: new Blob([Buffer.from([0, 1, 254, 255])]),
        })]);
        if (initial === 'native-url') await clipboard.write([new electron.ClipboardItem({
          'text/plain': `https://${fixtureTailnet}/fixture.invalid/`,
          'electron application/osclipboard;format="public.url"': new Blob(['https://fixture.invalid/']),
          'electron application/osclipboard;format="public.url-name"': new Blob(['Fixture bookmark']),
        })]);
        const before = await captureClipboard();
        if (initial === 'empty') assert.equal(before.items.length, 0, 'empty clipboard has no restorable formats');
        if (initial === 'native-url' && process.platform === 'darwin') assert.ok(before.derived.some(entry => entry.type === 'electron application/bookmark'), 'native URL exposes a bookmark to verify after raw-format restoration');
        if (initial === 'custom') assert.ok(before.items.some(item => item.types.includes(custom)), 'custom clipboard bytes are captured');
        await open();
        try {
          const text = await js('document.querySelector("[data-settings-section=agent-setup]").innerText');
          assert.match(text, /follow openalan.com\/agent-prompt/); assert.match(text, /set up the Alan’s Way Plugin, preserving Hermes/);
          assert.match(text, /Expect approval steps/); assert.match(text, /report.*checks.*warnings.*unfinished/);
          await click('#settings-copy-setup-prompt'); await idle('#settings-copy-setup-prompt');
          const actual = await clipboard.readText();
          assert.match(actual, /Before any setup, load the installed workspace-setup skill/);
          assert.match(actual, /skill_view\(name="alans-way:workspace-setup"\)/);
          assert.match(actual, /Never.*\n.*execute branch\/main URLs or unpinned checkouts/);
          assert.match(actual, /BOT_ID=74001/); assert.ok(actual.includes('MAC_SSH=' + disk().macSshHost));
          observations.setupPrompt = actual; await shot('prompt-guidance');
          await click('#settings-enter-addresses');
          assert.equal(await js('document.getElementById("settings-agent-details").open'), true);
          assert.equal(await js('document.activeElement.id'), 'mac-ssh-host');
        } finally {
          const formats = await restoreClipboard(before);
          observations.clipboard = { restored: true, formats, unavailable: before.unavailable, initial };
        }
        console.log('PASS: actual copy and clipboard restoration with', initial, 'clipboard');
      }
    } finally {
      await restoreClipboard(saved);
    }
  });
  await check('continuation keeps keyboard focus across an unrelated real state refresh', async () => {
    await click('#settings-category-connections');
    for (let n = 0; n < 15; n++) {
      await key('Tab');
      if (await js('document.activeElement.id') === 'settings-enter-addresses') break;
    }
    assert.equal(await js('document.activeElement.id'), 'settings-enter-addresses');
    await call('settings', { showBots: false }); await frame();
    assert.equal(await js('document.activeElement.id'), 'settings-enter-addresses');
    await key('Enter'); assert.equal(await js('document.activeElement.id'), 'mac-ssh-host');
  });
  await check('late IPC-only path reply after reopen cannot verify a newer draft', async () => {
    let release, entered = false; seams.set('test-agent-path', () => { entered = true; return new Promise(resolve => { release = resolve; }); });
    await click('#settings-test-path'); await wait(() => entered); await open(); await disclose('#settings-agent-details');
    await fill('#mac-ssh-host', `not-checked@${fixtureTailnet}`); release({ ok: true, detail: 'OLD_PATH_RESULT' }); await frame(); await pause(50);
    assert.doesNotMatch(await js('document.getElementById("settings-content").innerText'), /OLD_PATH_RESULT|SSH path checked/);
    assert.equal(await js('document.getElementById("mac-ssh-host").value'), `not-checked@${fixtureTailnet}`);
  });
  for (const size of [[1280, 800], [1120, 800], [1024, 800], [840, 800]]) await check(`${size.join('x')}: trusted forward/reverse keyboard routes keep focus visible and drafts recoverable`, async () => {
    win.setMinimumSize(0, 0); await resizeWindow(win, ...size); await frame();
    await click('#settings-enter-addresses'); await fill('#mac-ssh-host', `keyboard@${fixtureTailnet}`);
    await disclose('#settings-connector-details'); await disclose('#settings-remote-details');
    await click('#settings-category-connections'); const samples = [];
    for (const reverse of [false, true]) for (let n = 0; n < 30; n++) {
      await key('Tab', reverse);
      const sample = await js(`(() => {const a=document.activeElement,p=document.getElementById('settings-content'),r=p.getBoundingClientRect(),b=a.getBoundingClientRect(),c=getComputedStyle(a),ring=a===p?0:(parseFloat(c.outlineWidth)||0)+Math.max(0,parseFloat(c.outlineOffset)||0);return {id:a.id||a.textContent,inModal:document.getElementById('modal').contains(a),inPane:p.contains(a),visible:b.top-ring>=r.top-1&&b.bottom+ring<=r.bottom+1&&b.left-ring>=r.left-1&&b.right+ring<=r.right+1}})()`);
      samples.push(sample); assert.equal(sample.inModal, true); if (sample.inPane) assert.equal(sample.visible, true, sample.id);
    }
    observations[size.join('x')] = samples;
    await click('#settings-discard-addresses'); if (size[0] === 1280 || size[0] === 840) await shot(`${size.join('x')}-expanded`);
    await click('#modal-close'); await open(); if (size[0] === 1280 || size[0] === 840) await shot(`${size.join('x')}-initial`);
  });
  observations.input = await js('journeyInputs'); assert.ok(observations.input.length && observations.input.every(e => e.trusted));
  observations.runtimeURL = wc.getURL();
  observations.preload = wc.getLastWebPreferences().preload;
  observations.productModules = Object.keys(require.cache).filter(file => /\/desktop\/(src|scripts)\//.test(file));
  assert.ok(observations.productModules.length > 10);
  assert.ok(observations.productModules.every(file => file.startsWith(target + path.sep)), 'Product modules must resolve inside the frozen target');
}).catch(error => { results.push({ name: 'fixture', pass: false, error: error.stack }); console.error(error); }).finally(async () => {
  for (const gate of gates) gate.release();
  const fail = results.filter(r => !r.pass).length;
  fs.writeFileSync(path.join(out, `${phase}-results.json`), JSON.stringify({ pass: results.length - fail, fail, results, observations, calls, safety, runtime: { pid: process.pid, profile: 'disposable', nativeInput: false, softwareCompositing: true, phase, sourceHashes } }, null, 2));
  app.once('will-quit', () => app.exit(fail ? 1 : 0)); quitFixture(server);
});
