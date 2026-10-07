const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createDownloadStore, isPdf, decideAutoOpen, insideDownloads, AUTO_OPEN_LIMIT, MAX_DOWNLOADS } = require('../src/download-store.cjs');

function fakeItem(fields = {}) {
  const listeners = {};
  return {
    fields: { filename: 'report.pdf', savePath: '/tmp/report.pdf', totalBytes: 100, receivedBytes: 0,
      state: 'progressing', url: 'https://example.com/report.pdf', paused: false, mimeType: 'application/pdf', ...fields },
    getFilename() { return this.fields.filename; },
    getSavePath() { return this.fields.savePath; },
    getMimeType() { return this.fields.mimeType; },
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

function fixture(initial = [], files = { '/tmp/report.pdf': true }, confirmOpen, openInTab, scope = 'browser', extra = {}) {
  let prefs = { downloads: initial.map(item => ({ ...item })) }, saved = 0, notices = 0;
  const opened = [], shown = [], session = { handlers: {}, on(name, fn) { (this.handlers[name] ||= []).push(fn); } };
  const store = createDownloadStore({ getPreferences: () => prefs, savePreferences: () => saved++, onChanged: () => notices++, progressMs: 0,
    downloadsPath: () => '/tmp/downloads', realpath: (file) => file,
    shell: { openPath: async (file) => { opened.push(file); return ''; }, showItemInFolder: (file) => shown.push(file) },
    existsSync: (file) => files[file] === true, ...(confirmOpen ? { confirmOpen } : {}), ...(openInTab ? { openInTab } : {}), ...extra });
  store.install(session, scope);
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

test('PDF detection requires a real .pdf file on disk plus a PDF name or mime', () => {
  assert.equal(isPdf({ mime: 'application/pdf', name: 'file.bin', path: '/tmp/report.pdf' }), true);
  assert.equal(isPdf({ name: 'Report.PDF', path: 'C:\\Users\\user\\Downloads\\scan.pdf' }), true);
  assert.equal(isPdf({ mime: 'Application/PDF; charset=binary', name: 'doc', path: '/tmp/doc.PDF' }), true);
  assert.equal(isPdf({ mime: 'application/pdf', name: 'invoice.pdf', path: '/tmp/invoice.html' }), false, 'a spoofed mime cannot rescue a non-pdf save path');
  assert.equal(isPdf({ mime: 'application/pdf', name: 'file.bin' }), false, 'mime alone is not enough');
  assert.equal(isPdf({ name: 'Report.PDF' }), false, 'name alone is not enough');
  assert.equal(isPdf({ path: '/tmp/scan.pdf' }), false, 'the saved path alone is not enough');
  assert.equal(isPdf({ mime: 'application/octet-stream', name: 'setup.exe', path: '/tmp/setup.pdf' }), false);
  assert.equal(isPdf({ name: 'report.pdf.exe', path: '/tmp/report.pdf.exe' }), false);
  assert.equal(isPdf({}), false);
  assert.equal(isPdf(null), false);
});

test('a completed Telegram download opens a PDF in a tab, never as a dialog or external app', () => {
  const inTab = [];
  const f = fixture([], { '/tmp/downloads/report.pdf': true, '/tmp/downloads/photos.zip': true }, undefined,
    async (record) => { inTab.push(record.path); }, 'telegram');
  const pdf = f.start({ url: 'blob:https://web.telegram.org/doc', savePath: '/tmp/downloads/report.pdf' });
  pdf.emit('done', 'completed');
  assert.deepEqual(inTab, ['/tmp/downloads/report.pdf']);
  const zip = f.start({ filename: 'photos.zip', savePath: '/tmp/downloads/photos.zip', mimeType: 'application/zip' });
  zip.emit('done', 'completed');
  const cancelled = f.start({ filename: 'later.pdf', savePath: '/tmp/downloads/later.pdf' });
  cancelled.emit('done', 'cancelled');
  assert.deepEqual(inTab, ['/tmp/downloads/report.pdf'], 'only the completed PDF opened a tab');
  assert.equal(f.prefs.downloads.find(item => item.name === 'report.pdf').source, 'Telegram', 'a blob: download names its session, not a fake host');
});

test('a completed download in the browser session never auto-opens a tab', () => {
  const inTab = [];
  const f = fixture([], { '/tmp/report.pdf': true }, undefined, async (record) => { inTab.push(record.path); });
  const pdf = f.start();
  pdf.emit('done', 'completed');
  assert.deepEqual(inTab, []);
});

test('Open on a PDF download goes to an in-app tab, other files keep the system viewer', async () => {
  const inTab = [];
  const files = { '/tmp/report.pdf': true, '/tmp/photo.zip': true };
  const f = fixture([
    { id: 'pdf-entry-01', name: 'report.pdf', path: '/tmp/report.pdf', mime: 'application/pdf', state: 'completed', startedAt: 1 },
    { id: 'pdf-entry-02', name: 'download.bin', path: '/tmp/report.pdf', mime: 'application/pdf', state: 'completed', startedAt: 1 },
    { id: 'zip-entry-01', name: 'photo.zip', path: '/tmp/photo.zip', state: 'completed', startedAt: 1 },
  ], files, undefined, async (record) => { inTab.push(record.path); });
  await f.store.open('pdf-entry-01');
  await f.store.open('pdf-entry-02');
  assert.deepEqual(inTab, ['/tmp/report.pdf', '/tmp/report.pdf'], 'the saved path is what the tab opens');
  assert.deepEqual(f.opened, [], 'no PDF reached the external viewer');
  await f.store.open('zip-entry-01');
  assert.deepEqual(f.opened, ['/tmp/photo.zip'], 'non-PDF files still open externally');
});

test('a Telegram download claiming PDF mime but saved as markup never opens a tab', () => {
  const inTab = [];
  const f = fixture([], { '/tmp/downloads/invoice.html': true, '/tmp/downloads/vector.svg': true }, undefined,
    async (record) => { inTab.push(record.path); }, 'telegram');
  const html = f.start({ filename: 'invoice.html', savePath: '/tmp/downloads/invoice.html' });
  html.emit('done', 'completed');
  const svg = f.start({ filename: 'vector.svg', savePath: '/tmp/downloads/vector.svg' });
  svg.emit('done', 'completed');
  assert.deepEqual(inTab, [], 'a sender-controlled mime cannot put a file:// page in a tab');
});

test('Open on a spoofed PDF record asks before the system browser runs the markup', async () => {
  const asked = [], inTab = [];
  const files = { '/tmp/downloads/invoice.html': true, '/tmp/downloads/vector.svg': true, '/tmp/downloads/page.mhtml': true };
  const f = fixture([
    { id: 'html-entry-1', name: 'invoice.html', path: '/tmp/downloads/invoice.html', mime: 'application/pdf', state: 'completed', startedAt: 1 },
    { id: 'svg-entry-01', name: 'vector.svg', path: '/tmp/downloads/vector.svg', mime: 'application/pdf', state: 'completed', startedAt: 1 },
    { id: 'mht-entry-01', name: 'page.mhtml', path: '/tmp/downloads/page.mhtml', state: 'completed', startedAt: 1 },
  ], files, async (name) => { asked.push(name); return true; }, async (record) => { inTab.push(record.path); });
  await f.store.open('html-entry-1');
  await f.store.open('svg-entry-01');
  await f.store.open('mht-entry-01');
  assert.deepEqual(inTab, [], 'a spoofed mime still cannot reach a tab');
  assert.deepEqual(asked, ['invoice.html', 'vector.svg', 'page.mhtml'], 'markup asks before the system browser runs it');
  assert.deepEqual(f.opened, ['/tmp/downloads/invoice.html', '/tmp/downloads/vector.svg', '/tmp/downloads/page.mhtml']);
});

test('auto-open only fires for files inside the downloads directory', () => {
  const inTab = [];
  const files = { '/tmp/report.pdf': true, '/tmp/downloads/report.pdf': true };
  const f = fixture([], files, undefined, async (record) => { inTab.push(record.path); }, 'telegram');
  const outside = f.start({ filename: 'report.pdf', savePath: '/tmp/report.pdf' });
  outside.emit('done', 'completed');
  const inside = f.start({ filename: 'report.pdf', savePath: '/tmp/downloads/report.pdf' });
  inside.emit('done', 'completed');
  assert.deepEqual(inTab, ['/tmp/downloads/report.pdf'], 'a save path outside the downloads directory stays put');
});

test('a save path that resolves outside the downloads directory never auto-opens', () => {
  const inTab = [];
  const realpath = (file) => file === '/tmp/downloads/link.pdf' ? '/tmp/elsewhere/real.pdf' : file;
  const f = fixture([], { '/tmp/downloads/link.pdf': true }, undefined,
    async (record) => { inTab.push(record.path); }, 'telegram', { realpath });
  const item = f.start({ filename: 'link.pdf', savePath: '/tmp/downloads/link.pdf' });
  item.emit('done', 'completed');
  assert.deepEqual(inTab, [], 'the resolved path decides, not the literal one');
});

test('insideDownloads compares resolved paths against the downloads directory', () => {
  const real = (file) => file === '/tmp/downloads/link.pdf' ? '/tmp/elsewhere/real.pdf' : file;
  assert.equal(insideDownloads('/tmp/downloads/a.pdf', '/tmp/downloads', real), true);
  assert.equal(insideDownloads('/tmp/downloads/sub/a.pdf', '/tmp/downloads', real), true);
  assert.equal(insideDownloads('/tmp/downloads', '/tmp/downloads', real), false, 'the directory itself is not a file inside it');
  assert.equal(insideDownloads('/tmp/a.pdf', '/tmp/downloads', real), false);
  assert.equal(insideDownloads('/tmp/downloads/../a.pdf', '/tmp/downloads', (f) => f), false);
  assert.equal(insideDownloads('/tmp/downloads/link.pdf', '/tmp/downloads', real), false, 'a symlink resolving outside is rejected');
  assert.equal(insideDownloads('/tmp/downloads/a.pdf', '', real), false, 'no downloads directory means no auto-open');
});

test('the auto-open decision activates the first of a burst and caps at five a minute', () => {
  let recent = [], decision = decideAutoOpen(recent, 0);
  recent = decision.recent;
  assert.deepEqual([decision.open, decision.activate], [true, true], 'a lone download activates');
  decision = decideAutoOpen(recent, 1_000); recent = decision.recent;
  assert.deepEqual([decision.open, decision.activate], [true, false], 'a burst opens behind');
  decision = decideAutoOpen(recent, 10_000); recent = decision.recent;
  assert.deepEqual([decision.open, decision.activate], [true, true], 'a quiet gap activates again');
  while (recent.length < AUTO_OPEN_LIMIT) { decision = decideAutoOpen(recent, 20_000); recent = decision.recent; }
  decision = decideAutoOpen(recent, 20_001);
  assert.equal(decision.open, false, 'the sixth inside a minute stays in the list');
  decision = decideAutoOpen(recent, 61_000);
  assert.deepEqual([decision.open, decision.activate], [true, true], 'the cap resets with the window');
});

test('a dump of Telegram PDFs activates one tab, then stops at the per-minute cap', () => {
  const inTab = [];
  let now = 1_000_000;
  const files = {};
  const f = fixture([], files, undefined,
    async (record, options) => { inTab.push({ path: record.path, activate: options?.activate }); }, 'telegram', { now: () => now });
  const complete = (name) => {
    const savePath = `/tmp/downloads/${name}`;
    files[savePath] = true;
    const item = f.start({ filename: name, savePath });
    item.emit('done', 'completed');
  };
  complete('a.pdf');
  complete('b.pdf');
  now += 1_000;
  complete('c.pdf');
  assert.deepEqual(inTab, [
    { path: '/tmp/downloads/a.pdf', activate: true },
    { path: '/tmp/downloads/b.pdf', activate: false },
    { path: '/tmp/downloads/c.pdf', activate: false },
  ], 'only the first tab of a burst comes forward');
  now += 6_000;
  complete('d.pdf');
  complete('e.pdf');
  assert.equal(inTab.length, 5);
  assert.equal(inTab[3].activate, true, 'a quiet gap lets the next PDF activate again');
  complete('f.pdf');
  assert.equal(inTab.length, 5, 'the sixth inside a minute waits in the downloads list');
  assert.equal(f.store.list().length, 6, 'the skipped download is still recorded');
  now += 60_000;
  complete('g.pdf');
  assert.equal(inTab.length, 6, 'the cap resets with the window');
});
