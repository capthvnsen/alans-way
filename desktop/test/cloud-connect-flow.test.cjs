const { ip: fixtureTailnet, otherIp: fixtureTailnetOther } = require('./tailnet-fixture.cjs');
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

const changedHost = process.env.HERMES_WORKSPACE_REQUIRE_TAILNET === '1' ? require('./tailnet-fixture.cjs').otherIp : 'new.invalid';

function fixture({ diy = true, resume = false, step = 'connect', failure, probe, realBrokerSetup = false, model = null, tokenedProfiles = [],
  inventory = tokenedProfiles.map(name => name === '*' ? '/fixture/.hermes/.env' : `/fixture/.hermes/profiles/${name}/.env`).join('\n') } = {}) {
  const peerIp = realBrokerSetup ? fixtureTailnet : '192.0.2.7';
  const host = realBrokerSetup ? `agent@${peerIp}` : diy ? `user@${fixtureTailnet}` : `root@${peerIp}`;
  const prefs = {
    onboarded: false,
    macSshHost: `user@${fixtureTailnet}`,
    ...(diy && !resume ? {} : {
      cloud: { step, tokenedProfiles, ...(diy ? { diy: true } : { sessionEnc: 'fixture-session', computerName: 'alan-fixture' }) },
      vpsBrowser: { sshHost: host },
    }),
  };
  if (realBrokerSetup) prefs.vpsBrowser = { sshHost: host, brokerSshHost: `broker@${peerIp}`, scriptPath: '/app/host.cjs' };
  const readiness = vm.runInNewContext(source.slice(source.indexOf('function checkBrokerSetup()'), source.indexOf('function testAgentPath()')) + ';checkBrokerSetup', { prefs, brokerTarget: require('../src/vps-browser.cjs').brokerTarget });
  const calls = [];
  const commands = [];
  const savedSteps = [];
  const broadcasts = [];
  const commandSource = source.slice(source.indexOf('  const runCommand = async'), source.indexOf('\n  // Failed actions'));
  const run = vm.runInNewContext(`${connectSource}\n${commandSource}\nrunCommand;`, {
    prefs, isSshTarget, nextCloudStep, setCloudStep,
    trustSender() {}, getState: () => ({ step: prefs.cloud?.step }),
    broadcastNow: () => broadcasts.push(prefs.cloud?.step),
    setTimeout() {}, checkVersionsWhenIdle() {},
    cloudComputer: null,
    cloudModel,
    cloudMigrate: require('../src/cloud-migrate.cjs'),
    cloudConnect: { ...cloudConnect, tailscaleCli: () => 'fixture-tailscale' },
    localRun: async (cli, args) => {
      assert.equal(cli, 'fixture-tailscale');
      assert.deepEqual(args, ['status', '--json']);
      calls.push('pairing');
      return { code: 0, out: JSON.stringify({ Peer: { fixture: { HostName: 'alan-fixture', TailscaleIPs: [peerIp], Online: true } } }) };
    },
    sshRun: async (target, command, options) => {
      commands.push(command);
      assert.ok([host, `user@${changedHost}`].includes(target));
      if (command === require('../src/cloud-migrate.cjs').profilesWithTokenCommand()) {
        calls.push('tokens');
        assert.equal(options.timeoutMs, 8000);
        if (typeof inventory === 'function') return inventory('tokens');
        return { code: 0, out: inventory };
      }
      if (command === 'ls ~/.hermes/profiles 2>/dev/null') {
        calls.push('profiles');
        if (typeof inventory === 'function') return inventory('profiles');
        return { code: 0, out: 'personal\nwork\n' };
      }
      if (command === 'echo CONNECT_OK') {
        calls.push('ssh');
        if (probe) return probe(target);
        if (failure === 'throw') throw new Error('fixture connection failure');
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
    checkBrokerSetup: () => {
      assert.ok([host, `user@${changedHost}`].includes(prefs.vpsBrowser.sshHost));
      calls.push('authorize');
      return realBrokerSetup ? readiness() : { ok: failure !== 'authorize', detail: 'fixture authorization failure' };
    },
    testAgentPath: async () => {
      calls.push('path');
      return { ok: failure !== 'path', detail: 'fixture return-path failure' };
    },
    savePreferences: () => savedSteps.push(prefs.cloud.step),
  });
  const requestConnect = (target = diy && !resume ? host : '') => run(null, 'cloud-connect', { host: target });
  return { prefs, calls, commands, savedSteps, broadcasts, requestConnect,
    command: (name, value) => run(null, name, value),
    connect: async () => {
      const result = await requestConnect();
      if (diy && result.ok && !result.cancelled && ['connect', 'migrate'].includes(prefs.cloud.step)) await run(null, 'cloud-goto', { step: 'model' });
      return result;
    } };
}

test('Connect B starts its own request while A is pending and discards A even on failure', async () => {
  let release;
  const f = fixture({ probe: target => target === `user@${changedHost}`
    ? { code: 0, out: 'CONNECT_OK\n' } : new Promise(resolve => { release = resolve; }) });
  const first = f.requestConnect();
  const next = f.requestConnect(`user@${changedHost}`);
  await new Promise(setImmediate);
  assert.equal(f.calls.filter(call => call === 'ssh').length, 2, 'different addresses cannot share a pending connection');
  const second = await next;
  assert.equal(second.host, `user@${changedHost}`);
  assert.equal(second.ok, true);
  assert.equal(f.prefs.cloud.step, 'connect', 'the renderer must accept the address before advancing');
  release({ code: 1, out: '' });
  const stale = await first;
  assert.equal(stale.host, `user@${fixtureTailnet}`);
  assert.equal(stale.cancelled, true);
  assert.equal(stale.detail, '');
  assert.equal(f.prefs.vpsBrowser.sshHost, `user@${changedHost}`);
  assert.equal(f.calls.filter(call => call === 'authorize').length, 1);
});

test('changing the saved address cancels Connect before interpreting an old SSH failure', async () => {
  let release;
  const f = fixture({ probe: () => new Promise(resolve => { release = resolve; }) });
  const first = f.requestConnect();
  f.prefs.vpsBrowser.sshHost = `user@${changedHost}`;
  release({ code: 1, out: '' });
  const result = await first;
  assert.equal(result.cancelled, true);
  assert.equal(result.detail, '');
  assert.deepEqual(f.calls, ['ssh']);
});

test('DIY bot-chat discards both inventory reads when the saved host changes', async () => {
  const pending = {};
  const f = fixture({ resume: true, step: 'model', inventory: kind => new Promise(resolve => { pending[kind] = resolve; }) });
  const result = f.command('cloud-goto', { step: 'bot-chat' });
  assert.deepEqual(Object.keys(pending).sort(), ['profiles', 'tokens']);
  f.prefs.vpsBrowser.sshHost = `user@${changedHost}`;
  pending.tokens({ code: 0, out: '/fixture/.hermes/profiles/old/.env\n' });
  pending.profiles({ code: 0, out: 'old\n' });
  await result;
  assert.equal(f.prefs.cloud.botInventoryChecked, undefined);
  assert.deepEqual(Array.from(f.prefs.cloud.tokenedProfiles), []);
  assert.equal(f.prefs.cloud.profiles, undefined);
  assert.equal(f.prefs.cloud.step, 'model');
  assert.equal(f.savedSteps.length, 0);
});

test('Connect lets the renderer accept the model card, including a replay', async () => {
  const f = fixture();
  assert.equal((await f.connect()).ok, true);
  assert.equal(f.broadcasts.at(-1), 'model', 'the open renderer must leave Connect without reopening');
  await f.connect();
  assert.equal(f.broadcasts.length, 3);
});

test('the shared command boundary publishes partial state even when Connect rejects', async () => {
  const f = fixture({ failure: 'throw' });
  await assert.rejects(f.connect(), /fixture connection failure/);
  assert.deepEqual(f.broadcasts, ['connect']);
});

test('DIY inventories bot presence without reading token values', async () => {
  const f = fixture({ inventory: '/fixture/.hermes/profiles/personal/.env\n' });
  await f.connect();
  assert.deepEqual(Array.from(f.prefs.cloud.tokenedProfiles || []), ['personal']);
  assert.deepEqual(Array.from(f.prefs.cloud.profiles || []), ['personal', 'work']);
  assert.equal(nextCloudStep(f.prefs, 'model'), 'bot-chat');
});

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
    assert.equal(f.prefs.cloud.modelDetected, true, 'the model card must not read the server model again');
    assert.deepEqual(f.calls, ['ssh', 'state', 'authorize', 'path', 'model', 'tokens', 'profiles']);
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
  assert.deepEqual(f.broadcasts, ['migrate'], 'hosted early returns also publish their destination');
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
    assert.equal(f.commands.length, 5, 'connection only reads reachability, state, model identifiers and bot presence');
    assert.equal(f.prefs.cloud.step, 'model', 'detected identifiers must leave the model card for confirmation');
    assert.equal(f.prefs.cloud.model, undefined);
    assert.equal(f.prefs.cloud.existingModel.provider, 'openrouter');
    assert.equal(f.prefs.cloud.existingModel.model, 'openai/gpt-4.1');
    assert.equal(f.savedSteps.at(-1), 'model');
    assert.match(result.detail, /openrouter.*openai\/gpt-4\.1/);
    assert.equal(f.prefs.onboarded, false);
    assert.deepEqual(f.calls, ['ssh', 'state', 'authorize', 'path', 'model', 'tokens', 'profiles']);
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

for (const diy of [true, false]) {
  test(`${diy ? 'DIY retry' : 'hosted discovery'} preserves a provisioned non-root agent and separate broker`, async () => {
    const f = fixture({ diy, realBrokerSetup: true });
    const config = { ...f.prefs.vpsBrowser };
    const result = await f.connect();
    assert.equal(result.ok, true, result.detail);
    assert.deepEqual({ ...f.prefs.vpsBrowser }, config);
    assert.ok(f.calls.includes('path'));
  });
}

test('changing the DIY host discards the previous broker and fails readiness', async () => {
  const f = fixture({ realBrokerSetup: true });
  const result = await f.requestConnect(`user@${changedHost}`);
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'path');
  assert.equal(f.prefs.vpsBrowser.brokerSshHost, '');
  assert.ok(!f.calls.includes('path'));
});
