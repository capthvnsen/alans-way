const crypto = require('node:crypto');

// Drops tracking parameters and fragments; keeps only web and mail links.
const SHORT_HREF = `(raw) => {
  if (!raw) return '';
  try {
    const url = new URL(raw, location.href);
    if (url.protocol !== 'https:' && url.protocol !== 'http:' && url.protocol !== 'mailto:') return '';
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      for (const key of [...url.searchParams.keys()]) {
        if (/^(utm_|fbclid$|gclid$|mc_eid$|mc_cid$|igshid$|_hsenc$|_hsmi$)/.test(key)) url.searchParams.delete(key);
      }
      url.hash = '';
    }
    return url.href.slice(0, 300);
  } catch { return ''; }
}`;
const REFS_KEY = 'hw.refs';
const PICK = 'a[href],button,summary,input:not([type="hidden"]),textarea,select,[onclick],[role="button"],[role="link"],[role="tab"],[role="checkbox"],[role="radio"],[role="switch"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="option"],[role="treeitem"],[role="slider"],[role="combobox"],[role="textbox"],[role="searchbox"],[role="spinbutton"],[contenteditable="true"]';
// The page-side ref store, kept on the document's window under a registered
// symbol. A ref names one control for the life of the document: it follows
// the node through any change to the page, and when the page re-renders the
// control as a new node it moves to that node only if exactly one new control
// has the same role, name, row and address and no other lost ref shares them.
// Anything less certain is a stale ref, never a guess. Agent input resolves
// refs through the same store (find), so a planted attribute cannot redirect one.
// seed is the highest ref the tab has handed out: whichever script first
// opens a document's store (a snapshot, a name lookup), numbering continues
// past it, so a ref remembered from an earlier page never names a control here.
function refsSource(seed = 0) {
  const floor = Number.isInteger(seed) && seed > 0 ? seed : 0;
  return `(() => {
    const key = Symbol.for(${JSON.stringify(REFS_KEY)});
    let S = window[key];
    if (!S || S.doc !== document) {
      S = { doc: document, n: 0, byRef: new Map(), byNode: new WeakMap() };
      try { Object.defineProperty(window, key, { value: S, configurable: true }); } catch { try { window[key] = S; } catch {} }
    }
    S.n = Math.max(S.n, ${floor});
    const shortHref = ${SHORT_HREF};
    const pick = ${JSON.stringify(PICK)};
    // Widgets with no native tag or listed role: a state attribute, or a
    // focusable custom element. Containers around real controls are skipped
    // below so the host and the control inside its shadow root do not both show.
    const loosePick = pick + ',[aria-checked],[aria-pressed],[tabindex]:not([tabindex^="-"])';
    S.live = (ref) => { const r = S.byRef.get(ref), node = r && r.node.deref(); return node && node.isConnected ? node : null; };
    S.refOf = (el) => { const ref = S.byNode.get(el); return ref && S.live(ref) === el ? ref : ''; };
    // Visible controls in page order, through open shadow roots and
    // same-origin frames. A closed root reads null here, which keeps the
    // agent cursor (and anything else the page sealed) out.
    S.collect = (deadline, maxScan, maxElements) => {
      const queue = [document], seenRoot = new Set(), candidates = [], list = [];
      let more = false;
      while (queue.length && seenRoot.size < 600 && performance.now() <= deadline) {
        const root = queue.shift();
        if (seenRoot.has(root)) continue;
        seenRoot.add(root);
        try { for (const el of root.querySelectorAll(loosePick)) candidates.push(el); } catch {}
        const start = root.nodeType === 11 ? root : (root.documentElement || root.body || null);
        if (!start) continue;
        const walker = document.createTreeWalker(start, NodeFilter.SHOW_ELEMENT);
        let node, walked = 0;
        while ((node = walker.nextNode()) && walked++ < 4000) {
          if (performance.now() > deadline) { more = true; break; }
          if (node.shadowRoot && !seenRoot.has(node.shadowRoot)) queue.push(node.shadowRoot);
        }
        if (walked >= 4000) more = true;
        let frames = [];
        try { frames = root.querySelectorAll('iframe'); } catch {}
        for (const frame of frames) {
          let doc = null;
          try { doc = frame.contentDocument; } catch {}
          if (doc && !seenRoot.has(doc)) queue.push(doc);
        }
      }
      if (queue.length) more = true;
      let scanned = 0;
      for (const el of candidates) {
        if (el.tagName === 'BODY' || el.tagName === 'HTML') continue;
        if (scanned >= maxScan || list.length >= maxElements || performance.now() > deadline) break;
        scanned++;
        // checkVisibility rejects display:none/visibility:hidden without forcing
        // layout; only survivors pay for the rect that catches zero-area boxes.
        if (el.checkVisibility ? !el.checkVisibility({ checkVisibilityCSS: true })
          : (s => s.visibility === 'hidden' || s.display === 'none')(getComputedStyle(el))) continue;
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        if (!el.matches(pick)) {
          const stateful = el.hasAttribute('aria-checked') || el.hasAttribute('aria-pressed');
          if (!stateful && el.localName.indexOf('-') < 0) continue;
          if (el.querySelector(pick) || (el.shadowRoot && el.shadowRoot.querySelector(pick))) continue;
        }
        list.push(el);
      }
      return { list, more: more || scanned < candidates.length || list.length >= maxElements };
    };
    // role and name as a person reads the control; base is the name without
    // its state words (on, off, open ...), so a toggled control keeps its identity.
    S.describe = (el) => {
      let name = '';
      const labelledby = el.getAttribute('aria-labelledby');
      if (labelledby) {
        const root = el.getRootNode();
        name = labelledby.split(/\\s+/).map(id => {
          const node = root.getElementById ? root.getElementById(id) : null;
          return (node && (node.innerText || node.textContent) || '').trim();
        }).filter(Boolean).join(' ').trim();
      }
      if (!name) name = (el.getAttribute('aria-label') || el.placeholder || el.title || '').trim();
      if (!name && el.labels && el.labels[0]) {
        const labelText = (el.labels[0].innerText || '').trim();
        const own = (el.innerText || '').trim();
        name = own && labelText.endsWith(own) ? labelText.slice(0, -own.length).trim() : labelText;
      }
      if (!name) name = (el.innerText || '').trim();
      // A control inside a shadow root is usually named by its host (a slotted
      // label, or a label attribute).
      for (let host = el.getRootNode().host, hops = 0; !name && host && hops < 3; host = host.getRootNode().host, hops++) {
        name = (host.getAttribute('aria-label') || host.getAttribute('label') || host.innerText || '').trim();
      }
      if (el.tagName === 'SELECT' && el.selectedIndex >= 0) {
        const picked = (el.options[el.selectedIndex].label || el.options[el.selectedIndex].text || '').trim();
        if (picked && picked !== name) name = (name ? name + ' ' : '') + picked;
      }
      const base = name.replace(/\\s+/g, ' ').trim().slice(0, 200);
      const ariaChecked = el.getAttribute('aria-checked');
      const checked = /^(checkbox|radio)$/.test(el.type) ? !!el.checked : ariaChecked === 'true' ? true : ariaChecked === 'false' ? false : null;
      if (checked === true) name += ' on';
      else if (checked === false) name += ' off';
      else {
        const pressed = el.getAttribute('aria-pressed');
        if (pressed === 'true') name += ' on';
        else if (pressed === 'false') name += ' off';
      }
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') name += ' disabled';
      const expanded = el.getAttribute('aria-expanded');
      if (expanded === 'true') name += ' open';
      else if (expanded === 'false') name += ' closed';
      else if (el.tagName === 'SUMMARY' && el.parentElement && el.parentElement.tagName === 'DETAILS') name += el.parentElement.open ? ' open' : ' closed';
      if (el.getAttribute('aria-selected') === 'true') name += ' selected';
      if (el.getAttribute('aria-current') === 'page') name += ' current';
      const type = el.type || '';
      return { role: el.getAttribute('role') || el.tagName.toLowerCase(), name: name.trim().slice(0, 200), base, type,
        value: type === 'password' ? '[password]' : String(el.value || '').slice(0, 200),
        href: shortHref(typeof el.href === 'string' ? el.href : (el.getAttribute('href') || '')) };
    };
    // The text around a control that shares its name with others (the row,
    // card or list item it sits in), without the control's own name: what
    // tells one "Delete" from the next for a person reading the page.
    S.rowOf = (el, name) => {
      const up = (node) => node.parentElement || (node.getRootNode() && node.getRootNode().host) || null;
      for (let node = up(el), hops = 0; node && hops < 4; node = up(node), hops++) {
        if (node.tagName === 'BODY' || node.tagName === 'HTML') return '';
        const text = (node.textContent || '').replace(/\\s+/g, ' ').trim();
        if (text.length <= name.length + 1) continue;
        if (text.length > 200) return '';
        const at = name ? text.indexOf(name) : -1;
        return (at >= 0 ? text.slice(0, at) + ' ' + text.slice(at + name.length) : text).replace(/\\s+/g, ' ').trim().slice(0, 60);
      }
      return '';
    };
    // Identity for a rebind: role, base name, row when the name repeats, and
    // the address including a hash route. A repeated name with no row text to
    // tell it apart has no identity (null) and is never rebound.
    S.keys = (entries) => {
      const count = new Map(), here = location.pathname + location.search + location.hash;
      for (const x of entries) { const k = x.d.role + '\\u0001' + x.d.base; count.set(k, (count.get(k) || 0) + 1); }
      for (const x of entries) {
        const repeated = count.get(x.d.role + '\\u0001' + x.d.base) > 1;
        if (repeated) x.row = S.rowOf(x.el, x.d.base);
        x.key = repeated && !x.row ? null : [x.d.role, x.d.base, x.row || '', here].join('\\u0001');
      }
    };
    // Lost refs by identity; a key two lost refs share maps to null (ambiguous).
    const retired = () => {
      const out = new Map();
      for (const [ref, r] of S.byRef) if (r.key && !S.live(ref)) out.set(r.key, out.has(r.key) ? null : ref);
      return out;
    };
    // whole is true for a full scan, the only list that knows which names
    // repeat: refs handed out for a few controls (a name target, an overlay's
    // close) get no identity, so they never rebind on a partial view.
    S.assign = (entries, seed, whole = true) => {
      S.n = Math.max(S.n, seed);
      S.keys(entries);
      if (!whole) for (const x of entries) x.key = null;
      const fresh = entries.filter((x) => !S.refOf(x.el));
      if (fresh.length) {
        const lost = whole ? retired() : new Map(), count = new Map();
        for (const x of fresh) count.set(x.key, (count.get(x.key) || 0) + 1);
        for (const x of fresh) {
          const old = x.key && count.get(x.key) === 1 ? lost.get(x.key) : null;
          if (old) lost.delete(x.key);
          const ref = old || 'e' + (++S.n);
          S.byNode.set(x.el, ref);
          S.byRef.set(ref, { node: new WeakRef(x.el), key: x.key });
        }
      }
      for (const x of entries) { x.ref = S.byNode.get(x.el); if (whole) S.byRef.get(x.ref).key = x.key; }
      // Lost refs only matter for a rebind; a long-lived page keeps the newest.
      if (S.byRef.size > 3000) for (const [ref] of S.byRef) { if (S.byRef.size <= 2000) break; if (!S.live(ref)) S.byRef.delete(ref); }
    };
    // A fixed layer over a quarter or more of the viewport (a modal, a
    // cookie banner) eats clicks meant for the page under it. It is named the
    // way a person would read it, with the control that dismisses it,
    // preferring the choice that shares nothing (close, no thanks, reject).
    // listed is for a layer found by looking, not by a blocked click: an app
    // whose whole shell is fixed holds most of the page's controls, and that
    // is the page, not something over it.
    S.layer = (el, listed = false) => {
      let layer = null;
      for (let node = el; node && node.nodeType === 1; node = node.parentElement || (node.getRootNode() && node.getRootNode().host) || null) {
        if (typeof node.id === 'string' && node.id.indexOf('hermes-workspace-agent-cursor') === 0) return null;
        if (getComputedStyle(node).position === 'fixed') layer = node;
      }
      if (!layer) return null;
      const box = layer.getBoundingClientRect();
      if (box.width * box.height < innerWidth * innerHeight * 0.25) return null;
      if (listed && layer.querySelectorAll(pick).length * 2 > document.querySelectorAll(pick).length) return null;
      const dialog = layer.matches('dialog,[role=dialog],[role=alertdialog]') ? layer : layer.querySelector('dialog,[role=dialog],[role=alertdialog]') || layer;
      let name = (dialog.getAttribute('aria-label') || '').trim();
      const labelledby = dialog.getAttribute('aria-labelledby');
      if (!name && labelledby) name = labelledby.split(/\\s+/).map((id) => (document.getElementById(id) || {}).textContent || '').join(' ');
      const heading = !name && dialog.querySelector('h1,h2,h3,h4,legend');
      if (heading) name = heading.textContent || '';
      // No title: its words, leaving out its buttons and links.
      if (!name) {
        const words = [], walk = document.createTreeWalker(dialog, NodeFilter.SHOW_TEXT);
        for (let node; (node = walk.nextNode()) && words.join(' ').length < 80;) if (!node.parentElement.closest('button,a,[role=button]')) words.push(node.nodeValue);
        name = words.join(' ');
      }
      // Nothing to read: name the element itself, the way an error would.
      const tag = layer.localName + (layer.id ? '#' + layer.id : typeof layer.className === 'string' && layer.className.trim() ? '.' + layer.className.trim().split(/\\s+/)[0] : '');
      const out = { name: name.replace(/\\s+/g, ' ').trim().slice(0, 80) || tag };
      // A real dialog is searched on its own, and only a banner falls back to
      // its accept choice: a confirm dialog's Continue is never offered as a way out.
      const real = dialog !== layer || layer.matches('dialog,[role=dialog],[role=alertdialog]');
      const controls = [...(real ? dialog : layer).querySelectorAll('button,a[href],[role=button],input[type=button],input[type=submit]')].filter((c) => c.getClientRects().length);
      const label = (c) => S.describe(c).base;
      const close = controls.find((c) => /^(close|dismiss|cancel|no|no,? thanks|not now|maybe later|skip|reject( all)?|decline( all)?|×|✕|x)$/i.test(label(c)) || /^(close|dismiss)/i.test(c.getAttribute('aria-label') || ''))
        || (!real && controls.find((c) => /^(accept( all)?|got it|ok|okay|agree)$/i.test(label(c))));
      if (close) {
        if (!S.refOf(close)) S.assign([{ el: close, d: S.describe(close) }], S.n, false);
        out.close = S.refOf(close);
        out.closeName = label(close);
      }
      return { layer, out };
    };
    // Every such layer over a 3x3 grid of the viewport, stacked ones too
    // (a newsletter modal over a cookie banner), topmost first.
    S.overlays = () => {
      const seen = new Set(), layers = new Set(), out = [];
      for (const fy of [1 / 6, 1 / 2, 5 / 6]) for (const fx of [1 / 6, 1 / 2, 5 / 6]) {
        for (const hit of document.elementsFromPoint(innerWidth * fx, innerHeight * fy)) {
          if (seen.has(hit)) continue;
          seen.add(hit);
          if (getComputedStyle(hit).position !== 'fixed') continue;
          const found = S.layer(hit, true);
          if (found && !layers.has(found.layer)) { layers.add(found.layer); if (out.length < 3) out.push(found.out); }
        }
      }
      return out;
    };
    // A control by the name a snapshot lists for it, the way a person names
    // it: exact, then starting with, then containing the words; role (a tag
    // or ARIA role such as link, button, textbox, checkbox) and row narrow it.
    // Only an exact match (case and spacing aside) is acted on, and only when
    // it is the one: several come back as candidates, and near matches
    // ("Cancel subscription" for "Cancel") come back as suggestions, never a guess.
    // cut says the page had more controls than the lookup read.
    const norm = (text) => String(text || '').toLowerCase().replace(/\\s+/g, ' ').trim();
    const implicit = (el, d) => {
      if (el.getAttribute('role')) return d.role;
      if (el.tagName === 'INPUT') return { checkbox: 'checkbox', radio: 'radio', submit: 'button', button: 'button', reset: 'button', range: 'slider', search: 'searchbox' }[d.type] || 'textbox';
      return { a: 'link', select: 'combobox', textarea: 'textbox', summary: 'button' }[d.role] || d.role;
    };
    S.byName = (name, role, row) => {
      const want = norm(name), wantRole = norm(role), wantRow = norm(row);
      const found = S.collect(performance.now() + 400, 6000, 2000), cut = found.more;
      const entries = found.list.map((el) => ({ el, d: S.describe(el) }));
      S.keys(entries);
      const pool = entries.filter((x) => (!wantRole || x.d.role === wantRole || implicit(x.el, x.d) === wantRole)
        && (!wantRow || norm(x.row || S.rowOf(x.el, x.d.base)).includes(wantRow)));
      const listed = (hits) => {
        S.assign(hits, 0, false);
        return hits.slice(0, 8).map((x) => ({ ref: x.ref, name: x.d.name, ...(x.row ? { row: x.row } : {}) }));
      };
      const exact = pool.filter((x) => norm(x.d.base) === want || norm(x.d.name) === want);
      if (exact.length === 1) { S.assign(exact, 0, false); return { el: exact[0].el, ref: exact[0].ref, name: exact[0].d.name, cut }; }
      if (exact.length) return { count: exact.length, many: listed(exact), cut };
      const near = pool.filter((x) => norm(x.d.base).includes(want) || norm(x.d.name).includes(want));
      return { near: listed(near), cut };
    };
    S.find = (ref) => {
      const r = S.byRef.get(ref);
      if (!r) return null;
      const node = S.live(ref);
      if (node) return node;
      if (!r.key || retired().get(r.key) !== ref) return null;
      const entries = S.collect(performance.now() + 300, 4000, 1000).list.map((el) => ({ el, d: S.describe(el) }));
      S.keys(entries);
      const twins = entries.filter((x) => x.key === r.key && !S.refOf(x.el));
      if (twins.length !== 1) return null;
      S.byNode.set(twins[0].el, ref);
      r.node = new WeakRef(twins[0].el);
      return twins[0].el;
    };
    return S;
  })()`;
}

