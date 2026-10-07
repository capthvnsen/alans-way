const test = require('node:test');
const assert = require('node:assert/strict');
const { createMacPermissionHelp } = require('../src/mac-permissions.cjs');

function fixture({ platform = 'darwin', screen = 'denied' } = {}) {
  const prompts = [];
  const systemPreferences = {
    isTrustedAccessibilityClient: (prompt) => { if (prompt) prompts.push(1); return false; },
    getMediaAccessStatus: () => screen,
  };
  return { prompts, help: createMacPermissionHelp({ systemPreferences, platform }) };
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
