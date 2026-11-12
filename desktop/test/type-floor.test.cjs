// No text under 11px in the Canvas, Settings, dialogs, footer or Bot screen. The chat pane and the bots list
// (other owners) and the extension icon badge are left out.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const outside = /\.(nc-|hermes-|bot-|side-|presence|chat-|sidebar|empty-bots|sort-menu|search-|native-pane|primary-badge)|#(bot-|hermes|native-pane|chat-|presence|sort-|search-|telegram|native-extension-actions)/;

for (const file of ['style.css', 'remote.css']) {
  test(`${file}: text is at least 11px outside the chat pane and bots list`, () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const small = [];
    for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const size = body.match(/font-size:\s*([\d.]+)px/) || body.match(/(?:^|;)\s*font:[^;]*?([\d.]+)px/);
      if (size && Number(size[1]) < 11 && !outside.test(selector)) small.push(`${selector.trim()} ${size[1]}px`);
    }
    assert.deepEqual(small, []);
  });
}
