#!/usr/bin/env node
// browser-bench.cjs: realistic web tasks driven the way a model drives the
// browser tools. Each task runs through the shipped MCP server
// (scripts/browser-mcp.cjs) with an emulated agent loop: read the page once,
// act on element refs by name, read only the replies, snapshot again only
// when the controls it needs are not in hand, and batch what it can. Per task
// it records success, tool calls (model round trips), tokens returned to the
// model (reply chars / 4; a screenshot is width*height/750), tool latency and
// tool errors.
//
// Engines:
//   vm    headless Chrome + scripts/vps-browser-host.cjs (the VM browser's code, run locally)
//   app   the desktop app (src/main.cjs) under Electron with a throwaway profile (host tabs)
//   --connection FILE  an already running app or host; --host vm opens its tabs on the VM.
//                      Fixtures need --fixture-host <LAN IP> there; without it only public tasks run.
//
// Usage: node scripts/browser-bench.cjs [--engine vm,app] [--root DIR] [--tasks id,id]
//        [--runs N] [--think MS] [--json FILE] [--no-public]
//        node scripts/browser-bench.cjs --suite api [--connection FILE]   (the older raw-API timing suite)
// --root benches another checkout (a baseline): its MCP server, hosts and app code.
// --think is the pause between reading a reply and acting (default 300ms), standing in for model time.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

// Under Electron this file is the app launcher for the `app` engine: a fresh
// profile, loopback fixtures allowed, the window kept out of the way.
if (process.versions.electron) {
  const { app, BrowserWindow, webContents, session } = require('electron');
  const profile = process.env.HERMES_WORKSPACE_DATA;
  process.env.HERMES_WORKSPACE_PORT = '0';
  process.env.HERMES_WORKSPACE_ALLOW_LOOPBACK = '1';
  fs.writeFileSync(path.join(profile, 'preferences.json'), JSON.stringify({ bots: [{ id: 'bench', name: 'Bench', isBot: true }], selectedBotId: 'bench', preview: false }));
  require(path.join(process.env.BENCH_ROOT, 'src', 'main.cjs'));
  app.whenReady().then(async () => {
    for (let i = 0; i < 200 && !BrowserWindow.getAllWindows().length; i++) await new Promise((r) => setTimeout(r, 50));
    for (const win of BrowserWindow.getAllWindows()) if (win.isVisible()) win.minimize();
    const telegram = webContents.getAllWebContents().find((item) => item.session === session.fromPartition('persist:telegram'));
    if (telegram) { telegram.stop(); telegram.loadURL('about:blank').catch(() => {}); }
  });
  return;
}

function arg(name, fallback) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback; }
const here = path.join(__dirname, '..');
const root = path.resolve(arg('--root', here));
const suite = arg('--suite', 'agent');
const think = Number(arg('--think', 300));
const runs = Number(arg('--runs', 1));
const connectionArg = arg('--connection');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms, what) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) { const v = await fn(); if (v) return v; } throw new Error('timed out waiting for ' + what); };

// ---------------------------------------------------------------- fixtures
const NAV = '<header><nav>' + ['Home', 'Shop', 'Deals', 'Help', 'About', 'Careers', 'Blog', 'Contact', 'Privacy', 'Terms', 'Sitemap', 'Account'].map((n) => `<a href="/${n.toLowerCase()}">${n}</a>`).join(' ') + '</nav></header>';
const page = (title, body, script = '') => `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width"><title>${title}</title>
<style>body{font:16px system-ui;margin:0 24px}nav a{margin-right:8px}button,input,select,textarea{font:inherit;padding:6px 10px;margin:4px}li{margin:6px 0}</style>
${NAV}${body}<script>const report=(k,v)=>fetch('/_r',{method:'POST',body:JSON.stringify({k,v})});${script}</script>`;
const RESULTS = [['Lovelace Bridge, Bristol', 'A footbridge named in 2019.'], ['Ada (programming language)', 'A structured, statically typed language.'], ['Lovelace Medal', 'Awarded by the British Computer Society.'],
  ['Analytical Engine', 'A proposed mechanical general-purpose computer.'], ['Byron family papers', 'Letters and journals, 1798-1860.'], ['Ada Lovelace: Notes on the Analytical Engine', 'Her 1843 notes include the first published algorithm.'],
  ['Lovelace (film)', 'A 2013 biographical drama.'], ['Charles Babbage', 'Mathematician and inventor.'], ['Lovelace Day', 'An annual celebration of women in STEM.'], ['Difference Engine No. 2', 'Built by the Science Museum in 1991.']];
