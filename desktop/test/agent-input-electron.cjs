// Run: ./node_modules/.bin/electron test/agent-input-electron.cjs
// Uses a fresh temporary Electron profile, hidden windows and localhost only.
// Add --visible to watch the test fixture without activating its window.
const { app, BrowserWindow, WebContentsView, webContents } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createAgentInput } = require('../src/agent-input.cjs');
const { requireActor } = require('../src/core.cjs');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-agent-input-'));
app.setPath('userData', temp);
app.setName('Hermes isolated input test');
let win, server;
const fixture = `<!doctype html><meta charset="utf-8"><style>body{font:20px system-ui;margin:30px}input,button{font:inherit;padding:12px}#space{height:1800px}</style><h1>Isolated agent input</h1><form id="form"><input id="entry" aria-label="Agent input" data-hermes-workspace-ref="s1-1"><button id="submit" data-hermes-workspace-ref="s1-2">Confirm</button></form><p id="result">Waiting</p><div id="space"></div><script>window.events=[];for(const name of ['input','click','keydown','pointermove'])document.addEventListener(name,e=>events.push({type:e.type,trusted:e.isTrusted,key:e.key,x:e.clientX,y:e.clientY}));document.querySelector('#form').onsubmit=e=>{e.preventDefault();document.querySelector('#result').textContent='Confirmed: '+document.querySelector('#entry').value};</script>`;
const humanPage = '<title>Human focus fixture</title><input id="human" value="Human draft stays here"><script>human.focus();human.setSelectionRange(6,11)</script>';
async function value(wc, expression) { return wc.executeJavaScript(expression); }
async function eventually(fn, predicate) {
  for (let i = 0; i < 30; i++) { const result = await fn(); if (predicate(result)) return result; await new Promise(r => setTimeout(r, 40)); }
  throw new Error('Timed out waiting for browser input.');
}
app.whenReady().then(async () => {
  server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(req.url === '/human' ? humanPage : fixture); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const root = `http://127.0.0.1:${server.address().port}`;
  win = new BrowserWindow({ show: false, width: 1000, height: 720, webPreferences: { sandbox: true } });
  await win.loadURL(`${root}/human`);
  const view = new WebContentsView({ webPreferences: { sandbox: true, backgroundThrottling: false } });
  win.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 100, width: 900, height: 550 });
  view.setVisible(false);
  await view.webContents.loadURL(root);
  if (process.argv.includes('--visible')) win.showInactive();
  const tab = { view, botId: 'fixture-agent', controller: 'agent', epoch: 1, refs: new Set(['s1-1', 's1-2']) };
  const command = async (target, method, params) => {
    const debuggerSession = target.view.webContents.debugger;
    if (!debuggerSession.isAttached()) debuggerSession.attach('1.3');
    return debuggerSession.sendCommand(method, params);
  };
  const agent = createAgentInput({ command, requireActor });
  let appShortcutCalls = 0;
  view.webContents.on('before-input-event', (_event, input) => {
    if (agent.isDispatching(tab)) return;
    if ((input.meta || input.control) && input.key.toLowerCase() === 'l') appShortcutCalls++;
  });
  const focusedBefore = webContents.getFocusedWebContents()?.id;
  const humanBefore = await value(win.webContents, '({value:human.value,id:document.activeElement.id,start:human.selectionStart,end:human.selectionEnd})');
  const nativeFocusBefore = win.isFocused();
  async function perform(body) {
    const visibleBefore = view.getVisible();
    const result = await agent.perform(tab, { epoch: tab.epoch, ...body }, 'fixture-agent');
    assert.equal(webContents.getFocusedWebContents()?.id, focusedBefore, 'Agent stole the native WebContents focus');
    assert.equal(win.isFocused(), nativeFocusBefore, 'Agent activated its window');
    assert.equal(view.getVisible(), visibleBefore, 'Agent changed the selected tab');
    assert.deepEqual(await value(win.webContents, '({value:human.value,id:document.activeElement.id,start:human.selectionStart,end:human.selectionEnd})'), humanBefore, 'Agent changed the human draft, selection or DOM focus');
    return result;
  }
  for (const text of ['Discard this value', 'Background typing works', '', 'Final agent text']) {
    await perform({ action: 'type', ref: 's1-1', text });
    assert.equal(await value(view.webContents, 'entry.value'), text);
  }
  await perform({ action: 'click', ref: 's1-2' });
  assert.equal(await value(view.webContents, 'result.textContent'), 'Confirmed: Final agent text');
  await perform({ action: 'type', ref: 's1-1', text: 'Enter submits' });
  await perform({ action: 'press', key: 'Enter' });
  assert.equal(await value(view.webContents, 'result.textContent'), 'Confirmed: Enter submits');
  await perform({ action: 'move', x: 420, y: 210 });
  assert.deepEqual(await value(view.webContents, 'events.filter(e=>e.type==="pointermove").at(-1)'), { type: 'pointermove', trusted: true, key: undefined, x: 420, y: 210 });
  assert.match(await value(view.webContents, 'document.getElementById("hermes-workspace-agent-cursor").style.transform'), /420px, 210px/);
  await perform({ action: 'press', key: 'l', modifiers: ['meta'] });
  assert.equal(appShortcutCalls, 0);
  await perform({ action: 'scroll', y: 400 });
  await eventually(() => value(view.webContents, 'scrollY'), y => y > 0);
  // A visible browser pane must also leave the human's composer alone.
  view.setVisible(true);
  await perform({ action: 'type', ref: 's1-1', text: 'Visible agent pane' });
  await perform({ action: 'click', ref: 's1-2' });
  assert.equal(await value(view.webContents, 'result.textContent'), 'Confirmed: Visible agent pane');
  assert.equal(await value(view.webContents, 'events.filter(e=>["input","click","keydown"].includes(e.type)).every(e=>e.trusted)'), true, 'Input must be trusted Chromium events');
  tab.controller = 'human'; tab.epoch++;
  await agent.clear(tab);
  assert.equal(await value(view.webContents, '!!document.getElementById("hermes-workspace-agent-cursor")'), false);
  await assert.rejects(agent.perform(tab, { action: 'click', epoch: 1, ref: 's1-2' }, 'fixture-agent'), /human_has_control/);
  console.log('PASS: hidden and visible tab CDP replacement typing, clearing, click, Enter, real pointer movement/cursor, scrolling, native shortcut isolation, takeover, and unchanged human draft/selection/native focus.');
}).catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(() => {
  win?.destroy();
  server?.close();
  const exitCode = process.exitCode || 0;
  app.exit(exitCode);
});
app.on('quit', () => { fs.rmSync(temp, { recursive: true, force: true }); });
