const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  createVmUpdater, vmTargets, parseResultLine, shouldShowUpdatePopup, snoozeUntil,
  vmRetryState, VM_TIMEOUT_MS, CHECK_TIMEOUT_MS,
} = require('../src/vm-update.cjs');

const SCRIPTS = { 'vm-update.sh': '#!/bin/sh\n# fake posix payload\n', 'vm-update.ps1': '# fake windows payload\n' };
const readScript = (name) => {
  assert.ok(name in SCRIPTS, `unexpected bundled script ${name}`);
  return SCRIPTS[name];
};
const vm = (over = {}) => ({
  id: 'agent', label: 'VPS', sshHost: 'user@vm.example',
  scriptPath: '/home/user/.local/share/hermes-alans-way/app/desktop/scripts/vps-browser-host.cjs',
  sudo: false, ...over,
});
const okLine = (extra = {}) => `${JSON.stringify({ ok: true, version: '0.3.2', restarted: true, error: '', ...extra })}\n`;

function fakeRun(respond) {
  const calls = [];
  const run = (bin, args, opts = {}) => {
    calls.push({ bin, args, opts });
    return Promise.resolve(typeof respond === 'function' ? respond({ bin, args, opts }) : respond);
  };
  return { calls, run };
}

test('vmTargets lists the saved agent machine once an ssh host exists', () => {
  const targets = vmTargets({ vpsBrowser: { sshHost: 'u@h.example', scriptPath: '/x/h.cjs', sudo: true }, remotePlatform: 'mac' });
  assert.equal(targets.length, 1);
  assert.equal(targets[0].sshHost, 'u@h.example');
  assert.equal(targets[0].label, 'Mac VM');
  assert.equal(vmTargets({}).length, 0);
  assert.equal(vmTargets({ vpsBrowser: {} }).length, 0);
  assert.equal(vmTargets(undefined).length, 0);
});

test('non-release tags are refused before ssh is ever spawned', async () => {
  const { calls, run } = fakeRun({ code: 0, out: '', err: '' });
  const updater = createVmUpdater({ run, readScript });
  for (const tag of ['latest', 'v1.2', 'v1.2.3-rc.1', 'v1.2.3;id', 'v1.2.3$(id)', '../../x', '']) {
    const result = await updater.updateVm(vm(), tag);
    assert.equal(result.ok, false, tag);
  }
  assert.equal(calls.length, 0);
});

test('invalid saved ssh addresses are refused before ssh is spawned', async () => {
  for (const sshHost of ['host;id', 'host$(id)', '-oProxyCommand=x', 'user@host;id', 'a b', 'u@h`id`']) {
    const { calls, run } = fakeRun({ code: 0, out: '', err: '' });
    const updater = createVmUpdater({ run, readScript });
    const result = await updater.updateVm(vm({ sshHost }), 'v0.3.2');
    assert.equal(result.ok, false, sshHost);
    assert.equal(calls.length, 0, sshHost);
  }
});

test('the bundled POSIX script is piped over ssh stdin with the tag as its only argument', async () => {
  const { calls, run } = fakeRun({ code: 0, out: `vm-update: checkout pinned\n${okLine()}`, err: '' });
  const updater = createVmUpdater({ run, readScript });
  const result = await updater.updateVm(vm(), 'v0.3.2');
  assert.equal(result.ok, true);
  assert.equal(result.version, '0.3.2');
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.bin, 'ssh');
  assert.deepEqual(call.args.slice(0, -2), ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=yes']);
  assert.equal(call.args.at(-2), 'user@vm.example');
  assert.equal(call.args.at(-1), 'sh -s -- v0.3.2');
  assert.equal(call.opts.input, SCRIPTS['vm-update.sh']);
  assert.equal(call.opts.timeoutMs, VM_TIMEOUT_MS);
});

test('a Windows drive scriptPath selects the PowerShell twin and carries the tag in its environment', async () => {
  const { calls, run } = fakeRun({ code: 0, out: okLine(), err: '' });
  const updater = createVmUpdater({ run, readScript });
  const result = await updater.updateVm(vm({ scriptPath: 'C:\\Users\\a b\\app\\desktop\\scripts\\vps-browser-host.cjs' }), 'v0.3.2');
  assert.equal(result.ok, true);
  assert.equal(calls[0].opts.input, SCRIPTS['vm-update.ps1']);
  assert.match(calls[0].args.at(-1), /powershell/);
  assert.match(calls[0].args.at(-1), /ALANS_WAY_VM_TAG=v0\.3\.2/);
});

test('a guest without a saved scriptPath is probed for its platform once', async () => {
  const { calls, run } = fakeRun(({ args }) => args.at(-1) === 'node -p process.platform'
    ? { code: 0, out: 'win32\n', err: '' }
    : { code: 0, out: okLine(), err: '' });
  const updater = createVmUpdater({ run, readScript });
  await updater.updateVm(vm({ scriptPath: '' }), 'v0.3.2');
  assert.equal(calls[0].args.at(-1), 'node -p process.platform');
  assert.equal(calls[1].opts.input, SCRIPTS['vm-update.ps1']);
});

