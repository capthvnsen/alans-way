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
// /usr/bin/git is a license-gated stub until Xcode's license is accepted;
// the Command Line Tools git is not.
if (process.platform === 'darwin' && fs.existsSync('/Library/Developer/CommandLineTools/usr/bin/git')) {
  process.env.DEVELOPER_DIR = '/Library/Developer/CommandLineTools';
}
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
  // The fake systemctl answers is-system-running from bin/systemd-state; no
  // file means a live systemd, which is what most fixtures stand in for.
  fs.writeFileSync(path.join(bin, 'systemctl'), `#!/bin/sh
echo "systemctl $@" >> "${marker}"
if [ "\${1:-}" = "is-system-running" ]; then cat "${bin}/systemd-state" 2>/dev/null || echo running; fi
# A unit named in bin/missing-units does not exist; every verb on it fails.
for _a in "$@"; do grep -qxF "$_a" "${bin}/missing-units" 2>/dev/null && { echo "Unit $_a.service not found." >&2; exit 1; }; done
# A hermes-gateway unit's state is tracked in the hermes fixture so a fake
# hermes can tell a stopped gateway apart from a running one.
_op="" _gw=0
for _a in "$@"; do case "$_a" in stop) _op=stopped;; start|restart) _op=running;; hermes-gateway|hermes-gateway.service) _gw=1;; esac; done
[ "$_gw" = 1 ] && [ -n "$_op" ] && [ -n "\${FAKE_HERMES_STATE:-}" ] && printf '%s\\n' "$_op" > "$FAKE_HERMES_STATE/gwstate"
exit 0
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'launchctl'), `#!/bin/sh\necho "launchctl $@" >> "${marker}"\nexit 0\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'npm'), `#!/bin/sh\necho "npm $@" >> "${marker}"\nexit 0\n`, { mode: 0o755 });
  // The closed PATH still reaches /usr/bin/sudo; a runner with passwordless sudo
  // (macOS CI) would rerun the fake supervisorctl with the test env scrubbed and
  // turn a deliberate failure into success. Default to "password required".
  fs.writeFileSync(path.join(bin, 'sudo'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  return { bin, marker };
}
// A fake supervisorctl driven by files under $FAKE_SUPERVISOR_STATE:
//   status           printed verbatim by `supervisorctl status` (the matching
//                    line only when a program name is passed)
//   pid.<name>       the pid `supervisorctl pid <name>` answers
//   next-pid.<name>  the pid `signal`/`start` promotes: the relaunched process
//   signal-fail      names whose `signal` exits 1 (a verb the host lacks)
//   drain-hold       names whose `signal` lands but keeps the old pid: the
//                    drain is still in flight when the wait ends
//   no-relaunch      names that stay STOPPED after `signal` (no autorestart)
//   restart-fail     names whose `restart` exits 1
// Like the real supervisorctl, status exits nonzero when any listed program
// is not RUNNING and pid exits nonzero for a program that is not RUNNING.
// A long-lived process whose argv carries the given words, so the script's
// program-by-command-line detection has something real to find.
const fakeDaemons = [];
function spawnDaemon(...args) {
  const child = spawn('node', ['-e', 'setInterval(()=>{}, 1000)', ...args], { stdio: 'ignore' });
  fakeDaemons.push(child);
  return child.pid;
}
function addSupervisor(bin, marker, state, sudoOnly = false) {
  fs.writeFileSync(path.join(bin, 'supervisorctl'), `#!/bin/sh
STATE="$FAKE_SUPERVISOR_STATE"
${sudoOnly ? '[ -n "${FAKE_SUDO:-}" ] || exit 1\n' : ''}case "\${1:-}" in
  status) if [ -n "\${2:-}" ]; then
            grep "^\${2} " "$STATE/status" 2>/dev/null
            awk -v n="\${2:-}" '$1 == n && $2 != "RUNNING" { bad = 1 } END { exit bad+0 }' "$STATE/status" 2>/dev/null || exit 3
            exit 0
          fi
          cat "$STATE/status" 2>/dev/null
          [ -f "$STATE/status" ] || exit 0
          awk 'NF > 1 && $2 != "RUNNING" { bad = 1 } END { exit bad+0 }' "$STATE/status" || exit 3
          exit 0;;
  pid) cat "$STATE/pid.\${2:-}" 2>/dev/null
       awk -v n="\${2:-}" '$1 == n { found = ($2 == "RUNNING") } END { exit !found }' "$STATE/status" 2>/dev/null || exit 7
       exit 0;;
  signal) n="\${3:-}"
          [ "\${2:-}" = "USR1" ] || [ "\${2:-}" = "SIGUSR1" ] || exit 1
          grep -qxF "$n" "$STATE/signal-fail" 2>/dev/null && exit 1
          grep -qxF "$n" "$STATE/drain-hold" 2>/dev/null \
            && { echo "supervisorctl signal \${2:-} $n" >> "${marker}"; exit 0; }
          cur="$(cat "$STATE/pid.$n" 2>/dev/null | tr -d '[:space:]')"
          case "$cur" in ''|0|*[!0-9]*) exit 1;; esac
          echo "supervisorctl signal \${2:-} $n" >> "${marker}"
          kill "$cur" 2>/dev/null
          newp="$(cat "$STATE/next-pid.$n" 2>/dev/null | tr -d '[:space:]')"
          grep -qxF "$n" "$STATE/no-relaunch" 2>/dev/null && newp=""
          case "$newp" in
            ''|*[!0-9]*)
              printf '0\\n' > "$STATE/pid.$n"
              awk -v n="$n" '$1 == n { $0 = n " STOPPED Oct 08 12:00 AM" } { print }' "$STATE/status" > "$STATE/status.tmp" \\
                && mv "$STATE/status.tmp" "$STATE/status";;
            *)
              printf '%s\\n' "$newp" > "$STATE/pid.$n"
              awk -v n="$n" -v p="$newp" '$1 == n { sub(/pid [0-9]+/, "pid " p) } { print }' "$STATE/status" > "$STATE/status.tmp" \\
                && mv "$STATE/status.tmp" "$STATE/status";;
          esac
          exit 0;;
  start) n="\${2:-}"
         cur="$(cat "$STATE/pid.$n" 2>/dev/null | tr -d '[:space:]')"
         case "$cur" in ''|0|*[!0-9]*) ;; *) exit 1;; esac
         newp="$(cat "$STATE/next-pid.$n" 2>/dev/null | tr -d '[:space:]')"
         case "$newp" in ''|*[!0-9]*) exit 1;; esac
         echo "supervisorctl start $n" >> "${marker}"
         printf '%s\\n' "$newp" > "$STATE/pid.$n"
         awk -v n="$n" -v p="$newp" '$1 == n { $0 = n " RUNNING pid " p ", uptime 0:00:01" } { print }' "$STATE/status" > "$STATE/status.tmp" \\
           && mv "$STATE/status.tmp" "$STATE/status"
         exit 0;;
  stop) n="\${2:-}"
        cur="$(cat "$STATE/pid.$n" 2>/dev/null | tr -d '[:space:]')"
        # Like the real verb, stop on a program that is not RUNNING answers
        # "not running" and exits nonzero.
        case "$cur" in ''|0|*[!0-9]*) echo "$n: ERROR (not running)"; exit 1;; esac
        echo "supervisorctl stop $n" >> "${marker}"
        kill "$cur" 2>/dev/null
        printf '0\\n' > "$STATE/pid.$n"
        awk -v n="$n" '$1 == n { $0 = n " STOPPED Oct 08 12:00 AM" } { print }' "$STATE/status" > "$STATE/status.tmp" \\
          && mv "$STATE/status.tmp" "$STATE/status"
        exit 0;;
  restart) echo "supervisorctl restart \${2:-}" >> "${marker}"
           grep -qxF "\${2:-}" "$STATE/restart-fail" 2>/dev/null && exit 1
           exit 0;;
esac
exit 0
`, { mode: 0o755 });
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
// A data dir laid out the way a configured install can leave it: the port is
// only on connection.json's url and the token only in a relocated file named
// by config.appTokenFile (vps-browser-host.cjs supports both).
function makeRelocatedDataDir(port) {
  const dir = mktemp('vm-update-data-');
  const tokenFile = path.join(dir, 'moved', 'token.json');
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
  fs.writeFileSync(tokenFile, JSON.stringify({ token: 'fixture-token' }));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ appTokenFile: tokenFile }));
  fs.writeFileSync(path.join(dir, 'connection.json'), JSON.stringify({ url: `http://127.0.0.1:${port}`, protocol: 1, host: 'vps' }));
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
  // A closed PATH and HOME so the script under test can never reach the real
  // hermes CLI, ~/.local/bin/hermes or ~/.hermes on the machine running them.
  PATH: `${bin}:/usr/bin:/bin`,
  HOME: data,
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
  for (const child of fakeDaemons) { try { child.kill('SIGKILL'); } catch {} }
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
  assert.deepEqual(result, { ok: true, version: '0.3.2', restarted: true, error: '', plugins: [], gatewayRestarted: false });
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

test('a same-named local branch cannot stand in for a missing tag', async () => {
  const lonely = makeRemote();
  git(lonely, 'tag', '-d', 'v0.3.2');
  const checkout = makeCheckout(lonely);
  git(checkout, 'branch', 'v0.3.2', 'origin/main');
  const { bin, marker } = makeBin();
  const port = await makeStatus({ version: '0.3.2', busy: false });
  const res = await runScript(['v0.3.2'], envFor(checkout, makeDataDir(port), bin));
  const result = lastJson(res);
  assert.notEqual(res.status, 0, res.stdout);
  assert.equal(result.ok, false);
  assert.match(result.error, /tag v0\.3\.2/i);
  assert.equal(git(checkout, 'rev-parse', 'HEAD'), git(checkout, 'rev-parse', 'v0.3.1^{commit}'), 'the checkout was not moved');
  assert.equal(fs.existsSync(marker), false, 'no service was touched');
});

test('a same-named local branch does not shadow a real tag', async () => {
  const checkout = makeCheckout(remote);
  git(checkout, 'branch', 'v0.3.2', 'v0.3.1');
  const { bin } = makeBin();
  const port = await makeStatus({ version: '0.3.2', busy: false });
  const res = await runScript(['v0.3.2'], envFor(checkout, makeDataDir(port), bin));
  const result = lastJson(res);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(result.ok, true);
  assert.equal(git(checkout, 'rev-parse', 'HEAD'), git(checkout, 'rev-parse', 'refs/tags/v0.3.2^{commit}'));
});

test('--help prints usage even when the script is piped over ssh stdin', () => {
  const res = spawnSync('sh', ['-s', '--', '--help'], { input: fs.readFileSync(SCRIPT, 'utf8'), encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /vm-update\.sh/);
  assert.match(res.stdout, /--check/);
  assert.doesNotMatch(res.stdout, /—/);
});

test('error strings carrying backslashes or quotes stay valid JSON', async () => {
  const checkout = makeCheckout(remote);
  const { bin } = makeBin();
  const res = await runScript(['v1.2.3\\x"y'], envFor(checkout, makeDataDir(9), bin));
  assert.notEqual(res.status, 0);
  const result = lastJson(res);
  assert.equal(result.ok, false);
  assert.match(result.error, /v1\.2\.3\\x"y/);
});

test('the status read follows connection.json and a relocated token file', async () => {
  const checkout = makeCheckout(remote);
  const port = await makeStatus({ version: '0.3.1', busy: false });
  const res = await runScript(['--check'], envFor(checkout, makeRelocatedDataDir(port), makeBin().bin));
  const result = lastJson(res);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(result.ok, true);
  assert.equal(result.hostVersion, '0.3.1');
});

test('the busy gate still applies when the data dir was relocated', async () => {
  const checkout = makeCheckout(remote);
  const { bin } = makeBin();
  const port = await makeStatus({ version: '0.3.1', busy: true });
  const res = await runScript(['v0.3.2'], envFor(checkout, makeRelocatedDataDir(port), bin));
  const result = lastJson(res);
  assert.notEqual(res.status, 0);
  assert.equal(result.ok, false);
  assert.match(result.error, /busy/i);
  assert.equal(git(checkout, 'describe', '--tags', 'HEAD').trim(), 'v0.3.1', 'the checkout was not moved');
});

test('the Windows twin pins full tag refs and retries the fetch like the POSIX script', () => {
  const ps1 = fs.readFileSync(WINDOWS_SCRIPT, 'utf8');
  assert.match(ps1, /refs\/tags\//, 'resolves refs/tags/<tag>, never a loose name');
  assert.doesNotMatch(ps1, /rev-parse --verify -q "\$Tag\^\{commit\}"/, 'no loose tag lookup left');
  assert.match(ps1, /--unshallow/, 'keeps the shallow-fetch fallback');
  assert.match(ps1, /--depth=1000000/, 'keeps the deep-fetch fallback');
  assert.match(ps1, /connection\.json/, 'reads the broker-written connection file');
  assert.match(ps1, /'plugins', 'update'/, 'plugin updates go through hermes plugins update');
  assert.match(ps1, /'gateway', 'restart'/, 'one drain-restart through hermes gateway restart');
  assert.match(ps1, /RedirectStandardInput/, 'hermes runs with stdin closed so no consent prompt can be answered');
  assert.match(ps1, /needs_approval/, 'consent gates surface as needs_approval');
  assert.doesNotMatch(ps1, /--yes|--force/, 'no consent bypass flags');
});

// --- Hermes plugin phase --------------------------------------------------
// A fake `hermes` on PATH. Control files under the state dir decide outcomes:
//   $STATE/mode.<profile>.<name>  update|current|consent|fail|caps
//   $STATE/gwfail                  makes `gateway restart` exit 1
//   $STATE/gwguard                 refuses `plugins update` while the gateway
//                                  is live, like the recent-hermes guard
//   $STATE/gwstate                 the unmanaged gateway's state file:
//                                  `gateway stop`/`gateway start` and the
//                                  fake systemctl keep it stopped|running
//   $STATE/updated-version         the version "update" writes to plugin.yaml
//   $STATE/hermes.log              one line per invocation
//   $STATE/restarts.log            one line per `gateway restart`
// $FAKE_SVC_LOG (when set) also gets one line per invocation, so a test can
// interleave hermes calls with the service-manager marker log.
const FAKE_HERMES = `#!/bin/sh
STATE="$FAKE_HERMES_STATE"
P=default
if [ "\${1:-}" = "-p" ]; then P="$2"; shift 2; fi
printf 'hermes -p %s %s\\n' "$P" "$*" >> "$STATE/hermes.log"
[ -n "\${FAKE_SVC_LOG:-}" ] && printf 'hermes -p %s %s\\n' "$P" "$*" >> "$FAKE_SVC_LOG"
# The gateway counts as live while a supervisor program reports RUNNING whose
# process argv carries 'gateway run' (the same match the script uses), or
# while a fixture without supervisord left gwstate at "running".
gw_live() {
  [ -f "$STATE/gwguard" ] || return 1
  if [ -n "\${FAKE_SUPERVISOR_STATE:-}" ] && [ -f "$FAKE_SUPERVISOR_STATE/status" ]; then
    while read -r _n _s _rest; do
      [ "$_s" = "RUNNING" ] || continue
      _p="$(cat "$FAKE_SUPERVISOR_STATE/pid.$_n" 2>/dev/null | tr -d '[:space:]')"
      case "$_p" in ''|0|*[!0-9]*) continue;; esac
      ps -p "$_p" -o args= 2>/dev/null | grep -q 'gateway run' && return 0
    done < "$FAKE_SUPERVISOR_STATE/status"
  fi
  [ "$(cat "$STATE/gwstate" 2>/dev/null || true)" = "running" ]
}
if [ "$1" = gateway ] && [ "$2" = restart ]; then
  if [ -f "$STATE/gwfail" ]; then echo 'gateway restart refused'; exit 1; fi
  printf 'restart\\n' >> "$STATE/restarts.log"; exit 0
fi
if [ "$1" = gateway ] && [ "$2" = stop ]; then printf 'stopped\\n' > "$STATE/gwstate"; exit 0; fi
if [ "$1" = gateway ] && [ "$2" = start ]; then printf 'running\\n' > "$STATE/gwstate"; exit 0; fi
if [ "$1" = plugins ] && [ "$2" = update ]; then
  name="$3"
  if gw_live; then
    echo 'Cannot update plugin files while the messaging gateway is running and its loaded plugin callbacks import from the installed checkouts.'
    echo 'Run \`hermes gateway stop\`, apply the change, then \`hermes gateway start\`.'
    echo 'To skip this check pass --allow-live-gateway (callbacks may fail until restart).'
    exit 1
  fi
  if [ "$P" = default ]; then PH="$HERMES_HOME"; else PH="$HERMES_HOME/profiles/$P"; fi
  mode="$(cat "$STATE/mode.$P.$name" 2>/dev/null || echo update)"
  case "$mode" in
    current) echo "Plugin $name is already up to date."; exit 0;;
    consent) echo 'Non-interactive session: update NOT applied (fail closed).'
             echo "Update of $name not applied: Updating '$name' to abc1234 adds tools.new; Confirm to continue."
             exit 1;;
    fail) echo 'Error: plugin registry unreachable'; exit 1;;
    *) v="$(cat "$STATE/updated-version" 2>/dev/null || echo 9.9.9)"
       sed "s/^version:.*/version: \\"$v\\"/" "$PH/plugins/$name/plugin.yaml" > "$PH/plugins/$name/plugin.yaml.tmp" \\
         && mv "$PH/plugins/$name/plugin.yaml.tmp" "$PH/plugins/$name/plugin.yaml"
       echo "Plugin $name updated."
       if [ "$mode" = caps ]; then
         echo "Plugin $name has new capabilities; review them with hermes plugins capabilities $name."
         echo 'Non-interactive session: capabilities NOT granted (fail closed).'
       fi
       exit 0;;
  esac
fi
echo "unexpected call: $*"; exit 2
`;
function makeHermesState() {
  const state = mktemp('vm-update-hermes-state-');
  fs.writeFileSync(path.join(state, 'updated-version'), '0.6.2');
  return state;
}
function addHermes(bin, state) {
  fs.writeFileSync(path.join(bin, 'hermes'), FAKE_HERMES, { mode: 0o755 });
  return { log: () => (fs.existsSync(path.join(state, 'hermes.log')) ? fs.readFileSync(path.join(state, 'hermes.log'), 'utf8') : ''),
    restarts: () => (fs.existsSync(path.join(state, 'restarts.log')) ? fs.readFileSync(path.join(state, 'restarts.log'), 'utf8').trim().split('\n').length : 0) };
}
function makeHermesHome() {
  const home = mktemp('vm-update-hermes-home-');
  fs.mkdirSync(path.join(home, 'plugins'), { recursive: true });
  return home;
}
function addProfile(home, name) {
  const dir = path.join(home, 'profiles', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.yaml'), 'model: fixture\n');
}
// A plugin install: <home>/plugins/<name>/plugin.yaml plus an entry in the
// profile's .install-metadata.json (the file `hermes plugins update` reads).
function addPlugin(home, profile, name, version, entry) {
  const ph = profile === 'default' ? home : path.join(home, 'profiles', profile);
  const dir = path.join(ph, 'plugins', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugin.yaml'), `name: ${name}\nversion: "${version}"\n`);
  const metaPath = path.join(ph, 'plugins', '.install-metadata.json');
  const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) : {};
  meta[name] = entry || { pinned: false, revision: 'aaa111', source: 'https://example.com/repo.git' };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
}
// An alans-way-agents clone (what `file://` plugin sources point at) pinned to
// the older release tag v0.6.0; the remote also carries v0.6.2.
function makePluginClone() {
  const remoteDir = mktemp('alans-way-agents-remote-');
  execFileSync('git', ['init', '--bare', '-q', remoteDir]);
  const work = mktemp('alans-way-agents-seed-');
  execFileSync('git', ['init', '-b', 'main', '-q', work]);
  git(work, 'config', 'user.email', 'fixture@example.com');
  git(work, 'config', 'user.name', 'fixture');
  fs.mkdirSync(path.join(work, 'alans-way'), { recursive: true });
  fs.writeFileSync(path.join(work, 'alans-way', 'plugin.yaml'), 'name: alans-way\nversion: "0.6.0"\n');
  git(work, 'add', '.'); git(work, 'commit', '-q', '-m', 'v0.6.0'); git(work, 'tag', 'v0.6.0');
  fs.writeFileSync(path.join(work, 'alans-way', 'plugin.yaml'), 'name: alans-way\nversion: "0.6.2"\n');
  git(work, 'add', '.'); git(work, 'commit', '-q', '-m', 'v0.6.2'); git(work, 'tag', 'v0.6.2');
  git(work, 'remote', 'add', 'origin', remoteDir);
  git(work, 'push', '-q', 'origin', 'main', '--tags');
  const clone = mktemp('alans-way-agents-clone-');
  execFileSync('git', ['clone', '-q', remoteDir, clone]);
  git(clone, 'config', 'user.email', 'fixture@example.com');
  git(clone, 'config', 'user.name', 'fixture');
  git(clone, 'checkout', '-q', 'refs/tags/v0.6.0');
  return clone;
}
const pluginEnv = (home, state) => ({ HERMES_HOME: home, FAKE_HERMES_STATE: state });

test('a VM without hermes still updates and reports an empty plugin list', async () => {
  const checkout = makeCheckout(remote);
  const { bin } = makeBin();
  const port = await makeStatus({ version: '0.3.2', busy: false });
  const res = await runScript(['v0.3.2'], envFor(checkout, makeDataDir(port), bin, pluginEnv(makeHermesHome(), mktemp('vm-update-hermes-state-'))));
  const result = lastJson(res);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(result.ok, true);
  assert.deepEqual(result.plugins, []);
  assert.equal(result.gatewayRestarted, false);
});

test('a file-sourced plugin advances its clone to the newest tag, updates and restarts the gateway once', async () => {
  const checkout = makeCheckout(remote);
  const { bin } = makeBin();
  const state = makeHermesState();
  const { log, restarts } = addHermes(bin, state);
  const home = makeHermesHome();
  const clone = makePluginClone();
  addPlugin(home, 'default', 'alans-way', '0.6.1', { pinned: false, revision: 'aaa111', source: `file://${clone}#alans-way` });
  const port = await makeStatus({ version: '0.3.2', busy: false });
  const res = await runScript(['v0.3.2'], envFor(checkout, makeDataDir(port), bin, pluginEnv(home, state)));
  const result = lastJson(res);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(result.ok, true);
  assert.deepEqual(result.plugins, [
    { profile: 'default', name: 'alans-way', before: '0.6.1', after: '0.6.2', status: 'updated', repoRef: 'v0.6.2' }]);
  assert.equal(result.gatewayRestarted, true);
  assert.equal(restarts(), 1);
  assert.equal(git(clone, 'rev-parse', 'HEAD'), git(clone, 'rev-parse', 'refs/tags/v0.6.2^{commit}'), 'clone pinned to the newest tag');
  assert.match(log(), /plugins update alans-way/, 'update went through hermes');
});

test('plugin updates across profiles restart the gateway a single time', async () => {
  const checkout = makeCheckout(remote);
  const { bin } = makeBin();
  const state = makeHermesState();
  const { restarts } = addHermes(bin, state);
  const home = makeHermesHome();
  const clone = makePluginClone();
  const entry = { pinned: false, revision: 'aaa111', source: `file://${clone}#alans-way` };
  addPlugin(home, 'default', 'alans-way', '0.6.1', entry);
  addProfile(home, 'alpha');
  addPlugin(home, 'alpha', 'alans-way', '0.5.0', entry);
  addPlugin(home, 'alpha', 'alans-way-computer', '0.5.0', { ...entry, source: `file://${clone}#alans-way-computer` });
  addProfile(home, 'beta');
  addPlugin(home, 'beta', 'alans-way', '0.5.0', entry);
  const port = await makeStatus({ version: '0.3.2', busy: false });
  const res = await runScript(['v0.3.2'], envFor(checkout, makeDataDir(port), bin, pluginEnv(home, state)));
  const result = lastJson(res);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(result.plugins.length, 4);
  for (const p of result.plugins) assert.equal(p.status, 'updated', JSON.stringify(p));
  assert.equal(result.gatewayRestarted, true);
  assert.equal(restarts(), 1, 'one gateway restart per VM');
});

test('a current plugin means no gateway restart', async () => {
  const checkout = makeCheckout(remote);
  const { bin } = makeBin();
  const state = makeHermesState();
  const { restarts } = addHermes(bin, state);
  const home = makeHermesHome();
  addPlugin(home, 'default', 'alans-way', '0.6.2');
  fs.writeFileSync(path.join(state, 'mode.default.alans-way'), 'current');
  const port = await makeStatus({ version: '0.3.2', busy: false });
  const res = await runScript(['v0.3.2'], envFor(checkout, makeDataDir(port), bin, pluginEnv(home, state)));
  const result = lastJson(res);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(result.plugins[0], { profile: 'default', name: 'alans-way', before: '0.6.2', after: '0.6.2', status: 'current' });
  assert.equal(result.gatewayRestarted, false);
  assert.equal(restarts(), 0);
});

test('a consent-gated update reports needs_approval, never answers a prompt and never restarts', async () => {
  const checkout = makeCheckout(remote);
  const { bin } = makeBin();
  const state = makeHermesState();
  const { log, restarts } = addHermes(bin, state);
  const home = makeHermesHome();
  addPlugin(home, 'default', 'alans-way', '0.6.1');
  fs.writeFileSync(path.join(state, 'mode.default.alans-way'), 'consent');
  const port = await makeStatus({ version: '0.3.2', busy: false });
  const res = await runScript(['v0.3.2'], envFor(checkout, makeDataDir(port), bin, pluginEnv(home, state)));
  const result = lastJson(res);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(result.ok, true, 'a plugin consent gate is never a VM failure');
  assert.equal(result.plugins[0].status, 'needs_approval');
  assert.equal(result.plugins[0].after, '0.6.1', 'nothing was applied');
  assert.equal(result.gatewayRestarted, false);
  assert.equal(restarts(), 0);
  assert.doesNotMatch(log(), /--yes|--force/, 'no consent bypass flags');
});

test('a plugin update failure is a warning, not a VM failure', async () => {
  const checkout = makeCheckout(remote);
  const { bin } = makeBin();
  const state = makeHermesState();
  addHermes(bin, state);
  const home = makeHermesHome();
  addPlugin(home, 'default', 'alans-way', '0.6.1');
  fs.writeFileSync(path.join(state, 'mode.default.alans-way'), 'fail');
  const port = await makeStatus({ version: '0.3.2', busy: false });
  const res = await runScript(['v0.3.2'], envFor(checkout, makeDataDir(port), bin, pluginEnv(home, state)));
  const result = lastJson(res);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(result.ok, true);
  assert.equal(result.plugins[0].status, 'failed');
  assert.match(result.plugins[0].error, /registry unreachable/);
  assert.equal(result.gatewayRestarted, false);
});

test('a plugin clone with local changes is left alone and the plugin reported skipped', async () => {
  const checkout = makeCheckout(remote);
  const { bin } = makeBin();
  const state = makeHermesState();
  const { log, restarts } = addHermes(bin, state);
  const home = makeHermesHome();
  const clone = makePluginClone();
  fs.writeFileSync(path.join(clone, 'dirty.txt'), 'local edit\n');
  addPlugin(home, 'default', 'alans-way', '0.6.1', { pinned: false, revision: 'aaa111', source: `file://${clone}#alans-way` });
  const port = await makeStatus({ version: '0.3.2', busy: false });
  const res = await runScript(['v0.3.2'], envFor(checkout, makeDataDir(port), bin, pluginEnv(home, state)));
  const result = lastJson(res);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(result.plugins[0].status, 'skipped');
  assert.match(result.plugins[0].error, /local changes/);
  assert.equal(git(clone, 'rev-parse', 'HEAD'), git(clone, 'rev-parse', 'refs/tags/v0.6.0^{commit}'), 'clone untouched');
  assert.doesNotMatch(log(), /plugins update/, 'a dirty clone skips the plugin update');
  assert.equal(restarts(), 0);
});

test('a plugin clone on a diverged commit is left alone and reported skipped', async () => {
  const checkout = makeCheckout(remote);
  const { bin } = makeBin();
  const state = makeHermesState();
  const { log } = addHermes(bin, state);
  const home = makeHermesHome();
  const clone = makePluginClone();
  fs.writeFileSync(path.join(clone, 'dev.txt'), 'dev commit\n');
  git(clone, 'add', 'dev.txt'); git(clone, 'commit', '-q', '-m', 'diverged');
  addPlugin(home, 'default', 'alans-way', '0.6.1', { pinned: false, revision: 'aaa111', source: `file://${clone}#alans-way` });
  const port = await makeStatus({ version: '0.3.2', busy: false });
  const res = await runScript(['v0.3.2'], envFor(checkout, makeDataDir(port), bin, pluginEnv(home, state)));
  const result = lastJson(res);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(result.plugins[0].status, 'skipped');
  assert.doesNotMatch(log(), /plugins update/);
});

test('a catalog-installed plugin updates through hermes and never consults a clone', async () => {
  const checkout = makeCheckout(remote);
  const { bin } = makeBin();
  const state = makeHermesState();
  const { log, restarts } = addHermes(bin, state);
  const home = makeHermesHome();
  addPlugin(home, 'default', 'alans-way', '0.6.1', {
    catalog: { name: 'alans-way', pin: 'bbb222', repo: 'https://example.com/alans-way-agents', sha: 'bbb222', tier: 'official' },
    pinned: true, revision: 'bbb222', source: 'https://example.com/alans-way-agents',
  });
  const port = await makeStatus({ version: '0.3.2', busy: false });
  const res = await runScript(['v0.3.2'], envFor(checkout, makeDataDir(port), bin, pluginEnv(home, state)));
  const result = lastJson(res);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(result.plugins[0].status, 'updated');
  assert.match(log(), /plugins update alans-way/);
  assert.equal(restarts(), 1);
});

test('a VM with hermes but no managed plugins reports an empty plugin list', async () => {
  const checkout = makeCheckout(remote);
  const { bin } = makeBin();
  const state = makeHermesState();
  const { restarts } = addHermes(bin, state);
  const home = makeHermesHome();
  addProfile(home, 'alpha');
  addPlugin(home, 'alpha', 'unrelated-plugin', '1.0.0');
  const port = await makeStatus({ version: '0.3.2', busy: false });
  const res = await runScript(['v0.3.2'], envFor(checkout, makeDataDir(port), bin, pluginEnv(home, state)));
  const result = lastJson(res);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(result.plugins, []);
  assert.equal(result.gatewayRestarted, false);
  assert.equal(restarts(), 0);
});

// --- guests without systemd ------------------------------------------------
// A VM image can ship a systemctl binary that answers "offline"; the services
// then live under supervisord and restart through supervisorctl.

test('a guest without systemd restarts the broker through its supervisord program', async () => {
  const checkout = makeCheckout(remote);
  const { bin, marker } = makeBin();
  fs.writeFileSync(path.join(bin, 'systemd-state'), 'offline\n');
  const sstate = mktemp('vm-update-supervisor-');
  const pid = spawnDaemon('vps-browser-host.cjs', 'serve');
  fs.writeFileSync(path.join(sstate, 'status'), `worker-one RUNNING pid ${pid}, uptime 0:01:00\n`);
  fs.writeFileSync(path.join(sstate, 'pid.worker-one'), `${pid}\n`);
  addSupervisor(bin, marker, sstate);
  const port = await makeStatus({ version: '0.3.2', busy: false });
  const res = await runScript(['v0.3.2'], envFor(checkout, makeDataDir(port), bin,
    { FAKE_SUPERVISOR_STATE: sstate, ...pluginEnv(makeHermesHome(), mktemp('vm-update-hermes-state-')) }));
  const result = lastJson(res);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(result.ok, true);
  assert.equal(result.restarted, true);
  const markerText = fs.readFileSync(marker, 'utf8');
  assert.match(markerText, /supervisorctl restart worker-one/);
  assert.doesNotMatch(markerText, /systemctl (--user )?restart/);
});

test('a stopped broker program resolves through its supervisor conf command line', async () => {
  const checkout = makeCheckout(remote);
  const { bin, marker } = makeBin();
  fs.writeFileSync(path.join(bin, 'systemd-state'), 'offline\n');
  const sstate = mktemp('vm-update-supervisor-');
  fs.writeFileSync(path.join(sstate, 'status'), 'unrelated RUNNING pid 1, uptime 9:09:09\n');
  fs.writeFileSync(path.join(sstate, 'pid.unrelated'), '1\n');
  addSupervisor(bin, marker, sstate);
  const confdir = mktemp('vm-update-confd-');
  fs.writeFileSync(path.join(confdir, 'apps.conf'),
    '[program:browser-svc]\ncommand=/usr/bin/node /opt/x/vps-browser-host.cjs serve\nautorestart=unexpected\n');
  const port = await makeStatus({ version: '0.3.2', busy: false });
  const res = await runScript(['v0.3.2'], envFor(checkout, makeDataDir(port), bin, {
    FAKE_SUPERVISOR_STATE: sstate,
    ALANS_WAY_VM_SUPERVISOR_CONFS: `${confdir}/*.conf`,
    ...pluginEnv(makeHermesHome(), mktemp('vm-update-hermes-state-')),
  }));
  const result = lastJson(res);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(result.restarted, true);
  assert.match(fs.readFileSync(marker, 'utf8'), /supervisorctl restart browser-svc/);
});

test('an unresolvable broker program names supervisorctl, never a dead systemctl', async () => {
  const checkout = makeCheckout(remote);
  const { bin, marker } = makeBin();
  fs.writeFileSync(path.join(bin, 'systemd-state'), 'offline\n');
  const sstate = mktemp('vm-update-supervisor-');
  fs.writeFileSync(path.join(sstate, 'status'), '');
  addSupervisor(bin, marker, sstate);
  const port = await makeStatus({ version: '0.3.2', busy: false });
  const res = await runScript(['v0.3.2'], envFor(checkout, makeDataDir(port), bin,
    { FAKE_SUPERVISOR_STATE: sstate, ALANS_WAY_VM_SUPERVISOR_CONFS: `${mktemp('vm-update-confd-')}/*.conf`,
      ...pluginEnv(makeHermesHome(), mktemp('vm-update-hermes-state-')) }));
  const result = lastJson(res);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(result.restarted, false);
  assert.match(res.stdout, /supervisorctl status/);
  assert.doesNotMatch(res.stdout, /run: systemctl/);
  assert.doesNotMatch(fs.readFileSync(marker, 'utf8'), /systemctl (--user )?restart/);
});

test('a plugin change drains a supervisord-managed gateway through SIGUSR1', async () => {
  const checkout = makeCheckout(remote);
  const { bin, marker } = makeBin();
  fs.writeFileSync(path.join(bin, 'systemd-state'), 'offline\n');
  const state = makeHermesState();
  const { log, restarts } = addHermes(bin, state);
  const home = makeHermesHome();
  addPlugin(home, 'default', 'alans-way', '0.6.1');
  const sstate = mktemp('vm-update-supervisor-');
  const pid = spawnDaemon('hermes', 'gateway', 'run', '--no-supervise');
  const pid2 = spawnDaemon('hermes', 'gateway', 'run', '--no-supervise');
  fs.writeFileSync(path.join(sstate, 'status'), `gw-one RUNNING pid ${pid}, uptime 0:02:00\n`);
  fs.writeFileSync(path.join(sstate, 'pid.gw-one'), `${pid}\n`);
  fs.writeFileSync(path.join(sstate, 'next-pid.gw-one'), `${pid2}\n`);
  addSupervisor(bin, marker, sstate);
  const port = await makeStatus({ version: '0.3.2', busy: false });
  const res = await runScript(['v0.3.2'], envFor(checkout, makeDataDir(port), bin,
    { FAKE_SUPERVISOR_STATE: sstate, ...pluginEnv(home, state) }));
  const result = lastJson(res);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(result.plugins[0].status, 'updated');
  assert.equal(result.gatewayRestarted, true);
  assert.equal(result.gatewayRestartCmd, 'supervisorctl signal USR1 gw-one');
  assert.equal(restarts(), 0, 'no hermes gateway restart on a supervisord guest');
  assert.doesNotMatch(log(), /gateway restart/);
  const markerText = fs.readFileSync(marker, 'utf8');
  assert.match(markerText, /supervisorctl signal USR1 gw-one/);
  assert.doesNotMatch(markerText, /supervisorctl restart/, 'a drain restart never escalates to SIGKILL');
});

test('a gateway still down after the drain is started through supervisorctl', async () => {
  const checkout = makeCheckout(remote);
  const { bin, marker } = makeBin();
  fs.writeFileSync(path.join(bin, 'systemd-state'), 'offline\n');
  const state = makeHermesState();
  const { restarts } = addHermes(bin, state);
  const home = makeHermesHome();
  addPlugin(home, 'default', 'alans-way', '0.6.1');
  const sstate = mktemp('vm-update-supervisor-');
  const pid = spawnDaemon('hermes', 'gateway', 'run', '--no-supervise');
  const pid2 = spawnDaemon('hermes', 'gateway', 'run', '--no-supervise');
  fs.writeFileSync(path.join(sstate, 'status'), `gw-one RUNNING pid ${pid}, uptime 0:02:00\n`);
  fs.writeFileSync(path.join(sstate, 'pid.gw-one'), `${pid}\n`);
  fs.writeFileSync(path.join(sstate, 'next-pid.gw-one'), `${pid2}\n`);
  fs.writeFileSync(path.join(sstate, 'no-relaunch'), 'gw-one\n');
  addSupervisor(bin, marker, sstate);
  const port = await makeStatus({ version: '0.3.2', busy: false });
  const res = await runScript(['v0.3.2'], envFor(checkout, makeDataDir(port), bin,
    { FAKE_SUPERVISOR_STATE: sstate, ALANS_WAY_VM_GATEWAY_TIMEOUT: '2',
      ...pluginEnv(home, state) }));
  const result = lastJson(res);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(result.gatewayRestarted, true);
  assert.equal(result.gatewayRestartCmd, 'supervisorctl start gw-one');
  const markerText = fs.readFileSync(marker, 'utf8');
  assert.match(markerText, /supervisorctl signal USR1 gw-one/);
  assert.match(markerText, /supervisorctl start gw-one/);
  assert.equal(restarts(), 0);
});

test('a supervisor without the signal verb falls back to supervisorctl restart', async () => {
  const checkout = makeCheckout(remote);
  const { bin, marker } = makeBin();
  fs.writeFileSync(path.join(bin, 'systemd-state'), 'offline\n');
  const state = makeHermesState();
  const { restarts } = addHermes(bin, state);
  const home = makeHermesHome();
  addPlugin(home, 'default', 'alans-way', '0.6.1');
  const sstate = mktemp('vm-update-supervisor-');
  const pid = spawnDaemon('hermes', 'gateway', 'run', '--no-supervise');
  fs.writeFileSync(path.join(sstate, 'status'), `gw-one RUNNING pid ${pid}, uptime 0:02:00\n`);
  fs.writeFileSync(path.join(sstate, 'pid.gw-one'), `${pid}\n`);
  fs.writeFileSync(path.join(sstate, 'signal-fail'), 'gw-one\n');
  addSupervisor(bin, marker, sstate);
  const port = await makeStatus({ version: '0.3.2', busy: false });
  const res = await runScript(['v0.3.2'], envFor(checkout, makeDataDir(port), bin,
    { FAKE_SUPERVISOR_STATE: sstate, ...pluginEnv(home, state) }));
  const result = lastJson(res);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(result.gatewayRestarted, true);
  assert.equal(result.gatewayRestartCmd, 'supervisorctl restart gw-one');
  const markerText = fs.readFileSync(marker, 'utf8');
  assert.match(markerText, /supervisorctl restart gw-one/);
  assert.doesNotMatch(markerText, /supervisorctl signal/, 'the signal verb itself was never usable');
  assert.equal(restarts(), 0);
});

test('a failed supervisord gateway restart names the working command, not a dead one', async () => {
  const checkout = makeCheckout(remote);
  const { bin, marker } = makeBin();
  fs.writeFileSync(path.join(bin, 'systemd-state'), 'offline\n');
  const state = makeHermesState();
  fs.writeFileSync(path.join(state, 'gwfail'), '');
  const { log } = addHermes(bin, state);
  const home = makeHermesHome();
  addPlugin(home, 'default', 'alans-way', '0.6.1');
  const sstate = mktemp('vm-update-supervisor-');
  const pid = spawnDaemon('hermes', 'gateway', 'run', '--no-supervise');
  fs.writeFileSync(path.join(sstate, 'status'), `gw-one RUNNING pid ${pid}, uptime 0:02:00\n`);
  fs.writeFileSync(path.join(sstate, 'pid.gw-one'), `${pid}\n`);
  fs.writeFileSync(path.join(sstate, 'signal-fail'), 'gw-one\n');
  fs.writeFileSync(path.join(sstate, 'restart-fail'), 'gw-one\n');
  addSupervisor(bin, marker, sstate);
  const port = await makeStatus({ version: '0.3.2', busy: false });
  const res = await runScript(['v0.3.2'], envFor(checkout, makeDataDir(port), bin,
    { FAKE_SUPERVISOR_STATE: sstate, ...pluginEnv(home, state) }));
  const result = lastJson(res);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(result.gatewayRestarted, false);
  assert.equal(result.gatewayRestartCmd, 'supervisorctl restart gw-one');
  assert.match(res.stdout, /on the VM run: supervisorctl restart gw-one/);
  assert.doesNotMatch(res.stdout, /on the VM run: hermes gateway restart/);
  assert.match(log(), /hermes -p default gateway restart/, 'hermes gateway restart stays the last resort');
});

test('a stale supervisor conf does not win on a host with a live systemd', async () => {
  const checkout = makeCheckout(remote);
  const { bin, marker } = makeBin();
  // No systemd-state file: the fake systemctl answers "running".
  const sstate = mktemp('vm-update-supervisor-');
  fs.writeFileSync(path.join(sstate, 'status'), 'web RUNNING pid 1, uptime 9:09:09\n');
  fs.writeFileSync(path.join(sstate, 'pid.web'), '1\n');
  addSupervisor(bin, marker, sstate);
  const confdir = mktemp('vm-update-confd-');
  fs.writeFileSync(path.join(confdir, 'leftover.conf'),
    '[program:browser-svc]\ncommand=/usr/bin/node /opt/x/vps-browser-host.cjs serve\n');
  const port = await makeStatus({ version: '0.3.2', busy: false });
  const res = await runScript(['v0.3.2'], envFor(checkout, makeDataDir(port), bin, {
    FAKE_SUPERVISOR_STATE: sstate,
    ALANS_WAY_VM_SUPERVISOR_CONFS: `${confdir}/*.conf`,
    ...pluginEnv(makeHermesHome(), mktemp('vm-update-hermes-state-')),
  }));
  const result = lastJson(res);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(result.restarted, true);
  const markerText = fs.readFileSync(marker, 'utf8');
  assert.match(markerText, /systemctl --user restart hermes-alans-way-browser\.service/);
  assert.doesNotMatch(markerText, /supervisorctl restart/, 'a leftover conf must not start a duplicate service');
});

test('a supervisor socket that needs root is still inspected through sudo -n', async () => {
  const checkout = makeCheckout(remote);
  const { bin, marker } = makeBin();
  fs.writeFileSync(path.join(bin, 'systemd-state'), 'offline\n');
  // A sudo that never asks: it tags the child so the fake supervisorctl can
  // tell a privileged call from a plain one.
  fs.writeFileSync(path.join(bin, 'sudo'), '#!/bin/sh\n[ "$1" = "-n" ] && shift\nexport FAKE_SUDO=1\nexec "$@"\n', { mode: 0o755 });
  const sstate = mktemp('vm-update-supervisor-');
  const pid = spawnDaemon('vps-browser-host.cjs', 'serve');
  fs.writeFileSync(path.join(sstate, 'status'), `broker-svc RUNNING pid ${pid}, uptime 0:01:00\n`);
  fs.writeFileSync(path.join(sstate, 'pid.broker-svc'), `${pid}\n`);
  addSupervisor(bin, marker, sstate, true);
  const port = await makeStatus({ version: '0.3.2', busy: false });
  const res = await runScript(['v0.3.2'], envFor(checkout, makeDataDir(port), bin,
    { FAKE_SUPERVISOR_STATE: sstate, ...pluginEnv(makeHermesHome(), mktemp('vm-update-hermes-state-')) }));
  const result = lastJson(res);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(result.restarted, true);
  assert.match(fs.readFileSync(marker, 'utf8'), /supervisorctl restart broker-svc/);
});

test('a program still starting resolves by its pid on a sudo-capable socket', async () => {
  const checkout = makeCheckout(remote);
  const { bin, marker } = makeBin();
  fs.writeFileSync(path.join(bin, 'systemd-state'), 'offline\n');
  fs.writeFileSync(path.join(bin, 'sudo'), '#!/bin/sh\n[ "$1" = "-n" ] && shift\nexec "$@"\n', { mode: 0o755 });
  const sstate = mktemp('vm-update-supervisor-');
  // STARTING has a live pid but `supervisorctl pid` still exits nonzero for
  // it; the EXITED entry keeps `status` failing too, so both answers come
  // from calls whose exit status says failure while the output is valid.
  const pid = spawnDaemon('vps-browser-host.cjs', 'serve');
  fs.writeFileSync(path.join(sstate, 'status'),
    `broker-svc STARTING pid ${pid}, uptime 0:00:01\ncrashed-svc EXITED Oct 07 10:00 PM\n`);
  fs.writeFileSync(path.join(sstate, 'pid.broker-svc'), `${pid}\n`);
  fs.writeFileSync(path.join(sstate, 'pid.crashed-svc'), '0\n');
  addSupervisor(bin, marker, sstate);
  const port = await makeStatus({ version: '0.3.2', busy: false });
  const res = await runScript(['v0.3.2'], envFor(checkout, makeDataDir(port), bin,
    { FAKE_SUPERVISOR_STATE: sstate, ...pluginEnv(makeHermesHome(), mktemp('vm-update-hermes-state-')) }));
  const result = lastJson(res);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(result.restarted, true);
  assert.match(fs.readFileSync(marker, 'utf8'), /supervisorctl restart broker-svc/);
});

test('a foreign "gateway run" program is never restarted for the agent gateway', async () => {
  const checkout = makeCheckout(remote);
  const { bin, marker } = makeBin();
  fs.writeFileSync(path.join(bin, 'systemd-state'), 'offline\n');
  const state = makeHermesState();
  const { restarts } = addHermes(bin, state);
  const home = makeHermesHome();
  addPlugin(home, 'default', 'alans-way', '0.6.1');
  const sstate = mktemp('vm-update-supervisor-');
  // An unrelated service that merely shares the words "gateway run".
  const pid = spawnDaemon('api-gateway', 'run', '--port', '8800');
  fs.writeFileSync(path.join(sstate, 'status'), `api-gateway RUNNING pid ${pid}, uptime 0:02:00\n`);
  fs.writeFileSync(path.join(sstate, 'pid.api-gateway'), `${pid}\n`);
  addSupervisor(bin, marker, sstate);
  const port = await makeStatus({ version: '0.3.2', busy: false });
  const res = await runScript(['v0.3.2'], envFor(checkout, makeDataDir(port), bin,
    { FAKE_SUPERVISOR_STATE: sstate, ...pluginEnv(home, state) }));
  const result = lastJson(res);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(result.plugins[0].status, 'updated');
  assert.equal(result.gatewayRestarted, true);
  assert.equal(result.gatewayRestartCmd, 'supervisorctl signal USR1 <program>');
  assert.equal(restarts(), 1, 'the plain hermes gateway restart path runs');
  assert.doesNotMatch(fs.readFileSync(marker, 'utf8'), /supervisorctl restart/, 'an unrelated program is left alone');
});

// --- live-gateway refusals ---------------------------------------------------
// Recent hermes refuses `plugins update` while the profile's gateway runs
// ("Cannot update plugin files while the messaging gateway is running"). The
// updater must drain-stop the gateway, retry only the refused pairs, and
// always start the gateway again.

test('a refused update drain-stops the supervisord gateway, retries it and starts the gateway again', async () => {
  const checkout = makeCheckout(remote);
  const { bin, marker } = makeBin();
  fs.writeFileSync(path.join(bin, 'systemd-state'), 'offline\n');
  const state = makeHermesState();
  fs.writeFileSync(path.join(state, 'gwguard'), '');
  const { log, restarts } = addHermes(bin, state);
  const home = makeHermesHome();
  addPlugin(home, 'default', 'alans-way', '0.6.1');
  addProfile(home, 'alpha');
  addPlugin(home, 'alpha', 'alans-way-computer', '0.5.0');
  const sstate = mktemp('vm-update-supervisor-');
  const pid = spawnDaemon('hermes', 'gateway', 'run', '--no-supervise');
  const pid2 = spawnDaemon('hermes', 'gateway', 'run', '--no-supervise');
  // Padded status columns, like real supervisorctl output.
  fs.writeFileSync(path.join(sstate, 'status'), `gw-one                          RUNNING   pid ${pid}, uptime 0:02:00\n`);
  fs.writeFileSync(path.join(sstate, 'pid.gw-one'), `${pid}\n`);
  fs.writeFileSync(path.join(sstate, 'next-pid.gw-one'), `${pid2}\n`);
  addSupervisor(bin, marker, sstate);
  const port = await makeStatus({ version: '0.3.2', busy: false });
  const res = await runScript(['v0.3.2'], envFor(checkout, makeDataDir(port), bin, {
    FAKE_SUPERVISOR_STATE: sstate, FAKE_SVC_LOG: marker,
    ALANS_WAY_VM_SUPERVISOR_CONFS: `${mktemp('vm-update-confd-')}/*.conf`,
    ...pluginEnv(home, state),
  }));
  const result = lastJson(res);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(result.plugins.map((p) => [p.profile, p.name, p.status, p.after]), [
    ['default', 'alans-way', 'updated', '0.6.2'],
    ['alpha', 'alans-way-computer', 'updated', '0.6.2'],
  ]);
  assert.equal(result.gatewayRestarted, true);
  assert.equal(restarts(), 0, 'no hermes gateway restart on a supervisord guest');
  assert.doesNotMatch(log(), /gateway restart/);
  const markerText = fs.readFileSync(marker, 'utf8');
  const i = (s) => markerText.indexOf(s);
  const l = (s) => markerText.lastIndexOf(s);
  assert.ok(i('hermes -p alpha plugins update alans-way-computer') > -1, markerText);
  assert.ok(i('signal USR1 gw-one') > i('hermes -p alpha plugins update alans-way-computer'),
    'the drain signal follows the refused first pass');
  assert.ok(i('supervisorctl stop gw-one') > i('signal USR1 gw-one'),
    'a plain stop after the drain so autorestart cannot relaunch it');
  assert.ok(l('hermes -p default plugins update alans-way') > i('supervisorctl stop gw-one'),
    'the retry ran while the gateway was down');
  assert.ok(l('hermes -p alpha plugins update alans-way-computer') > i('supervisorctl stop gw-one'));
  assert.ok(i('supervisorctl start gw-one') > l('hermes -p alpha plugins update alans-way-computer'),
    'the gateway starts after the retries');
  assert.doesNotMatch(markerText, /supervisorctl restart/, 'a drain never escalates to SIGKILL');
});

test('a stopped supervisor program is never started when the refusing gateway runs outside supervisord', async () => {
  const checkout = makeCheckout(remote);
  const { bin, marker } = makeBin();
  fs.writeFileSync(path.join(bin, 'systemd-state'), 'offline\n');
  const state = makeHermesState();
  fs.writeFileSync(path.join(state, 'gwguard'), '');
  fs.writeFileSync(path.join(state, 'gwstate'), 'running\n');
  addHermes(bin, state);
  const home = makeHermesHome();
  addPlugin(home, 'default', 'alans-way', '0.6.1');
  const sstate = mktemp('vm-update-supervisor-');
  fs.writeFileSync(path.join(sstate, 'status'), 'gw-one                          STOPPED   Oct 08 12:00 AM\n');
  fs.writeFileSync(path.join(sstate, 'pid.gw-one'), '0\n');
  addSupervisor(bin, marker, sstate);
  const confd = mktemp('vm-update-confd-');
  fs.writeFileSync(path.join(confd, 'gw.conf'), '[program:gw-one]\ncommand=hermes gateway run --no-supervise\n');
  const port = await makeStatus({ version: '0.3.2', busy: false });
  const res = await runScript(['v0.3.2'], envFor(checkout, makeDataDir(port), bin, {
    FAKE_SUPERVISOR_STATE: sstate, FAKE_SVC_LOG: marker,
    ALANS_WAY_VM_SUPERVISOR_CONFS: `${confd}/*.conf`,
    ...pluginEnv(home, state),
  }));
  const result = lastJson(res);
  assert.equal(res.status, 0, res.stderr);
  assert.doesNotMatch(fs.readFileSync(marker, 'utf8'), /supervisorctl (start|restart) gw-one/,
    'starting a program that was never running would add a second gateway');
  assert.notEqual(result.plugins[0].status, 'updated');
});

test('a run where nothing is refused never stops the gateway', async () => {
  const checkout = makeCheckout(remote);
  const { bin, marker } = makeBin();
  fs.writeFileSync(path.join(bin, 'systemd-state'), 'offline\n');
  const state = makeHermesState();
  fs.writeFileSync(path.join(state, 'gwguard'), '');
  const { restarts } = addHermes(bin, state);
  const home = makeHermesHome();
  addPlugin(home, 'default', 'alans-way', '0.6.1');
  const sstate = mktemp('vm-update-supervisor-');
  fs.writeFileSync(path.join(sstate, 'status'), 'gw-one                          STOPPED   Oct 08 12:00 AM\n');
  fs.writeFileSync(path.join(sstate, 'pid.gw-one'), '0\n');
  addSupervisor(bin, marker, sstate);
  const port = await makeStatus({ version: '0.3.2', busy: false });
  const res = await runScript(['v0.3.2'], envFor(checkout, makeDataDir(port), bin, {
    FAKE_SUPERVISOR_STATE: sstate, FAKE_SVC_LOG: marker,
    ALANS_WAY_VM_SUPERVISOR_CONFS: `${mktemp('vm-update-confd-')}/*.conf`,
    ...pluginEnv(home, state),
  }));
  const result = lastJson(res);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(result.plugins[0].status, 'updated');
  assert.equal(result.gatewayRestarted, true);
  assert.equal(restarts(), 1, 'the usual drain-restart still happens through hermes');
  const markerText = fs.readFileSync(marker, 'utf8');
  assert.doesNotMatch(markerText, /supervisorctl stop|supervisorctl signal/,
    'no drain-stop when nothing was refused');
  assert.doesNotMatch(markerText, /supervisorctl start/);
});

test('the gateway is started again even when the retried update fails', async () => {
  const checkout = makeCheckout(remote);
  const { bin, marker } = makeBin();
  fs.writeFileSync(path.join(bin, 'systemd-state'), 'offline\n');
  const state = makeHermesState();
  fs.writeFileSync(path.join(state, 'gwguard'), '');
  fs.writeFileSync(path.join(state, 'mode.default.alans-way'), 'fail');
  addHermes(bin, state);
  const home = makeHermesHome();
  addPlugin(home, 'default', 'alans-way', '0.6.1');
  const sstate = mktemp('vm-update-supervisor-');
  const pid = spawnDaemon('hermes', 'gateway', 'run', '--no-supervise');
  const pid2 = spawnDaemon('hermes', 'gateway', 'run', '--no-supervise');
  fs.writeFileSync(path.join(sstate, 'status'), `gw-one                          RUNNING   pid ${pid}, uptime 0:02:00\n`);
  fs.writeFileSync(path.join(sstate, 'pid.gw-one'), `${pid}\n`);
  fs.writeFileSync(path.join(sstate, 'next-pid.gw-one'), `${pid2}\n`);
  addSupervisor(bin, marker, sstate);
  const port = await makeStatus({ version: '0.3.2', busy: false });
  const res = await runScript(['v0.3.2'], envFor(checkout, makeDataDir(port), bin, {
    FAKE_SUPERVISOR_STATE: sstate, FAKE_SVC_LOG: marker,
    ALANS_WAY_VM_SUPERVISOR_CONFS: `${mktemp('vm-update-confd-')}/*.conf`,
    ...pluginEnv(home, state),
  }));
  const result = lastJson(res);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(result.plugins[0].status, 'failed');
  assert.match(result.plugins[0].error, /registry unreachable/);
  assert.equal(result.gatewayRestarted, true, 'the gateway is never left stopped');
  const markerText = fs.readFileSync(marker, 'utf8');
  assert.match(markerText, /supervisorctl stop gw-one/);
  assert.match(markerText, /supervisorctl start gw-one/);
});

test('a still-refused update reports blocked and keeps the whole refusal text', async () => {
  const checkout = makeCheckout(remote);
  const { bin, marker } = makeBin();
  fs.writeFileSync(path.join(bin, 'systemd-state'), 'offline\n');
  const state = makeHermesState();
  fs.writeFileSync(path.join(state, 'gwguard'), '');
  addHermes(bin, state);
  const home = makeHermesHome();
  addPlugin(home, 'default', 'alans-way', '0.6.1');
  const sstate = mktemp('vm-update-supervisor-');
  // A second live gateway keeps hermes refusing after gw-one goes down.
  const pid = spawnDaemon('hermes', 'gateway', 'run', '--no-supervise');
  const pid2 = spawnDaemon('hermes', 'gateway', 'run', '--no-supervise');
  const other = spawnDaemon('hermes', 'gateway', 'run', '--no-supervise');
  fs.writeFileSync(path.join(sstate, 'status'),
    `gw-one                          RUNNING   pid ${pid}, uptime 0:02:00\ngw-two                          RUNNING   pid ${other}, uptime 0:02:00\n`);
  fs.writeFileSync(path.join(sstate, 'pid.gw-one'), `${pid}\n`);
  fs.writeFileSync(path.join(sstate, 'next-pid.gw-one'), `${pid2}\n`);
  fs.writeFileSync(path.join(sstate, 'pid.gw-two'), `${other}\n`);
  addSupervisor(bin, marker, sstate);
  const port = await makeStatus({ version: '0.3.2', busy: false });
  const res = await runScript(['v0.3.2'], envFor(checkout, makeDataDir(port), bin, {
    FAKE_SUPERVISOR_STATE: sstate, FAKE_SVC_LOG: marker,
    ALANS_WAY_VM_SUPERVISOR_CONFS: `${mktemp('vm-update-confd-')}/*.conf`,
    ...pluginEnv(home, state),
  }));
  const result = lastJson(res);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(result.plugins[0].status, 'blocked');
  assert.match(result.plugins[0].error, /Cannot update plugin files while the messaging gateway is running/,
    'the refusal sentence survives instead of a tail-cut fragment');
  assert.match(result.plugins[0].error, /allow-live-gateway/, 'the whole message is kept');
  assert.equal(result.gatewayRestarted, true);
  const markerText = fs.readFileSync(marker, 'utf8');
  assert.match(markerText, /signal USR1 gw-one/);
  assert.doesNotMatch(markerText, /signal USR1 gw-two/, 'only the resolved program is drained');
  assert.match(markerText, /supervisorctl start gw-one/);
});

test('a refused update on a systemd guest stops and starts the hermes-gateway unit', async () => {
  const checkout = makeCheckout(remote);
  const { bin, marker } = makeBin();
  // No systemd-state file: the fake systemctl answers "running".
  const state = makeHermesState();
  fs.writeFileSync(path.join(state, 'gwguard'), '');
  fs.writeFileSync(path.join(state, 'gwstate'), 'running\n');
  addHermes(bin, state);
  const home = makeHermesHome();
  addPlugin(home, 'default', 'alans-way', '0.6.1');
  const port = await makeStatus({ version: '0.3.2', busy: false });
  const res = await runScript(['v0.3.2'], envFor(checkout, makeDataDir(port), bin, {
    FAKE_SVC_LOG: marker, ...pluginEnv(home, state),
  }));
  const result = lastJson(res);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(result.plugins[0].status, 'updated');
  assert.equal(result.plugins[0].after, '0.6.2');
  assert.equal(result.gatewayRestarted, true);
  const markerText = fs.readFileSync(marker, 'utf8');
  assert.ok(markerText.indexOf('stop hermes-gateway') > markerText.indexOf('plugins update alans-way'));
  assert.ok(markerText.lastIndexOf('plugins update alans-way') > markerText.indexOf('stop hermes-gateway'));
  assert.ok(markerText.indexOf('start hermes-gateway') > markerText.lastIndexOf('plugins update alans-way'));
});

test('a refused update with no service manager goes through hermes gateway stop and start', async () => {
  const checkout = makeCheckout(remote);
  const { bin, marker } = makeBin();
  fs.writeFileSync(path.join(bin, 'systemd-state'), 'offline\n');
  const state = makeHermesState();
  fs.writeFileSync(path.join(state, 'gwguard'), '');
  fs.writeFileSync(path.join(state, 'gwstate'), 'running\n');
  const { log } = addHermes(bin, state);
  const home = makeHermesHome();
  addPlugin(home, 'default', 'alans-way', '0.6.1');
  const port = await makeStatus({ version: '0.3.2', busy: false });
  const res = await runScript(['v0.3.2'], envFor(checkout, makeDataDir(port), bin, {
    ...pluginEnv(home, state),
  }));
  const result = lastJson(res);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(result.plugins[0].status, 'updated');
  assert.equal(result.gatewayRestarted, true);
  const calls = log();
  assert.ok(calls.indexOf('plugins update alans-way') < calls.indexOf('gateway stop'), calls);
  assert.ok(calls.indexOf('gateway stop') < calls.lastIndexOf('plugins update alans-way'), calls);
  assert.ok(calls.lastIndexOf('plugins update alans-way') < calls.indexOf('gateway start'), calls);
  assert.doesNotMatch(fs.readFileSync(marker, 'utf8'), /supervisorctl/);
});

test('a gateway still draining when the wait ends is left running and the pair reports blocked', async () => {
  const checkout = makeCheckout(remote);
  const { bin, marker } = makeBin();
  fs.writeFileSync(path.join(bin, 'systemd-state'), 'offline\n');
  const state = makeHermesState();
  fs.writeFileSync(path.join(state, 'gwguard'), '');
  addHermes(bin, state);
  const home = makeHermesHome();
  addPlugin(home, 'default', 'alans-way', '0.6.1');
  const sstate = mktemp('vm-update-supervisor-');
  const pid = spawnDaemon('hermes', 'gateway', 'run', '--no-supervise');
  fs.writeFileSync(path.join(sstate, 'status'), `gw-one                          RUNNING   pid ${pid}, uptime 0:02:00\n`);
  fs.writeFileSync(path.join(sstate, 'pid.gw-one'), `${pid}\n`);
  // USR1 lands but the drain never finishes inside the wait window.
  fs.writeFileSync(path.join(sstate, 'drain-hold'), 'gw-one\n');
  addSupervisor(bin, marker, sstate);
  const port = await makeStatus({ version: '0.3.2', busy: false });
  const res = await runScript(['v0.3.2'], envFor(checkout, makeDataDir(port), bin, {
    FAKE_SUPERVISOR_STATE: sstate, FAKE_SVC_LOG: marker,
    ALANS_WAY_VM_GATEWAY_TIMEOUT: '2',
    ALANS_WAY_VM_SUPERVISOR_CONFS: `${mktemp('vm-update-confd-')}/*.conf`,
    ...pluginEnv(home, state),
  }));
  const result = lastJson(res);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(result.plugins[0].status, 'blocked');
  assert.match(result.plugins[0].error, /Cannot update plugin files while the messaging gateway is running/);
  assert.equal(result.gatewayRestarted, false);
  const markerText = fs.readFileSync(marker, 'utf8');
  assert.match(markerText, /signal USR1 gw-one/);
  assert.doesNotMatch(markerText, /supervisorctl stop gw-one/,
    'a mid-drain gateway is never stopped (stop would escalate to SIGKILL)');
  assert.doesNotMatch(markerText, /supervisorctl start gw-one/, 'the gateway was never down');
  assert.equal(fs.readFileSync(path.join(sstate, 'pid.gw-one'), 'utf8').trim(), String(pid),
    'the pre-drain process still owns the program');
});

test('a supervisor without the signal verb leaves the live gateway alone and reports blocked', async () => {
  const checkout = makeCheckout(remote);
  const { bin, marker } = makeBin();
  fs.writeFileSync(path.join(bin, 'systemd-state'), 'offline\n');
  const state = makeHermesState();
  fs.writeFileSync(path.join(state, 'gwguard'), '');
  addHermes(bin, state);
  const home = makeHermesHome();
  addPlugin(home, 'default', 'alans-way', '0.6.1');
  const sstate = mktemp('vm-update-supervisor-');
  const pid = spawnDaemon('hermes', 'gateway', 'run', '--no-supervise');
  fs.writeFileSync(path.join(sstate, 'status'), `gw-one                          RUNNING   pid ${pid}, uptime 0:02:00\n`);
  fs.writeFileSync(path.join(sstate, 'pid.gw-one'), `${pid}\n`);
  fs.writeFileSync(path.join(sstate, 'signal-fail'), 'gw-one\n');
  addSupervisor(bin, marker, sstate);
  const port = await makeStatus({ version: '0.3.2', busy: false });
  const res = await runScript(['v0.3.2'], envFor(checkout, makeDataDir(port), bin, {
    FAKE_SUPERVISOR_STATE: sstate, FAKE_SVC_LOG: marker,
    ALANS_WAY_VM_SUPERVISOR_CONFS: `${mktemp('vm-update-confd-')}/*.conf`,
    ...pluginEnv(home, state),
  }));
  const result = lastJson(res);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(result.plugins[0].status, 'blocked');
  assert.equal(result.gatewayRestarted, false);
  assert.doesNotMatch(fs.readFileSync(marker, 'utf8'), /supervisorctl (stop|start) gw-one/,
    'the still-running pre-drain pid is never stopped');
});

test('a systemd guest without a hermes-gateway unit falls back to hermes gateway stop', async () => {
  const checkout = makeCheckout(remote);
  const { bin, marker } = makeBin();
  // No systemd-state file: the fake systemctl answers "running", but the
  // hermes-gateway unit does not exist on this host.
  fs.writeFileSync(path.join(bin, 'missing-units'), 'hermes-gateway\n');
  const state = makeHermesState();
  fs.writeFileSync(path.join(state, 'gwguard'), '');
  fs.writeFileSync(path.join(state, 'gwstate'), 'running\n');
  addHermes(bin, state);
  const home = makeHermesHome();
  addPlugin(home, 'default', 'alans-way', '0.6.1');
  const port = await makeStatus({ version: '0.3.2', busy: false });
  const res = await runScript(['v0.3.2'], envFor(checkout, makeDataDir(port), bin, {
    FAKE_SVC_LOG: marker, ...pluginEnv(home, state),
  }));
  const result = lastJson(res);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(result.plugins[0].status, 'updated');
  assert.equal(result.plugins[0].after, '0.6.2');
  assert.equal(result.gatewayRestarted, true);
  const markerText = fs.readFileSync(marker, 'utf8');
  const i = (s) => markerText.indexOf(s), l = (s) => markerText.lastIndexOf(s);
  assert.ok(i('stop hermes-gateway') > -1, 'the systemctl stop was tried first');
  assert.ok(i('hermes -p default gateway stop') > i('stop hermes-gateway'),
    'hermes gateway stop is the fallback when the unit does not exist');
  assert.ok(l('hermes -p default plugins update alans-way') > i('hermes -p default gateway stop'),
    'the retry ran while the gateway was down');
  assert.ok(i('hermes -p default gateway start') > l('hermes -p default plugins update alans-way'),
    'the gateway is started again after the retries');
});

test('a supervisor start failure names the sudo variant in the remediation', async () => {
  const checkout = makeCheckout(remote);
  const { bin, marker } = makeBin();
  fs.writeFileSync(path.join(bin, 'systemd-state'), 'offline\n');
  const state = makeHermesState();
  fs.writeFileSync(path.join(state, 'gwguard'), '');
  addHermes(bin, state);
  const home = makeHermesHome();
  addPlugin(home, 'default', 'alans-way', '0.6.1');
  const sstate = mktemp('vm-update-supervisor-');
  const pid = spawnDaemon('hermes', 'gateway', 'run', '--no-supervise');
  fs.writeFileSync(path.join(sstate, 'status'), `gw-one                          RUNNING   pid ${pid}, uptime 0:02:00\n`);
  fs.writeFileSync(path.join(sstate, 'pid.gw-one'), `${pid}\n`);
  // No next-pid.gw-one: the drain stops the program with no relaunch queued,
  // and the later `start` has nothing to launch, so it fails.
  addSupervisor(bin, marker, sstate);
  const confdir = mktemp('vm-update-confd-');
  fs.writeFileSync(path.join(confdir, 'apps.conf'),
    '[program:gw-one]\ncommand=/usr/bin/hermes gateway run\n');
  const port = await makeStatus({ version: '0.3.2', busy: false });
  const res = await runScript(['v0.3.2'], envFor(checkout, makeDataDir(port), bin, {
    FAKE_SUPERVISOR_STATE: sstate, FAKE_SVC_LOG: marker,
    ALANS_WAY_VM_SUPERVISOR_CONFS: `${confdir}/*.conf`,
    ...pluginEnv(home, state),
  }));
  const result = lastJson(res);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(result.plugins[0].status, 'updated');
  assert.match(res.stdout, /on the VM run: supervisorctl start gw-one \(or: sudo supervisorctl start gw-one\)/);
  assert.equal(result.gatewayRestarted, true, 'the tail drain-restart path recovers it');
});

// A read-only hermes for --doctor. Per profile P:
//   $STATE/updates.P.json  what `plugins check-updates --json` prints ("[]" when absent)
//   $STATE/backend.P       what `config get computer_use.backend` prints
//   $STATE/noise           when present, a warning line with brackets comes before the JSON
// Every call is logged; any other call fails, so a mutating call shows up.
const DOCTOR_HERMES = `#!/bin/sh
STATE="$FAKE_HERMES_STATE"
P=default
if [ "\${1:-}" = "-p" ]; then P="$2"; shift 2; fi
printf 'hermes -p %s %s\\n' "$P" "$*" >> "$STATE/hermes.log"
if [ "$1 $2 $3" = "plugins check-updates --json" ]; then
  [ -f "$STATE/noise" ] && echo 'warning: [catalog] cache is 3 days old'
  cat "$STATE/updates.$P.json" 2>/dev/null || echo '[]'
  exit 0
fi
if [ "$1 $2 $3" = "config get computer_use.backend" ]; then cat "$STATE/backend.$P" 2>/dev/null; exit 0; fi
echo "unexpected call: $*"; exit 2
`;
// A setup.sh at $HOME/alans-way-agents (HOME is the data dir in envFor) that
// prints the given lines and records its arguments.
function addSetupScript(homeDir, lines, exitCode = 0) {
  const dir = path.join(homeDir, 'alans-way-agents');
  fs.mkdirSync(dir, { recursive: true });
  const log = path.join(dir, 'calls.log');
  fs.writeFileSync(path.join(dir, 'setup.sh'),
    `#!/bin/sh\necho "$@" >> "${log}"\n${lines.map((line) => `echo '${line}'`).join('\n')}\nexit ${exitCode}\n`, { mode: 0o755 });
  return () => fs.readFileSync(log, 'utf8');
}
function doctorFixture() {
  const { bin } = makeBin();
  const state = mktemp('vm-doctor-state-');
  fs.writeFileSync(path.join(bin, 'hermes'), DOCTOR_HERMES, { mode: 0o755 });
  const hermesLog = () => (fs.existsSync(path.join(state, 'hermes.log')) ? fs.readFileSync(path.join(state, 'hermes.log'), 'utf8').trim().split('\n') : []);
  return { bin, state, home: makeHermesHome(), hermesLog };
}

test('--doctor reports versions, plugin rows, the newest plugin tag and the setup audit without changing anything', async () => {
  const checkout = makeCheckout(remote);
  const before = git(checkout, 'rev-parse', 'HEAD');
  const { bin, state, home, hermesLog } = doctorFixture();
  addPlugin(home, 'default', 'alans-way', '0.6.0', {
    catalog: { name: 'alans-way', pin: 'bbb222', sha: 'bbb222' }, pinned: true, revision: 'bbb222', source: 'https://example.com/alans-way-agents' });
  addPlugin(home, 'default', 'alans-way-computer', '0.6.0');
  fs.writeFileSync(path.join(state, 'updates.default.json'), JSON.stringify([
    { name: 'alans-way', class: 'catalog', current: 'bbb222', latest: 'ccc333', update_available: true },
    { name: 'alans-way-computer', class: 'manual', current: null, latest: null, update_available: null }]));
  fs.writeFileSync(path.join(state, 'backend.default'), 'alans-way-computer\n');
  fs.writeFileSync(path.join(state, 'noise'), '');
  const port = await makeStatus({ version: '0.3.1', busy: false });
  const data = makeDataDir(port);
  const setupCalls = addSetupScript(data, ['  ok   plugin enabled', '  FAIL browser host not running', '  warn no primary route bound'], 1);
  const pluginRemote = git(makePluginClone(), 'remote', 'get-url', 'origin').trim();
  const res = await runScript(['--doctor'], envFor(checkout, data, bin, { ...pluginEnv(home, state), ALANS_WAY_VM_PLUGIN_REMOTE: pluginRemote }));
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(lastJson(res), {
    ok: true, version: '0.3.1', hostVersion: '0.3.1', pluginTag: 'v0.6.2', error: '',
    verify: { ran: true, fails: ['browser host not running'], warns: ['no primary route bound'] },
    profiles: [{
      profile: 'default', computerBackend: 'alans-way-computer',
      plugins: [
        { name: 'alans-way', version: '0.6.0', class: 'catalog', updateAvailable: true },
        { name: 'alans-way-computer', version: '0.6.0', class: 'manual', updateAvailable: null }],
      checked: true,
    }],
  });
  assert.equal(git(checkout, 'rev-parse', 'HEAD'), before, 'the checkout did not move');
  assert.deepEqual(hermesLog(), ['hermes -p default plugins check-updates --json', 'hermes -p default config get computer_use.backend']);
  assert.equal(setupCalls().trim(), `--verify --hermes-home ${home}`);
});

test('--doctor reports a profile the time budget does not reach instead of running it', async () => {
  const checkout = makeCheckout(remote);
  const { bin, state, home, hermesLog } = doctorFixture();
  addPlugin(home, 'default', 'alans-way', '0.6.0');
  const port = await makeStatus({ version: '0.3.1', busy: false });
  const data = makeDataDir(port);
  addSetupScript(data, ['  ok   plugin enabled']);
  const res = await runScript(['--doctor'], envFor(checkout, data, bin, {
    ...pluginEnv(home, state), ALANS_WAY_VM_DOCTOR_BUDGET: '0', ALANS_WAY_VM_PLUGIN_REMOTE: path.join(os.tmpdir(), 'no-such-remote') }));
  const result = lastJson(res);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(result.pluginTag, '', 'an unreachable remote gives no tag');
  assert.deepEqual(result.profiles, [{
    profile: 'default', computerBackend: '',
    plugins: [{ name: 'alans-way', version: '0.6.0', class: '', updateAvailable: null }],
    checked: false }]);
  assert.deepEqual(result.verify, { ran: false, reason: 'time' });
  assert.deepEqual(hermesLog(), [], 'hermes was never called');
  assert.equal(fs.existsSync(path.join(data, 'alans-way-agents', 'calls.log')), false, 'setup.sh was never run');
});

test('--doctor without setup.sh says so, and an unset backend printed as None counts as none', async () => {
  const checkout = makeCheckout(remote);
  const { bin, state, home } = doctorFixture();
  addProfile(home, 'alpha');
  addPlugin(home, 'alpha', 'alans-way', '0.6.0');
  fs.writeFileSync(path.join(state, 'backend.alpha'), 'None\n');
  const port = await makeStatus({ version: '0.3.1', busy: false });
  const res = await runScript(['--doctor'], envFor(checkout, makeDataDir(port), bin, {
    ...pluginEnv(home, state), ALANS_WAY_VM_PLUGIN_REMOTE: path.join(os.tmpdir(), 'no-such-remote') }));
  const result = lastJson(res);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(result.profiles.length, 1);
  assert.equal(result.profiles[0].profile, 'alpha');
  assert.equal(result.profiles[0].computerBackend, '');
  assert.equal(result.profiles[0].checked, true);
  assert.deepEqual(result.verify, { ran: false, reason: 'no-setup' });
});

test('--doctor runs the setup audit once per server, after every profile, and reports it at the top level', async () => {
  const checkout = makeCheckout(remote);
  const { bin, state, home, hermesLog } = doctorFixture();
  addPlugin(home, 'default', 'alans-way', '0.6.0');
  addProfile(home, 'work');
  addPlugin(home, 'work', 'alans-way', '0.6.1');
  const port = await makeStatus({ version: '0.3.1', busy: false });
  const data = makeDataDir(port);
  const setupCalls = addSetupScript(data, ['  FAIL work: plugin disabled'], 1);
  fs.writeFileSync(path.join(state, 'updates.work.json'), JSON.stringify([
    { name: 'alans-way', class: 'catalog', current: 'aaa111', latest: null, update_available: null }]));
  const res = await runScript(['--doctor'], envFor(checkout, data, bin, {
    ...pluginEnv(home, state), ALANS_WAY_VM_PLUGIN_REMOTE: path.join(os.tmpdir(), 'no-such-remote') }));
  const result = lastJson(res);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(setupCalls().trim().split('\n'), [`--verify --hermes-home ${home}`], 'one audit, no --profile');
  assert.deepEqual(result.profiles.map((p) => [p.profile, p.checked]), [['default', true], ['work', true]]);
  assert.deepEqual(result.verify, { ran: true, fails: ['work: plugin disabled'], warns: [] });
  assert.equal(result.profiles.some((p) => 'verify' in p), false);
  assert.deepEqual(result.profiles[1].plugins, [{ name: 'alans-way', version: '0.6.1', class: 'catalog', updateAvailable: null }],
    'a catalog row hermes could not check stays unknown');
  assert.deepEqual(hermesLog(), ['hermes -p default plugins check-updates --json', 'hermes -p default config get computer_use.backend',
    'hermes -p work plugins check-updates --json', 'hermes -p work config get computer_use.backend']);
});

for (const [label, lines, code, expected] of [
  ['exits 124 (timed out)', ['  ok   plugin enabled'], 124, { ran: false, reason: 'time' }],
  ['exits non-zero without a FAIL line', ['  ok   plugin enabled'], 3, { ran: true, fails: ['setup.sh --verify stopped early (exit 3)'], warns: [] }],
]) {
  test(`--doctor: a setup.sh --verify that ${label} is not reported as a clean pass`, async () => {
    const checkout = makeCheckout(remote);
    const { bin, state, home } = doctorFixture();
    addPlugin(home, 'default', 'alans-way', '0.6.0');
    const port = await makeStatus({ version: '0.3.1', busy: false });
    const data = makeDataDir(port);
    addSetupScript(data, lines, code);
    const res = await runScript(['--doctor'], envFor(checkout, data, bin, {
      ...pluginEnv(home, state), ALANS_WAY_VM_PLUGIN_REMOTE: path.join(os.tmpdir(), 'no-such-remote') }));
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(lastJson(res).verify, expected);
  });
}
