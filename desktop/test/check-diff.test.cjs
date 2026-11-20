const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { select } = require('../scripts/check-diff.cjs');

function repo(files) {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), 'check-diff-'));
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(top, name)), { recursive: true });
    fs.writeFileSync(path.join(top, name), body);
  }
  return { top, root: path.join(top, 'desktop') };
}
const names = (picked) => picked && picked.map((f) => path.basename(f)).sort();

test('a changed source file selects the tests that import it, and with depth the tests that reach it through another module', () => {
  const { top, root } = repo({
    'desktop/src/a.cjs': "module.exports = require('./b.cjs');", 'desktop/src/b.cjs': '', 'desktop/src/c.cjs': '',
    'desktop/test/a.test.cjs': "require('../src/a.cjs');", 'desktop/test/c.test.cjs': "require('../src/c');",
  });
  try {
    assert.deepEqual(names(select(root, ['desktop/src/a.cjs'])), ['a.test.cjs']);
    assert.deepEqual(names(select(root, ['desktop/src/b.cjs'])), [], 'default: only a test\'s own imports');
    assert.deepEqual(names(select(root, ['desktop/src/b.cjs'], Infinity)), ['a.test.cjs'], '--deep follows imports of imports');
    assert.deepEqual(names(select(root, ['desktop/src/c.cjs'])), ['c.test.cjs']);
    assert.deepEqual(names(select(root, ['desktop/test/c.test.cjs'])), ['c.test.cjs']);
  } finally { fs.rmSync(top, { recursive: true, force: true }); }
});

test('a script a test names only as text, or builds a path to, is still selected by its file name', () => {
  const { top, root } = repo({
    'desktop/scripts/run.sh': '', 'desktop/scripts/other.sh': '',
    'desktop/test/s.test.cjs': "const p = path.join(__dirname, '../scripts/run.sh');",
    'desktop/test/t.test.cjs': "const base = path.join(__dirname, '../scripts'); read(base, 'other.sh');",
    'desktop/test/u.test.cjs': '',
  });
  try {
    assert.deepEqual(names(select(root, ['desktop/scripts/run.sh'])), ['s.test.cjs']);
    assert.deepEqual(names(select(root, ['desktop/scripts/other.sh'])), ['t.test.cjs']);
  } finally { fs.rmSync(top, { recursive: true, force: true }); }
});

test('changes it cannot place run everything: package files, other directories, shared test helpers', () => {
  const { top, root } = repo({ 'desktop/test/a.test.cjs': '', 'desktop/test/helper.cjs': '', 'desktop/test/x-electron.cjs': '' });
  try {
    for (const changed of [['desktop/package.json'], ['docs/setup-prompt.md'], ['desktop/test/helper.cjs'], ['desktop/src/a.cjs', 'tests/x.py']]) {
      assert.equal(select(root, changed), null, changed.join());
    }
    assert.deepEqual(names(select(root, ['desktop/test/x-electron.cjs'])), []);
  } finally { fs.rmSync(top, { recursive: true, force: true }); }
});
