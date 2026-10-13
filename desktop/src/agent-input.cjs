// All input stays inside this tab's Chromium target. Never focus a native view,
// activate a window, use the clipboard for typing, or move the system pointer.
const { followUpArmExpression, followUpCloseExpression, FOLLOW_UP_KEY, REFS_KEY, PICK, refsSource, CHALLENGE_HIT_SOURCE, challengeExpression, challengeHitExpression } = require('./browser-page.cjs');
const { looksLikeCommit, isActionUrl, READ_ONLY_CDP } = require('./commit-patterns.cjs');
const { cdpMethodError } = require('./core.cjs');
const INPUT_ACTIONS = new Set(['move', 'click', 'double_click', 'right_click', 'drag', 'type', 'press', 'scroll', 'select']);
const CLICKS = { click: { button: 'left', buttons: 1, count: 1 }, double_click: { button: 'left', buttons: 1, count: 2 }, right_click: { button: 'right', buttons: 2, count: 1 } };
const POINTER_ACTIONS = new Set(['move', 'drag', ...Object.keys(CLICKS)]);
const CURSOR_ID = 'hermes-workspace-agent-cursor';
// The submit probe's flag and listener ride under a symbol key: an enumerable
// window global is how bot detectors spot injected state.
const SUBMIT_KEY = 'hw.submit', SUBMIT_SEEN_KEY = 'hw.submitSeen';
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
// Every ref an agent is handed raises the tab's seed, so a later document
// numbers its refs past it and an old ref can never name a new control.
function issueRef(tab, ref) {
  tab.refs.add(ref);
  tab.refSeed = Math.max(tab.refSeed || 0, Number(ref.slice(1)) || 0);
}
const staleRef = (ref) => fail(`Stale or unknown reference ${ref}: it does not name a control on this page now. Use a ref from your latest reply or snapshot.`, 409);
// The commit check. The router asks the user before a commit and judges the
// action from outside; this is the last look, at the element the input will
// actually reach. Unapproved, a commit-looking target is refused the way the
// router refuses it and nothing is sent. Only agent input passes through here.
const COMMIT_KINDS = ['purchase', 'booking', 'send', 'post', 'submit', 'delete', 'account_change'];
const APPROVAL_MS = 120000, APPROVAL_SKEW_MS = 5000;
// Set by approve() on an action whose approval checked out; a request body is
// JSON, so it cannot carry this key itself. Batch steps inherit it.
const APPROVED = Symbol('approved');
const commitRequired = (why) => fail(`commit_required: ${why}. It did not run. Repeat the call with commit: {kind, summary, amount?, currency?, counterparty?} so the user can approve it.`, 403);
const LOOKS = 'looks like it buys, books, sends, posts, submits or deletes';

// A wedged renderer leaves executeJavaScript pending forever and would
// wedge tab.queue behind it. Bound every probe like snapshot's 10s race.
function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('The page stopped responding.'), { status: 503 })), ms); }),
  ]).finally(() => clearTimeout(timer));
}
// webContents.executeJavaScript queues until the whole page, images and
// trackers included, has finished loading. Once a document has committed the
// main frame runs the same code now, so an action does not wait on stragglers.
function frameOf(wc) {
  try { const frame = wc.mainFrame; if (frame && /^https?:/.test(frame.url)) return frame; } catch { /* destroyed contents fall through */ }
  return wc;
}
const boundedJs = (wc, code, ms = 5000) => withTimeout(frameOf(wc).executeJavaScript(code), ms);
// A frame call that lands as the frame is swapped by a navigation can be lost,
// so a read-only script retries through webContents (which waits for the load)
// when the frame answers late or not at all. Never use this for a script with effects.
function readJs(wc, code, ms = 5000, retryAfter = 2500) {
  let timer;
  const viaContents = () => wc.executeJavaScript(code);
  const first = Promise.resolve().then(() => frameOf(wc).executeJavaScript(code)).catch(viaContents);
  const late = new Promise((resolve, reject) => { timer = setTimeout(() => viaContents().then(resolve, reject), retryAfter); });
  return withTimeout(Promise.race([first, late]), ms).finally(() => clearTimeout(timer));
}

// Bots never solve a challenge: input that would land on a CAPTCHA widget or
// on a bot-check page is refused, and the reply says to hand the tab over.
const checkFailed = () => fail('challenge_check_failed: the page could not be checked for a CAPTCHA before this input. Read the tab and retry.', 503);
function challengePresent(c) {
  return Object.assign(new Error(`challenge_present: this page shows a ${c.kind} challenge and bots never solve one. Release the tab with reason "captcha" (control: controller "human", reason "captcha") so the person can; it comes back to you once the challenge clears.`), { status: 409, code: 'challenge_present' });
}
// With no points it refuses on any challenge on the page: page script (eval,
// Runtime.*, DOM.*) can reach a widget anywhere. A probe that fails or times
// out refuses too, since the page could not be checked.
async function refuseChallenge(wc, points = null, keyboard = false) {
  const c = await boundedJs(wc, points ? challengeHitExpression(points, keyboard) : challengeExpression(), 3000).catch(() => { throw checkFailed(); });
  if (typeof c?.kind === 'string') throw challengePresent(c);
}

// A ref resolves only through the page's ref store (see refsSource), which
// follows a re-rendered control or answers null. document.querySelector stays
// in the light DOM, so a selector walks open shadow roots and same-origin
// frames; a closed root is not readable.
function locateElement(target) {
  if (target.ref) return `(window[Symbol.for(${JSON.stringify(REFS_KEY)})]?.find?.(${JSON.stringify(target.ref)}) || null)`;
  return `(() => {
    const sel = ${JSON.stringify(target.selector)};
    const queue = [document];
    const seen = new Set();
    for (let i = 0; i < queue.length && i < 600; i++) {
      const root = queue[i];
      let hit = null;
      try { hit = root.querySelector(sel); } catch { return null; }
      if (hit) return hit;
      const start = root.nodeType === 11 ? root : (root.documentElement || root);
      if (!start) continue;
      const walker = document.createTreeWalker(start, NodeFilter.SHOW_ELEMENT);
      let node, n = 0;
      while ((node = walker.nextNode()) && n++ < 4000) {
        if (node.shadowRoot && !seen.has(node.shadowRoot)) { seen.add(node.shadowRoot); queue.push(node.shadowRoot); }
      }
      let frames = [];
      try { frames = root.querySelectorAll('iframe'); } catch {}
      for (const frame of frames) {
        let doc = null;
        try { doc = frame.contentDocument; } catch {}
        if (doc && !seen.has(doc)) { seen.add(doc); queue.push(doc); }
      }
    }
    return null;
  })()`;
}

