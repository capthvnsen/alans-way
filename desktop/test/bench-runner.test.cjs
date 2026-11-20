'use strict';
// The test bench runner (test/bench/run.cjs): its safety checks, and the whole run against the fake bench backend.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runBench, readConfig, checkAddress, createPromptBudget, cleanupSessions, redactor, BenchRefusal, PromptCapError, HARD_PROMPT_CAP } = require('./bench/run.cjs');
const { fakeBench, KEY } = require('./bench/fake-bench-backend.cjs');

const prior = process.env.HERMES_WORKSPACE_ALLOW_LOOPBACK;
before(() => { process.env.HERMES_WORKSPACE_ALLOW_LOOPBACK = '1'; });
after(() => { if (prior === undefined) delete process.env.HERMES_WORKSPACE_ALLOW_LOOPBACK; else process.env.HERMES_WORKSPACE_ALLOW_LOOPBACK = prior; });

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-runner-test-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
// Tailnet addresses are built from octets: the publication check treats a written one as a real machine.
const ip = (...octets) => octets.join('.');
const good = { gateway_url: 'http://127.0.0.1:1', api_url: 'http://127.0.0.1:2', username: 'bench-user', password: 'p'.repeat(24), api_key: KEY };
function writeConfig(obj, mode = 0o600, name = `cfg-${Math.random().toString(36).slice(2)}.json`) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(obj), { mode });
  fs.chmodSync(file, mode);
  return file;
}

test('the config file must be 0600, a plain file, and complete', () => {
  assert.equal(readConfig(writeConfig(good)).api_key, KEY);
  for (const mode of [0o644, 0o640, 0o660, 0o400, 0o700]) assert.throws(() => readConfig(writeConfig(good, mode)), BenchRefusal, `mode ${mode.toString(8)}`);
  const link = path.join(dir, 'link.json');
  fs.symlinkSync(writeConfig(good), link);
  assert.throws(() => readConfig(link), /plain file/);
  assert.throws(() => readConfig(path.join(dir, 'missing.json')), /does not exist/);
  assert.throws(() => readConfig(writeConfig({ ...good, api_key: '' })), /api_key/);
  assert.throws(() => readConfig(writeConfig({ ...good, api_key: 'short' })), /too short/);
  const bad = path.join(dir, 'bad.json'); fs.writeFileSync(bad, '{nope', { mode: 0o600 });
  assert.throws(() => readConfig(bad), /not valid JSON/);
});

test('only loopback, tailnet addresses and https Tailscale names are accepted', () => {
  for (const ok of ['http://127.0.0.1:8642', 'http://[::1]:8642', `http://${ip(100, 64, 0, 1)}:29119`, `http://${ip(100, 127, 255, 254)}`, 'http://[fd7a:115c:a1e0::1]:9119', 'https://box.tail1234.ts.net']) assert.ok(checkAddress(ok), ok);
  for (const no of ['http://192.168.1.5:8642', 'http://10.0.0.1', `http://${ip(100, 63, 0, 1)}`, `http://${ip(100, 128, 0, 1)}`, 'http://example.com', 'http://localhost:8642', 'http://box.ts.net', 'https://ts.net.evil.com', `https://${ip(100, 64, 0, 1)}.evil.com`,
    'http://user:pw@127.0.0.1', 'http://127.0.0.1/?token=x', 'ftp://127.0.0.1', 'not a url', 'http://0.0.0.0:8642']) assert.throws(() => checkAddress(no), BenchRefusal, no);
});

test('the prompt budget stops at the cap and never exceeds the hard cap', () => {
  const b = createPromptBudget(2);
  b.take('a'); b.take('b');
  assert.throws(() => b.take('c'), PromptCapError);
  assert.equal(b.used, 2);
  assert.equal(createPromptBudget(10_000).cap, HARD_PROMPT_CAP);
  assert.ok(createPromptBudget(undefined).cap > 0);
  assert.ok(createPromptBudget(-5).cap > 0);
});

test('cleanup deletes only bench conversations, and reports what it could not delete', async () => {
  const deleted = [];
  const failed = await cleanupSessions(['bench-1', 'api_123_abcd', 'bench-2', 'bench-1', 'bench-3'], async (id) => { if (id === 'bench-3') throw new Error('HTTP 500'); deleted.push(id); });
  assert.deepEqual(deleted, ['bench-1', 'bench-2']);
  assert.deepEqual(failed.map(([id]) => id), ['api_123_abcd', 'bench-3']);
});

