const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const cloudConnect = require('../src/cloud-connect.cjs');
const cloudModel = require('../src/cloud-model.cjs');
const { isSshTarget } = require('../src/core.cjs');
const { cloudStep, nextCloudStep, setCloudStep } = require('../src/onboarding.cjs');

// Exercise the shipped main-process transition without booting Electron or
// touching SSH, Tailscale, local keys or the user's preferences.
const source = fs.readFileSync(path.join(__dirname, '../src/main.cjs'), 'utf8');
const start = source.indexOf('function setServerConfig(');
assert.notEqual(start, -1);
const end = source.indexOf('\nasync function claimWithToken(', start);
assert.ok(end > start);
const connectSource = source.slice(start, end);

function fixture({ diy = true, resume = false, step = 'connect', failure, model = null, tokenedProfiles = [] } = {}) {
  const host = diy ? 'user@server.example' : 'root@192.0.2.7';
  const prefs = {
    onboarded: false,
    macSshHost: 'user@computer.example',
    ...(diy && !resume ? {} : {
      cloud: { step, tokenedProfiles, ...(diy ? { diy: true } : { sessionEnc: 'fixture-session', computerName: 'alan-fixture' }) },
      vpsBrowser: { sshHost: host },
    }),
  };
  const calls = [];
  const commands = [];
  const savedSteps = [];
  const run = vm.runInNewContext(`${connectSource}\ncloudConnectRun;`, {
    prefs, isSshTarget, nextCloudStep, setCloudStep,
    setTimeout() {}, checkVersionsWhenIdle() {},
    cloudComputer: null,
    cloudModel,
    cloudConnect: { ...cloudConnect, tailscaleCli: () => 'fixture-tailscale' },
    localRun: async (cli, args) => {
      assert.equal(cli, 'fixture-tailscale');
      assert.deepEqual(args, ['status', '--json']);
      calls.push('pairing');
      return { code: 0, out: JSON.stringify({ Peer: { fixture: { HostName: 'alan-fixture', TailscaleIPs: ['192.0.2.7'], Online: true } } }) };
    },
    sshRun: async (target, command, options) => {
      commands.push(command);
      assert.equal(target, host);
      if (command === 'echo CONNECT_OK') {
        calls.push('ssh');
        return failure === 'ssh' ? { code: 1, out: '' } : { code: 0, out: 'CONNECT_OK\n' };
      }
      if (command.includes('hermes config get')) {
        calls.push('model');
        assert.equal(options.timeoutMs, 8000, 'the read-only model check must be bounded');
        if (model === 'throw') throw new Error('fixture SSH timeout');
        return typeof model === 'function' ? model() : model || { code: 1, out: '' };
      }
      assert.equal(command, cloudConnect.sshReadCommand('/var/lib/alan/state.json'));
      calls.push('state');
      return { code: 0, out: JSON.stringify({ state: failure === 'failed' ? 'failed' : 'ready', step: 'paired' }) };
    },
    authorizeComputerKey: async (target) => {
      assert.equal(target, host);
      calls.push('authorize');
      return { ok: failure !== 'authorize', detail: 'fixture authorization failure' };
    },
    testAgentPath: async () => {
      calls.push('path');
      return { ok: failure !== 'path', detail: 'fixture return-path failure' };
    },
    savePreferences: () => savedSteps.push(prefs.cloud.step),
  });
  return { prefs, calls, commands, savedSteps, connect: () => run(diy && !resume ? host : undefined) };
}

for (const resume of [false, true]) {
  test(`a ${resume ? 'resumed' : 'new'} DIY connection skips migration and persists the Start fresh destination`, async () => {
    const f = fixture({ resume });
    const result = await f.connect();
    assert.equal(result.ok, true);
    assert.equal(result.stage, 'done');
    assert.equal(f.prefs.cloud.step, 'model');
    assert.equal(f.prefs.cloud.step, nextCloudStep(f.prefs, 'migrate'));
    assert.equal(cloudStep(f.prefs), 'model', 'reopening the wizard must not show migration');
    assert.equal(f.savedSteps.at(-1), 'model');
    assert.equal(f.prefs.onboarded, false, 'model and bot setup still remain');
    assert.deepEqual(f.calls, ['ssh', 'state', 'authorize', 'path', 'model']);
  });
}

test('reconnecting an older DIY setup saved at migration advances to model setup', async () => {
  const f = fixture({ resume: true, step: 'migrate' });
  const result = await f.connect();
  assert.equal(result.ok, true);
  assert.equal(cloudStep(f.prefs), 'model');
  assert.equal(f.savedSteps.at(-1), 'model');
});

