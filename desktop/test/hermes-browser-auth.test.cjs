const { ip: fixtureTailnet } = require('./tailnet-fixture.cjs');
process.env.HERMES_WORKSPACE_ALLOW_LOOPBACK = '1';
'use strict';
// Synthetic native OAuth against real loopback HTTP and the real hub/wire.
// No system browser, provider account, credential store or external network.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createHermesRemote } = require('../src/hermes-remote.cjs');
const { createHermesHub } = require('../src/hermes-hub.cjs');
const { fakeBackend } = require('./hermes-auth-fake-backend.cjs');

function request(raw, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(raw, { ...options, agent: false }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}
const settle = p => p.then(value => ({ value }), error => ({ error }));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('OAuth-only backend signs in through browser PKCE, refresh and ticket without a password', async () => {
  const backend = await fakeBackend({ nativeBrowser: true, provider: 'nous', tokenTag: 'oauth' });
  const saved = [], opened = [];
  const hub = createHermesHub({ persist: value => saved.push(value), openAuthUrl: async raw => {
    opened.push(raw);
    const authorize = new URL(raw);
    assert.equal(authorize.origin, backend.url);
    assert.equal(authorize.pathname, '/auth/native/authorize');
    assert.equal(authorize.searchParams.get('provider'), 'nous');
    assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
    const callback = new URL(authorize.searchParams.get('redirect_uri'));
    assert.equal(callback.hostname, '127.0.0.1');
    assert.notEqual(callback.port, '');
    const response = await request(raw);
    const done = await request(response.headers.location);
    assert.equal(done.status, 200);
    assert.equal(done.headers['cache-control'], 'no-store');
    assert.ok(!done.body.includes('gwcode-') && !done.body.includes(authorize.searchParams.get('state')));
  } });
  try {
    await hub.command('configure', { url: backend.url });
    await assert.rejects(hub.command('connect'), { code: 'needs_signin' });
    assert.equal(hub.getState().providers[0].browser, true, 'OAuth-only provider advertises browser sign-in');
    await assert.doesNotReject(hub.command('sign-in-browser', { provider: 'nous' }));
    assert.equal(hub.getState().status, 'ready');
    assert.deepEqual(hub.getState().principal, { userId: 'oauth-user', provider: 'nous' });
    assert.ok(saved.at(-1).tokens.refreshToken.startsWith('rt-oauth-'));
    assert.equal(opened.length, 1);
    assert.ok(!backend.hits.some(hit => hit.url === '/auth/password-login'));
    assert.ok(backend.hits.some(hit => hit.url === '/auth/native/refresh'));
    assert.ok(backend.hits.some(hit => hit.url === '/api/auth/ws-ticket'));
    assert.ok(!JSON.stringify(hub.getState()).includes('rt-oauth-'));
  } finally { hub.dispose(); await backend.close(); }
});

test('callback ambiguity, wrong peer authority and request bodies cannot consume valid login', async () => {
  const backend = await fakeBackend({ nativeBrowser: true, provider: 'nous' });
  const remote = createHermesRemote();
  let callback;
  try {
    let tokens;
    await assert.doesNotReject(async () => { tokens = await remote.signInBrowser({
      base: remote.normalizeBaseUrl(backend.url), provider: 'nous', openAuthUrl: async raw => {
        callback = (await request(raw)).headers.location;
        const wrong = new URL(callback); wrong.searchParams.set('state', 'wrong');
        assert.notEqual((await request(wrong)).status, 200);
        for (const key of ['state', 'code']) {
          const duplicate = new URL(callback); duplicate.searchParams.append(key, 'extra');
          assert.notEqual((await request(duplicate)).status, 200);
        }
        const path = new URL(callback); path.pathname = '/wrong';
        assert.notEqual((await request(path)).status, 200);
        assert.notEqual((await request(callback, { headers: { Host: 'attacker.invalid' } })).status, 200);
        assert.notEqual((await request(callback, { method: 'POST', body: 'denied' })).status, 200);
        assert.notEqual((await request(callback, { headers: { 'Content-Length': '6' }, body: 'denied' })).status, 200);
        assert.equal((await request(callback)).status, 200);
      },
    }); });
    assert.equal(tokens.provider, 'nous');
    await assert.rejects(request(callback), { code: 'ECONNREFUSED' });
    assert.equal(backend.hits.filter(hit => hit.url === '/auth/native/token').length, 1);
  } finally { await backend.close(); }
});

for (const action of ['configure', 'disconnect', 'sign-out', 'cancel-sign-in']) {
  test(`${action} cancels browser auth and never persists or connects stale credentials`, async () => {
    const backend = await fakeBackend({ nativeBrowser: true, provider: 'nous' });
    const saved = [];
    let opened;
    const seen = new Promise(resolve => { opened = resolve; });
    const hub = createHermesHub({ persist: value => saved.push(value), openAuthUrl: async raw => { opened(raw); } });
    try {
      await hub.command('configure', { url: backend.url });
      await assert.rejects(hub.command('connect'), { code: 'needs_signin' });
      const pending = settle(hub.command('sign-in-browser', { provider: 'nous' }));
      const raw = await Promise.race([seen, wait(500).then(() => null)]);
      assert.ok(raw, 'the supported OAuth flow must open its browser');
      assert.equal(hub.getState().signInPending, true);
      await hub.command(action, action === 'configure' ? { url: 'http://127.0.0.1:1' } : {});
      const result = await pending;
      assert.ok(result.error && ['stale', 'aborted'].includes(result.error.code));
      assert.equal(hub.getState().signInPending, false);
      assert.equal(hub.getState().principal, null);
      assert.ok(!saved.some(record => record.tokens));
      assert.equal(backend.hits.filter(hit => hit.url === '/auth/native/token').length, 0);
      const callback = new URL(new URL(raw).searchParams.get('redirect_uri'));
      await assert.rejects(request(callback), { code: 'ECONNREFUSED' });
    } finally { hub.dispose(); await backend.close(); }
  });
}

test('browser launch errors and OAuth callback errors are fixed and redacted', async () => {
  const remote = createHermesRemote();
  const base = remote.normalizeBaseUrl(`https://${fixtureTailnet}`);
  await assert.rejects(async () => {
    assert.equal(typeof remote.signInBrowser, 'function');
    await remote.signInBrowser({ base, provider: 'nous', openAuthUrl: async () => { throw new Error('PRIVATE_CANARY'); } });
  }, error => error.code === 'browser_unavailable' && !error.message.includes('PRIVATE_CANARY'));
  await assert.rejects(remote.signInBrowser({ base, provider: 'nous', openAuthUrl: async raw => {
    const authorize = new URL(raw), callback = new URL(authorize.searchParams.get('redirect_uri'));
    callback.searchParams.set('state', authorize.searchParams.get('state'));
    callback.searchParams.set('error', 'access_denied');
    callback.searchParams.set('error_description', 'PRIVATE_CANARY');
    await request(callback);
  } }), error => error.code === 'auth_cancelled' && !error.message.includes('PRIVATE_CANARY'));
});

test('provider names without confirmed flow metadata cannot launch a browser or password request', async () => {
  const backend = await fakeBackend({ nativeBrowser: true, provider: 'nous' });
  const remote = createHermesRemote();
  remote.providers = async () => [{ name: 'nous' }];
  let opened = 0;
  const hub = createHermesHub({ remote, openAuthUrl: async () => { opened++; throw new Error('should not open'); } });
  try {
    await hub.command('configure', { url: backend.url });
    await assert.rejects(hub.command('connect'), { code: 'needs_signin' });
    await assert.rejects(hub.command('sign-in-browser', { provider: 'nous' }), { code: 'no_browser_provider' });
    await assert.rejects(hub.command('sign-in', { provider: 'nous' }), { code: 'no_password_provider' });
    assert.equal(opened, 0);
    assert.deepEqual(hub.getState().providers, [{ name: 'nous', displayName: 'nous', password: false, browser: false }]);
  } finally { hub.dispose(); await backend.close(); }
});

test('browser authentication timeout and already-aborted attempts release callback resources', async () => {
  const remote = createHermesRemote(), base = remote.normalizeBaseUrl(`https://${fixtureTailnet}`);
  let callback;
  await assert.rejects(remote.signInBrowser({ base, provider: 'nous', timeoutMs: 10,
    openAuthUrl: async raw => { callback = new URL(raw).searchParams.get('redirect_uri'); },
  }), { code: 'timeout' });
  await assert.rejects(request(callback), { code: 'ECONNREFUSED' });
  let opened = false;
  const ctl = new AbortController(); ctl.abort();
  await assert.rejects(remote.signInBrowser({ base, provider: 'nous', signal: ctl.signal,
    openAuthUrl: async () => { opened = true; },
  }), { code: 'aborted' });
  assert.equal(opened, false);
});

test('non-loopback plaintext browser authentication is rejected before browser or network use', async () => {
  let opened = false;
  const remote = createHermesRemote();
  await assert.rejects(remote.signInBrowser({ base: remote.normalizeBaseUrl(`http://${fixtureTailnet}`), provider: 'nous',
    openAuthUrl: async () => { opened = true; },
  }), { code: 'bad_url' });
  assert.equal(opened, false);
});

test('a backend move during browser token exchange cannot persist or forward the old credential', async () => {
  const a = await fakeBackend({ nativeBrowser: true, provider: 'nous', tokenTag: 'older', tokenDelayMs: 200 });
  const b = await fakeBackend({ nativeBrowser: true, provider: 'nous', tokenTag: 'newer' });
  const saved = [];
  const hub = createHermesHub({ persist: value => saved.push(value), openAuthUrl: async raw => {
    await request((await request(raw)).headers.location);
  } });
  try {
    await hub.command('configure', { url: a.url });
    await assert.rejects(hub.command('connect'), { code: 'needs_signin' });
    const old = settle(hub.command('sign-in-browser', { provider: 'nous' }));
    for (let i = 0; i < 50 && !a.hits.some(hit => hit.url === '/auth/native/token'); i++) await wait(5);
    assert.ok(a.hits.some(hit => hit.url === '/auth/native/token'));
    await hub.command('configure', { url: b.url });
    assert.equal((await old).error.code, 'stale');
    assert.ok(!saved.some(record => JSON.stringify(record).includes('rt-older-')));
    assert.ok(!b.leaked('-older-'));
    assert.equal(hub.getState().principal, null);
    assert.equal(hub.getState().target.url, b.url);
    assert.ok(!a.hits.some(hit => hit.url === '/auth/native/refresh'));
  } finally { hub.dispose(); await a.close(); await b.close(); }
});

test('a stale browser attempt cannot clear a newer attempt while it is still pending', async () => {
  const backend = await fakeBackend({ nativeBrowser: true, provider: 'nous' });
  const saved = [];
  let firstResolve, secondResolve, opens = 0, oldCallback;
  const first = new Promise(resolve => { firstResolve = resolve; });
  const second = new Promise(resolve => { secondResolve = resolve; });
  const hub = createHermesHub({ persist: value => saved.push(value), openAuthUrl: async raw => {
    if (++opens === 1) { oldCallback = new URL(raw).searchParams.get('redirect_uri'); firstResolve(); return; }
    secondResolve(raw);
  } });
  try {
    await hub.command('configure', { url: backend.url });
    await assert.rejects(hub.command('connect'), { code: 'needs_signin' });
    const older = settle(hub.command('sign-in-browser', { provider: 'nous' }));
    await first;
    const newer = settle(hub.command('sign-in-browser', { provider: 'nous' }));
    const raw = await second;
    assert.equal((await older).error.code, 'stale');
    assert.equal(hub.getState().signInPending, true);
    assert.equal(hub.getState().principal, null);
    assert.ok(!saved.some(record => record.tokens));
    await assert.rejects(request(oldCallback), { code: 'ECONNREFUSED' });
    await request((await request(raw)).headers.location);
    assert.ok((await newer).value);
    assert.equal(hub.getState().status, 'ready');
    assert.equal(hub.getState().signInPending, false);
    assert.equal(backend.hits.filter(hit => hit.url === '/auth/native/token').length, 1);
  } finally { hub.dispose(); await backend.close(); }
});

for (const move of ['profile', 'prefix']) {
  test(`a same-origin ${move} move during browser token exchange rejects the old credential`, async () => {
    const backend = await fakeBackend({ nativeBrowser: true, provider: 'nous', tokenTag: 'old', tokenDelayMs: 200 });
    const saved = [];
    const hub = createHermesHub({ persist: value => saved.push(value), openAuthUrl: async raw => {
      await request((await request(raw)).headers.location);
    } });
    try {
      await hub.command('configure', { url: backend.url, profile: 'first' });
      await assert.rejects(hub.command('connect'), { code: 'needs_signin' });
      const pending = settle(hub.command('sign-in-browser', { provider: 'nous' }));
      for (let i = 0; i < 50 && !backend.hits.some(hit => hit.url === '/auth/native/token'); i++) await wait(5);
      assert.ok(backend.hits.some(hit => hit.url === '/auth/native/token'));
      const target = { url: backend.url + (move === 'prefix' ? '/new-prefix' : ''),
        profile: move === 'profile' ? 'second' : 'first' };
      await hub.command('configure', target);
      assert.equal((await pending).error.code, 'stale');
      assert.ok(!saved.some(record => record.tokens));
      assert.equal(hub.getState().principal, null);
      assert.equal(hub.getState().target.url, target.url);
      assert.equal(hub.getState().target.profile, target.profile);
      assert.ok(!backend.hits.some(hit => hit.url === '/auth/native/refresh' || hit.url === '/api/auth/ws-ticket'));
    } finally { hub.dispose(); await backend.close(); }
  });
}

test('cancellation closes the callback even when the browser opener never settles', async () => {
  const remote = createHermesRemote(), ctl = new AbortController();
  let opened, rejectOpener;
  const seen = new Promise(resolve => { opened = resolve; });
  const unhandled = [];
  const onUnhandled = error => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  try {
    const pending = settle(remote.signInBrowser({ base: remote.normalizeBaseUrl(`https://${fixtureTailnet}`),
      provider: 'nous', signal: ctl.signal, openAuthUrl: raw => {
        opened(new URL(raw).searchParams.get('redirect_uri'));
        return new Promise((_resolve, reject) => { rejectOpener = reject; });
      } }));
    const callback = await seen;
    ctl.abort();
    assert.equal((await pending).error.code, 'aborted');
    await assert.rejects(request(callback), { code: 'ECONNREFUSED' });
    rejectOpener(new Error('PRIVATE_LATE_OPENER_CANARY'));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally { process.removeListener('unhandledRejection', onUnhandled); }
});

test('an OAuth provider without native_pkce cannot advertise or start native browser login', async () => {
  const backend = await fakeBackend({ nativeBrowser: true, provider: 'nous' });
  const remote = createHermesRemote(), originalProbe = remote.probe.bind(remote);
  remote.probe = async (...args) => ({ ...await originalProbe(...args), authFlows: ['cookie'] });
  let opened = 0;
  const hub = createHermesHub({ remote, openAuthUrl: async () => { opened++; } });
  try {
    await hub.command('configure', { url: backend.url });
    await assert.rejects(hub.command('connect'), { code: 'needs_signin' });
    assert.equal(hub.getState().providers[0].browser, false);
    await assert.rejects(hub.command('sign-in-browser', { provider: 'nous' }), { code: 'auth_flow_unsupported' });
    assert.equal(opened, 0);
    assert.ok(!backend.hits.some(hit => hit.url.startsWith('/auth/')));
  } finally { hub.dispose(); await backend.close(); }
});

test('browser token exchange rejects missing credentials and mismatched provider or subject', async () => {
  const valid = { access_token: 'SYNTHETIC_ACCESS', refresh_token: 'SYNTHETIC_REFRESH',
    provider: 'nous', user_id: 'synthetic-user' };
  for (const tokenResponse of [
    {}, { ...valid, access_token: '' }, { ...valid, refresh_token: '' },
    { ...valid, provider: 'different-provider' }, { ...valid, user_id: '' },
  ]) {
    const backend = await fakeBackend({ nativeBrowser: true, provider: 'nous', tokenResponse });
    const remote = createHermesRemote();
    try {
      await assert.rejects(remote.signInBrowser({ base: remote.normalizeBaseUrl(backend.url),
        provider: 'nous', openAuthUrl: async raw => {
          await request((await request(raw)).headers.location);
        } }), error => error.code === 'auth_failed' &&
          error.message === 'The backend could not complete browser sign-in.');
      assert.equal(backend.hits.filter(hit => hit.url === '/auth/native/token').length, 1);
      assert.ok(!backend.hits.some(hit => hit.url === '/auth/native/refresh' || hit.url === '/api/auth/ws-ticket'));
    } finally { await backend.close(); }
  }
});
