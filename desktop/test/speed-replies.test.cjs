// The one-turn benchmark contract: a page that mimics ten sequential tasks.
// Like the real benchmark page, a correct answer first shows "✓ Correct"
// feedback and 450ms later swaps in the next instruction and its controls.
// The action reply settles after the work the action itself started (short
// timers, requests), so a bare click already carries the next state and fresh
// refs; no wait, read or follow-up snapshot is needed. A password-manager
// style announcement sits on the page the whole time and must stay out of
// the text. Runs the real VPS host against a real headless Chromium; skipped
// when no Chrome is found (set HERMES_TEST_CHROME).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { CDP } = require('../src/cdp.cjs');
const { followUpArmExpression, followUpCloseExpression, snapshotExpression } = require('../src/browser-page.cjs');

function findChrome() {
  const home = os.homedir();
  const globs = (dir, rx) => { try { return fs.readdirSync(dir).filter((n) => rx.test(n)).map((n) => path.join(dir, n)); } catch { return []; } };
  const candidates = [
    process.env.HERMES_TEST_CHROME,
    ...globs(path.join(home, '.agent-browser', 'browsers'), /^chrome-/).map((d) => path.join(d, 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')),
    ...globs(path.join(home, 'Library/Caches/ms-playwright'), /^chromium-\d+$/).flatMap((d) => globs(d, /^chrome-/).map((e) => path.join(e, 'Chromium.app/Contents/MacOS/Chromium'))),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ...['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].flatMap((n) => (process.env.PATH || '').split(path.delimiter).map((d) => path.join(d, n))),
  ];
  return candidates.find((file) => file && fs.existsSync(file));
}
const chrome = findChrome();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Ten tasks: button click, link click, checkbox, select and type+submit run
// twice each. Each call acts on a ref taken from the previous reply's
// elements and nothing else: the settle waits out the follow-up render the
// action started, so the reply's effect already carries the next state.
const pick = (els, pred, hint) => {
  const el = els.find(pred);
  assert.ok(el && el.ref, `no fresh ref for ${hint}: ${JSON.stringify(els)}`);
  return el.ref;
};
const tasks = [
  { prompt: 'Click the Start button', steps: (els) => [{ action: 'click', ref: pick(els, (e) => e.role === 'button' && /Start/.test(e.name || ''), 'Start') }], next: 'Task 2:' },
  { prompt: 'Click the Continue link', steps: (els) => [{ action: 'click', ref: pick(els, (e) => /Continue/.test(e.name || ''), 'Continue') }], next: 'Task 3:' },
  { prompt: 'Check the Agree checkbox', steps: (els) => [{ action: 'click', ref: pick(els, (e) => e.type === 'checkbox', 'Agree') }], next: 'Task 4:' },
  { prompt: 'Choose Banana in the fruit select', steps: (els) => [{ action: 'select', ref: pick(els, (e) => e.role === 'select', 'fruit select'), text: 'Banana' }], next: 'Task 5:' },
  { prompt: 'Type a word and send the first form', steps: (els) => [{ action: 'type', ref: pick(els, (e) => e.role === 'input' && !e.type, 'first input'), text: 'hello' }, { action: 'click', ref: pick(els, (e) => /Send/.test(e.name || ''), 'Send') }], next: 'Task 6:' },
  { prompt: 'Click the Finish button', steps: (els) => [{ action: 'click', ref: pick(els, (e) => /Finish/.test(e.name || ''), 'Finish') }], next: 'Task 7:' },
  { prompt: 'Click the Proceed link', steps: (els) => [{ action: 'click', ref: pick(els, (e) => /Proceed/.test(e.name || ''), 'Proceed') }], next: 'Task 8:' },
  { prompt: 'Check the Confirm checkbox', steps: (els) => [{ action: 'click', ref: pick(els, (e) => e.type === 'checkbox', 'Confirm') }], next: 'Task 9:' },
  { prompt: 'Choose Cherry in the dessert select', steps: (els) => [{ action: 'select', ref: pick(els, (e) => e.role === 'select', 'dessert select'), choice: 'Cherry' }], next: 'Task 10:' },
  { prompt: 'Type a word and send the second form', steps: (els) => [{ action: 'type', ref: pick(els, (e) => e.role === 'input' && !e.type, 'second input'), text: 'done' }, { action: 'click', ref: pick(els, (e) => /Send/.test(e.name || ''), 'Send') }], next: 'All 10 tasks done' },
];
const sections = [
  `<div id="task1"><p>Task 1: Click the Start button</p><button id="t1" onclick="advance(1)">Start</button></div>`,
  `<div id="task2" class="hidden"><p>Task 2: Click the Continue link</p><a id="t2" href="#" onclick="advance(2);return false">Continue</a></div>`,
  `<div id="task3" class="hidden"><p>Task 3: Check the Agree checkbox</p><label><input id="t3" type="checkbox" onchange="advance(3)"> Agree</label></div>`,
  `<div id="task4" class="hidden"><p>Task 4: Choose Banana in the fruit select</p><select id="t4" onchange="advance(4)"><option value="">Pick a fruit</option><option value="a">Apple</option><option value="b">Banana</option><option value="c">Cherry</option></select></div>`,
  `<div id="task5" class="hidden"><p>Task 5: Type a word and send the first form</p><form onsubmit="advance(5);return false"><input id="t5in"><button id="t5go" type="submit">Send</button></form></div>`,
  `<div id="task6" class="hidden"><p>Task 6: Click the Finish button</p><button id="t6" onclick="advance(6)">Finish</button></div>`,
  `<div id="task7" class="hidden"><p>Task 7: Click the Proceed link</p><a id="t7" href="#" onclick="advance(7);return false">Proceed</a></div>`,
  `<div id="task8" class="hidden"><p>Task 8: Check the Confirm checkbox</p><label><input id="t8" type="checkbox" onchange="advance(8)"> Confirm</label></div>`,
  `<div id="task9" class="hidden"><p>Task 9: Choose Cherry in the dessert select</p><select id="t9" onchange="advance(9)"><option value="">Pick a dessert</option><option value="p">Pie</option><option value="c">Cake</option><option value="ch">Cherry</option></select></div>`,
  `<div id="task10" class="hidden"><p>Task 10: Type a word and send the second form</p><form onsubmit="advance(10);return false"><input id="t10in"><button id="t10go" type="submit">Send</button></form></div>`,
  `<div id="done" class="hidden"><p>All 10 tasks done</p></div>`,
];
const benchPage = `<!doctype html><title>bench</title><style>.hidden{display:none}</style>
<div id="fb" class="hidden">✓ Correct — 0.4s</div>
${sections.join('\n')}
<div aria-live="polite" data-1p-announce="menu">1Password menu is available. Press down arrow to select.</div>
<div data-bitwarden-watching="1">Bitwarden inline menu opened. Press arrow keys to choose.</div>
<acme-vault-helper id="vh">AcmeVault quick menu is ready.</acme-vault-helper>
<script>
// An extension's isolated world can attach a shadow root the page registry
// never defined; the light-DOM text is noise either way.
document.getElementById('vh').attachShadow({ mode: 'open' });
function advance(done) {
  document.getElementById('fb').classList.remove('hidden');
  setTimeout(function () {
    document.getElementById('fb').classList.add('hidden');
    document.getElementById('task' + done).classList.add('hidden');
    document.getElementById(done === 10 ? 'done' : 'task' + (done + 1)).classList.remove('hidden');
  }, 450);
}
</script>`;

// Fixture pages for the effect-reply edge cases.
const longRows = Array.from({ length: 400 }, (_, i) => `<div>Long page row ${i} with enough padding to fill the read window</div>`).join('');
const longPage = `<!doctype html><title>long</title><style>.hidden{display:none}</style>
${longRows}<div id="tail" class="hidden">tail reveal beyond the read window</div>`;
const asyncPage = `<!doctype html><title>async</title><button id="ab" onclick="setTimeout(function(){var d=document.createElement('div');d.textContent='Async result appeared';document.body.appendChild(d)},150)">Load</button>`;
const navA = `<!doctype html><title>navA</title><p>Shared header</p><p>Page A body</p><a id="l" href="/nav-b">Next</a><a id="h" href="#frag">Jump</a><p id="frag">anchor</p>`;
const navB = `<!doctype html><title>navB</title><p>Shared header</p><p>Page B body</p>`;
const focusPage = `<!doctype html><title>focus</title><div id="f" tabindex="0">Plain focusable</div>`;
// Consequence-settle fixtures: work the click itself starts.
const fetchPage = `<!doctype html><title>fetchp</title><button id="fb">Load</button><div id="out"></div><script>
document.getElementById('fb').onclick = function () {
  fetch('/slow-json').then(function (r) { return r.text(); }).then(function (t) { document.getElementById('out').textContent = t; });
};
</script>`;
const hangPage = `<!doctype html><title>hang</title><button id="hb">Hang</button><script>
document.getElementById('hb').onclick = function () { fetch('/hang').then(function () { document.body.append('landed'); }, function () {}); };
</script>`;
// A poller and a long timer armed before the click are not its follow-up.
const noisePage = `<!doctype html><title>noise</title><button id="nb">Quiet</button><div id="tick">0</div><script>
setInterval(function () { const d = document.getElementById('tick'); d.textContent = String(Number(d.textContent) + 1); }, 100);
setTimeout(function () { document.body.appendChild(document.createElement('hr')); }, 5000);
</script>`;
const quietPage = `<!doctype html><title>quiet</title><button id="qb">Noop</button>`;
// A main thread this busy is what a slow machine's renderer looks like: the
// dispatched click queues behind work and its handler runs well after the
// host was acked.
const busyPage = `<!doctype html><title>busy</title><button id="rb">Go</button><div id="out"></div><script>
setInterval(function () { var t = Date.now(); while (Date.now() - t < 150) {} }, 160);
document.getElementById('rb').onclick = function () {
  setTimeout(function () { document.getElementById('out').textContent = 'Busy follow-up landed'; }, 300);
};
</script>`;
// A page's own hint is not extension noise: the phrase only gets filtered
// inside a node the structural extension heuristics already flagged.
const hintPage = `<!doctype html><title>hint</title><label for="c">Fruit</label><input id="c" role="combobox" aria-expanded="true"><p id="hint">Press down arrow to select a suggestion.</p>`;
// A bundled page captures fetch at module init, before any agent action could
// arm a lazy tracker; only a document-start install still counts its work.
const boundPage = `<!doctype html><title>bound</title><button id="bb">Go</button><div id="out"></div><script>
var capturedFetch = window.fetch;
document.getElementById('bb').onclick = function () {
  capturedFetch('/slow-json').then(function (r) { return r.text(); }).then(function (t) { document.getElementById('out').textContent = t; });
};
</script>`;
const routes = { '/bench': benchPage, '/long': longPage, '/async': asyncPage, '/nav-a': navA, '/nav-b': navB, '/focus': focusPage, '/fetchp': fetchPage, '/hang-page': hangPage, '/noise': noisePage, '/quiet': quietPage, '/hint': hintPage, '/bound': boundPage, '/busy': busyPage };

let dir, profile, browser, host, site, port, connection, stderr = '', cdpPort;
const api = (route, method = 'GET', body, epoch) =>
  fetch(connection.url + route, {
    method,
    headers: { Authorization: `Bearer ${connection.token}`, 'X-Hermes-Bot': 'bench-bot', 'X-Control-Epoch': String(epoch ?? ''), 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, data: await r.json() }));

before(async () => {
  if (!chrome) return;
  site = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://x').pathname;
    // A slow endpoint and a never-answering one stand in for a page's own
    // requests: the tracker counts them only when the action started them.
    if (pathname === '/slow-json') return setTimeout(() => { res.setHeader('content-type', 'text/plain'); res.end('Fetched payload text'); }, 300);
    if (pathname === '/hang') return;
    res.setHeader('content-type', 'text/html');
    res.end(routes[pathname] || 'nf');
  });
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
  port = site.address().port;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-bench-'));
  profile = path.join(dir, 'profile');
  browser = spawn(chrome, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-sandbox',
    '--host-resolver-rules=MAP bench.example 127.0.0.1', 'about:blank'], { stdio: 'ignore' });
  const portFile = path.join(profile, 'DevToolsActivePort');
  // Child processes publish their endpoints through files; a loaded runner
  // can take tens of seconds to get there, so wait long and fail early.
  for (const deadline = Date.now() + 60000; !fs.existsSync(portFile);) {
    assert.equal(browser.exitCode, null, 'Chrome exited before writing DevToolsActivePort');
    assert.ok(Date.now() < deadline, 'Chrome never wrote DevToolsActivePort');
    await wait(100);
  }
  cdpPort = fs.readFileSync(portFile, 'utf8').split('\n')[0];
  // DevToolsActivePort appears when the port is bound, before Chrome answers
  // HTTP; the host's one-shot connect gives up after 3s and exits on a starved runner.
  for (const deadline = Date.now() + 60000;;) {
    if (await fetch(`http://127.0.0.1:${cdpPort}/json/version`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false)) break;
    assert.equal(browser.exitCode, null, 'Chrome exited before answering /json/version');
    assert.ok(Date.now() < deadline, 'Chrome never answered /json/version');
    await wait(100);
  }
  const data = path.join(dir, 'data');
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ cdpUrl: `http://127.0.0.1:${cdpPort}`, port: await new Promise((r) => { const p = http.createServer(); p.listen(0, '127.0.0.1', () => { const n = p.address().port; p.close(() => r(n)); }); }) }));
  const env = { ...process.env, HERMES_VPS_BROWSER_DATA: data };
  delete env.HERMES_WORKSPACE_ALLOW_LOOPBACK;
  host = spawn(process.execPath, [path.join(__dirname, '../scripts/vps-browser-host.cjs'), 'serve'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  host.stderr.on('data', (c) => { stderr += c; });
  for (const deadline = Date.now() + 60000; !fs.existsSync(path.join(data, 'connection.json'));) {
    assert.equal(host.exitCode, null, `VPS host exited early: ${stderr}`);
    assert.ok(Date.now() < deadline, `VPS host never wrote connection.json: ${stderr}`);
    await wait(100);
  }
  connection = JSON.parse(fs.readFileSync(path.join(data, 'connection.json')));
});
const exited = (child) => new Promise((resolve) => {
  if (!child || child.exitCode !== null || child.signalCode) return resolve();
  const force = setTimeout(() => child.kill('SIGKILL'), 3000);
  child.once('exit', () => { clearTimeout(force); resolve(); });
  child.kill();
});
after(async () => {
  site?.close();
  await Promise.all([exited(host), exited(browser)]);
  if (dir) { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {} }
});

