'use strict';
// The native prompt's contract: a sheet on the app window (so a signal can close it), Deny by default, and no
// answer at all when there is no window to ask in.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createVaultPrompt } = require('../src/vault-prompt.cjs');

const activeWindow = () => ({ isDestroyed: () => false, isMinimized: () => false, isVisible: () => true, isFocused: () => true,
  show() { this.raised = true; }, restore() { this.raised = true; }, focus() { this.raised = true; } });
const rig = ({ response = 1, window = activeWindow() } = {}) => {
  const calls = [], dock = { bounced: 0, bounce() { dock.bounced++; } };
  const dialog = { showMessageBox: async (...args) => { calls.push(args); return { response }; } };
  return { calls, window, dock, ask: createVaultPrompt({ dialog, getWindow: () => window }) };
};
const info = { botName: 'Alan', origin: 'https://example.com' };

test('asks as a sheet on the app window, names the bot and the site, and defaults to Deny', async () => {
  const r = rig(), signal = new AbortController().signal;
  assert.equal(await r.ask(info, signal), true);
  const [parent, options] = r.calls[0];
  assert.equal(parent, r.window);
  assert.equal(options.signal, signal);
  assert.deepEqual(options.buttons, ['Deny', 'Allow once']);
  assert.deepEqual([options.defaultId, options.cancelId], [0, 0]);
  assert.match(options.message, /Alan.*https:\/\/example\.com/);
  assert.match(options.detail, /page can read it/i, 'it says what Allow does');
  assert.match(options.detail, /paused/i);
  assert.equal(/never show|never see|cannot see/i.test(options.detail), false, 'no promise it cannot keep');
  assert.equal(r.window.raised, undefined, 'it asks in the window the user is already in');
});

test('Deny is false, a withdrawn prompt is no answer, and an unencrypted site says so', async () => {
  assert.equal(await rig({ response: 0 }).ask(info, new AbortController().signal), false);
  const ctl = new AbortController(), r = rig({ response: 1 });
  r.ask = createVaultPrompt({ dialog: { showMessageBox: async () => { ctl.abort(); return { response: 1 }; } }, getWindow: () => r.window });
  assert.equal(await r.ask(info, ctl.signal), null, 'an Allow that lands after the signal fired does not count');
  const plain = rig();
  await plain.ask({ botName: 'Alan', origin: 'http://example.com' }, new AbortController().signal);
  assert.match(plain.calls[0][1].detail, /not encrypted/);
});

test('with no window to ask in, it does not ask', async () => {
  const none = rig({ window: null });
  assert.equal(await none.ask(info, new AbortController().signal), null);
  assert.equal(none.calls.length, 0);
  const gone = rig({ window: { isDestroyed: () => true } });
  assert.equal(await gone.ask(info, new AbortController().signal), null);
  const aborted = new AbortController(); aborted.abort();
  assert.equal(await rig().ask(info, aborted.signal), null);
});

test('when the app is not the active app it neither raises the window nor bounces the dock, and says so', async () => {
  for (const [why, patch] of [['unfocused', { isFocused: () => false }], ['minimized', { isMinimized: () => true }], ['hidden', { isVisible: () => false }]]) {
    const window = Object.assign(activeWindow(), patch), r = rig({ window });
    assert.equal(await r.ask(info, new AbortController().signal), 'inactive', why);
    assert.deepEqual([r.calls.length, r.dock.bounced, window.raised], [0, 0, undefined], why);
  }
});

test('M1a: the origin leads, the page follows as plain text, truncated in the middle; controls and bidi overrides are stripped', async () => {
  const r = rig();
  await r.ask({ botName: 'Alan', origin: 'https://example.com', page: '/search?q=hello' }, new AbortController().signal);
  const [, options] = r.calls[0];
  assert.match(options.message, /https:\/\/example\.com/, 'the site is in the headline');
  assert.equal(options.message.includes('/search'), false, 'the page is not mixed into it');
  assert.match(options.detail, /Page: \/search\?q=hello/);
  assert.ok(options.detail.indexOf('https://example.com') < options.detail.indexOf('/search'), 'origin first, then the page');

  const nasty = '/login?x=\u202eevil\u202c\u2066a\u2069\u200f\u0007\u001b[31m\r\nspoof: Allowed\u0085\u2028<b>bold</b>&amp;%00';
  const s = rig();
  await s.ask({ botName: 'Al\u202ean', origin: 'https://example.com', page: nasty }, new AbortController().signal);
  const shown = s.calls[0][1];
  for (const text of [shown.message, shown.detail]) assert.equal(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/.test(text), false, 'no control characters or bidi overrides');
  assert.equal(shown.detail.split('\n').filter((line) => /^spoof/.test(line)).length, 0, 'a newline in the query cannot start a line of its own');
  assert.match(shown.detail, /<b>bold<\/b>&amp;%00/, 'markup is shown as it is, not interpreted');

  const long = `/${'a'.repeat(300)}?q=${'z'.repeat(300)}END`;
  const l = rig();
  await l.ask({ botName: 'Alan', origin: 'https://example.com', page: long }, new AbortController().signal);
  const line = l.calls[0][1].detail.split('\n').find((x) => x.startsWith('Page: '));
  assert.ok(line.length <= 'Page: '.length + 120, `capped: ${line.length}`);
  assert.match(line, /^Page: \/a+…z+END$/, 'the middle is elided, both ends kept');

  const root = rig();
  await root.ask({ botName: 'Alan', origin: 'https://example.com', page: '/' }, new AbortController().signal);
  assert.match(root.calls[0][1].detail, /Page: \//);
  const none = rig();
  await none.ask({ botName: 'Alan', origin: 'https://example.com' }, new AbortController().signal);
  assert.equal(/Page:/.test(none.calls[0][1].detail), false, 'no page, no line');
});
