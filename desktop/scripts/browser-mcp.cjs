#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
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
const tools = [
  { name: 'workspace_browser_status', description: 'Check the configured browser host and available hosts. Inspect host before acting; an unavailable computer is never replaced implicitly by another. Host selection is decided by the connector at spawn and re-converges on its own when Mac availability flips — on a tool error just retry once, and if it still fails report it; never restart, kill, or edit connector processes to steer the host.', inputSchema: objectSchema(), annotations: { readOnlyHint: true } },
  { name: 'workspace_browser_tabs', description: 'List this bot’s owned Chromium tabs with execution host and current control epochs. Mac and VPS logins are separate; bots on a host share sign-ins.', inputSchema: objectSchema(), annotations: { readOnlyHint: true } },
  { name: 'workspace_browser_open', description: 'Open a tab owned by this bot — the default surface for web-shaped work; use it whenever a task needs a site or web app with no API. No human handoff, assignment, grant, or approval is ever needed: the call itself creates your tab. On the Mac connector, defaults to Mac — keep it there whenever the Mac is reachable; host vps is only for work that must outlive the Mac sleeping or when the user names the VPS. A native VPS connector serves only VPS. Shared sign-ins within a host, separate tab ownership and input. Opens in the background.', inputSchema: objectSchema({ url: string, host:{type:'string',enum:['mac','vps']}, background: { type: 'boolean', default: true } }, ['url']), annotations: { readOnlyHint: false, openWorldHint: true } },
  { name: 'workspace_browser_snapshot', description: 'Read a tab: bounded page text plus fresh interactive element refs (a map, not the whole DOM). Refs describe the top document; use screenshot for iframe content. Request a new snapshot after every action; pass since=<last generation> for a cheap {unchanged:true} when the page is identical.', inputSchema: objectSchema({ tabId: string, maxChars: { type: 'integer', description: 'Cap on returned page text, default 6000, max 20000.' }, maxElements: { type: 'integer', description: 'Cap on interactive element refs, default 150, max 300.' }, since: { type: 'integer', description: 'Generation from the previous snapshot; returns {unchanged:true} when content is identical.' } }, ['tabId']), annotations: { readOnlyHint: true } },
  { name: 'workspace_browser_screenshot', description: 'View the assigned browser tab on its execution host as an image. Defaults to compact jpeg; png keeps alpha.', inputSchema: objectSchema({ tabId: string, format: { type: 'string', enum: ['jpeg', 'png', 'webp'], description: 'Image format, default jpeg.' }, quality: { type: 'integer', description: 'jpeg/webp quality 1-100, default 70.' }, maxWidth: { type: 'integer', description: 'Downscale cap on image width in px, default 1280.' } }, ['tabId']), annotations: { readOnlyHint: true } },
  { name: 'workspace_browser_action', description: 'Use the bot’s own cursor and keyboard in its assigned Chromium tab, including background tabs; never moves the human’s system mouse or types into another tab. Include current epoch. move/click accept a fresh ref, a selector, or viewport x,y; type replaces the text of a fresh ref or selector; press sends a key to that tab (optional ref/selector); scroll uses x,y as deltas. batch runs a steps array of these actions in one call — prefer it for multi-step work, it collapses many round-trips into one. eval runs JS in the page and returns the JSON result — use it to read DOM state, extract data, or do a whole interaction in one call; keep results small. wait blocks until a selector exists, text appears, or the url contains a substring (up to timeout ms) — use it inside batch between actions so steps land on a ready page; add visible:true to require the selector to be actually rendered, not just present. viewport sets the tab layout size (a page that renders narrow or collapsed can be widened this way). cdp sends a raw Chrome DevTools Protocol command for anything the named actions do not cover. The Agent cursor marks dispatched input. Stops during human takeover. If a tab reports human_has_control, call action "claim" to take control back yourself — this bot has priority in the in-app browser; no human involvement is needed and the human can always grab it back by interacting. claim returns a fresh epoch to use for following actions. action "release" hands a tab back to the human. Do not retry an uncertain submission; inspect the page first.', inputSchema: objectSchema({
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
async function request(endpoint, method = 'GET', body) {
  let connection;
  try { connection = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('Configured browser unavailable: start its app or browser host first.'); }
  const url = new URL(connection.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !connection.token) throw new Error('Invalid local browser connection file.');
  let response;
  try {
    response = await fetch(new URL(endpoint, url), { method, headers: { Authorization: `Bearer ${connection.token}`, 'X-Hermes-Bot': botId, ...(botName ? { 'X-Hermes-Bot-Name': botName } : {}), 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(25000) });
  } catch { throw new Error('Configured browser unavailable or timed out. Inspect existing task state before retrying an action.'); }
  const data = await response.json(); if (!response.ok) throw new Error(data.error || `Browser request failed (${response.status}).`); return data;
}
const server = new Server({ name: 'hermes-workspace-browser', version: '0.1.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  try {
    const args = params.arguments || {}; let result;
    const tabPath = `/v1/tabs/${encodeURIComponent(args.tabId || '')}`;
    switch (params.name) {
      case 'workspace_browser_status': result = await request('/v1/status'); break;
      case 'workspace_browser_tabs': result = await request('/v1/tabs'); break;
      case 'workspace_browser_open': result = await request('/v1/tabs', 'POST', { url: args.url, host:args.host, background: args.background !== false }); break;
      case 'workspace_browser_snapshot': {
        const q = new URLSearchParams();
        for (const key of ['maxChars', 'maxElements', 'since']) if (Number.isInteger(args[key])) q.set(key, args[key]);
        result = await request(`${tabPath}/snapshot${q.size ? '?' + q : ''}`); break;
      }
      case 'workspace_browser_screenshot': {
        const q = new URLSearchParams();
        if (typeof args.format === 'string') q.set('format', args.format);
        for (const key of ['quality', 'maxWidth']) if (Number.isInteger(args[key])) q.set(key, args[key]);
        const shot = await request(`${tabPath}/screenshot${q.size ? '?' + q : ''}`);
        return { content: [{ type: 'image', data: shot.base64, mimeType: shot.mimeType },
          { type: 'text', text: JSON.stringify({ viewport: shot.viewport, note: 'Pointer coordinates use CSS viewport pixels; the image is downscaled to maxWidth, so scale screenshot pixels by viewport.width / image width.' }) }] };
      }
      case 'workspace_browser_action': {
        const { tabId, ...body } = args;
        result = body.action === 'claim' || body.action === 'release'
          ? await request(`${tabPath}/control`, 'POST', { controller: body.action === 'claim' ? 'agent' : 'human' })
          : await request(`${tabPath}/actions`, 'POST', body);
        break;
      }
      default: throw new Error('Unknown browser tool.');
    }
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
});
server.connect(new StdioServerTransport()).catch(() => { process.stderr.write('Browser MCP connection failed.\n'); process.exit(1); });
