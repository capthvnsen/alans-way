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
const longForm = `<!doctype html><meta charset="utf-8"><style>body{font:20px system-ui;margin:30px}input,button{font:inherit;padding:12px}</style><form id="longform"><input id="custname" aria-label="Customer name" data-hermes-workspace-ref="s1-1"><div style="height:2200px"></div><button type="submit" id="order" data-hermes-workspace-ref="s1-2">Submit order</button></form><p id="result">Waiting</p><script>longform.onsubmit=e=>{e.preventDefault();result.textContent='Submitted: '+custname.value}</script>`;
const widgets = `<!doctype html><meta charset="utf-8"><style>body{font:18px system-ui;margin:20px}#src,#dst,#h5src,#h5dst{display:inline-block;width:90px;height:50px;margin:8px;background:#ddd}#dst,#h5dst{background:#bdf}</style>
<input id="t" aria-label="t" data-hermes-workspace-ref="s1-1" value="hello world"><select id="sel" data-hermes-workspace-ref="s1-2"><option value="a">Alpha</option><option value="b">Beta</option><option value="c">Gamma</option></select>
<button id="dbl" data-hermes-workspace-ref="s1-3">double</button><div id="ctx" data-hermes-workspace-ref="s1-4" style="width:100px;height:40px;background:#ccc">ctx</div>
<input type="range" id="rng" min="0" max="100" value="0" data-hermes-workspace-ref="s1-5" style="width:300px"><br>
<div id="src" data-hermes-workspace-ref="s1-6">src</div><div id="dst" data-hermes-workspace-ref="s1-7">dst</div>
<div id="h5src" draggable="true" data-hermes-workspace-ref="s1-8">h5</div><div id="h5dst" data-hermes-workspace-ref="s1-9">h5 drop</div>
<form id="f1"><input name="q" value="1"><button id="sub" name="which" value="primary" data-hermes-workspace-ref="s1-10">Send</button></form>
<form id="f2"><button id="prev" onclick="event.preventDefault()" data-hermes-workspace-ref="s1-11">Prevented</button></form>
<form id="f3"><fieldset disabled><button id="fsd" data-hermes-workspace-ref="s1-12">Disabled</button></fieldset></form>
<select id="hs" style="display:none" data-hermes-workspace-ref="s1-13"><option value="x">X</option><option value="y">Y</option></select>
<script>window.submits=[];for(const f of [f1,f2,f3])f.addEventListener('submit',e=>{e.preventDefault();submits.push([e.target.id,e.submitter&&e.submitter.name+'='+e.submitter.value])});
window.log={moves:0,keys:[],selChange:[]};
dbl.addEventListener('dblclick',e=>log.dbl=e.isTrusted);ctx.addEventListener('contextmenu',e=>{log.ctx=[e.isTrusted,e.button]});
sel.addEventListener('change',e=>log.selChange.push([e.target.value,e.isTrusted]));
t.addEventListener('keydown',e=>log.keys.push([e.key,e.code,e.keyCode]));
src.addEventListener('mousedown',()=>{log.down=true});document.addEventListener('mousemove',e=>{if(e.buttons===1&&log.down)log.moves++});document.addEventListener('mouseup',e=>{if(log.down){log.up=e.target.id;log.down=false}});
h5src.addEventListener('dragstart',()=>log.h5start=true);document.addEventListener('drop',e=>{e.preventDefault();log.h5drop=e.target.id});document.addEventListener('dragover',e=>e.preventDefault());</script>`;
const humanPage = '<title>Human focus fixture</title><input id="human" value="Human draft stays here"><script>human.focus();human.setSelectionRange(6,11)</script>';
async function value(wc, expression) { return wc.executeJavaScript(expression); }
async function eventually(fn, predicate) {
  let result;
  for (let i = 0; i < 30; i++) { result = await fn(); if (predicate(result)) return result; await new Promise(r => setTimeout(r, 40)); }
  throw new Error(`Timed out waiting for browser input; last value: ${JSON.stringify(result)}`);
}
// Dispatched input is acked over CDP before the renderer applies it, so a
// page read taken the moment perform resolves can beat the events on a loaded
// runner. Await the value the action was meant to produce instead.
const equals = (got, expected) => JSON.stringify(got) === JSON.stringify(expected);
async function eventuallyEquals(fn, expected) {
  const got = await eventually(fn, value => equals(value, expected));
  assert.deepEqual(got, expected);
  return got;
}
app.whenReady().then(async () => {
  server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(req.url === '/human' ? humanPage : req.url === '/longform' ? longForm : req.url === '/widgets' ? widgets : fixture); });
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
    await eventuallyEquals(() => value(view.webContents, 'entry.value'), text);
  }
  await perform({ action: 'click', ref: 's1-2' });
  await eventuallyEquals(() => value(view.webContents, 'result.textContent'), 'Confirmed: Final agent text');
  await perform({ action: 'type', ref: 's1-1', text: 'Enter submits' });
  await perform({ action: 'press', key: 'Enter' });
  await eventuallyEquals(() => value(view.webContents, 'result.textContent'), 'Confirmed: Enter submits');
  await perform({ action: 'move', x: 420, y: 210 });
  await eventuallyEquals(() => value(view.webContents, 'events.filter(e=>e.type==="pointermove").at(-1)'), { type: 'pointermove', trusted: true, key: undefined, x: 420, y: 210 });
  assert.match(await value(view.webContents, 'document.getElementById("hermes-workspace-agent-cursor").style.transform'), /420px, 210px/);
  await perform({ action: 'press', key: 'l', modifiers: ['meta'] });
  assert.equal(appShortcutCalls, 0);
  await perform({ action: 'scroll', y: 400 });
  await eventually(() => value(view.webContents, 'scrollY'), y => y > 0);
  // A visible browser pane must also leave the human's composer alone.
  view.setVisible(true);
  await perform({ action: 'type', ref: 's1-1', text: 'Visible agent pane' });
  await perform({ action: 'click', ref: 's1-2' });
  await eventuallyEquals(() => value(view.webContents, 'result.textContent'), 'Confirmed: Visible agent pane');
  assert.equal(await value(view.webContents, 'events.filter(e=>["input","click","keydown"].includes(e.type)).every(e=>e.trusted)'), true, 'Input must be trusted Chromium events');
  await view.webContents.loadURL(`${root}/longform`);
  tab.refs = new Set(['s1-1', 's1-2']);
  await view.webContents.executeJavaScript('scrollTo(0,0)');
  await perform({ action: 'type', ref: 's1-1', text: 'Offscreen submit' });
  await perform({ action: 'click', ref: 's1-2' });
  await eventuallyEquals(() => value(view.webContents, 'result.textContent'), 'Submitted: Offscreen submit');
  await view.webContents.executeJavaScript('scrollTo(0,0)');
  await perform({ action: 'type', ref: 's1-1', text: 'Selector submit' });
  await perform({ action: 'click', selector: 'button[type=submit]' });
  await eventuallyEquals(() => value(view.webContents, 'result.textContent'), 'Submitted: Selector submit');
  await view.webContents.loadURL(`${root}/widgets`);
  tab.refs = new Set(['s1-1', 's1-2', 's1-3', 's1-4', 's1-5', 's1-6', 's1-7', 's1-8', 's1-9', 's1-10', 's1-11', 's1-12', 's1-13']);
  const log = () => value(view.webContents, 'JSON.parse(JSON.stringify(window.log))');
  const selection = () => value(view.webContents, '[t.selectionStart,t.selectionEnd]');
  await perform({ action: 'press', ref: 's1-1', key: 'End' });
  await perform({ action: 'press', key: 'a', modifiers: ['meta'] });
  if (process.platform === 'darwin') assert.deepEqual(await eventually(selection, got => equals(got, [0, 11])), [0, 11], 'Cmd+A selects the whole field on macOS');
  await perform({ action: 'press', key: 'ArrowLeft', modifiers: ['alt'] });
  if (process.platform === 'darwin') assert.deepEqual(await eventually(selection, got => equals(got, [6, 6])), [6, 6], 'Alt+Left moves the caret back one word');
  await perform({ action: 'type', ref: 's1-1', text: 'hello world' });
  await perform({ action: 'press', key: '.' });
  await perform({ action: 'press', key: "'" });
  assert.equal(await eventually(() => value(view.webContents, 't.value'), got => got === "hello world.'"), "hello world.'", 'punctuation types its character');
  assert.deepEqual((await eventually(log, got => got.keys.length >= 2 && equals(got.keys.slice(-2), [['.', 'Period', 190], ["'", 'Quote', 222]]))).keys.slice(-2), [['.', 'Period', 190], ["'", 'Quote', 222]], 'punctuation keys report their real key, code and keyCode');
  const picked = await perform({ action: 'select', ref: 's1-2', label: 'Beta' });
  assert.deepEqual(picked.matched, { by: 'label', value: 'b', label: 'Beta' });
  await perform({ action: 'select', selector: '#sel', value: 'c' });
  assert.deepEqual((await log()).selChange, [['b', false], ['c', false]]);
  assert.equal(await value(view.webContents, 'sel.value'), 'c');
  await assert.rejects(perform({ action: 'select', ref: 's1-2', label: 'Delta' }), /no option matching.*Alpha/);
  await perform({ action: 'double_click', ref: 's1-3' });
  assert.equal((await eventually(log, got => got.dbl !== undefined)).dbl, true, 'double_click produces a trusted dblclick');
  await perform({ action: 'right_click', ref: 's1-4' });
  assert.deepEqual((await eventually(log, got => got.ctx !== undefined)).ctx, [true, 2], 'right_click produces a trusted contextmenu with button 2');
  await perform({ action: 'drag', ref: 's1-5', toX: 330, toY: await value(view.webContents, 'Math.round(rng.getBoundingClientRect().top + rng.getBoundingClientRect().height / 2)') });
  assert.ok(Number(await eventually(() => value(view.webContents, 'rng.value'), v => Number(v) >= 90)) >= 90, 'dragging a range thumb to its end sets the value');
  await perform({ action: 'drag', ref: 's1-6', toRef: 's1-7' });
  const dragged = await eventually(log, got => got.up !== undefined);
  assert.equal(dragged.up, 'dst', 'the button is released over the destination element');
  assert.ok(dragged.moves >= 2, 'the pointer moved with the button held');
  const h5 = await Promise.race([perform({ action: 'drag', ref: 's1-8', toRef: 's1-9' }).then(() => 'settled'), new Promise(resolve => setTimeout(() => resolve('wedged'), 5000))]);
  assert.equal(h5, 'settled', 'a native HTML5 drag cannot wedge the action');
  const h5log = await eventually(log, got => got.h5start !== undefined && got.h5drop !== undefined);
  assert.deepEqual([h5log.h5start, h5log.h5drop], [true, 'h5dst'], 'an HTML5 draggable element starts a drag and drops on the destination');
  await perform({ action: 'click', ref: 's1-10' });
  assert.deepEqual(await eventually(() => value(view.webContents, 'submits'), got => got.length === 1), [['f1', 'which=primary']], 'a submit click submits once, with its button as the submitter');
  await perform({ action: 'click', ref: 's1-11' });
  assert.equal((await value(view.webContents, 'submits')).length, 1, 'a click the page cancels does not submit');
  await assert.rejects(perform({ action: 'click', ref: 's1-12' }), /missing or disabled/);
  assert.equal((await value(view.webContents, 'submits')).length, 1, 'a button in a disabled fieldset does not submit');
  const hidden = await perform({ action: 'select', ref: 's1-13', value: 'y' });
  assert.deepEqual(hidden.matched, { by: 'value', value: 'y', label: 'Y' }, 'a hidden native select can still be chosen');
  console.log('PASS: macOS editing commands, punctuation key codes, select, double/right click, mouse and HTML5 drag by ref and coordinates.');
  tab.controller = 'human'; tab.epoch++;
  await agent.clear(tab);
  assert.equal(await value(view.webContents, '!!document.getElementById("hermes-workspace-agent-cursor")'), false);
  await assert.rejects(agent.perform(tab, { action: 'click', epoch: 1, ref: 's1-2' }, 'fixture-agent'), /human_has_control/);
  console.log('PASS: hidden and visible tab CDP replacement typing, clearing, click, Enter, offscreen submit by ref/selector, real pointer movement/cursor, scrolling, native shortcut isolation, takeover, and unchanged human draft/selection/native focus.');
}).catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(() => {
  win?.destroy();
  server?.close();
  const exitCode = process.exitCode || 0;
  app.exit(exitCode);
});
app.on('quit', () => { fs.rmSync(temp, { recursive: true, force: true }); });
