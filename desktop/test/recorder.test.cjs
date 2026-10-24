const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { REDACTED, MAX_RECORDINGS, PAGE_SCRIPT, normalizeEvent, navigateStep, addStep, finishRecording, createRecordingStore } = require('../src/recorder.cjs');
const finishSteps = (steps, options) => finishRecording(steps, options).steps;

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
  for (const extra of [{ name: 'Card PIN' }, { name: 'CVV' }, { name: 'Security code' }, { name: 'SSN' }, { field: 'otpCode' }, { field: 'cvc2 cardCvc' },
    { selector: 'input[name="reset_token"]' }, { name: 'Verification code' }]) {
    assert.equal(finishSteps([input({ ...extra, value: 'hunter2' })], { keepTyped: true })[0].value, REDACTED, `secret-named field ${JSON.stringify(extra)}`);
  }
  // Underscored, hyphenated, camelCase and run-together names, and card fields with no autocomplete.
  for (const label of ['security_code', 'securityCode', 'security-code', 'SECURITYCODE', 'verification_code', 'one_time_code', 'oneTimeCode', 'social_security_number',
    'cardnumber', 'card_number', 'cardNumber', 'ccnum', 'cc_number', 'cc-no', 'creditCard', 'cvc2', 'card_cvv', 'exp_date', 'expDate', 'expiry_month', 'expiration-year', 'cc_exp', 'cardExpiry']) {
    for (const key of ['name', 'field']) {
      assert.equal(finishSteps([input({ [key]: label, value: 'hunter2' })], { keepTyped: true })[0].value, REDACTED, `${key} ${label}`);
    }
    assert.equal(finishSteps([input({ selector: `input[name="${label}"]`, value: 'hunter2' })], { keepTyped: true })[0].value, REDACTED, `selector ${label}`);
  }
  for (const name of ['Shipping notes', 'Spinner', 'Pinterest handle', 'Tokenomics essay', 'Phone time zone', 'Expected delivery', 'Account name', 'Card message']) assert.equal(input({ name }).value, 'typed', `${name} is not a secret`);
  for (const label of ['card_no', 'cardno', 'cardNo', 'paymentCardNo', 'ccno', 'ccNo', 'cc_no', 'card no 4', 'ccno2', 'cc no number', 'your_card_no',
    'paymentcardno', 'customerccno', 'paymentcardno_field', 'billing-ccnonumber',
    // Any run of card+no / cc+no counts, however it is split or prefixed: a
    // harmless note field that also matches loses only its typed text.
    'paymentcard_no', 'billingcard_no', 'customercc_no', 'paymentcardNo', 'visaccno', 'paymentcardnoinput', 'customerccnofield', 'postcard_notes']) {
    for (const key of ['name', 'field']) {
      assert.equal(finishSteps([input({ [key]: label, value: 'hunter2' })], { keepTyped: true })[0].value, REDACTED, `${key} ${label}`);
    }
  }
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
  assert.equal(navigateStep('https://a.example/login?user=ada&password=hunter2').url, 'https://a.example/login', 'query strings never reach a step');
  assert.equal(navigateStep('https://a.example/cb#access_token=xyz').url, 'https://a.example/cb');
  assert.equal(navigateStep('https://a.example/reset/9f8a7c6b5d4e3f2a1b0c9d8e/confirm').url, 'https://a.example/reset/[redacted]/confirm');
  assert.equal(navigateStep('https://a.example/invite/550e8400-e29b-41d4-a716-446655440000').url, 'https://a.example/invite/[redacted]');
  assert.equal(navigateStep('https://a.example/magic/eyJhbGciOiJIUzI1NiJ9abc123XYZ').url, 'https://a.example/magic/[redacted]');
  assert.equal(navigateStep('https://a.example/blog/how-to-file-taxes-2026/comments').url, 'https://a.example/blog/how-to-file-taxes-2026/comments', 'a slug is not a token');
  assert.equal(navigateStep('https://a.example/orders/2026/10').url, 'https://a.example/orders/2026/10');
  assert.deepEqual(navigateStep('https://shop.example/'), { url: 'https://shop.example/', action: 'navigate', role: '', name: '', selector: '' });
  assert.equal(navigateStep('about:blank'), null);
});

