const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const electron = require('electron');

if (typeof electron === 'string') {
  const { spawnSync } = require('node:child_process');
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
        const result = spawnSync(electron, [__filename, phase], { env: { ...process.env, HERMES_WORKSPACE_DATA: profile, HERMES_WORKSPACE_PORT: '0', HERMES_RESTORE_TABS_BASE: base }, stdio: 'inherit', timeout: 40000, killSignal: 'SIGKILL' });
        assert.equal(result.status, 0, result.error?.message || `Restore tabs ${phase} phase failed.`);
        if (phase === 'pending') {
          const saved = JSON.parse(fs.readFileSync(path.join(profile, 'preferences.json'), 'utf8'));
          assert.deepEqual(saved.savedTabs.map(item => item.url), [`${base}/fast`, `${base}/slow`]);
          Atomics.store(new Int32Array(slowReady), 0, 1);
        }
      }
      // A navigate before the first commit replaces the URL the next launch restores.
      fs.writeFileSync(path.join(profile, 'preferences.json'), JSON.stringify({ onboarded: true, preview: false,
        savedTabs: [{ url: `${base}/hang-source`, botId: 'shared' }] }));
      const navigate = spawnSync(electron, [__filename, 'navigate'], { env: { ...process.env, HERMES_WORKSPACE_DATA: profile, HERMES_WORKSPACE_PORT: '0', HERMES_RESTORE_TABS_BASE: base }, stdio: 'inherit', timeout: 40000, killSignal: 'SIGKILL' });
      assert.equal(navigate.status, 0, navigate.error?.message || 'Restore tabs navigate phase failed.');
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(profile, 'preferences.json'), 'utf8')).savedTabs.map(item => item.url), [`${base}/hang-target`]);
      // A window.open tab whose first load is still pending saves nothing.
      fs.writeFileSync(path.join(profile, 'preferences.json'), JSON.stringify({ onboarded: true, preview: false,
        savedTabs: [{ url: `${base}/fast`, botId: 'shared' }] }));
      const popup = spawnSync(electron, [__filename, 'popup'], { env: { ...process.env, HERMES_WORKSPACE_DATA: profile, HERMES_WORKSPACE_PORT: '0', HERMES_RESTORE_TABS_BASE: base }, stdio: 'inherit', timeout: 40000, killSignal: 'SIGKILL' });
      assert.equal(popup.status, 0, popup.error?.message || 'Restore tabs popup phase failed.');
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(profile, 'preferences.json'), 'utf8')).savedTabs.map(item => item.url), [`${base}/fast`]);
      console.log('PASS: pending restored tabs keep their requested URLs and legacy blank tabs are ignored.');
    } finally {
      await server.terminate();
      fs.rmSync(profile, { recursive: true, force: true });
    }
  })().catch(error => { console.error(error.stack); process.exitCode = 1; });
} else {
  const { app, BrowserWindow, webContents, session } = electron;
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
    telegram.stop(); await telegram.loadURL('about:blank');
    const state = () => evaluate('window.workspace.getState()');
    const base = process.env.HERMES_RESTORE_TABS_BASE;
    const phase = process.argv[2];
    if (phase === 'pending') {
      const current = await waitFor(state, value => value.tabs.some(tab => tab.url === `${base}/fast`));
      assert.equal(current.tabs.length, 2, 'Only valid saved tabs are restored.');
      assert.ok(current.tabs.every(tab => !tab.internal), 'No restored tab is internal.');
    } else if (phase === 'restored') {
      const expected = [`${base}/fast`, `${base}/slow`];
      const current = await waitFor(state, value => value.tabs.length === 2 && value.tabs.every(tab => expected.includes(tab.url)));
      assert.deepEqual(current.tabs.map(tab => tab.url), expected);
      assert.ok(current.tabs.every(tab => !tab.internal && tab.url !== 'about:blank' && !tab.url.endsWith('/newtab.html')));
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
    app.quit();
  }).catch(error => { console.error(error.stack); app.exit(1); });
}
