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

// Must match macScripts and linuxAppRoots in alans-way-agents/alans-way/scripts/workspace-router.cjs.
const ROUTER_MAC_APPS = ['alans-way-localapp', 'Open Alan', "Hermes- Alan's way", 'Hermes Workspace'].map((name) => `/Applications/${name}.app`);
const ROUTER_LINUX_ROOTS = ['/opt/alans-way-localapp-linux-x64', '/opt/alans-way-localapp',
  '$HOME/.local/share/alans-way-localapp-linux-x64', '$HOME/.local/share/alans-way-localapp'];

// The connector copy may only go when the router can find the app's own
// connector instead; otherwise the copy is the only one this computer has.
function bundledConnectorReachable({ platform, isPackaged, execPath, home }) {
  if (!isPackaged) return false;
  if (platform === 'darwin') return ROUTER_MAC_APPS.includes(path.posix.resolve(execPath, '../../..'));
  if (platform === 'linux') return ROUTER_LINUX_ROOTS.map((root) => root.replace('$HOME', home)).includes(path.posix.dirname(execPath));
  return false;
}

const row = (group, level, title, fix = '', action = null) => ({ group, level, title, fix, action });

function computerRows({ platform, local }) {
  const rows = [local.telegram === 'connected'
    ? row('computer', 'ok', 'Signed in to Telegram')
    : row('computer', 'fail', 'Not signed in to Telegram', 'Scan the QR code on the left with your phone: Telegram → Settings → Devices → Link Desktop Device.')];
  if (platform === 'darwin') {
    if (local.inApplications === true) rows.push(row('computer', 'ok', 'Alan’s Workspace is in Applications'));
    if (local.inApplications === false) rows.push(row('computer', 'fail', 'Alan’s Workspace is not in Applications', 'Move it there so your agent can find it.', 'move-to-applications'));
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
  if (typeof behind !== 'boolean') return row(group, 'warn', `${prefix}Couldn’t check ${plugin.name} for updates`, 'The server couldn’t reach GitHub. Check again later.');
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
    return [row(s, 'fail', missing ? 'Alan’s Tools aren’t installed on the server' : 'The server check failed', missing ? SETUP_PROMPT : server.error || '')];
  }
  const rows = [];
  if (isNewer(appVersion, server.version)) rows.push(row(s, 'fail', 'The server is on an older version', `Server ${server.version}, this app ${appVersion}.`, 'update-server'));
  else if (isNewer(server.version, appVersion)) rows.push(row(s, 'warn', 'The server is newer than this app', 'Update this app.'));
  else rows.push(row(s, 'ok', `Server tools are on ${server.version}`));
  if (!server.hostVersion) rows.push(row(s, 'fail', 'The server’s browser is not running', 'Update the server to restart it.', 'update-server'));
  else if (server.hostVersion !== server.version) rows.push(row(s, 'warn', 'The server’s browser is running an older version', 'Update the server to restart it.', 'update-server'));
  else rows.push(row(s, 'ok', 'The server’s browser is running'));
  const profiles = server.profiles || [];
  if (!profiles.length) rows.push(row(s, 'warn', 'No Hermes profile on the server has the Alan’s Way Plugin', SETUP_PROMPT));
  for (const p of profiles) {
    const prefix = profiles.length > 1 ? `${p.profile}: ` : '';
    if (p.checked === false) { rows.push(row(s, 'warn', `${prefix}Not checked (out of time)`, 'Check again later.')); continue; }
    for (const plugin of p.plugins || []) rows.push(pluginRow(s, prefix, plugin, server.pluginTag));
    rows.push(p.computerBackend === 'alans-way-computer'
      ? row(s, 'ok', `${prefix}Computer use goes through the Alan’s Way Plugin`)
      : row(s, 'warn', `${prefix}Computer use runs on Hermes’s built-in backend`, 'Update Hermes to a build with the computer-use provider API, then paste the setup prompt to your bot again.'));
  }
  // One audit per server; setup.sh names the profile in its own lines.
  const v = server.verify || {};
  if (!v.ran) rows.push(v.reason === 'time'
    ? row(s, 'warn', 'Setup audit not run (out of time)', 'Check again later.')
    : row(s, 'warn', 'Setup audit not available', `The setup files are missing on the server. ${SETUP_PROMPT}`));
  else if (!(v.fails || []).length && !(v.warns || []).length) rows.push(row(s, 'ok', 'Setup audit passed'));
  for (const text of v.fails || []) rows.push(row(s, 'fail', text, AUDIT_FIX));
  for (const text of v.warns || []) rows.push(row(s, 'warn', text, AUDIT_FIX));
  return rows;
}

