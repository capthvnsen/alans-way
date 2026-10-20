// Run: node test/run-electron.cjs test/keyboard-navigation-electron.cjs
// Real source app, isolated profile, fixture Telegram. No sign-in or messages.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, webContents } = require('electron');
const { prepareFixture, quitFixture } = require('./electron-fixture.cjs');
const profile = process.env.HERMES_TEST_PROFILE;
assert.ok(profile, 'Use test/run-electron.cjs for an isolated profile.');
prepareFixture(profile);
// Keep the ordinary fixture small, then reveal a dense list for redraw regressions.
const denseBots = Array.from({ length: 21 }, (_, index) => ({
  id: String(400 + index), isBot: true, username: `fixture_agent_${index + 1}_bot`,
  name: `Agent ${String(index + 1).padStart(2, '0')}${index % 4 === 0 ? ' — An extraordinarily long research and implementation companion across all desktop workspaces' : ''}`,
}));
fs.writeFileSync(path.join(profile, 'preferences.json'), JSON.stringify({ onboarded: true, preview: false, macSshHost: 'fixture@local.invalid',
  bots: [{ id: '101', name: 'Atlas', isBot: true }, { id: '202', name: 'Scout', isBot: true }, { id: '303', name: 'Writer', isBot: true }, ...denseBots],
  selectedBotId: '101', hidden: ['303', ...denseBots.map(bot => bot.id)], botSort: 'alpha' }));
