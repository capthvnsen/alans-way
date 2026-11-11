#!/usr/bin/env node
// Chat-surface speed: native chat vs the embedded Hermes Webapp (hermes-desktop) vs Telegram, in the real app
// (src/main.cjs) under Electron with a throwaway profile per surface. Never the user's real profile.
// Needs the Hermes lab (a scratch Hermes + fake model on loopback), see docs/benchmarks/results/2026-11-11-chat-surfaces/results.md for how it was set up.
// Run: HERMES_LAB=<lab dir> npm run bench:chat [-- --out DIR --cold 10 --warm 3 --switch 20 --token 10 --scroll 5 --only a,b --proof]
// Two modes in one file: the plain Node orchestrator, and (under Electron) one job per launch.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const KEY = process.env.HERMES_LAB_KEY || 'lab-key-local-throwaway-0001', API = process.env.HERMES_LAB_API || 'http://127.0.0.1:18642', WEBAPP = process.env.HERMES_LAB_WEBAPP || 'http://127.0.0.1:19120/';
// In-page helpers: __wp resolves with epoch ms of the frame (rAF, then a 0 ms timer) in which cond() first holds.
const HELPERS = `window.__wp = window.__wp || ((cond, ms = 60000) => new Promise((res, rej) => { const end = performance.now() + ms;
  const tick = () => { let ok = false; try { ok = !!cond(); } catch {} if (ok) setTimeout(() => res(performance.timeOrigin + performance.now()), 0); else if (performance.now() > end) rej(new Error('timeout')); else requestAnimationFrame(tick); };
  requestAnimationFrame(tick); }));
  window.__poll = window.__poll || ((cond, ms = 20000) => window.__wp(cond, ms));
  if (!window.__keyT) { window.__keyT = 0; addEventListener('keydown', (e) => { if (e.key === 'Enter') window.__keyT = performance.timeOrigin + performance.now(); }, true); }`;
const lastText = (sel) => `(() => { const e = document.querySelectorAll(${JSON.stringify(sel)}); return e.length ? e[e.length - 1].textContent : ''; })()`;
// What "the thread is painted" means on each surface, as page predicates (strings, run in the page).
const COND = {
  native: (title, expect) => `() => { const r = document.querySelectorAll('#native-pane .nc-list > .nc-row'), b = document.querySelector('#native-pane textarea'); return r.length && r[r.length - 1].textContent.includes(${JSON.stringify(expect)}) && document.querySelector('#native-pane .nc-switch-title')?.textContent === ${JSON.stringify(title)} && b && b.offsetParent; }`,
  hermes: (id, expect) => `() => { const e = document.querySelectorAll('[data-message-id]'); return location.hash.includes(${JSON.stringify(id)}) && e.length && e[e.length - 1].textContent.includes(${JSON.stringify(expect)}) && document.querySelector('[aria-label=Message]'); }`,
  hermesReady: () => `() => document.querySelector('[aria-label=Message]') && !document.querySelector('[data-slot=aui_thread-viewport] [data-message-id]') && location.pathname === '/'`,
  telegram: () => `() => document.querySelector('#auth-qr-form button')`,
};
const SCROLLER = { native: '#native-pane .nc-scroll', hermes: '[data-slot=aui_thread-viewport]' };
const COMPOSER = { native: '#native-pane textarea', hermes: '[aria-label=Message]' };
const ASSISTANT = { native: '#native-pane .nc-row.assistant', hermes: '[data-role=assistant]' };

