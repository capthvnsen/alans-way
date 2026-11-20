'use strict';
// Spawns the real scripts/browser-mcp.cjs over stdio against a fake loopback app.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const CONNECTOR = process.env.MCP_CONNECTOR_UNDER_TEST || path.join(__dirname, '../scripts/browser-mcp.cjs');

async function fakeApp(handler) {
  const log = [];
  const sockets = new Set();
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    const entry = { method: req.method, url: req.url, headers: req.headers, body: '', closed: false };
    log.push(entry);
    res.on('close', () => { if (!res.writableFinished) entry.closed = true; });
    for await (const chunk of req) chunks.push(chunk);
    entry.body = Buffer.concat(chunks).toString();
    const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    try { await handler(entry, json, res); } catch (error) { json(500, { error: String(error.message) }); }
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server, log, port: server.address().port,
    close: () => new Promise((resolve) => { for (const socket of sockets) socket.destroy(); server.close(resolve); }),
  };
}

function writeConnection(file, app, extra = {}) {
  fs.writeFileSync(file, JSON.stringify({ url: `http://127.0.0.1:${app.port}`, token: 'fixture-token', botId: 'fixture', ...extra }));
}

// A raw JSON-RPC client: tests write bytes themselves so framing can be abused.
function startConnector({ connection, args = [], env = {}, script = CONNECTOR } = {}) {
  const child = spawn(process.execPath, [script, '--bot-id', 'fixture', '--connection', connection, ...args], {
    stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env },
  });
  const state = { stdout: '', stderr: '', lines: [], byId: new Map(), waiters: [], exited: null };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (text) => { state.stderr += text; });
  child.stdout.on('data', (text) => {
    state.stdout += text;
    let at;
    while ((at = state.stdout.indexOf('\n')) >= 0) {
      const line = state.stdout.slice(0, at); state.stdout = state.stdout.slice(at + 1);
      state.lines.push(line);
      let message; try { message = JSON.parse(line); } catch { message = undefined; }
      if (message && message.id !== undefined) state.byId.set(message.id, message);
      for (const waiter of [...state.waiters]) waiter(line, message);
    }
  });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => { state.exited = { code, signal }; resolve(state.exited); }));
  const write = (value) => child.stdin.write(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value) + '\n');
  let nextId = 100;
  const reply = (id, ms = 8000) => new Promise((resolve, reject) => {
    if (state.byId.has(id)) return resolve(state.byId.get(id));
    const timer = setTimeout(() => { state.waiters = state.waiters.filter((w) => w !== waiter); reject(new Error(`no reply to ${id}; stderr: ${state.stderr}`)); }, ms);
    const waiter = (_line, message) => { if (message && message.id === id) { clearTimeout(timer); state.waiters = state.waiters.filter((w) => w !== waiter); resolve(message); } };
    state.waiters.push(waiter);
  });
  const request = (method, params, ms) => { const id = nextId++; write({ jsonrpc: '2.0', id, method, params }); return reply(id, ms); };
  const call = async (name, args = {}, meta, ms) => {
    const response = await request('tools/call', { name, arguments: args, ...(meta ? { _meta: meta } : {}) }, ms);
    return response.result ?? response;
  };
  const callAsync = (name, args = {}, meta) => { const id = nextId++; write({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) } }); return { id, reply: (ms) => reply(id, ms) }; };
  const initialize = async () => {
    const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } });
    write({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return init;
  };
  const stop = async () => {
    if (state.exited) return;
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    await exited; clearTimeout(timer);
  };
  return { child, state, write, request, call, callAsync, reply, initialize, exited, stop };
}

function tempConnection(app, extra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-stdio-'));
  const file = path.join(dir, 'connection.json');
  if (app) writeConnection(file, app, extra);
  return { dir, file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

module.exports = { CONNECTOR, fakeApp, writeConnection, startConnector, tempConnection };
