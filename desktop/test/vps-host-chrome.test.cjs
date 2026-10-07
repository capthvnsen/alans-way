// Runs the real VPS browser host against a real headless Chromium to prove the
// agent URL barrier holds for redirects, userinfo, pop-ups, frames, workers and
// subresources. Skipped when no Chrome is found (set HERMES_TEST_CHROME).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

function findChrome() {
  const home = os.homedir();
  const globs = (dir, rx) => { try { return fs.readdirSync(dir).filter((n) => rx.test(n)).map((n) => path.join(dir, n)); } catch { return []; } };
  const candidates = [
    process.env.HERMES_TEST_CHROME,
    ...globs(path.join(home, '.agent-browser', 'browsers'), /^chrome-/).map((d) => path.join(d, 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')),
    ...globs(path.join(home, 'Library/Caches/ms-playwright'), /^chromium-\d+$/).flatMap((d) => globs(d, /^chrome-/).map((e) => path.join(e, 'Chromium.app/Contents/MacOS/Chromium'))),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ...['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].flatMap((n) => (process.env.PATH || '').split(path.delimiter).map((d) => path.join(d, n))),
  ];
  return candidates.find((file) => file && fs.existsSync(file));
}
const chrome = findChrome();
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

let dir, profile, browser, host, site, secret, pa, pb, hits, connection, stderr = '';
const api = (route, method = 'GET', body, epoch) =>
  fetch(connection.url + route, {
    method,
    headers: { Authorization: `Bearer ${connection.token}`, 'X-Hermes-Bot': 'chrome-bot', 'X-Control-Epoch': String(epoch ?? ''), 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, data: await r.json() }));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  if (!chrome) return;
  hits = [];
  secret = http.createServer((req, res) => { hits.push(req.method + ' ' + req.url); res.setHeader('content-type', 'text/html'); res.end('SECRET'); });
  secret.on('upgrade', (req, socket) => { hits.push('UPGRADE ' + req.url); socket.destroy(); });
  pb = await listen(secret);
  const T = `http://127.0.0.1:${pb}/secret`;
  const page = (html) => (res) => { res.setHeader('content-type', 'text/html'); res.end(html); };
  const routes = {
    '/redir': (res) => { res.writeHead(302, { Location: T + '?redir' }); res.end(); },
    '/redir-cred': (res) => { res.writeHead(302, { Location: `http://u:p@127.0.0.1:${pb}/secret?cred` }); res.end(); },
    '/redir-dec': (res) => { res.writeHead(302, { Location: `http://2130706433:${pb}/secret?dec` }); res.end(); },
    '/sub': page(`<script>fetch('${T}?fetch',{mode:'no-cors'}).catch(()=>{});var x=new XMLHttpRequest();x.open('GET','${T}?xhr');x.send();new Image().src='${T}?img';try{new WebSocket('ws://127.0.0.1:${pb}/ws')}catch(e){}navigator.sendBeacon('${T}?beacon','x')</script>sub`),
    '/iframe': page(`<iframe src="${T}?iframe"></iframe>`),
    '/form': page(`<form id=f method=post action="${T}?form"><input name=a value=1></form><script>f.submit()</script>`),
    '/worker.js': (res) => { res.setHeader('content-type', 'application/javascript'); res.end(`fetch('${T}?worker',{mode:'no-cors'})`); },
    '/worker': page(`<script>new Worker('/worker.js')</script>worker`),
    '/pop': page(`<script>setTimeout(()=>window.open("${T}?pop"),300)</script>pop`),
    '/pop-userinfo': page(`<script>setTimeout(()=>window.open("http://u:p@127.0.0.1:${pb}/secret?popcred"),300)</script>pop`),
    '/pop-blank': page(`<script>setTimeout(()=>{var w=window.open("about:blank");w.location="${T}?popblank"},300)</script>pop`),
    '/ok': page('<p id=ok>ok</p>' + '<img src="/i.png?1"><img src="/i.png?2"><img src="/i.png?3">'),
    '/i.png': (res) => { res.setHeader('content-type', 'image/png'); res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')); },
  };
  site = http.createServer((req, res) => (routes[new URL(req.url, 'http://x').pathname] || page('fixture'))(res));
  pa = await listen(site);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-vps-chrome-'));
  profile = path.join(dir, 'profile');
  browser = spawn(chrome, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-sandbox',
    '--host-resolver-rules=MAP test.example 127.0.0.1', 'about:blank'], { stdio: 'ignore' });
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await wait(100);
  const cdpPort = fs.readFileSync(portFile, 'utf8').split('\n')[0];
  const data = path.join(dir, 'data');
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ cdpUrl: `http://127.0.0.1:${cdpPort}`, port: await new Promise((r) => { const p = http.createServer(); p.listen(0, '127.0.0.1', () => { const n = p.address().port; p.close(() => r(n)); }); }) }));
  const env = { ...process.env, HERMES_VPS_BROWSER_DATA: data };
  delete env.HERMES_WORKSPACE_ALLOW_LOOPBACK;
  host = spawn(process.execPath, [path.join(__dirname, '../scripts/vps-browser-host.cjs'), 'serve'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  host.stderr.on('data', (c) => { stderr += c; });
  for (let i = 0; i < 100 && !fs.existsSync(path.join(data, 'connection.json')); i++) await wait(100);
  connection = JSON.parse(fs.readFileSync(path.join(data, 'connection.json')));
});
const exited = (child) => new Promise((resolve) => {
  if (!child || child.exitCode !== null || child.signalCode) return resolve();
  const force = setTimeout(() => child.kill('SIGKILL'), 3000);
  child.once('exit', () => { clearTimeout(force); resolve(); });
  child.kill();
});
after(async () => {
  site?.close();
  secret?.close();
  // Chrome keeps writing to its profile until it is gone, so wait for both exits.
  await Promise.all([exited(host), exited(browser)]);
  if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('real Chromium: an agent page cannot reach loopback or metadata by redirect, pop-up, frame, form, worker or subresource', { skip: !chrome && 'no Chrome found (set HERMES_TEST_CHROME)', timeout: 60000 }, async () => {
  const cases = ['redir', 'redir-cred', 'redir-dec', 'sub', 'iframe', 'form', 'worker', 'pop', 'pop-userinfo', 'pop-blank'];
  await Promise.all(cases.map((name) => api('/v1/tabs', 'POST', { url: `http://test.example:${pa}/${name}` })));
  await wait(3000);
  // WebSocket handshakes are invisible to the Fetch domain: a documented gap, so only they may arrive.
  const reached = hits.filter((h) => !h.startsWith('UPGRADE '));
  assert.deepEqual(reached, [], `loopback server was reached: ${reached.join(', ')}\n${stderr}`);
  const tabs = (await api('/v1/tabs')).data.tabs;
  assert.ok(tabs.some((t) => t.blocked), 'at least one tab reports why it was stopped');
  assert.ok(tabs.every((t) => !/127\.0\.0\.1/.test(t.url)), 'no agent tab rests on a loopback page');
  for (const tab of tabs) await api(`/v1/tabs/${tab.id}`, 'DELETE', undefined, tab.epoch);

  const ok = (await api('/v1/tabs', 'POST', { url: `http://test.example:${pa}/ok` })).data;
  const loadedImages = await api(`/v1/tabs/${ok.id}/actions`, 'POST', { action: 'eval', code: "[...document.images].filter((i) => i.complete && i.naturalWidth).length", epoch: ok.epoch });
  assert.equal(loadedImages.data.value, 3, 'ordinary subresources still load through the filter');
  const viaEval = await api(`/v1/tabs/${ok.id}/actions`, 'POST', { action: 'eval', code: `location.href='http://u@127.0.0.1:${pb}/secret?eval';1`, epoch: ok.epoch });
  assert.equal(viaEval.status, 200);
  await wait(1500);
  assert.deepEqual(hits.filter((h) => !h.startsWith('UPGRADE ')), [], 'script navigation is stopped too');
});
