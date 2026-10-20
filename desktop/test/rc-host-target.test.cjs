const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { latestHostRelease, versionRecord, describeVersions, planSteps } = require('../src/update-all.cjs');

const cache = { where: 'server', checkedAt: 1, host: '0.21.5', hostLatest: '0.21.6', plugins: [] };
const hostStep = (options) => planSteps({ cache, ...options }).find((step) => step.id === 'host');

async function retryHost({ appVersion = '0.21.7-rc.2', force = true, installed = '0.21.5', hostLatest = '0.21.6' } = {}) {
  const source = fs.readFileSync(require.resolve('../src/main.cjs'), 'utf8');
  const start = source.indexOf("      case 'vm-update-retry': {");
  const branch = source.slice(start, source.indexOf("      case 'hermes-update':", start));
  const calls = [];
  const context = { value: { force }, prefs: { versionCache: { hostLatest }, vmUpdates: { server: { version: installed } } },
    app: { getVersion: () => appVersion }, update: {}, vmRetrying: false, hermesUpdating: false, updatingAll: false,
    updateLocked: () => false, broadcast() {}, waitForVersionCheck: async () => {},
    ...require('../src/update-all.cjs'), stagedAppVersion: () => '',
    vmTargets: () => [{ id: 'server' }], vmProgress: {}, noteVmProgress() {}, noteVmResult() {},
    vmProgressResult: result => result, savePreferences() {}, macUpdate: require('../src/mac-update.cjs'),
    vmUpdater: { updateVm: async (target, tag) => { calls.push(tag); return { ok: true }; } },
  };
  try { await vm.runInNewContext(`(async () => { switch ('vm-update-retry') { ${branch} } })()`, context); }
  finally { assert.equal(context.vmRetrying, false, 'a failed target lookup must release the update lock'); }
  return calls;
}

test('Settings Update server uses the stable host target for a prerelease app', async () => {
  assert.deepEqual(await retryHost(), ['v0.21.6']);
  assert.deepEqual(await retryHost({ force: false, installed: '0.21.6' }), []);
  assert.deepEqual(await retryHost({ appVersion: '0.21.7' }), ['v0.21.7']);
  await assert.rejects(retryHost({ hostLatest: '' }), /stable.*release|component versions/i);
});

test('RC apps target the latest stable host release, including when another RC is staged', () => {
  for (const appUpdate of ['', '0.21.7-rc.3']) {
    assert.equal(hostStep({ app: '0.21.7-rc.2', appUpdate })?.to, '0.21.6');
    const view = describeVersions({ app: '0.21.7-rc.2', appUpdate, cache });
    assert.equal(view.components.find((row) => row.id === 'host').status, 'latest 0.21.6');
    assert.match(view.tooltip, /Browser host 0\.21\.5 on the server · 0\.21\.6 goes with this app/);
  }
});

test('stable apps and staged stable updates retain their host target', () => {
  assert.equal(hostStep({ app: '0.21.7' })?.to, '0.21.7');
  assert.equal(hostStep({ app: '0.21.7', appUpdate: '0.21.8' })?.to, '0.21.8');
  assert.equal(hostStep({ app: '0.21.7-rc.2', appUpdate: '0.21.7' })?.to, '0.21.7');
});

test('RC host planning never invents a stable tag, downgrades, or updates local/offline hosts', () => {
  for (const hostLatest of ['', '0.21.7-rc.3', '0.21.6+build.1', 'garbage']) {
    const options = { app: '0.21.7-rc.2', cache: { ...cache, hostLatest } };
    assert.equal(hostStep(options), undefined, hostLatest);
    assert.equal(describeVersions(options).components.find((row) => row.id === 'host').status, 'latest not checked yet');
  }
  for (const changes of [{ host: '0.21.6' }, { host: '0.21.7' }, { where: 'local' }, { offline: true }]) {
    assert.equal(hostStep({ app: '0.21.7-rc.2', cache: { ...cache, ...changes } }), undefined);
  }
});

test('host release lookup accepts only a published stable tag from the app repository', async () => {
  const fetchRelease = (body) => async (url, options) => {
    assert.equal(url, 'https://api.github.com/repos/capthvnsen/alans-way/releases/latest');
    assert.ok(options.signal);
    return { ok: true, json: async () => body };
  };
  assert.equal(await latestHostRelease(fetchRelease({ tag_name: 'v0.21.6', prerelease: false, draft: false })), '0.21.6');
  for (const body of [null, {}, { tag_name: 'v0.21.7-rc.2' }, { tag_name: 'v0.21.7', prerelease: true }, { tag_name: 'v0.21.7', draft: true }]) {
    assert.equal(await latestHostRelease(fetchRelease(body)), '');
  }
  assert.equal(await latestHostRelease(async () => ({ ok: false })), '');
});

test('version probes cache the stable host release and retain it on a failed lookup', () => {
  const probe = { target: {}, check: { ok: true, hostVersion: '0.21.5' }, hostLatest: '0.21.6', now: 1 };
  const record = versionRecord(null, probe);
  assert.equal(record.hostLatest, '0.21.6');
  assert.equal(versionRecord(record, { ...probe, hostLatest: '', now: 2 }).hostLatest, '0.21.6');
  assert.equal(hostStep({ app: '0.21.7-rc.2', cache: record })?.to, '0.21.6');
});
