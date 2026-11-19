// Declarative batch control flow: wait for a control by name, if, repeat.
// The first half tests the planner with fakes; the second runs the real VPS
// host against headless Chromium (skipped when no Chrome is found, set
// HERMES_TEST_CHROME).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const flow = require('../src/batch-flow.cjs');
const { startStack, findChrome } = require('../eval/runtime.cjs');

const ctx = (budgetMs = 5000) => flow.context(budgetMs);
const leafOf = (log, fail) => async (step) => { log.push(step.action + (step.text ? ':' + step.text : '')); if (fail && fail(step)) throw new Error('boom ' + step.action); return { dispatched: true }; };
const rejects = (step, rx) => assert.throws(() => flow.validate(step), (e) => e.status === 400 && rx.test(e.message));

test('validate: if and repeat shapes are checked before anything runs', () => {
  rejects({ action: 'if', then: [] }, /needs when/);
  rejects({ action: 'if', when: {}, then: [] }, /selector, text, url or name/);
  rejects({ action: 'if', when: { selector: '#a' } }, /then must be an array/);
  rejects({ action: 'if', when: { selector: '#a' }, then: [{ action: 'if', when: { text: 'x' }, then: [] }] }, /cannot nest/);
  rejects({ action: 'if', when: { selector: '#a' }, then: [{ action: 'batch', steps: [] }] }, /cannot nest/);
  rejects({ action: 'if', when: { selector: '#a' }, then: Array(11).fill({ action: 'read' }) }, /at most 10/);
  rejects({ action: 'if', when: { selector: '#a' }, then: ['x'] }, /each step needs an action/);
  rejects({ action: 'repeat', steps: [{ action: 'scroll', y: 500 }] }, /needs until/);
  rejects({ action: 'repeat', until: { text: 'x' }, steps: [] }, /1 to 10 steps/);
  rejects({ action: 'repeat', until: { text: 'x' }, steps: [{ action: 'scroll' }], max: 21 }, /max must be 1 to 20/);
  rejects({ action: 'repeat', until: { text: 'x' }, steps: [{ action: 'scroll' }], max: 0 }, /max must be 1 to 20/);
  rejects({ action: 'repeat', until: { text: 'x' }, steps: [{ action: 'scroll' }], max: 2.5 }, /max must be 1 to 20/);
  rejects({ action: 'if', when: { selector: 7 }, then: [] }, /selector, text, url or name/);
  rejects({ action: 'if', when: { text: 'x'.repeat(2001) }, then: [] }, /at most 2000/);
  flow.validate({ action: 'if', when: { name: 'Close', role: 'button' }, then: [{ action: 'click', name: 'Close' }], else: [] });
  flow.validate({ action: 'repeat', until: { text: 'x' }, steps: [{ action: 'scroll', y: 800 }], max: 20 });
});

test('if runs one branch and reports which', async () => {
  for (const [hit, branch, want] of [[true, 'then', ['click:a']], [false, 'else', ['click:b']]]) {
    const log = [];
    const r = await flow.run({ action: 'if', when: { selector: '#x' }, then: [{ action: 'click', text: 'a' }], else: [{ action: 'click', text: 'b' }] }, { ctx: ctx(), leaf: leafOf(log), test: async () => hit });
    assert.equal(r.branch, branch); assert.deepEqual(log, want); assert.equal(r.results.length, 1);
  }
  const log = [];
  const none = await flow.run({ action: 'if', when: { selector: '#x' }, then: [{ action: 'click' }] }, { ctx: ctx(), leaf: leafOf(log), test: async () => false });
  assert.deepEqual(none, { branch: 'none', results: [] }); assert.deepEqual(log, []);
});

test('if: a failing inner step stops the branch and keeps the results so far', async () => {
  const log = [];
  await assert.rejects(
    flow.run({ action: 'if', when: { selector: '#x' }, then: [{ action: 'click', text: 'a' }, { action: 'click', text: 'b' }, { action: 'click', text: 'c' }] },
      { ctx: ctx(), leaf: leafOf(log, (s) => s.text === 'b'), test: async () => true }),
    (e) => /boom/.test(e.message) && e.flowResults.length === 2 && e.flowResults[0].ok === true && e.flowResults[1].ok === false);
  assert.deepEqual(log, ['click:a', 'click:b']);
});

