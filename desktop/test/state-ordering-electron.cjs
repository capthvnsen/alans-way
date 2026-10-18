// Real main/renderer, disposable persistence, trusted Chromium input. Gates hold
// actual IPC handlers/replies/broadcasts; they never manufacture state snapshots.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, session } = require('electron');
const { prepareFixture, quitFixture } = require('./electron-fixture.cjs');
const profile = process.env.HERMES_TEST_PROFILE;
assert.ok(profile, 'Use test/run-electron.cjs for disposable storage.');
prepareFixture(profile);
fs.writeFileSync(path.join(profile, 'preferences.json'), JSON.stringify({
  onboarded: true, preview: false, bots: [{ id: '73000', name: 'Disposable ordering researcher', username: 'ordering_fixture_bot' }],
  selectedBotId: '73000', hidden: [], remoteUrl: '', macSshHost: '', autoOpenLinks: false, autoTakeover: false,
}));
app.whenReady().then(() => {
  for (const s of [session.defaultSession, session.fromPartition('persist:browser')]) {
    s.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, done) => done({ cancel: !/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(details.url) }));
  }
});
const calls = [], gates = new Map(), activeGates = new Set(), broadcasts = [];
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => handle(channel, async (event, name, value) => {
  if (channel !== 'workspace:command' && channel !== 'workspace:get') return handler(event, name, value);
  const record = { id: calls.length + 1, channel, name, value, started: Date.now() };
  calls.push(record);
  const gate = gates.get(channel === 'workspace:get' ? 'get' : name === 'settings' ? Object.keys(value)[0] : name);
  if (gate) gates.delete(gate.key);
  try {
    if (gate?.stage === 'before') await gate.wait(record);
    record.handlerStarted = Date.now();
    const result = await handler(event, name, value);
    record.handlerEnded = Date.now();
    if (result?.api && result?.bots) record.snapshot = { uiStateRevision: result.uiStateRevision, autoOpenLinks: result.autoOpenLinks, autoTakeover: result.autoTakeover };
    if (gate?.stage === 'after') await gate.wait(record);
    record.replied = Date.now();
    return result;
  } catch (error) { record.error = error.message; record.replied = Date.now(); throw error; }
});
require('../src/main.cjs');
const out = process.env.STATE_ORDERING_EVIDENCE_DIR ? path.resolve(process.env.STATE_ORDERING_EVIDENCE_DIR) : path.resolve(__dirname, '../../evidence/quality/state-ordering');
fs.mkdirSync(out, { recursive: true });
const phase = process.env.STATE_ORDERING_PHASE || 'green';
const results = [], observations = {};
const pause = (ms = 25) => new Promise(resolve => setTimeout(resolve, ms));
async function wait(read, predicate = Boolean) {
  for (let n = 0; n < 160; n++) { const value = await read(); if (predicate(value)) return value; await pause(); }
  throw Error('Timed out waiting for authoritative UI state.');
}
function hold(key, stage = 'after') {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const gate = { key, entered: false, stage, release, wait: async record => {
    gate.entered = true; record.heldAt = Date.now();
    const error = await pending; record.releasedAt = Date.now();
    if (error) throw Error(error);
  } };
  gates.set(key, gate); activeGates.add(gate); return gate;
}
app.whenReady().then(async () => {
  const win = await wait(() => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html')));
  const wc = win.webContents, js = code => wc.executeJavaScript(code);
  await wait(() => js('!!document.querySelector(".bot-open")').catch(() => false));
  const send = wc.send.bind(wc);
  let holdBroadcast, heldBroadcast;
  wc.send = (channel, ...args) => {
    if (channel === 'workspace:state') {
      const s = args[0]; broadcasts.push({ at: Date.now(), uiStateRevision: s.uiStateRevision, autoOpenLinks: s.autoOpenLinks, autoTakeover: s.autoTakeover });
      if (holdBroadcast?.(s)) { holdBroadcast = null; heldBroadcast = () => send(channel, ...args); return; }
    }
    return send(channel, ...args);
  };
  wc.debugger.attach('1.3');
  await wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
  const frame = () => js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  const key = async (key, extra = {}) => {
    const vk = { Tab: 9, Enter: 13, Escape: 27, Backspace: 8, a: 65, ' ': 32 }[key];
    const params = { key, code: key === ' ' ? 'Space' : key === 'a' ? 'KeyA' : key, windowsVirtualKeyCode: vk, ...extra };
    await wc.debugger.sendCommand('Input.dispatchKeyEvent', { ...params, type: 'keyDown', ...(key === 'Enter' ? { text: '\r' } : key === ' ' ? { text: ' ' } : {}) });
    await wc.debugger.sendCommand('Input.dispatchKeyEvent', { ...params, type: 'keyUp' });
    await pause(); await frame();
  };
  const click = async selector => {
    const point = await js(`(() => {const e=document.querySelector(${JSON.stringify(selector)}),r=e?.getBoundingClientRect();if(!r?.width||!r.height||r.y<0||r.bottom>innerHeight)throw Error('Invisible target: '+${JSON.stringify(selector)});return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
    await pause(); await frame();
  };
  const active = () => js('document.activeElement.id');
  const reach = async selector => {
    const disclosure = await js(`document.querySelector(${JSON.stringify(selector)})?.closest('details:not([open])')?.id || ''`);
    if (disclosure) await click('#' + disclosure + ' > summary');
    await click('#settings-search');
    for (let n = 0; n < 120; n++) { await key('Tab'); if (await js(`document.activeElement===document.querySelector(${JSON.stringify(selector)})`)) return; }
    throw Error('Unreachable target: ' + selector);
  };
  const open = () => click('#settings-button');
  const reset = async () => { if (await js('!document.getElementById("modal").classList.contains("hidden")')) await click('#modal-close'); await open(); };
  const search = async text => {
    await click('#settings-search'); await key('a', { modifiers: 4, commands: ['selectAll'] }); await key('Backspace');
    if (text) await wc.debugger.sendCommand('Input.insertText', { text }); await frame();
  };
  const shot = async name => fs.writeFileSync(path.join(out, `${phase}-${name}.png`), (await wc.capturePage()).toPNG());
  const prefs = () => JSON.parse(fs.readFileSync(path.join(profile, 'preferences.json')));
  const pick = s => ({ autoOpenLinks: s.autoOpenLinks, autoTakeover: s.autoTakeover });
  const api = () => js('workspace.getState()');
  const ui = () => js('({autoOpenLinks:document.getElementById("settings-auto-links").getAttribute("aria-checked")==="true",autoTakeover:document.getElementById("settings-auto-takeover").getAttribute("aria-checked")==="true"})');
  const matchesAuthority = async () => {
    const actual = await api(), disk = prefs(), displayed = await ui();
    assert.deepEqual(displayed, pick(actual), 'Displayed switches must match the real current API');
    assert.deepEqual(displayed, pick(disk), 'Displayed switches must match actual persisted preferences');
    return { api: pick(actual), disk: pick(disk), ui: displayed, uiStateRevision: actual.uiStateRevision };
  };
  const settingsCalls = () => calls.filter(c => c.name === 'settings');
  const idle = selector => wait(() => js(`!document.querySelector(${JSON.stringify(selector)}).hasAttribute('aria-busy')`));
  const check = async (name, test) => {
    if (process.env.STATE_ORDERING_CASE && !name.includes(process.env.STATE_ORDERING_CASE)) return;
    try { await reset(); await test(); results.push({ name, pass: true }); console.log('PASS:', name); }
    catch (error) { results.push({ name, pass: false, error: error.stack }); console.error('FAIL:', name, error.message); await shot('failure-' + results.length); }
    finally { for (const gate of activeGates) gate.release(); activeGates.clear(); gates.clear(); heldBroadcast?.(); heldBroadcast = null; holdBroadcast = null; }
  };
  win.setContentSize(1120, 680); await frame();
  await js('window.orderingInputs=[];for(const type of ["keydown","keyup","pointerdown","click"])document.addEventListener(type,e=>orderingInputs.push({type,key:e.key,trusted:e.isTrusted,id:e.target.id}),true);true');
  for (const reopen of [false, true]) await check(`${reopen ? 'reopened' : 'same'} Settings: older real save reply cannot undo newer real save`, async () => {
    const before = settingsCalls().length, old = hold('autoOpenLinks');
    await reach('#settings-auto-links'); await key('Enter'); await wait(() => old.entered);
    await key('Enter'); await key(' ', { autoRepeat: true }); await click('#settings-auto-links');
    assert.equal(settingsCalls().length - before, 1, 'Pending action dispatches once even after real broadcast');
    if (reopen) { await click('#modal-close'); await open(); }
    await reach('#settings-auto-takeover'); await key('Enter'); await idle('#settings-auto-takeover');
    const newer = await matchesAuthority();
    await click('#settings-search'); const moved = await active(); old.release();
    await wait(() => settingsCalls().filter(c => c.replied).length === settingsCalls().length); await frame();
    const after = { api: pick(await api()), disk: pick(prefs()), ui: await ui(), focus: await active() };
    observations[reopen ? 'reopened' : 'same'] = { newer, after, dispatches: settingsCalls().slice(before) };
    await shot(reopen ? 'reopened-after-old' : 'same-after-old');
    assert.equal(after.focus, moved); assert.equal(settingsCalls().length - before, 2);
    await matchesAuthority();
  });
  if (phase === 'red') {
    observations.input = await js('orderingInputs');
    observations.nativeAttempts = 0;
    return;
  }
  await check('newer real broadcast protects UI while both save replies remain held', async () => {
    const old = hold('autoOpenLinks'), newer = hold('autoTakeover');
    await reach('#settings-auto-links'); await key('Enter'); await wait(() => old.entered);
    await reach('#settings-auto-takeover'); await key('Enter'); await wait(() => newer.entered);
    const confirmed = await matchesAuthority();
    await click('#settings-search'); old.release(); await idle('#settings-auto-links');
    observations.broadcastBeforeReply = { confirmed, afterOld: await matchesAuthority() };
    assert.equal(await active(), 'settings-search'); newer.release(); await idle('#settings-auto-takeover');
    await matchesAuthority();
  });
  await check('a real save delayed before persistence still applies its legitimate later completion', async () => {
    const before = settingsCalls().length, old = hold('autoOpenLinks', 'before');
    const original = pick(await api());
    await reach('#settings-auto-links'); await key('Enter'); await wait(() => old.entered);
    await reach('#settings-auto-takeover'); await key('Enter'); await idle('#settings-auto-takeover');
    assert.equal(prefs().autoOpenLinks, original.autoOpenLinks);
    await click('#settings-search'); old.release(); await idle('#settings-auto-links');
    observations.laterPersistence = { final: await matchesAuthority(), dispatches: settingsCalls().slice(before) };
    assert.equal(prefs().autoOpenLinks, !original.autoOpenLinks); assert.equal(prefs().autoTakeover, !original.autoTakeover);
    assert.equal(settingsCalls().length - before, 2); assert.equal(await active(), 'settings-search');
  });
  await check('older actual broadcast cannot undo a newer reply or broadcast', async () => {
    const original = pick(await api()); await reach('#settings-auto-links');
    holdBroadcast = s => s.autoOpenLinks !== original.autoOpenLinks;
    await key('Enter'); await idle('#settings-auto-links');
    assert.ok(heldBroadcast, 'A real main broadcast was captured');
    await reach('#settings-auto-takeover'); await key('Enter'); await idle('#settings-auto-takeover');
    await click('#settings-search'); heldBroadcast(); heldBroadcast = null; await pause(80); await frame();
    observations.oldBroadcast = await matchesAuthority(); assert.equal(await active(), 'settings-search');
  });
  await check('older actual getState reply cannot undo a newer authoritative broadcast', async () => {
    const old = hold('get');
    const read = js('workspace.getState().then(render)'); await wait(() => old.entered);
    await reach('#settings-auto-takeover'); await key('Enter'); await idle('#settings-auto-takeover');
    old.release(); await read; await frame();
    observations.oldGet = await matchesAuthority();
  });
  for (const afterPersistence of [false, true]) await check(`held ${afterPersistence ? 'post-persistence delivery' : 'pre-persistence'} failure preserves newer truth and permits real retry`, async () => {
    const before = settingsCalls().length, original = pick(await api());
    const old = hold('autoOpenLinks', afterPersistence ? 'after' : 'before');
    await reach('#settings-auto-links'); await key('Enter'); await wait(() => old.entered);
    await reach('#settings-auto-takeover'); await key('Enter'); await idle('#settings-auto-takeover');
    old.release('Ordering fixture held delivery failed. Retry.'); await idle('#settings-auto-links');
    assert.match(await js('document.getElementById("settings-auto-links").parentElement.nextElementSibling.textContent'), /held delivery failed/);
    const failed = await matchesAuthority(); assert.equal(failed.api.autoOpenLinks, afterPersistence ? !original.autoOpenLinks : original.autoOpenLinks);
    await reach('#settings-auto-links'); await key('Enter'); await idle('#settings-auto-links');
    observations[afterPersistence ? 'failureAfterPersistence' : 'failureBeforePersistence'] = { failed, retried: await matchesAuthority() };
    assert.equal(settingsCalls().length - before, 3); assert.equal(await active(), 'settings-auto-links');
  });
  await check('late snapshot preserves a dirty field and moved focus without duplicate saves', async () => {
    const before = settingsCalls().length, old = hold('autoOpenLinks');
    await reach('#settings-auto-links'); await key('Enter'); await wait(() => old.entered);
    await reach('#settings-auto-takeover'); await key('Enter'); await idle('#settings-auto-takeover');
    await click('#settings-category-connections'); await reach('#mac-ssh-host');
    await wc.debugger.sendCommand('Input.insertText', { text: 'ordering-draft@local.invalid' });
    assert.equal(await js('document.getElementById("mac-ssh-host").value'), 'ordering-draft@local.invalid');
    old.release(); await wait(() => settingsCalls().filter(c => c.replied).length === settingsCalls().length); await frame();
    assert.equal(await active(), 'mac-ssh-host'); assert.equal(await js('document.getElementById("mac-ssh-host").value'), 'ordering-draft@local.invalid');
    assert.equal(settingsCalls().length - before, 2); assert.equal(prefs().macSshHost, '');
    await click('#settings-category-general'); observations.draft = await matchesAuthority();
  });
  await check('native snapshot revisions agree across unchanged reads and actual broadcasts', async () => {
    await pause(150); const a = await api(), b = await api();
    assert.ok(Number.isSafeInteger(a.uiStateRevision) && a.uiStateRevision > 0);
    assert.equal(a.uiStateRevision, b.uiStateRevision, 'Unchanged snapshot reads retain the revision');
    await reach('#settings-auto-links'); await key('Enter'); await idle('#settings-auto-links'); const c = await api();
    assert.ok(c.uiStateRevision > b.uiStateRevision);
    assert.ok(broadcasts.some(s => s.uiStateRevision === c.uiStateRevision && s.autoOpenLinks === c.autoOpenLinks));
    observations.revisions = { before: b.uiStateRevision, after: c.uiStateRevision };
  });
  observations.input = await js('orderingInputs');
  assert.ok(observations.input.length && observations.input.every(e => e.trusted));
  observations.runtime = { pid: process.pid, source: path.resolve(__dirname, '../src/main.cjs'), preload: wc.getLastWebPreferences().preload, nativeAttempts: 0, profile: 'disposable; deleted by runner' };
}).catch(error => { results.push({ name: 'fixture', pass: false, error: error.stack }); console.error(error); }).finally(() => {
  const fail = results.filter(result => !result.pass).length;
  fs.writeFileSync(path.join(out, `${phase}-results.json`), JSON.stringify({ pass: results.length - fail, fail, results, observations, calls, broadcasts }, null, 2));
  app.once('will-quit', () => app.exit(fail ? 1 : 0)); quitFixture();
});
