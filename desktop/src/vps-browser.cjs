const { spawn, execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isSshTarget } = require('./core.cjs');
const { posixCommand } = require('./remote-shell.cjs');
// A double-quoted path parses the same in sh, cmd.exe and PowerShell (the
// shells a VM's sshd may start), so the allowlist is what keeps it inert: it has
// no quote, $, backtick, %, ; or & to act on, and cannot end in a backslash
// that would escape the closing quote.
const SCRIPT_PATH = /^(\/|[A-Za-z]:[\\/])[A-Za-z0-9 _.:\\/~-]*[A-Za-z0-9 _.:/~-]$/;
const checkScriptPath = (value) => SCRIPT_PATH.test(value) ? '' : 'Invalid VPS browser script path. Use an absolute path of letters, digits, spaces and _ . : \\ / ~ - only.';
// sudo is POSIX-only, so a Windows drive path never gets it.
const remoteCommand = (cfg) => {
  const windows = /^[A-Za-z]:/.test(cfg.scriptPath);
  if (cfg.sudo) throw new Error('Use the separate broker SSH user; generic sudo request helpers are refused.');
  const command = 'node "' + cfg.scriptPath + '" request';
  return windows ? command : posixCommand(command);
};
// Anything outside ASCII is escaped so a shell that re-encodes stdin or stdout (PowerShell) cannot corrupt it.
const asciiJson = (value) => JSON.stringify(value).replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
// Unix sockets cap at 104 bytes and ssh adds a 17 byte suffix while binding, so
// the path is a short hash in a private directory (a shared /tmp would let
// another local user plant a socket at a guessable name).
function controlPath(host) {
  const base = os.tmpdir().length > 60 ? '/tmp' : os.tmpdir();
  const dir = path.join(base, 'hw-tailnet-ssh-' + (process.getuid ? process.getuid() : 'u'));
  try {
    fs.mkdirSync(dir, { mode: 0o700, recursive: true });
    if (process.getuid && fs.statSync(dir).uid !== process.getuid()) return '';
  } catch { return ''; }
  return path.join(dir, crypto.createHash('sha1').update(host).digest('hex').slice(0, 10));
}
// Keepalives drop a dead link in about 10s instead of the OS TCP timeout.
// The refresh and every agent call share one multiplexed connection, so the
// 5s poll stops paying a full handshake and remote start each time.
function sshArgs(host, command, platform = process.platform) {
  const socket = platform === 'win32' ? '' : controlPath(host);
  return [...SSH_OPTIONS, '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=6',
    '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2',
    ...(socket ? ['-o', 'ControlMaster=auto', '-o', 'ControlPersist=120', '-o', 'ControlPath=' + socket] : []),
    host, command];
}
// Chromium cookies as the VM's Network.setCookies wants them. Electron marks
// host-only cookies by a dotless domain, which is also what CDP expects.
const SAME_SITE = { no_restriction: 'None', lax: 'Lax', strict: 'Strict' };
function toCdpCookie(c) {
  const session = c.session === true || !(c.expirationDate > 0);
  return { name: c.name, value: c.value, domain: c.domain, path: c.path || '/', expires: session ? -1 : c.expirationDate,
    httpOnly: c.httpOnly === true, secure: c.secure === true, session, ...(SAME_SITE[c.sameSite] ? { sameSite: SAME_SITE[c.sameSite] } : {}) };
}
// The reverse, for a page moved back from the VM: only cookies the page's own
// URL would send, so a VM cannot plant sign-ins for other sites on this
// computer. Partitioned (CHIPS) cookies are left out; Electron cannot set them.
const ELECTRON_SAME_SITE = { None: 'no_restriction', Lax: 'lax', Strict: 'strict' };
function toElectronCookies(cookies, pageUrl) {
  let page;
  try { page = new URL(pageUrl); } catch { return []; }
  if (!/^https?:$/.test(page.protocol)) return [];
  const host = page.hostname.toLowerCase();
  return (Array.isArray(cookies) ? cookies : []).filter((c) => {
    if (!c || typeof c.name !== 'string' || typeof c.value !== 'string' || c.name.length > 4096 || c.value.length > 8192 || c.partitionKey) return false;
    const domain = String(c.domain || '').toLowerCase();
    const bare = domain.replace(/^\./, '');
    return !!bare && (host === bare || (domain.startsWith('.') && host.endsWith('.' + bare))) && (c.secure !== true || page.protocol === 'https:');
  }).slice(0, 150).map((c) => {
    const session = c.session === true || !(Number(c.expires) > 0);
    const path = typeof c.path === 'string' && c.path.startsWith('/') ? c.path : '/';
    return { url: `${page.protocol}//${host}${path}`, name: c.name, value: c.value, path, secure: c.secure === true, httpOnly: c.httpOnly === true,
      ...(String(c.domain).startsWith('.') ? { domain: c.domain } : {}), ...(session ? {} : { expirationDate: Number(c.expires) }),
      ...(ELECTRON_SAME_SITE[c.sameSite] ? { sameSite: ELECTRON_SAME_SITE[c.sameSite] } : {}) };
  });
}
// Sign-in cookies only travel to a VM reached over the tailnet: a Tailscale
// address (100.64.0.0/10, fd7a:115c:a1e0::/48). SSH config aliases and DNS
// names are refused; callers may still inspect ssh -G for diagnostics.
const { isTailnetHost, SSH_OPTIONS } = require('./tailnet.cjs');
const sshResolvedHostname = (configText) => (/^hostname\s+(\S+)\s*$/m.exec(String(configText || '')) || [])[1] || '';
// Resolves the hostname ssh will actually dial for sshHost; '' when ssh -G fails.
function resolveSshHostname(sshHost, run = (args) => new Promise((resolve) => {
  execFile('ssh', args, { timeout: 3000 }, (error, stdout) => resolve(error ? '' : stdout));
})) {
  if (!isSshTarget(sshHost)) return Promise.resolve('');
  return run([...SSH_OPTIONS, '-G', sshHost]).then(sshResolvedHostname);
}
// collect() resolves to Map<bot, tabs[]> for the agent-controlled tabs now,
// or null while there is nothing to mirror to (VM not configured or offline).
// Changed tabs are pushed at once; unchanged tabs refresh hourly before the
// host's 24h expiry. A bot that lost all its agent tabs is cleared once so a
// stale mirror cannot resurrect them. On the first
// successful connect every bot in bots() is cleared the same way, which also
// wipes mirrors left on the VM by an earlier app session.
// An unchanged mirror is still resent every refreshMs so the VM's 24 hour
// freshness check never expires a long-running task.
function createMirrorPusher({ collect, push, bots = () => [], refreshMs = 3600000, now = Date.now }) {
  const sent = new Map(), sentAt = new Map();
  let busy = false, pendingClear;
  return async function run() {
    if (busy) return;
    busy = true;
    try {
      const current = await collect();
      if (!current) return;
      pendingClear ||= new Set(bots());
      for (const bot of new Set([...current.keys(), ...sent.keys(), ...pendingClear])) {
        const tabs = current.get(bot) || [];
        const signature = JSON.stringify(tabs);
        if (tabs.length ? sent.get(bot) === signature && now() - sentAt.get(bot) < refreshMs : !sent.has(bot) && !pendingClear.has(bot)) continue;
        try {
          await push(bot, tabs);
          pendingClear.delete(bot);
          if (tabs.length) { sent.set(bot, signature); sentAt.set(bot, now()); } else sent.delete(bot);
        } catch { /* the VM may be unreachable; the next tick retries */ }
      }
    } catch { /* a page that vanished mid-read is picked up on the next tick */ } finally { busy = false; }
  };
}
// Cookies are jar-wide on the VM, so a cookie is sent once per bot however many
// tabs share the site. Past maxBytes the oldest tabs (collected first) go, so a
// huge jar degrades to fewer tabs rather than a push the host refuses forever.
function prepareMirrorTabs(tabs, maxBytes = 3500000) {
  const share = (list) => {
    const seen = new Set();
    return list.map((tab) => ({ ...tab, cookies: (tab.cookies || []).filter((c) => {
      const key = `${c.domain}\0${c.path}\0${c.name}`;
      return seen.has(key) ? false : seen.add(key);
    }) }));
  };
  let dropped = 0, kept = share(tabs);
  while (kept.length > 1 && asciiJson(kept).length > maxBytes) kept = share(tabs.slice(++dropped));
  return { tabs: kept, dropped };
}
const settleWithin = (promise, ms, fallback) => new Promise((resolve) => {
  const timer = setTimeout(() => resolve(fallback), ms);
  promise.then((value) => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); resolve(fallback); });
});
const backoffDelay = (failures) => Math.min(60000, 5000 * 2 ** Math.min(failures, 4));
function createVpsBrowser({ getConfig }) {
  async function request(route, method = 'GET', body, { botId = '', botName = '', human = false, epoch } = {}) {
    const cfg = getConfig();
    if (!cfg?.sshHost || !cfg.scriptPath) throw new Error('Configure the VPS browser connection in Settings.');
    if (!isSshTarget(cfg.sshHost)) throw new Error('Invalid VPS browser SSH settings.');
    const pathProblem = checkScriptPath(cfg.scriptPath);
    if (pathProblem) throw new Error(pathProblem);
    const cmd = remoteCommand(cfg);
    return new Promise((resolve, reject) => {
      const child = spawn('ssh', sshArgs(cfg.sshHost, cmd), { stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '',
        stderr = '',
        size = 0,
        done = false;
      const finish = (error, value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        error ? reject(error) : resolve(value);
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(new Error('VPS browser timed out. Inspect the task before retrying.'));
      }, route.endsWith('/actions') ? 87000 : 30000);
      child.stdout.on('data', (chunk) => {
        size += chunk.length;
        if (size > 12000000) {
          child.kill();
          finish(new Error('VPS response too large.'));
        } else output += chunk;
      });
      child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-500); });
      child.on('error', () => finish(new Error('Unable to start the private VPS SSH connection.')));
      child.on('close', (code) => {
        if (code !== 0) {
          const tail = stderr.replace(/\s+/g, ' ').trim();
          return finish(new Error('VPS browser SSH unavailable. Check Tailscale and saved SSH access.' + (tail ? ` (${tail})` : '')));
        }
        try {
          const response = JSON.parse(output);
          if (response.status >= 400) throw Object.assign(new Error(response.data.error), { status: response.status });
          finish(null, response.data);
        } catch (e) {
          finish(e);
        }
      });
      child.stdin.on('error', () => {}); // ssh may exit before reading the request — the close handler reports the real error
      child.stdin.end(asciiJson({ path: route, method, body, botId, botName, human, epoch }));
    });
  }
  return { request };
}
module.exports = { createVpsBrowser, remoteCommand, asciiJson, checkScriptPath, sshArgs, backoffDelay, toCdpCookie, toElectronCookies, isTailnetHost, sshResolvedHostname, resolveSshHostname, createMirrorPusher, prepareMirrorTabs, settleWithin };
