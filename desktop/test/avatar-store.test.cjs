const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createAvatarStore, normalizeEyes } = require('../src/avatar-store.cjs');

function setup(prefs = {}) {
  prefs = { bots: [{ id: '123' }], avatarLibrary: [], avatarPreferences: {}, ...prefs };
  const store = createAvatarStore({ root: path.join(__dirname, '../src'), getPreferences: () => prefs });
  return { store, prefs };
}
test('avatar selection requires a known bot and a gallery item, and keeps Telegram discovery separate', () => {
  const { store, prefs } = setup();
  assert.throws(() => store.set({ id: '999', selectedId: 'telegram' }), /Choose a Telegram bot/);
  assert.throws(() => store.set({ id: '123', selectedId: 'file:///tmp/avatar.png' }), /available avatar/);
  const builtin = store.library()[0];
  store.set({ id: '123', selectedId: builtin.id, eyes: builtin.eyes });
  assert.equal(prefs.avatarPreferences['123'].selectedId, builtin.id);
  assert.deepEqual(prefs.bots, [{ id: '123' }]);
});
test('deleting a custom avatar resets every bot that uses it and preserves built-ins', () => {
  const { store, prefs } = setup({ avatarLibrary: [{ id: 'custom-test', name: 'Test', dataUrl: 'data:image/png;base64,AA==' }],
    avatarPreferences: { '123': { selectedId: 'custom-test' }, '456': { selectedId: 'telegram' } } });
  assert.throws(() => store.remove(store.library()[0].id), /Built-in/);
  store.remove('custom-test');
  assert.deepEqual(prefs.avatarLibrary, []);
  assert.deepEqual(prefs.avatarPreferences, { '456': { selectedId: 'telegram' } });
});
test('eye calibration values are finite, bounded, and disabled unless explicitly selected', () => {
  assert.equal(normalizeEyes(null).enabled, false);
  const eyes = normalizeEyes({ enabled: true, left: { x: -3, y: Infinity }, right: { x: 9 }, radius: 8, aspect: NaN });
  assert.equal(eyes.left.x, 0); assert.equal(eyes.right.x, 1);
  assert.ok(Number.isFinite(eyes.left.y)); assert.equal(eyes.radius, 0.12); assert.equal(eyes.aspect, 1.6);
});