require('../src/main.cjs');
const pause = () => new Promise(resolve => setTimeout(resolve, 35));
const waitFor = async (read, predicate = Boolean) => {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { const value = await read(); if (predicate(value)) return value; await pause(); }
  throw new Error('Timed out waiting for keyboard fixture state.');
};
app.whenReady().then(async () => {
  const win = await waitFor(() => BrowserWindow.getAllWindows()[0]);
  const wc = win.webContents, evaluate = code => wc.executeJavaScript(code);
  await waitFor(() => evaluate('!!document.querySelector(".bot-row")').catch(() => false));
  win.setSize(1440, 900); win.show(); win.focus(); wc.focus();
  wc.debugger.attach('1.3');
  const frame = () => evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
  const focus = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const key = async (keyCode, modifiers = []) => {
    const virtualKey = { Tab: 9, Enter: 13, Escape: 27, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46, ' ': 32 }[keyCode];
    const params = { key: keyCode, code: keyCode, windowsVirtualKeyCode: virtualKey, modifiers: modifiers.includes('shift') ? 8 : 0 };
    await wc.debugger.sendCommand('Input.dispatchKeyEvent', { ...params, type: 'keyDown', ...(keyCode === 'Enter' ? { text: '\r' } : keyCode === ' ' ? { text: ' ' } : {}) });
    await wc.debugger.sendCommand('Input.dispatchKeyEvent', { ...params, type: 'keyUp' });
    await pause();
  };
  const active = () => evaluate('document.activeElement.id || document.activeElement.className');
  const inside = id => evaluate(`document.getElementById(${JSON.stringify(id)}).contains(document.activeElement)`);
  const hidden = id => evaluate(`document.getElementById(${JSON.stringify(id)}).classList.contains('hidden')`);
  const invoke = (name, value = {}) => evaluate(`window.workspace.command(${JSON.stringify(name)}, ${JSON.stringify(value)})`);
  const getState = () => evaluate('window.workspace.getState()');
  const evidence = process.env.KEYBOARD_EVIDENCE;
  const evidenceDir = path.resolve(process.env.KEYBOARD_EVIDENCE_DIR || path.join(__dirname, '../../evidence/quality/keyboard'));
  if (evidence) fs.mkdirSync(evidenceDir, { recursive: true });
  await evaluate(`window.fixtureKeys = []; document.addEventListener('keydown', event => window.fixtureKeys.push({ key: event.key, trusted: event.isTrusted }), true)`);
  const shot = async name => {
    if (!evidence) return;
    await frame(); fs.writeFileSync(path.join(evidenceDir, `${evidence}-${name}.png`), (await wc.capturePage()).toPNG());
  };
  const failures = [], results = [], nativeFocus = [];
  const recordFocus = async phase => nativeFocus.push({ phase, window: win.isFocused(), focusedContents: webContents.getFocusedWebContents()?.id ?? null, shellContents: wc.id, document: await evaluate('document.hasFocus()') });
  await recordFocus('initial');
  const check = async (name, test) => {
    try { await test(); results.push({ name, pass: true }); console.log(`PASS: ${name}`); }
    catch (error) { failures.push(`${name}: ${error.message}`); results.push({ name, pass: false, error: error.message }); console.error(`FAIL: ${name}: ${error.message}`); await shot(`failure-${results.length}`); }
  };

  if (!process.env.KEYBOARD_FOCUS_ONLY) {
    await focus('#add-bot'); await key('Enter'); await frame();
    await check('dialog opens with its username field focused', async () => assert.equal(await active(), 'bot-username'));
    await shot('add-bot');
    await check('forward Tab wraps inside the dialog', async () => {
      await focus('#modal-body button[type=submit]'); await key('Tab'); assert.equal(await active(), 'modal-close');
    });
    await check('reverse Tab wraps inside the dialog', async () => {
      await focus('#modal-close'); await key('Tab', ['shift']); assert.equal(await active(), 'primary-button');
    });
    await check('background controls cannot take modal focus', async () => {
      await focus('#search-toggle'); assert.equal(await inside('modal'), true);
    });
    await focus('#bot-username'); await key('Escape');
    await check('Escape dismisses and restores the opener', async () => {
      assert.equal(await hidden('modal'), true); assert.equal(await active(), 'add-bot');
    });

    await focus('#settings-button'); await key('Enter'); await frame();
    await check('settings receives initial focus', async () => assert.equal(await inside('modal'), true));
    await check('Tab skips hidden and disabled dialog controls', async () => {
      await evaluate(`(() => {
        const body = document.getElementById('modal-body');
        for (const [id, style, disabled] of [['fixture-disabled', '', true], ['fixture-hidden', 'display:none', false], ['fixture-invisible', 'visibility:hidden', false]]) {
          const b = document.createElement('button'); b.id = id; b.style = style; b.disabled = disabled; body.append(b);
        }
        const last = document.createElement('button'); last.id = 'fixture-last'; last.textContent = 'Last action'; body.append(last); last.focus();
      })()`);
      await key('Tab'); assert.equal(await active(), 'modal-close');
      await key('Tab', ['shift']); assert.equal(await active(), 'fixture-last');
      for (let i = 0; i < 28; i++) { await key('Tab'); assert.equal(await inside('modal'), true); assert.doesNotMatch(await active(), /^fixture-(disabled|hidden|invisible)$/); }
    });
    await shot('settings-focus');
    await key('Escape');
    await check('settings restores its trigger', async () => assert.equal(await active(), 'settings-button'));
    await check('replacement dialog retains the original opener', async () => {
      await focus('#settings-button'); await key('Enter'); await frame();
      await focus('#settings-category-browser'); await key('Enter'); await frame();
      await focus('[data-settings-section=extensions] button'); await key('Enter'); await frame();
      assert.equal(await evaluate('document.getElementById("modal-title").textContent'), 'Extensions');
      assert.equal(await inside('modal'), true); await key('Escape'); assert.equal(await active(), 'settings-button');
    });
    await check('disabled opener gets a visible focus fallback', async () => {
      await focus('#add-bot'); await key('Enter'); await frame();
      await evaluate('document.getElementById("add-bot").disabled = true'); await key('Escape');
      assert.equal(await active(), 'settings-button'); await evaluate('document.getElementById("add-bot").disabled = false');
    });

    await focus('#search-toggle'); await key('Enter'); await wc.insertText('no-such-agent'); await frame();
    await shot('search-empty');
    await check('zero-result search explains and offers recovery', async () => {
      assert.equal(await evaluate('document.querySelectorAll(".bot-row").length'), 0);
      assert.equal(await hidden('bot-search-empty'), false);
      assert.match(await evaluate('document.getElementById("bot-search-empty").textContent'), /No agents found/);
      assert.equal(await evaluate('document.getElementById("bot-search-status").textContent'), 'No agents found.');
      await key('Tab'); assert.equal(await active(), 'bot-search-clear'); await key('Enter');
      assert.equal(await active(), 'bot-search'); assert.equal(await evaluate('document.getElementById("bot-search").value'), '');
      assert.equal(await evaluate('document.querySelectorAll(".bot-row").length'), 2);
    });
    // Recover independently if the preceding baseline assertion failed.
    await evaluate('document.getElementById("bot-search").value = "no-such-agent"; document.getElementById("bot-search").dispatchEvent(new Event("input"))');
    await focus('#bot-search'); await key('Escape');
    await check('first search Escape clears and keeps focus', async () => {
      assert.equal(await evaluate('document.getElementById("bot-search").value'), '');
      assert.equal(await active(), 'bot-search'); assert.equal(await hidden('bot-search'), false);
    });
    await key('Escape');
    await check('second search Escape collapses and restores toggle', async () => {
      assert.equal(await hidden('bot-search'), true); assert.equal(await active(), 'search-toggle');
      assert.equal(await evaluate('document.getElementById("search-toggle").getAttribute("aria-expanded")'), 'false');
    });
    if (!(await hidden('bot-search'))) await click('#search-toggle');

    await check('agent arrows move focus without opening Telegram', async () => {
      await focus('.bot-open, .bot-row[role=button]'); await key('ArrowDown');
      assert.equal(await evaluate('document.activeElement.closest(".bot-row")?.dataset.botId'), '202');
      assert.equal((await getState()).selectedBotId, '101');
      await key('Home'); assert.equal(await evaluate('document.activeElement.closest(".bot-row")?.dataset.botId'), '101');
      await key('End'); assert.equal(await evaluate('document.activeElement.closest(".bot-row")?.dataset.botId'), '202');
      await key('ArrowDown'); assert.equal(await evaluate('document.activeElement.closest(".bot-row")?.dataset.botId'), '101');
      assert.equal(await evaluate(`document.querySelectorAll('.bot-open[tabindex="0"]').length`), 1);
    });
    await check('agent focus survives a state render and exposes hide action', async () => {
      await focus('.bot-open, .bot-row[role=button]'); await invoke('settings', { showBots: true }); await frame();
      assert.equal(await evaluate('document.activeElement.closest(".bot-row")?.dataset.botId'), '101');
      assert.equal(await evaluate('getComputedStyle(document.querySelector(".bot-row .bot-hide")).display !== "none"'), true);
      await key('Tab'); assert.equal(await active(), 'bot-hide');
      await invoke('bot-sort', { mode: 'recent' }); await frame(); assert.equal(await active(), 'bot-hide');
      await invoke('bot-sort', { mode: 'alpha' }); await frame();
    });
    await check('Enter and Space activate agents without losing focus', async () => {
      await focus('.bot-open'); await key('ArrowDown'); await key('Enter');
      await waitFor(getState, state => state.selectedBotId === '202'); await frame();
      assert.equal(await evaluate('document.activeElement.closest(".bot-row")?.dataset.botId'), '202');
      assert.equal(await evaluate('document.activeElement.getAttribute("aria-current")'), 'true');
      await key('Home'); await key(' '); await waitFor(getState, state => state.selectedBotId === '101');
    });
    await check('keyboard hide does not also open that agent', async () => {
      await focus('.bot-open'); await key('ArrowDown'); await key('Tab'); await key('Enter'); await frame();
      assert.equal((await getState()).selectedBotId, '101');
      assert.equal(await evaluate('document.querySelectorAll(".bot-row").length'), 1);
      assert.equal(await active(), 'bot-hide');
      await invoke('set-bot-visibility', { id: '202', visible: true }); await frame();
    });

    const first = await invoke('create-tab'), second = await invoke('create-tab'); await frame(); wc.focus();
    await check('tab strip has a named tablist and one entry point', async () => {
      assert.equal(await evaluate('document.getElementById("tabs").getAttribute("role")'), 'tablist');
      assert.equal(await evaluate(`document.querySelectorAll('#tabs [role=tab][tabindex="0"]').length`), 1);
    });
    await check('tab arrows activate, preserve focus through render, and wrap', async () => {
      await focus('#tabs [role=tab][aria-selected=true]'); await key('ArrowLeft'); await frame();
      assert.equal((await getState()).browserTabId, first.id);
      assert.equal(await evaluate('document.activeElement.getAttribute("aria-selected")'), 'true');
      await key('ArrowLeft'); await frame();
      assert.equal((await getState()).browserTabId, second.id);
      await key('Home'); await frame(); assert.equal((await getState()).browserTabId, first.id);
      await key('End'); await frame(); assert.equal((await getState()).browserTabId, second.id);
    });
    await shot('navigation');
    await check('Delete closes the focused tab and focuses its neighbor', async () => {
      await focus('#tabs [role=tab][aria-selected=true]'); await key('Delete'); await frame();
      assert.equal((await getState()).tabs.length, 1);
      assert.equal(await evaluate('document.activeElement.getAttribute("role")'), 'tab');
      await key('Delete'); await frame(); assert.equal(await active(), 'new-tab');
    });

    // Busy update dialogs have no enabled buttons: focus must stay on the dialog itself.
    const originalSend = wc.send.bind(wc);
    wc.send = (channel, ...args) => { if (channel !== 'workspace:state') originalSend(channel, ...args); };
    const real = await evaluate('window.workspace.getState()');
    await focus('#update-all');
    originalSend('workspace:state', { ...real, updateAll: { busy: true, steps: [] } }); await frame();
    await check('busy dialog contains Tab even without enabled controls', async () => {
      assert.equal(await inside('update-all-popup'), true); await key('Tab'); assert.equal(await inside('update-all-popup'), true);
      await key('Tab', ['shift']); assert.equal(await inside('update-all-popup'), true);
      await key('Escape'); assert.equal(await hidden('update-all-popup'), false);
    });
    originalSend('workspace:state', real); await frame();
    await check('automatic dialog close restores focus', async () => assert.equal(await active(), 'update-all'));
    wc.send = originalSend;
  }

  const rowId = () => evaluate('document.activeElement.closest(".bot-row")?.dataset.botId');
  const geometry = () => evaluate(`(() => {
    const active = document.activeElement, rect = active.getBoundingClientRect(), style = getComputedStyle(active);
    // Include the outline in the clipping check, not just the button's box.
    const ring = parseFloat(style.outlineWidth) + Math.max(0, parseFloat(style.outlineOffset));
    const bounds = { left: rect.left - ring, top: rect.top - ring, right: rect.right + ring, bottom: rect.bottom + ring };
    let visible = rect.width > 0 && rect.height > 0 && bounds.left >= 0 && bounds.top >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight;
    for (let parent = active.parentElement; parent; parent = parent.parentElement) {
      const css = getComputedStyle(parent);
      if (/auto|scroll|hidden|clip/.test(css.overflowX + ' ' + css.overflowY) || parent.matches('.sidebar')) {
        const clip = parent.getBoundingClientRect();
        if (bounds.left < clip.left || bounds.top < clip.top || bounds.right > clip.right || bounds.bottom > clip.bottom) visible = false;
      }
    }
    return { visible, enabled: !active.matches(':disabled'), ring: active.matches(':focus-visible') && style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0,
      id: active.id, className: active.className, bot: active.closest('.bot-row')?.dataset.botId,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, scroll: document.getElementById('bot-list').scrollTop };
  })()`);
  const expectVisible = async label => {
    const value = await geometry();
    if (evidence) fs.writeFileSync(path.join(evidenceDir, `${evidence}-${label}.json`), JSON.stringify(value, null, 2));
    assert.equal(value.enabled && value.visible && value.ring, true, JSON.stringify(value));
  };
  const reveal = async () => {
    await focus('#search-toggle');
    if (!(await hidden('bot-search'))) await key('Enter');
    await evaluate(`document.getElementById('bot-search').value = ''; document.getElementById('bot-search').dispatchEvent(new Event('input'))`);
    for (const id of ['101', '202', '303']) await invoke('set-bot-visibility', { id, visible: false });
    for (const bot of denseBots) await invoke('set-bot-visibility', { id: bot.id, visible: true });
    await invoke('bot-sort', { mode: 'alpha' }); await frame(); wc.focus();
    assert.equal(await evaluate('document.querySelectorAll(".bot-row").length'), 21);
  };
  const hideFocused = async id => {
    await key('Tab'); assert.equal(await active(), 'bot-hide'); assert.equal(await rowId(), id);
    await key('Enter'); await waitFor(getState, value => value.hidden.includes(id)); await frame();
  };
  await evaluate(`window.fixtureActions = []; document.getElementById('bot-list').addEventListener('click', event => {
    const button = event.target.closest('.bot-open, .bot-hide'); if (button) window.fixtureActions.push({ action: button.className, id: button.closest('.bot-row').dataset.botId, trusted: event.isTrusted });
  }, true)`);
  for (const [width, height] of [[1280, 800], [1024, 640]]) {
    win.setMinimumSize(0, 0); win.setContentSize(width, height); await frame();
    await check(`${width}: actual viewport`, async () => assert.deepEqual(await evaluate('[innerWidth, innerHeight]'), [width, height]));
    await reveal(); await recordFocus(`${width}-dense`);
    await check(`${width}: final Hide keeps previous neighbor visible and selection unchanged`, async () => {
      // Enter the list by Tab, then reproduce End / Space / Tab / Enter.
      await focus('#sort-bots'); await key('Tab'); assert.equal(await active(), 'bot-open');
      await key('End'); assert.equal(await rowId(), '420'); await key(' ');
      await waitFor(getState, value => value.selectedBotId === '420'); await frame();
      await evaluate('window.fixtureActions = []'); await hideFocused('420');
      await expectVisible(`${width}-final-hide`);
      assert.equal(await rowId(), '419'); assert.equal(await active(), 'bot-hide');
      assert.equal((await getState()).selectedBotId, '420');
      assert.deepEqual(await evaluate('window.fixtureActions'), [{ action: 'bot-hide', id: '420', trusted: true }]);
      await shot(`${width}-final-hide`);
      await key('Tab', ['shift']); assert.equal(await rowId(), '419'); assert.equal(await active(), 'bot-open');
      await key('Enter'); await waitFor(getState, value => value.selectedBotId === '419'); await frame();
      await key('Tab'); assert.equal(await active(), 'bot-hide'); await key('Tab');
      assert.equal(await active(), 'hermes-connect-row'); await key('Tab', ['shift']);
      // Hide is disclosed by focus-within; reverse entry returns through Open.
      assert.equal(await rowId(), '419'); assert.equal(await active(), 'bot-open');
      await key('Tab'); assert.equal(await active(), 'bot-hide'); await expectVisible(`${width}-tab-return`);
    });
    await reveal();
    await check(`${width}: middle Hide keeps next neighbor and subsequent Enter hides only that neighbor`, async () => {
      await focus('#sort-bots'); await key('Tab'); await key('End'); for (let index = 0; index < 10; index++) await key('ArrowUp'); assert.equal(await rowId(), '410');
      const selected = (await getState()).selectedBotId; await evaluate('window.fixtureActions = []'); await hideFocused('410');
      assert.equal(await rowId(), '411'); assert.equal(await active(), 'bot-hide');
      assert.equal((await getState()).selectedBotId, selected); await expectVisible(`${width}-middle-hide`); await shot(`${width}-middle-hide`);
      await key('Tab', ['shift']); assert.equal(await active(), 'bot-open'); assert.equal(await rowId(), '411');
      await key('Tab'); await key('Enter'); await waitFor(getState, value => value.hidden.includes('411')); await frame();
      assert.equal(await rowId(), '412'); assert.equal(await active(), 'bot-hide'); await expectVisible(`${width}-second-hide`);
      assert.deepEqual(await evaluate('window.fixtureActions'), [{ action: 'bot-hide', id: '410', trusted: true }, { action: 'bot-hide', id: '411', trusted: true }]);
      assert.equal((await getState()).selectedBotId, selected);
    });
    await reveal();
    await check(`${width}: sort and state redraw reveal the same focused long-name control`, async () => {
      await invoke('bot-sort', { mode: 'manual' });
      await invoke('sort-bots', { ids: denseBots.map(bot => bot.id).reverse() }); await frame();
      await focus('#sort-bots'); await key('Tab'); await key('End'); assert.equal(await rowId(), '400'); await key('Tab');
      const selected = (await getState()).selectedBotId;
      await invoke('bot-sort', { mode: 'alpha' }); await frame();
      assert.equal(await rowId(), '400'); assert.equal(await active(), 'bot-hide'); await expectVisible(`${width}-sort-hide`);
      await invoke('settings', { showBots: true }); await frame(); assert.equal(await rowId(), '400');
      await key('Tab', ['shift']); assert.equal(await active(), 'bot-open');
      assert.equal(await evaluate('document.activeElement.getAttribute("aria-label")'), `Open ${denseBots[0].name}`);
      await expectVisible(`${width}-long-name-open`); assert.equal((await getState()).selectedBotId, selected);
    });
    await check(`${width}: filtering a focused row out picks the surviving result without selecting it`, async () => {
      // A filter redraw arriving while a row owns focus must capture it before hiding the list.
      await evaluate(`document.getElementById('bot-search').value = 'Agent 21'; document.getElementById('bot-search').dispatchEvent(new Event('input'))`); await frame();
      assert.equal(await rowId(), '420'); assert.equal(await active(), 'bot-open'); await expectVisible(`${width}-filter-redraw`);
    });
    await check(`${width}: only filtered Hide returns to search and clear recovers results`, async () => {
      await focus('#search-toggle'); await key('Enter'); await focus('#bot-search'); await key('ArrowDown'); assert.equal(await rowId(), '420');
      const selected = (await getState()).selectedBotId; await hideFocused('420');
      assert.equal(await active(), 'bot-search'); assert.equal((await getState()).selectedBotId, selected); await expectVisible(`${width}-filtered-empty`);
      await key('Tab'); assert.equal(await active(), 'bot-search-clear'); await key('Enter');
      assert.equal(await active(), 'bot-search'); assert.equal(await evaluate('document.querySelectorAll(".bot-row").length'), 20);
      await wc.insertText('preserved draft'); await invoke('bot-sort', { mode: 'recent' }); await frame();
      assert.equal(await active(), 'bot-search'); assert.equal(await evaluate('document.getElementById("bot-search").value'), 'preserved draft');
      await key('Escape'); await key('Escape');
    });
    await reveal();
    await check(`${width}: final remaining visible agent returns to search toggle`, async () => {
      await focus('#sort-bots');
      for (const bot of denseBots.slice(0, -1)) await invoke('set-bot-visibility', { id: bot.id, visible: false });
      await frame(); await key('Tab'); assert.equal(await rowId(), '420'); const selected = (await getState()).selectedBotId;
      await hideFocused('420'); assert.equal(await active(), 'search-toggle'); await expectVisible(`${width}-all-hidden`);
      assert.equal((await getState()).selectedBotId, selected); await key('Tab'); assert.equal(await active(), 'add-bot');
      await key('Tab', ['shift']); assert.equal(await active(), 'search-toggle'); await key('Enter'); assert.equal(await active(), 'bot-search');
      await key('Escape');
    });
  }
  await check('all regression keys are trusted Chromium input', async () => {
    const keys = await evaluate('window.fixtureKeys'); assert.ok(keys.length > 50); assert.ok(keys.every(value => value.trusted));
  });
  if (evidence) fs.writeFileSync(path.join(evidenceDir, `${evidence}-results.json`), JSON.stringify({ results, pass: results.filter(value => value.pass).length, fail: failures.length, failures, nativeFocus, keys: await evaluate('window.fixtureKeys') }, null, 2));
  assert.deepEqual(failures, [], 'Keyboard interaction regressions');
  quitFixture();
}).catch(error => { console.error(error.stack); app.exit(1); });
