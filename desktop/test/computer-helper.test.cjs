const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { createHelper, createComputer, createComputerService, normalizeStep, normalizeKey, binaryCurrent, recordBuild } = require('../src/computer-helper.cjs');
const { pickHelper, makeCompile } = require('../src/computer.cjs');
const { createMacPermissionHelp } = require('../src/mac-permissions.cjs');

function permissionComputer(t, handle) {
  const { EventEmitter } = require('node:events');
  const { PassThrough } = require('node:stream');
  const children = [];
  t.mock.method(require('node:child_process'), 'spawn', () => {
    const proc = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      unref() {}, kill() { this.emit('close', 1); },
    });
    proc.stdin.on('data', (chunk) => queueMicrotask(() => {
      const request = JSON.parse(chunk);
      const reply = request.cmd === 'init' ? { ok: true } : handle(request, proc);
      if (reply) proc.stdout.write(JSON.stringify({ id: request.id, ...reply }) + '\n');
    }));
    children.push(proc);
    return proc;
  });
  const setTimer = global.setTimeout;
  t.mock.method(global, 'setTimeout', (callback, ms, ...args) => ms === 150
    ? setTimer(() => { t.mock.timers.tick(ms); callback(...args); }, 0)
    : setTimer(callback, ms, ...args));
  // Reload to capture only the fake process transport; all helper logic stays real.
  const filename = require.resolve('../src/computer-helper.cjs');
  const cached = require.cache[filename];
  let computer;
  try {
    delete require.cache[filename];
    computer = require(filename).createComputer({ command: async () => ['fixture'] });
  } finally { require.cache[filename] = cached; }
  t.after(() => computer.close());
  return { ...computer, children };
}

for (const grantedAt of [34999, 35001, 59000]) test(`read permission budget survives a real helper crash-retry or explains a late grant (${grantedAt} ms)`, async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  let requests = 0;
  const computer = permissionComputer(t, (_request, proc) => {
    requests++;
    if (requests === 1) return { ok: false, code: 'permission', error: 'Accessibility is off.' };
    t.mock.timers.tick(19999);
    if (requests === 2) { proc.emit('close', 1); return; }
    return { ok: true, generation: 1, elements: [] };
  });
  const service = createMacPermissionHelp({
    platform: 'darwin',
    systemPreferences: { isTrustedAccessibilityClient: () => Date.now() >= grantedAt },
    sleep: async (ms) => t.mock.timers.tick(ms),
  }).wrap(computer.service);
  if (grantedAt < 35000) {
    assert.equal((await service.snapshot('bot', 7)).generation, 1);
    assert.equal(Date.now(), 74998);
    assert.equal(requests, 3);
    assert.equal(computer.children.length, 2);
  } else {
    await assert.rejects(service.snapshot('bot', 7), { code: 'permission', message: /Accessibility is off for alans-way-localapp/ });
    assert.equal(Date.now(), 35000);
    assert.equal(requests, 1);
  }
  assert.ok(Date.now() < 80000, 'ordinary calls must finish before the router deadline');
});

test('action permission recovery leaves room for the real batch budget and a final wait crash-retry', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  let requests = 0;
  const computer = permissionComputer(t, (request, proc) => {
    requests++;
    if (requests === 1) return { ok: false, code: 'permission', error: 'Accessibility is off.' };
    t.mock.timers.tick(({ 2: 19000, 3: 14800, 4: 11049, 5: 19999, 6: 19999 })[requests]);
    if (requests === 5) { proc.emit('close', 1); return; }
    return { ok: true, generation: 1,
      ...(request.cmd === 'act' ? { results: request.steps.map(() => ({ ok: true })) } : {}),
      elements: [{ ref: 'c1', role: 'AXStaticText', name: requests === 3 ? 'Ready' : requests === 6 ? 'Finished' : 'Loading' }],
    };
  });
  const service = createMacPermissionHelp({
    platform: 'darwin',
    systemPreferences: { isTrustedAccessibilityClient: () => Date.now() >= 3999 },
    sleep: async (ms) => t.mock.timers.tick(ms),
  }).wrap(computer.service);
  const reply = await service.action('bot', 7, { action: 'batch', steps: [
    { action: 'click', x: 1, y: 2 }, { action: 'wait', text: 'Ready', timeout: 15000 },
    { action: 'click', x: 1, y: 2 }, { action: 'wait', text: 'Finished', timeout: 15000 },
  ] });
  assert.equal(reply.results.length, 4);
  assert.ok(reply.results.every((result) => result.ok));
  assert.equal(requests, 6);
  assert.equal(computer.children.length, 2);
  assert.equal(Date.now(), 89147);
  assert.ok(Date.now() < 90000 && Date.now() < 100000);
});

