const test = require('node:test');
const assert = require('node:assert/strict');
const markdownit = require('markdown-it');
const UnifiedChat = require('../src/unified-chat.js');
const { NATIVE_CHAT_LABEL } = require('../src/gateway-list.js');

class FakeEvent {
  constructor(type, opts = {}) { this.type = type; Object.assign(this, opts); this.defaultPrevented = false; }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this.stopped = true; }
}
class FakeText {
  constructor(text) { this.text = String(text); this.parent = null; }
  get textContent() { return this.text; }
}
class FakeNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parent = null;
    this._text = '';
    this._html = '';
    this.listeners = {};
    this.dataset = {};
    this.attributes = {};
    this.className = '';
    this.disabled = false;
    this.value = '';
    this.type = '';
    this.title = '';
    this.rows = 0;
    this.dir = '';
    this.tabIndex = 0;
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
    this.style = {};
  }
  set textContent(value) { this._text = String(value); this._html = ''; this.children = []; }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
  set innerHTML(value) { this._html = String(value); this._text = ''; this.children = []; }
  get innerHTML() { return this._html + this.children.map((child) => child.outerHTML || '').join(''); }
  get outerHTML() { return `<${this.tagName.toLowerCase()}>${this.innerHTML || this.textContent}</${this.tagName.toLowerCase()}>`; }
  get firstChild() { return this.children[0] || null; }
  get lastChild() { return this.children.at(-1) || null; }
  get childElementCount() { return this.children.length; }
  get classList() {
    const node = this;
    const mutate = (cls, force) => {
      const set = new Set(node.className.split(/\s+/).filter(Boolean));
      if (force === undefined ? !set.has(cls) : force) set.add(cls); else set.delete(cls);
      node.className = [...set].join(' ');
    };
    return {
      add: (...classes) => classes.forEach((cls) => mutate(cls, true)),
      remove: (...classes) => classes.forEach((cls) => mutate(cls, false)),
      toggle: (cls, force) => mutate(cls, force),
      contains: (cls) => node.className.split(/\s+/).includes(cls),
    };
  }
  append(...kids) {
    for (const kid of kids) {
      if (!kid) continue;
      const child = typeof kid === 'string' ? new FakeText(kid) : kid;
      child.parent = this;
      this.children.push(child);
    }
  }
  prepend(...kids) {
    const nodes = kids.filter(Boolean).map((kid) => typeof kid === 'string' ? new FakeText(kid) : kid);
    for (const child of nodes) child.parent = this;
    this.children.unshift(...nodes);
  }
  replaceChildren(...kids) {
    this.children = [];
    this._text = '';
    this._html = '';
    this.append(...kids);
  }
  replaceWith(node) {
    if (!this.parent) return;
    const at = this.parent.children.indexOf(this);
    if (at >= 0) this.parent.children.splice(at, 1, node);
    node.parent = this.parent;
    this.parent = null;
  }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  getAttribute(key) { return Object.hasOwn(this.attributes, key) ? this.attributes[key] : null; }
  removeAttribute(key) { delete this.attributes[key]; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) {
    const list = this.listeners[type] || [];
    const at = list.indexOf(fn);
    if (at >= 0) list.splice(at, 1);
  }
  dispatchEvent(event) {
    event.target ||= this;
    event.currentTarget = this;
    for (const fn of [...(this.listeners[event.type] || [])]) fn.call(this, event);
    return !event.defaultPrevented;
  }
  click() { if (!this.disabled) this.dispatchEvent(new FakeEvent('click')); }
  focus() { if (!this.disabled) document.activeElement = this; }
  requestSubmit() { this.dispatchEvent(new FakeEvent('submit')); }
  contains(node) { return node === this || this.findAll((child) => child === node).length > 0; }
  matches(selector) {
    if (selector.startsWith('.')) return this.className.split(/\s+/).includes(selector.slice(1));
    if (selector.startsWith('[data-')) return false;
    if (selector === 'a[href]') return this.tagName === 'A' && !!this.attributes.href;
    return this.tagName === selector.toUpperCase();
  }
  closest(selector) {
    for (let node = this; node; node = node.parent) if (node.matches?.(selector)) return node;
    return null;
  }
  querySelector(selector) { return this.findAll((node) => node.matches(selector))[0] || null; }
  querySelectorAll(selector) { return this.findAll((node) => node.matches(selector)); }
  findAll(pred, out = []) {
    for (const child of this.children) {
      if (child instanceof FakeNode) {
        if (pred(child)) out.push(child);
        child.findAll(pred, out);
      }
    }
    return out;
  }
  getBoundingClientRect() { return { top: 0 }; }
  get offsetHeight() { return 0; }
}
const document = {
  activeElement: null,
  listeners: {},
  createElement: (tag) => new FakeNode(tag),
  createTextNode: (text) => new FakeText(text),
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
  removeEventListener(type, fn) {
    const list = this.listeners[type] || [];
    const at = list.indexOf(fn);
    if (at >= 0) list.splice(at, 1);
  },
  querySelectorAll: () => [],
};
global.document = document;
global.HTMLElement = FakeNode;

