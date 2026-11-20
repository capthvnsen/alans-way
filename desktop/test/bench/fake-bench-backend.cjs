'use strict';
// A fake of the bench Hermes for the runner's own tests: the existing fake gateway (sign-in, tickets, the WebSocket
// engine) plus a loopback REST+SSE side shaped like the Hermes API server's /api/sessions routes. Fake data only.
const http = require('node:http');
const path = require('node:path');
const { fakeBackend } = require(path.join(__dirname, '..', 'hermes-auth-fake-backend.cjs'));

const KEY = 'bench-fake-key-0123456789abcdef';

async function fakeBench({ marker = 'alans-way-test-bench', key = KEY, ...cfg } = {}) {
  const be = await fakeBackend({ tokenTag: 'bench', context: { used: 3000, max: 200000 }, contextPerTurn: 800, deltaCount: 3, ...cfg });
  const engine = be.engine;
  const sessions = new Map();   // id -> { id, title, source }
  const deleted = new Set();
  const requests = [];
  let prompts = 0;

  const send = (res, status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = {}; try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch {}
      const u = new URL(req.url, 'http://h');
      requests.push(`${req.method} ${u.pathname}`);
      if (req.headers.origin) { send(res, 403, { error: { message: 'origin' } }); return; }
      if (req.headers.authorization !== `Bearer ${key}`) { send(res, 401, { error: { message: 'bad key' } }); return; }
      if (u.pathname === '/v1/models' && req.method === 'GET') { send(res, 200, { object: 'list', data: [{ id: marker, object: 'model' }] }); return; }
      if (u.pathname === '/api/sessions' && req.method === 'POST') {
        const id = String(body.id || '');
        if (!id) { send(res, 400, { error: { message: 'Invalid session ID' } }); return; }
        if (sessions.has(id) || deleted.has(id)) { send(res, 409, { error: { message: `Session already exists: ${id}` } }); return; }
        sessions.set(id, { id, title: body.title || '', source: 'api_server' });
        send(res, 201, { object: 'hermes.session', session: sessions.get(id) });
        return;
      }
      if (u.pathname === '/api/sessions' && req.method === 'GET') { send(res, 200, { data: [...sessions.values()] }); return; }
      const one = /^\/api\/sessions\/([^/]+)(\/messages|\/chat\/stream)?$/.exec(u.pathname);
      if (!one) { send(res, 404, { error: { message: 'not found' } }); return; }
      const id = decodeURIComponent(one[1]);
      if (!sessions.has(id)) { send(res, 404, { error: { message: 'no such session' } }); return; }
      if (!one[2] && req.method === 'DELETE') { sessions.delete(id); deleted.add(id); send(res, 200, {}); return; }
      if (one[2] === '/messages' && req.method === 'GET') { send(res, 200, { data: engine.history(id).slice().reverse() }); return; }
      if (one[2] === '/chat/stream' && req.method === 'POST') { stream(id, String(body.input || ''), res); return; }
      send(res, 405, { error: { message: 'method' } });
    });
  });

  // The REST turn rides the same engine as the WebSocket one and is told as SSE.
  function stream(id, text, res) {
    prompts += 1;
    const sse = (name, data) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const peer = engine.connect((frame) => {
      const { type, payload } = frame.params || {};
      if (type === 'message.start') sse('message.started', { message: { id: 'm1' } });
      if (type === 'message.delta') sse('assistant.delta', { delta: payload.text });
      if (type === 'message.complete') { sse('assistant.completed', { content: payload.text }); sse('run.completed', {}); res.end(); engine.disconnect(peer); }
    });
    const resumed = engine.handle(peer, { method: 'session.resume', params: { session_id: id } }).result;
    engine.handle(peer, { method: 'session.activate', params: { session_id: resumed.session_id } });
    sse('run.started', { run_id: `run-${prompts}` });
    engine.handle(peer, { method: 'prompt.submit', params: { session_id: resumed.session_id, text } });
  }

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    be, engine, key, marker, requests, sessions,
    apiUrl: `http://127.0.0.1:${server.address().port}`,
    gatewayUrl: be.url,
    wsPrompts: () => engine.submits.length,
    close: async () => { await new Promise((r) => { server.closeAllConnections?.(); server.close(r); }); await be.close(); },
  };
}

module.exports = { fakeBench, KEY };
