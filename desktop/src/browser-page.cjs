function snapshotExpression(generation, opts = {}) {
  const int = (value, min, max, fallback) => Number.isInteger(value) ? Math.max(min, Math.min(max, value)) : fallback;
  const maxChars = int(opts.maxChars, 0, 20000, 6000);
  const maxElements = int(opts.maxElements, 0, 300, 150);
  const maxScan = int(opts.maxScan, 1, 50000, 2000);
  const textMs = int(opts.textMs, 5, 2000, 60);
  return `(() => {
    const items = [];
    const deadline = performance.now() + ${textMs};
    const candidates = document.querySelectorAll('a[href],button,input:not([type="hidden"]),textarea,select,[role="button"],[role="link"],[contenteditable="true"]');
    let scanned = 0;
    for (const el of candidates) {
      if (scanned >= ${maxScan} || items.length >= ${maxElements} || performance.now() > deadline) break;
      scanned++;
      // checkVisibility rejects display:none/visibility:hidden without forcing
      // layout; only survivors pay for the rect that catches zero-area boxes.
      if (el.checkVisibility ? !el.checkVisibility({ checkVisibilityCSS: true })
        : (s => s.visibility === 'hidden' || s.display === 'none')(getComputedStyle(el))) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const ref = 's${generation}-' + (items.length + 1); el.setAttribute('data-hermes-workspace-ref',ref);
      items.push({ref,role:el.getAttribute('role') || el.tagName.toLowerCase(),name:(el.getAttribute('aria-label') || el.labels?.[0]?.innerText || el.innerText || el.placeholder || el.title || '').trim().slice(0,200),type:el.type || '',value:el.type === 'password' ? '[password]' : String(el.value || '').slice(0,200),href:el.href || '',disabled:!!el.disabled});
    }
    // body.innerText pays a full-document render pass regardless of the slice;
    // a bounded walker stops at the char cap or the time budget instead.
    let text = '', textCut = false;
    if (${maxChars} > 0 && document.body) {
      const textDeadline = performance.now() + ${textMs};
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const p = node.parentElement;
        if (!p || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(p.tagName)) continue;
        if (p.checkVisibility && !p.checkVisibility({ checkVisibilityCSS: true })) continue;
        const chunk = node.nodeValue.replace(/\\s+/g, ' ').trim();
        if (chunk) text += (text ? ' ' : '') + chunk;
        if (text.length >= ${maxChars} || performance.now() > textDeadline) { textCut = true; break; }
      }
      text = text.slice(0, ${maxChars});
    } else textCut = ${maxChars} <= 0 && !!document.body?.textContent?.trim();
    return {title:document.title,url:location.href,text,elements:items,truncated:{text:textCut,elements:scanned < candidates.length || items.length >= ${maxElements}},viewport:{width:innerWidth,height:innerHeight,deviceScaleFactor:devicePixelRatio},iframes:[...document.querySelectorAll('iframe')].map(el=>({title:el.title,src:el.src})).slice(0,20)};
  })()`;
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
module.exports = { snapshotExpression, checkpointExpression, restoreExpression };