const hasClass = (cls) => (node) => node.className.split(/\s+/).includes(cls);
const tick = () => new Promise((resolve) => setImmediate(resolve));
const message = (key, lane, role, text, ts, state = 'sent') => ({
  key, lane, sessionId: `${lane}-session`, rowId: key, role, text, ts, state,
});
const lanes = (overrides = {}) => ({
  telegram: { health: 'live', sendable: true },
  'hermes-desktop': { health: 'live', sendable: true },
  native: { health: 'live', sendable: true },
  ...overrides,
});
const baseState = (overrides = {}) => ({
  botId: 'bot-1',
  botName: 'Alan',
  messages: [],
  lanes: lanes(),
  sendVia: 'telegram',
  ...overrides,
});

function harness() {
  document.activeElement = null;
  const root = new FakeNode('div');
  const calls = { send: [], sendVia: [], retry: [], delete: [], cancel: [], copy: [], openLink: [] };
  const view = UnifiedChat.create({
    root,
    md: markdownit({ html: false, linkify: true }),
    onSend: (value) => calls.send.push(value),
    onSendVia: (lane) => calls.sendVia.push(lane),
    onRetry: (key) => calls.retry.push(key),
    onDelete: (key) => calls.delete.push(key),
    onCancel: (key) => calls.cancel.push(key),
    onCopy: (text) => calls.copy.push(text),
    onOpenLink: (url) => calls.openLink.push(url),
  });
  return {
    root, view, calls,
    textarea: root.findAll((node) => node.tagName === 'TEXTAREA')[0],
    composer: root.findAll((node) => node.className.split(/\s+/).includes('uc-composer'))[0],
    viaButton: root.findAll((node) => node.className.split(/\s+/).includes('uc-via'))[0],
  };
}
const clone = (value) => JSON.parse(JSON.stringify(value));

test('origin tags name the lane, including the native label, and repeats are quiet', () => {
  const h = harness();
  h.view.setState(baseState({
    messages: [
      message('t1', 'telegram', 'user', 'one', 100),
      message('t2', 'telegram', 'user', 'two', 150),
      message('h1', 'hermes-desktop', 'user', 'three', 180),
      message('n1', 'native', 'assistant', 'four', 210),
    ],
  }));
  const tags = h.root.findAll(hasClass('uc-lane-tag'));
  assert.deepEqual(tags.map((tag) => tag.textContent), ['Telegram', 'Telegram', 'Hermes', NATIVE_CHAT_LABEL]);
  assert.equal(tags[0].classList.contains('nc-pill'), true);
  assert.equal(tags[1].classList.contains('quiet'), true);
  assert.equal(tags[1].classList.contains('nc-pill'), false);
  assert.equal(tags[2].classList.contains('nc-pill'), true, 'a lane change earns a full tag again');
  h.view.dispose();
});

