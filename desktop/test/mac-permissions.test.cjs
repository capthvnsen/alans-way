const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { calls, context } = require('../src/call-budget.cjs');
const { createMacPermissionHelp } = require('../src/mac-permissions.cjs');

test('Screen Recording is requested once by setup or first use without blocking AX; each bot gets one notice', async () => {
  let requests = 0, actions = 0, granted = false;
  const help = createMacPermissionHelp({ platform: 'darwin', systemPreferences: { getMediaAccessStatus: () => 'denied' } });
  const service = help.wrap({
    requestScreenAccess: () => { requests++; return new Promise(() => {}); },
    permissions: async () => ({ accessibility: true, screenRecording: granted }),
    snapshot: async () => ({ generation: 1, elements: [{ ref: 'c1', name: 'Equals' }] }),
    action: async () => { actions++; return { ok: true }; },
  });
  help.requestScreen();
  const first = await service.snapshot('bot', 7);
  assert.match(first.note, /Screen.*Recording.*alans-way-localapp/);
  assert.match(first.note, /Continue.*controls and menus/);
  assert.equal((await service.snapshot('bot', 7)).note, undefined);
  assert.equal((await service.action('bot', 7, {})).ok, true);
  assert.match((await service.snapshot('second', 7)).note, /Screen/);
  help.requestScreen();
  assert.equal(requests, 1);
  assert.equal(actions, 1);
  assert.deepEqual(await help.read(service), { accessibility: true, screen: 'denied', restartRequired: true });
  granted = true;
  assert.deepEqual(await help.read(service), { accessibility: true, screen: 'granted', restartRequired: true });
  assert.equal((await service.snapshot('after-grant', 7)).note, undefined, 'a verified grant must not be reported as off');
  granted = undefined;
  assert.equal((await help.read(service)).screen, 'unknown');
  assert.equal((await service.snapshot('unknown', 7)).note, undefined, 'an unavailable probe must not be reported as off');
});

test('repeated screenshot refusals mention the switch once and never replay input', async () => {
  let attempts = 0;
  const help = createMacPermissionHelp({ platform: 'darwin', systemPreferences: { getMediaAccessStatus: () => 'denied' } });
  const service = help.wrap({ requestScreenAccess: async () => ({ screenRecording: false }), screenshot: async () => {
    attempts++; throw Object.assign(Error('Screen Recording is off.'), { code: 'permission' });
  } });
  await assert.rejects(service.screenshot(7, 960, { bot: 'bot' }), /Screen & System Audio Recording.*alans-way-localapp/);
  await assert.rejects(service.screenshot(7, 960, { bot: 'bot' }), error => error.code === 'permission' && !/Recording is off|System Settings/.test(error.message) && /Continue/.test(error.message));
  assert.equal(attempts, 2);
});

test('a rejected screen prompt never blocks AX and an existing grant never prompts', async () => {
  for (const granted of [true, false]) {
    let requests = 0;
    const help = createMacPermissionHelp({ platform: 'darwin', systemPreferences: { getMediaAccessStatus: () => granted ? 'granted' : 'denied' } });
    const service = help.wrap({ requestScreenAccess: async () => { requests++; throw Error('Prompt unavailable'); },
      action: async () => ({ ok: true }), permissions: async () => ({ accessibility: true, screenRecording: granted }) });
    assert.equal((await service.action('bot', 7, {})).ok, true);
    assert.equal((await service.action('bot', 7, {})).ok, true);
    assert.equal(requests, granted ? 0 : 1);
    assert.equal((await help.read(service)).screen, granted ? 'granted' : 'denied');
  }
});

