'use strict';
// Transport check and baseline against a REAL remote Hermes (docs/gateway-spec.md, "Phase 1").
// It drives the repo's own client modules from Node, no Electron and no app profile:
//   REST+SSE   hermes-api.cjs              (needs HERMES_API_KEY; the API server is loopback-only, reach it by SSH tunnel)
//   WebSocket  gateway-link + gateway-api  (password sign-in -> ticket -> /api/ws)
//
// Every credential comes from the environment and is never printed or written:
//   GW_BASE          https://<machine>.<tailnet>.ts.net   (the dashboard / WebSocket address)
//   GW_USER, GW_PASS dashboard password sign-in
//   HERMES_API_KEY   API_SERVER_KEY, for REST + SSE and for creating/deleting throwaway sessions
//   HERMES_API_URL   default http://127.0.0.1:18642  (ssh -N -L 18642:127.0.0.1:8642 <host>)
//   GW_TUNNEL_BASE   default http://127.0.0.1:19119  (ssh -N -L 19119:127.0.0.1:9119 <host>); the reset-drop arm uses it
// Knobs: BENCH_STEPS (rtt,cold,warm,drop,requests,grace), BENCH_MAX_PROMPTS (hard cap, default 40),
// BENCH_WARM_N (samples per transport, default 10), BENCH_COLD_N, BENCH_OUT, BENCH_LEDGER (file that
// gets every created session id the moment it exists, so a crash can still be cleaned up).
//
// Safety: it only creates its own sessions (id `gwvmcheck-<stamp>-*`, title `gateway-vm-check <stamp> *`),
// deletes them at the end, counts every prompt, and refuses to write results that contain a secret value.
// Output is merged into <BENCH_OUT>/results.json step by step.
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');
const { execFileSync, execFile } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const SRC = path.join(__dirname, '..', '..', 'src');
const { createHermesRemote } = require(path.join(SRC, 'hermes-remote.cjs'));
const { HermesSessionWire } = require(path.join(SRC, 'hermes-session-wire.cjs'));
const { createHermesApi } = require(path.join(SRC, 'hermes-api.cjs'));
const { createGatewayLink, createGatewayOpener } = require(path.join(SRC, 'gateway-link.cjs'));
const { createGatewayApi } = require(path.join(SRC, 'gateway-api.cjs'));

const need = (k) => { const v = process.env[k]; if (!v) { console.error(`${k} is not set`); process.exit(2); } return v; };
const GW_BASE = need('GW_BASE'), GW_USER = need('GW_USER'), GW_PASS = need('GW_PASS'), KEY = need('HERMES_API_KEY');
const API_URL = process.env.HERMES_API_URL || 'http://127.0.0.1:18642';
const TUNNEL_BASE = process.env.GW_TUNNEL_BASE || 'http://127.0.0.1:19119';
const STEPS = (process.env.BENCH_STEPS || 'rtt,cold,warm,drop,requests,grace').split(',').map((s) => s.trim());
const MAX_PROMPTS = Number(process.env.BENCH_MAX_PROMPTS || 40);
const WARM_N = Number(process.env.BENCH_WARM_N || 10);
const COLD_N = Number(process.env.BENCH_COLD_N || 10);
const OUT = process.env.BENCH_OUT || path.join(__dirname, '..', '..', '..', 'docs', 'benchmarks', 'results', '2026-11-19-gateway-vm');
const LEDGER = process.env.BENCH_LEDGER || '';
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();
const enc = encodeURIComponent;
const pct = (xs, p) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[Math.max(0, Math.ceil(p / 100 * s.length) - 1)] : null; };
const stats = (xs) => ({ n: xs.filter(Number.isFinite).length, p50: round(pct(xs, 50)), p95: round(pct(xs, 95)), min: round(Math.min(...xs)), max: round(Math.max(...xs)) });
const round = (x) => (x == null || !Number.isFinite(x)) ? null : Math.round(x * 10) / 10;
async function until(pred, ms, what) {
  const end = now() + ms;
  while (!pred()) { if (now() > end) throw new Error(`timed out (${ms} ms) waiting for ${what}`); await sleep(5); }
}

// ── results, with a guard against writing a secret ──────────────────────────
fs.mkdirSync(OUT, { recursive: true });
const RESULTS_FILE = path.join(OUT, 'results.json');
const R = fs.existsSync(RESULTS_FILE) ? JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8')) : { steps: {} };
const secrets = () => [GW_USER, GW_PASS, KEY, ...liveTokens].filter((s) => typeof s === 'string' && s.length >= 4);
const liveTokens = [];
function save() {
  const text = JSON.stringify(R, null, 1);
  for (const s of secrets()) if (text.includes(s)) throw new Error('refusing to write results: a secret value is in them');
  fs.writeFileSync(RESULTS_FILE, text + '\n');
}

