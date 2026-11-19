'use strict';
process.env.HERMES_WORKSPACE_ALLOW_LOOPBACK = '1'; // loopback fixtures under HERMES_WORKSPACE_REQUIRE_TAILNET=1, as the other hermes tests
// Link supervisor over a fake wire: the REAL HermesSessionWire and controller
// run over in-memory streams against the shared gateway engine (replay ring,
// epoch, orphan grace). No sockets, no Electron. Timers are real and small.
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { HermesSessionWire } = require('../src/hermes-session-wire.cjs');
const { RemoteError } = require('../src/hermes-remote.cjs');
const { createGatewayLink, LinkError } = require('../src/gateway-link.cjs');
const { createGatewayEngine } = require('./hermes-gateway-engine.cjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(pred, ms = 5000, what = 'condition') {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(2); }
}

// One in-memory "socket" between a real wire and the engine.
function memConn(engine, server) {
  const input = new PassThrough(), output = new PassThrough();
  input.on('error', () => {}); // the real adapter keeps the same permanent sink
  const wire = new HermesSessionWire({ input, output });
  const peer = engine.connect((o) => { if (!conn.silent && !input.destroyed) input.write(JSON.stringify(o) + '\n'); });
  const conn = { wire, input, epoch: engine.epoch(), silent: false, closed: false };
  let rest = '';
  output.on('data', (c) => {
    rest += c.toString('utf8');
    let i;
    while ((i = rest.indexOf('\n')) >= 0) {
      const f = JSON.parse(rest.slice(0, i)); rest = rest.slice(i + 1);
      if (conn.silent || f.id === undefined) continue;
      Promise.resolve(engine.handle(peer, f)).then((r) => { if (r !== undefined && !conn.silent && !input.destroyed) input.write(JSON.stringify({ jsonrpc: '2.0', id: f.id, ...r }) + '\n'); });
    }
  });
  conn.close = () => { if (conn.closed) return; conn.closed = true; server.open--; engine.disconnect(peer); };
  conn.reset = () => { engine.disconnect(peer); input.destroy(new Error('reset')); };
  setImmediate(() => input.write(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready', payload: { replay_epoch: engine.epoch() } } }) + '\n'));
  return conn;
}

const live = [];
// Whatever a test (even a failing one) started is stopped here, so nothing keeps the suite alive.
afterEach(() => { for (const stop of live.splice(0)) stop(); });

function rig(engineCfg = {}, linkCfg = {}) {
  const engine = createGatewayEngine({ sessions: [], orphanGraceMs: 5000, deltaCount: 6, deltaMs: 15, ...engineCfg });
  const server = { opens: 0, open: 0, maxOpen: 0, maxInFlight: 0, inFlight: 0, gate: null, fail: 0, conns: [], failWith: null };
  const open = async () => {
    server.opens++; server.inFlight++; server.maxInFlight = Math.max(server.maxInFlight, server.inFlight);
    try {
      if (server.gate) await server.gate;
      if (server.fail > 0) { server.fail--; throw server.failWith || new RemoteError('unreachable', 'refused'); }
      const c = memConn(engine, server);
      server.open++; server.maxOpen = Math.max(server.maxOpen, server.open);
      server.conns.push(c);
      return c;
    } finally { server.inFlight--; }
  };
  const logs = [];
  const link = createGatewayLink({
    open, log: (event, f) => logs.push([event, f]),
    options: { baseMs: 5, capMs: 40, pingIdleMs: 1e9, pingDeadMs: 50, offlinePollMs: 10, connectTimeoutMs: 500, bindTimeoutMs: 500 },
    ...linkCfg,
  });
  const states = [], events = [], gaps = [];
  link.on('state', (s) => states.push(s.state));
  link.on('event', (e) => events.push(e));
  link.on('gap', (g) => gaps.push(g));
  const hold = () => { let release; server.gate = new Promise((r) => { release = r; }); return () => { server.gate = null; release(); }; };
  const done = () => { link.stop(); engine.close(); };
  live.push(done);
  return { engine, server, link, states, events, gaps, logs, hold, done };
}
const seqs = (events, id = 'k1') => events.filter((e) => e.storedId === id && e.type !== 'gateway.ready').map((e) => e.seq);

test('backoff: first retry is immediate, then 0.5 s doubling to the 15 s cap, full jitter scales it', async () => {
  const delays = [];
  let n = 0;
  const link = createGatewayLink({
    open: async () => { n++; throw new RemoteError('unreachable', 'x'); },
    timers: { random: () => 1, setTimeout: (fn, ms) => { delays.push(ms); return setTimeout(fn, 1); } },
  });
  live.push(() => link.stop());
  link.start();
  await until(() => n >= 9);
  link.stop();
  assert.deepEqual(delays.slice(0, 8), [0, 500, 1000, 2000, 4000, 8000, 15000, 15000]);

  const half = [];
  let m = 0;
  const link2 = createGatewayLink({
    open: async () => { m++; throw new RemoteError('unreachable', 'x'); },
    timers: { random: () => 0.5, setTimeout: (fn, ms) => { half.push(ms); return setTimeout(fn, 1); } },
  });
  live.push(() => link2.stop());
  link2.start();
  await until(() => m >= 4);
  link2.stop();
  assert.deepEqual(half.slice(0, 3), [0, 250, 500]);
});

// Virtual time for the reconnect rule: the link's clock and timers are fake, so 3 minutes of flapping cost milliseconds.
// The server, wire and controller still run for real (microtasks only); each step waits for the link, not for a duration.
function retryRig({ random = 1 } = {}) {
  let clock = 1000, seq = 0;
  const queue = [];
  const vt = {
    now: () => clock, advance: (ms) => { clock += ms; },
    setTimeout: (fn, ms) => { const t = { at: clock + ms, seq: seq++, fn, unref() {} }; queue.push(t); return t; },
    clearTimeout: (t) => { const i = queue.indexOf(t); if (i >= 0) queue.splice(i, 1); },
    fire() { queue.sort((x, y) => x.at - y.at || x.seq - y.seq); const t = queue.shift(); clock = Math.max(clock, t.at); t.fn(); },
  };
  const r = rig({}, { options: { baseMs: 500, capMs: 15000, pingIdleMs: 1e9, pingDeadMs: 50, offlinePollMs: 10, connectTimeoutMs: 500, bindTimeoutMs: 500 }, timers: { random: () => random, now: vt.now, setTimeout: vt.setTimeout, clearTimeout: vt.clearTimeout } });
  r.vt = vt;
  r.retries = () => r.logs.filter(([event]) => event === 'link.retry').map(([, f]) => f.inMs);
  // Close the live socket after it has been live `liveMs`, then let the scheduled reconnect run.
  r.dropAfter = async (liveMs) => {
    await until(() => r.link.isLive(), 5000, 'live');
    vt.advance(liveMs);
    r.server.conns.at(-1).reset();
    await until(() => !r.link.isLive(), 5000, 'the drop to be seen');
    vt.fire();
  };
  r.flapUntil = async (liveMs, endAt) => { while (vt.now() < endAt) await r.dropAfter(liveMs); };
  return r;
}

test('backoff: the first five drops of a live link in 2 minutes reconnect at once, seven idle closes 0.5 s apart never wait over 1 s', async () => {
  const r = retryRig();
  r.link.start();
  for (let n = 0; n < 7; n++) await r.dropAfter(500);
  await until(() => r.link.isLive());
  assert.deepEqual(r.retries(), [0, 0, 0, 0, 0, 500, 1000]); // random = 1: the longest each wait can be
  r.done();
});

test('backoff: an occasional drop on a healthy link reconnects at once, however many over time', async () => {
  const r = retryRig();
  r.link.start();
  for (let n = 0; n < 12; n++) await r.dropAfter(30000); // 4 drops in any 2 minutes
  assert.deepEqual(r.retries(), Array(12).fill(0));
  r.done();
});

test('backoff: a link dropped every 200 ms settles to a handful of attempts a minute, whatever the jitter draws', async () => {
  for (const random of [0, 0.5, 1]) {
    const r = retryRig({ random });
    r.link.start();
    await r.flapUntil(200, 1000 + 180000);
    const t0 = r.vt.now(), before = r.server.opens;
    await r.flapUntil(200, t0 + 60000);
    const lastMinute = r.server.opens - before;
    assert.ok(lastMinute <= 8, `random=${random}: ${lastMinute} attempts in the last minute`);
    assert.ok(Math.max(...r.retries()) <= 15000, 'no wait beyond the cap');
    r.done();
  }
});

test('backoff: a server that accepts and drops at once backs off after the free drops, up to the cap', async () => {
  const r = retryRig();
  r.link.start();
  for (let n = 0; n < 11; n++) await r.dropAfter(0);
  assert.deepEqual(r.retries(), [0, 0, 0, 0, 0, 500, 1000, 2000, 4000, 8000, 15000]);
  r.done();
});

test('backoff: a refused attempt after a healthy drop starts the failure delays over (0, then 500)', async () => {
  const r = retryRig();
  r.link.start();
  await until(() => r.link.isLive());
  r.server.fail = 1;
  r.vt.advance(5000);
  r.server.conns[0].reset();
  await until(() => !r.link.isLive());
  r.vt.fire(); // the drop's own immediate retry: refused
  await until(() => r.server.opens === 2 && r.retries().length === 2, 5000, 'the refused attempt to schedule its retry');
  r.vt.fire();
  await until(() => r.server.opens === 3 && r.link.isLive(), 5000, 'live again');
  assert.deepEqual(r.retries(), [0, 500]);
  r.done();
});

test('a reply streaming at a reset arrives whole: replay since lastSeq, nothing lost, nothing doubled', async () => {
  const r = rig();
  r.link.start();
  await until(() => r.link.isLive());
  await r.link.attach('k1');
  await r.link.submit('k1', 'hi');
  await until(() => seqs(r.events).length >= 2);
  r.server.conns[0].reset();
  await until(() => r.states.includes('syncing') || r.link.getState().state === 'live' && r.server.opens > 1);
  await until(() => r.events.some((e) => e.type === 'message.complete'));
  assert.deepEqual(seqs(r.events), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(r.events.filter((e) => e.type === 'message.complete')[0].payload.text, 'w0 w1 w2 w3 w4 w5 ');
  assert.equal(r.engine.submits.length, 1, 'the link never resends a prompt');
  assert.deepEqual(r.gaps, []);
  assert.equal(r.server.maxOpen, 1);
  r.done();
});

test('duplicate and out-of-order replay is applied once and in order', async () => {
  const r = rig({ mangleReplay: (events) => [...events].reverse().concat(events.slice(0, 1)) });
  r.link.start();
  await until(() => r.link.isLive());
  await r.link.attach('k1');
  const gate = r.hold();
  await r.link.submit('k1', 'hi');
  await until(() => seqs(r.events).length >= 2);
  r.server.conns[0].reset();
  await until(() => r.engine.applied.some((e) => e.type === 'message.complete'), 5000, 'the turn to finish with nobody attached');
  gate();
  await until(() => r.events.some((e) => e.type === 'message.complete'));
  const s = seqs(r.events);
  assert.deepEqual(s, [...new Set(s)].sort((a, b) => a - b), 'strictly increasing, no repeats');
  assert.equal(s.length, 8);
  r.done();
});

test('truncated replay: gap reported, no error state, next send works', async () => {
  const r = rig({ ringMax: 3 });
  r.link.start();
  await until(() => r.link.isLive());
  await r.link.attach('k1');
  const gate = r.hold();
  await r.link.submit('k1', 'hi');
  await until(() => seqs(r.events).length >= 2);
  r.server.conns[0].reset();
  await until(() => r.engine.applied.some((e) => e.type === 'message.complete'), 5000, 'the turn to finish with nobody attached');
  gate();
  await until(() => r.gaps.length === 1 && r.link.isLive());
  assert.equal(r.gaps[0].reason, 'truncated');
  assert.ok(!r.states.includes('signin') && !r.states.includes('stopped'));
  await until(() => r.link.getState().attached === 1, 1000, 're-attach');
  await r.link.submit('k1', 'again');
  r.done();
});

test('epoch change: watermark discarded, history path, a fresh seq 1 is not mistaken for a duplicate', async () => {
  const r = rig();
  r.link.start();
  await until(() => r.link.isLive());
  await r.link.attach('k1');
  await r.link.submit('k1', 'one');
  await until(() => r.events.some((e) => e.type === 'message.complete'));
  const before = r.events.length;
  const gate = r.hold();
  r.server.conns[0].reset();
  r.engine.restart();
  gate();
  await until(() => r.gaps.length === 1 && r.link.isLive());
  assert.equal(r.gaps[0].reason, 'restarted');
  await until(() => r.link.getState().attached === 1, 1000, 're-attach on the new epoch');
  await r.link.submit('k1', 'two');
  await until(() => r.events.slice(before).some((e) => e.type === 'message.complete'));
  assert.deepEqual(seqs(r.events.slice(before)), [1, 2, 3, 4, 5, 6, 7, 8]);
  r.done();
});

test('a session reaped after the grace window goes the history path, quietly', async () => {
  const r = rig({ orphanGraceMs: 30 });
  r.link.start();
  await until(() => r.link.isLive());
  await r.link.attach('k1');
  await r.link.submit('k1', 'hi');
  await until(() => seqs(r.events).length >= 1);
  const gate = r.hold();
  r.server.conns[0].reset();
  await until(() => r.engine.liveSessions().length === 0, 5000, 'the engine to reap the orphan');
  gate();
  await until(() => r.gaps.length === 1 && r.link.isLive());
  assert.equal(r.gaps[0].reason, 'reaped');
  assert.ok(!r.states.some((s) => s === 'signin' || s === 'idle'));
  r.done();
});

test('ping: silence is probed, a dead answer drops the socket and reconnects', async () => {
  // pingDeadMs is generous: answered pings must never look dead on a loaded machine. Nothing below
  // asserts how long detection took (the drop harness measures that); it waits for events.
  const r = rig({}, { options: { baseMs: 5, capMs: 40, pingIdleMs: 20, pingDeadMs: 300, offlinePollMs: 10, connectTimeoutMs: 500, bindTimeoutMs: 500 } });
  r.link.start();
  await until(() => r.link.isLive());
  const first = r.server.conns[0];
  await until(() => r.engine.pings() >= 2, 5000, 'two answered idle pings');
  assert.equal(r.server.opens, 1, 'answered pings keep the same socket');
  first.silent = true;
  // The link goes live -> reconnecting -> syncing -> live in a few ms; read the recorded
  // transitions, not a poll that can land after the whole round trip.
  await until(() => r.server.opens === 2 && r.link.isLive(), 5000, 'a second socket after the silence');
  assert.ok(r.states.indexOf('reconnecting') > r.states.indexOf('live'), 'the silence was seen as a drop');
  assert.ok(r.logs.some(([event, f]) => event === 'link.dropped' && f.reason === 'ping_timeout'));
  assert.equal(r.server.maxOpen, 1);
  r.done();
});

test('ping: bytes from a dropped socket do not vouch for its replacement', async () => {
  const r = rig({}, { options: { baseMs: 5, capMs: 40, pingIdleMs: 20, pingDeadMs: 300, offlinePollMs: 10, connectTimeoutMs: 500, bindTimeoutMs: 500 } });
  r.link.start();
  await until(() => r.link.isLive());
  const old = r.server.conns[0];
  r.link.trigger('wake');
  await until(() => r.server.opens === 2 && r.link.isLive());
  // The second socket goes dead while the first one, long dropped, keeps emitting bytes.
  r.server.conns[1].silent = true;
  const noise = setInterval(() => old.input.write('\n'), 2);
  try {
    await until(() => r.server.opens === 3 && r.link.isLive(), 5000, 'the dead second socket to be noticed');
  } finally { clearInterval(noise); }
  assert.ok(r.logs.some(([event, f]) => event === 'link.dropped' && f.reason === 'ping_timeout'));
  r.done();
});

test('triggers skip the wait: online ends a backoff sleep, wake drops a live socket', async () => {
  const r = rig({}, { options: { baseMs: 60000, capMs: 60000, pingIdleMs: 1e9, pingDeadMs: 50, offlinePollMs: 10, connectTimeoutMs: 500, bindTimeoutMs: 500 }, timers: { random: () => 1 } });
  r.server.fail = 2;
  r.link.start();
  await until(() => r.server.opens >= 2); // immediate retry, then a 60 s sleep
  await sleep(30);
  assert.equal(r.server.opens, 2);
  r.link.trigger('online');
  await until(() => r.link.isLive());
  assert.equal(r.server.opens, 3);
  r.link.trigger('wake');
  await until(() => r.server.opens === 4 && r.link.isLive());
  assert.equal(r.server.maxOpen, 1);
  r.done();
});

test('one attempt at a time and one socket, however many triggers or flaps', async () => {
  const r = rig();
  r.link.start();
  const gate = r.hold();
  for (let i = 0; i < 12; i++) r.link.trigger('online');
  await sleep(20);
  assert.equal(r.server.maxInFlight, 1);
  gate();
  await until(() => r.link.isLive());
  for (let i = 0; i < 8; i++) {
    r.server.conns.at(-1).reset();
    r.link.trigger('wake'); r.link.trigger('online');
    await until(() => r.link.isLive() && r.server.conns.at(-1).closed === false, 1000, 'flap recovery');
  }
  assert.equal(r.server.maxInFlight, 1);
  assert.equal(r.server.maxOpen, 1);
  r.done();
});

test('suspend closes the socket and attempts nothing; resume reconnects at once', async () => {
  const r = rig({ orphanGraceMs: 20 });
  r.link.start();
  await until(() => r.link.isLive());
  await r.link.attach('k1');
  r.link.suspend();
  assert.equal(r.link.getState().state, 'suspended');
  assert.equal(r.server.open, 0);
  await until(() => r.engine.liveSessions().length === 0, 5000, 'the grace window to pass');
  await sleep(50); // a negative check: nothing may be attempted while suspended
  assert.equal(r.server.opens, 1, 'no attempt while suspended');
  r.link.resume();
  await until(() => r.link.isLive());
  assert.equal(r.gaps.length, 1);
  assert.equal(r.gaps[0].reason, 'reaped');
  assert.ok(!r.states.includes('signin'));
  r.done();
});

test('a refused sign-in stops retrying and says so; credentials trigger a new attempt', async () => {
  const r = rig();
  r.server.fail = 1; r.server.failWith = new RemoteError('session_expired', 'expired');
  r.link.start();
  await until(() => r.link.getState().state === 'signin');
  await sleep(60);
  assert.equal(r.server.opens, 1);
  r.link.trigger('credentials');
  await until(() => r.link.isLive());
  r.done();
});

test('offline: no attempt without a network, polled until it returns', async () => {
  let online = false;
  const r = rig({}, { isOnline: () => online });
  r.link.start();
  await until(() => r.link.getState().state === 'offline');
  await sleep(50);
  assert.equal(r.server.opens, 0);
  online = true;
  await until(() => r.link.isLive());
  r.done();
});

test('a send while the link is not live is refused, not queued', async () => {
  const r = rig();
  await assert.rejects(r.link.submit('k1', 'hi'), (e) => e instanceof LinkError && e.code === 'not_live');
  r.done();
});

test('a refused address ends in the refused state: one attempt, no retry loop, nothing left running', async () => {
  let opens = 0;
  const link = createGatewayLink({ open: async () => { opens++; throw new RemoteError('bad_url', 'Use a literal Tailscale IP address for the Hermes backend.'); },
    options: { baseMs: 5, capMs: 10 } });
  live.push(() => link.stop());
  link.start();
  await until(() => link.getState().state === 'refused');
  await sleep(60);
  assert.equal(opens, 1);
  assert.equal(link.getState().lastError, 'bad_url');
  link.trigger('online'); link.trigger('wake');
  await sleep(30);
  assert.equal(opens, 2, 'a trigger tries once more, and lands in refused again');
  assert.equal(link.getState().state, 'refused');
  link.stop();
  await sleep(30);
  assert.equal(opens, 2);
});
