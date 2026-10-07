const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseClaimUrl, claim, ClaimError, createTokenQueue, ensureInstallId } = require('../src/cloud-claim.cjs');

const goodToken = 'Ab3_x-Yz0123456789abcd';

test('the claim deep link yields its token', () => {
  assert.equal(parseClaimUrl(`alansway://claim?token=${goodToken}`), goodToken);
  assert.equal(parseClaimUrl(`alansway:claim?token=${goodToken}`), goodToken);
  assert.equal(parseClaimUrl(`alansway://claim/?token=${goodToken}&ignored=1`), goodToken);
});

test('other schemes, paths and params are rejected', () => {
  for (const value of [
    `https://openalan.com/claim?token=${goodToken}`,
    `alansway://other?token=${goodToken}`,
    'alansway://claim',
    'alansway://claim?token=',
    'alansway://claim?token=has space in it',
    'alansway://claim?token=short',
    'alansway://claim?token=bad+chars/plus=',
    '', null, undefined, 'not a url',
  ]) assert.equal(parseClaimUrl(value), null, JSON.stringify(value));
});

const respond = (status, body = {}) => async () => ({ status, ok: status >= 200 && status < 300, json: async () => body });

test('a successful claim returns the session and expiry', async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, init }; return respond(200, { session: 'sess-1', expires_at: '2026-10-08T00:00:00Z' })(url, init); };
  const result = await claim('https://api.example', goodToken, 'install-1', fetchImpl);
  assert.deepEqual(result, { session: 'sess-1', expiresAt: '2026-10-08T00:00:00Z' });
  assert.equal(seen.url, 'https://api.example/api/claim');
  assert.equal(seen.init.method, 'POST');
  assert.deepEqual(JSON.parse(seen.init.body), { token: goodToken, install_id: 'install-1' });
});

test('a claimed token and an unknown token map to typed errors', async () => {
  await assert.rejects(claim('https://api.example', goodToken, 'i', respond(409)), (error) => error instanceof ClaimError && error.code === 'claimed');
  await assert.rejects(claim('https://api.example', goodToken, 'i', respond(404)), (error) => error instanceof ClaimError && error.code === 'unknown');
  await assert.rejects(claim('https://api.example', goodToken, 'i', respond(500)), (error) => error instanceof ClaimError && error.code === 'http');
  await assert.rejects(claim('https://api.example', goodToken, 'i', respond(200, {})), (error) => error instanceof ClaimError && error.code === 'bad-response');
});

test('tokens queue until the window is ready, then the newest wins', () => {
  const queue = createTokenQueue();
  const delivered = [];
  queue.push('first-token-001');
  queue.push('second-token-002');
  assert.equal(queue.pending, 'second-token-002');
  queue.setReady((token) => delivered.push(token));
  assert.equal(queue.pending, null);
  assert.deepEqual(delivered, ['second-token-002']);
  queue.push('third-token-003');
  assert.deepEqual(delivered, ['second-token-002', 'third-token-003']);
});

test('a token arriving after ready is delivered at once', () => {
  const queue = createTokenQueue();
  const delivered = [];
  queue.setReady((token) => delivered.push(token));
  queue.push('late-token-0001');
  assert.deepEqual(delivered, ['late-token-0001']);
});

test('install id is generated once and persisted in prefs', () => {
  const prefs = {};
  const id = ensureInstallId(prefs);
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.equal(prefs.installId, id);
  assert.equal(ensureInstallId(prefs), id, 'a second call keeps the stored id');
  prefs.installId = 'hand-set';
  assert.equal(ensureInstallId(prefs), 'hand-set');
});
