const test = require('node:test');
const assert = require('node:assert/strict');
const { createMacPermissionHelp } = require('../src/mac-permissions.cjs');

function fixture({ platform = 'darwin', screen = 'denied', grantOnPoll = Infinity, waitMs = 30, pollMs = 10 } = {}) {
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
  const sleep = async (ms) => { assert.equal(prompts.length, 1); sleeps.push(ms); };
  return { prompts, polls, sleeps, help: createMacPermissionHelp({ systemPreferences, platform, waitMs, pollMs, sleep }) };
}
const failure = (message, code) => Object.assign(new Error(message), { code });

test('an Accessibility failure prompts for the app once and tells the agent what to ask', () => {
  const { help, prompts } = fixture();
  const first = help.explain(failure('Accessibility is off for this program. Turn it on in System Settings.', 'permission'));
  assert.match(first.message, /Accessibility is off for alans-way-localapp/);
  assert.match(first.message, /System Settings > Privacy & Security > Accessibility/);
  assert.match(first.message, /retry/);
  assert.equal(first.code, 'permission');
  help.explain(failure('Accessibility is off for this program.', 'permission'));
  assert.equal(prompts.length, 1);
});

test('a screenshot failure names Screen Recording when macOS has not granted it', () => {
  const { help } = fixture({ screen: 'denied' });
  for (const original of [failure('Screen Recording is off for this program.', 'permission'), failure('could not create image from display')]) {
    const error = help.explain(original);
    assert.match(error.message, /Screen Recording is off for alans-way-localapp \(denied\)/);
    assert.match(error.message, /Privacy & Security > Screen Recording/);
  }
});

test('other errors, a granted Screen Recording, and other platforms pass through untouched', () => {
  const { help } = fixture({ screen: 'granted' });
  const other = failure('That app is off limits.', 'off_limits');
  assert.equal(help.explain(other), other);
  const shot = failure('could not create image from display');
  assert.equal(help.explain(shot), shot);
  const linux = fixture({ platform: 'linux' });
  const denied = failure('Accessibility is off for this program.', 'permission');
  assert.equal(linux.help.explain(denied), denied);
});

test('wrap rewrites a rejected call and leaves successes and close alone', async () => {
  const { help } = fixture();
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

test('wrap waits for the third Accessibility poll and retries the refused call once with its arguments', async () => {
  const { help, prompts, polls, sleeps } = fixture({ grantOnPoll: 3 });
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

test('wrap times out with the existing explanation without retrying or prompting again', async () => {
  const { help, prompts, polls, sleeps } = fixture({ waitMs: 25 });
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

test('wrap does not replay a batch with completed steps and a permission failure', async () => {
  const { help, prompts, polls, sleeps } = fixture({ grantOnPoll: 1 });
  const result = { results: [{ ok: true }, { ok: false, code: 'permission', error: 'Accessibility is off.' }] };
  let calls = 0;
  const wrapped = help.wrap({ action: async () => { calls++; return result; } });
  assert.equal(await wrapped.action('bot', 1, { action: 'batch', steps: [] }), result);
  assert.equal(calls, 1);
  assert.deepEqual([prompts, polls, sleeps], [[], [], []]);
});

test('wrap does not wait or retry for other errors or Screen Recording refusals', async () => {
  for (const original of [failure('Accessibility failed.', 'off_limits'), failure('Screen Recording is off.', 'permission')]) {
    const { help, prompts, polls, sleeps } = fixture({ grantOnPoll: 1 });
    let calls = 0;
    const wrapped = help.wrap({ screenshot: async () => { calls++; throw original; } });
    const expected = help.explain(original);
    await assert.rejects(wrapped.screenshot('bot', 1), { message: expected.message, code: expected.code });
    assert.equal(calls, 1);
    assert.deepEqual([prompts, polls, sleeps], [[], [], []]);
  }
});

test('wrap explains a second refusal and never retries it again', async () => {
  const { help, prompts, polls, sleeps } = fixture({ grantOnPoll: 1 });
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