test('repeat: runs until the condition holds, checks first, reports rounds and the last round only', async () => {
  let n = 0;
  const log = [];
  const r = await flow.run({ action: 'repeat', until: { text: 'done' }, steps: [{ action: 'scroll', text: 's' }], max: 5 }, { ctx: ctx(), leaf: leafOf(log), test: async () => ++n > 3, settleMs: 0 });
  assert.equal(r.iterations, 3); assert.equal(log.length, 3); assert.equal(r.results.length, 1);
  const again = await flow.run({ action: 'repeat', until: { text: 'done' }, steps: [{ action: 'scroll' }] }, { ctx: ctx(), leaf: leafOf(log), test: async () => true });
  assert.equal(again.iterations, 0); assert.equal(log.length, 3);
});

test('repeat: max rounds bound the loop and an unmet condition is an error', async () => {
  const log = [];
  await assert.rejects(
    flow.run({ action: 'repeat', until: { text: 'never' }, steps: [{ action: 'scroll' }, { action: 'read' }], max: 3 }, { ctx: ctx(), leaf: leafOf(log), test: async () => false, settleMs: 0 }),
    (e) => /not met after 3 rounds/.test(e.message) && Array.isArray(e.flowResults));
  assert.equal(log.length, 6);
});

test('the whole batch shares one step budget and one deadline', async () => {
  const c = ctx();
  const log = [];
  await assert.rejects(
    flow.run({ action: 'repeat', until: { text: 'never' }, steps: Array(10).fill({ action: 'scroll' }), max: 20 }, { ctx: c, leaf: leafOf(log), test: async () => false, settleMs: 0 }),
    /more than 60 steps/);
  assert.equal(log.length, 60);
  const late = flow.context(1, () => 1000000);
  late.started = 0;
  await assert.rejects(flow.run({ action: 'if', when: { text: 'x' }, then: [{ action: 'read' }] }, { ctx: late, leaf: leafOf([]), test: async () => true }), /time budget/);
});

test('cancellation: the host hook runs before every inner step', async () => {
  let calls = 0;
  await assert.rejects(
    flow.run({ action: 'repeat', until: { text: 'x' }, steps: [{ action: 'scroll' }], max: 9 }, { ctx: ctx(), leaf: leafOf([]), test: async () => false, settleMs: 0, before: () => { if (++calls > 2) throw new Error('Call cancelled'); } }),
    /Call cancelled/);
  assert.equal(calls, 3);
});

test('conditionExpression is data only: values are JSON-quoted, never spliced as code', () => {
  const evil = '";alert(1);//';
  const code = flow.conditionExpression({ selector: evil, text: evil, url: evil, name: evil, role: evil, row: evil }, 0);
  for (const piece of [evil]) assert.ok(code.includes(JSON.stringify(piece)));
  assert.ok(!code.includes(`= ${evil}`));
  assert.doesNotThrow(() => new Function(`return ${code}`));
});

test('hasInput: a flow step counts as input when any inner step is one', () => {
  const input = new Set(['click', 'type']);
  assert.equal(flow.hasInput({ action: 'if', when: { text: 'x' }, then: [{ action: 'read' }], else: [{ action: 'click' }] }, input), true);
  assert.equal(flow.hasInput({ action: 'repeat', until: { text: 'x' }, steps: [{ action: 'read' }] }, input), false);
});

test('waitFor polls a probe until it holds and fails with a message that names the control', async () => {
  let n = 0;
  const found = await flow.waitFor({ name: 'Seats' }, { test: async () => ++n > 2, timeoutMs: 2000, pollMs: 5 });
  assert.equal(found.found, true); assert.equal(n, 3);
  await assert.rejects(flow.waitFor({ name: 'Seats', role: 'textbox' }, { test: async () => false, timeoutMs: 40, pollMs: 5 }),
    (e) => e.status === 408 && /wait timed out after \d+ms for a control named "Seats" with role textbox/.test(e.message));
  await assert.rejects(flow.waitFor({ name: 'Gone', gone: true }, { test: async () => false, timeoutMs: 30, pollMs: 5 }), /absence of a control named "Gone"/);
  await assert.rejects(flow.waitFor({ name: 'x' }, { test: async () => false, timeoutMs: 1000, pollMs: 5, aborted: () => true }), (e) => e.status === 499);
});

