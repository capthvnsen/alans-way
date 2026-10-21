const { app, BrowserWindow, WebContentsView, webContents, ipcMain, Menu, Tray, Notification, dialog, clipboard, shell, nativeTheme, screen, nativeImage, session, powerMonitor, net, protocol, systemPreferences, safeStorage } = require('electron');
const { ACCELERATORS } = require('./workspace-shortcuts.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { normalizeUrl, agentPageUrl, agentHostBarrier, faviconTarget, faviconQueue, redactTabForBot, cdpMethodError, parseRemoteUrl, isSshTarget, normalizeHost, requireActor: requireActorCore, requireAgentRead, requireAgentClaim, takeoverDelay, reviewedHandoff, isAuthorized, sanitizeBots, errorMessage, followVmRemoteUrl, handbackRequest, liveHandback, nextHandback, dialogAnswer, answerDialog, challengeReply, captchaHandback, captchaWatchStep, cdpChallengeSafe } = require('./core.cjs');
const { createAvatarStore, AVATAR_SCHEME } = require('./avatar-store.cjs');
const { writePrivateJson, normalizePreferences, coalesce, createSaver, createRetry, hostAllowed, fileUrlMatches, linuxTrayUsable, pollTier, watchChange, tailscaleSshHost } = require('./shell-support.cjs');
const { buildAgentPrompt } = require('./agent-prompt.cjs');
const { shouldOnboard, pinOnboarding, cloudStep, nextCloudStep, setCloudStep } = require('./onboarding.cjs');
const cloudClaim = require('./cloud-claim.cjs');
const cloudStatus = require('./cloud-status.cjs');
const cloudConnect = require('./cloud-connect.cjs');
const cloudMigrate = require('./cloud-migrate.cjs');
const cloudModel = require('./cloud-model.cjs');
const { posixCommand } = require('./remote-shell.cjs');
const cloudTelegram = require('./cloud-telegram.cjs');
const { openUsernameScript } = require('./telegram-open.cjs');
const macUpdate = require('./mac-update.cjs');
const setupCheck = require('./setup-check.cjs');
const { createLog } = require('./main-log.cjs');
const { armQuitWatchdog } = require('./update-quit.cjs');
const { githubFeed } = require('./win-update.cjs');
const { PUBLISH } = require('../electron-builder.cjs');
const { createVmUpdater, vmTargets, snoozeUntil, vmRetryState, vmCheckEntry, pruneVmUpdates, shouldShowUpdatePopup, hermesUpdateDetail, updateLocked, LOCAL_TARGET } = require('./vm-update.cjs');
const { latestPluginTag, latestHostRelease, stableHostTarget, versionRecord, describeVersions, runSteps, summarizeRun, reportText, reportDeliveryText, deliverPendingUpdateReport, restartWarning, pluginStepResult, runLogText } = require('./update-all.cjs');
const { describeBuild, readBuildInfo } = require('./build-channel.cjs');
const { createAgentInput, PREFLIGHT_READY, APPROVED, refuseChallenge, tintScript, botAccent, boundedJs, readJs, frameOf, INPUT_ACTIONS } = require('./agent-input.cjs');
const { createHermesHub } = require('./hermes-hub.cjs');
const { createActivityTracker } = require('./activity.cjs');
const { createSitePermissions } = require('./site-permissions.cjs');
const { snapshotExpression, settleSnapshot, readEffect, passCloudflare, challengeProbeExpression, checkpointExpression, restoreExpression, followUpInstallExpression, lastReadOf } = require('./browser-page.cjs');
const { createVpsBrowser, backoffDelay, toCdpCookie, createMirrorPusher, prepareMirrorTabs, settleWithin, checkScriptPath } = require('./vps-browser.cjs');
const { createExtensionStore } = require('./extension-store.cjs');
const { createDownloadStore } = require('./download-store.cjs');
const { pdfFile } = require('./local-pdf.cjs');
const recorder = require('./recorder.cjs');
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

app.enableSandbox();
protocol.registerSchemesAsPrivileged([{ scheme: AVATAR_SCHEME, privileges: { secure: true, supportFetchAPI: true } }]);
app.setName("alans-way-localapp");
if (process.platform === 'win32') app.setAppUserModelId('app.alans-way.localapp');
// The paid-computer link arrives as alansway://claim?token=… — on macOS via
// open-url possibly before the window exists, on Windows in the launch or
// second-instance argv. Either way the token waits in a queue until the
// window can act on it, and only the newest is kept.
app.setAsDefaultProtocolClient('alansway');
const claimTokens = cloudClaim.createTokenQueue();
app.on('open-url', (event, url) => { event.preventDefault(); claimTokens.push(cloudClaim.parseClaimUrl(url)); });
const pendingPdfs = [];
let pdfWindowReady = false;
function receivePdf(file) {
  const valid = pdfFile(file);
  if (!valid) return;
  if (!pdfWindowReady) { if (pendingPdfs.length < 40) pendingPdfs.push(valid); return; }
  try { createTab({ filePath: valid }); showWindow(); } catch (error) { logError('open-pdf', error); }
}
app.on('open-file', (event, file) => { event.preventDefault(); receivePdf(file); });
async function pickPdf() {
  const result = await dialog.showOpenDialog(win, { title: 'Open PDF', properties: ['openFile', 'multiSelections'], filters: [{ name: 'PDF documents', extensions: ['pdf'] }] });
  if (!result.canceled) for (const file of result.filePaths) receivePdf(file);
}
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
  try { console.error(`${label}: ${error?.stack || error}`); } catch {}
  mainLog().write(label, String(error?.stack || error));
}
let mainLogger;
const mainLog = () => mainLogger ||= createLog(path.join(app.getPath('userData'), 'logs'));
process.on('uncaughtException', (error) => logError('uncaughtException', error));
process.on('unhandledRejection', (reason) => logError('unhandledRejection', reason));
const TELEGRAM = 'https://web.telegram.org/a/';
let win, backgroundWindow, telegramView, remoteView, apiServer, prefs, layout = {}, apiPort = 0, tray, telegramRecovery;
let obscuredFocus = null;
let extensionStore, extensionHost, extensionPopup, extensionPopupTabId, extensionActiveContentsId;
let registeringExtensionTab = false;
const update = { available: '', tag: '', ready: false, busy: false, error: '', justUpdatedFrom: '' };
const serverSetup = require('./server-setup.cjs').createServerSetup();
const vmUpdater = createVmUpdater({ log: (label, error) => logError(label, error) });
// Per-VM progress while an update or retry runs; prefs.vmUpdates holds the
// persistent record (known VM version / last failure) the retry banner reads.
const vmProgress = {};
let vmRetrying = false;
let hermesUpdating = false;
// "Update everything" from the bottom bar: its lock flag and the last run's
// step rows, closing summary and whether a staged app update awaits a restart.
let updatingAll = false;
let pendingUpdateDelivery = null;
let updateRun = { steps: [], summary: '', restart: false };
let lastSetupCheck = null;
let tabActivationSequence = 0;
let activeTabId = 'home', activeVpsTabId = '', browserReturnTabId = 'home', apiError = '', remoteStatus = 'disconnected', telegramStatus = 'loading', telegramDiagnostics = {};
// Native Hermes chat: 'telegram' shows the Telegram WebContentsView; 'hermes'
// shows the DOM surface (the Telegram view then measures to zero and hides).
let hermesHub = null, chatTarget = 'telegram';
let cloudError = '', cloudComputer = null, cloudPollAbort = null, modelAuthChild = null;
const tabs = new Map();
const vpsTabs = new Map();
const recentLinkTabs = new Map();
let vpsBrowserStatus = 'unconfigured', vpsBrowserError = '', vpsRefreshBusy = false, vpsFailures = 0, vpsTimer, vpsMirrorTimer, vpsMirrorDebounce;
let waitingVpsTabs = new Set();
const vpsBrowser = createVpsBrowser({ getConfig: () => prefs?.vpsBrowser });
const configuredSessions = new WeakSet();
const API_TOKEN = crypto.randomBytes(32).toString('hex');
// Connectors allow 90s for action requests; a batch stops starting new steps
// early enough that its last step (wait caps at 30s) still answers in time.
const BATCH_BUDGET_MS = 50000;
const NAVIGATE_PARSE_MS = 3000;
const OPEN_PARSE_MS = 8000;
// A snapshot waits this long for a still-parsing document; the wait ends at DOMContentLoaded.
const SNAPSHOT_PARSE_MS = 1500;
const WAIT_SLICE_MS = 1000;
const HUMAN_INPUT = new Set(['mouseDown', 'rawKeyDown', 'keyDown', 'char', 'mouseWheel', 'gestureScrollBegin', 'gestureScrollUpdate', 'touchStart']);
const TAKEOVER_NOTICE_MS = 8000, TAKE_BACK_MS = 60000;
let isQuitting = false;
let bundleWarningDismissed = false;
const runningBundle = () => process.platform === 'darwin' && app.isPackaged ? macUpdate.bundleLocation(path.resolve(process.execPath, '../../..'), app.getName()) : null;
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
  // Only a human source may auto-open a local PDF. Capture the source's
  // control when the download starts, not when its done event arrives.
  isHumanDownload: (source) => {
    const tab = [...tabs.values()].find(t => t.view.webContents === source || t.view.webContents === source?.hostWebContents);
    return !!tab && tab.controller === 'human' && !agentInput.isDispatching(tab);
  },
  openInTab: async (record, { activate = true } = {}) => { createTab({ filePath: record.path, activate }); },
  confirmOpen: async (name) => (await dialog.showMessageBox(win, { type: 'warning', buttons: ['Cancel', 'Open anyway'], defaultId: 0, cancelId: 0,
    message: `Open ${name}?`, detail: 'This file can run programs on your computer. Only open it if you trust where it came from.' })).response === 1 });
const recordings = recorder.createRecordingStore(path.join(app.getPath('userData'), 'recordings'));
let pointerTimer, activityTimer, idleTimer, captchaTimer;

