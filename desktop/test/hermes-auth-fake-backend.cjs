'use strict';
// Loopback fake of the documented public Hermes backend surface used by the
// hermes-auth-race tests: HTTP auth routes + a WS newline-delimited JSON-RPC
// gateway, with honest edge behavior (one-shot tickets, 4401 closes,
// cookie-bound PKCE, configurable latency and forced failures). Node built-ins
// only. Tokens are minted as `at-<tag>-<user>` / `rt-<tag>-<user>` so a test
// can prove which backend AND which sign-in attempt produced a credential.

const http = require('node:http');
const crypto = require('node:crypto');

function wsAccept(key) {
  return crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
}
function wsSendText(socket, text) {
  const payload = Buffer.from(text);
  let header;
  if (payload.length < 126) { header = Buffer.from([0x81, payload.length]); }
  else if (payload.length < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(payload.length, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(payload.length), 2); }
  socket.write(Buffer.concat([header, payload]));
}
const wsSendJson = (s, o) => wsSendText(s, JSON.stringify(o));
function wsSendClose(socket, code = 1000, reason = '') {
  const r = Buffer.from(reason.slice(0, 120));
  const p = Buffer.alloc(2 + r.length);
  p.writeUInt16BE(code, 0); r.copy(p, 2);
  socket.write(Buffer.concat([Buffer.from([0x88, p.length]), p]));
  setTimeout(() => { try { socket.end(); } catch {} }, 40).unref?.();
}
function wsReadFrames(socket, cb) {
  let buf = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const op = buf[0] & 0x0f;
      const masked = !!(buf[1] & 0x80);
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const maskOff = off; if (masked) off += 4;
      if (buf.length < off + len) return;
      let payload = Buffer.from(buf.subarray(off, off + len));
      if (masked) { const m = buf.subarray(maskOff, maskOff + 4); for (let i = 0; i < payload.length; i++) payload[i] ^= m[i % 4]; }
      buf = buf.subarray(off + len);
      cb(op, payload);
      if (op === 0x8) return;
    }
  });
}

