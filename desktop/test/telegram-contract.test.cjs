const { test } = require('node:test');
const assert = require('node:assert/strict');
const { contractHolds, createContractMonitor } = require('../src/telegram-contract.cjs');

const healthy = { dbDiag: 'ok', cached: { currentUserId: '1', users: { byId: {} }, chats: { byId: {} } }, authVisible: false, hasLeftColumn: true };

test('a logged-in Telegram with the expected state shape and left column holds the contract', () => {
  assert.equal(contractHolds(healthy), true);
});
test('the login screen and the passcode lock are expected states', () => {
  assert.equal(contractHolds({ dbDiag: 'empty:tt-global-state', cached: null, authVisible: true, hasLeftColumn: false }), true);
  assert.equal(contractHolds({ dbDiag: 'ok', cached: { passcode: { isScreenLocked: true } }, authVisible: false, hasLeftColumn: false }), true);
});
test('a moved database, missing slices, or a missing left column break it', () => {
  assert.equal(contractHolds({ ...healthy, dbDiag: 'no-store:other' }), false);
  assert.equal(contractHolds({ ...healthy, cached: { currentUserId: '1', users: {}, chats: { byId: {} } } }), false);
  assert.equal(contractHolds({ ...healthy, cached: { currentUserId: '1', users: { byId: {} } } }), false);
  assert.equal(contractHolds({ ...healthy, hasLeftColumn: false }), false);
  assert.equal(contractHolds({ ...healthy, cached: {} }), false);
});
test('the monitor trips on elapsed time, not poll count, and a good poll resets the run', () => {
  const monitor = createContractMonitor(90000);
  const loggedIn = { loggedIn: true };
  assert.equal(monitor.observe(false, loggedIn, 0), false);
  for (let t = 1000; t < 90000; t += 1000) assert.equal(monitor.observe(false, loggedIn, t), false, `${t}`);
  assert.equal(monitor.observe(true, {}, 60000), false);
  assert.equal(monitor.observe(false, loggedIn, 70000), false);
  assert.equal(monitor.observe(false, loggedIn, 159999), false);
  assert.equal(monitor.observe(false, loggedIn, 160000), true);
  assert.equal(monitor.observe(true, {}, 161000), false);
});
test('a burst of focus-triggered polls adds no misses', () => {
  const monitor = createContractMonitor(90000);
  for (let i = 0; i < 50; i++) assert.equal(monitor.observe(false, { loggedIn: true }, 5000 + i), false);
});
test('right after sign-in nothing trips until the contract has held or the user is clearly logged in', () => {
  const monitor = createContractMonitor(90000);
  assert.equal(monitor.observe(true, {}, 0), false, 'login screen is expected');
  for (let t = 1000; t <= 200000; t += 5000) assert.equal(monitor.observe(false, { loggedIn: false }, t), false, 'not logged in, never held');
  const second = createContractMonitor(90000);
  assert.equal(second.observe(true, { full: true }, 0), false);
  assert.equal(second.observe(false, { loggedIn: false }, 1000), false);
  assert.equal(second.observe(false, { loggedIn: false }, 91000), true, 'held once, then lost for 90s');
});