// ── prompts and sessions ────────────────────────────────────────────────────
let prompts = 0;
const promptLog = [];
function countPrompt(what) {
  if (prompts >= MAX_PROMPTS) throw new Error(`prompt cap ${MAX_PROMPTS} reached before: ${what}`);
  prompts += 1; promptLog.push(what);
}
async function restRaw(method, p, body) {
  const res = await fetch(API_URL + p, { method, headers: { Authorization: `Bearer ${KEY}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
const created = [];
async function makeSession(tag) {
  const id = `gwvmcheck-${STAMP}-${tag}`;
  const r = await restRaw('POST', '/api/sessions', { id, title: `gateway-vm-check ${STAMP} ${tag}` });
  if (r.status !== 201) throw new Error(`create session ${tag}: HTTP ${r.status}`);
  created.push(id);
  if (LEDGER) fs.appendFileSync(LEDGER, id + '\n');
  return id;
}
const rest = createHermesApi({ baseUrl: API_URL, key: KEY });
const serverLastAssistant = async (id, expect) => {
  for (let i = 0; i < 20; i++) {
    const m = await rest.getMessages(id, { limit: 20, order: 'latest' });
    const rows = (m.messages || m.items || m.data || []).filter((x) => x.role === 'assistant' && typeof x.content === 'string');
    const last = rows.sort((a, b) => (a.id ?? 0) - (b.id ?? 0)).at(-1);
    if (last && (expect === undefined || last.content.trim() === expect.trim())) return last.content;
    await sleep(250);
  }
  const m = await rest.getMessages(id, { limit: 20, order: 'latest' });
  return ((m.messages || m.items || m.data || []).filter((x) => x.role === 'assistant').at(-1) || {}).content ?? null;
};
const userRowCount = async (id, text) => {
  const m = await rest.getMessages(id, { limit: 100, order: 'latest' });
  return (m.messages || m.items || m.data || []).filter((x) => x.role === 'user' && x.content === text).length;
};

// ── one WebSocket client stack: the real opener, link and adapter ───────────
let baseSignIn = null;
async function signIn(baseUrl) {
  const remote = createHermesRemote();
  const base = remote.normalizeBaseUrl(baseUrl);
  const t0 = now();
  const tokens = await remote.signIn({ base, provider: 'basic', username: GW_USER, password: GW_PASS });
  liveTokens.push(tokens.accessToken, tokens.refreshToken);
  return { base, tokens, ms: now() - t0 };
}
const stacks = [];
function makeStack({ base, tokens, probeCache = true, linkOptions = {}, wrapOpen = (o) => o }) {
  const rawRemote = createHermesRemote();
  const remoteCalls = [];
  const remote = new Proxy(rawRemote, { get(t, p) {
    const v = t[p];
    if (typeof v !== 'function') return v;
    if (!['probe', 'refresh', 'wsTicket', 'connectSocket'].includes(p)) return v.bind(t);
    return async (...a) => { const s = now(); try { return await v.apply(t, a); } finally { remoteCalls.push({ name: p, ms: now() - s, at: s }); } };
  } });
  const calls = [];
  const wires = [];
  const createWire = ({ input, output }) => {
    const w = new HermesSessionWire({ input, output });
    const call = w.call.bind(w);
    w.call = (m, p, o) => { const s = now(); const rec = { method: m, at: s }; calls.push(rec); return call(m, p, o).then((r) => { rec.ms = now() - s; return r; }, (e) => { rec.ms = now() - s; rec.err = e && e.code; throw e; }); };
    wires.push(w);
    return w;
  };
  let tokensRef = tokens;
  const real = createGatewayOpener({ credentials: () => ({ base, tokens: tokensRef }), adoptTokens: (t) => { tokensRef = t; liveTokens.push(t.accessToken, t.refreshToken); }, remote, createWire });
  const last = { conn: null, opens: 0 };
  const open = wrapOpen(async (arg) => { const c = await real(arg); last.conn = c; last.opens += 1; return c; });
  const logs = [];
  const link = createGatewayLink({ open, log: (e, f) => logs.push([e, f]), options: linkOptions });
  const events = [], states = [], lives = [], gaps = [];
  link.on('event', (e) => events.push({ ...e, at: now() }));
  link.on('state', (s) => states.push({ state: s.state, at: now() }));
  link.on('live', () => lives.push(now()));
  link.on('gap', (g) => gaps.push({ ...g, at: now() }));
  const api = createGatewayApi({ rest, link });
  const stack = { link, api, open, last, calls, remoteCalls, wires, logs, events, states, lives, gaps, real, base, tokens: () => tokensRef };
  stacks.push(stack);
  return stack;
}
async function startLive(stack) {
  const t0 = now();
  stack.link.start();
  await until(() => stack.link.isLive(), 15000, 'link live');
  return now() - t0;
}

// ── a reply through the adapter or the SSE client ───────────────────────────
function runReply(api, sessionId, text, { onDelta } = {}) {
  const r = { t0: now(), ack: null, first: null, firstAny: null, last: null, end: null, deltas: 0, text: '', completed: null, terminal: null, err: null, names: {}, started: false };
  r.done = api.streamChat(sessionId, text, { onEvent: (name, data) => {
    const t = now() - r.t0;
    r.names[name] = (r.names[name] || 0) + 1;
    if (name === 'run.started') { r.ack = t; r.started = true; }
    if (name === 'assistant.delta' && typeof data?.delta === 'string') { r.deltas += 1; r.text += data.delta; if (r.first == null) r.first = t; onDelta?.(r); }
    if (name === 'assistant.completed') { r.completed = data?.content ?? null; if (r.firstAny == null) r.firstAny = t; }
    if (name === 'assistant.delta' && r.firstAny == null) r.firstAny = t;
    if (['run.completed', 'run.failed', 'run.cancelled'].includes(name)) { r.terminal = name; r.last = t; }
  } }).then(() => { r.end = now() - r.t0; }, (e) => { r.err = { code: e.code, message: String(e.message).slice(0, 160) }; r.end = now() - r.t0; });
  return r;
}

// ── step: round trip ────────────────────────────────────────────────────────
async function stepRtt() {
  const out = {};
  const pings = [];
  const si = await signIn(GW_BASE);
  const st = makeStack({ base: si.base, tokens: si.tokens });
  const c = await st.open({ timeoutMs: 8000 });
  for (let i = 0; i < 30; i++) { const s = now(); await c.wire.call('gateway.ping', {}, { timeoutMs: 8000 }); pings.push(now() - s); await sleep(100); }
  c.close();
  out.wsPingWss = { note: 'gateway.ping round trip on a warm wss socket (app level, includes server dispatch)', ...stats(pings) };
  // REST path round trip: GET /health on the tunnel, keep-alive
  const health = [];
  const httpGet = (agent) => new Promise((resolve, reject) => { const s = now(); http.get(`${API_URL}/health`, { agent }, (res) => { res.resume(); res.on('end', () => resolve(now() - s)); }).on('error', reject); });
  for (let i = 0; i < 31; i++) { const d = await httpGet(undefined); if (i) health.push(d); await sleep(100); }
  out.restHealthTunnel = { note: 'GET /health through the SSH tunnel with node:http and its default keep-alive agent (what hermes-api.cjs uses), first discarded', ...stats(health) };
  const cold = [];
  const noKeep = new http.Agent({ keepAlive: false });
  for (let i = 0; i < 10; i++) { cold.push(await httpGet(noKeep)); await sleep(100); }
  out.restHealthTunnelNewConnection = { note: 'same request on a new connection each time', ...stats(cold) };
  // WS ping on the tunnel path
  try {
    const ts = await signIn(TUNNEL_BASE);
    const tst = makeStack({ base: ts.base, tokens: ts.tokens });
    const tc = await tst.open({ timeoutMs: 8000 });
    const tp = [];
    for (let i = 0; i < 30; i++) { const s = now(); await tc.wire.call('gateway.ping', {}, { timeoutMs: 8000 }); tp.push(now() - s); await sleep(100); }
    tc.close();
    out.wsPingTunnel = { note: 'gateway.ping through the SSH tunnel to the loopback dashboard', ...stats(tp) };
  } catch (e) { out.wsPingTunnel = { error: String(e.code || e.message).slice(0, 120) }; }
  // network level: tailscale ping
  try {
    const text = await new Promise((resolve, reject) => execFile('tailscale', ['ping', '-c', '10', '--until-direct=false', '--timeout', '3s', process.env.GW_TS_HOST || 'hermes-orgo'], { timeout: 40000 }, (e, so, se) => resolve(String(so) + String(se))));
    const ms = [...text.matchAll(/in (\d+(?:\.\d+)?)ms/g)].map((m) => Number(m[1]));
    out.tailscalePing = { note: 'tailscale ping -c 10 (network path, first reply may be relayed)', direct: /via \d+\.\d+\.\d+\.\d+:\d+/.test(text) && !/DERP/.test(text.split('\n').slice(1).join('\n')), ...stats(ms) };
  } catch (e) { out.tailscalePing = { error: String(e.message).slice(0, 100) }; }
  out.rttMsForTargets = out.wsPingWss.p50;
  out.signInMs = round(si.ms);
  R.steps.rtt = out; save();
  console.log('rtt', JSON.stringify(out));
}

// ── step: cold connect + auth + attach ──────────────────────────────────────
async function stepCold() {
  const si = await signIn(GW_BASE);
  const A = await makeSession('cold');
  const samples = [];
  for (let i = 0; i < COLD_N; i++) {
    const st = makeStack({ base: si.base, tokens: si.tokens });
    const t0 = now();
    st.link.start();
    await until(() => st.link.isLive(), 15000, 'cold live');
    const tLive = now() - t0;
    const mark = st.calls.length;
    await st.link.attach(A);
    const tAttach = now() - t0 - tLive;
    const parts = {};
    for (const c of st.remoteCalls) parts[c.name] = round(c.ms);
    const attachCalls = st.calls.slice(mark).map((c) => ({ m: c.method, ms: round(c.ms) }));
    samples.push({ tLive: round(tLive), tAttach: round(tAttach), total: round(tLive + tAttach), totalWithoutProbe: round(tLive + tAttach - (parts.probe || 0)), remote: parts, attachCalls });
    st.link.stop();
    await sleep(400);
  }
  const col = (f) => samples.map(f);
  R.steps.cold = {
    note: 'new link and opener per sample, signed in beforehand (unexpired token, so no refresh). live = probe + ticket + socket + gateway.ready; attach = session.resume + bind. totalWithoutProbe subtracts the measured /api/status probe, which the spec target skips (cached auth_required)',
    n: COLD_N,
    live: stats(col((s) => s.tLive)), attach: stats(col((s) => s.tAttach)), total: stats(col((s) => s.total)), totalWithoutProbe: stats(col((s) => s.totalWithoutProbe)),
    probeMs: stats(col((s) => s.remote.probe)), ticketMs: stats(col((s) => s.remote.wsTicket)), socketMs: stats(col((s) => s.remote.connectSocket)),
    attachRpcSequence: samples[0].attachCalls.map((c) => c.m),
    sampleDetail: samples.slice(0, 2),
    sessionId: A,
  };
  save();
  console.log('cold', JSON.stringify({ live: R.steps.cold.live, attach: R.steps.cold.attach, total: R.steps.cold.total }));
}

// ── step: warm first token / last token, SSE vs WebSocket, alternating ──────
const PROMPT_OK = process.env.BENCH_WARM_PROMPT || 'Reply with the single word: ok';
const WARM_TAG = process.env.BENCH_WARM_TAG || 'warm';
async function stepWarm() {
  const si = await signIn(GW_BASE);
  const st = makeStack({ base: si.base, tokens: si.tokens });
  await startLive(st);
  const Sws = await makeSession('warm-ws'), Ssse = await makeSession('warm-sse');
  await st.link.attach(Sws);
  const rows = { sse: [], ws: [] };
  const mismatches = [];
  const nameSets = { sse: {}, ws: {} };
  for (let i = 0; i <= WARM_N; i++) {
    const order = i % 2 ? ['ws', 'sse'] : ['sse', 'ws'];
    for (const which of order) {
      countPrompt(`${WARM_TAG} ${which} #${i}`);
      const sid = which === 'ws' ? Sws : Ssse;
      const api = which === 'ws' ? st.api : rest;
      const text = PROMPT_OK;
      const r = runReply(api, sid, text);
      await r.done;
      for (const [k, v] of Object.entries(r.names)) nameSets[which][k] = (nameSets[which][k] || 0) + v;
      const streamed = r.completed ?? r.text;
      const server = await serverLastAssistant(sid, streamed);
      const same = server != null && server.trim() === String(streamed).trim() && (r.deltas === 0 || r.text.trim() === String(streamed).trim());
      if (!same || r.err || r.terminal !== 'run.completed') mismatches.push({ which, i, err: r.err, terminal: r.terminal, streamedLen: streamed.length, serverLen: server == null ? null : server.length, deltaJoinEqualsCompleted: r.text === r.completed });
      rows[which].push({ i, ack: round(r.ack), firstDelta: round(r.first), first: round(r.firstAny), last: round(r.last ?? r.end), deltas: r.deltas, same });
      await sleep(1500);
    }
  }
  const col = (w, f) => rows[w].filter((x) => x.i > 0).map((x) => x[f]);
  const summary = (w) => ({ ack: stats(col(w, 'ack')), firstToken: stats(col(w, 'first')), firstDelta: stats(col(w, 'firstDelta')), lastToken: stats(col(w, 'last')), firstSampleDiscarded: rows[w][0], mismatchOrErrors: mismatches.filter((m) => m.which === w).length });
  R.steps[WARM_TAG] = { prompt: PROMPT_OK, n: WARM_N, order: 'alternating, first of each discarded as warm-up', sse: summary('sse'), ws: summary('ws'), samples: rows, eventNames: nameSets, mismatches, sessions: { ws: Sws, sse: Ssse } };
  save();
  console.log(WARM_TAG, JSON.stringify({ sse: R.steps[WARM_TAG].sse, ws: R.steps[WARM_TAG].ws }));
  st.link.stop();
}

// ── step: drop mid-reply and resume ─────────────────────────────────────────
function createResetProxy(targetUrl) {
  const t = new URL(targetUrl);
  const pairs = new Set();
  const server = net.createServer((client) => {
    const up = net.connect(Number(t.port), t.hostname);
    const pair = { client, up };
    pairs.add(pair);
    client.pipe(up); up.pipe(client);
    const done = () => { pairs.delete(pair); client.destroy(); up.destroy(); };
    client.on('error', done); up.on('error', done); client.on('close', done); up.on('close', done);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port,
    reset() { for (const p of [...pairs]) { pairs.delete(p); p.client.resetAndDestroy(); p.up.destroy(); } },
    close: () => new Promise((r) => { for (const p of pairs) { p.client.destroy(); p.up.destroy(); } server.close(r); }),
  })));
}
const LONG_PROMPT = 'Write a 200-word paragraph about why a private network is useful. No lists.';

