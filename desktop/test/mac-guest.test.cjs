const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { driverCommand } = require('../src/computer.cjs');

test('the computer helper runs through launchctl asuser only when asked', () => {
  const helper = '/repo/desktop/scripts/mac-computer';
  delete process.env.HERMES_COMPUTER_ASUSER;
  assert.deepEqual(driverCommand(helper, ['apps']), [helper, 'apps']);
  process.env.HERMES_COMPUTER_ASUSER = '1';
  try {
    assert.deepEqual(driverCommand(helper, ['snapshot', '7']),
      ['sudo', '-n', 'launchctl', 'asuser', String(process.getuid()), helper, 'snapshot', '7']);
  } finally {
    delete process.env.HERMES_COMPUTER_ASUSER;
  }
  process.env.HERMES_COMPUTER_ASUSER = '0';
  try {
    assert.deepEqual(driverCommand(helper, ['apps']), [helper, 'apps'], 'only "1" enables the wrapper');
  } finally {
    delete process.env.HERMES_COMPUTER_ASUSER;
  }
});

test('managed browser hosts pick their data dir by platform', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-home-'));
  const env = { ...process.env, HOME: home };
  delete env.HERMES_VPS_BROWSER_DATA;
  const want = process.platform === 'darwin'
    ? path.join(home, 'Library', 'Application Support', 'hermes-alans-way', 'browser', 'config.json')
    : path.join(home, '.local', 'share', 'hermes-alans-way', 'browser', 'config.json');
  for (const [script, args] of [['vps-browser-host.cjs', ['serve']], ['vps-chromium-host.cjs', []]]) {
    const result = spawnSync(process.execPath, [path.join(__dirname, '../scripts', script), ...args], {
      encoding: 'utf8', env,
    });
    assert.ok(result.stderr.includes(want), `${script} should read ${want} — got: ${result.stderr.slice(0, 300)}`);
  }
});

test('HERMES_VPS_BROWSER_DATA still overrides the platform default', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-home-'));
  const data = path.join(home, 'elsewhere');
  const env = { ...process.env, HOME: home, HERMES_VPS_BROWSER_DATA: data };
  const result = spawnSync(process.execPath,
    [path.join(__dirname, '../scripts/vps-chromium-host.cjs')], { encoding: 'utf8', env });
  assert.ok(result.stderr.includes(path.join(data, 'config.json')),
    `env override should win — got: ${result.stderr.slice(0, 300)}`);
});

test('the guest shell scripts parse', () => {
  for (const name of ['mac-guest-services.sh', 'mac-vm-setup.sh', 'mac-vm-preview.sh']) {
    const result = spawnSync('sh', ['-n', path.join(__dirname, '../../scripts', name)], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
  }
});

test('the guest installer emits valid plists and a default config', {
  skip: process.platform !== 'darwin' && 'plutil and launchd only exist on macOS',
}, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-guest-'));
  const data = path.join(home, 'data');
  const result = spawnSync('sh', [
    path.join(__dirname, '../../scripts/mac-guest-services.sh'),
    '--no-load', '--node', process.execPath,
  ], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, HERMES_VPS_BROWSER_DATA: data, CHROMIUM: '/bin/sh' },
  });
  assert.equal(result.status, 0, result.stderr);
  for (const label of ['com.alans-way.chromium.plist', 'com.alans-way.browser.plist']) {
    const plist = path.join(home, 'Library', 'LaunchAgents', label);
    const lint = spawnSync('plutil', ['-lint', plist], { encoding: 'utf8' });
    assert.equal(lint.status, 0, `${label}: ${lint.stderr}${lint.stdout}`);
    const content = fs.readFileSync(plist, 'utf8');
    assert.ok(content.includes(`<string>${process.execPath}</string>`), `${label} should run node`);
    assert.ok(content.includes(`<string>${data}</string>`), `${label} should carry the data dir`);
  }
  const config = JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8'));
  assert.equal(config.browserCommand, '/bin/sh', '$CHROMIUM should win discovery');
  const port = Number(new URL(config.cdpUrl).port);
  assert.ok(port >= 9223 && port <= 9422, `the default CDP port scan picked ${port}`);
  assert.ok(config.browserArgs.includes(`--remote-debugging-port=${port}`), 'browserArgs match cdpUrl');
  assert.equal(fs.statSync(path.join(data, 'config.json')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(data).mode & 0o777, 0o700);
});

