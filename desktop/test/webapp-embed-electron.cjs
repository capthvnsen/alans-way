// Real main, preload and renderer against a local stand-in for the Hermes Webapp.
// Run: npm run test:webapp-embed
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const electron = require('electron');
const { app, BrowserWindow, session, webContents, dialog } = electron;
const { prepareFixture, quitFixture } = require('./electron-fixture.cjs');

const profile = process.env.HERMES_TEST_PROFILE;
prepareFixture(profile);
process.env.HERMES_WORKSPACE_ALLOW_LOOPBACK = '1';
const prompts = [];
dialog.showMessageBox = async (_win, options) => { prompts.push(options.message); return { response: 0 }; };

let server, other;
const until = async (read, why, ms = 15000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out: ${why}`);
    await new Promise(resolve => setTimeout(resolve, 40));
  }
};
const listen = (handler, host) => new Promise(resolve => { const s = http.createServer(handler); s.listen(0, host, () => resolve(s)); });

(async () => {
  other = await listen((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Elsewhere</title>'); }, '127.0.0.1');
  const elsewhere = `http://127.0.0.1:${other.address().port}`;
  server = await listen((req, res) => {
    if (req.url === '/away') { res.writeHead(302, { Location: `${elsewhere}/redirected` }); return res.end(); }
    res.setHeader('Content-Type', 'text/html');
    // The header the real Webapp sends: it rules out an iframe, not a top-level view.
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    res.setHeader('Set-Cookie', 'webapp-login=yes; Max-Age=3600; HttpOnly');
    res.end('<!doctype html><title>Webapp fixture</title><main>Webapp</main>');
  }, 'localhost');
  const origin = `http://localhost:${server.address().port}`;
  fs.writeFileSync(path.join(profile, 'preferences.json'), JSON.stringify({ onboarded: true, preview: false, hermesWebappUrl: `${origin}/`,
    bots: [{ id: '4242', isBot: true, name: 'Embed fixture' }], selectedBotId: '4242' }));
  require('../src/main.cjs');

  const win = await until(() => BrowserWindow.getAllWindows()[0], 'workspace window');
  const shell = win.webContents;
  await until(() => !shell.isLoading() && shell.getURL().endsWith('index.html'), 'workspace page');
  const run = (expression) => shell.executeJavaScript(expression);
  const state = () => run('workspace.getState()');
  await until(async () => (await state()).hermesWebapp, 'opt-in visible in state');
  await until(() => run(`[...document.querySelectorAll('#hermes-list .bot-open')].some(button => button.textContent === 'Hermes Webapp')`), 'sidebar row');

  const webappPartition = session.fromPartition('persist:hermes-webapp');
  const browserPartition = session.fromPartition('persist:browser');
  const opened = () => webContents.getAllWebContents().filter(contents => contents.session === browserPartition && !contents.isDestroyed());
  const openedAt = (url) => opened().find(contents => contents.getURL().startsWith(url));
  assert.equal(webContents.getAllWebContents().some(contents => contents.session === webappPartition), false, 'the opt-in view is created on first use');

  await run(`[...document.querySelectorAll('#hermes-list .bot-open')].find(button => button.textContent === 'Hermes Webapp').click()`);
  const view = await until(() => webContents.getAllWebContents().find(contents => contents.session === webappPartition), 'webapp view');
  await until(() => view.getURL() === `${origin}/` && !view.isLoading(), 'webapp page');
  assert.equal(await view.executeJavaScript('document.title'), 'Webapp fixture', 'frame-ancestors does not block a top-level view');

  await until(async () => (await state()).chatTarget === 'webapp', 'chat target');
  await until(() => run(`document.getElementById('telegram-slot').classList.contains('hidden') && !document.getElementById('webapp-slot').classList.contains('hidden') && document.getElementById('chat-title').textContent === 'Hermes Webapp'`), 'pane swap');
  const slotWidth = await run(`document.getElementById('webapp-slot').getBoundingClientRect().width`);
  await until(async () => Math.abs(await view.executeJavaScript('innerWidth') - (slotWidth - 2)) <= 1, 'view fits the chat pane');

  assert.equal(await view.executeJavaScript('typeof window.workspace + typeof window.hermes'), 'undefinedundefined', 'no Workspace bridge');
  assert.equal((await webappPartition.cookies.get({ name: 'webapp-login' })).length, 1, 'sign-in cookie lands in the webapp partition');
  assert.equal((await browserPartition.cookies.get({ name: 'webapp-login' })).length, 0, 'sign-in cookie never reaches the browser partition');

  assert.equal(await view.executeJavaScript('Notification.requestPermission()', true), 'denied');
  assert.equal(prompts.length, 1, 'permissions go through the site prompt');

  // Links leave for the Browser pane, the Webapp stays put, child windows are refused.
  const before = opened().length;
  await view.executeJavaScript(`void window.open('${origin}/child')`, true);
  await view.executeJavaScript(`void window.open('${elsewhere}/popup')`, true);
  await until(() => openedAt(`${elsewhere}/popup`), 'off-origin popup opens a Browser tab');
  assert.equal(opened().length, before + 1, 'a same-origin child window opens nothing');
  await view.executeJavaScript(`location.href = '${elsewhere}/link'; void 0`);
  await until(() => openedAt(`${elsewhere}/link`), 'off-origin navigation opens a Browser tab');
  await view.executeJavaScript(`location.href = '${origin}/away'; void 0`);
  await until(() => openedAt(`${elsewhere}/redirected`), 'off-origin redirect opens a Browser tab');
  assert.equal(new URL(view.getURL()).origin, origin, 'the main frame stays on the Webapp');

  // Webapp URL previews are off-origin iframes; a redirect inside one must not be intercepted.
  const tabsBefore = opened().length;
  await view.executeJavaScript(`new Promise(done => { const frame = document.createElement('iframe'); frame.onload = done; frame.src = '${origin}/away'; document.body.append(frame); }).then(() => undefined)`);
  assert.equal(view.mainFrame.frames[0].url, `${elsewhere}/redirected`);
  assert.equal(opened().length, tabsBefore, 'a subframe redirect opens no tab');

  // The agent's route to the right-hand pane does not depend on the chat surface.
  const connection = JSON.parse(fs.readFileSync(path.join(profile, 'connection.json'), 'utf8'));
  const response = await fetch(new URL('/v1/tabs', connection.url), { method: 'POST',
    headers: { Authorization: `Bearer ${connection.token}`, 'X-Hermes-Bot': '4242', 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: `${elsewhere}/agent`, background: false }) });
  assert.equal(response.status, 201);
  const created = await response.json();
  await until(async () => { const now = await state(); return now.activeTabId === created.id && now.chatTarget === 'webapp'; }, 'agent tab foregrounds beside the webapp');
  assert.equal(view.isDestroyed(), false);

  await run(`workspace.command('show-telegram')`);
  await until(() => run(`!document.getElementById('telegram-slot').classList.contains('hidden') && document.getElementById('webapp-slot').classList.contains('hidden')`), 'way back to Telegram');
  console.log('webapp embed: ok');
  quitFixture(server, other);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
  server?.closeAllConnections(); other?.closeAllConnections();
  app.exit(1);
});
