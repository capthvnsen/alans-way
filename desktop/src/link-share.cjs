// URL detection for links shared in bot chats. Pure logic so unit tests can
// cover it without Electron — the Telegram preload supplies state + IPC send.
'use strict';

const SKIP_HOSTS = /(^|\.)t\.me$|(^|\.)telegram\.(org|me|dog)$/i;

function firstLink(message) {
  const body = message?.content?.text;
  const text = typeof body?.text === 'string' ? body.text : typeof body === 'string' ? body : '';
  let url = '';
  for (const entity of body?.entities || []) {
    if (entity?.type === 'MessageEntityTextUrl' && typeof entity.url === 'string') { url = entity.url; break; }
    if (entity?.type === 'MessageEntityUrl' && Number.isInteger(entity.offset) && Number.isInteger(entity.length)) {
      url = text.slice(entity.offset, entity.offset + entity.length); break;
    }
  }
  if (!url) url = text.match(/https?:\/\/[^\s<>"'()]+/)?.[0]?.replace(/[.,;:!?]+$/, '') || '';
  if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
  try {
    if (SKIP_HOSTS.test(new URL(url).hostname)) return '';
  } catch { return ''; }
  return url;
}

// Scans messages (previousSeen+1 .. lastId, at most the last 10) of one chat for
// new links. `seen`/`sent` are Maps/Sets owned by the caller; `send` delivers
// {chatId, url, outgoing}. First call only seeds the watermark — chat history
// is never opened retroactively.
function scanLinks({ userId, byId, lastId, currentUserId, seen, sent, send }) {
  if (!lastId) return;
  const previousSeen = seen.get(userId);
  if (previousSeen === undefined) { seen.set(userId, lastId); return; }
  if (lastId === previousSeen) return;
  seen.set(userId, lastId);
  for (let id = Math.max(previousSeen + 1, lastId - 9); id <= lastId; id++) {
    const message = byId?.[id], key = `${userId}:${id}`, url = firstLink(message);
    if (!message || !url || sent.has(key)) continue;
    sent.add(key);
    if (sent.size > 400) sent.clear();
    send({ chatId: String(userId), url,
      outgoing: message.isOutgoing === true || String(message.senderId || '') === String(currentUserId || '') });
  }
}

module.exports = { firstLink, scanLinks };
