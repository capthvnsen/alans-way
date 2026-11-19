'use strict';
// The vault lock on an agent tab: what sets it, what lifts it, and what it refuses. Pure Node.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const lock = require('../src/vault-lock.cjs');

test('prompt, filled and released: a refused fill never lifts the lock an earlier fill set', () => {
  const tab = {};
  assert.equal(lock.isLocked(tab), false);
  lock.acquire(tab);
  assert.deepEqual([lock.isLocked(tab), tab.vaultLock], [true, 'prompt']);
  lock.release(tab);
  assert.equal(lock.isLocked(tab), false, 'a fill that did not happen releases');
  lock.acquire(tab); lock.markFilled(tab);
  assert.equal(tab.vaultLock, 'filled');
  lock.acquire(tab);
  assert.equal(tab.vaultLock, 'filled', 'a later prompt does not downgrade it');
  lock.release(tab);
  assert.equal(tab.vaultLock, 'filled', 'and a later refusal does not lift it');
});

test('eval and cdp are refused while locked, with the reason and a 403; everything that submits a login still works', () => {
  const tab = {};
  lock.acquire(tab);
  for (const body of [{ action: 'eval', code: '1' }, { action: 'cdp', method: 'Runtime.evaluate' }, { action: 'cdp', method: 'DOM.getDocument' },
    { action: 'cdp', method: 'DOMSnapshot.captureSnapshot' }, { action: 'cdp', method: 'Page.captureScreenshot' }]) {
    assert.throws(() => lock.guardAction(tab, body), (error) => error.status === 403 && error.code === 'vault_locked' && /paused|locked/i.test(error.message) && /page changes|navigat/i.test(error.message), JSON.stringify(body));
  }
  for (const action of ['click', 'double_click', 'right_click', 'type', 'press', 'select', 'scroll', 'move', 'drag', 'navigate', 'back', 'forward', 'reload', 'read', 'wait', 'batch', 'viewport', 'if', 'repeat']) {
    assert.doesNotThrow(() => lock.guardAction(tab, { action }), action);
  }
  lock.release(tab);
  assert.doesNotThrow(() => lock.guardAction(tab, { action: 'eval', code: '1' }), 'no lock, no change');
});

test('script run by the agent taints the document the moment it is dispatched; read-only DevTools calls and input do not', () => {
  const tab = {};
  for (const body of [{ action: 'click' }, { action: 'cdp', method: 'DOM.getDocument' }, { action: 'cdp', method: 'Emulation.setDeviceMetricsOverride' }, { action: 'cdp', method: 'Page.navigate' }, { action: 'cdp', method: 'Page.reload' }, { action: 'read' }]) {
    lock.beginScript(tab, body)();
    assert.equal(!!tab.agentScripted, false, JSON.stringify(body));
  }
  for (const body of [{ action: 'eval', code: '1' }, { action: 'cdp', method: 'Runtime.evaluate' }, { action: 'cdp', method: 'Runtime.callFunctionOn' }, { action: 'cdp', method: 'Runtime.getProperties' },
    { action: 'cdp', method: 'Runtime.queryObjects' }, { action: 'cdp', method: 'DOM.setAttributeValue' }, { action: 'cdp', method: 'DOM.setOuterHTML' }, { action: 'cdp', method: 'Input.dispatchKeyEvent' }]) {
    const t = {};
    lock.beginScript(t, body);
    assert.equal(t.agentScripted, true, JSON.stringify(body));
  }
  const other = {};
  lock.beginScript(other, { action: 'cdp', method: 'Runtime.enable' })();
  assert.equal(!!other.agentScripted, false, 'enabling the domain runs nothing');
});

test('a script still in flight keeps the next document tainted: a timed-out eval stays queued in the page', () => {
  const tab = { vaultLock: 'filled' };
  const done = lock.beginScript(tab, { action: 'eval', code: '1' });
  assert.equal(tab.scriptsInFlight, 1);
  lock.reset(tab); // a cross-document navigation commits while the script is queued
  assert.deepEqual([tab.vaultLock, tab.agentScripted], [undefined, true], 'the lock ends but the document is not clean');
  done(); done();
  assert.equal(tab.scriptsInFlight, 0, 'ending twice counts once');
  lock.reset(tab);
  assert.equal(tab.agentScripted, false);
});

