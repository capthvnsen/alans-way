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

let server, other, statusUp = false;
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
    if (req.url === '/api/status') {
      res.writeHead(statusUp ? 200 : 502, { 'Content-Type': 'application/json' });
      return res.end(statusUp ? '{"version":"0.23.0"}' : '{}');
    }
    if (req.url === '/away') { res.writeHead(302, { Location: `${elsewhere}/redirected` }); return res.end(); }
    if (req.url === '/signin') { res.writeHead(302, { Location: '/', 'Set-Cookie': 'webapp-login=yes; Max-Age=3600; HttpOnly' }); return res.end(); }
    if (req.url === '/' && !/webapp-login/.test(req.headers.cookie || '')) { res.writeHead(302, { Location: '/login' }); return res.end(); }
    res.setHeader('Content-Type', 'text/html');
    // The header the real Webapp sends: it rules out an iframe, not a top-level view.
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    res.end(`<!doctype html><title>${req.url === '/login' ? 'Sign in' : 'Webapp fixture'}</title><main>Webapp</main>`);
  }, 'localhost');
  const address = `http://localhost:${server.address().port}/`, origin = address.slice(0, -1);
  // A loopback Hermes without sign-in, as reached through an SSH tunnel.
  const launches = [];
  const privateServer = await listen((req, res) => {
    if (req.url === '/api/status') { res.setHeader('Content-Type', 'application/json'); return res.end('{"version":"0.23.0","auth_required":false}'); }
    if (req.url === '/webapp/launch') { res.setHeader('Content-Type', 'text/html'); return res.end('<script>fetch("/ticket?" + location.hash.slice(8)).then(() => { sessionStorage.signedIn = "yes"; location.replace("/"); })</script>'); }
    if (req.url.startsWith('/ticket?')) { launches.push(req.url.slice(8)); return res.end(); }
    res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Private webapp</title>');
  }, '127.0.0.1');
  const privateAddress = `http://127.0.0.1:${privateServer.address().port}`;
  const prefsFile = path.join(profile, 'preferences.json');
  fs.writeFileSync(prefsFile, JSON.stringify({ onboarded: true, preview: false,
    bots: [{ id: '4242', isBot: true, name: 'Embed fixture' }], selectedBotId: '4242' }));
  require('../src/main.cjs');

  const win = await until(() => BrowserWindow.getAllWindows()[0], 'workspace window');
  const shell = win.webContents;
  await until(() => !shell.isLoading() && shell.getURL().endsWith('index.html'), 'workspace page');
  const run = (expression) => shell.executeJavaScript(expression);
  const state = () => run('workspace.getState()');
  const settings = (value) => run(`workspace.command('settings', ${JSON.stringify(value)})`);
  const saved = () => JSON.parse(fs.readFileSync(prefsFile, 'utf8'));
  const showing = (slot) => until(() => run(`['telegram-slot', 'webapp-slot'].every(id => document.getElementById(id).classList.contains('hidden') !== (id === '${slot}'))`), `${slot} showing`);
  const helpSays = (text) => until(() => run(`document.getElementById('webapp-help').textContent.includes(${JSON.stringify(text)})`), `help says ${text}`);
  const statusIs = (status) => until(async () => (await state()).webappStatus === status, `status ${status}`);
  const webappPartition = session.fromPartition('persist:hermes-webapp');
  const browserPartition = session.fromPartition('persist:browser');
  const webappViews = () => webContents.getAllWebContents().filter(contents => contents.session === webappPartition && !contents.isDestroyed());
  const opened = () => webContents.getAllWebContents().filter(contents => contents.session === browserPartition && !contents.isDestroyed());
  const openedAt = (url) => opened().find(contents => contents.getURL().startsWith(url));

  // Default: nothing configured stays on Telegram, with no view and no setting forced.
  await statusIs('unconfigured');
  assert.equal((await state()).chatSurface, 'telegram');
  await showing('telegram-slot');
  assert.equal(webappViews().length, 0);

  // Configured but not answering stays on Telegram too.
  await settings({ hermesWebappUrl: address });
  await statusIs('unreachable');
  assert.equal((await state()).chatTarget, 'telegram');
  assert.equal(webappViews().length, 0);

  // Bad addresses are refused and leave the saved one alone.
  await assert.rejects(settings({ hermesWebappUrl: 'https://example.com/' }), /ts\.net/);
  assert.equal(saved().hermesWebappUrl, address);

  // Choosing Hermes Desktop persists and explains what is missing, inline.
  await settings({ hermesWebappUrl: '', chatSurface: 'hermes-desktop' });
  assert.equal(saved().chatSurface, 'hermes-desktop');
  await showing('webapp-slot');
  await helpSays('no address yet');
  await settings({ hermesWebappUrl: address });
  await helpSays('hermes webapp --status');
  assert.equal(webappViews().length, 0, 'an unreachable address opens no view');

  // Try again recovers once the host answers, and the view then asks for sign-in.
  statusUp = true;
  await run(`[...document.querySelectorAll('#webapp-help button')].find(button => button.textContent === 'Try again').click()`);
  const view = await until(() => webappViews()[0], 'webapp view');
  await statusIs('sign-in');
  await until(() => view.getURL() === `${origin}/login`, 'sign-in page');
  await view.executeJavaScript(`location.href = '/signin'; void 0`);
  await statusIs('ready');
  await until(() => view.getURL() === `${origin}/` && !view.isLoading(), 'webapp page');
  assert.equal(await view.executeJavaScript('document.title'), 'Webapp fixture', 'frame-ancestors does not block a top-level view');
  const slotWidth = await run(`document.getElementById('webapp-slot').getBoundingClientRect().width`);
  await until(async () => Math.abs(await view.executeJavaScript('innerWidth') - (slotWidth - 2)) <= 1, 'view fits the chat pane');

  // Settings shows the choice and the status; changing the select applies it.
  await run(`document.getElementById('settings-fallback').click()`);
  await until(() => run(`document.getElementById('settings-chat-surface')?.value === 'hermes-desktop' && document.getElementById('settings-webapp-status').textContent.includes('signed in')`), 'Settings status');
  await run(`(() => { const select = document.getElementById('settings-chat-surface'); select.value = 'telegram'; select.dispatchEvent(new Event('change')); })()`);
  await until(() => saved().chatSurface === 'telegram', 'choice persisted from Settings');
  await until(async () => (await state()).chatTarget === 'telegram', 'Settings switches the pane');
  await run(`document.getElementById('modal-close').click()`);

  // Switching back and forth keeps both surfaces alive and unreloaded.
  const telegram = await until(() => webContents.getAllWebContents().find(contents => contents.session === session.fromPartition('persist:telegram')), 'telegram view');
  await view.executeJavaScript('window.kept = "webapp"');
  await telegram.executeJavaScript('window.kept = "telegram"');
  for (const choice of ['hermes-desktop', 'telegram', 'hermes-desktop']) {
    await settings({ chatSurface: choice });
    await showing(choice === 'telegram' ? 'telegram-slot' : 'webapp-slot');
    assert.equal(await view.executeJavaScript('window.kept'), 'webapp');
    assert.equal(await telegram.executeJavaScript('window.kept'), 'telegram');
  }
  assert.equal(webappViews().length, 1);

  // Selecting a bot keeps the chosen surface; the Telegram row is the way across and back.
  await run(`workspace.command('open-bot', { id: '4242' })`);
  await showing('webapp-slot');
  await run(`workspace.command('show-telegram')`);
  await showing('telegram-slot');
  await run(`[...document.querySelectorAll('#hermes-list .bot-open')].find(button => button.textContent === 'Hermes Desktop').click()`);
  await showing('webapp-slot');
  assert.equal(await view.executeJavaScript('window.kept'), 'webapp');

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

  // A Webapp without sign-in opens from a pasted one-use link; changing the address replaces the view.
  const ticket = 'T'.repeat(43);
  await settings({ hermesWebappUrl: `${privateAddress}/` });
  await until(() => view.isDestroyed(), 'old view closed');
  await statusIs('needs-link');
  await helpSays('hermes webapp --no-open');
  assert.equal(webappViews().length, 0, 'no view until a link arrives');
  await assert.rejects(run(`workspace.command('webapp-link', { url: 'http://127.0.0.1:9120/webapp/launch#ticket=short' })`), /one-use link/);
  await run(`(() => { document.getElementById('webapp-link').value = 'http://127.0.0.1:9120/webapp/launch#ticket=${ticket}'; [...document.querySelectorAll('#webapp-help button')].find(button => button.textContent === 'Open').click(); })()`);
  await statusIs('ready');
  const linked = await until(() => webappViews()[0], 'linked view');
  await until(() => linked.getURL() === `${privateAddress}/` && !linked.isLoading(), 'linked webapp');
  assert.deepEqual(launches, [ticket], 'the host printed port is rebased onto the saved address');
  assert.equal(await linked.executeJavaScript('sessionStorage.signedIn'), 'yes');
  assert.equal(JSON.stringify(saved()).includes(ticket), false, 'the link is never saved');
  await settings({ chatSurface: 'telegram' });
  await settings({ chatSurface: 'hermes-desktop' });
  assert.equal(await linked.executeJavaScript('sessionStorage.signedIn'), 'yes', 'switching keeps the link sign-in');

  // Clearing the address falls back to the help.
  await settings({ hermesWebappUrl: '' });
  await until(() => linked.isDestroyed(), 'linked view closed');
  await helpSays('no address yet');
  console.log('webapp embed: ok');
  quitFixture(server, other, privateServer);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
  server?.closeAllConnections(); other?.closeAllConnections();
  app.exit(1);
});