async function auditSeqs(st, sessionKey, appliedSeqs, since) {
  // A second, separate socket reads the server's replay ring for the live session.
  const c2 = await st.real({ timeoutMs: 8000 });
  try {
    const al = await c2.wire.call('session.active_list', {}, { timeoutMs: 8000 });
    const mine = (al.sessions || []).find((s) => s.session_key === sessionKey);
    if (!mine) return { error: 'session not in active_list' };
    const r = await c2.wire.call('session.events.since', { session_id: mine.id, last_seen: 0 }, { timeoutMs: 8000 });
    const ring = r.events.map((e) => e.seq).filter((s) => s > since);
    const applied = appliedSeqs.filter((s) => s > since);
    const missing = r.events.filter((e) => e.seq > since && !applied.includes(e.seq));
    const lost = missing.length;
    const dups = applied.length - new Set(applied).size;
    const extra = applied.filter((s) => !ring.includes(s)).length;
    return { missingTypes: missing.map((e) => e.type || e.params?.type || Object.keys(e).join('/')), ringTypes: r.events.filter((e) => e.seq > since).map((e) => e.type), ringEvents: ring.length, appliedEvents: applied.length, lost, duplicates: dups, notInRing: extra, latestSeq: r.latest_seq, truncated: r.truncated, epochSame: true };
  } finally { c2.close(); }
}