test('the anchored read-only allowlist: methods that run code, inject script or write the DOM are not plain reads', async () => {
  const { READ_ONLY_CDP } = require('../src/commit-patterns.cjs');
  for (const method of ['DOM.getDocument', 'DOM.querySelectorAll', 'DOMSnapshot.captureSnapshot', 'Page.captureScreenshot', 'Page.reload', 'Page.navigate', 'Page.stopLoading', 'Emulation.setDeviceMetricsOverride', 'Network.enable', 'Log.enable', 'CSS.getComputedStyleForNode']) {
    assert.equal(READ_ONLY_CDP.test(method), true, method);
  }
  for (const method of ['Runtime.evaluate', 'Runtime.callFunctionOn', 'Runtime.compileScript', 'Runtime.runScript', 'Page.addScriptToEvaluateOnNewDocument', 'Page.setBypassCSP', 'Page.navigateToHistoryEntry', 'Page.reloadX',
    'DOM.setOuterHTML', 'DOM.setAttributeValue', 'DOM.setNodeValue', 'DOM.performSearch', 'DOM.removeNode', 'CSS.setStyleTexts', 'Input.insertText', 'Network.setExtraHTTPHeaders', 'Network.setRequestInterception', 'Page.getX.evil', 'Evil.getX', 'XPage.reload']) {
    assert.equal(READ_ONLY_CDP.test(method) && !/^(?:\w+)\.get/.test(method), false, method);
  }
  for (const trailing of ['DOM.getDocument; Runtime.evaluate', 'DOM.get-evil', 'DOM.getDocument\n', 'Emulation.setX.y', 'Page.reload; Runtime.evaluate']) assert.equal(READ_ONLY_CDP.test(trailing), false, `anchored: ${JSON.stringify(trailing)}`);
  assert.equal(READ_ONLY_CDP.test('Page.reloadSomething'), false);
});

test('Page.reload scriptToEvaluateOnLoad is refused always; a reload or navigation with any script-like parameter too', () => {
  for (const body of [{ action: 'cdp', method: 'Page.reload', params: { scriptToEvaluateOnLoad: 'x' } }, { action: 'cdp', method: 'Page.reload', params: { ignoreCache: true, scriptToEvaluateOnLoad: '' } },
    { action: 'cdp', method: 'Runtime.evaluate', params: { nested: { scriptToEvaluateOnLoad: 'x' } } }, { action: 'cdp', method: 'Page.navigate', params: { url: 'https://example.com/', scriptSource: 'x' } },
    { action: 'cdp', method: 'Page.reload', params: { scriptSource: 'x' } }]) {
    assert.match(lock.cdpParamError(body), /scriptToEvaluateOnLoad/, JSON.stringify(body));
  }
  for (const body of [{ action: 'cdp', method: 'Page.reload', params: { ignoreCache: true } }, { action: 'cdp', method: 'Page.navigate', params: { url: 'https://example.com/' } },
    { action: 'cdp', method: 'Runtime.evaluate', params: { expression: '1', returnByValue: true } }, { action: 'cdp', method: 'Runtime.runScript', params: { scriptId: '1' } }, { action: 'click' }, { action: 'cdp', method: 'DOM.getDocument' }]) {
    assert.equal(lock.cdpParamError(body), '', JSON.stringify(body));
  }
});

