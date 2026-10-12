// Run: npx electron test/update-all-electron.cjs
// The bottom bar's versions and the "Update everything" dialog, end to end in
// the real window with every machine-touching step stubbed: no ssh, no hermes,
// no GitHub. The plugin step fails on purpose to cover stop-on-failure.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, webContents, session } = require('electron');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-workspace-update-all-'));
process.env.HERMES_WORKSPACE_DATA = profile;
// A saved server address makes the probe target the server; .invalid never
// resolves, so the browser host connection fails fast and quietly.
fs.writeFileSync(path.join(profile, 'preferences.json'), JSON.stringify({ onboarded: true, preview: false,
  bots: [{ id: '4242', isBot: true, name: 'Scout' }], selectedBotId: '4242', vpsBrowser: { sshHost: 'tester@vm.invalid', scriptPath: '/srv/app/desktop/scripts/vps-browser-host.cjs' } }));
process.env.HERMES_WORKSPACE_PORT = String(19000 + Math.floor(Math.random() * 10000));

// main.cjs destructures these at load, so patching the exports first swaps
// the real ssh-driven updater and the GitHub read for recorders.
const calls = [];
let hermesNow = '0.21.6', releaseHermes;
const hermesGate = new Promise((resolve) => { releaseHermes = resolve; });
require('../src/update-all.cjs').latestPluginTag = async () => '0.21.1';
require('../src/vm-update.cjs').createVmUpdater = () => ({
  checkVm: async (target) => {
    calls.push(`check ${target.id}`);
    return { ok: true, version: '0.21.3', hostVersion: '0.21.3', busy: false, hermesVersion: `Hermes Agent v${hermesNow} (2026.9.24) · stable`,
      hermesCheck: hermesNow === '0.21.6' ? '→ Selected release available: stable v0.21.7 (71d34bad1045)' : '✓ Up to date with the latest release (stable v0.21.7 (71d34bad1045)).',
      pluginVersion: '0.21.0', gatewayRunning: true };
  },
  hermesUpdateVm: async (target, opts = {}) => {
    if (opts.report) { calls.push(`report ${opts.report}`); return { ok: true, messaged: true, messages: [{ profile: 'default', sent: true }] }; }
    calls.push(`hermes ${target.id} quiet=${opts.quiet === true}`);
    if (opts.quiet) await hermesGate;
    hermesNow = '0.21.7';
    return { ok: true, version: '0.21.7', updated: true, messaged: false, messages: [] };
  },
  updatePluginsVm: async (target) => {
    calls.push(`plugin ${target.id}`);
    const plugins = [{ profile: 'default', name: 'alans-way', before: '0.21.0', after: '0.21.0', status: 'failed', error: 'registry unreachable' }];
    return { id: target.id, ok: true, state: 'ok', plugins, gatewayRestarted: false, pluginLines: [{ text: 'Plugin update failed: registry unreachable', tone: 'warn' }] };
  },
  updateVm: async (target, tag) => { calls.push(`host ${target.id} ${tag}`); return { id: target.id, ok: true, state: 'ok', version: tag.slice(1), plugins: [], pluginLines: [] }; },
  doctorVm: async () => ({ ok: false, error: 'stubbed' }),
  updateAll: async () => [],
});
require('../src/main.cjs');

