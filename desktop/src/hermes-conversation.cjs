'use strict';
// Session-bound conversation controller over a caller-supplied public
// HermesSessionWire (desktop/src/hermes-session-wire.cjs — newline JSON-RPC to a
// stock `python -m tui_gateway.entry` peer). Headless state/action layer only:
// no process launch, no session discovery, no UI, no reconnect or durability.
//
// Binding model:
// - The caller supplies the wire AND an explicit, immutable, caller-reviewed
//   identity: { profile, sessionKey, sessionId, reviewed: true }. `profile` is a
//   caller label, never server attestation. `sessionId` is the process-local
//   live runtime id; `sessionKey` is the stored session key. Identity is never
//   inferred from traffic and never re-resolved after construction.
// - bind() negotiates on the supplied wire only: replay epoch (gateway.ready or
//   the caller-supplied expectedEpoch, verified against session.events.since),
//   gateway.capabilities, client.capabilities {server_requests:true}, an exact
//   session.active_list row match, then session.activate whose session_id /
//   session_key must equal the bound identity. Any drift fails closed.
// - Only events and server→client requests carrying the exact bound session_id
//   are applied. Foreign-session traffic never enters controller state; a
//   request whose session_id is missing or not a string is unattributable and
//   can never be answered through this controller. A second isolated gateway
//   is never treated as attachment to an existing cloud conversation.
//
// Honesty rules:
// - Text is preserved literally (no trimming/transform, markup-looking text
//   stays verbatim). prompt.submit results are admitted once; a wire-level
//   failure mid-submit is reported as 'uncertain' and is NEVER silently
//   replayed — an explicit caller resend is required.
// - stop() issues the public session.interrupt RPC for the bound session only.
//   It reports the RPC result; the turn is not claimed stopped until a terminal
//   session event (message.complete) actually ends it.
// - Server→client requests are answered or refused only by exact id through
//   answerRequest()/refuseRequest() — single-use, schema-verified for the
//   request kinds this layer understands (clarify, approval, single-value
//   prompts). Unknown kinds stay pending and unsupported: they are never
//   auto-answered and never executed. Withdrawn requests surface as outcomes.
// - Every internal bound is finite; overflow sets honest truncation counters
//   rather than dropping silently. durableAdmission is always false.
// - dispose() detaches only this controller's listeners; the caller-owned wire
//   and any other session's controller on it are untouched.
//
// Runs under Node >= 20 and Electron-as-Node (plain node: builtins only).

const { EventEmitter } = require('node:events');

const DEFAULT_LIMITS = Object.freeze({
  maxTranscriptEntries: 512,     // user/assistant/note rows retained
  maxStreamedChars: 262144,      // per-turn streamed text (and reasoning) chars
  maxDraftChars: 65536,
  maxPendingRequests: 64,        // surfaced for THIS session (+ unattributed)
  maxRequestOutcomes: 64,
  maxErrors: 32,
  maxInterimEntries: 32,
  maxToolsPerTurn: 128,
  bindTimeoutMs: 30000,
});

// Phases: detached → binding → bound | review | blocked | disconnected → disposed
//   bound        — verified identity + epoch; send/stop/answer allowed
//   review       — bound but replay/history proved incomplete; read-only until
//                  the caller reviews (sends and answers are disabled)
//   blocked      — live contract drift (epoch change, identity/reclaim loss)
//   disconnected — wire closed/eof/failed while bound (terminal for binding)
//   disposed     — caller detached this controller's subscriptions

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const idKey = (id) => (typeof id === 'string' || typeof id === 'number') ? `${typeof id}:${String(id)}` : null;

class ConversationError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.name = 'ConversationError';
    this.code = code;
    if (extra !== undefined) this.detail = extra;
  }
}

// Request kinds this layer can validate answers for. Everything else stays
// pending and answerable only by refusal — never auto-executed.
const ANSWER_SHAPES = Object.freeze({
  clarify: 'clarify',
  approval: 'approval',
  sudo: 'value', secret: 'value',
  'vault.code': 'value', 'vault.unlock_prompt': 'value', 'vault.save_login': 'value',
  'terminal.read': 'value', 'preview.read': 'value', 'window.read': 'value',
  'preview.act': 'value', tour: 'value',
});
const APPROVAL_CHOICES = new Set(['once', 'session', 'always', 'deny']);

// prompt.submit outcomes that mean the text was definitely NOT admitted.
const DEFINITE_REJECT = new Set(['bad_method', 'bad_params', 'bad_timeout', 'queue_full',
  'remote_error', 'oversized_out', 'unserializable']);

function deepFreeze(v, seen = new Set()) {
  if (typeof v !== 'object' || v === null || seen.has(v)) return v;
  seen.add(v);
  for (const k of Object.keys(v)) deepFreeze(v[k], seen);
  return Object.freeze(v);
}

