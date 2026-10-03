const { app, BrowserWindow, WebContentsView, ipcMain, Menu, dialog, clipboard, shell, nativeTheme, screen, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { normalizeUrl, parseRemoteUrl, requireActor, isAuthorized, sanitizeBots } = require('./core.cjs');
const { createAvatarStore } = require('./avatar-store.cjs');
const { createAgentInput } = require('./agent-input.cjs');
const { createActivityTracker } = require('./activity.cjs');
const { createSitePermissions } = require('./site-permissions.cjs');

app.setName("Hermes- Alan's way");
// Keep existing sessions and connector discovery stable when the product name changes.
app.setPath('userData', process.env.HERMES_WORKSPACE_DATA
  ? path.resolve(process.env.HERMES_WORKSPACE_DATA)
  : path.join(app.getPath('appData'), 'Hermes Workspace'));
const ROOT = __dirname;
const TELEGRAM = 'https://web.telegram.org/a/';
let win, backgroundWindow, telegramView, remoteView, apiServer, prefs, layout = {}, apiPort = 0;
let activeTabId = 'home', apiError = '', remoteStatus = 'disconnected', telegramStatus = 'loading', telegramDiagnostics = {};
const tabs = new Map();
const configuredSessions = new WeakSet();
const API_TOKEN = crypto.randomBytes(32).toString('hex');
let isQuitting = false;
let backgroundCaptureQueue = Promise.resolve();
const avatarStore = createAvatarStore({ root: ROOT, nativeImage, dialog, getWindow: () => win, getPreferences: () => prefs });
const agentInput = createAgentInput({ command: browserCommand, requireActor });
const activity = createActivityTracker();
const sitePermissions = createSitePermissions({ getPreferences: () => prefs, savePreferences,
  canRequest: (wc) => {
    const tab = [...tabs.values()].find(item => item.view.webContents === wc);
    if (layout.obscured) return false;
    return tab ? tab.id === activeTabId && tab.controller === 'human' : wc === telegramView?.webContents;
  },
  prompt: async (origin, permissions) => {
    const answer = await dialog.showMessageBox(win, { type: 'question', buttons: ['Block for this site', 'Allow for this site'], defaultId: 0, cancelId: 0,
      message: `${origin} wants ${permissions.join(' and ').toLowerCase()} access.`, detail: 'Your choice is remembered. Change it in Workspace settings → Site permissions.' });
    return answer.response === 1;
  }
});
let pointerTimer, activityTimer;

function readPreferences() {
  const defaults = { bots: [], order: [], hidden: [], selectedBotId: '', accountId: '', remoteUrl: '', chatWidth: 490, preview: true, savedTabs: [], avatarLibrary: [], avatarPreferences: {}, locationDefault: 'approximate', sitePermissions: {} };
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
    controller: tab.controller, epoch: tab.epoch, loading: tab.loading, error: tab.error || '', allowedBots: tab.allowedBots, agentCursor: tab.agentCursor || null };
}
function getState() {
  return { name: app.getName(), version: app.getVersion(), bots: prefs.bots.map(bot => ({ ...bot, activity: activity.get(bot.id) })), order: prefs.order, hidden: prefs.hidden,
    selectedBotId: prefs.selectedBotId, chatWidth: prefs.chatWidth, preview: prefs.preview, remoteUrl: prefs.remoteUrl,
    remoteStatus, remoteControl: prefs.remoteControl === true, telegramStatus, tabs: [...tabs.values()].map(describeTab),
    activeTabId, avatarLibrary: avatarStore.library(), avatarPreferences: prefs.avatarPreferences,
    locationDefault: prefs.locationDefault, sitePermissions: prefs.sitePermissions,
    fullscreen: win?.isFullScreen() || false, api: { url: apiPort ? `http://127.0.0.1:${apiPort}` : '', ready: !!apiPort, error: apiError } };
}
function broadcast() {
  if (!win || win.isDestroyed() || !prefs) return;
  const state = getState();
  win.webContents.send('workspace:state', state);
  if (remoteView && !remoteView.webContents.isDestroyed()) remoteView.webContents.send('workspace:state', state);
}
function fit(view, rect) {
  if (!view || view.webContents.isDestroyed()) return;
  if (!rect || rect.width < 1 || rect.height < 1 || layout.obscured) { if (view.getVisible()) view.setVisible(false); return; }
  const size = win.getContentBounds();
  const x = Math.max(0, Math.round(rect.x)), y = Math.max(0, Math.round(rect.y));
  const next = { x, y, width: Math.max(1, Math.min(Math.round(rect.width), size.width - x)), height: Math.max(1, Math.min(Math.round(rect.height), size.height - y)) };
  const previous = view.getBounds();
  if (Object.keys(next).some(key => next[key] !== previous[key])) view.setBounds(next);
  if (!view.getVisible()) view.setVisible(true);
}
function backgroundHost(width = 900, height = 700) {
  width = Math.max(900, Math.ceil(width)); height = Math.max(700, Math.ceil(height));
  if (!backgroundWindow || backgroundWindow.isDestroyed()) {
    // A hidden WebContentsView in the human window can acquire native focus
    // during load and has no viewport before its first show. Keep inactive
    // tabs visible inside a separate window that can never accept native focus.
    backgroundWindow = new BrowserWindow({ show: false, focusable: false, frame: false, skipTaskbar: true,
      width, height, webPreferences: { sandbox: true, backgroundThrottling: false } });
  } else {
    const [currentWidth, currentHeight] = backgroundWindow.getContentSize();
    if (width > currentWidth || height > currentHeight) backgroundWindow.setContentSize(Math.max(width, currentWidth), Math.max(height, currentHeight));
  }
  return backgroundWindow;
}
function applyLayout() {
  fit(telegramView, layout.telegram);
  for (const tab of tabs.values()) {
    const foreground = activeTabId === tab.id && layout.browser?.width > 0 && layout.browser?.height > 0 && !layout.obscured;
    const host = foreground ? win : backgroundHost(layout.browser?.width || 900, layout.browser?.height || 700);
    if (tab.host !== host) {
      tab.view.setVisible(false);
      tab.host?.contentView.removeChildView(tab.view);
      host.contentView.addChildView(tab.view);
      tab.host = host;
    }
    if (foreground) fit(tab.view, layout.browser);
    else {
      const previous = tab.view.getBounds();
      const next = { x: 0, y: 0, width: Math.max(1, Math.round(layout.browser?.width || previous.width || 900)), height: Math.max(1, Math.round(layout.browser?.height || previous.height || 700)) };
      if (Object.keys(next).some(key => next[key] !== previous[key])) tab.view.setBounds(next);
      if (!tab.view.getVisible()) tab.view.setVisible(true);
    }
  }
  fit(remoteView, activeTabId === 'vps' ? layout.browser : prefs.preview ? layout.preview : null);
  if (remoteView && win.contentView.children.at(-1) !== remoteView) win.contentView.addChildView(remoteView);
}
function configureContents(contents, isTelegram = false) {
  contents.setWindowOpenHandler((details) => {
    let url;
    try { url = normalizeUrl(details.url); } catch { return { action: 'deny' }; }
    return { action: 'allow', createWindow: (options) => {
      const parent = [...tabs.values()].find((tab) => tab.view.webContents === contents);
      const tab = createTab({ url, botId: parent?.botId || prefs.selectedBotId || 'shared', controller: parent?.controller || 'human', options, skipLoad: details.disposition !== 'background-tab', activate: parent?.controller !== 'agent' && details.disposition !== 'background-tab' });
      return tab.view.webContents;
    } };
  });
  contents.on('will-navigate', (event, url) => {
    if (isTelegram && !url.startsWith(TELEGRAM)) { event.preventDefault(); try { createTab({ url }); } catch {} }
    else if (!isTelegram && !/^https?:\/\//i.test(url) && url !== 'about:blank') event.preventDefault();
  });
  contents.on('before-input-event', (event, input) => {
    const targetTab = [...tabs.values()].find(tab => tab.view.webContents === contents);
    if (targetTab && agentInput.isDispatching(targetTab)) return;
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
  sitePermissions.install(session, isTelegram ? 'telegram' : 'browser');
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
  tab.host = backgroundHost();
  tab.host.contentView.addChildView(view);
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
  tab.host?.contentView.removeChildView(tab.view);
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
  agentInput.clear(tab).catch(() => {});
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
        tab.epoch++; tab.refs.clear(); agentInput.clear(tab).catch(() => {}); break;
      }
      case 'import-avatars': await avatarStore.importFiles(); savePreferences(); break;
      case 'set-bot-avatar': avatarStore.set(value); savePreferences(); break;
      case 'remove-avatar': avatarStore.remove(value.avatarId); savePreferences(); break;
      case 'open-bot': await openBot(String(value.id)); break;
      case 'sort-bots': prefs.order = Array.isArray(value.ids) ? value.ids.filter((id) => prefs.bots.some((bot) => bot.id === id)) : prefs.order; savePreferences(); break;
      case 'hide-bot':
      case 'set-bot-visibility': {
        const id = String(value.id);
        if (!prefs.bots.some((bot) => bot.id === id)) throw new Error('Telegram bot not found. Sync your bot list and try again.');
        if (command === 'set-bot-visibility' && typeof value.visible !== 'boolean') throw new Error('Choose whether to show this bot.');
        if (command === 'set-bot-visibility' && value.visible) prefs.hidden = prefs.hidden.filter((hiddenId) => hiddenId !== id);
        else if (!prefs.hidden.includes(id)) prefs.hidden.push(id);
        savePreferences(); break;
      }
      case 'restore-bots': prefs.hidden = []; savePreferences(); break;
      case 'set-site-permission': sitePermissions.set(value); break;
      case 'reset-site-permissions': sitePermissions.reset(); break;
      case 'settings':
        if (typeof value.remoteUrl === 'string') { parseRemoteUrl(value.remoteUrl); prefs.remoteUrl = value.remoteUrl; remoteStatus = 'disconnected'; prefs.remoteControl = false; }
        if (typeof value.preview === 'boolean') prefs.preview = value.preview;
        if (['ask', 'block', 'approximate'].includes(value.locationDefault)) prefs.locationDefault = value.locationDefault;
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
      if (prefs.accountId && prefs.accountId !== value.accountId) { prefs.bots = []; prefs.order = []; prefs.hidden = []; prefs.selectedBotId = ''; prefs.avatarPreferences = {}; }
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
    activity.setContext({ accountId: prefs.accountId, bots: prefs.bots, connected: telegramStatus === 'connected' });
    broadcast();
  });
  ipcMain.on('telegram:activity', (event, packet) => {
    if (event.sender !== telegramView?.webContents || event.senderFrame !== event.sender.mainFrame || !event.sender.getURL().startsWith(TELEGRAM)) return;
    if (activity.ingest(packet)) broadcast();
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
      viewport: { width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio },
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
  const capture = backgroundCaptureQueue.then(async () => {
    const wc = tab.view.webContents;
    if (tab.host === win) return wc.capturePage(undefined, { stayHidden: true });
    // Hidden tabs share one host. Bring only this surface to its top while
    // capturing; never reparent it into the human's window or change selection.
    if (tab.host.contentView.children.at(-1) !== tab.view) tab.host.contentView.addChildView(tab.view);
    await browserCommand(tab, 'Emulation.setFocusEmulationEnabled', { enabled: true });
    try {
      await wc.executeJavaScript('new Promise(resolve => { const timer = setTimeout(resolve, 250); requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve(); })); })');
      return await wc.capturePage(undefined, { stayHidden: true });
    }
    finally { if (!wc.isDestroyed()) await browserCommand(tab, 'Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {}); }
  });
  backgroundCaptureQueue = capture.catch(() => {});
  return capture;
}
async function performAction(tab, body, botId) {
  requireActor(tab, botId, body.epoch, true);
  if (['click', 'type', 'press', 'scroll', 'move'].includes(body.action)) {
    const result = await agentInput.perform(tab, body, botId);
    if (body.action !== 'move') tab.refs.clear();
    broadcast();
    return { ...result, tab: describeTab(tab), dispatched: true };
  }
  const wc = tab.view.webContents;
  if (body.action === 'navigate') {
    await agentInput.clear(tab);
    requireActor(tab, botId, body.epoch, true);
    await wc.loadURL(normalizeUrl(body.url));
  } else if (['back', 'forward', 'reload'].includes(body.action)) {
    await agentInput.clear(tab);
    requireActor(tab, botId, body.epoch, true);
    const history = wc.navigationHistory;
    if (body.action === 'back' && history.canGoBack()) history.goBack();
    else if (body.action === 'forward' && history.canGoForward()) history.goForward();
    else if (body.action === 'reload') wc.reload();
  } else throw Object.assign(new Error('Supported actions: navigate, click, type, press, move, scroll, back, forward, reload.'), { status: 400 });
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
      if (req.method === 'GET' && url.pathname === '/v1/status') return send(200, { name: app.getName(), version: app.getVersion(), protocol: 1, host: 'mac', capabilities: ['tabs', 'snapshot', 'screenshot', 'navigate', 'click', 'type', 'press', 'move', 'scroll', 'agent-cursor', 'background-input', 'control-epochs'], tabCount: tabs.size });
      if (req.method === 'GET' && url.pathname === '/v1/diagnostics') {
        const appearance = await telegramView.webContents.executeJavaScript(`(() => ({
          styled: document.body.classList.contains('hw-chat'),
          composerCount: document.querySelectorAll('.Composer').length,
          middleClasses: document.querySelector('#MiddleColumn')?.className || '',
          middleChildren: [...(document.querySelector('#MiddleColumn')?.children || [])].map(el => ({ tag: el.tagName, id: el.id, className: String(el.className), background: getComputedStyle(el).backgroundImage, display: getComputedStyle(el).display })),
        }))()`).catch(() => ({}));
        const activityStates = prefs.bots.map(bot => activity.get(bot.id).state);
        return send(200, { telegram: { status: telegramStatus, ...telegramDiagnostics, appearance,
          activity: { available: activityStates.some(state => state !== 'unknown'), activeBots: activityStates.filter(state => state === 'active').length } }, remote: remoteStatus,
          window: { visible: win.isVisible(), focused: win.isFocused() } });
      }
      if (url.pathname === '/v1/tabs' && req.method === 'GET') return send(200, { tabs: [...tabs.values()].filter((tab) => !botId || tab.botId === botId || tab.allowedBots.includes(botId)).map(describeTab) });
      if (url.pathname === '/v1/tabs' && req.method === 'POST') {
        if (!botId || botId.length > 100) throw Object.assign(new Error('X-Hermes-Bot is required.'), { status: 400 });
        const body = await readJson(req);
        return send(201, describeTab(createTab({ url: body.url, botId, controller: 'agent', activate: body.background === false })));
      }
      const match = /^\/v1\/tabs\/([\w-]+)(?:\/(snapshot|screenshot|actions))?$/.exec(url.pathname);
      const tab = match && tabs.get(match[1]);
      if (!tab) return send(404, { error: 'Tab not found.' });
      requireActor(tab, botId);
      if (req.method === 'GET' && !match[2]) return send(200, describeTab(tab));
      if (req.method === 'GET' && match[2] === 'snapshot') return send(200, await snapshot(tab));
      if (req.method === 'GET' && match[2] === 'screenshot') {
        const capture = tab.queue.then(async () => {
          const shot = await captureTab(tab);
          const viewport = await tab.view.webContents.executeJavaScript('({ width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio })');
          return { shot, viewport };
        });
        tab.queue = capture.catch(() => {});
        const { shot, viewport } = await capture;
        return send(200, { mimeType: 'image/png', base64: shot.toPNG().toString('base64'), viewport, tab: describeTab(tab) });
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
  telegramView.webContents.on('did-start-loading', () => { activity.clear(); broadcast(); });
  telegramView.webContents.on('render-process-gone', () => { telegramStatus = 'offline'; activity.clear(); broadcast(); });
  telegramView.webContents.on('did-fail-load', (_e, code, _desc, _url, main) => { if (main && code !== -3) { telegramStatus = 'offline'; activity.clear(); broadcast(); } });
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
  // Read the real pointer position, even over native child views or another app.
  // This never installs a global input hook or moves the system cursor.
  pointerTimer = setInterval(() => {
    if (!win || win.isDestroyed() || !win.isVisible() || win.isMinimized()) return;
    const point = screen.getCursorScreenPoint(), bounds = win.getContentBounds();
    const zoom = win.webContents.getZoomFactor();
    win.webContents.send('workspace:pointer', { x: (point.x - bounds.x) / zoom, y: (point.y - bounds.y) / zoom });
  }, 50);
  pointerTimer.unref();
  activityTimer = setInterval(() => { if (activity.expire()) broadcast(); }, 500);
  activityTimer.unref();
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.whenReady().then(() => { app.setAccessibilitySupportEnabled(true); prefs = readPreferences(); prefs.remoteControl = false; fs.mkdirSync(app.getPath('userData'), { recursive: true }); createWindow(); });
  app.on('second-instance', () => { win?.show(); win?.focus(); });
  app.on('activate', () => { win?.show(); win?.focus(); });
  app.on('before-quit', () => { isQuitting = true; clearInterval(pointerTimer); clearInterval(activityTimer); savePreferences(); apiServer?.close(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
