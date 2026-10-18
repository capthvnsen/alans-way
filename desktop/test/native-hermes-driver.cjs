'use strict';
// Electron main-process driver for the native Hermes acceptance run.
// Spawned by test/native-hermes-acceptance.cjs INSIDE test/native-hermes-boundaries.cjs
// (the fixture-only boundary module is the Electron entry; it requires this
// file last, after every guard is installed and probed fail-closed):
// Loads production src/main.cjs unchanged, then drives the actual DOM +
// window.hermes IPC surface and writes a JSON report to $NHC_REPORT.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { app, BrowserWindow, webContents, session } = require('electron');

const profile = process.env.HERMES_WORKSPACE_DATA;
const BACKEND = process.env.NHC_BACKEND_URL;
const USERNAME = process.env.NHC_USERNAME;
const PASSWORD = process.env.NHC_PASSWORD;
const REPORT = process.env.NHC_REPORT;
const { prepareFixture, quitFixture } = require('./electron-fixture.cjs');
prepareFixture(profile);
fs.writeFileSync(path.join(profile, 'preferences.json'), JSON.stringify({ onboarded: true }));
require('../src/main.cjs');

const report = { finished: false, checks: [], failed: [] };
const snap = async (wc, name) => {
  try {
    const img = await wc.capturePage();
    fs.writeFileSync(path.join(path.dirname(REPORT), `shot-${name}.png`), img.toPNG());
    report.checks.push({ at: Date.now(), id: `screenshot:${name}`, ok: true, detail: `shot-${name}.png ${img.getSize().width}x${img.getSize().height}` });
  } catch (e) { report.checks.push({ at: Date.now(), id: `screenshot:${name}`, ok: false, detail: String(e) }); }
};
const rec = (id, ok, detail) => {
  report.checks.push({ at: Date.now(), id, ok: !!ok, detail });
  if (!ok) report.failed.push(id);
};
const writeReport = () => { try { fs.writeFileSync(REPORT, JSON.stringify(report, null, 2)); } catch (e) { console.error('report write', e); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const waitFor = async (read, predicate, timeout = 30000, label = '') => {
  const deadline = Date.now() + timeout;
  let value;
  while (Date.now() < deadline) {
    try { value = await read(); } catch (e) { value = { __err: String(e && e.message || e) }; }
    if (predicate(value)) return value;
    await sleep(120);
  }
  throw new Error(`timeout waiting ${label}: ${JSON.stringify(value)?.slice(0, 400)}`);
};

app.whenReady().then(async () => {
  const win = await waitFor(() => BrowserWindow.getAllWindows()[0], Boolean, 20000, 'main window');
  const wc = win.webContents;
  const telegram = webContents.getAllWebContents().find((item) => item.session === session.fromPartition('persist:telegram'));
  if (telegram) { telegram.stop(); await telegram.loadURL('about:blank'); }
  const evaluate = (code) => wc.executeJavaScript(code);
  await waitFor(() => evaluate('typeof window.hermes === "object" && typeof window.hermes.command === "function"').catch(() => false), Boolean, 20000, 'hermes preload bridge');
  rec('preload-hermes-bridge', true);

  const hget = () => evaluate('window.hermes.getState()');
  const hcmd = (name, value) => evaluate(`window.hermes.command(${JSON.stringify(name)}, ${JSON.stringify(value || {})}).then(r => ({ok:true,r})).catch(e => ({ok:false,err:String(e && e.message || e)}))`);
  const wcmd = (name, value) => evaluate(`window.workspace.command(${JSON.stringify(name)}, ${JSON.stringify(value || {})}).then(r => ({ok:true,r})).catch(e => ({ok:false,err:String(e && e.message || e)}))`);

  // ── unconfigured → configure → auth-gated connect ──
  let st = await hget();
  rec('starts-unconfigured', ['unconfigured', 'disconnected'].includes(st.status), st.status);
  let r = await hcmd('configure', { url: BACKEND });
  rec('configure-accepted', r.ok === true, r);
  st = await hget();
  rec('target-shows-real-url', st.target && st.target.url === BACKEND, st.target);

  r = await hcmd('connect', {});
  st = await hget();
  rec('auth-gate-needs-signin', st.status === 'needs_signin' && st.authRequired === true, { status: st.status, authRequired: st.authRequired, err: r.err });

  // Wrong password must not mint a session.
  r = await hcmd('sign-in', { provider: 'basic', username: USERNAME, password: 'definitely-wrong' });
  st = await hget();
  rec('wrong-password-no-session', r.ok === false && st.status !== 'ready', { err: r.err, status: st.status });

  r = await hcmd('sign-in', { provider: 'basic', username: USERNAME, password: PASSWORD });
  st = await hget();
  rec('signin-connects', r.ok === true && st.status === 'ready', { status: st.status, err: r.err, principal: st.principal });
  rec('principal-is-real-user', st.principal && st.principal.userId === USERNAME, st.principal);
  await snap(wc, 'signed-in');

  // ── Hermes pane over the chat surface; Telegram stays reachable ──
  await wcmd('show-hermes');
  await waitFor(() => evaluate('!document.getElementById("hermes-pane").classList.contains("hidden")'), Boolean, 10000, 'hermes pane visible');
  rec('hermes-pane-visible', true);
  // Telegram must remain reachable in parallel (checked again at the end).
  rec('telegram-slot-hidden-under-hermes',
    await evaluate('document.getElementById("telegram-slot").classList.contains("hidden")') === true);

  // ── two sessions, both created through the real gateway ──
  r = await hcmd('new-session');
  rec('session-one-created', r.ok === true, r);
  const sid1 = r.r && r.r.sessionId;
  r = await hcmd('new-session');
  const sid2 = r.r && r.r.sessionId;
  rec('two-live-sessions', !!(sid1 && sid2 && sid1 !== sid2), { sid1, sid2 });
  st = await hget();
  rec('sidebar-lists-both', Array.isArray(st.sessions) && st.sessions.filter((s) => s.id === sid1 || s.id === sid2).length === 2, st.sessions && st.sessions.map((s) => s.id));

  // Select session 1; composer usable.
  await hcmd('select', { sessionId: sid1 });
  st = await waitFor(async () => (await hget()), (s) => s.conversation && s.conversation.phase === 'bound', 20000, 'controller bound');
  rec('controller-bound', true, { phase: st.conversation.phase });
  await waitFor(() => evaluate('(() => { const t = document.querySelector("#hermes-convo textarea"); return t && !t.disabled; })()'), Boolean, 10000, 'composer enabled');

  // ── send a hostile-markup turn through the real DOM composer ──
  const hostile = '<img src=x onerror=alert(9)><script>alert(1)</script>';
  await evaluate(`(() => {
    const t = document.querySelector('#hermes-convo textarea');
    t.value = ${JSON.stringify(hostile)};
    t.dispatchEvent(new Event('input', { bubbles: true }));
    t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true; })()`);
  // The scripted provider echoes the text; transcript must hold it as TEXT only.
  await waitFor(() => evaluate(`(() => {
    const tr = document.querySelector('#hermes-convo .hermes-transcript');
    return tr && tr.textContent.includes('CRITIC_ECHO'); })()`), Boolean, 60000, 'streamed echo row');
  rec('streamed-echo-rendered', true);
  const noImg = await evaluate('document.querySelectorAll("#hermes-convo img, #hermes-convo script").length');
  const hasText = await evaluate(`document.querySelector('#hermes-convo .hermes-transcript').textContent.includes(${JSON.stringify('<img src=x onerror=alert(9)>')})`);
  rec('hostile-markup-literal', noImg === 0 && hasText === true, { noImg, hasText });

  // ── clarify request crosses the tool boundary into a real card ──
  await evaluate(`(() => {
    const t = document.querySelector('#hermes-convo textarea');
    t.value = 'CRITIC_ASK fruit';
    t.dispatchEvent(new Event('input', { bubbles: true }));
    t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true; })()`);
  await waitFor(() => evaluate('(() => { const c = document.querySelector("#hermes-convo .hermes-card"); return c && c.textContent.includes("Pick a fixture fruit"); })()'), Boolean, 60000, 'clarify card');
  rec('clarify-card-rendered', true);
  await evaluate(`(() => {
    const i = document.querySelector('#hermes-convo .hermes-answer-input');
    i.value = 'Fig';
    i.dispatchEvent(new Event('input', { bubbles: true }));
    [...document.querySelectorAll('#hermes-convo button')].find((b) => b.textContent === 'Send answers').click();
    return true; })()`);
  await waitFor(() => evaluate(`(() => {
    const tr = document.querySelector('#hermes-convo .hermes-transcript');
    return tr && tr.textContent.includes('CRITIC_TOOL_RESULT'); })()`), Boolean, 60000, 'answer echoed across tool boundary');
  const answerInEcho = await evaluate(`document.querySelector('#hermes-convo .hermes-transcript').textContent.includes('Fig')`);
  rec('clarify-answered-through-ui', answerInEcho === true, { answerInEcho });
  await snap(wc, 'clarify-answered');

  // ── stop a mid-turn request ──
  await evaluate(`(() => {
    const t = document.querySelector('#hermes-convo textarea');
    t.value = 'CRITIC_HOLD now';
    t.dispatchEvent(new Event('input', { bubbles: true }));
    t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true; })()`);
  await waitFor(() => evaluate('(() => { const b = document.querySelector("#hermes-convo .hermes-stop"); return b && !b.disabled && !b.classList.contains("hidden"); })()'), Boolean, 30000, 'stop visible during stream/hold');
  await evaluate('document.querySelector("#hermes-convo .hermes-stop").click()');
  await waitFor(async () => (await hget()), (s) =>
    s.conversation && (s.conversation.lastInterrupt || s.conversation.turn === null), 30000, 'stop outcome');
  st = await hget();
  rec('stop-resolved', !!(st.conversation && (st.conversation.lastInterrupt || st.conversation.turn === null)),
    { interrupt: st.conversation?.lastInterrupt, turn: st.conversation?.turn && { streaming: st.conversation.turn.streaming } });

  // ── draft survives an exact session switch ──
  await hcmd('select', { sessionId: sid2 });
  await waitFor(async () => (await hget()), (s) => s.selected && s.selected.sessionId === sid2 && s.conversation && s.conversation.phase === 'bound', 15000, 'bound session 2');
  await evaluate(`(() => {
    const t = document.querySelector('#hermes-convo textarea');
    t.value = 'DRAFT-KEEP-123';
    t.dispatchEvent(new Event('input', { bubbles: true }));
    t.focus();
    return document.activeElement === t; })()`);
  await hcmd('select', { sessionId: sid1 });
  await waitFor(async () => (await hget()), (s) => s.selected && s.selected.sessionId === sid1 && s.conversation && s.conversation.phase === 'bound', 15000, 'back on session 1');
  // The DOM reflects the renderer's last-applied broadcast, which can lag the
  // command result — wait on the DOM itself, not the main-process state. The
  // textarea still holds focus: the composer must reload for the new target,
  // not pin session 2's draft onto session 1.
  await waitFor(() => evaluate('document.querySelector("#hermes-convo textarea").value'), (v) => v === '', 15000, 'composer cleared on switch');
  const cleared = await evaluate('document.querySelector("#hermes-convo textarea").value');
  await hcmd('select', { sessionId: sid2 });
  await waitFor(async () => (await hget()), (s) => s.selected && s.selected.sessionId === sid2 && s.conversation && s.conversation.phase === 'bound', 15000, 'session 2 again');
  await waitFor(() => evaluate('document.querySelector("#hermes-convo textarea").value'), (v) => v === 'DRAFT-KEEP-123', 15000, 'draft restored');
  const draftBack = await evaluate('document.querySelector("#hermes-convo textarea").value');
  rec('draft-survives-switch', cleared === '' && draftBack === 'DRAFT-KEEP-123', { cleared, draftBack });
  // Immediate Send on the restored draft lands on session 2, never session 1.
  await evaluate(`(() => {
    const t = document.querySelector('#hermes-convo textarea');
    t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true; })()`);
  const sendTarget = await waitFor(async () => (await hget()), (s) => s.conversation && s.conversation.lastSend && s.conversation.lastSend.target && s.conversation.lastSend.target.sessionId, 15000, 'send admitted').catch(() => null);
  const sendSid = sendTarget && sendTarget.conversation && sendTarget.conversation.lastSend && sendTarget.conversation.lastSend.target ? sendTarget.conversation.lastSend.target.sessionId : null;
  rec('send-hits-selected-session', sendSid === sid2, { sendSid, expected: sid2 });
  // The focused editor must clear once the backend admits the exact submitted
  // text — the draft surviving in the map alone is the DRAFT-KEEP-123 bug.
  const admitted = await waitFor(async () => (await hget()), (s) => s.conversation && s.conversation.lastSend && s.conversation.lastSend.outcome === 'admitted' && s.conversation.lastSend.target && s.conversation.lastSend.target.sessionId === sid2 && s.conversation.lastSend.text === 'DRAFT-KEEP-123', 15000, 'admitted outcome lands').catch(() => null);
  const editorAfterAdmit = admitted
    ? await waitFor(() => evaluate('document.querySelector("#hermes-convo textarea").value'), (v) => v === '', 15000, 'focused editor cleared on admit').then(() => '').catch(() => 'TIMEOUT')
    : 'NO-ADMIT';
  rec('focused-admitted-clears-editor', editorAfterAdmit === '', { admitted: !!admitted, editorAfterAdmit });

  // ── narrow window: composer still usable ──
  // The production minimum (1120x680) would clamp setSize — lower it first so
  // the 640px capture actually exercises the narrow layout, then assert the
  // real inner width.
  win.setMinimumSize(320, 320);
  win.setSize(640, 480);
  await sleep(400);
  const innerW = await evaluate('window.innerWidth');
  rec('narrow-width-actual', innerW === 640, innerW);
  const narrow = await evaluate(`(() => {
    const t = document.querySelector('#hermes-convo textarea');
    const r = t.getBoundingClientRect();
    return r.width > 100 && r.height > 20 && r.left >= 0 && r.right <= window.innerWidth + 0.5;
  })()`);
  rec('narrow-composer-usable', narrow === true);
  // The Send button must be fully reachable — nothing may paint it offscreen.
  const sendVisible = await evaluate(`(() => {
    const b = document.querySelector('#hermes-convo .hermes-send');
    if (!b) return false;
    const r = b.getBoundingClientRect();
    return r.width > 20 && r.right <= window.innerWidth + 0.5 && r.bottom <= window.innerHeight + 0.5;
  })()`);
  rec('narrow-send-onscreen', sendVisible === true);
  // The remote preview card must not paint over the chat surface. Its layout
  // box can extend past a collapsed workspace pane — what matters is the
  // painted part, i.e. the layout box clipped by the pane (or unclipped when
  // the browser-hidden mode floats it position:fixed).
  const previewClear = await evaluate(`(() => {
    const pane = document.querySelector('.workspace-pane').getBoundingClientRect();
    const convo = document.getElementById('hermes-convo').getBoundingClientRect();
    const overlaps = (el) => {
      if (!el || el.classList.contains('hidden')) return false;
      const r = el.getBoundingClientRect();
      const fixed = getComputedStyle(el).position === 'fixed';
      const clip = fixed ? { left: -1e9, right: 1e9, top: -1e9, bottom: 1e9 } : pane;
      const vis = { left: Math.max(r.left, clip.left), right: Math.min(r.right, clip.right),
                    top: Math.max(r.top, clip.top), bottom: Math.min(r.bottom, clip.bottom) };
      if (vis.right - vis.left < 2 || vis.bottom - vis.top < 2) return false;
      return !(vis.right <= convo.left || vis.left >= convo.right || vis.bottom <= convo.top || vis.top >= convo.bottom);
    };
    return !overlaps(document.getElementById('remote-preview-slot'))
        && !overlaps(document.getElementById('preview-chip'));
  })()`);
  rec('preview-not-over-composer', previewClear === true);
  // The Telegram empty-state promo must be bounded inside the bot region so it
  // can never paint over the Hermes section below it.
  const sidebarClear = await evaluate(`(() => {
    const promo = document.getElementById('empty-bots');
    const hermes = document.querySelector('.hermes-caption');
    if (!promo || promo.classList.contains('hidden') || !hermes) return true;
    const region = promo.closest('.bot-region');
    if (!region) return false;
    return region.getBoundingClientRect().bottom <= hermes.getBoundingClientRect().top;
  })()`);
  rec('sidebar-empty-no-collision', sidebarClear === true);
  await snap(wc, 'narrow-640');
  win.setMinimumSize(1120, 680);
  win.setSize(1100, 720);

  // ── Telegram route preserved ──
  await wcmd('show-telegram');
  await sleep(300);
  const teleBack = await evaluate('document.getElementById("hermes-pane").classList.contains("hidden")');
  rec('telegram-route-preserved', teleBack === true);
  await wcmd('show-hermes');

  // ── disconnect → reconnect via the persisted refresh token ──
  r = await hcmd('disconnect');
  st = await hget();
  rec('disconnect-honest', st.status === 'disconnected', st.status);
  r = await hcmd('connect');
  st = await waitFor(() => hget(), (s) => s.status === 'ready' || s.status === 'error' || s.status === 'needs_signin', 30000, 'reconnect settles');
  rec('reconnect-with-stored-token', st.status === 'ready', { status: st.status, error: st.error });

  // ── adverse EOF mid-submit: a durable review-required tombstone, no replay ──
  // send() marks lastSend 'inflight' synchronously before its wire call, so a
  // send+disconnect fired in one evaluate leaves the submit in flight when
  // teardown runs — a genuine delivery-uncertain cut, not a simulated one.
  const eofText = 'EOF-RACE-DO-NOT-REPLAY';
  const cardProbe = `(() => {
    const c = document.querySelector('#hermes-convo .hermes-card.uncertain');
    if (!c) return false;
    const r = c.getBoundingClientRect();
    return r.width > 10 && r.height > 10 && c.textContent.includes(${JSON.stringify(eofText)});
  })()`;
  await evaluate(`(() => {
    window.hermes.command('send', { sessionId: ${JSON.stringify(sid2)}, text: ${JSON.stringify(eofText)} });
    window.hermes.command('disconnect', {});
    return true; })()`);
  await waitFor(() => hget(), (s) => s.status === 'error' || s.status === 'disconnected', 15000, 'EOF teardown settles');
  const tomb = (await hget()).uncertain;
  rec('adverse-eof-tombstone', !!(tomb && tomb.sessionId === sid2 && tomb.text === eofText), tomb || 'none');
  const cardVisible = await waitFor(() => evaluate(cardProbe), Boolean, 15000, 'tombstone card visible').catch(() => false);
  rec('adverse-eof-durable-card', cardVisible === true, cardVisible);
  // Reconnect + rebind: the review-required state must survive a fresh
  // controller, and the rebound transcript may hold the text at most once.
  await hcmd('connect');
  st = await waitFor(() => hget(), (s) => s.status === 'ready', 30000, 'reconnect after EOF');
  await hcmd('select', { sessionId: sid2 });
  await waitFor(async () => (await hget()), (s) => s.selected && s.selected.sessionId === sid2 && s.conversation && s.conversation.phase === 'bound', 15000, 'rebound after EOF');
  const tombAfter = (await hget()).uncertain;
  const cardAfter = await waitFor(() => evaluate(cardProbe), Boolean, 15000, 'tombstone card after reconnect').catch(() => false);
  rec('adverse-eof-survives-reconnect', !!(tombAfter && tombAfter.sessionId === sid2 && cardAfter === true), { tomb: tombAfter, cardAfter });
  const dupes = ((await hget()).conversation?.transcript || []).filter((row) => row.role === 'user' && row.text === eofText).length;
  rec('adverse-eof-no-replay', dupes <= 1, { userRowsWithText: dupes });
  // The only way the review state clears is the deliberate, session-fenced dismiss.
  await hcmd('uncertain-dismiss', { sessionId: sid2 });
  const stAfterDismiss = await hget();
  const cardGone = await waitFor(() => evaluate(cardProbe), (v) => v === false, 15000, 'card dismissed').then(() => true).catch(() => false);
  rec('adverse-eof-dismiss-clears', stAfterDismiss.uncertain === null && cardGone === true, { uncertain: stAfterDismiss.uncertain, cardGone });

  report.finished = true;
  writeReport();
}).catch((error) => {
  console.error('driver fatal', error);
  report.finished = true;
  rec('driver-fatal', false, String(error && error.stack || error));
  writeReport();
}).finally(() => {
  setTimeout(() => quitFixture(), 500);
});
