const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { listReadExpression } = require('../src/browser-page.cjs');

const fields = { title: { type: 'text', selector: 'a' }, url: { type: 'href', selector: 'a' }, price: { type: 'text', selector: '.price' } };
function read(body, count = 3) {
  const rows = Array.from({ length: count }, (_, i) => ({
    querySelector: selector => selector === 'a'
      ? { textContent: 'Book ' + i, getAttribute: () => '/book/' + i, baseURI: 'https://fixture.example/' }
      : selector === '.price' ? { textContent: '$' + (10 + i) } : null,
  }));
  const container = { querySelectorAll: () => rows, querySelector: () => null };
  const document = { querySelectorAll: selector => selector === '.product' ? rows : [container], querySelector: () => null };
  const context = { document, window: { [Symbol.for('hw.refs')]: { live: ref => ref === 'e1' ? container : null } }, URL, location: { href: 'https://fixture.example/' } };
  return JSON.parse(JSON.stringify(vm.runInNewContext(listReadExpression(body), context)));
}

test('read a product grid as typed fields, with a selector or container ref', () => {
  for (const target of [{ selector: '#grid' }, { ref: 'e1' }]) {
    const result = read({ ...target, list: { selector: '.product', fields } });
    assert.deepEqual(result.items[0], { title: 'Book 0', url: 'https://fixture.example/book/0', price: '$10' });
    assert.equal(result.items.length, 3);
    assert.equal(result.truncated, false);
  }
});

test('list reads bound item count, each field, and total serialized items', () => {
  const body = { list: { selector: '.product', fields, maxItems: 2, maxFieldChars: 4 }, maxChars: 20000 };
  const result = read(body);
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].title, 'Book');
  assert.equal(result.truncated, true);
  const small = read({ ...body, maxChars: 60 });
  assert.ok(JSON.stringify(small.items).length <= 60);
  assert.equal(small.truncated, true);
  assert.deepEqual(read({ ...body, maxChars: 0 }).items, []);
  assert.equal(read({ list: { selector: '.product', fields: { title: fields.title }, maxItems: 1000 } }, 150).items.length, 100);
});

test('invalid list requests and stale container refs fail explicitly', () => {
  for (const list of [null, {}, { selector: '.product', fields: {} }, { selector: '.product', fields: { x: { type: 'value' } } },
    { selector: '.product', fields, maxItems: -1 }, { selector: '.product', fields, maxFieldChars: '10' },
    { selector: '.product', fields: { x: { type: 'text', code: 'alert(1)' } } }]) {
    assert.throws(() => listReadExpression({ list }), /list|field/i);
  }
  assert.throws(() => read({ ref: 'e2', list: { selector: '.product', fields } }), /stale|container/i);
});

test('href fields reject executable and credential links and leave missing children empty', () => {
  for (const href of ['javascript:alert(1)', 'data:text/html,hello', 'https://user:pass@example.com/']) {
    const row = { getAttribute: () => href, baseURI: 'https://fixture.example/', querySelector: () => null };
    const code = listReadExpression({ list: { selector: 'a', fields: { url: { type: 'href' }, missing: { type: 'text', selector: '.missing' } } } });
    const result = vm.runInNewContext(code, { document: { querySelector: () => null, querySelectorAll: () => [row] }, URL });
    assert.equal(result.items[0].url, '');
    assert.equal(result.items[0].missing, '');
  }
});

for (const file of ['../src/main.cjs', '../scripts/vps-browser-host.cjs']) {
  test(`${file}: the read dispatcher uses the shared bounds and rechecks ownership`, async () => {
    const source = fs.readFileSync(require.resolve(file), 'utf8');
    const start = source.indexOf("if (body.action === 'read') {");
    const branch = source.slice(start, source.indexOf("if (body.action === 'eval')", start));
    let checks = 0, revoked = false, revokeDuringRead = false;
    const payload = { items: [{ title: 'Book' }], truncated: false };
    const execute = async code => {
      assert.match(code, /"maxItems":100/);
      assert.match(code, /"maxFieldChars":2000/);
      assert.match(code, /"maxChars":20000/);
      if (revokeDuringRead) revoked = true;
      return payload;
    };
    const dispatch = vm.runInNewContext(`(async body => { ${branch} })`, {
      listReadExpression, Number, tab: {}, botId: 'fixture', overseer: false,
      wc: { executeJavaScript: execute }, readJs: (_wc, code) => execute(code), dryRun: () => {},
      requireAgentRead: () => {}, requireActor: () => { checks++; if (revoked) throw new Error('stale_control_epoch'); },
      finish: data => data,
    });
    const request = { action: 'read', maxChars: 99999, list: { selector: 'article', fields, maxItems: 999, maxFieldChars: 9999 } };
    assert.deepEqual(JSON.parse(JSON.stringify(await dispatch(request))), { ...payload, dispatched: true });
    assert.equal(checks, 1);
    revokeDuringRead = true;
    await assert.rejects(dispatch(request), /stale_control_epoch/);
  });
}
