const { test } = require('node:test');
const assert = require('node:assert/strict');
const { latestHostRelease, versionRecord, describeVersions, planSteps } = require('../src/update-all.cjs');

const cache = { where: 'server', checkedAt: 1, host: '0.21.5', hostLatest: '0.21.6', plugins: [] };
const hostStep = (options) => planSteps({ cache, ...options }).find((step) => step.id === 'host');

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