async function dropArm({ name, base, tokens, dropper, prompts: n, dropsPerPrompt, wrapOpen, makeDropper }) {
  const st = makeStack({ base, tokens, wrapOpen });
  const dropFn = makeDropper ? makeDropper(st) : dropper(st);
  await startLive(st);
  const S = await makeSession(`drop-${name}`);
  await st.link.attach(S);
  const out = { name, reconnectMs: [], replies: [], gaps: 0 };
  for (let p = 0; p < n; p++) {
    countPrompt(`drop ${name} #${p}`);
    const mark = st.events.length;
    const text = `${LONG_PROMPT} (${name} ${p})`;
    let drops = 0;
    const r = runReply(st.api, S, text);
    const sinceSeq = Math.max(0, ...st.events.filter((e) => e.storedId === S).map((e) => e.seq || 0));
    let armAt = null;
    const rec = { drops: [], statesSeen: [] };
    while (r.end == null) {
      if (r.started && armAt == null) armAt = now() + 400;
      if (drops < dropsPerPrompt && armAt != null && now() >= armAt && r.terminal == null && st.link.isLive()) {
        const liveBefore = st.lives.length;
        const t0 = now();
        const sinceAck = t0 - (r.t0 + r.ack);
        await dropFn();
        drops += 1; armAt = null;
        try { await until(() => st.lives.length > liveBefore, 20000, 'live again'); out.reconnectMs.push(st.lives.at(-1) - t0); rec.drops.push({ ms: round(st.lives.at(-1) - t0), msAfterAck: round(sinceAck), terminalSeenAtLive: r.terminal }); armAt = now() + 300; }
        catch (e) { rec.drops.push({ error: String(e.message) }); }
      }
      await sleep(15);
    }
    await sleep(300); // the turn's trailing session.info follows message.complete
    const streamed = r.completed ?? r.text;
    const server = await serverLastAssistant(S, streamed);
    const applied = st.events.slice(mark).filter((e) => e.storedId === S).map((e) => e.seq);
    let audit;
    try { audit = await auditSeqs(st, S, applied, sinceSeq); } catch (e) { audit = { error: String(e.code || e.message).slice(0, 100) }; }
    const submits = await userRowCount(S, text);
    out.replies.push({ p, drops: rec.drops, terminal: r.terminal, err: r.err, deltas: r.deltas, textEqualsServer: server != null && server.trim() === String(streamed).trim() && (r.deltas === 0 || r.text.trim() === String(streamed).trim()), deltaJoinEqualsCompleted: r.text === r.completed, serverRows: submits, audit, names: r.names });
    await sleep(1500);
  }
  out.gaps = st.gaps.length;
  out.gapDetail = st.gaps.map((g) => g.reason);
  st.link.stop();
  return out;
}