function readPreferences() {
  const defaults = { bots: [], order: [], hidden: [], selectedBotId: '', accountId: '', remoteUrl: '', remotePlatform: 'linux', chatWidth: 490, preview: true, previewPos: null, showBots: true, showBrowser: true, savedTabs: [], avatarLibrary: [], avatarPreferences: {}, locationDefault: 'approximate', sitePermissions: {}, browserExtensions: [], vpsBrowser: {}, agentIdleMinutes: 15, agentLastTabs: {}, handoffs: [], downloads: [], updateSnoozedUntil: 0, vmUpdates: {}, versionCache: {},
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
    if (win && !win.isDestroyed()) prefs.savedTabs = [...tabs.values()].filter(tab => !tab.extensionPage && tab.view?.webContents && !tab.view.webContents.isDestroyed()).map((tab) => ({ url: tab.view.webContents.getURL() || tab.requestedUrl, botId: tab.botId, ...(tab.localPdf ? { localPdf: true } : {}) })).filter((item) => item.url);
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
// Delivery must not start, or a restart be offered, before its record is durable.
function saveUpdateReport() {
  if (!prefsSaver.flush()) throw new Error('The update report could not be saved. Check that app data is writable before restarting.');
}
// Onboarding and the path check need this computer's SSH address as the agent
// machine reaches it; derive it from Tailscale while the field was never set
// so a fresh install starts with a working answer. A saved value is never
// touched, including a deliberately cleared one.
function seedMacSshHost() {
  if (typeof prefs.macSshHost === 'string') return;
  let username = '';
  try { username = os.userInfo().username; } catch {}
  const host = tailscaleSshHost({ username });
  if (host) prefs.macSshHost = host;
}
function describeTab(tab, forBot = false) {
  const wc = tab.view?.webContents;
  const url = wc && !wc.isDestroyed() ? wc.getURL() : '';
  const info = { id: tab.id, title: tab.title || 'New tab', url, internal: url === NEWTAB_URL || url === 'about:blank', botId: tab.botId, favicon: tab.favicon || '', agentHue: botAccent(tab.botId).hue,
    controller: tab.controller, epoch: tab.epoch, loading: tab.loading, error: tab.error || '', ...(tab.recoveryUrl ? { recoveryUrl: tab.recoveryUrl } : {}), allowedBots: tab.allowedBots, agentCursor: tab.agentCursor || null, agentBusy: agentInput.isDispatching(tab), extensionPage: tab.extensionPage === true, localPdf: tab.localPdf === true, viewport: tab.viewport || null, host: HOST_LABEL, session: `shared-${HOST_LABEL}`, handoff: tab.handoff || null, handback: liveHandback(tab), takeover: tab.takeover || null };
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
function isVpsTarget(id, host) {
  if (host !== undefined && host !== HOST_LABEL && host !== 'vps') throw new Error('Unknown tab computer.');
  if (host === undefined && tabs.has(id) && isVpsTab(id)) throw new Error('Choose the tab and its computer.');
  const remote = host === 'vps' || (host === undefined && isVpsTab(id));
  if (host !== undefined && !(remote ? vpsTabs : tabs).has(id)) throw new Error('Tab not found on that computer.');
  return remote;
}
async function refreshVpsTabs() {
  if (!prefs?.vpsBrowser?.sshHost || vpsRefreshBusy) return;
  vpsRefreshBusy = true;
  try {
    const wasVps = vpsTabs.has(activeTabId);
    const data = await vpsBrowser.request('/v1/tabs', 'GET', undefined, { human: true });
    // API replies can warm vpsTabs before polling sees a new hold.
    const waiting = new Set(data.tabs.filter(tab => tab.handback?.state === 'awaiting_human').map(tab => tab.id));
    vpsTabs.clear();
    data.tabs.forEach(tab => {
      vpsTabs.set(tab.id, tab);
      resolveFavicon(tab, [tab.favicon]).catch(() => {});
      if (waiting.has(tab.id) && !waitingVpsTabs.has(tab.id)) {
        notifiedHandbacks.delete(`vps:${tab.id}:${tab.handback.since}`);
        notifyHandback(tab);
      }
    });
    waitingVpsTabs = waiting;
    if(wasVps&&!vpsTabs.has(activeTabId)){prefs.remoteControl=false;activeTabId='home';applyLayout();}
    vpsBrowserStatus = 'connected'; vpsBrowserError = ''; vpsFailures = 0;
  }
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
  chatTarget = 'telegram';
  const own = [...tabs.values()].filter(tab => tab.botId === id || (tab.allowedBots ?? []).includes(id));
  const nextLocal = own.some(tab => tab.id === prefs.agentLastTabs[id]) ? prefs.agentLastTabs[id] : own.at(-1)?.id || 'home';
  browserReturnTabId = nextLocal;
  activeTabId = viewingVps ? 'vps' : nextLocal;
  applyLayout();
}
// Compact, transcript-free Hermes summary for the workspace shell (sidebar
// rows + header). The full bounded conversation state ships on hermes:state.
function hermesSummary() {
  const h = hermesHub?.getState();
  if (!h) return { status: 'unconfigured', sessions: [], error: null };
  return { status: h.status, error: h.error, target: h.target, authRequired: h.authRequired,
    principal: h.principal, sessions: h.sessions, selected: h.selected,
    conversationPhase: h.conversation?.phase || '' };
}
let uiStateRevision = 0, uiStateSignature = '';
// Settings writes use bounded, caller-local high-water marks. Retiring an unseen
// request prevents its delayed delivery from reviving after a saved-state check.
// A newer renderer time origin replaces the ledger; older origins stay fenced.
const settingsWriteCallers = new WeakMap();
const settingsWriteFields = {
  autoOpenLinks: ['autoOpenLinks'], autoTakeover: ['autoTakeover'], preview: ['preview'],
  addresses: ['macSshHost', 'vpsBrowser', 'remoteUrl'], viewer: ['remoteUrl'],
};
// Explicit same-value choices also advance their field. A delayed tracked write
// cannot replace a newer choice made through the legacy public Settings command.
const settingsFieldRevisions = Object.fromEntries([...new Set(Object.values(settingsWriteFields).flat())].map(field => [field, 0]));
function settingsWriteEntry(event, token, checking = false, payload) {
  trustSender(event);
  if (!token || !Number.isFinite(token.client) || token.client <= 0 || !Number.isSafeInteger(token.sequence) || token.sequence < 1
    || !Object.hasOwn(settingsWriteFields, token.slot)) throw Error('Invalid Settings save request.');
  let ledger = settingsWriteCallers.get(event.sender);
  if (ledger && token.client < ledger.client) return { superseded: true };
  if (!ledger || token.client > ledger.client) {
    ledger = { client: token.client, fields: new Map(), slots: new Map() };
    settingsWriteCallers.set(event.sender, ledger);
  }
  const previous = ledger.slots.get(token.slot);
  if (previous?.sequence === token.sequence) return { record: previous };
  const fields = settingsWriteFields[token.slot];
  if (fields.some(field => (ledger.fields.get(field)?.sequence || 0) >= token.sequence)) return { superseded: true };
  if (!checking) {
    const keys = Object.keys(payload).filter(key => !['_settingsWrite', '_settingsContext', '_settingsBase'].includes(key)).sort();
    const expectedKeys = token.slot === 'addresses' ? ['macSshHost', 'vpsBrowser'] : token.slot === 'viewer' ? ['remoteUrl'] : [token.slot];
    if (JSON.stringify(keys) !== JSON.stringify(expectedKeys) || (token.slot in { autoOpenLinks: 1, autoTakeover: 1, preview: 1 } && typeof payload[token.slot] !== 'boolean')) throw Error('Invalid Settings save fields.');
  }
  const record = { sequence: token.sequence, slot: token.slot, status: checking ? 'not-applied' : 'admitted', expected: payload };
  ledger.slots.set(token.slot, record);
  for (const field of fields) ledger.fields.set(field, record);
  if (!checking && fields.some(field => payload._settingsBase?.[field] !== settingsFieldRevisions[field])) {
    record.status = 'not-applied'; record.detail = 'A newer choice was made. Review the current saved value before saving again.';
  }
  if (!checking && ['addresses', 'viewer'].includes(token.slot)) {
    const current = { bot: prefs.selectedBotId || '', host: HOST_LABEL, platform: prefs.remotePlatform || 'linux', mac: prefs.macSshHost || '', vps: prefs.vpsBrowser?.sshHost || '' };
    if (JSON.stringify(payload._settingsContext) !== JSON.stringify(current)) {
      record.status = 'not-applied'; record.detail = 'The connection changed. Review its saved addresses before saving again.';
    }
  }
  return { record, admit: record.status === 'admitted' };
}
// Settings alone use a staged commit; the global automatic saver keeps its
// existing behavior. Publish and seed only after the private-file write succeeds.
function persistSettingsPreferences(next) {
  if (win && !win.isDestroyed()) next.savedTabs = [...tabs.values()].filter(tab => !tab.extensionPage && tab.view?.webContents && !tab.view.webContents.isDestroyed()).map(tab => ({ url: tab.view.webContents.getURL() || tab.requestedUrl, botId: tab.botId, ...(tab.localPdf ? { localPdf: true } : {}) })).filter(item => item.url);
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    writePrivateJson(path.join(app.getPath('userData'), 'preferences.json'), next);
  } catch (error) {
    throw new Error('App data could not be written. Check that it is writable before trying again.', { cause: error });
  }
  prefs = next;
  prefsSaver.seed(prefs);
}
function settingsWriteReceipt(entry) {
  let saved;
  try { saved = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'preferences.json'), 'utf8')); }
  catch { return { settingsWrite: { status: 'unknown', detail: 'Saved settings could not be read. Check again.' }, state: getState() }; }
  const record = entry.record;
  let status = entry.superseded ? 'changed' : record.status;
  if (record?.expected && status !== 'failed') {
    const keys = record.slot === 'addresses' ? ['macSshHost', 'vpsBrowser'] : record.slot === 'viewer' ? ['remoteUrl'] : [record.slot];
    // Compare persisted values, never an optimistic renderer or in-memory flag.
    const value = (source, key) => key === 'vpsBrowser' ? [source.vpsBrowser?.sshHost || '', source.vpsBrowser?.scriptPath || '', source.vpsBrowser?.sudo === true] : source[key];
    const matches = keys.every(key => JSON.stringify(value(saved, key)) === JSON.stringify(value(record.expected, key)));
    if (status !== 'not-applied') status = matches ? 'saved' : 'changed';
  }
  return { settingsWrite: { status, detail: record?.detail || '' }, state: getState() };
}
function getState() {
  const state = { name: app.getName(), version: app.getVersion(), build: BUILD, buildBadge: describeBuild(BUILD), bots: avatarStore.publicBots().map(bot => ({ ...bot, activity: activity.get(bot.id), hue: botAccent(bot.id).hue })), order: prefs.order, hidden: prefs.hidden,
    selectedBotId: prefs.selectedBotId, settingsFieldRevisions: { ...settingsFieldRevisions }, chatWidth: prefs.chatWidth, preview: prefs.preview, previewPos: prefs.previewPos, showBots: prefs.showBots, showBrowser: prefs.showBrowser, remoteUrl: prefs.remoteUrl,
    remoteStatus, remoteControl: prefs.remoteControl === true, telegramStatus, tabs: [...tabs.values()].map(tab => describeTab(tab)).concat([...vpsTabs.values()]), cloud: cloudView(),
    vpsBrowser: prefs.vpsBrowser, vpsBrowserStatus, vpsBrowserError, handoffs: prefs.handoffs, macSshHost: prefs.macSshHost || '',
    platform: process.platform, hostLabel: HOST_LABEL, remotePlatform: prefs.remotePlatform || 'linux',
    update: { available: update.available, ready: update.ready, busy: update.busy, error: update.error, justUpdatedFrom: update.justUpdatedFrom,
      popup: shouldShowUpdatePopup({ available: update.available, snoozedUntil: prefs.updateSnoozedUntil, now: Date.now(), busy: update.busy }),
      snoozedUntil: prefs.updateSnoozedUntil || 0,
      vms: vmTargets(prefs).map((target) => ({ id: target.id, label: target.label, ...(vmProgress[target.id] || {}) })),
      vmRetry: vmRetryState(app.getVersion(), prefs.vmUpdates, vmTargets(prefs)), vmRetrying },
    versions: describeVersions({ app: app.getVersion(), appUpdate: stagedAppVersion(), appLatest, cache: prefs.versionCache }),
    updateAll: { busy: updatingAll, ...updateRun },
    bundleWarning: bundleWarningDismissed ? '' : setupCheck.bundleWarning(runningBundle(), app.getName()) || '',
    onboarding: shouldOnboard(prefs), inApplications: process.platform === 'darwin' && app.isPackaged ? setupCheck.inRouterApplications(process.execPath) : null,
    primaryBotId: prefs.primaryBotId || (prefs.overseerBots || [])[0] || '', primaryBotPref: prefs.primaryBotId || '', overseerBots: prefs.overseerBots || [],
    botSort: prefs.botSort || 'manual',
    autoOpenLinks: prefs.autoOpenLinks !== false, autoTakeover: prefs.autoTakeover !== false,
    activeTabId, activeVpsTabId, browserTabHost: activeTabId === 'vps' && vpsTabs.has(activeVpsTabId) ? 'vps' : HOST_LABEL, browserContentsId: (() => { const contents = tabs.get(activeTabId)?.view?.webContents; return contents && !contents.isDestroyed() ? contents.id : null; })(), browserTabId: activeTabId === 'vps' ? (vpsTabs.has(activeVpsTabId) ? activeVpsTabId : tabs.has(browserReturnTabId) ? browserReturnTabId : 'home') : activeTabId, avatarLibrary: avatarStore.publicLibrary(), avatarPreferences: prefs.avatarPreferences,
    locationDefault: prefs.locationDefault, sitePermissions: prefs.sitePermissions, extensions: extensionStore?.list() || [], downloads: downloadStore.list(),
    chatTarget, hermes: hermesSummary(),
    recording: recording ? { tabId: recording.tabId, steps: recording.steps.length, startedAt: recording.startedAt } : null, recordings: recordings.list(),
    fullscreen: !!win && !win.isDestroyed() && win.isFullScreen(), api: { url: apiPort ? `http://127.0.0.1:${apiPort}` : '', ready: !!apiPort, error: apiError } };
  // One authority orders native IPC reads, command replies and broadcasts by
  // snapshot content, independent of when any asynchronous reply is delivered.
  const signature = JSON.stringify(state);
  if (signature !== uiStateSignature) { uiStateSignature = signature; uiStateRevision++; }
  return { ...state, uiStateRevision };
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
let lastStateRevision = 0;
function sendState() {
  if (!win || win.isDestroyed() || !prefs) return;
  const state = getState();
  if (state.uiStateRevision !== lastStateRevision) {
    lastStateRevision = state.uiStateRevision;
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
      if (parent?.controller === 'agent' && !extensionPage) parent.opened = [...(parent.opened || []), { tabId: tab.id, url }].slice(-10);
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
  // The human's last press, key or scroll on a page holds off a bot takeover.
  contents.on('input-event', (_event, input) => {
    if (!HUMAN_INPUT.has(input.type)) return;
    const targetTab = [...tabs.values()].find(tab => tab.view.webContents === contents);
    if (targetTab && !agentInput.isDispatching(targetTab)) targetTab.lastHumanInput = Date.now();
  });
  contents.on('before-input-event', (event, input) => {
    const targetTab = [...tabs.values()].find(tab => tab.view.webContents === contents);
    if (targetTab && agentInput.isDispatching(targetTab)) return;
    if ((input.meta || input.control) && input.type === 'keyDown') {
      const key = input.key.toLowerCase();
      if (key === 'l') { event.preventDefault(); win.webContents.send('workspace:focus-address'); }
      if (key === 'o') { event.preventDefault(); pickPdf().catch(error => logError('open-pdf', error)); }
      if (key === 't') { event.preventDefault(); createTab({}); }
      if (key === 'w' && !isTelegram && activeTabId !== 'home') { event.preventDefault(); closeTab(activeTabId); }
    }
  });
  const session = contents.session;
  if (configuredSessions.has(session)) return;
  configuredSessions.add(session);
  sitePermissions.install(session, isTelegram ? 'telegram' : 'browser');
  downloadStore.install(session, isTelegram ? 'telegram' : 'browser');
  if (!isTelegram) session.on('will-download', (_event, item, source) => { try { trackAgentDownload(item, source); } catch {} });
}
// A download an agent tab starts has no human to pick a save location, so it
// saves straight into Downloads and the next action reply reports the finished
// file (name, path, state), so the agent never has to guess or re-click.
function trackAgentDownload(item, source) {
  const tab = [...tabs.values()].find(t => t.view.webContents === source);
  if (!tab || tab.controller !== 'agent') return;
  const dir = app.getPath('downloads'), name = path.basename(String(item.getFilename() || 'download')) || 'download';
  const ext = path.extname(name), stem = path.basename(name, ext);
  let target = path.join(dir, name);
  for (let n = 1; fs.existsSync(target); n++) target = path.join(dir, `${stem} (${n})${ext}`);
  item.setSavePath(target);
  const record = { name: path.basename(target), path: target, state: 'progressing' };
  record.done = new Promise((resolve) => item.once('done', (_event, state) => {
    record.state = state;
    record.bytes = item.getReceivedBytes();
    resolve();
  }));
  (tab.downloads ||= []).push(record);
}
const DOWNLOAD_WAIT_MS = 5000;
async function takeDownloads(tab) {
  const list = tab.downloads;
  if (!list?.length) return {};
  await Promise.race([Promise.all(list.map(d => d.done)), new Promise(r => setTimeout(r, DOWNLOAD_WAIT_MS))]);
  tab.downloads = list.filter(d => d.state === 'progressing');
  return { downloads: list.map(({ name, path, state, bytes }) => ({ name, path, state, ...(bytes !== undefined ? { bytes } : {}) })) };
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
async function fetchFavicon(pageUrlNow, target) {
  try {
    let response;
    for (let hop = 0; hop < 3; hop++) {
      response = await fetch(target, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location) {
        target = faviconTarget(pageUrlNow, new URL(location, target).href);
        if (!target) return '';
      } else break;
    }
    const mime = response.headers.get('content-type')?.split(';')[0]?.trim() || '';
    if (!response.ok || !mime.startsWith('image/')) return '';
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length || buffer.length > 262144) return '';
    const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;
    if (faviconCache.size > 300) faviconCache.clear();
    faviconCache.set(target, dataUrl);
    return dataUrl;
  } catch { return ''; }
}
async function resolveFavicon(tab, favicons) {
  const seq = (tab.faviconSeq = (tab.faviconSeq || 0) + 1);
  const apply = (value) => { if (tab.faviconSeq === seq && value !== tab.favicon) { tab.favicon = value; broadcast(); } };
  // Only same-origin icons, fetched without the browser session or its
  // cookies: a page-controlled favicon URL must never become a credentialed
  // fetch to somewhere the page points at (loopback, LAN, metadata).
  const pageUrlNow = tab.view?.webContents && !tab.view.webContents.isDestroyed() ? tab.view.webContents.getURL() : String(tab.url || '');
  const { targets, inline } = faviconQueue(pageUrlNow, favicons);
  for (const target of targets) {
    const dataUrl = faviconCache.get(target) || await fetchFavicon(pageUrlNow, target);
    if (dataUrl) return apply(dataUrl);
  }
  apply(inline);
}
// Until an interrupted navigation commits, Chromium reload still names the old
// page. All explicit reload entrypoints use the retained destination. Load
// failures remain visible through the tab's did-fail-load state.
function reloadBrowserPage(tab) {
  if (tab.error && tab.recoveryUrl) return tab.view.webContents.loadURL(tab.recoveryUrl).catch(() => {});
  return tab.view.webContents.reload();
}
function createTab({ url = 'about:blank', filePath = '', botId = prefs.selectedBotId || 'shared', controller = 'human', options, skipLoad = false, activate = true, extensionPage = false, localPdf = false } = {}) {
  if (tabs.size >= 40) throw new Error('Close a tab before opening another.');
  if (filePath) {
    filePath = pdfFile(filePath);
    if (!filePath) throw new Error('This file is not a PDF document.');
  }
  localPdf = !!filePath || localPdf === true;
  if (localPdf) controller = 'human';
  const targetUrl = filePath ? pathToFileURL(filePath).href : pageUrl(url, extensionPage);
  // plugins: true enables only Chromium's bundled PDF viewer, so a PDF URL
  // renders in the tab instead of downloading. The rest of the lockdown list
  // is unchanged, and the extension preload ignores the viewer's own frame.
  const view = new WebContentsView({ ...(options?.webContents ? { webContents: options.webContents } : {}),
    webPreferences: { ...options?.webPreferences, preload: undefined, partition: 'persist:browser', contextIsolation: true, nodeIntegration: false, sandbox: true,
      webSecurity: true, navigateOnDragDrop: false, plugins: true, backgroundThrottling: false } });
  view.setBackgroundColor('#0b0b0c');
  const tab = { id: crypto.randomUUID(), view, requestedUrl: skipLoad ? '' : targetUrl, botId: String(botId).slice(0, 100), controller, extensionPage, localPdf, epoch: 1, title: filePath ? path.basename(filePath) : 'New tab', loading: false, allowedBots: [], refs: new Set(), generation: 0, queue: Promise.resolve() };
  if (controller === 'agent') tab.agentSince = Date.now();
  tabs.set(tab.id, tab);
  tab.host = backgroundHost();
  tab.host.contentView.addChildView(view);
  // Background agent tabs still need a real viewport for layout and screenshots.
  const viewport = layout.browser || { x: 0, y: 0, width: 900, height: 700 };
  view.setBounds({ x: Math.round(viewport.x), y: Math.round(viewport.y), width: Math.round(viewport.width), height: Math.round(viewport.height) });
  configureContents(view.webContents);
  syncFollowUpSeed(tab);
  syncDialogGuard(tab);
  // The library selects newly registered tabs. Registration must not reparent
  // or focus a background agent view in the human window.
  registeringExtensionTab = true;
  try { extensionHost?.addTab(view.webContents, win); } finally { registeringExtensionTab = false; }
  extensionActiveContentsId = undefined;
  view.webContents.on('context-menu', (_event, params) => {
    const items = extensionHost?.getContextMenuItems(view.webContents, params) || [];
    if (items.length && tab.id === activeTabId && tab.controller === 'human') Menu.buildFromTemplate(items).popup({ window: win });
  });
  const liveBrowserFrames = () => {
    const wc = view.webContents;
    if (wc.isDestroyed()) return null;
    try {
      const frame = wc.mainFrame;
      return frame.isDestroyed() || frame.detached ? null : frame.framesInSubtree;
    } catch { return null; } // A crash can dispose the frame before renderer-gone.
  };
  const installViewerDrop = () => {
    const frames = liveBrowserFrames();
    if (!frames) return;
    for (const frame of frames) {
      if (!frame.url.startsWith('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/')) continue;
      // Electron preloads do not run in the bundled viewer. Relay only native
      // dropped File objects to the MIME shell's isolated preload, never paths.
      frame.executeJavaScript(`(() => {
        if (window.workspacePdfDropInstalled) return;
        window.workspacePdfDropInstalled = true;
        window.addEventListener('dragover', event => { if (event.isTrusted && [...(event.dataTransfer?.items || [])].some(item => item.kind === 'file')) event.preventDefault(); }, true);
        window.addEventListener('drop', event => {
          if (!event.isTrusted) return;
          const files = [...(event.dataTransfer?.files || [])].filter(file => /\\.pdf$/i.test(file.name));
          if (!files.length) return;
          event.preventDefault(); event.stopImmediatePropagation();
          window.top.postMessage({ workspacePdfDrop: true, files }, '*');
        }, true);
      })()`).catch(() => {});
    }
  };
  view.webContents.on('did-frame-finish-load', installViewerDrop);
  view.webContents.on('page-title-updated', (_event, title) => { tab.title = tab.localPdf && /^file:/.test(view.webContents.getURL()) ? path.basename(fileURLToPath(view.webContents.getURL())) : title; broadcast(); });
  view.webContents.on('did-start-loading', () => { tab.loading = true; tab.error = ''; broadcast(); });
  view.webContents.on('did-start-navigation', (_event, url, inPlace, isMainFrame) => {
    if (!isMainFrame || inPlace) return;
    // getURL()/reload() still name the old committed page until this commits.
    tab.navigationUrl = url; tab.recoveryUrl = ''; tab.error = ''; tab.loading = true; broadcast();
  });
  view.webContents.on('did-redirect-navigation', (_event, url, inPlace, isMainFrame) => {
    if (isMainFrame && !inPlace) tab.navigationUrl = url;
  });
  view.webContents.on('did-stop-loading', () => {
    if (view.webContents.isLoading()) return;
    // A completed stop leaves the committed frame alive. Crash-induced stop can
    // precede isCrashed()/renderer-gone, but its frame is already disposed: keep
    // that interrupted destination for explicit recovery, never a canceled one.
    if (liveBrowserFrames()) tab.navigationUrl = '';
    tab.loading = false; installViewerDrop(); savePreferencesSoon(); broadcast();
  });
  view.webContents.on('did-navigate', () => { tab.navigationUrl = ''; tab.recoveryUrl = ''; tab.refs.clear(); tab.snapshotStamp = null; tab.scan = null; tab.lastRead = null; tab.favicon = ''; tab.faviconSeq = (tab.faviconSeq || 0) + 1; tab.generation++; if (tab.controller === 'agent') { view.webContents.executeJavaScript(tintScript(true)).catch(() => {}); scheduleVpsMirror(); } broadcast(); });
  view.webContents.on('page-favicon-updated', (event, favicons) => { resolveFavicon(tab, favicons).catch(() => {}); });
  view.webContents.on('did-navigate-in-page', () => { tab.generation++; if (tab.controller === 'agent') scheduleVpsMirror(); broadcast(); });
  view.webContents.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3 || url !== (tab.navigationUrl || tab.recoveryUrl || view.webContents.getURL())) return;
    tab.recoveryUrl = url; tab.navigationUrl = ''; tab.error = description; tab.loading = false; broadcast();
  });
  view.webContents.on('render-process-gone', () => {
    tab.recoveryUrl = tab.navigationUrl || view.webContents.getURL() || tab.requestedUrl;
    tab.navigationUrl = ''; tab.loading = false;
    tab.refs.clear(); tab.snapshotStamp = null; tab.scan = null; tab.lastRead = null; tab.generation++;
    tab.error = 'This page stopped. Reload to reconnect.'; broadcast();
  });
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
  if (recording?.tabId === id) { try { stopRecording(); } catch (error) { logError('recording', error); } }
  tabs.delete(id);
  handbackNotices.get(`${HOST_LABEL}:${id}`)?.close();
  handbackNotices.delete(`${HOST_LABEL}:${id}`);
  for (const key of notifiedHandbacks) if (key.startsWith(`${HOST_LABEL}:${id}:`)) notifiedHandbacks.delete(key);
  if (tab.view.webContents) extensionHost?.removeTab(tab.view.webContents);
  if (browserReturnTabId === id) browserReturnTabId = [...tabs.keys()].at(-1) || 'home';
  tab.host?.contentView.removeChildView(tab.view);
  tab.view.webContents?.close();
  if (activeTabId === id) activeTabId = [...tabs.keys()].at(-1) || 'home';
  savePreferences(); applyLayout(); broadcast();
}
// The settle tracker is planted on an agent tab before its first document
// script, so a page that bound fetch or setTimeout at module init still routes
// through the tracker once an action arms it. Inert until armed, and stripped
// again when the tab goes back to a human.
function syncFollowUpSeed(tab) {
  const wc = tab.view.webContents;
  if (!wc || wc.isDestroyed()) return;
  if (tab.controller === 'agent') {
    if (tab.followUpSeed) return;
    tab.followUpSeed = true;
    browserCommand(tab, 'Page.addScriptToEvaluateOnNewDocument', { source: followUpInstallExpression() })
      .catch(() => { tab.followUpSeed = false; });
  } else if (tab.followUpSeed) {
    tab.followUpSeed = false;
    browserCommand(tab, 'Page.removeAllScriptsToEvaluateOnNewDocument').catch(() => {});
  }
}
// An open JS dialog blocks the page and every evaluate on it, and on a
// background tab nobody sees the native sheet. With Page enabled on the
// debugger Chromium hands dialogs to us instead: an agent tab answers at once
// (answerDialog, same rules as the VM host) and the next action reply says
// what it said. A human's tab keeps its native dialog.
function syncDialogGuard(tab) {
  const wc = tab.view.webContents;
  if (!wc || wc.isDestroyed()) return Promise.resolve();
  if (tab.controller !== 'agent') {
    if (!tab.pageEnabled) return Promise.resolve();
    tab.pageEnabled = false;
    return browserCommand(tab, 'Page.disable').catch(() => {});
  }
  if (!tab.dialogListener) {
    tab.dialogListener = true;
    wc.debugger.on('message', (_event, method, params) => {
      if (method !== 'Page.javascriptDialogOpening' || tab.controller !== 'agent') return;
      const { record, params: answer } = answerDialog(params.type, params.message, tab.dialogAnswer);
      tab.dialogs = [...(tab.dialogs || []), record].slice(-20);
      wc.debugger.sendCommand('Page.handleJavaScriptDialog', answer).catch(() => {});
    });
    wc.debugger.on('detach', () => { tab.pageEnabled = false; });
  }
  if (tab.pageEnabled && wc.debugger.isAttached()) return Promise.resolve();
  tab.pageEnabled = true;
  return browserCommand(tab, 'Page.enable').catch(() => { tab.pageEnabled = false; });
}
function takeDialogs(tab) {
  const dialogs = tab.dialogs;
  tab.dialogs = undefined;
  return dialogs ? { dialogs } : {};
}
// Tabs the page opened (window.open, target=_blank) while the bot acted, so
// the reply names them and no tab listing is needed to find a popup.
function takeOpened(tab) {
  const opened = tab.opened;
  tab.opened = undefined;
  return opened ? { opened: opened.filter((item) => tabs.has(item.tabId)).map((item) => ({ ...item, url: tabs.get(item.tabId).view.webContents.getURL() || item.url, title: tabs.get(item.tabId).title || '', epoch: tabs.get(item.tabId).epoch })) } : {};
}
function changeController(id, controller, source = 'human', handback = null) {
  const tab = tabs.get(id);
  if (!tab) throw new Error('Tab not found.');
  if (tab.localPdf && controller === 'agent') throw new Error('Local PDF tabs stay under your control.');
  if (tab.extensionPage && controller === 'agent') throw new Error('Extension account pages stay under your control.');
  // Only the human's own browsing is recorded: a bot taking the tab ends it.
  if (recording?.tabId === id && (controller === 'agent' || tab.extensionPage)) { try { stopRecording(); } catch (error) { logError('recording', error); } }
  const wasAgent = tab.controller === 'agent';
  tab.takeover = null;
  tab.handback = nextHandback(tab, controller, source, handback);
  // Browsing a CAPTCHA tab themselves (address bar, back, reload) makes the
  // human the one to give it back: the automatic return stops watching it.
  if (wasAgent === false && source === 'human' && controller === 'human' && tab.handback?.reason === 'captcha') tab.handback = { ...tab.handback, watch: false };
  tab.controller = controller === 'agent' ? 'agent' : 'human';
  syncFollowUpSeed(tab);
  syncDialogGuard(tab);
  // An explicit human takeover seals the tab to bots until the human hands
  // it back in the UI. A bot's own release or the idle-expiry clock stays
  // retakeable, and a tab already locked stays locked.
  if (tab.controller === 'agent') { tab.humanLock = false; tab.agentSince = Date.now(); }
  else if (wasAgent) { tab.humanLock = source === 'human'; tab.humanSince = Date.now(); }
  if (tab.controller === 'agent' && tab.challengeLog) tab.challengeLog.on = '';
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
  notifyHandback(describeTab(tab));
  broadcast();
  return describeTab(tab);
}
// A bot's claim, or an action on a tab the human holds, takes the tab back when
// Settings allow it (on by default). The claim rules run before and after the
// grace wait: the human may hand the tab over or start recording meanwhile.
// A caller holding an epoch (an action or a close) needs the tab unchanged
// since it read it; a plain claim gets a fresh epoch either way.
function claimRules(tab) {
  const autoTakeover = prefs.autoTakeover !== false;
  return { autoTakeover, recording: autoTakeover && recording?.tabId === tab.id };
}
// An action also holds the page's navigation generation, and dry-runs itself
// (preflight) after the wait, so a refusal never takes the tab.
async function claimTab(tab, botId, { isClosed = () => false, overseer = false, epoch, generation, preflight, beforeClaim } = {}) {
  if (tab.localPdf) throw Object.assign(new Error('Local PDF tabs stay under your control.'), { status: 403 });
  const rules = () => claimRules(tab);
  requireAgentClaim(tab, Date.now(), rules());
  const auto = rules().autoTakeover && tab.controller === 'human';
  if (auto) {
    const started = Date.now();
    for (let ms; (ms = takeoverDelay(tab.lastHumanInput, started)) > 0;) await new Promise((resolve) => setTimeout(resolve, ms));
    // Another bot's claim, Take back or a navigation may have moved the tab
    // while this one waited or dry-ran.
    const recheck = () => {
      if (isClosed()) throw Object.assign(new Error('The request was closed before this action started.'), { status: 499 });
      if (!tabs.has(tab.id)) throw Object.assign(new Error('Tab not found.'), { status: 404 });
      requireAgentClaim(tab, Date.now(), rules());
      if (tab.botId !== 'shared') requireActorCore(tab, botId, undefined, false, overseer);
      if ((epoch !== undefined && tab.epoch !== epoch) || (generation !== undefined && tab.generation !== generation))
        throw Object.assign(new Error(STALE_WAIT), { status: 409 });
    };
    recheck();
    if (tab.controller === 'agent') return describeTab(tab);
    // Input during the dry run restarts the grace (still 10 seconds at most).
    while (preflight) {
      await preflight(); recheck();
      if (tab.controller === 'agent') return describeTab(tab);
      const ms = takeoverDelay(tab.lastHumanInput, started);
      if (ms <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, ms)); recheck();
    }
  }
  // Revalidate the dry approval while the human still holds the epoch.
  beforeClaim?.();
  // The notice is for a tab the human took or used, not one a bot released
  // that sat idle.
  const took = auto && tab.controller === 'human' && (tab.humanLock || (tab.lastHumanInput || 0) >= (tab.humanSince || 0));
  tab.handoff = reviewedHandoff(tab.handoff);
  if (tab.botId === 'shared') tab.botId = botId;
  const info = changeController(tab.id, 'agent', 'agent');
  if (!took) return info;
  const notice = tab.takeover = { botId: tab.botId, at: Date.now() };
  setTimeout(() => { if (tab.takeover === notice) { tab.takeover = null; broadcast(); } }, TAKEOVER_NOTICE_MS);
  broadcast();
  return describeTab(tab);
}
// With automatic takeover on, the human grabbing a tab mid-call is not a stop
// sign: the bot's next call takes the tab back once they pause.
function takeoverError(error) {
  if (prefs.autoTakeover !== false && /^human_has_control/.test(error?.message || ''))
    error.message = 'human_took_tab: the human took this tab during your call. Check its effect, then call again; the tab comes back to you once they pause.';
  return error;
}
const STALE_WAIT = 'stale_control_epoch: the tab changed while you waited (the human navigated, or another claim landed). Claim it, read it, then act.';
// A dry run (tab.preflight) acts for a tab the human still holds: it needs the
// tab's bot and an unchanged epoch, and stops at the first change to the page.
function requireActor(tab, botId, epoch, mutate = false, overseer = false, now = Date.now()) {
  if (!tab.preflight || !mutate || tab.controller === 'agent') return requireActorCore(tab, botId, epoch, mutate, overseer, now);
  requireActorCore(tab, botId, epoch, false, overseer, now);
  if (epoch !== tab.epoch) throw Object.assign(new Error(STALE_WAIT), { status: 409 });
}
function dryRun(tab) { if (tab.preflight) throw PREFLIGHT_READY; }
const STALE_HUMAN_EPOCH = 'stale_control_epoch: the human took this tab and may have changed the page. Claim it (control, controller "agent") to take it back, read it, then act.';
const OTHER_ACTIONS = new Set(['navigate', 'back', 'forward', 'reload', 'batch', 'read', 'eval', 'wait', 'viewport', 'cdp']);
const UNSUPPORTED_ACTION = 'Supported actions: navigate, click, double_click, right_click, drag, select, type, press, move, scroll, back, forward, reload, batch, read, eval, wait, viewport, cdp.';
// The checks an action passes before it touches the page, run before a bot
// takes a tab back so a malformed action never costs the human their tab.
async function checkAction(tab, body, botId, depth = 0) {
  const bad = (message) => { throw Object.assign(new Error(message), { status: 400 }); };
  if (!body || typeof body !== 'object' || typeof body.action !== 'string') bad('action is required.');
  const { action } = body;
  if (!INPUT_ACTIONS.has(action) && !OTHER_ACTIONS.has(action)) bad(UNSUPPORTED_ACTION);
  if (body.dialog !== undefined) dialogAnswer(body.dialog);
  // Later steps may aim at refs the first one finds, so only the first is checked.
  if (action === 'batch') return depth > 0 ? bad('Batches cannot nest.') : Array.isArray(body.steps) && body.steps.length ? checkAction(tab, body.steps[0], botId, 1) : bad('batch needs a non-empty steps array (max 25).');
  if (INPUT_ACTIONS.has(action)) return agentInput.perform(tab, body, botId, { argsOnly: true });
  const code = String(body.code || '');
  if (action === 'eval' && (!code || code.length > 16384)) bad('eval needs a code string (max 16KB).');
  if (action === 'wait' && !body.selector && !body.text && !body.url) bad('wait needs a selector, text, or url to wait for.');
  const width = Math.round(Number(body.width)), height = Math.round(Number(body.height));
  if (action === 'viewport' && body.clear !== true && !(width >= 100 && width <= 7680 && height >= 100 && height <= 4320))
    bad('viewport needs width 100-7680 and height 100-4320, or clear:true.');
  if (action === 'navigate') agentPageUrl(body.url);
  if (action === 'cdp') {
    const methodError = cdpMethodError(String(body.method || ''));
    if (methodError) bad(methodError);
    if (body.method === 'Page.navigate') { if (typeof body.params?.url !== 'string' || !body.params.url) bad('Page.navigate needs a url string.'); agentPageUrl(body.params.url); }
  }
}
// A read that finds a challenge reports it (with the back-off advice), and a
// blocking one on a bot's tab goes to the human at once: the N2 release with
// reason captcha, made by the app so the bot never has to remember.
function handleChallenge(tab, raw) {
  const url = tab.view.webContents.getURL();
  const challenge = challengeReply(tab, url, raw);
  if (challenge?.blocking && tab.controller === 'agent') {
    try { changeController(tab.id, 'human', 'agent', captchaHandback(url, challenge)); } catch (error) { logError('captcha release', error); }
  }
  return challenge ? { challenge } : {};
}
// While a tab waits on a human for a CAPTCHA, a cheap page probe each second
// hands it back once the challenge it saw has cleared (see captchaWatchStep).
// The human can still give it back themselves.
function watchCaptchas() {
  for (const tab of tabs.values()) {
    const h = liveHandback(tab), wc = tab.view.webContents;
    if (h?.state !== 'awaiting_human' || h.reason !== 'captcha' || h.watch === false || wc.isDestroyed()) { tab.captchaWatch = undefined; continue; }
    if (tab.captchaProbing) continue;
    tab.captchaProbing = true;
    readJs(wc, challengeProbeExpression(), 2000).catch(() => null).then((probe) => {
      tab.captchaProbing = false;
      if (!tabs.has(tab.id) || liveHandback(tab) !== h) return;
      tab.captchaWatch = captchaWatchStep(tab.captchaWatch || { seen: h.auto === true, clear: 0, typing: '' }, probe);
      if (!tab.captchaWatch.resume) return;
      tab.captchaWatch = undefined;
      try { changeController(tab.id, 'agent', 'human'); } catch (error) { return logError('captcha resume', error); }
      tab.handback = { ...tab.handback, resumed: 'auto' };
      broadcast();
    });
  }
}
const HANDBACK_TEXT = { captcha: 'Solve the CAPTCHA, then give the tab back.', login: 'Sign in, then give the tab back.', two_factor: 'Enter the verification code, then give the tab back.', payment_details: 'Enter the card details, then give the tab back.', review: 'Review the page, then give the tab back.', other: 'Take a look, then give the tab back.' };
// One notification per handback. Notifications are kept per tab so a click
// still reaches its handler after garbage collection.
const handbackNotices = new Map(), notifiedHandbacks = new Set();
function notifyHandback(info) {
  const h = info && info.handback;
  if (!h || h.state !== 'awaiting_human' || !Notification.isSupported()) return;
  const key = `${info.host}:${info.id}:${h.since}`;
  if (notifiedHandbacks.has(key)) return;
  notifiedHandbacks.add(key);
  const notice = new Notification({ title: `${nameForBot(info.botId) || 'Your agent'} needs you`, body: h.note || HANDBACK_TEXT[h.reason] || '' });
  notice.on('click', () => {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show(); win.focus();
    if (!(info.host === 'vps' ? vpsTabs : tabs).has(info.id)) return;
    // A collapsed browser pane would hide the badge and the banner.
    if (prefs.showBrowser === false) { prefs.showBrowser = true; savePreferencesSoon(); }
    activateTab(info.id, info.host).then(broadcast, () => {});
  });
  handbackNotices.set(`${info.host}:${info.id}`, notice);
  notice.show();
}
async function activateTab(tabId, host) {
  const remote = isVpsTarget(tabId, host), sequence = ++tabActivationSequence;
  const id = remote ? 'vps' : tabId;
  if(id==='vps'&&activeTabId!=='vps')browserReturnTabId=activeTabId;
  if(activeTabId!==id)prefs.remoteControl=false;
  activeTabId=tabs.has(id)||['home','vps'].includes(id)?id:'home';
  if (remote) {
    activeVpsTabId = '';
    await remoteRequest(tabId, 'activate', {});
    if (sequence !== tabActivationSequence) return;
    activeVpsTabId = tabId;
  }
  applyLayout();
}
// One recording at a time, on a tab the human controls. The page script runs
// in its own isolated world on each document (dom-ready); Page stays disabled
// so the human keeps native dialogs. The recording shows (and the Record
// command returns) only once the script is in the page, so nothing typed
// right after pressing Record is lost. Steps live in memory until Stop.
let recording = null, recordingStarting = false;
async function startRecording(id) {
  const tab = tabs.get(id);
  const recordable = () => tabs.get(id) === tab && tab.controller === 'human' && !tab.extensionPage;
  if (!tab) throw new Error('Open a page to record first.');
  if (recording || recordingStarting) throw new Error('A recording is already running. Stop it first.');
  if (!recordable()) throw new Error('Take over this tab before recording it.');
  if (recordings.full()) throw new Error(`You have ${recorder.MAX_RECORDINGS} recordings. Delete one in Settings to record another.`);
  const wc = tab.view.webContents;
  const rec = { tabId: id, title: tab.title, steps: [], startedAt: Date.now() };
  const add = (step) => { if (recording === rec) { recorder.addStep(rec.steps, step); broadcast(); } };
  rec.onMessage = (_event, method, params) => {
    if (method !== 'Runtime.bindingCalled' || params.name !== recorder.BINDING) return;
    try { add(recorder.normalizeEvent(JSON.parse(params.payload))); } catch {}
  };
  rec.onNavigate = (_event, url) => add(recorder.navigateStep(url));
  rec.onInPage = (_event, url, isMainFrame) => { if (isMainFrame) add(recorder.navigateStep(url)); };
  // ponytail: main frame only; a task inside an iframe records as clicks on the frame's host page.
  rec.inject = async () => {
    const { frameTree } = await browserCommand(tab, 'Page.getFrameTree');
    const { executionContextId } = await browserCommand(tab, 'Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: recorder.WORLD });
    await browserCommand(tab, 'Runtime.evaluate', { expression: recorder.PAGE_SCRIPT, contextId: executionContextId });
  };
  rec.onReady = () => rec.inject().catch(() => {});
  wc.debugger.on('message', rec.onMessage);
  wc.on('did-navigate', rec.onNavigate);
  wc.on('did-navigate-in-page', rec.onInPage);
  wc.on('dom-ready', rec.onReady);
  recordingStarting = true;
  try {
    await browserCommand(tab, 'Runtime.enable');
    await browserCommand(tab, 'Runtime.addBinding', { name: recorder.BINDING, executionContextName: recorder.WORLD });
    await rec.inject();
    // A bot may have claimed the tab, or it closed, while the script went in.
    if (!recordable()) throw new Error('the tab changed hands.');
  } catch (error) {
    detachRecorder(rec);
    throw new Error(`Could not record this page: ${errorMessage(error)}`);
  } finally { recordingStarting = false; }
  recording = rec;
  add(recorder.navigateStep(wc.getURL()));
  broadcast();
}
function detachRecorder(rec) {
  const tab = tabs.get(rec.tabId), wc = tab?.view.webContents;
  if (!wc || wc.isDestroyed()) return;
  wc.debugger.removeListener('message', rec.onMessage);
  wc.removeListener('did-navigate', rec.onNavigate).removeListener('did-navigate-in-page', rec.onInPage).removeListener('dom-ready', rec.onReady);
  if (wc.debugger.isAttached()) {
    browserCommand(tab, 'Runtime.removeBinding', { name: recorder.BINDING }).catch(() => {});
    browserCommand(tab, 'Runtime.disable').catch(() => {});
  }
}
function stopRecording({ save = true, keepTyped = false } = {}) {
  const rec = recording;
  if (!rec) return null;
  recording = null;
  detachRecorder(rec);
  try {
    // A lone starting page teaches nothing.
    if (!save || !rec.steps.some(step => step.action !== 'navigate')) return null;
    const tab = tabs.get(rec.tabId);
    const host = new URL(rec.steps[0].url).hostname;
    const { title, steps } = recorder.finishRecording(rec.steps, { keepTyped, title: rec.title && rec.title !== 'New tab' ? rec.title : tab?.title, fallbackTitle: host });
    return recordings.save({ title, steps, keepTyped, sharedWith: prefs.selectedBotId ? [prefs.selectedBotId] : [] });
  } finally { broadcast(); }
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
let openingTelegramUsername = false;
async function openTelegramUsername(username) {
  if (!telegramView || telegramView.webContents.isDestroyed()) throw new Error('Telegram is not loaded.');
  if (telegramStatus !== 'connected') throw new Error('Sign in to Telegram before opening a bot.');
  if (openingTelegramUsername) throw new Error('Wait for the current bot to open, then try again.');
  openingTelegramUsername = true;
  try {
    const result = await boundedJs(telegramView.webContents, openUsernameScript(username), 20000);
    const bot = sanitizeBots([result?.bot])[0];
    if (result?.ok !== true || !bot || bot.username.toLowerCase() !== username.toLowerCase()) {
      throw new Error(result?.error || `Telegram could not open @${username}. Try again.`);
    }
    const existing = prefs.bots.find(item => item.id === bot.id);
    if (!existing) prefs.bots.push(bot);
    selectAgent(bot.id);
    savePreferences();
  } finally { openingTelegramUsername = false; }
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
// The guest script narrates phases ("Updating agent plugins…"); fold them
// into the VM's detail line so the popup shows what it is doing.
function noteVmProgress(id, text) {
  vmProgress[id] = { ...(vmProgress[id] || {}), state: 'updating', detail: String(text || '') };
  broadcast();
}
// A finished VM update carries per-plugin lines; they are warnings, never a
// change to the VM's ok/failed state.
function vmProgressResult(result) {
  return { state: result.state, error: result.error || '', version: result.version || '',
    pluginLines: result.pluginLines || [] };
}
// Record what a VM update attempt produced so a relaunch can offer retry.
function noteVmResult(result) {
  const previous = prefs.vmUpdates?.[result.id] || {};
  prefs.vmUpdates = { ...(prefs.vmUpdates || {}), [result.id]: result.ok
    ? { version: result.version || '', failed: '' }
    : { version: result.version || previous.version || '', failed: result.error || 'The VM update failed.' } };
}
// After relaunch (and at every start) each saved VM reports its checkout
// version; a VM behind the app surfaces through update.vmRetry. The same
// probe feeds the bottom bar: the machine's Hermes, plugin and gateway, plus
// the newest plugin tag on GitHub. No saved server means the Hermes on this
// computer. Callers skip it while an update holds the machine: `hermes update
// --check` fetches into the same checkout `hermes update` is moving.
// One probe at a time: a caller arriving mid-probe shares the running one.
let versionsProbe = null;
function checkVmVersions() {
  versionsProbe ||= probeVersions().finally(() => { versionsProbe = null; });
  return versionsProbe;
}
async function probeVersions() {
  // Records outlive their VM when a target is removed or an older build wrote
  // a bad id; drop them so only live VMs can ever steer the retry banner.
  const targets = vmTargets(prefs);
  prefs.vmUpdates = pruneVmUpdates(prefs.vmUpdates, targets);
  const target = targets[0] || LOCAL_TARGET;
  const [result, pluginLatest, hostLatest] = await Promise.all([vmUpdater.checkVm(target), latestPluginTag().catch(() => ''),
    !target.local && app.getVersion().includes('-') ? latestHostRelease().catch(() => '') : '']);
  // The server address changed while this probe ran: its answer describes
  // the old machine, so drop it and probe the new one.
  if ((vmTargets(prefs)[0]?.sshHost || '') !== (target.sshHost || '')) { setTimeout(checkVersionsWhenIdle, 0); return; }
  if (result.ok && !target.local) {
    const entry = vmCheckEntry(prefs.vmUpdates?.[target.id], result);
    if (entry) prefs.vmUpdates = { ...(prefs.vmUpdates || {}), [target.id]: entry };
  }
  prefs.versionCache = versionRecord(prefs.versionCache, { target, check: result, pluginLatest, hostLatest, now: Date.now() });
  savePreferencesSoon(); broadcast();
}
// The app step in "Update everything" only plans for a build the updater
// has staged (update-now has the same guard).
const stagedAppVersion = () => (updateDriver === 'electron-updater' ? update.ready : updateDriver === 'self' && Boolean(update.tag)) ? update.available : '';
// Every update path takes its lock, then waits out a probe already in flight.
const waitForVersionCheck = () => versionsProbe?.catch(() => {});
// While "Update everything" runs, quitting must not install the staged app
// build: the app would come back ahead of a half-updated server.
function holdAppInstall(hold) {
  if (updateDriver === 'electron-updater') require('electron-updater').autoUpdater.autoInstallOnAppQuit = !hold;
}
const VERSIONS_EVERY_MS = 30 * 60 * 1000;
const checkVersionsWhenIdle = () => {
  if (updateLocked({ updateBusy: update.busy, vmRetrying, hermesUpdating, updatingAll })) return;
  checkVmVersions().catch((error) => logError('vm-check', error));
};
// Hands over to the new app build: electron-updater installs on quit, an
// unsigned Mac swaps its own bundle and relaunches.
async function restartIntoUpdate() {
  if (updateDriver === 'electron-updater') {
    // quitAndInstall closes windows without a before-quit, so the close
    // handler would hide the window instead and the app would never exit.
    isQuitting = true;
    mainLog().write('updater', 'quitAndInstall called');
    armQuitWatchdog({ exit: (code) => app.exit(code), log: (text) => mainLog().write('updater', text) });
    require('electron-updater').autoUpdater.quitAndInstall();
    return;
  }
  await macUpdate.installMacUpdate({ tag: update.tag, bundlePath: path.resolve(process.execPath, '../../..') });
  savePreferences(); app.relaunch(); app.exit(0);
}
// One "Update everything" step against the agent machine (or this app). Each
// reuses the flow its own button runs: hermes-update (quiet: the bot reports
// once at the end), vm-update --plugins, the tag update, and the app updater.
async function runUpdateStep(step, target) {
  if (step.id === 'hermes') {
    const result = await vmUpdater.hermesUpdateVm(target, { quiet: true });
    return { ok: result.ok, error: result.error, version: result.version, before: result.before, current: result.current, updated: result.updated,
      detail: result.ok ? (result.updated ? `Updated to ${result.version || 'the latest version'}` : result.current ? 'Already up to date' : result.error || 'Version unchanged or unverified') : '' };
  }
  if (step.id === 'plugin') {
    const result = await vmUpdater.updatePluginsVm(target);
    return pluginStepResult(result, step);
  }
  if (step.id === 'host') {
    const result = await vmUpdater.updateVm(target, `v${step.to}`);
    noteVmResult(result); savePreferences();
    const lines = result.pluginLines || [];
    return { ok: result.ok, error: result.error, version: result.version, warning: lines.some((line) => line.tone === 'warn'),
      detail: [result.ok ? `Running ${result.version}` : '', ...lines.map((line) => line.text)].filter(Boolean).join(' ') };
  }
  // The app only stages here; the restart is the user's click.
  return stagedAppVersion() ? { ok: true, detail: 'Downloaded. Restart to finish.' } : { ok: false, error: 'The app update is not downloaded yet; try again in a few minutes.' };
}
// Offline or rate-limited checks stay quiet for the user; only the first failure is logged, and the next check retries.
let updateDriver = 'none';
let appLatest = '', checkAppVersions = () => {};
function startUpdates() {
  mainLog().write('app', `v${app.getVersion()} started from ${path.resolve(process.execPath, '../../..')}`);
  if (prefs.lastVersion && prefs.lastVersion !== app.getVersion()) update.justUpdatedFrom = prefs.lastVersion;
  if (prefs.lastVersion !== app.getVersion()) { prefs.lastVersion = app.getVersion(); savePreferences(); }
  pendingUpdateDelivery = deliverPendingUpdateReport({ prefs, version: app.getVersion(), save: saveUpdateReport,
    send: (report, target) => vmUpdater.hermesUpdateVm(target, { report }),
    log: text => mainLog().write('update report', text),
  }).catch(error => logError('update report', error));
  if (prefs.updateSnoozedUntil) { prefs.updateSnoozedUntil = 0; savePreferencesSoon(); }
  checkVersionsWhenIdle(); setInterval(checkVersionsWhenIdle, VERSIONS_EVERY_MS);
  if (!app.isPackaged) return;
  // Only a Developer ID signed Mac app can use electron-updater (Squirrel
  // verifies the update signature); unsigned installs keep swapping the dmg.
  const signed = process.platform === 'darwin' && macUpdate.isDeveloperIdSigned(path.resolve(process.execPath, '../../..'));
  updateDriver = macUpdate.updaterDriver(process.platform, signed);
  let check;
  if (updateDriver === 'electron-updater') {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoInstallOnAppQuit = true;
    const note = (text) => mainLog().write('updater', text);
    autoUpdater.on('checking-for-update', () => note('checking'));
    autoUpdater.on('update-available', (info) => { note(`available ${info?.version}`); appLatest = info?.version || ''; broadcast(); });
    autoUpdater.on('update-not-available', (info) => { note('none available'); appLatest = info?.version || ''; broadcast(); });
    autoUpdater.on('update-downloaded', (info) => { note(`downloaded ${info.version}`); appLatest = info.version; update.available = info.version; update.ready = true; broadcast(); });
    const feed = githubFeed(fs.existsSync(path.join(process.resourcesPath, 'app-update.yml')), PUBLISH);
    if (feed) autoUpdater.setFeedURL(feed);
    let logged = false;
    const failed = (error) => { appLatest = ''; broadcast(); mainLog().write('updater error', String(error?.message || error)); if (!logged) { logged = true; logError('updater', error); } };
    autoUpdater.on('error', failed);
    check = () => autoUpdater.checkForUpdates().catch(failed);
  } else {
    // Linux reads release evidence too, but only the Mac self-updater stages it.
    check = async () => {
      try {
        const latest = await macUpdate.checkLatest();
        appLatest = latest?.version || '';
        if (updateDriver === 'self' && latest && macUpdate.isNewer(latest.version, app.getVersion())) { update.available = latest.version; update.tag = latest.tag; broadcast(); }
        broadcast();
      } catch { appLatest = ''; broadcast(); }
    };
  }
  checkAppVersions = check;
  check(); setInterval(check, 6 * 60 * 60 * 1000);
}
// The claimed session stays encrypted in preferences and is never logged or
// sent anywhere but the cloud API, so a restart or a second click on the
// claim link resumes onboarding instead of claiming the token again.
function cloudSession() {
  try {
    const enc = prefs?.cloud?.sessionEnc;
    if (!enc || !safeStorage.isEncryptionAvailable()) return '';
    return safeStorage.decryptString(Buffer.from(enc, 'base64'));
  } catch { return ''; }
}
function cloudView() {
  const cloud = prefs?.cloud && typeof prefs.cloud === 'object' ? prefs.cloud : {};
  const session = cloudSession();
  const computer = cloudComputer ? { state: cloudComputer.state || '', step: cloudComputer.step || '', error: cloudComputer.error || '',
    name: cloudComputer.computer_name || cloud.computerName || '', tailscaleUrl: cloudComputer.tailscale_url || cloud.tailscaleUrl || '' } : null;
  return { claimed: !!session || cloud.diy === true, diy: cloud.diy === true,
    step: cloudStep(prefs, cloudComputer) || '',
    model: cloud.model || '', existingModel: cloud.diy === true ? cloudModel.parseExistingModel({ code: 0, out: `${cloud.existingModel?.provider || ''}\n${cloud.existingModel?.model || ''}` }) : null,
    modelDetected: cloud.diy === true && cloud.modelDetected === true,
    migration: cloud.migration || '', tokenedProfiles: cloud.tokenedProfiles || [],
    migrateCommand: cloud.migration === 'bring' && (prefs.vpsBrowser?.sshHost || '').trim() ? cloudMigrate.migrateCommand(prefs.vpsBrowser.sshHost.trim()) : '',
    telegramFallback: cloud.telegramFallback === true, botUsername: cloud.botUsername || '',
    existingBotId: cloud.diy === true ? cloud.existingBotId || '' : '',
    existingBotProfile: cloud.diy === true ? cloud.existingBotProfile || '' : '',
    computer, error: cloudError,
    supportUrl: session ? `${cloudClaim.apiBase()}/api/discord/start?session=${encodeURIComponent(session)}` : `${cloudClaim.apiBase()}/api/discord/start` };
}
// The wait step polls the cloud API; each answer lands in cloudComputer for
// cloudView and advances the stored step once pairing can start.
function startCloudPolling() {
  cloudPollAbort?.abort();
  const session = cloudSession();
  if (!session) return;
  cloudPollAbort = new AbortController();
  const signal = cloudPollAbort.signal;
  cloudStatus.pollComputer(cloudClaim.apiBase(), session, {
    signal,
    onUpdate(data) {
      cloudComputer = data;
      const cloud = prefs.cloud && typeof prefs.cloud === 'object' ? prefs.cloud : {};
      if (data.computer_name && cloud.computerName !== data.computer_name) cloud.computerName = data.computer_name;
      if (data.tailscale_url && cloud.tailscaleUrl !== data.tailscale_url) cloud.tailscaleUrl = data.tailscale_url;
      if (data.state === 'ready' && cloud.step === 'cloud-wait') cloud.step = 'connect';
      prefs.cloud = cloud;
      savePreferencesSoon();
      broadcast();
    },
  }).catch((error) => { if (!signal.aborted) { cloudError = error.message; broadcast(); } });
}
function startCloudOnboarding() {
  prefs.onboarded = false;
  activeTabId = 'home';
  startCloudPolling();
  showWindow();
  broadcast();
}
// The account's first name comes out of Telegram's own IndexedDB state, the
// same shape the preload polls, read directly when the wizard needs it.
async function telegramFirstName() {
  try {
    if (!telegramView || telegramView.webContents.isDestroyed()) return '';
    return await telegramView.webContents.executeJavaScript(`(async () => {
      const request = indexedDB.open('tt-data');
      const db = await new Promise((resolve) => { request.onsuccess = () => resolve(request.result); request.onerror = request.onupgradeneeded = () => resolve(null); });
      if (!db || !db.objectStoreNames.contains('store')) return '';
      const get = db.transaction('store', 'readonly').objectStore('store').get('tt-global-state');
      const state = await new Promise((resolve) => { get.onsuccess = () => resolve(get.result || null); get.onerror = () => resolve(null); });
      return String(state?.users?.byId?.[state?.currentUserId]?.firstName || '');
    })()`);
  } catch { return ''; }
}
// One env write + a gateway restart, shared by the API-key, model and bot-token
// steps. The value travels over ssh stdin so it never shows in a process list.
async function cloudWriteEnv(host, key, value, tokenedProfiles) {
  const profiles = await sshRun(host, 'ls ~/.hermes/profiles 2>/dev/null');
  const profile = key === 'TELEGRAM_BOT_TOKEN' ? cloudTelegram.untokenedProfile(profiles.out, tokenedProfiles) : cloudModel.chooseProfile(profiles.out);
  const envPath = cloudModel.envPathFor(profile);
  const current = await sshRun(host, cloudConnect.sshReadCommand(envPath));
  // A failed read (missing file, ssh error) means an empty base — never feed
  // error text into setEnvValue or the write would clobber the real .env.
  const write = await sshWrite(host, envPath, cloudModel.setEnvValue(current.code === 0 ? current.out : '', key, value));
  if (write.code !== 0) return { ok: false, detail: 'The computer refused the env file write.' };
  const status = await sshRun(host, 'supervisorctl status 2>/dev/null');
  await sshRun(host, cloudModel.gatewayRestartCommand(status.out), { timeoutMs: 30000 });
  return { ok: true, profile };
}
// Minted or pasted, a good bot token finishes the wizard the same way: write
// the env, open the bot chat and send /start so the pair meets.
async function cloudFinishTelegram(token, username) {
  if (!telegramView || telegramView.webContents.isDestroyed()) return { done: false, detail: 'Telegram is not loaded. Sign in and try again.' };
  const host = (prefs.vpsBrowser?.sshHost || '').trim();
  const write = await cloudWriteEnv(host, 'TELEGRAM_BOT_TOKEN', token, prefs.cloud?.tokenedProfiles);
  if (!write.ok) return { done: false, detail: write.detail };
  const send = await telegramView.webContents.executeJavaScript(cloudTelegram.sendMessageScript(username, '/start'))
    .catch(error => ({ ok: false, error: error.message }));
  if (send?.ok !== true) return { done: false, detail: send?.error || `Opening @${username} and sending /start did not complete. Try again.` };
  const cloud = prefs.cloud && typeof prefs.cloud === 'object' ? prefs.cloud : {};
  prefs.cloud = { ...cloud, botUsername: username, step: 'done' };
  prefs.onboarded = true;
  savePreferences();
  broadcast();
  return { done: true, username };
}
// Local and remote probes for the connect step. Both cap output so a chatty
// remote can never grow memory without bound.
function localRun(file, args, { timeoutMs = 10000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(file, args, { timeout: timeoutMs });
    let out = '', err = '';
    child.stdout.on('data', (chunk) => { out = (out + chunk).slice(-20000); });
    // stderr stays separate: a remote warning must not corrupt parsers that
    // read stdout (JSON state files, `cat`-ed env files, tailscale --json).
    child.stderr.on('data', (chunk) => { err = (err + chunk).slice(-20000); });
    child.on('error', (error) => resolve({ code: -1, out, err: err || String(error?.message || error) }));
    child.on('close', (code) => resolve({ code: code ?? -1, out, err }));
  });
}
// accept-new pins the first-seen host key without prompting (BatchMode cannot
// ask). The wizard assigns the ssh host itself, so =yes would fail every new
// peer with "Host key verification failed."
function sshRun(host, remote, { timeoutMs = 15000 } = {}) {
  return localRun('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=accept-new', host, posixCommand(remote)], { timeoutMs });
}
// Writes a whole file over stdin so the content never lands in the remote
// command line (keys would leak into ps otherwise). Leading ~ stays unquoted
// so it expands; the rest of the path is single-quoted against remote-side
// interpolation of profile names.
function sshWrite(host, remotePath, content, { timeoutMs = 15000 } = {}) {
  const p = String(remotePath);
  const target = p.startsWith('~/') ? `"$HOME"/${cloudMigrate.shellQuote(p.slice(2))}` : cloudMigrate.shellQuote(p);
  return new Promise((resolve) => {
    const child = spawn('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=accept-new', host, `cat > ${target}`], { timeout: timeoutMs });
    let out = '', err = '';
    child.stdout.on('data', (chunk) => { out = (out + chunk).slice(-20000); });
    child.stderr.on('data', (chunk) => { err = (err + chunk).slice(-20000); });
    child.stdin.on('error', () => {});
    child.on('error', () => resolve({ code: -1, out, err }));
    child.on('close', (code) => resolve({ code: code ?? -1, out, err }));
    child.stdin.end(content);
  });
}
// scripts/connect-mac.sh keeps its authorized_keys editor between "tailnet
// helpers" markers; read the real script (the packaged app carries it as an
// extra resource) so the wizard installs keys exactly the way the script does.
function connectMacHelpers() {
  const candidates = [path.join(ROOT, '..', '..', 'scripts', 'connect-mac.sh')];
  try { if (app.isPackaged) candidates.unshift(path.join(process.resourcesPath, 'connect-mac.sh')); } catch {}
  for (const file of candidates) {
    try {
      const block = cloudConnect.tailnetHelpers(fs.readFileSync(file, 'utf8'));
      if (block) return block;
    } catch {}
  }
  return '';
}
// The computer must ssh back into this machine for AGENT_PATH_OK: ensure it
// has a keypair, then authorize its public key here restricted to the tailnet.
// While there, fill in this machine's ssh address when it is derivable, so the
// path check can actually run in the claimed flow.
async function authorizeComputerKey(host) {
  if (process.platform === 'win32') return { ok: true };
  const pub = await sshRun(host, cloudConnect.ensureKeypairCommand());
  const key = pub.code === 0 ? cloudConnect.publicKeyLine(pub.out) : '';
  if (!key) return { ok: false, detail: 'The computer did not produce an SSH key to authorize here.' };
  const helpers = connectMacHelpers();
  if (!helpers) return { ok: false, detail: 'The connect helper script is missing, so the computer key cannot be authorized on this computer.' };
  const run = await localRun('sh', ['-c', cloudConnect.authorizeKeyCommand(helpers), 'sh', key]);
  if (run.code !== 0) return { ok: false, detail: 'Could not authorize the computer key on this computer.' };
  seedMacSshHost();
  savePreferencesSoon();
  return { ok: true };
}
// The saved VPS SSH path check, shared by Settings and the connect step.
function testAgentPath() {
  seedMacSshHost();
  const host = (prefs.vpsBrowser?.sshHost || '').trim();
  const mac = (prefs.macSshHost || '').trim();
  if (!host) throw new Error('Save a VPS browser SSH host first.');
  if (!isSshTarget(host)) throw new Error('The saved VPS SSH address is invalid. Re-enter it as user@host or host.');
  if (!mac) throw new Error(`Enter this ${HOST_LABEL === 'windows' ? 'PC' : 'computer'}’s SSH address as your VPS reaches it.`);
  if (!isSshTarget(mac)) throw new Error('The saved SSH address for this computer is invalid. Re-enter it as user@host or host.');
  return new Promise((resolve) => {
    const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=accept-new', host,
      `ssh -o BatchMode=yes -o ConnectTimeout=6 -o StrictHostKeyChecking=accept-new ${mac} 'echo AGENT_PATH_OK'`], { timeout: 30000 });
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
// The connector copy setup.sh left in userData when it is older than the app
// and the router can find this app's own connector to take its place.
function staleConnector() {
  const reachable = setupCheck.bundledConnectorReachable({ platform: process.platform, isPackaged: app.isPackaged, execPath: process.execPath, home: app.getPath('home') });
  return reachable ? setupCheck.staleConnectorCopy(app.getPath('userData'), app.getVersion()) : null;
}
// Check setup: local state, both SSH directions, then the server's read-only
// doctor report. Each part is independent; a failure becomes a finding.
async function runSetupCheck() {
  const serverHost = (prefs.vpsBrowser?.sshHost || '').trim();
  const computerHost = (prefs.macSshHost || '').trim();
  const mac = process.platform === 'darwin';
  const local = {
    telegram: telegramStatus,
    inApplications: mac && app.isPackaged ? setupCheck.inRouterApplications(process.execPath) : null,
    bundle: runningBundle(), productName: app.getName(),
    permissions: mac ? { accessibility: systemPreferences.isTrustedAccessibilityClient(false), screen: systemPreferences.getMediaAccessStatus('screen') } : null,
    staleConnector: staleConnector(),
  };
  const connection = { addresses: { server: serverHost, computer: computerHost }, reach: null, back: null };
  let server = null;
  if (serverHost && !isSshTarget(serverHost)) connection.reach = { ok: false, detail: 'The saved address is invalid. Re-enter it as user@host or host.' };
  else if (serverHost) {
    const probe = await sshRun(serverHost, 'echo CHECK_OK');
    connection.reach = probe.code === 0 && probe.out.includes('CHECK_OK')
      ? { ok: true, detail: '' }
      : { ok: false, detail: (probe.err || probe.out).trim().split('\n').pop() || `ssh exited ${probe.code}` };
    if (connection.reach.ok) {
      const [back, report] = await Promise.all([
        computerHost ? Promise.resolve().then(testAgentPath).catch((error) => ({ ok: false, detail: error.message })) : null,
        vmUpdater.doctorVm(vmTargets(prefs)[0]),
      ]);
      connection.back = back;
      server = report;
    }
  }
  const findings = setupCheck.buildFindings({ appVersion: app.getVersion(), hostTarget: stableHostTarget(app.getVersion(), '', prefs.versionCache), platform: process.platform, local, connection, server });
  lastSetupCheck = { at: new Date().toISOString(), findings, server };
  return findings;
}
// Every server-address save drops evidence from the previous machine.
function setServerConfig(config, target = prefs) {
  const changed = config.sshHost !== target.vpsBrowser?.sshHost;
  target.vpsBrowser = config;
  if (changed) {
    target.versionCache = {};
    if (target.cloud) {
      if (target !== prefs) target.cloud = { ...target.cloud };
      for (const field of ['botInventoryChecked', 'tokenedProfiles', 'profiles', 'existingBotId', 'existingBotProfile']) delete target.cloud[field];
    }
    if (target === prefs) setTimeout(checkVersionsWhenIdle, 0);
  }
  return changed;
}
// Keeping a DIY model never writes credentials or restarts a running gateway.
// Detection is best-effort; the manual choice also works with older Hermes CLIs.
async function cloudKeepServerModel(detect = true) {
  const host = (prefs.vpsBrowser?.sshHost || '').trim();
  if (prefs.cloud?.diy !== true) throw new Error('This option is only for your own server.');
  if (!host) throw new Error('Connect to the computer first.');
  const cloud = prefs.cloud, step = cloud.step;
  const current = () => prefs.cloud === cloud && cloud.step === step && (prefs.vpsBrowser?.sshHost || '').trim() === host;
  let existing = null;
  if (detect) {
    try { existing = cloudModel.parseExistingModel(await sshRun(host, cloudModel.existingModelCommand(), { timeoutMs: 8000 })); } catch {}
    if (!current()) return { done: false, cancelled: true, detail: '' };
    if (!cloud.botInventoryChecked) {
      const inventory = await cloudReadBotInventory(host);
      if (!current()) return { done: false, cancelled: true, detail: '' };
      Object.assign(cloud, inventory);
    }
    cloud.modelDetected = true;
    if (existing) cloud.existingModel = existing;
    else delete cloud.existingModel;
    savePreferences();
    return { done: false, existingModel: existing, detail: existing
      ? `Your server already uses ${existing.provider} · ${existing.model}.`
      : 'Could not detect a configured model. You can use the model already set on your server, or choose a new login below.' };
  } else {
    existing = cloudModel.parseExistingModel({ code: 0, out: `${cloud.existingModel?.provider || ''}\n${cloud.existingModel?.model || ''}` });
  }
  prefs.cloud.model = 'existing';
  if (existing) prefs.cloud.existingModel = existing;
  else delete prefs.cloud.existingModel;
  const next = nextCloudStep(prefs, 'model');
  setCloudStep(prefs, next);
  if (next === 'done') prefs.onboarded = true;
  savePreferences();
  const name = existing ? `: ${existing.provider} / ${existing.model}` : '';
  return { done: true, existingModel: existing, detail: `Using the model already set on your server${name}.` };
}
// Reuse migration's presence-only inventory: SSH returns paths and names,
// never bot tokens. Older DIY saves are inventoried when the model card opens.
async function cloudReadBotInventory(host) {
  try {
    const [tokens, profiles] = await Promise.all([
      sshRun(host, cloudMigrate.profilesWithTokenCommand(), { timeoutMs: 8000 }),
      sshRun(host, 'ls ~/.hermes/profiles 2>/dev/null', { timeoutMs: 8000 }),
    ]);
    return { tokenedProfiles: cloudMigrate.profilesWithToken(tokens.out),
      profiles: cloudMigrate.profileNames(profiles.out), botInventoryChecked: true };
  } catch { return {}; }
}
// The connect step advances as far as it can each click: CLI check, pairing
// status, the computer's own state file, then the saved return path check.
// {stage} tells the wizard which message to show; 'done' moves to migration
// for a hosted computer; DIY servers show model setup for explicit confirmation.
let cloudConnectPending = null;
function cloudConnectRun(diyHost) {
  const host = diyHost || (prefs.vpsBrowser?.sshHost || '').trim();
  if (cloudConnectPending?.host === host) return cloudConnectPending.promise;
  // A queued click from a removed card must not reset a later wizard step.
  const sameServer = !diyHost || diyHost === prefs.vpsBrowser?.sshHost;
  if (sameServer && ['model', 'telegram', 'bot-chat', 'done'].includes(prefs.cloud?.step)) {
    return Promise.resolve({ host, stage: 'done', ok: true, detail: 'Already connected.' });
  }
  const pending = { host };
  cloudConnectPending = pending;
  pending.promise = cloudConnectOnce(diyHost, pending).then(result => ({ ...result, host: pending.host })).finally(() => {
    if (cloudConnectPending === pending) cloudConnectPending = null;
  });
  return pending.promise;
}
async function cloudConnectOnce(diyHost, pending) {
  const cloud = { ...prefs.cloud };
  if (diyHost) {
    if (!isSshTarget(diyHost)) throw new Error('Enter the server SSH address as user@host or host, with no spaces or symbols.');
    cloud.diy = true;
    cloud.step = 'connect';
    prefs.cloud = cloud;
    setServerConfig({ ...(prefs.vpsBrowser || {}), sshHost: diyHost });
    savePreferences();
  }
  prefs.cloud = cloud;
  const step = cloud.step;
  let host = (prefs.vpsBrowser?.sshHost || '').trim();
  const current = () => cloudConnectPending === pending && prefs.cloud === cloud && cloud.step === step && (prefs.vpsBrowser?.sshHost || '').trim() === host;
  const cancelled = { stage: 'connect', ok: false, cancelled: true, detail: '' };
  if (cloud.diy === true) {
    const sshHost = host;
    if (!sshHost) return { stage: 'host', ok: false, detail: 'Enter the server SSH address first.' };
    const probe = await sshRun(sshHost, 'echo CONNECT_OK');
    if (!current()) return cancelled;
    if (probe.code !== 0 || !probe.out.includes('CONNECT_OK')) return { stage: 'ssh', ok: false, detail: `Could not reach ${sshHost} over SSH. Check the address and your key, then try again.` };
    const remote = cloudConnect.parseComputerState((await sshRun(sshHost, cloudConnect.sshReadCommand('/var/lib/alan/state.json'))).out);
    if (!current()) return cancelled;
    if (remote?.state === 'failed') return { stage: 'failed', ok: false, detail: remote.error || 'The setup on the server failed.' };
    const back = await authorizeComputerKey(sshHost);
    if (!current()) return cancelled;
    if (!back.ok) return { stage: 'path', ok: false, detail: back.detail };
    if ((prefs.macSshHost || '').trim()) {
      const path = await testAgentPath();
      if (!current()) return cancelled;
      if (!path.ok) return { stage: 'path', ok: false, detail: path.detail };
    }
    delete cloud.existingModel;
    delete cloud.modelDetected;
    delete cloud.modelOnly;
    delete cloud.botInventoryChecked;
    delete cloud.tokenedProfiles;
    delete cloud.profiles;
    delete cloud.existingBotId;
    delete cloud.existingBotProfile;
    const model = await cloudKeepServerModel();
    if (!current() || model.cancelled) return cancelled;
    if (cloud.model === 'existing') delete cloud.model;
    savePreferences();
    return { stage: 'done', ok: true, existingModel: model.existingModel, detail: `Connected to ${sshHost}. ${model.detail}` };
  }
  const cli = cloudConnect.tailscaleCli();
  if (!cli) return { stage: 'cli', ok: false, detail: 'Tailscale is not installed on this computer. Install it, then check again.' };
  const url = cloud.tailscaleUrl || cloudComputer?.tailscale_url || '';
  if (url && !cloud.pairingOpened) { shell.openExternal(url).catch(() => {}); cloud.pairingOpened = true; prefs.cloud = cloud; savePreferencesSoon(); }
  const status = await localRun(...cloudConnect.pairPollCommand(cli));
  if (!current()) return cancelled;
  const name = cloud.computerName || cloudComputer?.computer_name || '';
  const peer = status.code === 0 ? cloudConnect.findPeer(status.out, name) : null;
  if (!peer) return { stage: 'pairing', ok: false, detail: url ? 'Waiting for the computer to join your tailnet. Finish the pairing page, then check again.' : 'Waiting for the computer to join your tailnet…' };
  const sshHost = `root@${peer.ip}`;
  if (setServerConfig({ ...(prefs.vpsBrowser || {}), sshHost })) savePreferences();
  pending.host = host = sshHost;
  const remote = cloudConnect.parseComputerState((await sshRun(sshHost, cloudConnect.sshReadCommand('/var/lib/alan/state.json'))).out);
  if (!current()) return cancelled;
  if (!remote) return { stage: 'state', ok: false, detail: 'The computer joined Tailscale. Waiting for its setup to finish…' };
  if (remote.state === 'failed') return { stage: 'failed', ok: false, detail: remote.error || 'The setup on the computer failed.' };
  if (remote.state !== 'ready' && remote.step !== 'paired') return { stage: 'state', ok: false, detail: 'The computer is still finishing its setup…' };
  const back = await authorizeComputerKey(sshHost);
  if (!current()) return cancelled;
  if (!back.ok) return { stage: 'path', ok: false, detail: back.detail };
  if ((prefs.macSshHost || '').trim()) {
    const path = await testAgentPath();
    if (!current()) return cancelled;
    if (!path.ok) return { stage: 'path', ok: false, detail: path.detail };
  }
  setCloudStep(prefs, 'migrate');
  savePreferences();
  return { stage: 'done', ok: true, detail: `Connected to ${name || peer.hostName} at ${sshHost}.` };
}
async function claimWithToken(token) {
  if (!token) return;
  // A stored session means this token (or an earlier one) already claimed the
  // computer: resume the wizard, or ignore a stale link once setup is done.
  if (cloudSession()) { if (prefs.cloud?.step !== 'done') startCloudOnboarding(); return; }
  try {
    // Encryption is checked before the POST: the token is single-use, so a
    // machine that cannot store the session must fail before consuming it.
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure storage is unavailable on this computer.');
    const installId = cloudClaim.ensureInstallId(prefs);
    savePreferencesSoon();
    const result = await cloudClaim.claim(cloudClaim.apiBase(), token, installId);
    const cloud = prefs.cloud && typeof prefs.cloud === 'object' ? prefs.cloud : {};
    prefs.cloud = { ...cloud, sessionEnc: safeStorage.encryptString(result.session).toString('base64'), sessionExpiresAt: result.expiresAt, step: 'cloud-wait' };
    cloudError = '';
    savePreferences();
    buildMenu();
    startCloudOnboarding();
  } catch (error) { cloudError = error.message; startCloudOnboarding(); }
}
function registerIpc() {
  ipcMain.handle('workspace:pdf-drop', (event, files) => {
    const source = event.sender;
    if (event.senderFrame !== source.mainFrame) throw new Error('PDFs must be dropped onto the main page.');
    const tab = [...tabs.values()].find(t => t.view.webContents === source || t.view.webContents === source.hostWebContents);
    const shellView = source === win?.webContents || source === telegramView?.webContents || source === remoteView?.webContents;
    if ((!tab && !shellView) || (tab && (tab.controller !== 'human' || agentInput.isDispatching(tab)))) throw new Error('Only human drops can open a PDF.');
    if (Array.isArray(files)) for (const file of files.slice(0, 40)) receivePdf(file);
  });
  ipcMain.handle('workspace:get', (event) => { trustSender(event); return getState(); });
  // Native Hermes chat bridge — the allowlisted command names are enforced by
  // the hub; secrets (passwords, tokens) may arrive but are never returned
  // through state or logged.
  ipcMain.handle('hermes:get', (event) => { trustSender(event); return hermesHub.getState(); });
  ipcMain.handle('hermes:command', async (event, name, value) => {
    trustSender(event);
    try {
      const result = await hermesHub.command(name, value);
      if (['select', 'new-session'].includes(name) && result?.ok !== false) { chatTarget = 'hermes'; broadcast(); }
      return result;
    } catch (error) { logError(`hermes ${String(name).slice(0, 40)}`, error); throw error; }
  });
  ipcMain.on('workspace:layout', (event, value) => {
    try {
      trustSender(event);
      const next = value || {};
      // A DOM overlay (settings, the update popup) shows while the attached
      // views hide. Keys must move to the page too, or Escape and typing keep
      // landing in a view nobody can see. Restore the visible view on close.
      const wasObscured = !!layout.obscured;
      if (next.obscured && !wasObscured) {
        const focused = webContents.getFocusedWebContents();
        obscuredFocus = focused === telegramView?.webContents || focused === tabs.get(activeTabId)?.view.webContents ? focused : null;
        win.webContents.focus();
      }
      layout = next;
      applyLayout();
      if (!next.obscured && wasObscured) {
        const target = obscuredFocus;
        obscuredFocus = null;
        if (target && !target.isDestroyed() && (target === telegramView?.webContents || target === tabs.get(activeTabId)?.view.webContents)) target.focus();
      }
    } catch {}
  });
  const runCommand = async (event, command, value = {}) => {
    trustSender(event);
    try { return await executeCommand(command, value, event); }
    finally { broadcastNow(); }
  };
  // Publish after every command settles, including early returns and failures.
  const executeCommand = async (command, value, event) => {
    switch (command) {
      case 'settings-write-status': return settingsWriteReceipt(settingsWriteEntry(event, value, true));
      case 'create-tab': return describeTab(createTab({ url: value.url || 'about:blank' }));
      case 'close-tab':
        if (isVpsTarget(value.id, value.host)) { if(activeTabId===value.id)prefs.remoteControl=false; await vpsBrowser.request(`/v1/tabs/${value.id}`,'DELETE',undefined,{human:true}); vpsTabs.delete(value.id); if(activeTabId===value.id)activeTabId='home'; applyLayout(); } else closeTab(value.id); break;
      case 'activate': await activateTab(value.id, value.host); break;
      case 'toggle-vps-view': {
        if(activeTabId==='vps')activeTabId=tabs.has(browserReturnTabId)?browserReturnTabId:'home';
        else {
          browserReturnTabId=activeTabId;activeTabId='vps';
          if (!vpsTabs.has(activeVpsTabId)) {
            const waiting = [...vpsTabs.values()].find(tab => tab.handback?.state === 'awaiting_human');
            if (waiting) await activateTab(waiting.id, 'vps');
          }
        }
        prefs.remoteControl=false;applyLayout();break;
      }
      case 'navigate': {
        if (isVpsTab(value.id)) { await navigateVps(value.id,value.url); break; }
        const tab = tabs.get(value.id); if (tab) { changeController(tab.id, 'human'); const target = pageUrl(value.url); tab.requestedUrl = target; await tab.view.webContents.loadURL(target).catch(() => {}); } break;
      }
      case 'history': {
        if (isVpsTab(value.id)) { await remoteRequest(value.id,'control',{controller:'human'}); await remoteRequest(value.id,'human-actions',{action:value.action}); break; }
        const tab = tabs.get(value.id); if (!tab) break;
        changeController(tab.id, 'human'); const history = tab.view.webContents.navigationHistory;
        if (value.action === 'back' && history.canGoBack()) history.goBack();
        if (value.action === 'forward' && history.canGoForward()) history.goForward();
        if (value.action === 'reload') await reloadBrowserPage(tab);
        break;
      }
      case 'control': {
        if(isVpsTarget(value.id, value.host)){if(value.controller==='agent')prefs.remoteControl=false;return remoteRequest(value.id,'control',{controller:value.controller,...(value.giveBack === true ? { giveBack: true, epoch: value.epoch } : {})});}
        const tab = tabs.get(value.id);
        if (tab && value.giveBack === true && (value.controller !== 'agent' || tab.controller !== 'human' || liveHandback(tab)?.state !== 'awaiting_human' || value.epoch !== tab.epoch)) return { ...describeTab(tab), ...(value.epoch !== tab.epoch && tab.controller === 'human' && liveHandback(tab)?.state === 'awaiting_human' ? { refused: 'stale' } : {}) };
        // Give to agent also ends a Take back cooldown.
        if (tab && value.controller === 'agent') { tab.handoff = reviewedHandoff(tab.handoff); tab.tookBackUntil = 0; }
        if (tab && value.controller !== 'agent') tab.lastHumanInput = Date.now();
        // Take back on the takeover notice keeps bots off the tab for a minute,
        // and its epoch bump voids any takeover still waiting out the grace.
        if (tab && value.takeBack === true) tab.tookBackUntil = Date.now() + TAKE_BACK_MS;
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
        if (tab.localPdf) throw new Error('Local PDF tabs stay under your control.');
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
      case 'record-start': await startRecording(String(value.id)); break;
      case 'record-stop': return stopRecording({ save: value.save !== false, keepTyped: value.keepTyped === true });
      case 'recording-share': recordings.share(String(value.id), value.botIds); broadcast(); break;
      case 'recording-delete': recordings.remove(String(value.id)); broadcast(); break;
      case 'open-bot': await openBot(String(value.id)); break;
      case 'show-telegram': chatTarget = 'telegram'; broadcast(); break;
      case 'show-hermes': chatTarget = 'hermes'; broadcast(); break;
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
      case 'settings': {
        // Stage this explicit choice until the actual private-file write succeeds.
        // Failed choices must not leak into broadcasts or later automatic saves.
        const next = { ...prefs };
        let followed = '', vpsChanged = false;
        if (typeof value.macSshHost === 'string' && value.macSshHost.trim() && !isSshTarget(value.macSshHost.trim())) throw new Error('Enter the Mac SSH address as user@host or host, with no spaces or symbols.');
        if (value.vpsBrowser && typeof value.vpsBrowser === 'object') {
          const sshHost = String(value.vpsBrowser.sshHost || '').trim();
          if (sshHost && !isSshTarget(sshHost)) throw new Error('Enter the VPS SSH address as user@host or host, with no spaces or symbols.');
          const scriptPath = String(value.vpsBrowser.scriptPath || '').trim();
          if (scriptPath && checkScriptPath(scriptPath)) throw new Error(checkScriptPath(scriptPath));
          // When the VM's SSH address moves to a different host, the noVNC
          // viewer follows unless remoteUrl was deliberately pointed elsewhere.
          followed = followVmRemoteUrl(next.vpsBrowser.sshHost, sshHost, next.remoteUrl);
          vpsChanged = setServerConfig({sshHost,scriptPath,sudo:value.vpsBrowser.sudo===true}, next); if(!sshHost)next.vmUpdates={};
          if (followed) { next.remoteUrl = followed; next.remoteControl = false; }
        }
        if (Number.isFinite(value.agentIdleMinutes)) next.agentIdleMinutes = Math.max(1, Math.min(240, value.agentIdleMinutes));
        if (typeof value.remoteUrl === 'string') { parseRemoteUrl(value.remoteUrl); next.remoteUrl = value.remoteUrl; next.remoteControl = false; }
        if (value.remotePlatform !== undefined) next.remotePlatform = value.remotePlatform === 'mac' ? 'mac' : 'linux';
        if (typeof value.preview === 'boolean') next.preview = value.preview;
        if (typeof value.showBots === 'boolean') next.showBots = value.showBots;
        if (typeof value.showBrowser === 'boolean') next.showBrowser = value.showBrowser;
        if (typeof value.macSshHost === 'string') next.macSshHost = value.macSshHost.trim();
        if (typeof value.autoOpenLinks === 'boolean') next.autoOpenLinks = value.autoOpenLinks;
        if (typeof value.autoTakeover === 'boolean') next.autoTakeover = value.autoTakeover;
        if (typeof value.primaryBotId === 'string') next.primaryBotId = next.bots.some((bot) => bot.id === value.primaryBotId) || value.primaryBotId === '' ? value.primaryBotId : next.primaryBotId;
        if (['ask', 'block', 'approximate'].includes(value.locationDefault)) next.locationDefault = value.locationDefault;
        if (Number.isFinite(value.chatWidth)) next.chatWidth = Math.max(320, Math.min(680, value.chatWidth));
        for (const field of Object.keys(settingsFieldRevisions)) {
          if (Object.hasOwn(value, field) || (field === 'remoteUrl' && value.vpsBrowser && typeof value.vpsBrowser === 'object')) settingsFieldRevisions[field]++;
        }
        persistSettingsPreferences(next);
        if (vpsChanged) setTimeout(checkVersionsWhenIdle, 0);
        if (value.vpsBrowser && typeof value.vpsBrowser === 'object') { vpsBrowserStatus = 'connecting'; refreshVpsTabs(); }
        if (followed || typeof value.remoteUrl === 'string') remoteStatus = 'disconnected';
        applyLayout(); break;
      }
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
        // Retain the old IPC name for older callers, but never copy an installer.
        const botId = String(value?.botId ?? prefs.selectedBotId ?? '');
        const bot = prefs.bots.find(item => item.id === botId);
        if (!bot) throw new Error('Choose an available bot, then copy its setup review notes again.');
        const fact = text => String(text || '').replace(/[\r\n]/g, ' ').trim();
        clipboard.writeText([
          "Alan's Workspace setup review notes: not shell commands.",
          'Read these notes; do not paste them into a terminal. Copy setup prompt in Connections to begin guided setup in this bot’s Hermes chat.',
          `Bot: ${fact(bot.name)}${bot.username ? ` (@${fact(bot.username)})` : ''}; BOT_ID=${botId}`,
          `Computer OS: ${HOST_LABEL}; installed app version: ${app.getVersion()}`,
          `Timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
          `MAC_SSH=${fact(prefs.macSshHost) || 'not saved'}`,
          `AGENT_SSH=${fact(prefs.vpsBrowser?.sshHost) || 'not saved'}`,
          'Saved addresses are context, not proof of connectivity. Confirm this bot’s conversation-owning Hermes profile before setup; do not reuse another bot’s profile or route.',
          '',
          'Review with the agent before running anything:',
          '1. Preserve Hermes and any existing alans-way install. If absent, use Hermes’ reviewed catalog; if unavailable or security scanning blocks it, stop and report the findings. Obtain explicit approval for any documented one-install scan override.',
          '2. Load that profile’s installed workspace-setup skill. It owns the procedure and reviewed plugin and desktop pins. If the installed skill is missing or cannot resolve a pin, stop and report it; never substitute a repository tip, branch/main script, or reconstructed procedure. Keep its pin and skip-plugin flags, and use pinned connectors with skip-install to preserve the installed app.',
          '3. Ask each preference separately. Give short numbered human steps for Telegram QR, Tailscale sign-in, SSH, public key outputs and local permissions as needed; wait for replies. Silence is not consent. Never request or disclose secrets. Keep SSH host-key checking enabled.',
          '4. Review the proposed installation, trust/configuration changes and gateway pause with its owner first. Keep the gateway restart last through its real owner; agree when to send the next message and resume its audit then. Copying these notes performs none of those actions.',
          '5. Report exact installed revisions and resolved pins, app version, checks, warnings and unfinished steps. Enter verified addresses in Connections, Save addresses, then Check saved path (SSH only). Follow the agent’s browser task to verify Hermes access.',
        ].join('\n'));
        break;
      }
      case 'agent-prompt': {
        const botId = String(value?.botId || prefs.selectedBotId || '').replace(/[^0-9A-Za-z_-]/g, '');
        seedMacSshHost();
        const text = buildAgentPrompt({ kind: value?.kind === 'update' ? 'update' : 'setup', hostLabel: HOST_LABEL, version: app.getVersion(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, botId, sshHost: (prefs.macSshHost || '').trim() });
        if (value?.copy !== false) clipboard.writeText(text);
        return text;
      }
      case 'server-setup': {
        if (updateLocked({ updateBusy: update.busy, vmRetrying, hermesUpdating, updatingAll }))
          return { ok: false, detail: 'Wait for the current server operation to finish.' };
        const target = vmTargets(prefs)[0];
        if (!target) return { ok: false, detail: 'Save the agent machine SSH address first.' };
        if (/^[A-Za-z]:/.test(target.scriptPath || ''))
          return { ok: false, detail: 'This step needs a POSIX SSH shell. On a Windows server, run the pinned setup in an external Git Bash shell.' };
        hermesUpdating = true;
        try {
          await waitForVersionCheck();
          return await serverSetup(target.sshHost, value?.plan);
        } finally { hermesUpdating = false; }
      }
      case 'test-agent-path': return testAgentPath();
      case 'setup-check': return runSetupCheck();
      case 'remove-old-connector': {
        // The renderer toasts on a truthy reply, so return whether a copy was
        // actually there to remove (other commands fall through to getState()).
        const stale = staleConnector();
        if (stale) fs.rmSync(stale, { recursive: true, force: true });
        return Boolean(stale);
      }
      case 'copy-report': {
        const errorLog = mainLog().tail(100);
        clipboard.writeText(setupCheck.buildReport({
          app: { version: app.getVersion(), platform: process.platform, arch: process.arch, osVersion: process.getSystemVersion(),
            signed: process.platform === 'darwin' && macUpdate.isDeveloperIdSigned(path.resolve(process.execPath, '../../..')) },
          serverAddress: prefs.vpsBrowser?.sshHost || '', computerAddress: prefs.macSshHost || '',
          findings: lastSetupCheck?.findings, checkedAt: lastSetupCheck?.at, server: lastSetupCheck?.server, errorLog }));
        break;
      }
      case 'open-support': shell.openExternal('https://discord.gg/jBQCPUsVE'); break;
      case 'show-data': shell.openPath(app.getPath('userData')); break;
      case 'mac-permissions': return process.platform === 'darwin' ? { accessibility: systemPreferences.isTrustedAccessibilityClient(false), screen: systemPreferences.getMediaAccessStatus('screen') } : null;
      case 'open-mac-privacy': if (process.platform === 'darwin') shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${value.pane === 'screen' ? 'Privacy_ScreenCapture' : 'Privacy_Accessibility'}`); break;
      case 'update-now': {
        if (updateLocked({ updateBusy: update.busy, vmRetrying, hermesUpdating, updatingAll })) break;
        const autoUpdate = updateDriver === 'electron-updater';
        const tag = autoUpdate ? `v${update.available}` : update.tag;
        if (autoUpdate ? !update.ready : !tag) break;
        update.busy = true; update.error = ''; broadcast();
        const targets = vmTargets(prefs);
        for (const target of targets) vmProgress[target.id] = { state: 'updating' };
        if (targets.length) broadcast();
        // Every saved VM first, then this app. A VM failure or timeout is
        // recorded for the retry banner and never blocks the app update.
        try {
          await waitForVersionCheck();
          mainLog().write('vm update', `start ${tag} for ${targets.map((t) => t.id).join(',') || 'no targets'}`);
          for (const result of await vmUpdater.updateAll(tag, targets, noteVmProgress)) {
            mainLog().write('vm update', `${result.id} ${result.ok ? `ok ${result.version || ''}` : `failed ${result.error || ''}`}`.trim());
            vmProgress[result.id] = vmProgressResult(result);
            noteVmResult(result); broadcast();
          }
          savePreferences();
          await restartIntoUpdate();
        }
        catch (error) { update.busy = false; update.error = error.message; broadcast(); throw error; }
        break;
      }
      case 'update-later': prefs.updateSnoozedUntil = snoozeUntil(Date.now()); savePreferences(); broadcast(); break;
      case 'vm-update-retry': {
        if (updateLocked({ updateBusy: update.busy, vmRetrying, hermesUpdating, updatingAll })) break;
        vmRetrying = true; broadcast();
        try {
          await waitForVersionCheck();
          const version = stableHostTarget(app.getVersion(), stagedAppVersion(), prefs.versionCache);
          if (!version) throw new Error('Check component versions first to find the latest stable browser host release.');
          const tag = `v${version}`;
          for (const target of vmTargets(prefs)) {
            const entry = prefs.vmUpdates?.[target.id] || {};
            if (!value.force && !entry.failed && !(entry.version && macUpdate.isNewer(version, entry.version))) continue;
            vmProgress[target.id] = { state: 'updating' }; broadcast();
            const result = await vmUpdater.updateVm(target, tag, noteVmProgress);
            vmProgress[target.id] = vmProgressResult(result);
            noteVmResult(result); broadcast();
          }
          savePreferences();
        } finally { vmRetrying = false; broadcast(); }
        break;
      }
      // Settings → Update Hermes: `hermes update` on the agent machine, then
      // each profile's bot messages the user from its own chat. Never runs
      // alongside the app's own VM update, which touches the same machine.
      case 'hermes-update': {
        if (updateLocked({ updateBusy: update.busy, vmRetrying, hermesUpdating, updatingAll })) break;
        const target = vmTargets(prefs)[0];
        if (!target) throw new Error('Save the agent machine SSH address first.');
        hermesUpdating = true;
        try {
          await waitForVersionCheck();
          const result = await vmUpdater.hermesUpdateVm(target);
          return { ok: result.ok, detail: hermesUpdateDetail(result, target.label) };
        } finally { hermesUpdating = false; }
      }
      case 'versions-refresh': checkVersionsWhenIdle(); checkAppVersions(); break;
      // The bottom bar's "Update everything", sent only after the user
      // confirmed the plan in the popover. Server first (Hermes, then the
      // plugin that must match it), then the browser host, then this app,
      // which only stages: the restart waits for "Restart to finish". Then
      // the versions refresh. A staged app's report waits until the next launch.
      case 'update-all': {
        if (updateLocked({ updateBusy: update.busy, vmRetrying, hermesUpdating, updatingAll })) return { refused: 'Another update is already running. Try again when it finishes.' };
        const { steps, upToDate } = describeVersions({ app: app.getVersion(), appUpdate: stagedAppVersion(), appLatest, cache: prefs.versionCache });
        if (!steps.length) return { refused: upToDate ? 'Everything is already up to date.' : 'No verified updates are ready. Check component versions first.' };
        const target = vmTargets(prefs)[0] || LOCAL_TARGET;
        updatingAll = true; updateRun = { steps: [], summary: '', restart: false }; holdAppInstall(true); broadcast();
        try {
          await pendingUpdateDelivery;
          // A probe already in flight finishes first: its `hermes update
          // --check` fetches into the checkout `hermes update` moves.
          await waitForVersionCheck();
          mainLog().write('update all', `start ${steps.map((step) => `${step.id} ${step.from}->${step.to}`).join(', ')}`);
          const rows = await runSteps(steps, (step) => runUpdateStep(step, target), (next) => { updateRun.steps = next; broadcast(); });
          mainLog().write('update all', runLogText(rows));
          const appStep = rows.find(row => row.id === 'app' && row.state === 'done');
          if (appStep) {
            prefs.pendingUpdateReport = { runId: crypto.randomUUID(), targetVersion: appStep.to, target: { ...target }, rows, attempts: 0 };
            saveUpdateReport();
          }
          // Wait out any probe that started before the run, then take a fresh one.
          await waitForVersionCheck();
          await checkVmVersions().catch((error) => logError('vm-check', error));
          const where = target.local ? 'this computer' : 'server';
          updateRun = { steps: rows, restart: rows.some((row) => row.id === 'app' && row.state === 'done'),
            summary: summarizeRun(rows, { gatewayRunning: prefs.versionCache?.gatewayRunning ?? null, where }) };
          broadcast();
          if (appStep) {
            updateRun.summary += ' Your bot will report the result when the app starts again.';
          } else if (prefs.versionCache?.hermes) {
            const sent = await vmUpdater.hermesUpdateVm(target, { report: reportText(rows) });
            const delivery = reportDeliveryText(sent);
            mainLog().write('update report', delivery);
            updateRun = { ...updateRun, summary: `${updateRun.summary} ${delivery}` };
          }
        } catch (error) {
          // The dialog shows why the run stopped instead of an empty summary.
          updateRun = { ...updateRun, summary: `Update everything stopped: ${setupCheck.redactReport(error.message)}` };
          throw error;
        } finally { updatingAll = false; holdAppInstall(false); broadcast(); }
        break;
      }
      case 'update-all-restart': {
        if (updateLocked({ updateBusy: update.busy, vmRetrying, hermesUpdating, updatingAll }) || !updateRun.restart) break;
        // Restarting cuts off any bot mid-task in a tab here; ask first.
        const warning = restartWarning(Object.keys(computeBotWork()).map((id) => nameForBot(id) || 'An agent'));
        if (warning && (await dialog.showMessageBox(win, { type: 'warning', buttons: ['Wait', 'Restart anyway'], defaultId: 0, cancelId: 0, ...warning })).response !== 1) break;
        update.busy = true; broadcast();
        try { await restartIntoUpdate(); }
        catch (error) { update.busy = false; update.error = error.message; broadcast(); throw error; }
        break;
      }
      case 'open-download-page': shell.openExternal(`https://openalan.com/download/${HOST_LABEL === 'windows' ? 'windows' : 'mac'}`); break;
      case 'open-release-notes': shell.openExternal(`https://github.com/capthvnsen/alans-way/releases/tag/v${app.getVersion()}`); break;
      case 'dismiss-bundle-warning': bundleWarningDismissed = true; broadcast(); break;
      case 'dismiss-updated': update.justUpdatedFrom = ''; break;
      case 'onboarding-done': prefs.onboarded = true; savePreferences(); break;
      case 'onboarding-open': {
        const cloud = prefs.cloud;
        // Revisit the hosted migration choice without repeating provisioning
        // or offering migration to a server that already runs Hermes.
        if (cloud?.sessionEnc && cloud.diy !== true && ['migrate', 'model', 'telegram', 'done'].includes(cloud.step)) {
          // Completed setups revisit only this choice. Replaying model/bot
          // setup could replace a working token, including on older saves
          // that never recorded tokenedProfiles after creating their bot.
          if (cloud.step === 'done') cloud.migrationOnly = true;
          cloud.step = 'migrate';
          delete cloud.migration;
        }
        if (cloud?.diy === true && ['model', 'telegram', 'bot-chat', 'done'].includes(cloud.step)) {
          // Revisit model choice after a failed first reply without replacing
          // the bot on a completed server, including older saved setups.
          if (cloud.step === 'done') cloud.modelOnly = true;
          cloud.step = 'model';
          delete cloud.modelDetected;
        }
        prefs.onboarded = false; prefs.remoteControl = false; activeTabId = 'home';
        seedMacSshHost(); savePreferences(); applyLayout(); break;
      }
      case 'cloud-claim-code': {
        const token = cloudClaim.claimToken(value.code);
        if (!token) throw new Error('That does not look like a claim code or claim link.');
        await claimWithToken(token);
        if (cloudError) throw new Error(cloudError);
        break;
      }
      case 'cloud-goto': {
        if (value.step === 'bot-chat') {
          const cloud = prefs.cloud, step = cloud?.step;
          if (cloud?.diy !== true) throw new Error('This option is only for your own server.');
          if (!cloud.botInventoryChecked) {
            const host = (prefs.vpsBrowser?.sshHost || '').trim();
            const inventory = await cloudReadBotInventory(host);
            if (prefs.cloud !== cloud || cloud.step !== step || (prefs.vpsBrowser?.sshHost || '').trim() !== host) return getState();
            Object.assign(cloud, inventory);
          }
        }
        if (value.step === 'done' && prefs.cloud) { prefs.cloud.step = 'done'; prefs.onboarded = true; savePreferences(); break; }
        const from = prefs.cloud?.step;
        if (!setCloudStep(prefs, String(value.step || ''))) throw new Error('Unknown setup step.');
        // Connect has just read the server's model, so only a later return to the model step re-reads it.
        if (prefs.cloud.diy === true && value.step === 'model' && from !== 'connect') delete prefs.cloud.modelDetected;
        savePreferences(); break;
      }
      case 'cloud-next': {
        const next = nextCloudStep(prefs, prefs.cloud?.step);
        if (next === 'done') { prefs.cloud.step = 'done'; prefs.onboarded = true; }
        else setCloudStep(prefs, next);
        savePreferences(); break;
      }
      case 'cloud-connect': return cloudConnectRun(String(value.host || '').trim());
      case 'cloud-open-pairing': {
        const url = prefs.cloud?.tailscaleUrl || cloudComputer?.tailscale_url || '';
        if (url) await shell.openExternal(url);
        break;
      }
      case 'cloud-tailscale-download': await shell.openExternal('https://tailscale.com/download'); break;
      case 'cloud-diy': {
        const cloud = prefs.cloud && typeof prefs.cloud === 'object' ? prefs.cloud : {};
        if (value.off === true) {
          // Back out of the DIY connect card: leave cloud mode entirely so the
          // normal wizard shows again.
          prefs.cloud = { ...cloud, diy: false };
          savePreferences();
          broadcast();
          break;
        }
        prefs.cloud = { ...cloud, diy: true, step: 'connect' };
        prefs.onboarded = false;
        savePreferences();
        startCloudOnboarding();
        break;
      }
      case 'cloud-migrate': {
        if (value.choice !== 'bring') {
          delete prefs.cloud.migration;
          setCloudStep(prefs, nextCloudStep(prefs, 'migrate'));
          if (nextCloudStep(prefs, 'migrate') === 'done') { prefs.cloud.step = 'done'; prefs.onboarded = true; }
          savePreferences(); break;
        }
        const host = (prefs.vpsBrowser?.sshHost || '').trim();
        if (!host) throw new Error('Connect to the computer first.');
        const cloud = prefs.cloud && typeof prefs.cloud === 'object' ? prefs.cloud : {};
        prefs.cloud = { ...cloud, migration: 'bring' };
        savePreferences();
        return { command: cloudMigrate.migrateCommand(host) };
      }
      case 'cloud-migrate-copy': {
        const host = (prefs.vpsBrowser?.sshHost || '').trim();
        if (!host) throw new Error('Connect to the computer first.');
        clipboard.writeText(cloudMigrate.migrateCommand(host));
        break;
      }
      case 'cloud-migrate-local': {
        const host = (prefs.vpsBrowser?.sshHost || '').trim();
        if (!host) throw new Error('Connect to the computer first.');
        return new Promise((resolve) => {
          // The migrate script runs in a hidden shell; each chunk is relayed to
          // the wizard log so the run is visible without a terminal.
          const child = spawn('bash', ['-lc', cloudMigrate.migrateCommand(host)]);
          let out = '';
          const feed = (chunk) => {
            out = (out + chunk).slice(-60000);
            try { if (win && !win.isDestroyed()) win.webContents.send('workspace:cloud-log', String(chunk)); } catch {}
          };
          child.stdout.on('data', feed);
          child.stderr.on('data', feed);
          child.on('error', () => resolve({ done: false, detail: 'Could not start the local migrate run.' }));
          child.on('close', (code) => resolve({ done: code === 0, detail: code === 0 ? 'The local migrate run finished.' : `The migrate run exited with ${code}.` }));
        });
      }
      case 'cloud-migrate-check': {
        const host = (prefs.vpsBrowser?.sshHost || '').trim();
        if (!host) throw new Error('Connect to the computer first.');
        const marker = await sshRun(host, cloudMigrate.migrateCheckCommand());
        // ls exits non-zero when one glob has no match even while printing the
        // other — the stdout content alone carries the signal.
        if (!marker.out.trim()) return { done: false, detail: 'No migration has landed on the computer yet.' };
        const grep = await sshRun(host, cloudMigrate.profilesWithTokenCommand());
        const profiles = await sshRun(host, 'ls ~/.hermes/profiles 2>/dev/null');
        const cloud = prefs.cloud && typeof prefs.cloud === 'object' ? prefs.cloud : {};
        prefs.cloud = { ...cloud, profiles: cloudMigrate.profileNames(profiles.out), tokenedProfiles: cloudMigrate.profilesWithToken(grep.out) };
        const next = nextCloudStep(prefs, 'migrate');
        setCloudStep(prefs, next);
        if (next === 'done') prefs.onboarded = true;
        savePreferences();
        return {
          done: true,
          profiles: cloudMigrate.namedTokenedProfiles(prefs.cloud.tokenedProfiles),
          sharedToken: prefs.cloud.tokenedProfiles.includes(cloudMigrate.SHARED_TOKEN),
        };
      }
      case 'cloud-model-detect':
      case 'cloud-model-existing': {
        if (prefs.cloud?.step !== 'model') throw new Error('Open the model setup step first.');
        const result = await cloudKeepServerModel(command === 'cloud-model-detect');
        return result;
      }
      case 'cloud-existing-bot': {
        const cloud = prefs.cloud;
        if (cloud?.diy !== true || cloud.step !== 'bot-chat') throw new Error('Open your existing bot setup first.');
        const profile = String(value.profile || '');
        const profiles = cloud.tokenedProfiles || [];
        if (profiles.length && !profiles.includes(profile)) throw new Error('Choose the profile whose bot you want to use.');
        const username = String(value.username || '').replace(/^@/, '');
        if (!/^[A-Za-z][\w]{3,31}$/.test(username)) throw new Error('Enter your Telegram bot username.');
        await openTelegramUsername(username);
        if (prefs.cloud !== cloud || cloud.step !== 'bot-chat') return { ok: false };
        cloud.existingBotId = prefs.selectedBotId;
        cloud.existingBotProfile = profile;
        savePreferences();
        return { ok: true };
      }
      case 'cloud-model': {
        const host = (prefs.vpsBrowser?.sshHost || '').trim();
        if (!host) throw new Error('Connect to the computer first.');
        const key = String(value.key || '').trim();
        if (!/^sk-[\w-]{10,}$/.test(key)) throw new Error('Paste the Anthropic API key (it starts with sk-).');
        const profile = cloudModel.chooseProfile((await sshRun(host, 'ls ~/.hermes/profiles 2>/dev/null')).out);
        const envPath = cloudModel.envPathFor(profile);
        const current = await sshRun(host, cloudConnect.sshReadCommand(envPath));
        const write = await sshWrite(host, envPath, cloudModel.setEnvValue(current.code === 0 ? current.out : '', 'ANTHROPIC_API_KEY', key));
        if (write.code !== 0) return { done: false, detail: 'The key could not be written on the computer.' };
        const status = await sshRun(host, 'supervisorctl status 2>/dev/null');
        await sshRun(host, cloudModel.gatewayRestartCommand(status.out), { timeoutMs: 30000 });
        prefs.cloud = { ...(prefs.cloud || {}), model: 'apikey' };
        const next = nextCloudStep(prefs, 'model');
        if (next === 'done') { prefs.cloud.step = 'done'; prefs.onboarded = true; } else setCloudStep(prefs, next);
        savePreferences();
        return { done: true, detail: 'API key saved and the gateway restarted.' };
      }
      case 'cloud-model-subscribe': {
        const host = (prefs.vpsBrowser?.sshHost || '').trim();
        if (!host) throw new Error('Connect to the computer first.');
        // The OAuth flow prints a URL once; it opens in the user's browser here
        // while the remote waits, and cloud-model-check polls for the result.
        if (!modelAuthChild) {
          modelAuthChild = spawn('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=accept-new', host, posixCommand(cloudModel.authLoginCommand())]);
          let seen = '', opened = false;
          const feed = (chunk) => {
            seen = (seen + chunk).slice(-20000);
            const url = cloudModel.extractAuthUrl(seen);
            if (url && !opened) { opened = true; shell.openExternal(url).catch(() => {}); }
            try { if (win && !win.isDestroyed()) win.webContents.send('workspace:cloud-log', String(chunk)); } catch {}
          };
          modelAuthChild.stdout.on('data', feed);
          modelAuthChild.stderr.on('data', feed);
          const clear = () => { modelAuthChild = null; };
          modelAuthChild.on('close', clear);
          modelAuthChild.on('error', clear);
        }
        return { done: false, detail: 'The sign-in page opened in your browser. Finish it there, then check again.' };
      }
      case 'cloud-model-check': {
        const host = (prefs.vpsBrowser?.sshHost || '').trim();
        if (!host) throw new Error('Connect to the computer first.');
        const status = await sshRun(host, 'hermes auth status anthropic 2>/dev/null');
        if (!cloudModel.authLoggedIn(status.out)) return { done: false, detail: 'Still waiting for the sign-in to finish.' };
        const supervisor = await sshRun(host, 'supervisorctl status 2>/dev/null');
        await sshRun(host, cloudModel.gatewayRestartCommand(supervisor.out), { timeoutMs: 30000 });
        prefs.cloud = { ...(prefs.cloud || {}), model: 'subscription' };
        const next = nextCloudStep(prefs, 'model');
        if (next === 'done') { prefs.cloud.step = 'done'; prefs.onboarded = true; } else setCloudStep(prefs, next);
        savePreferences();
        return { done: true, detail: 'Signed in.' };
      }
      case 'cloud-telegram': {
        const host = (prefs.vpsBrowser?.sshHost || '').trim();
        if (!host) throw new Error('Connect to the computer first.');
        if (!telegramView || telegramView.webContents.isDestroyed()) throw new Error('Telegram is not loaded.');
        if (telegramStatus !== 'connected') return { done: false, detail: 'Sign in to Telegram on the left first.' };
        const wc = telegramView.webContents, first = await telegramFirstName();
        // Up to four tries: the first username plus three suffixed retries when
        // BotFather says taken or rate-limits, then the paste-token fallback.
        for (let attempt = 0; attempt < 4; attempt++) {
          const username = cloudTelegram.retryUsername(first, attempt);
          const run = await wc.executeJavaScript(cloudTelegram.botFatherScript({ name: cloudTelegram.botName(first), username })).catch(() => null);
          if (run?.ok !== true) return { done: false, detail: run?.error || 'Could not open @BotFather. Check Telegram and try again.' };
          const reply = cloudTelegram.parseBotFatherReply(run.reply || '');
          if (reply.type !== 'token') continue;
          const check = await cloudTelegram.validateToken(reply.token);
          if (!check.ok) continue;
          return cloudFinishTelegram(reply.token, check.username || username);
        }
        const cloud = prefs.cloud && typeof prefs.cloud === 'object' ? prefs.cloud : {};
        prefs.cloud = { ...cloud, telegramFallback: true };
        savePreferences(); broadcast();
        return { done: false, fallback: true, detail: 'BotFather did not mint a bot after a few tries. Paste a token below instead.' };
      }
      case 'cloud-telegram-paste': {
        const host = (prefs.vpsBrowser?.sshHost || '').trim();
        if (!host) throw new Error('Connect to the computer first.');
        // The finish still needs the embedded Telegram: the bot chat opens and
        // /start is sent through it, so a signed-out pane cannot complete.
        if (telegramStatus !== 'connected') return { done: false, detail: 'Sign in to Telegram on the left first.' };
        const check = await cloudTelegram.validateToken(String(value.token || '').trim());
        if (!check.ok) return { done: false, detail: 'Telegram did not accept that token. Check it and try again.' };
        return cloudFinishTelegram(String(value.token).trim(), check.username);
      }
      case 'cloud-discord': shell.openExternal(cloudView().supportUrl); break;
      case 'move-to-applications': return app.moveToApplicationsFolder();
      case 'sync-telegram': telegramView.webContents.reload(); break;
      case 'open-username': {
        const username = String(value.username || '').replace(/^@/, '');
        if (!/^[A-Za-z][\w]{3,31}$/.test(username)) throw new Error('Enter a Telegram bot username.');
        await openTelegramUsername(username);
        return { ok: true };
      }
      default: throw new Error('Unknown workspace command.');
    }
    return getState();
  };
  // Failed actions only reached the screen as a toast; log them so a copied
  // report shows what went wrong.
  ipcMain.handle('workspace:command', async (event, command, value = {}) => {
    if (command === 'settings' && value._settingsWrite) {
      const entry = settingsWriteEntry(event, value._settingsWrite, false, value);
      if (entry.admit) {
        try { await runCommand(event, command, value); entry.record.status = 'finished'; }
        catch (error) { entry.record.status = 'failed'; entry.record.detail = String(error?.message || error); logError('command settings', error); }
      }
      return settingsWriteReceipt(entry);
    }
    try { return await runCommand(event, command, value); }
    catch (error) {
      // Legacy Settings choices advance the fence even when persistence fails.
      // Publish the retained saved values and new fence before the next choice.
      if (command === 'settings') broadcastNow();
      logError(`command ${command}`, error); throw error;
    }
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
    const read = () => Promise.race([
      readJs(tab.view.webContents, snapshotExpression({ parseWaitMs: SNAPSHOT_PARSE_MS, ...opts, seed: tab.refSeed }), 20000),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('Snapshot timed out after 10s. The page may be unresponsive.'), { status: 503 })), 10000); }),
    ]).finally(() => clearTimeout(timer));
    let result = await read();
    // A Cloudflare check that clears by itself is waited out here too.
    if (result?.challenge?.kind === 'cloudflare' && await passCloudflare((code) => readJs(tab.view.webContents, code, 3000))) result = await read();
    if (!result || !Array.isArray(result.elements)) throw Object.assign(new Error('Snapshot returned no page data.'), { status: 503 });
    // A takeover while the page was being read seals the response.
    requireAgentRead(tab);
    const settled = settleSnapshot(tab, result, generation, opts.since);
    return { ...settled, ...handleChallenge(tab, settled.challenge), tab: describeTab(tab, true) };
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
// Resolves true when the trigger committed a cross-document main-frame
// navigation; a same-document history step (did-navigate-in-page) is not one.
function settleNavigation(wc, trigger, timeout = 15000) {
  return new Promise((resolve) => {
    let committed = false;
    const onNav = () => { committed = true; };
    const events = ['did-stop-loading', 'did-navigate-in-page', 'destroyed'];
    const done = () => { clearTimeout(timer); wc.off('did-navigate', onNav); for (const name of events) wc.off(name, done); resolve(committed); };
    const timer = setTimeout(done, timeout);
    wc.on('did-navigate', onNav);
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
      const size = await boundedJs(wc, '({ width: globalThis.visualViewport?.width ?? innerWidth, height: globalThis.visualViewport?.height ?? innerHeight, pageLeft: globalThis.visualViewport?.pageLeft ?? scrollX, pageTop: globalThis.visualViewport?.pageTop ?? scrollY, dsf: devicePixelRatio })');
      const scale = maxWidth && size.width * size.dsf > maxWidth ? Math.max(0.01, maxWidth / size.width) : size.dsf;
      const shot = await browserCommand(tab, 'Page.captureScreenshot', { format: cdpFormat, ...(cdpFormat === 'png' ? {} : { quality }), fromSurface: true, clip: { x: size.pageLeft, y: size.pageTop, width: size.width, height: size.height, scale } });
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
const EMPTY_EFFECT = { navigated: false, changed: false, text: '' };
async function actionEffect(tab, opts) {
  try {
    requireAgentRead(tab);
    const effect = await readEffect((code) => readJs(tab.view.webContents, code, 12000), tab, opts);
    requireAgentRead(tab);
    if (effect) return { ...effect, ...handleChallenge(tab, effect.challenge), ...takeDialogs(tab), ...takeOpened(tab), ...(await takeDownloads(tab)) };
    return { effect: { ...EMPTY_EFFECT }, error: 'The page returned no state.', ...takeDialogs(tab), ...takeOpened(tab), ...(await takeDownloads(tab)) };
  } catch (error) {
    if (error && error.status === 409) throw error;
    return { effect: { ...EMPTY_EFFECT }, error: String(error && error.message || error), ...takeDialogs(tab), ...takeOpened(tab), ...(await takeDownloads(tab)) };
  }
}
// A batch step answers with its own payload only: the page state, controls and
// tab record ride once on the batch reply instead of once per step. Every
// top-level reply carries effect: the url, title, new visible text and any
// changed controls the action produced, so the model never snapshots to
// learn what its action did.
// dialog on an action (or a batch step) answers the confirm or prompt that
// action raises; without it they are dismissed.
async function performAction(tab, body, botId, depth = 0, isAborted = () => false) {
  if (body.dialog === undefined) return performStep(tab, body, botId, depth, isAborted);
  const before = tab.dialogAnswer;
  tab.dialogAnswer = dialogAnswer(body.dialog);
  try { return await performStep(tab, body, botId, depth, isAborted); } finally { tab.dialogAnswer = before; }
}
async function performStep(tab, body, botId, depth, isAborted) {
  const overseer = isOverseer(botId);
  requireActor(tab, botId, body.epoch, true, overseer);
  const wc = tab.view.webContents;
  if (depth === 0) await syncDialogGuard(tab);
  if (depth === 0) agentInput.approve(tab, body);
  const reply = (payload) => depth > 0 ? payload : actionReply(tab, payload);
  const finish = async (payload, opts) => depth > 0 ? payload : actionReply(tab, { ...payload, ...(await actionEffect(tab, { ...opts, held: body.generation })) });
  if (body.action === 'batch') {
    if (depth > 0) throw Object.assign(new Error('Batches cannot nest.'), { status: 400 });
    const steps = Array.isArray(body.steps) ? body.steps.slice(0, 25) : [];
    if (!steps.length) throw Object.assign(new Error('batch needs a non-empty steps array (max 25).'), { status: 400 });
    // Takeover validates just the first step, with the batch's approval mark.
    if (tab.preflight) return performAction(tab, { ...steps[0], epoch: body.epoch, [APPROVED]: body[APPROVED] }, botId, 1, isAborted);
    const results = [], started = Date.now();
    let lastTarget, sawInput = false;
    for (const step of steps) {
      if (!step || typeof step !== 'object') { results.push({ ok: false, error: 'Invalid step.' }); break; }
      if (Date.now() - started > BATCH_BUDGET_MS) { results.push({ ok: false, error: `batch stopped after ${BATCH_BUDGET_MS / 1000}s; remaining steps were not run. Snapshot, then continue.` }); break; }
      if (isAborted()) { results.push({ ok: false, error: 'The request was closed; remaining steps were not run.' }); break; }
      try { results.push({ ok: true, ...(await performAction(tab, { ...step, epoch: body.epoch, [APPROVED]: body[APPROVED] }, botId, 1, isAborted)) }); }
      catch (error) { results.push({ ok: false, error: errorMessage(error) }); break; }
      // A step aimed by name reports the ref it resolved to.
      const ref = results.at(-1).ref || step.ref;
      if (ref !== undefined || step.selector !== undefined) lastTarget = { ref, selector: step.selector };
      if (INPUT_ACTIONS.has(step.action) && step.action !== 'move') sawInput = true;
    }
    // A takeover mid-batch seals the accumulated step results too.
    requireActor(tab, botId, body.epoch, true, overseer);
    return actionReply(tab, { results, ...(await actionEffect(tab, { target: lastTarget, settle: sawInput, held: body.generation })), dispatched: true });
  }
  // Page script and DevTools calls are checked in their branches, after the challenge preflight.
  if (body.action !== 'cdp' && body.action !== 'eval') await agentInput.guard(tab, body);
  if (body.action === 'read') {
    const maxChars = Number.isInteger(body.maxChars) ? Math.min(Math.max(body.maxChars, 0), 20000) : 600;
    dryRun(tab);
    requireAgentRead(tab);
    // A read step is the model's own baseline, so it must not plant the doc
    // marker: on a fresh document the missing marker is what lets the final
    // effect report the navigation it observed.
    const data = await readJs(wc, snapshotExpression({ maxChars, maxElements: 0, elementMs: 5, mark: false }), 12000).catch(() => null);
    requireActor(tab, botId, body.epoch, true, overseer);
    if (data) { tab.lastRead = data.sameDoc === false ? null : lastReadOf(data); tab.docMarked = tab.docMarked || data.sameDoc === true; }
    return finish({ text: (data && typeof data.text === 'string' ? data.text : ''), dispatched: true });
  }
  if (body.action === 'eval') {
    const code = String(body.code || '');
    if (!code || code.length > 16384) throw Object.assign(new Error('eval needs a code string (max 16KB).'), { status: 400 });
    const wc = tab.view.webContents;
    // Page script can reach a widget anywhere on the page.
    await refuseChallenge(wc);
    await agentInput.guard(tab, body);
    let evalTimer;
    dryRun(tab);
    let value = await Promise.race([
      frameOf(wc).executeJavaScript(code, true),
      new Promise((_, reject) => { evalTimer = setTimeout(() => reject(Object.assign(new Error('eval timed out after 15s.'), { status: 408 })), 15000); }),
    ]).finally(() => clearTimeout(evalTimer));
    // A takeover while the eval ran seals the result: the human's page state
    // is not returned to the bot.
    requireActor(tab, botId, body.epoch, true, overseer);
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    if (serialized && serialized.length > 48000) value = serialized.slice(0, 48000) + '…[truncated]';
    return finish({ value, dispatched: true });
  }
  if (body.action === 'wait') {
    const selector = String(body.selector || '').slice(0, 2000);
    const text = String(body.text || '').slice(0, 2000);
    const urlPart = String(body.url || '').slice(0, 2000);
    const visible = body.visible === true;
    const gone = body.gone === true;
    const timeout = Math.min(Math.max(Number(body.timeout) || 10000, 100), 30000);
    if (!selector && !text && !urlPart) throw Object.assign(new Error('wait needs a selector, text, or url to wait for.'), { status: 400 });
    const waitCode = (ms) => `new Promise((resolve) => {
      const sel = ${JSON.stringify(selector)}, txt = ${JSON.stringify(text)}, urlP = ${JSON.stringify(urlPart)}, vis = ${visible}, gone = ${gone};
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
      const met = () => check() !== gone;
      const t0 = Date.now();
      let mo, poll;
      const done = (found) => { clearInterval(poll); if (mo) mo.disconnect(); resolve({ found, waited: Date.now() - t0 }); };
      if (met()) return done(true);
      mo = new MutationObserver(() => { if (met()) done(true); });
      mo.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
      poll = setInterval(() => { if (met() || Date.now() > deadline) done(met()); }, 100);
      setTimeout(() => done(met()), ${ms});
    })`;
    dryRun(tab);
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
      if (urlPart && wc.getURL().includes(urlPart) !== gone) { value = { found: true, waited: elapsed }; break; }
      if (!attempt || attempt.navRetry) await new Promise((r) => setTimeout(r, 250));
    }
    if (!value || !value.found) throw Object.assign(new Error(`wait timed out after ${value ? value.waited : Date.now() - hostStart}ms for ${gone ? 'absence of ' : ''}${[selector && `selector ${JSON.stringify(selector)}`, text && `text ${JSON.stringify(text.slice(0, 80))}`, urlPart && `url containing ${JSON.stringify(urlPart.slice(0, 80))}`].filter(Boolean).join(' and ')}. Snapshot the page to see its current state.`), { status: 408 });
    requireActor(tab, botId, body.epoch, true, overseer);
    // A successful wait observed the page, so it becomes the read baseline:
    // the final effect must not re-report what the wait already confirmed.
    const waited = await readJs(wc, snapshotExpression({ maxChars: 8000, maxElements: 0, elementMs: 5, mark: false }), 12000).catch(() => null);
    if (waited) { tab.lastRead = waited.sameDoc === false ? null : lastReadOf(waited); tab.docMarked = tab.docMarked || waited.sameDoc === true; }
    return finish({ waited: value.waited, dispatched: true });
  }
  if (body.action === 'viewport') {
    dryRun(tab);
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
    if (body.clear === true) {
      await wc.debugger.sendCommand('Emulation.clearDeviceMetricsOverride');
      delete tab.viewport;
      return finish({ viewport: null, dispatched: true });
    }
    const width = Math.round(Number(body.width)), height = Math.round(Number(body.height));
    const scale = Math.min(Math.max(Number(body.scale) || 1, 0.1), 5);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 100 || width > 7680 || height < 100 || height > 4320)
      throw Object.assign(new Error('viewport needs width 100-7680 and height 100-4320, or clear:true.'), { status: 400 });
    await wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
    tab.viewport = { width, height, scale };
    broadcast();
    return finish({ viewport: tab.viewport, dispatched: true });
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
    // While a challenge is on the page, only read-only methods run: raw input,
    // script and DOM writes could all reach the widget.
    if (!cdpChallengeSafe(method, params)) await refuseChallenge(wc);
    // A challenge answers first: input or script aimed at a CAPTCHA goes to the person, not to approval.
    await agentInput.guard(tab, { ...body, params });
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
    dryRun(tab);
    let cdpTimer;
    let value = await Promise.race([
      wc.debugger.sendCommand(method, params),
      new Promise((_, reject) => { cdpTimer = setTimeout(() => reject(Object.assign(new Error('cdp timed out after 20s.'), { status: 408 })), 20000); }),
    ]).finally(() => clearTimeout(cdpTimer));
    // Seal mid-flight takeovers: the result is the human's page state then.
    requireActor(tab, botId, body.epoch, true, overseer);
    const cdpSerialized = typeof value === 'string' ? value : JSON.stringify(value);
    if (cdpSerialized && cdpSerialized.length > 48000) value = cdpSerialized.slice(0, 48000) + '…[truncated]';
    return finish({ value, dispatched: true });
  }
  if (INPUT_ACTIONS.has(body.action)) {
    const { input, cursor, navigated, ...result } = await agentInput.perform(tab, body, botId);
    broadcast();
    const payload = { ...result, ...(depth === 0 && cursor ? { cursor: { x: cursor.x, y: cursor.y } } : {}), dispatched: true };
    // A move changes no page state; report it without paying for a read.
    if (body.action === 'move') return depth > 0 ? payload : actionReply(tab, { ...payload, effect: { ...EMPTY_EFFECT } });
    return finish(payload,
      { navigated, settle: true, target: result.ref || body.ref !== undefined || body.selector !== undefined ? { ref: result.ref || body.ref, selector: body.selector } : undefined });
  }
  let parseWaitMs = 0, didNavigate = false;
  if (body.action === 'navigate') {
    dryRun(tab);
    await agentInput.clear(tab);
    requireActor(tab, botId, body.epoch, true, overseer);
    const target = pageUrl(agentPageUrl(body.url));
    tab.requestedUrl = target;
    const commit = await waitForNavigationCommit(wc, () => wc.loadURL(target));
    if (commit.state === 'failed' || commit.state === 'destroyed') throw Object.assign(new Error(commit.error ? `Navigation failed: ${commit.error}.` : 'Navigation failed.'), { status: 400 });
    tab.refs.clear();
    if (commit.state === 'timeout') { requireActor(tab, botId, body.epoch, true, overseer); broadcast(); return finish({ loading: true, dispatched: true }, { navigated: true }); }
    // Controls are ready once the document has parsed; the rest of the page
    // keeps loading and `loading` says so.
    parseWaitMs = NAVIGATE_PARSE_MS;
    didNavigate = commit.state === 'committed';
  } else if (['back', 'forward', 'reload'].includes(body.action)) {
    dryRun(tab);
    await agentInput.clear(tab);
    requireActor(tab, botId, body.epoch, true, overseer);
    const history = wc.navigationHistory;
    const go = body.action === 'back' ? history.canGoBack() && (() => history.goBack())
      : body.action === 'forward' ? history.canGoForward() && (() => history.goForward())
      : () => reloadBrowserPage(tab);
    if (go) didNavigate = await settleNavigation(wc, go);
    // History entries predate the address check, so a back/forward/reload can
    // land on one. will-navigate covers the cases Electron emits it for.
    if (tab.controller === 'agent') {
      try { agentPageUrl(wc.getURL()); }
      catch (error) {
        await wc.loadURL('about:blank').catch(() => {});
        throw Object.assign(error, { status: 400 });
      }
    }
  } else throw Object.assign(new Error(UNSUPPORTED_ACTION), { status: 400 });
  // Seal navigation-family results too: a takeover while the page settled
  // makes this response the human's page state.
  requireActor(tab, botId, body.epoch, true, overseer);
  tab.refs.clear(); broadcast();
  if (depth > 0) {
    if (parseWaitMs) await boundedJs(wc, `document.readyState === 'loading' ? new Promise(done => { document.addEventListener('DOMContentLoaded', done, { once: true }); setTimeout(done, ${parseWaitMs}); }) : 0`, parseWaitMs + 2000).catch(() => {});
    return reply({ dispatched: true });
  }
  return finish({ dispatched: true }, { parseWaitMs: parseWaitMs || undefined, navigated: didNavigate });
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
      if (req.method === 'GET' && url.pathname === '/v1/status') return send(200, { name: app.getName(), version: app.getVersion(), protocol: 1, build: BUILD, host: HOST_LABEL, hosts:{[HOST_LABEL]:'connected',vps:vpsBrowserStatus}, capabilities: [...(hostComputer ? ['computer', 'computer-v2'] : []), 'tabs', 'snapshot', 'screenshot', 'navigate', 'click', 'double_click', 'right_click', 'drag', 'select', 'type', 'press', 'move', 'scroll', 'batch', 'read', 'eval', 'wait', 'viewport', 'cdp', 'agent-cursor', 'background-input', 'control-epochs', 'name-targets', 'commit-check', ...(require('./agent-input.cjs').APPROVAL_BINDING_VERSION === 1 ? ['approval-binding-v1'] : [])], tabCount: tabs.size+vpsTabs.size });
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
        return send(200, { tabs: [...tabs.values()].filter(tab => !tab.extensionPage && !tab.localPdf).map(tab => describeTab(tab, true)).concat([...vpsTabs.values()]).filter((tab) => overseer || tab.botId === botId || (tab.allowedBots ?? []).includes(botId)) });
      }
      if (url.pathname === '/v1/tabs' && req.method === 'POST') {
        if (!botId || botId.length > 100) throw Object.assign(new Error('X-Hermes-Bot is required.'), { status: 400 });
        const body = await readJson(req);
        const host=normalizeHost(body.host);
        if(body.host!==undefined&&!host)throw new Error(`Use host "computer" or "vm".`);
        if(host==='vm'){const forward={...body};delete forward.host;const result=await vpsBrowser.request('/v1/tabs','POST',forward,{botId,botName:nameForBot(botId)});vpsTabs.set(result.id,result);broadcast();return send(201,result);}
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
            // Commit is not parsed: an eval or snapshot right after open would
            // see a half-built document. The VM host waits for the parse too.
            await boundedJs(wc, `document.readyState === 'loading' ? new Promise(done => { document.addEventListener('DOMContentLoaded', done, { once: true }); setTimeout(done, ${OPEN_PARSE_MS}); }) : 0`, OPEN_PARSE_MS + 2000).catch(() => {});
          }
          return send(201, describeTab(created, true)); }
      }
      // Recordings the user shared with this bot; read-only.
      const recordingMatch = /^\/v1\/recordings(?:\/([\w-]{8,64}))?$/.exec(url.pathname);
      if (recordingMatch && req.method === 'GET') {
        if (!botId || botId.length > 100) throw Object.assign(new Error('X-Hermes-Bot is required.'), { status: 400 });
        if (!recordingMatch[1]) return send(200, { recordings: recordings.listFor(botId) });
        const record = recordings.getFor(recordingMatch[1], botId);
        if (!record) throw Object.assign(new Error('Recording not found, or the user has not shared it with you.'), { status: 404 });
        return send(200, record);
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
        const body = req.method === 'POST' ? await readJson(req) : undefined;
        if (match[2] === 'actions' && body?.approval !== undefined) {
          // Local capability says nothing about the remote host. Check the
          // actual backend on every approved forward, with no reconnect cache.
          const configured = JSON.stringify(prefs.vpsBrowser);
          let status;
          try { status = await vpsBrowser.request('/v1/status', 'GET', undefined, { botId }); } catch { /* refuse below */ }
          if (configured !== JSON.stringify(prefs.vpsBrowser) || !Array.isArray(status?.capabilities) || !status.capabilities.includes('approval-binding-v1'))
            throw Object.assign(new Error('approval_binding_unavailable: the remote browser could not confirm document and target checks. Update the remote browser host and workspace connector, reconnect, take a fresh snapshot, and request approval again. No action was sent.'), { status: 403 });
        }
        const result=await vpsBrowser.request(url.pathname+url.search,req.method,body,{botId,botName:nameForBot(botId),epoch:Number(req.headers['x-control-epoch'])});
        const remote=result.tab || (result.id?result:null);if(remote)vpsTabs.set(remote.id,remote);if(req.method==='DELETE')vpsTabs.delete(match[1]);broadcast();return send(200,result);
      }
      if (!tab || tab.extensionPage || tab.localPdf) return send(404, { error: 'Tab not found.' });
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
        const action = tab.queue.then(async () => {
          if (closed) throw Object.assign(new Error('The request was closed before this action started.'), { status: 499 });
          // A malformed action must not cost the human their tab.
          if (!body || typeof body !== 'object' || typeof body.action !== 'string') throw Object.assign(new Error('action is required.'), { status: 400 });
          // An epoch read while the human held the tab carries over to the
          // takeover; an older one is refused and the tab stays theirs.
          let taken = 0, held;
          if (tab.controller !== 'agent' && prefs.autoTakeover !== false) {
            await checkAction(tab, body, botId);
            // A tab that stays the human's says why before any epoch advice.
            requireAgentClaim(tab, Date.now(), claimRules(tab));
            // The generation the bot holds says whether the human moved the page since.
            const generation = Number.isInteger(body.generation) ? body.generation : tab.generation;
            if (body.epoch !== tab.epoch || generation !== tab.generation) throw Object.assign(new Error(STALE_HUMAN_EPOCH), { status: 409 });
            held = { humanLock: tab.humanLock, humanSince: tab.humanSince, botId: tab.botId, handoff: tab.handoff };
            const preflight = async () => {
              tab.preflight = true;
              try { await performAction(tab, { ...body }, botId, 0, () => closed); }
              catch (error) { if (error !== PREFLIGHT_READY) throw error; }
              finally { tab.preflight = false; }
            };
            const approvalEpoch = body.epoch;
            taken = body.epoch = (await claimTab(tab, botId, { isClosed: () => closed, overseer, epoch: body.epoch, generation, preflight,
              beforeClaim: () => agentInput.carryApproval?.(tab, body, approvalEpoch) })).epoch;
          }
          // An action the page refused before any input or navigation reached it
          // (a challenge, a commit check, a missing control) hands the tab
          // straight back: the takeover bought the bot nothing.
          const inputs = tab.inputsSent || 0, wc = tab.view.webContents;
          let moved = false;
          const onMove = () => { moved = true; };
          const unrun = () => taken && tab.epoch === taken && tab.controller === 'agent' && (tab.inputsSent || 0) === inputs && !moved;
          const giveBack = () => {
            try { changeController(tab.id, 'human', 'human'); Object.assign(tab, held); broadcast(); } catch (error) { logError('takeover undo', error); }
          };
          wc.on('did-start-navigation', onMove);
          try {
            const result = await performAction(tab, body, botId, 0, () => closed);
            // Batch steps report errors without a status: only an input first
            // step that failed before reaching the page counts as refused.
            if (INPUT_ACTIONS.has(body.steps?.[0]?.action) && result?.results?.[0]?.ok === false && unrun()) giveBack();
            return result;
          } catch (error) {
            if (([400, 403, 409].includes(error?.status) || error?.code === 'stale_ref') && unrun()) giveBack();
            throw takeoverError(error);
          } finally { if (!wc.isDestroyed()) wc.off('did-start-navigation', onMove); }
        })
          .finally(() => { tab.pendingActions--; tab.lastAgentActivity = Date.now(); });
        tab.queue = action.catch(() => {});
        const result = await action;
        // The bot is acting on the tab again; human_returned has done its job.
        if (tab.handback?.state === 'human_returned') { tab.handback = null; broadcast(); }
        return send(200, result);
      }
      if (req.method === 'POST' && match[2] === 'control') {
        const body = await readJson(req);
        const granted = (tab.allowedBots || []).includes(botId)
          || (tab.botId === 'shared' && prefs.bots.some((bot) => bot.id === botId));
        if (botId !== tab.botId && !overseer && !granted) throw Object.assign(new Error('Only the owning bot can change control.'), { status: 403 });
        let closed = false;
        res.on('close', () => { if (!res.writableFinished) closed = true; });
        if (body.controller === 'agent') return send(200, redactTabForBot(await claimTab(tab, botId, { isClosed: () => closed, overseer })));
        const request = handbackRequest(body);
        const ignored = request && tab.controller === 'human' && tab.humanLock;
        const info = redactTabForBot(changeController(tab.id, body.controller, 'agent', request));
        if (ignored) info.note = 'The human has taken over this tab; the handback reason was ignored.';
        return send(200, info);
      }
      if (req.method === 'DELETE' && !match[2]) {
        let epoch = Number(req.headers['x-control-epoch']), closed = false;
        res.on('close', () => { if (!res.writableFinished) closed = true; });
        if (tab.controller !== 'agent' && prefs.autoTakeover !== false) {
          requireActor(tab, botId, undefined, false, overseer);
          requireAgentClaim(tab, Date.now(), claimRules(tab));
          if (epoch !== tab.epoch) throw Object.assign(new Error(STALE_HUMAN_EPOCH), { status: 409 });
          epoch = (await claimTab(tab, botId, { isClosed: () => closed, overseer, epoch, generation: tab.generation })).epoch;
        }
        if (closed) throw Object.assign(new Error('The request was closed before the tab closed.'), { status: 499 });
        requireActor(tab, botId, epoch, true, overseer); closeTab(tab.id); return send(200, { closed: true });
      }
      return send(405, { error: 'Method not supported.' });
    } catch (error) { send((error && error.status) || (error && error.code === 'stale_ref' ? 409 : 400), { error: errorMessage(error), ...(error && error.code ? { code: error.code } : {}) }); }
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
    tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Show Alan’s Workspace', click: showWindow }, { type: 'separator' }, { label: 'Quit', click: () => app.quit() }]));
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
// A claimed cloud computer keeps a permanent way back to support; the menu is
// rebuilt when a session lands or clears so the item tracks cloud.sessionEnc.
function buildMenu() {
  const settings = { id: 'workspace-settings', label: 'Settings…', accelerator: ACCELERATORS.settings, click: () => { if (!layout.obscured) win.webContents.send('workspace:settings'); } };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ label: app.getName(), submenu: [{ role: 'about' }, { type: 'separator' }, settings, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] }] : []),
    { label: 'File', submenu: [{ label: 'Open File…', accelerator: ACCELERATORS['open-file'], click: () => pickPdf().catch(error => logError('open-pdf', error)) }, { label: 'New Browser Tab', accelerator: ACCELERATORS['new-tab'], click: () => createTab({}) }, { label: 'Close Tab', accelerator: ACCELERATORS['close-tab'], click: () => extensionPopup?.browserWindow?.isFocused() ? extensionPopup.destroy() : closeTab(activeTabId) }, ...(process.platform === 'darwin' ? [] : [{ type: 'separator' }, settings, { type: 'separator' }, { role: 'quit' }])] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ label: 'Reload Page', accelerator: ACCELERATORS.reload, click: () => { const tab = tabs.get(activeTabId); if (tab) reloadBrowserPage(tab); } }, { role: 'togglefullscreen' }, ...(app.isPackaged ? [] : [{ label: 'App Developer Tools', accelerator: 'Alt+CmdOrCtrl+I', click: () => win.webContents.toggleDevTools() }])] },
    ...(process.platform === 'darwin' ? [{ label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'front' }] }] : []),
    { label: 'Help', submenu: [{ id: 'workspace-shortcuts', label: 'Keyboard Shortcuts', click: () => win.webContents.send('workspace:shortcuts') }, ...(prefs?.cloud?.sessionEnc ? [{ type: 'separator' }, { label: 'Get help', click: () => shell.openExternal(cloudView().supportUrl).catch(() => {}) }] : [])] },
  ]));
}
function createWindow() {
  nativeTheme.themeSource = 'dark';
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({ width: Math.min(1550, width), height: Math.min(980, height),
    minWidth: Math.min(1120, width), minHeight: Math.min(680, height), backgroundColor: '#09090a', title: app.getName(),
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 18 } }
      : { titleBarStyle: 'hidden', titleBarOverlay: { color: '#111112', symbolColor: '#e7e7eb', height: 40 } }),
    webPreferences: { preload: path.join(ROOT, 'preload.bundle.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  lockDown(win.webContents, INDEX_FILE);
  telegramView = new WebContentsView({ webPreferences: { preload: path.join(ROOT, 'telegram-preload.bundle.cjs'), partition: 'persist:telegram', navigateOnDragDrop: false, contextIsolation: true, nodeIntegration: false, sandbox: true } });
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
  claimTokens.setReady(claimWithToken);
  win.loadFile(path.join(ROOT, 'index.html'));
  remoteView.webContents.loadFile(path.join(ROOT, 'remote.html'));
  telegramView.webContents.loadURL(prefs.selectedBotId ? `${TELEGRAM}#${prefs.selectedBotId}` : TELEGRAM).catch(() => {});
  for (const item of prefs.savedTabs.filter((item) => item.url && item.url !== 'about:blank').slice(0, 12)) {
    try {
      if (/^file:\/\//i.test(String(item.url))) createTab({ filePath: fileURLToPath(item.url), botId: item.botId, activate: false });
      else createTab({ url: item.url, botId: item.botId, localPdf: item.localPdf === true, activate: false });
    } catch {}
  }
  activeTabId = 'home';
  pdfWindowReady = true;
  for (const file of pendingPdfs.splice(0)) receivePdf(file);
  win.on('enter-full-screen', broadcast); win.on('leave-full-screen', broadcast);
  createTray();
  win.on('session-end', () => { isQuitting = true; prefsSaver.flush(); });
  win.on('close', (event) => {
    if (isQuitting) return;
    if (process.platform === 'darwin' || tray) { event.preventDefault(); win.hide(); }
    else if (process.platform === 'linux') { event.preventDefault(); win.minimize(); }
  });
  for (const name of ['show', 'hide', 'minimize', 'restore', 'focus', 'blur']) win.on(name, () => sendPollTier());
  buildMenu();
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
      if (tab.handback && !liveHandback(tab, now)) { tab.handback = null; broadcast(); }
      if (tab.controller !== 'agent' || tab.extensionPage || tab.pendingActions > 0 || agentInput.isDispatching(tab)) continue;
      if (now - Math.max(tab.agentSince || 0, tab.lastAgentActivity || 0) > idleMs) changeController(tab.id, 'human', 'idle');
    }
  }, 30000).unref();
  captchaTimer = setInterval(watchCaptchas, 1000);
  captchaTimer.unref();
  const vpsTick = async () => { await refreshVpsTabs(); vpsTimer = setTimeout(vpsTick, backoffDelay(vpsFailures)); vpsTimer.unref(); };
  vpsTick();
  vpsMirrorTimer = setInterval(pushVpsMirror, 10000); vpsMirrorTimer.unref();
}
// ── Native Hermes chat: hub construction + persisted connection ─────────────
// Secrets (refresh token, loopback token) are stored only when safeStorage can
// encrypt them; otherwise they live for the process lifetime in memory only.
const HERMES_STORE = () => path.join(app.getPath('userData'), 'hermes-gateway.json');
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
function hermesSecretsAvailable() { try { return safeStorage.isEncryptionAvailable(); } catch { return false; } }
function loadHermesPersisted() {
  try {
    const raw = JSON.parse(fs.readFileSync(HERMES_STORE(), 'utf8'));
    if (!raw || typeof raw !== 'object') return {};
    const out = { url: raw.url, profile: raw.profile, selected: raw.selected };
    const unseal = (v) => {
      try { return typeof v === 'string' && v ? safeStorage.decryptString(Buffer.from(v, 'base64')) : ''; }
      catch { return ''; }
    };
    if (isPlainObject(raw.tokensEnc)) {
      out.tokens = {
        refreshToken: unseal(raw.tokensEnc.refreshToken), accessToken: unseal(raw.tokensEnc.accessToken),
        expiresAt: raw.tokensEnc.expiresAt || 0, provider: raw.tokensEnc.provider || '', userId: raw.tokensEnc.userId || '',
      };
      if (!out.tokens.refreshToken) out.tokens = null;
    }
    out.localToken = unseal(raw.localTokenEnc);
    return out;
  } catch { return {}; }
}
function saveHermesPersisted(record) {
  try {
    const seal = (v) => hermesSecretsAvailable() && typeof v === 'string' && v
      ? safeStorage.encryptString(v).toString('base64') : '';
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    writePrivateJson(HERMES_STORE(), JSON.stringify({
      url: record.url || '', profile: record.profile || '', selected: record.selected || null,
      tokensEnc: record.tokens ? {
        refreshToken: seal(record.tokens.refreshToken), accessToken: seal(record.tokens.accessToken),
        expiresAt: record.tokens.expiresAt || 0, provider: record.tokens.provider || '', userId: record.tokens.userId || '',
      } : null,
      localTokenEnc: seal(record.localToken),
    }));
  } catch (error) { logError('hermes-persist', error); }
}
const pushHermesState = coalesce(() => {
  if (win && !win.isDestroyed() && hermesHub) win.webContents.send('hermes:state', hermesHub.getState());
}, 60);
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.whenReady().then(async () => {
    prefs = readPreferences(); prefs.remoteControl = false;
    if (pinOnboarding(prefs)) savePreferences();
    seedMacSshHost();
    hermesHub = createHermesHub({
      load: loadHermesPersisted,
      persist: saveHermesPersisted,
      notify: () => { pushHermesState(); broadcast(); },
    });
    pushHermesState();
    // A cold start launched by the claim link (Windows/Linux) carries the URL in argv.
    for (const arg of process.argv) { claimTokens.push(cloudClaim.parseClaimUrl(arg)); receivePdf(arg); }
    // A session already stored means onboarding was in progress: resume it.
    if (cloudSession() && prefs.cloud?.step && prefs.cloud.step !== 'done') prefs.onboarded = false;
    session.defaultSession.protocol.handle(AVATAR_SCHEME, (request) => {
      const image = avatarStore.imageFor(request.url);
      return image ? new Response(image.data, { headers: { 'Content-Type': image.mime, 'Cache-Control': 'private, max-age=3600' } }) : new Response('', { status: 404 });
    });
    try { parseRemoteUrl(prefs.remoteUrl); } catch { prefs.remoteUrl = ''; }
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    // A connector copy setup.sh left behind runs ahead of the app's own and
    // nothing else updates it; once the app is newer, drop it.
    const stale = staleConnector();
    if (stale) try { fs.rmSync(stale, { recursive: true, force: true }); } catch (error) { logError('stale-connector', error); }
    const browserSession = session.fromPartition('persist:browser');
    for (const target of [session.defaultSession, browserSession, session.fromPartition('persist:telegram')]) {
      target.registerPreloadScript({ id: 'workspace-pdf-drop', type: 'frame', filePath: path.join(ROOT, 'pdf-drop-preload.cjs') });
    }
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
    if (cloudSession() && prefs.cloud?.step && prefs.cloud.step !== 'done') startCloudPolling();
    startUpdates();
  });
  app.on('second-instance', (_event, argv) => {
    for (const arg of argv || []) { claimTokens.push(cloudClaim.parseClaimUrl(arg)); receivePdf(arg); }
    showWindow();
  });
  app.on('activate', showWindow);
  app.on('before-quit', () => { isQuitting = true; hostComputer?.close(); try { modelAuthChild?.kill(); } catch {} clearInterval(pointerTimer); clearInterval(activityTimer); clearInterval(idleTimer); clearInterval(captchaTimer); clearTimeout(vpsTimer); clearInterval(vpsMirrorTimer); clearTimeout(vpsMirrorDebounce); prefsSaver.flush(); tray?.destroy(); apiServer?.close(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
