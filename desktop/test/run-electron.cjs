const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-electron-suite-'));
const child = spawn(require('electron'), [`--user-data-dir=${profile}`, path.resolve(process.argv[2])], {
  env: { ...process.env, HERMES_TEST_PROFILE: profile }, stdio: 'inherit',
});
const deadline = setTimeout(() => { console.error('Electron suite exceeded its 160s deadline.'); child.kill('SIGKILL'); }, 160000);
child.once('error', error => { console.error(error); });
child.once('close', (code, signal) => {
  clearTimeout(deadline);
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
  catch (error) { console.error(error); process.exitCode = 1; }
  if (code !== 0 || signal) process.exitCode = 1;
});
