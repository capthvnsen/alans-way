'use strict';
// Real isolated STOCK Hermes TUI-gateway proof for
// desktop/src/hermes-conversation.cjs on top of desktop/src/hermes-session-wire.cjs.
//
//   node hermes-conversation-native.cjs --out <evidence-dir> --module <conv .cjs> --wire <wire .cjs>
//
// Runs the public `python -m tui_gateway.entry` stdio launcher under macOS Seatbelt
// (loopback-only network, deny read+write on every non-allowlisted ~/.hermes entry,
// read-only source/installs) with a NEW UUID home `~/.hermes/hermes-conv-<32hex>`,
// an allowlisted environment, and an owned 127.0.0.1 scripted chat-completions
// provider. The model is a deterministic transport fixture, not agent
// intelligence; no paid or remote calls are possible inside the sandbox.
//
// Scenario: one wire, TWO synthetic sessions, one controller per session —
// streamed output through controller state, a real clarify question answered
// explicitly through the controller across the provider tool boundary (each
// session's answer verified reaching its own provider turn), session.interrupt
// via controller.stop() withdrawing a pending question, replay/open_requests
// merge, then EOF. Unsuccessful attempts are preserved in <out>; source and
// harness are frozen into evidence and executed only from fresh copies.
//
// Confinement provisioning is inherited from the hermes-session-wire builder
// fixture (same allowlist/EPERM-preflight discipline), not rebuilt.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { PassThrough } = require('node:stream');

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const m = process.argv[i].match(/^--([^=]+)(?:=(.*))?$/);
  if (!m) continue;
  if (m[2] !== undefined) args[m[1]] = m[2];
  else if (i + 1 < process.argv.length && !process.argv[i + 1].startsWith('--')) args[m[1]] = process.argv[++i];
  else args[m[1]] = true;
}
if (!args.out || !args.module || !args.wire) {
  console.error('usage: node hermes-conversation-native.cjs --out <dir> --module <hermes-conversation.cjs> --wire <hermes-session-wire.cjs>');
  process.exit(2);
}
const OUT = path.resolve(String(args.out));
const MODULE = path.resolve(String(args.module));
const WIRE_MOD = path.resolve(String(args.wire));
const HOME_ROOT = path.join(os.homedir(), '.hermes');
const SOURCE = path.resolve(String(args.source || path.join(HOME_ROOT, 'hermes-agent')));

const startedAt = new Date().toISOString();
const t0 = Date.now();
const mark = () => Date.now() - t0;

const evidence = { startedAt, argv: process.argv.slice(2), checks: [], errors: [] };
function check(id, ok, detail) {
  evidence.checks.push({ at: mark(), id, ok: !!ok, detail });
  if (!ok) throw new Error(`check failed: ${id} ${JSON.stringify(detail)}`);
}
function note(id, detail) { evidence.checks.push({ at: mark(), id, ok: true, detail }); }
function dump(name, value) {
  fs.writeFileSync(path.join(OUT, name), JSON.stringify(value, null, 2) + '\n');
}
const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function bail(msg) { throw new Error(`native harness preflight: ${msg}`); }

// ── preflight ─────────────────────────────────────────────────────────────────

if (!OUT || !MODULE || !WIRE_MOD) bail('usage: --out <dir> --module <conv.cjs> --wire <wire.cjs>');
if (process.platform !== 'darwin') bail('requires macOS Seatbelt; no unconfined fallback');
if (!fs.existsSync('/usr/bin/sandbox-exec')) bail('/usr/bin/sandbox-exec missing');
if (!fs.existsSync(MODULE)) bail(`controller module not found: ${MODULE}`);
if (!fs.existsSync(WIRE_MOD)) bail(`wire module not found: ${WIRE_MOD}`);
if (fs.existsSync(OUT)) bail('out dir already exists; evidence is never overwritten');
fs.mkdirSync(OUT, { recursive: true, mode: 0o700 });
if (OUT.startsWith(HOME_ROOT + '/') || OUT.startsWith(path.join(HOME_ROOT, '/')))
  bail('out dir must be outside the Hermes root');
if (!(OUT.startsWith('/'))) bail('out dir must be absolute');
if (OUT === HOME_ROOT || OUT === os.homedir()) bail('refusing dangerous out dir');

const SANDBOX = '/usr/bin/sandbox-exec';
if (!fs.existsSync(path.join(SOURCE, 'tui_gateway', 'entry.py'))) bail('stock launcher missing');
for (const n of ['.env', '.op.env']) {
  if (fs.existsSync(path.join(SOURCE, n))) bail(`refuse source credential fallback: ${n}`);
}

