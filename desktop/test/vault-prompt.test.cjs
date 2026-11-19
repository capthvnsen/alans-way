'use strict';
// The native prompt's contract: a sheet on the app window (so a signal can close it), Deny by default, and no
// answer at all when there is no window to ask in.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createVaultPrompt } = require('../src/vault-prompt.cjs');

const rig = ({ response = 1, window = { isDestroyed: () => false, isMinimized: () => false, show() { this.shown = true; } } } = {}) => {
  const calls = [];
  const dialog = { showMessageBox: async (...args) => { calls.push(args); return { response }; } };
  return { calls, window, ask: createVaultPrompt({ dialog, app: { dock: { bounce() {} } }, getWindow: () => window }) };
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
  assert.equal(r.window.shown, true);
});

test('Deny is false, a withdrawn prompt is no answer, and an unencrypted site says so', async () => {
  assert.equal(await rig({ response: 0 }).ask(info, new AbortController().signal), false);
  const ctl = new AbortController(), r = rig({ response: 1 });
  r.ask = createVaultPrompt({ dialog: { showMessageBox: async () => { ctl.abort(); return { response: 1 }; } }, app: {}, getWindow: () => r.window });
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
