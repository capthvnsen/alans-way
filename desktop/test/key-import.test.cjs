const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { keyFiles, importKey } = require('../src/key-import.cjs');

const KEY = 'fake-import-key-0123456789abcdef';
const secure = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret' };

function setup(content = `${KEY}\n`, mode = 0o600) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'key-import-'));
  const dir = path.join(home, '.config', 'alans-way'), file = path.join(dir, 'hermes-api-key');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, content, { mode });
  fs.chmodSync(file, mode);
  let stored = null;
  const opts = { name: 'hermes', fs, home, safeStorage: secure, save: (key) => { stored = key; }, readBack: () => stored };
  return { home, file, opts, stored: () => stored };
}
// Every result and every thrown message is scanned for the key.
function run(opts) {
  try { const result = importKey(opts); assert.equal(JSON.stringify(result).includes(KEY), false); return result; }
  catch (error) { assert.equal(`${error.message}${error.stack}`.includes(KEY), false); assert.equal(error.message.includes('fake-import'), false); return { error: error.message }; }
}

test('keyFiles lists only <name>-api-key names', () => {
  const { home } = setup();
  const dir = path.join(home, '.config', 'alans-way');
  for (const name of ['api-key', 'UPPER-api-key', 'two-api-key', 'notes.txt']) fs.writeFileSync(path.join(dir, name), 'x');
  assert.deepEqual(keyFiles({ fs, home }), ['hermes', 'two']);
  assert.deepEqual(keyFiles({ fs, home: path.join(home, 'missing') }), []);
});

test('a good 600 file is saved, read back, then deleted', () => {
  const { file, opts, stored } = setup();
  assert.deepEqual(run(opts), { ok: true, deleted: true, detail: 'Key imported and the file deleted.' });
  assert.equal(stored(), KEY);
  assert.equal(fs.existsSync(file), false);
});

test('refusals leave the file alone and never save', () => {
  const cases = [
    ['symlink', (s) => { const real = `${s.file}.real`; fs.renameSync(s.file, real); fs.symlinkSync(real, s.file); }, /regular file/],
    ['wrong mode', (s) => fs.chmodSync(s.file, 0o644), /mode 600/],
    ['too short', (s) => fs.writeFileSync(s.file, 'short-key\n'), /16 to 500 bytes/],
    ['too long', (s) => fs.writeFileSync(s.file, `${KEY}${'x'.repeat(500)}`), /16 to 500 bytes/],
    ['whitespace inside', (s) => fs.writeFileSync(s.file, `${KEY.slice(0, 10)} ${KEY.slice(10)}\n`), /no spaces/],
    ['two lines', (s) => fs.writeFileSync(s.file, `${KEY}\n${KEY}\n`), /no spaces/],
    ['encryption unavailable', (s) => { s.opts.safeStorage = { isEncryptionAvailable: () => false }; }, /no secure storage/],
    ['linux basic_text', (s) => { s.opts.platform = 'linux'; s.opts.safeStorage = { ...secure, getSelectedStorageBackend: () => 'basic_text' }; }, /no secure storage/],
    ['someone else owns it', (s) => { s.opts.uid = process.getuid() + 1; }, /belong to you/],
    ['unknown name', (s) => { s.opts.name = '../hermes'; }, /not there/],
  ];
  for (const [why, change, reason] of cases) {
    const s = setup();
    change(s);
    const result = run(s.opts);
    assert.match(result.error || '', reason, why);
    assert.equal(s.stored(), null, why);
    assert.equal(fs.existsSync(s.file), true, why);
  }
});

test('Windows skips the owner and mode checks', () => {
  const { file, opts } = setup(KEY, 0o644);
  assert.equal(run({ ...opts, platform: 'win32' }).deleted, true);
  assert.equal(fs.existsSync(file), false);
});

test('the file stays when the save fails or does not read back', () => {
  for (const [why, change, reason] of [
    ['save throws', (o) => { o.save = () => { throw new Error(`disk full ${KEY}`); }; }, /could not be saved/],
    ['save silently lost', (o) => { o.save = () => {}; }, /did not read back/],
    ['read back differs', (o) => { o.readBack = () => `${KEY}x`; }, /did not read back/],
    ['read back throws', (o) => { o.readBack = () => { throw new Error(KEY); }; }, /did not read back/],
  ]) {
    const s = setup();
    change(s.opts);
    assert.match(run(s.opts).error || '', reason, why);
    assert.equal(fs.existsSync(s.file), true, why);
  }
});

test('an unlink failure keeps the import and says so', () => {
  const s = setup();
  const result = run({ ...s.opts, fs: { ...fs, unlinkSync: () => { throw new Error('EPERM'); } } });
  assert.deepEqual(result, { ok: true, deleted: false, detail: 'Imported, but could not delete the file: remove it yourself.' });
  assert.equal(s.stored(), KEY);
});
