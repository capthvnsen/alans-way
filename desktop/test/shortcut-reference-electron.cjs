// Real source app with an isolated profile, intercepted Telegram and loopback pages.
// SHORTCUT_PHASE=red node test/run-electron.cjs test/shortcut-reference-electron.cjs
// SHORTCUT_NATIVE=1 additionally drives macOS menu accelerators through Orca.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const { app, BrowserWindow, Menu, dialog, webContents, session } = require('electron');
const { prepareFixture, quitFixture } = require('./electron-fixture.cjs');
const profile = process.env.HERMES_TEST_PROFILE;
assert.ok(profile, 'Run with test/run-electron.cjs for disposable storage.');
prepareFixture(profile);
process.env.HERMES_WORKSPACE_ALLOW_LOOPBACK = '1';
fs.writeFileSync(path.join(profile, 'preferences.json'), JSON.stringify({ onboarded: true, preview: false,
  macSshHost: 'fixture@local.invalid', bots: Array.from({ length: 24 }, (_, i) => ({ id: String(101 + i), name: `Agent ${String(i + 1).padStart(2, '0')}`, isBot: true })),
  selectedBotId: '101', botSort: 'alpha' }));
require('../src/main.cjs');
const evidence = path.resolve(process.env.SHORTCUT_EVIDENCE_DIR || path.join(__dirname, '../../evidence/quality/shortcut-reference'));
fs.mkdirSync(evidence, { recursive: true });
  const phase = process.env.SHORTCUT_PHASE || 'green';
