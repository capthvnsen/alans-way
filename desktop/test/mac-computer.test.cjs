const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const mac = require('../src/computer.cjs');

const skip = process.platform !== 'darwin' && 'the Swift helper only builds on macOS';

test('the Mac helper builds and its self test passes', { skip, timeout: 120000 }, async () => {
  const binary = await mac.ensureBinary();
  const result = spawnSync(binary, ['selftest'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const reply = JSON.parse(result.stdout);
  assert.equal(reply.ok, true);
  assert.ok(reply.checks >= 10);
});

test('the Mac helper still compiles for the oldest macOS the app supports', { skip, timeout: 120000 }, () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-mac13-')), 'mac-computer');
  const result = spawnSync('swiftc', ['-O', '-target', mac.target, '-o', out, path.join(__dirname, '../scripts/mac-computer.swift')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(mac.target, /-apple-macos13$/);
});

test('the Mac helper answers requests in order over one process and rejects bad ones', { skip, timeout: 120000 }, async () => {
  const binary = await mac.ensureBinary();
  const helper = spawn(binary, ['serve'], { stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = [];
  let buffer = '';
  helper.stdout.setEncoding('utf8');
  helper.stdout.on('data', (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) { lines.push(JSON.parse(buffer.slice(0, at))); buffer = buffer.slice(at + 1); }
  });
  try {
    helper.stdin.write(JSON.stringify({ id: 1, cmd: 'init', policy: { exact: [], contains: [] } }) + '\n');
    helper.stdin.write(JSON.stringify({ id: 'two', cmd: 'bogus' }) + '\n');
    helper.stdin.write('not json\n');
    helper.stdin.write(JSON.stringify({ id: 4, cmd: 'act', pid: 2147483000, steps: [{ action: 'click', x: 1, y: 1 }] }) + '\n');
    for (let waited = 0; lines.length < 4 && waited < 10000; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    helper.stdin.end();
  }
  assert.equal(lines.length, 4);
  assert.deepEqual(lines[0], { id: 1, ok: true, protocol: 2 });
  assert.equal(lines[1].id, 'two');
  assert.equal(lines[1].code, 'bad_request');
  assert.equal(lines[2].code, 'bad_request');
  assert.equal(lines[3].id, 4);
  assert.equal(lines[3].ok, false);
  assert.ok(['permission', 'not_found'].includes(lines[3].code), `unexpected ${lines[3].code}`);
});

test('the Mac helper refuses password managers by policy before touching an app', { skip, timeout: 120000 }, async () => {
  const binary = await mac.ensureBinary();
  // Finder is always running; a policy that names its bundle id must refuse it.
  const result = spawnSync(binary, ['once'], {
    encoding: 'utf8',
    input: JSON.stringify({ id: 1, cmd: 'apps', policy: { exact: ['com.apple.finder'], contains: [] } }) + '\n',
  });
  const apps = JSON.parse(result.stdout);
  if (!apps.ok) return; // Accessibility is off for this runner; the policy path is covered by selftest.
  const finder = apps.apps.find((app) => app.bundleId === 'com.apple.finder');
  if (!finder) return;
  const refused = spawnSync(binary, ['once'], {
    encoding: 'utf8',
    input: JSON.stringify({ id: 2, cmd: 'snapshot', pid: finder.pid, policy: { exact: ['com.apple.finder'], contains: [] } }) + '\n',
  });
  const reply = JSON.parse(refused.stdout);
  assert.equal(reply.ok, false);
  assert.equal(reply.code, 'off_limits');
});

test('the Mac helper re-walks with the request menubar flag, fails closed on focus errors and checks drag starts', () => {
  const swift = fs.readFileSync(path.join(__dirname, '../scripts/mac-computer.swift'), 'utf8');
  assert.match(swift, /func ensureCache\(_ pid: pid_t, _ expected: Int\?, menubar: Bool\)/);
  assert.match(swift, /try ensureCache\(pid, [^\n]*menubar: menubar\)/);
  assert.ok(!/refresh\(pid, menubar: false\)/.test(swift), 'no walk may hard-code menubar:false');
  const focus = swift.slice(swift.indexOf('func rejectSecureFocus'), swift.indexOf('func rejectSecure(_ node'));
  assert.match(focus, /\.noValue/);
  assert.match(focus, /throw Fail\("focus_unverified"/);
  const drag = swift.slice(swift.indexOf('case "drag":'), swift.indexOf('case "scroll":'));
  assert.match(drag, /isSecure\(element\)/);
});

test('the Mac helper checks focus before menu items, drag ends, and defaults to the snapshot menubar flag', () => {
  const swift = fs.readFileSync(path.join(__dirname, '../scripts/mac-computer.swift'), 'utf8');
  const menu = swift.slice(swift.indexOf('case "menu":\n        try'), swift.indexOf('default:\n        throw Fail("unsupported_action"'));
  assert.match(menu, /try rejectSecureFocus\(pid\)\n\s+try pressMenu/);
  const drag = swift.slice(swift.indexOf('case "drag":'), swift.indexOf('case "scroll":'));
  assert.match(drag, /elementAt\(pid, end\), isSecure/);
  assert.match(swift, /struct Cache \{[^}]*var menubar: Bool/);
  assert.match(swift, /request\["menubar"\] as\? Bool \?\? caches\[pid\]\?\.menubar \?\? false/);
});

test('the Mac helper checks focus before pressing or clicking menu items', () => {
  const swift = fs.readFileSync(path.join(__dirname, '../scripts/mac-computer.swift'), 'utf8');
  assert.match(swift, /func inMenu\(_ element: AXUIElement\) -> Bool[\s\S]*?AXMenuItem[\s\S]*?AXMenu/);
  assert.match(swift, /func rejectSecureFocusForMenu\(_ pid: pid_t, _ element: AXUIElement\?\) throws \{\s*if let element, inMenu\(element\) \{ try rejectSecureFocus\(pid\) \}/);
  const run = swift.slice(swift.indexOf('func runStep'), swift.indexOf('case "scroll":'));
  assert.ok((run.match(/rejectSecureFocusForMenu\(pid, /g) || []).length >= 4, 'press, click, double_click and right_click');
  assert.match(swift, /Fail\("focus_unverified", "Could not verify which field has focus; retry or snapshot first\."\)/);
});

