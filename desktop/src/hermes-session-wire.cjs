'use strict';
// Public newline-delimited JSON-RPC session wire for a stock Hermes TUI gateway
// (`python -m tui_gateway.entry`, documented in the public programmatic-integration
// guide). The caller supplies both owned streams (typically child stdin/stdout).
//
// Scope and honesty rules:
// - Pure transport + correlation. No process spawn, no session semantics, no
//   automatic approval, no hidden retry/replay/reconnect, no cancellation claims.
// - Server→client requests (approval/clarify/sudo/…) are surfaced verbatim with
//   their exact frame id and params.session_id. Only an explicit
//   answerServerRequest()/refuseServerRequest() settles one — a request with no
//   answer simply stays open here; nothing silently consumes or withdraws it.
// - EOF, stream errors, malformed/oversized frames and send timeouts are terminal
//   for the wire: every pending call rejects and every open server request is
//   marked unsettled-dead, so no promise or answer attempt can hang.
// - dispose()/close() ends only the caller-supplied output stream and detaches
//   from the input. No process is signalled and no foreign file handle is closed.
// - All internal timers (call timeouts, send timeouts) are unref'd: a pending
//   call or write never keeps the host process alive. The host owns its own
//   liveness and must hold its own handle if it must outlive pending work.
//
// Runs under Node >= 20 and Electron-as-Node (plain node: builtins only).

const { EventEmitter } = require('node:events');

const DEFAULT_LIMITS = Object.freeze({
  maxFrameBytes: 1024 * 1024,        // one JSON line, either direction
  maxBufferedBytes: 2 * 1024 * 1024, // unparsed inbound accumulation
  maxPendingCalls: 128,
  maxPendingServerRequests: 128,
  defaultTimeoutMs: 30000,
  sendTimeoutMs: 10000,
});

class WireError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.name = 'WireError';
    this.code = code;
    if (extra !== undefined) this.detail = extra;
  }
}

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

// `id` may legitimately be a string, a number, or null on the wire. We only
// correlate string/number ids; null ids are stray by definition for us.
const idKey = (id) => (typeof id === 'string' || typeof id === 'number') ? `${typeof id}:${String(id)}` : null;

// Non-streaming fatal decoder is stateless — safe to share across lines.
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true });

class HermesSessionWire extends EventEmitter {
  constructor({ input, output, idPrefix = 'w', ...limits } = {}) {
    super();
    if (!input || typeof input.on !== 'function' || typeof input.read !== 'function' && typeof input.pipe !== 'function') {
      throw new WireError('bad_input', 'input must be a readable stream');
    }
    if (!output || typeof output.write !== 'function') {
      throw new WireError('bad_output', 'output must be a writable stream');
    }
    const l = { ...DEFAULT_LIMITS, ...limits };
    for (const [k, v] of Object.entries(l)) {
      if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
        throw new WireError('bad_limit', `limit ${k} must be a finite positive number`);
      }
      if (k.startsWith('max') && !Number.isInteger(v)) {
        throw new WireError('bad_limit', `limit ${k} must be an integer`);
      }
    }
    this.limits = l;
    this.input = input;
    this.output = output;
    this.idPrefix = String(idPrefix || 'w');
    this.state = 'open'; // open | closed | eof | failed
    this.failReason = null;
    this._counter = 0;
    this._pending = new Map();            // idKey -> {id, method, resolve, reject, timer, aborted}
    this._serverRequests = new Map();     // idKey -> {id, method, sessionId, params, settled:false}
    this._buf = Buffer.alloc(0);
    this._writeChain = Promise.resolve();
    this._inflightWrites = new Set();
    this._closedEmitted = false;
    this.stats = {
      framesIn: 0, framesOut: 0, bytesIn: 0, bytesOut: 0,
      strayResponses: 0, droppedLines: 0,
    };

