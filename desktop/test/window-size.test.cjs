const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Stop at the native window boundary: no app startup, profiles or connections.
function windowOptions(workAreaSize) {
  const source = fs.readFileSync(path.join(__dirname, '../src/main.cjs'), 'utf8');
  const createWindow = source.slice(source.indexOf('function createWindow() {'), source.indexOf('\nif (!app.requestSingleInstanceLock())'));
  let options;
  const captured = new Error('window options captured');
  assert.throws(() => vm.runInNewContext(`${createWindow}; createWindow();`, {
    nativeTheme: {}, screen: { getPrimaryDisplay: () => ({ workAreaSize }) },
    BrowserWindow: class { constructor(value) { options = value; throw captured; } },
    app: { getName: () => 'Fixture' }, process: { platform: 'darwin' }, path, ROOT: '/fixture',
  }), error => error === captured);
  return [options.width, options.height, options.minWidth, options.minHeight];
}

test('the first window and its minimum fit a 1024-point primary work area', () => {
  assert.deepEqual(windowOptions({ width: 1024, height: 640 }), [1024, 640, 1024, 640]);
});

test('normal displays keep the existing initial and minimum window sizes', () => {
  assert.deepEqual(windowOptions({ width: 1920, height: 1080 }), [1550, 980, 1120, 680]);
});