test('ten sequential tasks each complete in one action call', { skip: !chrome && 'no Chrome found (set HERMES_TEST_CHROME)', timeout: 120000 }, async () => {
  const tab = (await api('/v1/tabs', 'POST', { url: `http://bench.example:${port}/bench` })).data;
  assert.ok(tab.id, `tab did not open: ${stderr}`);
  const snap = await api(`/v1/tabs/${tab.id}/snapshot`);
  assert.equal(snap.status, 200);
  assert.ok(!/1Password|Bitwarden|AcmeVault/.test(snap.data.text), `snapshot leaked extension text: ${snap.data.text}`);
  let elements = snap.data.elements;
  assert.ok(Array.isArray(elements) && elements.length, 'the first snapshot lists the task 1 controls');
  let calls = 0;
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    // A single action call: no wait or read steps, no snapshot between tasks.
    const steps = task.steps(elements);
    const reply = await api(`/v1/tabs/${tab.id}/actions`, 'POST', { action: 'batch', epoch: tab.epoch, steps });
    calls++;
    assert.equal(reply.status, 200, `task ${i + 1} call failed: ${JSON.stringify(reply.data)}\n${stderr}`);
    assert.ok(reply.data.results.every((step) => step.ok), `task ${i + 1} step failed: ${JSON.stringify(reply.data.results)}`);
    assert.ok(reply.data.effect, `task ${i + 1} reply carries no effect`);
    assert.equal(reply.data.effect.changed, true, `task ${i + 1} changed nothing`);
    assert.ok(reply.data.effect.text.includes(task.next), `task ${i + 1} effect.text lacks ${JSON.stringify(task.next)}: ${JSON.stringify(reply.data.effect)}`);
    assert.ok(!/1Password|Bitwarden|AcmeVault/.test(reply.data.effect.text), `task ${i + 1} effect.text leaked extension text`);
    assert.ok(Number.isFinite(reply.data.effect.settledMs), `task ${i + 1} effect lacks settledMs: ${JSON.stringify(reply.data.effect)}`);
    // The controls changed with the task, so the reply carries fresh refs the
    // next call acts on directly, with no snapshot in between. The final task
    // leaves no controls behind, so its list is empty.
    assert.ok(Array.isArray(reply.data.elements), `task ${i + 1} reply lacks an elements list: ${JSON.stringify(reply.data)}`);
    if (i + 1 < tasks.length) assert.ok(reply.data.elements.length, `task ${i + 1} reply lacks fresh element refs`);
    assert.ok(reply.data.elements.every((el) => /^s\d+-\d+$/.test(el.ref)), `task ${i + 1} refs malformed: ${JSON.stringify(reply.data.elements)}`);
    elements = reply.data.elements;
    if (i === 0) {
      assert.equal(reply.data.effect.navigated, false);
      assert.equal(reply.data.effect.url, `http://bench.example:${port}/bench`);
      assert.equal(reply.data.effect.title, 'bench');
      // The reply waited out the 450ms render timer the click started; the
      // bound is loose because the read starts wherever the eval lands.
      assert.ok(reply.data.effect.settledMs >= 200, `task 1 settledMs: ${reply.data.effect.settledMs}`);
      console.log(`single-action settle: task 1 waited ${reply.data.effect.settledMs}ms for its own follow-up render; effect.text=${JSON.stringify(reply.data.effect.text.slice(0, 120))}`);
    }
    if (i === 3 || i === 8) assert.match(reply.data.results[0].matched.by, /label/, `task ${i + 1} select matched by label`);
  }
  assert.equal(calls, 10, 'one action call per task');
});

