const { ipcRenderer, contextBridge } = require('electron');
const { firstLink, scanLinks } = require('./link-share.cjs');
const { botAccent } = require('./agent-input.cjs');

// Read only the API worker's actual chat-action updates. Do not infer work from
// outgoing messages, previews, unread counts, or the persisted Telegram cache.
// Upstream: src/api/gramjs/worker/connector.ts and updates/mtpUpdateHandler.ts
// https://github.com/Ajaxy/telegram-tt
let activityAccountId = '', activityConnected = false, activitySequence = 0;
const seenLinks = new Map(), sentLinkIds = new Set();
let activityWorkerReady = false, activityNetworkReady = true, activityRuntimeAccount = '';
const telegramActions = new Set(['typing', 'recordVideo', 'uploadVideo', 'recordAudio', 'uploadAudio', 'uploadPhoto',
  'uploadFile', 'chooseLocation', 'chooseContact', 'playingGame', 'recordRound', 'uploadRound', 'chooseSticker', 'watchingAnimations']);

function sendActivity(type, details = {}) {
  if (!activityAccountId) return;
  ipcRenderer.send('telegram:activity', { version: 1, source: 'telegram-web-a-worker', accountId: activityAccountId,
    observedAt: Date.now(), sequence: ++activitySequence, type, ...details });
}
function isActivityAvailable() {
  return activityConnected && activityWorkerReady && activityNetworkReady && navigator.onLine !== false &&
    (!activityRuntimeAccount || activityRuntimeAccount === activityAccountId);
}
function publishActivityAvailability() { sendActivity(isActivityAvailable() ? 'ready' : 'unavailable'); }

// "Working" indicator: an iMessage-style bubble pinned above the composer of
// the open bot chat. Typing actions come straight from the worker stream;
// browser work is pushed from the main process on workspace:bot-activity.
const typingActivity = new Map();
let workActivity = {};
const TYPING_TTL_MS = 8000;
function renderAgentBubble() {
  const chatId = location.hash.slice(1).split('_')[0] || '';
  const now = Date.now();
  for (const [id, at] of typingActivity) if (at + TYPING_TTL_MS <= now) typingActivity.delete(id);
  const typing = typingActivity.has(chatId), working = Object.hasOwn(workActivity, chatId);
  let bubble = document.querySelector('.hw-agent-bubble');
  if (!chatId || (!typing && !working) || !activityConnected) { bubble?.remove(); return; }
  const composer = document.querySelector('#MiddleColumn .Composer, .Composer');
  if (!composer) { bubble?.remove(); return; }
  if (!bubble) {
    bubble = document.createElement('div');
    bubble.className = 'hw-agent-bubble';
    bubble.innerHTML = '<i></i><i></i><i></i>';
    document.body.append(bubble);
  }
  const rect = composer.getBoundingClientRect();
  bubble.style.left = `${Math.round(rect.left + 14)}px`;
  bubble.style.top = `${Math.round(rect.top - 46)}px`;
  bubble.style.setProperty('--h', String(working ? workActivity[chatId] : botAccent(chatId).hue));
  bubble.title = typing ? 'Bot is typing in Telegram' : 'Bot is working in a workspace tab';
  bubble.classList.toggle('typing', typing);
}
function receiveTelegramActivity(update) {
  if (!update || typeof update !== 'object') return;
  switch (update.type) {
    case 'ready': activityWorkerReady = true; break;
    case 'unavailable': activityWorkerReady = false; break;
    case 'connection': activityNetworkReady = update.ready === true; break;
    case 'account':
      if (!/^\d{1,20}$/.test(update.accountId)) return;
      activityRuntimeAccount = update.accountId;
      activityWorkerReady = true;
      break;
    case 'logout':
      activityWorkerReady = false; activityRuntimeAccount = ''; activityConnected = false;
      break;
    case 'action':
      if (!isActivityAvailable() || !/^\d{1,20}$/.test(update.botId) || update.actorId !== update.botId ||
        (update.action !== 'cancel' && !telegramActions.has(update.action))) return;
      sendActivity('action', { botId: update.botId, actorId: update.actorId, action: update.action });
      if (update.action === 'cancel') typingActivity.delete(update.botId); else typingActivity.set(update.botId, Date.now());
      renderAgentBubble();
      return;
    default: return;
  }
  publishActivityAvailability();
}

