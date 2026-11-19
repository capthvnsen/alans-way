'use strict';
process.env.HERMES_WORKSPACE_ALLOW_LOOPBACK = '1'; // loopback fixtures under HERMES_WORKSPACE_REQUIRE_TAILNET=1, as the other hermes tests
// Network-drop harness for the gateway link (`npm run test:gateway-drop`).
//
// The REAL stack runs end to end: hermes-remote (sign-in, ticket, WebSocket),
// the session wire, the controller, the link supervisor and the gateway
// adapter, against the fake Hermes backend, with a `node:net` TCP proxy in the
// middle that can reset, blackhole, refuse, delay and flap the path. Nothing
// here touches a real Hermes, a real VM or a real profile.
//
// It measures time to first token, reconnect time, lost events, duplicate
// events and detection time, asserts the spec's Phase 1 pass table
// (docs/gateway-spec.md, "Phase 1") and prints a results table. A failed row
// sets a non-zero exit code.
//
// DROP_RUNS=<n> overrides the 100 reset runs (the scenario that dominates run time).
// DROP_ONLY=<text> runs only the scenarios whose name contains the text.
const net = require('node:net');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { fakeBackend } = require('./hermes-auth-fake-backend.cjs');
const { createHermesRemote } = require('../src/hermes-remote.cjs');
const { createHermesApi } = require('../src/hermes-api.cjs');
const { createGatewayLink, createGatewayOpener } = require('../src/gateway-link.cjs');
const { createGatewayApi } = require('../src/gateway-api.cjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();
async function until(pred, ms, what) {
  const end = now() + ms;
  while (!pred()) { if (now() > end) throw new Error(`timed out (${ms} ms) waiting for ${what}`); await sleep(2); }
}
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.max(0, Math.ceil(p / 100 * s.length) - 1)] : NaN; };
const fmt = (x) => Number.isFinite(x) ? Math.round(x) : 'n/a';

// ── TCP proxy ───────────────────────────────────────────────────────────────
// Per direction, bytes are delayed by half the injected round trip (order kept).
// Blackhole: bytes vanish, sockets stay open (the half-open case). Heal: the
// blackholed sockets are destroyed, as the OS eventually would, and forwarding
// resumes for new connections. Refuse: new connections are reset at once.
function createProxy(targetPort) {
  const pairs = new Set();
  const mode = { blackhole: false, refuse: false, rttMs: 0, jitterMs: 0 };
  const server = net.createServer((client) => {
    if (mode.refuse) { client.resetAndDestroy(); return; }
    const up = net.connect(targetPort, '127.0.0.1');
    const pair = { client, up, dead: false, due: { c2u: 0, u2c: 0 } };
    pairs.add(pair);
    const kill = () => { pair.dead = true; pairs.delete(pair); client.destroy(); up.destroy(); };
    const forward = (dir, from, to) => from.on('data', (chunk) => {
      if (mode.blackhole) return;
      const delay = Math.max(0, mode.rttMs / 2 + (mode.jitterMs ? (Math.random() - 0.5) * mode.jitterMs : 0));
      if (!delay && now() >= pair.due[dir]) { if (!to.destroyed) to.write(chunk); return; }
      const at = Math.max(now() + delay, pair.due[dir]);
      pair.due[dir] = at;
      setTimeout(() => { if (!pair.dead && !to.destroyed) to.write(chunk); }, at - now());
    });
    forward('c2u', client, up); forward('u2c', up, client);
    client.on('error', () => {}); up.on('error', () => {});
    client.on('close', () => { pair.dead = true; pairs.delete(pair); up.destroy(); });
    // A blackholed path swallows the server's FIN too: the client keeps a dead socket.
    up.on('close', () => { if (mode.blackhole) return; pair.dead = true; pairs.delete(pair); client.destroy(); });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port,
    mode,
    reset() { for (const p of [...pairs]) { p.dead = true; pairs.delete(p); p.client.resetAndDestroy(); p.up.destroy(); } },
    // `serverDropMs`: the server side notices the dead peer after that long (Hermes's own
    // heartbeat deadline is 45 s); the client side stays open and half-dead.
    blackhole(serverDropMs = 0) {
      mode.blackhole = true;
      if (serverDropMs) { const mine = [...pairs]; setTimeout(() => { for (const p of mine) p.up.destroy(); }, serverDropMs).unref(); }
    },
    heal() { mode.blackhole = false; mode.refuse = false; for (const p of [...pairs]) { p.dead = true; pairs.delete(p); p.client.destroy(); p.up.destroy(); } },
    refuse(on) { mode.refuse = on; },
    delay(rttMs, jitterMs = 0) { mode.rttMs = rttMs; mode.jitterMs = jitterMs; },
    open: () => pairs.size,
    close: () => new Promise((r) => { for (const p of pairs) { p.client.destroy(); p.up.destroy(); } server.close(r); }),
  })));
}

