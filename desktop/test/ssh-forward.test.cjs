const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createSshForward } = require('../src/ssh-forward.cjs');

const flush = () => new Promise((resolve) => setImmediate(resolve));

// The real host rule depends on HERMES_WORKSPACE_REQUIRE_TAILNET (CI sets it); only the refusal test needs it.
function rig({ answering = new Set(), isHost = (value) => /^[\w.@-]+$/.test(value) } = {}) {
  const spawned = [], queue = [], changes = [];
  const timers = { set: (fn, ms) => { const t = { fn, ms }; queue.push(t); return t; }, clear: (t) => { const i = queue.indexOf(t); if (i >= 0) queue.splice(i, 1); } };
  let pid = 1000;
  const spawn = (command, args, options) => {
    const child = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), pid: ++pid, killed: 0, command, args, options });
    child.kill = () => { child.killed += 1; setImmediate(() => child.emit('exit', null)); };
    spawned.push(child);
    return child;
  };
  const probe = async (port, bind) => answering.has(`${bind}:${port}`);
  const forward = createSshForward({ spawn, probe, timers, isHost, sshOptions: ['-F', 'none'], onChange: () => changes.push(forward.state().state) });
  const fire = async () => { const t = queue.shift(); await t.fn(); await flush(); return t; };
  return { forward, spawned, queue, changes, fire, answering };
}

test('starts one ssh with an argument array, the shared options and a forward per port', async () => {
  const { forward, spawned, fire } = rig();
  assert.equal(forward.set('agent@vm.tail1234.ts.net', [{ host: '127.0.0.1', port: 9120 }, { host: 'localhost', port: 8642 }, { host: '127.0.0.1', port: 8642 }]), true);
  await fire();
  assert.equal(spawned.length, 1);
  const { command, args, options } = spawned[0];
  assert.equal(command, 'ssh');
  assert.deepEqual(args, ['-N', '-F', 'none', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
    '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=accept-new', '-L', '127.0.0.1:8642:127.0.0.1:8642', '-L', '127.0.0.1:9120:127.0.0.1:9120', 'agent@vm.tail1234.ts.net']);
  assert.ok(args.every((a) => typeof a === 'string'));
  assert.equal(options.shell, undefined);
});

test('an ::1 address gets its own bind', async () => {
  const { forward, spawned, fire } = rig();
  forward.set('agent@vm.tail1234.ts.net', [{ host: '[::1]', port: 8642 }]);
  await fire();
  assert.deepEqual(spawned[0].args.slice(-3), ['-L', '[::1]:8642:127.0.0.1:8642', 'agent@vm.tail1234.ts.net']);
});

test('refuses a bad host, bad ports and non-loopback targets', async () => {
  const { forward, spawned, queue } = rig({ isHost: undefined });
  for (const host of ['', '-oProxyCommand=evil', 'a b', 'host;rm -rf', 'root@host\nx', '$(id)', 5, null]) assert.equal(forward.set(host, [{ host: '127.0.0.1', port: 8642 }]), false, String(host));
  for (const bad of [0, 65536, -1, 1.5, '8642', NaN, null]) assert.equal(forward.set('agent@vm.tail1234.ts.net', [{ host: '127.0.0.1', port: bad }]), false, String(bad));
  assert.equal(forward.set('agent@vm.tail1234.ts.net', [{ host: 'example.com', port: 8642 }, { host: '10.0.0.1', port: 8642 }]), false);
  assert.equal(queue.length, 0);
  assert.equal(spawned.length, 0);
  assert.equal(forward.state().state, 'off');
});

test('a port that already answers is not forwarded and nothing is spawned', async () => {
  const { forward, spawned, fire, answering } = rig();
  answering.add('127.0.0.1:8642');
  forward.set('agent@vm.tail1234.ts.net', [{ host: '127.0.0.1', port: 8642 }]);
  await fire();
  assert.equal(spawned.length, 0);
  assert.equal(forward.state().state, 'external');
});

test('only the ports that do not answer are forwarded', async () => {
  const { forward, spawned, fire, answering } = rig();
  answering.add('127.0.0.1:8642');
  forward.set('agent@vm.tail1234.ts.net', [{ host: '127.0.0.1', port: 8642 }, { host: '127.0.0.1', port: 9120 }]);
  await fire();
  assert.deepEqual(spawned[0].args.filter((a) => a.startsWith('127.0.0.1:')), ['127.0.0.1:9120:127.0.0.1:9120']);
});

test('connecting, then up once the port answers', async () => {
  const { forward, fire, answering, changes } = rig();
  forward.set('agent@vm.tail1234.ts.net', [{ host: '127.0.0.1', port: 8642 }]);
  assert.equal(forward.note(), 'Connecting to your server…');
  await fire();
  await fire();
  assert.equal(forward.state().state, 'connecting');
  answering.add('127.0.0.1:8642');
  await fire();
  assert.equal(forward.state().state, 'up');
  assert.equal(forward.note(), '');
  assert.deepEqual(changes, ['connecting', 'up']);
});

test('ready() resolves when the attempt has an outcome', async () => {
  const { forward, fire, answering } = rig();
  forward.set('agent@vm.tail1234.ts.net', [{ host: '127.0.0.1', port: 8642 }]);
  let done = false;
  const waiting = forward.ready().then(() => { done = true; });
  await fire(); await flush();
  assert.equal(done, false);
  answering.add('127.0.0.1:8642');
  await fire();
  await waiting;
  assert.equal(done, true);
});

