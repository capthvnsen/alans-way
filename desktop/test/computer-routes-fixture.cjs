// Runs the app's real /v1/computer route table from main.cjs against fakes,
// so tests can drive leases and approvals without Electron or a Mac helper.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createDesktopLease } = require('../src/computer.cjs');
const { createDesktopApproval } = require('../src/desktop-approval.cjs');
const { calls, context, READ_BUDGET_MS } = require('../src/call-budget.cjs');

function computerRoutes(driver = {}, { approval = createDesktopApproval({ ask: async () => true, trusted: () => true }) } = {}) {
  const seen = [];
  const source = fs.readFileSync(path.join(__dirname, '../src/main.cjs'), 'utf8');
  const routes = source.slice(source.indexOf('const computerMatch ='), source.indexOf("const match = /^\\/v1\\/tabs"));
  assert.ok(routes.includes('hostComputer.action'), 'exercise the actual computer route table');
  const route = vm.runInNewContext(`async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const botId = req.headers['x-hermes-bot'] || '';
    const send = (status, body) => ({status, body});
    ${routes}
  }`, {
    approvalIdentity: () => undefined, registryFile: () => '', app: { getPath: () => '' }, API_TOKEN: 'synthetic',
    URL, AbortController, process: { platform: 'darwin' },
    calls, context, READ_BUDGET_MS,
    readJson: async req => req.body || {}, intParam: () => undefined,
    desktopLease: createDesktopLease(), desktopApproval: approval, nameForBot: id => id === 'a' ? 'Agent A' : '',
    hostComputer: { ...Object.fromEntries(['apps', 'launch', 'snapshot', 'screenshot', 'menu', 'action'].map(verb => [verb, async () => { seen.push(verb); return { ok: true }; }])), ...driver },
  });
  return {
    seen,
    route,
    request: async (url, botId = 'a', method = 'GET', headers = {}, body) => JSON.parse(JSON.stringify(await route({ url, method, body, headers: { ...headers, 'x-hermes-bot': botId } }, { on() {} }))),
  };
}

module.exports = { computerRoutes };