class HermesConversation extends EventEmitter {
  constructor({ wire, identity, ...limits } = {}) {
    super();
    if (!wire || typeof wire.call !== 'function' || typeof wire.on !== 'function'
        || typeof wire.removeListener !== 'function'
        || typeof wire.answerServerRequest !== 'function'
        || typeof wire.refuseServerRequest !== 'function') {
      throw new ConversationError('bad_wire', 'wire must be a HermesSessionWire-compatible transport');
    }
    if (!isPlainObject(identity) || identity.reviewed !== true
        || ['profile', 'sessionKey', 'sessionId'].some(
          (k) => typeof identity[k] !== 'string' || !identity[k] || identity[k] !== identity[k].trim())) {
      throw new ConversationError('bad_identity',
        'explicit reviewed identity required: {profile, sessionKey, sessionId, reviewed:true}');
    }
    const l = { ...DEFAULT_LIMITS, ...limits };
    for (const [k, v] of Object.entries(l)) {
      if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
        throw new ConversationError('bad_limit', `limit ${k} must be a finite positive number`);
      }
      if (k.startsWith('max') && !Number.isInteger(v)) {
        throw new ConversationError('bad_limit', `limit ${k} must be an integer`);
      }
    }
    this.limits = l;
    this.wire = wire;
    this.identity = deepFreeze({
      profile: identity.profile,      // caller label — NOT server attestation
      sessionKey: identity.sessionKey,
      sessionId: identity.sessionId,
    });

    this._s = {
      phase: 'detached',
      attested: null,             // server-observed identity/capability facts
      connectivity: wire.state || 'unknown',
      transcript: [], transcriptDropped: 0,
      turn: null,
      draft: { text: '', updatedAt: null },
      lastSend: null,             // {text, outcome:'admitted'|'rejected'|'uncertain', ...}
      lastInterrupt: null,
      errors: [],
      pending: new Map(),         // idKey -> request record (ours or unattributed)
      outcomes: [],
      truncated: { transcript: false, replay: false },
      epochChanged: false, needsReview: false, reclaimed: false,
      statusLine: null, sessionInfo: null,
      lastSeq: 0,
      stats: { foreignEvents: 0, foreignRequests: 0, duplicateEvents: 0, eventGaps: 0, droppedRequests: 0 },
      durableAdmission: false,
    };
    this._sendInFlight = false;
    this._disposed = false;
    this._bindingEpoch = null;      // epoch observed while binding, before attested exists

