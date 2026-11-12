// The per-bot chat surface toggle and one inbox, end to end: real main, preload and renderer with
// two fake Telegram bots, a local stand-in Hermes Webapp and the native chat mock. Three launches
// share one throwaway profile: the toggle and switching, a relaunch, then zero Telegram bots.
// Run: npm run test:surface-toggle
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const KEY = 'mock-key-0000000000000001';

if (!process.versions.electron) {
  const http = require('node:http');
  const { spawn } = require('node:child_process');
  const { createMock } = require('./native-chat-mock.cjs');
  (async () => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'surface-toggle-electron-'));
    const mock = await createMock({ key: KEY }).listen();
    const webapp = http.createServer((req, res) => {
      if (req.url === '/api/status') { res.setHeader('Content-Type', 'application/json'); return res.end('{"version":"0.23.0"}'); }
      res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Webapp fixture</title><main>Webapp</main>');
    });
    await new Promise((resolve) => webapp.listen(0, 'localhost', resolve));
    let failed = false;
    for (const phase of ['1', '2', '3']) {
      if (phase === '3') {
        const file = path.join(profile, 'preferences.json'), prefs = JSON.parse(fs.readFileSync(file, 'utf8'));
        fs.writeFileSync(file, JSON.stringify({ ...prefs, bots: [], order: [], selectedBotId: '' }));
      }
      const code = await new Promise((resolve) => {
        const child = spawn(require('electron'), [`--user-data-dir=${profile}`, __filename], { stdio: 'inherit',
          env: { ...process.env, HERMES_TEST_PROFILE: profile, SURFACE_PHASE: phase, NATIVE_CHAT_URL: mock.url, WEBAPP_URL: `http://localhost:${webapp.address().port}/` } });
        const deadline = setTimeout(() => { console.error(`Phase ${phase} exceeded 150s.`); child.kill('SIGKILL'); }, 150000);
        child.once('close', (exit, signal) => { clearTimeout(deadline); resolve(signal ? 1 : exit); });
      });
      if (code !== 0) { failed = true; break; }
    }
    mock.close(); webapp.closeAllConnections(); webapp.close();
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    console.log(failed ? 'surface toggle: FAILED' : 'surface toggle: ok');
    process.exit(failed ? 1 : 0);
  })();
} else {
  const assert = require('node:assert/strict');
  const { app, BrowserWindow, Notification, webContents, session } = require('electron');
  const { prepareFixture, quitFixture } = require('./electron-fixture.cjs');
  const profile = process.env.HERMES_TEST_PROFILE, phase = process.env.SURFACE_PHASE;
  prepareFixture(profile);
  const prefsFile = path.join(profile, 'preferences.json');
  if (phase === '1') fs.writeFileSync(prefsFile, JSON.stringify({ onboarded: true, preview: false, hermesWebappUrl: process.env.WEBAPP_URL,
    bots: [{ id: '1001', isBot: true, name: 'Alan' }, { id: '1002', isBot: true, name: 'Scout Research Assistant' }], selectedBotId: '1001' }));
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
    const segments = () => run(`[...document.querySelectorAll('#surface-tabs [role=tab]')].filter(b => b.offsetParent).map(b => b.dataset.surface + (b.getAttribute('aria-selected') === 'true' ? '*' : '')).join()`);
    const showing = (surface) => until(async () => (await state()).chatTarget === { telegram: 'telegram', 'hermes-desktop': 'webapp', native: 'native' }[surface]
      && (await segments()).split(',').includes(`${surface}*`), `${surface} showing`);
    const pick = async (id) => { await run(`workspace.command('open-bot', { id: '${id}' })`); await until(async () => (await state()).selectedBotId === id, `bot ${id}`); };
    const choose = (surface) => run(`document.querySelector('#surface-tabs [data-surface="${surface}"]').click()`);
    const row = (id) => `#bot-list .bot-row[data-bot-id="${id}"]`;
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
      await run(`workspace.command('settings', { nativeChatUrl: ${JSON.stringify(process.env.NATIVE_CHAT_URL)}, nativeChatKey: ${JSON.stringify(KEY)} })`);
      // Three usable surfaces: three segments in one tablist; nothing configured yet is the default Hermes Desktop.
      await until(async () => (await segments()).replace(/\*/g, '') === 'telegram,hermes-desktop,native', 'three segments');
      assert.equal(await run(`document.getElementById('surface-tabs').getAttribute('role')`), 'tablist');
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

      // Bot A: arrow keys move the selection and focus to Native; it opens the newest Telegram-source conversation read-only.
      await run(`document.querySelector('#surface-tabs [data-surface="hermes-desktop"]').focus(); document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))`);
      await showing('native');
      assert.equal(await run('document.activeElement.dataset.surface'), 'native', 'focus follows the arrow');
      assert.equal(await run(`document.querySelector('#surface-tabs [data-surface="native"]').tabIndex`), 0, 'roving tab stop');
      await until(async () => (await native()).thread?.source === 'telegram', 'telegram-source conversation');
      await until(() => has('#native-pane .nc-readonly:not(.hidden)'), 'read-only with Continue here');
      await until(() => saved().chatSurfaces?.['1001'] === 'native', 'A choice saved');

      // Bot B: Hermes Desktop.
      await pick('1002'); await choose('hermes-desktop'); await showing('hermes-desktop');
      await until(() => saved().chatSurfaces?.['1002'] === 'hermes-desktop', 'B choice saved');
      const apart = () => run(`(() => { const [t, p, s] = ['bots-toggle', 'chat-pill', 'surface-tabs'].map(id => document.getElementById(id).getBoundingClientRect()); return t.right <= p.left && p.right <= s.left; })()`);
      assert.equal(await apart(), true, 'a long bot name keeps the header pieces apart');
      assert.match(await run(`document.getElementById('home-copy').textContent`), /^Talk to Scout Research Assistant/, 'Home does not wait for Telegram when the bot chats elsewhere');
      await run(`document.getElementById('bots-toggle').click()`); await until(() => run(`document.getElementById('shell').classList.contains('bots-hidden')`), 'agent list hidden');
      assert.equal(await apart(), true, 'and with the agent list hidden');
      await run(`document.getElementById('bots-toggle').click()`); await until(async () => !(await run(`document.getElementById('shell').classList.contains('bots-hidden')`)), 'agent list back');
      for (let i = 0; i < 2; i++) {
        await pick('1001'); await showing('native');
        await pick('1002'); await showing('hermes-desktop');
      }
      assert.equal(await webappView.executeJavaScript('window.kept'), 'webapp', 'webapp view kept alive');
      assert.equal(await telegramView.executeJavaScript('window.kept'), 'telegram', 'telegram view kept alive');

      // A's own conversation: a draft and a scroll position survive switching bots.
      await pick('1001'); await showing('native');
      const bigId = await openSession('seed 1k');
      await until(() => saved().nativeSessions?.['1001'] === bigId, 'A conversation remembered');
      await until(() => run(`document.querySelectorAll('#native-pane .nc-list > .nc-row').length >= 60`), 'thread painted');
      await type('half-written thought');
      await run(`document.querySelector('${scroller}').scrollTop = 4000`);
      await sleep(150);
      const anchor = await topRow(), sameView = (back) => back[0] === anchor[0] && Math.abs(back[1] - anchor[1]) < 4;
      assert.ok(await scrollTop() > 1000 && !(await atBottom()), 'scrolled into the thread');
      await pick('1002'); await showing('hermes-desktop');
      await pick('1001'); await showing('native');
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
      await pick('1002'); await showing('hermes-desktop');
      await pick('1001'); await showing('native');
      await sleep(150);
      assert.ok(await atBottom(), 'pinned stays pinned');

      // A slow turn keeps streaming while another bot is open; finishing there marks A unread.
      await streamDelay(1500);
      await type('hello world', true);
      await until(async () => (await native()).run, 'turn started');
      await pick('1002'); await showing('hermes-desktop');
      assert.ok((await native()).run, 'still running in the background');
      await until(async () => !(await native()).run, 'turn finished in the background', 30000);
      await until(() => has(`${row('1001')} .unread`), 'A row unread');
      assert.equal((await state()).inbox['1001'].preview, 'pong: hello world', 'row previews the native reply');
      await until(async () => (await run(`document.querySelector('${row('1001')} .bot-preview').textContent`)) === 'pong: hello world', 'preview line');
      await pick('1001'); await showing('native');
      await until(async () => !(await has(`${row('1001')} .unread`)), 'opening native clears unread');

      // An approval request while away: waiting badge, its label, one notification.
      await type('APPROVE please', true);
      await until(async () => (await native()).run, 'approval turn started');
      await pick('1002'); await showing('hermes-desktop');
      await until(() => has(`${row('1001')} .waiting-badge`), 'waiting badge', 30000);
      assert.match(await run(`document.querySelector('${row('1001')} .bot-open').getAttribute('aria-label')`), /waiting for you$/);
      assert.equal(await has(`${row('1002')} .waiting-badge`), false);
      await sleep(600);
      assert.deepEqual(shown, [{ title: 'Alan', body: 'is waiting for you' }], 'one notification per waiting episode');
      await pick('1001'); await showing('native');
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
      fs.writeFileSync('/tmp/w1-proof/surface-toggle.png', (await shell.capturePage()).toPNG());
      console.log('SURFACE TOGGLE PROOF: /tmp/w1-proof/surface-toggle.png');
    } else if (phase === '2') {
      // Relaunch: each bot's surface and A's conversation come back.
      await showing('native');
      const bigId = saved().nativeSessions['1001'];
      await until(async () => (await native()).activeId === bigId, 'A conversation restored');
      await pick('1002'); await showing('hermes-desktop');
      await pick('1001'); await showing('native');
      assert.deepEqual(saved().chatSurfaces, { 1001: 'native', 1002: 'hermes-desktop' });
    } else {
      // No Telegram bots: one built-in row for this Hermes host, offering only the two Hermes surfaces.
      await until(async () => (await run(`[...document.querySelectorAll('#bot-list .bot-row')].map(r => r.dataset.botId).join()`)) === 'hermes', 'built-in row');
      assert.equal(await run(`document.querySelector('${row('hermes')} .bot-name').textContent`), 'Hermes on localhost');
      assert.equal(await run(`document.querySelector('${row('hermes')}').classList.contains('selected')`), true);
      await until(async () => (await segments()).replace(/\*/g, '') === 'hermes-desktop,native', 'two Hermes segments');
      await choose('native'); await showing('native');
      await choose('hermes-desktop'); await showing('hermes-desktop');
      await until(() => saved().chatSurfaces?.hermes === 'hermes-desktop', 'built-in choice saved');
      await assert.rejects(run(`workspace.command('chat-surface', { surface: 'telegram' })`), /not set up/);
    }
    console.log(`PASS surface toggle phase ${phase}`);
    quitFixture();
  })().catch((error) => {
    console.error(error);
    app.exit(1);
  });
}
