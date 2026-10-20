'use strict';
// Real isolated STOCK Hermes TUI-gateway proof for desktop/src/hermes-session-wire.cjs.
//
//   node hermes-session-wire-native.cjs --out <evidence-dir> --module <adapter .cjs>
//
// Runs the public `python -m tui_gateway.entry` stdio launcher under macOS Seatbelt
// (loopback-only network, deny read+write on every non-allowlisted ~/.hermes entry,
// read-only source/installs) with a NEW UUID home `~/.hermes/hermes-session-wire-<32hex>`,
// an allowlisted environment, and an owned 127.0.0.1 scripted chat-completions provider.
// The model is a deterministic transport fixture, not agent intelligence; no paid or
// remote calls are possible inside the sandbox. Every model turn is still real gateway
// work: session.create → prompt.submit → streamed events → a real `clarify` server
// request answered once through the adapter → interrupt/request.cancel → EOF.
//
// Unsuccessful attempts are preserved in <out>; this file and the adapter are frozen
// into evidence and executed only from fresh copies (the caller passes --module).

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
if (!args.out || !args.module) {
  console.error('usage: node hermes-session-wire-native.cjs --out <dir> --module <hermes-session-wire.cjs>');
  process.exit(2);
}
const OUT = path.resolve(String(args.out));
const MODULE = path.resolve(String(args.module));
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

if (!OUT || !MODULE) bail('usage: --out <dir> --module <hermes-session-wire.cjs>');
if (process.platform !== 'darwin') bail('requires macOS Seatbelt; no unconfined fallback');
if (!fs.existsSync('/usr/bin/sandbox-exec')) bail('/usr/bin/sandbox-exec missing');
if (!fs.existsSync(MODULE)) bail(`adapter module not found: ${MODULE}`);
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
const ownedHome = path.join(HOME_ROOT, `hermes-session-wire-${crypto.randomBytes(16).toString('hex')}`);
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