test('every saved VM updates in parallel under one timeout cap, before the app update runs', async () => {
  const order = [];
  const gates = {};
  const run = (bin, args, opts = {}) => new Promise((resolve) => {
    const host = args.at(-2);
    gates[host] = { opts, resolve };
    order.push(`start:${host}`);
  });
  const updater = createVmUpdater({ run, readScript });
  const targets = [vm({ id: 'a', sshHost: 'user@a.example' }), vm({ id: 'b', sshHost: 'user@b.example' })];
  const done = updater.updateAppAndVms({
    tag: 'v0.3.2', targets,
    applyAppUpdate: async () => { order.push('app'); return 'relaunch'; },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual([...order].sort(), ['start:user@a.example', 'start:user@b.example']);
  assert.equal(gates['user@a.example'].opts.timeoutMs, VM_TIMEOUT_MS);
  assert.equal(gates['user@b.example'].opts.timeoutMs, VM_TIMEOUT_MS);
  gates['user@a.example'].resolve({ code: 0, out: okLine(), err: '' });
  gates['user@b.example'].resolve({ code: 0, out: JSON.stringify({ ok: false, version: '0.3.1', error: 'disk full' }), err: '' });
  const result = await done;
  assert.equal(order.at(-1), 'app', 'the app update still runs after a VM failure');
  assert.equal(result.app, 'relaunch');
  assert.equal(result.vms.find((v) => v.id === 'a').ok, true);
  assert.equal(result.vms.find((v) => v.id === 'b').ok, false);
  assert.match(result.vms.find((v) => v.id === 'b').error, /disk full/);
});

test('a VM that stays busy is skipped with a retry reason', async () => {
  const { run } = fakeRun({ code: 0, out: JSON.stringify({ ok: false, version: '0.3.1', restarted: false, error: 'busy' }), err: '' });
  const updater = createVmUpdater({ run, readScript });
  const result = await updater.updateVm(vm(), 'v0.3.2');
  assert.equal(result.ok, false);
  assert.equal(result.state, 'busy');
  assert.match(result.error, /busy/i);
});

test('ssh-level failures become per-VM errors, never a throw', async () => {
  const { run } = fakeRun({ code: 255, out: '', err: 'ssh: connect to host vm.example port 22: timed out' });
  const updater = createVmUpdater({ run, readScript });
  const result = await updater.updateVm(vm(), 'v0.3.2');
  assert.equal(result.ok, false);
  assert.equal(result.state, 'failed');
  assert.match(result.error, /timed out/);
});

test('the result line is the last JSON object line of script output', () => {
  assert.deepEqual(parseResultLine('noise\n{"ok":true,"version":"0.3.2"}\n'), { ok: true, version: '0.3.2' });
  assert.deepEqual(parseResultLine('{"ok":true}\ntrailing log'), { ok: true });
  assert.equal(parseResultLine('no json here'), null);
  assert.equal(parseResultLine(''), null);
});

test('checkVm asks the guest for checkout and live versions under a short cap', async () => {
  const { calls, run } = fakeRun({ code: 0, out: 'vm-update: found checkout\n{"ok":true,"version":"0.3.1","hostVersion":"0.3.1","busy":false}', err: '' });
  const updater = createVmUpdater({ run, readScript });
  const result = await updater.checkVm(vm());
  assert.equal(result.ok, true);
  assert.equal(result.version, '0.3.1');
  assert.equal(result.busy, false);
  assert.equal(calls[0].args.at(-1), 'sh -s -- --check');
  assert.equal(calls[0].opts.timeoutMs, CHECK_TIMEOUT_MS);
});

test('the retry banner shows while a saved VM lags the app or failed, and clears once it matches', () => {
  assert.deepEqual(vmRetryState('0.3.2', { agent: { version: '0.3.1', failed: '' } }), { show: true, version: '0.3.1', failed: '' });
  assert.deepEqual(vmRetryState('0.3.2', { agent: { version: '', failed: 'disk full' } }), { show: true, version: '', failed: 'disk full' });
  assert.equal(vmRetryState('0.3.2', { agent: { version: '0.3.2' } }).show, false);
  assert.equal(vmRetryState('0.3.2', {}).show, false);
  assert.equal(vmRetryState('0.3.2', undefined).show, false);
  assert.equal(vmRetryState('0.3.2', { agent: { version: '0.4.0' } }).show, false);
});

test('the update popup shows only for an available, unsnoozed, idle update', () => {
  const now = 1000000;
  assert.equal(shouldShowUpdatePopup({ available: '0.3.2', snoozedUntil: 0, now }), true);
  assert.equal(shouldShowUpdatePopup({ available: '0.3.2', snoozedUntil: now + 1, now }), false);
  assert.equal(shouldShowUpdatePopup({ available: '', snoozedUntil: 0, now }), false);
  assert.equal(shouldShowUpdatePopup({ available: '0.3.2', snoozedUntil: 0, now, busy: true }), false);
});

test('Later snoozes for twenty four hours', () => {
  assert.equal(snoozeUntil(1000), 1000 + 24 * 60 * 60 * 1000);
});
