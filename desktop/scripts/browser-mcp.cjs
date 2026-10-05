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
  { name: 'workspace_browser_status', description: 'Check the configured browser host and available hosts. Inspect host before acting; an unavailable computer is never replaced implicitly by another.', inputSchema: objectSchema(), annotations: { readOnlyHint: true } },
  { name: 'workspace_browser_tabs', description: 'List this bot’s assigned Chromium tabs with execution host and current control epochs. Mac and VPS logins are separate; bots on a host share sign-ins.', inputSchema: objectSchema(), annotations: { readOnlyHint: true } },
  { name: 'workspace_browser_open', description: 'Open a tab assigned to this bot. On the Mac connector, defaults to Mac; explicitly choose host vps for remote execution. A native VPS connector serves only VPS. Shared sign-ins within a host, separate tab ownership and input. Opens in the background.', inputSchema: objectSchema({ url: string, host:{type:'string',enum:['mac','vps']}, background: { type: 'boolean', default: true } }, ['url']), annotations: { readOnlyHint: false, openWorldHint: true } },
  { name: 'workspace_browser_snapshot', description: 'Read a tab and fresh interactive element refs. Refs describe the top document; use screenshot for iframe content. Request a new snapshot after every action.', inputSchema: objectSchema({ tabId: string }, ['tabId']), annotations: { readOnlyHint: true } },
  { name: 'workspace_browser_screenshot', description: 'View the assigned browser tab on its execution host as a PNG image.', inputSchema: objectSchema({ tabId: string }, ['tabId']), annotations: { readOnlyHint: true } },
  { name: 'workspace_browser_action', description: 'Use the bot’s own cursor and keyboard in its assigned Chromium tab, including background tabs; never moves the human’s system mouse or types into another tab. Include current epoch. move/click accept a fresh ref, a selector, or viewport x,y; type replaces the text of a fresh ref or selector; press sends a key to that tab (optional ref/selector); scroll uses x,y as deltas. batch runs a steps array of these actions in one call — prefer it for multi-step work, it collapses many round-trips into one. eval runs JS in the page and returns the JSON result — use it to read DOM state, extract data, or do a whole interaction in one call; keep results small. wait blocks until a selector exists or text appears in the page (up to timeout ms) — use it inside batch between actions so steps land on a ready page. The Agent cursor marks dispatched input. Stops during human takeover. Do not retry an uncertain submission; inspect the page first.', inputSchema: objectSchema({
    tabId: string, epoch: { type: 'integer' }, action: { type: 'string', enum: ['navigate', 'move', 'click', 'type', 'press', 'scroll', 'back', 'forward', 'reload', 'batch', 'eval', 'wait'] }, ref: string, text: string, url: string, key: string,
    modifiers: { type: 'array', items: { type: 'string', enum: ['shift', 'control', 'alt', 'meta'] } }, x: { type: 'number', description: 'Viewport x for move/click; horizontal scroll delta for scroll.' }, y: { type: 'number', description: 'Viewport y for move/click; vertical scroll delta for scroll.' },
    steps: { type: 'array', items: { type: 'object' }, description: 'For batch: up to 25 action objects run sequentially; execution stops at the first error.' },
    code: { type: 'string', description: 'For eval: JS expression/function body evaluated in the page, returning a JSON-serializable value (max 16KB source, 15s timeout, ~48KB result cap).' },
    selector: { type: 'string', description: 'CSS selector targeting an element for click/type/press/move — resolved at dispatch, so it stays valid inside batch across page changes where snapshot refs go stale. For wait: the selector that must exist before returning.' },
    timeout: { type: 'number', description: 'For wait: max milliseconds to wait (default 10000, cap 30000).' },
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
      case 'workspace_browser_snapshot': result = await request(`${tabPath}/snapshot`); break;
      case 'workspace_browser_screenshot': {
        const shot = await request(`${tabPath}/screenshot`); return { content: [{ type: 'image', data: shot.base64, mimeType: shot.mimeType },
          { type: 'text', text: JSON.stringify({ viewport: shot.viewport, note: 'Pointer coordinates use CSS viewport pixels. Divide screenshot pixel coordinates by deviceScaleFactor on Retina displays.' }) }] };
      }
      case 'workspace_browser_action': { const { tabId, ...body } = args; result = await request(`${tabPath}/actions`, 'POST', body); break; }
      default: throw new Error('Unknown browser tool.');
    }
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
});
server.connect(new StdioServerTransport()).catch(() => { process.stderr.write('Browser MCP connection failed.\n'); process.exit(1); });
