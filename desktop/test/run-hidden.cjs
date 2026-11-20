// Runs one `npm run test:<name>` window suite with the app under test hidden: no window, focus, Dock icon or native
// dialog (see src/hidden-mode.cjs). On macOS a watchdog also kills the run by exact pid if any process of the run owns
// an on-screen window or shows up as a visible process in System Events.
//   node test/run-hidden.cjs test:newtab
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { privateTmp } = require('./with-tmp.cjs');
const desktop = path.resolve(__dirname, '..');
// Suites whose point is real OS focus, real visibility, or a human at the keyboard cannot be judged without a screen,
// and one that needs a real hermes process, which an agent must not start.
const NEEDS_SCREEN = {
  'test:desktop': 'asserts native window focus',
  'test:keyboard-navigation': 'asserts native focus order',
  'test:shortcut-reference': 'asserts native focus and menu accelerators',
  'test:recorder': 'asserts the tab view took native focus',
  'test:pdf-viewer': 'asserts document.hasFocus() after native focus',
  'test:browser-reliability': 'opens a visible human window by design',
  'test:live': 'is the visible suite set',
  'test:native-hermes': 'starts a real hermes process',
};

function hiddenElectron() {
  if (process.platform !== 'darwin') return null;
  const dist = path.join(path.dirname(require.resolve('electron/package.json')), 'dist');
  const version = fs.readFileSync(path.join(dist, 'version'), 'utf8').trim();
  const stub = path.join(desktop, 'node_modules', '.cache', 'hermes-hidden-electron', version);
  if (!fs.existsSync(path.join(stub, 'Electron.app'))) {
    // LSUIElement makes the copy background-only from its first instruction, so no Dock icon flashes before app.dock.hide().
    const tmp = `${stub}.${process.pid}`;
    fs.mkdirSync(tmp, { recursive: true });
    execFileSync('cp', ['-cR', path.join(dist, 'Electron.app'), tmp]);
    fs.copyFileSync(path.join(dist, 'version'), path.join(tmp, 'version'));
    execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Add :LSUIElement bool true', path.join(tmp, 'Electron.app/Contents/Info.plist')]);
    execFileSync('codesign', ['--force', '--deep', '-s', '-', path.join(tmp, 'Electron.app')], { stdio: 'ignore' });
    try { fs.renameSync(tmp, stub); } catch { fs.rmSync(tmp, { recursive: true, force: true }); }
  }
  return stub;
}

const jxa = `ObjC.import('CoreGraphics');function run(a){const p=new Set(a.map(Number));` +
  `return ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly,0)))` +
  `.filter(w=>p.has(w.kCGWindowOwnerPID)).map(w=>w.kCGWindowOwnerPID+' '+w.kCGWindowOwnerName).join(',')}`;
function osa(args) { return execFileSync('osascript', args, { timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
function processTree(root) {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=']).toString().trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
  const pids = new Set([root]);
  for (let grew = true; grew;) { grew = false; for (const [pid, ppid] of rows) if (pids.has(ppid) && !pids.has(pid)) { pids.add(pid); grew = true; } }
  return [...pids];
}
function watchdog(child, fail) {
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
        fail(`${windows ? `on-screen window: ${windows}` : `visible process: ${shown}`}`);
      }
    } catch {} finally { busy = false; }
  }, 250);
  timer.unref();
  return () => clearInterval(timer);
}

const name = process.argv[2];
if (!name?.startsWith('test:') || !require('../package.json').scripts[name]) {
  console.error('Usage: node test/run-hidden.cjs test:<suite>'); process.exit(2);
}
if (NEEDS_SCREEN[name]) { console.log(`SKIPPED ${name} in hidden mode: it ${NEEDS_SCREEN[name]}.`); process.exit(0); }

const tmp = privateTmp();
const profile = fs.mkdtempSync(path.join(tmp.dir, 'hermes-hidden-'));
const dist = hiddenElectron();
const env = { ...process.env, ...tmp.env, HERMES_WORKSPACE_TEST_HIDDEN: '1', HERMES_WORKSPACE_DATA: process.env.HERMES_WORKSPACE_DATA || profile,
  NODE_OPTIONS: `${tmp.env.NODE_OPTIONS} --require ${path.join(desktop, 'src/hidden-mode.cjs')}` };
if (dist) env.ELECTRON_OVERRIDE_DIST_PATH = dist;
const child = spawn('npm', ['run', name], { cwd: desktop, env, stdio: 'inherit' });
const stop = process.platform === 'darwin' ? watchdog(child, reason => { console.error(`WATCHDOG ABORT: ${reason}`); process.exitCode = 99; }) : () => {};
child.once('close', (code, signal) => {
  stop();
  fs.rmSync(profile, { recursive: true, force: true });
  if (!tmp.finish()) process.exitCode ||= 1;
  if (!process.exitCode && (code || signal)) process.exitCode = code || 1;
});
