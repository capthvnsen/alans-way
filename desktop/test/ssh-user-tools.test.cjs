const { ip: fixtureTailnet } = require('./tailnet-fixture.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const cloudModel = require('../src/cloud-model.cjs');
const { posixCommand } = require('../src/remote-shell.cjs');

// Run the actual main-process SSH boundary against an isolated remote home.
// No ssh process or installed Hermes is used.
const source = fs.readFileSync(path.join(__dirname, '../src/main.cjs'), 'utf8');
const sshSource = source.match(/function sshRun\([^]*?\n}/)[0];

test('SSH discovers the existing model from an install.sh user bin', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'alan-ssh-tools-'));
  try {
    const bin = path.join(home, '.local/bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'hermes'), `#!/bin/sh
case "$*" in
  'config get model.provider') echo openrouter ;;
  'config get model.default') echo anthropic/claude-sonnet-5.5 ;;
  *) exit 99 ;;
esac
`, { mode: 0o700 });
    const sshRun = vm.runInNewContext(`${sshSource}\nsshRun`, {
      posixCommand, isSshTarget: require('../src/core.cjs').isSshTarget, TAILNET_SSH_OPTIONS: require('../src/tailnet.cjs').SSH_OPTIONS,
      localRun: async (file, args, options) => {
        assert.equal(file, 'ssh');
        assert.equal(options.timeoutMs, 8000);
        const result = spawnSync('/bin/sh', ['-c', args.at(-1)], {
          env: { HOME: home, PATH: path.join(home, 'system') }, encoding: 'utf8', timeout: 1000,
        });
        return { code: result.status, out: result.stdout, err: result.stderr };
      },
    });
    const result = await sshRun(fixtureTailnet, cloudModel.existingModelCommand(), { timeoutMs: 8000 });
    assert.deepEqual(cloudModel.parseExistingModel(result), { provider: 'openrouter', model: 'anthropic/claude-sonnet-5.5' });
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// Translate fixed system directories into a fixture root to model a remote
// filesystem, including the missing case, without invoking machine tools.
function remoteFixture(t, shell = '/bin/sh', shellArgs = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alan-ssh-path-'));
  const home = path.join(root, "home with spaces ' $(touch injected) `id` $dollar");
  fs.mkdirSync(home);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { HOME: home, HERMES_HOME: path.join(home, 'custom hermes'), PATH: path.join(root, 'original'), FIXTURE_ROOT: root };
  const run = (command, options = {}) => spawnSync(shell, [...shellArgs, '-c', command
    .replaceAll('/usr/local/bin', '$FIXTURE_ROOT/usr/local/bin')
    .replaceAll('/opt/homebrew/bin', '$FIXTURE_ROOT/opt/homebrew/bin')], { env, cwd: home, encoding: 'utf8', timeout: 1000, ...options });
  const tool = (dir, name, output) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), `#!/bin/sh\nprintf '%s\\n' '${output}'\n`, { mode: 0o700 });
  };
  return { root, home, env, run, tool };
}

// The prelude runs in sshd's account shell, before any script's shebang.
// Exercise strict glob handling as well as the POSIX shells available in CI.
for (const [shell, shellArgs] of [
  ['/bin/sh', []], ['/bin/bash', ['-O', 'failglob']], ['/bin/zsh', ['-f']], ['/bin/dash', []],
]) {
  const options = { skip: !fs.existsSync(shell) && `${shell} unavailable` };
  test(`${shell}: empty HOME reaches the command without adding nonexistent bins`, options, (t) => {
    const f = remoteFixture(t, shell, shellArgs);
    const result = f.run(posixCommand(`printf '%s\\n' "command-reached" "$PATH"`));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `command-reached\n${f.env.PATH}\n`);
    assert.equal(result.stderr, '');
  });
  for (const location of ['install.sh / pipx', 'pip user (macOS)', 'pip user (legacy macOS)', 'Hermes home', 'default Hermes home', '/usr/local/bin', 'Homebrew', 'inherited PATH', 'missing']) {
    test(`${shell} user-tool PATH: ${location}`, options, (t) => {
      const f = remoteFixture(t, shell, shellArgs);
      const dirs = {
        'install.sh / pipx': path.join(f.home, '.local/bin'),
        'pip user (macOS)': path.join(f.home, 'Library/Python/3.13/bin'),
        'pip user (legacy macOS)': path.join(f.home, 'Library/Python/2.7/bin'),
        'Hermes home': path.join(f.env.HERMES_HOME, 'bin'),
        'default Hermes home': path.join(f.home, '.hermes/bin'),
        '/usr/local/bin': path.join(f.root, 'usr/local/bin'),
        'Homebrew': path.join(f.root, 'opt/homebrew/bin'),
        'inherited PATH': f.env.PATH,
      };
      if (location === 'default Hermes home') delete f.env.HERMES_HOME;
      if (dirs[location]) f.tool(dirs[location], 'hermes', 'found');
      const result = f.run(posixCommand('hermes 2>/dev/null'));
      assert.equal(result.status, location === 'missing' ? 127 : 0, result.stderr);
      assert.equal(result.stdout, location === 'missing' ? '' : 'found\n');
      assert.equal(result.stderr, '');
      assert.equal(fs.existsSync(path.join(f.home, 'injected')), false);
    });
  }
  test(`${shell}: sudo resolves user Node before resetting PATH`, options, (t) => {
    const f = remoteFixture(t, shell, shellArgs);
    const { remoteCommand } = require('../src/vps-browser.cjs');
    f.tool(path.join(f.home, '.local/bin'), 'node', 'node-found');
    fs.mkdirSync(f.env.PATH, { recursive: true });
    fs.writeFileSync(path.join(f.env.PATH, 'sudo'), `#!/bin/sh
[ "$1" = -n ] || exit 98
shift
PATH=/fixture-empty-secure-path
export PATH
exec "$@"
`, { mode: 0o700 });
    const result = f.run(remoteCommand({ scriptPath: '/fixture/my host.cjs', sudo: true }));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'node-found\n');
    assert.equal(fs.existsSync(path.join(f.home, 'injected')), false);
  });
}

