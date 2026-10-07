// Pairing the claimed computer over Tailscale: find the CLI, watch
// `tailscale status --json` for the computer's hostname to come online, then
// confirm the agent wrote its state file. Pure parsing lives here; spawning
// stays in main.cjs where ssh and Electron already are.
'use strict';
const fs = require('node:fs');

const MAC_CLI = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

// macOS ships the CLI inside Tailscale.app; on Windows and Linux it is on PATH.
function tailscaleCli({ platform = process.platform, existsSync = fs.existsSync } = {}) {
  if (platform === 'darwin') return existsSync(MAC_CLI) ? MAC_CLI : null;
  return 'tailscale';
}

// A peer matches when its HostName is exactly the computer's name and it is
// online. Self never counts: the user's own machine cannot be the computer.
function findPeer(statusJson, computerName) {
  let data;
  try { data = typeof statusJson === 'string' ? JSON.parse(statusJson) : statusJson; } catch { return null; }
  if (!data || typeof data !== 'object') return null;
  const name = String(computerName || '');
  if (!name) return null;
  const peer = Object.values(data.Peer || {}).find((p) => p && p.HostName === name && p.Online === true);
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

// Single quotes keep any path inert; only absolute paths reach this command.
function sshReadCommand(remotePath) {
  const safe = String(remotePath).replace(/'/g, `'\\''`);
  return `cat '${safe}'`;
}

module.exports = { MAC_CLI, tailscaleCli, findPeer, pairPollCommand, parseComputerState, sshReadCommand };