// Resolve the managed venv interpreter exactly like the proven fixture:
// installs/<sha256(source)[:16]>/facts.json → packages.venv.environment.
const install = path.join(HOME_ROOT, 'installs', crypto.createHash('sha256').update(SOURCE).digest('hex').slice(0, 16));
const factsPath = path.join(install, 'facts.json');
const selectedPath = path.join(install, 'pm-runtime', 'selected.json');
if (!fs.existsSync(factsPath) || !fs.existsSync(selectedPath)) bail('runtime facts/selection missing');
const venvDir = JSON.parse(fs.readFileSync(factsPath, 'utf8')).packages.venv.environment;
const generation = path.dirname(venvDir);   // facts.environment → <generation>/venv
const pmGeneration = path.join(install, 'pm-runtime', JSON.parse(fs.readFileSync(selectedPath, 'utf8')).generation);
const PYTHON = path.join(venvDir, 'bin', 'python');
for (const [gen, parent] of [[generation, path.join(install, 'environments')],
                            [pmGeneration, path.join(install, 'pm-runtime', 'generations')]]) {
  const st = fs.lstatSync(gen, { throwIfNoEntry: false });
  if (!st || st.isSymbolicLink() || fs.realpathSync(path.dirname(gen)) !== fs.realpathSync(parent)
      || !/^[0-9a-f]{32}$/.test(path.basename(gen))
      || !fs.existsSync(path.join(gen, '.lease-managed')) || !fs.existsSync(path.join(gen, '.leases'))) {
    bail(`require a committed lease-managed generation: ${gen}`);
  }
}
if (!fs.existsSync(PYTHON)) bail(`managed interpreter missing: ${PYTHON}`);
const leaseDirs = [generation, pmGeneration].map((g) => path.join(fs.realpathSync(g), '.leases'));
const mutexes = [path.join(install, '.install.lock'), path.join(install, 'pm-runtime', '.prepare.lock')];
for (const m of mutexes) {
  const st = fs.lstatSync(m, { throwIfNoEntry: false });
  if (!st || st.isSymbolicLink() || !st.isFile()) bail(`require existing launcher mutex: ${m}`);
}
// Every installs/**/.leases file is protected; targeted dirs only (no full tree walk).
const existingLeases = [];
const listDir = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }); } catch { return []; } };
function collectLeases() {
  const installsDir = path.join(HOME_ROOT, 'installs');
  for (const inst of listDir(installsDir)) {
    if (!inst.isDirectory()) continue;
    for (const sub of ['environments', 'pm-runtime/generations']) {
      const gens = path.join(installsDir, inst.name, sub);
      for (const gen of listDir(gens)) {
        if (!gen.isDirectory()) continue;
        const ld = path.join(gens, gen.name, '.leases');
        for (const e of listDir(ld)) {
          const p = path.join(ld, e.name);
          if (e.isFile() || e.isSymbolicLink()) existingLeases.push(fs.realpathSync(p));
        }
      }
    }
  }
}
collectLeases();
const leaseBefore = {};
const leaseDisappeared = [];
for (const p of existingLeases) {
  try {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink() || !st.isFile()) bail(`unrecognized lease entry: ${p}`);
    leaseBefore[p] = { sha256: sha256(p), size: st.size, mtimeNs: Number(st.mtimeNs) };
  } catch (e) { if (e.code === 'ENOENT') leaseDisappeared.push(p); else throw e; }
}

// New exclusively-owned home, UUID-named, directly under the default root.
const ownedHome = path.join(HOME_ROOT, `hermes-conv-${crypto.randomBytes(16).toString('hex')}`);
fs.mkdirSync(ownedHome, { mode: 0o700 });
const workDir = path.join(ownedHome, 'work');
const tmpDir = path.join(ownedHome, 'tmp');
fs.mkdirSync(workDir); fs.mkdirSync(tmpDir);

// ── Seatbelt policy ───────────────────────────────────────────────────────────
// allow default; loopback-only network; ~/.hermes read+write allowlist; sensitive
// credential dirs denied outright; workspace write-denied; $HOME writes denied
// except the owned home.

const q = (s) => JSON.stringify(s);
const realOrSelf = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const allowlist = new Set([
  fs.realpathSync(ownedHome), fs.realpathSync(SOURCE),
  fs.realpathSync(path.join(HOME_ROOT, 'installs')),
  fs.realpathSync(path.join(HOME_ROOT, 'tools')),
]);
// Every existing non-allowlisted entry under the default root (other homes,
// default config/auth/history/state/profiles/…) is read+write denied. The root
// dir itself stays stat-able so traversal into the allowlisted paths works.
const rootChildren = fs.readdirSync(HOME_ROOT, { withFileTypes: true })
  .map((e) => realOrSelf(path.join(HOME_ROOT, e.name)))
  .filter((p) => !allowlist.has(p));
const credentialPaths = ['.ssh', '.aws', '.gnupg', '.netrc', '.zsh_history', '.bash_history',
  '.docker', '.kube', '.config/gh', '.local/share/keyrings', 'Library/Keychains']
  .map((n) => path.join(os.homedir(), n)).filter((p) => fs.existsSync(p))
  .map(realOrSelf);

const leaseRegex = leaseDirs.map((d) =>
  `(regex (string-append "^" (regex-quote ${q(d)}) "/${'[0-9a-f]'.repeat(32)}$"))`);
