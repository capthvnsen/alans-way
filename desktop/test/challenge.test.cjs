// CAPTCHA and bot-check handling. The detector runs against fixture pages in a
// real headless Chromium (skipped when no Chrome is found; set
// HERMES_TEST_CHROME); the back-off, release note, resume watch and viewer
// address are plain functions.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { CDP } = require('../src/cdp.cjs');
const { challengeExpression, challengeHitExpression, challengeProbeExpression, readEffect } = require('../src/browser-page.cjs');
const { rawInputTarget } = require('../src/agent-input.cjs');
const { challengeReply, captchaHandback, captchaWatchStep, viewerUrl } = require('../src/core.cjs');

test('a second challenge from the same site within ten minutes tells the bot to back off', () => {
  const tab = {}, t0 = 1_000_000;
  const first = challengeReply(tab, 'https://www.google.com/sorry/index', { kind: 'google_sorry', blocking: true }, t0);
  assert.deepEqual(first, { kind: 'google_sorry', blocking: true });
  // The same challenge seen on the next read is the same encounter.
  assert.equal(challengeReply(tab, 'https://www.google.com/sorry/index', { kind: 'google_sorry', blocking: true }, t0 + 1000).backOff, undefined);
  // A clean read ends it; another site does not count toward this one.
  challengeReply(tab, 'https://www.google.com/search', null, t0 + 2000);
  assert.equal(challengeReply(tab, 'https://bing.com/', { kind: 'turnstile', blocking: false }, t0 + 3000).backOff, undefined);
  challengeReply(tab, 'https://bing.com/', null, t0 + 4000);
  const second = challengeReply(tab, 'https://www.google.com/sorry/index?x=2', { kind: 'recaptcha', blocking: true }, t0 + 5 * 60000);
  assert.equal(second.backOff, true);
  assert.match(second.advice, /^www\.google\.com has challenged 2 times in 10 minutes\. Stop retrying it and use another source\.$/);
  // Past the window the count starts over.
  challengeReply(tab, 'https://www.google.com/', null, t0 + 6 * 60000);
  assert.equal(challengeReply(tab, 'https://www.google.com/sorry/index', { kind: 'google_sorry', blocking: true }, t0 + 16 * 60000).backOff, undefined);
  assert.equal(challengeReply({}, 'https://x.example/', null), undefined);
});

test('the automatic release names the site and the kind of check', () => {
  const h = captchaHandback('https://www.google.com/sorry/index?continue=x', { kind: 'google_sorry', blocking: true });
  assert.deepEqual(h, { reason: 'captcha', note: 'Solve the Google "unusual traffic" check on www.google.com. The tab goes back to the agent once it clears.', auto: true, challenge: 'google_sorry' });
  assert.match(captchaHandback('https://shop.example/', { kind: 'hcaptcha' }).note, /^Solve the hCaptcha on shop\.example\./);
  assert.ok(captchaHandback(`https://${'a'.repeat(200)}.example/`, { kind: 'arkose' }).note.length <= 140);
  // A back-off rides on the handback, so the bot still hears it after the tab comes back.
  const repeat = captchaHandback('https://www.google.com/sorry/index', { kind: 'google_sorry', blocking: true, backOff: true, advice: 'Stop retrying it.' });
  assert.equal(repeat.backOff, true); assert.equal(repeat.advice, 'Stop retrying it.');
});

test('the watch hands back only after a challenge it saw has cleared twice in a row and nobody is typing', () => {
  const step = (watch, probe) => captchaWatchStep(watch, probe);
  let w = { seen: false, clear: 0, typing: '' };
  // A bot's own captcha release on a page with no known challenge never auto-returns.
  for (let i = 0; i < 5; i++) w = step(w, { challenge: null, loading: false, typing: '' });
  assert.equal(w.resume, false);
  w = step(w, { challenge: { kind: 'recaptcha', blocking: false }, loading: false, typing: '' });
  assert.equal(w.seen, true);
  w = step(w, { challenge: null, loading: true, typing: '' });
  assert.equal(w.clear, 0, 'a loading page is not clear yet');
  w = step(w, { challenge: null, loading: false, typing: '' });
  assert.equal(w.resume, false, 'one clear read is not enough');
  w = step(w, { challenge: null, loading: false, typing: '5:abc' });
  assert.equal(w.resume, false, 'the person typed between reads');
  w = step(w, { challenge: null, loading: false, typing: '5:abc' });
  assert.equal(w.resume, false);
  w = step(w, { challenge: null, loading: false, typing: '5:abc' });
  assert.equal(w.resume, true);
  assert.equal(step({ seen: true, clear: 1, typing: '' }, null).clear, 0, 'an unreadable page (mid-navigation) restarts the count');
});

