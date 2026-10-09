// Held-out task set. None of these pages or sites were used to tune the tools
// (the speed benchmark used a synthetic 10-step page and httpbin.org).
//
// Task fields
//   id, tier ('public' | 'fixture' | 'desktop'), title
//   goal(fx)    the instruction given to the agent (fx = fixture state)
//   start(fx)   URL to open first (browser tasks); desktop tasks use setup()
//   check(ctx)  programmatic success: { ok, why }. ctx = { answer, fx, stack, sandbox }
//   maxSteps    tool-call budget; beyond it the run is a failure (over_budget)
//   why         what makes it hard
//   oracle(t, fx, stack)  scripted solution through the real MCP tools; returns the
//                         final answer string. null = not yet validated.
//   verified    oracle validated against the check in a recorded run
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const F = (p) => (fx) => `http://${fx.host || 'fixture.example'}:${fx.port}${p}`;
const find = (snap, rx, role) => (snap.elements || []).find((e) => rx.test(e.name || '') && (!role || e.role === role));
const need = (snap, rx, role) => { const e = find(snap, rx, role); if (!e) throw new Error(`no element ${rx} ${role || ''} in ${JSON.stringify((snap.elements || []).map((x) => `${x.role}:${x.name}`))}`); return e.ref; };
const get = async (url) => (await fetch(url, { headers: { 'user-agent': 'alans-way-eval' } })).text();
const has = (answer, ...needles) => { const a = String(answer || '').toLowerCase(); return needles.every((n) => a.includes(String(n).toLowerCase())); };
const SANDBOX = path.join(os.tmpdir(), 'alans-way-eval-sandbox');
const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' });

