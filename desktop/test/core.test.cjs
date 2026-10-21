const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeUrl, agentPageUrl, faviconTarget, faviconQueue, redactTabForBot, cdpMethodError, parseRemoteUrl, isSshTarget, normalizeHost, requireActor, requireAgentRead, requireAgentClaim, takeoverDelay, reviewedHandoff, isAuthorized, sanitizeBots, retargetMissingTab, needsContinuedEpoch, hostShouldReload, errorMessage, followVmRemoteUrl, handbackRequest, nextHandback, liveHandback, HANDBACK_MS, dialogAnswer, answerDialog } = require('../src/core.cjs');
const { controlsDelta, snapshotExpression, settleSnapshot, readEffect } = require('../src/browser-page.cjs');
const { locateElement } = require('../src/agent-input.cjs');
const { omitIcons } = require('../src/omit-icons.cjs');

test('browser URLs reject executable and credential-bearing schemes', () => {
  for (const value of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,test', 'https://user:password@example.com']) assert.throws(() => normalizeUrl(value));
  assert.equal(normalizeUrl('github.com'), 'https://github.com/');
  assert.equal(normalizeUrl('localhost:3000/test'), 'http://localhost:3000/test');
  assert.match(normalizeUrl('browser task handoff'), /^https:\/\/www.google.com\/search\?/);
});
test('agent navigations refuse loopback, link-local and metadata addresses in every spelling', () => {
  for (const value of ['http://127.0.0.1:3000/', 'http://localhost:3000/', 'http://0x7f000001/', 'http://2130706433/', 'http://127.1/', 'http://[::1]/', 'http://[::ffff:7f00:1]/', 'http://0.0.0.0/', 'http://[::]/', 'http://169.254.169.254/latest/meta-data', 'http://169.254.1.1/', 'http://sub.localhost:8080/', 'http://localhost./', 'http://a.localhost./', 'http://LOCALHOST../', 'http://127.0.0.1./'])
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
test('the favicon queue keeps every same-origin candidate in page order', () => {
  const page = 'https://a.example/page';
  const { targets, inline } = faviconQueue(page, ['https://cdn.other.example/x.png', 'https://a.example/one.ico', 'https://a.example/one.ico', 'https://a.example/two.png', 'data:image/png;base64,x']);
  assert.deepEqual(targets, ['https://a.example/one.ico', 'https://a.example/two.png'], 'cross-origin candidates drop, duplicates collapse');
  assert.equal(inline, 'data:image/png;base64,x', 'a decoded inline icon stays the last fallback');
  assert.deepEqual(faviconQueue(page, ['https://evil.example/x.png']), { targets: [], inline: '' }, 'a cross-origin url never renders directly');
  assert.equal(faviconQueue(page, ['data:,']).inline, '', 'the blank-data sentinel is not an icon');
  const many = Array.from({ length: 9 }, (_, i) => `https://a.example/${i}.png`);
  assert.equal(faviconQueue(page, many).targets.length, 6, 'the serial fetch queue is bounded');
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
  for (const method of ['Page.addScriptToEvaluateOnNewDocument', 'Page.removeScriptToEvaluateOnNewDocument', 'Page.addScriptToEvaluateOnLoad', 'Network.replayXHR', 'Page.setInterceptFileChooserDialog', 'Page.handleFileChooser', 'Page.navigateToHistoryEntry', 'Page.setDownloadBehavior', 'Page.getCookies', 'DOM.setFileInputFiles', 'Network.getCookies', 'Network.getAllCookies', 'Network.setCookie', 'Network.setCookies', 'Network.clearBrowserCookies', 'Network.deleteCookies', 'Storage.clearCookies', 'Network.clearBrowserCache', 'Network.loadNetworkResource', 'Network.setRequestInterception', 'Network.continueInterceptedRequest', 'Fetch.enable', 'Fetch.continueRequest', 'Storage.getCookies', 'Storage.setCookies', 'Storage.clearDataForOrigin', 'Target.createTarget', 'Browser.getCookies'])
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
test('the noVNC address follows the agent VM when the SSH host moves', () => {
  // Empty or still pointing at the previous host: re-derive for the new one.
  assert.equal(followVmRemoteUrl('root@10.0.0.1', 'root@10.0.0.2', 'http://10.0.0.1:6080/vnc.html'), 'http://10.0.0.2:6080/vnc.html');
  assert.equal(followVmRemoteUrl('', 'root@10.0.0.2', ''), 'http://10.0.0.2:6080/vnc.html');
  assert.equal(followVmRemoteUrl('root@10.0.0.1', '10.0.0.2', 'http://10.0.0.1:9090/custom.html'), 'http://10.0.0.2:6080/vnc.html');
  // A remoteUrl pointing anywhere else is the user's and is left alone.
  for (const other of ['https://desktop.example:8445/vnc.html', 'wss://other.example/ws'])
    assert.equal(followVmRemoteUrl('root@10.0.0.1', 'root@10.0.0.2', other), '', other);
  // Same host, with or without a user@ change, never rewrites; neither does clearing the VM.
  assert.equal(followVmRemoteUrl('root@10.0.0.1', 'me@10.0.0.1', ''), '');
  assert.equal(followVmRemoteUrl('root@10.0.0.1', 'root@10.0.0.1', 'http://10.0.0.1:6080/vnc.html'), '');
  assert.equal(followVmRemoteUrl('root@10.0.0.1', '', 'http://10.0.0.1:6080/vnc.html'), '');
  // IPv6 targets keep their brackets in the derived URL.
  assert.equal(followVmRemoteUrl('', 'root@fd00::2', ''), 'http://[fd00::2]:6080/vnc.html');
  assert.equal(followVmRemoteUrl('root@fd00::1', 'root@fd00::2', 'http://[fd00::1]:6080/vnc.html'), 'http://[fd00::2]:6080/vnc.html');
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
  for (const value of ['', 'mac; rm -rf ~', 'mac$(id)', 'mac`id`', '-oProxyCommand=id', 'me@mac other', 'mac\nid', 'mac|id', "mac'x", 'a@b@c', '-x@mac'])
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
test('with automatic takeover a bot action takes the human\'s tab back under a fresh epoch', () => {
  const tab = { botId: 'research', controller: 'agent', epoch: 4 };
  // The human takes over: the tab is locked to them and the bot's action is refused.
  Object.assign(tab, { controller: 'human', humanLock: true, epoch: 5 });
  assert.throws(() => requireActor(tab, 'research', 4, true), /human_has_control/);
  assert.throws(() => requireAgentClaim(tab), /human_has_control/, 'the setting off keeps the refusal');
  assert.throws(() => requireAgentClaim(tab, Date.now(), { autoTakeover: false }), /human_has_control/);
  // The setting on: the claim rules let the bot take it, as changeController then does.
  requireAgentClaim(tab, Date.now(), { autoTakeover: true });
  Object.assign(tab, { controller: 'agent', humanLock: false, epoch: tab.epoch + 1 });
  requireActor(tab, 'research', 6, true);
  assert.throws(() => requireActor(tab, 'research', 4, true), /stale_control_epoch/, 'an epoch from before the human took over stays stale');
});
test('automatic takeover never takes a tab the bot handed over or one being recorded', () => {
  const waiting = { botId: 'research', controller: 'human', handback: { state: 'awaiting_human', reason: 'captcha', note: '', botId: 'research', since: 1000 } };
  assert.throws(() => requireAgentClaim(waiting, 2000, { autoTakeover: true }), /awaiting_human/);
  assert.throws(() => requireAgentClaim({ controller: 'human', humanLock: true }, 2000, { autoTakeover: true, recording: true }), /^Error: recording_in_progress/);
});
test('Take back keeps automatic takeover off the tab for its cooldown', () => {
  const tab = { controller: 'human', humanLock: true, tookBackUntil: 61000 };
  assert.throws(() => requireAgentClaim(tab, 1000, { autoTakeover: true }), /^Error: human_took_back: .* for 60s/);
  requireAgentClaim(tab, 61000, { autoTakeover: true });
  assert.throws(() => requireAgentClaim(tab, 1000), /human_has_control/, 'the setting off keeps its own refusal');
});
test('a takeover waits until 3 seconds after the human\'s last input, for 10 seconds at most', () => {
  const t = 1_700_000_000_000;
  assert.equal(takeoverDelay(undefined, t, t), 0, 'no input: take over at once');
  assert.equal(takeoverDelay(t - 5000, t, t), 0, 'input long ago');
  assert.equal(takeoverDelay(t - 1000, t, t), 2000, 'typed a second ago');
  assert.equal(takeoverDelay(t - 1000, t, t + 2000), 0, 'paused 3 seconds');
  assert.equal(takeoverDelay(t + 9000, t, t + 9000), 1000, 'still typing: the 10 second cap wins');
  assert.equal(takeoverDelay(t + 10500, t, t + 10500), 0, 'past the cap');
});
test('a release with a reason waits for the human, then the give-back or 30 minutes reopens the tab', () => {
  assert.equal(handbackRequest({ controller: 'human' }), null);
  assert.throws(() => handbackRequest({ reason: 'bored' }), /reason must be one of/);
  const request = handbackRequest({ reason: 'captcha', note: `  Solve\nthe <b>puzzle</b> ${'x'.repeat(200)}` });
  assert.equal(request.reason, 'captcha');
  assert.equal(request.note.length, 140);
  assert.match(request.note, /^Solve the <b>puzzle<\/b> x/);
  const tab = { botId: 'research', controller: 'agent', epoch: 4 };
  // The bot's release: the tab goes to the human and the bot cannot claim it.
  tab.handback = nextHandback(tab, 'human', 'agent', request, 1000); tab.controller = 'human'; tab.epoch++;
  assert.deepEqual(tab.handback, { reason: 'captcha', note: request.note, state: 'awaiting_human', botId: 'research', since: 1000 });
  assert.throws(() => requireAgentClaim(tab, 2000), /awaiting_human/);
  assert.throws(() => requireAgentRead(tab, 2000), /awaiting_human/);
  assert.throws(() => requireActor(tab, 'research', 5, true, false, 2000), /awaiting_human/);
  // Neither a plain re-release nor human navigation lifts it; a second reason keeps the clock.
  assert.equal(nextHandback(tab, 'human', 'agent', null, 2000), tab.handback);
  assert.equal(nextHandback(tab, 'human', 'human', null, 2000), tab.handback);
  assert.equal(nextHandback(tab, 'human', 'agent', handbackRequest({ reason: 'login' }), 5000).since, 1000);
  // The human gives it back: the bot sees human_returned and claims with a fresh epoch.
  const returned = nextHandback(tab, 'agent', 'human', null, 3000);
  assert.equal(returned.state, 'human_returned');
  tab.handback = returned; tab.controller = 'agent'; tab.epoch++;
  assert.throws(() => requireActor(tab, 'research', 5, true, false, 3000), /human_returned/);
  requireAgentClaim(tab, 3000);
  requireActor(tab, 'research', 6, true, false, 3000);
  assert.equal(nextHandback(tab, 'agent', 'agent', null, 3000), null, 'a claim clears the marker');
  assert.equal(nextHandback(tab, 'human', 'human', null, 3000), null, 'a human takeover clears the marker');
  // Unanswered, the hold expires into a normal, retakeable release.
  const waiting = { botId: 'research', controller: 'human', handback: { state: 'awaiting_human', reason: 'review', note: '', botId: 'research', since: 1000 } };
  assert.throws(() => requireAgentClaim(waiting, 1000 + HANDBACK_MS), /awaiting_human/);
  assert.equal(liveHandback(waiting, 1001 + HANDBACK_MS), null);
  requireAgentClaim(waiting, 1001 + HANDBACK_MS);
  assert.equal(nextHandback(waiting, 'agent', 'human', null, 1001 + HANDBACK_MS), null);
  assert.equal(nextHandback({ botId: 'research', controller: 'human', humanLock: true }, 'human', 'agent', request, 1000), null, 'no hold on a tab the human took over');
});
test('an unchanged snapshot answers unchanged and the refs the agent holds stay valid', () => {
  const page = (label = 'Send') => ({ url: 'https://a.example/', title: 'A', text: 'hello', seq: 2,
    elements: [{ ref: 'e1', role: 'button', name: label }, { ref: 'e2', role: 'link', name: 'Home' }] });
  const tab = { refs: new Set() };
  assert.equal(settleSnapshot(tab, page(), 1).elements.length, 2);
  assert.equal(tab.refSeed, 2, 'the next document numbers its refs after these');
  assert.deepEqual(settleSnapshot(tab, page(), 2, 1), { unchanged: true, generation: 2 });
  assert.ok(tab.refs.has('e1') && tab.refs.has('e2'));
  assert.equal(settleSnapshot(tab, page(), 3, 2).unchanged, true, 'dedupe chains on the latest generation');
  const changed = settleSnapshot(tab, page('Sent'), 4, 3);
  assert.equal(changed.unchanged, undefined);
  assert.equal(changed.elements[0].ref, 'e1', 'a control keeps its ref when its name changes');
  assert.equal(changed.seq, undefined, 'bookkeeping stays out of the reply');
  assert.equal(settleSnapshot(tab, page('Sent'), 5).unchanged, undefined, 'no since means a full reply');
});

test('web snapshot names say on, off, and disabled', () => {
  const source = snapshotExpression().replace(/\\"/g, '"');
  assert.match(source, /role="checkbox"/);
  assert.match(source, /name \+= ' on'/);
  assert.match(source, /name \+= ' off'/);
  assert.match(source, /name \+= ' disabled'/);
  assert.match(source, /summary/);
  assert.match(source, /name \+= ' open'/);
  assert.match(source, /name \+= ' closed'/);
  assert.match(source, /role="tab"/);
  assert.match(source, /\[onclick\]/);
  assert.match(source, /role="menuitem"/);
  assert.match(source, /role="option"/);
  assert.match(source, /role="treeitem"/);
  assert.match(source, /role="slider"/);
  assert.match(source, /el\.tagName === 'BODY'/);
  assert.match(source, /node\.shadowRoot/);
  assert.match(source, /contentDocument/);
  assert.match(source, /aria-labelledby/);
  assert.match(source, /aria-pressed/);
  assert.match(source, /getRootNode/);
  assert.match(source, /labelledby\.split\(\/\\s\+\/\)/);
  assert.match(locateElement({ selector: 'button' }), /node\.shadowRoot/);
  assert.match(locateElement({ selector: 'button' }), /contentDocument/);
  assert.match(locateElement({ ref: 'e4' }), /Symbol\.for\("hw\.refs"\)\]\?\.find\?\.\("e4"\)/, 'a ref resolves through the page store, never an attribute');
  assert.doesNotMatch(locateElement({ ref: 'e4' }), /querySelector/);
  assert.match(require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/agent-input.cjs'), 'utf8'), /frameElement/);
  assert.match(source, /name \+= ' selected'/);
  assert.match(source, /name \+= ' current'/);
  assert.match(source, /item\.disabled = true/);
  assert.match(source, /if \(d\.name\) item\.name = d\.name;/);
  assert.match(source, /if \(x\.row\) item\.row = x\.row;/);
  assert.match(source, /el\.tagName === 'INPUT' && d\.type !== 'text'/);
  assert.match(source, /\.slice\(0, 300\)/);
  assert.doesNotMatch(snapshotExpression({ maxElements: 0 }), /hw\.refs/, 'a text read leaves the ref store alone');
});

test('an action read returns the new state and fresh controls', async () => {
  const tab = { refs: new Set(), generation: 4 };
  let code = '';
  const reply = await readEffect((expression) => {
    code = expression;
    return { url: 'https://a.example/', title: 'A', text: 'Task 2: click Go', elements: [{ ref: 'e5', role: 'button', name: 'Go' }], truncated: { text: false } };
  }, tab);
  assert.match(code, /"maxChars":8000/, 'the effect read walks bounded page text');
  assert.match(code, /"maxElements":150,"maxScan":2000,"textMs":60,"elementMs":200/);
  assert.deepEqual(reply.elements, [{ ref: 'e5', role: 'button', name: 'Go' }]);
  assert.equal(reply.generation, 5);
  assert.ok(tab.refs.has('e5'));
  assert.equal(reply.effect.changed, true);
  assert.equal(reply.effect.url, 'https://a.example/');
  assert.equal(reply.effect.text, 'Task 2: click Go');
});

test('an action read reports only the text lines it added', async () => {
  const tab = { refs: new Set(), generation: 1 };
  const first = 'step 1\nstep 2', second = 'step 1\nstep 2\nstep 3 appears';
  settleSnapshot(tab, { url: 'https://a.example/', title: 'A', text: first, elements: [{ ref: 'e1', role: 'button', name: 'Go' }] }, 1);
  const reply = await readEffect(() => ({ url: 'https://a.example/', title: 'A', text: second, elements: [{ ref: 'e1', role: 'button', name: 'Go' }] }), tab);
  assert.equal(reply.effect.text, 'step 3 appears');
  assert.equal(reply.effect.changed, true);
  const quiet = await readEffect(() => ({ url: 'https://a.example/', title: 'A', text: second, elements: [{ ref: 'e1', role: 'button', name: 'Go' }] }), tab);
  assert.equal(quiet.effect.text, '', 'a second identical read adds nothing');
  assert.equal(quiet.effect.changed, false);
});
test('an action read keeps the last generation when the page did not change', async () => {
  const tab = { refs: new Set(), generation: 1 };
  const page = { url: 'https://a.example/', title: 'A', text: 'hello', elements: [{ ref: 'e1', role: 'button', name: 'Go' }] };
  settleSnapshot(tab, page, 1);
  const reply = await readEffect(() => ({ ...page }), tab);
  assert.equal(reply.generation, 1);
  assert.equal(reply.elements, undefined);
  assert.equal(reply.changed, undefined);
  assert.equal(reply.effect.changed, false);
  assert.equal(reply.effect.text, '');
  assert.ok(tab.refs.has('e1'));
  assert.equal(tab.generation, 1);
});

test('an action read keeps the snapshot baseline when controls match', async () => {
  const tab = { refs: new Set(), generation: 2 };
  const page = { url: 'https://a.example/', title: 'A', text: 'a long document', elements: [{ ref: 'e2', role: 'button', name: 'Go' }] };
  const settled = settleSnapshot(tab, page, 2);
  const stamp = tab.snapshotStamp.hash;
  let code = '';
  const reply = await readEffect((expression) => {
    code = expression;
    return { url: page.url, title: page.title, text: page.text, elements: [{ ref: 'e2', role: 'button', name: 'Go' }], truncated: { text: false } };
  }, tab);
  assert.match(code, /"wantEffect":true/, 'effect reads collect focus and value');
  assert.match(code, /"held":\["e2"\]/, 'the read asks which held refs are gone');
  assert.equal(reply.generation, settled.generation);
  assert.equal(reply.elements, undefined);
  assert.equal(reply.effect.changed, false);
  assert.equal(tab.snapshotStamp.hash, stamp);
  const changed = await readEffect(() => ({ url: page.url, title: page.title, text: page.text, elements: [{ ref: 'e2', role: 'button', name: 'Sent' }] }), tab);
  assert.equal(changed.elements[0].name, 'Sent', 'without the caller\'s generation the reply is the list');
  assert.equal(changed.effect.changed, true);
  assert.notEqual(tab.snapshotStamp.hash, stamp, 'a changed read becomes the new baseline');
  assert.equal(tab.snapshotStamp.generation, changed.generation);
  assert.equal(tab.scan.generation, changed.generation);
});

test('two changed action reads never reuse a generation', async () => {
  const tab = { refs: new Set(), generation: 1 };
  const url = 'https://a.example/', title = 'A';
  settleSnapshot(tab, { url, title, text: '', elements: [{ ref: 'e1', role: 'button', name: 'One' }] }, 1);
  const first = await readEffect(() => ({ url, title, text: '', elements: [{ ref: 'e2', role: 'button', name: 'Two' }] }), tab);
  const second = await readEffect(() => ({ url, title, text: '', elements: [{ ref: 'e3', role: 'button', name: 'Three' }] }), tab);
  assert.ok(second.generation > first.generation);
  const again = await readEffect(() => ({ url, title, text: '', elements: [{ ref: 'e3', role: 'button', name: 'Three' }] }), tab);
  assert.equal(again.elements, undefined);
  assert.equal(again.generation, second.generation);
  assert.equal(again.effect.changed, false);
  assert.deepEqual(settleSnapshot(tab, { url, title, text: '', elements: [{ ref: 'e3', role: 'button', name: 'Three' }] }, 5, second.generation), { unchanged: true, generation: 5 });
  const renumbered = await readEffect(() => ({ url, title, text: '', elements: [{ ref: 'e4', role: 'button', name: 'Three' }] }), tab);
  assert.equal(renumbered.elements[0].ref, 'e4', 'a control that came back under a new ref is a change');
});

test('identical controls on a different page are a navigation, not an unchanged reply', async () => {
  const tab = { refs: new Set(), generation: 1 };
  const controls = (ref) => [{ ref, role: 'button', name: 'Continue' }];
  settleSnapshot(tab, { url: 'https://a.example/1', title: 'Step', text: '', elements: controls('e1') }, 1);
  const moved = await readEffect(() => ({ url: 'https://a.example/2', title: 'Step', text: '', elements: controls('e2'), sameDoc: false }), tab, { held: 1 });
  assert.equal(moved.effect.navigated, true);
  assert.equal(moved.effect.changed, true);
  assert.equal(moved.elements[0].ref, 'e2', 'a navigation answers with the list even when the caller held a generation');
  // A same-document URL change (pushState, hash) is not a navigation.
  const rerouted = await readEffect(() => ({ url: 'https://a.example/2#frag', title: 'Step', text: '', elements: controls('e2'), sameDoc: true }), tab);
  assert.equal(rerouted.effect.navigated, false);
  assert.equal(rerouted.effect.url, 'https://a.example/2#frag');
});
test('an action read reports the value and focus of the element it touched', async () => {
  const tab = { refs: new Set(), generation: 1 };
  const code = snapshotExpression({ effect: true, valueFor: { ref: 'e1' } });
  assert.match(code, /const wantEffect = true, wantSettle = false, valueRef = "e1"/);
  assert.match(snapshotExpression({ effect: true, settle: true }), /wantSettle = true/, 'only settling reads watch for late mutations');
  assert.match(code, /activeElement === el\)/);
  assert.match(code, /el\.matches\(valueSel\)/);
  const reply = await readEffect(() => ({ url: 'https://a.example/', title: 'A', text: '', elements: [{ ref: 'e2', role: 'input', name: 'Box' }], acted: 'typed text', focused: { ref: 'e2', name: 'Box' } }), tab);
  assert.equal(reply.effect.value, 'typed text');
  assert.deepEqual(reply.effect.focused, { ref: 'e2', name: 'Box' });
  // Focus outside the picked controls still reports, with a name only.
  const plain = await readEffect(() => ({ url: 'https://a.example/', title: 'A', text: '', elements: [{ ref: 'e4', role: 'input', name: 'Box' }], focused: { ref: '', name: 'Plain div' } }), tab);
  assert.deepEqual(plain.effect.focused, { name: 'Plain div' });
});

test('snapshot bounds clamp and never splice caller text into page code', () => {
  assert.match(snapshotExpression(), /text\.slice\(0, 6000\)/);
  assert.match(snapshotExpression({ maxChars: 999999 }), /text\.slice\(0, 20000\)/);
  assert.match(snapshotExpression(), /setT\(done, 400\)/);
  assert.match(snapshotExpression(), /seenParent/);
  assert.match(snapshotExpression(), /checkVisibilityCSS: true/);
  assert.match(snapshotExpression(), /utm_/);
  assert.match(snapshotExpression(), /src:shortHref/);
  assert.match(snapshotExpression(), /performance\.now\(\) > deadline\) \{ more = true; break; \}/);
  assert.match(snapshotExpression(), /\.slice\(0,8\)/);
  assert.match(snapshotExpression(), /searchParams\.delete/);
  assert.doesNotMatch(snapshotExpression({ maxChars: '1);alert(1' }), /alert\(/);
  assert.doesNotMatch(snapshotExpression({ seed: '1);alert(1', held: ['e1', '");alert(1'] }), /alert\(/);
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
test('opening a tab passes a normalized host to the app', () => {
  assert.equal(normalizeHost('computer'), 'computer');
  assert.equal(normalizeHost('local'), 'computer');
  assert.equal(normalizeHost('mac'), 'computer');
  assert.equal(normalizeHost(' Windows '), 'computer');
  assert.equal(normalizeHost('vps'), 'vm');
  assert.equal(normalizeHost('remote'), 'vm');
  assert.equal(normalizeHost('server'), 'vm');
  assert.equal(normalizeHost('bogus'), undefined);
  assert.equal(normalizeHost(undefined), undefined);
  assert.equal(normalizeHost(''), undefined);
  const mcp = require('node:fs').readFileSync(require('node:path').join(__dirname, '../scripts/browser-mcp.cjs'), 'utf8');
  assert.match(mcp, /normalizeHost\(args\.host\)/);
  assert.match(mcp, /host === 'vm' \? 'vps' : 'local'/);
  assert.doesNotMatch(mcp, /enum:\s*\['mac'/);
  assert.doesNotMatch(mcp, /Ignored/);
  assert.match(mcp, /args\.maxChars : 2000/);
  assert.match(mcp, /400ms grace/);
  assert.match(mcp, /args\.quality : 50/);
  assert.match(mcp, /args\.maxWidth : 960/);
  assert.match(mcp, /if only a URL is supplied, open it and inspect before proceeding/);
  assert.match(mcp, /confirmed pre-dispatch missing tab; approval-bearing calls need fresh review/);
  assert.match(mcp, /When continuation is reported, use the named tab/);
  assert.match(mcp, /The Mac tab is gone\. Keep working in tab/);
  assert.match(mcp, /continuedTab/);
  assert.match(mcp, /continuedEpoch/);
  assert.match(mcp, /Stale or unknown reference/);
  assert.match(mcp, /maxChars=0&maxElements=40/);
  assert.match(mcp, /--continued-tab/);
  assert.match(mcp, /same machine as the browser/);
  const main = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/main.cjs'), 'utf8');
  assert.match(main, /normalizeHost\(body\.host\)/);
  assert.doesNotMatch(main, /isLocalHost/);
});
test('a missing Mac tab is carried onto the continued VPS tab', () => {
  const page = { tabId: 'tab-9' };
  assert.equal(retargetMissingTab('/v1/tabs/mac-tab/snapshot?maxChars=2000', 'GET', page), '/v1/tabs/tab-9/snapshot?maxChars=2000');
  assert.equal(retargetMissingTab('/v1/tabs/tab-9/snapshot', 'GET', page), null);
  assert.equal(retargetMissingTab('/v1/tabs/mac-tab', 'DELETE', page), null);
  assert.equal(retargetMissingTab('/v1/status', 'GET', page), null);
  assert.equal(retargetMissingTab('/v1/tabs/mac-tab/actions', 'POST', page), '/v1/tabs/tab-9/actions');
  assert.equal(retargetMissingTab('/v1/tabs/a%2Fb/snapshot', 'GET', page), '/v1/tabs/tab-9/snapshot');
  const map = { map: { 'mac-a': 'vm-1', 'mac-b': 'vm-2' }, tabId: 'tab-9' };
  assert.equal(retargetMissingTab('/v1/tabs/mac-a/snapshot', 'GET', map), '/v1/tabs/vm-1/snapshot');
  assert.equal(retargetMissingTab('/v1/tabs/mac-b/actions', 'POST', map), '/v1/tabs/vm-2/actions');
  assert.equal(retargetMissingTab('/v1/tabs/mac-c/snapshot', 'GET', map), null, 'an id the map does not know is not sent to some other tab');
  assert.equal(retargetMissingTab('/v1/tabs/vm-1/snapshot', 'GET', map), null);
  assert.equal(retargetMissingTab('/v1/tabs/mac-a', 'DELETE', map), null);
  assert.equal(retargetMissingTab('/v1/tabs/mac-c/snapshot', 'GET', { map: {}, tabId: 'tab-9' }), '/v1/tabs/tab-9/snapshot', 'an empty map keeps the single-tab fallback');
  assert.equal(needsContinuedEpoch('stale_control_epoch: read the tab state and retry after a fresh snapshot.', 'POST'), true);
  assert.equal(needsContinuedEpoch('stale_control_epoch', 'GET'), false);
  assert.equal(needsContinuedEpoch('tab not found', 'POST'), false);
  assert.equal(hostShouldReload(20, 10, 0), true);
  assert.equal(hostShouldReload(20, 10, 1), false);
  assert.equal(hostShouldReload(10, 10, 0), false);
  const host = require('node:fs').readFileSync(require('node:path').join(__dirname, '../scripts/vps-browser-host.cjs'), 'utf8');
  assert.match(host, /script replaced; exiting so the service loads it/);
});
test('only positively identified direct bot IDs enter the catalog', () => {
  const bots = sanitizeBots([{ id: '123', isBot: true, name: 'Agent' }, { id: '456', name: 'Human' }, { id: '-100123', isBot: true }, { id: '789', isBot: false }]);
  assert.deepEqual(bots.map((bot) => bot.id), ['123']);
});

test('a page exception reaches the agent with its message', async () => {
  const { CDP } = require('../src/cdp.cjs');
  const handlers = {};
  const socket = { readyState: 1, addEventListener: (name, fn) => { handlers[name] = fn; },
    send(raw) {
      const { id, method } = JSON.parse(raw);
      const result = method === 'Target.attachToTarget' ? { sessionId: 's' } : { exceptionDetails: { text: 'Uncaught', exception: { description: 'ReferenceError: nope is not defined\n    at <anonymous>:1:1' } } };
      setImmediate(() => handlers.message({ data: JSON.stringify({ id, result }) }));
    } };
  const page = await new CDP(socket).page('t');
  await assert.rejects(page.executeJavaScript('nope'), /Unable to inspect browser page: ReferenceError: nope is not defined$/);
});

test('a rejected page eval answers with the page message, not an empty body', () => {
  // WebFrameMain.executeJavaScript rejects with a bare string, not an Error.
  assert.equal(errorMessage('Uncaught SyntaxError: Illegal return statement'), 'Uncaught SyntaxError: Illegal return statement');
  assert.equal(errorMessage(Object.assign(new Error('Element is covered.'), { status: 400 })), 'Element is covered.');
  assert.equal(errorMessage({ message: 'object rejection' }), 'object rejection');
  for (const value of [undefined, null, '', 0]) assert.equal(errorMessage(value), 'Request failed.');
});

test('control fingerprints ignore the key order the executor happens to return', async () => {
  const tab = { refs: new Set(), generation: 1 };
  settleSnapshot(tab, { url: 'https://a.example/', title: 'A', text: '', elements: [{ ref: 'e1', role: 'button', name: 'Go' }] }, 1);
  const reply = await readEffect(() => ({ url: 'https://a.example/', title: 'A', text: '', elements: [{ name: 'Go', ref: 'e1', role: 'button' }] }), tab);
  assert.equal(reply.elements, undefined);
  assert.equal(reply.generation, 1);
  assert.equal(reply.effect.changed, false);
});

test('a caller holding the last generation gets only what changed', async () => {
  const url = 'https://a.example/', title = 'A';
  const rows = (n, extra = []) => [...Array.from({ length: n }, (_, i) => ({ ref: `e${i + 1}`, role: 'button', name: 'Open', row: `Order #${i + 1}` })), ...extra];
  const tab = { refs: new Set(), generation: 1 };
  settleSnapshot(tab, { url, title, text: '', elements: rows(20) }, 1);
  const more = await readEffect(() => ({ url, title, text: '', elements: rows(25) }), tab, { held: 1 });
  assert.deepEqual(more.changed.map((item) => item.ref), ['e21', 'e22', 'e23', 'e24', 'e25']);
  assert.deepEqual(more.removed, []);
  assert.equal(more.elements, undefined);
  const renamed = rows(25).filter((item) => item.ref !== 'e3').map((item) => item.ref === 'e2' ? { ...item, name: 'Opened' } : item);
  const next = await readEffect(() => ({ url, title, text: '', elements: renamed }), tab, { held: more.generation });
  assert.deepEqual(next.changed, [{ ref: 'e2', role: 'button', name: 'Opened', row: 'Order #2' }]);
  assert.deepEqual(next.removed, ['e3']);
  const stale = await readEffect(() => ({ url, title, text: '', elements: rows(26) }), tab, { held: more.generation });
  assert.equal(stale.elements.length, 26, 'a caller holding an older generation gets the list');
  // A scan cut short drops only refs the page says are gone.
  const capped = await readEffect(() => ({ url, title, text: '', elements: rows(10, [{ ref: 'e99', role: 'link', name: 'New' }]), truncated: { elements: true }, gone: ['e12'] }), tab, { held: stale.generation });
  assert.deepEqual(capped.removed, ['e12']);
  assert.deepEqual(capped.changed.map((item) => item.ref), ['e99']);
  assert.deepEqual(capped.truncated, { elements: true }, 'a delta reply reports the scan was cut short');
  assert.deepEqual(controlsDelta({ byRef: new Map() }, { elements: [] }), { changed: [], removed: [] });
});

test('action replies say when the effect read was truncated', async () => {
  const tab = { refs: new Set(), generation: 1 };
  const page = { url: 'https://a.example/', title: 'A', text: 'hello', elements: [{ ref: 'e1', role: 'button', name: 'Go' }] };
  settleSnapshot(tab, page, 1);
  const list = await readEffect(() => ({ ...page, elements: [{ ref: 'e1', role: 'button', name: 'Go' }, { ref: 'e2', role: 'button', name: 'Stop' }], truncated: { elements: true, text: true } }), tab);
  assert.deepEqual(list.truncated, { elements: true, text: true }, 'the list reply reports the cut');
  const quiet = await readEffect(() => ({ ...page, elements: [{ ref: 'e1', role: 'button', name: 'Go' }, { ref: 'e2', role: 'button', name: 'Stop' }], truncated: { text: true } }), tab);
  assert.equal(quiet.elements, undefined);
  assert.deepEqual(quiet.truncated, { text: true }, 'an unchanged reply reports the cut too');
  const full = await readEffect(() => ({ ...page, elements: [{ ref: 'e1', role: 'button', name: 'Go' }, { ref: 'e2', role: 'button', name: 'Stop' }] }), tab);
  assert.equal(full.truncated, undefined, 'a complete read reports nothing');
});
test('a long list in an action reply says how many controls it left out', async () => {
  const tab = { refs: new Set(), generation: 1 };
  const reply = await readEffect(() => ({ url: 'https://a.example/', title: 'A', text: '', elements: Array.from({ length: 55 }, (_, i) => ({ ref: `e${i + 1}`, role: 'a', name: `Link ${i}` })) }), tab);
  assert.equal(reply.elements.length, 40);
  assert.equal(reply.unlisted, 15);
  assert.ok(tab.refs.has('e55'), 'every scanned ref is valid, listed or not');
});
test('a dialog or banner over the page rides on snapshots and replies', async () => {
  const tab = { refs: new Set(), generation: 1 };
  const overlays = [{ name: 'Join our newsletter', close: 'e9', closeName: 'No thanks' }];
  const snap = settleSnapshot(tab, { url: 'https://a.example/', title: 'A', text: '', elements: [{ ref: 'e1', role: 'button', name: 'Add' }], overlays }, 1);
  assert.deepEqual(snap.overlays, overlays);
  assert.ok(tab.refs.has('e9'), 'the close ref is usable even when the scan did not list it');
  const quiet = await readEffect(() => ({ url: 'https://a.example/', title: 'A', text: '', elements: [{ ref: 'e1', role: 'button', name: 'Add' }], overlays }), tab);
  assert.deepEqual(quiet.overlays, overlays);
  const clear = settleSnapshot(tab, { url: 'https://a.example/', title: 'A', text: '', elements: [], overlays: [] }, 2);
  assert.equal(clear.overlays, undefined);
});

test('an agent tab dismisses a confirm or prompt unless the action said how to answer', () => {
  assert.deepEqual(answerDialog('alert', 'Saved', undefined), { record: { type: 'alert', message: 'Saved', accepted: true }, params: { accept: true } });
  const dismissed = answerDialog('confirm', 'Delete?', undefined);
  assert.equal(dismissed.params.accept, false);
  assert.match(dismissed.record.note, /dialog: \{accept: true\}/);
  assert.match(answerDialog('prompt', 'Name?', undefined).record.note, /text: "<answer>"/);
  assert.deepEqual(answerDialog('prompt', 'Name?', { accept: true, text: 'eval-42' }).params, { accept: true, promptText: 'eval-42' });
  assert.deepEqual(answerDialog('confirm', 'Delete?', { accept: false }).params, { accept: false });
  assert.equal(answerDialog('beforeunload', '', { accept: false }).params.accept, true, 'leaving the page the agent navigated away from is never blocked');
  assert.deepEqual(dialogAnswer({ accept: true, text: 'x' }), { accept: true, text: 'x' });
  for (const bad of [null, true, {}, { accept: 'yes' }, { accept: true, text: 5 }, { accept: true, text: 'x'.repeat(1001) }]) assert.throws(() => dialogAnswer(bad), /dialog must be/);
});

test('main content priority keeps the original byte budget and snapshot bookkeeping', async () => {
  const tab = { refs: new Set(), generation: 1, docMarked: true };
  const elements = Array.from({ length: 55 }, (_, i) => ({ ref: `e${i + 1}`, role: 'link', name: `Category ${i}` }));
  const book = { ref: 'e56', role: 'link', name: 'A long new book title '.repeat(10) };
  elements.push(book);
  const data = { sameDoc: false, url: 'https://books.example/travel', title: 'Travel', text: 'Category 0\nTravel books', elements, contentRefs: [book.ref], contentText: 'Travel books' };
  const reply = await readEffect(() => data, tab, { navigated: true });
  assert.equal(reply.elements[0], book);
  assert.ok(Buffer.byteLength(JSON.stringify(reply.elements)) <= Buffer.byteLength(JSON.stringify(elements.slice(0, 40))));
  assert.equal(reply.unlisted, elements.length - reply.elements.length);
  assert.equal(tab.scan.byRef.size, elements.length, 'ranking must not change the scan or ref store');
  assert.equal(reply.contentRefs, undefined);
  assert.equal(reply.contentText, undefined);
  assert.equal(reply.effect.text, 'Travel books');
  const same = await readEffect(() => ({ ...data, sameDoc: true, contentRefs: undefined, contentText: undefined }), tab);
  assert.equal(same.effect.changed, false, 'ranking must not manufacture a later control change');
});