// ── one client stack ────────────────────────────────────────────────────────
const KEY = 'sess-key-1';
async function stack({ rttMs = 0, jitterMs = 0, backend: backendCfg = {}, options = {} } = {}) {
  const backend = await fakeBackend({ authRequired: true, sessions: [], tokenTag: 'be', deltaCount: 6, deltaMs: 20, ...backendCfg });
  let proxy, link;
  try { return await build(); } catch (e) { link?.stop(); await proxy?.close(); await backend.close(); throw e; }
  async function build() {
  proxy = await createProxy(new URL(backend.url).port);
  const url = `http://127.0.0.1:${proxy.port}`;
  const remote = createHermesRemote();
  const base = remote.normalizeBaseUrl(url);
  let tokens = await remote.signIn({ base, provider: 'basic', username: 'drop', password: 'x' });
  proxy.delay(rttMs, jitterMs);
  const real = createGatewayOpener({ credentials: () => ({ base, tokens }), adoptTokens: (t) => { tokens = t; }, remote });
  const live = { inFlight: 0, maxInFlight: 0, sockets: 0, maxSockets: 0 };
  const open = async (arg) => {
    live.inFlight += 1; live.maxInFlight = Math.max(live.maxInFlight, live.inFlight);
    try {
      const c = await real(arg);
      live.sockets += 1; live.maxSockets = Math.max(live.maxSockets, live.sockets);
      let counted = true;
      const dec = () => { if (counted) { counted = false; live.sockets -= 1; } };
      c.wire.on('close', dec);
      return c;
    } finally { live.inFlight -= 1; }
  };
  const logs = [];
  link = createGatewayLink({ open, log: (e, f) => logs.push([e, f]), options: { stableMs: 50, ...options } });
  const rest = createHermesApi({ baseUrl: url, key: 'k'.repeat(20) });
  const api = createGatewayApi({ rest, link });
  const linkEvents = [], states = [], gaps = [], lives = [];
  link.on('event', (e) => linkEvents.push({ ...e, at: now() }));
  link.on('state', (s) => states.push({ state: s.state, at: now() }));
  link.on('gap', (g) => gaps.push({ ...g, at: now() }));
  link.on('live', () => lives.push(now()));
  link.start();
  await until(() => link.isLive(), 5000, 'the first connection');
  const bounded = (p) => Promise.race([p, sleep(5000)]); // a close that never settles must not hold the run
  return { backend, proxy, link, api, rest, live, logs, linkEvents, states, gaps, lives, url,
    async close() { link.stop(); await bounded(proxy.close()); await bounded(backend.close()); } };
  }
}

// One reply through the adapter; resolves when the stream ends.
function reply(h, text) {
  const out = { text: [], completed: '', first: 0, started: now(), events: 0, done: null, firstDeltaAt: 0 };
  out.done = h.api.streamChat(KEY, text, { onEvent: (name, data) => {
    out.events += 1;
    if (name === 'assistant.delta') { out.text.push(data.delta); if (!out.first) out.first = now() - out.started; }
    if (name === 'assistant.completed') out.completed = data.content;
  } });
  return out;
}
const serverText = (h) => h.backend.engine.history(KEY).filter((m) => m.role === 'assistant').at(-1)?.content;
// Seqs the server emitted for the live session since `from` vs seqs the client applied since `at`.
function accounting(h, runStart) {
  const sessions = h.backend.engine.liveSessions().filter((s) => s.session_key === KEY);
  const sid = sessions[0]?.id;
  const server = h.backend.engine.applied.filter((e, i) => i >= runStart.server && e.sessionId === sid).map((e) => e.seq);
  const client = h.linkEvents.filter((e, i) => i >= runStart.client && e.storedId === KEY).map((e) => e.seq);
  const lost = server.filter((s) => !client.includes(s)).length;
  return { lost, duplicates: client.length - new Set(client).size };
}
const mark = (h) => ({ server: h.backend.engine.applied.length, client: h.linkEvents.length });

// ── results ────────────────────────────────────────────────────────────────
const rows = [];
const check = (scenario, metric, measured, target, ok) => { rows.push({ scenario, metric, measured: String(measured), target, ok }); };

