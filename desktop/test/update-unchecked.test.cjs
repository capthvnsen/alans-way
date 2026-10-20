const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const U = require('../src/update-all.cjs');
const app = '0.21.6';
const current = { where: 'server', checkedAt: 1, offline: false, hermes: '0.22.1', hermesUpdate: false,
  plugins: [{ name: 'alans-way', profile: 'default', version: app }], pluginLatest: app, host: app };
const view = (cache, extra = {}) => U.describeVersions({ app, cache, ...extra });

function renderPlan(versions) {
  const nodes = new Map();
  const $ = (id) => {
    if (!nodes.has(id)) nodes.set(id, { textContent: '', children: [], classList: { contains: () => false, toggle() {} },
      replaceChildren() { this.children = []; }, append(p) { this.children.push(p); }, focus() {} });
    return nodes.get(id);
  };
  const source = fs.readFileSync(require.resolve('../src/renderer.js'), 'utf8');
  const fn = source.slice(source.indexOf('function renderUpdateAll()'), source.indexOf('\nfunction closeUpdateAll()'));
  vm.runInNewContext(fn + '\nrenderUpdateAll();', { $, state: { versions }, updateAllOpen: true, updateAllView: 'plan', scheduleLayout() {}, setDialogVisible() {},
    element: (tag, className, textContent) => ({ textContent, className }) });
  return $;
}

test('fresh-install dialog never presents an empty plan as up to date', () => {
  const $ = renderPlan(view({}));
  assert.doesNotMatch($('update-all-copy').textContent, /Everything is up to date/);
  const rows = $('update-all-steps').children.map(p => p.textContent).join('\n');
  for (const name of ['Alan’s Workspace', 'Hermes', 'Alan’s Way plugin', 'Browser host']) assert.ok(rows.includes(name), rows);
  assert.match(rows, /not checked yet/i);
});

test('only read installed versions and a known latest verdict certify all components', () => {
  assert.equal(view(current, { appLatest: app }).upToDate, true);
  for (const cache of [{}, { ...current, offline: true }, { ...current, hermesUpdate: null }, { ...current, pluginLatest: '' },
    { ...current, plugins: [] }, { ...current, plugins: undefined }, { ...current, host: '' }, { ...current, host: 'garbage' },
    { ...current, plugins: [{ name: 'alans-way', profile: 'default', version: 'garbage' }] },
    { ...current, plugins: [...current.plugins, { name: 'alans-way-computer', profile: 'work', version: '0.21.5' }] }]) {
    assert.equal(view(cache, { appLatest: app }).upToDate, false, JSON.stringify(cache));
  }
  assert.equal(view(current).upToDate, false, 'installed app version alone is no latest check');
  assert.equal(view(current, { appLatest: '0.21.7' }).upToDate, false, 'an unstaged app update is still an update');
  assert.equal(view({ ...current, host: '0.21.7' }, { appLatest: app, appUpdate: '0.21.7' }).upToDate, false, 'a staged update cannot be hidden by an older latest result');
});

test('a successful fresh-server probe distinguishes absent components from unchecked ones', () => {
  const cache = U.versionRecord({}, { target: {}, now: 1, pluginLatest: app,
    check: { ok: true, hermesVersion: 'Hermes Agent v0.22.1', hermesCheck: 'up to date', plugins: [], hostVersion: '' } });
  const components = view(cache).components;
  assert.equal(components.find(c => c.id === 'plugin').status, 'not installed');
  assert.equal(components.find(c => c.id === 'host').status, 'not installed');
  assert.equal(view({}).components.find(c => c.id === 'plugin').status, 'not checked yet');
});