    this._onData = (chunk) => this._receive(chunk);
    this._onEnd = () => this._terminate('eof', 'input stream ended');
    this._onInputError = (err) => this._terminate('failed', 'input stream error', err);
    this._onOutputError = (err) => this._terminate('failed', 'output stream error', err);
    input.on('data', this._onData);
    input.once('end', this._onEnd);
    input.once('error', this._onInputError);
    output.once('error', this._onOutputError);
  }

  // ── public state ──────────────────────────────────────────────────────────

  get pendingCalls() {
    return [...this._pending.values()].map((p) => ({ id: p.id, method: p.method, deadlineAt: p.deadlineAt }));
  }

  get pendingServerRequests() {
    return [...this._serverRequests.values()].map((r) => ({
      id: r.id, method: r.method, sessionId: r.sessionId, params: r.params,
    }));
  }

  // ── client → server calls ────────────────────────────────────────────────

  call(method, params, { timeoutMs, signal } = {}) {
    if (typeof method !== 'string' || !method) {
      return Promise.reject(new WireError('bad_method', 'method must be a non-empty string'));
    }
    if (params !== undefined && !isPlainObject(params) && !Array.isArray(params)) {
      return Promise.reject(new WireError('bad_params', 'params must be an object or array'));
    }
    const timeout = timeoutMs === undefined ? this.limits.defaultTimeoutMs : timeoutMs;
    if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) {
      return Promise.reject(new WireError('bad_timeout', 'timeout must be a finite positive number of ms'));
    }
    if (this.state !== 'open') {
      return Promise.reject(this._stateError('call on a wire that is not open'));
    }
    if (signal && signal.aborted) {
      return Promise.reject(new WireError('aborted', 'call aborted before send'));
    }
    if (this._pending.size >= this.limits.maxPendingCalls) {
      return Promise.reject(new WireError('queue_full', 'pending call cap reached'));
    }
    const id = `${this.idPrefix}-${++this._counter}`;
    return new Promise((resolve, reject) => {
      const entry = {
        id, method, resolve, reject,
        deadlineAt: Date.now() + timeout,
        timer: null, signal,
      };
      const settle = (fn, value) => {
        if (entry.timer) clearTimeout(entry.timer);
        if (entry.signal && entry._onAbort) entry.signal.removeEventListener('abort', entry._onAbort);
        this._pending.delete(idKey(id));
        fn(value);
      };
      entry.settle = settle;
      entry.timer = setTimeout(() => {
        settle(reject, new WireError('timeout', `call ${method} timed out after ${timeout}ms`));
      }, timeout);
      if (entry.timer.unref) entry.timer.unref();
      if (signal) {
        entry._onAbort = () => settle(reject, new WireError('aborted', `call ${method} aborted`));
        signal.addEventListener('abort', entry._onAbort, { once: true });
      }
      this._pending.set(idKey(id), entry);
      const frame = params === undefined
        ? { jsonrpc: '2.0', id, method }
        : { jsonrpc: '2.0', id, method, params };
      this._send(frame).catch((err) => {
        if (this._pending.has(idKey(id))) {
          settle(reject, err instanceof WireError ? err : new WireError('send_failed', String(err && err.message || err)));
        }
      });
    });
  }

  // ── server → client request answers ─────────────────────────────────────
  // Both return a Promise resolved when the frame is durably written. The id is
  // removed from the pending set BEFORE the write so an answer can never be
  // sent twice for one question; a failed write fails the wire.

  answerServerRequest(id, result) {
    const rec = this._takeServerRequest(id);
    if (!rec) {
      return Promise.reject(new WireError('unknown_request',
        'no open server request with that exact id', { id }));
    }
    if (result !== undefined && !isPlainObject(result) && !Array.isArray(result) && typeof result !== 'string'
        && typeof result !== 'number' && typeof result !== 'boolean' && result !== null) {
      // JSON can carry these; anything else (functions, symbols, bigint) cannot.
      return Promise.reject(new WireError('bad_result', 'result must be JSON-serializable'));
    }
    return this._send({ jsonrpc: '2.0', id: rec.id, result: result === undefined ? null : result });
  }

  refuseServerRequest(id, { code = -32601, message = 'method not implemented by this client' } = {}) {
    const rec = this._takeServerRequest(id);
    if (!rec) {
      return Promise.reject(new WireError('unknown_request',
        'no open server request with that exact id', { id }));
    }
    return this._send({ jsonrpc: '2.0', id: rec.id, error: { code, message: String(message) } });
  }

  _takeServerRequest(id) {
    const key = idKey(id);
    const rec = key === null ? undefined : this._serverRequests.get(key);
    if (!rec || rec.settled) return undefined;
    rec.settled = true;
    this._serverRequests.delete(key);
    return rec;
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  close() { this._terminate('closed', 'closed by caller'); }
  dispose() { this.close(); }

  _stateError(what) {
    return new WireError(this.state === 'failed' ? 'failed' : this.state,
      `${what}: wire is ${this.state}${this.failReason ? ` (${this.failReason})` : ''}`);
  }

  _terminate(state, reason, err) {
    if (this.state !== 'open') return;
    this.state = state;
    this.failReason = reason;
    // A typed WireError cause (send_timeout, send_failed, …) propagates verbatim
    // to every settlement instead of being masked behind a generic 'failed'.
    const error = state === 'closed'
      ? new WireError('closed', 'wire closed before a reply arrived')
      : state === 'eof'
        ? new WireError('eof', 'input ended before a reply arrived')
        : err instanceof WireError
          ? err
          : new WireError('failed', `${reason}${err && err.message ? `: ${err.message}` : ''}`);
    for (const entry of [...this._pending.values()]) entry.settle(entry.reject, error);
    for (const rec of [...this._serverRequests.values()]) rec.settled = true;
    this._serverRequests.clear();
    for (const settleWrite of [...this._inflightWrites]) settleWrite(error);
    this._inflightWrites.clear();
    this.input.removeListener('data', this._onData);
    this.input.removeListener('end', this._onEnd);
    this.input.removeListener('error', this._onInputError);
    this.output.removeListener('error', this._onOutputError);
    if (state === 'closed' && this.output.writable && !this.output.destroyed) {
      try { this.output.end(); } catch { /* ending a supplied writable is best-effort */ }
    }
    if (!this._closedEmitted) {
      this._closedEmitted = true;
      this.emit('close', { state, reason });
    }
  }

  _fail(reason, err) { this._terminate('failed', reason, err); }

  // ── outbound framing ─────────────────────────────────────────────────────

  _send(frame) {
    const send = () => this._writeFrame(frame);
    this._writeChain = this._writeChain.then(send, send);
    return this._writeChain;
  }

  _writeFrame(frame) {
    return new Promise((resolve, reject) => {
      if (this.state !== 'open') {
        reject(this._stateError('send on a wire that is not open'));
        return;
      }
      let line;
      try {
        line = JSON.stringify(frame) + '\n';
      } catch (e) {
        reject(new WireError('unserializable', `frame is not JSON-serializable: ${e.message}`));
        return;
      }
      const bytes = Buffer.byteLength(line, 'utf8');
      if (bytes > this.limits.maxFrameBytes) {
        reject(new WireError('oversized_out', `outgoing frame is ${bytes}B > ${this.limits.maxFrameBytes}B`));
        return;
      }
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this._inflightWrites.delete(finish);
        if (err) {
          reject(err instanceof WireError ? err
            : new WireError('send_failed', `write failed: ${err.message || err}`));
        } else {
          this.stats.framesOut += 1;
          this.stats.bytesOut += bytes;
          resolve();
        }
      };
      const timer = setTimeout(() => {
        const err = new WireError('send_timeout', `write not flushed within ${this.limits.sendTimeoutMs}ms`);
        this._fail('send timeout', err);
        finish(err);
      }, this.limits.sendTimeoutMs);
      if (timer.unref) timer.unref();
      this._inflightWrites.add(finish);
      try {
        this.output.write(line, 'utf8', (err) => {
          if (err) {
            const werr = new WireError('send_failed', `write failed: ${err.message || err}`);
            this._fail('output write failed', werr);
            finish(werr);
          } else {
            finish(null);
          }
        });
      } catch (e) {
        const werr = new WireError('send_failed', `write threw: ${e.message || e}`);
        this._fail('output write threw', werr);
        finish(werr);
      }
    });
  }

  // ── inbound framing ──────────────────────────────────────────────────────

  _receive(chunk) {
    if (this.state !== 'open') return;
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.stats.bytesIn += buf.length;
    this._buf = Buffer.concat([this._buf, buf]);
    if (this._buf.length > this.limits.maxBufferedBytes) {
      this._fail(`inbound buffer exceeded ${this.limits.maxBufferedBytes}B without a newline`);
      return;
    }
    for (;;) {
      const nl = this._buf.indexOf(0x0a);
      if (nl < 0) return;
      const line = this._buf.subarray(0, nl);
      this._buf = this._buf.subarray(nl + 1);
      if (line.length > this.limits.maxFrameBytes) {
        this._fail(`inbound frame exceeded ${this.limits.maxFrameBytes}B`);
        return;
      }
      if (line.length === 0) continue;
      this._handleLine(line);
      if (this.state !== 'open') return;
    }
  }

  _handleLine(line) {
    let text;
    try {
      // strict UTF-8: fatal decode rejects lone surrogates/invalid bytes
      text = STRICT_UTF8.decode(line);
    } catch {
      this.stats.droppedLines += 1;
      this._fail('inbound frame is not valid UTF-8');
      return;
    }
    let frame;
    try {
      frame = JSON.parse(text);
    } catch {
      this.stats.droppedLines += 1;
      this._fail('inbound line is not valid JSON');
      return;
    }
    this._handleFrame(frame, text);
  }

  _handleFrame(frame, raw) {
    if (!isPlainObject(frame)) { this._fail('inbound frame is not a JSON object'); return; }
    if (frame.jsonrpc !== '2.0') { this._fail('inbound frame jsonrpc is not "2.0"'); return; }
    const hasMethod = typeof frame.method === 'string';
    const hasId = Object.prototype.hasOwnProperty.call(frame, 'id');
    const hasResult = Object.prototype.hasOwnProperty.call(frame, 'result');
    const hasError = Object.prototype.hasOwnProperty.call(frame, 'error');
    if (hasMethod && (hasResult || hasError)) { this._fail('ambiguous frame: method with result/error'); return; }
    this.stats.framesIn += 1;
    if (hasMethod && hasId) { this._onServerRequest(frame, raw); return; }
    if (hasMethod) { this._onNotification(frame, raw); return; }
    if (hasId && (hasResult || hasError)) { this._onResponse(frame); return; }
    this._fail('inbound frame is neither request, notification nor response');
  }

  _onNotification(frame, raw) {
    const params = frame.params;
    if (params !== undefined && !isPlainObject(params) && !Array.isArray(params)) {
      this._fail('notification params are not an object/array');
      return;
    }
    this.emit('notification', { method: frame.method, params, raw });
    if (frame.method === 'event' && isPlainObject(params)) {
      const evt = { type: params.type, sessionId: params.session_id, seq: params.seq, payload: params.payload, raw };
      if (evt.type === 'request.cancel' && isPlainObject(evt.payload) && evt.payload.id !== undefined) {
        this._withdrawServerRequest(evt.payload.id, evt.payload);
      }
      this.emit('event', evt);
    }
  }

  _onServerRequest(frame, raw) {
    const key = idKey(frame.id);
    if (key === null) { this._fail('server request id is not a string or number'); return; }
    if (this._serverRequests.has(key) || this._pending.has(key)) {
      this._fail('duplicate inbound frame id');
      return;
    }
    if (this._serverRequests.size >= this.limits.maxPendingServerRequests) {
      this._fail(`open server requests exceeded ${this.limits.maxPendingServerRequests}`);
      return;
    }
    const params = isPlainObject(frame.params) ? frame.params : (frame.params === undefined ? {} : null);
    if (params === null) { this._fail('server request params are not an object'); return; }
    const rec = {
      id: frame.id, method: frame.method,
      sessionId: params.session_id,
      params, raw, settled: false, receivedAt: Date.now(),
    };
    this._serverRequests.set(key, rec);
    this.emit('serverRequest', {
      id: rec.id, method: rec.method, sessionId: rec.sessionId, params: rec.params, raw,
    });
  }

  _withdrawServerRequest(id, payload) {
    const key = idKey(id);
    const rec = key === null ? undefined : this._serverRequests.get(key);
    if (rec && !rec.settled) {
      rec.settled = true;
      this._serverRequests.delete(key);
      this.emit('serverRequestWithdrawn', { id: rec.id, method: rec.method, sessionId: rec.sessionId, cancel: payload });
    }
  }

  _onResponse(frame) {
    const key = idKey(frame.id);
    const entry = key === null ? undefined : this._pending.get(key);
    if (!entry) {
      this.stats.strayResponses += 1;
      this.emit('strayResponse', { id: frame.id, hasError: Object.prototype.hasOwnProperty.call(frame, 'error') });
      return;
    }
    if (Object.prototype.hasOwnProperty.call(frame, 'error')) {
      const e = isPlainObject(frame.error) ? frame.error : {};
      entry.settle(entry.reject, new WireError('remote_error',
        `remote error ${e.code}: ${e.message}`, { code: e.code }));
    } else {
      entry.settle(entry.resolve, frame.result);
    }
  }
}

module.exports = { HermesSessionWire, WireError, DEFAULT_LIMITS };