// cfg: { authRequired, tokenTag, tokenDelayMs, refreshDelayMs, refreshStatus,
//        ticketStatus, localToken, wsCloseCode, wsCloseReason, wsReadyDelayMs,
//        wsNeverReady, epoch, sessions, extraRpc, onWsOpen }
// `cfg` is returned live on the handle so a test can flip failure flags
// mid-flight (e.g. refreshStatus = 401 to expire the stored session).
async function fakeBackend(cfg = {}) {
  const hits = [];
  const sockets = new Set();
  const wsPeers = new Set();
  const tickets = new Set();
  const consumed = new Set();
  const pendingStates = new Map(); // pkce cookie -> client state
  const pendingUser = new Map();   // issued auth code -> username
  let ticketCounter = 0;
  const epoch = cfg.epoch || 'epoch-1';
  const tag = cfg.tokenTag || 'be';
  const liveSessions = (cfg.sessions !== undefined ? cfg.sessions : [
    { id: 'sess-1', session_key: 'key-1', title: 'alpha', profile: 'default' },
    { id: 'sess-2', session_key: 'key-2', title: 'beta', profile: 'default' },
  ]).slice();
  const mint = (user, seq = '') => ({
    access_token: `at-${tag}-${user}${seq}`,
    refresh_token: `rt-${tag}-${user}${seq}`,
    expires_at: 9999999999,
    provider: cfg.provider || 'basic',
    user_id: user,
  });

  function rpcResult(method, params) {
    switch (method) {
      case 'gateway.capabilities': return { result: { per_session_exclusive_submit: true, modes: ['default'] } };
      case 'client.capabilities': return { result: { server_requests: ['tool.approval'] } };
      case 'session.active_list': return { result: { sessions: liveSessions.slice() } };
      case 'session.list': return { result: { sessions: [] } };
      case 'session.create': {
        const id = `sess-new-${Math.floor(Math.random() * 1e6)}`;
        if (!liveSessions.some((r) => r.id === id)) {
          liveSessions.push({ id, session_key: `key-${id}`, title: id, profile: 'default' });
        }
        return { result: { session_id: id } };
      }
      case 'session.activate': {
        const row = liveSessions.find((r) => r.id === params.session_id);
        return { result: { session_id: params.session_id,
          session_key: row ? row.session_key : `key-${params.session_id}`,
          stored_session_id: `stored-${params.session_id}`, messages: [], open_requests: [], inflight: null } };
      }
      case 'session.events.since':
        return { result: { epoch, events: [], open_requests: [], latest_seq: 0, truncated: false } };
      case 'prompt.submit': return { result: { status: 'admitted', user_row_id: 'row-1' } };
      case 'session.interrupt': return { result: { status: 'ok', interrupted: true } };
      default:
        if (cfg.extraRpc) { const r = cfg.extraRpc(method, params); if (r !== undefined) return r; }
        return { error: { code: -32601, message: `unknown method ${method}` } };
    }
  }

  function onUpgrade(req, socket) {
    sockets.add(socket);
    wsPeers.add(socket);
    socket.on('close', () => { sockets.delete(socket); wsPeers.delete(socket); });
    const u = new URL(`http://h${req.url}`);
    const ticket = u.searchParams.get('ticket');
    const token = u.searchParams.get('token');
    let ok = false;
    if (cfg.authRequired !== false) {
      if (ticket && tickets.has(ticket) && !consumed.has(ticket)) { consumed.add(ticket); ok = true; }
      if (token) ok = false;
    } else {
      if (token && (!cfg.localToken || token === cfg.localToken)) ok = true;
      if (ticket && tickets.has(ticket) && !consumed.has(ticket)) { consumed.add(ticket); ok = true; }
    }
    if (!ok) { wsSendClose(socket, 4401, token ? 'token_invalid' : 'ticket_invalid'); return; }
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${wsAccept(req.headers['sec-websocket-key'])}\r\n\r\n`);
    if (cfg.wsCloseCode) { wsSendClose(socket, cfg.wsCloseCode, cfg.wsCloseReason || ''); return; }
    const sendReady = () => wsSendJson(socket, { jsonrpc: '2.0', method: 'event',
      params: { type: 'gateway.ready', payload: { replay_epoch: epoch, skin: 'auth-fake', change_events: true, heartbeat_ms: 30000 } } });
    if (cfg.wsNeverReady) { /* hold open, no ready */ } else if (cfg.wsReadyDelayMs) { setTimeout(sendReady, cfg.wsReadyDelayMs); } else sendReady();
    wsReadFrames(socket, (op, payload) => {
      if (op === 0x8) { wsSendClose(socket, 1000); return; }
      if (op === 0x9) { socket.write(Buffer.from([0x8a, 0])); return; }
      if (op !== 0x1) return;
      for (const line of payload.toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        let frame; try { frame = JSON.parse(line); } catch { continue; }
        if (typeof frame.method === 'string' && frame.id !== undefined) {
          const r = rpcResult(frame.method, frame.params || {});
          if (r !== undefined) wsSendJson(socket, { jsonrpc: '2.0', id: frame.id, ...r });
        }
      }
    });
    cfg.onWsOpen?.({ socket, send: (o) => wsSendJson(socket, o), close: (c, r) => wsSendClose(socket, c, r) });
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      let body = null; try { body = JSON.parse(raw || 'null'); } catch {}
      hits.push({ method: req.method, url: req.url, headers: req.headers, body });
      const u = new URL(`http://h${req.url}`);
      const send = (status, obj) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (u.pathname === '/api/status' && req.method === 'GET') {
        const auth = cfg.authRequired !== false;
        send(200, {
          version: '1.0.0-auth-fake',
          auth_required: auth,
          auth_flows: auth ? ['cookie', 'native_pkce'] : [],
          auth_providers: auth ? [cfg.provider || 'basic'] : [],
          profiles: ['default'],
          gateway_running: false,
        });
        return;
      }
      if (u.pathname === '/api/auth/providers' && req.method === 'GET') {
        send(200, { providers: [{ name: cfg.provider || 'basic', display_name: cfg.nativeBrowser ? 'Nous Research' : 'Password', supports_password: !cfg.nativeBrowser }] });
        return;
      }
      if (u.pathname === '/auth/native/authorize' && req.method === 'GET') {
        const state = u.searchParams.get('state') || '';
        const cookie = `pkce_${crypto.randomBytes(8).toString('hex')}`;
        if (cfg.nativeBrowser) {
          const code = `gwcode-${cookie}`;
          const redirect = new URL(u.searchParams.get('redirect_uri'));
          pendingUser.set(code, { user: cfg.user || 'oauth-user', challenge: u.searchParams.get('code_challenge') });
          redirect.searchParams.set('code', code);
          redirect.searchParams.set('state', state);
          res.writeHead(302, { location: redirect.href }); res.end(); return;
        }
        pendingStates.set(cookie, state);
        res.writeHead(302, { 'set-cookie': `hermes_pkce=${cookie}; Path=/; HttpOnly`, location: '/login' });
        res.end();
        return;
      }
      if (u.pathname === '/auth/password-login' && req.method === 'POST') {
        const cookie = /hermes_pkce=([^;]+)/.exec(req.headers.cookie || '')?.[1];
        const state = cookie ? pendingStates.get(cookie) : undefined;
        if (!cookie) { send(400, { detail: 'missing_pkce_cookie' }); return; }
        if (!body || typeof body.username !== 'string' || typeof body.password !== 'string') {
          send(401, { detail: 'Invalid credentials' }); return;
        }
        const code = `gwcode-${cookie}`;
        pendingUser.set(code, body.username);
        send(200, { ok: true, next: `http://127.0.0.1/hermes/callback?code=${code}&state=${state}` });
        return;
      }
      if (u.pathname === '/auth/native/token' && req.method === 'POST') {
        if (!body || typeof body.code !== 'string' || typeof body.code_verifier !== 'string') {
          send(400, { detail: 'bad_code' }); return;
        }
        const pending = pendingUser.get(body.code);
        if (cfg.nativeBrowser && (!pending || pending.challenge !== crypto.createHash('sha256').update(body.code_verifier).digest('base64url'))) {
          send(400, { detail: 'invalid_code_or_pkce' }); return;
        }
        if (cfg.nativeBrowser) pendingUser.delete(body.code);
        const user = cfg.nativeBrowser ? pending.user : pending || 'agent';
        const answer = () => send(200, cfg.tokenResponse || mint(user));
        if (cfg.tokenDelayMs) setTimeout(answer, cfg.tokenDelayMs); else answer();
        return;
      }
      if (u.pathname === '/auth/native/refresh' && req.method === 'POST') {
        const answer = () => {
          if (cfg.refreshStatus) { send(cfg.refreshStatus, { detail: 'expired' }); return; }
          const rt = body && body.refresh_token;
          // Only refresh tokens minted by THIS backend are honored.
          if (typeof rt !== 'string' || !rt.startsWith(`rt-${tag}-`)) { send(401, { detail: 'expired' }); return; }
          const user = rt.slice(`rt-${tag}-`.length).replace(/-r\d+$/, '');
          send(200, mint(user, '-r1'));
        };
        if (cfg.refreshDelayMs) setTimeout(answer, cfg.refreshDelayMs); else answer();
        return;
      }
      if (u.pathname === '/api/auth/ws-ticket' && req.method === 'POST') {
        if (cfg.ticketStatus) { send(cfg.ticketStatus, { detail: 'unauthorized' }); return; }
        const auth = req.headers.authorization || '';
        if (!auth.startsWith(`Bearer at-${tag}-`)) { send(401, { detail: 'unauthorized' }); return; }
        const t = `tk-${tag}-${++ticketCounter}-${crypto.randomBytes(6).toString('hex')}`;
        tickets.add(t);
        send(200, { ticket: t, ttl_seconds: 30 });
        return;
      }
      send(404, { detail: 'not_found' });
    });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  server.on('upgrade', (req, socket) => {
    if (!new URL(`http://h${req.url}`).pathname.endsWith('/api/ws')) { socket.destroy(); return; }
    onUpgrade(req, socket);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    server, hits, tickets, consumed, cfg,
    url: `http://127.0.0.1:${server.address().port}`,
    wsPeerCount: () => wsPeers.size,
    // True iff any recorded request carries a credential bearing `mark` in the
    // Authorization header or a token field. Random PKCE verifiers can contain
    // the mark by chance, so the whole body is not scanned.
    leaked: (mark) => hits.some((h) =>
      (h.headers.authorization || '').includes(mark) || ['refresh_token', 'access_token'].some((k) => String(h.body?.[k] || '').includes(mark))),
    close: () => new Promise((r) => {
      for (const s of sockets) s.destroy();
      server.close(r);
    }),
  };
}

module.exports = { fakeBackend };
