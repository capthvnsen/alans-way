'use strict';
// Each child loads tailnet policy once, just as the application does. All
// remote transports are fenced; only owned loopback callback listeners run.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const policyCheck = String.raw`
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const { createHermesRemote } = require('./src/hermes-remote.cjs');
let transport = 0, sockets = 0, listeners = 0, opened = 0;
http.request = https.request = () => { transport++; throw Error('transport_fence'); };
global.WebSocket = class { constructor() { sockets++; throw Error('socket_fence'); } };
const createServer = http.createServer;
http.createServer = (...args) => { listeners++; return createServer(...args); };
const remote = createHermesRemote();
const strict = process.env.HERMES_WORKSPACE_REQUIRE_TAILNET === '1';
const fixture = process.env.HERMES_WORKSPACE_ALLOW_LOOPBACK === '1';
const cases = [
  ['https://100.64.0.1', true, true],
  ['https://[fd7a:115c:a1e0::1]', true, true],
  ['https://macmini.example.ts.net', !strict, !strict],
  ['https://public.example', !strict, !strict],
  ['https://203.0.113.7', !strict, !strict],
  ['http://100.64.0.1', true, false],
  ['http://public.example', !strict, false],
  ['http://127.0.0.1', !strict || fixture, !strict || fixture],
  ['http://[::1]', !strict || fixture, !strict || fixture],
  ['http://localhost', !strict || fixture, false],
];
(async () => {
  for (const [raw, normalized, browser] of cases) {
    if (normalized) assert.doesNotThrow(() => remote.normalizeBaseUrl(raw), raw);
    else assert.throws(() => remote.normalizeBaseUrl(raw), { code: 'bad_url' }, raw);
    const before = { listeners, opened };
    const base = { origin: raw, prefix: '/hermes' };
    await assert.rejects(remote.signInBrowser({ base, provider: 'nous', openAuthUrl: async () => {
      opened++; throw Error('PRIVATE_BROWSER_CANARY');
    } }), error => error.code === (browser ? 'browser_unavailable' : 'bad_url') &&
      !error.message.includes('PRIVATE_BROWSER_CANARY'), raw);
    assert.equal(listeners - before.listeners, Number(browser), raw);
    assert.equal(opened - before.opened, Number(browser), raw);
    if (!normalized) {
      await assert.rejects(remote.providers(base), { code: 'bad_url' }, raw);
      await assert.rejects(remote.connectSocket({ url: raw.replace(/^http/, 'ws') + '/api/ws' }), { code: 'bad_url' }, raw);
    }
  }
  for (const origin of ['https://user:password@100.64.0.1', 'https://100.64.0.1/path',
    'https://100.64.0.1?target=elsewhere', 'https://100.64.0.1#fragment']) {
    const before = listeners;
    await assert.rejects(remote.signInBrowser({ base: { origin, prefix: '' }, provider: 'nous',
      openAuthUrl: async () => { opened++; throw Error('forged_base_opened'); } }), { code: 'bad_url' });
    assert.equal(listeners, before);
  }
  assert.equal(transport, 0);
  assert.equal(sockets, 0);
})().catch(error => { console.error(error); process.exitCode = 1; });
`;

for (const [mode, strict, loopback] of [
  ['legacy', '0', '0'], ['strict', '1', '0'], ['strict fixture', '1', '1'],
]) {
  test(`native browser, REST and WS keep ${mode} destination boundaries`, () => {
    const result = spawnSync(process.execPath, ['-e', policyCheck], {
      cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 10000,
      env: { ...process.env, HERMES_WORKSPACE_REQUIRE_TAILNET: strict,
        HERMES_WORKSPACE_ALLOW_LOOPBACK: loopback },
    });
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
  });
}