test('a busy renderer still counts the work its own click started', { skip: !chrome && 'no Chrome found (set HERMES_TEST_CHROME)', timeout: 120000 }, async () => {
  const tab = (await api('/v1/tabs', 'POST', { url: `http://bench.example:${port}/busy` })).data;
  assert.ok(tab.id, `tab did not open: ${stderr}`);
  const snap = await api(`/v1/tabs/${tab.id}/snapshot`);
  assert.equal(snap.status, 200);
  const direct = await CDP.connect(`http://127.0.0.1:${cdpPort}`);
  try {
    const { sessionId } = await direct.send('Target.attachToTarget', { targetId: tab.targetId, flatten: true });
    // A slow machine delivers the dispatched input well after the host is
    // acked: the follow-up window must stay open until the page saw the
    // event, or the click's own render timer escapes the settle.
    await direct.send('Emulation.setCPUThrottlingRate', { rate: 6 }, sessionId);
    const reply = await api(`/v1/tabs/${tab.id}/actions`, 'POST', { action: 'click', selector: '#rb', epoch: tab.epoch });
    assert.equal(reply.status, 200, JSON.stringify(reply.data));
    assert.equal(reply.data.effect.changed, true, `effect: ${JSON.stringify(reply.data.effect)}`);
    assert.ok(reply.data.effect.text.includes('Busy follow-up landed'), `busy-renderer click lost its follow-up render: ${JSON.stringify(reply.data.effect)}`);
    console.log(`busy click settle: waited ${reply.data.effect.settledMs}ms for the follow-up render`);
    await direct.send('Emulation.clearCPUThrottlingRate', {}, sessionId).catch(() => {});
  } finally {
    direct.socket.close();
  }
});

