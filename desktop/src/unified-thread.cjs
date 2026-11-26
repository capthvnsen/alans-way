'use strict';
// Pure merge logic for one bot's conversation across the three chat lanes.
const { toMessage } = require('./native-chat.cjs');

const LANES = Object.freeze(['telegram', 'hermes-desktop', 'native']);
const LOCAL_SOURCES = new Set(['local', 'cli', 'tui', 'gui', 'desktop']);

const text = (value) => typeof value === 'string' ? value : '';
const finite = (value) => Number.isFinite(value) ? value : 0;

function normalizeRows(lane, sessionId, serverRows) {
  const id = text(sessionId);
  return (Array.isArray(serverRows) ? serverRows : []).map((row) => {
    // toMessage is native-chat.cjs's server-row reduction: user/assistant text only.
    const message = toMessage(row);
    return message && {
      key: `hermes:${id}:${message.id}`,
      lane,
      sessionId: id,
      rowId: message.id,
      role: message.role,
      text: message.text,
      ts: message.ts,
      state: 'sent',
    };
  }).filter(Boolean);
}

function compareText(a, b) {
  a = text(a); b = text(b);
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareRowId(a, b) {
  const an = typeof a === 'number', bn = typeof b === 'number';
  if (an && bn) return a - b;
  if (an !== bn) return an ? -1 : 1;
  return compareText(String(a ?? ''), String(b ?? ''));
}

function compareMessages(a, b) {
  return (finite(a.ts) - finite(b.ts)) || compareText(a.sessionId, b.sessionId) || compareRowId(a.rowId, b.rowId);
}

function perLaneArrays(lanes) {
  if (Array.isArray(lanes)) return lanes.filter(Array.isArray);
  if (!lanes || typeof lanes !== 'object') return [];
  const known = LANES.filter((lane) => Array.isArray(lanes[lane]));
  const other = Object.keys(lanes).filter((lane) => !LANES.includes(lane) && Array.isArray(lanes[lane]));
  return [...known, ...other].map((lane) => lanes[lane]);
}

function mergeThread(lanes) {
  const byKey = new Map();
  for (const rows of perLaneArrays(lanes)) {
    for (const message of rows) {
      if (!message || typeof message.key !== 'string' || !message.key) continue;
      // A key is one server row (or one optimistic row), even when the same session is bound twice.
      if (!byKey.has(message.key)) byKey.set(message.key, message);
    }
  }
  return [...byKey.values()].sort(compareMessages);
}

function sendableList(sendable) {
  const list = sendable instanceof Set ? [...sendable] : Array.isArray(sendable) ? sendable
    : sendable && typeof sendable === 'object' ? LANES.filter((lane) => sendable[lane]) : [];
  return list.filter((lane, index) => LANES.includes(lane) && list.indexOf(lane) === index);
}

function defaultSendLane(messages, sendable) {
  const choices = sendableList(sendable);
  let latest = null;
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message && LANES.includes(message.lane) && (!latest || compareMessages(message, latest) >= 0)) latest = message;
  }
  if (latest && choices.includes(latest.lane)) return latest.lane;
  return choices[0] || '';
}

function laneOfSession(session) {
  if (!session || typeof session !== 'object') return '';
  const kind = text(session.source).toLowerCase() || text(session.platform).toLowerCase();
  if (kind === 'telegram') return 'telegram';
  if (kind === 'api_server') return 'native';
  // local/cli/tui/gui/desktop are the local-surface family native-chat.cjs already recognizes.
  if (LOCAL_SOURCES.has(kind)) return 'hermes-desktop';
  return '';
}

module.exports = { normalizeRows, mergeThread, defaultSendLane, laneOfSession };