// The page side of the commit check: the names a person reads on what an
// action lands on. Matching happens in Node, against commit-patterns.cjs.
function commitSource(seed) {
  return `(() => {
    const S = ${refsSource(seed)}, pick = ${JSON.stringify(PICK)};
    const up = (n) => n.parentElement || (n.getRootNode && n.getRootNode().host) || null;
    const clean = (list) => [...new Set(list.map(t => String(t || '').replace(/\\s+/g, ' ').trim().slice(0, 200)).filter(Boolean))].slice(0, 12);
    // Its label, a submit input's value, and for an icon-only control the
    // aria-label, title or alt inside it.
    const read = (el) => {
      const out = [S.describe(el).base];
      if (el.tagName === 'INPUT' && /^(submit|image|button|reset)$/.test(el.type)) out.push(el.value || el.alt || (/^(submit|image)$/.test(el.type) ? 'Submit' : ''));
      if (!out[0]) for (const n of el.querySelectorAll('[aria-label],[title],img[alt],svg title')) out.push(n.getAttribute('aria-label') || n.getAttribute('title') || n.getAttribute('alt') || n.textContent);
      return out;
    };
    const C = {};
    // What a press on el reaches: the control around it, or for a bare
    // element (a styled div), it and the wrappers around it that hold no control.
    C.at = (el) => {
      if (!el || el.nodeType !== 1) return [];
      for (let n = el, hops = 0; n && n.nodeType === 1 && hops < 8; n = up(n), hops++) if (n.matches(pick)) return clean(read(n));
      const out = [];
      for (let n = el, hops = 0; n && n.nodeType === 1 && hops < 4 && n !== n.ownerDocument.body && !n.querySelector(pick) && (n.innerText || '').length <= 80; n = up(n), hops++) out.push(...read(n));
      return clean(out);
    };
    C.field = (el) => !!el && el.nodeType === 1 && (el.isContentEditable || el.matches('textarea,select,input:not([type=submit]):not([type=image]):not([type=button]):not([type=reset]),[role=textbox],[role=searchbox],[role=combobox]'));
    // The names of the controls Enter in el's form would submit with; null outside a form.
    C.form = (el) => el && el.form ? clean([...el.form.elements].filter(c => (c.tagName === 'BUTTON' || c.tagName === 'INPUT') && (c.type === 'submit' || c.type === 'image')).flatMap(read)) : null;
    C.opaque = (el) => { if (!el || (el.tagName !== 'IFRAME' && el.tagName !== 'FRAME')) return false; try { return !el.contentDocument; } catch { return true; } };
    C.look = (el) => el === 'frame' || C.opaque(el) ? { frame: true } : el ? { names: C.at(el), field: C.field(el), form: C.form(el) } : null;
    // The element at a viewport point, through open shadow roots and
    // same-origin frames; 'frame' for a cross-origin frame, which cannot be read.
    C.hit = (x, y) => {
      let doc = document;
      for (let depth = 0; depth < 10; depth++) {
        let el = doc.elementFromPoint(x, y);
        while (el && el.shadowRoot) { const deeper = el.shadowRoot.elementFromPoint(x, y); if (!deeper || deeper === el) break; el = deeper; }
        if (!el || (el.tagName !== 'IFRAME' && el.tagName !== 'FRAME')) return el;
        let inner = null;
        try { inner = el.contentDocument; } catch {}
        if (!inner) return 'frame';
        const r = el.getBoundingClientRect();
        x -= r.left + el.clientLeft; y -= r.top + el.clientTop; doc = inner;
      }
      return null;
    };
    C.focus = () => {
      let a = document.activeElement;
      for (let depth = 0; a && depth < 10; depth++) {
        if (a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
        else if (a.tagName === 'IFRAME' || a.tagName === 'FRAME') { let doc = null; try { doc = a.contentDocument; } catch {} if (!doc) return 'frame'; a = doc.activeElement; }
        else break;
      }
      return a;
    };
    // The names of every visible control a press would set off (a field's
    // label, such as a "Pay rent" checkbox, is not one): what the page shows.
    C.page = () => {
      const names = new Set();
      for (const el of S.collect(performance.now() + 400, 6000, 2000).list) { if (C.field(el)) continue; for (const n of C.at(el)) names.add(n); if (names.size >= 1500) break; }
      return { origin: location.origin, names: [...names] };
    };
    return C;
  })()`;
}

const NAMED_KEYS = { Enter: [13, 'Enter'], Tab: [9, 'Tab'], Backspace: [8, 'Backspace'], Escape: [27, 'Escape'], Delete: [46, 'Delete'], ArrowLeft: [37, 'ArrowLeft'], ArrowUp: [38, 'ArrowUp'], ArrowRight: [39, 'ArrowRight'], ArrowDown: [40, 'ArrowDown'], Home: [36, 'Home'], End: [35, 'End'], PageUp: [33, 'PageUp'], PageDown: [34, 'PageDown'], ' ': [32, 'Space'] };
const PUNCTUATION = { ';': [186, 'Semicolon'], '=': [187, 'Equal'], ',': [188, 'Comma'], '-': [189, 'Minus'], '.': [190, 'Period'], '/': [191, 'Slash'], '`': [192, 'Backquote'], '[': [219, 'BracketLeft'], '\\': [220, 'Backslash'], ']': [221, 'BracketRight'], "'": [222, 'Quote'] };
const SHIFTED = { '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0', _: '-', '+': '=', '{': '[', '}': ']', '|': '\\', ':': ';', '"': "'", '<': ',', '>': '.', '?': '/', '~': '`' };
function physicalKey(key) {
  if (NAMED_KEYS[key]) return NAMED_KEYS[key];
  if (/^F(?:[1-9]|1[0-2])$/.test(key)) return [111 + Number(key.slice(1)), key];
  if (key.length !== 1) return null;
  const base = SHIFTED[key] || key;
  if (PUNCTUATION[base]) return PUNCTUATION[base];
  if (/^[0-9]$/.test(base)) return [48 + Number(base), `Digit${base}`];
  if (/^[a-z]$/i.test(base)) return [base.toUpperCase().charCodeAt(0), `Key${base.toUpperCase()}`];
  return [key.toUpperCase().charCodeAt(0), ''];
}
// Chromium on macOS routes editing shortcuts through NSResponder selectors, so
// a raw Cmd+A key event selects nothing. Clipboard commands (copy, cut, paste)
// are left out on purpose: the agent never reads or fills the human's clipboard.
const MAC_COMMANDS = { Backspace: 'deleteBackward', Delete: 'deleteForward', 'Meta+a': 'selectAll', 'Meta+z': 'undo', 'Meta+Shift+z': 'redo',
  'Meta+ArrowLeft': 'moveToLeftEndOfLine', 'Meta+ArrowRight': 'moveToRightEndOfLine', 'Meta+ArrowUp': 'moveToBeginningOfDocument', 'Meta+ArrowDown': 'moveToEndOfDocument',
  'Meta+Shift+ArrowLeft': 'moveToLeftEndOfLineAndModifySelection', 'Meta+Shift+ArrowRight': 'moveToRightEndOfLineAndModifySelection', 'Meta+Shift+ArrowUp': 'moveToBeginningOfDocumentAndModifySelection', 'Meta+Shift+ArrowDown': 'moveToEndOfDocumentAndModifySelection',
  'Alt+ArrowLeft': 'moveWordLeft', 'Alt+ArrowRight': 'moveWordRight', 'Alt+Shift+ArrowLeft': 'moveWordLeftAndModifySelection', 'Alt+Shift+ArrowRight': 'moveWordRightAndModifySelection',
  'Meta+Backspace': 'deleteToBeginningOfLine', 'Alt+Backspace': 'deleteWordBackward', 'Alt+Delete': 'deleteWordForward',
  'Shift+ArrowLeft': 'moveLeftAndModifySelection', 'Shift+ArrowRight': 'moveRightAndModifySelection', 'Shift+ArrowUp': 'moveUpAndModifySelection', 'Shift+ArrowDown': 'moveDownAndModifySelection' };

