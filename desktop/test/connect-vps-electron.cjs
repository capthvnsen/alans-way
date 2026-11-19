const assert = require('node:assert/strict');
const { app, BrowserWindow, webContents } = require('electron');
const { prepareFixture, quitFixture } = require('./electron-fixture.cjs');
const profile = process.env.HERMES_TEST_PROFILE;
assert.ok(profile, 'run with node test/run-electron.cjs test/connect-vps-electron.cjs');
prepareFixture(profile);
require('../src/main.cjs');

const pause = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  try {
  let win;
  for (let i = 0; i < 80 && !win; i++) {
    win = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().endsWith('/index.html'));
    if (!win) await pause(100);
  }
  assert.ok(win, 'workspace window did not open');
  for (let i = 0; i < 50; i++) {
    const ready = await win.webContents.executeJavaScript(`document.getElementById('version-label').textContent.length > 0`);
    if (ready) break;
    await pause(100);
  }
  const guest = webContents.getAllWebContents().find((item) => item.getURL().endsWith('/remote.html'));
  assert.ok(guest, 'VM viewer did not load');
  for (let i = 0; i < 50; i++) {
    const ready = await guest.executeJavaScript(`document.getElementById('remote-hint').textContent.includes('Take control')`);
    if (ready) break;
    await pause(100);
  }
  const configure = await guest.executeJavaScript(`document.getElementById('configure').textContent`);
  assert.equal(configure, 'Connect VPS');
  await guest.executeJavaScript(`document.getElementById('configure').click()`);
  let opened;
  for (let i = 0; i < 40; i++) {
    opened = await win.webContents.executeJavaScript(`(() => {
      const section = document.querySelector('[data-settings-section="remote-desktop"]');
      const general = document.querySelector('[data-settings-section="keyboard"]');
      return {
        open: !document.getElementById('modal').classList.contains('hidden'),
        remoteHidden: section ? section.hidden : null,
        generalHidden: general ? general.hidden : null,
        title: document.getElementById('settings-content-title')?.textContent || '',
        heading: section?.querySelector('h3')?.textContent || '',
      };
    })()`);
    if (opened.open && opened.remoteHidden === false) break;
    await pause(50);
  }
  assert.equal(opened.open, true, JSON.stringify(opened));
  assert.equal(opened.title, 'Connections', JSON.stringify(opened));
  assert.equal(opened.remoteHidden, false, JSON.stringify(opened));
  assert.equal(opened.generalHidden, true, JSON.stringify(opened));
  assert.match(opened.heading, /Remote desktop/, JSON.stringify(opened));
  console.log('PASS: Connect VPS opens Remote desktop settings');
  quitFixture();
  } catch (error) {
    console.error(error);
    quitFixture();
    app.exit(1);
  }
});