test('Computer permissions requests access and offers quit and reopen after a missing grant', async () => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8');
  const commands = [];
  const element = (tag, cls, text = '') => ({ tag, className: cls, textContent: text, children: [], hidden: false,
    append(...children) { this.children.push(...children); }, setAttribute() {} });
  const context = { element, command: async name => commands.push(name), settingsStatus: () => element('p'),
    api: { command: async name => { commands.push(name); return { accessibility: true, screen: 'denied', restartRequired: true }; } },
    runSettingsAction: async (_button, _status, work) => ({ ok: true, result: await work() }) };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function showMacPermissions('), source.indexOf('const CHECK_GROUPS')), context);
  const body = element('div');
  context.showMacPermissions(body);
  await new Promise(setImmediate);
  assert.equal(commands.filter(name => name === 'request-screen-permission').length, 1);
  const buttons = body.children.filter(node => node.tag === 'button');
  const restart = buttons.find(node => node.textContent === "Quit and reopen Alan's Workspace");
  assert.ok(restart);
  assert.equal(restart.hidden, false);
  await restart.onclick();
  assert.ok(commands.includes('relaunch-for-permissions'));
});

test('the permission relaunch saves state, disables update installation and quits normally', async () => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../src/main.cjs'), 'utf8');
  const branch = source.slice(source.indexOf("case 'relaunch-for-permissions':"), source.indexOf("case 'open-mac-privacy':"));
  for (const busy of [false, true]) {
    const events = [];
    const context = { process: { platform: 'darwin' }, update: {}, vmRetrying: false, hermesUpdating: false, updatingAll: false,
      updateLocked: () => busy, holdAppInstall: hold => events.push(['hold', hold]), savePreferences: () => events.push('save'),
      app: { relaunch: () => events.push('relaunch'), quit: () => events.push('quit') } };
    const run = () => vm.runInNewContext(`(async () => { switch ('relaunch-for-permissions') { ${branch} } })()`, context);
    if (busy) { await assert.rejects(run(), /update/i); assert.deepEqual(events, []); }
    else { await run(); assert.deepEqual(events, [['hold', true], 'save', 'relaunch', 'quit']); }
  }
});

test('permission status uses helper preflight and preserves unknown on failure', async () => {
  const { readMacPermissions } = require('../src/mac-permissions.cjs');
  assert.deepEqual(await readMacPermissions({ permissions: async () => ({ accessibility: true, screenRecording: false }) }),
    { accessibility: true, screen: 'denied' });
  assert.deepEqual(await readMacPermissions({ permissions: async () => ({ accessibility: false, screenRecording: true }) }),
    { accessibility: false, screen: 'granted' });
  assert.deepEqual(await readMacPermissions({ permissions: async () => { throw new Error('Unavailable'); } }),
    { accessibility: null, screen: 'unknown' });
});

function fixture(t, { platform = 'darwin', screen = 'denied', grantOnPoll = Infinity, waitMs = 30, pollMs = 10 } = {}) {
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(performance, 'now', () => Date.now());
  const prompts = [];
  const polls = [];
  const sleeps = [];
  const systemPreferences = {
    isTrustedAccessibilityClient: (prompt) => {
      if (prompt) { prompts.push(1); return false; }
      polls.push(prompt);
      return polls.length >= grantOnPoll;
    },
    getMediaAccessStatus: () => screen,
  };
  const sleep = async (ms) => { assert.equal(prompts.length, 1); sleeps.push(ms); now += ms; };
  return { prompts, polls, sleeps, help: createMacPermissionHelp({ systemPreferences, platform, waitMs, pollMs, sleep }) };
}
const failure = (message, code) => Object.assign(new Error(message), { code });

test('an Accessibility failure prompts for the app once and tells the agent what to ask', (t) => {
  const { help, prompts } = fixture(t);
  const first = help.explain(failure('Accessibility is off for this program. Turn it on in System Settings.', 'permission'));
  assert.match(first.message, /Accessibility is off for alans-way-localapp/);
  assert.match(first.message, /System Settings > Privacy & Security > Accessibility/);
  assert.match(first.message, /retry/);
  assert.equal(first.code, 'permission');
  help.explain(failure('Accessibility is off for this program.', 'permission'));
  assert.equal(prompts.length, 1);
});

test('a screenshot failure names Screen Recording when macOS has not granted it', (t) => {
  const { help } = fixture(t, { screen: 'denied' });
  for (const original of [failure('Screen Recording is off for this program.', 'permission'), failure('could not create image from display')]) {
    const error = help.explain(original);
    assert.match(error.message, /Screen Recording is off for alans-way-localapp \(denied\)/);
    assert.match(error.message, /Privacy & Security > Screen & System Audio Recording/);
  }
});