// A challenge only a person can clear: a CAPTCHA widget or a bot-check page.
// A few URL, title and selector checks, no layout beyond the frames' boxes.
// Whole-page checks are read on the top document; widgets also in open shadow
// roots and same-origin frames, nested either way (a cross-origin frame's
// document and a closed root are not readable). Every widget on
// the page is collected, of every provider. A widget whose own response token
// is filled is solved and no longer counts; an invisible reCAPTCHA (the corner
// badge) is not one until it pops its image challenge. page marks a whole-page
// check, where every input lands on the challenge; blocking means the bot
// cannot go on without a person. parts are the widgets, for the input hit test.
const CHALLENGE_SOURCE = `() => {
  const shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 2 && r.height > 2 && (!el.checkVisibility || el.checkVisibility({ checkVisibilityCSS: true, opacityProperty: true })); };
  const whole = (kind) => ({ kind, blocking: true, page: true, parts: [] });
  const path = location.pathname, title = document.title.trim();
  if (path.indexOf('/sorry/') === 0 && (/(^|\\.)google\\.[a-z.]+$/.test(location.hostname) || document.querySelector('#captcha-form'))) return whole('google_sorry');
  // Its ids and titles are ordinary words on other pages too, so they need Cloudflare's own markers.
  if ((window._cf_chl_opt || document.querySelector('script[src*="/cdn-cgi/challenge-platform/"]'))
    && (document.querySelector('#challenge-form,#challenge-stage,#challenge-running,#cf-challenge-running,#cf-please-wait') || /^(just a moment|one more step|verify you are human)/i.test(title))) return whole('cloudflare');
  // ponytail: one querySelectorAll('*') per root; cap at 200 roots for pages built from thousands of components.
  const roots = [document];
  for (let i = 0; i < roots.length && roots.length < 200; i++) for (const el of roots[i].querySelectorAll('*')) {
    if (el.shadowRoot) roots.push(el.shadowRoot);
    else if (/^I?FRAME$/.test(el.tagName)) { let d = null; try { d = shown(el) && el.contentDocument; } catch {} if (d) roots.push(d); }
  }
  const all = (sel) => roots.flatMap((d) => [...d.querySelectorAll(sel)]);
  const frames = all('iframe').filter(shown);
  const src = (el) => String(el.src || '');
  // One element per widget, outermost first, in page order.
  const outer = (els) => els.filter((el, i) => els.indexOf(el) === i && !els.some((o) => o !== el && o.contains(el))).sort((x, y) => x.compareDocumentPosition(y) & 2 ? 1 : -1);
  // A widget's token is the response field beside it: under the nearest
  // ancestor holding any, the fields pair with the widgets there in page
  // order. Counts that do not match leave the widget unsolved.
  const field = (name) => 'textarea[name^="' + name + '"],input[name^="' + name + '"]';
  const open = (list, name) => { const els = outer(list); return els.filter((el) => {
    for (let p = el; p; p = p.parentNode) { const f = [...p.querySelectorAll(field(name))]; if (!f.length) continue; const w = els.filter((x) => p.contains(x)); return w.length !== f.length || !f[w.indexOf(el)].value; }
    return true;
  }); };
  // A popup challenge (appended to the body) stays until every field is filled.
  const pending = (name) => { const f = all(field(name)); return !f.length || f.some((el) => !el.value); };
  const parts = [];
  const add = (kind, blocking, els) => { if (els.length) parts.push({ kind, blocking, els }); };
  add('arkose', true, [...frames.filter((el) => /arkoselabs\\.com|funcaptcha\\.com/.test(src(el))), ...all('#FunCaptcha,#arkose-iframe,[data-e2e="enforcement-frame"]').filter(shown)]);
  const hc = frames.filter((el) => /hcaptcha\\.com/.test(src(el)) && !/frame=checkbox-invisible/.test(src(el)));
  const hcPop = pending('h-captcha-response') ? hc.filter((el) => /frame=challenge/.test(src(el))) : [];
  add('hcaptcha', hcPop.length > 0, [...open(hc.filter((el) => !/frame=challenge/.test(src(el))), 'h-captcha-response'), ...hcPop]);
  const rc = frames.filter((el) => /\\/recaptcha\\/(api2|enterprise)\\/(anchor|bframe)/.test(src(el)) && !/[?&]size=invisible/.test(src(el)));
  const rcPop = pending('g-recaptcha-response') ? rc.filter((el) => /\\/bframe/.test(src(el))) : [];
  add('recaptcha', rcPop.length > 0, [...open(rc.filter((el) => !/\\/bframe/.test(src(el))), 'g-recaptcha-response'), ...rcPop]);
  // Turnstile draws its frame in a closed shadow root; its response field sits beside it.
  add('turnstile', false, open([...frames.filter((el) => /challenges\\.cloudflare\\.com/.test(src(el))), ...[...all('.cf-turnstile'), ...all('input[name="cf-turnstile-response"]').map((el) => el.parentElement)].filter((el) => el && shown(el))], 'cf-turnstile-response'));
  if (!parts.length) return null;
  const lead = parts.find((p) => p.blocking) || parts[0];
  return { kind: lead.kind, blocking: lead.blocking, page: false, parts };
}`;
// The element keys go to: down through open shadow roots and same-origin
// frames. Focus inside a cross-origin frame stops at the frame.
const FOCUS_SOURCE = `() => {
  let a = document.activeElement;
  for (let i = 0; a && i < 50; i++) {
    let next = null;
    try { next = a.shadowRoot ? a.shadowRoot.activeElement : /^I?FRAME$/.test(a.tagName) && a.contentDocument ? a.contentDocument.activeElement : null; } catch {}
    if (!next || next === a || next === next.ownerDocument.body) break;
    a = next;
  }
  return a;
}`;
function challengeExpression() {
  return `(() => { const c = (${CHALLENGE_SOURCE})(); return c && { kind: c.kind, blocking: c.blocking }; })()`;
}
// Whether input at these viewport points (or, for keys, into the focused
// element, or on these elements however hidden) would land on a challenge: the widget's challenge when it would,
// else null. The input locate scripts run it in the same round trip.
const CHALLENGE_HIT_SOURCE = `(points, keyboard, els) => {
  const c = (${CHALLENGE_SOURCE})();
  if (!c) return null;
  if (c.page) return { kind: c.kind, blocking: c.blocking };
  // Up through shadow hosts and frame elements, so a node deep in a widget's
  // own same-origin document or shadow tree still belongs to it.
  const up = (n) => { if (n.nodeType === 11) return n.host; if (n.nodeType === 9) { try { return n.defaultView && n.defaultView.frameElement; } catch { return null; } } return n.parentNode; };
  const partOf = (el) => { for (let n = el; n; n = up(n)) { const p = c.parts.find((x) => x.els.includes(n)); if (p) return p; } return null; };
  const at = (x, y) => {
    let root = document, el = null;
    for (let i = 0; i < 50; i++) {
      const next = root.elementFromPoint(x, y);
      if (!next || next === el) break;
      el = next;
      if (el.shadowRoot) { root = el.shadowRoot; continue; }
      let d = null;
      try { d = /^I?FRAME$/.test(el.tagName) && el.contentDocument; } catch {}
      if (!d) break;
      const r = el.getBoundingClientRect(); x -= r.left + el.clientLeft; y -= r.top + el.clientTop; root = d;
    }
    return el;
  };
  const hits = points.filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y)).map((p) => at(p.x, p.y));
  if (keyboard) hits.push((${FOCUS_SOURCE})());
  if (els) hits.push(...els);
  const hit = hits.map(partOf).find(Boolean);
  return hit ? { kind: hit.kind, blocking: hit.blocking } : null;
}`;
function challengeHitExpression(points = [], keyboard = false) {
  return `(${CHALLENGE_HIT_SOURCE})(${JSON.stringify(points)}, ${keyboard === true})`;
}
// The watch on a tab handed over for a CAPTCHA reads the challenge, whether
// the page is loading, and a fingerprint of the focused field (in a frame or
// shadow root too) so a person still typing keeps the tab.
function challengeProbeExpression() {
  return `(() => {
    const c = (${CHALLENGE_SOURCE})();
    const a = (${FOCUS_SOURCE})(), editable = !!a && (a.isContentEditable || /^(INPUT|TEXTAREA)$/.test(a.tagName));
    let typing = '';
    if (editable) {
      const value = String(a.isContentEditable ? a.textContent : a.value);
      let h = 0x811c9dc5;
      for (let i = 0; i < value.length; i++) { h ^= value.charCodeAt(i); h = Math.imul(h, 0x01000193); }
      typing = value.length + ':' + (h >>> 0).toString(36);
    }
    return { challenge: c && { kind: c.kind, blocking: c.blocking }, loading: document.readyState === 'loading', typing };
  })()`;
}

