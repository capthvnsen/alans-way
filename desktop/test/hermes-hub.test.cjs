'use strict';
// Behavioral tests for the main-process Hermes hub. Deps are injected fakes so
// real hub logic — command allowlist, generation/session fencing, secrets
// discipline, lifecycle — is exercised, not mirrored.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { createHermesHub } = require('../src/hermes-hub.cjs');

function fakeWire() {
  const wire = new EventEmitter();
  wire.state = 'open';
  wire.calls = [];
  wire.call = async (method, params) => {
    wire.calls.push({ method, params });
    if (method === 'session.active_list') {
      return { sessions: [{ id: 's-1', session_key: 'k-1', title: 'First' }, { id: 's-2', session_key: 'k-2', title: 'Second' }] };
    }
    if (method === 'session.create') return { session_id: 's-9', session_key: 'k-9' };
    return { ok: true };
  };
  wire.dispose = () => { wire.state = 'closed'; };
  return wire;
}

function fakeController(identity) {
  const c = new EventEmitter();
  c.identity = identity;
  c.phase = 'detached';
  c.calls = [];
  c.subscribe = (fn) => { c.on('change', fn); return () => c.removeListener('change', fn); };
  c.getState = () => ({ phase: c.phase, identity, transcript: [], pendingRequests: [], draft: { text: c.draftText || '' }, stats: {}, lastSend: c.lastSend || null });
  c.bind = async () => { c.calls.push('bind'); c.phase = 'bound'; c.emit('change'); };
  c.setDraft = (t) => { c.draftText = t; };
  c.send = async () => { c.calls.push('send'); return { status: 'running' }; };
  c.acknowledgeReview = () => { c.calls.push('acknowledge-review'); c.phase = 'bound'; c.emit('change'); };
  c.stop = async () => { c.calls.push('stop'); return { status: 'interrupted' }; };
  c.answerRequest = async (id, result) => { c.calls.push(['answer', id, result]); return { ok: true }; };
  c.refuseRequest = async (id, opts) => { c.calls.push(['refuse', id, opts]); return { ok: true }; };
  c.dispose = () => { c.phase = 'disposed'; };
  return c;
}

function fixture({ authRequired = true, tokens = null, persisted = {}, signIn, notify } = {}) {
  const controllers = [];
  const wires = [fakeWire()];
  const wire = wires[0];
  const saved = [];
  const remote = {
    normalizeBaseUrl: require('../src/hermes-remote.cjs').normalizeBaseUrl,
    probe: async () => ({
      base: remote.normalizeBaseUrl('http://127.0.0.1:9119'), status: {},
      authRequired, authFlows: authRequired ? ['cookie', 'native_pkce'] : [],
      authProviders: ['basic'], profiles: [], gatewayRunning: true,
    }),
    providers: async () => [{ name: 'basic', display_name: 'Password', supports_password: true }],
    signIn: signIn || (async ({ username }) => ({ accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: 1, provider: 'basic', userId: username })),
    refresh: async ({ refreshToken }) => {
      if (refreshToken !== 'rt-1') { const e = new Error('expired'); e.code = 'session_expired'; e.name = 'RemoteError'; throw e; }
      return { accessToken: 'at-2', refreshToken: 'rt-1', expiresAt: 2, provider: 'basic', userId: 'u' };
    },
    wsTicket: async () => ({ ticket: 'tk-1', ttlSeconds: 30 }),
    wsUrlArgs: [],
    wsUrl({ ticket, localToken }) { this.wsUrlArgs.push({ ticket, localToken }); return `ws://127.0.0.1:9119/api/ws?${ticket ? 'ticket' : 'token'}=x`; },
    connectSocket: async () => {
      // First socket reuses the wire tests hold; later connects get fresh
      // wires, matching production (a new socket = a new wire).
      const w = wires.at(-1).state === 'open' && !wires.at(-1).wasConn ? wires.at(-1) : (wires.push(fakeWire()), wires.at(-1));
      w.wasConn = true;
      // The real gateway sends `gateway.ready` right after the socket opens.
      setImmediate(() => w.emit('event', { type: 'gateway.ready', payload: { replay_epoch: 'e1' } }));
      return { input: new PassThrough(), output: new Writable({ write(c, e, cb) { cb(); } }), socket: { close() {} } };
    },
  };
  const hub = createHermesHub({
    remote,
    // Each connectSocket yields a fresh wire, like production; tests that
    // reuse the first socket still see `wire`, reconnects get wires.at(-1).
    createWire: () => wires.at(-1),
    createController: ({ identity }) => { const c = fakeController(identity); controllers.push(c); return c; },
    persist: (r) => saved.push(r),
    load: () => persisted,
    notify: notify || (() => {}),
  });
  return { hub, wire, wires, controllers, saved, remote };
}