const policy = [
  '(version 1)', '(allow default)',
  '(deny network-outbound)', '(deny network-inbound)',
  '(allow network-outbound (remote ip "localhost:*"))',
  '(allow network-inbound (local ip "localhost:*"))',
  // Writes under the default root: denied except the owned home, the launcher's
  // mutex files, and NEW UUID lease entries under existing .leases dirs.
  `(deny file-write* (require-all (subpath ${q(HOME_ROOT)}) `
    + `(require-not (subpath ${q(ownedHome)})) `
    + mutexes.map((m) => `(require-not (literal ${q(m)}))`).join(' ')
    + ' ' + leaseRegex.map((r) => `(require-not ${r})`).join(' ') + '))',
  // Existing entries of the default home are not readable or writable at all.
  ...rootChildren.map((p) => `(deny file-read* file-write* (subpath ${q(p)}))`),
  // Installs outside the active one are other runtimes: no read, no write.
  `(deny file-read* file-write* (require-all (subpath ${q(path.join(HOME_ROOT, 'installs'))}) `
    + `(require-not (subpath ${q(fs.realpathSync(install))}))))`,
  // Inside the active install, snapshot-time lease files are pinned.
  ...existingLeases.map((p) => `(deny file-write* (subpath ${q(p)}))`),
  // Source checkout and managed runtimes stay read-only.
  `(deny file-write* (subpath ${q(fs.realpathSync(SOURCE))}))`,
  `(deny file-write* (subpath ${q(fs.realpathSync(path.join(HOME_ROOT, 'tools')))}))`,
  // Credential/state stores elsewhere in $HOME.
  ...credentialPaths.map((p) => `(deny file-read* file-write* (subpath ${q(p)}))`),
  // The whole rest of $HOME (incl. this workspace and the evidence dir) is
  // write-denied for the child. Seatbelt denies are cumulative: the launcher
  // mutex/lease exemptions must be repeated here or this rule still blocks them.
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
  python: PYTHON, mutexes, uuidLeaseDirectories: leaseDirs,
  existingLeases: leaseBefore, leasesDisappearedDuringSnapshot: leaseDisappeared,
  deniedRootChildren: rootChildren, deniedCredentialPaths: credentialPaths,
  scope: 'Child policy only; the harness process, provider endpoint and audit are outside Seatbelt.',
});

// ── owned loopback scripted provider ─────────────────────────────────────────
// Deterministic transport fixture: OpenAI-compatible /v1/chat/completions (+/v1/models).
// It validates the actually-advertised `clarify` tool schema before emitting any
// scripted tool_call, and records every request verbatim for the audit log.
// Two scenarios: CONV_FRUIT → clarify question answered by the controller;
// CONV_HOLD → clarify the harness deliberately leaves open until interrupt.

const providerLog = [];
const declarationChecks = [];
const FRUIT_Q = 'Pick a harmless fixture fruit for this turn';
const HOLD_Q = 'Fixture hold question — the harness will interrupt instead of answering';

function validateClarifySchema(decl) {
  const p = decl && decl.function && decl.function.parameters;
  const props = p && p.properties && p.properties.questions;
  const itemProps = props && props.items && props.items.properties;
  return !!(p && Array.isArray(p.required) && p.required.includes('questions')
    && props && props.type === 'array'
    && itemProps && itemProps.question && itemProps.question.type === 'string'
    && (!itemProps.choices || itemProps.choices.type === 'array'));
}

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
    try { json = JSON.parse(body || 'null'); } catch { /* recorded below */ }
    const entry = { at: new Date().toISOString(), method: req.method, path: req.url, body: json, raw: json === null ? body.slice(0, 4096) : undefined };
    providerLog.push(entry);
    try {
      if (req.method === 'GET' && /\/v1\/models$/.test(req.url)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'fixture-inert', object: 'model', owned_by: 'local-wire-fixture', context_length: 65536 }] }));
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
        toolNames: tools.map((t) => t && t.function && t.function.name), toolResults: toolMsgs.length,
        userTextExcerpt: userText.slice(0, 160), auxTitle: isAuxTitle };
      if (tools.length) {
        const decl = tools.find((t) => t && t.function && t.function.name === 'clarify');
        declarationChecks.push({ at: entry.at, requestIndex: providerLog.length - 1,
          advertisedNames: entry.summary.toolNames,
          clarifyDeclared: !!decl, clarifySchemaOk: validateClarifySchema(decl),
          clarifySchema: decl && decl.function && decl.function.parameters });
      }

      let message, finish;
      if (isAuxTitle || !/CONV_FIXTURE/.test(userText)) {
        message = { role: 'assistant', content: isAuxTitle ? 'conversation fixture session' : 'Nothing to save.' };
        finish = 'stop';
      } else if (!toolMsgs.length) {
        const decl = tools.find((t) => t && t.function && t.function.name === 'clarify');
        if (!decl || !validateClarifySchema(decl)) {
          entry.fixtureError = 'clarify tool not declared with the expected schema';
          res.writeHead(500); res.end(JSON.stringify({ error: entry.fixtureError })); return;
        }
        const question = /CONV_HOLD/.test(userText)
          ? { question: HOLD_Q, choices: ['Alpha', 'Beta'] }
          : { question: FRUIT_Q, choices: ['Apple', 'Banana'] };
        message = { role: 'assistant', content: null, tool_calls: [{
          id: `fixture_${providerLog.length}`, type: 'function',
          function: { name: 'clarify', arguments: JSON.stringify({ questions: [question] }) } }] };
        finish = 'tool_calls';
      } else {
        const seen = toolMsgs.map((m) => String(m.content)).join(' ');
        const fruit = /"user_response":\s*"([^"]+)"/.exec(seen)?.[1] || 'NONE';
        entry.answeredUserResponse = fruit;
        message = { role: 'assistant', content: `CONV_FIXTURE_ANSWERED ${fruit}` };
        finish = 'stop';
      }
      const payload = { id: `local-fixture-${providerLog.length}`, object: 'chat.completion',
        created: Math.floor(Date.now() / 1000), model: 'fixture-inert',
        choices: [{ index: 0, message, finish_reason: finish }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } };
      entry.response = payload;
      if (json.stream) {
        const delta = JSON.parse(JSON.stringify(message));
        for (const [i, tc] of (delta.tool_calls || []).entries()) tc.index = i;
        if (message.content) {
          const pieces = message.content.match(/.{1,8}/g) || [message.content];
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
              choices: [{ index: 0, delta: {}, finish_reason: finish }] },
          ]);
        }
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      }
    } catch (e) {
      entry.fixtureError = String(e && e.stack || e);
      res.writeHead(500); res.end(JSON.stringify({ error: entry.fixtureError }));
    }
    dump('provider-log.json', providerLog);
    dump('declaration-validation.json', declarationChecks);
  });
});

