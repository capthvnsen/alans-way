// Real main, preload and renderer: the Canvas tab strip and its per-bot memory.
// Run: npm run test:canvas-tabs   (CANVAS_SHOTS=<dir> also saves screenshots)
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { app, BrowserWindow, Menu, session, webContents } = require('electron');
const { prepareFixture, quitFixture } = require('./electron-fixture.cjs');

const profile = process.env.HERMES_TEST_PROFILE;
prepareFixture(profile);
process.env.HERMES_WORKSPACE_ALLOW_LOOPBACK = '1';
const until = async (read, why, ms = 15000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out: ${why}`);
    await new Promise(resolve => setTimeout(resolve, 40));
  }
};

const listen = (handler) => new Promise(resolve => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => resolve(s)); });

(async () => {
  // Stand-ins for Hermes Desktop: one signs in with cookies, one only through a one-use link.
  let statusUp = true;
  const server = await listen((req, res) => {
    if (req.url === '/api/status') { res.writeHead(statusUp ? 200 : 502, { 'Content-Type': 'application/json' }); return res.end(statusUp ? '{"version":"0.23.0"}' : '{}'); }
    if (req.url === '/' && !/webapp-login/.test(req.headers.cookie || '')) { res.writeHead(302, { Location: '/login' }); return res.end(); }
    res.setHeader('Content-Type', 'text/html'); res.end(`<!doctype html><title>${req.url === '/login' ? 'Sign in' : 'Hermes Desktop'}</title><body style="color:#ddd;font:20px system-ui">Hermes Desktop stand-in</body>`);
  });
  // A loopback host without sign-in, as reached through an SSH tunnel: the launch link leaves a credential in sessionStorage, as Hermes does.
  const privateKey = 'hermes.webapp.session.v1:["origin",""]';
  const privateServer = await listen((req, res) => {
    if (req.url === '/api/status') { res.setHeader('Content-Type', 'application/json'); return res.end('{"version":"0.23.0","auth_required":false}'); }
    res.setHeader('Content-Type', 'text/html');
    if (req.url.startsWith('/webapp/launch')) return res.end(`<script>if (location.hash) { sessionStorage.setItem(${JSON.stringify(privateKey)}, 'K'.repeat(43)); location.replace('/'); }</script>`);
    res.end(`<!doctype html><script>document.title = sessionStorage.getItem(${JSON.stringify(privateKey)}) ? 'Hermes Desktop' : 'No link'</script>`);
  });
  const address = `http://127.0.0.1:${server.address().port}/`;
  const prefsFile = path.join(profile, 'preferences.json');
  fs.writeFileSync(prefsFile, JSON.stringify({ onboarded: true, preview: false,
    bots: [{ id: '1001', isBot: true, name: 'Alan' }, { id: '1002', isBot: true, name: 'Scout' }], selectedBotId: '1001' }));
  require('../src/main.cjs');

  const win = await until(() => BrowserWindow.getAllWindows()[0], 'workspace window');
  const shell = win.webContents;
  await until(() => !shell.isLoading() && shell.getURL().endsWith('index.html'), 'workspace page');
  const run = (expression) => shell.executeJavaScript(expression).catch(error => { throw new Error(`${expression}: ${error.message}`); });
  const shots = process.env.CANVAS_SHOTS;
  const shot = async (name, width) => {
    if (!shots) return;
    win.setSize(width, 820); await new Promise(resolve => setTimeout(resolve, 600));
    // capturePage sees only the shell page; the VM live view is its own native view, saved alongside.
    fs.writeFileSync(path.join(shots, `${name}-${width}.png`), (await shell.capturePage()).toPNG());
    const native = name === 'screen' ? webContents.getAllWebContents().find(item => item.getURL().endsWith('remote.html')) : name === 'cron' ? canvasView() : null;
    // shortcut: native views may refuse capture (no Screen Recording permission); the shell shot still lands.
    const image = await native?.capturePage().catch(error => console.warn(`no ${name} view shot: ${error.message}`));
    if (image) fs.writeFileSync(path.join(shots, `${name}-${width}-${name === 'cron' ? 'canvas' : 'vm'}-view.png`), image.toPNG());
  };
  const state = () => run('workspace.getState()');
  const selected = () => run(`[...document.querySelectorAll('#canvas-tabs [role=tab]')].filter(b => b.getAttribute('aria-selected') === 'true').map(b => b.dataset.canvas).join()`);
  const showing = async (tab) => {
    await until(async () => (await selected()) === tab, `${tab} tab selected`);
    assert.equal((await state()).activeTabId === 'vps', tab === 'screen', `${tab} drives the canvas`);
    assert.equal(await run(`document.getElementById('canvas-${tab}').tabIndex`), 0, 'only the selected tab is in the Tab order');
  };
  const visible = () => run(`[...document.querySelectorAll('#canvas-tabs [role=tab]')].filter(b => !b.hidden).map(b => b.dataset.canvas).join()`);
  const canvasView = () => webContents.getAllWebContents().find(item => !item.isDestroyed() && item.session === session.fromPartition('persist:hermes-webapp') && item.getURL().includes('#/'));
  const pick = (id) => run(`workspace.command('open-bot', { id: '${id}' })`);
  const saved = () => JSON.parse(fs.readFileSync(prefsFile, 'utf8'));

  await showing('browser');
  await shot('browser', 1440); await shot('browser', 1120);

  // Click: Alan moves to his screen.
  await run(`document.getElementById('canvas-screen').click()`);
  await showing('screen');
  await shot('screen', 1440); await shot('screen', 1120);

  // The canvas follows the bot: Scout has no choice yet and inherits the view;
  // set Scout to Browser, then each bot gets its own tab back.
  await pick('1002'); await showing('screen');
  await run(`document.getElementById('canvas-browser').click()`); await showing('browser');
  await pick('1001'); await showing('screen');
  await pick('1002'); await showing('browser');

  // Keyboard: arrow keys on the strip, and the View menu accelerators from anywhere.
  await run(`document.getElementById('canvas-browser').focus(); document.getElementById('canvas-browser').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))`);
  await showing('screen');
  assert.equal(await run('document.activeElement.id'), 'canvas-screen', 'focus follows the arrow');
  await run(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))`);
  await showing('browser');
  const menu = Menu.getApplicationMenu();
  assert.equal(menu.getMenuItemById('canvas-screen').accelerator, 'CmdOrCtrl+2');
  menu.getMenuItemById('canvas-screen').click(); await showing('screen');
  menu.getMenuItemById('canvas-browser').click(); await showing('browser');
  menu.getMenuItemById('canvas-screen').click(); await showing('screen');

  // Choices are saved per bot, so they survive a restart.
  await until(() => saved().canvasTabs?.['1002'] === 'screen' && saved().canvasTabs?.['1001'] === 'screen', 'choices saved');
  menu.getMenuItemById('canvas-browser').click(); await showing('browser');
  await until(() => saved().canvasTabs?.['1002'] === 'browser', 'browser choice saved');

  // ⌘1/⌘2 with the browser pane collapsed reopen it.
  await run(`workspace.command('settings', { showBrowser: false })`);
  await until(async () => (await state()).showBrowser === false, 'pane collapsed');
  menu.getMenuItemById('canvas-screen').click(); await showing('screen');
  await until(async () => (await state()).showBrowser === true && saved().showBrowser === true, '⌘2 reopens the pane');
  await run(`workspace.command('settings', { showBrowser: false })`);
  menu.getMenuItemById('canvas-browser').click(); await showing('browser');
  await until(async () => (await state()).showBrowser === true, '⌘1 reopens the pane');

  // Without a Hermes Desktop address the page tabs stay hidden and do nothing.
  assert.equal(await visible(), 'browser,screen,terminal');
  menu.getMenuItemById('canvas-cron').click(); await new Promise(resolve => setTimeout(resolve, 300));
  await showing('browser');
  await run(`workspace.command('canvas-tab', { tab: 'nonsense' })`); await showing('browser');

  // With one, they appear and load its pages in a Canvas view that shares the sign-in cookie.
  await session.fromPartition('persist:hermes-webapp').cookies.set({ url: address, name: 'webapp-login', value: 'yes' });
  await run(`workspace.command('settings', { hermesWebappUrl: ${JSON.stringify(address)}, chatSurface: 'telegram' })`);
  await until(async () => (await visible()) === 'browser,screen,terminal,chat,artifacts,cron,settings', 'page tabs shown');
  await run(`document.getElementById('canvas-cron').click()`); await showing('cron');
  const view = await until(canvasView, 'canvas view');
  await until(() => view.getURL() === `${address}#/cron` && !view.isLoading(), 'cron page');
  assert.equal(await view.executeJavaScript('document.title'), 'Hermes Desktop', 'signed in by the shared cookie');
  await shot('cron', 1440); await shot('cron', 1120);
  assert.equal(await view.executeJavaScript('typeof workspace'), 'undefined', 'no Workspace bridge in the Canvas view');
  assert.equal(await run(`document.getElementById('home').classList.contains('hidden') && document.getElementById('browser-toolbar').classList.contains('hidden')`), true, 'the page replaces home and the toolbar');
  const slot = await run(`document.getElementById('browser-slot').getBoundingClientRect().width`);
  await until(async () => Math.abs(await view.executeJavaScript('innerWidth') - slot) <= 2, 'view fits the canvas');
  await view.executeJavaScript('window.kept = 1');
  for (const [item, hash] of [['canvas-settings', '#/settings'], ['canvas-chat', '#/'], ['canvas-artifacts', '#/artifacts']]) {
    menu.getMenuItemById(item).click(); await showing(item.slice(7));
    await until(() => view.getURL() === `${address}${hash}`, hash);
  }
  assert.equal(await view.executeJavaScript('window.kept'), 1, 'switching pages does not reload Hermes Desktop');
  assert.equal(canvasView(), view, 'one Canvas view serves every page');
  await run(`document.getElementById('canvas-artifacts').focus(); document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))`);
  await showing('settings');
  await run(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))`);
  await showing('cron');
  // Hermes Desktop closes its Cron overlay by navigating; picking the tab again reopens it.
  await view.executeJavaScript(`location.hash = '#/'`);
  await until(() => view.getURL() === `${address}#/`, 'overlay closed');
  await run(`document.getElementById('canvas-cron').click()`);
  await until(() => view.getURL() === `${address}#/cron`, 'cron reopened');
  assert.equal(await view.executeJavaScript('window.kept'), 1);

  // Page tabs are remembered per bot like the others.
  await pick('1001'); await showing('screen');
  await pick('1002'); await showing('cron');
  await until(() => view.getURL() === `${address}#/cron`, 'cron again');

  // If Hermes Desktop goes away the canvas falls back to Browser but keeps the choice.
  statusUp = false; await run(`workspace.command('webapp-retry')`);
  await showing('browser');
  assert.equal(await visible(), 'browser,screen,terminal');
  assert.equal(saved().canvasTabs['1002'], 'cron');
  statusUp = true; await run(`workspace.command('webapp-retry')`);
  await showing('cron');

  // A host without sign-in has no page tabs until its one-use link is open in the chat view, then they share that credential.
  const privateAddress = `http://127.0.0.1:${privateServer.address().port}/`;
  await run(`workspace.command('settings', { hermesWebappUrl: ${JSON.stringify(privateAddress)} })`);
  await until(async () => (await state()).webappStatus === 'needs-link', 'private host checked');
  await showing('browser');
  assert.equal(await visible(), 'browser,screen,terminal');
  assert.equal(canvasView(), undefined, 'the old host’s Canvas view is closed');
  await run(`workspace.command('webapp-link', { url: 'http://127.0.0.1:9120/webapp/launch#ticket=${'T'.repeat(43)}' })`);
  await until(async () => (await visible()) === 'browser,screen,terminal,chat,artifacts,cron,settings', 'page tabs after the link');
  await run(`document.getElementById('canvas-cron').click()`); await showing('cron');
  const linked = await until(canvasView, 'private canvas view');
  await until(() => linked.getURL() === `${privateAddress}#/cron` && !linked.isLoading(), 'private cron page');
  assert.equal(await linked.executeJavaScript('document.title'), 'Hermes Desktop', 'the Canvas view got the link’s credential');
  assert.equal(await linked.executeJavaScript('typeof workspace'), 'undefined', 'no Workspace bridge in the Canvas view');
  assert.equal(JSON.stringify(saved()).includes('K'.repeat(43)), false, 'the credential is never saved');
  console.log('PASS canvas tabs: click, per-bot memory, arrow keys, ⌘1–⌘7, collapsed pane, Hermes Desktop pages (cookie and one-use-link hosts), saved preferences.');
  server.close(); privateServer.close();
  quitFixture();
// app.quit() would exit 0 and hide the failure.
})().catch((error) => { console.error(error); app.exit(1); });
