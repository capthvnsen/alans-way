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

test('generated usernames stay valid for long names and names beginning with underscores', () => {
  for (const name of ['A'.repeat(40), '_Maya', '__', '4' + 'a'.repeat(40)]) {
    for (let attempt = 0; attempt <= 3; attempt++) {
      const username = retryUsername(name, attempt, () => 0);
      assert.match(username, /^[a-z][a-z0-9_]{4,31}$/, username);
      assert.ok(username.endsWith('_bot'));
    }
    assert.match(botUsername(name, () => 0), /^[a-z][a-z0-9_]{4,31}$/);
  }
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

// Run the shipped completion transition with fixture preferences and no SSH.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const cloudTelegram = require('../src/cloud-telegram.cjs');
const { profileInventoryCommand } = require('../src/env-write.cjs');
const main = fs.readFileSync(path.join(__dirname, '../src/main.cjs'), 'utf8');
const finishSource = main.slice(main.indexOf('async function cloudFinishTelegram('), main.indexOf('// Local and remote probes for the connect step.'));
function finishFixture({ send = { ok: true }, failure, destroyed = false } = {}) {
  const prefs = { onboarded: false, cloud: { step: 'telegram' } };
  const saved = [];
  const finish = vm.runInNewContext('(' + finishSource + ')', {
    prefs, cloudTelegram, cloudWriteEnv: async () => ({ ok: true }),
    telegramView: { webContents: { isDestroyed: () => destroyed,
      executeJavaScript: async () => { if (failure) throw failure; return send; } } },
    savePreferences: () => saved.push(prefs.cloud.step), broadcast() {}, logError() {},
  });
  return { prefs, saved, finish: () => finish('fixture-token', 'fresh_bot') };
}

function remoteFinishFixture({ profiles = 'personal\nwork\n', writeCode = 0, setupCode = 0 } = {}) {
  const prefs = { onboarded: false, cloud: { step: 'telegram', tokenedProfiles: ['personal'] }, vpsBrowser: { sshHost: 'user@192.0.2.10' } };
  const calls = [];
  const context = vm.createContext({
    prefs, cloudTelegram, profileInventoryCommand, cloudModel: require('../src/cloud-model.cjs'), cloudConnect: require('../src/cloud-connect.cjs'),
    sshRun: async (host, command, options) => {
      calls.push({ host, command, options });
      if (command === profileInventoryCommand) return { code: 0, out: profiles };
      if (command.startsWith('set -eu')) return { code: setupCode, out: '' };
      return { code: 0, out: 'hermes-gateway RUNNING pid 123\n' };
    },
    sshWrite: async (host, file, value) => { calls.push({ host, file, value }); return { code: writeCode }; },
    telegramView: { webContents: { isDestroyed: () => false, executeJavaScript: async () => { calls.push({ start: true }); return { ok: true }; } } },
    savePreferences() {}, broadcast() {},
  });
  vm.runInContext(main.slice(main.indexOf('async function cloudWriteEnv('), main.indexOf('// Minted or pasted')), context);
  vm.runInContext(finishSource, context);
  return { prefs, calls, finish: () => context.cloudFinishTelegram(TOKEN, 'fresh_bot') };
}

for (const [profiles, profile] of [['personal\nwork\n', 'work'], ['', 'default']]) {
  test(`a saved bot configures exactly its ${profile} profile before restarting and sending /start`, async () => {
    const f = remoteFinishFixture({ profiles });
    assert.equal((await f.finish()).done, true);
    assert.equal(f.calls[0].command, profileInventoryCommand);
    assert.equal(f.calls[1].file, profile === 'default' ? '~/.hermes/.env' : '~/.hermes/profiles/work/.env');
    assert.equal(f.calls[1].value.key, 'TELEGRAM_BOT_TOKEN');
    assert.equal(f.calls[1].value.value, TOKEN);
    const setup = f.calls.filter(call => call.command?.startsWith('set -eu'));
    assert.equal(setup.length, 1);
    assert.equal(setup[0].host, 'user@192.0.2.10');
    assert.equal(setup[0].options.timeoutMs, 300000);
    assert.equal(setup[0].command, `set -eu
for dir in "$HOME/alans-way-agents" "$HOME/.local/share/alans-way-agents"; do
  if [ -f "$dir/setup.sh" ]; then
    exec sh "$dir/setup.sh" '--non-interactive' '--skip-browser' '--skip-plugin' '--skip-services'${profile === 'default' ? '' : ` '--profile' '${profile}'`} </dev/null
  fi
done
echo 'The installed setup.sh was not found.' >&2
exit 1`);
    assert.equal(f.calls[2], setup[0], 'setup follows the successful write');
    assert.match(f.calls[4].command, /^supervisorctl signal USR1/);
    assert.equal(f.calls[5].start, true);
  });
}

for (const writeCode of [1, -1]) {
  test(`a failed token write (${writeCode}) never runs setup or completes onboarding`, async () => {
    const f = remoteFinishFixture({ writeCode });
    const result = await f.finish();
    assert.equal(result.done, false);
    assert.match(result.detail, /env file write/);
    assert.equal(f.calls.length, 2);
    assert.equal(f.prefs.cloud.step, 'telegram');
    assert.equal(f.prefs.onboarded, false);
  });
}

for (const setupCode of [1, -1, null]) {
  test(`a failed or timed-out setup (${setupCode}) reaches the existing onboarding error UI`, async () => {
    const f = remoteFinishFixture({ setupCode });
    const result = await f.finish();
    assert.equal(result.done, false);
    assert.match(result.detail, /token was saved.*workspace browser setup failed/);
    assert.equal(f.calls.length, 3, 'no gateway restart or /start on setup failure');
    assert.equal(f.prefs.cloud.step, 'telegram');
    assert.equal(f.prefs.onboarded, false);
  });
}

test('the installed setup receives the pinned argv literally, and a missing script fails', (t) => {
  const os = require('node:os');
  const { spawnSync } = require('node:child_process');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-telegram-setup-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const profile = "work' $(touch marker)";
  const invoke = () => spawnSync('sh', ['-c', cloudTelegram.workspaceSetupCommand(profile)], { env: { ...process.env, HOME: home }, encoding: 'utf8', cwd: home });
  assert.notEqual(invoke().status, 0);
  for (const dir of ['alans-way-agents', '.local/share/alans-way-agents']) {
    const script = path.join(home, dir, 'setup.sh');
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, 'printf "%s\\n" "$@" > "$HOME/argv"\n');
    assert.equal(invoke().status, 0);
    assert.deepEqual(fs.readFileSync(path.join(home, 'argv'), 'utf8').trim().split('\n'),
      ['--non-interactive', '--skip-browser', '--skip-plugin', '--skip-services', '--profile', profile]);
    assert.equal(fs.existsSync(path.join(home, 'marker')), false);
    fs.unlinkSync(script);
  }
});
for (const [name, options] of [
  ['open failure', { send: { ok: false, error: 'Could not open @fresh_bot.' } }],
  ['missing composer', { send: { ok: false, error: 'No message box.' } }],
  ['execution failure', { failure: Error('Telegram disconnected') }],
  ['destroyed Telegram', { destroyed: true }],
]) {
  test('onboarding surfaces ' + name + ' without completing setup', async () => {
    const f = finishFixture(options);
    const result = await f.finish();
    assert.equal(result.done, false);
    assert.ok(result.detail);
    assert.equal(f.prefs.cloud.step, 'telegram');
    assert.equal(f.prefs.onboarded, false);
    assert.deepEqual(f.saved, []);
  });
}
test('onboarding finishes only after the bot chat accepts /start', async () => {
  const f = finishFixture();
  assert.equal((await f.finish()).done, true);
  assert.equal(f.prefs.cloud.step, 'done');
  assert.equal(f.prefs.onboarded, true);
  assert.deepEqual(f.saved, ['done']);
});

// Both auto-created and pasted tokens use finish; automatic creation must
// also surface BotFather resolution errors instead of retrying an ignored route.
const autoSource = main.slice(main.indexOf("      case 'cloud-telegram': {"), main.indexOf("      case 'cloud-telegram-paste': {"));
for (const failure of [false, true]) {
  test('BotFather ' + (failure ? 'execution' : 'open') + ' failure reaches onboarding immediately', async () => {
    const prefs = { cloud: { step: 'telegram' }, vpsBrowser: { sshHost: 'fixture.invalid' } };
    let attempts = 0;
    const run = vm.runInNewContext(`(async () => { switch ('cloud-telegram') { ${autoSource} } })`, {
      prefs, cloudTelegram, telegramStatus: 'connected', telegramFirstName: async () => 'Fixture',
      telegramView: { webContents: { isDestroyed: () => false, executeJavaScript: async () => {
        attempts++;
        if (failure) throw Error('Telegram disconnected');
        return { ok: false, error: 'Could not resolve @BotFather.' };
      } } },
      savePreferences() {}, broadcast() {},
    });
    const result = await run();
    assert.equal(result.done, false);
    assert.match(result.detail, failure ? /Could not open @BotFather/ : /Could not resolve @BotFather/);
    assert.equal(attempts, 1);
    assert.equal(prefs.cloud.step, 'telegram');
    assert.equal(prefs.cloud.telegramFallback, undefined);
  });
}
