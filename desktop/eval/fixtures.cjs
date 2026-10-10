// Local fixture pages for the held-out eval. Pages report outcomes to the
// server (POST /_r), so success checks never depend on the agent's own words.
const http = require('node:http');

const rnd = (n) => Math.floor(Math.random() * n);
const COUNTRIES = ['Argentina', 'Australia', 'Belgium', 'Brazil', 'Canada', 'Chile', 'China', 'Denmark', 'Egypt', 'Finland', 'France', 'Germany', 'Ghana', 'Greece', 'Hungary', 'Iceland', 'India', 'Ireland', 'Italy', 'Japan', 'Kenya', 'Mexico', 'Morocco', 'Nepal', 'Netherlands', 'Norway', 'Peru', 'Poland', 'Portugal', 'Romania', 'Spain', 'Sweden', 'Switzerland', 'Turkey', 'Uganda', 'Ukraine', 'Uruguay', 'Vietnam', 'Zambia', 'Zimbabwe'];
const COLORS = ['red', 'green', 'blue', 'orange', 'purple'];

const page = (title, body, script = '') => `<!doctype html><meta charset=utf-8><title>${title}</title>
<style>body{font:16px system-ui;margin:24px}button,input,select{font:inherit;padding:6px 10px;margin:4px}.err{color:#b00}</style>
${body}<script>const report=(k,v)=>fetch('/_r',{method:'POST',body:JSON.stringify({k,v})});${script}</script>`;

