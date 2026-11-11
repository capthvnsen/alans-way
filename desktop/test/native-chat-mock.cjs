// In-process stand-in for the Hermes API server that replays captures from a real
// Hermes 0.23.1 (test/fixtures/native-chat). Records every request it sees.
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const DIR = path.join(__dirname, 'fixtures', 'native-chat');
const read = (name) => fs.readFileSync(path.join(DIR, name), 'utf8');
const framesOf = (name) => read(name).split(/\n\n/).filter((frame) => frame.trim()).map((frame) => `${frame}\n\n`);
const dataOf = (frame) => { const line = frame.split('\n').find((l) => l.startsWith('data: ')); return line ? JSON.parse(line.slice(6)) : null; };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function synthRows(meta, count, start) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    const user = i % 2 === 0;
    rows.push({ id: start + i, session_id: meta.id, role: user ? 'user' : 'assistant', timestamp: meta.started_at + i * 30,
      content: user ? `question ${i / 2}` : `## Result ${(i - 1) / 2}\n\n- item a\n- item b\n\n| k | v |\n|---|---|\n| x | ${i} |\n\n\`\`\`js\nconsole.log(${i});\n\`\`\`\n${'lorem ipsum '.repeat(18)}`,
      tool_calls: null, tool_name: null, finish_reason: user ? null : 'stop', display_kind: null });
  }
  return rows;
}

