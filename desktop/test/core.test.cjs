const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeUrl, agentPageUrl, faviconTarget, redactTabForBot, cdpMethodError, parseRemoteUrl, isSshTarget, requireActor, requireAgentRead, requireAgentClaim, reviewedHandoff, isAuthorized, sanitizeBots } = require('../src/core.cjs');
const { snapshotExpression, settleSnapshot, readControls } = require('../src/browser-page.cjs');
const { omitIcons } = require('../src/omit-icons.cjs');

test('browser URLs reject executable and credential-bearing schemes', () => {
  for (const value of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,test', 'https://user:password@example.com']) assert.throws(() => normalizeUrl(value));
  assert.equal(normalizeUrl('github.com'), 'https://github.com/');
  assert.equal(normalizeUrl('localhost:3000/test'), 'http://localhost:3000/test');
  assert.match(normalizeUrl('browser task handoff'), /^https:\/\/www.google.com\/search\?/);
});
test('agent navigations refuse loopback, link-local and metadata addresses in every spelling', () => {
  for (const value of ['http://127.0.0.1:3000/', 'http://localhost:3000/', 'http://0x7f000001/', 'http://2130706433/', 'http://127.1/', 'http://[::1]/', 'http://[::ffff:7f00:1]/', 'http://0.0.0.0/', 'http://[::]/', 'http://169.254.169.254/latest/meta-data', 'http://169.254.1.1/', 'http://sub.localhost:8080/'])
    assert.throws(() => agentPageUrl(value), /loopback|link-local|metadata/, value);
  for (const value of ['http://192.168.1.20:3000/', 'http://10.0.0.4/', 'http://172.16.5.4/', 'https://dev.internal.example/'])
    assert.doesNotThrow(() => agentPageUrl(value), value);
});
test('HERMES_WORKSPACE_ALLOW_LOOPBACK reopens loopback for fixtures only', () => {
  process.env.HERMES_WORKSPACE_ALLOW_LOOPBACK = '1';
  try {
    assert.equal(agentPageUrl('http://127.0.0.1:3000/x'), 'http://127.0.0.1:3000/x');
    assert.equal(agentPageUrl('localhost:3000/x'), 'http://localhost:3000/x');
    assert.throws(() => agentPageUrl('http://169.254.169.254/'), /link-local|metadata/);
    assert.throws(() => agentPageUrl('http://0.0.0.0/'));
  } finally { delete process.env.HERMES_WORKSPACE_ALLOW_LOOPBACK; }
});
test('only same-origin favicons may be fetched', () => {
  assert.equal(faviconTarget('https://a.example/page', 'https://a.example/favicon.ico'), 'https://a.example/favicon.ico');
  assert.equal(faviconTarget('http://a.example:8080/x', 'http://a.example:8080/i.png'), 'http://a.example:8080/i.png');
  for (const icon of ['https://evil.example/x.png', 'http://127.0.0.1:9999/x.png', 'https://a.example.evil.com/x.png', 'data:image/png;base64,x', 'file:///etc/passwd'])
    assert.equal(faviconTarget('https://a.example/page', icon), '', icon);
  assert.equal(faviconTarget('https://a.example:444/x', 'https://a.example/i.png'), '', 'ports differ');
});
test('bot-visible tab metadata seals url, title, icon and note on human-controlled tabs', () => {
  const info = { id: 't', url: 'https://a.example/private?token=1', title: 'Secret page', favicon: 'data:image/png;base64,x', controller: 'human', handoff: { phase: 'handed_off', destinationTabId: 't2', note: 'do this' } };
  const redacted = redactTabForBot(info);
  assert.equal(redacted.url, 'https://a.example');
  assert.equal(redacted.title, '');
  assert.equal(redacted.favicon, '');
  assert.equal(redacted.handoff.note, '');
  assert.equal(redacted.handoff.phase, 'handed_off');
  assert.equal(redacted.handoff.destinationTabId, 't2');
  assert.equal(redactTabForBot({ ...info, controller: 'agent' }).url, info.url, 'agent tabs keep full metadata');
  assert.equal(redactTabForBot({ ...info, url: 'file:///private/x' }).url, '', 'non-web urls blank out fully');
});
test('the cdp allowlist denies storage, cookie, file and interception methods', () => {
  for (const method of ['Page.addScriptToEvaluateOnNewDocument', 'Page.removeScriptToEvaluateOnNewDocument', 'Page.setInterceptFileChooserDialog', 'Page.handleFileChooser', 'Page.navigateToHistoryEntry', 'Page.setDownloadBehavior', 'Page.getCookies', 'DOM.setFileInputFiles', 'Network.getCookies', 'Network.getAllCookies', 'Network.setCookie', 'Network.setCookies', 'Network.clearBrowserCookies', 'Network.clearBrowserCache', 'Network.loadNetworkResource', 'Network.setRequestInterception', 'Network.continueInterceptedRequest', 'Fetch.enable', 'Fetch.continueRequest', 'Storage.getCookies', 'Storage.setCookies', 'Storage.clearDataForOrigin', 'Target.createTarget', 'Browser.getCookies'])
    assert.match(cdpMethodError(method), /./, method);
  for (const method of ['Runtime.evaluate', 'Page.navigate', 'Page.captureScreenshot', 'Input.dispatchMouseEvent', 'Emulation.setDeviceMetricsOverride', 'DOM.querySelector', 'Network.enable', 'Accessibility.getFullAXTree'])
    assert.equal(cdpMethodError(method), '', method);
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
  for (const header of [undefined, 'paired-secret', 'Bearer paired', 'Bearer another-secret', 'Bearer', 'Basic cGFpcmVkLXNlY3JldA==']) assert.equal(isAuthorized(header, 'paired-secret'), false);
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
test('an explicit human takeover locks bots out while an idle or released tab stays claimable', () => {
  assert.throws(() => requireAgentClaim({ controller: 'human', humanLock: true }), /human_has_control/);
  requireAgentClaim({ controller: 'human', humanLock: false });
  requireAgentClaim({ controller: 'human' });
  requireAgentClaim({ controller: 'agent', humanLock: true });
});
test('an unchanged snapshot keeps the refs the agent already holds usable', () => {
  const page = (generation, label = 'Send') => ({ url: 'https://a.example/', title: 'A', text: 'hello',
    elements: [{ ref: `s${generation}-1`, role: 'button', name: label }, { ref: `s${generation}-2`, role: 'link', name: 'Home' }] });
  const tab = { refs: new Set() };
  assert.equal(settleSnapshot(tab, page(1), 1).elements.length, 2);
  tab.refs.clear();
  assert.deepEqual(settleSnapshot(tab, page(2), 2, 1), { unchanged: true, generation: 2 });
  assert.ok(tab.refs.has('s1-1') && tab.refs.has('s1-2'), 'refs from the last full snapshot still resolve');
  assert.match(snapshotExpression(3, { keep: tab.snapshotStamp.base }), /startsWith\('s1-'\)/);
  tab.refs.clear();
  assert.equal(settleSnapshot(tab, page(3), 3, 2).unchanged, true, 'dedupe chains on the latest generation');
  assert.ok(tab.refs.has('s1-1'), 'the chain keeps pointing at the full snapshot the agent read');
  const changed = settleSnapshot(tab, page(4, 'Sent'), 4, 3);
  assert.equal(changed.unchanged, undefined);
  assert.equal(changed.elements[0].ref, 's4-1');
  assert.ok(!tab.refs.has('s1-1'), 'refs from before a real change stay stale');
  assert.equal(settleSnapshot(tab, page(5, 'Sent'), 5).unchanged, undefined, 'no since means a full reply');
});
test('web snapshot names say on, off, and disabled', () => {
  const source = snapshotExpression(1);
  assert.match(source, /role="checkbox"/);
  assert.match(source, /name \+= ' on'/);
  assert.match(source, /name \+= ' off'/);
  assert.match(source, /name \+= ' disabled'/);
  assert.match(source, /summary/);
  assert.match(source, /name \+= ' open'/);
  assert.match(source, /name \+= ' closed'/);
  assert.match(source, /role="tab"/);
  assert.match(source, /name \+= ' selected'/);
  assert.match(source, /name \+= ' current'/);
  assert.match(source, /item\.disabled = true/);
  assert.match(source, /\.slice\(0, 300\)/);
});
test('an action read returns controls and leaves the page text out', async () => {
  const tab = { refs: new Set(), generation: 4 };
  let code = '';
  const reply = await readControls((expression) => {
    code = expression;
    return { url: 'https://a.example/', title: 'A', text: '', elements: [{ ref: 's5-1', role: 'button', name: 'Go' }] };
  }, tab);
  assert.match(code, /text\.slice\(0, 6000\)/);
  assert.match(code, /items\.length >= 150/);
  assert.equal(reply.text, undefined);
  assert.deepEqual(reply.elements, [{ ref: 's5-1', role: 'button', name: 'Go' }]);
  assert.equal(reply.generation, 5);
  assert.ok(tab.refs.has('s5-1'));
});
test('an action read keeps the last generation when the page did not change', async () => {
  const tab = { refs: new Set(), generation: 1 };
  const page = { url: 'https://a.example/', title: 'A', text: 'hello', elements: [{ ref: 's1-1', role: 'button', name: 'Go' }] };
  settleSnapshot(tab, page, 1);
  tab.refs.clear();
  const reply = await readControls(() => ({ ...page, elements: [{ ref: 's9-1', role: 'button', name: 'Go' }] }), tab);
  assert.deepEqual(reply, { unchanged: true, generation: 1 });
  assert.ok(tab.refs.has('s1-1'));
  assert.equal(tab.generation, 1);
});
test('snapshot bounds clamp and never splice caller text into page code', () => {
  assert.match(snapshotExpression(3), /text\.slice\(0, 6000\)/);
  assert.match(snapshotExpression(3, { maxChars: 999999 }), /text\.slice\(0, 20000\)/);
  assert.doesNotMatch(snapshotExpression(3, { maxChars: '1);alert(1' }), /alert/);
});
test('tool results drop favicon images and keep the fields a model acts on', () => {
  const icon = 'data:image/png;base64,' + 'A'.repeat(4000);
  const reply = omitIcons({
    tabs: [{ id: 't', title: 'Inbox', epoch: 3, favicon: icon, tab: { favicon: icon, url: 'https://a.example/' } }],
    note: 'favicon stays when it is only a word',
  });
  assert.equal(JSON.stringify(reply).includes('data:image'), false);
  assert.equal(reply.tabs[0].favicon, undefined);
  assert.equal(reply.tabs[0].tab.favicon, undefined);
  assert.equal(reply.tabs[0].title, 'Inbox');
  assert.equal(reply.tabs[0].epoch, 3);
  assert.equal(reply.tabs[0].tab.url, 'https://a.example/');
  assert.match(reply.note, /favicon/);
});
test('only positively identified direct bot IDs enter the catalog', () => {
  const bots = sanitizeBots([{ id: '123', isBot: true, name: 'Agent' }, { id: '456', name: 'Human' }, { id: '-100123', isBot: true }, { id: '789', isBot: false }]);
  assert.deepEqual(bots.map((bot) => bot.id), ['123']);
});