// ── child env + config ────────────────────────────────────────────────────────

function childEnv() {
  return {
    PATH: ['/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
    HOME: os.homedir(),
    USER: (os.userInfo().username || process.env.USER || 'unknown'),
    LOGNAME: (process.env.LOGNAME || process.env.USER || os.userInfo().username || 'unknown'),
    LANG: 'en_US.UTF-8',
    TERM: 'xterm-256color',
    TMPDIR: tmpDir,
    HERMES_HOME: ownedHome,
    HERMES_RUNTIME_DIR: path.join(ownedHome, 'runtime'),
    XDG_CONFIG_HOME: path.join(ownedHome, 'config'),
    XDG_CACHE_HOME: path.join(ownedHome, 'cache'),
    PYTHONPATH: SOURCE,
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONUNBUFFERED: '1',
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
    HERMES_TUI_TOOLSETS: 'clarify',   // pinned minimal public tool surface
  };
}

// Minimal hand-written config in the owned home (JSON is valid YAML 1.2).
function writeConfig(port) {
  const cfg = {
    _config_version: 50,
    model: { default: 'fixture-inert', provider: 'custom:wire-fixture', context_length: 65536 },
    providers: {
      'wire-fixture': {
        api: `http://127.0.0.1:${port}/v1`, api_key: 'local-wire-fixture-key',
        transport: 'chat_completions', default_model: 'fixture-inert',
        context_length: 65536, discover_models: false,
      },
    },
    memory: { memory_enabled: false, user_profile_enabled: false },
    approvals: { timeout: 30 },
    display: { bell_on_prompt: false, bell_on_complete: false },
    clarify: { timeout: 30 },
    model_catalog: { enabled: false },
    monitoring: { gateway_health_export: { enabled: false } },
  };
  fs.writeFileSync(path.join(ownedHome, 'config.yaml'), JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  return cfg;
}

// ── sandbox preflight probe (EPERM gates BEFORE any public command) ──────────

function probe() {
  const targets = [
    path.join(HOME_ROOT, 'config.yaml'), path.join(HOME_ROOT, '.env'),
    path.join(HOME_ROOT, 'auth.json'), path.join(HOME_ROOT, 'state.db'),
    path.join(SOURCE, 'tui_gateway', 'entry.py'),
    path.join(install, 'facts.json'),
    ...existingLeases.slice(0, 4),
  ].filter((p) => fs.existsSync(p));
  const script = `import os,socket,json,sys
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
print(json.dumps(r))
`;
  const out = execFileSync(SANDBOX, ['-f', policyPath, PYTHON, '-c', script],
    { cwd: workDir, env: childEnv(), timeout: 20000, encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop());
}

// ── gateway child + wire tap logging ─────────────────────────────────────────

let providerPort = 0;
let child = null;
let wire = null;
const wireLog = [];
const controllerStates = { A: [], B: [] };
function logWire(direction, chunk) {
  for (const lineText of String(chunk).split('\n')) {
    if (lineText) wireLog.push({ at: new Date().toISOString(), direction, line: lineText });
  }
}
function flushWireLog() {
  fs.writeFileSync(path.join(OUT, 'wire-log.jsonl'),
    wireLog.map((r) => JSON.stringify(r)).join('\n') + (wireLog.length ? '\n' : ''));
}

async function waitFor(pred, label, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`timeout waiting for ${label}`)); }, timeoutMs);
    const onEvent = (e) => { if (pred(e)) { cleanup(); resolve(e); } };
    const onReq = (r) => { if (pred(r)) { cleanup(); resolve(r); } };
    const onClose = (c) => { cleanup(); reject(new Error(`wire closed waiting for ${label}: ${JSON.stringify(c)}`)); };
    function cleanup() {
      clearTimeout(timer);
      wire.removeListener('event', onEvent); wire.removeListener('serverRequest', onReq);
      wire.removeListener('close', onClose);
    }
    wire.on('event', onEvent); wire.on('serverRequest', onReq); wire.once('close', onClose);
  });
}