function createMock({ key, chunk = 0 } = {}) {
  const requests = [], sessions = new Map(), approvals = new Map(), stops = new Set();
  let nextId = 100000, served = 0;
  const listed = JSON.parse(read('sessions-list.json')).data;
  const base = JSON.parse(read('messages.json'));
  sessions.set(base.session_id, { meta: { ...listed[1], id: base.session_id, title: 'pong: hello world', message_count: base.data.length, last_active: listed[0].last_active + 10 }, rows: base.data });
  let start = 1000;
  for (const meta of listed) {
    const count = meta.title === 'seed 1k' ? 1000 : 6;
    sessions.set(meta.id, { meta, rows: synthRows(meta, count, start) });
    start += count + 10;
  }
  const mock = { requests, sessions, delayMs: 0, streamDelayMs: 0, chunk, get served() { return served; }, set served(n) { served = n; } };

  const json = (res, status, body) => { served++; res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const error = (res, status, code, message) => json(res, status, { error: { message, type: 'invalid_request_error', param: null, code } });
  const body = (req) => new Promise((resolve) => { let text = ''; req.on('data', (c) => { text += c; }); req.on('end', () => { try { resolve(text ? JSON.parse(text) : {}); } catch { resolve(null); } }); });
  const write = async (res, frame) => {
    if (!mock.chunk) { res.write(frame); return; }
    for (let i = 0; i < frame.length; i += mock.chunk) { res.write(frame.slice(i, i + mock.chunk)); await sleep(1); }
  };

  async function stream(req, res, session, input) {
    const capture = /APPROVE/.test(input) ? 'stream-approve.sse' : /MD/.test(input) ? 'stream-md.sse' : /LONG/.test(input) ? 'stream-long-cancelled.sse' : 'stream-pong.sse';
    const frames = framesOf(capture);
    const runId = dataOf(frames[0]).run_id;
    stops.delete(runId);
    served++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Hermes-Session-Id': session.meta.id });
    if (mock.streamDelayMs) await sleep(mock.streamDelayMs);
    let content = '';
    for (let i = 0; i < frames.length; i++) {
      if (res.destroyed) return;
      const frame = frames[i];
      // Paced like the real server: agent setup before the first token, then a steady stream.
      if (/^event: assistant\.delta/.test(frame)) {
        if (stops.has(runId)) continue;
        await sleep(i === 2 ? 120 : capture === 'stream-long-cancelled.sse' ? 60 : 15);
      }
      await write(res, frame);
      const data = /^event: /.test(frame) ? dataOf(frame) : null;
      if (/^event: assistant\.completed/.test(frame)) content = data.content;
      if (/^event: approval\.request/.test(frame)) {
        await new Promise((resolve) => approvals.set(runId, { requestId: data.request_id, generation: data.execution_generation, resolve }));
      }
    }
    res.end();
    const now = Date.now() / 1000;
    session.rows.push({ id: nextId++, session_id: session.meta.id, role: 'user', content: input, timestamp: now - 1, display_kind: 'internal_notification' },
      { id: nextId++, session_id: session.meta.id, role: 'assistant', content, timestamp: now, finish_reason: 'stop' },
      { id: nextId++, session_id: session.meta.id, role: 'session_meta', content: null, timestamp: now });
    session.meta.last_active = now;
  }

  function newSession(extra = {}) {
    const id = `api_${Math.floor(Date.now() / 1000)}_${(nextId++).toString(16).padStart(8, '0')}`;
    const meta = { id, source: 'api_server', title: null, started_at: Date.now() / 1000, last_active: Date.now() / 1000, message_count: 0, parent_session_id: null, ...extra };
    sessions.set(id, { meta, rows: [] });
    return sessions.get(id);
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://mock');
    requests.push({ method: req.method, path: url.pathname, search: url.search, headers: { ...req.headers } });
    if (url.pathname === '/__stats') { res.end(JSON.stringify({ served })); return; }
    if (url.pathname === '/__stream-delay') { mock.streamDelayMs = Number(url.searchParams.get('ms')) || 0; res.end('{}'); return; }
    if (url.pathname === '/__fail-approval') { mock.failApproval = true; res.end('{}'); return; }
    if (mock.delayMs) await sleep(mock.delayMs);
    if (req.headers.origin !== undefined) { served++; res.writeHead(403); res.end('Forbidden'); return; }
    if (req.headers.authorization !== `Bearer ${key}`) return error(res, 401, 'gateway_auth_failed', 'Invalid gateway API key (API_SERVER_KEY)');
    const parts = url.pathname.replace(/^\/p\/[\w.-]+/, '').split('/').filter(Boolean);
    const session = parts[0] === 'api' && parts[1] === 'sessions' && parts[2] ? sessions.get(decodeURIComponent(parts[2])) : null;
    if (parts[0] === 'api' && parts[1] === 'sessions' && parts[2] && !session) return error(res, 404, 'session_not_found', 'Session not found');
    const route = `${req.method} /${parts.map((p, i) => (i === 2 && parts[1] === 'sessions') || (i === 2 && parts[1] === 'runs') ? ':id' : p).join('/')}`;
    switch (route) {
      case 'GET /api/sessions': {
        const limit = Math.min(200, Number(url.searchParams.get('limit')) || 50), offset = Number(url.searchParams.get('offset')) || 0;
        const all = [...sessions.values()].map((s) => s.meta).sort((a, b) => b.last_active - a.last_active);
        return json(res, 200, { object: 'list', data: all.slice(offset, offset + limit), limit, offset, has_more: all.length > offset + limit });
      }
      case 'POST /api/sessions': await body(req); return json(res, 201, { object: 'hermes.session', session: newSession().meta });
      case 'GET /api/sessions/:id/messages': {
        const limit = Math.min(500, Number(url.searchParams.get('limit')) || 500), offset = Number(url.searchParams.get('offset')) || 0;
        const rows = session.rows, end = Math.max(0, rows.length - offset);
        const data = url.searchParams.get('order') === 'oldest' ? rows.slice(offset, offset + limit) : rows.slice(Math.max(0, end - limit), end);
        return json(res, 200, { object: 'list', session_id: session.meta.id, data, pagination: { limit, offset, order: url.searchParams.get('order') || 'latest', returned: data.length } });
      }
      case 'POST /api/sessions/:id/chat/stream': {
        const input = (await body(req))?.input;
        if (typeof input !== 'string') return error(res, 400, 'invalid_params', 'input is required');
        if (session.meta.source !== 'api_server') { served++; res.writeHead(500); res.end('Server got itself in trouble'); return; }
        return stream(req, res, session, input);
      }
      case 'POST /api/sessions/:id/fork': {
        await body(req);
        const copy = newSession({ title: `${session.meta.title || 'Untitled'} (copy)`, parent_session_id: session.meta.id });
        copy.rows = session.rows.map((row) => ({ ...row, id: nextId++, session_id: copy.meta.id }));
        session.meta.ended_at = Date.now() / 1000; session.meta.end_reason = 'branched';
        return json(res, 200, { object: 'hermes.session', session: copy.meta });
      }
      case 'POST /v1/runs/:id/approval': {
        const runId = parts[2], value = await body(req), pending = approvals.get(runId);
        if (!pending) return error(res, 404, 'run_not_found', 'Run not found');
        if (mock.failApproval) { mock.failApproval = false; return error(res, 500, 'server_error', 'Hermes had a problem'); }
        if (!value || Object.keys(value).sort().join() !== 'choice,execution_generation,request_id' || value.request_id !== pending.requestId || value.execution_generation !== pending.generation) return error(res, 400, 'invalid_params', 'request_id and execution_generation are required');
        approvals.delete(runId);
        pending.resolve(value.choice);
        return json(res, 200, { run_id: runId, status: 'resolved', prompt_id: value.request_id });
      }
      case 'POST /v1/runs/:id/stop': await body(req); stops.add(parts[2]); return json(res, 200, { run_id: parts[2], status: 'stopping' });
      default: return error(res, 404, 'not_found', `No route ${route}`);
    }
  }

  const server = http.createServer((req, res) => { handle(req, res).catch((e) => { try { res.destroy(e); } catch {} }); });
  mock.listen = () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => { mock.url = `http://127.0.0.1:${server.address().port}`; resolve(mock); }));
  mock.close = () => { server.closeAllConnections(); server.close(); };
  return mock;
}

module.exports = { createMock };