function buildFindings(input) {
  return [...computerRows(input), ...connectionRows(input), ...serverRows(input)];
}

// Secrets that can end up in logs or doctor output. SSH addresses, usernames
// and versions stay: a report without them can't be acted on.
// Every rule keeps its own output unchanged, so redacting twice is safe.
const SECRETS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----|[\s\S]*$)/g, '[private key removed]'],
  // "…token…": "value" in JSON, then the same pair escaped inside stringified JSON.
  [/("[\w-]*(?:token|secret|password|api[_-]?key|authorization)"\s*:\s*")(?:[^"\\]|\\.)*"/gi, '$1[removed]"'],
  [/(\\"[\w-]*(?:token|secret|password|api[_-]?key|authorization)\\"\s*:\s*\\")(?:[^"\\]|\\[^"])*\\"/gi, '$1[removed]\\"'],
  // --token value, key=value, key: value and URL queries. A plain word needs
  // =, : or a -- flag after it, so prose about keys and tokens stays.
  [/((?<![\w-])(?:--[\w-]*(?:token|secret|password|key)[ \t]+|[\w-]*(?:token|secret|password|key)[ \t]*[=:][ \t]*)["']?)[^\s"'&]+/gi, '$1[removed]'],
  [/([?&]code=)[^\s&#"']+/g, '$1[removed]'],
  [/(Authorization[ \t]*:[ \t]*)(?:[A-Za-z]+[ \t]+)?[^\s"']+/gi, '$1[removed]'],
  [/\b(Bearer)[ \t]+[A-Za-z0-9._~+/=-]+/gi, '$1 [removed]'],
  [/(?<!\d)\d{6,15}:[A-Za-z0-9_-]{30,}/g, '[bot token removed]'],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '[api key removed]'],
];
function redactReport(text) {
  return SECRETS.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), String(text));
}

const MARKS = { ok: '✓', warn: '!', fail: '✗' };
const GROUPS = { computer: 'This computer', connection: 'Connection', server: 'Server' };

// The plain-text report a user pastes to support. Built only on request.
function buildReport({ now = new Date(), app, serverAddress, computerAddress, findings, checkedAt, server, errorLog }) {
  const lines = [
    `Alan’s Workspace report, ${now.toISOString()}`,
    `App ${app.version} on ${app.platform} ${app.arch} (${app.osVersion}), ${app.signed ? 'signed' : 'unsigned'} build`,
    `Server address: ${serverAddress || 'not saved'}`,
    `This computer’s address: ${computerAddress || 'not saved'}`,
    '',
  ];
  if (findings?.length) {
    lines.push(`Check setup, ${checkedAt}:`);
    for (const f of findings) lines.push(`${MARKS[f.level]} ${GROUPS[f.group]}: ${f.title}${f.level !== 'ok' && f.fix ? ` (${f.fix})` : ''}`);
  } else lines.push('Check setup not run yet.');
  if (server) lines.push('', 'Server report:', JSON.stringify(server));
  // Redact before the cut so a secret spanning it can't lose its start marker.
  const log = redactReport(String(errorLog || '')).trimEnd().split('\n').slice(-50).join('\n');
  lines.push('', 'Recent app errors:', log || 'none');
  return redactReport(lines.join('\n'));
}

module.exports = { staleConnectorCopy, bundledConnectorReachable, buildFindings, redactReport, buildReport };
