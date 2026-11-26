'use strict';
// Unified per-bot chat thread (renderer side): a plain-DOM projection of state
// merged in main. It holds no gateway credentials and sends only through callbacks.
(() => {
  const parts = typeof module !== 'undefined' && module.exports ? require('./chat-parts.js') : window.ChatParts;
  const gatewayList = typeof module !== 'undefined' && module.exports ? require('./gateway-list.js') : window.GatewayList;
  const {
    el, button, createMarkdownView, dayLabel, GAP, CHUNK,
    reconcileChildren, bindComposer, messageBubble,
  } = parts;
  const LANES = gatewayList.GATEWAYS.map((gateway) => gateway.id);
  const labelOf = (lane) => gatewayList.labelOf(lane);
  const LANE_REASON = { signin: 'Signed out', offline: 'Offline', syncing: 'Syncing' };

  function create({
    root,
    md,
    onSend = () => {},
    onSendVia = () => {},
    onRetry = () => {},
    onDelete = () => {},
    onCancel = () => {},
    onCopy = () => {},
    onOpenLink = () => {},
    onOpenHermesDesktop = () => {},
  }) {
    if (!root || !md) throw new Error('unified chat needs {root, md}');
    let state = null, disposed = false;
    let shown = CHUNK, pinned = true, growing = false;
    let nodes = new Map(), threadSig = '', liveSig = '', stateSig = '';
    let seenBot = false, currentBot = '';
    const drafts = new Map();

    root.replaceChildren();
    root.classList.add('uc-root');
    root.setAttribute('aria-label', 'Unified chat');
    const head = el('div', 'nc-head uc-head');
    const title = el('div', 'uc-title');
    head.append(title);
    const laneNotice = el('div', 'nc-conn hidden');
    laneNotice.setAttribute('role', 'status');
    const scroller = el('div', 'nc-scroll');
    scroller.setAttribute('role', 'log');
    scroller.setAttribute('aria-label', 'Messages');
    const list = el('div', 'nc-list'), live = el('div', 'nc-live'), empty = el('div', 'nc-empty hidden');
    scroller.append(empty, list, live);
    const jump = button('nc-jump hidden', 'Jump to latest', () => { pinned = true; toBottom(); jump.classList.add('hidden'); });
    const middle = el('div', 'nc-body');
    middle.append(scroller, jump);
    const sendNote = el('div', 'uc-send-note hidden');
    sendNote.setAttribute('role', 'status');
    const composer = el('form', 'nc-composer uc-composer');
    const textarea = document.createElement('textarea');
    textarea.rows = 1;
    textarea.dir = 'auto';
    textarea.placeholder = 'Message';
    textarea.setAttribute('aria-label', 'Message');
    const viaWrap = el('div', 'uc-via-wrap');
    const viaButton = button('uc-via', '', () => setMenuOpen(viaMenu.classList.contains('hidden'), true));
    viaButton.setAttribute('aria-haspopup', 'menu');
    viaButton.setAttribute('aria-expanded', 'false');
    const viaMenu = el('div', 'menu uc-via-menu hidden');
    viaMenu.setAttribute('role', 'menu');
    viaMenu.setAttribute('aria-label', 'Send via');
    viaWrap.append(viaButton, viaMenu);
    const sendBtn = el('button', 'nc-send');
    sendBtn.type = 'submit';
    sendBtn.title = 'Send';
    sendBtn.setAttribute('aria-label', 'Send');
    sendBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 19V5m0 0-6 6m6-6 6 6"/></svg>';
    composer.append(textarea, viaWrap, sendBtn);
    root.append(head, laneNotice, middle, sendNote, composer);

    const botKey = () => currentBot || 'new';
    const laneState = (lane) => state?.lanes?.[lane] || {};
    const laneEntries = () => LANES
      .filter((lane) => state?.lanes?.[lane] && laneState(lane).health !== 'unavailable')
      .map((lane) => ({ lane, ...laneState(lane) }));
    const sendLane = () => {
      const lane = state?.sendVia || '';
      return lane && laneState(lane).sendable ? lane : '';
    };

    function sendText(text) {
      const lane = sendLane();
      if (!String(text).trim() || !lane) return;
      pinned = true;
      onSend({ lane, text: String(text) });
    }
    const ctx = {
      openLink: (url) => onOpenLink(url),
      copy: (text, node) => {
        onCopy(text);
        if (node) {
          const before = node.textContent;
          node.textContent = 'Copied';
          setTimeout(() => { node.textContent = before; }, 1200);
        }
      },
      send: (text) => sendText(text),
      openHermesDesktop: () => onOpenHermesDesktop(),
    };
    const markdown = createMarkdownView(md, ctx);
    const fillMarkdown = markdown.fillMarkdown;

    root.addEventListener('click', (event) => {
      const link = event.target.closest?.('a[href]');
      if (!link || !root.contains(link)) return;
      event.preventDefault();
      ctx.openLink(link.href);
    });
    root.addEventListener('auxclick', (event) => { if (event.target.closest?.('a[href]')) event.preventDefault(); });

    const composerKeys = bindComposer({
      composer,
      textarea,
      onInput: () => drafts.set(botKey(), textarea.value),
      onEnter: () => composer.requestSubmit(),
      onSubmit: () => {
        const text = textarea.value;
        if (!text.trim() || !sendLane()) return;
        textarea.value = '';
        drafts.delete(botKey());
        grow();
        sendText(text);
      },
    });
    const grow = composerKeys.grow;

    function laneTag(lane, quiet) {
      return el('span', quiet ? 'uc-lane-tag quiet' : 'nc-pill uc-lane-tag', labelOf(lane));
    }
    function rowFor(m, cont) {
      const row = messageBubble({ ...m, id: m.key }, cont, {
        fillMarkdown,
        copy: ctx.copy,
        action: (name, message) => {
          if (name === 'retry') onRetry(message.key);
          else if (name === 'delete') onDelete(message.key);
          else if (name === 'cancel') onCancel(message.key);
        },
        deleteAction: 'delete',
      });
      row.dataset.key = m.key;
      row.dataset.lane = m.lane;
      row.prepend(laneTag(m.lane, cont));
      return row;
    }

    // Newest `shown` messages. Same-lane, same-role continuations keep the
    // origin present but quiet; a lane or role change earns the full pill again.
    function renderThread() {
      const messages = state?.messages || [];
      const start = Math.max(0, messages.length - shown);
      const next = new Map(), wanted = [];
      const use = (key, make) => { const node = nodes.get(key) || make(); next.set(key, node); wanted.push(node); };
      let prev = start > 0 ? messages[start - 1] : null;
      for (let i = start; i < messages.length; i++) {
        const m = messages[i];
        const gap = !prev || m.ts - prev.ts > GAP;
        if (gap && m.ts) use(`t|${m.key}`, () => el('div', 'nc-time', dayLabel(m.ts)));
        const cont = !gap && prev && prev.role === m.role && prev.lane === m.lane && m.ts - prev.ts < 120;
        use(`m|${m.key}|${m.lane}|${m.role}|${m.state || ''}|${m.text.length}|${cont ? 1 : 0}`, () => rowFor(m, cont));
        prev = m;
      }
      nodes = next;
      const anchor = pinned || growing ? null : scrollAnchor();
      reconcileChildren(list, wanted);
      if (anchor) restoreScroll(anchor);
    }

    let streamRow = null, streamBody = null, streamLane = '';
    function renderStreaming() {
      const streaming = state?.streaming;
      if (!streaming) {
        live.replaceChildren();
        streamRow = streamBody = null;
        streamLane = '';
        return;
      }
      const children = [];
      if (streaming.text) {
        if (streamLane !== streaming.lane || !streamRow) {
          streamLane = streaming.lane;
          streamRow = el('div', 'nc-row assistant streaming');
          streamRow.dataset.lane = streaming.lane;
          streamBody = el('div', 'nc-bubble');
          streamRow.append(laneTag(streaming.lane, false), streamBody);
        }
        fillMarkdown(streamBody, streaming.text, true);
        children.push(streamRow);
      } else {
        const line = el('div', 'nc-status');
        line.append(el('span', 'nc-dots'), document.createTextNode('Thinking'));
        children.push(line);
      }
      live.replaceChildren(...children);
    }

    const toBottom = () => { scroller.scrollTop = scroller.scrollHeight; };
    const offsetOf = (node) => node.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    const scrollAnchor = () => {
      const row = [...list.children].find((node) => node.dataset.key && offsetOf(node) + node.offsetHeight > scroller.scrollTop);
      return { key: row?.dataset.key || '', delta: row ? scroller.scrollTop - offsetOf(row) : 0, top: scroller.scrollTop };
    };
    const restoreScroll = (anchor) => {
      const row = anchor.key && [...list.children].find((node) => node.dataset.key === anchor.key);
      scroller.scrollTop = row ? offsetOf(row) + anchor.delta : anchor.top;
    };
    let follow = { observe: () => {}, disconnect: () => {} };
    if (typeof ResizeObserver === 'function') {
      follow = new ResizeObserver(() => { if (pinned) toBottom(); });
      for (const node of [scroller, list, live]) follow.observe(node);
    }
    scroller.addEventListener('scroll', () => {
      pinned = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
      if (pinned) jump.classList.add('hidden');
      if (scroller.scrollTop < 800 && !growing) growOlder();
    }, { passive: true });
    function messagesSignature() {
      return JSON.stringify([shown, (state?.messages || []).map((m) => [m.key, m.lane, m.role, m.text, m.ts, m.state || ''])]);
    }
    function growOlder() {
      const total = state?.messages?.length || 0;
      if (shown >= total) return;
      growing = true;
      const fromBottom = scroller.scrollHeight - scroller.scrollTop;
      shown = Math.min(total, shown + CHUNK);
      renderThread();
      threadSig = messagesSignature();
      scroller.scrollTop = scroller.scrollHeight - fromBottom;
      growing = false;
    }

    const closeMenu = () => {
      viaMenu.classList.add('hidden');
      viaButton.setAttribute('aria-expanded', 'false');
    };
    function enabledItems() {
      return [...viaMenu.children].filter((item) => !item.disabled);
    }
    function focusMenuItem(which) {
      const items = enabledItems();
      const item = which === 'last' ? items.at(-1) : items.find((entry) => entry.getAttribute('aria-checked') === 'true') || items[0];
      item?.focus();
    }
    function setMenuOpen(open, focus = false) {
      if (open && !laneEntries().length) open = false;
      viaMenu.classList.toggle('hidden', !open);
      viaButton.setAttribute('aria-expanded', String(open));
      if (open) {
        renderPicker();
        if (focus) focusMenuItem('first');
      }
    }
    function chooseLane(lane) {
      if (!laneState(lane).sendable) return;
      closeMenu();
      viaButton.focus();
      onSendVia(lane);
    }
    function renderPicker() {
      const entries = laneEntries();
      const signature = JSON.stringify([state?.sendVia || '', entries.map((entry) => [entry.lane, entry.health, !!entry.sendable])]);
      if (viaMenu.dataset.signature === signature && viaMenu.childElementCount) return;
      viaMenu.dataset.signature = signature;
      const focused = viaMenu.contains(document.activeElement) ? document.activeElement.dataset.lane : '';
      viaMenu.replaceChildren();
      for (const entry of entries) {
        const item = button('menu-item uc-via-item', '', () => chooseLane(entry.lane));
        item.dataset.lane = entry.lane;
        item.tabIndex = -1;
        item.disabled = !entry.sendable;
        item.setAttribute('role', 'menuitemradio');
        item.setAttribute('aria-checked', String(entry.lane === state?.sendVia));
        const label = el('span', 'uc-via-label', labelOf(entry.lane));
        const check = el('span', 'uc-via-check', '✓');
        check.setAttribute('aria-hidden', 'true');
        item.append(label);
        if (!entry.sendable) {
          const reason = LANE_REASON[entry.health] || 'Not available';
          item.append(el('span', 'uc-via-reason', reason));
          item.setAttribute('aria-label', `${labelOf(entry.lane)}, ${reason}`);
        }
        item.append(check);
        viaMenu.append(item);
      }
      if (focused) [...viaMenu.children].find((item) => item.dataset.lane === focused && !item.disabled)?.focus();
    }
    viaButton.addEventListener('keydown', (event) => {
      if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
      event.preventDefault();
      setMenuOpen(true, false);
      focusMenuItem(event.key === 'ArrowUp' ? 'last' : 'first');
    });
    viaMenu.addEventListener('keydown', (event) => {
      const items = enabledItems(), at = items.indexOf(document.activeElement);
      if (event.key === 'Tab') { closeMenu(); return; }
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMenu();
        viaButton.focus();
        return;
      }
      const next = items[{ ArrowDown: Math.min(items.length - 1, at + 1), ArrowUp: Math.max(0, at - 1), Home: 0, End: items.length - 1 }[event.key]];
      if (next) { event.preventDefault(); next.focus(); }
    });
    const outside = (event) => { if (!viaWrap.contains(event.target)) closeMenu(); };
    document.addEventListener('pointerdown', outside);
    root.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || viaMenu.classList.contains('hidden')) return;
      event.preventDefault();
      event.stopPropagation();
      closeMenu();
      viaButton.focus();
    });

    function renderLaneNotice() {
      const notes = [];
      for (const lane of LANES) {
        const health = laneState(lane).health;
        if (health === 'offline') notes.push(`${labelOf(lane)} is offline.`);
        if (health === 'signin') notes.push(`${labelOf(lane)} is signed out.`);
      }
      laneNotice.textContent = notes.join(' ');
      laneNotice.classList.toggle('hidden', !notes.length);
    }
    function noSendReason() {
      const entries = laneEntries();
      if (!entries.length) return 'No gateway can send right now.';
      const healths = new Set(entries.map((entry) => entry.health));
      if (healths.size === 1 && healths.has('signin')) return 'Sign in to send.';
      if (healths.size === 1 && healths.has('offline')) return 'You are offline.';
      if (healths.size === 1 && healths.has('syncing')) return 'Still syncing. Try again in a moment.';
      return 'No gateway can send right now.';
    }
    function renderComposer() {
      const lane = sendLane();
      textarea.disabled = !lane;
      sendBtn.disabled = !lane;
      sendNote.textContent = lane ? '' : noSendReason();
      sendNote.classList.toggle('hidden', !!lane);
      const entries = laneEntries();
      viaButton.disabled = !entries.length;
      viaButton.textContent = state?.sendVia ? `via ${labelOf(state.sendVia)}` : 'Send via';
      renderPicker();
    }

    function render() {
      if (!state) return;
      title.textContent = state.botName || 'Chat';
      root.setAttribute('aria-label', `${state.botName || 'Bot'} unified chat`);
      renderLaneNotice();
      renderComposer();
      const count = state.messages?.length || 0;
      const emptyText = count || state.streaming ? '' : 'No messages yet. Say hello.';
      empty.textContent = emptyText;
      empty.classList.toggle('hidden', !emptyText);
      const key = messagesSignature();
      if (key !== threadSig) { threadSig = key; renderThread(); }
      const liveKey = JSON.stringify(state.streaming || null);
      if (liveKey !== liveSig) { liveSig = liveKey; renderStreaming(); }
      if (pinned) toBottom();
      else jump.classList.remove('hidden');
    }

    function stateSignature(next) {
      return JSON.stringify({
        botId: next.botId || '',
        botName: next.botName || '',
        messages: (next.messages || []).map((m) => [m.key, m.lane, m.sessionId, m.rowId, m.role, m.text, m.ts, m.state || '']),
        lanes: LANES.map((lane) => [lane, next.lanes?.[lane]?.health || '', next.lanes?.[lane]?.sendable === true]),
        sendVia: next.sendVia || '',
        streaming: next.streaming ? [next.streaming.lane || '', next.streaming.text || ''] : null,
      });
    }
    function resetForBot(key) {
      shown = CHUNK;
      pinned = true;
      nodes = new Map();
      list.replaceChildren();
      threadSig = liveSig = '';
      streamRow = streamBody = null;
      streamLane = '';
      textarea.value = drafts.get(key) || '';
      grow();
    }
    function setState(next) {
      if (disposed || !next) return;
      const key = next.botId || '';
      if (!seenBot || key !== currentBot) {
        currentBot = key;
        seenBot = true;
        resetForBot(botKey());
      }
      const signature = stateSignature(next);
      if (signature === stateSig) return;
      stateSig = signature;
      state = next;
      render();
    }

    return {
      setState,
      dispose() {
        if (disposed) return;
        disposed = true;
        document.removeEventListener('pointerdown', outside);
        follow.disconnect();
        root.replaceChildren();
        root.classList.remove('uc-root');
      },
    };
  }

  const exported = { create };
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  else window.UnifiedChat = exported;
})();
