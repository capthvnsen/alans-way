'use strict';
// Fills a saved login from Hermes's own vault into a page of the built-in browser, for the `preview.act`
// requests Hermes sends the client that owns the browser (tools/browser_vault_preview.py, operation
// open | evaluate | close). Hermes resolves the secret on its side and sends it INSIDE the fill script; the model
// never sees it. This module is the only door that script walks through, in the main process:
//   - open pins one agent tab of the conversation's bot, bound to its document (a counter only a new document advances) and control (epoch);
//   - `window.location.href` is answered from the main process's own navigation state, never from the page;
//   - only the exact inspection and fill scripts Hermes builds (vault-scripts.cjs) run, over CDP in an isolated world
//     of the tab's main frame, so a page (or an agent's earlier eval) that patched its own builtins sees nothing;
//   - a fill needs: the tab's top-level origin (not opaque) exactly equal to the origin the entry is bound to, a native
//     Allow once from the user, and the same checks again right before the page runs it;
//   - from the prompt on, the tab is vault-locked (vault-lock.cjs) so the agent cannot read the value back.
// What goes back to Hermes is rebuilt here: a count, a reason, and for the inspection a descriptor of each password input
// whose label, name and autocomplete text is page-derived (capped at 64 characters, control characters stripped).
// Logs carry the step and a reason code. JS strings cannot be zeroed: the secret is kept in no field of ours
// and the request's copy is blanked as soon as the page has run it.
const { INSPECT, FILL, clearJs } = require('./vault-scripts.cjs');
const lock = require('./vault-lock.cjs');

const VAULT_REQUESTS = new Set(['vault.code', 'vault.unlock_prompt', 'vault.save_login']);
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
// Requests the conversation controller must never hold: they carry (or ask for) vault secrets.
const isVaultRequest = (method, params) => VAULT_REQUESTS.has(method)
  || (method === 'preview.act' && isPlainObject(params) && params.action === 'vault');

const MAX_EXPRESSION = 65536, MAX_TARGETS = 16, MAX_CONTROLS = 50, PAGE_MS = 5000;
const NOT_YET = 'not supported yet';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const JSON_STRING = '"(?:[^"\\\\\\n]|\\\\.)*"';
const SLOT = { __NONCE__: JSON_STRING, __EXPECTED_ORIGIN__: JSON_STRING, __FILLS__: '\\[.*?\\]' };
// A template with each slot as a JSON capture: an expression matches only if it IS the template with JSON
// values in its slots. A JSON value is data, so nothing else can ride along in the script.
function templateMatcher(template) {
  const literals = template.split(/__[A-Z_]+__/), slots = template.match(/__[A-Z_]+__/g);
  const source = literals.reduce((acc, text, i) => `${acc}${escapeRe(text)}${i < slots.length ? `(${SLOT[slots[i]]})` : ''}`, '^');
  return new RegExp(`${source}$`, 's');
}
const INSPECT_RE = templateMatcher(INSPECT), FILL_RE = templateMatcher(FILL);
const NONCE_RE = /^[0-9a-f]{8,64}$/;
const parseJson = (text) => { try { return JSON.parse(text); } catch { return undefined; } };

function matchInspect(expression) {
  const m = INSPECT_RE.exec(expression), nonce = m && parseJson(m[1]);
  return typeof nonce === 'string' && NONCE_RE.test(nonce) ? { nonce } : null;
}
function matchFill(expression) {
  const m = FILL_RE.exec(expression);
  if (!m) return null;
  const [origin, fills, nonce] = [parseJson(m[1]), parseJson(m[2]), parseJson(m[3])];
  const shaped = (f) => isPlainObject(f) && Object.keys(f).sort().join() === 'index,token,value'
    && Number.isSafeInteger(f.index) && f.index >= 0 && typeof f.token === 'string' && typeof f.value === 'string';
  return typeof origin === 'string' && typeof nonce === 'string' && Array.isArray(fills) && fills.every(shaped) ? { origin, fills, nonce } : null;
}

