const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/remote.js'), 'utf8');
test('picture drag follows screen movement while its native view moves underneath it', () => {
  const listeners = {}, calls = [], position = { x: 450, y: 350 };
  let captured;
  const target = { closest: () => false, setPointerCapture: id => { captured = id; } };
  vm.runInNewContext(source.slice(source.indexOf('let pdrag ='), source.indexOf("$('screen').onclick")), {
    state: { remoteControl: false, activeTabId: 'home' },
    document: { addEventListener: (name, fn) => { listeners[name] = fn; } },
    api: { command: async (name, value) => {
      calls.push(name);
      if (name === 'preview-nudge') { position.x += value.dx; position.y += value.dy; }
    } },
  });
  const event = (screenX, screenY) => ({ screenX, screenY,
    clientX: screenX - position.x, clientY: screenY - position.y, target, pointerId: 1 });
  listeners.pointerdown(event(500, 400));
  for (let i = 1; i <= 8; i++) {
    listeners.pointermove(event(500 - i * 12, 400 - i * 8));
    assert.deepEqual(position, { x: 450 - i * 12, y: 350 - i * 8 }, `move ${i} must retain the original grab offset`);
  }
  assert.equal(captured, 1, 'capture keeps the drag alive when the pointer leaves the picture');
  listeners.pointerup(event(404, 336));
  assert.equal(calls.at(-1), 'preview-drop');
  listeners.pointerdown(event(404, 336));
  listeners.pointermove(event(424, 356));
  listeners.pointercancel(event(424, 356));
  assert.equal(calls.at(-1), 'preview-drop', 'a canceled drag also ends the renderer drag and persists its position');
  listeners.pointermove(event(444, 376));
  assert.deepEqual(position, { x: 374, y: 306 }, 'canceled drags stop moving');
});
