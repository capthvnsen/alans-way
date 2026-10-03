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
  process.stderr.write('Usage: node browser-mcp.cjs --bot-id YOUR_BOT_ID\n'); process.exit(1);
}
const file = process.env.HERMES_WORKSPACE_CONNECTION || path.join(os.homedir(), 'Library', 'Application Support', 'Hermes Workspace', 'connection.json');
const objectSchema = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const string = { type: 'string' };
const tools = [
  { name: 'workspace_browser_status', description: 'Check the Mac browser connection. The browser runs on the Mac; offline means unavailable, never a fallback to the VPS.', inputSchema: objectSchema(), annotations: { readOnlyHint: true } },
  { name: 'workspace_browser_tabs', description: 'List this bot’s assigned Mac Chromium tabs with current control epochs.', inputSchema: objectSchema(), annotations: { readOnlyHint: true } },
  { name: 'workspace_browser_open', description: 'Open a new Mac browser tab assigned to this bot. Uses the workspace’s shared local login profile. Opens in the background by default and leaves the human’s selected tab and keyboard focus alone.', inputSchema: objectSchema({ url: string, background: { type: 'boolean', default: true } }, ['url']), annotations: { readOnlyHint: false, openWorldHint: true } },
  { name: 'workspace_browser_snapshot', description: 'Read a tab and fresh interactive element refs. Refs describe the top document; use screenshot for iframe content. Request a new snapshot after every action.', inputSchema: objectSchema({ tabId: string }, ['tabId']), annotations: { readOnlyHint: true } },
  { name: 'workspace_browser_screenshot', description: 'View the assigned Mac tab as a PNG image.', inputSchema: objectSchema({ tabId: string }, ['tabId']), annotations: { readOnlyHint: true } },
  { name: 'workspace_browser_action', description: 'Use the bot’s own cursor and keyboard in its assigned Chromium tab, including background tabs; never moves the human’s system mouse or types into another tab. Include current epoch. move/click accept a fresh ref or viewport x,y; type replaces a fresh ref’s text; press sends a key to that tab (optional ref); scroll uses x,y as deltas. The Agent cursor marks dispatched input. Stops during human takeover. Do not retry an uncertain submission; inspect the page first.', inputSchema: objectSchema({
    tabId: string, epoch: { type: 'integer' }, action: { type: 'string', enum: ['navigate', 'move', 'click', 'type', 'press', 'scroll', 'back', 'forward', 'reload'] }, ref: string, text: string, url: string, key: string,
    modifiers: { type: 'array', items: { type: 'string', enum: ['shift', 'control', 'alt', 'meta'] } }, x: { type: 'number', description: 'Viewport x for move/click; horizontal scroll delta for scroll.' }, y: { type: 'number', description: 'Viewport y for move/click; vertical scroll delta for scroll.' },
  }, ['tabId', 'epoch', 'action']), annotations: { readOnlyHint: false, openWorldHint: true } },
];
async function request(endpoint, method = 'GET', body) {
  let connection;
  try { connection = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error("Mac browser unavailable: open Hermes- Alan's way first."); }
  const url = new URL(connection.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !connection.token) throw new Error('Invalid local browser connection file.');
  let response;
  try {
    response = await fetch(new URL(endpoint, url), { method, headers: { Authorization: `Bearer ${connection.token}`, 'X-Hermes-Bot': botId, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(25000) });
  } catch { throw new Error('Mac browser unavailable or timed out. Inspect existing task state before retrying an action.'); }
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
      case 'workspace_browser_open': result = await request('/v1/tabs', 'POST', { url: args.url, background: args.background !== false }); break;
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