function snapshotExpression(opts = {}) {
  const int = (value, min, max, fallback) => Number.isInteger(value) ? Math.max(min, Math.min(max, value)) : fallback;
  const maxChars = int(opts.maxChars, 0, 20000, 6000);
  const maxElements = int(opts.maxElements, 0, 300, 150);
  const maxScan = int(opts.maxScan, 1, 50000, 2000);
  const textMs = int(opts.textMs, 5, 2000, 60);
  // Controls matter more than prose: a heavy app page must still list its
  // buttons, so the scan gets a wider budget than the text walk.
  const elementMs = int(opts.elementMs, 5, 2000, 200);
  // Ref numbers continue from the tab's last one, so a ref from an earlier
  // document can never name a control in this one.
  const seed = int(opts.seed, 0, Number.MAX_SAFE_INTEGER, 0);
  const held = (Array.isArray(opts.held) ? opts.held : []).filter((ref) => typeof ref === 'string' && /^e\d+$/.test(ref)).slice(0, 400);
  const parseWaitMs = int(opts.parseWaitMs, 0, 5000, 400);
  const frameWaitMs = int(opts.frameWaitMs, 0, 5000, maxElements > 0 ? 1200 : 0);
  // effect reads also report which control holds focus and the value of the
  // element the action just touched (a ref token or a selector).
  const valueRef = opts.valueFor && typeof opts.valueFor.ref === 'string' ? opts.valueFor.ref : null;
  const valueSel = opts.valueFor && typeof opts.valueFor.selector === 'string' ? opts.valueFor.selector : null;
  return `(async () => {
    const wantEffect = ${opts.effect === true}, wantSettle = ${opts.effect === true && opts.settle === true}, valueRef = ${JSON.stringify(valueRef)}, valueSel = ${JSON.stringify(valueSel)};
    let focused = null, acted = null, settledMs;
    // The tracker's raw timers keep this read's own scheduling out of the
    // count: the settle lands inside the arm grace and must not track itself.
    const followUp = window[Symbol.for(${JSON.stringify(FOLLOW_UP_KEY)})];
    const setT = followUp && followUp.setT || setTimeout, clearT = followUp && followUp.clearT || clearTimeout;
    // The parser yields between chunks, so a snapshot can land mid-document;
    // give a still-parsing page a moment and report it if it is not done.
    if (document.readyState === 'loading') await new Promise(done => { document.addEventListener('DOMContentLoaded', done, { once: true }); setT(done, ${parseWaitMs}); });
    // A same-origin iframe is readable as an empty about:blank document until
    // its navigation commits, and the top document says nothing about it, so
    // the controls inside would be missing from a read that looks complete.
    // Wait for such frames, bounded; whatever is still pending is reported as loading.
    const framesPending = (doc, depth) => {
      for (const frame of doc.querySelectorAll('iframe')) {
        let inner = null;
        try { inner = frame.contentDocument; } catch {}
        if (!inner) continue;
        const src = frame.getAttribute('src') || '';
        const blank = !src || frame.hasAttribute('srcdoc') || /^(about|javascript):/i.test(src) || frame.loading === 'lazy';
        if (inner.readyState !== 'complete' || (!blank && inner.URL === 'about:blank')) return true;
        if (depth < 3 && framesPending(inner, depth + 1)) return true;
      }
      return false;
    };
    for (const end = performance.now() + ${frameWaitMs}; document.readyState !== 'loading' && performance.now() < end && framesPending(document, 0);) await new Promise(done => setT(done, 25));
    // Marks the document: a cross-document navigation swaps the window and
    // drops the marker, which is how a read tells it from a same-document one.
    // Kept under a symbol and non-enumerable so window scans do not see it.
    const docKey = Symbol.for(${JSON.stringify(FOLLOW_UP_DOC_KEY)});
    const sameDoc = window[docKey] === 1;
    if (${opts.mark !== false}) { try { Object.defineProperty(window, docKey, { value: 1, configurable: true }); } catch { try { window[docKey] = 1; } catch {} } }
    // An action's effect often lands a beat after it (XHR, setTimeout ~150ms
    // is common), so an action read first gives late reactions a moment to
    // land, then settles once the DOM has stayed quiet, bounded so a busy
    // page cannot hold the reply. The cursor overlay does not count.
    if (wantSettle && document.documentElement && document.readyState !== 'loading') {
      const settleStart = performance.now();
      // Dispatch is over by the time this read runs; a close probe lost to a
      // failed dispatch leaves the window open, so close it here with the
      // same grace. While the close is still waiting out delivery, though,
      // the input has not reached the page: sealing now would drop the work
      // that late input starts, so the delivery-bound seal closes it instead.
      const armed = followUp && followUp.cur;
      if (armed && armed.open) {
        armed.closing = true;
        if (typeof followUp.seal === 'function' && !armed.delivered) {
          if (!armed.sealT) armed.sealT = setT(() => followUp.seal(armed), ${FOLLOW_UP_DELIVERY_MS});
        } else {
          armed.open = false;
          if (!armed.until) armed.until = performance.now() + ${FOLLOW_UP_GRACE_MS};
        }
      }
      await new Promise((finish) => {
        const own = (node) => {
          const el = node && node.nodeType === 1 ? node : node && node.parentElement;
          return !!(el && typeof el.id === 'string' && el.id.indexOf('hermes-workspace-agent-cursor') === 0);
        };
        // Work the action itself started is counted by the page-side tracker
        // (see followUpArmExpression): an open arm window or a pending item
        // keeps the settle alive past the first quiet moment.
        const busy = () => {
          const c = followUp && followUp.cur;
          return !!c && performance.now() < c.expires && (c.open || performance.now() < c.until || c.pending > 0);
        };
        const sawWork = () => { const c = followUp && followUp.cur; return !!c && c.total > 0; };
        let quiet, cap, drain;
        const done = () => { mo.disconnect(); clearT(quiet); clearT(cap); clearInterval(drain); finish(); };
        const check = () => {
          if (!busy()) return done();
          if (drain) return;
          // Once the tracked work is done, a fresh quiet window still applies.
          drain = setInterval(() => {
            if (busy()) return;
            clearInterval(drain); drain = null;
            clearT(quiet); quiet = setT(check, ${EFFECT_QUIET_MS});
          }, 30);
        };
        const mo = new MutationObserver((list) => {
          for (const m of list) {
            if (own(m.target)) continue;
            if (m.type === 'childList' && [...m.addedNodes, ...m.removedNodes].every(own)) continue;
            clearT(quiet);
            quiet = setT(check, ${EFFECT_QUIET_MS});
            return;
          }
        });
        // Only work the action started stretches the bound; a page that stays
        // noisy on its own keeps the same budget it always had.
        cap = setT(() => {
          if (sawWork()) cap = setT(done, ${FOLLOW_UP_CAP_MS - EFFECT_SETTLE_MS});
          else done();
        }, ${EFFECT_SETTLE_MS});
        mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
        // With the tracker armed for this action, its timers and requests hold
        // the settle open themselves, so the first window only covers what the
        // tracker cannot see (a microtask or message-channel render).
        quiet = setT(check, armed && performance.now() < armed.expires ? ${EFFECT_TRACKED_WATCH_MS} : ${EFFECT_WATCH_MS});
      });
      settledMs = Math.round(performance.now() - settleStart);
    }
    const shortHref = ${SHORT_HREF};
    const items = [], R = ${maxElements > 0 ? refsSource(seed) : 'null'};
    let gone = [], more = false;
    if (R) {
      const found = R.collect(performance.now() + ${elementMs}, ${maxScan}, ${maxElements});
      more = found.more;
      const entries = found.list.map((el) => ({ el, d: R.describe(el) }));
      R.assign(entries, ${seed}, !found.more);
      const listed = new Set();
      for (const x of entries) {
        const { el, d } = x;
        listed.add(x.ref);
        // Defaults stay out of the reply: an empty name, the implied type of a
        // non-input, 'text', and the constant value of a checkbox or radio.
        const item = { ref: x.ref, role: d.role };
        if (d.name) item.name = d.name;
        if (x.row) item.row = x.row;
        if (d.type && el.tagName === 'INPUT' && d.type !== 'text') item.type = d.type;
        if (d.value && !/^(checkbox|radio)$/.test(d.type)) item.value = d.value;
        if (d.href) item.href = d.href;
        if (el.disabled) item.disabled = true;
        items.push(item);
        if (wantEffect && !focused && el.getRootNode && el.getRootNode().activeElement === el) focused = { ref: x.ref, name: d.name };
        if (wantEffect && !acted && (valueRef !== null || valueSel !== null)) {
          let hit = valueRef !== null && x.ref === valueRef;
          if (!hit && valueSel !== null) { try { hit = el.matches(valueSel); } catch {} }
          if (hit) {
            const kind = (el.type || '').toLowerCase();
            if (/^(checkbox|radio)$/.test(kind)) acted = el.checked ? 'checked' : 'unchecked';
            else if (el.isContentEditable) acted = (el.innerText || '').trim().slice(0, 1000);
            else if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) acted = String(el.value == null ? '' : el.value).slice(0, 1000);
          }
        }
      }
      // Refs the caller held that are no longer on the page or no longer
      // shown, so a reply can drop them even when the scan was cut short.
      gone = ${JSON.stringify(held)}.filter((ref) => {
        if (listed.has(ref)) return false;
        const node = R.live(ref);
        return !node || (node.checkVisibility ? !node.checkVisibility({ checkVisibilityCSS: true }) : false) || !node.getClientRects().length;
      });
    }
    const overlays = R ? R.overlays() : [];
    // Focus can sit on an element the controls pick skipped (a tabindex div,
    // a link under the scan cap). Report it anyway, with its ref if it has one.
    if (wantEffect && !focused) {
      let active = document.activeElement;
      while (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement;
      if (active && active !== document.body && active !== document.documentElement) {
        const ref = R ? R.refOf(active) : '';
        let name = (typeof active.getAttribute === 'function' ? (active.getAttribute('aria-label') || active.title || '') : '').trim();
        if (!name) name = (active.innerText || '').trim();
        focused = { ref, name: name.slice(0, 200) };
      }
    }
    // body.innerText pays a full-document render pass regardless of the slice;
    // a bounded walker stops at the char cap or the time budget instead. The
    // walk keeps going past the cap to hash every visible text node, so a
    // change beyond the window still shows up in textSig.
    let text = '', textCut = false, textSig = '';
    if (${maxChars} > 0 && document.body) {
      const textDeadline = performance.now() + ${textMs};
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      // Password managers and other extensions inject their own UI into the
      // page; none of it is page content. Noise signals, cheapest first: the
      // node (or an ancestor) came from another document or is a frame into
      // an extension page, it carries a known extension data attribute
      // (1Password, LastPass, Bitwarden, Dashlane, Keeper, NordPass, Proton
      // Pass, Grammarly), or it is a custom element whose shadow root the page
      // registry never defined. All of these are structural: a phrase like
      // "press down arrow to select" is real page text on comboboxes.
      const extAttr = /^data-(?:1p|1password|lastpass|bitwarden|bw|dashlane|keeper|nordpass|protonpass|proton|grammarly|gramm)[-_]/i;
      const extFrame = /^(?:chrome|moz|safari-web)-extension:/i;
      const extCache = new WeakMap();
      const extNoise = (el) => {
        if (!el || el.nodeType !== 1) return false;
        let hit = extCache.get(el);
        if (hit !== undefined) return hit;
        hit = el.ownerDocument !== document || extFrame.test(el.getAttribute('src') || el.getAttribute('href') || '');
        const attrs = el.attributes;
        for (let i = 0; !hit && attrs && i < attrs.length; i++) hit = extAttr.test(attrs[i].name);
        if (!hit && el.localName.indexOf('-') >= 0 && el.shadowRoot && !customElements.get(el.localName)) hit = true;
        if (!hit) hit = extNoise(el.parentElement);
        extCache.set(el, hit);
        return hit;
      };
      // Tag names stand in for computed display so lists, rows and headings
      // keep their line breaks without a style read per text node.
      const blockTag = /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|BODY|CAPTION|DD|DETAILS|DIALOG|DIV|DL|DT|FIELDSET|FIGCAPTION|FIGURE|FOOTER|FORM|H[1-6]|HEADER|HR|LEGEND|LI|MAIN|NAV|OL|P|PRE|SECTION|SUMMARY|TABLE|TR|UL)$/;
      let node, lastBlock = null, seenParent = null, parentVisible = true, parentBlock = null;
      let sigHash = 0x811c9dc5, sigNodes = 0;
      while ((node = walker.nextNode()) && sigNodes < 30000) {
        const p = node.parentElement;
        if (!p || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(p.tagName)) continue;
        // Sibling text nodes share a parent. One style check covers the run.
        if (p !== seenParent) {
          seenParent = p;
          parentVisible = !(p.checkVisibility && !p.checkVisibility({ checkVisibilityCSS: true })) && !extNoise(p);
          let block = p;
          while (block.parentElement && !blockTag.test(block.tagName)) block = block.parentElement;
          parentBlock = block;
        }
        if (!parentVisible) continue;
        const chunk = node.nodeValue.replace(/\\s+/g, ' ').trim();
        if (!chunk) continue;
        for (let i = 0; i < chunk.length; i++) { sigHash ^= chunk.charCodeAt(i); sigHash = Math.imul(sigHash, 0x01000193); }
        sigHash ^= 0x9d; sigHash = Math.imul(sigHash, 0x01000193);
        sigNodes++;
        if (!textCut) {
          text += (text ? (parentBlock === lastBlock ? ' ' : '\\n') : '') + chunk;
          lastBlock = parentBlock;
          // The time budget never cuts the first screenful: a slow renderer
          // must still return enough text for the agent to orient itself.
          if (text.length >= ${maxChars} || (text.length >= ${Math.min(1000, maxChars)} && performance.now() > textDeadline)) textCut = true;
        }
      }
      text = text.slice(0, ${maxChars});
      textSig = sigNodes + ':' + (sigHash >>> 0).toString(36);
    } else textCut = ${maxChars} <= 0 && !!document.body?.textContent?.trim();
    const challenge = ${challengeExpression()};
    return {title:document.title,url:location.href,sameDoc,challenge,loading:document.readyState === 'loading' || framesPending(document, 0),text,textSig,elements:items,seq:R ? R.n : 0,gone,overlays,truncated:{text:textCut,elements:more},viewport:{width:innerWidth,height:innerHeight,deviceScaleFactor:devicePixelRatio},iframes:[...document.querySelectorAll('iframe')].map(el=>({title:(el.title||'').slice(0,80),src:shortHref(typeof el.src==='string'?el.src:'')})).filter(frame=>frame.src).slice(0,8),focused,acted,settledMs};
  })()`;
}

