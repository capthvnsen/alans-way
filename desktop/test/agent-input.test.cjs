const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createAgentInput, keyboardEvent, botAccent, cursorPath, boundedJs } = require('../src/agent-input.cjs');
const { requireActor } = require('../src/core.cjs');

function fixture(options = {}) {
  const calls = [], scripts = [], shortcuts = [];
  let hook = async () => {};
  const found = { x: 40, y: 60, ...options.found };
  const tab = { botId: 'bot', controller: 'agent', epoch: 1, refs: new Set(['s1-1', 's1-2']), view: { webContents: Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    setIgnoreMenuShortcuts: value => shortcuts.push(value),
    executeJavaScript: async code => { scripts.push(code); await hook('evaluate', code); return code.includes('innerWidth, height: innerHeight') ? { width: 800, height: 600 } : code.includes('elementFromPoint') ? found : code.includes('__hermesSubmit') ? (options.submitted ?? null) : code.includes('has no option matching') ? (options.select || { selected: { value: 'b', label: 'Beta' } }) : found; },
    focus: () => { throw new Error('Native focus must never be used.'); },
    sendInputEvent: () => { throw new Error('Native input must never be used.'); },
  }) } };
  const agent = createAgentInput({ requireActor, isVisible: () => options.visible !== false, delay: options.delay || (async () => {}), command: async (_tab, method, params) => { assert.equal(_tab, tab); calls.push({ method, ...params }); await hook(method, params); return {}; } });
  return { tab, agent, calls, scripts, shortcuts, hook: callback => { hook = callback; }, perform: body => agent.perform(tab, { epoch: 1, ...body }, 'bot') };
}
const pointer = f => f.calls.filter(call => call.method === 'Input.dispatchMouseEvent').map(({ type, x, y, button, buttons, clickCount }) => ({ type, x, y, button, buttons, clickCount }));

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
  // Focus emulation is enabled once and held for the tab's agent lifetime —
  // a successful action no longer toggles it off.
  assert.deepEqual(f.calls.filter(call => call.method === 'Emulation.setFocusEmulationEnabled').map(call => call.enabled), [true]);
  assert.deepEqual(f.shortcuts, [true, false]);
  assert.equal(f.agent.isDispatching(f.tab), false);
});

test('cursor motion is deterministic, eased, bounded and lands exactly on the target', async () => {
  const short = cursorPath({ x: 10, y: 10 }, { x: 14, y: 12 });
  const path = cursorPath({ x: 10, y: 10 }, { x: 610, y: 410 });
  assert.deepEqual(path, cursorPath({ x: 10, y: 10 }, { x: 610, y: 410 }));
  assert.ok(short.length >= 2);
  assert.ok(path.length <= 5, 'a long move stays within a few frames');
  assert.deepEqual(path.at(-1), { x: 610, y: 410 });
  assert.notDeepEqual(path[Math.floor(path.length / 2)], { x: 310, y: 210 });

  const f = fixture();
  f.tab.agentCursor = { x: 10, y: 10 };
  await f.perform({ action: 'click', x: 610, y: 410 });
  assert.deepEqual(pointer(f).map(({ type, x, y }) => ({ type, x, y })), [
    { type: 'mouseMoved', x: 610, y: 410 }, { type: 'mousePressed', x: 610, y: 410 }, { type: 'mouseReleased', x: 610, y: 410 },
  ], 'one real pointer move, however far the cursor glides');
  // The visible glide is one injected rAF tween, not an eval per pointer step.
  assert.equal(f.scripts.filter(code => code.includes('"path":[')).length, 1, 'exactly one injection carries the tween path');
});

test('a tab the human is not watching skips the glide and its pacing', async () => {
  let paced = 0;
  const f = fixture({ visible: false, delay: async () => { paced++; } });
  f.tab.agentCursor = { x: 10, y: 10 };
  await f.perform({ action: 'click', ref: 's1-1' });
  assert.equal(paced, 0);
  assert.equal(f.scripts.filter(code => code.includes('"path":[')).length, 0, 'no tween for a hidden tab');
  assert.equal(pointer(f).filter(call => call.type === 'mouseMoved').length, 1);
  assert.equal(f.scripts.filter(code => code.includes('requestSubmit')).length, 0, 'a plain click needs no submit probe');
  assert.ok(f.scripts.length <= 3, 'one locate plus fire-and-forget overlay updates');
});

