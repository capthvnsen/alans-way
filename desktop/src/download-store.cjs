const crypto = require('node:crypto');
const path = require('node:path');

const MAX_DOWNLOADS = 50;
const STATES = new Set(['progressing', 'completed', 'cancelled', 'interrupted']);

// Opening one of these runs code (or installs it) with the user's privileges,
// so the user is asked first. Markup counts too: the system browser would run
// its script. Documents and media open without a prompt.
const RISKY = /\.(app|bat|cmd|com|command|cpl|dll|dmg|exe|hta|inf|jar|js|jse|lnk|msc|msi|msp|pkg|ps1|psm1|py|reg|scpt|scr|sh|url|vb|vbe|vbs|webloc|workflow|ws|wsf|wsh|appimage|desktop|deb|rpm|html|htm|svg|xhtml|xml|mht|mhtml)$/i;

// The saved path decides: Chromium serves a file by its on-disk extension, so
// a sender-controlled mime or attachment name claiming invoice.html is a PDF
// must never reach a file:// tab. Name or mime only backs up a real .pdf file.
function isPdf(record) {
  const mime = String(record?.mime || '').split(';')[0].trim().toLowerCase();
  return /\.pdf$/i.test(String(record?.path || '')) && (mime === 'application/pdf' || /\.pdf$/i.test(String(record?.name || '')));
}

// Auto-open only trusts files under the downloads directory; resolving both
// ends keeps a symlinked or dot-dot save path from pointing elsewhere.
function insideDownloads(file, dir, realpath) {
  try {
    const relative = path.relative(realpath(dir), realpath(file));
    return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  } catch { return false; }
}

// A dump of chat PDFs must not keep grabbing focus: only the first tab of a
// burst activates, and past a few per minute the files wait in the list.
const AUTO_OPEN_LIMIT = 5, AUTO_OPEN_WINDOW_MS = 60_000, AUTO_OPEN_BURST_MS = 5_000;

function decideAutoOpen(times, at) {
  const recent = times.filter(opened => at - opened < AUTO_OPEN_WINDOW_MS);
  if (recent.length >= AUTO_OPEN_LIMIT) return { open: false, activate: false, recent };
  return { open: true, activate: !recent.some(opened => at - opened < AUTO_OPEN_BURST_MS), recent: [...recent, at] };
}

function describe(record) {
  return { id: record.id, name: record.name, path: record.path, source: record.source, mime: record.mime,
    state: record.state, paused: record.paused === true,
    receivedBytes: record.receivedBytes, totalBytes: record.totalBytes, startedAt: record.startedAt };
}

// Preferences keep finished downloads across restarts; sanitize anything the
// file hands back so the list can never carry a malformed entry.
function sanitize(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const record = {
    id: String(entry.id || ''), name: String(entry.name || 'download').slice(0, 300),
    path: String(entry.path || '').slice(0, 2000), source: String(entry.source || '').slice(0, 60),
    mime: String(entry.mime || '').slice(0, 100),
    state: STATES.has(entry.state) ? entry.state : 'interrupted',
    receivedBytes: Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Number(entry.receivedBytes) || 0)),
    totalBytes: Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Number(entry.totalBytes) || 0)),
    startedAt: Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Number(entry.startedAt) || 0)),
    paused: false,
  };
  return /^[\w-]{8,64}$/.test(record.id) ? record : null;
}

