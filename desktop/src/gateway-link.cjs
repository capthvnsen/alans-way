'use strict';
// Link supervisor: one per account. Owns the single Hermes WebSocket, keeps it
// alive (ping), reconnects with capped jittered backoff, and resumes every
// attached conversation from its last applied `seq` instead of losing the reply.
//
// It adds no protocol of its own. The connector (hermes-remote), the wire
// (hermes-session-wire) and the controller (hermes-conversation, incl. its
// bindResume) do the speaking; this module decides WHEN, and what a gap means.
//
// Rules held here:
// - One attempt at a time, never more than one open socket. A trigger cancels
//   the wait between attempts, never a running attempt.
// - lastSeq/epoch survive a drop in the attachment record; the old controller
//   is disposed, a new one is built on the new wire with `resume`.
// - Same epoch + session still live: replay since lastSeq. Epoch changed,
//   replay truncated or holed, or the session reaped: emit `gap` and let the
//   caller reload history. Nothing is replayed for a send (no outbox here): a
//   send while the link is not live is refused with `not_live`.
// - Vault requests (a fill script that carries a password, a code or unlock prompt) are answered on the wire
//   here, by the injected `vault` handler or a refusal, and never reach a controller or a listener.
// - Logs carry state names, codes, counts and timings only. Never a URL,
//   credential, message text or request body.
const { EventEmitter } = require('node:events');
const { HermesConversation } = require('./hermes-conversation.cjs');
const { createHermesRemote, RemoteError } = require('./hermes-remote.cjs');
const { HermesSessionWire } = require('./hermes-session-wire.cjs');
const { isVaultRequest, NOT_YET } = require('./vault-fill.cjs');

const DEFAULTS = Object.freeze({
  baseMs: 500, capMs: 15000, freeDrops: 5, dropWindowMs: 120000,
  connectTimeoutMs: 8000, bindTimeoutMs: 8000,
  pingIdleMs: 9000, pingDeadMs: 4000, // 13 s worst case from the last frame, inside the 14 s target and Hermes's 45 s
  offlinePollMs: 1000, focusIdleMs: 15000,
});

class LinkError extends Error {
  constructor(code, message) { super(message); this.name = 'LinkError'; this.code = code; }
}

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
// The wire tells 1 from "1"; so must anything keyed by a request id.
const idKey = (id) => `${typeof id}:${String(id)}`;
const str = (v, max = 300) => typeof v === 'string' ? v.slice(0, max) : '';
// Failures that retrying cannot fix: the user (or the settings) must act.
const SIGNIN_CODES = new Set(['session_expired', 'needs_signin', 'auth_failed']);
const STOP_CODES = new Set(['unconfigured', 'no_credential']);

