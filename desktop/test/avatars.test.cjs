const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { isActive, activityLabel, normalizeEyes, normalizeTint, resolveAvatar, gazeOffset, easeGaze, eyePose, createWander, createGaze } = require('../src/avatars.js');

test('animation requires an active signal and stops when its lease expires', () => {
  for (const activity of [undefined, {}, { state: 'idle' }, { state: 'unknown' }, { state: 'typing' }, { label: 'working' }, { state: 'active', expiresAt: 100 }, { state: 'active', expiresAt: '999' }]) {
    assert.equal(isActive(activity, 100), false);
  }
  assert.equal(isActive({ state: 'active', expiresAt: 101 }, 100), true);
  assert.equal(isActive({ state: 'active' }), true);
  assert.equal(activityLabel({ state: 'active', expiresAt: 100 }, 100), 'Idle · no live activity signal');
  assert.equal(activityLabel({ state: 'unknown' }), '');
  assert.equal(activityLabel(undefined), '');
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
  assert.deepEqual(eyes.left, { x: 0.05, y: 0.43, scaleX: 0.5, scaleY: 1, rotate: 0 });
  assert.deepEqual(eyes.right, { x: 0.95, y: 0.43, scaleX: 1.5, scaleY: 1, rotate: 0 });
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

test('every marble avatar records in-range eye geometry measured from its original eyes', () => {
  const directory = path.join(__dirname, '../assets/avatars');
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  for (const { id, eyes } of manifest) {
    const { left, right } = eyes;
    for (const [side, eye] of [['left', left], ['right', right]]) {
      const rx = eyes.radius * eye.scaleX, ry = eyes.radius * eyes.aspect * eye.scaleY;
      assert.ok(rx > 0.01 && rx < 0.03 && ry > 0.025 && ry < 0.06, `${id} ${side} radii ${rx} x ${ry}`);
      assert.ok(eye.x - rx > 0.2 && eye.x + rx < 0.8 && eye.y - ry > 0.2 && eye.y + ry < 0.6, `${id} ${side} sits on the face`);
      assert.ok(Math.abs(eye.rotate) <= 10, `${id} ${side} tilt ${eye.rotate}`);
    }
    assert.ok(left.x + eyes.radius < right.x - eyes.radius * right.scaleX, `${id} eyes do not overlap`);
    for (const edge of ['left', 'right', 'up', 'down']) assert.ok(eyes.travel[edge] > 0 && eyes.travel[edge] <= 0.05, `${id} travel.${edge}`);
  }
});

test('gaze eases towards a target without overshooting and returns to centre', () => {
  let look = { x: 0.9, y: -0.6 };
  for (let ms = 0; ms < 1000; ms += 16) {
    const next = easeGaze(look, { x: 0, y: 0 }, 16, 90);
    assert.ok(Math.abs(next.x) <= Math.abs(look.x) && Math.abs(next.y) <= Math.abs(look.y));
    look = next;
  }
  assert.ok(Math.hypot(look.x, look.y) < 0.001);
  assert.deepEqual(easeGaze({ x: 1, y: 1 }, { x: 0, y: 0 }, 1e9, 90), { x: 0, y: 0 });
  assert.deepEqual(easeGaze({ x: 0.3, y: 0.1 }, { x: 1, y: 1 }, 0, 90), { x: 0.3, y: 0.1 });
});

test('eye pose clamps travel to the avatar-specific reach and is neutral without a gaze', () => {
  const eyes = normalizeEyes({ enabled: true, style: 'obsidian', radius: 0.02, aspect: 2, travel: { left: 0.02, right: 0.01, up: 0.005, down: 0.01 } });
  assert.deepEqual(eyePose(eyes, 'left', { x: 0, y: 0 }), { x: 0, y: 0, scaleY: 1 });
  assert.deepEqual(eyePose(eyes, 'left', undefined), { x: 0, y: 0, scaleY: 1 });
  assert.deepEqual(eyePose(eyes, 'left', { x: NaN, y: 1 }), { x: 0, y: 0, scaleY: 1 });
  // reach / eye width: a full right glance moves 0.01 of the image = 25% of a 0.04-wide eye
  assert.ok(Math.abs(eyePose(eyes, 'left', { x: 1, y: 0 }).x - 25) < 1e-9);
  assert.ok(Math.abs(eyePose(eyes, 'left', { x: -1, y: 0 }).x + 50) < 1e-9);
  assert.deepEqual(eyePose(eyes, 'left', { x: 500, y: 0 }), eyePose(eyes, 'left', { x: 1, y: 0 }));
  const diagonal = eyePose(eyes, 'right', { x: 30, y: -40 });
  assert.ok(Math.abs(diagonal.x - eyePose(eyes, 'right', { x: 0.6, y: -0.8 }).x) < 1e-9);
  assert.ok(Math.abs(eyePose(eyes, 'left', { x: 0, y: -9 }).y + 0.005 / (2 * 0.02 * 2) * 100) < 1e-9);
  assert.equal(eyePose(eyes, 'left', { x: 0, y: 0 }, 1).scaleY.toFixed(2), '0.08');
  assert.equal(eyePose(eyes, 'left', { x: 0, y: 0 }, 7).scaleY.toFixed(2), '0.08');
});

test('a working bot wanders organically: bounded glances, irregular blinks, never a fixed loop', () => {
  let seed = 12345;
  const random = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const sample = createWander(random);
  const looks = new Set(), blinkStarts = [];
  let blinking = false;
  for (let now = 0; now < 120000; now += 16) {
    const { x, y, blink } = sample(now);
    assert.ok(Math.hypot(x, y) <= 1, `gaze (${x}, ${y}) stays in the unit disk`);
    assert.ok(blink >= 0 && blink <= 1);
    looks.add(`${Math.round(x * 4)},${Math.round(y * 4)}`);
    if (blink > 0 && !blinking) blinkStarts.push(now);
    blinking = blink > 0;
  }
  assert.ok(looks.size > 12, 'many different glances');
  assert.ok(blinkStarts.length >= 15 && blinkStarts.length <= 60, `blinks in 2 minutes: ${blinkStarts.length}`);
  const gaps = blinkStarts.slice(1).map((time, index) => time - blinkStarts[index]);
  assert.ok(Math.max(...gaps) - Math.min(...gaps) > 1500, 'blink spacing varies');
  assert.deepEqual([0, 1, 2].map((i) => createWander(() => 0.5)(i * 16).blink), [0, 0, 0]);
});

test('tint choices fall back to none and travel with the bot', () => {
  for (const value of ['red', 'blue', 'yellow', 'none']) assert.equal(normalizeTint(value), value);
  for (const value of [undefined, null, '', 'green', 'RED', 7, {}, ['red']]) assert.equal(normalizeTint(value), 'none');
  const bot = { id: '7', name: 'Test' };
  const state = { avatarLibrary: [{ id: 'marble-a', name: 'A', builtIn: true, cutout: true, dataUrl: 'a.png', eyes: { enabled: true, style: 'obsidian' } }],
    avatarPreferences: { 7: { selectedId: 'marble-a', tint: 'blue' }, 8: { selectedId: 'marble-a', tint: 'chartreuse' }, 9: { selectedId: 'marble-a' } } };
  assert.equal(resolveAvatar(bot, state).tint, 'blue');
  assert.equal(resolveAvatar({ id: '8' }, state).tint, 'none');
  assert.equal(resolveAvatar({ id: '9' }, state).tint, 'none');
  assert.equal(resolveAvatar({ id: '10' }, state).tint, 'none');
  assert.equal(resolveAvatar(bot, state, { selectedId: 'marble-a', tint: 'red' }).tint, 'red');
});

test('marble busts always draw the manifest eyes; photos and imported pictures stay as they were', () => {
  const bot = { id: '7', name: 'Test', avatar: 'telegram.png' };
  const state = { avatarLibrary: [
    { id: 'marble-a', name: 'A', builtIn: true, cutout: true, dataUrl: 'a.png', eyes: { enabled: false, style: 'obsidian', radius: 0.02 } },
    { id: 'custom-1', name: 'Mine', dataUrl: 'mine.png', eyes: { enabled: false } }],
    avatarPreferences: { 7: { selectedId: 'marble-a', eyes: { enabled: false, radius: 0.1 }, tint: 'red' } } };
  const marble = resolveAvatar(bot, state);
  assert.equal(marble.eyes.enabled, true);
  assert.equal(marble.eyes.radius, 0.02, 'a stale saved calibration cannot move the eyes off the eyeless image');
  for (const selectedId of ['custom-1', 'telegram', 'gone']) {
    const plain = resolveAvatar(bot, state, { selectedId, tint: 'red' });
    assert.equal(plain.eyes.enabled, false, `${selectedId} has no eye data, so no overlay is drawn`);
    assert.equal(plain.cutout, false, 'and is not treated as a tintable cutout');
  }
  assert.equal(resolveAvatar({ id: '1', name: 'No picture' }, {}).eyes.enabled, false);
});

const seeded = (seed) => () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;

test('an idle wander glances less far and more slowly than a working one, and still blinks', () => {
  const measure = (options) => {
    const sample = createWander(seeded(99), options);
    let farthest = 0, glances = 0, previous = '', blinks = 0, blinking = false;
    for (let now = 0; now < 120000; now += 16) {
      const { x, y, blink } = sample(now);
      assert.ok(Math.hypot(x, y) <= 1);
      farthest = Math.max(farthest, Math.hypot(x, y));
      const spot = `${Math.round(x * 3)},${Math.round(y * 3)}`;
      if (spot !== previous) glances++;
      previous = spot;
      if (blink > 0 && !blinking) blinks++;
      blinking = blink > 0;
    }
    return { farthest, glances, blinks };
  };
  const working = measure(undefined), idle = measure({ reach: 0.4, hold: 2.2 });
  assert.ok(idle.farthest < 0.5 && working.farthest > 0.7, `reach ${idle.farthest} vs ${working.farthest}`);
  assert.ok(idle.glances < working.glances * 0.6, `glances ${idle.glances} vs ${working.glances}`);
  assert.ok(idle.blinks >= 15 && idle.blinks <= 60, `an idle avatar still blinks at natural intervals: ${idle.blinks}`);
});

test('the gaze follows a moving pointer, then idles once it has been still for a couple of seconds', () => {
  const gaze = createGaze({ random: seeded(7) }), centre = { x: 100, y: 100 };
  const look = (now, busy = false) => gaze.sample(now, { busy, centre, range: 50 });
  assert.equal(look(0).following, false, 'no pointer yet: idle');
  gaze.pointer({ x: 400, y: 100 }, 1000);
  let sample = look(1016);
  assert.deepEqual([sample.following, sample.x, sample.y], [true, 1, 0], 'looks right at a pointer to the right');
  gaze.pointer({ x: -300, y: 100 }, 2000);
  assert.equal(look(2016).x, -1, 'and follows it when it moves');
  gaze.pointer({ x: -300, y: 101 }, 3000);
  assert.equal(look(3016).following, true, 'a 1 px tremor is not movement, but the pointer moved a moment ago');
  assert.equal(look(2000 + 2199).following, true);
  assert.equal(look(2000 + 2201).following, false, 'still for 2.2 s: back to idling');
  for (let now = 4300; now < 40000; now += 50) {
    sample = look(now);
    assert.ok(Math.hypot(sample.x, sample.y) < 0.5, 'idle glances stay small');
  }
  gaze.pointer({ x: 400, y: 400 }, 41000);
  assert.equal(look(41016).following, true, 'moving again wakes the following');
  gaze.pointer(null, 41100);
  assert.equal(look(41116).following, false, 'a pointer that left the window is not followed');
  gaze.pointer({ x: 400, y: 400 }, 44000);
  assert.equal(look(44016).following, false, 'coming back at the same spot, long after it last moved, is not movement');
  gaze.pointer({ x: 420, y: 400 }, 44100);
  assert.equal(look(44116).following, true);
  assert.equal(look(44116, true).following, true, 'a working bot follows the pointer too');
  assert.equal(gaze.sample(44116, { centre: undefined }).following, false, 'nowhere to look from, nothing to follow');
});

test('a gaze stays inside the unit disk whatever the pointer does', () => {
  const gaze = createGaze({ random: seeded(3) });
  for (const [index, point] of [{ x: 1e9, y: -1e9 }, { x: NaN, y: 4 }, { x: 5, y: 5 }, { x: 99, y: 7 }].entries()) {
    gaze.pointer(point, index * 100);
    const { x, y } = gaze.sample(index * 100 + 16, { centre: { x: 5, y: 5 }, range: 30 });
    assert.ok(Math.hypot(x, y) <= 1);
  }
});
