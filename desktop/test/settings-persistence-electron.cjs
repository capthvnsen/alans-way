const { ip: fixtureTailnet, otherIp: fixtureTailnetOther } = require('./tailnet-fixture.cjs');
process.env.HERMES_WORKSPACE_ALLOW_LOOPBACK = '1';
'use strict';
const { resizeWindow } = require('./window-fixture.cjs');
// Builder regression: guarded runtime scaffold adapted after the sealed Settings critic judgement.
// No independence claim; added persistence-failure and draft-lifetime scenarios are builder authored.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const Module = require('node:module'), { EventEmitter } = require('node:events');
const electron = require('electron');
const { app, ipcMain, BrowserWindow, webContents, session } = electron;
const snapshot = path.resolve(process.env.SETTINGS_PERSISTENCE_TARGET);
const out = path.resolve(process.env.SETTINGS_PERSISTENCE_OUT);
fs.mkdirSync(out, { recursive: true });
const profile = process.env.HERMES_TEST_PROFILE;
if (!profile || !path.basename(profile).startsWith('hermes-electron-suite-')) throw Error('Owned runner profile required');
process.env.HERMES_WORKSPACE_DATA = profile;
process.env.HERMES_WORKSPACE_ALLOW_LOOPBACK = '1';
app.getVersion = () => JSON.parse(fs.readFileSync(path.join(snapshot, 'package.json'), 'utf8')).version;
const prefsFile = path.join(profile, 'preferences.json');
const originalRead = fs.readFileSync.bind(fs), originalRename = fs.renameSync.bind(fs);
const initial = { onboarded:true, bots:[{id:'101',name:'Fixture Alpha',username:'fixture_alpha_bot'},{id:'202',name:'Fixture Beta',username:'fixture_beta_bot'}], order:['101','202'], hidden:[], selectedBotId:'101', macSshHost:`fixture@${fixtureTailnet}`, vpsBrowser:{sshHost:`fixture@${fixtureTailnet}`,scriptPath:'',sudo:false}, remoteUrl:`http://${fixtureTailnet}/server-a:6080/vnc.html`, remotePlatform:'linux', autoOpenLinks:true,autoTakeover:true,preview:false, savedTabs:[], lastVersion:'0.21.6' };
fs.writeFileSync(prefsFile, JSON.stringify(initial));
const output = { mode:process.env.SETTINGS_PERSISTENCE_PHASE||'target', snapshot, started:new Date().toISOString(), provenance:{}, boundary:[], attempts:[], assertions:[], transitions:[], diskWrites:[], dispatches:[], stateReads:[], publications:[], responsiveness:[], screenshots:[] };
for (const f of ['src/main.cjs','src/preload.cjs','src/preload.bundle.cjs','src/index.html','src/renderer.js','src/style.css']) output.provenance[f] = crypto.createHash('sha256').update(originalRead(path.join(snapshot,f))).digest('hex');
const boundary = (kind, detail='') => { if(output.boundary.length<250) output.boundary.push({kind,detail:String(detail).slice(0,180)}); };
const deny = kind => (...args) => { boundary(kind, args[0]); throw Error('CRITIC boundary blocked '+kind); };
let failRead=false, failWrite=false, failedRenameAttempts=0;
fs.readFileSync = function(file,...args) { if(failRead && path.resolve(String(file))===prefsFile) throw Object.assign(Error('Owned preference read failure'),{code:'EACCES'}); return originalRead(file,...args); };
const disk = () => JSON.parse(originalRead(prefsFile,'utf8'));
fs.renameSync = function(from,to,...args) { if(path.resolve(String(to))===prefsFile) { if(failWrite) { failedRenameAttempts++; throw Object.assign(Error('Owned preference write failure'),{code:'EACCES'}); } const before=originalRead(prefsFile,'utf8'); const result=originalRename(from,to,...args); const after=originalRead(prefsFile,'utf8'); output.diskWrites.push({at:Date.now(),data:JSON.parse(after)});if(before!==after)output.transitions.push({at:Date.now(),before:JSON.parse(before),after:JSON.parse(after)});return result; } return originalRename(from,to,...args); };
// Block all process and network boundaries before loading actual main or dependencies.
const cp = require('node:child_process'); for(const method of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) cp[method]=deny('child.'+method);
require('node:net').connect=deny('net.connect');require('node:net').createConnection=deny('net.createConnection');require('node:tls').connect=deny('tls.connect');
const fakeServer=()=>{ const s=new EventEmitter(); s.listen=(...args)=>{boundary('server.listen',args.slice(0,2));return s;}; s.close=callback=>callback?.();s.address=()=>({port:0,address:'127.0.0.1'}); return s; };
for(const name of ['node:http','node:https']) { const h=require(name);h.request=deny(name+'.request');h.get=deny(name+'.get');h.createServer=fakeServer; }
global.fetch=deny('fetch');
const inert='data:text/html;charset=utf-8,'+encodeURIComponent('<!doctype html><title>Owned inert page</title><main>Local fixture only</main>');
app.on('web-contents-created',(_event,wc)=>{
 const original=wc.loadURL.bind(wc);
 // Keep background viewer retries out of the Settings command assertions.
 const loadFile=wc.loadFile.bind(wc);
 wc.loadFile=(file,...args)=>{if(path.basename(file)==='remote.html'){boundary('viewer.inert');return original(inert);}return loadFile(file,...args);};
 const send=wc.send.bind(wc);wc.send=(channel,...args)=>{if(channel==='workspace:state')output.publications.push({at:Date.now(),contents:wc.id,state:args[0]});return send(channel,...args);};
 wc.loadURL=(url,...args)=>{if(/^https?:|^wss?:/i.test(url)){boundary('webContents.loadURL',url);return original(inert);}return original(url,...args);};
 wc.focus=()=>boundary('webContents.focus');
 wc.on('did-fail-load',(_e,code,desc,url)=>boundary('did-fail-load',JSON.stringify({code,desc,url})));
 wc.on('render-process-gone',(_e,details)=>boundary('render-process-gone',JSON.stringify(details)));
 wc.on('console-message',(_e,...a)=>boundary('renderer-console',JSON.stringify(a)));
 wc.on('will-navigate',(event,url)=>{if(/^https?:|^wss?:/i.test(url)){boundary('will-navigate',url);event.preventDefault();}});
 wc.on('will-redirect',(event,url)=>{if(/^https?:|^wss?:/i.test(url)){boundary('will-redirect',url);event.preventDefault();}});
 wc.setWindowOpenHandler(()=>({action:'deny'}));
});
const rawRequest = session.fromPartition;
function guardSession(s){
 if(s.__criticGuard)return s;s.__criticGuard=true;
 const original=s.webRequest.onBeforeRequest.bind(s.webRequest);
 s.webRequest.onBeforeRequest=function(...args){const product=args.at(-1);return original({urls:['<all_urls>']},(details,callback)=>{ if(/^https?:|^wss?:/i.test(details.url)){boundary('session.request',details.url);return callback({cancel:true});}if(typeof product==='function')return product(details,callback);callback({});});};
 s.webRequest.onBeforeRequest((d,cb)=>cb({}));
 const permissionRequest=s.setPermissionRequestHandler.bind(s),permissionCheck=s.setPermissionCheckHandler.bind(s);s.setPermissionRequestHandler=()=>{};s.setPermissionCheckHandler=()=>{};
 // Guards are installed directly, independently of product permission setup.
 permissionRequest((_wc,_p,callback)=>{boundary('permission.request');callback(false);});
 permissionCheck(()=>false);
 return s;
}
// Session readiness is guarded before main's app.whenReady callback.
app.whenReady().then(()=>{guardSession(session.defaultSession);guardSession(session.fromPartition('persist:browser'));guardSession(session.fromPartition('persist:telegram'));});
session.fromPartition=function(...args){return guardSession(rawRequest.apply(this,args));};
const ownedWindows=[];
class FixtureWindow extends BrowserWindow { constructor(options){super({...options,show:false,focusable:false});ownedWindows.push(this);} show(){boundary('window.show');} showInactive(){boundary('window.showInactive');} focus(){boundary('window.focus');} }
require('node:os').homedir=()=>profile;
const appProxy = new Proxy(app,{get(t,k){if(k==='getPath')return name=>['home','appData','downloads','documents','desktop'].includes(name)?profile:t.getPath(name);if(['setAsDefaultProtocolClient','relaunch','focus'].includes(k))return (...a)=>{boundary('app.'+k,a[0]);return false;};if(k==='requestSingleInstanceLock')return ()=>true;const v=t[k];return typeof v==='function'?v.bind(t):v;}});
const fakeTray=class {setToolTip(){}setContextMenu(){}on(){}destroy(){}};
const noNative = new Proxy({close(){}},{get(t,k){return t[k]||deny('native.'+String(k));}});
const eProxy = new Proxy(electron,{get(t,k){if(k==='safeStorage')return {isEncryptionAvailable:()=>false,encryptString:deny('safeStorage.encrypt'),decryptString:deny('safeStorage.decrypt')};if(k==='globalShortcut')return new Proxy({},{get:(_,p)=>deny('globalShortcut.'+String(p))});if(k==='BrowserWindow')return FixtureWindow;if(k==='app')return appProxy;if(k==='Tray')return fakeTray;if(k==='clipboard')return new Proxy({},{get:(_,p)=>deny('clipboard.'+String(p))});if(k==='shell')return new Proxy({},{get:(_,p)=>deny('shell.'+String(p))});if(k==='dialog')return new Proxy({},{get:(_,p)=>deny('dialog.'+String(p))});if(k==='systemPreferences')return new Proxy({},{get:(_,p)=>deny('systemPreferences.'+String(p))});if(k==='net')return new Proxy(t.net,{get:(v,p)=>p==='isOnline'?()=>false:deny('net.'+String(p))});if(k==='screen')return new Proxy(t.screen,{get:(v,p)=>p==='getCursorScreenPoint'?()=>({x:-10000,y:-10000}):typeof v[p]==='function'?v[p].bind(v):v[p]});return t[k];}});
const rawLoad=Module._load;
Module._load=function(request,parent,...args){if(request==='electron')return eProxy;if(parent?.filename?.startsWith(snapshot) && /(?:^|\/)(?:computer|win-computer|vps-computer)\.cjs$/.test(request))return {service:noNative,createDesktopLease:()=>({take:()=>null,release(){}})};return rawLoad.call(this,request,parent,...args);};
const controls=[];let nextControl;
const rawHandle=ipcMain.handle.bind(ipcMain);
ipcMain.handle=function(channel,handler){ return rawHandle(channel,async (event,...args)=>{
 if(channel==='workspace:get')output.stateReads.push({at:Date.now(),contents:event.sender.id});
 if(channel!=='workspace:command')return handler(event,...args);
 const [name,value]=args;
 const row={at:Date.now(),name,value};output.dispatches.push(row);
 const c=nextControl && nextControl.match(name,value)?nextControl:null;
 if(c){nextControl=null;controls.push(c);c.row=row;c.seen=true;if(c.before)await new Promise(resolve=>c.admit=resolve);}
 let reply;try{reply=await handler(event,...args);}catch(error){row.error=String(error?.message||error);row.completed=Date.now();throw error;}row.reply=reply;row.completed=Date.now();
 if(c){c.persisted=true;c.reply=reply;if(c.after)await new Promise((resolve,reject)=>{c.release=()=>resolve();c.reject=()=>reject(Error('Owned held reply rejected'));});}
 return reply;
 });};