// An origin as the browser writes it, http(s) only: the entry's bound origin must already be in this form.
function originOf(url) {
  try { const u = new URL(url); return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : ''; } catch { return ''; }
}
const canonicalOrigin = (s) => typeof s === 'string' && s && originOf(s) === s ? s : '';

const ok = (extra = {}) => ({ success: true, ...extra });
const refuse = (error_type, error) => ({ success: false, error_type, error });
const REASONS = {
  no_bot: 'This conversation is not tied to a bot of this app, so there is no agent tab to fill.',
  no_tab: "This bot has no agent tab open in the built-in browser. Open the login page first.",
  human_has_control: 'The person has taken this tab. Nothing was filled.',
  navigating: 'The page is still navigating. Nothing was filled.',
  page_changed: 'The page changed since the vault operation started. Nothing was filled.',
  opaque_origin: 'This page has an opaque (sandboxed) origin, so it is not the site the login is saved for. Nothing was filled.',
  origin_mismatch: "The tab's site is not exactly the site this login is saved for. Nothing was filled.",
  page_scripted: 'The agent has run script (eval or a DevTools write) in this page, which could read the password back. Reload the page (navigate to it again), then ask again. Nothing was filled.',
  origin_scripted: 'An agent has run script on this site since the app started, which can leave state this check cannot see. Fills on this site are refused until the app restarts. Nothing was filled.',
  service_worker: 'This page is controlled by a service worker, which can rewrite the page or read what is typed into it. Nothing was filled.',
  not_isolated: 'Another tab shares a browsing context or this site with the tab to fill (a popup or its opener, or a second tab of this bot on the same site), so it could read the password back. Close the other tabs on this site and any popups, then ask again. Nothing was filled.',
  denied: 'The user chose not to fill this login. Do not ask again this turn.',
  denied_recently: 'A fill prompt for this site was just declined or went unanswered. Do not ask again this turn.',
  no_answer: 'The user did not answer the fill prompt in time. Nothing was filled.',
  app_inactive: 'The app is not the active app, so the user was not asked. Nothing was filled; ask the user to open the app first.',
  rate_limited: 'Too many fill prompts for this bot in the last minute. Nothing was filled.',
  backoff: 'Fill prompts for this bot are paused after repeated unanswered, denied or withdrawn requests. Nothing was filled.',
  busy: 'Another fill prompt is already open. Nothing was filled.',
  unknown_target: 'That vault target is closed or expired. Open a new one.',
  no_inspection: 'The fill does not match the page inspection that came before it. Nothing was filled.',
  already_filled: 'This vault target already filled once. Open a new one.',
  page_failed: 'The page could not complete the vault step. Nothing was filled or its result was unusable.',
  bad_request: 'The vault request was malformed.',
  internal: 'The vault step failed.',
};
const no = (type, message) => refuse(type, message || REASONS[type]);

const WORLD = 'hermes-vault';
const MAX_ANSWER = 256 * 1024, CLEAR_MS = 2000, PROMPTS_PER_MINUTE = 3, BACKOFF_MINUTES = [1, 5, 15], MAX_STREAKS = 100;
// A page's answer is data from the page: a string of bounded size, parsed only then.
const pageJson = (raw) => typeof raw === 'string' && raw.length <= MAX_ANSWER ? parseJson(raw) : undefined;

