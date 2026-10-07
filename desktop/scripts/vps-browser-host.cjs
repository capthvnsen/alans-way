#!/usr/bin/env node
// Add-on browser host. Stock Hermes connects through MCP; its runtime is unchanged.
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  http = require('node:http'),
  crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { CDP } = require('../src/cdp.cjs');
const { normalizeUrl, agentPageUrl, cdpMethodError, requireActor, requireAgentRead, requireAgentClaim, reviewedHandoff, isAuthorized, hostShouldReload } = require('../src/core.cjs');
const agentInputModule = require('../src/agent-input.cjs');
const { createAgentInput, tintScript, botAccent } = agentInputModule;
// Nobody watches the VM pointer live, so agent-input skips its glide pacing (isVisible) when it supports that.
const INPUT_ACTIONS = agentInputModule.INPUT_ACTIONS || new Set(['click', 'type', 'press', 'move', 'scroll']);
const { snapshotExpression, settleSnapshot, readControls, checkpointExpression, restoreExpression } = require('../src/browser-page.cjs');
const root =
  process.env.HERMES_VPS_BROWSER_DATA ||
  (process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', 'hermes-alans-way', 'browser')
    : path.join(os.homedir(), '.local', 'share', 'hermes-alans-way', 'browser'));
const configFile = path.join(root, 'config.json'),
  connectionFile = path.join(root, 'connection.json'),
  registryFile = path.join(root, 'tabs.json'),
  mirrorFile = path.join(root, 'mirror.json');
