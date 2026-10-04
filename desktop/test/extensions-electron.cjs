// Uses only a generated, harmless extension and localhost pages in a temporary profile.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const electron = require('electron');
if (typeof electron === 'string') {
  const { spawnSync } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-extension-test-'));
  const source = path.join(root, 'source'), profile = path.join(root, 'profile');
  fs.mkdirSync(source); fs.mkdirSync(path.join(source, 'background')); fs.mkdirSync(profile);
  fs.writeFileSync(path.join(profile, 'preferences.json'), JSON.stringify({ bots: [{ id: '123', name: 'Extension fixture', isBot: true }], selectedBotId: '123', preview: false }));
  fs.writeFileSync(path.join(source, 'manifest.json'), JSON.stringify({ manifest_version: 3, content_security_policy: {extension_pages: "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'"}, name: 'Harmless fixture', version: '1.0', permissions: ['storage', 'tabs'], host_permissions:['<all_urls>'], background: { service_worker: 'background/worker.js', type: 'module' },
    action: { default_popup: 'popup.html', default_icon: 'icon.png' }, content_scripts: [{ matches: ['http://127.0.0.1/*'], js: ['content.js'] }] }));
  fs.writeFileSync(path.join(source, 'icon.png'), fs.readFileSync(path.join(__dirname, '../assets/avatars/hermes.png')));
  fs.writeFileSync(path.join(source, 'background/dependency.js'), 'export const WINDOW_ID_NONE = browser.windows.WINDOW_ID_NONE;');
  fs.writeFileSync(path.join(source, 'background/worker.js'), `import './dependency.js'; chrome.storage.local.set({workerApi:{windows:typeof chrome.windows, constant:chrome.windows?.WINDOW_ID_NONE}}); chrome.runtime.onMessage.addListener((message, sender, reply) => { if (message === 'active-tab') { chrome.tabs.query({active:true, currentWindow:true}, tabs => reply(tabs.map(tab => ({id:tab.id, url:tab.url})))); return true; } }); chrome.action.setBadgeText({text:'OK'});`);
  fs.writeFileSync(path.join(source, 'content.js'), 'document.documentElement.dataset.extensionFixture = "loaded";');
  fs.writeFileSync(path.join(source, 'popup.html'), '<!doctype html><title>Harmless extension popup</title><p id="value">Loading</p><p id="active">Loading</p><button id="save">Save fixture value</button><script src="popup.js"></script>');
  fs.writeFileSync(path.join(source, 'popup.js'), 'chrome.storage.local.get("workerApi", value => document.body.dataset.workerApi = JSON.stringify(value.workerApi)); chrome.runtime.sendMessage("active-tab", tabs => document.getElementById("active").textContent = JSON.stringify(tabs)); chrome.storage.local.get("fixtureValue", value => document.getElementById("value").textContent = value.fixtureValue || "empty"); document.getElementById("save").onclick = () => chrome.storage.local.set({fixtureValue:"persisted fixture"}, () => document.getElementById("value").textContent = "persisted fixture");');
  try {
    for (const phase of ['install', 'restore']) {
      const result = spawnSync(electron, [__filename, phase], { env: { ...process.env, HERMES_WORKSPACE_DATA: profile, HERMES_WORKSPACE_PORT: '0', HERMES_EXTENSION_TEST_ROOT: root }, stdio: 'inherit', timeout: 40000, killSignal: 'SIGKILL' });
      assert.equal(result.status, 0, result.error?.message || `Extension ${phase} failed.`);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
} else {
  const { app, BrowserWindow, dialog, webContents, session } = electron;
  const root = process.env.HERMES_EXTENSION_TEST_ROOT, source = path.join(root, 'source');
  const { resourcePath, validateFiles } = require('../src/extension-store.cjs');
  assert.throws(() => resourcePath(source, '../outside.html'));
  assert.throws(() => resourcePath(source, '/outside.html'));
  fs.symlinkSync(path.join(source, 'manifest.json'), path.join(source, 'forbidden-link'));
  assert.throws(() => validateFiles(source), /links/); fs.unlinkSync(path.join(source, 'forbidden-link'));
  require('../src/main.cjs');
  const waitFor = async (read, predicate, timeout = 12000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { const value = await read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 50)); }
    throw new Error('Timed out waiting for extension fixture.');
  };
  let server;
  app.whenReady().then(async () => {
    const win = await waitFor(() => BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('index.html')), Boolean);
    const wc = win.webContents, evaluate = code => wc.executeJavaScript(code);
    await waitFor(() => evaluate('typeof window.workspace === "object"').catch(() => false), Boolean);
    const telegram = webContents.getAllWebContents().find(item => item.session === session.fromPartition('persist:telegram'));
    telegram.stop(); await telegram.loadURL('about:blank');
    const invoke = (name, value = {}) => evaluate(`window.workspace.command(${JSON.stringify(name)}, ${JSON.stringify(value)})`);
    const state = () => evaluate('window.workspace.getState()');
    let item;
    if (process.argv[2] === 'install') {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] });
      dialog.showMessageBox = async () => ({ response: 0 });
      await invoke('add-extension'); assert.equal((await state()).extensions.length, 0, 'Cancel imports nothing.');
      dialog.showMessageBox = async () => ({ response: 1 });
      await evaluate('document.getElementById("extensions-button").click()');
      assert.equal(await evaluate('document.getElementById("modal-title").textContent'), 'Extensions');
      await invoke('add-extension'); item = await waitFor(async () => (await state()).extensions[0], item => item?.loaded);
      assert.ok(item.loaded && item.pinned && item.icon.startsWith('data:image/png'));
      assert.equal(session.fromPartition('persist:telegram').extensions.getAllExtensions().length, 0, 'Extensions stay out of Telegram.');
      await waitFor(() => evaluate('[...document.getElementById("native-extension-actions").shadowRoot.querySelectorAll("button.action")].filter(button => getComputedStyle(button).display !== "none").length'), value => value === 1);
      await invoke('pin-extension', { key: item.key, pinned: false });
      assert.equal(await evaluate('[...document.getElementById("native-extension-actions").shadowRoot.querySelectorAll("button.action")].filter(button => getComputedStyle(button).display !== "none").length'), 0);
      await invoke('pin-extension', { key: item.key, pinned: true });
      await invoke('enable-extension', { key: item.key, enabled: false });
      assert.equal((await state()).extensions[0].loaded, false);
      await invoke('enable-extension', { key: item.key, enabled: true });
      await evaluate('document.getElementById("modal-close").click()');
      server = require('node:http').createServer((_req, res) => res.end('<!doctype html><title>Extension content fixture</title><input aria-label="Fixture input">'));
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const tab = await invoke('create-tab', { url: `http://127.0.0.1:${server.address().port}` });
      const page = await waitFor(() => webContents.getAllWebContents().find(item => item.getURL().startsWith(`http://127.0.0.1:${server.address().port}`)), Boolean);
      await waitFor(() => page.executeJavaScript('document.documentElement.dataset.extensionFixture').catch(() => ''), value => value === 'loaded');
      const background = await invoke('create-tab', { url: `http://127.0.0.1:${server.address().port}/background` });
      await invoke('activate', { id: tab.id });
      await invoke('control', { id: tab.id, controller: 'agent' });
      await evaluate('document.getElementById("native-extension-actions").shadowRoot.querySelector("button.action").click()');
      await waitFor(() => state(), state => state.tabs.find(item => item.id === tab.id).controller === 'human');
      const extensionId = (await state()).extensions[0].id;
      const popup = await waitFor(() => webContents.getAllWebContents().find(item => item.getURL() === `chrome-extension://${extensionId}/popup.html`), Boolean);
      await waitFor(() => popup.executeJavaScript('document.getElementById("active")?.textContent').catch(() => ''), value => value?.includes(`http://127.0.0.1:${server.address().port}/`) && !value.includes('/background'));
      assert.deepEqual(JSON.parse(await popup.executeJavaScript('document.body.dataset.workerApi')), {windows:'object', constant:-1}, 'Module workers receive the compatibility APIs before startup.');
      assert.equal(await popup.executeJavaScript('typeof window.workspace'), 'undefined', 'No workspace or agent API in the popup.');
      await popup.executeJavaScript('document.getElementById("save").click()');
      await waitFor(() => popup.executeJavaScript('document.getElementById("value").textContent'), value => value === 'persisted fixture');
      const installed = (await state()).extensions[0]; fs.writeFileSync(path.join(root, 'proof.json'), JSON.stringify(installed));
      console.log('PASS: native extension import/cancel, real content script, sandboxed popup, human takeover, pin and enable controls.');
    } else {
      const proof = JSON.parse(fs.readFileSync(path.join(root, 'proof.json'))); item = await waitFor(async () => (await state()).extensions[0], item => item?.loaded);
      assert.ok(item.loaded && item.pinned && item.enabled); assert.equal(item.id, proof.id, 'Extension identity survives an app restart.');
      await invoke('open-extension', { key: item.key });
      const popup = await waitFor(() => webContents.getAllWebContents().find(wc => wc.getURL() === `chrome-extension://${item.id}/popup.html`), Boolean);
      await waitFor(() => popup.executeJavaScript('document.getElementById("value").textContent'), value => value === 'persisted fixture');
      await invoke('remove-extension', { key: item.key });
      assert.equal((await state()).extensions.length, 0);
      assert.equal(session.fromPartition('persist:browser').extensions.getAllExtensions().length, 0);
      assert.equal(fs.existsSync(path.join(process.env.HERMES_WORKSPACE_DATA, 'browser-extensions', item.key)), false);
      assert.equal(fs.existsSync(path.join(source, 'manifest.json')), true, 'Original code is left intact.');
      console.log('PASS: real app restart restores extension, pin choice and popup storage; removal unloads only the imported copy.');
    }
    server?.close(); app.quit();
  }).catch(error => { console.error(error.stack); server?.close(); app.exit(1); });
}
