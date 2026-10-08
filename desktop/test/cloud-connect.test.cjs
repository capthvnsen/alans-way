const { test } = require('node:test');
const assert = require('node:assert/strict');
const { tailscaleCli, findPeer, parseComputerState, pairPollCommand, sshReadCommand } = require('../src/cloud-connect.cjs');

const fixture = JSON.stringify({
  Self: { HostName: 'my-mac', TailscaleIPs: ['100.64.0.1'], Online: true },
  Peer: {
    'peer-1': { HostName: 'alan-42', TailscaleIPs: ['100.64.0.7', 'fd7a:115c:a1e0::7'], Online: true },
    'peer-2': { HostName: 'alan-99', TailscaleIPs: ['100.64.0.9'], Online: false },
  },
});

test('the matching online peer yields its tailnet address', () => {
  assert.deepEqual(findPeer(fixture, 'alan-42'), { hostName: 'alan-42', ip: '100.64.0.7' });
});

test('an offline or absent computer is not paired', () => {
  assert.equal(findPeer(fixture, 'alan-99'), null, 'offline peer');
  assert.equal(findPeer(fixture, 'alan-7'), null, 'missing peer');
  assert.equal(findPeer('{bad json', 'alan-42'), null);
  assert.equal(findPeer('{"Self":{"HostName":"alan-42","TailscaleIPs":["100.64.0.1"],"Online":true}}', 'alan-42'), null, 'Self needs the shared secret: our own machine never counts');
});

test('the macOS CLI lives inside the app bundle; Windows and Linux use PATH', () => {
  const mac = tailscaleCli({ platform: 'darwin', existsSync: () => true });
  assert.equal(mac, '/Applications/Tailscale.app/Contents/MacOS/Tailscale');
  assert.equal(tailscaleCli({ platform: 'darwin', existsSync: () => false }), null, 'missing bundle means not installed');
  assert.equal(tailscaleCli({ platform: 'win32', existsSync: () => false }), 'tailscale');
  assert.equal(tailscaleCli({ platform: 'linux', existsSync: () => false }), 'tailscale');
});

test('the status command is read-only json', () => {
  assert.deepEqual(pairPollCommand('/Applications/Tailscale.app/Contents/MacOS/Tailscale'), ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', ['status', '--json']]);
  assert.deepEqual(pairPollCommand('tailscale'), ['tailscale', ['status', '--json']]);
});

test('the computer state file parses, and junk does not', () => {
  assert.deepEqual(parseComputerState('{"state":"ready","step":"paired"}'), { state: 'ready', step: 'paired' });
  assert.equal(parseComputerState(''), null);
  assert.equal(parseComputerState('not json'), null);
  assert.equal(parseComputerState('[]'), null);
});

test('remote reads quote the path and never interpolate raw input', () => {
  assert.equal(sshReadCommand('/var/lib/alan/state.json'), "cat '/var/lib/alan/state.json'");
});

test('a ~ path expands on the remote: the tilde stays outside the quotes', () => {
  assert.equal(sshReadCommand('~/.hermes/.env'), "cat ~/'.hermes/.env'");
  assert.equal(sshReadCommand('~/.hermes/profiles/personal/.env'), "cat ~/'.hermes/profiles/personal/.env'");
  assert.equal(sshReadCommand("~/it's.env"), "cat ~/'it'\\''s.env'");
});