test('clipboard keys are refused on every platform, with Control or Meta, and only then', () => {
  const refused = [{ key: 'c', modifiers: ['control'] }, { key: 'c', modifiers: ['meta'] }, { key: 'C', modifiers: ['meta', 'shift'] }, { key: 'x', modifiers: ['control'] }, { key: 'v', modifiers: ['meta'] }, { key: 'v', modifiers: ['control', 'shift'] },
    { key: 'a', modifiers: ['control'] }, { key: 'a', modifiers: ['meta'] }, { key: 'Insert', modifiers: ['control'] }, { key: 'Insert', modifiers: ['shift'] }, { key: 'Insert' }, { key: 'Delete', modifiers: ['shift'] }];
  const allowed = [{ key: 'Enter' }, { key: 'Tab' }, { key: 'c' }, { key: 'v' }, { key: 'a', modifiers: ['alt'] }, { key: 'c', modifiers: ['shift'] }, { key: 'Delete' }, { key: 'Backspace', modifiers: ['meta'] }, { key: 'z', modifiers: ['control'] }, { key: 'ArrowLeft', modifiers: ['shift'] }];
  const { keyboardEvent } = require('../src/agent-input.cjs');
  for (const platform of ['darwin', 'win32', 'linux']) {
    for (const body of refused) {
      // The filter does not look at the platform; what the key would become on that platform is built here to show it is the same key.
      try { keyboardEvent({ action: 'press', ...body }, platform); } catch { /* unsupported keys (Insert) are refused by the filter anyway */ }
      assert.equal(lock.clipboardKey({ action: 'press', ...body }), true, `${platform} ${JSON.stringify(body)}`);
    }
    for (const body of allowed) assert.equal(lock.clipboardKey({ action: 'press', ...body }), false, `${platform} ${JSON.stringify(body)}`);
  }
  const tab = { vaultLock: 'filled' };
  assert.throws(() => lock.guardAction(tab, { action: 'press', key: 'v', modifiers: ['control'] }), (e) => e.code === 'vault_locked' && /clipboard/.test(e.message));
  assert.doesNotThrow(() => lock.guardAction({}, { action: 'press', key: 'v', modifiers: ['control'] }), 'no lock, no change');
});

test('selectors while locked: ids, classes, tags, descendant and child combinators only, in every place one is accepted', () => {
  const ok = ['#pw', '.field', 'input', 'form#f', 'form > input', 'div.card .field', 'main   section>p', 'ul li.item#first', '#a > #b #c'];
  const bad = ['#pw[value^="C"]', 'input[type=password]', 'input:valid', '#pw:not(.x)', 'a, b', '*', '#a + #b', '#a ~ #b', '#\\70 w', '', ' ', 'a >', '> a', '#1abc', 'x'.repeat(201), '.a[b]', 'input::placeholder', '#pw:placeholder-shown', 'a:is(b)', 'a\\b'];
  for (const sel of ok) assert.equal(lock.simpleSelector(sel), true, sel);
  for (const sel of bad) assert.equal(lock.simpleSelector(sel), false, JSON.stringify(sel));
  const tab = { vaultLock: 'filled' };
  const places = [
    { action: 'wait', selector: '#pw[value^="C"]' }, { action: 'click', selector: '#pw[value^="C"]' }, { action: 'type', selector: 'input:valid', text: 'x' }, { action: 'drag', selector: '#a', toSelector: '#b[x]' },
    { action: 'read', selector: '#f[x]', maxChars: 5 }, { action: 'read', list: { selector: 'li[x]', fields: { t: { type: 'text' } } } }, { action: 'read', list: { selector: 'li', fields: { t: { type: 'text', selector: 'b[x]' } } } },
    { action: 'wait', name: 'x', selector: '#pw:not(.y)' },
    { action: 'batch', steps: [{ action: 'if', when: { selector: '#pw[value^="C"]' }, then: [{ action: 'read' }], else: [] }] },
    { action: 'batch', steps: [{ action: 'repeat', until: { selector: '#pw[value]' }, steps: [{ action: 'scroll' }] }] },
    { action: 'batch', steps: [{ action: 'if', when: { text: 'x' }, then: [{ action: 'click', selector: '#a[b]' }], else: [] }] },
    { action: 'batch', steps: [{ action: 'wait', selector: '#a[b]' }] },
  ];
  for (const body of places) assert.throws(() => lock.guardAction(tab, body), (e) => e.status === 403 && e.code === 'vault_locked' && /selector/i.test(e.message), JSON.stringify(body).slice(0, 80));
  for (const body of [{ action: 'wait', selector: '#pw' }, { action: 'click', ref: 'e3' }, { action: 'click', selector: 'form > button' }, { action: 'wait', name: 'Sign in', role: 'button' }, { action: 'batch', steps: [{ action: 'if', when: { name: 'x' }, then: [{ action: 'click', ref: 'e1' }], else: [] }] },
    { action: 'read', list: { selector: 'li.item', fields: { t: { type: 'text', selector: 'b' } } } }, { action: 'navigate', url: 'https://example.com/?q[x]=1' }, { action: 'type', ref: 'e2', text: '#pw[value]' }]) {
    assert.doesNotThrow(() => lock.guardAction(tab, body), JSON.stringify(body));
  }
  assert.doesNotThrow(() => lock.guardSelectors(tab, { name: 'Sign in', role: 'button', selector: undefined, row: undefined }), 'a wait by name carries an absent selector');
  assert.throws(() => lock.guardSelectors(tab, { name: 'x', selector: '' }), (e) => e.code === 'vault_locked', 'an empty selector is not absent');
  for (const body of places) assert.doesNotThrow(() => lock.guardAction({}, body), 'no lock, no change');
});

