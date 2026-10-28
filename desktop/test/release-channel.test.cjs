'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeChannel, releaseVersion, checkLatest, canUpdate, configureUpdater, nightlyBuild } = require('../src/release-channel.cjs');
const { planSteps, stableHostTarget } = require('../src/update-all.cjs');
const stable = { tag_name: 'v0.21.13', name: 'v0.21.13', prerelease: false, draft: false };
const nightly = { tag_name: 'nightly-20261028', name: '0.21.14-nightly.20261028', prerelease: true, draft: false };

test('Stable is the default and release streams are isolated', () => {
  for (const value of [undefined, null, '', 'beta', {}, 'stable']) assert.equal(normalizeChannel(value), 'stable');
  assert.equal(normalizeChannel('nightly'), 'nightly');
  assert.equal(releaseVersion(stable, 'stable'), '0.21.13');
  assert.equal(releaseVersion(nightly, 'stable'), '');
  assert.equal(releaseVersion(stable, 'nightly'), '');
  assert.equal(releaseVersion(nightly, 'nightly'), nightly.name);
  for (const change of [{ draft: true }, { prerelease: false }, { name: '0.21.14-nightly.20261027' }, { tag_name: 'v0.21.14-rc.1' }]) assert.equal(releaseVersion({ ...nightly, ...change }, 'nightly'), '');
});

test('release lookup chooses newest published nightly, excluding drafts and RCs', async () => {
  let url;
  const fetch = async value => { url = value; return { ok: true, json: async () => [stable, nightly, { ...nightly, tag_name: 'nightly-20261029', name: '0.21.14-nightly.20261029', draft: true }, { ...nightly, tag_name: 'nightly-20261027', name: '0.21.14-nightly.20261027' }] }; };
  assert.deepEqual(await checkLatest('nightly', fetch), { tag: nightly.tag_name, version: nightly.name });
  assert.match(url, /releases\?per_page=100$/);
  assert.deepEqual(await checkLatest(undefined, async value => { assert.match(value, /releases\/latest$/); return { ok: true, json: async () => stable }; }), { tag: stable.tag_name, version: '0.21.13' });
  assert.equal(await checkLatest('nightly', async () => ({ ok: false })), null);
});

test('channel changes, older versions, equal versions and malformed versions never install', () => {
  assert.equal(canUpdate(nightly.name, '0.21.13', 'nightly', 'nightly'), true);
  assert.equal(canUpdate('0.21.14-nightly.20261029', nightly.name, 'nightly', 'nightly'), true);
  assert.equal(canUpdate(nightly.name, '0.21.13', 'stable', 'nightly'), false);
  assert.equal(canUpdate('0.21.13', nightly.name, 'stable', 'stable'), false);
  assert.equal(canUpdate('0.21.14', nightly.name, 'stable', 'stable'), true);
  for (const version of [nightly.name, 'invalid', '0.21.12']) assert.equal(canUpdate(version, nightly.name, 'nightly', 'nightly'), false);
});

test('updater uses a pinned feed and resets implicit downgrade permission', () => {
  const updater = { setFeedURL(feed) { this.feed = feed; }, set channel(value) { this.selectedChannel = value; this.allowDowngrade = true; } };
  configureUpdater(updater, 'nightly', nightly.tag_name);
  assert.equal(updater.allowDowngrade, false);
  assert.equal(updater.allowPrerelease, true);
  assert.equal(updater.autoDownload, false);
  assert.match(updater.feed.url, /releases\/download\/nightly-20261028\/$/);
  assert.equal(updater.feed.channel, 'latest');
  configureUpdater(updater, 'stable', stable.tag_name);
  assert.equal(updater.allowPrerelease, false);
  assert.equal(updater.allowDowngrade, false);
});

test('nightly version advances stable patch, date orders builds, next stable supersedes it', () => {
  assert.deepEqual(nightlyBuild('0.21.13', new Date('2026-10-28T23:59:00Z')), { tag: nightly.tag_name, version: nightly.name });
  assert.throws(() => nightlyBuild('invalid'));
  const cache = { hostLatest: '0.21.13' };
  assert.equal(stableHostTarget(nightly.name, '0.21.14-nightly.20261029', cache), '0.21.13');
  assert.ok(planSteps({ app: '0.21.13', appUpdate: nightly.name, cache }).some(step => step.id === 'app' && step.to === nightly.name));
  assert.ok(planSteps({ app: nightly.name, appUpdate: '0.21.14', cache }).some(step => step.id === 'app'));
  assert.ok(!planSteps({ app: nightly.name, appUpdate: '0.21.13', cache }).some(step => step.id === 'app'));
});