function keyboardEvent(body, platform = process.platform) {
  if (typeof body.key !== 'string' || !body.key || body.key.length > 30) throw fail('Invalid key.');
  if (body.modifiers !== undefined && (!Array.isArray(body.modifiers) || body.modifiers.some(key => !['alt', 'control', 'meta', 'shift'].includes(key)))) throw fail('Invalid key modifiers.');
  const names = body.modifiers || [];
  const modifiers = names.reduce((bits, key) => bits | ({ alt: 1, control: 2, meta: 4, shift: 8 }[key]), 0);
  const key = ({ Return: 'Enter', Esc: 'Escape', Space: ' ' })[body.key] || body.key;
  const physical = physicalKey(key);
  if (!physical || !physical[0]) throw fail('Unsupported key. Use a character, Enter, Tab, Escape, Backspace, Delete, an arrow, Home, End, PageUp, PageDown or F1–F12.');
  const [windowsVirtualKeyCode, code] = physical;
  const shortcut = ['control', 'alt', 'meta', 'shift'].filter(name => names.includes(name)).map(name => name[0].toUpperCase() + name.slice(1)).concat(key.length === 1 ? key.toLowerCase() : key).join('+');
  const command = platform === 'darwin' && !(modifiers & 2) ? MAC_COMMANDS[shortcut] : undefined;
  return { key, ...(code ? { code } : {}), modifiers, windowsVirtualKeyCode, ...(command ? { commands: [command] } : {}),
    ...(key === 'Enter' && !(modifiers & 7) ? { text: '\r' } : key.length === 1 && !(modifiers & 7) ? { text: key } : {}) };
}

function cursorScript(cursor) {
  // A closed shadow tree keeps the decorative label out of page snapshots.
  return `(() => {
    const id = ${JSON.stringify(CURSOR_ID)}, value = ${JSON.stringify(cursor)};
    // The overlay lands inside the action's arm window; its own timers must
    // not count as follow-up work the action started.
    const track = window[Symbol.for(${JSON.stringify(FOLLOW_UP_KEY)})];
    const setT = track && track.setT || setTimeout, clearT = track && track.clearT || clearTimeout;
    let host = document.getElementById(id);
    if (!value) { host?.remove(); document.getElementById(id + '-hl')?.remove(); return; }
    if (host && !host._root) { host.remove(); host = null; }
    if (!host) {
      host = document.createElement('div'); host.id = id;
      host.setAttribute('aria-hidden', 'true');
      host.style.cssText = 'all:initial!important;position:fixed!important;left:0!important;top:0!important;width:0!important;height:0!important;z-index:2147483647!important;pointer-events:none!important;user-select:none!important;';
      // Closed roots read null through .shadowRoot — keep our own reference.
      host._root = host.attachShadow({ mode: 'closed' });
      host._root.innerHTML = '<style>:host{pointer-events:none;transition:transform .28s cubic-bezier(.3,.9,.4,1)}svg{overflow:visible;filter:drop-shadow(0 0 5px var(--am,#69f5d4)) drop-shadow(0 0 14px var(--am,#69f5d4)) drop-shadow(0 2px 3px #0008)}span{position:absolute;left:19px;top:20px;padding:4px 7px;border:1px solid var(--ab,#a0fff4);border-radius:7px;background:var(--alb,#073b37);color:var(--alf,#d9fff8);font:600 11px/1.2 system-ui;white-space:nowrap;box-shadow:0 2px 8px #0004}.ring{fill:none;stroke:var(--am,#69f5d4);stroke-width:2;opacity:0}:host([data-action="click"]) .ring{animation:tap .48s ease-out}@keyframes tap{from{r:3;opacity:.9}to{r:23;opacity:0}}@media(prefers-reduced-motion:reduce){.ring{animation:none!important}:host{transition:none!important}}</style><svg width="19" height="25" viewBox="0 0 19 25"><circle class="ring" cx="1" cy="1" r="3"/><path d="M1 1v19l5-5 4 9 4-2-4-8h7Z" fill="var(--am,#69f5d4)" stroke="var(--as,#06332c)" stroke-width="1.5" stroke-linejoin="round"/></svg><span></span>';
      document.documentElement.appendChild(host);
    }
    if (value.c) {
      host.style.setProperty('--am', value.c.main); host.style.setProperty('--as', value.c.stroke);
      host.style.setProperty('--alb', value.c.labelBg); host.style.setProperty('--alf', value.c.labelFg); host.style.setProperty('--ab', value.c.border);
    }
    // The element highlight rides the same injection: ref actions flash their
    // target in blue while the cursor travels to it, then the outline fades.
    let box = document.getElementById(id + '-hl');
    if (box && !box._root) { box.remove(); box = null; }
    if (!box) {
      box = document.createElement('div'); box.id = id + '-hl';
      box.setAttribute('aria-hidden', 'true');
      box.style.cssText = 'all:initial!important;position:fixed!important;left:0!important;top:0!important;width:0!important;height:0!important;z-index:2147483646!important;pointer-events:none!important;user-select:none!important;';
      box._root = box.attachShadow({ mode: 'closed' });
      box._root.innerHTML = '<style>div{position:fixed;pointer-events:none;border:2px solid #6f9fff;border-radius:9px;background:#3b82f612;box-shadow:0 0 0 3px #3b82f628,inset 0 0 22px #3b82f61f;opacity:0;transition:opacity .18s ease,left .22s ease,top .22s ease,width .22s ease,height .22s ease}div.on{opacity:1}@media(prefers-reduced-motion:reduce){div{transition:opacity .18s ease!important}}</style><div></div>';
      document.documentElement.appendChild(box);
    }
    host.setAttribute('data-action', value.action);
    host._root.querySelector('span').textContent = value.name || 'Agent';
    const outline = box._root.querySelector('div');
    if (value.hl) {
      outline.style.left = value.hl.x + 'px'; outline.style.top = value.hl.y + 'px';
      outline.style.width = value.hl.width + 'px'; outline.style.height = value.hl.height + 'px';
      outline.classList.add('on');
      clearT(box._hlTimer); box._hlTimer = setT(() => outline.classList.remove('on'), 1600);
    }
    // A passed path tweens the overlay on local rAF while the real pointer
    // stream dispatches separately — per-step evals multiplied renderer
    // round-trips by path length for identical visuals. The returned promise
    // resolves when the glide lands, so callers can order a follow-up click.
    const pts = value.path;
    cancelAnimationFrame(host._raf); clearT(host._glideTimer);
    host._glideResolve?.(); host._glideResolve = null;
    if (pts && pts.length > 1) {
      host.style.setProperty('transition', 'none');
      host.style.setProperty('transform', 'translate(' + pts[0].x + 'px,' + pts[0].y + 'px)', 'important');
      const start = performance.now(), last = pts[pts.length - 1];
      return new Promise(resolve => {
        const land = () => {
          clearT(host._glideTimer); host._glideResolve = null;
          host.style.setProperty('transform', 'translate(' + last.x + 'px,' + last.y + 'px)', 'important');
          host.style.removeProperty('transition'); resolve();
        };
        // Hidden tabs never fire rAF; the timer still lands the overlay on the
        // pointer so a later captureTab screenshot shows the right position.
        host._glideTimer = setT(land, pts.length * 16 + 100);
        host._glideResolve = resolve;
        const tick = () => {
          if (!host.isConnected) return land();
          const i = Math.min((performance.now() - start) / 16, pts.length - 1), i0 = Math.floor(i), f = i - i0;
          const a = pts[i0], b = pts[Math.min(i0 + 1, pts.length - 1)];
          host.style.setProperty('transform', 'translate(' + Math.round(a.x + (b.x - a.x) * f) + 'px,' + Math.round(a.y + (b.y - a.y) * f) + 'px)', 'important');
          if (i < pts.length - 1) host._raf = requestAnimationFrame(tick);
          else land();
        };
        host._raf = requestAnimationFrame(tick);
      });
    }
    host.style.removeProperty('transition');
    host.style.setProperty('transform', 'translate(' + value.x + 'px,' + value.y + 'px)', 'important');
  })()`;
}

