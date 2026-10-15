const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setEnvValue, gatewayProgram, gatewayRestartCommand, authLoginCommand, extractAuthUrl, authLoggedIn, envPathFor, chooseProfile } = require('../src/cloud-model.cjs');

test('replacing a line keeps every other line byte-identical', () => {
  const before = '# comment\nTELEGRAM_BOT_TOKEN=abc\nANTHROPIC_API_KEY=old\nexport OTHER=1\n';
  const after = setEnvValue(before, 'ANTHROPIC_API_KEY', 'sk-ant-new');
  assert.equal(after, `# comment\nTELEGRAM_BOT_TOKEN=abc\nANTHROPIC_API_KEY='sk-ant-new'\nexport OTHER=1\n`);
});

test('a missing key appends one line at the end', () => {
  assert.equal(setEnvValue('A=1\n', 'B', '2'), `A=1\nB='2'\n`);
  assert.equal(setEnvValue('A=1', 'B', '2'), `A=1\nB='2'\n`);
  assert.equal(setEnvValue('', 'B', '2'), `B='2'\n`);
});

test('values are single-quoted so spaces and dollar signs stay literal', () => {
  assert.equal(setEnvValue('', 'ANTHROPIC_API_KEY', `sk-'$HOME;x`), `ANTHROPIC_API_KEY='sk-'\\''$HOME;x'\n`);
});

test('ANTHROPIC_BASE_URL is never written', () => {
  assert.equal(setEnvValue('ANTHROPIC_API_KEY=x\n', 'ANTHROPIC_BASE_URL', 'https://evil'), 'ANTHROPIC_API_KEY=x\n');
});

const status = `hermes-db                         EXITED    Oct 07 10:38 PM\nhermes-gateway                    RUNNING   pid 28478\nhoncho-api                        RUNNING   pid 19263\n`;

test('the gateway program is read from supervisorctl output, else hermes-gateway', () => {
  assert.equal(gatewayProgram(status), 'hermes-gateway');
  assert.equal(gatewayProgram('sshd                            RUNNING\n'), 'hermes-gateway');
  assert.equal(gatewayRestartCommand(status), `supervisorctl signal USR1 'hermes-gateway' || supervisorctl restart 'hermes-gateway'`);
  assert.equal(gatewayRestartCommand(''), `supervisorctl signal USR1 'hermes-gateway' || supervisorctl restart 'hermes-gateway'`);
});

test('a hostile program name is single-quoted before it reaches the remote shell', () => {
  assert.equal(gatewayRestartCommand('gateway$(rm -rf ~)              RUNNING\n'), `supervisorctl signal USR1 'gateway$(rm' || supervisorctl restart 'gateway$(rm'`);
});

test('the subscription login is the hermes oauth flow', () => {
  assert.equal(authLoginCommand(), 'hermes auth add anthropic --type oauth');
});

test('the sign-in URL is lifted from the login output', () => {
  assert.equal(extractAuthUrl('Visit https://nous.example/oauth/authorize?client_id=abc to sign in\n'), 'https://nous.example/oauth/authorize?client_id=abc');
  assert.equal(extractAuthUrl('no link here'), '');
});

test('auth status answers whether the login finished', () => {
  assert.equal(authLoggedIn('anthropic: logged in'), true);
  assert.equal(authLoggedIn('anthropic: not configured'), false);
  assert.equal(authLoggedIn('anthropic: not logged in'), false, 'the negation is not a login');
  assert.equal(authLoggedIn('anthropic: never logged in'), false);
  assert.equal(authLoggedIn('anthropic: logged in\nother: not logged in'), true);
  assert.equal(authLoggedIn(''), false);
});

test('only the exact provider form counts, not prose that mentions logging in', () => {
  assert.equal(authLoggedIn('logged in, do not close this window'), false);
  assert.equal(authLoggedIn('anthropic: logged in, do not restart'), false);
  assert.equal(authLoggedIn('all providers logged in'), false);
  assert.equal(authLoggedIn('anthropic:logged in'), true);
});

test('the env file for a profile sits in its directory; bare home falls back', () => {
  assert.equal(envPathFor('personal'), '~/.hermes/profiles/personal/.env');
  assert.equal(envPathFor(''), '~/.hermes/.env');
  assert.equal(chooseProfile('f4f\npersonal\n'), 'f4f');
  assert.equal(chooseProfile(''), '');
});


test('existing model probe queries only provider and default model, without reading credentials', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { execFileSync } = require('node:child_process');
  const { existingModelCommand, parseExistingModel } = require('../src/cloud-model.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alan-model-probe-'));
  try {
    fs.writeFileSync(path.join(dir, 'hermes'), `#!/bin/sh
case "$*" in
  'config get model.provider') echo openrouter ;;
  'config get model.default') echo openai/gpt-4.1 ;;
  *) exit 99 ;;
esac
`, { mode: 0o700 });
    const out = execFileSync('/bin/sh', ['-c', existingModelCommand()], { env: { PATH: dir }, timeout: 1000, encoding: 'utf8' });
    assert.deepEqual(parseExistingModel({ code: 0, out }), { provider: 'openrouter', model: 'openai/gpt-4.1' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('only successful, explicit model identifiers are persisted or displayed', () => {
  const { parseExistingModel } = require('../src/cloud-model.cjs');
  for (const out of ['', 'None\nNone', 'auto\nopenai/gpt-4.1', 'openrouter\nnull', 'openrouter\n',
    'warning\nopenrouter\nopenai/gpt-4.1', 'openrouter\nsk-fixture-private', 'openrouter\nhttps://example.com',
    'openrouter\n<model>', 'open router\nopenai/gpt-4.1']) {
    assert.equal(parseExistingModel({ code: 0, out }), null, out);
  }
  assert.equal(parseExistingModel({ code: 1, out: 'openrouter\nopenai/gpt-4.1' }), null);
  assert.deepEqual(parseExistingModel({ code: 0, out: 'openrouter\r\nopenai/gpt-4.1\r\n' }), { provider: 'openrouter', model: 'openai/gpt-4.1' });
});
