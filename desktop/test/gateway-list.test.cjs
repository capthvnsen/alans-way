const test = require('node:test');
const assert = require('node:assert/strict');
const { GATEWAYS, labelOf, botRows, unreadLabel, createUnreadOrder, previewOrder } = require('../src/gateway-list.js');

const alan = { id: '1', name: 'Alan', username: 'alan_bot' };
const mira = { id: '2', name: 'Mira', username: 'mira_bot' };
const scout = { id: '3', name: 'Scout', username: 'scout_bot' };
const shape = (result) => result.rows.map((row) => [row.bot.id, row.gateways]);

test('gateways come in a fixed order: Telegram, Hermes, Alan’s Way', () => {
  assert.deepEqual(GATEWAYS.map((gateway) => [gateway.id, gateway.label]), [['telegram', 'Telegram'], ['hermes-desktop', 'Hermes'], ['native', 'Alan\'s Way']]);
  assert.equal(labelOf('native'), 'Alan\'s Way');
  assert.deepEqual(shape(botRows({ bots: [alan], gateways: { 1: ['native', 'telegram', 'hermes-desktop'] } })), [['1', ['telegram', 'hermes-desktop', 'native']]]);
});

test('a bot connected on several gateways is still one row', () => {
  const result = botRows({ bots: [alan, mira], gateways: { 1: ['telegram', 'native'], 2: ['telegram'] } });
  assert.deepEqual(shape(result), [['1', ['telegram', 'native']], ['2', ['telegram']]]);
  assert.equal(result.rows[0].bot, alan);
});

test('a gateway that is not connected for a bot is not listed, and a bot with none has no row', () => {
  const result = botRows({ bots: [alan, mira, scout], gateways: { 1: ['telegram', 'hermes-desktop'], 2: ['native'], 3: [] } });
  assert.deepEqual(shape(result), [['1', ['telegram', 'hermes-desktop']], ['2', ['native']]]);
  assert.deepEqual(botRows({ bots: [], gateways: {} }).rows, []);
});

test('count is the bots on any gateway; found is the ones matching the search', () => {
  const gateways = { 1: ['telegram', 'hermes-desktop', 'native'], 2: ['telegram', 'native'], 3: ['telegram'] };
  const all = botRows({ bots: [alan, mira, scout], gateways });
  assert.deepEqual([all.rows.length, all.count, all.found], [3, 3, 3]);
  const byName = botRows({ bots: [alan, mira, scout], gateways, search: 'ALAN' });
  assert.deepEqual(shape(byName), [['1', ['telegram', 'hermes-desktop', 'native']]]);
  assert.deepEqual([byName.found, byName.count], [1, 3], 'the list count ignores the search');
  assert.equal(botRows({ bots: [alan, mira, scout], gateways, search: '_bot' }).found, 3, 'the username matches too');
  const none = botRows({ bots: [alan, mira, scout], gateways, search: 'zzz' });
  assert.deepEqual([none.rows, none.found, none.count], [[], 0, 3]);
});

test('the input order, which carries the sort, is kept', () => {
  const gateways = { 1: ['telegram', 'native'], 2: ['telegram'], 3: ['telegram', 'native'] };
  assert.deepEqual(botRows({ bots: [scout, alan, mira], gateways }).rows.map((row) => row.bot.id), ['3', '1', '2']);
});

test('a bot the main process has not described yet is a Telegram row only', () => {
  assert.deepEqual(shape(botRows({ bots: [alan], gateways: {} })), [['1', ['telegram']]]);
  assert.deepEqual(shape(botRows({ bots: [alan] })), [['1', ['telegram']]]);
});

test('the unread text names each gateway, for screen readers', () => {
  assert.equal(unreadLabel([]), '');
  assert.equal(unreadLabel(['telegram']), 'Unread in Telegram');
  assert.equal(unreadLabel(['telegram', 'hermes-desktop']), 'Unread in Telegram and Hermes');
  assert.equal(unreadLabel(['telegram', 'hermes-desktop', 'native']), 'Unread in Telegram, Hermes and Alan\'s Way');
});

test('unread chips stack oldest first, so the gateway that became unread last is on top', () => {
  const order = createUnreadOrder();
  assert.deepEqual(order('1', ['telegram']), ['telegram']);
  assert.deepEqual(order('1', ['telegram', 'native']), ['telegram', 'native'], 'native arrived after Telegram');
  assert.deepEqual(order('1', ['native', 'telegram']), ['telegram', 'native'], 'the order does not depend on how the list is given');
  assert.deepEqual(order('1', ['native']), ['native']);
  assert.deepEqual(order('1', ['telegram', 'native']), ['native', 'telegram'], 'Telegram went read, so its next unread is new again');
  assert.deepEqual(order('2', ['native', 'telegram']), ['native', 'telegram'], 'each bot has its own order; a tie keeps the given order');
  assert.deepEqual(order('1', []), []);
  assert.deepEqual(order('1', ['native', 'telegram']), ['native', 'telegram'], 'all read, then both new again');
});

test('the row preview comes from the gateway with the newest unread, then the one on screen, then the rest', () => {
  const gateways = ['telegram', 'hermes-desktop', 'native'];
  assert.deepEqual(previewOrder({ gateways, shown: 'hermes-desktop', unread: [] }), ['hermes-desktop', 'telegram', 'native']);
  assert.deepEqual(previewOrder({ gateways, shown: 'hermes-desktop', unread: ['telegram', 'native'] }), ['native', 'telegram', 'hermes-desktop']);
  assert.deepEqual(previewOrder({ gateways: ['telegram'], shown: 'native', unread: [] }), ['telegram'], 'a gateway the bot is not on is never offered');
});
