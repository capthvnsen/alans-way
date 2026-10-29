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
function fixture(cloud, { sshRun, sshWrite, telegramView = null, openBot = async () => {} } = {}) {
  const prefs = { onboarded: false, cloud, vpsBrowser: { sshHost: 'user@server.example' } };
  const saved = [];
  const context = vm.createContext({
    ...onboarding, prefs, sshRun, sshWrite, profileInventoryCommand: require('../src/env-write.cjs').profileInventoryCommand,
    cloudModel: require('../src/cloud-model.cjs'), cloudTelegram: require('../src/cloud-telegram.cjs'),
    cloudConnect: require('../src/cloud-connect.cjs'), telegramView, broadcast() {}, readPreferences: () => prefs, cloudMigrate, cloudComputer: null, cloudError: '',
    cloudClaim: { apiBase: () => 'https://cloud.example' },
    cloudSession: () => prefs.cloud.sessionEnc ? 'fixture-session' : '',
    trustSender: () => {}, seedMacSshHost: () => {}, applyLayout: () => {}, broadcastNow: () => {},
    createHermesHub: () => ({ getState: () => ({}) }), loadHermesPersisted: () => null, saveHermesPersisted() {}, pushHermesState() {},
    activeTabId: 'settings', savePreferences: () => saved.push(structuredClone(prefs)),
    openTelegramUsername: async username => { await openBot(username); prefs.selectedBotId = 'fixture-bot-id'; },
  });
  vm.runInContext(section('async function cloudKeepServerModel(', '\n// The connect step'), context);
  vm.runInContext(section('function cloudView() {', '\n// The wait step'), context);
  vm.runInContext(section('async function cloudWriteEnv(', '\n// Minted or pasted'), context);
  vm.runInContext(section('async function cloudFinishTelegram(', '\n// Local and remote probes'), context);
  context.getState = () => context.cloudView();
  const run = vm.runInContext(`${section('  const runCommand = async', '\n  // Failed actions')}\nrunCommand;`, context);
  return { prefs, saved, finishTelegram: (...args) => context.cloudFinishTelegram(...args), view: () => context.cloudView(), command: (name, value) => run(null, name, value),
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
    assert.equal(f.view().step, step === 'done' ? '' : 'model');
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

// Review repro: complete the real bot writer, reopen, choose fresh, and only
// offer another bot if the shipped state machine leads to Telegram again.
for (const legacy of [false, true]) {
  test(`completed hosted setup preserves its bot on Start fresh (${legacy ? 'older saved state' : 'new completion'})`, async () => {
    let env = 'TELEGRAM_BOT_TOKEN=fixture-original\n';
    const writes = [];
    const scripts = [];
    const f = fixture({ sessionEnc: 'fixture', ...(legacy ? { step: 'done', botUsername: 'original_bot' } : { step: 'telegram' }) }, {
      sshRun: async (_, command) => ({ code: 0, out: (command.startsWith('ls ') || command === require('../src/env-write.cjs').profileInventoryCommand) ? 'personal\n' : command.startsWith('cat ') ? env : 'anthropic: logged in' }),
      sshWrite: async (_, file, value) => { writes.push(file); env = require('../src/cloud-model.cjs').setEnvValue(env, value.key, value.value); return { code: 0 }; },
      // Completion requires the embedded bot chat to accept /start (#165).
      telegramView: { webContents: { isDestroyed: () => false,
        executeJavaScript: async (script) => { scripts.push(script); return { ok: true }; } } },
    });
    if (!legacy) {
      assert.equal((await f.finishTelegram('fixture-original', 'original_bot')).done, true);
      assert.equal(writes.length, 1, 'initial setup must exercise the real bot token writer');
      assert.deepEqual(scripts, [require('../src/cloud-telegram.cjs').sendMessageScript('original_bot', '/start')]);
    }
    assert.equal(f.prefs.cloud.step, 'done');
    writes.length = 0;
    scripts.length = 0;
    const originalEnv = env;
    await f.command('onboarding-open');
    assert.equal(f.view().step, 'migrate');
    await f.command('cloud-migrate', { choice: 'fresh' });
    if (f.view().step === 'model') await f.command('cloud-model-check');
    if (f.view().step === 'telegram') await f.finishTelegram('fixture-replacement', 'replacement_bot');
    assert.equal(writes.length, 0, 'replaying completed setup must never replace the working bot token');
    assert.equal(scripts.length, 0, 'replaying completed setup must not restart the bot chat');
    assert.equal(env, originalEnv);
    assert.equal(f.prefs.cloud.botUsername, 'original_bot');
    assert.equal(f.prefs.cloud.step, 'done', 'completed setup changes migration choice only');
    assert.equal(f.prefs.onboarded, true);
    assert.equal(f.saved.at(-1).cloud.step, 'done');
  });
}

for (const choice of ['fresh', 'bring']) {
  test(`completed migration review survives restart and finishes ${choice} without model or bot setup`, async () => {
    const remote = {
      sshRun: async (_, command) => {
        if (command === cloudMigrate.migrateCheckCommand()) return { code: 0, out: '/fixture/.hermes/.migrated' };
        if (command === cloudMigrate.profilesWithTokenCommand()) return { code: 0, out: '/fixture/.hermes/profiles/personal/.env' };
        assert.equal(command, 'ls ~/.hermes/profiles 2>/dev/null');
        return { code: 0, out: 'personal\n' };
      },
    };
    const f = fixture({ sessionEnc: 'fixture', step: 'done', botUsername: 'original_bot' }, remote);
    await f.command('onboarding-open');
    await f.command('cloud-migrate', { choice: 'bring' });
    const resumed = fixture(structuredClone(f.saved.at(-1).cloud), choice === 'bring' ? remote : {
      sshRun: async () => { throw new Error('Start fresh must not touch the host'); },
    });
    resumed.launch();
    if (choice === 'fresh') await resumed.command('cloud-migrate', { choice });
    else {
      const result = await resumed.command('cloud-migrate-check');
      assert.equal(result.done, true);
    }
    const done = resumed;
    assert.equal(done.prefs.cloud.step, 'done');
    assert.equal(done.prefs.onboarded, true);
    assert.equal(done.prefs.cloud.botUsername, 'original_bot');
    await done.command('onboarding-open');
    assert.equal(done.view().step, 'migrate', 'the migration choice remains reversible on subsequent reopens');
    await done.command('cloud-migrate', { choice: 'fresh' });
    assert.equal(done.prefs.cloud.step, 'done');
  });
}

test('an unfinished hosted migration still continues through model setup', async () => {
  const f = fixture({ sessionEnc: 'fixture', step: 'migrate', migration: 'bring' }, {
    sshRun: async () => ({ code: 0, out: '/fixture/.hermes/.migrated' }),
  });
  await f.command('cloud-migrate-check');
  assert.equal(f.view().step, 'model');
  assert.equal(f.prefs.onboarded, false);
});

for (const tokenedProfiles of [[], ['*']]) {
  test(`DIY users stuck at model can keep their server model without SSH or credentials (tokens: ${tokenedProfiles.length})`, async () => {
    const f = fixture({ diy: true, step: 'model', tokenedProfiles }, {
      sshRun: async () => { assert.fail('manual keep must not need a working probe'); },
      sshWrite: async () => { assert.fail('keep must never write credentials'); },
    });
    await f.command('cloud-model-existing');
    assert.equal(f.prefs.cloud.step, tokenedProfiles.length ? 'bot-chat' : 'telegram');
    assert.equal(f.prefs.onboarded, false, 'the existing bot still needs the setup prompt');
    assert.equal(f.prefs.cloud.model, 'existing');
    assert.equal(f.saved.at(-1).cloud.model, 'existing');
  });
}

test('hosted users cannot use the DIY model escape', async () => {
  const f = fixture({ sessionEnc: 'fixture', step: 'model' });
  await assert.rejects(f.command('cloud-model-existing'), /own server/i);
  assert.equal(f.prefs.cloud.step, 'model');
  assert.equal(f.saved.length, 0);
});


test('resuming a DIY model card detects and displays the existing provider', async () => {
  const calls = [];
  const f = fixture({ diy: true, step: 'model' }, {
    sshRun: async (host, command, options) => {
      calls.push(command);
      assert.equal(host, 'user@server.example');
      const model = require('../src/cloud-model.cjs');
      if (command === cloudMigrate.profilesWithTokenCommand()) return { code: 0, out: '/fixture/.hermes/profiles/personal/.env' };
      if (command === 'ls ~/.hermes/profiles 2>/dev/null') return { code: 0, out: 'personal\nwork\n' };
      assert.equal(command, model.existingModelCommand());
      assert.equal(options.timeoutMs, 8000);
      return { code: 0, out: 'openrouter\nopenai/gpt-4.1\n' };
    },
    sshWrite: async () => assert.fail('detection must never write'),
  });
  assert.equal((await f.command('cloud-model-detect')).done, false);
  assert.equal(calls.length, 3, 'model detection also inventories existing DIY bots');
  assert.equal(f.view().step, 'model');
  assert.equal(f.view().modelDetected, true);
  assert.equal(f.view().model, '');
  assert.equal(f.view().existingModel.provider, 'openrouter');
  assert.equal(f.view().existingModel.model, 'openai/gpt-4.1');
  assert.deepEqual(Array.from(f.view().tokenedProfiles), ['personal']);
  const resumed = fixture(structuredClone(f.saved.at(-1).cloud));
  assert.equal(resumed.view().existingModel.model, 'openai/gpt-4.1');
});

test('a late detection does not undo the manual keep choice', async () => {
  let finish;
  const f = fixture({ diy: true, step: 'model' }, { sshRun: () => new Promise(resolve => { finish = resolve; }) });
  const pending = f.command('cloud-model-detect');
  await f.command('cloud-model-existing');
  finish({ code: 0, out: 'openrouter\nopenai/gpt-4.1' });
  assert.equal((await pending).done, false);
  assert.equal(f.prefs.cloud.step, 'telegram');
  assert.equal(f.prefs.cloud.existingModel, undefined);
  assert.equal(f.saved.length, 1);
});

for (const step of ['telegram', 'done']) {
  test(`DIY users can return from ${step} to model setup and confirm without replacing their bot`, async () => {
    const f = fixture({ diy: true, step, model: 'existing', botUsername: 'original_bot', modelDetected: true }, {
      sshRun: async () => assert.fail('reopening and manual confirmation must not run SSH'),
      sshWrite: async () => assert.fail('must preserve the bot and credentials'),
    });
    f.prefs.onboarded = step === 'done';
    await f.command('onboarding-open');
    assert.equal(f.view().step, 'model');
    assert.equal(f.view().modelDetected, false, 'reopening must allow a fresh read of model identifiers');
    assert.equal(f.prefs.onboarded, false);
    const resumed = fixture(structuredClone(f.saved.at(-1).cloud));
    await resumed.command('cloud-model-existing');
    assert.equal(resumed.prefs.cloud.step, step, 'completed setup must not repeat bot creation');
    assert.equal(resumed.prefs.cloud.botUsername, 'original_bot');
    assert.equal(resumed.prefs.onboarded, step === 'done');
  });
}

test('DIY existing-bot setup selects a profile and opens the bot without writing or restarting', async () => {
  const opened = [];
  const f = fixture({ diy: true, step: 'model', tokenedProfiles: ['personal', 'work'] }, {
    sshRun: async () => assert.fail('keeping a bot must not read credentials or restart the gateway'),
    sshWrite: async () => assert.fail('keeping a bot must not write credentials'),
    openBot: async username => opened.push(username),
  });
  await f.command('cloud-model-existing');
  assert.equal(f.view().step, 'bot-chat');
  await assert.rejects(f.command('cloud-existing-bot', { username: 'work_bot' }), /profile/);
  await assert.rejects(f.command('cloud-existing-bot', { profile: 'work', username: 'bad?username' }), /username/);
  assert.equal(f.prefs.cloud.existingBotId, undefined);
  assert.equal((await f.command('cloud-existing-bot', { profile: 'work', username: '@work_bot' })).ok, true);
  assert.deepEqual(opened, ['work_bot']);
  assert.equal(f.view().existingBotId, 'fixture-bot-id');
  assert.equal(f.view().existingBotProfile, 'work');
  assert.equal(f.view().step, 'bot-chat', 'keep the setup prompt available until the user finishes');
  await f.command('cloud-next');
  assert.equal(f.prefs.cloud.step, 'done');
  assert.equal(f.prefs.onboarded, true);
});

test('a failed existing bot open keeps the wizard unfinished and can be retried', async () => {
  let failed = true;
  const f = fixture({ diy: true, step: 'bot-chat', tokenedProfiles: ['*'] }, {
    openBot: async () => { if (failed) throw Error('fixture Telegram offline'); },
  });
  const choice = { profile: '*', username: 'shared_bot' };
  await assert.rejects(f.command('cloud-existing-bot', choice), /offline/);
  assert.equal(f.view().existingBotId, '');
  assert.equal(f.view().step, 'bot-chat');
  assert.equal(f.prefs.onboarded, false);
  failed = false;
  assert.equal((await f.command('cloud-existing-bot', choice)).ok, true);
});

test('hosted users cannot enter the DIY existing-bot handler', async () => {
  const f = fixture({ sessionEnc: 'fixture', step: 'telegram' });
  await assert.rejects(f.command('cloud-existing-bot', { username: 'work_bot' }), /existing bot setup/);
  assert.equal(f.view().step, 'telegram');
});

test('older DIY saves at Telegram inventory profiles before opening their existing bot', async () => {
  const f = fixture({ diy: true, step: 'telegram' }, {
    sshRun: async (_, command) => ({ code: 0, out: command === cloudMigrate.profilesWithTokenCommand()
      ? '/fixture/.hermes/profiles/personal/.env\n/fixture/.hermes/profiles/work/.env' : 'personal\nwork\n' }),
    sshWrite: async () => assert.fail('inventory must never write credentials'),
  });
  await f.command('cloud-goto', { step: 'bot-chat' });
  assert.equal(f.view().step, 'bot-chat');
  assert.deepEqual(Array.from(f.view().tokenedProfiles), ['personal', 'work']);
});

test('a late bot inventory cannot roll back a manual model choice', async () => {
  const pending = [];
  const f = fixture({ diy: true, step: 'model' }, {
    sshRun: async (_, command) => command.includes('hermes config get')
      ? { code: 0, out: 'openrouter\nopenai/gpt-4.1' }
      : new Promise(resolve => pending.push(resolve)),
  });
  const detection = f.command('cloud-model-detect');
  await new Promise(setImmediate);
  assert.equal(pending.length, 2);
  await f.command('cloud-model-existing');
  pending[0]({ code: 0, out: '/fixture/.hermes/.env' });
  pending[1]({ code: 0, out: 'personal\n' });
  assert.equal((await detection).cancelled, true);
  assert.equal(f.view().step, 'telegram');
  assert.equal(f.prefs.cloud.tokenedProfiles, undefined);
  assert.equal(f.prefs.cloud.model, 'existing');
});
