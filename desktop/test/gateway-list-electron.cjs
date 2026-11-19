// The agent list grouped by gateway (Telegram, Hermes, Alan's Way) and one inbox, end to end: real main,
// preload and renderer with two fake Telegram bots, a local stand-in Hermes Webapp and the native chat mock.
// Three launches share one throwaway profile: the grouped list and switching, a relaunch (with an old
// preference that names no gateway), then zero Telegram bots.
// Run: npm run test:gateway-list
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const KEY = 'mock-key-0000000000000001';

if (!process.versions.electron) {
  const http = require('node:http');
  const { spawn } = require('node:child_process');
  const { createMock } = require('./native-chat-mock.cjs');
  (async () => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-list-electron-'));
    const mock = await createMock({ key: KEY }).listen();
    const webapp = http.createServer((req, res) => {
      if (req.url === '/api/status') { res.setHeader('Content-Type', 'application/json'); return res.end('{"version":"0.23.0"}'); }
      res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Webapp fixture</title><main>Webapp</main>');
    });
    await new Promise((resolve) => webapp.listen(0, 'localhost', resolve));
    let failed = false;
    for (const phase of ['1', '2', '3']) {
      if (phase === '2') {
        const file = path.join(profile, 'preferences.json'), prefs = JSON.parse(fs.readFileSync(file, 'utf8'));
        fs.writeFileSync(file, JSON.stringify({ ...prefs, chatSurfaces: { ...prefs.chatSurfaces, 1002: 'pill-toggle-leftover' } }));
      }
      if (phase === '3') {
        const file = path.join(profile, 'preferences.json'), prefs = JSON.parse(fs.readFileSync(file, 'utf8'));
        fs.writeFileSync(file, JSON.stringify({ ...prefs, bots: [], order: [], selectedBotId: '' }));
      }
      const code = await new Promise((resolve) => {
        const child = spawn(require('electron'), [`--user-data-dir=${profile}`, __filename], { stdio: 'inherit',
          env: { ...process.env, HERMES_TEST_PROFILE: profile, GATEWAY_PHASE: phase, NATIVE_CHAT_URL: mock.url, WEBAPP_URL: `http://localhost:${webapp.address().port}/` } });
        const deadline = setTimeout(() => { console.error(`Phase ${phase} exceeded 150s.`); child.kill('SIGKILL'); }, 150000);
        child.once('close', (exit, signal) => { clearTimeout(deadline); resolve(signal ? 1 : exit); });
      });
      if (code !== 0) { failed = true; break; }
    }
    mock.close(); webapp.closeAllConnections(); webapp.close();
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    console.log(failed ? 'gateway list: FAILED' : 'gateway list: ok');
    process.exit(failed ? 1 : 0);
  })();
} else {
  const assert = require('node:assert/strict');
  const { app, BrowserWindow, Notification, webContents, session } = require('electron');
  const { prepareFixture, quitFixture } = require('./electron-fixture.cjs');
  const profile = process.env.HERMES_TEST_PROFILE, phase = process.env.GATEWAY_PHASE;
  prepareFixture(profile);
  const prefsFile = path.join(profile, 'preferences.json');
  if (phase === '1') fs.writeFileSync(prefsFile, JSON.stringify({ onboarded: true, preview: false, hermesWebappUrl: process.env.WEBAPP_URL,
    bots: [{ id: '1001', isBot: true, name: 'Alan', username: 'alan_bot' }, { id: '1002', isBot: true, name: 'Scout Research Assistant' }], selectedBotId: '1001' }));
  // Notifications are recorded instead of shown.
  const shown = [];
  Notification.prototype.show = function show() { shown.push({ title: this.title, body: this.body }); };
  const until = async (read, why, ms = 20000) => {
    const end = Date.now() + ms;
    for (;;) {
      const value = await read();
      if (value) return value;
      if (Date.now() > end) throw new Error(`Timed out: ${why}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  require('../src/main.cjs');

  (async () => {
    const win = await until(() => BrowserWindow.getAllWindows()[0], 'workspace window');
    const shell = win.webContents;
    shell.setBackgroundThrottling(false);
    win.show();
    await until(() => !shell.isLoading() && shell.getURL().endsWith('index.html'), 'workspace page');
    const run = (expression) => shell.executeJavaScript(expression);
    const state = () => run('workspace.getState()');
    const native = () => run('nativeChat.getState()');
    const saved = () => JSON.parse(fs.readFileSync(prefsFile, 'utf8'));
    // The list as [gateway, bot ids]; rows other than the selected one carry no star.
    const sections = () => run(`[...document.querySelectorAll('#bot-list .gateway-section')].map(s => s.querySelector('.gateway-logo').dataset.gateway + ':' + [...s.querySelectorAll('.bot-row')].map(r => r.dataset.botId + (r.classList.contains('selected') ? '*' : '')).join('+')).join(' ')`);
    const selectedRows = () => run(`[...document.querySelectorAll('#bot-list .bot-row.selected')].map(r => r.dataset.botId + '@' + r.dataset.gateway)`);
    const showing = (surface, id) => until(async () => (await state()).chatTarget === { telegram: 'telegram', 'hermes-desktop': 'webapp', native: 'native' }[surface]
      && (await selectedRows()).length === 1 && (!id || (await selectedRows())[0] === `${id}@${surface}`), `${surface} showing`);
    // A click on a row opens that bot on that row's gateway.
    const go = async (id, surface) => { await run(`document.querySelector('${row(id, surface)}').click()`); await until(async () => (await state()).chatBotId === id, `bot ${id}`); await showing(surface, id); };
    const row = (id, surface = 'telegram') => `#bot-list .bot-row[data-bot-id="${id}"][data-gateway="${surface}"]`;
    const has = (selector) => run(`!!document.querySelector(${JSON.stringify(selector)})`);
    const scroller = '#native-pane .nc-scroll';
    const scrollTop = () => run(`document.querySelector('${scroller}').scrollTop`);
    const atBottom = () => run(`(() => { const s = document.querySelector('${scroller}'); return s.scrollHeight - s.scrollTop - s.clientHeight < 2; })()`);
    const topRow = () => run(`(() => { const s = document.querySelector('${scroller}'), edge = s.getBoundingClientRect().top; const row = [...s.querySelectorAll('.nc-list > .nc-row[data-id]')].find(r => r.getBoundingClientRect().bottom > edge); return row && [row.dataset.id, Math.round(row.getBoundingClientRect().top - edge)]; })()`);
    const draft = () => run(`document.querySelector('#native-pane textarea').value`);
    const streamDelay = (ms) => fetch(`${process.env.NATIVE_CHAT_URL}/__stream-delay?ms=${ms}`);
    const type = (text, enter) => run(`(() => { const box = document.querySelector('#native-pane textarea'); box.value = ${JSON.stringify(text)}; box.dispatchEvent(new Event('input')); ${enter ? `box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));` : ''} })()`);
    const openSession = async (title) => {
      const id = (await native()).sessions.find((s) => s.title === title).id;
      await run(`document.querySelector('#native-pane .nc-switch').click()`);
      await until(() => has(`#native-pane .nc-menu-item[data-id="${id}"]`), `menu item ${title}`);
      await run(`document.querySelector('#native-pane .nc-menu-item[data-id="${id}"]').click()`);
      await until(async () => (await native()).activeId === id, `active ${title}`);
      return id;
    };

    if (phase === '1') {
      // Only the gateways that are set up get a section: Telegram and Hermes now, no Alan's Way section yet, and no empty header.
      await until(async () => (await sections()).replace(/\*/g, '') === 'telegram:1001+1002 hermes-desktop:1001+1002', 'Telegram and Hermes sections');
      assert.equal(await run(`document.querySelectorAll('#bot-list .gateway-section').length`), 2);
      await run(`workspace.command('settings', { nativeChatUrl: ${JSON.stringify(process.env.NATIVE_CHAT_URL)}, nativeChatKey: ${JSON.stringify(KEY)} })`);
      // Three gateways, in order, each header a logo with only an accessible name; each bot is on all three; two bots, six rows.
      await until(async () => (await sections()).replace(/\*/g, '') === 'telegram:1001+1002 hermes-desktop:1001+1002 native:1001+1002', 'three sections');
      assert.deepEqual(await run(`[...document.querySelectorAll('#bot-list .gateway-head')].map(h => [h.textContent.trim(), h.querySelector('[role=img]').getAttribute('aria-label'), h.querySelector('[role=img]').title])`), [['', 'Telegram', 'Telegram'], ['', 'Hermes', 'Hermes'], ['', 'Alan\'s Way', 'Alan\'s Way']]);
      assert.deepEqual(await run(`[...document.querySelectorAll('#bot-list .gateway-section')].map(s => [s.getAttribute('role'), document.getElementById(s.getAttribute('aria-labelledby')).textContent.trim() === '' && s.querySelector('[role=img]').getAttribute('aria-label')])`), [['group', 'Telegram'], ['group', 'Hermes'], ['group', 'Alan\'s Way']]);
      assert.equal(await run(`document.getElementById('bot-list').getAttribute('aria-label')`), 'Your agents (2)', 'the count is bots, not rows, and only in the list name');
      // The sidebar header: one line beside the window buttons, a search field that is always there, no label or count.
      assert.deepEqual(await run(`(() => { const t = document.querySelector('.side-title'), s = document.getElementById('bots-toggle'), top = document.querySelector('.side-top').getBoundingClientRect(), r = t.getBoundingClientRect(), b = s.getBoundingClientRect(); return [t.textContent, Math.round(r.height) <= 20, r.left >= b.right, r.bottom <= top.bottom, getComputedStyle(t.querySelector('b')).fontWeight > getComputedStyle(t).fontWeight]; })()`), ['Alan\'s Workspace', true, true, true, true], 'title on one line, right of the toggle, first word heavier');
      assert.equal(await run(`getComputedStyle(document.querySelector('.side-top')).webkitAppRegion + ' ' + getComputedStyle(document.getElementById('bots-toggle')).webkitAppRegion`), 'drag no-drag', 'the top row drags except on its button');
      assert.equal(await run(`getComputedStyle(document.getElementById('bot-search')).display !== 'none' && document.getElementById('bot-search').getBoundingClientRect().width > 60 && document.getElementById('bot-search').placeholder`), 'Search', 'the search field is always visible');
      assert.equal(await run(`document.getElementById('search-toggle')`), null, 'no search toggle');
      assert.equal(await run(`['bot-count', 'sort-bots', 'add-bot'].map((id) => !!document.getElementById(id)).join()`), 'false,true,true');
      assert.equal(await run(`/YOUR AGENTS/.test(document.querySelector(".sidebar").textContent)`), false, 'no YOUR AGENTS label');
      assert.equal(await run(`/Activity unavailable/.test(document.getElementById('bot-list').textContent) || !!document.querySelector('.bot-activity:not(.hidden):empty')`), false, 'unknown activity takes no line');
      assert.equal(await run(`getComputedStyle(document.querySelector('#bot-list .bot-row.selected')).backgroundColor !== 'rgba(0, 0, 0, 0)' && getComputedStyle(document.querySelector('#bot-list .bot-row:not(.selected)')).backgroundColor === 'rgba(0, 0, 0, 0)'`), true, 'the open row is a card, the others are flat');
      assert.equal(await run(`document.querySelectorAll('#bot-list .bot-row').length`), 6);
      assert.equal((await selectedRows()).length, 1, 'exactly one row is selected');
      assert.equal(await run(`document.getElementById('surface-tabs')`), null, 'no pill toggle in the chat header');
      assert.equal(await run(`document.getElementById('bot-list').textContent.includes('Telegram bot')`), false, 'no row claims to be a Telegram bot');
      // Search filters rows in every section; the count stays; sorting is within each section.
      await run(`(() => { const i = document.getElementById('bot-search'); i.value = 'scout'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await until(async () => (await sections()).replace(/\*/g, '') === 'telegram:1002 hermes-desktop:1002 native:1002', 'search across sections');
      assert.equal(await run(`document.getElementById('bot-list').getAttribute('aria-label')`), 'Your agents (2)');
      await run(`document.getElementById('bot-search-clear').click()`);
      await until(async () => (await sections()).replace(/\*/g, '') === 'telegram:1001+1002 hermes-desktop:1001+1002 native:1001+1002', 'search cleared');
      // An unsaved address in Settings, Chat surface survives Escape without being saved.
      const openSettings = async () => { await run(`document.getElementById('settings-fallback').click()`); await until(() => run(`!document.getElementById('modal').classList.contains('hidden') && !!document.getElementById('settings-native-url')`), 'chat surface settings'); };
      await openSettings();
      await run(`(() => { const i = document.getElementById('settings-native-url'); i.focus(); i.value = 'http://127.0.0.1:1'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      for (const type of ['keyDown', 'keyUp']) shell.sendInputEvent({ type, keyCode: 'Escape' });
      await until(() => run(`document.getElementById('modal').classList.contains('hidden')`), 'settings closed by Escape');
      await openSettings();
      assert.equal(await run(`document.getElementById('settings-native-url').value`), 'http://127.0.0.1:1', 'an unsaved address survives closing Settings');
      assert.equal((await state()).nativeChat.address, process.env.NATIVE_CHAT_URL, 'and is not saved');
      await run(`document.getElementById('modal-close').click()`);
      assert.equal(await run(`(() => { const xs = [...document.querySelectorAll('.chat-header button, .chat-header [tabindex="0"]')].filter(n => n.offsetParent && n.tabIndex >= 0).map(n => n.getBoundingClientRect().left); return xs.every((x, i) => !i || x >= xs[i - 1]); })()`), true, 'header tab order follows the screen');
      assert.equal(await run(`[...document.querySelectorAll('#bot-list .avatar')].every(a => getComputedStyle(a).backgroundColor !== 'rgba(0, 0, 0, 0)')`), true, 'a bot without a picture shows its initials on a colour');
      await showing('hermes-desktop');
      const webappView = await until(() => webContents.getAllWebContents().find((c) => c.session === session.fromPartition('persist:hermes-webapp') && !c.isDestroyed()), 'webapp view');
      const telegramView = webContents.getAllWebContents().find((c) => c.session === session.fromPartition('persist:telegram'));
      await until(() => !webappView.isLoading() && webappView.getURL().startsWith(process.env.WEBAPP_URL), 'webapp page');
      await webappView.executeJavaScript('window.kept = "webapp"');
      await telegramView.executeJavaScript('window.kept = "telegram"');

      // Bot A on Alan's Way: Arrow keys cross sections one row at a time; Enter on a row opens that gateway; the newest Telegram-source conversation opens read-only.
      await run(`document.querySelector('${row('1001', 'hermes-desktop')} .bot-open').focus(); document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))`);
      assert.equal(await run(`document.activeElement.closest('.bot-row').dataset.botId + '@' + document.activeElement.closest('.bot-row').dataset.gateway`), '1002@hermes-desktop');
      await run(`document.querySelector('${row('1001', 'native')} .bot-open').focus(); document.activeElement.click()`);
      await showing('native', '1001');
      assert.equal(await run(`document.querySelectorAll('#bot-list .bot-open[tabindex="0"]').length`), 1, 'roving tab stop');
      await until(async () => (await native()).thread?.source === 'telegram', 'telegram-source conversation');
      await until(() => has('#native-pane .nc-readonly:not(.hidden)'), 'read-only with Continue here');
      await until(() => saved().chatSurfaces?.['1001'] === 'native', 'A choice saved');

      // Bot B: Hermes Desktop.
      await go('1002', 'hermes-desktop');
      await until(() => saved().chatSurfaces?.['1002'] === 'hermes-desktop', 'B choice saved');
      const apart = () => run(`(() => { const [t, p] = ['bots-show', 'chat-pill'].map(id => document.getElementById(id).getBoundingClientRect()); return t.right <= p.left; })()`);
      assert.equal(await run(`getComputedStyle(document.getElementById('bots-show')).display`), 'none', 'the chat header has no toggle while the agent list shows');
      await run(`document.getElementById('bots-toggle').click()`); await until(() => run(`document.getElementById('shell').classList.contains('bots-hidden')`), 'agent list hidden');
      assert.equal(await apart(), true, 'a long bot name keeps the header pieces apart with the agent list hidden');
      await run(`document.getElementById('bots-show').click()`); await until(async () => !(await run(`document.getElementById('shell').classList.contains('bots-hidden')`)), 'agent list back');
      for (let i = 0; i < 2; i++) {
        await go('1001', 'native');
        await go('1002', 'hermes-desktop');
      }
      assert.equal(await webappView.executeJavaScript('window.kept'), 'webapp', 'webapp view kept alive');
      assert.equal(await telegramView.executeJavaScript('window.kept'), 'telegram', 'telegram view kept alive');

      // A's own conversation: a draft and a scroll position survive switching bots.
      await go('1001', 'native');
      const bigId = await openSession('seed 1k');
      await until(() => saved().nativeSessions?.['1001'] === bigId, 'A conversation remembered');
      await until(() => run(`document.querySelectorAll('#native-pane .nc-list > .nc-row').length >= 60`), 'thread painted');
      await type('half-written thought');
      await run(`document.querySelector('${scroller}').scrollTop = 4000`);
      await sleep(150);
      const anchor = await topRow(), sameView = (back) => back[0] === anchor[0] && Math.abs(back[1] - anchor[1]) < 4;
      assert.ok(await scrollTop() > 1000 && !(await atBottom()), 'scrolled into the thread');
      await go('1002', 'hermes-desktop');
      await go('1001', 'native');
      await sleep(150);
      assert.equal(await draft(), 'half-written thought', 'draft kept');
      // The message at the top of the view, not scrollTop: rows above it may paint at full height meanwhile.
      assert.ok(sameView(await topRow()), `scroll restored (${anchor} vs ${await topRow()})`);
      await openSession('pong: CLARIFY please');
      await openSession('seed 1k');
      await sleep(150);
      assert.equal(await draft(), 'half-written thought', 'draft kept per conversation');
      assert.ok(sameView(await topRow()), `scroll restored per conversation (${anchor} vs ${await topRow()})`);
      await run(`(() => { const s = document.querySelector('${scroller}'); s.scrollTop = s.scrollHeight; })()`);
      await sleep(150);
      assert.ok(await atBottom(), 'pinned to the bottom');
      await go('1002', 'hermes-desktop');
      await go('1001', 'native');
      await sleep(150);
      assert.ok(await atBottom(), 'pinned stays pinned');

      // A slow turn keeps streaming while another bot is open; finishing there marks A unread.
      await streamDelay(1500);
      await type('hello world', true);
      await until(async () => (await native()).run, 'turn started');
      await go('1002', 'hermes-desktop');
      assert.ok((await native()).run, 'still running in the background');
      await until(async () => !(await native()).run, 'turn finished in the background', 30000);
      await until(() => has(`${row('1001', 'native')} .unread`), 'A row unread');
      assert.equal((await state()).inbox['1001'].rows.native.preview, 'pong: hello world', 'row previews the native reply');
      assert.equal(await has(`${row('1001')} .unread`), false, 'native unread is not Telegram unread');
      assert.equal(await run(`document.querySelector('${row('1001')} .bot-preview').textContent`), '@alan_bot', 'the Telegram row keeps its own line');
      await until(async () => (await run(`document.querySelector('${row('1001', 'native')} .bot-preview').textContent`)) === 'pong: hello world', 'preview line');
      await go('1001', 'native');
      await until(async () => !(await has(`${row('1001', 'native')} .unread`)), 'opening native clears unread');

      // An approval request while away: waiting badge, its label, one notification.
      await type('APPROVE please', true);
      await until(async () => (await native()).run, 'approval turn started');
      await go('1002', 'hermes-desktop');
      await until(() => has(`${row('1001', 'native')} .waiting-badge`), 'waiting badge', 30000);
      assert.match(await run(`document.querySelector('${row('1001', 'native')} .bot-open').getAttribute('aria-label')`), /waiting for you$/);
      assert.equal(await has(`#bot-list [data-bot-id="1002"] .waiting-badge`), false);
      assert.equal(await has(`${row('1001')} .waiting-badge`), false, 'waiting on a native approval is not waiting on Telegram');
      await sleep(600);
      assert.deepEqual(shown, [{ title: 'Alan', body: 'is waiting for you' }], 'one notification per waiting episode');
      await go('1001', 'native');
      await until(() => has('#native-pane .nc-prompt.approval.open'), 'approval card');
      await run(`[...document.querySelectorAll('#native-pane .nc-prompt.approval button')].find(b => b.textContent === 'Allow once').click()`);
      await until(async () => !(await has(`${row('1001', 'native')} .waiting-badge`)), 'waiting cleared');
      await streamDelay(0);
      await until(async () => !(await native()).run, 'approval turn finished', 30000);

      const small = await run(`[...document.querySelectorAll('#bot-list *, .chat-header *, #native-pane *')].filter(n => n.offsetParent && [...n.childNodes].some(c => c.nodeType === 3 && c.textContent.trim()) && parseFloat(getComputedStyle(n).fontSize) < 11).map(n => n.className)`);
      assert.deepEqual(small, [], 'no text below 11px in the list, header or native chat');
      fs.mkdirSync('/tmp/w1-proof', { recursive: true });
      await run(`document.activeElement?.blur()`);
      await sleep(400);
      fs.writeFileSync('/tmp/w1-proof/gateway-list.png', (await shell.capturePage()).toPNG());
      console.log('GATEWAY LIST PROOF: /tmp/w1-proof/gateway-list.png');
    } else if (phase === '2') {
      // Relaunch: the last bot and gateway come back, and A's conversation.
      await showing('native', '1001');
      const bigId = saved().nativeSessions['1001'];
      await until(async () => (await native()).activeId === bigId, 'A conversation restored');
      // An old preference that names no gateway cannot strand B on a missing row: B opens on one it has.
      assert.equal(saved().chatSurfaces['1002'], 'pill-toggle-leftover');
      await run(`workspace.command('open-bot', { id: '1002' })`);
      await until(async () => (await state()).selectedBotId === '1002', 'B opened');
      await until(async () => (await selectedRows()).length === 1 && (await selectedRows())[0].startsWith('1002@'), 'one row selected for B');
      await go('1002', 'hermes-desktop');
      await go('1001', 'native');
      assert.deepEqual(saved().chatSurfaces, { 1001: 'native', 1002: 'hermes-desktop' });
    } else {
      // No Telegram bots: one built-in bot with a row under Hermes and one under Alan's Way, and no Telegram section.
      await until(async () => (await sections()).replace(/\*/g, '') === 'hermes-desktop:hermes native:hermes', 'built-in rows');
      assert.equal(await run(`document.getElementById('bot-list').getAttribute('aria-label')`), 'Your agents (1)');
      assert.equal(await run(`document.querySelector('${row('hermes', 'hermes-desktop')} .bot-name').textContent`), 'Hermes on localhost');
      assert.equal((await selectedRows()).length, 1);
      await go('hermes', 'native');
      await go('hermes', 'hermes-desktop');
      await until(() => saved().chatSurfaces?.hermes === 'hermes-desktop', 'built-in choice saved');
      await assert.rejects(run(`workspace.command('open-bot', { id: 'hermes', surface: 'telegram' })`), /not set up/);
    }
    console.log(`PASS gateway list phase ${phase}`);
    quitFixture();
  })().catch((error) => {
    console.error(error);
    app.exit(1);
  });
}