const providerLog = [];
const declarationChecks = [];
const FRUIT_Q = 'Pick a harmless fixture fruit for this turn';
const CANCEL_Q = 'Fixture cancellation marker question — do not answer';

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
      // Hop 2 = a tool result arrived AFTER the newest user turn; hop 1 = the
      // newest user turn still awaits the model's tool_call. Prior turns' tool
      // results stay in the transcript and must not misroute the request.
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
      if (isAuxTitle || !/WIRE_FIXTURE/.test(userText)) {
        message = { role: 'assistant', content: isAuxTitle ? 'wire fixture session' : 'Nothing to save.' };
        finish = 'stop';
      } else if (!toolMsgs.length) {
        // First hop of a fixture turn: one schema-checked clarify tool_call.
        const decl = tools.find((t) => t && t.function && t.function.name === 'clarify');
        if (!decl || !validateClarifySchema(decl)) {
          entry.fixtureError = 'clarify tool not declared with the expected schema';
          res.writeHead(500); res.end(JSON.stringify({ error: entry.fixtureError })); return;
        }
        const question = /CANCEL_SCENARIO/.test(userText)
          ? { question: CANCEL_Q, choices: ['Alpha', 'Beta'] }
          : { question: FRUIT_Q, choices: ['Apple', 'Banana'] };
        message = { role: 'assistant', content: null, tool_calls: [{
          id: `fixture_${providerLog.length}`, type: 'function',
          function: { name: 'clarify', arguments: JSON.stringify({ questions: [question] }) } }] };
        finish = 'tool_calls';
      } else {
        // Second hop: the clarify tool result is echoed verbatim into the reply,
        // proving the answer crossed the real tool boundary.
        const seen = toolMsgs.map((m) => String(m.content)).join(' ');
        const fruit = /"user_response":\s*"([^"]+)"/.exec(seen)?.[1] || 'NONE';
        entry.answeredUserResponse = fruit;
        message = { role: 'assistant', content: `WIRE_FIXTURE_ANSWERED ${fruit}` };
        finish = 'stop';
      }
      const payload = { id: `local-fixture-${providerLog.length}`, object: 'chat.completion',
        created: Math.floor(Date.now() / 1000), model: 'fixture-inert',
        choices: [{ index: 0, message, finish_reason: finish }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } };
      entry.response = payload;
      if (json.stream) {
        // Split the final text into real deltas so message.delta evidence is real.
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
  const env = {
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
  return env;
}

// Minimal hand-written config in the owned home (the loader deep-merges
// DEFAULT_CONFIG; _config_version stamps the current schema so no migration runs).
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
  // No hand-rolled YAML: a JSON document is valid YAML 1.2.
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

// ── gateway child + wire tap logging (module scope: cleanup needs them) ──────

let providerPort = 0;
let child = null;
let wire = null;
const wireEvents = [];
const withdrawn = [];
const strays = [];
const wireLog = [];
function logWire(direction, chunk) {
  for (const lineText of String(chunk).split('\n')) {
    if (lineText) wireLog.push({ at: new Date().toISOString(), direction, line: lineText });
  }
}
function flushWireLog() {
  fs.writeFileSync(path.join(OUT, 'wire-log.jsonl'),
    wireLog.map((r) => JSON.stringify(r)).join('\n') + (wireLog.length ? '\n' : ''));
}

async function waitEvent(wire, pred, label, timeoutMs) {
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

async function main() {
  const { HermesSessionWire } = require(MODULE);
  note('module-loaded', { module: MODULE, sha256: sha256(MODULE) });

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

  // 2. Launch the stock public module under Seatbelt through the adapter.
  child = spawn(SANDBOX, ['-f', policyPath, PYTHON, '-m', 'tui_gateway.entry'], {
    cwd: workDir, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'],
  });
  evidence.child = { argv: [PYTHON, '-m', 'tui_gateway.entry'], pid: child.pid,
    confinement: 'sandbox-exec ' + policyPath };
  dump('owned-process.json', { pid: child.pid, argv: evidence.child.argv, cwd: workDir });
  child.stderr.on('data', (c) => { try { fs.appendFileSync(path.join(OUT, 'gateway-stderr.log'), c); } catch {} });
  const toChild = new PassThrough();           // owned by us; tap outbound bytes
  toChild.on('data', (c) => logWire('client-to-gateway', c));
  toChild.pipe(child.stdin);
  child.stdout.on('data', (c) => logWire('gateway-to-client', c));
  wire = new HermesSessionWire({ input: child.stdout, output: toChild, defaultTimeoutMs: 60000 });
  wire.on('event', (e) => wireEvents.push({ at: mark(), ...e }));
  // 'event' frames already land via the normalized 'event' listener above.
  wire.on('notification', (n) => { if (n.method !== 'event') wireEvents.push({ at: mark(), notification: n.method, params: n.params }); });
  wire.on('serverRequestWithdrawn', (r) => withdrawn.push(r));
  wire.on('strayResponse', (r) => strays.push(r));
  wire.on('serverRequest', (r) => {
    // No automatic approval: unexpected methods get an explicit -32601 decline,
    // never a fabricated result and never a silent swallow.
    if (r.method !== 'clarify') {
      wire.refuseServerRequest(r.id, { code: -32601, message: 'fixture answers clarify only' })
        .catch((e) => evidence.errors.push(`refuse failed: ${e.message}`));
    }
  });

  const ready = await waitEvent(wire, (e) => e.type === 'gateway.ready', 'gateway.ready', 30000);
  check('gateway-ready', !!ready.payload && typeof ready.payload.replay_epoch === 'string',
    { replay_epoch: ready.payload && ready.payload.replay_epoch, skin: !!ready.payload.skin });

  // 3. Advertise we answer server→client requests; learn the real catalog.
  const caps = await wire.call('client.capabilities', { server_requests: true });
  check('client-capabilities', Array.isArray(caps.server_requests) && caps.server_requests.includes('clarify'), caps);
  const gcaps = await wire.call('gateway.capabilities', {});
  note('gateway-capabilities', gcaps);

  // 4. session.create in the owned work dir.
  const created = await wire.call('session.create', {
    title: 'synthetic wire fixture', cwd: workDir, source: 'wire-fixture',
  });
  const sid = created.session_id;
  check('session-create', typeof sid === 'string' && sid.length > 0
    && typeof created.stored_session_id === 'string', {
    session_id: sid, stored_session_id: created.stored_session_id,
    infoKeys: created.info && Object.keys(created.info).slice(0, 12) });

  // 5. Turn 1: scripted clarify → we answer once → streamed final text.
  const clarifyP = waitEvent(wire, (r) => r.method === 'clarify', 'clarify server request', 90000);
  const submit1 = await wire.call('prompt.submit', { session_id: sid, text: 'WIRE_FIXTURE CLARIFY_SCENARIO please ask the fixture question' });
  check('prompt-submit-streaming', submit1 && submit1.status === 'streaming', submit1);
  const srq = await clarifyP;
  check('clarify-request-shape', srq.sessionId === sid
    && /^srq-[0-9a-f]{12}$/.test(String(srq.id))
    && Array.isArray(srq.params.questions)
    && srq.params.questions[0] && srq.params.questions[0].question === FRUIT_Q,
    { id: srq.id, sessionId: srq.sessionId, questions: srq.params.questions });
  const deltas1P = waitEvent(wire, (e) => e.type === 'message.complete' && e.sessionId === sid,
    'message.complete turn 1', 90000);
  await wire.answerServerRequest(srq.id, { answers: { q0: 'Apple' } });
  note('clarify-answered', { id: srq.id, sentResult: { answers: { q0: 'Apple' } } });
  // Single-use: a second answer must be refused without writing.
  let doubleAnswerRejected = false;
  try { await wire.answerServerRequest(srq.id, { answers: { q0: 'Banana' } }); }
  catch (e) { doubleAnswerRejected = e.code === 'unknown_request'; }
  check('clarify-single-use', doubleAnswerRejected);
  const complete1 = await deltas1P;
  const deltaTexts = wireEvents.filter((e) => e.type === 'message.delta' && e.sessionId === sid)
    .map((e) => e.payload && e.payload.text).filter(Boolean);
  check('turn1-streamed', deltaTexts.length > 0
    && deltaTexts.join('').includes('WIRE_FIXTURE_ANSWERED'), { deltas: deltaTexts });
  const finalText = String((complete1.payload && complete1.payload.text) || deltaTexts.join(''));
  check('turn1-complete', /WIRE_FIXTURE_ANSWERED Apple/.test(finalText),
    { status: complete1.payload && complete1.payload.status, text: finalText.slice(0, 300) });
  // The answer must have crossed the real tool boundary back to the provider.
  const hop2 = providerLog.find((e2) => e2.answeredUserResponse === 'Apple');
  check('answer-reached-model', !!hop2, {
    answeredUserResponse: hop2 && hop2.answeredUserResponse,
    toolResultRequests: providerLog.filter((e2) => (e2.summary || {}).toolResults > 0).length });

  // 6. Turn 2: scripted clarify we do NOT answer → session.interrupt withdraws it.
  const clarify2P = waitEvent(wire, (r) => r.method === 'clarify', 'clarify #2', 90000);
  await wire.call('prompt.submit', { session_id: sid, text: 'WIRE_FIXTURE CANCEL_SCENARIO second turn' });
  const srq2 = await clarify2P;
  check('clarify-2', srq2.sessionId === sid && srq2.id !== srq.id, { id: srq2.id });
  const cancelP = waitEvent(wire, (e) => e.type === 'request.cancel'
    && e.payload && e.payload.id === srq2.id, 'request.cancel', 30000);
  const complete2P = waitEvent(wire, (e) => e.type === 'message.complete' && e.sessionId === sid
    && e.payload && e.payload.status !== 'complete', 'turn-2 terminal event', 90000)
    .catch((e) => ({ error: String(e) }));
  const interrupt = await wire.call('session.interrupt', { session_id: sid });
  note('session-interrupt-result', interrupt);
  const cancelEvt = await cancelP;
  check('request-cancel-withdraws', cancelEvt.payload.reason !== undefined, cancelEvt.payload);
  await sleep(150); // let the withdrawal event land
  let lateAnswerRejected = false;
  try { await wire.answerServerRequest(srq2.id, { answers: {} }); }
  catch (e) { lateAnswerRejected = e.code === 'unknown_request'; }
  check('withdrawn-request-not-answerable', lateAnswerRejected
    && withdrawn.some((r) => r.id === srq2.id));
  const complete2 = await complete2P;
  note('turn2-terminal', complete2.payload
    ? { status: complete2.payload.status, text: String(complete2.payload.text || '').slice(0, 200) }
    : complete2);

  // 7. Replay + close + EOF.
  const replay = await wire.call('session.events.since', { session_id: sid, last_seen: 0 });
  check('replay', typeof replay.epoch === 'string' && replay.truncated === false
    && Array.isArray(replay.events) && replay.events.length > 0
    && Array.isArray(replay.open_requests), {
    epoch: replay.epoch, events: replay.events && replay.events.length,
    open_requests: replay.open_requests && replay.open_requests.length });
  const closed = await wire.call('session.close', { session_id: sid });
  note('session-close', closed);

  wire.close(); // ends only our owned writable → gateway stdin EOF
  check('close-settles', wire.state === 'closed' && wire.pendingCalls.length === 0,
    { state: wire.state });
  const eofExit = await Promise.race([
    new Promise((r) => child.once('exit', (code, sig) => r({ code, sig }))),
    sleep(20000).then(() => 'still-running'),
  ]);
  note('eof-exit', eofExit);   // direct exit status — recorded separately from functionality
  if (eofExit === 'still-running') {
    child.kill('SIGTERM');
    const t = await Promise.race([new Promise((r) => child.once('exit', (c, s) => r({ code: c, sig: s }))), sleep(8000).then(() => 'term-hung')]);
    if (t === 'term-hung') { child.kill('SIGKILL'); await new Promise((r) => child.once('exit', r)); }
    evidence.errors.push('gateway did not exit on EOF; needed signals: ' + JSON.stringify(t));
  }
  evidence.eofExit = eofExit;
  evidence.cleanupExit = { exitCode: child.exitCode, signal: child.signalCode };
  check('child-exited', child.exitCode !== null || child.signalCode !== null, evidence.cleanupExit);
  check('no-stray-responses', strays.length === 0, strays);
  return { sid };
}

// ── cleanup + audit ───────────────────────────────────────────────────────────

async function audit() {
  // The owned PID must be reaped and hold no surviving descriptors into the home.
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
    // lsof exits 1 when nothing is open.
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
  // Lease readback: every snapshot lease unchanged, no surviving owned leases.
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
  let sid = null;
  try {
    sid = (await main()).sid;
  } catch (e) {
    evidence.errors.push(String(e && e.stack || e));
  } finally {
    // Never leave the owned child running on a failure path.
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
    fs.writeFileSync(path.join(OUT, 'wire-events.json'), JSON.stringify(wireEvents, null, 2) + '\n');
    fs.writeFileSync(path.join(OUT, 'wire-withdrawn.json'), JSON.stringify(withdrawn, null, 2) + '\n');
    await new Promise((r) => {
      try { provider.close(() => r()); } catch { r(); }
      setTimeout(r, 3000);
    });
    const a = await audit().catch((e) => { evidence.errors.push('audit: ' + e); return {}; });
    // Export the owned home into evidence, then remove it — only when the
    // process exited, no handles are open and the endpoint closed.
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
    evidence.sessionId = sid;
    evidence.providerRequests = providerLog.length;
    dump('outcome.json', evidence);
    dump('provider-log.json', providerLog);
    dump('declaration-validation.json', declarationChecks);
    flushWireLog();
    console.log((evidence.success ? 'WIRE-NATIVE-PASS' : 'WIRE-NATIVE-FAIL')
      + ' ' + JSON.stringify({ checks: evidence.checks.length, errors: evidence.errors,
        wallSeconds: evidence.wallSeconds }));
    process.exit(evidence.success ? 0 : 1);
  }
}

run().catch((e) => { console.error(e); process.exit(1); });
