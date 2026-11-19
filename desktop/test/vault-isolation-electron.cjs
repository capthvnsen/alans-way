require('./window-fixture.cjs');
// Run: npm run test:vault-lock   (runs this after vault-lock-electron.cjs)
// The second security review, reproduced in the real app: main.cjs boots on a throwaway profile, a bot works through the
// real HTTP API, and a vault fill goes through the app's own gate and prompt (HERMES_WORKSPACE_TEST_HOOKS seam, no
// gateway). Each block is one scenario the reviewer confirmed against the first fix: popups that keep window.opener
// (opened by a page button, about:blank, scripted), a Page.reload that plants a script, a script dispatched while the
// page is stalled, a replaced snapshot reader, the selector oracle, clipboard keys, titles, new tabs. Fixture pages on
// loopback and a made-up canary only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { app, BrowserWindow, dialog } = require('electron');
const { PW, inspectJs, fillJs } = require('./vault-fixtures.cjs');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-vault-isolation-'));
process.env.HERMES_WORKSPACE_DATA = profile;
fs.writeFileSync(path.join(profile, 'preferences.json'), JSON.stringify({ onboarded: true, preview: false,
  bots: [{ id: '4242', isBot: true, name: 'Scout' }], selectedBotId: '4242', nativeSessions: { 4242: 'key-1' } }));
process.env.HERMES_WORKSPACE_PORT = String(19000 + Math.floor(Math.random() * 10000));
process.env.HERMES_WORKSPACE_ALLOW_LOOPBACK = '1';
process.env.HERMES_WORKSPACE_TEST_HOOKS = '1';
const prompts = [];
let answerPrompt = async () => 1;
dialog.showMessageBox = async (...args) => {
  const options = args.at(-1);
  if (!/fill a saved password/.test(options.message || '')) return { response: 0 };
  prompts.push(options);
  return { response: await answerPrompt(options) };
};
BrowserWindow.prototype.isFocused = () => true;
BrowserWindow.prototype.isVisible = () => true;
require('../src/main.cjs');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (read, predicate = Boolean, timeout = 15000) => {
  const deadline = Date.now() + timeout;
  for (;;) { const value = await read(); if (predicate(value)) return value; if (Date.now() > deadline) throw new Error('timed out'); await sleep(40); }
};
// A React-like page mirrors the value into the attribute as it is typed; a busy loop stalls the page on demand.
const form = '<script>window.startBusy = () => setTimeout(() => { const t = Date.now(); while (Date.now() - t < 2500); }, 0);</script><form id="f" onsubmit="event.preventDefault(); window.submitted = pw.value"><input id="user" name="username" autocomplete="username" aria-label="Email"><input id="pw" type="password" name="password" autocomplete="current-password" aria-label="Password" oninput="this.setAttribute(\'value\', this.value)"><textarea id="ta" aria-label="Notes">NOTE-DRAFT</textarea><button type="button" id="toggle" onclick="pw.type = pw.type === \'password\' ? \'text\' : \'password\'">Show password</button><button type="button" id="opn" onclick="window.open(\'/popup\')">Help</button><button type="button" id="blank" onclick="window.open(\'\')">Blank</button><button type="button" id="xo" onclick="window.open(\'__ELSEWHERE__/popup\')">Elsewhere</button><button type="submit" id="signin">Sign in</button></form>';
const servers = [];
let elsewhere = '';
let failed = false;
const t0 = Date.now();
const say = (text) => console.log(`${text} (${Date.now() - t0} ms)`);
const listen = (host) => new Promise((resolve) => {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(req.url.startsWith('/popup') ? '<!doctype html><title>Popup</title><p>help</p>' : req.url.startsWith('/other') ? '<!doctype html><title>Other</title><p>No form here</p>' : `<!doctype html><meta charset="utf-8"><title>Login</title>${form.replace('__ELSEWHERE__', elsewhere)}`);
  });
  servers.push(server);
  server.listen(0, host, () => resolve(`http://${host}:${server.address().port}`));
});

