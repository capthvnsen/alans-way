// Telegram's updateUserTyping expires after six seconds without another update.
// https://core.telegram.org/constructor/updateUserTyping
const ACTIVITY_TTL_MS = 6000;
const BRIDGE_TTL_MS = 8000;
const ACTIVITY_SOURCE = 'telegram-web-a-worker';
const ACTION_LABELS = Object.freeze({
  typing: 'Typing', recordVideo: 'Recording video', uploadVideo: 'Uploading video',
  recordAudio: 'Recording audio', uploadAudio: 'Uploading audio', uploadPhoto: 'Uploading photo',
  uploadFile: 'Uploading file', chooseLocation: 'Choosing location', chooseContact: 'Choosing contact',
  playingGame: 'Playing a game', recordRound: 'Recording video message', uploadRound: 'Uploading video message',
  chooseSticker: 'Choosing sticker', watchingAnimations: 'Viewing animation',
});

function createActivityTracker() {
  let accountId = '', connected = false, available = false, bridgeSeenAt = 0, lastSequence = -1;
  let botIds = new Set();
  const active = new Map();

  function clear() {
    const changed = available || active.size > 0;
    available = false; bridgeSeenAt = 0; lastSequence = -1; active.clear();
    return changed;
  }

  function setContext(context = {}) {
    const nextAccount = typeof context.accountId === 'string' && /^\d+$/.test(context.accountId) ? context.accountId : '';
    const nextConnected = context.connected === true && !!nextAccount;
    let changed = false;
    if (accountId !== nextAccount || connected !== nextConnected) changed = clear();
    accountId = nextAccount; connected = nextConnected;
    botIds = new Set((Array.isArray(context.bots) ? context.bots : []).filter(bot => bot?.isBot === true && /^\d+$/.test(bot.id)).map(bot => String(bot.id)));
    for (const id of active.keys()) if (!botIds.has(id)) { active.delete(id); changed = true; }
    return changed;
  }

  function ingest(packet, now = Date.now()) {
    if (!connected || !packet || packet.version !== 1 || packet.source !== ACTIVITY_SOURCE || packet.accountId !== accountId) return false;
    if (!Number.isFinite(packet.observedAt) || packet.observedAt > now + 250 || now - packet.observedAt >= ACTIVITY_TTL_MS) return false;
    if (!Number.isSafeInteger(packet.sequence) || packet.sequence < 0 || packet.sequence <= lastSequence) return false;
    if (!['ready', 'unavailable', 'action'].includes(packet.type)) return false;
    if (packet.type === 'action' && (!botIds.has(packet.botId) || packet.actorId !== packet.botId || packet.actorId === accountId ||
      (packet.action !== 'cancel' && !Object.hasOwn(ACTION_LABELS, packet.action)))) return false;
    lastSequence = packet.sequence;
    if (packet.type === 'unavailable') {
      const changed = available || active.size > 0;
      available = false; bridgeSeenAt = 0; active.clear();
      return changed;
    }
    const wasAvailable = available;
    available = true; bridgeSeenAt = now;
    if (packet.type === 'ready') return !wasAvailable;
    if (packet.action === 'cancel') return active.delete(packet.botId) || !wasAvailable;
    const previous = active.get(packet.botId);
    active.set(packet.botId, { action: packet.action, observedAt: packet.observedAt, expiresAt: packet.observedAt + ACTIVITY_TTL_MS });
    return !wasAvailable || !previous || previous.action !== packet.action || previous.observedAt !== packet.observedAt;
  }

  function expire(now = Date.now()) {
    let changed = false;
    if (available && now - bridgeSeenAt >= BRIDGE_TTL_MS) {
      available = false; active.clear(); return true;
    }
    for (const [id, evidence] of active) if (evidence.expiresAt <= now) { active.delete(id); changed = true; }
    return changed;
  }

  function get(botId, now = Date.now()) {
    if (!connected || !available || !botIds.has(botId) || now - bridgeSeenAt >= BRIDGE_TTL_MS) {
      return { state: 'unknown', action: '', label: 'Activity unavailable', source: '', observedAt: 0, expiresAt: 0 };
    }
    const evidence = active.get(botId);
    if (!evidence || evidence.expiresAt <= now) {
      return { state: 'idle', action: '', label: 'No current Telegram activity', source: ACTIVITY_SOURCE, observedAt: 0, expiresAt: 0 };
    }
    return { state: 'active', ...evidence, label: ACTION_LABELS[evidence.action], source: ACTIVITY_SOURCE };
  }

  return { setContext, ingest, get, clear, expire };
}

module.exports = { ACTIVITY_TTL_MS, BRIDGE_TTL_MS, ACTIVITY_SOURCE, ACTION_LABELS, createActivityTracker };
