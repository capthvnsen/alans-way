const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createAgentInput, APPROVED, approvalActionKey, keyboardEvent, botAccent, cursorPath, boundedJs } = require('../src/agent-input.cjs');
const { requireActor } = require('../src/core.cjs');

const TEST_CONTEXT = { version: 1, documentId: 'a'.repeat(32), url: 'https://shop.example/checkout' };
const TEST_TARGET = 'b'.repeat(32);
const proofFor = body => ({ ...TEST_CONTEXT, key: approvalActionKey(body), steps: [{ key: approvalActionKey(body), targets: body.action ? [{ ref: body.ref || 'e1', token: TEST_TARGET }] : [] }] });
function fixture(options = {}) {
  const calls = [], scripts = [], shortcuts = [];
  let hook = async () => {};
  const found = { x: 40, y: 60, ...options.found, look: { names: [], field: false, form: null, approvalContext: TEST_CONTEXT, approvalTarget: TEST_TARGET, ...options.found?.look } };
  const tab = { id: 'tab-1', botId: 'bot', controller: 'agent', epoch: 1, refs: new Set(['e1', 'e2']), view: { webContents: Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    setIgnoreMenuShortcuts: value => shortcuts.push(value),
    executeJavaScript: async code => { scripts.push(code); await hook('evaluate', code); return code.includes('matches:') ? { ...found, matches: options.matches ?? true } : code.includes('targets: [') && code.includes('S.approvalTarget(S.find(ref))') ? { approvalContext: options.approvalContext || TEST_CONTEXT, targets: [options.approvalTarget || TEST_TARGET, options.approvalTarget || TEST_TARGET] } : code.endsWith('([], true)') ? (options.challenge ?? null) : code.includes('.page()') ? (options.page ?? { origin: 'https://shop.example', names: [] }) : code.includes('return C.look(C.') ? (options.probe ?? null) : code.includes('innerWidth, height: innerHeight') ? { width: 800, height: 600 } : code.includes('has no option matching') ? (options.select || { matched: { by: 'label', value: 'b', label: 'Beta' } }) : code.includes('elementFromPoint') ? found : code.includes('hw.submit') ? (options.submitted ?? null) : found; },
    focus: () => { throw new Error('Native focus must never be used.'); },
    sendInputEvent: () => { throw new Error('Native input must never be used.'); },
  }) } };
  const agent = createAgentInput({ requireActor, now: options.now, isVisible: () => options.visible !== false, delay: options.delay || (async () => {}), command: async (_tab, method, params) => { assert.equal(_tab, tab); calls.push({ method, ...params }); await hook(method, params); return {}; } });
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
  const result = await f.perform({ action: 'click', ref: 'e1' });
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
  await f.perform({ action: 'click', ref: 'e1' });
  assert.equal(paced, 0);
  assert.equal(f.scripts.filter(code => code.includes('"path":[')).length, 0, 'no tween for a hidden tab');
  assert.equal(pointer(f).filter(call => call.type === 'mouseMoved').length, 1);
  assert.equal(f.scripts.filter(code => code.includes('requestSubmit')).length, 0, 'a plain click needs no submit probe');
  assert.ok(f.scripts.length <= 6, 'one locate, two hit checks, and fire-and-forget overlay and tracker updates');
});

test('the locate script scrolls only when out of view and never waits on rAF alone', async () => {
  const f = fixture();
  await f.perform({ action: 'click', ref: 'e1' });
  const locate = f.scripts.find(code => code.includes('elementFromPoint'));
  assert.match(locate, /box\.top < 0/, 'an in-view element is not scrolled');
  assert.match(locate, /setTimeout\(r, 80\)/, 'the rAF wait has a timer fallback');
});

function scrollFixture({ x = 0, y = 0, maxX = 30000, maxY = 30000, challengeAfter = Infinity } = {}) {
  const f = fixture();
  const { CHALLENGE_HIT_SOURCE } = require('../src/browser-page.cjs');
  let wheels = 0;
  const page = { scrollX: x, scrollY: y, innerHeight: 600,
    document: { scrollingElement: { scrollHeight: maxY + 600 }, elementFromPoint: () => null },
    setTimeout: read => read(), requestAnimationFrame: read => read() };
  const execute = f.tab.view.webContents.executeJavaScript;
  f.tab.view.webContents.executeJavaScript = async code => {
    const result = await execute(code);
    // The page mock has no DOM for the real challenge scan; stand in a CAPTCHA once enough wheels have landed.
    const probe = code.split(CHALLENGE_HIT_SOURCE).join(`(() => ${wheels >= challengeAfter ? "({ kind: 'recaptcha' })" : 'null'})`);
    return code.includes('const positions =') || code.includes('const maxY =') ? require('node:vm').runInNewContext(probe, page) : result;
  };
  f.hook(async (_method, params) => {
    if (params.type !== 'mouseWheel') return;
    wheels++;
    page.scrollX = Math.max(0, Math.min(maxX, page.scrollX + params.deltaX));
    page.scrollY = Math.max(0, Math.min(maxY, page.scrollY + params.deltaY));
  });
  return { ...f, page };
}

