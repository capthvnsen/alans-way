// The environment and safety net for running window suites hidden (see src/hidden-mode.cjs); shared by run-hidden.cjs
// and scripts/ui-shot.cjs. On macOS the app runs from a background-only copy of Electron, so no Dock icon appears even
// before the app can hide it, and a watchdog kills the run by exact pid if any process of it owns an on-screen window or
// shows up as a visible process in System Events.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const desktop = path.resolve(__dirname, '..');

function electronDist() {
  const dist = path.join(path.dirname(require.resolve('electron/package.json')), 'dist');
  if (process.platform !== 'darwin') return { dist: null, binary: require('electron') };
  const version = fs.readFileSync(path.join(dist, 'version'), 'utf8').trim();
  const stub = path.join(desktop, 'node_modules', '.cache', 'hermes-hidden-electron', version);
  if (!fs.existsSync(path.join(stub, 'Electron.app'))) {
    // LSUIElement makes the copy background-only from its first instruction. `cp -c` clones on APFS, so it costs no disk.
    const tmp = `${stub}.${process.pid}`;
    fs.mkdirSync(tmp, { recursive: true });
    execFileSync('cp', ['-cR', path.join(dist, 'Electron.app'), tmp]);
    fs.copyFileSync(path.join(dist, 'version'), path.join(tmp, 'version'));
    execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Add :LSUIElement bool true', path.join(tmp, 'Electron.app/Contents/Info.plist')]);
    execFileSync('codesign', ['--force', '--deep', '-s', '-', path.join(tmp, 'Electron.app')], { stdio: 'ignore' });
    try { fs.renameSync(tmp, stub); } catch { fs.rmSync(tmp, { recursive: true, force: true }); }
  }
  return { dist: stub, binary: path.join(stub, 'Electron.app/Contents/MacOS/Electron') };
}

// `base` is the environment to extend (normally privateTmp().env merged over process.env).
// Throws unless a window-less launch proves the hidden mode took hold, so a broken mode can never reach a real suite.
function hiddenEnv(base = process.env) {
  const { dist, binary } = electronDist();
  const env = { ...base, HERMES_WORKSPACE_TEST_HIDDEN: '1',
    NODE_OPTIONS: `${base.NODE_OPTIONS || ''} --require ${path.join(desktop, 'src/hidden-mode.cjs')}`.trim() };
  if (dist) env.ELECTRON_OVERRIDE_DIST_PATH = dist;
  const profile = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'hc-'));
  try {
    const canary = spawnSync(binary, [`--user-data-dir=${profile}`, path.join(__dirname, 'hidden-canary.cjs')], { env, encoding: 'utf8', timeout: 60000 });
    if (!/HIDDEN-MODE-OK/.test(canary.stdout || '')) throw new Error(`Hidden mode did not take hold; refusing to launch a suite.\n${canary.stdout}${canary.stderr}`);
  } finally { fs.rmSync(profile, { recursive: true, force: true }); }
  return { env, binary };
}

const jxa = `ObjC.import('CoreGraphics');function run(a){const p=new Set(a.map(Number));` +
  `return ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly,0)))` +
  `.filter(w=>p.has(w.kCGWindowOwnerPID)).map(w=>w.kCGWindowOwnerPID+' '+w.kCGWindowOwnerName+' '+JSON.stringify(w.kCGWindowBounds)).join(',')}`;
const osa = args => execFileSync('osascript', args, { timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
function processTree(root) {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=']).toString().trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
  const pids = new Set([root]);
  for (let grew = true; grew;) { grew = false; for (const [pid, ppid] of rows) if (pids.has(ppid) && !pids.has(pid)) { pids.add(pid); grew = true; } }
  return [...pids];
}
// Returns a function that stops watching. `fail(reason)` runs after the tree has been killed.
function watchdog(child, fail) {
  if (process.platform !== 'darwin') return () => {};
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    try {
      const pids = processTree(child.pid);
      const windows = osa(['-l', 'JavaScript', '-e', jxa, ...pids.map(String)]);
      const visible = osa(['-e', 'tell application "System Events" to get unix id of every process whose visible is true']).split(/,\s*/).map(Number);
      const shown = pids.filter(pid => visible.includes(pid));
      if (windows || shown.length) {
        for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch {} }
        fail(windows ? `on-screen window: ${windows}` : `visible process: ${shown}`);
      }
    } catch {} finally { busy = false; }
  }, 250);
  timer.unref();
  return () => clearInterval(timer);
}
module.exports = { hiddenEnv, watchdog };
