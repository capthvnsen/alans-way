const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const preload = path.join(__dirname, 'tmp-cleanup.cjs'), withTmp = path.join(__dirname, 'with-tmp.cjs');
const scratch = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmp-cleanup-test-')); return { dir, env: { ...process.env, TMPDIR: dir, TMP: dir, TEMP: dir, HERMES_TEST_KEEP_TMP: '' } }; };
// The prefixes below are the ones that once filled the disk.
const make = body => `const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  for (const prefix of ['native-chat-home-', 'hermes-vps-host-', 'key-import-', 'gateway-api-', 'native-chat-', 'hermes-guest-', 'setup-check-', 'workspace-evidence-'])
    fs.writeFileSync(path.join(fs.mkdtempSync(path.join(os.tmpdir(), prefix)), 'x'), 'x');
  ${body}`;
const left = dir => fs.readdirSync(dir).sort();

for (const [name, body] of [['finishing', ''], ['throwing', 'throw new Error("boom")'], ['exiting with a code', 'process.exit(3)'],
  ['being terminated', 'process.kill(process.pid, "SIGTERM"); setTimeout(() => {}, 5000)']]) {
  test(`test temp folders are removed after a process ${name}`, () => {
    const { dir, env } = scratch();
    try {
      spawnSync(process.execPath, ['--require', preload, '-e', make(body)], { env, stdio: 'ignore' });
      assert.deepEqual(left(dir).filter(n => !/^workspace-evidence-/.test(n)), []);
      assert.equal(left(dir).length, 1, 'only the evidence folder, which is kept on purpose, remains');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}

test('with-tmp fails the run, and still cleans up, when a process leaves folders behind', () => {
  const { dir, env } = scratch();
  try {
    const run = body => spawnSync(process.execPath, [withTmp, process.execPath, '-e', make(body)], { env: { ...env, HERMES_TEST_KEEP_TMP: '1' }, encoding: 'utf8' });
    const leaky = run('');
    assert.equal(leaky.status, 1);
    assert.match(leaky.stderr, /TEMP LEAK.*native-chat-home-/);
    const tidy = spawnSync(process.execPath, [withTmp, process.execPath, '-e', make('')], { env, encoding: 'utf8' });
    assert.equal(tidy.status, 0, tidy.stderr);
    assert.deepEqual(left(dir), [], 'the private temp folder itself is gone');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
