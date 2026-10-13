const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const U = require('../src/update-all.cjs');
const V = require('../src/vm-update.cjs');
const target = { id: 'fixture', local: true };
const plugins = [{ name: 'alans-way', profile: 'default', version: '0.21.5' }];

const malformed = ['0.21.6garbage', '0.21.6+', '0.21.6..oops', '0.21.6+build..bad', '0.21.6+.', '01.21.6', '0.21.6-01'];
test('whole Hermes probe tokens must be valid before claiming current', () => {
  for (const token of malformed) {
    const cache = U.versionRecord(null, { target, check: { ok: true, hermesVersion: `Hermes Agent v${token}`, hermesCheck: 'up to date', plugins }, pluginLatest: '0.21.5', now: 1 });
    const view = U.describeVersions({ app: '0.21.5', cache });
    assert.equal(cache.hermes, '', token);
    assert.deepEqual(view.steps.map(s => s.id), ['hermes'], token);
    assert.match(view.tooltip, /Hermes: version unverified/);
    assert.doesNotMatch(view.tooltip, /up to date/);
    assert.equal(U.parseHermesCheck(`release available: stable v${token}`).latest, '');
  }
  assert.equal(U.parseHermesVersion('Hermes Agent v0.21.6-rc.1+build.2 (fixture)'), '0.21.6-rc.1');
  assert.equal(U.parseHermesVersion('Hermes Agent v0.21.6+build.2 (fixture)'), '0.21.6');
});

test('legacy scalar evidence cannot certify every plugin/profile as current', async () => {
  const guest = { ok: true, pluginVersion: '0.21.5', hermesVersion: 'Hermes Agent v0.21.6', hermesCheck: 'up to date' };
  const up = V.createVmUpdater({ readScript: () => '# fixture', run: async () => ({ code: 0, out: JSON.stringify(guest), err: '' }) });
  const cache = U.versionRecord(null, { target, check: await up.checkVm(target), pluginLatest: '0.21.5', now: 1 });
  assert.deepEqual(U.describeVersions({ app: '0.21.5', cache }).steps.map(s => s.id), ['plugin']);
  assert.match(U.describeVersions({ app: '0.21.5', cache }).tooltip, /profiles unverified/);
  assert.equal(U.planSteps({ app: '0.21.5', cache: { ...cache, pluginLatest: '' } })[0].id, 'plugin');
  assert.deepEqual(U.planSteps({ app: '0.21.5', cache: { ...cache, plugins } }), []);
});

test('scheme-less credential remnants are removed at the guest boundary', async () => {
  const remnant = 'SYNTHETICtail@host/repo?opaque=SYNTHETICquery#SYNTHETICfrag';
  const up = V.createVmUpdater({ readScript: () => '# fixture', run: async () => ({ code: 1, out: JSON.stringify({ ok: false, error: remnant, messages: [{ error: remnant }] }), err: '' }) });
  assert.doesNotMatch(JSON.stringify(await up.hermesUpdateVm(target)), /SYNTHETIC/);
});

test('long token-only SSH errors are scrubbed before guest tails and bot messages', { skip: process.platform === 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-r3-'));
  try {
    const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'hermes'), `#!/bin/sh
case "$1" in
  --version) echo 'Hermes Agent v0.21.6';;
  update) echo "$FAKE_ERROR"; exit 1;;
  send) echo "$*" > "$CASE_DIR/message"; echo "$FAKE_ERROR"; exit 1;;
esac
`, { mode: 0o755 });
    const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, HERMES_HOME: dir, TMPDIR: dir, CASE_DIR: dir,
      FAKE_ERROR: 'fatal ssh://' + 'SYNTHETIC'.repeat(70) + '@host/repo?opaque=SYNTHETICquery#SYNTHETICfrag' };
    const res = spawnSync('/bin/sh', [path.join(__dirname, '../scripts/hermes-update.sh')], { env, encoding: 'utf8', timeout: 10000 });
    assert.equal(res.status, 1, res.stderr);
    const up = V.createVmUpdater({ readScript: () => '# fixture', run: async () => ({ code: 1, out: res.stdout, err: res.stderr }) });
    const result = await up.hermesUpdateVm(target);
    const rows = await U.runSteps([{ id: 'hermes', name: 'Hermes', from: '0.21.6', to: 'latest' }], () => result);
    const surfaces = [res.stdout, fs.readFileSync(path.join(dir, 'message'), 'utf8'), JSON.stringify(result), V.hermesUpdateDetail(result, 'fixture'), U.runLogText(rows), U.reportText(rows)].join('\n');
    assert.doesNotMatch(surfaces, /SYNTHETIC/);
    assert.match(result.error, /host\/repo/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the shipped POSIX version validator rejects the same malformed tokens', { skip: process.platform === 'win32' }, () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/hermes-update.sh'), 'utf8');
  const start = source.indexOf('hermes_version() {');
  const fn = source.slice(start, source.indexOf('\n}', start) + 2);
  for (const token of [...malformed, '0.21.6', '0.21.6-rc.1+build.2']) {
    const res = spawnSync('/bin/sh', ['-c', fn + '\nprintf "%s" "$BANNER" | hermes_version'], {
      env: { PATH: '/usr/bin:/bin', BANNER: `Hermes Agent v${token} (fixture)` }, encoding: 'utf8', timeout: 2000,
    });
    assert.equal(res.stdout.trim(), malformed.includes(token) ? '' : token, token);
  }
});
