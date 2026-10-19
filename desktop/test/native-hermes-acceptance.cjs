'use strict';
// Runtime acceptance for the native Hermes conversation surface.
//
//   node test/native-hermes-acceptance.cjs --out <evidence-dir>
//
// What it proves, against REAL running software (no mocked gateway):
//   1. A stock `hermes serve` backend booted under macOS Seatbelt in a NEW
//      owned HERMES_HOME, loopback-only network, auth gate engaged via a
//      non-loopback dashboard.public_url + the bundled password provider.
//   2. The connector (src/hermes-remote.cjs) standalone: wrong ticket and
//      wrong password refused, real native sign-in, ws-ticket, WS + gateway.ready.
//   3. The production Electron main (src/main.cjs) + preload + renderer DOM:
//      configure → sign-in → two sessions → UI send/stream → real clarify card
//      answered through the DOM → stop → session switch with draft survival →
//      hostile markup stays literal → narrow resize → disconnect/reconnect.
//   4. Cleanup: direct process exit, owned home/port/profile/lease teardown.
//
// Confinement pattern adapted from the approved conversation-controller critic
// harness (evidence/quality/hermes-conversation-controller-critic/harness/).
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const m = process.argv[i].match(/^--([^=]+)(?:=(.*))?$/);
  if (m) args[m[1]] = m[2] !== undefined ? m[2] : (i + 1 < process.argv.length && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : true);
}
if (!args.out) { console.error('usage: --out <dir>'); process.exit(2); }
const OUT = path.resolve(String(args.out));
const HOME_ROOT = path.join(os.homedir(), '.hermes');
const SOURCE = path.resolve(String(args.source || path.join(HOME_ROOT, 'hermes-agent')));
const DRIVER = path.join(__dirname, 'native-hermes-driver.cjs');
const t0 = Date.now();
const mark = () => Date.now() - t0;
const evidence = { startedAt: new Date().toISOString(), checks: [], errors: [] };
const check = (id, ok, detail) => { evidence.checks.push({ at: mark(), id, ok: !!ok, detail }); if (!ok) { evidence.errors.push({ id, detail }); throw new Error(`check failed: ${id} ${JSON.stringify(detail)}`); } };
const note = (id, detail) => evidence.checks.push({ at: mark(), id, ok: true, detail });
const dump = (name, v) => fs.writeFileSync(path.join(OUT, name), JSON.stringify(v, null, 2) + '\n');
const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bail = (m) => { throw new Error(`preflight: ${m}`); };

// ── preflight ──────────────────────────────────────────────────────────────
if (process.platform !== 'darwin') bail('needs macOS Seatbelt');
if (!fs.existsSync('/usr/bin/sandbox-exec')) bail('sandbox-exec missing');
if (fs.existsSync(OUT)) bail('out dir exists; evidence is never overwritten');
if (!fs.existsSync(path.join(SOURCE, 'hermes_cli', 'web_server.py'))) bail('stock source missing');
if (!fs.existsSync(DRIVER)) bail('driver missing');
for (const n of ['.env', '.op.env']) if (fs.existsSync(path.join(SOURCE, n))) bail(`refuse source credential file ${n}`);
let electronBin;
try { electronBin = require('electron'); } catch { bail('electron module missing'); }
fs.mkdirSync(OUT, { recursive: true, mode: 0o700 });
if (OUT.startsWith(HOME_ROOT)) bail('out dir must not be inside the Hermes root');

