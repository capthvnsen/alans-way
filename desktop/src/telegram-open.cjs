'use strict';

// Web A captures tgaddr at startup, not as an in-page username router. Use
// its native search to resolve accounts absent from the local chat list.
// This function is serialized into the Telegram page; keep it self-contained.
async function resolveUsername(username, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const pause = () => new Promise(resolve => setTimeout(resolve, 100));
  const matches = user => (user?.usernames || []).some(item => item.isActive && item.username?.toLowerCase() === username.toLowerCase()) ||
    user?.username?.toLowerCase() === username.toLowerCase();
  const isBot = user => user?.isBot === true || user?.type === 'userTypeBot' || user?.type === 'bot';
  const setQuery = value => {
    const input = document.querySelector('#telegram-search-input');
    if (!input) throw Error('Telegram search is unavailable. Sign in or sync Telegram and try again.');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return input;
  };
  const readUser = () => new Promise(resolve => {
    let db, settled = false;
    const finish = value => { if (settled) return; settled = true; clearTimeout(timer); db?.close(); resolve(value); };
    const timer = setTimeout(() => finish(null), 1000);
    const request = indexedDB.open('tt-data');
    request.onupgradeneeded = () => { request.transaction.abort(); finish(null); };
    request.onerror = () => finish(null);
    request.onblocked = () => finish(null);
    request.onsuccess = () => {
      db = request.result;
      if (settled) { db.close(); return; }
      if (!db.objectStoreNames.contains('store')) return finish(null);
      const slot = new URL(location.href).searchParams.get('account');
      const key = slot && slot !== '1' ? `tt-global-state_${slot}` : 'tt-global-state';
      const get = db.transaction('store', 'readonly').objectStore('store').get(key);
      get.onerror = () => finish(null);
      get.onsuccess = () => finish(Object.values(get.result?.users?.byId || {}).find(matches) || null);
    };
  });
  try {
    // Focus can reset the query on the next render, even while the native
    // column is hidden. Let that transition settle before entering the name.
    const input = setQuery('');
    input.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 350));
    setQuery(username);
    let bot;
    while (Date.now() < deadline) {
      const user = await readUser();
      const id = String(user?.id || '');
      // Local search results omit the username. Match their peer ID against
      // the verified cache entry, never their display name or result order.
      const row = /^\d{1,20}$/.test(id) && [...document.querySelectorAll('#LeftColumn .search-result')].find(el => {
        const handle = el.querySelector('.handle')?.textContent.trim().replace(/^@/, '').toLowerCase();
        return el.querySelector('[data-peer-id]')?.getAttribute('data-peer-id') === id && (!handle || handle === username.toLowerCase());
      });
      if (row) {
        if (!isBot(user)) throw Error(`@${username} is not a Telegram bot.`);
        bot = { id, isBot: true, username, name: [user.firstName, user.lastName].filter(Boolean).join(' ') || username };
        const button = row.querySelector('.ListItem-button');
        if (!button) break;
        button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
        button.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
        button.click();
        break;
      }
      await pause();
    }
    while (bot && Date.now() < deadline) {
      const correctChat = location.hash.slice(1).split('_')[0] === bot.id;
      const header = document.querySelector('#MiddleColumn .MiddleHeader');
      // A new bot has a primary footer action (Start) in place of a Composer.
      // Do not click it: opening a chat must leave first contact to the user.
      const control = document.querySelector('#MiddleColumn .Composer, #MiddleColumn button.Button.primary.fluid:not(:disabled)');
      if (correctChat && header && control) return { ok: true, bot };
      await pause();
    }
    throw Error(`Telegram could not open @${username}. Check the username and connection, then try again.`);
  } catch (error) {
    return { ok: false, error: error.message };
  } finally {
    try { setQuery(''); } catch {}
  }
}

function openUsernameScript(username, timeoutMs = 15000) {
  return `(${resolveUsername.toString()})(${JSON.stringify(username)}, ${JSON.stringify(timeoutMs)})`;
}

module.exports = { openUsernameScript };
