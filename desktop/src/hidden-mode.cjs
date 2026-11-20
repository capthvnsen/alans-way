// Opt-in for agents that cannot look at the screen: with HERMES_WORKSPACE_TEST_HIDDEN=1 the app under test never shows
// a window, takes focus, bounces the Dock, opens a native dialog, banner or external app, yet still lays out and paints.
// Inert unless the app is unpackaged; with the variable unset the product only passes its window options through.
const Module = require('node:module');

let electron = null, hidden = false;
// Preloaded with NODE_OPTIONS, `electron` is not resolvable yet (it is just the npm package's path), so a preload waits
// for the app's own first require of it; main.cjs requires this file directly and installs at once.
function install(candidate) {
  if (electron || typeof candidate !== 'object' || !candidate?.app) return;
  electron = candidate;
  hidden = !electron.app.isPackaged && process.env.HERMES_WORKSPACE_TEST_HIDDEN === '1';
  if (hidden) installHidden();
}
function start() {
  if (!process.versions.electron) return;
  // Early on there is no main script yet, and resolving `electron` now would cache the npm package's path over the real
  // module for every later require, so wait for the app's own first require instead.
  if (require.main) return install(require('electron'));
  const load = Module._load;
  Module._load = function (request) {
    const exports = load.apply(this, arguments);
    if (!electron && request === 'electron') install(exports);
    return exports;
  };
}

const states = new WeakMap();
const stateOf = win => states.get(win) || states.set(win, { visible: false, focused: false, minimized: false }).get(win);

// Painting is kept alive without a screen; windows start hidden whatever the caller asked for.
const windowOptions = options => hidden ? { ...options, show: false, paintWhenInitiallyHidden: true,
  webPreferences: { ...options.webPreferences, backgroundThrottling: false } } : options;

// The one place the product creates a BrowserWindow. A hidden window still answers "am I on screen?" as a shown one would,
// because product code and tests branch on it; that bookkeeping never shows or focuses anything natively.
function newWindow(options) {
  const win = new electron.BrowserWindow(windowOptions(options));
  if (hidden && options.show !== false) Object.assign(stateOf(win), { visible: true, focused: options.focusable !== false });
  return win;
}

function simulateWindows() {
  const proto = electron.BrowserWindow.prototype;
  const transition = (name, change, events) => { proto[name] = function () { change(stateOf(this)); for (const event of events) this.emit(event); }; };
  transition('show', s => { s.visible = true; s.minimized = false; s.focused = true; }, ['show', 'focus']);
  transition('showInactive', s => { s.visible = true; s.minimized = false; }, ['show']);
  transition('hide', s => { s.visible = false; s.focused = false; }, ['hide']);
  transition('focus', s => { if (s.visible) s.focused = true; }, ['focus']);
  transition('blur', s => { s.focused = false; }, ['blur']);
  transition('minimize', s => { s.minimized = true; s.focused = false; }, ['minimize']);
  transition('restore', s => { s.minimized = false; s.visible = true; }, ['restore']);
  for (const name of ['moveTop', 'maximize', 'unmaximize', 'setFullScreen', 'setSimpleFullScreen']) proto[name] = () => {};
  proto.isVisible = function () { return stateOf(this).visible; };
  proto.isFocused = function () { return stateOf(this).focused; };
  proto.isMinimized = function () { return stateOf(this).minimized; };
}

function silenceNativeUi() {
  const { app, dialog, shell, Notification, systemPreferences } = electron;
  for (const name of ['showMessageBox', 'showOpenDialog', 'showSaveDialog']) {
    dialog[name] = async () => ({ response: 0, checkboxChecked: false, canceled: true, filePaths: [], filePath: '' });
    dialog[`${name}Sync`] = () => (name === 'showMessageBox' ? 0 : undefined);
  }
  dialog.showErrorBox = () => {};
  shell.openExternal = async () => {};
  shell.openPath = async () => '';
  shell.showItemInFolder = () => {};
  Notification.prototype.show = () => {};
  if (process.platform === 'darwin') {
    systemPreferences.isTrustedAccessibilityClient = () => false;
    systemPreferences.askForMediaAccess = async () => false;
  }
  app.focus = () => {};
  app.setAsDefaultProtocolClient = app.removeAsDefaultProtocolClient = () => false; // a system-wide setting, not ours to change
  if (app.dock) for (const name of ['bounce', 'show', 'setBadge']) app.dock[name] = () => {};
}

function installHidden() {
  const { app } = electron;
  const proto = electron.BrowserWindow.prototype, nativeVisible = proto.isVisible, nativeHide = proto.hide;
  if (process.platform === 'darwin') { app.dock?.hide(); app.setActivationPolicy('accessory'); }
  app.commandLine.appendSwitch('use-mock-keychain'); // a Keychain prompt is a window too
  simulateWindows();
  silenceNativeUi();
  // Last line of defence: if anything natively shows a window despite the above, hide it and fail loudly.
  app.on('browser-window-created', (_event, win) => {
    const guard = setInterval(() => {
      if (win.isDestroyed()) return clearInterval(guard);
      if (nativeVisible.call(win)) { nativeHide.call(win); console.error('HIDDEN MODE VIOLATION: a window became visible.'); app.exit(70); }
    }, 100);
    guard.unref();
  });
}

start();
module.exports = { isHidden: () => hidden, windowOptions, newWindow };
