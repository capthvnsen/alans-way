const { ip: fixtureTailnet, otherIp: fixtureTailnetOther } = require('./tailnet-fixture.cjs');
process.env.HERMES_WORKSPACE_ALLOW_LOOPBACK = '1';
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
    return { add(cls) { node.classList.toggle(cls, true); }, remove(cls) { node.classList.toggle(cls, false); }, toggle(cls, force) {
      const set = new Set(node.className.split(/\s+/).filter(Boolean));
      if (force === undefined ? !set.has(cls) : force) set.add(cls); else set.delete(cls);
      node.className = [...set].join(' ');
    } };
  }
  append(...kids) { for (const k of kids) { if (k) { k.parent = this; this.children.push(k); } } }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
  click() { if (this.onclick) return this.onclick({ type: 'click', stopPropagation() {} }); }
  querySelector(sel) { return this.findAll(n => n.hasClass(sel.slice(1)))[0] || null; }
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
  h = { providers: [{ name: 'basic', displayName: 'Password', password: true, browser: false }], ...h };
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
    window: { HermesView: require('../src/hermes-view.js') },
  };
  vm.runInNewContext(`${slice}\nthis.renderHermesSetup = renderHermesSetup;\nthis.setForced = (v) => { hermesSetupForced = v; };\nthis.getForced = () => hermesSetupForced;`, ctx);
  ctx.renderHermesSetup(h);
  return { setup, convo, calls, renders, ctx };
}

const target = { label: `${fixtureTailnet}`, url: `https://${fixtureTailnet}`, profile: 'default' };
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

test('ready shows the conversation until Change backend is requested, then keeps the editor open across pushes', () => {
  const { setup, convo, ctx } = harness({ status: 'ready', target, selected: sel, error: null });
  assert.ok(setup.hasClass('hidden'));
  assert.ok(!convo.hasClass('hidden'));
  ctx.setForced(true);
  ctx.renderHermesSetup({ status: 'ready', target, selected: sel, error: null });
  assert.equal(ctx.getForced(), true);
  assert.ok(!setup.hasClass('hidden'));
  assert.ok(convo.hasClass('hidden'));
  const url = setup.findAll(n => n.attributes['aria-label'] === 'Hermes backend URL')[0];
  url.value = 'https://other.example';
  ctx.renderHermesSetup({ status: 'ready', target, selected: sel, error: null });
  assert.equal(url.value, 'https://other.example', 'ordinary pushes preserve edits');
  setup.findAll(n => n.hasClass('hermes-setup-back'))[0].click();
  ctx.renderHermesSetup({ status: 'ready', target, selected: sel, error: null });
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
  // Input-required states own the form and release the explicit override.
  for (const h2 of [
    { ...h, status: 'needs_signin' },
    { ...h, status: 'unconfigured', selected: null },
  ]) {
    ctx.setForced(true);
    ctx.renderHermesSetup(h2);
    assert.equal(ctx.getForced(), false, `flag self-cleared for ${JSON.stringify(h2.status)}`);
  }
});

test('sign-in retries retain the username and show updated errors inline without replacing the form', async () => {
  const h = { status: 'needs_signin', target, selected: null, error: null,
    providers: [{ name: 'basic', displayName: 'Password', password: true, browser: false }] };
  const { setup, ctx, calls } = harness(h);
  const user = setup.findAll(n => n.attributes['aria-label'] === 'Username')[0];
  const pass = setup.findAll(n => n.attributes['aria-label'] === 'Password')[0];
  user.value = 'test-user'; pass.value = 'fixture-only';
  await setup.findAll(n => n.textContent === 'Sign in and connect')[0].click();
  assert.deepEqual(calls.map(c => c.name), ['sign-in'], 'unchanged target does not disconnect before sign-in');
  assert.equal(pass.value, '', 'the submitted password is cleared');
  ctx.renderHermesSetup({ ...h, error: { code: 'auth_failed', message: 'Wrong username or password.' } });
  assert.equal(setup.findAll(n => n.attributes['aria-label'] === 'Username')[0], user);
  assert.equal(user.value, 'test-user');
  const error = setup.querySelector('.hermes-setup-error');
  assert.equal(error.textContent, 'Wrong username or password.');
  assert.equal(error.attributes['aria-live'], 'polite');
  assert.ok(!error.hasClass('hidden'));
  assert.ok(setup.findAll(n => n.textContent === 'Sign in and connect')[0]);
  ctx.renderHermesSetup(h);
  assert.ok(error.hasClass('hidden'), 'the next attempt clears the previous error');
});

