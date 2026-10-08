const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseSetupUrl, splitTailnetTarget, createLinkQueue } = require('../src/setup-link.cjs');
const { cloudStep, startServerSetup } = require('../src/onboarding.cjs');

test('the setup deep link yields its host', () => {
  assert.equal(parseSetupUrl('alansway://setup?host=alan-7'), 'alan-7');
  assert.equal(parseSetupUrl('alansway:setup?host=alan-7'), 'alan-7');
  assert.equal(parseSetupUrl('alansway://setup/?host=alan-7&ignored=1'), 'alan-7');
  assert.equal(parseSetupUrl('alansway://setup?host=root@alan-7'), 'root@alan-7');
  assert.equal(parseSetupUrl('alansway://setup?host=alan-7.example-tailnet.ts.net'), 'alan-7.example-tailnet.ts.net');
  assert.equal(parseSetupUrl('alansway://setup?host=100.64.0.1'), '100.64.0.1');
  assert.equal(parseSetupUrl('alansway://setup?host=100.127.255.254'), '100.127.255.254');
  assert.equal(parseSetupUrl('alansway://setup?host=fd7a:115c:a1e0::1'), 'fd7a:115c:a1e0::1');
  assert.equal(parseSetupUrl('alansway://setup?host=fd7a:115c:a1e0:ab12:cd34:ef56:0000:0001'), 'fd7a:115c:a1e0:ab12:cd34:ef56:0000:0001');
  assert.equal(parseSetupUrl('alansway://setup?host=ubuntu@fd7a:115c:a1e0::1'), 'ubuntu@fd7a:115c:a1e0::1');
});

test('other schemes, paths and hosts are rejected', () => {
  for (const value of [
    'https://example.com/setup?host=alan-7',
    'alansway://other?host=alan-7',
    'alansway://claim?token=alan-7',
    'alansway://setup',
    'alansway://setup?host=',
    'alansway://setup?host=has space',
    'alansway://setup?host=a%20b',
    'alansway://setup?host=a"b',
    "alansway://setup?host=a'b",
    'alansway://setup?host=a;b',
    'alansway://setup?host=a|b',
    'alansway://setup?host=-alan',
    'alansway://setup?host=alan-',
    'alansway://setup?host=example.com',
    'alansway://setup?host=alan-7.ts.net.evil.com',
    'alansway://setup?host=ts.net',
    'alansway://setup?host=Alan-7',
    'alansway://setup?host=100.63.255.255',
    'alansway://setup?host=100.128.0.1',
    'alansway://setup?host=10.0.0.1',
    'alansway://setup?host=192.168.1.1',
    'alansway://setup?host=8.8.8.8',
    'alansway://setup?host=alan-7:22',
    'alansway://setup?host=[fd7a:115c:a1e0::1]',
    'alansway://setup?host=fe80::1',
    'alansway://setup?host=fd7a:115c:a1e1::1',
    'alansway://setup?host=fd7a:115c:a1e0::1:extra:junk',
    'alansway://setup?host=me@-alan',
    'alansway://setup?host=@alan-7',
    'alansway://setup?host=a@b@c',
    'alansway://setup?host=me%40you@alan-7',
    '', null, undefined, 'not a url',
  ]) assert.equal(parseSetupUrl(value), null, JSON.stringify(value));
});

test('splitTailnetTarget splits user@ from a valid tailnet host only', () => {
  assert.deepEqual(splitTailnetTarget('alan-7'), { user: '', host: 'alan-7' });
  assert.deepEqual(splitTailnetTarget('root@alan-7'), { user: 'root', host: 'alan-7' });
  assert.deepEqual(splitTailnetTarget('deploy_1@100.64.0.1'), { user: 'deploy_1', host: '100.64.0.1' });
  assert.equal(splitTailnetTarget('alan 7'), null);
  assert.equal(splitTailnetTarget('example.com'), null);
  assert.equal(splitTailnetTarget('root@10.0.0.1'), null);
  assert.equal(splitTailnetTarget(''), null);
  assert.equal(splitTailnetTarget(null), null);
});

test('a host queues until the window is ready, then the newest wins', () => {
  const queue = createLinkQueue();
  const delivered = [];
  queue.push('alan-1');
  queue.push('alan-2');
  assert.equal(queue.pending, 'alan-2');
  queue.setReady((host) => delivered.push(host));
  assert.equal(queue.pending, null);
  assert.deepEqual(delivered, ['alan-2']);
  queue.push('alan-3');
  assert.deepEqual(delivered, ['alan-2', 'alan-3']);
});

test('a host arriving after ready is delivered at once; junk is ignored', () => {
  const queue = createLinkQueue();
  const delivered = [];
  queue.setReady((host) => delivered.push(host));
  queue.push('alan-9');
  queue.push(null);
  queue.push('');
  assert.deepEqual(delivered, ['alan-9']);
});

test('a setup link starts the wizard at connect with the host prefilled', () => {
  const prefs = { onboarded: true };
  startServerSetup(prefs, 'root@alan-7');
  assert.equal(cloudStep(prefs), 'connect');
  assert.equal(prefs.cloud.setupHost, 'root@alan-7');
  assert.equal(prefs.onboarded, false, 'the wizard reopens even for a finished setup');
});

test('the setup button enters the same wizard without a host', () => {
  const prefs = {};
  startServerSetup(prefs);
  assert.equal(cloudStep(prefs), 'connect');
  assert.equal(prefs.cloud.setupHost, undefined);
});

test('a later link re-prefills the host and restarts at connect', () => {
  const prefs = { cloud: { step: 'telegram', setupHost: 'alan-1', botUsername: 'x_bot' } };
  startServerSetup(prefs, 'alan-2');
  assert.equal(cloudStep(prefs), 'connect');
  assert.equal(prefs.cloud.setupHost, 'alan-2');
  assert.equal(prefs.cloud.botUsername, 'x_bot', 'earlier setup state survives');
});
