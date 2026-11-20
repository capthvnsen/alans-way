// Run: node test/run-electron.cjs test/footer-status-electron.cjs
// The main screen has no footer: versions, the release channel and the connector status live in Settings → About, and only
// a real problem (connector down) or an available update reaches the main screen, as a banner, a gear dot and an Update pill.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, Menu } = require('electron');
const { prepareFixture, quitFixture } = require('./electron-fixture.cjs');
const profile = process.env.HERMES_TEST_PROFILE;
assert.ok(profile, 'run with node test/run-electron.cjs test/footer-status-electron.cjs');
prepareFixture(profile);
fs.writeFileSync(path.join(profile, 'preferences.json'), JSON.stringify({ onboarded: true, preview: false, bots: [{ id: '1001', isBot: true, name: 'Alan' }], selectedBotId: '1001' }));
require('../src/main.cjs');
const until = async (read, why, ms = 15000) => { const end = Date.now() + ms; for (;;) { const v = await read(); if (v) return v; if (Date.now() > end) throw new Error(`Timed out: ${why}`); await new Promise(r => setTimeout(r, 40)); } };

(async () => {
  const win = await until(() => BrowserWindow.getAllWindows()[0], 'workspace window');
  const shell = win.webContents;
  await until(() => !shell.isLoading() && shell.getURL().endsWith('index.html'), 'workspace page');
  const run = (js) => shell.executeJavaScript(js);
  await until(() => run('typeof state === "object" && !!state?.api'), 'first state');
  const patch = (extra) => run(`render({ ...JSON.parse(JSON.stringify(state)), uiStateRevision: (state.uiStateRevision ?? 0) + 100000, ...${JSON.stringify(extra)} })`);

  // No footer, no version, status or channel on the main screen; the footer's controls are gone with it.
  const gone = ['workspace-footer', 'version-label', 'update-all', 'build-badge', 'workspace-status', 'connection-status', 'status-more', 'status-panel', 'shortcuts-button'];
  assert.deepEqual(await run(`${JSON.stringify(gone)}.filter(id => document.getElementById(id) || document.querySelector('.' + id))`), [], 'the footer is gone');
  assert.equal(await run('document.body.innerText.includes("Browser connector ready") || /\\bv?\\d+\\.\\d+\\.\\d+/.test(document.querySelector("#shell").innerText.replace(/\\s+/g, " ").replace(/\\d+px/g, ""))'), false, 'no ready text or version number anywhere on the main screen');
  await until(() => run('state.api.ready'), 'the connector ready');
  assert.equal(await run('document.getElementById("connector-banner").classList.contains("hidden")'), true, 'ready shows nothing');
  assert.equal(await run('[...document.querySelectorAll(".bridge-dot")].every(dot => dot.classList.contains("hidden"))'), true, 'no dot on the gear while all is well');
  assert.equal(await run('document.getElementById("update-note").classList.contains("hidden")'), true, 'no Update pill without an update');
  const bottom = await run('document.querySelector(".workspace-pane").getBoundingClientRect().bottom - document.getElementById("browser-slot").getBoundingClientRect().bottom');
  assert.ok(bottom <= 16, `the page frame runs to the bottom of the window, ${bottom}px`);

  // Every remaining icon button has a tooltip and an accessible name, and every visible control is at least a 24px target.
  assert.deepEqual(await run(`[...document.querySelectorAll('#shell button')].filter(b => b.offsetParent && !b.textContent.trim() && !b.getAttribute('aria-label')).map(b => b.id || b.className)`), [], 'every icon button has an accessible name');
  assert.deepEqual(await run(`[...document.querySelectorAll('#shell .icon-button')].filter(b => !b.title).map(b => b.id || b.className)`), [], 'and a tooltip');
  assert.deepEqual(await run(`[...document.querySelectorAll('#shell button')].filter(b => b.offsetParent && (b.getBoundingClientRect().width < 24 || b.getBoundingClientRect().height < 24)).map(b => (b.id || b.className) + ' ' + Math.round(b.getBoundingClientRect().width) + 'x' + Math.round(b.getBoundingClientRect().height))`), [], 'hit targets are at least 24px');

  // A real connector error is announced and reachable; an update gets the pill and a dot.
  await patch({ api: { ready: false, error: 'listen EADDRINUSE' } });
  assert.equal(await run('document.getElementById("connector-banner").classList.contains("hidden")'), false, 'a failed connector shows a banner');
  assert.match(await run('document.getElementById("connector-banner-text").textContent'), /connector is unavailable/);
  assert.equal(await run('document.getElementById("connector-banner").getAttribute("role")'), 'alert');
  assert.equal(await run('document.querySelector("#settings-button .bridge-dot").dataset.tone'), 'danger');
  assert.match(await run('document.getElementById("settings-button").getAttribute("aria-label")'), /unavailable/);
  await run('document.getElementById("connector-banner-details").click()');
  await until(() => run('!!document.getElementById("settings-about")'), 'About opened from the banner');
  assert.match(await run('document.getElementById("settings-about").textContent'), /Browser connectorUnavailable/);
  await run('document.getElementById("modal-close").click()');
  await patch({ api: { ready: true }, update: { available: '9.9.9', ready: false, busy: false, error: '', justUpdatedFrom: '', popup: false, vms: [] } });
  assert.equal(await run('document.getElementById("connector-banner").classList.contains("hidden")'), true);
  assert.equal(await run('document.getElementById("update-note").textContent'), 'Update');
  assert.equal(await run('document.querySelector("#settings-button .bridge-dot").dataset.tone'), 'accent');

  // Settings → About carries what the footer did: version, channel, Hermes, plugin, connector; Shortcuts too.
  await run('document.getElementById("settings-button").click()');
  await until(() => run('!!document.getElementById("settings-category-about")'), 'Settings');
  await run('document.getElementById("settings-category-about").click()');
  const about = await until(() => run('document.getElementById("settings-about")?.textContent'), 'the About section');
  assert.ok(about.includes(`v${app.getVersion()}`), `the app version is in About: ${about}`);
  assert.match(about, /Release channel/);
  assert.match(about, /Browser connectorReady/);
  assert.deepEqual(await run('[...document.querySelectorAll("#settings-content .about-actions button")].map(b => b.textContent)'), ['Release notes', 'Review updates', 'Keyboard shortcuts']);
  await run('document.getElementById("modal-close").click()');
  assert.equal(Menu.getApplicationMenu().getMenuItemById('workspace-shortcuts').accelerator, 'CmdOrCtrl+/', 'Shortcuts keep a key');
  console.log('PASS: no footer; About carries versions, channel and connector; only errors and updates reach the main screen.');
  quitFixture();
})().catch((error) => { console.error(error.stack || error); app.exit(1); });
