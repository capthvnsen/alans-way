// Run: npx electron test/pdf-viewer-electron.cjs
// Serves a fixture PDF over loopback and proves the bundled viewer renders it
// in tabs (agent-created and human-created) instead of downloading, that a
// finished Telegram-session PDF download opens a human tab on the file, and
// that agent navigation to file: stays refused. No Telegram sign-in happens.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, webContents, session } = require('electron');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-workspace-pdf-'));
process.env.HERMES_WORKSPACE_DATA = profile;
process.env.HERMES_WORKSPACE_PORT = String(19000 + Math.floor(Math.random() * 10000));
// The fixture serves pages from loopback; production code only lets a bot
// navigate there through this explicit opt-in.
process.env.HERMES_WORKSPACE_ALLOW_LOOPBACK = '1';
fs.writeFileSync(path.join(profile, 'preferences.json'), JSON.stringify({ bots: [{ id: '123', name: 'PDF fixture bot', isBot: true }], selectedBotId: '123', preview: false }));
require('../src/main.cjs');
const waitFor = async (read, predicate, timeout = 15000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (predicate(value)) return value; await new Promise(r => setTimeout(r, 50)); }
  throw new Error('Timed out waiting for PDF viewer state.');
};
// A small but complete PDF: the viewer only loads for valid documents.
function buildPdf() {
  const parts = ['%PDF-1.4\n'], offsets = [0];
  const obj = (id, body) => { offsets[id] = parts.join('').length; parts.push(`${id} 0 obj\n${body}\nendobj\n`); };
  const stream = 'BT /F1 24 Tf 100 700 Td (PDF fixture) Tj ET';
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  obj(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>');
  obj(4, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  obj(5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const start = parts.join('').length;
  parts.push('xref\n0 6\n0000000000 65535 f \n');
  for (let i = 1; i <= 5; i++) parts.push(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
  parts.push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`);
  return Buffer.from(parts.join(''));
}
const PDF = buildPdf();
const PDF_EXTENSION = 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/';
// Extension guest views can share the URL space; real tabs only.
const tabContents = (url) => webContents.getAllWebContents().filter(item => item.getURL() === url && !['webview', 'guestView'].includes(item.getType()));
let server;
app.whenReady().then(async () => {
  const win = await waitFor(() => BrowserWindow.getAllWindows()[0], win => !!win);
  const wc = win.webContents;
  // The live Telegram login screen can autofocus asynchronously. This fixture
  // simulates its downloads instead, so keep that pane inert.
  const telegram = webContents.getAllWebContents().find(item => item.session === session.fromPartition('persist:telegram'));
  if (telegram) { telegram.stop(); await telegram.loadURL('about:blank'); }
  const evaluate = code => wc.executeJavaScript(code);
  await waitFor(() => evaluate('typeof window.workspace === "object"').catch(() => false), Boolean);
  server = http.createServer((req, res) => {
    if (req.url === '/doc.pdf') {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'inline; filename="doc.pdf"');
      return res.end(PDF);
    }
    res.end('<!doctype html><title>pdf index</title>');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const pdfUrl = `http://127.0.0.1:${server.address().port}/doc.pdf`;
  const connection = JSON.parse(fs.readFileSync(path.join(profile, 'connection.json')));
  const apiRaw = async (route, method = 'GET', body, actor = 'pdf-fixture') => {
    const response = await fetch(new URL(route, connection.url), { method, headers: { Authorization: `Bearer ${connection.token}`, 'X-Hermes-Bot': actor, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  };
  const api = async (route, method = 'GET', body, actor) => {
    const { status, data } = await apiRaw(route, method, body, actor);
    assert.ok(status < 300, data.error); return data;
  };
  // The PDF viewer runs in an out-of-process child frame on the internal
  // extension URL; the mime document itself stays an empty shell, so the frame
  // tree is the reliable "the viewer loaded" signal.
  const viewerOf = async (target) => {
    try {
      return await waitFor(() => target.isDestroyed() ? null : target.mainFrame.framesInSubtree.map(frame => frame.url),
        frames => frames.some(url => url.startsWith(PDF_EXTENSION)));
    } catch (error) {
      const html = await target.executeJavaScript('document.documentElement && document.documentElement.outerHTML').catch(() => '');
      error.message += ` URL: ${target.getURL()} page: ${String(html).slice(0, 500)}`;
      throw error;
    }
  };

  // A PDF an agent opens renders in the bundled viewer: the tab stays on the
  // PDF URL, the internal viewer frame attaches, and nothing reaches the
  // downloads list.
  const agentTab = await api('/v1/tabs', 'POST', { url: pdfUrl, background: true });
  const agentWc = await waitFor(() => tabContents(pdfUrl)[0], Boolean);
  await viewerOf(agentWc);
  assert.equal(agentWc.getURL(), pdfUrl, 'the tab stays on the PDF URL');
  let state = await evaluate('window.workspace.getState()');
  assert.equal(state.downloads.length, 0, 'rendering a PDF must not create a download item');
  console.log('PASS: an agent-controlled tab renders a served PDF in the bundled viewer (no download).');

  // A human navigation to the same URL behaves identically.
  await evaluate(`window.workspace.command('create-tab', { url: ${JSON.stringify(pdfUrl)} })`);
  state = await waitFor(() => evaluate('window.workspace.getState()'), value => value.tabs.some(tab => tab.url === pdfUrl && tab.controller === 'human'));
  const humanTab = state.tabs.find(tab => tab.url === pdfUrl && tab.controller === 'human');
  assert.ok(humanTab, 'a human tab opened on the PDF URL');
  const humanWc = await waitFor(() => tabContents(pdfUrl).find(item => item !== agentWc), Boolean);
  await viewerOf(humanWc);
  console.log('PASS: a human-controlled tab renders a served PDF in the bundled viewer.');

  // A PDF that finished downloading from the Telegram session saves through
  // the store, then opens the saved file in a new human tab on a file: URL.
  const savedPdf = path.join(profile, 'chat attachment.pdf');
  fs.writeFileSync(savedPdf, PDF);
  const listeners = {};
  const fakeItem = {
    getFilename: () => 'chat attachment.pdf', getURL: () => 'blob:https://web.telegram.org/attachment',
    getMimeType: () => 'application/pdf', getState: () => 'progressing',
    getTotalBytes: () => PDF.length, getReceivedBytes: () => PDF.length,
    getSavePath: () => savedPdf, isPaused: () => false, canResume: () => false,
    pause() {}, resume() {}, cancel() {}, setSaveDialogOptions() {},
    on(name, fn) { (listeners[name] ||= []).push(fn); }, once(name, fn) { this.on(name, fn); },
  };
  session.fromPartition('persist:telegram').emit('will-download', {}, fakeItem);
  (listeners.done || []).forEach(fn => fn({}, 'completed'));
  const fileUrl = pathToFileURL(savedPdf).href;
  const fileTabWc = await waitFor(() => tabContents(fileUrl)[0], Boolean);
  await viewerOf(fileTabWc);
  state = await waitFor(() => evaluate('window.workspace.getState()'), value => value.tabs.some(tab => tab.url === fileUrl));
  const fileTab = state.tabs.find(tab => tab.url === fileUrl);
  assert.equal(fileTab.controller, 'human', 'a downloaded PDF opens under human control');
  assert.equal(state.activeTabId, fileTab.id, 'the PDF tab comes forward');
  const record = state.downloads.find(item => item.name === 'chat attachment.pdf');
  assert.equal(record.state, 'completed');
  assert.equal(record.source, 'Telegram', 'a blob download names the Telegram session');
  assert.equal(record.mime, 'application/pdf');
  console.log('PASS: a completed Telegram-session PDF download opens the saved file in a human tab.');

  // "Open" on that downloads-list row opens another in-app tab, never an
  // external viewer, and it works for the same record twice.
  await evaluate(`window.workspace.command('open-download', { id: ${JSON.stringify(record.id)} })`);
  await waitFor(() => evaluate('window.workspace.getState()'), value => value.tabs.filter(tab => tab.url === fileUrl).length >= 2);
  console.log('PASS: downloads-list Open on a PDF opens an in-app tab.');

  // The file: path is reachable only through recorded downloads: agent
  // navigation to the same file URL stays refused.
  const refused = await apiRaw(`/v1/tabs/${agentTab.id}/actions`, 'POST', { action: 'navigate', url: fileUrl, epoch: agentTab.epoch });
  assert.equal(refused.status, 400, 'agent navigation to a file: URL is refused');
  console.log('PASS: agent navigation to file: is refused.');

  server.close(); app.quit();
}).catch(error => { console.error(error.stack); server?.close(); app.exit(1); });
