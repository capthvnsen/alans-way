const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { staleConnectorCopy, bundledConnectorReachable, buildFindings } = require('../src/setup-check.cjs');

function userData(connectorPackage) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-check-'));
  if (connectorPackage !== undefined) {
    fs.mkdirSync(path.join(dir, 'connector'));
    fs.writeFileSync(path.join(dir, 'connector', 'package.json'), connectorPackage);
  }
  return dir;
}

test('an older connector copy is stale; same, newer, missing and unreadable copies are kept', () => {
  const older = userData(JSON.stringify({ version: '0.3.2' }));
  assert.equal(staleConnectorCopy(older, '0.4.0'), path.join(older, 'connector'));
  assert.equal(staleConnectorCopy(userData(JSON.stringify({ version: '0.4.0' })), '0.4.0'), null);
  assert.equal(staleConnectorCopy(userData(JSON.stringify({ version: '0.4.1' })), '0.4.0'), null);
  assert.equal(staleConnectorCopy(userData(), '0.4.0'), null);
  assert.equal(staleConnectorCopy(userData('{not json'), '0.4.0'), null);
  assert.equal(staleConnectorCopy(userData(JSON.stringify({ name: 'no-version' })), '0.4.0'), null);
});

test('the bundled connector counts as reachable only where the router looks for it', () => {
  const reachable = (platform, execPath, isPackaged = true) => bundledConnectorReachable({ platform, isPackaged, execPath, home: '/home/you' });
  assert.equal(reachable('darwin', '/Applications/Open Alan.app/Contents/MacOS/Open Alan'), true);
  assert.equal(reachable('darwin', '/Applications/alans-way-localapp.app/Contents/MacOS/alans-way-localapp'), true);
  assert.equal(reachable('darwin', '/Users/you/Downloads/Open Alan.app/Contents/MacOS/Open Alan'), false);
  assert.equal(reachable('darwin', '/Users/you/Applications/Open Alan.app/Contents/MacOS/Open Alan'), false, '~/Applications is not on the router list');
  assert.equal(reachable('darwin', '/Applications/Open Alan 2.app/Contents/MacOS/Open Alan'), false, 'a renamed bundle');
  assert.equal(reachable('darwin', '/Applications/Open Alan.app/Contents/MacOS/Open Alan', false), false, 'a dev run');
  assert.equal(reachable('linux', '/opt/alans-way-localapp-linux-x64/alans-way-localapp'), true);
  assert.equal(reachable('linux', '/home/you/.local/share/alans-way-localapp/alans-way-localapp'), true);
  assert.equal(reachable('linux', '/home/you/Downloads/alans-way-localapp-linux-x64/alans-way-localapp'), false);
  assert.equal(reachable('linux', '/opt/alans-way-localapp/alans-way-localapp', false), false, 'a dev run');
  assert.equal(reachable('win32', 'C:\\Program Files\\Open Alan\\Open Alan.exe'), false);
});

const healthyServer = (over = {}) => ({
  ok: true, version: '0.4.0', hostVersion: '0.4.0', pluginTag: 'v0.7.0', error: '',
  verify: { ran: true, fails: [], warns: [] },
  profiles: [{ profile: 'default', computerBackend: 'alans-way-computer',
    plugins: [{ name: 'alans-way', version: '0.7.0', class: 'catalog', updateAvailable: false }], checked: true }],
  ...over,
});
const healthy = (over = {}) => ({
  appVersion: '0.4.0', platform: 'darwin',
  local: { telegram: 'connected', inApplications: true, permissions: { accessibility: true, screen: 'granted' }, staleConnector: null },
  connection: { addresses: { server: 'me@vps', computer: 'me@mac' }, reach: { ok: true, detail: '' }, back: { ok: true, detail: '' } },
  server: healthyServer(),
  ...over,
});
const byTitle = (findings, pattern) => findings.find((f) => pattern.test(f.title));

test('a healthy Mac setup is all ok and offers no actions', () => {
  const findings = buildFindings(healthy());
  assert.ok(findings.length >= 10);
  assert.deepEqual(findings.filter((f) => f.level !== 'ok'), []);
  assert.deepEqual(findings.filter((f) => f.action), []);
  assert.deepEqual([...new Set(findings.map((f) => f.group))], ['computer', 'connection', 'server']);
});

