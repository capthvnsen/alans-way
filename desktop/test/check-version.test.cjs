const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checkTag } = require('../scripts/check-version.cjs');

test('a final tag must equal the package version', () => {
  assert.equal(checkTag('v0.3.0', '0.3.0').ok, true);
  assert.equal(checkTag('v0.3.1', '0.3.0').ok, false);
  assert.match(checkTag('v0.3.1', '0.3.0').message, /v0\.3\.1.*0\.3\.0/);
});
test('a release candidate tag needs a matching base and keeps its tag version', () => {
  assert.deepEqual(checkTag('v0.3.0-rc.1', '0.3.0'), { ok: true, version: '0.3.0-rc.1' });
  assert.equal(checkTag('v0.3.1-rc.2', '0.3.0').ok, false);
});
test('a final tag reports the package version unchanged', () => {
  assert.equal(checkTag('v0.3.0', '0.3.0').version, '0.3.0');
});
test('anything that is not vX.Y.Z or vX.Y.Z-rc.N fails', () => {
  for (const tag of ['', 'garbage', '0.3.0', 'v0.3', 'v0.3.0.1', 'v0.3.0-beta.1', 'v0.3.0-rc', 'v0.3.0-rc.1.2', 'v01.3.0', undefined]) {
    assert.equal(checkTag(tag, '0.3.0').ok, false, String(tag));
  }
});