async function stepDrop() {
  const want = (process.env.BENCH_DROP_ARMS || 'wss-close,tunnel-reset').split(',');
  const promptsFor = Number(process.env.BENCH_DROP_PROMPTS || 3);
  const fresh = [];
  if (want.includes('wss-close')) {
    // Arm 1: wss to the real dashboard, drop = the client closes its own socket.
    const si = await signIn(GW_BASE);
    fresh.push(await dropArm({ name: 'wss-close', base: si.base, tokens: si.tokens, prompts: promptsFor, dropsPerPrompt: 2,
      makeDropper: (st) => async () => { st.last.conn.socket.close(); } }));
    R.steps.drop = { ...(R.steps.drop || {}), arms: [...((R.steps.drop || {}).arms || []).filter((x) => x.name !== 'wss-close'), ...fresh] }; save();
  }
  if (want.includes('tunnel-reset')) {
    // Arm 2: loopback tunnel with a TCP proxy in front, drop = connection reset.
    const proxy = await createResetProxy(TUNNEL_BASE);
    try {
      const ts = await signIn(`http://127.0.0.1:${proxy.port}`);
      fresh.push(await dropArm({ name: 'tunnel-reset', base: ts.base, tokens: ts.tokens, prompts: Number(process.env.BENCH_DROP_PROMPTS_RESET || 2), dropsPerPrompt: 2, makeDropper: () => async () => { proxy.reset(); } }));
    } finally { await proxy.close(); }
  }
  const arms = [...((R.steps.drop || {}).arms || []).filter((x) => !fresh.some((f) => f.name === x.name)), ...fresh];
  const all = arms.flatMap((a) => a.reconnectMs);
  const replies = arms.flatMap((a) => a.replies);
  // seq 1 of a session's first reply is the pre-bind session.info; the controller never forwards it, so it is not a loss
  const realLost = (r) => (r.audit.lost || 0) - ((r.audit.missingTypes || []).filter((t) => t === 'session.info').length);
  R.steps.drop = {
    prompt: LONG_PROMPT,
    reconnect: { note: 'ms from the drop to link `live` again (replay applied); consecutive drops within the 30 s stable window back off', ...stats(all) },
    totals: { replies: replies.length, drops: all.length, dropAttemptsThatTimedOut: replies.flatMap((r) => r.drops).filter((d) => d.error).length,
      lostEvents: replies.reduce((s, r) => s + realLost(r), 0), duplicateEvents: replies.reduce((s, r) => s + (r.audit.duplicates || 0), 0),
      textMismatch: replies.filter((r) => !r.textEqualsServer).length, notExactlyOneSubmit: replies.filter((r) => r.serverRows !== 1).length, gaps: arms.reduce((s, a) => s + a.gaps, 0), auditErrors: replies.filter((r) => r.audit.error).length },
    arms,
  };
  save();
  console.log('drop', JSON.stringify(R.steps.drop.totals), JSON.stringify(R.steps.drop.reconnect));
}

