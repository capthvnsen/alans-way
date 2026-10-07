const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createDownloadStore, MAX_DOWNLOADS } = require('../src/download-store.cjs');

function fakeItem(fields = {}) {
  const listeners = {};
  return {
    fields: { filename: 'report.pdf', savePath: '/tmp/report.pdf', totalBytes: 100, receivedBytes: 0,
      state: 'progressing', url: 'https://example.com/report.pdf', paused: false, ...fields },
    getFilename() { return this.fields.filename; },
    getSavePath() { return this.fields.savePath; },
    getTotalBytes() { return this.fields.totalBytes; },
    getReceivedBytes() { return this.fields.receivedBytes; },
    getState() { return this.fields.state; },
    getURL() { return this.fields.url; },
    isPaused() { return this.fields.paused === true; },
    canResume() { return this.fields.paused === true; },
    pause() { this.fields.paused = true; },
    resume() { this.fields.paused = false; },
    cancel() { this.fields.state = 'cancelled'; this.emit('done', 'cancelled'); },
    dialogTitle: '',
    setSaveDialogOptions(options) { this.dialogTitle = options.title; },
    on(name, fn) { (listeners[name] ||= []).push(fn); },
    once(name, fn) { (listeners[name] ||= []).push(fn); },
    emit(name, ...args) { (listeners[name] || []).forEach(fn => fn({}, ...args)); },
  };
}

function fixture(initial = [], files = { '/tmp/report.pdf': true }, confirmOpen) {
  let prefs = { downloads: initial.map(item => ({ ...item })) }, saved = 0, notices = 0;
  const opened = [], shown = [], session = { handlers: {}, on(name, fn) { (this.handlers[name] ||= []).push(fn); } };
  const store = createDownloadStore({ getPreferences: () => prefs, savePreferences: () => saved++, onChanged: () => notices++, progressMs: 0,
    downloadsPath: () => '/tmp/downloads',
    shell: { openPath: async (file) => { opened.push(file); return ''; }, showItemInFolder: (file) => shown.push(file) },
    existsSync: (file) => files[file] === true, ...(confirmOpen ? { confirmOpen } : {}) });
  store.install(session);
  return { store, prefs, opened, shown,
    get saved() { return saved; }, get notices() { return notices; },
    start(fields) { const item = fakeItem(fields); (session.handlers['will-download'] || []).forEach(fn => fn({}, item)); return item; } };
}

test('a new download is recorded with filename, source host and progress state', () => {
  const f = fixture();
  f.start();
  const [item] = f.store.list();
  assert.equal(item.name, 'report.pdf');
  assert.equal(item.source, 'example.com');
  assert.equal(item.state, 'progressing');
  assert.equal(f.notices, 1);
});

test('finished downloads persist to preferences and leave the live set', async () => {
  const f = fixture();
  const item = f.start();
  item.fields.receivedBytes = 100;
  item.emit('updated');
  item.emit('done', 'completed');
  const [record] = f.prefs.downloads;
  assert.equal(record.state, 'completed');
  assert.equal(record.receivedBytes, 100);
  assert.equal(record.path, '/tmp/report.pdf');
  assert.ok(f.saved >= 1);
  await f.store.open(record.id);
  assert.deepEqual(f.opened, ['/tmp/report.pdf']);
  f.store.showInFolder(record.id);
  assert.deepEqual(f.shown, ['/tmp/report.pdf']);
  assert.throws(() => f.store.cancel(record.id), /no longer running/);
});

test('cancel stops the item and records it as cancelled', () => {
  const f = fixture();
  const item = f.start();
  const id = f.store.list()[0].id;
  f.store.cancel(id);
  assert.equal(item.fields.state, 'cancelled');
  assert.equal(f.store.list()[0].state, 'cancelled');
});

test('pause and resume drive the live item only', () => {
  const f = fixture();
  const item = f.start();
  const id = f.store.list()[0].id;
  f.store.pause(id, true);
  assert.equal(item.fields.paused, true);
  item.emit('updated');
  assert.equal(f.store.list()[0].paused, true);
  f.store.pause(id, false);
  assert.equal(item.fields.paused, false);
});