// ── scenarios ──────────────────────────────────────────────────────────────

// Reset mid-reply, inside the grace window, repeated.
async function resetRuns({ runs, rttMs }) {
  const h = await stack({ rttMs, backend: { orphanGraceMs: 20000 } });
  const reconnect = [], lostAll = [], dupAll = [], textBad = [], submitsBad = [];
  try {
    await h.link.attach(KEY);
    for (let i = 0; i < runs; i++) {
      const m = mark(h);
      const text = `run-${i}`;
      const r = reply(h, text);
      await until(() => r.text.length >= 2, 5000, 'two deltas');
      const liveBefore = h.lives.length;
      const t0 = now();
      h.proxy.reset();
      await until(() => h.lives.length > liveBefore, 10000, 'link live again');
      reconnect.push(h.lives.at(-1) - t0);
      await r.done;
      const acc = accounting(h, m);
      lostAll.push(acc.lost); dupAll.push(acc.duplicates);
      const final = serverText(h);
      textBad.push(r.text.join('') === final && r.completed === final ? 0 : 1);
      submitsBad.push(h.backend.engine.submits.filter((s) => s.text === text).length === 1 ? 0 : 1);
      await sleep(rttMs ? 80 : 60);
    }
    const sum = (xs) => xs.reduce((a, b) => a + b, 0);
    const scenario = `reset mid-reply, ${runs} runs, RT ${rttMs} ms`;
    check(scenario, 'lost events', sum(lostAll), '0', sum(lostAll) === 0);
    check(scenario, 'duplicate events', sum(dupAll), '0', sum(dupAll) === 0);
    check(scenario, 'text != server text / submits != 1', `${sum(textBad)} / ${sum(submitsBad)}`, '0 / 0', sum(textBad) === 0 && sum(submitsBad) === 0);
    check(scenario, 'reconnect p50 / p95 / max ms', `${fmt(pct(reconnect, 50))} / ${fmt(pct(reconnect, 95))} / ${fmt(Math.max(...reconnect))}`,
      rttMs === 100 ? 'p95 <= 500' : 'info', rttMs === 100 ? pct(reconnect, 95) <= 500 : true);
    check(scenario, 'peak sockets / in-flight attempts', `${h.live.maxSockets} / ${h.live.maxInFlight}`, '1 / 1', h.live.maxSockets === 1 && h.live.maxInFlight === 1);
  } finally { await h.close(); }
}

// Blackhole: stop forwarding, keep sockets open, then heal.
async function blackhole({ holdMs, graceMs, serverDropMs = 0, expectGap }) {
  const h = await stack({ backend: { orphanGraceMs: graceMs, deltaCount: 12, deltaMs: 40 } });
  const scenario = `blackhole ${holdMs / 1000} s mid-reply, grace ${graceMs / 1000} s${serverDropMs ? `, server notices after ${serverDropMs / 1000} s` : ''}`;
  try {
    await h.link.attach(KEY);
    const m = mark(h);
    const r = reply(h, 'blackhole');
    await until(() => r.text.length >= 3, 5000, 'three deltas');
    const t0 = now();
    h.proxy.blackhole(serverDropMs);
    await until(() => h.states.some((s) => s.at > t0 && s.state === 'reconnecting'), 30000, 'detection');
    const detection = h.states.find((s) => s.at > t0 && s.state === 'reconnecting').at - t0;
    await sleep(Math.max(0, holdMs - (now() - t0)));
    const liveBefore = h.lives.length, tHeal = now();
    h.proxy.heal();
    await until(() => h.lives.length > liveBefore, 30000, 'live after heal');
    const back = h.lives.at(-1) - tHeal;
    await r.done;
    check(scenario, 'detection ms', fmt(detection), '<= 14000', detection <= 14000);
    check(scenario, 'live again after heal ms', fmt(back), 'info', true);
    const final = serverText(h);
    if (expectGap) {
      check(scenario, 'gap reported (history path)', h.gaps.map((g) => g.reason).join(',') || 'none', 'reaped|truncated', h.gaps.length === 1 && ['reaped', 'truncated'].includes(h.gaps[0].reason));
      const history = await h.rest.getMessages(KEY, { limit: 50 });
      const last = history.data.find((x) => x.role === 'assistant');
      check(scenario, 'history has the full reply', last?.content === final ? 'yes' : 'no', 'yes', !!final && last?.content === final);
    } else {
      const acc = accounting(h, m);
      check(scenario, 'lost / duplicate events', `${acc.lost} / ${acc.duplicates}`, '0 / 0', acc.lost === 0 && acc.duplicates === 0 && h.gaps.length === 0);
      check(scenario, 'text equals server text', r.text.join('') === final ? 'yes' : 'no', 'yes', r.text.join('') === final);
    }
  } finally { await h.close(); }
}