test('other errors, a granted Screen Recording, and other platforms pass through untouched', (t) => {
  const { help } = fixture(t, { screen: 'granted' });
  const other = failure('That app is off limits.', 'off_limits');
  assert.equal(help.explain(other), other);
  const shot = failure('could not create image from display');
  assert.equal(help.explain(shot), shot);
  const linux = fixture(t, { platform: 'linux' });
  const denied = failure('Accessibility is off for this program.', 'permission');
  assert.equal(linux.help.explain(denied), denied);
});

test('wrap rewrites a rejected call and leaves successes and close alone', async (t) => {
  const { help } = fixture(t);
  let closed = false;
  const service = {
    apps: async () => [1], snapshot: async () => { throw failure('Accessibility is off for this program.', 'permission'); },
    close: () => { closed = true; },
  };
  const wrapped = help.wrap(service);
  assert.deepEqual(await wrapped.apps(), [1]);
  await assert.rejects(wrapped.snapshot('bot', 1), /alans-way-localapp/);
  wrapped.close();
  assert.equal(closed, true);
});

test('wrap waits for the third Accessibility poll and retries the refused call once with its arguments', async (t) => {
  const { help, prompts, polls, sleeps } = fixture(t, { grantOnPoll: 3 });
  const calls = [];
  const body = { action: 'click', x: 1, y: 2 };
  const result = { ok: true };
  const wrapped = help.wrap({ action: async (...args) => {
    calls.push(args);
    if (calls.length === 1) throw failure('Accessibility is off for this program.', 'permission');
    return result;
  } });
  assert.equal(await wrapped.action('bot', 1, body), result);
  assert.deepEqual(calls, [['bot', 1, body], ['bot', 1, body]]);
  assert.deepEqual(prompts, [1]);
  assert.deepEqual(polls, [false, false, false]);
  assert.deepEqual(sleeps, [10, 10, 10]);
});

test('wrap times out with the existing explanation without retrying or prompting again', async (t) => {
  const { help, prompts, polls, sleeps } = fixture(t, { waitMs: 25 });
  let calls = 0;
  const wrapped = help.wrap({ snapshot: async () => {
    calls++;
    throw failure('Accessibility is off for this program.', 'permission');
  } });
  const expected = help.explain(failure('Accessibility is off for this program.', 'permission'));
  for (let i = 0; i < 2; i++) {
    await assert.rejects(wrapped.snapshot('bot', 1), { message: expected.message, code: 'permission' });
  }
  assert.equal(calls, 2);
  assert.deepEqual(prompts, [1]);
  assert.deepEqual(polls, Array(6).fill(false));
  assert.deepEqual(sleeps, [10, 10, 5, 10, 10, 5]);
});

test('wrap does not replay a batch with completed steps and a permission failure', async (t) => {
  const { help, prompts, polls, sleeps } = fixture(t, { grantOnPoll: 1 });
  const result = { results: [{ ok: true }, { ok: false, code: 'permission', error: 'Accessibility is off.' }] };
  let calls = 0;
  const wrapped = help.wrap({ action: async () => { calls++; return result; } });
  assert.equal(await wrapped.action('bot', 1, { action: 'batch', steps: [] }), result);
  assert.equal(calls, 1);
  assert.deepEqual([prompts, polls, sleeps], [[], [], []]);
});

test('wrap does not wait or retry for other errors or Screen Recording refusals', async (t) => {
  for (const original of [failure('Accessibility failed.', 'off_limits'), failure('Screen Recording is off.', 'permission')]) {
    const { help, prompts, polls, sleeps } = fixture(t, { grantOnPoll: 1 });
    let calls = 0;
    const wrapped = help.wrap({ screenshot: async () => { calls++; throw original; } });
    const expected = help.explain(original);
    await assert.rejects(wrapped.screenshot('bot', 1), { message: expected.message, code: expected.code });
    assert.equal(calls, 1);
    assert.deepEqual([prompts, polls, sleeps], [[], [], []]);
  }
});

