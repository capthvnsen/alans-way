const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('workspace', {
  getState: () => ipcRenderer.invoke('workspace:get'),
  command: (name, value) => ipcRenderer.invoke('workspace:command', name, value),
  layout: (rects) => ipcRenderer.send('workspace:layout', rects),
  onState: (callback) => { ipcRenderer.on('workspace:state', (_event, state) => callback(state)); },
  onFocusAddress: (callback) => { ipcRenderer.on('workspace:focus-address', callback); },
  onSettings: (callback) => { ipcRenderer.on('workspace:settings', callback); },
  onFocusWorkspace: (callback) => { ipcRenderer.on('workspace:focus-workspace', callback); },
  onPointer: (callback) => { ipcRenderer.on('workspace:pointer', (_event, point) => callback(point)); },
});
