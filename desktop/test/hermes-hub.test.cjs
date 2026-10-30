const { ip: fixtureTailnet, otherIp: fixtureTailnetOther } = require('./tailnet-fixture.cjs');
process.env.HERMES_WORKSPACE_ALLOW_LOOPBACK = '1';
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
  wire.sessions = [{ id: 's-1', session_key: 'k-1', title: 'First' }, { id: 's-2', session_key: 'k-2', title: 'Second' }];
  wire.storedSessions = [];
  wire.call = async (method, params) => {
    wire.calls.push({ method, params });
    if (method === 'session.active_list') {
      return { sessions: wire.sessions.slice() };
    }
    if (method === 'session.list') return { sessions: wire.storedSessions.slice() };
    if (method === 'session.resume') {
      const row = wire.storedSessions.find(s => s.id === params.session_id);
      if (!row) throw new Error('stored session not found');
      const resumed = wire.resumeResult || { session_id: 's-resumed', session_key: row.id };
      if (wire.publishResume !== false) wire.sessions.push({ id: resumed.session_id, session_key: wire.resumeLiveKey || resumed.session_key, title: row.title });
      return resumed;
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

function fixture({ authRequired = true, tokens = null, persisted = {}, signIn, notify, setupWire } = {}) {
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
    createWire: () => { const w = wires.at(-1); setupWire?.(w); return w; },
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

test('wrong password keeps sign-in available with a plain inline error, then accepts a retry', async () => {
  let attempts = 0;
  const { RemoteError } = require('../src/hermes-remote.cjs');
  const { hub } = fixture({ signIn: async () => {
    if (++attempts === 1) throw new RemoteError('auth_failed', 'POST /auth/password-login: Invalid credentials');
    return { accessToken: 'at-1', refreshToken: 'rt-1', userId: 'u', provider: 'basic' };
  } });
  try {
    await hub.command('configure', { url: 'http://127.0.0.1:9119' });
    await assert.rejects(hub.command('connect', {}), { code: 'needs_signin' });
    await assert.rejects(hub.command('sign-in', { username: 'u', password: 'wrong' }), {
      code: 'auth_failed', message: 'Wrong username or password.',
    });
    assert.equal(hub.getState().status, 'needs_signin');
    assert.deepEqual(hub.getState().error, { code: 'auth_failed', message: 'Wrong username or password.' });
    assert.equal(hub.getState().principal, null);
    await hub.command('sign-in', { username: 'u', password: 'right' });
    assert.equal(hub.getState().status, 'ready');
    assert.equal(hub.getState().error, null);
  } finally { hub.dispose(); }
});

test('sign-in transport failure keeps the form available without mislabeling it as a wrong password', async () => {
  const { RemoteError } = require('../src/hermes-remote.cjs');
  const { hub } = fixture({ signIn: async () => { throw new RemoteError('unreachable', 'Backend is unreachable.'); } });
  try {
    await hub.command('configure', { url: 'http://127.0.0.1:9119' });
    await assert.rejects(hub.command('connect', {}), { code: 'needs_signin' });
    await assert.rejects(hub.command('sign-in', { username: 'u', password: 'fixture-only' }), { code: 'unreachable' });
    assert.equal(hub.getState().status, 'needs_signin');
    assert.deepEqual(hub.getState().error, { code: 'unreachable', message: 'Backend is unreachable.' });
  } finally { hub.dispose(); }
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
  assert.deepEqual(wire.calls.map((c) => c.method), ['session.active_list', 'session.list']);
  const text = JSON.stringify(s);
  assert.ok(!text.includes('rt-1') && !text.includes('tk-1') && !text.includes('at-2'));
});

test('restart and re-auth refresh saved history and explicit Resume binds a fresh live identity without sending', async () => {
  const { hub, remote, wires, controllers } = fixture({
    persisted: { url: 'http://127.0.0.1:9119', profile: 'work', tokens: { refreshToken: 'expired' },
      selected: { sessionId: 's-before-restart', sessionKey: 'stored-1' } },
    setupWire: wire => { wire.sessions = []; wire.storedSessions = [{ id: 'stored-1', title: 'Lighthouse' }]; },
  });
  try {
    const refresh = remote.refresh;
    remote.refresh = async value => {
      if (value.refreshToken === 'expired') throw new (require('../src/hermes-remote.cjs').RemoteError)('session_expired', 'Stored sign-in expired; sign in again.');
      return refresh(value);
    };
    await assert.rejects(hub.command('connect'), { code: 'needs_signin' });
    await hub.command('sign-in', { username: 'u', password: 'fixture-only' });
    const state = hub.getState();
    assert.equal(state.status, 'ready');
    assert.deepEqual(state.sessions, [], 'a restarted backend has no live sessions');
    assert.deepEqual(state.storedSessions, [{ id: 'stored-1', title: 'Lighthouse' }]);
    assert.equal(state.storedSessionsError, null);
    assert.deepEqual(wires[0].calls.find(c => c.method === 'session.list').params, { profile: 'work', limit: 50 });
    assert.equal(wires[0].calls.filter(c => c.method === 'session.resume').length, 0, 're-auth never resumes or submits automatically');
    const result = await hub.command('resume-session', { storedSessionId: 'stored-1', generation: state.generation });
    assert.equal(result.sessionId, 's-resumed');
    assert.deepEqual(hub.getState().selected, { sessionId: 's-resumed', sessionKey: 'stored-1' });
    assert.deepEqual(hub.getState().storedSessions, [], 'the now-live conversation is not duplicated in Saved');
    assert.deepEqual(controllers[0].identity, { profile: 'work', sessionId: 's-resumed', sessionKey: 'stored-1', reviewed: true });
    assert.deepEqual(controllers[0].calls, ['bind']);
    assert.deepEqual(wires[0].calls.find(c => c.method === 'session.resume').params,
      { session_id: 'stored-1', profile: 'work', lazy: true, inline_images: false });
    assert.equal(wires[0].calls.some(c => c.method === 'prompt.submit'), false);
    await hub.command('disconnect'); await hub.command('connect');
    assert.deepEqual(hub.getState().storedSessions, [{ id: 'stored-1', title: 'Lighthouse' }], 'ordinary reconnect also refreshes saved history');
    assert.ok(remote.wsUrlArgs.length >= 2);
  } finally { hub.dispose(); }
});

test('saved-session resume rejects stale or unlisted controls before issuing an RPC', async () => {
  const { hub, wire } = fixture({ authRequired: false, persisted: { url: 'http://127.0.0.1:9119', localToken: 'fixture' },
    setupWire: w => { w.storedSessions = [{ id: 'stored-1', title: 'Saved' }]; } });
  try {
    await hub.command('connect');
    const generation = hub.getState().generation;
    for (const value of [{ storedSessionId: 'stored-1' }, { storedSessionId: 'stored-1', generation: generation - 1 }]) {
      await assert.rejects(hub.command('resume-session', value), { code: 'stale_generation' });
    }
    await assert.rejects(hub.command('resume-session', { storedSessionId: 'not-listed', generation }), { code: 'unknown_session' });
    assert.equal(wire.calls.filter(c => c.method === 'session.resume').length, 0);
  } finally { hub.dispose(); }
});

test('resume requires the returned runtime/key pair in the fresh live list before it can bind', async () => {
  for (const publishResume of [false, true]) {
    const { hub, wire, controllers } = fixture({ authRequired: false,
      persisted: { url: 'http://127.0.0.1:9119', localToken: 'fixture' },
      setupWire: w => { w.storedSessions = [{ id: 'stored-1', title: 'Saved' }];
        w.publishResume = publishResume; w.resumeLiveKey = 'different-key'; } });
    try {
      await hub.command('connect');
      await assert.rejects(hub.command('resume-session', { storedSessionId: 'stored-1', generation: hub.getState().generation }), { code: 'identity_mismatch' });
      assert.equal(controllers.length, 0);
      assert.equal(hub.getState().selected, null);
      assert.equal(wire.calls.filter(c => c.method === 'prompt.submit').length, 0);
    } finally { hub.dispose(); }
  }
});

test('saved-list errors keep the live list usable and are not presented as an empty saved history', async () => {
  const { hub, wire } = fixture({ authRequired: false, persisted: { url: 'http://127.0.0.1:9119', localToken: 'fixture' } });
  const call = wire.call;
  wire.call = async (method, params) => {
    if (method === 'session.list') throw Object.assign(new Error('unsupported'), { code: 'remote_error' });
    return call(method, params);
  };
  try {
    await hub.command('connect');
    assert.equal(hub.getState().status, 'ready');
    assert.equal(hub.getState().sessions.length, 2);
    assert.ok(hub.getState().storedSessionsError);
    wire.call = call;
    await hub.command('refresh-sessions', {});
    assert.equal(hub.getState().storedSessionsError, null);
  } finally { hub.dispose(); }
});

test('a late saved-history list cannot cross a backend change', { timeout: 3000 }, async () => {
  const { hub, wire } = fixture({ authRequired: false, persisted: { url: 'http://127.0.0.1:9119', localToken: 'fixture' } });
  let release, started;
  const pending = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  const call = wire.call;
  wire.call = (method, params) => {
    if (method === 'session.list') { started(); return pending; }
    return call(method, params);
  };
  try {
    const connecting = hub.command('connect'); await entered;
    await hub.command('configure', { url: `http://${fixtureTailnetOther}:9119` });
    release({ sessions: [{ id: 'old-history', title: 'Old backend' }] });
    await assert.rejects(connecting, { code: 'stale' });
    assert.deepEqual(hub.getState().storedSessions, []);
    assert.deepEqual(hub.getState().sessions, []);
    assert.equal(hub.getState().storedSessionsError, null);
  } finally { release({ sessions: [] }); hub.dispose(); }
});

test('a late Resume cannot select a conversation after a backend change', { timeout: 3000 }, async () => {
  const { hub, wire, controllers } = fixture({ authRequired: false,
    persisted: { url: 'http://127.0.0.1:9119', localToken: 'fixture' },
    setupWire: w => { w.storedSessions = [{ id: 'stored-1', title: 'Saved' }]; } });
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  try {
    await hub.command('connect');
    const call = wire.call;
    wire.call = (method, params) => method === 'session.resume' ? pending : call(method, params);
    const resuming = hub.command('resume-session', { storedSessionId: 'stored-1', generation: hub.getState().generation });
    await hub.command('configure', { url: `http://${fixtureTailnetOther}:9119` });
    release({ session_id: 'old-runtime', session_key: 'stored-1' });
    await assert.rejects(resuming, { code: 'stale' });
    assert.equal(controllers.length, 0);
    assert.equal(hub.getState().selected, null);
    assert.deepEqual(hub.getState().storedSessions, []);
  } finally { release({}); hub.dispose(); }
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
    await hub.command('configure', { url: `http://${fixtureTailnet}`, localToken: 'fixture' });
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
    await hub.command('configure', { url: `http://${fixtureTailnet}`, profile: 'profile-A', localToken: 'fixture' });
    await hub.command('connect'); await hub.command('select', { sessionId: 's-1' });
    const generation = hub.getState().generation;
    controllers[0].lastSend = { text: 'A-only pending text', outcome: 'inflight', target: { sessionId: 's-1', sessionKey: 'k-1' } };
    await hub.command('configure', { url: `http://${fixtureTailnet}`, profile: 'profile-B', localToken: 'fixture' });
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
    await hub.command('configure', { url: `http://${fixtureTailnet}`, localToken: 'fixture' });
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
