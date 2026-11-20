'use strict';
// Scripted real-backend session for the test bench (docs/test-bench.md). Window-free: it drives the app's own client
// modules (gateway-link, gateway-api, native-chat, hermes-api, hermes-remote) against the bench Hermes and prints one
// PASS/FAIL/SKIP line per check.
//
//   node desktop/test/bench/run.cjs --config <bench credentials file, mode 0600> [--clarify] [--max-prompts N] [--sweep]
//
// The config file is JSON: { gateway_url, api_url, username, password, api_key, max_prompts?, marker? }.
// Safety, all enforced before any request leaves: the file is 0600 and ours; both addresses are loopback or tailnet;
// the server on api_url calls itself the bench (/v1/models); every prompt passes one counter with a hard cap; only
// conversations named `bench-...` are created or deleted; no secret value is ever printed.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const SRC = path.join(__dirname, '..', '..', 'src');
const { isTailnetAddress } = require(path.join(SRC, 'tailnet.cjs'));
const { createHermesRemote } = require(path.join(SRC, 'hermes-remote.cjs'));
const { createHermesApi } = require(path.join(SRC, 'hermes-api.cjs'));
const { createGatewayLink, createGatewayOpener } = require(path.join(SRC, 'gateway-link.cjs'));
const { createGatewayApi } = require(path.join(SRC, 'gateway-api.cjs'));
const { createNativeChat } = require(path.join(SRC, 'native-chat.cjs'));

const PREFIX = 'bench-';
const MARKER = 'alans-way-test-bench';
const HARD_PROMPT_CAP = 60, DEFAULT_PROMPT_CAP = 24;
const STEP_TIMEOUT_MS = 90000;

class BenchRefusal extends Error {}
class PromptCapError extends Error {}

// ── safety checks (unit-tested) ─────────────────────────────────────────────
function readConfig(file) {
  let st;
  try { st = fs.lstatSync(file); } catch { throw new BenchRefusal('The config file does not exist.'); }
  if (!st.isFile()) throw new BenchRefusal('The config path is not a plain file (a link or a directory is refused).');
  if ((st.mode & 0o777) !== 0o600) throw new BenchRefusal(`The config file must be mode 0600 (it is ${(st.mode & 0o777).toString(8).padStart(4, '0')}).`);
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new BenchRefusal('The config file belongs to another user.');
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new BenchRefusal('The config file is not valid JSON.'); }
  for (const k of ['gateway_url', 'api_url', 'username', 'password', 'api_key']) {
    if (typeof raw[k] !== 'string' || !raw[k]) throw new BenchRefusal(`The config file has no "${k}".`);
  }
  if (raw.api_key.length < 16) throw new BenchRefusal('The api_key is too short to be a bench key.');
  return raw;
}

