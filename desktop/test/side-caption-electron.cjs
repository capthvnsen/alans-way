const { resizeWindow } = require('./window-fixture.cjs');
const assert = require('node:assert/strict');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const profile = process.env.HERMES_TEST_PROFILE;
assert.ok(profile, 'run with node test/run-electron.cjs test/side-caption-electron.cjs');
app.setPath('userData', profile);
app.setPath('sessionData', profile);

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1120, height: 680, useContentSize: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  await win.loadFile(path.join(__dirname, '../src/index.html'));
  for (const [width, height] of [[1120, 680], [1550, 980]]) {
    await resizeWindow(win, width, height);
    const rows = await win.webContents.executeJavaScript(`(() => [...document.querySelectorAll('.side-caption')].map((caption) => {
      const label = caption.querySelector(':scope > span');
      const actions = caption.querySelector('.caption-actions');
      const cr = caption.getBoundingClientRect();
      const lr = label.getBoundingClientRect();
      const ar = actions.getBoundingClientRect();
      return { label: label.textContent.trim(), labelH: Math.round(lr.height), labelRight: lr.right, actionsRight: ar.right, captionRight: cr.right, overflow: caption.scrollWidth - caption.clientWidth };
    }))()`);
    for (const row of rows) {
      assert.ok(row.labelH > 0 && row.labelH <= 16, `${width}: ${row.label} should stay on one line ${JSON.stringify(row)}`);
      assert.ok(row.actionsRight <= row.captionRight + 1, `${width}: ${row.label} actions overflow ${JSON.stringify(row)}`);
      assert.ok(row.labelRight <= row.captionRight + 1, `${width}: ${row.label} label overflow ${JSON.stringify(row)}`);
      assert.ok(row.overflow <= 1, `${width}: ${row.label} caption overflow ${JSON.stringify(row)}`);
      console.log(`PASS: ${row.label} stays one line at ${width}×${height}`);
    }
  }
  app.exit(0);
});
