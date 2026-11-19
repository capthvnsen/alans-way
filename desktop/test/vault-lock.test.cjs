'use strict';
// The vault lock on an agent tab: what sets it, what lifts it, and what it refuses. Pure Node.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const lock = require('../src/vault-lock.cjs');

test('prompt, filled and released: a refused fill never lifts the lock an earlier fill set', () => {
  const tab = {};
  assert.equal(lock.isLocked(tab), false);
  lock.acquire(tab);
  assert.deepEqual([lock.isLocked(tab), tab.vaultLock], [true, 'prompt']);
  lock.release(tab);
  assert.equal(lock.isLocked(tab), false, 'a fill that did not happen releases');
  lock.acquire(tab); lock.markFilled(tab);
  assert.equal(tab.vaultLock, 'filled');
  lock.acquire(tab);
  assert.equal(tab.vaultLock, 'filled', 'a later prompt does not downgrade it');
  lock.release(tab);
  assert.equal(tab.vaultLock, 'filled', 'and a later refusal does not lift it');
});

test('eval and cdp are refused while locked, with the reason and a 403; everything that submits a login still works', () => {
  const tab = {};
  lock.acquire(tab);
  for (const body of [{ action: 'eval', code: '1' }, { action: 'cdp', method: 'Runtime.evaluate' }, { action: 'cdp', method: 'DOM.getDocument' },
    { action: 'cdp', method: 'DOMSnapshot.captureSnapshot' }, { action: 'cdp', method: 'Page.captureScreenshot' }]) {
    assert.throws(() => lock.guardAction(tab, body), (error) => error.status === 403 && error.code === 'vault_locked' && /paused|locked/i.test(error.message) && /page changes|navigat/i.test(error.message), JSON.stringify(body));
  }
  for (const action of ['click', 'double_click', 'right_click', 'type', 'press', 'select', 'scroll', 'move', 'drag', 'navigate', 'back', 'forward', 'reload', 'read', 'wait', 'batch', 'viewport', 'if', 'repeat']) {
    assert.doesNotThrow(() => lock.guardAction(tab, { action }), action);
  }
  lock.release(tab);
  assert.doesNotThrow(() => lock.guardAction(tab, { action: 'eval', code: '1' }), 'no lock, no change');
});

test('script run by the agent taints the document; read-only DevTools calls and input do not', () => {
  const tab = {};
  for (const body of [{ action: 'click' }, { action: 'cdp', method: 'DOM.getDocument' }, { action: 'cdp', method: 'Emulation.setDeviceMetricsOverride' }, { action: 'cdp', method: 'Page.navigate' }, { action: 'read' }]) {
    lock.noteScript(tab, body);
    assert.equal(!!tab.agentScripted, false, JSON.stringify(body));
  }
  lock.noteScript(tab, { action: 'eval', code: '1' });
  assert.equal(tab.agentScripted, true);
  const other = {};
  lock.noteScript(other, { action: 'cdp', method: 'Runtime.evaluate' });
  assert.equal(other.agentScripted, true);
  const third = {};
  lock.noteScript(third, { action: 'cdp', method: 'DOM.setAttributeValue' });
  assert.equal(third.agentScripted, true, 'a DOM write can plant a handler');
});

test('a cross-document navigation or a crashed page ends the lock and the taint; an in-page navigation does not', () => {
  const wc = new EventEmitter(), tab = { vaultLock: 'filled', agentScripted: true };
  lock.watch(tab, wc);
  for (const event of ['did-navigate-in-page', 'did-start-navigation', 'did-frame-navigate', 'did-finish-load']) {
    wc.emit(event, {}, 'https://example.com/#x', true, true);
    assert.deepEqual([tab.vaultLock, tab.agentScripted], ['filled', true], event);
  }
  wc.emit('did-navigate', {}, 'https://example.com/next');
  assert.deepEqual([tab.vaultLock, tab.agentScripted], [undefined, false]);
  tab.vaultLock = 'filled'; tab.agentScripted = true;
  wc.emit('render-process-gone');
  assert.deepEqual([tab.vaultLock, tab.agentScripted], [undefined, false]);
});

test('blank options: values are blanked exactly while locked', () => {
  assert.deepEqual(lock.readOptions({}), {});
  assert.deepEqual(lock.readOptions({ vaultLock: 'prompt' }), { blankValues: true });
  assert.deepEqual(lock.readOptions({ vaultLock: 'filled' }), { blankValues: true });
});

// A popup the agent opened is an agent tab of the same bot that keeps `window.opener`: at the same origin it can
// script the locked page, so the lock covers it too.
const peerTab = (botId, url, extra = {}) => ({ botId, view: { webContents: { getURL: () => url } }, ...extra });

test('a same-bot tab on the locked tab\'s origin is locked with it, whatever its own state', () => {
  const locked = peerTab('bot1', 'https://example.com/login', { vaultLock: 'filled' });
  const popup = peerTab('bot1', 'https://example.com/popup');
  const elsewhere = peerTab('bot1', 'https://other.test/');
  const otherBot = peerTab('bot2', 'https://example.com/');
  const noUrl = { botId: 'bot1' };
  lock.setPeers(() => [locked, popup, elsewhere, otherBot, noUrl]);
  try {
    assert.equal(lock.isLocked(popup), true);
    assert.throws(() => lock.guardAction(popup, { action: 'eval', code: '1' }), (e) => e.code === 'vault_locked');
    assert.throws(() => lock.guardScreenshot(popup), (e) => e.code === 'vault_locked');
    assert.deepEqual(lock.readOptions(popup), { blankValues: true });
    for (const tab of [elsewhere, otherBot, noUrl]) {
      assert.equal(lock.isLocked(tab), false);
      assert.doesNotThrow(() => lock.guardAction(tab, { action: 'eval', code: '1' }));
    }
    popup.view.webContents.getURL = () => 'https://other.test/x';
    assert.equal(lock.isLocked(popup), false, 'the moment it is on another origin it cannot reach the page');
    elsewhere.view.webContents.getURL = () => 'https://example.com/again';
    assert.equal(lock.isLocked(elsewhere), true, 'and a tab that navigates onto the origin is covered from then on');
    // Only the page\'s own state counts as holding the lock: a peer\'s lock is never released by this tab\'s refusal.
    lock.acquire(popup); lock.release(popup);
    assert.equal(popup.vaultLock, undefined);
  } finally { lock.setPeers(() => []); }
});
