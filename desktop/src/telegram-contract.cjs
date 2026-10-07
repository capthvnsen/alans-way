// What the Telegram preload relies on: the tt-data IndexedDB global-state shape
// and a few DOM anchors. Telegram Web A is third-party, so when an update moves
// them the app must say so instead of silently listing no bots. Dependency-free
// because the sandboxed preload bundles this file.
'use strict';

const BREAK_AFTER_MS = 90000;
const isObject = (value) => !!value && typeof value === 'object';

function contractHolds({ dbDiag, cached, authVisible, hasLeftColumn }) {
  if (authVisible || cached?.passcode?.isScreenLocked) return true;
  if (dbDiag !== 'ok' || !isObject(cached) || !cached.currentUserId) return false;
  return isObject(cached.users?.byId) && isObject(cached.chats?.byId) && hasLeftColumn === true;
}

// A bad read is normal while Telegram boots, right after QR sign-in, and on
// alt-tab, so only a miss that lasts `windowMs` counts, and only once the
// contract has held in this session or the user is clearly logged in.
function createContractMonitor(windowMs = BREAK_AFTER_MS) {
  let missingSince = null, held = false;
  return { observe(ok, { full = false, loggedIn = false } = {}, now = Date.now()) {
    if (ok) { missingSince = null; if (full) held = true; return false; }
    missingSince ??= now;
    return now - missingSince >= windowMs && (held || loggedIn);
  } };
}

module.exports = { contractHolds, createContractMonitor, BREAK_AFTER_MS };
