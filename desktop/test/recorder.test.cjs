const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { REDACTED, MAX_RECORDINGS, PAGE_SCRIPT, normalizeEvent, navigateStep, addStep, finishSteps, createRecordingStore } = require('../src/recorder.cjs');

const url = 'https://shop.example/login';
const input = (extra) => normalizeEvent({ kind: 'input', url, role: 'input', name: 'Field', selector: '#f', type: 'text', autocomplete: '', value: 'typed', ...extra });

test('secret fields are always redacted, whatever the page sends', () => {
  for (const extra of [{ type: 'password' }, { type: 'hidden' }, { autocomplete: 'cc-number' }, { autocomplete: 'billing cc-exp-month' },
    { autocomplete: 'CC-CSC' }, { autocomplete: 'one-time-code' }, { autocomplete: 'current-password' }, { autocomplete: 'section-a new-password' }, { secret: true }]) {
    const step = input({ ...extra, value: 'hunter2' });
    assert.equal(step.value, REDACTED, JSON.stringify(extra));
    assert.equal(finishSteps([step], { keepTyped: true })[0].value, REDACTED, 'keep typed text never keeps a secret');
  }
  assert.equal(normalizeEvent({ kind: 'change', url, type: '', autocomplete: 'cc-exp-year', value: '2031' }).value, REDACTED);
  assert.equal(input({ autocomplete: 'email' }).value, 'typed');
  assert.equal(input({ autocomplete: 'occ-note' }).value, 'typed', 'only whole cc-* tokens count');
});

test('other typed text is kept only when the user ticks keep typed text', () => {
  const steps = [input({ value: 'ada@example.com' }), normalizeEvent({ kind: 'change', url, role: 'select', name: 'Country', selector: '#c', value: 'Canada' })];
  assert.deepEqual(finishSteps(steps).map(step => step.value), [REDACTED, 'Canada']);
  assert.deepEqual(finishSteps(steps, { keepTyped: true }).map(step => step.value), ['ada@example.com', 'Canada']);
});

test('events become steps with the documented shape and nothing else', () => {
  assert.deepEqual(normalizeEvent({ kind: 'click', url, role: 'button', name: '  Sign\n in ', selector: '#go', extra: 'x', value: 'ignored' }),
    { url, action: 'click', role: 'button', name: 'Sign in', selector: '#go' });
  assert.deepEqual(normalizeEvent({ kind: 'submit', url, role: 'form', name: '', selector: 'form' }), { url, action: 'submit', role: 'form', name: '', selector: 'form' });
  assert.equal(normalizeEvent({ kind: 'eval', url }), null);
  assert.equal(normalizeEvent({ kind: 'toString', url }), null);
  assert.equal(normalizeEvent({ kind: 'click', url: 'file:///etc/passwd' }), null);
  assert.equal(normalizeEvent(null), null);
  assert.equal(normalizeEvent({ kind: 'click', url: 'https://me:secret@bank.example/a' }).url, 'https://bank.example/a', 'credentials in a URL are dropped');
  assert.equal(navigateStep('https://a.example/login?user=ada&password=hunter2&next=%2Fhome').url, 'https://a.example/login?user=ada&password=%5Bredacted%5D&next=%2Fhome');
  assert.equal(navigateStep('https://a.example/cb?code=abc&state=1#access_token=xyz').url, 'https://a.example/cb?code=%5Bredacted%5D&state=1');
  assert.equal(navigateStep('https://a.example/search?q=shoes#reviews').url, 'https://a.example/search?q=shoes#reviews');
  assert.deepEqual(navigateStep('https://shop.example/'), { url: 'https://shop.example/', action: 'navigate', role: '', name: '', selector: '' });
  assert.equal(navigateStep('about:blank'), null);
});

test('steps merge keystrokes, redirects and the submit a click caused', () => {
  const steps = [];
  addStep(steps, navigateStep('https://a.example/'));
  addStep(steps, navigateStep('https://a.example/home'));
  addStep(steps, input({ url: 'https://a.example/home', value: 'a' }));
  addStep(steps, input({ url: 'https://a.example/home', value: 'ab' }));
  addStep(steps, input({ url: 'https://a.example/home', selector: '#other', value: 'c' }));
  addStep(steps, normalizeEvent({ kind: 'click', url: 'https://a.example/home', role: 'button', name: 'Go', selector: '#go' }));
  addStep(steps, normalizeEvent({ kind: 'submit', url: 'https://a.example/home', role: 'form', name: '', selector: 'form' }));
  addStep(steps, navigateStep('https://a.example/home'));
  addStep(steps, null);
  addStep(steps, navigateStep('https://a.example/done'));
  assert.deepEqual(steps.map(step => [step.action, step.url, step.value]), [
    ['navigate', 'https://a.example/home', undefined],
    ['type', 'https://a.example/home', 'ab'],
    ['type', 'https://a.example/home', 'c'],
    ['click', 'https://a.example/home', undefined],
    ['navigate', 'https://a.example/done', undefined],
  ]);
  const enter = [input({ value: 'q' })];
  addStep(enter, normalizeEvent({ kind: 'submit', url, role: 'form', name: '', selector: 'form' }));
  assert.equal(enter.at(-1).action, 'submit', 'a submit by Enter stays');
});

test('the store keeps at most 20 private recordings, deletes them, and shows a bot only what was shared with it', () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'recorder-test-')), 'recordings');
  const store = createRecordingStore(dir);
  const steps = [navigateStep(url), input({ value: REDACTED })];
  const first = store.save({ title: 'Log in', steps, keepTyped: false, sharedWith: ['42'] });
  assert.equal(fs.statSync(path.join(dir, `${first.id}.json`)).mode & 0o777, 0o600);
  assert.deepEqual(store.listFor('42').map(item => item.id), [first.id]);
  assert.deepEqual(store.listFor('99'), []);
  assert.equal(store.getFor(first.id, '99'), null);
  assert.deepEqual(store.getFor(first.id, '42').steps, steps);
  assert.equal(store.listFor('42')[0].sharedWith, undefined, 'a bot does not learn who else it was shared with');
  store.share(first.id, ['99']);
  assert.equal(store.getFor(first.id, '42'), null);
  assert.equal(createRecordingStore(dir).getFor(first.id, '99').title, 'Log in', 'sharing persists');
  for (let i = 1; i < MAX_RECORDINGS; i++) store.save({ title: `r${i}`, steps, sharedWith: [] });
  assert.ok(store.full());
  assert.throws(() => store.save({ title: 'one too many', steps, sharedWith: [] }), /Delete one in Settings/);
  store.remove(first.id);
  assert.equal(fs.existsSync(path.join(dir, `${first.id}.json`)), false);
  assert.equal(store.list().length, MAX_RECORDINGS - 1);
  assert.equal(createRecordingStore(dir).list().length, MAX_RECORDINGS - 1);
});

test('the page script parses', () => {
  assert.doesNotThrow(() => new vm.Script(PAGE_SCRIPT));
});