    this._onEvent = (e) => this._handleWireEvent(e);
    this._onServerRequest = (r) => this._handleServerRequest(r);
    this._onWithdrawn = (w) => this._handleWithdrawn(w);
    this._onClose = (info) => this._handleWireClose(info);
    wire.on('event', this._onEvent);
    wire.on('serverRequest', this._onServerRequest);
    wire.on('serverRequestWithdrawn', this._onWithdrawn);
    wire.on('close', this._onClose);
  }

  // ── public state ──────────────────────────────────────────────────────────

  getState() {
    const s = this._s;
    return deepFreeze({
      phase: s.phase,
      ready: s.phase === 'bound' || s.phase === 'review',
      identity: { ...this.identity },
      attested: s.attested ? structuredClone(s.attested) : null,
      connectivity: s.connectivity,
      transcript: structuredClone(s.transcript),
      transcriptDropped: s.transcriptDropped,
      turn: s.turn ? structuredClone(s.turn) : null,
      draft: { ...s.draft },
      lastSend: s.lastSend ? structuredClone(s.lastSend) : null,
      lastInterrupt: s.lastInterrupt ? { ...s.lastInterrupt } : null,
      errors: structuredClone(s.errors),
      pendingRequests: [...s.pending.values()].map((r) => ({
        id: r.id, method: r.method, sessionId: r.sessionId,
        attributed: r.attributed, supported: r.supported, replayed: r.replayed,
        advertised: r.advertised, cancelReason: r.cancelReason ?? null,
        receivedAt: r.receivedAt, params: structuredClone(r.params),
      })),
      requestOutcomes: structuredClone(s.outcomes),
      truncated: { ...s.truncated },
      epochChanged: s.epochChanged, needsReview: s.needsReview, reclaimed: s.reclaimed,
      statusLine: s.statusLine ? { ...s.statusLine } : null,
      sessionInfo: s.sessionInfo ? structuredClone(s.sessionInfo) : null,
      lastSeq: s.lastSeq,
      stats: { ...s.stats },
      durableAdmission: false,
    });
  }

  subscribe(listener) {
    if (typeof listener !== 'function') {
      throw new ConversationError('bad_listener', 'subscribe requires a function');
    }
    const fn = () => listener(this.getState());
    this.on('change', fn);
    return () => this.removeListener('change', fn);
  }

  _changed() { this.emit('change', this.getState()); }

  // ── binding ───────────────────────────────────────────────────────────────

  // Negotiate the bound session on the supplied wire. `expectedEpoch` is the
  // replay epoch the caller already observed on THIS wire's gateway.ready;
  // when omitted, bind waits for a gateway.ready event for bindTimeoutMs.
  async bind({ timeoutMs = this.limits.bindTimeoutMs, expectedEpoch, omitMessages = false } = {}) {
    const s = this._s;
    if (this._disposed || s.phase === 'disposed') throw new ConversationError('disposed', 'controller is disposed');
    if (s.phase !== 'detached') throw new ConversationError('already_bound', `bind() while phase=${s.phase}`);
    if (this.wire.state !== 'open') throw new ConversationError('wire_not_open', `wire is ${this.wire.state}`);
    if (expectedEpoch !== undefined && (typeof expectedEpoch !== 'string' || !expectedEpoch)) {
      throw new ConversationError('bad_epoch', 'expectedEpoch must be a non-empty string');
    }
    s.phase = 'binding';
    this._changed();
    try {
      const epoch = expectedEpoch !== undefined
        ? expectedEpoch
        : await this._waitReady(timeoutMs);
      this._bindingEpoch = epoch;
      if (s.epochChanged) throw new ConversationError('epoch_mismatch', 'gateway.ready epoch changed during bind');

      const caps = await this.wire.call('gateway.capabilities', {});
      if (!isPlainObject(caps) || caps.per_session_exclusive_submit !== true) {
        throw new ConversationError('capability_missing',
          'gateway.capabilities lacks per_session_exclusive_submit:true', caps);
      }
      const adv = await this.wire.call('client.capabilities', { server_requests: true });
      if (!isPlainObject(adv) || !Array.isArray(adv.server_requests)
          || !adv.server_requests.every((m) => typeof m === 'string')) {
        throw new ConversationError('contract_drift', 'client.capabilities server_requests list drifted', adv);
      }

      const rows = await this.wire.call('session.active_list', {});
      const list = isPlainObject(rows) && Array.isArray(rows.sessions) ? rows.sessions : null;
      if (!list || !list.some((r) => isPlainObject(r) && r.id === this.identity.sessionId
          && r.session_key === this.identity.sessionKey)) {
        throw new ConversationError('identity_unavailable',
          'reviewed live session_id + session_key pair not in session.active_list');
      }

      const snap = await this.wire.call('session.activate', {
        session_id: this.identity.sessionId, omit_messages: !!omitMessages,
      });
      if (!isPlainObject(snap) || snap.session_id !== this.identity.sessionId) {
        throw new ConversationError('identity_drift', 'session.activate returned a different session_id');
      }
      if (Object.prototype.hasOwnProperty.call(snap, 'session_key') && snap.session_key != null
          && snap.session_key !== this.identity.sessionKey) {
        throw new ConversationError('identity_drift', 'session.activate returned a different session_key');
      }

      // Replay check: epoch must match this wire's epoch; truncation is honest.
      const replay = await this.wire.call('session.events.since',
        { session_id: this.identity.sessionId, last_seen: 0 });
      if (!isPlainObject(replay) || typeof replay.epoch !== 'string'
          || !Array.isArray(replay.events) || !Array.isArray(replay.open_requests)
          || typeof replay.latest_seq !== 'number') {
        throw new ConversationError('contract_drift', 'session.events.since result drifted', replay);
      }
      if (replay.epoch !== epoch) {
        s.epochChanged = true;
        throw new ConversationError('epoch_mismatch',
          'replay epoch differs from this wire\'s gateway.ready epoch');
      }
      if (replay.truncated === true) {
        // History beyond the ring is provably missing: bind read-only.
        s.truncated.replay = true;
        s.needsReview = true;
      }
      s.lastSeq = Math.max(s.lastSeq, replay.latest_seq);

      s.attested = deepFreeze({
        sessionId: snap.session_id,
        sessionKey: Object.prototype.hasOwnProperty.call(snap, 'session_key') ? snap.session_key : null,
        storedSessionId: snap.stored_session_id ?? null,
        replayEpoch: epoch,
        serverRequestMethods: adv.server_requests.slice(),
        perSessionExclusiveSubmit: true,
        boundAt: new Date().toISOString(),
      });

      if (!omitMessages && Array.isArray(snap.messages)) this._hydrateTranscript(snap.messages);
      if (isPlainObject(snap.inflight)) this._hydrateInflight(snap.inflight);
      for (const r of snap.open_requests || []) this._adoptReplayedRequest(r);
      for (const r of replay.open_requests) this._adoptReplayedRequest(r);

      s.phase = s.needsReview ? 'review' : 'bound';
      this._bindingEpoch = null;
      this._changed();
      return this.getState();
    } catch (e) {
      s.phase = 'blocked';
      this._bindingEpoch = null;
      this._pushError(e instanceof ConversationError ? e.code : 'bind_failed', e.message || String(e));
      this._changed();
      throw e;
    }
  }

  _waitReady(timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new ConversationError('ready_timeout', `gateway.ready not observed within ${timeoutMs}ms`));
      }, timeoutMs);
      if (timer.unref) timer.unref();
      const onEvent = (e) => {
        if (e && e.type === 'gateway.ready' && isPlainObject(e.payload)
            && typeof e.payload.replay_epoch === 'string' && e.payload.replay_epoch) {
          cleanup(); resolve(e.payload.replay_epoch);
        }
      };
      const onClose = (info) => { cleanup(); reject(new ConversationError('wire_closed', `wire closed before gateway.ready: ${info && info.state}`)); };
      const cleanup = () => {
        clearTimeout(timer);
        this.wire.removeListener('event', onEvent);
        this.wire.removeListener('close', onClose);
      };
      this.wire.on('event', onEvent);
      this.wire.once('close', onClose);
    });
  }

  _hydrateTranscript(messages) {
    for (const m of messages) {
      if (!isPlainObject(m) || typeof m.role !== 'string') continue;
      this._pushTranscript({
        kind: 'message', role: m.role, text: m.text !== undefined ? m.text : (m.content ?? null),
        rowId: m.row_id ?? null, timestamp: m.timestamp ?? null,
        displayKind: m.display_kind ?? null, name: m.name ?? null,
        hydrated: true,
      });
    }
  }

  _hydrateInflight(inflight) {
    const s = this._s;
    if (s.turn) return; // a live turn already started via events during binding
    const turn = this._newTurn();
    turn.streaming = inflight.streaming === true;
    turn.user = typeof inflight.user === 'string' ? inflight.user : null;
    turn.startedAt = null;
    turn.fromInflight = true;
    turn.status = inflight.status ?? null;
    turn.error = inflight.error ?? null;
    if (typeof inflight.assistant === 'string' && inflight.assistant) {
      turn.text = inflight.assistant.length > this.limits.maxStreamedChars
        ? (turn.truncated = true, inflight.assistant.slice(0, this.limits.maxStreamedChars))
        : inflight.assistant;
    }
  }

  // ── actions ───────────────────────────────────────────────────────────────

  _requireOperable(what) {
    const s = this._s;
    if (this._disposed || s.phase === 'disposed') {
      throw new ConversationError('disposed', `${what}: controller is disposed`);
    }
    if (s.phase === 'blocked' || s.phase === 'disconnected') {
      throw new ConversationError(s.phase === 'blocked' ? 'blocked' : 'disconnected',
        `${what}: controller is ${s.phase}`);
    }
    if (s.phase === 'review' && what !== 'stop') {
      // Send/answer are disabled while replay/history is proven incomplete.
      // stop() stays allowed: interrupting the bound session is still explicit
      // and attributable even when local history is under review.
      throw new ConversationError('needs_review', `${what}: replay/history proved incomplete; review required`);
    }
    if (s.phase !== 'bound' && !(s.phase === 'review' && what === 'stop')) {
      throw new ConversationError('not_bound', `${what}: controller is ${s.phase}`);
    }
  }

  setDraft(text) {
    if (this._disposed) throw new ConversationError('disposed', 'setDraft: controller is disposed');
    if (typeof text !== 'string') throw new ConversationError('bad_draft', 'draft must be a string');
    if (text.length > this.limits.maxDraftChars) {
      throw new ConversationError('draft_too_large', `draft is ${text.length} chars > ${this.limits.maxDraftChars}`);
    }
    this._s.draft = { text, updatedAt: new Date().toISOString() };
    this._changed();
    return this.getState();
  }

  // Explicit user send. Captures the immutable bound target at call time.
  // `text` omitted sends the current draft. An admitted send clears the draft
  // only when the sent text is exactly the draft (unrelated drafts survive).
  async send(text) {
    const s = this._s;
    this._requireOperable('send');
    const body = text === undefined ? s.draft.text : text;
    if (typeof body !== 'string') throw new ConversationError('bad_text', 'send text must be a string');
    if (body === '') throw new ConversationError('empty_text', 'send text must not be empty');
    if (this._sendInFlight) {
      throw new ConversationError('send_in_flight', 'a prompt.submit is already in flight; no duplicate send');
    }
    this._sendInFlight = true;
    const target = { sessionId: this.identity.sessionId, sessionKey: this.identity.sessionKey };
    const submission = { text: body, target, at: new Date().toISOString() };
    s.lastSend = { ...submission, outcome: 'inflight' };
    // The user row enters the transcript immediately as 'sending' — the user
    // really did submit it. Its status settles to the admitted status, or to
    // 'rejected'/'uncertain' — it is never rewritten into a fake admission.
    const row = this._pushTranscript({ kind: 'message', role: 'user', text: body, status: 'sending',
      admitted: false, at: submission.at });
    this._changed();
    try {
      const result = await this.wire.call('prompt.submit', { session_id: target.sessionId, text: body });
      const status = isPlainObject(result) ? result.status ?? null : null;
      row.status = status || 'admitted';
      row.admitted = true;
      row.rowId = isPlainObject(result) ? result.user_row_id ?? null : null;
      s.lastSend = { ...submission, outcome: 'admitted', status, userRowId: row.rowId };
      if (s.draft.text === body) s.draft = { text: '', updatedAt: new Date().toISOString() };
      // The turn is event-driven (message.start/delta/complete) and may already
      // have streamed and sealed while the call was in flight — never fabricate.
      this._changed();
      return result;
    } catch (e) {
      const code = e && e.code;
      // Wire-level failures mean the submit may already have been written:
      // honest 'uncertain', never silently replayed. Definite rejections keep
      // their exact code.
      const outcome = DEFINITE_REJECT.has(code) ? 'rejected' : 'uncertain';
      row.status = outcome;
      row.error = { code: code || 'unknown', message: String(e && e.message || e) };
      s.lastSend = { ...submission, outcome, error: row.error };
      this._pushError(code || 'send_failed', e && e.message || String(e), 'prompt.submit');
      this._changed();
      throw e;
    } finally {
      this._sendInFlight = false;
    }
  }

  // Public session.interrupt for the captured session. Reports the RPC result;
  // the turn is marked stopped only by a real terminal event, never by this call.
  async stop() {
    const s = this._s;
    this._requireOperable('stop');
    const result = await this.wire.call('session.interrupt', { session_id: this.identity.sessionId });
    const status = isPlainObject(result) ? result.status ?? null : null;
    s.lastInterrupt = { at: new Date().toISOString(), status,
      interrupted: isPlainObject(result) ? result.interrupted ?? null : null };
    if (s.turn) s.turn.stopRequested = true;
    this._changed();
    return result;
  }

  // Single-use explicit answer to a pending server→client request by exact id.
  // The result shape is verified against the request kind's public schema.
  async answerRequest(id, result) {
    this._requireOperable('answerRequest');
    const rec = this._findPending(id);
    if (!rec) throw new ConversationError('unknown_request', 'no pending request with that exact id', { id });
    if (!rec.attributed) {
      throw new ConversationError('ambiguous_request',
        'request params carry no bound-session id; refusing to route an answer', { id });
    }
    const shape = ANSWER_SHAPES[rec.method];
    if (!shape) {
      throw new ConversationError('unsupported_request',
        `no verified answer schema for ${rec.method}; refuseRequest() remains available`, { id });
    }
    // Local validation precedes consumption: a malformed answer must not
    // destroy the question or write a single byte.
    this._validateAnswer(rec, shape, result);
    this._takePending(id);
    try {
      await this.wire.answerServerRequest(rec.id, result);
      this._recordOutcome(rec, 'answered');
      this._changed();
    } catch (e) {
      // Stale/withdrawn at the wire: drop the record, surface the exact code.
      if (e && e.code === 'unknown_request') this._recordOutcome(rec, 'stale');
      else this._restorePending(rec);
      this._changed();
      throw e;
    }
  }

  // Explicit negative response (default JSON-RPC -32601) — visible, never
  // silent, and still single-use at the wire.
  async refuseRequest(id, { code = -32601, message = 'method not implemented by this client' } = {}) {
    this._requireOperable('refuseRequest');
    const rec = this._findPending(id);
    if (!rec) throw new ConversationError('unknown_request', 'no pending request with that exact id', { id });
    if (!rec.attributed) {
      throw new ConversationError('ambiguous_request',
        'request params carry no bound-session id; refusing to route a refusal', { id });
    }
    this._takePending(id);
    try {
      await this.wire.refuseServerRequest(rec.id, { code, message });
      this._recordOutcome(rec, 'refused');
      this._changed();
    } catch (e) {
      if (e && e.code === 'unknown_request') this._recordOutcome(rec, 'stale');
      else this._restorePending(rec);
      this._changed();
      throw e;
    }
  }

  _validateAnswer(rec, shape, result) {
    const bad = (m) => { throw new ConversationError('bad_result', `${rec.method}: ${m}`); };
    if (!isPlainObject(result)) bad('result must be an object');
    if (shape === 'approval') {
      const choice = result.choice;
      if (typeof choice !== 'string' || !APPROVAL_CHOICES.has(choice)) {
        bad('choice must be one of once|session|always|deny');
      }
      const offered = rec.params && Array.isArray(rec.params.choices) ? rec.params.choices : null;
      if (offered && offered.length && !offered.includes(choice)) {
        bad(`choice ${choice} was not offered by this request`, { offered });
      }
      if (result.all !== undefined && result.all !== null && typeof result.all !== 'boolean') {
        bad('all must be a boolean');
      }
      return;
    }
    if (shape === 'clarify') {
      const a = result.answers;
      if (a === undefined || a === null) return;            // {} / {answers:null} = cancel-all
      if (!isPlainObject(a)) bad('answers must be an object keyed by question id, or null');
      const qs = rec.params && Array.isArray(rec.params.questions) ? rec.params.questions : null;
      const qids = qs && qs.every((q) => isPlainObject(q) && typeof q.qid === 'string')
        ? new Set(qs.map((q) => q.qid)) : null;
      for (const [k, v] of Object.entries(a)) {
        if (qids && !qids.has(k)) bad(`answer key ${k} is not a declared question id`, { qids: [...qids] });
        if (v !== null && typeof v !== 'string') bad(`answer ${k} must be a string or null`);
      }
      return;
    }
    if (shape === 'value') {
      if (typeof result.value !== 'string') bad('value must be a string (empty string declines)');
      return;
    }
  }

  // Explicit replay sync on THIS wire only: same-epoch check, honest
  // truncation, ordered application of unseen seqs, open_requests merge.
  async syncFromReplay() {
    const s = this._s;
    this._requireOperable('syncFromReplay');
    const replay = await this.wire.call('session.events.since',
      { session_id: this.identity.sessionId, last_seen: s.lastSeq });
    if (!isPlainObject(replay) || typeof replay.epoch !== 'string'
        || !Array.isArray(replay.events) || !Array.isArray(replay.open_requests)) {
      throw new ConversationError('contract_drift', 'session.events.since result drifted', replay);
    }
    if (replay.epoch !== (s.attested && s.attested.replayEpoch)) {
      s.epochChanged = true;
      s.phase = 'blocked';
      this._pushError('epoch_mismatch', 'replay epoch changed on this wire');
      this._changed();
      throw new ConversationError('epoch_mismatch', 'replay epoch changed on this wire');
    }
    let applied = 0;
    for (const frame of replay.events) {
      if (this._applyEventParams(frame)) applied += 1;
    }
    for (const r of replay.open_requests) this._adoptReplayedRequest(r);
    if (replay.truncated === true) {
      s.truncated.replay = true;
      s.needsReview = true;
      s.phase = 'review';
      this._pushError('replay_truncated', 'replay ring evicted events before our watermark');
    }
    if (typeof replay.latest_seq === 'number') s.lastSeq = Math.max(s.lastSeq, replay.latest_seq);
    this._changed();
    return { applied, openRequests: replay.open_requests.length, truncated: replay.truncated === true };
  }

  // Detach only this controller's subscriptions. The caller-owned wire (and
  // any other session's controller on it) is untouched.
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.wire.removeListener('event', this._onEvent);
    this.wire.removeListener('serverRequest', this._onServerRequest);
    this.wire.removeListener('serverRequestWithdrawn', this._onWithdrawn);
    this.wire.removeListener('close', this._onClose);
    this._s.phase = 'disposed';
    this._changed();
  }

  // ── wire event handling ───────────────────────────────────────────────────

  _handleWireEvent(e) {
    const s = this._s;
    if (this._disposed || !isPlainObject(e)) return;
    if (e.type === 'gateway.ready') {
      const epoch = isPlainObject(e.payload) ? e.payload.replay_epoch : undefined;
      const expected = s.attested ? s.attested.replayEpoch : this._bindingEpoch;
      if (expected && typeof epoch === 'string' && epoch !== expected) {
        s.epochChanged = true;
        if (s.phase !== 'detached') s.phase = 'blocked';
        this._pushError('epoch_mismatch', 'gateway.ready replay_epoch changed mid-observation');
        this._changed();
      }
      return;
    }
    if (typeof e.sessionId !== 'string' || e.sessionId !== this.identity.sessionId) {
      if (e.sessionId !== undefined) s.stats.foreignEvents += 1;
      return; // foreign/session-less events never enter bound state
    }
    if (s.phase === 'detached' || s.phase === 'blocked' || s.phase === 'disconnected') return;
    this._applyEventParams({ type: e.type, session_id: e.sessionId, seq: e.seq, payload: e.payload });
    this._changed();
  }

  // Returns true when the event was applied (used by syncFromReplay).
  _applyEventParams(p) {
    const s = this._s;
    if (!isPlainObject(p) || p.session_id !== this.identity.sessionId) return false;
    if (p.seq !== undefined) {
      if (typeof p.seq !== 'number' || !Number.isInteger(p.seq) || p.seq < 1) {
        this._pushError('contract_drift', `non-integer event seq for bound session: ${JSON.stringify(p.seq)}`);
        return false;
      }
      if (p.seq <= s.lastSeq) { s.stats.duplicateEvents += 1; return false; }
      if (p.seq > s.lastSeq + 1 && s.lastSeq > 0) s.stats.eventGaps += p.seq - s.lastSeq - 1;
      s.lastSeq = p.seq;
    }
    const payload = isPlainObject(p.payload) ? p.payload : {};
    switch (p.type) {
      case 'message.start':
        if (s.turn) {
          // A prior turn that never completed is sealed honestly, not dropped.
          this._pushTranscript({ kind: 'message', role: 'assistant', text: s.turn.text,
            status: 'incomplete', sealedBy: 'message.start', interim: s.turn.interims.length ? s.turn.interims : undefined,
            tools: s.turn.tools.length ? s.turn.tools.map((x) => ({ ...x })) : undefined });
        }
        this._newTurn();
        break;
      case 'message.delta': {
        const t = this._turnOrNew();
        if (typeof payload.text === 'string') t.text = this._appendBounded(t, 'text', payload.text);
        break;
      }
      case 'reasoning.delta': case 'reasoning.available': case 'thinking.delta': {
        const t = this._turnOrNew();
        if (typeof payload.text === 'string') t.reasoning = this._appendBounded(t, 'reasoning', payload.text);
        break;
      }
      case 'message.interim': {
        const t = this._turnOrNew();
        if (t.interims.length < this.limits.maxInterimEntries) {
          t.interims.push({ text: payload.text ?? null, alreadyStreamed: payload.already_streamed === true });
        } else t.truncated = true;
        break;
      }
      case 'tool.start': {
        const t = this._turnOrNew();
        if (t.tools.length < this.limits.maxToolsPerTurn) {
          t.tools.push({ id: payload.tool_id ?? null, name: payload.name ?? null,
            status: 'running', at: new Date().toISOString() });
        } else t.truncated = true;
        break;
      }
      case 'tool.generating': {
        const t = this._turnOrNew();
        t.generating = payload.name ?? null;
        break;
      }
      case 'tool.complete': case 'tool.output_risk': {
        const t = s.turn;
        if (t) {
          const tool = t.tools.find((x) => x.id === (payload.tool_id ?? null));
          if (tool) {
            tool.status = p.type === 'tool.complete' ? 'complete' : 'risk';
            if (typeof payload.summary === 'string') tool.summary = payload.summary;
          }
          if (t.generating === (payload.name ?? null)) t.generating = null;
        }
        break;
      }
      case 'message.complete': {
        const t = s.turn;
        const text = payload.text !== undefined ? payload.text : (t ? t.text : '');
        this._pushTranscript({
          kind: 'message', role: 'assistant', text,
          status: payload.status ?? 'complete',
          partial: payload.partial === true,
          error: payload.error ?? null,
          failureReason: payload.failure_reason ?? null,
          reasoning: t && t.reasoning ? t.reasoning : (payload.reasoning ?? null),
          interim: t && t.interims.length ? t.interims : undefined,
          tools: t && t.tools.length ? t.tools.map((x) => ({ ...x })) : undefined,
          seq: p.seq ?? null,
        });
        s.turn = null;
        break;
      }
      case 'request.cancel':
        // The wire withdraws the request and emits serverRequestWithdrawn; that
        // path removes the pending entry. Here we only forward the reason.
        this._noteOutcomeCancel(payload);
        break;
      case 'session.reclaimed':
        s.reclaimed = true;
        s.phase = 'blocked';
        this._pushError('session_reclaimed', 'the backend reclaimed this session');
        break;
      case 'error':
        this._pushError('session_error', typeof payload.message === 'string' ? payload.message : 'session error event');
        break;
      case 'status.update':
        s.statusLine = { kind: payload.kind ?? null, text: payload.text ?? '' };
        break;
      case 'session.info':
        s.sessionInfo = structuredClone(payload);
        break;
      default:
        break; // unknown session events stay observable through 'event' passthrough
    }
    this.emit('event', { type: p.type, sessionId: p.session_id, seq: p.seq ?? null, payload: p.payload });
    return true;
  }

  _newTurn() {
    this._s.turn = {
      streaming: true, text: '', reasoning: '', interims: [], tools: [],
      user: null, startedAt: new Date().toISOString(), stopRequested: false,
      truncated: false, fromInflight: false, status: null, error: null,
      generating: null,
    };
    return this._s.turn;
  }

  _turnOrNew() { return this._s.turn || this._newTurn(); }

  _appendBounded(turn, field, chunk) {
    const cur = turn[field];
    if (cur.length + chunk.length <= this.limits.maxStreamedChars) return cur + chunk;
    turn.truncated = true;
    return cur + chunk.slice(0, Math.max(0, this.limits.maxStreamedChars - cur.length));
  }

  _pushTranscript(entry) {
    const s = this._s;
    const stored = { at: new Date().toISOString(), ...entry };
    s.transcript.push(stored);
    while (s.transcript.length > this.limits.maxTranscriptEntries) {
      s.transcript.shift();
      s.transcriptDropped += 1;
      s.truncated.transcript = true;
    }
    return stored;
  }

  _pushError(code, message, context) {
    const s = this._s;
    s.errors.push({ code, message, context: context ?? null, at: new Date().toISOString() });
    while (s.errors.length > this.limits.maxErrors) s.errors.shift();
  }

  // ── server→client requests ────────────────────────────────────────────────

  _handleServerRequest(r) {
    const s = this._s;
    if (this._disposed || !isPlainObject(r)) return;
    const sid = r.sessionId;
    if (typeof sid === 'string' && sid !== this.identity.sessionId) {
      s.stats.foreignRequests += 1;
      return; // another session's question — another controller owns it
    }
    const attributed = sid === this.identity.sessionId;
    if (s.pending.size >= this.limits.maxPendingRequests) {
      s.stats.droppedRequests += 1;
      this._pushError('pending_cap', 'pending request cap reached; request left at the wire layer');
      this._changed();
      return;
    }
    const key = idKey(r.id);
    if (key === null || s.pending.has(key)) return;
    const method = r.method;
    s.pending.set(key, {
      id: r.id, method,
      sessionId: typeof sid === 'string' ? sid : null,
      attributed,
      supported: Object.prototype.hasOwnProperty.call(ANSWER_SHAPES, method),
      advertised: s.attested ? s.attested.serverRequestMethods.includes(method) : null,
      replayed: false,
      params: structuredClone(isPlainObject(r.params) ? r.params : {}),
      receivedAt: new Date().toISOString(),
    });
    this._changed();
  }

  _adoptReplayedRequest(r) {
    const s = this._s;
    if (!isPlainObject(r) || idKey(r.id) === null) return;
    const key = idKey(r.id);
    if (s.pending.has(key)) {
      s.pending.get(key).replayed = true;
      return;
    }
    const params = isPlainObject(r.params) ? r.params : {};
    if (params.session_id !== undefined && params.session_id !== this.identity.sessionId) {
      s.stats.foreignRequests += 1;
      return;
    }
    if (s.pending.size >= this.limits.maxPendingRequests) {
      s.stats.droppedRequests += 1;
      this._pushError('pending_cap', 'replayed request dropped: pending cap reached');
      return;
    }
    s.pending.set(key, {
      id: r.id, method: r.method,
      sessionId: typeof params.session_id === 'string' ? params.session_id : this.identity.sessionId,
      attributed: params.session_id === undefined || params.session_id === this.identity.sessionId,
      supported: Object.prototype.hasOwnProperty.call(ANSWER_SHAPES, r.method),
      advertised: s.attested ? s.attested.serverRequestMethods.includes(r.method) : null,
      replayed: true,
      params: structuredClone(params),
      receivedAt: new Date().toISOString(),
    });
  }

  _handleWithdrawn(w) {
    const s = this._s;
    if (this._disposed || !isPlainObject(w)) return;
    const key = idKey(w.id);
    const rec = key === null ? undefined : s.pending.get(key);
    if (rec) {
      s.pending.delete(key);
      rec.outcome = 'withdrawn';
      rec.outcomeAt = new Date().toISOString();
      rec.cancel = isPlainObject(w.cancel) ? structuredClone(w.cancel) : null;
      this._recordOutcome(rec, 'withdrawn');
      this._changed();
    }
  }

  _noteOutcomeCancel(payload) {
    // request.cancel events carry {id, method, reason}; the withdrawal itself
    // arrives via serverRequestWithdrawn. If the wire already consumed it,
    // annotate the existing outcome entry.
    const key = idKey(payload.id);
    const rec = key === null ? undefined : this._s.pending.get(key);
    if (rec) rec.cancelReason = payload.reason ?? null;
  }

  _findPending(id) {
    const key = idKey(id);
    return key === null ? undefined : this._s.pending.get(key);
  }

  _takePending(id) {
    const rec = this._findPending(id);
    if (rec) this._s.pending.delete(idKey(id));
    return rec;
  }

  _restorePending(rec) {
    const key = idKey(rec.id);
    if (key !== null) this._s.pending.set(key, rec);
  }

  _recordOutcome(rec, outcome) {
    const s = this._s;
    s.outcomes.push({ id: rec.id, method: rec.method, sessionId: rec.sessionId,
      outcome, at: new Date().toISOString(),
      cancelReason: rec.cancelReason ?? (rec.cancel && rec.cancel.reason) ?? null });
    while (s.outcomes.length > this.limits.maxRequestOutcomes) s.outcomes.shift();
  }

  // ── wire lifecycle ────────────────────────────────────────────────────────

  _handleWireClose(info) {
    const s = this._s;
    s.connectivity = info && info.state ? info.state : (this.wire.state || 'closed');
    if (this._disposed) return;
    if (s.phase !== 'disposed') s.phase = 'disconnected';
    if (s.lastSend && s.lastSend.outcome === 'inflight') {
      // The RPC may or may not have reached the gateway: stay uncertain.
      s.lastSend.outcome = 'uncertain';
      s.lastSend.error = { code: s.connectivity, message: 'wire ended while prompt.submit was in flight' };
    }
    // Open server→client requests died with the wire (it settled them without
    // an answer). They are surfaced as 'dead' outcomes, not left hanging.
    if (s.pending.size) {
      for (const rec of s.pending.values()) this._recordOutcome(rec, 'dead');
      s.pending.clear();
    }
    this._pushError('wire_' + s.connectivity, 'wire terminated', 'wire');
    this._changed();
  }
}

module.exports = { HermesConversation, ConversationError, DEFAULT_LIMITS };
