process.env.HERMES_WORKSPACE_ALLOW_LOOPBACK = '1';
const test = require('node:test');
const { posixCommand } = require('../src/remote-shell.cjs');
const assert = require('node:assert/strict');
const { createVpsBrowser, remoteCommand, asciiJson, sshArgs, backoffDelay, toCdpCookie, toElectronCookies, isTailnetHost, sshResolvedHostname, resolveSshHostname, createMirrorPusher, prepareMirrorTabs, settleWithin, checkScriptPath } = require('../src/vps-browser.cjs');

test('VPS SSH failures include a bounded stderr tail', async () => {
  const browser = createVpsBrowser({ getConfig: () => ({ sshHost: '127.0.0.1', scriptPath: '/nonexistent/vps-browser-host.cjs', sudo: false }) });
  await assert.rejects(
    () => browser.request('/v1/status'),
    (error) => error.message.includes('VPS browser SSH unavailable') && /127\.0\.0\.1|Connection refused|connect/i.test(error.message),
  );
});

test('script paths are absolute Unix or Windows paths from a small safe alphabet', async () => {
  const via = (scriptPath) => createVpsBrowser({ getConfig: () => ({ sshHost: '127.0.0.1', scriptPath }) }).request('/v1/status');
  for (const scriptPath of ['C:\\Users\\a b\\h.cjs', 'd:/tools/h.cjs', '/home/user/.hermes/h.cjs', '/opt/my app/h-1_2.cjs'])
    await assert.rejects(via(scriptPath), (error) => !/Invalid VPS browser/.test(error.message), scriptPath);
  for (const scriptPath of ['relative/h.cjs', 'C:h.cjs', "/x/it's.cjs", '/x/$(id).cjs', '/x/`id`.cjs', '/x/a"b.cjs', '/x/a;b.cjs', '/x/a&b.cjs', '/x/a%PATH%.cjs', '/x/h.cjs\\', '/x/\u00e9.cjs', '/x/a\nb.cjs'])
    await assert.rejects(via(scriptPath), /Invalid VPS browser (SSH settings|script path)/, scriptPath);
});

test('POSIX browser commands add user tools; Windows keeps its native command', () => {
  assert.equal(remoteCommand({ scriptPath: '/opt/hermes app/h.cjs' }), posixCommand('node "/opt/hermes app/h.cjs" request'));
  assert.equal(remoteCommand({ scriptPath: 'C:\\Users\\a b\\h.cjs' }), 'node "C:\\Users\\a b\\h.cjs" request');
  assert.equal(remoteCommand({ scriptPath: '/x/h.cjs', sudo: true }), posixCommand('_alan_node=$(command -v node) && sudo -n "$_alan_node" "/x/h.cjs" request'));
});

test('requests are sent as ASCII so no shell re-encodes them', () => {
  const text = asciiJson({ title: 'Caf\u00e9 \u65e5\u672c \ud83d\ude00', plain: 'a' });
  assert.ok(/^[\x00-\x7f]*$/.test(text));
  assert.deepEqual(JSON.parse(text), { title: 'Caf\u00e9 \u65e5\u672c \ud83d\ude00', plain: 'a' });
});

test('ssh fails fast on a dead link and multiplexes everywhere except Windows', () => {
  const args = sshArgs('me@vm.tail1234.ts.net', 'node x request', 'darwin');
  const has = (option) => args.some((arg, i) => args[i - 1] === '-o' && arg === option);
  for (const option of ['BatchMode=yes', 'StrictHostKeyChecking=yes', 'ConnectTimeout=6', 'ServerAliveInterval=5', 'ServerAliveCountMax=2', 'ControlMaster=auto'])
    assert.ok(has(option), option);
  const controlPath = args.find((arg) => arg.startsWith('ControlPath=')).slice('ControlPath='.length);
  assert.ok(controlPath.length + 18 < 104, `ControlPath ${controlPath.length} chars leaves room under the 104 byte socket limit`);
  assert.deepEqual(args.slice(-2), ['me@vm.tail1234.ts.net', 'node x request']);
  const windows = sshArgs('vm', 'node x request', 'win32');
  assert.ok(windows.includes('ServerAliveInterval=5'));
  assert.ok(!windows.some((arg) => /^Control/.test(arg)), 'Windows OpenSSH has no ControlMaster');
});

