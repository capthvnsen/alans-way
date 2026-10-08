# Check setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A **Check setup** button and a **Copy report** button in the desktop app. Check setup lists every
setup problem on the user's computer, the connection and the server, each with a fix. Copy report produces a
redacted text report the user can send to Alex. The app also removes a stale connector copy at launch.

**Architecture:** The server is checked by a new read-only `--doctor` mode in the existing
`desktop/scripts/vm-update.sh`. The app pipes that script over SSH, the way it already runs updates, and gets
one JSON line back. A new pure module, `desktop/src/setup-check.cjs`, turns the local, connection and server
results into findings, and builds the redacted report. `main.cjs` gathers the inputs and exposes commands.
`renderer.js` shows the results in Settings and in the wizard's last step.

**Tech Stack:** Electron (main and renderer, plain JS, no framework), POSIX `sh` for the guest script,
`node:test` for tests. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-08-setup-check-design.md`

## Global Constraints

- No new npm dependencies. `setup-check.cjs` uses Node built-ins and `./mac-update.cjs` only.
- `vm-update.sh` stays POSIX `sh`. The test suite runs `sh -n` on it, so there must be no bash-isms.
- `--doctor` changes nothing on the server. It may call only `hermes plugins check-updates --json`,
  `hermes config get computer_use.backend`, `setup.sh --verify`, `git ls-remote` and the broker's loopback
  `/v1/status`.
- User-facing copy has no em dashes.
- No doctor run against a Windows server, and no connector cleanup on Windows.
- The report goes on the clipboard only when the user clicks. Nothing is sent anywhere.
- SSH uses the existing helpers and options (`sshRun`, `runGuest`). No new SSH flags.
- Commit messages follow this repo's style: one plain sentence, then a blank line and
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Run every command from `desktop/` unless a step says otherwise.

## Review Focus

1. Hermes prints a warning line before the `check-updates` JSON. The plugin rows should still parse. (Task 1, test 1)
2. On a Hermes where the key is unset, `config get computer_use.backend` prints `None`. That should count as
   the built-in backend, not as a backend named "None". (Task 1, test 3)
3. The installed plugin is newer than the newest release tag (a dev install: 0.7.1 against `v0.7.0`). It should
   show as up to date, not as behind. (Task 3)
4. A Telegram bot token inside a URL in `main-errors.log` (`/bot123456789:AA…/getUpdates`) should be removed
   from the report. (Task 4)
5. A connector copy whose `package.json` is corrupt or has no version should be kept, never deleted. (Task 3)

---

### Task 1: `vm-update.sh --doctor`

**Files:**
- Modify: `desktop/scripts/vm-update.sh` (header comment, argument parsing, help text, a new `doctor` function
  before `# ---- main`, and one dispatch line after the `--check` block)
- Test: `desktop/test/vm-update-script.test.cjs` (append at the end)

**Interfaces:**
- Consumes: the script's existing helpers `find_checkout`, `status_body`, `json_field`, `list_profiles`,
  `hermes_bin`, `run_hermes`, `plugin_version`, `plugin_meta`, `budget_left`, `node_bin`, `have`, `fail`.
- Produces: `sh vm-update.sh --doctor`, which prints one JSON line:
  `{"ok":true,"version":"<checkout>","hostVersion":"<broker or ''>","pluginTag":"<vX.Y.Z or ''>","error":"","profiles":[{"profile":"<name>","computerBackend":"<value or ''>","plugins":[{"name":"alans-way","version":"0.7.0","class":"catalog","updateAvailable":false}],"verify":{"ran":true,"fails":["…"],"warns":["…"]}}]}`.
  `verify` can also be `{"ran":false,"reason":"time"}` or `{"ran":false,"reason":"no-setup"}`. On failure it
  prints the existing `fail` JSON (`ok:false` plus `error`).
- Environment knobs, for tests: `ALANS_WAY_VM_PLUGIN_REMOTE` (default
  `https://github.com/capthvnsen/alans-way-agents`) and `ALANS_WAY_VM_DOCTOR_BUDGET` (default `100` seconds).

- [ ] **Step 0: Install dependencies once**

Run: `cd desktop && npm ci`
Expected: it finishes without errors. `node_modules/` is absent in a fresh worktree.

- [ ] **Step 1: Write the failing tests**

Append this to the end of `desktop/test/vm-update-script.test.cjs`:

```js
// A read-only hermes for --doctor. Per profile P:
//   $STATE/updates.P.json  what `plugins check-updates --json` prints ("[]" when absent)
//   $STATE/backend.P       what `config get computer_use.backend` prints
//   $STATE/noise           when present, a warning line comes before the JSON
// Every call is logged; any other call fails, so a mutating call shows up.
const DOCTOR_HERMES = `#!/bin/sh
STATE="$FAKE_HERMES_STATE"
P=default
if [ "\${1:-}" = "-p" ]; then P="$2"; shift 2; fi
printf 'hermes -p %s %s\\n' "$P" "$*" >> "$STATE/hermes.log"
if [ "$1 $2 $3" = "plugins check-updates --json" ]; then
  [ -f "$STATE/noise" ] && echo 'warning: catalog cache is 3 days old'
  cat "$STATE/updates.$P.json" 2>/dev/null || echo '[]'
  exit 0
