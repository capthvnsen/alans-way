'use strict';
// Public authenticated connector to a `hermes serve` backend.
//
// Talks ONLY the documented public seam (website/docs/developer-guide/
// programmatic-integration.md + dashboard_auth/routes.py):
//   GET  /api/status            liveness + {auth_required, auth_flows, profiles}
//   GET  /api/auth/providers    registered auth providers
//   GET  /auth/native/authorize RFC 8252 broker start (password providers → /login)
//   POST /auth/password-login   verify credentials; JSON `next` carries code+state
//   POST /auth/native/token     loopback code + PKCE verifier → bearer tokens
//   POST /auth/native/refresh   rotate a stored refresh token
//   POST /api/auth/ws-ticket    Bearer access token → single-use WS ticket
//   WS   /api/ws?ticket=…       gated chat transport; loopback mode uses ?token=
//
// Secrets discipline: passwords, codes and tokens live only inside this module's
// request bodies and the returned `tokens` object the hub keeps in main-process
// memory. Nothing here logs URLs carrying credentials, and the only persisted
// secret is the refresh token the caller stores via safeStorage.
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { PassThrough, Writable } = require('node:stream');

class RemoteError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.name = 'RemoteError';
    this.code = code;
    if (extra !== undefined) this.detail = extra;
  }
}

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const MAX_BODY = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15000;

// Validate an operator-supplied base URL. http/https only; a path prefix
// (reverse-proxy mount) is preserved verbatim for every route.
function normalizeBaseUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new RemoteError('bad_url', 'A backend URL is required.');
  }
  let url;
  try { url = new URL(raw.trim()); } catch { throw new RemoteError('bad_url', `Cannot parse backend URL: ${raw}`); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new RemoteError('bad_url', 'Backend URL must be http:// or https://.');
  }
  if (url.username || url.password) {
    throw new RemoteError('bad_url', 'Do not embed credentials in the URL; sign in instead.');
  }
  url.hash = '';
  url.search = '';
  const prefix = url.pathname.replace(/\/+$/, '');
  return { origin: url.origin, prefix, label: `${url.host}${prefix}` };
}

const joinPath = (prefix, route) => `${prefix}${route}`;

// One JSON request. `cookieJar` collects Set-Cookie values between the broker
// authorize call and password-login (the PKCE cookie is the only server
// channel that survives the credential step). `signal` is optional additive
// cancellation: aborting destroys the in-flight request/response so a
// superseded attempt releases the socket now instead of at timeout.
function requestJson({ origin, prefix, method, route, headers = {}, body, timeoutMs = REQUEST_TIMEOUT_MS, cookieJar, signal }) {
  return new Promise((resolve, reject) => {
    const abortErr = () => signal?.reason instanceof RemoteError ? signal.reason
      : new RemoteError('aborted', `${method} ${route} aborted`);
    if (signal?.aborted) { reject(abortErr()); return; }
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    let liveRes = null;
    const timer = setTimeout(() => req.destroy(new RemoteError('timeout', `${method} ${route} timed out`)), timeoutMs);
    timer.unref();
    const done = () => { clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); };
    const onAbort = () => {
      const err = abortErr();
      try { liveRes?.destroy(err); } catch {}
      try { req.destroy(err); } catch {}
    };
    const req = (origin.startsWith('https:') ? https : http).request(`${origin}${joinPath(prefix, route)}`, {
      method,
      headers: {
        Accept: 'application/json',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}),
        ...(cookieJar?.size ? { Cookie: [...cookieJar.values()].join('; ') } : {}),
        ...headers,
      },
    }, (res) => {
      liveRes = res;
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) { res.destroy(); reject(new RemoteError('oversized', `${route}: response too large`)); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        done();
        for (const sc of res.headers['set-cookie'] || []) {
          const pair = String(sc).split(';')[0];
          const eq = pair.indexOf('=');
          if (eq > 0 && cookieJar) cookieJar.set(pair.slice(0, eq), pair);
        }
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* html/non-json */ }
        resolve({ status: res.statusCode, json, text, headers: res.headers });
      });
      res.on('error', (e) => {
        done();
        reject(e instanceof RemoteError ? e : new RemoteError('unreachable', String(e && e.message || e)));
      });
    });
    req.on('error', (e) => {
      done();
      reject(e instanceof RemoteError ? e : new RemoteError('unreachable', `${origin}: ${e.code || e.message}`));
    });
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    if (data) req.write(data);
    req.end();
  });
}

function httpFail(res, route) {
  const detail = res.json && (res.json.detail || res.json.error) || res.text.slice(0, 200);
  if (res.status === 401 || res.status === 403) return new RemoteError('auth_failed', `${route}: ${detail || res.status}`);
  if (res.status === 404) return new RemoteError('not_found', `${route}: ${detail || 'not found'}`);
  return new RemoteError('http_error', `${route}: HTTP ${res.status} ${detail}`.trim());
}

