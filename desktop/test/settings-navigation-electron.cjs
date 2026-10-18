// Actual renderer + main, disposable data, trusted Chromium keys. No OS focus lease.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { app, BrowserWindow, ipcMain, session, webContents } = require('electron');
const { prepareFixture, quitFixture } = require('./electron-fixture.cjs');
const profile = process.env.HERMES_TEST_PROFILE;
assert.ok(profile, 'Use test/run-electron.cjs for disposable storage.');
const boundaries = require('./settings-fixture-boundaries.cjs')();
prepareFixture(profile);
const bots = Array.from({ length: 24 }, (_, i) => ({ id: String(9000 + i), name: i % 5 === 0 ? `Research ${i + 1} — a long bot name across multiple workspaces` : `Research ${i + 1}`, username: `settings_fixture_${i + 1}_bot`, isBot: true }));
fs.writeFileSync(path.join(profile, 'preferences.json'), JSON.stringify({ onboarded: true, preview: false, bots, selectedBotId: bots[0].id, hidden: [bots[23].id], remoteUrl: '', macSshHost: 'fixture@local.invalid', vpsBrowser: { enabled: false, sshHost: 'agent@fixture.invalid' } }));
const responses = new Map(), calls = [];
const realHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => realHandle(channel, channel === 'workspace:command' ? async (event, name, value) => {
  calls.push({ name, value });
  if (responses.has(name)) return responses.get(name)(value);
  return handler(event, name, value);
} : handler);
require('../src/main.cjs');
const out = process.env.SETTINGS_EVIDENCE_DIR ? path.resolve(process.env.SETTINGS_EVIDENCE_DIR) : path.resolve(__dirname, '../../evidence/quality/settings-navigation');
fs.mkdirSync(out, { recursive: true });
const phase = process.env.SETTINGS_PHASE || 'green';
const results = [], observations = {};
let win, wc, server;
const pause = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));
const wait = async (read, predicate = Boolean) => {
  for (let i = 0; i < 160; i++) { const value = await read(); if (predicate(value)) return value; await pause(); }
  throw Error('Timed out waiting for UI state.');
};
app.whenReady().then(async () => {
  win = await wait(() => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html')));
  wc = win.webContents;
  const js = code => wc.executeJavaScript(code);
  await wait(() => js('!!document.querySelector(".bot-open")').catch(() => false));
  wc.debugger.attach('1.3');
  await wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
  const frame = () => js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  const focus = async selector => {
    const summary = await js(`(() => { const details=document.querySelector(${JSON.stringify(selector)})?.closest('details'); return details&&!details.open?'#'+details.id+' > summary':null; })()`);
    if (summary) { await js(`document.querySelector(${JSON.stringify(summary)}).focus()`); await key('Enter'); }
    await js(`document.querySelector(${JSON.stringify(selector)})?.focus()`);
  };
  const active = () => js('document.activeElement.id');
  const key = async (key, shift = false) => {
    const vk = { Tab: 9, Enter: 13, Escape: 27, End: 35, Home: 36, ArrowUp: 38, ArrowDown: 40, ' ': 32 }[key];
    const params = { key, code: key === ' ' ? 'Space' : key, windowsVirtualKeyCode: vk, modifiers: shift ? 8 : 0 };
    await wc.debugger.sendCommand('Input.dispatchKeyEvent', { ...params, type: 'keyDown', ...(key === 'Enter' ? { text: '\r' } : key === ' ' ? { text: ' ' } : {}) });
    await wc.debugger.sendCommand('Input.dispatchKeyEvent', { ...params, type: 'keyUp' });
    await pause(); await frame();
  };
  const shot = async name => { await frame(); fs.writeFileSync(path.join(out, `${phase}-${name}.png`), (await wc.capturePage()).toPNG()); };
  const check = async (name, test) => {
    try { await test(); results.push({ name, pass: true }); console.log('PASS:', name); }
    catch (error) { results.push({ name, pass: false, error: error.stack }); console.error('FAIL:', name, error.message); await shot(`failure-${results.length}`); }
  };
  const open = async () => { await focus('#settings-button'); await key('Enter'); await frame(); };
  const search = async query => { await focus('#settings-search'); await js('document.getElementById("settings-search").select()'); await wc.insertText(query); await frame(); };
  const category = async id => { await focus(`#settings-category-${id}`); await key('Enter'); };
  const press = async selector => { await focus(selector); await key('Enter'); };
  const replace = async (selector, value) => { await focus(selector); await js(`document.querySelector(${JSON.stringify(selector)}).select()`); await wc.insertText(value); await frame(); };
  const close = async () => { await focus('#modal-close'); await key('Enter'); };
  win.setContentSize(1280, 800); await frame();
  await js('window.settingsKeys=[];document.addEventListener("keydown",e=>settingsKeys.push({key:e.key,trusted:e.isTrusted}),true)');
  await open();
  await check('find Accessibility directly without tabbing through 24 bot switches', async () => {
    assert.equal(await active(), 'settings-search', 'Settings opens focused in its named search field');
    await search('accessibility');
    assert.equal(await js('document.querySelector("[data-settings-section=computer-permissions]")?.hidden'), false);
    assert.match(await js('document.getElementById("settings-content").innerText'), /Accessibility/);
    await shot('accessibility-1280');
  });
  if (phase === 'red') return;
  await check('find remote connection, bot visibility, cookies and update status by their task names', async () => {
    for (const [query, section] of [['remote connection', 'remote-desktop'], ['bot visibility', 'bot-visibility'], ['cookies', 'cookies'], ['update status', 'updates']]) {
      await search(query);
      assert.equal(await js(`document.querySelector('[data-settings-section="${section}"]')?.hidden`), false, query);
    }
  });
  if (phase === 'sections-red') return;
  await check('no-results, clear, Escape, and category arrows have accurate state and recover directly', async () => {
    await search('nonesuch-zqv'); assert.equal(await js('document.getElementById("settings-empty").hidden'), false);
    assert.equal(await js('document.querySelectorAll(".settings-category[aria-selected=true]").length'), 0);
    await shot('no-results'); await press('#settings-reset'); assert.equal(await active(), 'settings-search');
    assert.equal(await js('document.getElementById("settings-search").value'), '');
    await search('cookies'); await key('Escape'); assert.equal(await active(), 'settings-search');
    assert.equal(await js('document.getElementById("settings-search").value'), '');
    await category('general'); await key('ArrowDown'); assert.equal(await active(), 'settings-category-bots');
    assert.equal(await js('document.querySelector(".settings-category[aria-selected=true]").textContent'), 'Bots & appearance');
    await key('End'); assert.equal(await active(), 'settings-category-support');
    await key('Home'); assert.equal(await active(), 'settings-category-general');
    await search('remote connection'); await key('Escape'); await key('Escape'); assert.equal(await active(), 'settings-button');
    await open(); assert.equal(await active(), 'settings-search'); assert.equal(await js('document.getElementById("settings-search").value'), '');
  });
  await check('real local save validation retains invalid draft, then saves and reads back the remote URL', async () => {
    await search('remote connection');
    await replace('#remote-url', 'file:///invalid-remote');
    await press('[data-settings-section=remote-desktop] .primary-button');
    await wait(() => js('document.querySelector("[data-settings-section=remote-desktop] .settings-action-status").textContent'), s => /http\(s\)/.test(s));
    assert.equal(await js('document.getElementById("remote-url").value'), 'file:///invalid-remote');
    assert.equal((await js('workspace.getState()')).remoteUrl, '');
    const url = 'http://127.0.0.1:9/vnc.html?token=SettingsSecretMarker';
    await replace('#remote-url', url); await press('[data-settings-section=remote-desktop] .primary-button');
    await wait(() => js('workspace.getState()'), s => s.remoteUrl === url);
    await search('SettingsSecretMarker'); assert.equal(await js('document.getElementById("settings-empty").hidden'), false, 'Secret field values are not searchable');
    await search('remote connection'); await close(); await open(); await search('remote connection');
    assert.equal(await js('document.getElementById("remote-url").value'), url);
    assert.equal(JSON.parse(fs.readFileSync(path.join(profile, 'preferences.json'))).remoteUrl, url);
    await replace('#remote-url', ''); await press('[data-settings-section=remote-desktop] .primary-button');
    await wait(() => js('workspace.getState()'), s => s.remoteUrl === '');
  });
  await check('bot visibility saves and persists; async failure rolls the switch back', async () => {
    await search('bot visibility'); const selector = 'input[data-bot-id="9001"]';
    await focus(selector); await key(' ');
    await wait(() => js('workspace.getState()'), s => s.hidden.includes('9001'));
    assert.equal(await js(`document.querySelector('${selector}').checked`), false);
    assert.ok(JSON.parse(fs.readFileSync(path.join(profile, 'preferences.json'))).hidden.includes('9001'));
    responses.set('set-bot-visibility', async () => { throw Error('Visibility could not be saved (fixture).'); });
    await focus(selector); await key(' '); await wait(() => js(`!document.querySelector('${selector}').hasAttribute('aria-busy')`));
    assert.equal(await js(`document.querySelector('${selector}').checked`), false);
    assert.match(await js(`document.querySelector('${selector}').closest('label').textContent`), /Visibility could not be saved/);
    assert.doesNotMatch(await js(`document.querySelector('${selector}').closest('label').textContent`), /Error invoking remote method|workspace:command/);
    await shot('visibility-failed');
    responses.delete('set-bot-visibility');
    await focus(selector); await key(' '); await wait(() => js('workspace.getState()'), s => !s.hidden.includes('9001'));
    await close(); await open(); await search('bot visibility'); assert.equal(await js(`document.querySelector('${selector}').checked`), true);
  });
  await check('drafts, selected category, and update status survive actual state broadcasts and repeated Settings commands', async () => {
    const current = await js('workspace.getState()');
    await category('connections'); await replace('#remote-url', 'unsaved draft');
    await js(`workspace.command("settings",{autoOpenLinks:${!current.autoOpenLinks}})`); await frame();
    assert.equal(await js('document.getElementById("remote-url").value'), 'unsaved draft');
    assert.equal(await js('document.getElementById("settings-remote-platform").value'), current.remotePlatform);
    wc.send('workspace:settings'); await frame(); assert.equal(await active(), 'remote-url', 'Repeated menu commands preserve the active dialog focus');
    assert.equal(await js('document.getElementById("remote-url").value'), 'unsaved draft');
    await category('browser'); await category('connections'); assert.equal(await js('document.getElementById("remote-url").value'), 'unsaved draft');
    await search('update status');
    const real = await js('workspace.getState()'), send = wc.send.bind(wc);
    wc.send = (channel, ...args) => { if (channel !== 'workspace:state') send(channel, ...args); };
    try {
      send('workspace:state', { ...real, versions: { text: 'Version status fixture', tooltip: 'Checked fixture status', hasUpdate: true, steps: [] } }); await frame();
      assert.match(await js('document.getElementById("settings-update-summary").textContent'), /Updates are available/);
      assert.equal(await active(), 'settings-search'); assert.equal(await js('document.getElementById("settings-search").value'), 'update status');
    } finally { wc.send = send; send('workspace:state', real); }
  });
  await check('an explicit platform change isolates its viewer draft and returning restores it without saving', async () => {
    const current = await js('workspace.getState()'), original = current.remotePlatform;
    const alternate = original === 'mac' ? 'linux' : 'mac';
    const draft = 'http://127.0.0.1:9/original-platform-draft';
    await category('connections'); await replace('#remote-url', draft);
    try {
      await js(`workspace.command("settings",{remotePlatform:${JSON.stringify(alternate)}})`);
      await wait(() => js('document.getElementById("settings-remote-platform").value'), value => value === alternate);
      assert.equal(await js('document.getElementById("remote-url").value'), current.remoteUrl);
      assert.equal(JSON.parse(fs.readFileSync(path.join(profile, 'preferences.json'))).remoteUrl, current.remoteUrl);
      await js(`workspace.command("settings",{remotePlatform:${JSON.stringify(original)}})`);
      await wait(() => js('document.getElementById("remote-url").value'), value => value === draft);
      assert.equal(await js('document.getElementById("settings-remote-platform").value'), original);
      assert.equal(await js('document.getElementById("remote-url").dataset.dirty'), 'true');
      assert.equal(JSON.parse(fs.readFileSync(path.join(profile, 'preferences.json'))).remoteUrl, current.remoteUrl);
    } finally {
      await js(`workspace.command("settings",{remotePlatform:${JSON.stringify(original)}})`);
    }
    await press('#settings-discard-viewer');
    assert.equal(await js('document.getElementById("remote-url").value'), current.remoteUrl);
  });
  await check('cookie loading/failure fixtures give retry; real local cookie clear reads back empty', async () => {
    await close(); let resolveLoad;
    responses.set('list-cookies', () => new Promise(resolve => { resolveLoad = resolve; }));
    await open(); await search('cookies'); await wait(() => resolveLoad);
    assert.equal(await js('document.getElementById("settings-refresh-cookies").getAttribute("aria-busy")'), 'true');
    assert.match(await js('document.querySelector("[data-settings-section=cookies]").innerText'), /Loading cookies/);
    await shot('cookies-loading'); await category('general'); await category('browser');
    await close(); resolveLoad([]); responses.set('list-cookies', async () => { throw Error('Cookie service unavailable (fixture).'); });
    await open(); await search('cookies');
    await wait(() => js('document.querySelector("[data-settings-section=cookies]").innerText'), s => /Cookie service unavailable/.test(s));
    assert.doesNotMatch(await js('document.getElementById("cookie-list").innerText'), /No cookies stored/);
    assert.equal(await js('document.getElementById("settings-refresh-cookies").disabled'), false); await shot('cookies-failed');
    responses.delete('list-cookies');
    await session.fromPartition('persist:browser').cookies.set({ url: 'http://settings-fixture.invalid', name: 'task', value: 'local-only' });
    await press('#settings-refresh-cookies'); await wait(() => js('document.getElementById("cookie-list").innerText'), s => s.includes('settings-fixture.invalid'));
    await press('#settings-clear-cookies'); await wait(() => js('document.getElementById("cookie-list").innerText'), s => s.includes('No cookies stored'));
    assert.equal((await session.fromPartition('persist:browser').cookies.get({})).length, 0);
  });
  await check('browser permission validation errors stay inline; real local save and reset read back', async () => {
    await search('site permissions'); await replace('#permission-origin', 'not-a-site');
    await press('[data-settings-section=site-permissions] .field button');
    await wait(() => js('document.querySelector("[data-settings-section=site-permissions] .settings-action-status.error")?.textContent'));
    assert.equal(await js('document.getElementById("permission-origin").value'), 'not-a-site');
    assert.doesNotMatch(await js('document.querySelector("[data-settings-section=site-permissions]").innerText'), /Error invoking remote method|workspace:command/);
    await replace('#permission-origin', 'https://settings-fixture.invalid');
    await press('[data-settings-section=site-permissions] .field button');
    await wait(() => js('document.getElementById("site-permissions").innerText'), s => s.includes('settings-fixture.invalid'));
    assert.equal((await js('workspace.getState()')).sitePermissions.browser['https://settings-fixture.invalid'].geolocation, 'block');
    await press('[data-settings-section=site-permissions] .settings-section-body > button');
    await wait(() => js('document.getElementById("site-permissions").innerText'), s => !s.includes('settings-fixture.invalid'));
  });
  await check('slow and failed agent path and diagnostics remain readable and retryable (IPC fixtures)', async () => {
    let rejectPath; responses.set('test-agent-path', () => new Promise((_resolve, reject) => { rejectPath = reject; }));
    await search('agent setup'); await press('#settings-test-path'); await wait(() => rejectPath);
    assert.equal(await js('document.getElementById("settings-test-path").getAttribute("aria-busy")'), 'true');
    assert.equal(await js('(() => {const b=document.getElementById("settings-test-path").nextElementSibling.getBoundingClientRect(),p=document.getElementById("settings-content").getBoundingClientRect();return b.top>=p.top&&b.bottom<=p.bottom})()'), true, 'Busy feedback must be visible with its action');
    await shot('agent-path-loading'); await category('general'); await category('connections');
    rejectPath(Error('Agent machine unreachable (fixture).'));
    await wait(() => js('document.querySelector("[data-settings-section=agent-setup]").innerText'), s => /Agent machine unreachable/.test(s));
    assert.equal(await js('document.getElementById("settings-test-path").disabled'), false);
    responses.set('test-agent-path', async () => ({ ok: false, detail: 'SSH check failed (fixture).' })); await press('#settings-test-path');
    await wait(() => js('document.querySelector("[data-settings-section=agent-setup]").innerText'), s => /SSH check failed/.test(s));
    responses.set('setup-check', async () => { throw Error('Setup check failed (fixture).'); });
    await search('diagnostics'); await press('[data-settings-section=diagnostics] button');
    await wait(() => js('document.querySelector("[data-settings-section=diagnostics]").innerText'), s => /Setup check failed/.test(s));
    await shot('async-failed'); responses.delete('test-agent-path'); responses.delete('setup-check');
  });
  observations.viewports = [];
  const minimum = win.getMinimumSize();
  for (const viewport of [{ name: '1280x800', size: [1280, 800] }, { name: 'app-minimum', size: minimum, outer: true }, { name: '1024x640', size: [1024, 640], forced: true }]) {
    if (viewport.forced) win.setMinimumSize(0, 0);
    if (viewport.outer) win.setSize(...viewport.size); else win.setContentSize(...viewport.size);
    await frame();
    await check(`${viewport.name}: categories/title remain visible and Tab/Shift+Tab reveal full focus outlines`, async () => {
      await category('general'); const dimensions = await js('[innerWidth,innerHeight]');
      const failures = [], stops = {};
      const geometry = () => js(`(() => {const a=document.activeElement,p=document.getElementById('settings-content'),b=a.getBoundingClientRect(),c=p.getBoundingClientRect(),s=getComputedStyle(a),ring=a===p?0:(parseFloat(s.outlineWidth)||0)+Math.max(0,parseFloat(s.outlineOffset)||0);return {text:a.id||a.getAttribute('aria-label')||a.textContent,inside:p.contains(a),top:b.top-ring,bottom:b.bottom+ring,left:b.left-ring,right:b.right+ring,pane:{top:c.top,bottom:c.bottom,left:c.left,right:c.right}}})()`);
      const inspect = async () => { const g = await geometry(); if (g.inside && (g.top < g.pane.top - 1 || g.bottom > g.pane.bottom + 1 || g.left < g.pane.left - 1 || g.right > g.pane.right + 1)) failures.push(g); };
      for (const id of ['general', 'bots', 'browser', 'recordings', 'computer', 'connections', 'support']) {
        await category(id); let count = 0;
        do {
          await key('Tab'); count++;
          await inspect();
          assert.equal(await js('document.getElementById("modal").contains(document.activeElement)'), true);
          if (count > 90) throw Error('Tab did not complete its cycle');
        } while (await active() !== 'modal-close');
        stops[id] = count;
        let reverse = 0;
        do {
          await key('Tab', true); reverse++; await inspect();
          if (reverse === 1) await shot(`${viewport.name}-${id}-last`);
          if (reverse > 90) throw Error('Reverse Tab did not return to the category');
        } while (await active() !== `settings-category-${id}`);
        assert.equal(reverse, count);
      }
    observations.viewports.push({ name: viewport.name, dimensions, minimum, stops, failures });
      assert.deepEqual(failures, []);
      assert.equal(await js('document.querySelector(".settings-modal>.modal-card").scrollTop'), 0);
      assert.equal(await js('document.getElementById("modal-body").scrollTop'), 0);
      assert.equal(await js('document.getElementById("settings-navigation").scrollTop'), 0);
      assert.equal(await js('(() => {const ids=["modal-title","modal-close","settings-navigation"];return ids.every(id=>{const r=document.getElementById(id).getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&r.left>=0&&r.right<=innerWidth})})()'), true);
      await category('general'); await shot(`${viewport.name}-general`);
    });
  }
  await check('guide opens from settings, preserves its search/scroll region, and returns focus', async () => {
    await category('general'); await press('#settings-shortcuts');
    assert.equal(await active(), 'shortcut-search');
    await key('Tab'); assert.equal(await active(), 'shortcut-results'); await key('End'); await key('Escape');
    assert.equal(await active(), 'settings-shortcuts'); assert.equal(await js('document.getElementById("modal").classList.contains("hidden")'), false);
  });
  await check('extension and avatar detail return to the settings category', async () => {
    await category('browser'); await press('[data-settings-section=extensions] button');
    assert.equal(await js('document.getElementById("modal-title").textContent'), 'Extensions');
    await press('.settings-detail-back'); assert.equal(await active(), 'settings-category-browser');
    await category('bots'); await press('[data-settings-section=bot-appearance] button');
    assert.equal(await js('document.getElementById("modal-title").textContent'), 'Bot appearance');
    await press('.settings-detail-back'); assert.equal(await active(), 'settings-category-bots');
  });
  await check('native child geometry is shielded while settings is open; draft survives (not OS focus proof)', async () => {
    await close();
    server = http.createServer((_req, res) => res.end('<!doctype html><title>Settings local fixture</title><textarea id="draft">Human draft</textarea>'));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/`;
    await js(`workspace.command('create-tab',{url:${JSON.stringify(url)}})`);
    const child = await wait(() => webContents.getAllWebContents().find(c => c.getURL() === url));
    await wait(() => child.executeJavaScript('!!document.getElementById("draft")').catch(() => false));
    await child.executeJavaScript('draft.focus();draft.setSelectionRange(2,7)');
    await open(); await frame();
    assert.notEqual(child.getOwnerBrowserWindow(), win);
    await shot('child-shielded'); await key('Escape'); await frame();
    assert.equal(child.getOwnerBrowserWindow(), win);
    assert.deepEqual(await child.executeJavaScript('[draft.value,draft.selectionStart,draft.selectionEnd]'), ['Human draft', 2, 7]);
  });
  await check('reduced motion and final Escape leave a visible workspace opener', async () => {
    await wc.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await open(); await category('general'); await shot('reduced-motion'); await key('Escape');
    assert.equal(await active(), 'settings-button');
    observations.reducedMotion = await js('matchMedia("(prefers-reduced-motion: reduce)").matches');
    assert.equal(observations.reducedMotion, true);
  });
  observations.trusted = await js('settingsKeys');
  assert.ok(observations.trusted.length && observations.trusted.every(e => e.trusted));
  observations.native = { tested: false, reason: 'No OS focus or permission attempts. Chromium trusted-key coverage only.' };
  observations.boundaries = boundaries;
  fs.writeFileSync(path.join(out, `${phase}-ax.json`), JSON.stringify(await wc.debugger.sendCommand('Accessibility.getFullAXTree'), null, 2));
}).catch(error => { results.push({ name: 'fixture', pass: false, error: error.stack }); console.error(error); }).finally(() => {
  const fail = results.filter(r => !r.pass).length;
  fs.writeFileSync(path.join(out, `${phase}-results.json`), JSON.stringify({ pass: results.length - fail, fail, results, observations, calls }, null, 2));
  app.once('will-quit', () => app.exit(fail ? 1 : 0)); quitFixture(server);
});
