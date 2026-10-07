// Pure helpers for the app shell (preferences file, coalesced timers, retry,
// request checks). Kept free of Electron so unit tests can cover them.
'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { fileURLToPath } = require('node:url');

const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES', 'EMFILE']);
function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

// Windows antivirus and indexers briefly lock freshly written files, so a
// rename can fail with EPERM once and succeed a moment later.
function writePrivateJson(file, data, { fsApi = fs, retryDelayMs = 60 } = {}) {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  let failure;
  for (let attempt = 0; attempt < 2; attempt++) {
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      const fd = fsApi.openSync(tmp, 'w', 0o600);
      try { fsApi.writeSync(fd, text); fsApi.fsyncSync(fd); } finally { fsApi.closeSync(fd); }
      fsApi.renameSync(tmp, file);
      return;
    } catch (error) {
      failure = error;
      try { fsApi.rmSync(tmp, { force: true }); } catch {}
      if (attempt === 0 && RETRYABLE.has(error.code)) { sleepSync(retryDelayMs); continue; }
      break;
    }
  }
  throw failure;
}

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const isString = (value) => typeof value === 'string';
const ARRAY_ITEMS = {
  bots: (item) => isObject(item) && isString(item.id), avatarLibrary: (item) => isObject(item) && isString(item.id),
  savedTabs: (item) => isObject(item) && isString(item.url),
  order: isString, hidden: isString, overseerBots: isString,
};
// A hand-edited or half-written preferences file must never hand the app a
// string where it iterates an array. Any field of the wrong type falls back to
// the default; keys the defaults do not know pass through untouched.
function normalizePreferences(raw, defaults) {
  const input = isObject(raw) ? raw : {};
  const out = { ...defaults, ...input };
  for (const [key, fallback] of Object.entries(defaults)) {
    const value = input[key];
    if (value === undefined) continue;
    if (Array.isArray(fallback)) out[key] = Array.isArray(value) ? value.filter(ARRAY_ITEMS[key] || isObject) : fallback;
    else if (fallback === null) out[key] = value === null || (isObject(value) && Number.isFinite(value.x) && Number.isFinite(value.y)) ? value : fallback;
    else if (isObject(fallback)) out[key] = isObject(value) ? value : fallback;
    else if (typeof value !== typeof fallback || (typeof value === 'number' && !Number.isFinite(value))) out[key] = fallback;
  }
  return out;
}

// Leading and trailing edge: an isolated call runs at once, and calls inside
// the next `ms` collapse into one more run when the window closes.
function coalesce(fn, ms) {
  let timer, pending = false;
  const arm = () => {
    timer = setTimeout(() => { timer = undefined; if (pending) { pending = false; fn(); arm(); } }, ms);
    timer.unref?.();
  };
  const schedule = () => { if (timer) { pending = true; return; } fn(); arm(); };
  schedule.flush = () => { if (pending) { clearTimeout(timer); timer = undefined; pending = false; fn(); arm(); } };
  return schedule;
}

// Debounced, change-detecting writer: `snapshot()` returns the object to
// persist; nothing is written when it serializes the same as the last write.
function createSaver({ snapshot, write, onError = () => {}, delayMs = 250 }) {
  let timer, lastText = null;
  function flush() {
    clearTimeout(timer); timer = undefined;
    try {
      const data = snapshot();
      if (!data) return false;
      const text = JSON.stringify(data, null, 2);
      if (text === lastText) return false;
      write(text);
      lastText = text;
      return true;
    } catch (error) { onError(error); return false; }
  }
  function schedule() { if (!timer) { timer = setTimeout(flush, delayMs); timer.unref?.(); } }
  return { schedule, flush, seed(data) { lastText = JSON.stringify(data, null, 2); } };
}

// Retry with growing delays. `now()` retries immediately (for example when the
// network returns) without resetting the backoff; `reset()` marks success.
function createRetry({ run, delays = [2000, 5000, 15000, 30000, 60000] }) {
  let timer, attempt = 0;
  const clear = () => { clearTimeout(timer); timer = undefined; };
  return {
    schedule() {
      if (timer) return;
      const ms = delays[Math.min(attempt++, delays.length - 1)];
      timer = setTimeout(() => { timer = undefined; run(); }, ms);
      timer.unref?.();
    },
    now() { clear(); run(); },
    reset() { attempt = 0; clear(); },
    get pending() { return !!timer; },
  };
}

// DNS-rebinding defense in depth: a page on another origin can be pointed at
// 127.0.0.1 but cannot make the browser send a loopback Host header.
function hostAllowed(header, port) {
  const match = /^(127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})$/i.exec(String(header || ''));
  return !!match && Number(match[2]) === port;
}

// Chromium and pathToFileURL encode some characters differently (%, ~, [, ]),
// so trust is decided on the decoded path, never on the URL string.
function fileUrlMatches(href, file) {
  try {
    const url = new URL(href);
    if (url.protocol !== 'file:') return false;
    url.search = ''; url.hash = '';
    // Chromium leaves a stray % (one not starting an escape) unescaped.
    url.pathname = url.pathname.replace(/%(?![0-9a-fA-F]{2})/g, '%25');
    const norm = (value) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
    return norm(fileURLToPath(url)) === norm(file);
  } catch { return false; }
}

// A tray icon with no host to draw it is invisible, and hiding the window
// behind it would strand the app. GNOME needs the AppIndicator extension; other
// desktops either have a StatusNotifier host or fall back to an XEmbed tray.
function linuxTrayUsable({ desktop = '', hasWatcher = false } = {}) {
  return hasWatcher || !/gnome/i.test(desktop);
}

function pollTier({ visible, minimized, focused }) {
  if (!visible || minimized) return 'hidden';
  return focused ? 'active' : 'idle';
}

// Reads a page signal, waits, reads again, and calls onStuck if it did not move.
async function watchChange({ read, delayMs, onStuck }) {
  try {
    const before = await read();
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (await read() === before) onStuck();
  } catch {}
}

module.exports = { writePrivateJson, normalizePreferences, coalesce, createSaver, createRetry, hostAllowed, fileUrlMatches, linuxTrayUsable, pollTier, watchChange };