test('a field is never named by what was typed into it', () => {
  assert.equal(input({ name: 'Dear Ada, the contract is attached', value: 'Dear Ada, the contract is attached' }).name, '');
  assert.equal(input({ name: 'x'.repeat(200), value: 'x'.repeat(300) }).name, '', 'a name cut from long contents');
  assert.equal(input({ name: 'Bio', value: 'Bio text here' }).name, 'Bio', 'a label that the text happens to start with stays');
  assert.equal(input({ name: 'Email', value: 'ada@example.com' }).name, 'Email');
  assert.equal(normalizeEvent({ kind: 'click', url, role: 'button', name: 'Save', selector: '#s' }).name, 'Save');
});

test('without keep typed text, a page echoing the typed text in its path or title does not carry it', () => {
  const steps = [navigateStep('https://shop.example/find'), input({ url: 'https://shop.example/find', selector: '#q', value: 'Zebra umbrella 7731' }),
    normalizeEvent({ kind: 'click', url: 'https://shop.example/find', role: 'button', name: 'Go', selector: '#go' }),
    navigateStep('https://shop.example/search/zebra-umbrella-7731/page/2'), navigateStep('https://shop.example/q/Zebra%20umbrella%207731')];
  const done = finishRecording(steps, { title: 'Results for Zebra Umbrella 7731 - Shop', fallbackTitle: 'shop.example' });
  assert.equal(done.title, 'shop.example');
  assert.deepEqual(done.steps.map(step => step.url), ['https://shop.example/find', 'https://shop.example/find', 'https://shop.example/find',
    'https://shop.example/search/[redacted]/page/2', 'https://shop.example/q/[redacted]']);
  assert.ok(!JSON.stringify(done).toLowerCase().includes('umbrella'));
  assert.equal(finishRecording(steps, { title: 'Find - Shop', fallbackTitle: 'shop.example' }).title, 'Find - Shop', 'a title that does not echo stays');
  assert.equal(finishRecording(steps, { title: '', fallbackTitle: 'shop.example' }).title, 'shop.example');
  const kept = finishRecording(steps, { keepTyped: true, title: 'Results for Zebra Umbrella 7731', fallbackTitle: 'shop.example' });
  assert.equal(kept.title, 'Results for Zebra Umbrella 7731', 'kept typed text may show in the title');
  assert.equal(kept.steps[3].url, 'https://shop.example/search/zebra-umbrella-7731/page/2');
  const short = finishRecording([navigateStep('https://a.example/page/2'), input({ value: '2' })], { title: 'Page 2', fallbackTitle: 'a.example' });
  assert.equal(short.title, 'Page 2', 'a one-character value does not wipe titles');
});

