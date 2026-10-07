const { app, BrowserWindow, WebContentsView, webContents, ipcMain, Menu, Tray, dialog, clipboard, shell, nativeTheme, screen, nativeImage, session, powerMonitor, net, protocol, systemPreferences } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { normalizeUrl, agentPageUrl, agentHostBarrier, faviconTarget, redactTabForBot, cdpMethodError, parseRemoteUrl, isSshTarget, requireActor, requireAgentRead, requireAgentClaim, reviewedHandoff, isAuthorized, sanitizeBots } = require('./core.cjs');
const { createAvatarStore, AVATAR_SCHEME } = require('./avatar-store.cjs');
const { writePrivateJson, normalizePreferences, coalesce, createSaver, createRetry, hostAllowed, fileUrlMatches, linuxTrayUsable, pollTier, watchChange } = require('./shell-support.cjs');
const { buildAgentPrompt } = require('./agent-prompt.cjs');
const { shouldOnboard, pinOnboarding } = require('./onboarding.cjs');
const macUpdate = require('./mac-update.cjs');
const { windowsFeed } = require('./win-update.cjs');
const { describeBuild, readBuildInfo } = require('./build-channel.cjs');
const { createAgentInput, tintScript, botAccent, boundedJs, readJs, frameOf, INPUT_ACTIONS } = require('./agent-input.cjs');
const { createActivityTracker } = require('./activity.cjs');
const { createSitePermissions } = require('./site-permissions.cjs');
const { snapshotExpression, settleSnapshot, readControls, checkpointExpression, restoreExpression } = require('./browser-page.cjs');
const { createVpsBrowser, backoffDelay, toCdpCookie, createMirrorPusher, prepareMirrorTabs, settleWithin, checkScriptPath } = require('./vps-browser.cjs');
const { createExtensionStore } = require('./extension-store.cjs');
const { createDownloadStore } = require('./download-store.cjs');
const { ElectronChromeExtensions } = require('electron-chrome-extensions');

// The host computer driver runs in the app's own session — the only place it
// works on Windows, where SSH-spawned processes sit in Session 0 and cannot
// see the desktop. Linux hosts drive the desktop through AT-SPI like the guest.
const macPermissions = require('./mac-permissions.cjs').createMacPermissionHelp({ systemPreferences });
const hostComputer = process.platform === 'darwin' ? macPermissions.wrap(require('./computer.cjs').service)
  : process.platform === 'win32' ? require('./win-computer.cjs').service
  : process.platform === 'linux' ? require('./vps-computer.cjs').service
  : null;
const HOST_LABEL = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows' : 'linux';
const isLocalHost = (value) => value === undefined || value === 'mac' || value === 'windows' || value === 'local' || value === HOST_LABEL;

app.enableSandbox();
protocol.registerSchemesAsPrivileged([{ scheme: AVATAR_SCHEME, privileges: { secure: true, supportFetchAPI: true } }]);
app.setName("alans-way-localapp");
if (process.platform === 'win32') app.setAppUserModelId('app.alans-way.localapp');
// Keep existing sessions and connector discovery stable when the product name changes.
app.setPath('userData', process.env.HERMES_WORKSPACE_DATA
  ? path.resolve(process.env.HERMES_WORKSPACE_DATA)
  : path.join(app.getPath('appData'), 'Hermes Workspace'));
const ROOT = __dirname;
const NEWTAB_URL = pathToFileURL(path.join(ROOT, 'newtab.html')).href;
const INDEX_FILE = path.join(ROOT, 'index.html');
const REMOTE_FILE = path.join(ROOT, 'remote.html');
const BUILD = readBuildInfo(path.join(ROOT, '..', 'build-info.json'));

// Log and keep running: a stray rejection in one tab's plumbing must not take
// down the connector every bot depends on. The log file helps when a Windows
// user reports a silent failure.
function logError(label, error) {
  const line = `${new Date().toISOString()} ${label}: ${error?.stack || error}\n`;
  try { console.error(line.trimEnd()); } catch {}
  try {
    const file = path.join(app.getPath('userData'), 'main-errors.log');
    if (fs.existsSync(file) && fs.statSync(file).size > 1000000) fs.renameSync(file, `${file}.old`);
    fs.appendFileSync(file, line);
  } catch {}
}
process.on('uncaughtException', (error) => logError('uncaughtException', error));
process.on('unhandledRejection', (reason) => logError('unhandledRejection', reason));
const TELEGRAM = 'https://web.telegram.org/a/';
let win, backgroundWindow, telegramView, remoteView, apiServer, prefs, layout = {}, apiPort = 0, tray, telegramRecovery;
let extensionStore, extensionHost, extensionPopup, extensionPopupTabId, extensionActiveContentsId;
let registeringExtensionTab = false;
const update = { available: '', tag: '', ready: false, busy: false, error: '', justUpdatedFrom: '' };
let activeTabId = 'home', browserReturnTabId = 'home', apiError = '', remoteStatus = 'disconnected', telegramStatus = 'loading', telegramDiagnostics = {};
const tabs = new Map();
const vpsTabs = new Map();
const recentLinkTabs = new Map();
let vpsBrowserStatus = 'unconfigured', vpsBrowserError = '', vpsRefreshBusy = false, vpsFailures = 0, vpsTimer, vpsMirrorTimer, vpsMirrorDebounce;
const vpsBrowser = createVpsBrowser({ getConfig: () => prefs?.vpsBrowser });
const configuredSessions = new WeakSet();
const API_TOKEN = crypto.randomBytes(32).toString('hex');
// Connectors allow 90s for action requests; a batch stops starting new steps
// early enough that its last step (wait caps at 30s) still answers in time.
const BATCH_BUDGET_MS = 50000;
const NAVIGATE_PARSE_MS = 3000;
// A snapshot waits this long for a still-parsing document; the wait ends at DOMContentLoaded.
const SNAPSHOT_PARSE_MS = 1500;
const WAIT_SLICE_MS = 1000;
let isQuitting = false;
let backgroundCaptureQueue = Promise.resolve();
const avatarStore = createAvatarStore({ root: ROOT, nativeImage, dialog, getWindow: () => win, getPreferences: () => prefs });
const agentInput = createAgentInput({ command: browserCommand,
  requireActor: (tab, botId, epoch, mutate) => requireActor(tab, botId, epoch, mutate, isOverseer(botId)),
  isVisible: (tab) => tab.host === win && win.isVisible() && !win.isMinimized(),
  botName: (id) => nameForBot(id) || 'Agent', onBusy: () => broadcast() });