test('the viewer address keeps no password, token or fragment', () => {
  assert.equal(viewerUrl('http://100.64.0.2:6080/vnc.html?autoconnect=1&password=hunter2&path=websockify#password=x'), 'http://100.64.0.2:6080/vnc.html?autoconnect=1&path=websockify');
  assert.equal(viewerUrl('https://u:p@desk.example/vnc.html?token=abc&apiKey=1'), 'https://desk.example/vnc.html');
  assert.equal(viewerUrl('http://desk.example/vnc.html?pw=1&sig=2&jwt=3&resize=scale'), 'http://desk.example/vnc.html?resize=scale', 'only noVNC settings survive');
  assert.equal(viewerUrl('ws://desk.example/websockify'), '');
  assert.equal(viewerUrl(''), '');
  assert.equal(viewerUrl(undefined), '');
});

test('raw CDP input is aimed at every point it lands on, or at the focus for keys', () => {
  assert.deepEqual(rawInputTarget('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 1, y: 2 }, { x: 3, y: 4 }] }).points.slice(1), [{ x: 1, y: 2 }, { x: 3, y: 4 }]);
  assert.equal(rawInputTarget('Input.dispatchMouseEvent', { x: 5, y: 6 }).keyboard, false);
  assert.deepEqual(rawInputTarget('Input.insertText', { text: 'hi' }), { points: [], keyboard: true });
  assert.equal(rawInputTarget('Input.dispatchKeyEvent', { type: 'keyDown' }).keyboard, true);
});

test('a Cloudflare interstitial that clears by itself is waited out, so the reply shows the real page', async () => {
  let cleared = false, challengeReads = 0;
  const page = (challenge) => ({ title: challenge ? 'Just a moment...' : 'Results', url: challenge ? 'https://x.example/' : 'https://x.example/results', sameDoc: false, challenge,
    loading: false, text: challenge ? 'Verify you are human' : 'Ten results', textSig: '', elements: [], seq: 0, gone: [], overlays: [], truncated: { text: false, elements: false } });
  const execute = async (code) => {
    if (code.startsWith('(async')) return page(cleared ? null : { kind: 'cloudflare', blocking: true });
    challengeReads++;
    if (challengeReads === 2) { cleared = true; throw new Error('Execution context was destroyed.'); }
    return cleared ? null : { kind: 'cloudflare', blocking: true };
  };
  const tab = { refs: new Set() };
  const reply = await readEffect(execute, tab, { navigated: true });
  assert.equal(reply.challenge, undefined);
  assert.equal(reply.effect.url, 'https://x.example/results');
  assert.equal(reply.effect.navigated, true);
  // One that stays is reported once the wait runs out.
  const stuck = await readEffect(async (code) => code.startsWith('(async') ? page({ kind: 'cloudflare', blocking: true }) : { kind: 'cloudflare', blocking: true }, { refs: new Set() }, { navigated: true, cloudflareWaitMs: 600 });
  assert.deepEqual(stuck.challenge, { kind: 'cloudflare', blocking: true });
});

function findChrome() {
  const home = os.homedir();
  const globs = (dir, rx) => { try { return fs.readdirSync(dir).filter((n) => rx.test(n)).map((n) => path.join(dir, n)); } catch { return []; } };
  const candidates = [
    process.env.HERMES_TEST_CHROME,
    ...globs(path.join(home, '.agent-browser', 'browsers'), /^chrome-/).map((d) => path.join(d, 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')),
    ...globs(path.join(home, 'Library/Caches/ms-playwright'), /^chromium-\d+$/).flatMap((d) => globs(d, /^chrome-/).map((e) => path.join(e, 'Chromium.app/Contents/MacOS/Chromium'))),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ...['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].flatMap((n) => (process.env.PATH || '').split(path.delimiter).map((d) => path.join(d, n))),
  ];
  return candidates.find((file) => file && fs.existsSync(file));
}
const chrome = findChrome();
const skip = !chrome && 'no Chrome found (set HERMES_TEST_CHROME)';
const fixtures = path.join(__dirname, 'fixtures', 'challenges');
let browser, dir, site, port, cdp;
before(async () => {
  if (!chrome) return;
  site = http.createServer((req, res) => {
    const name = new URL(req.url, 'http://x').pathname === '/sorry/index' ? 'google-sorry' : path.basename(new URL(req.url, 'http://x').pathname);
    const file = path.join(fixtures, `${name}.html`);
    res.setHeader('content-type', 'text/html');
    res.end(fs.existsSync(file) ? fs.readFileSync(file) : '<title>fixture</title>');
  });
  port = await new Promise((resolve) => site.listen(0, '127.0.0.1', () => resolve(site.address().port)));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-challenge-'));
  // Every host resolves to this machine, so the widgets' real frame addresses
  // fail fast instead of reaching Google or Cloudflare.
  browser = spawn(chrome, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run', '--no-sandbox',
    '--host-resolver-rules=MAP * 127.0.0.1', 'about:blank'], { stdio: 'ignore' });
  const portFile = path.join(dir, 'DevToolsActivePort');
  for (const deadline = Date.now() + 60000; !fs.existsSync(portFile);) {
    assert.ok(Date.now() < deadline && browser.exitCode === null, 'Chrome never published its debugging port');
    await new Promise((r) => setTimeout(r, 100));
  }
  const cdpPort = fs.readFileSync(portFile, 'utf8').split('\n')[0];
  for (const deadline = Date.now() + 60000; ;) {
    if (await fetch(`http://127.0.0.1:${cdpPort}/json/version`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false)) break;
    assert.ok(Date.now() < deadline, 'Chrome never answered /json/version');
    await new Promise((r) => setTimeout(r, 100));
  }
  cdp = await CDP.connect(`http://127.0.0.1:${cdpPort}`);
});
after(async () => {
  site?.close();
  try { cdp?.socket.close(); } catch {}
  if (browser && browser.exitCode === null) await new Promise((resolve) => { browser.once('exit', resolve); browser.kill(); setTimeout(() => { browser.kill('SIGKILL'); resolve(); }, 3000); });
  if (dir) try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
});
async function open(url) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const page = await cdp.page(targetId);
  await page.command('Page.enable');
  const loaded = new Promise((resolve) => page.on('did-stop-loading', resolve));
  await page.command('Page.navigate', { url });
  await Promise.race([loaded, new Promise((r) => setTimeout(r, 5000))]);
  await page.executeJavaScript(`new Promise((r) => document.readyState === 'complete' ? r() : addEventListener('load', r))`);
  return page;
}

test('real Chromium: each kind of challenge is detected from its fixture, and look-alikes are not', { skip, timeout: 60000 }, async () => {
  const expected = {
    recaptcha: { kind: 'recaptcha', blocking: false },
    'recaptcha-challenge': { kind: 'recaptcha', blocking: true },
    'recaptcha-enterprise': { kind: 'recaptcha', blocking: false },
    'recaptcha-invisible': null,
    'recaptcha-solved': null,
    hcaptcha: { kind: 'hcaptcha', blocking: false },
    'hcaptcha-challenge': { kind: 'hcaptcha', blocking: true },
    turnstile: { kind: 'turnstile', blocking: false },
    'turnstile-shadow': { kind: 'turnstile', blocking: false },
    cloudflare: { kind: 'cloudflare', blocking: true },
    'cloudflare-managed': { kind: 'cloudflare', blocking: true },
    onboarding: null,
    arkose: { kind: 'arkose', blocking: true },
    plain: null,
  };
  for (const [name, want] of Object.entries(expected)) {
    const page = await open(`http://127.0.0.1:${port}/${name}`);
    assert.deepEqual(await page.executeJavaScript(challengeExpression()), want, name);
  }
  // Google's /sorry/ page, by its address on Google and by its form elsewhere.
  assert.deepEqual(await (await open(`http://www.google.com:${port}/sorry/index?continue=x`)).executeJavaScript(challengeExpression()), { kind: 'google_sorry', blocking: true });
  assert.deepEqual(await (await open(`http://127.0.0.1:${port}/sorry/index`)).executeJavaScript(challengeExpression()), { kind: 'google_sorry', blocking: true });
});

test('real Chromium: input is refused on the widget or a bot-check page, and allowed elsewhere', { skip, timeout: 30000 }, async () => {
  const page = await open(`http://127.0.0.1:${port}/recaptcha`);
  const center = (selector) => page.executeJavaScript(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  assert.deepEqual(await page.executeJavaScript(challengeHitExpression([await center('iframe')])), { kind: 'recaptcha', blocking: false });
  assert.equal(await page.executeJavaScript(challengeHitExpression([await center('#submit')])), null);
  await page.executeJavaScript(`document.querySelector('input[name=email]').focus()`);
  assert.equal(await page.executeJavaScript(challengeHitExpression([], true)), null, 'typing into the form is fine');
  await page.executeJavaScript(`document.querySelector('iframe').focus()`);
  assert.deepEqual(await page.executeJavaScript(challengeHitExpression([], true)), { kind: 'recaptcha', blocking: false }, 'keys into the widget are not');
  const gate = await open(`http://127.0.0.1:${port}/cloudflare`);
  assert.deepEqual(await gate.executeJavaScript(challengeHitExpression([{ x: 5, y: 5 }])), { kind: 'cloudflare', blocking: true }, 'the whole page is the check');
});

test('real Chromium: the watch probe sees a widget leave and a person typing', { skip, timeout: 30000 }, async () => {
  const page = await open(`http://127.0.0.1:${port}/recaptcha`);
  const first = await page.executeJavaScript(challengeProbeExpression());
  assert.deepEqual(first, { challenge: { kind: 'recaptcha', blocking: false }, loading: false, typing: '' });
  await page.executeJavaScript(`(() => { const e = document.querySelector('input[name=email]'); e.focus(); e.value = 'me@x'; })()`);
  const typed = await page.executeJavaScript(challengeProbeExpression());
  assert.match(typed.typing, /^4:/);
  assert.equal(JSON.stringify(typed).includes('me@x'), false, 'the probe never carries what was typed');
  await page.executeJavaScript(`document.querySelector('textarea[name=g-recaptcha-response]').value = 'token'`);
  assert.equal((await page.executeJavaScript(challengeProbeExpression())).challenge, null, 'a solved widget no longer counts');
});
