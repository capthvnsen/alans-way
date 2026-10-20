'use strict';
// Auth-race fencing tests for the Hermes hub — F3 class: asynchronous
// credential work that resolves AFTER the backend target / auth context moved
// must never persist tokens under the new target, send old credentials to it,
// tear down its newer connection, or resurrect a signed-out identity.
//
// Everything below runs the REAL stack — createHermesRemote HTTP calls and the
// real HermesSessionWire over real loopback HTTP + RFC6455 sockets — against
// loopback fake backends (hermes-auth-fake-backend.cjs). Assertions read the
// persisted record stream and the backends' actual request bodies/headers, not
// just rejection codes. All tokens are synthetic tags, never real secrets.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHermesHub } = require('../src/hermes-hub.cjs');
const { createHermesRemote } = require('../src/hermes-remote.cjs');
const { fakeBackend } = require('./hermes-auth-fake-backend.cjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Settle without throwing; attach immediately so a later rejection is never
// unhandled while we orchestrate the race.
const settleOf = (p) => p.then(
  (v) => ({ outcome: 'resolved', v }),
  (e) => ({ outcome: 'rejected', code: e.code || e.name, message: String(e.message || e) }));

function hubOn() {
  const persisted = [];
  const hub = createHermesHub({
    remote: createHermesRemote(),
    persist: (r) => persisted.push(r),
    notify: () => {},
  });
  return { hub, persisted };
}

// Persisted records written at/after the configure that moved the hub to `url`.
const recordsSinceMove = (persisted, url) => {
  const i = persisted.findIndex((r) => r.url === url);
  return i < 0 ? persisted : persisted.slice(i);
};
const anyRecordContains = (records, mark) =>
  records.some((r) => JSON.stringify(r).includes(mark));

test('stale sign-in after target move: A tokens never persist under B, never reach B, no stale principal', async () => {
  const beA = await fakeBackend({ tokenTag: 'A', tokenDelayMs: 400 });
  const beB = await fakeBackend({ tokenTag: 'B' });
  const { hub, persisted } = hubOn();
  try {
    await hub.command('configure', { url: beA.url });
    await assert.rejects(() => hub.command('connect'), (e) => e.code === 'needs_signin');
    const pending = settleOf(hub.command('sign-in', { username: 'agent', password: 'pw' }));
    await sleep(120); // authorize + password-login done; /auth/native/token delayed
    await hub.command('configure', { url: beB.url });
    const settle = await pending;
    assert.equal(settle.outcome, 'rejected', 'late A sign-in must not succeed under B');
    assert.equal(settle.code, 'stale');
    // No A-minted credential under the B target at ANY point of the stream.
    assert.ok(!anyRecordContains(recordsSinceMove(persisted, beB.url), '-A'),
      `persisted under B: ${JSON.stringify(persisted.map((r) => r.tokens?.refreshToken))}`);
    assert.ok(!beB.leaked('-A'),
      `B received A credential: ${JSON.stringify(beB.hits.filter((h) => (h.headers.authorization || '').includes('-A') || JSON.stringify(h.body || {}).includes('-A')).map((h) => h.url))}`);
    const st = hub.getState();
    assert.equal(st.principal, null);
    assert.equal(st.status, 'disconnected');
    assert.equal(st.target.url, beB.url);
  } finally {
    hub.dispose();
    await beA.close(); await beB.close();
  }
});

test('stale refresh in flight during target move cannot leak to, overwrite, or tear down connected B', async () => {
  const beA = await fakeBackend({ tokenTag: 'A', refreshDelayMs: 450 });
  const beB = await fakeBackend({ tokenTag: 'B' });
  const { hub, persisted } = hubOn();
  try {
    await hub.command('configure', { url: beA.url });
    await assert.rejects(() => hub.command('connect'), (e) => e.code === 'needs_signin');
    await hub.command('sign-in', { username: 'agent', password: 'pw' });
    assert.equal(hub.getState().status, 'ready');
    assert.equal(hub.getState().principal.userId, 'agent');
    assert.equal(beA.wsPeerCount(), 1);

    // Re-connect on A; its refresh is delayed long enough to move mid-flight.
    const staleConnect = settleOf(hub.command('connect'));
    await sleep(150); // probe/providers done; /auth/native/refresh still pending
    await hub.command('configure', { url: beB.url });
    await hub.command('sign-in', { username: 'buser', password: 'pw' }); // newest wins; waits out the stale connect
    const settle = await staleConnect;
    assert.equal(settle.outcome, 'rejected');
    assert.equal(settle.code, 'stale');

    // B came up cleanly and was never touched by A's late refresh.
    const st = hub.getState();
    assert.equal(st.status, 'ready');
    assert.equal(st.principal.userId, 'buser');
    assert.equal(st.principal.provider, 'basic');
    assert.ok(st.sessions.length >= 2, 'B session list is populated');
    assert.equal(beB.wsPeerCount(), 1, 'B socket still open — stale attempt tore nothing down');
    assert.ok(!beB.leaked('-A'), 'A refresh/bearer never reached B');
    assert.ok(!anyRecordContains(recordsSinceMove(persisted, beB.url), '-A'),
      'no A credential persisted under B');
    assert.ok(persisted.at(-1).tokens.refreshToken.includes('-B'),
      `latest persisted tokens are B's: ${persisted.at(-1).tokens.refreshToken}`);
    // Sanity: A really did receive the in-flight refresh before it was fenced.
    assert.ok(beA.hits.some((h) => h.url === '/auth/native/refresh' && JSON.stringify(h.body).includes('-A')));
  } finally {
    hub.dispose();
    await beA.close(); await beB.close();
  }
});

for (const cmd of ['sign-out', 'disconnect']) {
  test(`${cmd} during pending sign-in: late completion cannot resurrect identity`, async () => {
    const beA = await fakeBackend({ tokenTag: 'A', tokenDelayMs: 400 });
    const { hub, persisted } = hubOn();
    try {
      await hub.command('configure', { url: beA.url });
      await assert.rejects(() => hub.command('connect'), (e) => e.code === 'needs_signin');
      const pending = settleOf(hub.command('sign-in', { username: 'agent', password: 'pw' }));
      await sleep(120);
      await hub.command(cmd);
      const settle = await pending;
      assert.equal(settle.outcome, 'rejected');
      assert.equal(settle.code, 'stale');
      const st = hub.getState();
      assert.equal(st.status, 'disconnected', 'late completion must not flip status');
      assert.equal(st.principal, null);
      assert.equal(persisted.at(-1).tokens, null);
      // A resurrected connect would refresh + ticket + open a socket — none did.
      assert.ok(!beA.hits.some((h) => h.url === '/auth/native/refresh'));
      assert.ok(!beA.hits.some((h) => h.url === '/api/auth/ws-ticket'));
      assert.equal(beA.wsPeerCount(), 0);
    } finally {
      hub.dispose();
      await beA.close();
    }
  });
}

test('overlapping sign-ins on one backend: only the newest attempt persists and connects', async () => {
  const beA = await fakeBackend({ tokenTag: 'A', tokenDelayMs: 300 });
  const { hub, persisted } = hubOn();
  try {
    await hub.command('configure', { url: beA.url });
    await assert.rejects(() => hub.command('connect'), (e) => e.code === 'needs_signin');
    const older = settleOf(hub.command('sign-in', { username: 'older', password: 'pw' }));
    await sleep(80);
    const newer = settleOf(hub.command('sign-in', { username: 'newer', password: 'pw' }));
    const [o, n] = await Promise.all([older, newer]);
    assert.equal(o.outcome, 'rejected');
    assert.equal(o.code, 'stale', 'older completion must lose to the newer attempt');
    assert.equal(n.outcome, 'resolved');
    assert.ok(!anyRecordContains(persisted, 'older'), 'older-minted tokens were never persisted');
    assert.ok(persisted.at(-1).tokens.refreshToken.includes('newer'));
    const st = hub.getState();
    assert.equal(st.status, 'ready');
    assert.equal(st.principal.userId, 'newer');
    // Every credential A saw downstream belongs to the winning attempt.
    for (const h of beA.hits.filter((x) => x.url === '/auth/native/refresh')) {
      assert.ok(JSON.stringify(h.body).includes('newer'), 'refresh body is the newest attempt');
    }
    const ticket = beA.hits.filter((x) => x.url === '/api/auth/ws-ticket');
    assert.ok(ticket.length >= 1 && ticket.every((h) => h.headers.authorization.includes('newer')));
  } finally {
    hub.dispose();
    await beA.close();
  }
});

test('same-target auth still works end to end; expired stored session clears principal and tokens', async () => {
  const beA = await fakeBackend({ tokenTag: 'A' });
  const { hub, persisted } = hubOn();
  try {
    await hub.command('configure', { url: beA.url });
    await assert.rejects(() => hub.command('connect'), (e) => e.code === 'needs_signin');
    await hub.command('sign-in', { username: 'agent', password: 'pw' });
    let st = hub.getState();
    assert.equal(st.status, 'ready');
    assert.equal(st.principal.userId, 'agent');
    assert.deepEqual(st.sessions.map((s) => s.id), ['sess-1', 'sess-2']);
    assert.ok(persisted.at(-1).tokens.refreshToken.includes('rt-A-agent'));
    assert.ok(beA.hits.some((h) => h.url === '/auth/native/refresh'));
    assert.ok(beA.hits.some((h) => h.url === '/api/auth/ws-ticket' && h.headers.authorization.startsWith('Bearer at-A-')));

    // Stored-token reconnect path works on the same target.
    await hub.command('disconnect');
    await hub.command('connect');
    assert.equal(hub.getState().status, 'ready');
    assert.equal(beA.hits.filter((h) => h.url === '/auth/native/refresh').length, 2);

    // Now expire the stored session: tokens AND principal are cleared, the
    // projection honestly asks for sign-in again.
    beA.cfg.refreshStatus = 401;
    await hub.command('disconnect');
    await assert.rejects(() => hub.command('connect'), (e) => e.code === 'needs_signin');
    st = hub.getState();
    assert.equal(st.status, 'needs_signin');
    assert.equal(st.principal, null);
    assert.equal(persisted.at(-1).tokens, null);
  } finally {
    hub.dispose();
    await beA.close();
  }
});
