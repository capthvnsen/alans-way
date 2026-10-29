const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createDesktopLease } = require('../src/computer.cjs');
const { computerRoutes } = require('./computer-routes-fixture.cjs');

test('desktop input takes, refreshes and expires a lease by bot ID', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const { take, release } = createDesktopLease();
  assert.equal(take('a', 'Agent A'), null);
  release('a');
  t.mock.timers.tick(19000);
  assert.equal(take('a', 'Agent A'), null);
  release('a');
  t.mock.timers.tick(19999);
  assert.deepEqual(take('b'), { error: 'desktop_busy', holder: 'Agent A', retryAfter: 1 });
  t.mock.timers.tick(1);
  assert.equal(take('b'), null);
  assert.deepEqual(take('a'), { error: 'desktop_busy', holder: 'b', retryAfter: 20 });
});

for (const [endpoint, method] of [['launch', 'POST'], ['7/menu', 'GET'], ['7/action', 'POST']]) {
  test(`${endpoint} keeps the lease until all holder requests complete, then expires after 20 idle seconds`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: 0 });
    const finish = [];
    const verb = endpoint.split('/').at(-1);
    const competing = verb === 'action' ? '/v1/computer/launch' : '/v1/computer/7/action';
    const { request } = computerRoutes({ [verb]: () => new Promise(resolve => finish.push(resolve)) });
    const first = request(`/v1/computer/${endpoint}`, 'a', method);
    const second = request(`/v1/computer/${endpoint}`, 'a', method);
    t.after(async () => {
      for (const resolve of finish) resolve({ ok: true });
      await Promise.allSettled([first, second]);
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(finish.length, 2);
    t.mock.timers.tick(21000);
    assert.equal((await request(competing, 'b', 'POST')).status, 409);
    finish[0]({ ok: true });
    assert.equal((await first).status, 200);
    t.mock.timers.tick(21000);
    assert.equal((await request(competing, 'b', 'POST')).status, 409);
    finish[1]({ ok: true });
    assert.equal((await second).status, 200);
    t.mock.timers.tick(19999);
    assert.equal((await request(competing, 'b', 'POST')).status, 409);
    t.mock.timers.tick(1);
    assert.equal((await request(competing, 'b', 'POST')).status, 200);
  });

  for (const code of ['driver_error', 'cancelled', 'timeout']) {
    test(`${endpoint} releases the active request after ${code}`, async t => {
      t.mock.timers.enable({ apis: ['Date'], now: 0 });
      const verb = endpoint.split('/').at(-1);
      const competing = verb === 'action' ? '/v1/computer/launch' : '/v1/computer/7/action';
      const failure = Object.assign(new Error(code), { code });
      const { request } = computerRoutes({ [verb]: async () => { throw failure; } });
      await assert.rejects(request(`/v1/computer/${endpoint}`, 'a', method), failure);
      assert.equal((await request(competing, 'b', 'POST')).status, 409);
      t.mock.timers.tick(20000);
      assert.equal((await request(competing, 'b', 'POST')).status, 200);
    });
  }

  test(`${endpoint} takes the lease and returns HTTP 409 for another bot`, async () => {
    const { request, seen } = computerRoutes();
    assert.equal((await request(`/v1/computer/${endpoint}`, 'a', method)).status, 200);
    assert.deepEqual(await request(`/v1/computer/${endpoint}`, 'b', method), {
      status: 409, body: { error: 'desktop_busy', holder: 'Agent A', retryAfter: 20 },
    });
    assert.equal((await request(`/v1/computer/${endpoint}`, 'a', method)).status, 200);
    assert.equal(seen.length, 2, 'a rejected request never reaches the driver');
  });
}

test('computer reads remain open and do not refresh the input lease', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const { request } = computerRoutes();
  await request('/v1/computer/7/action', 'a', 'POST');
  t.mock.timers.tick(19000);
  for (const bot of ['a', 'b']) for (const endpoint of ['apps', '7/snapshot', '7/screenshot'])
    assert.equal((await request(`/v1/computer/${endpoint}`, bot)).status, 200);
  t.mock.timers.tick(1000);
  assert.equal((await request('/v1/computer/launch', 'b', 'POST')).status, 200);
});