test('local problems carry their fix actions; non-Mac platforms skip the Mac-only rows', () => {
  const findings = buildFindings(healthy({ local: { telegram: 'login', inApplications: false,
    permissions: { accessibility: false, screen: 'denied' }, staleConnector: '/x/connector' } }));
  assert.equal(byTitle(findings, /Telegram/).level, 'fail');
  assert.equal(byTitle(findings, /Applications/).action, 'move-to-applications');
  assert.equal(byTitle(findings, /Accessibility/).action, 'open-accessibility');
  assert.equal(byTitle(findings, /Screen Recording/).action, 'open-screen');
  assert.equal(byTitle(findings, /connector/i).action, 'remove-old-connector');
  const linux = buildFindings(healthy({ platform: 'linux', local: { telegram: 'connected', inApplications: null, permissions: null, staleConnector: null } }));
  assert.equal(byTitle(linux, /Applications|Accessibility|Screen Recording/), undefined);
});

test('an unreachable server fails the connection and skips every server check', () => {
  const findings = buildFindings(healthy({
    connection: { addresses: { server: 'me@vps', computer: 'me@mac' }, reach: { ok: false, detail: 'Connection refused' }, back: null },
    server: null }));
  assert.equal(byTitle(findings, /reach the server/).level, 'fail');
  assert.match(byTitle(findings, /reach the server/).fix, /Connection refused/);
  const server = findings.filter((f) => f.group === 'server');
  assert.equal(server.length, 1);
  assert.equal(server[0].level, 'fail');
  assert.match(server[0].title, /skipped/);
});

test('missing addresses are reported before any reach check', () => {
  const findings = buildFindings(healthy({ connection: { addresses: { server: '', computer: '' }, reach: null, back: null }, server: null }));
  assert.equal(byTitle(findings, /server address/).level, 'fail');
  assert.equal(byTitle(findings, /computer.s address/).level, 'fail');
});

test('a server behind the app, or with its browser down, offers the update', () => {
  const behind = buildFindings(healthy({ server: healthyServer({ version: '0.3.2', hostVersion: '0.3.2' }) }));
  assert.equal(byTitle(behind, /older version/).action, 'update-server');
  const down = buildFindings(healthy({ server: healthyServer({ hostVersion: '' }) }));
  assert.equal(byTitle(down, /browser is not running/).action, 'update-server');
});

test('plugin freshness: the catalog pin is the published version, other installs compare to the newest tag', () => {
  const plugin = (p, tag = 'v0.7.0') => buildFindings(healthy({ server: healthyServer({ pluginTag: tag,
    profiles: [{ ...healthyServer().profiles[0], plugins: [p] }] }) }));
  const row = (findings) => byTitle(findings, /alans-way/);
  assert.equal(row(plugin({ name: 'alans-way', version: '0.6.2', class: 'catalog', updateAvailable: true })).action, 'update-server');
  assert.equal(row(plugin({ name: 'alans-way', version: '0.6.2', class: 'catalog', updateAvailable: false })).level, 'ok',
    'a newer GitHub tag the catalog has not picked up is not a problem');
  assert.equal(row(plugin({ name: 'alans-way', version: '0.6.2', class: 'drift', updateAvailable: false })).action, 'update-server');
  assert.equal(row(plugin({ name: 'alans-way', version: '0.7.1', class: '', updateAvailable: false })).level, 'ok',
    'a dev install newer than the newest tag is up to date');
  assert.match(row(plugin({ name: 'alans-way', version: '0.7.0', class: '', updateAvailable: false }, '')).title, /Couldn.t check/);
  const unknown = row(plugin({ name: 'alans-way', version: '0.6.2', class: 'catalog', updateAvailable: null }));
  assert.equal(unknown.title, 'Couldn’t check alans-way for updates');
  assert.equal(unknown.level, 'warn');
  assert.match(row(plugin({ name: 'alans-way', version: '0.6.2', class: 'catalog' })).title, /Couldn.t check/, 'no answer is not an answer');
});

test('a profile the time budget did not reach gets one row and no plugin or backend rows', () => {
  const late = { profile: 'work', computerBackend: '', plugins: [{ name: 'alans-way', version: '0.6.0', class: '', updateAvailable: null }], checked: false };
  const findings = buildFindings(healthy({ server: healthyServer({ profiles: [healthyServer().profiles[0], late] }) }));
  const work = findings.filter((f) => f.title.startsWith('work: '));
  assert.deepEqual(work.map(({ level, title, fix }) => ({ level, title, fix })),
    [{ level: 'warn', title: 'work: Not checked (out of time)', fix: 'Check again later.' }]);
  const only = buildFindings(healthy({ server: healthyServer({ profiles: [{ ...late, profile: 'default' }] }) }));
  assert.equal(byTitle(only, /^Not checked/).level, 'warn');
  assert.equal(byTitle(only, /alans-way|Computer use/), undefined);
});

