'use strict';

// Check setup: turns what the app can see locally, over the connection, and
// from the server's --doctor report into a list of findings with fixes.
const fs = require('node:fs');
const path = require('node:path');
const { isNewer } = require('./mac-update.cjs');

const UPDATE = 'Update the server to install it.';
const SETUP_PROMPT = 'Paste the setup prompt to your bot (Settings → Agent setup → Copy setup prompt).';
const AUDIT_FIX = 'Ask your bot to run setup.sh --verify and fix what it reports.';

// setup.sh copies a connector into <userData>/connector and the router runs it
// ahead of the app's own, so once the app updates past it the copy is stale.
// A copy we can't read a version from is left alone.
function staleConnectorCopy(userDataDir, appVersion) {
  const dir = path.join(userDataDir, 'connector');
  let version;
  try { version = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version; } catch { return null; }
  return isNewer(appVersion, version) ? dir : null;
}

const row = (group, level, title, fix = '', action = null) => ({ group, level, title, fix, action });

function computerRows({ platform, local }) {
  const rows = [local.telegram === 'connected'
    ? row('computer', 'ok', 'Signed in to Telegram')
    : row('computer', 'fail', 'Not signed in to Telegram', 'Scan the QR code on the left with your phone: Telegram → Settings → Devices → Link Desktop Device.')];
  if (platform === 'darwin') {
    if (local.inApplications === true) rows.push(row('computer', 'ok', 'Open Alan is in Applications'));
    if (local.inApplications === false) rows.push(row('computer', 'fail', 'Open Alan is not in Applications', 'Move it there so your agent can find it.', 'move-to-applications'));
    if (local.permissions) {
      rows.push(local.permissions.accessibility === true
        ? row('computer', 'ok', 'Accessibility is on')
        : row('computer', 'warn', 'Accessibility is off', 'Your agent can use browser tabs, but it can’t click or type in other apps until this is on.', 'open-accessibility'));
      rows.push(local.permissions.screen === 'granted'
        ? row('computer', 'ok', 'Screen Recording is on')
        : row('computer', 'warn', 'Screen Recording is off', 'Your agent can’t see other apps’ windows until this is on.', 'open-screen'));
    }
  }
  rows.push(local.staleConnector
    ? row('computer', 'warn', 'An old connector copy is in use', 'Remove it so your agent uses the one inside this app.', 'remove-old-connector')
    : row('computer', 'ok', 'The connector matches this app'));
  return rows;
}

function connectionRows({ connection }) {
  const { addresses, reach, back } = connection;
  const rows = [];
  if (!addresses.server) rows.push(row('connection', 'fail', 'No server address saved', 'Enter your server’s SSH address and save it.'));
  if (!addresses.computer) rows.push(row('connection', 'fail', 'This computer’s address isn’t saved', 'Enter the address your server uses to reach this computer and save it.'));
  if (reach) rows.push(reach.ok
    ? row('connection', 'ok', 'This computer reaches the server')
    : row('connection', 'fail', 'This computer can’t reach the server', `Check the address and that this computer’s key is on the server. ${reach.detail}`.trim()));
  if (back) rows.push(back.ok
    ? row('connection', 'ok', 'The server reaches this computer')
    : row('connection', 'fail', 'The server can’t reach this computer', back.detail));
  return rows;
}

function pluginRow(group, prefix, plugin, pluginTag) {
  const behind = plugin.class === 'catalog' ? plugin.updateAvailable : pluginTag ? isNewer(pluginTag, plugin.version) : null;
  if (behind === null) return row(group, 'warn', `${prefix}Couldn’t check ${plugin.name} for updates`, 'The server couldn’t reach GitHub. Check again later.');
  return behind
    ? row(group, 'warn', `${prefix}${plugin.name} ${plugin.version} has an update`, UPDATE, 'update-server')
    : row(group, 'ok', `${prefix}${plugin.name} ${plugin.version} is the latest published version`);
}

function serverRows({ appVersion, server }) {
  const s = 'server';
  if (!server) return [row(s, 'fail', 'Server checks skipped', 'Fix the connection above, then check again.')];
  if (server.ok !== true) {
    if (server.error === 'windows') return [row(s, 'warn', 'Server checks aren’t available for Windows servers yet')];
    const missing = /no browser host checkout/.test(server.error || '');
    return [row(s, 'fail', missing ? 'Open Alan isn’t installed on the server' : 'The server check failed', missing ? SETUP_PROMPT : server.error || '')];
  }
  const rows = [];
  if (isNewer(appVersion, server.version)) rows.push(row(s, 'fail', 'The server is on an older version', `Server ${server.version}, this app ${appVersion}.`, 'update-server'));
  else if (isNewer(server.version, appVersion)) rows.push(row(s, 'warn', 'The server is newer than this app', 'Update this app.'));
  else rows.push(row(s, 'ok', `Server tools are on ${server.version}`));
  if (!server.hostVersion) rows.push(row(s, 'fail', 'The server’s browser is not running', 'Update the server to restart it.', 'update-server'));
  else if (server.hostVersion !== server.version) rows.push(row(s, 'warn', 'The server’s browser is running an older version', 'Update the server to restart it.', 'update-server'));
  else rows.push(row(s, 'ok', 'The server’s browser is running'));
  const profiles = server.profiles || [];
  if (!profiles.length) rows.push(row(s, 'warn', 'No Hermes profile on the server has the alans-way plugin', SETUP_PROMPT));
  for (const p of profiles) {
    const prefix = profiles.length > 1 ? `${p.profile}: ` : '';
    for (const plugin of p.plugins || []) rows.push(pluginRow(s, prefix, plugin, server.pluginTag));
    rows.push(p.computerBackend === 'alans-way-computer'
      ? row(s, 'ok', `${prefix}Computer use goes through Alan’s Way`)
      : row(s, 'warn', `${prefix}Computer use runs on Hermes’s built-in backend`, 'Update Hermes to a build with the computer-use provider API, then paste the setup prompt to your bot again.'));
    const v = p.verify || {};
    if (!v.ran) rows.push(v.reason === 'time'
      ? row(s, 'warn', `${prefix}Setup audit not run (out of time)`, 'Check again to audit the rest.')
      : row(s, 'warn', `${prefix}Setup audit not available`, `The setup files are missing on the server. ${SETUP_PROMPT}`));
    else if (!(v.fails || []).length && !(v.warns || []).length) rows.push(row(s, 'ok', `${prefix}Setup audit passed`));
    for (const text of v.fails || []) rows.push(row(s, 'fail', `${prefix}${text}`, AUDIT_FIX));
    for (const text of v.warns || []) rows.push(row(s, 'warn', `${prefix}${text}`, AUDIT_FIX));
  }
  return rows;
}

function buildFindings(input) {
  return [...computerRows(input), ...connectionRows(input), ...serverRows(input)];
}

module.exports = { staleConnectorCopy, buildFindings };
