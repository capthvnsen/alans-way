const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createWebappLink, createLaunchWatch, launchFragment, COMMAND } = require('../src/webapp-link.cjs');

const TICKET = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v'.slice(0, 43);
const LINK = `http://127.0.0.1:9120/webapp/launch#ticket=${TICKET}`;
const HOST = 'agent@vm.tail1234.ts.net';
const TARGET = 'http://127.0.0.1:9120/';

function rig(result, { open = () => {} } = {}) {
  const calls = [], opened = [], logs = [];
  const link = createWebappLink({
    run: async (host, command, options) => { calls.push({ host, command, options }); return typeof result === 'function' ? result() : result; },
    open: (url) => { opened.push(url); open(url); },
    log: (line) => logs.push(line),
    isHost: (value) => /^[\w.@-]+$/.test(value),
  });
  return { link, calls, opened, logs };
}
const ok = { code: 0, out: `Webapp ready.\nOpen: ${LINK}\nThis link works once.\n`, err: '' };

test('a printed link is opened and the remote command is the fixed string', async () => {
  const { link, calls, opened } = rig(ok);
  assert.equal(await link.fetch({ host: HOST }), '');
  assert.deepEqual(opened, [LINK]);
  assert.deepEqual(calls, [{ host: HOST, command: 'hermes webapp --no-open --skip-build', options: { timeoutMs: 20000 } }]);
  assert.equal(COMMAND, 'hermes webapp --no-open --skip-build');
});

test('the link is found among ANSI colour and a timeout still counts when the link was printed', async () => {
  const { link, opened } = rig({ code: -1, out: `\x1b[32m${LINK}\x1b[0m\n`, err: '' });
  assert.equal(await link.fetch({ host: HOST }), '');
  assert.deepEqual(opened, [LINK]);
});

test('the link and ticket never reach the log or the returned reason', async () => {
  for (const result of [ok, { code: 1, out: `${LINK}x`, err: `boom ${LINK}` }, { code: 0, out: `http://127.0.0.1:9120/webapp/launch#ticket=short`, err: '' }]) {
    const { link, logs } = rig(result, { open: () => { throw new Error(`bad ${LINK}`); } });
    const reason = await link.fetch({ host: HOST });
    for (const text of [reason, ...logs]) { assert.equal(text.includes(TICKET), false); assert.equal(text.includes('ticket='), false); }
    assert.equal(logs.length, 1);
  }
});

test('a failed try says why in plain words and opens nothing', async () => {
  const cases = [
    [{ code: 255, out: '', err: 'ssh: connect to host x port 22: Operation timed out' }, "ssh couldn't connect to the server"],
    [{ code: 127, out: '', err: 'bash: hermes: command not found' }, "hermes isn't on the server's path"],
    [{ code: -1, out: '', err: '' }, 'it took too long'],
    [{ code: -1, out: '', err: 'spawn ssh ENOENT' }, "ssh didn't start"],
    [{ code: 1, out: '', err: 'Traceback…' }, 'hermes reported an error'],
    [{ code: 0, out: 'Webapp ready.\n', err: '' }, 'hermes printed no link'],
  ];
  for (const [result, expected] of cases) {
    const { link, opened } = rig(result);
    assert.equal(await link.fetch({ host: HOST }), expected);
    assert.deepEqual(opened, []);
  }
});

test('a link the app refuses reports a plain reason', async () => {
  const { link } = rig(ok, { open: () => { throw new Error('nope'); } });
  assert.equal(await link.fetch({ host: HOST }), "Workspace couldn't use the link hermes printed");
});

test('nothing is opened when the address changed while ssh ran', async () => {
  const { link, opened } = rig(ok);
  assert.equal(await link.fetch({ host: HOST, canOpen: () => false }), '');
  assert.deepEqual(opened, []);
});

test('one automatic try per episode until reset', async () => {
  const { link } = rig(ok);
  const ask = { target: TARGET, host: HOST, needsLink: true };
  assert.equal(link.wants(ask), true);
  await link.fetch({ host: HOST });
  assert.equal(link.wants(ask), false);
  link.reset();
  assert.equal(link.wants(ask), true);
});