// Loopback (the SSH tunnel to the bench's API port, or a local fake), a literal tailnet address, or an https Tailscale name.
function checkAddress(value) {
  let url;
  try { url = new URL(String(value)); } catch { throw new BenchRefusal('An address in the config is not a URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new BenchRefusal('An address must be a plain http(s) URL with no credentials or query.');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const ok = ['127.0.0.1', '::1'].includes(host) || isTailnetAddress(host) || (url.protocol === 'https:' && /^(?:[a-z0-9-]+\.)+ts\.net$/.test(host));
  if (!ok) throw new BenchRefusal('The bench only talks to loopback or tailnet addresses.');
  return url;
}

// One counter for every prompt, whoever sends it. Past the cap nothing more is sent.
function createPromptBudget(requested) {
  const cap = Math.min(Number.isInteger(requested) && requested > 0 ? requested : DEFAULT_PROMPT_CAP, HARD_PROMPT_CAP);
  const labels = [];
  return { cap, labels, get used() { return labels.length; }, tripped: false,
    take(label) { if (labels.length >= cap) { this.tripped = true; throw new PromptCapError(`prompt cap ${cap} reached before: ${label}`); } labels.push(label); } };
}

// The only deleter. It refuses any id that is not ours, and reports what it could not remove.
async function cleanupSessions(ids, deleteOne) {
  const failed = [];
  for (const id of [...new Set(ids)]) {
    if (!id.startsWith(PREFIX)) { failed.push([id, 'not a bench conversation']); continue; }
    try { await deleteOne(id); } catch (e) { failed.push([id, String(e && e.message || e).slice(0, 80)]); }
  }
  return failed;
}

const redactor = (secrets) => {
  const list = () => secrets().filter((s) => typeof s === 'string' && s.length >= 4).sort((a, b) => b.length - a.length);
  return (text) => list().reduce((t, s) => t.split(s).join('[redacted]'), String(text));
};

// ── the run ─────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(pred, ms, what) {
  const end = performance.now() + ms;
  for (;;) { const v = await pred(); if (v) return v; if (performance.now() > end) throw new Error(`timed out (${ms} ms) waiting for ${what}`); await sleep(20); }
}

async function runBench({ configFile, clarify = false, maxPrompts, sweep = false, out = (line) => process.stdout.write(`${line}\n`) } = {}) {
  const config = readConfig(configFile);
  const gatewayBase = checkAddress(config.gateway_url), apiBase = checkAddress(config.api_url);
  // hermes-api.cjs (what the app uses for REST) takes only loopback http or https, so a tailnet API goes through the tunnel.
  if (apiBase.protocol === 'http:' && !['127.0.0.1', '[::1]'].includes(apiBase.hostname)) throw new BenchRefusal('The REST address must be loopback (the SSH tunnel) or https: the app client refuses plain http elsewhere.');
  const budget = createPromptBudget(maxPrompts ?? config.max_prompts);
  const liveTokens = [];
  const redact = redactor(() => [config.api_key, config.password, ...liveTokens]);
  const say = (line) => out(redact(line));
  const results = [];
  const ledger = [];
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const runId = `${PREFIX}${stamp}-${crypto.randomBytes(2).toString('hex')}`;
  const ledgerFile = path.join(path.dirname(configFile), `${runId}.ledger`);
  const key = config.api_key, apiOrigin = apiBase.origin + apiBase.pathname.replace(/\/+$/, '');
  const authed = (method, p, body) => fetch(apiOrigin + p, { method, headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });

  // Nothing is created or sent to a server that does not call itself the bench.
  const named = await authed('GET', '/v1/models').then(async (res) => ({ status: res.status, body: await res.json().catch(() => ({})) }));
  if (named.status !== 200) throw new BenchRefusal(`The API address answered HTTP ${named.status} to the bench key.`);
  if (!(named.body.data || []).some((m) => m && m.id === (config.marker || MARKER))) throw new BenchRefusal('The API server does not call itself the bench, so nothing was run.');

  async function step(name, fn, { timeoutMs = STEP_TIMEOUT_MS } = {}) {
    const t0 = performance.now();
    let row;
    if (budget.tripped) { row = { status: 'SKIP', detail: 'the prompt cap was reached', name, ms: 0 }; results.push(row); say(`SKIP  ${name}`); return row; }
    try {
      const detail = await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error(`step timed out after ${timeoutMs} ms`)), timeoutMs).unref())]);
      row = detail && detail.skip ? { status: 'SKIP', detail: detail.skip } : { status: 'PASS', detail: typeof detail === 'string' ? detail : '' };
    } catch (e) { row = { status: 'FAIL', detail: String(e && e.message || e).slice(0, 240) }; }
    row.name = name; row.ms = Math.round(performance.now() - t0);
    results.push(row);
    say(`${row.status.padEnd(4)}  ${name.padEnd(22)} ${String(row.ms).padStart(6)} ms  ${row.detail}`);
    return row;
  }

  // Every call that could send a prompt or create a conversation goes through here.
  const counted = (api) => ({ ...api,
    streamChat: (id, text, opts) => { budget.take(`${id}: ${text.slice(0, 40)}`); return api.streamChat(id, text, opts); },
    createSession: async (body = {}) => {
      if (!String(body.id || '').startsWith(PREFIX)) throw new BenchRefusal(`refusing to create a conversation not named ${PREFIX}...`);
      const made = await api.createSession(body);
      ledger.push(body.id); try { fs.appendFileSync(ledgerFile, `${body.id}\n`, { mode: 0o600 }); } catch {}
      return made;
    } });
  const inflate = { on: false }; // the one fiction in the run: see the compaction step
  const faked = (u) => (inflate.on && u && u.context_max > 0 ? { ...u, context_used: Math.ceil(u.context_max * 0.9) } : u);
  const restRaw = createHermesApi({ baseUrl: apiBase.href, key });
  const rest = counted(restRaw);
  const remote = createHermesRemote();
  const priorLoopback = process.env.HERMES_WORKSPACE_ALLOW_LOOPBACK;
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alans-way-bench-'));
  let link = null, chat = null, gw = null;

  const newId = (tag) => `${runId}-${tag}`;
  const history = async (id) => (await restRaw.getMessages(id, { limit: 100, order: 'latest' })).data || [];
  const rowsByRole = (rows, role) => rows.filter((m) => m.role === role && typeof m.content === 'string' && m.content.trim()).sort((a, b) => a.id - b.id);
  // The reply is in history once an assistant row follows the user row with this text.
  const answered = async (id, text) => {
    const rows = await history(id), user = rowsByRole(rows, 'user').find((m) => m.content === text);
    return user && rowsByRole(rows, 'assistant').some((m) => m.id > user.id) ? rows : null;
  };

  async function reply(api, id, text) {
    const r = { t0: performance.now(), first: null, deltas: 0, text: '', final: null, terminal: '', error: '' };
    await api.streamChat(id, text, { onEvent: (name, data) => {
      if (name === 'assistant.delta' && typeof data?.delta === 'string') { r.deltas += 1; r.text += data.delta; r.first ??= performance.now() - r.t0; }
      if (name === 'assistant.completed') { r.final = data?.content ?? null; r.first ??= performance.now() - r.t0; }
      if (['run.completed', 'run.failed', 'run.cancelled'].includes(name)) r.terminal = name;
      if (name === 'error') r.error = String(data?.message || '');
    } });
    r.end = performance.now() - r.t0;
    r.answer = (r.final ?? r.text ?? '').trim();
    return r;
  }
  const replyDetail = (r) => `first token ${Math.round(r.first ?? r.end)} ms, total ${Math.round(r.end)} ms, ${r.deltas ? `${r.deltas} deltas` : 'whole reply (no deltas)'}`;
  const expectDone = (r, what) => { if (r.terminal !== 'run.completed') throw new Error(`${what}: ended with ${r.terminal || 'no terminal event'} ${r.error}`.trim()); if (!r.answer) throw new Error(`${what}: empty reply`); };
  const sent = { ws: [], sse: [] }, answers = { ws: [], sse: [] };
  let wsId = '', sseId = '';

  // A wait in a run that has hit its prompt cap ends at once instead of running out its clock.
  const wait = (pred, ms, what) => until(() => { if (budget.tripped) throw new PromptCapError('prompt cap reached'); return pred(); }, ms, what);

  async function body() {
    const base = remote.normalizeBaseUrl(gatewayBase.href);
    let tokens = null;
    await step('signin', async () => {
      const providers = await remote.providers(base);
      const provider = (providers.find((p) => p.supports_password) || providers[0] || { name: 'basic' }).name;
      tokens = await remote.signIn({ base, provider, username: config.username, password: config.password });
      liveTokens.push(tokens.accessToken, tokens.refreshToken);
      return `provider ${provider}`;
    });
    if (!tokens) return;
    const opener = createGatewayOpener({ credentials: () => ({ base, tokens }), adoptTokens: (t) => { tokens = t; liveTokens.push(t.accessToken, t.refreshToken); }, remote });
    link = createGatewayLink({ open: opener });
    gw = counted(createGatewayApi({ rest: restRaw, link, transport: () => 'websocket' }));
    const rawUsage = gw.usage, rawOnUsage = gw.onUsage;
    gw.usage = async (id) => faked(await rawUsage(id));
    gw.onUsage = (cb) => rawOnUsage((id, u) => cb(id, faked(u)));
    const live = await step('link-live', async () => { link.start(); await wait(() => link.isLive(), 15000, 'the link to come up'); return 'WebSocket attached'; });
    if (live.status !== 'PASS') return;

    await step('create-conversation', async () => {
      wsId = newId('ws'); sseId = newId('sse');
      const made = await rest.createSession({ id: wsId, title: `bench ${stamp} ws` });
      if (made?.session?.id !== wsId) throw new Error('Hermes did not keep the id we chose');
      await rest.createSession({ id: sseId, title: `bench ${stamp} sse` });
      let again = '';
      try { await restRaw.createSession({ id: wsId }); again = 'accepted'; } catch (e) { again = e.code; }
      if (again !== 'http_409') throw new Error(`a second create answered ${again}, not http_409`);
      const listed = ((await restRaw.listSessions({ limit: 200 })).data || []).filter((s) => s.id === wsId).length;
      if (listed !== 1) throw new Error(`the conversation is listed ${listed} times`);
      return 'created once, second create 409';
    });
    if (!wsId) return;

    const turn = (api, which, id, word) => async () => {
      const text = `Reply with the single word: ${word} (${stamp})`;
      const r = await reply(api, id, text);
      expectDone(r, `${which} reply`); sent[which].push(text); answers[which].push(r.answer);
      return replyDetail(r);
    };
    await step('reply-websocket', turn(gw, 'ws', wsId, 'ok'));
    await step('reply-rest-sse', turn(rest, 'sse', sseId, 'ok'));
    await step('usage-after-reply', async () => {
      const u = await gw.usage(wsId);
      if (!(u.context_used > 0 && u.context_max > 0)) throw new Error('session.usage reported no context size after a reply');
      return `context ${u.context_used} of ${u.context_max}`;
    });
    // the second turn gives the conversation the four messages Hermes needs before it will compact
    await step('second-turn', turn(gw, 'ws', wsId, 'yes'));

    await step('history-matches', async () => {
      for (const [which, id] of [['ws', wsId], ['sse', sseId]]) {
        const rows = await history(id);
        const users = rowsByRole(rows, 'user').map((m) => m.content), got = rowsByRole(rows, 'assistant').map((m) => m.content.trim());
        if (JSON.stringify(users) !== JSON.stringify(sent[which])) throw new Error(`${which}: history user rows differ from what was sent`);
        if (JSON.stringify(got) !== JSON.stringify(answers[which])) throw new Error(`${which}: a stored reply differs from the streamed one`);
      }
      return `${sent.ws.length + sent.sse.length} user and ${answers.ws.length + answers.sse.length} assistant messages match, in order`;
    });

    chat = createNativeChat({ dir: workDir, loadConfig: () => ({ baseUrl: apiBase.href, key }), saveConfig: () => {}, retryMs: 500, settleMs: 500, apiFactory: () => gw });
    await step('compact-then-send', async () => {
      // Hermes reports the real context size, and a cheap session never nears the compaction threshold. Native chat is
      // shown the size inflated to 90% of the window so its own policy decides to compact; the session.compress that
      // follows is the real one.
      inflate.on = true;
      try {
        await chat.command('open', { sessionId: wsId });
        await wait(() => chat.getState().compact, 10000, 'the context size to reach native chat');
        await chat.command('send', { sessionId: wsId, text: `Reply with the single word: done (${stamp})` });
        const card = await wait(() => (chat.getState().cards || []).find((c) => c.kind === 'compact' && c.state !== 'working'), 60000, 'the compaction to settle');
        if (card.state !== 'done') throw new Error(`compaction ended as: ${card.text}`);
        await wait(() => { const s = chat.getState(); return !s.run && s.thread.messages.at(-1)?.role === 'assistant'; }, 60000, 'the reply after compaction');
      } finally { inflate.on = false; }
      return 'session.compress ran, then the message was answered';
    });

    await step('queued-while-down', async () => {
      const id = newId('queue'), text = `Reply with the single word: back (${stamp})`;
      await rest.createSession({ id, title: `bench ${stamp} queue` });
      await chat.command('open', { sessionId: id });
      const used = budget.used;
      link.suspend();
      await wait(() => link.getState().state === 'suspended', 5000, 'the link to go down');
      await chat.command('send', { sessionId: id, text, compact: false });
      await sleep(1500);
      if (budget.used !== used) throw new Error('the message was sent while the link was down');
      const row = chat.getState().thread.messages.find((m) => m.text === text);
      if (!row || row.state !== 'queued') throw new Error(`the message is ${row ? row.state : 'missing'}, not queued`);
      link.resume();
      await wait(() => answered(id, text), 60000, 'the queued message to be answered');
      await sleep(1500);
      const count = rowsByRole(await history(id), 'user').filter((m) => m.content === text).length;
      if (count !== 1 || budget.used !== used + 1) throw new Error(`delivered ${count} times, ${budget.used - used} prompts spent`);
      return 'held while the link was down, delivered exactly once after it returned';
    });

    await step('clarify-roundtrip', async () => {
      if (!clarify) return { skip: 'off (--clarify): needs a model that calls the clarify tool; approvals need a terminal tool, which the bench does not enable' };
      const id = newId('clarify');
      await rest.createSession({ id, title: `bench ${stamp} clarify` });
      let asked = null, answeredOk = false, terminal = '', runId2 = '';
      const run = gw.streamChat(id, 'Call the clarify tool once with the question "Pick one" and the choices red and blue. Wait for the answer, then reply with the word done.', { onEvent: (name, data) => {
        if (name === 'run.started') runId2 = data.run_id;
        if (name === 'clarify.request' && !asked) { asked = data; gw.answerClarify(runId2, { requestId: data.prompt_id, answer: 'red' }).then(() => { answeredOk = true; }, () => {}); }
        if (['run.completed', 'run.failed', 'run.cancelled'].includes(name)) terminal = name;
      } });
      await Promise.race([run, new Promise((r) => setTimeout(r, 60000).unref())]);
      if (!asked) return { skip: 'the model did not call clarify' };
      if (!answeredOk || terminal !== 'run.completed') throw new Error(`asked, but answered=${answeredOk} and the run ended ${terminal || 'unfinished'}`);
      return 'asked, answered, finished';
    });
  }

  say(`bench run ${runId}: prompt cap ${budget.cap}${clarify ? ', clarify probe on' : ''}`);
  try {
    if (['127.0.0.1', '[::1]'].includes(gatewayBase.hostname)) process.env.HERMES_WORKSPACE_ALLOW_LOOPBACK = '1'; // hermes-remote's own address rule, for a local fake or a tunnel
    await body();
  } catch (e) {
    results.push({ name: 'run', status: 'FAIL', ms: 0, detail: String(e && e.message || e).slice(0, 240) });
    say(`FAIL  run                       ${e && e.message || e}`);
  } finally {
    try { link?.stop(); } catch {}
    try { chat?.flush(); } catch {}
    const leftovers = [];
    if (sweep) { try { for (const s of (await restRaw.listSessions({ limit: 200 })).data || []) if (String(s.id).startsWith(PREFIX) && !ledger.includes(s.id)) leftovers.push(s.id); } catch {} }
    const failed = await cleanupSessions([...ledger, ...leftovers], async (id) => {
      let status = 0;
      for (let i = 0; i < 6; i++) { status = (await authed('DELETE', `/api/sessions/${encodeURIComponent(id)}`)).status; if (status !== 409) break; await sleep(2000); }
      if (status >= 400 && status !== 404) throw new Error(`HTTP ${status}`);
    });
    const row = { name: 'cleanup', status: failed.length ? 'FAIL' : 'PASS', ms: 0, detail: failed.length ? `could not delete: ${failed.map(([id, why]) => `${id} (${why})`).join(', ')}` : `deleted ${ledger.length + leftovers.length} conversations` };
    results.push(row); say(`${row.status.padEnd(4)}  ${row.name.padEnd(22)} ${row.detail}`);
    if (!failed.length) { try { fs.rmSync(ledgerFile, { force: true }); } catch {} }
    if (priorLoopback === undefined) delete process.env.HERMES_WORKSPACE_ALLOW_LOOPBACK; else process.env.HERMES_WORKSPACE_ALLOW_LOOPBACK = priorLoopback;
    fs.rmSync(workDir, { recursive: true, force: true });
  }
  return finish(results, say, budget);
}