const SANDBOX = '/usr/bin/sandbox-exec';
const install = path.join(HOME_ROOT, 'installs', crypto.createHash('sha256').update(SOURCE).digest('hex').slice(0, 16));
const factsPath = path.join(install, 'facts.json');
const selectedPath = path.join(install, 'pm-runtime', 'selected.json');
if (!fs.existsSync(factsPath) || !fs.existsSync(selectedPath)) bail('runtime facts/selection missing');
const venvDir = JSON.parse(fs.readFileSync(factsPath, 'utf8')).packages.venv.environment;
const generation = path.dirname(venvDir);
const pmGeneration = path.join(install, 'pm-runtime', JSON.parse(fs.readFileSync(selectedPath, 'utf8')).generation);
const PYTHON = path.join(venvDir, 'bin', 'python');
const HERMES_BIN = path.join(venvDir, 'bin', 'hermes');
for (const [gen, parent] of [[generation, path.join(install, 'environments')], [pmGeneration, path.join(install, 'pm-runtime', 'generations')]]) {
  const st = fs.lstatSync(gen, { throwIfNoEntry: false });
  if (!st || st.isSymbolicLink() || fs.realpathSync(path.dirname(gen)) !== fs.realpathSync(parent)
    || !/^[0-9a-f]{32}$/.test(path.basename(gen))
    || !fs.existsSync(path.join(gen, '.lease-managed')) || !fs.existsSync(path.join(gen, '.leases'))) {
    bail(`require committed lease-managed generation: ${gen}`);
  }
}
if (!fs.existsSync(PYTHON) || !fs.existsSync(HERMES_BIN)) bail('interpreter/launcher missing');
const leaseDirs = [generation, pmGeneration].map((g) => path.join(fs.realpathSync(g), '.leases'));
const mutexes = [path.join(install, '.install.lock'), path.join(install, 'pm-runtime', '.prepare.lock')];
for (const m of mutexes) {
  const st = fs.lstatSync(m, { throwIfNoEntry: false });
  if (!st || st.isSymbolicLink() || !st.isFile()) bail(`require existing launcher mutex: ${m}`);
}
const listDir = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }); } catch { return []; } };
const existingLeases = [];
for (const inst of listDir(path.join(HOME_ROOT, 'installs'))) {
  if (!inst.isDirectory()) continue;
  for (const sub of ['environments', 'pm-runtime/generations']) {
    for (const gen of listDir(path.join(HOME_ROOT, 'installs', inst.name, sub))) {
      if (!gen.isDirectory()) continue;
      const ld = path.join(HOME_ROOT, 'installs', inst.name, sub, gen.name, '.leases');
      for (const e of listDir(ld)) {
        const p = path.join(ld, e.name);
        if (e.isFile() || e.isSymbolicLink()) existingLeases.push(fs.realpathSync(p));
      }
    }
  }
}
const leaseBefore = {};
for (const p of existingLeases) {
  const st = fs.lstatSync(p);
  if (st.isSymbolicLink() || !st.isFile()) bail(`unrecognized lease entry: ${p}`);
  leaseBefore[p] = { sha256: sha256(p), size: st.size, mtimeNs: Number(st.mtimeNs) };
}

const ownedHome = path.join(HOME_ROOT, `nhc-${crypto.randomBytes(16).toString('hex')}`);
fs.mkdirSync(ownedHome, { mode: 0o700 });
const workDir = path.join(ownedHome, 'work');
const tmpDir = path.join(ownedHome, 'tmp');
fs.mkdirSync(workDir); fs.mkdirSync(tmpDir);
const e2eProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'nhc-electron-profile-'));

// ── Seatbelt policy (same construction as the approved critic harness) ─────
const q = (s) => JSON.stringify(s);
const realOrSelf = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const allowlist = new Set([
  fs.realpathSync(ownedHome), fs.realpathSync(SOURCE),
  fs.realpathSync(path.join(HOME_ROOT, 'installs')),
  fs.realpathSync(path.join(HOME_ROOT, 'tools')),
]);
const rootChildren = fs.readdirSync(HOME_ROOT, { withFileTypes: true })
  .map((e) => realOrSelf(path.join(HOME_ROOT, e.name)))
  .filter((p) => !allowlist.has(p));
const credentialPaths = ['.ssh', '.aws', '.gnupg', '.netrc', '.zsh_history', '.bash_history',
  '.docker', '.kube', '.config/gh', '.local/share/keyrings', 'Library/Keychains']
  .map((n) => path.join(os.homedir(), n)).filter((p) => fs.existsSync(p)).map(realOrSelf);