// ---- real host ----

const chrome = findChrome();
let stack, site, port, T;
const PAGES = {
  '/late': '<title>late</title><div id=host></div><script>setTimeout(()=>{host.innerHTML=\'<label>Seats <input id=s></label><button id=n>Next</button>\'},700)</script>',
  '/promo': '<title>promo</title><div id=promo role=dialog aria-label="Promo"><button id=x onclick="promo.remove()">No thanks</button></div><button id=t onclick="out.textContent=\'toggled\'">Toggle</button><p id=out>idle</p>',
  '/nopromo': '<title>nopromo</title><button id=t onclick="out.textContent=\'toggled\'">Toggle</button><p id=out>idle</p>',
  '/scroll': '<title>scroll</title><style>body{margin:0}</style><ul id=l></ul><script>let n=0;function more(){for(let i=0;i<20;i++){const li=document.createElement("li");li.style.height="40px";li.textContent="Row "+(++n);l.appendChild(li)}}more();addEventListener("scroll",()=>{if(innerHeight+scrollY>=document.body.scrollHeight-50&&n<200)setTimeout(more,100)})</script>',
  '/gate': '<title>gate</title><button id=ok onclick="out.textContent=\'safe\'">Show</button><button id=buy onclick="out.textContent=\'ordered\'">Place order</button><p id=out>idle</p>',
};
before(async () => {
  if (!chrome) return;
  site = http.createServer((req, res) => { const body = PAGES[req.url.split('?')[0]]; res.setHeader('content-type', 'text/html'); res.statusCode = body ? 200 : 404; res.end(body || 'no'); });
  port = await new Promise((r) => site.listen(0, '127.0.0.1', () => r(site.address().port)));
  stack = await startStack({});
  T = `http://fixture.example:${port}`;
});
after(async () => { site?.close(); await stack?.stop(); });

async function openTab(path) {
  const t = await stack.raw('/v1/tabs', 'POST', { url: T + path });
  const act = (body) => stack.raw(`/v1/tabs/${t.id}/actions`, 'POST', { epoch: t.epoch, ...body });
  const text = async () => (await stack.raw(`/v1/tabs/${t.id}/snapshot`)).text;
  return { t, act, text, close: () => stack.raw(`/v1/tabs/${t.id}`, 'DELETE', undefined, t.epoch).catch(() => {}) };
}
const real = { skip: !chrome, timeout: 60000 };

test('host: wait for a control by name appears late, in one batch with the click that needs it', real, async () => {
  const tab = await openTab('/late');
  try {
    const r = await tab.act({ action: 'batch', steps: [{ action: 'wait', name: 'Seats', role: 'textbox', timeout: 5000 }, { action: 'type', name: 'Seats', text: '12' }, { action: 'click', name: 'Next' }] });
    assert.deepEqual(r.results.map((x) => x.ok), [true, true, true], JSON.stringify(r));
    assert.ok(r.results[0].waited >= 300, 'it really waited for the late control');
    const miss = await tab.act({ action: 'wait', name: 'No such control', timeout: 300 });
    assert.match(miss.error, /wait timed out after \d+ms for a control named "No such control"/);
    const gone = await tab.act({ action: 'wait', name: 'Seats', gone: true, timeout: 300 });
    assert.match(gone.error, /absence of a control named "Seats"/);
  } finally { await tab.close(); }
});

test('host: if closes a promo only when it is there', real, async () => {
  const steps = [{ action: 'if', when: { selector: '#promo' }, then: [{ action: 'click', name: 'No thanks' }] }, { action: 'click', name: 'Toggle' }, { action: 'read' }];
  for (const [path, branch] of [['/promo', 'then'], ['/nopromo', 'none']]) {
    const tab = await openTab(path);
    try {
      const r = await tab.act({ action: 'batch', steps });
      assert.equal(r.results[0].branch, branch, JSON.stringify(r));
      assert.equal(r.results[0].results.length, branch === 'then' ? 1 : 0);
      assert.match(r.results[2].text, /toggled/);
    } finally { await tab.close(); }
  }
});

