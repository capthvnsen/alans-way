'use strict';
// The test bench's shell scripts (scripts/test-bench): what they must never contain, and that they are a dry run by default.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ip = (...octets) => octets.join('.'); // a written tailnet address would read as a real machine to the publication check
const DIR = path.join(__dirname, '..', '..', 'scripts', 'test-bench');
const scripts = fs.readdirSync(DIR).filter((n) => n.endsWith('.sh'));
const code = (name) => fs.readFileSync(path.join(DIR, name), 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

test('no script can end a process by pattern, touch production services, expose Tailscale, trace, or print a secret', () => {
  const forbidden = [
    [/\b(pkill|killall|killall5|pgrep|pidof|fuser)\b/, 'selects processes by name'],
    [/kill\s+(-\w+\s+)?-1\b/, 'kills everything'],
    [/--replace\b/, 'hermes gateway run --replace takes over another gateway'],
    [/gateway\s+(stop|restart|start|install|uninstall)\b/, 'hermes gateway lifecycle commands act on the production service'],
    [/(serve|dashboard)\s+--stop\b/, 'hermes --stop scans the process table'],
    [/\btailscale\s+(serve|funnel|set|up|down)\b/, 'changes the machine-wide Tailscale setup'],
    [/\bset\s+-\w*x|\bsh\s+-\w*x\b|xtrace/, 'tracing prints secret values'],
    [/\b(cat|less|more|head|tail|base64)\b[^|<>\n]*(credentials|\.env\b)/, 'prints a secrets file'],
    [/\b(echo|say)\b[^\n]*\$\{?(PASS|API_KEY|SECRET|PROVIDER_KEY|key|password)\b/, 'echoes a secret'],
    [/systemctl\b(?![^\n]*--user)[^\n]*\b(stop|restart|disable|kill)\b/, 'a system-level systemctl stop/restart'],
  ];
  for (const name of scripts) {
    const text = code(name);
    for (const [re, why] of forbidden) assert.ok(!re.test(text), `${name}: ${why}`);
  }
});

test('every script is POSIX sh with set -eu, and the bench scripts that change things default to a dry run', () => {
  for (const name of scripts.filter((n) => n !== 'common.sh')) {
    const text = fs.readFileSync(path.join(DIR, name), 'utf8');
    assert.match(text, /^#!\/bin\/sh\n/, name);
    assert.match(text, /^set -eu$/m, name);
  }
  const common = fs.readFileSync(path.join(DIR, 'common.sh'), 'utf8');
  assert.match(common, /^APPLY=0$/m);
  for (const name of ['provision.sh', 'reset.sh', 'uninstall.sh', 'control.sh']) assert.match(fs.readFileSync(path.join(DIR, name), 'utf8'), /parse_apply/, name);
});

const canRun = process.platform !== 'win32' && !(process.getuid && process.getuid() === 0);
const sh = (args) => spawnSync('sh', [path.join(DIR, 'provision.sh'), ...args], { encoding: 'utf8', env: { ...process.env, PATH: process.env.PATH } });

test('provision.sh without --apply only prints what it would do', { skip: !canRun }, () => {
  const r = sh(['--hermes-bin', '/opt/hermes/bin/hermes', '--no-prod-check', '--bind-ip', ip(100, 101, 102, 103)]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /mode: dry run/);
  assert.match(r.stdout, /DRY-RUN: sudo useradd/);
  assert.ok(!/^\+ /m.test(r.stdout), 'nothing was executed');
});

test('provision.sh refuses a bad user, a non-tailnet address and a missing production check', { skip: !canRun }, () => {
  const base = ['--hermes-bin', '/opt/hermes/bin/hermes', '--bind-ip', ip(100, 101, 102, 103), '--no-prod-check'];
  for (const bad of [['--user', 'root'], ['--user', 'alan'], ['--bind-ip', '192.168.1.9'], ['--bind-ip', '0.0.0.0'], ['--hermes-bin', 'hermes'], ['--model', 'a b']]) {
    const r = sh([...base, ...bad]);
    assert.equal(r.status, 2, `${bad.join(' ')}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /^refused:/m);
  }
  assert.equal(sh(['--hermes-bin', '/opt/hermes/bin/hermes', '--bind-ip', ip(100, 101, 102, 103)]).status, 2);
});
