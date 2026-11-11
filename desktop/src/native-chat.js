'use strict';
// Alan's native chat (renderer side). A plain-DOM projection of the main-process
// controller (`window.nativeChat`): no HTTP, no key, no cache here. Assistant
// text goes through markdown-it with HTML disabled; nothing else is set as HTML.
(() => {
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
  function widgetElement(source) {
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

  const fmtTime = (ts) => new Date(ts * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const exactTime = (ts) => ts ? new Date(ts * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'medium' }) : '';
  function dayLabel(ts) {
    const date = new Date(ts * 1000), today = new Date();
    if (date.toDateString() === today.toDateString()) return fmtTime(ts);
    const days = (today - date) / 86400000;
    return `${date.toLocaleDateString([], days < 6 ? { weekday: 'long' } : { month: 'short', day: 'numeric', year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric' })} ${fmtTime(ts)}`;
  }
  const SOURCE_LABEL = { api_server: 'Here', telegram: 'Telegram', discord: 'Discord', slack: 'Slack', whatsapp: 'WhatsApp', signal: 'Signal', email: 'Email', cli: 'Terminal', tui: 'Terminal', desktop: 'Hermes Desktop' };
  const sourceLabel = (source) => SOURCE_LABEL[source] || String(source || 'Hermes').replace(/_/g, ' ');
  const GAP = 15 * 60, CHUNK = 60;

  function createView({ api, root, md, onOpenSettings = () => {}, onOpenHermesDesktop = () => {}, marks = [] }) {
    if (!api || !root || !md) throw new Error('native chat needs {api, root, md}');
    setupMarkdown(md);
    let state = null, thread = null, visible = false, disposed = false;
    let shown = CHUNK, pinned = true, composing = false, growing = false, olderPending = false;
    let threadSig = '', liveSig = '', lastActive = null, paneArmed = false, threadArmed = false, tokenRun = '', frame = 0;
    let nodes = new Map();
    const drafts = new Map(), scrolls = new Map();
    // Per conversation: the message at the top of the view and how far into it (rebuilt rows have
    // estimated heights until painted, so a raw scrollTop would drift), or pinned to the bottom.
    const offsetOf = (node) => node.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    const keepScroll = () => {
      if (!visible || !state || !scroller.clientHeight) return;
      const row = [...list.children].find((node) => node.dataset.id && offsetOf(node) + node.offsetHeight > scroller.scrollTop);
      scrolls.set(draftKey(), { pinned, shown, top: scroller.scrollTop, id: row?.dataset.id, delta: row ? scroller.scrollTop - offsetOf(row) : 0 });
    };
    // Rows near the view paint at full height over the next frames, so the anchor is set again.
    const restoreScroll = (key = draftKey(), frames = 2) => {
      const saved = scrolls.get(key);
      if (!visible || !saved || saved.pinned || key !== draftKey()) return;
      const row = saved.id && [...list.children].find((node) => node.dataset.id === saved.id);
      scroller.scrollTop = row ? offsetOf(row) + saved.delta : saved.top;
      if (row && frames) requestAnimationFrame(() => restoreScroll(key, frames - 1));
    };
    const mark = (name) => requestAnimationFrame(() => setTimeout(() => marks.push({ name, t: performance.now() }), 0));
    const draftKey = () => state?.activeId || 'new';

    root.replaceChildren();
    const head = el('div', 'nc-head');
    const switcher = button('nc-switch', '');
    switcher.setAttribute('aria-haspopup', 'menu');
    switcher.setAttribute('aria-expanded', 'false');
    const switchTitle = el('span', 'nc-switch-title'), switchCaret = el('span', 'nc-caret', '⌄');
    switcher.append(switchTitle, switchCaret);
    const menu = el('div', 'nc-menu hidden');
    menu.setAttribute('role', 'menu');
    const newBtn = button('nc-icon nc-new', '', () => command('new'));
    newBtn.title = 'New chat'; newBtn.setAttribute('aria-label', 'New chat');
    newBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>';
    head.append(switcher, newBtn, menu);
    const notice = el('div', 'nc-notice hidden');
    notice.setAttribute('role', 'status');
    const scroller = el('div', 'nc-scroll');
    scroller.setAttribute('role', 'log');
    scroller.setAttribute('aria-label', 'Messages');
    const list = el('div', 'nc-list'), live = el('div', 'nc-live'), empty = el('div', 'nc-empty hidden');
    scroller.append(empty, list, live);
    const jump = button('nc-jump hidden', 'Jump to latest', () => { pinned = true; toBottom(); jump.classList.add('hidden'); });
    const middle = el('div', 'nc-body');
    middle.append(scroller, jump);
    const composer = el('form', 'nc-composer');
    const textarea = document.createElement('textarea');
    textarea.rows = 1;
    textarea.placeholder = 'Message';
    textarea.setAttribute('aria-label', 'Message');
    const sendBtn = el('button', 'nc-send');
    sendBtn.type = 'submit'; sendBtn.title = 'Send'; sendBtn.setAttribute('aria-label', 'Send');
    sendBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 19V5m0 0-6 6m6-6 6 6"/></svg>';
    const stopBtn = button('nc-stop hidden', '', () => command('stop', { sessionId: state?.activeId }));
    stopBtn.title = 'Stop'; stopBtn.setAttribute('aria-label', 'Stop');
    stopBtn.append(el('span', 'nc-stop-square'));
    composer.append(textarea, sendBtn, stopBtn);
    const readOnly = el('div', 'nc-readonly hidden');
    const setup = el('div', 'nc-setup hidden');
    root.append(head, notice, middle, composer, readOnly, setup);

    async function command(name, value = {}) {
      try { return await api.command(name, value); }
      catch (error) { flash(String(error?.message || error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')); return null; }
    }
    function flash(text) {
      notice.textContent = text;
      notice.classList.remove('hidden');
      notice.dataset.flash = '1';
      setTimeout(() => { delete notice.dataset.flash; renderNotice(); }, 5000);
    }
    const ctx = {
      openLink: (url) => command('open-link', { url }),
      copy: (text, node) => { command('copy', { text }); if (node) { const before = node.textContent; node.textContent = 'Copied'; setTimeout(() => { node.textContent = before; }, 1200); } },
      send: (text) => sendText(text),
      openHermesDesktop: () => onOpenHermesDesktop(),
    };

    root.addEventListener('click', (event) => {
      const link = event.target.closest('a[href]');
      if (!link || !root.contains(link)) return;
      event.preventDefault();
      ctx.openLink(link.href);
    });
    root.addEventListener('auxclick', (event) => { if (event.target.closest('a[href]')) event.preventDefault(); });

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

    function bubble(m, cont) {
      const row = el('div', `nc-row ${m.role}${cont ? ' cont' : ''}${m.state ? ` ${m.state}` : ''}`);
      row.dataset.id = m.id;
      const body = el('div', 'nc-bubble');
      body.title = exactTime(m.ts);
      if (m.role === 'assistant') fillMarkdown(body, m.text, false);
      else body.append(el('div', 'nc-plain', m.text));
      const copy = button('nc-copy', 'Copy', () => ctx.copy(m.text, copy));
      body.append(copy);
      row.append(body);
      if (m.state === 'sending') row.append(el('div', 'nc-meta', 'Sending…'));
      if (m.state === 'failed') {
        const meta = el('div', 'nc-meta failed', 'Not sent. ');
        meta.append(button('nc-link', 'Retry', () => command('retry', { sessionId: state.activeId, localId: m.id })));
        row.append(meta);
      }
      return row;
    }

    function card(c) {
      const box = el('div', `nc-row system`);
      const node = el('div', `nc-prompt ${c.kind} ${c.state}`);
      box.append(node);
      if (c.kind === 'approval') {
        node.append(el('div', 'nc-prompt-title', c.state === 'open' ? 'Alan wants to run a command' : c.state === 'answered' ? `You answered: ${{ once: 'Allow once', session: 'Allow for this chat', always: 'Always allow', deny: 'Deny' }[c.answer] || c.answer}` : 'This request expired'));
        if (c.description) node.append(el('div', 'nc-prompt-body', c.description));
        const details = el('details', 'nc-prompt-details');
        details.append(el('summary', '', 'Show details'), el('pre', '', c.command));
        node.append(details);
        if (c.state === 'open') {
          const actions = el('div', 'nc-prompt-actions');
          for (const choice of ['deny', 'once', 'session', 'always']) {
            if (!c.choices.includes(choice)) continue;
            actions.append(button(`nc-pill${choice === 'once' ? ' primary' : ''}`, { once: 'Allow once', session: 'Allow for this chat', always: 'Always allow', deny: 'Deny' }[choice],
              (event) => { event.currentTarget.disabled = true; command('approve', { sessionId: state.activeId, cardId: c.id, choice }); }));
          }
          node.append(actions);
        }
      } else {
        node.append(el('div', 'nc-prompt-title', c.state === 'open' ? 'Alan has a question' : c.state === 'answered' ? 'You answered' : 'This question expired'));
        node.append(el('div', 'nc-prompt-body', c.question));
        if (c.state !== 'open') { if (c.answer) node.append(el('div', 'nc-prompt-answer', c.answer)); return box; }
        const actions = el('div', 'nc-prompt-actions');
        const answer = (text) => command('clarify', { sessionId: state.activeId, cardId: c.id, answer: text });
        for (const choice of c.choices) actions.append(button('nc-pill', choice, () => answer(choice)));
        const form = el('form', 'nc-prompt-form');
        const input = el('input');
        input.placeholder = 'Type an answer'; input.setAttribute('aria-label', 'Your answer');
        form.append(input, button('nc-pill primary', 'Answer'));
        form.lastChild.type = 'submit';
        form.addEventListener('submit', (event) => { event.preventDefault(); if (input.value.trim()) answer(input.value); });
        node.append(actions, form);
      }
      return box;
    }

    // Newest `shown` messages, with time separators and prompt cards; nodes are
    // reused by key, so a revalidation or an appended reply touches only what changed.
    function renderThread() {
      const messages = thread?.messages || [];
      const start = Math.max(0, messages.length - shown);
      const cardsLeft = (state.cards || []).slice().sort((a, b) => a.ts - b.ts);
      const next = new Map(), wanted = [];
      const use = (key, make) => { const node = nodes.get(key) || make(); next.set(key, node); wanted.push(node); };
      let prev = start > 0 ? messages[start - 1] : null;
      for (let i = start; i < messages.length; i++) {
        const m = messages[i];
        while (cardsLeft.length && cardsLeft[0].ts < m.ts) { const c = cardsLeft.shift(); use(`c|${c.id}|${c.state}|${c.answer}`, () => card(c)); }
        const gap = !prev || m.ts - prev.ts > GAP;
        if (gap && m.ts) use(`t|${m.id}`, () => el('div', 'nc-time', dayLabel(m.ts)));
        const cont = !gap && prev && prev.role === m.role && m.ts - prev.ts < 120;
        use(`m|${m.id}|${m.state || ''}|${m.text.length}|${cont ? 1 : 0}`, () => bubble(m, cont));
        prev = m;
      }
      for (const c of cardsLeft) use(`c|${c.id}|${c.state}|${c.answer}`, () => card(c));
      nodes = next;
      const current = [...list.children];
      const head = wanted.length - current.length;
      if (head >= 0 && current.every((node, i) => node === wanted[head + i])) list.prepend(...wanted.slice(0, head));
      else if (head >= 0 && current.every((node, i) => node === wanted[i])) list.append(...wanted.slice(current.length));
      else list.replaceChildren(...wanted);
    }

    let streamBubble = null, streamFor = '';
    function renderLive() {
      const run = state.run;
      if (!run) { live.replaceChildren(); streamBubble = null; streamFor = ''; return; }
      if (streamFor !== `${state.activeId}|${run.messageId}`) {
        streamFor = `${state.activeId}|${run.messageId}`;
        streamBubble = null;
      }
      const children = [];
      if (run.text) {
        if (!streamBubble) {
          streamBubble = el('div', 'nc-row assistant streaming');
          streamBubble.append(el('div', 'nc-bubble'));
        }
        fillMarkdown(streamBubble.firstChild, run.text, true);
        children.push(streamBubble);
        if (tokenRun !== streamFor) { tokenRun = streamFor; mark('first-token'); }
      }
      const statusText = run.tool || (run.status === 'waiting' ? 'Waiting for you' : !run.text ? 'Thinking' : '');
      if (statusText) {
        const line = el('div', 'nc-status');
        line.append(el('span', 'nc-dots'), document.createTextNode(statusText));
        children.push(line);
      }
      live.replaceChildren(...children);
    }

    const toBottom = () => { scroller.scrollTop = scroller.scrollHeight; };
    // Rows grow from their estimated height once painted (content-visibility), so a pinned view follows.
    const follow = new ResizeObserver(() => { if (visible && pinned) toBottom(); });
    for (const node of [scroller, list, live]) follow.observe(node);
    scroller.addEventListener('scroll', () => {
      if (!visible) return;
      pinned = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
      if (pinned) jump.classList.add('hidden');
      if (scroller.scrollTop < 800 && !growing) growOlder();
    }, { passive: true });
    function growOlder() {
      const total = thread?.messages.length || 0;
      if (shown < total) {
        growing = true;
        const fromBottom = scroller.scrollHeight - scroller.scrollTop;
        shown = Math.min(total, shown + CHUNK);
        renderThread();
        threadSig = sig();
        scroller.scrollTop = scroller.scrollHeight - fromBottom;
        growing = false;
      } else if (thread?.hasOlder && !olderPending && state?.activeId) {
        olderPending = true;
        command('older', { sessionId: state.activeId }).finally(() => { olderPending = false; });
      }
    }

    function grow() {
      textarea.style.height = 'auto';
      // Hidden (display:none) it measures 0; 'auto' keeps one row until it is laid out.
      if (textarea.scrollHeight) textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
    }
    textarea.addEventListener('input', () => { drafts.set(draftKey(), textarea.value); grow(); });
    textarea.addEventListener('compositionstart', () => { composing = true; });
    textarea.addEventListener('compositionend', () => { composing = false; });
    textarea.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !composing && !event.isComposing) { event.preventDefault(); composer.requestSubmit(); }
    });
    composer.addEventListener('submit', (event) => {
      event.preventDefault();
      const text = textarea.value;
      if (!text.trim() || state?.run) return;
      textarea.value = ''; drafts.delete(draftKey()); grow();
      sendText(text, true);
    });
    async function sendText(text, fromComposer) {
      const key = draftKey();
      mark('send');
      pinned = true;
      const reply = await command('send', { sessionId: state?.activeId, text });
      if (!reply && fromComposer && !drafts.get(key)) {
        drafts.set(key, text);
        if (draftKey() === key && !textarea.value) { textarea.value = text; grow(); }
      }
    }

    function renderMenu() {
      menu.replaceChildren();
      const fresh = button('nc-menu-item nc-menu-new', 'New chat', () => { closeMenu(); command('new'); });
      menu.append(fresh);
      for (const s of (state.sessions || []).slice(0, 30)) {
        const item = button(`nc-menu-item${s.id === state.activeId ? ' current' : ''}`, '', () => { closeMenu(); if (s.id !== state.activeId) command('open', { sessionId: s.id }); });
        item.setAttribute('role', 'menuitem');
        item.dataset.id = s.id;
        const title = el('span', 'nc-menu-title', s.title || s.preview || 'Untitled chat');
        const meta = el('span', 'nc-menu-meta', `${sourceLabel(s.source)}${s.running ? ' · replying' : ''}${s.waiting ? ' · needs you' : ''}`);
        if (s.unread) item.append(el('span', 'nc-unread'));
        item.append(title, meta);
        menu.append(item);
      }
    }
    const closeMenu = () => { menu.classList.add('hidden'); switcher.setAttribute('aria-expanded', 'false'); };
    switcher.addEventListener('click', () => {
      const open = menu.classList.contains('hidden');
      if (open) renderMenu();
      menu.classList.toggle('hidden', !open);
      switcher.setAttribute('aria-expanded', String(open));
    });
    document.addEventListener('pointerdown', (event) => { if (!head.contains(event.target)) closeMenu(); });
    root.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !menu.classList.contains('hidden')) { closeMenu(); switcher.focus(); } });

    function renderNotice() {
      if (notice.dataset.flash) return;
      const s = state, count = thread?.messages.length || 0;
      const text = !s.configured ? ''
        : s.status === 'unreachable' ? `Can't reach Hermes${count ? '; showing what was saved here' : ''}.`
          : s.status === 'unauthorized' ? 'Hermes refused the API key; check it in Settings.'
            : s.status === 'error' ? s.error : thread?.notice || '';
      notice.textContent = text;
      notice.classList.toggle('hidden', !text);
    }

    const sig = () => `${state.activeId}|${thread?.rev}|${shown}|${JSON.stringify(state.cards || [])}`;
    function render() {
      const s = state;
      root.classList.toggle('unconfigured', !s.configured);
      setup.classList.toggle('hidden', s.configured);
      if (!s.configured) {
        if (!setup.childElementCount) setup.append(el('p', '', 'Add the native chat address and API key in Settings to start.'), button('nc-pill primary', 'Open Settings', onOpenSettings));
        for (const node of [head, middle, composer, readOnly, notice]) node.classList.add('hidden');
        return;
      }
      for (const node of [head, middle]) node.classList.remove('hidden');
      switchTitle.textContent = thread?.title || (s.activeId ? 'Untitled chat' : 'New chat');
      if (!menu.classList.contains('hidden')) renderMenu();
      renderNotice();
      const count = thread?.messages.length || 0;
      const emptyText = count || s.run ? '' : !s.activeId ? 'New conversation. Say hello.'
        : thread?.loading ? 'Loading this conversation…' : s.status === 'unreachable' || s.status === 'unauthorized' ? '' : 'No messages yet. Say hello.';
      empty.textContent = emptyText;
      empty.classList.toggle('hidden', !emptyText);
      const ro = !!thread?.readOnly;
      composer.classList.toggle('hidden', ro);
      readOnly.classList.toggle('hidden', !ro);
      if (ro) {
        readOnly.replaceChildren(el('span', '', `This conversation is from ${sourceLabel(thread.source)}, so it is read-only here.`),
          button('nc-pill primary', 'Continue here', () => command('fork', { sessionId: s.activeId })));
      }
      const running = !!s.run;
      sendBtn.classList.toggle('hidden', running);
      stopBtn.classList.toggle('hidden', !running);
      const key = sig();
      if (key !== threadSig) { threadSig = key; renderThread(); }
      const liveKey = JSON.stringify(s.run);
      if (liveKey !== liveSig) { liveSig = liveKey; renderLive(); }
      if (pinned) toBottom();
      else jump.classList.remove('hidden');
      if (visible && count) {
        if (paneArmed) { paneArmed = false; threadArmed = false; mark('pane-painted'); }
        else if (threadArmed) { threadArmed = false; mark('thread-painted'); }
      }
    }

    function scheduleRender() {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; if (!disposed && state) render(); });
    }

    function setState(next) {
      if (disposed || !next) return;
      if (next.thread?.same) {
        if (thread?.sessionId !== next.thread.sessionId || thread?.rev !== next.thread.rev) { api.getState().then(setState).catch(() => {}); return; }
        next = { ...next, thread: { ...next.thread, messages: thread.messages } };
      }
      const first = lastActive === null, switched = !first && next.activeId !== lastActive;
      if (first || switched) {
        if (switched) keepScroll();
        const saved = scrolls.get(next.activeId || 'new');
        shown = saved?.shown || CHUNK; pinned = saved ? saved.pinned : true; nodes = new Map(); list.replaceChildren(); threadSig = '';
        if (switched) {
          if (state) drafts.set(draftKey(), textarea.value);
          threadArmed = visible;
        }
        textarea.value = drafts.get(next.activeId || 'new') || ''; grow();
      }
      lastActive = next.activeId;
      state = next;
      thread = next.thread;
      // A session switch paints in this same task; streaming frames wait for the next animation frame.
      if (first || switched) { render(); if (switched) restoreScroll(); } else scheduleRender();
    }

    const unsubscribe = api.onState(setState);
    api.getState().then(setState).catch(() => {});
    return {
      setState,
      setVisible(on) {
        const shown = on && !visible;
        if (!on) keepScroll();
        visible = on;
        if (shown) { paneArmed = true; grow(); if (state) { render(); restoreScroll(); } }
      },
      dispose() {
        disposed = true;
        follow.disconnect();
        if (typeof unsubscribe === 'function') unsubscribe();
        root.replaceChildren();
      },
    };
  }

  const exported = { create: createView, blocks, parseDirective, renderMarkdown, setupMarkdown };
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  else window.NativeChat = exported;
})();