// ── step: reconnect time on an idle attached session, drops spaced past the link's stable window (no prompts) ──
async function reconnectArm({ name, base, tokens, dropFn, n, gapMs }) {
  const st = makeStack({ base, tokens });
  await startLive(st);
  const S = await makeSession(`reconnect-${name}`);
  await st.link.attach(S);
  const rows = [];
  for (let i = 0; i < n; i++) {
    await sleep(gapMs);
    const liveBefore = st.lives.length, droppedBefore = st.states.length;
    const t0 = now();
    await dropFn(st);
    try {
      await until(() => st.lives.length > liveBefore, 30000, 'live again');
      const detect = st.states.slice(droppedBefore).find((x) => x.state !== 'live');
      rows.push({ ms: round(st.lives.at(-1) - t0), detectMs: detect ? round(detect.at - t0) : null, attached: st.link.getState().attached });
    } catch (e) { rows.push({ error: String(e.message) }); }
  }
  st.link.stop();
  return { name, samples: rows, reconnect: stats(rows.map((r) => r.ms)), allReattached: rows.every((r) => r.attached === 1) };
}
async function stepReconnect() {
  const n = Number(process.env.BENCH_RECONNECT_N || 10), gapMs = Number(process.env.BENCH_RECONNECT_GAP_MS || 31000);
  const arms = [];
  const si = await signIn(GW_BASE);
  arms.push(await reconnectArm({ name: 'wss-close', base: si.base, tokens: si.tokens, n, gapMs, dropFn: async (st) => { st.last.conn.socket.close(); } }));
  save();
  const proxy = await createResetProxy(TUNNEL_BASE);
  try {
    const ts = await signIn(`http://127.0.0.1:${proxy.port}`);
    arms.push(await reconnectArm({ name: 'tunnel-reset', base: ts.base, tokens: ts.tokens, n, gapMs, dropFn: async () => { proxy.reset(); } }));
  } finally { await proxy.close(); }
  R.steps.reconnect = { note: `idle attached session, ${gapMs} ms between drops so the link's failure counter resets; ms = drop to link live again with replay applied`, arms };
  save();
  console.log('reconnect', JSON.stringify(arms.map((a) => ({ name: a.name, ...a.reconnect, allReattached: a.allReattached }))));
}

