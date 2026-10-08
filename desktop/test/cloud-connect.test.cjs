const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tailscaleCli, findPeer, parseComputerState, pairPollCommand, sshReadCommand, ensureKeypairCommand, publicKeyLine, tailnetHelpers } = require('../src/cloud-connect.cjs');

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

test('a tailnet name-collision suffix (-1, -2…) still matches the computer', () => {
  const collided = JSON.stringify({ Peer: { p1: { HostName: 'alan-42-1', TailscaleIPs: ['100.64.0.7'], Online: true } } });
  assert.deepEqual(findPeer(collided, 'alan-42'), { hostName: 'alan-42-1', ip: '100.64.0.7' });
  const other = JSON.stringify({ Peer: {
    a: { HostName: 'alan-42-extra', TailscaleIPs: ['100.64.0.7'], Online: true },
    b: { HostName: 'alan-420', TailscaleIPs: ['100.64.0.8'], Online: true },
    c: { HostName: 'alan-42-x', TailscaleIPs: ['100.64.0.9'], Online: true },
  } });
  assert.equal(findPeer(other, 'alan-42'), null, 'only a numeric suffix may match');
  assert.equal(findPeer(other, 'alan-4'), null, 'a partial prefix is not the name');
  const prefixed = JSON.stringify({ Peer: { p: { HostName: 'alan-4x2', TailscaleIPs: ['100.64.0.7'], Online: true } } });
  assert.equal(findPeer(prefixed, 'alan'), null, 'a non-numeric suffix is a different host');
});

test('an offline or absent computer is not paired', () => {
  assert.equal(findPeer(fixture, 'alan-99'), null, 'offline peer');
  assert.equal(findPeer(fixture, 'alan-7'), null, 'missing peer');
  assert.equal(findPeer('{bad json', 'alan-42'), null);
  assert.equal(findPeer('{"Self":{"HostName":"alan-42","TailscaleIPs":["100.64.0.1"],"Online":true}}', 'alan-42'), null, 'Self needs the shared secret: our own machine never counts');
});

test('the macOS CLI lives inside the app bundle; everywhere else PATH decides', () => {
  const mac = tailscaleCli({ platform: 'darwin', existsSync: () => true });
  assert.equal(mac, '/Applications/Tailscale.app/Contents/MacOS/Tailscale');
});

test('a brew or standalone CLI on PATH counts, on every platform', () => {
  const brew = (p) => p === '/opt/homebrew/bin/tailscale';
  assert.equal(tailscaleCli({ platform: 'darwin', existsSync: brew, pathEnv: '/opt/homebrew/bin:/usr/bin' }), 'tailscale');
  assert.equal(tailscaleCli({ platform: 'linux', existsSync: brew, pathEnv: '/opt/homebrew/bin' }), 'tailscale');
  const win = (p) => p.endsWith('tailscale.exe');
  assert.equal(tailscaleCli({ platform: 'win32', existsSync: win, pathEnv: 'C:\\Tools;C:\\Windows' }), 'tailscale');
});

test('no bundle and no PATH entry means not installed', () => {
  assert.equal(tailscaleCli({ platform: 'darwin', existsSync: () => false, pathEnv: '/usr/bin' }), null);
  assert.equal(tailscaleCli({ platform: 'linux', existsSync: () => false, pathEnv: '/usr/bin' }), null);
  assert.equal(tailscaleCli({ platform: 'win32', existsSync: () => false, pathEnv: 'C:\\Windows' }), null);
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

const CONNECT_MAC = path.join(__dirname, '..', '..', 'scripts', 'connect-mac.sh');
const COMPUTER_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample root@alan-1';

test('the keypair command generates only when missing, then prints the pubkey', () => {
  const cmd = ensureKeypairCommand();
  assert.match(cmd, /ssh-keygen -t ed25519 -N '' -f ~\/.ssh\/id_ed25519/);
  assert.match(cmd, /cat ~\/.ssh\/id_ed25519\.pub/);
  assert.match(cmd, /\[ -f ~\/.ssh\/id_ed25519\.pub \]/, 'generate only when the key is absent');
});

test('the first real key line is lifted from remote output', () => {
  assert.equal(publicKeyLine(`noise\n${COMPUTER_KEY} \n`), COMPUTER_KEY);
  assert.equal(publicKeyLine('no keys here'), '');
});

test('connect-mac.sh helper block is reused verbatim to restrict the key to the tailnet', (t) => {
  if (process.platform === 'win32') return t.skip('posix sh only');
  const helpers = tailnetHelpers(fs.readFileSync(CONNECT_MAC, 'utf8'));
  assert.match(helpers, /install_tailnet_key/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-keys-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'authorized_keys');
  fs.writeFileSync(file, 'ssh-ed25519 AAAAOther someone@else\n');
  for (let i = 0; i < 2; i++) {
    const res = spawnSync('sh', ['-c', `${helpers}\ninstall_tailnet_key "$1" "$2"`, 'sh', file, COMPUTER_KEY]);
    assert.equal(res.status, 0, res.stderr.toString());
  }
  assert.deepEqual(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean),
    ['ssh-ed25519 AAAAOther someone@else', `from="100.64.0.0/10,fd7a:115c:a1e0::/48" ${COMPUTER_KEY}`]);
});
