const test = require('node:test');
const assert = require('node:assert/strict');
const { createVoiceMode } = require('../src/voice-mode.cjs');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A fake hidden view: captures control messages, pretends to load instantly.
function fakeView() {
  const sent = [];
  const wc = { send: (_channel, message) => sent.push(message), loadURL: async () => {}, isDestroyed: () => false };
  return { sent, webContents: wc, setBackgroundColor() {}, setBounds() {} };
}

function harness(prefs = {}) {
  const state = { selectedBotId: '42', voice: {}, ...prefs };
  const sent = [], drafts = [];
  let view;
  const vm = createVoiceMode({
    getView: () => ({ webContents: {} }),
    telegramSend: { send: async (botId, text) => sent.push([botId, text]), insertDraft: async (botId, text) => drafts.push([botId, text]) },
    openBot: async () => {},
    hostWindow: () => ({ contentView: { addChildView() {} } }),
    getPrefs: () => state,
    savePrefs: () => {},
    broadcast: () => {},
    electron: {
      WebContentsView: class { constructor() { view = fakeView(); Object.assign(this, view); } },
      systemPreferences: { askForMediaAccess: async () => true },
    },
  });
  // Commands that touch the view block in ensureReady() until the view reports
  // its models are loaded — so issue the command, let the view instantiate,
  // then drive the ready events and collect the result.
  const run = async (name, value) => {
    const pending = vm.command(name, value);
    await sleep(10);
    vm.onViewEvent({ type: 'view-ready' });
    vm.onViewEvent({ type: 'ready' });
    return pending;
  };
  return { vm, state, sent, drafts, controls: () => view.sent, run };
}

test('dictation inserts a composer draft instead of sending', async () => {
  const { vm, sent, drafts, run } = harness();
  await run('voice-dictation');
  vm.onViewEvent({ type: 'utterance', id: 1, text: 'hello there' });
  assert.deepEqual(drafts, [['42', 'hello there ']]);
  assert.equal(sent.length, 0);
  await run('voice-dictation'); // toggle off
  assert.equal(vm.describe().dictating, false);
});

test('call sends prefixed transcripts and the start notice', async () => {
  const { vm, sent, run } = harness();
  await run('voice-call');
  assert.equal(sent.length, 1);
  assert.match(sent[0][1], /Voice call started/);
  vm.onBotMessage({ chatId: '42', id: 1, text: 'Go ahead.', edited: false });
  await sleep(1400);
  vm.onViewEvent({ type: 'utterance', id: 1, text: 'what time is it' });
  assert.equal(sent.at(-1)[1], '🎙 what time is it');
  await vm.endCall();
  assert.match(sent.at(-1)[1], /Voice call ended/);
  assert.equal(vm.describe().callActive, false);
});

test('a second utterance while a reply is pending queues locally', async () => {
  const { vm, sent, run } = harness();
  await run('voice-call');
  // The bot's answer to the call-start notice clears the outstanding send.
  vm.onBotMessage({ chatId: '42', id: 0, text: 'Hey!', edited: false });
  await sleep(1400);
  vm.onViewEvent({ type: 'utterance', id: 1, text: 'first' });
  await sleep(50);
  assert.equal(sent.at(-1)[1], '🎙 first');
  // Bot is still working on "first" — this must queue, not replace the pending turn.
  vm.onViewEvent({ type: 'utterance', id: 2, text: 'second' });
  assert.equal(sent.filter(([, t]) => t === '🎙 second').length, 0);
  assert.equal(vm.describe().queued, 1);
  // Reply arrives → queue drains one at a time.
  vm.onBotMessage({ chatId: '42', id: 2, text: 'Done with first.', edited: false });
  await sleep(1400);
  assert.equal(sent.at(-1)[1], '🎙 second');
  assert.equal(vm.describe().queued, 0);
  await vm.endCall();
});

test('messages from other chats and empty texts are ignored', async () => {
  const { vm, run, controls } = harness();
  await run('voice-call');
  const before = controls().length;
  vm.onBotMessage({ chatId: '99', id: 1, text: 'wrong chat', edited: false });
  vm.onBotMessage({ chatId: '42', id: 2, text: '', edited: false });
  await sleep(1400);
  assert.deepEqual(controls().slice(before).filter((m) => m.type === 'speak'), []);
  await vm.endCall();
});

test('bot replies get spoken after the quiet period', async () => {
  const { vm, run, controls } = harness();
  await run('voice-call');
  const before = controls().length;
  vm.onBotMessage({ chatId: '42', id: 1, text: 'Here is the reply.', edited: false });
  // An edit burst inside the quiet window resets the timer — still one speak job.
  vm.onBotMessage({ chatId: '42', id: 1, text: 'Here is the reply, edited.', edited: true });
  await sleep(1400);
  const speaks = controls().slice(before).filter((m) => m.type === 'speak');
  assert.equal(speaks.length, 1);
  assert.match(speaks[0].text, /reply, edited/);
  await vm.endCall();
});