function build(s) {
  const pages = {};
  pages['/f/shadow'] = page('Radio room', `<h1>Radio room</h1><x-card></x-card>`, `
customElements.define('x-field', class extends HTMLElement { constructor(){ super(); const r=this.attachShadow({mode:'open'}); r.innerHTML='<label>Callsign <input aria-label="Callsign"></label>'; } get value(){ return this.shadowRoot.querySelector('input').value; } });
customElements.define('x-card', class extends HTMLElement { constructor(){ super(); const r=this.attachShadow({mode:'open'}); r.innerHTML='<section><h2>Transmit panel</h2><x-field></x-field><button>Transmit</button><p id=st>idle</p></section>';
  r.querySelector('button').onclick=()=>{ const v=r.querySelector('x-field').value; r.getElementById('st').textContent='sent '+v; report('shadow',{callsign:v}); }; } });`);

  pages['/f/iframe'] = page('Checkout', `<h1>Checkout</h1><p>Banner promo (display only)</p><input aria-label="Coupon code" disabled value="BANNER"><button disabled>Apply</button>
<iframe src="/f/iframe-inner" title="Coupon form" style="width:420px;height:160px;border:1px solid #888"></iframe>`);
  pages['/f/iframe-inner'] = page('Coupon form', `<form id=f><label>Coupon code <input name=c aria-label="Coupon code"></label><button>Apply</button></form><p id=o></p>`,
    `f.onsubmit=e=>{e.preventDefault();o.textContent='Applied '+f.c.value;report('iframe',{code:f.c.value,source:'inner'})}`);

  pages['/f/dialogs'] = page('Cleanup', `<button id=run>Run cleanup</button><p id=out>not run</p>`,
    `run.onclick=()=>{alert('Cleanup will start');const ok=confirm('Delete the scratch files?');const name=ok?prompt('Name this run','run'):null;out.textContent='ok='+ok+' name='+name;report('dialogs',{confirm:ok,prompt:name})}`);

  pages['/f/download'] = page('Reports', `<h1>Reports</h1><p>Q3 report</p><a href="/f/report.csv" download="q3-report.csv">Download Q3 report</a>`);

  pages['/f/newtab'] = page('Vault', `<h1>Vault</h1><button id=g>Reveal access code</button><p>Codes open in a separate window.</p>
<label>Access code <input id=code aria-label="Access code"></label><button id=v>Verify</button><p id=o></p>`,
    `g.onclick=()=>window.open('/f/newtab-code','_blank');v.onclick=()=>{fetch('/_code?v='+encodeURIComponent(code.value)).then(r=>r.json()).then(j=>{o.textContent=j.ok?'Verified':'Wrong code';})}`);
  pages['/f/newtab-code'] = () => page('Access code', `<h1>Your access code</h1><p>Code: <b id=c>${s.codes.newtab}</b></p>`);

  pages['/f/scroll'] = () => page('Inventory', `<h1>Inventory</h1><ul id=l style="list-style:none;padding:0"></ul><div id=sent style="height:20px">loading more</div>`,
    `let n=0;const add=()=>{if(n>=120){sent.remove();return}for(let i=0;i<20;i++){n++;const li=document.createElement('li');li.style.cssText='height:44px';li.innerHTML='Item '+n+' <button>Select</button>';const k=n;li.querySelector('button').onclick=()=>report('scroll',{selected:'Item '+k});l.append(li)}};
new IntersectionObserver(e=>{if(e[0].isIntersecting)setTimeout(add,150)},{rootMargin:'0px'}).observe(sent);add();`);

  pages['/f/paginate'] = page('Leaderboard', `<h1>Leaderboard</h1><table border=1 cellpadding=6><thead><tr><th>ID</th><th>Score</th></tr></thead><tbody id=t></tbody></table>
<button id=pv>Previous</button><span id=pg>Page 1 of 6</span><button id=nx>Next</button><hr><label>Answer ID <input id=a aria-label="Answer ID"></label><button id=sub>Submit</button>`,
    `let p=1;const load=()=>fetch('/f/api/rows?p='+p).then(r=>r.json()).then(rows=>{t.innerHTML=rows.map(r=>'<tr><td>'+r.id+'</td><td>'+r.score+'</td></tr>').join('');pg.textContent='Page '+p+' of 6'});
pv.onclick=()=>{if(p>1){p--;load()}};nx.onclick=()=>{if(p<6){p++;load()}};sub.onclick=()=>report('paginate',{id:a.value});load();`);

  pages['/f/flaky'] = page('Order', `<h1>Order #1</h1><div id=host><button id=b>Confirm order</button></div><p id=st>waiting</p>
<div id=ov style="position:fixed;inset:0;background:#fffc;display:flex;align-items:center;justify-content:center">Loading...</div>`,
    `let clicks=0,blocked=0;const mk=()=>{host.innerHTML='<button id=b>Confirm order</button>'};
setTimeout(mk,500);setTimeout(mk,1200);setTimeout(()=>ov.remove(),1800);
ov.onclick=()=>{blocked++};
document.addEventListener('click',e=>{if(e.target.id==='b'){clicks++;st.textContent='Order placed x'+clicks;report('flaky',{clicks,blocked});}});`);

  pages['/f/combo'] = page('Shipping', `<h1>Shipping</h1><label>Country <input id=i role=combobox aria-expanded=false aria-label="Country" autocomplete=off></label><p id=o>none</p>`,
    `const C=${JSON.stringify(COUNTRIES)};let box;const open=()=>{i.setAttribute('aria-expanded','true');box&&box.remove();box=document.createElement('div');box.setAttribute('role','listbox');box.style.cssText='border:1px solid #888;height:224px;overflow:auto;width:260px;position:relative';
const draw=()=>{const f=C.filter(c=>c.toLowerCase().includes(i.value.toLowerCase()));const top=Math.floor(box.scrollTop/32);box.innerHTML='<div style="height:'+f.length*32+'px"></div>';f.slice(top,top+9).forEach((c,k)=>{const d=document.createElement('div');d.setAttribute('role','option');d.textContent=c;d.style.cssText='position:absolute;left:0;right:0;height:32px;line-height:32px;top:'+(top+k)*32+'px';d.onclick=()=>{i.value=c;o.textContent='Country: '+c;report('combo',c);box.remove();i.setAttribute('aria-expanded','false')};box.append(d)})};
box.onscroll=draw;i.oninput=draw;document.body.append(box);draw()};i.onfocus=open;i.onclick=open;`);

  pages['/f/canvas'] = () => page('Targets', `<h1>Click the ${s.canvas.target} circle</h1><canvas id=c width=600 height=300 style="border:1px solid #888"></canvas>`,
    `const P=${JSON.stringify(s.canvas.circles)};const x=c.getContext('2d');P.forEach(p=>{x.fillStyle=p.color;x.beginPath();x.arc(p.x,p.y,28,0,7);x.fill()});
c.onclick=e=>{const r=c.getBoundingClientRect(),px=(e.clientX-r.left)*c.width/r.width,py=(e.clientY-r.top)*c.height/r.height;const h=P.find(p=>Math.hypot(p.x-px,p.y-py)<=28);report('canvas',{hit:h?h.color:null})}`);

  pages['/f/wizard'] = page('Sign up', `<h1>Sign up</h1><div id=app></div>`,
    `const d={email:'',plan:'',seats:'',terms:false};let st=1;
const R=()=>{let h='';if(st===1)h='<label>Work email <input id=e aria-label="Work email" value="'+d.email+'"></label><p class=err id=er></p><button id=n>Next</button>';
if(st===2)h='<fieldset><legend>Plan</legend><label><input type=radio name=pl value=solo '+(d.plan==='solo'?'checked':'')+'> Solo</label><label><input type=radio name=pl value=team '+(d.plan==='team'?'checked':'')+'> Team</label></fieldset>'+(d.plan==='team'?'<label>Seats (3-50) <input id=s aria-label="Seats" value="'+d.seats+'"></label>':'')+'<p class=err id=er></p><button id=b>Back</button><button id=n>Next</button>';
if(st===3)h='<label><input type=checkbox id=t '+(d.terms?'checked':'')+'> I accept the terms</label><p class=err id=er></p><button id=b>Back</button><button id=n>Create account</button>';
if(st===4)h='<h2>Account created</h2>';app.innerHTML=h;
const er=m=>{document.getElementById('er').textContent=m};
document.querySelectorAll('[name=pl]').forEach(r=>r.onchange=()=>{d.plan=r.value;R()});
if(document.getElementById('b'))b.onclick=()=>{st--;R()};
if(document.getElementById('n'))n.onclick=()=>{if(st===1){d.email=e.value;if(!/^[^@\\s]+@[^@\\s]+\\.[a-z]{2,}$/.test(d.email))return er('Enter a valid email')}
if(st===2){if(!d.plan)return er('Pick a plan');if(d.plan==='team'){d.seats=s.value;if(!(+d.seats>=3&&+d.seats<=50))return er('Seats must be 3-50')}}
if(st===3){d.terms=t.checked;if(!d.terms)return er('Accept the terms');report('wizard',d)}st++;R()}};R();`);

  pages['/f/drag'] = page('Priorities', `<h1>Priorities</h1><ol id=l></ol>`,
    `const items=['A','B','C','D'];const draw=()=>{l.innerHTML=items.map(x=>'<li draggable=true data-k='+x+' style="padding:10px;border:1px solid #888;margin:4px;width:200px;cursor:grab">Task '+x+'</li>').join('');
l.querySelectorAll('li').forEach(li=>{li.ondragstart=e=>e.dataTransfer.setData('text',li.dataset.k);li.ondragover=e=>e.preventDefault();li.ondrop=e=>{e.preventDefault();const k=e.dataTransfer.getData('text');items.splice(items.indexOf(k),1);items.splice(items.indexOf(li.dataset.k),0,k);draw();report('drag',items.join(''))}})};draw();`);
  return pages;
}

