'use strict';

const PARTITIONS = ['persist:browser', 'persist:telegram'];

// Electron persists expiring cookies itself, but drops session-only cookies.
function createBrowserSessionStore({ session, safeStorage, getPreferences, savePreferences }) {
  let pending = Promise.resolve();
  const secure = () => safeStorage.isEncryptionAvailable()
    && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text');

  function save() {
    pending = pending.catch(() => {}).then(async () => {
      const prefs = getPreferences();
      if (!prefs) return;
      if (secure()) {
        const records = {};
        for (const partition of PARTITIONS) records[partition] = await session.fromPartition(partition).cookies.get({ session: true });
        getPreferences().sessionCookies = safeStorage.encryptString(JSON.stringify(records)).toString('base64');
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
    if (!saved || !secure()) return;
    const records = JSON.parse(safeStorage.decryptString(Buffer.from(saved, 'base64')));
    for (const partition of PARTITIONS) {
      if (!Array.isArray(records[partition])) continue;
      for (const cookie of records[partition]) {
        if (cookie.session !== true || typeof cookie.domain !== 'string') continue;
        const { hostOnly, session: _session, ...details } = cookie;
        if (hostOnly) delete details.domain;
        const url = `${cookie.secure ? 'https' : 'http'}://${cookie.domain.replace(/^\./, '')}${cookie.path || '/'}`;
        await session.fromPartition(partition).cookies.set({ ...details, url });
      }
    }
  }

  return { save, restore };
}

module.exports = { createBrowserSessionStore };
