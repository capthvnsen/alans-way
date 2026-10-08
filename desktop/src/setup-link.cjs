// The alansway://setup?host=<server> deep link opens the "Set up a server"
// wizard with the connect step prefilled. The host is validated hard here —
// only a tailnet MagicDNS name or a tailnet address, with an optional user@ —
// because whatever passes is later handed to ssh. The link itself never runs
// anything: the user still clicks Connect.
'use strict';
const net = require('node:net');

// One MagicDNS label, or a dotted name under *.ts.net — the only name shapes
// Tailscale hands out.
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
function tailnetName(host) {
  const labels = String(host).split('.');
  if (labels.length === 1) return LABEL.test(host);
  return host.endsWith('.ts.net') && labels.every((label) => LABEL.test(label));
}

// Tailscale v4 addresses come from the CGNAT range 100.64.0.0/10.
function tailnetV4(host) {
  if (!net.isIPv4(host)) return false;
  const octets = host.split('.').map(Number);
  return octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
}

// Tailscale v6 addresses live under fd7a:115c:a1e0::/48. net.isIPv6 validates
// the shape; expanding the :: shorthand is what makes the prefix comparable.
function tailnetV6(host) {
  const text = String(host).toLowerCase();
  if (!net.isIPv6(text) || text.includes('.')) return false;
  const sides = text.split('::');
  const head = sides[0] ? sides[0].split(':') : [];
  const tail = sides.length === 2 ? (sides[1] ? sides[1].split(':') : []) : [];
  const parts = [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail];
  if (parts.length !== 8) return false;
  return parts[0] === 'fd7a' && parts[1] === '115c' && parts[2] === 'a1e0';
}

const USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;

// Split an ssh-style target into {user, host} only when the host part is a
// tailnet name or address. Anything else — ordinary DNS, public IPs, other
// private ranges, spaces, quotes, options like -o — returns null.
function splitTailnetTarget(sshHost) {
  const text = String(sshHost || '').trim();
  if (!text || text.indexOf('@') !== text.lastIndexOf('@')) return null;
  const at = text.indexOf('@');
  const user = at === -1 ? '' : text.slice(0, at);
  const host = at === -1 ? text : text.slice(at + 1);
  if (!host || (at !== -1 && !USER_RE.test(user))) return null;
  if (!(tailnetName(host) || tailnetV4(host) || tailnetV6(host))) return null;
  return { user, host };
}

// Only alansway://setup?host=<target> is a setup link; a validated target is
// handed back as `user@host` or `host`, ready to prefill the connect field.
function parseSetupUrl(value) {
  let url;
  try { url = new URL(String(value || '')); } catch { return null; }
  if (url.protocol !== 'alansway:') return null;
  const path = (url.hostname + url.pathname).replace(/\/+$/, '');
  if (path !== 'setup') return null;
  const target = splitTailnetTarget(url.searchParams.get('host') || '');
  if (!target) return null;
  return target.user ? `${target.user}@${target.host}` : target.host;
}

// A deep link can land before the window exists (open-url on a cold start, or
// the second-instance argv on Windows). Hold the newest host until the
// renderer can act on it; only one is ever pending.
function createLinkQueue() {
  let pending = null, consumer = null;
  return {
    push(host) {
      if (!host) return;
      if (consumer) consumer(host);
      else pending = host;
    },
    setReady(fn) {
      consumer = fn;
      if (pending) { const host = pending; pending = null; fn(host); }
    },
    get pending() { return pending; },
  };
}

module.exports = { splitTailnetTarget, parseSetupUrl, createLinkQueue };