test('unknown commands and non-object values are rejected by the allowlist', async () => {
  const { hub } = fixture();
  await assert.rejects(() => hub.command('eval', { js: 'process.exit()' }), /Unknown hermes command/);
  await assert.rejects(() => hub.command('shell', {}), /Unknown/);
});

test('unconfigured hub reports unconfigured; configure persists without secrets in projection', async () => {
  const { hub } = fixture();
  assert.equal(hub.getState().status, 'unconfigured');
  await hub.command('configure', { url: 'http://127.0.0.1:9119' });
  const s = hub.getState();
  assert.equal(s.status, 'disconnected');
  assert.equal(s.target.label, '127.0.0.1:9119');
  assert.ok(!JSON.stringify(s).includes('rt-1'));
});

test('connect with stored refresh token: refresh → ticket → wire → sessions; secret never in state', async () => {
  const { hub, wire } = fixture({ persisted: { url: 'http://127.0.0.1:9119', tokens: { refreshToken: 'rt-1' } } });
  await hub.command('connect');
  const s = hub.getState();
  assert.equal(s.status, 'ready');
  assert.deepEqual(s.sessions.map((x) => x.id), ['s-1', 's-2']);
  assert.deepEqual(wire.calls.map((c) => c.method), ['session.active_list']);
  const text = JSON.stringify(s);
  assert.ok(!text.includes('rt-1') && !text.includes('tk-1') && !text.includes('at-2'));
});

test('needs_signin when auth required and no stored token; sign-in then connects', async () => {
  const { hub } = fixture();
  await hub.command('configure', { url: 'http://127.0.0.1:9119' });
  await assert.rejects(() => hub.command('connect'), /needs_signin|Sign in/);
  assert.equal(hub.getState().status, 'needs_signin');
  await hub.command('sign-in', { username: 'u', password: 'p' });
  assert.equal(hub.getState().status, 'ready');
  assert.equal(hub.getState().principal.userId, 'u');
});

test('loopback mode requires an operator-supplied local token', async () => {
  const { hub } = fixture({ authRequired: false });
  await hub.command('configure', { url: 'http://127.0.0.1:9119' });
  await assert.rejects(() => hub.command('connect'), /session token|needs_local_token/);
  await hub.command('configure', { url: 'http://127.0.0.1:9119', localToken: 'fixture-token' });
  await hub.command('connect');
  assert.equal(hub.getState().status, 'ready');
});

test('select binds a controller to the exact live identity; send/stop/answer are fenced', async () => {
  const { hub, controllers } = fixture({ persisted: { url: 'http://127.0.0.1:9119', tokens: { refreshToken: 'rt-1' } } });
  await hub.command('connect');
  await hub.command('select', { sessionId: 's-1' });
  assert.equal(controllers.length, 1);
  assert.deepEqual(controllers[0].identity, { profile: 'default', sessionKey: 'k-1', sessionId: 's-1', reviewed: true });
  assert.deepEqual(controllers[0].calls, ['bind']);
  await hub.command('send', { sessionId: 's-1', text: 'hi', generation: hub.getState().generation });
  assert.ok(controllers[0].calls.includes('send'));
  // Stale session/generation must not reach any controller.
  await hub.command('select', { sessionId: 's-2' });
  await assert.rejects(() => hub.command('send', { sessionId: 's-1', text: 'x' }), /no longer selected/);
  await assert.rejects(() => hub.command('stop', { generation: -5, sessionId: 's-2' }), /connection changed/);
  assert.equal(controllers.length, 2);
  assert.ok(!controllers[1].calls.includes('send'));
});

test('unknown live session cannot be selected', async () => {
  const { hub } = fixture({ persisted: { url: 'http://127.0.0.1:9119', tokens: { refreshToken: 'rt-1' } } });
  await hub.command('connect');
  await assert.rejects(() => hub.command('select', { sessionId: 'bogus' }), /not live/);
});

test('new-session creates then selects through the same live path', async () => {
  const { hub, wire } = fixture({ persisted: { url: 'http://127.0.0.1:9119', tokens: { refreshToken: 'rt-1' } } });
  await hub.command('connect');
  await hub.command('new-session');
  assert.equal(hub.getState().selected.sessionId, 's-9');
  assert.ok(wire.calls.some((c) => c.method === 'session.create'));
});

test('disconnect disposes controllers and closes the wire; reconfiguring to a new origin drops tokens', async () => {
  const { hub, wire, controllers, saved } = fixture({ persisted: { url: 'http://127.0.0.1:9119', tokens: { refreshToken: 'rt-1' } } });
  await hub.command('connect');
  await hub.command('select', { sessionId: 's-1' });
  await hub.command('disconnect');
  assert.equal(wire.state, 'closed');
  assert.equal(controllers[0].phase, 'disposed');
  assert.equal(hub.getState().status, 'disconnected');
  await hub.command('configure', { url: 'http://127.0.0.1:9222' });
  assert.ok(saved.at(-1).tokens === null);
});

