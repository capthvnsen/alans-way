require('./window-fixture.cjs');
const { app, session, webContents } = require('electron');

function prepareFixture(profile) {
  process.env.HERMES_WORKSPACE_DATA = profile;
  process.env.HERMES_WORKSPACE_PORT = '0';
  app.setPath('userData', profile);
  app.setPath('sessionData', profile);
  app.setAsDefaultProtocolClient = () => false;
  app.whenReady().then(() => {
    session.fromPartition('persist:telegram').protocol.handle('https', () =>
      new Response('<!doctype html><title>Telegram fixture</title>', { headers: { 'Content-Type': 'text/html' } }));
  });
  const deadline = setTimeout(() => { console.error('Electron fixture exceeded its 150s deadline.'); app.exit(1); }, 150000);
  deadline.unref();
}

function quitFixture(...servers) {
  for (const server of servers) { server?.closeAllConnections(); server?.close(); }
  const deadline = setTimeout(() => { console.error('Electron fixture did not finish teardown within 10s.'); app.exit(1); }, 10000);
  deadline.unref();
  // Main defers quit while saving browser sessions; keep its views alive until
  // that drain finishes, then destroy unload handlers and attached debuggers.
  const destroyViews = event => {
    if (event.defaultPrevented) return;
    app.removeListener('before-quit', destroyViews);
    for (const contents of webContents.getAllWebContents()) {
      if (contents.isDestroyed()) continue;
      if (contents.debugger.isAttached()) contents.debugger.detach();
      contents.destroy();
    }
  };
  app.on('before-quit', destroyViews);
  app.quit();
}

module.exports = { prepareFixture, quitFixture };