test('browser providers render explicit provider actions and no password form', async () => {
  const providers = [
    { name: 'nous', displayName: 'Nous Research', password: false, browser: true },
    { name: 'other', displayName: 'Other account', password: false, browser: true },
  ];
  const { setup, calls } = harness({ status: 'needs_signin', target, providers });
  assert.equal(setup.findAll(n => n.attributes['aria-label'] === 'Password').length, 0);
  const buttons = setup.findAll(n => n.tagName === 'BUTTON');
  await buttons.find(n => n.textContent === 'Continue with Nous Research in browser').click();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'sign-in-browser');
  assert.equal(calls[0].value.provider, 'nous');
});

test('browser sign-in pending state can cancel and does not offer another login', async () => {
  const providers = [{ name: 'nous', displayName: 'Nous Research', browser: true }];
  const h = { status: 'needs_signin', target, providers };
  const { setup, calls, ctx } = harness(h);
  ctx.renderHermesSetup({ ...h, signInPending: true });
  assert.ok(setup.textContent.includes('Finish signing in in your browser'));
  assert.equal(setup.findAll(n => n.textContent === 'Continue with Nous Research in browser').length, 0);
  await setup.findAll(n => n.textContent === 'Cancel sign-in')[0].click();
  assert.equal(calls[0].name, 'cancel-sign-in');
  ctx.renderHermesSetup({ ...h, signInPending: false });
  assert.ok(setup.findAll(n => n.textContent === 'Continue with Nous Research in browser').length);
});

test('provider refresh redraws the setup form and unknown capabilities fail closed', () => {
  const h = { status: 'needs_signin', target, providers: [] };
  const { setup, ctx } = harness(h);
  assert.equal(setup.findAll(n => n.attributes['aria-label'] === 'Password').length, 0);
  assert.ok(setup.textContent.includes('No supported sign-in method'));
  ctx.renderHermesSetup({ ...h, providers: [{ name: 'nous', displayName: 'Nous Research', browser: true }] });
  assert.ok(setup.findAll(n => n.textContent === 'Continue with Nous Research in browser').length);
  ctx.renderHermesSetup({ ...h, providers: [{ name: 'unknown', displayName: 'Unknown' }] });
  assert.equal(setup.findAll(n => n.tagName === 'BUTTON').length, 0);
  assert.ok(setup.textContent.includes('No supported sign-in method'));
});

test('a changed backend is saved and probed before provider authentication', async () => {
  const providers = [{ name: 'nous', displayName: 'Nous Research', browser: true }];
  const { setup, calls } = harness({ status: 'needs_signin', target, providers });
  setup.findAll(n => n.attributes['aria-label'] === 'Hermes backend URL')[0].value = 'https://other.example';
  await setup.findAll(n => n.textContent === 'Continue with Nous Research in browser')[0].click();
  assert.deepEqual(calls.map(c => c.name), ['configure', 'connect']);
});

test('the real hub and setup pane keep the sign-in form throughout a failed password attempt', async () => {
  const { createHermesHub } = require('../src/hermes-hub.cjs');
  const { normalizeBaseUrl, RemoteError } = require('../src/hermes-remote.cjs');
  let pane, rejectLogin;
  const login = new Promise((_resolve, reject) => { rejectLogin = reject; });
  const hub = createHermesHub({
    remote: { normalizeBaseUrl,
      probe: async () => ({ authRequired: true, authFlows: ['native_pkce'], authProviders: ['basic'] }),
      providers: async () => [{ name: 'basic', supports_password: true }],
      signIn: () => login },
    notify: () => pane?.ctx.renderHermesSetup(hub.getState()),
  });
  try {
    await hub.command('configure', { url: target.url, profile: target.profile });
    await assert.rejects(hub.command('connect'), { code: 'needs_signin' });
    pane = harness(hub.getState());
    pane.ctx.hermesCommand = async (name, value) => {
      try { return await hub.command(name, value); } catch { return null; }
    };
    const user = pane.setup.findAll(n => n.attributes['aria-label'] === 'Username')[0];
    const pass = pane.setup.findAll(n => n.attributes['aria-label'] === 'Password')[0];
    const submit = pane.setup.findAll(n => n.textContent === 'Sign in and connect')[0];
    user.value = 'fixture-user'; pass.value = 'fixture-only';
    const attempt = submit.click();
    assert.equal(pane.setup.findAll(n => n.attributes['aria-label'] === 'Username')[0], user, 'pending sign-in keeps the same form');
    rejectLogin(new RemoteError('auth_failed', 'POST /auth/password-login: Invalid credentials'));
    await attempt;
    assert.equal(pane.setup.findAll(n => n.attributes['aria-label'] === 'Username')[0], user);
    assert.equal(pane.setup.querySelector('.hermes-setup-error').textContent, 'Wrong username or password.');
    assert.equal(submit.disabled, false, 'the same button is ready for an inline retry');
    assert.equal(user.value, 'fixture-user');
    assert.equal(pass.value, '');
  } finally { hub.dispose(); }
});