test('PATH preserves the selected CLI, ignores non-executables, and never reads shell profiles', (t) => {
  const f = remoteFixture(t);
  f.tool(f.env.PATH, 'hermes', 'selected');
  f.tool(path.join(f.home, '.local/bin'), 'hermes', 'fallback');
  fs.writeFileSync(path.join(f.home, '.profile'), "echo profile-output; touch profile-read\n");
  fs.writeFileSync(path.join(f.home, '.bash_profile'), "echo profile-output; touch profile-read\n");
  assert.equal(f.run(posixCommand('hermes')).stdout, 'selected\n');
  fs.chmodSync(path.join(f.env.PATH, 'hermes'), 0o600);
  assert.equal(f.run(posixCommand('hermes')).stdout, 'fallback\n');
  const result = f.run(posixCommand("IFS= read -r line; printf '%s\\n' \"$line\"; printf '%s\\n' 'literal '\\'' $HOME $(id); `id`'; exit 23"), { input: 'stdin survives\n' });
  assert.equal(result.status, 23);
  assert.equal(result.stdout, "stdin survives\nliteral ' $HOME $(id); `id`\n");
  assert.equal(fs.existsSync(path.join(f.home, 'profile-read')), false);
});

test('POSIX browser Node calls and updater payloads use the shared PATH', async (t) => {
  const f = remoteFixture(t);
  const { remoteCommand } = require('../src/vps-browser.cjs');
  const { createVmUpdater } = require('../src/vm-update.cjs');
  f.tool(path.join(f.home, '.local/bin'), 'node', 'node-found');
  assert.equal(f.run(remoteCommand({ scriptPath: '/fixture/host.cjs' })).stdout, 'node-found\n');
  assert.equal(remoteCommand({ scriptPath: 'C:/fixture/host.cjs' }), 'node "C:/fixture/host.cjs" request');
  const calls = [];
  const updater = createVmUpdater({
    readScript: () => 'node\n',
    run: async (bin, args, opts) => {
      calls.push({ bin, args, opts });
      assert.equal(f.run(opts.input).stdout, 'node-found\n');
      return { code: 0, out: '{"ok":true,"version":"0.21.7"}\n', err: '' };
    },
  });
  const guest = { sshHost: fixtureTailnet, scriptPath: '/fixture/host.cjs' };
  await updater.checkVm(guest);
  await updater.doctorVm(guest);
  await updater.hermesUpdateVm(guest);
  await updater.updatePluginsVm(guest);
  await updater.updateVm(guest, 'v0.21.7');
  assert.equal(calls.length, 5);
  assert.ok(calls.every(({ opts }) => opts.timeoutMs > 0));
});

test('the OAuth SSH spawn also discovers a user-installed Hermes', async (t) => {
  const f = remoteFixture(t);
  const { EventEmitter } = require('node:events');
  f.tool(path.join(f.home, '.local/bin'), 'hermes', 'oauth-found');
  const start = source.indexOf("      case 'cloud-model-subscribe': {");
  const end = source.indexOf("      case 'cloud-model-check': {", start);
  assert.ok(start > 0 && end > start);
  let command;
  const run = vm.runInNewContext(`(async () => { switch ('cloud-model-subscribe') { ${source.slice(start, end)} } })`, {
    prefs: { vpsBrowser: { sshHost: fixtureTailnet } },
    modelAuthChild: null, cloudModel, posixCommand, isSshTarget: require('../src/core.cjs').isSshTarget, TAILNET_SSH_OPTIONS: require('../src/tailnet.cjs').SSH_OPTIONS,
    spawn: (bin, args) => {
      assert.equal(bin, 'ssh');
      assert.equal(args.at(-2), fixtureTailnet);
      command = args.at(-1);
      return Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
    },
  });
  await run();
  const result = f.run(command);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'oauth-found\n');
});


test('the nested agent path probe disables SSH aliases and quotes bracketed IPv6', async () => {
  const section=source.slice(source.indexOf('function testAgentPath()'),source.indexOf('async function runSetupCheck'));
  const {EventEmitter}=require('node:events');let sent;
  const probe=vm.runInNewContext(section+';testAgentPath',{
    prefs:{vpsBrowser:{sshHost:'agent@'+fixtureTailnet},macSshHost:'user@[fd7a:115c:a1e0::1]'},seedMacSshHost(){},HOST_LABEL:'mac',
    isSshTarget:require('../src/core.cjs').isSshTarget,TAILNET_SSH_OPTIONS:require('../src/tailnet.cjs').SSH_OPTIONS,cloudMigrate:require('../src/cloud-migrate.cjs'),
    spawn:(_file,args)=>{sent=args;const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();queueMicrotask(()=>child.emit('close',1));return child;},
  });
  await probe();const nested=sent.at(-1);
  assert.match(nested,/ssh -F none -o ProxyCommand=none -o ProxyJump=none -o CanonicalizeHostname=no/);
  assert.ok(nested.includes("'user@[fd7a:115c:a1e0::1]'"),'IPv6 brackets cannot expand as a shell glob');
});