function createFixtures(bind = '127.0.0.1') {
  const s = { hits: {}, reports: {}, codes: {}, canvas: {}, rows: [], paginateAnswer: '', scrollTarget: 0, country: 'Portugal' };
  const pages = build(s);
  const reset = () => {
    s.hits = {}; s.reports = {};
    s.codes.newtab = 'K' + (100000 + rnd(900000));
    const target = COLORS[rnd(COLORS.length)];
    const circles = COLORS.map((color, i) => ({ color, x: 60 + i * 110 + rnd(30), y: 60 + rnd(180) }));
    s.canvas = { target, circles };
    s.rows = Array.from({ length: 48 }, (_, i) => ({ id: 'R-' + (1000 + i), score: 100 + rnd(800) }));
    const best = 8 * (2 + rnd(3)) + rnd(8); // lands on page 3 to 5
    s.rows[best].score = 999;
    s.paginateAnswer = s.rows[best].id;
    s.scrollTarget = 80 + rnd(31);
  };
  reset();
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    s.hits[u.pathname] = (s.hits[u.pathname] || 0) + 1;
    if (u.pathname === '/_r' && req.method === 'POST') {
      let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { try { const { k, v } = JSON.parse(b); s.reports[k] = v; } catch {} res.end('ok'); });
      return;
    }
    if (u.pathname === '/_code') return res.end(JSON.stringify({ ok: u.searchParams.get('v') === s.codes.newtab }));
    if (u.pathname === '/f/api/rows') { const p = +u.searchParams.get('p') || 1; res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(s.rows.slice((p - 1) * 8, p * 8))); }
    if (u.pathname === '/f/report.csv') { res.setHeader('content-type', 'text/csv'); res.setHeader('content-disposition', 'attachment; filename="q3-report.csv"'); return res.end('id,total\n1,10\n2,20\n'); }
    const p = pages[u.pathname];
    res.setHeader('content-type', 'text/html');
    res.end(typeof p === 'function' ? p() : p || 'not found');
  });
  return new Promise((resolve) => server.listen(0, bind, () => resolve({ state: s, reset, port: server.address().port, close: () => server.close() })));
}

module.exports = { createFixtures, COUNTRIES };
