'use strict';
// In-memory model of the Hermes conversation gateway that tests share, whatever
// carries the frames (a real WebSocket in hermes-auth-fake-backend.cjs, plain
// streams in gateway-link.test.cjs). It models the parts the link depends on
// and nothing else: per-session monotonic `seq` in a bounded replay ring, a
// per-process epoch (a restart resets every seq), `gateway.ping`, the orphan
// grace (a session whose last socket dropped is reaped after `orphanGraceMs`,
// its ring freed), and a streaming turn that keeps running with no socket
// attached. Like Hermes it has NO client id on prompt.submit and no dedupe:
// every submit it receives is recorded in `submits`.
//
// cfg: { epoch, sessions, ringMax=512, orphanGraceMs=20000, deltaCount=3,
//        firstDeltaMs=0, deltaMs=0, extraRpc, mangleReplay(events) }
function createGatewayEngine(cfg = {}) {
  let epoch = cfg.epoch || 'epoch-1';
  let epochCounter = 1;
  const ringMax = cfg.ringMax ?? 512;
  const graceMs = cfg.orphanGraceMs ?? 20000;
  const live = new Map();        // runtime session id -> session
  const stored = new Map();      // stored id (= session_key) -> { id, title, messages }
  const peers = new Set();
  const timers = new Set();
  const submits = [];
  const applied = [];            // every event emitted: { sessionId, seq, type }
  let rowSeq = 0, newSeq = 0, closed = false, pings = 0;
  const nowSec = () => Math.floor(Date.now() / 1000);
  const later = (fn, ms) => {
    const t = setTimeout(() => { timers.delete(t); if (!closed) fn(); }, ms);
    t.unref?.(); timers.add(t); return t;
  };

  const storedFor = (key, title = key) => {
    if (!stored.has(key)) stored.set(key, { id: key, title, messages: [] });
    return stored.get(key);
  };
  function addSession(id, key, title = key, profile = 'default') {
    const s = { id, session_key: key, title, profile, seq: 0, ring: [], peers: new Set(), orphan: null, turn: null, reaped: false };
    live.set(id, s); storedFor(key, title);
    return s;
  }
  for (const r of (cfg.sessions !== undefined ? cfg.sessions : [
    { id: 'sess-1', session_key: 'key-1', title: 'alpha', profile: 'default' },
    { id: 'sess-2', session_key: 'key-2', title: 'beta', profile: 'default' },
  ])) addSession(r.id, r.session_key, r.title, r.profile);

  const row = (s) => ({ id: s.id, session_key: s.session_key, title: s.title, profile: s.profile });

  function emit(s, type, payload) {
    if (s.reaped) return;
    const seq = ++s.seq;
    const frame = { type, session_id: s.id, seq, payload };
    s.ring.push(frame);
    while (s.ring.length > ringMax) s.ring.shift();
    applied.push({ sessionId: s.id, seq, type });
    for (const p of s.peers) if (p.alive) p.send({ jsonrpc: '2.0', method: 'event', params: frame });
  }

  function startTurn(s, text) {
    const n = cfg.deltaCount ?? 3;
    const tokens = cfg.tokens ? cfg.tokens(text) : Array.from({ length: n }, (_, i) => `w${i} `);
    s.turn = { text };
    let i = 0;
    const step = () => {
      if (i === 0) emit(s, 'message.start', {});
      if (i < tokens.length) { emit(s, 'message.delta', { text: tokens[i] }); i += 1; later(step, cfg.deltaMs ?? 0); return; }
      const full = tokens.join('');
      storedFor(s.session_key).messages.push({ id: ++rowSeq, role: 'assistant', content: full, timestamp: nowSec() });
      emit(s, 'message.complete', { text: full, status: 'complete' });
      s.turn = null;
    };
    later(step, cfg.firstDeltaMs ?? 0);
  }

  function reap(s) {
    if (s.reaped) return;
    s.reaped = true; s.ring = [];
    live.delete(s.id);
  }
  function attachPeer(p, s) {
    if (s.orphan) { clearTimeout(s.orphan); timers.delete(s.orphan); s.orphan = null; }
    s.peers.add(p); p.sessions.add(s);
  }

  function rpc(peer, method, params) {
    switch (method) {
      case 'gateway.ping': pings += 1; return { result: { ok: true } };
      case 'gateway.capabilities': return { result: { per_session_exclusive_submit: true, modes: ['default'] } };
      case 'client.capabilities': return { result: { server_requests: ['tool.approval'] } };
      case 'session.active_list': return { result: { sessions: [...live.values()].map(row) } };
      case 'session.list': return { result: { sessions: [...stored.values()].map((r) => ({ id: r.id, title: r.title })) } };
      case 'session.create': {
        const id = `sess-new-${++newSeq}-${Math.floor(Math.random() * 1e6)}`;
        addSession(id, `key-${id}`, id);
        return { result: { session_id: id } };
      }
      case 'session.resume': {
        const key = String(params.session_id || '');
        const existing = [...live.values()].find((s) => s.session_key === key);
        const s = existing || addSession(`rt-${++newSeq}`, key, storedFor(key).title);
        return { result: { session_id: s.id, session_key: s.session_key, resumed: true, message_count: storedFor(key).messages.length } };
      }
      case 'session.activate': {
        const s = live.get(params.session_id);
        if (!s) return { result: { session_id: params.session_id, session_key: `key-${params.session_id}`,
          stored_session_id: `stored-${params.session_id}`, messages: [], open_requests: [], inflight: null } };
        attachPeer(peer, s);
        return { result: { session_id: s.id, session_key: s.session_key, stored_session_id: s.session_key,
          messages: params.omit_messages ? [] : storedFor(s.session_key).messages.map((m) => ({ role: m.role, text: m.content, row_id: m.id, timestamp: m.timestamp })),
          open_requests: [], inflight: null } };
      }
      case 'session.events.since': {
        const s = live.get(params.session_id);
        if (!s) return { error: { code: 4001, message: 'unknown session' } };
        const last = Number.isInteger(params.last_seen) ? params.last_seen : 0;
        const first = s.ring.length ? s.ring[0].seq : s.seq + 1;
        const events = (cfg.mangleReplay || ((e) => e))(s.ring.filter((e) => e.seq > last));
        return { result: { epoch, events, open_requests: [], latest_seq: s.seq, truncated: last < first - 1, count: events.length } };
      }
      case 'prompt.submit': {
        const s = live.get(params.session_id);
        if (!s) return { error: { code: 4001, message: 'unknown session' } };
        if (s.turn) return { error: { code: 4090, message: 'Nothing was sent: a reply is still running' } };
        submits.push({ sessionId: s.id, text: String(params.text), at: Date.now() });
        const userRow = { id: ++rowSeq, role: 'user', content: String(params.text), timestamp: nowSec() };
        storedFor(s.session_key).messages.push(userRow);
        startTurn(s, String(params.text));
        return { result: { status: 'streaming', user_row_id: userRow.id } };
      }
      case 'session.interrupt': return { result: { status: 'ok', interrupted: true } };
      default:
        if (cfg.extraRpc) { const r = cfg.extraRpc(method, params); if (r !== undefined) return r; }
        return { error: { code: -32601, message: `unknown method ${method}` } };
    }
  }

  return {
    epoch: () => epoch,
    submits, applied,
    pings: () => pings,
    liveSessions: () => [...live.values()],
    session: (id) => live.get(id),
    stored: (key) => stored.get(key),
    connect(send) {
      const peer = { send, alive: true, sessions: new Set() };
      peers.add(peer);
      return peer;
    },
    handle: (peer, frame) => rpc(peer, frame.method, frame.params || {}),
    // A dropped socket parks its sessions; the grace window starts when the
    // LAST attached socket goes. Only an orphan is reaped.
    disconnect(peer) {
      if (!peer.alive) return;
      peer.alive = false; peers.delete(peer);
      for (const s of peer.sessions) {
        s.peers.delete(peer);
        if (!s.peers.size && !s.orphan && !s.reaped) s.orphan = later(() => { s.orphan = null; reap(s); }, graceMs);
      }
      peer.sessions.clear();
    },
    // A Hermes restart: new epoch, every runtime session and every seq gone,
    // the running turn lost. Stored history survives.
    restart(next) {
      epochCounter += 1;
      epoch = next || `epoch-${epochCounter}`;
      for (const s of live.values()) { s.reaped = true; s.ring = []; if (s.orphan) clearTimeout(s.orphan); }
      live.clear();
      for (const p of [...peers]) { p.alive = false; peers.delete(p); p.sessions.clear(); }
    },
    history: (key) => (stored.get(key)?.messages || []).slice(),
    close() { closed = true; for (const t of timers) clearTimeout(t); timers.clear(); },
  };
}

module.exports = { createGatewayEngine };
