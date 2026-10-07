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
test('published state carries avatar URLs instead of image bytes and the protocol serves them by id', () => {
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  const { store, prefs } = setup({ bots: [{ id: '123', avatar: png }, { id: '456', avatar: '' }],
    avatarLibrary: [{ id: 'custom-test', name: 'Test', dataUrl: png }] });
  const custom = store.publicLibrary().find(item => item.id === 'custom-test');
  assert.equal(custom.dataUrl, 'hw-avatar://library/custom-test');
  assert.equal(prefs.avatarLibrary[0].dataUrl, png, 'stored data is untouched');
  assert.ok(store.publicLibrary().filter(item => item.builtIn).every(item => item.dataUrl.startsWith('../assets/avatars/')));
  const [first] = store.publicBots();
  assert.match(first.avatar, /^hw-avatar:\/\/bot\/123\?v=[0-9a-f]{10}$/);
  assert.equal(store.publicBots()[1].avatar, '');
  assert.equal(JSON.stringify([store.publicLibrary(), store.publicBots()]).includes('base64'), false);
  const served = store.imageFor(custom.dataUrl);
  assert.equal(served.mime, 'image/png');
  assert.deepEqual([...served.data], [...Buffer.from('iVBORw0KGgo=', 'base64')]);
  assert.equal(store.imageFor(first.avatar).mime, 'image/png');
  assert.equal(store.imageFor('hw-avatar://library/custom-missing'), null);
  assert.equal(store.imageFor('hw-avatar://bot/456'), null);
  assert.equal(store.imageFor('hw-avatar://other/123'), null);
});
test('a bot picture that changes gets a new URL so the renderer reloads it', () => {
  const a = 'data:image/png;base64,AAAA', b = 'data:image/png;base64,BBBB';
  const { store, prefs } = setup({ bots: [{ id: '123', avatar: a }] });
  const first = store.publicBots()[0].avatar;
  assert.equal(store.publicBots()[0].avatar, first, 'stable while unchanged');
  prefs.bots[0].avatar = b;
  assert.notEqual(store.publicBots()[0].avatar, first);
});
