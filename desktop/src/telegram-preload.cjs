const { ipcRenderer } = require('electron');
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
`;
let busy = false, db, previous = '', timer;
function readDatabase() {
  return new Promise((resolve) => {
    if (db) return read(db);
    const request = indexedDB.open('tt-data');
    // The wrapper never creates or upgrades Telegram's database.
    request.onupgradeneeded = () => { request.transaction.abort(); resolve(null); };
    request.onerror = () => resolve(null);
    request.onsuccess = () => { db = request.result; db.onversionchange = () => { db.close(); db = null; }; read(db); };
    function read(database) {
      if (!database.objectStoreNames.contains('store')) return resolve(null);
      const slot = new URL(location.href).searchParams.get('account');
      const key = slot && slot !== '1' ? `tt-global-state_${slot}` : 'tt-global-state';
      const get = database.transaction('store', 'readonly').objectStore('store').get(key);
      get.onsuccess = () => resolve(get.result || null); get.onerror = () => resolve(null);
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
        chatNodes: links.length,
        userFields: Object.keys(Object.values(users)[0] || {}), usersFields: Object.keys(cached?.users || {}), chatsFields: Object.keys(cached?.chats || {}) } };
    const signature = JSON.stringify(packet);
    if (signature !== previous) { previous = signature; ipcRenderer.send('telegram:catalog', packet); }
  } catch {} finally { busy = false; }
}
window.addEventListener('DOMContentLoaded', () => {
  const style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);
  sync(); timer = setInterval(sync, 2500);
});
ipcRenderer.on('telegram:sync', sync);
window.addEventListener('beforeunload', () => { clearInterval(timer); db?.close(); });
