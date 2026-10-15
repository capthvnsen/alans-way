const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const onboarding = require('../src/onboarding.cjs');
const cloudMigrate = require('../src/cloud-migrate.cjs');

const source = fs.readFileSync(path.join(__dirname, '../src/main.cjs'), 'utf8');
function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from);
  return source.slice(from, to);
}

// Run the shipped commands and state projection with fixture-only preferences.
// No Electron startup, SSH, local migration, clipboard or network is available.
function fixture(cloud) {
  const prefs = { onboarded: false, cloud, vpsBrowser: { sshHost: 'user@server.example' } };
  const saved = [];
  const context = vm.createContext({
    ...onboarding, prefs, readPreferences: () => prefs, cloudMigrate, cloudComputer: null, cloudError: '',
    cloudClaim: { apiBase: () => 'https://cloud.example' },
    cloudSession: () => prefs.cloud.sessionEnc ? 'fixture-session' : '',
    trustSender: () => {}, seedMacSshHost: () => {}, applyLayout: () => {}, broadcastNow: () => {},
    activeTabId: 'settings', savePreferences: () => saved.push(structuredClone(prefs)),
  });
  vm.runInContext(section('function cloudView() {', '\n// The wait step'), context);
  context.getState = () => context.cloudView();
  const run = vm.runInContext(`${section('  const runCommand = async', '\n  // Failed actions')}\nrunCommand;`, context);
  return { prefs, saved, view: () => context.cloudView(), command: (name, value) => run(null, name, value),
    launch: () => vm.runInContext(section('    prefs = readPreferences();', '    // A cold start'), context) };
}

test('a hosted user can choose Bring and then start fresh without retaining the choice', async () => {
  const f = fixture({ sessionEnc: 'fixture', step: 'migrate' });
  await f.command('cloud-migrate', { choice: 'bring' });
  assert.equal(f.view().step, 'migrate');
  assert.equal(f.view().migration, 'bring');
  assert.ok(f.view().migrateCommand);
  await f.command('cloud-migrate', { choice: 'fresh' });
  assert.equal(f.view().step, 'model');
  assert.equal(f.view().migration, '', 'Start fresh must clear the saved Bring choice');
  assert.equal(f.view().migrateCommand, '');
  assert.equal(f.saved.at(-1).cloud.migration, undefined);
  assert.equal(f.prefs.onboarded, false);
});

for (const step of ['migrate', 'model', 'telegram', 'done']) {
  test(`Run setup wizard restores the hosted migration choice from ${step}`, async () => {
    const f = fixture({ sessionEnc: 'fixture', step, migration: 'bring', computerName: 'alan-fixture' });
    f.prefs.onboarded = step === 'done';
    await f.command('onboarding-open');
    assert.equal(f.view().step, 'migrate');
    assert.equal(f.view().migration, '', 'the wizard must show the choice rather than the Bring command');
    assert.equal(f.prefs.onboarded, false);
    assert.equal(f.saved.at(-1).cloud.step, 'migrate');
    assert.equal(f.saved.at(-1).cloud.migration, undefined);
    assert.equal(f.prefs.cloud.sessionEnc, 'fixture');
    assert.equal(f.prefs.cloud.computerName, 'alan-fixture');
    await f.command('cloud-migrate', { choice: 'fresh' });
    assert.equal(f.view().step, 'model');
  });
}

for (const step of ['cloud-wait', 'connect', 'support']) {
  test(`Run setup wizard preserves the hosted ${step} prerequisite`, async () => {
    const f = fixture({ sessionEnc: 'fixture', step });
    await f.command('onboarding-open');
    assert.equal(f.view().step, step);
  });
}

for (const sessionEnc of [undefined, 'fixture']) {
  test(`launch repairs and saves an older DIY migration step${sessionEnc ? ' even with a stored claim' : ''}`, () => {
    const f = fixture({ diy: true, sessionEnc, step: 'migrate', migration: 'bring', profiles: ['personal'] });
    f.launch();
    assert.equal(f.view().step, 'model', 'an upgraded DIY setup must not resume migration');
    assert.equal(f.view().migration, '');
    assert.equal(f.saved.at(-1)?.cloud.step, 'model', 'the repair must survive a restart');
    assert.equal(f.saved.at(-1).cloud.migration, undefined);
    assert.deepEqual(f.prefs.cloud.profiles, ['personal']);
    assert.equal(f.prefs.onboarded, false);
    const saves = f.saved.length;
    f.launch();
    assert.equal(f.saved.length, saves, 'a second launch needs no further repair');
  });
}

test('launch still resumes a hosted Bring choice without resetting it', () => {
  const f = fixture({ sessionEnc: 'fixture', step: 'migrate', migration: 'bring' });
  f.launch();
  assert.equal(f.view().step, 'migrate');
  assert.equal(f.view().migration, 'bring');
});

test('Run setup wizard keeps a DIY server out of hosted migration even with a stored claim', async () => {
  const f = fixture({ diy: true, sessionEnc: 'fixture', step: 'model' });
  await f.command('onboarding-open');
  assert.equal(f.view().step, 'model');
});
