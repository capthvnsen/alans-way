'use strict';
// Hermes Agent Sessions REST + SSE client, main process only. The API server
// answers 403 to any request carrying an Origin header, and node:http sends none.
const http = require('node:http');
const https = require('node:https');

const MAX_BODY = 8 * 1024 * 1024, MAX_EVENT = 2 * 1024 * 1024, STREAM_IDLE_MS = 45000;

class ApiError extends Error {
  constructor(code, message, status = 0) { super(message || code); this.name = 'ApiError'; this.code = code; this.status = status; }
}

// Loopback over plain http (a local Hermes or an SSH tunnel), anything else only over https.
// A trailing /p/<profile> becomes the profile prefix.
function parseBaseUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.username || url.password || url.search || url.hash) return null;
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(host))) return null;
    const match = /^(.*?)\/p\/([\w.-]{1,64})\/?$/.exec(url.pathname);
    return { baseUrl: url.origin + (match ? match[1] : url.pathname).replace(/\/+$/, ''), profile: match ? match[2] : '' };
  } catch { return null; }
}

// Feed text chunks; calls onEvent(name, data) per complete frame. Comments
// (": keepalive") are skipped; a frame larger than MAX_EVENT throws.
function createSseParser(onEvent) {
  let buffer = '', event = '', data = [], size = 0;
  return (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      if (!line) {
        if (data.length) {
          let parsed = null;
          try { parsed = JSON.parse(data.join('\n')); } catch {}
          onEvent(event || 'message', parsed);
        }
        event = ''; data = []; size = 0;
        continue;
      }
      if (line[0] === ':') continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'event') event = value;
      else if (field === 'data') { data.push(value); size += value.length; }
    }
    if (buffer.length + size > MAX_EVENT) throw new ApiError('stream_too_large', 'A reply event was too large.');
  };
}

function readBody(res, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0, done = false;
    res.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { done = true; res.destroy(); reject(new ApiError('too_large', 'Hermes sent more data than expected.')); return; }
      chunks.push(chunk);
    });
    res.on('end', () => { done = true; resolve(Buffer.concat(chunks).toString('utf8')); });
    res.on('error', (error) => { if (!done) { done = true; reject(error); } });
    res.on('close', () => { if (!done) { done = true; reject(new ApiError('unreachable', 'The connection to Hermes closed early.')); } });
  });
}

async function failure(res) {
  const text = await readBody(res, 64 * 1024).catch(() => '');
  if (res.statusCode === 401) return new ApiError('unauthorized', 'Hermes refused the API key.', 401);
  let message = '';
  try { message = String(JSON.parse(text)?.error?.message || '').slice(0, 300); } catch {}
  return new ApiError(`http_${res.statusCode}`, message || `Hermes answered HTTP ${res.statusCode}.`, res.statusCode);
}

function createHermesApi({ baseUrl, key, profile = '', timeoutMs = 15000, idleMs = STREAM_IDLE_MS } = {}) {
  const base = baseUrl ? parseBaseUrl(baseUrl) : null;
  const prefix = profile ? `/p/${encodeURIComponent(profile)}` : '';
  const enc = encodeURIComponent;
  const query = (params) => new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== '')).toString();

  function send(method, path, body, signal) {
    if (!base || !key) return Promise.reject(new ApiError('unconfigured', 'Native chat has no address or API key yet.'));
    const url = new URL(base.baseUrl + prefix + path);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = { Authorization: `Bearer ${key}`, Accept: 'application/json, text/event-stream' };
    if (payload) Object.assign(headers, { 'Content-Type': 'application/json', 'Content-Length': payload.length });
    return new Promise((resolve, reject) => {
      const req = (url.protocol === 'https:' ? https : http).request(url, { method, headers, signal }, resolve);
      req.on('error', (error) => reject(error.name === 'AbortError' ? new ApiError('aborted', 'Stopped.') : new ApiError('unreachable', `Can't reach Hermes at ${url.host}.`)));
      req.end(payload || undefined);
    });
  }

  async function json(method, path, body, { signal } = {}) {
    const timeout = AbortSignal.timeout(timeoutMs);
    try {
      const res = await send(method, path, body, signal ? AbortSignal.any([signal, timeout]) : timeout);
      if (res.statusCode < 200 || res.statusCode >= 300) throw await failure(res);
      const text = await readBody(res, MAX_BODY);
      try { return text ? JSON.parse(text) : {}; } catch { throw new ApiError('bad_response', 'Hermes sent a reply this app cannot read.'); }
    } catch (error) {
      if (timeout.aborted && !signal?.aborted) throw new ApiError('unreachable', 'Hermes did not answer in time.');
      throw error instanceof ApiError ? error : new ApiError('unreachable', String(error?.message || error));
    }
  }

  // No overall timeout on a live reply; 45 s without a single byte (keepalives
  // included) counts as a dropped stream.
  async function streamChat(sessionId, input, { onEvent = () => {}, signal } = {}) {
    const local = new AbortController();
    const abort = () => local.abort();
    signal?.addEventListener('abort', abort, { once: true });
    let idle, dropped = false;
    const arm = () => { clearTimeout(idle); idle = setTimeout(() => { dropped = true; local.abort(); }, idleMs); };
    try {
      arm();
      const res = await send('POST', `/api/sessions/${enc(sessionId)}/chat/stream`, { input }, local.signal);
      if (res.statusCode !== 200) throw await failure(res);
      res.setEncoding('utf8');
      const feed = createSseParser(onEvent);
      await new Promise((resolve, reject) => {
        res.on('data', (chunk) => { arm(); try { feed(chunk); } catch (error) { res.destroy(); reject(error); } });
        // An unframed body ends at socket close, so an aborted stream can still "end".
        res.on('end', () => (local.signal.aborted ? reject(new ApiError('aborted', 'Stopped.')) : resolve()));
        res.on('error', reject);
        res.on('close', () => reject(new ApiError('stream_dropped', 'The reply stream closed early.')));
      });
    } catch (error) {
      if (dropped) throw new ApiError('stream_dropped', 'The reply stream went quiet for 45 seconds and was dropped.');
      if (signal?.aborted) throw new ApiError('aborted', 'Stopped.');
      throw error instanceof ApiError ? error : new ApiError('unreachable', String(error?.message || error));
    } finally {
      clearTimeout(idle);
      signal?.removeEventListener('abort', abort);
    }
  }

  return {
    listSessions: ({ limit = 50, offset = 0, source } = {}, options) => json('GET', `/api/sessions?${query({ limit, offset, source })}`, undefined, options),
    createSession: (body = {}) => json('POST', '/api/sessions', body),
    getMessages: (id, { limit = 500, offset = 0, order = 'latest' } = {}, options) => json('GET', `/api/sessions/${enc(id)}/messages?${query({ limit, offset, order })}`, undefined, options),
    forkSession: (id, body = {}) => json('POST', `/api/sessions/${enc(id)}/fork`, body),
    getRun: (runId) => json('GET', `/v1/runs/${enc(runId)}`),
    stopRun: (runId) => json('POST', `/v1/runs/${enc(runId)}/stop`, {}),
    answerApproval: (runId, { requestId, generation, choice }) => json('POST', `/v1/runs/${enc(runId)}/approval`, { request_id: requestId, execution_generation: generation, choice }),
    answerClarify: (runId, { requestId, generation, answer }) => json('POST', `/v1/runs/${enc(runId)}/clarify`, { request_id: requestId, execution_generation: generation, answer }),
    streamChat,
  };
}

module.exports = { createHermesApi, createSseParser, parseBaseUrl, ApiError };