// webContents and frame execution hand back the same object with its keys in
// a different order, so the order must not matter. Refs are part of it: a
// control that came back under a new ref is a change the caller must hear about.
const itemFingerprint = (item) => JSON.stringify(item, Object.keys(item).sort());
function elementFingerprint(elements) {
  return JSON.stringify((elements || []).map(itemFingerprint));
}
function elementsHash(elements) {
  return crypto.createHash('sha1').update(elementFingerprint(elements)).digest('hex');
}
function snapshotHash(data) {
  const hash = crypto.createHash('sha1');
  for (const part of [data.url, data.title, data.text]) hash.update(part || '').update('\0');
  return hash.update(elementFingerprint(data.elements)).digest('hex');
}
const EFFECT_MAX_LINES = 400;
const EFFECT_TEXT_CHARS = 600;
// An action's DOM settles when nothing mutates for this long; the cap keeps a
// busy page from holding the reply.
const EFFECT_QUIET_MS = 60;
const EFFECT_SETTLE_MS = 400;
// The first window stays open long enough to catch a reaction scheduled a
// beat after the action; once anything mutates, the shorter quiet window is
// all a settled page pays.
const EFFECT_WATCH_MS = 250;
const EFFECT_TRACKED_WATCH_MS = 100;
// Consequence tracking: followUpInstallExpression wraps the page's setTimeout,
// fetch and XMLHttpRequest.send once — planted on agent tabs at document start
// (so a bundled page that bound the originals at module init still routes
// through the tracker) and lazily re-run by followUpArmExpression on pages that
// predate the install. followUpArmExpression then opens a counting window
// around each action's dispatch, so the effect settle can wait out work the
// action itself started (a short timer, a request) instead of answering
// mid-update. Unarmed the wrappers are pure pass-through.
// State and document markers live under registered symbols and non-enumerable
// properties: enumerable, plainly-named window keys are how bot detectors spot
// injected globals.
const FOLLOW_UP_KEY = 'hw.followUp';
const FOLLOW_UP_DOC_KEY = 'hw.doc';
// The window covers the dispatch plus a beat after: a handler can schedule
// its follow-up a tick later than the input ack.
const FOLLOW_UP_GRACE_MS = 50;
// Timers this far out are background work, not consequences of the click.
const FOLLOW_UP_TIMER_MS = 1000;
// An arm left open by a failed dispatch self-expires so it cannot pin a
// later read.
const FOLLOW_UP_ARM_EXPIRY_MS = 15000;
// A close waits this long for the page to confirm the input arrived; a
// dispatch lost on the way still seals on this bound.
const FOLLOW_UP_DELIVERY_MS = 300;
// The settle bound stretches to this only while tracked work is in flight.
const FOLLOW_UP_CAP_MS = 1500;
function followUpInstallExpression() {
  return `(() => {
    const w = window, key = Symbol.for(${JSON.stringify(FOLLOW_UP_KEY)});
    let S = w[key];
    if (!S) {
      S = { cur: null, inside: 0, timers: new Map(), installed: false };
      try { Object.defineProperty(w, key, { value: S, configurable: true }); } catch { try { w[key] = S; } catch {} }
    }
    if (S.installed) return true;
    const armed = () => { const c = S.cur; return S.inside > 0 || !!c && performance.now() < c.expires && (c.open || performance.now() < c.until); };
    const setT = w.setTimeout, clearT = w.clearTimeout, fetch0 = w.fetch;
    const send0 = w.XMLHttpRequest && w.XMLHttpRequest.prototype && w.XMLHttpRequest.prototype.send;
    // Our own in-page timers (the settle's quiet windows, the cursor tween)
    // schedule through the originals, or they would count against the arm.
    S.setT = setT; S.clearT = clearT;
    try {
      // The wrappers must be indistinguishable from the natives they replace:
      // same name and arity, and a toString that answers the original's
      // "[native code]" source through a patched Function.prototype.toString
      // that reports native itself. Method shorthand matters here: plain
      // functions carry a prototype own property and arguments/caller
      // throwers, while natives expose only name and length.
      const toString0 = Function.prototype.toString;
      const sources = new Map();
      const disguise = (fn, original) => {
        try { Object.defineProperty(fn, 'name', { value: original.name, configurable: true }); } catch {}
        try { Object.defineProperty(fn, 'length', { value: original.length, configurable: true }); } catch {}
        try { delete fn.arguments; delete fn.caller; delete fn.prototype; } catch {}
        sources.set(fn, toString0.call(original));
        return fn;
      };
      const wrapped = {
        toString() { const s = sources.get(this); return s === undefined ? toString0.call(this) : s; },
        setTimeout(callback, delay, ...rest) {
          const c = S.cur, ms = typeof delay === 'number' ? delay : 0;
          if (!c || !armed() || ms > ${FOLLOW_UP_TIMER_MS}) return setT.call(this, callback, delay, ...rest);
          c.pending++; c.total++;
          let id = 0;
          const run = function (...args) {
            if (S.timers.delete(id)) c.pending--;
            S.inside++;
            try {
              return typeof callback === 'function' ? callback.apply(this, args) : (0, eval)(String(callback));
            } finally { S.inside--; }
          };
          try { id = setT.call(this, run, delay, ...rest); }
          catch (e) { c.pending--; c.total--; throw e; }
          S.timers.set(id, c);
          return id;
        },
        clearTimeout(id) {
          const owner = S.timers.get(id);
          if (owner) { S.timers.delete(id); owner.pending--; }
          return clearT.call(this, id);
        },
        fetch(...args) {
          const c = S.cur;
          if (!c || !armed()) return fetch0.apply(this, args);
          c.pending++; c.total++;
          let sent;
          try { sent = fetch0.apply(this, args); }
          catch (e) { c.pending--; c.total--; throw e; }
          // The returned promise re-rejects rather than lending the page's
          // own promise a handler, so an unhandled rejection reports exactly
          // as it would have without the tracker.
          return new Promise((resolve, reject) => Promise.resolve(sent).then(
            (value) => { c.pending--; resolve(value); },
            (error) => { c.pending--; reject(error); }));
        },
        send(...args) {
          const c = S.cur;
          if (!c || !armed()) return send0.apply(this, args);
          c.pending++; c.total++;
          const drop = () => { c.pending--; };
          try {
            this.addEventListener('loadend', drop, { once: true });
            return send0.apply(this, args);
          } catch (e) {
            this.removeEventListener('loadend', drop);
            c.pending--; c.total--;
            throw e;
          }
        },
      };
      sources.set(wrapped.toString, toString0.call(toString0));
      try { delete wrapped.toString.arguments; delete wrapped.toString.caller; } catch {}
      try { Function.prototype.toString = wrapped.toString; } catch {}
      w.setTimeout = disguise(wrapped.setTimeout, setT);
      w.clearTimeout = disguise(wrapped.clearTimeout, clearT);
      if (fetch0) w.fetch = disguise(wrapped.fetch, fetch0);
      if (send0) w.XMLHttpRequest.prototype.send = disguise(wrapped.send, send0);
    } catch { /* a sealed page gets no tracking and the old timing */ }
    // The events the dispatched input produces are how the page confirms it
    // arrived. While an arm is closing, each observed event holds the window
    // open so that event's own handlers still count, and the seal lands one
    // macrotask after the burst ends; a dispatch lost on the way seals on
    // the delivery bound the close scheduled.
    S.seal = (c) => {
      if (S.cur === c && c.open) { c.open = false; c.until = performance.now() + ${FOLLOW_UP_GRACE_MS}; }
    };
    const seen = () => {
      const c = S.cur;
      if (!c || performance.now() >= c.expires) return;
      c.delivered = true;
      if (!c.closing) return;
      clearT(c.sealT);
      c.open = true; c.until = 0;
      c.sealT = setT(() => S.seal(c), 0);
    };
    for (const type of ['mousedown', 'mouseup', 'mousemove', 'click', 'dblclick', 'contextmenu', 'wheel', 'keydown', 'keypress', 'keyup', 'input', 'change', 'pointerdown', 'pointerup', 'pointermove', 'touchstart', 'touchend'])
      w.addEventListener(type, seen, true);
    S.installed = true;
    return true;
  })()`;
}
function followUpArmExpression() {
  return `(() => {
    const installed = ${followUpInstallExpression()};
    const S = window[Symbol.for(${JSON.stringify(FOLLOW_UP_KEY)})];
    if (!installed || !S) return false;
    S.cur = { open: true, until: 0, expires: performance.now() + ${FOLLOW_UP_ARM_EXPIRY_MS}, pending: 0, total: 0, delivered: false, closing: false, sealT: 0 };
    return true;
  })()`;
}
function followUpCloseExpression() {
  return `(() => {
    const s = window[Symbol.for(${JSON.stringify(FOLLOW_UP_KEY)})], c = s && s.cur;
    if (!c) return true;
    // The input may still sit in the renderer's queue on a slow machine: the
    // window seals a macrotask after the page's last observed event, or on
    // the delivery bound if nothing ever arrived. Trackers predating the
    // delivery check keep the old fixed grace.
    c.closing = true;
    if (typeof s.seal !== 'function') { c.open = false; c.until = performance.now() + ${FOLLOW_UP_GRACE_MS}; return true; }
    const setT = s.setT || setTimeout, clearT = s.clearT || clearTimeout;
    clearT(c.sealT);
    c.sealT = setT(() => s.seal(c), c.delivered ? 0 : ${FOLLOW_UP_DELIVERY_MS});
    return true;
  })()`;
}
function linesOf(text) {
  return String(text || '').split('\n').filter(Boolean).slice(0, EFFECT_MAX_LINES);
}
// The coverage of a read is how much of the page's text it scanned: null when
// it saw the whole document, otherwise the characters it reached. Diffing a
// fresh read against a narrower one must stay inside that window or text the
// prior read never saw is reported as new.
function lastReadOf(data) {
  return { url: data.url, lines: linesOf(data.text), coverage: data.truncated?.text ? data.text.length : null, sig: data.textSig || '' };
}
// Every element read records what it saw, per ref, so the next action reply
// can say what changed instead of resending the list. tab.refs holds every
// ref issued in the tab; the page's store decides whether one still resolves.
function noteScan(tab, data, generation) {
  tab.scan = { generation, url: data.url, byRef: new Map(data.elements.map((item) => [item.ref, itemFingerprint(item)])) };
  if (Number.isInteger(data.seq)) tab.refSeed = Math.max(tab.refSeed || 0, data.seq);
  if (tab.refs.size > 5000) tab.refs.clear();
  for (const item of [...data.elements, ...(data.overlays || []).map((o) => ({ ref: o.close }))]) if (item.ref) tab.refs.add(item.ref);
}
function settleSnapshot(tab, data, generation, since) {
  const hash = snapshotHash(data), previous = tab.snapshotStamp;
  const unchanged = !!previous && since !== undefined && previous.generation === since && previous.hash === hash;
  tab.snapshotStamp = { generation, hash, url: data.url, elementsHash: elementsHash(data.elements) };
  tab.lastRead = lastReadOf(data);
  tab.docMarked = true;
  noteScan(tab, data, generation);
  // sameDoc, textSig, seq and gone feed the host's bookkeeping, not the reply.
  // A challenge rides even on an unchanged read: its frames sit outside the text.
  const { sameDoc, textSig, seq, gone, overlays, challenge, ...page } = data;
  const flagged = challenge ? { challenge } : {};
  return unchanged ? { unchanged: true, generation, ...flagged } : { ...page, ...(overlays && overlays.length ? { overlays } : {}), ...flagged, generation };
}
// A full list in an action reply stops here; unlisted says how many more a snapshot shows.
const EFFECT_ELEMENTS = 40;
// Past this share of the list, a delta costs about as much as the list.
const DELTA_SHARE = 0.6;
// What changed in the controls since the scan the caller holds: new or updated
// elements, and refs that left the page. A scan cut short by its cap only
// drops refs the page reports gone, not ones it merely did not reach.
function controlsDelta(scan, data) {
  const now = new Set(data.elements.map((item) => item.ref));
  const gone = new Set(data.gone || []), capped = !!data.truncated?.elements;
  return {
    changed: data.elements.filter((item) => scan.byRef.get(item.ref) !== itemFingerprint(item)),
    removed: [...scan.byRef.keys()].filter((ref) => !now.has(ref) && (!capped || gone.has(ref))),
  };
}
// After an action, describe what it did to the page. The effect carries the
// new visible text lines since the model's last read (bounded, capped at 600
// chars) so a click answers with the state it produced. Controls are sent only
// when they changed: as changed[] and removed[] when the caller passed the
// generation it holds (held) and the page did not navigate, otherwise as the
// list. An unchanged page keeps the generation, so a later since= still dedupes.
// A Cloudflare "Just a moment" page usually clears by itself in a few seconds
// in a real browser. The reply waits that out, so neither the bot nor the
// person hears about a check nobody had to solve.
const CLOUDFLARE_WAIT_MS = 8000;
async function passCloudflare(execute, ms = CLOUDFLARE_WAIT_MS, step = 500) {
  for (const end = Date.now() + ms; Date.now() < end;) {
    await new Promise((r) => setTimeout(r, step));
    // A read that lands mid-navigation fails or hangs; that is the page moving on.
    const c = await Promise.race([Promise.resolve().then(() => execute(challengeExpression())).catch(() => undefined), new Promise((r) => setTimeout(r, 1500))]);
    if (c === null) return true;
  }
  return false;
}
async function readEffect(execute, tab, opts = {}) {
  const reply = await readEffectOnce(execute, tab, opts);
  if (reply?.challenge?.kind !== 'cloudflare' || !(await passCloudflare(execute, opts.cloudflareWaitMs))) return reply;
  return (await readEffectOnce(execute, tab, { ...opts, navigated: opts.navigated === true || undefined, settle: false })) || reply;
}
async function readEffectOnce(execute, tab, { parseWaitMs, navigated, target, settle, held } = {}) {
  const previous = tab.snapshotStamp, scan = tab.scan;
  const generation = Math.max(previous && Number.isInteger(previous.generation) ? previous.generation : 0, Number.isInteger(tab.generation) ? tab.generation : 0) + 1;
  let timer;
  const result = await Promise.race([
    Promise.resolve(execute(snapshotExpression({ maxChars: 8000, maxElements: 150, parseWaitMs, seed: tab.refSeed, held: scan ? [...scan.byRef.keys()] : [], effect: true, settle, valueFor: target }))),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('controls')), 8000 + (parseWaitMs || 0)); }),
  ]).finally(() => clearTimeout(timer));
  if (!result || !Array.isArray(result.elements)) return null;
  // The marker planted by the previous read is gone: a cross-document
  // navigation committed in between, so the old document's lines do not mask
  // the new one's.
  const freshDoc = result.sameDoc === false && tab.docMarked === true;
  const priorRead = freshDoc ? null : (tab.lastRead || null);
  const priorLines = new Set(priorRead ? priorRead.lines : []);
  const coverage = priorRead && Number.isFinite(priorRead.coverage) ? priorRead.coverage : Number.MAX_SAFE_INTEGER;
  const freshLines = linesOf(result.text);
  const freshSet = new Set(freshLines);
  const added = [];
  let at = 0;
  for (const line of freshLines) {
    const start = at;
    at += line.length + 1;
    // A line reaching past the previous read's coverage was cut in half there;
    // it is not new.
    if (start + line.length > coverage) break;
    if (!priorLines.has(line) && !added.includes(line)) added.push(line);
  }
  const removed = !result.truncated?.text && priorRead !== null && priorRead.lines.some((line) => !freshSet.has(line));
  const controlsSame = !!previous && previous.url === result.url && elementsHash(result.elements) === previous.elementsHash;
  // navigated is certain when the caller watched the navigation events; when
  // it is unknown, the missing document marker is the evidence.
  const nav = navigated === true || (navigated !== false && freshDoc);
  // The whole-page signature catches what the bounded diff cannot: added or
  // removed text beyond the walk's coverage.
  const deepChange = !!priorRead && !!priorRead.sig && !!result.textSig && priorRead.sig !== result.textSig;
  const changed = !controlsSame || nav || added.length > 0 || removed || deepChange;
  tab.docMarked = true;
  tab.lastRead = lastReadOf(result);
  const effect = { navigated: nav, url: result.url, title: result.title, changed, text: added.join('\n').slice(0, EFFECT_TEXT_CHARS) };
  if (typeof result.settledMs === 'number') effect.settledMs = result.settledMs;
  if (result.acted !== undefined && result.acted !== null) effect.value = result.acted;
  if (result.focused) {
    effect.focused = {};
    if (result.focused.ref) effect.focused.ref = result.focused.ref;
    if (result.focused.name) effect.focused.name = result.focused.name;
  }
  // A dialog or banner over the page rides on every reply while it is there.
  // So does a challenge (a CAPTCHA or a bot check) the page shows.
  const overlays = { ...(result.overlays && result.overlays.length ? { overlays: result.overlays } : {}), ...(result.challenge ? { challenge: result.challenge } : {}) };
  if (Number.isInteger(result.seq)) tab.refSeed = Math.max(tab.refSeed || 0, result.seq);
  if (controlsSame) return { generation: previous.generation, effect, ...overlays };
  tab.generation = generation;
  const settled = settleSnapshot(tab, result, generation);
  if (!nav && scan && held === scan.generation) {
    const delta = controlsDelta(scan, result);
    if (delta.changed.length + delta.removed.length <= Math.max(8, result.elements.length * DELTA_SHARE)) return { ...delta, generation, effect, ...overlays };
  }
  const reply = { elements: settled.elements.slice(0, EFFECT_ELEMENTS), generation: settled.generation, effect, ...overlays };
  if (settled.elements.length > EFFECT_ELEMENTS) reply.unlisted = settled.elements.length - EFFECT_ELEMENTS;
  return reply;
}

