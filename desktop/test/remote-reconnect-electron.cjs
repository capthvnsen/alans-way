'use strict';
// Real noVNC and WebSocket faults, hidden window, disposable profile, loopback only.
// Run: node test/run-electron.cjs test/remote-reconnect-electron.cjs
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, session } = require('electron');

const profile = process.env.HERMES_TEST_PROFILE;
assert.ok(profile, 'Use run-electron.cjs for an isolated profile');
app.setPath('userData', profile); app.setPath('sessionData', profile);
app.disableHardwareAcceleration(); app.commandLine.appendSwitch('use-mock-keychain');
const sockets = new Set(), statuses = [];
let upgrades = 0, win;
const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
server.on('upgrade', (req, socket) => {
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
  // First connection stalls during negotiation; the second loses its network.
  if (++upgrades === 2) setTimeout(() => socket.destroy(), 100);
});
const until = async (predicate, ms) => {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'Timed out waiting for viewer recovery: ' + JSON.stringify({ upgrades, statuses }));
    await new Promise(resolve => setTimeout(resolve, 40));
  }
};
app.whenReady().then(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({
    cancel: /^(https?|wss?):/.test(details.url) && new URL(details.url).hostname !== '127.0.0.1',
  }));
  const remoteUrl = `http://127.0.0.1:${server.address().port}/`;
  const preload = path.join(profile, 'viewer-preload.cjs');
  fs.writeFileSync(preload, `const {contextBridge,ipcRenderer}=require('electron');
    contextBridge.exposeInMainWorld('workspace',{
      getState:async()=>({remoteUrl:${JSON.stringify(remoteUrl)},remoteControl:false}),onState(){},onRemoteRetry(){},
      command:async(name,value)=>ipcRenderer.send('viewer-command',name,value)
    });`);
  ipcMain.on('viewer-command', (_event, name, value) => { if (name === 'remote-status') statuses.push(value.status); });
  win = new BrowserWindow({ show: false, webPreferences: { preload, contextIsolation: true, sandbox: false } });
  await win.loadFile(path.join(__dirname, '../src/remote.html'));
  await until(() => upgrades >= 3, 24000);
  assert.ok(statuses.includes('reconnecting'), 'an actual lost WebSocket enters retry mode');
  assert.equal(await win.webContents.executeJavaScript('document.getElementById("control").disabled'), true);
  assert.ok(statuses.filter(status => status === 'connecting').length >= 3);
  console.log('PASS: real noVNC recovers from a silent handshake and dropped WebSocket without enabling control.');
}).catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  win?.destroy(); for (const socket of sockets) socket.destroy(); server.close(); app.exit(process.exitCode || 0);
});