test('without keep typed text, part of a typed term still cannot reach disk', () => {
  const type = (value) => input({ selector: '#q', value });
  const click = (extra) => normalizeEvent({ kind: 'click', url: 'https://shop.example/find', role: 'button', name: 'Go', selector: '#go', ...extra });
  // A slug or filename holding any 3+ letter word of a typed value is scrubbed.
  const done = finishRecording([type('Zebra umbrella 7731'),
    navigateStep('https://shop.example/s/zebra-umbrella.html'),
    navigateStep('https://shop.example/zebra-umbrella-results'),
    navigateStep('https://shop.example/search/prefixzebrasuffix'),
    navigateStep('https://shop.example/results/page-2')], { title: 'Shop', fallbackTitle: 'shop.example' });
  assert.deepEqual(done.steps.map(step => step.url), ['https://shop.example/login',
    'https://shop.example/s/[redacted]', 'https://shop.example/[redacted]', 'https://shop.example/search/[redacted]', 'https://shop.example/results/page-2']);
  // A lone short word works as a substring too: /search/prefixzebrasuffix.
  assert.equal(finishRecording([type('zebra'), navigateStep('https://shop.example/search/prefixzebrasuffix')]).steps[1].url,
    'https://shop.example/search/[redacted]');
  assert.equal(done.title, 'Shop', 'a title without the term stays');
  // A title or a click name showing only part of the typed term is caught.
  assert.equal(finishRecording([type('Zebra umbrella 7731')], { title: 'Zebra - Shop', fallbackTitle: 'shop.example' }).title, 'shop.example');
  assert.equal(finishRecording([type('Zebra umbrella 7731')], { title: '7731 results', fallbackTitle: 'shop.example' }).title, 'shop.example');
  const echoed = finishRecording([type('Zebra umbrella 7731'),
    click({ name: 'Zebra umbrella 7731', selector: 'li[data-q="zebra-umbrella-7731"]' }),
    click({ name: 'Umbrella in stock' }),
    click({ name: 'Go', selector: '#go' })], { fallbackTitle: 'shop.example' });
  assert.equal(echoed.steps[1].name, REDACTED, 'a clicked suggestion echoing the term');
  assert.equal(echoed.steps[1].selector, REDACTED, 'a selector carrying the term');
  assert.equal(echoed.steps[2].name, REDACTED, 'even part of the term in a name is redacted');
  assert.equal(echoed.steps[3].name, 'Go');
  assert.equal(echoed.steps[3].selector, '#go');
  assert.ok(!JSON.stringify(echoed).toLowerCase().includes('umbrella'));
  // Type steps are scrubbed too: a page can name or select a field by what
  // was typed into it.
  const fieldEcho = finishRecording([input({ name: 'Zebra search', selector: 'input[name="zebra_q"]', value: 'Zebra umbrella 7731' })], { fallbackTitle: 'shop.example' });
  assert.equal(fieldEcho.steps[0].name, REDACTED, 'a type-step name echoing the typed text');
  assert.equal(fieldEcho.steps[0].selector, REDACTED, 'a type-step selector echoing it too');
  // keepTyped still keeps names and selectors as recorded.
  const kept = finishRecording([type('Zebra umbrella 7731'), click({ name: 'Zebra umbrella 7731' })], { keepTyped: true });
  assert.equal(kept.steps[1].name, 'Zebra umbrella 7731');
});

test('typed terms never reach the recording file on disk', () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'recorder-test-')), 'recordings');
  const store = createRecordingStore(dir);
  // A camelCase card field redacts its value even when typed text is kept.
  store.save({ title: 'Pay', steps: finishSteps([input({ field: 'paymentCardNo', value: 'cn-90425' })], { keepTyped: true }), keepTyped: true });
  // Run-together lowercase card fields with a prefix are card fields too.
  for (const field of ['paymentcardno', 'customerccno', 'paymentcard_no', 'billingcard_no', 'customercc_no', 'paymentcardNo', 'visaccno']) {
    store.save({ title: 'Pay', steps: finishSteps([input({ field, selector: `input[name="${field}"]`, value: 'cn-90425' })], { keepTyped: true }), keepTyped: true });
  }
  // A typed term echoed in a path, title, type-step name/selector or click
  // name/selector is scrubbed before the file is written.
  const done = finishRecording([input({ name: 'Zebra search', selector: 'input[name="zebra_q"]', value: 'Zebra umbrella 77310429' }),
    normalizeEvent({ kind: 'click', url: 'https://shop.example/find', role: 'button', name: 'prefixzebrasuffix', selector: '#xzebrax' }),
    navigateStep('https://shop.example/search/prefixzebrasuffix')], { title: 'prefixzebrasuffix', fallbackTitle: 'shop.example' });
  store.save({ title: done.title, steps: done.steps });
  for (const file of fs.readdirSync(dir)) {
    const bytes = fs.readFileSync(path.join(dir, file));
    for (const term of ['cn-90425', 'zebra', 'umbrella', '77310429']) assert.ok(!bytes.includes(term), `${term} reached disk in ${file}`);
  }
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
