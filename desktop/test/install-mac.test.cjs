// Runs scripts/install-mac.sh against fake binaries in a temp dir. The app
// destination is redirected with ALANS_WAY_APP_DEST; /Applications is never touched.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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
function run({ failPlaceNew = false, incompleteBuild = false, staleOld = false, existing = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'install-mac-')); dirs.push(dir);
  const bin = path.join(dir, 'bin'), home = path.join(dir, 'home'), src = path.join(dir, 'src');
  const dest = path.join(dir, 'apps', 'alans-way-localapp.app');
  for (const d of [bin, path.dirname(dest), path.join(src, '.git'), path.join(src, 'desktop'), path.join(home, 'Library/Application Support/Hermes Workspace')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(home, 'Library/Application Support/Hermes Workspace/connection.json'), '{}');
  if (existing) writeApp(dest, 'old');
  if (staleOld) { fs.renameSync(dest, `${dest}.old`); }
  const built = path.join(src, 'desktop/dist/mac-arm64/alans-way-localapp.app');
  script(path.join(bin, 'uname'), 'if [ "$1" = -m ]; then echo arm64; else echo Darwin; fi');
  script(path.join(bin, 'node'), 'echo "fake 1.0.0"');
  script(path.join(bin, 'xcode-select'), 'exit 0');
  script(path.join(bin, 'git'), 'case "$*" in *rev-parse*) echo abc1234;; esac');
  script(path.join(bin, 'pgrep'), 'exit 1');
  script(path.join(bin, 'open'), 'exit 0');
  script(path.join(bin, 'ditto'), (incompleteBuild ? 'cp -R "$1" "$2"; rm -f "$2/Contents/MacOS/alans-way-localapp"' : 'cp -R "$1" "$2"'));
  script(path.join(bin, 'npm'), `[ "$1" = ci ] && exit 0
mkdir -p "${built}/Contents/MacOS"; echo new > "${built}/Contents/Info.plist"
printf '#!/bin/sh\\n' > "${built}/Contents/MacOS/alans-way-localapp"; chmod +x "${built}/Contents/MacOS/alans-way-localapp"`);
  script(path.join(bin, 'mv'), `[ -n "$FAIL_PLACE_NEW" ] && [ "$2" = "$ALANS_WAY_APP_DEST" ] && [ "$1" = "$ALANS_WAY_APP_DEST.new" ] && exit 1
exec /bin/mv "$@"`);
  const result = spawnSync('/bin/sh', [SCRIPT], {
    encoding: 'utf8', timeout: 60000,
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, ALANS_WAY_DIR: src, ALANS_WAY_APP_DEST: dest, FAIL_PLACE_NEW: failPlaceNew ? '1' : '' },
  });
  const read = (app) => (fs.existsSync(path.join(app, 'Contents/Info.plist')) ? fs.readFileSync(path.join(app, 'Contents/Info.plist'), 'utf8').trim() : null);
  return { result, dest, read };
}

test('install-mac replaces the installed app and leaves no leftovers', posix, () => {
  const { result, dest, read } = run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(read(dest), 'new');
  assert.ok(!fs.existsSync(`${dest}.old`) && !fs.existsSync(`${dest}.new`));
});

test('install-mac puts the old app back when the new one cannot be put in place', posix, () => {
  const { result, dest, read } = run({ failPlaceNew: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /previous app was restored/);
  assert.equal(read(dest), 'old');
  assert.ok(!fs.existsSync(`${dest}.old`));
});

test('install-mac leaves the old app alone when the copy is incomplete', posix, () => {
  const { result, dest, read } = run({ incompleteBuild: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /incomplete/);
  assert.equal(read(dest), 'old');
  assert.ok(!fs.existsSync(`${dest}.new`));
});

test('install-mac restores the app a killed earlier run left only at .old', posix, () => {
  const { result, dest, read } = run({ staleOld: true, incompleteBuild: true });
  assert.notEqual(result.status, 0);
  assert.equal(read(dest), 'old');
});

test('install-mac installs when nothing is installed yet', posix, () => {
  const { result, dest, read } = run({ existing: false });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(read(dest), 'new');
});
