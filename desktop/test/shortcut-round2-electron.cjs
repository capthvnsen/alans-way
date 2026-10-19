const { resizeWindow } = require('./window-fixture.cjs');
// Focused UI regressions. Runs the actual source app with disposable storage.
// No native focus, OS permission, accelerator, or editing acceptance is implied.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { app, BrowserWindow, Menu, webContents } = require('electron');
const { prepareFixture, quitFixture } = require('./electron-fixture.cjs');
const profile = process.env.HERMES_TEST_PROFILE;
assert.ok(profile, 'Run through test/run-electron.cjs for disposable storage.');
prepareFixture(profile);
process.env.HERMES_WORKSPACE_ALLOW_LOOPBACK = '1';
fs.writeFileSync(path.join(profile, 'preferences.json'), JSON.stringify({ onboarded: true, preview: false,
  macSshHost: 'fixture@local.invalid', bots: [{ id: '401', name: 'Research', isBot: true }], selectedBotId: '401' }));
require('../src/main.cjs');
const out = process.env.SHORTCUT_EVIDENCE_DIR ? path.resolve(process.env.SHORTCUT_EVIDENCE_DIR) : fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'shortcut-round2-'));
fs.mkdirSync(out, { recursive: true });
const phase = process.env.SHORTCUT_PHASE || 'green';
const results = [], trusted = [], observations = {};
const pause = (ms = 40) => new Promise(resolve => setTimeout(resolve, ms));
const wait = async (read, predicate = Boolean) => {
  for (let i = 0; i < 150; i++) { const value = await read(); if (predicate(value)) return value; await pause(); }
  throw Error('Timed out waiting for UI state.');
};
let wc, win, server;
app.whenReady().then(async () => {
  win = await wait(async () => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html')));
  wc = win.webContents;
  const js = code => wc.executeJavaScript(code);
  await wait(() => js('!!document.querySelector(".bot-open")').catch(() => false));
  win.setMinimumSize(0, 0);
  wc.debugger.attach('1.3');
  // Chromium focus emulation makes DOM keys testable without taking OS focus.
  await wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
  const frame = () => js('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
  const focus = selector => js(`document.querySelector(${JSON.stringify(selector)}).focus()`);
  const active = () => js('document.activeElement.id');
  const state = () => js('workspace.getState()');
  const invoke = (command, value = {}) => js(`workspace.command(${JSON.stringify(command)},${JSON.stringify(value)})`);
  const menu = label => {
    const walk = items => { for (const item of items) { if (item.label === label) return item; const found = item.submenu && walk(item.submenu.items); if (found) return found; } };
    return walk(Menu.getApplicationMenu().items);
  };
  const key = async (key, shift = false) => {
    const vk = { Tab: 9, Enter: 13, Escape: 27, PageUp: 33, PageDown: 34, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46 }[key];
    const params = { key, code: key, windowsVirtualKeyCode: vk, modifiers: shift ? 8 : 0 };
    await wc.debugger.sendCommand('Input.dispatchKeyEvent', { ...params, type: 'keyDown', ...(key === 'Enter' ? { text: '\r' } : {}) });
    await wc.debugger.sendCommand('Input.dispatchKeyEvent', { ...params, type: 'keyUp' });
    await pause(); await frame();
  };
  const shot = async name => { await frame(); fs.writeFileSync(path.join(out, `${phase}-${name}.png`), (await wc.capturePage()).toPNG()); };
  const check = async (name, test) => {
    try { await test(); results.push({ name, pass: true }); console.log('PASS:', name); }
    catch (error) { results.push({ name, pass: false, error: error.stack }); console.error('FAIL:', name, error.message); await shot(`failure-${results.length}`); }
  };
  let opener;
  const open = async () => {
    const toolbarVisible = await js('document.getElementById("shortcuts-button").getBoundingClientRect().width > 0');
    opener = toolbarVisible ? 'shortcuts-button' : 'status-more';
    await focus('#' + opener);
    if (toolbarVisible) await key('Enter'); else menu('Keyboard Shortcuts').click();
    await frame();
  };
  const close = async () => { await key('Escape'); await frame(); };
  const search = async query => {
    await focus('#shortcut-search');
    await js('document.getElementById("shortcut-search").select()');
    await wc.insertText(query); await frame();
  };
  const rows = () => js('[...document.querySelectorAll("[data-shortcut]")].map(n=>n.dataset.shortcut)');
  const scroll = () => js('document.getElementById("shortcut-results").scrollTop');
  const unavailable = () => js('[...document.querySelectorAll(".shortcut-unavailable")].map(n=>n.closest("[data-shortcut]").dataset.shortcut)');
  await js('window.round2Keys=[];document.addEventListener("keydown",e=>round2Keys.push({key:e.key,trusted:e.isTrusted}),true)');
  const queries = [
    ['new tab', ['new-tab']], ['close tab', ['close-tab', 'tab-close']], ['focus address', ['address']], ['switch tabs', ['tab-move']],
    ['cmd+t', ['new-tab']], ['Command+T', ['new-tab']], ['⌘T', ['new-tab']],
    ['command comma', ['settings']], ['cmd+,', ['settings']], ['⌘,', ['settings']], ['comma', ['settings']], ['settings', ['settings']],
    ['ArrowDown', ['agent-move', 'search-result']], ['down arrow', ['agent-move', 'search-result']], ['↓', ['agent-move', 'search-result']],
    ['shift tab', ['dialog-tab']], ['⇧⇥', ['dialog-tab']], ['command+q', []], ['nonesuch-zqv', []],
  ];
  await open();
  observations.queries = [];
  for (const [query, expected] of queries) await check(`search ${JSON.stringify(query)} finds the intended rows`, async () => {
    await search(query); const actual = await rows(); observations.queries.push({ query, expected, actual }); assert.deepEqual(actual, expected);
  });
  await close();
  observations.viewports = [];
  for (const [width, height] of [[820, 560], [1024, 640], [1440, 900]]) {
    const effective = await resizeWindow(win, width, height); await frame(); await open();
    await check(`${width}x${height}: Tab enters results; navigation reaches last row and returns to opener`, async () => {
      assert.deepEqual(await js('[innerWidth,innerHeight]'), [effective.width, effective.height]);
      await key('Tab'); assert.equal(await active(), 'shortcut-results', 'Tab from Search must enter the results');
      const start = await scroll(); await key('ArrowDown'); await wait(scroll, top => top > start);
      const arrow = await scroll(); await key('PageDown'); await wait(scroll, top => top > arrow);
      await key('End'); await wait(() => js('(() => {const r=document.getElementById("shortcut-results"),last=document.querySelector("[data-shortcut=dialog-close]");return last.getBoundingClientRect().bottom<=r.getBoundingClientRect().bottom})()'));
      const end = await scroll(); await shot(`browse-${width}x${height}-end`);
      const geometry = await js('(() => {const c=document.querySelector(".shortcut-card"),r=document.getElementById("shortcut-results");return {width:innerWidth,height:innerHeight,client:r.clientHeight,scroll:r.scrollHeight,top:r.scrollTop,overflow:c.scrollWidth>c.clientWidth}})()');
      observations.viewports.push(geometry); assert.equal(geometry.overflow, false);
      await key('ArrowUp'); await wait(scroll, top => top < end);
      await key('PageUp'); await key('Home'); await wait(scroll, top => top === 0);
      await key('Tab', true); assert.equal(await active(), 'shortcut-search');
      await key('Tab', true); assert.equal(await active(), 'shortcut-close');
      await key('Tab', true); assert.equal(await active(), 'shortcut-results');
      await key('Tab'); assert.equal(await active(), 'shortcut-close');
      await key('Tab'); assert.equal(await active(), 'shortcut-search');
      await shot(`browse-${width}x${height}-top`);
    });
    await close(); assert.equal(await active(), opener);
  }
  await open();
  await check('unfiltered guide updates availability through real menu create/close and activation without moving focus or scroll', async () => {
    assert.deepEqual(await unavailable(), ['close-tab', 'reload']);
    await key('Tab'); if (await active() === 'shortcut-results') { await key('PageDown'); await pause(200); }
    const before = { active: await active(), scroll: await scroll() };
    menu('New Browser Tab').click(); await wait(state, s => s.tabs.length === 1); await frame();
    assert.deepEqual(await unavailable(), [], 'New Browser Tab must clear unavailable labels immediately');
    const id = (await state()).activeTabId;
    await invoke('activate', { id: 'home' }); await frame(); assert.deepEqual(await unavailable(), ['close-tab', 'reload']);
    await invoke('activate', { id }); await frame(); assert.deepEqual(await unavailable(), []);
    menu('Close Tab').click(); await wait(state, s => s.tabs.length === 0); await frame();
    assert.deepEqual(await unavailable(), ['close-tab', 'reload']);
    assert.equal(await active(), before.active); assert.ok(Math.abs(await scroll() - before.scroll) < 80, 'Preserve a reasonable reading position');
    assert.equal(await js('document.getElementById("shortcut-search").value'), '');
    observations.liveUnfiltered = { before, after: { active: await active(), scroll: await scroll() } };
    await shot('live-unfiltered');
  });
  for (const tab of (await state()).tabs) await invoke('close-tab', { id: tab.id });
  await frame();
  await check('filtered guide updates labels through real create/activate/close while retaining query and Search focus', async () => {
    await search('reload'); assert.deepEqual(await unavailable(), ['reload']);
    const tab = await invoke('create-tab'); await frame(); assert.deepEqual(await unavailable(), []);
    await invoke('activate', { id: 'home' }); await frame(); assert.deepEqual(await unavailable(), ['reload']);
    await invoke('activate', { id: tab.id }); await frame(); assert.deepEqual(await unavailable(), []);
    await invoke('close-tab', { id: tab.id }); await frame(); assert.deepEqual(await unavailable(), ['reload']);
    assert.equal(await js('document.getElementById("shortcut-search").value'), 'reload'); assert.equal(await active(), 'shortcut-search');
    assert.deepEqual(await rows(), ['reload']); await shot('live-filtered');
  });
  for (const tab of (await state()).tabs) await invoke('close-tab', { id: tab.id });
  await close();
  await check('busy update above guide preserves focus boundary, query and result reading position', async () => {
    await open(); await key('Tab'); if (await active() === 'shortcut-results') { await key('PageDown'); await pause(200); }
    const before = { active: await active(), scroll: await scroll() }, real = await state();
    const send = wc.send.bind(wc); wc.send = (channel, ...args) => { if (channel !== 'workspace:state') send(channel, ...args); };
    try {
      send('workspace:state', { ...real, update: { ...real.update, available: '9.9.9', popup: true, busy: true } }); await frame();
      await key('Tab'); await key('Tab', true); await key('Escape');
      assert.equal(await js('document.getElementById("update-popup").contains(document.activeElement)'), true);
      assert.equal(await js('document.getElementById("update-popup").classList.contains("hidden")'), false);
      send('workspace:state', real); await frame();
      assert.equal(await active(), before.active); assert.equal(await scroll(), before.scroll);
    } finally { wc.send = send; send('workspace:state', real); }
    await close(); assert.equal(await active(), opener);
  });
  await check('agent-dispatched chords preserve a human page draft and open-guide query/focus/scroll', async () => {
    server = http.createServer((_req, res) => res.end('<!doctype html><title>Local round2 fixture</title><textarea id="draft">Human draft</textarea>'));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/`;
    await invoke('create-tab', { url });
    const human = await wait(async () => webContents.getAllWebContents().find(c => c.getURL() === url));
    await wait(() => human.executeJavaScript('!!document.getElementById("draft")').catch(() => false));
    await human.executeJavaScript('draft.focus();draft.setSelectionRange(2,7)');
    const connection = JSON.parse(fs.readFileSync(path.join(profile, 'connection.json'), 'utf8'));
    const api = async (route, body) => { const response = await fetch(new URL(route, connection.url), { method: 'POST', headers: { Authorization: `Bearer ${connection.token}`, 'X-Hermes-Bot': 'round2-isolation', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const data = await response.json(); assert.ok(response.ok, data.error); return data; };
    const agent = await api('/v1/tabs', { url: url + 'agent' });
    await open(); await search('agent'); await key('Tab'); await key('Tab'); await key('End'); await pause(200);
    const sample = async () => ({ active: await active(), scroll: await scroll(), query: await js('document.getElementById("shortcut-search").value'), state: (await state()).activeTabId, draft: await human.executeJavaScript('[draft.value,draft.selectionStart,draft.selectionEnd]') });
    const before = await sample();
    for (const modifiers of [['meta'], ['control']]) for (const key of [',', 't', 'w', 'r', 'o', 'l', 'a', 'Escape', 'ArrowDown', 'Tab'])
      await api(`/v1/tabs/${agent.id}/actions`, { action: 'press', key, modifiers, epoch: agent.epoch });
    assert.deepEqual(await sample(), before); observations.agentDispatches = 20; await close();
  });
  trusted.push(...await js('round2Keys')); assert.ok(trusted.length > 10); assert.ok(trusted.every(e => e.trusted));
  observations.native = { status: 'unverified', reason: 'No OS focus/permission attempts, physical Cmd hotkeys, native editing, or native child focus checks in this scoped run.' };
  fs.writeFileSync(path.join(out, `${phase}-ax.json`), JSON.stringify(await wc.debugger.sendCommand('Accessibility.getFullAXTree'), null, 2));
}).catch(error => { results.push({ name: 'fixture', pass: false, error: error.stack }); console.error(error); }).finally(() => {
  const fail = results.filter(r => !r.pass).length;
  fs.writeFileSync(path.join(out, `${phase}-ui-results.json`), JSON.stringify({ pass: results.length - fail, fail, results, observations, trusted }, null, 2));
  app.once('will-quit', () => app.exit(fail ? 1 : 0)); quitFixture(server);
});
