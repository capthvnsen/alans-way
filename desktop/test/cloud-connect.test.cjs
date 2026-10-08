const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tailscaleCli, findPeerForTarget, parseComputerState, pairPollCommand, sshReadCommand, ensureKeypairCommand, publicKeyLine, tailnetHelpers, authorizeKeyCommand } = require('../src/cloud-connect.cjs');

const fixture = JSON.stringify({
  Self: { HostName: 'my-mac', TailscaleIPs: ['192.0.2.1'], Online: true },
  Peer: {
    'peer-1': { HostName: 'alan-42', DNSName: 'alan-42.example-tailnet.ts.net.', TailscaleIPs: ['192.0.2.7', 'fd7a:115c:a1e0::7'], Online: true },
    'peer-2': { HostName: 'alan-99', TailscaleIPs: ['192.0.2.9'], Online: false },
  },
});

test('the matching online peer yields its tailnet address', () => {
  assert.deepEqual(findPeerForTarget(fixture, 'alan-42'), { hostName: 'alan-42', ip: '192.0.2.7' });
});

test('a setup target can name the peer by MagicDNS name or tailnet address', () => {
  assert.deepEqual(findPeerForTarget(fixture, 'alan-42.example-tailnet.ts.net'), { hostName: 'alan-42', ip: '192.0.2.7' }, 'full DNSName');
  assert.deepEqual(findPeerForTarget(fixture, 'alan-42.example-tailnet.ts.net.'), { hostName: 'alan-42', ip: '192.0.2.7' }, 'trailing-dot DNSName');
  assert.deepEqual(findPeerForTarget(fixture, '192.0.2.7'), { hostName: 'alan-42', ip: '192.0.2.7' }, 'tailnet v4');
  assert.deepEqual(findPeerForTarget(fixture, 'fd7a:115c:a1e0::7'), { hostName: 'alan-42', ip: '192.0.2.7' }, 'tailnet v6 resolves to the v4');
  const dnsOnly = JSON.stringify({ Peer: { p: { HostName: 'ubuntu-1', DNSName: 'server.tail-abc.ts.net.', TailscaleIPs: ['192.0.2.10'], Online: true } } });
  assert.deepEqual(findPeerForTarget(dnsOnly, 'server'), { hostName: 'ubuntu-1', ip: '192.0.2.10' }, 'a bare MagicDNS name matches the DNSName label');
});

test('a tailnet name-collision suffix (-1, -2…) still matches the server', () => {
  const collided = JSON.stringify({ Peer: { p1: { HostName: 'alan-42-1', TailscaleIPs: ['192.0.2.7'], Online: true } } });
  assert.deepEqual(findPeerForTarget(collided, 'alan-42'), { hostName: 'alan-42-1', ip: '192.0.2.7' });
  const other = JSON.stringify({ Peer: {
    a: { HostName: 'alan-42-extra', TailscaleIPs: ['192.0.2.7'], Online: true },
    b: { HostName: 'alan-420', TailscaleIPs: ['192.0.2.8'], Online: true },
    c: { HostName: 'alan-42-x', TailscaleIPs: ['192.0.2.9'], Online: true },
  } });
  assert.equal(findPeerForTarget(other, 'alan-42'), null, 'only a numeric suffix may match');
  assert.equal(findPeerForTarget(other, 'alan-4'), null, 'a partial prefix is not the name');
  const prefixed = JSON.stringify({ Peer: { p: { HostName: 'alan-4x2', TailscaleIPs: ['192.0.2.7'], Online: true } } });
  assert.equal(findPeerForTarget(prefixed, 'alan'), null, 'a non-numeric suffix is a different host');
});

test('an offline or absent peer does not match', () => {
  assert.equal(findPeerForTarget(fixture, 'alan-99'), null, 'offline peer');
  assert.equal(findPeerForTarget(fixture, 'alan-7'), null, 'missing peer');
  assert.equal(findPeerForTarget('{bad json', 'alan-42'), null);
  assert.equal(findPeerForTarget('{"Self":{"HostName":"alan-42","TailscaleIPs":["192.0.2.1"],"Online":true}}', 'alan-42'), null, 'our own machine never counts');
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
  assert.match(cmd, /mkdir -p ~\/.ssh/, 'ssh-keygen fails when ~/.ssh does not exist yet');
});

test('the keypair command works against a home with no .ssh dir at all', (t) => {
  if (process.platform === 'win32') return t.skip('posix sh only');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const res = spawnSync('sh', ['-c', ensureKeypairCommand()], { env: { ...process.env, HOME: home } });
  assert.equal(res.status, 0, res.stderr.toString());
  assert.match(fs.readFileSync(path.join(home, '.ssh', 'id_ed25519.pub'), 'utf8'), /^ssh-ed25519 /);
});

