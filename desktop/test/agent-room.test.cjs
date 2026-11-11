const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAgentRoom } = require('../prototypes/agent-room.js');
const { createDesktopLease } = require('../src/computer.cjs');

test('Alex and both bots share one room; only a leading owner mention schedules work', () => {
  const room = createAgentRoom();
  room.owner.post('Can @hermes and @grok compare this?');
  assert.equal(room.state().active, null);
  room.owner.post('@hermes Compare these options with Grok.');
  const first = room.state().active;
  assert.equal(first.bot, 'hermes');
  room.bots.hermes.reply(first.id, '@grok is mentioned in prose; do not wake it.');
  assert.equal(room.state().active, null);
  room.owner.post('@GROK Please review.');
  room.bots.grok.reply(room.state().active.id, 'Reviewed.');
  assert.deepEqual(room.state().messages.map(row => row.author), ['alex', 'alex', 'hermes', 'alex', 'grok']);
});

test('explicit handoff preserves the root task and consumes its predecessor exactly once', () => {
  const room = createAgentRoom();
  room.owner.post('@hermes Prepare an approach.');
  const first = room.state().active;
  assert.throws(() => room.bots.grok.reply(first.id, 'Impersonation'), { code: 'stale_turn' });
  room.bots.hermes.reply(first.id, 'Grok, review this approach.', 'grok');
  const next = room.state().active;
  assert.equal(next.bot, 'grok');
  assert.equal(next.rootId, first.rootId);
  assert.equal(next.number, 2);
  assert.throws(() => room.bots.hermes.reply(first.id, 'Replay', 'grok'), { code: 'stale_turn' });
  assert.deepEqual(room.state().active, next);
  room.bots.grok.reply(next.id, 'Done.');
  assert.equal(room.state().active, null);
});

test('a ping-pong chain stops after six turns; bot text and unaddressed owner posts cannot reset it', () => {
  const room = createAgentRoom();
  room.owner.post('@hermes Collaborate with Grok.');
  for (let turn = 1; turn <= 6; turn++) {
    const current = room.state().active;
    assert.equal(current.number, turn);
    room.owner.post('Keep the original budget.');
    room.bots[current.bot].reply(current.id, '@hermes @grok Continue!', current.bot === 'hermes' ? 'grok' : 'hermes');
  }
  assert.equal(room.state().active, null);
  assert.equal(room.state().turns, 6);
  assert.match(room.state().messages.at(-1).text, /Six turns reached/);
  assert.throws(() => room.bots.hermes.reply('turn-1', 'Reset the budget'), { code: 'stale_turn' });
  room.owner.post('@grok Start a new task.');
  assert.equal(room.state().active.number, 1);
});

test('pause fences replies and tool eligibility; resume never replays a cancelled turn', () => {
  const room = createAgentRoom();
  room.owner.post('@hermes Start.');
  const first = room.state().active;
  room.bots.hermes.assertTurn(first.id);
  room.owner.pause();
  assert.equal(room.state().active, null);
  assert.throws(() => room.bots.hermes.assertTurn(first.id), { code: 'paused' });
  assert.throws(() => room.bots.hermes.reply(first.id, 'Late reply', 'grok'), { code: 'paused' });
  assert.throws(() => room.owner.post('@grok Work while paused'), { code: 'paused' });
  room.owner.post('A note while paused.');
  room.owner.resume();
  assert.equal(room.state().active, null);
  assert.throws(() => room.bots.hermes.reply(first.id, 'Late after resume'), { code: 'stale_turn' });
  room.owner.post('@hermes Continue explicitly.');
  assert.notEqual(room.state().active.id, first.id);
  assert.throws(() => room.bots.hermes.assertTurn(first.id), { code: 'stale_turn' });
});

