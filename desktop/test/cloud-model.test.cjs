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
  assert.equal(gatewayRestartCommand(status), `supervisorctl restart 'hermes-gateway'`);
  assert.equal(gatewayRestartCommand(''), `supervisorctl restart 'hermes-gateway'`);
});

test('a hostile program name is single-quoted before it reaches the remote shell', () => {
  assert.equal(gatewayRestartCommand('gateway$(rm -rf ~)              RUNNING\n'), `supervisorctl restart 'gateway$(rm'`);
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
