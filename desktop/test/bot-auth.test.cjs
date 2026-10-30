const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { authorizeBot, privateJson } = require('../src/bot-auth.cjs');
const { provision } = require('../scripts/bot-credential.cjs');
const vm = require('node:vm');
const { isAuthorized } = require('../src/core.cjs');
const { spawnSync } = require('node:child_process');

test('root provisioning enforces real cross-UID file separation and rotates old tokens', { skip: process.platform !== 'linux' || process.getuid?.() !== 0 }, t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'credential-users-'));
  fs.chmodSync(base, 0o711);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'broker'), exported = path.join(base, 'exports');
  fs.mkdirSync(root, { mode: 0o700 }); fs.mkdirSync(exported, { mode: 0o711 });
  const brokerFile = path.join(root, 'connection.json');
  fs.writeFileSync(brokerFile, JSON.stringify({ url: 'http://127.0.0.1:9465', token: 'synthetic-broker-token' }), { mode: 0o600 });
  const args = { root, botId: 'a', uid: 60001, output: path.join(exported, 'a.json'), apply: true };
  provision(args);
  const old = JSON.parse(fs.readFileSync(args.output));
  assert.equal(fs.statSync(args.output).uid, 60001);
  assert.equal(fs.statSync(args.output).mode & 0o777, 0o600);
  assert.notEqual(old.token, 'synthetic-broker-token');
  assert.equal(authorizeBot(path.join(root, 'bot-credentials.json'), 'Bearer ' + old.token, 'a'), true);
  const readAs = (uid, file) => spawnSync(process.execPath, ['-e', 'try { require("node:fs").readFileSync(process.argv[1]); } catch { process.exit(1); }', file], { uid, gid: uid }).status;
  assert.equal(readAs(60001, args.output), 0);
  assert.equal(readAs(60002, args.output), 1);
  assert.equal(readAs(60001, brokerFile), 1);
  provision(args);
  assert.equal(authorizeBot(path.join(root, 'bot-credentials.json'), 'Bearer ' + old.token, 'a'), false);
});

test('the desktop API binds every route before trusting a bot header', { skip: !process.getuid }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-bot-auth-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const token = 'c'.repeat(64);
  fs.writeFileSync(path.join(root, 'bot-credentials.json'), JSON.stringify({ bots: { a: { uid: process.getuid() + 1, token } } }), { mode: 0o600 });
  const source = fs.readFileSync(require.resolve('../src/main.cjs'), 'utf8');
  const start = source.indexOf('    if (req.headers.origin', source.indexOf('function startApi()'));
  const end = source.indexOf('\n    try {', start);
  const gate = vm.runInNewContext(`(req) => { ${source.slice(start, end)}; return 200; }`, {
    send: status => status, app: { getPath: () => root }, apiPort: 1234, hostAllowed: () => true,
    isAuthorized, authorizeBot, registryFile: require('../src/bot-auth.cjs').registryFile, API_TOKEN: 'synthetic-broker-token',
  });
  const req = id => ({ headers: { authorization: 'Bearer ' + token, 'x-hermes-bot': id } });
  assert.equal(gate(req('a')), 200);
  for (const id of ['overseer', 'b', '']) assert.equal(gate(req(id)), 401);
  assert.equal(gate({ headers: { authorization: 'Bearer synthetic-broker-token' } }), 200, 'the separate broker retains its trusted operations');
});

test('identity-bound credentials reject impersonation, revoked and unsafe credentials', { skip: !process.getuid }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-auth-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'bot-credentials.json'), token = 'a'.repeat(64), other = 'b'.repeat(64);
  const write = bots => fs.writeFileSync(file, JSON.stringify({ bots }), { mode: 0o600 });
  write({ a: { token, uid: process.getuid() + 1 }, overseer: { token: other, uid: process.getuid() + 2 } });
  assert.equal(authorizeBot(file, 'Bearer ' + token, 'a'), true);
  for (const id of ['overseer', '', 'unknown', 'a\n']) assert.equal(authorizeBot(file, 'Bearer ' + token, id), false);
  assert.equal(authorizeBot(file, 'Bearer ' + other, 'a'), false);
  write({ a: { token, uid: process.getuid() } });
  assert.equal(authorizeBot(file, 'Bearer ' + token, 'a'), false, 'the broker OS user cannot be a bot');
  write({ a: { token: other, uid: process.getuid() + 1 } });
  assert.equal(authorizeBot(file, 'Bearer ' + token, 'a'), false, 'rotation revokes cached credentials immediately');
  fs.chmodSync(file, 0o644);
  assert.equal(authorizeBot(file, 'Bearer ' + other, 'a'), false);
  fs.chmodSync(file, 0o600);
  const link = path.join(root, 'link'); fs.symlinkSync(file, link);
  assert.throws(() => privateJson(link));
  fs.writeFileSync(file, '{');
  assert.equal(authorizeBot(file, 'Bearer ' + other, 'a'), false);
});

test('provisioning is dry-run by default and rejects same-user exports', { skip: !process.getuid }, t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-provision-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'broker'), exports = path.join(base, 'exports');
  fs.mkdirSync(root, { mode: 0o700 }); fs.mkdirSync(exports, { mode: 0o711 });
  fs.writeFileSync(path.join(root, 'connection.json'), JSON.stringify({ url: 'http://127.0.0.1:9465', token: 'synthetic-human-token' }), { mode: 0o600 });
  const args = { root, botId: 'a', uid: process.getuid() + 1, output: path.join(exports, 'a.json') };
  const plan = provision(args);
  assert.equal(plan.dryRun, true);
  assert.equal(JSON.stringify(plan).includes('synthetic-human-token'), false);
  assert.equal(fs.existsSync(args.output), false);
  assert.equal(fs.existsSync(path.join(root, 'bot-credentials.json')), false);
  assert.throws(() => provision({ ...args, uid: process.getuid() }), /separate/);
  assert.throws(() => provision({ ...args, output: path.join(root, 'a.json') }), /Export outside/);
});

test('desktop identity binds Allow to a credential generation and rechecks revocation', { skip: !process.getuid }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'allow-identity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'registry.json'), token = 'd'.repeat(64);
  fs.writeFileSync(file, JSON.stringify({ bots: { a: { uid: process.getuid() + 1, token } } }), { mode: 0o600 });
  const { approvalIdentity } = require('../src/bot-auth.cjs');
  const identity = approvalIdentity(file, 'Bearer ' + token, 'a', 'synthetic-broker');
  assert.equal(identity.valid(), true);
  assert.notEqual(identity.generation, token);
  assert.notEqual(identity.generation, approvalIdentity(file, 'Bearer ' + 'e'.repeat(64), 'a', 'synthetic-broker').generation);
  assert.equal(approvalIdentity(file, 'Bearer synthetic-broker', 'a', 'synthetic-broker'), undefined);
  fs.writeFileSync(file, JSON.stringify({ bots: {} }));
  assert.equal(identity.valid(), false);
});
