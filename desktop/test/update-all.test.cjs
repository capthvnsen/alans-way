// Covers the bottom bar's versions and "Update everything": parsing what the
// agent machine reports (strings captured from real hermes CLIs), the
// update-available comparison, and step orchestration with a failure midway.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseHermesVersion, parseHermesCheck, newestTag, latestPluginTag, versionRecord, planSteps, describeVersions, runSteps, summarizeRun, reportText } = require('../src/update-all.cjs');

test('the Hermes version comes from the --version banner, build suffixes dropped', () => {
  assert.equal(parseHermesVersion('Hermes Agent v0.21.6+763.g1fd1827 (2026.9.24) · stable · local 1fd182772671'), '0.21.6');
  assert.equal(parseHermesVersion('Hermes Agent v0.21.6+187.g1e0c773 (2026.9.24) · upstream 1e0c7730'), '0.21.6');
  assert.equal(parseHermesVersion('Hermes Agent v0.22.0 (2026.10.1)'), '0.22.0');
  assert.equal(parseHermesVersion(''), '');
  assert.equal(parseHermesVersion('command not found: hermes'), '');
});

test('hermes update --check verdicts: release channel, branch install, current, no verdict', () => {
  assert.deepEqual(parseHermesCheck('→ Selected release available: stable v0.21.7 (71d34bad1045)'), { available: true, latest: '0.21.7' });
  assert.deepEqual(parseHermesCheck('⚕ Update available: 827 commits behind origin/main.'), { available: true, latest: '' });
  assert.deepEqual(parseHermesCheck('⚕ Update available (behind origin/main).'), { available: true, latest: '' });
  assert.deepEqual(parseHermesCheck('✓ Already up to date.'), { available: false, latest: '' });
  assert.deepEqual(parseHermesCheck('✓ Up to date with the latest release (stable v0.21.6 (abc123)).'), { available: false, latest: '' });
  assert.deepEqual(parseHermesCheck('✓ No newer release: stable v0.21.6 (abc123).'), { available: false, latest: '' });
  assert.deepEqual(parseHermesCheck('no update available'), { available: false, latest: '' });
  assert.deepEqual(parseHermesCheck(''), { available: null, latest: '' });
  assert.deepEqual(parseHermesCheck('✗ Not a git repository — cannot check for updates.'), { available: null, latest: '' });
});

test('the newest plugin tag compares numerically and ignores pre-releases', () => {
  assert.equal(newestTag(['v0.6.1', 'v0.6.2', 'v0.7.0', 'v0.21.0', 'v0.9.9']), '0.21.0');
  assert.equal(newestTag(['v1.0.0-rc1', 'main', 'v0.21.0']), '0.21.0');
  assert.equal(newestTag([]), '');
});

test('latestPluginTag reads the GitHub tag list and treats a failed request as unknown', async () => {
  const ok = async () => ({ ok: true, json: async () => [{ name: 'v0.7.0' }, { name: 'v0.21.0' }] });
  assert.equal(await latestPluginTag(ok), '0.21.0');
  assert.equal(await latestPluginTag(async () => ({ ok: false })), '');
});

const serverCheck = { ok: true, version: '0.21.4', hostVersion: '0.21.4', hermesVersion: 'Hermes Agent v0.21.6+187.g1e0c773 (2026.9.24)',
  hermesCheck: '→ Selected release available: stable v0.21.7 (71d34bad1045)', pluginVersion: '0.21.0', gatewayRunning: true };
const server = { id: 'agent', label: 'VPS', sshHost: 'u@vm' };

test('a check becomes the cached record; an unreachable machine keeps the last versions and goes offline', () => {
  const record = versionRecord({}, { target: server, check: serverCheck, pluginLatest: '0.21.1', now: 1000 });
  assert.deepEqual(record, { where: 'server', checkedAt: 1000, pluginLatest: '0.21.1', offline: false, hermes: '0.21.6',
    hermesUpdate: true, hermesLatest: '0.21.7', plugin: '0.21.0', host: '0.21.4', gatewayRunning: true });
  const offline = versionRecord(record, { target: server, check: { ok: false, error: 'ssh: timed out' }, pluginLatest: '', now: 2000 });
  assert.equal(offline.offline, true);
  assert.equal(offline.hermes, '0.21.6', 'the last known version stays for the tooltip');
  assert.equal(offline.pluginLatest, '0.21.1', 'a failed GitHub read keeps the last tag');
  assert.equal(offline.checkedAt, 2000);
  const moved = versionRecord(record, { target: { id: 'local', local: true }, check: { ok: false }, now: 3000 });
  assert.equal(moved.hermes, undefined, 'a record for another machine never leaks into this one');
});

