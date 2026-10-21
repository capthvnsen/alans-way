const { resizeWindow } = require('./window-fixture.cjs');
// Real Settings renderer/main + disposable local storage. External work is held
// at the named IPC seam. Trusted Chromium input; no OS focus/permission calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, session } = require('electron');
const { prepareFixture, quitFixture } = require('./electron-fixture.cjs');
const profile = process.env.HERMES_TEST_PROFILE;
assert.ok(profile, 'Use test/run-electron.cjs for disposable storage.');
const boundaries = require('./settings-fixture-boundaries.cjs')();
prepareFixture(profile);
const bots = Array.from({ length: 9 }, (_, i) => ({ id: String(72000 + i), name: `Round two researcher ${i + 1} — a long independent settings identity`, username: `round2_${i + 1}_bot` }));
fs.writeFileSync(path.join(profile, 'preferences.json'), JSON.stringify({ onboarded: true, preview: false, bots, selectedBotId: bots[0].id, hidden: [], remoteUrl: '', macSshHost: 'local@fixture.invalid', vpsBrowser: { enabled: false, sshHost: 'agent@fixture.invalid' } }));
const seams = new Map(), calls = [];
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => handle(channel, channel === 'workspace:command' ? async (event, name, value) => {
  calls.push({ name, value });
  if (name === 'request-screen-permission') return {};
  if (seams.has(name)) return seams.get(name)(() => handler(event, name, value));
  return handler(event, name, value);
} : handler);
require('../src/main.cjs');
const out = process.env.SETTINGS_EVIDENCE_DIR ? path.resolve(process.env.SETTINGS_EVIDENCE_DIR) : path.resolve(__dirname, '../../evidence/quality/settings-round2');
fs.mkdirSync(out, { recursive: true });
const phase = process.env.SETTINGS_ASYNC_PHASE || 'green';
const results = [], observations = {};
let wc;
const pause = (ms = 25) => new Promise(resolve => setTimeout(resolve, ms));
async function wait(read, predicate = Boolean) {
  for (let n = 0; n < 180; n++) { const value = await read(); if (predicate(value)) return value; await pause(); }
  throw Error('Timed out waiting for Settings.');
}
app.whenReady().then(async () => {
  const win = await wait(() => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html')));
  wc = win.webContents;
  const js = code => wc.executeJavaScript(code);
  await wait(() => js('!!document.querySelector(".bot-open")').catch(() => false));
  wc.debugger.attach('1.3');
  await wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
  const frame = () => js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  const key = async (key, shift = false, extra = {}) => {
    const vk = { Tab: 9, Enter: 13, Escape: 27, Backspace: 8, End: 35, Home: 36, ArrowUp: 38, ArrowDown: 40, ' ': 32, a: 65 }[key];
    const params = { key, code: key === ' ' ? 'Space' : key === 'a' ? 'KeyA' : key, windowsVirtualKeyCode: vk, modifiers: shift ? 8 : 0, ...extra };
    await wc.debugger.sendCommand('Input.dispatchKeyEvent', { ...params, type: 'keyDown', ...(key === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : key === ' ' ? { text: ' ', unmodifiedText: ' ' } : {}) });
    await wc.debugger.sendCommand('Input.dispatchKeyEvent', { ...params, type: 'keyUp' });
    await pause(); await frame();
  };
  const click = async selector => {
    const point = await js(`(() => {const e=document.querySelector(${JSON.stringify(selector)});e?.scrollIntoView({block:'nearest'});const r=e?.getBoundingClientRect();if(!r?.width||!r.height)throw Error('Invisible target: '+${JSON.stringify(selector)});return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
    await pause(); await frame();
  };
  const active = () => js('({id:document.activeElement.id,tag:document.activeElement.tagName,bot:document.activeElement.dataset.botId,text:document.activeElement.textContent})');
  const body = () => js('document.getElementById("modal-body").innerText');
  const reach = async selector => {
    const summary = await js(`(() => { const details=document.querySelector(${JSON.stringify(selector)})?.closest('details'); return details&&!details.open?'#'+details.id+' > summary':null; })()`);
    if (summary) await click(summary);
    await click('#settings-search');
    for (let n = 0; n < 160; n++) {
      await key('Tab');
      if (await js(`document.activeElement===document.querySelector(${JSON.stringify(selector)})`)) return;
    }
    throw Error(`Unreachable: ${selector}`);
  };
  const search = async text => {
    await click('#settings-search'); await key('a', false, { modifiers: 4, commands: ['selectAll'] }); await key('Backspace');
    await wc.debugger.sendCommand('Input.insertText', { text }); await frame();
  };
  const open = async () => { await click(await js('document.getElementById("settings-button").getBoundingClientRect().width?"#settings-button":"#settings-fallback"')); };
  const reset = async () => {
    // Each case owns its address draft. Discard via the actual UI at the next
    // case boundary, since closing Settings now intentionally retains drafts.
    if (await js('!document.getElementById("modal").classList.contains("hidden")')) await click('#modal-close');
    await open(); await click('#settings-category-connections');
    if (await js('!!document.querySelector("#settings-agent-details input[data-dirty=true]")')) {
      await reach('#settings-discard-addresses'); await key('Enter');
    }
    await click('#modal-close'); await open();
  };
  const shot = async name => { await frame(); fs.writeFileSync(path.join(out, `${phase}-${name}.png`), (await wc.capturePage()).toPNG()); };
  const check = async (name, test) => {
    if (process.env.SETTINGS_ASYNC_CASE && !name.includes(process.env.SETTINGS_ASYNC_CASE)) return;
    try { await reset(); await test(); results.push({ name, pass: true }); console.log('PASS:', name); }
    catch (error) { results.push({ name, pass: false, error: error.stack }); console.error('FAIL:', name, error.message); await shot(`failure-${results.length}`); }
    finally { seams.clear(); }
  };
  const hold = name => {
    let release, entered = false;
    const pending = new Promise(resolve => { release = resolve; });
    seams.set(name, async real => { entered = true; const reply = await pending; if (reply.error) throw Error(reply.error); return reply.real ? real() : reply.result; });
    return { release, entered: () => entered };
  };
  const count = name => calls.filter(call => call.name === name).length;
  const geometry = (selector, statusSelector) => js(`(() => {
    const a=document.querySelector(${JSON.stringify(selector)}),s=document.querySelector(${JSON.stringify(statusSelector)}),p=document.getElementById('settings-content'),b=a.getBoundingClientRect(),r=s.getBoundingClientRect(),q=p.getBoundingClientRect(),css=getComputedStyle(a),ring=parseFloat(css.outlineWidth)+Math.max(0,parseFloat(css.outlineOffset));
    return {focused:a===document.activeElement,outline:parseFloat(css.outlineWidth),complete:b.top-ring>=q.top-1&&b.bottom+ring<=q.bottom+1&&b.left-ring>=q.left-1&&b.right+ring<=q.right+1,feedback:r.height>0&&r.top>=q.top&&r.bottom<=q.bottom};
  })()`);
  await resizeWindow(win, 1120, 680); await frame();
  await js('window.round2Input=[];for(const type of ["keydown","keyup","pointerdown"])document.addEventListener(type,e=>round2Input.push({type,key:e.key,trusted:e.isTrusted,target:e.target.id||e.target.dataset.botId||e.target.tagName}),true);true');
  await check('delayed path rejection retains the initiating keyboard action and adjacent retry context', async () => {
    await click('#settings-category-connections'); await reach('#settings-test-path');
    const gate = hold('test-agent-path'); await key('Enter'); await wait(gate.entered); await pause(130);
    const busy = await active(); await shot('path-pending');
    gate.release({ error: 'Round2 delayed path unavailable. Retry this check.' });
    await wait(body, text => text.includes('Round2 delayed path unavailable'));
    const after = await active(); await shot('path-rejection'); await key('Tab'); const next = await active();
    observations.pathRejection = { busy, after, next, seam: 'held test-agent-path IPC rejection; no SSH or gateway work' };
    assert.equal(busy.id, 'settings-test-path', 'Pending action retains focus');
    assert.equal(after.id, 'settings-test-path', 'Rejection leaves action focused for retry');
    assert.equal(next.id, 'settings-copy-setup-prompt', 'Tab continues beside the path action');
  });
  await check('failed cookie refresh replaces the previous successful empty claim with unknown state and retry', async () => {
    await search('cookies'); await wait(body, text => text.includes('No cookies stored.'));
    seams.set('list-cookies', async () => { throw Error('Round2 cookie read locked. Refresh to retry.'); });
    await reach('#settings-refresh-cookies'); await key('Enter'); await wait(body, text => text.includes('Round2 cookie read locked'));
    const text = await body(); observations.failedEmptyRefresh = text; await shot('cookie-failed-after-empty');
    assert.doesNotMatch(await js('document.getElementById("cookie-list").innerText'), /No cookies stored/);
    assert.equal(await js('document.getElementById("settings-refresh-cookies").disabled'), false);
  });
  await check('pending path success blocks repeated Enter and clicks while Tab and Shift+Tab keep their place', async () => {
    await search('agent setup'); await reach('#settings-test-path');
    const gate = hold('test-agent-path'), before = count('test-agent-path');
    await key('Enter'); await wait(gate.entered);
    await key('Enter'); await key('Enter'); await click('#settings-test-path'); await click('#settings-test-path');
    const busy = await active();
    await key('Tab'); assert.equal((await active()).id, 'settings-copy-setup-prompt');
    await key('Tab', true); assert.equal((await active()).id, 'settings-test-path');
    const box = await geometry('#settings-test-path', '[data-settings-section=agent-setup] .connection-check-status');
    await shot('path-busy-outline'); gate.release({ result: { ok: true, detail: 'Round2 external success fixture; no connection executed.' } });
    await wait(body, text => text.includes('Saved SSH path passed. Hermes authentication and bot setup were not checked.'));
    observations.busyActivation = { calls: count('test-agent-path') - before, busy, box, after: await active() };
    assert.equal(count('test-agent-path') - before, 1, 'Repeated activation must not dispatch again');
    assert.equal(busy.id, 'settings-test-path'); assert.deepEqual(box, { focused: true, outline: 2, complete: true, feedback: true });
    assert.equal((await active()).id, 'settings-test-path');
    await key('Tab', true); assert.equal((await active()).id, 'settings-setup-bot');
    await key('Tab'); assert.equal((await active()).id, 'settings-test-path');
  });
  await check('pending rejection respects a deliberate Shift+Tab move to the preceding action', async () => {
    await search('agent setup'); await reach('#settings-test-path'); const gate = hold('test-agent-path');
    await key('Enter'); await wait(gate.entered); await key('Tab', true);
    const moved = await active(); gate.release({ error: 'Round2 error after backward navigation.' });
    await wait(body, text => text.includes('Round2 error after backward navigation'));
    assert.equal(moved.id, 'settings-setup-bot'); assert.deepEqual(await active(), moved);
  });
  await check('completion respects a different editable field and keeps its unsaved draft', async () => {
    await click('#settings-category-connections'); await reach('#settings-test-path'); const gate = hold('test-agent-path');
    await key('Enter'); await wait(gate.entered); await reach('#mac-ssh-host');
    await js('document.getElementById("mac-ssh-host").select()');
    await wc.debugger.sendCommand('Input.insertText', { text: 'round2-draft@local.invalid' });
    gate.release({ result: { ok: true, detail: 'Round2 response after field movement.' } });
    await wait(body, text => text.includes('Addresses or bot changed. Check the saved path again.'));
    assert.equal((await active()).id, 'mac-ssh-host');
    assert.equal(await js('document.getElementById("mac-ssh-host").value'), 'round2-draft@local.invalid');
  });
  for (const failure of [false, true]) await check(`pending ${failure ? 'rejection' : 'success'} respects category and search transitions`, async () => {
    await search('agent setup'); await reach('#settings-test-path'); const gate = hold('test-agent-path');
    await key('Enter'); await wait(gate.entered); await click('#settings-category-general');
    await search('cookies'); const moved = await active();
    gate.release(failure ? { error: 'Round2 hidden path rejection.' } : { result: { ok: true, detail: 'Round2 hidden path success.' } });
    await pause(100); await frame();
    assert.deepEqual(await active(), moved); assert.equal(moved.id, 'settings-search');
    assert.equal(await js('document.getElementById("settings-search").value'), 'cookies');
    assert.doesNotMatch(await body(), /Round2 hidden path/);
  });
  await check('late path reply cannot focus over the shortcut dialog', async () => {
    await search('agent setup'); await reach('#settings-test-path'); const gate = hold('test-agent-path');
    await key('Enter'); await wait(gate.entered); await click('#settings-category-general'); await reach('#settings-shortcuts'); await key('Enter');
    assert.equal((await active()).id, 'shortcut-search'); gate.release({ error: 'Round2 path rejected under guide.' });
    await pause(100); await frame(); assert.equal((await active()).id, 'shortcut-search'); await shot('guide-pending-context');
    await key('Escape'); assert.equal((await active()).id, 'settings-shortcuts');
  });
  await check('late path reply cannot replace or focus over an extension detail dialog', async () => {
    await search('agent setup'); await reach('#settings-test-path'); const gate = hold('test-agent-path');
    await key('Enter'); await wait(gate.entered); await click('#settings-category-browser');
    await reach('[data-settings-section=extensions] button'); await key('Enter');
    const moved = await active(); gate.release({ result: { ok: true, detail: 'Round2 old detail response.' } });
    await pause(100); await frame(); assert.deepEqual(await active(), moved);
    assert.equal(await js('document.getElementById("modal-title").textContent'), 'Extensions'); assert.doesNotMatch(await body(), /Round2 old detail/);
    await click('.settings-detail-back'); assert.equal((await active()).id, 'settings-category-browser');
  });
  for (const failure of [false, true]) await check(`closed and reopened Settings ignore stale path ${failure ? 'rejection' : 'success'}`, async () => {
    await search('agent setup'); await reach('#settings-test-path'); const gate = hold('test-agent-path');
    await key('Enter'); await wait(gate.entered); await key('Escape'); await key('Escape'); await open(); await click('#settings-category-connections'); await reach('#remote-url');
    gate.release(failure ? { error: 'Round2 stale reopened error.' } : { result: { ok: true, detail: 'Round2 stale reopened result.' } });
    await pause(100); await frame(); assert.equal((await active()).id, 'remote-url'); assert.doesNotMatch(await body(), /Round2 stale reopened/);
  });
  await check('delayed visibility failure holds its switch, blocks repeat changes, and real retry persists with UI readback', async () => {
    const selector = 'input[data-bot-id="72008"]'; await search('bot visibility'); await reach(selector);
    const original = await js(`document.querySelector('${selector}').checked`), gate = hold('set-bot-visibility'), before = count('set-bot-visibility');
    await key(' '); await wait(gate.entered); await key(' '); await click(selector); await key(' ');
    const pendingValue = await js(`document.querySelector('${selector}').checked`), pendingFocus = await active();
    gate.release({ error: 'Round2 visibility save rejected; retry the switch.' });
    await wait(body, text => text.includes('Round2 visibility save rejected')); await shot('visibility-failure-outline');
    assert.equal(count('set-bot-visibility') - before, 1); assert.equal(pendingValue, !original); assert.equal(pendingFocus.bot, '72008');
    assert.equal(await js(`document.querySelector('${selector}').checked`), original); assert.equal((await active()).bot, '72008');
    seams.delete('set-bot-visibility'); await key(' ');
    await wait(() => js('workspace.getState()'), state => state.hidden.includes('72008') === original);
    assert.equal((await active()).bot, '72008', 'Real save retains focus on the stable replacement switch');
    await reset(); await search('bot visibility'); assert.equal(await js(`document.querySelector('${selector}').checked`), !original);
    assert.equal(JSON.parse(fs.readFileSync(path.join(profile, 'preferences.json'))).hidden.includes('72008'), original);
  });
  await check('visibility response held after real persistence stays busy through the state broadcast', async () => {
    const selector = 'input[data-bot-id="72000"]'; await search('bot visibility'); await reach(selector);
    const before = count('set-bot-visibility'); let entered = false, release;
    const pending = new Promise(resolve => { release = resolve; });
    seams.set('set-bot-visibility', async real => { const result = await real(); entered = true; await pending; return result; });
    await key(' '); await wait(() => entered); await frame();
    const busy = await js(`document.querySelector('${selector}').getAttribute('aria-busy')`);
    await key(' '); await click(selector); await pause(100); const dispatched = count('set-bot-visibility') - before;
    release(); await pause(100); await frame();
    observations.persistedVisibilityPending = { busy, dispatched, active: await active() };
    assert.equal(busy, 'true', 'State broadcasts preserve the pending control and feedback');
    assert.equal(dispatched, 1, 'The response is still pending after local persistence'); assert.equal((await active()).bot, '72000');
    assert.equal((await js('workspace.getState()')).hidden.includes('72000'), true);
  });
  await check('initial cookie failure differs from empty success and real recovery restores accurate local rows', async () => {
    seams.set('list-cookies', async () => { throw Error('Round2 initial cookie read rejected.'); }); await search('cookies');
    await wait(body, text => text.includes('Round2 initial cookie read rejected'));
    assert.match(await js('document.getElementById("cookie-list").innerText'), /unavailable/); assert.doesNotMatch(await body(), /No cookies stored/);
    seams.delete('list-cookies'); await reach('#settings-refresh-cookies'); await key('Enter'); await wait(body, text => text.includes('No cookies stored.'));
    assert.doesNotMatch(await body(), /Round2 initial cookie read rejected|unavailable/);
    await session.fromPartition('persist:browser').cookies.set({ url: 'https://round2-alpha.invalid', name: 'one', value: 'disposable' });
    await session.fromPartition('persist:browser').cookies.set({ url: 'https://round2-alpha.invalid', name: 'two', value: 'disposable' });
    await session.fromPartition('persist:browser').cookies.set({ url: 'http://round2-beta.invalid', name: 'one', value: 'disposable' });
    await key('Enter'); await wait(body, text => text.includes('round2-alpha.invalid'));
    assert.match(await body(), /round2-alpha\.invalid · 2 cookies/); assert.match(await body(), /round2-beta\.invalid · 1 cookie/); await shot('cookies-real-local-rows');
    seams.set('list-cookies', async () => { throw Error('Round2 read failed after nonempty data.'); }); await key('Enter'); await wait(body, text => text.includes('Round2 read failed after nonempty'));
    assert.doesNotMatch(await js('document.getElementById("cookie-list").innerText'), /round2-alpha|round2-beta|No cookies stored/);
    seams.delete('list-cookies'); await key('Enter'); await wait(body, text => text.includes('round2-alpha.invalid'));
    assert.doesNotMatch(await body(), /Round2 read failed|unavailable/);
  });
  await check('invalid cookie responses invalidate cached results and a later real refresh recovers', async () => {
    await search('cookies'); await wait(body, text => text.includes('round2-alpha.invalid')); await reach('#settings-refresh-cookies');
    for (const value of [{ invalid: true }, [{ domain: 'bad.invalid', count: 'unknown' }]]) {
      seams.set('list-cookies', async () => value); await key('Enter'); await wait(body, text => text.includes('Cookies could not be read'));
      assert.match(await js('document.getElementById("cookie-list").innerText'), /unavailable/);
      assert.doesNotMatch(await js('document.getElementById("cookie-list").innerText'), /round2-alpha|No cookies stored|bad.invalid/);
    }
    seams.delete('list-cookies'); await key('Enter'); await wait(body, text => text.includes('round2-alpha.invalid'));
  });
  await check('pending cookie reads block repeat refresh and clear dispatch while preserving Tab movement', async () => {
    await search('cookies'); await wait(body, text => text.includes('round2-alpha.invalid')); await reach('#settings-refresh-cookies');
    const gate = hold('list-cookies'), before = count('list-cookies'), clears = count('clear-cookies');
    await key('Enter'); await wait(gate.entered); await key('Enter'); await click('#settings-refresh-cookies'); await key('Tab');
    assert.equal((await active()).id, 'settings-clear-cookies'); await key('Enter'); await key('Tab', true);
    assert.equal((await active()).id, 'settings-refresh-cookies'); gate.release({ real: true }); await wait(() => js('!document.getElementById("settings-refresh-cookies").hasAttribute("aria-busy")'));
    assert.equal(count('list-cookies') - before, 1); assert.equal(count('clear-cookies'), clears);
    assert.equal((await active()).id, 'settings-refresh-cookies');
  });
  await check('real per-domain cookie clear uses a focused replacement and real readback, without stealing moved focus', async () => {
    await search('cookies'); await wait(body, text => text.includes('round2-alpha.invalid'));
    await reach('[aria-label="Clear cookies for round2-beta.invalid"]'); await key('Enter');
    await wait(body, text => !text.includes('round2-beta.invalid')); assert.equal((await active()).id, 'settings-refresh-cookies');
    assert.match(await body(), /round2-alpha.invalid/); assert.equal((await session.fromPartition('persist:browser').cookies.get({ domain: 'round2-beta.invalid' })).length, 0);
    await reach('[aria-label="Clear cookies for round2-alpha.invalid"]'); const gate = hold('clear-cookies'); await key('Enter'); await wait(gate.entered);
    await reach('#settings-refresh-cookies'); const moved = await active(); gate.release({ real: true });
    await wait(body, text => text.includes('No cookies stored.')); assert.deepEqual(await active(), moved);
    assert.deepEqual(await js('workspace.command("list-cookies")'), []); await shot('cookies-real-empty-after-clear');
  });
  await check('stale cookie read after close/reopen cannot overwrite the new successful empty read', async () => {
    const gate = hold('list-cookies'); await search('cookies'); await wait(gate.entered);
    await key('Escape'); await key('Escape'); seams.delete('list-cookies'); await open(); await search('cookies');
    await wait(body, text => text.includes('No cookies stored.')); const moved = await active();
    gate.release({ result: [{ domain: 'stale-cookie.invalid', count: 99 }] }); await pause(100); await frame();
    assert.deepEqual(await active(), moved); assert.match(await body(), /No cookies stored/); assert.doesNotMatch(await body(), /stale-cookie/);
  });
  for (const size of [[1280, 800], [1120, 680], [1024, 640]]) await check(`${size.join('x')}: pending/rejected action keeps a complete outline and adjacent feedback`, async () => {
    win.setMinimumSize(0, 0); await resizeWindow(win, ...size); await frame(); await click('#settings-category-connections'); await reach('#settings-test-path');
    const gate = hold('test-agent-path'); await key('Enter'); await wait(gate.entered);
    const busy = await geometry('#settings-test-path', '[data-settings-section=agent-setup] .connection-check-status');
    gate.release({ error: 'Round2 connection unavailable. Check the saved addresses, then retry this action.' });
    await wait(body, text => text.includes('Round2 connection unavailable'));
    const after = await geometry('#settings-test-path', '[data-settings-section=agent-setup] .connection-check-status');
    observations[size.join('x')] = { busy, after }; await shot(`async-outline-${size.join('x')}`);
    assert.deepEqual(busy, { focused: true, outline: 2, complete: true, feedback: true }); assert.deepEqual(after, busy);
  });
  await check('wizard ignores Connect A after editing its address to B without another click', async () => {
    await click('#modal-close');
    await js("workspace.command('cloud-diy')");
    await wait(() => js('!!document.getElementById("ob-diy-host")'));
    const address = async text => {
      await click('#ob-diy-host'); await key('a', false, { modifiers: 4, commands: ['selectAll'] });
      await wc.debugger.sendCommand('Input.insertText', { text }); await frame();
    };
    try {
      for (const reply of [{ result: { host: 'user@server-a.invalid', stage: 'done', ok: true, detail: 'Connected to server A.' } }, { error: 'Server A failed.' }]) {
        await address('user@server-a.invalid');
        const gate = hold('cloud-connect');
        await click('#onboarding .primary-button'); await wait(gate.entered);
        await address('user@server-b.invalid');
        await js('state = {...state, cloud: {...state.cloud, existingModel: {provider:"fixture",model:"model-a"}, modelDetected:true}}; renderOnboarding(true); true');
        assert.equal(await js('document.getElementById("ob-diy-host")?.value'), 'user@server-b.invalid', 'model metadata must preserve the address draft');
        const before = count('cloud-goto');
        gate.release(reply);
        await pause(150); await frame();
        assert.equal(await js('document.getElementById("ob-diy-host")?.value'), 'user@server-b.invalid');
        assert.doesNotMatch(await js('document.getElementById("onboarding").innerText'), /Connected to server A|Server A failed/);
        assert.doesNotMatch(await js('document.getElementById("toast").innerText'), /Server A failed/);
        assert.equal(count('cloud-goto'), before, 'an edited address cannot accept the old result');
      }
      seams.set('cloud-connect', async () => ({ host: 'user@server-b.invalid', stage: 'done', ok: true, detail: 'Connected to server B.' }));
      seams.set('cloud-model-detect', async () => ({ detail: '' }));
      await click('#onboarding .primary-button');
      await wait(() => calls.some(call => call.name === 'cloud-goto' && call.value.step === 'model'));
      await wait(() => js('!document.getElementById("ob-diy-host")'));
    } finally { await js("workspace.command('onboarding-done')"); }
  });
  observations.input = await js('round2Input');
  assert.ok(observations.input.length && observations.input.every(event => event.trusted));
  observations.native = { tested: false, reason: 'Trusted Chromium input only; zero OS focus or permission attempts.' };
  observations.boundaries = boundaries;
  observations.viewport = await js('[innerWidth,innerHeight]');
}).catch(error => { results.push({ name: 'fixture', pass: false, error: error.stack }); console.error(error); }).finally(() => {
  const fail = results.filter(result => !result.pass).length;
  fs.writeFileSync(path.join(out, `${phase}-results.json`), JSON.stringify({ pass: results.length - fail, fail, results, observations, calls }, null, 2));
  app.once('will-quit', () => app.exit(fail ? 1 : 0)); quitFixture();
});