test('scroll sends 4584 pixels as three wheel events at the same aim and reports its position', async () => {
  const f = scrollFixture();
  f.tab.agentCursor = { x: 120, y: 180 };
  const result = await f.perform({ action: 'scroll', y: 4584 });
  assert.deepEqual(f.calls.filter(call => call.type === 'mouseWheel').map(({ x, y, deltaX, deltaY }) => ({ x, y, deltaX, deltaY })), [
    { x: 40, y: 60, deltaX: 0, deltaY: 2000 },
    { x: 40, y: 60, deltaX: 0, deltaY: 2000 },
    { x: 40, y: 60, deltaX: 0, deltaY: 584 },
  ]);
  assert.deepEqual({ ...result.scroll }, { x: 0, y: 4584, maxY: 30000, atEnd: false });
  assert.ok(f.scripts.find(code => code.includes('const p =')).includes('120'), 'the challenge check uses the existing cursor aim');
  assert.equal((await f.perform({ action: 'move', x: 10, y: 20 })).scroll, undefined, 'other actions keep their reply shape');
});

test('a challenge that scrolls under the pointer stops the remaining wheel events', async () => {
  const f = scrollFixture({ challengeAfter: 1 });
  await assert.rejects(f.perform({ action: 'scroll', y: 6000 }), /challenge|CAPTCHA|check/i);
  assert.equal(f.calls.filter(call => call.type === 'mouseWheel').length, 1);
});

test('scroll caps each axis at 20000 pixels in either direction', async () => {
  for (const sign of [1, -1]) {
    const f = scrollFixture({ x: 30000, y: 30000, maxX: 60000, maxY: 60000 });
    const result = await f.perform({ action: 'scroll', x: sign * 50000, y: sign * 50000 });
    const wheels = f.calls.filter(call => call.type === 'mouseWheel');
    assert.equal(wheels.length, 10);
    assert.ok(wheels.every(call => call.deltaX === sign * 2000 && call.deltaY === sign * 2000));
    assert.equal(result.scroll.x, 30000 + sign * 20000);
    assert.equal(result.scroll.y, 30000 + sign * 20000);
  }
});

test('scroll stops when the page cannot move and reports the end, including short pages', async () => {
  for (const [y, maxY, delta, atEnd] of [[0, 1000, 4584, true], [1000, 1000, 4584, true], [5000, 6000, -20000, false], [0, -100, 4584, true]]) {
    const f = scrollFixture({ y, maxY });
    const result = await f.perform({ action: 'scroll', y: delta });
    assert.ok(f.calls.filter(call => call.type === 'mouseWheel').length < Math.ceil(Math.abs(delta) / 2000));
    assert.equal(result.scroll.maxY, Math.max(0, maxY));
    assert.equal(result.scroll.atEnd, atEnd);
  }
});

test('scroll continues horizontally when vertical scrolling reaches the end', async () => {
  const f = scrollFixture({ maxY: 1000 });
  const result = await f.perform({ action: 'scroll', x: 4584, y: 4584 });
  assert.equal(f.calls.filter(call => call.type === 'mouseWheel').length, 3);
  assert.deepEqual({ ...result.scroll }, { x: 4584, y: 1000, maxY: 1000, atEnd: true });
});

test('scroll does not stop when a panel moves but the main document stays put', async () => {
  const f = scrollFixture({ maxY: 0 });
  const panel = { scrollLeft: 0, scrollTop: 0, parentElement: null, getRootNode: () => ({}) };
  f.page.document.elementFromPoint = () => panel;
  f.hook(async (_method, params) => { if (params.type === 'mouseWheel') panel.scrollTop += params.deltaY; });
  const result = await f.perform({ action: 'scroll', y: 4584 });
  assert.equal(panel.scrollTop, 4584);
  assert.equal(f.calls.filter(call => call.type === 'mouseWheel').length, 3);
  assert.deepEqual({ ...result.scroll }, { x: 0, y: 0, maxY: 0, atEnd: true }, 'the reply describes the main document');
});

test('scroll follows a panel inside a shadow root', async () => {
  const f = scrollFixture({ maxY: 0 });
  const host = { scrollLeft: 0, scrollTop: 0, parentElement: null, getRootNode: () => ({}) };
  const panel = { scrollLeft: 0, scrollTop: 0, parentElement: null, getRootNode: () => ({ host }) };
  host.shadowRoot = { elementFromPoint: () => panel };
  f.page.document.elementFromPoint = () => host;
  f.hook(async (_method, params) => { if (params.type === 'mouseWheel') panel.scrollTop += params.deltaY; });
  await f.perform({ action: 'scroll', y: 4584 });
  assert.equal(panel.scrollTop, 4584);
});

test('a challenge that appears before the first wheel sends no wheel at all', async () => {
  const f = scrollFixture({ challengeAfter: 0 });
  await assert.rejects(f.perform({ action: 'scroll', y: 6000 }), /challenge|CAPTCHA|check/i);
  assert.equal(f.calls.filter(call => call.type === 'mouseWheel').length, 0);
});

test('scroll follows a shadow scroller that holds slotted content', async () => {
  const f = scrollFixture({ maxY: 0 });
  const host = { scrollLeft: 0, scrollTop: 0, parentElement: null, getRootNode: () => ({}) };
  const scroller = { scrollLeft: 0, scrollTop: 0, parentElement: null, getRootNode: () => ({ host }) };
  const slot = { scrollLeft: 0, scrollTop: 0, parentElement: scroller, getRootNode: () => ({ host }) };
  const item = { scrollLeft: 0, scrollTop: 0, assignedSlot: slot, parentElement: host, getRootNode: () => ({}) };
  f.page.document.elementFromPoint = () => item;
  f.hook(async (_method, params) => { if (params.type === 'mouseWheel') scroller.scrollTop += params.deltaY; });
  await f.perform({ action: 'scroll', y: 4584 });
  assert.equal(scroller.scrollTop, 4584);
});