// `command(tab, method, params)` sends one CDP command to the tab. `ask` resolves true (Allow once), false (Deny),
// 'inactive' (the app is not the active app, nothing was shown) or null (no answer).
function createVaultFill({ botFor, nameFor = () => '', listTabs, command, ask, log = () => {}, now = Date.now,
  targetTtlMs = 5 * 60000, askMs = 30000, denyMs = 60000 }) {
  const targets = new Map(), denied = new Map(), prompts = new Map(), streaks = new Map(), penalty = new Map();
  let asking = false;

  const findTab = (id) => { for (const tab of listTabs()) if (tab.id === id) return tab; return null; };
  const liveContents = (tab) => { const wc = tab?.view?.webContents; return wc && !wc.isDestroyed() && !wc.isCrashed() ? wc : null; };
  const agentTab = (tab, bot) => tab.controller === 'agent' && tab.botId === bot && !tab.extensionPage && !tab.localPdf && !tab.preflight;

  const frameOrigin = (tab) => { try { return liveContents(tab).mainFrame.origin; } catch { return ''; } };
  // The context the password goes into must be one nothing but the site can reach: no popup link to or from the tab (a
  // popup keeps window.opener, and an about:blank one inherits the origin), no other tab of the bot on the same site
  // (judged by the frame's own origin, not the URL), and nothing the agent scripted there, or still has in flight.
  function unclean(tab, bound) {
    if (tab.agentScripted || (tab.scriptsInFlight || 0) > 0) return 'page_scripted';
    const live = [...listTabs()].filter(liveContents), ids = new Set(live.map((t) => t.id));
    const linked = new Set([tab.id]), queue = [tab];
    while (queue.length) {
      const at = queue.pop();
      for (const t of live) {
        if (linked.has(t.id) || !((t.openerId && t.openerId === at.id) || (at.openerId && at.openerId === t.id && ids.has(at.openerId)))) continue;
        linked.add(t.id); queue.push(t);
      }
    }
    if (linked.size > 1) return 'not_isolated';
    for (const t of live) if (t !== tab && t.botId === tab.botId && frameOrigin(t) === bound) return 'not_isolated';
    if (lock.isScriptedOrigin(bound)) return 'origin_scripted';
    return '';
  }
  const negative = (key, bot) => {
    const n = (streaks.get(key) || 0) + 1;
    streaks.delete(key); streaks.set(key, n);
    while (streaks.size > MAX_STREAKS) streaks.delete(streaks.keys().next().value);
    if (n >= 2) penalize(bot);
  };
  // Backoff grows 1, 5, 15 minutes per bot and starts over after an hour of quiet or an Allow.
  function penalize(bot) {
    let p = penalty.get(bot);
    if (p && now() - p.until > 3600000) p = null;
    const level = Math.min((p ? p.level : 0) + 1, BACKOFF_MINUTES.length);
    penalty.set(bot, { level, until: now() + BACKOFF_MINUTES[level - 1] * 60000 });
  }

  // The tab as the main process knows it right now, or why it cannot be filled. Page script is never asked.
  function read(target) {
    const tab = findTab(target.tabId), wc = liveContents(tab);
    if (!wc || tab.botId !== target.botId || tab.extensionPage || tab.localPdf) return { why: 'no_tab' };
    if (tab.controller !== 'agent') return { why: 'human_has_control' };
    if (!agentTab(tab, target.botId)) return { why: 'no_tab' };
    if (tab.navigationUrl) return { why: 'navigating' };
    if (tab.recoveryUrl || tab.error || (tab.documentSeq || 0) !== target.documentSeq || tab.epoch !== target.epoch) return { why: 'page_changed' };
    const origin = originOf(wc.getURL()), frame = wc.mainFrame;
    // Top frame only: what the scripts run in must be the very document whose origin was just read.
    if (!origin || !frame || frame.isDestroyed?.() || frame.detached || originOf(frame.url) !== origin) return { why: 'page_changed' };
    // A sandboxed document (CSP sandbox) has an opaque origin but the URL's origin in location.origin, which is what
    // the URL comparison above and the fill script's own check both read. The frame says what it really is.
    if (frame.origin === 'null') return { why: 'opaque_origin' };
    if (frame.origin !== origin) return { why: 'page_changed' };
    return { tab, origin, wc };
  }

  // A service worker that controls the document can rewrite the page or read what is typed into it; one registered earlier
  // (by an agent's eval, another bot, or a hostile page) survives a reload. Asked of the page from the isolated world, which
  // sees the same navigator.serviceWorker.controller. If the page cannot say, it is not filled.
  const SW_CHECK = '(() => JSON.stringify({ controlled: !!(navigator.serviceWorker && navigator.serviceWorker.controller) }))()';
  async function workerRefusal(tab) {
    let answer;
    try { answer = pageJson(await run(tab, SW_CHECK)); } catch { return 'page_failed'; }
    return isPlainObject(answer) && typeof answer.controlled === 'boolean' ? (answer.controlled ? 'service_worker' : '') : 'page_failed';
  }

  // One script in a fresh isolated world of the tab's main frame, bounded, and its error text (which can quote
  // the script) dropped. An isolated world has its own builtins: nothing the page or an earlier agent script
  // patched applies to it, while the DOM, and so the page's own input and change listeners, are shared.
  async function run(tab, expression, ms = PAGE_MS) {
    let timer;
    try {
      return await Promise.race([(async () => {
        const { frameTree } = await command(tab, 'Page.getFrameTree', {});
        const { executionContextId } = await command(tab, 'Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: WORLD, grantUniveralAccess: false });
        const out = await command(tab, 'Runtime.evaluate', { contextId: executionContextId, expression, returnByValue: true });
        if (out.exceptionDetails) throw new Error('page error');
        return out.result && out.result.value;
      })(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); timer.unref?.(); })]);
    } finally { clearTimeout(timer); }
  }

  // Removes the stamps an inspection left (the fill script removes its own). Best effort, bounded, never throws.
  async function clearStamps(target) {
    const nonce = target.nonce;
    target.nonce = '';
    const tab = findTab(target.tabId);
    if (!nonce || !liveContents(tab) || (tab.documentSeq || 0) !== target.documentSeq) return;
    try { await run(tab, clearJs(nonce), CLEAR_MS); } catch { /* the page is gone or busy: the stamps go with it */ }
  }
  const forget = (id) => { const target = targets.get(id); targets.delete(id); if (target) clearStamps(target); };

  const lookup = (v, storedId) => {
    const target = typeof v.target === 'string' ? targets.get(v.target) : null;
    if (target && target.expiresAt < now()) { forget(v.target); return null; }
    return target && target.storedId === storedId ? target : null;
  };

  function open({ storedId }) {
    const bot = botFor(storedId);
    if (!bot) return no('no_bot');
    const mine = [...listTabs()].filter((t) => t.botId === bot && liveContents(t) && !t.extensionPage && !t.localPdf);
    const own = mine.filter((t) => agentTab(t, bot)).sort((a, b) => Math.max(b.agentSince || 0, b.lastAgentActivity || 0) - Math.max(a.agentSince || 0, a.lastAgentActivity || 0));
    if (!own.length) return no(mine.length ? 'human_has_control' : 'no_tab');
    const tab = own[0], target = { storedId, botId: bot, tabId: tab.id, documentSeq: tab.documentSeq || 0, epoch: tab.epoch, nonce: '', filled: false, typed: false, expiresAt: now() + targetTtlMs };
    const seen = read(target);
    if (seen.why) return no(seen.why);
    while (targets.size >= MAX_TARGETS) forget(targets.keys().next().value);
    const id = require('node:crypto').randomUUID();
    targets.set(id, target);
    return ok({ target: id });
  }

  const control = (c) => {
    const text = (v) => typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, 64) : '';
    const int = (v) => Number.isSafeInteger(v) && v >= 0 ? v : null;
    return { autocomplete: text(c.autocomplete), formIndex: int(c.formIndex), index: c.index, label: text(c.label), maxLength: int(c.maxLength), name: text(c.name), type: 'password' };
  };

  async function inspect(target, expression, inspection) {
    const seen = read(target);
    if (seen.why) return no(seen.why);
    const raw = pageJson(await run(seen.tab, expression));
    const after = read(target);
    if (after.why) return no(after.why);
    if (!Array.isArray(raw)) return no('page_failed');
    target.nonce = inspection.nonce;
    // Only password inputs, each as a descriptor whose text is page-derived (capped, control characters stripped): the
    // least of the page that Hermes needs to choose the field, and it does go to Hermes.
    const controls = raw.filter((c) => isPlainObject(c) && c.type === 'password' && Number.isSafeInteger(c.index) && c.index >= 0).slice(0, MAX_CONTROLS).map(control);
    return ok({ result: JSON.stringify(controls) });
  }

  async function fill(target, expression, fillScript, signal) {
    const { fills } = fillScript;
    if (!fills.length) return no('bad_request');
    if (fills.length !== 1 || fills[0].token !== 'current-password') return no('unsupported', `Only a saved password can be filled; one-time codes, usernames, cards and addresses are ${NOT_YET}.`);
    if (!fills[0].value || fills[0].value.length > 1024) return no('bad_request');
    const bound = canonicalOrigin(fillScript.origin);
    if (!bound) return no('bad_request', 'The saved login is not bound to a plain http(s) origin. Nothing was filled.');
    if (target.filled) return no('already_filled');
    if (!target.nonce || target.nonce !== fillScript.nonce) return no('no_inspection');
    let seen = read(target);
    if (seen.why) return no(seen.why);
    if (seen.origin !== bound) return no('origin_mismatch');
    const unclear = unclean(seen.tab, bound);
    if (unclear) return no(unclear);
    const tab = seen.tab;
    const worker = await workerRefusal(tab);
    if (worker) return no(worker);

    const key = JSON.stringify([target.botId, bound]);
    for (const [k, until] of denied) if (until <= now()) denied.delete(k);
    const paused = penalty.get(target.botId);
    if (paused && paused.until > now()) return no('backoff', `${REASONS.backoff} Try again in about ${Math.ceil((paused.until - now()) / 60000)} minute(s).`);
    if (denied.get(key) > now()) return no('denied_recently');
    if (asking) return no('busy');
    const recent = (prompts.get(target.botId) || []).filter((t) => t > now() - 60000);
    if (recent.length >= PROMPTS_PER_MINUTE) { penalize(target.botId); return no('rate_limited'); }

    // The page the user is asked about, from the main process's own navigation state (never from the page).
    let page = '';
    try { const u = new URL(seen.wc.getURL()); page = `${u.pathname}${u.search}`; } catch { /* the origin alone */ }
    // From here until the answer, and after a fill, the agent's readers on this tab are closed.
    lock.acquire(tab);
    // Drop what an earlier DevTools Network.enable buffered (request bodies, post data): the login's own request must not be in it.
    Promise.resolve().then(() => command(tab, 'Network.disable', {})).catch(() => {});
    asking = true;
    let keep = false;
    try {
      const deadline = AbortSignal.timeout(askMs), cancel = signal ? AbortSignal.any([signal, deadline]) : deadline;
      const settled = new Promise((resolve) => { if (cancel.aborted) resolve(null); else cancel.addEventListener('abort', () => resolve(null), { once: true }); });
      prompts.set(target.botId, [...recent, now()]);
      // Raced against the abort: a prompt that never settles cannot hold the slot.
      const answer = await Promise.race([Promise.resolve().then(() => ask({ botId: target.botId, botName: nameFor(target.botId) || target.botId, origin: bound, page }, cancel)).catch(() => null), settled]);
      if (answer === 'inactive') { prompts.set(target.botId, recent); return no('app_inactive'); }
      if (cancel.aborted || answer === null || answer === undefined) {
        if (!signal?.aborted) denied.set(key, now() + denyMs); // a withdrawn request (Stop) gets no cooldown, but it counts toward the backoff
        negative(key, target.botId);
        return no('no_answer');
      }
      if (answer !== true) { denied.set(key, now() + denyMs); negative(key, target.botId); return no('denied'); }
      streaks.delete(key); penalty.delete(target.botId);

      // The same checks again, now that the user has answered: this is what the password is typed into.
      seen = read(target);
      if (seen.why) return no(seen.why);
      if (seen.origin !== bound) return no('origin_mismatch');
      const changed = unclean(seen.tab, bound);
      if (changed) return no(changed);
      const taken = await workerRefusal(seen.tab);
      if (taken) return no(taken);
      const again = read(target); // the worker check was a round trip to the page: the page must not have moved during it
      if (again.why) return no(again.why);
      if (again.origin !== bound) return no('origin_mismatch');
      target.filled = true;
      keep = true; // the script is about to run: assume it typed, unless it says it did not
      let raw;
      try { raw = pageJson(await run(seen.tab, expression)); } catch { return no('page_failed'); }
      if (isPlainObject(raw) && raw.refused === 'origin_changed') { keep = false; return ok({ result: JSON.stringify({ refused: 'origin_changed', found: originOf(seen.wc.getURL()) }) }); }
      if (isPlainObject(raw) && Number.isSafeInteger(raw.filled) && raw.filled >= 0) {
        keep = raw.filled > 0; target.typed = keep;
        return ok({ result: JSON.stringify({ filled: Math.min(raw.filled, 1) }) });
      }
      return no('page_failed');
    } finally {
      asking = false;
      if (keep) lock.markFilled(tab); else lock.release(tab);
    }
  }

  async function evaluate(v, { storedId, signal }) {
    const target = lookup(v, storedId);
    if (!target) return no(typeof v.target === 'string' && typeof v.expression === 'string' ? 'unknown_target' : 'bad_request');
    const expression = v.expression;
    if (typeof expression !== 'string' || !expression || expression.length > MAX_EXPRESSION) return no('bad_request');
    if (expression === 'window.location.href') {
      const seen = read(target);
      return seen.why ? no(seen.why) : ok({ result: `${seen.origin}/` });
    }
    const inspection = matchInspect(expression);
    if (inspection) return inspect(target, expression, inspection);
    const script = matchFill(expression);
    if (script) {
      try { return await fill(target, expression, script, signal); } finally {
        for (const f of script.fills) f.value = ''; script.fills.length = 0;
        if (!target.typed && target.nonce === script.nonce) await clearStamps(target);
      }
    }
    return no('bad_request', 'That script is not one the vault runs in a page.');
  }

  // One answer per request: `{value}` is the JSON text Hermes's `preview.act` reply carries.
  async function handle({ storedId, sessionId, params, signal } = {}) {
    const v = isPlainObject(params) && params.action === 'vault' && isPlainObject(params.vault) ? params.vault : null;
    const op = v && typeof v.operation === 'string' ? v.operation : 'invalid';
    let out;
    try {
      if (!v) out = no('bad_request');
      else if (op === 'open') out = open({ storedId, sessionId });
      else if (op === 'evaluate') out = await evaluate(v, { storedId, signal });
      else if (op === 'close') {
        const target = lookup(v, storedId);
        if (target) { targets.delete(v.target); await clearStamps(target); }
        out = target ? ok() : no('unknown_target');
      } else out = no(typeof v.operation === 'string' ? 'unsupported' : 'bad_request', `The vault operation ${NOT_YET}.`);
    } catch {
      out = no('page_failed');
    } finally {
      if (v) v.expression = '';
    }
    log('vault.step', { op, ok: out.success, ...(out.success ? {} : { reason: out.error_type }) });
    return { value: JSON.stringify(out) };
  }

  return { handle, size: () => ({ targets: targets.size, denied: denied.size }) };
}

module.exports = { createVaultFill, isVaultRequest, NOT_YET };
