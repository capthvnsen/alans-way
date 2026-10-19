// Install before loading real main. Saved fixture addresses must never launch
// SSH, services, external network requests, shell actions or native permissions.
module.exports = function settingsFixtureBoundaries() {
  const electron = require('electron');
  const { app, BrowserWindow, session } = electron;
  const blocked = [];
  const refuse = name => (...args) => {
    blocked.push({ boundary: name, target: String(args[0] || '') });
    throw Error(`Settings fixture forbids ${name}.`);
  };
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  app.focus = () => { blocked.push({ boundary: 'app.focus' }); };
  app.on('web-contents-created', (_event, contents) => {
    contents.focus = () => { blocked.push({ boundary: 'webContents.focus' }); };
  });
  const Module = require('node:module'), load = Module._load;
  const facade = { ...electron, BrowserWindow: new Proxy(BrowserWindow, {
    construct(Constructor, args) {
      const win = new Constructor({ ...args[0], show: false, focusable: false });
      win.focus = () => { blocked.push({ boundary: 'window.focus' }); };
      win.show = () => win.showInactive();
      return win;
    },
  }) };
  Module._load = function(request, ...args) {
    return request === 'electron' ? facade : load.call(this, request, ...args);
  };
  const cp = require('node:child_process');
  for (const name of ['spawn', 'fork', 'exec', 'execFile', 'execFileSync', 'spawnSync', 'execSync']) cp[name] = refuse(`child_process.${name}`);
  for (const name of ['openExternal', 'openPath', 'showItemInFolder', 'trashItem']) electron.shell[name] = refuse(`shell.${name}`);
  for (const name of ['askForMediaAccess', 'isTrustedAccessibilityClient', 'getMediaAccessStatus']) electron.systemPreferences[name] = refuse(`systemPreferences.${name}`);
  const https = require('node:https');
  https.get = refuse('https.get'); https.request = refuse('https.request');
  const http = require('node:http');
  for (const name of ['get', 'request']) {
    const original = http[name];
    http[name] = (target, ...args) => {
      const hostname = typeof target === 'string' || target instanceof URL
        ? new URL(target).hostname
        : target?.hostname || target?.host || 'localhost';
      if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostname)) return refuse(`http.${name}`)(hostname);
      return original.call(http, target, ...args);
    };
  }
  electron.net.request = refuse('net.request'); electron.net.fetch = refuse('net.fetch');
  electron.net.isOnline = () => false;
  const local = url => /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(String(url));
  const fetch = global.fetch;
  global.fetch = (url, ...args) => local(url) ? fetch(url, ...args) : Promise.reject(Error('Settings fixture forbids external fetch.'));
  app.whenReady().then(() => {
    for (const partition of [undefined, 'persist:browser', 'persist:telegram']) {
      const current = partition ? session.fromPartition(partition) : session.defaultSession;
      const register = current.webRequest.onBeforeRequest.bind(current.webRequest);
      const guard = callback => (details, done) => {
        if (/^(https?|wss?):/.test(details.url) && !local(details.url)) {
          blocked.push({ boundary: 'webRequest', target: details.url }); return done({ cancel: true });
        }
        return callback ? callback(details, done) : done({});
      };
      current.webRequest.onBeforeRequest = (...args) => register(guard(typeof args.at(-1) === 'function' ? args.at(-1) : null));
      register(guard(null));
    }
  });
  return blocked;
};
