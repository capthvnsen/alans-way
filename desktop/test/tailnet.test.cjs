const { test } = require('node:test');
const assert = require('node:assert/strict');
// The first test covers strict mode; the legacy default is covered by the spawned checks below.
process.env.HERMES_WORKSPACE_REQUIRE_TAILNET = '1';
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

test('the Hermes gateway accepts the Tailscale Serve name over https/wss and nothing looser', () => {
  const { tailnetUrl } = require('../src/tailnet.cjs');
  const gateway = (value) => { try { return tailnetUrl(new URL(value), true); } catch { return false; } };
  for (const url of ['https://vm.tail1234.ts.net', 'https://vm.tail1234.ts.net/p/work', 'https://vm.tail1234.ts.net:8443', 'HTTPS://VM.tail1234.TS.NET', 'wss://vm.tail1234.ts.net/api/ws?ticket=x', `http://${ip}:9119`]) assert.equal(gateway(url), true, url);
  for (const url of ['http://vm.tail1234.ts.net', 'ws://vm.tail1234.ts.net/api/ws', 'https://ts.net', 'https://.ts.net', 'https://a..ts.net', 'https://vm.tail1234.ts.net.', 'https://ts.net.evil.com', 'https://vm.ts.net.evil.com', 'https://evil-ts.net', 'https://evilts.net', 'https://vm.ts.net@evil.example', 'https://evil.example@vm.tail1234.ts.net', 'https://vm.tail1234.ts.net%2eevil.com',
    'https://xn--vm-6ma.tail1234.ts.net', 'https://vm.tѕ.net', 'https://vm.ts。net.evil.com', 'https://203.0.113.7', 'https://localhost', 'ftp://vm.tail1234.ts.net']) assert.equal(gateway(url), false, url);
  assert.equal(normalizeBaseUrl('https://vm.tail1234.ts.net/p/work/').origin, 'https://vm.tail1234.ts.net');
  for (const url of ['http://vm.tail1234.ts.net', 'https://ts.net.evil.com', 'https://user:pw@vm.tail1234.ts.net']) assert.throws(() => normalizeBaseUrl(url), /bad|Use|credentials/, url);
});

test('the serve-name allowance is opt-in: desktop and viewer addresses stay literal tailnet IPs', () => {
  for (const url of ['https://vm.tail1234.ts.net/vnc.html', 'wss://vm.tail1234.ts.net/websockify']) {
    assert.throws(() => parseRemoteUrl(url), /literal Tailscale IP/, url);
    assert.equal(viewerUrl(url), '', url);
  }
});

const fs = require('node:fs');
const vm = require('node:vm');
const rendererSource = fs.readFileSync(require.resolve('../src/renderer.js'), 'utf8');
const mainSource = fs.readFileSync(require.resolve('../src/main.cjs'), 'utf8');
const webappText = (state) => vm.runInNewContext(
  rendererSource.slice(rendererSource.indexOf('const WEBAPP_HOST_CHECK'), rendererSource.indexOf('function renderWebappHelp')) + ';webappStatusText', { state })();

test('the Hermes Desktop address wording names both accepted forms', () => {
  const accepted = 'an https://….ts.net address, or http://127.0.0.1:9120 together with your server’s SSH address';
  assert.ok(mainSource.includes(`Enter ${accepted}.`));
  assert.ok(rendererSource.includes('https://….ts.net or http://127.0.0.1:9120'));
  assert.ok(!/your-tailnet\.ts\.net/.test(mainSource + rendererSource));
});

test('an unreachable loopback Hermes Desktop with no saved SSH address says to save one', () => {
  const unreachable = { webappStatus: 'unreachable', hermesWebappUrl: 'http://127.0.0.1:9120/', tunnelNote: '', vpsBrowser: { sshHost: '' } };
  const text = webappText(unreachable);
  assert.match(text, /Save your server’s SSH address in Settings under Agent machine\./);
  assert.doesNotMatch(text, /hermes webapp --status/);
  assert.match(webappText({ ...unreachable, hermesWebappUrl: 'http://localhost:9120/' }), /Agent machine/);
  assert.match(webappText({ ...unreachable, vpsBrowser: undefined }), /Agent machine/);
});

test('every other unreachable Hermes Desktop keeps the host check', () => {
  const unreachable = { webappStatus: 'unreachable', hermesWebappUrl: 'http://127.0.0.1:9120/', tunnelNote: '', vpsBrowser: { sshHost: `agent@vm.tail1234.ts.net` } };
  assert.match(webappText(unreachable), /hermes webapp --status/, 'a saved SSH address means the tunnel is wanted');
  assert.match(webappText({ ...unreachable, vpsBrowser: {}, tunnelNote: 'Connecting to your server…' }), /Connecting to your server….*hermes webapp --status/);
  assert.match(webappText({ ...unreachable, hermesWebappUrl: 'https://vm.tail1234.ts.net/', vpsBrowser: {} }), /hermes webapp --status/);
});
