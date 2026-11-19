const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createWebappSignIn, signInToWebapp, SIGN_IN_ERRORS } = require('../src/webapp-signin.cjs');

const fakeSafeStorage = (available = true) => ({
  isEncryptionAvailable: () => available, getSelectedStorageBackend: () => 'gnome_libsecret',
  encryptString: (text) => Buffer.from(`enc:${[...text].reverse().join('')}`),
  decryptString: (buffer) => { const text = buffer.toString(); if (!text.startsWith('enc:')) throw new Error('bad'); return [...text.slice(4)].reverse().join(''); },
});

test('the saved sign-in is encrypted and tied to its origin', () => {
  const prefs = {}; let saves = 0;
  const store = createWebappSignIn({ safeStorage: fakeSafeStorage(), getPreferences: () => prefs, savePreferences: () => saves++ });
  store.save('https://box.tail1.ts.net', ' sam ', 'p4ss-word');
  assert.equal(saves, 1);
  assert.equal(JSON.stringify(prefs).includes('p4ss-word'), false, 'no plaintext password in preferences');
  assert.deepEqual(store.read('https://box.tail1.ts.net'), { username: 'sam', password: 'p4ss-word' });
  assert.equal(store.username('https://box.tail1.ts.net'), 'sam');
  for (const other of ['https://box.tail2.ts.net', 'https://evil-box.tail1.ts.net', 'http://box.tail1.ts.net']) {
    assert.equal(store.read(other), null, other);
    assert.equal(store.username(other), '');
  }
  prefs.webappSignIn.passwordEnc = Buffer.from('garbage').toString('base64');
  assert.equal(store.read('https://box.tail1.ts.net'), null, 'an undecryptable entry reads as none');
  store.forget();
  assert.equal(prefs.webappSignIn, undefined);
  assert.equal(saves, 2);
  store.forget();
  assert.equal(saves, 2, 'forgetting nothing writes nothing');
});

test('no keychain, no saved password', () => {
  const prefs = {};
  const store = createWebappSignIn({ safeStorage: fakeSafeStorage(false), getPreferences: () => prefs, savePreferences: () => {} });
  assert.throws(() => store.save('https://box.tail1.ts.net', 'sam', 'pw'), /keychain/);
  assert.throws(() => createWebappSignIn({ safeStorage: fakeSafeStorage(), getPreferences: () => prefs, savePreferences: () => {} }).save('https://b.ts.net', 'sam', ''), /username and password/);
  assert.equal(prefs.webappSignIn, undefined);
});

test('signs in through the Webapp password route and names each failure', async () => {
  const seen = [];
  let answer = 200;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => { seen.push({ method: req.method, url: req.url, type: req.headers['content-type'], body: JSON.parse(body) }); res.writeHead(answer, answer === 307 ? { Location: '/elsewhere' } : {}); res.end('{}'); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/hermes/`;
  try {
    assert.equal(await signInToWebapp(fetch, base, { username: 'sam', password: 'pw' }), '');
    assert.deepEqual(seen[0], { method: 'POST', url: '/hermes/auth/password-login', type: 'application/json', body: { provider: 'basic', username: 'sam', password: 'pw' } });
    for (const [status, reason] of [[401, 'refused'], [404, 'no-password-sign-in'], [429, 'throttled'], [503, 'error'], [307, 'error']]) {
      answer = status;
      const result = await signInToWebapp(fetch, base, { username: 'sam', password: 'pw' });
      assert.equal(result, reason);
      assert.ok(SIGN_IN_ERRORS[result]);
    }
  } finally { server.close(); }
  assert.equal(await signInToWebapp(fetch, base, { username: 'sam', password: 'pw' }), 'unreachable');
  for (const message of Object.values(SIGN_IN_ERRORS)) assert.equal(/pw|sam/.test(message), false);
});