test('a hosted connection still persists migration before model setup', async () => {
  const f = fixture({ diy: false });
  const result = await f.connect();
  assert.equal(result.ok, true);
  assert.equal(result.stage, 'done');
  assert.equal(cloudStep(f.prefs), 'migrate');
  assert.equal(f.savedSteps.at(-1), 'migrate');
  assert.equal(nextCloudStep(f.prefs, 'migrate'), 'model');
  assert.deepEqual(f.calls, ['pairing', 'state', 'authorize', 'path']);
});

for (const [failure, stage, calls] of [
  ['ssh', 'ssh', ['ssh']],
  ['failed', 'failed', ['ssh', 'state']],
  ['authorize', 'path', ['ssh', 'state', 'authorize']],
  ['path', 'path', ['ssh', 'state', 'authorize', 'path']],
]) {
  test(`a DIY ${failure} failure stays on connect`, async () => {
    const f = fixture({ failure });
    const result = await f.connect();
    assert.equal(result.ok, false);
    assert.equal(result.stage, stage);
    assert.equal(cloudStep(f.prefs), 'connect');
    assert.deepEqual(f.savedSteps, ['connect']);
    assert.deepEqual(f.calls, calls);
  });
}

for (const resume of [false, true]) {
  test(`a ${resume ? 'resumed' : 'new'} DIY server with OpenRouter waits for the user to confirm its model`, async () => {
    const f = fixture({ resume, model: { code: 0, out: 'openrouter\nopenai/gpt-4.1\n' } });
    const result = await f.connect();
    assert.equal(result.ok, true);
    assert.equal(f.commands.length, 3, 'connection must only read reachability, state and model identifiers');
    assert.equal(f.prefs.cloud.step, 'model', 'detected identifiers must leave the model card for confirmation');
    assert.equal(f.prefs.cloud.model, undefined);
    assert.equal(f.prefs.cloud.existingModel.provider, 'openrouter');
    assert.equal(f.prefs.cloud.existingModel.model, 'openai/gpt-4.1');
    assert.equal(f.savedSteps.at(-1), 'model');
    assert.match(result.detail, /openrouter.*openai\/gpt-4\.1/);
    assert.equal(f.prefs.onboarded, false);
    assert.deepEqual(f.calls, ['ssh', 'state', 'authorize', 'path', 'model']);
  });
}

test('even known bot coverage leaves the detected model for confirmation', async () => {
  const f = fixture({ resume: true, model: { code: 0, out: 'openrouter\nopenai/gpt-4.1\n' }, tokenedProfiles: ['*'] });
  await f.connect();
  assert.equal(f.prefs.cloud.step, 'model');
  assert.equal(f.prefs.onboarded, false);
});

for (const model of ['throw', { code: -1, out: 'openrouter\nopenai/gpt-4.1\n' }, { code: 0, out: 'None\nNone\n' }]) {
  test(`a failed or inconclusive DIY model probe falls back to the model card: ${JSON.stringify(model)}`, async () => {
    const f = fixture({ model });
    assert.equal((await f.connect()).ok, true);
    assert.equal(f.prefs.cloud.step, 'model');
    assert.equal(f.prefs.cloud.existingModel, undefined);
  });
}

test('overlapping Connect clicks and a replay cannot roll completed DIY setup backwards', async () => {
  const pending = [];
  const f = fixture({ resume: true, model: () => new Promise(resolve => pending.push(resolve)), tokenedProfiles: ['*'] });
  const first = f.connect();
  const second = f.connect();
  await new Promise(setImmediate);
  pending[0]({ code: 0, out: 'openrouter\nopenai/gpt-4.1\n' });
  await first;
  assert.equal(f.prefs.cloud.step, 'model');
  f.prefs.cloud.model = 'existing';
  f.prefs.cloud.step = 'done';
  f.prefs.onboarded = true;
  for (const resolve of pending.slice(1)) resolve({ code: 0, out: 'openrouter\nopenai/gpt-4.1\n' });
  await second;
  assert.equal(f.prefs.cloud.step, 'done', 'a stale probe must not roll back completion');
  assert.equal(f.prefs.cloud.model, 'existing');
  assert.equal(f.prefs.onboarded, true);
  assert.equal(pending.length, 1, 'overlapping clicks share the in-flight connection');
  const calls = f.calls.length, saves = f.savedSteps.length;
  await f.connect();
  assert.equal(f.prefs.cloud.step, 'done', 'a queued click after completion must also be harmless');
  assert.equal(f.calls.length, calls);
  assert.equal(f.savedSteps.length, saves);
});

test('a new DIY connection clears the previous completed model review', async () => {
  const f = fixture({ resume: true });
  f.prefs.cloud.modelOnly = true;
  f.prefs.cloud.migrationOnly = true;
  await f.connect();
  assert.equal(f.prefs.cloud.step, 'model');
  assert.equal(nextCloudStep(f.prefs, 'model'), 'telegram', 'a new connection still needs bot setup');
});
