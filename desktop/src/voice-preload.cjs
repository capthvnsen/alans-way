// Thin bridge between the hidden voice view and main. The view gets no Node —
// only an event emitter down to main and a control channel back up.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('voiceBridge', {
  emit: (event) => ipcRenderer.send('voice:event', event),
  onControl: (callback) => { ipcRenderer.on('voice:control', (_event, message) => callback(message)); },
});
