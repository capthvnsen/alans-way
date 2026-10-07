// The one-turn benchmark contract: a page that mimics ten sequential tasks.
// Each task's instruction becomes visible only after the previous task is
// done, and each action call is a batch (act, wait for the next instruction,
// read) whose effect.text must already carry that instruction, so no follow-up
// snapshot is needed. Runs the real VPS host against a real headless Chromium;
// skipped when no Chrome is found (set HERMES_TEST_CHROME).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

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
// twice each. Task N's instruction and control stay hidden until task N-1
// finishes. A transient "New!" badge self-removes so one wait uses gone:true.
const tasks = [
  { instruction: 'Task 1: Click the Start button', steps: [{ action: 'click', selector: '#t1' }], next: 'Task 2:', gone: '#flash1' },
  { instruction: 'Task 2: Click the Continue link', steps: [{ action: 'click', selector: '#t2' }], next: 'Task 3:' },
  { instruction: 'Task 3: Check the Agree checkbox', steps: [{ action: 'click', selector: '#t3' }], next: 'Task 4:' },
  { instruction: 'Task 4: Choose Banana in the fruit select', steps: [{ action: 'select', selector: '#t4', text: 'Banana' }], next: 'Task 5:' },
  { instruction: 'Task 5: Type a word and send the form', steps: [{ action: 'type', selector: '#t5in', text: 'hello' }, { action: 'click', selector: '#t5go' }], next: 'Task 6:' },
  { instruction: 'Task 6: Click the Finish button', steps: [{ action: 'click', selector: '#t6' }], next: 'Task 7:' },
  { instruction: 'Task 7: Click the Proceed link', steps: [{ action: 'click', selector: '#t7' }], next: 'Task 8:' },
  { instruction: 'Task 8: Check the Confirm checkbox', steps: [{ action: 'click', selector: '#t8' }], next: 'Task 9:' },
  { instruction: 'Task 9: Choose Cherry in the dessert select', steps: [{ action: 'select', selector: '#t9', choice: 'Cherry' }], next: 'Task 10:' },
  { instruction: 'Task 10: Type a word and send the second form', steps: [{ action: 'type', selector: '#t10in', text: 'done' }, { action: 'click', selector: '#t10go' }], next: 'All 10 tasks done' },
];
const sections = [
  `<div id="task1"><p>Task 1: Click the Start button</p><button id="t1" onclick="advance(1)">Start</button></div>`,
  `<div id="task2" class="hidden"><p>Task 2: Click the Continue link <span id="flash1">New!</span></p><a id="t2" href="#" onclick="advance(2);return false">Continue</a></div>`,
  `<div id="task3" class="hidden"><p>Task 3: Check the Agree checkbox</p><label><input id="t3" type="checkbox" onchange="advance(3)"> Agree</label></div>`,
  `<div id="task4" class="hidden"><p>Task 4: Choose Banana in the fruit select</p><select id="t4" onchange="advance(4)"><option value="">Pick a fruit</option><option value="a">Apple</option><option value="b">Banana</option><option value="c">Cherry</option></select></div>`,
  `<div id="task5" class="hidden"><p>Task 5: Type a word and send the form</p><form onsubmit="advance(5);return false"><input id="t5in"><button id="t5go" type="submit">Send</button></form></div>`,
  `<div id="task6" class="hidden"><p>Task 6: Click the Finish button</p><button id="t6" onclick="advance(6)">Finish</button></div>`,
  `<div id="task7" class="hidden"><p>Task 7: Click the Proceed link</p><a id="t7" href="#" onclick="advance(7);return false">Proceed</a></div>`,
  `<div id="task8" class="hidden"><p>Task 8: Check the Confirm checkbox</p><label><input id="t8" type="checkbox" onchange="advance(8)"> Confirm</label></div>`,
  `<div id="task9" class="hidden"><p>Task 9: Choose Cherry in the dessert select</p><select id="t9" onchange="advance(9)"><option value="">Pick a dessert</option><option value="p">Pie</option><option value="c">Cake</option><option value="ch">Cherry</option></select></div>`,
  `<div id="task10" class="hidden"><p>Task 10: Type a word and send the second form</p><form onsubmit="advance(10);return false"><input id="t10in"><button id="t10go" type="submit">Send</button></form></div>`,
  `<div id="done" class="hidden"><p>All 10 tasks done</p></div>`,
];
const benchPage = `<!doctype html><title>bench</title><style>.hidden{display:none}</style>
${sections.join('\n')}
<script>
function advance(done) {
  var next = document.getElementById(done === 10 ? 'done' : 'task' + (done + 1));
  next.classList.remove('hidden');
  var flash = document.getElementById('flash1');
  if (flash) setTimeout(function () { flash.remove(); }, 400);
}
</script>`;

