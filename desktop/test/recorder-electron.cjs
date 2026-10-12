// Run: npx electron test/recorder-electron.cjs
// Uses an isolated profile and localhost pages. No Telegram sign-in required.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { app, BrowserWindow, webContents, session } = require('electron');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-workspace-recorder-'));
process.env.HERMES_WORKSPACE_DATA = profile;
fs.writeFileSync(path.join(profile, 'preferences.json'), JSON.stringify({ onboarded: true, preview: false,
  bots: [{ id: '4242', isBot: true, name: 'Scout' }, { id: '5151', isBot: true, name: 'Other' }], selectedBotId: '4242' }));
process.env.HERMES_WORKSPACE_PORT = String(19000 + Math.floor(Math.random() * 10000));
require('../src/main.cjs');
// Typed only, never served: if either string is anywhere in the profile, a secret reached disk.
const PASSWORD = 'Tr0ub4dor-recorder-test-pw', CARD = '4111222233334444', NOTE = 'Private note 8317 for Ada', BIO = 'Bio text 5521 never kept';
const waitFor = async (read, predicate, timeout = 12000) => {
  const deadline = Date.now() + timeout;
  let value;
  while (Date.now() < deadline) { value = await read(); if (predicate(value)) return value; await new Promise(r => setTimeout(r, 50)); }
  throw new Error(`Timed out waiting for recorder state: ${JSON.stringify(value?.recording ?? value)?.slice(0, 300)}`);
};
const pause = ms => new Promise(r => setTimeout(r, ms));
const filesUnder = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  const file = path.join(dir, entry.name);
  return entry.isDirectory() ? filesUnder(file) : entry.isFile() ? [file] : [];
});
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
  const api = async (endpoint, bot = '4242', method = 'GET', body) => {
    const res = await fetch(`${connection.url}${endpoint}`, { method, headers: { Authorization: `Bearer ${connection.token}`, 'X-Hermes-Bot': bot,
      ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, data: await res.json() };
  };

  server = http.createServer((req, res) => res.end(req.url === '/account'
    ? '<title>Account</title><button id="save">Save plan</button>'
    : `<title>Sign in</title><form><label>Email <input id="email" autocomplete="email"></label><label>Password <input id="pw" type="password"></label>
       <label>Card <input id="card" autocomplete="cc-number"></label><input id="pin" type="password"><div id="note" contenteditable="true" style="min-height:20px"></div><label>Bio <textarea id="bio"></textarea></label><input type="hidden" id="token" value="x"></form><a id="next" href="/account">Continue</a>`));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const tab = await invoke('create-tab', { url: `${base}/login` });
  const pageWc = await waitFor(() => webContents.getAllWebContents().find(item => item.getURL().startsWith(base)), Boolean);
  const loaded = path => waitFor(() => pageWc.executeJavaScript(`location.pathname === ${JSON.stringify(path)} && document.readyState === 'complete'`).catch(() => false), Boolean);
  await loaded('/login');
  // Real input events, so the page sees trusted clicks and typing.
  const click = async selector => {
    const { x, y } = await pageWc.executeJavaScript(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    pageWc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    pageWc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await pause(150);
  };
  // A click right after the Settings sheet closes can land before the tab view
  // is back on screen, so retry until the field really has focus.
  const type = async (selector, text, contents = pageWc) => {
    const focused = () => contents.executeJavaScript(`document.activeElement === document.querySelector(${JSON.stringify(selector)})`);
    for (let attempt = 0; attempt < 20 && !await focused(); attempt++) await (contents === pageWc ? click(selector) : contents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).focus()`));
    assert.ok(await focused(), `${selector} never took focus`);
    await contents.insertText(text); await pause(150);
  };

  // Recording needs a tab the human controls.
  await invoke('control', { id: tab.id, controller: 'agent' });
  await assert.rejects(invoke('record-start', { id: tab.id }), /Take over this tab/);
  await waitFor(() => evaluate('document.getElementById("record-button").disabled'), Boolean); // Record is disabled on an agent tab
  await invoke('control', { id: tab.id, controller: 'human' });
  await waitFor(() => evaluate('!document.getElementById("record-button").disabled'), Boolean);

  // Golden path: Record, type, follow a link, click, Stop and save.
  await evaluate('document.getElementById("record-button").click()');
  await waitFor(getState, state => state.recording?.tabId === tab.id);
  await waitFor(() => evaluate('!document.getElementById("recording-banner").classList.contains("hidden")'), Boolean);
  assert.equal(await pageWc.executeJavaScript('typeof window.__alansWayRecord'), 'undefined', 'the page cannot see the recorder');
  await type('#email', 'ada@example.com');
  await type('#pw', PASSWORD);
  await type('#card', CARD);
  await type('#pin', PASSWORD);
  await type('#note', NOTE);
  await type('#bio', BIO);
  await pageWc.executeJavaScript('document.getElementById("email").dispatchEvent(new Event("input", { bubbles: true }))');
  await click('#next');
  await loaded('/account');
  await pause(300);
  await click('#save');
  await waitFor(getState, state => state.recording?.steps === 10);
  await waitFor(() => evaluate('document.getElementById("recording-text").textContent'), text => text.includes('10 steps'));
  await evaluate('document.getElementById("recording-stop").click()');
  await waitFor(getState, state => !state.recording && state.recordings.length === 1);
  await waitFor(() => evaluate('document.getElementById("toast").textContent'), text => text.includes('shared with Scout'));

  const listed = await api('/v1/recordings');
  assert.equal(listed.status, 200, JSON.stringify(listed.data));
  assert.equal(listed.data.recordings.length, 1);
  const { id } = listed.data.recordings[0];
  const got = await api(`/v1/recordings/${id}`);
  assert.equal(got.status, 200);
  assert.equal(got.data.title, 'Sign in');
  assert.deepEqual(got.data.steps, [
    { url: `${base}/login`, action: 'navigate', role: '', name: '', selector: '' },
    { url: `${base}/login`, action: 'type', role: 'input', name: 'Email', selector: '#email', value: '[redacted]' },
    { url: `${base}/login`, action: 'type', role: 'input', name: 'Password', selector: '#pw', value: '[redacted]' },
    { url: `${base}/login`, action: 'type', role: 'input', name: 'Card', selector: '#card', value: '[redacted]' },
    { url: `${base}/login`, action: 'type', role: 'input', name: '', selector: '#pin', value: '[redacted]' },
    { url: `${base}/login`, action: 'type', role: 'div', name: '', selector: '#note', value: '[redacted]' },
    { url: `${base}/login`, action: 'type', role: 'textarea', name: 'Bio', selector: '#bio', value: '[redacted]' },
    { url: `${base}/login`, action: 'click', role: 'a', name: 'Continue', selector: '#next' },
    { url: `${base}/account`, action: 'navigate', role: '', name: '', selector: '' },
    { url: `${base}/account`, action: 'click', role: 'button', name: 'Save plan', selector: '#save' },
  ], 'a synthetic page event is ignored and typed text is not kept by default');

  // A bot sees only the recordings shared with it.
  assert.deepEqual((await api('/v1/recordings', '5151')).data.recordings, []);
  assert.equal((await api(`/v1/recordings/${id}`, '5151')).status, 404);
  await evaluate('document.getElementById("settings-fallback").click()');
  await waitFor(() => evaluate('document.querySelectorAll("#recordings-list input[type=checkbox]").length'), count => count === 2);
  assert.ok(await evaluate('document.querySelector(\'#recordings-list input[data-bot-id="4242"]\').checked'));
  await evaluate('document.querySelector(\'#recordings-list input[data-bot-id="4242"]\').click()');
  await evaluate('document.querySelector(\'#recordings-list input[data-bot-id="5151"]\').click()');
  await waitFor(() => api('/v1/recordings', '5151'), result => result.data.recordings.length === 1);
  assert.equal((await api(`/v1/recordings/${id}`)).status, 404, 'unsharing takes it away from Scout');

  // Keep typed text keeps ordinary text, never the password.
  await evaluate('document.getElementById("modal-close").click()');
  await invoke('activate', { id: tab.id });
  await pageWc.loadURL(`${base}/login`); await loaded('/login');
  await invoke('record-start', { id: tab.id });
  await type('#email', 'ada@example.com');
  await type('#pw', PASSWORD);
  await waitFor(getState, state => state.recording?.steps === 3);
  await evaluate('document.getElementById("recording-keep").click()');
  await evaluate('document.getElementById("recording-stop").click()');
  await waitFor(getState, state => state.recordings.length === 2);
  const kept = (await api(`/v1/recordings/${(await getState()).recordings[0].id}`, '4242')).data;
  assert.equal(kept.keepTyped, true);
  assert.deepEqual(kept.steps.slice(1).map(step => step.value), ['ada@example.com', '[redacted]']);

  // A bot taking a tab ends its recording (a tab the human never took over
  // stays claimable, as before).
  const fresh = await invoke('create-tab', { url: `${base}/login?fresh` });
  const freshWc = await waitFor(() => webContents.getAllWebContents().find(item => item.getURL().endsWith('?fresh')), Boolean);
  await waitFor(() => freshWc.executeJavaScript('document.readyState === "complete"').catch(() => false), Boolean);
  await invoke('record-start', { id: fresh.id });
  await type('#email', 'x', freshWc);
  await waitFor(getState, state => state.recording?.steps === 2);
  const claim = await api(`/v1/tabs/${fresh.id}/control`, '4242', 'POST', { controller: 'agent' });
  assert.equal(claim.status, 200, JSON.stringify(claim.data));
  await waitFor(getState, state => !state.recording && state.recordings.length === 3);
  await waitFor(() => evaluate('document.getElementById("toast").textContent'), text => text.includes('Recording stopped'));

  // The test password and card number never reached disk.
  session.fromPartition('persist:browser').flushStorageData();
  await pause(500);
  for (const file of filesUnder(profile)) {
    const bytes = fs.readFileSync(file);
    for (const text of [NOTE, BIO]) assert.ok(!bytes.includes(text) && !bytes.includes(Buffer.from(text, 'utf16le')), `typed text that was not kept is in ${file}`);
    assert.ok(!bytes.includes(PASSWORD) && !bytes.includes(Buffer.from(PASSWORD, 'utf16le')), `the password is in ${file}`);
    assert.ok(!bytes.includes(CARD) && !bytes.includes(Buffer.from(CARD, 'utf16le')), `the card number is in ${file}`);
  }

  // Each recording is deletable.
  const files = () => fs.readdirSync(path.join(profile, 'recordings'));
  assert.equal(files().length, 3);
  await invoke('recording-delete', { id: kept.id });
  assert.equal(files().length, 2);
  assert.ok(!files().includes(`${kept.id}.json`));

  console.log('PASS: Record captures clicks, typing and navigation on a human tab, redacts secrets, shares per bot, and keeps the password off disk.');
  server.close(); app.quit();
}).catch(error => { console.error(error.stack); server?.close(); app.exit(1); });