test('scroll omits its position on a failed read and sends no further unchecked wheel events', async () => {
  const f = scrollFixture();
  f.hook(async (method, code) => {
    if (method === 'evaluate' && (code.includes('const positions =') || code.includes('const maxY ='))) throw new Error('Context destroyed');
  });
  const result = await f.perform({ action: 'scroll', y: 4584 });
  assert.equal(result.dispatched, true);
  assert.equal(Object.hasOwn(result, 'scroll'), false);
  assert.deepEqual(f.calls.filter(call => call.type === 'mouseWheel').map(call => call.deltaY), [2000]);
});

test('scroll still validates deltas and refuses a challenge at its aim before input', async () => {
  for (const body of [{ x: NaN }, { y: Infinity }, { x: '1' }]) {
    const f = fixture();
    await assert.rejects(f.perform({ action: 'scroll', ...body }), /Scroll deltas must be finite/);
    assert.equal(f.calls.length, 0);
  }
  const f = fixture({ found: { challenge: { kind: 'captcha' } } });
  await assert.rejects(f.perform({ action: 'scroll', y: 4584 }), /challenge_present/);
  assert.equal(f.calls.some(call => call.type === 'mouseWheel'), false);
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
  for (const body of [{ epoch: 2, action: 'click', ref: 'e1' }, { action: 'type', ref: 'e99', text: 'hello' }, { action: 'move', x: NaN, y: 10 }, { action: 'type', ref: 'e1', text: 'x'.repeat(20001) }]) {
    const f = fixture(); await assert.rejects(f.perform(body)); assert.equal(f.calls.length, 0);
  }
  const f = fixture();
  await assert.rejects(f.agent.perform(f.tab, { epoch: 1, action: 'click', ref: 'e1' }, 'other'), /different bot/);
  f.tab.controller = 'human';
  await assert.rejects(f.perform({ action: 'click', ref: 'e1' }), /human_has_control/);
  assert.equal(f.calls.length, 0);
});

test('takeover during target resolution prevents all subsequent pointer input', async () => {
  const f = fixture();
  f.hook(async method => { if (method === 'evaluate') f.tab.controller = 'human'; });
  await assert.rejects(f.perform({ action: 'click', ref: 'e1' }), /human_has_control/);
  assert.equal(f.calls.some(call => call.method.startsWith('Input.')), false);
  assert.equal(f.calls.at(-1).enabled, false);
});

