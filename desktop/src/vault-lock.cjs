'use strict';
// The vault lock. While a vault fill holds one tab, EVERY agent tab of that bot is locked (whatever its origin, plus any
// tab created meanwhile): the agent's tools that could read the filled password back are closed or narrowed. The lock
// begins when a fill reaches its prompt and ends only when the filled tab's top-level document is replaced by a
// cross-document navigation (or the tab closes or crashes). The human is never locked out: the lock only gates agent
// callers (main.cjs: performStep, the snapshot and screenshot routes, tab listings, window.open and tab creation).
//
// While locked, for agent callers:
//   - eval and cdp (every method) and screenshots are refused;
//   - value-returning reads blank every input, textarea and contenteditable value, and tab titles read empty;
//   - key actions refuse clipboard combinations (Ctrl or Meta with c, x, v or a; Insert; Shift+Delete), on every platform;
//   - CSS selectors are limited to ids, classes and tags with descendant or child combinators (no attribute selectors,
//     pseudo-classes or escapes), everywhere one is accepted, because `#pw[value^="C"]` is a one-bit oracle on a value a
//     page mirrors into an attribute. Refs and names still target controls, so the login can be submitted;
//   - new tabs and window.open are refused.
//
// The lock is only sound on a context the agent never scripted: its own eval or DevTools writes could have planted a hook
// the lock cannot see. noteScript/beginScript record that, and vault-fill refuses to fill unless the context is clean.
const { READ_ONLY_CDP } = require('./commit-patterns.cjs');

// 'prompt': a fill is waiting for the user. 'filled': it ran (or may have). Absent: no lock.
const holds = (tab) => !!tab.vaultLock;
let peerTabs = () => [];
const setPeers = (provider) => { peerTabs = provider; };
const isBotLocked = (botId) => { for (const peer of peerTabs()) if (peer.botId === botId && holds(peer)) return true; return false; };
const isLocked = (tab) => holds(tab) || isBotLocked(tab.botId);
const acquire = (tab) => { if (!tab.vaultLock) tab.vaultLock = 'prompt'; };
const markFilled = (tab) => { tab.vaultLock = 'filled'; };
// A fill that did not happen lifts only its own prompt lock, never an earlier fill's.
const release = (tab) => { if (tab.vaultLock === 'prompt') delete tab.vaultLock; };
// A script still in flight (a timed-out eval keeps queued in the page) runs in whatever document comes next.
const reset = (tab) => { delete tab.vaultLock; tab.agentScripted = (tab.scriptsInFlight || 0) > 0; };

// What taints a document: eval, and any DevTools call that is not a plain read. Runtime exposes heap objects and can
// run code, so only its enable and disable count as plain.
const isScript = (body) => body.action === 'eval'
  || (body.action === 'cdp' && (!READ_ONLY_CDP.test(String(body.method || '')) || (/^Runtime\./.test(body.method) && !/^Runtime\.(?:enable|disable)$/.test(body.method))));
// Called synchronously right before the script is dispatched. Returns the function to call when the dispatch settles.
function beginScript(tab, body) {
  if (!isScript(body)) return () => {};
  tab.agentScripted = true;
  tab.scriptsInFlight = (tab.scriptsInFlight || 0) + 1;
  let ended = false;
  return () => { if (!ended) { ended = true; tab.scriptsInFlight -= 1; } };
}

// Parameters that run code on the page's next load, refused whether or not a lock is held: Page.reload's
// scriptToEvaluateOnLoad plants a main-world script that survives the reload (and so the taint reset). A reload or
// navigation carrying any other script-like parameter is refused too.
function cdpParamError(body) {
  const params = body.action === 'cdp' && body.params && typeof body.params === 'object' ? body.params : null;
  if (!params) return '';
  const carries = JSON.stringify(params).includes('scriptToEvaluateOnLoad')
    || (/^Page\.(?:reload|navigate)$/.test(String(body.method)) && Object.keys(params).some((key) => /script/i.test(key)));
  return carries ? 'cdp parameters that run script on load (scriptToEvaluateOnLoad) are not available to agents.' : '';
}

const REFUSAL = 'vault_locked: a saved password was just filled into a page of this bot, so page scripts (eval, cdp), screenshots, new tabs, clipboard keys and attribute or pseudo-class selectors are paused on its tabs, and form values and tab titles read as empty, until the filled page changes (a navigation or reload). Click, type, press and navigate still work, so you can submit the login.';
const refusal = (message = REFUSAL) => Object.assign(new Error(message), { status: 403, code: 'vault_locked' });

// Ctrl or Meta with c, x, v or a; Insert; Shift+Delete. Platform does not matter: refused everywhere.
function clipboardKey(body) {
  if (body.action !== 'press' || typeof body.key !== 'string') return false;
  const key = body.key.toLowerCase(), mods = Array.isArray(body.modifiers) ? body.modifiers : [];
  const command = mods.includes('control') || mods.includes('meta');
  return (command && ['c', 'x', 'v', 'a'].includes(key)) || key === 'insert' || (key === 'delete' && mods.includes('shift'));
}

const IDENT = '[A-Za-z_][\\w-]*';
const COMPOUND = `(?:${IDENT}(?:[#.]${IDENT})*|(?:[#.]${IDENT})+)`;
const SIMPLE_SELECTOR = new RegExp(`^${COMPOUND}(?:(?:\\s*>\\s*|\\s+)${COMPOUND})*$`);
const simpleSelector = (value) => typeof value === 'string' && value.length <= 200 && SIMPLE_SELECTOR.test(value.trim());
// Every property named *selector* anywhere in the body (a batch's steps, a flow's when, until, then and else, a list's fields).
function badSelector(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 12) return false;
  for (const [key, item] of Object.entries(value)) {
    if (/selector$/i.test(key) && item !== undefined && item !== null && !simpleSelector(item)) return true;
    if (item && typeof item === 'object' && badSelector(item, depth + 1)) return true;
  }
  return false;
}
const SELECTOR_REFUSAL = 'vault_locked: while a saved password is filled, selectors are limited to ids, classes and tags with descendant (space) or child (>) combinators. Target by ref or name instead.';
function guardSelectors(tab, body) {
  if (isLocked(tab) && badSelector(body)) throw refusal(SELECTOR_REFUSAL);
}

function guardAction(tab, body) {
  if (!isLocked(tab)) return;
  if (body.action === 'eval' || body.action === 'cdp') throw refusal();
  if (clipboardKey(body)) throw refusal('vault_locked: clipboard key combinations are paused while a saved password is filled.');
  guardSelectors(tab, body);
}
function guardScreenshot(tab) { if (isLocked(tab)) throw refusal(); }
function guardNewTab(botId) { if (isBotLocked(botId)) throw refusal(); }
// Options every page reader adds for this tab.
const readOptions = (tab) => isLocked(tab) ? { blankValues: true } : {};

// The document is gone once a cross-document navigation commits (did-navigate is not sent for in-page ones) or
// its renderer dies; a back or forward step loads a fresh document too.
function watch(tab, contents) {
  contents.on('did-navigate', () => reset(tab));
  contents.on('render-process-gone', () => reset(tab));
}

module.exports = { isLocked, isBotLocked, setPeers, acquire, markFilled, release, reset, isScript, beginScript, cdpParamError, clipboardKey, simpleSelector,
  guardAction, guardSelectors, guardScreenshot, guardNewTab, readOptions, watch };