// The CI flake behind this test: on a starved runner the dispatched input
// reached the page ~90ms after the host's close landed, so the click's own
// render timer slipped past the follow-up window and the reply settled early.
// This drives that exact state - arm, close, then a late event - in the page.
test('the follow-up window stays open until the page sees the dispatched input', { skip: !chrome && 'no Chrome found (set HERMES_TEST_CHROME)', timeout: 60000 }, async () => {
  const tab = (await api('/v1/tabs', 'POST', { url: `http://bench.example:${port}/quiet` })).data;
  assert.ok(tab.id, `tab did not open: ${stderr}`);
  await api(`/v1/tabs/${tab.id}/snapshot`);
  const direct = await CDP.connect(`http://127.0.0.1:${cdpPort}`);
  try {
    const { sessionId } = await direct.send('Target.attachToTarget', { targetId: tab.targetId, flatten: true });
    const evalOnTab = (expr) => direct.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId).then((r) => r.result && r.result.value);
    const cur = `(() => { const c = window[Symbol.for('hw.followUp')] && window[Symbol.for('hw.followUp')].cur; return c ? { open: c.open, until: Math.round(c.until), pending: c.pending, total: c.total, delivered: !!c.delivered, now: Math.round(performance.now()) } : null; })()`;
    await evalOnTab(followUpArmExpression());
    // Close and read in one evaluate, so no runner stall can land between them.
    const closed = await evalOnTab(`(${followUpCloseExpression()}, ${cur})`);
    assert.equal(closed.delivered, false, 'no input reached the page yet');
    assert.equal(closed.open, true, `the window stays open while the input is in flight: ${JSON.stringify(closed)}`);
    // The "event" lands inside the delivery bound, late like on a starved CI
    // runner, and its handler schedules the page's follow-up.
    await wait(50);
    await evalOnTab(`(() => { const b = document.getElementById('qb'); b.addEventListener('click', () => setTimeout(() => { window.__followUp = 1; }, 30), { once: true }); b.dispatchEvent(new Event('click', { bubbles: true })); return 1; })()`);
    const armed = await evalOnTab(cur);
    assert.equal(armed.delivered, true, 'the page saw the event');
    assert.equal(armed.total, 1, `the late handler's timer must be tracked: ${JSON.stringify(armed)}`);
    for (const deadline = Date.now() + 5000; await evalOnTab('window.__followUp') !== 1;) {
      assert.ok(Date.now() < deadline, 'the follow-up timer never ran');
      await wait(50);
    }
  } finally {
    direct.socket.close();
  }
});

