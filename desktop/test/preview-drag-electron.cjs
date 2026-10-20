// The VM mini preview must drag with real window input: pointer capture on the
// title strip, the native remote view tracking the screen area, and the drop
// position persisted to preferences.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const electron = require('electron');
if (typeof electron === 'string') {
  const { spawnSync } = require('node:child_process');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-preview-drag-'));
  fs.writeFileSync(path.join(profile, 'preferences.json'), JSON.stringify({ onboarded: true, bots: [{ id: '123', name: 'Atlas fixture', isBot: true }], selectedBotId: '123' }));
  try {
    const result = spawnSync(electron, [__filename], { env: { ...process.env, HERMES_WORKSPACE_DATA: profile, HERMES_WORKSPACE_PORT: '0' }, stdio: 'inherit', timeout: 60000, killSignal: 'SIGKILL' });
    assert.equal(result.status, 0, result.error?.message || 'Preview drag test failed.');
  } finally { fs.rmSync(profile, { recursive: true, force: true }); }
} else {
  const { app, BrowserWindow, webContents } = electron;
  const { prepareFixture, quitFixture } = require('./electron-fixture.cjs');
  prepareFixture(process.env.HERMES_WORKSPACE_DATA);
  require('../src/main.cjs');
  const waitFor = async (read, predicate, label, timeout = 20000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { const value = await read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
    throw new Error(`Timed out: ${label}`);
  };
  const step = label => console.log(`[step] ${label}`);
  app.whenReady().then(async () => {
    const win = await waitFor(() => BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('index.html')), Boolean, 'workspace');
    const evaluate = code => win.webContents.executeJavaScript(code);
    await waitFor(() => evaluate('typeof window.workspace === "object"').catch(() => false), Boolean, 'preload');
    await waitFor(() => evaluate(`(() => { const r = document.getElementById('preview-chrome').getBoundingClientRect(); return r.width > 20 && r.height > 10 })()`), Boolean, 'visible preview chrome');
    const chrome = JSON.parse(await evaluate(`JSON.stringify(document.getElementById('preview-chrome').getBoundingClientRect())`));
    const slotBefore = JSON.parse(await evaluate(`JSON.stringify(document.getElementById('remote-preview-slot').getBoundingClientRect())`));
    // Grab the strip at a point clear of the buttons (grip area, left side).
    const startX = Math.round(chrome.x + 60), startY = Math.round(chrome.y + chrome.height / 2);
    step(`drag from ${startX},${startY}`);
    win.webContents.sendInputEvent({ type: 'mouseDown', x: startX, y: startY, button: 'left', clickCount: 1 });
    await new Promise(resolve => setTimeout(resolve, 40));
    for (let i = 1; i <= 8; i++) {
      win.webContents.sendInputEvent({ type: 'mouseMove', x: startX - i * 12, y: startY - i * 8, button: 'left', modifiers: ['leftbuttondown'], movementX: -12, movementY: -8 });
      await waitFor(() => evaluate(`JSON.stringify(document.getElementById('remote-preview-slot').getBoundingClientRect())`).then(JSON.parse),
        slot => Math.abs(slot.x - (slotBefore.x - i * 12)) <= 1 && Math.abs(slot.y - (slotBefore.y - i * 8)) <= 1,
        `strip move ${i} must follow the pointer`, 1000);
    }
    win.webContents.sendInputEvent({ type: 'mouseUp', x: startX - 96, y: startY - 64, button: 'left', clickCount: 1 });
    await waitFor(() => evaluate(`JSON.stringify(document.getElementById('remote-preview-slot').getBoundingClientRect())`).then(r => { const b = JSON.parse(r); return b.x !== slotBefore.x && b.y !== slotBefore.y; }), Boolean, 'preview moved after real drag');
    const slotAfter = JSON.parse(await evaluate(`JSON.stringify(document.getElementById('remote-preview-slot').getBoundingClientRect())`));
    step(`strip drag moved ${Math.round(slotAfter.x - slotBefore.x)},${Math.round(slotAfter.y - slotBefore.y)}`);
    const readPrefs = () => JSON.parse(fs.readFileSync(path.join(process.env.HERMES_WORKSPACE_DATA, 'preferences.json')));
    const prefs = await waitFor(readPrefs, value => Number.isFinite(value.previewPos?.x), 'persisted strip drag');
    // The streamed picture itself is a drag surface too — real input lands on
    // the native remote view, whose deltas are relayed back to the renderer.
    const remoteWc = await waitFor(() => webContents.getAllWebContents().find(item => item.getURL().endsWith('remote.html')), Boolean, 'remote view');
    const remoteView = win.contentView.children.find(view => view.webContents === remoteWc);
    const boundsBefore = remoteView.getBounds(), windowBounds = win.getContentBounds();
    const screen = JSON.parse(await evaluate(`JSON.stringify(document.getElementById('preview-screen').getBoundingClientRect())`));
    const sx = Math.round(screen.width / 2), sy = Math.round(screen.height / 2);
    step(`picture drag from ${sx},${sy} inside remote view`);
    remoteWc.sendInputEvent({ type: 'mouseDown', x: sx, y: sy, globalX: windowBounds.x + boundsBefore.x + sx, globalY: windowBounds.y + boundsBefore.y + sy, button: 'left', clickCount: 1 });
    await new Promise(resolve => setTimeout(resolve, 40));
    for (let i = 1; i <= 6; i++) {
      // Keep the physical pointer path fixed as the native view moves under it.
      const bounds = remoteView.getBounds();
      remoteWc.sendInputEvent({ type: 'mouseMove', x: boundsBefore.x + sx - i * 10 - bounds.x,
        y: boundsBefore.y + sy - i * 10 - bounds.y, globalX: windowBounds.x + boundsBefore.x + sx - i * 10,
        globalY: windowBounds.y + boundsBefore.y + sy - i * 10, button: 'left', modifiers: ['leftbuttondown'], movementX: -10, movementY: -10 });
      const slot = await waitFor(() => evaluate(`JSON.stringify(document.getElementById('remote-preview-slot').getBoundingClientRect())`).then(JSON.parse),
        box => Math.abs(box.x - (slotAfter.x - i * 10)) <= 1 && Math.abs(box.y - (slotAfter.y - i * 10)) <= 1,
        `picture move ${i} must follow the pointer`, 1000);
      await waitFor(() => remoteView.getBounds(), bounds => Math.abs(bounds.x - (boundsBefore.x - i * 10)) <= 1
        && Math.abs(bounds.y - (boundsBefore.y - i * 10)) <= 1, `native picture tracks move ${i}`, 1000);
      step(`picture move ${i}: ${Math.round(slot.x - slotAfter.x)},${Math.round(slot.y - slotAfter.y)}`);
    }
    const dropBounds = remoteView.getBounds();
    remoteWc.sendInputEvent({ type: 'mouseUp', x: boundsBefore.x + sx - 60 - dropBounds.x,
      y: boundsBefore.y + sy - 60 - dropBounds.y, globalX: windowBounds.x + boundsBefore.x + sx - 60,
      globalY: windowBounds.y + boundsBefore.y + sy - 60, button: 'left', clickCount: 1 });
    await waitFor(() => evaluate(`JSON.stringify(document.getElementById('remote-preview-slot').getBoundingClientRect())`).then(r => { const b = JSON.parse(r); return b.x < slotAfter.x - 30 && b.y < slotAfter.y - 30; }), Boolean, 'preview moved by dragging the remote picture');
    const prefs2 = await waitFor(readPrefs, value => value.previewPos.x < prefs.previewPos.x - 30 && value.previewPos.y < prefs.previewPos.y - 30, 'persisted picture drag');
    assert.equal(JSON.parse(await evaluate(`document.getElementById('remote-preview-slot').classList.contains('hidden')`)), false, 'preview stays visible');
    console.log(`PASS: real-input drag moves the VM preview by its strip AND its picture; drop persists at ${prefs2.previewPos.x},${prefs2.previewPos.y}.`);
    quitFixture();
  }).catch(error => { console.error(error.stack || error); app.exit(1); });
}
