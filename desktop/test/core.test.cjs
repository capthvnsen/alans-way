const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeUrl, parseRemoteUrl, isSshTarget, requireActor, requireAgentRead, requireAgentClaim, reviewedHandoff, isAuthorized, sanitizeBots } = require('../src/core.cjs');
const { snapshotExpression } = require('../src/browser-page.cjs');

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
test('an overseer bypasses ownership but not the control and epoch gates', () => {
  const tab = { botId: 'research', controller: 'agent', epoch: 4, allowedBots: [] };
  requireActor(tab, 'overseer', 4, true, true);
  assert.throws(() => requireActor(tab, 'overseer', 3, true, true), /stale_control_epoch/);
  tab.controller = 'human'; tab.epoch++;
  assert.throws(() => requireActor(tab, 'overseer', 5, true, true), /human_has_control/);
  assert.throws(() => requireActor(tab, '', 5, true, true), /X-Hermes-Bot/);
});
test('human-controlled tabs reject bot page reads', () => {
  assert.throws(() => requireAgentRead({ controller: 'human' }), /human control/);
  requireAgentRead({ controller: 'agent' });
});
test('API authentication rejects missing, truncated and different tokens', () => {
  assert.equal(isAuthorized('Bearer paired-secret', 'paired-secret'), true);
  for (const header of [undefined, 'Bearer paired', 'Bearer another-secret']) assert.equal(isAuthorized(header, 'paired-secret'), false);
});
test('saved SSH addresses accept user@host or an alias and nothing a shell would interpret', () => {
  for (const value of ['me@mac.example.ts.net', 'mymac', 'me@192.0.2.7', 'a_b-c.d']) assert.equal(isSshTarget(value), true, value);
  for (const value of ['', 'mac; rm -rf ~', 'mac$(id)', 'mac`id`', '-oProxyCommand=id', 'alex@mac other', 'mac\nid', 'mac|id', "mac'x", 'a@b@c', '-x@mac'])
    assert.equal(isSshTarget(value), false, JSON.stringify(value));
});
test('a handoff source and an unverified destination refuse agent claims until the human gives them over', () => {
  assert.throws(() => requireAgentClaim({ handoff: { phase: 'handed_off', destinationHost: 'vps', destinationTabId: 't2' } }), /handoff_source.*vps tab t2/);
  assert.throws(() => requireAgentClaim({ handoff: { phase: 'review_required', verification: 'review_required' } }), /handoff_review_required/);
  requireAgentClaim({ handoff: { phase: 'review_required', verification: 'ready' } });
  requireAgentClaim({});
  const reviewed = reviewedHandoff({ phase: 'handed_off', destinationHost: 'vps' });
  assert.equal(reviewed.phase, 'reviewed');
  requireAgentClaim({ handoff: reviewed });
  assert.equal(reviewedHandoff(undefined), undefined);
});
test('snapshot bounds clamp and never splice caller text into page code', () => {
  assert.match(snapshotExpression(3), /text\.slice\(0, 6000\)/);
  assert.match(snapshotExpression(3, { maxChars: 999999 }), /text\.slice\(0, 20000\)/);
  assert.doesNotMatch(snapshotExpression(3, { maxChars: '1);alert(1' }), /alert/);
});
test('only positively identified direct bot IDs enter the catalog', () => {
  const bots = sanitizeBots([{ id: '123', isBot: true, name: 'Agent' }, { id: '456', name: 'Human' }, { id: '-100123', isBot: true }, { id: '789', isBot: false }]);
  assert.deepEqual(bots.map((bot) => bot.id), ['123']);
});
