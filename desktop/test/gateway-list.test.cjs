const test = require('node:test');
const assert = require('node:assert/strict');
const { GATEWAYS, gatewaySections } = require('../src/gateway-list.js');

const alan = { id: '1', name: 'Alan', username: 'alan_bot' };
const mira = { id: '2', name: 'Mira', username: 'mira_bot' };
const scout = { id: '3', name: 'Scout', username: 'scout_bot' };
const ids = (section) => section.rows.map((row) => row.bot.id);
const shape = (result) => result.sections.map((section) => [section.id, ids(section)]);

test('sections come in a fixed order: Telegram, Hermes, Alan’s Way', () => {
  assert.deepEqual(GATEWAYS.map((gateway) => [gateway.id, gateway.label]), [['telegram', 'Telegram'], ['hermes-desktop', 'Hermes'], ['native', 'Alan\'s Way']]);
  const gateways = { 1: ['native', 'telegram', 'hermes-desktop'] };
  assert.deepEqual(shape(gatewaySections({ bots: [alan], gateways })), [['telegram', ['1']], ['hermes-desktop', ['1']], ['native', ['1']]]);
});

test('a bot connected on two gateways gets a row in each section', () => {
  const result = gatewaySections({ bots: [alan, mira], gateways: { 1: ['telegram', 'native'], 2: ['telegram'] } });
  assert.deepEqual(shape(result), [['telegram', ['1', '2']], ['native', ['1']]]);
  assert.deepEqual(result.sections[1].rows[0], { bot: alan, gateway: 'native' });
});

test('a gateway that is not connected for a bot gives that bot no row there', () => {
  const result = gatewaySections({ bots: [alan, mira], gateways: { 1: ['telegram', 'hermes-desktop'], 2: ['telegram'] } });
  assert.deepEqual(shape(result), [['telegram', ['1', '2']], ['hermes-desktop', ['1']]]);
});

test('a section with no rows is left out entirely', () => {
  const result = gatewaySections({ bots: [alan, mira], gateways: { 1: ['telegram'], 2: ['telegram'] } });
  assert.deepEqual(result.sections.map((section) => section.id), ['telegram']);
  assert.deepEqual(gatewaySections({ bots: [], gateways: {} }).sections, []);
  assert.deepEqual(gatewaySections({ bots: [alan], gateways: { 1: [] } }).sections, []);
});

test('count is the number of distinct bots, not rows', () => {
  const result = gatewaySections({ bots: [alan, mira, scout], gateways: { 1: ['telegram', 'hermes-desktop', 'native'], 2: ['telegram', 'native'], 3: ['telegram'] } });
  assert.equal(result.sections.reduce((sum, section) => sum + section.rows.length, 0), 6);
  assert.equal(result.count, 3);
});

test('search filters rows in every section by name or username, and counts the bots found', () => {
  const gateways = { 1: ['telegram', 'hermes-desktop', 'native'], 2: ['telegram', 'native'], 3: ['telegram'] };
  const byName = gatewaySections({ bots: [alan, mira, scout], gateways, search: 'ALAN' });
  assert.deepEqual(shape(byName), [['telegram', ['1']], ['hermes-desktop', ['1']], ['native', ['1']]]);
  assert.equal(byName.found, 1);
  assert.equal(byName.count, 3, 'the list count ignores the search');
  const byHandle = gatewaySections({ bots: [alan, mira, scout], gateways, search: '_bot' });
  assert.equal(byHandle.found, 3);
  assert.deepEqual(shape(gatewaySections({ bots: [alan, mira, scout], gateways, search: 'mira' })), [['telegram', ['2']], ['native', ['2']]], 'sections that lose all rows disappear');
  const none = gatewaySections({ bots: [alan, mira, scout], gateways, search: 'zzz' });
  assert.deepEqual([none.sections, none.found, none.count], [[], 0, 3]);
});

test('the input order, which carries the sort, is kept inside each section', () => {
  const gateways = { 1: ['telegram', 'native'], 2: ['telegram'], 3: ['telegram', 'native'] };
  assert.deepEqual(shape(gatewaySections({ bots: [scout, alan, mira], gateways })), [['telegram', ['3', '1', '2']], ['native', ['3', '1']]]);
});

test('a bot the main process has not described yet is a Telegram row only', () => {
  assert.deepEqual(shape(gatewaySections({ bots: [alan], gateways: {} })), [['telegram', ['1']]]);
  assert.deepEqual(shape(gatewaySections({ bots: [alan] })), [['telegram', ['1']]]);
});