// The follow-on CI flake ('a fetch bound at module init ...'): while the
// close's delivery wait was still pending, the effect read sealed the window
// itself after a fixed grace, so a click that reached the page inside the
// delivery bound counted nothing and the reply settled before its fetch
// landed. Driven exactly: arm, close, start the settle read, then land the
// click on the tracker's raw timer so the click itself is never tracked.
test('a click landing inside the delivery window still counts the work it started', { skip: !chrome && 'no Chrome found (set HERMES_TEST_CHROME)', timeout: 60000 }, async () => {
  const tab = (await api('/v1/tabs', 'POST', { url: `http://bench.example:${port}/bound` })).data;
  assert.ok(tab.id, `tab did not open: ${stderr}`);
  await api(`/v1/tabs/${tab.id}/snapshot`);
  const direct = await CDP.connect(`http://127.0.0.1:${cdpPort}`);
  try {
    const { sessionId } = await direct.send('Target.attachToTarget', { targetId: tab.targetId, flatten: true });
    const evalOnTab = (expr) => direct.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId).then((r) => {
      if (r.exceptionDetails) throw new Error(`eval threw: ${JSON.stringify(r.exceptionDetails).slice(0, 500)}`);
      return r.result && r.result.value;
    });
    await evalOnTab(followUpArmExpression());
    const scheduled = await evalOnTab(`(() => {
      const closed = ${followUpCloseExpression()};
      const s = window[Symbol.for('hw.followUp')];
      if (!closed || !s || !s.setT) return false;
      const raw = s.setT;
      raw(() => document.getElementById('bb').dispatchEvent(new Event('click', { bubbles: true })), 320);
      return true;
    })()`);
    assert.equal(scheduled, true, 'the close ran and the late click was scheduled on the raw timer');
    const data = await evalOnTab(snapshotExpression(90, { effect: true, settle: true }));
    assert.ok(data && typeof data.text === 'string', `the settle read returned nothing: ${JSON.stringify(data)}`);
    assert.ok(data.text.includes('Fetched payload text'), `the late click's fetch escaped the settle: ${JSON.stringify(data.text).slice(0, 300)} settledMs=${data.settledMs}`);
  } finally {
    direct.socket.close();
  }
});

test('an unchanged long page does not report its unseen tail as new text', { skip: !chrome && 'no Chrome found (set HERMES_TEST_CHROME)', timeout: 60000 }, async () => {
  const tab = (await api('/v1/tabs', 'POST', { url: `http://bench.example:${port}/long` })).data;
  assert.ok(tab.id, `tab did not open: ${stderr}`);
  // The agent's snapshots cap the text walk below the effect read's, so the
  // diff must be limited to the coverage the previous read actually had.
  const snap = await api(`/v1/tabs/${tab.id}/snapshot?maxChars=2000`);
  assert.equal(snap.status, 200);
  assert.equal(snap.data.truncated.text, true, 'fixture must exceed the snapshot cap');
  const reply = await api(`/v1/tabs/${tab.id}/actions`, 'POST', { action: 'eval', code: '1', epoch: tab.epoch });
  assert.equal(reply.status, 200, JSON.stringify(reply.data));
  assert.equal(reply.data.effect.changed, false, `effect: ${JSON.stringify(reply.data.effect)}`);
  assert.equal(reply.data.effect.text, '');
  // A reveal past the walk cap still reports changed via the whole-page hash.
  const deep = await api(`/v1/tabs/${tab.id}/actions`, 'POST', { action: 'eval', code: `document.getElementById('tail').classList.remove('hidden')`, epoch: tab.epoch });
  assert.equal(deep.status, 200);
  assert.equal(deep.data.effect.changed, true, `effect: ${JSON.stringify(deep.data.effect)}`);
});

test('a bare click reports DOM text that lands shortly after it', { skip: !chrome && 'no Chrome found (set HERMES_TEST_CHROME)', timeout: 60000 }, async () => {
  const tab = (await api('/v1/tabs', 'POST', { url: `http://bench.example:${port}/async` })).data;
  assert.ok(tab.id, `tab did not open: ${stderr}`);
  await api(`/v1/tabs/${tab.id}/snapshot`);
  const reply = await api(`/v1/tabs/${tab.id}/actions`, 'POST', { action: 'click', selector: '#ab', epoch: tab.epoch });
  assert.equal(reply.status, 200, JSON.stringify(reply.data));
  assert.equal(reply.data.effect.changed, true);
  assert.ok(reply.data.effect.text.includes('Async result appeared'), `effect.text: ${JSON.stringify(reply.data.effect.text)}`);
});

