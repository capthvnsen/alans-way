const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { test } = require('node:test');
const { scanProfile } = require('./profile-disk-scan.cjs');

function fixture(t) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'next-FX6-scan-'));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  return profile;
}

for (const partition of ['', 'Partitions/telegram']) {
  test(`rescans renamed files, including earlier files (${partition || 'root'})`, t => {
    const profile = fixture(t);
    const dir = path.join(profile, partition);
    fs.mkdirSync(dir, { recursive: true });
    const earlier = path.join(dir, 'a-checked');
    const temporary = path.join(dir, 'z-temporary');
    const final = path.join(dir, 'final');
    fs.writeFileSync(earlier, 'clean');
    fs.writeFileSync(temporary, 'clean');
    const read = fs.readFileSync;
    let renamed = false;
    t.mock.method(fs, 'readFileSync', (file, ...args) => {
      if (file === temporary && !renamed) {
        renamed = true;
        fs.renameSync(temporary, final);
        fs.writeFileSync(earlier, 'changed');
      }
      return read(file, ...args);
    });
    const seen = [];
    scanProfile(profile, (bytes, file) => seen.push([file, bytes.toString()]));
    assert.ok(renamed);
    assert.ok(seen.some(([file]) => file === final), 'checks the renamed destination');
    assert.ok(seen.some(([file, text]) => file === earlier && text === 'changed'), 'restarts the entire scan');
  });
}

test('a secret in a renamed destination still fails the privacy assertion', t => {
  const profile = fixture(t);
  const temporary = path.join(profile, 'temporary');
  const final = path.join(profile, 'final');
  fs.writeFileSync(temporary, 'fixture-secret');
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (file === temporary && fs.existsSync(temporary)) fs.renameSync(temporary, final);
    return read(file, ...args);
  });
  assert.throws(() => scanProfile(profile, bytes => assert.ok(!bytes.includes('fixture-secret'), 'secret reached disk')),
    { code: 'ERR_ASSERTION', message: 'secret reached disk' });
});

test('continuous ENOENT fails after five whole scans', t => {
  const profile = fixture(t);
  fs.writeFileSync(path.join(profile, 'unstable'), 'clean');
  let attempts = 0;
  const missing = Object.assign(new Error('fixture vanished'), { code: 'ENOENT' });
  t.mock.method(fs, 'readFileSync', () => { attempts++; throw missing; });
  assert.throws(() => scanProfile(profile, () => {}), error => error === missing);
  assert.equal(attempts, 5);
});

test('other filesystem errors and assertion failures are never retried', t => {
  const profile = fixture(t);
  fs.writeFileSync(path.join(profile, 'file'), 'clean');
  let attempts = 0;
  const denied = Object.assign(new Error('fixture denied'), { code: 'EACCES' });
  const mock = t.mock.method(fs, 'readFileSync', () => { attempts++; throw denied; });
  assert.throws(() => scanProfile(profile, () => {}), error => error === denied);
  assert.equal(attempts, 1);
  mock.mock.restore();
  attempts = 0;
  assert.throws(() => scanProfile(profile, () => { attempts++; assert.fail('secret reached disk'); }), /secret reached disk/);
  assert.equal(attempts, 1);
});