// ── step: server requests (clarify) with two sockets ────────────────────────
async function stepRequests() {
  const si = await signIn(GW_BASE);
  const S = await makeSession('requests');
  const A = makeStack({ base: si.base, tokens: si.tokens });
  await startLive(A);
  await A.link.attach(S);
  // second socket: raw wire, attached to the same session, declares server_requests
  const c2 = await A.open({ timeoutMs: 8000 });
  const res = await c2.wire.call('session.resume', { session_id: S, lazy: true, inline_images: false }, { timeoutMs: 15000 });
  await c2.wire.call('gateway.capabilities', {}); await c2.wire.call('client.capabilities', { server_requests: true });
  const sid2 = res.session_id;
  await c2.wire.call('session.activate', { session_id: sid2, omit_messages: false });
  const seen = { a: [], b: [], aWithdrawn: [], bWithdrawn: [], bEvents: [] };
  A.link.on('request', ({ request }) => seen.a.push({ id: request.id, method: request.method, params: shape(request.params), at: now() }));
  A.link.on('requestClosed', ({ id }) => seen.aWithdrawn.push({ id, at: now() }));
  c2.wire.on('serverRequest', (q) => seen.b.push({ id: q.id, method: q.method, params: shape(q.params), at: now() }));
  c2.wire.on('serverRequestWithdrawn', (q) => seen.bWithdrawn.push({ id: q.id, cancel: q.cancel, at: now() }));
  c2.wire.on('event', (e) => { if (e.type !== 'message.delta') seen.bEvents.push(e.type); });
  const events = new Set();
  A.link.on('event', (e) => events.add(e.type));
  countPrompt('requests clarify');
  const text = 'Use your clarify tool to ask me exactly one question: "Which colour do you prefer, red or blue?" with the choices red and blue. After I answer, reply with only that colour.';
  const r = runReply(A.api, S, text);
  await until(() => seen.a.length > 0 || r.end != null, 90000, 'a request or the end of the reply');
  const out = { sessionId: S, prompt: text };
  if (seen.a.length) {
    await sleep(800);
    out.reachedLinkSocket = seen.a.length; out.reachedSecondSocket = seen.b.length;
    out.request = { method: seen.a[0].method, params: seen.a[0].params };
    // answer it through the adapter, the app's own path
    const req = seen.a[0];
    const t0 = now();
    let answer;
    try { await A.api.answerClarify(`ws:${S}:1`, { requestId: String(req.id), answer: 'blue' }); answer = { ok: true, ms: round(now() - t0) }; } catch (e) { answer = { ok: false, code: e.code, message: String(e.message).slice(0, 200) }; }
    out.answerViaAdapter = answer;
    await Promise.race([r.done, sleep(90000)]);
    await sleep(500);
    out.secondSocketWithdrawn = seen.bWithdrawn.length; out.linkSocketWithdrawn = seen.aWithdrawn.length;
    out.withdrawDetail = seen.bWithdrawn.map((w) => w.cancel);
  } else out.noRequest = { terminal: r.terminal, text: r.text.slice(0, 200) };
  out.reply = { terminal: r.terminal, text: r.text.slice(0, 200), err: r.err };
  out.secondSocketEventTypes = [...new Set(seen.bEvents)];
  out.linkEventTypes = [...events];
  c2.close(); A.link.stop();
  R.steps.requests = out; save();
  console.log('requests', JSON.stringify(out).slice(0, 700));
}
// Structure only (keys and short values); never message text beyond 80 chars.
function shape(v, d = 0) {
  if (typeof v === 'string') return v.length > 80 ? v.slice(0, 80) + '…' : v;
  if (Array.isArray(v)) return d > 3 ? '[…]' : v.slice(0, 6).map((x) => shape(x, d + 1));
  if (v && typeof v === 'object') return d > 3 ? '{…}' : Object.fromEntries(Object.entries(v).slice(0, 14).map(([k, x]) => [k, shape(x, d + 1)]));
  return v;
}

