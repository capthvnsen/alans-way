const { isTailnetHost, tailnetUrl } = require('./tailnet.cjs');
const crypto = require('node:crypto');

function normalizeUrl(value) {
  const input = String(value || '').trim();
  if (!input) return 'about:blank';
  if (input === 'about:blank') return input;
  let url;
  if (/^https?:\/\//i.test(input)) url = new URL(input);
  else if (/^[\w.-]+(?::\d+)?(?:\/.*)?$/.test(input) && (input.includes('.') || /^localhost(?::|$)/.test(input))) {
    url = new URL(`http${/^localhost(?::|$)|^127\./.test(input) ? '' : 's'}://${input}`);
  } else {
    if (/^[a-z][a-z\d+.-]*:/i.test(input)) throw new Error('Only http and https pages are supported.');
    url = new URL(`https://www.google.com/search?q=${encodeURIComponent(input)}`);
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid browser URL.');
  return url.href;
}

// Agent-initiated navigations never open loopback, link-local or cloud
// metadata addresses: those expose services that trust the machine itself,
// and the bot would read them through the Mac's network position. Private
// LAN ranges stay reachable (people run dev servers and home tools there).
// The URL parser normalizes numeric, hex and shorthand IP forms before this
// check. HERMES_WORKSPACE_ALLOW_LOOPBACK=1 lifts only the loopback part, for
// test fixtures that serve pages from 127.0.0.1.
function ipv4Bytes(hostname) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!match) return null;
  const bytes = match.slice(1).map(Number);
  return bytes.every((byte) => byte <= 255) ? bytes : null;
}
function agentHostBarrier(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.+$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return 'loopback';
  let v4 = ipv4Bytes(host);
  if (host.startsWith('[') && host.endsWith(']')) {
    const inner = host.slice(1, -1);
    if (inner === '::1') return 'loopback';
    if (inner === '::') return 'unspecified';
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(inner);
    if (mapped) {
      const hi = parseInt(mapped[1], 16), lo = parseInt(mapped[2], 16);
      v4 = [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
    } else if ((parseInt(inner.split(':', 1)[0] || '0', 16) & 0xffc0) === 0xfe80) return 'link-local';
  }
  if (v4) {
    if (v4[0] === 127) return 'loopback';
    if (v4[0] === 0) return 'unspecified';
    if (v4[0] === 169 && v4[1] === 254) return 'link-local';
  }
  return '';
}
function agentPageUrl(value) {
  const url = normalizeUrl(value);
  if (url === 'about:blank') return url;
  const barrier = agentHostBarrier(new URL(url).hostname);
  if (!barrier || (barrier === 'loopback' && process.env.HERMES_WORKSPACE_ALLOW_LOOPBACK === '1')) return url;
  throw new Error('Agents cannot open loopback, link-local or metadata addresses.');
}

// A page can name any favicon URL and bots read favicons, so only
// same-origin icons may be fetched — anything else would be a credentialed
// SSRF/exfil channel through the browser session.
function faviconTarget(pageUrlValue, iconUrl) {
  try {
    const icon = new URL(String(iconUrl), String(pageUrlValue));
    const page = new URL(String(pageUrlValue));
    if (!['http:', 'https:'].includes(icon.protocol) || icon.origin !== page.origin) return '';
    return icon.href;
  } catch { return ''; }
}

// A page names every candidate icon; the fetch queue keeps the same-origin
// http(s) ones in the page's own order so a cross-origin or dead first
// candidate does not sink the tab's icon. Non-URL candidates (an inline
// data: icon Chromium already decoded) ride along as the last fallback.
// The queue is capped: fetches run serially, so a page naming dozens of
// icons cannot stall the icon or hang the resolver.
function faviconQueue(pageUrlValue, favicons) {
  const targets = [];
  for (const item of favicons) {
    if (targets.length >= 6) break;
    if (!/^https?:\/\//i.test(item)) continue;
    const target = faviconTarget(pageUrlValue, item);
    if (target && !targets.includes(target)) targets.push(target);
  }
  const inline = favicons.find((item) => item && item !== 'data:,' && !/^https?:\/\//i.test(item)) || '';
  return { targets, inline };
}

// While the human holds a tab, bots may learn that it exists and who holds
// it — not where the human is. Keep metadata structural: origin-only URL,
// no title, icon or handoff note.
function redactTabForBot(info) {
  if (!info || info.controller !== 'human') return info;
  let origin = '';
  try { const url = new URL(info.url); if (url.protocol === 'http:' || url.protocol === 'https:') origin = url.origin; } catch {}
  const handoff = info.handoff && typeof info.handoff === 'object' ? { ...info.handoff, note: '' } : info.handoff;
  return { ...info, url: origin, title: '', favicon: '', handoff };
}

const CDP_METHOD_RE = /^(Page|Runtime|Input|Emulation|Network|DOM|DOMSnapshot|Accessibility|CSS|Log)\.[a-zA-Z]+$/;
// These in-domain methods still reach outside the page: cookie/storage
// jars, file pickers and downloads, browser-privileged fetches, request
// interception and persistent script injection all stay denied. Fetch and
// Storage are excluded from the allowed domains entirely.
const CDP_BLOCKED = new Set([
  'Page.addScriptToEvaluateOnNewDocument', 'Page.removeScriptToEvaluateOnNewDocument', 'Page.addScriptToEvaluateOnLoad', 'Network.replayXHR',
  'Page.setInterceptFileChooserDialog', 'Page.handleFileChooser', 'Page.setDownloadBehavior', 'Page.getCookies',
  'Page.navigateToHistoryEntry',
  'DOM.setFileInputFiles',
  'Network.getCookies', 'Network.getAllCookies', 'Network.setCookie', 'Network.setCookies', 'Network.deleteCookies', 'Storage.clearCookies',
  'Network.clearBrowserCookies', 'Network.clearBrowserCache', 'Network.loadNetworkResource',
  'Network.setRequestInterception', 'Network.continueInterceptedRequest',
]);
// While a challenge is on the page only these run: reads and domain toggles,
// plus leaving the page. Everything else can script, write the DOM or send
// input, and a new method stays refused until it is listed here. A navigate
// with a frameId could replace a challenge's own frame, so only the
// top-frame form (no frameId) leaves the page.
const CDP_CHALLENGE_SAFE = new Set([
  'Page.enable', 'Page.disable', 'Page.navigate', 'Page.stopLoading', 'Page.captureScreenshot', 'Page.getLayoutMetrics', 'Page.getFrameTree', 'Page.getNavigationHistory',
  'DOM.enable', 'DOM.disable', 'DOM.getDocument', 'DOM.getFlattenedDocument', 'DOM.querySelector', 'DOM.querySelectorAll', 'DOM.describeNode', 'DOM.getBoxModel', 'DOM.getContentQuads', 'DOM.getOuterHTML', 'DOM.getAttributes', 'DOM.getNodeForLocation',
  'DOMSnapshot.enable', 'DOMSnapshot.disable', 'DOMSnapshot.captureSnapshot',
  'Accessibility.enable', 'Accessibility.disable', 'Accessibility.getFullAXTree', 'Accessibility.getPartialAXTree', 'Accessibility.queryAXTree', 'Accessibility.getRootAXNode', 'Accessibility.getChildAXNodes',
  'CSS.enable', 'CSS.disable', 'CSS.getComputedStyleForNode', 'CSS.getMatchedStylesForNode', 'CSS.getInlineStylesForNode',
  'Network.enable', 'Network.disable', 'Log.enable', 'Log.disable',
]);
const cdpChallengeSafe = (method, params = {}) => CDP_CHALLENGE_SAFE.has(method) && !(method === 'Page.navigate' && params.frameId !== undefined);
function cdpMethodError(method) {
  if (CDP_BLOCKED.has(method)) return `cdp method ${method} is not available to agents.`;
  if (!CDP_METHOD_RE.test(method)) return 'Unsupported CDP method. Allowed domains: Page, Runtime, Input, Emulation, Network, DOM, DOMSnapshot, Accessibility, CSS, Log.';
  return '';
}

function parseRemoteUrl(value) {
  if (!value) return '';
  const url = new URL(String(value));
  if (!['https:', 'http:', 'wss:', 'ws:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Use an http(s) noVNC URL or ws(s) desktop connection.');
  }
  if (!tailnetUrl(url)) throw new Error('Use a literal Tailscale IP address for the desktop connection.');
  if (url.protocol === 'https:' || url.protocol === 'http:') {
    const remotePath = url.searchParams.get('path') || 'websockify';
    const prefix = url.pathname.endsWith('/') ? url.pathname : url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1);
    url.pathname = remotePath.startsWith('/') ? remotePath : `${prefix}${remotePath}`;
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.search = '';
  }
  url.hash = '';
  return url.href;
}

// The noVNC viewer sits on the agent VM, so its URL derives from the SSH host:
// when the host moves, an empty remoteUrl or one still on the old host follows.
// A remoteUrl pointing anywhere else is the user's own and is left alone.
function followVmRemoteUrl(previousSshHost, sshHost, remoteUrl) {
  const hostOf = (target) => String(target || '').split('@').pop().trim().replace(/^\[|\]$/g, '');
  const previous = hostOf(previousSshHost).toLowerCase();
  const host = hostOf(sshHost);
  if (!host || host.toLowerCase() === previous) return '';
  let current = '';
  try { current = new URL(remoteUrl).hostname.replace(/^\[|\]$/g, ''); } catch {}
  if (current && current !== previous) return '';
  return `http://${host.includes(':') ? `[${host}]` : host}:6080/vnc.html`;
}

// Saved SSH addresses are interpolated into a remote shell command, so only
// [user@]Tailscale-IP is accepted; DNS and SSH aliases cannot redirect it.
function isSshTarget(value) {
  return typeof value === 'string' && value.length <= 200 && /^(?:[A-Za-z0-9][A-Za-z0-9._-]*@)?(?:[0-9.]+|\[[0-9a-fA-F:]+\])$/.test(value) && isTailnetHost(value);
}

// Which machine a browser tab runs on: 'computer' is the user's own machine,
// 'vm' is the connector host's browser. Unknown values resolve to undefined;
// the plugin router keeps the same alias table.
const HOST_ALIASES = {
  computer: 'computer', mac: 'computer', windows: 'computer', linux: 'computer', local: 'computer', pc: 'computer',
  vm: 'vm', vps: 'vm', remote: 'vm', server: 'vm',
};
function normalizeHost(value) {
  if (value === undefined || value === null) return undefined;
  return HOST_ALIASES[String(value).trim().toLowerCase()];
}

// A bot releases a tab with a reason when only the human can go on (a
// CAPTCHA, a login, card details). The tab then waits for the human: bots
// cannot claim it until the human gives it back, or until HANDBACK_MS
// passes and it becomes a normal release. After the give-back the bot sees
// human_returned until it claims the tab again.
const HANDBACK_REASONS = ['captcha', 'login', 'two_factor', 'payment_details', 'review', 'other'];
const HANDBACK_MS = 30 * 60000;
function handbackRequest(body) {
  if (!body || body.reason === undefined) return null;
  if (!HANDBACK_REASONS.includes(body.reason)) throw Object.assign(new Error(`reason must be one of ${HANDBACK_REASONS.join(', ')}.`), { status: 400 });
  return { reason: body.reason, note: String(body.note ?? '').replace(/\s+/g, ' ').trim().slice(0, 140) };
}
function liveHandback(tab, now = Date.now()) {
  const h = tab.handback;
  return h && !(h.state === 'awaiting_human' && now - h.since > HANDBACK_MS) ? h : null;
}
// The handback a tab carries after its controller changes. tab.controller is
// still the old controller here.
function nextHandback(tab, controller, source, request, now = Date.now()) {
  const current = liveHandback(tab, now);
  const awaiting = current && current.state === 'awaiting_human';
  if (controller === 'human') {
    // A tab the human already took over needs no banner from the bot.
    if (source === 'agent' && request && !(tab.controller === 'human' && tab.humanLock)) return { ...request, state: 'awaiting_human', botId: tab.botId, since: awaiting ? current.since : now };
    return tab.controller === 'human' ? current : null;
  }
  return source === 'human' && awaiting ? { ...current, state: 'human_returned', returnedAt: now } : null;
}
// Challenges (CAPTCHAs, bot checks) a tab met, per origin: one counts when the
// last read saw none there. Two inside ten minutes tell the bot to stop
// retrying that site.
const CHALLENGE_WINDOW_MS = 10 * 60000;
const CHALLENGE_NAMES = { recaptcha: 'reCAPTCHA', hcaptcha: 'hCaptcha', turnstile: 'Cloudflare check', cloudflare: 'Cloudflare check', google_sorry: 'Google "unusual traffic" check', arkose: 'Arkose puzzle' };
function challengeReply(tab, url, challenge, now = Date.now()) {
  const log = tab.challengeLog ||= { on: '', seen: {} };
  if (!challenge) { log.on = ''; return undefined; }
  let origin = '', host = 'This site';
  try { const u = new URL(url); origin = u.origin; host = u.hostname || host; } catch {}
  for (const key of Object.keys(log.seen)) if (log.seen[key].every((at) => now - at >= CHALLENGE_WINDOW_MS)) delete log.seen[key];
  const times = (log.seen[origin] || []).filter((at) => now - at < CHALLENGE_WINDOW_MS);
  if (log.on !== origin) times.push(now);
  log.seen[origin] = times;
  log.on = origin;
  const reply = { kind: challenge.kind, blocking: challenge.blocking === true };
  if (times.length >= 2) Object.assign(reply, { backOff: true, advice: `${host} has challenged ${times.length} times in 10 minutes. Stop retrying it and use another source.` });
  return reply;
}
// The N2 release the host makes itself when a blocking challenge lands on a
// bot's tab. The note names the site and the kind of check.
function captchaHandback(url, challenge) {
  let host = 'this site';
  try { host = new URL(url).hostname || host; } catch {}
  const note = `Solve the ${CHALLENGE_NAMES[challenge.kind] || 'CAPTCHA'} on ${host}. The tab goes back to the agent once it clears.`;
  // The back-off rides on the handback too, so a bot that gets the tab back still hears it.
  return { reason: 'captcha', note: note.slice(0, 140), auto: true, challenge: challenge.kind, ...(challenge.backOff ? { backOff: true, advice: challenge.advice } : {}) };
}
// One step of the watch on a tab handed over for a CAPTCHA, fed a page probe
// (challengeProbeExpression) about once a second. It hands the tab back once
// a challenge it saw is gone (a navigation, or the widget removed or solved)
// on two reads in a row, the page is not loading, and the focused field held
// still between them (the person is not typing). resume says to give it back.
function captchaWatchStep(watch, probe) {
  if (!probe || probe.loading) return { ...watch, clear: 0, resume: false };
  if (probe.challenge) return { seen: true, clear: 0, typing: probe.typing, resume: false };
  // A focused field with text in it is a person mid-form, typing or not.
  const filled = /^[1-9]/.test(probe.typing || '');
  const clear = watch.seen && !filled && probe.typing === watch.typing ? watch.clear + 1 : 0;
  return { seen: watch.seen, clear, typing: probe.typing, resume: clear >= CAPTCHA_QUIET_READS };
}
// The watch reads once a second: about six quiet seconds before the hand-back.
const CAPTCHA_QUIET_READS = 6;
// The live desktop viewer a person opens to solve a challenge on the VM: an
// http(s) address with no credentials or fragment (noVNC also reads a
// password from the fragment), keeping only noVNC's harmless settings. A
// value that could carry a nested address or query (a token tucked into
// path) is dropped, and path may only name noVNC's own websockify endpoint.
const VIEWER_PARAMS = new Set(['autoconnect', 'reconnect', 'reconnect_delay', 'resize', 'quality', 'compression', 'show_dot', 'shared', 'view_only', 'view_clip', 'path', 'host', 'port', 'encrypt', 'bell', 'logging']);
function viewerUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    if (!tailnetUrl(url)) return '';
    url.username = ''; url.password = ''; url.hash = '';
    for (const [key, value] of [...url.searchParams]) {
      if ((key === 'host' && !isTailnetHost(value)) || !VIEWER_PARAMS.has(key) || /[?=@]|\/\//.test(value) || (key === 'path' && value !== 'websockify')) url.searchParams.delete(key);
    }
    return url.href;
  } catch { return ''; }
}
function awaitingHumanError(h) {
  return Object.assign(new Error(`awaiting_human: this tab was handed to the human (${h.reason}). Wait until they give it back; read the tab state later.`), { status: 409 });
}

function requireActor(tab, botId, epoch, mutate = false, overseer = false, now = Date.now()) {
  if (!botId || typeof botId !== 'string' || botId.length > 100) throw Object.assign(new Error('X-Hermes-Bot is required.'), { status: 400 });
  if (!overseer && tab.botId !== botId && !(tab.allowedBots || []).includes(botId)) {
    throw Object.assign(new Error('This tab belongs to a different bot.'), { status: 403 });
  }
  if (!mutate) return;
  const h = liveHandback(tab, now);
  if (tab.controller !== 'agent') throw h && h.state === 'awaiting_human' ? awaitingHumanError(h) : Object.assign(new Error('human_has_control'), { status: 409 });
  if (epoch !== tab.epoch) throw Object.assign(new Error(h && h.state === 'human_returned'
    ? 'human_returned: the human finished and gave this tab back. Read the tab state for its fresh epoch and current page.'
    : 'stale_control_epoch: read the tab state and retry after a fresh snapshot.'), { status: 409 });
}

// A handoff source stays human-only so the task has one live copy, and a
// destination that did not verify (login redirect, lost drafts) waits for the
// human. Humans clear either by giving the tab to an agent themselves.
// autoTakeover (a Setting, on by default) lets a bot take back a tab the human
// took over; a tab the bot handed over or one being recorded stays theirs.
function requireAgentClaim(tab, now = Date.now(), { autoTakeover = false, recording = false } = {}) {
  const h = tab.handoff;
  if (h && (h.phase === 'handed_off' || (h.phase === 'review_required' && h.verification !== 'ready')))
    throw Object.assign(new Error(h.phase === 'handed_off'
      ? `handoff_source: this task moved to the ${h.destinationHost || 'other'} tab ${h.destinationTabId || ''}. Continue there; only the human can reopen this tab for agents.`
      : 'handoff_review_required: the handed-off page needs the human to check it (for example a login) before an agent can take control.'), { status: 409 });
  // An explicit human takeover (Take over, human navigation, extension page)
  // seals the tab until the human hands it back in the UI. A bot's own
  // release or the idle-expiry clock stays retakeable.
  const handback = liveHandback(tab, now);
  if (handback && handback.state === 'awaiting_human') throw awaitingHumanError(handback);
  if (recording)
    throw Object.assign(new Error('recording_in_progress: the human is recording a task on this tab. Open your own tab, or read the tab state later.'), { status: 409 });
  if (tab.controller === 'human' && tab.humanLock && !autoTakeover)
    throw Object.assign(new Error('human_has_control: the human took this tab over; only they can hand it back.'), { status: 409 });
  if (tab.controller === 'human' && autoTakeover && tab.tookBackUntil > now)
    throw Object.assign(new Error(`human_took_back: the human pressed Take back, so leave this tab to them for ${Math.ceil((tab.tookBackUntil - now) / 1000)}s. Open your own tab, or tell them what you need.`), { status: 409 });
}
// Input in the last 3 seconds holds a takeover until the human pauses, for
// 10 seconds at most, so a bot never yanks the page mid-keystroke.
const TAKEOVER_GRACE_MS = 3000, TAKEOVER_MAX_MS = 10000;
function takeoverDelay(lastInput, started, now = Date.now()) {
  return Math.max(0, Math.min((lastInput || 0) + TAKEOVER_GRACE_MS, started + TAKEOVER_MAX_MS) - now);
}
// A local agent tab the VM resumed from the mirror while this computer was
// away: the same retired-source record a manual Move leaves, or null when the
// tab is no longer the agent's copy to retire.
function continuedOnVm(tab, destinationTabId, now = Date.now()) {
  // Once retired for that VM tab, a human who gave the tab back to agents decided.
  if (!tab || tab.controller !== 'agent' || tab.handoff?.phase === 'handed_off' || tab.handoff?.destinationTabId === destinationTabId || !/^[\w-]{1,100}$/.test(String(destinationTabId))) return null;
  return { id: crypto.randomUUID(), phase: 'handed_off', sourceHost: 'mac', sourceTabId: tab.id, destinationHost: 'vps', destinationTabId, createdAt: now, automatic: true };
}
function reviewedHandoff(handoff) {
  return handoff && handoff.phase !== 'reviewed' ? { ...handoff, phase: 'reviewed', reviewedAt: Date.now() } : handoff;
}

function requireAgentRead(tab, now = Date.now()) {
  if (tab.controller !== 'human') return;
  const handback = liveHandback(tab, now);
  if (handback && handback.state === 'awaiting_human') throw awaitingHumanError(handback);
  throw Object.assign(new Error('Tab is under human control. Claim it to take it back, then read.'), { status: 409 });
}

function isAuthorized(header, token) {
  const match = /^Bearer (.+)$/i.exec(String(header || ''));
  if (!match) return false;
  const input = Buffer.from(match[1]);
  const expected = Buffer.from(token);
  return input.length === expected.length && crypto.timingSafeEqual(input, expected);
}

function sanitizeBots(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((bot) => bot && /^\d{1,20}$/.test(String(bot.id)) && bot.isBot === true).slice(0, 1000).map((bot) => ({
    id: String(bot.id), isBot: true,
    name: String(bot.name || 'Telegram bot').slice(0, 100),
    username: String(bot.username || '').replace(/[^\w]/g, '').slice(0, 40),
    preview: String(bot.preview || '').slice(0, 120),
    unread: Math.max(0, Math.min(9999, Number(bot.unread) || 0)),
    lastId: Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Number(bot.lastId) || 0)),
    avatar: typeof bot.avatar === 'string' && /^data:image\/(png|jpeg|webp);base64,/.test(bot.avatar) && bot.avatar.length < 150000 ? bot.avatar : '',
  }));
}