test('revocation between mouse down and up cannot complete a click on the old target', async () => {
  const f = fixture();
  f.hook(async (method, params) => { if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') f.tab.epoch++; });
  await assert.rejects(f.perform({ action: 'click', ref: 'e1' }), /stale_control_epoch/);
  const released = f.calls.filter(call => call.type === 'mouseReleased');
  assert.deepEqual(released.map(({ x, y, clickCount }) => ({ x, y, clickCount })), [{ x: -1, y: -1, clickCount: 0 }]);
  assert.equal(f.calls.at(-1).enabled, false);
});

test('typing is Chromium text input; empty replacement deletes the selected text', async () => {
  const f = fixture();
  await f.perform({ action: 'type', ref: 'e1', text: 'Agent text' });
  assert.ok(f.calls.some(call => call.method === 'Input.insertText' && call.text === 'Agent text'));
  assert.ok(f.scripts.some(code => code.includes('el.select()')));
  f.calls.length = 0;
  await f.perform({ action: 'type', ref: 'e1', text: '' });
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
  await assert.rejects(f.perform({ action: 'type', ref: 'e1', text: 'hello' }), /Target detached/);
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

test('a name lookup cut short by the control cap refuses instead of acting', async () => {
  const f = fixture({ found: { x: 40, y: 60, ref: 'e9', resolved: 'Go', partial: true } });
  await assert.rejects(f.perform({ action: 'click', name: 'Go' }), /not confirmed as the only match.*e9/);
  assert.equal(f.calls.some(call => call.method.startsWith('Input.')), false, 'no input is dispatched on a guess');
  assert.ok(f.tab.refs.has('e9'), 'the resolved ref is still issued so the agent can opt in');
  // A ref or selector target never consults the name lookup and still acts.
  const byRef = fixture();
  await byRef.perform({ action: 'click', ref: 'e1' });
  assert.equal(byRef.calls.some(call => call.type === 'mousePressed'), true);
});

test('a submit button gets a real click, not a synthetic submit', async () => {
  const f = fixture({ found: { submit: true, nav: true } });
  await f.perform({ action: 'click', ref: 'e2' });
  assert.equal(f.scripts.some(code => code.includes('requestSubmit')), false);
  assert.equal(pointer(f).filter(call => call.type === 'mousePressed').length, 1, 'trusted input carries the click, the submitter and its handlers');
  assert.match(f.scripts.find(code => code.includes('elementFromPoint')), /addEventListener\('submit'/, 'a click on a submit button watches for the submit');
});

test('a submit the page handles does not wait for a navigation, an uncancelled one does', async () => {
  let waited = 0;
  const handled = fixture({ found: { submit: true }, submitted: 'handled', delay: async () => { waited++; } });
  await handled.perform({ action: 'click', ref: 'e2' });
  assert.equal(waited, 0);
  const real = fixture({ found: { submit: true }, submitted: 'navigates', delay: async () => { waited++; } });
  await real.perform({ action: 'click', ref: 'e2' });
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
  await f.perform({ action: 'double_click', ref: 'e1' });
  assert.deepEqual(pointer(f).slice(1).map(({ type, button, buttons, clickCount }) => [type, button, buttons, clickCount]), [
    ['mousePressed', 'left', 1, 1], ['mouseReleased', 'left', 0, 1], ['mousePressed', 'left', 1, 2], ['mouseReleased', 'left', 0, 2],
  ]);
  f.calls.length = 0;
  await f.perform({ action: 'right_click', ref: 'e1' });
  assert.deepEqual(pointer(f).slice(1).map(({ type, button, buttons, clickCount }) => [type, button, buttons, clickCount]), [
    ['mousePressed', 'right', 2, 1], ['mouseReleased', 'right', 0, 1],
  ]);
  assert.equal(f.tab.agentCursor.action, 'click');
});

test('a revoked right click releases the right button outside the viewport', async () => {
  const f = fixture();
  f.hook(async (method, params) => { if (params.type === 'mousePressed') f.tab.epoch++; });
  await assert.rejects(f.perform({ action: 'right_click', ref: 'e1' }), /stale_control_epoch/);
  assert.deepEqual(pointer(f).filter(call => call.type === 'mouseReleased').map(({ x, y, button }) => ({ x, y, button })), [{ x: -1, y: -1, button: 'right' }]);
});

test('drag presses at the source, moves with the button held and releases at the destination', async () => {
  const f = fixture({ visible: false });
  await f.perform({ action: 'drag', ref: 'e1', toX: 300, toY: 200 });
  const events = pointer(f);
  assert.deepEqual(events[0], { type: 'mouseMoved', x: 40, y: 60, button: 'none', buttons: 0, clickCount: undefined });
  assert.deepEqual(events[1], { type: 'mousePressed', x: 40, y: 60, button: 'left', buttons: 1, clickCount: 1 });
  const moves = events.slice(2, -1);
  assert.ok(moves.length >= 2 && moves.every(call => call.type === 'mouseMoved' && call.buttons === 1));
  assert.deepEqual(events.at(-1), { type: 'mouseReleased', x: 300, y: 200, button: 'left', buttons: 0, clickCount: 1 });
  assert.deepEqual({ x: f.tab.agentCursor.x, y: f.tab.agentCursor.y }, { x: 300, y: 200 });
  await assert.rejects(f.perform({ action: 'drag', ref: 'e1' }), /destination/);
  await assert.rejects(f.perform({ action: 'drag', ref: 'e1', toRef: 'e909' }), /Stale/);
  await assert.rejects(f.perform({ action: 'drag', ref: 'e1', toX: 9999, toY: 5 }), /inside the tab viewport/);
});

test('drag to an element resolves the destination before the source', async () => {
  const f = fixture({ visible: false });
  await f.perform({ action: 'drag', ref: 'e1', toRef: 'e2' });
  const locates = f.scripts.filter(code => code.includes('elementFromPoint'));
  assert.equal(locates.length, 2);
  assert.ok(locates[0].includes('e2') && locates[1].includes('e1'), 'the destination is found first so scrolling the source cannot move it');
});

test('select picks an option by value or label and reports it', async () => {
  const f = fixture();
  const result = await f.perform({ action: 'select', ref: 'e1', label: 'Beta' });
  assert.deepEqual(result.matched, { by: 'label', value: 'b', label: 'Beta' });
  const script = f.scripts.find(code => code.includes('has no option matching'));
  assert.ok(script.includes('"Beta"') && script.includes("dispatchEvent(new Event('change'"));
  await assert.rejects(f.perform({ action: 'select', ref: 'e1' }), /value, label, option, text or choice/);
  await assert.rejects(f.perform({ action: 'select', x: 1, label: 'Beta' }), /requires a ref, a name or a selector/);
  const loose = fixture();
  await loose.perform({ action: 'select', ref: 'e1', value: 'b' });
  assert.match(loose.scripts.find(code => code.includes('elementFromPoint')), /const loose = true && el\.tagName === 'SELECT'/, 'select resolves without a hit test');
  const g = fixture({ select: { fail: 'has no option matching that value or label', options: [{ value: 'a', label: 'Alpha' }] } });
  await assert.rejects(g.perform({ action: 'select', ref: 'e1', value: 'zzz' }), /no option matching.*Alpha/);
});

test('a click that starts a navigation answers after DOMContentLoaded, not before', async () => {
  const f = fixture({ found: { nav: true } });
  const wc = f.tab.view.webContents;
  f.hook(async (method, params) => { if (params.type === 'mouseReleased') wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false }); });
  let done = false;
  const pending = f.perform({ action: 'click', ref: 'e2' }).then(result => { done = true; return result; });
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
  await f.perform({ action: 'click', ref: 'e2' });
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
  let emittedAt = 0;
  setTimeout(() => { emittedAt = Date.now(); spa.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true }); }, 20);
  started = Date.now();
  await watchSpa.settle(true);
  // Measure from the emit: a starved runner defers the timer itself, and what
  // must be prompt is the end of the wait once the route change was seen.
  assert.ok(emittedAt > 0 && Date.now() - emittedAt < 250, 'an in-page route change does not wait out the window');
  watchSpa.stop();
});

const PAGE_WITH_ORDER = { origin: 'https://shop.example', names: ['Add to cart', 'Place order'] };
const dispatched = f => f.calls.filter(call => call.method.startsWith('Input.'));
const approvalFor = (f, extra = {}) => ({ nonce: 'n-' + Math.random().toString(36).slice(2).padEnd(16, '0'), kind: 'purchase', summary: 'Desk lamp', issuedAt: Date.now(), tabId: f.tab.id, epoch: f.tab.epoch, binding: proofFor({}), ...extra });
const approved = async (f, body, approval = approvalFor(f)) => { approval.binding = proofFor(body); body = { epoch: 1, ...body, approval }; f.agent.approve(f.tab, body); return f.agent.perform(f.tab, body, 'bot'); };

test('legacy proof, changed action arguments, changed document and changed target refuse before input', async () => {
  const legacy = fixture(), body = { action: 'click', ref: 'e1' }, receipt = approvalFor(legacy);
  delete receipt.binding;
  assert.throws(() => legacy.agent.approve(legacy.tab, { ...body, approval: receipt }), /update.*plugin.*host/i);
  assert.deepEqual(dispatched(legacy), []);
  const changed = approvalFor(legacy, { binding: proofFor(body) });
  assert.throws(() => legacy.agent.approve(legacy.tab, { action: 'click', ref: 'e2', approval: changed }), /operation differs/);
  for (const options of [{ approvalContext: { ...TEST_CONTEXT, documentId: 'c'.repeat(32) } }, { approvalTarget: 'd'.repeat(32) }]) {
    const f = fixture(options);
    await assert.rejects(approved(f, body), /approval_invalid:.*(document|control)/);
    assert.deepEqual(dispatched(f), []);
  }
  const a = { action: 'batch', dialog: { accept: false }, steps: [body] };
  const b = { steps: [body], dialog: { accept: false }, action: 'batch', epoch: 8, tabId: 'another', generation: 19 };
  assert.equal(approvalActionKey(a), approvalActionKey(b), 'routing metadata and JSON field order do not change the operation');
  assert.notEqual(approvalActionKey(a), approvalActionKey({ ...a, dialog: { accept: true } }), 'outer batch dialog acceptance is part of review');
});

test('a click whose resolved target reads as a commit is refused before any input, and runs once approved', async () => {
  const f = fixture({ found: { look: { names: ['Plаce ​order'], field: false, form: null } } });
  await assert.rejects(f.perform({ action: 'click', name: 'x' }), err => err.status === 403 && /^commit_required: "Pl.*" looks like it buys/.test(err.message));
  await assert.rejects(f.perform({ action: 'right_click', name: 'x' }), /commit_required/);
  assert.deepEqual(dispatched(f), [], 'nothing was sent');
  await approved(f, { action: 'click', name: 'x' });
  assert.deepEqual(pointer(f).map(call => call.type), ['mouseMoved', 'mousePressed', 'mouseReleased']);
});

test('look-alike names pass: Add to cart, Send code, a Pay with picker, Purchase history, a filter chip delete', async () => {
  for (const name of ['Add to cart', 'Send code', 'Pay with Google Pay', 'Purchase history', 'Delete filter']) {
    const f = fixture({ found: { look: { names: [name], field: false, form: null } } });
    await f.perform({ action: 'click', name });
    assert.equal(pointer(f).filter(call => call.type === 'mousePressed').length, 1, name);
  }
});

test('a tax-income accordion passes, but its label cannot hide a commit action', async () => {
  const name = 'Business and Rental Income 1099-NEC, 1099-MISC, Schedule C, K-1s';
  const f = fixture({ found: { look: { names: [name] } } });
  await f.perform({ action: 'click', name });
  assert.equal(pointer(f).filter(call => call.type === 'mousePressed').length, 1);
  for (const name of ['Schedule pickup', 'Schedule post', 'Schedule a meeting', 'Schedule C - Submit return', 'Schedule C - Buy', 'Delete account']) {
    const commit = fixture({ found: { look: { names: [name] } } });
    await assert.rejects(commit.perform({ action: 'click', name }), /commit_required/, name);
    assert.deepEqual(dispatched(commit), [], name);
  }
});

test('Enter in a field is judged by its form\'s submit controls; a space in a field or a click into one is not', async () => {
  const field = { names: ['Email'], field: true, form: ['Place order'] };
  const f = fixture({ found: { look: field }, probe: field });
  for (const key of ['Enter', 'Return', '\r', '\n']) {
    await assert.rejects(f.perform({ action: 'press', ref: 'e1', key }), /commit_required: pressing Enter here submits the form with "Place order"/, key);
    await assert.rejects(f.perform({ action: 'press', key }), /commit_required: pressing Enter/, `${key} on the focused field`);
  }
  assert.deepEqual(dispatched(f), []);
  await f.perform({ action: 'press', ref: 'e1', key: ' ' });
  await f.perform({ action: 'click', ref: 'e1' });
  const search = fixture({ found: { look: { names: ['Search'], field: true, form: ['Search'] } } });
  await search.perform({ action: 'press', ref: 'e1', key: 'Enter' });
  assert.equal(search.calls.filter(call => call.type === 'keyDown').length, 1, 'Enter in a search form submits');
});

test('input landing in a cross-origin frame needs approval; an unreadable point fails closed only on a commit page', async () => {
  const frame = fixture({ probe: { frame: true }, found: { look: { frame: true, approvalContext: null, approvalTarget: null } } });
  await assert.rejects(frame.perform({ action: 'click', x: 100, y: 100 }), /commit_required: a click here lands in a cross-origin frame/);
  await assert.rejects(frame.perform({ action: 'press', key: 'Enter' }), /commit_required: pressing Enter here lands in a cross-origin frame/);
  await assert.rejects(frame.perform({ action: 'drag', ref: 'e1', toX: 300, toY: 300 }), /cross-origin frame/, 'a drag judges where it drops');
  assert.deepEqual(dispatched(frame), []);
  await assert.rejects(approved(frame, { action: 'click', x: 100, y: 100 }), /approval_invalid/, 'opaque frame cannot supply live target proof');
  const blank = fixture({ probe: null, page: PAGE_WITH_ORDER });
  await assert.rejects(blank.perform({ action: 'click', x: 100, y: 100 }), /where the app cannot read the page here could set off "Place order"/);
  const quiet = fixture({ probe: null });
  await quiet.perform({ action: 'click', x: 100, y: 100 });
  const named = fixture({ probe: { names: ['Place order'], field: false, form: null } });
  await assert.rejects(named.perform({ action: 'double_click', x: 100, y: 100 }), /commit_required: "Place order"/, 'a coordinate is hit-tested to its control');
});

test('an approval counts once, within 120s, on its own tab and epoch, and a bad one refuses the action', async () => {
  let clock = 1_000_000;
  const f = fixture({ now: () => clock, found: { look: { names: ['Buy now'], field: false, form: null } } });
  const once = approvalFor(f, { issuedAt: clock });
  await approved(f, { action: 'click', ref: 'e1' }, once);
  await assert.rejects(approved(f, { action: 'click', ref: 'e1' }, once), err => err.status === 403 && /^approval_invalid: the approval was already used/.test(err.message));
  clock += 121000;
  await assert.rejects(approved(f, { action: 'click', ref: 'e1' }, approvalFor(f, { issuedAt: clock - 120001 })), /expired/);
  await assert.rejects(approved(f, { action: 'click', ref: 'e1' }, approvalFor(f, { issuedAt: clock + 6000 })), /expired/, 'a clock far ahead is not trusted');
  await approved(f, { action: 'click', ref: 'e1' }, approvalFor(f, { issuedAt: clock + 4000 }));
  await assert.rejects(approved(f, { action: 'click', ref: 'e1' }, approvalFor(f, { issuedAt: clock, epoch: 2 })), /another tab or control epoch/);
  await assert.rejects(approved(f, { action: 'click', ref: 'e1' }, approvalFor(f, { issuedAt: clock, tabId: 'tab-2' })), /another tab or control epoch/);
  for (const bad of [null, 'yes', { nonce: 'short', kind: 'purchase', summary: 's', issuedAt: clock }, approvalFor(f, { kind: 'shopping' }), approvalFor(f, { summary: 'x'.repeat(201) }), approvalFor(f, { issuedAt: 'now' })])
    assert.throws(() => f.agent.approve(f.tab, { approval: bad }), /approval_invalid: approval needs/);
  const body = { action: 'click', ref: 'e1', [APPROVED]: true };
  assert.equal(body[APPROVED], true, 'only approve() sets the mark; JSON cannot carry a symbol key');
  assert.equal(JSON.parse(JSON.stringify(body))[APPROVED], undefined);
});

test('page scripts, acting DevTools calls, reloads and action addresses are refused while the page shows a commit control', async () => {
  const live = fixture({ page: PAGE_WITH_ORDER });
  const refuse = (body, pattern) => assert.rejects(live.agent.guard(live.tab, body), pattern, JSON.stringify(body));
  await refuse({ action: 'eval', code: '1' }, /commit_required: a page script here could set off "Place order"/);
  for (const method of ['Runtime.evaluate', 'Runtime.callFunctionOn', 'Input.dispatchMouseEvent', 'DOM.setAttributeValue'])
    await refuse({ action: 'cdp', method }, new RegExp(`the DevTools call ${method.replace('.', '\\.')} here`));
  await refuse({ action: 'reload' }, /reloading here could resubmit/);
  await refuse({ action: 'cdp', method: 'Page.reload' }, /reloading here could resubmit/);
  await refuse({ action: 'navigate', url: 'https://shop.example/checkout/complete' }, /looks like an address that confirms/);
  await refuse({ action: 'cdp', method: 'Page.navigate', params: { url: 'shop.example/orders/7/delete' } }, /looks like an address/);
  for (const body of [{ action: 'cdp', method: 'DOM.getDocument' }, { action: 'cdp', method: 'Accessibility.getFullAXTree' }, { action: 'cdp', method: 'Emulation.setDeviceMetricsOverride' },
    { action: 'navigate', url: 'https://other.example/checkout/complete' }, { action: 'navigate', url: 'https://shop.example/maps/place/x' }, { action: 'read' }, { action: 'wait', text: 'x' },
    { action: 'cdp', method: 'Page.addScriptToEvaluateOnNewDocument' }])
    await live.agent.guard(live.tab, body);
  const quiet = fixture();
  await quiet.agent.guard(quiet.tab, { action: 'eval', code: '1' });
  await quiet.agent.guard(quiet.tab, { action: 'reload' });
  const silent = fixture({ page: 'no answer' });
  await assert.rejects(silent.agent.guard(silent.tab, { action: 'eval', code: '1' }), /did not answer the commit check/, 'a page that does not answer fails closed for scripts');
  await silent.agent.guard(silent.tab, { action: 'navigate', url: 'https://shop.example/pay' });
});

test('a key is judged by the element that holds focus, not by a target that could not take it', async () => {
  const f = fixture({ found: { look: { names: ['Shipping notes'], field: false, form: null } }, probe: { names: ['Pay now'], field: false, form: null } });
  await assert.rejects(f.perform({ action: 'press', ref: 'e1', key: 'Enter' }), /commit_required: "Pay now"/);
  assert.equal(f.calls.filter(call => call.type === 'keyDown').length, 0);
});

test('a key aimed at a CAPTCHA answers challenge_present before the commit check', async () => {
  const f = fixture({ probe: { frame: true }, challenge: { kind: 'recaptcha' }, page: PAGE_WITH_ORDER });
  f.tab.challengeLog = { on: 'recaptcha' };
  await assert.rejects(f.perform({ action: 'press', key: 'Enter' }), err => err.code === 'challenge_present');
  assert.deepEqual(dispatched(f), []);
});

test('a page script that sets up later work or submits on its own needs approval on any page', async () => {
  const quiet = fixture();
  for (const code of ['setInterval(() => document.querySelector("#place")?.click(), 500)', 'setTimeout(go, 9)', 'new MutationObserver(go).observe(document, { subtree: true })', 'fetch("/orders", { method: "POST" })',
    'new XMLHttpRequest()', 'document.forms[0].requestSubmit()', 'document.forms[0].submit()', 'document.body.addEventListener("click", go)', 'button.onclick = go', 'a.href = "JavaScript:go()"', 'new Function("go()")()', 'navigator.sendBeacon("/x")'])
    await assert.rejects(quiet.agent.guard(quiet.tab, { action: 'eval', code }), /commit_required: a page script that uses .* can act after this check/, code);
  for (const [method, params] of [['Runtime.evaluate', { expression: 'setTimeout(go, 9)' }], ['Runtime.callFunctionOn', { functionDeclaration: 'function () { this.requestSubmit(); }' }], ['DOM.setAttributeValue', { nodeId: 3, name: 'onclick', value: 'go()' }], ['DOM.setOuterHTML', { nodeId: 3, outerHTML: '<img src=x onerror=go()>' }]])
    await assert.rejects(quiet.agent.guard(quiet.tab, { action: 'cdp', method, params }), /commit_required: the DevTools call .* that uses/, method);
  for (const code of ['document.title', '[...document.querySelectorAll("li")].map(li => li.textContent)', '(() => { function f(x) { return x; } return typeof f === "function"; })()', 'document.querySelector("button[type=submit]").textContent', 'typeof f.onsubmit'])
    await quiet.agent.guard(quiet.tab, { action: 'eval', code });
  const body = { action: 'eval', code: 'setTimeout(go, 9)' };
  body.approval = approvalFor(quiet, { binding: proofFor(body) });
  body.approval.binding.steps[0].targets = [];
  quiet.agent.approve(quiet.tab, body);
  await quiet.agent.guard(quiet.tab, body);
});

// The receipt alans-way-agents #89 (1515ce6, settleApproval) attaches to the
// one forward the user approved, built the same way.
test('the router\'s approval receipt is accepted once, for its tab and epoch', async () => {
  const f = fixture({ found: { look: { names: ['Place order'], field: false, form: null } } });
  const entry = { commit: { kind: 'purchase', summary: 'x'.repeat(200) }, bound: { tabId: f.tab.id, epoch: f.tab.epoch } };
  const receipt = { nonce: require('node:crypto').randomUUID(), kind: entry.commit.kind, summary: entry.commit.summary, issuedAt: Date.now(), tabId: entry.bound.tabId, epoch: entry.bound.epoch };
  await approved(f, { action: 'click', name: 'Place order' }, receipt);
  assert.equal(pointer(f).filter(call => call.type === 'mousePressed').length, 1);
  await assert.rejects(approved(f, { action: 'click', name: 'Place order' }, receipt), /already used/);
});

test('Enter in a field outside a form, or in a form with no named submit, is judged by the page', async () => {
  for (const form of [null, []]) {
    const field = { names: ['Message'], field: true, form };
    const live = fixture({ found: { look: field }, probe: field, page: { origin: 'https://chat.example', names: ['Delete conversation'] } });
    await assert.rejects(live.perform({ action: 'press', ref: 'e1', key: 'Enter' }), new RegExp(`commit_required: pressing Enter in ${form ? 'a form with no named submit control' : 'a field outside a form'} here could set off "Delete conversation"`));
    assert.deepEqual(dispatched(live), []);
    const quiet = fixture({ found: { look: field }, probe: field, page: { origin: 'https://chat.example', names: ['Search'] } });
    await quiet.perform({ action: 'press', ref: 'e1', key: 'Enter' });
    assert.equal(quiet.calls.filter(call => call.type === 'keyDown').length, 1, 'a page with no commit control lets Enter through');
  }
});

test('dry approval checks preserve the receipt for one real dispatch', async () => {
  const f = fixture();
  const approval = approvalFor(f);
  f.tab.preflight = true;
  f.agent.approve(f.tab, { approval });
  f.agent.approve(f.tab, { approval });
  f.tab.preflight = false;
  f.agent.approve(f.tab, { approval });
  assert.throws(() => f.agent.approve(f.tab, { approval }), /already used/);
});

test('only a dry-validated receipt carries across one takeover, retaining nonce/tab/epoch binding', () => {
  const f = fixture();
  const receipt = approvalFor(f);
  const body = { approval: receipt };
  assert.throws(() => f.agent.carryApproval(f.tab, body, 1), /another tab or control epoch/);
  f.tab.preflight = true;
  f.agent.approve(f.tab, { approval: receipt });
  f.tab.preflight = false;
  assert.throws(() => f.agent.carryApproval({ ...f.tab }, body, 1), /another tab or control epoch/);
  assert.throws(() => f.agent.carryApproval(f.tab, { approval: { ...receipt } }, 1), /another tab or control epoch/);
  f.tab.epoch = 2;
  assert.throws(() => f.agent.carryApproval(f.tab, body, 1), /another tab or control epoch/);
  f.tab.epoch = 1;
  f.agent.carryApproval(f.tab, body, 1);
  f.tab.epoch = 3;
  assert.throws(() => f.agent.approve(f.tab, body), /another tab or control epoch/);
  f.tab.epoch = 2;
  assert.throws(() => f.agent.approve(f.tab, { approval: receipt }), /another tab or control epoch/, 'JSON cannot carry the internal transfer');
  f.agent.approve(f.tab, body);
  assert.throws(() => f.agent.approve(f.tab, body), /already used|another tab or control epoch/);
});

test('a receipt expiring after dry validation is still refused at takeover', () => {
  const f = fixture(); let clock = Date.now();
  f.agent = createAgentInput({ command: async () => ({}), requireActor, now: () => clock });
  const approval = approvalFor(f, { issuedAt: clock });
  f.tab.preflight = true; f.agent.approve(f.tab, { approval });
  f.tab.preflight = false;
  clock += 120001;
  assert.throws(() => f.agent.carryApproval(f.tab, { approval }, 1), /expired/);
});

test('certain locator failures offer bounded candidates without dispatching input', async () => {
  const f = fixture({ found: { fail: 'missing or disabled', candidates: Array.from({ length: 20 }, (_, i) => ({ ref: `e${i + 10}`, name: 'Candidate '.repeat(50), row: 'row '.repeat(100) })) } });
  await assert.rejects(f.perform({ action: 'click', selector: '#old-control' }), error => {
    assert.match(error.message, /Candidates: e10/);
    assert.ok(error.message.length < 1800);
    assert.doesNotMatch(error.message, /e15 /);
    return true;
  });
  assert.equal(pointer(f).length, 0);
  assert.ok(f.tab.refs.has('e10'));
  assert.equal(f.tab.refs.has('e15'), false);
});

test('a target still mismatched after one re-resolution receives no press', async () => {
  const f = fixture({ matches: false });
  await assert.rejects(f.perform({ action: 'click', ref: 'e1' }), /could not be verified/);
  assert.equal(pointer(f).filter(e => e.type === 'mouseMoved').length, 2, 'only one retry');
  assert.equal(pointer(f).some(e => e.type === 'mousePressed'), false);
});

test('an unreadable post-hover hit receives no press', async () => {
  const f = fixture();
  f.hook(async (method, code) => { if (method === 'evaluate' && code.includes('matches:')) throw new Error('renderer unavailable'); });
  await assert.rejects(f.perform({ action: 'click', ref: 'e1' }), /could not be verified/);
  assert.equal(pointer(f).some(e => e.type === 'mousePressed'), false);
});

test('a double click verifies the target again before its second press', async () => {
  const f = fixture();
  let pressed = false;
  f.hook(async (method, params) => {
    if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') pressed = true;
    if (method === 'evaluate' && params.includes('matches:') && pressed) throw new Error('target changed');
  });
  await assert.rejects(f.perform({ action: 'double_click', ref: 'e1' }), /could not be verified/);
  assert.equal(pointer(f).filter(e => e.type === 'mousePressed').length, 1);
});

test('double-click verification preserves the first click follow-up tracker', async () => {
  const f = fixture();
  await f.perform({ action: 'double_click', ref: 'e1' });
  const probes = f.scripts.filter(code => code.includes('matches:'));
  assert.equal(probes.length, 4, 'both presses are verified before and after policy checks');
  assert.equal(probes.filter(code => code.includes('S.cur = { open: true')).length, 1, 'the second probe must not replace pending work from the first click');
});

test('a target moving during the final policy await is rechecked before pressing', async () => {
  const f = fixture({ visible: false });
  const evaluate = f.tab.view.webContents.executeJavaScript;
  let checks = 0, verifiedLast = false;
  f.tab.view.webContents.executeJavaScript = async code => {
    const result = await evaluate(code);
    if (code.includes('matches:')) {
      checks++;
      // The first hit was Search; a layout update now puts Appearance there.
      verifiedLast = checks > 1;
      if (checks === 2) return { ...result, matches: false };
    }
    return result;
  };
  f.hook(async (method, params) => {
    if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed')
      assert.equal(verifiedLast, true, 'Search must be checked again after the policy await');
  });
  await f.perform({ action: 'click', ref: 'e1' });
  assert.equal(pointer(f).filter(call => call.type === 'mousePressed').length, 1);
  assert.ok(checks >= 4, 'the moved target is resolved and verified again');
});

test('a changed policy meaning or approval target at the final hit receives no press', async () => {
  for (const useApproval of [false, true]) {
    const f = fixture();
    const evaluate = f.tab.view.webContents.executeJavaScript;
    let checks = 0;
    f.tab.view.webContents.executeJavaScript = async code => {
      const result = await evaluate(code);
      if (code.includes('matches:') && ++checks >= 2)
        return { ...result, look: { ...result.look, names: ['Donate'], approvalTarget: 'c'.repeat(32) } };
      return result;
    };
    const click = { action: 'click', ref: 'e1' };
    await assert.rejects(useApproval ? approved(f, click) : f.perform(click), /commit_required|approval_invalid/);
    assert.equal(pointer(f).some(call => call.type === 'mousePressed'), false);
  }
});