// Exercise address changes at the shipped onboarding/settings boundaries. All
// machine I/O stops at a stubbed SSH failure, before any remote setup can run.
for (const route of ['DIY', 'hosted', 'settings']) {
  test(`${route} server save discards old-machine evidence and schedules an immediate check`, async () => {
    const source = fs.readFileSync(require.resolve('../src/main.cjs'), 'utf8');
    const timers = [], prefs = { versionCache: { ...current }, vpsBrowser: { sshHost: 'old.invalid' },
      cloud: { computerName: 'fixture', botInventoryChecked: true, tokenedProfiles: ['old'], profiles: ['old'], existingBotId: '101', existingBotProfile: 'old' } };
    const context = { prefs, isSshTarget: () => true, savePreferences() {}, checkVersionsWhenIdle() {},
      setTimeout: (fn, ms) => timers.push({ fn, ms }), sshRun: async () => ({ code: 1, out: '' }),
      cloudComputer: null, cloudConnect: { ...require('../src/cloud-connect.cjs'), tailscaleCli: () => 'fixture-tailscale' },
      localRun: async () => ({ code: 0, out: JSON.stringify({ Peer: { fixture: { HostName: 'fixture', TailscaleIPs: ['192.0.2.7'], Online: true } } }) }),
      value: { vpsBrowser: { sshHost: 'new.invalid' } }, checkScriptPath: () => '', followVmRemoteUrl: () => '',
      refreshVpsTabs() {}, applyLayout() {}, persistSettingsPreferences: (next) => Object.assign(prefs, next) };
    vm.createContext(context);
    const revisions = source.indexOf('const settingsWriteFields =');
    if (revisions !== -1) vm.runInContext(source.slice(revisions, source.indexOf('\nfunction settingsWriteEntry(', revisions)), context);
    // Include the shared setter when present; on the regression base each
    // route still executes its original production save code.
    const setter = source.indexOf('function setServerConfig(');
    if (setter !== -1) vm.runInContext(source.slice(setter, source.indexOf('\n}', setter) + 2), context);
    let run;
    if (route === 'settings') {
      const start = source.indexOf("      case 'settings':");
      const end = source.indexOf("      case 'preview-move':", start);
      run = `async function save() { switch ('settings') { ${source.slice(start, end)} } } save();`;
    } else {
      const pending = source.indexOf('let cloudConnectPending =');
      const start = pending === -1 ? source.indexOf('async function cloudConnectRun(') : pending;
      const end = source.indexOf('\nasync function claimWithToken(', start);
      assert.ok(start >= 0 && end > start, 'include the connection guard and transition');
      run = source.slice(start, end) + `\ncloudConnectRun(${route === 'DIY' ? '"new.invalid"' : ''});`;
    }
    await vm.runInContext(run, context);
    assert.equal(prefs.vpsBrowser.sshHost, route === 'hosted' ? 'root@192.0.2.7' : 'new.invalid');
    const $ = renderPlan(view(prefs.versionCache, { appLatest: app }));
    assert.doesNotMatch($('update-all-copy').textContent, /Everything is up to date/);
    assert.equal(Object.keys(prefs.versionCache).length, 0);
    for (const field of ['botInventoryChecked', 'tokenedProfiles', 'profiles', 'existingBotId', 'existingBotProfile']) {
      assert.equal(prefs.cloud[field], undefined, `${route} must discard ${field} from the old server`);
    }
    assert.equal(timers.length, 1);
    assert.equal(timers[0].fn, context.checkVersionsWhenIdle);
    assert.equal(timers[0].ms, 0);
  });
}

test('packaged Linux Check now reads app releases without staging an automatic install', async () => {
  let release = `v${app}`, offline = false;
  const requests = [], intervals = [];
  // Run the real release reader with a fixture HTTP boundary.
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/mac-update.cjs'), 'utf8'), {
    module, require, fetch: async (url) => {
      requests.push(url);
      if (offline) throw new Error('fixture offline');
      return { ok: true, json: async () => ({ tag_name: release }) };
    },
  });
  const source = fs.readFileSync(require.resolve('../src/main.cjs'), 'utf8');
  const start = source.indexOf("let updateDriver = 'none';");
  const end = source.indexOf('\nfunction cloudSession()', start);
  const update = {}, context = { app: { isPackaged: true, getVersion: () => app }, prefs: { lastVersion: app }, update,
    process: { platform: 'linux', execPath: '/fixture/alans-way' }, path: require('node:path'), macUpdate: module.exports,
    mainLog: () => ({ write() {} }), savePreferences() {}, savePreferencesSoon() {}, broadcast() {},
    checkVersionsWhenIdle() {}, VERSIONS_EVERY_MS: 1800000, setInterval: (fn) => intervals.push(fn) };
  vm.createContext(context);
  await vm.runInContext(source.slice(start, end) + '\nstartUpdates(); checkAppVersions();', context);
  const versions = () => view(current, { appLatest: vm.runInContext('appLatest', context) });
  assert.equal(versions().components.find(c => c.id === 'app').status, 'up to date');
  assert.equal(versions().upToDate, true);
  assert.ok(intervals.length >= 2, 'app release checking remains periodic on Linux');
  requests.length = 0;
  release = 'v0.21.7';
  await vm.runInContext('checkAppVersions();', context);
  assert.deepEqual(requests, ['https://api.github.com/repos/capthvnsen/alans-way/releases/latest']);
  assert.equal(versions().components.find(c => c.id === 'app').status, 'latest 0.21.7');
  assert.equal(versions().upToDate, false);
  assert.deepEqual(update, {}, 'reading a release cannot stage a Linux installer');
  assert.equal(vm.runInContext('updateDriver', context), 'none');
  offline = true;
  await vm.runInContext('checkAppVersions();', context);
  assert.equal(versions().components.find(c => c.id === 'app').status, 'latest not checked yet');
  assert.equal(versions().upToDate, false, 'a failed release check cannot certify currency');
});
