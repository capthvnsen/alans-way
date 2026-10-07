#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
// Computer drivers are per-OS. An SSH-spawned process cannot drive the
// desktop: on Windows it sits in Session 0, and on macOS TCC credits
// Accessibility and Screen Recording to the SSH session, not the app. So when
// the connected app advertises computer use, these tools go through its
// loopback API on every OS. The in-process driver is only for a host with no
// computer endpoint (the VM's own browser host, whose desktop is this one).
const localDriver = process.platform === 'darwin' ? '../src/computer.cjs'
  : process.platform === 'win32' ? null
  : '../src/vps-computer.cjs';
const { connectorReplaced } = require('../src/connector-reload.cjs');
const { omitIcons } = require('../src/omit-icons.cjs');
const { retargetMissingTab, needsContinuedEpoch } = require('../src/core.cjs');
const watched = [
  __filename,
  path.join(__dirname, '..', 'src', 'omit-icons.cjs'),
  path.join(__dirname, '..', 'src', 'computer-snapshot.cjs'),
  path.join(__dirname, '..', 'src', 'computer-helper.cjs'),
  path.join(__dirname, '..', 'src', 'computer-policy.cjs'),
];
if (process.platform !== 'win32')
  watched.push(path.join(__dirname, '..', 'src', process.platform === 'darwin' ? 'computer.cjs' : 'vps-computer.cjs'));
