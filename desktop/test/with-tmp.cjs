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
const CHROMIUM = ['Crashpad', 'Local Storage', 'Network', 'GPUCache', 'Code Cache', 'Session Storage', 'Shared Dictionary', 'Partitions', 'Local State', 'Preferences',
  'blob_storage', 'DawnGraphiteCache', 'DawnWebGPUCache', 'shared_proto_db', 'WebStorage', 'DIPS', 'SingletonLock', 'SingletonCookie', 'SingletonSocket'];
const isProfile = dir => { try { return CHROMIUM.some(name => fs.existsSync(path.join(dir, name))); } catch { return false; } };
// strict: false is for runs that start Electron. Chromium keeps writing into a profile after the test's own code has
// removed it, in files no list here can keep up with, so those runs sweep and report but do not fail.
function privateTmp({ strict = true } = {}) {
  // /tmp keeps paths short: macOS's own temp folder is 49 characters, and unix sockets under it cap at 104.
  const dir = fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'ht-'));
  return {
    dir,
    env: { TMPDIR: dir, TMP: dir, TEMP: dir,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require ${path.join(__dirname, 'tmp-cleanup.cjs')}`.trim() },
    finish() {
      const all = fs.readdirSync(dir).filter(name => !ALLOWED.test(name) && !isProfile(path.join(dir, name)));
      // Only a mkdtemp name (prefix, dash, six characters) is a test's own folder. Tools the tests run (pwsh, Chrome) leave
      // their own files here; those are swept with the folder and only reported.
      const left = all.filter(name => /^[A-Za-z][\w-]*-[A-Za-z0-9]{6}$/.test(name) && !/^dotnet-diagnostic-/.test(name));
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      if (all.length > left.length) console.error(`Swept ${all.length - left.length} file(s) left by tools the tests ran.`);
      if (left.length) { console.error(`TEMP LEAK: the tests left ${left.length} folder(s) behind: ${left.slice(0, 10).join(', ')}`); return !strict; }
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