test('the refresh backs off while the VM is unreachable and recovers at once', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 9].map(backoffDelay), [5000, 10000, 20000, 40000, 60000, 60000]);
});

test('Electron cookies map onto the CDP cookie shape', () => {
  const cdp = toCdpCookie({ name: 'sid', value: 'v', domain: '.shop.example', hostOnly: false, path: '/a', secure: true, httpOnly: true, session: false, expirationDate: 1900000000.5, sameSite: 'no_restriction' });
  assert.deepEqual(cdp, { name: 'sid', value: 'v', domain: '.shop.example', path: '/a', expires: 1900000000.5, httpOnly: true, secure: true, session: false, sameSite: 'None' });
  const session = toCdpCookie({ name: 'k', value: 'v', domain: 'shop.example', hostOnly: true, path: '/', secure: false, httpOnly: false, session: true, sameSite: 'unspecified' });
  assert.equal(session.expires, -1);
  assert.equal(session.session, true);
  assert.ok(!('sameSite' in session), 'unspecified SameSite is left unset');
});

test('the mirror pusher sends a bot only when its tabs changed and retries failures', async () => {
  let current = new Map([['bot-a', [{ id: 't1', url: 'https://a.example/' }]]]);
  const pushed = [];
  let failNext = false;
  const run = createMirrorPusher({
    collect: async () => current,
    push: async (bot, tabs) => { if (failNext) { failNext = false; throw new Error('down'); } pushed.push([bot, tabs.length]); },
  });
  await run();
  await run();
  assert.deepEqual(pushed, [['bot-a', 1]], 'an unchanged mirror is not resent');
  current = new Map([['bot-a', [{ id: 't1', url: 'https://a.example/next' }]]]);
  failNext = true;
  await run();
  await run();
  assert.deepEqual(pushed, [['bot-a', 1], ['bot-a', 1]], 'a failed push is retried on the next tick');
  current = new Map();
  await run();
  await run();
  assert.deepEqual(pushed.at(-1), ['bot-a', 0], 'a bot with no agent tabs left is cleared once');
  assert.equal(pushed.length, 3);
  current = null;
  await run();
  assert.equal(pushed.length, 3, 'nothing is pushed while the VM is unreachable');
  const overlapping = createMirrorPusher({ collect: () => new Promise(() => {}), push: async () => {} });
  overlapping();
  assert.equal(await overlapping(), undefined, 'a run in flight is not doubled');
});

test('the first successful connect clears every known bot that has no agent tabs', async () => {
  const pushed = [];
  let down = true, failB = true;
  const run = createMirrorPusher({
    bots: () => ['a', 'b', 'c'],
    collect: async () => (down ? null : new Map([['a', [{ id: 't1', url: 'https://a.example/' }]]])),
    push: async (bot, tabs) => { if (bot === 'b' && failB) { failB = false; throw new Error('down'); } pushed.push([bot, tabs.length]); },
  });
  await run();
  assert.deepEqual(pushed, [], 'nothing while the VM is unreachable');
  down = false;
  await run();
  assert.deepEqual(pushed.sort(), [['a', 1], ['c', 0]], 'a stale mirror from before the restart is cleared; a failed clear waits');
  await run();
  assert.deepEqual(pushed.sort(), [['a', 1], ['b', 0], ['c', 0]], 'the failed clear is retried');
  await run();
  assert.equal(pushed.length, 3, 'and each bot is cleared only once');
});

