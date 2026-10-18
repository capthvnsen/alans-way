const { bindApproval } = require('./approval-fixture.cjs');
// Run: npx electron test/auto-takeover-commit-electron.cjs
// Uses an isolated profile and a localhost page. No Telegram sign-in required.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { app, BrowserWindow, webContents, session } = require('electron');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-workspace-auto-takeover-'));
process.env.HERMES_WORKSPACE_DATA = profile;
fs.writeFileSync(path.join(profile, 'preferences.json'), JSON.stringify({ onboarded: true, preview: false,
  bots: [{ id: '4242', isBot: true, name: 'Scout' }, { id: '5151', isBot: true, name: 'Other' }], selectedBotId: '4242' }));
process.env.HERMES_WORKSPACE_PORT = String(19000 + Math.floor(Math.random() * 10000));
process.env.HERMES_WORKSPACE_ALLOW_LOOPBACK = '1';
require('../src/main.cjs');
const waitFor = async (read, predicate, timeout = 12000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (predicate(value)) return value; await new Promise(r => setTimeout(r, 50)); }
  throw new Error('Timed out waiting for takeover state.');
};
let server;
app.whenReady().then(async () => {
  const win = await waitFor(() => BrowserWindow.getAllWindows()[0], win => !!win);
  const wc = win.webContents;
  const telegram = webContents.getAllWebContents().find(item => item.session === session.fromPartition('persist:telegram'));
  if (telegram) { telegram.stop(); await telegram.loadURL('about:blank'); }
  const evaluate = code => wc.executeJavaScript(code);
  await waitFor(() => evaluate('typeof window.workspace === "object"').catch(() => false), Boolean);
  const invoke = (name, value) => evaluate(`window.workspace.command(${JSON.stringify(name)}, ${JSON.stringify(value || {})})`);
  const connection = JSON.parse(await waitFor(() => { try { return fs.readFileSync(path.join(profile, 'connection.json'), 'utf8'); } catch { return ''; } }, Boolean));
  const api = async (endpoint, method = 'GET', body, bot = '4242', epoch) => {
    const res = await fetch(`${connection.url}${endpoint}`, { method, headers: { Authorization: `Bearer ${connection.token}`, 'X-Hermes-Bot': bot,
      ...(epoch !== undefined ? { 'X-Control-Epoch': String(epoch) } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const reply = { status: res.status, data: await res.json() };
    return reply;
  };
  const hasCommitGuard = !!require('../src/agent-input.cjs').APPROVED;
  const fixture = `<title>Commit preflight</title><style>body{margin:20px}#blocked{position:relative;width:140px}#veil{position:absolute;inset:0;background:pink}</style>
    <input id="q"><div id="plain">Plain wrapper</div><div id="pretend" role="textbox" tabindex="banana">Plain wrapper</div><div id="tabstop" tabindex="-1">Confirm and pay</div><button id="order" type="button">Place order</button>
    <div style="height:2200px"></div><div id="blocked"><button id="benign">Continue</button><div id="veil">Overlay</div></div>
    <button id="offscreen">Pay now</button>
    <script>window.orders=0;window.focusEffects=0;window.keys=0;q.focus();
    order.onclick=offscreen.onclick=()=>window.orders++;
    order.onfocus=()=>window.focusEffects++;
    q.onkeydown=()=>window.keys++;</script>`;
  const widget = '<div class="g-recaptcha"><iframe title="reCAPTCHA" width="304" height="78" src="/recaptcha/api2/anchor?k=x&size=normal"></iframe></div>';
  server = http.createServer((req,res)=>{res.setHeader('content-type','text/html');res.end(req.url.startsWith('/recaptcha') ? '<title>frame</title>' : fixture+(req.url==='/captcha'?widget:''));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const tab = (await api('/v1/tabs','POST',{url:base+'/form',background:false})).data;
  const pageWc = await waitFor(()=>webContents.getAllWebContents().find(w=>w.getURL()===base+'/form'),Boolean);
  await waitFor(()=>pageWc.executeJavaScript('document.readyState==="complete"').catch(()=>false),Boolean);
  const state = async()=>{const t=(await api(`/v1/tabs/${tab.id}`)).data;return {controller:t.controller,botId:t.botId,epoch:t.epoch};};
  const page = ()=>pageWc.executeJavaScript('({focus:document.activeElement.id,scroll:scrollY,orders:window.orders,focusEffects:window.focusEffects,keys:window.keys,value:q.value})');
  const hold = async()=>{await invoke('control',{id:tab.id,controller:'human'});await pageWc.executeJavaScript('q.focus();scrollTo(0,0)');};
  let cases=0;
  const refuse = async(body,pattern,status=403)=>{
    const before=await state(), beforePage=await page();
    const r=await api(`/v1/tabs/${tab.id}/actions`,'POST',{epoch:before.epoch,...body});
    assert.equal(r.status,status,JSON.stringify(r));assert.match(r.data.error,pattern);
    assert.deepEqual(await state(),before,'refusal preserves controller, owner and epoch');
    assert.deepEqual(await page(),beforePage,'refusal preserves focus, scroll and page effects');cases++;
  };
  const snapshot=(await api(`/v1/tabs/${tab.id}/snapshot`)).data;
  await hold();
  if (hasCommitGuard) {
    for (const key of ['Space','Enter']) {
      await refuse({action:'press',selector:'#order',key},/commit_required/);
      await refuse({action:'press',name:'Place order',key},/commit_required/);
    }
    const ref=snapshot.elements.find(el=>el.name==='Place order').ref;
    for (const key of ['Space','Enter']) await refuse({action:'press',ref,key},/commit_required/);
    await refuse({action:'press',selector:'#missing',key:'Space'},/missing/,400);
    await refuse({action:'press',selector:'#order',key:'NoSuchKey'},/Unsupported|Unknown|key/,400);
    await refuse({action:'press',selector:'#offscreen',key:'Space'},/commit_required/);
    await pageWc.executeJavaScript('order.focus()');
    await refuse({action:'press',selector:'#plain',key:'Space'},/commit_required/);
    await refuse({action:'press',selector:'#pretend',key:'Space'},/commit_required/);
    await hold();
    await refuse({action:'press',selector:'#tabstop',key:'Space'},/commit_required/);
    await pageWc.executeJavaScript('order.focus()');
    // A focusable field receives Space even when a purchase button held focus.
    let before=await state();
    let r=await api(`/v1/tabs/${tab.id}/actions`,'POST',{action:'press',selector:'#q',key:'Space',epoch:before.epoch});
    assert.equal(r.status,200,JSON.stringify(r));
    await waitFor(page,p=>p.keys===1);assert.equal((await page()).orders,0);cases++;
    await hold();
    before=await state();
    const receipt=(extra={})=>({nonce:'lead0215-receipt-'+cases+'-'+Date.now(),kind:'purchase',summary:'Local fixture order',issuedAt:Date.now(),tabId:tab.id,epoch:before.epoch,...extra});
    for(const extra of [{tabId:'wrong-tab'},{epoch:before.epoch+1},{issuedAt:Date.now()-120001}])
      await refuse({action:'click',selector:'#order',approval:receipt(extra)},/approval_invalid/);
    const approval=receipt();
    const body=bindApproval({action:'press',name:'Place order',key:'Space',epoch:before.epoch,approval},snapshot);
    r=await api(`/v1/tabs/${tab.id}/actions`,'POST',body);
    assert.equal(r.status,200,JSON.stringify(r));await waitFor(page,p=>p.orders===1);cases++;
    await refuse({...body,epoch:(await state()).epoch},/approval_invalid/);
    assert.equal((await page()).orders,1);
    await hold();before=await state();
    const click=bindApproval({action:'click',name:'Place order',epoch:before.epoch,approval:receipt()},snapshot);
    r=await api(`/v1/tabs/${tab.id}/actions`,'POST',click);
    assert.equal(r.status,200,JSON.stringify(r));await waitFor(page,p=>p.orders===2);cases++;
    await refuse({...click,epoch:(await state()).epoch},/approval_invalid/);
    await hold();before=await state();
    const batch=bindApproval({action:'batch',steps:[{action:'click',name:'Place order'}],epoch:before.epoch,approval:receipt()},snapshot);
    r=await api(`/v1/tabs/${tab.id}/actions`,'POST',batch);
    assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.data.results[0].ok,true,JSON.stringify(r));
    await waitFor(page,p=>p.orders===3);cases++;
    await refuse({...batch,epoch:(await state()).epoch},/approval_invalid/);
    await hold();
    await invoke('navigate',{id:tab.id,url:base+'/captcha'});
    await waitFor(()=>pageWc.executeJavaScript('location.pathname==="/captcha" && document.readyState==="complete"').catch(()=>false),Boolean);
    before=await state();
    const captchaSnapshot=await pageWc.executeJavaScript(require('../src/browser-page.cjs').snapshotExpression());
    await refuse(bindApproval({action:'eval',code:'1',approval:receipt()},captchaSnapshot),/challenge_present|awaiting_human/,409);
    console.log(`PASS: ${cases} combined commit preflight cases (Space/Enter, fallback focus, approval/batch single use, tab/epoch/expiry, CAPTCHA precedence).`);
    await invoke('navigate',{id:tab.id,url:base+'/form'});
    await waitFor(()=>pageWc.executeJavaScript('location.pathname==="/form" && document.readyState==="complete"').catch(()=>false),Boolean);
    await hold();
  } else console.log('SKIP: combined commit guard cases require companion #143.');
  // Document the existing offscreen hit-test fallback, without broadening the
  // focus fix into rollback semantics: ownership returns, epoch advances twice.
  const before=await state();
  const r=await api(`/v1/tabs/${tab.id}/actions`,'POST',{action:'click',selector:'#benign',epoch:before.epoch});
  assert.equal(r.status,400,JSON.stringify(r));assert.match(r.data.error,/covered/);
  const after=await state();assert.equal(after.controller,'human');assert.equal(after.botId,before.botId);assert.equal(after.epoch,before.epoch+2);
  console.log('PASS: offscreen covered-target rollback restores human owner and documents epoch +2.');
  server.close();app.exit(0);
}).catch(error=>{console.error(error.stack);server?.close();app.exit(1);});
