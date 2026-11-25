// The agent list (one row per bot) with a gateway menu in the chat header and one inbox, end to end: real main,
// preload and renderer with two fake Telegram bots, a local stand-in Hermes Webapp and the native chat mock.
// Three launches share one throwaway profile: the list, the menu and switching, a relaunch (with an old
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
    bots: [{ id: '1001', isBot: true, name: 'Alan', username: 'alan_bot' }, { id: '1002', isBot: true, name: 'Scout Research Assistant', unread: 3 }], selectedBotId: '1001' }));
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
    // The list as bot ids, the selected one starred; one row per bot.
    const bots = () => run(`[...document.querySelectorAll('#bot-list .bot-row')].map(r => r.dataset.botId + (r.classList.contains('selected') ? '*' : '')).join(' ')`);
    const selectedRows = () => run(`[...document.querySelectorAll('#bot-list .bot-row.selected')].map(r => r.dataset.botId)`);
    const TARGET = { telegram: 'telegram', 'hermes-desktop': 'webapp', native: 'native' };
    const showing = (surface, id) => until(async () => (await state()).chatTarget === TARGET[surface] && (await selectedRows()).length === 1 && (!id || (await selectedRows())[0] === id), `${surface} showing`);
    const row = (id) => `#bot-list .bot-row[data-bot-id="${id}"]`;
    const menuHidden = () => run(`document.getElementById('chat-menu').classList.contains('hidden')`);
    const openMenu = async () => { if (await menuHidden()) await run(`document.getElementById('chat-name').click()`); await until(async () => !(await menuHidden()), 'menu open'); };
    const closeMenu = async () => { if (!(await menuHidden())) await run(`document.getElementById('chat-name').click()`); await until(menuHidden, 'menu closed'); };
    // The menu's entries as key, a star on the checked one, a bang on one with unread.
    const menuItems = () => run(`[...document.querySelectorAll('#chat-menu [role^=menuitem]')].map(b => (b.dataset.gateway || b.dataset.page || (b.dataset.sidebar ? 'sidebar' : '')) + (b.getAttribute('aria-checked') === 'true' ? '*' : '') + (b.querySelector('.unread') ? '!' : ''))`);
    const menu = async () => { await openMenu(); const items = await menuItems(); await closeMenu(); return items; };
    const choose = async (key) => { await openMenu(); await run(`(() => { const item = document.querySelector('#chat-menu [data-gateway="${key}"], #chat-menu [data-page="${key}"]'); render(state); if (!item.isConnected) throw new Error('a state update rebuilt the open menu, which loses a click in progress'); item.click(); })()`); await until(menuHidden, 'menu closed'); };
    // A click on a row opens that bot on the gateway it remembers; the header menu switches gateway.
    const go = async (id, surface) => {
      if ((await state()).chatBotId !== id) { await run(`document.querySelector('${row(id)}').click()`); await until(async () => (await state()).chatBotId === id, `bot ${id}`); }
      if ((await state()).chatTarget !== TARGET[surface]) await choose(surface);
      await showing(surface, id);
    };
    const chips = (selector) => run(`[...document.querySelectorAll(${JSON.stringify(selector + ' .gateway-chip')})].map(c => c.dataset.gateway).join()`);
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
      // Two gateways set up: one row per bot, no sections or headers, and the open bot's menu offers just those two.
      await until(async () => (await bots()).replace(/\*/g, '') === '1001 1002', 'one row per bot');
      assert.equal(await run(`document.querySelectorAll('#bot-list .gateway-section, #bot-list .gateway-head, #bot-list h3, #bot-list .gateway-logo').length`), 0, 'no gateway sections or headers');
      await until(async () => (await menu()).filter((key) => key !== 'settings' && key !== 'cron').join() === 'telegram,hermes-desktop*,sidebar', 'Telegram and Hermes, Hermes on screen');
      await run(`workspace.command('settings', { nativeChatUrl: ${JSON.stringify(process.env.NATIVE_CHAT_URL)}, nativeChatKey: ${JSON.stringify(KEY)} })`);
      // Alan's Way joins: still one row per bot, and the menu lists the three gateways in order with a check on the one shown.
      await until(async () => (await menu()).filter((key) => key !== 'settings' && key !== 'cron').join() === 'telegram,hermes-desktop*,native,sidebar', 'three gateways in the menu');
      assert.equal(await run(`document.querySelectorAll('#bot-list .bot-row').length`), 2, 'still one row per bot');
      assert.equal(await run(`document.getElementById('bot-list').getAttribute('aria-label')`), 'Your agents (2)', 'the count is bots');
      assert.equal(await run(`document.getElementById('bot-list').getAttribute('role')`), 'list');
      // The pages join the menu below a divider whenever Hermes Desktop has them.
      await openMenu();
      assert.deepEqual(await run(`(() => { const m = document.getElementById('chat-menu'); return [m.getAttribute('role'), m.querySelectorAll('[role=menuitemradio]').length, m.querySelectorAll('[role=separator]').length, [...m.querySelectorAll('[role=menuitemradio] .gateway-logo')].map(l => l.querySelector('img, svg') && l.querySelector('img, svg').tagName.toLowerCase()).join()]; })()`), ['menu', 3, (await run(`!!document.querySelector('#chat-menu [data-page]')`)) ? 1 : 0, 'svg,img,img'], 'menu semantics: radios with a logo each');
      assert.equal(await run(`document.querySelector('#chat-menu [data-sidebar]').getAttribute('role') + '/' + document.querySelector('#chat-menu [data-sidebar]').getAttribute('aria-checked')`), 'menuitemcheckbox/false', 'the sidebar row is an unchecked checkbox');
      assert.deepEqual(await run(`[...document.querySelectorAll('#chat-menu [data-gateway] .gateway-logo img')].map(i => i.getAttribute('src'))`), ['../assets/hermes-icon.png', '../assets/alans-way-logo-64.png'], 'Alan\'s Way wears the new logo');
      assert.equal(await run(`getComputedStyle(document.querySelector('#chat-menu [aria-checked="true"] .chat-menu-check')).visibility + getComputedStyle(document.querySelector('#chat-menu [aria-checked="false"] .chat-menu-check')).visibility`), 'visiblehidden', 'only the shown gateway has a check');
      await closeMenu();
      // The sidebar header: one line beside the window buttons, a search field that is always there, no label or count.
      assert.deepEqual(await run(`(() => { const t = document.querySelector('.side-title'), s = document.getElementById('bots-toggle'), top = document.querySelector('.side-top').getBoundingClientRect(), r = t.getBoundingClientRect(), b = s.getBoundingClientRect(); return [t.textContent, Math.round(r.height) <= 20, r.left >= b.right, r.bottom <= top.bottom, getComputedStyle(t.querySelector('b')).fontWeight > getComputedStyle(t).fontWeight]; })()`), ['Alan\'s Workspace', true, true, true, true], 'title on one line, right of the toggle, first word heavier');
      assert.equal(await run(`getComputedStyle(document.querySelector('.side-top')).webkitAppRegion + ' ' + getComputedStyle(document.getElementById('bots-toggle')).webkitAppRegion`), 'drag no-drag', 'the top row drags except on its button');
      assert.equal(await run(`getComputedStyle(document.getElementById('bot-search')).display !== 'none' && document.getElementById('bot-search').getBoundingClientRect().width > 60 && document.getElementById('bot-search').placeholder`), 'Search', 'the search field is always visible');
      assert.equal(await run(`document.getElementById('search-toggle')`), null, 'no search toggle');
      assert.equal(await run(`['bot-count', 'sort-bots', 'add-bot'].map((id) => !!document.getElementById(id)).join()`), 'false,true,true');
      assert.equal(await run(`/YOUR AGENTS/.test(document.querySelector(".sidebar").textContent)`), false, 'no YOUR AGENTS label');
      assert.equal(await run(`/Idle|Unreachable|Waiting|Activity unavailable/.test(document.getElementById('bot-list').textContent) || !!document.querySelector('.bot-activity, #presence-status:not(:empty)')`), false, 'idle and unknown activity take no line or label');
      assert.equal(await run(`getComputedStyle(document.querySelector('#bot-list .bot-row.selected')).backgroundColor !== 'rgba(0, 0, 0, 0)' && getComputedStyle(document.querySelector('#bot-list .bot-row:not(.selected)')).backgroundColor === 'rgba(0, 0, 0, 0)'`), true, 'the open row is a card, the others are flat');
      assert.equal((await selectedRows()).length, 1, 'exactly one row is selected');
      assert.equal(await run(`document.getElementById('surface-tabs')`), null, 'no pill toggle in the chat header');
      assert.equal(await run(`document.getElementById('bot-list').textContent.includes('Telegram bot')`), false, 'no row claims to be a Telegram bot');
      // Search filters the rows; the count stays.
      await run(`(() => { const i = document.getElementById('bot-search'); i.value = 'scout'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await until(async () => (await bots()).replace(/\*/g, '') === '1002', 'search narrows to Scout');
      assert.equal(await run(`document.getElementById('bot-list').getAttribute('aria-label')`), 'Your agents (2)');
      await run(`document.getElementById('bot-search-clear').click()`);
      await until(async () => (await bots()).replace(/\*/g, '') === '1001 1002', 'search cleared');
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

      // The sidebar switch saves, then drops and restores the secondary-window flag on the live view.
      await openMenu(); await run(`document.querySelector('#chat-menu [data-sidebar]').click()`);
      await until(async () => (await state()).showHermesSidebar === true, 'sidebar preference on');
      await until(() => saved().showHermesSidebar === true, 'sidebar preference saved');
      await until(() => new URL(webappView.getURL()).searchParams.get('win') === null && !webappView.isLoading(), 'secondary flag dropped');
      await openMenu();
      await until(async () => (await run(`document.querySelector('#chat-menu [data-sidebar]').getAttribute('aria-checked')`)) === 'true', 'the switch shows its saved state');
      await run(`document.querySelector('#chat-menu [data-sidebar]').click()`);
      await until(async () => (await state()).showHermesSidebar === false, 'sidebar preference off');
      await until(() => new URL(webappView.getURL()).searchParams.get('win') === 'secondary' && !webappView.isLoading(), 'secondary flag restored');
      await webappView.executeJavaScript('window.kept = "webapp"');

      // Bot A on Alan's Way: Arrow keys move one row at a time; Enter on a row opens that bot; the menu picks Alan's Way; the newest Telegram-source conversation opens read-only.
      await run(`document.querySelector('${row('1001')} .bot-open').focus(); document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))`);
      assert.equal(await run(`document.activeElement.closest('.bot-row').dataset.botId`), '1002');
      await run(`document.querySelector('${row('1001')} .bot-open').focus(); document.activeElement.click()`);
      await until(async () => (await state()).chatBotId === '1001', 'bot 1001 opened by its row');
      await choose('native');
      await showing('native', '1001');
      assert.equal(await run(`document.querySelectorAll('#bot-list .bot-open[tabindex="0"]').length`), 1, 'roving tab stop');
      await until(async () => (await native()).thread?.source === 'telegram', 'telegram-source conversation');
      await until(() => has('#native-pane .nc-readonly:not(.hidden)'), 'read-only with Continue here');
      await until(() => saved().chatSurfaces?.['1001'] === 'native', 'A choice saved');

      // Bot B: Hermes Desktop.
      await go('1002', 'hermes-desktop');
      await until(() => saved().chatSurfaces?.['1002'] === 'hermes-desktop', 'B choice saved');
      // Scout has Telegram unread (3), and Hermes Desktop is on screen: his row and the header pill both show a Telegram chip, the menu a dot.
      assert.equal(await chips(row('1002')), 'telegram', 'the row shows the logo of the gateway with unread, in place of the dot');
      assert.equal(await has(`${row('1002')} .bot-status > .unread`), false, 'no plain dot beside the chips');
      assert.equal(await chips('#chat-name'), 'telegram', 'the pill points at the gateway to switch to');
      assert.match(await run(`document.getElementById('chat-name').getAttribute('aria-label')`), /Unread in Telegram$/);
      assert.match(await run(`document.querySelector('${row('1002')} .bot-open').getAttribute('aria-label')`), /unread in telegram$/);
      assert.equal(await run(`document.querySelector('${row('1002')} .gateway-chips').getAttribute('aria-label')`), 'Unread in Telegram');
      // The chips are 20 px in the row and the header pill, each ringed in the colour of what is behind it.
      assert.equal(await run(`['${row('1002')}', '#chat-name'].map((s) => getComputedStyle(document.querySelector(s + ' .gateway-chip')).width).join()`), '20px,20px', 'chips are 20 px');
      assert.equal(await run(`(() => { const row = document.querySelector('${row('1002')}'); return getComputedStyle(row.querySelector('.gateway-chip')).boxShadow.startsWith(getComputedStyle(row).backgroundColor); })()`), true, 'the selected row\'s ring is its own background');
      assert.deepEqual((await menu()).filter((key) => key !== 'settings' && key !== 'cron'), ['telegram!', 'hermes-desktop*', 'native', 'sidebar']);
      await openMenu();
      assert.equal(await run(`document.querySelector('#chat-menu [data-gateway="telegram"] .sr-only').textContent`), ', unread', 'the dot has a text equivalent');
      await closeMenu();
      // Telegram on screen: the pill drops that chip (it is the one shown); the row keeps it.
      await choose('telegram'); await showing('telegram', '1002');
      assert.equal(await chips('#chat-name'), '', 'no pill chip for the gateway on screen');
      assert.equal(await chips(row('1002')), 'telegram');
      assert.equal(await run(`document.getElementById('chat-name').getAttribute('aria-label').includes('Unread')`), false);
      await choose('hermes-desktop'); await showing('hermes-desktop', '1002');
      await telegramView.executeJavaScript('window.kept = "telegram"');
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
      // Enter while the reply streams sends nothing, keeps the draft and says why.
      await type('typed ahead', true);
      await until(() => run(`!document.querySelector('#native-pane .nc-hint').classList.contains('hidden')`), 'hint shown');
      assert.equal(await run(`document.querySelector('#native-pane .nc-hint').textContent`), 'Wait for the reply to finish, or press Stop');
      assert.equal(await draft(), 'typed ahead', 'the draft waits in the box');
      await type('', false);
      await go('1002', 'hermes-desktop');
      assert.ok((await native()).run, 'still running in the background');
      await until(async () => !(await native()).run, 'turn finished in the background', 30000);
      await until(() => has(`${row('1001')} .gateway-chip[data-gateway="native"]`), 'A row unread on Alan\'s Way');
      assert.equal(await chips(row('1001')), 'native', 'one gateway unread shows one chip');
      assert.match(await run(`document.querySelector('${row('1001')} .bot-open').getAttribute('aria-label')`), /unread in alan's way$/);
      assert.equal((await state()).inbox['1001'].rows.native.preview, 'pong: hello world', 'native keeps its own preview');
      assert.equal((await state()).inbox['1001'].rows.telegram.unread, false, 'native unread is not Telegram unread');
      assert.equal((await state()).inbox['1001'].rows['hermes-desktop'].unread, false, 'Hermes Desktop exposes no unread');
      await until(async () => (await run(`document.querySelector('${row('1001')} .bot-preview').textContent`)) === 'pong: hello world', 'the row shows its latest activity');
      await go('1001', 'native');
      await until(async () => (await chips(row('1001'))) === '', 'opening native clears unread');

      // The same turn finishing while A is open on another of its own gateways: the row and the pill both point at Alan's Way.
      await streamDelay(1500);
      await type('second turn', true);
      await until(async () => (await native()).run, 'second turn started');
      await choose('telegram'); await showing('telegram', '1001');
      await until(async () => !(await native()).run, 'second turn finished behind Telegram', 30000);
      await until(async () => (await chips('#chat-name')) === 'native', 'the pill points at Alan\'s Way');
      assert.equal(await chips(row('1001')), 'native');
      assert.match(await run(`document.getElementById('chat-name').getAttribute('aria-label')`), /Unread in Alan's Way$/);
      assert.deepEqual((await menu()).filter((key) => key !== 'settings' && key !== 'cron'), ['telegram*', 'hermes-desktop', 'native!']);
      // Choosing the gateway with unread shows it and clears both indicators; the choice is the bot's, remembered.
      await choose('native'); await showing('native', '1001');
      await until(async () => (await chips('#chat-name')) === '' && (await chips(row('1001'))) === '', 'indicators cleared');
      await until(() => saved().chatSurfaces?.['1001'] === 'native', 'the menu choice is remembered per bot');
      await streamDelay(0);

      // The choice is remembered per bot: Telegram for A, then Scout and back, A is still on Telegram.
      await choose('telegram'); await showing('telegram', '1001');
      await until(() => saved().chatSurfaces?.['1001'] === 'telegram', 'A on Telegram saved');
      await go('1002', 'hermes-desktop');
      await run(`document.querySelector('${row('1001')}').click()`);
      await showing('telegram', '1001');
      await go('1001', 'native');

      // Keyboard: ArrowDown on the pill opens the menu on its first entry, the arrows and Home/End move, Enter chooses, Escape closes and returns to the pill.
      shell.debugger.attach('1.3');
      const key = async (name) => {
        const params = { key: name, code: name, windowsVirtualKeyCode: { Enter: 13, Escape: 27, End: 35, Home: 36, ArrowUp: 38, ArrowDown: 40 }[name] };
        await shell.debugger.sendCommand('Input.dispatchKeyEvent', { ...params, type: 'keyDown', ...(name === 'Enter' ? { text: '\r' } : {}) });
        await shell.debugger.sendCommand('Input.dispatchKeyEvent', { ...params, type: 'keyUp' });
      };
      const focusedIn = () => run(`document.activeElement.id + '/' + (document.activeElement.dataset.gateway || document.activeElement.dataset.page || '')`);
      shell.focus();
      await run(`document.getElementById('chat-name').focus()`);
      await key('ArrowDown');
      await until(async () => !(await menuHidden()), 'ArrowDown opens the menu');
      assert.equal(await focusedIn(), '/telegram');
      assert.equal(await run(`document.getElementById('chat-name').getAttribute('aria-expanded')`), 'true');
      await key('ArrowDown'); await until(async () => (await focusedIn()) === '/hermes-desktop', 'ArrowDown moves on');
      await key('End'); await until(async () => (await run(`document.activeElement === [...document.querySelectorAll('#chat-menu [role^=menuitem]')].at(-1)`)), 'End reaches the last entry');
      await key('Home'); await until(async () => (await focusedIn()) === '/telegram', 'Home returns to the first');
      await key('ArrowUp'); await until(async () => (await run(`document.activeElement === [...document.querySelectorAll('#chat-menu [role^=menuitem]')].at(-1)`)), 'ArrowUp wraps');
      await key('Home'); await until(async () => (await focusedIn()) === '/telegram', 'Home again');
      await key('ArrowDown'); await until(async () => (await focusedIn()) === '/hermes-desktop', 'Down to Hermes');
      await key('Enter');
      await showing('hermes-desktop', '1001');
      assert.equal(await menuHidden(), true, 'Enter chooses and closes');
      assert.equal(await run(`document.activeElement.id`), 'chat-name', 'focus returns to the pill');
      assert.equal(await run(`document.getElementById('chat-name').getAttribute('aria-expanded')`), 'false');
      await openMenu(); await key('Escape');
      await until(menuHidden, 'Escape closes');
      assert.equal(await run(`document.activeElement.id`), 'chat-name');
      await openMenu(); await run(`document.getElementById('bot-search').click()`);
      await until(menuHidden, 'a click outside closes');
      shell.debugger.detach();
      await go('1001', 'native');

      // An approval request while away: waiting badge, its label, one notification.
      await streamDelay(800);
      await type('APPROVE please', true);
      await until(async () => (await native()).run, 'approval turn started');
      await go('1002', 'hermes-desktop');
      await until(() => has(`${row('1001')} .waiting-badge`), 'waiting badge', 30000);
      assert.match(await run(`document.querySelector('${row('1001')} .bot-open').getAttribute('aria-label')`), /waiting for you$/);
      assert.equal(await has(`#bot-list [data-bot-id="1002"] .waiting-badge`), false);
      await sleep(600);
      assert.deepEqual(shown, [{ title: 'Alan', body: 'is waiting for you' }], 'one notification per waiting episode');
      await go('1001', 'native');
      await until(() => has('#native-pane .nc-prompt.approval.open'), 'approval card');
      await run(`[...document.querySelectorAll('#native-pane .nc-prompt.approval button')].find(b => b.textContent === 'Allow once').click()`);
      await until(async () => !(await has(`${row('1001')} .waiting-badge`)), 'waiting cleared');
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
      await until(async () => (await selectedRows()).length === 1 && (await selectedRows())[0] === '1002', 'one row selected for B');
      // Nothing was chosen yet, so the stale value stays until the menu overwrites it.
      await choose('telegram'); await choose('hermes-desktop'); await showing('hermes-desktop', '1002');
      await go('1001', 'native');
      assert.deepEqual(saved().chatSurfaces, { 1001: 'native', 1002: 'hermes-desktop' });
      // Removing the Hermes Desktop address while a bot is on it moves that bot to a gateway it still has, with its check on.
      await go('1002', 'hermes-desktop');
      await run(`workspace.command('settings', { hermesWebappUrl: '' })`);
      await until(async () => (await state()).chatTarget !== 'webapp', 'the bot leaves the removed Hermes Desktop');
      await until(async () => (await menu()).filter((key) => key.includes('*')).length === 1, 'one gateway is checked');
      assert.equal((await menu()).some((key) => key.startsWith('hermes-desktop')), false, 'Hermes Desktop is no longer offered');
      await run(`workspace.command('settings', { hermesWebappUrl: ${JSON.stringify(process.env.WEBAPP_URL)} })`);
      await until(() => saved().hermesWebappUrl === process.env.WEBAPP_URL, 'the address is back for the next launch');
    } else {
      // No Telegram bots: one built-in bot with one row, a menu of Hermes and Alan's Way (no Telegram), and no sections.
      await until(async () => (await bots()) === 'hermes*', 'built-in row');
      assert.equal(await run(`document.getElementById('bot-list').getAttribute('aria-label')`), 'Your agents (1)');
      assert.equal(await run(`document.querySelector('${row('hermes')} .bot-name').textContent`), 'Hermes on localhost');
      assert.equal((await selectedRows()).length, 1);
      await until(async () => (await menu()).filter((key) => !['settings', 'cron', 'sidebar'].includes(key)).length === 2, 'two gateways');
      assert.deepEqual((await menu()).filter((key) => !['settings', 'cron', 'sidebar'].includes(key)).map((key) => key.replace('*', '')), ['hermes-desktop', 'native']);
      assert.equal((await menu()).includes('sidebar'), true, 'the sidebar switch shows on Hermes Desktop');
      await go('hermes', 'native');
      await go('hermes', 'hermes-desktop');
      await until(() => saved().chatSurfaces?.hermes === 'hermes-desktop', 'built-in choice saved');
      await assert.rejects(run(`workspace.command('open-bot', { id: 'hermes', surface: 'telegram' })`), /not set up/);
      // One gateway left: the gateway group goes; the sidebar switch stays with the two page entries.
      await run(`workspace.command('settings', { nativeChatUrl: '' })`);
      await until(async () => (await state()).inbox.hermes.gateways.join() === 'hermes-desktop', 'only Hermes Desktop');
      await until(async () => (await menu()).join() === 'sidebar,settings,cron', 'the sidebar switch and page entries');
      await openMenu();
      assert.equal(await run(`document.querySelectorAll('#chat-menu [role=menuitemradio]').length`), 0, 'no gateway group');
      assert.equal(await run(`document.querySelectorAll('#chat-menu [role=separator]').length`), 1, 'the switch and pages stay separate');
      await run(`document.querySelector('#chat-menu [data-page="cron"]').click()`);
      await until(async () => (await state()).canvasTab === 'cron', 'Cron jobs opens its page');
      await openMenu(); await run(`document.querySelector('#chat-menu [data-page="settings"]').click()`);
      await until(async () => (await state()).canvasTab === 'settings', 'Bot settings opens its page');
    }
    console.log(`PASS gateway list phase ${phase}`);
    quitFixture();
  })().catch((error) => {
    console.error(error);
    app.exit(1);
  });
}
