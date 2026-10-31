// Runs the app's real /v1/computer route table from main.cjs against fakes,
// so tests can drive leases and approvals without Electron or a Mac helper.
const { createDesktopLease } = require('../src/computer.cjs');
const { createDesktopApproval } = require('../src/desktop-approval.cjs');

function computerRoutes(driver = {}, { approval = createDesktopApproval({ ask: async () => true, trusted: () => true }), identityFor } = {}) {
  const seen = [];
  const handle = require('../src/computer-http.cjs').createComputerRoutes({
    identityFor, readJson: async req => req.body || {}, intParam: () => undefined,
    desktopLease: createDesktopLease(), desktopApproval: approval, nameForBot: id => id === 'a' ? 'Agent A' : '',
    hostComputer: { ...Object.fromEntries(['apps', 'launch', 'snapshot', 'screenshot', 'menu', 'action'].map(verb => [verb, async () => { seen.push(verb); return { ok: true }; }])), ...driver },
  });
  const route = async (req, res) => {
    let result;
    await handle(req, res, new URL(req.url, 'http://127.0.0.1'), req.headers['x-hermes-bot'] || '', (status, body) => { result = { status, body }; });
    return result;
  };

  return {
    seen,
    route,
    request: async (url, botId = 'a', method = 'GET', headers = {}, body) => JSON.parse(JSON.stringify(await route({ url, method, body, headers: { ...headers, 'x-hermes-bot': botId } }, { on() {} }))),
  };
}

module.exports = { computerRoutes };