// The app token authorizes human-only operations. It lives outside the agent's
// connection file; config.appTokenFile can move it somewhere the agent user
// cannot read (see the setup notes for running the broker under another user).
function appTokenFile() {
  let configured;
  try { configured = JSON.parse(fs.readFileSync(configFile)).appTokenFile; } catch { /* default location */ }
  return typeof configured === 'string' && path.isAbsolute(configured) ? configured : path.join(root, 'app-token.json');
}
function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const intParam = (url, key, min, max) => {
  const raw = url.searchParams.get(key);
  if (raw === null) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw fail(`${key} must be an integer.`);
  return Math.max(min, Math.min(max, value));
};
// Must stay below the request timeouts for /actions in request() and the
// Mac's SSH proxy, allowing a final 30s wait step to finish.
const BATCH_BUDGET_MS = 50000;
const MIRROR_TTL_MS = 24 * 3600000;
const RESTORE_PARALLEL = 4, RESTORE_LOAD_ATTEMPTS = 50;
// Every request an agent-held tab (or a frame, worker or pop-up of it) makes is
// paused and checked against the barrier in core.cjs before it leaves, so
// redirects, userinfo URLs, pop-ups and subresources cannot reach loopback or
// metadata. Human tabs are not intercepted. Known gaps: WebSocket handshakes
// (the Fetch domain never sees them), service workers and shared workers (not
// tied to one tab), and hostnames that merely resolve to a blocked address.
const FETCH_ALL = [{ urlPattern: '*' }];
const AUTO_ATTACH = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true };
// Judged on the host alone: userinfo on a public host is no threat, and on a
// blocked host it must not be a way round the check.
const agentUrlProblem = (url) => {
  let u;
  try { u = new URL(String(url)); } catch { return ''; }
  if (!/^https?:$/.test(u.protocol)) return '';
  try { agentPageUrl(`http://${u.host}/`); return ''; } catch (e) { return e.message; }
};
const overseerBots = new Set(
  String(process.env.HERMES_OVERSEER_BOT_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id && id.length <= 100),
);
async function read(req, limit = 150000) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw fail('Request too large.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}
async function request(input) {
  const c = JSON.parse(fs.readFileSync(connectionFile));
  if (!/^\/v1\/(status|tabs|mirror|restore)(\/|$)/.test(input.path)) throw new Error('Invalid browser operation.');
  const token = input.human || input.path.startsWith('/v1/mirror') ? JSON.parse(fs.readFileSync(appTokenFile())).token : c.token;
  const response = await fetch(c.url + input.path, {
    method: input.method || 'GET',
    headers: {
      Authorization: 'Bearer ' + token,
      'X-Hermes-Bot': String(input.botId || ''),
      'X-Hermes-Bot-Name': encodeURIComponent(String(input.botName || '').slice(0, 80)),
      'X-Hermes-Human': input.human ? '1' : '0',
      'X-Control-Epoch': String(input.epoch || ''),
      'Content-Type': 'application/json',
    },
    ...(input.body ? { body: JSON.stringify(input.body) } : {}),
    signal: AbortSignal.timeout(/\/actions$/.test(input.path) ? 84000 : 25000),
  });
  const data = await response.json();
  return { status: response.status, data };
}
async function serve() {
  const cfg = JSON.parse(fs.readFileSync(configFile));
  let cdp;
  try {
    cdp = await CDP.connect(cfg.cdpUrl);
  } catch (error) {
    if (!cfg.browserCommand) throw error;
    const child = spawn(cfg.browserCommand, cfg.browserArgs || [], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    child.unref();
    for (let n = 0; n < 40; n++) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        cdp = await CDP.connect(cfg.cdpUrl);
        break;
      } catch {}
    }
    if (!cdp) throw new Error('Configured VPS Chromium did not become available.');
  }
  const tabs = new Map();
  // The Mac shell forwards each bot's display name so the in-page agent cursor
  // shows it instead of a generic "Agent" inside the streamed desktop.
  const botNames = new Map();
  let persistQueue = Promise.resolve();
  const describe = (t) => ({
    id: t.id,
    targetId: t.targetId,
    title: t.title,
    url: t.url,
    botId: t.botId,
    allowedBots: t.allowedBots ?? [],
    favicon: t.favicon || '',
    agentHue: botAccent(t.botId).hue,
    controller: t.controller,
    epoch: t.epoch,
    host: 'vps',
    session: 'shared-vps',
    loading: false,
    viewport: t.viewport || null,
    agentCursor: t.agentCursor || null,
    agentBusy: input.isDispatching(t),
    handoff: t.handoff || null,
    blocked: t.blocked || null,
  });
  function persist() {
    const data = [...tabs.values()].map(describe);
    persistQueue = persistQueue.then(() => write(registryFile, data));
    return persistQueue;
  }
  const input = createAgentInput({
    requireActor: (tab, botId, epoch, mutate) =>
      requireActor(tab, botId, epoch, mutate, overseerBots.has(botId)),
    command: (tab, method, params) => tab.view.webContents.command(method, params),
    botName: (id) => botNames.get(id) || 'Agent',
    isVisible: () => false,
  });
  // Every CDP session that carries a tab's traffic (its own, plus auto-attached
  // frames, workers and pop-ups) maps to the tab whose controller decides.
  const sessionOwner = new Map();
  // Agent tabs get the request filter on every session; giving a tab back
  // turns it off again so human browsing pays nothing.
  function syncFetch(tab) {
    const on = tab.controller === 'agent';
    return Promise.all([...tab.sessions].map((sid) => guardSession(sid, on).catch(() => {})));
  }
  const guardSession = (sid, on) =>
    cdp.send(on ? 'Fetch.enable' : 'Fetch.disable', on ? { patterns: FETCH_ALL } : {}, sid);
  async function attach(data) {
    const wc = await cdp.page(data.targetId);
    const t = { ...data, view: { webContents: wc }, refs: new Set(), generation: 0, queue: Promise.resolve(), sessions: new Set([wc.sessionId]) };
    tabs.set(t.id, t);
    sessionOwner.set(wc.sessionId, { tab: t, targetId: data.targetId });
    // A pop-up's early session was filed under its opener; it belongs to this tab now.
    for (const [sid, entry] of sessionOwner) if (entry.targetId === data.targetId && entry.tab !== t) { entry.tab = t; t.sessions.add(sid); }
    await wc.command('Target.setAutoAttach', AUTO_ATTACH).catch(() => {});
    await syncFetch(t);
    return t;
  }
  const newTarget = async () =>
    (await cdp.send('Target.createTarget', { url: 'about:blank', newWindow: true, background: true })).targetId;
  const closeTarget = (targetId) => cdp.send('Target.closeTarget', { targetId }).catch(() => {});
  const targets = (await cdp.send('Target.getTargets')).targetInfos;
  let registry = [];
  try {
    registry = JSON.parse(fs.readFileSync(registryFile));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  // A restart keeps who holds each tab (the epoch still moves on, so stale
  // refs are refused). Targets lost to a Chromium crash or VM reboot reopen
  // at their saved URL rather than vanishing from the task.
  for (const saved of registry) {
    const controller = saved.controller === 'agent' ? 'agent' : 'human';
    const carried = { ...saved, controller, epoch: (saved.epoch || 0) + 1, ...(controller === 'agent' ? { agentSince: Date.now() } : {}) };
    try {
      const target = targets.find((t) => t.targetId === saved.targetId && t.type === 'page');
      let tab;
      if (target) tab = await attach({ ...carried, url: target.url, title: target.title });
      else {
        tab = await attach({ ...carried, targetId: await newTarget() });
        if (/^https?:\/\//i.test(saved.url)) {
          await tab.view.webContents.command('Page.enable');
          await tab.view.webContents.command('Page.navigate', { url: saved.url });
        }
      }
      if (controller === 'agent') tab.view.webContents.executeJavaScript(tintScript(true)).catch(() => {});
    } catch (e) {
      process.stderr.write(`Could not reattach saved tab ${String(saved.id).slice(0, 40)}: ${e.message}\n`);
      tabs.delete(saved.id);
    }
  }
  await persist();
  const agentIdleMs = Math.max(1, Number(process.env.HERMES_AGENT_IDLE_MINUTES) || 15) * 60000;
  setInterval(() => {
    const now = Date.now();
    for (const t of tabs.values()) {
      if (t.controller !== 'agent' || t.pendingActions > 0 || input.isDispatching(t)) continue;
      if (now - Math.max(t.agentSince || 0, t.lastAgentActivity || 0) <= agentIdleMs) continue;
      t.controller = 'human';
      t.epoch++;
      t.refs.clear();
      syncFetch(t);
      input.clear(t).catch(() => {});
      t.view.webContents.executeJavaScript(tintScript(false)).catch(() => {});
      persist();
    }
  }, 30000).unref();
  cdp.socket.addEventListener('close', () => {
    process.stderr.write('Chromium disconnected; restarting the broker through its service.\n');
    process.exit(1);
  });
  async function open(body, botId, human, prepare) {
    if (body.host !== undefined && body.host !== 'vps')
      throw fail('This connection serves only the VPS browser. Use the Mac connector for Mac tasks.', 503);
    if (!botId || botId.length > 100) throw fail('X-Hermes-Bot is required.');
    if (tabs.size >= 40) throw fail('Close a VPS browser tab before opening another.');
    const url = human ? normalizeUrl(body.url) : agentPageUrl(body.url);
    const targetId = await newTarget();
    let tab;
    try {
      tab = await attach({
        id: crypto.randomUUID(),
        targetId,
        title: 'New VPS tab',
        url: 'about:blank',
        botId,
        allowedBots: [],
        controller: human ? 'human' : 'agent',
        epoch: 1,
        agentSince: human ? undefined : Date.now(),
      });
      await persist();
      await tab.view.webContents.command('Page.enable');
      if (prepare) await prepare(tab);
      await tab.view.webContents.command('Page.navigate', { url });
    } catch (e) {
      if (tab) tabs.delete(tab.id);
      await closeTarget(targetId);
      await persist().catch(() => {});
      throw fail('VPS tab could not be opened and was closed. Retry the open.', 502);
    }
    try {
      // A laptop-close continue must not wait out a slow Docs or Notion load.
      // The tab id is returned immediately; the next snapshot sees loading.
      if (body.settle === false) {
        tab.url = url;
        if (tab.controller === 'agent') tab.view.webContents.executeJavaScript(tintScript(true)).catch(() => {});
        await persist();
        return tab;
      }
      await loaded(tab, url);
      if (tab.controller === 'agent') await tab.view.webContents.executeJavaScript(tintScript(true)).catch(() => {});
      await persist();
      return tab;
    } catch (e) {
      throw fail('VPS tab opened but navigation needs review. List its state before retrying.', 502);
    }
  }
  async function loaded(tab, url, attempts = 80, previous) {
    for (let i = 0; i < attempts; i++) {
      const s = await tab.view.webContents
        .executeJavaScript('({url:location.href,title:document.title,ready:document.readyState})')
        .catch(() => null);
      if ((s && s.url !== 'about:blank' && s.url !== previous && s.ready === 'complete') || (s && url === 'about:blank')) {
        tab.url = s.url;
        tab.title = s.title;
        tab.favicon = await tab.view.webContents
          .executeJavaScript("document.querySelector('link[rel~=icon]')?.href || ''")
          .catch(() => '');
        return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw fail('VPS page is still loading. Inspect it before continuing.', 504);
  }
  // Reload and history entries resolve on dispatch, not on load. Subscribe
  // before triggering so a cached or same-document navigation is not missed.
  async function settle(tab, trigger) {
    const wc = tab.view.webContents;
    await wc.command('Page.enable').catch(() => {});
    let listener, timer;
    const settled = new Promise((resolve) => {
      listener = (m) => {
        if (m.sessionId !== wc.sessionId) return;
        if (m.method === 'Page.loadEventFired' || m.method === 'Page.navigatedWithinDocument' ||
          (m.method === 'Page.frameNavigated' && m.params?.type === 'BackForwardCacheRestore')) resolve();
      };
      cdp.listeners.add(listener);
      timer = setTimeout(resolve, 15000);
    });
    try {
      await trigger();
      await settled;
    } finally {
      clearTimeout(timer);
      cdp.listeners.delete(listener);
    }
    const s = await wc.executeJavaScript('({url:location.href,title:document.title})').catch(() => null);
    if (s) Object.assign(tab, s);
  }
  async function history(tab, action) {
    const wc = tab.view.webContents;
    if (action === 'reload') return settle(tab, () => wc.command('Page.reload'));
    const h = await wc.command('Page.getNavigationHistory');
    const e = h.entries[h.currentIndex + (action === 'back' ? -1 : 1)];
    if (e) await settle(tab, () => wc.command('Page.navigateToHistoryEntry', { entryId: e.id }));
  }
  async function actionControls(tab) {
    try {
      requireAgentRead(tab);
      const controls = await readControls((code) => tab.view.webContents.executeJavaScript(code), tab);
      requireAgentRead(tab);
      return controls;
    } catch (error) {
      if (error && error.status === 409) throw error;
      return null;
    }
  }
  async function vpsPerform(tab, body, botId, overseer, depth = 0) {
    const wc = tab.view.webContents;
    requireActor(tab, botId, body.epoch, true, overseer);
    if (body.action === 'batch') {
      if (depth > 0) throw fail('Batches cannot nest.');
      const steps = Array.isArray(body.steps) ? body.steps.slice(0, 25) : [];
      if (!steps.length) throw fail('batch needs a non-empty steps array (max 25).');
      const results = [], started = Date.now();
      for (const step of steps) {
        if (!step || typeof step !== 'object') { results.push({ error: 'Invalid step.' }); break; }
        if (Date.now() - started > BATCH_BUDGET_MS) { results.push({ error: `batch stopped after ${BATCH_BUDGET_MS / 1000}s; remaining steps were not run. Snapshot, then continue.` }); break; }
        try { results.push(await vpsPerform(tab, { ...step, epoch: body.epoch }, botId, overseer, 1)); }
        catch (error) { results.push({ error: error.message }); break; }
      }
      const controls = await actionControls(tab);
      return { results, ...(controls || {}), dispatched: true };
    }
    if (body.action === 'eval') {
      const code = String(body.code || '');
      if (!code || code.length > 16384) throw fail('eval needs a code string (max 16KB).');
      let value = await Promise.race([
        wc.executeJavaScript(code),
        new Promise((_, reject) => setTimeout(() => reject(fail('eval timed out after 15s.', 408)), 15000)),
      ]);
      const serialized = typeof value === 'string' ? value : JSON.stringify(value);
      if (serialized && serialized.length > 48000) value = serialized.slice(0, 48000) + '…[truncated]';
      return { value, dispatched: true };
    }
    if (body.action === 'wait') {
      const selector = String(body.selector || '').slice(0, 2000);
      const text = String(body.text || '').slice(0, 2000);
      const urlPart = String(body.url || '').slice(0, 2000);
      const visible = body.visible === true;
      const timeout = Math.min(Math.max(Number(body.timeout) || 10000, 100), 30000);
      if (!selector && !text && !urlPart) throw fail('wait needs a selector, text, or url to wait for.');
      const waitCode = (ms) => `new Promise((resolve) => {
        const sel = ${JSON.stringify(selector)}, txt = ${JSON.stringify(text)}, urlP = ${JSON.stringify(urlPart)}, vis = ${visible};
        const deadline = Date.now() + ${ms};
        const check = () => {
          if (urlP && !location.href.includes(urlP)) return false;
          if (sel) {
            const el = document.querySelector(sel);
            if (!el) return false;
            if (vis) {
              const r = el.getBoundingClientRect();
              if (!r.width || !r.height) return false;
              if (el.checkVisibility && !el.checkVisibility({ checkVisibilityCSS: true })) return false;
            }
          }
          if (txt && !(document.body && document.body.innerText.includes(txt))) return false;
          return true;
        };
        const t0 = Date.now();
        let mo, poll;
        const done = (found) => { clearInterval(poll); if (mo) mo.disconnect(); resolve({ found, waited: Date.now() - t0 }); };
        if (check()) return done(true);
        mo = new MutationObserver(() => { if (check()) done(true); });
        mo.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
        poll = setInterval(() => { if (check() || Date.now() > deadline) done(check()); }, 100);
        setTimeout(() => done(check()), ${ms});
      })`;
      const hostStart = Date.now();
      let value = null;
      while (Date.now() - hostStart < timeout + 1000) {
        const remaining = Math.max(400, timeout - (Date.now() - hostStart));
        const attempt = await Promise.race([
          wc.executeJavaScript(waitCode(remaining)).catch(() => ({ navRetry: true })),
          new Promise((r) => setTimeout(() => r({ navRetry: true }), remaining + 1500)),
        ]);
        if (attempt && !attempt.navRetry) { value = attempt; break; }
        if (urlPart && tab.url.includes(urlPart)) { value = { found: true, waited: Date.now() - hostStart }; break; }
        await new Promise((r) => setTimeout(r, 250));
      }
      if (!value || !value.found) throw fail(`wait timed out after ${value ? value.waited : Date.now() - hostStart}ms for ${[selector && `selector ${JSON.stringify(selector)}`, text && `text ${JSON.stringify(text.slice(0, 80))}`, urlPart && `url containing ${JSON.stringify(urlPart.slice(0, 80))}`].filter(Boolean).join(' and ')}. Snapshot the page to see its current state.`, 408);
      return { waited: value.waited, dispatched: true };
    }
    if (body.action === 'viewport') {
      if (body.clear === true) {
        await wc.command('Emulation.clearDeviceMetricsOverride');
        delete tab.viewport;
        return { viewport: null, dispatched: true };
      }
      const width = Math.round(Number(body.width)), height = Math.round(Number(body.height));
      const scale = Math.min(Math.max(Number(body.scale) || 1, 0.1), 5);
      if (!Number.isInteger(width) || !Number.isInteger(height) || width < 100 || width > 7680 || height < 100 || height > 4320)
        throw fail('viewport needs width 100-7680 and height 100-4320, or clear:true.');
      await wc.command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
      tab.viewport = { width, height, scale };
      return { viewport: tab.viewport, dispatched: true };
    }
    if (body.action === 'cdp') {
      const method = String(body.method || '');
      const methodError = cdpMethodError(method);
      if (methodError) throw fail(methodError);
      const params = { ...(body.params && typeof body.params === 'object' ? body.params : {}) };
      if (JSON.stringify(params).length > 64000) throw fail('cdp params too large (max 64KB).');
      if (method === 'Page.navigate') {
        if (typeof params.url !== 'string' || !params.url) throw fail('Page.navigate needs a url string.');
        params.url = agentPageUrl(params.url);
      }
      let value = await Promise.race([
        wc.command(method, params),
        new Promise((_, reject) => setTimeout(() => reject(fail('cdp timed out after 20s.', 408)), 20000)),
      ]);
      const serialized = typeof value === 'string' ? value : JSON.stringify(value);
      if (serialized && serialized.length > 48000) value = serialized.slice(0, 48000) + '…[truncated]';
      return { value, dispatched: true };
    }
    if (INPUT_ACTIONS.has(body.action)) await input.perform(tab, body, botId);
    else if (body.action === 'navigate') {
      await input.clear(tab);
      requireActor(tab, botId, body.epoch, true, overseer);
      const target = agentPageUrl(body.url);
      await wc.command('Page.navigate', { url: target });
      await loaded(tab, target);
    } else if (['back', 'forward', 'reload'].includes(body.action)) {
      await input.clear(tab);
      requireActor(tab, botId, body.epoch, true, overseer);
      await history(tab, body.action);
    } else throw fail('Unsupported VPS action.');
    if (body.action !== 'move') tab.refs.clear();
    const controls = depth === 0 && body.action !== 'move' ? await actionControls(tab) : null;
    return { ...(controls || {}), dispatched: true };
  }
  const mirror = (() => { try { return JSON.parse(fs.readFileSync(mirrorFile)).bots || {}; } catch { return {}; } })();
  const saveMirror = () => write(mirrorFile, { bots: mirror });
  const mirrorFresh = (entry) => entry && Number(entry.updatedAt) > Date.now() - MIRROR_TTL_MS;
  // A mirror the app stopped refreshing (app closed, bot removed) must not
  // resurrect an old task on a failover days later.
  for (const bot of Object.keys(mirror)) {
    if (!mirrorFresh(mirror[bot]) || !Array.isArray(mirror[bot].tabs)) delete mirror[bot];
    else for (const key of ['restored', 'restoredAt', 'verification', 'restoredUrl']) mirror[bot][key] ||= {};
  }
  saveMirror();
  const finite = (v, max) => (Number.isFinite(Number(v)) ? Math.max(0, Math.min(max, Number(v))) : 0);
  const SECRET_FIELD = /password|passwd|secret|token|otp|one.time|credit|card|cc-|cvc|cvv/i;
  function cleanMirrorTab(t) {
    if (!t || !/^[\w-]{1,100}$/.test(String(t.id)) || typeof t.url !== 'string' || t.url.length > 2000 || !/^https?:\/\//i.test(t.url)) return null;
    const drafts = (Array.isArray(t.drafts) ? t.drafts : [])
      .filter((d) => d && typeof d.selector === 'string' && d.selector.length < 500 && typeof d.value === 'string' && d.value.length <= 10000 && d.type !== 'password' && !SECRET_FIELD.test(d.selector))
      .slice(0, 30)
      .map((d) => ({ selector: d.selector, tag: String(d.tag || ''), type: String(d.type || ''), editable: d.editable === true, value: d.value }));
    const cookies = (Array.isArray(t.cookies) ? t.cookies : [])
      .filter((c) => c && typeof c.name === 'string' && typeof c.value === 'string' && c.name.length <= 4096 && c.value.length <= 8192 && /^\.?[\w.-]{1,253}$/.test(String(c.domain)) && typeof c.path === 'string' && c.path.startsWith('/'))
      .slice(0, 150)
      .map((c) => ({
        name: c.name, value: c.value, domain: c.domain, path: c.path,
        expires: c.session === true || !(Number(c.expires) > 0) ? -1 : Number(c.expires),
        httpOnly: c.httpOnly === true, secure: c.secure === true, session: c.session === true || !(Number(c.expires) > 0),
        ...(['Strict', 'Lax', 'None'].includes(c.sameSite) ? { sameSite: c.sameSite } : {}),
      }));
    return { id: String(t.id), url: t.url, title: String(t.title || '').slice(0, 300), scroll: { x: finite(t.scroll?.x, 1e7), y: finite(t.scroll?.y, 1e7) }, drafts, cookies };
  }
  function saveMirrorEntry(body) {
    if (typeof body.bot !== 'string' || !body.bot || body.bot.length > 100) throw fail('mirror needs a bot id.');
    if (!Array.isArray(body.tabs)) throw fail('mirror needs a tabs array.');
    const previous = mirror[body.bot];
    const entry = {
      updatedAt: Math.max(Date.now(), (previous?.updatedAt || 0) + 1),
      tabs: body.tabs.slice(0, 40).map(cleanMirrorTab).filter(Boolean),
      restored: previous?.restored || {}, restoredAt: previous?.restoredAt || {}, verification: previous?.verification || {}, restoredUrl: previous?.restoredUrl || {},
    };
    mirror[body.bot] = entry;
    saveMirror();
    return { stored: entry.tabs.length, updatedAt: entry.updatedAt };
  }
  const cookieParams = (t) => t.cookies.filter((c) => c.session || c.expires > Date.now() / 1000).map(({ session, expires, domain, ...c }) => ({
    ...c,
    ...(session ? {} : { expires }),
    ...(domain.startsWith('.') ? { domain } : { url: `${c.secure ? 'https' : 'http'}://${domain}${c.path}` }),
  }));
  // One bad cookie rejects a whole Network.setCookies call; retry singly so
  // the rest of the site's session still lands.
  async function setCookies(tab, cookies) {
    if (!cookies.length) return;
    const wc = tab.view.webContents;
    try { await wc.command('Network.setCookies', { cookies }); } catch {
      for (const cookie of cookies) await wc.command('Network.setCookie', cookie).catch(() => {});
    }
  }
  // Brings one mirrored tab to the VM: a new tab, or the one an earlier restore
  // opened when the mirror has moved on since. The load wait is short (a slow
  // page is reported review_required rather than holding up the failover).
  async function restoreTab(bot, entry, t) {
    const at = entry.updatedAt;
    let url;
    try { url = agentPageUrl(t.url); } catch { return null; }
    let tab = tabs.get(entry.restored[t.id]);
    if (tab && (entry.restoredAt[t.id] || 0) >= at) return { tab, verification: entry.verification[t.id] || 'review_required' };
    // A tab the human holds is theirs: never navigated, never claimed. One the
    // agent has moved on with (or is acting in) keeps its work.
    if (tab && tab.controller === 'human') return { tab, verification: 'human_has_control' };
    if (tab && (tab.url !== entry.restoredUrl[t.id] || tab.pendingActions > 0 || input.isDispatching(tab)))
      return { tab, verification: entry.verification[t.id] || 'review_required' };
    const cookies = cookieParams(t);
    let previous;
    if (tab) {
      previous = tab.url === url ? undefined : tab.url;
      await setCookies(tab, cookies);
      tab.controller = 'agent';
      tab.agentSince = Date.now();
      tab.epoch++;
      tab.refs.clear();
      await syncFetch(tab);
      await input.clear(tab);
      await tab.view.webContents.command('Page.navigate', { url });
      tab.view.webContents.executeJavaScript(tintScript(true)).catch(() => {});
    } else tab = await open({ url, settle: false }, bot, false, (opened) => setCookies(opened, cookies));
    const ready = await loaded(tab, url, RESTORE_LOAD_ATTEMPTS, previous).then(() => true, () => false);
    const result = ready ? await tab.view.webContents.executeJavaScript(restoreExpression({ url: t.url, scroll: t.scroll, drafts: t.drafts })).catch(() => null) : null;
    const verification = result?.verification || 'review_required';
    const live = mirror[bot];
    if (live) { live.restored[t.id] = tab.id; live.restoredAt[t.id] = at; live.verification[t.id] = verification; live.restoredUrl[t.id] = tab.url; }
    return { tab, verification };
  }
  // Restores are serialized per host (a retry after a timeout returns the tabs
  // already opened) and run RESTORE_PARALLEL tabs at a time inside one call.
  let restoreQueue = Promise.resolve();
  function restoreMirror(bot) {
    const run = restoreQueue.then(async () => {
      const entry = mirror[bot], map = {}, verification = {};
      if (!mirrorFresh(entry)) return { map, verification };
      const results = new Array(entry.tabs.length);
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(RESTORE_PARALLEL, entry.tabs.length) }, async () => {
        while (next < entry.tabs.length) {
          const index = next++;
          try { results[index] = await restoreTab(bot, entry, entry.tabs[index]); } catch (e) {
            process.stderr.write(`Mirror restore skipped ${entry.tabs[index].id}: ${e.message}\n`);
          }
        }
      }));
      entry.tabs.forEach((t, index) => {
        if (!results[index]) return;
        map[t.id] = results[index].tab.id;
        verification[t.id] = results[index].verification;
      });
      saveMirror();
      return { map, verification };
    });
    restoreQueue = run.catch(() => {});
    return run;
  }
  // A tab an agent holds never rests on a blocked address, whichever way it
  // got there (redirect, window.open, eval). The tab says why.
  function sendBack(tab, url, problem) {
    tab.blocked = { url: String(url).slice(0, 500), reason: problem, at: Date.now() };
    tab.refs.clear();
    tab.view.webContents.command('Page.navigate', { url: 'about:blank' }).catch(() => {});
    persist().catch(() => {});
  }
  cdp.listeners.add((event) => {
    if (event.method === 'Fetch.requestPaused') {
      const owner = sessionOwner.get(event.sessionId)?.tab;
      const problem = owner?.controller === 'agent' ? agentUrlProblem(event.params.request?.url) : '';
      if (problem && owner.blocked?.url !== event.params.request.url) {
        owner.blocked = { url: String(event.params.request.url).slice(0, 500), reason: problem, at: Date.now() };
        persist().catch(() => {});
      }
      cdp.send(problem ? 'Fetch.failRequest' : 'Fetch.continueRequest',
        problem ? { requestId: event.params.requestId, errorReason: 'BlockedByClient' } : { requestId: event.params.requestId },
        event.sessionId).catch(() => {});
    }
    // New pages, frames and workers start paused. The filter goes on before
    // they run, and they are always released, even when guarding fails.
    if (event.method === 'Target.attachedToTarget') {
      const { sessionId, targetInfo, waitingForDebugger } = event.params;
      (async () => {
        try {
          const own = [...tabs.values()].some((t) => t.targetId === targetInfo.targetId);
          const owner = event.sessionId ? sessionOwner.get(event.sessionId)?.tab
            : own ? null : [...sessionOwner.values()].find((e) => e.targetId === targetInfo.openerId)?.tab;
          if (owner) {
            sessionOwner.set(sessionId, { tab: owner, targetId: targetInfo.targetId });
            owner.sessions.add(sessionId);
            if (owner.controller === 'agent' && /^(page|iframe)$/.test(targetInfo.type)) await guardSession(sessionId, true);
            if (/^(page|iframe|worker)$/.test(targetInfo.type)) await cdp.send('Target.setAutoAttach', AUTO_ATTACH, sessionId).catch(() => {});
          }
        } catch (e) {
          process.stderr.write(`Could not guard ${targetInfo.type} target: ${e.message}\n`);
        } finally {
          if (waitingForDebugger) cdp.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
        }
      })();
    }
    if (event.method === 'Target.detachedFromTarget') {
      const entry = sessionOwner.get(event.params.sessionId);
      if (entry) { entry.tab.sessions.delete(event.params.sessionId); sessionOwner.delete(event.params.sessionId); }
    }
    if (event.method === 'Target.targetInfoChanged') {
      const info = event.params.targetInfo;
      const tab = [...tabs.values()].find((t) => t.targetId === info.targetId);
      if (tab) {
        const moved = info.url !== tab.url;
        tab.url = info.url;
        tab.title = info.title;
        if (moved) tab.refs.clear();
        const problem = tab.controller === 'agent' ? agentUrlProblem(info.url) : '';
        if (problem && moved) sendBack(tab, info.url, problem);
        else if (moved && tab.controller === 'agent') {
          if (tab.blocked && info.url !== 'about:blank' && !info.url.startsWith('chrome-error:')) tab.blocked = null;
          tab.view.webContents.executeJavaScript(tintScript(true)).catch(() => {});
        }
        persist().catch(() => {});
      }
    }
    if (event.method === 'Target.targetDestroyed') {
      const tab = [...tabs.values()].find((t) => t.targetId === event.params.targetId);
      if (tab) {
        tabs.delete(tab.id);
        persist().catch(() => {});
      }
    }
    if (event.method === 'Target.targetCreated') {
      const info = event.params.targetInfo;
      const parent = [...tabs.values()].find((t) => t.targetId === info.openerId);
      if (info.type === 'page' && parent && ![...tabs.values()].some((t) => t.targetId === info.targetId)) {
        const problem = parent.controller === 'agent' ? agentUrlProblem(info.url) : '';
        if (problem) {
          parent.blocked = { url: String(info.url).slice(0, 500), reason: problem, at: Date.now() };
          closeTarget(info.targetId);
          persist().catch(() => {});
        } else
          attach({
            id: crypto.randomUUID(),
            targetId: info.targetId,
            title: info.title,
            url: info.url,
            botId: parent.botId,
            allowedBots: [],
            controller: parent.controller,
            epoch: 1,
          })
            .then(persist)
            .catch(() => {});
      }
    }
  });
  await cdp.send('Target.setDiscoverTargets', { discover: true });
  await cdp.send('Target.setAutoAttach', AUTO_ATTACH);
  const token = crypto.randomBytes(32).toString('hex');
  const appToken = crypto.randomBytes(32).toString('hex');
  write(appTokenFile(), { token: appToken });
  let inFlight = 0;
  const server = http.createServer(async (req, res) => {
    inFlight++;
    res.on('close', () => { inFlight = Math.max(0, inFlight - 1); });
    const send = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(data));
    };
    const isApp = isAuthorized(req.headers.authorization, appToken);
    if (req.headers.origin || !(isApp || isAuthorized(req.headers.authorization, token)))
      return send(401, { error: 'Unauthorized' });
    if (cdp.socket.readyState !== 1)
      return send(503, { error: 'VPS Chromium disconnected. Inspect task state before retrying.' });
    try {
      const url = new URL(req.url, 'http://127.0.0.1'),
        botId = String(req.headers['x-hermes-bot'] || ''),
        human = req.headers['x-hermes-human'] === '1',
        overseer = overseerBots.has(botId);
      if (human && !isApp) throw fail('Human-only operations need the app token.', 403);
      try {
        const botName = decodeURIComponent(String(req.headers['x-hermes-bot-name'] || '')).slice(0, 80);
        if (botId && botName) botNames.set(botId, botName);
      } catch {}
      if (url.pathname === '/v1/status')
        return send(200, {
          name: 'Hermes VPS browser',
          version: '0.1.5',
          host: 'vps',
          protocol: 1,
          session: 'shared-vps',
          capabilities: ['tabs', 'snapshot', 'screenshot', 'background-input', 'control-epochs', 'checkpoint'],
          tabCount: tabs.size,
        });
      if (url.pathname === '/v1/tabs' && req.method === 'GET')
        return send(200, {
          tabs: [...tabs.values()]
            .filter((t) => human || overseer || t.botId === botId || (t.allowedBots ?? []).includes(botId))
            .map(describe),
        });
      if (url.pathname === '/v1/tabs' && req.method === 'POST')
        return send(201, describe(await open(await read(req), botId, human)));
      if (url.pathname === '/v1/mirror' && req.method === 'POST') {
        if (!isApp) throw fail('Only the app may update the mirror.', 403);
        return send(200, saveMirrorEntry(await read(req, 4000000)));
      }
      if (url.pathname === '/v1/restore' && req.method === 'POST') {
        const body = await read(req);
        if (typeof body.bot !== 'string' || !body.bot || body.bot.length > 100) throw fail('restore needs a bot id.');
        if (!isApp && !overseer && body.bot !== botId) throw fail('This mirror belongs to a different bot.', 403);
        return send(200, await restoreMirror(body.bot));
      }
      const m =
          /^\/v1\/tabs\/([\w-]+)(?:\/(snapshot|screenshot|actions|human-actions|control|activate|checkpoint|restore|grant))?$/.exec(
            url.pathname,
          ),
        tab = m && tabs.get(m[1]);
      if (!tab) throw fail('VPS tab not found.', 404);
      if (!human) requireActor(tab, botId, undefined, false, overseer);
      const wc = tab.view.webContents;
      if (req.method === 'GET' && !m[2]) return send(200, describe(tab));
      if (!human) tab.lastAgentActivity = Date.now();
      if (req.method === 'GET' && m[2] === 'snapshot') {
        if (!human) requireAgentRead(tab);
        const opts = {
          maxChars: intParam(url, 'maxChars', 0, 20000),
          maxElements: intParam(url, 'maxElements', 0, 300),
          since: intParam(url, 'since', 0, Number.MAX_SAFE_INTEGER),
        };
        const work = tab.queue.then(async () => {
          const generation = ++tab.generation;
          let timer;
          const data = await Promise.race([
            wc.executeJavaScript(snapshotExpression(generation, { ...opts, keep: tab.snapshotStamp?.base, restamp: tab.snapshotStamp?.base })),
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(fail('Snapshot timed out after 10s. The page may be unresponsive.', 503)), 10000);
            }),
          ]).finally(() => clearTimeout(timer));
          if (!data || !Array.isArray(data.elements)) throw fail('Snapshot returned no page data.', 503);
          tab.url = data.url;
          tab.title = data.title;
          return { ...settleSnapshot(tab, data, generation, opts.since), tab: describe(tab) };
        });
        tab.queue = work.catch(() => {});
        return send(200, await work);
      }
      if (req.method === 'GET' && m[2] === 'screenshot') {
        if (!human) requireAgentRead(tab);
        const format = url.searchParams.get('format') ?? 'jpeg';
        if (!['jpeg', 'png', 'webp'].includes(format)) throw fail('format must be jpeg, png, or webp.');
        const quality = intParam(url, 'quality', 1, 100) ?? 50;
        const maxWidth = intParam(url, 'maxWidth', 1, 10000) ?? 960;
        const capture = tab.queue.then(async () => {
          const viewport = await wc.executeJavaScript(
            '({width:innerWidth,height:innerHeight,deviceScaleFactor:devicePixelRatio})',
          );
          // No resize post-capture here: clip.scale is the downscale knob,
          // keeping the emitted image at maxWidth pixels when it would exceed it.
          const dsf = viewport.deviceScaleFactor || 1;
          const scale = viewport.width * dsf > maxWidth ? Math.max(0.01, maxWidth / viewport.width) : dsf;
          const params = { format, fromSurface: true, clip: { x: 0, y: 0, width: viewport.width, height: viewport.height, scale } };
          if (format !== 'png') params.quality = quality;
          return { shot: await wc.command('Page.captureScreenshot', params), viewport };
        });
        tab.queue = capture.catch(() => {});
        const { shot, viewport } = await capture;
        return send(200, { base64: shot.data, mimeType: { jpeg: 'image/jpeg', webp: 'image/webp', png: 'image/png' }[format], viewport, tab: describe(tab) });
      }
      if (req.method === 'POST' && m[2] === 'actions') {
        const body = await read(req);
        tab.pendingActions = (tab.pendingActions || 0) + 1;
        const action = tab.queue.then(async () => {
          const result = await vpsPerform(tab, body, botId, overseer);
          await persist();
          return { ...result, tab: describe(tab) };
        }).finally(() => {
          tab.pendingActions--;
          if (!human) tab.lastAgentActivity = Date.now();
        });
        tab.queue = action.catch(() => {});
        return send(200, await action);
      }
      if ((human || overseer || botId === tab.botId) && req.method === 'POST' && m[2] === 'control') {
        const body = await read(req);
        if (!human && body.controller === 'agent') { requireAgentClaim(tab); tab.handoff = reviewedHandoff(tab.handoff); }
        if (human && body.handoff?.phase === 'handed_off')
          tab.handoff = {
            id: String(body.handoff.id || '').slice(0, 100),
            phase: 'handed_off',
            sourceHost: 'vps',
            destinationHost: body.handoff.destinationHost === 'mac' ? 'mac' : 'vps',
            destinationTabId: String(body.handoff.destinationTabId || '').slice(0, 100),
            createdAt: Number(body.handoff.createdAt) || Date.now(),
          };
        else if (human && body.controller === 'agent') tab.handoff = reviewedHandoff(tab.handoff);
        tab.controller = body.controller === 'agent' ? 'agent' : 'human';
        if (tab.controller === 'agent') tab.agentSince = Date.now();
        tab.epoch++;
        tab.refs.clear();
        await syncFetch(tab);
        await input.clear(tab);
        await wc.executeJavaScript(tintScript(tab.controller === 'agent')).catch(() => {});
        await persist();
        return send(200, describe(tab));
      }
      if (human && req.method === 'POST' && m[2] === 'activate') {
        await cdp.send('Target.activateTarget', { targetId: tab.targetId });
        return send(200, describe(tab));
      }
      if (human && req.method === 'POST' && m[2] === 'human-actions') {
        if (tab.controller !== 'human') throw fail('Take control before navigating.', 409);
        const body = await read(req),
          epoch = tab.epoch;
        const operation = tab.queue.then(async () => {
          if (tab.controller !== 'human' || tab.epoch !== epoch) throw fail('Control changed. Inspect the tab.', 409);
          if (body.action === 'navigate') {
            const target = normalizeUrl(body.url);
            await wc.command('Page.navigate', { url: target });
            await loaded(tab, target);
          } else if (['back', 'forward', 'reload'].includes(body.action)) await history(tab, body.action);
          else throw fail('Unsupported human browser navigation.');
          tab.refs.clear();
          await persist();
          return { tab: describe(tab) };
        });
        tab.queue = operation.catch(() => {});
        return send(200, await operation);
      }
      if (human && req.method === 'POST' && m[2] === 'grant') {
        const body = await read(req);
        if (typeof body.botId === 'string' && body.botId.length && body.botId.length <= 100) tab.botId = body.botId;
        tab.allowedBots = [
          ...new Set(
            (body.botIds || []).filter(
              (id) => typeof id === 'string' && id.length && id.length <= 100 && id !== tab.botId,
            ),
          ),
        ];
        tab.epoch++;
        tab.refs.clear();
        await input.clear(tab);
        await persist();
        return send(200, describe(tab));
      }
      if (human && req.method === 'POST' && m[2] === 'checkpoint') {
        if (tab.controller !== 'human') throw fail('Take control before checkpointing.', 409);
        const body = await read(req);
        await tab.queue;
        return send(200, await wc.executeJavaScript(checkpointExpression(body.includeDrafts)));
      }
      if (human && req.method === 'POST' && m[2] === 'restore') {
        if (tab.controller !== 'human') throw fail('Destination must remain under human review.', 409);
        const body = await read(req);
        await tab.queue;
        const result = await wc.executeJavaScript(restoreExpression(body.checkpoint));
        tab.handoff = {
          ...body.handoff,
          destinationTabId: tab.id,
          verification: result.verification,
          restoredDrafts: result.restored,
          skippedDrafts: result.skipped,
        };
        await persist();
        return send(200, { ...result, tab: describe(tab) });
      }
      if (req.method === 'DELETE' && !m[2]) {
        if (!human) requireActor(tab, botId, Number(req.headers['x-control-epoch']), true, overseer);
        tab.epoch++;
        await input.clear(tab);
        await cdp.send('Target.closeTarget', { targetId: tab.targetId });
        tabs.delete(tab.id);
        await persist();
        return send(200, { closed: true });
      }
      throw fail('Unsupported VPS operation.', 405);
    } catch (e) {
      send(e.status || 400, { error: e.message });
    }
  });
  const port = cfg.port || 9465;
  // 78 (EX_CONFIG) lets the service unit stop restarting a broker that can
  // never bind, via RestartPreventExitStatus=78.
  server.on('error', (e) => {
    process.stderr.write(e.code === 'EADDRINUSE'
      ? `VPS browser host cannot listen on 127.0.0.1:${port}: port already in use. Stop the other broker or set a different "port" in config.json.\n`
      : `VPS browser host cannot listen: ${e.message}\n`);
    process.exit(e.code === 'EADDRINUSE' ? 78 : 1);
  });
  server.listen(port, '127.0.0.1', () => {
    write(connectionFile, { url: 'http://127.0.0.1:' + server.address().port, token, protocol: 1, host: 'vps' });
    process.stderr.write('VPS browser host ready on loopback.\n');
  });
  let startedMtime = 0;
  try { startedMtime = fs.statSync(__filename).mtimeMs; } catch { /* a missing script has nothing newer to load */ }
  const reloadTimer = setInterval(() => {
    let mtime = startedMtime;
    try { mtime = fs.statSync(__filename).mtimeMs; } catch { return; }
    if (!hostShouldReload(mtime, startedMtime, inFlight)) return;
    process.stderr.write('vps-browser-host: script replaced; exiting so the service loads it\n');
    process.exit(1);
  }, 5000);
  reloadTimer.unref();
}
if (require.main === module) {
  const mode = process.argv[2];
  if (mode === 'serve')
    serve().catch((e) => {
      process.stderr.write(e.message + '\n');
      process.exit(1);
    });
  else if (mode === 'request') {
    let bytes = 0,
      text = '';
    process.stdin.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 4100000) process.exit(1);
      text += chunk;
    });
    // ASCII only: a PowerShell default shell on a Windows VM re-encodes anything else.
    process.stdin.on('end', () =>
      Promise.resolve()
        .then(() => JSON.parse(text))
        .then(request)
        .then((data) => process.stdout.write(JSON.stringify(data).replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))))
        .catch(() => {
          process.stdout.write(
            JSON.stringify({
              status: 503,
              data: { error: 'VPS browser host unavailable. Check its service and Chromium.' },
            }),
          );
        }),
    );
  } else {
    process.stderr.write(
      'Usage: vps-browser-host.cjs serve | request\nConfiguration lives in HERMES_VPS_BROWSER_DATA/config.json or the default private browser data directory.\n',
    );
    process.exit(1);
  }
}
