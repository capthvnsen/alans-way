'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function fixture({ activationFails = false, remote = false } = {}) {
  const main = fs.readFileSync(require.resolve('../src/main.cjs'), 'utf8');
  let resume, created = 0, saved = 0;
  const source = { id: remote ? 'vm-task' : 'mac-task', botId: 'bot-a', controller: 'agent',
    queue: new Promise(resolve => { resume = resolve; }),
    view: { webContents: { executeJavaScript: async () => ({ url: 'https://task.example/', drafts: [] }) } },
  };
  const context = vm.createContext({
    tabs: new Map(remote ? [] : [[source.id, source]]), vpsTabs: new Map(remote ? [[source.id, source]] : []), prefs: { handoffs: [] }, HOST_LABEL: 'mac',
    crypto: { randomUUID: () => `move-${created}` }, checkpointExpression() {},
    changeController: (_id, controller) => { source.controller = controller; },
    vpsBrowser: { request: async () => ({ id: `vm-${++created}`, botId: source.botId, controller: 'human' }) },
    createTab: () => ({ id: `mac-${++created}`, view: { webContents: {
      isLoading: () => false, getURL: () => 'https://task.example/', executeJavaScript: async () => ({ verification: 'ready' }),
    } } }), restoreExpression() {},
    remoteRequest: async (id, operation) => {
      if (operation === 'checkpoint') { await source.queue; return { url: 'https://task.example/' }; }
      if (operation === 'activate' && activationFails) throw new Error('Tailscale disconnected');
      return { tab: { id, botId: source.botId, controller: 'human' }, verification: 'ready', restored: 0, skipped: 0 };
    },
    savePreferences: () => { saved++; }, applyLayout() {}, broadcast() {}, logError() {},
  });
  vm.runInContext(main.slice(main.indexOf('const handoffRequests ='), main.indexOf('// History navigation has no promise.')), context);
  return { source, resume, context, move: () => context.handoffTab({ id: source.id, destination: remote ? 'mac' : 'vps' }), created: () => created, saved: () => saved };
}

test('overlapping Move requests during a paused task share one handoff', async () => {
  const f = fixture();
  const first = f.move(), second = f.move();
  f.resume();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(f.created(), 1, 'one destination even when the source queue was paused across sleep');
  assert.equal(a.id, b.id);
  assert.equal(f.context.prefs.handoffs.length, 1);
});

test('a repeated request after completion cannot move the retired source again', async () => {
  const f = fixture(); f.resume();
  await f.move();
  await assert.rejects(f.move(), /already moved/i);
  assert.equal(f.created(), 1);
});

test('VM tab refresh during a paused Move back cannot lose the pending handoff', async () => {
  const f = fixture({ remote: true });
  const first = f.move();
  await new Promise(resolve => setImmediate(resolve));
  f.context.vpsTabs.set(f.source.id, { id: f.source.id, botId: f.source.botId, controller: 'human' });
  const second = f.move(); f.resume();
  await Promise.all([first, second]);
  assert.equal(f.created(), 1, 'polling replaces remote tab objects while the handoff is waiting');
});

test('a network drop while focusing the destination keeps the completed move saved', async () => {
  const f = fixture({ activationFails: true }); f.resume();
  const record = await f.move();
  assert.ok(f.saved() > 0);
  assert.equal(f.context.prefs.handoffs[0].id, record.id);
  assert.equal(f.source.handoff.destinationTabId, record.destinationTabId);
  assert.equal(f.source.handoff.phase, 'handed_off');
});

test('a failed checkpoint releases the pending handoff so it can be retried', async () => {
  const f = fixture(); f.resume();
  const contents = f.source.view.webContents, read = contents.executeJavaScript;
  contents.executeJavaScript = async () => { throw new Error('renderer paused'); };
  await assert.rejects(f.move(), /renderer paused/);
  assert.equal(vm.runInContext('handoffRequests.size', f.context), 0);
  contents.executeJavaScript = read;
  await f.move();
  assert.equal(f.created(), 1);
});