function checkpointExpression(includeDrafts) {
  return `(() => {
    const drafts = []; let size = 0;
    if (${includeDrafts === true}) for (const el of document.querySelectorAll('input,textarea,[contenteditable="true"]')) {
      if (el.disabled || el.readOnly || (!el.isContentEditable && el.tagName !== 'TEXTAREA' && !/^(text|search|email|url|tel)$/.test(el.type))) continue;
      const hint = [el.name,el.id,el.autocomplete,el.getAttribute('aria-label')].join(' ');
      if (/password|passwd|secret|token|otp|one.time|credit|card|cc-|cvc|cvv/i.test(hint)) continue;
      let selector;
      if (el.id) selector = '#' + CSS.escape(el.id);
      else if (el.name) selector = el.tagName.toLowerCase() + '[name="' + CSS.escape(el.name) + '"]';
      if (!selector || document.querySelectorAll(selector).length !== 1) continue;
      const value = el.isContentEditable ? el.innerText : el.value;
      if (!value || value.length > 10000 || size + value.length > 20000) continue;
      drafts.push({selector,tag:el.tagName,type:el.type || '',editable:el.isContentEditable,value}); size += value.length;
      if (drafts.length >= 30) break;
    }
    return {url:location.href,title:document.title,scroll:{x:scrollX,y:scrollY},drafts};
  })()`;
}

