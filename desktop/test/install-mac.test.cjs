// Runs scripts/install-mac.sh against fake binaries in a temp dir. The app
// destination is redirected with ALANS_WAY_APP_DEST; /Applications and the
// network are never touched.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '../../scripts/install-mac.sh');
const posix = { skip: process.platform === 'win32' && 'POSIX shell script' };
const dirs = [];
after(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); });

const writeApp = (app, marker, { executable = true } = {}) => {
  fs.mkdirSync(path.join(app, 'Contents/MacOS'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents/Info.plist'), marker);
  if (executable) fs.writeFileSync(path.join(app, 'Contents/MacOS/alans-way-localapp'), '#!/bin/sh\n', { mode: 0o755 });
};
const script = (file, body) => fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });

// failPlaceNew makes the rename that puts the new app in place fail, as a full disk
// or a permission change would; incompleteBuild builds an app with no executable.
function run({ failPlaceNew = false, incompleteBuild = false, staleOld = false, existing = true,
  buildFromSource = false, arch = 'arm64', badChecksum = false, failCodesign = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'install-mac-')); dirs.push(dir);
  const bin = path.join(dir, 'bin'), home = path.join(dir, 'home'), src = path.join(dir, 'src');
  const fixture = path.join(dir, 'fixture'), dest = path.join(dir, 'apps', 'alans-way-localapp.app');
  const logs = { curl: path.join(dir, 'curl.log'), npm: path.join(dir, 'npm.log') };
  for (const d of [bin, fixture, path.dirname(dest), path.join(src, '.git'), path.join(src, 'desktop'), path.join(home, 'Library/Application Support/Hermes Workspace')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(home, 'Library/Application Support/Hermes Workspace/connection.json'), '{"url":"http://fixture.local","token":"fixture"}');
  if (existing) writeApp(dest, 'old');
  if (staleOld) { fs.renameSync(dest, `${dest}.old`); }

  const releaseApp = path.join(fixture, 'release-app');
  writeApp(releaseApp, 'release');
  const dmg = path.join(fixture, 'OpenAlan-mac.dmg');
  fs.writeFileSync(dmg, 'fixture dmg\n');
  let sha512 = crypto.createHash('sha512').update(fs.readFileSync(dmg)).digest('hex');
  if (badChecksum) sha512 = `${sha512[0] === '0' ? '1' : '0'}${sha512.slice(1)}`;
  fs.writeFileSync(path.join(fixture, 'OpenAlan-mac.dmg.sha512'), `${sha512}  OpenAlan-mac.dmg\n`);
  const built = path.join(src, 'desktop/dist/mac-arm64/alans-way-localapp.app');

  script(path.join(bin, 'uname'), 'if [ "$1" = -m ]; then echo "$FAKE_ARCH"; else echo Darwin; fi');
  script(path.join(bin, 'node'), 'echo "fake 1.0.0"');
  script(path.join(bin, 'xcode-select'), 'exit 0');
  script(path.join(bin, 'git'), 'case "$*" in *rev-parse*) echo abc1234;; esac');
  script(path.join(bin, 'pgrep'), 'exit 1');
  script(path.join(bin, 'open'), 'exit 0');
  script(path.join(bin, 'curl'), `
out=''
url=''
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    http*://*) url="$1"; shift ;;
    *) shift ;;
  esac
done
echo "$url" >> "$CURL_LOG"
write_body() {
  case "$url" in
    */releases/latest) printf '%s\\n' '{"tag_name":"v9.9.9"}' ;;
    *\/v1/status) printf '%s\\n' '{"host":"fixture","version":"1.0.0"}' ;;
    */OpenAlan-mac.dmg.sha512) cat "$FIXTURE_DIR/OpenAlan-mac.dmg.sha512" ;;
    */OpenAlan-mac.dmg) cat "$FIXTURE_DIR/OpenAlan-mac.dmg" ;;
    *) echo "unexpected curl: $url" >&2; exit 1 ;;
  esac
}
if [ -n "$out" ]; then write_body > "$out"; else write_body; fi`);
  script(path.join(bin, 'hdiutil'), `
if [ "$1" = attach ]; then
  mount=''
  while [ $# -gt 0 ]; do
    if [ "$1" = -mountpoint ]; then mount="$2"; shift 2; else shift; fi
  done
  mkdir -p "$mount"
  cp -R "$FIXTURE_DIR/release-app" "$mount/alans-way-localapp.app"
  exit 0
fi
[ "$1" = detach ] && exit 0
exit 1`);
  script(path.join(bin, 'defaults'), '[ "$3" = CFBundleIdentifier ] && echo app.alans-way.localapp');
  script(path.join(bin, 'codesign'), '[ -z "$FAIL_CODESIGN" ]');
  script(path.join(bin, 'xcrun'), '[ "$1" = stapler ] && [ "$2" = validate ]');
  script(path.join(bin, 'spctl'), 'exit 1');
  script(path.join(bin, 'ditto'), (incompleteBuild ? 'cp -R "$1" "$2"; rm -f "$2/Contents/MacOS/alans-way-localapp"' : 'cp -R "$1" "$2"'));
  script(path.join(bin, 'npm'), `echo "$@" >> "$NPM_LOG"
[ "$1" = ci ] && exit 0
mkdir -p "${built}/Contents/MacOS"; echo source > "${built}/Contents/Info.plist"
printf '#!/bin/sh\\n' > "${built}/Contents/MacOS/alans-way-localapp"; chmod +x "${built}/Contents/MacOS/alans-way-localapp"`);
  script(path.join(bin, 'mv'), `[ -n "$FAIL_PLACE_NEW" ] && [ "$2" = "$ALANS_WAY_APP_DEST" ] && [ "$1" = "$ALANS_WAY_APP_DEST.new" ] && exit 1
exec /bin/mv "$@"`);
  const env = {
    PATH: `${bin}:/usr/bin:/bin`, HOME: home, ALANS_WAY_DIR: src, ALANS_WAY_APP_DEST: dest,
    FAIL_PLACE_NEW: failPlaceNew ? '1' : '', FAIL_CODESIGN: failCodesign ? '1' : '',
    FAKE_ARCH: arch, FIXTURE_DIR: fixture, CURL_LOG: logs.curl, NPM_LOG: logs.npm,
  };
  if (buildFromSource) env.ALANS_WAY_BUILD_FROM_SOURCE = '1';
  const result = spawnSync('/bin/sh', [SCRIPT], { encoding: 'utf8', timeout: 60000, env });
  const read = (app) => (fs.existsSync(path.join(app, 'Contents/Info.plist')) ? fs.readFileSync(path.join(app, 'Contents/Info.plist'), 'utf8').trim() : null);
  return { result, dest, read, logs };
}