test('opening a missing file reports instead of launching', async () => {
  const f = fixture([{ id: 'gone-file-1', name: 'old.zip', path: '/tmp/old.zip', state: 'completed', startedAt: 1 }]);
  await assert.rejects(() => f.store.open('gone-file-1'), /no longer on disk/);
  assert.throws(() => f.store.showInFolder('gone-file-1'), /no longer on disk/);
});

test('clear drops finished rows but keeps live downloads', () => {
  const f = fixture([{ id: 'done-file-1', name: 'a.txt', path: '/tmp/a.txt', state: 'completed', startedAt: 1 }]);
  f.start({ filename: 'live.iso' });
  f.store.clear();
  assert.equal(f.store.list().length, 1);
  assert.equal(f.store.list()[0].name, 'live.iso');
});

test('the list caps at the most recent entries', () => {
  const f = fixture();
  for (let n = 0; n < MAX_DOWNLOADS + 5; n++) f.start({ filename: `f${n}.bin` });
  assert.equal(f.store.list().length, MAX_DOWNLOADS);
  assert.equal(f.store.list()[0].name, `f${MAX_DOWNLOADS + 4}.bin`);
});

test('restored entries are sanitized and a missing save dialog keeps working', () => {
  const f = fixture([
    { id: 'bad', name: 'x' },
    { id: 'kept-entry-1', name: 'ok.dmg', path: '/tmp/report.pdf', state: 'completed', receivedBytes: 5, totalBytes: 5, startedAt: 2 },
  ]);
  assert.equal(f.store.list().length, 1);
  assert.equal(f.store.list()[0].name, 'ok.dmg');
  const item = f.start({ state: 'interrupted' });
  assert.equal(item.dialogTitle, '');
  assert.equal(f.store.list()[0].state, 'interrupted');
});

test('downloads folder opens via the injected shell', async () => {
  const f = fixture();
  await f.store.openFolder();
  assert.deepEqual(f.opened, ['/tmp/downloads']);
});

test('executables and scripts need confirmation before they open, documents do not', async () => {
  const asked = [];
  let answer = false;
  const files = { '/tmp/setup.exe': true, '/tmp/run.PS1': true, '/tmp/report.pdf': true, '/tmp/tool.app': true };
  const f = fixture([
    { id: 'risky-exe-1', name: 'setup.exe', path: '/tmp/setup.exe', state: 'completed', startedAt: 1 },
    { id: 'risky-ps1-1', name: 'run.PS1', path: '/tmp/run.PS1', state: 'completed', startedAt: 1 },
    { id: 'safe-pdf-01', name: 'report.pdf', path: '/tmp/report.pdf', state: 'completed', startedAt: 1 },
    { id: 'risky-app-1', name: 'tool.app', path: '/tmp/tool.app', state: 'completed', startedAt: 1 },
  ], files, async (name) => { asked.push(name); return answer; });
  await f.store.open('safe-pdf-01');
  assert.deepEqual(asked, []);
  await f.store.open('risky-exe-1');
  assert.deepEqual(asked, ['setup.exe']);
  assert.deepEqual(f.opened, ['/tmp/report.pdf'], 'declined, so it did not open');
  answer = true;
  await f.store.open('risky-exe-1');
  await f.store.open('risky-ps1-1');
  await f.store.open('risky-app-1');
  assert.deepEqual(f.opened, ['/tmp/report.pdf', '/tmp/setup.exe', '/tmp/run.PS1', '/tmp/tool.app']);
});

test('a risky file is never opened when nothing can ask the user', async () => {
  const f = fixture([{ id: 'risky-exe-1', name: 'setup.exe', path: '/tmp/setup.exe', state: 'completed', startedAt: 1 }], { '/tmp/setup.exe': true });
  await f.store.open('risky-exe-1');
  assert.deepEqual(f.opened, []);
});
