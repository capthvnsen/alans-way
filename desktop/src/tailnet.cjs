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

const SSH_OPTIONS = requireTailnet ? ['-F', 'none', '-o', 'ProxyCommand=none', '-o', 'ProxyJump=none', '-o', 'CanonicalizeHostname=no'] : [];
module.exports = { requireTailnet, isTailnetAddress, isTailnetHost, tailnetUrl, SSH_OPTIONS };