test('host: repeat scrolls until the row exists, bounded by max', real, async () => {
  const tab = await openTab('/scroll');
  try {
    const r = await tab.act({ action: 'batch', steps: [{ action: 'repeat', until: { text: 'Row 61' }, steps: [{ action: 'scroll', y: 4000 }], max: 8 }, { action: 'read', list: { selector: 'li:nth-child(61)', fields: { t: { type: 'text' } } } }] });
    assert.equal(r.results[0].ok, true, JSON.stringify(r));
    assert.ok(r.results[0].iterations >= 1 && r.results[0].iterations <= 8);
    assert.equal(r.results[1].items[0].t, 'Row 61');
    const never = await tab.act({ action: 'batch', steps: [{ action: 'repeat', until: { text: 'Row 9999' }, steps: [{ action: 'scroll', y: 100 }], max: 2 }, { action: 'read' }] });
    assert.equal(never.results.length, 1, 'the batch stops at the failed repeat');
    assert.match(never.results[0].error, /not met after 2 rounds/);
    assert.equal(never.results[0].results.length, 1);
  } finally { await tab.close(); }
});

test('host: every inner step passes the same commit gate as a single action', real, async () => {
  const tab = await openTab('/gate');
  try {
    const single = await tab.act({ action: 'click', name: 'Place order' });
    assert.match(single.error, /commit_required/);
    const viaIf = await tab.act({ action: 'batch', steps: [{ action: 'if', when: { text: 'idle' }, then: [{ action: 'click', name: 'Place order' }] }] });
    assert.equal(viaIf.results[0].ok, false);
    assert.match(viaIf.results[0].error, /commit_required/);
    const viaRepeat = await tab.act({ action: 'batch', steps: [{ action: 'repeat', until: { text: 'ordered' }, steps: [{ action: 'click', name: 'Place order' }], max: 3 }] });
    assert.match(viaRepeat.results[0].error, /commit_required/);
    assert.equal(await tab.text(), 'Show Place order\nidle');
  } finally { await tab.close(); }
});

test('host: an approval for one step does not reach inner steps of a flow step', real, async () => {
  const tab = await openTab('/gate');
  try {
    const { harnessApproval, bindApproval } = require('./approval-fixture.cjs');
    const snap = await stack.raw(`/v1/tabs/${tab.t.id}/snapshot`);
    const body = { tabId: tab.t.id, epoch: tab.t.epoch, action: 'batch', steps: [
      { action: 'click', name: 'Show' },
      { action: 'if', when: { text: 'safe' }, then: [{ action: 'click', name: 'Place order' }] },
    ], approval: harnessApproval(tab.t) };
    bindApproval(body, snap);
    const r = await stack.raw(`/v1/tabs/${tab.t.id}/actions`, 'POST', body);
    assert.equal(r.results[0].ok, true, JSON.stringify(r));
    assert.equal(r.results[1].ok, false);
    assert.match(r.results[1].error, /commit_required|approval_invalid/);
    assert.match(await tab.text(), /safe/);
    assert.doesNotMatch(await tab.text(), /ordered/);
  } finally { await tab.close(); }
});

test('host: malformed flow steps are refused with 400 before any step runs', real, async () => {
  const tab = await openTab('/nopromo');
  try {
    for (const steps of [
      [{ action: 'click', name: 'Toggle' }, { action: 'repeat', steps: [{ action: 'scroll' }] }],
      [{ action: 'click', name: 'Toggle' }, { action: 'if', when: { selector: '#t' }, then: [{ action: 'if', when: { selector: '#t' }, then: [] }] }],
      [{ action: 'repeat', until: { text: 'x' }, steps: [{ action: 'scroll' }], max: 99 }],
    ]) {
      const r = await tab.act({ action: 'batch', steps });
      assert.ok(r.error && !r.results, JSON.stringify(r));
    }
    assert.match(await tab.text(), /idle/, 'the click before the bad step never ran');
    const top = await tab.act({ action: 'if', when: { selector: '#t' }, then: [] });
    assert.match(top.error, /inside a batch/);
  } finally { await tab.close(); }
});
