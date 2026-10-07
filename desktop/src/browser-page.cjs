const crypto = require('node:crypto');

function snapshotExpression(generation, opts = {}) {
  const int = (value, min, max, fallback) => Number.isInteger(value) ? Math.max(min, Math.min(max, value)) : fallback;
  const maxChars = int(opts.maxChars, 0, 20000, 6000);
  const maxElements = int(opts.maxElements, 0, 300, 150);
  const maxScan = int(opts.maxScan, 1, 50000, 2000);
  const textMs = int(opts.textMs, 5, 2000, 60);
  // Controls matter more than prose: a heavy app page must still list its
  // buttons, so the scan gets a wider budget than the text walk.
  const elementMs = int(opts.elementMs, 5, 2000, 200);
  const keep = int(opts.keep, 0, Number.MAX_SAFE_INTEGER, -1);
  const restamp = int(opts.restamp, 0, Number.MAX_SAFE_INTEGER, -1);
  const parseWaitMs = int(opts.parseWaitMs, 0, 5000, 400);
  // effect reads also report which control holds focus and the value of the
  // element the action just touched (a ref token or a selector).
  const valueRef = opts.valueFor && typeof opts.valueFor.ref === 'string' ? opts.valueFor.ref : null;
  const valueSel = opts.valueFor && typeof opts.valueFor.selector === 'string' ? opts.valueFor.selector : null;
  return `(async () => {
    const wantEffect = ${opts.effect === true}, wantSettle = ${opts.effect === true && opts.settle === true}, valueRef = ${JSON.stringify(valueRef)}, valueSel = ${JSON.stringify(valueSel)};
    let focused = null, acted = null;
    // The parser yields between chunks, so a snapshot can land mid-document;
    // give a still-parsing page a moment and report it if it is not done.
    if (document.readyState === 'loading') await new Promise(done => { document.addEventListener('DOMContentLoaded', done, { once: true }); setTimeout(done, ${parseWaitMs}); });
    // Marks the document: a cross-document navigation swaps the window and
    // drops the marker, which is how a read tells it from a same-document one.
    const sameDoc = window.__hermesWorkspaceDoc === 1;
    try { window.__hermesWorkspaceDoc = 1; } catch {}
    // An action's effect often lands a beat after it (XHR, setTimeout ~150ms
    // is common), so an action read first gives late reactions a moment to
    // land, then settles once the DOM has stayed quiet, bounded so a busy
    // page cannot hold the reply. The cursor overlay does not count.
    if (wantSettle && document.documentElement && document.readyState !== 'loading') {
      await new Promise((finish) => {
        const own = (node) => {
          const el = node && node.nodeType === 1 ? node : node && node.parentElement;
          return !!(el && typeof el.id === 'string' && el.id.indexOf('hermes-workspace-agent-cursor') === 0);
        };
        let quiet;
        const done = () => { mo.disconnect(); clearTimeout(quiet); clearTimeout(cap); finish(); };
        const mo = new MutationObserver((list) => {
          for (const m of list) {
            if (own(m.target)) continue;
            if (m.type === 'childList' && [...m.addedNodes, ...m.removedNodes].every(own)) continue;
            clearTimeout(quiet);
            quiet = setTimeout(done, ${EFFECT_QUIET_MS});
            return;
          }
        });
        const cap = setTimeout(done, ${EFFECT_SETTLE_MS});
        mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
        quiet = setTimeout(done, ${EFFECT_WATCH_MS});
      });
    }
    const shortHref = (raw) => {
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
    };
    const items = [];
    const deadline = performance.now() + ${elementMs};
    const pick = 'a[href],button,summary,input:not([type="hidden"]),textarea,select,[onclick],[role="button"],[role="link"],[role="tab"],[role="checkbox"],[role="radio"],[role="switch"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="option"],[role="treeitem"],[role="slider"],[contenteditable="true"]';
    // Open shadow roots only. A closed root reads null here, which keeps the
    // agent cursor (and anything else the page sealed) out of the snapshot.
    const queue = [document];
    const seenRoot = new Set();
    const candidates = [];
    let more = false;
    while (queue.length && seenRoot.size < 40 && performance.now() <= deadline) {
      const root = queue.shift();
      if (seenRoot.has(root)) continue;
      seenRoot.add(root);
      let list = [];
      try { list = root.querySelectorAll(pick); } catch {}
      for (const el of list) candidates.push(el);
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
      if (scanned >= ${maxScan} || items.length >= ${maxElements} || performance.now() > deadline) break;
      scanned++;
      // checkVisibility rejects display:none/visibility:hidden without forcing
      // layout; only survivors pay for the rect that catches zero-area boxes.
      if (el.checkVisibility ? !el.checkVisibility({ checkVisibilityCSS: true })
        : (s => s.visibility === 'hidden' || s.display === 'none')(getComputedStyle(el))) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const ref = 's${generation}-' + (items.length + 1);
      const kept = (el.getAttribute('data-hermes-workspace-ref') || '').split(' ').filter(token => token.startsWith('s${keep}-'));
      // Held refs stay usable if the page re-rendered an identical tree: the
      // caller drops them from its valid set unless the read comes back unchanged.
      const tokens = new Set([...kept, ref]);
      if (${restamp} >= 0) tokens.add('s${restamp}-' + (items.length + 1));
      el.setAttribute('data-hermes-workspace-ref', [...tokens].join(' '));
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
      if (el.tagName === 'SELECT' && el.selectedIndex >= 0) {
        const picked = (el.options[el.selectedIndex].label || el.options[el.selectedIndex].text || '').trim();
        if (picked && picked !== name) name = (name ? name + ' ' : '') + picked;
      }
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
      name = name.trim().slice(0, 200);
      const role = el.getAttribute('role') || el.tagName.toLowerCase();
      const type = el.type || '';
      const value = type === 'password' ? '[password]' : String(el.value || '').slice(0, 200);
      const rawHref = typeof el.href === 'string' ? el.href : (el.getAttribute('href') || '');
      const href = shortHref(rawHref);
      // Defaults stay out of the reply: an empty name, the implied type of a
      // non-input, 'text', and the constant value of a checkbox or radio.
      const item = { ref, role };
      if (name) item.name = name;
      if (type && el.tagName === 'INPUT' && type !== 'text') item.type = type;
      if (value && !/^(checkbox|radio)$/.test(type)) item.value = value;
      if (href) item.href = href;
      if (el.disabled) item.disabled = true;
      items.push(item);
      if (wantEffect && !focused && el.getRootNode && el.getRootNode().activeElement === el) focused = { ref, kept: kept[0] || '', name };
      if (wantEffect && !acted && (valueRef !== null || valueSel !== null)) {
        let hit = false;
        if (valueRef !== null && tokens.has(valueRef)) hit = true;
        else if (valueSel !== null) { try { hit = el.matches(valueSel); } catch {} }
        if (hit) {
          const kind = (el.type || '').toLowerCase();
          if (/^(checkbox|radio)$/.test(kind)) acted = el.checked ? 'checked' : 'unchecked';
          else if (el.isContentEditable) acted = (el.innerText || '').trim().slice(0, 1000);
          else if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) acted = String(el.value == null ? '' : el.value).slice(0, 1000);
        }
      }
    }
    // Focus can sit on an element the controls pick skipped (a tabindex div,
    // a link under the scan cap). Report it anyway; only a still-valid ref
    // token travels with it.
    if (wantEffect && !focused) {
      let active = document.activeElement;
      while (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement;
      if (active && active !== document.body && active !== document.documentElement) {
        const tokens = (typeof active.getAttribute === 'function' ? active.getAttribute('data-hermes-workspace-ref') || '' : '').split(' ');
        const keptRef = tokens.find((token) => token.startsWith('s${keep}-')) || '';
        let name = (typeof active.getAttribute === 'function' ? (active.getAttribute('aria-label') || active.title || '') : '').trim();
        if (!name) name = (active.innerText || '').trim();
        focused = { ref: '', kept: keptRef, name: name.slice(0, 200) };
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
      // page; none of it is page content. Skip a subtree when an element (or
      // an ancestor) carries a known extension data attribute, came from
      // another document, or is an aria-live region announcing a known
      // extension message, and drop the known announcement text outright.
      const extAttr = /^data-(?:1p|lastpass|bitwarden|dashlane)[-_]/i;
      const extPhrase = /1Password menu is available|Press down arrow to select/i;
      const extCache = new WeakMap();
      const extNoise = (el) => {
        if (!el || el.nodeType !== 1) return false;
        let hit = extCache.get(el);
        if (hit !== undefined) return hit;
        hit = el.ownerDocument !== document;
        const attrs = el.attributes;
        for (let i = 0; !hit && attrs && i < attrs.length; i++) hit = extAttr.test(attrs[i].name);
        if (!hit && el.hasAttribute('aria-live')) hit = extPhrase.test(el.textContent || '');
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
        if (!chunk || extPhrase.test(chunk)) continue;
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
    return {title:document.title,url:location.href,sameDoc,loading:document.readyState === 'loading',text,textSig,elements:items,truncated:{text:textCut,elements:more || scanned < candidates.length || items.length >= ${maxElements}},viewport:{width:innerWidth,height:innerHeight,deviceScaleFactor:devicePixelRatio},iframes:[...document.querySelectorAll('iframe')].map(el=>({title:(el.title||'').slice(0,80),src:shortHref(typeof el.src==='string'?el.src:'')})).filter(frame=>frame.src).slice(0,8),focused,acted};
  })()`;
}

