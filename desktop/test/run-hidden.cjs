// Runs one `npm run test:<name>` window suite with the app under test hidden: no window, focus, Dock icon or native
// dialog (see src/hidden-mode.cjs), with the watchdog from hidden-env.cjs on macOS.
//   node test/run-hidden.cjs test:newtab
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { privateTmp } = require('./with-tmp.cjs');
const { hiddenEnv, watchdog } = require('./hidden-env.cjs');
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

const name = process.argv[2];
if (!name?.startsWith('test:') || !require('../package.json').scripts[name]) {
  console.error('Usage: node test/run-hidden.cjs test:<suite>'); process.exit(2);
}
if (NEEDS_SCREEN[name]) { console.log(`SKIPPED ${name} in hidden mode: it ${NEEDS_SCREEN[name]}.`); process.exit(0); }

const tmp = privateTmp({ strict: false });
const profile = fs.mkdtempSync(path.join(tmp.dir, 'hermes-hidden-'));
const { env } = hiddenEnv({ ...process.env, ...tmp.env, HERMES_WORKSPACE_DATA: process.env.HERMES_WORKSPACE_DATA || profile });
const child = spawn('npm', ['run', name], { cwd: desktop, env, stdio: 'inherit' });
const stop = watchdog(child, reason => { console.error(`WATCHDOG ABORT: ${reason}`); process.exitCode = 99; });
child.once('close', (code, signal) => {
  stop();
  fs.rmSync(profile, { recursive: true, force: true });
  if (!tmp.finish()) process.exitCode ||= 1;
  if (!process.exitCode && (code || signal)) process.exitCode = code || 1;
});