// Wait until a predicate on a controller snapshot holds (subscription-driven).
function waitState(conv, pred, label, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { un(); reject(new Error(`timeout waiting for ${label}`)); }, timeoutMs);
    const checkNow = (s) => { if (pred(s)) { un(); clearTimeout(timer); resolve(s); } };
    const un = conv.subscribe(checkNow);
    checkNow(conv.getState());
  });
}

async function main() {
  const { HermesSessionWire } = require(WIRE_MOD);
  const { HermesConversation } = require(MODULE);
  note('modules-loaded', { module: MODULE, moduleSha256: sha256(MODULE),
    wire: WIRE_MOD, wireSha256: sha256(WIRE_MOD) });

  // 1. Provider up; config written; EPERM probe before the public launcher.
  await new Promise((r) => provider.listen(0, '127.0.0.1', r));
  providerPort = provider.address().port;
  note('provider-listening', { port: providerPort });
  const cfg = writeConfig(providerPort);
  dump('effective-config.json', cfg);
  const proof = probe();
  const blockedOk = Object.entries(proof).filter(([k]) => k !== 'loopback' && k !== 'ownedWrite')
    .every(([, v]) => v && v.blocked === true);
  check('sandbox-eperm-gates-before-launch', blockedOk
    && proof.loopback && !proof.loopback.blocked
    && proof.ownedWrite && !proof.ownedWrite.blocked, proof);
  dump('confinement-proof.json', { results: proof, beforeAnyHermesCommand: true,
    safety: 'O_WRONLY open only; no create/truncate/write of existing entries, no contents read.' });

  // 2. Launch the stock public module under Seatbelt; tap both directions.
  child = spawn(SANDBOX, ['-f', policyPath, PYTHON, '-m', 'tui_gateway.entry'], {
    cwd: workDir, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'],
  });
  evidence.child = { argv: [PYTHON, '-m', 'tui_gateway.entry'], pid: child.pid,
    confinement: 'sandbox-exec ' + policyPath };
  dump('owned-process.json', { pid: child.pid, argv: evidence.child.argv, cwd: workDir });
  child.stderr.on('data', (c) => { try { fs.appendFileSync(path.join(OUT, 'gateway-stderr.log'), c); } catch {} });
  const toChild = new PassThrough();
  toChild.on('data', (c) => logWire('client-to-gateway', c));
  toChild.pipe(child.stdin);
  child.stdout.on('data', (c) => logWire('gateway-to-client', c));
  wire = new HermesSessionWire({ input: child.stdout, output: toChild, defaultTimeoutMs: 60000 });

  // 3. Fixture caller owns gateway.ready + session creation; capture the epoch.
  const ready = await waitFor((e) => e.type === 'gateway.ready', 'gateway.ready', 30000);
  const epoch = ready.payload && ready.payload.replay_epoch;
  check('gateway-ready', typeof epoch === 'string' && !!epoch, { replay_epoch: epoch });

  const createdA = await wire.call('session.create', { title: 'conv fixture A', cwd: workDir, source: 'conv-fixture' });
  const createdB = await wire.call('session.create', { title: 'conv fixture B', cwd: workDir, source: 'conv-fixture' });
  check('sessions-created', createdA.session_id && createdB.session_id
    && createdA.session_id !== createdB.session_id,
    { a: createdA.session_id, b: createdB.session_id });
  const active = await wire.call('session.active_list', {});
  const rowA = active.sessions.find((r) => r.id === createdA.session_id);
  const rowB = active.sessions.find((r) => r.id === createdB.session_id);
  check('session-keys-observed', !!(rowA && rowB && rowA.session_key && rowB.session_key
    && rowA.session_key !== rowB.session_key),
    { a: rowA && rowA.session_key, b: rowB && rowB.session_key });

  // 4. Two controllers, one shared wire, explicit reviewed identities.
  const convA = new HermesConversation({ wire, identity: {
    profile: 'fixture-profile', sessionKey: rowA.session_key, sessionId: createdA.session_id, reviewed: true } });
  const convB = new HermesConversation({ wire, identity: {
    profile: 'fixture-profile', sessionKey: rowB.session_key, sessionId: createdB.session_id, reviewed: true } });
  convA.subscribe((s) => controllerStates.A.push({ at: mark(), phase: s.phase,
    transcript: s.transcript.length, turnText: s.turn ? s.turn.text : null,
    pending: s.pendingRequests.map((r) => r.id), lastSend: s.lastSend && s.lastSend.outcome }));
  convB.subscribe((s) => controllerStates.B.push({ at: mark(), phase: s.phase,
    transcript: s.transcript.length, turnText: s.turn ? s.turn.text : null,
    pending: s.pendingRequests.map((r) => r.id), lastSend: s.lastSend && s.lastSend.outcome }));

  const boundA = await convA.bind({ expectedEpoch: epoch });
  const boundB = await convB.bind({ expectedEpoch: epoch });
  check('controllers-bound', boundA.phase === 'bound' && boundB.phase === 'bound'
    && boundA.attested.replayEpoch === epoch && boundB.attested.replayEpoch === epoch
    && boundA.attested.sessionId === createdA.session_id
    && boundB.attested.sessionId === createdB.session_id,
    { a: boundA.attested && boundA.attested.sessionKey, b: boundB.attested && boundB.attested.sessionKey,
      advertisedA: boundA.attested.serverRequestMethods.length });

  // 5. Turn 1 on each session: clarify pending in the owning controller only.
  const pendA = waitState(convA, (s) => s.pendingRequests.some((r) => r.method === 'clarify'),
    'clarify pending in A', 90000);
  const pendB = waitState(convB, (s) => s.pendingRequests.some((r) => r.method === 'clarify'),
    'clarify pending in B', 90000);
  const sub1 = await convA.send('CONV_FIXTURE turn A1 — please ask the fixture question');
  check('submit-A-streaming', sub1 && sub1.status === 'streaming', sub1);
  const sub2 = await convB.send('CONV_FIXTURE turn B1 — please ask the fixture question');
  check('submit-B-streaming', sub2 && sub2.status === 'streaming', sub2);
  const [pa, pb] = await Promise.all([pendA, pendB]);
  const reqA = pa.pendingRequests.find((r) => r.method === 'clarify');
  const reqB = pb.pendingRequests.find((r) => r.method === 'clarify');
  check('clarify-pending-attributed', reqA && reqB && reqA.id !== reqB.id
    && /^srq-[0-9a-f]{12}$/.test(String(reqA.id)) && /^srq-[0-9a-f]{12}$/.test(String(reqB.id))
    && reqA.attributed === true && reqB.attributed === true
    && reqA.supported === true && reqB.supported === true,
    { a: reqA && { id: reqA.id, sessionId: reqA.sessionId, questions: reqA.params.questions },
      b: reqB && { id: reqB.id, sessionId: reqB.sessionId, questions: reqB.params.questions } });
  check('no-cross-session-pending',
    convA.getState().pendingRequests.every((r) => r.sessionId === createdA.session_id)
    && convB.getState().pendingRequests.every((r) => r.sessionId === createdB.session_id),
    { aPending: convA.getState().pendingRequests.map((r) => r.id),
      bPending: convB.getState().pendingRequests.map((r) => r.id) });

  // 6. Answer in REVERSE session order — B's question first, then A's — each
  // through the owning controller, with the declared question id.
  const qidOf = (r) => (Array.isArray(r.params.questions) && r.params.questions[0]
    && typeof r.params.questions[0].qid === 'string' ? r.params.questions[0].qid : 'q0');
  const doneA = waitState(convA, (s) => s.turn === null && s.transcript.some((m) => m.role === 'assistant'),
    'A assistant row', 90000);
  const doneB = waitState(convB, (s) => s.turn === null && s.transcript.some((m) => m.role === 'assistant'),
    'B assistant row', 90000);
  await convB.answerRequest(reqB.id, { answers: { [qidOf(reqB)]: 'Plum' } });
  await convA.answerRequest(reqA.id, { answers: { [qidOf(reqA)]: 'Apple' } });
  note('clarify-answered-reverse-order', { first: reqB.id, second: reqA.id });
  await assertReject(() => convA.answerRequest(reqA.id, { answers: { [qidOf(reqA)]: 'Banana' } }),
    'unknown_request', 'clarify-single-use');
  const [finA, finB] = await Promise.all([doneA, doneB]);
  const rowA2 = finA.transcript.at(-1);
  const rowB2 = finB.transcript.at(-1);
  check('turn-A-streamed-through-controller', /CONV_FIXTURE_ANSWERED Apple/.test(String(rowA2.text)),
    { text: String(rowA2.text).slice(0, 300), status: rowA2.status,
      deltaSeen: controllerStates.A.some((s) => typeof s.turnText === 'string' && s.turnText.includes('CONV_FIXTURE')) });
  check('turn-B-streamed-through-controller', /CONV_FIXTURE_ANSWERED Plum/.test(String(rowB2.text)),
    { text: String(rowB2.text).slice(0, 300), status: rowB2.status,
      deltaSeen: controllerStates.B.some((s) => typeof s.turnText === 'string' && s.turnText.includes('CONV_FIXTURE')) });
  const hopA = providerLog.find((e2) => e2.answeredUserResponse === 'Apple');
  const hopB = providerLog.find((e2) => e2.answeredUserResponse === 'Plum');
  check('answers-reached-own-provider-turns', !!hopA && !!hopB, {
    a: hopA && hopA.answeredUserResponse, b: hopB && hopB.answeredUserResponse });

  // 7. Turn 2 on A: a clarify we deliberately leave open → stop() interrupts;
  // the gateway withdraws it and the controller records the outcome.
  const holdP = waitState(convA, (s) => s.pendingRequests.some((r) => r.method === 'clarify'),
    'A hold clarify', 90000);
  await convA.send('CONV_FIXTURE CONV_HOLD turn A2');
  const holdReq = (await holdP).pendingRequests.find((r) => r.method === 'clarify');
  check('hold-pending', holdReq && holdReq.id !== reqA.id, { id: holdReq.id });
  const stopRes = await convA.stop();
  check('stop-result', stopRes && typeof stopRes.status === 'string', stopRes);
  // The RPC result alone must not have ended the turn or the request.
  const mid = convA.getState();
  check('stop-not-premature', mid.pendingRequests.some((r) => r.id === holdReq.id)
    || mid.turn !== null, { pending: mid.pendingRequests.map((r) => r.id), turn: !!mid.turn });
  const settled = await waitState(convA,
    (s) => s.requestOutcomes.some((o) => o.id === holdReq.id && o.outcome === 'withdrawn'),
    'withdrawal outcome', 30000);
  const outcome = settled.requestOutcomes.find((o) => o.id === holdReq.id);
  check('request-withdrawn-on-interrupt', outcome && typeof outcome.cancelReason === 'string',
    outcome);
  await assertReject(() => convA.answerRequest(holdReq.id, { answers: { q0: 'late' } }),
    'unknown_request', 'withdrawn-request-not-answerable');
  const finalA = await waitState(convA, (s) => s.turn === null, 'A turn terminal', 60000)
    .then(() => convA.getState());
  check('turn-terminal-after-interrupt', finalA.turn === null
    && finalA.transcript.at(-1).status !== 'complete', {
    lastRow: finalA.transcript.at(-1) && { role: finalA.transcript.at(-1).role, status: finalA.transcript.at(-1).status } });

  // 8. Replay/open_requests merge on THIS wire (same epoch).
  const replay = await convB.syncFromReplay();
  check('replay-sync', replay.truncated === false && typeof replay.applied === 'number',
    replay);

  // 9. Dispose B only — A's subscriptions and the wire survive.
  convB.dispose();
  check('dispose-scoped', convB.getState().phase === 'disposed'
    && convA.getState().phase === 'bound' && wire.state === 'open', {});

  // 10. EOF: close only the owned output → gateway stdin EOF → exit.
  wire.close();
  await sleep(150);
  const endA = convA.getState();
  check('close-disconnects-controller', endA.phase === 'disconnected' && endA.connectivity === 'closed'
    && wire.pendingCalls.length === 0, { phase: endA.phase, connectivity: endA.connectivity });
  await assertReject(() => convA.send('post-eof'), 'disconnected', 'send-after-disconnect');
  const eofExit = await Promise.race([
    new Promise((r) => child.once('exit', (code, sig) => r({ code, sig }))),
    sleep(20000).then(() => 'still-running'),
  ]);
  note('eof-exit', eofExit);
  if (eofExit === 'still-running') {
    child.kill('SIGTERM');
    const t = await Promise.race([new Promise((r) => child.once('exit', (c, s) => r({ code: c, sig: s }))), sleep(8000).then(() => 'term-hung')]);
    if (t === 'term-hung') { child.kill('SIGKILL'); await new Promise((r) => child.once('exit', r)); }
    evidence.errors.push('gateway did not exit on EOF; needed signals: ' + JSON.stringify(t));
  }
  evidence.eofExit = eofExit;
  evidence.cleanupExit = { exitCode: child.exitCode, signal: child.signalCode };
  check('child-exited', child.exitCode !== null || child.signalCode !== null, evidence.cleanupExit);
  convA.dispose();
  return { sidA: createdA.session_id, sidB: createdB.session_id };
}

