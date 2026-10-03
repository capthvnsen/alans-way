const { app, BrowserWindow, WebContentsView, ipcMain, Menu, dialog, clipboard, shell, nativeTheme } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { normalizeUrl, parseRemoteUrl, requireActor, isAuthorized, sanitizeBots } = require('./core.cjs');

app.setName('Hermes Workspace');
if (process.env.HERMES_WORKSPACE_DATA) app.setPath('userData', path.resolve(process.env.HERMES_WORKSPACE_DATA));
const ROOT = __dirname;
const TELEGRAM = 'https://web.telegram.org/a/';
let win, telegramView, remoteView, apiServer, prefs, layout = {}, apiPort = 0;
let activeTabId = 'home', apiError = '', remoteStatus = 'disconnected', telegramStatus = 'loading', telegramDiagnostics = {};
const tabs = new Map();
const configuredSessions = new WeakSet();
const API_TOKEN = crypto.randomBytes(32).toString('hex');
let isQuitting = false;

function readPreferences() {
  const defaults = { bots: [], order: [], hidden: [], selectedBotId: '', accountId: '', remoteUrl: '', chatWidth: 490, preview: true, savedTabs: [] };
  try { return { ...defaults, ...JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'preferences.json'), 'utf8')) }; }
  catch { return { ...defaults, remoteUrl: process.env.HERMES_WORKSPACE_VPS_URL || '' }; }
}
function savePreferences() {
  if (!prefs) return;
  prefs.savedTabs = [...tabs.values()].map((tab) => ({ url: tab.view.webContents.getURL(), botId: tab.botId }));
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  const file = path.join(app.getPath('userData'), 'preferences.json');
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(prefs, null, 2), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}
function describeTab(tab) {
  return { id: tab.id, title: tab.title || 'New tab', url: tab.view.webContents.getURL(), botId: tab.botId,
    controller: tab.controller, epoch: tab.epoch, loading: tab.loading, error: tab.error || '', allowedBots: tab.allowedBots };
}
function getState() {
  return { name: app.getName(), version: app.getVersion(), bots: prefs.bots, order: prefs.order, hidden: prefs.hidden,
    selectedBotId: prefs.selectedBotId, chatWidth: prefs.chatWidth, preview: prefs.preview, remoteUrl: prefs.remoteUrl,
    remoteStatus, remoteControl: prefs.remoteControl === true, telegramStatus, tabs: [...tabs.values()].map(describeTab),
    activeTabId, fullscreen: win?.isFullScreen() || false, api: { url: apiPort ? `http://127.0.0.1:${apiPort}` : '', ready: !!apiPort, error: apiError } };
}
function broadcast() {
  if (!win || win.isDestroyed() || !prefs) return;
  const state = getState();
  win.webContents.send('workspace:state', state);
  if (remoteView && !remoteView.webContents.isDestroyed()) remoteView.webContents.send('workspace:state', state);
}
function fit(view, rect) {
  if (!view || view.webContents.isDestroyed()) return;
  if ([...tabs.values()].some(tab => tab.view === view && tab.capturing)) return;
  if (!rect || rect.width < 1 || rect.height < 1 || layout.obscured) { view.setVisible(false); return; }
  const size = win.getContentBounds();
  const x = Math.max(0, Math.round(rect.x)), y = Math.max(0, Math.round(rect.y));
  view.setBounds({ x, y, width: Math.max(1, Math.min(Math.round(rect.width), size.width - x)), height: Math.max(1, Math.min(Math.round(rect.height), size.height - y)) });
  view.setVisible(true);
}
function applyLayout() {
  fit(telegramView, layout.telegram);
  for (const tab of tabs.values()) fit(tab.view, activeTabId === tab.id ? layout.browser : null);
  fit(remoteView, activeTabId === 'vps' ? layout.browser : prefs.preview ? layout.preview : null);
  if (remoteView) win.contentView.addChildView(remoteView);
}
function configureContents(contents, isTelegram = false) {
  contents.setWindowOpenHandler((details) => {
    let url;
    try { url = normalizeUrl(details.url); } catch { return { action: 'deny' }; }
    return { action: 'allow', createWindow: (options) => {
      const parent = [...tabs.values()].find((tab) => tab.view.webContents === contents);
      const tab = createTab({ url, botId: parent?.botId || prefs.selectedBotId || 'shared', controller: parent?.controller || 'human', options, skipLoad: details.disposition !== 'background-tab' });
      return tab.view.webContents;
    } };
  });
  contents.on('will-navigate', (event, url) => {
    if (isTelegram && !url.startsWith(TELEGRAM)) { event.preventDefault(); try { createTab({ url }); } catch {} }
    else if (!isTelegram && !/^https?:\/\//i.test(url) && url !== 'about:blank') event.preventDefault();
  });
  contents.on('before-input-event', (event, input) => {
    if ((input.meta || input.control) && input.type === 'keyDown') {
      const key = input.key.toLowerCase();
      if (key === 'l') { event.preventDefault(); win.webContents.send('workspace:focus-address'); }
      if (key === 't') { event.preventDefault(); createTab({}); }
      if (key === 'w' && !isTelegram && activeTabId !== 'home') { event.preventDefault(); closeTab(activeTabId); }
    }
  });
  const session = contents.session;
  if (configuredSessions.has(session)) return;
  configuredSessions.add(session);
  session.setPermissionRequestHandler(async (wc, permission, callback, details) => {
    if (permission === 'fullscreen') return callback(true);
    const tab = [...tabs.values()].find((item) => item.view.webContents === wc);
    if (tab && (tab.id !== activeTabId || tab.controller === 'agent')) return callback(false);
    const allowedTypes = ['media', 'notifications', 'clipboard-read', 'geolocation'];
    if (!allowedTypes.includes(permission)) return callback(false);
    let host = 'This page';
    try { host = new URL(details.requestingUrl || wc.getURL()).hostname; } catch {}
    const answer = await dialog.showMessageBox(win, { type: 'question', buttons: ['Don’t allow', 'Allow once'], defaultId: 0,
      message: `${host} wants ${permission === 'media' ? 'camera or microphone access' : permission}.` });
    callback(answer.response === 1);
  });
  session.on('will-download', (_event, item) => {
    if (item.getState() !== 'interrupted') item.setSaveDialogOptions({ title: 'Save download' });
  });
}
function createTab({ url = 'about:blank', botId = prefs.selectedBotId || 'shared', controller = 'human', options, skipLoad = false, activate = true } = {}) {
  if (tabs.size >= 40) throw new Error('Close a tab before opening another.');
  const targetUrl = normalizeUrl(url);
  const view = new WebContentsView({ ...(options?.webContents ? { webContents: options.webContents } : {}),
    webPreferences: { ...options?.webPreferences, preload: undefined, partition: 'persist:browser', contextIsolation: true, nodeIntegration: false, sandbox: true,
      webSecurity: true, backgroundThrottling: false } });
  view.setBackgroundColor('#0b0b0c');
  const tab = { id: crypto.randomUUID(), view, botId: String(botId).slice(0, 100), controller, epoch: 1, title: 'New tab', loading: false, allowedBots: [], refs: new Set(), generation: 0, queue: Promise.resolve() };
  tabs.set(tab.id, tab);
  win.contentView.addChildView(view);
  // Background agent tabs still need a real viewport for layout and screenshots.
  const viewport = layout.browser || { x: 0, y: 0, width: 900, height: 700 };
  view.setBounds({ x: Math.round(viewport.x), y: Math.round(viewport.y), width: Math.round(viewport.width), height: Math.round(viewport.height) });
  configureContents(view.webContents);
  view.webContents.on('page-title-updated', (_event, title) => { tab.title = title; broadcast(); });
  view.webContents.on('did-start-loading', () => { tab.loading = true; tab.error = ''; broadcast(); });
  view.webContents.on('did-stop-loading', () => { tab.loading = false; savePreferences(); broadcast(); });
  view.webContents.on('did-navigate', () => { tab.refs.clear(); tab.generation++; broadcast(); });
  view.webContents.on('did-navigate-in-page', () => { tab.refs.clear(); tab.generation++; broadcast(); });
  view.webContents.on('did-fail-load', (_e, code, description, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) { tab.error = description; tab.loading = false; broadcast(); }
  });
  view.webContents.on('render-process-gone', () => { tab.error = 'This page stopped. Reload to reconnect.'; broadcast(); });
  if (activate) activeTabId = tab.id;
  applyLayout(); broadcast();
  if (!skipLoad) view.webContents.loadURL(targetUrl).catch(() => {});
  return tab;
}
function closeTab(id) {
  if (id === 'home' || id === 'vps') { activeTabId = 'home'; applyLayout(); broadcast(); return; }
  const tab = tabs.get(id);
  if (!tab) return;
  tabs.delete(id);
  win.contentView.removeChildView(tab.view);
  tab.view.webContents.close();
  if (activeTabId === id) activeTabId = [...tabs.keys()].at(-1) || 'home';
  savePreferences(); applyLayout(); broadcast();
}
function changeController(id, controller) {
  const tab = tabs.get(id);
  if (!tab) throw new Error('Tab not found.');
  tab.controller = controller === 'agent' ? 'agent' : 'human';
  if (tab.controller === 'agent' && tab.botId === 'shared' && prefs.selectedBotId) tab.botId = prefs.selectedBotId;
  tab.epoch++;
  tab.refs.clear();
  broadcast();
  return describeTab(tab);
}
function trustSender(event) {
  const trusted = [win?.webContents, remoteView?.webContents];
  if (!trusted.includes(event.sender) || event.senderFrame !== event.sender.mainFrame || !event.sender.getURL().startsWith('file:')) {
    throw new Error('Untrusted workspace request.');
  }
}
async function openBot(id) {
  if (!prefs.bots.some((bot) => bot.id === id)) throw new Error('Select a verified Telegram bot.');
  prefs.selectedBotId = id;
  savePreferences(); broadcast();
  const selected = await telegramView.webContents.executeJavaScript(`(() => {
    const link = [...document.querySelectorAll('#LeftColumn a[href]')].find(el => el.hash?.slice(1).split('_')[0] === '${id}');
    if (link) {
      link.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
      link.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
      link.click(); return true;
    } return false;
  })()`).catch(() => false);
  if (!selected) {
    await telegramView.webContents.loadURL(`${TELEGRAM}#${id}`).catch(() => {});
    telegramView.webContents.reload();
  }
}
function registerIpc() {
  ipcMain.handle('workspace:get', (event) => { trustSender(event); return getState(); });
  ipcMain.on('workspace:layout', (event, value) => { try { trustSender(event); layout = value || {}; applyLayout(); } catch {} });
  ipcMain.handle('workspace:command', async (event, command, value = {}) => {
    trustSender(event);
    switch (command) {
      case 'create-tab': return describeTab(createTab({ url: value.url || 'about:blank' }));
      case 'close-tab': closeTab(value.id); break;
      case 'activate': activeTabId = tabs.has(value.id) || ['home', 'vps'].includes(value.id) ? value.id : 'home'; applyLayout(); break;
      case 'navigate': {
        const tab = tabs.get(value.id); if (tab) { changeController(tab.id, 'human'); await tab.view.webContents.loadURL(normalizeUrl(value.url)).catch(() => {}); } break;
      }
      case 'history': {
        const tab = tabs.get(value.id); if (!tab) break;
        changeController(tab.id, 'human'); const history = tab.view.webContents.navigationHistory;
        if (value.action === 'back' && history.canGoBack()) history.goBack();
        if (value.action === 'forward' && history.canGoForward()) history.goForward();
        if (value.action === 'reload') tab.view.webContents.reload(); break;
      }
      case 'control': return changeController(value.id, value.controller);
      case 'grant-tab': {
        const tab = tabs.get(value.id); if (!tab) throw new Error('Tab not found.');
        if (typeof value.botId === 'string' && value.botId.length > 0 && value.botId.length <= 100) tab.botId = value.botId;
        tab.allowedBots = Array.isArray(value.botIds) ? [...new Set(value.botIds.filter(id => typeof id === 'string' && id.length > 0 && id.length <= 100 && id !== tab.botId))] : [];
        tab.epoch++; tab.refs.clear(); break;
      }
      case 'open-bot': await openBot(String(value.id)); break;
      case 'sort-bots': prefs.order = Array.isArray(value.ids) ? value.ids.filter((id) => prefs.bots.some((bot) => bot.id === id)) : prefs.order; savePreferences(); break;
      case 'hide-bot': if (!prefs.hidden.includes(value.id)) prefs.hidden.push(value.id); savePreferences(); break;
      case 'restore-bots': prefs.hidden = []; savePreferences(); break;
      case 'settings':
        if (typeof value.remoteUrl === 'string') { parseRemoteUrl(value.remoteUrl); prefs.remoteUrl = value.remoteUrl; remoteStatus = 'disconnected'; prefs.remoteControl = false; }
        if (typeof value.preview === 'boolean') prefs.preview = value.preview;
        if (Number.isFinite(value.chatWidth)) prefs.chatWidth = Math.max(320, Math.min(680, value.chatWidth));
        savePreferences(); applyLayout(); break;
      case 'remote-control': prefs.remoteControl = value.enabled === true; break;
      case 'remote-status': remoteStatus = String(value.status).slice(0, 50); break;
      case 'fullscreen': win.setFullScreen(!win.isFullScreen()); break;
      case 'open-settings': win.webContents.send('workspace:settings'); break;
      case 'focus-workspace': win.webContents.send('workspace:focus-workspace'); break;
      case 'copy-connection': clipboard.writeText(JSON.stringify({ url: `http://127.0.0.1:${apiPort}`, token: API_TOKEN }, null, 2)); break;
      case 'show-data': shell.openPath(app.getPath('userData')); break;
      case 'sync-telegram': telegramView.webContents.reload(); break;
      case 'open-username': {
        const username = String(value.username || '').replace(/^@/, '');
        if (!/^[A-Za-z][\w]{3,31}$/.test(username)) throw new Error('Enter a Telegram bot username.');
        const link = `tg://resolve?domain=${username}`;
        prefs.selectedBotId = '';
        await telegramView.webContents.loadURL(`${TELEGRAM}#?tgaddr=${encodeURIComponent(link)}`).catch(() => {});
        telegramView.webContents.reload(); break;
      }
      default: throw new Error('Unknown workspace command.');
    }
    broadcast(); return getState();
  });
  ipcMain.on('telegram:catalog', (event, value) => {
    if (event.sender !== telegramView?.webContents || event.senderFrame !== event.sender.mainFrame || !event.sender.getURL().startsWith(TELEGRAM)) return;
    if (!value || typeof value !== 'object') return;
    telegramStatus = ['connected', 'login', 'locked', 'loading'].includes(value.status) ? value.status : 'loading';
    telegramDiagnostics = value.diagnostics || {};
    if (value.accountId && /^\d+$/.test(value.accountId)) {
      if (prefs.accountId && prefs.accountId !== value.accountId) { prefs.bots = []; prefs.order = []; prefs.hidden = []; prefs.selectedBotId = ''; }
      prefs.accountId = value.accountId;
      const bots = sanitizeBots(value.bots);
      const merged = new Map(prefs.bots.map((bot) => [bot.id, bot]));
      bots.forEach((bot) => merged.set(bot.id, bot));
      prefs.bots = [...merged.values()];
      if (value.selectedId && prefs.bots.some((bot) => bot.id === value.selectedId)) prefs.selectedBotId = value.selectedId;
      if (!prefs.selectedBotId && prefs.bots.length && telegramStatus === 'connected') {
        const bot = prefs.bots.find((item) => !prefs.hidden.includes(item.id));
        if (bot) openBot(bot.id).catch(() => {});
      }
      savePreferences();
    }
    broadcast();
  });
}

