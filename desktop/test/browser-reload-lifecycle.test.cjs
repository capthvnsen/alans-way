'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { frameOf, boundedJs, readJs, createAgentInput } = require('../src/agent-input.cjs');

function unavailable(kind) {
  let sends = 0;
  const wc = { isDestroyed: () => kind === 'destroyed', isCrashed: () => kind === 'crashed',
    executeJavaScript() { sends++; return Promise.resolve('stale document'); } };
  Object.defineProperty(wc, 'mainFrame', { get() {
    if (kind === 'disposed') throw Error('Render frame was disposed before WebFrameMain could be accessed');
    return { url: 'https://fixture.example/', detached: kind === 'detached', isDestroyed: () => false,
      executeJavaScript: wc.executeJavaScript };
  } });
  return { wc, sends: () => sends };
}
for (const kind of ['destroyed', 'crashed', 'disposed', 'detached']) {
  test(`${kind} document cannot fall back to a stale WebContents read or cursor send`, async () => {
    const f = unavailable(kind);
    assert.throws(() => frameOf(f.wc), error => error.status === 503 && error.code === 'page_unavailable');
    await assert.rejects(boundedJs(f.wc, 'cursor effect', 50), { code: 'page_unavailable' });
    await assert.rejects(readJs(f.wc, 'read only', 50, 5), { code: 'page_unavailable' });
    const tab = { view: { webContents: f.wc }, agentCursor: { x: 1, y: 2 }, focusEmulation: true };
    const calls = [];
    const agent = createAgentInput({ command: async (...args) => calls.push(args), requireActor() {} });
    await agent.clear(tab);
    assert.equal(tab.agentCursor, null);
    assert.equal(tab.focusEmulation, false);
    assert.equal(f.sends(), 0);
    assert.equal(calls.length, 0);
  });
}
test('read fallback rechecks a frame disposed after the first read fails', async () => {
  let gone = false, fallback = 0;
  const wc = { executeJavaScript: async () => { fallback++; return 'wrong'; } };
  Object.defineProperty(wc, 'mainFrame', { get() {
    if (gone) throw Error('Render frame was disposed before WebFrameMain could be accessed');
    return { url: 'https://fixture.example/', executeJavaScript: async () => { gone = true; throw Error('frame swapped'); } };
  } });
  await assert.rejects(readJs(wc, 'read only', 50, 5), { code: 'page_unavailable' });
  assert.equal(fallback, 0);
});
test('unexpected mainFrame errors propagate and live navigation fallback still works', async () => {
  const broken = { get mainFrame() { throw Error('unexpected accessor failure'); }, executeJavaScript: async () => 'wrong' };
  assert.throws(() => frameOf(broken), /unexpected accessor failure/);
  await assert.rejects(readJs(broken, 'read', 50, 5), /unexpected accessor failure/);
  let fallback = 0;
  const live = { mainFrame: { url: 'https://fixture.example/', isDestroyed: () => false, detached: false,
    executeJavaScript: async () => { throw Error('navigation swapped the live frame'); } },
    executeJavaScript: async () => { fallback++; return 'new live document'; } };
  assert.equal(await readJs(live, 'read', 50, 5), 'new live document');
  assert.equal(fallback, 1);
  assert.equal(await boundedJs({ executeJavaScript: async () => 'internal page' }, 'read', 50), 'internal page');
});
test('a late read retry rejects if the initially live frame was disposed while pending', async () => {
  let reads = 0;
  const wc = { executeJavaScript: async () => { throw Error('must never fall back'); } };
  Object.defineProperty(wc, 'mainFrame', { get() {
    if (reads++) throw Error('Render frame was disposed before WebFrameMain could be accessed');
    return { url: 'https://fixture.example/', executeJavaScript: () => new Promise(() => {}) };
  } });
  await assert.rejects(readJs(wc, 'read', 50, 5), { code: 'page_unavailable' });
});