function createGatewayLink(deps = {}) {
  const { open } = deps;
  if (typeof open !== 'function') throw new LinkError('bad_open', 'open() is required');
  const makeController = deps.createController || ((a) => new HermesConversation(a));
  const isOnline = deps.isOnline || (() => true);
  const log = deps.log || (() => {});
  const vault = deps.vault || null;
  const profileOf = () => str(typeof deps.profile === 'function' ? deps.profile() : deps.profile, 200);
  const timers = { setTimeout, clearTimeout, now: Date.now, random: Math.random, ...deps.timers };
  const o = { ...DEFAULTS, ...deps.options };
  const link = new EventEmitter();

  let state = 'idle', since = timers.now(), started = false, suspended = false, stopped = false;
  let failures = 0, drops = [], lastError = '', everLive = false, liveAt = 0;
  let conn = null, generation = 0, running = false, abortCtl = null;
  let waitTimer = null, pingTimer = null, lastActivity = 0, lastEpoch = '';
  const att = new Map(); // storedId -> attachment

  const emitState = () => link.emit('state', getState());
  function setState(next) {
    if (state === next) return;
    state = next; since = timers.now();
    log('link.state', { state: next, failures });
    emitState();
  }
  function getState() {
    return { state, since, failures, lastError, epoch: lastEpoch, live: state === 'live',
      attached: [...att.values()].filter((a) => a.controller).length, socket: !!conn };
  }

  const backoffMs = (n) => n <= 0 ? 0 : Math.floor(timers.random() * Math.min(o.capMs, o.baseMs * 2 ** (n - 1)));

  // ── scheduling ────────────────────────────────────────────────────────────
  function clearWait() { if (waitTimer) { timers.clearTimeout(waitTimer); waitTimer = null; } }
  function schedule(ms) {
    clearWait();
    if (stopped || suspended) return;
    waitTimer = timers.setTimeout(() => { waitTimer = null; attemptNow(); }, ms);
    waitTimer.unref?.();
  }
  // Drops of a link that had reached live, newest last. The first `freeDrops` in `dropWindowMs` reconnect at once;
  // each one past that doubles the wait (capped, half-to-full jitter so luck cannot make a flapping link a loop).
  function dropDelay() {
    const t = timers.now();
    drops = drops.filter((d) => t - d < o.dropWindowMs);
    drops.push(t);
    const over = drops.length - o.freeDrops;
    if (over <= 0) return 0;
    const cap = Math.min(o.capMs, o.baseMs * 2 ** (over - 1));
    return Math.floor(cap / 2 + timers.random() * cap / 2);
  }
  function scheduleNext(ms = backoffMs(failures)) {
    failures += 1;
    log('link.retry', { inMs: ms, failures });
    schedule(ms);
  }

  async function attemptNow() {
    if (stopped || suspended || running || conn) return;
    clearWait();
    if (!isOnline()) { setState('offline'); schedule(o.offlinePollMs); return; }
    running = true;
    const gen = ++generation;
    abortCtl = new AbortController();
    setState(everLive ? 'reconnecting' : 'connecting');
    let opened = null;
    try {
      opened = await open({ signal: abortCtl.signal, timeoutMs: o.connectTimeoutMs });
      if (gen !== generation || stopped || suspended) { closeConn(opened); return; }
      adopt(opened);
      setState('syncing');
      await resumeAll(opened);
      if (gen !== generation || conn !== opened) return;
      everLive = true; lastError = ''; liveAt = timers.now();
      lastEpoch = opened.epoch;
      failures = 0;
      setState('live');
      armPing();
      link.emit('live', getState());
    } catch (e) {
      if (gen !== generation) return;
      const code = str(e && e.code, 60) || 'error';
      lastError = code;
      log('link.attempt_failed', { code });
      if (conn === opened && opened) dropConn('attach_failed', { keepState: true });
      else if (opened) closeConn(opened);
      if (SIGNIN_CODES.has(code)) { setState('signin'); return; }
      // The address rule (tailnet, scheme) said no: retrying cannot change that, only a new address can.
      if (code === 'bad_url') { setState('refused'); return; }
      if (STOP_CODES.has(code)) { setState('idle'); return; }
      setState(isOnline() ? 'reconnecting' : 'offline');
      scheduleNext();
    } finally {
      if (gen === generation) { running = false; abortCtl = null; }
    }
  }

  function closeConn(c) {
    if (!c) return;
    try { c.wire?.dispose?.(); } catch {}
    try { c.close?.(); } catch {}
  }

  function adopt(c) {
    conn = c;
    lastActivity = timers.now();
    // Any inbound byte is proof of life; the ping only fires after real silence.
    // Only the current socket's bytes count: a late frame from a dropped one must not vouch for the new one.
    c.wire.input?.on?.('data', () => { if (conn === c) lastActivity = timers.now(); });
    c.wire.on('close', (info) => { if (conn === c) dropConn(`wire_${info && info.state || 'closed'}`); });
    serveVault(c);
  }

  // One answer per vault request. A withdrawn request or a closed wire aborts the handler, which closes its prompt.
  function serveVault(c) {
    const inflight = new Map(); // idKey(wire id) -> AbortController
    const refuse = (id, message, code = -32601) => c.wire.refuseServerRequest(id, { code, message }).catch(() => {});
    c.wire.on('serverRequest', (r) => {
      if (conn !== c || !isVaultRequest(r.method, r.params)) return;
      const a = r.method === 'preview.act' && typeof r.sessionId === 'string' ? [...att.values()].find((x) => x.controller && x.sessionId === r.sessionId) : null;
      if (r.method !== 'preview.act') { refuse(r.id, `Vault codes and unlock are ${NOT_YET} in this app.`); return; }
      if (!vault) { refuse(r.id, `Vault fill is ${NOT_YET} in this app.`); return; }
      if (!a) { refuse(r.id, 'That conversation is not open in this app.'); return; }
      const ctl = new AbortController(), key = idKey(r.id);
      inflight.set(key, ctl);
      Promise.resolve().then(() => vault.handle({ storedId: a.storedId, sessionId: a.sessionId, params: r.params, signal: ctl.signal }))
        .then((result) => c.wire.answerServerRequest(r.id, result), () => refuse(r.id, 'The vault step failed.', -32603))
        .catch(() => {}).finally(() => inflight.delete(key));
    });
    c.wire.on('serverRequestWithdrawn', (w) => { inflight.get(idKey(w.id))?.abort(); });
    c.wire.on('close', () => { for (const ctl of inflight.values()) ctl.abort(); });
  }

  // Tear down the socket, keep every attachment's watermark. `keepState` is for
  // a failed attempt, whose caller sets the state itself.
  function dropConn(reason, { keepState = false } = {}) {
    const c = conn;
    if (!c) return;
    conn = null;
    timers.clearTimeout(pingTimer); pingTimer = null;
    const wasLive = liveAt > 0;
    liveAt = 0;
    for (const a of att.values()) detachController(a);
    closeConn(c);
    log('link.dropped', { reason });
    link.emit('dropped', { reason });
    if (keepState || stopped || suspended) return;
    setState(isOnline() ? 'reconnecting' : 'offline');
    generation++; running = false;
    scheduleNext(wasLive ? dropDelay() : undefined);
  }

  function detachController(a) {
    for (const off of a.offs) { try { off(); } catch {} }
    a.offs = [];
    if (a.controller) { try { a.controller.dispose(); } catch {} }
    a.controller = null;
    a.seen.clear();
  }

  // ── liveness ──────────────────────────────────────────────────────────────
  function armPing(delay = o.pingIdleMs - (timers.now() - lastActivity)) {
    timers.clearTimeout(pingTimer);
    if (!conn) return;
    pingTimer = timers.setTimeout(pingCheck, Math.max(1, delay));
    pingTimer.unref?.();
  }
  function pingCheck() {
    const quiet = timers.now() - lastActivity;
    if (!conn) return;
    if (quiet < o.pingIdleMs) { armPing(); return; }
    probeNow();
  }
  function probeNow() {
    const c = conn;
    if (!c || c.probing) return;
    c.probing = true;
    c.wire.call('gateway.ping', {}, { timeoutMs: o.pingDeadMs }).then(() => {
      c.probing = false; lastActivity = timers.now();
      if (conn === c) armPing();
    }, () => { c.probing = false; if (conn === c) dropConn('ping_timeout'); });
  }

  // ── attachments ───────────────────────────────────────────────────────────
  function track(a, ctl) {
    a.controller = ctl;
    const onEvent = (e) => {
      if (Number.isSafeInteger(e.seq) && e.seq > a.lastSeq) a.lastSeq = e.seq;
      link.emit('event', { storedId: a.storedId, ...e });
    };
    const onChange = (s) => {
      const open = new Map(s.pendingRequests.filter((r) => r.attributed).map((r) => [String(r.id), r]));
      for (const [id, r] of open) if (!a.seen.has(id)) { a.seen.add(id); link.emit('request', { storedId: a.storedId, request: r }); }
      for (const id of [...a.seen]) if (!open.has(id)) { a.seen.delete(id); link.emit('requestClosed', { storedId: a.storedId, id }); }
    };
    ctl.on('event', onEvent); ctl.on('change', onChange);
    a.offs.push(() => ctl.removeListener('event', onEvent), () => ctl.removeListener('change', onChange));
  }

  const identityOf = (a) => ({ profile: profileOf() || 'default', sessionKey: a.sessionKey, sessionId: a.sessionId, reviewed: true });

  async function attachFresh(a, c) {
    const resumed = await c.wire.call('session.resume', { session_id: a.storedId, ...(profileOf() ? { profile: profileOf() } : {}), lazy: true, inline_images: false });
    const sessionId = str(resumed && resumed.session_id), sessionKey = str(resumed && resumed.session_key) || a.storedId;
    if (!sessionId) throw new LinkError('contract_drift', 'session.resume did not return a session_id');
    a.sessionId = sessionId; a.sessionKey = sessionKey; a.lastSeq = 0;
    const ctl = makeController({ wire: c.wire, identity: identityOf(a) });
    track(a, ctl);
    try {
      await ctl.bind({ expectedEpoch: c.epoch, timeoutMs: o.bindTimeoutMs });
      // The caller reads history over REST; the controller's own transcript is not shown.
      if (ctl.getState().phase === 'review') ctl.acknowledgeReview();
    } catch (e) { detachController(a); throw e; }
    a.lastSeq = ctl.getState().lastSeq;
    a.epoch = c.epoch;
  }

  function gap(a, reason) {
    log('link.gap', { reason, seq: a.lastSeq });
    detachController(a);
    a.sessionId = ''; a.sessionKey = ''; a.lastSeq = 0; a.epoch = '';
    link.emit('gap', { storedId: a.storedId, reason });
  }

  async function resumeAll(c) {
    const restarted = !!lastEpoch && c.epoch !== lastEpoch;
    const jobs = [];
    for (const a of att.values()) {
      if (!a.sessionId) { att.delete(a.storedId); continue; }
      jobs.push((async () => {
        if (restarted) { gap(a, 'restarted'); return; }
        const ctl = makeController({ wire: c.wire, identity: identityOf(a), resume: { epoch: a.epoch || lastEpoch, lastSeq: a.lastSeq } });
        track(a, ctl);
        let info;
        try { info = await ctl.bindResume({ expectedEpoch: c.epoch, timeoutMs: o.bindTimeoutMs }); }
        catch (e) {
          if (conn !== c || c.wire.state !== 'open') throw e;
          if (['identity_unavailable', 'epoch_mismatch', 'identity_drift', 'blocked'].includes(e && e.code)) { gap(a, e.code === 'identity_unavailable' ? 'reaped' : 'restarted'); return; }
          throw e;
        }
        a.epoch = c.epoch;
        log('link.resumed', { applied: info.applied, truncated: info.truncated, holes: info.holes });
        if (info.truncated) { ctl.acknowledgeReview(); gap(a, 'truncated'); }
      })());
    }
    await Promise.all(jobs);
    // A conversation whose runtime session is gone gets a new live one now, so
    // the next send is not the one that pays for it. Best effort.
    await Promise.all([...att.values()].filter((a) => !a.controller && a.wanted).map((a) => attachFresh(a, c).catch((e) => {
      if (c.wire.state !== 'open') throw e;
      log('link.reattach_failed', { code: str(e && e.code, 60) });
    })));
  }

  function requireLive() {
    if (state !== 'live' || !conn) {
      throw new LinkError(state === 'signin' ? 'signin' : 'not_live', state === 'signin' ? 'Sign in to Hermes again.' : 'The connection to Hermes is not live.');
    }
    return conn;
  }

  async function attach(storedId) {
    const id = str(storedId, 300);
    if (!id) throw new LinkError('bad_session', 'A conversation id is required.');
    let a = att.get(id);
    if (!a) { a = { storedId: id, sessionId: '', sessionKey: '', controller: null, lastSeq: 0, epoch: '', offs: [], seen: new Set(), attaching: null, wanted: true }; att.set(id, a); }
    a.wanted = true;
    if (a.controller && conn && a.controller.wire === conn.wire) return a;
    const c = requireLive();
    if (!a.attaching) {
      a.attaching = attachFresh(a, c).then(() => a, (e) => { if (!a.sessionId) att.delete(id); throw e; }).finally(() => { a.attaching = null; });
    }
    return a.attaching;
  }

  const controllerOf = (storedId) => {
    const a = att.get(storedId);
    if (!a || !a.controller || !conn || a.controller.wire !== conn.wire) throw new LinkError('not_live', 'This conversation is not attached.');
    return a.controller;
  };

  // ── triggers ──────────────────────────────────────────────────────────────
  function trigger(reason) {
    if (stopped || !started) return;
    log('link.trigger', { reason });
    if (reason === 'retry' || reason === 'credentials') {
      if (suspended) return;
      if (state === 'signin' || state === 'idle' || state === 'refused') { failures = 0; setState('reconnecting'); }
      if (!conn) { clearWait(); attemptNow(); }
      return;
    }
    if (suspended || state === 'signin') return;
    if (reason === 'wake') {
      if (conn) { dropConn('wake', { keepState: true }); setState(isOnline() ? 'reconnecting' : 'offline'); generation++; running = false; }
      clearWait(); attemptNow();
      return;
    }
    if (conn) { if (reason === 'online' || (reason === 'focus' && timers.now() - lastActivity > o.focusIdleMs)) probeNow(); return; }
    clearWait(); attemptNow();
  }

  function suspend() {
    if (stopped || suspended) return;
    suspended = true;
    clearWait();
    abortCtl?.abort();
    if (conn) dropConn('suspend', { keepState: true });
    generation++; running = false;
    setState('suspended');
  }
  function resume() {
    if (stopped || !suspended) return;
    suspended = false;
    // After sleep the old socket is dead even if nothing says so; a fresh attempt starts now.
    setState('reconnecting');
    attemptNow();
  }

  function start() {
    if (started || stopped) return;
    started = true;
    attemptNow();
  }
  function stop() {
    stopped = true; clearWait();
    abortCtl?.abort();
    if (conn) dropConn('stop', { keepState: true });
    generation++; running = false;
    setState('stopped');
  }

  return Object.assign(link, {
    start, stop, suspend, resume, trigger, getState, attach,
    detach(storedId) { const a = att.get(storedId); if (a) { a.wanted = false; detachController(a); att.delete(storedId); } },
    submit: async (storedId, text) => { await attach(storedId); return controllerOf(storedId).send(text); },
    interrupt: (storedId) => controllerOf(storedId).stop(),
    answer: (storedId, requestId, result) => controllerOf(storedId).answerRequest(requestId, result),
    pending: (storedId) => { try { return controllerOf(storedId).getState().pendingRequests.filter((r) => r.attributed); } catch { return []; } },
    isLive: () => state === 'live' && !!conn,
  });
}

