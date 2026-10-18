'use strict';
// Connector tests against a real local HTTP server faking the public auth
// contract + a minimal RFC6455 echo server for connectSocket. The assertions
// check wire behavior (methods, headers, bodies, credentials), not internals.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { createHermesRemote } = require('../src/hermes-remote.cjs');

function wsAccept(key) {
  return crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
}

// Minimal WS server: upgrade then echo each text frame back with a tag.
function wsUpgrade(req, socket) {
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${wsAccept(req.headers['sec-websocket-key'])}\r\n\r\n`);
  socket.on('data', (buf) => {
    // one small frame: [fin+op][len][mask?][payload]
    if (buf.length < 2 || (buf[1] & 0x7f) > 125) return;
    const op = buf[0] & 0x0f;
    if (op === 0x8) { socket.write(Buffer.from([0x88, 0x02, 0x03, 0xe8])); socket.end(); return; }
    if (op === 0x9) { socket.write(Buffer.from([0x8a, 0])); return; }
    if (op !== 0x1) return;
    const masked = !!(buf[1] & 0x80);
    let off = 2;
    const mask = masked ? buf.subarray(off, off + 4) : null;
    if (mask) off += 4;
    const payload = Buffer.from(buf.subarray(off, off + (buf[1] & 0x7f)));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    const echo = Buffer.concat([Buffer.from('echo:'), payload]);
    socket.write(Buffer.concat([Buffer.from([0x81, echo.length]), echo]));
  });
}

function fixture(handler) {
  const hits = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      hits.push({ method: req.method, url: req.url, headers: req.headers, body: body.slice(0, 4000) });
      handler(req, res, JSON.parse(body || 'null'), hits.at(-1));
    });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  server.on('upgrade', (req, socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); wsUpgrade(req, socket); });
  server.on('close', () => { for (const s of sockets) s.destroy(); });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, hits, url: `http://127.0.0.1:${server.address().port}` })));
}

const baseHandler = (req, res, body) => {
  if (req.url === '/api/status') {
    res.end(JSON.stringify({ version: '0.9.9-test', auth_required: true, auth_flows: ['cookie', 'native_pkce'], auth_providers: ['basic'], profiles: ['default'], gateway_running: true }));
    return;
  }
  if (req.url === '/api/auth/providers') {
    res.end(JSON.stringify({ providers: [{ name: 'basic', display_name: 'Password', supports_password: true }] }));
    return;
  }
  if (req.url.startsWith('/auth/native/authorize')) {
    res.writeHead(302, { 'Set-Cookie': 'hermes_pkce=broker123; Path=/', Location: '/login' });
    res.end();
    return;
  }
  if (req.url === '/auth/password-login') {
    if (body.username !== 'agent' || body.password !== 'pw') { res.writeHead(401); res.end(JSON.stringify({ detail: 'Invalid credentials' })); return; }
    const redirect = new URLSearchParams(req.headers.cookie?.includes('hermes_pkce=broker123') ? '' : '');
    res.end(JSON.stringify({ ok: true, next: 'http://127.0.0.1/cb?code=gwcode&state=' + (fixtureState || '') }));
    return;
  }
  res.writeHead(404); res.end('{}');
};
let fixtureState = '';

test('probe reads auth gate shape and rejects non-Hermes endpoints', async () => {
  const { server, url } = await fixture(baseHandler);
  const remote = createHermesRemote();
  const base = remote.normalizeBaseUrl(url);
  const p = await remote.probe(url);
  assert.equal(p.authRequired, true);
  assert.deepEqual(p.profiles, ['default']);
  assert.equal(p.gatewayRunning, true);
  const bad = await fixture((req, res) => res.end(JSON.stringify({ ok: true })));
  await assert.rejects(() => remote.probe(bad.url), /not a Hermes/);
  await new Promise((r) => server.close(r));
  await new Promise((r) => bad.server.close(r));
});

