'use strict';
const { fitWindow, resizeWindow } = require('./window-fixture.cjs');
// Builder fixture boundary adapted from settings-switches-critic/runtime-harness.cjs.
// Actual frozen main/preload/renderer; own regressions and disposable profile.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const electron = require('electron');
const { app, ipcMain, BrowserWindow, webContents, session } = electron;
const OUT = path.resolve(process.env.SETTINGS_RECOVERY_OUT);
fs.mkdirSync(OUT, {recursive:true});
const mode = process.env.SETTINGS_RECOVERY_PHASE || 'red';
const TARGET = path.resolve(process.env.SETTINGS_RECOVERY_TARGET);
const PROFILE = path.join(OUT, 'profile');
const journal = { mode, target: TARGET, startedAt: new Date().toISOString(), checks: [], commands: [], blocked: [], captures: [], errors: [] };
const save = () => fs.writeFileSync(path.join(OUT, `runtime-${mode}.json`), JSON.stringify(journal, null, 2) + '\n');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = (name, pass, details) => { journal.checks.push({ name, pass: !!pass, details }); save(); console.log(JSON.stringify({ name, pass: !!pass })); };
const block = (kind, target) => { journal.blocked.push({ kind, target: String(target || '').slice(0, 200) }); return Error(`Critic fixture blocked ${kind}`); };
for (const name of ['userData', 'appData', 'sessionData', 'cache', 'temp', 'home', 'downloads', 'documents', 'desktop', 'logs', 'crashDumps']) {
  const dir = name === 'userData' ? PROFILE : path.join(OUT, 'fixture-paths', name);
  fs.mkdirSync(dir, { recursive: true });
  try { app.setPath(name, dir); } catch (e) { journal.errors.push(`setPath ${name}: ${e.message}`); }
}
process.env.HERMES_WORKSPACE_DATA = PROFILE;
process.env.HERMES_WORKSPACE_PORT = '0';
// Loading a .cjs entry directly otherwise reports the Electron runtime version.
app.getVersion = () => JSON.parse(fs.readFileSync(path.join(TARGET, 'package.json'), 'utf8')).version;
fs.writeFileSync(path.join(PROFILE, 'preferences.json'), JSON.stringify({
  onboarded: true, macSshHost: '', remoteUrl: '', vpsBrowser: { sshHost: '', scriptPath: '', sudo: false },
  bots: [{id:'81001',name:'Cedar',username:'cedar_fixture_bot'},{id:'81002',name:'Maple',username:'maple_fixture_bot'}], order: [], hidden: [], selectedBotId: '81001', accountId: '', savedTabs: [],
  autoOpenLinks: false, autoTakeover: true, preview: true, showBots: true, showBrowser: true,
  browserExtensions: [], cloud: {}, versionCache: {}, lastVersion: app.getVersion()
}));
app.setAsDefaultProtocolClient = () => { journal.blocked.push({ kind: 'protocol registration' }); return false; };
app.relaunch = () => { throw block('relaunch'); };
app.focus = () => { journal.blocked.push({kind:'app focus suppressed'}); };
require('node:os').tmpdir = () => path.join(OUT, 'fixture-paths/temp');
for (const api of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  require('node:child_process')[api] = (...args) => { throw block(`child_process.${api}`, args[0]); };
}
for (const mod of ['node:http', 'node:https']) for (const name of ['request', 'get']) {
  require(mod)[name] = (...args) => { throw block(`${mod}.${name}`, args[0]?.href || args[0]); };
}
for (const mod of ['node:net', 'node:tls']) for (const name of ['connect', 'createConnection']) {
  if (require(mod)[name]) require(mod)[name] = (...args) => { throw block(`${mod}.${name}`, args[0]); };
}
global.fetch = async (...args) => { throw block('fetch', args[0]); };
for (const name of ['fetch', 'request']) electron.net[name] = (...args) => { throw block(`electron.net.${name}`, args[0]); };
const securedSessions = new WeakSet();
function secure(s) {
  if (securedSessions.has(s)) return s;
  securedSessions.add(s);
  const original = s.webRequest.onBeforeRequest.bind(s.webRequest);
  s.webRequest.onBeforeRequest = (...args) => {
    const listener = args.at(-1);
    original((details, callback) => {
      if (/^(https?|wss?|ftp):/i.test(details.url)) { journal.blocked.push({ kind: 'renderer network', target: details.url }); callback({ cancel: true }); }
      else if (typeof listener === 'function') listener(details, callback);
      else callback({});
    });
  };
  s.webRequest.onBeforeRequest(null);
  const deny = s.setPermissionRequestHandler.bind(s);
  s.setPermissionRequestHandler = () => deny((_wc, _permission, callback) => callback(false));
  s.setPermissionRequestHandler(null);
  s.setPermissionCheckHandler(() => false);
  return s;
}
const partition = session.fromPartition.bind(session);
session.fromPartition = (...args) => secure(partition(...args));
app.on('web-contents-created', (_event, wc) => {
  wc.focus = () => { journal.blocked.push({kind:'webContents focus suppressed',target:wc.id}); };
  wc.on('console-message', details => { if(details.level==='error'||details.level===3)console.log('RENDERER',details.message); });
  wc.on('did-fail-load', (_e, code, description, url) => console.log('LOAD_FAILED', wc.id, code, description, url));
  wc.on('did-finish-load', () => console.log('LOADED', wc.id, wc.getURL()));
  wc.on('render-process-gone', (_e, details) => console.log('RENDERER_GONE', wc.id, details));
  const original = wc.loadURL.bind(wc);
  wc.loadURL = (url, ...args) => {
    if (/^https:\/\/web\.telegram\.org\//.test(url)) {
      journal.blocked.push({kind:'Telegram external load replaced with inert local document',target:url});
      return original('data:text/html,'+encodeURIComponent('<!doctype html><title>Inert fixture Telegram boundary</title><body>No service loaded.</body>'));
    }
    return /^(file:|about:|data:)/.test(url) ? original(url, ...args) : Promise.reject(block('loadURL', url));
  };
});
app.whenReady().then(() => secure(session.defaultSession));
class InertTray extends EventEmitter { setToolTip() {} setContextMenu() {} setImage() {} destroy() {} }
function FixtureWindow(options) {
  const window = new BrowserWindow({ ...options, show: false, focusable: false, paintWhenInitiallyHidden: true,
    webPreferences: { ...options.webPreferences, backgroundThrottling: false } });
  window.setMinimumSize(1, 1);
  fitWindow(window, 1280, 900);
  window.focus = () => { journal.blocked.push({kind:'window focus suppressed'}); };
  window.show = () => window.showInactive();
  window.showInactive();
  return window;
}
Object.setPrototypeOf(FixtureWindow, BrowserWindow);
FixtureWindow.prototype = BrowserWindow.prototype;
const fakeHost = { service: new Proxy({ close() {} }, { get: (obj, name) => obj[name] || (async () => { throw block(`host computer ${String(name)}`); }) }) };
const electronView = { ...electron, BrowserWindow: FixtureWindow, Tray: InertTray,
  screen: { getPrimaryDisplay: () => electron.screen.getPrimaryDisplay(), getCursorScreenPoint: () => ({ x: -1000, y: -1000 }) },
  Menu: { ...electron.Menu, setApplicationMenu() {}, getApplicationMenu: () => null },
  shell: new Proxy({}, { get: (_obj, name) => () => { throw block(`shell.${String(name)}`); } }),
  clipboard: new Proxy({}, { get: (_obj, name) => () => { throw block(`clipboard.${String(name)}`); } }),
  dialog: new Proxy({}, { get: (_obj, name) => () => { throw block(`dialog.${String(name)}`); } }),
  systemPreferences: new Proxy({}, { get: (_obj, name) => () => { throw block(`systemPreferences.${String(name)}`); } }),
  powerMonitor: Object.assign(new EventEmitter(), { getSystemIdleTime: () => 0, getSystemIdleState: () => 'active' })
};
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'electron') return electronView;
  if (parent?.filename.startsWith(TARGET) && /(?:^|\/)computer\.cjs$/.test(request)) return fakeHost;
  return originalLoad.call(this, request, parent, isMain);
};
let gate;
const held = new Map(), handlers = new Map();
const originalRename = fs.renameSync;
fs.renameSync = function(from, to) {
  const result = originalRename.apply(this, arguments);
  if (to === path.join(PROFILE, 'preferences.json')) {
    journal.persistence ||= [];
    journal.persistence.push({ at: Date.now(), data: JSON.parse(fs.readFileSync(to, 'utf8')) });
  }
  return result;
};
const originalHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => {
  handlers.set(channel, handler);
  return originalHandle(channel, channel !== 'workspace:command' ? handler : async (event, name, value) => {
    const record = { name, value, at: Date.now() }; journal.commands.push(record);
    if (!['settings','settings-write-status','remote-status','update-status','mac-permissions','select-agent'].includes(name)) throw block('command', name);
    if (name === 'update-status') return {};
    if (name === 'mac-permissions') return {accessibility:false,screen:'not-determined'};
    const mine = gate && name === gate.name && (!gate.key || Object.hasOwn(value || {}, gate.key)) ? gate : null;
    if (mine) { gate = null; mine.record = record; held.set(mine.id, mine); }
    if (mine?.phase === 'before') await mine.promise;
    if (mine?.errorBefore) throw Error(mine.errorBefore);
    const result = await handler(event, name, value);
    record.returned = {settingsWrite:result?.settingsWrite,state:result?.state&&Object.fromEntries(['uiStateRevision','selectedBotId','autoOpenLinks','autoTakeover','preview','macSshHost','vpsBrowser','remoteUrl','remotePlatform'].map(k=>[k,result.state[k]]))};
    if (mine?.phase === 'after') await mine.promise;
    if (mine?.errorAfter) throw Error(mine.errorAfter);
    return result;
  });
};
function hold(key, phase, name = 'settings') {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  gate = {id: `hold-${Date.now()}-${held.size}`, name, key, phase, promise, release};
  return gate;
}
require(path.join(TARGET, 'src/main.cjs'));
let win, wc;
const js = code => wc.executeJavaScript(code);
const disk = () => JSON.parse(fs.readFileSync(path.join(PROFILE, 'preferences.json'), 'utf8'));
async function until(read, timeout = 10000) {
  const started = Date.now();
  while (Date.now()-started < timeout) { try { const result = await read(); if (result) return result; } catch {} await sleep(25); }
  throw Error('Timed out waiting for recovery assertion');
}
const event = () => ({sender:wc,senderFrame:wc.mainFrame});
const command = (name, value) => { (journal.directCommands ||= []).push({name,value}); return handlers.get('workspace:command')(event(),name,value); };
const state = () => handlers.get('workspace:get')(event());
const attr = (id, name) => js(`document.getElementById(${JSON.stringify(id)})?.getAttribute(${JSON.stringify(name)})`);
const text = () => js('document.getElementById("modal-body").innerText');
const val = id => js(`document.getElementById(${JSON.stringify(id)})?.value`);
async function key(name, modifiers = 0) {
  const vk = {Tab:9,Enter:13,Escape:27,' ':32}[name];
  const p={key:name,code:name===' '?'Space':name,windowsVirtualKeyCode:vk,modifiers};
  await wc.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',...p,...(name==='Enter'?{text:'\r',unmodifiedText:'\r'}:name===' '?{text:' ',unmodifiedText:' '}:{})});
  await wc.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',...p}); await sleep(30);
}
async function click(selector) {
  const p = await js(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw Error('missing target');n.scrollIntoView({block:'nearest'});const b=n.getBoundingClientRect();if(!b.width||!b.height)throw Error('hidden target '+${JSON.stringify(selector)});return {x:b.x+b.width/2,y:b.y+b.height/2}})()`);
  await wc.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mousePressed',...p,button:'left',clickCount:1});
  await wc.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseReleased',...p,button:'left',clickCount:1}); await sleep(35);
}
async function edit(id, value) {
  await js(`(()=>{const e=document.getElementById(${JSON.stringify(id)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
}
async function open() { await click(await js('document.getElementById("settings-button").getBoundingClientRect().width?"#settings-button":"#settings-fallback"')); await until(()=>js('!!document.getElementById("settings-search")')); }
async function reopen() { await key('Escape'); await open(); }
async function show(id) {
  await click(id==='settings-auto-links'||id==='settings-auto-takeover'?'#settings-category-general':'#settings-category-connections');
  if (id==='settings-preview'||id==='remote-url') await js('document.getElementById("settings-remote-details").open=true');
  if (id==='settings-save-addresses'||id==='mac-ssh-host') await js('document.getElementById("settings-agent-details").open=true');
}
const count = key => journal.commands.filter(c=>c.name==='settings' && Object.hasOwn(c.value||{},key)).length;
const persists = key => (journal.persistence||[]).filter((p,i,a)=>i && JSON.stringify(p.data[key])!==JSON.stringify(a[i-1].data[key])).length;
async function shot(name) {
  await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  fs.writeFileSync(path.join(OUT,name+'.png'),(await wc.capturePage()).toPNG());
}
async function test(name, run) {
  if (process.env.SETTINGS_RECOVERY_CASE && !name.includes(process.env.SETTINGS_RECOVERY_CASE)) return;
  try { await run(); journal.checks.push({name,pass:true}); console.log('PASS', name); }
  catch(error) { journal.checks.push({name,pass:false,error:error.stack}); console.log('FAIL',name,error.message); await shot('failure-'+journal.checks.length); }
  finally { gate=null; for(const h of held.values())h.release();held.clear();await sleep(80); save(); }
}
async function recover(id) {
  await until(()=>js(`!!document.getElementById(${JSON.stringify(id)})&&!document.getElementById(${JSON.stringify(id)}).hidden`),7000);
  await click('#'+id);
}
const saveFor = field => field==='remote-url'?'[data-settings-section="remote-desktop"] .primary-button':'#settings-save-addresses';
async function settled(selector) { await until(()=>js(`!document.querySelector(${JSON.stringify(selector)}).hasAttribute('aria-busy')`)); }
async function reviewBot(id) { await js(`(()=>{const e=document.getElementById('settings-setup-bot');e.value=${JSON.stringify(id)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`); }
async function search(query) { await js(`(()=>{const e=document.getElementById('settings-search');e.value=${JSON.stringify(query)};e.dispatchEvent(new Event('input',{bubbles:true}));})()`); }
async function geometry(selector) {
  return js(`(()=>{const n=document.querySelector(${JSON.stringify(selector)}),s=n.closest('.settings-section').querySelector('.settings-action-status'),p=document.getElementById('settings-content'),b=n.getBoundingClientRect(),r=p.getBoundingClientRect(),c=getComputedStyle(n),ring=parseFloat(c.outlineWidth)+Math.max(0,parseFloat(c.outlineOffset));return {focused:n===document.activeElement,outline:parseFloat(c.outlineWidth),complete:b.top-ring>=r.top-1&&b.bottom+ring<=r.bottom+1&&b.left-ring>=r.left-1&&b.right+ring<=r.right+1,viewport:[innerWidth,innerHeight]};})()`);
}
async function run() {
  await open();
  for (const spec of [{id:'settings-auto-links',key:'autoOpenLinks'},{id:'settings-auto-takeover',key:'autoTakeover'},{id:'settings-preview',key:'preview'}]) {
    for(const phase of ['before','after']) await test(`${spec.key}: ${phase} write survives reopen and blocks duplicate`,async()=>{
      await show(spec.id); const old=disk()[spec.key], before=count(spec.key), writes=persists(spec.key), h=hold(spec.key,phase);
      await click('#'+spec.id);await until(()=>held.has(h.id));
      await key('Enter');await click('#'+spec.id);assert.equal(count(spec.key)-before,1);
      await reopen();await show(spec.id);
      assert.equal(await attr(spec.id,'aria-busy'),'true','Recreated control retains pending state');
      assert.match(await text(),/Saving/);
      await click('#'+spec.id);await key('Enter');assert.equal(count(spec.key)-before,1,'Recreated control cannot send a second write');
      assert.equal(disk()[spec.key],phase==='after'?!old:old);
      h.release();await until(async()=>await attr(spec.id,'aria-busy')!=='true');
      assert.equal(disk()[spec.key],!old);assert.equal(persists(spec.key)-writes,1);
      assert.equal(await attr(spec.id,'aria-checked'),String(!old));
    });
    for(const phase of ['before','after']) await test(`${spec.key}: missing ${phase} reply checks disk and fences late old work`,async()=>{
      await show(spec.id);const old=disk()[spec.key],before=count(spec.key),writes=persists(spec.key),h=hold(spec.key,phase);
      await click('#'+spec.id);await until(()=>held.has(h.id));await reopen();await show(spec.id);
      await recover(spec.id+'-check-save');await until(async()=>await attr(spec.id,'aria-busy')!=='true');
      assert.equal(disk()[spec.key],phase==='after'?!old:old);assert.equal(count(spec.key)-before,1,'Recovery is a read/fence, never replay');
      await click('#'+spec.id);await until(()=>count(spec.key)-before===2);await until(async()=>await attr(spec.id,'aria-busy')!=='true');
      const newer=disk()[spec.key];h.release();await sleep(140);
      assert.equal(disk()[spec.key],newer,'Late earlier work cannot overwrite the next explicit choice');
      assert.equal(await attr(spec.id,'aria-checked'),String(newer));
      assert.equal(persists(spec.key)-writes,phase==='after'?2:1);
    });
  }
  for(const field of ['mac-ssh-host','remote-url']) for(const phase of ['before','after']) await test(`${field}: missing ${phase} reply preserves same-value revisions and newer drafts`,async()=>{
    await show(field);
    const keyName=field==='remote-url'?'remoteUrl':'macSshHost';
    const saveSelector=field==='remote-url'?'[data-settings-section="remote-desktop"] .primary-button':'#settings-save-addresses';
    const submit=()=>click(saveSelector);
    const suffix=String(Date.now()), submitted=field==='remote-url'?`https://viewer-${suffix}.invalid/vnc.html`:`saved-${suffix}@computer.invalid`;
    await edit(field,submitted);const h=hold(keyName,phase),before=count(keyName);await submit();await until(()=>held.has(h.id));
    await edit(field,submitted);await reopen();await show(field);assert.equal(await val(field),submitted);
    const later=field==='remote-url'?`https://draft-${suffix}.invalid/vnc.html`:`draft-${suffix}@computer.invalid`;
    await edit(field,later);await recover(field+'-check-save');
    await until(()=>js(`document.getElementById(${JSON.stringify(field+'-check-save')}).hidden`));
    assert.equal(await js(`document.querySelector(${JSON.stringify(saveSelector)}).getAttribute('aria-busy')`),null);
    assert.equal(await js(`document.getElementById(${JSON.stringify(field)}).dataset.dirty`),'true','The later input revision stays unsaved');
    assert.equal(await val(field),later);assert.equal(count(keyName)-before,1);
    await submit();await until(()=>count(keyName)-before===2);await sleep(90);assert.equal(disk()[keyName],later);
    h.release();await sleep(120);assert.equal(disk()[keyName],later);assert.equal(await val(field),later);
  });
  if(['red-reopen','red-reopen-2','red-stalled'].includes(mode)) return;
  await test('legacy same-field explicit choice fences a tracked switch held before admission',async()=>{
    await show('settings-auto-links');const old=disk().autoOpenLinks,before=persists('autoOpenLinks'),h=hold('autoOpenLinks','before');await click('#settings-auto-links');await until(()=>held.has(h.id));
    // This newer explicit choice deliberately equals the existing saved value.
    await command('settings',{autoOpenLinks:old});h.release();await settled('#settings-auto-links');
    assert.equal(disk().autoOpenLinks,old,'The newer explicit legacy choice wins even when its value did not change');assert.equal(persists('autoOpenLinks'),before);
    assert.match(await js('document.getElementById("settings-auto-links").parentElement.nextElementSibling.textContent'),/not applied|current value/);
  });
  await test('same-value input revisions stay dirty and explicit Discard restores disk without writing',async()=>{
    await show('mac-ssh-host');const submitted=`same-${Date.now()}@computer.invalid`;await edit('mac-ssh-host',submitted);
    const h=hold('macSshHost','after');await click(saveFor('mac-ssh-host'));await until(()=>held.has(h.id));await edit('mac-ssh-host',submitted);
    h.release();await settled(saveFor('mac-ssh-host'));
    assert.equal(await js('document.getElementById("mac-ssh-host").dataset.dirty'),'true');assert.match(await text(),/Newer edits are not saved/);
    const writes=(journal.persistence||[]).length;await edit('mac-ssh-host','discard-me@computer.invalid');await click('#settings-discard-addresses');
    assert.equal(await val('mac-ssh-host'),disk().macSshHost);assert.equal((journal.persistence||[]).length,writes);
    assert.equal(await js('document.getElementById("mac-ssh-host").dataset.dirty'),undefined);
  });
  await test('two address fields own independent revisions across a successful reply',async()=>{
    await show('mac-ssh-host');const mac=`pair-${Date.now()}@computer.invalid`;await edit('mac-ssh-host',mac);
    const h=hold('macSshHost','after');await click(saveFor('mac-ssh-host'));await until(()=>held.has(h.id));
    await edit('vps-ssh-host','newer@agent.invalid');h.release();await settled(saveFor('mac-ssh-host'));
    assert.equal(await val('mac-ssh-host'),mac);assert.equal(await js('document.getElementById("mac-ssh-host").dataset.dirty'),undefined);
    assert.equal(await val('vps-ssh-host'),'newer@agent.invalid');assert.equal(await js('document.getElementById("vps-ssh-host").dataset.dirty'),'true');
    assert.notEqual(disk().vpsBrowser.sshHost,'newer@agent.invalid');await click('#settings-discard-addresses');
  });
  for(const phase of ['before','after']) await test(`late ${phase} rejection after recovery cannot replace newer save or draft`,async()=>{
    await show('mac-ssh-host');const a=`old-${Date.now()}@computer.invalid`,b=`new-${Date.now()}@computer.invalid`;await edit('mac-ssh-host',a);
    const h=hold('macSshHost',phase);if(phase==='after')h.errorAfter='Lost reply after persistence';else h.errorBefore='Old request rejected before admission';
    await click(saveFor('mac-ssh-host'));await until(()=>held.has(h.id));await edit('mac-ssh-host',b);await recover('mac-ssh-host-check-save');await settled(saveFor('mac-ssh-host'));
    await click(saveFor('mac-ssh-host'));await settled(saveFor('mac-ssh-host'));assert.equal(disk().macSshHost,b);
    await edit('mac-ssh-host','later-local@computer.invalid');const notice=await text();h.release();await sleep(100);
    assert.equal(disk().macSshHost,b);assert.equal(await val('mac-ssh-host'),'later-local@computer.invalid');assert.equal(await text(),notice);await click('#settings-discard-addresses');
  });
  await test('rejected delivery before admission offers immediate checked recovery without false failure',async()=>{
    await show('settings-auto-links');const old=disk().autoOpenLinks,h=hold('autoOpenLinks','before');h.errorBefore='Injected delivery unavailable';
    await click('#settings-auto-links');await until(()=>held.has(h.id));h.release();await recover('settings-auto-links-check-save');await settled('#settings-auto-links');
    const feedback=await js('document.getElementById("settings-auto-links").parentElement.nextElementSibling.textContent');
    assert.equal(disk().autoOpenLinks,old);assert.match(feedback,/not applied/);assert.doesNotMatch(feedback,/Saved\.|cancelled|rolled back/);
  });
  await test('missing recovery reply is bounded and another check never replays the original write',async()=>{
    await show('settings-auto-links');const h=hold('autoOpenLinks','before'),before=count('autoOpenLinks');await click('#settings-auto-links');await until(()=>held.has(h.id));
    await until(()=>js('!document.getElementById("settings-auto-links-check-save").hidden'),7000);
    const statusHold=hold(null,'after','settings-write-status');await click('#settings-auto-links-check-save');await until(()=>held.has(statusHold.id));
    await until(async()=>await attr('settings-auto-links-check-save','aria-disabled')==='false',7000);assert.equal(count('autoOpenLinks')-before,1);
    await click('#settings-auto-links-check-save');await settled('#settings-auto-links');await click('#settings-auto-links');await settled('#settings-auto-links');const newer=disk().autoOpenLinks;
    statusHold.release();h.release();await sleep(150);assert.equal(disk().autoOpenLinks,newer);assert.equal(count('autoOpenLinks')-before,2);
  });
  await test('concurrent different switches and addresses keep independent pending ownership',async()=>{
    await show('settings-auto-links');const old=disk().autoOpenLinks,h=hold('autoOpenLinks','before');await click('#settings-auto-links');await until(()=>held.has(h.id));
    await click('#settings-auto-takeover');await settled('#settings-auto-takeover');const takeover=disk().autoTakeover;
    await show('mac-ssh-host');await edit('mac-ssh-host',`concurrent-${Date.now()}@computer.invalid`);await click(saveFor('mac-ssh-host'));await settled(saveFor('mac-ssh-host'));
    await reopen();await show('settings-auto-links');assert.equal(await attr('settings-auto-links','aria-busy'),'true');assert.equal(await attr('settings-auto-takeover','aria-busy'),null);
    h.release();await settled('#settings-auto-links');assert.equal(disk().autoOpenLinks,!old);assert.equal(disk().autoTakeover,takeover);
  });
  await test('reviewed bot contexts isolate drafts and newer shared addresses fence older work',async()=>{
    await show('mac-ssh-host');await reviewBot('81001');const cedar=`cedar-${Date.now()}@computer.invalid`,maple=`maple-${Date.now()}@computer.invalid`;
    await edit('mac-ssh-host',cedar);const h=hold('macSshHost','before');await click(saveFor('mac-ssh-host'));await until(()=>held.has(h.id));
    await reviewBot('81002');assert.notEqual(await val('mac-ssh-host'),cedar);await edit('mac-ssh-host',maple);await click(saveFor('mac-ssh-host'));await settled(saveFor('mac-ssh-host'));assert.equal(disk().macSshHost,maple);
    await edit('mac-ssh-host','maple-later@computer.invalid');await reviewBot('81001');h.release();await sleep(100);assert.equal(disk().macSshHost,maple);
    await reviewBot('81002');assert.equal(await val('mac-ssh-host'),'maple-later@computer.invalid');await click('#settings-discard-addresses');await reviewBot('81001');
  });
  await test('actual selected-bot change prevents a delayed address request entering the new context',async()=>{
    await show('mac-ssh-host');const initial=await state(),old=disk().macSshHost,before=persists('macSshHost');await edit('mac-ssh-host','old-bot@computer.invalid');
    const h=hold('macSshHost','before');await click(saveFor('mac-ssh-host'));await until(()=>held.has(h.id));
    await command('open-bot',{id:'81002'});await sleep(60);assert.equal((await state()).selectedBotId,'81002');assert.equal(disk().selectedBotId,'81002');
    await edit('mac-ssh-host','new-bot-draft@computer.invalid');h.release();await sleep(100);
    assert.equal(disk().macSshHost,old);assert.equal(persists('macSshHost'),before);assert.equal(await val('mac-ssh-host'),'new-bot-draft@computer.invalid');
    await command('open-bot',{id:initial.selectedBotId});await sleep(60);assert.equal(await val('mac-ssh-host'),'old-bot@computer.invalid');await click('#settings-discard-addresses');
  });
  await test('a later explicit viewer save fences the earlier address write that could move the viewer',async()=>{
    await show('mac-ssh-host');const old=disk().macSshHost;await edit('mac-ssh-host','old-address@computer.invalid');const h=hold('macSshHost','before');await click(saveFor('mac-ssh-host'));await until(()=>held.has(h.id));
    await show('remote-url');const newer=`https://new-viewer-${Date.now()}.invalid/vnc.html`;await edit('remote-url',newer);await click(saveFor('remote-url'));await settled(saveFor('remote-url'));assert.equal(disk().remoteUrl,newer);
    h.release();await sleep(100);assert.equal(disk().macSshHost,old);assert.equal(disk().remoteUrl,newer);await show('mac-ssh-host');await click('#settings-discard-addresses');
  });
  await test('saved-target, host-label and platform contexts retain their own drafts',async()=>{
    await show('remote-url');const initial=await state();await edit('remote-url','https://retained-context.invalid/vnc.html');
    await command('settings',{macSshHost:'context-host@computer.invalid'});await sleep(60);assert.notEqual(await val('remote-url'),'https://retained-context.invalid/vnc.html');
    await command('settings',{macSshHost:initial.macSshHost});await sleep(60);assert.equal(await val('remote-url'),'https://retained-context.invalid/vnc.html');
    const actual=await state();wc.send('workspace:state',{...actual,uiStateRevision:actual.uiStateRevision+1,hostLabel:'fixture-other-host'});await sleep(50);assert.notEqual(await val('remote-url'),'https://retained-context.invalid/vnc.html');
    wc.send('workspace:state',{...actual,uiStateRevision:actual.uiStateRevision+2});await sleep(50);assert.equal(await val('remote-url'),'https://retained-context.invalid/vnc.html');
    // Advance actual main revisions through real mutations past the synthetic label probe.
    for(let i=0;i<4;i++)await command('settings',{showBots:i%2===0});
    await command('settings',{showBots:true});await command('settings',{remotePlatform:'mac'});await sleep(50);assert.notEqual(await val('remote-url'),'https://retained-context.invalid/vnc.html');
    await command('settings',{remotePlatform:initial.remotePlatform});await sleep(50);assert.equal(await val('remote-url'),'https://retained-context.invalid/vnc.html');await click('#settings-discard-viewer');
  });
  await test('search, category and focused editable field survive a late confirmed reply',async()=>{
    await show('mac-ssh-host');await edit('mac-ssh-host',`focus-${Date.now()}@computer.invalid`);const h=hold('macSshHost','after');await click(saveFor('mac-ssh-host'));await until(()=>held.has(h.id));
    await search('viewer');await click('#remote-url');await edit('remote-url','https://local-focus.invalid/vnc.html');const focus=await js('document.activeElement.id');h.release();await sleep(90);
    assert.equal(await js('document.activeElement.id'),focus);assert.equal(await val('settings-search'),'viewer');assert.equal(await val('remote-url'),'https://local-focus.invalid/vnc.html');
    await search('');await show('remote-url');await click('#settings-discard-viewer');
  });
  await test('actual validation keeps invalid addresses editable and disk unchanged',async()=>{
    await show('mac-ssh-host');const old=disk().macSshHost;await edit('mac-ssh-host','invalid address');await click(saveFor('mac-ssh-host'));await settled(saveFor('mac-ssh-host'));
    assert.equal(disk().macSshHost,old);assert.equal(await val('mac-ssh-host'),'invalid address');assert.match(await text(),/Enter the Mac SSH address/);await click('#settings-discard-addresses');
    await show('remote-url');const url=disk().remoteUrl;await edit('remote-url','invalid viewer');await click(saveFor('remote-url'));await settled(saveFor('remote-url'));
    assert.equal(disk().remoteUrl,url);assert.equal(await val('remote-url'),'invalid viewer');await click('#settings-discard-viewer');
  });
  for(const [width,height] of [[1280,900],[1120,760],[1024,680],[840,520]]) await test(`keyboard recovery, outline and feedback at ${width}x${height}`,async()=>{
    await wc.debugger.sendCommand('Emulation.clearDeviceMetricsOverride');const effective=await resizeWindow(win,width,height);await wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width:effective.width,height:effective.height,deviceScaleFactor:1,mobile:false});await show('settings-auto-links');
    await js('document.getElementById("settings-auto-links").focus()');await key('Tab');await key('Tab',8);
    const h=hold('autoOpenLinks','before'),before=count('autoOpenLinks');await key('Enter');await until(()=>held.has(h.id));await key('Enter');await key(' ');await click('#settings-auto-links');assert.equal(count('autoOpenLinks')-before,1);
    await key('Tab');await key('Tab',8);const g=await geometry('#settings-auto-links');assert.ok(g.focused&&g.complete&&g.outline>=2,JSON.stringify(g));
    await until(()=>js('!document.getElementById("settings-auto-links-check-save").hidden'),7000);await key('Tab');assert.equal(await js('document.activeElement.id'),'settings-auto-links-check-save');
    const recoveryGeometry=await geometry('#settings-auto-links-check-save');assert.ok(recoveryGeometry.complete&&recoveryGeometry.outline>=2,JSON.stringify(recoveryGeometry));await shot(`recovery-${width}`);
    await key('Enter');await settled('#settings-auto-links');assert.equal(await js('document.activeElement.id'),'settings-auto-links');
    await key('Tab');assert.equal(await js('document.activeElement.id'),'settings-auto-takeover');h.release();await sleep(80);
    (journal.geometry ||= []).push({requested:[width,height],...effective,switch:g,recovery:recoveryGeometry});
  });
  for(const spec of [{id:'settings-preview',key:'preview',check:'settings-preview-check-save'}, {id:'mac-ssh-host',key:'macSshHost',check:'mac-ssh-host-check-save'}, {id:'remote-url',key:'remoteUrl',check:'remote-url-check-save'}]) await test(`${spec.id}: pending recovery geometry across four sizes`,async()=>{
    await show(spec.id);const selector=spec.id==='settings-preview'?'#'+spec.id:saveFor(spec.id);
    if(spec.id==='mac-ssh-host')await edit(spec.id,'geometry@computer.invalid');if(spec.id==='remote-url')await edit(spec.id,'https://geometry.invalid/vnc.html');
    const h=hold(spec.key,'before');await click(selector);await until(()=>held.has(h.id));await until(()=>js(`!document.getElementById(${JSON.stringify(spec.check)}).hidden`),7000);
    for(const [width,height] of [[1280,900],[1120,760],[1024,680],[840,520]]) {
      await wc.debugger.sendCommand('Emulation.clearDeviceMetricsOverride');const effective=await resizeWindow(win,width,height);await wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width:effective.width,height:effective.height,deviceScaleFactor:1,mobile:false});
      await js(`document.querySelector(${JSON.stringify(selector)}).focus()`);await key('Tab');
      if(spec.id!=='settings-preview')await key('Tab');assert.equal(await js('document.activeElement.id'),spec.check);
      const g=await geometry('#'+spec.check);assert.ok(g.focused&&g.complete&&g.outline>=2,JSON.stringify(g));await shot(`${spec.id}-recovery-${width}`);
      (journal.geometry ||= []).push({id:spec.id,requested:[width,height],...effective,recovery:g});
    }
    await key('Enter');await settled(selector);assert.equal(await js(`document.activeElement===document.querySelector(${JSON.stringify(selector)})`),true);h.release();await sleep(60);
    if(spec.id!=='settings-preview')await click(spec.id==='remote-url'?'#settings-discard-viewer':'#settings-discard-addresses');
  });
}
app.whenReady().then(async()=>{
  try {
    win=await until(()=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/index.html')));wc=win.webContents;
    await until(()=>js('!!document.getElementById("settings-fallback")&&!!window.workspace'));
    wc.debugger.attach('1.3');await wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
    journal.provenance={pid:process.pid,versions:process.versions,target:TARGET,url:wc.getURL(),preloadHash:require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(TARGET,'src/preload.bundle.cjs'))).digest('hex'),loaded: Object.keys(require.cache).filter(f=>f.startsWith(TARGET))};
    await js(`window.fixtureInput=[];document.addEventListener('keydown',e=>fixtureInput.push({key:e.key,trusted:e.isTrusted,target:e.target.id}),true);true`);
    await run();journal.input=await js('fixtureInput');journal.finalDisk=disk();journal.completed=true;save();
  } catch(error) {journal.errors.push(error.stack);save();console.error(error);}
  finally {
    const failed=journal.checks.some(c=>!c.pass)||journal.errors.length;
    console.log('COMPLETE',JSON.stringify({checks:journal.checks.length,failed:journal.checks.filter(c=>!c.pass).length,errors:journal.errors}));
    for(const w of BrowserWindow.getAllWindows())w.destroy();
    app.exit(failed?1:0);
  }
});
setTimeout(()=>{journal.errors.push('Fixture deadline exceeded');save();app.exit(2);},240000).unref();