const guestScript = path.join(__dirname, '../../scripts/mac-guest-services.sh');
const guestInstall = (data, extra = [], envExtra = {}) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-guest-'));
  const result = spawnSync('sh', [guestScript, '--no-load', '--node', process.execPath, ...extra], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, HERMES_VPS_BROWSER_DATA: data, CHROMIUM: '/bin/sh', ...envExtra },
  });
  return { home, result, config: () => JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8')) };
};
const darwinOnly = { skip: process.platform !== 'darwin' && 'plutil and launchd only exist on macOS' };
const freePort = (port) => new Promise((resolve) => {
  const probe = net.createServer();
  probe.once('error', () => resolve(freePort(port + 1)));
  probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(port)));
});

test('the guest installer honors --cdp-port and keeps it on re-run', darwinOnly, () => {
  const data = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-data-')), 'data');
  const first = guestInstall(data, ['--cdp-port', '9357']);
  assert.equal(first.result.status, 0, first.result.stderr);
  assert.equal(first.config().cdpUrl, 'http://127.0.0.1:9357');
  assert.ok(first.config().browserArgs.includes('--remote-debugging-port=9357'));
  const again = guestInstall(data);
  assert.equal(again.result.status, 0, again.result.stderr);
  assert.match(again.result.stdout, /kept existing/);
  assert.equal(again.config().cdpUrl, 'http://127.0.0.1:9357', 'a re-run keeps the chosen port');
  // An explicit --cdp-port on a re-run moves the managed browser, keeping the
  // rest of config.json, matching the setup.sh port precedence.
  const moved = guestInstall(data, ['--cdp-port', '9361']);
  assert.equal(moved.result.status, 0, moved.result.stderr);
  assert.match(moved.result.stdout, /CDP port.*9361|cdp.*9361/i, `the move is announced: ${moved.result.stdout}`);
  const config = moved.config();
  assert.equal(config.cdpUrl, 'http://127.0.0.1:9361');
  assert.ok(config.browserArgs.includes('--remote-debugging-port=9361'));
  assert.ok(!config.browserArgs.includes('--remote-debugging-port=9357'), 'the old port flag is replaced');
  assert.equal(config.browserCommand, '/bin/sh', 'other config fields survive the port move');
  assert.equal(config.port, 9465, 'the broker port is untouched');
  // The env var is the same explicit request.
  const movedEnv = guestInstall(data, [], { ALANS_WAY_CDP_PORT: '9363' });
  assert.equal(movedEnv.result.status, 0, movedEnv.result.stderr);
  assert.equal(movedEnv.config().cdpUrl, 'http://127.0.0.1:9363');
});

test('the guest installer picks the first free CDP port when the default is busy', darwinOnly, async () => {
  const listener = net.createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(9223, '127.0.0.1', resolve); });
  try {
    const data = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-data-')), 'data');
    const first = guestInstall(data);
    assert.equal(first.result.status, 0, first.result.stderr);
    const config = first.config();
    const port = Number(new URL(config.cdpUrl).port);
    assert.equal(port, await freePort(9223), 'first free loopback port wins over the busy 9223');
    assert.ok(port > 9223);
    assert.ok(config.browserArgs.includes(`--remote-debugging-port=${port}`));
    // An explicit request for the busy port is kept but announced.
    const forced = guestInstall(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-data-')), 'data'), ['--cdp-port', '9223']);
    assert.equal(forced.result.status, 0, forced.result.stderr);
    assert.match(forced.result.stdout, /already listening/, 'a busy explicit port warns');
    assert.equal(forced.config().cdpUrl, 'http://127.0.0.1:9223', 'an explicit port wins even when busy');
  } finally {
    listener.close();
  }
});
