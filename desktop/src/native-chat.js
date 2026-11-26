'use strict';
// Alan's native chat (renderer side). A plain-DOM projection of the main-process
// controller (`window.nativeChat`): no HTTP, no key, no cache here.
(() => {
  const policy = typeof module !== 'undefined' && module.exports ? require('./compact-policy.cjs') : window.CompactPolicy;
  const gatewayList = typeof module !== 'undefined' && module.exports ? require('./gateway-list.js') : window.GatewayList;
  const parts = typeof module !== 'undefined' && module.exports ? require('./chat-parts.js') : window.ChatParts;
  const {
    parseDirective, renderMarkdown, setupMarkdown, blocks, widgetElement, createMarkdownView,
    el, button, exactTime, dayLabel, GAP, CHUNK, reconcileChildren, bindComposer, messageBubble,
  } = parts;
  const nativeChatLabel = gatewayList.NATIVE_CHAT_LABEL, nativeChatBeta = gatewayList.nativeChatBetaLabel();
  const SOURCE_LABEL = { api_server: 'Alan\'s Way', telegram: 'Telegram', discord: 'Discord', slack: 'Slack', whatsapp: 'WhatsApp', signal: 'Signal', email: 'Email', cli: 'Terminal', tui: 'Terminal', desktop: 'Hermes Desktop', gui: 'Hermes Desktop', local: 'Hermes Desktop' };
  const sourceLabel = (source) => SOURCE_LABEL[source] || String(source || 'Hermes').replace(/_/g, ' ');

  function createView({ api, root, md, onOpenSettings = () => {}, onOpenHermesDesktop = () => {}, marks = [] }) {
    if (!api || !root || !md) throw new Error('native chat needs {api, root, md}');
    let state = null, thread = null, visible = false, disposed = false;
    let shown = CHUNK, pinned = true, growing = false, olderPending = false;
    let threadSig = '', liveSig = '', lastActive = null, paneArmed = false, threadArmed = false, tokenRun = '', frame = 0;
    let compactOff = false, compactTimer = 0;
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
    root.setAttribute('aria-label', nativeChatLabel);
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
    head.append(switcher);
    if (nativeChatBeta) head.append(el('span', 'nc-pill', nativeChatBeta));
    head.append(newBtn, menu);
    const notice = el('div', 'nc-notice hidden');
    notice.setAttribute('role', 'status');
    const linkBanner = el('div', 'nc-conn hidden');
    linkBanner.setAttribute('role', 'status');
    const scroller = el('div', 'nc-scroll');
    scroller.setAttribute('role', 'log');
    scroller.setAttribute('aria-label', 'Messages');
    const list = el('div', 'nc-list'), live = el('div', 'nc-live'), empty = el('div', 'nc-empty hidden');
    scroller.append(empty, list, live);
    const jump = button('nc-jump hidden', 'Jump to latest', () => { pinned = true; toBottom(); jump.classList.add('hidden'); });
    const middle = el('div', 'nc-body');
    middle.append(scroller, jump);
    const hint = el('div', 'nc-hint hidden', 'Wait for the reply to finish, or press Stop');
    hint.setAttribute('role', 'status');
    middle.append(hint);
    let hintTimer;
    const chip = el('div', 'nc-compact-chip hidden');
    chip.setAttribute('role', 'status');
    const chipText = el('span', 'nc-compact-text'), chipSwitch = button('nc-compact-switch', '', () => { compactOff = !compactOff; renderChip(); });
    chipSwitch.setAttribute('role', 'switch');
    chip.append(chipText, chipSwitch);
    const composer = el('form', 'nc-composer');
    const textarea = document.createElement('textarea');
    textarea.rows = 1;
    textarea.dir = 'auto';
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
    root.append(head, notice, linkBanner, middle, chip, composer, readOnly, setup);

    async function command(name, value = {}) {
      try { return await api.command(name, value); }
      catch (error) { flash(String(error?.message || error).replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '')); return null; }
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
    const markdown = createMarkdownView(md, ctx);
    const fillMarkdown = markdown.fillMarkdown;

    root.addEventListener('click', (event) => {
      const link = event.target.closest('a[href]');
      if (!link || !root.contains(link)) return;
      event.preventDefault();
      ctx.openLink(link.href);
    });
    root.addEventListener('auxclick', (event) => { if (event.target.closest('a[href]')) event.preventDefault(); });

    function bubble(m, cont) {
      return messageBubble(m, cont, {
        fillMarkdown,
        copy: ctx.copy,
        action: (name, message) => command(name, { sessionId: state.activeId, localId: message.id }),
      });
    }

    function card(c) {
      const box = el('div', `nc-row system`);
      if (c.kind === 'compact') { box.append(el('div', `nc-compact-note ${c.state}`, c.text)); return box; }
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
              (event) => { const pressed = event.currentTarget; pressed.disabled = true; command('approve', { sessionId: state.activeId, cardId: c.id, choice }).then((reply) => { if (!reply) pressed.disabled = false; }); }));
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
      reconcileChildren(list, wanted);
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
      const statusText = run.status === 'compacting' ? '' : run.status === 'waiting' ? 'Waiting for you' : run.tool || (!run.text ? 'Thinking' : '');
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

    const composerKeys = bindComposer({
      composer,
      textarea,
      onInput: () => drafts.set(draftKey(), textarea.value),
      onEnter: () => composer.requestSubmit(),
      onSubmit: () => {
        const text = textarea.value;
        if (!text.trim() || state?.run) return;
        textarea.value = ''; drafts.delete(draftKey()); grow();
        sendText(text, true);
      },
    });
    const grow = composerKeys.grow;
    textarea.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.shiftKey || composerKeys.composing() || event.isComposing || !state?.run || !textarea.value.trim()) return;
      hint.classList.remove('hidden'); clearTimeout(hintTimer); hintTimer = setTimeout(() => hint.classList.add('hidden'), 4000);
    });
    async function sendText(text, fromComposer) {
      const key = draftKey();
      mark('send');
      pinned = true;
      const optOut = compactOff && !chip.classList.contains('hidden');
      compactOff = false;
      const reply = await command('send', { sessionId: state?.activeId, text, ...(optOut ? { compact: false } : {}) });
      if (!reply && fromComposer && !drafts.get(key)) {
        drafts.set(key, text);
        if (draftKey() === key && !textarea.value) { textarea.value = text; grow(); }
      }
    }

    function renderMenu() {
      const signature = JSON.stringify([state.activeId, (state.sessions || []).slice(0, 30).map((s) => [s.id, s.title, s.preview, s.shared, s.source, s.running, s.waiting, s.unread])]);
      if (menu.dataset.signature === signature) return;
      menu.dataset.signature = signature;
      const focused = menu.contains(document.activeElement) && (document.activeElement.dataset.id || 'new');
      menu.replaceChildren();
      const fresh = button('nc-menu-item nc-menu-new', 'New chat', () => { closeMenu(); command('new'); textarea.focus(); });
      fresh.dataset.id = '';
      menu.append(fresh);
      for (const s of (state.sessions || []).slice(0, 30)) {
        const item = button(`nc-menu-item${s.id === state.activeId ? ' current' : ''}`, '', () => { closeMenu(); switcher.focus(); if (s.id !== state.activeId) command('open', { sessionId: s.id }); });
        item.dataset.id = s.id;
        const title = el('span', 'nc-menu-title', s.title || s.preview || 'Untitled chat');
        const meta = el('span', 'nc-menu-meta', `${s.shared ? 'Shared with Hermes Desktop' : sourceLabel(s.source)}${s.running ? ' · replying' : ''}${s.waiting ? ' · needs you' : ''}`);
        if (s.unread) { const dot = el('span', 'nc-unread'); dot.setAttribute('role', 'img'); dot.setAttribute('aria-label', 'Unread'); item.append(dot); }
        item.append(title, meta);
        menu.append(item);
      }
      for (const item of menu.children) { item.setAttribute('role', 'menuitem'); item.tabIndex = -1; }
      // Live updates redraw the menu; keep the keyboard where it was.
      if (focused) [...menu.children].find((item) => (item.dataset.id || 'new') === focused)?.focus();
    }
    const closeMenu = () => { menu.classList.add('hidden'); switcher.setAttribute('aria-expanded', 'false'); };
    switcher.addEventListener('click', () => {
      const open = menu.classList.contains('hidden');
      if (open) renderMenu();
      menu.classList.toggle('hidden', !open);
      switcher.setAttribute('aria-expanded', String(open));
      if (open) (menu.querySelector('.current') || menu.firstChild).focus();
    });
    menu.addEventListener('keydown', (event) => {
      const items = [...menu.children], at = items.indexOf(document.activeElement);
      if (event.key === 'Tab') { closeMenu(); return; }
      const next = items[{ ArrowDown: Math.min(items.length - 1, at + 1), ArrowUp: Math.max(0, at - 1), Home: 0, End: items.length - 1 }[event.key]];
      if (next) { event.preventDefault(); next.focus(); }
    });
    document.addEventListener('pointerdown', (event) => { if (!head.contains(event.target)) closeMenu(); });
    // Escape closes the topmost thing only: the menu, else an open details toggle; never the draft.
    root.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      const details = event.target.closest?.('details[open]');
      if (!menu.classList.contains('hidden')) { closeMenu(); switcher.focus(); }
      else if (details) { details.open = false; details.querySelector('summary')?.focus(); }
      else return;
      event.preventDefault(); event.stopPropagation();
    });

    // The note above the message box: shown when the send will compact first. The switch turns it off for the next message only.
    const idleLabel = (ms) => { const min = Math.floor(ms / 60000); return min >= 120 ? `${Math.floor(min / 60)} h` : `${min} min`; };
    function renderChip() {
      const c = state?.compact;
      const reason = c && !state.run && policy.shouldCompact({ usedTokens: c.usedTokens, windowTokens: c.windowTokens, idleMs: c.idleSince ? Date.now() - c.idleSince : NaN, cacheTtlMs: c.cacheTtlMs });
      chip.classList.toggle('hidden', !reason);
      if (!reason) { compactOff = false; return; }
      const why = reason === 'high' ? `context ${Math.round(c.usedTokens / c.windowTokens * 100)}% full` : `chat idle ${idleLabel(Date.now() - c.idleSince)}`;
      chipText.textContent = compactOff ? `Will not compact this message · ${why}` : `Will compact before sending · ${why}`;
      chipSwitch.textContent = compactOff ? 'Off' : 'On';
      chipSwitch.setAttribute('aria-checked', String(!compactOff));
      chipSwitch.setAttribute('aria-label', 'Compact before sending this message');
    }
    // Idle time passes with nothing pushed from main, so the note re-reads the clock now and then.
    compactTimer = setInterval(() => { if (state?.compact && !disposed) renderChip(); }, 30000);

    function renderNotice() {
      if (notice.dataset.flash) return;
      const s = state, count = thread?.messages.length || 0;
      const text = !s.configured ? ''
        : s.tunnel ? s.tunnel
        : s.status === 'unreachable' ? `Can't reach Hermes${count ? '; showing what was saved here' : ''}.`
          : s.status === 'unauthorized' ? 'Hermes refused the API key; check it in Settings.'
            : s.status === 'error' ? s.error : thread?.notice || '';
      notice.textContent = text;
      notice.classList.toggle('hidden', !text);
    }

    // A short blip stays silent: reconnecting and catching up show after 3 s.
    const LINK_TEXT = { reconnecting: 'Reconnecting…', syncing: 'Catching up…', offline: 'Offline. Messages wait here and send when you are back.', signin: 'Sign in to Hermes again.', refused: 'This Hermes address is not allowed. Messages wait here.' };
    let linkTimer;
    function renderLink() {
      clearTimeout(linkTimer);
      const link = state.link, text = link && LINK_TEXT[link.state];
      const wait = text && ['reconnecting', 'syncing'].includes(link.state) ? link.since + 3000 - Date.now() : 0;
      if (wait > 0) linkTimer = setTimeout(scheduleRender, wait);
      linkBanner.textContent = text || '';
      linkBanner.classList.toggle('hidden', !text || wait > 0);
    }

    const sig = () => `${state.activeId}|${thread?.rev}|${shown}|${JSON.stringify(state.cards || [])}`;
    function render() {
      const s = state;
      root.classList.toggle('unconfigured', !s.configured);
      setup.classList.toggle('hidden', s.configured);
      if (!s.configured) {
        if (!setup.childElementCount) setup.append(el('p', '', 'Add the native chat address and API key in Settings to start.'), button('nc-pill primary', 'Open Settings', onOpenSettings));
        for (const node of [head, middle, composer, readOnly, notice, linkBanner]) node.classList.add('hidden');
        return;
      }
      for (const node of [head, middle]) node.classList.remove('hidden');
      switchTitle.textContent = thread?.title || (s.activeId ? 'Untitled chat' : 'New chat');
      if (!menu.classList.contains('hidden')) renderMenu();
      renderNotice();
      renderLink();
      const count = thread?.messages.length || 0;
      const emptyText = count || s.run || s.cards?.length ? '' : !s.activeId ? 'New conversation. Say hello.'
        : thread?.loading ? 'Loading this conversation…' : s.status === 'unreachable' || s.status === 'unauthorized' ? '' : 'No messages yet. Say hello.';
      empty.textContent = emptyText;
      empty.classList.toggle('hidden', !emptyText);
      const ro = !!thread?.readOnly;
      composer.classList.toggle('hidden', ro);
      readOnly.classList.toggle('hidden', !ro);
      if (ro) {
        const readonlySignature = `${s.activeId}|${sourceLabel(thread.source)}`;
        if (readOnly.dataset.signature !== readonlySignature) {
          readOnly.dataset.signature = readonlySignature;
          readOnly.replaceChildren(el('span', '', `This conversation is from ${sourceLabel(thread.source)}, so it is read-only here.`),
            button('nc-pill primary', 'Continue here', () => command('fork', { sessionId: s.activeId })));
        }
      }
      renderChip();
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
          compactOff = false;
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
        clearInterval(compactTimer);
        follow.disconnect();
        if (typeof unsubscribe === 'function') unsubscribe();
        root.replaceChildren();
      },
    };
  }

  const exported = { create: createView, blocks, parseDirective, renderMarkdown, setupMarkdown, widgetElement };
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  else window.NativeChat = exported;
})();