async function assertReject(fn, code, checkId) {
  let ok = false; let got = null;
  try { await fn(); } catch (e) { got = e; ok = e && e.code === code; }
  check(checkId, ok, { expected: code, got: got && { code: got.code, message: got.message } });
}

// ── cleanup + audit ───────────────────────────────────────────────────────────

async function audit() {
  if (child && child.pid) {
    let alive = true;
    try { process.kill(child.pid, 0); } catch (e) { alive = e.code !== 'ESRCH'; }
    dump('owned-pid-final.json', { pid: child.pid, alive });
    if (alive) evidence.errors.push(`owned pid ${child.pid} still alive after exit`);
  }
  try {
    const out = execFileSync('/usr/sbin/lsof', ['-nP', '-Fpcfn', '+D', ownedHome],
      { timeout: 15000, encoding: 'utf8' });
    dump('owned-home-handles.json', { noOpenHandles: false, stdout: out.slice(0, 4000) });
    evidence.errors.push('open handles remain in owned home; home retained');
  } catch (e) {
    dump('owned-home-handles.json', { noOpenHandles: e.status === 1, exitCode: e.status });
    if (e.status !== 1) evidence.errors.push('lsof failed; handle absence unproven: ' + e.message);
  }
  const portClosed = providerPort
    ? await new Promise((r) => {
        const s = new (require('node:net').Socket)();
        s.setTimeout(1000);
        s.once('connect', () => { s.destroy(); r(false); });
        s.once('error', () => r(true));
        s.once('timeout', () => { s.destroy(); r(true); });
        s.connect(providerPort, '127.0.0.1');
      })
    : true;
  const leaseAfter = {};
  const readbackDisappeared = [];
  for (const p of existingLeases) {
    try {
      const st = fs.lstatSync(p);
      leaseAfter[p] = { sha256: sha256(p), size: st.size, mtimeNs: Number(st.mtimeNs) };
    } catch (e) { if (e.code === 'ENOENT') readbackDisappeared.push(p); else throw e; }
  }
  const newLeases = [];
  for (const dir of leaseDirs) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isFile() && !leaseBefore[fs.realpathSync(p)]) newLeases.push(p);
    }
  }
  const unchanged = JSON.stringify(leaseAfter) === JSON.stringify(leaseBefore);
  dump('lease-cleanup.json', { unchanged, readbackDisappeared, newLeasesAfterRun: newLeases,
    changed: Object.keys(leaseBefore).filter((k) => JSON.stringify(leaseBefore[k]) !== JSON.stringify(leaseAfter[k])) });
  if (!unchanged || newLeases.some((p) => fs.existsSync(p))) {
    evidence.errors.push('lease readback changed or owned leases remain; review lease-cleanup.json');
  }
  return { portClosed, unchanged };
}

