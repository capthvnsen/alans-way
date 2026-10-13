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
// Secret fields known only by their name (no type or autocomplete), typed with Keep typed text on.
const NAMED_SECRETS = { security_code: 'sc-90417', verificationCode: 'vc-90418', one_time_code: 'otc-90419', social_security_number: 'ssn-90420',
  cardnumber: 'cn-90421', ccnum: 'cc-90422', cvc2: 'cvc-90423', exp_date: 'exp-90424', paymentCardNo: 'pcn-90425' };
// A search the page echoes into its path and title.
const TERM = 'Zebra umbrella 7731', TERM_FORMS = ['zebra', 'umbrella 7731', 'umbrella-7731', 'umbrella%207731', 'Umbrella 7731'];
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

  // no-store keeps Chromium's own HTTP cache (which keys entries by URL, as in
  // any browsing) out of the disk scan below, so the scan sees what the app writes.
  server = http.createServer((req, res) => res.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': 'text/html' }).end(req.url === '/account'
    ? '<title>Account</title><button id="save">Save plan</button>'
    : req.url === '/find'
    ? `<title>Find</title><input id="q"><div id="pick" role="option">prefixzebrasuffix</div>
       <button id="go" onclick="location.href = '/search/prefix' + document.getElementById('q').value.toLowerCase().replace(/ +/g, '-') + 'suffix'">Go</button>`
    : req.url.startsWith('/search/')
    ? `<title>Results for ${decodeURIComponent(req.url.slice(8)).replace(/-/g, ' ')}</title><p>No results</p>`
    : `<title>Sign in</title><form><label>Email <input id="email" autocomplete="email"></label><label>Password <input id="pw" type="password"></label>
       <label>Card <input id="card" autocomplete="cc-number"></label><input id="pin" type="password"><div id="note" contenteditable="true" style="min-height:20px"></div><label>Bio <textarea id="bio"></textarea></label><input type="hidden" id="token" value="x">${Object.keys(NAMED_SECRETS).map(name => `<input name="${name}">`).join('')}</form><a id="next" href="/account">Continue</a>`));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const tab = await invoke('create-tab', { url: `${base}/login` });
  const pageWc = await waitFor(() => webContents.getAllWebContents().find(item => item.getURL().startsWith(base)), Boolean);
  const loaded = path => waitFor(() => pageWc.executeJavaScript(`location.pathname === ${JSON.stringify(path)} && document.readyState === 'complete'`).catch(() => false), Boolean);
  await loaded('/login');
  // Real input events, so the page sees trusted clicks and typing. They only
  // land in a view that is on screen with native focus, which a run with the
  // app in the background (or a sheet just closed) does not have, so check both.
  const ready = async (contents) => {
    await waitFor(() => contents.executeJavaScript('document.visibilityState === "visible" && innerWidth > 0').catch(() => false), Boolean);
    for (let attempt = 0; attempt < 20 && !contents.isFocused(); attempt++) { app.focus({ steal: true }); win.focus(); contents.focus(); await pause(100); }
    assert.ok(contents.isFocused(), 'the tab view never took native focus');
  };
  const click = async (selector, contents = pageWc) => {
    await ready(contents);
    const { x, y } = await contents.executeJavaScript(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    contents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await pause(150);
  };
  const type = async (selector, text, contents = pageWc) => {
    const focused = () => contents.executeJavaScript(`document.activeElement === document.querySelector(${JSON.stringify(selector)})`);
    for (let attempt = 0; attempt < 20 && !await focused(); attempt++) await click(selector, contents);
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
    { url: `${base}/login`, action: 'type', role: 'div', name: '', selector: '[redacted]', value: '[redacted]' },
    { url: `${base}/login`, action: 'type', role: 'textarea', name: '[redacted]', selector: '[redacted]', value: '[redacted]' },
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
  for (const [name, value] of Object.entries(NAMED_SECRETS)) await type(`[name="${name}"]`, value);
  await waitFor(getState, state => state.recording?.steps === 12);
  await evaluate('document.getElementById("recording-keep").click()');
  await evaluate('document.getElementById("recording-stop").click()');
  await waitFor(getState, state => state.recordings.length === 2);
  const kept = (await api(`/v1/recordings/${(await getState()).recordings[0].id}`, '4242')).data;
  assert.equal(kept.keepTyped, true);
  assert.deepEqual(kept.steps.slice(1).map(step => step.value), ['ada@example.com', ...Array(10).fill('[redacted]')], 'secret-named fields stay redacted with Keep typed text');

  // A bot cannot take a tab while it records; with automatic takeover off, a
  // bot taking a tab the human never took over ends its recording, as before.
  const fresh = await invoke('create-tab', { url: `${base}/login?fresh` });
  const freshWc = await waitFor(() => webContents.getAllWebContents().find(item => item.getURL().endsWith('?fresh')), Boolean);
  await waitFor(() => freshWc.executeJavaScript('document.readyState === "complete"').catch(() => false), Boolean);
  await invoke('record-start', { id: fresh.id });
  await type('#email', 'x', freshWc);
  await waitFor(getState, state => state.recording?.steps === 2);
  const refused = await api(`/v1/tabs/${fresh.id}/control`, '4242', 'POST', { controller: 'agent' });
  assert.equal(refused.status, 409); assert.match(refused.data.error, /^recording_in_progress/);
  assert.equal((await getState()).recording?.steps, 2, 'the recording keeps running');
  await invoke('settings', { autoTakeover: false });
  const claim = await api(`/v1/tabs/${fresh.id}/control`, '4242', 'POST', { controller: 'agent' });
  assert.equal(claim.status, 200, JSON.stringify(claim.data));
  await invoke('settings', { autoTakeover: true });
  await waitFor(getState, state => !state.recording && state.recordings.length === 3);
  await waitFor(() => evaluate('document.getElementById("toast").textContent'), text => text.includes('Recording stopped'));

  // A search echoed into the URL path and the page title stays off disk
  // when typed text is not kept. The tab starts blank, so the title comes
  // from the results page at Stop.
  const blank = await invoke('create-tab');
  await waitFor(getState, state => state.activeTabId === blank.id);
  await invoke('record-start', { id: blank.id });
  const blankWc = await waitFor(async () => webContents.fromId((await getState()).browserContentsId), Boolean);
  await blankWc.loadURL(`${base}/find`);
  await waitFor(() => blankWc.executeJavaScript('document.readyState === "complete"').catch(() => false), Boolean);
  await pause(300);
  await type('#q', TERM, blankWc);
  await click('#pick', blankWc);
  await click('#go', blankWc);
  await waitFor(() => blankWc.executeJavaScript('document.title').catch(() => ''), title => title.includes('umbrella 7731'));
  await waitFor(getState, state => state.recording?.steps === 5);
  const searched = await invoke('record-stop', { keepTyped: false });
  assert.equal(searched.title, '127.0.0.1', 'a title echoing the search falls back to the host');
  const search = (await api(`/v1/recordings/${searched.id}`)).data;
  assert.deepEqual(search.steps.map(step => [step.action, step.url.replace(base, ''), step.name, step.value]), [
    ['navigate', '/find', '', undefined], ['type', '/find', '', '[redacted]'], ['click', '/find', '[redacted]', undefined],
    ['click', '/find', 'Go', undefined], ['navigate', '/search/[redacted]', '', undefined]],
  'the embedded term is scrubbed from the path and the clicked suggestion name');
  await invoke('close-tab', { id: blank.id });

  // The test password, card number, notes, named secrets and the search never reached disk.
  session.fromPartition('persist:browser').flushStorageData();
  await pause(500);
  for (const file of filesUnder(profile)) {
    const bytes = fs.readFileSync(file);
    for (const text of [NOTE, BIO, ...Object.values(NAMED_SECRETS), ...TERM_FORMS]) assert.ok(!bytes.includes(text) && !bytes.includes(Buffer.from(text, 'utf16le')), `typed text that was not kept is in ${file}`);
    assert.ok(!bytes.includes(PASSWORD) && !bytes.includes(Buffer.from(PASSWORD, 'utf16le')), `the password is in ${file}`);
    assert.ok(!bytes.includes(CARD) && !bytes.includes(Buffer.from(CARD, 'utf16le')), `the card number is in ${file}`);
  }

  // Each recording is deletable.
  const files = () => fs.readdirSync(path.join(profile, 'recordings'));
  assert.equal(files().length, 4);
  await invoke('recording-delete', { id: kept.id });
  assert.equal(files().length, 3);
  assert.ok(!files().includes(`${kept.id}.json`));

  console.log('PASS: Record captures clicks, typing and navigation on a human tab, redacts secrets, shares per bot, and keeps the password off disk.');
  server.close(); app.quit();
}).catch(error => { console.error(error.stack); server?.close(); app.exit(1); });
