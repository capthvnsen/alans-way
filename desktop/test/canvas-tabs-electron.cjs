// Real main, preload and renderer: the Canvas tab strip and its per-bot memory.
// Run: npm run test:canvas-tabs   (CANVAS_SHOTS=<dir> also saves screenshots)
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { BrowserWindow, Menu, webContents } = require('electron');
const { prepareFixture, quitFixture } = require('./electron-fixture.cjs');

const profile = process.env.HERMES_TEST_PROFILE;
prepareFixture(profile);
const until = async (read, why, ms = 15000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out: ${why}`);
    await new Promise(resolve => setTimeout(resolve, 40));
  }
};

(async () => {
  const prefsFile = path.join(profile, 'preferences.json');
  fs.writeFileSync(prefsFile, JSON.stringify({ onboarded: true, preview: false,
    bots: [{ id: '1001', isBot: true, name: 'Alan' }, { id: '1002', isBot: true, name: 'Scout' }], selectedBotId: '1001' }));
  require('../src/main.cjs');

  const win = await until(() => BrowserWindow.getAllWindows()[0], 'workspace window');
  const shell = win.webContents;
  await until(() => !shell.isLoading() && shell.getURL().endsWith('index.html'), 'workspace page');
  const run = (expression) => shell.executeJavaScript(expression);
  const shots = process.env.CANVAS_SHOTS;
  const shot = async (name, width) => {
    if (!shots) return;
    win.setSize(width, 820); await new Promise(resolve => setTimeout(resolve, 600));
    // capturePage sees only the shell page; the VM live view is its own native view, saved alongside.
    fs.writeFileSync(path.join(shots, `${name}-${width}.png`), (await shell.capturePage()).toPNG());
    const remote = webContents.getAllWebContents().find(item => item.getURL().endsWith('remote.html'));
    if (name === 'screen' && remote) fs.writeFileSync(path.join(shots, `${name}-${width}-vm-view.png`), (await remote.capturePage()).toPNG());
  };
  const state = () => run('workspace.getState()');
  const selected = () => run(`[...document.querySelectorAll('#canvas-tabs [role=tab]')].filter(b => b.getAttribute('aria-selected') === 'true').map(b => b.dataset.canvas).join()`);
  const showing = async (tab) => {
    await until(async () => (await selected()) === tab, `${tab} tab selected`);
    assert.equal((await state()).activeTabId === 'vps', tab === 'screen', `${tab} drives the canvas`);
    assert.equal(await run(`document.getElementById('canvas-${tab}').tabIndex`), 0, 'only the selected tab is in the Tab order');
  };
  const pick = (id) => run(`workspace.command('open-bot', { id: '${id}' })`);
  const saved = () => JSON.parse(fs.readFileSync(prefsFile, 'utf8'));

  await showing('browser');
  await shot('browser', 1440); await shot('browser', 1120);

  // Click: Alan moves to his screen.
  await run(`document.getElementById('canvas-screen').click()`);
  await showing('screen');
  await shot('screen', 1440); await shot('screen', 1120);

  // The canvas follows the bot: Scout has no choice yet and inherits the view;
  // set Scout to Browser, then each bot gets its own tab back.
  await pick('1002'); await showing('screen');
  await run(`document.getElementById('canvas-browser').click()`); await showing('browser');
  await pick('1001'); await showing('screen');
  await pick('1002'); await showing('browser');

  // Keyboard: arrow keys on the strip, and the View menu accelerators from anywhere.
  await run(`document.getElementById('canvas-browser').focus(); document.getElementById('canvas-browser').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))`);
  await showing('screen');
  assert.equal(await run('document.activeElement.id'), 'canvas-screen', 'focus follows the arrow');
  await run(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))`);
  await showing('browser');
  const menu = Menu.getApplicationMenu();
  assert.equal(menu.getMenuItemById('canvas-screen').accelerator, 'CmdOrCtrl+2');
  menu.getMenuItemById('canvas-screen').click(); await showing('screen');
  menu.getMenuItemById('canvas-browser').click(); await showing('browser');
  menu.getMenuItemById('canvas-screen').click(); await showing('screen');

  // Choices are saved per bot, so they survive a restart.
  await until(() => saved().canvasTabs?.['1002'] === 'screen' && saved().canvasTabs?.['1001'] === 'screen', 'choices saved');
  menu.getMenuItemById('canvas-browser').click(); await showing('browser');
  await until(() => saved().canvasTabs?.['1002'] === 'browser', 'browser choice saved');
  console.log('PASS canvas tabs: click, per-bot memory, arrow keys, ⌘1/⌘2, saved preferences.');
  quitFixture();
})().catch((error) => { console.error(error); quitFixture(); process.exitCode = 1; });