// A laptop-close leaves the model holding a Mac tab id. Carry the read or
// action onto the VPS tab the connector already opened. page.map (old tab id
// to VPS tab id, from a mirror restore) retargets each id on its own; without
// a map every missing id falls back to the single continued tab. Never carry
// a close: that would shut the page the task just moved to.
function retargetMissingTab(endpoint, method, page) {
  if (!page || method === 'DELETE') return null;
  const match = /^\/v1\/tabs\/([^/?]+)(.*)$/.exec(String(endpoint || ''));
  if (!match) return null;
  let requested = match[1];
  try { requested = decodeURIComponent(requested); } catch { return null; }
  const mapped = page.map && Object.keys(page.map).length > 0;
  const target = mapped ? (Object.hasOwn(page.map, requested) ? page.map[requested] : '') : page.tabId;
  if (!target || requested === target) return null;
  return '/v1/tabs/' + encodeURIComponent(target) + match[2];
}

// The new VPS tab starts at its own control epoch. A Mac epoch must not be
// reused for the action that just moved.
function needsContinuedEpoch(message, method) {
  return method !== 'GET' && method !== 'DELETE' && /stale_control_epoch/i.test(String(message || ''));
}

// A page eval rejection arrives as a bare string, not an Error; serialize
// the page's own message so the reply never carries an empty error body.
function errorMessage(error) {
  const message = error && error.message ? error.message : error;
  return message ? String(message) : 'Request failed.';
}

