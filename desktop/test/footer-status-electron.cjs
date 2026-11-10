const { resizeWindow } = require('./window-fixture.cjs');
const assert = require('node:assert/strict');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const profile = process.env.HERMES_TEST_PROFILE;
assert.ok(profile, 'run with node test/run-electron.cjs test/footer-status-electron.cjs');
app.setPath('userData', profile);
app.setPath('sessionData', profile);

const measure = `(() => {
  const box = (id) => {
    const el = document.getElementById(id);
    const style = getComputedStyle(el);
    return { id, display: style.display, w: el.getBoundingClientRect().width, overflow: el.scrollWidth - el.clientWidth };
  };
  return {
    width: innerWidth,
    footer: Math.round(document.querySelector('.workspace-footer').getBoundingClientRect().width),
    version: box('version-label'),
    status: box('workspace-status'),
    connection: box('connection-status'),
    more: box('status-more'),
    shortcuts: box('shortcuts-button'),
  };
})()`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1550, height: 980, useContentSize: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  await win.loadFile(path.join(__dirname, '../src/index.html'));
  await win.webContents.executeJavaScript(`document.getElementById('version-label').textContent = 'Alan’s Workspace 0.21.14'; document.getElementById('workspace-status').textContent = 'You in control · Mac'; document.getElementById('connection-status').textContent = 'Browser connector ready';`);
  await resizeWindow(win, 1550, 980);
  const wide = await win.webContents.executeJavaScript(measure);
  assert.notEqual(wide.status.display, 'none', JSON.stringify(wide));
  assert.notEqual(wide.connection.display, 'none', JSON.stringify(wide));
  assert.equal(wide.status.overflow, 0, JSON.stringify(wide));
  console.log('PASS: wide footer keeps both status lines', JSON.stringify(wide));

  await resizeWindow(win, 1120, 680);
  const narrow = await win.webContents.executeJavaScript(measure);
  assert.equal(narrow.status.display, 'none', JSON.stringify(narrow));
  assert.equal(narrow.connection.display, 'none', JSON.stringify(narrow));
  assert.notEqual(narrow.more.display, 'none', JSON.stringify(narrow));
  assert.ok(narrow.more.w >= 16, JSON.stringify(narrow));
  assert.notEqual(narrow.shortcuts.display, 'none', JSON.stringify(narrow));
  assert.equal(narrow.version.overflow, 0, JSON.stringify(narrow));
  console.log('PASS: minimum window hides clipped status and keeps the version readable', JSON.stringify(narrow));
  app.exit(0);
});