function pages(s) {
  const p = {};
  p['/search'] = page('Archive', `<main><h1>Archive search</h1><form action="/results" role="search"><input name=q aria-label="Search the archive" autocomplete=off><button>Search</button></form>
<ul id=sug role=listbox hidden style="position:absolute;background:#fff;border:1px solid #888;list-style:none;padding:4px"></ul><p>Browse 40,000 documents from the collection.</p></main>`,
  `const q=document.querySelector('[name=q]');q.oninput=()=>{sug.hidden=!q.value;sug.innerHTML=['lovelace','lovelace notes','lovelace bridge'].map(x=>'<li role=option>'+x+'</li>').join('')}`);
  p['/results'] = page('Results', `<main><h1>Results</h1><ol>${RESULTS.map(([t, d], i) => `<li><a href="/doc/${i}">${t}</a><p>${d}</p><a href="/doc/${i}/cite">Cite</a></li>`).join('')}</ol></main>`);
  for (let i = 0; i < RESULTS.length; i++) p['/doc/' + i] = page(RESULTS[i][0], `<main><h1>${RESULTS[i][0]}</h1>${i === 5 ? '<table><tr><th>Born</th><td>10 December 1815, London</td></tr><tr><th>Died</th><td>27 November 1852</td></tr></table>' : ''}<p>${'Archive text. '.repeat(120)}</p></main>`);
  p['/products'] = page('Products', `<main><h1>Compare notebooks</h1><section id=products>${Array.from({ length: 20 }, (_, i) => `<article><h2>Product ${String(i + 1).padStart(2, '0')}</h2><span class=price>$${(12 + i * 0.75).toFixed(2)}</span><p>${'Recycled paper, stitched binding, delivery within five business days. '.repeat(8)}</p></article>`).join('')}</section><button onclick="report('products','ordered')">Place order</button></main>`);
  p['/form'] = page('Contact sales', `<main><h1>Contact sales</h1><form id=f novalidate>
<label>Full name <input name=name required></label><br><label>Work email <input name=email type=email required></label><br><label>Phone <input name=phone type=tel></label><br>
<label>Country <select name=country><option value="">Choose…</option>${['Canada', 'France', 'Germany', 'Japan', 'Portugal', 'United Kingdom', 'United States'].map((c) => `<option>${c}</option>`).join('')}</select></label>
<fieldset><legend>Plan</legend>${['Starter', 'Team', 'Enterprise'].map((x) => `<label><input type=radio name=plan value=${x.toLowerCase()}> ${x}</label>`).join('')}</fieldset>
<label><input type=checkbox name=news> Send me product news</label><br><label>Message <textarea name=msg rows=3></textarea></label><p id=err style="color:#b00"></p><button>Send request</button></form></main>`,
  `f.onsubmit=e=>{e.preventDefault();const d=Object.fromEntries(new FormData(f));d.news=!!f.news.checked;if(!/@/.test(d.email))return err.textContent='Enter a valid email';report('form',d);f.outerHTML='<h2>Thanks, '+d.name+'</h2><p>We will reply to '+d.email+' within a day.</p>'}`);
  p['/dropdown'] = page('Delivery form', `<form id=f><label>Delivery <select name=delivery><option value="std" label="Standard delivery">Internal text</option><option value="exp" selected>Express delivery</option><option value="pickup" disabled>Collect in person</option></select></label><button>Submit</button></form>`,
    `f.onsubmit=e=>{e.preventDefault();report('dropdown','submitted')};f.delivery.onchange=()=>report('dropdown','changed')`);
  p['/feed'] = page('Orders', `<main><h1>Orders</h1><ul id=l style="list-style:none;padding:0"></ul><div id=more>Loading more…</div><p id=out></p></main>`,
  `let n=0;const add=()=>{for(let i=0;i<20&&n<120;i++){n++;const k=n,li=document.createElement('li');li.style.height='44px';li.innerHTML='Order #'+k+' · $'+(17+k*3)+'.00 <button>Open</button>';li.querySelector('button').onclick=()=>{out.textContent='Opened order #'+k;report('feed',k)};l.append(li)}if(n>=120)more.remove()};
new IntersectionObserver(e=>{if(e[0].isIntersecting)setTimeout(add,150)}).observe(more);add();`);
  p['/shop'] = page('Field Notes', `<main><h1>Field Notes Notebook, 3-pack</h1><p>$12.95 · In stock</p><div style="height:42vh"></div><label>Quantity <input name=qty type=number value=1 min=1></label> <button id=add>Add to cart</button><p id=cart>Cart: empty</p></main>
<div id=cookies style="position:fixed;left:0;right:0;bottom:0;height:46vh;background:#222;color:#fff;padding:16px">We use cookies to improve your experience. <button>Reject all</button><button>Accept all</button></div>`,
  `add.onclick=()=>{cart.textContent='Added to cart: '+document.querySelector('[name=qty]').value;report('shop',document.querySelector('[name=qty]').value)};
document.querySelectorAll('#cookies button').forEach(b=>b.onclick=()=>cookies.remove());
setTimeout(()=>{const m=document.createElement('div');m.id='modal';m.style.cssText='position:fixed;inset:0;background:#0008;display:flex;align-items:center;justify-content:center';
m.innerHTML='<div role=dialog aria-modal=true aria-labelledby=mt style="background:#fff;padding:24px"><h2 id=mt>Join our newsletter</h2><input aria-label="Email address"><button>Subscribe</button><button>No thanks</button></div>';
m.querySelectorAll('button')[1].onclick=()=>m.remove();document.body.append(m)},400);`);
  p['/todos'] = page('Todos', `<main><h1>Todos</h1><p id=saved>Saved just now</p><label>Add a task <input id=new aria-label="New todo" placeholder="What needs doing?"></label><ul id=l></ul></main>`,
  `let t=[['Walk dog',0],['Pay rent',0],['Old task',0],['Call mom',0]],s=0;setInterval(()=>{saved.textContent='Saved '+(++s)+'s ago'},300);
const R=()=>{l.innerHTML=t.map(([x,d],i)=>'<li><label><input type=checkbox data-i='+i+(d?' checked':'')+'> '+x+'</label> <button data-d='+i+'>Delete</button></li>').join('');
l.querySelectorAll('input').forEach(c=>c.onchange=()=>{t[c.dataset.i][1]=c.checked?1:0;R()});l.querySelectorAll('button').forEach(b=>b.onclick=()=>{t.splice(b.dataset.d,1);R()});report('todos',t.map(([x,d])=>x+(d?'+':'')).join(','))};
document.getElementById('new').onkeydown=e=>{if(e.key==='Enter'&&e.target.value){t.push([e.target.value,0]);e.target.value='';R()}};R();`);
  p['/vault'] = () => page('Vault', `<main><h1>Vault</h1><button id=g>Reveal access code</button><p>Codes open in a separate window.</p><label>Access code <input id=code></label> <button id=v>Verify</button><p id=o></p></main>`,
  `g.onclick=()=>window.open('/vault/code','_blank');v.onclick=()=>{o.textContent=code.value===${JSON.stringify(s.code)}?'Verified':'Wrong code';report('vault',o.textContent)}`);
  p['/vault/code'] = () => page('Access code', `<main><h1>Your access code</h1><p>Code: <b>${s.code}</b></p></main>`);
  p['/drafts'] = page('Drafts', `<main><h1>Drafts</h1><ul><li>Q3 plan <button id=d>Delete draft</button></li></ul><p id=o>1 draft</p></main>`,
  `d.onclick=()=>{if(confirm('Delete this draft?')){o.textContent='Draft deleted';report('drafts','deleted')}}`);
  p['/home'] = page('Store', `<main><h1>Welcome back</h1><p>New arrivals every week.</p><a href="/orders">Order history</a> <a href="/shop">Shop notebooks</a></main>`);
  p['/login'] = page('Sign in', `<main><h1>Sign in to continue</h1><form><label>Email <input name=email type=email></label><br><label>Password <input name=pw type=password></label><br><button type=button>Sign in</button></form><a href="/forgot">Forgot password?</a> <button type=button>Continue with Google</button></main>`,
  `document.addEventListener('input',()=>report('login','typed'))`);
  p['/checkout'] = () => page('Checkout', `<main><h1>Checkout</h1><iframe src="/checkout/address" title="Shipping address" style="width:520px;height:190px;border:1px solid #888"></iframe>
<iframe src="${s.widget}/widget/delivery" title="Delivery options" style="width:520px;height:150px;border:1px solid #888"></iframe><p><button id=place>Place order</button></p><p id=st></p></main>`,
  `place.onclick=()=>{st.textContent='Order placed';report('placed',true)}`);
  p['/checkout/address'] = `<!doctype html><meta charset=utf-8><body style="font:15px system-ui"><form id=f><label>Street <input name=street></label><label>City <input name=city></label><label>Postcode <input name=zip></label><button>Save address</button></form><p id=o></p>
<script>f.onsubmit=e=>{e.preventDefault();o.textContent='Address saved';fetch('/_r',{method:'POST',body:JSON.stringify({k:'address',v:Object.fromEntries(new FormData(f))})})}</script>`;
  p['/widget/delivery'] = `<!doctype html><meta charset=utf-8><body style="font:15px system-ui"><label style="position:absolute;left:12px;top:12px"><input type=radio name=d value=standard checked> Standard (3-5 days)</label><label style="position:absolute;left:12px;top:44px"><input type=radio name=d value=express> Express (next day)</label><button id=c style="position:absolute;left:12px;top:80px">Confirm delivery</button><p id=o style="position:absolute;left:12px;top:110px"></p>
<script>c.onclick=()=>{const v=document.querySelector('[name=d]:checked').value;o.textContent='Delivery: '+v;fetch(${JSON.stringify(s.main)}+'/_r',{method:'POST',mode:'no-cors',body:JSON.stringify({k:'delivery',v})})}</script>`;
  return p;
}
function startFixtures(bind) {
  const s = { reports: {} };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/_r' && req.method === 'POST') {
      let b = ''; req.on('data', (c) => { b += c; });
      req.on('end', () => { try { const { k, v } = JSON.parse(b); s.reports[k] = v; } catch {} res.end('ok'); });
      return;
    }
    if (u.pathname === '/orders') { res.writeHead(302, { location: '/login?next=/orders' }); return res.end(); }
    const p = s.pages[u.pathname];
    res.setHeader('content-type', 'text/html');
    res.end(typeof p === 'function' ? p() : p || '<!doctype html><title>Not found</title><p>Not found');
  });
  return new Promise((resolve) => server.listen(0, bind, () => {
    s.port = server.address().port;
    resolve({ state: s, reset: () => { s.reports = {}; s.code = 'K' + (100000 + Math.floor(Math.random() * 900000)); }, close: () => server.close() });
  }));
}