// Default `open`: probe once (cached), refresh if the access token is stale,
// mint a ticket, connect, wait for gateway.ready. Reuses hermes-remote and the
// wire; the credential owner (the hub) supplies and receives the tokens.
function createGatewayOpener({ credentials, adoptTokens = () => {}, expireSignIn = () => {}, remote = createHermesRemote(), createWire, now = Date.now } = {}) {
  const wireOf = createWire || (({ input, output }) => new HermesSessionWire({ input, output }));
  const authRequiredCache = new Map();
  const unexpired = (t) => {
    if (!t || !t.accessToken || !t.expiresAt) return false;
    const ms = t.expiresAt > 1e12 ? t.expiresAt : t.expiresAt * 1000;
    return ms - now() > 30000;
  };
  return async function open({ signal, timeoutMs = 8000 } = {}) {
    const cred = credentials();
    if (!cred || !cred.base) throw new RemoteError('unconfigured', 'No Hermes gateway is configured.');
    const { base } = cred;
    const key = `${base.origin}${base.prefix}`;
    if (!authRequiredCache.has(key)) {
      const report = await remote.probe(key, { signal });
      authRequiredCache.set(key, report.authRequired);
    }
    let credential;
    if (authRequiredCache.get(key)) {
      let tokens = cred.tokens;
      if (!tokens || !tokens.refreshToken) throw new RemoteError('needs_signin', 'Sign in to this backend first.');
      const refresh = async () => {
        try { tokens = await remote.refresh({ base, refreshToken: tokens.refreshToken, provider: tokens.provider, signal }); }
        catch (e) { if (e instanceof RemoteError && e.code === 'session_expired') expireSignIn(); throw e; }
        adoptTokens(tokens);
      };
      if (!unexpired(tokens)) await refresh();
      let ticket;
      try { ({ ticket } = await remote.wsTicket({ base, accessToken: tokens.accessToken, signal })); }
      catch (e) {
        if (!(e instanceof RemoteError) || e.code !== 'auth_failed') throw e;
        await refresh();
        ({ ticket } = await remote.wsTicket({ base, accessToken: tokens.accessToken, signal }));
      }
      credential = { ticket };
    } else {
      if (!cred.localToken) throw new RemoteError('needs_signin', 'This backend needs its local session token.');
      credential = { localToken: cred.localToken };
    }
    const conn = await remote.connectSocket({ url: remote.wsUrl({ base, ...credential }), timeoutMs, signal });
    const wire = wireOf({ input: conn.input, output: conn.output });
    const epoch = await new Promise((resolve, reject) => {
      const done = () => { clearTimeout(timer); wire.removeListener('event', onEvent); wire.removeListener('close', onClose); };
      const onEvent = (e) => {
        if (e && e.type === 'gateway.ready' && isPlainObject(e.payload) && typeof e.payload.replay_epoch === 'string' && e.payload.replay_epoch) { done(); resolve(e.payload.replay_epoch); }
      };
      const onClose = () => { done(); reject(new RemoteError('gateway_down', 'The connection closed before gateway.ready.')); };
      const timer = setTimeout(() => { done(); reject(new RemoteError('gateway_down', 'The gateway did not say gateway.ready.')); }, timeoutMs);
      wire.on('event', onEvent); wire.on('close', onClose);
    }).catch((e) => { try { wire.dispose(); conn.socket?.close?.(); } catch {} throw e; });
    return { wire, epoch, socket: conn.socket, close: () => { try { conn.socket?.close?.(); } catch {} } };
  };
}

module.exports = { createGatewayLink, createGatewayOpener, LinkError, DEFAULTS };
