'use strict';
// Alan's native chat, main-process side: a thin client on Hermes Agent's own
// Sessions API. Owns the config, session list, per-session message cache, the
// live run per session with its approval/clarify prompts, and projects a
// bounded display state. The API key never leaves this process.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createHermesApi } = require('./hermes-api.cjs');
const { writePrivateJson, plainLine } = require('./shell-support.cjs');
const { shouldCompact } = require('./compact-policy.cjs');

const MAX_TEXT = 100000, MAX_THREAD = 2000, MAX_SESSIONS = 50, MAX_CARDS = 20, MAX_THREADS = 20;
const PAGE = 500, CACHE_CAP = 32 * 1024 * 1024;
const SESSION_ID = /^[\w.-]{1,128}$/, BOT_CHAT = 'Bot Chat', LOCAL_SOURCES = new Set(['local', 'cli', 'tui', 'gui', 'desktop']);
const REFUSED = 'Hermes does not let this app write to that conversation.';
const GAP_NOTE = 'Part of this reply was missed and was reloaded from history.';
const DELIVERED_NOTE = 'That message had already reached Hermes. Its reply shows after a refresh.';
// A message typed while Hermes cannot be reached waits in a per-conversation queue on disk and goes in order.
const QUEUE_MAX_MS = 30 * 60 * 1000, QUEUE_MAX = 200, QUEUE_BYTES = 1048576, QUEUE_SAVE_MS = 250;
// After an attempt that may have reached Hermes without an answer, the history is not read for this long: a request that
// was still on its way when we gave up has its row in the history by then.
const QUEUE_SETTLE_MS = 15000;
const QUEUE_STATES = new Set(['queued', 'sending', 'failed']);
// A compaction that has not answered by then is given up on and the message goes as it is.
const COMPACT_DEADLINE_MS = 120000;
const CMID = /^[\w-]{8,64}$/, WAIT_CODES = new Set(['unreachable', 'stream_dropped', 'http_409']);
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
  apiFactory = createHermesApi, now = Date.now, pollMs = 1000, retryMs = 5000, visible = () => true, compactEnabled = () => true, compactDeadlineMs = COMPACT_DEADLINE_MS, settleMs = QUEUE_SETTLE_MS }) {
  const cacheDir = path.join(dir, 'native-chat-cache'), queueDir = path.join(dir, 'native-chat-queue');
  const loaded = loadConfig() || {};
  const config = { baseUrl: str(loaded.baseUrl, 500), profile: str(loaded.profile, 64), key: str(loaded.key, 500) };
  let sessions = Array.isArray(loaded.sessions) ? loaded.sessions.filter((s) => s && SESSION_ID.test(s.id)).slice(0, MAX_SESSIONS) : [];
  let activeId = SESSION_ID.test(loaded.lastSessionId || '') ? loaded.lastSessionId : '';
  let api = null, status = 'idle', error = '', revSeq = 0, localSeq = 0, cardSeq = 0, configTimer, autoPick = !activeId, wanted = {};
  const threads = new Map(), runs = new Map(), cards = new Map(), unread = new Set(), inflight = new Map();
  // Unsent messages per conversation, oldest first: { cmid, text, createdAt (ms), state, attempts, attemptedAt, afterId, localId, settleAt }.
  const queues = new Map(), queueTimers = new Map(), checking = new Set(), claimed = new Set();
  let drainTimer;
  const configured = () => !!(config.baseUrl && config.key);
  let offApi = () => {};
  const rebuild = () => {
    offApi(); offApi = () => {};
    api = configured() ? apiFactory({ baseUrl: config.baseUrl, key: config.key, profile: config.profile }) : null; status = api ? 'idle' : 'unconfigured'; error = '';
    // A gateway-backed api reports its link: show it, warm the open thread when it comes up, reload a thread after a gap.
    if (api?.onLinkState) {
      const offs = [api.onLinkState((s) => { if (s.state === 'live') { if (activeId) warm(activeId); drainAll(); } notify(); }),
        api.onGap?.(({ storedId }) => { if (!runs.has(storedId)) revalidate(storedId); }), api.onUsage?.(noteUsage)];
      offApi = () => offs.forEach((off) => off?.());
    }
  };
  // Attach the open conversation and learn its context size once; later numbers arrive on the reply events.
  const warm = (id) => { api?.warm?.(id); Promise.resolve(api?.usage?.(id)).then((u) => noteUsage(id, u), () => {}); };
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
    for (const item of queues.get(id) || []) t.messages.push(queuedRow(item));
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

  // ── send queue ────────────────────────────────────────────────────────────
  // Every send is an item here first. It goes straight out when Hermes is reachable and the
  // conversation is idle; otherwise it waits (queued), in order, one prompt at a time, and goes
  // when the link returns or the retry timer finds Hermes. Items live on disk, so a restart keeps them.
  // An item is on disk before a send is acknowledged and before its request leaves, and a cancel removes it at once;
  // other changes are written 250 ms later (a crash inside that window repeats a step that the history check absorbs).
  const queueFile = (id) => path.join(queueDir, `${id}.json`);
  const queuedRow = (item) => ({ id: item.localId ||= `local-${++localSeq}`, role: 'user', text: item.text, ts: item.createdAt / 1000, state: item.state });
  function writeQueue(id) {
    clearTimeout(queueTimers.get(id)); queueTimers.delete(id);
    try {
      const items = queues.get(id);
      if (!items?.length) { fs.rmSync(queueFile(id), { force: true }); return; }
      fs.mkdirSync(queueDir, { recursive: true, mode: 0o700 });
      writePrivateJson(queueFile(id), JSON.stringify({ sessionId: id, items: items.map(({ localId, ...rest }) => rest) }));
    } catch {}
  }
  function saveQueueSoon(id) {
    if (queueTimers.has(id)) return;
    const timer = setTimeout(() => writeQueue(id), QUEUE_SAVE_MS);
    timer.unref?.();
    queueTimers.set(id, timer);
  }
  function loadQueues() {
    let names = [];
    try { names = fs.readdirSync(queueDir); } catch { return; }
    for (const name of names) {
      const id = name.slice(0, -5);
      if (!name.endsWith('.json') || !SESSION_ID.test(id)) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(queueDir, name), 'utf8'));
        const items = (Array.isArray(raw.items) ? raw.items : [])
          .filter((i) => i && CMID.test(i.cmid) && typeof i.text === 'string' && i.text.trim() && i.text.length <= MAX_TEXT && Number.isFinite(i.createdAt) && QUEUE_STATES.has(i.state))
          .slice(0, QUEUE_MAX)
          // An attempt that was in flight when the app quit is in doubt: it goes through the history check, never straight out.
          .map((i) => ({ cmid: i.cmid, text: i.text, createdAt: i.createdAt, state: i.state === 'sending' ? 'queued' : i.state,
            attempts: Math.max(Number.isSafeInteger(i.attempts) ? i.attempts : 0, i.state === 'sending' ? 1 : 0), attemptedAt: Number(i.attemptedAt) || 0, afterId: Number(i.afterId) || 0,
            ...(i.state === 'sending' ? { settleAt: now() + settleMs } : {}), ...(i.noCompact === true ? { noCompact: true } : {}) }));
        if (items.length) queues.set(id, items);
      } catch {}
    }
  }
  function setItemState(id, item, state) {
    item.state = state;
    const t = thread(id);
    t.messages = t.messages.map((m) => m.id === item.localId ? { ...m, state } : m);
    bump(t); saveQueueSoon(id);
  }
  function dropItem(id, item, { row = false } = {}) {
    const rest = (queues.get(id) || []).filter((i) => i !== item);
    if (rest.length) queues.set(id, rest); else queues.delete(id);
    if (row) { const t = thread(id); t.messages = t.messages.filter((m) => m.id !== item.localId); bump(t); }
    saveQueueSoon(id);
  }
  const ready = () => !api?.sendReady || api.sendReady();
  // Too old to run: an instruction typed half an hour ago should not fire now. It stays, as "Not sent".
  function sweep() {
    for (const [id, items] of queues) for (const item of items) if (item.state === 'queued' && now() - item.createdAt > QUEUE_MAX_MS) setItemState(id, item, 'failed');
  }
  function scheduleDrain() {
    if (drainTimer || ![...queues.values()].some((items) => items.some((i) => i.state === 'queued'))) return;
    drainTimer = setTimeout(() => { drainTimer = undefined; drainAll(); }, retryMs);
    drainTimer.unref?.();
  }
  function drainAll() { for (const id of [...queues.keys()]) drain(id); notify(); }
  // Only the head goes, and only with no reply running: a failed head holds everything behind it until the user decides.
  function drain(id) {
    sweep();
    const item = queues.get(id)?.[0];
    if (api && item?.state === 'queued' && !runs.has(id) && !checking.has(id) && !(item.settleAt > now()) && ready()) attempt(id, item);
    scheduleDrain();
  }

  async function attempt(id, item) {
    if (item.attempts > 0) {
      // An earlier try may have reached Hermes. Hermes takes no client id on a prompt yet, so history is the only
      // evidence: a user row with this text, newer than what we had when the first try began, not yet claimed.
      // drain() holds this read back for settleMs after the first try ended in doubt, so a request still on its way has landed.
      // shortcut: that is a delay, not proof (a request slower than settleMs still goes twice); it closes only when Hermes
      // returns the client id (NousResearch/hermes-agent#157880). Two identical messages typed within the 60 s window can also be mistaken for one another.
      checking.add(id);
      let body;
      try { body = await api.getMessages(id, { limit: 50, order: 'latest' }); } catch { checking.delete(id); scheduleDrain(); return; }
      checking.delete(id);
      if (item.state !== 'queued' || !queues.get(id)?.includes(item)) return;
      const fresh = (Array.isArray(body.data) ? body.data : []).map(toMessage).filter(Boolean);
      const hit = fresh.filter((m) => m.role === 'user' && m.text.trim() === item.text.trim() && m.id > item.afterId && m.ts >= item.attemptedAt / 1000 - 60 && !claimed.has(m.id))
        .sort((a, b) => a.id - b.id)[0];
      if (hit) {
        claimed.add(hit.id);
        dropItem(id, item, { row: true });
        apply(id, fresh);
        thread(id).notice = DELIVERED_NOTE;
        notify(); scheduleDrain();
        return;
      }
    }
    const t = thread(id);
    if (!item.attempts) item.afterId = t.messages.reduce((top, m) => typeof m.id === 'number' && m.id > top ? m.id : top, 0);
    item.attempts += 1; item.attemptedAt = now();
    setItemState(id, item, 'sending');
    writeQueue(id);
    startRun(id, item);
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
  // Hermes admits API turns only into API sessions and into the profile's local "Bot Chat" (its
  // peer door: gateway/platforms/api_server_bot_chat.py); every other surface's session refuses them.
  const isShared = (row) => !!row && LOCAL_SOURCES.has(row.source) && row.title === BOT_CHAT;
  const isReadOnly = (id) => sourceOf(id) !== 'api_server' && !isShared(sessions.find((s) => s.id === id));
  // A bot's conversation: the one it last used while that still exists; for a Telegram bot the
  // newest Telegram-source one (which Telegram bot it came from is not knowable here); else the newest one made here.
  const pickSession = () => (sessions.find((s) => s.id === wanted.sessionId) || (wanted.telegram && sessions.find((s) => s.source === 'telegram'))
    || sessions.find((s) => s.source === 'api_server'))?.id || '';

  function refreshSessions() {
    if (!api) { rebuild(); notify(); return Promise.resolve(); }
    return once('sessions', async () => {
      try {
        // Hermes Desktop's Bot Mode keeps the Bot Chat hidden from the general list: it is asked for by title and pinned first.
        const [body, bot] = await Promise.all([api.listSessions({ limit: MAX_SESSIONS }), api.listSessions({ limit: 1, title: BOT_CHAT, includeHidden: true }).catch(() => ({}))]);
        const listed = (Array.isArray(body.data) ? body.data : []).filter((s) => s && !s.hidden);
        for (const s of Array.isArray(bot.data) ? bot.data : []) if (s && isShared(s) && !listed.some((r) => r.id === s.id)) listed.push(s);
        const rows = listed.filter((s) => SESSION_ID.test(s.id) && !s.archived && !s.is_internal_child).map(sessionRow).sort((a, b) => isShared(b) - isShared(a));
        const local = sessions.filter((s) => s.id === activeId && !rows.some((r) => r.id === s.id));
        sessions = local.concat(rows).slice(0, MAX_SESSIONS);
        status = 'ready'; error = '';
        if (autoPick && !activeId) { activeId = pickSession(); if (activeId) revalidate(activeId); }
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
    const next = mergeMessages(base, fresh, (m) => m.state === 'failed' || m.state === 'queued' || (!!run?.localIds.includes(m.id) && !(m.role === 'user' && echoed.has(m.text))));
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
      } catch (e) { if (e?.code === 'http_404') t.notice = 'This conversation was deleted in Hermes.'; else fail(e); }
      t.loading = false; notify();
    });
  }

  function addCard(run, card) {
    const list = cards.get(run.id) || [], entry = { id: `card-${++cardSeq}`, state: 'open', ts: now() / 1000, runId: run.runId, answer: '', ...card };
    list.push(entry);
    cards.set(run.id, list.slice(-MAX_CARDS));
    return entry;
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
      case 'run.started': run.runId = str(d.run_id, 200); run.status = 'running'; setLocal(run, 'sent'); dropItem(run.id, run.item); break;
      case 'message.started': run.messageId = str(d.message?.id, 200); break;
      case 'assistant.delta': if (typeof d.delta === 'string' && run.text.length < MAX_TEXT) run.text += d.delta; break;
      case 'assistant.completed': if (typeof d.content === 'string') run.final = d.content; break;
      case 'tool.started': run.tool = toolLabel(d.tool_name); if (d.tool_name === 'clarify' && run.runId && !run.runId.startsWith('ws:')) pollClarify(run); break;
      // The gateway delivers a question as an event; the REST path finds it by polling the run.
      case 'clarify.request':
        if (!(cards.get(run.id) || []).some((c) => c.requestId === d.prompt_id)) {
          addCard(run, { kind: 'clarify', requestId: str(d.prompt_id, 200), generation: 0, question: str(d.question, 2000),
            choices: (Array.isArray(d.choices) ? d.choices : []).slice(0, 8).map((c) => str(String(c), 200)) });
        }
        break;
      case 'request.closed': for (const card of openCards(run)) if (card.requestId === d.request_id) card.state = 'expired'; break;
      case 'gateway.gap': run.gap = true; break;
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
      // A Bot Chat turn still waiting behind its owner's queue after the server's wait budget.
      case 'run.queued': run.outcome = 'queued'; break;
      case 'error': run.error = d.message === 'permission_denied' || d.code === 'permission_denied' ? REFUSED : str(d.message, 300); break;
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
      runs.delete(id);
      if (run.sent && !/^http_/.test(err.code)) run.item.settleAt = now() + settleMs;
      // Not admitted and not stopped by the user: Hermes was unreachable or busy. The message waits and goes again.
      if (WAIT_CODES.has(err.code) && queues.get(id)?.includes(run.item)) {
        if (err.code !== 'http_409') fail(err);
        setItemState(id, run.item, 'queued');
        scheduleDrain(); notify();
        return;
      }
      setItemState(id, run.item, 'failed');
      if (err.code === 'http_404') t.notice = 'This conversation was deleted in Hermes, so the message was not sent.';
      else if (err.code !== 'aborted') { fail(err); t.notice = 'That message was not sent.'; }
      notify();
      drain(id);
      return;
    }
    t.doneAt = now();
    const text = run.final || run.text;
    if (text) { const reply = { id: `local-${++localSeq}`, role: 'assistant', text: capText(text), ts: now() / 1000 }; t.messages = [...t.messages, reply]; run.localIds.push(reply.id); }
    t.notice = err && err.code !== 'aborted' ? 'The connection dropped during the reply; it may be incomplete.'
      : run.gap ? GAP_NOTE
      : run.outcome === 'failed' || (run.error && !text) ? (run.error || 'Hermes could not finish this reply.') : run.outcome === 'cancelled' ? 'Stopped.'
      : run.outcome === 'queued' ? 'Hermes queued this message behind a reply still running there. Refresh later to see the answer.' : '';
    setLocal(run, 'sent');
    runs.delete(id);
    if (id !== activeId || !visible()) unread.add(id);
    notify();
    await revalidate(id);
    // Hermes names a conversation after its first turn.
    if (!sessions.find((s) => s.id === id)?.title) refreshSessions();
    drain(id);
  }

  function startRun(id, item) {
    thread(id).notice = '';
    const run = { id, runId: '', messageId: '', text: '', final: '', tool: '', status: 'sending', outcome: '', error: '', localIds: [item.localId], item, abort: new AbortController(), startedAt: now() / 1000 };
    runs.set(id, run);
    notify();
    compactFirst(run).then(() => { run.sent = true; return api.streamChat(id, item.text, { signal: run.abort.signal, clientMessageId: item.cmid, onEvent: (name, data) => onEvent(run, name, data) }); })
      .then(() => finish(run, null), (e) => finish(run, e));
  }

  // ── compaction before a send ──────────────────────────────────────────────
  // What the chip and the send decision both read: the context size Hermes last reported and when the last turn ended
  // (this app's own clock, else the newest reply row's time). Unknown numbers decide nothing.
  function compactInputs(id) {
    if (!id || !compactEnabled() || !api?.compact || isReadOnly(id)) return null;
    const t = thread(id);
    if (!t.ctx) return null;
    const lastReply = (t.messages.findLast((m) => m.role === 'assistant')?.ts || 0) * 1000;
    return { usedTokens: t.ctx.used, windowTokens: t.ctx.max, idleSince: Math.max(t.doneAt || 0, lastReply) };
  }
  function compactReason(id) {
    const c = compactInputs(id);
    return c && shouldCompact({ usedTokens: c.usedTokens, windowTokens: c.windowTokens, idleMs: c.idleSince ? now() - c.idleSince : NaN });
  }
  function noteUsage(id, usage) {
    const used = Number(usage?.context_used), max = Number(usage?.context_max);
    if (!(used > 0 && max > 0) || !SESSION_ID.test(String(id))) return;
    const t = thread(id);
    if (t.ctx?.used === used && t.ctx.max === max) return;
    t.ctx = { used, max };
    notify();
  }
  // Once per message. A failure or the deadline sends the message anyway; only Stop holds it back (it stays "Not sent").
  async function compactFirst(run) {
    const { id, item } = run;
    if (item.noCompact || item.compactTried || !compactReason(id)) return;
    item.compactTried = true;
    const row = addCard(run, { kind: 'compact', state: 'working', text: 'Compacting conversation…' });
    const settle = (state, text) => { Object.assign(row, { state, text }); notify(); };
    run.status = 'compacting';
    notify();
    try {
      const result = await api.compact(id, { signal: run.abort.signal, timeoutMs: compactDeadlineMs });
      if (result?.status !== 'compressed') throw new Error('not compacted');
      const t = thread(id), after = Number(result.after_tokens);
      if (t.ctx && after > 0) t.ctx = { used: after, max: t.ctx.max };
      settle('done', 'Conversation compacted');
    } catch (e) {
      if (run.abort.signal.aborted) { settle('failed', 'Compaction stopped.'); throw Object.assign(new Error('Stopped.'), { code: 'aborted' }); }
      settle('failed', 'Could not compact, so the message was sent as it is.');
    } finally {
      if (run.status === 'compacting') run.status = 'sending';
    }
  }

  function setActive(id) {
    activeId = id; autoPick = false;
    unread.delete(id);
    if (id) { thread(id); warm(id); }
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
    async send({ sessionId, text, compact }) {
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
      const t = thread(id), items = queues.get(id) || [];
      if (items.length >= QUEUE_MAX || items.reduce((n, i) => n + i.text.length, 0) + text.length > QUEUE_BYTES) throw new Error('Too many messages are waiting to send. Wait for them to go, or delete some.');
      const item = { cmid: crypto.randomUUID(), text, createdAt: now(), state: 'queued', attempts: 0, attemptedAt: 0, afterId: 0, ...(compact === false ? { noCompact: true } : {}) };
      queues.set(id, [...items, item]);
      t.messages = [...t.messages, queuedRow(item)]; t.notice = ''; bump(t); writeQueue(id);
      const s = sessions.find((row) => row.id === id);
      if (s) { s.lastActive = now() / 1000; sessions = [s, ...sessions.filter((row) => row !== s)]; }
      drain(id);
      notify();
      return { ok: true, sessionId: id };
    },
    retry({ sessionId, localId }) {
      const id = String(sessionId || '');
      const item = queues.get(id)?.find((i) => i.localId === localId && i.state === 'failed');
      if (!item) throw new Error('Nothing to retry.');
      item.createdAt = now();
      setItemState(id, item, 'queued');
      drain(id); notify();
      return { ok: true };
    },
    // Cancel a waiting message, or delete a "Not sent" one. One being sent right now is stopped with Stop.
    cancel({ sessionId, localId }) {
      const id = String(sessionId || '');
      const item = queues.get(id)?.find((i) => i.localId === localId && i.state !== 'sending');
      if (!item) throw new Error('Nothing to cancel.');
      dropItem(id, item, { row: true });
      writeQueue(id);
      drain(id); notify();
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

  loadQueues();
  rebuild();
  if (activeId) thread(activeId);
  scheduleDrain();

  function getState() {
    const t = activeId ? thread(activeId) : null;
    const s = sessions.find((row) => row.id === activeId);
    const run = runs.get(activeId);
    return {
      configured: configured(), status, error, address: address(), link: api?.linkState?.() || null,
      sessions: sessions.map((row) => {
        const live = runs.get(row.id);
        return { ...row, readOnly: isReadOnly(row.id), shared: isShared(row), running: !!live, waiting: !!live && openCards(live).length > 0, unread: unread.has(row.id) };
      }),
      activeId,
      thread: t && { sessionId: activeId, rev: t.rev, messages: t.messages, loading: t.loading, hasOlder: t.hasOlder, notice: t.notice,
        title: s?.title || '', source: sourceOf(activeId), readOnly: isReadOnly(activeId), shared: isShared(s) },
      run: run ? { status: run.status, text: run.text, tool: run.tool, messageId: run.messageId } : null,
      compact: activeId && !run ? compactInputs(activeId) : null,
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
    get activeId() { return activeId; },
    // A row's view of one conversation, from memory only: no disk or network.
    info(id) {
      if (!sessions.some((s) => s.id === id)) return null;
      const live = runs.get(id), last = threads.get(id)?.messages.findLast((m) => m.role === 'assistant');
      return { unread: unread.has(id), waiting: !!live && openCards(live).length > 0, preview: plainLine(last?.text) };
    },
    show({ sessionId = '', telegram = false } = {}) {
      wanted = { sessionId, telegram };
      const id = pickSession();
      autoPick = !id;
      if (id === activeId) return;
      activeId = id;
      if (id) thread(id);
      persistConfigSoon();
      notify();
    },
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
    activate() { unread.delete(activeId); notify(); if (!api) return; refreshSessions(); if (activeId) revalidate(activeId); },
    flush() { persistConfig(); for (const [id, t] of threads) writeCache(id, t); for (const id of [...queueTimers.keys()]) writeQueue(id); },
  };
}

module.exports = { createNativeChat, mergeMessages, toMessage, toolLabel };
