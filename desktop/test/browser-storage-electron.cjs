'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const electron = require('electron');

if (typeof electron === 'string') {
  const { spawn } = require('node:child_process');
  const { Worker } = require('node:worker_threads');
  const { once } = require('node:events');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-storage-'));
  const server = new Worker(`
    const server = require('node:http').createServer((_req, res) => res.end('<!doctype html><title>Storage fixture</title>'));
    server.listen(0, '127.0.0.1', () => require('node:worker_threads').parentPort.postMessage(server.address().port));
  `, { eval: true });
  (async () => {
    try {
      const [port] = await once(server, 'message');
      for (const phase of ['write', 'restore', 'cleared']) {
        const result = await new Promise((resolve, reject) => {
          const env = { ...process.env, HOME: dir, HERMES_WORKSPACE_DATA: path.join(dir, 'profile'), FIXTURE_URL: `http://127.0.0.1:${port}` };
          delete env.ELECTRON_RUN_AS_NODE;
          const child = spawn(electron, [`--user-data-dir=${path.join(dir, 'bootstrap')}`, __filename, phase], { env, stdio: ['ignore', 'inherit', 'pipe'] });
          let stderr = '';
          const timer = setTimeout(() => child.kill('SIGKILL'), 45000);
          child.stderr.on('data', chunk => { stderr += chunk; });
          child.once('error', error => { clearTimeout(timer); reject(error); });
          child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stderr }); });
        });
        assert.equal(result.code, 0, JSON.stringify(result));
        console.log(`PASS browser storage ${phase}`);
      }
    } finally { await server.terminate(); fs.rmSync(dir, { recursive: true, force: true }); }
  })().catch(error => { console.error(error); process.exitCode = 1; });
} else {
  // No BrowserWindow, screen driver, real profile, external service or keychain.
  const { app, session, WebContentsView } = electron;
  app.commandLine.appendSwitch('use-mock-keychain');
  app.commandLine.appendSwitch('password-store', 'basic');
  app.disableHardwareAcceleration();
  const source = fs.readFileSync(require.resolve('../src/main.cjs'), 'utf8');
  const start = source.indexOf("app.setPath('userData',");
  vm.runInNewContext(source.slice(start, source.indexOf('\nconst ROOT', start)), { app, process, path });
  app.whenReady().then(async () => {
    const phase = process.argv.at(-1), root = app.getPath('userData');
    fs.mkdirSync(root, { recursive: true });
    const file = path.join(root, 'fixture-state.json');
    const prefs = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    // The encryption boundary is deterministic and in memory. Real OS secure
    // storage is deliberately not consulted by this disposable fixture.
    const safeStorage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret',
      encryptString: text => Buffer.from(text.split('').reverse().join('')),
      decryptString: value => value.toString().split('').reverse().join('') };
    const savePreferences = () => require('../src/shell-support.cjs').writePrivateJson(file, prefs);
    const browserSessionStore = require('../src/browser-session.cjs').createBrowserSessionStore({ session, safeStorage, getPreferences: () => prefs, savePreferences });
    const browser = session.fromPartition('persist:browser');
    assert.ok(browser.getStoragePath().startsWith(root + path.sep), 'browser profile must stay beneath stable app data');
    await browserSessionStore.restore();
    const view = new WebContentsView({ webPreferences: { partition: 'persist:browser', sandbox: true } });
    await view.webContents.loadURL(process.env.FIXTURE_URL);
    if (phase === 'write') {
      await browser.cookies.set({ url: process.env.FIXTURE_URL, name: 'fixture-session', value: 'fixture-only', httpOnly: true });
      await browser.cookies.set({ url: process.env.FIXTURE_URL, name: 'fixture-expiring', value: 'fixture-only', expirationDate: Date.now() / 1000 + 3600 });
      await view.webContents.executeJavaScript("localStorage.setItem('fixture', 'retained')");
    } else {
      assert.equal(await view.webContents.executeJavaScript("localStorage.getItem('fixture')"), 'retained');
      const transient = await browser.cookies.get({ name: 'fixture-session' });
      const persistent = await browser.cookies.get({ name: 'fixture-expiring' });
      assert.equal(transient.length, phase === 'cleared' ? 0 : 1);
      assert.equal(persistent.length, phase === 'cleared' ? 0 : 1);
      if (phase === 'restore') {
        assert.equal(transient[0].session, true); assert.equal(transient[0].httpOnly, true); assert.equal(transient[0].hostOnly, true);
        const clearStart = source.indexOf("      case 'clear-cookies':");
        await vm.runInNewContext(`(async () => { switch ('clear-cookies') { ${source.slice(clearStart, source.indexOf("      case 'open-download':", clearStart))} } })()`, {
          value: {}, session, browserSessionStore, broadcast() {},
        });
      }
    }
    const helper = source.slice(source.indexOf('async function saveBrowserSession('), source.indexOf('\n// Hands over only after'));
    await vm.runInNewContext(helper + '\nsaveBrowserSession();', { savePreferences, session, browserSessionStore });
    view.webContents.close();
    app.exit(0); // Model the updater's forced exit after the durability barrier.
  }).catch(error => { console.error(error); app.exit(1); });
}