test('navigated is true only for a cross-document main-frame navigation', { skip: !chrome && 'no Chrome found (set HERMES_TEST_CHROME)', timeout: 60000 }, async () => {
  const tab = (await api('/v1/tabs', 'POST', { url: `http://bench.example:${port}/nav-a` })).data;
  assert.ok(tab.id, `tab did not open: ${stderr}`);
  await api(`/v1/tabs/${tab.id}/snapshot`);
  // A same-document pushState updates url without reporting a navigation.
  const push = await api(`/v1/tabs/${tab.id}/actions`, 'POST', { action: 'eval', code: `history.pushState({}, '', location.pathname + '#sect')`, epoch: tab.epoch });
  assert.equal(push.status, 200, JSON.stringify(push.data));
  assert.equal(push.data.effect.navigated, false);
  assert.ok(push.data.effect.url.endsWith('#sect'), `effect.url: ${push.data.effect.url}`);
  // A hash link click is same-document too.
  const hash = await api(`/v1/tabs/${tab.id}/actions`, 'POST', { action: 'click', selector: '#h', epoch: tab.epoch });
  assert.equal(hash.status, 200, JSON.stringify(hash.data));
  assert.equal(hash.data.effect.navigated, false, `effect: ${JSON.stringify(hash.data.effect)}`);
  // A real link click commits a new document: navigated, and lines shared
  // with the old page are not masked out of the new page's text.
  const nav = await api(`/v1/tabs/${tab.id}/actions`, 'POST', {
    action: 'batch', epoch: tab.epoch,
    steps: [{ action: 'click', selector: '#l' }, { action: 'wait', url: '/nav-b', timeout: 10000 }],
  });
  assert.equal(nav.status, 200, JSON.stringify(nav.data));
  assert.equal(nav.data.effect.navigated, true, `effect: ${JSON.stringify(nav.data.effect)}`);
  assert.equal(nav.data.effect.url, `http://bench.example:${port}/nav-b`);
  assert.ok(nav.data.effect.text.includes('Shared header'), `effect.text: ${JSON.stringify(nav.data.effect.text)}`);
  assert.ok(nav.data.effect.text.includes('Page B body'), `effect.text: ${JSON.stringify(nav.data.effect.text)}`);
});

test('effect reports focus on any element and move skips the page read', { skip: !chrome && 'no Chrome found (set HERMES_TEST_CHROME)', timeout: 60000 }, async () => {
  const tab = (await api('/v1/tabs', 'POST', { url: `http://bench.example:${port}/focus` })).data;
  assert.ok(tab.id, `tab did not open: ${stderr}`);
  await api(`/v1/tabs/${tab.id}/snapshot`);
  const reply = await api(`/v1/tabs/${tab.id}/actions`, 'POST', { action: 'click', selector: '#f', epoch: tab.epoch });
  assert.equal(reply.status, 200, JSON.stringify(reply.data));
  assert.ok(reply.data.effect.focused, `no focused element: ${JSON.stringify(reply.data.effect)}`);
  assert.equal(reply.data.effect.focused.name, 'Plain focusable');
  const move = await api(`/v1/tabs/${tab.id}/actions`, 'POST', { action: 'move', x: 40, y: 40, epoch: tab.epoch });
  assert.equal(move.status, 200, JSON.stringify(move.data));
  assert.deepEqual(move.data.effect, { navigated: false, changed: false, text: '' });
});

test('a click reply waits out the request the click started', { skip: !chrome && 'no Chrome found (set HERMES_TEST_CHROME)', timeout: 60000 }, async () => {
  const tab = (await api('/v1/tabs', 'POST', { url: `http://bench.example:${port}/fetchp` })).data;
  assert.ok(tab.id, `tab did not open: ${stderr}`);
  await api(`/v1/tabs/${tab.id}/snapshot`);
  const reply = await api(`/v1/tabs/${tab.id}/actions`, 'POST', { action: 'click', selector: '#fb', epoch: tab.epoch });
  assert.equal(reply.status, 200, JSON.stringify(reply.data));
  assert.ok(reply.data.effect.text.includes('Fetched payload text'), `effect.text: ${JSON.stringify(reply.data.effect.text)}`);
  assert.ok(reply.data.effect.settledMs >= 200, `settledMs: ${reply.data.effect.settledMs}`);
});

test('work the click did not start holds no reply', { skip: !chrome && 'no Chrome found (set HERMES_TEST_CHROME)', timeout: 60000 }, async () => {
  const tab = (await api('/v1/tabs', 'POST', { url: `http://bench.example:${port}/noise` })).data;
  assert.ok(tab.id, `tab did not open: ${stderr}`);
  await api(`/v1/tabs/${tab.id}/snapshot`);
  const started = Date.now();
  const reply = await api(`/v1/tabs/${tab.id}/actions`, 'POST', { action: 'click', selector: '#nb', epoch: tab.epoch });
  const elapsed = Date.now() - started;
  console.log(`unrelated-work click reply: ${elapsed}ms, settledMs=${reply.data.effect && reply.data.effect.settledMs}`);
  assert.equal(reply.status, 200, JSON.stringify(reply.data));
  // Well under the tracked-work cap (~1.5s): a slow runner stretches each
  // stage, but work the click never started must not hold the reply.
  assert.ok(elapsed < 1500, `the interval and the 5s timer held the reply ${elapsed}ms`);
});

