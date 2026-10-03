const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeUrl, parseRemoteUrl, requireActor, isAuthorized, sanitizeBots } = require('../src/core.cjs');

test('browser URLs reject executable and credential-bearing schemes', () => {
  for (const value of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,test', 'https://user:password@example.com']) assert.throws(() => normalizeUrl(value));
  assert.equal(normalizeUrl('github.com'), 'https://github.com/');
  assert.equal(normalizeUrl('localhost:3000/test'), 'http://localhost:3000/test');
  assert.match(normalizeUrl('browser task handoff'), /^https:\/\/www.google.com\/search\?/);
});
test('existing noVNC links map to their websocket route', () => {
  assert.equal(parseRemoteUrl('https://desktop.example:8445/vnc.html?view_only=true'), 'wss://desktop.example:8445/websockify');
  assert.equal(parseRemoteUrl('https://desktop.example/view/vnc.html?path=socket'), 'wss://desktop.example/view/socket');
  assert.equal(parseRemoteUrl('wss://desktop.example/ws'), 'wss://desktop.example/ws');
  assert.throws(() => parseRemoteUrl('file:///etc/passwd'));
});
test('a bot cannot accidentally drive another bot tab or stale human takeover', () => {
  const tab = { botId: 'research', controller: 'agent', epoch: 4, allowedBots: [] };
  assert.throws(() => requireActor(tab, 'content', 4, true), /different bot/);
  assert.throws(() => requireActor(tab, 'research', 3, true), /stale_control_epoch/);
  requireActor(tab, 'research', 4, true);
  tab.controller = 'human'; tab.epoch++;
  assert.throws(() => requireActor(tab, 'research', 5, true), /human_has_control/);
  requireActor(tab, 'research');
});
test('explicit crossover grant permits a second bot', () => {
  requireActor({ botId: 'research', controller: 'agent', epoch: 1, allowedBots: ['content'] }, 'content', 1, true);
});
test('API authentication rejects missing, truncated and different tokens', () => {
  assert.equal(isAuthorized('Bearer paired-secret', 'paired-secret'), true);
  for (const header of [undefined, 'Bearer paired', 'Bearer another-secret']) assert.equal(isAuthorized(header, 'paired-secret'), false);
});
test('only positively identified direct bot IDs enter the catalog', () => {
  const bots = sanitizeBots([{ id: '123', isBot: true, name: 'Agent' }, { id: '456', name: 'Human' }, { id: '-100123', isBot: true }, { id: '789', isBot: false }]);
  assert.deepEqual(bots.map((bot) => bot.id), ['123']);
});
