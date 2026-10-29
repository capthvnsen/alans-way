require('./window-fixture.cjs');
// Run: npx electron test/update-all-electron.cjs
// The bottom bar's versions and the "Update everything" dialog, end to end in
// the real window with every machine-touching step stubbed: no ssh, no hermes,
// no GitHub. The plugin stays behind on purpose to cover the warning UI,
// then succeeds so a full run stages the app restart.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, webContents, session } = require('electron');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-workspace-update-all-'));
process.env.HERMES_WORKSPACE_DATA = profile;
// A saved server address makes the probe target the server; .invalid never
// resolves, so the browser host connection fails fast and quietly.
fs.writeFileSync(path.join(profile, 'preferences.json'), JSON.stringify({ onboarded: true, preview: false, versionCache: { hermes: '0.21.6' },
  pendingUpdateReport: { runId: 'previous-run', targetVersion: require('../package.json').version, attempts: 0,
    target: { id: 'agent', label: 'VPS', sshHost: 'tester@vm.invalid', scriptPath: '/srv/app/desktop/scripts/vps-browser-host.cjs', sudo: false },
    rows: [{ id: 'app', from: '0.21.0', to: require('../package.json').version, state: 'done' }] },
  bots: [{ id: '4242', isBot: true, name: 'Scout' }], selectedBotId: '4242', vpsBrowser: { sshHost: 'tester@vm.invalid', scriptPath: '/srv/app/desktop/scripts/vps-browser-host.cjs' } }));
process.env.HERMES_WORKSPACE_PORT = String(19000 + Math.floor(Math.random() * 10000));

