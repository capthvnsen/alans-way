require('./window-fixture.cjs');
// Run: npm run test:vault-lock
// The vault lock against the REAL app: main.cjs boots on a throwaway profile (as the other full-app tests do), an agent
// tab is opened through the real HTTP API a bot uses, and a vault fill goes through the app's own gate, prompt and tab
// records (reached through the HERMES_WORKSPACE_TEST_HOOKS seam; no gateway is needed). Every agent action that can
// return page content is tried before, during and after a fill. Fixture pages on loopback and a made-up canary only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { app, BrowserWindow, dialog } = require('electron');
const { PW, inspectJs, fillJs } = require('./vault-fixtures.cjs');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-vault-lock-'));
process.env.HERMES_WORKSPACE_DATA = profile;
fs.writeFileSync(path.join(profile, 'preferences.json'), JSON.stringify({ onboarded: true, preview: false,
  bots: [{ id: '4242', isBot: true, name: 'Scout' }], selectedBotId: '4242', nativeSessions: { 4242: 'key-1' } }));
process.env.HERMES_WORKSPACE_PORT = String(19000 + Math.floor(Math.random() * 10000));
process.env.HERMES_WORKSPACE_ALLOW_LOOPBACK = '1';
process.env.HERMES_WORKSPACE_TEST_HOOKS = '1';
// The native prompt, answered by the test; the real one (vault-prompt.cjs) still builds its text and options.
const prompts = [];
let answerPrompt = async () => 1;
dialog.showMessageBox = async (...args) => {
  const options = args.at(-1);
  if (!/fill a saved password/.test(options.message || '')) return { response: 0 };
  prompts.push(options);
  return { response: await answerPrompt(options) };
};
// The fixture window is hidden: the prompt only asks in an active app.
BrowserWindow.prototype.isFocused = () => true;
BrowserWindow.prototype.isVisible = () => true;
require('../src/main.cjs');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (read, predicate = Boolean, timeout = 15000) => {
  const deadline = Date.now() + timeout;
  for (;;) { const value = await read(); if (predicate(value)) return value; if (Date.now() > deadline) throw new Error('timed out'); await sleep(40); }
};
const form = '<form id="f" onsubmit="event.preventDefault(); window.submitted = pw.value; document.title = \'submitted\'"><input id="user" name="username" autocomplete="username" aria-label="Email"><input id="pw" type="password" name="password" autocomplete="current-password" aria-label="Password"><textarea id="ta" aria-label="Notes">NOTE-DRAFT</textarea><div id="ce" contenteditable="true" role="textbox" aria-label="Editor">CE-DRAFT</div><button type="button" id="toggle" onclick="pw.type = pw.type === \'password\' ? \'text\' : \'password\'">Show password</button><button type="submit" id="signin">Sign in</button></form>';
let server, failed = false;

