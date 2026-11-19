'use strict';
// The vault lock on an agent tab. From the moment a vault fill reaches its prompt until the tab's top-level
// document is replaced, the agent's tools that could read the filled password back are closed on that tab:
// page script (eval, cdp), screenshots, and every value in a read (see readOptions). Clicking, typing, pressing
// keys and navigating stay open so the agent can submit the login. The human is never locked out: the lock only
// gates agent callers (main.cjs, performStep and the snapshot and screenshot routes).
//
// The lock is only sound on a document the agent never scripted: its own eval or DevTools writes could have
// planted a hook (a listener, a patched getter, a fake reader) that the lock cannot see. noteScript records
// that, and vault-fill refuses to fill into such a document.
const { READ_ONLY_CDP } = require('./commit-patterns.cjs');

// 'prompt': a fill is waiting for the user. 'filled': it ran (or may have). Absent: no lock.
const holds = (tab) => !!tab.vaultLock;
// A popup the agent opened keeps window.opener, and an agent tab of the same bot on the same origin can script the
// locked page through it. So a tab is locked when it holds the lock, or a peer of its bot at its own origin does.
let peerTabs = () => [];
const setPeers = (provider) => { peerTabs = provider; };
const originOf = (tab) => { try { return new URL(tab.view.webContents.getURL()).origin; } catch { return ''; } };
function isLocked(tab) {
  if (holds(tab)) return true;
  const here = originOf(tab);
  if (!here || here === 'null') return false;
  for (const peer of peerTabs()) if (peer !== tab && peer.botId === tab.botId && holds(peer) && originOf(peer) === here) return true;
  return false;
}
const acquire = (tab) => { if (!tab.vaultLock) tab.vaultLock = 'prompt'; };
const markFilled = (tab) => { tab.vaultLock = 'filled'; };
// A fill that did not happen lifts only its own prompt lock, never an earlier fill's.
const release = (tab) => { if (tab.vaultLock === 'prompt') delete tab.vaultLock; };
const reset = (tab) => { delete tab.vaultLock; tab.agentScripted = false; };

// The same line agent-input's commit guard draws: eval and any DevTools call that is not a plain read.
const isScript = (body) => body.action === 'eval' || (body.action === 'cdp' && !READ_ONLY_CDP.test(String(body.method || '')));
const noteScript = (tab, body) => { if (isScript(body)) tab.agentScripted = true; };

const REFUSAL = 'vault_locked: a saved password was just filled into this page, so page scripts (eval, cdp) and screenshots are paused on this tab and form values read as empty, until the page changes (a navigation or reload). Click, type, press and navigate still work, so you can submit the login.';
function guardAction(tab, body) {
  if (isLocked(tab) && (body.action === 'eval' || body.action === 'cdp')) throw Object.assign(new Error(REFUSAL), { status: 403, code: 'vault_locked' });
}
function guardScreenshot(tab) {
  if (isLocked(tab)) throw Object.assign(new Error(REFUSAL), { status: 403, code: 'vault_locked' });
}
// Options every page reader adds for this tab.
const readOptions = (tab) => isLocked(tab) ? { blankValues: true } : {};

// The document is gone once a cross-document navigation commits (did-navigate is not sent for in-page ones) or
// its renderer dies; a back or forward step loads a fresh document too.
function watch(tab, contents) {
  contents.on('did-navigate', () => reset(tab));
  contents.on('render-process-gone', () => reset(tab));
}

module.exports = { isLocked, setPeers, acquire, markFilled, release, reset, isScript, noteScript, guardAction, guardScreenshot, readOptions, watch };
