// Runs a command with a private temp folder and fails the run if the tests left directories in it. test/tmp-cleanup.cjs
// removes what a process creates when it exits; this catches what it cannot (a killed process, a script's own mktemp)
// and still removes it, so one bad suite cannot fill the disk.
//   node test/with-tmp.cjs node --test test/*.test.cjs
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

// Same exemption as tmp-cleanup.cjs, plus Node's own compile cache and the product's own scratch folders (ssh control sockets; the update check's, which
// dies with the app when a suite quits mid-check). The prefix below is short on
// purpose: unix socket paths under the temp folder cap at 104 bytes.
const ALLOWED = /^(workspace-|.*evidence|hw-tailnet-ssh-|node-compile-cache$|vm-update-check\.)/;
// Chromium rewrites an Electron profile while it shuts down, after the last line of test code, so a profile folder that
// comes back is swept without failing the run.
const CHROMIUM = ['Crashpad', 'Local Storage', 'Network', 'GPUCache', 'Code Cache', 'Session Storage', 'Shared Dictionary'];
const isProfile = dir => { try { return CHROMIUM.some(name => fs.existsSync(path.join(dir, name))); } catch { return false; } };
function privateTmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ht-'));
  return {
    dir,
    env: { TMPDIR: dir, TMP: dir, TEMP: dir,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require ${path.join(__dirname, 'tmp-cleanup.cjs')}`.trim() },
    finish() {
      const left = fs.readdirSync(dir).filter(name => !ALLOWED.test(name) && !isProfile(path.join(dir, name)));
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      if (left.length) { console.error(`TEMP LEAK: the tests left ${left.length} folder(s) behind: ${left.slice(0, 10).join(', ')}`); return false; }
      return true;
    },
  };
}
module.exports = { privateTmp };

if (require.main === module) {
  const tmp = privateTmp();
  const child = spawn(process.argv[2], process.argv.slice(3), { stdio: 'inherit', env: { ...process.env, ...tmp.env } });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.once('error', error => { console.error(error); process.exitCode = 1; });
  child.once('close', (code, signal) => { const clean = tmp.finish(); process.exitCode = code || (signal ? 1 : clean ? 0 : 1); });
}