// ---------------------------------------------------------------- engines
function findChrome() {
  const globs = (dir, rx) => { try { return fs.readdirSync(dir).filter((n) => rx.test(n)).map((n) => path.join(dir, n)); } catch { return []; } };
  return [process.env.HERMES_TEST_CHROME,
    ...globs(path.join(os.homedir(), '.agent-browser', 'browsers'), /^chrome-/).map((d) => path.join(d, 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')),
    ...globs(path.join(os.homedir(), 'Library/Caches/ms-playwright'), /^chromium-\d+$/).flatMap((d) => globs(d, /^chrome-/).map((e) => path.join(e, 'Chromium.app/Contents/MacOS/Chromium'))),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/google-chrome'].find((f) => f && fs.existsSync(f));
}
const freePort = () => new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const n = s.address().port; s.close(() => r(n)); }); });
async function startEngine(engine) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-bench-'));
  const children = [];
  const stop = async () => { for (const c of children) c.kill(); await sleep(300); try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* a temp dir left behind is harmless */ } };
  if (engine === 'vm') {
    const chrome = findChrome();
    if (!chrome) throw new Error('no Chrome found (set HERMES_TEST_CHROME)');
    const profile = path.join(dir, 'profile');
    children.push(spawn(chrome, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-sandbox', '--host-resolver-rules=MAP *.example 127.0.0.1', 'about:blank'], { stdio: 'ignore' }));
    const portFile = path.join(profile, 'DevToolsActivePort');
    await until(() => fs.existsSync(portFile), 60000, 'Chrome');
    const cdpUrl = `http://127.0.0.1:${fs.readFileSync(portFile, 'utf8').split('\n')[0]}`;
    await until(() => fetch(cdpUrl + '/json/version').then((r) => r.ok, () => false), 60000, 'Chrome CDP');
    const data = path.join(dir, 'data'); fs.mkdirSync(data);
    fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ cdpUrl, port: await freePort() }));
    const env = { ...process.env, HERMES_VPS_BROWSER_DATA: data }; delete env.HERMES_WORKSPACE_ALLOW_LOOPBACK;
    children.push(spawn(process.execPath, [path.join(root, 'scripts/vps-browser-host.cjs'), 'serve'], { env, stdio: 'ignore' }));
    const connFile = path.join(data, 'connection.json');
    await until(() => fs.existsSync(connFile), 60000, 'VM host');
    return { connFile, main: (port) => `http://fixture.example:${port}`, widget: (port) => `http://widget.example:${port}`, bind: '127.0.0.1', stop };
  }
  if (engine === 'app') {
    const electron = require(path.join(here, 'node_modules', 'electron'));
    const env = { ...process.env, HERMES_WORKSPACE_DATA: dir, BENCH_ROOT: root };
    children.push(spawn(electron, [__filename], { env, stdio: 'ignore' }));
    const connFile = path.join(dir, 'connection.json');
    await until(() => fs.existsSync(connFile), 60000, 'app connection.json');
    await until(() => fetch(JSON.parse(fs.readFileSync(connFile, 'utf8')).url + '/v1/status').then(() => true, () => false), 30000, 'app API');
    return { connFile, main: (port) => `http://127.0.0.1:${port}`, widget: (port) => `http://localhost:${port}`, bind: '127.0.0.1', stop };
  }
  const ip = arg('--fixture-host');
  return { connFile: path.resolve(engine), live: true, host: arg('--host'), main: ip && ((port) => `http://${ip}:${port}`), widget: ip && ((port) => `http://${ip}:${port + 1}`), bind: ip ? '0.0.0.0' : '127.0.0.1', stop: async () => {} };
}