test('the plan lists only what is behind, in run order, with from and to versions', () => {
  const cache = versionRecord({}, { target: server, check: serverCheck, pluginLatest: '0.21.1', now: 1 });
  assert.deepEqual(planSteps({ app: '0.21.4', appUpdate: '0.21.5', cache }).map((s) => [s.id, s.from, s.to]),
    [['hermes', '0.21.6', '0.21.7'], ['plugin', '0.21.0', '0.21.1'], ['host', '0.21.4', '0.21.5'], ['app', '0.21.4', '0.21.5']]);
  // Everything current: Hermes said so, plugin at the newest tag, host matches the app.
  const current = { ...cache, hermesUpdate: false, hermesLatest: '', pluginLatest: '0.21.0' };
  assert.deepEqual(planSteps({ app: '0.21.4', appUpdate: '', cache: current }), []);
  // No verdict from Hermes still runs `hermes update` (a no-op when current).
  assert.deepEqual(planSteps({ app: '0.21.4', cache: { ...current, hermesUpdate: null } }).map((s) => [s.id, s.to]), [['hermes', 'latest']]);
  // An older tag on GitHub than installed is not an update.
  assert.deepEqual(planSteps({ app: '0.21.4', cache: { ...current, plugin: '0.22.0', pluginLatest: '0.21.1' } }), []);
  // An offline server contributes nothing; the app still updates.
  assert.deepEqual(planSteps({ app: '0.21.4', appUpdate: '0.21.5', cache: { ...cache, offline: true } }).map((s) => s.id), ['app']);
  // A local Hermes has no browser host to update.
  assert.deepEqual(planSteps({ app: '0.21.4', appUpdate: '0.21.5', cache: { ...cache, where: 'local' } }).map((s) => s.id), ['hermes', 'plugin', 'app']);
});

test('the bar text is compact, says where Hermes runs, and the tooltip carries the details', () => {
  const cache = versionRecord({}, { target: server, check: serverCheck, pluginLatest: '0.21.1', now: 1 });
  const v = describeVersions({ app: '0.21.5', cache, formatTime: () => '14:02' });
  assert.equal(v.text, 'Alan’s Workspace 0.21.5 · Hermes 0.21.6 (server) · Plugin 0.21.0');
  assert.equal(v.hasUpdate, true);
  assert.equal(v.tooltip, ['Alan’s Workspace 0.21.5', 'Hermes 0.21.6 on the server · 0.21.7 available',
    'Alan’s Way plugin 0.21.0 · 0.21.1 on GitHub', 'Browser host 0.21.4 on the server · 0.21.5 goes with this app', 'Checked 14:02'].join('\n'));
  const local = describeVersions({ app: '0.21.5', cache: { ...cache, where: 'local', hermesUpdate: false, pluginLatest: '0.21.0' }, formatTime: () => 't' });
  assert.equal(local.text, 'Alan’s Workspace 0.21.5 · Hermes 0.21.6 (local) · Plugin 0.21.0');
  assert.equal(local.hasUpdate, false);
  assert.match(local.tooltip, /Hermes 0\.21\.6 on this computer · up to date/);
  const offline = describeVersions({ app: '0.21.5', cache: { ...cache, offline: true }, formatTime: () => 't' });
  assert.equal(offline.text, 'Alan’s Workspace 0.21.5 · Hermes: offline');
  assert.match(offline.tooltip, /Hermes: offline, the server did not answer \(last seen 0\.21\.6\)/);
  assert.equal(describeVersions({ app: '0.21.5', cache: {} }).text, 'Alan’s Workspace 0.21.5');
  assert.match(describeVersions({ app: '0.21.5', cache: {} }).tooltip, /Not checked yet/);
  assert.equal(describeVersions({ app: '0.21.4', appUpdate: '0.21.5', cache: {} }).hasUpdate, true, 'an app build alone lights the indicator');
});