let dir, profile, browser, host, site, port, connection, stderr = '';
const api = (route, method = 'GET', body, epoch) =>
  fetch(connection.url + route, {
    method,
    headers: { Authorization: `Bearer ${connection.token}`, 'X-Hermes-Bot': 'bench-bot', 'X-Control-Epoch': String(epoch ?? ''), 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, data: await r.json() }));

before(async () => {
  if (!chrome) return;
  site = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(benchPage); });
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
  port = site.address().port;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-bench-'));
  profile = path.join(dir, 'profile');
  browser = spawn(chrome, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-sandbox',
    '--host-resolver-rules=MAP bench.example 127.0.0.1', 'about:blank'], { stdio: 'ignore' });
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await wait(100);
  const cdpPort = fs.readFileSync(portFile, 'utf8').split('\n')[0];
  const data = path.join(dir, 'data');
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ cdpUrl: `http://127.0.0.1:${cdpPort}`, port: await new Promise((r) => { const p = http.createServer(); p.listen(0, '127.0.0.1', () => { const n = p.address().port; p.close(() => r(n)); }); }) }));
  const env = { ...process.env, HERMES_VPS_BROWSER_DATA: data };
  delete env.HERMES_WORKSPACE_ALLOW_LOOPBACK;
  host = spawn(process.execPath, [path.join(__dirname, '../scripts/vps-browser-host.cjs'), 'serve'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  host.stderr.on('data', (c) => { stderr += c; });
  for (let i = 0; i < 100 && !fs.existsSync(path.join(data, 'connection.json')); i++) await wait(100);
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
  let calls = 0;
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const steps = [
      ...task.steps,
      task.gone ? { action: 'wait', selector: task.gone, gone: true, timeout: 10000 } : { action: 'wait', text: task.next, timeout: 10000 },
      { action: 'read' },
    ];
    const reply = await api(`/v1/tabs/${tab.id}/actions`, 'POST', { action: 'batch', epoch: tab.epoch, steps });
    calls++;
    assert.equal(reply.status, 200, `task ${i + 1} call failed: ${JSON.stringify(reply.data)}\n${stderr}`);
    assert.ok(reply.data.results.every((step) => step.ok), `task ${i + 1} step failed: ${JSON.stringify(reply.data.results)}`);
    assert.ok(reply.data.effect, `task ${i + 1} reply carries no effect`);
    assert.equal(reply.data.effect.changed, true, `task ${i + 1} changed nothing`);
    assert.ok(reply.data.effect.text.includes(task.next), `task ${i + 1} effect.text lacks ${JSON.stringify(task.next)}: ${JSON.stringify(reply.data.effect)}`);
    const read = reply.data.results[steps.length - 1];
    assert.ok(read.text.includes(task.next), `task ${i + 1} read lacks ${JSON.stringify(task.next)}`);
    if (i === 0) {
      assert.equal(reply.data.effect.navigated, false);
      assert.equal(reply.data.effect.url, `http://bench.example:${port}/bench`);
      assert.equal(reply.data.effect.title, 'bench');
      assert.ok(reply.data.results[1].waited >= 0, 'the gone wait reports its time');
    }
    if (i === 3 || i === 8) assert.match(reply.data.results[0].matched.by, /label/, `task ${i + 1} select matched by label`);
  }
  assert.equal(calls, 10, 'one action call per task');
});
