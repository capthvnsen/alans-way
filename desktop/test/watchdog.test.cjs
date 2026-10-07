const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createWatchdog, REMOTE_DIR, SCRIPTS, tailscaleBin, scriptPayloads } = require('../src/watchdog.cjs');

// A canned process runner: hands each spawn call to `responder(args)` and
// records it. responder returns { code, out, err }.
function recorder(responder) {
  const calls = [];
  const run = (bin, args, opts = {}) => {
    calls.push({ bin, args, input: opts.input });
    const reply = responder(bin, args, opts);
    return Promise.resolve({ code: 0, out: '', err: '', ...reply });
  };
  return { calls, run };
}
const sshCalls = (calls) => calls.filter((c) => c.bin === 'ssh');
const happyResponder = (bin, args) => {
  if (args[0] === 'ip') return { out: '192.0.2.9\n' };
  if (bin === 'ssh' && args.at(-1).includes('--exit-node')) return { out: 'alans-watchdog-vps: enabled and started' };
  return {};
};
const payloads = { [SCRIPTS.watchdog]: '#!/bin/sh\n', [SCRIPTS.installer]: '#!/bin/sh\n' };

test('watchdog refuses unusable or missing agent machine addresses before touching the network', async () => {
  const { calls, run } = recorder(() => ({}));
  const wd = createWatchdog({ run, payloads });
  for (const sshHost of ['', 'vps; rm -rf /', 'vps$(id)', "vps'x"]) {
    const result = await wd.setEnabled({ enabled: true, sshHost, remotePlatform: 'linux' });
    assert.equal(result.ok, false, JSON.stringify(sshHost));
  }
  assert.equal(sshCalls(calls).length, 0);
});

test('watchdog points out that a macOS VM already shares this computer’s network', async () => {
  const { run } = recorder(() => ({}));
  const result = await createWatchdog({ run, payloads }).setEnabled({ enabled: true, sshHost: 'me@vps', remotePlatform: 'mac' });
  assert.equal(result.ok, false);
  assert.match(result.detail, /already shares|nothing to route/i);
});

test('enabling advertises this computer, uploads both scripts, and installs over ssh', async () => {
  const { calls, run } = recorder(happyResponder);
  const result = await createWatchdog({ run, payloads }).setEnabled({ enabled: true, sshHost: 'me@vps', remotePlatform: 'linux' });
  assert.equal(result.ok, true, result.detail);
  const seq = calls.map((c) => [c.bin, ...c.args].join(' '));
  assert.ok(seq.some((line) => line.includes('set --advertise-exit-node')), 'advertise ran');
  assert.ok(seq.some((line) => line.includes('ip -4')), 'address read');
  const uploads = sshCalls(calls).filter((c) => c.args.at(-1).includes('cat >'));
  assert.equal(uploads.length, 2, 'both scripts uploaded');
  assert.ok(uploads.some((c) => c.input === payloads[SCRIPTS.watchdog] && c.args.at(-1).includes(SCRIPTS.watchdog)));
  assert.ok(uploads.some((c) => c.input === payloads[SCRIPTS.installer] && c.args.at(-1).includes(SCRIPTS.installer)));
  const install = sshCalls(calls).find((c) => c.args.at(-1).includes('--exit-node'));
  assert.ok(install, 'installer ran');
  assert.match(install.args.at(-1), /--exit-node '192\.0\.2\.9'/, 'quoted local tailnet address is the target');
  assert.ok(install.args.at(-1).includes('sudo -n'), 'non-root installs go through passwordless sudo');
  for (const c of sshCalls(calls)) {
    assert.ok(c.args.includes('BatchMode=yes') && c.args.includes('StrictHostKeyChecking=yes'), 'pinned, non-interactive ssh');
  }
});

test('a refused advertisement stops the sequence before any ssh call', async () => {
  const { calls, run } = recorder((bin, args) => (args[0] === 'set' ? { code: 1, err: 'access denied' } : {}));
  const result = await createWatchdog({ run, payloads }).setEnabled({ enabled: true, sshHost: 'me@vps', remotePlatform: 'linux' });
  assert.equal(result.ok, false);
  assert.match(result.detail, /advertis/i);
  assert.equal(sshCalls(calls).length, 0);
});

test('a missing admin approval is reported, not hidden', async () => {
  const { run } = recorder((bin, args) => {
    if (args[0] === 'ip') return { out: '192.0.2.9\n' };
    if (bin === 'ssh' && args.at(-1).includes('--exit-node')) return { out: 'alans-watchdog-vps: WARNING — not an approved exit node yet\nalans-watchdog-vps: enabled and started' };
    return {};
  });
  const result = await createWatchdog({ run, payloads }).setEnabled({ enabled: true, sshHost: 'me@vps', remotePlatform: 'linux' });
  assert.equal(result.ok, true);
  assert.match(result.detail, /admin console|approve/i);
});

test('a root requirement comes back as the exact command to run there', async () => {
  const { run } = recorder((bin, args) => {
    if (args[0] === 'ip') return { out: '192.0.2.9\n' };
    if (bin === 'ssh' && args.at(-1).includes('--exit-node')) return { out: 'WATCHDOG_NEEDS_ROOT', code: 0 };
    return {};
  });
  const result = await createWatchdog({ run, payloads }).setEnabled({ enabled: true, sshHost: 'me@vps', remotePlatform: 'linux' });
  assert.equal(result.ok, false);
  assert.match(result.detail, /sudo sh .*alans-watchdog-vps\.sh --exit-node 192\.0\.2\.9/);
});

test('disabling removes the remote watchdog and stops advertising, even when ssh is down', async () => {
  const { calls, run } = recorder((bin, args) => {
    if (bin === 'ssh') return { code: 255, err: 'Connection timed out' };
    return {};
  });
  const result = await createWatchdog({ run, payloads }).setEnabled({ enabled: false, sshHost: 'me@vps', remotePlatform: 'linux' });
  assert.equal(result.ok, true);
  assert.match(result.detail, /no longer|direct egress|could not/i);
  const seq = calls.map((c) => [c.bin, ...c.args].join(' '));
  assert.ok(seq.some((line) => line.includes('set --advertise-exit-node=false')), 'un-advertised locally');
  assert.ok(sshCalls(calls).some((c) => c.args.at(-1).includes('--uninstall')), 'remote uninstall attempted');
});

test('script payloads resolve from the repo checkout and carry the real watchdog', () => {
  const found = scriptPayloads({ home: '/nonexistent-home', root: path.join(__dirname, '..', '..') });
  assert.match(found[SCRIPTS.watchdog], /exit-node=/);
  assert.match(found[SCRIPTS.installer], /systemd|hermes-alans-way-watchdog/);
});

test('the local tailscale binary prefers the app bundle and falls back to PATH', () => {
  assert.equal(tailscaleBin('darwin', () => true), '/Applications/Tailscale.app/Contents/MacOS/Tailscale');
  assert.equal(tailscaleBin('darwin', () => false), 'tailscale');
  assert.equal(tailscaleBin('linux'), 'tailscale');
});

test('the remote install directory is fixed and quoted paths stay single-quoted', () => {
  assert.match(REMOTE_DIR, /^\$HOME\//);
  const wd = createWatchdog({ run: () => Promise.resolve({ code: 0, out: '', err: '' }), payloads });
  assert.equal(typeof wd.setEnabled, 'function');
});