// A Hermes restart mid-reply: new epoch, every runtime session gone.
async function restart() {
  const h = await stack({ backend: { deltaCount: 12, deltaMs: 40 } });
  const scenario = 'Hermes restart (epoch change) mid-reply';
  try {
    await h.link.attach(KEY);
    const r = reply(h, 'before');
    await until(() => r.text.length >= 3, 5000, 'three deltas');
    const liveBefore = h.lives.length;
    h.backend.restart();
    await until(() => h.lives.length > liveBefore, 15000, 'live after restart');
    await r.done;
    check(scenario, 'gap reported', h.gaps.map((g) => g.reason).join(',') || 'none', 'restarted', h.gaps.length === 1 && h.gaps[0].reason === 'restarted');
    await until(() => h.link.getState().attached === 1, 5000, 're-attach on the new epoch');
    const m = mark(h);
    const after = reply(h, 'after');
    await after.done;
    const acc = accounting(h, m);
    const final = serverText(h);
    check(scenario, 'new reply whole at seq 1.. (no stale watermark)', after.text.join('') === final && acc.lost === 0 ? 'yes' : 'no', 'yes', after.text.join('') === final && acc.lost === 0 && acc.duplicates === 0);
    const history = await h.rest.getMessages(KEY, { limit: 50 });
    const same = JSON.stringify(history.data.map((x) => x.id).sort()) === JSON.stringify(h.backend.engine.history(KEY).map((x) => x.id).sort());
    check(scenario, 'transcript equals server history', same ? 'yes' : 'no', 'yes', same);
  } finally { await h.close(); }
}

// Laptop sleep: suspend, outlast the grace window, resume.
async function suspend({ sleepMs }) {
  const h = await stack({});
  const scenario = `${sleepMs / 1000} s suspend then resume`;
  try {
    await h.link.attach(KEY);
    const r = reply(h, 'sleepy');
    await r.done;
    h.link.suspend();
    const at = h.states.length;
    await sleep(sleepMs);
    const t0 = now();
    h.link.resume();
    await until(() => h.link.isLive(), 15000, 'live after resume');
    const names = new Set(h.states.slice(at).map((s) => s.state));
    const bad = ['signin', 'idle', 'stopped'].filter((s) => names.has(s));
    check(scenario, 'gap reported (history path)', h.gaps.map((g) => g.reason).join(',') || 'none', 'reaped', h.gaps.length === 1 && h.gaps[0].reason === 'reaped');
    check(scenario, 'error states seen', bad.join(',') || 'none', 'none', bad.length === 0);
    check(scenario, 'live after resume ms', fmt(h.lives.at(-1) - t0), 'info', true);
    await until(() => h.link.getState().attached === 1, 5000, 're-attach');
    const after = reply(h, 'awake');
    await after.done;
    check(scenario, 'send after wake works', after.text.join('') === serverText(h) ? 'yes' : 'no', 'yes', after.text.join('') === serverText(h));
  } finally { await h.close(); }
}

// Flapping network: 20 resets and short refusals, one attempt and one socket at a time.
async function flap({ flaps, spanMs }) {
  const h = await stack({ backend: { orphanGraceMs: 20000 } });
  const scenario = `flap ${flaps} times in ${spanMs / 1000} s`;
  try {
    await h.link.attach(KEY);
    let peakServerPeers = 0;
    const sampler = setInterval(() => { peakServerPeers = Math.max(peakServerPeers, h.backend.wsPeerCount()); }, 5);
    for (let i = 0; i < flaps; i++) {
      h.proxy.reset();
      if (i % 3 === 0) { h.proxy.refuse(true); await sleep(250); h.proxy.refuse(false); }
      await sleep(spanMs / flaps - (i % 3 === 0 ? 250 : 0));
    }
    await until(() => h.link.isLive(), 30000, 'live after the flapping');
    clearInterval(sampler);
    const r = reply(h, 'after-flap');
    await r.done;
    check(scenario, 'peak in-flight attempts', h.live.maxInFlight, '1', h.live.maxInFlight === 1);
    check(scenario, 'peak open sockets (client / server)', `${h.live.maxSockets} / ${Math.max(peakServerPeers, h.backend.maxWsPeers())}`, '1 / 1', h.live.maxSockets === 1 && Math.max(peakServerPeers, h.backend.maxWsPeers()) <= 1);
    check(scenario, 'reply after the flapping is whole', r.text.join('') === serverText(h) ? 'yes' : 'no', 'yes', r.text.join('') === serverText(h));
  } finally { await h.close(); }
}

