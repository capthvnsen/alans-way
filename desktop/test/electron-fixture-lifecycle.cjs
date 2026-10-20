const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

test('fixture quit destroys debugger views even when a page refuses unload', { timeout: 80000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-fixture-quit-'));
  const profile = path.join(dir, 'profile');
  fs.mkdirSync(profile);
  const script = path.join(dir, 'fixture.cjs');
  fs.writeFileSync(script, `
    const { app, BrowserWindow } = require('electron');
    const { prepareFixture, quitFixture } = require(${JSON.stringify(path.join(__dirname, 'electron-fixture.cjs'))});
    prepareFixture(${JSON.stringify(profile)});
    app.whenReady().then(async () => {
      const win = new BrowserWindow({ show: false });
      await win.loadURL('data:text/html,<button>fixture</button>');
      win.webContents.debugger.attach('1.3');
      await win.webContents.executeJavaScript('window.onbeforeunload = () => false; true', true);
      quitFixture();
    }).catch(error => { console.error(error); app.exit(1); });
  `);
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(require('electron'), [script], { stdio: ['ignore', 'inherit', 'pipe'] });
      let stderr = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), 70000);
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stderr }); });
    });
    assert.equal(result.code, 0, JSON.stringify(result));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
