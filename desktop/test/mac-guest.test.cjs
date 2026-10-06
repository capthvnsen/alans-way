const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
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
  assert.equal(config.cdpUrl, 'http://127.0.0.1:9223');
  assert.equal(fs.statSync(path.join(data, 'config.json')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(data).mode & 0o777, 0o700);
});
