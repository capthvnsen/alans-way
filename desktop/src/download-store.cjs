const crypto = require('node:crypto');

const MAX_DOWNLOADS = 50;
const STATES = new Set(['progressing', 'completed', 'cancelled', 'interrupted']);

// Opening one of these runs code (or installs it) with the user's privileges,
// so the user is asked first. Documents and media open without a prompt.
const RISKY = /\.(app|bat|cmd|com|command|cpl|dll|dmg|exe|hta|inf|jar|js|jse|lnk|msc|msi|msp|pkg|ps1|psm1|py|reg|scpt|scr|sh|url|vb|vbe|vbs|webloc|workflow|ws|wsf|wsh|appimage|desktop|deb|rpm)$/i;

function describe(record) {
  return { id: record.id, name: record.name, path: record.path, source: record.source,
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
    state: STATES.has(entry.state) ? entry.state : 'interrupted',
    receivedBytes: Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Number(entry.receivedBytes) || 0)),
    totalBytes: Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Number(entry.totalBytes) || 0)),
    startedAt: Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Number(entry.startedAt) || 0)),
    paused: false,
  };
  return /^[\w-]{8,64}$/.test(record.id) ? record : null;
}

function createDownloadStore({ getPreferences, savePreferences, onChanged = () => {}, shell, existsSync = () => false, downloadsPath = () => '', progressMs = 250, confirmOpen = async () => false }) {
  const live = new Map();
  let progressTimer, restored = false;
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
module.exports = { createDownloadStore, MAX_DOWNLOADS };