const leaseRegex = leaseDirs.map((d) =>
  `(regex (string-append "^" (regex-quote ${q(d)}) "/${'[0-9a-f]'.repeat(32)}$"))`);
const policy = [
  '(version 1)', '(allow default)',
  '(deny network-outbound)', '(deny network-inbound)',
  '(allow network-outbound (remote ip "localhost:*"))',
  '(allow network-inbound (local ip "localhost:*"))',
  `(deny file-write* (require-all (subpath ${q(HOME_ROOT)}) `
    + `(require-not (subpath ${q(ownedHome)})) `
    + mutexes.map((m) => `(require-not (literal ${q(m)}))`).join(' ')
    + ' ' + leaseRegex.map((r) => `(require-not ${r})`).join(' ') + '))',
  ...rootChildren.map((p) => `(deny file-read* file-write* (subpath ${q(p)}))`),
  // The `installs` dir node itself stays readable (literal) so the console
  // script's `realpath` can traverse it; only sibling installs' subtrees deny.
  `(deny file-read* file-write* (require-all (subpath ${q(path.join(HOME_ROOT, 'installs'))}) `
    + `(require-not (literal ${q(fs.realpathSync(path.join(HOME_ROOT, 'installs')))})) `
    + `(require-not (subpath ${q(fs.realpathSync(install))}))))`,
  ...existingLeases.map((p) => `(deny file-write* (subpath ${q(p)}))`),
  `(deny file-write* (subpath ${q(fs.realpathSync(SOURCE))}))`,
  `(deny file-write* (subpath ${q(fs.realpathSync(path.join(HOME_ROOT, 'tools')))}))`,
  ...credentialPaths.map((p) => `(deny file-read* file-write* (subpath ${q(p)}))`),
  `(deny file-write* (subpath ${q(path.resolve(__dirname, '..', '..'))}))`,
  `(deny file-write* (require-all (subpath ${q(os.homedir())}) `
    + `(require-not (subpath ${q(ownedHome)})) `
    + mutexes.map((m) => `(require-not (literal ${q(m)}))`).join(' ')
    + ' ' + leaseRegex.map((r) => `(require-not ${r})`).join(' ') + '))',
].join('\n') + '\n';
const policyPath = path.join(OUT, 'loopback-only.sb');
fs.writeFileSync(policyPath, policy);
dump('confinement-inputs.json', {
  root: HOME_ROOT, ownedHome, source: fs.realpathSync(SOURCE), install: fs.realpathSync(install),
  python: PYTHON, hermesBin: HERMES_BIN, mutexes, uuidLeaseDirectories: leaseDirs,
  existingLeases: leaseBefore, deniedRootChildren: rootChildren,
  deniedCredentialPaths: credentialPaths,
  scope: 'serve child only; harness, provider and Electron run outside Seatbelt.',
});

