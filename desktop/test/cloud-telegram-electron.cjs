require('./window-fixture.cjs');
// Run: ./node_modules/.bin/electron test/cloud-telegram-electron.cjs
// Drives the BotFather script against a fake Telegram page: the composer is a
// contenteditable, Enter appends an outgoing message, and a canned responder
// posts the incoming reply after a beat. Covers the success path and the
// taken-then-success retry.
const { app, BrowserWindow, WebContentsView } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { botFatherScript, sendMessageScript, parseBotFatherReply, retryUsername } = require('../src/cloud-telegram.cjs');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-cloud-telegram-'));
app.setPath('userData', temp);
app.setName('Hermes cloud telegram test');
let win, server;

const TOKEN = '123456789:AAEbbCCddEEffGGhhIIjjKKllMMnnOOp';
const fixture = `<!doctype html><meta charset="utf-8">
<div id="LeftColumn" style="display:none"><input id="telegram-search-input"><div id="results"></div></div>
<div id="MiddleColumn"><div class="MiddleHeader">Pick a chat</div><div class="messages"></div>
<div class="Composer"><div id="editable-message-text" contenteditable="true"></div></div></div>
<script>
// Like Web A, username hashes do nothing. Only a resolved search result
// changes the rendered peer, and fresh bots show Start before the composer.
const users = {
  '1': { id:'1', type:'userTypeBot', username:'BotFather', firstName:'BotFather' },
  '2': { id:'2', type:'userTypeBot', username:'maya_alan_aaaa_bot', firstName:"Maya's Alan" },
};
window.ready = new Promise(resolve => {
  const r = indexedDB.open('tt-data',1);
  r.onupgradeneeded = () => r.result.createObjectStore('store');
  r.onsuccess = () => {
    const db = r.result, tx = db.transaction('store','readwrite');
    tx.objectStore('store').put({users:{byId:users}},'tt-global-state');
    tx.oncomplete = () => { db.close(); resolve(); };
  };
});
const composerHtml = '<div class="Composer"><div id="editable-message-text" contenteditable="true"></div></div>';
window.started = new Set(); window.startClicks = 0; window.blockOpen = false;
document.querySelector('input').addEventListener('input', event => {
  document.querySelector('#results').replaceChildren();
  const user = Object.values(users).find(user => user.username.toLowerCase() === event.target.value.toLowerCase());
  if (!user) return;
  const row = document.createElement('div'); row.className = 'search-result';
  row.innerHTML = '<div class="ListItem-button"><span data-peer-id="'+user.id+'"></span><span class="handle">'+user.username+'</span></div>';
  row.firstElementChild.onclick = () => {
    location.hash = user.id;
    if (window.blockOpen) return;
    document.querySelector('.MiddleHeader').innerHTML = '<div data-peer-id="'+user.id+'"></div>'+user.firstName;
    document.querySelector('.Composer')?.remove();
    document.querySelector('#MiddleColumn > button')?.remove();
    if (window.started.has(user.id)) document.querySelector('#MiddleColumn').insertAdjacentHTML('beforeend',composerHtml);
    else {
      const start = document.createElement('button'); start.className = 'Button primary fluid'; start.textContent = 'Start';
      start.onclick = () => { window.startClicks++; window.started.add(user.id); start.remove(); document.querySelector('#MiddleColumn').insertAdjacentHTML('beforeend',composerHtml); add('own','/start'); };
      document.querySelector('#MiddleColumn').append(start);
    }
  };
  document.querySelector('#results').append(row);
});
const add = (cls, text) => { const el = document.createElement('div'); el.className = 'Message' + (cls ? ' ' + cls : ''); el.textContent = text; document.querySelector('.messages').append(el); };
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  const el = event.target, text = el.textContent.trim(); el.textContent = '';
  add('own', text);
  setTimeout(() => {
    const script = window.FAKE_SCRIPT || {};
    if (text === '/newbot') add('', 'Alright, a new bot. How are we going to call it? Please choose a name for your bot.');
    else if (text === '/start') add('', 'Welcome!');
    else if (/^\\S+'s Alan$/.test(text)) add('', 'Good. Now let\\'s choose a username for your bot. It must end in \\'bot\\'.');
    else if (script.taken?.includes(text)) add('', 'Sorry, this username is already taken. Please try something different.');
    else if (script.split?.includes(text)) { add('', 'Done! Congratulations on your new bot. You will find it at t.me/' + text + '.'); setTimeout(() => add('', 'Use this token to access the HTTP API: ${TOKEN} Keep your token secure.'), 400); }
    else if (text.endsWith('_bot')) add('', 'Done! Congratulations on your new bot. You will find it at t.me/' + text + '. Use this token to access the HTTP API: ${TOKEN} Keep your token secure and store it safely.');
  }, 60);
});
window.__sent = [];
document.addEventListener('input', (e) => { if(e.target.id === 'editable-message-text') window.__sent.push(e.target.textContent); });
</script>`;

