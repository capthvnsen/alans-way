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
  const parseWaitMs = int(opts.parseWaitMs, 0, 5000, 2000);
  return `(async () => {
    // The parser yields between chunks, so a snapshot can land mid-document;
    // give a still-parsing page a moment and report it if it is not done.
    if (document.readyState === 'loading') await new Promise(done => { document.addEventListener('DOMContentLoaded', done, { once: true }); setTimeout(done, ${parseWaitMs}); });
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
      el.setAttribute('data-hermes-workspace-ref', [...kept, ref].join(' '));
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
      const item = { ref, role, name };
      if (type) item.type = type;
      if (value) item.value = value;
      if (href) item.href = href;
      if (el.disabled) item.disabled = true;
      items.push(item);
    }
    // body.innerText pays a full-document render pass regardless of the slice;
    // a bounded walker stops at the char cap or the time budget instead.
    let text = '', textCut = false;
    if (${maxChars} > 0 && document.body) {
      const textDeadline = performance.now() + ${textMs};
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      // Tag names stand in for computed display so lists, rows and headings
      // keep their line breaks without a style read per text node.
      const blockTag = /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|BODY|CAPTION|DD|DETAILS|DIALOG|DIV|DL|DT|FIELDSET|FIGCAPTION|FIGURE|FOOTER|FORM|H[1-6]|HEADER|HR|LEGEND|LI|MAIN|NAV|OL|P|PRE|SECTION|SUMMARY|TABLE|TR|UL)$/;
      let node, lastBlock = null;
      while ((node = walker.nextNode())) {
        const p = node.parentElement;
        if (!p || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(p.tagName)) continue;
        if (p.checkVisibility && !p.checkVisibility({ checkVisibilityCSS: true })) continue;
        const chunk = node.nodeValue.replace(/\\s+/g, ' ').trim();
        if (!chunk) continue;
        let block = p;
        while (block.parentElement && !blockTag.test(block.tagName)) block = block.parentElement;
        text += (text ? (block === lastBlock ? ' ' : '\\n') : '') + chunk;
        lastBlock = block;
        // The time budget never cuts the first screenful: a slow renderer
        // must still return enough text for the agent to orient itself.
        if (text.length >= ${maxChars} || (text.length >= ${Math.min(1000, maxChars)} && performance.now() > textDeadline)) { textCut = true; break; }
      }
      text = text.slice(0, ${maxChars});
    } else textCut = ${maxChars} <= 0 && !!document.body?.textContent?.trim();
    return {title:document.title,url:location.href,loading:document.readyState === 'loading',text,elements:items,truncated:{text:textCut,elements:more || scanned < candidates.length || items.length >= ${maxElements}},viewport:{width:innerWidth,height:innerHeight,deviceScaleFactor:devicePixelRatio},iframes:[...document.querySelectorAll('iframe')].map(el=>({title:el.title,src:el.src})).slice(0,20)};
  })()`;
}

function elementFingerprint(elements) {
  return JSON.stringify((elements || []).map(({ ref, ...rest }) => rest));
}
function elementsHash(elements) {
  return crypto.createHash('sha1').update(elementFingerprint(elements)).digest('hex');
}
function snapshotHash(data) {
  const hash = crypto.createHash('sha1');
  for (const part of [data.url, data.title, data.text]) hash.update(part || '').update('\0');
  return hash.update(elementFingerprint(data.elements)).digest('hex');
}
// An unchanged reply carries no elements, so the agent keeps acting on refs
// from its last full snapshot (`base`); the page keeps those tokens too.
function settleSnapshot(tab, data, generation, since) {
  const hash = snapshotHash(data), previous = tab.snapshotStamp;
  const unchanged = !!previous && since !== undefined && previous.generation === since && previous.hash === hash;
  const base = unchanged ? previous.base : generation;
  tab.snapshotStamp = { generation, hash, base, elementsHash: elementsHash(data.elements) };
  tab.refs = new Set(data.elements.map((item) => item.ref));
  if (unchanged) for (let index = 1; index <= data.elements.length; index++) tab.refs.add(`s${base}-${index}`);
  return unchanged ? { unchanged: true, generation } : { ...data, generation };
}
// After an action, return the controls the model can act on next. Page text
// stays out of the reply. A page that did not change keeps the generation
// and refs the model already holds, so a later since= check still dedupes.
async function readControls(execute, tab) {
  const previous = tab.snapshotStamp;
  const generation = (previous && Number.isInteger(previous.generation) ? previous.generation : (Number.isInteger(tab.generation) ? tab.generation : 0)) + 1;
  let timer;
  const result = await Promise.race([
    Promise.resolve(execute(snapshotExpression(generation, { maxChars: 0, maxElements: 150, keep: previous ? previous.base : undefined }))),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('controls')), 8000); }),
  ]).finally(() => clearTimeout(timer));
  if (!result || !Array.isArray(result.elements)) return null;
  // Controls are enough to know the page the agent can click. Skipping the
  // text walk keeps a click from rereading the whole document.
  if (previous && previous.elementsHash && elementsHash(result.elements) === previous.elementsHash) {
    tab.refs = new Set();
    for (let index = 1; index <= result.elements.length; index++) tab.refs.add(`s${previous.base}-${index}`);
    return { unchanged: true, generation: previous.generation };
  }
  if (previous && snapshotHash(result) === previous.hash) {
    tab.refs = new Set();
    for (let index = 1; index <= result.elements.length; index++) tab.refs.add(`s${previous.base}-${index}`);
    return { unchanged: true, generation: previous.generation };
  }
  tab.generation = generation;
  if (previous) {
    tab.refs = new Set(result.elements.map((item) => item.ref));
    return { elements: result.elements.slice(0, 40), generation };
  }
  const settled = settleSnapshot(tab, result, generation);
  if (!Array.isArray(settled.elements)) return { unchanged: true, generation: settled.generation };
  return { elements: settled.elements.slice(0, 40), generation: settled.generation };
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
module.exports = { snapshotExpression, settleSnapshot, readControls, checkpointExpression, restoreExpression };
