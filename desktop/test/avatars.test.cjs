const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { isActive, activityLabel, normalizeEyes, resolveAvatar, gazeOffset } = require('../src/avatars.js');

test('animation requires an active signal and stops when its lease expires', () => {
  for (const activity of [undefined, {}, { state: 'idle' }, { state: 'unknown' }, { state: 'typing' }, { label: 'working' }, { state: 'active', expiresAt: 100 }, { state: 'active', expiresAt: '999' }]) {
    assert.equal(isActive(activity, 100), false);
  }
  assert.equal(isActive({ state: 'active', expiresAt: 101 }, 100), true);
  assert.equal(isActive({ state: 'active' }), true);
  assert.equal(activityLabel({ state: 'active', expiresAt: 100 }, 100), 'Idle · no live activity signal');
  assert.equal(activityLabel({ state: 'unknown' }), 'Activity unavailable');
});

test('avatar selection falls back to Telegram without applying a different gallery asset', () => {
  const bot = { id: '7', name: 'Test', avatar: 'data:image/png;base64,telegram' };
  const library = [{ id: 'custom', name: 'Photo', dataUrl: 'data:image/png;base64,custom', eyes: { enabled: true, style: 'obsidian' } }];
  const state = { avatarLibrary: library, avatarPreferences: { 7: { selectedId: 'custom' } } };
  assert.equal(resolveAvatar(bot, state).src, library[0].dataUrl);
  assert.equal(resolveAvatar(bot, state).eyes.enabled, true);
  state.avatarPreferences[7].selectedId = 'deleted';
  assert.equal(resolveAvatar(bot, state).src, bot.avatar);
  assert.equal(resolveAvatar(bot, state).selectedId, 'telegram');
  assert.equal(resolveAvatar(bot, state).eyes.enabled, false);
  assert.equal(resolveAvatar(bot, {}, { selectedId: 'telegram', eyes: { enabled: true } }).eyes.enabled, true);
});

test('eye configuration rejects invalid input and bounds the editable geometry', () => {
  const eyes = normalizeEyes({ enabled: 'true', radius: Infinity, aspect: 99, style: 'other', left: { x: -1, y: NaN, scaleX: 0 }, right: { x: 3, y: '0.2', scaleX: 10 } });
  assert.equal(eyes.enabled, false);
  assert.equal(eyes.radius, 0.045);
  assert.equal(eyes.aspect, 3);
  assert.equal(eyes.style, 'classic');
  assert.deepEqual(eyes.left, { x: 0.05, y: 0.43, scaleX: 0.5 });
  assert.deepEqual(eyes.right, { x: 0.95, y: 0.43, scaleX: 1.5 });
  assert.equal(normalizeEyes({ enabled: true }).enabled, true);
});

test('gaze follows the real pointer and stays inside each eye ellipse', () => {
  assert.deepEqual(gazeOffset(undefined, { x: 100, y: 100 }, 4, 8), { x: 0, y: 0 });
  assert.deepEqual(gazeOffset({ x: 100, y: 100 }, { x: 100, y: 100 }, 4, 8), { x: 0, y: 0 });
  assert.deepEqual(gazeOffset({ x: 10000, y: 100 }, { x: 100, y: 100 }, 4, 8), { x: 4, y: 0 });
  for (const point of [{ x: -10000, y: -10000 }, { x: 7, y: 21 }, { x: 100, y: 9000 }]) {
    const offset = gazeOffset(point, { x: 100, y: 100 }, 4, 8);
    assert.ok((offset.x / 4) ** 2 + (offset.y / 8) ** 2 <= 1.0000001);
    assert.equal(Math.sign(offset.x), Math.sign(point.x - 100));
    assert.equal(Math.sign(offset.y), Math.sign(point.y - 100));
  }
});

test('each marble avatar ships with an original image and calibrated enabled eyes', () => {
  const directory = path.join(__dirname, '../assets/avatars');
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.length, 10);
  assert.equal(new Set(manifest.map((entry) => entry.id)).size, manifest.length);
  for (const entry of manifest) {
    assert.ok(fs.existsSync(path.join(directory, entry.file)));
    assert.equal(entry.source.startsWith('ChatGPT Image Oct 3, 2026,'), true);
    assert.equal(entry.eyes.enabled, true);
    assert.equal(entry.eyes.style, 'obsidian');
    assert.deepEqual(normalizeEyes(entry.eyes), entry.eyes);
  }
});
