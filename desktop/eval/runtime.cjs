// Boots the same stack the speed tests use (headless Chrome + the real VPS
// browser host) behind a counting proxy, or attaches to an existing
// connection.json. The proxy is the metrics tap: every tool call the agent
// makes reaches the host as one HTTP request that passes through it.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function findChrome() {
  const home = os.homedir();
  const globs = (dir, rx) => { try { return fs.readdirSync(dir).filter((n) => rx.test(n)).map((n) => path.join(dir, n)); } catch { return []; } };
  return [
    process.env.HERMES_TEST_CHROME,
    ...globs(path.join(home, '.agent-browser', 'browsers'), /^chrome-/).map((d) => path.join(d, 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')),
    ...globs(path.join(home, 'Library/Caches/ms-playwright'), /^chromium-\d+$/).flatMap((d) => globs(d, /^chrome-/).map((e) => path.join(e, 'Chromium.app/Contents/MacOS/Chromium'))),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].find((f) => f && fs.existsSync(f));
}
async function until(fn, ms, what) {
  for (const end = Date.now() + ms; Date.now() < end;) { const v = await fn(); if (v) return v; await wait(100); }
  throw new Error('timed out waiting for ' + what);
}
const freePort = () => new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const n = s.address().port; s.close(() => r(n)); }); });

// log: [{t, method, path, status, ms, bytes}] since last takeLog().
async function startProxy(target, token) {
  let log = [];
  const server = http.createServer((req, res) => {
    const t0 = Date.now();
    const up = http.request(new URL(req.url, target.url), { method: req.method, headers: { ...req.headers, host: new URL(target.url).host } }, (r) => {
      let bytes = 0;
      r.on('data', (c) => { bytes += c.length; });
      r.on('end', () => log.push({ t: t0, method: req.method, path: req.url.split('?')[0], status: r.statusCode, ms: Date.now() - t0, bytes }));
      res.writeHead(r.statusCode, r.headers); r.pipe(res);
    });
    up.on('error', () => { log.push({ t: t0, method: req.method, path: req.url, status: 502, ms: Date.now() - t0, bytes: 0 }); res.writeHead(502).end('{"error":"proxy"}'); });
    req.pipe(up);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, token, takeLog: () => { const l = log; log = []; return l; }, close: () => server.close() };
}

async function startStack({ connection, fixtureHost = 'fixture.example', fixturePort } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alans-eval-'));
  const children = [];
  let direct;
  if (connection) direct = JSON.parse(fs.readFileSync(connection, 'utf8'));
  else {
    const chrome = findChrome();
    if (!chrome) throw new Error('no Chrome found (set HERMES_TEST_CHROME)');
    const profile = path.join(dir, 'profile');
    const browser = spawn(chrome, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-sandbox',
      `--host-resolver-rules=MAP ${fixtureHost} 127.0.0.1`, 'about:blank'], { stdio: 'ignore' });
    children.push(browser);
    const portFile = path.join(profile, 'DevToolsActivePort');
    await until(() => fs.existsSync(portFile), 60000, 'Chrome DevToolsActivePort');
    const cdpPort = fs.readFileSync(portFile, 'utf8').split('\n')[0];
    await until(() => fetch(`http://127.0.0.1:${cdpPort}/json/version`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false), 60000, 'Chrome /json/version');
    const data = path.join(dir, 'data'); fs.mkdirSync(data);
    fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ cdpUrl: `http://127.0.0.1:${cdpPort}`, port: await freePort() }));
    const env = { ...process.env, HERMES_VPS_BROWSER_DATA: data };
    delete env.HERMES_WORKSPACE_ALLOW_LOOPBACK;
    const host = spawn(process.execPath, [path.join(__dirname, '../scripts/vps-browser-host.cjs'), 'serve'], { env, stdio: 'ignore' });
    children.push(host);
    await until(() => fs.existsSync(path.join(data, 'connection.json')), 60000, 'host connection.json');
    direct = JSON.parse(fs.readFileSync(path.join(data, 'connection.json')));
  }
  const proxy = await startProxy(direct, direct.token);
  const connFile = path.join(dir, 'connection.json');
  fs.writeFileSync(connFile, JSON.stringify({ ...direct, url: proxy.url }));
  const botId = 'eval-bot';
  const raw = (route, method = 'GET', body, epoch) => fetch(direct.url + route, {
    method, headers: { Authorization: `Bearer ${direct.token}`, 'X-Hermes-Bot': botId, 'Content-Type': 'application/json', ...(epoch != null ? { 'X-Control-Epoch': String(epoch) } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).then((r) => r.json().catch(() => ({})));
  const tabs = async () => { const r = await raw('/v1/tabs'); return Array.isArray(r) ? r : r.tabs || []; };
  return {
    dir, connFile, proxy, botId, tabs, raw,
    // Evaluate in the task's first tab straight against the host (not counted as agent work).
    pageEval: async (code, index = 0) => { const t = (await tabs())[index]; return t ? (await raw(`/v1/tabs/${t.id}/actions`, 'POST', { action: 'eval', code, epoch: t.epoch })).value : undefined; },
    closeTabs: async () => { for (const t of await tabs()) await raw(`/v1/tabs/${t.id}`, 'DELETE', undefined, t.epoch).catch(() => {}); },
    stop: async () => { proxy.close(); for (const c of children) c.kill(); await wait(300); try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}
module.exports = { startStack };
