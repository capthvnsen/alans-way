const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createDesktopLease } = require('../src/computer.cjs');
const { calls, context, READ_BUDGET_MS } = require('../src/call-budget.cjs');

test('desktop input takes, refreshes and expires a lease by bot ID', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const take = createDesktopLease();
  assert.equal(take('a', 'Agent A'), null);
  t.mock.timers.tick(19000);
  assert.equal(take('a', 'Agent A'), null);
  t.mock.timers.tick(19999);
  assert.deepEqual(take('b'), { error: 'desktop_busy', holder: 'Agent A', retryAfter: 1 });
  t.mock.timers.tick(1);
  assert.equal(take('b'), null);
  assert.deepEqual(take('a'), { error: 'desktop_busy', holder: 'b', retryAfter: 20 });
});

function computerRoutes() {
  const seen = [];
  const source = fs.readFileSync(path.join(__dirname, '../src/main.cjs'), 'utf8');
  const routes = source.slice(source.indexOf('const computerMatch ='), source.indexOf("const match = /^\\/v1\\/tabs"));
  assert.ok(routes.includes('hostComputer.action'), 'exercise the actual computer route table');
  const route = vm.runInNewContext(`async (req) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const botId = req.headers['x-hermes-bot'] || '';
    const send = (status, body) => ({status, body});
    ${routes}
  }`, {
    URL, AbortController, process: { platform: 'darwin' },
    res: { on() {} }, calls, context, READ_BUDGET_MS,
    readJson: async req => req.body || {}, intParam: () => undefined,
    takeDesktopLease: createDesktopLease(), nameForBot: id => id === 'a' ? 'Agent A' : '',
    hostComputer: Object.fromEntries(['apps', 'launch', 'snapshot', 'screenshot', 'menu', 'action'].map(verb => [verb, async () => { seen.push(verb); return { ok: true }; }])),
  });
  return {
    seen,
    request: async (url, botId = 'a', method = 'GET', headers = {}) => JSON.parse(JSON.stringify(await route({ url, method, headers: { ...headers, 'x-hermes-bot': botId } }))),
  };
}

for (const [endpoint, method] of [['launch', 'POST'], ['7/menu', 'GET'], ['7/action', 'POST']]) {
  test(`${endpoint} takes the lease and returns HTTP 409 for another bot`, async () => {
    const { request, seen } = computerRoutes();
    assert.equal((await request(`/v1/computer/${endpoint}`, 'a', method)).status, 200);
    assert.deepEqual(await request(`/v1/computer/${endpoint}`, 'b', method), {
      status: 409, body: { error: 'desktop_busy', holder: 'Agent A', retryAfter: 20 },
    });
    assert.equal((await request(`/v1/computer/${endpoint}`, 'a', method)).status, 200);
    assert.equal(seen.length, 2, 'a rejected request never reaches the driver');
  });
}

test('computer reads remain open and do not refresh the input lease', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const { request } = computerRoutes();
  await request('/v1/computer/7/action', 'a', 'POST');
  t.mock.timers.tick(19000);
  for (const bot of ['a', 'b']) for (const endpoint of ['apps', '7/snapshot', '7/screenshot'])
    assert.equal((await request(`/v1/computer/${endpoint}`, bot)).status, 200);
  t.mock.timers.tick(1000);
  assert.equal((await request('/v1/computer/launch', 'b', 'POST')).status, 200);
});

test('trusted human input is never blocked and does not take or refresh a bot lease', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const { request } = computerRoutes();
  await request('/v1/computer/7/action', '', 'POST');
  assert.equal((await request('/v1/computer/7/action', 'a', 'POST')).status, 200);
  t.mock.timers.tick(19000);
  for (const [endpoint, method] of [['launch', 'POST'], ['7/menu', 'GET'], ['7/action', 'POST']])
    assert.equal((await request(`/v1/computer/${endpoint}`, '', method)).status, 200);
  assert.equal((await request('/v1/computer/7/action', 'b', 'POST', { 'x-hermes-human': '1' })).status, 409);
  t.mock.timers.tick(1000);
  assert.equal((await request('/v1/computer/7/action', 'b', 'POST')).status, 200);
});
