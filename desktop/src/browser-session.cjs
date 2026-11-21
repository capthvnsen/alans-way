'use strict';

const PARTITIONS = ['persist:browser', 'persist:telegram'];

// Electron persists expiring cookies itself, but drops session-only cookies.
const TIMED_OUT = Symbol('timed out');

function createBrowserSessionStore({ WebContentsView, safeStorage, getPreferences, savePreferences, mark = () => {}, log = () => {}, keychainTimeoutMs = 5000 }) {
  let pending = Promise.resolve();
  let stalled = false;
  let restoreSkipped = false;
  // An unsigned macOS build was seen never answering the async keychain call; one hang would block every later save and restore.
  // Callers treat TIMED_OUT as "unknown", not "unavailable": it is never cached and never deletes saved sign-ins.
  async function bounded(call, promise) {
    let timer;
    const result = await Promise.race([promise, new Promise(resolve => { timer = setTimeout(resolve, keychainTimeoutMs, TIMED_OUT); })]).finally(() => clearTimeout(timer));
    if (result !== TIMED_OUT) stalled = false;
    else if (!stalled) { stalled = true; log(`${call} did not answer within ${keychainTimeoutMs} ms; session sign-ins are not saved or restored until it does.`); }
    return result;
  }
  // Only async keychain calls: on macOS even the sync availability check reads the keychain,
  // blocking the main process for as long as a keychain prompt stays open.
  const secure = async () => {
    const available = await bounded('safeStorage.isAsyncEncryptionAvailable', safeStorage.isAsyncEncryptionAvailable());
    return available === TIMED_OUT ? TIMED_OUT
      : available && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text');
  };

  async function command(partition, method, params, step) {
    // Electron's Cookie API drops partition keys. A private, unloaded view
    // keeps Chromium's cookie isolation metadata intact without touching tabs.
    const view = new WebContentsView({ webPreferences: { partition, sandbox: true } });
    try {
      view.webContents.debugger.attach('1.3');
      if (step) mark(`${step}-attached`);
      return await view.webContents.debugger.sendCommand(method, params);
    } finally { view.webContents.destroy(); }
  }

  function save() {
    pending = pending.catch(() => {}).then(async () => {
      const prefs = getPreferences();
      if (!prefs) return;
      // Saving after a skipped restore would replace the stored sign-ins with only what the jar holds now.
      if (restoreSkipped) { await restoreCookies(); if (restoreSkipped) return; }
      const usable = await secure();
      if (usable === TIMED_OUT) return;
      if (usable) {
        const records = {};
        for (const partition of PARTITIONS) {
          const { cookies } = await command(partition, 'Network.getAllCookies');
          records[partition] = cookies.filter(cookie => cookie.session === true && !cookie.partitionKeyOpaque);
        }
        const sealed = await bounded('safeStorage.encryptStringAsync', safeStorage.encryptStringAsync(JSON.stringify(records)));
        if (sealed === TIMED_OUT) return;
        getPreferences().sessionCookies = sealed.toString('base64');
      } else {
        // Never fall back to plaintext credentials, including Linux basic_text.
        delete prefs.sessionCookies;
      }
      savePreferences();
    });
    return pending;
  }

  // Each mark prints only under HERMES_WORKSPACE_PROFILE_BOOT=1, so a real launch shows which step is slow.
  async function restoreCookies() {
    restoreSkipped = false;
    const saved = getPreferences()?.sessionCookies;
    if (!saved) return;
    mark('restore-start');
    const usable = await secure();
    if (usable === TIMED_OUT) { restoreSkipped = true; return; }
    if (!usable) return;
    mark('restore-keychain-available');
    const opened = await bounded('safeStorage.decryptStringAsync', safeStorage.decryptStringAsync(Buffer.from(saved, 'base64')));
    if (opened === TIMED_OUT) { restoreSkipped = true; return; }
    const records = JSON.parse(opened.result);
    mark('restore-decrypted');
    for (const partition of PARTITIONS) {
      if (!Array.isArray(records[partition])) continue;
      const cookies = records[partition].filter(cookie => cookie.session === true && !cookie.partitionKeyOpaque && typeof cookie.domain === 'string').map(cookie => {
        const { hostOnly, session: _session, size, expires, partitionKeyOpaque, ...details } = cookie;
        if (!cookie.domain.startsWith('.')) delete details.domain;
        const url = `${cookie.secure ? 'https' : 'http'}://${cookie.domain.replace(/^\./, '')}${cookie.path || '/'}`;
        return { ...details, url };
      });
      const step = `restore-${partition.replace('persist:', '')}`;
      if (cookies.length) { await command(partition, 'Network.setCookies', { cookies }, step); mark(`${step}-set`); }
    }
    mark('restore-done');
  }

  // Restore runs in the background while the app is already up; a save queued behind it would otherwise store half the sign-ins.
  function restore() {
    return pending = pending.catch(() => {}).then(restoreCookies);
  }

  return { save, restore };
}

module.exports = { createBrowserSessionStore };
