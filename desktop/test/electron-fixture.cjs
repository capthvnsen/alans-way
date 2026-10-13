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
  // Main's before-quit listener saves pending URLs first. Destroy the fixture
  // views afterwards: unload handlers and attached debuggers must not keep a
  // successful suite running until the CI step is killed.
  app.once('before-quit', () => {
    for (const contents of webContents.getAllWebContents()) {
      if (contents.isDestroyed()) continue;
      if (contents.debugger.isAttached()) contents.debugger.detach();
      contents.destroy();
    }
  });
  app.quit();
}

module.exports = { prepareFixture, quitFixture };