const fileMtime = (file) => { try { return fs.statSync(file).mtimeMs; } catch { return 0; } };
const started = Object.fromEntries(watched.map((file) => [file, fileMtime(file)]));
const reloadIfReplaced = () => {
  const current = Object.fromEntries(watched.map((file) => [file, fileMtime(file)]));
  if (!connectorReplaced(started, current)) return;
  setTimeout(() => process.exit(0), 50).unref();
};
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const index = process.argv.indexOf('--bot-id');
const botId = index >= 0 ? process.argv[index + 1] : '';
if (!botId || botId.length > 100 || /[\r\n]/.test(botId)) {
  process.stderr.write('Usage: node browser-mcp.cjs --bot-id YOUR_BOT_ID [--bot-name DISPLAY_NAME]\n'); process.exit(1);
}
const nameIndex = process.argv.indexOf('--bot-name');
const botName = encodeURIComponent(String((nameIndex >= 0 ? process.argv[nameIndex + 1] : '') || process.env.HERMES_BOT_NAME || '').slice(0, 80));
const connectionIndex=process.argv.indexOf('--connection');
const appData = process.platform === 'win32' ? (process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'))
  : process.platform === 'linux' ? (process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'))
  : path.join(os.homedir(), 'Library', 'Application Support');
const file = (connectionIndex>=0?process.argv[connectionIndex+1]:undefined) || process.env.HERMES_WORKSPACE_CONNECTION || path.join(appData, 'Hermes Workspace', 'connection.json');
const objectSchema = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const string = { type: 'string' };
function singleContinuedFromArgv(argv) {
  const tabAt = argv.indexOf('--continued-tab');
  const urlAt = argv.indexOf('--continued-url');
  const tabId = tabAt >= 0 ? String(argv[tabAt + 1] || '') : '';
  const raw = urlAt >= 0 ? String(argv[urlAt + 1] || '') : '';
  if (!/^[\w-]{1,100}$/.test(tabId)) return null;
  try {
    const url = new URL(raw);
    if (url.username || url.password || url.protocol !== 'https:') return null;
    url.hash = '';
    if (url.href.length > 500) return null;
    return { tabId, url: url.href };
  } catch { return null; }
}
// --tab-map '{"<old tab id>":"<new tab id>"}' comes from a mirror restore.
function tabMapFromArgv(argv) {
  const at = argv.indexOf('--tab-map');
  if (at < 0) return {};
  let parsed;
  try { parsed = JSON.parse(String(argv[at + 1] || '')); } catch { return {}; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const id = /^[\w-]{1,100}$/;
  return Object.fromEntries(Object.entries(parsed).filter(([from, to]) => id.test(from) && typeof to === 'string' && id.test(to)).slice(0, 40));
}
function continuedFromArgv(argv) {
  const single = singleContinuedFromArgv(argv), map = tabMapFromArgv(argv);
  return single || Object.keys(map).length ? { ...single, map } : null;
}
function withContinuedTab(message, page) {
  const text = String(message || '');
  if (!page || !/tab not found/i.test(text)) return text;
  if (!page.tabId) return text + ' The Mac tab is gone. Continued tabs (old id to new id): ' + JSON.stringify(page.map) + '.';
  return text + ' The Mac tab is gone. Keep working in tab ' + page.tabId + ' at ' + page.url + '.';
}
const continued = continuedFromArgv(process.argv);
const continuedNote = !continued ? ''
  : continued.tabId ? ' The Mac page was continued in this browser as tab ' + continued.tabId + ' at ' + continued.url + '. Keep working in that tab.'
  : ' The Mac pages were continued in this browser. Continued tabs (old id to new id): ' + JSON.stringify(continued.map) + '. Use the new ids.';
const tools = [
  { name: 'cua_alans_way_status', description: 'Check the configured browser host and available hosts. Inspect host before acting; an unavailable computer is never replaced implicitly by another. Host selection is decided by the connector at spawn and re-converges on its own when Mac availability flips; on a tool error just retry once, and if it still fails report it; never restart, kill, or edit connector processes to steer the host. If the Mac goes offline mid-task, the connector continues the last https page in the VPS browser. If the [workspace] line names a tab, keep working in that tab. If it only names a URL, reopen the same URL and continue. Calls that do not run on the Mac keep going.' + continuedNote, inputSchema: objectSchema(), annotations: { readOnlyHint: true } },
  { name: 'cua_alans_way_tabs', description: 'List this bot’s owned Chromium tabs with execution host and current control epochs. Mac and VPS logins are separate; bots on a host share sign-ins.', inputSchema: objectSchema(), annotations: { readOnlyHint: true } },
  { name: 'cua_alans_way_open', description: 'Open a tab in this connector browser. This is the in-app browser on the user’s computer whenever it is reachable, and the VPS browser when it is not. Do not pass host; the connector already chose the machine. No human handoff, assignment, grant, or approval is ever needed. Shared sign-ins within a host, separate tab ownership and input. Opens in the background.', inputSchema: objectSchema({ url: string, host:{type:'string',enum:['mac','windows','vps'], description: 'Ignored. The connector already chose the user’s computer when it is reachable and the VPS when it is not.'}, background: { type: 'boolean', default: true } }, ['url']), annotations: { readOnlyHint: false, openWorldHint: true } },
  { name: 'cua_alans_way_snapshot', description: 'Read a tab: bounded page text plus interactive elements in elements[] ({ref, role, name, …}). role is usually the lowercase tag (a, input, button, div) or an ARIA role. Menu items, options, tree items, sliders, and clickable divs are included by name. Controls inside an open shadow root are included too; a closed root is not. A name can come from aria-labelledby. A pressed toggle ends in on or off. loading:true means the document was still parsing after a 400ms grace. Same-origin frames are included. A cross-origin frame is not readable; screenshot that frame only. Pass since=<last generation> for a cheap {unchanged:true}. Request a fresh snapshot after actions that change the page; action responses include generation/url/title/loading so you can often skip one.', inputSchema: objectSchema({ tabId: string, maxChars: { type: 'integer', description: 'Cap on returned page text. Default 2000. Raise it up to 20000 when you need more of the page.' }, maxElements: { type: 'integer', description: 'Cap on interactive element refs, default 150, max 300.' }, since: { type: 'integer', description: 'Generation from the previous snapshot; returns {unchanged:true} when content is identical.' } }, ['tabId']), annotations: { readOnlyHint: true } },
  { name: 'cua_alans_way_screenshot', description: 'Capture the tab viewport as an image file. Hermes delivers it as MEDIA:<path>; run a vision step on that path to see pixels. Defaults to compact jpeg; png keeps alpha.', inputSchema: objectSchema({ tabId: string, format: { type: 'string', enum: ['jpeg', 'png', 'webp'], description: 'Image format, default jpeg.' }, quality: { type: 'integer', description: 'jpeg/webp quality 1-100, default 50.' }, maxWidth: { type: 'integer', description: 'Downscale cap on image width in px, default 960.' } }, ['tabId']), annotations: { readOnlyHint: true } },
  { name: 'cua_alans_way_close', description: 'Close a tab this bot owns. Pass the current epoch. Required to free VPS tabs (global cap 40).', inputSchema: objectSchema({ tabId: string, epoch: { type: 'integer' } }, ['tabId', 'epoch']), annotations: { readOnlyHint: false, openWorldHint: true } },
  { name: 'workspace_computer_apps', description: 'List desktop apps the agent can drive without taking the focused window. These apps are on the same machine as the browser: the user’s computer when it is reachable, otherwise the Linux desktop. On macOS and Windows that is every background app. On a Linux desktop that is every app except the focused one. Keychains, password managers, the Alan’s Way app itself, Windows secure-desktop surfaces (UAC, lock screen) and password fields are off limits. Terminal and System Settings are allowed. Web work stays on cua_alans_way. Never moves the pointer. On a Mac, macOS must have Accessibility (and Screen Recording for screenshots) turned on for the app alans-way-localapp itself; an SSH session needs no grant. If a call says one is off, ask the user to turn it on in System Settings > Privacy & Security, then retry.', inputSchema: objectSchema(), annotations: { readOnlyHint: true } },
  { name: 'workspace_computer_snapshot', description: 'Read one desktop app: elements[] with ref, role, and name; text fields also carry value. On macOS and Windows, elements also include screen x,y,width,height. The reply carries generation: pass it back with every action that uses a ref, or the action is refused with stale_ref. truncated:true means the element cap was hit and some controls are missing. Pass since=<last generation> for a cheap {unchanged:true} when the tree is the same. Pass menubar:true to include the menu bar items. Take a fresh snapshot after the app changes. Refuses the focused window.', inputSchema: objectSchema({ pid: { type: 'integer' }, since: { type: 'integer', description: 'Generation from the previous snapshot. Returns {unchanged:true} when the tree is identical.' }, menubar: { type: 'boolean', description: 'Also list the top-level menu bar items.' } }, ['pid']), annotations: { readOnlyHint: true } },
  { name: 'workspace_computer_screenshot', description: 'Capture one app window as a small jpeg. Use only when the snapshot has no named control for what you need, such as a canvas or a chart. Never a full screen. On macOS and Windows, image pixel (px, py) is at screen x = window.x + px * window.width / imageWidth and y = window.y + py * window.height / imageHeight; snapshot and click coordinates use that screen space. On Windows a minimized window cannot be captured, so restore it first. Refuses the focused window, keychains, password managers, and Windows secure-desktop UI.', inputSchema: objectSchema({ pid: { type: 'integer' }, maxWidth: { type: 'integer', description: 'Downscale cap in px, default 960, max 1280.' } }, ['pid']), annotations: { readOnlyHint: true } },
  { name: 'workspace_computer_menu', description: 'List an app menu bar. Without path it returns the top-level menu titles. With path such as ["File"] it returns that menu’s items with enabled, shortcut, and submenu. Press an item with workspace_computer_action action menu. Never moves the pointer.', inputSchema: objectSchema({ pid: { type: 'integer' }, path: { type: 'array', items: string, description: 'Menu titles from the menu bar down, for example ["File","Open Recent"].' } }, ['pid']), annotations: { readOnlyHint: true } },
  { name: 'workspace_computer_action', description: 'Act in a desktop app without moving the pointer or taking focus. Every action that uses a ref needs the generation from your latest snapshot; otherwise it fails with stale_ref and you take a fresh snapshot. press uses a ref (on macOS it also selects rows and tries the nearest pressable parent). type replaces the text of a ref and does not send keystrokes. click uses snapshot x,y. double_click and right_click take a ref or x,y. drag uses snapshot coordinates; it sets sliders and scroll bars from the end point. scroll takes direction (up, down, left, right) and amount in pages (default 1) on a ref, at x,y, or on the main window. key and hotkey send a key or a combo such as cmd+shift+n to the app without focusing it (macOS and Linux X11; Windows takes unmodified keys only). menu presses a menu item by path such as ["File","Save"]. batch runs up to 25 steps and stops at the first failure. An action the OS cannot do without moving the pointer or taking focus returns unsupported_action. The result includes generation. unchanged:true means the tree is the same as the last one you were sent. elements, when present, is the fresh tree; truncated:true means it was cut at the element cap. Refuses the focused window, keychains, password managers, Windows secure-desktop UI, and password fields.', inputSchema: objectSchema({
    pid: { type: 'integer' },
    action: { type: 'string', enum: ['press', 'click', 'double_click', 'right_click', 'drag', 'type', 'scroll', 'key', 'hotkey', 'menu', 'batch'] },
    generation: { type: 'integer', description: 'Generation from your latest snapshot. Required whenever the action or a batch step uses a ref.' },
    ref: string,
    text: { type: 'string', description: 'For type: the replacement text, at most 2000 characters. Password fields are refused.' },
    x: { type: 'number' }, y: { type: 'number' }, x2: { type: 'number' }, y2: { type: 'number' },
    direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'For scroll.' },
    amount: { type: 'number', description: 'For scroll: pages to scroll, default 1.' },
    key: { type: 'string', description: 'For key: one character, a name (return, tab, space, escape, backspace, up, down, left, right, home, end, pageup, pagedown, f1 to f12), or a combo such as cmd+shift+n.' },
    keys: { type: 'string', description: 'For hotkey: a combo such as cmd+shift+n or ctrl+a.' },
    modifiers: { type: 'array', items: string, description: 'For key: shift, control, alt, meta (cmd).' },
    path: { type: 'array', items: string, description: 'For menu: menu titles from the menu bar down.' },
    menubar: { type: 'boolean', description: 'Include the menu bar items in the returned tree.' },
    steps: { type: 'array', items: { type: 'object' }, description: 'For batch: up to 25 steps; each is an action object without pid. They all use the batch generation.' },
  }, ['pid', 'action']), annotations: { readOnlyHint: false } },
  { name: 'cua_alans_way_action', description: 'Use the bot’s own cursor and keyboard in its assigned Chromium tab, including background tabs; never moves the human’s system mouse or types into another tab. Include current epoch. move/click/double_click/right_click accept a fresh ref, a selector, or viewport x,y; drag presses at that source and releases at toRef, toSelector, or toX,toY; select chooses an option of a <select> by value or label; type replaces the text of a fresh ref or selector; press sends a key to that tab (optional ref/selector); scroll uses x,y as deltas. batch runs up to 25 steps in one call, so prefer it; use selectors or refs from one snapshot (refs stay valid for the whole batch unless the page navigates). eval runs JS in the page; keep results small. wait blocks until a selector exists, text appears, or the url contains a substring; after navigate, wait on url or a new-page selector, not body alone. viewport sets layout size. cdp sends an allowlisted DevTools command. Each result includes generation, url, title, loading and a compact tab record (id, controller, epoch, host); a batch carries them once, and its results[] hold only what each step returned. click, double_click, right_click, drag, select, type, press, scroll, navigate, and batch also include elements (up to 40 controls, no page text) when the page can be read; use those refs and skip a snapshot. Three identical failing calls pause this connector ~60s, so change approach instead of retrying the same call. Stops during human takeover. claim/release change control; claim returns a fresh epoch. Do not retry an uncertain submission; inspect the page first.', inputSchema: objectSchema({
    tabId: string, epoch: { type: 'integer' }, action: { type: 'string', enum: ['navigate', 'move', 'click', 'double_click', 'right_click', 'drag', 'select', 'type', 'press', 'scroll', 'back', 'forward', 'reload', 'batch', 'eval', 'wait', 'viewport', 'cdp', 'claim', 'release'] }, ref: string, text: string, url: string, key: string,
    modifiers: { type: 'array', items: { type: 'string', enum: ['shift', 'control', 'alt', 'meta'] } }, x: { type: 'number', description: 'Viewport x for move/click; horizontal scroll delta for scroll.' }, y: { type: 'number', description: 'Viewport y for move/click; vertical scroll delta for scroll.' },
    toRef: { type: 'string', description: 'For drag: ref of the element to release over.' }, toSelector: { type: 'string', description: 'For drag: CSS selector of the element to release over.' },
    toX: { type: 'number', description: 'For drag: viewport x to release at.' }, toY: { type: 'number', description: 'For drag: viewport y to release at.' },
    value: { type: 'string', description: 'For select: the option value to choose.' }, label: { type: 'string', description: 'For select: the visible option label to choose (used when value is not given).' },
    steps: { type: 'array', items: { type: 'object' }, description: 'For batch: up to 25 action objects run sequentially; execution stops at the first error.' },
    code: { type: 'string', description: 'For eval: JS expression/function body evaluated in the page, returning a JSON-serializable value (max 16KB source, 15s timeout, ~48KB result cap).' },
    selector: { type: 'string', description: 'CSS selector targeting an element for click/type/press/move, resolved at dispatch with multi-point hit testing, so it stays valid inside batch across page changes where snapshot refs go stale. For wait: the selector that must exist before returning.' },
    timeout: { type: 'number', description: 'For wait: max milliseconds to wait (default 10000, cap 30000).' },
    visible: { type: 'boolean', description: 'For wait with selector: require the element to be rendered with a non-zero box, not merely present in the DOM.' },
    width: { type: 'number', description: 'For viewport: layout width in px (100-7680).' }, height: { type: 'number', description: 'For viewport: layout height in px (100-4320).' },
    scale: { type: 'number', description: 'For viewport: device scale factor (default 1).' },
    method: { type: 'string', description: 'For cdp: a Chrome DevTools Protocol method (Page.*, Runtime.*, Input.*, Emulation.*, Network.*, DOM.*, Accessibility.* and friends).' },
    params: { type: 'object', description: 'For cdp: method parameters object.' },
  }, ['tabId', 'epoch', 'action']), annotations: { readOnlyHint: false, openWorldHint: true } },
];
async function requestOnce(endpoint, method = 'GET', body, epoch) {
  let connection;
  try { connection = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('Configured browser unavailable: start its app or browser host first.'); }
  const url = new URL(connection.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !connection.token) throw new Error('Invalid local browser connection file.');
  let response;
  try {
    response = await fetch(new URL(endpoint, url), { method, headers: { Authorization: `Bearer ${connection.token}`, 'X-Hermes-Bot': botId, ...(botName ? { 'X-Hermes-Bot-Name': botName } : {}), ...(Number.isInteger(epoch) ? { 'X-Control-Epoch': String(epoch) } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(/\/(actions|action)$/.test(endpoint) ? 90000 : 25000) });
  } catch { throw new Error('Configured browser unavailable or timed out. Inspect existing task state before retrying an action.'); }
  let data;
  const raw = await response.text();
  try { data = raw ? JSON.parse(raw) : {}; } catch {
    const excerpt = raw.replace(/\s+/g, ' ').trim().slice(0, 120);
    throw new Error(`Browser request failed (${response.status})${excerpt ? `: ${excerpt}` : ''}`);
  }
  if (!response.ok) throw new Error(data.error || `Browser request failed (${response.status}).`);
  return data;
}
let hostChoice = { key: '', app: false };
// null means use the app's API; otherwise the in-process driver. Decided per
// connection (url + token), so an app restart or a host switch is re-checked.
async function computerService() {
  if (!localDriver) return null;
  let key = '';
  try { const connection = JSON.parse(fs.readFileSync(file, 'utf8')); key = `${connection.url}|${connection.token}`; } catch { /* requestOnce reports it */ }
  if (!key || hostChoice.key !== key) {
    const status = await requestOnce('/v1/status');
    const capabilities = Array.isArray(status && status.capabilities) ? status.capabilities : [];
    hostChoice = { key, app: capabilities.includes('computer') || capabilities.includes('computer-v2') };
  }
  return hostChoice.app ? null : require(localDriver).service;
}
async function request(endpoint, method = 'GET', body, epoch) {
  try {
    return await requestOnce(endpoint, method, body, epoch);
  } catch (error) {
    const next = /tab not found/i.test(error.message) ? retargetMissingTab(endpoint, method, continued) : null;
    if (!next) throw error;
    const continuedTab = decodeURIComponent(/^\/v1\/tabs\/([^/?]+)/.exec(next)[1]);
    try {
      try {
        const data = await requestOnce(next, method, body, epoch);
        if (data && typeof data === 'object') data.continuedTab = continuedTab;
        return data;
      } catch (retryError) {
        if (!needsContinuedEpoch(retryError.message, method)) throw retryError;
        const tab = await requestOnce('/v1/tabs/' + encodeURIComponent(continuedTab), 'GET');
        if (!Number.isInteger(tab && tab.epoch)) throw retryError;
        const data = await requestOnce(next, method, body, tab.epoch);
        if (data && typeof data === 'object') {
          data.continuedTab = continuedTab;
          data.continuedEpoch = tab.epoch;
        }
        return data;
      }
    } catch (finalError) {
      const message = String(finalError.message || '');
      if (message.includes('Keep working in tab')) throw finalError;
      let controls = '';
      if (/Stale or unknown reference/.test(message)) {
        try {
          const snap = await requestOnce('/v1/tabs/' + encodeURIComponent(continuedTab) + '/snapshot?maxChars=0&maxElements=40', 'GET');
          const elements = Array.isArray(snap && snap.elements) ? snap.elements.slice(0, 40) : [];
          controls = ' ' + JSON.stringify({ continuedTab, generation: snap && snap.generation, elements });
        } catch { /* the tab id in the error is still enough to continue */ }
      }
      throw new Error(message + ' The Mac tab is gone. Keep working in tab ' + continuedTab + (continued.url && continued.tabId === continuedTab ? ' at ' + continued.url : '') + '.' + controls);
    }
  }
}
const server = new Server({ name: 'hermes-cua-alans-way', version: '0.1.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  try {
    const args = params.arguments || {}; let result;
    const computer = params.name.startsWith('workspace_computer_') ? await computerService() : null;
    const tabPath = `/v1/tabs/${encodeURIComponent(args.tabId || '')}`;
    switch (params.name) {
      case 'cua_alans_way_status': result = await request('/v1/status'); break;
      case 'cua_alans_way_tabs': result = await request('/v1/tabs'); break;
      case 'cua_alans_way_open': result = await request('/v1/tabs', 'POST', { url: args.url, background: args.background !== false }); break;
      case 'cua_alans_way_snapshot': {
        const q = new URLSearchParams();
        q.set('maxChars', String(Number.isInteger(args.maxChars) ? args.maxChars : 2000));
        for (const key of ['maxElements', 'since']) if (Number.isInteger(args[key])) q.set(key, args[key]);
        result = await request(`${tabPath}/snapshot${q.size ? '?' + q : ''}`); break;
      }
      case 'cua_alans_way_screenshot': {
        const q = new URLSearchParams();
        if (typeof args.format === 'string') q.set('format', args.format);
        q.set('quality', String(Number.isInteger(args.quality) ? args.quality : 50));
        q.set('maxWidth', String(Number.isInteger(args.maxWidth) ? args.maxWidth : 960));
        const shot = await request(`${tabPath}/screenshot${q.size ? '?' + q : ''}`);
        const shotNote = { viewport: shot.viewport, note: 'Pointer coordinates use CSS viewport pixels; the image is downscaled to maxWidth, so scale screenshot pixels by viewport.width / image width.' };
        if (shot.continuedTab) shotNote.continuedTab = shot.continuedTab;
        return { content: [{ type: 'image', data: shot.base64, mimeType: shot.mimeType },
          { type: 'text', text: JSON.stringify(shotNote) }] };
      }
      case 'cua_alans_way_close':
        result = await request(tabPath, 'DELETE', undefined, args.epoch);
        break;
      case 'workspace_computer_apps':
        result = computer ? { apps: await computer.apps() } : await request('/v1/computer/apps');
        break;
      case 'workspace_computer_snapshot':
        result = computer
          ? await computer.snapshot(botId, args.pid, { since: args.since, menubar: args.menubar })
          : await request(`/v1/computer/${encodeURIComponent(String(args.pid))}/snapshot?${new URLSearchParams({
            ...(Number.isInteger(args.since) ? { since: args.since } : {}), ...(args.menubar ? { menubar: '1' } : {}) })}`);
        break;
      case 'workspace_computer_screenshot': {
        const shot = computer
          ? await computer.screenshot(args.pid, args.maxWidth)
          : await request(`/v1/computer/${encodeURIComponent(String(args.pid))}/screenshot${Number.isInteger(args.maxWidth) ? `?maxWidth=${args.maxWidth}` : ''}`);
        return { content: [
          { type: 'image', data: shot.image, mimeType: 'image/jpeg' },
          { type: 'text', text: JSON.stringify({
            imageWidth: shot.imageWidth, imageHeight: shot.imageHeight,
            window: { x: shot.windowX, y: shot.windowY, width: shot.windowWidth, height: shot.windowHeight },
            note: 'Click coordinates stay in snapshot space. Screen x = window.x + px * window.width / imageWidth; screen y = window.y + py * window.height / imageHeight.',
          }) },
        ] };
      }
      case 'workspace_computer_menu':
        result = computer
          ? await computer.menu(args.pid, args.path)
          : await request(`/v1/computer/${encodeURIComponent(String(args.pid))}/menu?${new URLSearchParams({ path: JSON.stringify(args.path || []) })}`);
        break;
      case 'workspace_computer_action': {
        const { pid, ...body } = args;
        result = computer
          ? await computer.action(botId, pid, body)
          : await request(`/v1/computer/${encodeURIComponent(String(pid))}/action`, 'POST', body);
        break;
      }
      case 'cua_alans_way_action': {
        const { tabId, ...body } = args;
        result = body.action === 'claim' || body.action === 'release'
          ? await request(`${tabPath}/control`, 'POST', { controller: body.action === 'claim' ? 'agent' : 'human' })
          : await request(`${tabPath}/actions`, 'POST', body);
        break;
      }
      default: throw new Error('Unknown browser tool.');
    }
    return { content: [{ type: 'text', text: JSON.stringify(omitIcons(result)) }] };
  } catch (error) { return { isError: true, content: [{ type: 'text', text: withContinuedTab(error.message, continued) }] }; }
  finally { reloadIfReplaced(); }
});
server.connect(new StdioServerTransport()).catch(() => { process.stderr.write('Browser MCP connection failed.\n'); process.exit(1); });