test('the built-in computer-use backend, the setup audit and the time budget each show up', () => {
  const findings = buildFindings(healthy({ server: healthyServer({ profiles: [{ profile: 'default', computerBackend: '', plugins: [], checked: true }],
    verify: { ran: true, fails: ['browser host not running'], warns: ['no primary route bound'] } }) }));
  assert.equal(byTitle(findings, /built-in/).level, 'warn');
  assert.equal(byTitle(findings, /browser host not running/).level, 'fail');
  assert.equal(byTitle(findings, /no primary route bound/).level, 'warn');
  const late = byTitle(buildFindings(healthy({ server: healthyServer({ verify: { ran: false, reason: 'time' } }) })), /audit/);
  assert.equal(late.title, 'Setup audit not run (out of time)');
  assert.equal(late.fix, 'Check again later.');
  assert.match(byTitle(buildFindings(healthy({ server: healthyServer({ verify: { ran: false, reason: 'no-setup' } }) })), /audit/).title, /not available/);
});

test('several profiles prefix their rows, and the setup audit shows once for the whole server', () => {
  const two = healthyServer({ profiles: [healthyServer().profiles[0], { ...healthyServer().profiles[0], profile: 'work' }],
    verify: { ran: true, fails: ['work: plugin disabled'], warns: [] } });
  const findings = buildFindings(healthy({ server: two }));
  assert.ok(findings.some((f) => f.title.startsWith('work: ')));
  assert.deepEqual(findings.filter((f) => /plugin disabled/.test(f.title)).map((f) => f.title), ['work: plugin disabled']);
  const passed = buildFindings(healthy({ server: healthyServer({ profiles: two.profiles }) }));
  assert.deepEqual(passed.filter((f) => /audit/.test(f.title)).map((f) => f.title), ['Setup audit passed']);
});

test('a Windows server says its checks are not available', () => {
  const windows = buildFindings(healthy({ server: { ok: false, error: 'windows' } })).filter((f) => f.group === 'server');
  assert.deepEqual(windows.map((f) => f.level), ['warn']);
  assert.match(windows[0].title, /Windows servers/);
});

test('a server without the app installed points at the setup prompt', () => {
  const findings = buildFindings(healthy({ server: { ok: false, error: 'no browser host checkout found (expected …)' } }));
  assert.match(findings.find((f) => f.group === 'server').fix, /setup prompt/);
});

const { redactReport, buildReport } = require('../src/setup-check.cjs');

test('redactReport removes each secret shape and keeps addresses, versions and hashes', () => {
  const token = '123456789:AAFakeTokenForRedactionTestsOnly_123';
  const text = [
    `GET https://api.telegram.org/bot${token}/getUpdates failed`,
    `TELEGRAM_BOT_TOKEN=${token}`,
    '{"url":"http://127.0.0.1:9464","token":"e3b0c44298fc1c149afb"}',
    'Authorization: Bearer abc.def.ghi',
    'curl -H "Bearer zzz-123"',
    'OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwx',
    '-----BEGIN OPENSSH ' + 'PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----',
    'server root@192.0.2.5, app 0.4.0, plugin ce51733b66291e69f616db48ae8799c0de50db43',
  ].join('\n');
  const out = redactReport(text);
  for (const secret of [token, 'e3b0c44298fc1c149afb', 'abc.def.ghi', 'zzz-123', 'sk-proj-abcdefghijklmnopqrstuvwx', 'b3BlbnNzaC1rZXk'])
    assert.equal(out.includes(secret), false, `${secret} leaked`);
  assert.match(out, /root@192\.0\.2\.5/);
  assert.match(out, /app 0\.4\.0/);
  assert.match(out, /ce51733b66291e69f616db48ae8799c0de50db43/);
});