const fake = path.join(__dirname, 'computer-fake-helper.cjs');
const fakeHelper = (mode, extra = {}) => createHelper({
  command: async (kind) => [process.execPath, fake, kind], env: { ...process.env, FAKE_MODE: mode }, ...extra,
});
const fakeComputer = (mode) => createComputer({ command: async (kind) => [process.execPath, fake, kind], env: { ...process.env, FAKE_MODE: mode } });

test('one helper process answers every request and carries the policy', async (t) => {
  const helper = fakeHelper('ok');
  t.after(() => helper.close());
  const first = await helper.request({ cmd: 'snapshot', pid: 5 });
  const second = await helper.request({ cmd: 'snapshot', pid: 5 });
  assert.equal(first.helper, second.helper, 'the same process served both');
  assert.ok(first.policy.exact.includes('com.apple.passwords'));
  assert.ok(first.policy.contains.includes('1password'));
});

test('a crashed helper is replaced on the next request', async (t) => {
  const helper = fakeHelper('ok');
  t.after(() => helper.close());
  const first = await helper.request({ cmd: 'snapshot', pid: 5 });
  process.kill(first.helper, 'SIGKILL');
  // The 'close' event that marks the child dead can lag on a loaded runner;
  // retry until the helper replaces it instead of assuming it already did.
  let second;
  for (const deadline = Date.now() + 10000;;) {
    try { second = await helper.request({ cmd: 'snapshot', pid: 5, timeoutMs: 1000 }); break; }
    catch (e) {
      if (Date.now() > deadline) throw e;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  assert.notEqual(first.helper, second.helper);
});

test('a silent helper times out, is killed, and the next request starts fresh', async (t) => {
  const env = { ...process.env, FAKE_MODE: 'hang' };
  const helper = createHelper({ command: async (kind) => [process.execPath, fake, kind], env, timeoutMs: 300 });
  t.after(() => helper.close());
  await assert.rejects(helper.request({ cmd: 'apps' }), /timed out/);
  env.FAKE_MODE = 'ok';
  env.FAKE_STARTUP_DELAY_MS = '500';
  assert.equal((await helper.request({ cmd: 'apps', timeoutMs: 10000 })).ok, true);
});

test('a helper that cannot start falls back to one process per request', async (t) => {
  const helper = fakeHelper('crash-on-serve');
  t.after(() => helper.close());
  const first = await helper.request({ cmd: 'snapshot', pid: 5 });
  assert.equal(first.generation, 7);
  assert.ok(first.policy.exact.length > 0, 'once mode carries the policy in the request');
  const second = await helper.request({ cmd: 'snapshot', pid: 5 });
  assert.notEqual(first.helper, second.helper, 'every one-shot request is its own process');
});

test('an action is never replayed when the helper dies mid-action', async (t) => {
  const helper = fakeHelper('crash-mid-act');
  t.after(() => helper.close());
  await helper.request({ cmd: 'snapshot', pid: 5 });
  await assert.rejects(helper.request({ cmd: 'act', pid: 5, steps: [{ action: 'click', x: 1, y: 2 }] }), /stopped mid-action/);
});

test('helper failures carry their code', async (t) => {
  const helper = fakeHelper('ok');
  t.after(() => helper.close());
  await assert.rejects(helper.request({ cmd: 'nope' }), (error) => error.code === 'bad_request' && /unknown command/.test(error.message));
});

test('snapshot pin is sent only when supplied', async (t) => {
  const { driver, close } = fakeComputer('ok');
  t.after(close);
  assert.equal((await driver.snapshot(5, { pin: 7 })).pin, 7);
  assert.equal('pin' in (await driver.snapshot(5)), false);
});

test('screenshot notes pass through only when supplied', async (t) => {
  const elsewhere = fakeComputer('shot-elsewhere');
  const here = fakeComputer('ok');
  t.after(() => { elsewhere.close(); here.close(); });
  assert.equal((await elsewhere.driver.screenshot(5)).note, 'Read only: elsewhere.');
  assert.equal('note' in (await here.driver.screenshot(5)), false);
});

test('key names and combos normalise to one shape', () => {
  assert.deepEqual(normalizeKey({ key: 'cmd+Shift+N' }), { action: 'key', key: 'n', modifiers: ['shift', 'meta'] });
  assert.deepEqual(normalizeKey({ key: 'Enter' }), { action: 'key', key: 'return', modifiers: [] });
  assert.deepEqual(normalizeKey({ keys: 'ctrl+a' }), { action: 'key', key: 'a', modifiers: ['control'] });
  assert.deepEqual(normalizeKey({ key: '+', modifiers: ['Option'] }), { action: 'key', key: '+', modifiers: ['alt'] });
  assert.deepEqual(normalizeKey({ key: 'X' }), { action: 'key', key: 'x', modifiers: ['shift'] });
  assert.deepEqual(normalizeKey({ key: 'cmd+X' }), { action: 'key', key: 'x', modifiers: ['shift', 'meta'] });
  assert.deepEqual(normalizeKey({ key: '1' }), { action: 'key', key: '1', modifiers: [] });
  assert.deepEqual(normalizeKey({ key: 'F5' }), { action: 'key', key: 'f5', modifiers: [] });
  assert.throws(() => normalizeKey({ key: 'hyper+x' }), /Modifiers are/);
  assert.throws(() => normalizeKey({ key: 'banana' }), /Unknown key/);
});

test('steps are validated before they reach the helper', () => {
  assert.throws(() => normalizeStep({ action: 'type', ref: 'c1', text: 'x'.repeat(2001) }), /at most 2000/);
  assert.throws(() => normalizeStep({ action: 'press' }), /needs a ref/);
  assert.throws(() => normalizeStep({ action: 'type', ref: 5, text: 'x' }), /needs a ref/);
  // Typing at the focus is only for a desktop the agent owns; elsewhere apps never take focus.
  assert.throws(() => normalizeStep({ action: 'type', text: 'hi' }), /needs a ref/);
  process.env.ALANS_WAY_AGENT_DESKTOP = '1';
  try { assert.deepEqual(normalizeStep({ action: 'type', text: 'hi' }), { action: 'type', text: 'hi' }); }
  finally { delete process.env.ALANS_WAY_AGENT_DESKTOP; }
  assert.throws(() => normalizeStep({ action: 'scroll' }), /direction/);
  assert.throws(() => normalizeStep({ action: 'menu', path: [] }), /needs a path/);
  assert.throws(() => normalizeStep({ action: 'teleport' }), /must be press/);
  assert.deepEqual(normalizeStep({ action: 'click', x: 1, y: 2 }), { action: 'click', x: 1, y: 2 });
});

test('actions that use a ref must carry the snapshot generation', async (t) => {
  const { service, close } = fakeComputer('ok');
  t.after(close);
  await assert.rejects(service.action('bot', 5, { action: 'press', ref: 'c1' }), (error) => error.code === 'stale_ref' && /^stale_ref:/.test(error.message));
  const done = await service.action('bot', 5, { action: 'press', ref: 'c1', generation: 7 });
  assert.equal(done.ok, true);
  assert.equal(done.generation, 8);
  assert.equal(done.elements[0].name, 'Done');
  await assert.rejects(service.action('bot', 5, { action: 'press', ref: 'c1', generation: 3 }), (error) => error.code === 'stale_ref');
});

test('coordinate actions need no generation, and a failed single step throws with its code', async (t) => {
  const { service, close } = fakeComputer('ok');
  t.after(close);
  assert.equal((await service.action('bot', 5, { action: 'click', x: 1, y: 2 })).ok, true);
  await assert.rejects(service.action('bot', 5, { action: 'scroll', direction: 'down' }), (error) => error.code === 'unsupported_action' && /^unsupported_action:/.test(error.message));
});

test('a batch reports per-step results and stops at the first failure', async (t) => {
  const { service, close } = fakeComputer('ok');
  t.after(close);
  const reply = await service.action('bot', 5, { action: 'batch', generation: 7, steps: [
    { action: 'press', ref: 'c1' }, { action: 'scroll', direction: 'down' }, { action: 'click', x: 1, y: 2 },
  ] });
  assert.equal(reply.results.length, 2);
  assert.equal(reply.results[0].ok, true);
  assert.deepEqual(reply.results[1], { error: 'No scroll here.', code: 'unsupported_action' });
  assert.equal(reply.generation, 8);
});

test('wait steps are validated and capped', () => {
  assert.throws(() => normalizeStep({ action: 'wait' }), /wait needs text/);
  assert.throws(() => normalizeStep({ action: 'wait', text: 'x'.repeat(201) }), /wait needs text/);
  assert.deepEqual(normalizeStep({ action: 'wait', text: 'Saved' }), { action: 'wait', text: 'Saved', gone: false, timeout: 5000 });
  assert.deepEqual(normalizeStep({ action: 'wait', text: 'Saving', gone: true, timeout: 60000 }), { action: 'wait', text: 'Saving', gone: true, timeout: 15000 });
});

test('a batch can act and then wait for what the action caused', async (t) => {
  const { service, close } = fakeComputer('ok');
  t.after(close);
  const reply = await service.action('bot', 5, { action: 'batch', generation: 7, steps: [
    { action: 'press', ref: 'c1' }, { action: 'wait', text: 'done' }, { action: 'click', x: 1, y: 2 },
  ] });
  assert.equal(reply.results.length, 3);
  assert.equal(reply.results[1].ok, true);
  assert.ok(Number.isInteger(reply.results[1].waitedMs));
  assert.equal(reply.elements[0].name, 'Done');
});

test('wait polls pin the caller generation for later runs', async () => {
  const options = [], generations = [];
  let polls = 0;
  const service = createComputerService({
    snapshot: async (_pid, value) => {
      options.push(value);
      polls++;
      return { ok: true, generation: 50 + polls, elements: [{ ref: 'c1', role: 'AXButton', name: polls < 3 ? 'Saving' : 'Saved' }] };
    },
    act: async (_pid, request) => {
      generations.push(request.generation);
      return { results: request.steps.map(() => ({ ok: true })), generation: 50, elements: [{ ref: 'c1', role: 'AXButton', name: 'Saving' }] };
    },
  });
  const reply = await service.action('bot', 5, { action: 'batch', generation: 7, steps: [
    { action: 'press', ref: 'c1' }, { action: 'wait', text: 'Saved' }, { action: 'press', ref: 'c1' },
  ] });
  assert.equal(reply.results.length, 3);
  assert.ok(reply.results.every((item) => item.ok === true));
  assert.ok(options.length >= 3);
  assert.ok(options.every((value) => value.pin === 7));
  assert.deepEqual(generations, [7, 7]);
});

test('no act run starts after the call deadline', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  let acts = 0;
  const service = createComputerService({
    snapshot: async () => assert.fail('wait should use the act tree'),
    act: async (_pid, request) => {
      acts++;
      t.mock.timers.tick(30000);
      return { results: request.steps.map(() => ({ ok: true })), generation: 50, elements: [{ ref: 'c1', role: 'AXButton', name: 'Done' }] };
    },
  });
  const reply = await service.action('bot', 5, { action: 'batch', generation: 7, steps: [
    { action: 'press', ref: 'c1' }, { action: 'wait', text: 'Done' }, { action: 'press', ref: 'c1' },
    { action: 'wait', text: 'Done' }, { action: 'press', ref: 'c1' },
  ] });
  assert.equal(acts, 2);
  assert.deepEqual(reply.results.map((item) => item.ok === true ? 'ok' : item.code), ['ok', 'ok', 'ok', 'ok', 'timeout']);
  assert.ok(reply.results.slice(0, 4).every((item) => item.ok === true));
  assert.match(reply.results[4].error, /did not run/);
  assert.equal(reply.elements[0].name, 'Done');
});

test('a wait that times out stops the batch and still reports the steps that ran', async (t) => {
  const { service, close } = fakeComputer('ok');
  t.after(close);
  const reply = await service.action('bot', 5, { action: 'batch', generation: 7, steps: [
    { action: 'press', ref: 'c1' }, { action: 'wait', text: 'Never', timeout: 300 }, { action: 'click', x: 1, y: 2 },
  ] });
  assert.equal(reply.results.length, 2);
  assert.equal(reply.results[0].ok, true);
  assert.equal(reply.results[1].code, 'timeout');
  // The wait polled the tree, which the fake answers with its snapshot.
  assert.equal(reply.elements[0].name, 'Go');
  await assert.rejects(service.action('bot', 5, { action: 'wait', text: 'Never', timeout: 200 }), (error) => error.code === 'timeout');
});

test('a run after a wait that the helper refuses is reported, not thrown, once earlier steps ran', async (t) => {
  const { service, close } = fakeComputer('ok');
  t.after(close);
  // The fake refuses the ref "gone" the way a helper refuses a control that changed.
  const reply = await service.action('bot', 5, { action: 'batch', generation: 7, steps: [
    { action: 'click', x: 1, y: 2 }, { action: 'wait', text: 'Done' }, { action: 'press', ref: 'gone' },
  ] });
  assert.deepEqual(reply.results.map((item) => !item.error), [true, true, false]);
  assert.equal(reply.results[2].code, 'stale_ref');
  assert.equal(reply.elements[0].name, 'Done');
  await assert.rejects(service.action('bot', 5, { action: 'press', ref: 'gone', generation: 7 }), (error) => error.code === 'stale_ref');
});

test('a wait whose poll fails keeps the results of the steps that ran', async (t) => {
  const { service, close } = fakeComputer('snapshot-in-front');
  t.after(close);
  const reply = await service.action('bot', 5, { action: 'batch', generation: 7, steps: [
    { action: 'press', ref: 'c1' }, { action: 'wait', text: 'Never', timeout: 2000 },
  ] });
  assert.equal(reply.results[0].ok, true);
  assert.equal(reply.results[1].code, 'in_front');
  assert.equal(reply.elements[0].name, 'Done');
});

test('a wait for text to go away is done when the app quits', async (t) => {
  const { service, close } = fakeComputer('snapshot-not-found');
  t.after(close);
  const reply = await service.action('bot', 5, { action: 'batch', generation: 7, steps: [
    { action: 'menu', path: ['File', 'Quit'] }, { action: 'wait', text: 'Done', gone: true },
  ] });
  assert.equal(reply.results[1].ok, true);
});

test('the app list leaves out off-limits apps and only marks the front one', async (t) => {
  const { service, close } = fakeComputer('ok');
  t.after(close);
  const apps = await service.apps();
  assert.deepEqual(apps.map((app) => app.name), ['X', 'Front']);
  assert.equal('frontmost' in apps[0], false);
  assert.equal(apps[1].frontmost, true);
});

test('a second bot is sent the tree even when the first bot already saw it', async (t) => {
  const { service, close } = fakeComputer('ok');
  t.after(close);
  const a = await service.action('a', 5, { action: 'click', x: 1, y: 2 });
  assert.ok(a.elements);
  const again = await service.action('a', 5, { action: 'click', x: 1, y: 2 });
  assert.equal(again.unchanged, true);
  const b = await service.action('b', 5, { action: 'click', x: 1, y: 2 });
  assert.ok(b.elements, 'bot b has never seen generation 8');
});

test('a just-activated app that is briefly not found is retried once, then explained', async (t) => {
  const helper = fakeHelper('flaky-not-found');
  t.after(() => helper.close());
  assert.equal((await helper.request({ cmd: 'snapshot', pid: 5 })).generation, 7);
  const gone = fakeHelper('always-not-found');
  t.after(() => gone.close());
  await assert.rejects(gone.request({ cmd: 'snapshot', pid: 5 }), (error) => error.code === 'not_found' && /wait a moment and retry/.test(error.message));
});

test('any command that reports a missing app is retried once and explained', async (t) => {
  const gone = fakeHelper('always-not-found');
  t.after(() => gone.close());
  await assert.rejects(gone.request({ cmd: 'menu', pid: 5, path: ['File'] }), /wait a moment and retry/);
});

test('a not_found that is not a missing app keeps its own message', async (t) => {
  const helper = fakeHelper('bad-menu');
  t.after(() => helper.close());
  await assert.rejects(helper.request({ cmd: 'menu', pid: 5, path: ['File', 'Nope'] }), (error) => error.code === 'not_found' && error.message === 'No such menu item.');
});

test('a prebuilt binary is current by source content, not by mtime', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-bin-'));
  const source = path.join(dir, 'h.swift'), binary = path.join(dir, 'h');
  fs.writeFileSync(source, 'one');
  assert.equal(binaryCurrent(source, binary), false, 'no binary yet');
  fs.writeFileSync(binary, 'bin');
  assert.equal(binaryCurrent(source, binary), false, 'no build record');
  recordBuild(source, binary);
  assert.equal(binaryCurrent(source, binary), true);
  fs.utimesSync(source, new Date(Date.now() + 60000), new Date(Date.now() + 60000));
  assert.equal(binaryCurrent(source, binary), true, 'a newer mtime alone changes nothing');
  fs.writeFileSync(source, 'two');
  assert.equal(binaryCurrent(source, binary), false, 'changed source is stale');
});

