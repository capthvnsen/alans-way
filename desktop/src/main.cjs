const { app, BrowserWindow, WebContentsView, ipcMain, Menu, dialog, clipboard, shell, nativeTheme, screen, nativeImage, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { normalizeUrl, parseRemoteUrl, requireActor, isAuthorized, sanitizeBots } = require('./core.cjs');
const { createAvatarStore } = require('./avatar-store.cjs');
const { createAgentInput } = require('./agent-input.cjs');
const { createActivityTracker } = require('./activity.cjs');
const { createSitePermissions } = require('./site-permissions.cjs');
const { snapshotExpression, checkpointExpression, restoreExpression } = require('./browser-page.cjs');
const { createVpsBrowser } = require('./vps-browser.cjs');
const { createExtensionStore } = require('./extension-store.cjs');
const { ElectronChromeExtensions } = require('electron-chrome-extensions');

app.enableSandbox();
app.setName("Hermes- Alan's way");
// Keep existing sessions and connector discovery stable when the product name changes.
app.setPath('userData', process.env.HERMES_WORKSPACE_DATA
  ? path.resolve(process.env.HERMES_WORKSPACE_DATA)
  : path.join(app.getPath('appData'), 'Hermes Workspace'));
const ROOT = __dirname;
const TELEGRAM = 'https://web.telegram.org/a/';
let win, backgroundWindow, telegramView, remoteView, apiServer, prefs, layout = {}, apiPort = 0;
let extensionStore, extensionHost, extensionPopup, extensionPopupTabId, extensionActiveContentsId;
let registeringExtensionTab = false;
let activeTabId = 'home', browserReturnTabId = 'home', apiError = '', remoteStatus = 'disconnected', telegramStatus = 'loading', telegramDiagnostics = {};
const tabs = new Map();
const vpsTabs = new Map();
let vpsBrowserStatus = 'unconfigured', vpsRefreshBusy = false, vpsTimer;
const vpsBrowser = createVpsBrowser({ getConfig: () => prefs?.vpsBrowser });
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
  const defaults = { bots: [], order: [], hidden: [], selectedBotId: '', accountId: '', remoteUrl: '', chatWidth: 490, preview: true, savedTabs: [], avatarLibrary: [], avatarPreferences: {}, locationDefault: 'approximate', sitePermissions: {}, browserExtensions: [], vpsBrowser: {}, allAgentTabs: false, agentLastTabs: {}, handoffs: [] };
  try { return { ...defaults, ...JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'preferences.json'), 'utf8')) }; }
  catch { return { ...defaults, remoteUrl: process.env.HERMES_WORKSPACE_VPS_URL || '' }; }
}
function savePreferences() {
  if (!prefs) return;
  if (win && !win.isDestroyed()) prefs.savedTabs = [...tabs.values()].filter(tab => !tab.extensionPage).map((tab) => ({ url: tab.view.webContents.getURL(), botId: tab.botId }));
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  const file = path.join(app.getPath('userData'), 'preferences.json');
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(prefs, null, 2), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}
function describeTab(tab) {
  return { id: tab.id, title: tab.title || 'New tab', url: tab.view.webContents.getURL(), botId: tab.botId,
    controller: tab.controller, epoch: tab.epoch, loading: tab.loading, error: tab.error || '', allowedBots: tab.allowedBots, agentCursor: tab.agentCursor || null, extensionPage: tab.extensionPage === true, host: 'mac', session: 'shared-mac', handoff: tab.handoff || null };
}
function isVpsTab(id) { return vpsTabs.has(id); }
async function refreshVpsTabs() {
  if (!prefs?.vpsBrowser?.sshHost || vpsRefreshBusy) return;
  vpsRefreshBusy = true;
  try { const wasVps=vpsTabs.has(activeTabId); const data = await vpsBrowser.request('/v1/tabs', 'GET', undefined, { human: true }); vpsTabs.clear(); data.tabs.forEach(tab => vpsTabs.set(tab.id, tab)); if(wasVps&&!vpsTabs.has(activeTabId)){prefs.remoteControl=false;activeTabId='home';applyLayout();} vpsBrowserStatus = 'connected'; }
  catch { vpsBrowserStatus = 'disconnected'; }
  finally { vpsRefreshBusy = false; broadcast(); }
}
async function remoteRequest(id, operation, body, { human = true, botId = prefs.selectedBotId || 'shared' } = {}) {
  const result = await vpsBrowser.request(`/v1/tabs/${id}${operation ? '/' + operation : ''}`, body === undefined ? 'GET' : 'POST', body, {human, botId});
  const tab = result.tab || (result.id ? result : null); if (tab) vpsTabs.set(tab.id, tab);
  broadcast(); return result;
}
function selectAgent(id) {
  const old = prefs.selectedBotId;
  if (old === id) return;
  const viewingVps = activeTabId === 'vps';
  const localId = viewingVps ? browserReturnTabId : activeTabId;
  if (tabs.has(localId)) prefs.agentLastTabs[old] = localId;
  prefs.selectedBotId = id;
  prefs.remoteControl = false;
  const own = [...tabs.values()].filter(tab => tab.botId === id || tab.allowedBots.includes(id));
  const nextLocal = own.some(tab => tab.id === prefs.agentLastTabs[id]) ? prefs.agentLastTabs[id] : own.at(-1)?.id || 'home';
  browserReturnTabId = nextLocal;
  activeTabId = viewingVps ? 'vps' : nextLocal;
  applyLayout();
}
function getState() {
  return { name: app.getName(), version: app.getVersion(), bots: prefs.bots.map(bot => ({ ...bot, activity: activity.get(bot.id) })), order: prefs.order, hidden: prefs.hidden,
    selectedBotId: prefs.selectedBotId, chatWidth: prefs.chatWidth, preview: prefs.preview, remoteUrl: prefs.remoteUrl,
    remoteStatus, remoteControl: prefs.remoteControl === true, telegramStatus, tabs: [...tabs.values()].map(describeTab),
    vpsBrowser: prefs.vpsBrowser, vpsBrowserStatus, allAgentTabs: prefs.allAgentTabs, handoffs: prefs.handoffs,
    activeTabId, browserContentsId: tabs.get(activeTabId)?.view.webContents.id || null, browserTabId: activeTabId === 'vps' ? (tabs.has(browserReturnTabId) ? browserReturnTabId : 'home') : activeTabId, avatarLibrary: avatarStore.library(), avatarPreferences: prefs.avatarPreferences,
    locationDefault: prefs.locationDefault, sitePermissions: prefs.sitePermissions, extensions: extensionStore?.list() || [],
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
  if (extensionPopup && extensionPopupTabId !== activeTabId) extensionPopup.destroy();
  const active = tabs.get(activeTabId)?.view.webContents;
  if (active && active.id !== extensionActiveContentsId) { extensionActiveContentsId = active.id; extensionHost?.selectTab(active); }
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
    const extensionPage = !isTelegram && isExtensionUrl(details.url);
    try { url = extensionPage ? details.url : normalizeUrl(details.url); } catch { return { action: 'deny' }; }
    return { action: 'allow', createWindow: (options) => {
      const parent = [...tabs.values()].find((tab) => tab.view.webContents === contents);
      const tab = createTab({ url, extensionPage, botId: parent?.botId || prefs.selectedBotId || 'shared', controller: extensionPage ? 'human' : parent?.controller || 'human', options, skipLoad: details.disposition !== 'background-tab', activate: parent?.controller !== 'agent' && details.disposition !== 'background-tab' });
      return tab.view.webContents;
    } };
  });
  contents.on('will-navigate', (event, url) => {
    if (isTelegram && !url.startsWith(TELEGRAM)) { event.preventDefault(); try { createTab({ url }); } catch {} }
    else if (!isTelegram && !/^https?:\/\//i.test(url) && url !== 'about:blank') {
      if (!isExtensionUrl(url)) event.preventDefault();
      else { const tab = [...tabs.values()].find(item => item.view.webContents === contents); if (tab) { tab.extensionPage = true; changeController(tab.id, 'human'); } }
    }
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
function isExtensionUrl(value) {
  try { const url = new URL(value); return url.protocol === 'chrome-extension:' && !url.username && !url.password && !!session.fromPartition('persist:browser').extensions.getExtension(url.hostname); } catch { return false; }
}
function createTab({ url = 'about:blank', botId = prefs.selectedBotId || 'shared', controller = 'human', options, skipLoad = false, activate = true, extensionPage = false } = {}) {
  if (tabs.size >= 40) throw new Error('Close a tab before opening another.');
  const targetUrl = extensionPage && isExtensionUrl(url) ? url : normalizeUrl(url);
  const view = new WebContentsView({ ...(options?.webContents ? { webContents: options.webContents } : {}),
    webPreferences: { ...options?.webPreferences, preload: undefined, partition: 'persist:browser', contextIsolation: true, nodeIntegration: false, sandbox: true,
      webSecurity: true, backgroundThrottling: false } });
  view.setBackgroundColor('#0b0b0c');
  const tab = { id: crypto.randomUUID(), view, botId: String(botId).slice(0, 100), controller, extensionPage, epoch: 1, title: 'New tab', loading: false, allowedBots: [], refs: new Set(), generation: 0, queue: Promise.resolve() };
  tabs.set(tab.id, tab);
  tab.host = backgroundHost();
  tab.host.contentView.addChildView(view);
  // Background agent tabs still need a real viewport for layout and screenshots.
  const viewport = layout.browser || { x: 0, y: 0, width: 900, height: 700 };
  view.setBounds({ x: Math.round(viewport.x), y: Math.round(viewport.y), width: Math.round(viewport.width), height: Math.round(viewport.height) });
  configureContents(view.webContents);
  // The library selects newly registered tabs. Registration must not reparent
  // or focus a background agent view in the human window.
  registeringExtensionTab = true;
  try { extensionHost?.addTab(view.webContents, win); } finally { registeringExtensionTab = false; }
  extensionActiveContentsId = undefined;
  view.webContents.on('context-menu', (_event, params) => {
    const items = extensionHost?.getContextMenuItems(view.webContents, params) || [];
    if (items.length && tab.id === activeTabId && tab.controller === 'human') Menu.buildFromTemplate(items).popup({ window: win });
  });
  view.webContents.on('page-title-updated', (_event, title) => { tab.title = title; broadcast(); });
  view.webContents.on('did-start-loading', () => { tab.loading = true; tab.error = ''; broadcast(); });
  view.webContents.on('did-stop-loading', () => { tab.loading = false; savePreferences(); broadcast(); });
  view.webContents.on('did-navigate', () => { tab.refs.clear(); tab.generation++; broadcast(); });
  view.webContents.on('did-navigate-in-page', () => { tab.refs.clear(); tab.generation++; broadcast(); });
  view.webContents.on('did-fail-load', (_e, code, description, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) { tab.error = description; tab.loading = false; broadcast(); }
  });
  view.webContents.on('render-process-gone', () => { tab.error = 'This page stopped. Reload to reconnect.'; broadcast(); });
  if (activate) { prefs.remoteControl = false; activeTabId = tab.id; }
  applyLayout(); broadcast();
  if (!skipLoad) view.webContents.loadURL(targetUrl).catch(() => {});
  return tab;
}
function closeTab(id) {
  if (id === 'home' || id === 'vps') { prefs.remoteControl=false; activeTabId = 'home'; applyLayout(); broadcast(); return; }
  const tab = tabs.get(id);
  if (!tab) return;
  tabs.delete(id);
  extensionHost?.removeTab(tab.view.webContents);
  if (browserReturnTabId === id) browserReturnTabId = [...tabs.keys()].at(-1) || 'home';
  tab.host?.contentView.removeChildView(tab.view);
  tab.view.webContents.close();
  if (activeTabId === id) activeTabId = [...tabs.keys()].at(-1) || 'home';
  savePreferences(); applyLayout(); broadcast();
}
function changeController(id, controller) {
  const tab = tabs.get(id);
  if (!tab) throw new Error('Tab not found.');
  if (tab.extensionPage && controller === 'agent') throw new Error('Extension account pages stay under your control.');
  tab.controller = controller === 'agent' ? 'agent' : 'human';
  if (tab.controller === 'agent' && tab.botId === 'shared' && prefs.selectedBotId) tab.botId = prefs.selectedBotId;
  tab.epoch++;
  tab.refs.clear();
  agentInput.clear(tab).catch(() => {});
  broadcast();
  return describeTab(tab);
}
async function openExtension(key, anchor) {
  if (activeTabId === 'vps') throw new Error('Extensions are available in local browser tabs.');
  const item = extensionStore.list().find(item => item.key === key && item.loaded);
  if (!item) throw new Error('Enable this extension before opening it.');
  if (!tabs.has(activeTabId)) createTab({});
  const targetId = activeTabId, tab = tabs.get(targetId);
  // An extension popup may fill the page. Invalidate new agent actions first.
  if (tab) { changeController(tab.id, 'human'); await tab.queue; }
  if (activeTabId !== targetId || (tab && !tabs.has(tab.id))) throw new Error('The selected tab changed. Open the extension again on the intended tab.');
  const details = { eventType: 'click', extensionId: item.id, tabId: tab.view.webContents.id, alignment: 'bottom right',
    anchorRect: { x: Number.isFinite(anchor?.x) ? anchor.x - 28 : win.getContentBounds().width - 90, y: Number.isFinite(anchor?.y) ? anchor.y - 28 : 100, width: 28, height: 28 } };
  await win.webContents.executeJavaScript(`window.browserAction.activate('persist:browser', ${JSON.stringify(details)})`);
}
function trustSender(event) {
  const trusted = [win?.webContents, remoteView?.webContents];
  if (!trusted.includes(event.sender) || event.senderFrame !== event.sender.mainFrame || !event.sender.getURL().startsWith('file:')) {
    throw new Error('Untrusted workspace request.');
  }
}
async function openBot(id) {
  if (!prefs.bots.some((bot) => bot.id === id)) throw new Error('Select a verified Telegram bot.');
  selectAgent(id);
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
      case 'close-tab':
        if (isVpsTab(value.id)) { if(activeTabId===value.id)prefs.remoteControl=false; await vpsBrowser.request(`/v1/tabs/${value.id}`,'DELETE',undefined,{human:true}); vpsTabs.delete(value.id); if(activeTabId===value.id)activeTabId='home'; applyLayout(); } else closeTab(value.id); break;
      case 'activate': {
        const id=isVpsTab(value.id)?'vps':value.id;
        if(id==='vps'&&activeTabId!=='vps')browserReturnTabId=activeTabId;
        if(activeTabId!==id)prefs.remoteControl=false;
        activeTabId=tabs.has(id)||['home','vps'].includes(id)?id:'home';
        if(isVpsTab(value.id))await remoteRequest(value.id,'activate',{});
        applyLayout();break;
      }
      case 'toggle-vps-view': {
        if(activeTabId==='vps')activeTabId=tabs.has(browserReturnTabId)?browserReturnTabId:'home';
        else {browserReturnTabId=activeTabId;activeTabId='vps';}
        prefs.remoteControl=false;applyLayout();break;
      }
      case 'navigate': {
        if (isVpsTab(value.id)) { await navigateVps(value.id,value.url); break; }
        const tab = tabs.get(value.id); if (tab) { changeController(tab.id, 'human'); await tab.view.webContents.loadURL(normalizeUrl(value.url)).catch(() => {}); } break;
      }
      case 'history': {
        if (isVpsTab(value.id)) { await remoteRequest(value.id,'control',{controller:'human'}); await remoteRequest(value.id,'human-actions',{action:value.action}); break; }
        const tab = tabs.get(value.id); if (!tab) break;
        changeController(tab.id, 'human'); const history = tab.view.webContents.navigationHistory;
        if (value.action === 'back' && history.canGoBack()) history.goBack();
        if (value.action === 'forward' && history.canGoForward()) history.goForward();
        if (value.action === 'reload') tab.view.webContents.reload(); break;
      }
      case 'control': if(isVpsTab(value.id)){if(value.controller==='agent')prefs.remoteControl=false;return remoteRequest(value.id,'control',{controller:value.controller});}return changeController(value.id, value.controller);
      case 'handoff': return handoffTab(value);
      case 'grant-tab': {
        if (isVpsTab(value.id)) { await remoteRequest(value.id,'grant',value); break; }
        const tab = tabs.get(value.id); if (!tab) throw new Error('Tab not found.');
        if (tab.extensionPage) throw new Error('Extension account pages stay under your control.');
        if (typeof value.botId === 'string' && value.botId.length > 0 && value.botId.length <= 100) tab.botId = value.botId;
        tab.allowedBots = Array.isArray(value.botIds) ? [...new Set(value.botIds.filter(id => typeof id === 'string' && id.length > 0 && id.length <= 100 && id !== tab.botId))] : [];
        tab.epoch++; tab.refs.clear(); agentInput.clear(tab).catch(() => {}); break;
      }
      case 'import-avatars': await avatarStore.importFiles(); savePreferences(); break;
      case 'set-bot-avatar': avatarStore.set(value); savePreferences(); break;
      case 'remove-avatar': avatarStore.remove(value.avatarId); savePreferences(); break;
      case 'add-extension': await extensionStore.importFolder(); break;
      case 'pin-extension': extensionStore.pin(value.key, value.pinned); break;
      case 'enable-extension': extensionPopup?.destroy(); await extensionStore.setEnabled(value.key, value.enabled); break;
      case 'remove-extension': extensionPopup?.destroy(); await extensionStore.remove(value.key); break;
      case 'open-extension': await openExtension(value.key, value.anchor); break;
      case 'browse-extensions': createTab({ url: 'https://chromewebstore.google.com/category/extensions' }); break;
      case 'open-1password': {
        const error = await shell.openPath('/Applications/1Password.app');
        if (error) throw new Error('1Password for Mac was not found in Applications. Install the Mac app to use this shortcut.');
        break;
      }
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
        if (value.vpsBrowser && typeof value.vpsBrowser === 'object') { prefs.vpsBrowser={sshHost:String(value.vpsBrowser.sshHost || '').trim(),scriptPath:String(value.vpsBrowser.scriptPath || '').trim(),sudo:value.vpsBrowser.sudo===true}; vpsBrowserStatus='connecting'; refreshVpsTabs(); }
        if (typeof value.allAgentTabs === 'boolean') prefs.allAgentTabs=value.allAgentTabs;
        if (typeof value.remoteUrl === 'string') { parseRemoteUrl(value.remoteUrl); prefs.remoteUrl = value.remoteUrl; remoteStatus = 'disconnected'; prefs.remoteControl = false; }
        if (typeof value.preview === 'boolean') prefs.preview = value.preview;
        if (['ask', 'block', 'approximate'].includes(value.locationDefault)) prefs.locationDefault = value.locationDefault;
        if (Number.isFinite(value.chatWidth)) prefs.chatWidth = Math.max(320, Math.min(680, value.chatWidth));
        savePreferences(); applyLayout(); break;
      case 'remote-control': prefs.remoteControl = value.enabled === true; break;
      case 'remote-status': remoteStatus = String(value.status).slice(0, 50); break;
      case 'remote-paste': if (!prefs.remoteControl || remoteStatus!=='connected') throw new Error('Take control of the connected VPS desktop first.'); return clipboard.readText().slice(0,20000);
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
      if (value.selectedId && prefs.bots.some((bot) => bot.id === value.selectedId)) selectAgent(value.selectedId);
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
  const result = await tab.view.webContents.executeJavaScript(snapshotExpression(generation));
  tab.refs = new Set(result.elements.map((item) => item.ref));
  return { ...result, tab: describeTab(tab) };
}
async function navigateVps(id,url) {
  await remoteRequest(id,'control',{controller:'human'});
  await remoteRequest(id,'human-actions',{action:'navigate',url:normalizeUrl(url)});
}
async function handoffTab({id,destination,includeDrafts=false,note=''}) {
  const source=tabs.get(id) || vpsTabs.get(id); if(!source)throw new Error('Source tab not found.');
  const sourceHost=tabs.has(id)?'mac':'vps';
  if(!['mac','vps'].includes(destination)||destination===sourceHost)throw new Error('Choose the other computer.');
  if(sourceHost==='mac') { changeController(id,'human'); await source.queue; }
  else await remoteRequest(id,'control',{controller:'human'});
  const checkpoint=sourceHost==='mac'?await source.view.webContents.executeJavaScript(checkpointExpression(includeDrafts)):await remoteRequest(id,'checkpoint',{includeDrafts});
  if(!/^https?:\/\//.test(checkpoint.url))throw new Error('Open a web page before handing it off.');
  const handoff={id:crypto.randomUUID(),sourceHost,sourceTabId:id,destinationHost:destination,createdAt:Date.now(),note:String(note).slice(0,4000),phase:'review_required'};
  let target,result;
  if(destination==='vps') {
    target=await vpsBrowser.request('/v1/tabs','POST',{url:checkpoint.url},{botId:source.botId,human:true});vpsTabs.set(target.id,target);
    result=await remoteRequest(target.id,'restore',{checkpoint,handoff});target=result.tab;
  } else {
    target=createTab({url:checkpoint.url,botId:source.botId,controller:'human',activate:false});target.handoff=handoff;
    for(let n=0;n<100;n++){if(!target.view.webContents.isLoading()&&target.view.webContents.getURL()!=='about:blank')break;await new Promise(r=>setTimeout(r,100));}
    if(target.view.webContents.isLoading())throw new Error('Mac destination is still loading. Inspect its new tab before retrying.');
    result=await target.view.webContents.executeJavaScript(restoreExpression(checkpoint));
  }
  const record={...handoff,destinationTabId:target.id,verification:result.verification,restoredDrafts:result.restored,skippedDrafts:result.skipped};
  if(destination==='mac')target.handoff=record;
  else {target.handoff=record;vpsTabs.set(target.id,target);}
  prefs.remoteControl=false; prefs.handoffs=[record,...prefs.handoffs].slice(0,20);activeTabId=destination==='vps'?'vps':target.id;
  if(destination==='vps')await remoteRequest(target.id,'activate',{});
  savePreferences();applyLayout();broadcast();return record;
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
      if (req.method === 'GET' && url.pathname === '/v1/status') return send(200, { name: app.getName(), version: app.getVersion(), protocol: 1, host: 'mac', hosts:{mac:'connected',vps:vpsBrowserStatus}, capabilities: ['tabs', 'snapshot', 'screenshot', 'navigate', 'click', 'type', 'press', 'move', 'scroll', 'agent-cursor', 'background-input', 'control-epochs'], tabCount: tabs.size+vpsTabs.size });
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
      if (url.pathname === '/v1/tabs' && req.method === 'GET') {
        if(prefs.vpsBrowser?.sshHost)await refreshVpsTabs();
        return send(200, { tabs: [...tabs.values()].filter(tab => !tab.extensionPage).map(describeTab).concat([...vpsTabs.values()]).filter((tab) => !botId || tab.botId === botId || tab.allowedBots.includes(botId)) });
      }
      if (url.pathname === '/v1/tabs' && req.method === 'POST') {
        if (!botId || botId.length > 100) throw Object.assign(new Error('X-Hermes-Bot is required.'), { status: 400 });
        const body = await readJson(req);
        if(body.host==='vps'){const result=await vpsBrowser.request('/v1/tabs','POST',body,{botId});vpsTabs.set(result.id,result);broadcast();return send(201,result);}
        if(body.host!==undefined&&body.host!=='mac')throw new Error('Choose mac or vps explicitly.');
        return send(201, describeTab(createTab({ url: body.url, botId, controller: 'agent', activate: body.background === false })));
      }
      const match = /^\/v1\/tabs\/([\w-]+)(?:\/(snapshot|screenshot|actions))?$/.exec(url.pathname);
      const tab = match && tabs.get(match[1]);
      if(match&&!tab&&prefs.vpsBrowser?.sshHost){
        const result=await vpsBrowser.request(url.pathname,req.method,req.method==='POST'?await readJson(req):undefined,{botId,epoch:Number(req.headers['x-control-epoch'])});
        const remote=result.tab || (result.id?result:null);if(remote)vpsTabs.set(remote.id,remote);if(req.method==='DELETE')vpsTabs.delete(match[1]);broadcast();return send(200,result);
      }
      if (!tab || tab.extensionPage) return send(404, { error: 'Tab not found.' });
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
  apiServer.listen(process.env.HERMES_WORKSPACE_PORT === undefined ? 9464 : Number(process.env.HERMES_WORKSPACE_PORT), '127.0.0.1', () => {
    apiPort = apiServer.address().port;
    fs.writeFileSync(path.join(app.getPath('userData'), 'connection.json'), JSON.stringify({ url: `http://127.0.0.1:${apiPort}`, token: API_TOKEN, protocol: 1 }, null, 2), { mode: 0o600 });
    broadcast();
  });
}
function createWindow() {
  nativeTheme.themeSource = 'dark';
  win = new BrowserWindow({ width: 1550, height: 980, minWidth: 1120, minHeight: 680, backgroundColor: '#09090a', title: app.getName(),
    titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 18 },
    webPreferences: { preload: path.join(ROOT, 'preload.bundle.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  telegramView = new WebContentsView({ webPreferences: { preload: path.join(ROOT, 'telegram-preload.cjs'), partition: 'persist:telegram', contextIsolation: true, nodeIntegration: false, sandbox: true } });
  telegramView.setBackgroundColor('#09090a');
  configureContents(telegramView.webContents, true);
  telegramView.webContents.on('did-start-loading', () => { activity.clear(); broadcast(); });
  telegramView.webContents.on('render-process-gone', () => { telegramStatus = 'offline'; activity.clear(); broadcast(); });
  telegramView.webContents.on('did-fail-load', (_e, code, _desc, _url, main) => { if (main && code !== -3) { telegramStatus = 'offline'; activity.clear(); broadcast(); } });
  win.contentView.addChildView(telegramView);
  remoteView = new WebContentsView({ webPreferences: { preload: path.join(ROOT, 'preload.bundle.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  remoteView.setBackgroundColor('#101011');
  remoteView.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  remoteView.webContents.on('will-navigate', (event) => event.preventDefault());
  remoteView.webContents.on('before-input-event',(event,input)=>{
    if(prefs.remoteControl && remoteStatus==='connected' && input.meta && input.type==='keyDown' && /^[altrwf]$/i.test(input.key)){
      event.preventDefault();remoteView.webContents.send('workspace:remote-shortcut',{key:input.key.toLowerCase(),shift:input.shift});
    }
  });
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
    { label: 'File', submenu: [{ label: 'New Browser Tab', accelerator: 'CmdOrCtrl+T', click: () => createTab({}) }, { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => extensionPopup?.browserWindow?.isFocused() ? extensionPopup.destroy() : closeTab(activeTabId) }] },
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
  vpsTimer=setInterval(refreshVpsTabs,5000);vpsTimer.unref();refreshVpsTabs();
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.whenReady().then(async () => {
    app.setAccessibilitySupportEnabled(true); prefs = readPreferences(); prefs.remoteControl = false;
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    const browserSession = session.fromPartition('persist:browser');
    extensionHost = new ElectronChromeExtensions({ license: 'GPL-3.0', session: browserSession,
      createTab: async details => { const tab = createTab({ url: details.url || 'about:blank', activate: details.active !== false, extensionPage: isExtensionUrl(details.url) }); return [tab.view.webContents, win]; },
      selectTab: wc => { if (isQuitting || registeringExtensionTab) return; const tab = [...tabs.values()].find(item => item.view.webContents === wc); if (tab) { activeTabId = tab.id; prefs.remoteControl = false; applyLayout(); broadcast(); } else BrowserWindow.fromWebContents(wc)?.show(); },
      removeTab: (wc, window) => { if (isQuitting) return; const tab = [...tabs.values()].find(item => item.view.webContents === wc); if (tab) closeTab(tab.id); else if (window !== win && window !== backgroundWindow && !window?.isDestroyed()) window?.close(); },
      createWindow: async details => {
        const popup = new BrowserWindow({ parent: win, width: details.width || 640, height: details.height || 720, webPreferences: { session: browserSession, sandbox: true, contextIsolation: true, nodeIntegration: false } });
        extensionHost.addTab(popup.webContents, popup); configureContents(popup.webContents);
        const url = Array.isArray(details.url) ? details.url[0] : details.url || 'about:blank';
        await popup.loadURL(isExtensionUrl(url) ? url : normalizeUrl(url)); return popup;
      },
      removeWindow: window => { if (window.isDestroyed()) return; if (window === win) throw new Error('The workspace window cannot be closed by an extension.'); window.close(); },
      requestPermissions: async (extension, permissions) => {
        if (!win?.isFocused() || activeTabId === 'vps') return false;
        const answer = await dialog.showMessageBox(win, { type: 'question', message: `${extension.name} requests additional access`, detail: [...(permissions.permissions || []), ...(permissions.origins || [])].join('\n'), buttons: ['Block', 'Allow'], defaultId: 0, cancelId: 0 });
        return answer.response === 1;
      } });
    for (const type of ['frame', 'service-worker']) browserSession.registerPreloadScript({ id: `hermes-extension-namespace-${type}`, type, filePath: path.join(ROOT, 'extension-namespace-preload.cjs') });
    ElectronChromeExtensions.handleCRXProtocol(session.defaultSession);
    extensionHost.on('browser-action-popup-created', popup => {
      extensionPopup = popup; extensionPopupTabId = activeTabId;
      popup.browserWindow?.once('closed', () => { if (extensionPopup === popup) extensionPopup = undefined; });
      popup.browserWindow?.webContents.setWindowOpenHandler(({ url }) => { createTab({ url, extensionPage: isExtensionUrl(url) }); return { action: 'deny' }; });
    });
    extensionStore = createExtensionStore({ root: app.getPath('userData'), session: browserSession, dialog, nativeImage, getWindow: () => win, getPreferences: () => prefs, savePreferences, onChanged: broadcast,
      canInstall: frame => [...tabs.values()].some(tab => tab.id === activeTabId && tab.controller === 'human' && tab.view.webContents.mainFrame === frame && !layout.obscured) });
    await extensionStore.installStore(); createWindow(); await extensionStore.restore(); broadcast();
  });
  app.on('second-instance', () => { win?.show(); win?.focus(); });
  app.on('activate', () => { win?.show(); win?.focus(); });
  app.on('before-quit', () => { isQuitting = true; clearInterval(pointerTimer); clearInterval(activityTimer); clearInterval(vpsTimer); savePreferences(); apiServer?.close(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