// An agent tab answers a JS dialog at once: an alert or the leave-page prompt
// is accepted, and a confirm or prompt guards a decision, so it is dismissed
// unless the action that raised it said how to answer (dialog: {accept, text}).
function dialogAnswer(value) {
  if (!value || typeof value !== 'object' || typeof value.accept !== 'boolean' || (value.text !== undefined && (typeof value.text !== 'string' || value.text.length > 1000)))
    throw Object.assign(new Error('dialog must be {accept: true or false, text?: the prompt answer up to 1,000 characters}.'), { status: 400 });
  return { accept: value.accept, ...(typeof value.text === 'string' ? { text: value.text } : {}) };
}
function answerDialog(type, message, answer) {
  const decided = type === 'confirm' || type === 'prompt';
  const accepted = decided ? !!(answer && answer.accept) : true;
  const record = { type, message: String(message || '').slice(0, 500), accepted };
  if (decided && !answer) record.note = `Dismissed. To accept it, repeat the action with dialog: {accept: true${type === 'prompt' ? ', text: "<answer>"' : ''}}.`;
  return { record, params: { accept: accepted, ...(accepted && type === 'prompt' && answer && answer.text !== undefined ? { promptText: answer.text } : {}) } };
}

// The VPS browser host stays on the script it loaded. A replaced file should
// restart only while nothing is in flight, so a click is not cut off.
function hostShouldReload(mtime, started, inFlight) {
  return inFlight === 0 && Number(mtime) > Number(started);
}

module.exports = { normalizeUrl, agentPageUrl, agentHostBarrier, faviconTarget, faviconQueue, redactTabForBot, cdpMethodError, parseRemoteUrl, isSshTarget, normalizeHost, requireActor, requireAgentRead, requireAgentClaim, takeoverDelay, reviewedHandoff, continuedOnVm, isAuthorized, sanitizeBots, retargetMissingTab, needsContinuedEpoch, hostShouldReload, errorMessage, followVmRemoteUrl, HANDBACK_REASONS, HANDBACK_MS, handbackRequest, liveHandback, nextHandback, dialogAnswer, answerDialog, challengeReply, captchaHandback, captchaWatchStep, viewerUrl, cdpChallengeSafe };
