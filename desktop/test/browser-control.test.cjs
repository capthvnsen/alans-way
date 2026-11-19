'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { browserControlState } = require('../src/browser-control.cjs');

test('a page that is not open yet does not offer to give it to an agent', () => {
  assert.deepEqual(browserControlState({ botCount: 0 }), { text: 'You', disabled: true });
  assert.deepEqual(browserControlState({ tab: null, botCount: 3, recipientName: 'Ada' }), { text: 'You', disabled: true });
});

test('a shared page with no agents stays with you', () => {
  const tab = { botId: 'shared', controller: 'human' };
  assert.deepEqual(browserControlState({ tab, botCount: 0 }), { text: 'You', disabled: true });
});

test('a shared page names the selected agent, or agents when none is selected', () => {
  const tab = { botId: 'shared', controller: 'human' };
  assert.deepEqual(browserControlState({ tab, botCount: 2, recipientName: 'Ada' }), { text: 'Give to Ada', disabled: false });
  assert.deepEqual(browserControlState({ tab, botCount: 2 }), { text: 'Give to agents', disabled: false });
});

test('an owned page names that agent, and an agent page offers take over', () => {
  assert.deepEqual(browserControlState({ tab: { botId: '1', controller: 'human' }, ownerName: 'Cedar', botCount: 1 }), { text: 'Give to Cedar', disabled: false });
  assert.deepEqual(browserControlState({ tab: { botId: '1', controller: 'agent' }, ownerName: 'Cedar', botCount: 1 }), { text: 'Take over', disabled: false });
});

test('extension and local PDF pages stay with you', () => {
  for (const tab of [{ extensionPage: true, controller: 'human' }, { localPdf: true, controller: 'agent', botId: '1' }]) {
    assert.deepEqual(browserControlState({ tab, ownerName: 'Cedar', botCount: 1 }), { text: 'You', disabled: true });
  }
});