// Warm first token: send to first delta at the adapter (the model's first chunk is 50 ms).
async function firstToken({ rttMs, n = 10 }) {
  const h = await stack({ rttMs, backend: { firstDeltaMs: 50, deltaCount: 3, deltaMs: 5 } });
  const scenario = `warm first token, RT ${rttMs} ms`;
  try {
    await h.link.attach(KEY);
    const ttft = [];
    for (let i = 0; i < n + 1; i++) {
      const r = reply(h, `t${i}`);
      await r.done;
      if (i > 0) ttft.push(r.first); // the first run is the discarded warm-up
      await sleep(30);
    }
    const p50 = pct(ttft, 50), p95 = pct(ttft, 95);
    // Spec section 4: loopback 152 / 164 (painted); remote RT + 150 / RT + 190. This stops at the adapter event, before paint.
    const t50 = rttMs ? rttMs + 150 : 152, t95 = rttMs ? rttMs + 190 : 164;
    check(scenario, `first delta p50 / p95 ms (n=${n})`, `${fmt(p50)} / ${fmt(p95)}`, `<= ${t50} / ${t95}`, p50 <= t50 && p95 <= t95);
  } finally { await h.close(); }
}

// A scenario that stalls fails its row; the watchdog ends the process if anything still hangs.
const SCENARIO_MS = 240000;
setTimeout(() => { console.error('gateway-netdrop: watchdog, the run took longer than 10 minutes'); process.exit(2); }, 600000).unref();

async function main() {
  const runs = Number(process.env.DROP_RUNS) || 100;
  const started = now();
  const only = process.env.DROP_ONLY;
  const guarded = async (name, fn) => { if (only && !name.includes(only)) return; try { await Promise.race([fn(), sleep(SCENARIO_MS).then(() => { throw new Error(`no result in ${SCENARIO_MS / 1000} s`); })]); } catch (e) { check(name, 'scenario completed', e.message, 'completes', false); } };
  // Timing-sensitive scenarios run alone; the long waits run side by side.
  await guarded('reset RT 100', () => resetRuns({ runs, rttMs: 100 }));
  await guarded('reset RT 0', () => resetRuns({ runs: 30, rttMs: 0 }));
  await guarded('first token RT 0', () => firstToken({ rttMs: 0 }));
  await guarded('first token RT 100', () => firstToken({ rttMs: 100 }));
  await Promise.all([
    guarded('blackhole in grace', () => blackhole({ holdMs: 30000, graceMs: 20000, expectGap: false })),
    guarded('blackhole past grace', () => blackhole({ holdMs: 20000, graceMs: 3000, serverDropMs: 2000, expectGap: true })),
    guarded('restart', restart),
    guarded('suspend', () => suspend({ sleepMs: 25000 })),
    guarded('flap', () => flap({ flaps: 20, spanMs: 30000 })),
  ]);
  const w = (s, n) => String(s).padEnd(n);
  const cols = [Math.max(...rows.map((r) => r.scenario.length)), Math.max(...rows.map((r) => r.metric.length)), Math.max(...rows.map((r) => r.measured.length)), Math.max(...rows.map((r) => r.target.length))];
  console.log(`\n${w('scenario', cols[0])}  ${w('metric', cols[1])}  ${w('measured', cols[2])}  ${w('target', cols[3])}  result`);
  for (const r of rows) console.log(`${w(r.scenario, cols[0])}  ${w(r.metric, cols[1])}  ${w(r.measured, cols[2])}  ${w(r.target, cols[3])}  ${r.ok ? 'pass' : 'FAIL'}`);
  const failed = rows.filter((r) => !r.ok);
  console.log(`\n${rows.length - failed.length}/${rows.length} rows pass in ${fmt((now() - started) / 1000)} s (reset runs: ${runs} at RT 100 ms, 30 at RT 0 ms).`);
  assert.equal(failed.length, 0, `${failed.length} row(s) failed`);
}

main().then(() => process.exit(0), (e) => { console.error(e.message); process.exit(1); });