test('the lock is bot-wide: every tab of the bot, any origin, any tab created meanwhile; no other bot', () => {
  const holder = { botId: 'bot1', vaultLock: 'filled', view: { webContents: { getURL: () => 'https://example.com/login' } } };
  const mine = [holder, { botId: 'bot1', view: { webContents: { getURL: () => 'https://other.test/' } } }, { botId: 'bot1', view: { webContents: { getURL: () => 'about:blank' } } }, { botId: 'bot1' }];
  const stranger = { botId: 'bot2', view: { webContents: { getURL: () => 'https://example.com/' } } };
  const all = [...mine, stranger];
  lock.setPeers(() => all);
  try {
    for (const tab of mine) {
      assert.equal(lock.isLocked(tab), true);
      assert.throws(() => lock.guardAction(tab, { action: 'eval', code: '1' }), (e) => e.code === 'vault_locked');
      assert.throws(() => lock.guardScreenshot(tab), (e) => e.code === 'vault_locked');
      assert.deepEqual(lock.readOptions(tab), { blankValues: true });
    }
    assert.equal(lock.isLocked(stranger), false);
    assert.equal(lock.isBotLocked('bot1'), true);
    assert.equal(lock.isBotLocked('bot2'), false);
    assert.throws(() => lock.guardNewTab('bot1'), (e) => e.code === 'vault_locked');
    assert.doesNotThrow(() => lock.guardNewTab('bot2'));
    const created = { botId: 'bot1' };
    all.push(created);
    assert.equal(lock.isLocked(created), true, 'a tab created while the lock is held');
    delete holder.vaultLock;
    assert.equal(lock.isBotLocked('bot1'), false, 'it ends with the holder');
    all.splice(all.indexOf(holder), 1); holder.vaultLock = 'filled';
    assert.equal(lock.isBotLocked('bot1'), false, 'a closed holder holds nothing');
  } finally { lock.setPeers(() => []); }
});
test('a cross-document navigation or a crashed page ends the lock and the taint; an in-page navigation does not', () => {
  const wc = new EventEmitter(), tab = { vaultLock: 'filled', agentScripted: true };
  lock.watch(tab, wc);
  for (const event of ['did-navigate-in-page', 'did-start-navigation', 'did-frame-navigate', 'did-finish-load']) {
    wc.emit(event, {}, 'https://example.com/#x', true, true);
    assert.deepEqual([tab.vaultLock, tab.agentScripted], ['filled', true], event);
  }
  wc.emit('did-navigate', {}, 'https://example.com/next');
  assert.deepEqual([tab.vaultLock, tab.agentScripted], [undefined, false]);
  tab.vaultLock = 'filled'; tab.agentScripted = true;
  wc.emit('render-process-gone');
  assert.deepEqual([tab.vaultLock, tab.agentScripted], [undefined, false]);
});

test('blank options: values are blanked exactly while locked', () => {
  assert.deepEqual(lock.readOptions({}), {});
  assert.deepEqual(lock.readOptions({ vaultLock: 'prompt' }), { blankValues: true });
  assert.deepEqual(lock.readOptions({ vaultLock: 'filled' }), { blankValues: true });
});
