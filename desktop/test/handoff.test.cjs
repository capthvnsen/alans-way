'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { requireAgentClaim } = require('../src/core.cjs');
const { boundedJs } = require('../src/agent-input.cjs');

// restore: 'ok'; 'lost' (the VM applied it but the reply never arrived); 'fails' (the VM refused it);
// 'unreachable' (the VM answers nothing, not even the follow-up read or the delete).
function fixture({ activationFails = false, retirementFails = false, remote = false, restore = 'ok', localRestoreFails = false } = {}) {
  const main = fs.readFileSync(require.resolve('../src/main.cjs'), 'utf8');
  let resume, created = 0, saved = 0;
  const live = new Set(), applied = new Map();
  const source = { id: remote ? 'vm-task' : 'mac-task', botId: 'bot-a', controller: 'agent',
    queue: new Promise(resolve => { resume = resolve; }),
    view: { webContents: { executeJavaScript: async () => ({ url: 'https://task.example/', drafts: [] }) } },
  };
  const down = () => { throw new Error('Tailscale disconnected'); };
  const context = vm.createContext({
    tabs: new Map(remote ? [] : [[source.id, source]]), vpsTabs: new Map(remote ? [[source.id, source]] : []), prefs: { handoffs: [] }, HOST_LABEL: 'mac',
    boundedJs, vaultLock: { isLocked: () => false },
    signInsTravel: async () => false, crypto: { randomUUID: () => `move-${created}` }, checkpointExpression() {},
    changeController: (_id, controller) => { source.controller = controller; },
    vpsBrowser: { request: async (route, method) => {
      if (method === 'DELETE') { if (restore === 'unreachable') down(); live.delete(route.split('/').pop()); return { closed: true }; }
      const id = `vm-${++created}`; live.add(id); return { id, botId: source.botId, controller: 'human' };
    } },
    createTab: () => { const target = { id: `mac-${++created}`, controller: 'human', view: { webContents: {
      isLoading: () => false, getURL: () => 'https://task.example/',
      executeJavaScript: async () => { if (localRestoreFails) throw new Error('renderer paused'); return { verification: 'ready' }; },
    } } }; context.tabs.set(target.id, target); live.add(target.id); return target; }, restoreExpression() {},
    closeTab: (id) => { context.tabs.delete(id); live.delete(id); },
    remoteRequest: async (id, operation, body) => {
      if (operation === 'checkpoint') { await source.queue; return { url: 'https://task.example/' }; }
      if (body?.handoff && !body.checkpoint && retirementFails) throw new Error('Tailscale disconnected before retirement');
      if (operation === 'activate' && activationFails) throw new Error('Tailscale disconnected');
      if (operation === 'restore') {
        if (restore === 'fails' || restore === 'unreachable') down();
        applied.set(id, { ...body.handoff, verification: 'ready', restoredDrafts: 0, skippedDrafts: 0 });
        if (restore === 'lost') throw new Error('response lost');
      }
      if (operation === '' && body === undefined) { if (restore === 'unreachable') down(); return { id, handoff: applied.get(id) || null }; }
      return { tab: { id, botId: source.botId, controller: 'human' }, verification: 'ready', restored: 0, skipped: 0 };
    },
    savePreferences: () => { saved++; }, applyLayout() {}, broadcast() {}, logError() {},
  });
  vm.runInContext(main.slice(main.indexOf('const handoffRequests ='), main.indexOf('// History navigation has no promise.')), context);
  return { source, resume, context, live, move: () => context.handoffTab({ id: source.id, destination: remote ? 'mac' : 'vps' }), created: () => created, saved: () => saved };
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

test('Move back keeps its destination gated if the VM source retirement was not acknowledged', async () => {
  const f = fixture({ remote: true, retirementFails: true }); f.resume();
  const record = await f.move();
  assert.equal(record.sourceRetired, false);
  const target = f.context.tabs.get(record.destinationTabId);
  assert.throws(() => requireAgentClaim(target, Date.now(), { autoTakeover: true }), /handoff_review_required/);
  assert.equal(record.verification, 'review_required', 'the human must resolve an ambiguous source before agents continue');
});

test('Move back gates its destination while source retirement is still in flight', async () => {
  const f = fixture({ remote: true }); f.resume();
  let retire;
  const request = f.context.remoteRequest;
  f.context.remoteRequest = async (id, operation, body) => {
    if (body?.handoff) await new Promise(resolve => { retire = resolve; });
    return request(id, operation, body);
  };
  const moving = f.move();
  await new Promise(resolve => setImmediate(resolve));
  const target = [...f.context.tabs.values()][0];
  assert.throws(() => requireAgentClaim(target), /handoff_review_required/, 'verification cannot open the claim gate before retirement completes');
  retire();
  const record = await moving;
  assert.equal(record.sourceRetired, true);
  assert.doesNotThrow(() => requireAgentClaim(target));
});

test('a restore reply lost after the VM applied it is recorded once and never moved twice', async () => {
  const f = fixture({ restore: 'lost' }); f.resume();
  const record = await f.move();
  assert.equal(f.created(), 1, 'the destination the VM already restored is the one used');
  assert.equal(f.context.prefs.handoffs[0].id, record.id);
  assert.equal(record.verification, 'ready');
  assert.equal(f.source.handoff.phase, 'handed_off');
  assert.deepEqual([...f.live], ['vm-1'], 'the restored destination was not deleted');
  await assert.rejects(f.move(), /already moved/i);
});

test('a refused restore removes its unconfirmed destination and hands the source back for a retry', async () => {
  const f = fixture({ restore: 'fails' }); f.resume();
  await assert.rejects(f.move(), /Tailscale disconnected/);
  assert.equal(f.source.controller, 'agent', 'the Move button is shown for an agent-controlled tab');
  assert.equal(f.source.handoff, undefined);
  assert.equal(f.live.size, 0, 'no orphan destination is left holding the page');
  assert.equal(f.context.prefs.handoffs.length, 0);
});

test('when the VM cannot be asked at all the source still goes back to its agent', async () => {
  const f = fixture({ restore: 'unreachable' }); f.resume();
  await assert.rejects(f.move(), /Tailscale disconnected/);
  assert.equal(f.source.controller, 'agent');
  assert.equal(f.source.handoff, undefined);
  assert.equal(f.context.prefs.handoffs.length, 0);
});

test('a failed Move back closes its local copy so the retired source can still offer Move back', async () => {
  const f = fixture({ remote: true, localRestoreFails: true }); f.resume();
  await assert.rejects(f.move(), /renderer paused/);
  assert.equal(f.context.tabs.size, 0, 'a local tab pointing at the VM source would hide Move back');
  assert.equal(f.source.handoff, undefined);
  assert.equal(vm.runInContext('handoffRequests.size', f.context), 0);
});