test('the send-via picker is a menu with the default lane, disabled reasons, and no unavailable lane', () => {
  const h = harness();
  h.view.setState(baseState({
    lanes: lanes({
      telegram: { health: 'live', sendable: true },
      'hermes-desktop': { health: 'signin', sendable: false },
      native: { health: 'offline', sendable: false },
    }),
  }));
  assert.equal(h.viaButton.textContent, 'via Telegram');
  assert.equal(h.viaButton.getAttribute('aria-haspopup'), 'menu');
  h.viaButton.click();
  const items = h.root.findAll(hasClass('uc-via-item'));
  assert.equal(items.length, 3);
  assert.deepEqual(items.map((item) => item.getAttribute('role')), ['menuitemradio', 'menuitemradio', 'menuitemradio']);
  assert.deepEqual(items.map((item) => item.getAttribute('aria-checked')), ['true', 'false', 'false']);
  assert.equal(items[1].disabled, true);
  assert.equal(items[2].disabled, true);
  assert.ok(items[1].textContent.includes('Signed out'));
  assert.ok(items[2].textContent.includes('Offline'));

  h.view.setState(baseState({
    lanes: lanes({
      telegram: { health: 'live', sendable: true },
      'hermes-desktop': { health: 'signin', sendable: false },
      native: { health: 'unavailable', sendable: false },
    }),
  }));
  assert.equal(h.root.findAll(hasClass('uc-via-item')).length, 2, 'an unavailable lane is omitted');
  h.view.dispose();
});

test('choosing a picker lane reports it, and a composer send goes out on the chosen lane', () => {
  const h = harness();
  h.view.setState(baseState({ sendVia: 'hermes-desktop' }));
  h.viaButton.click();
  const native = h.root.findAll(hasClass('uc-via-item')).find((item) => item.dataset.lane === 'native');
  native.click();
  assert.deepEqual(h.calls.sendVia, ['native']);

  h.view.setState(baseState({ sendVia: 'hermes-desktop' }));
  h.textarea.value = 'hello there';
  h.textarea.dispatchEvent(new FakeEvent('input'));
  h.composer.requestSubmit();
  assert.deepEqual(h.calls.send, [{ lane: 'hermes-desktop', text: 'hello there' }]);
  assert.equal(h.textarea.value, '');
  h.view.dispose();
});

test('with no sendable lane the message box is disabled with one plain reason', () => {
  const h = harness();
  h.view.setState(baseState({
    sendVia: '',
    lanes: lanes({
      telegram: { health: 'offline', sendable: false },
      'hermes-desktop': { health: 'offline', sendable: false },
      native: { health: 'offline', sendable: false },
    }),
  }));
  const send = h.root.findAll((node) => node.className.split(/\s+/).includes('nc-send'))[0];
  const note = h.root.findAll(hasClass('uc-send-note'))[0];
  assert.equal(h.textarea.disabled, true);
  assert.equal(send.disabled, true);
  assert.equal(note.classList.contains('hidden'), false);
  assert.equal(note.textContent, 'You are offline.');
  h.textarea.value = 'still here';
  h.composer.requestSubmit();
  assert.deepEqual(h.calls.send, []);
  h.view.dispose();
});

test('offline and signed-out lanes produce one quiet notice while messages stay visible', () => {
  const h = harness();
  h.view.setState(baseState({
    sendVia: 'native',
    lanes: lanes({
      telegram: { health: 'offline', sendable: false },
      'hermes-desktop': { health: 'signin', sendable: false },
      native: { health: 'live', sendable: true },
    }),
    messages: [message('m1', 'telegram', 'assistant', 'still here', 100)],
  }));
  const notices = h.root.findAll((node) => node.className.split(/\s+/).includes('nc-conn'));
  assert.equal(notices.length, 1);
  assert.equal(notices[0].classList.contains('hidden'), false);
  assert.equal(notices[0].textContent, 'Telegram is offline. Hermes is signed out.');
  assert.equal(h.root.findAll((node) => node.dataset.key === 'm1').length, 1);
  h.view.dispose();
});

