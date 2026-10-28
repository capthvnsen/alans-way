const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createDesktopApproval } = require('../src/desktop-approval.cjs');
const { computerRoutes } = require('./computer-routes-fixture.cjs');

function gate(answers, trusted = () => false) {
  const asked = [];
  const approval = createDesktopApproval({
    trusted,
    ask: async (name, botId, signal) => { asked.push({ name, botId, signal }); return answers.shift(); },
  });
  return { approval, asked };
}

test('an untrusted agent is asked once, then keeps its grant until idle for 30 minutes', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const { approval, asked } = gate([true, true]);
  assert.equal(await approval.check('grok', 'Grok Bot'), null);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].name, 'Grok Bot');
  assert.equal(asked[0].botId, 'grok');
  assert.ok(asked[0].signal instanceof AbortSignal, 'the prompt can be closed when nobody answers');
  t.mock.timers.tick(29 * 60000);
  assert.equal(await approval.check('grok', 'Grok Bot'), null, 'use refreshes the grant');
  t.mock.timers.tick(29 * 60000);
  assert.equal(await approval.check('grok', 'Grok Bot'), null);
  assert.equal(asked.length, 1);
  t.mock.timers.tick(30 * 60000);
  assert.equal(await approval.check('grok', 'Grok Bot'), null);
  assert.equal(asked.length, 2, 'an idle grant expires and asks again');
});

test('unanswered prompts ask again; a denial holds for a minute without prompting', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const { approval, asked } = gate([null, undefined, false, true]);
  assert.deepEqual(await approval.check('grok', ''), { error: 'desktop_approval_required', name: 'grok' });
  assert.deepEqual(await approval.check('grok', 'Grok Bot'), { error: 'desktop_approval_required', name: 'Grok Bot' });
  assert.deepEqual(await approval.check('grok', 'Grok Bot'), { error: 'desktop_approval_denied', name: 'Grok Bot' });
  assert.equal(asked.length, 3);
  t.mock.timers.tick(59999);
  assert.deepEqual(await approval.check('grok', 'Grok Bot'), { error: 'desktop_approval_denied', name: 'Grok Bot' });
  assert.equal(asked.length, 3, 'retrying inside the minute does not prompt');
  t.mock.timers.tick(1);
  assert.equal(await approval.check('grok', 'Grok Bot'), null);
  assert.equal(asked.length, 4);
});

test('a failing prompt counts as unanswered instead of throwing', async () => {
  const approval = createDesktopApproval({ trusted: () => false, ask: async () => { throw new Error('no display'); } });
  assert.deepEqual(await approval.check('grok', 'Grok Bot'), { error: 'desktop_approval_required', name: 'Grok Bot' });
});

test('concurrent requests from one agent share one prompt', async () => {
  let answer;
  let asks = 0;
  const approval = createDesktopApproval({ trusted: () => false, ask: () => { asks++; return new Promise(resolve => { answer = resolve; }); } });
  const first = approval.check('grok', 'Grok Bot');
  const second = approval.check('grok', 'Grok Bot');
  await new Promise(resolve => setImmediate(resolve));
  answer(true);
  assert.deepEqual(await Promise.all([first, second]), [null, null]);
  assert.equal(asks, 1);
});

test('trusted agents and human input are never asked', async () => {
  const { approval, asked } = gate([], (id) => id === 'hermes');
  assert.equal(await approval.check('hermes', 'Hermes'), null);
  assert.equal(await approval.check('', ''), null);
  assert.equal(asked.length, 0);
});

test('launch and action ask before the lease and the driver; reads and menus do not ask', async () => {
  const { approval, asked } = gate([false, true]);
  const { request, seen } = computerRoutes({}, { approval });
  assert.deepEqual(await request('/v1/computer/7/action', 'grok', 'POST'), { status: 403, body: { error: 'desktop_approval_denied', name: 'grok' } });
  assert.deepEqual(await request('/v1/computer/launch', 'grok', 'POST'), { status: 403, body: { error: 'desktop_approval_denied', name: 'grok' } });
  assert.deepEqual(seen, [], 'a refused request never reaches the driver');
  assert.equal((await request('/v1/computer/7/action', 'a', 'POST')).status, 200, 'a refusal takes no lease');
  for (const endpoint of ['apps', '7/snapshot', '7/screenshot'])
    assert.equal((await request(`/v1/computer/${endpoint}`, 'grok')).status, 200);
  assert.equal((await request('/v1/computer/7/menu', 'grok')).status, 409, 'menus share the lease but never ask');
  assert.equal(asked.length, 2, 'the denial held for launch, agent a was asked; reads and menus were not');
});

test('the agent display name comes from the app, else the connector header', async () => {
  const { approval, asked } = gate([true, true, true]);
  const { request } = computerRoutes({}, { approval });
  await request('/v1/computer/7/action', 'grok', 'POST', { 'x-hermes-bot-name': encodeURIComponent('Grok Bot') });
  await request('/v1/computer/7/action', 'odd', 'POST', { 'x-hermes-bot-name': '%E0%A4%A' });
  await request('/v1/computer/7/action', 'bidi', 'POST', { 'x-hermes-bot-name': encodeURIComponent('Evil\u202Esremreh\u0007 Bot') });
  assert.deepEqual(asked.map(item => item.name), ['Grok Bot', 'odd', 'Evilsremreh Bot']);
});
