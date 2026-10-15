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
  vm.runInNewContext(fn + '\nrenderUpdateAll();', { $, state: { versions }, updateAllOpen: true, updateAllView: 'plan', scheduleLayout() {},
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

test('DIY server save discards old-machine evidence and schedules an immediate check', async () => {
  const source = fs.readFileSync(require.resolve('../src/main.cjs'), 'utf8');
  // Stop at the first SSH result: the production save path runs, all external work is stubbed.
  const start = source.indexOf('async function cloudConnectRun(');
  const end = source.indexOf('    const remote =', start);
  const timers = [], prefs = { versionCache: { ...current }, vpsBrowser: { sshHost: 'old.invalid' } };
  const context = { prefs, isSshTarget: () => true, savePreferences() {}, checkVersionsWhenIdle() {},
    setTimeout: (fn, ms) => timers.push({ fn, ms }), sshRun: async () => ({ code: 1, out: '' }) };
  vm.createContext(context);
  await vm.runInContext(source.slice(start, end) + '\n}}\ncloudConnectRun("new.invalid");', context);
  assert.equal(prefs.vpsBrowser.sshHost, 'new.invalid');
  assert.equal(Object.keys(prefs.versionCache).length, 0);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].fn, context.checkVersionsWhenIdle);
  assert.equal(timers[0].ms, 0);
});