async function run() {
  let sids = null;
  try {
    sids = await main();
  } catch (e) {
    evidence.errors.push(String(e && e.stack || e));
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const t = await Promise.race([
        new Promise((r) => child.once('exit', (c, s) => r({ code: c, sig: s }))),
        sleep(8000).then(() => null)]);
      if (t === null) {
        child.kill('SIGKILL');
        await new Promise((r) => child.once('exit', r));
      }
      if (!evidence.cleanupExit) {
        evidence.cleanupExit = { exitCode: child.exitCode, signal: child.signalCode, forced: true };
      }
    }
    flushWireLog();
    fs.writeFileSync(path.join(OUT, 'controller-states.json'), JSON.stringify(controllerStates, null, 2) + '\n');
    await new Promise((r) => {
      try { provider.close(() => r()); } catch { r(); }
      setTimeout(r, 3000);
    });
    const a = await audit().catch((e) => { evidence.errors.push('audit: ' + e); return {}; });
    const handlesOk = (() => { try {
      execFileSync('/usr/sbin/lsof', ['-nP', '+D', ownedHome], { stdio: 'pipe' }); return false;
    } catch { return true; } })();
    const childGone = !child || child.exitCode !== null || child.signalCode !== null;
    if (childGone && handlesOk && a.portClosed) {
      const dest = path.join(OUT, 'hermes-home');
      fs.cpSync(ownedHome, dest, { recursive: true });
      fs.rmSync(ownedHome, { recursive: true, force: true });
      dump('owned-home-cleanup.json', { path: ownedHome, existsAfterCleanup: fs.existsSync(ownedHome),
        exportedTo: 'hermes-home/', childGone, noOpenHandles: handlesOk, providerPortClosed: a.portClosed });
    } else {
      evidence.errors.push(`owned home retained: childGone=${childGone} handlesOk=${handlesOk} portClosed=${a.portClosed}`);
      dump('owned-home-cleanup.json', { path: ownedHome, retained: true, childGone, noOpenHandles: handlesOk });
    }
    evidence.finishedAt = new Date().toISOString();
    evidence.wallSeconds = (Date.now() - t0) / 1000;
    evidence.success = evidence.errors.length === 0 && evidence.checks.every((c) => c.ok);
    evidence.sessions = sids;
    evidence.providerRequests = providerLog.length;
    evidence.fixture = 'scripted loopback chat-completions provider — not agent intelligence';
    dump('outcome.json', evidence);
    dump('provider-log.json', providerLog);
    dump('declaration-validation.json', declarationChecks);
    flushWireLog();
    console.log((evidence.success ? 'CONVERSATION-NATIVE-PASS' : 'CONVERSATION-NATIVE-FAIL')
      + ' ' + JSON.stringify({ checks: evidence.checks.length, errors: evidence.errors,
        wallSeconds: evidence.wallSeconds, providerRequests: providerLog.length }));
    process.exit(evidence.success ? 0 : 1);
  }
}

run().catch((e) => { console.error(e); process.exit(1); });
