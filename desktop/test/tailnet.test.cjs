const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isTailnetAddress, SSH_OPTIONS } = require('../src/tailnet.cjs');
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
