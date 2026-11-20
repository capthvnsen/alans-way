'use strict';
// Adapter: gives native chat the `createHermesApi` shape on top of the gateway
// link. Lists, history and forks stay on REST (the `rest` api); a reply runs on
// the link's WebSocket and arrives as the same event names the SSE path emits,
// so native-chat's renderer, cache and run logic do not change.
//
// While the link is not configured at all (no gateway address or sign-in), a
// send falls through to the REST+SSE path, which stays the fallback. While the
// link IS configured but not live, `sendReady()` is false and native chat's send
// queue holds the message until the link is back.
const { ApiError } = require('./hermes-api.cjs');

const RUN_PREFIX = 'ws:';
const GIVE_UP_MS = 120000;
// Link states in which a send waits in native chat's queue; idle and stopped (no gateway) fall through to REST.
const HOLD_STATES = new Set(['connecting', 'reconnecting', 'syncing', 'offline', 'suspended', 'signin', 'refused']);
const str = (v, max = 4000) => typeof v === 'string' ? v.slice(0, max) : '';
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function submitError(e) {
  const code = e && e.code;
  if (code === 'signin') return new ApiError('unauthorized', 'Sign in to Hermes again.');
  if (code === 'remote_error') return new ApiError('http_409', str(e.message, 300).replace(/^remote error -?\d+: /, '') || 'Hermes refused the message.', 409);
  return new ApiError('unreachable', 'The connection to Hermes is not live.');
}

