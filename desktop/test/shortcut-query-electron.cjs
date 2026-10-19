const { resizeWindow } = require('./window-fixture.cjs');
// Focused matcher/renderer integration: real Electron, actual Help callback,
// trusted Chromium click/input. No native accelerator or Settings acceptance.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, Menu } = require('electron');
const desktop = path.resolve(process.env.SHORTCUT_QUERY_DESKTOP || path.join(__dirname, '..'));
const out = path.resolve(process.env.SHORTCUT_QUERY_OUT || path.join(__dirname, '../../evidence/quality/shortcut-round4'));
const { prepareFixture, quitFixture } = require(path.join(desktop, 'test/electron-fixture.cjs'));
assert.ok(process.env.HERMES_TEST_PROFILE, 'Use test/run-electron.cjs for disposable storage.');
prepareFixture(process.env.HERMES_TEST_PROFILE);
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(process.env.HERMES_TEST_PROFILE, 'preferences.json'), JSON.stringify({
  onboarded: true, preview: false, bots: [{ id: '401', name: 'Research', isBot: true }], selectedBotId: '401',
}));
const helperPath = path.join(desktop, 'src/workspace-shortcuts.cjs');
const helperSource = fs.readFileSync(helperPath, 'utf8');
assert.equal(helperSource, fs.readFileSync(path.join(__dirname, '../src/workspace-shortcuts.cjs'), 'utf8'), 'Candidate must contain the exact owned helper.');
const { matchesShortcut } = require(helperPath);
require(path.join(desktop, 'src/main.cjs'));
const receipts = [], errors = [];
const pause = () => new Promise(resolve => setTimeout(resolve, 30));
const wait = async read => {
  for (let i = 0; i < 180; i++) { const result = await read(); if (result) return result; await pause(); }
  throw Error('Timed out waiting for the shortcut UI.');
};
app.whenReady().then(async () => {
  const win = await wait(() => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html')));
  const wc = win.webContents;
  const js = code => wc.executeJavaScript(code);
  await wait(() => js('!!document.querySelector(".bot-open")').catch(() => false));
  win.setMinimumSize(0, 0); await resizeWindow(win, 1280, 800);
  wc.debugger.attach('1.3');
  await wc.debugger.sendCommand('Page.enable');
  await wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
  const frame = () => js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  const screenshot = async name => fs.writeFileSync(path.join(out, `${name}.png`), (await wc.capturePage()).toPNG());
  const click = async selector => {
    const point = await js(`(() => {const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    for (const type of ['mousePressed', 'mouseReleased']) await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...point });
  };
  const search = async query => {
    await click('#shortcut-search');
    await js('document.getElementById("shortcut-search").select()');
    await wc.debugger.sendCommand('Input.insertText', { text: query });
    await frame();
    return js('({query:document.getElementById("shortcut-search").value,status:document.getElementById("shortcut-status").textContent,rows:[...document.querySelectorAll("[data-shortcut]")].map(n=>({id:n.dataset.shortcut,text:n.innerText,bindings:[...n.querySelectorAll("kbd")].map(k=>k.innerText)})),active:document.activeElement.id})');
  };
  // Verify the actual script loaded by the document, not only a Node import.
  const helperURL = pathToFileURL(helperPath).href;
  assert.equal(await js('document.querySelector("script[src*=workspace-shortcuts]").src'), helperURL);
  const { frameTree } = await wc.debugger.sendCommand('Page.getResourceTree');
  const loaded = await wc.debugger.sendCommand('Page.getResourceContent', { frameId: frameTree.frame.id, url: helperURL });
  assert.equal(loaded.content, helperSource);
  assert.equal(await js('window.WorkspaceShortcuts.matchesShortcut.toString()'), matchesShortcut.toString());
  receipts.push({ name: 'runtime', desktop, cwd: process.cwd(), url: wc.getURL(), platform: process.platform,
    helperPath, helperURL, helperSha256: createHash('sha256').update(helperSource).digest('hex'),
    loadedScriptMatchesOwnedHelper: true, nativeOSAttempts: 0 });
  await js('window.queryEvents=[];for(const type of ["input","click"])document.addEventListener(type,e=>queryEvents.push({type,trusted:e.isTrusted,target:e.target.id}),true)');
  Menu.getApplicationMenu().getMenuItemById('workspace-shortcuts').click(); await frame();
  await screenshot('candidate-all');
  const mac = process.platform === 'darwin';
  const cases = [
    ['⇥', ['agent-hide', 'dialog-tab']], ['↩', ['agent-open']], ['Home', ['agent-move', 'tab-move']],
    ['End', ['agent-move', 'tab-move']], ['Enter', ['agent-open']], ['Return', ['agent-open']],
    ['home key', ['agent-move', 'tab-move']], ['return key', ['agent-open']], ['tab key', ['agent-hide', 'dialog-tab']],
    ['escape key', ['search-close', 'dialog-close']], ['spacebar key', ['agent-open']], ['forward delete key', ['tab-close']],
    ['down arrow key', ['agent-move', 'search-result']], ['⇥ key', ['agent-hide', 'dialog-tab']],
    ['return to opener', ['dialog-close']], ['home stays available', ['close-tab']],
    ['delete tab', ['tab-close']], ['tab delete', ['tab-close']], ['delete tabs', ['tab-close']],
    ['delete focused tab', ['tab-close']], ['delete browser tab', ['tab-close']], ['browser tab delete', ['tab-close']],
    ['forward delete tab', ['tab-close']], ['Delete+Tab', []], ['Tab+Delete', []], ['Delete Tab key', []],
    ['delete ⇥', []], ['⌦ tab', []], ['Del Tab', []], ['Shift Delete Tab', []],
    ['Home End', []], ['Tab Enter', []], ['ArrowUp ArrowDown key', []], ['⇥ Open', []], ['↩ opener', []],
    ['⌘T key', mac ? ['new-tab'] : []], ['⌥T key', []], ['Shift+Return key', []],
    ['⌃T', mac ? [] : ['new-tab']], ['^T', mac ? [] : ['new-tab']], ['Control+T', mac ? [] : ['new-tab']],
    ['⌥T', []], ['Alt+T', []], ['Option T', []], ['⌘⌥T', []], ['⌃⌥T', []], ['⌘⌃T', []], ['⌘⇧T', []],
    ['⌃,', mac ? [] : ['settings']], ['⌥', []], ['⌃', []], ['!!', []], ['🌐T', []], ['⌘T⌫', []],
    ['command+Home', []], ['command+Tab', []], ['control+Home', []], ['command new tab', []], ['Home+End', []], ['↑+↓', []],
    ['⌘T', mac ? ['new-tab'] : []], ['Command+T', mac ? ['new-tab'] : []], ['cmd t', mac ? ['new-tab'] : []],
    ['Command+,', mac ? ['settings'] : []], ['⌘,', mac ? ['settings'] : []],
    ['Shift+Tab', ['dialog-tab']], ['⇧⇥', ['dialog-tab']], ['tab shift', ['dialog-tab']],
    ['reload tab', ['reload']], ['tab reload', ['reload']], ['close browser tab', ['close-tab', 'tab-close']],
    ['browser tab close', ['close-tab', 'tab-close']], ['tab new', ['new-tab']], ['pdf open', ['open-file']],
    ['ArrowDown', ['agent-move', 'search-result']], ['down arrow', ['agent-move', 'search-result']],
    ['↓', ['agent-move', 'search-result']], ['⎋', ['search-close', 'dialog-close']], ['⌦', ['tab-close']],
    ['wrongtab', []], ['reopen tab', []], ['command+q', []],
  ];
  for (const [query, expected] of cases) {
    const result = await search(query), actual = result.rows.map(r => r.id);
    const pass = JSON.stringify(actual) === JSON.stringify(expected);
    receipts.push({ name: 'query', query, expected, actual, pass, result });
    if (!pass) errors.push({ query, expected, actual });
    const capture = { '⇥': 'tab-glyph', '↩': 'return-glyph', Home: 'home', 'home key': 'home-key',
      'return to opener': 'return-to-opener', '⌃T': 'control-t-zero', '⌘T': 'command-t', '⇧⇥': 'shift-tab',
      'close browser tab': 'close-browser-tab', 'reload tab': 'reload-tab', 'delete tab': 'delete-tab', 'Delete+Tab': 'delete-plus-tab-zero' }[query];
    if (capture) await screenshot(`candidate-${capture}`);
  }
  for (const query of ['', ' \t ']) {
    const result = await search(query); receipts.push({ name: 'empty-query', result });
    assert.equal(result.rows.length, 15);
  }
  const events = await js('queryEvents');
  assert.ok(events.some(e => e.type === 'input')); assert.ok(events.every(e => e.trusted));
  receipts.push({ name: 'events', events });
  fs.writeFileSync(path.join(out, 'candidate-ax.json'), JSON.stringify(await wc.debugger.sendCommand('Accessibility.getFullAXTree'), null, 2));
}).catch(error => errors.push({ fixture: error.stack })).finally(() => {
  fs.writeFileSync(path.join(out, 'ui-results.json'), JSON.stringify({ receipts, errors, nativeOSAttempts: 0 }, null, 2));
  console.log(JSON.stringify({ queries: receipts.filter(r => r.name === 'query').length, failures: errors.length, errors }));
  app.once('will-quit', () => app.exit(errors.length ? 1 : 0));
  quitFixture();
});
