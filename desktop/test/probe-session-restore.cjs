// Measures startup with saved session-only sign-ins, hidden, on a throwaway profile (never the real one):
//   node test/probe-session-restore.cjs [cookiesPerPartition=20] [keychainDelayMs=0]
// Also seeds one saved tab on a loopback server and prints when that server first sees a request (+ms since the app was
// spawned, so it also includes Electron's own startup before the app's clock starts), to show restored tabs waiting for the restore or its cap.
// Seeds preferences.json with sessionCookies sealed by the mock keychain, launches the app hidden under the
// watchdog with HERMES_WORKSPACE_PROFILE_BOOT=1, and prints the [boot-timing] lines. Not part of `npm test`.
// The mock keychain answers at once, so by default this times only the CDP/view steps. keychainDelayMs delays
// decryptStringAsync to imitate a slow or unanswered real Keychain call (a simulation, not a measurement of one).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const electron = require('electron');

if (typeof electron === 'string') {
  const { spawn } = require('node:child_process');
  const { hiddenEnv, watchdog } = require('./hidden-env.cjs');
  const { privateTmp } = require('./with-tmp.cjs');
  const http = require('node:http');
  const count = Number(process.argv[2]) || 20, delay = Number(process.argv[3]) || 0;
  const tmp = privateTmp({ strict: false });
  const profile = fs.mkdtempSync(path.join(tmp.dir, 'probe-'));
  const { env, binary } = hiddenEnv({ ...process.env, ...tmp.env, HERMES_WORKSPACE_DATA: profile, HERMES_PROBE_COOKIES: String(count), HERMES_PROBE_KEYCHAIN_DELAY_MS: String(delay) });
  delete env.ELECTRON_RUN_AS_NODE;
  let spawned = 0;
  const server = http.createServer((req, res) => { if (req.url === '/tab') console.log(`PROBE tab-request +${(performance.now() - spawned).toFixed(0)}ms`); res.end('<!doctype html><title>probe</title>'); });
  const run = phase => new Promise(resolve => {
    spawned = performance.now();
    const child = spawn(binary, [`--user-data-dir=${profile}`, __filename, phase], { env: { ...env, HERMES_WORKSPACE_PROFILE_BOOT: phase === 'boot' ? '1' : '' }, stdio: ['ignore', 'inherit', 'pipe'] });
    let aborted = '';
    const stop = watchdog(child, reason => { aborted = reason; console.error(`WATCHDOG ABORT: ${reason}`); });
    const deadline = setTimeout(() => { aborted ||= 'deadline'; try { process.kill(child.pid, 'SIGKILL'); } catch {} }, 60000);
    child.stderr.on('data', chunk => { for (const line of String(chunk).split('\n')) if (/\[boot-timing\]|PROBE|Error/.test(line)) console.log(line); });
    child.once('close', code => { clearTimeout(deadline); stop(); resolve({ code, aborted }); });
  });
  (async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    env.HERMES_PROBE_TAB = `http://127.0.0.1:${server.address().port}/tab`;
    let result = await run('seed');
    if (!result.code) result = await run('boot');
    console.log(`probe exit ${result.code}${result.aborted ? ` aborted: ${result.aborted}` : ' (watchdog did not fire)'}`);
  })().finally(() => { server.close(); fs.rmSync(profile, { recursive: true, force: true }); tmp.finish(); });
} else {
  const { app } = electron;
  const phase = process.argv.at(-1);
  app.commandLine.appendSwitch('use-mock-keychain');
  if (phase === 'seed') {
    app.whenReady().then(async () => {
      const count = Number(process.env.HERMES_PROBE_COOKIES);
      const cookie = (name, i) => ({ name: `${name}${i}`, value: 'x'.repeat(200), domain: 'probe.example', path: '/', secure: true, httpOnly: true, hostOnly: true, session: true, sameSite: 'lax', size: 210 });
      const records = { 'persist:browser': Array.from({ length: count }, (_, i) => cookie('b', i)), 'persist:telegram': Array.from({ length: count }, (_, i) => cookie('t', i)) };
      const sealed = (await electron.safeStorage.encryptStringAsync(JSON.stringify(records))).toString('base64');
      fs.writeFileSync(path.join(process.env.HERMES_WORKSPACE_DATA, 'preferences.json'), JSON.stringify({ onboarded: true, preview: false, sessionCookies: sealed, savedTabs: [{ url: process.env.HERMES_PROBE_TAB, botId: 'shared', owner: 'user' }] }));
      console.error('PROBE seeded');
      app.exit(0);
    });
  } else {
    require('./settings-fixture-boundaries.cjs')();
    const delay = Number(process.env.HERMES_PROBE_KEYCHAIN_DELAY_MS);
    if (delay) {
      const Module = require('node:module'), load = Module._load;
      Module._load = function(request, ...args) {
        const value = load.call(this, request, ...args);
        if (request !== 'electron') return value;
        const real = value.safeStorage;
        return { ...value, safeStorage: { isAsyncEncryptionAvailable: () => real.isAsyncEncryptionAvailable(), getSelectedStorageBackend: () => real.getSelectedStorageBackend(),
          encryptStringAsync: text => real.encryptStringAsync(text), decryptStringAsync: async buffer => { await new Promise(resolve => setTimeout(resolve, delay)); return real.decryptStringAsync(buffer); } } };
      };
    }
    const { prepareFixture, quitFixture } = require('./electron-fixture.cjs');
    prepareFixture(process.env.HERMES_WORKSPACE_DATA);
    require('../src/main.cjs');
    // Let ui-interactive and the boot tail print their marks, then quit.
    setTimeout(() => { console.error('PROBE done'); quitFixture(); }, 12000);
  }
}
