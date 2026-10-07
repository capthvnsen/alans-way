const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const win = require('../src/win-computer.cjs');
const source = path.join(__dirname, '..', 'scripts', 'win-computer.cs');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('the Windows computer helper only runs on Windows', async () => {
  if (process.platform === 'win32') return;
  await assert.rejects(win.service.apps(), /only runs on Windows/);
  await assert.rejects(win.service.snapshot('bot', 1), /only runs on Windows/);
  await assert.rejects(win.service.screenshot(1), /only runs on Windows/);
});

test('the Windows driver speaks the shared desktop protocol', () => {
  const cs = fs.readFileSync(source, 'utf8');
  for (const mode of ['serve', 'once', 'selftest']) {
    assert.ok(cs.includes(`case "${mode}"`), `missing mode ${mode}`);
  }
  for (const command of ['apps', 'snapshot', 'press', 'click', 'type', 'drag', 'shot', 'init', 'act', 'menu']) {
    assert.ok(cs.includes(`"${command}"`), `missing command ${command}`);
  }
  for (const action of ['double_click', 'right_click', 'scroll', 'key', 'menu']) {
    assert.ok(cs.includes(`case "${action}"`), `missing action ${action}`);
  }
  for (const code of ['stale_ref', 'unsupported_action', 'off_limits', 'not_found', 'in_front', 'no_window', 'unresponsive']) {
    assert.ok(cs.includes(`"${code}"`), `missing code ${code}`);
  }
  for (const key of ['bundleId', 'frontmost', 'elements', 'generation', 'truncated', 'cursorMoved', 'imageWidth', 'imageHeight', 'windowX', 'windowWidth', 'settleMs']) {
    assert.ok(cs.includes(key), `missing key ${key}`);
  }
  for (const message of [
    'Password fields are off limits.',
    'Unknown ref. Take a fresh snapshot.',
    'App not found.',
    'That app is off limits.',
    'That app has no window to capture.',
    'That app is the one in front. Leave it there; the pointer stays where it is.',
    'Windows cannot send modified keys to a background app without taking focus.',
    'That app is not responding.',
  ]) {
    assert.ok(cs.includes(message), `missing message ${message}`);
  }
  assert.ok(cs.includes('"c" + (index + 1)'), 'refs use the c<N> scheme');
  assert.ok(!/\$"/.test(cs) && !cs.includes('?.') && !cs.includes('nameof('), 'the in-box csc only speaks C# 5');
});

test('the Windows driver keeps results when the post-step walk fails, sees UIA focus, and sends shift+letter', () => {
  const cs = fs.readFileSync(source, 'utf8');
  const act = cs.slice(cs.indexOf('static Dictionary<string, object> CmdAct'), cs.indexOf('static Dictionary<string, object> CmdMenu'));
  assert.match(act, /try \{\s*var snap = DoWalk\(pid\);[\s\S]*?\} catch \(Exception\) \{[\s\S]*?"note"/, 'a failed walk after the steps still returns their results');
  const key = cs.slice(cs.indexOf('static Dictionary<string, object> StepKey'), cs.indexOf('static bool IsMenuHost'));
  assert.match(key, /CheckFocus\(/, 'the UIA focus is checked for a password');
  assert.match(cs, /HasKeyboardFocusProperty/);
  assert.match(cs, /static void CheckFocus[\s\S]*?\.Current\.IsPassword/);
  assert.match(key, /ToUpperInvariant/, 'shift+letter is sent as the capital letter');
});

test('the Windows helper names a process from its image path first, then falls back, and never caches an unreadable start', () => {
  const cs = fs.readFileSync(source, 'utf8');
  const name = cs.slice(cs.indexOf('static string ProcessName(int pid)'), cs.indexOf('static List<App> Apps()'));
  assert.ok(name.indexOf('ImagePath(pid') < name.indexOf('MainModule'), 'the limited-right image path is tried before MainModule');
  assert.match(name, /MainModule[\s\S]*process\.ProcessName/, 'ProcessName is the last fallback');
  assert.match(name, /if \(created != 0 && name\.Length > 0\)/, 'a name is cached only with a readable creation time');
  assert.match(cs, /static string ExeName\(/);
  assert.match(cs, /Check\(Rules\.ExeName\("", "Notepad"\) == "Notepad\.exe"/, 'the pure name logic is in the selftest');
  const check = cs.slice(cs.indexOf('static void CheckApp(int pid)'), cs.indexOf('static double Clean('));
  assert.ok(check.indexOf('name.Length == 0') < check.indexOf('in_front'), 'an unknown name is still blocked');
  assert.ok(!/\bout var\b|=> *[{(a-z]/.test(name), 'the name lookup stays C# 5');
});

test('the Windows helper compiles and drives notepad', async (t) => {
  if (process.platform !== 'win32') return;
  const exe = await win.ensureBinary();
  assert.ok(fs.existsSync(exe), 'ensureBinary produced win-computer.exe');
  const selftest = spawnSync(exe, ['selftest'], { encoding: 'utf8' });
  assert.equal(JSON.parse(selftest.stdout).ok, true, selftest.stdout);
  let notepad;
  try {
    notepad = spawn('notepad.exe');
  } catch {
    return t.skip('notepad.exe is unavailable');
  }
  notepad.on('error', () => {});
  t.after(() => { try { notepad.kill(); } catch {} win.close(); });
  if (!notepad.pid) return t.skip('notepad.exe is unavailable');
  let app;
  for (let attempt = 0; attempt < 40 && !app; attempt += 1) {
    await sleep(500);
    app = (await win.service.apps()).find((item) => item.pid === notepad.pid);
  }
  if (!app) return t.skip('notepad opened no visible window in this session');
  assert.equal(typeof app.name, 'string');
  assert.equal(typeof app.bundleId, 'string');
  assert.equal(typeof app.frontmost, 'boolean');
  assert.notEqual(app.bundleId, '', 'the helper could not read notepad.exe\'s name, so every action on it is refused as off limits');
  if (app.frontmost) {
    await assert.rejects(win.service.snapshot('bot', notepad.pid), /in front/);
    return;
  }
  const snapshot = await win.service.snapshot('bot', notepad.pid);
  assert.ok(Number.isInteger(snapshot.generation));
  assert.ok(snapshot.elements.length > 0, 'snapshot lists controls');
  const first = snapshot.elements[0];
  assert.match(first.ref, /^c\d+$/);
  assert.equal(typeof first.role, 'string');
  assert.equal(typeof first.name, 'string');
  await assert.rejects(win.service.action('bot', notepad.pid, { action: 'press', ref: 'c9999', generation: snapshot.generation }), /stale_ref|Unknown ref/);
  await assert.rejects(win.service.action('bot', notepad.pid, { action: 'press', ref: 'c1', generation: snapshot.generation + 1 }), /stale_ref/);
  const edit = snapshot.elements.find((element) => element.role === 'Edit' || element.role === 'Document');
  if (edit) {
    try {
      const typed = await win.service.action('bot', notepad.pid, { action: 'type', ref: edit.ref, text: 'hello from ci', generation: snapshot.generation });
      assert.equal(typed.ok, true);
      assert.equal(typed.cursorMoved, false);
    } catch (error) {
      assert.match(error.message, /does not take text|off limits|in front|stale_ref/);
    }
  }
  const shot = await win.service.screenshot(notepad.pid, 640);
  const jpeg = Buffer.from(shot.image, 'base64');
  assert.equal(jpeg[0], 0xff, 'jpeg starts with the SOI marker');
  assert.equal(jpeg[1], 0xd8, 'jpeg starts with the SOI marker');
  assert.ok(shot.imageWidth >= 1 && shot.imageWidth <= 640, 'image stays under the cap');
  assert.ok(shot.imageHeight >= 1);
  assert.ok(shot.windowWidth > 0 && shot.windowHeight > 0);
  assert.equal(typeof shot.windowX, 'number');
});

test('the Windows driver blocks menu presses on a focused password and never fails open on UIA errors', () => {
  const cs = fs.readFileSync(source, 'utf8');
  const menu = cs.slice(cs.indexOf('static Dictionary<string, object> StepMenu'), cs.indexOf('static List<string> StringList'));
  assert.match(menu, /CheckFocus\(pid, /, 'menu items are not pressed into a password field');
  const focus = cs.slice(cs.indexOf('static void CheckFocus'), cs.indexOf('static IntPtr Long('));
  assert.match(focus, /int state = 2;/, 'unverified unless the read finished cleanly');
  assert.match(focus, /\.Join\(\d+\)/, 'the focus search is time capped');
  assert.match(focus, /CacheRequest/, 'IsPassword rides on the search');
  assert.ok(!/return false;/.test(focus) && !/state = 0;\s*\}\s*catch/.test(focus), 'no path reports a field as safe except a clean read');
});

test('the Windows driver checks focus for menu item clicks, reports an unverifiable focus apart from a password, and caps every probe', () => {
  const cs = fs.readFileSync(source, 'utf8');
  const focus = cs.slice(cs.indexOf('static void CheckFocus'), cs.indexOf('static IntPtr Long('));
  assert.match(focus, /"focus_unverified", "Could not verify which field has focus; retry or snapshot first\."/);
  assert.match(focus, /"off_limits", "Password fields are off limits\."/);
  assert.match(focus, /PasswordWindow\(focusWindow\)/, 'the window probe runs under the capped worker');
  const key = cs.slice(cs.indexOf('static Dictionary<string, object> StepKey'), cs.indexOf('static bool IsMenuHost'));
  assert.ok(!/PasswordWindow\(target\)/.test(key), 'no uncapped window probe on the calling thread');
  for (const name of ['StepPress', 'StepClick', 'StepMouse']) {
    const start = cs.indexOf(`static Dictionary<string, object> ${name}(`);
    const body = cs.slice(start, cs.indexOf('\n  }\n', start));
    assert.match(body, /ControlType\.MenuItem/, `${name} checks menu items`);
    assert.match(body, /CheckFocus\(pid, /, `${name} verifies focus`);
  }
  const menu = cs.slice(cs.indexOf('static Dictionary<string, object> StepMenu'), cs.indexOf('static List<string> StringList'));
  assert.ok(!/top != IntPtr\.Zero &&/.test(menu), 'no main window does not skip the check');
});