test('an identical state push does not rebuild rows and preserves draft, focus, and scroll', () => {
  const h = harness();
  const state = baseState({ messages: [message('m1', 'telegram', 'assistant', 'first', 100)] });
  h.view.setState(state);
  const before = h.root.findAll((node) => node.dataset.key === 'm1')[0];
  const scroller = h.root.findAll((node) => node.className.split(/\s+/).includes('nc-scroll'))[0];
  scroller.scrollTop = 77;
  h.textarea.value = 'draft in progress';
  h.textarea.dispatchEvent(new FakeEvent('input'));
  h.textarea.focus();
  h.view.setState(clone(state));
  assert.equal(h.root.findAll((node) => node.dataset.key === 'm1')[0], before);
  assert.equal(h.textarea.value, 'draft in progress');
  assert.equal(document.activeElement, h.textarea);
  assert.equal(scroller.scrollTop, 77);
  h.view.dispose();
});

test('a failed message offers retry and delete; a queued message offers cancel', () => {
  const h = harness();
  h.view.setState(baseState({
    messages: [
      message('failed-1', 'telegram', 'user', 'try again', 100, 'failed'),
      message('queued-1', 'telegram', 'user', 'wait', 130, 'queued'),
    ],
  }));
  const byText = (text) => h.root.findAll((node) => node.tagName === 'BUTTON' && node.textContent === text);
  byText('Retry')[0].click();
  byText('Delete')[0].click();
  byText('Cancel')[0].click();
  assert.deepEqual(h.calls.retry, ['failed-1']);
  assert.deepEqual(h.calls.delete, ['failed-1']);
  assert.deepEqual(h.calls.cancel, ['queued-1']);
  h.view.dispose();
});

test('script markup and javascript: links in assistant markdown are neutralised', () => {
  const h = harness();
  h.view.setState(baseState({
    messages: [message('x1', 'telegram', 'assistant', '<script>alert(1)</script> [click](javascript:alert(1))', 100)],
  }));
  const bubble = h.root.findAll(hasClass('nc-bubble'))[0];
  assert.doesNotMatch(bubble.innerHTML, /<script/i);
  assert.match(bubble.innerHTML, /&lt;script&gt;/);
  assert.doesNotMatch(bubble.innerHTML, /href="javascript:/i);
  h.view.dispose();
});


test('the picker is keyboard reachable and Escape returns focus to its button', () => {
  const h = harness();
  h.view.setState(baseState());
  const menu = h.root.findAll(hasClass('uc-via-menu'))[0];
  h.viaButton.dispatchEvent(new FakeEvent('keydown', { key: 'ArrowDown' }));
  assert.equal(menu.classList.contains('hidden'), false);
  assert.equal(document.activeElement.dataset.lane, 'telegram');
  menu.dispatchEvent(new FakeEvent('keydown', { key: 'ArrowDown' }));
  assert.equal(document.activeElement.dataset.lane, 'hermes-desktop');
  menu.dispatchEvent(new FakeEvent('keydown', { key: 'Escape' }));
  assert.equal(menu.classList.contains('hidden'), true);
  assert.equal(document.activeElement, h.viaButton);
  h.view.dispose();
});

test('streaming markdown is shown in progress with its origin lane', () => {
  const h = harness();
  h.view.setState(baseState({ streaming: { lane: 'native', text: '**working**' } }));
  const streaming = h.root.findAll((node) => node.className.split(/\s+/).includes('streaming'))[0];
  assert.ok(streaming, 'streaming row renders');
  assert.equal(streaming.dataset.lane, 'native');
  assert.equal(streaming.findAll(hasClass('uc-lane-tag'))[0].textContent, NATIVE_CHAT_LABEL);
  assert.match(streaming.findAll(hasClass('nc-bubble'))[0].innerHTML, /<strong>working<\/strong>/);
  h.view.dispose();
});

test('long threads render in chunks instead of mounting every row', () => {
  const h = harness();
  const messages = Array.from({ length: 100 }, (_, i) => message(`m${i + 1}`, 'telegram', 'user', `message ${i + 1}`, i + 1));
  h.view.setState(baseState({ messages }));
  const rows = h.root.findAll((node) => node.dataset.key);
  assert.equal(rows.length, 60);
  assert.equal(rows[0].dataset.key, 'm41');
  assert.equal(rows.at(-1).dataset.key, 'm100');
  h.view.dispose();
});