function createDownloadStore({ getPreferences, savePreferences, onChanged = () => {}, shell, existsSync = () => false, downloadsPath = () => '', progressMs = 250, confirmOpen = async () => false, openInTab = null, realpath = (file) => file, now = () => Date.now() }) {
  const live = new Map();
  let progressTimer, restored = false, autoOpens = [];
  function records() {
    const prefs = getPreferences();
    if (!prefs) return [];
    if (!restored) {
      prefs.downloads = (Array.isArray(prefs.downloads) ? prefs.downloads : []).map(sanitize).filter(Boolean).slice(0, MAX_DOWNLOADS);
      restored = true;
    }
    return prefs.downloads;
  }
  function find(id) {
    const record = records().find(item => item.id === String(id || ''));
    if (!record) throw new Error('Download not found.');
    return record;
  }
  // Progress ticks can arrive per network chunk; coalesce them into a slow
  // drip of repaints and let state changes through immediately.
  function notify(immediate = false) {
    if (immediate) { clearTimeout(progressTimer); progressTimer = undefined; onChanged(); return; }
    if (progressTimer) return;
    progressTimer = setTimeout(() => { progressTimer = undefined; onChanged(); }, progressMs);
    progressTimer.unref?.();
  }
  function sourceOf(url, scope) {
    try { const host = new URL(url).hostname; if (host) return host; } catch {}
    return scope === 'telegram' ? 'Telegram' : '';
  }
  function track(item, scope) {
    const record = {
      id: crypto.randomUUID(), name: String(item.getFilename() || 'download').slice(0, 300),
      path: '', source: sourceOf(item.getURL(), scope),
      mime: String(item.getMimeType?.() || '').slice(0, 100),
      state: STATES.has(item.getState?.()) ? item.getState() : 'progressing',
      receivedBytes: 0, totalBytes: Math.max(0, Number(item.getTotalBytes()) || 0),
      startedAt: Date.now(), paused: false,
    };
    const list = records();
    list.unshift(record);
    if (list.length > MAX_DOWNLOADS) list.length = MAX_DOWNLOADS;
    if (record.state === 'progressing') live.set(record.id, item);
    const update = () => {
      record.receivedBytes = Math.max(0, Number(item.getReceivedBytes()) || 0);
      record.totalBytes = Math.max(0, Number(item.getTotalBytes()) || 0);
      record.paused = item.isPaused?.() === true;
      const savePath = item.getSavePath?.();
      if (savePath) record.path = String(savePath).slice(0, 2000);
    };
    item.on('updated', () => { update(); notify(); });
    item.once('done', (_event, state) => {
      update();
      record.state = STATES.has(state) ? state : 'interrupted';
      record.paused = false;
      live.delete(record.id);
      savePreferences();
      notify(true);
      // Chat attachments arrive through the Telegram session; a finished PDF
      // saved under the downloads directory opens in a workspace tab instead
      // of surfacing a native dialog.
      if (record.state === 'completed' && scope === 'telegram' && record.path && openInTab && isPdf(record) && insideDownloads(record.path, downloadsPath(), realpath)) {
        const decision = decideAutoOpen(autoOpens, now());
        autoOpens = decision.recent;
        if (decision.open) Promise.resolve(openInTab(record, { activate: decision.activate })).catch(() => {});
      }
    });
    if (item.getState() !== 'interrupted') item.setSaveDialogOptions?.({ title: 'Save download' });
    notify(true);
  }
  function install(session, scope = 'browser') {
    session.on('will-download', (_event, item) => { try { track(item, scope); } catch {} });
  }
  function saved(record) {
    if (!record.path || !existsSync(record.path)) throw new Error('This file is no longer on disk.');
    return record.path;
  }
  async function open(id) {
    const record = find(id), file = saved(record);
    if (isPdf(record) && openInTab) return openInTab(record);
    if ((RISKY.test(file) || RISKY.test(record.name)) && !(await confirmOpen(record.name))) return;
    const failure = await shell.openPath(file);
    if (failure) throw new Error(String(failure).slice(0, 300));
  }
  function showInFolder(id) { shell.showItemInFolder(saved(find(id))); }
  function pause(id, paused) {
    const item = live.get(find(id).id);
    if (!item) throw new Error('This download is no longer running.');
    if (paused) item.pause(); else if (item.canResume?.() !== false) item.resume();
  }
  function cancel(id) {
    const item = live.get(find(id).id);
    if (!item) throw new Error('This download is no longer running.');
    item.cancel();
  }
  function clear() {
    const prefs = getPreferences();
    if (!prefs) return;
    prefs.downloads = records().filter(record => record.state === 'progressing');
    savePreferences();
    notify(true);
  }
  async function openFolder() {
    const failure = await shell.openPath(downloadsPath());
    if (failure) throw new Error(String(failure).slice(0, 300));
  }
  return { install, list: () => records().map(describe), open, showInFolder, pause, cancel, clear, openFolder };
}
module.exports = { createDownloadStore, isPdf, insideDownloads, decideAutoOpen, AUTO_OPEN_LIMIT, MAX_DOWNLOADS };
