const assert = require('node:assert/strict');
const { isDeepStrictEqual } = require('node:util');
const { clipboard, ClipboardItem } = require('electron');
const rewritten = type => type === 'text/html' || type.startsWith('image/') || /^electron application\/osclipboard;format="org\.w3\.web-custom-format\.(map|type-\d+)"$/.test(type);

async function captureClipboard() {
  const items = [], unavailable = [], derived = [];
  for (const item of await clipboard.read()) {
    const data = Object.create(null);
    for (const type of item.types) {
      // Chromium wraps HTML and decodes/re-encodes images on write. These
      // representations cannot be restored byte-for-byte through this API.
      // Web custom-format map/type slots are regenerated from the web MIME;
      // replaying those internal slots would also restore stale slot numbers.
      if (rewritten(type)) {
        unavailable.push({ type, reason: 'Electron rewrites this representation on write' });
        continue;
      }
      try {
        const value = await item.getType(type);
        // macOS exposes a semantic bookmark derived from its raw URL formats.
        // Writing that value too synthesizes extra WebURLsWithTitles formats.
        // Replay the captured raw formats and verify the derived value below.
        if (type === 'electron application/bookmark' && item.types.includes('electron application/osclipboard;format="public.url"'))
          derived.push({ index: items.length, type, value });
        else data[type] = value;
      }
      catch (error) { unavailable.push({ type, reason: error.message }); }
    }
    // An empty OS clipboard can still return a read-side item with no types.
    // The write-side ClipboardItem constructor rejects an empty payload map.
    if (Object.keys(data).length) items.push(new ClipboardItem(data));
  }
  if (unavailable.length) console.error('Clipboard fixture: unavailable formats', JSON.stringify(unavailable));
  return { items, unavailable, derived };
}

async function restoreClipboard(saved) {
  clipboard.clear();
  if (saved.items.length) await clipboard.write(saved.items);
  const restored = (await clipboard.read()).filter(item => item.types.length);
  // A raw OS alias can also make Chromium expose its derived HTML/image MIME.
  // Verify all saved representations, without treating that derived MIME as
  // another representation we promised to restore byte-for-byte.
  const unavailable = new Set(saved.unavailable.map(entry => entry.type));
  assert.deepEqual(restored.map((item, index) => item.types.filter(type => !rewritten(type) && !unavailable.has(type) && !saved.derived.some(entry => entry.index === index && entry.type === type))).filter(types => types.length), saved.items.map(item => item.types));
  for (let index = 0; index < saved.items.length; index++) {
    for (const type of saved.items[index].types) {
      const expected = await saved.items[index].getType(type);
      const actual = await restored[index].getType(type);
      // Never dump the user's clipboard payload into test output on failure.
      if (expected instanceof Blob) assert.ok(Buffer.from(await actual.arrayBuffer()).equals(Buffer.from(await expected.arrayBuffer())), `Clipboard bytes restored for ${type}`);
      else assert.ok(isDeepStrictEqual(actual, expected), `Clipboard value restored for ${type}`);
    }
  }
  for (const { index, type, value } of saved.derived) {
    assert.ok(isDeepStrictEqual(await restored[index].getType(type), value), `Derived clipboard value restored for ${type}`);
  }
  return restored.map(item => item.types);
}

module.exports = { captureClipboard, restoreClipboard };
