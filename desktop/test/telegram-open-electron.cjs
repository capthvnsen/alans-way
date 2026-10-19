require('./window-fixture.cjs');
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const http = require('node:http');
const { openUsernameScript } = require('../src/telegram-open.cjs');

// A fresh username has no cached dialog. Like current Web A, this fixture
// ignores username hashes, resolves through search, and renders Start only
// after the exact result is clicked. It has no network or live user data.
const fixture = `<!doctype html><div id="LeftColumn" style="display:none"><input id="telegram-search-input"><div id="results"></div></div><div id="MiddleColumn"></div>
<script>
window.startClicks = 0; window.otherClicks = 0; window.targetClicks = 0;
window.setup = async (mode) => {
  location.hash = '';
  document.querySelector('#MiddleColumn').innerHTML = ['stale-chat','wrong-header','delayed'].includes(mode) ? '<div class=MiddleHeader>Previous bot</div><div class=Composer></div>' : '';
  const db = await new Promise(resolve => { const r = indexedDB.open('tt-data', 1); r.onupgradeneeded = () => r.result.createObjectStore('store'); r.onsuccess = () => resolve(r.result); });
  const user = { id: '123', firstName: 'Fresh bot', type: mode === 'human' ? 'userTypeRegular' : 'userTypeBot', usernames: [{username:'fresh_bot', isActive:true}] };
  const slot = new URL(location.href).searchParams.get('account');
  const key = slot && slot !== '1' ? 'tt-global-state_' + slot : 'tt-global-state';
  const saveUser = async (byId) => {
    await new Promise(resolve => { const tx=db.transaction('store','readwrite'); tx.objectStore('store').put({users:{byId}},key); tx.oncomplete=resolve; });
  };
  await saveUser({});
  let firstFocus = true;
  const input = document.querySelector('input');
  input.addEventListener('focus', () => { if (firstFocus) { firstFocus=false; setTimeout(()=>{input.value='';},30); } });
  input.addEventListener('input', () => {
    const query = input.value;
    document.querySelector('#results').replaceChildren();
    if (query !== 'fresh_bot') return;
    // Search resolves the previously unknown user; persistence lags the result.
    setTimeout(async () => { await saveUser({'123':user}); db.close(); },150);
    setTimeout(() => {
      if (input.value !== query || mode === 'missing') return;
      for (const [handle,id] of [['fresh_bot_impostor','456'],['fresh_bot','123']]) {
        const row=document.createElement('div'); row.className='search-result';
        row.innerHTML='<div class="ListItem-button"><div data-peer-id="'+id+'"></div>'+(mode === 'composer' ? '' : '<span class="handle">'+handle+'</span>')+'</div>';
        row.firstElementChild.addEventListener('click', () => {
          if(id !== '123') { window.otherClicks++; return; }
          window.targetClicks++;
          location.hash=mode === 'wrong-chat' ? '999' : id;
          if(mode === 'stale-chat') return;
          if(mode === 'wrong-header') { document.querySelector('.MiddleHeader').innerHTML='<div data-peer-id="999"></div>Fresh bot'; return; }
          const render = () => {
            const mid=document.querySelector('#MiddleColumn');
            mid.innerHTML='<div class="MiddleHeader"><div data-peer-id="123"></div>Fresh bot</div>';
            if(mode === 'blank') return;
            if(mode === 'composer') mid.innerHTML+='<div class="Composer"></div>';
            else { const start=document.createElement('button'); start.className='Button primary fluid'; start.textContent='Start'; start.onclick=()=>window.startClicks++; mid.append(start); }
          };
          if(mode === 'delayed') window.renderTarget=render; else render();
        });
        document.querySelector('#results').append(row);
      }
    },30);
  });
};
</script>`;
let win, server;
app.whenReady().then(async () => {
  server = http.createServer((_req,res) => { res.setHeader('Content-Type','text/html'); res.end(fixture); });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  win = new BrowserWindow({ show:false, webPreferences:{ sandbox:true, backgroundThrottling:false } });
  const wc = win.webContents;
  const root = 'http://127.0.0.1:' + server.address().port;
  let passed = 0;
  for (const [mode, ok] of [['start',true],['composer',true],['missing',false],['human',false],['wrong-chat',false],['blank',false],['stale-chat',false],['wrong-header',false],['delayed',true]]) {
    await wc.loadURL(root + (mode === 'composer' ? '?account=2' : ''));
    await wc.executeJavaScript('window.setup(' + JSON.stringify(mode) + ')');
    const opening = wc.executeJavaScript(openUsernameScript('fresh_bot', mode === 'delayed' ? 5000 : 1000));
    if (mode === 'delayed') {
      // Hold rendering until the host observes the target click. Check the
      // acknowledgement while the old chat is still present, then release it.
      let ready = false;
      for (let i = 0; i < 60 && !ready; i++) {
        ready = await wc.executeJavaScript('typeof window.renderTarget === "function"');
        if (!ready) await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.equal(ready, true, 'target result must be clicked');
      const finishedEarly = await Promise.race([opening.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 150))]);
      assert.equal(finishedEarly, false, 'opening must wait while the previous chat is rendered');
      await wc.executeJavaScript('window.renderTarget()');
    }
    const result = await opening;
    assert.equal(result.ok, ok, mode + ': ' + JSON.stringify(result));
    const state = await wc.executeJavaScript('({startClicks,otherClicks,targetClicks,query:document.querySelector("input").value})');
    assert.equal(state.startClicks,0,'opening must never send /start');
    assert.equal(state.otherClicks,0,'prefix match must not open another account');
    assert.equal(state.query,'','search is cleared after success and failure');
    if (mode === 'human') assert.equal(state.targetClicks,0,'non-bots are refused before opening');
    if (ok) {
      assert.equal(result.bot.id,'123'); assert.equal(result.bot.isBot,true);
      assert.equal(await wc.executeJavaScript('document.querySelector(".MiddleHeader [data-peer-id]")?.dataset.peerId'), '123', 'target header must render before acknowledgement');
    }
    else assert.match(result.error,mode === 'human' ? /not a Telegram bot/ : /could not open/);
    passed++; console.log('PASS telegram-open ' + mode);
  }
  await wc.loadURL(root);
  await wc.executeJavaScript('document.querySelector("input").remove()');
  const missingInput = await wc.executeJavaScript(openUsernameScript('fresh_bot',1000));
  assert.equal(missingInput.ok,false);
  assert.match(missingInput.error,/search is unavailable/);
  console.log('PASS telegram-open missing search; ' + (passed+1) + ' passed');
  server.close(); win.destroy(); app.quit();
}).catch(error => { console.error(error); server?.close(); win?.destroy(); app.exit(1); });
