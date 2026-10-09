const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isNewer, canSelfUpdate, bundleLocation } = require('../src/mac-update.cjs');

test('version compare', () => {
  assert.equal(isNewer('v0.3.1', '0.3.0'), true);
  assert.equal(isNewer('0.3.0', '0.3.0'), false);
  assert.equal(isNewer('0.10.0', '0.9.9'), true);
  assert.equal(isNewer('0.2.9', '0.3.0'), false);
  assert.equal(isNewer('0.3.1-rc.1', '0.3.0'), false);
  assert.equal(isNewer('', '0.3.0'), false);
  assert.equal(isNewer('garbage', '0.3.0'), false);
});
test('only an app bundle outside a mounted image can swap itself', () => {
  assert.equal(canSelfUpdate('/Applications/alans-way-localapp.app'), true);
  assert.equal(canSelfUpdate('/Volumes/alans-way-localapp/alans-way-localapp.app'), false);
  assert.equal(canSelfUpdate('/private/var/folders/x/AppTranslocation/y/d/alans-way-localapp.app'), false);
  assert.equal(canSelfUpdate(''), false);
});

test('bundleLocation accepts only /Applications/<productName>.app', () => {
  const at = (p) => bundleLocation(p, 'alans-way-localapp');
  assert.deepEqual(at('/Applications/alans-way-localapp.app'), { ok: true, kind: 'applications', path: '/Applications/alans-way-localapp.app' });
  assert.equal(at('/Applications/alans-way-localapp 3.app').kind, 'duplicate');
  assert.equal(at('/Applications/alans-way-localapp 2.app').ok, false);
  assert.equal(at('/Users/a/Downloads/alans-way-localapp.app').kind, 'downloads');
  assert.equal(at('/Volumes/alans-way-localapp 0.4.0/alans-way-localapp.app').kind, 'dmg');
  assert.equal(at('/Users/a/Desktop/alans-way-localapp.app').kind, 'other');
});