// ── owned loopback scripted provider (critic routing, same markers) ────────
const providerLog = [];
function sse(res, chunks) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.end('data: [DONE]\n\n');
}
const provider = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    let json = null;
    try { json = JSON.parse(body || 'null'); } catch { }
    const entry = { at: new Date().toISOString(), method: req.method, path: req.url, body: json, raw: json === null ? body.slice(0, 4096) : undefined };
    providerLog.push(entry);
    try {
      if (req.method === 'GET' && /\/v1\/models$/.test(req.url)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'critic-inert', object: 'model', owned_by: 'nhc-acceptance' }] }));
        return;
      }
      if (!(req.method === 'POST' && /\/v1\/chat\/completions$/.test(req.url))) {
        res.writeHead(404); res.end(JSON.stringify({ error: 'unknown path' })); return;
      }
      const messages = (json && json.messages) || [];
      const tools = (json && json.tools) || [];
      const lastUserIdx = messages.map((m) => m && m.role).lastIndexOf('user');
      const toolMsgs = lastUserIdx < 0 ? [] : messages.slice(lastUserIdx + 1).filter((m) => m.role === 'tool');
      const lastUser = lastUserIdx < 0 ? null : messages[lastUserIdx];
      const userText = lastUser ? String(typeof lastUser.content === 'string' ? lastUser.content : JSON.stringify(lastUser.content)) : '';
      const isAuxTitle = !tools.length && messages.length === 2 && messages[0].role === 'system'
        && String(messages[0].content || '').startsWith('You name chat sessions');
      entry.summary = { model: json.model, stream: !!json.stream, messageCount: messages.length,
        toolNames: tools.map((t) => t && t.function && t.function.name),
        toolResultsAfterUser: toolMsgs.length, userTextExcerpt: userText.slice(0, 160), auxTitle: isAuxTitle };

      let message, finish;
      if (isAuxTitle || !/CRITIC_(ASK|HOLD)/.test(userText)) {
        message = { role: 'assistant', content: isAuxTitle ? 'nhc session' : `CRITIC_ECHO ${userText.replace(/CRITIC_\w+/g, '').trim().slice(0, 80)}` };
        finish = 'stop';
      } else if (!toolMsgs.length) {
        const decl = tools.find((t) => t && t.function && t.function.name === 'clarify');
        if (!decl) { entry.fixtureError = 'clarify tool not advertised'; res.writeHead(500); res.end(JSON.stringify({ error: entry.fixtureError })); return; }
        const question = /CRITIC_HOLD/.test(userText) ? 'Hold this for interruption' : 'Pick a fixture fruit';
        message = { role: 'assistant', content: null, tool_calls: [{
          id: `nhc_${providerLog.length}`, type: 'function',
          function: { name: 'clarify', arguments: JSON.stringify({ questions: [{ question, choices: ['Fig', 'Plum', 'Quince'] }] }) } }] };
        finish = 'tool_calls';
      } else {
        const seen = toolMsgs.map((m) => String(m.content)).join(' ');
        entry.toolResultSeen = seen.slice(0, 400);
        const picked = /"user_response":\s*"([^"]+)"/.exec(seen)?.[1] || null;
        entry.answeredUserResponse = picked;
        message = { role: 'assistant', content: `CRITIC_TOOL_RESULT ${picked === null ? seen.slice(0, 80) : picked}` };
        finish = 'stop';
      }
      const payload = { id: `nhc-prov-${providerLog.length}`, object: 'chat.completion',
        created: Math.floor(Date.now() / 1000), model: 'critic-inert',
        choices: [{ index: 0, message, finish_reason: finish }],
        usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } };
      entry.response = payload;
      if (json.stream) {
        const delta = JSON.parse(JSON.stringify(message));
        for (const [i, tc] of (delta.tool_calls || []).entries()) tc.index = i;
        if (message.content) {
          const pieces = message.content.match(/.{1,7}/g) || [message.content];
          const frames = pieces.map((text, i) => ({ id: payload.id, object: 'chat.completion.chunk',
            created: payload.created, model: payload.model,
            choices: [{ index: 0, delta: i === 0 ? { role: 'assistant', content: text } : { content: text }, finish_reason: null }] }));
          frames.push({ id: payload.id, object: 'chat.completion.chunk', created: payload.created,
            model: payload.model, choices: [{ index: 0, delta: {}, finish_reason: finish }] });
          sse(res, frames);
        } else {
          sse(res, [
            { id: payload.id, object: 'chat.completion.chunk', created: payload.created, model: payload.model,
              choices: [{ index: 0, delta, finish_reason: null }] },
            { id: payload.id, object: 'chat.completion.chunk', created: payload.created, model: payload.model,
              choices: [{ index: 0, delta: {}, finish_reason: finish }] }]);
        }
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      }
    } catch (e) {
      entry.fixtureError = String(e && e.stack || e);
      res.writeHead(500); res.end(JSON.stringify({ error: entry.fixtureError }));
    }
    try { dump('provider-log.json', providerLog); } catch { }
  });
});