// A static inset frame marks a page while an agent holds control. It is
// re-injected after navigation because a new document destroys the overlay.
function tintScript(on) {
  return `(() => {
    const on = ${JSON.stringify(!!on)};
    const id = ${JSON.stringify(CURSOR_ID)} + '-tint';
    let host = document.getElementById(id);
    if (!on) { host?.remove(); return; }
    if (host) return;
    host = document.createElement('div'); host.id = id;
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'all:initial!important;position:fixed!important;left:0!important;top:0!important;width:0!important;height:0!important;z-index:2147483645!important;pointer-events:none!important;user-select:none!important;';
    host.attachShadow({ mode: 'closed' }).innerHTML = '<style>div{position:fixed;inset:0;pointer-events:none;box-shadow:inset 0 0 0 3px rgba(168,233,204,.34),inset 0 -140px 160px -110px rgba(168,233,204,.15);border-radius:2px}</style><div></div>';
    document.documentElement.appendChild(host);
  })()`;
}

// One agent accent so the cursor, page tint, control state and work glow all
// read as the same avatar-glow green everywhere an agent is working.
const AGENT_HUE = 152;
function botAccent(_botId) {
  const hue = AGENT_HUE;
  return { hue, main: `hsl(${hue},75%,62%)`, stroke: `hsl(${hue},60%,26%)`, labelBg: `hsl(${hue},48%,15%)`, labelFg: '#a8e9cc', border: '#a8e9cc' };
}

function cursorPath(from, to) {
  if (!from || from.x === to.x && from.y === to.y) return [to];
  const dx = to.x - from.x, dy = to.y - from.y, distance = Math.hypot(dx, dy);
  // A long glide made every click wait on a demo. A few frames is enough
  // for the page to see the pointer arrive, then the click lands.
  const duration = Math.min(64, Math.max(48, 24 + distance * .05));
  const steps = Math.max(2, Math.ceil(duration / 16));
  const bend = Math.min(18, distance * .04) * ((Math.round(from.x + from.y + to.x + to.y) & 1) ? 1 : -1);
  return Array.from({ length: steps }, (_, index) => {
    const t = (index + 1) / steps;
    const eased = t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    const arc = Math.sin(Math.PI * eased) * bend;
    return { x: index === steps - 1 ? to.x : Math.round(from.x + dx * eased - dy / distance * arc),
      y: index === steps - 1 ? to.y : Math.round(from.y + dy * eased + dx / distance * arc) };
  });
}

// One round trip finds the element, scrolls only when it is out of view, hit
// tests it, readies focus for typing and reports what a click needs to know.
// seed is the tab's highest issued ref, for a name lookup that opens the store.
function resolveScript(target, { focus = false, type = false, select = false, probe = false, look = false, seed = 0 } = {}) {
  return `(async () => {
    ${target.name ? `const named = ${refsSource(seed)}.byName(${JSON.stringify(target.name)}, ${JSON.stringify(target.role || '')}, ${JSON.stringify(target.row || '')});
    if (named.near) return { fail: 'unnamed', near: named.near, cut: named.cut };
    if (named.many) return { fail: 'ambiguous', many: named.many, count: named.count, cut: named.cut };
    const el = named.el, ref = named.ref, resolved = named.name, partial = named.cut;` : `const el = ${locateElement(target)}, ref = undefined, resolved = undefined, partial = undefined;`}
    if (!el) return { fail: ${target.ref ? "'stale'" : "'missing or disabled'"} };
    // Bots never solve a challenge: a target inside one is refused before any
    // path below can return a point for it, hidden or not.
    const inside = (${CHALLENGE_HIT_SOURCE})([], false, [el]);
    if (inside) return { fail: 'challenge', challenge: inside };
    if (el.disabled || el.matches(':disabled') || el.closest('[inert]')) return { fail: 'missing or disabled' };
    // A native select hidden behind a custom dropdown is chosen by value, so it needs no hit test.
    const loose = ${select} && el.tagName === 'SELECT';
    const view = el.ownerDocument.defaultView || window;
    const box = el.getBoundingClientRect();
    if (view !== window || box.top < 0 || box.left < 0 || box.bottom > innerHeight || box.right > innerWidth || !box.width || !box.height) {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      // Hidden tabs never fire rAF; the timer keeps the wait bounded.
      await Promise.race([new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))), new Promise(r => setTimeout(r, 80))]);
    }
    void el.offsetHeight;
    let ox = 0, oy = 0, parent = view;
    while (parent && parent !== window) {
      const frame = parent.frameElement;
      if (!frame) break;
      const fr = frame.getBoundingClientRect();
      ox += fr.left; oy += fr.top;
      parent = frame.ownerDocument.defaultView;
    }
    const r = el.getBoundingClientRect();
    const l = Math.max(0, r.left), t = Math.max(0, r.top), rr = Math.min(view.innerWidth, r.right), b = Math.min(view.innerHeight, r.bottom);
    const w = rr - l, h = b - t;
    if (!r.width || !r.height || w <= 0 || h <= 0) return loose ? { x: Math.round(innerWidth / 2), y: Math.round(innerHeight / 2) } : { fail: 'no visible area' };
    let point = null, coveredBy = null, coveredAt = null, at = null;
    for (const [fx, fy] of [[.5,.5],[.5,.25],[.5,.75],[.25,.5],[.75,.5],[.2,.2],[.8,.2],[.2,.8],[.8,.8]]) {
      const lx = Math.round(l + w * fx), ly = Math.round(t + h * fy);
      let hit = view.document.elementFromPoint(lx, ly);
      // elementFromPoint retargets a hit inside a shadow root to its host and
      // Node.contains stops at the shadow boundary, so only a walk up the
      // composed tree sees a host or wrapper ancestor as the target itself.
      let own = false;
      for (let n = el; n && !own; n = n.parentNode || n.host) own = n === hit;
      // A retargeted host hit can equally be a sibling overlay inside the
      // same root, so it only counts when each open root's own hit test
      // resolves down to el or something inside it.
      if (hit && own && hit !== el && hit.shadowRoot) {
        let inner = hit;
        while (inner.shadowRoot) {
          const deeper = inner.shadowRoot.elementFromPoint(lx, ly);
          if (!deeper || deeper === inner) break;
          inner = deeper;
        }
        if (inner !== hit) {
          hit = inner;
          own = false;
          for (let n = inner; n && !own; n = n.parentNode || n.host) own = n === el;
        }
      }
      // A visually hidden checkbox or radio (pointer-events:none behind a
      // styled track) is operated through its label; a hit on that label is a hit on it.
      if (hit && !own && hit.closest) { const label = hit.closest('label'); own = !!label && label.control === el; }
      if (hit && (own || el.contains(hit))) { point = { x: lx + ox, y: ly + oy }; at = hit; break; }
      if (hit && !coveredBy && !own && !el.contains(hit)) { coveredBy = hit; coveredAt = { x: lx + ox, y: ly + oy }; }
    }
    // Bots never solve a challenge: a point on one (or under its pop-up) is refused.
    const challenge = (${CHALLENGE_HIT_SOURCE})([point || coveredAt], false);
    if (challenge) return { fail: 'challenge', challenge };
    if (!point && loose) point = { x: Math.round(l + w / 2 + ox), y: Math.round(t + h / 2 + oy) };
    if (!point && coveredBy) {
      // Name the dialog or banner in the way, and what closes it.
      const store = window[Symbol.for(${JSON.stringify(REFS_KEY)})], found = store && store.layer ? store.layer(coveredBy) : null;
      if (found) return { fail: 'covered', layer: found.out };
      return { fail: 'covered by ' + coveredBy.tagName.toLowerCase() + (coveredBy.id ? '#' + coveredBy.id : typeof coveredBy.className === 'string' && coveredBy.className.trim() ? '.' + coveredBy.className.trim().split(/\\s+/)[0] : '') };
    }
    if (!point) return { fail: 'no clickable point' };
    if (${focus}) {
      if (${type} && (!(el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' && /^(text|search|email|url|tel|password|number)$/.test(el.type)) || el.readOnly)) return { fail: 'element cannot accept text' };
      el.focus({ preventScroll: true });
      if (${type}) {
        if (typeof el.select === 'function') el.select();
        else { const doc = el.ownerDocument; const range = doc.createRange(); range.selectNodeContents(el); const s = el.getRootNode().getSelection?.() || doc.getSelection(); s.removeAllRanges(); s.addRange(range); }
      }
    }
    const kind = (el.type || '').toLowerCase();
    if (${probe}) {
      const sKey = Symbol.for(${JSON.stringify(SUBMIT_KEY)}), seenKey = Symbol.for(${JSON.stringify(SUBMIT_SEEN_KEY)});
      try { Object.defineProperty(view, sKey, { value: null, writable: true, configurable: true }); } catch { view[sKey] = null; }
      view[seenKey] ||= (event) => { view[sKey] = event.defaultPrevented ? 'handled' : 'navigates'; };
      view.addEventListener('submit', view[seenKey], { once: true });
    }
    const submit = !!el.form && ((el.tagName === 'BUTTON' && (!kind || kind === 'submit')) || (el.tagName === 'INPUT' && kind === 'submit'));
    const link = !!el.closest('a[href]') && !/^#/.test(el.closest('a[href]').getAttribute('href') || '');
    ${look ? `const C = ${commitSource(seed)}, look = C.look(C.opaque(at) ? at : el);
    if (look.names) look.names = [...new Set([...look.names, ...C.at(at)])];` : 'const look = undefined;'}
    return { ...point, ref, resolved, partial, submit, nav: submit || link, look, hl: { x: Math.round(r.left + ox), y: Math.round(r.top + oy), width: Math.round(r.width), height: Math.round(r.height) } };
  })()`;
}

