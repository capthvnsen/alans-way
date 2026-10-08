const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writePrivateJson, normalizePreferences, coalesce, createSaver, createRetry, hostAllowed } = require('../src/shell-support.cjs');

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'shell-support-'));

test('writePrivateJson writes a 0600 file and leaves no temp file behind', () => {
  const root = dir(), file = path.join(root, 'prefs.json');
  writePrivateJson(file, { a: 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: 1 });
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(root), ['prefs.json']);
});

test('writePrivateJson retries once when the rename hits a transient EPERM', () => {
  const root = dir(), file = path.join(root, 'prefs.json');
  let renames = 0;
  const fsApi = { ...fs, renameSync(from, to) { if (renames++ === 0) throw Object.assign(new Error('locked'), { code: 'EPERM' }); return fs.renameSync(from, to); } };
  writePrivateJson(file, { ok: true }, { fsApi, retryDelayMs: 1 });
  assert.equal(renames, 2);
  assert.deepEqual(fs.readdirSync(root), ['prefs.json']);
});

test('writePrivateJson gives up after one retry, cleans up, and does not retry other errors', () => {
  const root = dir(), file = path.join(root, 'prefs.json');
  let renames = 0;
  const locked = { ...fs, renameSync() { renames++; throw Object.assign(new Error('locked'), { code: 'EPERM' }); } };
  assert.throws(() => writePrivateJson(file, {}, { fsApi: locked, retryDelayMs: 1 }), /locked/);
  assert.equal(renames, 2);
  const full = { ...fs, renameSync() { renames++; throw Object.assign(new Error('full'), { code: 'ENOSPC' }); } };
  renames = 0;
  assert.throws(() => writePrivateJson(file, {}, { fsApi: full }), /full/);
  assert.equal(renames, 1);
  assert.deepEqual(fs.readdirSync(root), [], 'no stray temp files');
});

const defaults = { bots: [], order: [], hidden: [], savedTabs: [], chatWidth: 490, preview: true, previewPos: null, selectedBotId: '', sitePermissions: {}, downloads: [] };
test('normalizePreferences replaces wrong-typed fields with defaults and keeps valid ones', () => {
  const prefs = normalizePreferences({ bots: 'oops', order: { 0: 'a' }, hidden: ['a', 5, null], savedTabs: [{ url: 'https://a.example' }, 7, { url: 3 }],
    chatWidth: '490', preview: 1, previewPos: 'x', selectedBotId: 12, sitePermissions: [], downloads: [null, { id: 'x' }], remoteControl: true }, defaults);
  assert.deepEqual(prefs.bots, []);
  assert.deepEqual(prefs.order, []);
  assert.deepEqual(prefs.hidden, ['a']);
  assert.deepEqual(prefs.savedTabs, [{ url: 'https://a.example' }]);
  assert.equal(prefs.chatWidth, 490);
  assert.equal(prefs.preview, true);
  assert.equal(prefs.previewPos, null);
  assert.equal(prefs.selectedBotId, '');
  assert.deepEqual(prefs.sitePermissions, {});
  assert.deepEqual(prefs.downloads, [{ id: 'x' }]);
  assert.equal(prefs.remoteControl, true, 'unknown keys pass through');
  const good = normalizePreferences({ bots: [{ id: '1', name: 'A' }, null, { name: 'no id' }], previewPos: { x: 1, y: 2 }, chatWidth: 500 }, defaults);
  assert.deepEqual(good.bots, [{ id: '1', name: 'A' }]);
  assert.deepEqual(good.previewPos, { x: 1, y: 2 });
  assert.equal(good.chatWidth, 500);
  assert.deepEqual(normalizePreferences([], defaults), defaults);
  assert.deepEqual(normalizePreferences('nope', defaults), defaults);
});

test('createSaver debounces, skips unchanged data, and survives write errors', async () => {
  let data = { n: 1 }, writes = [], failing = false, errors = 0;
  const saver = createSaver({ snapshot: () => data, write: (text) => { if (failing) throw new Error('EPERM'); writes.push(text); }, onError: () => errors++, delayMs: 10 });
  saver.schedule(); saver.schedule(); saver.schedule();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(writes.length, 1, 'three requests coalesce into one write');
  saver.schedule(); await new Promise((r) => setTimeout(r, 40));
  assert.equal(writes.length, 1, 'unchanged data is not rewritten');
  data = { n: 2 }; failing = true;
  assert.equal(saver.flush(), false); assert.equal(errors, 1);
  failing = false;
  assert.equal(saver.flush(), true, 'a failed write is retried on the next flush');
  assert.equal(writes.length, 2);
});