function hold(name,slot,phase='after') { const c={match:(n,v)=>n===name&&(!slot||v?._settingsWrite?.slot===slot||v?.slot===slot),before:phase==='before',after:true};nextControl=c;return c; }
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let win,wc;
const js=code=>wc.executeJavaScript(code,true);
async function until(fn,label,ms=4000){const start=Date.now();while(Date.now()-start<ms){if(await fn())return;await sleep(30);}throw Error('Timed out: '+label);}
async function assert(name,fn){try{const detail=await fn();output.assertions.push({name,pass:true,detail});console.log('PASS',name);}catch(error){output.assertions.push({name,pass:false,error:error.stack});console.error('FAIL',name,error.message);}}
async function scenario(name,fn){output.attempts.push({name,start:Date.now()});try{await fn();output.attempts.at(-1).completed=true;}catch(error){output.attempts.at(-1).error=error.stack;console.error('SCENARIO FAILURE',name,error.stack);output.lastTrusted=await js('window.criticTrusted').catch(()=>[]);output.lastDom=await js('({hasFocus:document.hasFocus(),active:document.activeElement?.outerHTML,modal:modalOpen})').catch(()=>null);nextControl=null;throw error;}}
function eq(actual,expected,message){if(JSON.stringify(actual)!==JSON.stringify(expected))throw Error(`${message}: got ${JSON.stringify(actual)} expected ${JSON.stringify(expected)}`);return actual;}
async function command(name,value){return js(`workspace.command(${JSON.stringify(name)},${JSON.stringify(value)})`);}
async function explicit(value){await command('settings',value);await sleep(100);}
async function mount(query){await js(`showSettings(); document.getElementById('settings-search').value=${JSON.stringify(query)};filterSettingsSections();`);await sleep(80);}
async function close(){await js('closeModal()');await sleep(60);}
async function input(id,value){await js(`(()=>{const e=document.getElementById(${JSON.stringify(id)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));})()`);}
async function debug(method,params){if(!wc.debugger.isAttached())wc.debugger.attach('1.3');return wc.debugger.sendCommand(method,params);}
async function activate(id,key='Enter'){
 await js(`document.getElementById(${JSON.stringify(id)}).focus()`);
 const map={Enter:{key:'Enter',code:'Enter',windowsVirtualKeyCode:13},Space:{key:' ',code:'Space',windowsVirtualKeyCode:32},Tab:{key:'Tab',code:'Tab',windowsVirtualKeyCode:9}};
 const data=map[key];await debug('Emulation.setFocusEmulationEnabled',{enabled:true});await debug('Input.dispatchKeyEvent',{type:'keyDown',...data,...(key==='Enter'?{text:'\r'}:key==='Space'?{text:' '}:{})});await debug('Input.dispatchKeyEvent',{type:'keyUp',...data});await sleep(80);
}
async function click(id){const r=await js(`(()=>{const e=document.getElementById(${JSON.stringify(id)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);await debug('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...r});await debug('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...r});await sleep(80);}
async function element(id){return js(`(()=>{const e=document.getElementById(${JSON.stringify(id)});if(!e)return null;const r=e.getBoundingClientRect(),s=getComputedStyle(e);return {text:e.textContent,value:e.value,busy:e.getAttribute('aria-busy'),disabled:e.getAttribute('aria-disabled'),checked:e.getAttribute('aria-checked'),hidden:e.hidden,visible:!!r.width&&!!r.height,focus:document.activeElement===e,outline:s.outlineStyle,outlineWidth:s.outlineWidth,rect:{x:r.x,y:r.y,width:r.width,height:r.height},status:e.parentElement.querySelector('.settings-action-status')?.textContent};})()`);}
async function capture(name){await sleep(120);const file=path.join(out,name+'.png');fs.writeFileSync(file,(await wc.capturePage()).toPNG());output.screenshots.push(file);}
function writes(slot){return output.dispatches.filter(r=>r.name==='settings'&&r.value?._settingsWrite?.slot===slot).length;}
function transitions(field,from=0){return output.transitions.slice(from).filter(r=>JSON.stringify(r.before[field])!==JSON.stringify(r.after[field])).length;}
async function responsiveness(){for(let i=0;i<12;i++){const s=process.hrtime.bigint();await js('document.querySelectorAll("button").length');output.responsiveness.push(Number(process.hrtime.bigint()-s)/1e6);}}
process.on('SIGTERM',()=>{output.interrupted='Owned SIGTERM requested';finish(2);});
const fatal=setTimeout(()=>{output.fatal='Independent fixture exceeded 150s';finish(2);},150000);
function finish(code){clearTimeout(fatal);output.finished=new Date().toISOString();output.disk=disk();output.profile=profile;for(const c of controls){c.admit?.();c.release?.();}if(wc?.debugger.isAttached())wc.debugger.detach();for(const w of ownedWindows)if(!w.isDestroyed())w.destroy();for(const c of webContents.getAllWebContents())if(!c.isDestroyed())c.close();output.cleanup={windows:BrowserWindow.getAllWindows().length,contents:webContents.getAllWebContents().length};fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(output,null,2)+'\n');console.log('SETTINGS_PERSISTENCE_RESULT',out,'failures',output.assertions.filter(r=>!r.pass).length);app.exit(code || (output.assertions.some(r=>!r.pass)?1:0));}
require(path.join(snapshot,'src/main.cjs'));
output.imports=Object.keys(require.cache).filter(f=>f.startsWith(snapshot)||f.includes('electron-chrome-extensions'));
output.fixtureSha256=crypto.createHash('sha256').update(originalRead(__filename)).digest('hex');
app.whenReady().then(async()=>{
 try{
 await until(()=>{win=ownedWindows.find(w=>w.webContents.getURL().endsWith('/index.html'));wc=win?.webContents;return !!wc;},'frozen index',12000);
 await until(()=>js('!!window.workspace && !!state?.api && document.readyState==="complete"'),'real preload and renderer');
 if(!output.boundary.some(item=>item.kind==='server.listen'))throw Error('Main did not reach the guarded local API listener.');
 await js(`window.criticTrusted=[];for(const t of ['click','keydown','keyup'])document.addEventListener(t,e=>{if(window.criticTrusted.length<250)window.criticTrusted.push({type:t,trusted:e.isTrusted,key:e.key,target:e.target.id});},true);`);
 output.webPreferences=wc.getLastWebPreferences();output.loadedURL=wc.getURL();
 await sleep(400);await run();await responsiveness();output.trustedInputs=await js('window.criticTrusted');finish(0);
 }catch(error){output.fatal=error.stack;output.windowDiagnostics=ownedWindows.filter(w=>!w.isDestroyed()).map(w=>({id:w.id,url:w.webContents.getURL()}));output.contentsDiagnostics=webContents.getAllWebContents().map(w=>({id:w.id,url:w.getURL()}));console.error(error);console.error(JSON.stringify(output.windowDiagnostics));finish(2);}
});

async function fieldStatus(id) { return js(`(()=>{const e=$(${JSON.stringify(id)});return {value:e.value,dirty:e.dataset.dirty,status:(e.id==='remote-url'?e.closest('.settings-section-body').querySelector('button.primary-button'):$('settings-save-addresses')).nextElementSibling.textContent}})()`); }
async function run(){
 BrowserWindow.prototype.showInactive.call(win);await resizeWindow(win,1440,900,{mode:'bounds'});await sleep(120);
 await scenario('a policy-paused saved viewer remains visible for repair', async()=>{
  const before=await js('JSON.stringify(state)');
  try {
   await js("state={...state,remoteUrl:'',savedRemoteUrl:'http://203.0.113.7/vnc.html'};");
   await mount('viewer');
   await assert('paused viewer remains editable',async()=>eq((await fieldStatus('remote-url')).value,'http://203.0.113.7/vnc.html','saved viewer address'));
  } finally { await js(`state=${before};settingsDrafts.clear();`); }
 });
 await scenario('separate broker address saves and survives failed replacement and discard', async()=>{
  const savedAgent=disk().vpsBrowser.sshHost, broker='broker@'+savedAgent.split('@').at(-1), later='later-broker@'+savedAgent.split('@').at(-1);
  await mount('ssh address');await input('vps-broker-ssh-host',broker);await activate('settings-save-addresses');
  await assert('broker address persists with the agent address unchanged',()=>eq([disk().vpsBrowser.sshHost,disk().vpsBrowser.brokerSshHost],[savedAgent,broker],'roles saved'));
  await input('vps-broker-ssh-host',later);failWrite=true;await activate('settings-save-addresses');await sleep(180);failWrite=false;
  await assert('failed broker address save retains private disk and editable draft',async()=>eq([disk().vpsBrowser.brokerSshHost,(await fieldStatus('vps-broker-ssh-host')).value],[broker,later],'failed broker save'));
  await mount('viewer');await mount('ssh address');await assert('broker draft survives reopening',async()=>eq((await fieldStatus('vps-broker-ssh-host')).value,later,'retained broker draft'));
  await activate('settings-discard-addresses');await assert('broker discard restores saved login',async()=>eq((await fieldStatus('vps-broker-ssh-host')).value,broker,'discarded broker draft'));
  await explicit({vpsBrowser:{sshHost:savedAgent,brokerSshHost:'',scriptPath:'',sudo:false}});
 });
 await legacyFailureRecovery();
 for(const [slot,id,query] of [['autoOpenLinks','settings-auto-links','takeover'],['autoTakeover','settings-auto-takeover','takeover'],['preview','settings-preview','viewer']]){
  await scenario(slot+' actual failed write then explicit choice',async()=>{
   await mount(query);const old=disk()[slot],n=writes(slot),t=output.transitions.length,a=failedRenameAttempts;
   failWrite=true;await activate(id);await sleep(180);failWrite=false;
   await assert(slot+' actual two EACCES attempts and zero persisted transitions',()=>eq([failedRenameAttempts-a,writes(slot)-n,transitions(slot,t),disk()[slot]],[2,1,0,old],'failed save counts'));
   await assert(slot+' UI and main show real saved value with actionable error',async()=>{const e=await element(id),s=await js('workspace.getState()');eq([e.checked,s[slot]],[String(old),old],'saved truth');const status=await js(`$('${id}').parentElement.nextElementSibling.textContent`);if(!/could not be saved|could not save|save failed/i.test(status))throw Error('Missing actionable persistence error: '+status);return status;});
   if(slot==='autoOpenLinks')await capture('failed-switch-current-saved');
   await sleep(350);await assert(slot+' failure never automatically replays',()=>eq([transitions(slot,t),disk()[slot]],[0,old],'no replay'));
   await activate(id);await sleep(120);
   await assert(slot+' one next explicit choice changes disk exactly once',async()=>eq([writes(slot)-n,transitions(slot,t),disk()[slot],(await element(id)).checked],[2,1,!old,String(!old)],'next explicit choice'));
  });
 }
 for(const spec of [{slot:'addresses',field:'macSshHost',id:'mac-ssh-host',save:'settings-save-addresses',query:'ssh address',value:`failed@${fixtureTailnet}`,later:`newer@${fixtureTailnet}`}, {slot:'viewer',field:'remoteUrl',id:'remote-url',save:'round2-viewer-save',query:'viewer',value:`http://${fixtureTailnet}/failed-viewer.invalid/vnc.html`,later:`http://${fixtureTailnet}/newer-viewer.invalid/vnc.html`}]){
  await scenario(spec.slot+' actual failure preserves later revisions',async()=>{
   await mount(spec.query);if(spec.slot==='viewer')await js(`$('remote-url').closest('.settings-section-body').querySelector('button.primary-button').id='${spec.save}'`);
   const old=disk()[spec.field],n=writes(spec.slot),t=output.transitions.length,a=failedRenameAttempts;
   await input(spec.id,spec.value);const c=hold('settings',spec.slot);failWrite=true;await activate(spec.save);await until(()=>c.persisted,'failed address reply');failWrite=false;
   await input(spec.id,spec.value);if(spec.slot==='addresses')await input('vps-ssh-host',`fixture-later-server@${fixtureTailnet}`);else await input(spec.id,spec.later);
   c.release();await sleep(120);
   await assert(spec.slot+' failed write leaves actual saved state and newer draft intact',async()=>{const f=await fieldStatus(spec.id),s=await js('workspace.getState()');eq([failedRenameAttempts-a,disk()[spec.field],s[spec.field],transitions(spec.field,t),f.value,f.dirty],[2,old,old,0,spec.slot==='viewer'?spec.later:spec.value,'true'],'failed draft');if(spec.slot==='addresses') { const later=await fieldStatus('vps-ssh-host');eq([later.value,later.dirty],[`fixture-later-server@${fixtureTailnet}`,'true'],'independent later field'); }if(!/could not be saved|could not save|save failed/i.test(f.status))throw Error('Missing failure detail '+f.status);return f;});
   await capture('failed-'+spec.slot+'-draft');
   await activate(spec.save);await sleep(120);
   await assert(spec.slot+' next explicit save persists intended draft once',()=>{eq([writes(spec.slot)-n,transitions(spec.field,t),disk()[spec.field]],[2,1,spec.slot==='viewer'?spec.later:spec.value],'explicit draft save');if(spec.slot==='addresses')eq([disk().vpsBrowser.sshHost,transitions('vpsBrowser',t)],[`fixture-later-server@${fixtureTailnet}`,1],'later server saved once');});
  });
 }
 await scenario('failed read after persistence preserves a newer draft until explicit check',async()=>{
  await mount('viewer');await js(`$('remote-url').closest('.settings-section-body').querySelector('button.primary-button').id='round2-viewer-save'`);
  const c=hold('settings','viewer');const n=writes('viewer'),t=output.transitions.length;await input('remote-url',`http://${fixtureTailnet}/read-failure.invalid/vnc.html`);failRead=true;await activate('round2-viewer-save');await until(()=>c.persisted,'unknown receipt');
  await input('remote-url',`http://${fixtureTailnet}/later-read-draft.invalid/vnc.html`);c.release();await sleep(120);
  await assert('read failure keeps pending and later draft',async()=>eq([(await element('round2-viewer-save')).disabled,(await fieldStatus('remote-url')).value,writes('viewer')-n],['true',`http://${fixtureTailnet}/later-read-draft.invalid/vnc.html`,1],'unknown remains pending'));
  await activate('remote-url-check-save');await assert('failed explicit read keeps recovery actionable',async()=>eq([(await element('remote-url-check-save')).hidden,(await element('round2-viewer-save')).disabled],[false,'true'],'read failed recovery'));
  failRead=false;await activate('remote-url-check-save');await sleep(100);
  await assert('second explicit read recovers without losing newer draft or replay',async()=>eq([(await element('round2-viewer-save')).disabled,(await fieldStatus('remote-url')).value,(await fieldStatus('remote-url')).dirty,writes('viewer')-n,transitions('remoteUrl',t)],['false',`http://${fixtureTailnet}/later-read-draft.invalid/vnc.html`,'true',1,1],'recovery preserves draft'));
  await activate('settings-discard-viewer');
 });
 await scenario('clean churn bounds bookkeeping while dirty pending and mounted groups survive',async()=>{
  await mount('ssh address');await input('mac-ssh-host',`fixture-retained-dirty@${fixtureTailnet}`);
  await mount('viewer');await js(`$('remote-url').closest('.settings-section-body').querySelector('button.primary-button').id='round2-viewer-save'`);await input('remote-url',`http://${fixtureTailnet}/pending-churn.invalid/vnc.html`);const c=hold('settings','viewer');await activate('round2-viewer-save');await until(()=>c.persisted,'pending churn save');
  const before=await js('settingsDrafts.size');for(let i=0;i<16;i++)await explicit({remoteUrl:`http://${fixtureTailnet}/churn-${i}.invalid/vnc.html`});
  const after=await js('settingsDrafts.size');
  await assert('sixteen clean targets retain bounded inactive bookkeeping',()=>{if(after-before>2)throw Error('draft growth '+before+' -> '+after);return {before,after};});
  await assert('pending and other mounted group dirty draft survive clean eviction',()=>js(`(()=>{const drafts=[...settingsDrafts.values()];if(!drafts.some(d=>d.pending)||!drafts.some(d=>d.values.includes('fixture-retained-dirty@${fixtureTailnet}')&&d.dirty.some(Boolean)))throw Error('Lost protected draft');return drafts.length})()`));
  c.release();await sleep(100);await explicit({remoteUrl:`http://${fixtureTailnet}/pending-churn.invalid/vnc.html`});await mount('viewer');await activate('settings-discard-viewer');await mount('ssh address');
  await assert('another mounted group retains its dirty input after churn',async()=>eq((await fieldStatus('mac-ssh-host')).value,`fixture-retained-dirty@${fixtureTailnet}`,'mounted address draft'));await activate('settings-discard-addresses');
 });
 await scenario('saving into a previously dirty target never overwrites its separate draft',async()=>{
  await mount('viewer');await js(`$('remote-url').closest('.settings-section-body').querySelector('button.primary-button').id='round2-viewer-save'`);
  const a=`http://${fixtureTailnet}/collision-a.invalid/vnc.html`,b=`http://${fixtureTailnet}/collision-b.invalid/vnc.html`,kept=`http://${fixtureTailnet}/collision-kept-draft.invalid/vnc.html`;
  await explicit({remoteUrl:b});await input('remote-url',kept);await explicit({remoteUrl:a});await input('remote-url',b);const t=output.transitions.length;await activate('round2-viewer-save');await sleep(120);
  await assert('destination target dirty draft survives a different draft saving into it',async()=>eq([disk().remoteUrl,(await fieldStatus('remote-url')).value,(await fieldStatus('remote-url')).dirty,transitions('remoteUrl',t)],[b,kept,'true',1],'destination draft collision'));
  await activate('settings-discard-viewer');
 });
 await scenario('minimum reduced-motion persistence failure feedback and keyboard focus',async()=>{
  const effective=await resizeWindow(win,1120,680,{mode:'bounds'});await debug('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await mount('takeover');failWrite=true;await activate('settings-auto-links');failWrite=false;await activate('settings-auto-links','Tab');await js(`$('settings-auto-links').focus()`);const e=await element('settings-auto-links');output.minimumFocus=e;output.reducedMotion=await js('matchMedia("(prefers-reduced-motion: reduce)").matches');
  await assert('failure feedback and focus remain nearby at minimum with reduced motion',async()=>{if(!e.focus||parseFloat(e.outlineWidth)<2||e.rect.y<0||e.rect.y+e.rect.height>effective.height||!output.reducedMotion)throw Error(JSON.stringify(e));return e;});await capture('failed-switch-minimum-reduced-motion');
 });
}

// Real public legacy IPC + owned rename EACCES, followed by exactly one normal
// tracked UI choice. Never refresh state or issue another command in between.
async function failedLegacy(value) {
 let error;failWrite=true;
 try { await command('settings',value); } catch(e) { error=String(e.message||e); }
 finally { failWrite=false; }
 if(!/App data could not be written/.test(error||''))throw Error('Missing real legacy persistence rejection: '+error);
 return error;
}
async function legacyFailureRecovery() {
 for(const spec of [
  {slot:'autoOpenLinks',id:'settings-auto-links',query:'takeover',saved:true,failed:false},
  {slot:'preview',id:'settings-preview',query:'viewer',saved:false,failed:true},
  {slot:'preview',id:'settings-preview',query:'viewer',saved:true,failed:false},
  {slot:'autoTakeover',id:'settings-auto-takeover',query:'takeover',saved:true,failed:true},
 ])await scenario(`${spec.slot} failed legacy ${spec.failed} then one tracked choice without refresh`,async()=>{
  await explicit({[spec.slot]:spec.saved});await mount(spec.query);await sleep(150);
  const a=failedRenameAttempts,t=output.transitions.length,w=output.diskWrites.length,n=writes(spec.slot),r=output.stateReads.length,d=output.dispatches.length;
  const base=await js(`state.settingsFieldRevisions.${spec.slot}`),error=await failedLegacy({[spec.slot]:spec.failed});
  await sleep(150);
  await assert(`${spec.slot} legacy ${spec.failed} rejects with two failed renames and real saved truth`,async()=>eq([failedRenameAttempts-a,output.diskWrites.length-w,transitions(spec.slot,t),disk()[spec.slot],(await element(spec.id)).checked],[2,0,0,spec.saved,String(spec.saved)],error));
  await assert(`${spec.slot} legacy ${spec.failed} publishes the retained value and advanced fence`,async()=>eq([await js(`state.${spec.slot}`),await js(`state.settingsFieldRevisions.${spec.slot}`)],[spec.saved,base+1],'failure publication'));
  await activate(spec.id);
  await assert(`${spec.slot} legacy ${spec.failed} next single tracked activation persists once without read or other command`,async()=>{
   eq([writes(spec.slot)-n,output.diskWrites.length-w,transitions(spec.slot,t),disk()[spec.slot],output.stateReads.length-r],[1,1,1,!spec.saved,0],'next normal choice');
   eq(output.dispatches.slice(d).map(x=>x.name),['settings','settings'],'no unrelated command');
   const next=output.dispatches.at(-1);eq([next.value._settingsBase[spec.slot],next.reply.settingsWrite.status],[base+1,'saved'],'next choice has new fence');
  });
 });
 await scenario('failed legacy addresses retain dirty and independent pending drafts until one explicit save',async()=>{
  await mount('viewer');await js(`$('remote-url').closest('.settings-section-body').querySelector('button.primary-button').id='round3-viewer-save'`);
  await input('remote-url',`http://${fixtureTailnet}/round3-pending.invalid/vnc.html`);const pending=hold('settings','viewer');await activate('round3-viewer-save');await until(()=>pending.persisted,'independent pending viewer');
  await input('remote-url',`http://${fixtureTailnet}/round3-kept-viewer-draft.invalid/vnc.html`);await mount('ssh address');
  // Both a same-value edit revision and an independently edited field survive.
  const saved=disk();await input('mac-ssh-host',saved.macSshHost);await input('vps-ssh-host',`fixture-round3-new-server@${fixtureTailnet}`);await sleep(150);
  const a=failedRenameAttempts,t=output.transitions.length,w=output.diskWrites.length,n=writes('addresses'),r=output.stateReads.length,d=output.dispatches.length;
  await failedLegacy({macSshHost:`fixture-round3-failed-mac@${fixtureTailnet}`,vpsBrowser:{sshHost:`fixture-round3-failed-server@${fixtureTailnet}`,scriptPath:'',sudo:false}});await sleep(150);
  await assert('failed legacy addresses preserve saved truth, same-value dirty revision and independent pending draft',async()=>{
   eq([failedRenameAttempts-a,output.diskWrites.length-w,disk().macSshHost,disk().vpsBrowser.sshHost],[2,0,saved.macSshHost,saved.vpsBrowser.sshHost],'failed address truth');
   eq([(await fieldStatus('mac-ssh-host')).value,(await fieldStatus('mac-ssh-host')).dirty,(await fieldStatus('vps-ssh-host')).value,(await fieldStatus('vps-ssh-host')).dirty],[saved.macSshHost,'true',`fixture-round3-new-server@${fixtureTailnet}`,'true'],'dirty address drafts');
   if(!await js(`[...settingsDrafts.values()].some(d=>d.pending&&d.values.includes('http://${fixtureTailnet}/round3-kept-viewer-draft.invalid/vnc.html')&&d.dirty.some(Boolean))`))throw Error('Lost independent pending viewer draft');
  });
  await activate('settings-save-addresses');
  await assert('failed legacy addresses next single tracked save persists current fields once without refresh',()=>{
   eq([writes('addresses')-n,output.diskWrites.length-w,transitions('vpsBrowser',t),disk().macSshHost,disk().vpsBrowser.sshHost,output.stateReads.length-r],[1,1,1,saved.macSshHost,`fixture-round3-new-server@${fixtureTailnet}`,0],'next address choice');
   eq(output.dispatches.slice(d).map(x=>x.name),['settings','settings'],'no unrelated command');eq(output.dispatches.at(-1).reply.settingsWrite.status,'saved','address receipt');
  });
  pending.release();await sleep(100);await mount('viewer');await activate('settings-discard-viewer');
 });
 await scenario('failed same-value legacy choice fences older held tracked admission and never later flushes failed intent',async()=>{
  await explicit({autoOpenLinks:true});await mount('takeover');const h=hold('settings','autoOpenLinks','before');const t=output.transitions.length,w=output.diskWrites.length;
  await activate('settings-auto-links');await until(()=>h.seen,'old held tracked request');await failedLegacy({autoOpenLinks:true});h.admit();await until(()=>h.persisted,'old admission settled');h.release();await sleep(100);
  await assert('failed same-value legacy choice retains revision fence against old held work',()=>eq([h.reply.settingsWrite.status,output.diskWrites.length-w,transitions('autoOpenLinks',t),disk().autoOpenLinks],['not-applied',0,0,true],'old admission fenced'));
  await failedLegacy({autoOpenLinks:false});await sleep(350);
  await assert('failed legacy intent never automatically replays after writability returns',()=>eq([output.diskWrites.length-w,transitions('autoOpenLinks',t),disk().autoOpenLinks],[0,0,true],'no automatic replay'));
  await command('preview-move',{x:23,y:31});await sleep(400);
  await assert('later automatic saver flush cannot resurrect failed legacy intent',()=>{if(output.diskWrites.length===w)throw Error('No actual later saver flush');return eq([transitions('autoOpenLinks',t),disk().autoOpenLinks,disk().previewPos],[0,true,{x:23,y:31}],'failed intent absent from saver');});
 });
}
