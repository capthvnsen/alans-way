// All input stays inside this tab's Chromium target. Never focus a native view,
// activate a window, use the clipboard for typing, or move the system pointer.
const { followUpArmExpression, followUpCloseExpression, FOLLOW_UP_KEY } = require('./browser-page.cjs');
const INPUT_ACTIONS = new Set(['move', 'click', 'double_click', 'right_click', 'drag', 'type', 'press', 'scroll', 'select']);
const CLICKS = { click: { button: 'left', buttons: 1, count: 1 }, double_click: { button: 'left', buttons: 1, count: 2 }, right_click: { button: 'right', buttons: 2, count: 1 } };
const POINTER_ACTIONS = new Set(['move', 'drag', ...Object.keys(CLICKS)]);
const CURSOR_ID = 'hermes-workspace-agent-cursor';
// The submit probe's flag and listener ride under a symbol key: an enumerable
// window global is how bot detectors spot injected state.
const SUBMIT_KEY = 'hw.submit', SUBMIT_SEEN_KEY = 'hw.submitSeen';
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

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

// document.querySelector stays in the light DOM. Refs stamped inside an open
// shadow root are found by walking those roots; a closed root is not readable.
function locateElement(selectorSource) {
  return `(() => {
    const sel = ${selectorSource};
    const queue = [document];
    const seen = new Set();
    for (let i = 0; i < queue.length && i < 40; i++) {
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

const selectorFor = (target) => JSON.stringify(target.ref ? `[data-hermes-workspace-ref~="${target.ref}"]` : target.selector);

// One round trip finds the element, scrolls only when it is out of view, hit
// tests it, readies focus for typing and reports what a click needs to know.
function resolveScript(target, { focus = false, type = false, select = false, probe = false } = {}) {
  return `(async () => {
    const el = ${locateElement(selectorFor(target))};
    if (!el || el.disabled || el.matches(':disabled') || el.closest('[inert]')) return { fail: 'missing or disabled' };
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
    let point = null, coveredBy = '';
    for (const [fx, fy] of [[.5,.5],[.5,.25],[.5,.75],[.25,.5],[.75,.5],[.2,.2],[.8,.2],[.2,.8],[.8,.8]]) {
      const lx = Math.round(l + w * fx), ly = Math.round(t + h * fy);
      const hit = view.document.elementFromPoint(lx, ly);
      // elementFromPoint retargets a hit inside a shadow root to its host and
      // Node.contains stops at the shadow boundary, so only a walk up the
      // composed tree sees a host or wrapper ancestor as the target itself.
      let own = false;
      for (let n = el; n && !own; n = n.parentNode || n.host) own = n === hit;
      if (hit && (own || el.contains(hit))) { point = { x: lx + ox, y: ly + oy }; break; }
      if (hit && !coveredBy && !own && !el.contains(hit)) coveredBy = hit.tagName.toLowerCase() + (hit.id ? '#' + hit.id : hit.className && typeof hit.className === 'string' ? '.' + hit.className.trim().split(/\\s+/)[0] : '');
    }
    if (!point && loose) point = { x: Math.round(l + w / 2 + ox), y: Math.round(t + h / 2 + oy) };
    if (!point) return { fail: coveredBy ? 'covered by ' + coveredBy : 'no clickable point' };
    if (${focus}) {
      if (${type} && !(el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' && /^(text|search|email|url|tel|password|number)$/.test(el.type)) || el.readOnly) return { fail: 'element cannot accept text' };
      el.focus({ preventScroll: true });
      if (${type}) {
        if (typeof el.select === 'function') el.select();
        else { const doc = el.ownerDocument; const range = doc.createRange(); range.selectNodeContents(el); const s = doc.getSelection(); s.removeAllRanges(); s.addRange(range); }
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
    return { ...point, submit, nav: submit || link, hl: { x: Math.round(r.left + ox), y: Math.round(r.top + oy), width: Math.round(r.width), height: Math.round(r.height) } };
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
    const el = ${locateElement(selectorFor(target))};
    if (!el || el.tagName !== 'SELECT') return { fail: 'is not a select' };
    if (el.disabled) return { fail: 'disabled' };
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

function createAgentInput({ command, requireActor, botName = () => 'Agent', onBusy = () => {}, isVisible = () => true, delay = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const states = new WeakMap();
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
    const knownRef = (ref) => typeof ref === 'string' && /^s\d+-\d+$/.test(ref) && tab.refs.has(ref);
    if (body.ref !== undefined && !knownRef(body.ref)) throw fail('Stale or unknown reference. Request a fresh snapshot.', 409);
    if (body.selector !== undefined && (typeof body.selector !== 'string' || !body.selector || body.selector.length > 2000)) throw fail('Provide a CSS selector up to 2,000 characters.');
    if ((action === 'type' || action === 'select') && !body.ref && !body.selector) throw fail(`${action === 'type' ? 'Typing' : 'Selecting'} requires an element reference or selector.`);
    if (POINTER_ACTIONS.has(action) && !body.ref && !body.selector && (!Number.isFinite(body.x) || !Number.isFinite(body.y))) throw fail('Provide a fresh element reference, selector, or viewport x and y coordinates.');
    if (action === 'scroll' && [body.x, body.y].some(value => value !== undefined && !Number.isFinite(value))) throw fail('Scroll deltas must be finite numbers.');
    if (action === 'select' && ![body.value, body.label, body.option, body.text, body.choice].some(item => typeof item === 'string' && item.length <= 1000)) throw fail('Provide the option value, label, option, text or choice (up to 1,000 characters).');
    let to = null;
    if (action === 'drag') {
      if (body.toRef !== undefined && !knownRef(body.toRef)) throw fail('Stale or unknown destination reference. Request a fresh snapshot.', 409);
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
      const viewport = await boundedJs(wc, '({ width: innerWidth, height: innerHeight })');
      check();
      if (x < 0 || y < 0 || x >= viewport.width || y >= viewport.height) throw fail('Pointer coordinates must be inside the tab viewport.');
      return { x, y };
    }
    async function resolve(target, options) {
      const found = await boundedJs(wc, resolveScript(target, options));
      check();
      if (!found || found.fail) throw fail(`Element is ${found ? found.fail : 'unavailable'}. Request a fresh snapshot or use a different selector.`);
      return found;
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
      // The source resolves last: scrolling it into view must not move a destination found earlier.
      if (to && (to.ref || to.selector)) end = await resolve(to);
      if (body.ref || body.selector) {
        found = await resolve(body, { focus: action === 'type' || action === 'press', type: action === 'type', select: action === 'select', probe: action === 'click' });
        const { hl, submit, nav, ...xy } = found;
        point = xy; found = { hl, submit, nav };
      } else if (POINTER_ACTIONS.has(action)) point = await viewportPoint(body.x, body.y);
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
              const el = ${locateElement(selectorFor(body))};
              return (el?.ownerDocument.defaultView || window)[Symbol.for(${JSON.stringify(SUBMIT_KEY)})] || null;
            })()`).catch(() => null);
            found.nav = submitted === 'navigates'; found.certain = found.nav;
          }
          likelyNavigation = found.certain ? 'certain' : !!found.nav;
          cursor(point, 'click', hl);
        }
      } else if (action === 'drag') {
        const { hl: endHl, submit, nav, ...target } = end || await viewportPoint(to.x, to.y);
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
        const picked = await boundedJs(wc, selectScript(body, body));
        check();
        if (!picked || picked.fail) throw fail(`Element ${picked ? picked.fail : 'is unavailable'}${picked?.options ? ': ' + JSON.stringify(picked.options) : ''}.`);
        extra = { matched: picked.matched };
        cursor(point, 'click', hl);
      } else if (action === 'type') {
        // insertText is actual Chromium input (including input/beforeinput).
        // The selection belongs to the agent tab, never the human's focused tab.
        await armFollowUp();
        if (body.text) await send('Input.insertText', { text: body.text });
        else await keys(keyboardEvent({ key: 'Backspace' }));
        cursor(point, 'type', hl);
      } else if (action === 'press') {
        await armFollowUp();
        await keys(keyEvent);
        likelyNavigation = keyEvent.key === 'Enter';
        if (point || tab.agentCursor) cursor(point || { x: tab.agentCursor.x, y: tab.agentCursor.y }, 'press', hl);
      } else if (action === 'scroll') {
        const viewport = await boundedJs(wc, '({ width: innerWidth, height: innerHeight })');
        check();
        point = { x: Math.max(0, Math.min(tab.agentCursor?.x ?? 100, viewport.width - 1)), y: Math.max(0, Math.min(tab.agentCursor?.y ?? 100, viewport.height - 1)) };
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
  return { perform, clear, isDispatching };
}

module.exports = { createAgentInput, tintScript, botAccent, cursorPath, INPUT_ACTIONS, keyboardEvent, locateElement, boundedJs, readJs, frameOf, watchNavigation };
