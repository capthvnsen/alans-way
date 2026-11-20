// Launched by hidden-env.cjs before any suite: proves the hidden mode took hold in this Electron, with no window created.
const { app, BrowserWindow, dialog } = require('electron');
const hidden = require('../src/hidden-mode.cjs');
const patched = /change/.test(BrowserWindow.prototype.show.toString()) && /canceled/.test(dialog.showMessageBox.toString());
const options = hidden.windowOptions({ show: true });
const ok = hidden.isHidden() && patched && options.show === false && BrowserWindow.getAllWindows().length === 0;
app.whenReady().then(() => { console.log(ok && (process.platform !== 'darwin' || !app.dock.isVisible()) ? 'HIDDEN-MODE-OK' : 'HIDDEN-MODE-MISSING'); app.exit(0); });