test('it is not wanted for a remote address, without a saved SSH host, with a bad host, or when sign-in is required', () => {
  const { link } = rig(ok);
  const ask = { target: TARGET, host: HOST, needsLink: true };
  assert.equal(link.wants(ask), true);
  assert.equal(link.wants({ ...ask, target: 'https://box.tail1234.ts.net/' }), false);
  assert.equal(link.wants({ ...ask, target: 'http://10.0.0.5:9120/' }), false);
  assert.equal(link.wants({ ...ask, target: 'not a url' }), false);
  assert.equal(link.wants({ ...ask, host: '' }), false);
  assert.equal(link.wants({ ...ask, host: '-oProxyCommand=x y' }), false);
  assert.equal(link.wants({ ...ask, needsLink: false }), false);
  assert.equal(link.wants({ target: TARGET, host: HOST }), false);
  assert.equal(link.wants({ ...ask, target: 'http://[::1]:9120/' }), true);
  assert.equal(link.wants({ ...ask, target: 'http://localhost:9120/' }), true);
});

function watch(ms) {
  const queue = [], stale = [];
  const timers = { set: (fn, delay) => { const t = { fn, delay }; queue.push(t); return t; }, clear: (t) => { const i = queue.indexOf(t); if (i >= 0) queue.splice(i, 1); } };
  return { queue, stale, watch: createLaunchWatch({ onStale: () => stale.push(true), ms, timers }) };
}

test('a launch page that never leads anywhere is reported stale after the wait', () => {
  const { queue, stale, watch: w } = watch(8000);
  w.arm();
  assert.equal(queue.length, 1);
  assert.equal(queue[0].delay, 8000);
  assert.deepEqual(stale, []);
  queue[0].fn();
  assert.deepEqual(stale, [true]);
});

test('leaving the launch page in time cancels the wait, and loading again restarts it', () => {
  const { queue, stale, watch: w } = watch(8000);
  w.arm(); w.arm();
  assert.equal(queue.length, 1, 'one timer at a time');
  w.disarm();
  assert.equal(queue.length, 0);
  w.disarm();
  assert.deepEqual(stale, []);
});

test('a pasted launch link is found whatever was copied with it', () => {
  const frag = `#ticket=${TICKET}`;
  const wrapped = `${TICKET.slice(0, 20)}\n      ${TICKET.slice(20)}`;
  assert.equal(launchFragment(LINK), frag);
  assert.equal(launchFragment(`  ${LINK}\n`), frag);
  assert.equal(launchFragment(`Webapp ready.\n  Open:\n  ${LINK}\nThis link works once, for 60 seconds.\n`), frag);
  assert.equal(launchFragment(`http://127.0.0.1:9120/webapp/launch#ticket=${wrapped}`), frag);
  assert.equal(launchFragment(`http://127.0.0.1:91\n20/webapp/lau nch#ticket=${TICKET}`), frag);
  assert.equal(launchFragment(`${LINK}&next=%2F`), `${frag}&next=%2F`);
  assert.equal(launchFragment(`https://box.tail1234.ts.net/webapp/launch#ticket=${TICKET}`), frag);
});

test('a paste without a one-use link is refused', () => {
  assert.equal(launchFragment(''), '');
  assert.equal(launchFragment(' \n '), '');
  assert.equal(launchFragment(undefined), '');
  assert.equal(launchFragment(`http://127.0.0.1:9120/webapp/launch#ticket=${TICKET.slice(0, 42)}`), '');
  assert.equal(launchFragment(`http://127.0.0.1:9120/webapp/launch#ticket=${TICKET.slice(0, 20)}!${TICKET.slice(21)}`), '');
  assert.equal(launchFragment(`http://127.0.0.1:9120/webapp/other#ticket=${TICKET}`), '');
  assert.equal(launchFragment(`http://127.0.0.1:9120/webapp/launch?ticket=${TICKET}`), '');
  assert.equal(launchFragment(`127.0.0.1:9120/webapp/launch#ticket=${TICKET}`), '');
  assert.equal(launchFragment('Paste the one-use link that hermes webapp --no-open prints'), '');
});