test('coalesce runs an isolated call at once, collapses a burst, and flush runs the rest now', async () => {
  let runs = 0;
  const tick = coalesce(() => runs++, 20);
  tick();
  assert.equal(runs, 1, 'leading edge');
  tick(); tick(); tick();
  assert.equal(runs, 1);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(runs, 2, 'the burst collapses into one trailing run');
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(runs, 2, 'no trailing run without a pending call');
  tick(); assert.equal(runs, 3);
  tick(); tick.flush(); assert.equal(runs, 4, 'flush runs the pending call now');
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(runs, 4, 'flush consumed the pending call');
});

test('createRetry backs off, caps, retries now, and resets', async () => {
  let runs = 0;
  const retry = createRetry({ run: () => runs++, delays: [5, 10] });
  retry.schedule(); retry.schedule();
  assert.equal(retry.pending, true);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(runs, 1, 'a second schedule while pending does not stack');
  retry.schedule(); retry.now();
  assert.equal(runs, 2); assert.equal(retry.pending, false);
  retry.schedule(); retry.reset();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(runs, 2, 'reset cancels a pending retry');
});

test('hostAllowed accepts only loopback hosts on the listening port', () => {
  for (const value of ['127.0.0.1:9464', 'localhost:9464', 'LOCALHOST:9464', '[::1]:9464']) assert.equal(hostAllowed(value, 9464), true, value);
  for (const value of ['evil.example:9464', '127.0.0.1:9465', '127.0.0.1', 'localhost.evil.example:9464', '127.0.0.1.evil.example:9464', '', undefined, '127.0.0.1:9464, evil.example']) assert.equal(hostAllowed(value, 9464), false, String(value));
});

const { fileUrlMatches, linuxTrayUsable, pollTier, watchChange } = require('../src/shell-support.cjs');

test('fileUrlMatches compares paths, so Chromium and pathToFileURL encodings of odd install paths agree', () => {
  const file = '/Applications/My App%1/~dev/[x]/index.html';
  const { pathToFileURL } = require('node:url');
  for (const href of [pathToFileURL(file).href, 'file:///Applications/My%20App%251/~dev/[x]/index.html', 'file:///Applications/My%20App%251/%7Edev/%5Bx%5D/index.html', `${pathToFileURL(file).href}?a=1#top`])
    assert.equal(fileUrlMatches(href, file), true, href);
  for (const href of ['file:///Applications/My%20App%251/~dev/[x]/other.html', 'file:///etc/hosts', 'http://example.com/index.html', 'file:///Applications/My%20App%251/~dev/%5Bx%5D%2Findex.html', 'nonsense', ''])
    assert.equal(fileUrlMatches(href, file), false, href);
});

test('fileUrlMatches accepts Chromium leaving a stray percent sign unescaped', () => {
  assert.equal(fileUrlMatches("file:///x/a%20b%20%c%20%23d%20%C3%A9&'+~[x]/index.html", "/x/a b %c #d é&'+~[x]/index.html"), true);
});

test('linuxTrayUsable needs a status notifier host on GNOME and trusts other desktops', () => {
  assert.equal(linuxTrayUsable({ desktop: 'ubuntu:GNOME', hasWatcher: false }), false);
  assert.equal(linuxTrayUsable({ desktop: 'GNOME', hasWatcher: true }), true);
  assert.equal(linuxTrayUsable({ desktop: 'KDE', hasWatcher: true }), true);
  assert.equal(linuxTrayUsable({ desktop: 'XFCE', hasWatcher: false }), true);
  assert.equal(linuxTrayUsable({ desktop: '', hasWatcher: false }), true);
});

test('pollTier is hidden when the window is hidden or minimized, idle when unfocused', () => {
  assert.equal(pollTier({ visible: false, minimized: false, focused: true }), 'hidden');
  assert.equal(pollTier({ visible: true, minimized: true, focused: false }), 'hidden');
  assert.equal(pollTier({ visible: true, minimized: false, focused: false }), 'idle');
  assert.equal(pollTier({ visible: true, minimized: false, focused: true }), 'active');
});

