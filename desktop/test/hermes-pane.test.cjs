'use strict';
// Pane-level regression for renderer.js renderHermesSetup: a dropped socket
// with an established selected conversation must keep the conversation
// surface instead of replacing it with the backend form, while every status
// that genuinely needs input still gets the form. The function is sliced
// verbatim out of renderer.js and driven in a vm context against a fake DOM
// — the same technique setup-review.test.cjs uses for main.cjs branches.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class FakeNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase(); this.children = []; this.parent = null;
    this._text = ''; this.listeners = {}; this.dataset = {}; this.attributes = {};
    this.className = ''; this.disabled = false; this.value = ''; this.onclick = null;
  }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set innerHTML(v) { this.children = []; }
  get innerHTML() { return this.children.map((c) => c.outerHTML || '').join(''); }
  get outerHTML() { return `<${this.tagName.toLowerCase()} class="${this.className}">${this._text}${this.innerHTML}</${this.tagName.toLowerCase()}>`; }
  get lastChild() { return this.children.at(-1); }
  get classList() {
    const node = this;
    return { toggle(cls, force) {
      const set = new Set(node.className.split(/\s+/).filter(Boolean));
      if (force === undefined ? !set.has(cls) : force) set.add(cls); else set.delete(cls);
      node.className = [...set].join(' ');
    } };
  }
  append(...kids) { for (const k of kids) { if (k) { k.parent = this; this.children.push(k); } } }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
  click() { if (this.onclick) this.onclick({ type: 'click', stopPropagation() {} }); }
  hasClass(c) { return this.className.split(/\s+/).includes(c); }
  findAll(pred, out = []) {
    for (const c of this.children) { if (pred(c)) out.push(c); c.findAll(pred, out); }
    return out;
  }
}

const src = fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8');
const start = src.indexOf('function renderHermesSetup');
const end = src.indexOf("$('hermes-new').onclick");
assert.ok(start > 0 && end > start, 'renderHermesSetup slice must resolve in renderer.js');
// The forced-setup flag lives above the function on the candidate; a
// baseline without it still runs — its needsSetup then just ignores the
// flag, which is exactly what the forced-path assertions check.
let slice = src.slice(start, end);
if (!slice.includes('hermesSetupForced')) slice = `let hermesSetupForced = false;\n${slice}`;

function harness(h, { chatTarget = 'hermes' } = {}) {
  const setup = new FakeNode('div');
  const convo = new FakeNode('div');
  const calls = [], renders = [];
  const ctx = {
    state: { chatTarget },
    hermesSetupForced: false,
    $: (id) => ({ 'hermes-setup': setup, 'hermes-convo': convo })[id] || null,
    element: (tag, className, text) => {
      const n = new FakeNode(tag);
      if (className) n.className = className;
      if (text !== undefined) n.textContent = text;
      return n;
    },
    hermesCommand: async (name, value) => { calls.push({ name, value }); return { ok: true }; },
    command: async () => ({}),
    render: () => renders.push(1),
    toast: () => {},
    document: { activeElement: null },
  };
  vm.runInNewContext(`${slice}\nthis.renderHermesSetup = renderHermesSetup;\nthis.setForced = (v) => { hermesSetupForced = v; };\nthis.getForced = () => hermesSetupForced;`, ctx);
  ctx.renderHermesSetup(h);
  return { setup, convo, calls, renders, ctx };
}

const target = { label: 'gw.example', url: 'https://gw.example', profile: 'default' };
const sel = { sessionId: 's-1', sessionKey: 'k1' };

test('a dropped socket with an established selection keeps the conversation surface', () => {
  for (const status of ['error', 'disconnected', 'connecting']) {
    const { setup, convo } = harness({
      status, error: status === 'error' ? { code: 'disconnected', message: 'Connection closed (failed)' } : null,
      target, selected: sel, sessions: [],
    });
    assert.ok(setup.hasClass('hidden'), `${status}: setup card must not replace the conversation`);
    assert.ok(!convo.hasClass('hidden'), `${status}: the conversation stays in place`);
  }
});