test('native password sign-in runs the full PKCE broker flow', async () => {
  const { server, url, hits } = await fixture((req, res, body, hit) => {
    if (req.url.startsWith('/auth/native/authorize')) {
      const q = new URL(`http://x${req.url}`).searchParams;
      fixtureState = q.get('state');
      res.writeHead(302, { 'Set-Cookie': 'hermes_pkce=broker123; Path=/', Location: '/login' });
      res.end(); return;
    }
    if (req.url === '/auth/password-login') {
      if (body.username !== 'agent' || body.password !== 'pw') { res.writeHead(401); res.end('{"detail":"Invalid credentials"}'); return; }
      res.end(JSON.stringify({ ok: true, next: `http://127.0.0.1/cb?code=gwcode&state=${fixtureState}` }));
      return;
    }
    if (req.url === '/auth/native/token') {
      assert.equal(body.code, 'gwcode');
      assert.ok(typeof body.code_verifier === 'string' && body.code_verifier.length > 20);
      res.end(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_at: 99, provider: 'basic', user_id: 'agent' }));
      return;
    }
    baseHandler(req, res, body);
  });
  const remote = createHermesRemote();
  const base = remote.normalizeBaseUrl(url);
  const tokens = await remote.signIn({ base, provider: 'basic', username: 'agent', password: 'pw' });
  assert.equal(tokens.accessToken, 'at');
  assert.equal(tokens.refreshToken, 'rt');
  assert.equal(tokens.userId, 'agent');
  // The PKCE cookie was carried from authorize → password-login.
  const login = hits.find((h) => h.url === '/auth/password-login');
  assert.ok(login.headers.cookie.includes('hermes_pkce=broker123'));
  await new Promise((r) => server.close(r));
});

test('wrong password surfaces auth_failed and never leaks the password', async () => {
  const { server, url } = await fixture(baseHandler);
  const remote = createHermesRemote();
  await assert.rejects(
    remote.signIn({ base: remote.normalizeBaseUrl(url), provider: 'basic', username: 'agent', password: 'nope' }),
    (e) => { assert.equal(e.code, 'auth_failed'); assert.ok(!e.message.includes('nope')); return true; });
  await new Promise((r) => server.close(r));
});

test('ws-ticket uses the bearer token; connectSocket adapts frames to wire streams', async () => {
  const { server, url, hits } = await fixture((req, res) => {
    if (req.url === '/api/auth/ws-ticket') {
      res.end(JSON.stringify({ ticket: 'tk-xyz', ttl_seconds: 30 }));
      return;
    }
    res.writeHead(404); res.end('{}');
  });
  const remote = createHermesRemote();
  const base = remote.normalizeBaseUrl(url);
  const { ticket } = await remote.wsTicket({ base, accessToken: 'AT-SECRET' });
  assert.equal(ticket, 'tk-xyz');
  assert.equal(hits[0].headers.authorization, 'Bearer AT-SECRET');
  const wsUrl = remote.wsUrl({ base, ticket });
  assert.match(wsUrl, /^ws:\/\/127\.0\.0\.1:\d+\/api\/ws\?ticket=tk-xyz$/);
  const { input, output, socket } = await remote.connectSocket({ url: wsUrl });
  input.on('error', () => {}); // a non-1000 close surfaces as a stream error
  const got = new Promise((r) => { let b = ''; input.on('data', (c) => { b += c; if (b.includes('ping')) r(b); }); });
  output.write('{"id":1,"method":"ping"}\n');
  assert.match(await got, /echo:\{"id":1/);
  socket.close();
  // Wait for the close handshake so teardown is provably complete.
  await once(input, 'close');
  await new Promise((r) => server.close(r));
});

test('path prefixes survive; credentials in URLs are refused', async () => {
  const remote = createHermesRemote();
  const base = remote.normalizeBaseUrl('https://gw.example/hermes/');
  assert.equal(remote.wsUrl({ base, ticket: 't' }), 'wss://gw.example/hermes/api/ws?ticket=t');
  assert.throws(() => remote.normalizeBaseUrl('https://u:p@gw.example'), /credentials/);
  assert.throws(() => remote.normalizeBaseUrl('ftp://gw.example'), /http/);
});

test('unreachable backend reports unreachable, not generic failure', async () => {
  const remote = createHermesRemote();
  await assert.rejects(remote.probe('http://127.0.0.1:1/dead'), (e) => { assert.equal(e.code, 'unreachable'); return true; });
});

test('WS handshake timeout settles as timeout, not unreachable — even when close() re-fires onerror', async () => {
  // A peer that accepts TCP but never answers the HTTP upgrade leaves the
  // handshake pending until our own timer fires.
  const peers = new Set();
  const silent = net.createServer((s) => {
    peers.add(s); s.on('close', () => peers.delete(s)); s.on('error', () => {});
  });
  await new Promise((r) => silent.listen(0, '127.0.0.1', r));
  const port = silent.address().port;
  const remote = createHermesRemote();
  const started = Date.now();
  await assert.rejects(
    remote.connectSocket({ url: `ws://127.0.0.1:${port}/api/ws`, timeoutMs: 300 }),
    (e) => { assert.equal(e.code, 'timeout'); return true; });
  assert.ok(Date.now() - started < 5000, 'timeout settled promptly');
  for (const s of peers) s.destroy();
  await new Promise((r) => silent.close(r));
});