const activity = createActivityTracker();
const sitePermissions = createSitePermissions({ getPreferences: () => prefs, savePreferences: () => { savePreferences(); broadcast(); },
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
const downloadStore = createDownloadStore({ getPreferences: () => prefs, savePreferences, onChanged: () => broadcast(),
  shell, existsSync: fs.existsSync, downloadsPath: () => app.getPath('downloads'), realpath: fs.realpathSync,
  // Recorded downloads are the only files a tab may open: the path always
  // comes from a store record, and agent tabs can never reach file: URLs
  // (agentPageUrl rejects them and will-navigate blocks in-page file: jumps).
  openInTab: async (record, { activate = true } = {}) => { createTab({ filePath: record.path, activate }); },
  confirmOpen: async (name) => (await dialog.showMessageBox(win, { type: 'warning', buttons: ['Cancel', 'Open anyway'], defaultId: 0, cancelId: 0,
    message: `Open ${name}?`, detail: 'This file can run programs on your computer. Only open it if you trust where it came from.' })).response === 1 });
let pointerTimer, activityTimer, idleTimer;

function readPreferences() {
  const defaults = { bots: [], order: [], hidden: [], selectedBotId: '', accountId: '', remoteUrl: '', remotePlatform: 'linux', chatWidth: 490, preview: true, previewPos: null, showBots: true, showBrowser: true, savedTabs: [], avatarLibrary: [], avatarPreferences: {}, locationDefault: 'approximate', sitePermissions: {}, browserExtensions: [], vpsBrowser: {}, agentIdleMinutes: 15, agentLastTabs: {}, handoffs: [], downloads: [],
    overseerBots: String(process.env.HERMES_OVERSEER_BOTS || '').split(',').map((id) => id.trim()).filter((id) => id && id.length <= 100) };
  const file = path.join(app.getPath('userData'), 'preferences.json');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { ...defaults, remoteUrl: process.env.HERMES_WORKSPACE_VPS_URL || '' }; }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Preferences are not an object.');
    return normalizePreferences(parsed, defaults);
  }
  catch {
    // Keep the unreadable file: the next save would otherwise erase every bot,
    // permission and extension record with defaults.
    try { fs.renameSync(file, `${file}.corrupt-${Date.now()}`); } catch {}
    return { ...defaults, remoteUrl: process.env.HERMES_WORKSPACE_VPS_URL || '' };
  }
}
// Explicit changes save at once; automatic ones (page loads, Telegram catalog
// polls) are batched. Either way nothing is written when nothing changed.
const prefsSaver = createSaver({
  snapshot() {
    if (!prefs) return null;
    if (win && !win.isDestroyed()) prefs.savedTabs = [...tabs.values()].filter(tab => !tab.extensionPage && tab.view?.webContents && !tab.view.webContents.isDestroyed()).map((tab) => ({ url: tab.view.webContents.getURL(), botId: tab.botId }));
    return prefs;
  },
  write(text) {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    writePrivateJson(path.join(app.getPath('userData'), 'preferences.json'), text);
  },
  onError: (error) => logError('preferences', error),
});
function savePreferences() { prefsSaver.flush(); }
function savePreferencesSoon() { prefsSaver.schedule(); }
function describeTab(tab, forBot = false) {
  const wc = tab.view?.webContents;
  const url = wc && !wc.isDestroyed() ? wc.getURL() : '';
  const info = { id: tab.id, title: tab.title || 'New tab', url, internal: url === NEWTAB_URL || url === 'about:blank', botId: tab.botId, favicon: tab.favicon || '', agentHue: botAccent(tab.botId).hue,
    controller: tab.controller, epoch: tab.epoch, loading: tab.loading, error: tab.error || '', allowedBots: tab.allowedBots, agentCursor: tab.agentCursor || null, agentBusy: agentInput.isDispatching(tab), extensionPage: tab.extensionPage === true, viewport: tab.viewport || null, host: HOST_LABEL, session: `shared-${HOST_LABEL}`, handoff: tab.handoff || null };
  return forBot ? redactTabForBot(info) : info;
}
function pageState(tab) {
  const wc = tab.view?.webContents;
  const url = wc && !wc.isDestroyed() ? wc.getURL() : '';
  return { generation: tab.generation, url, title: tab.title || 'New tab', loading: !!tab.loading };
}
// Action replies repeat on every call, so the tab record keeps only what the
// next call needs; url, title and loading already sit at the top level.
const TAB_NOISE = new Set(['url', 'title', 'favicon', 'internal', 'agentHue', 'agentCursor', 'agentBusy', 'session', 'extensionPage', 'loading', 'botId']);
function compactTab(info) {
  return Object.fromEntries(Object.entries(info).filter(([key, value]) => !TAB_NOISE.has(key) && value !== '' && value !== null && value !== false && !(Array.isArray(value) && !value.length)));
}
function actionReply(tab, payload = {}) {
  return { ...pageState(tab), ...payload, tab: compactTab(describeTab(tab, true)) };
}
function isVpsTab(id) { return vpsTabs.has(id); }
async function refreshVpsTabs() {
  if (!prefs?.vpsBrowser?.sshHost || vpsRefreshBusy) return;
  vpsRefreshBusy = true;
  try { const wasVps=vpsTabs.has(activeTabId); const data = await vpsBrowser.request('/v1/tabs', 'GET', undefined, { human: true }); vpsTabs.clear(); data.tabs.forEach(tab => { vpsTabs.set(tab.id, tab); resolveFavicon(tab, [tab.favicon]).catch(() => {}); }); if(wasVps&&!vpsTabs.has(activeTabId)){prefs.remoteControl=false;activeTabId='home';applyLayout();} vpsBrowserStatus = 'connected'; vpsBrowserError = ''; vpsFailures = 0; }
  catch (error) { vpsBrowserStatus = 'disconnected'; vpsBrowserError = /^Invalid VPS browser/.test(error.message) ? error.message : ''; vpsFailures++; }
  finally { vpsRefreshBusy = false; broadcast(); }
}
// Agent-controlled Mac tabs are mirrored to the VM (URL, scroll, text drafts,
// the page's cookies) so a failover can continue them signed in. Password
// fields never leave: checkpointExpression skips them.
const mirrorPages = new Map(), mirrorCapWarned = new Set();
const pushVpsMirror = createMirrorPusher({
  bots: () => (prefs?.bots || []).map((bot) => bot.id),
  async collect() {
    if (!prefs?.vpsBrowser?.sshHost || vpsBrowserStatus !== 'connected') return null;
    const jar = session.fromPartition('persist:browser').cookies;
    const agentTabs = [...tabs.values()].filter((tab) => {
      const wc = tab.view?.webContents;
      return tab.controller === 'agent' && !tab.extensionPage && tab.botId !== 'shared' && wc && !wc.isDestroyed() && /^https?:\/\//.test(wc.getURL());
    }).slice(0, 20);
    // A tab stuck on a dialog or a hung renderer keeps its last read instead of stalling every bot's push.
    const read = await Promise.all(agentTabs.map(async (tab) => {
      const wc = tab.view.webContents;
      const page = await settleWithin(wc.executeJavaScript(checkpointExpression(true)), 2000, null) || mirrorPages.get(tab.id);
      if (!page) return null;
      mirrorPages.set(tab.id, page);
      const cookies = (await settleWithin(jar.get({ url: page.url }), 2000, [])).slice(0, 100).map(toCdpCookie);
      return { botId: tab.botId, tab: { id: tab.id, ...page, cookies } };
    }));
    for (const id of mirrorPages.keys()) if (!tabs.has(id)) mirrorPages.delete(id);
    const bots = new Map();
    for (const item of read) if (item) bots.set(item.botId, [...(bots.get(item.botId) || []), item.tab]);
    for (const [bot, list] of bots) {
      const { tabs: fitted, dropped } = prepareMirrorTabs(list);
      bots.set(bot, fitted);
      if (dropped && !mirrorCapWarned.has(bot)) { mirrorCapWarned.add(bot); console.warn(`VPS mirror for bot ${bot} is over the size cap; the ${dropped} oldest agent tab(s) are left out.`); }
    }
    return bots;
  },
  push: (bot, mirrorTabs) => vpsBrowser.request('/v1/mirror', 'POST', { bot, tabs: mirrorTabs }, { human: true, botId: bot }),
});
function scheduleVpsMirror() {
  if (!prefs?.vpsBrowser?.sshHost) return;
  clearTimeout(vpsMirrorDebounce);
  vpsMirrorDebounce = setTimeout(pushVpsMirror, 1500);
  vpsMirrorDebounce.unref();
}
const nameForBot = (id) => prefs?.bots.find((bot) => bot.id === id)?.name || '';
const isOverseer = (botId) => Array.isArray(prefs?.overseerBots) && prefs.overseerBots.includes(botId);
async function remoteRequest(id, operation, body, { human = true, botId = prefs.selectedBotId || 'shared' } = {}) {
  const result = await vpsBrowser.request(`/v1/tabs/${id}${operation ? '/' + operation : ''}`, body === undefined ? 'GET' : 'POST', body, {human, botId, botName: nameForBot(botId)});
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
  const own = [...tabs.values()].filter(tab => tab.botId === id || (tab.allowedBots ?? []).includes(id));
  const nextLocal = own.some(tab => tab.id === prefs.agentLastTabs[id]) ? prefs.agentLastTabs[id] : own.at(-1)?.id || 'home';
  browserReturnTabId = nextLocal;
  activeTabId = viewingVps ? 'vps' : nextLocal;
  applyLayout();
}
function getState() {
  return { name: app.getName(), version: app.getVersion(), build: BUILD, buildBadge: describeBuild(BUILD), bots: avatarStore.publicBots().map(bot => ({ ...bot, activity: activity.get(bot.id), hue: botAccent(bot.id).hue })), order: prefs.order, hidden: prefs.hidden,
    selectedBotId: prefs.selectedBotId, chatWidth: prefs.chatWidth, preview: prefs.preview, previewPos: prefs.previewPos, showBots: prefs.showBots, showBrowser: prefs.showBrowser, remoteUrl: prefs.remoteUrl,
    remoteStatus, remoteControl: prefs.remoteControl === true, telegramStatus, tabs: [...tabs.values()].map(tab => describeTab(tab)),
    vpsBrowser: prefs.vpsBrowser, vpsBrowserStatus, vpsBrowserError, handoffs: prefs.handoffs, macSshHost: prefs.macSshHost || '',
    platform: process.platform, hostLabel: HOST_LABEL, remotePlatform: prefs.remotePlatform || 'linux',
    update: { available: update.available, ready: update.ready, busy: update.busy, error: update.error, justUpdatedFrom: update.justUpdatedFrom },
    onboarding: shouldOnboard(prefs), inApplications: process.platform === 'darwin' && app.isPackaged ? app.isInApplicationsFolder() : null,
    primaryBotId: prefs.primaryBotId || (prefs.overseerBots || [])[0] || '', primaryBotPref: prefs.primaryBotId || '', overseerBots: prefs.overseerBots || [],
    botSort: prefs.botSort || 'manual',
    autoOpenLinks: prefs.autoOpenLinks !== false,
    activeTabId, browserContentsId: (() => { const contents = tabs.get(activeTabId)?.view?.webContents; return contents && !contents.isDestroyed() ? contents.id : null; })(), browserTabId: activeTabId === 'vps' ? (tabs.has(browserReturnTabId) ? browserReturnTabId : 'home') : activeTabId, avatarLibrary: avatarStore.publicLibrary(), avatarPreferences: prefs.avatarPreferences,
    locationDefault: prefs.locationDefault, sitePermissions: prefs.sitePermissions, extensions: extensionStore?.list() || [], downloads: downloadStore.list(),
    fullscreen: win?.isFullScreen() || false, api: { url: apiPort ? `http://127.0.0.1:${apiPort}` : '', ready: !!apiPort, error: apiError } };
}
let lastBotWorkSignature = '';
// Bots with agent tabs that are dispatching, navigating, or recently acted
// count as working — the Telegram preload draws the composer orbit glow.
function computeBotWork() {
  const working = {};
  for (const tab of tabs.values()) {
    if (tab.controller === 'agent' && (agentInput.isDispatching(tab) || tab.loading || Date.now() - Math.max(tab.agentSince || 0, tab.lastAgentActivity || 0) < 15000)) working[tab.botId] = botAccent(tab.botId).hue;
  }
  for (const tab of vpsTabs.values()) {
    if (tab.controller === 'agent' && tab.agentBusy) working[tab.botId] = botAccent(tab.botId).hue;
  }
  return working;
}
function sendBotWork() {
  const working = computeBotWork();
  lastBotWorkSignature = JSON.stringify(working);
  if (telegramView && !telegramView.webContents.isDestroyed()) telegramView.webContents.send('workspace:bot-activity', working);
}
let lastStateSignature = '';
function sendState() {
  if (!win || win.isDestroyed() || !prefs) return;
  const state = getState();
  const stateSignature = JSON.stringify(state);
  if (stateSignature !== lastStateSignature) {
    lastStateSignature = stateSignature;
    win.webContents.send('workspace:state', state);
    if (remoteView && !remoteView.webContents.isDestroyed()) remoteView.webContents.send('workspace:state', state);
  }
  const signature = JSON.stringify(computeBotWork());
  if (signature !== lastBotWorkSignature) sendBotWork();
}
// Tab titles, loading and activity fire in bursts; at most one send per frame.
const scheduleState = coalesce(sendState, 16);
function broadcast() { scheduleState(); }
// A command's reply must find the renderer already showing its result.
function broadcastNow() { scheduleState(); scheduleState.flush(); }
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
    const opener = [...tabs.values()].find((tab) => tab.view.webContents === contents);
    try { url = extensionPage ? details.url : (opener?.controller === 'agent' ? agentPageUrl(details.url) : normalizeUrl(details.url)); } catch { return { action: 'deny' }; }
    if (isTelegram) {
      // Guest windows inherit the persist:telegram session, which the extension
      // host rejects — open Telegram links in our own browser-session tab.
      const opened = recentLinkTabs.get(url);
      if (opened && Date.now() - opened.at < 15000 && tabs.has(opened.tabId)) {
        if (details.disposition !== 'background-tab') { activeTabId = opened.tabId; broadcast(); }
      } else {
        try { createTab({ url }); } catch {}
      }
      return { action: 'deny' };
    }
    return { action: 'allow', createWindow: (options) => {
      const parent = opener;
      const tab = createTab({ url, extensionPage, botId: parent?.botId || prefs.selectedBotId || 'shared', controller: extensionPage ? 'human' : parent?.controller || 'human', options, skipLoad: details.disposition !== 'background-tab', activate: parent?.controller !== 'agent' && details.disposition !== 'background-tab' });
      return tab.view.webContents;
    } };
  });
  // Agent tabs follow redirects and in-page location changes without another
  // API call, so the address check has to live on the navigation itself.
  const blockAgentNavigation = (event, url) => {
    const owner = [...tabs.values()].find((tab) => tab.view.webContents === contents);
    if (owner?.controller !== 'agent') return;
    try { agentPageUrl(url); } catch { event.preventDefault(); }
  };
  contents.on('will-navigate', (event, url) => {
    if (isTelegram && !url.startsWith(TELEGRAM)) { event.preventDefault(); try { createTab({ url }); } catch {} }
    else if (!isTelegram) blockAgentNavigation(event, url);
    if (isTelegram) return;
    if (!isTelegram && !/^https?:\/\//i.test(url) && url !== 'about:blank') {
      if (!isExtensionUrl(url)) event.preventDefault();
      else { const tab = [...tabs.values()].find(item => item.view.webContents === contents); if (tab) { tab.extensionPage = true; changeController(tab.id, 'human'); } }
    }
  });
  contents.on('will-redirect', (event, url) => { if (!isTelegram) blockAgentNavigation(event, url); });
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
  downloadStore.install(session, isTelegram ? 'telegram' : 'browser');
}
function isExtensionUrl(value) {
  try { const url = new URL(value); return url.protocol === 'chrome-extension:' && !url.username && !url.password && !!session.fromPartition('persist:browser').extensions.getExtension(url.hostname); } catch { return false; }
}
// Blank pages show the bundled backdrop instead of an empty dark document.
function pageUrl(url, extensionPage = false) {
  if (url === 'about:blank' || url === NEWTAB_URL) return NEWTAB_URL;
  if (extensionPage && isExtensionUrl(url)) return url;
  return normalizeUrl(url);
}
const faviconCache = new Map();
async function resolveFavicon(tab, favicons) {
  const seq = (tab.faviconSeq = (tab.faviconSeq || 0) + 1);
  const apply = (value) => { if (tab.faviconSeq === seq && value !== tab.favicon) { tab.favicon = value; broadcast(); } };
  const url = favicons.find((item) => /^https?:\/\//i.test(item));
  if (!url) return apply(favicons.find((item) => item && item !== 'data:,') || '');
  // Only same-origin icons, fetched without the browser session or its
  // cookies: a page-controlled favicon URL must never become a credentialed
  // fetch to somewhere the page points at (loopback, LAN, metadata).
  const pageUrlNow = tab.view?.webContents && !tab.view.webContents.isDestroyed() ? tab.view.webContents.getURL() : String(tab.url || '');
  let target = faviconTarget(pageUrlNow, url);
  if (!target) return apply('');
  if (faviconCache.has(target)) return apply(faviconCache.get(target));
  try {
    let response;
    for (let hop = 0; hop < 3; hop++) {
      response = await fetch(target, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location) {
        target = faviconTarget(pageUrlNow, new URL(location, target).href);
        if (!target) return apply('');
      } else break;
    }
    const mime = response.headers.get('content-type')?.split(';')[0]?.trim() || '';
    if (!response.ok || !mime.startsWith('image/')) return apply('');
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length || buffer.length > 262144) return apply('');
    const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;
    if (faviconCache.size > 300) faviconCache.clear();
    faviconCache.set(target, dataUrl);
    apply(dataUrl);
  } catch { apply(''); }
}
function createTab({ url = 'about:blank', filePath = '', botId = prefs.selectedBotId || 'shared', controller = 'human', options, skipLoad = false, activate = true, extensionPage = false } = {}) {
  if (tabs.size >= 40) throw new Error('Close a tab before opening another.');
  const targetUrl = filePath ? pathToFileURL(filePath).href : pageUrl(url, extensionPage);
  // plugins: true enables only Chromium's bundled PDF viewer, so a PDF URL
  // renders in the tab instead of downloading. The rest of the lockdown list
  // is unchanged, and the extension preload ignores the viewer's own frame.
  const view = new WebContentsView({ ...(options?.webContents ? { webContents: options.webContents } : {}),
    webPreferences: { ...options?.webPreferences, preload: undefined, partition: 'persist:browser', contextIsolation: true, nodeIntegration: false, sandbox: true,
      webSecurity: true, plugins: true, backgroundThrottling: false } });
  view.setBackgroundColor('#0b0b0c');
  const tab = { id: crypto.randomUUID(), view, botId: String(botId).slice(0, 100), controller, extensionPage, epoch: 1, title: 'New tab', loading: false, allowedBots: [], refs: new Set(), generation: 0, queue: Promise.resolve() };
  if (controller === 'agent') tab.agentSince = Date.now();
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
  view.webContents.on('did-stop-loading', () => { tab.loading = false; savePreferencesSoon(); broadcast(); });
  view.webContents.on('did-navigate', () => { tab.refs.clear(); tab.snapshotStamp = null; tab.generation++; if (tab.controller === 'agent') { view.webContents.executeJavaScript(tintScript(true)).catch(() => {}); scheduleVpsMirror(); } broadcast(); });
  view.webContents.on('page-favicon-updated', (event, favicons) => { resolveFavicon(tab, favicons).catch(() => {}); });
  view.webContents.on('did-navigate-in-page', () => { tab.refs.clear(); tab.generation++; if (tab.controller === 'agent') scheduleVpsMirror(); broadcast(); });
  view.webContents.on('did-fail-load', (_e, code, description, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) { tab.error = description; tab.loading = false; broadcast(); }
  });
  view.webContents.on('render-process-gone', () => { tab.error = 'This page stopped. Reload to reconnect.'; broadcast(); });
  // Pages can close themselves (OAuth popups end with window.close()); once the
  // webContents is gone the tab is a zombie — route it through normal cleanup.
  // During teardown the hosts are already gone and cleanup only throws, and
  // app.exit() tears down without before-quit, so check the host itself.
  view.webContents.on('destroyed', () => { if (!isQuitting && tabs.has(tab.id) && !tab.host?.isDestroyed()) closeTab(tab.id); });
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
  if (tab.view.webContents) extensionHost?.removeTab(tab.view.webContents);
  if (browserReturnTabId === id) browserReturnTabId = [...tabs.keys()].at(-1) || 'home';
  tab.host?.contentView.removeChildView(tab.view);
  tab.view.webContents?.close();
  if (activeTabId === id) activeTabId = [...tabs.keys()].at(-1) || 'home';
  savePreferences(); applyLayout(); broadcast();
}
function changeController(id, controller, source = 'human') {
  const tab = tabs.get(id);
  if (!tab) throw new Error('Tab not found.');
  if (tab.extensionPage && controller === 'agent') throw new Error('Extension account pages stay under your control.');
  const wasAgent = tab.controller === 'agent';
  tab.controller = controller === 'agent' ? 'agent' : 'human';
  // An explicit human takeover seals the tab to bots until the human hands
  // it back in the UI. A bot's own release or the idle-expiry clock stays
  // retakeable, and a tab already locked stays locked.
  if (tab.controller === 'agent') { tab.humanLock = false; tab.agentSince = Date.now(); }
  else if (wasAgent) tab.humanLock = source === 'human';
  if (tab.controller === 'agent' && tab.botId === 'shared' && prefs.selectedBotId) tab.botId = prefs.selectedBotId;
  // Bots can't plant persistent page scripts (the cdp action denies the
  // method) but strip any surviving registrations when the human takes over.
  if (tab.controller === 'human' && !tab.view.webContents.isDestroyed() && tab.view.webContents.debugger.isAttached())
    browserCommand(tab, 'Page.removeAllScriptsToEvaluateOnNewDocument').catch(() => {});
  tab.view.webContents.executeJavaScript(tintScript(tab.controller === 'agent')).catch(() => {});
  tab.epoch++;
  tab.refs.clear();
  agentInput.clear(tab).catch(() => {});
  scheduleVpsMirror();
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
  const details = { eventType: 'click', extensionId: item.id, tabId: tab.view.webContents.id, alignment: 'bottom',
    anchorRect: { x: Number.isFinite(anchor?.x) ? anchor.x - 28 : win.getContentBounds().width - 90, y: Number.isFinite(anchor?.y) ? anchor.y - 28 : 100, width: 28, height: 28 } };
  await win.webContents.executeJavaScript(`window.browserAction.activate('persist:browser', ${JSON.stringify(details)})`);
}
function trustSender(event) {
  // Reading .webContents or .getURL() on a torn-down view throws; a destroyed
  // sender is simply untrusted. Each bridge-bearing page is trusted only at its
  // own exact file, never at "any file:" a drop or link could navigate to.
  try {
    const expected = event.sender === win?.webContents ? INDEX_FILE : event.sender === remoteView?.webContents ? REMOTE_FILE : '';
    if (!expected || event.senderFrame !== event.sender.mainFrame || !fileUrlMatches(event.sender.getURL(), expected)) throw new Error('untrusted');
  } catch { throw new Error('Untrusted workspace request.'); }
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
  if (!selected) await openTelegramHash(id);
}
// Changing only the hash keeps Telegram's session loaded; a full reload is for
// when the hash already matches and the page is stuck.
async function openTelegramHash(hash) {
  const wc = telegramView.webContents, target = `${TELEGRAM}#${hash}`;
  if (wc.getURL() === target) { wc.reload(); return; }
  // If Telegram ignores the hash change (the open chat does not move), reload once.
  const read = () => wc.executeJavaScript(`(document.querySelector('#MiddleColumn .MiddleHeader')?.textContent || '') + '|' + !!document.querySelector('#MiddleColumn .Composer')`);
  // The baseline read goes out before the navigation so it sees the old chat.
  watchChange({ read, delayMs: 1500, onStuck: () => { if (!wc.isDestroyed() && wc.getURL() === target) wc.reload(); } });
  await wc.loadURL(target).catch(() => {});
}
// Offline or rate-limited checks stay quiet for the user; only the first failure is logged, and the next check retries.
function startUpdates() {
  if (prefs.lastVersion && prefs.lastVersion !== app.getVersion()) update.justUpdatedFrom = prefs.lastVersion;
  if (prefs.lastVersion !== app.getVersion()) { prefs.lastVersion = app.getVersion(); savePreferences(); }
  if (!app.isPackaged) return;
  let check;
  if (process.platform === 'win32') {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('update-downloaded', (info) => { update.available = info.version; update.ready = true; broadcast(); });
    const feed = windowsFeed(fs.existsSync(path.join(process.resourcesPath, 'app-update.yml')), require('../package.json'));
    if (feed) autoUpdater.setFeedURL(feed);
    let logged = false;
    const failed = (error) => { if (!logged) { logged = true; logError('updater', error); } };
    autoUpdater.on('error', failed);
    check = () => autoUpdater.checkForUpdates().catch(failed);
  } else if (process.platform === 'darwin') {
    check = async () => {
      try {
        const latest = await macUpdate.checkLatest();
        if (latest && macUpdate.isNewer(latest.version, app.getVersion())) { update.available = latest.version; update.tag = latest.tag; broadcast(); }
      } catch {}
    };
  } else return;
  check(); setInterval(check, 6 * 60 * 60 * 1000);
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
        const tab = tabs.get(value.id); if (tab) { changeController(tab.id, 'human'); await tab.view.webContents.loadURL(pageUrl(value.url)).catch(() => {}); } break;
      }
      case 'history': {
        if (isVpsTab(value.id)) { await remoteRequest(value.id,'control',{controller:'human'}); await remoteRequest(value.id,'human-actions',{action:value.action}); break; }
        const tab = tabs.get(value.id); if (!tab) break;
        changeController(tab.id, 'human'); const history = tab.view.webContents.navigationHistory;
        if (value.action === 'back' && history.canGoBack()) history.goBack();
        if (value.action === 'forward' && history.canGoForward()) history.goForward();
        if (value.action === 'reload') tab.view.webContents.reload(); break;
      }
      case 'control': {
        if(isVpsTab(value.id)){if(value.controller==='agent')prefs.remoteControl=false;return remoteRequest(value.id,'control',{controller:value.controller});}
        const tab = tabs.get(value.id);
        if (tab && value.controller === 'agent') tab.handoff = reviewedHandoff(tab.handoff);
        return changeController(value.id, value.controller);
      }
      case 'share-page': {
        const tab = tabs.get(activeTabId);
        const url = tab ? tab.view.webContents.getURL() : '';
        if (!tab || !/^https?:\/\//i.test(url)) throw new Error('Open a web page first.');
        const title = (tab.view.webContents.getTitle() || url).slice(0, 300);
        if (!prefs.selectedBotId) throw new Error('Select a bot in the sidebar first. That is who the page goes to.');
        if (!telegramView || telegramView.webContents.isDestroyed()) throw new Error('Telegram is not loaded.');
        const tg = telegramView.webContents;
        const chatHash = new RegExp(`#${prefs.selectedBotId.replace(/\W/g, '')}(?:_|/|$)`);
        if (!chatHash.test(tg.getURL())) await openBot(prefs.selectedBotId);
        if (tg.isLoading()) throw new Error('Telegram is still loading. Try again in a moment.');
        let point = null;
        for (let i = 0; i < 16 && !point; i++) {
          // A stopped or never-committed page can leave executeJavaScript pending
          // forever; bound the probe so the button reports instead of hanging.
          point = await Promise.race([
            tg.executeJavaScript(`(() => {
              const el = document.querySelector('#editable-message-text') || document.querySelector('.Composer [contenteditable="true"], #MiddleColumn [contenteditable="true"]');
              if (!el || !el.offsetParent) return null;
              const r = el.getBoundingClientRect();
              return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
            })()`).catch(() => null),
            new Promise(resolve => setTimeout(() => resolve(null), 3000)),
          ]);
          if (!point) await new Promise(resolve => setTimeout(resolve, 250));
        }
        if (!point) throw new Error('The bot chat opened but no message box appeared.');
        if (!tg.debugger.isAttached()) tg.debugger.attach('1.3');
        try {
          await tg.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
          await tg.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
          await tg.debugger.sendCommand('Input.insertText', { text: `${title}\n${url}` });
          const enter = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
          await tg.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', ...enter });
          await tg.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...enter });
        }
        finally { tg.debugger.detach(); }
        break;
      }
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
      case 'list-cookies': {
        const groups = new Map();
        for (const c of await session.fromPartition('persist:browser').cookies.get({})) {
          const d = (c.domain || '').replace(/^\./, '');
          groups.set(d, (groups.get(d) || 0) + 1);
        }
        return [...groups.entries()].map(([domain, count]) => ({ domain, count })).sort((a, b) => b.count - a.count);
      }
      case 'clear-cookies': {
        const domain = String(value?.domain || '');
        const jar = session.fromPartition('persist:browser').cookies;
        for (const c of await jar.get({})) {
          const d = (c.domain || '').replace(/^\./, '');
          if (domain && d !== domain && !d.endsWith(`.${domain}`)) continue;
          await jar.remove(`${c.secure ? 'https' : 'http'}://${d}${c.path || '/'}`, c.name).catch(() => {});
        }
        broadcast(); break;
      }
      case 'open-download': await downloadStore.open(value.id); break;
      case 'show-download': downloadStore.showInFolder(value.id); break;
      case 'pause-download': downloadStore.pause(value.id, value.paused === true); break;
      case 'cancel-download': downloadStore.cancel(value.id); break;
      case 'clear-downloads': downloadStore.clear(); break;
      case 'downloads-folder': await downloadStore.openFolder(); break;
      case 'open-bot': await openBot(String(value.id)); break;
      case 'sort-bots': prefs.order = Array.isArray(value.ids) ? value.ids.filter((id) => prefs.bots.some((bot) => bot.id === id)) : prefs.order; savePreferences(); break;
      case 'bot-sort': if (['recent', 'alpha', 'manual'].includes(value.mode)) { prefs.botSort = value.mode; savePreferences(); } break;
      case 'hide-bot':
      case 'set-bot-visibility': {
        const id = String(value.id);
        if (!prefs.bots.some((bot) => bot.id === id)) throw new Error('Telegram bot not found. Sync your bot list and try again.');
        if (command === 'set-bot-visibility' && typeof value.visible !== 'boolean') throw new Error('Choose whether to show this bot.');
        if (command === 'set-bot-visibility' && value.visible) prefs.hidden = prefs.hidden.filter((hiddenId) => hiddenId !== id);
        else if (!prefs.hidden.includes(id)) prefs.hidden.push(id);
        savePreferences(); break;
      }
      case 'set-site-permission': sitePermissions.set(value); break;
      case 'reset-site-permissions': sitePermissions.reset(); break;
      case 'settings':
        if (typeof value.macSshHost === 'string' && value.macSshHost.trim() && !isSshTarget(value.macSshHost.trim())) throw new Error('Enter the Mac SSH address as user@host or host, with no spaces or symbols.');
        if (value.vpsBrowser && typeof value.vpsBrowser === 'object') {
          const sshHost = String(value.vpsBrowser.sshHost || '').trim();
          if (sshHost && !isSshTarget(sshHost)) throw new Error('Enter the VPS SSH address as user@host or host, with no spaces or symbols.');
          const scriptPath = String(value.vpsBrowser.scriptPath || '').trim();
          if (scriptPath && checkScriptPath(scriptPath)) throw new Error(checkScriptPath(scriptPath));
          prefs.vpsBrowser={sshHost,scriptPath,sudo:value.vpsBrowser.sudo===true}; vpsBrowserStatus='connecting'; refreshVpsTabs();
        }
        if (Number.isFinite(value.agentIdleMinutes)) prefs.agentIdleMinutes = Math.max(1, Math.min(240, value.agentIdleMinutes));
        if (typeof value.remoteUrl === 'string') { parseRemoteUrl(value.remoteUrl); prefs.remoteUrl = value.remoteUrl; remoteStatus = 'disconnected'; prefs.remoteControl = false; }
        if (value.remotePlatform !== undefined) prefs.remotePlatform = value.remotePlatform === 'mac' ? 'mac' : 'linux';
        if (typeof value.preview === 'boolean') prefs.preview = value.preview;
        if (typeof value.showBots === 'boolean') prefs.showBots = value.showBots;
        if (typeof value.showBrowser === 'boolean') prefs.showBrowser = value.showBrowser;
        if (typeof value.macSshHost === 'string') prefs.macSshHost = value.macSshHost.trim();
        if (typeof value.autoOpenLinks === 'boolean') prefs.autoOpenLinks = value.autoOpenLinks;
        if (typeof value.primaryBotId === 'string') prefs.primaryBotId = prefs.bots.some((bot) => bot.id === value.primaryBotId) || value.primaryBotId === '' ? value.primaryBotId : prefs.primaryBotId;
        if (['ask', 'block', 'approximate'].includes(value.locationDefault)) prefs.locationDefault = value.locationDefault;
        if (Number.isFinite(value.chatWidth)) prefs.chatWidth = Math.max(320, Math.min(680, value.chatWidth));
        savePreferences(); applyLayout(); break;
      case 'preview-move': {
        // The mini VM window floats anywhere inside the workspace pane.
        const x = Number(value.x), y = Number(value.y);
        if (Number.isFinite(x) && Number.isFinite(y)) { prefs.previewPos = { x: Math.round(x), y: Math.round(y) }; savePreferences(); }
        break;
      }
      case 'preview-nudge': {
        // The streamed desktop's own surface forwards drag deltas — the window
        // renderer owns the slot's position, so relay rather than duplicating.
        const dx = Number(value?.dx), dy = Number(value?.dy);
        if (Number.isFinite(dx) && Number.isFinite(dy) && win && !win.isDestroyed()) win.webContents.send('workspace:preview-nudge', { dx, dy });
        break;
      }
      case 'preview-drop': if (win && !win.isDestroyed()) win.webContents.send('workspace:preview-drop'); break;
      case 'remote-control': prefs.remoteControl = value.enabled === true; break;
      case 'remote-status': remoteStatus = String(value.status).slice(0, 50); break;
      case 'remote-paste': if (!prefs.remoteControl || remoteStatus!=='connected') throw new Error('Take control of the connected remote desktop first.'); return clipboard.readText().slice(0,20000);
      case 'fullscreen': win.setFullScreen(!win.isFullScreen()); break;
      case 'open-settings': win.webContents.send('workspace:settings'); break;
      case 'focus-workspace': win.webContents.send('workspace:focus-workspace'); break;
      case 'copy-connection': clipboard.writeText(JSON.stringify({ url: `http://127.0.0.1:${apiPort}`, token: API_TOKEN }, null, 2)); break;
      case 'agent-setup': {
        const botId = String(value?.botId || prefs.selectedBotId || '').replace(/[^0-9A-Za-z_-]/g, '');
        if (!botId) throw new Error('Select a bot first. Its ID goes in the agent config.');
        const bot = prefs.bots.find(item => item.id === botId);
        const macSsh = (prefs.macSshHost || '').trim();
        const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
        clipboard.writeText([
          "# Alan's Way setup: paste into a terminal on the host running your Hermes gateway",
          `curl -fsSL https://raw.githubusercontent.com/capthvnsen/alans-way-agents/main/setup.sh | bash -s -- --bot-id ${q(botId)}${bot ? ` --bot-name ${q(bot.name.replace(/'/g, ''))}` : ''}${macSsh ? ` --mac-ssh ${q(macSsh)}` : ''}${HOST_LABEL === 'mac' ? '' : ` --host-os ${HOST_LABEL}`} --timezone ${q(Intl.DateTimeFormat().resolvedOptions().timeZone)} --restart`,
          '# The bootstrap installs the plugin + hook, configures the browser connector,',
          '# offers to bind the primary route, restarts the gateway, and verifies itself.',
        ].join('\n'));
        break;
      }
      case 'agent-prompt': {
        const botId = String(value?.botId || prefs.selectedBotId || '').replace(/[^0-9A-Za-z_-]/g, '');
        const text = buildAgentPrompt({ kind: value?.kind === 'update' ? 'update' : 'setup', hostLabel: HOST_LABEL, version: app.getVersion(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, botId, sshHost: (prefs.macSshHost || '').trim() });
        if (value?.copy !== false) clipboard.writeText(text);
        return text;
      }
      case 'test-agent-path': {
        const host = (prefs.vpsBrowser?.sshHost || '').trim();
        const mac = (prefs.macSshHost || '').trim();
        if (!host) throw new Error('Save a VPS browser SSH host first.');
        if (!isSshTarget(host)) throw new Error('The saved VPS SSH address is invalid. Re-enter it as user@host or host.');
        if (!mac) throw new Error(`Enter this ${HOST_LABEL === 'windows' ? 'PC' : 'computer'}’s SSH address as your VPS reaches it.`);
        if (!isSshTarget(mac)) throw new Error('The saved SSH address for this computer is invalid. Re-enter it as user@host or host.');
        return new Promise((resolve) => {
          const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=yes', host,
            `ssh -o BatchMode=yes -o ConnectTimeout=6 -o StrictHostKeyChecking=yes ${mac} 'echo AGENT_PATH_OK'`], { timeout: 30000 });
          let out = '';
          child.stdout.on('data', chunk => { out += chunk; });
          child.stderr.on('data', chunk => { out += chunk; });
          child.on('error', () => resolve({ ok: false, detail: 'Could not start ssh. Check local ssh access.' }));
          child.on('close', code => resolve(out.includes('AGENT_PATH_OK')
            ? { ok: true, detail: `VPS reaches this ${HOST_LABEL === 'mac' ? 'Mac' : HOST_LABEL === 'windows' ? 'PC' : 'computer'} over ssh, so agents can route here.` }
            : out.includes('Tailscale SSH requires an additional check')
              ? { ok: false, detail: 'Tailscale SSH on the VPS wants a browser check for this login, which unattended agents cannot pass. In the Tailscale admin console → Access controls, change the SSH rule for this user from "check" to "accept".' }
              : { ok: false, detail: `Path check failed (exit ${code}). ${out.trim().slice(0, 300)}` }));
        });
      }
      case 'show-data': shell.openPath(app.getPath('userData')); break;
      case 'mac-permissions': return process.platform === 'darwin' ? { accessibility: systemPreferences.isTrustedAccessibilityClient(false), screen: systemPreferences.getMediaAccessStatus('screen') } : null;
      case 'open-mac-privacy': if (process.platform === 'darwin') shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${value.pane === 'screen' ? 'Privacy_ScreenCapture' : 'Privacy_Accessibility'}`); break;
      case 'update-now': {
        if (process.platform === 'win32') { if (update.ready) require('electron-updater').autoUpdater.quitAndInstall(); break; }
        if (!update.tag) break;
        update.busy = true; update.error = ''; broadcast();
        try { await macUpdate.installMacUpdate({ tag: update.tag, bundlePath: path.resolve(process.execPath, '../../..') }); }
        catch (error) { update.busy = false; update.error = error.message; broadcast(); throw error; }
        savePreferences(); app.relaunch(); app.exit(0); break;
      }
      case 'open-download-page': shell.openExternal(`https://openalan.com/download/${HOST_LABEL === 'windows' ? 'windows' : 'mac'}`); break;
      case 'open-release-notes': shell.openExternal(`https://github.com/capthvnsen/alans-way/releases/tag/v${app.getVersion()}`); break;
      case 'dismiss-updated': update.justUpdatedFrom = ''; break;
      case 'onboarding-done': prefs.onboarded = true; savePreferences(); break;
      case 'onboarding-open': prefs.onboarded = false; prefs.remoteControl = false; activeTabId = 'home'; savePreferences(); applyLayout(); break;
      case 'move-to-applications': return app.moveToApplicationsFolder();
      case 'sync-telegram': telegramView.webContents.reload(); break;
      case 'open-username': {
        const username = String(value.username || '').replace(/^@/, '');
        if (!/^[A-Za-z][\w]{3,31}$/.test(username)) throw new Error('Enter a Telegram bot username.');
        const link = `tg://resolve?domain=${username}`;
        prefs.selectedBotId = '';
        await openTelegramHash(`?tgaddr=${encodeURIComponent(link)}`); break;
      }
      default: throw new Error('Unknown workspace command.');
    }
    broadcastNow(); return getState();
  });
  ipcMain.on('telegram:catalog', (event, value) => {
    if (event.sender !== telegramView?.webContents || event.senderFrame !== event.sender.mainFrame || !event.sender.getURL().startsWith(TELEGRAM)) return;
    if (!value || typeof value !== 'object') return;
    telegramStatus = ['connected', 'login', 'locked', 'loading', 'layout-changed'].includes(value.status) ? value.status : 'loading';
    if (['connected', 'login', 'locked'].includes(telegramStatus)) telegramRecovery?.reset();
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
      savePreferencesSoon();
    }
    activity.setContext({ accountId: prefs.accountId, bots: prefs.bots, connected: telegramStatus === 'connected' });
    broadcast();
  });
  ipcMain.on('telegram:activity', (event, packet) => {
    if (event.sender !== telegramView?.webContents || event.senderFrame !== event.sender.mainFrame || !event.sender.getURL().startsWith(TELEGRAM)) return;
    if (activity.ingest(packet)) broadcast();
  });
  // The preload pulls the work map after attaching its listener so a send that
  // raced a reload can never wedge the signature dedup.
  ipcMain.on('workspace:poll-tier-pull', (event) => {
    if (event.sender !== telegramView?.webContents || event.senderFrame !== event.sender.mainFrame) return;
    sendPollTier(true);
  });
  ipcMain.on('workspace:bot-activity-pull', (event) => {
    if (event.sender !== telegramView?.webContents || event.senderFrame !== event.sender.mainFrame) return;
    sendBotWork();
  });
  const linkOpenedAt = new Map();
  ipcMain.on('telegram:link', (event, value) => {
    if (event.sender !== telegramView?.webContents || event.senderFrame !== event.sender.mainFrame || !event.sender.getURL().startsWith(TELEGRAM)) return;
    if (prefs.autoOpenLinks === false) return;
    const chatId = String(value?.chatId || ''), url = String(value?.url || '').slice(0, 2048);
    if (!prefs.bots.some((bot) => bot.id === chatId) || !/^https?:\/\//i.test(url)) return;
    const now = Date.now();
    if (now - (linkOpenedAt.get(chatId) || 0) < 3000) return;
    linkOpenedAt.set(chatId, now);
    try {
      const normalized = agentPageUrl(url);
      const tab = createTab({ url: normalized, botId: chatId, controller: 'agent', activate: value.outgoing === true });
      recentLinkTabs.set(normalized, { tabId: tab.id, at: now });
      if (recentLinkTabs.size > 50) recentLinkTabs.clear();
    } catch {}
  });
}

