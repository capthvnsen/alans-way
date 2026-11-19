'use strict';
process.env.HERMES_WORKSPACE_ALLOW_LOOPBACK = '1'; // loopback fixtures under HERMES_WORKSPACE_REQUIRE_TAILNET=1, as the other hermes tests
// Log canary (docs/gateway-spec.md, section 7): put a canary in every token and
// ticket the backend mints, in the password, and in a message; connect, stream,
// drop the socket, fail a ticket, expire the sign-in; then assert the canary is
// nowhere in the app log file, the console, or the state the link reports.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fakeBackend } = require('./hermes-auth-fake-backend.cjs');
const { createHermesRemote } = require('../src/hermes-remote.cjs');
const { createGatewayLink, createGatewayOpener } = require('../src/gateway-link.cjs');
const { createLog } = require('../src/main-log.cjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(pred, ms = 5000, what = 'condition') {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(5); }
}

test('a token, ticket, password or message never appears in a log', async () => {
  const CANARY = 'CANARY-9d41e07b';
  const MESSAGE = `${CANARY}-message`, PASSWORD = `${CANARY}-password`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-canary-'));
  const log = createLog(dir);
  const seen = [];
  const hooks = ['log', 'error', 'warn', 'info', 'debug'].map((k) => [k, console[k]]);
  const stdout = process.stdout.write, stderr = process.stderr.write;
  for (const [k] of hooks) console[k] = (...args) => { seen.push(args.map(String).join(' ')); };
  process.stdout.write = function (chunk, ...rest) { seen.push(String(chunk)); return stdout.call(this, chunk, ...rest); };
  process.stderr.write = function (chunk, ...rest) { seen.push(String(chunk)); return stderr.call(this, chunk, ...rest); };

  let backend, link;
  let expired = false;
  const reported = [];
  try {
    backend = await fakeBackend({ authRequired: true, tokenTag: CANARY, sessions: [], deltaCount: 8, deltaMs: 15 });
    const remote = createHermesRemote();
    const base = remote.normalizeBaseUrl(backend.url);
    const tokens = await remote.signIn({ base, provider: 'basic', username: 'alice', password: PASSWORD });
    assert.ok(tokens.accessToken.includes(CANARY), 'the canary is in the credentials');
    // Expired access token: every connect refreshes (refresh token on the wire) then mints a ticket.
    const open = createGatewayOpener({ credentials: () => ({ base, tokens: { ...tokens, expiresAt: 1 } }), adoptTokens: () => {}, expireSignIn: () => { expired = true; }, remote });
    link = createGatewayLink({ open, log: (event, fields) => log.write(event, JSON.stringify(fields)),
      options: { baseMs: 5, capMs: 40, connectTimeoutMs: 1000 } });
    link.on('state', (s) => reported.push(JSON.stringify(s)));
    link.on('gap', (g) => reported.push(JSON.stringify(g)));
    link.start();
    await until(() => link.isLive(), 5000, 'live');
    await link.attach('canary-session');
    const events = [];
    link.on('event', (e) => events.push(e));
    await link.submit('canary-session', MESSAGE);
    await until(() => events.length >= 2);
    backend.dropSockets();                       // a drop mid-reply
    await until(() => events.some((e) => e.type === 'message.complete'), 8000, 'resumed reply');
    backend.cfg.ticketStatus = 500;              // attempts that fail on the ticket
    backend.dropSockets();
    await until(() => link.getState().lastError === 'http_error', 5000, 'a failed attempt');
    backend.cfg.ticketStatus = 0;
    await until(() => link.isLive(), 8000, 'recovered');
    backend.cfg.refreshStatus = 401;             // the sign-in expires
    backend.dropSockets();
    await until(() => link.getState().state === 'signin', 8000, 'signin');
    assert.equal(expired, true);
  } finally {
    // Always: restore the console first so a failure is visible, then stop everything this test started.
    for (const [k, fn] of hooks) console[k] = fn;
    process.stdout.write = stdout; process.stderr.write = stderr;
    link?.stop();
    await backend?.close();
  }
  const everything = [fs.readFileSync(log.file, 'utf8'), ...seen, ...reported, JSON.stringify(link.getState())].join('\n');
  assert.ok(everything.includes('link.state'), 'the log recorded the run');
  assert.ok(everything.includes('link.dropped'), 'and the drops');
  assert.equal(everything.includes(CANARY), false, 'no canary anywhere');
  assert.equal(/ticket=|tk-|at-|rt-/.test(fs.readFileSync(log.file, 'utf8')), false, 'no credential shape in the log file');
});