app.whenReady().then(async () => {
  server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    if (req.url.startsWith('/sbx')) res.setHeader('Content-Security-Policy', 'sandbox allow-scripts');
    res.end(req.url.startsWith('/other') ? '<!doctype html><title>Other</title><p>No form here</p>' : `<!doctype html><meta charset="utf-8"><title>Login</title>${form}`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const connection = JSON.parse(await waitFor(() => { try { return fs.readFileSync(path.join(profile, 'connection.json'), 'utf8'); } catch { return ''; } }));
  const { vaultFill, tabs } = await waitFor(() => globalThis.__workspaceTest);
  const replies = [];
  const api = async (endpoint, method = 'GET', body) => {
    const res = await fetch(`${connection.url}${endpoint}`, { method, headers: { Authorization: `Bearer ${connection.token}`, 'X-Hermes-Bot': '4242', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    replies.push(text);
    return { status: res.status, data: JSON.parse(text) };
  };
  const created = (await api('/v1/tabs', 'POST', { url: `${base}/login`, background: false })).data;
  const tab = tabs.get(created.id), wc = tab.view.webContents;
  const ready = () => waitFor(() => wc.executeJavaScript('document.readyState === "complete" && !!document.getElementById("pw")').catch(() => false));
  await ready();
  const act = (body) => api(`/v1/tabs/${tab.id}/actions`, 'POST', { epoch: tab.epoch, ...body });
  const snapshot = async () => (await api(`/v1/tabs/${tab.id}/snapshot`)).data;
  const vcall = async (v) => JSON.parse((await vaultFill.handle({ storedId: 'key-1', sessionId: 'rt-1', params: { session_id: 'rt-1', action: 'vault', vault: v } })).value);
  let n = 0;
  const startFill = async (origin = base) => {
    const opened = await vcall({ operation: 'open' });
    assert.equal(opened.success, true, JSON.stringify(opened));
    const nonce = `${String(++n).padStart(2, '0')}fedcba98765432`.slice(0, 16);
    assert.equal((await vcall({ operation: 'evaluate', target: opened.target, expression: inspectJs(nonce) })).success, true);
    return () => vcall({ operation: 'evaluate', target: opened.target, expression: fillJs({ origin, nonce }) });
  };
  const value = (id) => wc.executeJavaScript(`document.getElementById(${JSON.stringify(id)}).value`);
  const locked = (r, what) => { assert.equal(r.status, 403, `${what}: ${JSON.stringify(r.data).slice(0, 200)}`); assert.equal(r.data.code, 'vault_locked', what); assert.match(r.data.error, /paused/, what); };
  const pwOf = (snap) => snap.elements.find((e) => e.type === 'password' || (e.name || '').startsWith('Password'));

  // 1. No lock: every content-returning action behaves as before, and shows the typed drafts.
  const before = await snapshot();
  assert.equal(before.elements.find((e) => e.name === 'Notes').value, 'NOTE-DRAFT', 'a textarea\'s value is readable with no lock');
  assert.match(before.text, /CE-DRAFT/);
  assert.equal((await act({ action: 'eval', code: 'document.title' })).data.value, 'Login');
  assert.equal(tab.agentScripted, true, 'an eval marks the document as scripted by the agent');
  assert.equal((await act({ action: 'cdp', method: 'Runtime.evaluate', params: { expression: '1+1', returnByValue: true } })).data.value.result.value, 2);
  assert.equal((await api(`/v1/tabs/${tab.id}/screenshot`)).status, 200);
  say('PASS: with no lock, snapshot, eval, cdp and screenshot are unchanged.');

  // 2. The agent has scripted this document: a fill into it is refused, with no prompt, and says to reload.
  const scripted = await (await startFill())();
  assert.deepEqual([scripted.success, scripted.error_type], [false, 'page_scripted']);
  assert.equal(prompts.length, 0);
  assert.equal(tab.vaultLock, undefined);
  assert.equal((await act({ action: 'navigate', url: `${base}/login` })).status, 200);
  await ready();
  assert.equal(tab.agentScripted, false, 'a new document is clean');
  assert.equal((await act({ action: 'cdp', method: 'DOM.getDocument', params: {} })).status, 200);
  assert.equal(tab.agentScripted, false, 'a read-only DevTools call does not mark it');
  assert.equal((await act({ action: 'cdp', method: 'Runtime.evaluate', params: { expression: '1' } })).status, 200);
  assert.equal(tab.agentScripted, true, 'a DevTools script does');
  assert.equal((await act({ action: 'navigate', url: `${base}/login` })).status, 200);
  await ready();
  assert.equal(tab.agentScripted, false);
  say('PASS: a document the agent scripted is refused until it is reloaded.');

  // 2b. A popup the agent opened keeps window.opener and is an agent tab of the same bot: it could script the page
  //     after the lock if the lock were per tab. Opened before the reload that cleans the document, as an attacker would.
  assert.equal((await act({ action: 'eval', code: `window.open('${base}/other', '_blank') && 1` })).status, 200);
  const popupInfo = await waitFor(async () => (await api('/v1/tabs')).data.tabs.find((t) => t.id !== tab.id && /\/other/.test(t.url)));
  const popupTab = tabs.get(popupInfo.id);
  assert.equal(popupTab.botId, '4242');
  const popupAct = (body) => api(`/v1/tabs/${popupTab.id}/actions`, 'POST', { epoch: popupTab.epoch, ...body });
  assert.equal((await act({ action: 'navigate', url: `${base}/login` })).status, 200);
  await ready();
  assert.equal(tab.agentScripted, false);
  assert.equal((await popupAct({ action: 'eval', code: 'opener.document.getElementById("pw").value' })).data.value, '', 'the popup can script the opener (no lock yet)');

  assert.equal((await act({ action: 'read', maxChars: 100 })).status, 200); // the login page is the tab the bot last used
  // 3. While the prompt is open the tab is already locked.
  let release;
  answerPrompt = () => new Promise((resolve) => { release = resolve; });
  const fill = await startFill();
  const filling = fill();
  await waitFor(() => prompts.length === 1);
  assert.equal(tab.vaultLock, 'prompt');
  locked(await act({ action: 'eval', code: 'window.planted = 1' }), 'eval during the prompt');
  locked(await act({ action: 'cdp', method: 'Runtime.evaluate', params: { expression: '1' } }), 'cdp during the prompt');
  assert.equal(await wc.executeJavaScript('window.planted'), undefined, 'nothing was planted');
  assert.match(prompts[0].detail, /page can read it/);
  assert.match(prompts[0].detail, /paused/);
  assert.deepEqual(prompts[0].buttons, ['Deny', 'Allow once']);
  release(1);
  const filled = await filling;
  assert.deepEqual([filled.success, filled.result], [true, '{"filled":1}'], JSON.stringify(filled));
  assert.equal(await value('pw'), PW);
  assert.equal(tab.vaultLock, 'filled');
  say('PASS: the tab is locked from the prompt on.');

  // 4. After the fill: every agent action that can return page content is closed or blanked.
  locked(await act({ action: 'eval', code: 'document.getElementById("pw").value' }), 'eval');
  for (const method of ['Runtime.evaluate', 'Runtime.callFunctionOn', 'DOM.getDocument', 'DOM.getOuterHTML', 'DOMSnapshot.captureSnapshot', 'Page.captureScreenshot', 'Accessibility.getFullAXTree', 'Input.dispatchKeyEvent']) {
    locked(await act({ action: 'cdp', method, params: {} }), `cdp ${method}`);
  }
  locked(await api(`/v1/tabs/${tab.id}/screenshot`), 'screenshot');
  locked(await api(`/v1/tabs/${tab.id}/screenshot?format=png&crop=0,0,100,100`), 'cropped screenshot');
  const batch = (await act({ action: 'batch', steps: [{ action: 'eval', code: '1' }] })).data;
  assert.equal(batch.results[0].ok, false);
  assert.match(batch.results[0].error, /vault_locked/, 'a batch step cannot smuggle a script in');
  const snap = await snapshot();
  assert.equal(snap.elements.find((e) => e.name === 'Notes').value, undefined, 'a textarea reads as empty');
  assert.equal(pwOf(snap).value, undefined);
  assert.equal(/NOTE-DRAFT|CE-DRAFT/.test(snap.text), false, 'neither a textarea\'s nor a contenteditable\'s text is in the page text');
  const read = (await act({ action: 'read', maxChars: 2000 })).data;
  assert.equal(/NOTE-DRAFT|CE-DRAFT/.test(read.text), false);
  const list = (await act({ action: 'read', list: { selector: '#f > *', fields: { t: { type: 'text' } } } })).data;
  assert.equal(JSON.stringify(list).includes('CE-DRAFT') || JSON.stringify(list).includes('NOTE-DRAFT'), false, 'a list read blanks them too');
  assert.equal((await act({ action: 'wait', selector: '#pw', timeout: 1000 })).status, 200, 'wait still works');
  say('PASS: eval, cdp, screenshots are refused; snapshot, read, list and effects blank every value.');

  locked(await popupAct({ action: 'eval', code: 'opener.document.getElementById("pw").value' }), 'the popup\'s eval');
  locked(await popupAct({ action: 'cdp', method: 'Runtime.evaluate', params: { expression: 'opener.document.getElementById("pw").value' } }), 'the popup\'s cdp');
  locked(await api(`/v1/tabs/${popupTab.id}/screenshot`), 'the popup\'s screenshot');
  say('PASS: a same-origin popup the agent opened is locked with the page it can script.');

  // 5. The site's "show password" toggle turns the field into plain text: its value is still not returned.
  const toggled = await act({ action: 'click', selector: '#toggle' });
  assert.equal(toggled.status, 200, JSON.stringify(toggled.data).slice(0, 200));
  assert.equal(await wc.executeJavaScript('document.getElementById("pw").type'), 'text');
  const shown = await snapshot();
  assert.equal(shown.elements.find((e) => e.name === 'Password').value, undefined, 'a text field holding the password reads as empty');
  assert.equal(shown.elements.find((e) => e.name === 'Password').type, undefined);
  // Several reads (each bumps tab.generation) do not lift the lock.
  const generation = tab.generation;
  await snapshot(); await snapshot();
  assert.ok(tab.generation > generation, 'snapshots advance the generation');
  locked(await act({ action: 'eval', code: '1' }), 'eval after snapshots');
  say('PASS: the show-password path yields nothing, and snapshots do not lift the lock.');

  // 6. The human is unaffected, and the agent can still submit the login.
  assert.equal(await value('pw'), PW, 'the page and the human\'s own tab hold the value');
  assert.equal((await act({ action: 'click', selector: '#signin' })).status, 200);
  assert.equal(await wc.executeJavaScript('window.submitted'), PW, 'the login was submitted with the filled password');
  assert.equal((await act({ action: 'type', selector: '#user', text: 'me@example.com' })).status, 200);
  assert.equal((await act({ action: 'press', key: 'Tab' })).status, 200);
  say('PASS: clicking, typing and pressing keys still work, and the human is not locked out.');

  // 7. An in-page navigation keeps the lock; a new document ends it.
  await wc.executeJavaScript('history.pushState({}, "", "#route"); location.hash = "#frag"; 0'); // the site\'s own client-side navigation
  await sleep(300);
  assert.equal(tab.vaultLock, 'filled', 'a fragment or pushState navigation is the same document');
  locked(await act({ action: 'eval', code: '1' }), 'eval after an in-page navigation');
  assert.equal((await act({ action: 'navigate', url: `${base}/other` })).status, 200);
  await waitFor(() => tab.vaultLock === undefined);
  assert.equal((await act({ action: 'eval', code: 'document.title' })).data.value, 'Other', 'the lock ended with the document');
  assert.equal((await act({ action: 'back' })).status, 200);
  await ready();
  assert.equal(await value('pw'), '', 'going back loads a fresh document: no password in it');
  assert.equal((await snapshot()).elements.find((e) => e.name === 'Notes').value, 'NOTE-DRAFT', 'reads are unblanked again');
  say('PASS: the lock ends with the document, not with a snapshot or an in-page navigation.');

  // 8. Deny and no-answer release the lock. (A fresh document, then the next prompt.)
  assert.equal((await act({ action: 'navigate', url: `${base}/login` })).status, 200);
  await ready();
  answerPrompt = async () => 0;
  const denied = await (await startFill())();
  assert.deepEqual([denied.success, denied.error_type], [false, 'denied']);
  assert.equal(tab.vaultLock, undefined, 'a denied prompt released the lock');
  assert.equal((await act({ action: 'eval', code: '1+1' })).data.value, 2);
  assert.equal((await api(`/v1/tabs/${tab.id}/screenshot`)).status, 200);
  say('PASS: a denied prompt releases the lock.');

  // 9. A sandboxed document is refused.
  assert.equal((await act({ action: 'navigate', url: `${base}/sbx` })).status, 200);
  await waitFor(() => wc.mainFrame.origin === 'null');
  const sandboxed = await vcall({ operation: 'open' });
  assert.deepEqual([sandboxed.success, sandboxed.error_type], [false, 'opaque_origin']);
  say('PASS: a sandboxed document is refused.');

  // 10. The canary is in no reply the bot received and in no prompt.
  assert.equal(replies.join('\n').includes('CANARY'), false, 'the password is in no HTTP reply to the bot');
  assert.equal(JSON.stringify(prompts).includes('CANARY'), false);
  say(`PASS: no reply to the bot (${replies.length} of them) and no prompt carried the password.`);
}).catch((error) => { failed = true; console.error(error.stack); }).finally(() => {
  server?.closeAllConnections?.(); server?.close();
  const deadline = setTimeout(() => app.exit(1), 5000); deadline.unref();
  app.exit(failed ? 1 : 0);
  fs.rmSync(profile, { recursive: true, force: true });
});
const t0 = Date.now();
function say(text) { console.log(`${text} (${Date.now() - t0} ms)`); }
const watchdog = setTimeout(() => { console.error('vault lock test exceeded its 120s deadline'); app.exit(1); }, 120000);
watchdog.unref();
