'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createBootTimer } = require('../src/boot-timing.cjs');

test('boot timer is silent when disabled and logs each milestone once when enabled', () => {
  const lines = [];
  let clock = 100;
  const off = createBootTimer({ enabled: false, now: () => clock, write: (line) => lines.push(line) });
  off.mark('process-start');
  assert.deepEqual(lines, []);

  const on = createBootTimer({ enabled: true, now: () => clock, write: (line) => lines.push(line) });
  on.mark('process-start');
  clock = 142.5;
  on.mark('app-ready');
  clock = 210;
  on.mark('app-ready'); // duplicate milestone is ignored
  on.mark('ui-interactive');
  assert.deepEqual(lines, [
    '[boot-timing] process-start +0.0ms\n',
    '[boot-timing] app-ready +42.5ms\n',
    '[boot-timing] ui-interactive +110.0ms\n',
  ]);
});