function createGatewayApi({ rest, link, transport = () => 'websocket' }) {
  let runCounter = 0;
  const idOf = (runId) => String(runId).split(':').slice(1, -1).join(':');
  const usable = () => transport() !== 'sse' && !['idle', 'refused', 'stopped'].includes(link.getState().state);

  async function streamChat(sessionId, text, { onEvent = () => {}, signal, clientMessageId } = {}) {
    if (!usable()) return rest.streamChat(sessionId, text, { onEvent, signal, clientMessageId });
    if (signal?.aborted) throw new ApiError('aborted', 'Stopped.');
    const runId = `${RUN_PREFIX}${sessionId}:${++runCounter}`;
    let started = false, finished = false, cleaned = false, giveUp = null;
    const held = [];
    let settle;
    const done = new Promise((resolve, reject) => { settle = { resolve, reject }; });
    const emit = (name, data) => { if (started) onEvent(name, data); else held.push([name, data]); };
    // `finished` stops event handling; `end` settles the stream once.
    const end = (err) => {
      if (cleaned) return;
      cleaned = true; finished = true;
      clearTimeout(giveUp);
      link.removeListener('event', onLinkEvent); link.removeListener('request', onRequest);
      link.removeListener('requestClosed', onClosed); link.removeListener('gap', onGap); link.removeListener('state', onState);
      signal?.removeEventListener('abort', onAbort);
      err ? settle.reject(err) : settle.resolve();
    };
    const onLinkEvent = (e) => {
      if (e.storedId !== sessionId || finished) return;
      const p = isPlainObject(e.payload) ? e.payload : {};
      switch (e.type) {
        case 'message.start': emit('message.started', { message: { id: `ws-${e.seq}` } }); break;
        case 'message.delta': if (typeof p.text === 'string') emit('assistant.delta', { delta: p.text }); break;
        case 'tool.start': emit('tool.started', { tool_name: str(p.name, 80) }); break;
        case 'tool.complete': emit('tool.completed', { tool_name: str(p.name, 80) }); break;
        case 'error': emit('error', { message: str(p.message, 300) }); break;
        case 'message.complete': {
          const status = str(p.status, 40);
          if (typeof p.text === 'string') emit('assistant.completed', { content: p.text });
          emit(['interrupted', 'cancelled'].includes(status) ? 'run.cancelled' : status === 'error' || status === 'failed' ? 'run.failed' : 'run.completed', {});
          if (started) end(); else finished = true;
          break;
        }
        default: break;
      }
    };
    const onRequest = ({ storedId, request }) => {
      if (storedId !== sessionId || finished) return;
      const params = isPlainObject(request.params) ? request.params : {};
      if (request.method === 'approval') {
        emit('approval.request', { request_id: String(request.id), execution_generation: 0, command: str(params.command), description: str(params.description, 500),
          choices: Array.isArray(params.choices) && params.choices.length ? params.choices : ['once', 'session', 'always', 'deny'] });
      } else if (request.method === 'clarify') {
        const q = Array.isArray(params.questions) && isPlainObject(params.questions[0]) ? params.questions[0] : {};
        emit('clarify.request', { prompt_id: String(request.id), question: str(q.question ?? q.text ?? q.prompt ?? params.question), choices: Array.isArray(q.choices) ? q.choices : [] });
      }
    };
    const onClosed = ({ storedId, id }) => { if (storedId === sessionId && !finished) emit('request.closed', { request_id: id }); };
    // History is the truth after a gap: finish the run and let native chat reload it.
    const onGap = ({ storedId, reason }) => { if (storedId === sessionId && !finished) { emit('gateway.gap', { reason }); if (started) end(); else finished = true; } };
    const onState = (s) => {
      if (finished) return;
      clearTimeout(giveUp);
      if (['signin', 'refused', 'stopped'].includes(s.state)) { end(new ApiError('stream_dropped', 'The reply could not be resumed.')); return; }
      if (s.state !== 'live') { giveUp = setTimeout(() => end(new ApiError('stream_dropped', 'The connection did not come back in time.')), GIVE_UP_MS); giveUp.unref?.(); }
    };
    const onAbort = () => end(new ApiError('aborted', 'Stopped.'));
    link.on('event', onLinkEvent); link.on('request', onRequest); link.on('requestClosed', onClosed); link.on('gap', onGap); link.on('state', onState);
    signal?.addEventListener('abort', onAbort, { once: true });
    done.catch(() => {});
    try {
      await link.submit(sessionId, text, { clientMessageId });
    } catch (e) {
      end(); // not a stream failure: the send itself
      throw submitError(e);
    }
    started = true;
    onEvent('run.started', { run_id: runId });
    for (const [name, data] of held.splice(0)) onEvent(name, data);
    if (finished) { end(); return; }
    // A reply the controller already saw complete is ended above; the rest waits for events.
    return done;
  }

  const attached = () => usable() && link.getState().state === 'live';
  return {
    listSessions: (...a) => rest.listSessions(...a),
    createSession: (...a) => rest.createSession(...a),
    getMessages: (...a) => rest.getMessages(...a),
    forkSession: (...a) => rest.forkSession(...a),
    streamChat,
    // False while a WebSocket send cannot go: the caller queues the message instead of trying.
    sendReady: () => transport() === 'sse' || !HOLD_STATES.has(link.getState().state),
    // The WebSocket has no run object to poll: clarify arrives as a request event.
    getRun: async (runId) => String(runId).startsWith(RUN_PREFIX) ? { pending_controls: [] } : rest.getRun(runId),
    stopRun: async (runId) => {
      if (!String(runId).startsWith(RUN_PREFIX)) return rest.stopRun(runId);
      try { await link.interrupt(idOf(runId)); } catch (e) { throw submitError(e); }
      return {};
    },
    answerApproval: async (runId, body) => {
      if (!String(runId).startsWith(RUN_PREFIX)) return rest.answerApproval(runId, body);
      const { requestId, choice } = body;
      try { await link.answer(idOf(runId), requestId, { choice }); } catch (e) { throw wireAnswerError(e); }
      return {};
    },
    answerClarify: async (runId, body) => {
      if (!String(runId).startsWith(RUN_PREFIX)) return rest.answerClarify(runId, body);
      const { requestId, answer } = body;
      const pending = link.pending(idOf(runId)).find((r) => String(r.id) === requestId);
      const qid = pending && Array.isArray(pending.params.questions) && pending.params.questions[0]?.qid;
      try { await link.answer(idOf(runId), requestId, { answers: qid ? { [qid]: answer } : {} }); } catch (e) { throw wireAnswerError(e); }
      return {};
    },
    // Native chat shows this as the connection banner and reloads on a gap.
    linkState: () => { if (!usable()) return null; const s = link.getState(); return { state: s.state, since: s.since }; },
    onLinkState: (cb) => { link.on('state', cb); return () => link.removeListener('state', cb); },
    onGap: (cb) => { link.on('gap', cb); return () => link.removeListener('gap', cb); },
    // Attach the open conversation ahead of the first send so that send is one frame.
    warm: (sessionId) => { if (attached()) link.attach(sessionId).catch(() => {}); },
  };
}

// An answer to a request that is already gone is a 404-like expiry for native chat.
function wireAnswerError(e) {
  const code = e && e.code;
  return code === 'unknown_request' || code === 'request_unavailable' ? new ApiError('http_404', 'That question is no longer open.', 404) : submitError(e);
}

// Factory for `createNativeChat({ apiFactory })`. The transport is read per call,
// so flipping the setting needs no rebuild: `sse` or an unconfigured gateway
// sends over REST+SSE, anything else over the WebSocket.
function createGatewayApiFactory({ restFactory, link, transport }) {
  return (config) => createGatewayApi({ rest: restFactory(config), link, transport });
}

module.exports = { createGatewayApi, createGatewayApiFactory };