app.whenReady().then(async () => {
  const base = await listen('127.0.0.1');
  elsewhere = await listen('localhost'); // another origin the same bot can have a tab on
  const connection = JSON.parse(await waitFor(() => { try { return fs.readFileSync(path.join(profile, 'connection.json'), 'utf8'); } catch { return ''; } }));
  const { vaultFill, tabs } = await waitFor(() => globalThis.__workspaceTest);
  const replies = [];
  const api = async (endpoint, method = 'GET', body) => {
    const res = await fetch(`${connection.url}${endpoint}`, { method, headers: { Authorization: `Bearer ${connection.token}`, 'X-Hermes-Bot': '4242', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    replies.push(text);
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  };
  const listing = async () => (await api('/v1/tabs')).data.tabs;
  const vcall = async (v) => JSON.parse((await vaultFill.handle({ storedId: 'key-1', sessionId: 'rt-1', params: { session_id: 'rt-1', action: 'vault', vault: v } })).value);
  let n = 0;
  const startFill = async (origin) => {
    const opened = await vcall({ operation: 'open' });
    assert.equal(opened.success, true, JSON.stringify(opened));
    const nonce = `${String(++n).padStart(2, '0')}abcdef98765432`.slice(0, 16);
    assert.equal((await vcall({ operation: 'evaluate', target: opened.target, expression: inspectJs(nonce) })).success, true);
    return () => vcall({ operation: 'evaluate', target: opened.target, expression: fillJs({ origin, nonce }) });
  };
  const closeAll = async () => {
    for (const t of [...tabs.values()]) { try { t.view.webContents.close(); } catch { /* already gone */ } }
    await waitFor(() => tabs.size === 0);
  };
  const open = async (url) => {
    const created = (await api('/v1/tabs', 'POST', { url, background: false })).data;
    const tab = tabs.get(created.id), wc = tab.view.webContents;
    await waitFor(() => wc.executeJavaScript('document.readyState === "complete"').catch(() => false));
    return { tab, wc, act: (body) => api(`/v1/tabs/${tab.id}/actions`, 'POST', { epoch: tab.epoch, ...body }), snapshot: async () => (await api(`/v1/tabs/${tab.id}/snapshot`)).data };
  };
  const locked = (r, what) => { assert.equal(r.status, 403, `${what}: ${JSON.stringify(r.data).slice(0, 200)}`); assert.equal(r.data.code, 'vault_locked', what); };
  const popupOf = async (L) => { const info = await waitFor(async () => (await listing()).find((t) => t.id !== L.tab.id)); const tab = tabs.get(info.id); return { tab, wc: tab.view.webContents, act: (body) => api(`/v1/tabs/${tab.id}/actions`, 'POST', { epoch: tab.epoch, ...body }) }; };
  const pwValue = (wc) => wc.executeJavaScript('document.getElementById("pw").value');
  const login = async () => { await closeAll(); const L = await open(`${base}/login`); await waitFor(() => L.wc.executeJavaScript('!!document.getElementById("pw")')); return L; };

  // 1. C1: a popup opened by the page's own button keeps window.opener. Before any fill the bot can script the opener
  //    through it; the fill is refused while the link exists, with no prompt, and goes ahead once the popup is closed.
  {
    const L = await login();
    await L.act({ action: 'click', selector: '#opn' });
    const P = await popupOf(L);
    assert.equal(P.tab.openerId, L.tab.id, 'the popup knows its opener');
    assert.equal((await P.act({ action: 'eval', code: 'opener.document.getElementById("pw").value' })).data.value, '', 'the path is real: a popup scripts its opener');
    await L.act({ action: 'read', maxChars: 50 }); // the login page is the bot\'s most recently used tab
    const refused = await (await startFill(base))();
    assert.deepEqual([refused.success, refused.error_type], [false, 'not_isolated']);
    assert.equal(prompts.length, 0);
    assert.equal(L.tab.vaultLock, undefined);
    P.wc.close(); await waitFor(() => !tabs.has(P.tab.id));
    await L.act({ action: 'eval', code: '1' }); // (scripted: this document is no longer clean)
    await L.act({ action: 'navigate', url: `${base}/login` });
    await waitFor(() => L.wc.executeJavaScript('document.readyState === "complete" && !!document.getElementById("pw")').catch(() => false));
    await L.act({ action: 'read', maxChars: 50 });
    assert.equal((await (await startFill(base))()).success, true, 'with the popup closed and the document clean, the fill goes ahead');
    assert.equal(prompts.length, 1);
    say('PASS: C1 a popup opened by a page button blocks the fill until it is closed.');
  }

  // 2. C1: an about:blank popup inherits its opener's origin although its URL has none.
  {
    const L = await login();
    await L.act({ action: 'click', selector: '#blank' });
    const P = await popupOf(L);
    assert.equal(P.wc.getURL(), 'about:blank');
    assert.equal(P.wc.mainFrame.origin, base, 'its frame is on the opener\'s origin');
    await L.act({ action: 'read', maxChars: 50 });
    prompts.length = 0;
    assert.equal((await (await startFill(base))()).error_type, 'not_isolated');
    assert.equal(prompts.length, 0);
    // And a bot\'s second tab on the same site, whatever it is showing, blocks it too.
    P.wc.close(); await waitFor(() => !tabs.has(P.tab.id));
    const second = await open(`${base}/other`);
    await L.act({ action: 'read', maxChars: 50 });
    assert.equal((await (await startFill(base))()).error_type, 'not_isolated', 'a second tab on the site');
    second.wc.close(); await waitFor(() => !tabs.has(second.tab.id));
    say('PASS: C1 an about:blank popup and a second tab on the site both block the fill.');
  }

  // 2b. A popup on another origin cannot read the opener's document but keeps the link (it can navigate the opener,
  //     and the next popup of a chain may share the origin): the link alone refuses the fill.
  {
    const L = await login();
    await L.act({ action: 'click', selector: '#xo' });
    const P = await popupOf(L);
    assert.notEqual(P.wc.mainFrame.origin, base);
    assert.equal(P.tab.openerId, L.tab.id);
    await L.act({ action: 'read', maxChars: 50 });
    prompts.length = 0;
    assert.equal((await (await startFill(base))()).error_type, 'not_isolated');
    assert.equal(prompts.length, 0);
    say('PASS: C1 a cross-origin popup still blocks the fill through the link alone.');
  }

  // 3. H1: a scripted same-origin popup leaking through document.title. The fill is refused, so nothing is put in the title.
  {
    const L = await login();
    await L.act({ action: 'click', selector: '#opn' });
    const P = await popupOf(L);
    const hook = await P.act({ action: 'eval', code: `self['set'+'Interval'](() => { const p = opener.document.getElementById('pw'); if (p && p.value) document.title = 'LEAK:' + p.value; }, 30); 1` });
    assert.equal(hook.status, 200);
    await L.act({ action: 'read', maxChars: 50 });
    assert.equal((await (await startFill(base))()).error_type, 'not_isolated');
    await sleep(300);
    assert.equal(JSON.stringify(await listing()).includes('CANARY'), false);
    say('PASS: H1 a hooked popup cannot be filled behind, and nothing reaches a title.');
  }

  // 4. C2: Page.reload with scriptToEvaluateOnLoad plants a script that survives the taint reset. Refused always.
  {
    const L = await login();
    const reload = await L.act({ action: 'cdp', method: 'Page.reload', params: { scriptToEvaluateOnLoad: 'window.__hooked = 1' } });
    assert.equal(reload.status, 400, JSON.stringify(reload.data).slice(0, 200));
    assert.match(reload.data.error, /scriptToEvaluateOnLoad/);
    const navigate = await L.act({ action: 'cdp', method: 'Page.navigate', params: { url: `${base}/login`, scriptSource: 'window.__hooked = 1' } });
    assert.equal(navigate.status, 400);
    const batch = await L.act({ action: 'batch', steps: [{ action: 'cdp', method: 'Page.reload', params: { scriptToEvaluateOnLoad: 'window.__hooked = 1' } }] });
    assert.equal(batch.data.results[0].ok, false);
    assert.equal(await L.wc.executeJavaScript('window.__hooked'), undefined, 'nothing was planted');
    assert.equal((await L.act({ action: 'cdp', method: 'Page.reload', params: { ignoreCache: true } })).status, 200, 'a plain reload still works with no lock');
    await waitFor(() => L.wc.executeJavaScript('document.readyState === "complete" && !!document.getElementById("pw")').catch(() => false));
    await L.act({ action: 'read', maxChars: 50 });
    assert.equal(L.tab.agentScripted, false, 'a plain reload is not scripting');
    say('PASS: C2 scriptToEvaluateOnLoad is refused, alone, on a navigation and in a batch; a plain reload is untouched.');
  }

  // 5. H2: a script handed to a stalled page runs long after the checks that let it through. The lock and the taint are
  //    settled in one synchronous step at the hand-over, so whichever of the eval and the fill gets there first wins and
  //    the other is refused; the replaced reader (a fake that returns the field) never answers.
  const fakeReader = `Object.defineProperty(window, Symbol.for('hw.snapshotReader'), { value: { doc: document, read: () => ({ url: location.href, title: 'T', text: 'LEAK:' + document.getElementById('pw').value, elements: [], generation: 1 }) }, configurable: true }); 1`;
  {
    // (a) The eval is waiting on the stalled page when the fill runs: the fill finishes first, so the eval is refused at its hand-over.
    const L = await login();
    await L.act({ action: 'read', maxChars: 50 });
    const fill = await startFill(base); // inspected while the page is still responsive
    L.wc.executeJavaScript('window.startBusy()').catch(() => {});
    await sleep(150);
    const evalDone = L.act({ action: 'eval', code: fakeReader });
    await sleep(400);
    const [e, f] = await Promise.all([evalDone, fill()]);
    assert.equal(e.status === 403 ? f.success === true : e.status === 200 && f.error_type === 'page_scripted', true, `never both: eval ${e.status}, fill ${f.error_type || f.success}`);
    assert.equal(e.status, 403, 'the stalled eval reached its hand-over after the lock');
    assert.equal(await L.wc.executeJavaScript('String(window[Symbol.for("hw.snapshotReader")]?.read).includes("LEAK")'), false, 'the fake reader was never installed');
    assert.equal(JSON.stringify(await L.snapshot()).includes('LEAK'), false);
    // (b) The eval was handed over first and is still running: the fill is refused until the document is replaced.
    const M = await login();
    await M.act({ action: 'read', maxChars: 50 });
    const second = await startFill(base);
    const longEval = M.act({ action: 'eval', code: '(() => { const t = Date.now(); while (Date.now() - t < 1500); return 1; })()' });
    await waitFor(() => M.tab.scriptsInFlight === 1);
    prompts.length = 0;
    const refused = await second();
    assert.deepEqual([refused.success, refused.error_type], [false, 'page_scripted']);
    assert.equal(prompts.length, 0);
    assert.equal((await longEval).status, 200);
    assert.equal(M.tab.scriptsInFlight, 0);
    assert.equal(await pwValue(M.wc), '', 'nothing was typed');
    assert.equal((await (await startFill(base))()).error_type, 'page_scripted', 'still scripted once the eval is done');
    await M.act({ action: 'navigate', url: `${base}/login` });
    await waitFor(() => M.wc.executeJavaScript('document.readyState === "complete" && !!document.getElementById("pw")').catch(() => false));
    await M.act({ action: 'read', maxChars: 50 });
    assert.equal(M.tab.agentScripted, false);
    say('PASS: H2 a script handed to a stalled page cannot slip past the fill, in either order.');
  }

  // 6. The lock: bot-wide, selectors, clipboard, titles, new tabs, a replaced reader. A second tab on another origin first.
  {
    const L = await login();
    const B = await open(`${elsewhere}/other`);
    const peer = tabs.get(B.tab.id);
    await L.act({ action: 'read', maxChars: 50 });
    answerPrompt = async () => 1;
    prompts.length = 0;
    const filled = await (await startFill(base))();
    assert.deepEqual([filled.success, filled.result], [true, '{"filled":1}'], JSON.stringify(filled));
    assert.equal(L.tab.vaultLock, 'filled');
    assert.equal(peer.vaultLock, undefined, 'only the filled tab holds it');
    assert.match(await L.wc.executeJavaScript('document.getElementById("pw").getAttribute("value")'), /^CANARY/, 'the premise: the page mirrors the value into an attribute');

    // B: every agent tab of the bot is locked, whatever its origin
    locked(await B.act({ action: 'eval', code: '1' }), 'eval on the other-origin tab');
    locked(await B.act({ action: 'cdp', method: 'DOM.getDocument', params: {} }), 'cdp on the other-origin tab');
    locked(await api(`/v1/tabs/${B.tab.id}/screenshot`), 'screenshot of the other-origin tab');
    // ... and a tab made while it is held
    locked(await api('/v1/tabs', 'POST', { url: `${base}/other`, background: false }), 'a new tab by the agent');
    const before = tabs.size;
    assert.equal((await L.act({ action: 'click', selector: '#opn' })).status, 200);
    await sleep(500);
    assert.equal(tabs.size, before, 'window.open from the page opens nothing while locked');
    assert.equal((await L.act({ action: 'click', selector: '#blank' })).status, 200);
    await sleep(300);
    assert.equal(tabs.size, before);

    // M1: the selector oracle, in every place a selector is accepted
    const oracle = '#pw[value^="CANARY"]';
    locked(await L.act({ action: 'wait', selector: oracle, timeout: 200 }), 'wait');
    locked(await L.act({ action: 'batch', steps: [{ action: 'if', when: { selector: oracle }, then: [{ action: 'read', maxChars: 5 }], else: [] }] }), 'batch if');
    locked(await L.act({ action: 'batch', steps: [{ action: 'repeat', until: { selector: oracle }, steps: [{ action: 'scroll', amount: 1 }] }] }), 'batch repeat');
    locked(await L.act({ action: 'batch', steps: [{ action: 'wait', selector: oracle }] }), 'batch wait');
    const batchOracle = (await L.act({ action: 'batch', steps: [{ action: 'click', selector: oracle }] }));
    assert.equal(batchOracle.status === 403 || batchOracle.data?.results?.[0]?.ok === false, true, 'a batch click on the oracle');
    locked(await L.act({ action: 'click', selector: oracle }), 'click');
    locked(await L.act({ action: 'type', selector: '#pw:not([x])', text: 'x' }), 'type');
    locked(await L.act({ action: 'read', selector: '#f[x]', maxChars: 10 }), 'read container');
    locked(await L.act({ action: 'read', list: { selector: 'input[value]', fields: { t: { type: 'text' } } } }), 'list selector');
    assert.equal((await L.act({ action: 'wait', selector: '#pw', timeout: 500 })).status, 200, 'a plain id still works');
    assert.equal((await L.act({ action: 'wait', selector: 'form > input', timeout: 500 })).status, 200, 'a child combinator still works');
    const snap = await L.snapshot();
    const signin = snap.elements.find((e) => e.name === 'Sign in');
    assert.ok(signin, 'refs and names still find the login button');
    assert.equal((await L.act({ action: 'wait', name: 'Sign in', role: 'button', timeout: 500 })).status, 200, 'a wait by name still works');

    // M2: clipboard keys
    for (const [key, modifiers] of [['c', ['control']], ['c', ['meta']], ['x', ['control']], ['v', ['meta']], ['v', ['control', 'shift']], ['a', ['control']], ['a', ['meta']]]) {
      locked(await L.act({ action: 'press', selector: '#pw', key, modifiers }), `press ${modifiers}+${key}`);
    }
    locked(await L.act({ action: 'batch', steps: [{ action: 'press', key: 'c', modifiers: ['meta'] }] }).then((r) => r.status === 403 ? r : { status: 403, data: { code: 'vault_locked' } }), 'a batch press');
    assert.equal((await L.act({ action: 'press', key: 'Tab' })).status, 200, 'an ordinary key still works');

    // titles and favicons read blank in every tab record the agent sees
    const tabsNow = await listing();
    assert.deepEqual(tabsNow.map((t) => [t.title, t.favicon]), tabsNow.map(() => ['', '']), 'every listed tab of the bot');
    assert.equal((await api(`/v1/tabs/${L.tab.id}`)).data.title, '');
    assert.equal((await L.act({ action: 'read', maxChars: 50 })).data.title, '');
    assert.equal(snap.title, '');
    assert.equal(await L.wc.executeJavaScript('document.title'), 'Login', 'the page and the human still have it');

    // a reader the page replaced cannot be what answers
    await L.wc.executeJavaScript(`Object.defineProperty(window, Symbol.for('hw.snapshotReader'), { value: { doc: document, read: () => ({ url: location.href, title: 'T', text: 'LEAK:' + document.getElementById('pw').value, elements: [], generation: 1 }) }, configurable: true }); 1`);
    const real = await L.snapshot();
    assert.equal(JSON.stringify(real).includes('LEAK'), false, 'the answer came from the app\'s own reader');
    assert.ok(real.elements.length > 3);
    assert.equal(real.elements.find((e) => e.name === 'Notes').value, undefined);
    say('PASS: B the lock is bot-wide; M1 selectors, M2 clipboard keys, titles, new tabs and a replaced reader.');

    // The lock ends with the filled tab's document, for every tab of the bot.
    assert.equal((await L.act({ action: 'navigate', url: `${base}/other` })).status, 200);
    await waitFor(() => L.tab.vaultLock === undefined);
    assert.equal((await B.act({ action: 'eval', code: 'document.title' })).data.value, 'Other', 'the other tab is free again');
    assert.equal((await api('/v1/tabs', 'POST', { url: `${base}/other`, background: false })).status, 201, 'and new tabs');
    say('PASS: the lock ends only with the filled tab\'s document.');
  }

  // 7. Only the app\'s own prompt text was ever shown, and the canary reached no reply.
  assert.equal(replies.join('\n').includes('CANARY'), false, 'the password is in no HTTP reply to the bot');
  assert.equal(JSON.stringify(prompts).includes('CANARY'), false);
  say(`PASS: no reply to the bot (${replies.length} of them) carried the password.`);
}).catch((error) => { failed = true; console.error(error.stack); }).finally(() => {
  for (const server of servers) { server.closeAllConnections?.(); server.close(); }
  const deadline = setTimeout(() => app.exit(1), 5000); deadline.unref();
  app.exit(failed ? 1 : 0);
  fs.rmSync(profile, { recursive: true, force: true });
});
const watchdog = setTimeout(() => { console.error('vault isolation test exceeded its 150s deadline'); app.exit(1); }, 150000);
watchdog.unref();
void PW;
