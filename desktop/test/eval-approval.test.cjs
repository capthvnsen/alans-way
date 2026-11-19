const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { findChrome, startStack } = require('../eval/runtime.cjs');
const { connectTools } = require('../eval/tools.cjs');
const { createFixtures } = require('../eval/fixtures.cjs');
const { tasks } = require('../eval/tasks.cjs');

test('the action tool declares every field the commit gate tells the model to send', async (t) => {
  const gate = fs.readFileSync(path.join(__dirname, '../src/agent-input.cjs'), 'utf8').match(/with commit: \{([^}]*)\}/)[1].split(',').map((f) => f.trim().replace('?', ''));
  assert.deepEqual(gate, ['kind', 'summary', 'amount', 'currency', 'counterparty']);
  const client = new Client({ name: 'schema-check', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(__dirname, '../scripts/browser-mcp.cjs'), '--bot-id', 'schema-check'] });
  t.after(() => client.close().catch(() => {}));
  await client.connect(transport);
  const action = (await client.listTools()).tools.find((x) => x.name === 'cua_alans_way_action');
  const commit = action.inputSchema.properties.commit;
  assert.ok(commit, 'a model that follows the commit_required message must be able to send commit');
  assert.deepEqual(Object.keys(commit.properties), gate);
  assert.deepEqual(commit.required, ['kind', 'summary']);
});

test('tasks that end in a gated action say so', () => {
  const expects = tasks.filter((x) => x.approval).map((x) => x.id).sort();
  assert.deepEqual(expects, ['fx-flaky-overlay', 'fx-paginate-max', 'pub-form-multifield']);
});

test('the harness grants approval only when the task expects it and the model asked for it', { skip: !findChrome() && 'no Chrome', timeout: 120000 }, async (t) => {
  const fixtures = await createFixtures();
  const stack = await startStack({ fixturePort: fixtures.port });
  const tools = await connectTools(stack);
  t.after(async () => { await tools.close(); fixtures.close(); await stack.stop(); });
  const url = `http://fixture.example:${fixtures.port}/f/flaky`;
  const click = (extra) => tools.raw('cua_alans_way_action', { tabId: tools.tab.id, epoch: tools.tab.epoch, action: 'click', name: 'Confirm order', ...extra });
  const commit = { kind: 'purchase', summary: 'Confirm order #1 on the local fixture' };
  const fresh = async () => { fixtures.reset(); await stack.closeTabs(); await tools.open(url); await tools.raw('cua_alans_way_action', { tabId: tools.tab.id, epoch: tools.tab.epoch, action: 'wait', selector: '#ov', gone: true, timeout: 6000 }); stack.approvals.length = 0; };

  await fresh();
  stack.approvalOrigin = new URL(url).origin;
  await assert.rejects(click(), /commit_required/, 'without a request from the model the gate still refuses');
  assert.equal(fixtures.state.reports.flaky?.clicks ?? 0, 0);
  assert.deepEqual(stack.approvals, []);

  await click({ commit });
  assert.equal(fixtures.state.reports.flaky.clicks, 1);
  assert.equal(stack.approvals.length, 1);
  assert.equal(stack.approvals[0].grantedBy, 'harness');
  assert.equal(stack.approvals[0].summary, commit.summary);

  await fresh();
  stack.approvalOrigin = null;
  await assert.rejects(click({ commit }), /commit_required/, 'a task that does not expect approval never gets one');
  assert.equal(fixtures.state.reports.flaky?.clicks ?? 0, 0);

  await fresh();
  stack.approvalOrigin = 'http://elsewhere.example';
  await assert.rejects(click({ commit }), /commit_required/, 'approval stays on the origin the task starts on');
  assert.equal(fixtures.state.reports.flaky?.clicks ?? 0, 0);
  assert.deepEqual(stack.approvals, []);
});
