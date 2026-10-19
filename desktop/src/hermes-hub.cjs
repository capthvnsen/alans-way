'use strict';
// Main-process owner for the native Hermes conversation surface.
//
// Owns the authenticated connector (hermes-remote.cjs), the session wire, and
// one HermesConversation controller per bound session. The renderer receives a
// bounded display-state projection and dispatches a closed allowlist of
// commands; credentials, sockets and RPCs never cross into the renderer.
//
// Identity honesty: a session row is ONLY ever the exact {session_id,
// session_key} pair the gateway itself reported over this authenticated wire.
// Telegram bots, browser URLs, and profile labels are never mapped onto a
// session, and a freshly created session is labelled as a new session on the
// configured gateway — never as an existing conversation owned elsewhere.
const { EventEmitter } = require('node:events');
const { createHermesRemote, RemoteError } = require('./hermes-remote.cjs');
const { HermesSessionWire } = require('./hermes-session-wire.cjs');
const { HermesConversation } = require('./hermes-conversation.cjs');

class HubError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.name = 'HubError';
    this.code = code;
    if (extra !== undefined) this.detail = extra;
  }
}
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const asString = (v, max = 4000) => typeof v === 'string' ? v.slice(0, max) : '';

const MAX_SESSIONS = 50;
const STATUS = new Set(['unconfigured', 'disconnected', 'connecting', 'needs_signin',
  'needs_local_token', 'ready', 'error']);