// ------------------------------------------------------------------ child (one Electron launch = one job)
function child() {
  const { app, BrowserWindow, webContents, session } = require('electron');
  const job = JSON.parse(process.env.BENCH_JOB), T0 = Number(process.env.BENCH_T0);
  process.env.HERMES_WORKSPACE_DATA = job.profile;
  process.env.HERMES_WORKSPACE_PORT = '0';
  process.env.HERMES_WORKSPACE_ALLOW_LOOPBACK = '1';
  app.setPath('userData', job.profile);
  app.setPath('sessionData', job.profile);
  app.setAsDefaultProtocolClient = () => false;
  const emit = (value) => process.stdout.write(`BENCH_RESULT ${JSON.stringify(value)}\n`);
  const finish = (value, code = 0) => { emit(value); setTimeout(() => app.exit(code), 50); };
  setTimeout(() => finish({ error: 'job deadline' }, 1), 240000).unref();
  // Telegram's real page needs the network and a login: every surface but Telegram's own cold open gets a static stand-in.
  if (job.stubTelegram) app.whenReady().then(() => session.fromPartition('persist:telegram').protocol.handle('https', () => new Response('<!doctype html><title>Telegram stand-in</title>', { headers: { 'Content-Type': 'text/html' } })));
  const partitionOf = (name) => session.fromPartition(name);
  const find = (what) => webContents.getAllWebContents().find((c) => !c.isDestroyed() && (what === 'shell' ? c.getURL().endsWith('index.html') && c.getType() === 'window' : c.session === partitionOf(what === 'hermes' ? 'persist:hermes-webapp' : 'persist:telegram')));
  const until = async (read, why, ms = 30000) => { for (const end = Date.now() + ms; ; await sleep(10)) { const v = await read(); if (v) return v; if (Date.now() > end) throw new Error(`timed out: ${why}`); } };
  const ev = (c, js) => c.executeJavaScript(js);
  const surfaceView = () => find(job.surface === 'hermes' ? 'hermes' : job.surface === 'telegram' ? 'telegram' : 'shell');
  // Arm the cold-open probe in every fresh page of the surface's view.
  const armCold = (cond) => app.on('web-contents-created', (_e, c) => c.on('dom-ready', () => {
    c.setBackgroundThrottling(false);
    if (c !== surfaceView()) return;
    ev(c, `${HELPERS}; window.__wp(${cond}).then((t) => { window.__coldT = t; }, () => {}); ${job.surface === 'hermes' ? `window.__wp(${COND.hermesReady()}).then((t) => { window.__readyT = t; }, () => {});` : ''} 0`).catch(() => {});
  }));
  const fix = job.fix || {};
  const coldCond = job.surface === 'native' ? COND.native(fix.A?.title, fix.A?.expect) : job.surface === 'hermes' ? COND.hermes(fix.A?.id, fix.A?.expect) : COND.telegram();
  if (job.kind !== 'prime-native') armCold(coldCond);
  require('../../src/main.cjs');

  const wheel = async (c, scroller, legs, dy) => {
    // A point on the right of the scroller: the Webapp's sidebar can cover its middle at chat-pane width.
    const rect = await ev(c, `(() => { const s = document.querySelector(${JSON.stringify(scroller)}), r = s.getBoundingClientRect(), x = Math.round(r.x + r.width * 0.9), y = Math.round(r.y + r.height / 2); const e = document.elementFromPoint(x, y); return { x, y, ok: s.contains(e), over: e && (e.tagName + '.' + String(e.className).slice(0, 80)), box: [r.x, r.y, r.width, r.height] }; })()`);
    if (!rect.ok) throw new Error(`the wheel point is not over the scroller: ${JSON.stringify(rect)}`);
    await ev(c, `window.__fr = { d: [], stop: false, top: 1e9, bottom: 0 }; (() => { let last = performance.now(); const s = document.querySelector(${JSON.stringify(scroller)}); const loop = () => { const n = performance.now(); window.__fr.d.push(n - last); last = n; window.__fr.top = Math.min(window.__fr.top, s.scrollTop); window.__fr.bottom = Math.max(window.__fr.bottom, s.scrollTop); if (!window.__fr.stop) requestAnimationFrame(loop); }; requestAnimationFrame(loop); })(); 0`);
    await sleep(100);
    for (const sign of legs) for (let i = 0; i < 150; i++) { c.sendInputEvent({ type: 'mouseWheel', ...rect, deltaX: 0, deltaY: sign * dy, wheelTicksX: 0, wheelTicksY: sign * dy / 120, hasPreciseScrollingDeltas: true, canScroll: true }); await sleep(16); }
    await sleep(300);
    return ev(c, `(() => { window.__fr.stop = true; return window.__fr; })()`);
  };
  const send = async (c, kind, text) => {
    await ev(c, `document.querySelector(${JSON.stringify(COMPOSER[kind])}).focus(); 0`);
    c.focus();
    c.insertText(text);
    await sleep(60);
    c.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    c.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
  };

  app.whenReady().then(async () => {
    const win = await until(() => BrowserWindow.getAllWindows()[0], 'window');
    const shell = win.webContents;
    shell.setBackgroundThrottling(false);
    win.show();
    await until(() => !shell.isLoading() && shell.getURL().endsWith('index.html'), 'workspace page');
    const out = { surface: job.surface, kind: job.kind };
    const readColdT = async (c) => until(() => ev(c, 'window.__coldT').catch(() => 0), 'chat usable', 60000);

    if (job.kind === 'prime-native') {
      // Settings, like test/native-chat-electron.cjs: Save, Test, then pick the surface; then open the cold-open thread.
      await ev(shell, `document.getElementById('settings-fallback').click()`);
      await until(() => ev(shell, `!!document.querySelector('#settings-native-url')?.offsetParent`), 'native settings');
      await ev(shell, `(() => { for (const [id, value] of [['settings-native-url', ${JSON.stringify(API)}], ['settings-native-key', ${JSON.stringify(KEY)}]]) { const i = document.getElementById(id); i.value = value; i.dispatchEvent(new Event('input')); } document.getElementById('settings-native-save').click(); })()`);
      await until(async () => (await ev(shell, `document.getElementById('settings-native-status').textContent`)) === 'Saved.', 'saved');
      await ev(shell, `document.getElementById('settings-native-test').click()`);
      await until(async () => /^Connected/.test(await ev(shell, `document.getElementById('settings-native-status').textContent`)), 'connected');
      await until(() => ev(shell, `!document.querySelector('#settings-chat-surface option[value="native"]').disabled`), 'surface selectable');
      await ev(shell, `(() => { const s = document.getElementById('settings-chat-surface'); s.value = 'native'; s.dispatchEvent(new Event('change')); })()`);
      await until(async () => (await ev(shell, 'workspace.getState()')).chatTarget === 'native', 'native surface');
      await ev(shell, `document.getElementById('modal-close').click()`);
      await until(() => ev(shell, `!!document.querySelector('#native-pane .nc-switch')?.offsetParent`), 'native pane');
      await ev(shell, `${HELPERS}; document.querySelector('#native-pane .nc-switch').click(); 0`);
      await until(() => ev(shell, `!!document.querySelector('#native-pane .nc-menu-item[data-id="${fix.A.id}"]')?.offsetParent`), 'menu item');
      await ev(shell, `document.querySelector('#native-pane .nc-menu-item[data-id="${fix.A.id}"]').click(); 0`);
      await ev(shell, `window.__wp(${COND.native(fix.A.title, fix.A.expect)})`);
      await sleep(800);
      return finish({ ...out, ok: true });
    }

    if (job.surface === 'hermes') {
      await until(async () => (await ev(shell, 'workspace.getState()')).webappStatus === 'needs-link', 'webapp needs-link');
      await ev(shell, `workspace.command('webapp-link', { url: ${JSON.stringify(job.link)} })`);
    }
    const view = await until(surfaceView, `${job.surface} view`, 20000);
    if (job.surface === 'hermes') {
      out.readyMs = (await until(() => ev(find('hermes'), 'window.__readyT').catch(() => 0), 'webapp composer', 60000)) - T0;
      if (job.kind !== 'proof') await ev(find('hermes'), `location.hash = '#/' + ${JSON.stringify(fix.A?.id || '')}; 0`);
    }
    if (job.kind === 'cold') {
      const t = await readColdT(view);
      out.coldMs = t - T0;
      if (job.surface === 'native') out.paneMarkMs = await ev(shell, `(() => { const m = (window.__nativeChatMarks || []).find((x) => x.name === 'pane-painted'); return m ? performance.timeOrigin + m.t : null; })()`).then((m) => (m ? m - T0 : null));
      return finish(out);
    }

    if (job.kind === 'proof') {
      const hv = find('hermes'), text = 'hello from hermes desktop';
      await ev(hv, `${HELPERS}; 0`);
      await sleep(4000); // a message sent in the first seconds after the composer shows is not always picked up
      await send(hv, 'hermes', text);
      await until(() => ev(hv, `${lastText(ASSISTANT.hermes)}.includes(${JSON.stringify('pong: ' + text)})`), 'pong reply', 60000).catch(async (error) => {
        fs.mkdirSync('/tmp/w1-proof', { recursive: true });
        fs.writeFileSync('/tmp/w1-proof/hermes-desktop-FAILED.png', (await hv.capturePage()).toPNG());
        throw error;
      });
      await sleep(1500);
      fs.mkdirSync('/tmp/w1-proof', { recursive: true });
      fs.writeFileSync('/tmp/w1-proof/hermes-desktop.png', (await hv.capturePage()).toPNG());
      const transcript = await ev(hv, `[...document.querySelectorAll('[data-message-id]')].map((e) => '[' + e.dataset.role + '] ' + (e.innerText || e.textContent).trim().replace(/\\n+/g, ' ')).join('\\n\\n')`);
      fs.writeFileSync('/tmp/w1-proof/hermes-desktop-transcript.txt', `${transcript}\n`);
      return finish({ ...out, ok: true, transcript, sessionHash: await ev(hv, 'location.hash') });
    }

    // interact: switch, 1k scroll, first token (sessions the first-token runs create would push the fixtures out of the Webapp's sidebar, so last)
    await readColdT(view);
    const kind = job.surface, samples = { switch: [], switchMarks: [], scroll: [], token: [], tokenMarks: [] };
    await ev(view, `${HELPERS}; 0`);
    // The Webapp's sidebar is a drawer at chat-pane width: open it to click rows, close it so it does not cover the thread.
    const sidebar = async (on) => {
      if (kind !== 'hermes') return;
      await ev(view, `document.querySelector('[aria-label="${on ? 'Show' : 'Hide'} sidebar"]')?.click(); 0`);
      if (!on) return sleep(500);
      await until(() => ev(view, `[...document.querySelectorAll('button[aria-expanded]')].some((b) => b.textContent.trim().toLowerCase() === 'api')`), 'API group');
      await ev(view, `(() => { const b = [...document.querySelectorAll('button[aria-expanded]')].find((x) => x.textContent.trim().toLowerCase() === 'api'); if (b.getAttribute('aria-expanded') === 'false') b.click(); })()`);
      await until(() => ev(view, `document.querySelectorAll('button[data-slot=row-button]').length >= 3`), 'sidebar rows');
    };
    await sidebar(true);
    // Trigger the switch the way a person does (menu item / sidebar row), time from the click to the frame with the last message painted.
    const open = (t) => kind === 'native'
      ? ev(view, `(async () => { document.querySelector('#native-pane .nc-switch').click(); await __poll(() => document.querySelector('#native-pane .nc-menu-item[data-id="${t.id}"]')?.offsetParent);
          const t0 = performance.timeOrigin + performance.now(); document.querySelector('#native-pane .nc-menu-item[data-id="${t.id}"]').click(); const t1 = await __wp(${COND.native(t.title, t.expect)});
          const m = (window.__nativeChatMarks || []).filter((x) => x.name === 'thread-painted' && performance.timeOrigin + x.t >= t0)[0]; return { ms: t1 - t0, mark: m ? performance.timeOrigin + m.t - t0 : null }; })()`)
      : ev(view, `(async () => { const row = [...document.querySelectorAll('button[data-slot=row-button]')].find((b) => b.textContent.trim() === ${JSON.stringify(t.title)}); if (!row) window.__hashNav = (window.__hashNav || 0) + 1;
          const t0 = performance.timeOrigin + performance.now(); if (row) row.click(); else location.hash = '#/${t.id}'; const t1 = await __wp(${COND.hermes(t.id, t.expect)}); return { ms: t1 - t0, mark: null }; })()`);
    for (let i = 0; i < job.counts.switch; i++) {
      const r = await open(i % 2 ? fix.A : fix.B);
      samples.switch.push(r.ms); if (r.mark != null) samples.switchMarks.push(r.mark);
      await sleep(150);
    }
    for (let i = 0; i < job.counts.scroll; i++) {
      await sidebar(true);
      await open(i % 2 ? fix.B : fix.A); await sleep(300);
      await open(fix.K);
      await sidebar(false);
      await sleep(500);
      const fr = await wheel(view, SCROLLER[kind], [1, -1], 400);
      if (fr.bottom - fr.top < 5000) throw new Error(`the wheel did not scroll (scrollTop ${fr.top}..${fr.bottom})`);
      const d = fr.d.slice(1).sort((a, b) => a - b);
      const over = d.filter((x) => x > 16.7).length;
      samples.scroll.push({ frames: d.length, p95: d[Math.ceil(0.95 * d.length) - 1], over167Pct: 100 * over / d.length, worst: d[d.length - 1], scrollTopMin: fr.top, scrollTopMax: fr.bottom });
    }
    for (let i = 0; i < job.counts.token + 1; i++) { // the first turn pays the gateway's one-off agent setup and is discarded
      if (kind === 'native') { await ev(view, `document.querySelector('#native-pane .nc-new').click(); 0`); await until(() => ev(view, `document.querySelector('#native-pane .nc-empty')?.textContent === 'New conversation. Say hello.'`), 'new chat'); }
      else { await ev(view, `location.hash = '#/'; 0`); await until(() => ev(view, `(${COND.hermesReady()})()`), 'new session'); }
      await sleep(300);
      const sel = ASSISTANT[kind];
      const before = await ev(view, `(window.__nativeChatMarks || []).length`);
      await ev(view, `window.__keyT = 0; 0`);
      await send(view, kind, 'hello');
      // t0 = the Enter keydown in the page; painted = first frame whose assistant text holds the reply
      const r = await ev(view, `(async () => { const t = await __wp(() => ${lastText(sel)}.includes('pong')); const m = (window.__nativeChatMarks || []).slice(${before}); const s = m.find((x) => x.name === 'send'), f = m.find((x) => x.name === 'first-token'); return { ms: t - window.__keyT, mark: s && f ? f.t - s.t : null }; })()`);
      if (i) { samples.token.push(r.ms); if (r.mark != null) samples.tokenMarks.push(r.mark); }
      await until(() => ev(view, `${lastText(sel)}.includes('pong: hello')`), 'reply complete');
      await sleep(600);
    }
    samples.hashNav = kind === 'hermes' ? await ev(view, 'window.__hashNav || 0') : 0;
    return finish({ ...out, samples });
  }).catch((error) => finish({ error: String(error?.stack || error) }, 1));
}