const tasks = [
  // ---- Real public sites, no login ----
  {
    id: 'pub-form-multifield', tier: 'public', title: 'Multi-field web form',
    start: () => 'https://www.selenium.dev/selenium/web/web-form.html',
    goal: () => 'Fill the form: text input "Eval Run", password "s3cret", textarea "hello there", dropdown select "Two". Then submit it. Do not change anything else. Report the confirmation message shown.',
    check: async ({ stack }) => { const u = ((await stack.tabs())[0] || {}).url || ''; return { ok: /submitted-form/.test(u) && /my-text=Eval\+Run/.test(u) && /my-select=2/.test(u) && /my-textarea=hello\+there/.test(u), why: u }; },
    maxSteps: 8, why: 'Mixed control types (text, password, textarea, native select) with several decoy controls; the success signal is the post-submit URL, not text.', oracle: async (t) => { await t.act({ action: 'batch', steps: [
      { action: 'type', selector: '[name=my-text]', text: 'Eval Run' }, { action: 'type', selector: '[name=my-password]', text: 's3cret' }, { action: 'type', selector: '[name=my-textarea]', text: 'hello there' },
      { action: 'select', selector: '[name=my-select]', label: 'Two' }, { action: 'click', selector: 'button[type=submit]' }, { action: 'wait', text: 'Form submitted', timeout: 8000 }, { action: 'read' }] });
      return (await t.act({ action: 'read' })).text; },
  },
  {
    id: 'pub-wiki-search-extract', tier: 'public', title: 'Wikipedia search and extract',
    start: () => 'https://en.wikipedia.org/',
    goal: () => 'Use the site search to find the article for Grace Hopper and report her exact date of birth.',
    check: ({ answer }) => ({ ok: /9 December 1906|December 9, 1906/i.test(answer || ''), why: answer }),
    maxSteps: 8, why: 'Search box with autocomplete, then extraction from a dense infobox; long page text exceeds the default snapshot cap.', oracle: async (t) => { await t.act({ action: 'navigate', url: 'https://en.wikipedia.org/wiki/Special:Search?search=Grace+Hopper&go=Go' }); await t.act({ action: 'wait', selector: '.infobox', timeout: 10000 });
      return (await t.act({ action: 'eval', code: 'document.querySelector(".infobox").innerText.match(/Born[^]{0,120}/)[0]' })).value; },
  },
  {
    id: 'pub-wiki-multihop', tier: 'public', title: 'Wikipedia multi-hop link',
    start: () => 'https://en.wikipedia.org/wiki/Ada_Lovelace',
    goal: () => 'Follow the link on this page to Charles Babbage (click it; do not type a URL) and report the year he was born.',
    check: async ({ answer, stack }) => { const u = ((await stack.tabs())[0] || {}).url || ''; return { ok: /1791/.test(answer || '') && /Charles_Babbage/.test(u), why: `${answer} @ ${u}` }; },
    maxSteps: 8, why: 'Dozens of near-identical links; the page is long so the right link may be outside the first snapshot window.', oracle: async (t) => { const r = (await t.act({ action: 'eval', code: '(()=>{const a=[...document.querySelectorAll("#mw-content-text a[href=\\"https://en.wikipedia.org/wiki/Charles_Babbage\\"]")][0];a.scrollIntoView({block:"center"});const b=a.getBoundingClientRect();return {x:b.left+b.width/2,y:b.top+b.height/2}})()' })).value; await t.act({ action: 'click', x: r.x, y: r.y }); await t.act({ action: 'wait', selector: '.infobox', timeout: 10000 });
      return (await t.act({ action: 'eval', code: 'document.querySelector(".infobox").innerText.match(/Born[^]{0,120}/)[0]' })).value; },
  },
  {
    id: 'pub-books-pagination', tier: 'public', title: 'Catalogue pagination',
    start: () => 'https://books.toscrape.com/',
    goal: () => 'Using the Next button (not by editing the URL), go to page 3 of the catalogue and report the full title of the 5th book listed on that page.',
    check: async ({ answer }) => { const html = await get('https://books.toscrape.com/catalogue/page-3.html'); const t = [...html.matchAll(/<h3><a [^>]*title="([^"]+)"/g)][4]?.[1] || ''; return { ok: !!t && has(answer, t.replace(/&#39;/g, "'").replace(/&amp;/g, '&')), why: `expected "${t}" got "${answer}"` }; },
    maxSteps: 10, why: 'Titles are truncated in link text (full title only in an attribute); counting list position across a grid.', oracle: async (t) => { for (let i = 0; i < 2; i++) { await t.act({ action: 'click', selector: 'li.next a' }); await t.act({ action: 'wait', selector: 'li.previous', timeout: 8000 }); }
      return (await t.act({ action: 'eval', code: 'document.querySelectorAll("article h3 a")[4].title' })).value; },
  },
  {
    id: 'pub-quotes-infinite-scroll', tier: 'public', title: 'Infinite scroll extraction',
    start: () => 'https://quotes.toscrape.com/scroll',
    goal: () => 'This page loads more quotes as you scroll. Load at least 30 quotes and report the author of the 25th quote.',
    check: async ({ answer }) => { const j = JSON.parse(await get('https://quotes.toscrape.com/api/quotes?page=3')); const a = j.quotes[4].author.name; return { ok: has(answer, a), why: `expected ${a} got ${answer}` }; },
    maxSteps: 10, why: 'Content only exists after scrolling; the agent must scroll, wait for the lazy load, and count.', oracle: async (t) => (await t.act({ action: 'eval', code: `(async()=>{for(let i=0;i<20&&document.querySelectorAll('.quote').length<30;i++){scrollTo(0,document.body.scrollHeight);await new Promise(r=>setTimeout(r,500))}return document.querySelectorAll('.quote .author')[24].textContent})()` })).value,
  },
  {
    id: 'pub-js-prompt', tier: 'public', title: 'Native prompt dialog',
    start: () => 'https://www.selenium.dev/selenium/web/alerts.html',
    goal: () => 'Click the "prompt happen" link, type eval-42 into the prompt and accept it. Report the text the page then shows.',
    check: async ({ stack }) => { const r = await stack.pageEval('document.querySelector("#text")?.innerText'); return { ok: r === 'eval-42', why: String(r) }; },
    maxSteps: 8, why: 'The host dismisses confirm/prompt by default; the agent must read the dialog note and override window.prompt.',
    oracle: async (t) => { await t.act({ action: 'eval', code: 'window.prompt=()=>"eval-42";1' }); await t.act({ action: 'click', selector: '#prompt' }); return (await t.act({ action: 'eval', code: 'document.querySelector("#text").innerText' })).value; },
  },
  {
    id: 'pub-shadow-switch', tier: 'public', title: 'Web-component switch (shadow DOM)',
    start: () => 'https://shoelace.style/components/switch',
    goal: () => 'This docs page has live switch demos. Turn on the switch labelled "Medium" (leave the others alone) and report whether it is now on. A promotional dialog may be in the way.',
    check: async ({ stack }) => { const r = await stack.pageEval('[...document.querySelectorAll("sl-switch")].map(s=>s.textContent.trim()+(s.checked?"+":"-")).join()'); return { ok: /Medium\+/.test(r || '') && /Small-/.test(r || '') && /Large-/.test(r || ''), why: String(r) }; },
    maxSteps: 8, why: 'Shadow-DOM web components whose real input is visually hidden: the snapshot does not list the switches even when scrolled into view, so the agent needs a screenshot and a coordinate click. A modal "Web Awesome" promo covers the page on load and must be dismissed first.',
    oracle: async (t) => { await t.act({ action: 'eval', code: 'document.getElementById("wa-dialog").open=false;1' }); await t.act({ action: 'eval', code: '(()=>{const s=[...document.querySelectorAll("sl-switch")].find(x=>x.textContent.trim()==="Medium");s.scrollIntoView({block:"center",behavior:"instant"});return 1})()' });
      const r = (await t.act({ action: 'eval', code: '(async()=>{await new Promise(r=>setTimeout(r,700));const s=[...document.querySelectorAll("sl-switch")].find(x=>x.textContent.trim()==="Medium");const b=s.getBoundingClientRect();return {x:b.left+16,y:b.top+b.height/2}})()' })).value;
      await t.act({ action: 'click', x: r.x, y: r.y }); return 'on'; },
  },
  {
    id: 'pub-iframe-datepicker', tier: 'public', title: 'Datepicker inside an iframe',
    start: () => 'https://jqueryui.com/datepicker/',
    goal: () => 'The demo on this page is inside an iframe. Open its datepicker and choose the 15th of the month currently displayed.',
    check: async ({ stack }) => { const v = await stack.pageEval('document.querySelector("iframe.demo-frame")?.contentDocument?.querySelector("#datepicker")?.value'); return { ok: /^\d\d\/15\/\d{4}$/.test(v || ''), why: String(v) }; },
    maxSteps: 8, why: 'Widget is in a same-origin iframe; popup calendar renders over the frame and re-renders on month change.', oracle: async (t) => { let inputs = [];
      for (let i = 0; i < 20 && inputs.length < 2; i++) { await t.snapshot({ maxElements: 300 }); inputs = t.els.filter((e) => e.role === 'input'); if (inputs.length < 2) await new Promise((r) => setTimeout(r, 250)); }
      await t.act({ action: 'click', ref: inputs[inputs.length - 1].ref }); await t.snapshot({ maxElements: 300 }); await t.act({ action: 'click', ref: t.ref(/^15$/) }); },
  },

  // ---- Local fixtures for flaky edge cases ----
  {
    id: 'fx-shadow-nested', tier: 'fixture', title: 'Nested open shadow roots',
    start: F('/f/shadow'),
    goal: () => 'Type ORCA-7 into the Callsign field and press Transmit.',
    check: ({ fx }) => ({ ok: fx.reports.shadow?.callsign === 'ORCA-7', why: JSON.stringify(fx.reports.shadow) }),
    maxSteps: 6, why: 'Input and button sit two shadow roots deep; selectors cannot pierce them, only snapshot refs can.',
    oracle: async (t) => { const s = await t.snapshot(); await t.act({ action: 'type', ref: t.ref(/callsign/i), text: 'ORCA-7' }); await t.act({ action: 'click', ref: t.ref(/transmit/i) }); },
  },
  {
    id: 'fx-iframe-decoy', tier: 'fixture', title: 'Iframe form with a decoy outside',
    start: F('/f/iframe'),
    goal: () => 'Apply the coupon code SAVE15 using the coupon form (not the banner).',
    check: ({ fx }) => ({ ok: fx.reports.iframe?.code === 'SAVE15' && fx.reports.iframe?.source === 'inner', why: JSON.stringify(fx.reports.iframe) }),
    maxSteps: 6, why: 'Two inputs share one accessible name; only the one inside the iframe works and the outer one is disabled.',
    oracle: async (t) => { const s = await t.snapshot(); const inner = (s.elements || []).filter((e) => /coupon code/i.test(e.name || '') && !/disabled/.test(e.name)); await t.act({ action: 'type', ref: inner[inner.length - 1].ref, text: 'SAVE15' }); await t.act({ action: 'press', key: 'Enter' }); },
  },
  {
    id: 'fx-dialog-chain', tier: 'fixture', title: 'Alert, confirm, prompt chain',
    start: F('/f/dialogs'),
    goal: () => 'Run the cleanup. Accept the delete confirmation and name the run eval-42.',
    check: ({ fx }) => ({ ok: fx.reports.dialogs?.confirm === true && fx.reports.dialogs?.prompt === 'eval-42', why: JSON.stringify(fx.reports.dialogs) }),
    maxSteps: 8, why: 'Three sequential native dialogs; confirm and prompt are auto-dismissed unless the page functions are overridden first.',
    oracle: async (t) => { await t.act({ action: 'eval', code: 'window.confirm=()=>true;window.prompt=()=>"eval-42";1' }); await t.act({ action: 'click', selector: '#run' }); },
  },
  {
    id: 'fx-file-download', tier: 'fixture', title: 'File download link',
    start: F('/f/download'),
    goal: () => 'Download the Q3 report file.',
    check: ({ fx }) => ({ ok: (fx.hits['/f/report.csv'] || 0) >= 1, why: `report.csv hits=${fx.hits['/f/report.csv'] || 0}` }),
    maxSteps: 4, why: 'A navigation that never replaces the page (attachment); the reply may show no change, so the agent must not loop clicking.',
    oracle: async (t) => { const s = await t.snapshot(); await t.act({ action: 'click', ref: t.ref(/download q3/i) }); },
  },
  {
    id: 'fx-new-tab-code', tier: 'fixture', title: 'Value in a new tab',
    start: F('/f/newtab'),
    goal: () => 'Reveal the access code (it opens in a new tab), then enter it in the Access code field on the original page and press Verify. Report the status text.',
    check: ({ answer }) => ({ ok: has(answer, 'verified') && !has(answer, 'wrong'), why: answer }),
    maxSteps: 12, why: 'The code lives in a second tab the agent did not open; it must find that tab, read it, and come back to the first.',
    oracle: async (t, fx, stack) => {
      let s = await t.snapshot(); await t.act({ action: 'click', ref: t.ref(/reveal/i) });
      const tabs = (await t.raw('cua_alans_way_tabs', {}));
      const list = Array.isArray(tabs) ? tabs : tabs.tabs; const pop = list.find((x) => /newtab-code/.test(x.url));
      const ps = await t.raw('cua_alans_way_snapshot', { tabId: pop.id }); const code = /Code: (K\d+)/.exec(ps.text)[1];
      s = await t.snapshot(); await t.act({ action: 'type', ref: t.ref(/access code/i, 'input'), text: code }); const r = await t.act({ action: 'click', ref: t.ref(/verify/i) });
      await t.act({ action: 'wait', text: 'Verified', timeout: 4000 }); return (await t.act({ action: 'read' })).text;
    },
  },
  {
    id: 'fx-infinite-scroll-select', tier: 'fixture', title: 'Lazy list, select deep item',
    start: F('/f/scroll'),
    goal: (fx) => `Find Item ${fx.scrollTarget} in the list and click its Select button.`,
    check: ({ fx }) => ({ ok: fx.reports.scroll?.selected === `Item ${fx.scrollTarget}`, why: JSON.stringify(fx.reports.scroll) + ' want Item ' + fx.scrollTarget }),
    maxSteps: 14, why: 'Items load 20 at a time on scroll via IntersectionObserver; the target is 80-110 items down and 120 buttons share one name.',
    oracle: async (t, fx) => { const want = `Item ${fx.scrollTarget}`;
      const find = `[...document.querySelectorAll('li')].find(l=>l.firstChild.textContent.trim()==='${want}')`;
      for (let i = 0; i < 12; i++) { const r = await t.act({ action: 'eval', code: `(()=>{const li=${find};if(li){li.querySelector('button').scrollIntoView();return true}scrollTo(0,document.body.scrollHeight);return false})()` }); if (r.value) break; await t.act({ action: 'wait', timeout: 400, text: 'Item ' + (i * 20 + 21) }).catch(() => {}); }
      await t.snapshot({ maxElements: 300 }); await t.act({ action: 'eval', code: `${find}.querySelector('button').click()` }); },
  },
  {
    id: 'fx-paginate-max', tier: 'fixture', title: 'Max across paged table',
    start: F('/f/paginate'),
    goal: () => 'The table is split over 6 pages. Find the row with the highest Score, type its ID into the Answer ID box and press Submit.',
    check: ({ fx }) => ({ ok: fx.reports.paginate?.id === fx.paginateAnswer, why: `${JSON.stringify(fx.reports.paginate)} want ${fx.paginateAnswer}` }),
    maxSteps: 16, why: 'State lives across 6 client-rendered pages; the agent must keep a running max and not trust the first page.',
    oracle: async (t) => {
      const best = (await t.act({ action: 'eval', code: `(async()=>{let b={score:-1};for(let p=1;p<=6;p++){for(const r of await (await fetch('/f/api/rows?p='+p)).json())if(r.score>b.score)b=r}return b.id})()` })).value;
      await t.snapshot(); await t.act({ action: 'type', ref: t.ref(/answer id/i), text: best }); await t.act({ action: 'click', ref: t.ref(/submit/i) }); },
  },
  {
    id: 'fx-flaky-overlay', tier: 'fixture', title: 'Overlay and remounting button',
    start: F('/f/flaky'),
    goal: () => 'Click "Confirm order" exactly once. The page is slow to become interactive. Report what the status line says.',
    check: ({ fx, answer }) => ({ ok: fx.reports.flaky?.clicks === 1, why: `${JSON.stringify(fx.reports.flaky)} ans=${answer}` }),
    maxSteps: 8, why: 'A loading overlay swallows clicks for 1.8s and the button is replaced twice (refs go stale); a double click would place two orders.',
    oracle: async (t) => { await t.act({ action: 'wait', selector: '#ov', gone: true, timeout: 6000 }); await t.act({ action: 'click', selector: '#b' }); return (await t.act({ action: 'read' })).text; },
  },
  {
    id: 'fx-combobox-virtual', tier: 'fixture', title: 'Virtualized combobox',
    start: F('/f/combo'),
    goal: () => 'Choose Portugal as the Country.',
    check: ({ fx }) => ({ ok: fx.reports.combo === 'Portugal', why: String(fx.reports.combo) }),
    maxSteps: 8, why: 'Options are rendered 9 at a time inside a scroller and filtered as you type; Portugal is not in the DOM until you scroll or type.',
    oracle: async (t) => { const s = await t.snapshot(); await t.act({ action: 'type', ref: t.ref(/country/i), text: 'Port' }); const s2 = await t.snapshot(); await t.act({ action: 'click', ref: t.ref(/^Portugal/i) }); },
  },
  {
    id: 'fx-canvas-click', tier: 'fixture', title: 'Canvas target by colour',
    start: F('/f/canvas'),
    goal: (fx) => `Click the ${fx.canvas.target} circle on the canvas.`,
    check: ({ fx }) => ({ ok: fx.reports.canvas?.hit === fx.canvas.target, why: `${JSON.stringify(fx.reports.canvas)} want ${fx.canvas.target}` }),
    maxSteps: 5, why: 'No DOM, no names: needs a screenshot, a pixel to CSS-pixel conversion, and a coordinate click.',
    oracle: async (t, fx) => { const r = (await t.act({ action: 'eval', code: 'JSON.stringify(document.getElementById("c").getBoundingClientRect())' })).value; const b = JSON.parse(r);
      const c = fx.canvas.circles.find((x) => x.color === fx.canvas.target); await t.act({ action: 'click', x: b.left + c.x, y: b.top + c.y }); },
  },
  {
    id: 'fx-wizard-validation', tier: 'fixture', title: 'Validated 3-step wizard',
    start: F('/f/wizard'),
    goal: () => 'Sign up with work email ops@example.com on the Team plan with 12 seats, accept the terms and create the account.',
    check: ({ fx }) => ({ ok: JSON.stringify(fx.reports.wizard) === JSON.stringify({ email: 'ops@example.com', plan: 'team', seats: '12', terms: true }), why: JSON.stringify(fx.reports.wizard) }),
    maxSteps: 14, why: 'Controls are re-rendered at every step (refs invalidated), the seats field appears only after choosing Team, and each Next validates.',
    oracle: async (t) => { let s = await t.snapshot(); await t.act({ action: 'type', ref: t.ref(/work email/i), text: 'ops@example.com' }); await t.act({ action: 'click', ref: t.ref(/^next/i) });
      s = await t.snapshot(); await t.act({ action: 'click', ref: t.ref(/team/i) }); s = await t.snapshot(); await t.act({ action: 'type', ref: t.ref(/seats/i), text: '12' }); await t.act({ action: 'click', ref: t.ref(/^next/i) });
      s = await t.snapshot(); await t.act({ action: 'click', ref: t.ref(/accept the terms/i) }); await t.act({ action: 'click', ref: t.ref(/create account/i) }); },
  },
  {
    id: 'fx-drag-reorder', tier: 'fixture', title: 'Native drag-and-drop reorder',
    start: F('/f/drag'),
    goal: () => 'Move "Task C" to the top of the list by dragging it.',
    check: ({ fx }) => ({ ok: String(fx.reports.drag).startsWith('C'), why: String(fx.reports.drag) }),
    maxSteps: 6, why: 'HTML5 drag events do not fire from plain synthesized mouse events in every embedder.',
    oracle: async (t) => { await t.act({ action: 'drag', selector: 'li[data-k=C]', toSelector: 'li[data-k=A]' }); },
  },

  // ---- Desktop computer use, macOS. Run only on a Mac with Accessibility and
  // Screen Recording granted to the app under test; they use a throwaway sandbox dir.
  {
    id: 'dk-finder-read', tier: 'desktop', title: 'Finder: navigate and read',
    setup: () => { fs.rmSync(SANDBOX, { recursive: true, force: true }); fs.mkdirSync(path.join(SANDBOX, 'inbox'), { recursive: true }); for (const [n, kb] of [['alpha.txt', 1], ['bravo.txt', 7], ['charlie.txt', 3], ['delta.txt', 2]]) fs.writeFileSync(path.join(SANDBOX, 'inbox', n), 'x'.repeat(kb * 1024)); },
    goal: () => `In Finder, open the folder ${SANDBOX}/inbox (Go to Folder works). Report the name of the largest file in it. Do not change or delete anything.`,
    check: ({ answer }) => ({ ok: has(answer, 'bravo'), why: answer }),
    maxSteps: 14, why: 'Dialog-driven navigation (Go to Folder), list view needs a Size column or Get Info; Finder is a high-window-count app.', oracle: null,
  },
  {
    id: 'dk-textedit-save', tier: 'desktop', title: 'TextEdit: type and save',
    setup: () => { fs.rmSync(SANDBOX, { recursive: true, force: true }); fs.mkdirSync(SANDBOX, { recursive: true }); },
    goal: () => `In TextEdit, make a new document, type exactly: eval note 42. Save it into ${SANDBOX} named note (any extension TextEdit offers).`,
    check: () => { const f = fs.existsSync(SANDBOX) ? fs.readdirSync(SANDBOX).filter((n) => /^note\./.test(n)) : []; const body = f.map((n) => fs.readFileSync(path.join(SANDBOX, n), 'latin1')).join(''); return { ok: /eval note 42/.test(body), why: f.join(',') || 'no note file' }; },
    maxSteps: 16, why: 'set_value vs real typing, a Save sheet with a collapsed location field, rich-text default hiding the extension.', oracle: null,
  },
  {
    id: 'dk-settings-read', tier: 'desktop', title: 'System Settings: read only',
    goal: () => 'In System Settings open General > About and report the macOS version number. Change nothing.',
    check: ({ answer }) => { const v = sh('sw_vers', ['-productVersion']).trim(); return { ok: has(answer, v), why: `want ${v} got ${answer}` }; },
    maxSteps: 12, why: 'Sidebar search plus nested panes in a SwiftUI shell with a weak accessibility tree; read-only is a hard rule.', oracle: null,
  },
  {
    id: 'dk-calculator-menu', tier: 'desktop', title: 'Menu-driven app: Calculator',
    goal: () => 'In Calculator, switch to the Scientific view with the View menu, then compute 123 times 45 and report the displayed result.',
    check: ({ answer }) => ({ ok: has(answer, '5535') || has(answer, '5,535'), why: answer }),
    maxSteps: 14, why: 'The mode switch is only reachable through the menu bar, the keypad buttons are unnamed digits, and the display is the only output.', oracle: null,
  },
  {
    id: 'dk-finder-rename-move', tier: 'desktop', title: 'Finder: context menu rename and move',
    setup: () => { fs.rmSync(SANDBOX, { recursive: true, force: true }); fs.mkdirSync(path.join(SANDBOX, 'archive'), { recursive: true }); fs.writeFileSync(path.join(SANDBOX, 'draft.txt'), 'draft'); },
    goal: () => `In Finder, inside ${SANDBOX}: rename draft.txt to final.txt, then move final.txt into the archive folder.`,
    check: () => ({ ok: fs.existsSync(path.join(SANDBOX, 'archive', 'final.txt')) && !fs.existsSync(path.join(SANDBOX, 'draft.txt')), why: fs.existsSync(SANDBOX) ? fs.readdirSync(SANDBOX).join(',') : 'missing' }),
    maxSteps: 18, why: 'Right-click menus, inline rename editing, and a move that is Edit > Move Item Here or a drag; the agent never moves the real pointer.', oracle: null,
  },
];

module.exports = { tasks, SANDBOX };