test('identity-free API input is refused and cannot take or refresh a bot lease', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const { request } = computerRoutes();
  assert.equal((await request('/v1/computer/7/action', '', 'POST')).status, 400);
  assert.equal((await request('/v1/computer/7/action', 'a', 'POST')).status, 200);
  t.mock.timers.tick(19000);
  for (const [endpoint, method] of [['launch', 'POST'], ['7/menu', 'GET'], ['7/action', 'POST']])
    assert.equal((await request(`/v1/computer/${endpoint}`, '', method)).status, 400);
  assert.equal((await request('/v1/computer/7/action', 'b', 'POST', { 'x-hermes-human': '1' })).status, 409);
  t.mock.timers.tick(1000);
  assert.equal((await request('/v1/computer/7/action', 'b', 'POST')).status, 200);
});

test('connectors in separate processes share one file lease with the same rules', async t => {
  const { createFileDesktopLease } = require('../src/computer-helper.cjs');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-lease-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'desktop-lease.json');
  t.mock.timers.enable({ apis: ['Date'], now: 1000000 });
  const hermes = createFileDesktopLease(file);
  const grok = createFileDesktopLease(file);
  assert.equal(hermes.take('h', 'Hermes'), null);
  assert.deepEqual(grok.take('g', 'Grok Bot'), { error: 'desktop_busy', holder: 'Hermes', retryAfter: 20 }, 'busy while acting');
  assert.equal(hermes.take('h', 'Hermes'), null, 'the holder refreshes');
  hermes.release('h');
  assert.equal(grok.take('g').error, 'desktop_busy', 'one of two holder calls still runs');
  hermes.release('h');
  t.mock.timers.tick(19000);
  assert.deepEqual(grok.take('g'), { error: 'desktop_busy', holder: 'Hermes', retryAfter: 1 });
  t.mock.timers.tick(1000);
  assert.equal(grok.take('g', 'Grok Bot'), null, 'free after 20 idle seconds');
  // A holder process that died mid-action frees the desktop at once.
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).stdout.toString();
  fs.writeFileSync(file, JSON.stringify({ botId: 'gone', name: 'Gone', pid: Number(dead), actingUntil: Date.now() + 60000 }));
  assert.equal(hermes.take('h'), null);
  // A live but reused pid holds it only until the acting cap.
  fs.writeFileSync(file, JSON.stringify({ botId: 'stuck', name: 'Stuck', pid: process.pid, actingUntil: Date.now() + 1000 }));
  assert.equal(hermes.take('h').error, 'desktop_busy');
  t.mock.timers.tick(1000);
  assert.equal(hermes.take('h'), null);
  fs.writeFileSync(file, '{not json');
  assert.equal(grok.take('g').error, 'desktop_busy', 'corrupt lease fails closed');
  const unwritable = createFileDesktopLease(path.join(dir, 'missing', 'desktop-lease.json'));
  assert.equal(unwritable.take('g').error, 'desktop_busy', 'unwritable lease fails closed');
  unwritable.release('g');
});


for (const sameBot of [false, true]) test(`a simultaneous take in live processes has one winner (same bot: ${sameBot})`, async t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { spawn } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-race-'));
  const file = path.join(dir, 'lease.json'), children = [];
  t.after(() => { for (const child of children) child.kill(); fs.rmSync(dir, { recursive: true, force: true }); });
  const code = `const {createFileDesktopLease}=require(process.argv[1]); process.send('ready');process.once('message',()=>{process.send(createFileDesktopLease(process.argv[2]).take(process.argv[3]));});setInterval(()=>{},1000);`;
  const replies = Array.from({ length: 8 }, (_, i) => {
    const child = spawn(process.execPath, ['-e', code, require.resolve('../src/computer-helper.cjs'), file, sameBot ? 'same-bot' : 'bot-'+i], { stdio: ['ignore','ignore','ignore','ipc'] });
    children.push(child);
    return new Promise((resolve, reject) => { child.once('error', reject); child.on('message', message => { if (message === 'ready') { child.ready = true; if (children.length === 8 && children.every(c=>c.ready)) for (const c of children) c.send('take'); } else resolve(message); }); });
  });
  const results = await Promise.all(replies);
  assert.equal(results.filter(result => result === null).length, 1);
  assert.equal(results.filter(result => result?.error === 'desktop_busy').length, 7);
  fs.writeFileSync(file+'.lock','stale');
  assert.equal(require('../src/computer-helper.cjs').createFileDesktopLease(file).take('other').error,'desktop_busy');
});
