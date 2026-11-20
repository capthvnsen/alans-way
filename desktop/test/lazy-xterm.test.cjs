'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('index.html does not eagerly load xterm scripts or stylesheet', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/index.html'), 'utf8');
  assert.doesNotMatch(html, /@xterm\/xterm/);
  assert.doesNotMatch(html, /@xterm\/addon-fit/);
});

test('renderer lazy-loads xterm on first terminal data/open and flushes buffered chunks in order', async () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8');
  const start = src.indexOf('const terminalViews = new Map();');
  const end = src.indexOf('new ResizeObserver(() => { for (const id of terminalViews.keys())');
  assert.ok(start > 0 && end > start);
  const slice = src.slice(start, end);

  const appended = [];
  const written = [];
  let opened = 0, focused = 0;
  let onDataCb, onExitCb;
  const elements = new Map();
  const makeEl = (tag) => ({
    tag, className: '', textContent: '', hidden: false,
    classList: {
      set: new Set(),
      toggle(c, v) { if (v) this.set.add(c); else this.set.delete(c); },
      add(c) { this.set.add(c); },
      remove(c) { this.set.delete(c); },
      contains(c) { return this.set.has(c); },
    },
    append(node) { appended.push(node); },
    contains: () => false,
  });
  const $ = (id) => { if (!elements.has(id)) elements.set(id, makeEl(id)); return elements.get(id); };
  const headNodes = [];
  const win = {
    terminal: {
      start() {}, input() {}, resize() {},
      onData(cb) { onDataCb = cb; },
      onExit(cb) { onExitCb = cb; },
    },
  };
  const ctx = vm.createContext({
    window: win,
    state: { canvasTab: 'browser', selectedBotId: 'b1', terminals: [], platform: 'darwin', vpsBrowser: {} },
    $, toast(msg) { throw new Error('unexpected toast: ' + msg); },
    document: {
      activeElement: null,
      head: { append(node) { headNodes.push(node); } },
      createElement(tag) { return makeEl(tag); },
    },
    navigator: { clipboard: { writeText: async () => {} } },
  });
  vm.runInContext(slice, ctx);

  // Idle browser render must not load xterm.
  ctx.renderTerminal();
  assert.equal(headNodes.length, 0, 'xterm is not loaded while on browser tab');

  // Early output queues chunks and triggers lazy load once.
  onDataCb('b1', 'hello ');
  onDataCb('b1', 'world');
  onExitCb('b1');
  assert.equal(headNodes.filter((n) => n.tag === 'link').length, 1);
  assert.equal(headNodes.filter((n) => n.tag === 'script').length, 1);

  // Simulate xterm.js finishing load -> triggers addon-fit.js load.
  win.Terminal = class {
    constructor() { this.cols = 80; this.rows = 24; }
    loadAddon() {}
    onData() {}
    attachCustomKeyEventHandler() {}
    open() { opened++; }
    focus() { focused++; }
    write(chunk) { written.push(chunk); }
  };
  headNodes.find((n) => n.tag === 'script').onload();
  headNodes.find((n) => n.tag === 'link').onload();
  await new Promise((r) => setImmediate(r));
  const fitScript = headNodes.filter((n) => n.tag === 'script')[1];
  assert.ok(fitScript && fitScript.src.includes('addon-fit.js'));
  win.FitAddon = { FitAddon: class { fit() {} } };
  fitScript.onload();
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(written, ['hello ', 'world', '\r\n[Session ended]\r\n']);
  // Subsequent terminal open uses loaded xterm and focuses on deliberate open.
  ctx.state.canvasTab = 'terminal';
  ctx.state.terminals = ['b1'];
  $('terminal-start').onclick();
  ctx.renderTerminal();
  assert.equal(opened, 1);
  assert.equal(focused, 1);
});