const intParam = (url, key, min, max) => {
  const raw = url.searchParams.get(key);
  if (raw === null) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw Object.assign(new Error(`${key} must be an integer.`), { status: 400 });
  return Math.max(min, Math.min(max, value));
};
async function snapshot(tab, opts = {}) {
  const work = tab.queue.then(async () => {
    requireAgentRead(tab);
    const generation = ++tab.generation;
    let timer;
    // A wedged renderer leaves executeJavaScript pending forever; bound it so
    // a snapshot can never outlive the connector's own timeout.
    const result = await Promise.race([
      readJs(tab.view.webContents, snapshotExpression(generation, { parseWaitMs: SNAPSHOT_PARSE_MS, ...opts, keep: tab.snapshotStamp?.base, restamp: tab.snapshotStamp?.base }), 20000),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('Snapshot timed out after 10s. The page may be unresponsive.'), { status: 503 })), 10000); }),
    ]).finally(() => clearTimeout(timer));
    if (!result || !Array.isArray(result.elements)) throw Object.assign(new Error('Snapshot returned no page data.'), { status: 503 });
    // A takeover while the page was being read seals the response.
    requireAgentRead(tab);
    return { ...settleSnapshot(tab, result, generation, opts.since), tab: describeTab(tab, true) };
  });
  tab.queue = work.catch(() => {});
  return work;
}
async function navigateVps(id,url) {
  await remoteRequest(id,'control',{controller:'human'});
  await remoteRequest(id,'human-actions',{action:'navigate',url:normalizeUrl(url)});
}
async function handoffTab({id,destination,includeDrafts=false,note=''}) {
  const source=tabs.get(id) || vpsTabs.get(id); if(!source)throw new Error('Source tab not found.');
  const sourceHost=tabs.has(id)?'mac':'vps';
  // Local tabs describe themselves with HOST_LABEL (e.g. 'windows'); 'mac'
  // stays accepted as the compat wire name for the user's own computer.
  const dest=destination===HOST_LABEL?'mac':destination;
  if(!['mac','vps'].includes(dest)||dest===sourceHost)throw new Error('Choose the other computer.');
  if(sourceHost==='mac') { changeController(id,'human'); await source.queue; }
  else await remoteRequest(id,'control',{controller:'human'});
  const checkpoint=sourceHost==='mac'?await source.view.webContents.executeJavaScript(checkpointExpression(includeDrafts)):await remoteRequest(id,'checkpoint',{includeDrafts});
  if(!/^https?:\/\//.test(checkpoint.url))throw new Error('Open a web page before handing it off.');
  const handoff={id:crypto.randomUUID(),sourceHost,sourceTabId:id,destinationHost:dest,createdAt:Date.now(),note:String(note).slice(0,4000),phase:'review_required'};
  let target,result;
  if(dest==='vps') {
    target=await vpsBrowser.request('/v1/tabs','POST',{url:checkpoint.url},{botId:source.botId,human:true});vpsTabs.set(target.id,target);
    result=await remoteRequest(target.id,'restore',{checkpoint,handoff});target=result.tab;
  } else {
    target=createTab({url:checkpoint.url,botId:source.botId,controller:'human',activate:false});target.handoff=handoff;
    for(let n=0;n<100;n++){if(!target.view.webContents.isLoading()&&target.view.webContents.getURL()!=='about:blank')break;await new Promise(r=>setTimeout(r,100));}
    if(target.view.webContents.isLoading()){try{closeTab(target.id)}catch{}throw new Error(`${HOST_LABEL==='windows'?'PC':'Mac'} destination is still loading. Its tab was closed. Retry the handoff.`);}
    result=await target.view.webContents.executeJavaScript(restoreExpression(checkpoint));
  }
  const record={...handoff,destinationTabId:target.id,verification:result.verification,restoredDrafts:result.restored,skippedDrafts:result.skipped};
  if(dest==='mac')target.handoff=record;
  else {target.handoff=record;vpsTabs.set(target.id,target);}
  const retired={id:record.id,phase:'handed_off',sourceHost,destinationHost:dest,destinationTabId:target.id,createdAt:record.createdAt};
  if(sourceHost==='mac')source.handoff=retired;
  else record.sourceRetired=await remoteRequest(id,'control',{controller:'human',handoff:retired}).then(()=>true,()=>false);
  prefs.remoteControl=false; prefs.handoffs=[record,...prefs.handoffs].slice(0,20);activeTabId=dest==='vps'?'vps':target.id;
  if(dest==='vps')await remoteRequest(target.id,'activate',{});
  savePreferences();applyLayout();broadcast();return record;
}
// History navigation has no promise. Listeners go on before the trigger so a
// fast (cached or same-document) navigation cannot finish unobserved.
function settleNavigation(wc, trigger, timeout = 15000) {
  return new Promise((resolve) => {
    const events = ['did-stop-loading', 'did-navigate-in-page', 'destroyed'];
    const done = () => { clearTimeout(timer); for (const name of events) wc.off(name, done); resolve(); };
    const timer = setTimeout(done, timeout);
    for (const name of events) wc.on(name, done);
    try { trigger(); } catch { done(); }
  });
}
// Resolves { state, error }; error carries Chromium's net error name
// (ERR_NAME_NOT_RESOLVED and friends) when the load failed.
function waitForNavigationCommit(wc, load, timeout = 15000) {
  return new Promise((resolve) => {
    const done = (state, error = '') => {
      clearTimeout(timer);
      wc.removeListener('did-navigate', onNav).removeListener('did-fail-load', onFail).removeListener('destroyed', onDestroy);
      resolve({ state, error });
    };
    const onNav = () => done('committed');
    const onFail = (_e, _code, description, _u, main) => { if (main) done('failed', description); };
    const onDestroy = () => done('destroyed');
    const timer = setTimeout(() => done('timeout'), timeout);
    wc.once('did-navigate', onNav);
    wc.on('did-fail-load', onFail);
    wc.once('destroyed', onDestroy);
    Promise.resolve(load()).catch((error) => done('failed', /ERR_[A-Z0-9_]+/.exec(String(error?.message))?.[0] || ''));
  });
}
function browserCommand(tab, method, params) {
  const wc = tab.view.webContents;
  if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
  return wc.debugger.sendCommand(method, params);
}
async function captureTab(tab, { format = 'png', quality = 80, maxWidth = 0 } = {}) {
  const capture = backgroundCaptureQueue.then(async () => {
    const wc = tab.view.webContents;
    const viaDevTools = async (cdpFormat) => {
      // clip.scale downscales at capture instead of a full-size decode then resize.
      const size = await boundedJs(wc, '({ width: innerWidth, height: innerHeight, dsf: devicePixelRatio })');
      const scale = maxWidth && size.width * size.dsf > maxWidth ? Math.max(0.01, maxWidth / size.width) : size.dsf;
      const shot = await browserCommand(tab, 'Page.captureScreenshot', { format: cdpFormat, ...(cdpFormat === 'png' ? {} : { quality }), fromSurface: true, clip: { x: 0, y: 0, width: size.width, height: size.height, scale } });
      return shot.data;
    };
    const encode = async () => {
      // nativeImage has no webp encoder; the compositor does.
      if (format === 'webp') return viaDevTools('webp');
      // capturePage copies the last composited frame and fails (UnknownVizError)
      // when a just-opened surface has not produced one; DevTools renders one.
      let image = await wc.capturePage(undefined, { stayHidden: true }).catch(() => null);
      if (!image || image.isEmpty()) return viaDevTools(format);
      if (maxWidth && image.getSize().width > maxWidth) image = image.resize({ width: maxWidth });
      return (format === 'jpeg' ? image.toJPEG(quality) : image.toPNG()).toString('base64');
    };
    if (tab.host === win) return encode();
    // Hidden tabs share one host. Bring only this surface to its top while
    // capturing; never reparent it into the human's window or change selection.
    if (tab.host.contentView.children.at(-1) !== tab.view) tab.host.contentView.addChildView(tab.view);
    // Agent input keeps its own per-tab focus hold — don't steal or release it.
    const heldFocus = tab.focusEmulation === true;
    if (!heldFocus) await browserCommand(tab, 'Emulation.setFocusEmulationEnabled', { enabled: true });
    try {
      await boundedJs(wc, 'new Promise(resolve => { const timer = setTimeout(resolve, 250); requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve(); })); })');
      return await encode();
    }
    finally { if (!heldFocus && !wc.isDestroyed()) await browserCommand(tab, 'Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {}); }
  });
  backgroundCaptureQueue = capture.catch(() => {});
  return capture;
}
async function actionControls(tab, opts) {
  try {
    requireAgentRead(tab);
    const controls = await readControls((code) => readJs(tab.view.webContents, code, 12000), tab, opts);
    requireAgentRead(tab);
    return controls;
  } catch (error) {
    if (error && error.status === 409) throw error;
    return null;
  }
}
// A batch step answers with its own payload only: the page state, controls and
// tab record ride once on the batch reply instead of once per step.
async function performAction(tab, body, botId, depth = 0, isAborted = () => false) {
  const overseer = isOverseer(botId);
  requireActor(tab, botId, body.epoch, true, overseer);
  const wc = tab.view.webContents;
  const reply = (payload) => depth > 0 ? payload : actionReply(tab, payload);
  if (body.action === 'batch') {
    if (depth > 0) throw Object.assign(new Error('Batches cannot nest.'), { status: 400 });
    const steps = Array.isArray(body.steps) ? body.steps.slice(0, 25) : [];
    if (!steps.length) throw Object.assign(new Error('batch needs a non-empty steps array (max 25).'), { status: 400 });
    const results = [], started = Date.now();
    for (const step of steps) {
      if (!step || typeof step !== 'object') { results.push({ error: 'Invalid step.' }); break; }
      if (Date.now() - started > BATCH_BUDGET_MS) { results.push({ error: `batch stopped after ${BATCH_BUDGET_MS / 1000}s; remaining steps were not run. Snapshot, then continue.` }); break; }
      if (isAborted()) { results.push({ error: 'The request was closed; remaining steps were not run.' }); break; }
      try { results.push(await performAction(tab, { ...step, epoch: body.epoch }, botId, 1, isAborted)); }
      catch (error) { results.push({ error: error.message }); break; }
    }
    // A takeover mid-batch seals the accumulated step results too.
    requireActor(tab, botId, body.epoch, true, overseer);
    const controls = await actionControls(tab);
    return actionReply(tab, { results, ...(controls || {}), dispatched: true });
  }
  if (body.action === 'eval') {
    const code = String(body.code || '');
    if (!code || code.length > 16384) throw Object.assign(new Error('eval needs a code string (max 16KB).'), { status: 400 });
    const wc = tab.view.webContents;
    let evalTimer;
    let value = await Promise.race([
      frameOf(wc).executeJavaScript(code, true),
      new Promise((_, reject) => { evalTimer = setTimeout(() => reject(Object.assign(new Error('eval timed out after 15s.'), { status: 408 })), 15000); }),
    ]).finally(() => clearTimeout(evalTimer));
    // A takeover while the eval ran seals the result: the human's page state
    // is not returned to the bot.
    requireActor(tab, botId, body.epoch, true, overseer);
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    if (serialized && serialized.length > 48000) value = serialized.slice(0, 48000) + '…[truncated]';
    return reply({ value, dispatched: true });
  }
  if (body.action === 'wait') {
    const selector = String(body.selector || '').slice(0, 2000);
    const text = String(body.text || '').slice(0, 2000);
    const urlPart = String(body.url || '').slice(0, 2000);
    const visible = body.visible === true;
    const timeout = Math.min(Math.max(Number(body.timeout) || 10000, 100), 30000);
    if (!selector && !text && !urlPart) throw Object.assign(new Error('wait needs a selector, text, or url to wait for.'), { status: 400 });
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
      requireAgentRead(tab);
      // Short slices let a hung-up client stop a long wait instead of polling to its timeout.
      if (isAborted()) throw Object.assign(new Error('The request was closed before the wait finished.'), { status: 499 });
      const remaining = Math.max(400, timeout - (Date.now() - hostStart));
      const slice = Math.min(remaining, WAIT_SLICE_MS);
      const attempt = await Promise.race([
        frameOf(wc).executeJavaScript(waitCode(slice), true).catch(() => ({ navRetry: true })),
        new Promise((r) => setTimeout(() => r({ navRetry: true }), slice + 1500)),
      ]);
      const elapsed = Date.now() - hostStart;
      if (attempt && !attempt.navRetry && (attempt.found || elapsed >= timeout)) { value = { found: attempt.found, waited: elapsed }; break; }
      if (urlPart && wc.getURL().includes(urlPart)) { value = { found: true, waited: elapsed }; break; }
      if (!attempt || attempt.navRetry) await new Promise((r) => setTimeout(r, 250));
    }
    if (!value || !value.found) throw Object.assign(new Error(`wait timed out after ${value ? value.waited : Date.now() - hostStart}ms for ${[selector && `selector ${JSON.stringify(selector)}`, text && `text ${JSON.stringify(text.slice(0, 80))}`, urlPart && `url containing ${JSON.stringify(urlPart.slice(0, 80))}`].filter(Boolean).join(' and ')}. Snapshot the page to see its current state.`), { status: 408 });
    requireActor(tab, botId, body.epoch, true, overseer);
    return reply({ waited: value.waited, dispatched: true });
  }
  if (body.action === 'viewport') {
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
    if (body.clear === true) {
      await wc.debugger.sendCommand('Emulation.clearDeviceMetricsOverride');
      delete tab.viewport;
      return reply({ viewport: null, dispatched: true });
    }
    const width = Math.round(Number(body.width)), height = Math.round(Number(body.height));
    const scale = Math.min(Math.max(Number(body.scale) || 1, 0.1), 5);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 100 || width > 7680 || height < 100 || height > 4320)
      throw Object.assign(new Error('viewport needs width 100-7680 and height 100-4320, or clear:true.'), { status: 400 });
    await wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
    tab.viewport = { width, height, scale };
    broadcast();
    return reply({ viewport: tab.viewport, dispatched: true });
  }
  if (body.action === 'cdp') {
    const method = String(body.method || '');
    const methodError = cdpMethodError(method);
    if (methodError) throw Object.assign(new Error(methodError), { status: 400 });
    const params = { ...(body.params && typeof body.params === 'object' ? body.params : {}) };
    if (JSON.stringify(params).length > 64000) throw Object.assign(new Error('cdp params too large (max 64KB).'), { status: 400 });
    // Page.navigate bypasses will-navigate: route it through the same agent
    // address validation as the navigate action (no file:, no local hosts).
    if (method === 'Page.navigate') {
      if (typeof params.url !== 'string' || !params.url) throw Object.assign(new Error('Page.navigate needs a url string.'), { status: 400 });
      params.url = agentPageUrl(params.url);
    }
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
    let cdpTimer;
    let value = await Promise.race([
      wc.debugger.sendCommand(method, params),
      new Promise((_, reject) => { cdpTimer = setTimeout(() => reject(Object.assign(new Error('cdp timed out after 20s.'), { status: 408 })), 20000); }),
    ]).finally(() => clearTimeout(cdpTimer));
    // Seal mid-flight takeovers: the result is the human's page state then.
    requireActor(tab, botId, body.epoch, true, overseer);
    const cdpSerialized = typeof value === 'string' ? value : JSON.stringify(value);
    if (cdpSerialized && cdpSerialized.length > 48000) value = cdpSerialized.slice(0, 48000) + '…[truncated]';
    return reply({ value, dispatched: true });
  }
  if (INPUT_ACTIONS.has(body.action)) {
    const { input, cursor, ...result } = await agentInput.perform(tab, body, botId);
    if (depth === 0 && body.action !== 'move') tab.refs.clear();
    broadcast();
    const controls = depth === 0 && body.action !== 'move' ? await actionControls(tab) : null;
    return reply({ ...result, ...(depth === 0 && cursor ? { cursor: { x: cursor.x, y: cursor.y } } : {}), ...(controls || {}), dispatched: true });
  }
  let parseWaitMs = 0;
  if (body.action === 'navigate') {
    await agentInput.clear(tab);
    requireActor(tab, botId, body.epoch, true, overseer);
    const target = pageUrl(agentPageUrl(body.url));
    const commit = await waitForNavigationCommit(wc, () => wc.loadURL(target));
    if (commit.state === 'failed' || commit.state === 'destroyed') throw Object.assign(new Error(commit.error ? `Navigation failed: ${commit.error}.` : 'Navigation failed.'), { status: 400 });
    tab.refs.clear();
    if (commit.state === 'timeout') { requireActor(tab, botId, body.epoch, true, overseer); broadcast(); return reply({ loading: true, dispatched: true }); }
    // Controls are ready once the document has parsed; the rest of the page
    // keeps loading and `loading` says so.
    parseWaitMs = NAVIGATE_PARSE_MS;
  } else if (['back', 'forward', 'reload'].includes(body.action)) {
    await agentInput.clear(tab);
    requireActor(tab, botId, body.epoch, true, overseer);
    const history = wc.navigationHistory;
    const go = body.action === 'back' ? history.canGoBack() && (() => history.goBack())
      : body.action === 'forward' ? history.canGoForward() && (() => history.goForward())
      : () => wc.reload();
    if (go) await settleNavigation(wc, go);
    // History entries predate the address check, so a back/forward/reload can
    // land on one. will-navigate covers the cases Electron emits it for.
    if (tab.controller === 'agent') {
      try { agentPageUrl(wc.getURL()); }
      catch (error) {
        await wc.loadURL('about:blank').catch(() => {});
        throw Object.assign(error, { status: 400 });
      }
    }
  } else throw Object.assign(new Error('Supported actions: navigate, click, double_click, right_click, drag, select, type, press, move, scroll, back, forward, reload, batch, eval, wait, viewport, cdp.'), { status: 400 });
  // Seal navigation-family results too: a takeover while the page settled
  // makes this response the human's page state.
  requireActor(tab, botId, body.epoch, true, overseer);
  tab.refs.clear(); broadcast();
  if (depth > 0) {
    if (parseWaitMs) await boundedJs(wc, `document.readyState === 'loading' ? new Promise(done => { document.addEventListener('DOMContentLoaded', done, { once: true }); setTimeout(done, ${parseWaitMs}); }) : 0`, parseWaitMs + 2000).catch(() => {});
    return reply({ dispatched: true });
  }
  const controls = await actionControls(tab, parseWaitMs ? { parseWaitMs } : undefined);
  return reply({ ...(controls || {}), dispatched: true });
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
    if (req.headers.origin || !hostAllowed(req.headers.host, apiPort) || !isAuthorized(req.headers.authorization, API_TOKEN)) return send(401, { error: 'Unauthorized' });
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const botId = String(req.headers['x-hermes-bot'] || '');
      const overseer = isOverseer(botId);
      if (req.method === 'GET' && url.pathname === '/v1/status') return send(200, { name: app.getName(), version: app.getVersion(), protocol: 1, build: BUILD, host: HOST_LABEL, hosts:{[HOST_LABEL]:'connected',vps:vpsBrowserStatus}, capabilities: [...(hostComputer ? ['computer', 'computer-v2'] : []), 'tabs', 'snapshot', 'screenshot', 'navigate', 'click', 'double_click', 'right_click', 'drag', 'select', 'type', 'press', 'move', 'scroll', 'batch', 'eval', 'wait', 'viewport', 'cdp', 'agent-cursor', 'background-input', 'control-epochs'], tabCount: tabs.size+vpsTabs.size });
      if (req.method === 'GET' && url.pathname === '/v1/diagnostics') {
        const appearance = await Promise.race([
          telegramView.webContents.executeJavaScript(`(() => ({
          styled: document.body.classList.contains('hw-chat'),
          composerCount: document.querySelectorAll('.Composer').length,
          middleClasses: document.querySelector('#MiddleColumn')?.className || '',
          middleChildren: [...(document.querySelector('#MiddleColumn')?.children || [])].map(el => ({ tag: el.tagName, id: el.id, className: String(el.className), background: getComputedStyle(el).backgroundImage, display: getComputedStyle(el).display })),
        }))()`).catch(() => ({})),
          new Promise(resolve => setTimeout(() => resolve({}), 3000)),
        ]);
        const activityStates = prefs.bots.map(bot => activity.get(bot.id).state);
        return send(200, { telegram: { status: telegramStatus, ...telegramDiagnostics, appearance,
          activity: { available: activityStates.some(state => state !== 'unknown'), activeBots: activityStates.filter(state => state === 'active').length } }, remote: remoteStatus,
          window: { visible: win.isVisible(), focused: win.isFocused() } });
      }
      if (url.pathname === '/v1/tabs' && req.method === 'GET') {
        if (!botId || botId.length > 100) throw Object.assign(new Error('X-Hermes-Bot is required.'), { status: 400 });
        // The 5s timer already keeps vpsTabs warm; a blocking SSH refresh here
        // cost seconds on a read-only list call. Serve the cache, refresh async.
        if(prefs.vpsBrowser?.sshHost)refreshVpsTabs();
        return send(200, { tabs: [...tabs.values()].filter(tab => !tab.extensionPage).map(tab => describeTab(tab, true)).concat([...vpsTabs.values()]).filter((tab) => overseer || tab.botId === botId || (tab.allowedBots ?? []).includes(botId)) });
      }
      if (url.pathname === '/v1/tabs' && req.method === 'POST') {
        if (!botId || botId.length > 100) throw Object.assign(new Error('X-Hermes-Bot is required.'), { status: 400 });
        const body = await readJson(req);
        if(body.host==='vps'||body.host==='remote'){const forward={...body};delete forward.host;const result=await vpsBrowser.request('/v1/tabs','POST',forward,{botId,botName:nameForBot(botId)});vpsTabs.set(result.id,result);broadcast();return send(201,result);}
        if(!isLocalHost(body.host))throw new Error(`Choose ${HOST_LABEL} or vps explicitly.`);
        { const targetUrl = pageUrl(agentPageUrl(body.url));
          const created = createTab({ url: targetUrl, botId, controller: 'agent', activate: body.background === false }); created.agentSince = Date.now();
          // Answer after commit (not full load): the first snapshot or eval then
          // sees the real document instead of racing about:blank. Cap the wait
          // so a slow site still returns promptly — `loading` reports the rest.
          if (/^https?:\/\//i.test(targetUrl)) {
            const wc = created.view.webContents;
            await new Promise(resolve => {
              const done = () => { clearTimeout(timer); wc.removeListener('did-navigate', done).removeListener('did-fail-load', failed).removeListener('destroyed', done); resolve(); };
              const failed = (_e, _c, _d, _u, main) => { if (main) done(); };
              const timer = setTimeout(done, 1500);
              wc.once('did-navigate', done); wc.on('did-fail-load', failed); wc.once('destroyed', done);
            });
          }
          return send(201, describeTab(created, true)); }
      }
      // Host computer use is served here so an SSH-spawned connector never
      // drives the desktop itself — on Windows that process would sit in
      // Session 0 and see no windows. Same verbs the MCP connector wraps.
      const computerMatch = /^\/v1\/computer\/(apps|\d{1,10})(?:\/(snapshot|screenshot|action|menu))?$/.exec(url.pathname);
      if (computerMatch) {
        if (!hostComputer) return send(400, { error: 'Computer use is not available on this host.' });
        if (computerMatch[1] === 'apps') {
          if (computerMatch[2] || req.method !== 'GET') return send(405, { error: 'Use GET /v1/computer/apps.' });
          return send(200, { apps: await hostComputer.apps() });
        }
        const pid = Number(computerMatch[1]);
        if (!Number.isInteger(pid) || pid < 0) return send(400, { error: 'App pid must be a non-negative integer.' });
        if (req.method === 'GET' && computerMatch[2] === 'snapshot')
          return send(200, await hostComputer.snapshot(botId, pid, { since: intParam(url, 'since', 0, Number.MAX_SAFE_INTEGER), menubar: url.searchParams.get('menubar') === '1' }));
        if (req.method === 'GET' && computerMatch[2] === 'screenshot')
          return send(200, await hostComputer.screenshot(pid, intParam(url, 'maxWidth', 1, 10000)));
        if (req.method === 'GET' && computerMatch[2] === 'menu') {
          let menuPath; try { menuPath = JSON.parse(url.searchParams.get('path') || '[]'); } catch { throw Object.assign(new Error('path must be a JSON array of menu titles.'), { status: 400 }); }
          return send(200, await hostComputer.menu(pid, menuPath));
        }
        if (req.method === 'POST' && computerMatch[2] === 'action')
          return send(200, await hostComputer.action(botId, pid, await readJson(req)));
        return send(405, { error: 'Method not supported.' });
      }
      const match = /^\/v1\/tabs\/([\w-]+)(?:\/(snapshot|screenshot|actions|control))?$/.exec(url.pathname);
      const tab = match && tabs.get(match[1]);
      if(match&&!tab&&isVpsTab(match[1])){
        const result=await vpsBrowser.request(url.pathname+url.search,req.method,req.method==='POST'?await readJson(req):undefined,{botId,botName:nameForBot(botId),epoch:Number(req.headers['x-control-epoch'])});
        const remote=result.tab || (result.id?result:null);if(remote)vpsTabs.set(remote.id,remote);if(req.method==='DELETE')vpsTabs.delete(match[1]);broadcast();return send(200,result);
      }
      if (!tab || tab.extensionPage) return send(404, { error: 'Tab not found.' });
      // Shared tabs are claimable by any known bot via POST control; the
      // per-endpoint gates still fence reads/actions until it is claimed.
      requireActor(tab, botId, undefined, false, overseer || (tab.botId === 'shared' && prefs.bots.some((bot) => bot.id === botId)));
      if (req.method === 'GET' && !match[2]) return send(200, describeTab(tab, true));
      tab.lastAgentActivity = Date.now();
      // A bounded backlog of pending reads per tab: a bot cannot stack up
      // snapshots or screenshots that would drain after a human takeover.
      if (req.method === 'GET' && (match[2] === 'snapshot' || match[2] === 'screenshot')) {
        requireAgentRead(tab);
        if ((tab.pendingReads || 0) >= 8) throw Object.assign(new Error('Too many pending reads on this tab.'), { status: 429 });
        tab.pendingReads = (tab.pendingReads || 0) + 1;
      }
      try {
      if (req.method === 'GET' && match[2] === 'snapshot') {
        return send(200, await snapshot(tab, { maxChars: intParam(url, 'maxChars', 0, 20000), maxElements: intParam(url, 'maxElements', 0, 300), since: intParam(url, 'since', 0, Number.MAX_SAFE_INTEGER) }));
      }
      if (req.method === 'GET' && match[2] === 'screenshot') {
        const format = url.searchParams.get('format') ?? 'jpeg';
        if (!['jpeg', 'png', 'webp'].includes(format)) throw Object.assign(new Error('format must be jpeg, png, or webp.'), { status: 400 });
        const quality = intParam(url, 'quality', 1, 100) ?? 50;
        const maxWidth = intParam(url, 'maxWidth', 1, 10000) ?? 960;
        const capture = tab.queue.then(async () => {
          // Reads are gated again inside the queue so a takeover while this
          // capture waited comes back 409, not a last page peek.
          requireAgentRead(tab);
          const base64 = await captureTab(tab, { format, quality, maxWidth });
          const viewport = await boundedJs(tab.view.webContents, '({ width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio })');
          requireAgentRead(tab);
          return { base64, viewport };
        });
        tab.queue = capture.catch(() => {});
        const { base64, viewport } = await capture;
        return send(200, { mimeType: { jpeg: 'image/jpeg', webp: 'image/webp', png: 'image/png' }[format], base64, viewport, tab: describeTab(tab, true) });
      }
      } finally { if (req.method === 'GET' && (match[2] === 'snapshot' || match[2] === 'screenshot')) tab.pendingReads--; }
      if (req.method === 'POST' && match[2] === 'actions') {
        const body = await readJson(req);
        tab.pendingActions = (tab.pendingActions || 0) + 1;
        // A client that gave up (its connector timed out) must not have its
        // queued action run later against whatever the page became.
        let closed = false;
        res.on('close', () => { if (!res.writableFinished) closed = true; });
        const action = tab.queue.then(() => {
          if (closed) throw Object.assign(new Error('The request was closed before this action started.'), { status: 499 });
          return performAction(tab, body, botId, 0, () => closed);
        })
          .finally(() => { tab.pendingActions--; tab.lastAgentActivity = Date.now(); });
        tab.queue = action.catch(() => {});
        return send(200, await action);
      }
      if (req.method === 'POST' && match[2] === 'control') {
        const body = await readJson(req);
        const granted = (tab.allowedBots || []).includes(botId)
          || (tab.botId === 'shared' && prefs.bots.some((bot) => bot.id === botId));
        if (botId !== tab.botId && !overseer && !granted) throw Object.assign(new Error('Only the owning bot can change control.'), { status: 403 });
        if (body.controller === 'agent') { requireAgentClaim(tab); tab.handoff = reviewedHandoff(tab.handoff); }
        if (tab.botId === 'shared' && body.controller === 'agent') tab.botId = botId;
        return send(200, redactTabForBot(changeController(tab.id, body.controller, 'agent')));
      }
      if (req.method === 'DELETE' && !match[2]) { requireActor(tab, botId, Number(req.headers['x-control-epoch']), true, overseer); closeTab(tab.id); return send(200, { closed: true }); }
      return send(405, { error: 'Method not supported.' });
    } catch (error) { send(error.status || (error.code === 'stale_ref' ? 409 : 400), { error: error.message, ...(error.code ? { code: error.code } : {}) }); }
  });
  apiServer.requestTimeout = 30000;
  apiServer.on('listening', () => {
    apiPort = apiServer.address().port;
    apiError = '';
    try { writePrivateJson(path.join(app.getPath('userData'), 'connection.json'), { url: `http://127.0.0.1:${apiPort}`, token: API_TOKEN, protocol: 1 }); }
    catch (error) { apiError = `Could not write the connection file: ${error.message}`; logError('connection.json', error); }
    broadcast();
  });
  apiServer.on('error', (error) => {
    // A taken port would leave the old connection.json pointing at a dead or
    // foreign listener. Come up on an ephemeral port and write the real one.
    if (error.code === 'EADDRINUSE' && !apiPort) { apiServer.listen(0, '127.0.0.1'); return; }
    apiError = error.message; broadcast();
  });
  const envPort = Number(process.env.HERMES_WORKSPACE_PORT);
  apiServer.listen(Number.isInteger(envPort) && envPort >= 0 && envPort < 65536 ? envPort : 9464, '127.0.0.1');
}
// The two bridge-bearing pages never navigate or open windows: a dropped HTML
// file or injected link would otherwise inherit the preload bridge.
function lockDown(contents, expectedFile) {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event, url) => { if (!fileUrlMatches(url, expectedFile)) event.preventDefault(); });
  contents.on('will-redirect', (event) => event.preventDefault());
  contents.on('will-attach-webview', (event) => event.preventDefault());
}
// Telegram's page cannot tell a tray-hidden window from a visible one, so the
// main process tells it how hard to poll. While hidden, main drives the poll
// itself: a hidden page's own timers are throttled to about once a minute.
let hiddenPoll, lastPollTier = '';
// webContents.send logs instead of throwing when the frame is gone, so the
// frame is probed first; reading any property of a disposed frame throws.
function sendToTelegram(channel, ...args) {
  try {
    const wc = telegramView.webContents;
    if (wc.isDestroyed() || wc.isCrashed()) return;
    void wc.mainFrame.url;
    wc.send(channel, ...args);
  } catch { /* the frame was disposed */ }
}
function sendPollTier(force = false) {
  if (!win || win.isDestroyed() || !telegramView || telegramView.webContents.isDestroyed()) return;
  const tier = pollTier({ visible: win.isVisible(), minimized: win.isMinimized(), focused: win.isFocused() });
  if (tier === lastPollTier && !force) return;
  lastPollTier = tier;
  sendToTelegram('workspace:poll-tier', tier);
  clearInterval(hiddenPoll);
  if (tier === 'hidden') {
    hiddenPoll = setInterval(() => { if (telegramView && !telegramView.webContents.isDestroyed()) sendToTelegram('telegram:poll'); }, 15000);
    hiddenPoll.unref();
  }
}
function showWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
}
// Windows and Linux hide to the tray on close, as macOS hides to the dock, so
// bots keep their browser. Without a visible tray the window could never come
// back, so closing only hides once a tray exists.
function statusNotifierHost() {
  try {
    return /boolean true/.test(execFileSync('dbus-send', ['--session', '--dest=org.freedesktop.DBus', '--type=method_call', '--print-reply', '/org/freedesktop/DBus', 'org.freedesktop.DBus.NameHasOwner', 'string:org.kde.StatusNotifierWatcher'], { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch { return false; }
}
function createTray() {
  if (process.platform === 'darwin' || tray) return;
  if (process.platform === 'linux' && !linuxTrayUsable({ desktop: process.env.XDG_CURRENT_DESKTOP || '', hasWatcher: statusNotifierHost() })) return;
  try {
    const icon = process.platform === 'win32' ? path.join(ROOT, '../assets/icon.ico')
      : nativeImage.createFromPath(path.join(ROOT, '../assets/icon.png')).resize({ width: 24, height: 24 });
    tray = new Tray(icon);
    tray.setToolTip(`${app.getName()} is running. Bots keep their browser while this icon is here.`);
    tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Show Alan’s Way', click: showWindow }, { type: 'separator' }, { label: 'Quit', click: () => app.quit() }]));
    tray.on('click', showWindow);
  } catch (error) { tray = undefined; logError('tray', error); }
}
// Telegram's page can crash, fail to load, hang, or sit offline across a
// sleep. Without this the sidebar stays on "offline" until the user restarts.
function watchTelegram(wc) {
  const target = () => prefs.selectedBotId ? `${TELEGRAM}#${prefs.selectedBotId}` : TELEGRAM;
  telegramRecovery = createRetry({ run: () => { if (!isQuitting && !wc.isDestroyed()) wc.loadURL(target()).catch(() => {}); } });
  const offline = () => { telegramStatus = 'offline'; activity.clear(); broadcast(); };
  let hangTimer, lastInput = 0;
  wc.on('before-input-event', () => { lastInput = Date.now(); });
  wc.on('did-start-loading', () => { lastBotWorkSignature = ''; activity.clear(); broadcast(); });
  wc.on('render-process-gone', (_event, details) => { offline(); if (details.reason !== 'clean-exit') telegramRecovery.schedule(); });
  wc.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => { if (isMainFrame && code !== -3) { offline(); telegramRecovery.schedule(); } });
  // Killing a page that is merely busy loses what the user is typing, so wait
  // a minute and never while they are actively using this window.
  const watchHang = () => {
    hangTimer = setTimeout(() => {
      if (wc.isDestroyed()) return;
      if (win?.isFocused() && Date.now() - lastInput < 30000) return watchHang();
      wc.forcefullyCrashRenderer();
    }, 60000);
    hangTimer.unref?.();
  };
  wc.on('unresponsive', () => { clearTimeout(hangTimer); watchHang(); });
  wc.on('responsive', () => clearTimeout(hangTimer));
  const stuck = () => telegramStatus === 'offline' || telegramStatus === 'loading';
  powerMonitor.on('resume', () => { const timer = setTimeout(() => { if (stuck()) telegramRecovery.now(); }, 3000); timer.unref?.(); });
  let wasOnline = net.isOnline();
  const timer = setInterval(() => {
    const online = net.isOnline();
    if (online && !wasOnline && telegramStatus === 'offline') telegramRecovery.now();
    wasOnline = online;
  }, 3000);
  timer.unref();
}
function createWindow() {
  nativeTheme.themeSource = 'dark';
  win = new BrowserWindow({ width: 1550, height: 980, minWidth: 1120, minHeight: 680, backgroundColor: '#09090a', title: app.getName(),
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 18 } }
      : { titleBarStyle: 'hidden', titleBarOverlay: { color: '#111112', symbolColor: '#e7e7eb', height: 40 } }),
    webPreferences: { preload: path.join(ROOT, 'preload.bundle.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  lockDown(win.webContents, INDEX_FILE);
  telegramView = new WebContentsView({ webPreferences: { preload: path.join(ROOT, 'telegram-preload.bundle.cjs'), partition: 'persist:telegram', contextIsolation: true, nodeIntegration: false, sandbox: true } });
  telegramView.setBackgroundColor('#09090a');
  configureContents(telegramView.webContents, true);
  watchTelegram(telegramView.webContents);
  win.contentView.addChildView(telegramView);
  remoteView = new WebContentsView({ webPreferences: { preload: path.join(ROOT, 'preload.bundle.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  remoteView.setBackgroundColor('#101011');
  lockDown(remoteView.webContents, REMOTE_FILE);
  remoteView.webContents.on('before-input-event',(event,input)=>{
    const hostModifier = process.platform === 'darwin' ? input.meta : input.control;
    if(prefs.remoteControl && remoteStatus==='connected' && hostModifier && input.type==='keyDown' && /^[altrwf]$/i.test(input.key)){
      event.preventDefault();remoteView.webContents.send('workspace:remote-shortcut',{key:input.key.toLowerCase(),shift:input.shift});
    }
  });
  win.contentView.addChildView(remoteView);
  registerIpc();
  win.loadFile(path.join(ROOT, 'index.html'));
  remoteView.webContents.loadFile(path.join(ROOT, 'remote.html'));
  telegramView.webContents.loadURL(prefs.selectedBotId ? `${TELEGRAM}#${prefs.selectedBotId}` : TELEGRAM).catch(() => {});
  for (const item of prefs.savedTabs.slice(0, 12)) {
    try {
      if (/^file:\/\//i.test(String(item.url))) createTab({ filePath: fileURLToPath(item.url), botId: item.botId, activate: false });
      else createTab({ url: item.url, botId: item.botId, activate: false });
    } catch {}
  }
  activeTabId = 'home';
  win.on('enter-full-screen', broadcast); win.on('leave-full-screen', broadcast);
  createTray();
  win.on('session-end', () => { isQuitting = true; prefsSaver.flush(); });
  win.on('close', (event) => {
    if (isQuitting) return;
    if (process.platform === 'darwin' || tray) { event.preventDefault(); win.hide(); }
    else if (process.platform === 'linux') { event.preventDefault(); win.minimize(); }
  });
  for (const name of ['show', 'hide', 'minimize', 'restore', 'focus', 'blur']) win.on(name, () => sendPollTier());
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ label: app.getName(), submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] }] : []),
    { label: 'File', submenu: [{ label: 'New Browser Tab', accelerator: 'CmdOrCtrl+T', click: () => createTab({}) }, { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => extensionPopup?.browserWindow?.isFocused() ? extensionPopup.destroy() : closeTab(activeTabId) }, ...(process.platform === 'darwin' ? [] : [{ type: 'separator' }, { role: 'quit' }])] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ label: 'Reload Page', accelerator: 'CmdOrCtrl+R', click: () => tabs.get(activeTabId)?.view.webContents.reload() }, { role: 'togglefullscreen' }, ...(app.isPackaged ? [] : [{ label: 'App Developer Tools', accelerator: 'Alt+CmdOrCtrl+I', click: () => win.webContents.toggleDevTools() }])] },
    ...(process.platform === 'darwin' ? [{ label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'front' }] }] : []),
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
  activityTimer = setInterval(() => { if (activity.expire() || JSON.stringify(computeBotWork()) !== lastBotWorkSignature) broadcast(); }, 500);
  activityTimer.unref();
  idleTimer = setInterval(() => {
    const idleMs = Math.max(1, Number(process.env.HERMES_AGENT_IDLE_MINUTES) || prefs.agentIdleMinutes || 15) * 60000, now = Date.now();
    for (const tab of tabs.values()) {
      if (tab.controller !== 'agent' || tab.extensionPage || tab.pendingActions > 0 || agentInput.isDispatching(tab)) continue;
      if (now - Math.max(tab.agentSince || 0, tab.lastAgentActivity || 0) > idleMs) changeController(tab.id, 'human', 'idle');
    }
  }, 30000).unref();
  const vpsTick = async () => { await refreshVpsTabs(); vpsTimer = setTimeout(vpsTick, backoffDelay(vpsFailures)); vpsTimer.unref(); };
  vpsTick();
  vpsMirrorTimer = setInterval(pushVpsMirror, 10000); vpsMirrorTimer.unref();
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.whenReady().then(async () => {
    prefs = readPreferences(); prefs.remoteControl = false; pinOnboarding(prefs);
    session.defaultSession.protocol.handle(AVATAR_SCHEME, (request) => {
      const image = avatarStore.imageFor(request.url);
      return image ? new Response(image.data, { headers: { 'Content-Type': image.mime, 'Cache-Control': 'private, max-age=3600' } }) : new Response('', { status: 404 });
    });
    try { parseRemoteUrl(prefs.remoteUrl); } catch { prefs.remoteUrl = ''; }
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    const browserSession = session.fromPartition('persist:browser');
    // Subresources (fetch, XHR, images) never hit will-navigate. Cancel the
    // ones an agent tab aims at a blocked address; the human's tabs are not
    // touched, and main-frame loads stay with the navigation hooks above.
    browserSession.webRequest.onBeforeRequest((details, callback) => {
      let cancel = false;
      try {
        const frame = details.webContentsId && webContents.fromId(details.webContentsId);
        const owner = frame && [...tabs.values()].find((tab) => tab.view.webContents === frame);
        if (owner?.controller === 'agent' && details.resourceType !== 'mainFrame') {
          const parsed = new URL(details.url);
          const barrier = (parsed.protocol === 'http:' || parsed.protocol === 'https:') && agentHostBarrier(parsed.hostname);
          cancel = Boolean(barrier) && !(barrier === 'loopback' && process.env.HERMES_WORKSPACE_ALLOW_LOOPBACK === '1');
        }
      } catch {}
      callback(cancel ? { cancel: true } : {});
    });
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
    startUpdates();
  });
  app.on('second-instance', showWindow);
  app.on('activate', showWindow);
  app.on('before-quit', () => { isQuitting = true; hostComputer?.close(); clearInterval(pointerTimer); clearInterval(activityTimer); clearInterval(idleTimer); clearTimeout(vpsTimer); clearInterval(vpsMirrorTimer); clearTimeout(vpsMirrorDebounce); prefsSaver.flush(); tray?.destroy(); apiServer?.close(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
