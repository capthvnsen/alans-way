#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const computer = process.platform === 'darwin' ? require('../src/computer.cjs') : require('../src/vps-computer.cjs');
const { createComputerSnapshots } = require('../src/computer-snapshot.cjs');
const { connectorReplaced } = require('../src/connector-reload.cjs');
const { omitIcons } = require('../src/omit-icons.cjs');
const { retargetMissingTab, needsContinuedEpoch } = require('../src/core.cjs');
const computerSnapshot = createComputerSnapshots();
const watched = [
  __filename,
  path.join(__dirname, '..', 'src', 'omit-icons.cjs'),
  path.join(__dirname, '..', 'src', 'computer-snapshot.cjs'),
  path.join(__dirname, '..', 'src', process.platform === 'darwin' ? 'computer.cjs' : 'vps-computer.cjs'),
];
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
const file = (connectionIndex>=0?process.argv[connectionIndex+1]:undefined) || process.env.HERMES_WORKSPACE_CONNECTION || path.join(os.homedir(), 'Library', 'Application Support', 'Hermes Workspace', 'connection.json');
const objectSchema = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const string = { type: 'string' };
function continuedFromArgv(argv) {
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
function withContinuedTab(message, page) {
  const text = String(message || '');
  if (!page || !/tab not found/i.test(text)) return text;
  return text + ' The Mac tab is gone. Keep working in tab ' + page.tabId + ' at ' + page.url + '.';
}
const continued = continuedFromArgv(process.argv);
const continuedNote = continued
  ? ' The Mac page was continued in this browser as tab ' + continued.tabId + ' at ' + continued.url + '. Keep working in that tab.'
  : '';
const tools = [
  { name: 'cua_alans_way_status', description: 'Check the configured browser host and available hosts. Inspect host before acting; an unavailable computer is never replaced implicitly by another. Host selection is decided by the connector at spawn and re-converges on its own when Mac availability flips — on a tool error just retry once, and if it still fails report it; never restart, kill, or edit connector processes to steer the host. If the Mac goes offline mid-task, the connector continues the last https page in the VPS browser. If the [workspace] line names a tab, keep working in that tab. If it only names a URL, reopen the same URL and continue. Calls that do not run on the Mac keep going.' + continuedNote, inputSchema: objectSchema(), annotations: { readOnlyHint: true } },
  { name: 'cua_alans_way_tabs', description: 'List this bot’s owned Chromium tabs with execution host and current control epochs. Mac and VPS logins are separate; bots on a host share sign-ins.', inputSchema: objectSchema(), annotations: { readOnlyHint: true } },
  { name: 'cua_alans_way_open', description: 'Open a tab in this connector browser. This is the in-app Mac browser whenever the Mac is reachable, and the VPS browser when the Mac is not. Do not pass host; the connector already chose the machine. No human handoff, assignment, grant, or approval is ever needed. Shared sign-ins within a host, separate tab ownership and input. Opens in the background.', inputSchema: objectSchema({ url: string, host:{type:'string',enum:['mac','vps'], description: 'Ignored. The connector already chose the Mac when it is reachable and the VPS when it is not.'}, background: { type: 'boolean', default: true } }, ['url']), annotations: { readOnlyHint: false, openWorldHint: true } },
  { name: 'cua_alans_way_snapshot', description: 'Read a tab: bounded page text plus interactive elements in elements[] ({ref, role, name, …}). role is usually the lowercase tag (a, input, button, div) or an ARIA role. Menu items, options, tree items, sliders, and clickable divs are included by name. Controls inside an open shadow root are included too; a closed root is not. A name can come from aria-labelledby. A pressed toggle ends in on or off. loading:true means the document was still parsing after a 400ms grace. Same-origin frames are included. A cross-origin frame is not readable; screenshot that frame only. Pass since=<last generation> for a cheap {unchanged:true}. Request a fresh snapshot after actions that change the page; action responses include generation/url/title/loading so you can often skip one.', inputSchema: objectSchema({ tabId: string, maxChars: { type: 'integer', description: 'Cap on returned page text. Default 2000. Raise it up to 20000 when you need more of the page.' }, maxElements: { type: 'integer', description: 'Cap on interactive element refs, default 150, max 300.' }, since: { type: 'integer', description: 'Generation from the previous snapshot; returns {unchanged:true} when content is identical.' } }, ['tabId']), annotations: { readOnlyHint: true } },
  { name: 'cua_alans_way_screenshot', description: 'Capture the tab viewport as an image file. Hermes delivers it as MEDIA:<path> — run a vision step on that path to see pixels. Defaults to compact jpeg; png keeps alpha.', inputSchema: objectSchema({ tabId: string, format: { type: 'string', enum: ['jpeg', 'png', 'webp'], description: 'Image format, default jpeg.' }, quality: { type: 'integer', description: 'jpeg/webp quality 1-100, default 50.' }, maxWidth: { type: 'integer', description: 'Downscale cap on image width in px, default 960.' } }, ['tabId']), annotations: { readOnlyHint: true } },
  { name: 'cua_alans_way_close', description: 'Close a tab this bot owns. Pass the current epoch. Required to free VPS tabs (global cap 40).', inputSchema: objectSchema({ tabId: string, epoch: { type: 'integer' } }, ['tabId', 'epoch']), annotations: { readOnlyHint: false, openWorldHint: true } },
  { name: 'workspace_computer_apps', description: 'List desktop apps the agent can drive without taking the focused window. These apps are on the same machine as the browser: the Mac when it is reachable, otherwise the Linux desktop. On a Mac that is every background app. On a Linux desktop that is every app except the focused one. Keychain and password fields are off limits. Web work stays on cua_alans_way. Never moves the pointer.', inputSchema: objectSchema(), annotations: { readOnlyHint: true } },
  { name: 'workspace_computer_snapshot', description: 'Read one desktop app: elements[] with ref, role, and name. On a Mac, elements also include screen x,y,width,height. Prefer press by ref. Pass since=<last generation> for a cheap {unchanged:true} when the tree is the same. Take a fresh snapshot after the app changes. Refuses the focused window.', inputSchema: objectSchema({ pid: { type: 'integer' }, since: { type: 'integer', description: 'Generation from the previous snapshot. Returns {unchanged:true} when the tree is identical.' } }, ['pid']), annotations: { readOnlyHint: true } },
  { name: 'workspace_computer_screenshot', description: 'Capture one app window as a small jpeg. Use only when the snapshot has no named control for what you need, such as a canvas or a chart. Never a full screen. On a Mac, scale image pixels by window.width / imageWidth. Refuses the focused window and Keychain.', inputSchema: objectSchema({ pid: { type: 'integer' }, maxWidth: { type: 'integer', description: 'Downscale cap in px, default 960, max 1280.' } }, ['pid']), annotations: { readOnlyHint: true } },
  { name: 'workspace_computer_action', description: 'Act in a desktop app without moving the pointer. press uses a snapshot ref. type replaces the text of a ref and does not send keystrokes. click uses snapshot x,y and lands on the control at that point. drag uses snapshot coordinates; it sets a slider from the end point, and on Linux a scroll bar too. batch runs up to 25 steps. The result includes generation. unchanged:true means the tree is the same and no new snapshot is needed. elements, when present, is the fresh tree. Refuses the focused window, Keychain, and password fields.', inputSchema: objectSchema({
    pid: { type: 'integer' },
    action: { type: 'string', enum: ['press', 'click', 'drag', 'type', 'batch'] },
    ref: string,
    text: { type: 'string', description: 'For type: the replacement text, at most 2000 characters. Password fields are refused.' },
    x: { type: 'number' }, y: { type: 'number' }, x2: { type: 'number' }, y2: { type: 'number' },
    steps: { type: 'array', items: { type: 'object' }, description: 'For batch: up to 25 press, click, or drag steps.' },
  }, ['pid', 'action']), annotations: { readOnlyHint: false } },
  { name: 'cua_alans_way_action', description: 'Use the bot’s own cursor and keyboard in its assigned Chromium tab, including background tabs; never moves the human’s system mouse or types into another tab. Include current epoch. move/click accept a fresh ref, a selector, or viewport x,y; type replaces the text of a fresh ref or selector; press sends a key to that tab (optional ref/selector); scroll uses x,y as deltas. batch runs up to 25 steps in one call — prefer it; use selectors or refs from one snapshot (refs stay valid for the whole batch unless the page navigates). eval runs JS in the page; keep results small. wait blocks until a selector exists, text appears, or the url contains a substring — after navigate, wait on url or a new-page selector, not body alone. viewport sets layout size. cdp sends an allowlisted DevTools command. Each result includes generation, url, title, loading. click, type, press, scroll, navigate, and batch also include elements (up to 40 controls, no page text) when the page can be read; use those refs and skip a snapshot. Three identical failing calls pause this connector ~60s — change approach instead of retrying the same call. Stops during human takeover. claim/release change control; claim returns a fresh epoch. Do not retry an uncertain submission; inspect the page first.', inputSchema: objectSchema({
    tabId: string, epoch: { type: 'integer' }, action: { type: 'string', enum: ['navigate', 'move', 'click', 'type', 'press', 'scroll', 'back', 'forward', 'reload', 'batch', 'eval', 'wait', 'viewport', 'cdp', 'claim', 'release'] }, ref: string, text: string, url: string, key: string,
    modifiers: { type: 'array', items: { type: 'string', enum: ['shift', 'control', 'alt', 'meta'] } }, x: { type: 'number', description: 'Viewport x for move/click; horizontal scroll delta for scroll.' }, y: { type: 'number', description: 'Viewport y for move/click; vertical scroll delta for scroll.' },
    steps: { type: 'array', items: { type: 'object' }, description: 'For batch: up to 25 action objects run sequentially; execution stops at the first error.' },
    code: { type: 'string', description: 'For eval: JS expression/function body evaluated in the page, returning a JSON-serializable value (max 16KB source, 15s timeout, ~48KB result cap).' },
    selector: { type: 'string', description: 'CSS selector targeting an element for click/type/press/move — resolved at dispatch with multi-point hit testing, so it stays valid inside batch across page changes where snapshot refs go stale. For wait: the selector that must exist before returning.' },
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
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(endpoint.endsWith('/actions') ? 90000 : 25000) });
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
async function request(endpoint, method = 'GET', body, epoch) {
  try {
    return await requestOnce(endpoint, method, body, epoch);
  } catch (error) {
    const next = /tab not found/i.test(error.message) ? retargetMissingTab(endpoint, method, continued) : null;
    if (!next) throw error;
    try {
      try {
        const data = await requestOnce(next, method, body, epoch);
        if (data && typeof data === 'object') data.continuedTab = continued.tabId;
        return data;
      } catch (retryError) {
        if (!needsContinuedEpoch(retryError.message, method)) throw retryError;
        const tab = await requestOnce('/v1/tabs/' + encodeURIComponent(continued.tabId), 'GET');
        if (!Number.isInteger(tab && tab.epoch)) throw retryError;
        const data = await requestOnce(next, method, body, tab.epoch);
        if (data && typeof data === 'object') {
          data.continuedTab = continued.tabId;
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
          const snap = await requestOnce('/v1/tabs/' + encodeURIComponent(continued.tabId) + '/snapshot?maxChars=0&maxElements=40', 'GET');
          const elements = Array.isArray(snap && snap.elements) ? snap.elements.slice(0, 40) : [];
          controls = ' ' + JSON.stringify({ continuedTab: continued.tabId, generation: snap && snap.generation, elements });
        } catch { /* the tab id in the error is still enough to continue */ }
      }
      throw new Error(message + ' The Mac tab is gone. Keep working in tab ' + continued.tabId + ' at ' + continued.url + '.' + controls);
    }
  }
}
const server = new Server({ name: 'hermes-cua-alans-way', version: '0.1.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  try {
    const args = params.arguments || {}; let result;
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
      case 'workspace_computer_apps': result = { apps: computer.apps() }; break;
      case 'workspace_computer_snapshot':
        result = computerSnapshot(args.pid, computer.snapshot(args.pid), args.since);
        break;
      case 'workspace_computer_screenshot': {
        const shot = computer.screenshot(args.pid, args.maxWidth);
        return { content: [
          { type: 'image', data: shot.image, mimeType: 'image/jpeg' },
          { type: 'text', text: JSON.stringify({
            imageWidth: shot.imageWidth, imageHeight: shot.imageHeight,
            window: { x: shot.windowX, y: shot.windowY, width: shot.windowWidth, height: shot.windowHeight },
            note: 'Click coordinates stay in snapshot space. Scale image pixels by window.width / imageWidth.',
          }) },
        ] };
      }
      case 'workspace_computer_action': {
        const step = (body) => {
          if (body.action === 'press') return computer.press(args.pid, body.ref);
          if (body.action === 'click') return computer.click(args.pid, body.x, body.y);
          if (body.action === 'drag') return computer.drag(args.pid, body.x, body.y, body.x2, body.y2);
          if (body.action === 'type') return computer.type(args.pid, body.ref, body.text);
          throw new Error('Computer action must be press, click, drag, type, or batch.');
        };
        if (args.action === 'batch') {
          const steps = Array.isArray(args.steps) ? args.steps.slice(0, 25) : [];
          const results = [];
          for (const item of steps) {
            try { results.push(step(item || {})); }
            catch (error) { results.push({ error: error.message }); break; }
          }
          result = { results };
        } else result = step(args);
        try {
          const observed = computerSnapshot.observe(args.pid, computer.snapshot(args.pid));
          result = observed.unchanged
            ? { ...result, unchanged: true, generation: observed.generation }
            : { ...result, generation: observed.generation, elements: observed.elements };
        } catch { /* the action stands even when a follow-up read is refused */ }
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