test('redactReport removes the token, password, key and header shapes that slipped through', () => {
  for (const [text, ...secrets] of [
    ['{"access_token":"ya29-access-secret","bot_token":"bot-json-secret","refresh_token":"refresh-json-secret"}',
      'ya29-access-secret', 'bot-json-secret', 'refresh-json-secret'],
    ['{"apiKey":"camel-key-secret","x-api-key":"json-header-secret"}', 'camel-key-secret', 'json-header-secret'],
    ['{"token":"head-secret\\"tail-secret"}', 'head-secret', 'tail-secret'],
    [JSON.stringify({ fails: ['bad config {"token":"nested-secret"}'] }), 'nested-secret'],
    ['GET https://broker.example/cb?code=oauth-code-secret&access_token=query-secret&state=1 failed', 'oauth-code-secret', 'query-secret'],
    ['db password=hunter2-secret, retrying', 'hunter2-secret'],
    ['hermes login --token flag-secret --verbose', 'flag-secret'],
    ['curl -H "x-api-key: header-key-secret" https://api.example', 'header-key-secret'],
    ['{"Authorization": "token json-auth-secret"}', 'json-auth-secret'],
    ['curl -H "authorization: bearer lower-auth-secret"', 'lower-auth-secret'],
    ['fetch failed with bearer lower-bearer-secret', 'lower-bearer-secret'],
    ['bot12345678901234:AAFakeTokenForRedactionTestsOnly_123/getMe', 'AAFakeTokenForRedactionTestsOnly_123'],
  ]) {
    const out = redactReport(text);
    for (const secret of secrets) assert.equal(out.includes(secret), false, `${secret} leaked from ${text} as ${out}`);
    assert.equal(redactReport(out), out, 'buildReport redacts twice, so a second pass changes nothing');
  }
});

test('redactReport leaves the next line and plain words about keys and tokens alone', () => {
  assert.equal(redactReport('Authorization:\nnext-line-kept'), 'Authorization:\nnext-line-kept');
  const prose = 'the key step is to check the token count, then the secret word and the password prompt';
  assert.equal(redactReport(prose), prose);
  assert.equal(redactReport('monkey business at 0.4.0'), 'monkey business at 0.4.0');
});

const appInfo = { version: '0.4.0', platform: 'darwin', arch: 'arm64', osVersion: '15.6', signed: true };

test('buildReport lists the setup, the last check and the newest log lines, redacted', () => {
  const log = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n') + '\nbot123456789:AAFakeTokenForRedactionTestsOnly_123 oops';
  const findings = [
    { group: 'computer', level: 'ok', title: 'Signed in to Telegram', fix: '', action: null },
    { group: 'server', level: 'fail', title: 'The server is on an older version', fix: 'Server 0.3.2, this app 0.4.0.', action: 'update-server' }];
  const report = buildReport({ now: new Date('2026-10-08T16:00:00Z'), app: appInfo, serverAddress: 'root@192.0.2.5', computerAddress: 'me@192.0.2.6',
    findings, checkedAt: '2026-10-08T15:59:00Z', server: { ok: true, version: '0.3.2' }, errorLog: log });
  assert.match(report, /^Open Alan report, 2026-10-08T16:00:00\.000Z$/m);
  assert.match(report, /App 0\.4\.0 on darwin arm64 \(15\.6\), signed build/);
  assert.match(report, /Server address: root@192\.0\.2\.5/);
  assert.match(report, /✓ This computer: Signed in to Telegram$/m);
  assert.match(report, /✗ Server: The server is on an older version \(Server 0\.3\.2, this app 0\.4\.0\.\)/);
  assert.match(report, /"version":"0\.3\.2"/);
  assert.doesNotMatch(report, /line 11$/m, 'only the last 50 log lines');
  assert.match(report, /line 12$/m);
  assert.doesNotMatch(report, /AAFakeTokenForRedactionTestsOnly_123/);
});

test('buildReport removes a private key that straddles the 50-line cut', () => {
  const log = [...Array.from({ length: 5 }, (_, i) => `before ${i}`), '-----BEGIN OPENSSH ' + 'PRIVATE KEY-----',
    ...Array.from({ length: 5 }, (_, i) => `keybody${i}secret`), '-----END OPENSSH PRIVATE KEY-----',
    ...Array.from({ length: 45 }, (_, i) => `after ${i}`)].join('\n');
  const report = buildReport({ app: appInfo, serverAddress: '', computerAddress: '', errorLog: log });
  assert.doesNotMatch(report, /keybody\dsecret/);
  assert.match(report, /\[private key removed\]/);
  assert.match(report, /after 44$/);
});

test('buildReport says when no check ran and when there are no errors', () => {
  const report = buildReport({ app: { ...appInfo, signed: false }, serverAddress: '', computerAddress: '', errorLog: '' });
  assert.match(report, /unsigned build/);
  assert.match(report, /Server address: not saved/);
  assert.match(report, /Check setup not run yet\./);
  assert.match(report, /Recent app errors:\nnone/);
});