test('target change clears the loopback localToken; old credential is never offered to the new backend', async () => {
  const { hub, remote, saved } = fixture({ authRequired: false, persisted: { url: 'http://127.0.0.1:9119', localToken: 'LT-A' } });
  await hub.command('connect');
  assert.equal(hub.getState().status, 'ready');
  assert.equal(remote.wsUrlArgs.at(-1).localToken, 'LT-A');
  await hub.command('configure', { url: 'http://127.0.0.1:9222' });
  // The move drops every target-scoped credential, persisted included.
  assert.equal(saved.at(-1).localToken, '');
  assert.equal(saved.at(-1).tokens, null);
  await assert.rejects(() => hub.command('connect'), /needs_local_token|session token/);
  assert.equal(hub.getState().status, 'needs_local_token');
  // LT-A appeared exactly once — for backend A only, never for B.
  assert.equal(remote.wsUrlArgs.filter((a) => a.localToken === 'LT-A').length, 1);
  // Reconfiguring the SAME origin with a new token still takes effect.
  await hub.command('configure', { url: 'http://127.0.0.1:9222', localToken: 'LT-B' });
  assert.equal(saved.at(-1).localToken, 'LT-B');
  await hub.command('connect');
  assert.equal(remote.wsUrlArgs.at(-1).localToken, 'LT-B');
});

test('uncertain send survives teardown as a durable tombstone across reconnect, never replayed, dismissed only explicitly', async () => {
  const { hub, wire, controllers } = fixture({ persisted: { url: 'http://127.0.0.1:9119', tokens: { refreshToken: 'rt-1' } } });
  await hub.command('connect');
  await hub.command('select', { sessionId: 's-1' });
  // A prompt.submit that never reached a terminal outcome.
  controllers[0].lastSend = { text: 'did the reply land?', target: { sessionId: 's-1', sessionKey: 'k-1' }, at: '2026-10-16T00:00:00Z', outcome: 'uncertain' };
  wire.state = 'failed';
  wire.emit('close', { state: 'failed', reason: 'EOF mid-submit' });
  // conversation is torn down, but the tombstone projects for the session.
  assert.equal(controllers[0].phase, 'disposed');
  assert.equal(hub.getState().status, 'error');
  // Reselect after reconnect: the tombstone is still there — durable across
  // teardown AND a fresh controller.
  await hub.command('connect');
  await hub.command('select', { sessionId: 's-1' });
  const tomb = hub.getState().uncertain;
  assert.ok(tomb);
  assert.equal(tomb.sessionId, 's-1');
  assert.equal(tomb.sessionKey, 'k-1');
  assert.equal(tomb.text, 'did the reply land?');
  // The fresh controller must not inherit or replay anything.
  assert.equal(controllers.at(-1).calls.includes('send'), false);
  // Dismiss is session-fenced: wrong session cannot clear it.
  await assert.rejects(() => hub.command('uncertain-dismiss', { sessionId: 's-2' }), /no longer selected|no unconfirmed/i);
  await hub.command('uncertain-dismiss', { sessionId: 's-1' });
  assert.equal(hub.getState().uncertain, null);
});

test('wire close mid-session tears down and reports disconnected', async () => {
  const { hub, wire, controllers } = fixture({ persisted: { url: 'http://127.0.0.1:9119', tokens: { refreshToken: 'rt-1' } } });
  await hub.command('connect');
  await hub.command('select', { sessionId: 's-1' });
  wire.state = 'failed';
  wire.emit('close', { state: 'failed', reason: 'boom' });
  assert.equal(controllers[0].phase, 'disposed');
  assert.equal(hub.getState().status, 'error');
});

test('adopted conn close during a pending same-target sign-in still surfaces the dead pipe', async () => {
  // A sign-in attempt bumps the credential epoch without replacing the live
  // socket. When that adopted socket dies the hub must report the dead pipe —
  // 'ready' with a secretly detached conn is a zombie state.
  let releaseSignIn;
  const statuses = [];
  const { hub, wire } = fixture({
    persisted: { url: 'http://127.0.0.1:9119', tokens: { refreshToken: 'rt-1' } },
    notify: () => statuses.push(hub.getState().status),
    signIn: () => new Promise((res) => {
      releaseSignIn = () => res({ accessToken: 'at-9', refreshToken: 'rt-1', expiresAt: 9, provider: 'basic', userId: 'u2' });
    }),
  });
  await hub.command('connect');
  assert.equal(hub.getState().status, 'ready');
  const pending = hub.command('sign-in', { username: 'u2', password: 'p' });
  pending.catch(() => {});
  // The pending sign-in bumped authSeq; the live socket is still adopted.
  wire.state = 'failed';
  wire.emit('close', { state: 'failed', reason: 'socket died' });
  const mid = hub.getState();
  assert.equal(mid.status, 'error');
  assert.deepEqual(mid.sessions, []);
  assert.ok(statuses.includes('error'));
  // Releasing the authorized sign-in must still settle and own the reconnect:
  // the wire re-establishes on the refreshed credential and re-lists sessions.
  releaseSignIn();
  await pending;
  assert.equal(hub.getState().status, 'ready');
  assert.deepEqual(hub.getState().sessions.map((x) => x.id), ['s-1', 's-2']);
});

