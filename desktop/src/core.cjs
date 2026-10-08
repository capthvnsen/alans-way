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
  'Page.addScriptToEvaluateOnNewDocument', 'Page.removeScriptToEvaluateOnNewDocument',
  'Page.setInterceptFileChooserDialog', 'Page.handleFileChooser', 'Page.setDownloadBehavior', 'Page.getCookies',
  'Page.navigateToHistoryEntry',
  'DOM.setFileInputFiles',
  'Network.getCookies', 'Network.getAllCookies', 'Network.setCookie', 'Network.setCookies', 'Network.deleteCookies', 'Storage.clearCookies',
  'Network.clearBrowserCookies', 'Network.clearBrowserCache', 'Network.loadNetworkResource',
  'Network.setRequestInterception', 'Network.continueInterceptedRequest',
]);
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
// [user@]host (or an ~/.ssh/config alias) is accepted.
function isSshTarget(value) {
  return typeof value === 'string' && value.length <= 200 && /^(?:[A-Za-z0-9][A-Za-z0-9._-]*@)?[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
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

function requireActor(tab, botId, epoch, mutate = false, overseer = false) {
  if (!botId || typeof botId !== 'string' || botId.length > 100) throw Object.assign(new Error('X-Hermes-Bot is required.'), { status: 400 });
  if (!overseer && tab.botId !== botId && !(tab.allowedBots || []).includes(botId)) {
    throw Object.assign(new Error('This tab belongs to a different bot.'), { status: 403 });
  }
  if (mutate && tab.controller !== 'agent') throw Object.assign(new Error('human_has_control'), { status: 409 });
  if (mutate && epoch !== tab.epoch) throw Object.assign(new Error('stale_control_epoch: read the tab state and retry after a fresh snapshot.'), { status: 409 });
}

// A handoff source stays human-only so the task has one live copy, and a
// destination that did not verify (login redirect, lost drafts) waits for the
// human. Humans clear either by giving the tab to an agent themselves.
function requireAgentClaim(tab) {
  const h = tab.handoff;
  if (h && (h.phase === 'handed_off' || (h.phase === 'review_required' && h.verification !== 'ready')))
    throw Object.assign(new Error(h.phase === 'handed_off'
      ? `handoff_source: this task moved to the ${h.destinationHost || 'other'} tab ${h.destinationTabId || ''}. Continue there; only the human can reopen this tab for agents.`
      : 'handoff_review_required: the handed-off page needs the human to check it (for example a login) before an agent can take control.'), { status: 409 });
  // An explicit human takeover (Take over, human navigation, extension page)
  // seals the tab until the human hands it back in the UI. A bot's own
  // release or the idle-expiry clock stays retakeable.
  if (tab.controller === 'human' && tab.humanLock)
    throw Object.assign(new Error('human_has_control: the human took this tab over; only they can hand it back.'), { status: 409 });
}
function reviewedHandoff(handoff) {
  return handoff && handoff.phase !== 'reviewed' ? { ...handoff, phase: 'reviewed', reviewedAt: Date.now() } : handoff;
}

function requireAgentRead(tab) {
  if (tab.controller === 'human') throw Object.assign(new Error('Tab is under human control.'), { status: 409 });
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

// The VPS browser host stays on the script it loaded. A replaced file should
// restart only while nothing is in flight, so a click is not cut off.
function hostShouldReload(mtime, started, inFlight) {
  return inFlight === 0 && Number(mtime) > Number(started);
}

module.exports = { normalizeUrl, agentPageUrl, agentHostBarrier, faviconTarget, redactTabForBot, cdpMethodError, parseRemoteUrl, isSshTarget, normalizeHost, requireActor, requireAgentRead, requireAgentClaim, reviewedHandoff, isAuthorized, sanitizeBots, retargetMissingTab, needsContinuedEpoch, hostShouldReload, followVmRemoteUrl };