fi
if [ "$1 $2 $3" = "config get computer_use.backend" ]; then cat "$STATE/backend.$P" 2>/dev/null; exit 0; fi
echo "unexpected call: $*"; exit 2
`;
// A setup.sh at $HOME/alans-way-agents (HOME is the data dir in envFor) that
// prints the given lines and records its arguments.
function addSetupScript(homeDir, lines) {
  const dir = path.join(homeDir, 'alans-way-agents');
  fs.mkdirSync(dir, { recursive: true });
  const log = path.join(dir, 'calls.log');
  fs.writeFileSync(path.join(dir, 'setup.sh'),
    `#!/bin/sh\necho "$@" >> "${log}"\n${lines.map((line) => `echo '${line}'`).join('\n')}\n`, { mode: 0o755 });
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
  const setupCalls = addSetupScript(data, ['  ok   plugin enabled', '  FAIL browser host not running', '  warn no primary route bound']);
  const pluginRemote = git(makePluginClone(), 'remote', 'get-url', 'origin').trim();
  const res = await runScript(['--doctor'], envFor(checkout, data, bin, { ...pluginEnv(home, state), ALANS_WAY_VM_PLUGIN_REMOTE: pluginRemote }));
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(lastJson(res), {
    ok: true, version: '0.3.1', hostVersion: '0.3.1', pluginTag: 'v0.6.2', error: '',
    profiles: [{
      profile: 'default', computerBackend: 'alans-way-computer',
      plugins: [
        { name: 'alans-way', version: '0.6.0', class: 'catalog', updateAvailable: true },
        { name: 'alans-way-computer', version: '0.6.0', class: 'manual', updateAvailable: false }],
      verify: { ran: true, fails: ['browser host not running'], warns: ['no primary route bound'] },
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
  const res = await runScript(['--doctor'], envFor(checkout, makeDataDir(port), bin, {
    ...pluginEnv(home, state), ALANS_WAY_VM_DOCTOR_BUDGET: '0', ALANS_WAY_VM_PLUGIN_REMOTE: path.join(os.tmpdir(), 'no-such-remote') }));
  const result = lastJson(res);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(result.pluginTag, '', 'an unreachable remote gives no tag');
  assert.deepEqual(result.profiles, [{
    profile: 'default', computerBackend: '',
    plugins: [{ name: 'alans-way', version: '0.6.0', class: '', updateAvailable: false }],
    verify: { ran: false, reason: 'time' } }]);
  assert.deepEqual(hermesLog(), [], 'hermes was never called');
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
  assert.deepEqual(result.profiles[0].verify, { ran: false, reason: 'no-setup' });
});
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `node --test --test-name-pattern='--doctor' test/vm-update-script.test.cjs`
Expected: all three FAIL. The script treats `--doctor` as a tag and prints
`refusing non-release tag '--doctor'`.

- [ ] **Step 3: Implement `--doctor`**

In `desktop/scripts/vm-update.sh`:

1. In the header comment, under the existing `sh vm-update.sh --check` line, add:

```sh
#   sh vm-update.sh --doctor  read-only: one JSON health report for Check setup
```

2. Replace `TAG="" CHECK=0` with `TAG="" CHECK=0 DOCTOR=0`, and add a case right after `--check) CHECK=1;;`:

```sh
  --doctor) DOCTOR=1;;
```

3. In the `--help` heredoc, add this line after the `--check` line:

```
  sh vm-update.sh --doctor  read-only: a health report for the app's Check setup
```

4. Directly above the `# ---------------------------------------------------------------- main` line, add:

```sh
# --- doctor -------------------------------------------------------------------
# Read-only health report for the app's Check setup. Nothing here changes the
# machine: hermes only gets `plugins check-updates --json` and `config get`,
# setup.sh only runs --verify, git only lists remote tags. The shell gathers
# raw pieces into a temp dir and node turns them into the one JSON line.

PLUGIN_REMOTE="${ALANS_WAY_VM_PLUGIN_REMOTE:-https://github.com/capthvnsen/alans-way-agents}"

bounded() { _s="$1"; shift; if have timeout; then timeout "$_s" "$@"; else "$@"; fi; }

# The setup.sh a profile was installed with: ~/alans-way-agents first (where
# the setup prompt clones it), else the clone its file:// plugin source names.
doctor_setup_script() {
  if [ -f "$HOME/alans-way-agents/setup.sh" ]; then printf '%s' "$HOME/alans-way-agents/setup.sh"; return 0; fi
  _ds="$(plugin_meta "$1/plugins" alans-way | sed -n 's|.*"source"[[:space:]]*:[[:space:]]*"file://\([^"#]*\).*|\1|p' | head -1)"
  [ -n "$_ds" ] && [ -f "$_ds/setup.sh" ] && printf '%s' "$_ds/setup.sh"
}

DOCTOR_JS='
const fs = require("fs"), path = require("path");
const [work, version] = process.argv.slice(1);
const has = (f) => fs.existsSync(path.join(work, f));
const read = (f) => { try { return fs.readFileSync(path.join(work, f), "utf8").trim(); } catch { return ""; } };
const array = (text) => {
  const a = text.indexOf("["), b = text.lastIndexOf("]");
  try { return a < 0 || b < a ? [] : JSON.parse(text.slice(a, b + 1)); } catch { return []; }
};
const pick = (lines, tag) => lines.map((l) => l.match(new RegExp("^\\s*" + tag + " (.*)$"))).filter(Boolean).map((m) => m[1].trim());
const dirs = fs.readdirSync(work).filter((d) => /^p\d+$/.test(d)).sort((a, b) => a.slice(1) - b.slice(1));
const profiles = dirs.map((d) => {
  const updates = array(read(`${d}/updates.json`));
  const plugins = ["alans-way", "alans-way-computer"].filter((n) => has(`${d}/version.${n}`)).map((name) => {
    const row = updates.find((u) => u && u.name === name) || {};
    return { name, version: read(`${d}/version.${name}`), class: String(row.class || ""), updateAvailable: row.update_available === true };
  });
  const backend = read(`${d}/backend`);
  const lines = read(`${d}/verify`).split("\n");
  const verify = has(`${d}/out-of-time`) ? { ran: false, reason: "time" }
    : has(`${d}/verify`) ? { ran: true, fails: pick(lines, "FAIL"), warns: pick(lines, "warn") }
    : { ran: false, reason: "no-setup" };
  return { profile: read(`${d}/name`), computerBackend: /^[a-z0-9_-]+$/i.test(backend) && !/^(none|null)$/i.test(backend) ? backend : "", plugins, verify };
});
process.stdout.write(JSON.stringify({ ok: true, version, hostVersion: read("hostVersion"), pluginTag: read("pluginTag"), error: "", profiles }) + "\n");
'

doctor() {
  VM_BUDGET="${ALANS_WAY_VM_DOCTOR_BUDGET:-100}"
  node_bin || fail "node is not installed on this server"
  WORK="$(mktemp -d)" || fail "could not create a temp dir"
  trap 'rm -rf "$WORK"' EXIT
  BODY="$(status_body)" || BODY=""
  printf '%s' "$BODY" | json_field version > "$WORK/hostVersion"
  bounded 15 "$GIT" ls-remote --tags --refs "$PLUGIN_REMOTE" 2>/dev/null \
    | sed -n 's|.*refs/tags/\(v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)$|\1|p' \
    | sort -t. -k1.2n -k2n -k3n | tail -1 > "$WORK/pluginTag"
  if hermes_bin; then
    HHOME="${HERMES_HOME:-$HOME/.hermes}"
    _i=0
    while read -r _pname _phome; do
      [ -n "$_pname" ] || continue
      [ -d "$_phome/plugins/alans-way" ] || [ -d "$_phome/plugins/alans-way-computer" ] || continue
      _i=$((_i + 1)); _d="$WORK/p$_i"; mkdir -p "$_d"
      printf '%s' "$_pname" > "$_d/name"
      for _name in alans-way alans-way-computer; do
        [ -d "$_phome/plugins/$_name" ] && plugin_version "$_phome/plugins/$_name" > "$_d/version.$_name"
      done
      if [ "$(budget_left)" -le 20 ]; then touch "$_d/out-of-time"; continue; fi
      if [ "$_pname" = default ]; then set --; else set -- -p "$_pname"; fi
      run_hermes 30 "$@" plugins check-updates --json > "$_d/updates.json"
      run_hermes 15 "$@" config get computer_use.backend | tail -1 > "$_d/backend"
      _setup="$(doctor_setup_script "$_phome")"
      [ -n "$_setup" ] || continue
      if [ "$(budget_left)" -le 10 ]; then touch "$_d/out-of-time"; continue; fi
      if [ "$_pname" = default ]; then set -- --verify --hermes-home "$HHOME"; else set -- --verify --hermes-home "$HHOME" --profile "$_pname"; fi
      bounded "$(( $(budget_left) - 5 ))" sh "$_setup" "$@" > "$_d/verify" 2>&1 </dev/null
    done <<EOF
$(list_profiles)
EOF
  fi
  "$NODE_BIN" -e "$DOCTOR_JS" "$WORK" "$VERSION"
}
```

5. Right after the `--check` block (the `if [ "$CHECK" = 1 ]; then … exit 0; fi` that prints `hostVersion`),
   add:

```sh
if [ "$DOCTOR" = 1 ]; then doctor; exit 0; fi
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `node --test test/vm-update-script.test.cjs`
Expected: PASS for the three new tests and for every existing test, including
`the shipped scripts parse cleanly`.

- [ ] **Step 5: Commit**

```bash
git add scripts/vm-update.sh test/vm-update-script.test.cjs
git commit -m "Add a read-only --doctor mode to vm-update.sh that reports versions, plugin updates and the setup audit as one JSON line.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `doctorVm` in `vm-update.cjs`

**Files:**
- Modify: `desktop/src/vm-update.cjs` (the `remoteFor` and `runGuest` signatures, a new `doctorVm`, the return
  value of `createVmUpdater`, `module.exports`)
- Test: `desktop/test/vm-update.test.cjs`

**Interfaces:**
- Consumes: `sh vm-update.sh --doctor` from Task 1.
- Produces: `updater.doctorVm(vm)` returns `Promise<object>` and never throws. It resolves to the parsed doctor
  JSON on success; to `{ ok: false, error: 'windows' }` for a Windows server, without running SSH; otherwise to
  `{ ok: false, error: string }`. Also exports `DOCTOR_TIMEOUT_MS = 120000`.

- [ ] **Step 1: Write the failing tests**

In `desktop/test/vm-update.test.cjs`, add `DOCTOR_TIMEOUT_MS` to the destructured `require` at the top
(after `CHECK_TIMEOUT_MS`), then append:

```js
test('doctorVm pipes the bundled script with --doctor under the doctor cap and returns its report', async () => {
  const report = { ok: true, version: '0.4.0', hostVersion: '0.4.0', pluginTag: 'v0.7.0', error: '', profiles: [] };
  const { calls, run } = fakeRun({ code: 0, out: `${JSON.stringify(report)}\n`, err: '' });
  const result = await createVmUpdater({ run, readScript }).doctorVm(vm());
  assert.deepEqual(result, report);
  assert.equal(calls[0].args.at(-1), 'sh -s -- --doctor');
  assert.equal(calls[0].opts.timeoutMs, DOCTOR_TIMEOUT_MS);
  assert.equal(calls[0].opts.input, SCRIPTS['vm-update.sh']);
});

test('doctorVm never runs against a Windows server', async () => {
  const { calls, run } = fakeRun({ code: 0, out: '', err: '' });
  const result = await createVmUpdater({ run, readScript }).doctorVm(vm({ scriptPath: 'C:/Users/me/app/vps-browser-host.cjs' }));
  assert.deepEqual(result, { ok: false, error: 'windows' });
  assert.equal(calls.length, 0);
});

test('doctorVm turns an unreachable server into an error result', async () => {
  const { run } = fakeRun({ code: 255, out: '', err: 'ssh: connect to host vm.example port 22: Connection refused' });
  const result = await createVmUpdater({ run, readScript }).doctorVm(vm());
  assert.equal(result.ok, false);
  assert.match(result.error, /Could not reach the VM over SSH/);
});
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `node --test --test-name-pattern='doctorVm' test/vm-update.test.cjs`
Expected: FAIL with `doctorVm is not a function`.

- [ ] **Step 3: Implement**

In `desktop/src/vm-update.cjs`:

1. Below `const CHECK_TIMEOUT_MS = 30000;` add:

```js
const DOCTOR_TIMEOUT_MS = 120000;
```

2. Change `function remoteFor(kind, { tag, check }) {` to `function remoteFor(kind, { tag, check, doctor }) {`,
   and add this as the first line after the closing brace of the `if (kind === 'windows') { … }` block:

```js
    if (doctor) return { script: SCRIPTS.posix, remote: 'sh -s -- --doctor' };
```

3. In `runGuest`:
   - Change the signature to
     `async function runGuest(vm, { tag, check = false, doctor = false, timeoutMs = VM_TIMEOUT_MS, onProgress } = {}) {`.
   - Change the tag guard to `if (!check && !doctor && !TAG_RE.test(String(tag)))`.
   - Directly after `const kind = await guestKind(vm);` add:
     `if (doctor && kind === 'windows') return { ok: false, error: 'windows' };`
   - Change `remoteFor(kind, { tag, check })` to `remoteFor(kind, { tag, check, doctor })`.

4. After the `checkVm` function add:

```js
  // Read-only health report for Check setup. Never throws: a failure is a result.
  async function doctorVm(vm) {
    try {
      const result = await runGuest(vm, { doctor: true, timeoutMs: DOCTOR_TIMEOUT_MS });
      return result.ok === true ? result : { ok: false, error: String(result.error || 'The server check failed.') };
    } catch (error) {
      log('vm-doctor', error);
      return { ok: false, error: tail(error.message) || 'The server check failed.' };
    }
  }
```

5. Change `return { updateVm, checkVm, updateAll, updateAppAndVms };` to
   `return { updateVm, checkVm, doctorVm, updateAll, updateAppAndVms };`, and add `DOCTOR_TIMEOUT_MS` to
   `module.exports` after `CHECK_TIMEOUT_MS`.

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `node --test test/vm-update.test.cjs`
Expected: PASS for every test, old and new.

- [ ] **Step 5: Commit**

```bash
git add src/vm-update.cjs test/vm-update.test.cjs
git commit -m "Let the VM updater run the read-only doctor report, skipping Windows servers.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: findings and the stale connector check (`setup-check.cjs`)

**Files:**
- Create: `desktop/src/setup-check.cjs`
- Create: `desktop/test/setup-check.test.cjs`
- Modify: `desktop/package.json` (add `node --check src/setup-check.cjs &&` to the `check` script, right before
  `node --test test/*.test.cjs`)

**Interfaces:**
- Consumes: `isNewer(latest, current)` from `./mac-update.cjs`. It returns `true` only when both are `x.y.z`
  and `latest` is newer.
- Produces:
  - `staleConnectorCopy(userDataDir: string, appVersion: string) => string | null`: the connector folder's
    path when it is older than the app.
  - `buildFindings({ appVersion, platform, local, connection, server }) => Finding[]`, where
    `Finding = { group: 'computer'|'connection'|'server', level: 'ok'|'warn'|'fail', title: string, fix: string, action: string|null }`.
    `action` is one of `'move-to-applications'`, `'open-accessibility'`, `'open-screen'`,
    `'remove-old-connector'`, `'update-server'`, or `null`.
  - The input shapes:
    - `local = { telegram: string, inApplications: boolean|null, permissions: { accessibility: boolean, screen: string } | null, staleConnector: string|null }`
    - `connection = { addresses: { server: string, computer: string }, reach: { ok, detail } | null, back: { ok, detail } | null }`
    - `server` is the doctor result from Task 2, or `null` when it didn't run.

- [ ] **Step 1: Write the failing tests**

Create `desktop/test/setup-check.test.cjs`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { staleConnectorCopy, buildFindings } = require('../src/setup-check.cjs');

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

const healthyServer = (over = {}) => ({
  ok: true, version: '0.4.0', hostVersion: '0.4.0', pluginTag: 'v0.7.0', error: '',
  profiles: [{ profile: 'default', computerBackend: 'alans-way-computer',
    plugins: [{ name: 'alans-way', version: '0.7.0', class: 'catalog', updateAvailable: false }],
    verify: { ran: true, fails: [], warns: [] } }],
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
});

test('the built-in computer-use backend, the setup audit and the time budget each show up', () => {
  const findings = buildFindings(healthy({ server: healthyServer({ profiles: [{ profile: 'default', computerBackend: '', plugins: [],
    verify: { ran: true, fails: ['browser host not running'], warns: ['no primary route bound'] } }] }) }));
  assert.equal(byTitle(findings, /built-in/).level, 'warn');
  assert.equal(byTitle(findings, /browser host not running/).level, 'fail');
  assert.equal(byTitle(findings, /no primary route bound/).level, 'warn');
  const late = buildFindings(healthy({ server: healthyServer({ profiles: [{ ...healthyServer().profiles[0], verify: { ran: false, reason: 'time' } }] }) }));
  assert.match(byTitle(late, /audit/).title, /out of time/);
});

test('several profiles prefix their rows, and a Windows server says its checks are not available', () => {
  const two = healthyServer({ profiles: [healthyServer().profiles[0], { ...healthyServer().profiles[0], profile: 'work' }] });
  const findings = buildFindings(healthy({ server: two }));
  assert.ok(findings.some((f) => f.title.startsWith('work: ')));
  const windows = buildFindings(healthy({ server: { ok: false, error: 'windows' } })).filter((f) => f.group === 'server');
  assert.deepEqual(windows.map((f) => f.level), ['warn']);
  assert.match(windows[0].title, /Windows servers/);
});

test('a server without the app installed points at the setup prompt', () => {
  const findings = buildFindings(healthy({ server: { ok: false, error: 'no browser host checkout found (expected …)' } }));
  assert.match(findings.find((f) => f.group === 'server').fix, /setup prompt/);
});
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `node --test test/setup-check.test.cjs`
Expected: FAIL with `Cannot find module '../src/setup-check.cjs'`.

- [ ] **Step 3: Implement**

Create `desktop/src/setup-check.cjs`:

```js
'use strict';

// Check setup: turns what the app can see locally, over the connection, and
// from the server's --doctor report into a list of findings with fixes.
const fs = require('node:fs');
const path = require('node:path');
const { isNewer } = require('./mac-update.cjs');

const UPDATE = 'Update the server to install it.';
const SETUP_PROMPT = 'Paste the setup prompt to your bot (Settings → Agent setup → Copy setup prompt).';
const AUDIT_FIX = 'Ask your bot to run setup.sh --verify and fix what it reports.';

// setup.sh copies a connector into <userData>/connector and the router runs it
// ahead of the app's own, so once the app updates past it the copy is stale.
// A copy we can't read a version from is left alone.
function staleConnectorCopy(userDataDir, appVersion) {
  const dir = path.join(userDataDir, 'connector');
  let version;
  try { version = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version; } catch { return null; }
  return isNewer(appVersion, version) ? dir : null;
}

const row = (group, level, title, fix = '', action = null) => ({ group, level, title, fix, action });

function computerRows({ platform, local }) {
  const rows = [local.telegram === 'connected'
    ? row('computer', 'ok', 'Signed in to Telegram')
    : row('computer', 'fail', 'Not signed in to Telegram', 'Scan the QR code on the left with your phone: Telegram → Settings → Devices → Link Desktop Device.')];
  if (platform === 'darwin') {
    if (local.inApplications === true) rows.push(row('computer', 'ok', 'Open Alan is in Applications'));
    if (local.inApplications === false) rows.push(row('computer', 'fail', 'Open Alan is not in Applications', 'Move it there so your agent can find it.', 'move-to-applications'));
    if (local.permissions) {
      rows.push(local.permissions.accessibility === true
        ? row('computer', 'ok', 'Accessibility is on')
        : row('computer', 'warn', 'Accessibility is off', 'Your agent can use browser tabs, but it can’t click or type in other apps until this is on.', 'open-accessibility'));
      rows.push(local.permissions.screen === 'granted'
        ? row('computer', 'ok', 'Screen Recording is on')
        : row('computer', 'warn', 'Screen Recording is off', 'Your agent can’t see other apps’ windows until this is on.', 'open-screen'));
    }
  }
  rows.push(local.staleConnector
    ? row('computer', 'warn', 'An old connector copy is in use', 'Remove it so your agent uses the one inside this app.', 'remove-old-connector')
    : row('computer', 'ok', 'The connector matches this app'));
  return rows;
}

function connectionRows({ connection }) {
  const { addresses, reach, back } = connection;
  const rows = [];
  if (!addresses.server) rows.push(row('connection', 'fail', 'No server address saved', 'Enter your server’s SSH address and save it.'));
  if (!addresses.computer) rows.push(row('connection', 'fail', 'This computer’s address isn’t saved', 'Enter the address your server uses to reach this computer and save it.'));
  if (reach) rows.push(reach.ok
    ? row('connection', 'ok', 'This computer reaches the server')
    : row('connection', 'fail', 'This computer can’t reach the server', `Check the address and that this computer’s key is on the server. ${reach.detail}`.trim()));
  if (back) rows.push(back.ok
    ? row('connection', 'ok', 'The server reaches this computer')
    : row('connection', 'fail', 'The server can’t reach this computer', back.detail));
  return rows;
}

function pluginRow(group, prefix, plugin, pluginTag) {
  const behind = plugin.class === 'catalog' ? plugin.updateAvailable : pluginTag ? isNewer(pluginTag, plugin.version) : null;
  if (behind === null) return row(group, 'warn', `${prefix}Couldn’t check ${plugin.name} for updates`, 'The server couldn’t reach GitHub. Check again later.');
  return behind
    ? row(group, 'warn', `${prefix}${plugin.name} ${plugin.version} has an update`, UPDATE, 'update-server')
    : row(group, 'ok', `${prefix}${plugin.name} ${plugin.version} is the latest published version`);
}

function serverRows({ appVersion, server }) {
  const s = 'server';
  if (!server) return [row(s, 'fail', 'Server checks skipped', 'Fix the connection above, then check again.')];
  if (server.ok !== true) {
    if (server.error === 'windows') return [row(s, 'warn', 'Server checks aren’t available for Windows servers yet')];
    const missing = /no browser host checkout/.test(server.error || '');
    return [row(s, 'fail', missing ? 'Open Alan isn’t installed on the server' : 'The server check failed', missing ? SETUP_PROMPT : server.error || '')];
  }
  const rows = [];
  if (isNewer(appVersion, server.version)) rows.push(row(s, 'fail', 'The server is on an older version', `Server ${server.version}, this app ${appVersion}.`, 'update-server'));
  else if (isNewer(server.version, appVersion)) rows.push(row(s, 'warn', 'The server is newer than this app', 'Update this app.'));
  else rows.push(row(s, 'ok', `Server tools are on ${server.version}`));
  if (!server.hostVersion) rows.push(row(s, 'fail', 'The server’s browser is not running', 'Update the server to restart it.', 'update-server'));
  else if (server.hostVersion !== server.version) rows.push(row(s, 'warn', 'The server’s browser is running an older version', 'Update the server to restart it.', 'update-server'));
  else rows.push(row(s, 'ok', 'The server’s browser is running'));
  const profiles = server.profiles || [];
  if (!profiles.length) rows.push(row(s, 'warn', 'No Hermes profile on the server has the alans-way plugin', SETUP_PROMPT));
  for (const p of profiles) {
    const prefix = profiles.length > 1 ? `${p.profile}: ` : '';
    for (const plugin of p.plugins || []) rows.push(pluginRow(s, prefix, plugin, server.pluginTag));
    rows.push(p.computerBackend === 'alans-way-computer'
      ? row(s, 'ok', `${prefix}Computer use goes through Alan’s Way`)
      : row(s, 'warn', `${prefix}Computer use runs on Hermes’s built-in backend`, 'Update Hermes to a build with the computer-use provider API, then paste the setup prompt to your bot again.'));
    const v = p.verify || {};
    if (!v.ran) rows.push(v.reason === 'time'
      ? row(s, 'warn', `${prefix}Setup audit not run (out of time)`, 'Check again to audit the rest.')
      : row(s, 'warn', `${prefix}Setup audit not available`, `The setup files are missing on the server. ${SETUP_PROMPT}`));
    else if (!(v.fails || []).length && !(v.warns || []).length) rows.push(row(s, 'ok', `${prefix}Setup audit passed`));
    for (const text of v.fails || []) rows.push(row(s, 'fail', `${prefix}${text}`, AUDIT_FIX));
    for (const text of v.warns || []) rows.push(row(s, 'warn', `${prefix}${text}`, AUDIT_FIX));
  }
  return rows;
}

function buildFindings(input) {
  return [...computerRows(input), ...connectionRows(input), ...serverRows(input)];
}

module.exports = { staleConnectorCopy, buildFindings };
```

Then in `desktop/package.json`, in the `check` script, replace `&& node --test test/*.test.cjs` with
`&& node --check src/setup-check.cjs && node --test test/*.test.cjs`.

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `node --test test/setup-check.test.cjs`
Expected: PASS, every test.

- [ ] **Step 5: Commit**

```bash
git add src/setup-check.cjs test/setup-check.test.cjs package.json
git commit -m "Turn local, connection and server results into Check setup findings, and spot a connector copy older than the app.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: the redacted report (`setup-check.cjs`)

**Files:**
- Modify: `desktop/src/setup-check.cjs` (add `redactReport` and `buildReport`, and extend `module.exports`)
- Test: `desktop/test/setup-check.test.cjs` (append)

**Interfaces:**
- Consumes: the `Finding` shape from Task 3, and the doctor result from Task 2.
- Produces:
  - `redactReport(text: string) => string`.
  - `buildReport({ now?: Date, app: { version, platform, arch, osVersion, signed }, serverAddress, computerAddress, findings?: Finding[], checkedAt?: string, server?: object, errorLog?: string }) => string`.
    It is already redacted.

- [ ] **Step 1: Write the failing tests**

Append to `desktop/test/setup-check.test.cjs`:

```js
const { redactReport, buildReport } = require('../src/setup-check.cjs');

test('redactReport removes each secret shape and keeps addresses, versions and hashes', () => {
  const token = '123456789:AAEhBP0av28XaVDWSnoOUmUpUb2vzt4e9pc';
  const text = [
    `GET https://api.telegram.org/bot${token}/getUpdates failed`,
    `TELEGRAM_BOT_TOKEN=${token}`,
    '{"url":"http://127.0.0.1:9464","token":"e3b0c44298fc1c149afb"}',
    'Authorization: Bearer abc.def.ghi',
    'curl -H "Bearer zzz-123"',
    'OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwx',
    '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----',
    'server root@100.64.0.5, app 0.4.0, plugin ce51733b66291e69f616db48ae8799c0de50db43',
  ].join('\n');
  const out = redactReport(text);
  for (const secret of [token, 'e3b0c44298fc1c149afb', 'abc.def.ghi', 'zzz-123', 'sk-proj-abcdefghijklmnopqrstuvwx', 'b3BlbnNzaC1rZXk'])
    assert.equal(out.includes(secret), false, `${secret} leaked`);
  assert.match(out, /root@100\.64\.0\.5/);
  assert.match(out, /app 0\.4\.0/);
  assert.match(out, /ce51733b66291e69f616db48ae8799c0de50db43/);
});

const appInfo = { version: '0.4.0', platform: 'darwin', arch: 'arm64', osVersion: '15.6', signed: true };

test('buildReport lists the setup, the last check and the newest log lines, redacted', () => {
  const log = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n') + '\nbot123456789:AAEhBP0av28XaVDWSnoOUmUpUb2vzt4e9pc oops';
  const findings = [
    { group: 'computer', level: 'ok', title: 'Signed in to Telegram', fix: '', action: null },
    { group: 'server', level: 'fail', title: 'The server is on an older version', fix: 'Server 0.3.2, this app 0.4.0.', action: 'update-server' }];
  const report = buildReport({ now: new Date('2026-10-08T16:00:00Z'), app: appInfo, serverAddress: 'root@100.64.0.5', computerAddress: 'me@100.64.0.6',
    findings, checkedAt: '2026-10-08T15:59:00Z', server: { ok: true, version: '0.3.2' }, errorLog: log });
  assert.match(report, /^Open Alan report, 2026-10-08T16:00:00\.000Z$/m);
  assert.match(report, /App 0\.4\.0 on darwin arm64 \(15\.6\), signed build/);
  assert.match(report, /Server address: root@100\.64\.0\.5/);
  assert.match(report, /✓ This computer: Signed in to Telegram$/m);
  assert.match(report, /✗ Server: The server is on an older version \(Server 0\.3\.2, this app 0\.4\.0\.\)/);
  assert.match(report, /"version":"0\.3\.2"/);
  assert.doesNotMatch(report, /line 11$/m, 'only the last 50 log lines');
  assert.match(report, /line 12$/m);
  assert.doesNotMatch(report, /AAEhBP0av28XaVDWSnoOUmUpUb2vzt4e9pc/);
});

test('buildReport says when no check ran and when there are no errors', () => {
  const report = buildReport({ app: { ...appInfo, signed: false }, serverAddress: '', computerAddress: '', errorLog: '' });
  assert.match(report, /unsigned build/);
  assert.match(report, /Server address: not saved/);
  assert.match(report, /Check setup not run yet\./);
  assert.match(report, /Recent app errors:\nnone/);
});
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `node --test test/setup-check.test.cjs`
Expected: the three new tests FAIL with `redactReport is not a function`.

- [ ] **Step 3: Implement**

In `desktop/src/setup-check.cjs`, add above `module.exports`:

```js
// Secrets that can end up in logs or doctor output. SSH addresses, usernames
// and versions stay: a report without them can't be acted on.
const SECRETS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[private key removed]'],
  [/(?<!\d)\d{6,12}:[A-Za-z0-9_-]{30,}/g, '[bot token removed]'],
  [/("(?:token|apiKey|api_key|secret|password)"\s*:\s*")[^"]*(")/gi, '$1[removed]$2'],
  [/(Authorization:\s*)\S+(\s+\S+)?/gi, '$1[removed]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [removed]'],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '[api key removed]'],
];
function redactReport(text) {
  return SECRETS.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), String(text));
}

const MARKS = { ok: '✓', warn: '!', fail: '✗' };
const GROUPS = { computer: 'This computer', connection: 'Connection', server: 'Server' };

// The plain-text report a user pastes to support. Built only on request.
function buildReport({ now = new Date(), app, serverAddress, computerAddress, findings, checkedAt, server, errorLog }) {
  const lines = [
    `Open Alan report, ${now.toISOString()}`,
    `App ${app.version} on ${app.platform} ${app.arch} (${app.osVersion}), ${app.signed ? 'signed' : 'unsigned'} build`,
    `Server address: ${serverAddress || 'not saved'}`,
    `This computer’s address: ${computerAddress || 'not saved'}`,
    '',
  ];
  if (findings?.length) {
    lines.push(`Check setup, ${checkedAt}:`);
    for (const f of findings) lines.push(`${MARKS[f.level]} ${GROUPS[f.group]}: ${f.title}${f.level !== 'ok' && f.fix ? ` (${f.fix})` : ''}`);
  } else lines.push('Check setup not run yet.');
  if (server) lines.push('', 'Server report:', JSON.stringify(server));
  const log = String(errorLog || '').trimEnd().split('\n').slice(-50).join('\n');
  lines.push('', 'Recent app errors:', log || 'none');
  return redactReport(lines.join('\n'));
}
```

Change `module.exports = { staleConnectorCopy, buildFindings };` to
`module.exports = { staleConnectorCopy, buildFindings, redactReport, buildReport };`.

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `node --test test/setup-check.test.cjs`
Expected: PASS, every test.

- [ ] **Step 5: Commit**

```bash
git add src/setup-check.cjs test/setup-check.test.cjs
git commit -m "Build a redacted plain-text setup report that users can paste to support.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: wire it into the main process

**Files:**
- Modify: `desktop/src/main.cjs`

**Interfaces:**
- Consumes: `staleConnectorCopy`, `buildFindings` and `buildReport` (Tasks 3 and 4); `vmUpdater.doctorVm`
  (Task 2); and the existing `sshRun`, `testAgentPath`, `isSshTarget`, `vmTargets`, `telegramStatus`,
  `macUpdate.isDeveloperIdSigned`, `logError`, `clipboard`, `systemPreferences`.
- Produces renderer commands:
  - `'setup-check'` returns a `Finding[]`.
  - `'remove-old-connector'`, `'copy-report'` and `'open-support'` return the normal state.
  - `'vm-update-retry'` with `{ force: true }` updates every saved server, even when its recorded version
    already matches.
  - Every failed command is now written to `main-errors.log`.

- [ ] **Step 1: Add the module and the last-check state**

Near the other local requires (next to `const macUpdate = require('./mac-update.cjs');`) add:

```js
const setupCheck = require('./setup-check.cjs');
```

Below `let vmRetrying = false;` add:

```js
let lastSetupCheck = null;
```

- [ ] **Step 2: Remove a stale connector copy at launch**

In `app.whenReady().then(async () => {`, directly after `fs.mkdirSync(app.getPath('userData'), { recursive: true });`, add:

```js
    // A connector copy setup.sh left behind runs ahead of the app's own and
    // nothing else updates it; once the app is newer, drop it.
    if (process.platform !== 'win32') {
      const stale = setupCheck.staleConnectorCopy(app.getPath('userData'), app.getVersion());
      if (stale) try { fs.rmSync(stale, { recursive: true, force: true }); } catch (error) { logError('stale-connector', error); }
    }
```

- [ ] **Step 3: Add `runSetupCheck`**

Directly after the `testAgentPath` function (it ends with `});\n}` before the `cloudConnectRun` comment), add:

```js
// Check setup: local state, both SSH directions, then the server's read-only
// doctor report. Each part is independent; a failure becomes a finding.
async function runSetupCheck() {
  const serverHost = (prefs.vpsBrowser?.sshHost || '').trim();
  const computerHost = (prefs.macSshHost || '').trim();
  const mac = process.platform === 'darwin';
  const local = {
    telegram: telegramStatus,
    inApplications: mac && app.isPackaged ? app.isInApplicationsFolder() : null,
    permissions: mac ? { accessibility: systemPreferences.isTrustedAccessibilityClient(false), screen: systemPreferences.getMediaAccessStatus('screen') } : null,
    staleConnector: process.platform === 'win32' ? null : setupCheck.staleConnectorCopy(app.getPath('userData'), app.getVersion()),
  };
  const connection = { addresses: { server: serverHost, computer: computerHost }, reach: null, back: null };
  let server = null;
  if (serverHost && !isSshTarget(serverHost)) connection.reach = { ok: false, detail: 'The saved address is invalid. Re-enter it as user@host or host.' };
  else if (serverHost) {
    const probe = await sshRun(serverHost, 'echo CHECK_OK');
    connection.reach = probe.code === 0 && probe.out.includes('CHECK_OK')
      ? { ok: true, detail: '' }
      : { ok: false, detail: (probe.err || probe.out).trim().split('\n').pop() || `ssh exited ${probe.code}` };
    if (connection.reach.ok) {
      const [back, report] = await Promise.all([
        computerHost ? testAgentPath().catch((error) => ({ ok: false, detail: error.message })) : null,
        vmUpdater.doctorVm(vmTargets(prefs)[0]),
      ]);
      connection.back = back;
      server = report;
    }
  }
  const findings = setupCheck.buildFindings({ appVersion: app.getVersion(), platform: process.platform, local, connection, server });
  lastSetupCheck = { at: new Date().toISOString(), findings, server };
  return findings;
}
```

- [ ] **Step 4: Add the commands**

In the `workspace:command` switch, directly after `case 'test-agent-path': return testAgentPath();`, add:

```js
      case 'setup-check': return runSetupCheck();
      case 'remove-old-connector': {
        const stale = setupCheck.staleConnectorCopy(app.getPath('userData'), app.getVersion());
        if (stale) fs.rmSync(stale, { recursive: true, force: true });
        break;
      }
      case 'copy-report': {
        let errorLog = '';
        try { errorLog = fs.readFileSync(path.join(app.getPath('userData'), 'main-errors.log'), 'utf8'); } catch {}
        clipboard.writeText(setupCheck.buildReport({
          app: { version: app.getVersion(), platform: process.platform, arch: process.arch, osVersion: process.getSystemVersion(),
            signed: process.platform === 'darwin' && macUpdate.isDeveloperIdSigned(path.resolve(process.execPath, '../../..')) },
          serverAddress: prefs.vpsBrowser?.sshHost || '', computerAddress: prefs.macSshHost || '',
          findings: lastSetupCheck?.findings, checkedAt: lastSetupCheck?.at, server: lastSetupCheck?.server, errorLog }));
        break;
      }
      case 'open-support': shell.openExternal('https://discord.gg/jBQCPUsVE'); break;
```

In `case 'vm-update-retry':`, change

```js
            if (!entry.failed && !(entry.version && macUpdate.isNewer(app.getVersion(), entry.version))) continue;
```

to

```js
            if (!value.force && !entry.failed && !(entry.version && macUpdate.isNewer(app.getVersion(), entry.version))) continue;
```

- [ ] **Step 5: Log every failed command**

In `registerIpc()`, change the handler's first line from

```js
  ipcMain.handle('workspace:command', async (event, command, value = {}) => {
```

to

```js
  const runCommand = async (event, command, value = {}) => {
```

and its closing line (the `  });` right after `    broadcastNow(); return getState();`) to

```js
  };
  // Failed actions only reached the screen as a toast; log them so a copied
  // report shows what went wrong.
  ipcMain.handle('workspace:command', async (event, command, value = {}) => {
    try { return await runCommand(event, command, value); }
    catch (error) { logError(`command ${command}`, error); throw error; }
  });
```

- [ ] **Step 6: Run the full check**

Run: `npm test`
Expected: every `node --check` passes, including `src/main.cjs` and `src/setup-check.cjs`, and every test file
passes.

- [ ] **Step 7: Commit**

```bash
git add src/main.cjs
git commit -m "Wire Check setup, the copyable report and stale connector cleanup into the main process, and log failed commands.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: the buttons and results

**Files:**
- Modify: `desktop/src/renderer.js` (new top-level helpers above `function showSettings()`, the Agent setup
  section in `showSettings`, and wizard step 3 in `renderOnboarding`)
- Modify: `desktop/src/style.css` (one new rule line after the `.checklist{…}` line)

**Interfaces:**
- Consumes: the commands from Task 5, plus the existing `move-to-applications` and `open-mac-privacy`.
- Produces: the UI. No new interfaces.

- [ ] **Step 1: Add the shared helpers**

Directly above `function showSettings() {` add:

```js
const CHECK_GROUPS = [['computer', 'This computer'], ['connection', 'Connection'], ['server', 'Server']];
const CHECK_MARKS = { ok: '✓', warn: '!', fail: '✗' };
const CHECK_ACTIONS = {
  'move-to-applications': ['Move to Applications', () => command('move-to-applications')],
  'open-accessibility': ['Open settings', () => command('open-mac-privacy', { pane: 'accessibility' })],
  'open-screen': ['Open settings', () => command('open-mac-privacy', { pane: 'screen' })],
  'remove-old-connector': ['Remove old copy', async () => { if (await command('remove-old-connector')) toast('Old connector copy removed.'); }],
  'update-server': ['Update server', async () => { toast('Updating the server…'); await command('vm-update-retry', { force: true }); }],
};
function renderFindings(container, findings) {
  container.replaceChildren();
  for (const [group, label] of CHECK_GROUPS) {
    const rows = findings.filter((f) => f.group === group);
    if (!rows.length) continue;
    container.append(element('p', 'check-group', label));
    for (const f of rows) {
      const item = element('div', `check-row ${f.level}`);
      item.append(element('p', 'check-item', `${CHECK_MARKS[f.level]} ${f.title}`));
      if (f.level !== 'ok' && f.fix) item.append(element('p', 'settings-note', f.fix));
      const action = f.level !== 'ok' && CHECK_ACTIONS[f.action];
      if (action) { const fix = element('button', 'secondary-button', action[0]); fix.onclick = action[1]; item.append(fix); }
      container.append(item);
    }
  }
}
async function runSetupCheck(trigger, container) {
  trigger.disabled = true; trigger.textContent = 'Checking…';
  container.classList.remove('hidden');
  container.replaceChildren(element('p', 'settings-note', 'Checking this computer, the connection and the server. This can take up to two minutes.'));
  const findings = await command('setup-check');
  trigger.disabled = false; trigger.textContent = 'Check setup';
  if (Array.isArray(findings)) renderFindings(container, findings); else container.classList.add('hidden');
}
async function copyReport() {
  if (await command('copy-report')) toast('Report copied. Paste it in Discord so we can take a look.');
}
```

- [ ] **Step 2: Add the buttons to Settings → Agent setup**

In `showSettings()`, directly above the line that starts
`  body.append(vpsField, sshField, element('div', 'setting-row'), sshSave,`, add:

```js
  const checkSetup = element('button', 'secondary-button', 'Check setup');
  const checkResults = element('div', 'checklist hidden');
  checkSetup.onclick = () => runSetupCheck(checkSetup, checkResults);
  const report = element('button', 'secondary-button', 'Copy report'); report.onclick = copyReport;
  const support = element('button', 'link-button', 'Get help on Discord ↗'); support.onclick = () => command('open-support');
```

Then change that `body.append(…)` line so that it ends `… agentTest, wizard, agentResult, checkSetup, report, support, checkResults);`.
In other words, append `checkSetup, report, support, checkResults` after `agentResult`.

- [ ] **Step 3: Use Check setup in wizard step 3**

In `renderOnboarding`, in the final `else {` branch (step 3, "Finish the connection"), replace everything from
`    const result = element('p', 'settings-note', '');` through `    card.append(testButton, result);` with:

```js
    const results = element('div', 'checklist hidden');
    const checkButton = button('Check setup', 'secondary-button', async () => {
      if (!await command('settings', { macSshHost: mine.value.trim(), vpsBrowser: { ...state.vpsBrowser, sshHost: vps.value.trim() } })) return;
      await runSetupCheck(checkButton, results);
    });
    card.append(checkButton, results);
```

and change `    actions.append(button('Back', 'secondary-button', () => go(2)), button('Done', 'primary-button', finish));` to

```js
    actions.append(button('Copy report', 'secondary-button', copyReport), button('Back', 'secondary-button', () => go(2)), button('Done', 'primary-button', finish));
```

- [ ] **Step 4: Style the rows**

In `desktop/src/style.css`, directly after the line that starts `.checklist{margin:6px 0 10px;`, add:

```css
.check-group{margin:10px 0 2px;font-size:10px;letter-spacing:1.2px;text-transform:uppercase;color:#6f6f7b}.check-row{margin:0 0 8px}.check-row .settings-note{margin:0 0 4px 16px}.check-row .secondary-button{margin-left:16px;font-size:11px;padding:6px 10px}.check-row.ok .check-item{color:#7fd4a8}.check-row.warn .check-item{color:#e6b45c}.check-row.fail .check-item{color:#ef7d7d}
```

- [ ] **Step 5: Run the full check**

Run: `npm test`
Expected: PASS. `node --check src/renderer.js` passes, and so does every test.

- [ ] **Step 6: Look at it in the running app**

Run the app with its own data folder, so it never touches the real app's settings or its single-instance lock:

```bash
HERMES_WORKSPACE_DATA="$TMPDIR/setup-check-app" npm start
```

Then, using the `computer-use` skill to click and take screenshots:
1. Edge case: open Settings, enter `root@100.64.0.99` as the server address and `me@100.64.0.98` as this
   computer's address, click **Save addresses**, then **Check setup**. Expected: the This computer rows show;
   Connection shows ✗ "This computer can't reach the server"; Server shows the single ✗ "Server checks
   skipped". Click **Copy report** and paste the clipboard (`pbpaste`). Expected: it starts with
   `Open Alan report,`, lists those rows and contains no token.
2. Golden path: enter the test server's address (`root@100.74.3.5`, the old Hetzner box), then
   **Check setup**. Expected: Connection ✓ "This computer reaches the server", and Server rows from a real
   `--doctor` run. Until the new-user test has run setup on that box, the run reports ✗ "Open Alan isn't
   installed on the server". After that, it shows versions, plugin rows and the setup audit. The made-up
   computer address from step 1 makes "The server can't reach this computer" fail. That's expected.
3. Wizard: click **Run setup wizard**, go to step 3, click **Check setup**. Expected: the same list appears in
   the card, and **Copy report** is next to **Back**.

Save a screenshot of each to the scratchpad. Fix anything that looks wrong before committing.

- [ ] **Step 7: Commit**

```bash
git add src/renderer.js src/style.css
git commit -m "Show Check setup results with fix buttons in Settings and the wizard, with Copy report and a Discord help link.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: whole-branch verification

**Files:** none changed unless a check fails.

- [ ] **Step 1: Full suite**

Run: `npm test`
Expected: PASS. Paste the final summary lines (`# pass N`, `# fail 0`) into the hand-off.

- [ ] **Step 2: Run `--doctor` against a real server**

From the repo root:
`ssh root@100.74.3.5 'HERMES_HOME=/root/hermes-newuser sh -s -- --doctor' < desktop/scripts/vm-update.sh`
Expected: one JSON line. Until the new-user test has run setup there, that line is `"ok":false` with
`no browser host checkout found`. After setup, it is `"ok":true` with the profile's plugin rows. The run is
read-only, so running it twice gives the same output.

- [ ] **Step 3: Stale connector cleanup, by hand**

Using the isolated data folder from Task 6, create `$TMPDIR/setup-check-app/connector/package.json`
containing `{"version":"0.0.1"}`. Start the app, then quit it. Expected: the `connector` folder is gone. Repeat
with `{"version":"9.9.9"}`. Expected: it stays.
