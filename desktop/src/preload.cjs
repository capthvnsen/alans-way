const { contextBridge, ipcRenderer } = require('electron');
const { shortcutReference } = require('./workspace-shortcuts.cjs');
const { injectBrowserAction } = require('electron-chrome-extensions/browser-action');
if (location.protocol === 'file:' && location.pathname.endsWith('/index.html')) injectBrowserAction();
contextBridge.exposeInMainWorld('workspace', {
  shortcuts: shortcutReference(process.platform),
  getState: () => ipcRenderer.invoke('workspace:get'),
  command: (name, value) => ipcRenderer.invoke('workspace:command', name, value),
  layout: (rects) => ipcRenderer.send('workspace:layout', rects),
  onState: (callback) => { ipcRenderer.on('workspace:state', (_event, state) => callback(state)); },
  onFocusAddress: (callback) => { ipcRenderer.on('workspace:focus-address', callback); },
  onSettings: (callback) => { ipcRenderer.on('workspace:settings', callback); },
  onShortcuts: (callback) => { ipcRenderer.on('workspace:shortcuts', callback); },
  onFocusWorkspace: (callback) => { ipcRenderer.on('workspace:focus-workspace', callback); },
  onPointer: (callback) => { ipcRenderer.on('workspace:pointer', (_event, point) => callback(point)); },
  onRemoteShortcut: (callback) => { ipcRenderer.on('workspace:remote-shortcut', (_event, value) => callback(value)); },
  onRemoteRetry: (callback) => { ipcRenderer.on('workspace:remote-retry', callback); },
  onPreviewNudge: (callback) => { ipcRenderer.on('workspace:preview-nudge', (_event, value) => callback(value)); },
  onPreviewDrop: (callback) => { ipcRenderer.on('workspace:preview-drop', callback); },
  onCloudLog: (callback) => { ipcRenderer.on('workspace:cloud-log', (_event, text) => callback(text)); },
});
// Canvas Terminal: four calls in, two events out. Only the Workspace page is served; the VM view is refused in main.
contextBridge.exposeInMainWorld('terminal', {
  start: (id, cols, rows) => ipcRenderer.invoke('terminal:start', id, cols, rows),
  input: (id, data) => ipcRenderer.send('terminal:input', id, data),
  resize: (id, cols, rows) => ipcRenderer.send('terminal:resize', id, cols, rows),
  kill: (id) => ipcRenderer.send('terminal:kill', id),
  onData: (callback) => { ipcRenderer.on('terminal:data', (_event, id, data) => callback(id, data)); },
  onExit: (callback) => { ipcRenderer.on('terminal:exit', (_event, id) => callback(id)); },
});
// Native Hermes chat: state + allowlisted commands only. No credentials,
// sockets, or arbitrary RPC names cross this bridge.
contextBridge.exposeInMainWorld('hermes', {
  getState: () => ipcRenderer.invoke('hermes:get'),
  command: (name, value) => ipcRenderer.invoke('hermes:command', name, value),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('hermes:state', listener);
    return () => { ipcRenderer.removeListener('hermes:state', listener); };
  },
});
// Alan's native chat: display state + the controller's allowlisted commands. The API key never crosses.
contextBridge.exposeInMainWorld('nativeChat', {
  getState: () => ipcRenderer.invoke('native:get'),
  command: (name, value) => ipcRenderer.invoke('native:command', name, value),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('native:state', listener);
    return () => { ipcRenderer.removeListener('native:state', listener); };
  },
});