// ---------------------------------------------------------------- agent loop
const { Client } = require(path.join(here, 'node_modules/@modelcontextprotocol/sdk/dist/cjs/client/index.js'));
const { StdioClientTransport } = require(path.join(here, 'node_modules/@modelcontextprotocol/sdk/dist/cjs/client/stdio.js'));
async function connectMcp(connFile) {
  const client = new Client({ name: 'browser-bench', version: '1' }, { capabilities: {} });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'scripts/browser-mcp.cjs'), '--bot-id', 'bench', '--connection', connFile] }));
  return client;
}
const isRef = (e) => e && typeof e.ref === 'string';
// What the model holds after each reply: the last full list, patched by deltas.
function merge(known, reply) {
  if (!reply || typeof reply !== 'object') return known;
  if (Array.isArray(reply.elements)) return reply.elements.filter(isRef);
  let out = known;
  if (Array.isArray(reply.removed)) out = out.filter((e) => !reply.removed.includes(e.ref));
  if (Array.isArray(reply.changed)) {
    const byRef = new Map(reply.changed.map((e) => [e.ref, e]));
    out = out.map((e) => byRef.get(e.ref) || e);
    const have = new Set(out.map((e) => e.ref));
    out = out.concat(reply.changed.filter((e) => !have.has(e.ref)));
  }
  return out;
}
class Agent {
  constructor(client, opts) { Object.assign(this, { client, opts, known: [], seen: '', tab: null, stats: { calls: 0, ms: 0, chars: 0, imageBytes: 0, imageTokens: 0, errors: 0, snapshots: 0 }, log: [] }); }
  async call(name, args) {
    if (this.stats.calls) await sleep(think);
    this.stats.calls++;
    const t0 = Date.now();
    const r = await this.client.callTool({ name, arguments: args });
    this.stats.ms += Date.now() - t0;
    let text = '';
    for (const c of r.content || []) {
      if (c.type === 'text') text += c.text;
      else if (c.type === 'image') {
        this.stats.imageBytes += Buffer.from(c.data, 'base64').length;
        this.stats.imageTokens += 1000; // corrected below from the viewport note
      }
    }
    this.stats.chars += text.length;
    let data; try { data = JSON.parse(text); } catch { data = text; }
    if (name === 'cua_alans_way_screenshot' && data && data.viewport) {
      const w = Math.min(960, data.viewport.width), h = Math.round(data.viewport.height * w / data.viewport.width);
      this.stats.imageTokens += Math.round(w * h / 750) - 1000;
    }
    const error = r.isError ? String(text) : Array.isArray(data?.results) ? data.results.find(x => !x.ok)?.error : undefined;
    if (error) this.stats.errors++;
    this.log.push({ name, action: args.action, ms: Date.now() - t0, chars: text.length, error: error?.slice(0, 160) });
    if (r.isError) return { error: String(text) };
    if (!this.tab || !args.tabId || args.tabId === this.tab.id) this.absorb(data);
    return data;
  }
  absorb(data) {
    if (!data || typeof data !== 'object') return;
    this.known = merge(this.known, data);
    if (Number.isInteger(data.generation)) this.generation = data.generation;
    this.lastControls = Array.isArray(data.elements) || Array.isArray(data.changed);
    // A page reply says what covers the page (overlays) whenever it is there.
    if ('generation' in data || 'effect' in data) this.overlays = Array.isArray(data.overlays) ? data.overlays : [];
    for (const t of [data.text, data.effect && data.effect.text, ...(Array.isArray(data.results) ? data.results.map((x) => x && x.text) : [])]) if (typeof t === 'string' && t) this.seen += '\n' + t;
    if (data.continuedEpoch) this.tab.epoch = data.continuedEpoch;
    if (Number.isInteger(data.epoch) && this.tab && data.id === this.tab.id) this.tab.epoch = data.epoch;
    if (data.observation) this.absorb(data.observation);
  }
  async open(url) {
    const r = await this.call('cua_alans_way_open', { url, ...(this.opts.host ? { host: this.opts.host } : {}), ...(this.opts.openSnapshot ? { snapshot: true } : {}) });
    if (r.error) throw new Error(r.error);
    this.tab = { id: r.id, epoch: r.epoch };
    return r;
  }
  async snapshot(extra = {}) {
    this.stats.snapshots++;
    const r = await this.call('cua_alans_way_snapshot', { tabId: this.tab.id, ...extra });
    if (r && r.text) this.seen += '\n' + r.text;
    return r;
  }
  // A model passes what the schema asks for: the generation it holds, where the tool takes one.
  act(body) { return this.call('cua_alans_way_action', { tabId: this.tab.id, epoch: this.tab.epoch, ...(this.opts.generation && Number.isInteger(this.generation) ? { generation: this.generation } : {}), ...body }); }
  async review(body) {
    if (!this.opts.fixtureApproval) throw new Error('Approval simulation is limited to a disposable fixture.');
    const snapshot = await this.snapshot();
    if (new URL(snapshot.url).origin !== this.opts.fixtureApproval) throw new Error('Approval simulation left the disposable fixture.');
    const { harnessApproval, bindApproval } = require('../test/approval-fixture.cjs');
    const reviewed = { ...body, approval: harnessApproval(this.tab) };
    bindApproval(reviewed, snapshot);
    return this.act(reviewed);
  }
  find(rx, role) { return this.known.find((e) => rx.test([e.name, e.row].filter(Boolean).join(' ')) && (!role || role.test(e.role) || role.test(e.type || ''))); }
  // The model looks in what it holds, then reads the page, then reads more of it.
  async need(rx, role) {
    let hit = this.find(rx, role);
    if (hit) return hit.ref;
    let snap = await this.snapshot();
    hit = this.find(rx, role);
    if (!hit && snap && snap.truncated && snap.truncated.elements) { await this.snapshot({ maxElements: 300 }); hit = this.find(rx, role); }
    if (!hit) throw new Error(`no control ${rx} in ${this.known.length} elements`);
    return hit.ref;
  }
  // Plans steps whose targets are known into one batch; a step whose target
  // is missing, or a failed step, ends the batch and is re-planned from fresh
  // state. Steps are { action, target: [rx, role?], ...body }.
  async run(steps, rounds = 4) {
    let i = 0;
    for (let round = 0; round < rounds && i < steps.length; round++) {
      const batch = [];
      for (let j = i; j < steps.length; j++) {
        const { target, after, named, ...body } = steps[j];
        // A control the task names needs no snapshot where the tool takes names.
        if (named && this.opts.names && !this.namesFailed && !(target && this.find(target[0], target[1]))) {
          batch.push({ ...body, name: named[0], ...(named[1] ? { role: named[1] } : {}), ...(named[2] ? { row: named[2] } : {}) });
          continue;
        }
        if (after) {
          // "the Delete in the Old task row": the first match after the anchor, in page order.
          let at = this.known.findIndex((e) => after.test(e.name || ''));
          if (at < 0 && !batch.length) { await this.snapshot(); at = this.known.findIndex((e) => after.test(e.name || '')); }
          const hit = at < 0 ? null : this.known.slice(at + 1).find((e) => target[0].test(e.name || ''));
          if (!hit) break;
          body.ref = hit.ref;
          batch.push(body);
          continue;
        }
        if (target) {
          let hit = this.find(target[0], target[1]);
          if (!hit && !batch.length) { await this.need(target[0], target[1]); hit = this.find(target[0], target[1]); }
          if (!hit) break;
          body.ref = hit.ref;
        }
        batch.push(body);
      }
      // Close what the page says covers it, in the same call, before acting under it.
      const closes = (this.overlays || []).filter((o) => o.close).map((o) => ({ action: 'click', ref: o.close }));
      this.overlays = [];
      batch.unshift(...closes);
      const r = batch.length === 1 ? await this.act(batch[0]) : await this.act({ action: 'batch', steps: batch });
      const done = (r.error ? 0 : Array.isArray(r.results) ? r.results.filter((x) => x.ok).length : 1) - closes.length;
      i += Math.max(0, done);
      if (done < batch.length - closes.length) {
        const why = r.error || (r.results.find((x) => !x.ok) || {}).error || '';
        this.lastError = why;
        // A covering dialog or banner is closed first, the way a person would.
        if (/commit_required/.test(why) && this.opts.fixtureApproval) {
          const approved = await this.review(batch[Math.max(0, done) + closes.length]);
          if (approved.error || approved.results?.some(x => !x.ok)) throw new Error(approved.error || 'Approved fixture action failed.');
          i++;
        }
        else if (/covered by/.test(why)) await this.dismissBlocker(why);
        else if (/No visible control is named|controls match/.test(why)) {
          this.namesFailed = true;
          // A single close match is the one the model meant: it acts on that ref next.
          const near = /Close matches: (e\d+) "([^"]*)"\. /.exec(why);
          if (near) this.known = [...this.known, { ref: near[1], name: near[2] }];
        }
        else if (!/stale|unknown ref|missing|not found/i.test(why)) throw new Error(why);
        else if (round > 0) await this.snapshot();
      }
    }
    if (i < steps.length) throw new Error('steps left after retries: ' + (this.lastError || ''));
  }
  async dismissBlocker(why) {
    const named = /click (e\d+) \(/.exec(why);
    if (named) { const r = await this.act({ action: 'click', ref: named[1] }); if (!r.error) return; }
    const words = [/^(no thanks|close|dismiss|not now|×)$/i, /^(reject all|accept all|got it)$/i];
    if (!this.dismissed) this.dismissed = new Set();
    const pick = () => this.known.find((e) => words[0].test(e.name || '') && !this.dismissed.has(e.ref)) || this.known.find((e) => words[1].test(e.name || '') && !this.dismissed.has(e.ref));
    if (!pick()) await this.snapshot();
    const hit = pick();
    if (!hit) throw new Error('nothing to dismiss: ' + why);
    this.dismissed.add(hit.ref);
    await this.act({ action: 'click', ref: hit.ref });
  }
  async answer(rx, maxChars = 2000) {
    let m = rx.exec(this.seen);
    if (m) return m[0];
    await this.act({ action: 'read', maxChars });
    m = rx.exec(this.seen);
    return m ? m[0] : '';
  }
}

