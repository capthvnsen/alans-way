// Runs the real scripts/vm-update.sh against a throwaway git remote and fake
// service managers on PATH. No real services, npm installs or VMs are touched.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync, execFileSync, spawn } = require('node:child_process');

const SCRIPT = path.join(__dirname, '../scripts/vm-update.sh');
const POST_HOOK = path.join(__dirname, '../scripts/vm-post-update.sh');
const WINDOWS_SCRIPT = path.join(__dirname, '../scripts/vm-update.ps1');
const REAL_GIT = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim() || '/usr/bin/git';
const tmpdirs = [], servers = [];
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
const mktemp = (prefix) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tmpdirs.push(dir); return dir; };

function seedVersion(work, version) {
  fs.mkdirSync(path.join(work, 'desktop', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(work, 'desktop', 'package.json'), JSON.stringify({ name: 'fixture', version }));
  fs.writeFileSync(path.join(work, 'desktop', 'scripts', 'vps-browser-host.cjs'), `// fixture host ${version}\n`);
  fs.writeFileSync(path.join(work, 'desktop', 'scripts', 'vm-post-update.sh'),
    '#!/bin/sh\n[ -z "${ALANS_WAY_VM_HOOK_LOG:-}" ] || echo "hook ran $1" >> "$ALANS_WAY_VM_HOOK_LOG"\n');
}
function makeRemote() {
  const remote = mktemp('vm-update-remote-');
  execFileSync('git', ['init', '--bare', '-q', remote]);
  const work = mktemp('vm-update-seed-');
  execFileSync('git', ['init', '-b', 'main', '-q', work]);
  git(work, 'config', 'user.email', 'fixture@example.com');
  git(work, 'config', 'user.name', 'fixture');
  seedVersion(work, '0.3.1');
  git(work, 'add', '.'); git(work, 'commit', '-q', '-m', 'v0.3.1'); git(work, 'tag', 'v0.3.1');
  seedVersion(work, '0.3.2');
  git(work, 'add', '.'); git(work, 'commit', '-q', '-m', 'v0.3.2'); git(work, 'tag', 'v0.3.2');
  git(work, 'remote', 'add', 'origin', remote);
  git(work, 'push', '-q', 'origin', 'main', '--tags');
  return remote;
}
function makeCheckout(remote, ref = 'v0.3.1') {
  const dir = mktemp('vm-update-checkout-');
  execFileSync('git', ['clone', '-q', remote, dir]);
  git(dir, 'checkout', '-q', ref);
  return dir;
}
function makeBin() {
  const bin = mktemp('vm-update-bin-');
  const marker = path.join(bin, 'services.log');
  for (const name of ['systemctl', 'launchctl']) {
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${name} $@" >> "${marker}"\nexit 0\n`, { mode: 0o755 });
  }
  fs.writeFileSync(path.join(bin, 'npm'), `#!/bin/sh\necho "npm $@" >> "${marker}"\nexit 0\n`, { mode: 0o755 });
  return { bin, marker };
}
async function makeStatus(body) {
  const server = http.createServer((_req, res) => res.end(JSON.stringify(typeof body === 'function' ? body() : body)));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return server.address().port;
}
function makeDataDir(port) {
  const dir = mktemp('vm-update-data-');
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ port }));
  fs.writeFileSync(path.join(dir, 'app-token.json'), JSON.stringify({ token: 'fixture-token' }));
  return dir;
}
const lastJson = (res) => {
  const lines = res.stdout.trim().split('\n').filter((line) => line.startsWith('{'));
  assert.ok(lines.length, `no JSON result line in:\n${res.stdout}\n${res.stderr}`);
  return JSON.parse(lines.at(-1));
};
// Async spawn: the status fixture is an in-process server, so a sync spawn
// would block the event loop and every health check would time out.
const runScript = (args, env) => new Promise((resolve, reject) => {
  const child = spawn('sh', [SCRIPT, ...args], { env: { ...process.env, ...env } });
  let stdout = '', stderr = '';
  const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`script timed out\n${stdout}\n${stderr}`)); }, 90000);
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('error', reject);
  child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
});
const envFor = (checkout, data, bin, extra = {}) => ({
  ALANS_WAY_DESKTOP_DIR: checkout,
  ALANS_WAY_VM_DATA: data,
  PATH: `${bin}:${process.env.PATH}`,
  ALANS_WAY_VM_OS: 'Linux',
  ALANS_WAY_VM_BUSY_WAIT: '2',
  ALANS_WAY_VM_BUSY_POLL: '1',
  ALANS_WAY_VM_HEALTH_WAIT: '6',
  ...extra,
});

let remote;
before(() => { remote = makeRemote(); });
after(() => {
  for (const server of servers) server.close();
  for (const dir of tmpdirs) fs.rmSync(dir, { recursive: true, force: true });
});

test('the shipped scripts parse cleanly', () => {
  for (const file of [SCRIPT, POST_HOOK]) {
    const res = spawnSync('sh', ['-n', file], { encoding: 'utf8' });
    assert.equal(res.status, 0, `${file}: ${res.stderr}`);
  }
  assert.ok(fs.existsSync(WINDOWS_SCRIPT), 'the Windows guest twin ships alongside');
});

