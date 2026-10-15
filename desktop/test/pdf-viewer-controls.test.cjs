const assert = require('node:assert/strict');
const { test } = require('node:test');
const vm = require('node:vm');
const { selectPdfPage } = require('./pdf-viewer-controls.cjs');

function fixture() {
  const changes = [];
  const input = { value: '1', disabled: false, dispatchEvent(event) { changes.push([this.value, event.type, event.bubbles]); } };
  const selector = { docLength: 2, pageNo: 1, shadowRoot: { querySelector: () => input } };
  const toolbar = { shadowRoot: { querySelector: () => selector } };
  const pdf = { loadState_: 'success', shadowRoot: { querySelector: () => toolbar } };
  const document = { querySelector: () => pdf };
  const viewer = { executeJavaScript: async code => vm.runInNewContext(code, { document, Event: class { constructor(type, options) { this.type = type; Object.assign(this, options); } } }) };
  return { changes, input, selector, toolbar, pdf, viewer };
}

test('page selection waits through missing controls and pending zoom renders', async () => {
  const f = fixture();
  let reads = 0;
  const waitFor = async read => {
    const states = [
      () => { f.pdf.shadowRoot.querySelector = () => null; },
      () => { f.pdf.shadowRoot.querySelector = () => f.toolbar; f.toolbar.isUpdatePending = true; },
      () => { f.toolbar.isUpdatePending = false; f.selector.isUpdatePending = true; },
      () => { f.selector.isUpdatePending = false; f.selector.docLength = 1; },
      () => { f.selector.docLength = 2; f.input.disabled = true; },
      () => { f.input.disabled = false; },
    ];
    for (const update of states) {
      assert.deepEqual(f.changes, [], 'does not dispatch against incomplete controls');
      update(); reads++;
      if (await read()) return;
    }
    assert.fail('page selection never became ready');
  };
  // Start in the actual race window: the toolbar is absent after zoom.
  f.pdf.shadowRoot.querySelector = () => null;
  await selectPdfPage(f.viewer, 2, waitFor);
  assert.equal(reads, 6);
  assert.deepEqual(f.changes, [['2', 'change', true]]);
});

test('controls that never render still fail with the wait deadline', async () => {
  const f = fixture();
  f.selector.shadowRoot.querySelector = () => null;
  await assert.rejects(selectPdfPage(f.viewer, 2, async read => {
    for (let i = 0; i < 5; i++) assert.equal(await read(), false);
    throw new Error('Timed out waiting for PDF fixture state.');
  }), /Timed out waiting for PDF fixture state/);
  assert.deepEqual(f.changes, []);
});

test('unexpected viewer script errors remain failures', async () => {
  const f = fixture();
  f.viewer.executeJavaScript = async () => { throw new Error('fixture frame detached'); };
  await assert.rejects(selectPdfPage(f.viewer, 2, read => read()), /fixture frame detached/);
});