function createHermesHub(deps = {}) {
  const remote = deps.remote || createHermesRemote();
  const createWire = deps.createWire || (({ input, output }) => new HermesSessionWire({ input, output }));
  const createController = deps.createController || (({ wire, identity }) => new HermesConversation({ wire, identity }));
  const notify = typeof deps.notify === 'function' ? deps.notify : () => {};
  const persist = typeof deps.persist === 'function' ? deps.persist : () => {};

  const hub = new EventEmitter();
  const state = {
    status: 'unconfigured', error: null,
    base: null, profile: '',
    authRequired: null, authFlows: [], providers: [],
    principal: null,                    // {userId, provider} — display only
    tokens: null,                       // private; never projected
    localToken: '',                     // private; loopback-only credential
    conn: null,                         // {input, output, socket, wire, epoch}
    sessions: [],                       // [{id, key, title, active}]
    storedSessions: [],                 // [{id, title}] — persisted ids, never live identities
    storedSessionsError: null,
    selected: null,                     // {sessionId, sessionKey}
    controllers: new Map(),             // sessionId -> {controller, off}
    uncertain: new Map(),               // sessionId -> {sessionKey,text,at,outcome,reason}
    generation: 0,
    authSeq: 0,                         // credential epoch — see auth fence below
  };
  let inflightConnect = null;             // {gen, seq, promise, abort} — coalescing guard
  const pendingAuth = new Set();          // AbortControllers of in-flight sign-ins
  let persisted = isPlainObject(deps.load?.()) ? deps.load() : {};
  if (isPlainObject(persisted) && typeof persisted.url === 'string' && persisted.url.trim()) {
    try {
      state.base = remote.normalizeBaseUrl(persisted.url);
      state.profile = asString(persisted.profile, 200);
      state.localToken = asString(persisted.localToken, 4000);
      if (isPlainObject(persisted.tokens) && typeof persisted.tokens.refreshToken === 'string') {
        state.tokens = persisted.tokens;
      }
      if (isPlainObject(persisted.selected)) {
        state.selected = { sessionId: asString(persisted.selected.sessionId, 300), sessionKey: asString(persisted.selected.sessionKey, 300) };
      }
      state.status = 'disconnected';
    } catch { persisted = {}; state.status = 'unconfigured'; }
  }

  function save() {
    persist({
      url: state.base ? `${state.base.origin}${state.base.prefix}` : '',
      profile: state.profile,
      localToken: state.localToken,
      tokens: state.tokens,
      selected: state.selected,
    });
  }
  const changed = () => { notify(); };

  // ── auth fence ────────────────────────────────────────────────────────────
  // generation guards the connection (bumped by every teardown); authSeq
  // guards credentials — bumped when a sign-in attempt starts and by any
  // command that invalidates pending auth (configure, disconnect, sign-out,
  // dispose). An async credential result is applied only while BOTH still
  // match the snapshot taken before the await, so a late old operation can
  // never persist tokens, mint a principal, or feed the next endpoint under a
  // newer target/identity — and can never tear the newer state down.
  const sameTarget = (a, b) => !!a && !!b && a.origin === b.origin && a.prefix === b.prefix;
  const authCurrent = (fence) =>
    state.authSeq === fence.seq && sameTarget(state.base, fence.base) && state.profile === fence.profile;
  const staleAuth = () => new HubError('stale', 'Authentication attempt superseded.');

  // Every credential-epoch invalidation cancels the backend work it fences
  // out: the result was already barred from state at the next fence, so this
  // only releases hung requests/sockets NOW — at the point of invalidation —
  // instead of letting them die by request timeout. A superseded attempt
  // settles promptly and reports 'stale'.
  function cancelPendingAuth() {
    try { inflightConnect?.abort?.(); } catch {}
    for (const ctl of pendingAuth) { try { ctl.abort(new RemoteError('aborted', 'Authentication attempt superseded.')); } catch {} }
  }
  function invalidateAuth() {
    state.authSeq++;
    cancelPendingAuth();
  }

  function setStatus(status, error = null) {
    if (!STATUS.has(status)) throw new HubError('bad_status', `unknown status ${status}`);
    state.status = status;
    state.error = error ? { code: error.code || 'error', message: String(error.message || error).slice(0, 500) } : null;
    changed();
  }

  function teardownConnection(reason = '') {
    state.generation++;
    // A send that never reached a terminal outcome survives teardown as a
    // durable tombstone: the row may have reached the backend, and nothing may
    // silently replay or silently forget it.
    for (const [sid, entry] of state.controllers) {
      try {
        const send = entry.controller.getState?.()?.lastSend;
        if (send && (send.outcome === 'inflight' || send.outcome === 'uncertain')) {
          state.uncertain.set(sid, {
            sessionId: sid,
            sessionKey: typeof send.target?.sessionKey === 'string' ? send.target.sessionKey : '',
            text: String(send.text || '').slice(0, 2000),
            at: send.at || new Date().toISOString(),
            outcome: send.outcome,
            reason,
          });
        }
      } catch {}
    }
    for (const entry of state.controllers.values()) {
      try { entry.off(); } catch {}
      try { entry.controller.dispose(); } catch {}
    }
    state.controllers.clear();
    if (state.conn) {
      // Detach BEFORE disposing: wire.dispose() emits 'close' synchronously,
      // and a wire we retire ourselves must re-enter the close handler as an
      // already-orphaned socket — never as a pipe that died on its own.
      const conn = state.conn;
      state.conn = null;
      try { conn.wire.dispose?.(); } catch {}
      try { conn.socket?.close?.(); } catch {}
    }
    state.sessions = [];
    state.storedSessions = []; state.storedSessionsError = null;
    if (reason) state.error = { code: 'disconnected', message: reason };
  }

  async function probe(signal) {
    if (!state.base) throw new HubError('unconfigured', 'Configure a Hermes backend first.');
    // Fetch first, apply only if the connection epoch is unchanged — a probe
    // answered after a target move must not stamp the old backend's auth
    // surface onto the new target's state.
    const gen = state.generation;
    const base = state.base;
    const report = await remote.probe(`${base.origin}${base.prefix}`, { signal });
    let providers = [];
    if (report.authRequired) {
      try { providers = await remote.providers(base, { signal }); }
      catch { providers = report.authProviders.map((name) => ({ name })); }
    }
    if (state.generation !== gen) throw new HubError('stale', 'connection superseded');
    state.authRequired = report.authRequired;
    state.authFlows = report.authFlows;
    state.providers = providers;
    return report;
  }

  async function establish(signal) {
    // Probe → credential → ticket → socket → wire. Every awaited step is fenced
    // by generation so a concurrent disconnect/config change can't leak a
    // half-connected wire into the new generation.
    const gen = state.generation, seq = state.authSeq;
    const report = await probe(signal);
    const alive = () => state.generation === gen && state.authSeq === seq;
    if (!alive()) throw new HubError('stale', 'connection superseded');
    // Snapshot the target once the fence passed: every credential request
    // below pairs with this exact backend, never a re-pointed one.
    const base = state.base;
    let credential;
    if (state.authRequired) {
      if (!state.tokens?.refreshToken) {
        state.status = 'needs_signin'; changed();
        throw new HubError('needs_signin', 'Sign in to this backend first.');
      }
      const tokens = await remote.refresh({ base, refreshToken: state.tokens.refreshToken, provider: state.tokens.provider, signal });
      if (!alive()) throw new HubError('stale', 'connection superseded');
      state.tokens = tokens;
      state.principal = { userId: tokens.userId, provider: tokens.provider };
      save();
      const { ticket } = await remote.wsTicket({ base, accessToken: tokens.accessToken, signal });
      credential = { ticket };
    } else {
      if (!state.localToken) {
        state.status = 'needs_local_token'; changed();
        throw new HubError('needs_local_token',
          'This backend reports loopback (unauthenticated) mode. It was launched without an auth gate; enter the per-launch session token (HERMES_DASHBOARD_SESSION_TOKEN) for this backend, or start the backend with authentication.');
      }
      state.principal = { userId: 'local', provider: 'loopback' };
      credential = { localToken: state.localToken };
    }
    if (!alive()) throw new HubError('stale', 'connection superseded');
    const url = remote.wsUrl({ base, ...credential });
    const conn = await remote.connectSocket({ url, signal });
    if (!alive()) { try { conn.socket?.close?.(); } catch {} throw new HubError('stale', 'connection superseded'); }
    const wire = createWire({ input: conn.input, output: conn.output });
    state.conn = { ...conn, wire, epoch: null, gen, seq };
    wire.on('event', (e) => {
      if (e && e.type === 'gateway.ready' && isPlainObject(e.payload) && typeof e.payload.replay_epoch === 'string') {
        // Stamp only the conn this wire adopted — a superseded socket's late
        // hello must not write a stale replay_epoch onto a newer connection.
        if (state.conn && state.conn.wire === wire) state.conn.epoch = e.payload.replay_epoch;
      }
    });
    wire.on('close', (info) => {
      // Wire identity is the only fence needed: a retired conn is detached
      // from state.conn BEFORE its wire is disposed, so a late close on a
      // superseded socket always sees null or a different wire here. Whatever
      // still IS state.conn is the live pipe — its death is always real and
      // must surface, even when a same-target configure or a pending sign-in
      // bumped the credential epoch without replacing the socket.
      if (!state.conn || state.conn.wire !== wire) return;
      teardownConnection(`Connection closed (${info?.state || 'ended'})`);
      setStatus('error', new HubError('disconnected', state.error?.message || 'Connection closed'));
    });
    // Readiness is the conversation gateway's own hello, not /api/status:
    // gateway_running there tracks the separate messaging gateway, which a
    // serve backend legitimately reports as down.
    await new Promise((resolve, reject) => {
      const done = () => { clearTimeout(timer); wire.removeListener('event', onEvent); wire.removeListener('close', onClose); };
      const onEvent = (e) => { if (e && e.type === 'gateway.ready') { done(); resolve(); } };
      const onClose = (info) => {
        done();
        reject(new HubError('gateway_down', `Connection closed before gateway.ready (${info?.state || 'ended'}).`));
      };
      const timer = setTimeout(() => {
        done();
        reject(new HubError('gateway_down', 'Backend accepted the socket but its conversation gateway did not say gateway.ready.'));
      }, 15000);
      wire.on('event', onEvent);
      wire.on('close', onClose);
    });
    if (!alive()) throw new HubError('stale', 'connection superseded');
    return report;
  }

  async function refreshSessions() {
    if (!state.conn?.wire || state.conn.wire.state !== 'open') return;
    const gen = state.generation, conn = state.conn;
    const profile = state.profile ? { profile: state.profile } : {};
    const rows = await conn.wire.call('session.active_list', profile);
    if (state.generation !== gen || state.conn !== conn) return;
    const list = isPlainObject(rows) && Array.isArray(rows.sessions) ? rows.sessions : [];
    state.sessions = list.slice(0, MAX_SESSIONS).filter((r) => isPlainObject(r) && typeof r.id === 'string')
      .map((r) => ({
        id: r.id, key: typeof r.session_key === 'string' ? r.session_key : '',
        title: asString(r.title || r.name || r.session_key || r.id, 200),
        active: true,
      }));
    // active_list is process-local and empties on a backend restart. The
    // separate DB listing survives it; its ids must never be bound as live.
    let stored = [], storedError = null;
    try {
      const result = await conn.wire.call('session.list', { ...profile, limit: MAX_SESSIONS });
      if (!isPlainObject(result) || !Array.isArray(result.sessions)) throw new HubError('contract_drift', 'session.list result drifted');
      stored = result.sessions;
    } catch {
      storedError = 'Saved conversations could not be loaded. Use Refresh conversations to try again.';
    }
    if (state.generation !== gen || state.conn !== conn) return;
    const liveKeys = new Set(state.sessions.map(s => s.key));
    const seen = new Set();
    state.storedSessions = stored.slice(0, MAX_SESSIONS)
      .filter(r => isPlainObject(r) && typeof r.id === 'string' && r.id && r.id.length <= 300
        && !liveKeys.has(r.id) && !seen.has(r.id) && seen.add(r.id))
      .map(r => ({ id: r.id, title: asString(r.title || r.id, 200) }));
    state.storedSessionsError = storedError;
    changed();
  }

  function controllerFor(sessionId) {
    const entry = state.controllers.get(sessionId);
    if (!entry) throw new HubError('not_selected', 'No bound conversation for that session.');
    return entry.controller;
  }

  // ── command surface (the ONLY methods IPC may reach) ──────────────────────
  const commands = {
    // Configure or re-point at a backend. URL/profile changes retire the
    // connection context and its stored credentials.
    async 'configure'(v) {
      invalidateAuth(); // any reconfigure invalidates pending credential work
      const url = asString(v.url, 2000);
      const profile = asString(v.profile, 200);
      const next = remote.normalizeBaseUrl(url);
      const moved = state.base && (state.base.origin !== next.origin || state.base.prefix !== next.prefix || state.profile !== profile);
      if (moved) { teardownConnection('Backend changed.'); state.tokens = null; state.principal = null; state.localToken = ''; state.uncertain.clear(); }
      state.base = next; state.profile = profile;
      if (typeof v.localToken === 'string') state.localToken = v.localToken.slice(0, 4000);
      state.selected = null;
      save();
      setStatus('disconnected');
      return { ok: true };
    },

    async 'probe'() { await probe(); return { ok: true, authRequired: state.authRequired }; },

    async 'sign-in'(v) {
      if (!state.base) throw new HubError('unconfigured', 'Configure a backend first.');
      const provider = asString(v.provider, 200) || state.providers.find((p) => p.supports_password)?.name || '';
      if (!provider) throw new HubError('no_password_provider', 'This backend offers no username/password sign-in. Use its own sign-in (e.g. browser OAuth) is not supported by this surface.');
      // This attempt supersedes every older pending sign-in; the fence is
      // checked BEFORE the minted tokens may mutate state, persist, or feed
      // the refresh/ticket chain of a possibly different target. The bump
      // also cancels whatever older credential work is still in flight.
      invalidateAuth();
      const fence = { seq: state.authSeq, base: state.base, profile: state.profile };
      const ctl = new AbortController();
      pendingAuth.add(ctl);
      setStatus('needs_signin');
      let tokens;
      try {
        tokens = await remote.signIn({
          base: fence.base, provider,
          username: asString(v.username, 1000), password: asString(v.password, 1000),
          signal: ctl.signal,
        });
      } catch (e) {
        // An aborted/superseded sign-in reports 'stale' regardless of which
        // transport error the cancellation surfaced as.
        if (!authCurrent(fence)) throw staleAuth();
        const error = e.code === 'auth_failed' && /^POST \/auth\/password-login: Invalid credentials\.?$/i.test(e.message)
          ? new HubError('auth_failed', 'Wrong username or password.') : e;
        setStatus('needs_signin', error);
        throw error;
      } finally {
        pendingAuth.delete(ctl);
      }
      if (!authCurrent(fence)) throw staleAuth();
      state.tokens = tokens;
      state.principal = { userId: tokens.userId, provider: tokens.provider };
      save(); changed();
      return commands.connect();
    },

    async 'connect'() {
      if (inflightConnect) {
        if (inflightConnect.seq === state.authSeq && inflightConnect.gen === state.generation) {
          throw new HubError('busy', 'Already connecting.');
        }
        // The in-flight connect belongs to a superseded epoch — already fenced
        // out of state at its next await. Cancel the backend work it still
        // holds, then let it unwind in the background: obsolete I/O must
        // never stall this newer authorized attempt.
        cancelPendingAuth();
      }
      // Exactly one authoritative live socket: a conn left over from a prior
      // connect (ready, or superseded mid-flight) is replaced through the
      // normal teardown path — never adopted beside a second socket and
      // orphaned under it.
      if (state.conn) teardownConnection('Reconnecting.');
      const gen = state.generation, seq = state.authSeq;
      const abortCtl = new AbortController();
      const record = {
        gen, seq,
        abort: () => abortCtl.abort(new RemoteError('aborted', 'Connection attempt superseded.')),
      };
      inflightConnect = record;
      record.promise = (async () => {
        try {
          if (state.generation !== gen || state.authSeq !== seq) {
            throw new HubError('stale', 'connection superseded');
          }
          setStatus('connecting');
          await establish(abortCtl.signal);
          // A teardown/re-auth landing between establish and ready must not
          // leave this superseded attempt owning sessions or status.
          if (state.generation !== gen || state.authSeq !== seq) {
            throw new HubError('stale', 'connection superseded');
          }
          await refreshSessions();
          if (state.generation !== gen || state.authSeq !== seq) {
            throw new HubError('stale', 'connection superseded');
          }
          setStatus('ready');
          // Re-bind the persisted selection if it is still live.
          if (state.selected && state.sessions.some((s) => s.id === state.selected.sessionId)) {
            await commands.select(state.selected);
          }
          return { ok: true };
        } catch (e) {
          // A superseded attempt never touches state and always reports
          // 'stale': whoever bumped the connection/credential epoch owns
          // status, identity and the wire now — including the transport
          // error its own cancellation surfaced as.
          if (state.generation !== gen || state.authSeq !== seq) {
            throw (e instanceof HubError && e.code === 'stale') ? e
              : new HubError('stale', 'connection superseded');
          }
          if (e instanceof HubError && e.code === 'stale') throw e;
          if (e instanceof HubError && (e.code === 'needs_signin' || e.code === 'needs_local_token')) throw e;
          if (e instanceof RemoteError && e.code === 'session_expired') {
            state.tokens = null; state.principal = null; save();
            setStatus('needs_signin', e);
            throw new HubError('needs_signin', e.message);
          }
          teardownConnection(String(e && e.message || e));
          setStatus('error', e);
          throw e;
        } finally {
          if (inflightConnect === record) inflightConnect = null;
        }
      })();
      // A superseded connect unwinds unobserved; never let its late rejection
      // become an unhandled rejection in the host process.
      record.promise.catch(() => {});
      return record.promise;
    },

    async 'disconnect'() {
      invalidateAuth();
      teardownConnection('Disconnected.');
      state.principal = null;
      setStatus('disconnected');
      return { ok: true };
    },

    async 'sign-out'() {
      invalidateAuth();
      teardownConnection('Signed out.');
      state.tokens = null; state.principal = null; state.selected = null;
      save();
      setStatus(state.base ? 'disconnected' : 'unconfigured');
      return { ok: true };
    },

    async 'refresh-sessions'() { await refreshSessions(); return { ok: true }; },

    async 'resume-session'(v) {
      if (!Number.isSafeInteger(v.generation) || v.generation !== state.generation) {
        throw new HubError('stale_generation', 'The connection changed since this control was drawn.');
      }
      const storedId = asString(v.storedSessionId, 300);
      if (!state.storedSessions.some(s => s.id === storedId)) throw new HubError('unknown_session', 'That saved conversation is no longer listed. Refresh conversations.');
      if (!state.conn?.wire || state.conn.wire.state !== 'open') throw new HubError('disconnected', 'Connect first.');
      const gen = state.generation, conn = state.conn;
      // Lazy resume loads history without building an agent or sending a
      // prompt. Only an explicit later Send can continue the conversation.
      const resumed = await conn.wire.call('session.resume', { session_id: storedId,
        ...(state.profile ? { profile: state.profile } : {}), lazy: true, inline_images: false });
      if (state.generation !== gen || state.conn !== conn) throw new HubError('stale', 'connection changed during resume');
      const id = asString(resumed?.session_id, 300), key = asString(resumed?.session_key, 300);
      await refreshSessions();
      if (state.generation !== gen || state.conn !== conn) throw new HubError('stale', 'connection changed during resume');
      const live = state.sessions.find(s => s.id === id && s.key === key);
      if (!id || !key || !live) throw new HubError('identity_mismatch', 'Resumed conversation is not in the backend live list. Refresh conversations.');
      return commands.select({ sessionId: id, sessionKey: key });
    },

    // Creating mints a NEW live session. Saved history uses resume-session
    // above and must acquire a verified live identity before selection too.
    async 'new-session'() {
      if (!state.conn?.wire) throw new HubError('disconnected', 'Connect first.');
      const gen = state.generation;
      const created = await state.conn.wire.call('session.create', state.profile ? { profile: state.profile } : {});
      if (state.generation !== gen) throw new HubError('stale', 'connection changed');
      const id = asString(created?.session_id || created?.id, 300);
      if (!id) throw new HubError('contract_drift', 'session.create did not return a session_id', created);
      await refreshSessions();
      // session.create's result has no session_key; the live active_list row
      // does. Binding needs the exact pair — never mint one locally.
      const live = state.sessions.find((s) => s.id === id);
      const key = asString(created?.session_key, 300) || live?.key || '';
      if (!key) throw new HubError('contract_drift', 'new session is not in session.active_list yet', created);
      if (!live) state.sessions.push({ id, key, title: key, active: true });
      return commands.select({ sessionId: id, sessionKey: key });
    },

    async 'select'(v) {
      const sessionId = asString(v.sessionId ?? v.id, 300);
      const row = state.sessions.find((s) => s.id === sessionId);
      if (!row) throw new HubError('unknown_session', 'Session is not live on this gateway.');
      const sessionKey = asString(v.sessionKey, 300) || row.key;
      if (sessionKey && row.key && sessionKey !== row.key) {
        throw new HubError('identity_mismatch', 'session_key does not match the live row');
      }
      const gen = state.generation;
      let entry = state.controllers.get(sessionId);
      if (!entry) {
        const controller = createController({
          wire: state.conn.wire,
          identity: { profile: state.profile || 'default', sessionKey: row.key || sessionKey, sessionId, reviewed: true },
        });
        const off = controller.subscribe(() => changed());
        entry = { controller, off };
        state.controllers.set(sessionId, entry);
      }
      state.selected = { sessionId, sessionKey: row.key || sessionKey };
      save();
      changed();
      if (entry.controller.getState().phase === 'detached') {
        await entry.controller.bind({ expectedEpoch: state.conn.epoch || undefined });
        if (state.generation !== gen) throw new HubError('stale', 'connection changed during bind');
        changed();
      }
      return { ok: true, sessionId };
    },

    // Fence: a control rendered for (session, generation) must not act on a
    // different selection or a reconnect's fresh controllers.
    async 'send'(v) {
      const c = fencedController(v);
      await c.setDraft(asString(v.text, 200000));
      try { return { ok: true, result: await c.send() }; }
      finally { changed(); }
    },

    async 'stop'(v) { return { ok: true, result: await fencedController(v).stop() }; },

    async 'answer-request'(v) {
      const c = fencedController(v, true);
      return { ok: true, result: await c.answerRequest(asString(v.requestId, 300), v.result) };
    },

    async 'refuse-request'(v) {
      const c = fencedController(v, true);
      return {
        ok: true,
        result: await c.refuseRequest(asString(v.requestId, 300), {
          code: Number.isInteger(v.code) ? v.code : -32601,
          message: asString(v.message, 500) || 'declined in companion app',
        }),
      };
    },

    async 'acknowledge-review'(v) {
      return { ok: true, result: fencedController(v, true).acknowledgeReview() };
    },

    async 'set-draft'(v) {
      const c = selectedController();
      c.setDraft(asString(v.text, 200000));
      return { ok: true };
    },

    // Acknowledge a delivery-unconfirmed tombstone after reviewing it. It can
    // only clear the tombstone of the exact session it names.
    async 'uncertain-dismiss'(v) {
      const sessionId = asString(v.sessionId, 300);
      const tomb = state.uncertain.get(sessionId);
      if (!tomb) throw new HubError('not_found', 'No unconfirmed delivery for that session.');
      if (state.selected && state.selected.sessionId !== sessionId) {
        throw new HubError('stale_session', 'That session is no longer selected.');
      }
      state.uncertain.delete(sessionId);
      changed();
      return { ok: true };
    },
  };

  function selectedController() {
    if (!state.selected) throw new HubError('not_selected', 'Select a session first.');
    return controllerFor(state.selected.sessionId);
  }

  // Commands carrying {sessionId, generation} only reach the controller that
  // was selected when the renderer drew the control.
  function fencedController(v, requireGeneration = false) {
    if ((requireGeneration && !Number.isSafeInteger(v?.generation))
        || (Number.isSafeInteger(v?.generation) && v.generation !== state.generation)) {
      throw new HubError('stale_generation', 'The connection changed since this control was drawn.');
    }
    const expected = asString(v?.sessionId, 300);
    if (expected && expected !== state.selected?.sessionId) {
      throw new HubError('stale_session', 'That session is no longer selected.');
    }
    return selectedController();
  }

  // IPC entry point: name is allowlisted, value must be a plain object.
  async function command(name, value) {
    if (typeof name !== 'string' || !Object.hasOwn(commands, name)) {
      throw new HubError('unknown_command', `Unknown hermes command: ${String(name)}`);
    }
    return commands[name](isPlainObject(value) ? value : {});
  }

  // Bounded display projection — the renderer's ONLY view of the hub.
  function getState() {
    const sel = state.selected;
    const convo = sel && state.controllers.get(sel.sessionId)?.controller;
    return {
      status: state.status,
      error: state.error,
      generation: state.generation,
      target: state.base ? { label: state.base.label, url: `${state.base.origin}${state.base.prefix}`, profile: state.profile } : null,
      authRequired: state.authRequired,
      authFlows: [...state.authFlows],
      providers: state.providers.map((p) => ({ name: p.name, displayName: asString(p.display_name || p.name, 200), password: p.supports_password === true })),
      principal: state.principal,
      sessions: state.sessions.map((s) => ({ ...s, selected: sel?.sessionId === s.id })),
      storedSessions: state.storedSessions.map(s => ({ ...s })),
      storedSessionsError: state.storedSessionsError,
      selected: sel ? { ...sel } : null,
      conversation: convo ? convo.getState() : null,
      uncertain: sel ? state.uncertain.get(sel.sessionId) || null : null,
    };
  }

  function dispose() { invalidateAuth(); teardownConnection('Disposed.'); }

  return { command, getState, dispose, hub };
}

module.exports = { createHermesHub, HubError };