const b64url = (buf) => buf.toString('base64url');
const sha256b64url = (text) => b64url(crypto.createHash('sha256').update(text).digest());

function createHermesRemote() {
  return {
    normalizeBaseUrl,

    // Availability probe. Never implies auth/session readiness — callers read
    // auth_required and still authenticate before opening the socket.
    async probe(baseUrl, { signal } = {}) {
      const base = normalizeBaseUrl(baseUrl);
      const res = await requestJson({ ...base, method: 'GET', route: '/api/status', signal });
      if (res.status !== 200 || !isPlainObject(res.json)) throw httpFail(res, 'GET /api/status');
      const s = res.json;
      if (typeof s.version !== 'string') {
        throw new RemoteError('not_hermes', 'Endpoint answered /api/status but is not a Hermes backend.');
      }
      return {
        base,
        status: s,
        authRequired: s.auth_required === true,
        authFlows: Array.isArray(s.auth_flows) ? s.auth_flows : [],
        authProviders: Array.isArray(s.auth_providers) ? s.auth_providers : [],
        profiles: Array.isArray(s.profiles) ? s.profiles : [],
        gatewayRunning: s.gateway_running === true,
      };
    },

    async providers(base, { signal } = {}) {
      const res = await requestJson({ ...base, method: 'GET', route: '/api/auth/providers', signal });
      const list = Array.isArray(res.json) ? res.json : (isPlainObject(res.json) && Array.isArray(res.json.providers) ? res.json.providers : null);
      if (res.status !== 200 || !list) throw httpFail(res, 'GET /api/auth/providers');
      return list.filter((p) => isPlainObject(p) && typeof p.name === 'string');
    },

    // RFC 8252 native password login. Returns bearer tokens or throws a coded
    // RemoteError. `username`/`password` never escape this function.
    async signIn({ base, provider, username, password, signal }) {
      if (typeof username !== 'string' || typeof password !== 'string') {
        throw new RemoteError('bad_credentials', 'username and password are required');
      }
      const cookieJar = new Map();
      const verifier = b64url(crypto.randomBytes(32));
      const state = b64url(crypto.randomBytes(18));
      const params = new URLSearchParams({
        provider, code_challenge: sha256b64url(verifier), code_challenge_method: 'S256',
        redirect_uri: 'http://127.0.0.1/hermes/callback', state,
      });
      const authz = await requestJson({
        ...base, method: 'GET', route: `/auth/native/authorize?${params}`,
        cookieJar, headers: { Accept: 'text/html,application/json' }, signal,
      });
      // Password providers answer 302 → /login and set the PKCE cookie; the
      // desktop completes via password-login, not by following the redirect.
      if (![302, 303].includes(authz.status) || !cookieJar.size) {
        throw new RemoteError('auth_flow_unsupported',
          `native authorize answered HTTP ${authz.status}; this provider may need browser sign-in`);
      }
      const login = await requestJson({
        ...base, method: 'POST', route: '/auth/password-login', cookieJar,
        body: { provider, username, password, next: '' }, signal,
      });
      if (login.status !== 200 || !isPlainObject(login.json) || typeof login.json.next !== 'string') {
        throw httpFail(login, 'POST /auth/password-login');
      }
      let next;
      try { next = new URL(login.json.next); } catch { throw new RemoteError('contract_drift', 'password-login next is not a URL'); }
      if (next.hostname !== '127.0.0.1' && next.hostname !== '[::1]') {
        throw new RemoteError('contract_drift', 'native login redirect is not loopback');
      }
      const code = next.searchParams.get('code') || '';
      if (!code || next.searchParams.get('state') !== state) {
        throw new RemoteError('auth_failed', 'native login returned a missing or mismatched state');
      }
      const token = await requestJson({
        ...base, method: 'POST', route: '/auth/native/token',
        body: { code, code_verifier: verifier }, signal,
      });
      if (token.status !== 200 || !isPlainObject(token.json) || typeof token.json.access_token !== 'string') {
        throw httpFail(token, 'POST /auth/native/token');
      }
      return this._tokens(token.json);
    },

    async refresh({ base, refreshToken, provider = '', signal }) {
      const res = await requestJson({
        ...base, method: 'POST', route: '/auth/native/refresh',
        body: { refresh_token: refreshToken, provider }, signal,
      });
      if (res.status === 401 || (isPlainObject(res.json) && res.json.error === 'session_expired')) {
        throw new RemoteError('session_expired', 'Stored sign-in expired; sign in again.');
      }
      if (res.status !== 200 || !isPlainObject(res.json) || typeof res.json.access_token !== 'string') {
        throw httpFail(res, 'POST /auth/native/refresh');
      }
      return this._tokens(res.json);
    },

    _tokens(json) {
      return {
        accessToken: json.access_token,
        refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : '',
        expiresAt: typeof json.expires_at === 'number' ? json.expires_at : 0,
        provider: typeof json.provider === 'string' ? json.provider : '',
        userId: typeof json.user_id === 'string' ? json.user_id : '',
      };
    },

    async wsTicket({ base, accessToken, signal }) {
      const res = await requestJson({
        ...base, method: 'POST', route: '/api/auth/ws-ticket',
        headers: { Authorization: `Bearer ${accessToken}` }, signal,
      });
      if (res.status !== 200 || !isPlainObject(res.json) || typeof res.json.ticket !== 'string') {
        throw httpFail(res, 'POST /api/auth/ws-ticket');
      }
      return { ticket: res.json.ticket, ttlSeconds: res.json.ttl_seconds ?? 30 };
    },

    // Build the WS URL without ever logging it (the ticket is a credential).
    wsUrl({ base, ticket, localToken }) {
      const ws = new URL(`${base.origin}${base.prefix}/api/ws`);
      ws.protocol = ws.protocol === 'https:' ? 'wss:' : 'ws:';
      if (ticket) ws.searchParams.set('ticket', ticket);
      else if (localToken) ws.searchParams.set('token', localToken);
      else throw new RemoteError('no_credential', 'no ticket or local token for WS connect');
      return ws.href;
    },

    // Adapt a WebSocket to the {input, output} pair HermesSessionWire expects.
    // Each inbound WS message is one JSON-RPC frame; the wire frames on newlines.
    async connectSocket({ url, timeoutMs = 15000, signal }) {
      if (typeof WebSocket !== 'function') {
        throw new RemoteError('no_websocket', 'this runtime lacks a WebSocket client');
      }
      const abortErr = () => signal?.reason instanceof RemoteError ? signal.reason
        : new RemoteError('aborted', 'WebSocket connect aborted');
      if (signal?.aborted) throw abortErr();
      let onAbort = null;
      const ws = await new Promise((resolve, reject) => {
        const sock = new WebSocket(url);
        let settled = false;
        // Reject BEFORE closing: close() on a connecting socket can fire
        // onerror synchronously, which would re-label a timeout 'unreachable'.
        const timer = setTimeout(() => {
          settled = true;
          if (onAbort) signal.removeEventListener('abort', onAbort);
          reject(new RemoteError('timeout', 'WebSocket connect timed out'));
          try { sock.close(); } catch {}
        }, timeoutMs);
        if (signal) {
          // Past onopen this stays armed: an abort after adoption still closes
          // the socket so a superseded connection never lingers — the caller's
          // own epoch fence decides whether that close may touch state.
          onAbort = () => {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              reject(abortErr());
            }
            try { sock.close(); } catch {}
          };
          signal.addEventListener('abort', onAbort, { once: true });
        }
        sock.onopen = () => {
          clearTimeout(timer);
          if (settled) { try { sock.close(); } catch {} return; }
          settled = true; resolve(sock);
        };
        sock.onerror = () => {
          clearTimeout(timer);
          if (onAbort) signal.removeEventListener('abort', onAbort);
          if (settled) return;
          settled = true; reject(new RemoteError('unreachable', 'WebSocket connection failed or was rejected'));
        };
      });
      const detachAbort = () => { if (onAbort) { signal.removeEventListener('abort', onAbort); onAbort = null; } };
      const input = new PassThrough({ allowHalfOpen: false });
      // 'error' on a stream with no listener throws. On abnormal close the
      // wire may already be detached (teardown), so keep a permanent sink —
      // a wire that IS attached still receives the same error event.
      input.on('error', () => { });
      const output = new Writable({
        write(chunk, _enc, cb) {
          try { ws.send(chunk.toString('utf8')); cb(); } catch (e) { cb(e); }
        },
        final(cb) { try { ws.close(); } catch {} cb(); },
      });
      ws.onmessage = (event) => {
        const text = typeof event.data === 'string' ? event.data : '';
        if (!input.destroyed) input.write(text.endsWith('\n') ? text : `${text}\n`);
      };
      ws.onclose = (event) => {
        detachAbort();
        if (input.destroyed) return;
        if (event.code === 1000) input.end();
        else input.destroy(new RemoteError('ws_closed', `WebSocket closed ${event.code} ${event.reason || ''}`.trim()));
      };
      ws.onerror = () => { detachAbort(); if (!input.destroyed) input.destroy(new RemoteError('ws_error', 'WebSocket error')); };
      return { input, output, socket: ws };
    },
  };
}

module.exports = { createHermesRemote, RemoteError, normalizeBaseUrl };
