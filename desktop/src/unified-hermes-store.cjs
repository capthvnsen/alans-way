'use strict';
// Per-bot reader for the unified thread. The caller owns refresh cadence and bindings.
const { normalizeRows, mergeThread, laneOfSession } = require('./unified-thread.cjs');

const LANES = Object.freeze(['telegram', 'hermes-desktop', 'native']);
const BINDING_KEYS = Object.freeze({ telegram: 'telegramSessionId', 'hermes-desktop': 'hermesSessionId', native: 'nativeSessionId' });
const PAGE = 500, SESSION_PAGE = 200, BOT_CHAT = 'Bot Chat';
const SESSION_ID = /^[\w.-]{1,128}$/;
const SIGNIN_CODES = new Set(['unauthorized', 'signin', 'session_expired', 'needs_signin', 'auth_failed']);
const str = (value, max = 4000) => typeof value === 'string' ? value.slice(0, max) : '';

const healthOfError = (error) => SIGNIN_CODES.has(error?.code) || error?.status === 401 ? 'signin' : 'offline';

function createUnifiedHermesStore({ client, bindings = {}, pageSize = PAGE } = {}) {
  if (!client || typeof client.getMessages !== 'function') throw new Error('A Hermes API client is required.');
  const lanes = Object.fromEntries(LANES.map((lane) => {
    const sessionId = str(bindings[BINDING_KEYS[lane]], 128);
    return [lane, { sessionId, health: sessionId ? 'syncing' : 'unavailable', messages: [] }];
  }));
  let activeRefresh = null;

  async function readHistory(sessionId) {
    const rows = [];
    let offset = 0, previousSignature = '';
    for (;;) {
      const body = await client.getMessages(sessionId, { limit: pageSize, offset, order: 'latest' });
      const page = Array.isArray(body?.data) ? body.data : [];
      rows.push(...page);
      offset += page.length;
      if (page.length < pageSize) break;
      const signature = `${page.length}:${page[0]?.id}:${page.at(-1)?.id}`;
      // A malformed server must not turn an automatic full-history read into an endless loop.
      if (signature === previousSignature) break;
      previousSignature = signature;
    }
    return rows;
  }

  async function refreshNow() {
    await Promise.all(LANES.map(async (lane) => {
      const entry = lanes[lane];
      if (!entry.sessionId) {
        entry.messages = [];
        entry.health = 'unavailable';
        return;
      }
      entry.health = 'syncing';
      try {
        entry.messages = normalizeRows(lane, entry.sessionId, await readHistory(entry.sessionId));
        entry.health = 'live';
      } catch (error) {
        entry.health = healthOfError(error);
      }
    }));
  }

  function refresh() {
    if (!activeRefresh) activeRefresh = refreshNow().finally(() => { activeRefresh = null; });
    return activeRefresh;
  }

  async function listSessionRows() {
    if (typeof client.listSessions !== 'function') throw new Error('The Hermes API client cannot list sessions.');
    const rows = [], seen = new Set();
    let offset = 0;
    for (;;) {
      const body = await client.listSessions({ limit: SESSION_PAGE, offset });
      const page = Array.isArray(body?.data) ? body.data : [];
      let added = 0;
      for (const session of page) {
        const id = str(session?.id, 128);
        if (!id || seen.has(id)) continue;
        seen.add(id); rows.push(session); added++;
      }
      offset += page.length;
      if (!page.length || page.length < SESSION_PAGE || body?.has_more === false || !added) break;
    }
    // Bot Mode hides the shared conversation from the general list, as in native-chat.cjs.
    const hidden = await client.listSessions({ limit: 1, title: BOT_CHAT, includeHidden: true }).catch(() => ({}));
    for (const session of Array.isArray(hidden?.data) ? hidden.data : []) {
      const id = str(session?.id, 128);
      if (id && !seen.has(id)) { seen.add(id); rows.push(session); }
    }
    return rows;
  }

  const candidateRow = (session) => ({
    id: str(session.id, 128),
    title: str(session.title, 200),
    source: str(session.source, 40),
    platform: str(session.platform, 40),
    preview: str(session.preview, 200),
    lastActive: Number(session.last_active ?? session.lastActive ?? session.started_at) || 0,
    hidden: session.hidden === true,
  });

  async function candidates() {
    const groups = Object.fromEntries(LANES.map((lane) => [lane, []]));
    for (const session of await listSessionRows()) {
      const lane = laneOfSession(session);
      if (!lane || !SESSION_ID.test(str(session?.id, 128)) || session.archived || session.is_internal_child) continue;
      if (session.hidden && !(session.title === BOT_CHAT && lane === 'hermes-desktop')) continue;
      groups[lane].push(candidateRow(session));
    }
    if (groups.telegram.length === 1) groups.telegram[0] = { ...groups.telegram[0], only: true };
    return groups;
  }

  function snapshot() {
    return {
      messages: mergeThread(Object.fromEntries(LANES.map((lane) => [lane, lanes[lane].messages]))),
      lanes: Object.fromEntries(LANES.map((lane) => [lane, { health: lanes[lane].health, sessionId: lanes[lane].sessionId }])),
    };
  }

  return { snapshot, refresh, candidates };
}

module.exports = { createUnifiedHermesStore };
