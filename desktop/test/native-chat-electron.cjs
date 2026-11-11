// Alan's native chat end to end: real main, preload and renderer against the
// in-process Hermes API mock (default, CI-safe) or, with NATIVE_CHAT_LAB=1, the
// real lab Hermes on 127.0.0.1:18642. Two launches share one throwaway profile:
// the second proves the last thread paints from the disk cache before any network.
// Run: npm run test:native-chat
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LAB = process.env.NATIVE_CHAT_LAB === '1';
// Throwaway keys: the mock's own, and the lab's (a scratch Hermes, never a real one).
const MOCK_KEY = 'mock-key-0000000000000001', LAB_KEY = 'lab-key-local-throwaway-0001';

if (!process.versions.electron) {
  const { spawn } = require('node:child_process');
  const { createMock } = require('./native-chat-mock.cjs');
  (async () => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'native-chat-electron-'));
    const mock = LAB ? null : await createMock({ key: MOCK_KEY }).listen();
    let failed = false;
    for (const phase of ['1', '2']) {
      if (mock) { mock.delayMs = phase === '2' ? 2500 : 0; mock.served = 0; }
      const code = await new Promise((resolve) => {
        const child = spawn(require('electron'), [`--user-data-dir=${profile}`, __filename], { stdio: 'inherit',
          env: { ...process.env, HERMES_TEST_PROFILE: profile, NATIVE_CHAT_PHASE: phase, NATIVE_CHAT_URL: mock ? mock.url : 'http://127.0.0.1:18642', NATIVE_CHAT_KEY: mock ? MOCK_KEY : LAB_KEY, NATIVE_CHAT_STATS: mock ? `${mock.url}/__stats` : '' } });
        const deadline = setTimeout(() => { console.error(`Phase ${phase} exceeded 150s.`); child.kill('SIGKILL'); }, 150000);
        child.once('close', (exit, signal) => { clearTimeout(deadline); resolve(signal ? 1 : exit); });
      });
      if (code !== 0) { failed = true; break; }
    }
    if (mock) {
      const origins = mock.requests.filter((r) => r.headers.origin !== undefined);
      if (origins.length) { console.error('A request carried an Origin header:', origins[0].path); failed = true; }
      mock.close();
    }
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    console.log(failed ? 'native chat: FAILED' : `native chat: ok (${LAB ? 'lab' : 'mock'})`);
    process.exit(failed ? 1 : 0);
  })();
} else {
  const assert = require('node:assert/strict');
  const { app, BrowserWindow } = require('electron');
  const { prepareFixture, quitFixture } = require('./electron-fixture.cjs');
  const profile = process.env.HERMES_TEST_PROFILE, phase = process.env.NATIVE_CHAT_PHASE;
  prepareFixture(profile);
  const prefsFile = path.join(profile, 'preferences.json');
  if (phase === '1') fs.writeFileSync(prefsFile, JSON.stringify({ onboarded: true, preview: false }));
  const until = async (read, why, ms = 20000) => {
    const end = Date.now() + ms;
    for (;;) {
      const value = await read();
      if (value) return value;
      if (Date.now() > end) throw new Error(`Timed out: ${why}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  const stats = async () => (process.env.NATIVE_CHAT_STATS ? (await (await fetch(process.env.NATIVE_CHAT_STATS)).json()).served : -1);
  const timings = {};
  require('../src/main.cjs');

  (async () => {
    const win = await until(() => BrowserWindow.getAllWindows()[0], 'workspace window');
    const shell = win.webContents;
    // Paint timings and content-visibility need real frames even when another app covers the window.
    shell.setBackgroundThrottling(false);
    win.show();
    await until(() => !shell.isLoading() && shell.getURL().endsWith('index.html'), 'workspace page');
    const run = (expression) => shell.executeJavaScript(expression);
    const native = () => run('nativeChat.getState()');
    // After a frame: content-visibility rows only lay out once they have been rendered.
    const rows = () => run(`new Promise(resolve => requestAnimationFrame(() => resolve([...document.querySelectorAll('#native-pane .nc-list > .nc-row')].map(row => ({ role: row.classList.contains('user') ? 'user' : row.classList.contains('assistant') ? 'assistant' : 'card', text: (row.innerText.trim() || row.textContent).replace(/\\s*Copy$/, '').trim() })))))`);
    const marksAfter = (name, t0) => run(`(window.__nativeChatMarks || []).filter(m => m.name === ${JSON.stringify(name)} && m.t >= ${t0}).map(m => m.t)`);
    const visible = (selector) => run(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); return !!node && !!node.offsetParent; })()`);
    const click = (selector) => run(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const idle = () => until(async () => !(await native()).run, 'reply finished', 30000);
    const type = async (text) => {
      await until(() => visible('#native-pane .nc-send'), 'send button');
      await run(`(() => { const box = document.querySelector('#native-pane textarea'); box.value = ${JSON.stringify(text)}; box.dispatchEvent(new Event('input')); box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
    };
    const send = async (text) => {
      await type(text);
      await until(async () => (await rows()).some((row) => row.role === 'user' && row.text === text), `user bubble ${text}`);
      await idle();
    };
    const openSession = async (id) => {
      await click('#native-pane .nc-switch');
      await until(() => visible(`#native-pane .nc-menu-item[data-id="${id}"]`), `menu item ${id}`);
      const t0 = await run(`(() => { const t = performance.now(); document.querySelector('#native-pane .nc-menu-item[data-id="${id}"]').click(); return t; })()`);
      await until(async () => (await native()).activeId === id, `active ${id}`);
      return t0;
    };
    const painted = async (t0, why) => (await until(async () => (await marksAfter('thread-painted', t0))[0], why)) - t0;

    if (phase === '1') {
      // Configure through Settings: Save, Test, then pick the surface.
      await run(`document.getElementById('settings-fallback').click()`);
      await until(() => visible('#settings-native-url'), 'native settings');
      assert.equal(await run(`document.querySelector('#settings-chat-surface option[value="native"]').disabled`), true, 'not selectable before it is configured');
      await run(`(() => { for (const [id, value] of [['settings-native-url', ${JSON.stringify(process.env.NATIVE_CHAT_URL)}], ['settings-native-key', ${JSON.stringify(process.env.NATIVE_CHAT_KEY)}]]) { const input = document.getElementById(id); input.value = value; input.dispatchEvent(new Event('input')); } document.getElementById('settings-native-save').click(); })()`);
      await until(async () => (await run(`document.getElementById('settings-native-status').textContent`)) === 'Saved.', 'saved');
      assert.equal(JSON.stringify(fs.readFileSync(path.join(profile, 'native-chat.json'), 'utf8')).includes(process.env.NATIVE_CHAT_KEY), false, 'the key is never stored in plain text');
      assert.equal(fs.readFileSync(prefsFile, 'utf8').includes(process.env.NATIVE_CHAT_KEY), false);
      assert.equal(JSON.stringify(await run('workspace.getState()')).includes(process.env.NATIVE_CHAT_KEY), false, 'the key never reaches the renderer');
      await click('#settings-native-test');
      await until(async () => /^Connected/.test(await run(`document.getElementById('settings-native-status').textContent`)), 'test connected');
      await until(() => run(`!document.querySelector('#settings-chat-surface option[value="native"]').disabled`), 'surface selectable');
      await run(`(() => { const select = document.getElementById('settings-chat-surface'); select.value = 'native'; select.dispatchEvent(new Event('change')); })()`);
      await until(async () => (await run('workspace.getState()')).chatTarget === 'native', 'native surface');
      assert.equal(JSON.parse(fs.readFileSync(prefsFile, 'utf8')).chatSurface, 'native');
      await click('#modal-close');
      await until(() => visible('#native-pane .nc-composer'), 'native pane');
      assert.equal(await run(`(() => { const box = document.querySelector('#native-pane textarea'); return box.scrollHeight <= box.clientHeight; })()`), true, 'the empty composer shows a whole line');

      // The newest conversation opens by itself and shows its history as bubbles.
      await until(async () => (await native()).activeId, 'a conversation opened');
      await until(async () => (await rows()).length > 0, 'history bubbles');
      if (!LAB) {
        const history = await rows();
        assert.deepEqual(history.map((row) => row.role), ['user', 'assistant', 'user', 'assistant']);
        assert.equal(history[1].text, 'pong: hello world');
        assert.ok(await visible('#native-pane .nc-row.assistant .nc-table table'));
      }

      // New chat, then a streamed reply.
      await click('#native-pane .nc-new');
      await until(async () => (await run(`document.querySelector('#native-pane .nc-empty').textContent`)) === 'New conversation. Say hello.', 'new chat empty state');
      let t0 = await run('performance.now()');
      await send('hello world');
      const sendMark = (await marksAfter('send', t0))[0], tokenMark = (await marksAfter('first-token', t0))[0];
      assert.ok(sendMark && tokenMark, 'send and first-token marks');
      timings.firstTokenMs = Math.round(tokenMark - sendMark);
      await until(async () => (await rows()).some((row) => row.role === 'assistant' && row.text === 'pong: hello world'), 'streamed reply');
      const chatId = (await native()).activeId;
      if (LAB) await until(async () => (await run(`document.querySelector('#native-pane .nc-switch-title').textContent`)) !== 'Untitled chat', 'Hermes names the new chat');

      // Markdown: table (scrollable, Copy as markdown) and a fenced code block with its label.
      await send('MD please');
      await until(() => run(`!![...document.querySelectorAll('#native-pane .nc-row.assistant')].at(-1)?.querySelector('.nc-table table')`), 'table');
      const md = await run(`(() => { const row = [...document.querySelectorAll('#native-pane .nc-row.assistant')].at(-1); return { table: !!row.querySelector('.nc-table-scroll table th'), copyTable: row.querySelector('[data-copy-table]')?.textContent, lang: row.querySelector('.nc-code-head span')?.textContent, code: row.querySelector('.nc-code code')?.textContent, heading: row.querySelector('h1')?.textContent, math: row.querySelector('.nc-math')?.textContent }; })()`);
      assert.deepEqual(md, { table: true, copyTable: 'Copy as markdown', lang: 'js', code: 'function add(a, b) {\n  return a + b;\n}\nconsole.log(add(1, 2));\n', heading: 'Heading One', math: 'a^2+b^2' });

      // Approval card: open, answer once, answered.
      await type('APPROVE please');
      await until(() => visible('#native-pane .nc-prompt.approval.open'), 'approval card', 30000);
      assert.match(await run(`document.querySelector('#native-pane .nc-prompt.approval').innerText`), /Alan wants to run a command[\s\S]*Show details/);
      await until(async () => (await run(`document.querySelector('#native-pane .nc-status')?.textContent`)) === 'Waiting for you', 'status says it waits for you');
      assert.equal(await run(`document.querySelector('#native-pane .nc-prompt.approval details pre').textContent`), 'rm -rf /tmp/hermes-lab-nonexistent-xyz');
      const allowOnce = `[...document.querySelectorAll('#native-pane .nc-prompt.approval button')].find(b => b.textContent === 'Allow once')`;
      if (!LAB) {
        // A failed answer leaves the choices usable.
        await fetch(`${process.env.NATIVE_CHAT_URL}/__fail-approval`);
        await run(`${allowOnce}.click()`);
        await until(() => visible('#native-pane .nc-notice'), 'failure shown');
        await until(() => run(`!${allowOnce}.disabled`), 'Allow once usable again', 3000);
      }
      await run(`${allowOnce}.click()`);
      await until(() => visible('#native-pane .nc-prompt.approval.answered'), 'approval answered');
      await idle();
      await until(async () => (await rows()).filter((row) => row.role === 'user').length === 3 && (await rows()).filter((row) => row.role === 'assistant').length === 3, 'approval turn reconciled');

      if (LAB) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        fs.mkdirSync('/tmp/w1-proof', { recursive: true });
        fs.writeFileSync('/tmp/w1-proof/native-chat.png', (await shell.capturePage()).toPNG());
        const transcript = (await rows()).map((row) => `[${row.role}] ${row.text}`).join('\n\n');
        fs.writeFileSync('/tmp/w1-proof/native-chat-transcript.txt', `${transcript}\n`);
        console.log('NATIVE CHAT PROOF: /tmp/w1-proof/native-chat.png /tmp/w1-proof/native-chat-transcript.txt');
      }

      // 1,000-message conversation: first open from the network, then switches paint from memory.
      const sessions = (await native()).sessions;
      const bigId = sessions.find((s) => s.title === 'seed 1k').id, telegramId = sessions.find((s) => s.source === 'telegram').id;
      t0 = await openSession(bigId);
      timings.bigFirstOpenMs = Math.round(await painted(t0, 'big thread painted'));
      await until(async () => (await native()).thread.messages.length >= 500, 'big thread loaded');
      const switches = [];
      for (let i = 0; i < 3; i++) {
        await painted(await openSession(chatId), 'back to chat');
        switches.push(await painted(await openSession(bigId), 'big thread from memory'));
      }
      timings.bigSwitchMs = switches.map(Math.round);
      assert.ok(Math.min(...switches) < 100, `switching to the 1k thread took ${switches}`);

      // Scroll from the newest message to the very first one, loading older pages on the way.
      const scroll = await run(`new Promise(resolve => {
        const scroller = document.querySelector('#native-pane .nc-scroll'), deltas = [];
        let last = performance.now(), frames = 0;
        const step = () => {
          const now = performance.now(); deltas.push(now - last); last = now;
          scroller.scrollTop -= 700;
          const rows = scroller.querySelectorAll('.nc-list > .nc-row').length;
          if ((scroller.scrollTop === 0 && rows >= 1000) || ++frames > 1500) {
            const sorted = deltas.slice(1).sort((a, b) => a - b);
            return resolve({ frames, rows, max: Math.round(sorted.at(-1)), p95: Math.round(sorted[Math.floor(sorted.length * 0.95)]), over50: sorted.filter(d => d > 50).length });
          }
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      })`);
      timings.scroll = scroll;
      assert.ok(scroll.rows >= 1000, `all 1,000 messages reachable by scrolling (${scroll.rows})`);

      // Read-only conversations offer Continue here.
      await openSession(telegramId);
      await until(() => visible('#native-pane .nc-readonly'), 'read-only bar');
      if (!LAB) await until(() => run(`(() => { const s = document.querySelector('#native-pane .nc-scroll'); return s.scrollHeight > s.clientHeight + 200 && s.scrollHeight - s.scrollTop - s.clientHeight < 2; })()`), 'opens at the newest message', 3000);
      assert.match(await run(`document.querySelector('#native-pane .nc-readonly').innerText`), /from Telegram, so it is read-only here[\s\S]*Continue here/);
      assert.equal(await visible('#native-pane .nc-composer'), false);
      if (!LAB) {
        await run(`[...document.querySelectorAll('#native-pane .nc-readonly button')].find(b => b.textContent === 'Continue here').click()`);
        await until(async () => { const s = await native(); return s.activeId !== telegramId && !s.thread.readOnly; }, 'forked');
        await until(() => visible('#native-pane .nc-composer'), 'composer after Continue here');
        await until(async () => (await rows()).length === 6, 'fork paints the copied history');
      }

      // Leave the big thread open for the relaunch.
      await openSession(bigId);
      await new Promise((resolve) => setTimeout(resolve, 700));
    } else {
      // Relaunch: the last thread is on screen while every request is still held by the mock.
      await until(async () => (await rows().catch(() => [])).length >= 60, 'cached bubbles after relaunch', 10000);
      const served = await stats();
      if (!LAB) assert.equal(served, 0, 'painted before any network response');
      const state = await native();
      assert.equal(state.thread.title, 'seed 1k');
      const mark = await until(async () => (await marksAfter('pane-painted', 0))[0], 'pane-painted mark');
      timings.relaunchPanePaintedMs = Math.round(mark);
      timings.relaunchAfterDomReadyMs = Math.round(mark - await run(`performance.getEntriesByType('navigation')[0].domContentLoadedEventEnd`));
      timings.relaunchMessages = state.thread.messages.length;
      timings.relaunchServedWhenPainted = served;
      if (!LAB) await until(async () => (await stats()) > 0, 'background revalidation', 10000);
      await until(async () => (await native()).status === 'ready', 'revalidated', 10000);
    }
    console.log(`NATIVE CHAT TIMING phase ${phase}: ${JSON.stringify(timings)}`);
    quitFixture();
  })().catch((error) => {
    console.error(error);
    app.exit(1);
  });
}