// ------------------------------------------------------------------ orchestrator
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback; };
const stats = (xs) => {
  if (!xs.length) return { n: 0 };
  const s = [...xs].sort((a, b) => a - b), at = (q) => s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)];
  const median = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  return { n: s.length, median: +median.toFixed(1), p95: +at(0.95).toFixed(1), min: +s[0].toFixed(1), max: +s.at(-1).toFixed(1) };
};
async function api(p, init = {}) { const r = await fetch(API + p, { ...init, headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', ...init.headers } }); return { status: r.status, body: await r.json().catch(() => null) }; }
const realGateway = () => { try { const pid = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.hermes/gateway.pid'), 'utf8')).pid; process.kill(pid, 0); return pid; } catch { return null; } };

async function orchestrate() {
  const LAB = process.env.HERMES_LAB;
  if (!LAB || !fs.existsSync(path.join(LAB, 'lab.sh'))) throw new Error('Set HERMES_LAB to the Hermes lab directory (it has lab.sh).');
  const here = path.resolve(__dirname, '..', '..');
  const out = path.resolve(arg('--out', path.join(here, '..', 'docs/benchmarks/results/2026-11-11-chat-surfaces')));
  const N = { warm: +arg('--warm', 3), cold: +arg('--cold', 10), switch: +arg('--switch', 20), token: +arg('--token', 10), scroll: +arg('--scroll', 5) };
  const only = (arg('--only', '') || '').split(',').filter(Boolean), want = (k) => !only.length || only.includes(k);
  const proofOnly = process.argv.includes('--proof');
  const gwBefore = realGateway();
  const profiles = [];
  const profile = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-bench-')); profiles.push(p); return p; };
  const writePrefs = (p, prefs) => { const f = path.join(p, 'preferences.json'); let old = {}; try { old = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {} fs.writeFileSync(f, JSON.stringify({ ...old, onboarded: true, preview: false, ...prefs })); };
  const mintLink = () => {
    const py = path.join(os.homedir(), '.hermes/hermes-agent/venv/bin/python'), home = path.join(LAB, 'home');
    const text = execFileSync(py, ['-m', 'hermes_cli.main', 'webapp', '--no-open', '--skip-build'], { cwd: path.join(os.homedir(), '.hermes/hermes-agent'), encoding: 'utf8', timeout: 30000,
      env: { ...process.env, HERMES_HOME: home, HERMES_GATEWAY_LOCK_DIR: path.join(home, 'locks'), PYTHONDONTWRITEBYTECODE: '1', HERMES_WEBAPP_DIST: path.join(LAB, 'webapp-dist') } });
    return text.match(/http:\/\/\S+\/webapp\/launch#ticket=[\w-]{43}/)[0];
  };
  // Fixtures are seeded straight into the lab DB: they are the newest sessions, so the Webapp's sidebar lists them.
  const FIX = [['bench 1k', 1000, 'K', 'Result 499'], ['bench A', 40, 'A', 'Result 19'], ['bench B', 44, 'B', 'Result 21']];
  const ensureFixtures = async () => {
    const fix = {};
    for (const [title, count, key, expect] of FIX) {
      const old = (await api(`/api/sessions?title=${encodeURIComponent(title)}`)).body?.data?.[0];
      if (old) await api(`/api/sessions/${old.id}`, { method: 'DELETE' });
      execFileSync(path.join(LAB, 'lab.sh'), ['seed', String(count), 'api_server', title], { stdio: 'ignore' });
      fix[key] = { id: (await api(`/api/sessions?title=${encodeURIComponent(title)}`)).body.data[0].id, title, expect };
      await sleep(1100);
    }
    return fix;
  };
  const launch = async (job, { prefs, link } = {}) => {
    if (prefs) writePrefs(job.profile, prefs);
    const env = { ...process.env, BENCH_JOB: JSON.stringify({ ...job, counts: N, link: link || (job.surface === 'hermes' && job.kind !== 'prime-native' ? mintLink() : undefined) }), BENCH_T0: '0' };
    return new Promise((resolve) => {
      env.BENCH_T0 = String(Date.now());
      const proc = spawn(require('electron'), [`--user-data-dir=${job.profile}`, __filename], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let buf = '', err = '';
      proc.stdout.on('data', (d) => { buf += d; });
      proc.stderr.on('data', (d) => { err = (err + d).slice(-1500); });
      const timer = setTimeout(() => proc.kill('SIGKILL'), 260000);
      proc.once('close', () => { clearTimeout(timer); const line = buf.split('\n').find((l) => l.startsWith('BENCH_RESULT ')); resolve(line ? JSON.parse(line.slice(13)) : { error: `no result; stderr tail: ${err}` }); });
    });
  };
  const must = (r, what) => { if (r.error) throw new Error(`${what}: ${r.error}`); return r; };

  const meta = { date: new Date().toISOString(), machine: {}, versions: {}, settings: N, notes: [] };
  const sh = (c, a) => { try { return execFileSync(c, a, { encoding: 'utf8' }).trim(); } catch { return ''; } };
  meta.machine = { model: sh('sysctl', ['-n', 'machdep.cpu.brand_string']), memGB: Math.round(+sh('sysctl', ['-n', 'hw.memsize']) / 2 ** 30), os: `macOS ${sh('sw_vers', ['-productVersion'])} (${sh('sw_vers', ['-buildVersion'])})`, power: sh('pmset', ['-g', 'batt']).split('\n')[0] + ' / ' + (sh('pmset', ['-g', 'batt']).split('\n')[1] || '').split(';').slice(0, 2).join(';').trim(), loadAvgAtStart: os.loadavg().map((x) => +x.toFixed(2)) };
  meta.versions = { gitRev: sh('git', ['-C', here, 'rev-parse', 'HEAD']), branch: sh('git', ['-C', here, 'rev-parse', '--abbrev-ref', 'HEAD']), electron: require('electron/package.json').version, node: process.version, hermesAgent: (await (await fetch(`${API}/health`)).json()).version || null, app: require(path.join(here, 'package.json')).version };
  const llm = sh('ps', ['eww', '-p', fs.readFileSync(path.join(LAB, 'pids/fake-llm.pid'), 'utf8').trim()]);
  meta.fakeModel = { ttftMs: +(llm.match(/FAKE_LLM_TTFT_MS=(\d+)/)?.[1] ?? 50), chunkDelayMs: +(llm.match(/FAKE_LLM_DELAY_MS=(\d+)/)?.[1] ?? 15), note: 'defaults of fake-llm.cjs when the env is unset; replies "pong: <text>" in 4-char chunks' };
  meta.realGatewayPidBefore = gwBefore;
  const rows = [], notMeasured = [];
  const flush = () => {
    meta.realGatewayPidAfter = realGateway();
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ meta, rows, notMeasured }, null, 1));
    fs.writeFileSync(path.join(out, 'meta.json'), JSON.stringify(meta, null, 1));
  };
  const add = (surface, metric, xs, note = '') => { rows.push({ surface, metric, unit: 'ms', ...stats(xs), ...(note ? { note } : {}), samples: xs.map((x) => +x.toFixed(1)) }); flush(); };
  let fix = await ensureFixtures();

  if (proofOnly) {
    const p = profile();
    const before = new Set((await api('/api/sessions?limit=200')).body.data.map((s) => s.id));
    const r = must(await launch({ surface: 'hermes', kind: 'proof', profile: p, stubTelegram: true, fix }, { prefs: { chatSurface: 'hermes-desktop', hermesWebappUrl: WEBAPP } }), 'proof');
    console.log(JSON.stringify(r));
    const after = (await api('/api/sessions?limit=200')).body.data.filter((s) => !before.has(s.id));
    const mine = after.find((s) => /hello from hermes desktop/.test(s.preview || '') || /hello from hermes desktop/.test(s.title || '')) || after[0];
    const lines = [`new sessions after the Hermes Desktop turn: ${after.length}`];
    if (!mine) lines.push('NOT FOUND in GET /api/sessions');
    else {
      const msgs = (await api(`/api/sessions/${mine.id}/messages`));
      const rows2 = (msgs.body?.data || []).filter((m) => m.role !== 'session_meta');
      lines.push(`session id: ${mine.id}`, `source: ${mine.source}`, `title: ${JSON.stringify(mine.title)}`, `message_count (session row): ${mine.message_count}`,
        `native API could list it: yes (GET /api/sessions, HTTP 200)`, `native API could read its messages: ${msgs.status === 200 ? 'yes' : 'no'} (GET /api/sessions/{id}/messages -> HTTP ${msgs.status}, ${rows2.length} non-meta rows: ${rows2.map((m) => `${m.role}:${JSON.stringify(String(m.content || '').slice(0, 40))}`).join(', ')})`);
      const post = await api(`/api/sessions/${mine.id}/chat`, { method: 'POST', body: JSON.stringify({ input: 'hello from native' }) });
      lines.push(`chat POST {"input":"hello from native"} -> HTTP ${post.status} ${JSON.stringify(post.body).slice(0, 300)}`,
        `native chat treats it as: ${mine.source === 'api_server' ? 'writable (source api_server)' : 'read-only (only api_server sessions accept messages; Continue here forks a copy)'}`);
    }
    fs.mkdirSync('/tmp/w1-proof', { recursive: true });
    fs.writeFileSync('/tmp/w1-proof/cross-surface.txt', lines.join('\n') + '\n');
    console.log(lines.join('\n'));
    return cleanup(profiles);
  }

  // ---- cold open (spawn -> last message of the thread painted and composer present)
  const cold = async (label, surface, prof, opts) => {
    const xs = [], marks = [], ready = [];
    for (let i = 0; i < N.warm + N.cold; i++) {
      if (opts.clearCache) fs.rmSync(path.join(prof, 'native-chat-cache'), { recursive: true, force: true });
      const r = must(await launch({ surface, kind: 'cold', profile: prof, stubTelegram: surface !== 'telegram', fix }, opts), `cold ${label} #${i}`);
      if (i >= N.warm) { xs.push(r.coldMs); if (r.paneMarkMs != null) marks.push(r.paneMarkMs); if (r.readyMs != null) ready.push(r.readyMs); }
      console.log(`cold ${label} ${i < N.warm ? 'warm-up' : '#' + (i - N.warm + 1)}: ${r.coldMs?.toFixed(0)} ms`);
    }
    return { xs, marks, ready };
  };
  const nativeProfile = profile(), hermesProfile = profile();
  if (want('native') || want('native-nocache')) {
    must(await launch({ surface: 'native', kind: 'prime-native', profile: nativeProfile, stubTelegram: true, fix }, { prefs: {} }), 'prime native');
    if (want('native')) { const r = await cold('native (cache warm)', 'native', nativeProfile, {}); add('native', 'cold open', r.xs, 'disk cache primed by the previous launch; the thread paints from it while the network revalidates'); if (r.marks.length) add('native', 'cold open (app pane-painted mark)', r.marks, 'cross-check: the pane-painted mark, not the shared probe'); }
    if (want('native-nocache')) { const r = await cold('native (no cache)', 'native', nativeProfile, { clearCache: true }); add('native (no cache)', 'cold open', r.xs, 'native-chat-cache/ deleted before each launch, so the thread comes from the network'); }
  }
  if (want('hermes')) {
    const r = await cold('hermes-desktop (lab)', 'hermes', hermesProfile, { prefs: { chatSurface: 'hermes-desktop', hermesWebappUrl: WEBAPP } });
    add('hermes-desktop', 'cold open', r.xs, 'includes redeeming a fresh one-use link (minted before the spawn, pasted by the harness) and the harness opening the thread by route once the composer is up');
    add('hermes-desktop', 'cold open: composer ready (new session, no thread)', r.ready);
  }
  if (want('telegram')) {
    const r = await cold('telegram (signed out)', 'telegram', profile(), { prefs: { chatSurface: 'telegram' } });
    add('telegram', 'cold open to the sign-in screen', r.xs, 'real web.telegram.org over the network, throwaway profile, never signed in; ends when the "Log in by phone number" button is painted. NOT comparable with a thread paint.');
  }

  // ---- interactions, one launch per surface
  for (const [name, surface, prof, opts] of [['native', 'native', nativeProfile, {}], ['hermes', 'hermes', hermesProfile, { prefs: { chatSurface: 'hermes-desktop', hermesWebappUrl: WEBAPP } }]]) {
    if (!want(name) && !want(`${name}-interact`)) continue;
    fix = await ensureFixtures();
    if (surface === 'native') must(await launch({ surface, kind: 'prime-native', profile: prof, stubTelegram: true, fix }, opts), 'reprime native');
    const label = surface === 'native' ? 'native' : 'hermes-desktop';
    const r = await launch({ surface, kind: 'interact', profile: prof, stubTelegram: true, fix }, opts);
    if (r.error) { notMeasured.push({ what: `${label}: thread switch, first token, 1k scroll`, why: `the harness run failed: ${r.error.split('\n')[0]}` }); flush(); continue; }
    add(label, 'thread switch', r.samples.switch, 'click on the menu item / sidebar row -> frame with the target thread\'s last message painted (small 40-44 message threads, alternating)');
    if (r.samples.switchMarks.length) add(label, 'thread switch (app thread-painted mark)', r.samples.switchMarks, 'cross-check: the app\'s own mark');
    add(label, 'first token', r.samples.token, 'Enter keydown in the page -> first frame whose reply text holds "pong"; new conversation, text "hello"');
    if (r.samples.tokenMarks.length) add(label, 'first token (app send->first-token marks)', r.samples.tokenMarks, 'cross-check: the app\'s own marks');
    const sc = r.samples.scroll;
    add(label, '1k scroll: p95 frame', sc.map((s) => s.p95), 'rAF frame deltas while 150 wheel events of 400 px (60,000 px) go up and 150 come back down at 16 ms spacing');
    add(label, '1k scroll: frames > 16.7 ms (%)', sc.map((s) => s.over167Pct));
    add(label, '1k scroll: worst frame', sc.map((s) => s.worst), `scrollTop reached ${Math.round(Math.min(...sc.map((s) => s.scrollTopMin)))}..${Math.round(Math.max(...sc.map((s) => s.scrollTopMax)))} px`);
    meta.notes.push(`${label}: ${sc.map((s) => s.frames).join('/')} frames per scroll run${r.samples.hashNav ? `; ${r.samples.hashNav} thread opens used the route (#/id) because the sidebar had no row for the thread` : ''}`); flush();
  }

  // ---- server floor: the same turn with plain curl against the API, time to the first assistant.delta
  if (want('floor')) {
    const curlFirst = (sid, input) => new Promise((resolve) => {
      const t0 = process.hrtime.bigint(), proc = spawn('curl', ['-sN', '-X', 'POST', '-H', `Authorization: Bearer ${KEY}`, '-H', 'Content-Type: application/json', '-d', JSON.stringify({ input }), `${API}/api/sessions/${sid}/chat/stream`]);
      let buf = '', done = false;
      proc.stdout.on('data', (d) => { buf += d; if (!done && buf.includes('event: assistant.delta')) { done = true; resolve(Number(process.hrtime.bigint() - t0) / 1e6); } });
      proc.once('close', () => { if (!done) resolve(NaN); });
    });
    const curlBase = () => new Promise((resolve) => { const t0 = process.hrtime.bigint(); const p = spawn('curl', ['-s', `${API}/health`]); p.stdout.once('data', () => resolve(Number(process.hrtime.bigint() - t0) / 1e6)); });
    const fresh = [], existing = [], base = [], create = [];
    const exist = (await api('/api/sessions', { method: 'POST', body: JSON.stringify({ title: `floor existing ${Date.now()}` }) })).body.session.id;
    for (let i = 0; i < 11; i++) { // the first round is a discarded warm-up (one-off agent setup in the gateway)
      const t0 = performance.now();
      const sid = (await api('/api/sessions', { method: 'POST', body: JSON.stringify({ title: `floor ${Date.now()}-${i}` }) })).body.session.id;
      const c = performance.now() - t0, f = await curlFirst(sid, 'hello'), e = await curlFirst(exist, 'hello'), b = await curlBase();
      if (i) { create.push(c); fresh.push(f); existing.push(e); base.push(b); }
    }
    add('server floor (curl)', 'first token, new session', fresh, 'curl POST /api/sessions/{id}/chat/stream on a just-created session, spawn -> first assistant.delta; same session setup as the surfaces\' first-token runs, minus session creation');
    add('server floor (curl)', 'first token, existing session', existing, 'same, on one session that already has turns');
    add('server floor (curl)', 'create session (POST /api/sessions)', create, 'not part of the stream above');
    add('server floor (curl)', 'curl spawn -> /health first byte', base, 'process-spawn baseline inside the floor numbers');
  }

  // ---- the VM over a tunnel: round trip only (a cold open needs a one-use link minted on the VM, which this run is not allowed to do)
  if (want('vm')) {
    const rtt = [], codes = [];
    for (let i = 0; i < 10; i++) { const o = sh('curl', ['-s', '-m', '8', '-o', '/dev/null', '-w', '%{http_code} %{time_total}', 'http://127.0.0.1:9120/api/status']).split(' '); codes.push(o[0]); rtt.push(+o[1] * 1000); }
    add('VM over tunnel', 'round trip to /api/status (curl time_total)', rtt, `HTTP ${[...new Set(codes)].join('/')}`);
    notMeasured.push({ what: 'Hermes Desktop cold open and thread switch on the VM over the tunnel', why: `the VM's Webapp has no sign-in but still needs a one-use link, which has to be minted on the VM (hermes webapp --no-open): an action on Alan's host this run is not allowed to take. At run time /api/status answered HTTP ${[...new Set(codes)].join('/')} and GET /api/sessions without a credential answered HTTP ${sh('curl', ['-s', '-m', '8', '-o', '/dev/null', '-w', '%{http_code}', 'http://127.0.0.1:9120/api/sessions'])}.` });
  }

  flush();
  console.log(`wrote ${out}/results.json, meta.json (results.md is written by hand from them)`);
  return cleanup(profiles);
}
function cleanup(profiles) { for (const p of profiles) fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }

if (process.versions.electron) child();
else orchestrate().catch((error) => { console.error(error); process.exit(1); });