const STEPS = [{ id: 'hermes', name: 'Hermes', from: '0.21.6', to: '0.21.7' }, { id: 'plugin', name: 'Alan’s Way plugin', from: '0.21.0', to: '0.21.1' },
  { id: 'host', name: 'Browser host', from: '0.21.4', to: '0.21.5' }, { id: 'app', name: 'Alan’s Workspace', from: '0.21.4', to: '0.21.5' }];

test('steps run in order; a failure midway stops the rest and they are reported as skipped', async () => {
  const ran = [], seen = [];
  const rows = await runSteps(STEPS, async (step) => {
    ran.push(step.id);
    if (step.id === 'plugin') return { ok: false, error: 'Plugin update failed: registry unreachable' };
    return { ok: true, detail: 'fine', version: step.id === 'hermes' ? '0.21.7' : '' };
  }, (snapshot) => seen.push(snapshot.map((row) => row.state).join(',')));
  assert.deepEqual(ran, ['hermes', 'plugin'], 'nothing after the failure runs');
  assert.deepEqual(rows.map((row) => row.state), ['done', 'failed', 'skipped', 'skipped']);
  assert.equal(rows[1].error, 'Plugin update failed: registry unreachable');
  assert.ok(seen.includes('done,running,pending,pending'), 'the popover sees each step start');
  assert.equal(seen.at(-1), 'done,failed,skipped,skipped');
  assert.equal(summarizeRun(rows, { gatewayRunning: true }),
    'Alan’s Way plugin did not update: Plugin update failed: registry unreachable. Updated: Hermes. Not started, still on the old version: Browser host, Alan’s Workspace.');
  assert.match(summarizeRun(rows, { gatewayRunning: false }), /gateway is not running on the server\. Start it there/);
  assert.equal(reportText(rows), 'Update everything stopped at the plugin: Plugin update failed: registry unreachable. Now on Hermes 0.21.7. Not started: browser host, app.');
});

test('a step that throws is a failure with its message; the actual version replaces the planned one', async () => {
  const rows = await runSteps(STEPS.slice(0, 2), async (step) => {
    if (step.id === 'hermes') return { ok: true, version: '0.21.8' };
    throw new Error('ssh: connection reset');
  });
  assert.equal(rows[0].to, '0.21.8');
  const leaky = await runSteps(STEPS.slice(0, 1), async () => ({ ok: false, error: 'curl -H "Authorization: Bearer abc.def" failed: TELEGRAM_BOT_TOKEN=123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }));
  assert.doesNotMatch(leaky[0].error, /abc\.def|AAAA/, 'machine output is redacted like Check setup');
  const missed = await runSteps(STEPS.slice(1, 2), async () => ({ ok: false, error: 'blocked', version: '0.21.0' }));
  assert.equal(missed[0].to, '0.21.1', 'a failed step still names the version it did not reach');
  assert.deepEqual([rows[1].state, rows[1].error], ['failed', 'ssh: connection reset']);
});

test('a clean run ends with the app staged for restart and one report for the bot', async () => {
  const rows = await runSteps(STEPS, async () => ({ ok: true }));
  assert.deepEqual(rows.map((row) => row.state), ['done', 'done', 'done', 'done']);
  assert.equal(summarizeRun(rows), 'Everything is updated. Restart to finish the app update.');
  assert.equal(reportText(rows), 'Update everything finished. Now on Hermes 0.21.7, plugin 0.21.1, browser host 0.21.5. The app installs 0.21.5 when you restart it.');
});

test('a step that finished without moving is named as unchanged, never claimed as updated', async () => {
  // A catalog install stays on its reviewed pin even when a newer tag exists.
  const rows = await runSteps(STEPS.slice(0, 2), async (step) => ({ ok: true, version: step.id === 'plugin' ? '0.21.0' : '0.21.7' }));
  assert.equal(summarizeRun(rows), 'Done. Still on the same version: Alan’s Way plugin (0.21.0).');
  assert.equal(reportText(rows), 'Update everything finished. Now on Hermes 0.21.7. Unchanged: plugin 0.21.0.');
});
