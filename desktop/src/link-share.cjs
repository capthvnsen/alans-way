// URL detection for links shared in bot chats. Pure logic so unit tests can
// cover it without Electron — the Telegram preload supplies state + IPC send.
'use strict';

const SKIP_HOSTS = /(^|\.)t\.me$|(^|\.)telegram\.(org|me|dog)$/i;
const BARE_LINK_LABEL = /^[^\s:/?#]+\.[^\s:/?#]+(?::\d+)?(?:[/?#]\S*)?$/u;

function firstLink(message) {
  const body = message?.content?.text;
  const text = typeof body?.text === 'string' ? body.text : typeof body === 'string' ? body : '';
  let url = '';
  for (const entity of body?.entities || []) {
    if (entity?.type === 'MessageEntityTextUrl' && typeof entity.url === 'string') {
      const label = text.slice(entity.offset, entity.offset + entity.length).trim();
      // Telegram can represent linkified filenames/hosts as TextUrl too, with
      // a scheme already added to the target. Inspect the displayed label;
      // a filename alone still does not opt into opening a workspace tab.
      if (BARE_LINK_LABEL.test(label)) continue;
      url = entity.url; break;
    }
    if (entity?.type === 'MessageEntityUrl' && Number.isInteger(entity.offset) && Number.isInteger(entity.length)) {
      const candidate = text.slice(entity.offset, entity.offset + entity.length);
      // Telegram also linkifies bare hosts and filenames such as SKILL.md.
      // Only an explicit web scheme in the message opts into auto-open.
      if (/^https?:\/\//i.test(candidate)) { url = candidate; break; }
    }
  }
  if (!url) url = text.match(/https?:\/\/[^\s<>"'()]+/i)?.[0]?.replace(/[.,;:!?]+$/, '') || '';
  if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
  try {
    if (SKIP_HOSTS.test(new URL(url).hostname)) return '';
  } catch { return ''; }
  return url;
}

// Scans messages (previousSeen+1 .. lastId, at most the last 10) of one chat for
// new links. `seen`/`sent` are Maps/Sets owned by the caller; `send` delivers
// {chatId, url, outgoing}. First call only seeds the watermark — chat history
// is never opened retroactively. Telegram publishes a chat's last id before the
// message body reaches the cache, so the watermark moves only past ids whose
// message is present; a late body is still scanned on a later tick.
function scanLinks({ userId, byId, lastId, currentUserId, seen, sent, send }) {
  if (!lastId) return;
  const previousSeen = seen.get(userId);
  if (previousSeen === undefined) { seen.set(userId, lastId); return; }
  if (lastId === previousSeen) return;
  let advanced = previousSeen;
  for (let id = Math.max(previousSeen + 1, lastId - 9); id <= lastId; id++) {
    const message = byId?.[id], key = `${userId}:${id}`, url = firstLink(message);
    if (!message) continue;
    advanced = id;
    if (!url || sent.has(key)) continue;
    sent.add(key);
    if (sent.size > 400) sent.clear();
    send({ chatId: String(userId), url,
      outgoing: message.isOutgoing === true || String(message.senderId || '') === String(currentUserId || '') });
  }
  seen.set(userId, advanced);
}

module.exports = { firstLink, scanLinks };
