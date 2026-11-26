'use strict';
// Plain-DOM pieces shared by the chat renderers. Assistant markdown is rendered
// with HTML disabled; only markdown-it's sanitised output is ever assigned as HTML.
(function (root) {
  // A paragraph that is only `::name{key="value" ...}` is a widget block.
  const DIRECTIVE = /^::([a-z][\w-]{0,40})\{((?:\s*[\w-]{1,40}="[^"\n]{0,2000}")*)\s*\}$/i;
  function parseDirective(text) {
    const match = DIRECTIVE.exec(String(text || '').trim());
    if (!match) return null;
    const attrs = {};
    for (const [, key, value] of match[2].matchAll(/([\w-]+)="([^"\n]*)"/g)) {
      attrs[key] = Object.hasOwn(attrs, key) ? [].concat(attrs[key], value) : value;
    }
    return { name: match[1].toLowerCase(), attrs };
  }
  const one = (value) => String([].concat(value ?? '')[0] ?? '');
  const many = (value) => [].concat(value ?? []).map(String);

  function setupMarkdown(md) {
    const esc = md.utils.escapeHtml;
    md.renderer.rules.nc_block = (tokens, i) => `<div class="nc-slot" data-block="${tokens[i].meta}"></div>`;
    md.renderer.rules.fence = (tokens, i, _options, env) => {
      const token = tokens[i], info = token.info.trim();
      if (/^html\s+widget$/i.test(info)) {
        const n = env.widgets.push(token.content) - 1;
        return env.streaming ? '<div class="nc-widget-wait">Widget shows when the reply finishes.</div>' : `<div class="nc-slot" data-widget="${n}"></div>`;
      }
      const n = env.codes.push(token.content) - 1;
      return `<div class="nc-code"><div class="nc-code-head"><span>${esc(info.split(/\s+/)[0].slice(0, 30) || 'code')}</span><button type="button" class="nc-mini" data-copy-code="${n}">Copy</button></div><pre><code>${esc(token.content)}</code></pre></div>`;
    };
    md.renderer.rules.table_open = (tokens, i, _options, env) => {
      const map = tokens[i].map;
      const n = env.tables.push(map ? env.lines.slice(map[0], map[1]).join('\n') : '') - 1;
      return `<div class="nc-table"><button type="button" class="nc-mini" data-copy-table="${n}">Copy as markdown</button><div class="nc-table-scroll"><table>`;
    };
    md.renderer.rules.table_close = () => '</table></div></div>';
    // shortcut: $…$ shows as inline code-styled text; render real math when a renderer is chosen.
    md.inline.ruler.before('escape', 'nc_math', (state, silent) => {
      const { src, pos } = state;
      if (src[pos] !== '$' || src[pos + 1] === '$') return false;
      const end = src.indexOf('$', pos + 1);
      const body = end > pos + 1 ? src.slice(pos + 1, end) : '';
      if (!body || /^\s|\s$|\n/.test(body)) return false;
      if (!silent) state.push('nc_math', 'code', 0).content = body;
      state.pos = end + 1;
      return true;
    });
    md.renderer.rules.nc_math = (tokens, i) => `<code class="nc-math">${esc(tokens[i].content)}</code>`;
    return md;
  }

  // Pure: markdown source -> { html, blocks, widgets, tables, codes }.
  function renderMarkdown(md, text, { streaming = false } = {}) {
    const env = { blocks: [], widgets: [], tables: [], codes: [], lines: String(text).split('\n'), streaming };
    const tokens = md.parse(String(text), env);
    for (let i = 0; i + 2 < tokens.length; i++) {
      if (tokens[i].type !== 'paragraph_open' || tokens[i + 1].type !== 'inline' || tokens[i + 2].type !== 'paragraph_close') continue;
      const directive = parseDirective(tokens[i + 1].content);
      if (!directive) continue;
      const token = new tokens[i].constructor('nc_block', '', 0);
      token.meta = env.blocks.push({ ...directive, raw: tokens[i + 1].content }) - 1;
      tokens.splice(i, 3, token);
    }
    const { lines, streaming: _s, ...out } = env;
    return { html: md.renderer.render(tokens, md.options, env), ...out };
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }
  function button(className, text, onClick) {
    const node = el('button', className, text);
    node.type = 'button';
    if (onClick) node.addEventListener('click', onClick);
    return node;
  }
  const blockCard = (title, ...rest) => {
    const card = el('div', 'nc-card');
    card.append(el('div', 'nc-card-title', title), ...rest.filter(Boolean));
    return card;
  };
  const humanSize = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return one(value);
    return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
  };

  const blocks = Object.create(null);
  blocks.link = (attrs, ctx) => {
    const url = one(attrs.url);
    if (!/^https?:\/\//i.test(url)) return null;
    let host = '';
    try { host = new URL(url).host; } catch { return null; }
    const card = button('nc-card nc-card-link', '', () => ctx.openLink(url));
    card.append(el('div', 'nc-card-title', one(attrs.title) || host));
    if (one(attrs.description)) card.append(el('div', 'nc-card-body', one(attrs.description)));
    card.append(el('div', 'nc-card-meta', host));
    return card;
  };
  blocks.file = (attrs, ctx) => {
    const name = one(attrs.name) || one(attrs.path).split(/[\\/]/).pop();
    if (!name) return null;
    const card = button('nc-card nc-card-file', '', () => { if (one(attrs.path)) ctx.copy(one(attrs.path), meta); });
    const meta = el('div', 'nc-card-meta', [humanSize(attrs.size), one(attrs.path)].filter(Boolean).join(' · ') || 'File');
    card.title = one(attrs.path) ? 'Copy path' : '';
    card.append(el('div', 'nc-card-title', name), meta);
    return card;
  };
  blocks.card = (attrs, ctx) => {
    if (!one(attrs.title) && !one(attrs.body)) return null;
    const actions = el('div', 'nc-card-actions');
    for (const label of many(attrs.action).slice(0, 3)) if (label.trim()) actions.append(button('nc-pill', label, () => ctx.send(label)));
    return blockCard(one(attrs.title), one(attrs.body) && el('div', 'nc-card-body', one(attrs.body)), actions.childElementCount && actions);
  };
  blocks.preview = (attrs, ctx) => {
    const file = one(attrs.file);
    if (!file) return null;
    const actions = el('div', 'nc-card-actions');
    actions.append(button('nc-pill', 'Open in Hermes Desktop', () => ctx.openHermesDesktop()));
    return blockCard(file.split(/[\\/]/).pop(), el('div', 'nc-card-meta', 'Preview'), actions);
  };

  const WIDGET_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'";
  // The widget page has its own network-blocking CSP: a srcdoc frame would
  // inherit the window's policy, which forbids inline scripts.
  // The widget page reports its content height. Only a finite number posted from a widget frame's own window counts, and the frame stays between these bounds.
  const WIDGET_MIN = 48, WIDGET_MAX = 480;
  let widgetSizing = false;
  function sizeWidgets(event) {
    const data = event.data;
    if (data?.type !== 'nc-widget-height' || typeof data.height !== 'number' || !Number.isFinite(data.height)) return;
    const frame = [...document.querySelectorAll('.nc-widget iframe')].find((item) => item.contentWindow === event.source);
    if (frame) frame.style.height = `${Math.min(WIDGET_MAX, Math.max(WIDGET_MIN, Math.ceil(data.height)))}px`;
  }
  function widgetElement(source) {
    if (!widgetSizing) { widgetSizing = true; window.addEventListener('message', sizeWidgets); }
    const wrap = el('div', 'nc-widget');
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('title', 'Widget');
    frame.src = 'native-widget.html';
    frame.addEventListener('load', () => frame.contentWindow?.postMessage(`<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${WIDGET_CSP}"><style>html{color-scheme:dark;color:#e7e7eb;font:13px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}body{margin:10px}</style>${source}`, '*'), { once: true });
    const details = el('details', 'nc-source');
    details.append(el('summary', '', 'View source'), el('pre', '', source));
    wrap.append(frame, details);
    return wrap;
  }

  function createMarkdownView(md, ctx) {
    setupMarkdown(md);
    function fillMarkdown(node, text, streaming) {
      const out = renderMarkdown(md, text, { streaming });
      node.innerHTML = out.html;
      for (const slot of node.querySelectorAll('[data-block]')) slot.replaceWith(blockElement(out.blocks[Number(slot.dataset.block)]));
      for (const slot of node.querySelectorAll('[data-widget]')) slot.replaceWith(widgetElement(out.widgets[Number(slot.dataset.widget)]));
      for (const b of node.querySelectorAll('[data-copy-code]')) b.addEventListener('click', () => ctx.copy(out.codes[Number(b.dataset.copyCode)], b));
      for (const b of node.querySelectorAll('[data-copy-table]')) b.addEventListener('click', () => ctx.copy(out.tables[Number(b.dataset.copyTable)], b));
    }
    function blockElement(block) {
      let node = null;
      try { node = Object.hasOwn(blocks, block.name) ? blocks[block.name](block.attrs, ctx) : null; } catch { node = null; }
      if (node instanceof HTMLElement) return node;
      const details = el('details', 'nc-card nc-unsupported');
      details.append(el('summary', '', 'Unsupported card'), el('pre', '', block.raw));
      return details;
    }
    return { fillMarkdown, blockElement };
  }

  const fmtTime = (ts) => new Date(ts * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const exactTime = (ts) => ts ? new Date(ts * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'medium' }) : '';
  function dayLabel(ts) {
    const date = new Date(ts * 1000), today = new Date();
    if (date.toDateString() === today.toDateString()) return fmtTime(ts);
    const days = (today - date) / 86400000;
    return `${date.toLocaleDateString([], days < 6 ? { weekday: 'long' } : { month: 'short', day: 'numeric', year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric' })} ${fmtTime(ts)}`;
  }
  const GAP = 15 * 60, CHUNK = 60;

  // Rows are reused by key. The common append/prepend cases move only the new
  // edge; anything else replaces the list in one operation.
  function reconcileChildren(list, wanted) {
    const current = [...list.children];
    const head = wanted.length - current.length;
    if (head >= 0 && current.every((node, i) => node === wanted[head + i])) list.prepend(...wanted.slice(0, head));
    else if (head >= 0 && current.every((node, i) => node === wanted[i])) list.append(...wanted.slice(current.length));
    else list.replaceChildren(...wanted);
  }

  function bindComposer({ composer, textarea, onInput = () => {}, onEnter = () => {}, onSubmit = () => {} }) {
    let composing = false;
    function grow() {
      textarea.style.height = 'auto';
      // Hidden (display:none) it measures 0; 'auto' keeps one row until it is laid out.
      if (textarea.scrollHeight) textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
    }
    textarea.addEventListener('input', () => { onInput(); grow(); });
    textarea.addEventListener('compositionstart', () => { composing = true; });
    textarea.addEventListener('compositionend', () => { composing = false; });
    textarea.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !composing && !event.isComposing) { event.preventDefault(); onEnter(event); }
    });
    composer.addEventListener('submit', (event) => { event.preventDefault(); onSubmit(event); });
    return { grow, composing: () => composing };
  }

  function messageBubble(m, cont, { fillMarkdown, copy, action, deleteAction = 'cancel' }) {
    const row = el('div', `nc-row ${m.role}${cont ? ' cont' : ''}${m.state ? ` ${m.state}` : ''}`);
    row.dataset.id = m.key ?? m.id;
    const body = el('div', 'nc-bubble');
    body.dir = 'auto';
    body.title = exactTime(m.ts);
    if (m.role === 'assistant') fillMarkdown(body, m.text, false);
    else body.append(el('div', 'nc-plain', m.text));
    const copyButton = button('nc-copy', 'Copy', () => copy(m.text, copyButton));
    body.append(copyButton);
    row.append(body);
    if (m.state === 'sending') row.append(el('div', 'nc-meta', 'Sending…'));
    // Plain text plus real buttons inside the log region, which a screen reader announces politely; the label says which message.
    const act = (label, name) => { const b = button('nc-link', label, () => action(name, m, label)); b.setAttribute('aria-label', `${label} message: ${m.text.slice(0, 40)}`); return b; };
    if (m.state === 'queued') {
      const meta = el('div', 'nc-meta', 'Waiting to send. ');
      meta.append(act('Cancel', 'cancel'));
      row.append(meta);
    }
    if (m.state === 'failed') {
      const meta = el('div', 'nc-meta failed', 'Not sent. ');
      meta.append(act('Retry', 'retry'), document.createTextNode(' '), act('Delete', deleteAction));
      row.append(meta);
    }
    if (m.state === 'uncertain') row.append(el('div', 'nc-meta failed', 'Delivery unconfirmed.'));
    return row;
  }

  const exported = {
    parseDirective, setupMarkdown, renderMarkdown,
    el, button, blocks, widgetElement, createMarkdownView,
    fmtTime, exactTime, dayLabel, GAP, CHUNK,
    reconcileChildren, bindComposer, messageBubble,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  else root.ChatParts = exported;
})(typeof window === 'object' ? window : undefined);
