'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createBrowserSessionStore } = require('../src/browser-session.cjs');

function fixture(create = createBrowserSessionStore) {
  let prefs = {}, available = true, backend = 'gnome_libsecret', sealed, text;
  const cookies = new Map(), restored = [], writes = [];
  const safeStorage = {
    isEncryptionAvailable: () => available, getSelectedStorageBackend: () => backend,
    encryptString: () => assert.fail('sync keychain access blocks the main process'),
    decryptString: () => assert.fail('sync keychain access blocks the main process'),
    encryptStringAsync: async value => { text = value; sealed = Buffer.from('opaque fixture ciphertext'); return sealed; },
    decryptStringAsync: async value => { assert.deepEqual(value, sealed); return { shouldReEncrypt: false, result: text }; },
  };
  const session = { fromPartition: partition => ({ cookies: {
    get: async filter => { assert.deepEqual(filter, { session: true }); return (cookies.get(partition) || []).map(({ partitionKey, partitionKeyOpaque, ...cookie }) => cookie); },
    set: async details => restored.push({ partition, ...details }),
  } }) };
  class WebContentsView {
    constructor({ webPreferences: { partition } }) {
      this.webContents = { destroy() {}, debugger: { attach() {}, detach() {}, sendCommand: async (method, params) => {
        if (method === 'Network.getAllCookies') return { cookies: structuredClone(cookies.get(partition) || []) };
        assert.equal(method, 'Network.setCookies');
        for (const cookie of params.cookies) restored.push({ partition, ...cookie });
        return {};
      } } };
    }
  }
  const store = create({ session, WebContentsView, safeStorage, getPreferences: () => prefs,
    savePreferences: () => writes.push(structuredClone(prefs)) });
  return { store, cookies, restored, writes, prefs: () => prefs, setPrefs: value => { prefs = value; },
    unavailable: () => { available = false; }, basic: () => { backend = 'basic_text'; } };
}
const cookie = { name: '__Host-fixture', value: 'fixture-only', domain: 'signin.example', path: '/',
  secure: true, httpOnly: true, hostOnly: true, session: true, sameSite: 'strict' };

test('restoring a third-party session cookie preserves its partition and never turns an opaque cookie into an unpartitioned one', async () => {
  const f = fixture();
  const partitionKey = { topLevelSite: 'https://top.example', hasCrossSiteAncestor: true };
  f.cookies.set('persist:browser', [{ ...cookie, partitionKey }, { ...cookie, name: 'opaque', partitionKeyOpaque: true }]);
  await f.store.save(); await f.store.restore();
  assert.equal(f.restored.length, 1);
  assert.deepEqual(f.restored[0].partitionKey, partitionKey);
});

test('encrypted session cookies restore in the original partition with host-only and security flags intact', async () => {
  const f = fixture();
  f.cookies.set('persist:browser', [cookie, { ...cookie, name: 'domain-fixture', domain: '.signin.example', hostOnly: false }]);
  f.cookies.set('persist:telegram', [{ ...cookie, name: 'chat-fixture' }]);
  await f.store.save();
  assert.doesNotMatch(JSON.stringify(f.writes), /fixture-only|signin\.example/);
  await f.store.restore();
  assert.deepEqual(f.restored, [
    { partition: 'persist:browser', name: '__Host-fixture', value: 'fixture-only', path: '/', secure: true, httpOnly: true, sameSite: 'strict', url: 'https://signin.example/' },
    { partition: 'persist:browser', name: 'domain-fixture', value: 'fixture-only', domain: '.signin.example', path: '/', secure: true, httpOnly: true, sameSite: 'strict', url: 'https://signin.example/' },
    { partition: 'persist:telegram', name: 'chat-fixture', value: 'fixture-only', path: '/', secure: true, httpOnly: true, sameSite: 'strict', url: 'https://signin.example/' },
  ]);
});

test('logout or clearing cookies replaces the saved sign-in, including queued saves', async () => {
  const f = fixture();
  f.cookies.set('persist:browser', [cookie]);
  await f.store.save();
  const pending = f.store.save();
  f.cookies.clear();
  await Promise.all([pending, f.store.save()]);
  await f.store.restore();
  assert.deepEqual(f.restored, [], 'removed credentials must never be resurrected');
});

test('unavailable OS encryption never writes plaintext and drops any stale saved sign-in', async () => {
  const f = fixture();
  f.cookies.set('persist:browser', [cookie]);
  f.setPrefs({ sessionCookies: 'old-ciphertext' });
  f.unavailable();
  await f.store.restore();
  await f.store.save();
  assert.deepEqual(f.restored, []);
  assert.equal(f.prefs().sessionCookies, undefined);
  assert.doesNotMatch(JSON.stringify(f.writes), /fixture-only/);
});

test('a Settings save while cookie reads are pending does not lose the current sign-in', async () => {
  const f = fixture(); f.cookies.set('persist:browser', [cookie]);
  const saving = f.store.save();
  await Promise.resolve();
  await Promise.resolve();
  f.setPrefs({ preview: false });
  await saving;
  assert.equal(typeof f.prefs().sessionCookies, 'string');
  assert.equal(f.prefs().preview, false);
});

test('a failed private-file write is reported and does not poison the next save', async () => {
  let failing = true;
  const store = createBrowserSessionStore({ session: {}, safeStorage: { isEncryptionAvailable: () => false },
    getPreferences: () => ({}), savePreferences: () => { if (failing) throw Error('fixture disk full'); } });
  await assert.rejects(store.save(), /fixture disk full/);
  failing = false;
  await store.save();
});

test('a failed cookie read destroys its private inspector and keeps the previous encrypted snapshot', async () => {
  let destroyed = 0;
  const prefs = { sessionCookies: 'previous-ciphertext' };
  class WebContentsView {
    constructor() { this.webContents = { destroy: () => { destroyed++; }, debugger: {
      attach() {}, sendCommand: async () => { throw Error('fixture read failed'); },
    } }; }
  }
  const store = createBrowserSessionStore({ WebContentsView, getPreferences: () => prefs, savePreferences() {},
    safeStorage: { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret' } });
  await assert.rejects(store.save(), /fixture read failed/);
  assert.equal(destroyed, 1);
  assert.equal(prefs.sessionCookies, 'previous-ciphertext');
});

test('Linux basic_text is not treated as secure storage', async () => {
  const module = { exports: {} };
  require('node:vm').runInNewContext(require('node:fs').readFileSync(require.resolve('../src/browser-session.cjs'), 'utf8'), { module, Buffer, process: { platform: 'linux' } });
  const f = fixture(module.exports.createBrowserSessionStore); f.basic(); f.cookies.set('persist:browser', [cookie]);
  await f.store.save();
  assert.equal(f.prefs().sessionCookies, undefined);
});
