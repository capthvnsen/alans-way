'use strict';
// Native Hermes conversation surface (renderer side).
//
// A thin, DOM-only projection of the main-process hub state. Holds no sockets,
// credentials, or RPC access — it renders `window.hermes` state and dispatches
// the allowlisted commands. Every control captures the session id + hub
// generation it was rendered against and re-checks both on click, so a control
// that survived a switch/reconnect cannot answer a stale request.
//
// Drafts are view-owned per session target and cleared only by this view's
// own send acknowledgement: hub 'send' resolves only after the controller's
// prompt.submit succeeds (an admission), and rejects on rejected, uncertain
// or stale outcomes. Each in-flight send holds exactly one pending record —
// the session key it was dispatched to, the submitted text, and the draft's
// edit revision at dispatch — released when the command settles. The clear
// spends that record once: the draft must still hold the submitted text at
// the same revision, so edits or an identical retype during the flight
// survive, replays and foreign admissions never consult it, other views
// cannot spend it, and nothing per-send is retained after settle.
//
// Last-known context: a dropped socket makes the hub dispose every
// controller, so `conversation` goes null while `selected` survives. The
// view keeps ONE retained copy of the freshest live conversation it was
// shown, fenced to the exact {target url, profile, sessionId, sessionKey}
// it came from. It renders only while that same session is still selected
// and nothing live has replaced it — visibly stale, never interactive, and
// dropped on an explicit target change or view dispose. It is display-only:
// no send/answer path ever consults it, and reconnect alone never resends.
(() => {
  const $ = (root, sel) => root.querySelector(sel);
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  const PHASE_TEXT = {
    detached: 'Not attached', binding: 'Attaching…', bound: '',
    review: 'Review loaded history before continuing', blocked: 'Session blocked by the backend',
    disconnected: 'Connection lost', disposed: 'Detached',
  };
  const SEND_STATUS = {
    sending: 'Sending…', admitted: '', rejected: 'Not sent', uncertain: 'Delivery unconfirmed',
    complete: '', interrupted: 'Stopped', incomplete: 'Incomplete', error: 'Error',
  };

  // Electron invoke serializes exceptions into a message with IPC/class
  // wrappers. Both the pane and conversation surface show the useful cause.
  function commandErrorMessage(error) {
    let message = String(error?.message || error);
    message = message.replace(/^Error invoking remote method ['"]hermes:command['"]:\s*/, '')
      .replace(/^(?:RemoteError|HubError|ConversationError|WireError|Error):\s*/, '');
    if (/^POST \/auth\/password-login: Invalid credentials\.?$/i.test(message)) return 'Wrong username or password.';
    return message;
  }

  function createHermesView({ api, root, onShowSetup }) {
    if (!api || !root) throw new Error('hermes view needs {api, root}');
    const drafts = new Map();          // exact target key -> {text, rev}; rev = this view's edit revision
    const answers = new Map();         // exact target + request id -> {qid -> text} (in-progress form state)
    let draftSeq = 0;                  // monotonic per-view revision counter
    let state = null;                  // last hub projection
    let retainedView = null;           // {targetKey, key, title, convo} — last live conversation
    let pinnedToBottom = true;
    let composing = false;             // IME composition guard
    let lastSig = '';
    let disposed = false;
    let focusMemory = null;
    const focusTargets = new Map();

    root.innerHTML = '';
    const bar = el('div', 'hermes-bar');
    bar.setAttribute('role', 'status');
    bar.setAttribute('aria-live', 'polite');
    bar.setAttribute('tabindex', '-1');
    const transcript = el('div', 'hermes-transcript');
    transcript.setAttribute('role', 'log');
    transcript.setAttribute('aria-live', 'polite');
    const requestsDock = el('div', 'hermes-requests');
    requestsDock.setAttribute('role', 'region');
    requestsDock.setAttribute('aria-label', 'Hermes requests');
    requestsDock.setAttribute('aria-live', 'polite');
    const composer = el('form', 'hermes-composer');
    const textarea = document.createElement('textarea');
    textarea.setAttribute('rows', '2');
    textarea.setAttribute('placeholder', 'Message Hermes…');
    textarea.setAttribute('aria-label', 'Message Hermes');
    const sendBtn = el('button', 'hermes-send primary-button', 'Send');
    sendBtn.type = 'submit';
    const stopBtn = el('button', 'hermes-stop secondary-button', 'Stop');
    stopBtn.type = 'button';
    const sendWarn = el('div', 'hermes-send-warn hidden');
    sendWarn.setAttribute('role', 'status');
    sendWarn.setAttribute('aria-live', 'polite');
    composer.append(textarea, sendWarn, el('div', 'hermes-composer-actions'));
    composer.lastChild.append(stopBtn, sendBtn);
    root.append(bar, transcript, requestsDock, composer);

    transcript.addEventListener('scroll', () => {
      const gap = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight;
      pinnedToBottom = gap < 40;
    });
    const stick = () => { if (pinnedToBottom) transcript.scrollTop = transcript.scrollHeight; };

    const retainedKey = (t, sel) => t && sel
      ? JSON.stringify([t.url, t.profile, sel.sessionId, sel.sessionKey]) : '';
    const sessionKey = () => retainedKey(state?.target, state?.selected);
    const answerKey = req => JSON.stringify([sessionKey(), typeof req.id, req.id]);
    const trackFocus = (node, key) => {
      node.dataset.hermesFocus = key;
      focusTargets.set(key, node);
      return node;
    };
    const requestFocus = (node, req, part) => trackFocus(node, JSON.stringify([answerKey(req), req.method, req.params, part]));
    const draft = () => drafts.get(sessionKey())?.text || '';
    // Re-asserting the same text without an edit gesture is not an edit — a
    // programmatic or send-time re-assert keeps the draft on the revision the
    // pending send was dispatched under. A real `input` event is always an
    // edit: even an atomic replacement that lands on the identical string
    // spends a fresh revision, so the in-flight send's ack cannot mistake the
    // re-entered draft for the text it submitted.
    const setDraft = (v, edit) => {
      const k = sessionKey();
      if (!k) return;
      const cur = drafts.get(k);
      if (cur && cur.text === v && !edit) return;
      drafts.set(k, { text: v, rev: ++draftSeq });
    };

    // The retained transcript only ever belongs to one exact identity —
    // backend URL + profile + session id + session key. Anything less could
    // resurrect a different target's context as current.
    // Retained is display-only: it renders only while the SAME session is
    // still selected and no live conversation has replaced it. A generation
    // bump is exactly the disconnect being survived, so it cannot fence here.
    const retained = () => {
      if (!retainedView || state?.conversation || !state?.selected) return null;
      return retainedView.key === retainedKey(state.target, state.selected) ? retainedView : null;
    };
    // The pane keeps a selected conversation's recovery surface instead of
    // the setup card exactly while the socket is down with an established
    // selection: lost link, retry in flight, or reconnecting now.
    const recoverySurface = () => !state?.conversation && !!state?.selected
      && (state.status === 'error' || state.status === 'disconnected' || state.status === 'connecting');

    const stopUnavailable = () => !!state?.selected
      && (!state.conversation || !['bound', 'review'].includes(state.conversation.phase));

    textarea.addEventListener('input', () => setDraft(textarea.value, true));
    textarea.addEventListener('compositionstart', () => { composing = true; });
    textarea.addEventListener('compositionend', () => { composing = false; });
    composer.addEventListener('submit', (event) => {
      event.preventDefault();
      send();
    });
    textarea.addEventListener('keydown', (event) => {
      // Enter sends; Shift+Enter inserts a newline. Never mid-IME-composition.
      if (event.key === 'Enter' && !event.shiftKey && !composing && !event.isComposing) {
        event.preventDefault();
        send();
      }
    });
    stopBtn.addEventListener('click', () => {
      const sel = state?.selected;
      if (sel && !stopBtn.disabled) api.command('stop', { sessionId: sel.sessionId, generation: state.generation }).catch(showError);
    });

    async function send() {
      const text = textarea.value;
      // The composer disabled flag IS the usability fence: a dropped socket
      // or an unbound phase means no send can be dispatched at all.
      if (!text.trim() || !state?.selected || textarea.disabled) return;
      setDraft(text);
      const captured = { sessionId: state.selected.sessionId, generation: state.generation };
      await dispatchSend(captured, text);
    }

    // One locally initiated send = one pending record, held only by this
    // closure and released when the command settles. Resolution of 'send' is
    // itself the admission acknowledgement (the hub resolves it only after
    // prompt.submit succeeds; rejected, uncertain and stale sends all reject),
    // so no lastSend identity ever needs matching and no send history is kept.
    // The clear fires once, only while the draft recorded for that session is
    // still exactly the submitted text at the revision it was dispatched
    // under: a different edit survives on text alone, an identical retype
    // survives on revision, and a send this view never issued can never reach
    // this path. A disposed view ignores the late settlement entirely.
    async function dispatchSend(captured, text) {
      const sendKey = sessionKey();
      const rev = drafts.get(sendKey)?.rev;
      try {
        await api.command('send', { ...captured, text });
      } catch (e) {
        if (!disposed) showError(e);
        return;
      }
      if (disposed || !sendKey) return;
      const cur = drafts.get(sendKey);
      if (cur && cur.text === text && cur.rev === rev) {
        drafts.set(sendKey, { text: '', rev: cur.rev });
        if (sendKey === sessionKey() && textarea.value === text) textarea.value = '';
      }
    }

    function showError(e) {
      const row = el('div', 'hermes-flash', commandErrorMessage(e));
      bar.append(row);
      setTimeout(() => row.remove(), 6000);
    }

    // Guard every request control: the click is only honored when the session
    // + generation + pending request it was rendered for are all still live.
    function guard(requestId, fn) {
      const captured = { sessionId: state?.selected?.sessionId, generation: state?.generation };
      const key = sessionKey();
      const signature = JSON.stringify(state?.conversation?.pendingRequests?.find(r => r.id === requestId));
      return () => {
        if (disposed || sessionKey() !== key || state?.generation !== captured.generation
            || state?.conversation?.phase !== 'bound') return;
        const still = state.conversation.pendingRequests.find(r => r.id === requestId);
        if (!still || still.answerable === false || JSON.stringify(still) !== signature) { render(); return; }
        fn(captured);
      };
    }

    function renderBar() {
      bar.innerHTML = '';
      const t = state.target;
      bar.append(el('span', 'hermes-target',
        t ? `${t.label}${t.profile ? ` · ${t.profile}` : ''}` : 'No backend configured'));
      if (state.principal) bar.append(el('span', 'hermes-principal', `signed in as ${state.principal.userId}`));
      const convo = state.conversation;
      if (convo) {
        const phase = PHASE_TEXT[convo.phase] || convo.phase;
        if (phase) bar.append(el('span', `hermes-phase ${convo.phase}`, phase));
        if (convo.truncated?.replay) bar.append(el('span', 'hermes-phase review', 'Some earlier events are unavailable.'));
        if (convo.stats?.eventGaps > 0) {
          bar.append(el('span', 'hermes-phase review', `${convo.stats.eventGaps} event(s) missing — transcript may be incomplete`));
        }
        const error = convo.errors?.at(-1);
        if (error) bar.append(el('span', 'hermes-phase review', error.message));
        if (convo.phase === 'review') {
          const captured = { sessionId: state.selected?.sessionId, generation: state.generation };
          const acknowledge = trackFocus(el('button', 'secondary-button', 'Continue after review'), 'acknowledge-review');
          acknowledge.type = 'button';
          acknowledge.onclick = () => api.command('acknowledge-review', captured).catch(showError);
          bar.append(acknowledge);
        }
        if (convo.statusLine?.text) bar.append(el('span', 'hermes-statusline', convo.statusLine.text));
      }
      // Exactly one scoped recovery action: a live error wins the slot, a
      // retry in flight becomes a passive chip, and a clean disconnect gets
      // Connect — never Connect and Reconnect side by side.
      const recover = (label) => {
        const b = trackFocus(el('button', 'secondary-button hermes-retry', label), 'reconnect');
        b.type = 'button';
        b.onclick = () => api.command('connect', {}).catch(showError);
        return b;
      };
      if (state.error) {
        bar.append(el('span', 'hermes-phase disconnected', `${state.error.code}: ${state.error.message}`));
        bar.append(recover('Reconnect'));
      } else if (convo && ['review', 'blocked', 'disconnected'].includes(convo.phase)) {
        bar.append(recover('Reconnect'));
      } else if (state.status === 'connecting') {
        bar.append(el('span', 'hermes-phase connecting', 'Reconnecting…'));
      } else if (state.status === 'disconnected' && t) {
        bar.append(recover('Connect'));
      }
      if (stopUnavailable()) bar.append(el('span', 'hermes-phase disconnected',
        'Work may still be running. Stop cannot be sent until this conversation is connected.'));
      // Keep backend setup reachable in the connected conversation too.
      if ((state.status === 'ready' || recoverySurface()) && typeof onShowSetup === 'function') {
        const change = el('button', 'link-button hermes-change-backend', 'Change backend');
        change.type = 'button';
        change.onclick = () => onShowSetup();
        bar.append(change);
      }
      if (state.status === 'ready') {
        const refresh = trackFocus(el('button', 'link-button', 'Refresh conversations'), 'refresh-conversations');
        refresh.type = 'button';
        refresh.onclick = () => api.command('refresh-sessions', {}).catch(showError);
        bar.append(refresh);
      }
    }

    function renderTranscript() {
      transcript.innerHTML = '';
      // Live conversation first; otherwise the retained last-known transcript
      // of the still-selected session — rendered visibly stale, never as live.
      const convo = state.conversation;
      const stale = !convo && retained();
      const shown = convo || stale?.convo;
      transcript.classList.toggle('stale', !!stale);
      if (!shown) {
        const emptyReady = state.storedSessionsError
          ? `No live conversation is selected. ${state.storedSessionsError}`
          : state.storedSessions?.length ? 'Resume a saved conversation from the sidebar, or start a new session.'
            : state.sessions?.length ? 'Select a live conversation to start.'
              : 'No live or saved conversations on this backend. Use New Hermes session to start.';
        transcript.append(el('div', 'hermes-empty',
          state.status === 'ready' ? emptyReady
            : state.selected ? 'Connection lost — reconnect to load this conversation.' : ''));
        return;
      }
      if (stale) {
        transcript.append(el('div', 'hermes-note hermes-stale-note',
          `${state.status === 'connecting' ? 'Reconnecting' : 'Connection lost'} — last known transcript${stale.title ? ` of “${stale.title}”` : ''}; it may have moved on.`));
      }
      if (shown.transcriptDropped > 0) {
        transcript.append(el('div', 'hermes-note',
          `${shown.transcriptDropped} older entr${shown.transcriptDropped === 1 ? 'y' : 'ies'} not shown.`));
      }
      for (const row of shown.transcript) {
        const item = el('div', `hermes-msg ${row.role || 'system'}${row.status === 'sending' ? ' sending' : ''}`);
        item.append(renderText(row.text ?? '', row.role === 'assistant'));
        if (row.reasoning) {
          const think = el('details', 'hermes-reasoning');
          think.append(el('summary', '', 'Reasoning'), renderText(row.reasoning, false));
          item.append(think);
        }
        for (const tool of row.tools || []) {
          item.append(el('div', `hermes-tool ${tool.status}`,
            `${tool.name || 'tool'} · ${tool.status}${tool.summary ? ` — ${tool.summary}` : ''}`));
        }
        const badge = SEND_STATUS[row.status];
        if (badge || row.error) {
          const meta = el('div', 'hermes-msg-meta');
          if (badge) meta.append(el('span', 'hermes-badge', badge));
          if (row.error) meta.append(el('span', 'hermes-badge error', String(row.error.message || row.error.code || row.error)));
          // A retained row's retry would be a dead control — its generation
          // fence can never pass once the socket is gone. Live rows only.
          if (row.status === 'uncertain' && !stale) {
            const retry = el('button', 'secondary-button hermes-inline-retry', 'Retry send');
            retry.type = 'button';
            const text = row.text;
            const captured = { sessionId: state.selected?.sessionId, generation: state.generation };
            retry.onclick = () => {
              if (state?.selected?.sessionId !== captured.sessionId || state?.generation !== captured.generation) return;
              // An explicit resend of the exact tombstone text is this view's
              // own send — its ack clears the preserved draft like any other.
              dispatchSend(captured, text);
            };
            meta.append(retry);
          }
          item.append(meta);
        }
        transcript.append(item);
      }
      if (shown.turn) {
        // A retained turn is frozen text — never painted as live streaming.
        const live = el('div', `hermes-msg assistant${stale ? '' : ' streaming'}`);
        live.append(renderText(shown.turn.text || '…', true));
        for (const tool of shown.turn.tools || []) {
          live.append(el('div', `hermes-tool ${tool.status}`, `${tool.name || 'tool'} · ${tool.status}`));
        }
        transcript.append(live);
      }
      stick();
    }

    // Minimal safe rendering: fenced code blocks and inline `code` get
    // structure; everything else stays literal textContent — markup-looking
    // text is never interpreted.
    function renderText(text, allowMd) {
      const frag = document.createDocumentFragment();
      if (!allowMd || !text.includes('```')) {
        frag.append(el('div', 'hermes-text', text));
        return frag;
      }
      const parts = text.split(/```(\w*)\n?/);
      for (let i = 0; i < parts.length; i++) {
        if (i % 2 === 0) { if (parts[i]) frag.append(el('div', 'hermes-text', parts[i])); }
        else {
          const code = parts[i + 1] ?? '';
          frag.append(el('pre', 'hermes-code', code.replace(/\n?```$/, '')));
          i++;
        }
      }
      return frag;
    }

    function renderRequests() {
      requestsDock.innerHTML = '';
      const tomb = state.uncertain;
      if (tomb && tomb.sessionId === state.selected?.sessionId) {
        const card = el('div', 'hermes-card uncertain');
        card.append(
          el('div', 'hermes-card-head', 'Delivery unconfirmed'),
          el('div', 'hermes-card-body',
            `The connection was lost before the backend acknowledged this message to ${tomb.sessionId}. It was not resent automatically.`),
          el('div', 'hermes-uncertain-text', String(tomb.text || '')),
        );
        const actions = el('div', 'hermes-card-actions');
        const dismiss = el('button', 'secondary-button', 'Dismiss after review');
        dismiss.type = 'button';
        dismiss.addEventListener('click', () => {
          api.command('uncertain-dismiss', { sessionId: tomb.sessionId, generation: state.generation }).catch(showError);
        });
        actions.append(dismiss);
        card.append(actions);
        requestsDock.append(card);
      }
      const convo = state.conversation;
      if (!convo) return;
      for (const req of convo.pendingRequests) {
        requestsDock.append(requestCard(req));
      }
      for (const out of (convo.requestOutcomes || []).slice(-5)) {
        requestsDock.append(el('div', `hermes-request-outcome ${out.outcome}`,
          `${out.method} — ${out.outcome}`));
      }
    }

    function requestCard(req) {
      const card = el('div', `hermes-card ${req.method.replace(/[^\w.-]/g, '')}`);
      const head = el('div', 'hermes-card-head');
      head.append(el('span', 'hermes-card-kind', req.method),
        el('span', 'hermes-card-id', `#${String(req.id).slice(0, 40)}`));
      card.append(head);
      if (req.answerable === false || state.conversation?.phase !== 'bound') {
        const description = req.params?.description || req.params?.prompt;
        if (description) card.append(el('div', 'hermes-card-body', description));
        if (req.params?.command) card.append(el('pre', 'hermes-code', req.params.command));
        for (const question of (Array.isArray(req.params?.questions) ? req.params.questions : [])) {
          if (question?.question) card.append(el('div', 'hermes-question-text', question.question));
        }
      }
      if (req.answerable === false) {
        card.append(el('div', 'hermes-card-body', 'Recovered request: not answerable on this connection. Reconnect or answer it where it was raised.'));
        return card;
      }
      if (state.conversation?.phase !== 'bound') {
        card.append(el('div', 'hermes-card-body', 'Review the conversation or reconnect before answering.'));
        return card;
      }
      if (!req.attributed) {
        card.append(el('div', 'hermes-card-body', 'This request arrived without a session identity and cannot be answered safely.'));
        card.append(refuseRow(req, 'Dismiss'));
        return card;
      }
      if (req.method === 'clarify') clarifyBody(card, req);
      else if (req.method === 'approval') approvalBody(card, req);
      else if (!req.supported) unsupportedBody(card, req);
      else valueBody(card, req);
      return card;
    }

    function clarifyBody(card, req) {
      const key = answerKey(req);
      const body = el('div', 'hermes-card-body');
      const held = answers.get(key) || {};
      const questions = Array.isArray(req.params?.questions) ? req.params.questions : [];
      for (const q of questions) {
        if (!q || typeof q.qid !== 'string') continue;
        const wrap = el('div', 'hermes-question');
        wrap.append(el('div', 'hermes-question-text', q.question || q.qid));
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'hermes-answer-input';
        input.placeholder = 'Your answer';
        input.value = held[q.qid] || '';
        input.dataset.qid = q.qid;
        input.setAttribute('aria-label', q.question || q.qid);
        requestFocus(input, req, q.qid);
        input.addEventListener('input', () => {
          const cur = answers.get(key) || {};
          cur[q.qid] = input.value;
          answers.set(key, cur);
        });
        wrap.append(input);
        for (const choice of (Array.isArray(q.choices) ? q.choices : [])) {
          const chip = el('button', 'hermes-choice', choice);
          chip.type = 'button';
          requestFocus(chip, req, JSON.stringify([q.qid, choice]));
          chip.onclick = guard(req.id, () => { input.value = String(choice); input.dispatchEvent(new Event('input')); });
          wrap.append(chip);
        }
        body.append(wrap);
      }
      card.append(body);
      const row = el('div', 'hermes-card-actions');
      const sendA = el('button', 'primary-button', 'Send answers');
      sendA.type = 'button';
      requestFocus(sendA, req, 'send-answers');
      sendA.onclick = guard(req.id, captured => {
        const heldNow = answers.get(key) || {};
        const result = {};
        for (const q of questions) if (typeof q.qid === 'string') result[q.qid] = heldNow[q.qid] ?? null;
        answers.delete(key);
        api.command('answer-request', { requestId: req.id, sessionId: req.sessionId, generation: captured.generation, result: { answers: result } }).catch(showError);
      });
      const skip = el('button', 'secondary-button', 'Skip all');
      skip.type = 'button';
      requestFocus(skip, req, 'skip');
      skip.onclick = guard(req.id, captured => {
        answers.delete(key);
        api.command('answer-request', { requestId: req.id, sessionId: req.sessionId, generation: captured.generation, result: { answers: null } }).catch(showError);
      });
      row.append(skip, sendA);
      card.append(row, refuseRow(req));
    }

    function approvalBody(card, req) {
      const body = el('div', 'hermes-card-body');
      if (req.params?.description) body.append(el('div', 'hermes-question-text', req.params.description));
      if (req.params?.command) body.append(el('pre', 'hermes-code', String(req.params.command)));
      card.append(body);
      const row = el('div', 'hermes-card-actions');
      const offered = Array.isArray(req.params?.choices) && req.params.choices.length
        ? req.params.choices : ['deny', 'once', 'session', 'always'];
      for (const choice of ['deny', 'once', 'session', 'always']) {
        if (!offered.includes(choice)) continue;
        const b = el('button', choice === 'deny' ? 'secondary-button' : 'primary-button',
          { deny: 'Deny', once: 'Allow once', session: 'Allow this session', always: 'Always allow' }[choice]);
        b.type = 'button';
        requestFocus(b, req, choice);
        // Deliberate one-time decision: no default selection, never a silent
        // permanent grant — 'always' is just another explicit click.
        b.onclick = guard(req.id, captured => api.command('answer-request',
          { requestId: req.id, sessionId: req.sessionId, generation: captured.generation, result: { choice } }).catch(showError));
        row.append(b);
      }
      card.append(row, refuseRow(req));
    }

    function valueBody(card, req) {
      const key = answerKey(req);
      const body = el('div', 'hermes-card-body');
      const label = req.params?.prompt || req.params?.description || `${req.method} is asking for a value.`;
      body.append(el('div', 'hermes-question-text', label));
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'hermes-answer-input';
      input.value = (answers.get(key) || {}).value || '';
      input.setAttribute('aria-label', label);
      requestFocus(input, req, 'value');
      input.addEventListener('input', () => answers.set(key, { value: input.value }));
      body.append(input);
      card.append(body);
      const row = el('div', 'hermes-card-actions');
      const sendV = el('button', 'primary-button', 'Send');
      sendV.type = 'button';
      requestFocus(sendV, req, 'send-value');
      sendV.onclick = guard(req.id, captured => {
        const v = (answers.get(key) || {}).value || '';
        answers.delete(key);
        api.command('answer-request', { requestId: req.id, sessionId: req.sessionId, generation: captured.generation, result: { value: v } }).catch(showError);
      });
      const decline = el('button', 'secondary-button', 'Decline');
      decline.type = 'button';
      requestFocus(decline, req, 'decline');
      decline.onclick = guard(req.id, captured => {
        answers.delete(key);
        api.command('answer-request', { requestId: req.id, sessionId: req.sessionId, generation: captured.generation, result: { value: '' } }).catch(showError);
      });
      row.append(decline, sendV);
      card.append(row, refuseRow(req));
    }

    function unsupportedBody(card, req) {
      card.append(el('div', 'hermes-card-body',
        `This ${req.method} request is not supported by this app. It stays pending here until the backend withdraws it — answer it where it was raised, or decline it.`));
      card.append(refuseRow(req, 'Decline'));
    }

    function refuseRow(req, label = 'Refuse') {
      const row = el('div', 'hermes-card-actions hermes-refuse-row');
      const b = el('button', 'link-button hermes-refuse', label);
      b.type = 'button';
      requestFocus(b, req, 'refuse');
      b.onclick = guard(req.id, captured => api.command('refuse-request',
        { requestId: req.id, sessionId: req.sessionId, generation: captured.generation, message: `declined in companion app` }).catch(showError));
      row.append(b);
      return row;
    }

    let lastDraftTarget = null;
    function renderComposer() {
      const sel = state.selected;
      const convo = state.conversation;
      const shown = convo || retained()?.convo;
      // Only a LIVE bound conversation may send or answer — a retained
      // transcript keeps the draft visible and the composer firmly disabled.
      const usable = !!sel && convo && convo.phase === 'bound';
      textarea.disabled = !usable;
      sendBtn.disabled = !usable;
      const streaming = !!convo?.turn?.streaming;
      const canStop = streaming && ['bound', 'review'].includes(convo.phase);
      stopBtn.disabled = !canStop;
      stopBtn.classList.toggle('hidden', !(streaming || stopUnavailable()));
      stopBtn.textContent = !canStop && stopUnavailable() ? 'Stop unavailable' : 'Stop';
      // A selection or connection-generation change always reloads the draft —
      // the focused-typing guard must not pin the previous target's text onto
      // the new session.
      const target = `${state?.generation ?? ''}|${sessionKey()}`;
      if (target !== lastDraftTarget) {
        lastDraftTarget = target;
        const d = draft();
        if (textarea.value !== d) textarea.value = d;
      } else if (document.activeElement !== textarea) {
        const d = draft();
        if (textarea.value !== d) textarea.value = d;
      }
      // A rejected or delivery-unconfirmed send keeps its text in the editor
      // and gets a durable warning — never a flash, never an auto-replay.
      // The retained conversation's lastSend still warns: the outcome was
      // real when the socket dropped.
      const ls = shown && shown.lastSend;
      const failed = ls && (ls.outcome === 'rejected' || ls.outcome === 'uncertain')
        && ls.target?.sessionId === sel?.sessionId;
      sendWarn.classList.toggle('hidden', !failed);
      if (failed) {
        sendWarn.textContent = ls.outcome === 'rejected'
          ? 'Send failed — your message is preserved in the editor; it was not resent.'
          : 'Delivery unconfirmed — your message is preserved in the editor; check the result before resending.';
      }
    }

    function render() {
      if (!state) return;
      const active = document.activeElement;
      const owned = root.contains(active);
      if (focusMemory && (focusMemory.session !== sessionKey()
          || (active && active !== document.body && active !== focusMemory.node && !owned))) focusMemory = null;
      if (owned && (!focusMemory || active !== focusMemory.node)) {
        focusMemory = { session: sessionKey(), key: active.dataset.hermesFocus || 'status', node: active };
      }
      focusTargets.clear();
      trackFocus(textarea, 'message'); trackFocus(sendBtn, 'send');
      trackFocus(stopBtn, 'stop'); trackFocus(bar, 'status');
      renderBar();
      renderTranscript();
      renderRequests();
      renderComposer();
      if (focusMemory) {
        const original = focusTargets.get(focusMemory.key);
        const target = original && !original.disabled ? original
          : focusTargets.get('acknowledge-review') || focusTargets.get('reconnect')
            || (!textarea.disabled ? textarea : bar);
        target.focus();
        focusMemory.node = target;
        if (!textarea.disabled) focusMemory = null;
      }
    }

    function setState(next) {
      if (disposed) return;            // late push/hydration: no work on detached DOM
      // The hub disposes controllers on teardown; this view is the only place
      // a last-known transcript can survive for display. Retain the freshest
      // live conversation of the selected identity — one bounded entry —
      // and drop it outright on an explicit target change.
      const targetKey = next.target ? JSON.stringify([next.target.url, next.target.profile]) : '';
      if (retainedView && retainedView.targetKey !== targetKey) retainedView = null;
      if (next.conversation && next.selected) {
        const row = (next.sessions || []).find((s) => (s.id || s.sessionId) === next.selected.sessionId);
        retainedView = {
          targetKey,
          key: retainedKey(next.target, next.selected),
          title: row?.title || next.selected.title || next.selected.sessionId,
          convo: next.conversation,
        };
      }
      state = next;
      const sig = JSON.stringify([next.status, next.generation, next.target, next.selected,
        next.sessions, next.storedSessions, next.storedSessionsError,
        next.conversation?.transcript?.length, next.conversation?.turn?.text?.length,
        next.conversation?.pendingRequests, next.conversation?.requestOutcomes, next.error,
        next.conversation?.statusLine, next.conversation?.errors,
        next.conversation?.lastSend?.outcome, next.conversation?.phase, next.uncertain]);
      // Draft clearing is origin-aware and ack-driven — see dispatchSend. A
      // delivered lastSend (fresh, replayed, or hydrated) only drives the
      // durable rejected/uncertain warning in renderComposer; it never spends
      // or records anything against drafts, so stale admissions resurfacing
      // after arbitrary later activity are inert by construction and no
      // per-send history exists to bound.
      if (sig !== lastSig) { lastSig = sig; render(); }
      else renderComposer();
    }

    // `onState` may return an unsubscribe function (preload bridge); older
    // bridges return nothing and the disposed flag alone fences late pushes.
    const unsubscribe = api.onState(setState);
    api.getState().then(setState).catch(() => {});
    return {
      setState,
      dispose() {
        if (disposed) return;
        disposed = true;
        if (typeof unsubscribe === 'function') { try { unsubscribe(); } catch {} }
        drafts.clear();
        answers.clear();
        retainedView = null;
        focusMemory = null; focusTargets.clear();
        root.innerHTML = '';
      },
    };
  }

  const api = { createHermesView, commandErrorMessage };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.HermesView = api;
})();