// Picks an option the way an assistive tool would: Chromium's native popup
// cannot be driven through the tab's input events, so the option is selected
// directly and the same input and change events a person would cause fire.
// The option may arrive under any of value, label, option, text or choice;
// it matches a value first, then an exact label, then a folded one.
function selectScript(target, body) {
  const tries = [body.value, body.label, body.option, body.text, body.choice].filter(item => typeof item === 'string').map(item => item.slice(0, 1000));
  return `(() => {
    const el = ${locateElement(target)};
    if (!el) return { fail: ${target.ref ? "'stale'" : "'is not a select'"} };
    if (el.tagName !== 'SELECT') return { fail: 'is not a select' };
    if (el.disabled) return { fail: 'disabled' };
    const challenge = (${CHALLENGE_HIT_SOURCE})([], false, [el]);
    if (challenge) return { fail: 'challenge', challenge };
    const tries = ${JSON.stringify(tries)};
    const text = (o) => (o.label || o.text || '').trim();
    const options = [...el.options];
    let pick = null, by = '';
    for (const t of tries) { pick = options.find(o => !o.disabled && o.value === t); if (pick) { by = 'value'; break; } }
    if (!pick) for (const t of tries) { pick = options.find(o => !o.disabled && text(o) === t); if (pick) { by = 'label'; break; } }
    if (!pick) for (const t of tries) { const low = t.trim().toLowerCase(); pick = options.find(o => !o.disabled && text(o).toLowerCase() === low); if (pick) { by = 'label-fold'; break; } }
    if (!pick) return { fail: 'has no option matching that value or label', options: options.slice(0, 30).map(o => ({ value: o.value, label: text(o) })) };
    el.focus({ preventScroll: true });
    for (const o of options) o.selected = o === pick;
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { matched: { by, value: pick.value, label: text(pick) } };
  })()`;
}

// A click or Enter that starts a main-frame navigation should not answer
// until the new document has parsed, or the controls read lands on the old page.
function watchNavigation(wc, delay) {
  const state = { started: false, ready: false, wake: null, awake: null };
  if (typeof wc.on !== 'function') return { settle: async () => {}, stop() {}, navigated: () => undefined };
  const onStart = (event, _url, inPlace, main) => {
    if (!(event.isMainFrame ?? main)) return;
    if (!(event.isSameDocument ?? inPlace)) { state.started = true; state.ready = false; }
    state.awake?.();
  };
  const onReady = () => { if (state.started) { state.ready = true; state.wake?.(); } };
  wc.on('did-start-navigation', onStart);
  for (const name of ['dom-ready', 'did-stop-loading', 'did-fail-load', 'destroyed']) wc.on(name, onReady);
  return {
    // likely is true when a navigation may follow (a link, Enter) and 'certain'
    // when the page left a submit alone. A slow machine can take a few hundred
    // ms to start a link's load; an in-page route change ends the wait at once.
    async settle(likely) {
      if (!state.started && likely) await new Promise(resolve => { state.awake = resolve; delay(likely === 'certain' ? 1000 : 600).then(resolve); });
      if (!state.started || state.ready) return;
      await new Promise(resolve => {
        const done = () => { clearTimeout(timer); state.wake = null; resolve(); };
        const timer = setTimeout(done, 2000);
        state.wake = done;
      });
    },
    // True only when a main-frame cross-document navigation started; a
    // same-document route change (pushState, hash) leaves it false.
    navigated: () => state.started,
    stop() {
      wc.removeListener('did-start-navigation', onStart);
      for (const name of ['dom-ready', 'did-stop-loading', 'did-fail-load', 'destroyed']) wc.removeListener(name, onReady);
    },
  };
}

