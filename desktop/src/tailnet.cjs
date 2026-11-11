'use strict';
const net = require('node:net');
const requireTailnet = process.env.HERMES_WORKSPACE_REQUIRE_TAILNET === '1';
if (!requireTailnet) console.error('Legacy workspace transport: tailnet enforcement is not enabled. Provision pinned tailnet addresses and SSH keys before setting HERMES_WORKSPACE_REQUIRE_TAILNET=1.');

function isTailnetAddress(value) {
  const host = String(value || '').replace(/^\[|\]$/g, '');
  if (net.isIP(host) === 4) return host.split('.')[0] === '100' && Number(host.split('.')[1]) >= 64 && Number(host.split('.')[1]) <= 127;
  if (net.isIP(host) !== 6 || host.includes('%')) return false;
  return new URL(`http://[${host}]`).hostname.startsWith('[fd7a:115c:a1e0:');
}

// Literal addresses avoid DNS rebinding and SSH configuration aliases.
function isTailnetHost(value) {
  const host = String(value || '').replace(/^[^@]*@/, '').replace(/^\[|\]$/g, '');
  return isTailnetAddress(host) || (process.env.HERMES_WORKSPACE_ALLOW_LOOPBACK === '1' && ['127.0.0.1', '::1'].includes(host));
}

function tailnetUrl(url) {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  // Existing fixture opt-in also covers loopback CDP; never set it on a service.
  return !requireTailnet || isTailnetAddress(host) || (process.env.HERMES_WORKSPACE_ALLOW_LOOPBACK === '1' && ['127.0.0.1', '::1', 'localhost'].includes(host));
}

// The Hermes Webapp address the chat pane may load, or '' when refused. A Webapp
// session can run shell commands on its host, so only Tailscale Serve's HTTPS
// names and this machine (a local Hermes or an SSH tunnel) qualify. A .ts.net
// name is certificate-bound, and the view holds no Workspace bridge, so
// rebinding one gains nothing.
function hermesWebappUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.username || url.password || url.search || url.hash) return '';
    const host = url.hostname.toLowerCase();
    const allowed = url.protocol === 'https:' ? host.endsWith('.ts.net') : url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(host);
    return allowed ? url.href : '';
  } catch { return ''; }
}

const SSH_OPTIONS = requireTailnet ? ['-F', 'none', '-o', 'ProxyCommand=none', '-o', 'ProxyJump=none', '-o', 'CanonicalizeHostname=no'] : [];
module.exports = { requireTailnet, isTailnetAddress, isTailnetHost, tailnetUrl, hermesWebappUrl, SSH_OPTIONS };
