// Standalone smoke test for the voice view — run with `npm run test:voice`.
// Boots a hidden window, loads voice-app://, and checks the full chain:
// protocol → page bundle → preload bridge → worker → model download start.
// A real call still needs a signed-in Telegram; this proves the voice engine
// itself loads and its IPC bridge works. Times out at TIMEOUT ms.
const path = require('node:path');
const { app, BrowserWindow, WebContentsView, ipcMain, systemPreferences } = require('electron');
const { registerVoiceScheme, installVoiceProtocol, VOICE_PARTITION, VOICE_URL } = require('../src/voice-protocol.cjs');

registerVoiceScheme();
app.setPath('userData', process.env.HERMES_WORKSPACE_DATA || path.join(require('node:os').tmpdir(), 'hw-voice-smoke'));

const TIMEOUT = 240000;
const seen = [];
let failed = false;

app.whenReady().then(async () => {
  installVoiceProtocol();
  if (process.platform === 'darwin') {
    const mic = await systemPreferences.askForMediaAccess('microphone').catch(() => false);
    console.log('[smoke] mic permission:', mic ? 'granted' : 'DENIED');
  }
  const host = new BrowserWindow({ show: false, width: 400, height: 300, webPreferences: { sandbox: true } });
  const view = new WebContentsView({ webPreferences: {
    preload: path.join(__dirname, '../src/voice-preload.bundle.cjs'),
    partition: VOICE_PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true,
  } });
  host.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 1, height: 1 });
  view.webContents.on('console-message', (_e, _level, message) => console.log('[page]', message));
  ipcMain.on('voice:event', (event, value) => {
    if (event.sender !== view.webContents) return;
    seen.push(value.type);
    if (value.type === 'progress') console.log('[progress]', value.stage, value.detail?.file || '', value.detail?.progress != null ? `${Math.round(value.detail.progress)}%` : value.detail?.status);
    else console.log('[event]', value.type, value.message || '');
    if (value.type === 'view-ready') view.webContents.send('voice:control', { type: 'init' });
    if (value.type === 'error') { failed = true; console.error('[smoke] FAILED:', value.message); app.exit(1); }
    if (value.type === 'ready') { console.log('[smoke] PASS — voice engine loaded (events:', seen.join(' → '), ')'); app.exit(0); }
  });
  console.log('[smoke] loading', VOICE_URL);
  view.webContents.loadURL(VOICE_URL).catch((e) => { console.error('[smoke] loadURL failed:', e.message); app.exit(1); });
  setTimeout(() => { console.error('[smoke] TIMEOUT — last events:', seen.join(' → ') || '(none)'); app.exit(1); }, TIMEOUT).unref();
});