async function eventually(fn, predicate, tries = 60) {
  let result;
  for (let i = 0; i < tries; i++) { result = await fn(); if (predicate(result)) return result; await new Promise(r => setTimeout(r, 60)); }
  throw new Error(`Timed out; last value: ${JSON.stringify(result)}`);
}

app.whenReady().then(async () => {
  server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(fixture); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const root = `http://127.0.0.1:${server.address().port}`;
  win = new BrowserWindow({ show: false, width: 900, height: 640, webPreferences: { sandbox: true } });
  const view = new WebContentsView({ webPreferences: { sandbox: true, backgroundThrottling: false } });
  win.contentView.addChildView(view);
  const [width, height] = win.getContentSize();
  view.setBounds({ x: 0, y: 0, width, height });
  await view.webContents.loadURL(root);
  const wc = view.webContents;
  await wc.executeJavaScript('window.ready');

  // Success path: the generated username is accepted on the first try.
  const first = await wc.executeJavaScript(botFatherScript({ name: "Maya's Alan", username: 'maya_alan_aaaa_bot' }));
  assert.equal(first.ok, true, JSON.stringify(first));
  const parsed = parseBotFatherReply(first.reply);
  assert.deepEqual(parsed, { type: 'token', token: TOKEN });

  // Taken-then-success: attempt 1's username is rejected, attempt 2 lands.
  const taken = 'maya_alan_zzzz_1_bot';
  await wc.executeJavaScript(`window.FAKE_SCRIPT = { taken: [${JSON.stringify(taken)}] }`);
  const second = await wc.executeJavaScript(botFatherScript({ name: "Maya's Alan", username: retryUsername('Maya', 1, () => 0.999) }));
  // retryUsername('Maya', 1, () => 0.999) is maya_alan_9999_1_bot — not taken.
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(parseBotFatherReply(second.reply).type, 'token');
  // Now force the taken reply itself: run with the taken username.
  const reject = await wc.executeJavaScript(botFatherScript({ name: "Maya's Alan", username: taken }));
  assert.equal(reject.ok, true, JSON.stringify(reject));
  assert.equal(parseBotFatherReply(reject.reply).type, 'taken');

  // A reply split across two bubbles still yields the token: the reader waits
  // for the message count to settle rather than grabbing the first bubble.
  const split = 'maya_alan_split_2_bot';
  await wc.executeJavaScript(`window.FAKE_SCRIPT = { split: [${JSON.stringify(split)}] }`);
  const splitRun = await wc.executeJavaScript(botFatherScript({ name: "Maya's Alan", username: split }));
  assert.equal(splitRun.ok, true, JSON.stringify(splitRun));
  assert.deepEqual(parseBotFatherReply(splitRun.reply), { type: 'token', token: TOKEN });

  // /start lands in the new bot's chat.
  await wc.executeJavaScript(`window.FAKE_SCRIPT = {}`);
  const started = await wc.executeJavaScript(sendMessageScript('maya_alan_aaaa_bot', '/start'));
  assert.equal(started.ok, true, JSON.stringify(started));
  await eventually(() => wc.executeJavaScript(`[...document.querySelectorAll('.Message.own')].map(m => m.textContent)`), (msgs) => msgs.includes('/start'));

  assert.equal(await wc.executeJavaScript('window.startClicks'), 2, 'each new bot is started exactly once');
  assert.equal(await wc.executeJavaScript("document.querySelector('.MiddleHeader [data-peer-id]').dataset.peerId"), '2');
  assert.equal(await wc.executeJavaScript("[...document.querySelectorAll('.Message.own')].filter(m => m.textContent === '/start').length"), 2, 'Start must not be sent twice');
  console.log('PASS cloud-telegram native resolution, BotFather retry/split replies, fresh bot Start');

  await wc.executeJavaScript("window.blockOpen=true; document.querySelector('.MiddleHeader').innerHTML='<div data-peer-id=999></div>Previous bot'; window.__sent=[]");
  const failed = await wc.executeJavaScript(sendMessageScript('maya_alan_aaaa_bot', '/start'));
  assert.equal(failed.ok, false, 'stale chat must not receive /start');
  const failedMint = await wc.executeJavaScript(botFatherScript({ name: "Maya's Alan", username: 'maya_alan_aaaa_bot' }));
  assert.equal(failedMint.ok, false, 'stale chat must not receive BotFather commands');
  assert.equal(await wc.executeJavaScript('window.__sent.length'), 0);
  console.log('PASS cloud-telegram stale chat refuses /start and /newbot');

  server.close();
  view.webContents.close(); win.destroy();
  fs.rmSync(temp, { recursive:true, force:true });
  app.exit(0);
}).catch((error) => {
  console.error(error); server?.closeAllConnections(); server?.close(); win?.destroy();
  fs.rmSync(temp, { recursive:true, force:true });
  app.exit(1);
});
