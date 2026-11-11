const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { terminalCommand, createTerminals } = require('../src/terminal.cjs');

const exists = (file) => file === '/bin/zsh';
const inner = (command) => command.args.slice(command.args.indexOf('sh', 2) + 1);

test('this computer: the user’s shell under script, sized by fixed arguments', () => {
  const mac = terminalCommand({ platform: 'darwin', env: { SHELL: '/bin/zsh' }, cols: 100, rows: 30, exists });
  assert.equal(mac.file, '/bin/sh');
  assert.deepEqual(mac.args.slice(0, 4), ['-c', 'cat | script "$@"', 'sh', '-q']);
  assert.deepEqual(mac.args.slice(-5), ['sh', '100', '30', '/bin/zsh', '-l']);
  const linux = terminalCommand({ platform: 'linux', env: { SHELL: '/bin/zsh' }, cols: 100, rows: 30, exists });
  assert.equal(linux.args[3], '-qfc');
  assert.match(linux.args[4], /^'\/bin\/sh' '-c' '[^']+' 'sh' '100' '30' '\/bin\/zsh' '-l'$/);
  assert.equal(linux.args[5], '/dev/null');
});

test('an unusable SHELL falls back to /bin/sh, and sizes are clamped integers', () => {
  for (const SHELL of ['', 'zsh', '/bin/zsh; reboot', '/no/such/shell']) {
    const command = terminalCommand({ platform: 'darwin', env: { SHELL }, cols: 'x', rows: 1e9, exists });
    assert.deepEqual(command.args.slice(-4), ['80', '200', '/bin/sh', '-l']);
  }
});

test('a bot reached over SSH: ssh -tt with the existing options, the address after --', () => {
  const command = terminalCommand({ platform: 'darwin', sshHost: 'agent@100.64.0.9', sshOptions: ['-F', 'none'], cols: 90, rows: 20 });
  assert.deepEqual(command.args.slice(-13), ['sh', '90', '20', 'ssh', '-tt', '-F', 'none', '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=accept-new', '--', 'agent@100.64.0.9']);
  assert.equal(command.args.includes('/bin/zsh'), false);
});

test('an address that is not a plain [user@]host is refused, never passed to ssh', () => {
  for (const sshHost of ['-oProxyCommand=touch /tmp/x', 'a b', 'x;reboot', '$(id)', '']) {
    const command = terminalCommand({ platform: 'darwin', sshHost, env: { SHELL: '/bin/zsh' }, exists });
    if (sshHost) assert.match(command.unavailable, /not valid/, sshHost); else assert.equal(command.args.includes('ssh'), false);
  }
});

test('Windows has no terminal yet', () => {
  assert.match(terminalCommand({ platform: 'win32' }).unavailable, /not available on Windows/);
  const terminals = createTerminals({ platform: 'win32', onData() {}, onExit() {} });
  assert.deepEqual(terminals.start('1'), { ok: false, reason: 'Terminal is not available on Windows yet.' });
  assert.deepEqual(terminals.ids(), []);
});

function fakeChild() {
  const child = new (require('node:events'))();
  Object.assign(child, { pid: 2147483000, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  child.stdio = [child.stdin, child.stdout, child.stderr, new PassThrough()];
  return child;
}

test('one session per bot: output, input, resize, and kill when the bot goes', () => {
  const children = [], runs = [], data = [], exited = [];
  const terminals = createTerminals({ platform: 'darwin', spawnProcess: () => { children.push(fakeChild()); return children.at(-1); }, run: (...args) => runs.push(args),
    build: () => ({ file: 'x', args: [] }), onData: (id, text) => data.push([id, text]), onExit: (id) => exited.push(id) });
  assert.deepEqual(terminals.start('1'), { ok: true });
  assert.deepEqual(terminals.start('1'), { ok: true });
  terminals.start('2');
  assert.equal(children.length, 2, 'starting twice keeps the live session');
  children[0].stdout.write('héllo');
  assert.deepEqual(data, [['1', 'héllo']]);
  let typed = ''; children[0].stdin.on('data', (chunk) => { typed += chunk; });
  terminals.input('1', 'ls\r'); terminals.input('1', 5); terminals.input('9', 'x'); terminals.input('1', 'a'.repeat(70000));
  assert.equal(typed, 'ls\r', 'only short strings for a live session');
  terminals.resize('1', 120, 40);
  assert.equal(runs.length, 0, 'a resize before the shell reported its tty waits for it');
  children[0].stdio[3].write('/dev/ttys042\n');
  assert.deepEqual(runs[0].slice(0, 2), ['stty', ['-f', '/dev/ttys042', 'cols', '120', 'rows', '40']]);
  terminals.resize('1', 100, 30);
  assert.deepEqual(runs[1][1], ['-f', '/dev/ttys042', 'cols', '100', 'rows', '30']);
  children[1].stdio[3].write('/dev/../etc/passwd\n');
  terminals.resize('2', 120, 40);
  assert.equal(runs.length, 2, 'a tty path outside /dev is ignored');
  terminals.keepOnly(['2']);
  assert.deepEqual(exited, ['1']);
  assert.deepEqual(terminals.ids(), ['2']);
  children[1].stdio[3].write('done\n');
  assert.deepEqual(exited, ['1', '2'], 'the shell ending ends the session');
  terminals.start('3'); terminals.killAll();
  assert.deepEqual(terminals.ids(), []);
  assert.deepEqual(exited, ['1', '2'], 'quitting is silent');
});
