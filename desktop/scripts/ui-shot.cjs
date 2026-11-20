// Screenshots of the real app for agents that cannot look at a screen: runs it hidden (see src/hidden-mode.cjs) with a
// throwaway profile and fake data only, drives it to a few named states and writes one PNG per state.
//   npm run ui:shot -- --out <dir> [--state home|chat|compact|settings|newtab]
const fs = require('node:fs');
const path = require('node:path');

const WIDTH = 1440, HEIGHT = 900;
const STATES = ['home', 'chat', 'compact', 'settings', 'newtab'];
const KEY = 'mock-key-0000000000000001';

if (!process.versions.electron) {
  const http = require('node:http');
  const { spawn } = require('node:child_process');
  const { createMock } = require('../test/native-chat-mock.cjs');
  const { privateTmp } = require('../test/with-tmp.cjs');
  const { hiddenEnv, watchdog } = require('../test/hidden-env.cjs');
  const arg = name => { const at = process.argv.indexOf(`--${name}`); return at < 0 ? '' : process.argv[at + 1] || ''; };
  const out = path.resolve(arg('out') || '');
  const only = arg('state');
  if (!arg('out') || (only && !STATES.includes(only))) { console.error(`Usage: npm run ui:shot -- --out <dir> [--state ${STATES.join('|')}]`); process.exit(2); }
  fs.mkdirSync(out, { recursive: true });
  (async () => {
    const tmp = privateTmp({ strict: false });
    const profile = fs.mkdtempSync(path.join(tmp.dir, 'ui-shot-'));
    const mock = await createMock({ key: KEY }).listen();
    // Stands in for Hermes Desktop at a bot's address; one bot points at a port nothing listens on.
    const webapp = http.createServer((req, res) => {
      if (req.url === '/api/status') { res.setHeader('Content-Type', 'application/json'); return res.end('{"version":"0.23.0"}'); }
      res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Hermes Desktop</title><main>Hermes Desktop</main>');
    });
    await new Promise(resolve => webapp.listen(0, '127.0.0.1', resolve));
    const { env, binary } = hiddenEnv({ ...process.env, ...tmp.env });
    Object.assign(env, { HERMES_TEST_PROFILE: profile, SHOT_OUT: out, SHOT_STATE: only, NATIVE_CHAT_URL: mock.url, WEBAPP_URL: `http://127.0.0.1:${webapp.address().port}/` });
    const child = spawn(binary, [`--user-data-dir=${profile}`, __filename], { env, stdio: 'inherit' });
    const deadline = setTimeout(() => { console.error('ui:shot exceeded 120s.'); child.kill('SIGKILL'); }, 120000);
    let aborted = false;
    const stop = watchdog(child, reason => { aborted = true; console.error(`WATCHDOG ABORT: ${reason}`); });
    child.once('close', code => {
      clearTimeout(deadline); stop(); mock.close(); webapp.closeAllConnections(); webapp.close();
      const clean = tmp.finish();
      process.exit(aborted ? 99 : code || (clean ? 0 : 1));
    });
  })();
} else {
  const assert = require('node:assert/strict');
  const { app, BrowserWindow, session } = require('electron');
  const { prepareFixture, quitFixture } = require('../test/electron-fixture.cjs');
  if (!require('../src/hidden-mode.cjs').isHidden()) { console.error('ui:shot only runs in the hidden mode.'); app.exit(2); }
  const profile = process.env.HERMES_TEST_PROFILE, out = process.env.SHOT_OUT, only = process.env.SHOT_STATE;
  prepareFixture(profile);
  // Fixed fake bots: Alan is open, Scout has unread messages, Quill's Hermes Desktop is unreachable, Relay is working, Nova waits for you.
  const bots = [
    { id: '1001', isBot: true, name: 'Alan', username: 'alan_bot', preview: 'Booked the 3pm.' },
    { id: '1002', isBot: true, name: 'Scout Research Assistant', username: 'scout_bot', unread: 3, preview: 'Three sources agree.' },
    { id: '1003', isBot: true, name: 'Quill', username: 'quill_bot', preview: 'Draft is ready.' },
    { id: '1004', isBot: true, name: 'Relay', username: 'relay_bot', preview: 'Checking the inbox.' },
    { id: '1005', isBot: true, name: 'Nova', username: 'nova_bot', preview: 'Needs your approval.' },
  ];
  fs.writeFileSync(path.join(profile, 'preferences.json'), JSON.stringify({ onboarded: true, preview: false, hermesWebappUrl: process.env.WEBAPP_URL,
    bots, selectedBotId: '1001', order: bots.map(bot => bot.id) }));
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (read, why, ms = 20000) => {
    for (const end = Date.now() + ms; ; await sleep(25)) { const value = await read(); if (value) return value; if (Date.now() > end) throw new Error(`Timed out: ${why}`); }
  };
  // Nothing leaves the machine: pages load from files and the loopback fixtures only.
  app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest((details, callback) =>
    callback({ cancel: !/^(file|devtools|data|blob):|^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(details.url) })));
  require('../src/main.cjs');

  (async () => {
    const win = await until(() => BrowserWindow.getAllWindows()[0], 'workspace window');
    const shell = win.webContents;
    await until(() => !shell.isLoading() && shell.getURL().endsWith('index.html'), 'workspace page');
    const run = expression => shell.executeJavaScript(expression);
    win.setContentSize(WIDTH, HEIGHT);

    // What the fake bots are doing cannot come from a live Telegram, so the state the window receives is decorated.
    const overlay = state => {
      const inbox = JSON.parse(JSON.stringify(state.inbox || {}));
      if (inbox['1005']?.rows?.native) inbox['1005'].rows.native.waiting = true;
      for (const [id, row] of Object.entries(inbox)) row.surface = id === '1003' ? 'hermes-desktop' : 'native';
      return { ...state, inbox, webappStatus: 'unreachable',
        bots: state.bots.map(bot => bot.id === '1004' ? { ...bot, activity: { state: 'active', label: 'Typing', expiresAt: Date.now() + 3.6e6 } }
          : bot.id === '1001' || bot.id === '1002' ? { ...bot, activity: { state: 'idle' } } : bot) };
    };
    const send = shell.send.bind(shell);
    shell.send = (channel, payload, ...rest) => send(channel, channel === 'workspace:state' ? overlay(payload) : payload, ...rest);
    const push = async () => send('workspace:state', overlay(await run('workspace.getState()')));

    const settle = async contents => {
      await contents.insertCSS('*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}');
      await contents.executeJavaScript('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
      await sleep(300);
    };
    const shoot = async (name, contents = shell) => {
      await settle(contents);
      const image = await contents.capturePage();
      assert.ok(!image.isEmpty(), `${name}: the page painted nothing`);
      // Retina and non-retina machines differ only in scale, so every shot is brought to the same pixel size.
      const fixed = image.getSize().width === WIDTH ? image : image.resize({ width: WIDTH, height: HEIGHT, quality: 'best' });
      fs.writeFileSync(path.join(out, `${name}.png`), fixed.toPNG());
      console.log(`wrote ${name}.png`);
    };
    const wanted = name => !only || only === name;

    await run(`workspace.command('settings', { nativeChatUrl: ${JSON.stringify(process.env.NATIVE_CHAT_URL)}, nativeChatKey: ${JSON.stringify(KEY)} })`);
    await until(async () => (await run('nativeChat.getState()')).configured, 'native chat configured');
    await run(`workspace.command('open-bot', { id: '1001', surface: 'native' })`);
    await until(async () => (await run('workspace.getState()')).chatTarget === 'native', 'native chat shown');
    await push();
    await until(() => run(`document.querySelectorAll('#bot-list .bot-row').length === ${bots.length}`), 'bot rows');
    if (wanted('home')) await shoot('home');

    const conversation = await until(async () => (await run('nativeChat.getState()')).sessions?.find(s => s.title === 'pong: hello world'), 'the mock conversation');
    await run(`nativeChat.command('open', { sessionId: ${JSON.stringify(conversation.id)} })`);
    await until(() => run(`document.querySelectorAll('#native-pane .nc-row[data-id]').length > 1`), 'chat messages');
    // Rendering the long reply grows the list after the first paint, so each shot waits for the bottom to hold still.
    const bottom = async () => {
      const edge = () => run(`(() => { const s = document.querySelector('#native-pane .nc-scroll'); s.scrollTop = s.scrollHeight; return s.scrollHeight; })()`);
      for (let last = -1, now = await edge(); now !== last; await sleep(250)) { last = now; now = await edge(); }
    };
    if (wanted('chat')) { await bottom(); await shoot('chat'); }

    if (wanted('compact')) {
      // The chip shows when the send would compact first; the engine only knows context size on a live gateway.
      shell.send = (channel, payload, ...rest) => send(channel, channel === 'workspace:state' ? overlay(payload)
        : channel === 'native:state' ? { ...payload, compact: { usedTokens: 164000, windowTokens: 200000, idleSince: Date.now() } } : payload, ...rest);
      send('native:state', { ...(await run('nativeChat.getState()')), compact: { usedTokens: 164000, windowTokens: 200000, idleSince: Date.now() } });
      await until(() => run(`!document.querySelector('.nc-compact-chip')?.classList.contains('hidden')`), 'compact chip');
      await bottom();
      await shoot('compact');
    }

    if (wanted('settings')) {
      await run(`document.getElementById('settings-fallback').click()`);
      await until(() => run(`!document.getElementById('modal').classList.contains('hidden')`), 'settings open');
      await shoot('settings');
      await run(`document.getElementById('modal-close').click()`);
    }

    if (wanted('newtab')) {
      const page = new BrowserWindow({ show: false, width: WIDTH, height: HEIGHT, useContentSize: true, backgroundColor: '#09090a', webPreferences: { sandbox: true, backgroundThrottling: false } });
      await page.loadFile(path.join(__dirname, '../src/newtab.html'));
      await shoot('newtab', page.webContents);
    }
    quitFixture();
  })().catch(error => { console.error(error); app.exit(1); });
}
