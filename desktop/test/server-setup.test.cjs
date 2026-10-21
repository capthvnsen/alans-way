'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServerSetup, parseSetupPlan, setupCommand } = require('../src/server-setup.cjs');
const plan = { repoRef: 'a'.repeat(40), desktopRef: 'b'.repeat(40), args: ['--bot-id', '123456789', '--mac-ssh', 'you@computer.example', '--host-os', 'mac', '--timezone', 'America/Denver', '--bind', '--proactive', 'yes'] };

test('setup accepts every supported public key type and keeps comments on user keys only', () => {
  const blob = 'A'.repeat(20);
  const parseKey = (option, value) => parseSetupPlan(JSON.stringify({ ...plan, args: [...plan.args, option, value] }));
  for (const type of ['ssh-ed25519', 'ssh-rsa', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384',
    'ecdsa-sha2-nistp521', 'sk-ssh-ed25519@openssh.com', 'sk-ecdsa-sha2-nistp256@openssh.com']) {
    for (const option of ['--mac-key', '--mac-host-key']) assert.doesNotThrow(() => parseKey(option, `${type} ${blob}==`));
    assert.doesNotThrow(() => parseKey('--mac-key', `${type} ${blob} user key comment`));
    assert.throws(() => parseKey('--mac-host-key', `${type} ${blob} host key comment`), /unsupported option or value/);
  }
});

test('setup rejects malformed key blobs, options, control characters and extra lines', () => {
  const key = `ssh-ed25519 ${'A'.repeat(20)}`;
  for (const option of ['--mac-key', '--mac-host-key']) {
    for (const value of ['ssh-dss ' + 'A'.repeat(20), 'ssh-ed25519 short', `${key}====`,
      `ssh-ed25519 ${'A'.repeat(20)}=A`, `command="id" ${key}`, `${key}\n`, `${key}\r`,
      `${key}\n${key}`, `${key} comment\tmore`, `${key} comment\x7f`]) {
      assert.throws(() => parseSetupPlan(JSON.stringify({ ...plan, args: [...plan.args, option, value] })), /unsupported option or value/);
    }
  }
});

