const test = require('node:test');
const assert = require('node:assert/strict');
const { screenshotClip } = require('../src/cdp.cjs');

test('cropping uses viewport CSS coordinates after scrolling and scales only the region', () => {
  const viewport = { width: 1000, height: 800, pageLeft: 50, pageTop: 3000, deviceScaleFactor: 2 };
  const crop = { x: 100, y: 200, width: 400, height: 300 };
  assert.deepEqual(screenshotClip(viewport, JSON.stringify(crop), 200), {
    crop, clip: { x: 150, y: 3200, width: 400, height: 300, scale: 0.5 },
  });
  assert.deepEqual(screenshotClip(viewport, null, 960).clip, { x: 50, y: 3000, width: 1000, height: 800, scale: 0.96 });
});

test('crop rejects malformed, empty, negative, non-finite and out-of-viewport rectangles', () => {
  const viewport = { width: 1000, height: 800 };
  for (const crop of ['bad', 'null', '[]', '{}', '{"x":0,"y":0,"width":0,"height":1}', '{"x":-1,"y":0,"width":1,"height":1}', '{"x":0,"y":0,"width":1e400,"height":1}', '{"x":999,"y":0,"width":2,"height":1}']) {
    assert.throws(() => screenshotClip(viewport, crop, 960), error => error.status === 400, crop);
  }
});

test('the app capture path returns the same crop and viewport used for capture', async () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require('node:path').join(__dirname, '../src/main.cjs'), 'utf8');
  const viewport = { width: 1000, height: 800, pageLeft: 50, pageTop: 3000, deviceScaleFactor: 2 };
  const crop = { x: 100, y: 200, width: 400, height: 300 };
  const commands = [], host = {};
  const captureTab = require('node:vm').runInNewContext(source.slice(source.indexOf('async function captureTab('), source.indexOf('const EMPTY_EFFECT')) + '\ncaptureTab;', {
    backgroundCaptureQueue: Promise.resolve(), win: host, screenshotClip,
    boundedJs: async () => viewport,
    browserCommand: async (_tab, method, params) => { commands.push({ method, params }); return { data: 'fixture-image' }; },
  });
  const tab = { host, view: { webContents: { capturePage: () => { throw new Error('A crop must be captured directly.'); } } } };
  const shot = await captureTab(tab, { format: 'jpeg', maxWidth: 200, quality: 50, crop: JSON.stringify(crop) });
  assert.equal(shot.base64, 'fixture-image');
  assert.deepEqual(shot.viewport, viewport);
  assert.deepEqual(shot.crop, crop);
  assert.equal(commands[0].method, 'Page.captureScreenshot');
  assert.deepEqual(commands[0].params.clip, { x: 150, y: 3200, width: 400, height: 300, scale: 0.5 });
});