if (location.origin === 'https://web.telegram.org' && location.pathname.startsWith('/a/')) {
  try {
    // Runs synchronously before page scripts construct the Worker. Passing this
    // one callback keeps IPC and Node APIs out of Telegram's main world entirely.
    contextBridge.executeInMainWorld({ args: [receiveTelegramActivity], func: (report) => {
      const OriginalWorker = window.Worker;
      if (typeof OriginalWorker !== 'function') return;
      window.Worker = new Proxy(OriginalWorker, {
        construct(Target, args, NewTarget) {
          const worker = Reflect.construct(Target, args, NewTarget);
          let url;
          try { url = new URL(String(args[0]), location.href); } catch { return worker; }
          if (url.origin !== 'https://web.telegram.org' || !url.pathname.startsWith('/a/')) return worker;
          let isApiWorker = false;
          const emit = (value) => { try { report(value); } catch {} };
          worker.addEventListener('message', (event) => {
            // Ignore script-dispatched events; real Worker messages are trusted.
            if (!event.isTrusted || !Array.isArray(event.data?.payloads)) return;
            for (const payload of event.data.payloads) {
              if (payload?.type !== 'updates' || !Array.isArray(payload.updates)) continue;
              for (const update of payload.updates) {
                if (!update || typeof update !== 'object') continue;
                switch (update['@type']) {
                  case 'updateApiReady':
                    isApiWorker = true; emit({ type: 'ready' }); break;
                  case 'updateConnectionState':
                    isApiWorker = true;
                    emit({ type: 'connection', ready: update.connectionState === 'connectionStateReady' });
                    break;
                  case 'updateCurrentUser':
                    isApiWorker = true;
                    emit({ type: 'account', accountId: String(update.currentUser?.id || '') });
                    break;
                  case 'updateAuthorizationState':
                    isApiWorker = true;
                    if (update.authorizationState !== 'authorizationStateReady') emit({ type: 'logout' });
                    break;
                  case 'updateChatTypingStatus': {
                    isApiWorker = true;
                    const botId = update.id, actorId = update.peerId;
                    // Private-chat updates identify the same user as chat and
                    // actor. Groups or another participant cannot activate a bot.
                    if (typeof botId !== 'string' || botId !== actorId || !/^\d{1,20}$/.test(botId)) break;
                    emit({ type: 'ready' });
                    emit({ type: 'action', botId, actorId, action: update.typingStatus === undefined ? 'cancel' : update.typingStatus?.type });
                    break;
                  }
                }
              }
            }
          });
          worker.addEventListener('error', () => { if (isApiWorker) emit({ type: 'unavailable' }); });
          const terminate = worker.terminate;
          worker.terminate = function (...values) {
            if (isApiWorker) emit({ type: 'unavailable' });
            return Reflect.apply(terminate, this, values);
          };
          return worker;
        },
      });
    } });
  } catch { activityWorkerReady = false; }
}
const CSS = `
  :root, body { color-scheme: dark !important; --color-background: #09090a !important; --color-background-secondary: #151516 !important; --color-background-secondary-accent: #242425 !important; --color-text: #e8e8e8 !important; --color-text-secondary: #858588 !important; --color-primary: #bcbcc2 !important; --color-message-meta: #939396 !important; --color-message-background: #262627 !important; --color-own-message-background: #555558 !important; }
  html, body, #root, #Main, .MiddleColumn, .messages-layout, .messages-container, .MessageList { background-color: #09090a !important; background-image: none !important; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif !important; }
  .Message .message-content { background: #252526 !important; border-radius: 18px !important; color: #e8e8eb !important; box-shadow: none !important; }
  .Message.own .message-content { background: #555558 !important; }
  .Message .message-content::before, .Message .message-content::after, .Message .svg-appendix { display: none !important; }
  .Composer .composer-wrapper, .Composer .message-input-wrapper, .Composer .input-message-input { background: #29292b !important; color: #ededf0 !important; }
  .message-input-wrapper { border-radius: 25px !important; }
  .Composer .input-message-container { border-radius: 25px !important; background: #29292b !important; }
  .Composer .svg-appendix { display: none !important; }
  .messages-container { --pattern-color: transparent !important; }
  body.hw-chat #LeftColumn { display: none !important; }
  body.hw-chat #MiddleColumn { width: 100% !important; max-width: none !important; flex: 1 !important; transform: none !important; margin: 0 !important; opacity: 1 !important; }
  body.hw-chat #Main { display: flex !important; width: 100% !important; }
  body.hw-chat #MiddleColumn .MiddleHeader { display: none !important; }
  body.hw-chat #MiddleColumn > [class*="background"], body.hw-chat #MiddleColumn > .bg-pattern, body.hw-chat #MiddleColumn > .bg-image { display: none !important; }
  body.hw-chat .messages-layout, body.hw-chat .middle-column-container { max-width: none !important; }
  body.hw-chat .message-list-item { max-width: 100% !important; }
  body.hw-chat .Composer { width: calc(100% - 24px) !important; max-width: none !important; margin: 0 12px 10px !important; }
  #auth-qr-form, #auth-phone-number-form { max-width: calc(100vw - 38px) !important; }
  .hw-agent-bubble { position: fixed; z-index: 60; display: flex; gap: 5px; align-items: center; padding: 10px 14px 10px 12px; border-radius: 18px 18px 18px 6px; background: #1c1c1e; border: 1px solid hsl(var(--h,168), 45%, 32%); box-shadow: 0 2px 10px rgba(0,0,0,.45), 0 0 12px hsla(var(--h,168), 80%, 55%, .18); pointer-events: none; }
  .hw-agent-bubble i { width: 7px; height: 7px; border-radius: 50%; background: hsl(var(--h,168), 80%, 62%); opacity: .35; animation: hwWingBeat 1.5s infinite; }
  .hw-agent-bubble i:nth-child(2) { animation-delay: .18s; }
  .hw-agent-bubble i:nth-child(3) { animation-delay: .36s; }
  @keyframes hwWingBeat { 0%, 55%, 100% { transform: translateY(0) scale(1); opacity: .35; } 18% { transform: translateY(-5px) scale(1.3); opacity: 1; } 34% { transform: translateY(1px) scale(.92); opacity: .7; } }
`;
let busy = false, db, previous = '', timer, dbDiag = 'init';
function readDatabase() {
  return new Promise((resolve) => {
    if (db) return read(db);
    const request = indexedDB.open('tt-data');
    // The wrapper never creates or upgrades Telegram's database.
    request.onupgradeneeded = () => { request.transaction.abort(); dbDiag = 'upgradeneeded'; resolve(null); };
    request.onerror = () => { dbDiag = 'open-error'; resolve(null); };
    request.onblocked = () => { dbDiag = 'open-blocked'; };
    request.onsuccess = () => { db = request.result; db.onversionchange = () => { db.close(); db = null; }; read(db); };
    function read(database) {
      if (!database.objectStoreNames.contains('store')) { dbDiag = `no-store:${[...database.objectStoreNames].join('|')}`; return resolve(null); }
      const slot = new URL(location.href).searchParams.get('account');
      const key = slot && slot !== '1' ? `tt-global-state_${slot}` : 'tt-global-state';
      const get = database.transaction('store', 'readonly').objectStore('store').get(key);
      get.onsuccess = () => { dbDiag = get.result ? 'ok' : `empty:${key}`; resolve(get.result || null); };
      get.onerror = () => { dbDiag = 'get-error'; resolve(null); };
    }
  });
}
async function sync() {
  if (busy || location.origin !== 'https://web.telegram.org' || !location.pathname.startsWith('/a/')) return;
  busy = true;
  try {
    const cached = await readDatabase();
    const authVisible = !!document.querySelector('#auth-pages, #auth-qr-form, #auth-phone-number-form');
    const locked = cached?.passcode?.isScreenLocked;
    const status = locked ? 'locked' : authVisible ? 'login' : cached?.currentUserId ? 'connected' : 'loading';
    activityAccountId = cached?.currentUserId ? String(cached.currentUserId) : '';
    activityConnected = status === 'connected';
    const users = cached?.users?.byId || {};
    const chats = cached?.chats?.byId || {};
    const bots = [];
    const links = [...document.querySelectorAll('#LeftColumn a[href]')];
    for (const user of Object.values(users)) {
      if (!(user?.isBot === true || user?.type === 'userTypeBot' || user?.type === 'bot') || !chats[user.id]) continue;
      const chat = chats[user.id];
      const username = user.usernames?.find((item) => item.isActive)?.username || user.username || '';
      const link = links.find(el => el.hash?.slice(1).split('_')[0] === String(user.id));
      const row = link?.closest('.Chat, .ListItem') || link;
      const lastId = chat.lastMessageId || cached.chats?.lastMessageIds?.all?.[user.id];
      const last = cached.messages?.byChatId?.[user.id]?.byId?.[lastId];
      if (status === 'connected') scanLinks({ userId: user.id, byId: cached.messages?.byChatId?.[user.id]?.byId,
        lastId, currentUserId: cached?.currentUserId, seen: seenLinks, sent: sentLinkIds,
        send: (value) => ipcRenderer.send('telegram:link', value) });
      let avatar = '';
      const image = row?.querySelector('.Avatar img, .avatar img, img');
      if (image?.complete && image.naturalWidth) {
        try { const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 64; canvas.getContext('2d').drawImage(image, 0, 0, 64, 64); avatar = canvas.toDataURL('image/png'); } catch {}
      }
      bots.push({ id: String(user.id), isBot: true, name: [user.firstName, user.lastName].filter(Boolean).join(' ') || username || 'Telegram bot', username,
        unread: chat.unreadCount || 0, preview: row?.querySelector('.last-message, .subtitle')?.textContent?.trim() || last?.content?.text?.text || '', avatar });
    }
    const selectedLink = links.find(el => el.closest('.selected'));
    const selectedId = selectedLink?.hash?.slice(1).split('_')[0] || location.hash.slice(1).split('_')[0];
    const selectedBot = bots.some((bot) => bot.id === selectedId);
    document.body.classList.toggle('hw-chat', status === 'connected');
    // Keep the native list filtered too, when visible during initial sync.
    const botIds = new Set(bots.map((bot) => bot.id));
    links.forEach((link) => {
      const id = link.hash?.slice(1).split('_')[0];
      const row = link.closest('.Chat, .ListItem') || link;
      row.style.display = botIds.has(id) ? '' : 'none';
    });
    const packet = { status, accountId: cached?.currentUserId ? String(cached.currentUserId) : '', bots, selectedId: selectedBot ? selectedId : '',
      diagnostics: { userCount: Object.keys(users).length, botCount: Object.values(users).filter(user => user?.isBot === true || user?.type === 'userTypeBot' || user?.type === 'bot').length, chatCount: Object.keys(chats).length,
        chatNodes: links.length, storeKeys: cached ? Object.keys(cached) : [], lastIds: bots.map(bot => [bot.id, chats[bot.id]?.lastMessageId || 0]), dbDiag,
        agentBubble: !!document.querySelector('.hw-agent-bubble'), workBots: Object.keys(workActivity), openChat: location.hash.slice(1).split('_')[0] || '',
        userFields: Object.keys(Object.values(users)[0] || {}), usersFields: Object.keys(cached?.users || {}), chatsFields: Object.keys(cached?.chats || {}) } };
    const signature = JSON.stringify(packet);
    if (signature !== previous) { previous = signature; ipcRenderer.send('telegram:catalog', packet); }
    publishActivityAvailability();
    renderAgentBubble();
  } catch {} finally { busy = false; }
}
window.addEventListener('DOMContentLoaded', () => {
  const style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);
  sync(); timer = setInterval(sync, 2500);
});
ipcRenderer.on('telegram:sync', sync);
ipcRenderer.on('workspace:bot-activity', (_event, working) => { workActivity = working && typeof working === 'object' ? working : {}; renderAgentBubble(); });
window.addEventListener('offline', publishActivityAvailability);
window.addEventListener('online', publishActivityAvailability);
window.addEventListener('beforeunload', () => { sendActivity('unavailable'); clearInterval(timer); db?.close(); });