test('a reviewed setup plan runs over pinned SSH outside the gateway', async () => {
  const calls = [];
  const setup = createServerSetup({ run: async (...args) => { calls.push(args); return { code: 0, out: 'setup: fixture passed\nRestarting the gateway in 10s, detached', err: '' }; } });
  const result = await setup('you@server.example', JSON.stringify(plan));
  assert.equal(result.ok, true);
  assert.match(result.detail, /restart|Restart/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'ssh');
  assert.deepEqual(calls[0][1].slice(0, -2), ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=yes']);
  assert.equal(calls[0][1].at(-2), 'you@server.example');
  assert.match(calls[0][1].at(-1), /sh -s/);
  const payload = calls[0][2].input;
  assert.match(payload, /git rev-parse HEAD/);
  assert.match(payload, /git diff --quiet/);
  assert.match(payload, /--skip-plugin/);
  assert.match(payload, /--non-interactive/);
  assert.match(payload, /--restart/);
  assert.match(payload, /--repo-ref' 'a{40}'/);
  assert.match(payload, /--desktop-ref' 'b{40}'/);
});

test('setup rejects unpinned sources, arbitrary flags and invalid SSH before spawning', async () => {
  let calls = 0;
  const setup = createServerSetup({ run: async () => { calls++; throw new Error('must not run'); } });
  const invalidPlans = ['not json', { ...plan, repoRef: 'main' }, { ...plan, desktopRef: 'latest' },
    { ...plan, args: [...plan.args, '--dev-plugin-install'] }, { ...plan, args: [...plan.args, '--restart'] },
    { ...plan, args: [...plan.args, '--config', '/etc/other'] }, { ...plan, args: ['--bot-id'] },
    { ...plan, args: [...plan.args, '--profile', '../other'] }, { ...plan, extra: 'unknown' }];
  for (const input of invalidPlans) assert.equal((await setup('you@server.example', typeof input === 'string' ? input : JSON.stringify(input))).ok, false);
  assert.equal((await setup('-oProxyCommand=bad', JSON.stringify(plan))).ok, false);
  assert.equal(calls, 0);
});

test('values remain shell data; profiles and explicit desktop opt-in survive', () => {
  const input = { ...plan, args: [...plan.args, '--bot-name', "A ' quote $(touch marker)", '--profile', 'work', '--allow-desktop-actions'] };
  assert.deepEqual(parseSetupPlan(JSON.stringify(input)), input);
  const command = setupCommand(input);
  assert.match(command, /'A '\\'' quote \$\(touch marker\)'/);
  assert.match(command, /'--profile' 'work'/);
  assert.match(command, /'--allow-desktop-actions'/);
  assert.doesNotMatch(setupCommand(plan), /allow-desktop-actions/);
});

test('failed checks and restart deferral remain visible, with output redacted', async () => {
  const setup = createServerSetup({ run: async () => ({ code: 1, out: 'FAIL required check\nhttps://name:password@example.invalid/report?token=secret', err: '' }) });
  const result = await setup('you@server.example', JSON.stringify(plan));
  assert.equal(result.ok, false);
  assert.match(result.detail, /FAIL required check/);
  assert.doesNotMatch(result.detail, /password|token=secret/);
});

test('a thrown or timed-out SSH operation cannot report setup success', async () => {
  for (const run of [async () => { throw new Error('spawn failed'); }, async () => ({ code: null, out: '', err: '' })]) {
    const result = await createServerSetup({ run })('you@server.example', JSON.stringify(plan));
    assert.equal(result.ok, false);
    assert.ok(result.detail);
  }
});


test('the actual setup payload enforces the pin and preserves literal user inputs', (t) => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { execFileSync, spawnSync } = require('node:child_process');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'server-setup-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const repo = path.join(home, 'alans-way-agents'); fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.name', 'fixture'); git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(repo, 'setup.sh'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$HOME/called"\n');
  git('add', '.'); git('commit', '-qm', 'fixture');
  const fixture = { ...plan, repoRef: git('rev-parse', 'HEAD'), args: [...plan.args, '--bot-name', "A quote ' $(touch marker)"] };
  const invoke = (input) => spawnSync('sh', ['-s'], { input: setupCommand(input), env: { ...process.env, HOME: home }, encoding: 'utf8' });
  assert.notEqual(invoke(plan).status, 0, 'wrong pin never executes setup');
  assert.equal(fs.existsSync(path.join(home, 'called')), false);
  assert.equal(invoke(fixture).status, 0);
  const called = fs.readFileSync(path.join(home, 'called'), 'utf8').trim().split('\n');
  assert.deepEqual(called, ['--skip-plugin', '--repo-ref', fixture.repoRef, '--desktop-ref', fixture.desktopRef, ...fixture.args, '--non-interactive', '--restart']);
  assert.equal(fs.existsSync(path.join(repo, 'marker')), false);
  fs.unlinkSync(path.join(home, 'called'));
  fs.appendFileSync(path.join(repo, 'setup.sh'), '# local change\n');
  assert.notEqual(invoke(fixture).status, 0, 'modified checkout never executes setup');
  assert.equal(fs.existsSync(path.join(home, 'called')), false);
});


test('IANA single-component aliases and Etc zones reach mocked SSH intact', async () => {
  const calls = [];
  const setup = createServerSetup({ run: async (...args) => { calls.push(args); return { code: 0, out: 'fixture passed', err: '' }; } });
  for (const timezone of ['UTC', 'Etc/UTC', 'Etc/GMT+12', 'Etc/GMT-14', 'America/Argentina/Buenos_Aires', 'GMT0', 'CST6CDT']) {
    const args = [...plan.args]; args[args.indexOf('--timezone') + 1] = timezone;
    assert.equal((await setup('you@server.example', JSON.stringify({ ...plan, args }))).ok, true, timezone);
    assert.ok(calls.at(-1)[2].input.includes(`'--timezone' '${timezone}'`));
  }
  assert.equal(calls.length, 7);
});

test('Hermes profile IDs accept the full 1 to 64 character boundary', async () => {
  const calls = [];
  const setup = createServerSetup({ run: async (...args) => { calls.push(args); return { code: 0, out: 'fixture passed', err: '' }; } });
  for (const profile of ['a', '0', 'work_1-test', 'default', 'a'.repeat(63), 'a'.repeat(64)]) {
    const input = { ...plan, args: [...plan.args, '--profile', profile] };
    assert.equal((await setup('you@server.example', JSON.stringify(input))).ok, true, profile);
    assert.ok(calls.at(-1)[2].input.includes(`'--profile' '${profile}'`));
  }
  assert.equal(calls.length, 6);
});

test('timezone and profile formats reject invalid boundaries and shell metacharacters before SSH', async () => {
  let calls = 0;
  const setup = createServerSetup({ run: async () => { calls++; throw Error('must not run'); } });
  for (const [option, invalid] of [
    ['--profile', ['', 'a'.repeat(65), '-work', '_work', 'Work', 'work.name', '../work']],
    ['--timezone', ['', '/UTC', 'Etc/', 'Etc//UTC', '../UTC']],
  ]) {
    for (const value of [...invalid, 'UTC;id', '$(id)', '`id`', 'UTC|id', 'UTC&id', 'UTC>file', "UTC'", 'UTC"', 'UTC\\id', 'UTC id', 'UTC\n', 'UTC\r', 'work\n', 'work\r']) {
      const args = [...plan.args];
      if (option === '--timezone') args[args.indexOf(option) + 1] = value;
      else args.push(option, value);
      assert.equal((await setup('you@server.example', JSON.stringify({ ...plan, args }))).ok, false, `${option}: ${JSON.stringify(value)}`);
    }
  }
  assert.equal(calls, 0);
});
