const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseBotFatherReply, botName, botUsername, retryUsername, validateToken, untokenedProfile, sendMessageScript, botFatherScript } = require('../src/cloud-telegram.cjs');

const TOKEN = '123456789:AAEbbCCddEEffGGhhIIjjKKllMMnnOOp';

test('a done reply parses the token out of the congratulations text', () => {
  const reply = parseBotFatherReply(`Done! Congratulations on your new bot. Use this token to access the HTTP API:\n${TOKEN}\nKeep your token secure.`);
  assert.deepEqual(reply, { type: 'token', token: TOKEN });
});

test('a taken username, a rate limit and noise each classify', () => {
  assert.equal(parseBotFatherReply('Sorry, this username is already taken.').type, 'taken');
  assert.equal(parseBotFatherReply('Sorry, this username is unavailable.').type, 'taken');
  assert.equal(parseBotFatherReply('Sorry, too many attempts. Please try again later.').type, 'rate-limit');
  assert.equal(parseBotFatherReply('Too many requests, retry later').type, 'rate-limit');
  assert.equal(parseBotFatherReply('Alright, a new bot. How are we going to call it?').type, 'unknown');
  assert.equal(parseBotFatherReply('').type, 'unknown');
});

test('the bot name is "<First>\'s Alan" and the username is <first>_alan_<4>_bot', () => {
  assert.equal(botName('Maya'), "Maya's Alan");
  const made = botUsername('Maya', () => 0);
  assert.equal(made, 'maya_alan_aaaa_bot');
  assert.match(botUsername('May A!', () => 0.5), /^maya_alan_[a-z0-9]{4}_bot$/);
  assert.match(botUsername('', () => 0), /^alan_alan_[a-z0-9]{4}_bot$/);
  assert.match(botUsername('4maya', () => 0), /^a4maya_alan_[a-z0-9]{4}_bot$/);
  assert.ok(botUsername('A'.repeat(40), () => 0).length <= 32);
});

test('retries keep the shape and add the attempt suffix, up to three', () => {
  assert.equal(retryUsername('Maya', 0, () => 0), 'maya_alan_aaaa_bot');
  assert.equal(retryUsername('Maya', 1, () => 0), 'maya_alan_aaaa_1_bot');
  assert.equal(retryUsername('Maya', 3, () => 0.999), 'maya_alan_9999_3_bot');
});

test('getMe validation accepts a real-shaped answer and rejects junk', async () => {
  const good = await validateToken(TOKEN, async (url) => {
    assert.equal(url, `https://api.telegram.org/bot${TOKEN}/getMe`);
    return { ok: true, json: async () => ({ ok: true, result: { username: 'maya_alan_aaaa_bot' } }) };
  });
  assert.deepEqual(good, { ok: true, username: 'maya_alan_aaaa_bot' });
  assert.equal((await validateToken(TOKEN, async () => ({ ok: true, json: async () => ({ ok: false }) }))).ok, false);
  assert.equal((await validateToken('not a token', async () => { throw new Error('never called'); })).ok, false);
  assert.equal((await validateToken(TOKEN, async () => { throw new Error('offline'); })).ok, false);
});

test('the env target is the first profile that does not already carry a token', () => {
  assert.equal(untokenedProfile('personal\nwork\n', ['personal']), 'work');
  assert.equal(untokenedProfile('personal\nwork\n', []), 'personal');
  assert.equal(untokenedProfile('', ['x']), '');
});

test('the driver scripts talk to @BotFather and a bot handle', () => {
  const drive = botFatherScript({ name: "Maya's Alan", username: 'maya_alan_aaaa_bot' });
  assert.match(drive, /BotFather/);
  assert.match(drive, /\/newbot/);
  const send = sendMessageScript('maya_alan_aaaa_bot', '/start');
  assert.match(send, /maya_alan_aaaa_bot/);
  assert.match(send, /\/start/);
});
