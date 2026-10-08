const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pollComputer } = require('../src/cloud-status.cjs');
const { cloudStep, setCloudStep, nextCloudStep } = require('../src/onboarding.cjs');

const respond = (status, body = {}) => async () => ({ status, ok: status >= 200 && status < 300, json: async () => body });

test('polling reports each state and stops once the computer is ready', async () => {
  const states = [{ state: 'new' }, { state: 'bootstrapping' }, { state: 'ready', step: 'waiting_for_pairing', computer_name: 'alan-1' }];
  const seen = [];
  const result = await pollComputer('https://api.example', 'sess', {
    intervalMs: 1,
    fetchImpl: async () => respond(200, states.shift() || states[0])(),
    onUpdate: (data) => seen.push(data.state),
  });
  assert.equal(result.state, 'ready');
  assert.deepEqual(seen, ['new', 'bootstrapping', 'ready']);
});

test('polling stops on a failed computer so the wizard can show support', async () => {
  const result = await pollComputer('https://api.example', 'sess', { intervalMs: 1, fetchImpl: respond(200, { state: 'failed', error: 'disk full' }) });
  assert.equal(result.state, 'failed');
});

test('transient errors are retried, a rejected session is not', async () => {
  let calls = 0;
  const flaky = async () => { calls++; if (calls < 3) throw new Error('network down'); return respond(200, { state: 'ready' })(); };
  const result = await pollComputer('https://api.example', 'sess', { intervalMs: 1, fetchImpl: flaky });
  assert.equal(result.state, 'ready');
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(pollComputer('https://api.example', 'sess', { intervalMs: 1, fetchImpl: respond(401) }), /rejected/i);
});

test('the auth header carries the session', async () => {
  let auth;
  await pollComputer('https://api.example', 'sess-9', { intervalMs: 1, fetchImpl: async (_url, init) => { auth = init.headers.Authorization; return respond(200, { state: 'ready' })(); } });
  assert.equal(auth, 'Bearer sess-9');
});

test('the wizard resumes at the persisted step', () => {
  const claimed = { cloud: { sessionEnc: 'enc' } };
  assert.equal(cloudStep(claimed), 'cloud-wait');
  assert.equal(cloudStep({ cloud: { sessionEnc: 'enc', step: 'migrate' } }), 'migrate');
  assert.equal(cloudStep({ cloud: { sessionEnc: 'enc', step: 'telegram' } }), 'telegram');
});

test('no session and a finished flow resolve to no cloud step', () => {
  assert.equal(cloudStep({}), null);
  assert.equal(cloudStep({ cloud: {} }), null);
  assert.equal(cloudStep({ cloud: { sessionEnc: 'enc', step: 'done' } }), null);
});

test('a failed computer shows support instead of spinning on its step', () => {
  assert.equal(cloudStep({ cloud: { sessionEnc: 'enc', step: 'connect' } }, { state: 'failed' }), 'support');
  assert.equal(cloudStep({ cloud: { sessionEnc: 'enc' } }, { state: 'failed', error: 'boom' }), 'support');
});

test('a ready computer moves the wait step to connect', () => {
  assert.equal(cloudStep({ cloud: { sessionEnc: 'enc', step: 'cloud-wait' } }, { state: 'ready', step: 'waiting_for_pairing' }), 'connect');
  assert.equal(cloudStep({ cloud: { sessionEnc: 'enc', step: 'model' } }, { state: 'ready' }), 'model');
});

test('the diy path runs the same steps without a session', () => {
  assert.equal(cloudStep({ cloud: { diy: true, step: 'connect' } }), 'connect');
});

test('a migrated profile that already has a bot token skips the telegram step', () => {
  const prefs = { cloud: { sessionEnc: 'enc', step: 'model', tokenedProfiles: ['personal'] } };
  assert.equal(nextCloudStep(prefs, 'model'), 'done');
  assert.equal(nextCloudStep({ cloud: { sessionEnc: 'enc' } }, 'model'), 'telegram');
  assert.equal(nextCloudStep({ cloud: { sessionEnc: 'enc' } }, 'telegram'), 'done');
  assert.equal(nextCloudStep({ cloud: { sessionEnc: 'enc' } }, 'support'), 'done');
});

test('step writes only accept known steps', () => {
  const prefs = { cloud: { sessionEnc: 'enc' } };
  assert.equal(setCloudStep(prefs, 'connect'), true);
  assert.equal(prefs.cloud.step, 'connect');
  assert.equal(setCloudStep(prefs, 'bogus'), false);
  assert.equal(prefs.cloud.step, 'connect');
  assert.equal(setCloudStep({}, 'connect'), false);
});