test('the first real key line is lifted from remote output, reduced to type and blob', () => {
  assert.equal(publicKeyLine(`noise\n${COMPUTER_KEY} \n`), 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample');
  assert.equal(publicKeyLine('no keys here'), '');
});

test('the key comment is untrusted remote text and never reaches authorized_keys', () => {
  const blob = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample';
  assert.equal(publicKeyLine(`${blob} \\ncommand="id" ssh-rsa CCC`), blob, 'the awk -v escape injection stays in the dropped comment');
  assert.equal(publicKeyLine(`${blob}\tevil`), blob);
  assert.equal(publicKeyLine('ssh-ed25519 AAAA=xBBB rest'), '', 'a blob that does not end in whitespace is not a key line');
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

test('the wanted line reaches awk through the environment, never through -v escapes', () => {
  const helpers = tailnetHelpers(fs.readFileSync(CONNECT_MAC, 'utf8'));
  const body = helpers.split('install_tailnet_key() {')[1] || '';
  assert.match(body, /ENVIRON\["WANT"\]/);
  assert.doesNotMatch(body, /awk -v/);
});

test('a key with a backslash escape cannot smuggle an unrestricted line in', (t) => {
  if (process.platform === 'win32') return t.skip('posix sh only');
  const helpers = tailnetHelpers(fs.readFileSync(CONNECT_MAC, 'utf8'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-keys-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'authorized_keys');
  fs.writeFileSync(file, 'ssh-ed25519 AAAAOther someone@else\n');
  // A literal backslash-n in the key: awk -v would have printed it as a real
  // newline, splitting an unrestricted `command="id" ssh-rsa CCC` line out of
  // the tailnet-restricted one. The helper must refuse the key outright.
  const hostile = 'ssh-ed25519 AAAABBB \\ncommand="id" ssh-rsa CCC';
  const res = spawnSync('sh', ['-c', `${helpers}\ninstall_tailnet_key "$1" "$2"`, 'sh', file, hostile]);
  assert.notEqual(res.status, 0, 'a key with escapes must be rejected');
  assert.deepEqual(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean),
    ['ssh-ed25519 AAAAOther someone@else'], 'the file is untouched');
});

test('install_tailnet_key reports a failed write instead of masking it', (t) => {
  if (process.platform === 'win32') return t.skip('posix sh only');
  const helpers = tailnetHelpers(fs.readFileSync(CONNECT_MAC, 'utf8'));
  const res = spawnSync('sh', ['-c', `${helpers}\ninstall_tailnet_key "$1" "$2"`, 'sh', '/no/such/dir/authorized_keys', COMPUTER_KEY]);
  assert.notEqual(res.status, 0, 'rm must not hide the awk/cat exit code');
});

test('the authorize chain creates authorized_keys at 600 restricted to the tailnet', (t) => {
  if (process.platform === 'win32') return t.skip('posix sh only');
  const helpers = tailnetHelpers(fs.readFileSync(CONNECT_MAC, 'utf8'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const res = spawnSync('sh', ['-c', authorizeKeyCommand(helpers), 'sh', 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample'],
    { env: { ...process.env, HOME: home } });
  assert.equal(res.status, 0, res.stderr.toString());
  const keys = path.join(home, '.ssh', 'authorized_keys');
  assert.equal(fs.statSync(keys).mode & 0o777, 0o600, 'sshd StrictModes would ignore a permissive file');
  assert.deepEqual(fs.readFileSync(keys, 'utf8').split('\n').filter(Boolean),
    ['from="100.64.0.0/10,fd7a:115c:a1e0::/48" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample']);
});

test('a node shared in from another tailnet, or owned by another user, never matches', () => {
  const status = JSON.stringify({
    Self: { HostName: 'my-mac', UserID: 1, TailscaleIPs: ['192.0.2.1'], Online: true },
    Peer: {
      shared: { HostName: 'alan-1', ShareeNode: true, UserID: 9, TailscaleIPs: ['192.0.2.5'], Online: true },
      other: { HostName: 'alan-2', UserID: 7, TailscaleIPs: ['192.0.2.6'], Online: true },
      mine: { HostName: 'alan-3', UserID: 1, TailscaleIPs: ['192.0.2.7'], Online: true },
    },
  });
  assert.equal(findPeerForTarget(status, 'alan-1'), null, 'shared-in node');
  assert.equal(findPeerForTarget(status, '192.0.2.5'), null, 'shared-in node by address');
  assert.equal(findPeerForTarget(status, 'alan-2'), null, 'another user on the tailnet');
  assert.deepEqual(findPeerForTarget(status, 'alan-3'), { hostName: 'alan-3', ip: '192.0.2.7' });
  assert.deepEqual(findPeerForTarget(status, 'ALAN-3'), { hostName: 'alan-3', ip: '192.0.2.7' }, 'case-insensitive');
});