// main.cjs destructures these at load, so patching the exports first swaps
// the real ssh-driven updater and the GitHub read for recorders.
const calls = [];
const setupCalls = [];
let releaseSetup;
require('../src/server-setup.cjs').createServerSetup = () => async (host, plan) => {
  setupCalls.push({ host, plan });
  await new Promise((resolve) => { releaseSetup = resolve; });
  return { ok: false, detail: 'FAIL fixture check: restart skipped' };
};
let hermesNow = '0.21.6', releaseHermes, checkGate = null, failReport = false, noHomeReport = false, pluginOk = false;
const hermesGate = new Promise((resolve) => { releaseHermes = resolve; });
const gate = () => {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
};
let successGates = null, checkFixture = null, appChecks = 0;
require('../src/update-all.cjs').latestPluginTag = async () => '0.21.1';
require('../src/update-all.cjs').latestHostRelease = async () => '0.21.6';
require('../src/release-channel.cjs').checkLatest = async () => { appChecks++; return null; };
require('../src/vm-update.cjs').createVmUpdater = () => ({
  checkVm: async (target) => {
    calls.push(`check ${target.id}`);
    if (checkGate) await checkGate.promise;
    if (checkFixture) return checkFixture;
    return { ok: true, version: '0.21.3', hostVersion: '0.21.3', busy: false, hermesVersion: `Hermes Agent v${hermesNow} (2026.9.24) · stable`,
      hermesCheck: hermesNow === '0.21.6' ? '→ Selected release available: stable v0.21.7 (71d34bad1045)' : '✓ Up to date with the latest release (stable v0.21.7 (71d34bad1045)).',
      pluginVersion: '0.21.0', plugins: [{ name: 'alans-way', profile: 'default', version: '0.21.0' }], gatewayRunning: true };
  },
  hermesUpdateVm: async (target, opts = {}) => {
    if (opts.report && failReport) throw new Error('relay down');
    if (opts.report) {
      calls.push(`report ${opts.report}`);
      if (noHomeReport) return { ok: true, messaged: false, messages: [
        { profile: 'main', sent: false, error: 'No home channel set for telegram to determine where to send the message.' },
      ] };
      return { ok: true, messaged: true, messages: [{ profile: 'default', sent: true }] };
    }
    calls.push(`hermes ${target.id} quiet=${opts.quiet === true}`);
    if (opts.quiet) await hermesGate;
    if (opts.quiet && successGates) await successGates.hermes.promise;
    hermesNow = '0.21.7';
    return { ok: true, version: '0.21.7', updated: true, messaged: false, messages: [] };
  },
  updatePluginsVm: async (target) => {
    calls.push(`plugin ${target.id}`);
    if (successGates) await successGates.plugin.promise;
    if (pluginOk) return { id: target.id, ok: true, state: 'ok', gatewayRestarted: true, plugins: [{ profile: 'default', name: 'alans-way', before: '0.21.0', after: '0.21.1', status: 'updated' }],
      pluginLines: [{ text: 'Plugin updated to 0.21.1.', tone: 'ok' }] };
    const plugins = [{ profile: 'default', name: 'alans-way', before: '0.21.0', after: '0.21.0', status: 'failed', error: 'registry unreachable' }];
    return { id: target.id, ok: true, state: 'ok', plugins, gatewayRestarted: false, pluginLines: [{ text: 'Plugin alans-way (default) on 0.21.0 (wanted 0.21.1): registry unreachable', tone: 'warn' }] };
  },
  updateVm: async (target, tag) => {
    calls.push(`host ${target.id} ${tag}`);
    if (successGates) await successGates.host.promise;
    return { id: target.id, ok: true, state: 'ok', version: tag.slice(1), plugins: [], pluginLines: [] };
  },
  doctorVm: async () => ({ ok: false, error: 'stubbed' }),
  updateAll: async () => [],
});
// Exercise the packaged-app staging path without downloading or installing.
Object.defineProperty(app, 'isPackaged', { value: true });
app.getVersion = () => require('../package.json').version;
require('../src/mac-update.cjs').bundleLocation = () => null;
require('../src/mac-update.cjs').isDeveloperIdSigned = () => true;
require('../src/mac-update.cjs').updaterDriver = () => 'electron-updater';
const stagedUpdater = new (require('node:events').EventEmitter)();
stagedUpdater.checkForUpdates = async () => ({});
stagedUpdater.setFeedURL = () => {};
stagedUpdater.quitAndInstall = () => { calls.push('install app'); throw new Error('Test must never install'); };
require('electron-updater');
require.cache[require.resolve('electron-updater')].exports = { autoUpdater: stagedUpdater };
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
  assert.match(tooltip, /alans-way \(default\) 0\.21\.0 · 0\.21\.1 on GitHub/);
  assert.match(tooltip, new RegExp(`Browser host 0\\.21\\.3 on the server · ${version.replace(/\./g, '\\.')} goes with this app`));
  assert.match(tooltip, /Checked /);
  assert.equal(await text('update-all'), '↑ Update');
  await waitFor(() => JSON.parse(fs.readFileSync(path.join(profile, 'preferences.json'), 'utf8')).pendingUpdateReport,
    value => value === undefined, 5000, 'the previous run to be delivered and cleared');
  assert.deepEqual(calls.filter(c => c.startsWith('report ')), [`report Update everything finished. The app is now on ${version}.`]);
  calls.splice(calls.findIndex(c => c.startsWith('report ')), 1);
  assert.deepEqual(calls, ['check agent'], 'the startup probe ran once and nothing else');

  // The confirmation lists exactly what changes and warns about the restart;
  // Cancel leaves everything untouched.
  await click('update-all');
  assert.equal(await hidden('update-all-popup'), false);
  assert.deepEqual(await lines(), ['|Hermes: 0.21.6 → 0.21.7', '|Alan’s Way plugin: 0.21.0 → 0.21.1', `|Browser host: 0.21.3 → ${version}`,
    `|Alan’s Workspace: ${version} · latest not checked yet`,
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
  assert.equal((await invoke('server-setup', { plan: '{}' })).ok, false);
  assert.equal(setupCalls.length, 0, 'setup shares the server update lock');
  const before = work().length;
  await invoke('hermes-update');
  await invoke('vm-update-retry', { force: true });
  assert.deepEqual(await invoke('update-all'), { refused: 'Another update is already running. Try again when it finishes.' });
  assert.equal(work().length, before, 'Update Hermes, VM retry and a second Update everything all wait');

  // The plugin remains behind: the warning names its version and target;
  // the browser host can update, versions refresh and the bot reports once.
  releaseHermes();
  await waitFor(() => evaluate('document.getElementById("update-all-cancel").disabled'), (d) => d === false, 8000, 'the run to end');
  const rows = await lines();
  assert.deepEqual(rows.map((l) => l.split('|')[0]), ['done', 'warn', 'done']);
  assert.equal(rows[0], 'done|✓ Hermes: 0.21.6 → 0.21.7 · Updated to 0.21.7');
  assert.equal(rows[1], 'warn|⚠ Alan’s Way plugin unchanged 0.21.0 (wanted 0.21.1): Plugin alans-way (default) on 0.21.0 (wanted 0.21.1): registry unreachable');
  assert.equal(rows[2], `done|✓ Browser host: 0.21.3 → ${version} · Running ${version}`);
  assert.ok(calls.includes(`host agent v${version}`), 'the version warning does not block the host');
  assert.equal(await text('update-all-copy'), 'Alan’s Way plugin unchanged 0.21.0 (wanted 0.21.1): Plugin alans-way (default) on 0.21.0 (wanted 0.21.1): registry unreachable. Updated: Hermes, Browser host. Your bot messaged you on Telegram.');
  assert.ok(calls.lastIndexOf('check agent') > calls.indexOf('plugin agent'), 'the versions refresh after the run');
  assert.deepEqual(work().slice(before), ['plugin agent', `host agent v${version}`,
    `report Update everything finished with warnings. plugin unchanged 0.21.0 (wanted 0.21.1): Plugin alans-way (default) on 0.21.0 (wanted 0.21.1): registry unreachable. Now on Hermes 0.21.7, browser host ${version}.`]);
  assert.equal(await hidden('update-all-go'), true, 'no app update staged, so no restart offered');
  assert.equal(await text('version-label'), `Alan’s Workspace ${version} · Hermes 0.21.7 (server) · Plugin 0.21.0`, 'the bar shows the refreshed versions');

  // Closing works once the run is over; reopening shows a fresh plan.
  await evaluate('document.getElementById("update-all-popup").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');
  assert.equal(await hidden('update-all-popup'), true);
  await click('update-all');
  assert.deepEqual((await lines()).slice(0, 2), ['|Alan’s Way plugin: 0.21.0 → 0.21.1', `|Browser host: 0.21.3 → ${version}`], 'Hermes is current now');

  await click('update-all-cancel');

  // Other update buttons wait out a version check already in flight: its
  // `hermes update --check` fetches into the checkout an update moves.
  await waitFor(() => evaluate('document.getElementById("update-all-popup").classList.contains("hidden")'), Boolean);
  let release; checkGate = { promise: new Promise((r) => { release = r; }) };
  invoke('versions-refresh');
  await waitFor(() => calls.at(-1), (c) => c === 'check agent', 3000, 'the probe to start');
  const updating = invoke('hermes-update');
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(!calls.includes('hermes agent quiet=false'), 'Update Hermes waits for the probe');
  checkGate = null; release();
  await updating;
  assert.ok(calls.indexOf('hermes agent quiet=false') > calls.lastIndexOf('check agent'), 'and runs once it finished');

  // A paired bot can chat without a home channel: the final dialog must
  // retain the delivery reason and tell the user where to set the target.
  noHomeReport = true;
  await click('update-all');
  await waitFor(lines, (l) => l.length > 0, 3000, 'the plan without a Telegram home');
  await click('update-all-go');
  await waitFor(() => evaluate('document.getElementById("update-all-cancel").disabled'), d => d === false, 8000, 'the report failure');
  assert.match(await text('update-all-copy'), /The bot could not message you on Telegram\. main: No home channel set for telegram/);
  assert.match(await text('update-all-copy'), /Send \/sethome in the affected bot’s Telegram chat to enable future update reports/);
  assert.deepEqual((await lines()).map(l => l.split('|')[0]), ['warn', 'done'], 'delivery does not change component outcomes');
  await click('update-all-cancel');
  noHomeReport = false;

  // An error that escapes the steps lands in the dialog, never a blank run.
  failReport = true;
  await click('update-all');
  await waitFor(lines, (l) => l.length > 0, 3000, 'the plan');
  await click('update-all-go');
  await waitFor(() => text('update-all-copy'), (t) => t.startsWith('Update everything stopped:'), 8000, 'the error in the dialog');
  assert.match(await text('update-all-copy'), /relay down/);
  assert.equal(await evaluate('document.getElementById("update-all-cancel").disabled'), false, 'and it can be closed');
  await click('update-all-cancel');

  // A fully successful run: Hermes, plugin, host and the staged app all finish.
  // Hold each server step so restart timing and report persistence are observable.
  failReport = false; pluginOk = true; hermesNow = '0.21.6';
  successGates = { hermes: gate(), plugin: gate(), host: gate() };
  const appVersion = version.replace(/\d+$/, (patch) => String(Number(patch) + 1));
  stagedUpdater.emit('update-downloaded', { version: appVersion });
  await waitFor(() => hidden('update-all-popup'), Boolean);
  const start = calls.length;
  await click('update-all');
  await waitFor(lines, (l) => l[0]?.includes('Hermes:'), 3000, 'the four-step plan');
  assert.deepEqual(await lines(), ['|Hermes: 0.21.6 → 0.21.7', '|Alan’s Way plugin: 0.21.0 → 0.21.1',
    `|Browser host: 0.21.3 → ${appVersion}`, `|Alan’s Workspace: ${version} → ${appVersion}`,
    'warn|Your bots restart briefly while the server updates.', '|The app update installs when you click Restart to finish.']);
  assert.equal(await text('update-all-go'), 'Update everything', 'confirmation comes before restart');
  // Mac keeps Squirrel unstaged until explicit restart so a later channel change can cancel it.
  assert.equal(stagedUpdater.autoInstallOnAppQuit, process.platform !== 'darwin', 'Stable preserves the platform install-on-quit policy before the run');
  await click('update-all-go');
  const successWork = () => calls.slice(start).filter((c) => !c.startsWith('check'));
  const assertHeld = async (states) => {
    await waitFor(lines, (l) => l.some((row, i) => states[i] === 'running' && row.startsWith('running|')), 5000, 'the paused step');
    assert.deepEqual((await lines()).map((l) => l.split('|')[0]), states);
    assert.equal(stagedUpdater.autoInstallOnAppQuit, false, 'app installation waits for the entire run');
    assert.equal(await hidden('update-all-go'), true, 'restart is unavailable while the run is busy');
    assert.equal(await evaluate('document.getElementById("update-all-cancel").disabled'), true);
    await invoke('update-all-restart');
    assert.ok(!successWork().includes('install app'), 'an early restart command cannot install');
  };
  await assertHeld(['running', 'pending', 'pending', 'pending']);
  assert.deepEqual(successWork(), ['hermes agent quiet=true']);
  successGates.hermes.release();
  await assertHeld(['done', 'running', 'pending', 'pending']);
  assert.deepEqual(successWork(), ['hermes agent quiet=true', 'plugin agent']);
  successGates.plugin.release();
  await assertHeld(['done', 'done', 'running', 'pending']);
  assert.deepEqual(successWork(), ['hermes agent quiet=true', 'plugin agent', `host agent v${appVersion}`]);
  successGates.host.release();
  await waitFor(lines, (l) => l.length === 4 && l.every((r) => r.startsWith('done|')), 5000, 'all four completion rows');
  assert.deepEqual(await lines(), ['done|✓ Hermes: 0.21.6 → 0.21.7 · Updated to 0.21.7',
    'done|✓ Alan’s Way plugin: 0.21.0 → 0.21.1 · Plugin alans-way (default) updated (v0.21.0 to v0.21.1)',
    `done|✓ Browser host: 0.21.3 → ${appVersion} · Running ${appVersion}`,
    `done|✓ Alan’s Workspace: ${version} → ${appVersion} · Downloaded. Restart to finish.`]);
  await waitFor(() => evaluate('document.getElementById("update-all-cancel").disabled'), (d) => d === false, 8000, 'the run to end');
  assert.deepEqual((await lines()).map((l) => l.split('|')[0]), ['done', 'done', 'done', 'done']);
  assert.deepEqual(successWork(), ['hermes agent quiet=true', 'plugin agent', `host agent v${appVersion}`,
    `report Update everything finished. Now on Hermes 0.21.7, plugin 0.21.1, browser host ${appVersion}.`]);
  assert.equal(successWork().filter((c) => c.startsWith('report ')).length, 1, 'server results report before restart');
  const pending = JSON.parse(fs.readFileSync(path.join(profile, 'preferences.json'), 'utf8')).pendingUpdateReport;
  assert.ok(pending.runId);
  assert.equal(pending.targetVersion, appVersion);
  assert.deepEqual(pending.target, { id: 'agent', label: 'VPS', sshHost: 'tester@vm.invalid', scriptPath: '/srv/app/desktop/scripts/vps-browser-host.cjs', sudo: false });
  assert.equal(pending.attempts, 0);
  assert.deepEqual(pending.rows.map(row => [row.id, row.state]), [['app', 'done']]);
  assert.match(await text('update-all-copy'), /Your bot messaged you on Telegram\. Your bot will report the app version when the app starts again\./);
  assert.match(await text('update-all-copy'), /^Everything is updated\./);
  assert.equal(await text('update-all-go'), 'Restart to finish');
  assert.equal(await hidden('update-all-go'), false, 'restart is offered once the run finishes');
  assert.equal(stagedUpdater.autoInstallOnAppQuit, process.platform !== 'darwin', 'Stable restores the platform install-on-quit policy after completion');

  // Nightly opt-in waits for a new app session; neither stream may stage an installer meanwhile.
  assert.equal((await evaluate('workspace.getState()')).releaseChannel, 'stable', 'Stable is the saved default');
  await invoke('settings', { releaseChannel: 'nightly' });
  const selectedNightly = await evaluate('workspace.getState()');
  assert.equal(selectedNightly.activeReleaseChannel, 'stable');
  assert.equal(selectedNightly.releaseChannel, 'nightly');
  assert.equal(selectedNightly.update.ready, false, 'changing channel discards the staged Stable update');
  assert.equal(stagedUpdater.autoInstallOnAppQuit, false, 'the previous stream cannot install on quit');
  for (const candidate of [appVersion, `${appVersion}-nightly.20261028`]) stagedUpdater.emit('update-downloaded', { version: candidate });
  assert.equal((await evaluate('workspace.getState()')).update.ready, false, 'late downloads cannot bypass the channel restart');
  await invoke('settings', { releaseChannel: 'stable' });
  stagedUpdater.emit('update-downloaded', { version: `${appVersion}-nightly.20261028` });
  const stableAgain = await evaluate('workspace.getState()');
  assert.equal(stableAgain.releaseChannel, 'stable');
  assert.equal(stableAgain.update.ready, false, 'a Stable install never stages a Nightly installer');
  assert.equal(stableAgain.versions.steps.some(step => step.id === 'app'), false);

  // A fresh server has Hermes but no plugin or host. Empty actions cannot
  // certify currency; the user can explicitly retry both version probes.
  await click('update-all-cancel');
  stagedUpdater.emit('update-not-available', { version });
  checkFixture = { ok: true, hermesVersion: 'Hermes Agent v0.22.1', hermesCheck: 'up to date', plugins: [] };
  await invoke('versions-refresh');
  await waitFor(() => text('version-label'), t => t.includes('0.22.1'));
  await click('update-all');
  assert.doesNotMatch(await text('update-all-copy'), /Everything is up to date/);
  const missing = (await lines()).join('\n');
  assert.match(missing, /Alan’s Way plugin: not installed/);
  assert.match(missing, /Browser host: not installed/);
  assert.match(missing, /Alan’s Workspace:/);
  assert.match(missing, /Hermes:/);
  const checkedBefore = appChecks, probesBefore = calls.filter(c => c.startsWith('check')).length;
  await click('update-all-check');
  await waitFor(() => appChecks, n => n > checkedBefore);
  await waitFor(() => calls.filter(c => c.startsWith('check')).length, n => n > probesBefore);

  // An RC app plans and executes a stable host release, never its own RC tag.
  await click('update-all-cancel');
  app.getVersion = () => '0.21.7-rc.2';
  stagedUpdater.emit('update-downloaded', { version: '0.21.7-rc.2' });
  checkFixture = { ok: true, hostVersion: '0.21.5', hermesVersion: 'Hermes Agent v0.21.7', hermesCheck: 'up to date',
    plugins: [{ name: 'alans-way', profile: 'default', version: '0.21.1' }] };
  await invoke('versions-refresh');
  await click('update-all');
  await waitFor(lines, (l) => l.some(row => row === '|Browser host: 0.21.5 → 0.21.6'), 3000, 'the stable host target for an RC app');
  const rcStart = calls.length;
  await click('update-all-go');
  await waitFor(() => evaluate('document.getElementById("update-all-cancel").disabled'), d => d === false, 8000, 'the RC run to finish');
  assert.ok(calls.slice(rcStart).includes('host agent v0.21.6'));
  assert.ok(!calls.slice(rcStart).some(c => c.startsWith('host ') && c.includes('-rc.')));

  // The Settings handoff reaches the app process, preserves the plan and
  // displays a failed check without claiming the gateway restarted.
  await click('update-all-cancel');
  await click('settings-button');
  await evaluate("document.querySelector('[data-category=connections]').click()");
  assert.equal(await evaluate(`!!document.querySelector('[aria-label="Server setup plan"]')`), true,
    'Agent machine settings must mount the external setup handoff');
  const setupPlan = JSON.stringify({ repoRef: 'a'.repeat(40), desktopRef: 'b'.repeat(40), args: [] });
  await evaluate(`document.querySelector('[aria-label="Server setup plan"]').value = ${JSON.stringify(setupPlan)}`);
  const setupButton = '[...document.querySelectorAll("button")].find(b => b.textContent === "Finish setup and restart my bot")';
  await evaluate(`document.getElementById('vps-ssh-host').value = 'tester@unsaved.invalid'; ${setupButton}.click()`);
  await waitFor(() => evaluate('document.getElementById("modal-body").textContent'), text => text.includes('Save address changes before running setup.'));
  assert.equal(setupCalls.length, 0, 'unsaved addresses cannot run setup against the previous host');
  await evaluate(`document.getElementById('vps-ssh-host').value = 'tester@vm.invalid'; ${setupButton}.click()`);
  await waitFor(() => setupCalls.length, n => n === 1, 5000, 'the SSH setup handoff');
  assert.deepEqual(setupCalls[0], { host: 'tester@vm.invalid', plan: setupPlan });
  assert.equal(await evaluate(`${setupButton}.disabled`), true);
  assert.equal((await invoke('server-setup', { plan: setupPlan })).ok, false, 'setup cannot overlap itself');
  assert.equal(setupCalls.length, 1);
  releaseSetup();
  await waitFor(() => evaluate('document.getElementById("modal-body").textContent'), text => text.includes('FAIL fixture check: restart skipped'), 5000, 'the setup report');
  assert.equal(await evaluate(`${setupButton}.disabled`), false);
  await click('modal-close');

  console.log('PASS: the bottom bar shows versions with details on hover; Update everything confirms first, runs in order under one lock, warns when a plugin stays behind, finishes a clean run, and reports once.');
  app.quit();
}).catch(error => { console.error(error.stack); app.exit(1); });
