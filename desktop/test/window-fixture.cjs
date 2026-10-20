// Native window sizing for Electron fixtures. Logical browser viewport emulation
// and headless Chromium do not use the desktop work area.
const assert = require('node:assert/strict');
const { app, screen } = require('electron');

function workArea() {
  const display = screen.getPrimaryDisplay();
  const area = { ...display.workArea, ...display.workAreaSize };
  const cap = process.env.WORKSPACE_TEST_MAX_WORKAREA;
  if (cap) {
    assert.match(cap, /^[1-9]\d*x[1-9]\d*$/, 'WORKSPACE_TEST_MAX_WORKAREA must be WIDTHxHEIGHT');
    const [width, height] = cap.split('x').map(Number);
    area.width = Math.min(area.width, width);
    area.height = Math.min(area.height, height);
  }
  return area;
}

function fitWindow(win, width, height, { mode = 'content' } = {}) {
  assert.ok(['content', 'bounds'].includes(mode));
  assert.ok(Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0);
  const area = workArea();
  const before = win.getBounds(), content = win.getContentBounds();
  const frame = [before.width - content.width, before.height - content.height];
  const requested = [width, height];
  const outer = [Math.min(width + (mode === 'content' ? frame[0] : 0), area.width),
    Math.min(height + (mode === 'content' ? frame[1] : 0), area.height)];
  const effective = [outer[0] - frame[0], outer[1] - frame[1]];
  assert.ok(effective.every(n => n > 0), 'Work area must fit the native window frame');
  console.log('FIXTURE WINDOW:', JSON.stringify({ requested, mode, effective, outer, frame,
    workArea: area, cap: process.env.WORKSPACE_TEST_MAX_WORKAREA || null,
    clamped: requested.some((n, i) => n !== (mode === 'content' ? effective : outer)[i]) }));
  const minimum = win.getMinimumSize();
  win.setMinimumSize(0, 0);
  win.setBounds({ x: area.x, y: area.y, width: outer[0], height: outer[1] });
  const actual = win.getBounds();
  assert.deepEqual([actual.width, actual.height], outer, 'Fixture must reach its effective native bounds');
  assert.deepEqual(win.getContentSize(), effective, 'Fixture must reach its effective content size');
  win.setMinimumSize(Math.min(minimum[0], outer[0]), Math.min(minimum[1], outer[1]));
  return { width: effective[0], height: effective[1], outer, requested };
}

async function resizeWindow(win, width, height, options) {
  const size = fitWindow(win, width, height, options);
  const zoom = win.webContents.getZoomFactor();
  const expected = [Math.round(size.width / zoom), Math.round(size.height / zoom)];
  let actual;
  const deadline = Date.now() + 5000;
  do {
    actual = await win.webContents.executeJavaScript('[innerWidth, innerHeight]');
    if (actual[0] === expected[0] && actual[1] === expected[1]) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  assert.deepEqual(actual, expected, 'Renderer must reach the effective fixture viewport');
  return { ...size, width: expected[0], height: expected[1] };
}

// Cover initial windows too, including fixtures which never explicitly resize.
// Capture the real screen before a suite installs its service/focus facades.
app.on('browser-window-created', (_event, win) => {
  const { width, height } = win.getBounds();
  fitWindow(win, width, height, { mode: 'bounds' });
});
module.exports = { fitWindow, resizeWindow, workArea };