test('a new addressed owner instruction invalidates an in-flight bot turn', () => {
  const room = createAgentRoom();
  room.owner.post('@hermes Start.');
  const first = room.state().active;
  room.owner.post('@grok Change of plan.');
  assert.throws(() => room.bots.hermes.reply(first.id, 'Old result'), { code: 'stale_turn' });
  assert.equal(room.state().active.bot, 'grok');
  assert.equal(room.state().active.number, 1);
});

test('invalid recipients and text reject before altering the room', () => {
  const room = createAgentRoom();
  for (const text of ['', '  ', null, 'x'.repeat(4001)])
    assert.throws(() => room.owner.post(text), { code: 'bad_text' });
  for (const text of ['@both Do it.', '@toString Do it.', '@hermes @grok Do it.', '@hermes   @grok Do it.'])
    assert.throws(() => room.owner.post(text), { code: 'bad_recipient' });
  assert.equal(room.state().messages.length, 0);
  room.owner.post('@hermes Start.');
  const before = room.state();
  for (const to of ['alex', 'hermes', 'toString', '', 1, {}])
    assert.throws(() => room.bots.hermes.reply(before.active.id, 'Invalid handoff', to), { code: 'bad_recipient' });
  assert.throws(() => room.bots.hermes.reply(before.active.id, ''), { code: 'bad_text' });
  assert.deepEqual(room.state(), before);
});

test('bounded display state cannot be mutated to mint a turn or resume a paused room', () => {
  const room = createAgentRoom();
  const text = '<img src=x onerror=alert(1)> @grok';
  room.owner.post(text);
  for (let n = 0; n < 110; n++) room.owner.post(`Note ${n}`);
  const copy = room.state();
  assert.equal(copy.messages.length, 100);
  assert.equal(copy.droppedMessages, 11);
  copy.active = { id: 'invented', bot: 'grok' };
  copy.messages[0].author = 'grok';
  assert.equal(room.state().active, null);
  assert.equal(room.state().messages[0].author, 'alex');
  assert.throws(() => room.bots.grok.reply('invented', 'Forge'), { code: 'stale_turn' });
  room.owner.post(text);
  assert.equal(room.state().messages.at(-1).text, text);
});

test('room handoff grants no desktop lease; existing lease still blocks the successor', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const room = createAgentRoom();
  const lease = createDesktopLease();
  room.owner.post('@hermes Prepare a desktop task.');
  const first = room.state().active;
  room.bots.hermes.assertTurn(first.id);
  assert.equal(lease.take('hermes', 'Hermes'), null);
  room.bots.hermes.reply(first.id, 'Ready for review.', 'grok');
  room.bots.grok.assertTurn(room.state().active.id);
  assert.equal(lease.take('grok', 'Grok Bot').error, 'desktop_busy');
  t.mock.timers.tick(30000);
  assert.equal(lease.take('grok', 'Grok Bot').error, 'desktop_busy', 'active input cannot be stolen');
  lease.release('hermes');
  t.mock.timers.tick(19999);
  assert.equal(lease.take('grok', 'Grok Bot').error, 'desktop_busy');
  t.mock.timers.tick(1);
  assert.equal(lease.take('grok', 'Grok Bot'), null);
  lease.release('grok');
});

test('a leading mention followed by punctuation still routes to that bot', () => {
  for (const [text, bot] of [['@hermes, hi', 'hermes'], ['@grok: review this', 'grok'], ['@Hermes. Draft it', 'hermes'], ['@grok! check', 'grok'], ['@hermes,', 'hermes']]) {
    const room = createAgentRoom();
    const state = room.owner.post(text);
    assert.equal(state.active.bot, bot, text);
    assert.equal(state.messages.at(-1).to, bot, text);
  }
  const room = createAgentRoom();
  assert.throws(() => room.owner.post('@hermes, @grok both'), { code: 'bad_recipient' });
  assert.throws(() => room.owner.post('@bob, hi'), { code: 'bad_recipient' });
  assert.throws(() => room.owner.post('@hermes;; hi'), { code: 'bad_recipient' });
  assert.equal(room.state().messages.length, 0);
});