test('watchChange reports a stuck page only when nothing changed after the delay', async () => {
  let value = 'a', stuck = 0;
  const unchanged = watchChange({ read: async () => value, delayMs: 10, onStuck: () => stuck++ });
  await unchanged;
  assert.equal(stuck, 1);
  const changing = watchChange({ read: async () => value, delayMs: 10, onStuck: () => stuck++ });
  value = 'b';
  await changing;
  assert.equal(stuck, 1, 'a changed page is left alone');
  await watchChange({ read: async () => { throw new Error('gone'); }, delayMs: 1, onStuck: () => stuck++ });
  assert.equal(stuck, 1, 'a failed read does not reload');
});

test('main.cjs mirrors on in-page navigation, guards the poll-tier send, and names the Linux host', () => {
  const main = fs.readFileSync(path.join(__dirname, '../src/main.cjs'), 'utf8');
  assert.match(main, /'did-navigate-in-page', \(\) => \{[^\n]*scheduleVpsMirror\(\)/);
  assert.match(main, /function sendToTelegram[\s\S]*?try \{[\s\S]*?mainFrame\.url[\s\S]*?catch/, 'the frame is probed before sending');
  assert.ok(!/telegramView\.webContents\.send\('(workspace:poll-tier|telegram:poll)'/.test(main), 'poll sends go through the guard');
  assert.ok(main.includes('--host-os ${HOST_LABEL}'), 'the setup command and prompt name every non-Mac host');
  assert.ok(!main.includes('open on my Mac, so add --skip-install and'), 'the Mac wording stays Mac only');
});

test('user-facing strings in the app have no em-dashes', () => {
  for (const file of ['src/main.cjs', 'src/renderer.js', 'scripts/browser-mcp.cjs', 'scripts/vps-browser-host.cjs']) {
    const lines = fs.readFileSync(path.join(__dirname, '..', file), 'utf8').split('\n');
    lines.forEach((line, index) => {
      const code = line.replace(/^\s*\/\/.*$/, '').replace(/\s\/\/ .*$/, '');
      assert.ok(!code.includes('\u2014'), `${file}:${index + 1} has an em-dash`);
    });
  }
});

test('the script path is validated on save and the reason survives the refresh', () => {
  const main = fs.readFileSync(path.join(__dirname, '../src/main.cjs'), 'utf8');
  assert.match(main, /checkScriptPath\(scriptPath\)/);
  assert.match(main, /vpsBrowserError = /);
  assert.match(main, /vpsBrowserError,/);
  const renderer = fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8');
  assert.match(renderer, /state\.vpsBrowserError/);
});

const { tailscaleSshHost } = require('../src/shell-support.cjs');

test('tailscaleSshHost derives user@tailnet-ip and refuses unusable answers', () => {
  const args = [];
  const run = (file, argv) => { args.push([file, argv]); return '100.64.7.42\n'; };
  assert.equal(tailscaleSshHost({ platform: 'linux', username: 'me', run }), 'me@100.64.7.42');
  assert.deepEqual(args[0][1], ['ip', '-4']);
  // Only a clean IPv4 line counts as the tailnet address.
  for (const out of ['', 'not an ip\n', '999.1.2.3\n', '100.64.7.42 trailing\n', '10.0.0.1\n']) {
    const expected = /^\d+\.\d+\.\d+\.\d+$/.test(out.trim()) && !out.includes('999') ? 'me@' + out.trim() : '';
    assert.equal(tailscaleSshHost({ platform: 'linux', username: 'me', run: () => out }), expected, JSON.stringify(out));
  }
  assert.equal(tailscaleSshHost({ platform: 'linux', username: 'me', run: () => { throw new Error('no cli'); } }), '');
  assert.equal(tailscaleSshHost({ platform: 'linux', username: '', run }), '');
});

test('tailscaleSshHost probes the bundled CLI before PATH', () => {
  const seen = [];
  const run = (file) => { seen.push(file); return '100.64.7.42\n'; };
  assert.equal(tailscaleSshHost({ platform: 'darwin', username: 'me', run, exists: () => true }), 'me@100.64.7.42');
  assert.equal(seen[0], '/Applications/Tailscale.app/Contents/MacOS/Tailscale');
  // With the app bundle missing, the PATH name is tried instead.
  seen.length = 0;
  tailscaleSshHost({ platform: 'darwin', username: 'me', run, exists: () => false });
  assert.deepEqual(seen, ['tailscale']);
  seen.length = 0;
  assert.equal(tailscaleSshHost({ platform: 'win32', username: 'me', programFiles: 'C:\\Program Files', run, exists: () => true }), 'me@100.64.7.42');
  assert.equal(seen[0], 'C:\\Program Files\\Tailscale\\tailscale.exe');
});