test('the locate script scrolls only when out of view and never waits on rAF alone', async () => {
  const f = fixture();
  await f.perform({ action: 'click', ref: 's1-1' });
  const locate = f.scripts.find(code => code.includes('elementFromPoint'));
  assert.match(locate, /box\.top < 0/, 'an in-view element is not scrolled');
  assert.match(locate, /setTimeout\(r, 80\)/, 'the rAF wait has a timer fallback');
});

test('control changes cancel motion before the press is dispatched', async () => {
  const f = fixture();
  f.tab.agentCursor = { x: 10, y: 10 };
  f.hook(async (method, params) => { if (params.type === 'mouseMoved') f.tab.epoch++; });
  await assert.rejects(f.perform({ action: 'click', x: 700, y: 500 }), /stale_control_epoch/);
  assert.equal(f.calls.filter(call => call.type === 'mouseMoved').length, 1);
  assert.equal(f.calls.some(call => call.type === 'mousePressed'), false);
});

test('an overlay or probe that never answers cannot hang an action', async () => {
  const wc = { executeJavaScript: () => new Promise(() => {}) };
  await assert.rejects(boundedJs(wc, '1', 10), /stopped responding/);
  const f = fixture({ visible: false });
  f.tab.view.webContents.executeJavaScript = code => code.includes('cursor') ? new Promise(() => {}) : Promise.resolve({ x: 5, y: 6 });
  await f.perform({ action: 'move', x: 5, y: 6 });
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

test('focus emulation is held across actions and released once on clear', async () => {
  const f = fixture();
  await f.perform({ action: 'move', x: 10, y: 20 });
  await f.perform({ action: 'move', x: 30, y: 40 });
  const focusCalls = () => f.calls.filter(call => call.method === 'Emulation.setFocusEmulationEnabled').map(call => call.enabled);
  assert.deepEqual(focusCalls(), [true], 'the hold is not retoggled per action');
  await f.agent.clear(f.tab);
  assert.deepEqual(focusCalls(), [true, false], 'clear releases the hold once');
  await f.perform({ action: 'move', x: 50, y: 60 });
  assert.deepEqual(focusCalls(), [true, false, true], 'the next action reacquires it lazily');
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

test('a submit button gets a real click, not a synthetic submit', async () => {
  const f = fixture({ found: { submit: true, nav: true } });
  await f.perform({ action: 'click', ref: 's1-2' });
  assert.equal(f.scripts.some(code => code.includes('requestSubmit')), false);
  assert.equal(pointer(f).filter(call => call.type === 'mousePressed').length, 1, 'trusted input carries the click, the submitter and its handlers');
  assert.match(f.scripts.find(code => code.includes('elementFromPoint')), /addEventListener\('submit'/, 'a click on a submit button watches for the submit');
});

test('a submit the page handles does not wait for a navigation, an uncancelled one does', async () => {
  let waited = 0;
  const handled = fixture({ found: { submit: true }, submitted: 'handled', delay: async () => { waited++; } });
  await handled.perform({ action: 'click', ref: 's1-2' });
  assert.equal(waited, 0);
  const real = fixture({ found: { submit: true }, submitted: 'navigates', delay: async () => { waited++; } });
  await real.perform({ action: 'click', ref: 's1-2' });
  assert.equal(waited, 1, 'an uncancelled submit gives the navigation its start window');
});

test('keys carry a physical code and the right virtual key for punctuation', () => {
  const expected = { '.': [190, 'Period'], "'": [222, 'Quote'], ',': [188, 'Comma'], '-': [189, 'Minus'], '/': [191, 'Slash'], ';': [186, 'Semicolon'], '[': [219, 'BracketLeft'], '5': [53, 'Digit5'], a: [65, 'KeyA'], Delete: [46, 'Delete'], ArrowRight: [39, 'ArrowRight'], F5: [116, 'F5'], ' ': [32, 'Space'] };
  for (const [key, [vk, code]] of Object.entries(expected)) {
    const event = keyboardEvent({ key });
    assert.deepEqual([event.windowsVirtualKeyCode, event.code], [vk, code], key);
  }
  assert.equal(keyboardEvent({ key: '?' }).code, 'Slash');
  assert.equal(keyboardEvent({ key: '.' }).text, '.');
});

test('editing shortcuts carry macOS commands, but never clipboard ones', () => {
  assert.deepEqual(keyboardEvent({ key: 'a', modifiers: ['meta'] }, 'darwin').commands, ['selectAll']);
  assert.deepEqual(keyboardEvent({ key: 'z', modifiers: ['meta', 'shift'] }, 'darwin').commands, ['redo']);
  assert.deepEqual(keyboardEvent({ key: 'Backspace', modifiers: ['alt'] }, 'darwin').commands, ['deleteWordBackward']);
  assert.deepEqual(keyboardEvent({ key: 'Backspace' }, 'darwin').commands, ['deleteBackward'], 'clearing a field must not depend on the raw key binding');
  assert.deepEqual(keyboardEvent({ key: 'Delete' }, 'darwin').commands, ['deleteForward']);
  assert.equal(keyboardEvent({ key: 'Backspace' }, 'win32').commands, undefined);
  assert.equal(keyboardEvent({ key: 'a', modifiers: ['meta'] }, 'win32').commands, undefined);
  assert.equal(keyboardEvent({ key: 'a' }, 'darwin').commands, undefined);
  for (const key of ['c', 'x', 'v']) assert.equal(keyboardEvent({ key, modifiers: ['meta'] }, 'darwin').commands, undefined, `Cmd+${key} never touches the clipboard`);
});

test('double and right clicks send the right buttons and click counts', async () => {
  const f = fixture();
  await f.perform({ action: 'double_click', ref: 's1-1' });
  assert.deepEqual(pointer(f).slice(1).map(({ type, button, buttons, clickCount }) => [type, button, buttons, clickCount]), [
    ['mousePressed', 'left', 1, 1], ['mouseReleased', 'left', 0, 1], ['mousePressed', 'left', 1, 2], ['mouseReleased', 'left', 0, 2],
  ]);
  f.calls.length = 0;
  await f.perform({ action: 'right_click', ref: 's1-1' });
  assert.deepEqual(pointer(f).slice(1).map(({ type, button, buttons, clickCount }) => [type, button, buttons, clickCount]), [
    ['mousePressed', 'right', 2, 1], ['mouseReleased', 'right', 0, 1],
  ]);
  assert.equal(f.tab.agentCursor.action, 'click');
});

test('a revoked right click releases the right button outside the viewport', async () => {
  const f = fixture();
  f.hook(async (method, params) => { if (params.type === 'mousePressed') f.tab.epoch++; });
  await assert.rejects(f.perform({ action: 'right_click', ref: 's1-1' }), /stale_control_epoch/);
  assert.deepEqual(pointer(f).filter(call => call.type === 'mouseReleased').map(({ x, y, button }) => ({ x, y, button })), [{ x: -1, y: -1, button: 'right' }]);
});

test('drag presses at the source, moves with the button held and releases at the destination', async () => {
  const f = fixture({ visible: false });
  await f.perform({ action: 'drag', ref: 's1-1', toX: 300, toY: 200 });
  const events = pointer(f);
  assert.deepEqual(events[0], { type: 'mouseMoved', x: 40, y: 60, button: 'none', buttons: 0, clickCount: undefined });
  assert.deepEqual(events[1], { type: 'mousePressed', x: 40, y: 60, button: 'left', buttons: 1, clickCount: 1 });
  const moves = events.slice(2, -1);
  assert.ok(moves.length >= 2 && moves.every(call => call.type === 'mouseMoved' && call.buttons === 1));
  assert.deepEqual(events.at(-1), { type: 'mouseReleased', x: 300, y: 200, button: 'left', buttons: 0, clickCount: 1 });
  assert.deepEqual({ x: f.tab.agentCursor.x, y: f.tab.agentCursor.y }, { x: 300, y: 200 });
  await assert.rejects(f.perform({ action: 'drag', ref: 's1-1' }), /destination/);
  await assert.rejects(f.perform({ action: 'drag', ref: 's1-1', toRef: 's9-9' }), /Stale/);
  await assert.rejects(f.perform({ action: 'drag', ref: 's1-1', toX: 9999, toY: 5 }), /inside the tab viewport/);
});

test('drag to an element resolves the destination before the source', async () => {
  const f = fixture({ visible: false });
  await f.perform({ action: 'drag', ref: 's1-1', toRef: 's1-2' });
  const locates = f.scripts.filter(code => code.includes('elementFromPoint'));
  assert.equal(locates.length, 2);
  assert.ok(locates[0].includes('s1-2') && locates[1].includes('s1-1'), 'the destination is found first so scrolling the source cannot move it');
});

test('select picks an option by value or label and reports it', async () => {
  const f = fixture();
  const result = await f.perform({ action: 'select', ref: 's1-1', label: 'Beta' });
  assert.deepEqual(result.selected, { value: 'b', label: 'Beta' });
  const script = f.scripts.find(code => code.includes('has no option matching'));
  assert.ok(script.includes('"Beta"') && script.includes("dispatchEvent(new Event('change'"));
  await assert.rejects(f.perform({ action: 'select', ref: 's1-1' }), /option value or label/);
  await assert.rejects(f.perform({ action: 'select', text: 'x', label: 'Beta' }), /requires an element/);
  const loose = fixture();
  await loose.perform({ action: 'select', ref: 's1-1', value: 'b' });
  assert.match(loose.scripts.find(code => code.includes('elementFromPoint')), /const loose = true && el\.tagName === 'SELECT'/, 'select resolves without a hit test');
  const g = fixture({ select: { fail: 'has no option matching that value or label', options: [{ value: 'a', label: 'Alpha' }] } });
  await assert.rejects(g.perform({ action: 'select', ref: 's1-1', value: 'zzz' }), /no option matching.*Alpha/);
});

test('a click that starts a navigation answers after DOMContentLoaded, not before', async () => {
  const f = fixture({ found: { nav: true } });
  const wc = f.tab.view.webContents;
  f.hook(async (method, params) => { if (params.type === 'mouseReleased') wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false }); });
  let done = false;
  const pending = f.perform({ action: 'click', ref: 's1-2' }).then(result => { done = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(done, false, 'still waiting on the new document');
  wc.emit('dom-ready');
  await pending;
  assert.equal(done, true);
  assert.equal(wc.listenerCount('dom-ready'), 0, 'listeners are removed');
});

test('same-document navigations and quiet clicks do not wait', async () => {
  const f = fixture();
  const wc = f.tab.view.webContents;
  f.hook(async (method, params) => { if (params.type === 'mouseReleased') wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true }); });
  await f.perform({ action: 'click', ref: 's1-2' });
  await f.perform({ action: 'press', key: 'Tab' });
});

test('a link click waits for a slow load to start, but an in-page route change ends the wait at once', async () => {
  const { watchNavigation } = require('../src/agent-input.cjs');
  const { EventEmitter } = require('node:events');
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const slow = new EventEmitter();
  const watchSlow = watchNavigation(slow, delay);
  setTimeout(() => slow.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false }), 300);
  setTimeout(() => slow.emit('dom-ready'), 350);
  let started = Date.now();
  await watchSlow.settle(true);
  assert.ok(Date.now() - started >= 300, 'a load that starts after 300ms is still awaited');
  watchSlow.stop();
  const spa = new EventEmitter();
  const watchSpa = watchNavigation(spa, delay);
  setTimeout(() => spa.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true }), 20);
  started = Date.now();
  await watchSpa.settle(true);
  assert.ok(Date.now() - started < 300, 'an in-page route change does not wait out the window');
  watchSpa.stop();
});