function restoreExpression(checkpoint) {
  return `(() => {
    const c = ${JSON.stringify(checkpoint)};
    if (location.href !== c.url) return {verification:'review_required',reason:'The destination redirected. Check its login and page before continuing.',restored:0,skipped:c.drafts.length};
    let restored = 0;
    for (const d of c.drafts) {
      const matches = document.querySelectorAll(d.selector), el = matches[0];
      if (matches.length !== 1 || !el || el.tagName !== d.tag || (el.type || '') !== d.type || el.isContentEditable !== d.editable || el.disabled || el.readOnly) continue;
      if (el.isContentEditable) el.textContent = d.value;
      else Object.getOwnPropertyDescriptor(el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,'value').set.call(el,d.value);
      el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true}));
      if ((el.isContentEditable ? el.innerText : el.value) === d.value) restored++;
    }
    scrollTo(c.scroll.x,c.scroll.y);
    return {verification:restored === c.drafts.length ? 'ready' : 'review_required',restored,skipped:c.drafts.length-restored};
  })()`;
}
module.exports = { refsSource, REFS_KEY, CHALLENGE_HIT_SOURCE, passCloudflare, challengeExpression, challengeHitExpression, challengeProbeExpression, snapshotExpression, settleSnapshot, readEffect, controlsDelta, checkpointExpression, restoreExpression, followUpArmExpression, followUpCloseExpression, followUpInstallExpression, lastReadOf, FOLLOW_UP_KEY };