function elementFingerprint(elements) {
  // webContents and frame execution hand back the same object with its keys
  // in a different order, so the order must not matter.
  return JSON.stringify((elements || []).map(({ ref, ...rest }) => JSON.stringify(rest, Object.keys(rest).sort())));
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
// An unchanged reply carries no elements, so the agent keeps acting on refs
// from its last full snapshot (`base`); the page keeps those tokens too.
function settleSnapshot(tab, data, generation, since) {
  const hash = snapshotHash(data), previous = tab.snapshotStamp;
  const unchanged = !!previous && since !== undefined && previous.generation === since && previous.hash === hash;
  const base = unchanged ? previous.base : generation;
  tab.snapshotStamp = { generation, hash, base, url: data.url, elementsHash: elementsHash(data.elements) };
  tab.lastRead = lastReadOf(data);
  tab.docMarked = true;
  tab.refs = new Set(data.elements.map((item) => item.ref));
  if (unchanged) for (let index = 1; index <= data.elements.length; index++) tab.refs.add(`s${base}-${index}`);
  // sameDoc and textSig feed the diff baseline, not the reply.
  const { sameDoc, textSig, ...page } = data;
  return unchanged ? { unchanged: true, generation } : { ...page, generation };
}
// After an action, describe what it did to the page. The effect carries the
// new visible text lines since the model's last read (bounded, capped at 600
// chars) so a click answers with the state it produced; controls are sent
// only when they changed, and an unchanged page keeps the generation and refs
// the model already holds, so a later since= check still dedupes.
async function readEffect(execute, tab, { parseWaitMs, navigated, target, settle } = {}) {
  const previous = tab.snapshotStamp;
  const generation = Math.max(previous && Number.isInteger(previous.generation) ? previous.generation : 0, Number.isInteger(tab.generation) ? tab.generation : 0) + 1;
  let timer;
  const result = await Promise.race([
    Promise.resolve(execute(snapshotExpression(generation, { maxChars: 8000, maxElements: 150, parseWaitMs, keep: previous ? previous.base : undefined, restamp: previous ? previous.base : undefined, effect: true, settle, valueFor: target }))),
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
  if (result.acted !== undefined && result.acted !== null) effect.value = result.acted;
  if (result.focused) {
    const ref = controlsSame ? result.focused.kept || result.focused.ref : result.focused.ref;
    effect.focused = {};
    if (ref) effect.focused.ref = ref;
    if (result.focused.name) effect.focused.name = result.focused.name;
  }
  if (controlsSame) {
    tab.refs = new Set();
    for (let index = 1; index <= result.elements.length; index++) tab.refs.add(`s${previous.base}-${index}`);
    return { generation: previous.generation, effect };
  }
  tab.generation = generation;
  const settled = settleSnapshot(tab, result, generation);
  return { elements: settled.elements.slice(0, 40), generation: settled.generation, effect };
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
module.exports = { snapshotExpression, settleSnapshot, readEffect, checkpointExpression, restoreExpression };