test('a tag update fetches, pins the checkout, restarts the broker and answers JSON', async () => {
  const checkout = makeCheckout(remote);
  const { bin, marker } = makeBin();
  const port = await makeStatus({ version: '0.3.2', busy: false });
  const data = makeDataDir(port);
  const hookLog = path.join(data, 'hook.log');
  const res = await runScript(['v0.3.2'], envFor(checkout, data, bin, { ALANS_WAY_VM_HOOK_LOG: hookLog }));
  const result = lastJson(res);
  assert.deepEqual(result, { ok: true, version: '0.3.2', restarted: true, error: '' });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(git(checkout, 'rev-parse', 'HEAD'), git(checkout, 'rev-parse', 'v0.3.2^{commit}'));
  assert.match(fs.readFileSync(marker, 'utf8'), /restart hermes-alans-way-browser\.service/);
  assert.match(fs.readFileSync(hookLog, 'utf8'), /hook ran v0\.3\.2/, 'the new checkout post-update hook ran');
  assert.equal(fs.readFileSync(path.join(checkout, 'desktop', 'package.json'), 'utf8').includes('0.3.2'), true);
});

test('a Darwin guest restarts the LaunchAgent, not systemctl', async () => {
  const checkout = makeCheckout(remote);
  const { bin, marker } = makeBin();
  const port = await makeStatus({ version: '0.3.2', busy: false });
  const res = await runScript(['v0.3.2'], envFor(checkout, makeDataDir(port), bin, { ALANS_WAY_VM_OS: 'Darwin' }));
  const result = lastJson(res);
  assert.equal(result.ok, true, res.stderr);
  assert.equal(result.restarted, true);
  assert.match(fs.readFileSync(marker, 'utf8'), /launchctl kickstart -k gui\/\d+\/com\.alans-way\.browser/);
  assert.doesNotMatch(fs.readFileSync(marker, 'utf8'), /systemctl/);
});

test('a checkout that does not land on the tag is a hard stop', async () => {
  const checkout = makeCheckout(remote);
  const { bin } = makeBin();
  const fakeGit = path.join(bin, 'git');
  fs.writeFileSync(fakeGit, `#!/bin/sh\nif [ "$1" = "-C" ] && [ "$3" = "rev-parse" ] && [ "$4" = "HEAD" ]; then echo 0000000000000000000000000000000000000000; exit 0; fi\nexec "${REAL_GIT}" "$@"\n`, { mode: 0o755 });
  const port = await makeStatus({ version: '0.3.2', busy: false });
  const res = await runScript(['v0.3.2'], envFor(checkout, makeDataDir(port), bin, { ALANS_WAY_VM_GIT: fakeGit }));
  const result = lastJson(res);
  assert.notEqual(res.status, 0);
  assert.equal(result.ok, false);
  assert.match(result.error, /did not land|refusing/i);
});

test('non-semver tags are refused before any git work', async () => {
  const checkout = makeCheckout(remote);
  const { bin, marker } = makeBin();
  for (const tag of ['latest', 'v1.2', 'v1.2.3-rc.1', '../..']) {
    const res = await runScript([tag], envFor(checkout, makeDataDir(9), bin));
    assert.notEqual(res.status, 0, tag);
    assert.equal(lastJson(res).ok, false, tag);
  }
  assert.equal(fs.existsSync(marker), false, 'no service was touched');
  assert.equal(git(checkout, 'describe', '--tags', 'HEAD').trim(), 'v0.3.1');
});

test('a missing checkout reports an error instead of guessing', async () => {
  const { bin } = makeBin();
  const res = await runScript(['v0.3.2'], envFor(path.join(os.tmpdir(), 'definitely-missing-checkout'), mktemp('vm-update-nodata-'), bin));
  assert.notEqual(res.status, 0);
  assert.equal(lastJson(res).ok, false);
  assert.match(lastJson(res).error, /checkout/i);
});

test('--check reports the checkout version, live host version and busy flag', async () => {
  const checkout = makeCheckout(remote);
  const port = await makeStatus({ version: '0.3.1', busy: false });
  const res = await runScript(['--check'], envFor(checkout, makeDataDir(port), makeBin().bin));
  const result = lastJson(res);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(result.ok, true);
  assert.equal(result.version, '0.3.1');
  assert.equal(result.hostVersion, '0.3.1');
  assert.equal(result.busy, false);
});

test('a host that stays busy is skipped without touching the checkout', async () => {
  const checkout = makeCheckout(remote);
  const { bin, marker } = makeBin();
  const port = await makeStatus({ version: '0.3.1', busy: true });
  const res = await runScript(['v0.3.2'], envFor(checkout, makeDataDir(port), bin));
  const result = lastJson(res);
  assert.notEqual(res.status, 0);
  assert.equal(result.ok, false);
  assert.match(result.error, /busy/i);
  assert.equal(git(checkout, 'describe', '--tags', 'HEAD').trim(), 'v0.3.1', 'the checkout was not moved');
});