function finish(results, say, budget) {
  const bad = results.filter((r) => r.status === 'FAIL').length;
  say(`${bad ? 'FAILED' : 'OK'}: ${results.filter((r) => r.status === 'PASS').length} passed, ${bad} failed, ${results.filter((r) => r.status === 'SKIP').length} skipped; prompts used ${budget.used} of ${budget.cap}`);
  return { ok: bad === 0, results, prompts: budget.used };
}

async function main(argv) {
  const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const configFile = arg('--config');
  if (!configFile) { console.error('usage: node run.cjs --config <bench credentials file> [--clarify] [--max-prompts N] [--sweep]'); return 2; }
  try {
    const outcome = await runBench({ configFile, clarify: argv.includes('--clarify'), maxPrompts: arg('--max-prompts') ? Number(arg('--max-prompts')) : undefined, sweep: argv.includes('--sweep') });
    return outcome.ok ? 0 : 1;
  } catch (e) {
    if (e instanceof BenchRefusal) { console.error(`refused: ${e.message}`); return 2; }
    console.error(`bench error: ${String(e && e.message || e).slice(0, 200)}`); return 1;
  }
}

if (require.main === module) main(process.argv.slice(2)).then((code) => process.exit(code));

module.exports = { runBench, readConfig, checkAddress, createPromptBudget, cleanupSessions, redactor, BenchRefusal, PromptCapError, PREFIX, MARKER, HARD_PROMPT_CAP };
