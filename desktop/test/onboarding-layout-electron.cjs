// Isolated renderer fixture: real HTML/CSS and wizard, no main-process services.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, session } = require('electron');
const profile = process.env.HERMES_TEST_PROFILE;
assert.ok(profile, 'run with node test/run-electron.cjs test/onboarding-layout-electron.cjs');
app.setPath('userData', profile);
app.setPath('sessionData', profile);

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({
    cancel: !details.url.startsWith('file:') || /\/(renderer|avatars)\.js$/.test(details.url),
  }));
  const win = new BrowserWindow({ show: false, width: 1024, height: 640, useContentSize: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  await win.loadFile(path.join(__dirname, '../src/index.html'));
  const renderer = fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8');
  await win.webContents.executeJavaScript(`
    window.workspace = { command: async () => 'Fixture prompt' };
    ${renderer.slice(0, renderer.indexOf('function orderedBots('))}
    ${renderer.slice(renderer.indexOf('let onboardingStep ='), renderer.indexOf('function rect('))}
    const copyReport = () => {};
    state = { platform: 'darwin', telegramStatus: 'offline', inApplications: true };
    document.getElementById('home').classList.add('hidden');
    renderOnboarding(true);
  `);
  for (const step of [1, 2, 3]) {
    const result = await win.webContents.executeJavaScript(`(() => {
      onboardingStep = ${step}; renderOnboarding(true);
      const panel = document.getElementById('onboarding');
      const buttons = [...panel.querySelectorAll('.onboarding-actions button')];
      return { width: innerWidth, buttons: buttons.map(button => {
        button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        const r = button.getBoundingClientRect();
        const p = panel.getBoundingClientRect();
        return { text: button.textContent, reachable: r.width > 0 && r.left >= 0 && r.right <= innerWidth
          && r.left >= p.left && r.right <= p.right && r.top >= p.top && r.bottom <= p.bottom
          && r.bottom <= innerHeight };
      }) };
    })()`);
    assert.equal(result.width, 1024);
    assert.ok(result.buttons.length > 0);
    for (const button of result.buttons) assert.ok(button.reachable, `Step ${step}: ${JSON.stringify(button)}`);
    console.log(`PASS: wizard step ${step} actions reachable at 1024×640`);
  }
  win.destroy();
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
