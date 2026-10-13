// Run: npx electron test/captcha-handback-electron.cjs
// A bot's tab meets a CAPTCHA: input on the widget is refused, a whole-page
// check is handed to the human with a note naming the site and the check, and
// once the human clears it (and leaves the field they were typing in) the tab
// goes back on its own. Page script waits while any challenge is on the page.
// Uses an isolated profile and localhost pages. No Telegram sign-in required.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { app, BrowserWindow, webContents, session, Notification } = require('electron');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-workspace-captcha-'));
process.env.HERMES_WORKSPACE_DATA = profile;
process.env.HERMES_WORKSPACE_ALLOW_LOOPBACK = '1';
fs.writeFileSync(path.join(profile, 'preferences.json'), JSON.stringify({ onboarded: true, preview: false,
  bots: [{ id: '4242', isBot: true, name: 'Scout' }], selectedBotId: '4242' }));
process.env.HERMES_WORKSPACE_PORT = String(19000 + Math.floor(Math.random() * 10000));
const shown = [];
Notification.prototype.show = function show() { shown.push(this); };
require('../src/main.cjs');
const waitFor = async (read, predicate, timeout = 12000, what = 'captcha state') => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (predicate(value)) return value; await new Promise(r => setTimeout(r, 50)); }
  throw new Error(`Timed out waiting for ${what}.`);
};
const widget = '<div class="g-recaptcha"><iframe title="reCAPTCHA" width="304" height="78" src="/recaptcha/api2/anchor?k=x&size=normal"></iframe><textarea name="g-recaptcha-response" style="display:none"></textarea></div>';
const pages = {
  '/start': '<title>start</title><p>hello</p>',
  '/form': `<title>sign in</title><form>${widget}<button id="other" type="button" onclick="document.title='other'">Other</button></form>`,
  '/sorry/index': `<title>unusual traffic</title><form id="captcha-form" action="index" method="post">${widget}</form><p>Our systems have detected unusual traffic from your computer network.</p>`,
  '/results': '<title>results</title><input id="q" aria-label="Search"><p>Ten plumbers</p>',
};
let server;
app.whenReady().then(async () => {
  const win = await waitFor(() => BrowserWindow.getAllWindows()[0], win => !!win);
  const wc = win.webContents;
  const telegram = webContents.getAllWebContents().find(item => item.session === session.fromPartition('persist:telegram'));
  if (telegram) { telegram.stop(); await telegram.loadURL('about:blank'); }
  const evaluate = code => wc.executeJavaScript(code);
  await waitFor(() => evaluate('typeof window.workspace === "object"').catch(() => false), Boolean);
  const invoke = (name, value) => evaluate(`window.workspace.command(${JSON.stringify(name)}, ${JSON.stringify(value || {})})`);
  const getState = () => evaluate('window.workspace.getState()');
  const connection = JSON.parse(await waitFor(() => { try { return fs.readFileSync(path.join(profile, 'connection.json'), 'utf8'); } catch { return ''; } }, Boolean));
  const api = async (endpoint, method = 'GET', body) => {
    const res = await fetch(`${connection.url}${endpoint}`, { method, headers: { Authorization: `Bearer ${connection.token}`, 'X-Hermes-Bot': '4242',
      ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, data: await res.json() };
  };

  server = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(pages[new URL(req.url, 'http://x').pathname] || '<title>frame</title>'); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const tab = await invoke('create-tab', { url: `${base}/start` });
  const pageWc = await waitFor(() => webContents.getAllWebContents().find(item => item.getURL().startsWith(base)), Boolean);
  await waitFor(() => pageWc.executeJavaScript('document.readyState === "complete"').catch(() => false), Boolean);
  let epoch = (await invoke('control', { id: tab.id, controller: 'agent' })).epoch;
  const act = (body) => api(`/v1/tabs/${tab.id}/actions`, 'POST', { epoch, ...body });

  // A widget in a form is reported but stays with the bot; touching it is refused.
  const form = await act({ action: 'navigate', url: `${base}/form` });
  assert.equal(form.status, 200, JSON.stringify(form.data));
  assert.deepEqual(form.data.challenge, { kind: 'recaptcha', blocking: false });
  assert.equal(form.data.tab.controller, 'agent');
  const touched = await act({ action: 'click', selector: 'iframe' });
  assert.equal(touched.status, 409);
  assert.equal(touched.data.code, 'challenge_present');
  assert.match(touched.data.error, /^challenge_present: .*reason "captcha"/);
  assert.equal((await act({ action: 'click', selector: '#other' })).status, 200, 'the rest of the page stays usable');
  // Page script could click the widget itself, so it waits until the check is gone.
  const script = await act({ action: 'eval', code: `document.querySelector('iframe').click()` });
  assert.equal(script.status, 409); assert.equal(script.data.code, 'challenge_present');
  // Raw CDP is held to read-only methods while the widget is there.
  for (const [method, params] of [['Runtime.evaluate', { expression: '1' }], ['Runtime.callFunctionOn', {}], ['Page.setDocumentContent', { frameId: 'x', html: '<script>parent.document.title = "written"</script>' }], ['DOM.setOuterHTML', { nodeId: 1, outerHTML: '<p></p>' }], ['Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter' }]]) {
    const refused = await act({ action: 'cdp', method, params });
    assert.equal(refused.status, 409, method); assert.equal(refused.data.code, 'challenge_present', method);
  }
  assert.equal((await act({ action: 'cdp', method: 'DOM.getDocument', params: {} })).status, 200, 'reads still work');
  assert.equal(await pageWc.executeJavaScript('document.title'), 'other');
  // Navigating the widget's own frame would replace the challenge document.
  const frameTree = (await act({ action: 'cdp', method: 'Page.getFrameTree', params: {} })).data.value;
  const child = JSON.parse(typeof frameTree === 'string' ? frameTree : JSON.stringify(frameTree)).frameTree.childFrames[0].frame.id;
  const swapped = await act({ action: 'cdp', method: 'Page.navigate', params: { frameId: child, url: `${base}/start` } });
  assert.equal(swapped.status, 409, JSON.stringify(swapped.data)); assert.equal(swapped.data.code, 'challenge_present');
  // A hidden control inside the widget is refused before select can change it.
  await pageWc.executeJavaScript(`(() => { const d = document.querySelector('iframe').contentDocument; d.body.insertAdjacentHTML('beforeend', '<select id="lang" style="display:none"><option value="en">English</option><option value="de">Deutsch</option></select>'); })()`);
  const picked = await act({ action: 'select', selector: '#lang', value: 'de' });
  assert.equal(picked.status, 409, JSON.stringify(picked.data)); assert.equal(picked.data.code, 'challenge_present');
  assert.equal(await pageWc.executeJavaScript(`document.querySelector('iframe').contentDocument.getElementById('lang').value`), 'en', 'the hidden select was not changed');
  // The page moves the widget under the bot's cursor: the wheel is refused there.
  await pageWc.executeJavaScript(`(() => { const f = document.querySelector('iframe'); f.dataset.style = f.getAttribute('style') || ''; f.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:9'; })()`);
  const wheel = await act({ action: 'scroll', y: 300 });
  assert.equal(wheel.status, 409, JSON.stringify(wheel.data)); assert.equal(wheel.data.code, 'challenge_present');
  await pageWc.executeJavaScript(`(() => { const f = document.querySelector('iframe'); f.style.cssText = f.dataset.style; })()`);
  assert.equal((await act({ action: 'scroll', y: 0 })).status, 200, 'the wheel works away from the widget');

  // A whole-page check goes to the human at once: the N2 release, made by the app.
  const gated = await act({ action: 'navigate', url: `${base}/sorry/index?continue=/results` });
  assert.equal(gated.status, 200, JSON.stringify(gated.data));
  assert.deepEqual(gated.data.challenge, { kind: 'google_sorry', blocking: true });
  const h = gated.data.tab.handback;
  assert.equal(gated.data.tab.controller, 'human');
  assert.equal(h.state, 'awaiting_human'); assert.equal(h.reason, 'captcha'); assert.equal(h.auto, true);
  assert.equal(h.note, 'Solve the Google "unusual traffic" check on 127.0.0.1. The tab goes back to the agent once it clears.');
  assert.equal(shown.length, 1, 'one notification');
  assert.equal(shown[0].title, 'Scout needs you');
  assert.equal(shown[0].body, h.note);
  assert.match((await act({ action: 'read' })).data.error, /^awaiting_human/);
  const claim = await api(`/v1/tabs/${tab.id}/control`, 'POST', { controller: 'agent' });
  assert.equal(claim.status, 409, 'no reclaim while the human has it'); assert.match(claim.data.error, /^awaiting_human/);
  shown[0].emit('click');
  await waitFor(getState, state => state.activeTabId === tab.id);
  await waitFor(() => evaluate('document.getElementById("needs-you-text").textContent'), text => text === `Scout needs you: ${h.note}`);

  // The human solves it and the page moves on, but they keep typing and then
  // sit in the filled field: the tab stays theirs until they leave it and six
  // quiet seconds pass, then goes back with a thank-you.
  await pageWc.executeJavaScript(`location.href = '/results'`);
  await waitFor(() => pageWc.executeJavaScript('location.pathname === "/results" && document.readyState === "complete"').catch(() => false), Boolean);
  await pageWc.executeJavaScript(`(() => { const q = document.getElementById('q'); q.focus(); let n = 0; const t = setInterval(() => { q.value += 'a'; if (++n >= 12) clearInterval(t); }, 300); })()`);
  await new Promise(r => setTimeout(r, 3000));
  assert.equal((await getState()).tabs.find(item => item.id === tab.id).controller, 'human', 'a person still typing keeps the tab');
  await new Promise(r => setTimeout(r, 8000));
  assert.equal((await getState()).tabs.find(item => item.id === tab.id).controller, 'human', 'a person sitting in a filled field keeps the tab');
  await pageWc.executeJavaScript(`document.getElementById('q').blur()`);
  const left = Date.now();
  const resumed = await waitFor(getState, state => state.tabs.find(item => item.id === tab.id).controller === 'agent', 15000, 'the automatic give-back');
  assert.ok(Date.now() - left >= 5000, 'the give-back waits out the quiet time');
  const back = resumed.tabs.find(item => item.id === tab.id);
  assert.equal(back.handback.state, 'human_returned'); assert.equal(back.handback.resumed, 'auto');
  assert.ok(back.epoch > gated.data.tab.epoch, 'the give-back moves the epoch on');
  await waitFor(() => evaluate('[document.getElementById("toast").textContent, document.getElementById("toast").classList.contains("hidden")]'), ([text, hidden]) => text === 'Thanks, continuing.' && !hidden);
  await waitFor(() => evaluate('document.getElementById("needs-you-banner").classList.contains("hidden")'), Boolean);
  assert.equal(shown.length, 1, 'the give-back does not notify');

  // The bot hears human_returned, picks up the fresh epoch and carries on.
  assert.match((await act({ action: 'read' })).data.error, /^human_returned/);
  epoch = (await api(`/v1/tabs/${tab.id}`)).data.epoch;
  const fresh = await act({ action: 'read' });
  assert.equal(fresh.status, 200, JSON.stringify(fresh.data));
  assert.equal(fresh.data.challenge, undefined);
  assert.equal((await act({ action: 'eval', code: '1 + 1' })).data.value, 2, 'page script works again once the check is gone');

  // A widget the page adds and focuses itself after the bot's last read: a
  // bare Enter must not press its Verify button.
  await pageWc.executeJavaScript(`(() => { const d = document.createElement('div'); d.className = 'g-recaptcha'; d.innerHTML = '<iframe width="304" height="78" src="/recaptcha/api2/anchor?k=x&size=normal"></iframe>'; document.body.append(d); })()`);
  await waitFor(() => pageWc.executeJavaScript(`document.querySelector('.g-recaptcha iframe').contentDocument?.readyState === 'complete'`).catch(() => false), Boolean);
  await pageWc.executeJavaScript(`(() => { const f = document.querySelector('.g-recaptcha iframe'), b = f.contentDocument.createElement('button'); b.textContent = 'Verify'; b.onclick = () => { document.title = 'verified'; }; f.contentDocument.body.append(b); f.focus(); b.focus(); })()`);
  assert.equal(await pageWc.executeJavaScript(`document.activeElement === document.querySelector('.g-recaptcha iframe')`), true, 'the widget has focus');
  const enter = await act({ action: 'press', key: 'Enter' });
  assert.equal(enter.status, 409, JSON.stringify(enter.data)); assert.equal(enter.data.code, 'challenge_present');
  assert.notEqual(await pageWc.executeJavaScript('document.title'), 'verified', 'the Verify button was not pressed');

  // The same site challenging again inside ten minutes: back off.
  const again = await act({ action: 'navigate', url: `${base}/sorry/index?again` });
  assert.equal(again.status, 200, JSON.stringify(again.data));
  assert.equal(again.data.challenge.backOff, true);
  assert.match(again.data.challenge.advice, /^127\.0\.0\.1 has challenged 2 times in 10 minutes\. Stop retrying it and use another source\.$/);
  assert.equal(again.data.tab.handback.state, 'awaiting_human');

  // A human who browses the tab on from the address bar keeps it: the check
  // is gone, but the automatic return stands down.
  await invoke('navigate', { id: tab.id, url: `${base}/start` });
  await waitFor(() => pageWc.executeJavaScript('location.pathname === "/start" && document.readyState === "complete"').catch(() => false), Boolean);
  await new Promise(r => setTimeout(r, 8000));
  const browsing = (await getState()).tabs.find(item => item.id === tab.id);
  assert.equal(browsing.controller, 'human', 'the human\'s own browsing is not handed to the bot');
  assert.equal(browsing.handback.state, 'awaiting_human');

  // The human can still give it back by hand.
  await waitFor(() => evaluate('!document.getElementById("needs-you-banner").classList.contains("hidden")'), Boolean);
  await evaluate('document.getElementById("needs-you-give-back").click()');
  const manual = await waitFor(getState, state => state.tabs.find(item => item.id === tab.id).controller === 'agent');
  assert.equal(manual.tabs.find(item => item.id === tab.id).handback.resumed, undefined);

  console.log('PASS: a CAPTCHA is refused to the bot, handed to the human with a note, and handed back once it clears and the human stops typing.');
  server.close(); app.quit();
}).catch(error => { console.error(error.stack); server?.close(); app.exit(1); });