// ---------------------------------------------------------------- tasks
const tasks = [
  { id: 'product-prices', what: 'compare prices of the items in a product grid', fixture: true,
    async run(a, fx) {
      await a.open(fx.url('/products'));
      if (a.opts.listRead) return JSON.stringify((await a.act({ action: 'read', selector: '#products', maxChars: 20000,
        list: { selector: 'article', fields: { title: { type: 'text', selector: 'h2' }, price: { type: 'text', selector: '.price' } } } })).items);
      const reply = await a.act({ action: 'read', maxChars: 20000 });
      return JSON.stringify([...reply.text.matchAll(/Product (\d{2})\s*\$(\d+\.\d{2})/g)].map(m => ({ title: 'Product ' + m[1], price: '$' + m[2] })));
    },
    check: (fx, ans) => !fx.reports.products && ans === JSON.stringify(Array.from({ length: 20 }, (_, i) => ({ title: 'Product ' + String(i + 1).padStart(2, '0'), price: '$' + (12 + i * 0.75).toFixed(2) }))) },
  { id: 'list-results', what: 'list the top 10 results and their links', fixture: true,
    async run(a, fx) {
      await a.open(fx.url('/results'));
      return JSON.stringify((await a.act({ action: 'read', selector: 'main ol', list: { selector: 'li', maxItems: 10,
        fields: { title: { type: 'text', selector: 'a' }, url: { type: 'href', selector: 'a' } } } })).items);
    },
    check: (fx, ans) => ans === JSON.stringify(RESULTS.map(([title], i) => ({ title, url: fx.url('/doc/' + i) }))) },
  { id: 'pub-list-results', what: 'list the top 10 book results and their links', public: true,
    async run(a) {
      await a.open('https://books.toscrape.com/');
      return JSON.stringify((await a.act({ action: 'read', maxChars: 6000, list: { selector: '.product_pod', maxItems: 10,
        fields: { title: { type: 'text', selector: 'h3 a' }, url: { type: 'href', selector: 'h3 a' } } } })).items);
    },
    check: async (fx, ans) => {
      const html = await (await fetch('https://books.toscrape.com/')).text();
      const decode = text => text.replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"');
      const expected = [...html.matchAll(/<h3><a href="([^"]+)"[^>]*>([^<]+)<\/a><\/h3>/g)].slice(0, 10).map(m => ({ title: decode(m[2]), url: new URL(decode(m[1]), 'https://books.toscrape.com/').href }));
      return expected.length === 10 && ans === JSON.stringify(expected);
    } },
  { id: 'dropdown-options', what: 'find a form dropdown and report its labels, values and selected state without changing it', fixture: true,
    async run(a, fx) {
      await a.open(fx.url('/dropdown'));
      if (!a.find(/^Delivery/)) await a.snapshot();
      return JSON.stringify(a.find(/^Delivery/)?.options || []);
    },
    check: (fx, ans) => !fx.reports.dropdown && ans === JSON.stringify([
      { label: 'Standard delivery', value: 'std', selected: false },
      { label: 'Express delivery', value: 'exp', selected: true },
      { label: 'Collect in person', value: 'pickup', selected: false, disabled: true },
    ]) },
  { id: 'search-open', what: 'search, open the 6th result, read a fact', fixture: true,
    async run(a, fx) {
      await a.open(fx.url('/search'));
      await a.run([{ action: 'type', target: [/search the archive/i], named: ['search', 'textbox'], text: 'lovelace' }, { action: 'press', key: 'Enter' }]);
      await a.run([{ action: 'click', target: [/^Ada Lovelace: Notes/] }]);
      return a.answer(/10 December 1815/);
    },
    check: (fx, ans) => /10 December 1815/.test(ans) },
  { id: 'form-multifield', what: 'fill 7 controls of 5 kinds and submit', fixture: true,
    async run(a, fx) {
      await a.open(fx.url('/form'));
      await a.run([{ action: 'type', target: [/^full name/i], text: 'Ada Lovelace' }, { action: 'type', target: [/^work email/i], text: 'ada@example.com' },
        { action: 'type', target: [/^phone/i], text: '+44 20 7946 0000' }, { action: 'select', target: [/^country/i], label: 'United Kingdom' },
        { action: 'click', target: [/^team/i] }, { action: 'click', target: [/product news/i] }, { action: 'type', target: [/^message/i], text: 'Quote for 12 seats' },
        { action: 'click', target: [/^send request/i] }]);
      return a.answer(/Thanks, Ada Lovelace/);
    },
    check: (fx) => JSON.stringify(fx.reports.form) === JSON.stringify({ name: 'Ada Lovelace', email: 'ada@example.com', phone: '+44 20 7946 0000', country: 'United Kingdom', plan: 'team', news: true, msg: 'Quote for 12 seats' }) },
  { id: 'infinite-list', what: 'scroll a lazy list to order #87 and open it', fixture: true,
    async run(a, fx) {
      await a.open(fx.url('/feed'));
      if (!a.lastControls) await a.snapshot();
      for (let i = 0; i < 12; i++) {
        const row = a.find(/order #87\b/i, /button/);
        if (row) { await a.act({ action: 'click', ref: row.ref }); break; }
        // No ref names the row: a model counts rows in the text, or locates it by script.
        if (/Order #87 /.test(a.seen) && i > 0) {
          const at = await a.act({ action: 'eval', code: '(()=>{const li=[...document.querySelectorAll("li")].find(l=>l.textContent.startsWith("Order #87 "));if(!li)return null;const b=li.querySelector("button");b.scrollIntoView({block:"center"});const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()' });
          if (at.value) { await a.act({ action: 'click', x: at.value.x, y: at.value.y }); break; }
        }
        await a.act({ action: 'scroll', y: 2500 });
        if (!a.find(/order #87\b/i, /button/) && !/Order #87 /.test(a.seen) && !a.lastControls) await a.act({ action: 'read', maxChars: 4000 });
      }
      return a.answer(/Opened order #\d+/);
    },
    check: (fx) => fx.reports.feed === 87 },
  { id: 'cookie-modal', what: 'add to cart past a newsletter modal and a cookie banner', fixture: true,
    async run(a, fx) {
      await a.open(fx.url('/shop'));
      await sleep(500);
      await a.run([{ action: 'click', target: [/^add to cart/i] }], 6);
      return a.answer(/Added to cart: \d+/);
    },
    check: (fx) => fx.reports.shop === '1' },
  { id: 'spa-rerender', what: 'add, tick two and delete one todo in a list that re-renders', fixture: true,
    async run(a, fx) {
      await a.open(fx.url('/todos'));
      // Every Delete reads the same; the model takes the one after "Old task" in page order.
      const del = (name) => ({ action: 'click', target: [/^Delete/, /button/], after: new RegExp('^' + name) });
      await a.run([{ action: 'type', target: [/new todo/i], named: ['new todo'], text: 'Buy milk' }, { action: 'press', target: [/new todo/i], key: 'Enter' },
        { action: 'click', target: [/^walk dog/i, /input|checkbox/], named: ['walk dog', 'checkbox'] }, { action: 'click', target: [/^pay rent/i, /input|checkbox/], named: ['pay rent', 'checkbox'] },
        { ...del('Old task'), named: ['delete', 'button', 'old task'] }], 6);
      return 'done';
    },
    check: (fx) => fx.reports.todos === 'Walk dog+,Pay rent+,Call mom,Buy milk' },
  { id: 'popup-tab', what: 'read a code from a pop-up tab, enter it in the first tab', fixture: true,
    async run(a, fx) {
      await a.open(fx.url('/vault'));
      const r = await a.call('cua_alans_way_action', { tabId: a.tab.id, epoch: a.tab.epoch, ...(a.opts.names ? { name: 'Reveal access code' } : { ref: await a.need(/^reveal access code/i) }), action: 'click' });
      let popup = r.opened && r.opened[0] && r.opened[0].tabId;
      if (!popup) {
        // Nothing in the reply says where the pop-up went: list the tabs.
        const tabs = await a.call('cua_alans_way_tabs', {});
        popup = (Array.isArray(tabs) ? tabs : tabs.tabs).find((t) => /vault\/code/.test(t.url || '')).id;
      }
      const code = /Code: (K\d+)/.exec((await a.call('cua_alans_way_snapshot', { tabId: popup, maxElements: 0 })).text)[1];
      await a.run([{ action: 'type', target: [/^access code/i], text: code }, { action: 'click', target: [/^verify/i], named: ['verify'] }]);
      return a.answer(/Verified|Wrong code/);
    },
    check: (fx, ans) => ans === 'Verified' && fx.reports.vault === 'Verified' },
  { id: 'confirm-dialog', what: 'delete a draft behind a confirm dialog', fixture: true,
    async run(a, fx) {
      await a.open(fx.url('/drafts'));
      const click = async (extra = {}) => {
        const body = { action: 'click', ...(a.opts.names ? { name: 'Delete draft' } : { ref: await a.need(/^delete draft/i) }), ...extra };
        const reply = await a.act(body);
        return /commit_required/.test(reply.error || '') ? a.review(body) : reply;
      };
      const r = await click();
      const note = (r.dialogs || []).map((d) => d.note || '').join(' ');
      // The reply says how to accept: repeat with dialog, or override confirm by eval first.
      if (/dialog: \{accept/.test(note)) await click({ dialog: { accept: true } });
      else if (/eval window\.confirm/.test(note)) { await a.act({ action: 'eval', code: 'window.confirm=()=>true;1' }); await click(); }
      return a.answer(/Draft deleted/);
    },
    check: (fx, ans) => fx.reports.drafts === 'deleted' && /Draft deleted/.test(ans) },
  { id: 'login-wall', what: 'reach order history, stop at the sign-in page and hand back', fixture: true,
    async run(a, fx) {
      await a.open(fx.url('/home'));
      await a.run([{ action: 'click', target: [/^order history/i], named: ['order history'] }]);
      const wall = a.known.some((e) => e.type === 'password') || /sign in/i.test(a.seen);
      if (!wall) return 'no wall seen';
      await a.act({ action: 'release' });
      return 'handed back';
    },
    check: (fx, ans) => ans === 'handed back' && !fx.reports.login },
  { id: 'iframes', what: 'fill a same-origin iframe, pick in a cross-site iframe, place order', fixture: true,
    async run(a, fx) {
      await a.open(fx.url('/checkout'));
      await a.run([{ action: 'type', target: [/^street/i], text: '1 Main St' }, { action: 'type', target: [/^city/i], text: 'Bristol' },
        { action: 'type', target: [/^postcode/i], text: 'BS1 4DJ' }, { action: 'click', target: [/^save address/i] }]);
      if (a.find(/^express/i)) await a.run([{ action: 'click', target: [/^express/i] }, { action: 'click', target: [/^confirm delivery/i] }]);
      else {
        // The frame cannot be read: look at it and click by coordinates (the
        // widget's layout is fixed, standing in for what a vision step reads).
        await a.call('cua_alans_way_screenshot', { tabId: a.tab.id });
        const located = await a.act({ action: 'eval', code: '(()=>{const f=document.querySelector("iframe[title=\\"Delivery options\\"]");f.scrollIntoView({block:"center"});const r=f.getBoundingClientRect();return {x:r.x,y:r.y}})()' });
        if (located.error) throw new Error(located.error);
        const box = located.value;
        await a.act({ action: 'click', x: box.x + 21, y: box.y + 56 });
        await a.act({ action: 'click', x: box.x + 60, y: box.y + 95 });
      }
      await a.run([{ action: 'click', target: [/^place order/i] }]);
      return 'done';
    },
    check: (fx) => fx.reports.delivery === 'express' && fx.reports.placed === true && fx.reports.address?.city === 'Bristol' },
  { id: 'pub-wiki-link', what: 'Wikipedia: follow the Charles Babbage link from Ada Lovelace', public: true,
    async run(a) {
      await a.open('https://en.wikipedia.org/wiki/Ada_Lovelace');
      const ref = await a.need(/^Charles Babbage$/, /^a$|link/);
      const reply = await a.act({ action: 'click', ref });
      if (reply.error) throw new Error(reply.error);
      return reply.effect?.navigated === true ? reply.effect.url : '';
    },
    check: (fx, ans) => ans === 'https://en.wikipedia.org/wiki/Charles_Babbage' && fx.lastUrl === ans },
  { id: 'pub-wiki-search', what: 'Wikipedia: search, open a result, read a date', public: true,
    async run(a) {
      await a.open('https://en.wikipedia.org/w/index.php?title=Special:Search&fulltext=1&search=');
      await a.run([{ action: 'type', target: [/^search wikipedia|^search$/i, /input|searchbox|combobox/], text: 'Grace Hopper COBOL admiral' }, { action: 'press', key: 'Enter' }]);
      await a.run([{ action: 'click', target: [/^Grace Hopper$/, /^a$|link/] }]);
      return a.answer(/(December 9, 1906|9 December 1906)/, 4000);
    },
    check: (fx, ans) => /1906/.test(ans) },
  { id: 'pub-books-next', what: 'books.toscrape: Next twice, read the 5th title', public: true,
    async run(a) {
      await a.open('https://books.toscrape.com/');
      await a.run([{ action: 'click', target: [/^next$/i], named: ['next', 'link'] }, { action: 'click', target: [/^next$/i], named: ['next', 'link'] }]);
      if (!a.known.some((e) => /catalogue\/[^/]+\/index\.html$/.test(e.href || ''))) await a.snapshot();
      const books = a.known.filter((e) => /catalogue\/[^/]+\/index\.html$/.test(e.href || '') && e.name && !/^\s*$/.test(e.name));
      const titles = [...new Set(books.map((e) => e.href))];
      const fifth = books.find((e) => e.href === titles[4]);
      return fifth ? fifth.name : '';
    },
    check: async (fx, ans) => {
      const html = await (await fetch('https://books.toscrape.com/catalogue/page-3.html')).text();
      const want = ([...html.matchAll(/<h3><a [^>]*title="([^"]+)"/g)][4] || [])[1] || '';
      return !!want && ans === want.replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"');
    } },
  { id: 'pub-selenium-form', what: 'selenium.dev web form: 4 controls and submit', public: true,
    async run(a) {
      await a.open('https://www.selenium.dev/selenium/web/web-form.html');
      await a.run([{ action: 'type', target: [/^text input/i], text: 'Bench Run' }, { action: 'type', target: [/^password/i], text: 's3cret' },
        { action: 'type', target: [/^textarea/i], text: 'hello there' }, { action: 'select', target: [/^dropdown \(select\)/i], label: 'Two' }, { action: 'click', target: [/^submit/i] }]);
      return a.answer(/Received!|Form submitted/);
    },
    check: (fx, ans) => /Received|submitted/.test(ans) },
];

// ---------------------------------------------------------------- run
async function runAgentSuite() {
  const engines = connectionArg ? [connectionArg] : arg('--engine', 'vm,app').split(',');
  const picked = arg('--tasks') ? tasks.filter((t) => arg('--tasks').split(',').includes(t.id)) : tasks.filter((t) => !t.public || !process.argv.includes('--no-public'));
  const rows = [];
  for (const engine of engines) {
    const eng = await startEngine(engine);
    const fixtures = await startFixtures(eng.bind);
    const fx = fixtures.state;
    if (eng.main) { fx.main = eng.main(fx.port); fx.widget = eng.widget(fx.port); }
    fx.pages = pages(fx);
    fx.url = (p) => fx.main + p;
    // A second listener for the cross-site frame when fixtures are addressed by IP.
    let widgetServer;
    if (eng.live && eng.main) widgetServer = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(fx.pages[new URL(req.url, 'http://x').pathname] || ''); }).listen(fx.port + 1, eng.bind);
    const conn = JSON.parse(fs.readFileSync(eng.connFile, 'utf8'));
    const raw = (route, method = 'GET', epoch) => fetch(conn.url + route, { method, headers: { Authorization: `Bearer ${conn.token}`, 'X-Hermes-Bot': 'bench', ...(epoch != null ? { 'X-Control-Epoch': String(epoch) } : {}) } }).then((r) => r.json().catch(() => ({})));
    const closeAll = async () => { const t = await raw('/v1/tabs'); for (const x of Array.isArray(t) ? t : t.tabs || []) await raw(`/v1/tabs/${x.id}`, 'DELETE', x.epoch).catch(() => {}); };
    const client = await connectMcp(eng.connFile);
    const browserTools = (await client.listTools()).tools.filter((t) => t.name.startsWith('cua_'));
    const toolsSize = JSON.stringify(browserTools).length;
    const actionProps = browserTools.find((t) => t.name === 'cua_alans_way_action')?.inputSchema?.properties || {};
    const openSnapshot = !!browserTools.find((t) => t.name === 'cua_alans_way_open')?.inputSchema?.properties?.snapshot;
    const label = engine.length > 12 ? 'live' + (eng.host ? ':' + eng.host : '') : engine;
    try {
      for (const task of picked) {
        if (task.fixture && !eng.main) continue;
        for (let run = 0; run < runs; run++) {
          fixtures.reset(); await closeAll();
          const a = new Agent(client, { host: eng.host, generation: !!actionProps.generation, names: !!actionProps.name, listRead: !!actionProps.list, openSnapshot,
            fixtureApproval: task.fixture && !eng.live ? new URL(fx.main).origin : null });
          const t0 = Date.now();
          let ans = '', err = '';
          try { ans = String(await task.run(a, fx) || ''); } catch (e) { err = e.message; }
          const wall = Date.now() - t0;
          await sleep(300);
          const tabs = await raw('/v1/tabs');
          fx.lastUrl = ((Array.isArray(tabs) ? tabs : tabs.tabs || [])[0] || {}).url;
          const ok = !err && !!(await task.check(fx, ans));
          rows.push({ engine: label, task: task.id, run, ok, calls: a.stats.calls, snapshots: a.stats.snapshots, errors: a.stats.errors, chars: a.stats.chars, imageBytes: a.stats.imageBytes, tokens: Math.round(a.stats.chars / 4) + a.stats.imageTokens, imageTokens: a.stats.imageTokens, toolMs: a.stats.ms, wallMs: wall, answer: ans.slice(0, 80), err: err.slice(0, 300), log: a.log });
          const r = rows.at(-1);
          console.log(`${label.padEnd(8)} ${task.id.padEnd(18)} ${ok ? 'PASS' : 'FAIL'} calls=${r.calls} snap=${r.snapshots} err=${r.errors} tok=${r.tokens} toolMs=${r.toolMs}${ok ? '' : ' :: ' + (err || ans)}`);
        }
      }
    } finally {
      await closeAll().catch(() => {});
      await client.close().catch(() => {});
      widgetServer?.close(); fixtures.close(); await eng.stop();
    }
    rows.push({ engine: label, toolsSize });
  }
  const med = (xs) => { const s = [...xs].sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) / 2)] : 0; };
  console.log('\n| Engine | Task | Pass | Calls | Snapshots | Errors | Tokens | Tool ms |\n|---|---|---|---|---|---|---|---|');
  const keyed = new Map();
  for (const r of rows.filter((x) => x.task)) { const k = r.engine + '|' + r.task; keyed.set(k, [...(keyed.get(k) || []), r]); }
  const totals = new Map();
  for (const [k, rs] of keyed) {
    const [engine, task] = k.split('|');
    const line = { pass: rs.filter((r) => r.ok).length, n: rs.length, calls: med(rs.map((r) => r.calls)), snaps: med(rs.map((r) => r.snapshots)), errors: med(rs.map((r) => r.errors)), tokens: med(rs.map((r) => r.tokens)), ms: med(rs.map((r) => r.toolMs)) };
    console.log(`| ${engine} | ${task} | ${line.pass}/${line.n} | ${line.calls} | ${line.snaps} | ${line.errors} | ${line.tokens} | ${line.ms} |`);
    const t = totals.get(engine) || { pass: 0, n: 0, calls: 0, snaps: 0, errors: 0, tokens: 0, ms: 0 };
    for (const key of Object.keys(t)) t[key] += line[key];
    totals.set(engine, t);
  }
  for (const [engine, t] of totals) console.log(`| ${engine} | **Total** | **${t.pass}/${t.n}** | **${t.calls}** | **${t.snaps}** | **${t.errors}** | **${t.tokens}** | **${t.ms}** |`);
  for (const r of rows.filter((x) => x.toolsSize)) console.log(`${r.engine}: browser tool definitions ${r.toolsSize} chars (~${Math.round(r.toolsSize / 4)} tokens per turn)`);
  if (arg('--json')) fs.writeFileSync(arg('--json'), JSON.stringify(rows, null, 1));
  process.exit(rows.some((r) => r.task && !r.ok) ? 1 : 0);
}

// ---------------------------------------------------------------- api suite
// The older suite: raw API timing, per action vs batched, against a running app.
async function runApiSuite() {
  const connPath = connectionArg || process.env.HERMES_WORKSPACE_CONNECTION || path.join(os.homedir(), 'Library', 'Application Support', 'Hermes Workspace', 'connection.json');
  const connection = JSON.parse(fs.readFileSync(connPath, 'utf8'));
  let calls = 0, chars = 0;
  async function api(endpoint, method = 'GET', body, extra = {}) {
    calls++;
    const r = await fetch(new URL(endpoint, connection.url), { method, headers: { Authorization: `Bearer ${connection.token}`, 'X-Hermes-Bot': 'bench', 'Content-Type': 'application/json', ...extra }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    chars += text.length;
    let data = {}; try { data = JSON.parse(text); } catch { /* counted, not parsed */ }
    return { status: r.status, ...data };
  }
  const act = (id, epoch, body) => api(`/v1/tabs/${id}/actions`, 'POST', { ...body, epoch });
  const FORM = () => [{ action: 'navigate', url: 'https://httpbin.org/forms/post' }, { action: 'wait', selector: 'input[name=custname]', timeout: 10000 },
    { action: 'type', selector: 'input[name=custname]', text: 'Ada Lovelace' }, { action: 'type', selector: 'textarea[name=comments]', text: 'first programmer' },
    { action: 'eval', code: '({name:document.querySelector("[name=custname]")?.value, comments:document.querySelector("[name=comments]")?.value})' }];
  const verify = (v) => v && v.name === 'Ada Lovelace' && v.comments === 'first programmer';
  const flows = [
    { name: 'form fill + readback', steps: FORM, ok: (r) => verify(r.value) },
    { name: 'navigate + extract', steps: () => [{ action: 'navigate', url: 'https://httpbin.org/html' }, { action: 'eval', code: 'document.querySelector("h1")?.textContent' }], ok: (r) => r.value === 'Herman Melville - Moby-Dick' },
    { name: 'multi-step wait chain', steps: () => [{ action: 'navigate', url: 'https://httpbin.org/links/200/0' }, { action: 'click', selector: 'a' }, { action: 'wait', url: '/links/200/1', timeout: 8000 }, { action: 'eval', code: 'location.pathname' }], ok: (r) => r.value === '/links/200/1' },
    { name: 'viewport + responsive check', steps: () => [{ action: 'navigate', url: 'https://example.com' }, { action: 'viewport', width: 1440, height: 900 }, { action: 'eval', code: 'innerWidth' }], ok: (r) => r.value === 1440 },
  ];
  const rows = [];
  for (const flow of flows) for (const mode of ['per-action', 'batch']) {
    const tab = await api('/v1/tabs', 'POST', { url: 'about:blank', background: true });
    calls = 0; chars = 0;
    const t0 = Date.now();
    let last;
    if (mode === 'batch') { const r = await act(tab.id, tab.epoch, { action: 'batch', steps: flow.steps() }); last = r.results?.at(-1) || {}; }
    else for (const step of flow.steps()) { last = await act(tab.id, tab.epoch, step); if (last.error) break; }
    rows.push({ task: flow.name, mode, ok: !!flow.ok(last || {}), ms: Date.now() - t0, calls, tokens: Math.round(chars / 4) });
    const fresh = await api(`/v1/tabs/${tab.id}`);
    await api(`/v1/tabs/${tab.id}`, 'DELETE', undefined, { 'x-control-epoch': String(fresh.epoch ?? tab.epoch) });
  }
  console.log('\n  task                         mode        ok   calls    wall   tokens');
  for (const r of rows) console.log(`  ${r.task.padEnd(28)} ${r.mode.padEnd(11)} ${r.ok ? 'PASS' : 'FAIL'}  ${String(r.calls).padStart(5)}  ${String(r.ms).padStart(6)}ms ${String(r.tokens).padStart(7)}`);
  process.exit(rows.some((r) => !r.ok) ? 1 : 0);
}

(suite === 'api' ? runApiSuite() : runAgentSuite()).catch((e) => { console.error('bench failed:', e.stack || e.message); process.exit(1); });
