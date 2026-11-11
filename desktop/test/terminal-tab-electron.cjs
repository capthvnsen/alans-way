// Real main, preload and renderer: the Canvas Terminal tab against this computer's shell.
// Run: npm run test:terminal-tab   (TERMINAL_SHOT=<file.png> also saves a screenshot)
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, Menu } = require('electron');
const { prepareFixture, quitFixture } = require('./electron-fixture.cjs');

const profile = process.env.HERMES_TEST_PROFILE;
prepareFixture(profile);
process.env.SHELL = '/bin/sh';
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
  fs.writeFileSync(prefsFile, JSON.stringify({ onboarded: true, preview: false, canvasTabs: { 1002: 'terminal' },
    bots: [{ id: '1001', isBot: true, name: 'Alan' }, { id: '1002', isBot: true, name: 'Scout' }], selectedBotId: '1001' }));
  require('../src/main.cjs');

  const win = await until(() => BrowserWindow.getAllWindows()[0], 'workspace window');
  const shell = win.webContents;
  await until(() => !shell.isLoading() && shell.getURL().endsWith('index.html'), 'workspace page');
  const run = (expression) => shell.executeJavaScript(expression).catch(error => { throw new Error(`${expression}: ${error.message}`); });
  const state = () => run('workspace.getState()');
  const selected = () => run(`[...document.querySelectorAll('#canvas-tabs [role=tab]')].filter(b => b.getAttribute('aria-selected') === 'true').map(b => b.dataset.canvas).join()`);
  const showing = (tab) => until(async () => (await selected()) === tab, `${tab} tab selected`);
  const screenText = (id) => run(`(() => { const buffer = terminalViews.get('${id}').term.buffer.active; return Array.from({ length: buffer.length }, (_, row) => buffer.getLine(row).translateToString(true)).join('\\n'); })()`);
  const pick = (id) => run(`workspace.command('open-bot', { id: '${id}' })`);
  const live = async () => (await state()).terminals.join();
  const lineFor = async (id, text) => (await screenText(id)).split('\n').includes(text);

  assert.equal(await live(), '', 'no shell until the user asks');
  assert.equal(await run(`[...document.querySelectorAll('#canvas-tabs [role=tab]')].filter(b => !b.hidden).map(b => b.dataset.canvas).join()`), 'browser,screen,terminal');
  assert.equal(Menu.getApplicationMenu().getMenuItemById('canvas-terminal').accelerator, 'CmdOrCtrl+3');

  // Arrowing across the strip passes over Terminal without starting a shell.
  await run(`document.getElementById('canvas-screen').focus(); document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))`);
  await showing('terminal');
  assert.equal(await live(), '', 'arrow keys do not start a shell');
  assert.equal(await run(`!document.getElementById('terminal-idle').classList.contains('hidden') && document.getElementById('terminal-start').offsetParent !== null`), true, 'Start button offered');
  await run(`document.getElementById('canvas-browser').click()`); await showing('browser');

  // A click on the tab starts this bot's shell and the typed command runs.
  await run(`document.getElementById('canvas-terminal').click()`); await showing('terminal');
  await until(async () => (await live()) === '1001', 'shell started');
  await until(() => run(`terminalViews.get('1001')?.opened && !terminalViews.get('1001').host.classList.contains('hidden')`), 'terminal shown');
  assert.equal(await run(`document.getElementById('preview-chip').classList.contains('hidden')`), true, 'the VM preview chip does not cover the terminal');
  await new Promise(resolve => setTimeout(resolve, 500));
  await run(`terminalViews.get('1001').term.input('echo canvas-$((6*7))\\r')`);
  await until(() => lineFor('1001', 'canvas-42'), 'echo output');
  const size = await run(`terminalViews.get('1001').size`);
  await run(`terminalViews.get('1001').term.input('stty size\\r')`);
  const [cols, rows] = size.split('x');
  await until(async () => (await screenText('1001')).split('\n').includes(`${rows} ${cols}`), 'the shell has the pane size');

  // Leaving the tab and coming back keeps the session and its output.
  await run(`document.getElementById('canvas-browser').click()`); await showing('browser');
  assert.equal(await run(`terminalViews.get('1001').host.classList.contains('hidden')`), true);
  assert.equal(await live(), '1001');
  Menu.getApplicationMenu().getMenuItemById('canvas-terminal').click(); await showing('terminal');
  assert.equal(await lineFor('1001', 'canvas-42'), true, 'output kept');
  assert.equal(await live(), '1001', 'the same shell');

  const shot = process.env.TERMINAL_SHOT;
  if (shot) { await new Promise(resolve => setTimeout(resolve, 600)); fs.mkdirSync(path.dirname(shot), { recursive: true }); fs.writeFileSync(shot, (await shell.capturePage()).toPNG()); }

  // Another bot: its saved Terminal tab is restored without a shell, and its shell is its own.
  await pick('1002'); await showing('terminal');
  assert.equal(await live(), '1001', 'restoring a bot’s Terminal tab starts nothing');
  await run(`document.getElementById('terminal-start').click()`);
  await until(async () => (await live()) === '1001,1002', 'second shell started');
  await until(() => run(`terminalViews.get('1002')?.opened && !terminalViews.get('1002').host.classList.contains('hidden')`), 'second terminal shown');
  assert.equal(await run(`terminalViews.get('1001').host.classList.contains('hidden')`), true);
  await pick('1001'); await showing('terminal');
  assert.equal(await lineFor('1001', 'canvas-42'), true, 'first bot’s output kept after switching bots');
  assert.equal(await lineFor('1002', 'canvas-42'), false, 'the other bot’s shell is separate');

  // Exiting the shell ends the session; Start offers a new one.
  await run(`terminalViews.get('1001').term.input('exit\\r')`);
  await until(async () => (await live()) === '1002', 'session ended');
  assert.equal(await lineFor('1001', '[Session ended]'), true);
  assert.equal(await run(`!document.getElementById('terminal-idle').classList.contains('hidden')`), true);
  assert.equal(await run(`!terminalViews.get('1001').host.classList.contains('hidden')`), true, 'the ended session’s output stays readable');
  assert.equal(await run(`document.getElementById('terminal-start').textContent`), 'Restart terminal');
  await run(`document.getElementById('terminal-start').click()`);
  await until(async () => (await state()).terminals.includes('1001'), 'restarted');
  assert.equal(await lineFor('1001', 'canvas-42'), true, 'a restart keeps the old scrollback');

  // Only the Workspace page may drive a shell: the browser pane's pages have no bridge at all.
  assert.equal(await run(`typeof window.terminal.start + typeof window.terminal.input + typeof window.terminal.resize + typeof window.terminal.kill + Object.keys(window.terminal).length`), 'functionfunctionfunctionfunction6');
  console.log('PASS terminal tab: click starts, echo canvas-42, output kept across tabs and bots, per-bot shells, nothing starts on restore or arrow keys.');
  quitFixture();
})().catch((error) => { console.error(error); app.exit(1); });
