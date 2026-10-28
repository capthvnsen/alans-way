'use strict';

// Offline policy prototype. Only a trusted adapter may hold the owner handle;
// these local handles model identity binding, not authentication or tool access.
function createAgentRoom() {
  const names = { hermes: 'Hermes', grok: 'Grok Bot' };
  const maxTurns = 6;
  let paused = false;
  let active = null;
  let turns = 0;
  let turnSequence = 0;
  let messageSequence = 0;
  let droppedMessages = 0;
  const messages = [];
  const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
  const isBot = id => Object.hasOwn(names, id);
  function checkText(text) {
    if (typeof text !== 'string' || !text.trim() || text.length > 4000)
      fail('bad_text', 'Write between 1 and 4000 characters.');
  }
  function append(author, text, extra = {}) {
    const row = { id: ++messageSequence, author, text, ...extra };
    messages.push(row);
    if (messages.length > 100) { messages.shift(); droppedMessages++; }
    return row;
  }
  const state = () => structuredClone({ paused, active, turns, maxTurns, messages, droppedMessages });
  function schedule(bot, rootId) {
    active = { id: `turn-${++turnSequence}`, bot, rootId, number: ++turns };
  }
  function assertTurn(bot, turnId) {
    if (paused) fail('paused', 'Alex paused the room.');
    if (!active || active.bot !== bot || active.id !== turnId)
      fail('stale_turn', 'This turn is no longer assigned to this bot.');
  }
  const bots = Object.fromEntries(Object.keys(names).map(bot => [bot, Object.freeze({
    assertTurn: turnId => assertTurn(bot, turnId),
    reply(turnId, text, handoffTo = null) {
      assertTurn(bot, turnId);
      checkText(text);
      if (handoffTo !== null && (!isBot(handoffTo) || handoffTo === bot))
        fail('bad_recipient', 'Hand off to the other room bot.');
      const completed = active;
      append(bot, text, { turnId, rootId: completed.rootId, handoffTo });
      active = null;
      if (handoffTo !== null) {
        if (turns < maxTurns) schedule(handoffTo, completed.rootId);
        else append('system', 'Six turns reached. Alex must send a new @mention to continue.');
      }
      return state();
    },
  })]));
  return Object.freeze({
    state,
    bots: Object.freeze(bots),
    owner: Object.freeze({
      post(text) {
        checkText(text);
        const mention = /^@([^\s]+)(?:\s|$)/.exec(text);
        const to = mention ? mention[1].toLowerCase() : null;
        if (to !== null && !isBot(to)) fail('bad_recipient', 'Start with @hermes or @grok.');
        if (to !== null && /^@(hermes|grok)(?:\s|$)/i.test(text.slice(mention[0].length).trimStart()))
          fail('bad_recipient', 'Address one bot per message.');
        if (to !== null && paused) fail('paused', 'Resume the room before addressing a bot.');
        const row = append('alex', text, { to });
        if (to !== null) {
          turns = 0;
          schedule(to, row.id);
        }
        return state();
      },
      pause() {
        if (!paused) {
          paused = true;
          active = null;
          append('system', 'Alex paused the room. Pending turns are cancelled.');
        }
        return state();
      },
      resume() {
        if (paused) {
          paused = false;
          append('system', 'Alex resumed the room. Send a new @mention to continue.');
        }
        return state();
      },
    }),
  });
}

// shortcut: memory-only room, add durable admission before connecting real agents.
if (typeof module !== 'undefined') module.exports = { createAgentRoom };
else globalThis.createAgentRoom = createAgentRoom;
