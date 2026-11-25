const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Avatars = require('../src/avatars.js');
const { GATEWAYS, NATIVE_CHAT_LABEL, nativeChatBetaLabel, labelOf, botRows, unreadLabel, createUnreadOrder, previewOrder } = require('../src/gateway-list.js');

const alan = { id: '1', name: 'Alan', username: 'alan_bot' };
const mira = { id: '2', name: 'Mira', username: 'mira_bot' };
const scout = { id: '3', name: 'Scout', username: 'scout_bot' };
const shape = (result) => result.rows.map((row) => [row.bot.id, row.gateways]);

test('gateways come in a fixed order: Telegram, Hermes, native chat', () => {
  assert.equal(NATIVE_CHAT_LABEL, 'Alan’s native chat (beta)');
  assert.equal(nativeChatBetaLabel(), 'Beta');
  assert.deepEqual(GATEWAYS.map((gateway) => [gateway.id, gateway.label]), [['telegram', 'Telegram'], ['hermes-desktop', 'Hermes'], ['native', NATIVE_CHAT_LABEL]]);
  assert.equal(labelOf('native'), NATIVE_CHAT_LABEL);
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
  assert.equal(unreadLabel(['telegram', 'hermes-desktop', 'native']), 'Unread in Telegram, Hermes and Alan’s native chat (beta)');
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

// The row status helpers are sliced out of renderer.js and run against a minimal fake DOM, as hermes-pane.test.cjs does.
const renderer = fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8');
const slice = (from, to) => renderer.slice(renderer.indexOf(from), renderer.indexOf(to, renderer.indexOf(from)));
function fakeNode(className = '') {
  const node = { className, title: '', attributes: {}, dataset: {}, props: {}, classes: new Set(className.split(' ').filter(Boolean)), children: [], style: { setProperty: (key, value) => { node.props[key] = value; } },
    setAttribute: (key, value) => { node.attributes[key] = String(value); }, classList: { toggle: (name, on) => { node.classes[on ? 'add' : 'delete'](name); }, contains: (name) => node.classes.has(name) },
    querySelector: (selector) => (selector === '.bot-open' ? node.open : null) };
  return node;
}
function rowStatus(state, shownSurface) {
  const context = { state, window: { HermesAvatars: Avatars }, element: (_tag, cls) => fakeNode(cls), shownGateway: () => shownSurface };
  vm.runInNewContext(`${slice('function colorFor', 'const SURFACE_OF')}\n${slice('function renderBotActivity', '// The chat header')}\nthis.api = { colorFor, isUnreachable, errorBadge, renderBotActivity };`, context);
  return context.api;
}
const render = (api, bot) => { const row = fakeNode('bot-row'), open = fakeNode('bot-open'); open.dataset.label = `Open ${bot.name}`; row.open = open; api.renderBotActivity(row, bot); return { row, open }; };

test('an idle bot, or one with no activity signal, shows nothing: no working class and the plain accessible name', () => {
  const api = rowStatus({}, 'telegram');
  for (const activity of [{ state: 'idle' }, undefined, { state: 'unknown' }, { state: 'active', expiresAt: Date.now() - 1 }]) {
    const { row, open } = render(api, { id: '1', name: 'Alan', activity });
    assert.equal(row.classList.contains('working'), false);
    assert.equal(open.attributes['aria-label'], 'Open Alan');
    assert.equal(open.title, '');
  }
});

test('a working bot glows in its colour and says "working" to screen readers', () => {
  const api = rowStatus({}, 'telegram');
  const { row, open } = render(api, { id: '1', name: 'Alan', activity: { state: 'active', label: 'typing…' } });
  assert.equal(row.classList.contains('working'), true);
  assert.equal(row.props['--glow'], api.colorFor('1'), 'a bot with no tint glows in its row colour');
  assert.equal(open.attributes['aria-label'], 'Open Alan, working');
  assert.equal(open.title, 'typing…');
  const tinted = rowStatus({ avatarLibrary: [{ id: 'bust', cutout: true, builtIn: true, dataUrl: 'x' }], avatarPreferences: { 2: { selectedId: 'bust', tint: 'red' } } }, 'telegram');
  assert.equal(render(tinted, { id: '2', name: 'Mira', activity: { state: 'active' } }).row.props['--glow'], 'var(--glow-red)', 'a tinted marble bust glows in its tint');
});

test('unreachable is a badge carrying the reason, and only while Hermes Desktop is the surface that cannot be reached', () => {
  assert.equal(rowStatus({ webappStatus: 'unreachable' }, 'hermes-desktop').isUnreachable('1'), true);
  assert.equal(rowStatus({ webappStatus: 'unreachable' }, 'telegram').isUnreachable('1'), false);
  assert.equal(rowStatus({ webappStatus: 'reachable' }, 'hermes-desktop').isUnreachable('1'), false);
  const badge = rowStatus({}, 'telegram').errorBadge('Can’t reach Hermes Desktop');
  assert.deepEqual([badge.className, badge.attributes.role, badge.attributes['aria-label'], badge.title], ['error-badge', 'img', 'Unreachable: Can’t reach Hermes Desktop', 'Can’t reach Hermes Desktop']);
});

test('the working glow holds still under reduced motion, and no status text is left in the row or presence card', () => {
  const css = fs.readFileSync(path.join(__dirname, '../src/style.css'), 'utf8');
  assert.match(css, /@media\(prefers-reduced-motion:no-preference\)\{\.bot-row\.working::after[^}]*animation:glow-pulse/);
  for (const text of ["'Idle'", "'Unreachable'", "'Waiting'", "'status-text"]) assert.equal(renderer.includes(text), false, `${text} is gone from renderer.js`);
});