function childEnv() {
  return {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: os.homedir(),
    USER: os.userInfo().username || 'unknown',
    LOGNAME: process.env.LOGNAME || process.env.USER || os.userInfo().username || 'unknown',
    LANG: 'en_US.UTF-8', TERM: 'xterm-256color',
    TMPDIR: tmpDir,
    HERMES_HOME: ownedHome,
    HERMES_RUNTIME_DIR: path.join(ownedHome, 'runtime'),
    XDG_CONFIG_HOME: path.join(ownedHome, 'config'),
    XDG_CACHE_HOME: path.join(ownedHome, 'cache'),
    PYTHONPATH: SOURCE,
    PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1',
    NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
    HERMES_TUI_TOOLSETS: 'clarify',
    HERMES_DASHBOARD_BASIC_AUTH_USERNAME: 'nhc-agent',
    HERMES_DASHBOARD_BASIC_AUTH_PASSWORD: 'nhc-pw-7f2a-fixture',
    // A non-loopback public URL engages the real auth gate on a loopback bind.
    HERMES_DASHBOARD_PUBLIC_URL: 'https://nhc-fixture.invalid',
  };
}
function writeConfig(port) {
  const cfg = {
    _config_version: 50,
    model: { default: 'critic-inert', provider: 'custom:critic-fixture', context_length: 65536 },
    providers: {
      'critic-fixture': {
        api: `http://127.0.0.1:${port}/v1`, api_key: 'local-critic-key',
        transport: 'chat_completions', default_model: 'critic-inert',
        context_length: 65536, discover_models: false,
      },
    },
    memory: { memory_enabled: false, user_profile_enabled: false },
    approvals: { timeout: 30 },
    display: { bell_on_prompt: false, bell_on_complete: false },
    clarify: { timeout: 90 },
    model_catalog: { enabled: false },
    monitoring: { gateway_health_export: { enabled: false } },
  };
  fs.writeFileSync(path.join(ownedHome, 'config.yaml'), JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  return cfg;
}

// ── EPERM probes BEFORE the public command ─────────────────────────────────
let providerPort = 0;
let servePort = 0;
function probe() {
  const targets = [
    path.join(HOME_ROOT, 'config.yaml'), path.join(HOME_ROOT, '.env'),
    path.join(HOME_ROOT, 'auth.json'), path.join(HOME_ROOT, 'state.db'),
    path.join(SOURCE, 'hermes_cli', 'web_server.py'),
    path.join(install, 'facts.json'),
    ...existingLeases.slice(0, 4),
  ].filter((p) => fs.existsSync(p));
  const script = `import os,socket,json
r={}
for p in ${JSON.stringify(targets)}:
 try:
  fd=os.open(p,os.O_WRONLY); os.close(fd); r[p]={'blocked':False}
 except OSError as e: r[p]={'errno':e.errno,'blocked':e.errno==1}
for p in ${JSON.stringify([path.join(HOME_ROOT, '.env'), path.join(HOME_ROOT, 'state.db'), path.join(HOME_ROOT, 'profiles')])}:
 try:
  open(p).read(1); r['read:'+p]={'blocked':False}
 except OSError as e: r['read:'+p]={'errno':e.errno,'blocked':e.errno==1}
 except IsADirectoryError as e: r['read:'+p]={'errno':e.errno,'blocked':e.errno==1}
s=socket.socket(); s.settimeout(1)
try: s.connect(('192.0.2.1',443)); r['external']={'blocked':False}
except OSError as e: r['external']={'errno':e.errno,'blocked':e.errno==1}
s.close()
s=socket.socket(); s.settimeout(1)
try: s.connect(('127.0.0.1',${providerPort})); r['loopback']={'blocked':False}
except OSError as e: r['loopback']={'errno':e.errno,'blocked':e.errno==1}
s.close()
try:
 open(${JSON.stringify(path.join(ownedHome, '.write-probe'))},'w').write('x'); r['ownedWrite']={'blocked':False}
except OSError as e: r['ownedWrite']={'errno':e.errno,'blocked':e.errno==1}
print(json.dumps(r))`;
  const out = execFileSync(SANDBOX, ['-f', policyPath, PYTHON, '-c', script],
    { cwd: workDir, env: childEnv(), timeout: 20000, encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop());
}

async function httpJson(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null; try { json = text ? JSON.parse(text) : null; } catch { }
        resolve({ status: res.statusCode, json, text: text.slice(0, 2000), headers: res.headers });
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('timeout')));
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

let serveChild = null;
let electronChild = null;
async function main() {
  const { createHermesRemote } = require(path.join(__dirname, '..', 'src', 'hermes-remote.cjs'));
  note('modules', { remote: sha256(path.join(__dirname, '..', 'src', 'hermes-remote.cjs')), driver: sha256(DRIVER) });
  await new Promise((r) => provider.listen(0, '127.0.0.1', r));
  providerPort = provider.address().port;
  const cfg = writeConfig(providerPort);
  dump('effective-config.json', cfg);

  // Free port for the backend (loopback; release-then-bind race is inert here).
  servePort = await new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const backendUrl = `http://127.0.0.1:${servePort}`;

  const proof = probe();
  const blockedOk = Object.entries(proof).filter(([k]) => k !== 'loopback' && k !== 'ownedWrite')
    .every(([, v]) => v && v.blocked === true);
  check('sandbox-eperm-before-spawn', blockedOk && proof.loopback && !proof.loopback.blocked
    && proof.ownedWrite && !proof.ownedWrite.blocked, proof);
  dump('confinement-proof.json', { results: proof, beforeAnyPublicCommand: true });

  // ── stock serve under Seatbelt: the unchanged public console script ──
  const serveArgv = ['-f', policyPath, HERMES_BIN, 'serve', '--host', '127.0.0.1', '--port', String(servePort), '--no-open'];
  serveChild = spawn(SANDBOX, serveArgv, { cwd: workDir, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  evidence.serveChild = { pid: serveChild.pid, argv: serveArgv.slice(2), confinement: policyPath };
  dump('serve-process.json', evidence.serveChild);
  serveChild.stdout.on('data', (c) => { try { fs.appendFileSync(path.join(OUT, 'serve-stdout.log'), c); } catch { } });
  serveChild.stderr.on('data', (c) => { try { fs.appendFileSync(path.join(OUT, 'serve-stderr.log'), c); } catch { } });
  serveChild.once('exit', (code, sig) => { evidence.serveExit = { at: mark(), code, sig }; });

  // Wait for the public status endpoint; auth gate must be engaged.
  const remote = createHermesRemote();
  let report = null;
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    if (evidence.serveExit) throw new Error(`serve exited early: ${JSON.stringify(evidence.serveExit)}`);
    try { report = await remote.probe(backendUrl); break; } catch { await sleep(400); }
  }
  // /api/status.gateway_running tracks the messaging gateway — correctly absent
  // here (no Telegram in the fixture). Conversation readiness is proven by the
  // ticket WS + gateway.ready below.
  check('serve-status-answers', !!(report && report.status && report.status.version), report && report.status && report.status.version);
  check('auth-gate-engaged', report.authRequired === true, { authRequired: report.authRequired, flows: report.authFlows });
  const providers = await remote.providers(report.base).catch(() => []);
  check('password-provider-registered', providers.some((p) => p.supports_password === true), providers);

  // ── connector-level proof before the UI: wrong ticket refused ──
  {
    let refused = null;
    try {
      const c = await remote.connectSocket({ url: remote.wsUrl({ base: report.base, ticket: 'definitely-wrong-ticket' }), timeoutMs: 8000 });
      c.socket.close();
    } catch (e) { refused = e.code || String(e); }
    check('wrong-ws-ticket-refused', !!refused, refused);
  }
  let wrongPw = null;
  try { await remote.signIn({ base: report.base, provider: 'basic', username: 'nhc-agent', password: 'wrong-pw' }); }
  catch (e) { wrongPw = e.code || String(e); }
  check('wrong-password-refused', wrongPw === 'auth_failed', wrongPw);

  const tokens = await remote.signIn({ base: report.base, provider: 'basic', username: 'nhc-agent', password: 'nhc-pw-7f2a-fixture' });
  check('native-signin-mints-tokens', !!tokens.accessToken && !!tokens.refreshToken, { userId: tokens.userId, provider: tokens.provider });
  const { ticket } = await remote.wsTicket({ base: report.base, accessToken: tokens.accessToken });
  const conn = await remote.connectSocket({ url: remote.wsUrl({ base: report.base, ticket }) });
  const { HermesSessionWire } = require(path.join(__dirname, '..', 'src', 'hermes-session-wire.cjs'));
  const wire = new HermesSessionWire({ input: conn.input, output: conn.output });
  const ready = await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('no gateway.ready in 15s')), 15000);
    wire.on('event', (e) => { if (e?.type === 'gateway.ready') { clearTimeout(t); res(e); } });
    wire.once('close', (i) => { clearTimeout(t); rej(new Error(`wire closed before ready: ${JSON.stringify(i)}`)); });
  });
  check('gateway-ready-over-ticket-ws', typeof ready.payload?.replay_epoch === 'string', ready.payload);
  conn.socket.close();
  await new Promise((r) => setTimeout(r, 300));

  // ── Electron app over the real path (requires the visible-UI lease) ──
  if (args['backend-only']) {
    note('backend-only', 'Electron half skipped by flag; lease not granted at run time.');
    return;
  }
  const reportPath = path.join(OUT, 'driver-report.json');
  // The Electron entry is the FROZEN boundary module inside the exec copy —
  // it installs every guard (fail-closed probed) before requiring the driver,
  // which loads production main.cjs unchanged. NODE_PATH reaches the pinned
  // node_modules; package-lock.json SHA is recorded in the freeze manifest.
  const execRoot = process.env.NHC_EXEC_ROOT
    ? path.resolve(process.env.NHC_EXEC_ROOT)
    : path.resolve(__dirname, '..');
  const boundariesEntry = path.join(execRoot, 'test', 'native-hermes-boundaries.cjs');
  if (!fs.existsSync(boundariesEntry)) bail(`frozen boundary module missing: ${boundariesEntry}`);
  electronChild = spawn(electronBin, [`--user-data-dir=${e2eProfile}`, boundariesEntry], {
    env: {
      ...process.env,
      NODE_PATH: path.join(path.resolve(__dirname, '..'), 'node_modules'),
      HERMES_WORKSPACE_DATA: e2eProfile,
      HOME_OUT: OUT,
      NHC_OUT: OUT,
      HOME_TARGET: execRoot,
      HERMES_TEST_PROFILE: e2eProfile,
      NHC_FIXTURE: path.join(execRoot, 'test', 'native-hermes-driver.cjs'),
      NHC_ALLOWED_PORTS: `${servePort},${providerPort}`,
      NHC_BACKEND_URL: backendUrl,
      NHC_USERNAME: 'nhc-agent',
      NHC_PASSWORD: 'nhc-pw-7f2a-fixture',
      NHC_REPORT: reportPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  electronChild.stdout.on('data', (c) => { try { fs.appendFileSync(path.join(OUT, 'electron-stdout.log'), c); } catch { } });
  electronChild.stderr.on('data', (c) => { try { fs.appendFileSync(path.join(OUT, 'electron-stderr.log'), c); } catch { } });
  electronChild.once('exit', (code, sig) => { evidence.electronExit = { at: mark(), code, sig }; });

  const e2eDeadline = Date.now() + 300000;
  let driverReport = null;
  while (Date.now() < e2eDeadline) {
    if (fs.existsSync(reportPath)) {
      try { driverReport = JSON.parse(fs.readFileSync(reportPath, 'utf8')); } catch { }
      if (driverReport && driverReport.finished) break;
    }
    if (evidence.electronExit) break;
    await sleep(500);
  }
  check('driver-finished', !!driverReport && driverReport.finished === true,
    driverReport ? { checks: driverReport.checks?.length, failed: driverReport.failed } : { electronExit: evidence.electronExit });
  const driverFailures = (driverReport.checks || []).filter((c) => !c.ok);
  check('driver-checks-all-pass', driverFailures.length === 0, driverFailures.slice(0, 8));
  evidence.driverReport = driverReport;
  evidence.providerRequests = providerLog.length;
  evidence.chatCompletions = providerLog.filter((e) => /\/v1\/chat\/completions$/.test(e.path)).length;
}

async function teardown() {
  if (electronChild && electronChild.exitCode === null && electronChild.signalCode === null) {
    electronChild.kill('SIGTERM');
    await Promise.race([new Promise((r) => electronChild.once('exit', r)), sleep(15000)]);
    if (electronChild.exitCode === null && electronChild.signalCode === null) { electronChild.kill('SIGKILL'); await sleep(1000); }
  }
  if (serveChild && serveChild.exitCode === null && serveChild.signalCode === null) {
    serveChild.kill('SIGTERM');
    const r = await Promise.race([new Promise((res) => serveChild.once('exit', (c, s) => res({ c, s }))), sleep(25000).then(() => 'still-running')]);
    if (r === 'still-running') { serveChild.kill('SIGKILL'); await sleep(1500); }
  }
  evidence.serveExitFinal = evidence.serveExit || null;
  evidence.electronExitFinal = evidence.electronExit || null;
  await new Promise((r) => { try { provider.close(() => r()); } catch { r(); } setTimeout(r, 3000); });
  // Port teardown: backend must not keep listening after exit.
  let portClosed = true;
  try {
    await httpJson(`http://127.0.0.1:${servePort}/api/status`);
    portClosed = false;
  } catch { }
  evidence.portClosedAfterExit = portClosed;
  // Owned home is ours to remove; existing leases must be byte-identical.
  const leaseAfter = {};
  let leasesUnchanged = true;
  for (const p of existingLeases) {
    const st = fs.lstatSync(p, { throwIfNoEntry: false });
    leaseAfter[p] = st ? { sha256: sha256(p), size: st.size, mtimeNs: Number(st.mtimeNs) } : null;
    if (JSON.stringify(leaseAfter[p]) !== JSON.stringify(leaseBefore[p])) leasesUnchanged = false;
  }
  evidence.leasesUnchanged = leasesUnchanged;
  dump('cleanup.json', {
    serveExit: evidence.serveExitFinal, electronExit: evidence.electronExitFinal,
    portClosedAfterExit: portClosed, leasesUnchanged,
    ownedHome, providerRequests: evidence.providerRequests,
  });
  try { fs.rmSync(ownedHome, { recursive: true, force: true }); } catch (e) { evidence.errors.push({ id: 'owned-home-rm', detail: String(e) }); }
  evidence.ownedHomeRemoved = !fs.existsSync(ownedHome);
  try { fs.rmSync(e2eProfile, { recursive: true, force: true }); } catch { }
}

main()
  .catch((e) => { evidence.errors.push({ id: 'fatal', detail: String(e && e.stack || e) }); })
  .finally(async () => {
    try { await teardown(); } catch (e) { evidence.errors.push({ id: 'teardown', detail: String(e) }); }
    evidence.wallSeconds = (Date.now() - t0) / 1000;
    dump('evidence.json', evidence);
    try { dump('provider-log.json', providerLog); } catch { }
    const ok = evidence.errors.length === 0;
    console.log(`${ok ? 'ACCEPTANCE-PASS' : 'ACCEPTANCE-FAIL'} checks=${evidence.checks.length} errors=${evidence.errors.length} wall=${evidence.wallSeconds}s providerRequests=${evidence.providerRequests ?? '?'}`);
    if (!ok) for (const e of evidence.errors.slice(0, 6)) console.log('  ERR', JSON.stringify(e).slice(0, 400));
    process.exitCode = ok ? 0 : 1;
  });
