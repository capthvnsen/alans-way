const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const electron = require('electron');

if (typeof electron === 'string') {
  const { spawn } = require('node:child_process');
  const { once } = require('node:events');
  const { Worker } = require('node:worker_threads');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-restore-tabs-'));
  const slowReady = new SharedArrayBuffer(8);
  const server = new Worker(`
    const http = require('node:http');
    const { parentPort, workerData } = require('node:worker_threads');
    const slowReady = new Int32Array(workerData.slowReady);
    const server = http.createServer((req, res) => {
      if (req.url === '/slow' && Atomics.load(slowReady, 0) === 0) return;
      if (req.url.startsWith('/hang') && Atomics.load(slowReady, 1) === 0) return;
      const title = req.url === '/slow' ? 'slow' : 'fast';
      res.end('<!doctype html><title>' + title + '</title>');
    });
    server.listen(0, '127.0.0.1', () => parentPort.postMessage(server.address().port));
  `, { eval: true, workerData: { slowReady } });

  const launch = (phase, base) => new Promise((resolve, reject) => {
    const env = { ...process.env, HOME: profile, HERMES_WORKSPACE_DATA: profile, HERMES_WORKSPACE_PORT: '0', HERMES_RESTORE_TABS_BASE: base };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(electron, [`--user-data-dir=${profile}`, __filename, phase], { env, stdio: ['ignore', 'inherit', 'pipe'] });
    let stderr = '';
    const deadline = setTimeout(() => { child.kill('SIGKILL'); }, 90000);
    child.stderr.on('data', chunk => { stderr += chunk; process.stderr.write(chunk); });
    child.once('error', error => { clearTimeout(deadline); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(deadline);
      try {
        assert.equal(code, 0, `Restore tabs ${phase} failed (${signal || code}): ${stderr.slice(-2000)}`);
        assert.doesNotMatch(stderr, /Object has been destroyed/);
        resolve();
      } catch (error) { reject(error); }
    });
  });

  (async () => {
    try {
      const [port] = await once(server, 'message');
      const base = `http://127.0.0.1:${port}`;
      fs.writeFileSync(path.join(profile, 'preferences.json'), JSON.stringify({ onboarded: true, preview: false, savedTabs: [
        { url: `${base}/fast`, botId: 'shared' },
        { url: `${base}/slow`, botId: 'shared' },
        { url: '', botId: 'shared' },
        { url: 'about:blank', botId: 'shared' },
      ] }));
      for (const phase of ['pending', 'restored']) {
        await launch(phase, base);
        if (phase === 'pending') {
          const saved = JSON.parse(fs.readFileSync(path.join(profile, 'preferences.json'), 'utf8'));
          assert.deepEqual(saved.savedTabs.map(item => item.url), [`${base}/fast`, `${base}/slow`]);
          Atomics.store(new Int32Array(slowReady), 0, 1);
        }
      }
      // A navigate before the first commit replaces the URL the next launch restores.
      fs.writeFileSync(path.join(profile, 'preferences.json'), JSON.stringify({ onboarded: true, preview: false,
        savedTabs: [{ url: `${base}/hang-source`, botId: 'shared' }] }));
      await launch('navigate', base);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(profile, 'preferences.json'), 'utf8')).savedTabs.map(item => item.url), [`${base}/hang-target`]);
      // A window.open tab whose first load is still pending saves nothing.
      fs.writeFileSync(path.join(profile, 'preferences.json'), JSON.stringify({ onboarded: true, preview: false,
        savedTabs: [{ url: `${base}/fast`, botId: 'shared' }] }));
      await launch('popup', base);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(profile, 'preferences.json'), 'utf8')).savedTabs.map(item => item.url), [`${base}/fast`]);
      const userTabs = Array.from({ length: 14 }, (_, i) => ({ url: `${base}/user-${i}`, botId: 'fixture-bot', owner: 'user', active: i === 12 }));
      fs.writeFileSync(path.join(profile, 'preferences.json'), JSON.stringify({ onboarded: true, preview: false, savedTabs: [
        ...userTabs, { url: `${base}/task`, botId: 'fixture-bot', owner: 'bot' },
        { url: `${base}/legacy-task`, botId: 'fixture-bot' }, { url: 'about:blank', owner: 'user' },
      ] }));
      await launch('selection', base);
      await launch('selection', base);
      console.log('PASS: pending restored tabs keep their requested URLs and legacy blank tabs are ignored.');
      console.log('PASS: 15 user tabs retain order and active selection across two launches; tasks stay out.');
    } finally {
      await server.terminate();
      fs.rmSync(profile, { recursive: true, force: true });
    }
  })().catch(error => { console.error(error.stack); process.exitCode = 1; });
} else {
  const { app, BrowserWindow, webContents, session } = electron;
  app.commandLine.appendSwitch('use-mock-keychain');
  require('./settings-fixture-boundaries.cjs')();
  const Module = require('node:module'), load = Module._load;
  Module._load = function(request, ...args) {
    const value = load.call(this, request, ...args);
    return request === 'electron' ? { ...value, safeStorage: { isAsyncEncryptionAvailable: async () => false } } : value;
  };
  const { prepareFixture, quitFixture } = require('./electron-fixture.cjs');
  prepareFixture(process.env.HERMES_WORKSPACE_DATA);
  require('../src/main.cjs');
  const waitFor = async (read, predicate, timeout = 12000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { const value = await read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 50)); }
    throw new Error('Timed out waiting for restored tabs.');
  };
  app.whenReady().then(async () => {
    const win = await waitFor(() => BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('index.html')), Boolean);
    const evaluate = code => win.webContents.executeJavaScript(code);
    await waitFor(() => evaluate('typeof window.workspace === "object"').catch(() => false), Boolean);
    const telegram = webContents.getAllWebContents().find(item => item.session === session.fromPartition('persist:telegram'));
    telegram.stop();
    const state = () => evaluate('window.workspace.getState()');
    const base = process.env.HERMES_RESTORE_TABS_BASE;
    const phase = process.argv.at(-1);
    if (phase === 'pending') {
      const current = await waitFor(state, value => value.tabs.some(tab => tab.url === `${base}/fast`));
      assert.equal(current.tabs.length, 2, 'Only valid saved tabs are restored.');
      assert.ok(current.tabs.every(tab => !tab.internal), 'No restored tab is internal.');
    } else if (phase === 'restored') {
      const expected = [`${base}/fast`, `${base}/slow`];
      const current = await waitFor(state, value => value.tabs.length === 2 && value.tabs.every(tab => expected.includes(tab.url)));
      assert.deepEqual(current.tabs.map(tab => tab.url), expected);
      assert.ok(current.tabs.every(tab => !tab.internal && tab.url !== 'about:blank' && !tab.url.endsWith('/newtab.html')));
    } else if (phase === 'selection') {
      const current = await waitFor(state, value => value.tabs.length === 15 && value.tabs[14].internal && value.tabs.slice(0, 14).every(tab => tab.url.startsWith(`${base}/user-`)));
      assert.deepEqual(current.tabs.slice(0, 14).map(tab => tab.url), Array.from({ length: 14 }, (_, i) => `${base}/user-${i}`));
      assert.equal(current.activeTabId, current.tabs[12].id);
      assert.ok(current.tabs.every(tab => tab.owner === 'user' && tab.controller === 'human'));
      assert.ok(current.tabs[14].internal);
    } else if (phase === 'navigate') {
      // /hang-source never commits; a navigate to /hang-target before that
      // first commit must be what the quit-time snapshot saves.
      const current = await waitFor(state, value => value.tabs.length === 1);
      evaluate(`void window.workspace.command('navigate', { id: ${JSON.stringify(current.tabs[0].id)}, url: ${JSON.stringify(`${base}/hang-target`)} })`).catch(() => {});
      // The navigate command passes through changeController, which bumps the
      // epoch — a reliable sign it ran while the load is still pending.
      await waitFor(state, value => value.tabs[0] && value.tabs[0].epoch >= 2);
    } else if (phase === 'popup') {
      // A window.open tab is loaded by Chromium itself; while that first load
      // is pending there is no URL of its own to save.
      await waitFor(state, value => value.tabs.length === 1 && value.tabs[0].url === `${base}/fast`);
      const page = await waitFor(() => webContents.getAllWebContents().find(item => item.getURL() === `${base}/fast`), Boolean);
      page.executeJavaScript(`void window.open(${JSON.stringify(`${base}/hang-popup`)})`).catch(() => {});
      await waitFor(state, value => value.tabs.length === 2);
    }
    quitFixture();
  }).catch(error => { console.error(error.stack); app.exit(1); });
}