test('restarts with a doubling, capped backoff and reports the first stderr line', async () => {
  const { forward, spawned, queue, fire } = rig();
  forward.set('agent@vm.tail1234.ts.net', [{ host: '127.0.0.1', port: 8642 }]);
  await fire();
  const delays = [];
  for (let i = 0; i < 8; i += 1) {
    const child = spawned[spawned.length - 1];
    child.stderr.emit('data', Buffer.from('Warning: Permanently added x\nagent@vm.tail1234.ts.net: Permission denied (publickey).\nmore\n'));
    child.emit('exit', 255);
    delays.push(queue.at(-1).ms);
    await fire();
  }
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  assert.equal(spawned.length, 9);
  assert.equal(forward.state().state, 'failed');
  assert.equal(forward.state().reason, 'agent@vm.tail1234.ts.net: Permission denied (publickey).');
  assert.match(forward.note(), /^Can't open the connection to your server \(agent@vm\.tail1234\.ts\.net: Permission denied \(publickey\)\.\)\. Check that Tailscale is on/);
});

test('a spawn error counts as a failure and retries', async () => {
  const { forward, spawned, queue, fire } = rig();
  forward.set('agent@vm.tail1234.ts.net', [{ host: '127.0.0.1', port: 8642 }]);
  await fire();
  spawned[0].emit('error', new Error('spawn ssh ENOENT'));
  spawned[0].emit('exit', null);
  assert.equal(forward.state().reason, 'spawn ssh ENOENT');
  assert.equal(queue.at(-1).ms, 1000);
});

test('a successful connection resets the backoff', async () => {
  const { forward, spawned, queue, fire, answering } = rig();
  forward.set('agent@vm.tail1234.ts.net', [{ host: '127.0.0.1', port: 8642 }]);
  await fire();
  spawned[0].emit('exit', 255);
  await fire();
  spawned[1].emit('exit', 255);
  assert.equal(queue.at(-1).ms, 2000);
  await fire();
  answering.add('127.0.0.1:8642');
  await fire();
  assert.equal(forward.state().state, 'up');
  answering.delete('127.0.0.1:8642');
  spawned[2].emit('exit', 255);
  assert.equal(queue.at(-1).ms, 1000);
});

test('stop kills only its own child, once, and nothing restarts', async () => {
  const { forward, spawned, queue, fire } = rig();
  forward.set('agent@vm.tail1234.ts.net', [{ host: '127.0.0.1', port: 8642 }]);
  await fire();
  const kills = [];
  const child = spawned[0];
  child.kill = (...args) => { kills.push(args); setImmediate(() => child.emit('exit', null)); };
  forward.stop();
  await flush();
  assert.deepEqual(kills, [[]]);
  assert.equal(queue.length, 0);
  assert.equal(spawned.length, 1);
  assert.equal(forward.state().state, 'off');
  forward.stop();
  assert.deepEqual(kills, [[]]);
});

test('a child whose pid is not above 1 is never signalled', async () => {
  const { forward, spawned, fire } = rig();
  forward.set('agent@vm.tail1234.ts.net', [{ host: '127.0.0.1', port: 8642 }]);
  await fire();
  for (const pid of [0, 1, -5, undefined, 1.5]) {
    spawned[0].pid = pid;
    spawned[0].killed = 0;
    forward.set('', []);
    assert.equal(spawned[0].killed, 0, String(pid));
    forward.set('agent@vm.tail1234.ts.net', [{ host: '127.0.0.1', port: 8642 }]);
  }
});

test('no restart after the surface is turned off, even if ssh exits later', async () => {
  const { forward, spawned, queue, fire } = rig();
  forward.set('agent@vm.tail1234.ts.net', [{ host: '127.0.0.1', port: 8642 }]);
  await fire();
  spawned[0].emit('exit', 255);
  assert.equal(queue.length, 1);
  forward.set('', []);
  assert.equal(queue.length, 0);
  await flush();
  assert.equal(spawned.length, 1);
});

test('a changed address replaces the tunnel after the old ssh exits', async () => {
  const { forward, spawned, queue, fire } = rig();
  forward.set('agent@vm.tail1234.ts.net', [{ host: '127.0.0.1', port: 8642 }]);
  await fire();
  forward.set('agent@vm.tail1234.ts.net', [{ host: '127.0.0.1', port: 8642 }]);
  assert.equal(spawned[0].killed, 0, 'the same wish does nothing');
  forward.set('agent@vm.tail1234.ts.net', [{ host: '127.0.0.1', port: 8643 }]);
  assert.equal(spawned[0].killed, 1);
  assert.equal(spawned.length, 1, 'waits for the old ssh to let go');
  await flush();
  assert.equal(queue.length, 1);
  await fire();
  assert.equal(spawned.length, 2);
  assert.ok(spawned[1].args.includes('127.0.0.1:8643:127.0.0.1:8643'));
});

test('an own tunnel that dies is noticed again after the external check interval', async () => {
  const { forward, spawned, queue, fire, answering } = rig();
  answering.add('127.0.0.1:8642');
  forward.set('agent@vm.tail1234.ts.net', [{ host: '127.0.0.1', port: 8642 }]);
  await fire();
  assert.equal(queue.at(-1).ms, 30000);
  answering.clear();
  await fire();
  assert.equal(spawned.length, 1);
});