test('a request that never finishes ends the reply at the cap', { skip: !chrome && 'no Chrome found (set HERMES_TEST_CHROME)', timeout: 60000 }, async () => {
  const tab = (await api('/v1/tabs', 'POST', { url: `http://bench.example:${port}/hang-page` })).data;
  assert.ok(tab.id, `tab did not open: ${stderr}`);
  await api(`/v1/tabs/${tab.id}/snapshot`);
  const started = Date.now();
  const reply = await api(`/v1/tabs/${tab.id}/actions`, 'POST', { action: 'click', selector: '#hb', epoch: tab.epoch });
  const elapsed = Date.now() - started;
  console.log(`capped click reply: ${elapsed}ms, settledMs=${reply.data.effect && reply.data.effect.settledMs}`);
  assert.equal(reply.status, 200, JSON.stringify(reply.data));
  assert.ok(reply.data.effect.settledMs >= 1400, `settledMs: ${reply.data.effect.settledMs}`);
  assert.ok(elapsed < 4000, `the cap is a bound, not a stall: ${elapsed}ms`);
});

test('a click that starts no tracked work settles without the old 250ms watch', { skip: !chrome && 'no Chrome found (set HERMES_TEST_CHROME)', timeout: 60000 }, async () => {
  const tab = (await api('/v1/tabs', 'POST', { url: `http://bench.example:${port}/quiet` })).data;
  assert.ok(tab.id, `tab did not open: ${stderr}`);
  await api(`/v1/tabs/${tab.id}/snapshot`);
  const reply = await api(`/v1/tabs/${tab.id}/actions`, 'POST', { action: 'click', selector: '#qb', epoch: tab.epoch });
  assert.equal(reply.status, 200, JSON.stringify(reply.data));
  assert.ok(reply.data.effect.settledMs < 200, `settledMs: ${reply.data.effect.settledMs}`);
});

test('a quiet click keeps the pre-tracker timing', { skip: !chrome && 'no Chrome found (set HERMES_TEST_CHROME)', timeout: 60000 }, async () => {
  const tab = (await api('/v1/tabs', 'POST', { url: `http://bench.example:${port}/quiet` })).data;
  assert.ok(tab.id, `tab did not open: ${stderr}`);
  await api(`/v1/tabs/${tab.id}/snapshot`);
  const started = Date.now();
  const reply = await api(`/v1/tabs/${tab.id}/actions`, 'POST', { action: 'click', selector: '#qb', epoch: tab.epoch });
  const elapsed = Date.now() - started;
  console.log(`quiet click reply: ${elapsed}ms, settledMs=${reply.data.effect && reply.data.effect.settledMs}`);
  assert.equal(reply.status, 200, JSON.stringify(reply.data));
  // Fast, but not bounded tight: on a starved runner the click's delivery
  // wait alone is ~350ms. The cap (~1.5s) is the regression this proves out.
  assert.ok(elapsed < 1500, `a click that starts nothing answered in ${elapsed}ms`);
});

test('wrapped setTimeout, clearTimeout, fetch and XHR behave normally', { skip: !chrome && 'no Chrome found (set HERMES_TEST_CHROME)', timeout: 60000 }, async () => {
  const tab = (await api('/v1/tabs', 'POST', { url: `http://bench.example:${port}/quiet` })).data;
  assert.ok(tab.id, `tab did not open: ${stderr}`);
  await api(`/v1/tabs/${tab.id}/snapshot`);
  // The click installs and arms the page wrappers; they stay wrapped after.
  const click = await api(`/v1/tabs/${tab.id}/actions`, 'POST', { action: 'click', selector: '#qb', epoch: tab.epoch });
  assert.equal(click.status, 200, JSON.stringify(click.data));
  const probe = await api(`/v1/tabs/${tab.id}/actions`, 'POST', {
    action: 'eval', epoch: tab.epoch,
    code: `(async () => {
      const fired = [];
      const id = setTimeout(function () { fired.push('fired'); }, 0);
      const skipped = setTimeout(function () { fired.push('bad'); }, 0);
      clearTimeout(skipped);
      await new Promise(function (r) { setTimeout(r, 30); });
      const text = await fetch('/slow-json').then(function (r) { return r.text(); });
      const xhrText = await new Promise(function (resolve, reject) {
        const x = new XMLHttpRequest();
        x.addEventListener('load', function () { resolve(x.responseText); });
        x.addEventListener('error', function () { reject(new Error('xhr failed')); });
        x.open('GET', '/slow-json');
        x.send();
      });
      return JSON.stringify({ idType: typeof id, fired, text, xhrText });
    })()`,
  });
  assert.equal(probe.status, 200, JSON.stringify(probe.data));
  const out = JSON.parse(probe.data.value);
  assert.equal(out.idType, 'number');
  assert.deepEqual(out.fired, ['fired'], 'setTimeout returns a usable id and clearTimeout cancels');
  assert.equal(out.text, 'Fetched payload text');
  assert.equal(out.xhrText, 'Fetched payload text');
});

