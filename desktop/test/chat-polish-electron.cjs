// Run: node test/run-electron.cjs test/chat-polish-electron.cjs
// Renderer-only fixture: real HTML/CSS, real bot-list and Hermes view code, fake data.
// Set CHAT_POLISH_SHOTS=<dir> to also save screenshots.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, session } = require('electron');
const { resizeWindow } = require('./window-fixture.cjs');
const profile = process.env.HERMES_TEST_PROFILE;
assert.ok(profile, 'run with node test/run-electron.cjs test/chat-polish-electron.cjs');
app.setPath('userData', profile);
app.setPath('sessionData', profile);

const renderer = fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8');
const fn = name => { const start = renderer.indexOf(`function ${name}(`); return renderer.slice(start, renderer.indexOf('\nfunction ', start + 1)); };
const bots = [
  { id: '1', name: 'Atlas', username: 'atlas_bot', isBot: true, preview: 'Booked the 9:30 call and sent the agenda.', activity: { state: 'active', label: 'typing' } },
  { id: '2', name: 'Scout', username: 'scout_bot', isBot: true, preview: 'Three new leads matched your filter.', unread: true, activity: { state: 'idle' } },
  { id: '3', name: 'Writer — long-form research and implementation companion', username: 'writer_bot', isBot: true, activity: { state: 'idle' } },
  { id: '4', name: 'Ledger', username: 'ledger_bot', isBot: true },
];
const hermesState = {
  status: 'ready', generation: 1,
  target: { url: 'https://hermes.fixture.invalid', label: 'hermes.fixture.invalid', profile: 'default' },
  principal: { userId: 'alex', provider: 'basic' },
  sessions: [{ sessionId: 's-1', sessionKey: 'k1', title: 'Quarterly plan' }],
  selected: { sessionId: 's-1', sessionKey: 'k1', title: 'Quarterly plan' },
  conversation: {
    phase: 'bound', sessionId: 's-1', pendingRequests: [], requestOutcomes: [], transcriptDropped: 0,
    stats: { eventGaps: 0 }, lastSend: null, statusLine: null,
    transcript: [
      { role: 'user', text: 'Summarise the open items from yesterday and draft a reply to Dana.', status: 'complete' },
      { role: 'assistant', text: 'Two items are still open:\n\n1. Contract redlines — waiting on legal.\n2. Hiring loop for the ops role.\n\nDraft reply:\n```\nHi Dana, quick update on both…\n```', status: 'complete',
        tools: [{ name: 'calendar.search', status: 'complete', summary: '4 events' }] },
      { role: 'user', text: 'Send it.', status: 'complete' },
    ],
    turn: { text: 'Sending the reply now…', tools: [{ name: 'mail.send', status: 'running' }] },
  },
  error: null,
};

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({
    cancel: !details.url.startsWith('file:') || /\/renderer\.js$/.test(details.url),
  }));
  const win = new BrowserWindow({ show: false, width: 1280, height: 760, useContentSize: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  await win.loadFile(path.join(__dirname, '../src/index.html'));
  await resizeWindow(win, 1280, 760);
  const js = code => win.webContents.executeJavaScript(code);
  await js(`
    window.workspace = { command: async () => null };
    ${renderer.slice(0, renderer.indexOf('function tabIcon('))}
    ${fn('moveNavigationFocus')}
    ${fn('canFocus')}
    state = { bots: ${JSON.stringify(bots)}, hidden: [], order: ['1', '2', '3', '4'], selectedBotId: '1', primaryBotId: '',
      botSort: 'manual', api: { ready: true }, telegramStatus: 'connected' };
    renderBots();
    document.getElementById('empty-bots').classList.add('hidden');
    document.getElementById('telegram-slot').classList.add('hidden');
    document.getElementById('hermes-pane').classList.remove('hidden');
    document.getElementById('chat-title').textContent = 'Quarterly plan';
    window.HermesView.createHermesView({ root: document.getElementById('hermes-convo'), api: {
      getState: async () => (${JSON.stringify(hermesState)}), command: async () => ({ ok: true }), onState: () => () => {} } });
    undefined;
  `);
  await js('new Promise(r => setTimeout(r, 100))');

  const bg = sel => js(`getComputedStyle(document.querySelector(${JSON.stringify(sel)})).backgroundColor`);
  const resting = await bg('.bot-row[data-bot-id="4"]');
  const selected = await bg('.bot-row.selected');
  const box = await js(`(() => { const r = document.querySelector('.bot-row[data-bot-id="3"]').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
  win.webContents.sendInputEvent({ type: 'mouseMove', x: box.x, y: box.y });
  await js('new Promise(r => setTimeout(r, 250))');
  const hovered = await bg('.bot-row[data-bot-id="3"]');

  const dir = process.env.CHAT_POLISH_SHOTS;
  if (dir) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'chat-and-bots.png'), (await win.webContents.capturePage()).toPNG());
    await js(`document.querySelector('.hermes-composer textarea').focus()`);
    fs.writeFileSync(path.join(dir, 'chat-and-bots-composer-focus.png'), (await win.webContents.capturePage({ x: 0, y: 0, width: 760, height: 760 })).toPNG());
    console.log(`Saved screenshots to ${dir}`);
  }
  const rows = await js(`[...document.querySelectorAll('#bot-list .bot-row')].map(r => r.getBoundingClientRect().height)`);
  assert.equal(rows.length, bots.length);
  for (const height of rows) assert.ok(height >= 44 && height <= 60, `bot rows stay dense but tappable: ${height}`);

  assert.notEqual(hovered, resting, 'hover is visible');
  assert.notEqual(selected, hovered, 'selection reads differently from hover');
  assert.equal(await js(`getComputedStyle(document.querySelector('.bot-row[data-bot-id="3"] .bot-hide')).display`), 'block', 'hover reveals hide');
  assert.equal(await js(`document.querySelector('.bot-row[data-bot-id="3"] .bot-name').scrollWidth > document.querySelector('.bot-row[data-bot-id="3"] .bot-name').clientWidth`), true, 'long name truncates');

  const msg = await js(`(() => { const s = getComputedStyle(document.querySelector('.hermes-msg.assistant')); return { size: parseFloat(s.fontSize), line: parseFloat(s.lineHeight) }; })()`);
  assert.ok(msg.size >= 13 && msg.line / msg.size >= 1.45, `chat text stays readable: ${JSON.stringify(msg)}`);
  assert.equal(await js(`getComputedStyle(document.querySelector('.hermes-code')).fontFamily.includes('monospace')`), true, 'code is monospaced');
  assert.equal(await js(`document.querySelector('.hermes-transcript').scrollWidth <= document.querySelector('.hermes-transcript').clientWidth`), true, 'no horizontal transcript scroll');
  console.log('PASS: bot list density, hover/selection states and chat typography');

  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