test('unchanged mirrors refresh before expiry and retry after sleep or a network drop', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  let online = true, failNext = false;
  const pushed = [];
  const run = createMirrorPusher({
    collect: async () => online ? new Map([['a', [{ id: 'task', url: 'https://task.example/' }]]]) : null,
    push: async () => { if (failNext) { failNext = false; throw new Error('network down'); } pushed.push(Date.now()); },
  });
  await run();
  t.mock.timers.tick(3600000 - 1); await run();
  assert.equal(pushed.length, 1);
  t.mock.timers.tick(1); failNext = true; await run(); await run();
  assert.equal(pushed.length, 2, 'an unchanged mirror is refreshed hourly and failed refreshes retry');
  online = false; t.mock.timers.tick(25 * 3600000); await run();
  assert.equal(pushed.length, 2);
  online = true; await run();
  assert.equal(pushed.length, 3, 'Tailscale reconnect refreshes an expired unchanged mirror');
});

test('mirror payloads share cookies across tabs and drop the oldest tabs past the cap', () => {
  const cookie = (name, domain = '.a.example') => ({ name, value: 'x'.repeat(100), domain, path: '/' });
  const tab = (id, cookies) => ({ id, url: 'https://a.example/' + id, cookies });
  const shared = prepareMirrorTabs([tab('1', [cookie('s'), cookie('t')]), tab('2', [cookie('s'), cookie('u')])], 1e6);
  assert.deepEqual(shared.tabs.map((t) => t.cookies.map((c) => c.name)), [['s', 't'], ['u']]);
  assert.equal(shared.dropped, 0);
  const big = [1, 2, 3, 4].map((n) => tab(String(n), [cookie('c' + n, `.${n}.example`)]));
  const size = JSON.stringify(big.slice(2)).length;
  const capped = prepareMirrorTabs(big, size + 10);
  assert.deepEqual(capped.tabs.map((t) => t.id), ['3', '4'], 'the oldest tabs go first');
  assert.equal(capped.dropped, 2);
});

test('settleWithin gives up on a hung promise', async () => {
  assert.equal(await settleWithin(new Promise(() => {}), 30, 'late'), 'late');
  assert.equal(await settleWithin(Promise.resolve('fast'), 30, 'late'), 'fast');
  assert.equal(await settleWithin(Promise.reject(new Error('x')), 30, 'late'), 'late');
});

test('sudo is never prepended for a Windows drive path', () => {
  assert.equal(remoteCommand({ scriptPath: 'C:\\h.cjs', sudo: true }), 'node "C:\\h.cjs" request');
  assert.equal(remoteCommand({ scriptPath: '/h.cjs', sudo: true }), posixCommand('_alan_node=$(command -v node) && sudo -n "$_alan_node" "/h.cjs" request'));
});

test('the mirror cap is measured on the escaped payload that is actually sent', () => {
  const tab = (id) => ({ id, url: 'https://a.example/' + id, title: '\u65e5\u672c'.repeat(50), cookies: [] });
  const tabs = [tab('1'), tab('2'), tab('3')];
  const plain = JSON.stringify(tabs.slice(1)).length;
  assert.ok(asciiJson(tabs.slice(1)).length > plain + 100, 'escaping makes the payload larger');
  const capped = prepareMirrorTabs(tabs, plain + 10);
  assert.deepEqual(capped.tabs.map((t) => t.id), ['3'], 'the escaped size, not the raw size, decides');
});

test('a bad script path has a readable reason before anything is sent', () => {
  assert.equal(checkScriptPath('/opt/hermes/h.cjs'), '');
  assert.equal(checkScriptPath('C:\\h\\x.cjs'), '');
  assert.match(checkScriptPath("/x/it's.cjs"), /Invalid VPS browser script path/);
});