function createAgentInput({ command, requireActor, botName = () => 'Agent', onBusy = () => {}, isVisible = () => true, delay = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now }) {
  const states = new WeakMap();
  const usedNonces = new Map();
  // The router sends approval: {nonce, kind, summary, issuedAt, tabId, epoch}
  // on the one action the user approved (a batch carries it for all its
  // steps). It counts once, within 120s, on that tab and control epoch;
  // anything else carrying an approval is refused outright.
  function approve(tab, body) {
    if (body.approval === undefined) return;
    const a = body.approval, at = now();
    const invalid = (why) => fail(`approval_invalid: ${why}. It did not run. Ask the user to approve it again.`, 403);
    if (!a || typeof a !== 'object' || typeof a.nonce !== 'string' || !/^[\w-]{16,128}$/.test(a.nonce) || !COMMIT_KINDS.includes(a.kind)
      || typeof a.summary !== 'string' || a.summary.length > 200 || !Number.isFinite(a.issuedAt)) throw invalid('approval needs nonce, kind, summary, issuedAt, tabId and epoch');
    for (const [nonce, until] of usedNonces) if (until < at) usedNonces.delete(nonce);
    if (at - a.issuedAt > APPROVAL_MS || a.issuedAt - at > APPROVAL_SKEW_MS) throw invalid('the approval expired');
    if (a.tabId !== tab.id || a.epoch !== tab.epoch) throw invalid('the approval is for another tab or control epoch');
    if (usedNonces.has(a.nonce)) throw invalid('the approval was already used');
    usedNonces.set(a.nonce, a.issuedAt + APPROVAL_MS + APPROVAL_SKEW_MS);
    body[APPROVED] = true;
  }
  const pageNames = (tab) => readJs(tab.view.webContents, `${commitSource(tab.refSeed)}.page()`).then(page => page && Array.isArray(page.names) ? page : null, () => null);
  // Page script and DevTools calls that can act, while the page shows a
  // commit control; a reload there (it may resubmit); a same-origin address
  // that reads like an action. Read-only DevTools calls pass.
  async function guard(tab, body) {
    if (body[APPROVED]) return;
    const method = body.action === 'cdp' ? String(body.method || '') : '';
    // A method the host refuses anyway gets that refusal, not this one.
    if (method && cdpMethodError(method)) return;
    const script = body.action === 'eval' || (!!method && !READ_ONLY_CDP.test(method));
    const reload = body.action === 'reload' || method === 'Page.reload';
    const url = body.action === 'navigate' ? body.url : method === 'Page.navigate' && body.params ? body.params.url : undefined;
    if (!script && !reload && typeof url !== 'string') return;
    const what = body.action === 'eval' ? 'a page script' : `the DevTools call ${method.slice(0, 60)}`;
    const page = await pageNames(tab);
    if (!page) { if (script) throw commitRequired(`the page did not answer the commit check, so ${what} could set off a commit control`); return; }
    const live = page.names.find(looksLikeCommit);
    if (!live) return;
    if (script) throw commitRequired(`${what} here could set off "${live}"`);
    if (reload) throw commitRequired(`reloading here could resubmit "${live}"`);
    if (isActionUrl(url, page.origin)) throw commitRequired(`${url.slice(0, 80)} looks like an address that confirms, orders, pays, submits or deletes`);
  }
  function state(tab) {
    if (!states.has(tab)) states.set(tab, { active: 0, revision: 0 });
    return states.get(tab);
  }
  async function clear(tab) {
    state(tab).revision++;
    tab.agentCursor = null;
    const wc = tab.view.webContents;
    if (wc.isDestroyed()) { tab.focusEmulation = false; return; }
    // Focus emulation is held per tab across actions, so clear() is the
    // teardown that actually releases it.
    if (tab.focusEmulation) {
      tab.focusEmulation = false;
      await command(tab, 'Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {});
    }
    await boundedJs(wc, cursorScript(null)).catch(() => {});
  }
  function isDispatching(tab) { return !!tab && (states.get(tab)?.active || 0) > 0; }

  async function perform(tab, body, botId) {
    const wc = tab.view.webContents;
    const own = state(tab), revision = own.revision;
    const check = () => {
      requireActor(tab, botId, body.epoch, true);
      if (own.revision !== revision || wc.isDestroyed()) throw fail('Agent input was cancelled. Request fresh tab state.', 409);
    };
    check();
    const action = body.action;
    if (!INPUT_ACTIONS.has(action)) throw fail('Unsupported agent input action.');
    if (action === 'type' && (typeof body.text !== 'string' || body.text.length > 20000)) throw fail('Provide text up to 20,000 characters.');
    const keyEvent = action === 'press' ? keyboardEvent(body) : null;
    const enterOrSpace = keyEvent && (keyEvent.windowsVirtualKeyCode === 13 || keyEvent.windowsVirtualKeyCode === 32);
    const gated = !body[APPROVED] && (['click', 'double_click', 'right_click', 'drag', 'select'].includes(action) || enterOrSpace);
    const knownRef = (ref) => typeof ref === 'string' && /^e\d+$/.test(ref) && tab.refs.has(ref);
    if (body.ref !== undefined && !knownRef(body.ref)) throw staleRef(body.ref);
    if (body.selector !== undefined && (typeof body.selector !== 'string' || !body.selector || body.selector.length > 2000)) throw fail('Provide a CSS selector up to 2,000 characters.');
    for (const key of ['name', 'role', 'row']) if (body[key] !== undefined && (typeof body[key] !== 'string' || !body[key].trim() || body[key].length > 200)) throw fail(`${key} must be a non-empty string up to 200 characters.`);
    if ((body.role !== undefined || body.row !== undefined) && body.name === undefined) throw fail('role and row narrow a name: pass name too.');
    if (body.name !== undefined && (body.ref !== undefined || body.selector !== undefined)) throw fail('Target one way: a ref, a name or a selector.');
    const targeted = body.ref !== undefined || body.selector !== undefined || body.name !== undefined;
    if ((action === 'type' || action === 'select') && !targeted) throw fail(`${action === 'type' ? 'Typing' : 'Selecting'} requires a ref, a name or a selector.`);
    if (POINTER_ACTIONS.has(action) && !targeted && (!Number.isFinite(body.x) || !Number.isFinite(body.y))) throw fail('Provide a ref, a name, a selector, or viewport x and y coordinates.');
    if (action === 'scroll' && [body.x, body.y].some(value => value !== undefined && !Number.isFinite(value))) throw fail('Scroll deltas must be finite numbers.');
    if (action === 'select' && ![body.value, body.label, body.option, body.text, body.choice].some(item => typeof item === 'string' && item.length <= 1000)) throw fail('Provide the option value, label, option, text or choice (up to 1,000 characters).');
    let to = null;
    if (action === 'drag') {
      if (body.toRef !== undefined && !knownRef(body.toRef)) throw staleRef(body.toRef);
      if (body.toSelector !== undefined && (typeof body.toSelector !== 'string' || !body.toSelector || body.toSelector.length > 2000)) throw fail('Provide a destination CSS selector up to 2,000 characters.');
      if (body.toRef || body.toSelector) to = { ref: body.toRef, selector: body.toSelector };
      else if (Number.isFinite(body.toX) && Number.isFinite(body.toY)) to = { x: body.toX, y: body.toY };
      else throw fail('drag needs a destination: toRef, toSelector, or toX and toY.');
    }

    // The API owner serializes perform() with screenshots and navigation in
    // tab.queue. Checks after awaits also stop an already queued revoked action.
    const send = async (method, params) => { check(); const result = await withTimeout(command(tab, method, params), 10000); check(); return result; };
    const visible = isVisible(tab) !== false;
    const accent = botAccent(botId);
    let mouseDown = null, keyDown = null;
    async function keys(event) {
      keyDown = event;
      await send('Input.dispatchKeyEvent', { type: 'keyDown', ...event });
      const { text, commands, ...released } = event;
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...released });
      keyDown = null;
    }
    // The overlay is decoration, never evidence that an action succeeded, so
    // nothing here waits on it. A navigation can destroy its context anyway.
    function overlay(point, action, hl, path) {
      return boundedJs(wc, cursorScript({ ...point, action, name: botName(botId), c: accent, hl: hl || null, path: path && path.length > 1 ? path : null })).catch(() => {});
    }
    function cursor(point, action, hl) {
      check();
      tab.agentCursor = { ...point, action, name: botName(botId), c: accent, hl: hl || null, updatedAt: Date.now() };
      overlay(point, action, hl);
    }
    async function moveCursor(point, hl) {
      // The glide is overlay-only and exists for a person watching: a tab the
      // human is not looking at gets one real pointer event and no pacing.
      const path = visible ? cursorPath(tab.agentCursor, point) : [point];
      check();
      const glide = overlay(point, 'move', hl, path);
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point, button: 'none', buttons: 0 });
      tab.agentCursor = { ...point, action: 'move', name: botName(botId), c: accent, hl: hl || null, updatedAt: Date.now() };
      if (path.length > 1) { await Promise.race([glide, delay(path.length * 16 + 150)]); check(); }
    }
    async function viewportPoint(x, y) {
      const viewport = await boundedJs(wc, `({ width: innerWidth, height: innerHeight, challenge: (${CHALLENGE_HIT_SOURCE})([${JSON.stringify({ x, y })}], false) })`);
      check();
      if (x < 0 || y < 0 || x >= viewport.width || y >= viewport.height) throw fail('Pointer coordinates must be inside the tab viewport.');
      if (typeof viewport.challenge?.kind === 'string') throw challengePresent(viewport.challenge);
      return { x, y };
    }
    async function resolve(target, options) {
      const found = await boundedJs(wc, resolveScript(target, { ...options, seed: tab.refSeed }));
      check();
      if (found && found.fail === 'stale') throw staleRef(target.ref);
      if (found && found.fail === 'challenge') throw challengePresent(found.challenge);
      const listed = (items) => items.map((item) => `${item.ref} ${JSON.stringify(item.name || '')}${item.row ? ` (row ${JSON.stringify(item.row)})` : ''}`).join(', ');
      const unread = found && found.cut ? ' The page has more controls than a name lookup reads; snapshot or scroll for the rest.' : '';
      if (found && found.fail === 'unnamed') {
        for (const item of found.near) issueRef(tab, item.ref);
        throw fail(`No visible control is named exactly ${JSON.stringify(target.name)}${target.role ? ` with role ${target.role}` : ''}${target.row ? ` in a row with ${JSON.stringify(target.row)}` : ''}.${found.near.length ? ` Close matches: ${listed(found.near)}. Act on one by ref if it is the one you mean.` : ' Snapshot to see the controls on the page.'}${unread}`);
      }
      if (found && found.fail === 'ambiguous') {
        for (const item of found.many) issueRef(tab, item.ref);
        throw fail(`${found.count} controls match ${JSON.stringify(target.name)}: ${listed(found.many)}${found.count > found.many.length ? ', ...' : ''}. Act on one by ref, or narrow with role or row.${unread}`);
      }
      if (found && found.ref) issueRef(tab, found.ref);
      if (found && found.fail === 'covered') {
        const { name, close, closeName } = found.layer;
        if (close) issueRef(tab, close);
        throw fail(`Element is covered by ${JSON.stringify(name || 'an overlay')}. ${close ? `Close it first: click ${close} (${JSON.stringify(closeName)}), then retry.` : 'Close it first (press Escape or click its close control), then retry.'}`);
      }
      if (!found || found.fail) throw fail(`Element is ${found ? found.fail : 'unavailable'}. Request a fresh snapshot or use a different selector.`);
      return found;
    }
    const probe = async (expression) => { const look = await boundedJs(wc, `(() => { const C = ${commitSource(tab.refSeed)}; return ${expression}; })()`).catch(() => null); check(); return look && typeof look === 'object' ? look : null; };
    // A target is judged by its names, and Enter in a field by the controls
    // its form submits with. Input the router cannot judge by name (an
    // unnamed control, a field outside a form) is the router's to refuse.
    // Input landing in a cross-origin frame (an embedded booking or payment
    // widget) has no name the app can read, so it needs approval; a page that
    // did not answer fails closed when it shows a commit control.
    async function judge(look) {
      const what = action === 'press' ? `pressing ${keyEvent.key === ' ' ? 'Space' : 'Enter'}` : `a ${action.replace('_', '-')}`;
      if (look && look.frame) throw commitRequired(`${what} here lands in a cross-origin frame, where the app cannot read what it would set off`);
      if (!look) {
        const page = await pageNames(tab);
        check();
        if (!page) throw commitRequired(`the page did not answer the commit check, so ${what} could set off a commit control`);
        const live = page.names.find(looksLikeCommit);
        if (live) throw commitRequired(`${what} where the app cannot read the page here could set off "${live.slice(0, 80)}"`);
        return;
      }
      // Clicking into a field, a checkbox or a select, or typing a space, submits nothing.
      if (look.field && (action !== 'press' || keyEvent.windowsVirtualKeyCode === 32)) return;
      const enterInField = action === 'press' && look.field;
      const hit = ((enterInField ? look.form : look.names) || []).find(looksLikeCommit);
      if (hit) throw commitRequired(enterInField ? `pressing Enter here submits the form with "${hit.slice(0, 80)}", which ${LOOKS}` : `"${hit.slice(0, 80)}" ${LOOKS}`);
    }
    // The page-side tracker counts the follow-up work the action starts (its
    // short timers and requests) so the effect read can wait it out. Arm just
    // before the real dispatch; a failed probe must not stall the action.
    const armFollowUp = () => boundedJs(wc, followUpArmExpression(), 3000).catch(() => {});
    const closeFollowUp = () => boundedJs(wc, followUpCloseExpression(), 3000).catch(() => {});
    const watching = watchNavigation(wc, delay);
    own.active++;
    if (own.active === 1) onBusy(tab, true);
    wc.setIgnoreMenuShortcuts(true);
    let succeeded = false;
    try {
      // Focus emulation persists for the tab's agent lifetime; toggling it per
      // action was two CDP round-trips on every dispatch.
      if (!tab.focusEmulation) { tab.focusEmulation = true; await send('Emulation.setFocusEmulationEnabled', { enabled: true }); }
      let point, found = {}, likelyNavigation = false, extra = {}, end = null;
      let target = { ref: body.ref, selector: body.selector, name: body.name, role: body.role, row: body.row };
      // The source resolves last: scrolling it into view must not move a destination found earlier.
      if (to && (to.ref || to.selector)) end = await resolve(to, { look: gated });
      if (body.ref || body.selector || body.name) {
        found = await resolve(target, { focus: action === 'type' || action === 'press', type: action === 'type', select: action === 'select', probe: action === 'click', look: gated });
        const { hl, submit, nav, ref, resolved, partial, look, ...xy } = found;
        point = xy; found = { hl, submit, nav, look };
        // A named control is the ref it resolved to from here on, and the reply
        // says which, by its full name (a near match is visible).
        if (ref) { target = { ref }; extra.ref = ref; extra.resolved = resolved; if (partial) extra.partial = true; }
      } else if (POINTER_ACTIONS.has(action)) point = await viewportPoint(body.x, body.y);
      if (gated) {
        const at = (x, y) => probe(`C.look(C.hit(${Number(x)}, ${Number(y)}))`);
        await judge(found.look || await (action === 'press' ? probe('C.look(C.focus())') : at(point.x, point.y)));
        if (action === 'drag') await judge(end ? end.look : await at(to.x, to.y));
      }
      const hl = found.hl || null;
      if (CLICKS[action] || action === 'move') {
        await moveCursor(point, hl);
        if (CLICKS[action]) {
          const kind = CLICKS[action];
          await armFollowUp();
          for (let count = 1; count <= kind.count; count++) {
            mouseDown = { point, button: kind.button };
            await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: kind.button, buttons: kind.buttons, clickCount: count });
            await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: kind.button, buttons: 0, clickCount: count });
            mouseDown = null;
          }
          // A submit button reports whether the page left its submit alone; only
          // an uncancelled submit navigates, so a handled one needs no wait.
          if (found.submit) {
            const submitted = await boundedJs(wc, `(() => {
              const el = ${locateElement(target)};
              return (el?.ownerDocument.defaultView || window)[Symbol.for(${JSON.stringify(SUBMIT_KEY)})] || null;
            })()`).catch(() => null);
            found.nav = submitted === 'navigates'; found.certain = found.nav;
          }
          likelyNavigation = found.certain ? 'certain' : !!found.nav;
          cursor(point, 'click', hl);
        }
      } else if (action === 'drag') {
        const { hl: endHl, submit, nav, look, ref, resolved, partial, ...target } = end || await viewportPoint(to.x, to.y);
        await moveCursor(point, hl);
        await armFollowUp();
        const path = cursorPath(point, target);
        mouseDown = { point, button: 'left' };
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 });
        const glide = visible ? overlay(target, 'move', endHl, path) : null;
        for (const next of path) {
          if (visible) { await delay(16); check(); }
          await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...next, button: 'left', buttons: 1 });
        }
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...target, button: 'left', buttons: 0, clickCount: 1 });
        mouseDown = null;
        if (glide) await Promise.race([glide, delay(path.length * 16 + 150)]);
        cursor(target, 'move', endHl);
      } else if (action === 'select') {
        await moveCursor(point, hl);
        await armFollowUp();
        const picked = await boundedJs(wc, selectScript(target, body));
        check();
        if (picked && picked.fail === 'stale') throw staleRef(body.ref);
        if (picked && picked.fail === 'challenge') throw challengePresent(picked.challenge);
        if (!picked || picked.fail) throw fail(`Element ${picked ? picked.fail : 'is unavailable'}${picked?.options ? ': ' + JSON.stringify(picked.options) : ''}.`);
        extra.matched = picked.matched;
        cursor(point, 'click', hl);
      } else if (action === 'type') {
        // insertText is actual Chromium input (including input/beforeinput).
        // The selection belongs to the agent tab, never the human's focused tab.
        await armFollowUp();
        if (body.text) {
          await send('Input.insertText', { text: body.text });
          // A key event sent before the renderer has produced a frame after the
          // insertion is dropped silently (the CDP ack comes first). Hidden pages
          // may never paint, so the wait is capped.
          await boundedJs(wc, 'new Promise(done => { setTimeout(done, 500); requestAnimationFrame(() => requestAnimationFrame(done)); })', 1500).catch(() => {});
        }
        else await keys(keyboardEvent({ key: 'Backspace' }));
        cursor(point, 'type', hl);
      } else if (action === 'press') {
        // A key goes to whatever has focus, wherever that is (a frame, a shadow
        // root, a widget the page focused itself), so every press checks it.
        // The check rides on the follow-up arm: no extra round trip.
        const armed = await boundedJs(wc, `(() => { const challenge = (${CHALLENGE_HIT_SOURCE})([], true); return { challenge, armed: !challenge && ${followUpArmExpression()} }; })()`, 3000).catch(() => { throw checkFailed(); });
        check();
        if (typeof armed?.challenge?.kind === 'string') throw challengePresent(armed.challenge);
        await keys(keyEvent);
        likelyNavigation = keyEvent.key === 'Enter';
        if (point || tab.agentCursor) cursor(point || { x: tab.agentCursor.x, y: tab.agentCursor.y }, 'press', hl);
      } else if (action === 'scroll') {
        // The wheel lands where the cursor is: never on a challenge.
        const aim = await boundedJs(wc, `(() => { const p = { x: Math.max(0, Math.min(${Number.isFinite(tab.agentCursor?.x) ? tab.agentCursor.x : 100}, innerWidth - 1)), y: Math.max(0, Math.min(${Number.isFinite(tab.agentCursor?.y) ? tab.agentCursor.y : 100}, innerHeight - 1)) }; return { ...p, challenge: (${CHALLENGE_HIT_SOURCE})([p], false) }; })()`);
        check();
        if (typeof aim.challenge?.kind === 'string') throw challengePresent(aim.challenge);
        point = { x: aim.x, y: aim.y };
        await armFollowUp();
        await send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: Math.max(-2000, Math.min(2000, body.x || 0)), deltaY: Math.max(-2000, Math.min(2000, body.y || 0)) });
        cursor(point, 'scroll');
      }
      if (action !== 'move') await closeFollowUp();
      await watching.settle(likelyNavigation);
      check();
      succeeded = true;
      return { dispatched: true, input: 'tab-cdp', cursor: tab.agentCursor || null, navigated: watching.navigated(), ...extra };
    } finally {
      watching.stop();
      if (!wc.isDestroyed()) {
        // Releasing outside the viewport cannot finish a revoked click on its
        // old target. No native input or synthetic retry is used for cleanup.
        if (mouseDown) await command(tab, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: -1, y: -1, button: mouseDown.button, buttons: 0, clickCount: 0 }).catch(() => {});
        if (keyDown) { const { text, commands, ...released } = keyDown; await command(tab, 'Input.dispatchKeyEvent', { type: 'keyUp', ...released }).catch(() => {}); }
        // Failures release the per-tab focus hold; success leaves it on until
        // clear() runs on teardown or a control change.
        if (!succeeded && tab.focusEmulation) { tab.focusEmulation = false; await command(tab, 'Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {}); }
        wc.setIgnoreMenuShortcuts(false);
      }
      own.active--;
      if (!own.active) onBusy(tab, false);
    }
  }
  return { perform, clear, isDispatching, approve, guard };
}

module.exports = { createAgentInput, APPROVED, refuseChallenge, tintScript, botAccent, cursorPath, INPUT_ACTIONS, keyboardEvent, locateElement, boundedJs, readJs, frameOf, watchNavigation };