const results = [], native = [], trust = [];
const pause = (ms = 45) => new Promise(r => setTimeout(r, ms));
const wait = async (read, predicate = Boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = await read(); if (predicate(value)) return value; await pause(); }
  throw new Error('Timed out waiting for shortcut fixture state.');
};
let server, wc, win;
app.whenReady().then(async () => {
  win = await wait(() => BrowserWindow.getAllWindows()[0]); wc = win.webContents;
  const js = code => wc.executeJavaScript(code);
  await wait(() => js('!!document.querySelector(".bot-open")').catch(() => false));
  win.setSize(1440, 900); win.show(); app.focus({ steal: true }); win.focus(); wc.focus();
  wc.debugger.attach('1.3');
  const frame = () => js('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
  const focus = selector => js(`document.querySelector(${JSON.stringify(selector)}).focus()`);
  const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const active = () => js('document.activeElement.id || document.activeElement.className');
  const visible = id => js(`!document.getElementById(${JSON.stringify(id)}).classList.contains('hidden')`);
  const invoke = (name, value = {}) => js(`window.workspace.command(${JSON.stringify(name)}, ${JSON.stringify(value)})`);
  const state = () => js('window.workspace.getState()');
  const shot = async name => { await frame(); fs.writeFileSync(path.join(evidence, `${phase}-${name}.png`), (await wc.capturePage()).toPNG()); };
  const check = async (name, test) => {
    try { await test(); results.push({ name, pass: true }); console.log(`PASS: ${name}`); }
    catch (error) { results.push({ name, pass: false, error: error.message }); console.error(`FAIL: ${name}: ${error.message}`); await shot(`failure-${results.length}`); }
  };
  const menuItem = id => Menu.getApplicationMenu().getMenuItemById(id);
  const key = async (key, shift = false) => {
    const vk = { Tab: 9, Enter: 13, Escape: 27, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46, ' ': 32 }[key];
    const params = { key, code: key, windowsVirtualKeyCode: vk, modifiers: shift ? 8 : 0 };
    await wc.debugger.sendCommand('Input.dispatchKeyEvent', { ...params, type: 'keyDown', ...(key === 'Enter' ? { text: '\r' } : key === ' ' ? { text: ' ' } : {}) });
    await wc.debugger.sendCommand('Input.dispatchKeyEvent', { ...params, type: 'keyUp' }); await pause();
  };
  await js(`window.shortcutKeyLog = []; document.addEventListener('keydown', e => window.shortcutKeyLog.push({key:e.key,trusted:e.isTrusted}),true)`);

  // This first regression fails against the original menu, before any UI behavior changes.
  await check('native app menu exposes Settings with the standard accelerator', async () => {
    const item = menuItem('workspace-settings'); assert.ok(item, 'Settings… is missing from the app menu');
    assert.equal(item.label, 'Settings…'); assert.equal(item.accelerator, 'CmdOrCtrl+,');
    item.click(); await frame(); assert.equal(await js('document.getElementById("modal-title").textContent'), 'Workspace settings');
  });
  if (phase === 'red') return;
  assert.equal(results[0].pass, true, 'The native Settings regression must pass before proceeding.');
  await check('settings and persistent workspace Help both expose the reference', async () => {
    assert.equal(await js('document.getElementById("settings-shortcuts").textContent'), 'Keyboard shortcuts');
    await focus('#settings-shortcuts'); await key('Enter'); await frame();
    assert.equal(await visible('shortcut-dialog'), true); assert.equal(await active(), 'shortcut-search');
    assert.equal(await js('document.getElementById("modal").inert'), true);
    await shot('settings-entry'); await key('Escape'); await frame();
    assert.equal(await active(), 'settings-shortcuts'); assert.equal(await visible('modal'), true);
    await key('Escape'); await frame();
    await focus('#shortcuts-button'); await key('Enter'); await frame(); assert.equal(await active(), 'shortcut-search');
  });
  await check('search matches descriptions and key names and announces no results', async () => {
    await wc.insertText('first'); await frame();
    assert.match(await js('document.getElementById("shortcut-results").textContent'), /Home/);
    await js('document.getElementById("shortcut-search").value=""'); await wc.insertText('command comma'); await frame();
    assert.match(await js('document.getElementById("shortcut-results").textContent'), /Settings/);
    await js('document.getElementById("shortcut-search").value=""'); await wc.insertText('zz-no-such-command'); await frame();
    assert.equal(await js('document.querySelectorAll(".shortcut-row").length'), 0);
    assert.match(await js('document.getElementById("shortcut-status").textContent'), /No shortcuts found/);
    await shot('no-results'); await key('Tab'); assert.equal(await active(), 'shortcut-clear'); await key('Enter');
    assert.equal(await active(), 'shortcut-search'); assert.ok(await js('document.querySelectorAll(".shortcut-row").length') > 10);
  });
  await check('global and region groups are distinct and unavailable commands explain context', async () => {
    assert.deepEqual(await js('[...document.querySelectorAll(".shortcut-section h3")].map(n=>n.textContent)'), ['App shortcuts', 'Browser & Telegram', 'Agent list', 'Browser tab strip', 'Search & dialogs']);
    assert.match(await js('document.querySelector("[data-shortcut=close-tab]").textContent'), /No local tab open/);
    assert.match(await js('document.querySelector("[data-shortcut=agent-move]").textContent'), /focus|Focus/);
    assert.equal(await js('document.querySelector("[data-shortcut=settings] kbd").textContent'), process.platform === 'darwin' ? '⌘' : 'Ctrl');
    await shot('reference');
    await focus('#shortcut-search'); await wc.insertText('agent'); await shot('agent-reference');
    await js('document.getElementById("shortcut-search").value="";document.getElementById("shortcut-search").dispatchEvent(new Event("input"))');
  });
  await check('reference contains Tab, Shift Tab and programmatic background focus', async () => {
    await focus('#shortcut-close'); await key('Tab'); assert.equal(await active(), 'shortcut-search');
    await key('Tab', true); assert.equal(await active(), 'shortcut-close');
    await focus('#new-tab'); assert.equal(await js('document.getElementById("shortcut-dialog").contains(document.activeElement)'), true);
    await key('Escape'); await frame(); assert.equal(await active(), 'shortcuts-button');
  });
  await check('repeated Help opens preserve one dialog and its search draft', async () => {
    menuItem('workspace-shortcuts').click(); await frame(); await wc.insertText('agent');
    for (let i=0;i<4;i++) menuItem('workspace-shortcuts').click(); await frame();
    assert.equal(await js('document.getElementById("shortcut-search").value'), 'agent');
    assert.equal(await js('document.querySelectorAll("#shortcut-dialog:not(.hidden)").length'), 1);
    menuItem('workspace-settings').click(); await frame(); assert.equal(await visible('modal'), false);
    await key('Escape'); await frame();
  });
  await check('Settings does not replace an existing Add bot dialog', async () => {
    await focus('#add-bot'); await key('Enter'); await frame(); await wc.insertText('draft_bot');
    menuItem('workspace-settings').click(); await frame();
    assert.equal(await js('document.getElementById("bot-username").value'), 'draft_bot');
    menuItem('workspace-shortcuts').click(); await frame(); await key('Escape'); await frame();
    assert.equal(await active(), 'bot-username'); await key('Escape'); await frame(); assert.equal(await active(), 'add-bot');
  });
  await check('small viewport keeps search, close, keys and results reachable', async () => {
    win.setMinimumSize(0,0); win.setSize(760, 520); menuItem('workspace-shortcuts').click(); await frame();
    const geometry = await js(`(() => { const card=document.querySelector('.shortcut-card'), r=card.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight,overflow:card.scrollWidth>card.clientWidth};})()`);
    assert.ok(geometry.left>=0 && geometry.top>=0 && geometry.right<=geometry.width && geometry.bottom<=geometry.height); assert.equal(geometry.overflow,false);
    await js('document.getElementById("shortcut-results").scrollTop=10000'); await frame();
    assert.equal(await js('document.querySelector("[data-shortcut=dialog-close]").getBoundingClientRect().bottom<=document.getElementById("shortcut-results").getBoundingClientRect().bottom'),true);
    await js('document.getElementById("shortcut-results").scrollTop=0');
    await shot('small'); await key('Escape'); win.setSize(1440,900); await frame();
  });
  await check('reduced motion retains the same usable reference', async () => {
    await wc.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name:'prefers-reduced-motion', value:'reduce' }] });
    menuItem('workspace-shortcuts').click(); await frame();
    assert.equal(await js('matchMedia("(prefers-reduced-motion:reduce)").matches'),true);
    assert.equal(await js('getComputedStyle(document.querySelector(".shortcut-card")).animationName'),'none');
    await shot('reduced-motion'); await key('Escape'); await wc.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });
  });

  await check('advertised agent arrows, endpoints, activation and Hide tab stop work only in the list', async () => {
    await focus('.bot-open'); await key('ArrowDown'); assert.equal(await js('document.activeElement.closest(".bot-row").dataset.botId'),'102');
    assert.equal((await state()).selectedBotId,'101'); await key('End'); assert.equal(await js('document.activeElement.closest(".bot-row").dataset.botId'),'124');
    await key('Home'); await key('Enter'); await key('ArrowDown'); await key(' '); await wait(state,s=>s.selectedBotId==='102');
    await key('Tab'); assert.equal(await active(),'bot-hide'); await key('Tab',true); assert.equal(await active(),'bot-open');
  });
  await check('advertised tab arrows, endpoints and Delete operate on focused tabs', async () => {
    const a=await invoke('create-tab'),b=await invoke('create-tab'); await frame(); wc.focus();
    await focus('#tabs [aria-selected=true]'); await key('ArrowLeft'); await wait(state,s=>s.browserTabId===a.id);
    await key('End'); await wait(state,s=>s.browserTabId===b.id); await key('Home'); await wait(state,s=>s.browserTabId===a.id);
    await key('Delete'); await wait(state,s=>!s.tabs.some(t=>t.id===a.id));
    await key('Delete'); await wait(state,s=>!s.tabs.some(t=>t.id===b.id));
  });
  await check('advertised agent search Down and two-stage Escape work in the search field', async () => {
    await focus('#search-toggle'); await key('Enter'); await wc.insertText('Agent 01'); await key('ArrowDown'); assert.equal(await active(),'bot-open');
    await focus('#bot-search'); await key('Escape'); assert.equal(await js('document.getElementById("bot-search").value'),'');
    assert.equal(await active(),'bot-search'); await key('Escape'); assert.equal(await active(),'search-toggle');
  });

  server=http.createServer((_req,res)=>res.end('<!doctype html><title>Shortcut fixture</title><input id="edit" value="alpha beta"><p>Local test page</p>'));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const url=`http://127.0.0.1:${server.address().port}/`;
  const tab=await invoke('create-tab',{url});
  const page=await wait(()=>webContents.getAllWebContents().find(c=>c.getURL()===url));
  await wait(()=>page.executeJavaScript('!!document.getElementById("edit")').catch(()=>false));
  const modifier=process.platform==='darwin'?'meta':'control';
  const input = async (target,key,modifiers=[]) => {
    target.sendInputEvent({type:'keyDown',keyCode:key,modifiers}); target.sendInputEvent({type:'keyUp',keyCode:key,modifiers}); await pause();
  };
  await check('trusted Chromium page editing and region keys leave workspace state unchanged', async () => {
    page.debugger.attach('1.3'); await page.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
    // A CDP editing selector must reach Chromium; native menu dispatch requires
    // OS focus and is checked separately, rather than claimed by this probe.
    page.setIgnoreMenuShortcuts(true);
    await page.executeJavaScript('edit.focus();edit.setSelectionRange(5,5)');
    await page.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:process.platform==='darwin'?4:2,...(process.platform==='darwin'?{commands:['selectAll']}:{})});
    await page.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:process.platform==='darwin'?4:2});
    assert.deepEqual(await wait(()=>page.executeJavaScript('[edit.selectionStart,edit.selectionEnd]'),v=>v[0]===0&&v[1]===10),[0,10]);
    for(const [key,vk] of [['Home',36],['End',35],['Delete',46],['ArrowLeft',37],['ArrowDown',40]]) {
      await page.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key,code:key,windowsVirtualKeyCode:vk});
      await page.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',key,code:key,windowsVirtualKeyCode:vk});
    }
    assert.equal((await state()).activeTabId,tab.id); assert.equal((await state()).selectedBotId,'102');
    await page.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:false});
    page.setIgnoreMenuShortcuts(false);
  });
  await check('Electron browser address input route reaches the workspace field', async () => {
    wc.focus(); await focus('#new-tab'); await input(page,'L',[modifier]); await frame(); assert.equal(await active(),'address');
  });
  await check('actual menu callbacks create, reload, close local tabs and invoke the PDF picker', async () => {
    const items=Menu.getApplicationMenu().items.flatMap(i=>i.submenu?.items||[]), find=label=>items.find(i=>i.label===label);
    const before=(await state()).tabs.length; find('New Browser Tab').click(); await wait(state,s=>s.tabs.length===before+1);
    const created=(await state()).activeTabId, fresh=await wait(()=>webContents.getAllWebContents().find(c=>c.getURL().endsWith('/newtab.html')));
    await fresh.loadURL(url+'menu-reload'); let loaded=0; const onLoad=()=>loaded++;fresh.on('did-finish-load',onLoad);
    find('Reload Page').click();await wait(()=>loaded>0);fresh.removeListener('did-finish-load',onLoad);
    find('Close Tab').click();await wait(state,s=>!s.tabs.some(t=>t.id===created));
    let picked=0;const original=dialog.showOpenDialog;dialog.showOpenDialog=async()=>{picked++;return {canceled:true,filePaths:[]};};
    try{find('Open File…').click();await wait(()=>picked===1);}finally{dialog.showOpenDialog=original;}
  });
  if(process.env.SHORTCUT_NATIVE) await check('native browser focus moves into reference and returns on Escape', async () => {
    win.show(); app.focus({steal:true}); win.focus(); page.focus(); await pause();
    if(process.env.SHORTCUT_NATIVE){
      try{const response=await execFile('orca',['computer','get-app-state','--app',`pid:${process.pid}`,'--restore-window','--no-screenshot','--json'],{maxBuffer:1024*1024});native.push({phase:'orca-restore',receipt:JSON.parse(response.stdout)});}
      catch(error){native.push({phase:'orca-restore',error:error.message,stdout:error.stdout});}
      await pause(150);page.focus();
    }
    const sample={window:win.isFocused(),contents:webContents.getFocusedWebContents()?.id||null,page:page.id,shell:wc.id}; native.push({phase:'before-reference',...sample});
    assert.equal(sample.window,true,'native key-window precondition'); assert.equal(sample.contents,page.id,'native child focus precondition');
    menuItem('workspace-shortcuts').click(); await frame(); await wait(()=>webContents.getFocusedWebContents()?.id===wc.id);
    await key('Escape'); await frame(); await wait(()=>webContents.getFocusedWebContents()?.id===page.id);
    native.push({phase:'after-reference',window:win.isFocused(),contents:webContents.getFocusedWebContents()?.id||null});
  });
  if (process.env.SHORTCUT_NATIVE) {
    await check('real macOS accelerators invoke Settings, new tab, reload, close tab and Open File', async () => {
      assert.equal(process.platform,'darwin'); win.show(); app.focus({steal:true}); win.focus(); wc.focus();
      const chord=async key => {
        let response;
        try{response=await execFile('orca',['computer','hotkey','--app',`pid:${process.pid}`,'--key',key,'--no-screenshot','--json'],{maxBuffer:1024*1024});}
        catch(error){native.push({key,error:error.message,stdout:error.stdout});throw error;}
        const receipt=JSON.parse(response.stdout); assert.equal(receipt.ok,true); native.push({key,receipt}); await pause(100);
      };
      await chord('CmdOrCtrl+,'); await wait(()=>visible('modal')); assert.equal(await js('document.getElementById("modal-title").textContent'),'Workspace settings');
      await key('Escape'); wc.focus(); const before=(await state()).tabs.length;
      await chord('CmdOrCtrl+T'); await wait(state,s=>s.tabs.length===before+1);
      const created=(await state()).activeTabId, fresh=webContents.getAllWebContents().find(c=>c.getURL().endsWith('/newtab.html'));
      assert.ok(fresh); await fresh.loadURL(url+'reload'); fresh.focus(); let reloads=0; const onLoad=()=>reloads++; fresh.on('did-finish-load',onLoad);
      await chord('CmdOrCtrl+R'); await wait(()=>reloads>0); fresh.removeListener('did-finish-load',onLoad);
      await chord('CmdOrCtrl+W'); await wait(state,s=>!s.tabs.some(t=>t.id===created));
      const original=dialog.showOpenDialog;let opened=0; dialog.showOpenDialog=async()=>{opened++;return {canceled:true,filePaths:[]};};
      try {wc.focus();await chord('CmdOrCtrl+O');await wait(()=>opened===1);}finally{dialog.showOpenDialog=original;}
    });
  }
  await check('agent-dispatched settings and browser keys cannot invoke workspace commands or take focus', async () => {
    const connection=JSON.parse(fs.readFileSync(path.join(profile,'connection.json'),'utf8'));
    const api=async (route,body) => {const response=await fetch(new URL(route,connection.url),{method:'POST',headers:{Authorization:`Bearer ${connection.token}`,'X-Hermes-Bot':'shortcut-fixture','Content-Type':'application/json'},body:JSON.stringify(body)});const data=await response.json();assert.ok(response.ok,data.error);return data;};
    const agent=await api('/v1/tabs',{url:url+'agent'});
    wc.focus(); await focus('#home-address').catch(()=>{}); const before=await state(), focused=webContents.getFocusedWebContents()?.id||null;
    for(const k of [',','t','w','l','r','o']) await api(`/v1/tabs/${agent.id}/actions`,{action:'press',key:k,modifiers:[modifier],epoch:agent.epoch});
    const after=await state();assert.equal(after.activeTabId,before.activeTabId);assert.equal(after.tabs.length,before.tabs.length);
    assert.equal(await visible('modal'),false);assert.equal(await visible('shortcut-dialog'),false);assert.equal(webContents.getFocusedWebContents()?.id||null,focused);
  });
  trust.push(...await js('window.shortcutKeyLog')); assert.ok(trust.length>20);assert.ok(trust.every(k=>k.trusted),'Every renderer keyboard event is trusted Chromium input');
}).catch(error=>{results.push({name:'fixture',pass:false,error:error.stack});console.error(error.stack);}).finally(()=>{
  const failures=results.filter(r=>!r.pass);fs.writeFileSync(path.join(evidence,`${phase}-results.json`),JSON.stringify({results,pass:results.length-failures.length,fail:failures.length,native,trust},null,2));
  if(failures.length)process.exitCode=1;app.once('will-quit',()=>app.exit(failures.length?1:0));quitFixture(server);
});