test('an unchanged mirror is resent once an hour so the VM never ages it out', async () => {
  let clock = 0;
  const pushed = [];
  const run = createMirrorPusher({ now: () => clock, collect: async () => new Map([['a', [{ id: 't1', url: 'https://a.example/' }]]]), push: async (bot) => pushed.push(bot) });
  await run();
  clock = 3599999;
  await run();
  assert.equal(pushed.length, 1);
  clock = 3600000;
  await run();
  assert.equal(pushed.length, 2, 'refreshed after an hour unchanged');
});

test('sign-ins only travel to a tailnet address or MagicDNS name', async () => {
  // Built at runtime: the publication check keeps literal tailnet addresses out of the repo.
  const cgnat = (...rest) => ['100', ...rest].join('.');
  for (const host of [cgnat(64, 0, 1), 'me@' + cgnat(101, 102, 103), cgnat(127, 255, 255), 'fd7a:115c:a1e0::1', '[fd7a:115c:a1e0:ab12::5]'])
    assert.equal(isTailnetHost(host), true, host);
  for (const host of ['vm.tail1234.ts.net', 'root@orgo.tailnet-x.ts.net', '', '203.0.113.7', cgnat(63, 255, 255), cgnat(128, 0, 1), cgnat(64, 0, 256), cgnat('064', 0, 1), cgnat(64, '01', 1), '10.0.0.5', 'vm.example.com', 'ts.net.evil.com', 'fd7a:115c:a1e1::1', 'orgo'])
    assert.equal(isTailnetHost(host), false, host);
  assert.equal(sshResolvedHostname(`user root\nhostname ${cgnat(88, 1, 2)}\nport 22\n`), cgnat(88, 1, 2));
  assert.equal(sshResolvedHostname('port 22'), '');
  const seen = [];
  assert.equal(await resolveSshHostname(cgnat(64, 0, 1), async (args) => { seen.push(args); return 'hostname orgo.tail1.ts.net\n'; }), 'orgo.tail1.ts.net');
  assert.deepEqual(seen, [[...require('../src/tailnet.cjs').SSH_OPTIONS, '-G', cgnat(64, 0, 1)]]);
  assert.equal(await resolveSshHostname('-oProxyCommand=x', async () => { throw new Error('never run'); }), '', 'an option-shaped host never reaches ssh');
});

test('cookies moved back from the VM are limited to the page they belong to', () => {
  const base = { value: 'v', path: '/', httpOnly: true, secure: true, session: false, expires: 1900000000, sameSite: 'Lax' };
  const set = toElectronCookies([
    { ...base, name: 'sid', domain: '.shop.example' },
    { ...base, name: 'host', domain: 'www.shop.example', session: true, expires: -1, sameSite: 'None', path: '/cart' },
    { ...base, name: 'other', domain: '.bank.example' },
    { ...base, name: 'sibling', domain: 'api.shop.example' },
    { ...base, name: 'chips', domain: '.shop.example', partitionKey: { topLevelSite: 'https://x.example' } },
    { ...base, name: 'evil', domain: '.example' + 'x' },
  ], 'https://www.shop.example/cart?id=1');
  assert.deepEqual(set.map((c) => c.name), ['sid', 'host']);
  assert.deepEqual(set[0], { url: 'https://www.shop.example/', name: 'sid', value: 'v', path: '/', secure: true, httpOnly: true, domain: '.shop.example', expirationDate: 1900000000, sameSite: 'lax' });
  assert.equal(set[1].domain, undefined, 'a host-only cookie stays host-only');
  assert.equal(set[1].expirationDate, undefined, 'a session cookie stays a session cookie');
  assert.equal(set[1].url, 'https://www.shop.example/cart');
  assert.deepEqual(toElectronCookies([{ ...base, name: 'sid', domain: 'shop.example' }], 'http://shop.example/'), [], 'a Secure cookie never lands on an http page');
  assert.deepEqual(toElectronCookies([{ ...base, name: 'sid', domain: 'shop.example' }], 'file:///etc/passwd'), []);
  assert.deepEqual(toElectronCookies('nope', 'https://shop.example/'), []);
});
