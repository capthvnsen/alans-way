// Preloaded into every test process (node-options in desktop/.npmrc, or NODE_OPTIONS): any directory a test creates with
// fs.mkdtemp* directly under the temp folder is removed when the process exits, whether the test passed, failed or threw.
// A process that is SIGKILLed cannot clean up; test/with-tmp.cjs covers that. HERMES_TEST_KEEP_TMP=1 keeps everything.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Evidence folders are printed for a human to open after the run, so they stay.
const KEEP = /^(workspace-|.*evidence)/;
if (process.type !== 'renderer' && !process.env.HERMES_TEST_KEEP_TMP && !globalThis.__hermesTmpCleanup) {
  globalThis.__hermesTmpCleanup = true;
  const made = new Set();
  const track = dir => {
    try {
      const real = fs.realpathSync(dir);
      if (path.dirname(real) === fs.realpathSync(os.tmpdir()) && !KEEP.test(path.basename(real))) made.add(real);
    } catch { /* not ours to track */ }
    return dir;
  };
  const { mkdtempSync, mkdtemp } = fs, { mkdtemp: mkdtempAsync } = fs.promises;
  fs.mkdtempSync = (...args) => track(mkdtempSync(...args));
  fs.mkdtemp = (...args) => {
    const done = args.pop();
    return mkdtemp(...args, (error, dir) => done(error, error ? dir : track(dir)));
  };
  fs.promises.mkdtemp = async (...args) => track(await mkdtempAsync(...args));
  const sweep = () => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); made.clear(); };
  process.on('exit', sweep);
  // A signal's default action skips 'exit' handlers, so convert it to a normal exit.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => process.exit(128 + os.constants.signals[signal]));
}
