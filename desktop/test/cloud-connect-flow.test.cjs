const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const cloudConnect = require('../src/cloud-connect.cjs');
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

function fixture({ diy = true, resume = false, step = 'connect', failure } = {}) {
  const host = diy ? 'user@server.example' : 'root@192.0.2.7';
  const prefs = {
    onboarded: false,
    macSshHost: 'user@computer.example',
    ...(diy && !resume ? {} : {
      cloud: { step, ...(diy ? { diy: true } : { sessionEnc: 'fixture-session', computerName: 'alan-fixture' }) },
      vpsBrowser: { sshHost: host },
    }),
  };
  const calls = [];
  const savedSteps = [];
  const run = vm.runInNewContext(`${connectSource}\ncloudConnectRun;`, {
    prefs, isSshTarget, nextCloudStep, setCloudStep,
    setTimeout() {}, checkVersionsWhenIdle() {},
    cloudComputer: null,
    cloudConnect: { ...cloudConnect, tailscaleCli: () => 'fixture-tailscale' },
    localRun: async (cli, args) => {
      assert.equal(cli, 'fixture-tailscale');
      assert.deepEqual(args, ['status', '--json']);
      calls.push('pairing');
      return { code: 0, out: JSON.stringify({ Peer: { fixture: { HostName: 'alan-fixture', TailscaleIPs: ['192.0.2.7'], Online: true } } }) };
    },
    sshRun: async (target, command) => {
      assert.equal(target, host);
      if (command === 'echo CONNECT_OK') {
        calls.push('ssh');
        return failure === 'ssh' ? { code: 1, out: '' } : { code: 0, out: 'CONNECT_OK\n' };
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
  return { prefs, calls, savedSteps, connect: () => run(diy && !resume ? host : undefined) };
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
    assert.deepEqual(f.calls, ['ssh', 'state', 'authorize', 'path']);
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
