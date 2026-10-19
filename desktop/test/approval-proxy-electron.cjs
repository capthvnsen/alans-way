// Run only with the visible-app lease: npx electron test/approval-proxy-electron.cjs
// Actual main HTTP route + actual VPS transport framing, with a private fake
// ssh executable forwarding solely to controlled loopback status/action routes.
// No SSH network connection, native input, account or external page is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { app, BrowserWindow, webContents, session } = require('electron');
const { harnessApproval, bindApproval } = require('./approval-fixture.cjs');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-proxy-main-'));
const out = process.env.HERMES_APPROVAL_PROXY_EVIDENCE || path.join(profile, 'evidence');
fs.mkdirSync(out, { recursive: true });
const wire = [], rows = [];
let mode = 'old', server, remote;
const until = async read => {
  for (const end = Date.now() + 15000; ;) { const value = await read(); if (value) return value; assert.ok(Date.now() < end, 'fixture startup timed out'); await new Promise(resolve => setTimeout(resolve, 50)); }
};
function save() { fs.writeFileSync(path.join(out, 'receipts.json'), JSON.stringify({ rows, wire }, null, 2)); }
(async () => {
  server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    wire.push({ method: req.method, path: req.url, body, mode });
    let status = 200, data = {};
    if (req.url === '/v1/status') {
      if (mode === 'fault') { status = 503; data = { error: 'Controlled offline status' }; }
      else if (mode === 'missing') data = {};
      else if (mode === 'malformed') data = { capabilities: 'approval-binding-v1' };
      else data = { capabilities: mode === 'current' ? ['approval-binding-v1'] : ['tabs'] };
    } else if (req.url === '/v1/tabs' && req.method === 'GET') data = { tabs: [remote] };
    else if (req.url === '/v1/tabs' && req.method === 'POST') data = remote;
    else if (req.url.endsWith('/actions')) data = { dispatched: true, tab: remote };
    else if (req.url.endsWith('/snapshot')) data = { url: remote.url, approvalContext: { version: 1, documentId: 'a'.repeat(32), url: remote.url }, elements: [{ ref: 'e1', role: 'a', name: 'Buy it again', approvalTarget: 'b'.repeat(32) }], tab: remote };
    res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  remote = { id: 'remote-approval', url: `${base}/fixture`, title: 'Controlled remote fixture', host: 'vps', botId: 'fixture', controller: 'agent', epoch: 1 };
  const bin = path.join(profile, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'ssh'), `#!/usr/bin/env node
let raw='';process.stdin.on('data', b=>raw+=b);process.stdin.on('end',async()=>{
  if(!process.argv.includes('fixture@127.0.0.1'))throw Error('Only the isolated fixture host is allowed');
  const r=JSON.parse(raw);const response=await fetch(${JSON.stringify(base)}+r.path,{method:r.method,headers:{'Content-Type':'application/json'},...(r.body===undefined?{}:{body:JSON.stringify(r.body)})});
  process.stdout.write(JSON.stringify({status:response.status,data:await response.json()}));
});
`, { mode: 0o755 });
  process.env.PATH = bin + path.delimiter + process.env.PATH;
  process.env.HERMES_WORKSPACE_DATA = profile;
  process.env.HERMES_WORKSPACE_PORT = '0';
  process.env.HERMES_WORKSPACE_ALLOW_LOOPBACK = '1';
  fs.writeFileSync(path.join(profile, 'preferences.json'), JSON.stringify({ onboarded: true, preview: false, bots: [{ id: 'fixture', isBot: true, name: 'Fixture' }], selectedBotId: 'fixture', vpsBrowser: { sshHost: 'fixture@127.0.0.1', scriptPath: '/fixture/browser-host.cjs' } }));
  require('../src/main.cjs');
  await app.whenReady();
  const connection = await until(() => { try { return JSON.parse(fs.readFileSync(path.join(profile, 'connection.json'))); } catch { return null; } });
  const telegram = webContents.getAllWebContents().find(wc => wc.session === session.fromPartition('persist:telegram'));
  if (telegram) { telegram.stop(); await telegram.loadURL('about:blank'); }
  const api = async (route, method = 'GET', body) => {
    const res = await fetch(connection.url + route, { method, headers: { Authorization: `Bearer ${connection.token}`, 'X-Hermes-Bot': 'fixture', 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, data: await res.json() };
  };
  assert.equal((await api('/v1/status')).data.capabilities.includes('approval-binding-v1'), true, 'local status alone is insufficient');
  assert.equal((await api('/v1/tabs', 'POST', { url: remote.url, host: 'vm' })).status, 201);
  const snapshot = (await api(`/v1/tabs/${remote.id}/snapshot`)).data;
  for (const next of ['old', 'missing', 'fault', 'malformed', 'current', 'old', 'current']) {
    mode = next;
    const body = bindApproval({ action: 'click', ref: 'e1', epoch: 1, approval: harnessApproval(remote) }, snapshot);
    const start = wire.length;
    const response = await api(`/v1/tabs/${remote.id}/actions`, 'POST', body);
    const forwarded = wire.slice(start).filter(r => r.method === 'POST' && r.path.endsWith('/actions'));
    assert.equal(forwarded.length, mode === 'current' ? 1 : 0, 'independent approved action POST count');
    assert.equal(response.status, mode === 'current' ? 200 : 403);
    if (mode !== 'current') assert.match(response.data.error, /approval_binding_unavailable:.*Update.*fresh snapshot/);
    else assert.deepEqual(forwarded[0].body, body, 'the reviewed receipt crosses the actual route intact');
    const ordinaryAt = wire.length;
    const ordinary = await api(`/v1/tabs/${remote.id}/actions`, 'POST', { action: 'navigate', url: `${base}/guide`, epoch: 1 });
    assert.equal(ordinary.status, 200);
    assert.equal(wire.slice(ordinaryAt).filter(r => r.method === 'POST' && r.path.endsWith('/actions')).length, 1);
    rows.push({ mode, response, approvedPostCount: forwarded.length, ordinaryPostCount: 1, wire: wire.slice(start) }); save();
  }
  const win = BrowserWindow.getAllWindows()[0];
  if (win) fs.writeFileSync(path.join(out, 'actual-main.png'), (await win.webContents.capturePage()).toPNG());
  console.log(`PASS actual main proxy route: ${rows.length} capability transitions; old/unknown approved POSTs=0, ordinary POSTs=1.`);
  save(); server.close(); app.exit(0);
})().catch(error => { save(); fs.writeFileSync(path.join(out, 'ERROR.txt'), error.stack); console.error(error); server?.close(); app.exit(1); });