test('a staged old-channel installer is fenced from quit and explicit restart', async () => {
  const fs = require('node:fs'), vm = require('node:vm');
  const source = fs.readFileSync(require.resolve('../src/main.cjs'), 'utf8');
  const updater = {};
  const context = vm.createContext({ prefs: { releaseChannel: 'nightly' }, activeReleaseChannel: 'nightly',
    updateDriver: 'electron-updater', update: { ready: true, available: nightly.name },
    process: { platform: 'win32' }, require: () => ({ autoUpdater: updater }) });
  const start = source.indexOf('const stagedAppVersion =');
  vm.runInContext(source.slice(start, source.indexOf('const VERSIONS_EVERY_MS', start)), context);
  assert.equal(vm.runInContext('stagedAppVersion()', context), nightly.name);
  context.prefs.releaseChannel = 'stable';
  vm.runInContext('holdAppInstall(false)', context);
  assert.equal(updater.autoInstallOnAppQuit, false);
  context.process.platform = 'darwin'; context.prefs.releaseChannel = 'nightly';
  vm.runInContext('holdAppInstall(false)', context);
  assert.equal(updater.autoInstallOnAppQuit, false, 'Mac installs only on explicit restart so Squirrel never stages the old channel');
  context.prefs.releaseChannel = 'stable';
  assert.equal(vm.runInContext('stagedAppVersion()', context), '');
  const restart = source.indexOf('async function restartIntoUpdate()');
  vm.runInContext(source.slice(restart, source.indexOf('// One "Update everything" step', restart)), context);
  await assert.rejects(context.restartIntoUpdate(), /Restart the app to apply/);
});

test('the packaged updater only downloads the selected newer version and ignores in-flight channel changes', async t => {
  const fs = require('node:fs'), vm = require('node:vm'), { EventEmitter } = require('node:events');
  const source = fs.readFileSync(require.resolve('../src/main.cjs'), 'utf8');
  const launch = source.slice(source.indexOf("let updateDriver = 'none';"), source.indexOf('\nfunction cloudSession()'));
  for (const scenario of ['newer', 'older', 'equal', 'changed channel', 'mismatched manifest']) await t.test(scenario, async () => {
    const update = {}, prefs = { releaseChannel: 'nightly', lastVersion: '0.21.13' };
    let downloads = 0, resolveRelease;
    const updater = new EventEmitter();
    updater.setFeedURL = () => {};
    updater.checkForUpdates = async () => ({ updateInfo: { version: scenario === 'mismatched manifest' ? '9.0.0' : nightly.name } });
    updater.downloadUpdate = async () => { downloads++; updater.emit('update-downloaded', { version: nightly.name }); };
    const context = vm.createContext({ app: { isPackaged: true, getVersion: () => '0.21.13' }, prefs, update,
      process: { platform: 'win32', execPath: '/fixture/app' }, path: require('node:path'),
      releaseChannel: { ...require('../src/release-channel.cjs'), checkLatest: () => new Promise(resolve => { resolveRelease = resolve; }) },
      macUpdate: { updaterDriver: () => 'electron-updater' }, require: () => ({ autoUpdater: updater }),
      mainLog: () => ({ write() {} }), savePreferences() {}, savePreferencesSoon() {}, broadcast() {},
      deliverPendingUpdateReport: async () => {}, saveUpdateReport() {}, vmUpdater: {},
      checkVersionsWhenIdle() {}, VERSIONS_EVERY_MS: 1800000, setInterval() {}, logError() {},
    });
    vm.runInContext(launch + '\nstartUpdates();', context);
    if (scenario === 'changed channel') prefs.releaseChannel = 'stable';
    resolveRelease({ tag: nightly.tag_name, version: scenario === 'older' ? '0.21.12' : scenario === 'equal' ? '0.21.13' : nightly.name });
    await vm.runInContext('checkAppVersions()', context);
    assert.equal(downloads, scenario === 'newer' ? 1 : 0);
    assert.equal(Boolean(update.ready), scenario === 'newer');
    assert.equal(updater.allowDowngrade, false);
    assert.equal(updater.autoDownload, false);
  });
});