test('deliberate disconnect of a live conn never projects a false error', async () => {
  // wire.dispose() emits 'close' synchronously inside teardown; the detached
  // conn must read as already-orphaned, not as a pipe that died on its own.
  const statuses = [];
  const { hub, wire } = fixture({
    persisted: { url: 'http://127.0.0.1:9119', tokens: { refreshToken: 'rt-1' } },
    notify: () => statuses.push(hub.getState().status),
  });
  await hub.command('connect');
  const gen = hub.getState().generation;
  const at = statuses.length;
  await hub.command('disconnect');
  assert.equal(hub.getState().status, 'disconnected');
  assert.equal(hub.getState().error, null);
  assert.ok(!statuses.slice(at).includes('error'));
  assert.equal(hub.getState().generation, gen + 1);
  assert.equal(wire.state, 'closed');
});

// Independent disconnect review: renderer pushes can lag a completed reconnect.
for (const command of ['answer-request', 'refuse-request']) test(`${command} requires the generation even before the renderer sees a reconnect`, async () => {
  const { hub, controllers } = fixture({ authRequired: false });
  try {
    await hub.command('configure', { url: 'http://gw.test', localToken: 'fixture' });
    await hub.command('connect'); await hub.command('select', { sessionId: 's-1' });
    const old = hub.getState().generation;
    await hub.command('disconnect'); await hub.command('connect');
    const value = { sessionId: 's-1', requestId: 'reused-id', result: { choice: 'once' } };
    for (const generation of [undefined, null, '1', old]) {
      await assert.rejects(hub.command(command, { ...value, generation }), e => e.code === 'stale_generation');
    }
    assert.deepEqual(controllers.at(-1).calls, ['bind']);
    await hub.command(command, { ...value, generation: hub.getState().generation });
    assert.equal(controllers.at(-1).calls.at(-1)[0], command === 'answer-request' ? 'answer' : 'refuse');
  } finally { hub.dispose(); }
});

test('profile changes retire sessions, controllers and uncertain sends before reconnect', async () => {
  const { hub, wire, controllers } = fixture({ authRequired: false });
  try {
    await hub.command('configure', { url: 'http://gw.test', profile: 'profile-A', localToken: 'fixture' });
    await hub.command('connect'); await hub.command('select', { sessionId: 's-1' });
    const generation = hub.getState().generation;
    controllers[0].lastSend = { text: 'A-only pending text', outcome: 'inflight', target: { sessionId: 's-1', sessionKey: 'k-1' } };
    await hub.command('configure', { url: 'http://gw.test', profile: 'profile-B', localToken: 'fixture' });
    assert.equal(wire.state, 'closed'); assert.equal(controllers[0].phase, 'disposed');
    assert.equal(hub.getState().generation, generation + 1);
    assert.deepEqual(hub.getState().sessions, []); assert.equal(hub.getState().conversation, null);
    await hub.command('connect'); await hub.command('select', { sessionId: 's-1' });
    assert.equal(hub.getState().uncertain, null);
    assert.equal(controllers.at(-1).identity.profile, 'profile-B');
  } finally { hub.dispose(); }
});

test('review acknowledgement is allowlisted and fenced to the rendered connection and session', async () => {
  const { hub, controllers } = fixture({ authRequired: false });
  try {
    await hub.command('configure', { url: 'http://gw.test', localToken: 'fixture' });
    await hub.command('connect'); await hub.command('select', { sessionId: 's-1' });
    controllers[0].phase = 'review'; const generation = hub.getState().generation;
    await assert.rejects(hub.command('acknowledge-review', { sessionId: 's-1' }), e => e.code === 'stale_generation');
    await assert.rejects(hub.command('acknowledge-review', { sessionId: 's-2', generation }), e => e.code === 'stale_session');
    assert.deepEqual(controllers[0].calls, ['bind']);
    await hub.command('acknowledge-review', { sessionId: 's-1', generation });
    assert.equal(hub.getState().conversation.phase, 'bound');
    assert.equal(controllers[0].calls.at(-1), 'acknowledge-review');
    await hub.command('disconnect'); await hub.command('connect');
    await assert.rejects(hub.command('acknowledge-review', { sessionId: 's-1', generation }), e => e.code === 'stale_generation');
  } finally { hub.dispose(); }
});
