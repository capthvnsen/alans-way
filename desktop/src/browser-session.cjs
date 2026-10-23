'use strict';

const PARTITIONS = ['persist:browser', 'persist:telegram'];

// Electron persists expiring cookies itself, but drops session-only cookies.
function createBrowserSessionStore({ WebContentsView, safeStorage, getPreferences, savePreferences }) {
  let pending = Promise.resolve();
  // Only async keychain calls: on macOS even the sync availability check reads the keychain,
  // blocking the main process for as long as a keychain prompt stays open.
  const secure = async () => await safeStorage.isAsyncEncryptionAvailable()
    && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text');

  async function command(partition, method, params) {
    // Electron's Cookie API drops partition keys. A private, unloaded view
    // keeps Chromium's cookie isolation metadata intact without touching tabs.
    const view = new WebContentsView({ webPreferences: { partition, sandbox: true } });
    try {
      view.webContents.debugger.attach('1.3');
      return await view.webContents.debugger.sendCommand(method, params);
    } finally { view.webContents.destroy(); }
  }

  function save() {
    pending = pending.catch(() => {}).then(async () => {
      const prefs = getPreferences();
      if (!prefs) return;
      if (await secure()) {
        const records = {};
        for (const partition of PARTITIONS) {
          const { cookies } = await command(partition, 'Network.getAllCookies');
          records[partition] = cookies.filter(cookie => cookie.session === true && !cookie.partitionKeyOpaque);
        }
        getPreferences().sessionCookies = (await safeStorage.encryptStringAsync(JSON.stringify(records))).toString('base64');
      } else {
        // Never fall back to plaintext credentials, including Linux basic_text.
        delete prefs.sessionCookies;
      }
      savePreferences();
    });
    return pending;
  }

  async function restore() {
    const saved = getPreferences()?.sessionCookies;
    if (!saved || !(await secure())) return;
    const records = JSON.parse((await safeStorage.decryptStringAsync(Buffer.from(saved, 'base64'))).result);
    for (const partition of PARTITIONS) {
      if (!Array.isArray(records[partition])) continue;
      const cookies = records[partition].filter(cookie => cookie.session === true && !cookie.partitionKeyOpaque && typeof cookie.domain === 'string').map(cookie => {
        const { hostOnly, session: _session, size, expires, partitionKeyOpaque, ...details } = cookie;
        if (!cookie.domain.startsWith('.')) delete details.domain;
        const url = `${cookie.secure ? 'https' : 'http'}://${cookie.domain.replace(/^\./, '')}${cookie.path || '/'}`;
        return { ...details, url };
      });
      if (cookies.length) await command(partition, 'Network.setCookies', { cookies });
    }
  }

  return { save, restore };
}

module.exports = { createBrowserSessionStore };