const text = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');

test('install-mac downloads and installs the verified release by default', posix, () => {
  const { result, dest, read, logs } = run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(read(dest), 'release');
  assert.match(text(logs.curl), /releases\/latest/);
  assert.match(text(logs.curl), /OpenAlan-mac\.dmg/);
  assert.equal(text(logs.npm), '');
  assert.ok(!fs.existsSync(`${dest}.old`) && !fs.existsSync(`${dest}.new`));
});

test('install-mac aborts a checksum mismatch without touching the installed app', posix, () => {
  const { result, dest, read } = run({ badChecksum: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /did not match its checksum/);
  assert.equal(read(dest), 'old');
  assert.ok(!fs.existsSync(`${dest}.old`) && !fs.existsSync(`${dest}.new`));
});

test('install-mac aborts a signature failure without touching the installed app', posix, () => {
  const { result, dest, read } = run({ failCodesign: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /signature verification/);
  assert.equal(read(dest), 'old');
  assert.ok(!fs.existsSync(`${dest}.old`) && !fs.existsSync(`${dest}.new`));
});

test('install-mac builds from source only when the explicit switch is set', posix, () => {
  const { result, dest, read, logs } = run({ buildFromSource: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(read(dest), 'source');
  assert.match(result.stdout, /ALANS_WAY_BUILD_FROM_SOURCE/);
  assert.match(text(logs.npm), /ci/);
  assert.doesNotMatch(text(logs.curl), /releases\/latest/);
});

test('install-mac says an Intel Mac has no release and falls back to the source build', posix, () => {
  const { result, dest, read, logs } = run({ arch: 'x86_64' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(read(dest), 'source');
  assert.match(result.stdout, /No published Mac release.*x86_64/);
  assert.match(text(logs.npm), /ci/);
  assert.doesNotMatch(text(logs.curl), /releases\/latest/);
});

test('install-mac puts the old app back when the new one cannot be put in place', posix, () => {
  const { result, dest, read } = run({ failPlaceNew: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /previous app was restored/);
  assert.equal(read(dest), 'old');
  assert.ok(!fs.existsSync(`${dest}.old`));
});

test('install-mac leaves the old app alone when the copy is incomplete', posix, () => {
  const { result, dest, read } = run({ buildFromSource: true, incompleteBuild: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /incomplete/);
  assert.equal(read(dest), 'old');
  assert.ok(!fs.existsSync(`${dest}.new`));
});

test('install-mac restores the app a killed earlier run left only at .old', posix, () => {
  const { result, dest, read } = run({ staleOld: true, buildFromSource: true, incompleteBuild: true });
  assert.notEqual(result.status, 0);
  assert.equal(read(dest), 'old');
});

test('install-mac installs when nothing is installed yet', posix, () => {
  const { result, dest, read } = run({ existing: false });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(read(dest), 'release');
});
