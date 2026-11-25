const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CHAT_ONLY_CSS, chatOnlyLaunchFragment, chatOnlyTarget, installChatOnly, shouldUseChatOnly } = require('../src/webapp-chat-only.cjs');

const HOST = 'https://agent-vm.tail1234.ts.net';

test('the chat-only rules apply to the new-chat route and session chat routes', () => {
  for (const suffix of ['', '/', '#/', '#/abc123', '#/session%20one', '/?win=secondary#/abc123']) {
    assert.equal(shouldUseChatOnly(`${HOST}${suffix}`), true, suffix);
  }
});


test('the supported secondary-window flag is added before the hash route', () => {
  const target = new URL(chatOnlyTarget(`${HOST}/`));
  assert.equal(target.searchParams.get('win'), 'secondary');
  assert.equal(target.hash, '');

  const routed = new URL(chatOnlyTarget(`${HOST}/#/abc123`));
  assert.equal(routed.searchParams.get('win'), 'secondary');
  assert.equal(routed.hash, '#/abc123');
});

test('private launch fragments carry the secondary-window query through the handoff', () => {
  const fragment = chatOnlyLaunchFragment('#ticket=abc&keep=1');
  const params = new URLSearchParams(fragment.slice(1));
  assert.equal(params.get('ticket'), 'abc');
  assert.equal(params.get('keep'), '1');
  const query = new URLSearchParams(params.get('query').slice(1));
  assert.equal(query.get('win'), 'secondary');

  const existing = new URLSearchParams(chatOnlyLaunchFragment('#ticket=abc&query=%3Fprofile%3Dcoder').slice(1));
  const existingQuery = new URLSearchParams(existing.get('query').slice(1));
  assert.equal(existingQuery.get('profile'), 'coder');
  assert.equal(existingQuery.get('win'), 'secondary');
});

test('workspace pages do not get the chat-only rules', () => {
  for (const page of ['settings', 'command-center', 'session-import', 'capabilities', 'messaging', 'webhooks', 'artifacts', 'cron', 'profiles', 'agents', 'starmap']) {
    assert.equal(shouldUseChatOnly(`${HOST}/#/${page}`), false, page);
  }
});

test('launch, child-window, and sign-in pages are skipped even when their hash looks like chat', () => {
  for (const path of ['/webapp/launch', '/one/webapp/launch', '/webapp/window', '/login', '/one/login']) {
    assert.equal(shouldUseChatOnly(`${HOST}${path}#/`), false, path);
    assert.equal(shouldUseChatOnly(`${HOST}${path}#ticket=abc`), false, path);
  }
});

test('bad and non-http-looking input fails safe by doing nothing', () => {
  assert.equal(shouldUseChatOnly(''), false);
  assert.equal(shouldUseChatOnly('not a url'), false);
});

test('the stylesheet never names the transcript or composer selectors', () => {
  for (const forbidden of ['composer', 'aui_', 'scroll-area', 'message-list', 'transcript']) {
    assert.equal(CHAT_ONLY_CSS.includes(forbidden), false, forbidden);
  }
});

test('the stylesheet does not nest relational selectors, which CSS rejects', () => {
  let depth = 0;
  for (let index = 0; index < CHAT_ONLY_CSS.length; index += 1) {
    if (depth > 0 && CHAT_ONLY_CSS.startsWith(':has(', index)) {
      assert.fail('nested :has() would invalidate the selector rule');
    }
    if (depth === 0 && CHAT_ONLY_CSS.startsWith(':has(', index)) {
      depth = 1;
      index += 4;
      continue;
    }
    if (depth === 0) continue;
    if (CHAT_ONLY_CSS[index] === '(') depth += 1;
    if (CHAT_ONLY_CSS[index] === ')') depth -= 1;
  }
});

test('the stylesheet uses structural pane chrome selectors, not hashed class names', () => {
  assert.match(CHAT_ONLY_CSS, /\[data-tree-split\]/);
  assert.match(CHAT_ONLY_CSS, /\[data-tree-tab="sessions"\]/);
  assert.match(CHAT_ONLY_CSS, /\[data-tree-tab="hermes-bots:routines"\]/);
  assert.match(CHAT_ONLY_CSS, /\[data-slot="statusbar"\]/);
  assert.doesNotMatch(CHAT_ONLY_CSS, /\.[A-Za-z0-9_-]{8,}\b/);
});

class FakeContents {
  constructor(url) {
    this.url = url;
    this.listeners = new Map();
    this.inserted = [];
    this.removed = [];
  }
  getURL() { return this.url; }
  on(event, fn) { this.listeners.set(event, fn); }
  once(event, fn) { this.listeners.set(event, fn); }
  insertCSS(css) { const key = `css-${this.inserted.length + 1}`; this.inserted.push([key, css]); return Promise.resolve(key); }
  removeInsertedCSS(key) { this.removed.push(key); return Promise.resolve(); }
  emit(event, ...args) { this.listeners.get(event)?.(...args); }
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('install reapplies after reloads and in-page chat navigation', async () => {
  const contents = new FakeContents(`${HOST}/#/`);
  installChatOnly(contents);
  await flush();
  assert.equal(contents.inserted.length, 1);

  contents.url = `${HOST}/#/abc123`;
  contents.emit('did-navigate-in-page', {}, contents.url, true);
  await flush();
  assert.equal(contents.inserted.length, 2);

  contents.emit('did-stop-loading');
  await flush();
  assert.equal(contents.inserted.length, 3);
  assert.deepEqual(contents.removed, ['css-1', 'css-2']);
});

test('install removes the rules for an in-page workspace page and skips launch and sign-in pages', async () => {
  const contents = new FakeContents(`${HOST}/#/`);
  installChatOnly(contents);
  await flush();
  assert.equal(contents.inserted.length, 1);

  contents.url = `${HOST}/#/artifacts`;
  contents.emit('did-navigate-in-page', {}, contents.url, true);
  await flush();
  assert.deepEqual(contents.removed, ['css-1']);
  assert.equal(contents.inserted.length, 1);

  for (const path of ['/webapp/launch', '/login']) {
    const skipped = new FakeContents(`${HOST}${path}#/`);
    installChatOnly(skipped);
    skipped.emit('did-stop-loading');
    await flush();
    assert.equal(skipped.inserted.length, 0, path);
  }
});
