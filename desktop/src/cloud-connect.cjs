// Pairing the claimed computer over Tailscale: find the CLI, watch
// `tailscale status --json` for the computer's hostname to come online, then
// confirm the agent wrote its state file. Pure parsing lives here; spawning
// stays in main.cjs where ssh and Electron already are.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const MAC_CLI = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

// macOS ships the CLI inside Tailscale.app; a brew or standalone install sits
// on PATH like Windows and Linux. Probe PATH everywhere so a missing CLI
// surfaces as "not installed" instead of a spawn failure that looks like a
// computer that never joins the tailnet.
function tailscaleCli({ platform = process.platform, existsSync = fs.existsSync, pathEnv = process.env.PATH || '' } = {}) {
  if (platform === 'darwin' && existsSync(MAC_CLI)) return MAC_CLI;
  const names = platform === 'win32' ? ['tailscale.exe', 'tailscale'] : ['tailscale'];
  const onPath = String(pathEnv || '').split(platform === 'win32' ? ';' : ':')
    .some((dir) => dir && names.some((name) => existsSync(path.join(dir, name))));
  return onPath ? 'tailscale' : null;
}

// Tailscale appends -<n> when a tailnet already has the hostname (a
// reinstalled alan-42 comes back as alan-42-1), so an exact name or the name
// plus a numeric suffix counts. Self never counts: the user's own machine
// cannot be the computer.
function peerNameMatches(hostName, name) {
  const host = String(hostName || '');
  return host === name || (host.startsWith(`${name}-`) && /^\d+$/.test(host.slice(name.length + 1)));
}
function findPeer(statusJson, computerName) {
  let data;
  try { data = typeof statusJson === 'string' ? JSON.parse(statusJson) : statusJson; } catch { return null; }
  if (!data || typeof data !== 'object') return null;
  const name = String(computerName || '');
  if (!name) return null;
  const peer = Object.values(data.Peer || {}).find((p) => p && p.Online === true && peerNameMatches(p.HostName, name));
  const ip = peer && Array.isArray(peer.TailscaleIPs) ? peer.TailscaleIPs.find((v) => /^\d+\.\d+\.\d+\.\d+$/.test(v)) || peer.TailscaleIPs[0] : '';
  return peer && ip ? { hostName: peer.HostName, ip } : null;
}

function pairPollCommand(cli) {
  return [cli, ['status', '--json']];
}

// The bootstrap on the computer records progress in a state file.
function parseComputerState(text) {
  try {
    const data = JSON.parse(String(text || ''));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch { return null; }
}

// Single quotes keep any path inert, but a leading ~ must sit outside them so
// the remote shell still expands it to the remote user's home.
function sshReadCommand(remotePath) {
  const p = String(remotePath);
  const rest = p.startsWith('~/') ? p.slice(2) : p;
  const safe = `'${rest.replace(/'/g, `'\\''`)}'`;
  return p.startsWith('~/') ? `cat ~/${safe}` : `cat ${safe}`;
}

// The computer must be able to ssh back into this machine. It may have no
// keypair yet — and no ~/.ssh at all — so create the dir first, generate a
// key only when missing, then print the public key.
function ensureKeypairCommand() {
  return `mkdir -p ~/.ssh && chmod 700 ~/.ssh; [ -f ~/.ssh/id_ed25519.pub ] || ssh-keygen -t ed25519 -N '' -f ~/.ssh/id_ed25519 >/dev/null; cat ~/.ssh/id_ed25519.pub`;
}

// The first real public-key line in remote output, reduced to `type blob`.
// The comment is untrusted remote text and never reaches authorized_keys —
// a backslash-n in it was enough to smuggle an unrestricted second line past
// awk -v. The blob must end at whitespace or end of line.
function publicKeyLine(text) {
  for (const line of String(text || '').split('\n')) {
    const match = /^((?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) [A-Za-z0-9+/]+=*)(?:[ \t]|$)/.exec(line.trim());
    if (match) return match[1];
  }
  return '';
}

// scripts/connect-mac.sh keeps its authorized_keys editor between markers —
// the same block tests/test_connect_scripts.py runs. Reused verbatim so the
// computer key lands tailnet-restricted (from="100.64.0.0/10,fd7a:115c:a1e0::/48")
// and re-runs tighten rather than duplicate.
function tailnetHelpers(scriptText) {
  return /# --- tailnet helpers begin[\s\S]*?# --- tailnet helpers end/.exec(String(scriptText || ''))?.[0] || '';
}

// The local half of authorizeComputerKey: create ~/.ssh, let the shared
// helper install the key tailnet-restricted, then pin authorized_keys to 600
// — sshd's StrictModes ignores a permissive file and the ssh-back path would
// fail silently after reporting ok.
function authorizeKeyCommand(helpers) {
  return `${helpers}\nmkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh" && touch "$HOME/.ssh/authorized_keys" && install_tailnet_key "$HOME/.ssh/authorized_keys" "$1" && chmod 600 "$HOME/.ssh/authorized_keys"`;
}

module.exports = { MAC_CLI, tailscaleCli, peerNameMatches, findPeer, pairPollCommand, parseComputerState, sshReadCommand, ensureKeypairCommand, publicKeyLine, tailnetHelpers, authorizeKeyCommand };
