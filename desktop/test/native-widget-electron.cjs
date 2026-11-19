// Run: npm run test:native-widget
// Renderer-only fixture: the real index.html, style.css, native-chat.js and native-widget.html. A chat widget's frame is sized to its
// content between a minimum and a maximum, and only a bounded number from that frame's own window can change it.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, session } = require('electron');
const profile = process.env.HERMES_TEST_PROFILE;
assert.ok(profile, 'run with npm run test:native-widget');
app.setPath('userData', profile);
app.setPath('sessionData', profile);

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') || /\/renderer\.js$/.test(details.url) }));
  const win = new BrowserWindow({ show: false, width: 700, height: 1400, useContentSize: true, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  await win.loadFile(path.join(__dirname, '../src/index.html'));
  const js = code => win.webContents.executeJavaScript(code);
  const until = async (read, why, ms = 8000) => { const end = Date.now() + ms; for (;;) { const value = await read(); if (value) return value; if (Date.now() > end) throw new Error(`Timed out: ${why}`); await new Promise(resolve => setTimeout(resolve, 40)); } };
  const heights = () => js(`[...document.querySelectorAll('#fixture iframe')].map(f => f.getBoundingClientRect().height)`);
  const bogus = (value) => `<p>tiny</p><script>setTimeout(() => parent.postMessage({ type: 'nc-widget-height', height: ${value} }, '*'), 400)</script>`;
  await js(`(() => {
    document.body.innerHTML = '<div id="fixture" style="position:fixed;inset:0;width:420px;overflow:auto;background:#09090a"></div>';
    const add = (source) => document.getElementById('fixture').append(NativeChat.widgetElement(source));
    add('<p>One line.</p>');
    add('<div style="height:2000px">Very tall</div>');
    add(${JSON.stringify(bogus('"900"'))});
    add(${JSON.stringify(bogus('NaN'))});
    add(${JSON.stringify(bogus('1e9'))});
  })()`);
  const [MIN, MAX] = [48, 480];
  await until(async () => { const [short, tall, ...rest] = await heights(); return short < 120 && tall === MAX && rest.every(height => height < 120 || height === MAX); }, 'frames sized');
  await new Promise(resolve => setTimeout(resolve, 1200));
  const [short, tall, text, nan, huge] = await heights();
  assert.ok(short >= MIN && short < 120, `a one-line widget has no dead space: ${short}`);
  assert.equal(tall, MAX, 'a tall widget stops at the maximum and scrolls inside its frame');
  assert.equal(text, short, 'a string height from the widget is ignored');
  assert.equal(nan, short, 'NaN from the widget is ignored');
  assert.equal(huge, MAX, 'a huge number is clamped, not obeyed');
  // Only a widget frame's own window counts: the page posting to itself changes nothing.
  await js(`postMessage({ type: 'nc-widget-height', height: 300 }, '*')`);
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.deepEqual((await heights()).slice(0, 2), [short, tall]);
  // Sandboxing is unchanged.
  assert.equal(await js(`[...document.querySelectorAll('#fixture iframe')].every(f => f.getAttribute('sandbox') === 'allow-scripts' && f.getAttribute('src') === 'native-widget.html')`), true);
  console.log('PASS native widget: frame fits its content between 48 and 480px, rejects unbounded or foreign height messages, sandbox unchanged');
  app.quit();
}).catch((error) => { console.error(error); app.exit(1); });
