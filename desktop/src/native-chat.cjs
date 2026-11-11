'use strict';
// Alan's native chat, main-process side: a thin client on Hermes Agent's own
// Sessions API. Owns the config, session list, per-session message cache, the
// live run per session with its approval/clarify prompts, and projects a
// bounded display state. The API key never leaves this process.
const fs = require('node:fs');
const path = require('node:path');
const { createHermesApi } = require('./hermes-api.cjs');
const { writePrivateJson } = require('./shell-support.cjs');

const MAX_TEXT = 100000, MAX_THREAD = 2000, MAX_SESSIONS = 50, MAX_CARDS = 20, MAX_THREADS = 20;
const PAGE = 500, CACHE_CAP = 32 * 1024 * 1024;
const SESSION_ID = /^[\w.-]{1,128}$/;
const str = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';
const capText = (text) => text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n\n…` : text;
const TOOL_LABELS = { terminal: 'Running a command', execute_code: 'Running code', web_search: 'Searching the web', web_extract: 'Reading a web page',
  read_file: 'Reading a file', write_file: 'Writing a file', patch: 'Editing a file', search_files: 'Searching files', clarify: 'Asking you a question',
  memory: 'Updating memory', todo: 'Updating the plan', delegate_task: 'Handing off a task', vision_analyze: 'Looking at an image' };
const toolLabel = (name) => TOOL_LABELS[name] || (/^browser_/.test(name) ? 'Using the browser' : `Using ${String(name || 'a tool').replace(/[_-]+/g, ' ').slice(0, 40)}`);

// Server rows to display rows: only user/assistant text; tool rows, tool-call-only
// assistant rows and session_meta rows are not shown.
function toMessage(row) {
  if (!row || !['user', 'assistant'].includes(row.role) || !Number.isSafeInteger(row.id)) return null;
  const text = typeof row.content === 'string' ? row.content : '';
  return text.trim() ? { id: row.id, role: row.role, text: capText(text), ts: Number(row.timestamp) || 0 } : null;
}
const validCached = (m) => !!m && Number.isSafeInteger(m.id) && ['user', 'assistant'].includes(m.role) && typeof m.text === 'string';

// Server messages merge by id (fresh wins) in id order; local optimistic rows
// (string ids) that `keepLocal` admits stay at the end.
function mergeMessages(current, incoming, keepLocal = () => true) {
  const byId = new Map();
  for (const m of current) if (typeof m.id === 'number') byId.set(m.id, m);
  for (const m of incoming) byId.set(m.id, m);
  const merged = [...byId.values()].sort((a, b) => a.id - b.id);
  return merged.concat(current.filter((m) => typeof m.id !== 'number' && keepLocal(m))).slice(-MAX_THREAD);
}
const sameMessages = (a, b) => a.length === b.length && a.every((m, i) => m.id === b[i].id && m.text === b[i].text && m.state === b[i].state);

function createNativeChat({ dir, loadConfig = () => ({}), saveConfig = () => {}, notify = () => {}, openLink = () => {}, copyText = () => {},
  apiFactory = createHermesApi, now = Date.now, pollMs = 1000 }) {
  const cacheDir = path.join(dir, 'native-chat-cache');
  const loaded = loadConfig() || {};
  const config = { baseUrl: str(loaded.baseUrl, 500), profile: str(loaded.profile, 64), key: str(loaded.key, 500) };
  let sessions = Array.isArray(loaded.sessions) ? loaded.sessions.filter((s) => s && SESSION_ID.test(s.id)).slice(0, MAX_SESSIONS) : [];
  let activeId = SESSION_ID.test(loaded.lastSessionId || '') ? loaded.lastSessionId : '';
  let api = null, status = 'idle', error = '', revSeq = 0, localSeq = 0, cardSeq = 0, configTimer, autoPick = !activeId;
  const threads = new Map(), runs = new Map(), cards = new Map(), unread = new Set(), inflight = new Map();
  const configured = () => !!(config.baseUrl && config.key);
  const rebuild = () => { api = configured() ? apiFactory({ baseUrl: config.baseUrl, key: config.key, profile: config.profile }) : null; status = api ? 'idle' : 'unconfigured'; error = ''; };
  const address = () => config.baseUrl ? `${config.baseUrl}${config.profile ? `/p/${config.profile}` : ''}` : '';
  const cacheFile = (id) => path.join(cacheDir, `${id}.json`);
  const bump = (t) => { t.rev = ++revSeq; };

  function persistConfig() {
    clearTimeout(configTimer); configTimer = undefined;
    try { saveConfig({ ...config, lastSessionId: activeId, sessions }); } catch {}
  }
  const persistConfigSoon = () => { if (!configTimer) { configTimer = setTimeout(persistConfig, 300); configTimer.unref?.(); } };

  function thread(id) {
    let t = threads.get(id);
    if (t) { threads.delete(id); threads.set(id, t); return t; }
    t = { messages: [], rev: ++revSeq, loading: false, hasOlder: false, loadedRows: 0, notice: '', saveTimer: undefined };
    try {
      const raw = JSON.parse(fs.readFileSync(cacheFile(id), 'utf8'));
      if (Array.isArray(raw.messages)) { t.messages = raw.messages.filter(validCached).map((m) => ({ id: m.id, role: m.role, text: capText(m.text), ts: Number(m.ts) || 0 })).slice(-MAX_THREAD); t.hasOlder = raw.hasOlder === true; }
    } catch {}
    threads.set(id, t);
    for (const [other, entry] of threads) {
      if (threads.size <= MAX_THREADS) break;
      if (other !== activeId && !runs.has(other)) { writeCache(other, entry); threads.delete(other); }
    }
    return t;
  }

  function writeCache(id, t) {
    clearTimeout(t.saveTimer); t.saveTimer = undefined;
    if (!t.dirty) return;
    t.dirty = false;
    try {
      fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
      writePrivateJson(cacheFile(id), JSON.stringify({ sessionId: id, hasOlder: t.hasOlder, messages: t.messages.filter((m) => typeof m.id === 'number') }));
      pruneCache(id);
    } catch {}
  }
  const saveSoon = (id, t) => { t.dirty = true; if (!t.saveTimer) { t.saveTimer = setTimeout(() => writeCache(id, t), 400); t.saveTimer.unref?.(); } };
  // Total cache size is capped; the least recently written sessions go first.
  function pruneCache(keep) {
    const files = fs.readdirSync(cacheDir).filter((name) => name.endsWith('.json')).map((name) => {
      const stat = fs.statSync(path.join(cacheDir, name));
      return { name, size: stat.size, mtime: stat.mtimeMs };
    }).sort((a, b) => b.mtime - a.mtime);
    let total = 0;
    for (const file of files) {
      total += file.size;
      if (total > CACHE_CAP && file.name !== `${keep}.json`) fs.rmSync(path.join(cacheDir, file.name), { force: true });
    }
  }

  function fail(e) {
    status = { unauthorized: 'unauthorized', unconfigured: 'unconfigured', unreachable: 'unreachable', stream_dropped: 'unreachable' }[e?.code] || 'error';
    error = String(e?.message || e).slice(0, 300);
  }
  // One in-flight request per key; later callers share it.
  function once(key, task) {
    if (!inflight.has(key)) inflight.set(key, task().finally(() => inflight.delete(key)));
    return inflight.get(key);
  }

  const sessionRow = (s) => ({ id: str(s.id, 128), title: str(s.title, 200), source: str(s.source, 40) || 'api_server', preview: str(s.preview, 200),
    lastActive: Number(s.last_active ?? s.lastActive ?? s.started_at) || 0 });
  const sourceOf = (id) => sessions.find((s) => s.id === id)?.source || 'api_server';
  const isReadOnly = (id) => sourceOf(id) !== 'api_server';

  function refreshSessions() {
    if (!api) { rebuild(); notify(); return Promise.resolve(); }
    return once('sessions', async () => {
      try {
        const body = await api.listSessions({ limit: MAX_SESSIONS });
        const rows = (Array.isArray(body.data) ? body.data : []).filter((s) => s && SESSION_ID.test(s.id) && !s.hidden && !s.archived && !s.is_internal_child).map(sessionRow);
        const local = sessions.filter((s) => s.id === activeId && !rows.some((r) => r.id === s.id));
        sessions = local.concat(rows).slice(0, MAX_SESSIONS);
        status = 'ready'; error = '';
        if (autoPick && !activeId) { const first = sessions.find((s) => s.source === 'api_server'); if (first) { activeId = first.id; revalidate(first.id); } }
        persistConfigSoon();
      } catch (e) { fail(e); }
      notify();
    });
  }

  function apply(id, fresh) {
    const t = thread(id), run = runs.get(id);
    // A live run's optimistic user row goes once the server row for it arrives.
    const echoed = new Set(fresh.filter((m) => m.role === 'user' && run && m.ts >= run.startedAt - 60).map((m) => m.text));
    // A fork's placeholder copy carries the source's ids; the server's copy replaces it.
    const base = t.placeholder ? t.messages.filter((m) => typeof m.id !== 'number') : t.messages;
    t.placeholder = false;
    const next = mergeMessages(base, fresh, (m) => m.state === 'failed' || (!!run?.localIds.includes(m.id) && !(m.role === 'user' && echoed.has(m.text))));
    if (sameMessages(next, t.messages)) return;
    t.messages = next; bump(t); saveSoon(id, t);
  }

  function revalidate(id) {
    if (!api || !id) return Promise.resolve();
    return once(`messages:${id}`, async () => {
      const t = thread(id);
      t.loading = true; notify();
      try {
        const body = await api.getMessages(id, { limit: PAGE, order: 'latest' });
        const rows = Array.isArray(body.data) ? body.data : [];
        if (!t.loadedRows) { t.loadedRows = rows.length; t.hasOlder = rows.length === PAGE; }
        apply(id, rows.map(toMessage).filter(Boolean));
        status = 'ready'; error = '';
      } catch (e) { fail(e); }
      t.loading = false; notify();
    });
  }

  function addCard(run, card) {
    const list = cards.get(run.id) || [];
    list.push({ id: `card-${++cardSeq}`, state: 'open', ts: now() / 1000, runId: run.runId, answer: '', ...card });
    cards.set(run.id, list.slice(-MAX_CARDS));
  }
  const openCards = (run, kind) => (cards.get(run.id) || []).filter((c) => c.runId === run.runId && c.state === 'open' && (!kind || c.kind === kind));
  function setLocal(run, state) {
    const t = thread(run.id);
    t.messages = t.messages.map((m) => run.localIds.includes(m.id) && m.role === 'user' ? { ...m, state } : m);
    bump(t);
  }

  // Clarify questions only show up on the run, never in the stream.
  function pollClarify(run) {
    clearInterval(run.poll);
    let tries = 0;
    run.poll = setInterval(async () => {
      if (++tries > 300 || !runs.has(run.id)) { clearInterval(run.poll); return; }
      try {
        const body = await api.getRun(run.runId);
        const control = (body.pending_controls || []).find((c) => c?.kind === 'clarify');
        if (!control || (cards.get(run.id) || []).some((c) => c.requestId === control.prompt_id)) return;
        clearInterval(run.poll);
        addCard(run, { kind: 'clarify', requestId: str(control.prompt_id, 200), generation: control.execution_generation, question: str(control.question, 2000),
          choices: (Array.isArray(control.choices) ? control.choices : []).slice(0, 8).map((c) => str(String(c), 200)) });
        notify();
      } catch {}
    }, pollMs);
    run.poll.unref?.();
  }

  function onEvent(run, name, data) {
    const d = data && typeof data === 'object' ? data : {};
    switch (name) {
      case 'run.started': run.runId = str(d.run_id, 200); run.status = 'running'; setLocal(run, 'sent'); break;
      case 'message.started': run.messageId = str(d.message?.id, 200); break;
      case 'assistant.delta': if (typeof d.delta === 'string' && run.text.length < MAX_TEXT) run.text += d.delta; break;
      case 'assistant.completed': if (typeof d.content === 'string') run.final = d.content; break;
      case 'tool.started': run.tool = toolLabel(d.tool_name); if (d.tool_name === 'clarify' && run.runId) pollClarify(run); break;
      case 'tool.completed': case 'tool.failed':
        run.tool = '';
        for (const card of openCards(run)) card.state = card.kind === 'clarify' && card.answer ? 'answered' : 'expired';
        break;
      case 'approval.request':
        addCard(run, { kind: 'approval', requestId: str(d.request_id, 200), generation: d.execution_generation, command: str(d.command, 4000), description: str(d.description, 500),
          choices: (Array.isArray(d.choices) ? d.choices : []).filter((c) => ['once', 'session', 'always', 'deny'].includes(c)) });
        break;
      case 'run.completed': case 'run.cancelled': case 'run.failed': {
        run.outcome = name.slice(4);
        const last = (Array.isArray(d.messages) ? d.messages : []).filter((m) => m?.role === 'assistant' && typeof m.content === 'string' && m.content.trim()).at(-1);
        if (last) run.final = last.content;
        break;
      }
      case 'error': run.error = str(d.message, 300); break;
      default: return;
    }
    run.status = run.runId ? (openCards(run).length ? 'waiting' : 'running') : run.status;
    notify();
  }

  async function finish(run, err) {
    const id = run.id, t = thread(id);
    clearInterval(run.poll);
    for (const card of openCards(run)) card.state = 'expired';
    if (err && !run.runId) {
      setLocal(run, 'failed');
      runs.delete(id);
      if (err.code !== 'aborted') { fail(err); t.notice = 'That message was not sent.'; }
      notify();
      return;
    }
    const text = run.final || run.text;
    if (text) { const reply = { id: `local-${++localSeq}`, role: 'assistant', text: capText(text), ts: now() / 1000 }; t.messages = [...t.messages, reply]; run.localIds.push(reply.id); }
    t.notice = err && err.code !== 'aborted' ? 'The connection dropped during the reply; it may be incomplete.'
      : run.outcome === 'failed' ? (run.error || 'Hermes could not finish this reply.') : run.outcome === 'cancelled' ? 'Stopped.' : '';
    setLocal(run, 'sent');
    runs.delete(id);
    if (id !== activeId) unread.add(id);
    notify();
    await revalidate(id);
    // Hermes names a conversation after its first turn.
    if (!sessions.find((s) => s.id === id)?.title) refreshSessions();
  }

  function startRun(id, text) {
    const t = thread(id);
    const local = { id: `local-${++localSeq}`, role: 'user', text, ts: now() / 1000, state: 'sending' };
    t.messages = [...t.messages, local]; t.notice = ''; bump(t);
    const run = { id, runId: '', messageId: '', text: '', final: '', tool: '', status: 'sending', outcome: '', error: '', localIds: [local.id], abort: new AbortController(), startedAt: now() / 1000 };
    runs.set(id, run);
    const s = sessions.find((row) => row.id === id);
    if (s) { s.lastActive = now() / 1000; sessions = [s, ...sessions.filter((row) => row !== s)]; }
    notify();
    api.streamChat(id, text, { signal: run.abort.signal, onEvent: (name, data) => onEvent(run, name, data) })
      .then(() => finish(run, null), (e) => finish(run, e));
  }

  function setActive(id) {
    activeId = id; autoPick = false;
    unread.delete(id);
    if (id) thread(id);
    persistConfigSoon();
    notify();
  }

  const findCard = (sessionId, cardId, kind) => {
    const card = (cards.get(sessionId) || []).find((c) => c.id === cardId && c.kind === kind);
    if (!card || card.state !== 'open') throw new Error('That question is no longer open.');
    return card;
  };
  const answered = async (card, sessionId, task) => {
    try { await task(); card.state = 'answered'; }
    catch (e) { if (/^http_(404|409)$/.test(e.code)) card.state = 'expired'; throw e; }
    finally { const run = runs.get(sessionId); if (run) run.status = openCards(run).length ? 'waiting' : 'running'; notify(); }
  };

  const commands = {
    async test() {
      if (!api) throw new Error('Save the native chat address and API key first.');
      try { const body = await api.listSessions({ limit: 1 }); status = 'ready'; error = ''; notify(); return { ok: true, detail: `Connected. Hermes answered${body.data?.length ? ' with your conversations' : ''}.` }; }
      catch (e) { fail(e); notify(); throw new Error(e.message); }
    },
    async refresh() { await refreshSessions(); if (activeId) await revalidate(activeId); return { ok: true }; },
    open({ sessionId }) {
      if (!SESSION_ID.test(String(sessionId || ''))) throw new Error('Unknown conversation.');
      setActive(sessionId);
      revalidate(sessionId);
      return { ok: true };
    },
    new() { setActive(''); return { ok: true }; },
    async send({ sessionId, text }) {
      text = typeof text === 'string' ? text : '';
      if (!text.trim()) throw new Error('Type a message first.');
      if (text.length > MAX_TEXT) throw new Error('That message is too long to send.');
      if (!api) throw new Error('Set up native chat in Settings first.');
      let id = SESSION_ID.test(String(sessionId || '')) ? sessionId : '';
      if (id && isReadOnly(id)) throw new Error('This conversation is read-only here. Use Continue here.');
      if (id && runs.has(id)) throw new Error('Wait for the reply, or stop it, before sending again.');
      if (!id) {
        const body = await api.createSession({});
        if (!SESSION_ID.test(String(body?.session?.id || ''))) throw new Error('Hermes did not create a conversation.');
        id = body.session.id;
        sessions = [sessionRow(body.session), ...sessions].slice(0, MAX_SESSIONS);
        setActive(id);
      }
      startRun(id, text);
      return { ok: true, sessionId: id };
    },
    retry({ sessionId, localId }) {
      const t = thread(String(sessionId || ''));
      const failed = t.messages.find((m) => m.id === localId && m.state === 'failed');
      if (!failed) throw new Error('Nothing to retry.');
      if (runs.has(sessionId)) throw new Error('Wait for the reply, or stop it, before sending again.');
      t.messages = t.messages.filter((m) => m !== failed);
      startRun(sessionId, failed.text);
      return { ok: true };
    },
    async stop({ sessionId }) {
      const run = runs.get(sessionId);
      if (!run) return { ok: true };
      if (!run.runId) { run.abort.abort(); return { ok: true }; }
      try { await api.stopRun(run.runId); } catch { run.abort.abort(); }
      return { ok: true };
    },
    async approve({ sessionId, cardId, choice }) {
      const card = findCard(sessionId, cardId, 'approval');
      if (!card.choices.includes(choice)) throw new Error('Choose one of the offered answers.');
      await answered(card, sessionId, () => api.answerApproval(card.runId, { requestId: card.requestId, generation: card.generation, choice }));
      card.answer = choice;
      notify();
      return { ok: true };
    },
    async clarify({ sessionId, cardId, answer }) {
      const card = findCard(sessionId, cardId, 'clarify');
      answer = str(answer, 4000).trim();
      if (!answer) throw new Error('Type an answer first.');
      card.answer = answer;
      await answered(card, sessionId, () => api.answerClarify(card.runId, { requestId: card.requestId, generation: card.generation, answer }));
      return { ok: true };
    },
    // A conversation from another surface is readable but not writable over
    // this API; Continue here forks it into an api_server session.
    async fork({ sessionId }) {
      if (!api) throw new Error('Set up native chat in Settings first.');
      const body = await api.forkSession(sessionId, {});
      const id = String(body?.session?.id || '');
      if (!SESSION_ID.test(id)) throw new Error('Hermes did not create the copy.');
      sessions = [sessionRow(body.session), ...sessions.filter((s) => s.id !== id)].slice(0, MAX_SESSIONS);
      const source = thread(sessionId), copy = thread(id);
      if (!copy.messages.length) { copy.messages = source.messages.filter((m) => typeof m.id === 'number'); copy.placeholder = true; bump(copy); }
      setActive(id);
      revalidate(id);
      return { ok: true, sessionId: id };
    },
    older({ sessionId }) {
      const t = thread(String(sessionId || ''));
      if (!api || !t.hasOlder) return { ok: true };
      return once(`older:${sessionId}`, async () => {
        try {
          const body = await api.getMessages(sessionId, { limit: PAGE, offset: t.loadedRows, order: 'latest' });
          const rows = Array.isArray(body.data) ? body.data : [];
          t.loadedRows += rows.length; t.hasOlder = rows.length === PAGE;
          apply(sessionId, rows.map(toMessage).filter(Boolean));
          bump(t);
        } catch (e) { fail(e); }
        notify();
        return { ok: true };
      });
    },
    'open-link'({ url }) {
      let parsed;
      try { parsed = new URL(String(url || '')); } catch { throw new Error('That link cannot be opened.'); }
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only web links open from chat.');
      openLink(parsed.href);
      return { ok: true };
    },
    copy({ text }) { copyText(str(text, 1000000)); return { ok: true }; },
  };

  rebuild();
  if (activeId) thread(activeId);

  function getState() {
    const t = activeId ? thread(activeId) : null;
    const s = sessions.find((row) => row.id === activeId);
    const run = runs.get(activeId);
    return {
      configured: configured(), status, error, address: address(),
      sessions: sessions.map((row) => {
        const live = runs.get(row.id);
        return { ...row, readOnly: row.source !== 'api_server', running: !!live, waiting: !!live && openCards(live).length > 0, unread: unread.has(row.id) };
      }),
      activeId,
      thread: t && { sessionId: activeId, rev: t.rev, messages: t.messages, loading: t.loading, hasOlder: t.hasOlder, notice: t.notice,
        title: s?.title || '', source: sourceOf(activeId), readOnly: isReadOnly(activeId) },
      run: run ? { status: run.status, text: run.text, tool: run.tool, messageId: run.messageId } : null,
      cards: (cards.get(activeId) || []).map(({ runId, generation, requestId, ...card }) => card),
    };
  }
  // Pushes leave out an unchanged thread's messages; the renderer keeps its copy.
  let pushedThread = '';
  function pushState() {
    const state = getState();
    const key = state.thread ? `${state.thread.sessionId}:${state.thread.rev}` : '';
    if (key && key === pushedThread) state.thread = { ...state.thread, messages: undefined, same: true };
    pushedThread = key;
    return state;
  }

  return {
    getState, pushState,
    get configured() { return configured(); },
    summary: () => ({ configured: configured(), hasKey: !!config.key, address: address(), status, error }),
    async command(name, value) {
      if (!Object.hasOwn(commands, name)) throw new Error('Unknown native chat command.');
      return commands[name](value && typeof value === 'object' ? value : {});
    },
    configure({ baseUrl = '', profile = '', key }) {
      for (const run of runs.values()) run.abort.abort();
      const moved = baseUrl !== config.baseUrl || profile !== config.profile;
      Object.assign(config, { baseUrl, profile }, key !== undefined ? { key } : {}, baseUrl ? {} : { key: '' });
      if (moved) { sessions = []; activeId = ''; autoPick = true; cards.clear(); unread.clear(); }
      rebuild();
      persistConfig();
      notify();
      if (api) refreshSessions();
    },
    activate() { if (!api) return; refreshSessions(); if (activeId) revalidate(activeId); },
    flush() { persistConfig(); for (const [id, t] of threads) writeCache(id, t); },
  };
}

module.exports = { createNativeChat, mergeMessages, toMessage, toolLabel };
