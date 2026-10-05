const test = require('node:test');
const assert = require('node:assert/strict');
const { createAgentInput, keyboardEvent, botAccent } = require('../src/agent-input.cjs');
const { requireActor } = require('../src/core.cjs');

function fixture() {
  const calls = [], scripts = [], shortcuts = [];
  let hook = async () => {};
  const tab = { botId: 'bot', controller: 'agent', epoch: 1, refs: new Set(['s1-1']), view: { webContents: {
    isDestroyed: () => false,
    setIgnoreMenuShortcuts: value => shortcuts.push(value),
    executeJavaScript: async code => { scripts.push(code); await hook('evaluate', code); return code.includes('innerWidth, height: innerHeight') ? { width: 800, height: 600 } : { x: 40, y: 60 }; },
    focus: () => { throw new Error('Native focus must never be used.'); },
    sendInputEvent: () => { throw new Error('Native input must never be used.'); },
  } } };
  const agent = createAgentInput({ requireActor, command: async (_tab, method, params) => { assert.equal(_tab, tab); calls.push({ method, ...params }); await hook(method, params); return {}; } });
  return { tab, agent, calls, scripts, shortcuts, hook: callback => { hook = callback; }, perform: body => agent.perform(tab, { epoch: 1, ...body }, 'bot') };
}

test('pointer and keyboard dispatch only to the assigned tab, in order, with a separate cursor', async () => {
  const f = fixture();
  let pending = false;
  f.hook(async method => {
    if (method !== 'Input.dispatchMouseEvent') return;
    assert.equal(pending, false, 'Input events must not overlap');
    assert.equal(f.agent.isDispatching(f.tab), true);
    pending = true;
    await new Promise(resolve => setImmediate(resolve));
    pending = false;
  });
  const result = await f.perform({ action: 'click', ref: 's1-1' });
  assert.equal(result.input, 'tab-cdp');
  assert.deepEqual(f.calls.filter(call => call.method === 'Input.dispatchMouseEvent').map(({ type, x, y }) => ({ type, x, y })), [
    { type: 'mouseMoved', x: 40, y: 60 }, { type: 'mousePressed', x: 40, y: 60 }, { type: 'mouseReleased', x: 40, y: 60 },
  ]);
  assert.equal(f.tab.agentCursor.action, 'click');
  assert.ok(f.scripts.some(code => code.includes('pointer-events:none')));
  assert.deepEqual(f.calls.filter(call => call.method === 'Emulation.setFocusEmulationEnabled').map(call => call.enabled), [true, false]);
  assert.deepEqual(f.shortcuts, [true, false]);
  assert.equal(f.agent.isDispatching(f.tab), false);
});

test('stale epoch, ownership and malformed targets fail before input or focus emulation', async () => {
  for (const body of [{ epoch: 2, action: 'click', ref: 's1-1' }, { action: 'type', ref: 's1-99', text: 'hello' }, { action: 'move', x: NaN, y: 10 }, { action: 'type', ref: 's1-1', text: 'x'.repeat(20001) }]) {
    const f = fixture(); await assert.rejects(f.perform(body)); assert.equal(f.calls.length, 0);
  }
  const f = fixture();
  await assert.rejects(f.agent.perform(f.tab, { epoch: 1, action: 'click', ref: 's1-1' }, 'other'), /different bot/);
  f.tab.controller = 'human';
  await assert.rejects(f.perform({ action: 'click', ref: 's1-1' }), /human_has_control/);
  assert.equal(f.calls.length, 0);
});

test('takeover during target resolution prevents all subsequent pointer input', async () => {
  const f = fixture();
  f.hook(async method => { if (method === 'evaluate') f.tab.controller = 'human'; });
  await assert.rejects(f.perform({ action: 'click', ref: 's1-1' }), /human_has_control/);
  assert.equal(f.calls.some(call => call.method.startsWith('Input.')), false);
  assert.equal(f.calls.at(-1).enabled, false);
});