test('Hermes pane CSS constrains the outer grid item so only the transcript scrolls', () => {
  const css = fs.readFileSync(path.join(__dirname, '../src/style.css'), 'utf8');
  const rule = selector => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = css.match(new RegExp(`${escaped}\\{([^}]*)\\}`));
    assert.ok(match, selector);
    return Object.fromEntries(match[1].split(';').filter(Boolean).map(s => s.split(':').map(x => x.trim())));
  };
  assert.equal(rule('.chat-pane')['min-height'], '0', 'grid automatic minimum must not grow with transcript content');
  for (const selector of ['.hermes-pane', '.hermes-convo']) {
    assert.equal(rule(selector)['min-height'], '0');
    assert.equal(rule(selector).overflow, 'hidden', selector);
  }
  assert.equal(rule('.hermes-transcript')['overflow-y'], 'auto');
  assert.equal(rule('.hermes-transcript')['min-height'], '0');
  assert.equal(rule('.hermes-composer')['flex-shrink'], '0', 'the composer retains its own height');
});

test('renderer Hermes command errors use the same plain messages as conversation errors', async () => {
  const messages = [];
  const start = src.indexOf('async function hermesCommand');
  const end = src.indexOf('function renderHermes()', start);
  assert.ok(start > 0 && end > start);
  const ctx = {
    window: { HermesView: require('../src/hermes-view.js') },
    hermesApi: { command: async () => { throw new Error("Error invoking remote method 'hermes:command': HubError: Configure a backend first."); } },
    toast: message => messages.push(message),
  };
  vm.runInNewContext(`${src.slice(start, end)}\nthis.run = hermesCommand;`, ctx);
  assert.equal(await ctx.run('connect'), null);
  assert.deepEqual(messages, ['Configure a backend first.']);
});

test('sidebar distinguishes saved conversations from live identities and dispatches a fenced Resume', () => {
  const list = new FakeNode('div'), connect = new FakeNode('div'), newSession = new FakeNode('button');
  const calls = [];
  const h = { status: 'ready', generation: 42, target, sessions: [], storedSessions: [{ id: 'stored-1', title: 'Lighthouse' }] };
  const ctx = { state: { chatTarget: 'hermes', hermes: h },
    $: id => ({ 'hermes-list': list, 'hermes-connect': connect, 'hermes-new': newSession })[id],
    element: (tag, cls, text) => { const n = new FakeNode(tag); n.className = cls || ''; if (text) n.textContent = text; return n; },
    hermesCommand: (name, value) => calls.push({ name, value }), command: () => {}, renderHermesSetup: () => {} };
  const start = src.indexOf('function renderHermes()'), end = src.indexOf('// The setup card owns', start);
  assert.ok(start > 0 && end > start);
  vm.runInNewContext(`${src.slice(start, end)}\nthis.renderHermes = renderHermes;`, ctx);
  ctx.renderHermes();
  assert.match(list.textContent, /No live conversations/);
  assert.match(list.textContent, /Saved conversations/);
  const resume = list.findAll(n => n.tagName === 'BUTTON' && n.textContent === 'Resume Lighthouse')[0];
  assert.ok(resume, 'saved history has an explicit Resume action');
  resume.click();
  assert.equal(calls[0].name, 'resume-session');
  assert.equal(calls[0].value.storedSessionId, 'stored-1');
  assert.equal(calls[0].value.generation, 42);
  assert.equal(calls.some(c => c.name === 'select'), false);
  h.storedSessions = []; h.storedSessionsError = 'Saved conversations could not be loaded.';
  ctx.renderHermes();
  assert.match(list.textContent, /Saved conversations could not be loaded/);
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