const base = { binary: '/c/mac-computer', source: '/c/mac-computer.swift', bundled: '/app/mac-computer' };
const files = (present, fresh = []) => ({ exists: (p) => present.includes(p), current: (_s, b) => fresh.includes(b) });

test('a current local helper is used as is', async () => {
  assert.equal(await pickHelper({ ...base, ...files(['/c/mac-computer', '/c/mac-computer.swift'], ['/c/mac-computer']), compile: async () => assert.fail('no compile') }), '/c/mac-computer');
});
test('a stale helper is rebuilt when swiftc works', async () => {
  assert.equal(await pickHelper({ ...base, ...files(['/c/mac-computer', '/c/mac-computer.swift']), compile: async () => true }), '/c/mac-computer');
});
test('without swiftc the app bundle helper is used', async () => {
  assert.equal(await pickHelper({ ...base, ...files(['/c/mac-computer.swift', '/app/mac-computer']), compile: async () => false }), '/app/mac-computer');
});
test('without swiftc a stale local helper beats nothing', async () => {
  assert.equal(await pickHelper({ ...base, ...files(['/c/mac-computer', '/c/mac-computer.swift']), compile: async () => false }), '/c/mac-computer');
});
test('a helper inside a packaged app is never recompiled, so a signed bundle keeps its seal', async () => {
  const sealed = { binary: '/A.app/Contents/Resources/app/scripts/mac-computer', source: '/A.app/Contents/Resources/app/scripts/mac-computer.swift', bundled: '/A.app/Contents/Resources/mac-computer' };
  const exists = (p) => p === sealed.binary || p === sealed.source;
  assert.equal(await pickHelper({ ...sealed, exists, current: () => false, compile: async () => assert.fail('no compile inside the bundle') }), sealed.binary);
});
test('no helper and no compiler is an error', async () => {
  await assert.rejects(pickHelper({ ...base, ...files(['/c/mac-computer.swift']), compile: async () => false }), /Mac computer helper/);
});
test('without developer tools swiftc is never run, so no install dialog appears', async () => {
  let ran = 0;
  const compile = makeCompile({ hasDevTools: async () => false, build: async () => { ran++; } });
  assert.equal(await compile(), false);
  assert.equal(ran, 0);
});
test('a failed compile is not retried on every action', async () => {
  let ran = 0;
  const compile = makeCompile({ hasDevTools: async () => true, build: async () => { ran++; throw new Error('no'); } });
  await compile(); await compile(); await compile();
  assert.equal(ran, 1);
});
test('a working compiler still rebuilds', async () => {
  const compile = makeCompile({ hasDevTools: async () => true, build: async () => {} });
  assert.equal(await compile(), true);
});
