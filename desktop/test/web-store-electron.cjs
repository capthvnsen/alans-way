// Network integration: the actual public Web Store page and 1Password package.
// All browser/extension data lives in a disposable profile. No account is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const electron = require('electron');
const ID = 'aeblfdkhhhdcdjpifhhbdiojplfjncoa';
if (typeof electron === 'string') {
  const { spawnSync } = require('node:child_process');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-web-store-'));
  fs.writeFileSync(path.join(profile, 'preferences.json'), JSON.stringify({ bots: [{ id: '123', name: 'Web Store fixture', isBot: true }], selectedBotId: '123', preview: false }));
  try {
    for (const phase of ['install', 'restore']) {
      const result = spawnSync(process.env.HERMES_TEST_ELECTRON || electron, [__filename, phase], { env: { ...process.env, HERMES_WORKSPACE_DATA: profile, HERMES_WORKSPACE_PORT: '0' }, stdio: 'inherit', timeout: 90000, killSignal: 'SIGKILL' });
      assert.equal(result.status, 0, result.error?.message || `Web Store ${phase} failed.`);
    }
  } finally { fs.rmSync(profile, { recursive: true, force: true }); }
} else {
  const { app, BrowserWindow, dialog, webContents, session } = electron;
  require('../src/main.cjs');
  const waitFor = async (read, predicate, label, timeout = 25000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { const value = await read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
    throw new Error(`Timed out: ${label}`);
  };
  app.whenReady().then(async () => {
    const win = await waitFor(() => BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('index.html')), Boolean, 'workspace');
    const evaluate = code => win.webContents.executeJavaScript(code);
    await waitFor(() => evaluate('typeof window.workspace === "object"').catch(() => false), Boolean, 'preload');
    const telegram = webContents.getAllWebContents().find(item => item.session === session.fromPartition('persist:telegram'));
    telegram.stop(); await telegram.loadURL('about:blank');
    const invoke = (name, value = {}) => evaluate(`window.workspace.command(${JSON.stringify(name)}, ${JSON.stringify(value)})`);
    const state = () => evaluate('window.workspace.getState()');
    let confirms = 0;
    dialog.showMessageBox = async (_window, details) => { assert.match(details.message, /Add 1Password/); assert.match(details.detail, /nativeMessaging/); confirms++; return { response: 1 }; };
    if (process.argv[2] === 'install') {
      await invoke('create-tab', { url: `https://chromewebstore.google.com/detail/1password-password-manager/${ID}` });
      const page = await waitFor(() => webContents.getAllWebContents().find(wc => wc.getURL().startsWith('https://chromewebstore.google.com/detail/')), Boolean, 'store tab');
      const button = await waitFor(() => page.executeJavaScript(`Array.from(document.querySelectorAll('button')).map(b => ({text:b.textContent, disabled:b.disabled})).filter(b => /Add to /.test(b.text))`).catch(() => []), buttons => buttons.some(b => !b.disabled), 'enabled Add to browser button');
      console.log('Web Store install button:', JSON.stringify(button));
      assert.equal(await page.executeJavaScript('typeof chrome.webstorePrivate.beginInstallWithManifest3'), 'function');
      await page.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(b => /Add to /.test(b.textContent) && !b.disabled).click()`);
      await waitFor(async () => (await state()).extensions.find(item => item.id === ID), item => item?.loaded, 'real 1Password installation', 60000);
      assert.equal(confirms, 1, 'The actual Web Store installer asks for consent.');
      assert.equal(session.fromPartition('persist:telegram').extensions.getAllExtensions().length, 0);
    }
    const item = await waitFor(async () => (await state()).extensions.find(item => item.id === ID), item => item?.loaded, '1Password restoration');
    assert.equal(item.source, 'webstore'); assert.ok(item.pinned && item.enabled);
    await waitFor(() => evaluate(`document.getElementById('native-extension-actions').shadowRoot.querySelector('button[id="${ID}"]') !== null`).catch(() => false), Boolean, 'real 1Password action');
    // Let the genuine first-run worker open its setup page before selecting our test tab.
    await new Promise(resolve => setTimeout(resolve, 1500));
    await invoke('create-tab', { url: 'about:blank' });
    await invoke('open-extension', { key: item.key });
    const popup = await waitFor(async () => {
      const current = await state();
      const selected = current.tabs.find(tab => tab.id === current.activeTabId && tab.extensionPage && tab.url.startsWith(`chrome-extension://${ID}/`));
      if (selected) return webContents.fromId(current.browserContentsId);
      return BrowserWindow.getAllWindows().find(window => window !== win && window.isVisible() && window.webContents.getURL().startsWith(`chrome-extension://${ID}/`))?.webContents;
    }, Boolean, '1Password action opens its setup tab or popup');
    const text = await waitFor(() => popup.executeJavaScript('document.body.innerText').catch(() => ''), value => /1Password|password|account|unlock|sign in/i.test(value), 'rendered 1Password screen');
    assert.equal(await popup.executeJavaScript('typeof window.workspace'), 'undefined');
    const connection = JSON.parse(fs.readFileSync(path.join(process.env.HERMES_WORKSPACE_DATA, 'connection.json')));
    const response = await fetch(new URL('/v1/tabs', connection.url), { headers: { Authorization: `Bearer ${connection.token}` } });
    const visible = await response.json();
    assert.ok(!visible.tabs.some(tab => tab.url.startsWith('chrome-extension:')), 'Extension account pages stay outside the agent browser API.');
    const account = (await state()).tabs.find(tab => tab.extensionPage);
    if (account) {
      await assert.rejects(invoke('control', { id: account.id, controller: 'agent' }), /your control/);
      await assert.rejects(invoke('grant-tab', { id: account.id, botId: '123' }), /your control/);
    }
    console.log(`PASS: ${process.argv[2]} real 1Password ${item.version}, pinned action and rendered extension screen (${text.slice(0, 250).replace(/\n/g, ' ')}).`);
    if (process.argv[2] === 'restore') {
      await invoke('enable-extension', { key: item.key, enabled: false }); assert.equal((await state()).extensions.find(e => e.key === item.key).loaded, false);
      await invoke('enable-extension', { key: item.key, enabled: true }); assert.equal((await state()).extensions.find(e => e.key === item.key).loaded, true);
      await invoke('remove-extension', { key: item.key }); assert.equal((await state()).extensions.length, 0);
      assert.equal(fs.existsSync(path.join(process.env.HERMES_WORKSPACE_DATA, 'chrome-web-store', ID)), false);
    }
    app.quit();
  }).catch(error => { console.error(error.stack); app.exit(1); });
}