async function snapshot(tab) {
  const generation = ++tab.generation;
  const result = await tab.view.webContents.executeJavaScript(`(() => {
    const items = [];
    const nodes = document.querySelectorAll('a[href], button, input:not([type="hidden"]), textarea, select, [role="button"], [role="link"], [contenteditable="true"]');
    for (const el of nodes) {
      const rect = el.getBoundingClientRect(), style = getComputedStyle(el);
      if (!rect.width || !rect.height || style.visibility === 'hidden' || style.display === 'none') continue;
      const ref = 's${generation}-' + (items.length + 1);
      el.setAttribute('data-hermes-workspace-ref', ref);
      items.push({ ref, role: el.getAttribute('role') || el.tagName.toLowerCase(), name: (el.getAttribute('aria-label') || el.labels?.[0]?.innerText || el.innerText || el.placeholder || el.title || '').trim().slice(0, 200), type: el.type || '', value: el.type === 'password' ? '[password]' : String(el.value || '').slice(0, 200), href: el.href || '', disabled: !!el.disabled });
      if (items.length >= 300) break;
    }
    return { title: document.title, url: location.href, text: document.body?.innerText?.slice(0, 20000) || '', elements: items,
      iframes: [...document.querySelectorAll('iframe')].map(el => ({ title: el.title, src: el.src })).slice(0, 20) };
  })()`);
  tab.refs = new Set(result.elements.map((item) => item.ref));
  return { ...result, tab: describeTab(tab) };
}
function browserCommand(tab, method, params) {
  const wc = tab.view.webContents;
  if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
  return wc.debugger.sendCommand(method, params);
}
async function captureTab(tab) {
  const wc = tab.view.webContents;
  if (tab.view.getVisible()) return wc.capturePage(undefined, { stayHidden: true });
  // A hidden native View has no capture surface. Temporarily parent it to a
  // hidden window; capturePage can paint there without changing the user's tab.
  const bounds = tab.view.getBounds();
  const captureWindow = new BrowserWindow({ show: false, frame: false, skipTaskbar: true,
    width: bounds.width, height: bounds.height, webPreferences: { sandbox: true } });
  tab.capturing = true;
  win.contentView.removeChildView(tab.view);
  captureWindow.contentView.addChildView(tab.view);
  tab.view.setBounds({ x: 0, y: 0, width: bounds.width, height: bounds.height });
  tab.view.setVisible(true);
  try {
    await browserCommand(tab, 'Emulation.setFocusEmulationEnabled', { enabled: true });
    return await wc.capturePage(undefined, { stayHidden: true });
  } finally {
    if (!wc.isDestroyed()) {
      await browserCommand(tab, 'Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {});
      captureWindow.contentView.removeChildView(tab.view);
      if (tabs.has(tab.id)) win.contentView.addChildView(tab.view);
    }
    tab.capturing = false;
    captureWindow.destroy();
    applyLayout();
  }
}
async function performAction(tab, body, botId) {
  requireActor(tab, botId, body.epoch, true);
  await browserCommand(tab, 'Emulation.setFocusEmulationEnabled', { enabled: true });
  try {
    requireActor(tab, botId, body.epoch, true);
    return await dispatchAction(tab, body, botId);
  } finally {
    if (!tab.view.webContents.isDestroyed()) await browserCommand(tab, 'Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {});
  }
}
async function dispatchAction(tab, body, botId) {
  requireActor(tab, botId, body.epoch, true);
  const wc = tab.view.webContents;
  if (body.action === 'navigate') {
    await wc.loadURL(normalizeUrl(body.url)); return describeTab(tab);
  }
  if (body.action === 'back' || body.action === 'forward' || body.action === 'reload') {
    const history = wc.navigationHistory;
    if (body.action === 'back' && history.canGoBack()) history.goBack();
    else if (body.action === 'forward' && history.canGoForward()) history.goForward();
    else if (body.action === 'reload') wc.reload();
  } else if (body.action === 'click' || body.action === 'type') {
    if (!tab.refs.has(body.ref)) throw Object.assign(new Error('Stale or unknown reference. Request a fresh snapshot.'), { status: 409 });
    const point = await wc.executeJavaScript(`(() => {
      const el = document.querySelector('[data-hermes-workspace-ref="${body.ref}"]');
      if (!el || el.disabled) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' }); el.focus();
      if (${body.action === 'type'}) {
        if (typeof el.select === 'function') el.select();
        else if (el.isContentEditable) { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
      }
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (!point) throw new Error('Element is no longer available.');
    requireActor(tab, botId, body.epoch, true);
    if (body.action === 'click') {
      await Promise.all([
        browserCommand(tab, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 }),
        browserCommand(tab, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 }),
      ]);
    } else {
      if (typeof body.text !== 'string' || body.text.length > 20000) throw new Error('Provide text up to 20,000 characters.');
      await browserCommand(tab, 'Input.insertText', { text: body.text });
    }
  } else if (body.action === 'press') {
    if (typeof body.key !== 'string' || body.key.length > 30) throw new Error('Invalid key.');
    const modifiers = (Array.isArray(body.modifiers) ? body.modifiers : []).reduce((bits, key) => bits | ({ alt: 1, control: 2, meta: 4, shift: 8 }[key] || 0), 0);
    const key = ({ Return: 'Enter', Esc: 'Escape', Space: ' ' })[body.key] || body.key;
    const keyCode = ({ Enter: 13, Tab: 9, Backspace: 8, Escape: 27, Delete: 46, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35, PageUp: 33, PageDown: 34 })[key] || (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
    const event = { key, modifiers, windowsVirtualKeyCode: keyCode, ...(key === 'Enter' ? { text: '\r' } : key.length === 1 && !(modifiers & 7) ? { text: key } : {}) };
    await Promise.all([browserCommand(tab, 'Input.dispatchKeyEvent', { type: 'keyDown', ...event }), browserCommand(tab, 'Input.dispatchKeyEvent', { type: 'keyUp', ...event, text: undefined })]);
  } else if (body.action === 'scroll') {
    await browserCommand(tab, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: 100, y: 100, deltaX: Math.max(-2000, Math.min(2000, Number(body.x) || 0)), deltaY: Math.max(-2000, Math.min(2000, Number(body.y) || 0)) });
  } else throw Object.assign(new Error('Supported actions: navigate, click, type, press, scroll, back, forward, reload.'), { status: 400 });
  tab.refs.clear(); broadcast();
  return { tab: describeTab(tab), dispatched: true };
}
async function readJson(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 100000) throw Object.assign(new Error('Request too large.'), { status: 413 }); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); }
  catch { throw Object.assign(new Error('Invalid JSON.'), { status: 400 }); }
}
function startApi() {
  apiServer = http.createServer(async (req, res) => {
    const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
    // No browser-origin requests or CORS: this endpoint is for the paired native connector.
    if (req.headers.origin || !isAuthorized(req.headers.authorization, API_TOKEN)) return send(401, { error: 'Unauthorized' });
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const botId = String(req.headers['x-hermes-bot'] || '');
      if (req.method === 'GET' && url.pathname === '/v1/status') return send(200, { name: app.getName(), version: app.getVersion(), protocol: 1, host: 'mac', capabilities: ['tabs', 'snapshot', 'screenshot', 'navigate', 'click', 'type', 'press', 'scroll', 'control-epochs'], tabCount: tabs.size });
      if (req.method === 'GET' && url.pathname === '/v1/diagnostics') {
        const appearance = await telegramView.webContents.executeJavaScript(`(() => ({
          styled: document.body.classList.contains('hw-chat'),
          composerCount: document.querySelectorAll('.Composer').length,
          middleClasses: document.querySelector('#MiddleColumn')?.className || '',
          middleChildren: [...(document.querySelector('#MiddleColumn')?.children || [])].map(el => ({ tag: el.tagName, id: el.id, className: String(el.className), background: getComputedStyle(el).backgroundImage, display: getComputedStyle(el).display })),
        }))()`).catch(() => ({}));
        return send(200, { telegram: { status: telegramStatus, ...telegramDiagnostics, appearance }, remote: remoteStatus,
          window: { visible: win.isVisible(), focused: win.isFocused() } });
      }
      if (url.pathname === '/v1/tabs' && req.method === 'GET') return send(200, { tabs: [...tabs.values()].filter((tab) => !botId || tab.botId === botId || tab.allowedBots.includes(botId)).map(describeTab) });
      if (url.pathname === '/v1/tabs' && req.method === 'POST') {
        if (!botId || botId.length > 100) throw Object.assign(new Error('X-Hermes-Bot is required.'), { status: 400 });
        const body = await readJson(req);
        return send(201, describeTab(createTab({ url: body.url, botId, controller: 'agent', activate: body.background !== true })));
      }
      const match = /^\/v1\/tabs\/([\w-]+)(?:\/(snapshot|screenshot|actions))?$/.exec(url.pathname);
      const tab = match && tabs.get(match[1]);
      if (!tab) return send(404, { error: 'Tab not found.' });
      requireActor(tab, botId);
      if (req.method === 'GET' && !match[2]) return send(200, describeTab(tab));
      if (req.method === 'GET' && match[2] === 'snapshot') return send(200, await snapshot(tab));
      if (req.method === 'GET' && match[2] === 'screenshot') {
        const capture = tab.queue.then(() => captureTab(tab));
        tab.queue = capture.catch(() => {});
        const shot = await capture; return send(200, { mimeType: 'image/png', base64: shot.toPNG().toString('base64'), tab: describeTab(tab) });
      }
      if (req.method === 'POST' && match[2] === 'actions') {
        const body = await readJson(req);
        const action = tab.queue.then(() => performAction(tab, body, botId));
        tab.queue = action.catch(() => {});
        return send(200, await action);
      }
      if (req.method === 'DELETE' && !match[2]) { requireActor(tab, botId, Number(req.headers['x-control-epoch']), true); closeTab(tab.id); return send(200, { closed: true }); }
      return send(405, { error: 'Method not supported.' });
    } catch (error) { send(error.status || 400, { error: error.message }); }
  });
  apiServer.requestTimeout = 30000;
  apiServer.on('error', (error) => { apiError = error.message; broadcast(); });
  apiServer.listen(Number(process.env.HERMES_WORKSPACE_PORT) || 9464, '127.0.0.1', () => {
    apiPort = apiServer.address().port;
    fs.writeFileSync(path.join(app.getPath('userData'), 'connection.json'), JSON.stringify({ url: `http://127.0.0.1:${apiPort}`, token: API_TOKEN, protocol: 1 }, null, 2), { mode: 0o600 });
    broadcast();
  });
}
function createWindow() {
  nativeTheme.themeSource = 'dark';
  win = new BrowserWindow({ width: 1550, height: 980, minWidth: 1120, minHeight: 680, backgroundColor: '#09090a', title: app.getName(),
    titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 18 },
    webPreferences: { preload: path.join(ROOT, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  telegramView = new WebContentsView({ webPreferences: { preload: path.join(ROOT, 'telegram-preload.cjs'), partition: 'persist:telegram', contextIsolation: true, nodeIntegration: false, sandbox: true } });
  telegramView.setBackgroundColor('#09090a');
  configureContents(telegramView.webContents, true);
  telegramView.webContents.on('did-fail-load', (_e, code, _desc, _url, main) => { if (main && code !== -3) { telegramStatus = 'offline'; broadcast(); } });
  win.contentView.addChildView(telegramView);
  remoteView = new WebContentsView({ webPreferences: { preload: path.join(ROOT, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  remoteView.setBackgroundColor('#101011');
  remoteView.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  remoteView.webContents.on('will-navigate', (event) => event.preventDefault());
  win.contentView.addChildView(remoteView);
  registerIpc();
  win.loadFile(path.join(ROOT, 'index.html'));
  remoteView.webContents.loadFile(path.join(ROOT, 'remote.html'));
  telegramView.webContents.loadURL(prefs.selectedBotId ? `${TELEGRAM}#${prefs.selectedBotId}` : TELEGRAM).catch(() => {});
  for (const item of prefs.savedTabs.slice(0, 12)) { try { createTab({ url: item.url, botId: item.botId, activate: false }); } catch {} }
  activeTabId = 'home';
  win.on('enter-full-screen', broadcast); win.on('leave-full-screen', broadcast);
  win.on('close', (event) => { if (!isQuitting) { event.preventDefault(); win.hide(); } });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: app.getName(), submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
    { label: 'File', submenu: [{ label: 'New Browser Tab', accelerator: 'CmdOrCtrl+T', click: () => createTab({}) }, { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => closeTab(activeTabId) }] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ label: 'Reload Page', accelerator: 'CmdOrCtrl+R', click: () => tabs.get(activeTabId)?.view.webContents.reload() }, { role: 'togglefullscreen' }, { label: 'App Developer Tools', accelerator: 'Alt+CmdOrCtrl+I', click: () => win.webContents.toggleDevTools() }] },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'front' }] },
  ]));
  startApi();
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.whenReady().then(() => { app.setAccessibilitySupportEnabled(true); prefs = readPreferences(); prefs.remoteControl = false; fs.mkdirSync(app.getPath('userData'), { recursive: true }); createWindow(); });
  app.on('second-instance', () => { win?.show(); win?.focus(); });
  app.on('activate', () => { win?.show(); win?.focus(); });
  app.on('before-quit', () => { isQuitting = true; savePreferences(); apiServer?.close(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
