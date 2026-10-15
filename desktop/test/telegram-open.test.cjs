const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { sanitizeBots } = require('../src/core.cjs');
const { openUsernameScript } = require('../src/telegram-open.cjs');

// Exercise the shipped command, including its old hash path, without loading
// the app, a real Telegram session, or any preferences.
const source = fs.readFileSync(path.join(__dirname, '../src/main.cjs'), 'utf8');
const command = source.slice(source.indexOf("      case 'open-username': {"), source.indexOf("      default: throw new Error('Unknown workspace command.');"));
const hash = source.slice(source.indexOf('async function openTelegramHash('), source.indexOf('// The guest script narrates phases'));
const helper = source.slice(source.indexOf('let openingTelegramUsername = false;'), source.indexOf('// Changing only the hash'));
function fixture({ result, failure } = {}) {
  const prefs = { selectedBotId: 'old-bot', bots: [] };
  let navigations = 0;
  const run = vm.runInNewContext(`(async value => {
    ${hash}
    ${helper}
    switch ('open-username') { ${command} }
    return getState();
  })`, {
    prefs, TELEGRAM: 'https://web.telegram.org/a/', telegramStatus: 'connected', sanitizeBots, openUsernameScript,
    telegramView: { webContents: { getURL: () => 'https://web.telegram.org/a/',
      loadURL: async () => { navigations++; if (failure) throw failure; },
      executeJavaScript: async () => { if (failure) throw failure; return result; }, isDestroyed: () => false } },
    boundedJs: (wc, script) => wc.executeJavaScript(script),
    selectAgent: id => { prefs.selectedBotId = id; }, savePreferences: () => {},
    watchChange: () => {}, broadcastNow: () => {}, getState: () => ({ selectedBotId: prefs.selectedBotId }),
  });
  return { run: username => run({ username }), prefs, navigations: () => navigations };
}

test('a blank chat is a command failure and preserves the current bot', async () => {
  const f = fixture();
  await assert.rejects(f.run('alanfresh4060_bot'), /could not open/);
  assert.equal(f.prefs.selectedBotId, 'old-bot');
  assert.equal(f.navigations(), 0, 'username resolution must not use an ignored hash');
});
test('Telegram execution failures reach the caller', async () => {
  const f = fixture({ failure: Error('Telegram is offline') });
  await assert.rejects(f.run('@alanfresh4060_bot'), /offline/);
  assert.equal(f.prefs.selectedBotId, 'old-bot');
});
test('only a confirmed open acknowledges success', async () => {
  const f = fixture({ result: { ok: true, bot: { id: '123', isBot: true, username: 'alanfresh4060_bot' } } });
  const result = await f.run('@alanfresh4060_bot');
  assert.equal(result.ok, true);
  assert.equal(f.prefs.selectedBotId, '123');
  assert.equal(f.navigations(), 0);
  assert.equal(f.prefs.bots[0].isBot, true);
});
test('a success for a different username or an unverified user is refused', async () => {
  for (const bot of [{ id: '123', isBot: true, username: 'another_bot' }, { id: '123', username: 'alanfresh4060_bot' }]) {
    const f = fixture({ result: { ok: true, bot } });
    await assert.rejects(f.run('alanfresh4060_bot'), /could not open/);
    assert.equal(f.prefs.selectedBotId, 'old-bot');
    assert.equal(f.prefs.bots.length, 0);
  }
});
test('a page resolution error reaches the caller', async () => {
  const f = fixture({ result: { ok: false, error: 'Username was not found' } });
  await assert.rejects(f.run('alanfresh4060_bot'), /not found/);
});

const renderer = fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8');
const modal = renderer.slice(renderer.indexOf('function showAddBot()'), renderer.indexOf("$('search-toggle').onclick"));
function modalFixture(command) {
  const nodes = [];
  let closes = 0;
  const element = (tag, cls, text = '') => {
    const el = { tag, textContent: text, disabled: false, isConnected: true, value: '@alanfresh4060_bot',
      append: () => {}, setAttribute: (key, value) => { el[key] = value; }, focus: () => {} };
    nodes.push(el); return el;
  };
  const show = vm.runInNewContext(`(${modal})`, { element, openModal: () => {}, closeModal: () => closes++, $: () => ({ append: () => {} }), api: { command } });
  show();
  return { nodes, form: nodes.find(n => n.tag === 'form'), error: nodes.find(n => n.role === 'alert'),
    button: nodes.find(n => n.tag === 'button'), input: nodes.find(n => n.tag === 'input'), closes: () => closes };
}
test('modal stays open with an inline error and can retry after failure', async () => {
  let success = false;
  const f = modalFixture(async () => { if (!success) throw Error("Error invoking remote method 'workspace:command': Error: Bot could not be resolved"); return { ok: true }; });
  await f.form.onsubmit({ preventDefault() {} });
  assert.equal(f.closes(), 0);
  assert.equal(f.error.textContent, 'Bot could not be resolved');
  assert.equal(f.button.disabled, false);
  assert.equal(f.input.disabled, false);
  success = true;
  await f.form.onsubmit({ preventDefault() {} });
  assert.equal(f.closes(), 1);
});
test('modal waits for explicit success and suppresses duplicate submissions', async () => {
  let finish, calls = 0;
  const f = modalFixture(() => { calls++; return new Promise(resolve => { finish = resolve; }); });
  const pending = f.form.onsubmit({ preventDefault() {} });
  assert.equal(f.button.disabled, true);
  assert.equal(f.input.disabled, true);
  await f.form.onsubmit({ preventDefault() {} });
  assert.equal(calls, 1);
  finish({ selectedBotId: 'old-bot' });
  await pending;
  assert.equal(f.closes(), 0, 'a truthy workspace state does not prove a chat opened');
  assert.match(f.error.textContent, /did not open/);
});
test('invalid usernames never reach Telegram', async () => {
  const f = fixture();
  await assert.rejects(f.run('bot?start=payload'), /username/);
  assert.equal(f.prefs.selectedBotId, 'old-bot');
});
