const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Run the actual preload sync against a read-only IndexedDB/DOM fixture.
function fixture() {
  let cached;
  const packets = [];
  const database = {
    objectStoreNames: { contains: () => true },
    transaction: () => ({ objectStore: () => ({ get: () => {
      const request = {};
      queueMicrotask(() => { request.result = cached; request.onsuccess(); });
      return request;
    } }) }),
  };
  const context = vm.createContext({
    require: (name) => name === 'electron'
      ? { ipcRenderer: { on() {}, send: (name, data) => packets.push({ name, data }) }, contextBridge: { executeInMainWorld() {} } }
      : require(path.join(__dirname, '../src', name)),
    location: { origin: 'https://web.telegram.org', pathname: '/a/', href: 'https://web.telegram.org/a/', hash: '' },
    window: { addEventListener() {} }, navigator: { onLine: true }, URL,
    document: { querySelector: () => null, querySelectorAll: () => [], getElementById: (id) => id === 'LeftColumn' ? {} : null,
      body: { classList: { toggle() {} } } },
    indexedDB: { open: () => {
      const request = {};
      queueMicrotask(() => { request.result = database; request.onsuccess(); });
      return request;
    } },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/telegram-preload.cjs'), 'utf8'), context);
  return {
    async sync(accountId, lastId, url) {
      cached = { currentUserId: accountId, users: { byId: { '200': { id: '200', isBot: true, firstName: 'Bot' } } },
        chats: { byId: { '200': { lastMessageId: lastId } } },
        messages: { byChatId: { '200': { byId: { [lastId]: { content: { text: { text: url } } } } } } } };
      await context.sync();
    },
    links: () => packets.filter((packet) => packet.name === 'telegram:link').map((packet) => packet.data.url),
  };
}

for (const historyId of [1, 200]) {
  test(`switching Telegram accounts seeds its own link history (message ${historyId})`, async () => {
    const app = fixture();
    await app.sync('100', 100, 'https://old-history.example');
    await app.sync('100', 101, 'https://first-account.example');
    assert.deepEqual(app.links(), ['https://first-account.example']);
    await app.sync('101', historyId, 'https://second-history.example');
    assert.deepEqual(app.links(), ['https://first-account.example'], 'existing history must stay closed on an account switch');
    await app.sync('101', historyId + 1, 'https://second-account.example');
    assert.deepEqual(app.links(), ['https://first-account.example', 'https://second-account.example']);
  });
}