test('the setup card still owns the pane whenever input is required or nothing is selected', () => {
  for (const status of ['unconfigured', 'needs_signin', 'needs_local_token']) {
    const { setup, convo } = harness({ status, target, selected: sel, error: null });
    assert.ok(!setup.hasClass('hidden'), `${status}: required inputs stay accessible`);
    assert.ok(convo.hasClass('hidden'), status);
  }
  for (const status of ['disconnected', 'connecting', 'error']) {
    const { setup, convo } = harness({ status, target, selected: null, error: null });
    assert.ok(!setup.hasClass('hidden'), `${status} with no selection falls back to the form`);
    assert.ok(convo.hasClass('hidden'), status);
  }
});

test('ready always shows the conversation and clears any forced setup', () => {
  const { setup, convo, ctx } = harness({ status: 'ready', target, selected: sel, error: null });
  ctx.setForced(true);
  ctx.renderHermesSetup({ status: 'ready', target, selected: sel, error: null });
  assert.equal(ctx.getForced(), false);
  assert.ok(setup.hasClass('hidden'));
  assert.ok(!convo.hasClass('hidden'));
});

test('required inputs stay reachable: url/profile fields, sign-in, token and save actions render', () => {
  const { setup } = harness({ status: 'unconfigured', target: null, selected: null, error: null });
  assert.ok(setup.findAll((n) => n.tagName === 'H2')[0]?.textContent === 'Hermes backend');
  assert.equal(setup.findAll((n) => n.tagName === 'INPUT').length, 2); // url + profile
  assert.ok(setup.findAll((n) => n.tagName === 'BUTTON').some((b) => b.textContent === 'Save and connect'));
  const signin = harness({ status: 'needs_signin', target, selected: sel, error: null });
  assert.ok(signin.setup.findAll((n) => n.tagName === 'BUTTON').some((b) => b.textContent === 'Sign in and connect'));
  const token = harness({ status: 'needs_local_token', target, selected: sel, error: null });
  assert.ok(token.setup.findAll((n) => n.tagName === 'INPUT' && n.attributes['aria-label'] === 'Backend session token').length === 1);
  assert.ok(token.setup.findAll((n) => n.tagName === 'BUTTON').some((b) => b.textContent === 'Connect'));
});

test('forced setup shows the form with a way back, and the flag self-clears', () => {
  const h = { status: 'error', error: { code: 'disconnected', message: 'closed' }, target, selected: sel };
  const { setup, convo, renders, ctx } = harness(h);      // recovery surface first
  assert.ok(setup.hasClass('hidden'));
  ctx.setForced(true);
  ctx.renderHermesSetup(h);
  assert.ok(!setup.hasClass('hidden'), 'explicit setup request shows the form');
  assert.ok(convo.hasClass('hidden'));
  assert.equal(setup.findAll((n) => n.tagName === 'INPUT').length, 2, 'the backend fields are the change path');
  const back = setup.findAll((n) => n.className.includes('hermes-setup-back'))[0];
  assert.ok(back, 'forced setup offers a way back to the conversation');
  back.click();
  assert.equal(ctx.getForced(), false);
  assert.equal(renders.length, 1, 'going back re-renders once');
  // The flag can never wedge the pane: input-required, ready, cleared
  // selection or leaving the Hermes pane all reset it.
  for (const h2 of [
    { ...h, status: 'needs_signin' },
    { ...h, selected: null },
  ]) {
    ctx.setForced(true);
    ctx.renderHermesSetup(h2);
    assert.equal(ctx.getForced(), false, `flag self-cleared for ${JSON.stringify(h2.status)}`);
  }
});

test('leaving the Hermes pane clears a forced setup so returning shows the conversation', () => {
  const h = { status: 'error', error: { code: 'x', message: 'y' }, target, selected: sel };
  const away = harness(h, { chatTarget: 'telegram' });
  away.ctx.setForced(true);
  away.ctx.renderHermesSetup(h);
  assert.equal(away.ctx.getForced(), false, 'a telegram detour releases the forced setup');
});

test('the setup form is the same card for every input status — the error message stays attached', () => {
  const { setup } = harness({
    status: 'error', error: { code: 'disconnected', message: 'Connection closed (failed)' },
    target, selected: null,
  });
  assert.ok(!setup.hasClass('hidden'));
  const err = setup.findAll((n) => n.className.includes('hermes-setup-error'))[0];
  assert.equal(err?.textContent, 'Connection closed (failed)');
});
