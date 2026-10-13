const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const U = require('../src/update-all.cjs');
const V = require('../src/vm-update.cjs');

const target = { id: 'fixture', label: 'fixture', local: true };
const secret = 'git://synthetic-user:synthetic-password@host/repo?session=synthetic-query#synthetic-fragment';
const surfaces = (rows) => [JSON.stringify(rows), U.summarizeRun(rows), U.runLogText(rows), U.reportText(rows)].join('\n');

test('planning retains every managed plugin/profile and schedules any stale or unverified version', () => {
  for (const name of ['alans-way', 'alans-way-computer']) for (const profile of ['default', 'work']) {
    for (const version of ['0.7.0', 'unknown']) {
      const plugins = ['alans-way', 'alans-way-computer'].flatMap((n) => ['default', 'work'].map((p) =>
        ({ name: n, profile: p, version: n === name && p === profile ? version : '0.21.5' })));
      const cache = U.versionRecord(null, { target, check: { ok: true, pluginVersion: '0.21.5', plugins }, pluginLatest: '0.21.5', now: 1 });
      assert.deepEqual(cache.plugins, plugins);
      assert.deepEqual(U.planSteps({ app: '0.21.5', cache }).map((s) => s.id), ['plugin']);
    }
  }
});

test('host adapter carries guest plugin warnings to every update surface', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/main.cjs'), 'utf8');
  const start = source.indexOf('async function runUpdateStep('), end = source.indexOf('\n// Offline', start);
  const guest = { ok: true, version: '0.21.5', plugins: [{ name: 'alans-way-computer', profile: 'work', after: '0.7.0', status: 'current', error: 'already at catalog pin abc' }] };
  const updater = V.createVmUpdater({ readScript: () => '# fixture', run: async () => ({ code: 0, out: JSON.stringify(guest), err: '' }) });
  const adapter = new Function('vmUpdater', 'noteVmResult', 'savePreferences', source.slice(start, end) + '\nreturn runUpdateStep;')(updater, () => {}, () => {});
  const rows = await U.runSteps([{ id: 'host', name: 'host', from: '0.7.0', to: '0.21.5' }], (s) => adapter(s, target));
  assert.equal(rows[0].state, 'warn');
  for (const text of [rows[0].warningText, U.summarizeRun(rows), U.runLogText(rows), U.reportText(rows)]) {
    assert.match(text, /alans-way-computer.*work.*catalog pin/);
    assert.doesNotMatch(text, /Everything is updated/);
  }
});

test('the app boundary scrubs raw stderr, thrown errors and nested guest data before every consumer', async () => {
  for (const mode of ['stderr', 'throw', 'json']) {
    const logs = [];
    const updater = V.createVmUpdater({ readScript: () => '# fixture', log: (...args) => logs.push(args), run: async () => {
      if (mode === 'throw') throw new Error('execution failed ' + secret);
      if (mode === 'stderr') return { code: 255, out: '', err: 'execution failed ' + secret };
      return { code: 0, out: JSON.stringify({ ok: false, error: secret, messages: [{ profile: 'work', sent: false, error: secret }],
        plugins: [{ name: 'alans-way', profile: 'work', status: 'skipped', error: secret }], findings: [{ fix: secret }] }), err: '' };
    } });
    for (const operation of [() => updater.updateVm(target, 'v0.21.5'), () => updater.updatePluginsVm(target),
      () => updater.hermesUpdateVm(target), () => updater.checkVm(target), () => updater.doctorVm(target)]) {
      const result = await operation();
      const rows = await U.runSteps([{ id: 'hermes', name: 'Hermes', from: '0.21.6', to: 'latest' }], () => result);
      const text = [JSON.stringify(result), V.hermesUpdateDetail(result, 'fixture'), surfaces(rows), JSON.stringify(logs)].join('\n');
      assert.doesNotMatch(text, /synthetic-/);
      assert.match(result.error, /host\/repo/);
    }
  }
});

test('catalog pins at or above target are current; stale pins keep their warning reason', async () => {
  const step = { id: 'plugin', name: 'plugin', from: '0.7.0', to: '0.21.5' };
  for (const after of ['"0.21.5" # release', '0.21.6', '0.7.0']) {
    const result = U.pluginStepResult({ ok: true, plugins: [{ name: 'alans-way', profile: 'default', after, status: 'current', error: 'already at catalog pin abc' }] }, step);
    const rows = await U.runSteps([step], () => result);
    assert.equal(rows[0].state, after === '0.7.0' ? 'warn' : 'done');
    assert.match(rows[0].detail, /already at catalog pin abc/);
  }
});

test('malformed Hermes evidence never claims success in standalone settings', () => {
  for (const current of [false, true]) {
    const text = V.hermesUpdateDetail({ ok: true, before: 'bad-old', version: 'bad-new', updated: true, current, messaged: true }, 'fixture');
    assert.match(text, /warning.*unverified/);
    assert.doesNotMatch(text, /Hermes updated|already up to date/);
  }
});

test('successful guest reports and long stderr are sanitized before storage and display', async () => {
  const guest = { ok: true, findings: [{ fix: secret }], messages: [{ profile: 'work', sent: false, error: secret }],
    plugins: [{ name: 'alans-way', profile: 'work', after: '0.7.0', status: 'skipped', error: secret }] };
  const updater = V.createVmUpdater({ readScript: () => '# fixture', run: async () => ({ code: 0, out: JSON.stringify(guest), err: '' }) });
  const report = await updater.doctorVm(target);
  assert.equal(report.ok, true);
  assert.doesNotMatch(JSON.stringify(report), /synthetic-/);
  assert.match(report.findings[0].fix, /host\/repo/);
  const long = V.createVmUpdater({ readScript: () => '# fixture', run: async () => ({ code: 255, out: '', err: secret + '&padding=' + 'x'.repeat(500) }) });
  assert.doesNotMatch(JSON.stringify(await long.hermesUpdateVm(target)), /synthetic-/);
});