test('revocation between mouse down and up cannot complete a click on the old target', async () => {
  const f = fixture();
  f.hook(async (method, params) => { if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') f.tab.epoch++; });
  await assert.rejects(f.perform({ action: 'click', ref: 's1-1' }), /stale_control_epoch/);
  const released = f.calls.filter(call => call.type === 'mouseReleased');
  assert.deepEqual(released.map(({ x, y, clickCount }) => ({ x, y, clickCount })), [{ x: -1, y: -1, clickCount: 0 }]);
  assert.equal(f.calls.at(-1).enabled, false);
});

test('typing is Chromium text input; empty replacement deletes the selected text', async () => {
  const f = fixture();
  await f.perform({ action: 'type', ref: 's1-1', text: 'Agent text' });
  assert.ok(f.calls.some(call => call.method === 'Input.insertText' && call.text === 'Agent text'));
  assert.ok(f.scripts.some(code => code.includes('el.select()')));
  f.calls.length = 0;
  await f.perform({ action: 'type', ref: 's1-1', text: '' });
  assert.deepEqual(f.calls.filter(call => call.method === 'Input.dispatchKeyEvent').map(call => [call.type, call.key]), [['keyDown', 'Backspace'], ['keyUp', 'Backspace']]);
});

test('keyboard modifiers are validated and Enter char appears only on key down', async () => {
  assert.equal(keyboardEvent({ key: 'Return' }).key, 'Enter');
  assert.equal(keyboardEvent({ key: 'a', modifiers: ['meta'] }).text, undefined);
  assert.throws(() => keyboardEvent({ key: 'Enter', modifiers: ['super'] }), /modifiers/);
  assert.throws(() => keyboardEvent({ key: 'Unknown' }), /Unsupported key/);
  const f = fixture();
  await f.perform({ action: 'press', key: 'Enter' });
  const events = f.calls.filter(call => call.method === 'Input.dispatchKeyEvent');
  assert.equal(events[0].text, '\r'); assert.equal(events[1].text, undefined);
});

test('input failure always disables focus emulation and restores shortcut handling', async () => {
  const f = fixture();
  f.hook(async method => { if (method === 'Input.insertText') throw new Error('Target detached'); });
  await assert.rejects(f.perform({ action: 'type', ref: 's1-1', text: 'hello' }), /Target detached/);
  assert.equal(f.calls.at(-1).enabled, false);
  assert.deepEqual(f.shortcuts, [true, false]);
  assert.equal(f.agent.isDispatching(f.tab), false);
});

test('agent accent is the shared green and busy callbacks bracket dispatch', async () => {
  assert.equal(botAccent('shared').hue, 152);
  assert.equal(botAccent('').hue, 152);
  assert.equal(botAccent('123').hue, 152);
  assert.deepEqual(botAccent('123'), botAccent('999'), 'Every bot shares the one agent green.');
  assert.ok(botAccent('123').main.startsWith('hsl('));
  const f = fixture(), busy = [];
  const agent = createAgentInput({ requireActor, command: async (_t, method, params) => { f.calls.push({ method, ...params }); return {}; }, botName: () => 'Test Bot', onBusy: (_t, on) => busy.push(on) });
  await agent.perform(f.tab, { epoch: 1, action: 'move', x: 10, y: 20 }, 'bot');
  assert.deepEqual(busy, [true, false]);
  assert.equal(f.tab.agentCursor.name, 'Test Bot');
  assert.equal(f.tab.agentCursor.c.hue, botAccent('bot').hue);
});

test('clearing cancels a pending action and removes the separate cursor', async () => {
  const f = fixture();
  f.tab.agentCursor = { x: 3, y: 4 };
  let clearing = false;
  f.hook(async method => {
    if (method === 'Emulation.setFocusEmulationEnabled' && !clearing) { clearing = true; await f.agent.clear(f.tab); }
  });
  await assert.rejects(f.perform({ action: 'move', x: 10, y: 20 }), /cancelled/);
  assert.equal(f.tab.agentCursor, null);
  assert.equal(f.calls.some(call => call.method.startsWith('Input.')), false);
});