// ── step: the live orphan grace (no prompts) ────────────────────────────────
async function stepGrace() {
  const si = await signIn(GW_BASE);
  const S = await makeSession('grace');
  const st = makeStack({ base: si.base, tokens: si.tokens });
  const watcher = await st.open({ timeoutMs: 8000 });
  const victim = await st.open({ timeoutMs: 8000 });
  await victim.wire.call('session.resume', { session_id: S, lazy: true, inline_images: false }, { timeoutMs: 15000 });
  const listed = async () => { const al = await watcher.wire.call('session.active_list', {}, { timeoutMs: 8000 }); return (al.sessions || []).some((s) => s.session_key === S); };
  const before = await listed();
  const t0 = now();
  victim.close();
  const maxMs = Number(process.env.BENCH_GRACE_MAX_S || 330) * 1000;
  let goneAt = null;
  while (now() - t0 < maxMs) {
    await sleep(2000);
    if (!(await listed())) { goneAt = now() - t0; break; }
  }
  watcher.close();
  R.steps.grace = { listedBeforeDrop: before, reapedAfterMs: goneAt == null ? null : round(goneAt), stillListedAtMs: goneAt == null ? round(now() - t0) : null, pollEveryMs: 2000, note: 'idle session, socket closed by the client; time until it left session.active_list' };
  save();
  console.log('grace', JSON.stringify(R.steps.grace));
}

// ── cleanup ─────────────────────────────────────────────────────────────────
async function cleanup() {
  const report = [];
  for (const s of stacks) { try { s.link.stop(); } catch {} }
  // close the runtime sessions of mine, only mine
  try {
    const si = await signIn(GW_BASE);
    const st = makeStack({ base: si.base, tokens: si.tokens });
    const c = await st.open({ timeoutMs: 8000 });
    const al = await c.wire.call('session.active_list', {}, { timeoutMs: 8000 });
    for (const s of al.sessions || []) if (created.includes(s.session_key)) { try { await c.wire.call('session.close', { session_id: s.id }, { timeoutMs: 15000 }); } catch {} }
    c.close();
  } catch (e) { report.push({ runtimeCloseError: String(e.code || e.message).slice(0, 100) }); }
  await sleep(1000);
  for (const id of created) {
    let del = { status: 0 };
    for (let i = 0; i < 6; i++) { del = await restRaw('DELETE', `/api/sessions/${enc(id)}`); if (del.status !== 409) break; await sleep(3000); }
    const chk = await restRaw('GET', `/api/sessions/${enc(id)}`);
    report.push({ id, deleteStatus: del.status, getAfterDelete: chk.status });
  }
  return report;
}

(async () => {
  console.log(`steps=${STEPS.join(',')} cap=${MAX_PROMPTS} stamp=${STAMP}`);
  const fns = { rtt: stepRtt, cold: stepCold, warm: stepWarm, drop: stepDrop, requests: stepRequests, grace: stepGrace, reconnect: stepReconnect };
  let failure = null;
  try {
    for (const s of STEPS) { if (!fns[s]) throw new Error(`unknown step ${s}`); console.log(`-- ${s}`); await fns[s](); }
  } catch (e) { failure = e; console.error('STEP FAILED:', String(e.stack || e).slice(0, 800)); }
  const cleaned = await cleanup().catch((e) => [{ cleanupError: String(e.message).slice(0, 100) }]);
  R.runs = R.runs || [];
  R.runs.push({ stamp: STAMP, steps: STEPS, promptsUsed: prompts, promptLog, sessionsCreated: created, cleanup: cleaned, failure: failure ? String(failure.message).slice(0, 300) : null });
  R.promptsUsedTotal = R.runs.reduce((s, r) => s + r.promptsUsed, 0);
  save();
  console.log(`prompts used this run: ${prompts}; sessions created: ${created.length}; cleanup: ${JSON.stringify(cleaned.map((c) => `${c.deleteStatus}/${c.getAfterDelete}`))}`);
  process.exit(failure ? 1 : 0);
})();
