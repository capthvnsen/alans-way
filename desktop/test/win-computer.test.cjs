const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const win = require('../src/win-computer.cjs');
const source = path.join(__dirname, '..', 'scripts', 'win-computer.cs');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('the Windows computer helper only runs on Windows', () => {
  if (process.platform === 'win32') return;
  assert.throws(() => win.apps(), /only runs on Windows/);
  assert.throws(() => win.snapshot(1), /only runs on Windows/);
  assert.throws(() => win.screenshot(1), /only runs on Windows/);
});

test('the Windows driver speaks the shared desktop protocol', () => {
  const cs = fs.readFileSync(source, 'utf8');
  for (const command of ['apps', 'snapshot', 'press', 'click', 'type', 'drag', 'shot']) {
    assert.ok(cs.includes(`"${command}"`), `missing command ${command}`);
  }
  for (const key of ['bundleId', 'frontmost', 'elements', 'cursorMoved', 'imageWidth', 'imageHeight', 'windowX', 'windowWidth']) {
    assert.ok(cs.includes(key), `missing key ${key}`);
  }
  for (const message of [
    'Password fields are off limits.',
    'Unknown ref. Take a fresh snapshot.',
    'App not found.',
    'That app is off limits.',
    'That app has no window to capture.',
    'That app is the one in front. Leave it there; the pointer stays where it is.',
  ]) {
    assert.ok(cs.includes(message), `missing message ${message}`);
  }
  assert.ok(cs.includes('{\\"ref\\":\\"c'), 'refs use the c<N> scheme');
});

test('the Windows helper compiles and drives notepad', async (t) => {
  if (process.platform !== 'win32') return;
  const exe = win.ensureBinary();
  assert.ok(fs.existsSync(exe), 'ensureBinary produced win-computer.exe');
  let notepad;
  try {
    notepad = spawn('notepad.exe');
  } catch {
    return t.skip('notepad.exe is unavailable');
  }
  notepad.on('error', () => {});
  try {
    if (!notepad.pid) return t.skip('notepad.exe is unavailable');
    let app;
    for (let attempt = 0; attempt < 40 && !app; attempt += 1) {
      await sleep(500);
      app = win.apps().find((item) => item.pid === notepad.pid);
    }
    if (!app) return t.skip('notepad opened no visible window in this session');
    assert.equal(typeof app.name, 'string');
    assert.equal(typeof app.bundleId, 'string');
    assert.equal(typeof app.frontmost, 'boolean');
    if (app.frontmost) {
      assert.throws(() => win.snapshot(notepad.pid), /in front/);
      return;
    }
    const snapshot = win.snapshot(notepad.pid);
    assert.equal(snapshot.ok, true);
    assert.ok(snapshot.elements.length > 0, 'snapshot lists controls');
    const first = snapshot.elements[0];
    assert.match(first.ref, /^c\d+$/);
    assert.equal(typeof first.role, 'string');
    assert.equal(typeof first.name, 'string');
    assert.throws(() => win.press(notepad.pid, 'c9999'), /Unknown ref\. Take a fresh snapshot\./);
    const edit = snapshot.elements.find((element) => element.role === 'Edit' || element.role === 'Document');
    if (edit) {
      try {
        const typed = win.type(notepad.pid, edit.ref, 'hello from ci');
        assert.equal(typed.ok, true);
        assert.equal(typed.cursorMoved, false);
      } catch (error) {
        assert.match(error.message, /does not take text|off limits|in front/);
      }
    }
    const menu = snapshot.elements.find((element) => element.role === 'MenuItem');
    if (menu) {
      try {
        win.press(notepad.pid, menu.ref);
      } catch (error) {
        assert.match(error.message, /Press failed|off limits|in front/);
      }
    }
    const shot = win.screenshot(notepad.pid, 640);
    const jpeg = Buffer.from(shot.image, 'base64');
    assert.equal(jpeg[0], 0xff, 'jpeg starts with the SOI marker');
    assert.equal(jpeg[1], 0xd8, 'jpeg starts with the SOI marker');
    assert.ok(shot.imageWidth >= 1 && shot.imageWidth <= 640, 'image stays under the cap');
    assert.ok(shot.imageHeight >= 1);
    assert.ok(shot.windowWidth > 0 && shot.windowHeight > 0);
    assert.equal(typeof shot.windowX, 'number');
  } finally {
    try { notepad.kill(); } catch {}
  }
});