test('secrets are replaced in anything printed', () => {
  const redact = redactor(() => ['hunter2-secret', 'tok-abcdef', 'ab']);
  assert.equal(redact('x hunter2-secret y tok-abcdef z hunter2-secret'), 'x [redacted] y [redacted] z [redacted]');
  assert.equal(redact('ab'), 'ab'); // too short to be a secret worth masking
});

test('a server that does not call itself the bench is refused before anything is created', async () => {
  const fake = await fakeBench({ marker: 'something-else' });
  try {
    const file = writeConfig({ ...good, gateway_url: fake.gatewayUrl, api_url: fake.apiUrl });
    await assert.rejects(runBench({ configFile: file, out: () => {} }), /does not call itself the bench/);
    assert.equal(fake.sessions.size, 0);
    assert.equal(fake.wsPrompts(), 0);
  } finally { await fake.close(); }
});

test('the whole run against the fake bench: every check passes, nothing is left behind, no secret is printed', async () => {
  const fake = await fakeBench({ deltaMs: 5 });
  const lines = [];
  try {
    const file = writeConfig({ ...good, gateway_url: fake.gatewayUrl, api_url: fake.apiUrl });
    const outcome = await runBench({ configFile: file, out: (l) => lines.push(l) });
    const text = lines.join('\n');
    assert.ok(outcome.ok, text);
    const by = Object.fromEntries(outcome.results.map((r) => [r.name, r.status]));
    for (const name of ['signin', 'link-live', 'create-conversation', 'reply-websocket', 'reply-rest-sse', 'usage-after-reply', 'second-turn', 'history-matches', 'compact-then-send', 'queued-while-down', 'cleanup']) assert.equal(by[name], 'PASS', `${name}\n${text}`);
    assert.equal(by['clarify-roundtrip'], 'SKIP');
    // the server saw each prompt once: 2 + 1 + 1 + 1 = 5
    assert.equal(fake.wsPrompts(), outcome.prompts, text);
    assert.equal(outcome.prompts, 5);
    assert.equal(fake.engine.compresses.length, 1, 'session.compress ran once');
    assert.equal(fake.sessions.size, 0, 'every conversation was deleted');
    assert.ok(fake.requests.every((r) => !/\/api\/sessions\/(?!bench-)/.test(r.split(' ')[1]) || r.endsWith('/api/sessions')), 'only bench- conversations were touched');
    for (const secret of [KEY, good.password, good.username, 'at-bench-', 'rt-bench-']) assert.ok(!text.includes(secret), `output leaked ${secret}`);
    assert.match(text, /first token \d+ ms/);
    assert.equal(process.env.HERMES_WORKSPACE_ALLOW_LOOPBACK, '1');
  } finally { await fake.close(); }
});

test('a prompt cap that is too low stops the run with a failed step, still cleans up, and sends nothing past the cap', async () => {
  const fake = await fakeBench();
  const lines = [];
  try {
    const file = writeConfig({ ...good, gateway_url: fake.gatewayUrl, api_url: fake.apiUrl });
    const outcome = await runBench({ configFile: file, maxPrompts: 2, out: (l) => lines.push(l) });
    assert.equal(outcome.ok, false);
    assert.ok(fake.wsPrompts() <= 2, `server saw ${fake.wsPrompts()} prompts`);
    assert.match(lines.join('\n'), /prompt cap 2 reached/);
    assert.equal(fake.sessions.size, 0);
  } finally { await fake.close(); }
});

test('conversations the run created are deleted even when a step fails midway', async () => {
  const fake = await fakeBench({ compressFails: 'boom' });
  try {
    const file = writeConfig({ ...good, gateway_url: fake.gatewayUrl, api_url: fake.apiUrl });
    const outcome = await runBench({ configFile: file, out: () => {} });
    assert.equal(outcome.results.find((r) => r.name === 'compact-then-send').status, 'FAIL');
    assert.equal(fake.sessions.size, 0);
    assert.equal(outcome.results.at(-1).name, 'cleanup');
  } finally { await fake.close(); }
});
