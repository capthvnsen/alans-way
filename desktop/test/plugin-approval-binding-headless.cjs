// Real router -> public MCP -> actual host -> headless Chromium. Inert loopback targets only.
// Adapted from the independent round2 probe; no browser policy/resolver/input stubs.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {spawn} = require('node:child_process');
const readline = require('node:readline');
const assert = require('node:assert/strict');
const primary = path.resolve(__dirname, '../..');
const desktop = path.resolve(process.env.HERMES_APPROVAL_DESKTOP || path.join(primary, 'desktop'));
for (const file of ['src/cdp.cjs', 'src/agent-input.cjs', 'src/browser-page.cjs', 'scripts/browser-mcp.cjs', 'scripts/vps-browser-host.cjs']) assert.ok(fs.existsSync(path.join(desktop, file)), 'HERMES_APPROVAL_DESKTOP must name a complete coherent desktop candidate (or omit it to test the current checkout). Missing: ' + file);
assert.ok(process.env.ALANS_WAY_AGENTS, 'Set ALANS_WAY_AGENTS to the plugin checkout to test.');
const plugin = path.resolve(process.env.ALANS_WAY_AGENTS);
assert.ok(fs.existsSync(path.join(plugin, 'alans-way/scripts/workspace-router.cjs')), 'ALANS_WAY_AGENTS must contain alans-way/scripts/workspace-router.cjs.');
const chrome = process.env.HERMES_TEST_CHROME;
assert.ok(chrome && fs.existsSync(chrome), 'Set HERMES_TEST_CHROME to an installed Chromium executable; this real-browser regression cannot skip.');
const out = path.resolve(process.env.HERMES_APPROVAL_EVIDENCE || path.join(primary, 'evidence/quality/plugin-round3/current'));
fs.mkdirSync(out,{recursive:true});
for (const name of ['wire.jsonl', 'router.stderr.txt', 'host.stderr.txt', 'chromium.stderr.txt']) fs.writeFileSync(path.join(out, name), '');
const {CDP} = require(path.join(desktop,'src/cdp.cjs'));
const pause = ms => new Promise(r=>setTimeout(r,ms));
const processes=[];
const receipts=[];
const events=[];
const navs=[];
const httpWire=[];
let fixture,cdp;
function save(){ fs.writeFileSync(path.join(out,'receipts.json'),JSON.stringify({runtime:{desktop,plugin:plugin,chrome},receipts,events,navs},null,2));fs.writeFileSync(path.join(out,'http-wire.json'),JSON.stringify(httpWire,null,2)); }
function launch(file,args,env,name){const p=spawn(file,args,{env:{...process.env,...env},stdio:['pipe','pipe','pipe']});processes.push(p);p.stderr.on('data',b=>fs.appendFileSync(path.join(out,name+'.stderr.txt'),b));return p;}
async function port(){const s=http.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const n=s.address().port;await new Promise(r=>s.close(r));return n;}
class Client{
  constructor(cap=true){this.next=1;this.pending=new Map();this.approvals=[];this.policy='accept';this.p=launch(process.execPath,[process.env.HERMES_APPROVAL_ROUTER || path.join(plugin,'alans-way/scripts/workspace-router.cjs'),'--bot-id','critic-binding','--bot-name','Binding Critic','--vps-script',process.env.HERMES_APPROVAL_MCP || path.join(desktop,'scripts/browser-mcp.cjs'),'--vps-connection',path.join(out,'runtime/proxy-connection.json'),'--mac-state-file',path.join(out,'router-state/mac.json')],{HERMES_WORKSPACE_ALLOW_LOOPBACK:'1',HERMES_WORKSPACE_MAC_SSH:''},'router');
    readline.createInterface({input:this.p.stdout}).on('line',line=>{let m;try{m=JSON.parse(line)}catch{return};fs.appendFileSync(path.join(out,'wire.jsonl'),JSON.stringify({direction:'out',...m})+'\n');
      if(m.method==='elicitation/create'){this.approvals.push(m);if(this.policy==='hold'){this.held=m;return}this.answer(m,this.policy);return}
      if(this.pending.has(m.id)){const x=this.pending.get(m.id);this.pending.delete(m.id);clearTimeout(x.timer);x.resolve(m);}});
    this.ready=this.rpc('initialize',{protocolVersion:'2024-11-05',capabilities:cap?{elicitation:{form:{}}}:{},clientInfo:{name:'independent-critic',version:'1'}}).then(()=>this.send({jsonrpc:'2.0',method:'notifications/initialized'}));
  }
  send(m){fs.appendFileSync(path.join(out,'wire.jsonl'),JSON.stringify({direction:'in',...m})+'\n');this.p.stdin.write(JSON.stringify(m).replace(/[\u2028\u2029]/g,c=>'\\u'+c.charCodeAt(0).toString(16))+'\n');}
  answer(m,policy){this.send({jsonrpc:'2.0',id:m.id,result:policy==='decline'?{action:'decline'}:policy==='cancel'?{action:'cancel'}:{action:'accept',content:{approve:true}}});}
  rpc(method,params){const id=this.next++;const result=new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject,timer:setTimeout(()=>{this.pending.delete(id);reject(new Error('RPC timeout '+id))},40000)});});this.send({jsonrpc:'2.0',id,method,params});return result;}
  async call(name,args){await this.ready;return this.rpc('tools/call',{name:'cua_alans_way_'+name,arguments:args});}
  stop(){this.p.kill();}
}
function body(m){for(const c of m.result?.content||[])if(c.type==='text'){try{return JSON.parse(c.text)}catch{}}return null;}
function text(m){return (m.result?.content||[]).filter(x=>x.type==='text').map(x=>x.text).join('\n');}
async function raw(method,route,data,human=false){const conn=JSON.parse(fs.readFileSync(path.join(out,'runtime/connection.json')));let token=conn.token;if(human)token=JSON.parse(fs.readFileSync(path.join(out,'runtime/app-token.json'))).token;const res=await fetch(conn.url+route,{method,headers:{Authorization:'Bearer '+token,'X-Hermes-Bot':'critic-binding','X-Hermes-Human':human?'1':'0','Content-Type':'application/json'},...(data?{body:JSON.stringify(data)}:{})});return {status:res.status,data:await res.json()};}
async function target(tab){const r=(await raw('GET','/v1/tabs')).data;const t=(Array.isArray(r)?r:r.tabs).find(x=>x.id===tab);return (await cdp.send('Target.attachToTarget',{targetId:t.targetId,flatten:true})).sessionId;}
async function js(sid,expression){const r=await cdp.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},sid);if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result?.value;}
async function state(sid){try{return await js(sid,'({url:location.href,documentId:window.criticDocumentId,timeOrigin:performance.timeOrigin,events:window.critEvents||[],hits:window.critHits||{},links:[...document.links].map(a=>({id:a.id,name:a.innerText,href:a.href}))})')}catch(e){return {error:e.message}}}
async function setup(client,kind,id){const m=await client.call('open',{url:fixture+'/fixture?kind='+Buffer.from(kind).toString('hex')+'&id='+Buffer.from(id).toString('hex')});const b=body(m);if(!b?.id)throw new Error('open shape '+text(m));const tab=b.id,epoch=b.epoch;const snap=await client.call('snapshot',{tabId:tab,maxElements:300});const sid=await target(tab);return {tabId:tab,epoch,sid,snap:body(snap),open:m};}
async function shot(client,c,name){const m=await client.call('screenshot',{tabId:c.tabId,format:'png',maxWidth:1280});for(const part of m.result?.content||[]){if(part.type==='image')fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(part.data,'base64'));if(part.type==='text'&&part.text.includes('MEDIA:')){const match=part.text.match(/MEDIA:([^\n]+)/);if(match&&fs.existsSync(match[1].trim()))fs.copyFileSync(match[1].trim(),path.join(out,name+'.png'));}}return m;}
async function probe(client,label,kind,args,prep,options={}){
 const c=await setup(client,kind,label);if(prep)await prep(c);const before=await state(c.sid);const eventStart=events.length,navStart=navs.length,approvalStart=client.approvals.length;
 const action=typeof args==='function'?args(c):args;
 const response=await client.call('action',{tabId:c.tabId,epoch:c.epoch,...action});await pause(80);const after=await state(c.sid);
 const row={label,kind,action,snapshot:c.snap,before,response,text:text(response),after,events:events.slice(eventStart),navigations:navs.slice(navStart),approvals:client.approvals.slice(approvalStart)};
 receipts.push(row);save();process.stdout.write(JSON.stringify({label,error:!!response.result?.isError,text:row.text.slice(0,300),clicks:row.events.filter(e=>e.type==='click').length,nav:row.navigations.map(n=>n.path),approvals:row.approvals.length})+'\n');
 if(options.shot)await shot(client,c,options.shot);
 await client.call('close',{tabId:c.tabId,epoch:c.epoch});return row;
}
async function main(){
 fs.rmSync(path.join(out,'runtime'),{recursive:true,force:true});fs.mkdirSync(path.join(out,'runtime'),{recursive:true});fs.rmSync(path.join(out,'chromium-profile'),{recursive:true,force:true});
 const web=http.createServer(async(req,res)=>{const u=new URL(req.url,'http://localhost');if(u.pathname==='/events'){let b='';for await(const chunk of req)b+=chunk;try{events.push(JSON.parse(b))}catch{}res.end('ok');return}
 if(u.pathname==='/favicon.ico'){res.writeHead(204);res.end();return}
 const encoded=u.searchParams.get('id')||'';const id=u.pathname==='/fixture'?Buffer.from(encoded,'hex').toString():encoded;navs.push({id,path:u.pathname,at:Date.now()});
 const kind=Buffer.from(u.searchParams.get('kind')||'','hex').toString();let content='';
 if(u.pathname!=='/fixture')content='<h2 id="arrived">Fixture destination: '+u.pathname+'</h2>';
 else if(kind==='pay')content='<ul><li id="row"><span id="rowLabel">Order Alpha</span> <a id="main" href="/pay?id='+id+'">Buy it again</a></li></ul><button id="adjust" type="button" onclick="document.querySelector(\'#main\').href=\'/delete?id=batch-change\'">Adjust view</button><button id="safe" type="button">Save draft</button><a id="guide" href="/guide?id='+id+'">Read guide</a><form id="checkout" action="/pay"><button id="submit" type="submit">Submit order</button></form>';
 else if(kind==='replacement')content='<a id="main" href="/delete?id='+id+'">Buy it again</a>';
 else if(kind==='safe'||kind==='move')content='<a id="main" href="/guide?id='+id+'"><span>Read guide</span></a>';
 else if(kind==='roles')content='<button id="safe" type="button">Review options</button><a id="main" href="/pay?id='+id+'">Review options</a>';
 else if(kind==='types')content='<input id="safe" type="button" value="Review options"><a id="main" href="/pay?id='+id+'">Review options</a>';
 else if(kind==='types-labelled')content='<input id="safe" type="button" aria-label="Review options" value="Review options"><a id="main" href="/pay?id='+id+'">Review options</a>';
 else if(kind==='rows')content='<ul><li>Item Alpha <a id="safe" href="/guide?id='+id+'">Review options</a></li><li>Item Beta <a id="main" href="/pay?id='+id+'">Review options</a></li></ul>';
 else if(kind==='many')content=Array.from({length:149},(_,i)=>'<button type="button">Option '+i+'</button>').join('')+'<a id="main" href="/pay?id='+id+'">Read guide</a>';
 else if(kind==='harmless')content='<label>Search<input id="field" aria-label="Search"></label><button id="safe" type="button">Save draft</button><a id="main" href="/guide?id='+id+'">Read guide</a><button id="change" type="button" onclick="document.querySelector(\'#main\').href=\'/pay?id='+id+'\'">Adjust view</button>';
 res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<!doctype html><html><head><title>Independent approval boundary fixture</title><style>body{font:20px system-ui;margin:50px;background:#f8fafc;color:#172033}a,button,input{display:inline-block;margin:16px;padding:14px}a{background:#e6eefb}li{margin:25px}header{font-size:14px;color:#566174}#status{margin:30px;padding:16px;border:1px solid #d4dbe4;white-space:pre-wrap}</style></head><body><header>LOCAL TEST FIXTURE · No external transactions</header><h1>Approval binding review</h1>${content}<div id="status">Controls ready</div><script>window.criticDocumentId=crypto.randomUUID();window.critEvents=[];window.critHits={};for(const type of ['pointermove','pointerdown','mousedown','click','keydown','input'])document.addEventListener(type,e=>{const row={id:${JSON.stringify(id)},type,trusted:e.isTrusted,target:e.target.id||e.target.closest('a,button,input')?.id||e.target.tagName,key:e.key||'',href:e.target.closest('a')?.href||''};critEvents.push(row);if(type==='click')critHits[row.target]=(critHits[row.target]||0)+1;fetch('/events',{method:'POST',body:JSON.stringify(row),keepalive:true});document.querySelector('#status').textContent=JSON.stringify(critHits);},true);${kind==='move'?`document.querySelector('#main').addEventListener('pointermove',()=>document.querySelector('#main').href='/pay?id='+${JSON.stringify(id)});`:''}</script></body></html>`);
 });await new Promise(r=>web.listen(0,'127.0.0.1',r));fixture='http://127.0.0.1:'+web.address().port;
 const cdpPort=await port(),hostPort=await port();fs.writeFileSync(path.join(out,'runtime/config.json'),JSON.stringify({cdpUrl:'http://127.0.0.1:'+cdpPort,port:hostPort}));
 launch(chrome,['--headless','--no-sandbox','--remote-debugging-address=127.0.0.1','--remote-debugging-port='+cdpPort,'--user-data-dir='+path.join(out,'chromium-profile'),'--window-size=1280,900','--no-first-run','--no-default-browser-check','about:blank'],{},'chromium');
 for(let i=0;i<80;i++){try{cdp=await CDP.connect('http://127.0.0.1:'+cdpPort);break}catch{await pause(100)}}if(!cdp)throw new Error('Chromium unavailable');
 launch(process.execPath,[path.join(desktop,'scripts/vps-browser-host.cjs'),'serve'],{HERMES_VPS_BROWSER_DATA:path.join(out,'runtime'),HERMES_WORKSPACE_ALLOW_LOOPBACK:'1'},'host');
 for(let i=0;i<100&&!fs.existsSync(path.join(out,'runtime/connection.json'));i++)await pause(100);
 const connection=JSON.parse(fs.readFileSync(path.join(out,'runtime/connection.json')));
 const proxy=http.createServer(async(req,res)=>{let payload='';for await(const chunk of req)payload+=chunk;const record={path:req.url,method:req.method,...(payload?{body:JSON.parse(payload)}:{})};httpWire.push(record);const response=await fetch(connection.url+req.url,{method:req.method,headers:{...req.headers,host:new URL(connection.url).host},...(payload?{body:payload}:{})});const text=await response.text();record.response={status:response.status,body:JSON.parse(text)};res.writeHead(response.status,{'Content-Type':'application/json'});res.end(text);});await new Promise(r=>proxy.listen(0,'127.0.0.1',r));fs.writeFileSync(path.join(out,'runtime/proxy-connection.json'),JSON.stringify({...connection,url:'http://127.0.0.1:'+proxy.address().port}));
 const client=new Client();await client.ready;receipts.push({label:'runtime-status',result:await client.call('status',{})});
 const commit={kind:'purchase',summary:'Follow original local /pay fixture link only',amount:'0',currency:'TEST',counterparty:'Local fixture'};
 if(process.env.HERMES_APPROVAL_MEASURE === '1') {
   const c=await setup(client,'many','snapshot-150-controls'),runs=[];
   for(let i=0;i<20;i++){const start=performance.now();const snap=body(await client.call('snapshot',{tabId:c.tabId,maxElements:300}));runs.push({elapsedMs:performance.now()-start,bytes:Buffer.byteLength(JSON.stringify(snap)),controls:snap.elements.length});assert.equal(snap.elements.length,150);}
   runs.sort((a,b)=>a.elapsedMs-b.elapsedMs);
   const measurement={runs,medianMs:(runs[9].elapsedMs+runs[10].elapsedMs)/2,bytes:runs[0].bytes,controls:150};
   fs.writeFileSync(path.join(out,'measurement.json'),JSON.stringify(measurement,null,2));
   process.stdout.write(JSON.stringify(measurement)+'\n');save();client.stop();web.close();proxy.close();return;
 }
 if(process.env.HERMES_APPROVAL_EXPECT_UPGRADE === '1') {
   const row=await probe(client,'approval-upgrade-required','pay',{action:'click',name:'Buy it again',commit});
   assert.match(row.text,/approval_binding_unavailable|approval_invalid/);
   assert.match(row.text,/update|upgrade/i);
   assert.equal(row.events.filter(e=>['pointerdown','mousedown','click'].includes(e.type)).length,0);
   assert.equal(row.navigations.filter(n=>['/pay','/delete'].includes(n.path)).length,0);
   const ordinary=await probe(client,'ordinary-old-version-navigation','pay',{action:'click',name:'Read guide'});
   assert.equal(ordinary.events.filter(e=>e.type==='click'&&e.trusted).length,1);
   assert.equal(ordinary.navigations.filter(n=>n.path==='/guide').length,1);
   fs.writeFileSync(path.join(out,'verification.json'),JSON.stringify({upgradeRefusal:row.text,ordinaryTrustedClicks:1},null,2));
   save();client.stop();web.close();proxy.close();return;
 }
 for(const policy of ['decline','cancel']){client.policy=policy;const row=await probe(client,'decision-'+policy,'pay',{action:'click',name:'Buy it again',commit});assert.equal(row.events.filter(e=>e.type==='click').length,0);assert.match(row.text,/declined/);}
 client.policy='accept';const no=new Client(false);const unavailable=await probe(no,'no-elicitation-capability','pay',{action:'click',name:'Buy it again',commit});assert.match(unavailable.text,/approval_unavailable/);assert.equal(unavailable.events.filter(e=>e.type==='click').length,0);no.stop();
 const scenarios=[
   {mode:'same-origin-new-page',refresh:true,navigate:true},
   {mode:'same-origin-no-snapshot',navigate:true},
   {mode:'same-url-reload',reload:true},
   {mode:'same-document-new-href',refresh:true,mutate:"document.querySelector('#main').href='/delete?id=changed-destination'"},
   {mode:'href-no-snapshot',mutate:"document.querySelector('#main').href='/delete?id=no-snapshot'"},
   {mode:'role-change',ref:true,mutate:"document.querySelector('#main').setAttribute('role','button')"},
   {mode:'name-change',ref:true,mutate:"document.querySelector('#main').textContent='Delete account'"},
   {mode:'row-change',mutate:"document.querySelector('#rowLabel').textContent='Order Beta'"},
   {mode:'row-long-suffix',before:"document.querySelector('#rowLabel').textContent='X'.repeat(80)+'Alpha'",mutate:"document.querySelector('#rowLabel').textContent='X'.repeat(80)+'Beta'"},
   {mode:'node-replacement',mutate:"const a=document.querySelector('#main');a.replaceWith(a.cloneNode(true))"},
   {mode:'form-destination',ref:true,targetName:'Submit order',mutate:"document.querySelector('#checkout').action='/delete'"},
   {mode:'submit-destination',ref:true,targetName:'Submit order',mutate:"document.querySelector('#submit').formAction='/delete'"},
   {mode:'pointermove-href',mutate:"document.querySelector('#main').addEventListener('pointermove',()=>document.querySelector('#main').href='/delete?id=hover')"},
   {mode:'unrelated-update',refresh:true,allowed:true,mutate:"document.querySelector('#status').textContent='Unrelated clock updated'"},
   {mode:'control-epoch',epoch:true},
 ];
 for(const scenario of scenarios){
   const {mode}=scenario;client.policy='hold';const c=await setup(client,'pay','lost-context-'+mode);
   if(scenario.before){await js(c.sid,scenario.before);c.snap=body(await client.call('snapshot',{tabId:c.tabId}));}
   const originalState=await state(c.sid);let mutationSnapshot;
   const eventStart=events.length,navStart=navs.length;
   const target=scenario.ref?{ref:c.snap.elements.find(e=>e.name===(scenario.targetName||'Buy it again')).ref}:{name:scenario.targetName||'Buy it again'};
   const p=client.call('action',{tabId:c.tabId,epoch:c.epoch,action:'click',...target,commit});
   for(let i=0;i<100&&!client.held;i++)await pause(10);assert.ok(client.held,'real elicitation must be held');const approval=client.held;
   assert.equal(events.slice(eventStart).filter(e=>e.type==='click').length,0,'no click before accept');
   if(scenario.navigate){await cdp.send('Page.navigate',{url:fixture+'/fixture?kind='+Buffer.from('replacement').toString('hex')+'&id='+Buffer.from('changed-page').toString('hex')},c.sid);await pause(100);}
   if(scenario.reload){await cdp.send('Page.reload',{},c.sid);await pause(100);}
   if(scenario.mutate)await js(c.sid,scenario.mutate);
   if(scenario.epoch){await raw('POST','/v1/tabs/'+c.tabId+'/control',{controller:'human',epoch:c.epoch},true);await client.call('tabs',{});}
   if(scenario.refresh)mutationSnapshot=await client.call('snapshot',{tabId:c.tabId});
   const beforeAccept=await state(c.sid);
   if(scenario.navigate||scenario.reload)assert.notEqual(originalState.documentId,beforeAccept.documentId,'new real document');
   else assert.equal(originalState.documentId,beforeAccept.documentId,'same real document');
   await shot(client,c,'before-accept-'+mode);const httpStart=httpWire.length;
   client.answer(approval,'accept');const response=await p;await pause(80);await shot(client,c,'after-accept-'+mode);
   receipts.push({label:'lost-context-'+mode,allowed:!!scenario.allowed,approval,originalSnapshot:c.snap,originalState,mutationSnapshot,beforeAccept,response,text:text(response),after:await state(c.sid),events:events.slice(eventStart),navigations:navs.slice(navStart),http:httpWire.slice(httpStart)});save();
   client.held=null;
   if(mode==='same-document-new-href'){
     client.policy='accept';const fresh=await client.call('snapshot',{tabId:c.tabId});const atEvents=events.length,atNavs=navs.length;
     const recovered=await client.call('action',{tabId:c.tabId,epoch:c.epoch,action:'click',ref:body(fresh).elements.find(e=>e.name==='Buy it again').ref,commit:{kind:'delete',summary:'Follow the freshly reviewed inert local /delete target'}});
     await pause(80);await shot(client,c,'reapproved-current-target');
     assert.equal(events.slice(atEvents).filter(e=>e.type==='click'&&e.trusted).length,1,'fresh reviewed approval executes once');
     assert.equal(navs.slice(atNavs).filter(n=>n.path==='/delete').length,1);
     receipts.push({label:'recovery-fresh-review',fresh,response:recovered,events:events.slice(atEvents),navigations:navs.slice(atNavs)});
   }
   await client.call('close',{tabId:c.tabId,epoch:c.epoch+(scenario.epoch?1:0)});client.policy='accept';
 }
 client.policy='hold';const cancelled=await setup(client,'pay','cancelled-request');const cancelPromise=client.call('action',{tabId:cancelled.tabId,epoch:cancelled.epoch,action:'click',name:'Buy it again',commit});cancelPromise.catch(()=>{});for(let i=0;i<100&&!client.held;i++)await pause(10);const cancelId=client.next-1;const ask=client.held;const cancelAt=httpWire.length,eventAt=events.length;client.send({jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:cancelId}});await pause(100);client.answer(ask,'accept');await client.call('status',{});receipts.push({label:'request-cancel-late-accept',approval:ask,http:httpWire.slice(cancelAt),events:events.slice(eventAt)});const pending=client.pending.get(cancelId);if(pending){clearTimeout(pending.timer);client.pending.delete(cancelId)}client.held=null;await client.call('close',{tabId:cancelled.tabId,epoch:cancelled.epoch});client.policy='accept';
 const accepted=await setup(client,'pay','double-accept');const acceptAt=events.length,httpAt=httpWire.length;const acceptedResponse=await client.call('action',{tabId:accepted.tabId,epoch:accepted.epoch,action:'click',name:'Buy it again',commit});client.answer(client.approvals.at(-1),'accept');await client.call('status',{});await shot(client,accepted,'unchanged-approval-control');receipts.push({label:'duplicate-acceptance',originalSnapshot:accepted.snap,response:acceptedResponse,after:await state(accepted.sid),http:httpWire.slice(httpAt),events:events.slice(acceptAt)});const acceptedWire=httpWire.slice(httpAt).find(r=>r.path.endsWith('/actions'));const replayAt=events.length;const nonceReplay=await raw('POST',acceptedWire.path,acceptedWire.body);assert.equal(nonceReplay.status,403);assert.match(nonceReplay.data.error,/already used/);assert.equal(events.slice(replayAt).filter(e=>e.type==='click').length,0);receipts.push({label:'host-nonce-replay',response:nonceReplay,events:events.slice(replayAt)});await client.call('close',{tabId:accepted.tabId,epoch:accepted.epoch});
 const batch=await setup(client,'pay','approved-partial-batch');const first=batch.snap.elements.find(e=>e.name==='Adjust view').ref,second=batch.snap.elements.find(e=>e.name==='Buy it again').ref;
 const batchEvents=events.length,batchNavs=navs.length;const batchResponse=await client.call('action',{tabId:batch.tabId,epoch:batch.epoch,action:'batch',steps:[{action:'click',ref:first},{action:'click',ref:second}],commit});await pause(80);
 assert.equal(body(batchResponse).dispatched,true);assert.equal(body(batchResponse).results[0].ok,true);assert.equal(body(batchResponse).results[1].ok,false);assert.match(body(batchResponse).results[1].error,/approval_invalid/);assert.equal(events.slice(batchEvents).filter(e=>e.type==='click').length,1);assert.equal(navs.slice(batchNavs).filter(n=>['/pay','/delete'].includes(n.path)).length,0);
 receipts.push({label:'approved-partial-batch',response:batchResponse,events:events.slice(batchEvents),navigations:navs.slice(batchNavs)});await client.call('close',{tabId:batch.tabId,epoch:batch.epoch});
 const sentApproval=receipts.find(r=>r.label==='duplicate-acceptance').http.find(r=>r.path.endsWith('/actions'));
 const replayEvents=events.length;const replay=await raw('POST',sentApproval.path,sentApproval.body);assert.equal(replay.status,404,'closed tab receipt cannot dispatch');assert.equal(events.slice(replayEvents).filter(e=>e.type==='click').length,0);receipts.push({label:'closed-tab-replay',response:replay});
 save();
 const findings=receipts.filter(r=>r.label.startsWith('lost-context-'));
 const violations=[];
 for(const r of findings){
   if(r.allowed){assert.equal(r.events.filter(e=>e.type==='click'&&e.trusted).length,1,'unrelated UI update preserves reviewed target');assert.equal(r.navigations.filter(n=>n.path==='/pay').length,1);continue;}
   if(r.events.some(e=>['pointerdown','mousedown','click'].includes(e.type))) violations.push(r.label+' dispatched trusted press/click');
   if(r.navigations.some(n=>['/pay','/delete'].includes(n.path))) violations.push(r.label+' navigated to '+r.navigations.at(-1).path);
   if(!/page_changed|approval_invalid/.test(r.text)) violations.push(r.label+' lacked actionable context refusal: '+r.text.slice(0,150));
 }
 const unchanged=receipts.find(r=>r.label==='duplicate-acceptance');
 assert.equal(unchanged.events.filter(e=>e.type==='click'&&e.trusted).length,1,'unchanged approval runs once');
 assert.equal(unchanged.http.filter(r=>r.path.endsWith('/actions')).length,1,'duplicate answer forwards once');
 const cancelledRow=receipts.find(r=>r.label==='request-cancel-late-accept');
 assert.equal(cancelledRow.http.filter(r=>r.path.endsWith('/actions')).length,0,'cancelled late approval never forwards');
 fs.writeFileSync(path.join(out,'verification.json'),JSON.stringify({violations,findings:findings.map(r=>({label:r.label,text:r.text,presses:r.events.filter(e=>['pointerdown','mousedown','click'].includes(e.type)),navigations:r.navigations})),unchangedTrustedClicks:unchanged.events.filter(e=>e.type==='click').length},null,2));
 assert.deepEqual(violations,[], 'held approval must remain bound to reviewed document and destination');
 process.stdout.write('PASS actual approval binding and controls\n');client.stop();web.close();proxy.close();
}
main().catch(e=>{fs.writeFileSync(path.join(out,'ERROR.txt'),e.stack);process.stderr.write(e.stack+'\n');process.exitCode=1}).finally(async()=>{save();for(const p of processes)p.kill();if(cdp?.socket)cdp.socket.close();if(fixture){}setTimeout(()=>process.exit(process.exitCode||0),300);});
