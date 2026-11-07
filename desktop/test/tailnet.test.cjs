const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isTailnetAddress, hermesWebappUrl, SSH_OPTIONS } = require('../src/tailnet.cjs');
const { isSshTarget, parseRemoteUrl, viewerUrl } = require('../src/core.cjs');
const { normalizeBaseUrl } = require('../src/hermes-remote.cjs');
const { ip } = require('./tailnet-fixture.cjs');

test('all saved destinations require literal tailnet addresses, including IPv6 encodings', () => {
  for (const host of [ip, 'fd7a:115c:a1e0::1', 'fd7a:115c:a1e0:0:0:0:0:2']) assert.equal(isTailnetAddress(host), true);
  for (const host of ['203.0.113.7', '10.0.0.1', '169.254.169.254', 'fd00::1', 'fd7a:115c:a1e1::1', 'fd7a:115c:a1e0::1%eth0', 'vm.tail.ts.net', 'alias']) {
    assert.equal(isSshTarget('user@' + host), false, host);
    const url = `http://${host.includes(':') ? `[${host}]` : host}/`;
    assert.throws(() => parseRemoteUrl(url), undefined, host);
    assert.throws(() => normalizeBaseUrl(url), undefined, host);
    assert.equal(viewerUrl(url), '', host);
  }
  assert.equal(isSshTarget('user@' + ip), true);
  assert.equal(isSshTarget('user@[fd7a:115c:a1e0::1]'), true);
  assert.equal(parseRemoteUrl(`http://${ip}/vnc.html`), `ws://${ip}/websockify`);
  assert.equal(viewerUrl(`http://${ip}/vnc.html?host=203.0.113.7`), `http://${ip}/vnc.html`);
  assert.deepEqual(SSH_OPTIONS.slice(0, 2), ['-F', 'none']);
});


test('legacy installs retain aliases and viewers; explicit enforcement never falls back', () => {
  const { spawnSync } = require('node:child_process');
  const script = `const assert = require('node:assert/strict');
    const { isSshTarget, parseRemoteUrl } = require('./src/core.cjs');
    const { SSH_OPTIONS } = require('./src/tailnet.cjs');
    const strict = process.env.HERMES_WORKSPACE_REQUIRE_TAILNET === '1';
    assert.equal(isSshTarget('user@saved-alias'), !strict);
    assert.equal(isSshTarget('user@host;command'), false);
    if (strict) assert.throws(() => parseRemoteUrl('https://viewer.example/vnc.html'));
    else assert.equal(parseRemoteUrl('https://viewer.example/vnc.html'), 'wss://viewer.example/websockify');
    assert.equal(SSH_OPTIONS.includes('none'), strict);`;
  for (const value of ['', '1']) {
    const result = spawnSync(process.execPath, ['-e', script], { cwd: require('node:path').join(__dirname, '..'), env: { ...process.env, HERMES_WORKSPACE_REQUIRE_TAILNET: value }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    if (!value) assert.match(result.stderr, /Legacy workspace transport/);
  }
});

test('the Hermes Webapp pane loads only Tailscale Serve names and this machine', () => {
  for (const url of ['https://vm.tail1234.ts.net/', 'https://vm.tail1234.ts.net/hermes/', 'http://127.0.0.1:9120/', 'http://localhost:9120/']) assert.equal(hermesWebappUrl(url), url);
  assert.equal(hermesWebappUrl('  HTTPS://VM.tail1234.TS.NET '), 'https://vm.tail1234.ts.net/');
  for (const url of ['', null, 'not a url', 'http://vm.tail1234.ts.net/', 'https://ts.net/', 'https://evil-ts.net/', 'https://vm.ts.net.evil.example/', 'https://127.0.0.1:9120/', 'http://127.0.0.2:9120/',
    `http://${ip}:9120/`, 'file:///etc/passwd', 'https://user:pw@vm.tail1234.ts.net/', 'https://vm.tail1234.ts.net/?ticket=x', 'http://127.0.0.1:9120/webapp/launch#ticket=x']) assert.equal(hermesWebappUrl(url), '', String(url));
});
