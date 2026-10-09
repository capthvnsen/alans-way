// Talks to the real browser-mcp.cjs over stdio, exactly as Hermes does, so the
// oracle exercises the shipped tool surface (names, schemas, reply shapes).
const path = require('node:path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

async function connectTools(stack) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(__dirname, '../scripts/browser-mcp.cjs'), '--bot-id', stack.botId, '--connection', stack.connFile] });
  const client = new Client({ name: 'eval-oracle', version: '0.1.0' }, { capabilities: {} });
  await client.connect(transport);
  const m = { calls: 0, errors: 0, bytes: 0, byTool: {} };
  const t = {
    metrics: m,
    resetMetrics() { Object.assign(m, { calls: 0, errors: 0, bytes: 0, byTool: {} }); },
    async raw(name, args) {
      m.calls++; m.byTool[name] = (m.byTool[name] || 0) + 1;
      const r = await client.callTool({ name, arguments: args });
      const text = (r.content || []).map((c) => c.type === 'text' ? c.text : `[${c.type}]`).join('');
      m.bytes += JSON.stringify(r.content || '').length;
      if (r.isError) { m.errors++; throw Object.assign(new Error(text), { tool: name }); }
      try { return JSON.parse(text); } catch { return text; }
    },
    tab: null, els: [],
    ref(rx, role) { const e = t.els.find((x) => rx.test(x.name || '') && (!role || x.role === role)); if (!e) throw new Error(`no element ${rx} in ${JSON.stringify(t.els.map((x) => x.role + ':' + x.name))}`); return e.ref; },
    async open(url) { const r = await t.raw('cua_alans_way_open', { url }); t.tab = { id: r.id, epoch: r.epoch }; return r; },
    act: async (body) => { const r = await t.raw('cua_alans_way_action', { tabId: t.tab.id, epoch: t.tab.epoch, ...body }); if (r && r.elements) t.els = r.elements; return r; },
    snapshot: async (a = {}) => { const r = await t.raw('cua_alans_way_snapshot', { tabId: t.tab.id, ...a }); if (r && r.elements) t.els = r.elements; return r; },
    screenshot: (a = {}) => t.raw('cua_alans_way_screenshot', { tabId: t.tab.id, ...a }),
    tools: async () => (await client.listTools()).tools.map((x) => x.name),
    close: () => client.close(),
  };
  return t;
}
module.exports = { connectTools };