const waitFor = async (read, predicate, timeout = 12000, what = 'state') => {
  const deadline = Date.now() + timeout;
  let value;
  while (Date.now() < deadline) { value = await read(); if (predicate(value)) return value; await new Promise(r => setTimeout(r, 50)); }
  throw new Error(`Timed out waiting for ${what}; last value: ${JSON.stringify(value)}`);
};
app.whenReady().then(async () => {
  const win = await waitFor(() => BrowserWindow.getAllWindows()[0], Boolean);
  const wc = win.webContents;
  const telegram = webContents.getAllWebContents().find(item => item.session === session.fromPartition('persist:telegram'));
  if (telegram) { telegram.stop(); await telegram.loadURL('about:blank'); }
  const evaluate = code => wc.executeJavaScript(code);
  await waitFor(() => evaluate('typeof window.workspace === "object"').catch(() => false), Boolean);
  const invoke = (name, value) => evaluate(`window.workspace.command(${JSON.stringify(name)}, ${JSON.stringify(value || {})})`);
  const text = (id) => evaluate(`document.getElementById(${JSON.stringify(id)}).textContent`);
  const hidden = (id) => evaluate(`document.getElementById(${JSON.stringify(id)}).classList.contains('hidden')`);
  const click = (id) => evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
  const lines = () => evaluate('[...document.querySelectorAll("#update-all-steps .update-line")].map((p) => p.className.replace("update-line", "").trim() + "|" + p.textContent)');
  const version = app.getVersion();
  // Probes (start, dialog open, after the run) are reads; `work` is what changed things.
  const work = () => calls.filter((c) => !c.startsWith('check'));

  // The bar: compact versions, the update arrow, and the details on hover.
  const bar = await waitFor(() => text('version-label'), (t) => t.includes('Hermes'), 12000, 'the versions in the bar');
  assert.equal(bar, `Alan’s Workspace ${version} · Hermes 0.21.6 (server) · Plugin 0.21.0`);
  const tooltip = await evaluate('document.getElementById("version-label").title');
  assert.match(tooltip, /Hermes 0\.21\.6 on the server · 0\.21\.7 available/);
  assert.match(tooltip, /Alan’s Way plugin 0\.21\.0 · 0\.21\.1 on GitHub/);
  assert.match(tooltip, new RegExp(`Browser host 0\\.21\\.3 on the server · ${version.replace(/\./g, '\\.')} goes with this app`));
  assert.match(tooltip, /Checked /);
  assert.equal(await text('update-all'), '↑ Update');
  assert.deepEqual(calls, ['check agent'], 'the startup probe ran once and nothing else');

  // The confirmation lists exactly what changes and warns about the restart;
  // Cancel leaves everything untouched.
  await click('update-all');
  assert.equal(await hidden('update-all-popup'), false);
  assert.deepEqual(await lines(), ['|Hermes: 0.21.6 → 0.21.7', '|Alan’s Way plugin: 0.21.0 → 0.21.1', `|Browser host: 0.21.3 → ${version}`,
    'warn|Your bots restart briefly while the server updates.']);
  assert.equal(await text('update-all-go'), 'Update everything');
  await click('update-all-cancel');
  assert.equal(await hidden('update-all-popup'), true);
  assert.deepEqual(work(), [], 'Cancel runs nothing');
  assert.ok(calls.filter((c) => c === 'check agent').length >= 2, 'opening the dialog re-checks the machine');

  // Confirm: Hermes runs first and quietly (the bot reports at the end).
  await click('update-all');
  await click('update-all-go');
  await waitFor(() => calls, (c) => c.includes('hermes agent quiet=true'), 5000, 'the Hermes step');
  await waitFor(lines, (l) => l[0]?.startsWith('running|'), 5000, 'the running row');
  assert.deepEqual((await lines()).map((l) => l.split('|')[0]), ['running', 'pending', 'pending']);
  assert.equal(await evaluate('document.getElementById("update-all-cancel").disabled'), true, 'no closing mid-run');
  assert.equal(await text('update-all'), 'Updating…');

  // One lock: every other update entry point refuses while this runs.
  const before = work().length;
  await invoke('hermes-update');
  await invoke('vm-update-retry', { force: true });
  assert.deepEqual(await invoke('update-all'), { refused: 'Another update is already running. Try again when it finishes.' });
  assert.equal(work().length, before, 'Update Hermes, VM retry and a second Update everything all wait');

  // The plugin step fails: the browser host never starts, the summary says
  // what is left, versions refresh and the bot reports once.
  releaseHermes();
  await waitFor(() => evaluate('document.getElementById("update-all-cancel").disabled'), (d) => d === false, 8000, 'the run to end');
  const rows = await lines();
  assert.deepEqual(rows.map((l) => l.split('|')[0]), ['done', 'failed', 'skipped']);
  assert.equal(rows[0], 'done|✓ Hermes: 0.21.6 → 0.21.7 · Updated to 0.21.7');
  assert.equal(rows[1], 'failed|✗ Alan’s Way plugin: 0.21.0 → 0.21.1: Plugin update failed: registry unreachable');
  assert.equal(rows[2], `skipped|– Browser host: 0.21.3 → ${version} (not started)`);
  assert.ok(!calls.some((c) => c.startsWith('host')), 'nothing after the failure ran');
  assert.equal(await text('update-all-copy'), 'Alan’s Way plugin did not update: Plugin update failed: registry unreachable. Updated: Hermes. '
    + 'Not started, still on the old version: Browser host. Your bot messaged you on Telegram.');
  assert.ok(calls.lastIndexOf('check agent') > calls.indexOf('plugin agent'), 'the versions refresh after the run');
  assert.deepEqual(work().slice(before), ['plugin agent',
    'report Update everything stopped at the plugin: Plugin update failed: registry unreachable. Now on Hermes 0.21.7. Not started: browser host.']);
  assert.equal(await hidden('update-all-go'), true, 'no app update staged, so no restart offered');
  assert.equal(await text('version-label'), `Alan’s Workspace ${version} · Hermes 0.21.7 (server) · Plugin 0.21.0`, 'the bar shows the refreshed versions');

  // Closing works once the run is over; reopening shows a fresh plan.
  await evaluate('document.getElementById("update-all-popup").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');
  assert.equal(await hidden('update-all-popup'), true);
  await click('update-all');
  assert.deepEqual((await lines()).slice(0, 2), ['|Alan’s Way plugin: 0.21.0 → 0.21.1', `|Browser host: 0.21.3 → ${version}`], 'Hermes is current now');

  console.log('PASS: the bottom bar shows versions with details on hover; Update everything confirms first, runs in order under one lock, stops at a failure and reports once.');
  app.quit();
}).catch(error => { console.error(error.stack); app.exit(1); });