test('wrap explains a second refusal and never retries it again', async (t) => {
  const { help, prompts, polls, sleeps } = fixture(t, { grantOnPoll: 1 });
  let calls = 0;
  const wrapped = help.wrap({ menu: async () => {
    calls++;
    throw failure('Accessibility is off for this program.', 'permission');
  } });
  await assert.rejects(wrapped.menu('bot', 1), { code: 'permission', message: help.explain(failure('Accessibility is off.', 'permission')).message });
  assert.equal(calls, 2);
  assert.deepEqual(prompts, [1]);
  assert.deepEqual(polls, [false]);
  assert.deepEqual(sleeps, [10]);
});

test('an action returns the explanation before its caller deadline when access arrives too late', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  t.mock.method(performance, 'now', () => Date.now());
  let calls = 0;
  const help = createMacPermissionHelp({
    platform: 'darwin',
    systemPreferences: { isTrustedAccessibilityClient: () => Date.now() >= 59000 },
    sleep: async (ms) => t.mock.timers.tick(ms),
  });
  const wrapped = help.wrap({ action: async () => {
    calls++;
    if (calls === 1) throw failure('Accessibility is off.', 'permission');
    t.mock.timers.tick(85000);
    return { results: [{ ok: true }] };
  } });
  await assert.rejects(wrapped.action('bot', 1, { action: 'batch', steps: [] }), /Accessibility is off for alans-way-localapp/);
  assert.equal(Date.now(), 4000);
  assert.equal(calls, 1);
});

test('an action does not wait or retry if its first refusal used the permission budget', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  t.mock.method(performance, 'now', () => Date.now());
  let calls = 0;
  const help = createMacPermissionHelp({
    platform: 'darwin',
    systemPreferences: { isTrustedAccessibilityClient: () => true },
    sleep: async () => assert.fail('no time remains for waiting'),
  });
  const wrapped = help.wrap({ action: async () => {
    calls++;
    t.mock.timers.tick(4000);
    throw failure('Accessibility is off.', 'permission');
  } });
  await assert.rejects(wrapped.action('bot', 1, { action: 'batch', steps: [] }), /Accessibility is off for alans-way-localapp/);
  assert.equal(Date.now(), 4000);
  assert.equal(calls, 1);
});

test('a delayed permission poll never starts a retry after its budget', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  t.mock.method(performance, 'now', () => Date.now());
  let calls = 0;
  const help = createMacPermissionHelp({
    platform: 'darwin',
    systemPreferences: { isTrustedAccessibilityClient: () => true },
    sleep: async () => t.mock.timers.tick(5000),
  });
  const wrapped = help.wrap({ action: async () => {
    calls++;
    throw failure('Accessibility is off.', 'permission');
  } });
  await assert.rejects(wrapped.action('bot', 1, { action: 'batch', steps: [] }), /Accessibility is off for alans-way-localapp/);
  assert.equal(Date.now(), 5000);
  assert.equal(calls, 1);
});

for (const [action, budget, grantAt, expectedWait, attempts] of [
  ['click', 50000, 12000, 12000, 2],
  ['batch', 77000, 12000, 12000, 2],
  ['click', 25000, 6000, 5000, 1],
  ['batch', 70000, 6000, 5000, 1],
]) test(`budgeted ${action} reserves input time (${budget}ms budget, grant at ${grantAt}ms)`, async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  t.mock.method(performance, 'now', () => Date.now());
  let callsMade = 0;
  const service = createMacPermissionHelp({ platform: 'darwin',
    systemPreferences: { isTrustedAccessibilityClient: () => Date.now() >= grantAt },
    sleep: async ms => t.mock.timers.tick(ms),
  }).wrap({ action: async () => {
    callsMade++;
    if (callsMade === 1) throw failure('Accessibility is off.', 'permission');
    return { ok: true };
  } });
  const result = calls.run(context(budget), () => service.action('bot', 7, { action }));
  if (attempts === 2) assert.deepEqual(await result, { ok: true });
  else await assert.rejects(result, { code: 'permission' });
  assert.equal(callsMade, attempts);
  assert.equal(Date.now(), expectedWait);
});