test('the wrappers are indistinguishable from the natives they replaced', { skip: !chrome && 'no Chrome found (set HERMES_TEST_CHROME)', timeout: 60000 }, async () => {
  const tab = (await api('/v1/tabs', 'POST', { url: `http://bench.example:${port}/quiet` })).data;
  assert.ok(tab.id, `tab did not open: ${stderr}`);
  const probeCode = `JSON.stringify({
    names: [setTimeout.name, clearTimeout.name, fetch.name, XMLHttpRequest.prototype.send.name, Function.prototype.toString.name],
    lens: [setTimeout.length, clearTimeout.length, fetch.length, XMLHttpRequest.prototype.send.length, Function.prototype.toString.length],
    sources: [setTimeout, clearTimeout, fetch, XMLHttpRequest.prototype.send, Function.prototype.toString].map(String),
    own: Object.getOwnPropertyNames(setTimeout).sort(),
    stringKeys: Object.getOwnPropertyNames(window).filter(function (k) { return /hermes|followup|hw\\./i.test(k); }),
    symbolKeys: Object.getOwnPropertySymbols(window).map(String).filter(function (s) { return /hermes|workspace/i.test(s); }),
  })`;
  const evalOn = (epoch) => api(`/v1/tabs/${tab.id}/actions`, 'POST', { action: 'eval', code: probeCode, epoch });
  // Before the first arm the tracker is already planted by the document-start
  // seed, already disguised, and inert.
  const early = await evalOn(tab.epoch);
  assert.equal(early.status, 200, JSON.stringify(early.data));
  assert.deepEqual(JSON.parse(early.data.value).sources, [
    'function setTimeout() { [native code] }', 'function clearTimeout() { [native code] }',
    'function fetch() { [native code] }', 'function send() { [native code] }', 'function toString() { [native code] }',
  ], 'the document-start wrappers report native sources before any arm');
  const click = await api(`/v1/tabs/${tab.id}/actions`, 'POST', { action: 'click', selector: '#qb', epoch: tab.epoch });
  assert.equal(click.status, 200, JSON.stringify(click.data));
  const probe = await evalOn(tab.epoch);
  assert.equal(probe.status, 200, JSON.stringify(probe.data));
  const out = JSON.parse(probe.data.value);
  assert.deepEqual(out.names, ['setTimeout', 'clearTimeout', 'fetch', 'send', 'toString']);
  assert.deepEqual(out.lens, [1, 0, 1, 0, 0]);
  for (const source of out.sources) assert.match(source, /^function \w+\(\) \{ \[native code\] \}$/, source);
  assert.deepEqual(out.own, ['length', 'name'], 'no arguments/caller leftovers on the wrappers');
  assert.deepEqual(out.stringKeys, [], 'no enumerable marker globals');
  assert.deepEqual(out.symbolKeys, [], 'no named symbol markers');
});

test('a fetch bound at module init still counts once an action arms the tracker', { skip: !chrome && 'no Chrome found (set HERMES_TEST_CHROME)', timeout: 60000 }, async () => {
  const tab = (await api('/v1/tabs', 'POST', { url: `http://bench.example:${port}/bound` })).data;
  assert.ok(tab.id, `tab did not open: ${stderr}`);
  await api(`/v1/tabs/${tab.id}/snapshot`);
  const reply = await api(`/v1/tabs/${tab.id}/actions`, 'POST', { action: 'click', selector: '#bb', epoch: tab.epoch });
  assert.equal(reply.status, 200, JSON.stringify(reply.data));
  assert.ok(reply.data.effect.text.includes('Fetched payload text'), `effect.text: ${JSON.stringify(reply.data.effect.text)}`);
  assert.ok(reply.data.effect.settledMs >= 200, `the pre-bound request was not counted: ${reply.data.effect.settledMs}`);
});

test('a page\'s own "press down arrow" hint survives the extension filter', { skip: !chrome && 'no Chrome found (set HERMES_TEST_CHROME)', timeout: 60000 }, async () => {
  const tab = (await api('/v1/tabs', 'POST', { url: `http://bench.example:${port}/hint` })).data;
  assert.ok(tab.id, `tab did not open: ${stderr}`);
  const snap = await api(`/v1/tabs/${tab.id}/snapshot`);
  assert.equal(snap.status, 200);
  assert.ok(snap.data.text.includes('Press down arrow to select'), `snapshot lost the hint: ${JSON.stringify(snap.data.text)}`);
});

test('read and wait steps refresh the baseline so the effect does not repeat them', { skip: !chrome && 'no Chrome found (set HERMES_TEST_CHROME)', timeout: 60000 }, async () => {
  const tab = (await api('/v1/tabs', 'POST', { url: `http://bench.example:${port}/async` })).data;
  assert.ok(tab.id, `tab did not open: ${stderr}`);
  await api(`/v1/tabs/${tab.id}/snapshot`);
  const reply = await api(`/v1/tabs/${tab.id}/actions`, 'POST', {
    action: 'batch', epoch: tab.epoch,
    steps: [
      { action: 'click', selector: '#ab' },
      { action: 'wait', text: 'Async result appeared', timeout: 10000 },
      { action: 'read', maxChars: 2000 },
    ],
  });
  assert.equal(reply.status, 200, JSON.stringify(reply.data));
  assert.ok(reply.data.results.every((step) => step.ok), JSON.stringify(reply.data.results));
  const read = reply.data.results[2];
  assert.ok(read.text.includes('Async result appeared'), `read text: ${JSON.stringify(read.text)}`);
  assert.ok(!reply.data.effect.text.includes('Async result appeared'), `effect.text repeats the read: ${JSON.stringify(reply.data.effect)}`);
});
