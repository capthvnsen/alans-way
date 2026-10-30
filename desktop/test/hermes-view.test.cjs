const { ip: fixtureTailnet, otherIp: fixtureTailnetOther } = require('./tailnet-fixture.cjs');
process.env.HERMES_WORKSPACE_ALLOW_LOOPBACK = '1';
'use strict';
// Renderer view tests on a minimal DOM — the goal is behavior (draft
// survival, hostile text staying literal, request fencing), not layout.
//
// Draft clearing is ack-driven: the stubbed bridge resolves 'send' commands
// like the real hub contract — resolution is the admission acknowledgement
// (hub 'send' returns only after the controller's prompt.submit succeeds; a
// rejected/uncertain/stale send rejects the command). sendReplies queues
// per-call results/errors; sendDefer holds acks back until flushSend() so a
// send is genuinely in flight while the test edits the draft.
const test = require('node:test');
const assert = require('node:assert/strict');

class FakeEvent {
  constructor(type, opts = {}) { this.type = type; Object.assign(this, opts); }
  preventDefault() { this.defaultPrevented = true; }
}
global.Event = FakeEvent;

class FakeFragment {
  constructor() { this.children = []; this.parent = null; }
  append(...kids) { for (const k of kids) if (k) this.children.push(k); }
  get textContent() { return this.children.map((c) => c.textContent).join(''); }
}
class FakeNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase(); this.children = []; this.parent = null;
    this._text = ''; this.listeners = {}; this.dataset = {}; this.attributes = {};
    this.className = ''; this.disabled = false; this.value = ''; this.onclick = null;
    this.scrollTop = 0; this.scrollHeight = 0; this.clientHeight = 0;
  }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set innerHTML(v) { this.children = []; }
  get innerHTML() { return this.children.map((c) => c.outerHTML || '').join(''); }
  get outerHTML() { return `<${this.tagName.toLowerCase()} class="${this.className}">${this._text.replace(/&/g,'&amp;').replace(/</g,'&lt;')}${this.innerHTML}</${this.tagName.toLowerCase()}>`; }
  get lastChild() { return this.children.at(-1); }
  get classList() {
    const node = this;
    return { toggle(cls, force) {
      const set = new Set(node.className.split(/\s+/).filter(Boolean));
      if (force === undefined ? !set.has(cls) : force) set.add(cls); else set.delete(cls);
      node.className = [...set].join(' ');
    } };
  }
  append(...kids) { for (const k of kids) { if (k) { k.parent = this; this.children.push(k); } } }
  focus() { if (!this.disabled) document.activeElement = this; }
  contains(node) { return node === this || this.findAll(n => n === node).length > 0; }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
  dispatchEvent(e) { for (const f of this.listeners[e.type] || []) f.call(this, e); return true; }
  click() { for (const f of this.listeners.click || []) f.call(this, new FakeEvent('click')); if (this.onclick) this.onclick(new FakeEvent('click')); }
  hasClass(c) { return this.className.split(/\s+/).includes(c); }
  remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); }
  querySelector(sel) { return this.findAll((n) => (sel.startsWith('.') ? n.className.split(/\s+/).includes(sel.slice(1)) : n.tagName === sel.toUpperCase()))[0] || null; }
  findAll(pred, out = []) {
    for (const c of this.children) {
      if (c instanceof FakeFragment) { for (const g of c.children) { if (pred(g)) out.push(g); g.findAll && g.findAll(pred, out); } }
      else { if (pred(c)) out.push(c); c.findAll(pred, out); }
    }
    return out;
  }
}
const document = {
  activeElement: null,
  body: new FakeNode('body'),
  createElement: (tag) => new FakeNode(tag),
  createDocumentFragment: () => new FakeFragment(),
};
global.document = document;
const { createHermesView, commandErrorMessage } = require('../src/hermes-view.js');

const tick = () => new Promise((r) => setImmediate(r));

function makeApi(initial) {
  const calls = [];
  const listeners = [];
  let deferred = [];
  const rec = {
    calls,
    listeners,
    sendReplies: [],   // queued per-send results; an Error entry rejects the send
    sendDefer: false,  // when true, 'send' acks stay in flight until flushSend
    emit: (s) => { for (const f of [...listeners]) f(s); },
    flushSend: (reply = { ok: true }) => {
      const d = deferred; deferred = [];
      for (const p of d) (reply instanceof Error) ? p.reject(reply) : p.resolve(reply);
    },
    api: {
      getState: async () => initial,
      command: (name, value) => {
        calls.push({ name, value });
        if (name === 'send' && rec.sendDefer) {
          return new Promise((resolve, reject) => deferred.push({ resolve, reject }));
        }
        if (name === 'send' && rec.sendReplies.length) {
          const r = rec.sendReplies.shift();
          if (r instanceof Error) return Promise.reject(r);
          return Promise.resolve(r);
        }
        return Promise.resolve({ ok: true });
      },
      onState: (cb) => {
        listeners.push(cb);
        return () => { const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); };
      },
    },
  };
  return rec;
}

const baseState = (over = {}) => ({
  status: 'ready',
  generation: 7,
  target: { url: `https://${fixtureTailnet}`, label: `${fixtureTailnet}`, profile: 'default', authRequired: true },
  principal: { userId: 'agent', provider: 'basic' },
  sessions: [{ sessionId: 's-1', sessionKey: 'k1', title: 'One' }],
  selected: { sessionId: 's-1', sessionKey: 'k1', title: 'One' },
  conversation: {
    phase: 'bound', sessionId: 's-1', transcript: [], turn: null,
    pendingRequests: [], requestOutcomes: [], transcriptDropped: 0,
    stats: { eventGaps: 0 }, lastSend: null, statusLine: null,
  },
  error: null,
  ...over,
});

function view(initial) {
  const root = new FakeNode('div');
  const rec = makeApi(initial);
  const v = createHermesView({ api: rec.api, root });
  const textarea = root.findAll((n) => n.tagName === 'TEXTAREA')[0];
  const transcript = root.findAll((n) => n.className.includes('hermes-transcript'))[0];
  return { root, rec, v, textarea, transcript };
}

test('renders transcript; hostile markup stays literal text, never elements', async () => {
  const hostile = '<img src=x onerror=alert(1)><script>alert(2)</script>';
  const { root, transcript } = view(baseState({
    conversation: {
      phase: 'bound', sessionId: 's-1',
      transcript: [
        { role: 'user', text: hostile, status: 'admitted' },
        { role: 'assistant', text: 'safe **reply**', status: 'complete', tools: [{ name: 'terminal', status: 'done', summary: 'ls' }] },
      ],
      turn: null, pendingRequests: [], requestOutcomes: [], transcriptDropped: 0,
      stats: { eventGaps: 0 }, lastSend: null, statusLine: null,
    },
  }));
  await new Promise((r) => setImmediate(r));
  assert.ok(transcript.textContent.includes(hostile));
  assert.ok(!root.findAll((n) => n.tagName === 'IMG' || n.tagName === 'SCRIPT').length);
  assert.ok(root.findAll((n) => n.className.includes('hermes-tool')).length === 1);
});

test('tool start and completion repaint while streamed text stays unchanged', async () => {
  const initial = baseState({ conversation: { ...baseState().conversation,
    turn: { text: 'Working', tools: [] } } });
  const s = view(initial); await tick();
  try {
    const tool = { name: 'terminal', status: 'running' };
    s.rec.emit({ ...initial, conversation: { ...initial.conversation,
      turn: { text: 'Working', tools: [tool] } } });
    assert.match(s.transcript.textContent, /terminal · running/);
    s.rec.emit({ ...initial, conversation: { ...initial.conversation,
      turn: { text: 'Working', tools: [{ ...tool, status: 'complete' }] } } });
    assert.match(s.transcript.textContent, /terminal · complete/);
    assert.doesNotMatch(s.transcript.textContent, /terminal · running/);
  } finally { s.v.dispose(); }
});

test('bounded transcript replacement repaints even when row count stays constant', async () => {
  const initial = baseState({ conversation: { ...baseState().conversation,
    transcript: [{ role: 'assistant', text: 'Earlier reply', status: 'complete' }] } });
  const s = view(initial); await tick();
  try {
    s.rec.emit({ ...initial, conversation: { ...initial.conversation, transcriptDropped: 1,
      transcript: [{ role: 'assistant', text: 'Current reply', status: 'complete' }] } });
    assert.match(s.transcript.textContent, /Current reply/);
    assert.match(s.transcript.textContent, /1 older entry not shown/);
    assert.doesNotMatch(s.transcript.textContent, /Earlier reply/);
  } finally { s.v.dispose(); }
});

test('send captures session+generation; the send ack clears the draft once, admission pushes stay inert', async () => {
  const rec = makeApi(baseState());
  const root = new FakeNode('div');
  createHermesView({ api: rec.api, root });
  await new Promise((r) => setImmediate(r));
  const textarea = root.findAll((n) => n.tagName === 'TEXTAREA')[0];
  textarea.value = 'hello hermes';
  textarea.dispatchEvent(new FakeEvent('input'));
  textarea.dispatchEvent(new FakeEvent('keydown', { key: 'Enter', shiftKey: false, isComposing: false }));
  await tick(); // the send command resolving IS the admission acknowledgement
  assert.deepEqual(rec.calls[0], { name: 'send', value: { sessionId: 's-1', generation: 7, text: 'hello hermes' } });
  assert.equal(textarea.value, '', 'the accepted local send clears its submitted draft at the ack');
  // The admission's own state push — and any later replay — is inert.
  rec.emit(baseState({ conversation: { ...baseState().conversation, lastSend: { outcome: 'admitted', text: 'hello hermes', target: { sessionId: 's-1', sessionKey: 'k1' }, at: '2026-10-16T01:00:00.000Z', userRowId: 'r-a' } } }));
  assert.equal(textarea.value, '');
  // A foreign admission (this view never sent it) never touches a live edit.
  textarea.value = 'edited later';
  textarea.dispatchEvent(new FakeEvent('input'));
  rec.emit(baseState({ conversation: { ...baseState().conversation, lastSend: { outcome: 'admitted', text: 'edited later', target: { sessionId: 's-1', sessionKey: 'k1' }, at: '2026-10-16T01:00:01.000Z', userRowId: 'r-b' } } }));
  assert.equal(textarea.value, 'edited later');
});

test('shift+enter and IME composition never send', async () => {
  const rec = makeApi(baseState());
  const root = new FakeNode('div');
  createHermesView({ api: rec.api, root });
  await new Promise((r) => setImmediate(r));
  const textarea = root.findAll((n) => n.tagName === 'TEXTAREA')[0];
  textarea.value = 'x';
  textarea.dispatchEvent(new FakeEvent('keydown', { key: 'Enter', shiftKey: true }));
  textarea.dispatchEvent(new FakeEvent('compositionstart'));
  textarea.dispatchEvent(new FakeEvent('keydown', { key: 'Enter', isComposing: true }));
  await new Promise((r) => setImmediate(r));
  assert.equal(rec.calls.filter((c) => c.name === 'send').length, 0);
});

test('clarify card renders exact qids; answer dispatches once and is fenced to generation', async () => {
  const st = baseState({
    conversation: {
      ...baseState().conversation,
      pendingRequests: [{
        id: 'req-9', method: 'clarify', sessionId: 's-1', attributed: true,
        params: { questions: [{ qid: 'color', question: 'Pick a color', choices: ['red', 'blue'] }] },
      }],
    },
  });
  const rec = makeApi(st);
  const root = new FakeNode('div');
  createHermesView({ api: rec.api, root });
  await new Promise((r) => setImmediate(r));
  const card = root.findAll((n) => n.hasClass && n.hasClass('hermes-card'))[0];
  assert.ok(card.textContent.includes('Pick a color'));
  const input = card.findAll((n) => n.tagName === 'INPUT' && n.dataset.qid === 'color')[0];
  input.value = 'green';
  input.dispatchEvent(new FakeEvent('input'));
  const sendA = card.findAll((n) => n.tagName === 'BUTTON' && n.textContent === 'Send answers')[0];
  sendA.click();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(rec.calls.at(-1).value, { requestId: 'req-9', sessionId: 's-1', generation: 7, result: { answers: { color: 'green' } } });
  // The same card after a reconnect (new generation) is inert.
  rec.emit({ ...st, generation: 8 });
  sendA.click();
  assert.equal(rec.calls.filter((c) => c.name === 'answer-request').length, 1);
});

test('approval offers deliberate choices; unsupported requests stay visibly pending', async () => {
  const st = baseState({
    conversation: {
      ...baseState().conversation,
      pendingRequests: [
        { id: 'a1', method: 'approval', sessionId: 's-1', attributed: true,
          params: { description: 'Run rm -rf?', command: 'rm -rf build', choices: ['deny', 'once'] } },
        { id: 'a2', method: 'mystery-kind', sessionId: 's-1', attributed: true, supported: false, params: {} },
      ],
    },
  });
  const rec = makeApi(st);
  const root = new FakeNode('div');
  createHermesView({ api: rec.api, root });
  await new Promise((r) => setImmediate(r));
  const cards = root.findAll((n) => n.hasClass && n.hasClass('hermes-card'));
  assert.equal(cards.length, 2);
  assert.ok(cards[0].textContent.includes('rm -rf build'));
  const onceBtn = cards[0].findAll((n) => n.tagName === 'BUTTON' && n.textContent === 'Allow once')[0];
  onceBtn.click();
  assert.deepEqual(rec.calls.at(-1).value, { requestId: 'a1', sessionId: 's-1', generation: 7, result: { choice: 'once' } });
  assert.ok(cards[1].textContent.includes('not supported'));
  assert.equal(cards[1].findAll((n) => n.tagName === 'BUTTON').length >= 1, true);
});

test('stop is only offered while a turn streams; command carries fences', async () => {
  const st = baseState({
    conversation: { ...baseState().conversation, turn: { streaming: true, text: 'partial', tools: [] } },
  });
  const rec = makeApi(st);
  const root = new FakeNode('div');
  createHermesView({ api: rec.api, root });
  await new Promise((r) => setImmediate(r));
  const stop = root.findAll((n) => n.className.includes('hermes-stop'))[0];
  assert.equal(stop.disabled, false);
  stop.click();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(rec.calls.at(-1), { name: 'stop', value: { sessionId: 's-1', generation: 7 } });
});

test('draft survives session switch and returns per exact target', async () => {
  const st = baseState();
  const rec = makeApi(st);
  const root = new FakeNode('div');
  createHermesView({ api: rec.api, root });
  await new Promise((r) => setImmediate(r));
  const textarea = root.findAll((n) => n.tagName === 'TEXTAREA')[0];
  textarea.value = 'draft for s-1';
  textarea.dispatchEvent(new FakeEvent('input'));
  const st2 = baseState({
    sessions: [{ sessionId: 's-2', sessionKey: 'k2', title: 'Two' }],
    selected: { sessionId: 's-2', sessionKey: 'k2', title: 'Two' },
  });
  st2.conversation.sessionId = 's-2';
  rec.emit(st2);
  assert.equal(textarea.value, '');
  rec.emit(st);
  assert.equal(textarea.value, 'draft for s-1');
});

test('selection change reloads the draft even while the textarea is focused', async () => {
  const st = baseState();
  const rec = makeApi(st);
  const root = new FakeNode('div');
  createHermesView({ api: rec.api, root });
  await new Promise((r) => setImmediate(r));
  const textarea = root.findAll((n) => n.tagName === 'TEXTAREA')[0];
  textarea.value = 'draft for s-1';
  textarea.dispatchEvent(new FakeEvent('input'));
  // Simulate the composer holding focus during the switch: the old target's
  // text must be replaced, not pinned onto the new session.
  document.activeElement = textarea;
  const st2 = baseState({
    sessions: [{ sessionId: 's-2', sessionKey: 'k2', title: 'Two' }],
    selected: { sessionId: 's-2', sessionKey: 'k2', title: 'Two' },
  });
  st2.conversation.sessionId = 's-2';
  rec.emit(st2);
  assert.equal(textarea.value, '');
  // An immediate Send on the new session carries s-2's fences and empty text,
  // never the stale s-1 draft.
  textarea.dispatchEvent(new FakeEvent('keydown', { key: 'Enter', shiftKey: false, isComposing: false }));
  assert.equal(rec.calls.length, 0); // nothing to send; no stale text leaked
  textarea.value = 's-2 text';
  textarea.dispatchEvent(new FakeEvent('input'));
  textarea.dispatchEvent(new FakeEvent('keydown', { key: 'Enter', shiftKey: false, isComposing: false }));
  const send = rec.calls.find((c) => c.name === 'send');
  assert.ok(send);
  assert.equal(send.value.sessionId, 's-2');
  assert.equal(send.value.text, 's-2 text');
  // Same-target re-render still respects the focus guard.
  rec.emit({ ...st2 });
  assert.equal(textarea.value, 's-2 text');
  document.activeElement = null;
  rec.emit({ ...st2 });
  assert.equal(textarea.value, 's-2 text');
  rec.emit(st);
  assert.equal(textarea.value, 'draft for s-1');
});

test('delivery-unconfirmed tombstone renders durably with no conversation; dismiss is explicit and session-fenced', async () => {
  const st = baseState({
    status: 'ready',
    conversation: null,
    uncertain: {
      sessionId: 's-1', sessionKey: 'k1',
      text: 'did the reply land?', at: '2026-10-16T00:00:00Z',
      outcome: 'uncertain', reason: 'Connection closed (failed)',
    },
  });
  const { root, rec } = view(st);
  rec.emit(st);
  const card = root.findAll((n) => n.hasClass && n.hasClass('hermes-card') && n.hasClass('uncertain'))[0];
  assert.ok(card, 'tombstone card must render even without a conversation');
  const txt = card.findAll((n) => n.hasClass && n.hasClass('hermes-uncertain-text'))[0];
  assert.equal(txt.textContent, 'did the reply land?');
  // Nothing auto-resends: the only command issued must be an explicit dismiss.
  assert.equal(rec.calls.length, 0);
  const dismiss = card.findAll((n) => n.tagName === 'BUTTON')[0];
  dismiss.click();
  assert.deepEqual(rec.calls[0], { name: 'uncertain-dismiss', value: { sessionId: 's-1', generation: 7 } });
  // A tombstone for another session does not render on this selection.
  rec.emit({ ...st, uncertain: { ...st.uncertain, sessionId: 's-other' } });
  assert.equal(root.findAll((n) => n.hasClass && n.hasClass('uncertain')).length, 0);
});

test('focused admission clears the editor on exact submitted text for the still-selected session', async () => {
  const st = baseState({
    conversation: {
      phase: 'bound', sessionId: 's-1', transcript: [], turn: null,
      pendingRequests: [], requestOutcomes: [], transcriptDropped: 0,
      stats: { eventGaps: 0 }, lastSend: null, statusLine: null,
    },
  });
  const { root, rec, textarea } = view(st);
  rec.emit(st);
  textarea.value = 'DRAFT-KEEP-123';
  textarea.dispatchEvent(new FakeEvent('input'));
  document.activeElement = textarea; // editor focused at submit
  textarea.dispatchEvent(new FakeEvent('keydown', { key: 'Enter', shiftKey: false, isComposing: false }));
  await tick(); // the accepted send's ack clears the focused editor
  assert.equal(textarea.value, '');
  // Its admission push arriving after the ack is inert.
  rec.emit({ ...st, conversation: { ...st.conversation,
    lastSend: { text: 'DRAFT-KEEP-123', outcome: 'admitted', target: { sessionId: 's-1', sessionKey: 'k1' }, at: '2026-10-16T01:00:00.000Z' } } });
  assert.equal(textarea.value, '');
  document.activeElement = null;
});

test('newer typed text survives a late admission of the older submitted text', async () => {
  const st = baseState();
  const { rec, textarea } = view(st);
  rec.emit(st);
  textarea.value = 'first send';
  textarea.dispatchEvent(new FakeEvent('input'));
  rec.sendDefer = true;
  textarea.dispatchEvent(new FakeEvent('keydown', { key: 'Enter', shiftKey: false, isComposing: false }));
  // User keeps typing before the send's ack lands.
  textarea.value = 'first send + newer typing';
  textarea.dispatchEvent(new FakeEvent('input'));
  rec.flushSend();
  await tick();
  rec.emit({ ...st, conversation: { ...st.conversation,
    lastSend: { text: 'first send', outcome: 'admitted', target: { sessionId: 's-1', sessionKey: 'k1' }, at: '2026-10-16T01:00:00.000Z' } } });
  assert.equal(textarea.value, 'first send + newer typing');
});

test('same-text edits while the send is in flight survive the ack (revision guard)', async () => {
  const st = baseState();
  const { rec, textarea } = view(st);
  rec.emit(st);
  textarea.value = 'retype me';
  textarea.dispatchEvent(new FakeEvent('input'));
  rec.sendDefer = true;
  textarea.dispatchEvent(new FakeEvent('keydown', { key: 'Enter', shiftKey: false, isComposing: false }));
  // Edit away, then retype the exact submitted text — a different revision.
  textarea.value = 'retype me!';
  textarea.dispatchEvent(new FakeEvent('input'));
  textarea.value = 'retype me';
  textarea.dispatchEvent(new FakeEvent('input'));
  rec.flushSend();
  await tick();
  rec.emit({ ...st, conversation: { ...st.conversation,
    lastSend: { text: 'retype me', outcome: 'admitted', target: { sessionId: 's-1', sessionKey: 'k1' }, at: '2026-10-16T01:00:00.000Z', userRowId: 'r-1' } } });
  assert.equal(textarea.value, 'retype me', 'a draft edited while pending is not the submitted draft');
});

// ── Atomic identical replacement while a send is in flight ─────────────────
// A selection replacement or paste that lands on the SAME string in a single
// input event is still a real edit: the revision must move even though the
// text did not, or the pending send's ack would wipe the re-entered draft.
// Programmatic re-asserts of the same text (no input event at all) are not
// edits and must not invalidate an otherwise unchanged draft.

test('one atomic identical multi-character replacement survives the pending send\'s ack', async () => {
  const st = baseState();
  const { rec, textarea } = view(st);
  rec.emit(st);
  textarea.value = 'same paste';
  textarea.dispatchEvent(new FakeEvent('input'));
  rec.sendDefer = true;
  textarea.dispatchEvent(new FakeEvent('keydown', { key: 'Enter', shiftKey: false, isComposing: false }));
  // One gesture replaces the whole selection with the identical text — the
  // only signal the view can see is the single input event itself.
  textarea.value = 'same paste';
  textarea.dispatchEvent(new FakeEvent('input', { inputType: 'insertFromPaste', data: 'same paste' }));
  rec.flushSend();
  await tick();
  rec.emit({ ...st, conversation: { ...st.conversation,
    lastSend: { text: 'same paste', outcome: 'admitted', target: { sessionId: 's-1', sessionKey: 'k1' }, at: '2026-10-16T01:00:00.000Z', userRowId: 'r-a1' } } });
  assert.equal(textarea.value, 'same paste', 'an input event is an edit even when the string is identical');
});

test('one atomic identical single-character replacement survives the pending send\'s ack', async () => {
  const st = baseState();
  const { rec, textarea } = view(st);
  rec.emit(st);
  textarea.value = 'x';
  textarea.dispatchEvent(new FakeEvent('input'));
  rec.sendDefer = true;
  textarea.dispatchEvent(new FakeEvent('keydown', { key: 'Enter', shiftKey: false, isComposing: false }));
  // Select the only character and retype it — one input event, same value.
  textarea.value = 'x';
  textarea.dispatchEvent(new FakeEvent('input', { inputType: 'insertReplacementText', data: 'x' }));
  rec.flushSend();
  await tick();
  rec.emit({ ...st, conversation: { ...st.conversation,
    lastSend: { text: 'x', outcome: 'admitted', target: { sessionId: 's-1', sessionKey: 'k1' }, at: '2026-10-16T01:00:00.000Z', userRowId: 'r-a2' } } });
  assert.equal(textarea.value, 'x', 'a one-character identical replacement still spends a revision');
});

test('an untouched draft still clears at the ack, and a programmatic same-text re-assert does not invalidate it', async () => {
  const st = baseState();
  // Control: no gesture at all while the send is in flight — the ack clears.
  {
    const { rec, textarea } = view(st);
    rec.emit(st);
    textarea.value = 'untouched';
    textarea.dispatchEvent(new FakeEvent('input'));
    rec.sendDefer = true;
    textarea.dispatchEvent(new FakeEvent('keydown', { key: 'Enter', shiftKey: false, isComposing: false }));
    rec.flushSend();
    await tick();
    rec.emit({ ...st, conversation: { ...st.conversation,
      lastSend: { text: 'untouched', outcome: 'admitted', target: { sessionId: 's-1', sessionKey: 'k1' }, at: '2026-10-16T01:00:00.000Z', userRowId: 'r-c1' } } });
    assert.equal(textarea.value, '', 'unchanged accepted send clears once');
  }
  // A programmatic .value re-assert plus a state re-render during the flight
  // — neither emits an input event — must not spend the pending revision.
  {
    const { rec, textarea } = view(st);
    rec.emit(st);
    textarea.value = 'asserted';
    textarea.dispatchEvent(new FakeEvent('input'));
    rec.sendDefer = true;
    textarea.dispatchEvent(new FakeEvent('keydown', { key: 'Enter', shiftKey: false, isComposing: false }));
    textarea.value = 'asserted'; // programmatic restore, no input event
    rec.emit({ ...st });         // re-render re-asserts the same draft text
    rec.flushSend();
    await tick();
    rec.emit({ ...st, conversation: { ...st.conversation,
      lastSend: { text: 'asserted', outcome: 'admitted', target: { sessionId: 's-1', sessionKey: 'k1' }, at: '2026-10-16T01:00:01.000Z', userRowId: 'r-c2' } } });
    assert.equal(textarea.value, '', 're-asserting the same text without an input event is not an edit');
  }
});

test('a send dispatched then selection switched clears only that session\'s stored draft at its ack', async () => {
  const st = baseState();
  const { rec, textarea } = view(st);
  rec.emit(st);
  await tick(); // initial getState hydration settles before the selection moves
  textarea.value = 's-1 pending';
  textarea.dispatchEvent(new FakeEvent('input'));
  rec.sendDefer = true;
  textarea.dispatchEvent(new FakeEvent('keydown', { key: 'Enter', shiftKey: false, isComposing: false }));
  const st2 = baseState({
    sessions: [{ sessionId: 's-1', sessionKey: 'k1', title: 'One' }, { sessionId: 's-2', sessionKey: 'k2', title: 'Two' }],
    selected: { sessionId: 's-2', sessionKey: 'k2', title: 'Two' },
  });
  st2.conversation = { ...st2.conversation, sessionId: 's-2' };
  rec.emit(st2);
  textarea.value = 's-2 work in progress';
  textarea.dispatchEvent(new FakeEvent('input'));
  // s-1's send ack lands while s-2 is selected — s-2's editor is untouched,
  // and s-1's stored draft clears.
  rec.flushSend();
  await tick();
  assert.equal(textarea.value, 's-2 work in progress');
  rec.emit({ ...st2, conversation: { ...st2.conversation,
    lastSend: { text: 's-1 pending', outcome: 'admitted', target: { sessionId: 's-1', sessionKey: 'k1' }, at: '2026-10-16T01:00:00.000Z', userRowId: 'r-2' } } });
  assert.equal(textarea.value, 's-2 work in progress');
  const st1back = baseState({
    sessions: [{ sessionId: 's-1', sessionKey: 'k1', title: 'One' }, { sessionId: 's-2', sessionKey: 'k2', title: 'Two' }],
    selected: { sessionId: 's-1', sessionKey: 'k1', title: 'One' },
  });
  st1back.conversation = { ...st1back.conversation, sessionId: 's-1' };
  rec.emit(st1back);
  assert.equal(textarea.value, '', 's-1\'s stored draft was cleared by its own send ack');
});

test('failed or uncertain submission preserves editor text with a durable warning and never replays', async () => {
  const st = baseState();
  const { root, rec, textarea } = view(st);
  rec.emit(st);
  for (const outcome of ['rejected', 'uncertain']) {
    textarea.value = 'maybe it landed';
    textarea.dispatchEvent(new FakeEvent('input'));
    rec.sendReplies.push(Object.assign(new Error(`send ${outcome}`), { code: outcome === 'rejected' ? 'queue_full' : 'wire_closed' }));
    textarea.dispatchEvent(new FakeEvent('keydown', { key: 'Enter', shiftKey: false, isComposing: false }));
    await tick(); // the command rejected — no admission, no clear
    rec.calls.length = 0;
    rec.emit({ ...st, conversation: { ...st.conversation,
      lastSend: { text: 'maybe it landed', outcome, target: { sessionId: 's-1', sessionKey: 'k1' }, at: '2026-10-16T01:00:00.000Z' } } });
    assert.equal(textarea.value, 'maybe it landed', `${outcome} must preserve editor text`);
    const warn = root.findAll((n) => n.hasClass && n.hasClass('hermes-send-warn'))[0];
    assert.ok(warn && !warn.hasClass('hidden'), `${outcome} must show a durable warning`);
    // Re-render (same outcome) must not resend anything.
    rec.emit({ ...st, conversation: { ...st.conversation,
      lastSend: { text: 'maybe it landed', outcome, target: { sessionId: 's-1', sessionKey: 'k1' }, at: '2026-10-16T01:00:00.000Z' } } });
    assert.equal(rec.calls.filter((c) => c.name === 'send').length, 0, `${outcome} must not replay`);
    // An explicit resend that succeeds still clears the preserved draft once.
    textarea.dispatchEvent(new FakeEvent('keydown', { key: 'Enter', shiftKey: false, isComposing: false }));
    await tick();
    assert.equal(rec.calls.filter((c) => c.name === 'send').length, 1, 'explicit resend fires once');
    assert.equal(textarea.value, '', `${outcome}: the accepted resend clears once`);
    rec.emit({ ...st, conversation: { ...st.conversation, lastSend: null } });
    rec.calls.length = 0;
  }
});

// ── Ack-driven clear, once per send (critic F1: identical-retype wipe) ──────
// Clearing rides the send's own acknowledgement — one pending record per
// in-flight send, released at settle. lastSend pushes (admitted or replayed,
// fresh or stale) never spend anything against drafts, so an identical
// retype is unreachable by any admission notification, old or new.

test('a replayed admission notification cannot wipe an identical retype', async () => {
  const st = baseState();
  const { rec, textarea } = view(st);
  rec.emit(st);
  textarea.value = 'same text';
  textarea.dispatchEvent(new FakeEvent('input'));
  textarea.dispatchEvent(new FakeEvent('keydown', { key: 'Enter', shiftKey: false, isComposing: false }));
  await tick();
  assert.equal(textarea.value, '', 'the accepted send clears its draft at the ack');
  const ls = { text: 'same text', outcome: 'admitted',
    target: { sessionId: 's-1', sessionKey: 'k1' }, at: '2026-10-16T01:00:00.000Z', userRowId: 'r1' };
  rec.emit({ ...st, conversation: { ...st.conversation, lastSend: ls } });
  assert.equal(textarea.value, '');
  // The user retypes the exact same text — a genuinely new draft.
  textarea.value = 'same text';
  textarea.dispatchEvent(new FakeEvent('input'));
  assert.equal(textarea.value, 'same text');
  // The same admission keeps replaying on later pushes — sig-identical and
  // sig-changed alike. Both must be inert for the fresh draft.
  rec.emit({ ...st, conversation: { ...st.conversation, lastSend: ls } });
  rec.emit({ ...st, conversation: { ...st.conversation, lastSend: ls,
    transcript: [{ role: 'assistant', text: 'echo', status: 'complete' }] } });
  assert.equal(textarea.value, 'same text', 'replayed admission must not wipe the retype');
  // The retyped draft is still view-owned: a session switch round-trip
  // restores it verbatim.
  const st2 = baseState({
    sessions: [{ sessionId: 's-2', sessionKey: 'k2', title: 'Two' }],
    selected: { sessionId: 's-2', sessionKey: 'k2', title: 'Two' },
  });
  st2.conversation = { ...st2.conversation, sessionId: 's-2' };
  rec.emit(st2);
  assert.equal(textarea.value, '');
  rec.emit(st);
  assert.equal(textarea.value, 'same text', 'retyped draft survives the switch round-trip');
});

test('a distinct send of identical text still clears exactly once', async () => {
  const st = baseState();
  const { rec, textarea } = view(st);
  rec.emit(st);
  const send = async (at, row) => {
    textarea.value = 'same text';
    textarea.dispatchEvent(new FakeEvent('input'));
    textarea.dispatchEvent(new FakeEvent('keydown', { key: 'Enter', shiftKey: false, isComposing: false }));
    await tick();                                            // this send's ack
    rec.emit({ ...st, conversation: { ...st.conversation,
      lastSend: { text: 'same text', outcome: 'admitted',
        target: { sessionId: 's-1', sessionKey: 'k1' }, at, userRowId: row } } });
  };
  await send('2026-10-16T01:00:00.000Z', 'r1');
  assert.equal(textarea.value, '', 'first send clears at its ack');
  // A second, fresh local send of the same text must still clear — the clear
  // keys the send's own pending record, never the text.
  await send('2026-10-16T01:00:01.000Z', 'r2');
  assert.equal(textarea.value, '', 'distinct second send still clears once');
  // Its own replays are just as inert for a further identical retype.
  textarea.value = 'same text';
  textarea.dispatchEvent(new FakeEvent('input'));
  const ls2 = { text: 'same text', outcome: 'admitted',
    target: { sessionId: 's-1', sessionKey: 'k1' }, at: '2026-10-16T01:00:01.000Z', userRowId: 'r2' };
  rec.emit({ ...st, conversation: { ...st.conversation, lastSend: ls2 } });
  rec.emit({ ...st, conversation: { ...st.conversation, lastSend: ls2 } });
  assert.equal(textarea.value, 'same text', 'replays of the second admission are inert too');
});

test('a late identical retype after an admission observed over newer text is never a target', async () => {
  const st = baseState();
  const { rec, textarea } = view(st);
  rec.emit(st);
  textarea.value = 'sent text';
  textarea.dispatchEvent(new FakeEvent('input'));
  rec.sendDefer = true;
  textarea.dispatchEvent(new FakeEvent('keydown', { key: 'Enter', shiftKey: false, isComposing: false }));
  // Newer different typing lands before the ack — nothing is spent.
  textarea.value = 'sent text + more';
  textarea.dispatchEvent(new FakeEvent('input'));
  rec.flushSend();
  await tick();
  const ls = { text: 'sent text', outcome: 'admitted',
    target: { sessionId: 's-1', sessionKey: 'k1' }, at: '2026-10-16T01:00:00.000Z', userRowId: 'r1' };
  rec.emit({ ...st, conversation: { ...st.conversation, lastSend: ls } });
  assert.equal(textarea.value, 'sent text + more', 'newer text survives the admission');
  // Retyping the exact admitted text later is fresh input, never a target.
  textarea.value = 'sent text';
  textarea.dispatchEvent(new FakeEvent('input'));
  rec.emit({ ...st, conversation: { ...st.conversation, lastSend: ls } });
  rec.emit({ ...st, conversation: { ...st.conversation, lastSend: ls } });
  assert.equal(textarea.value, 'sent text', 'a later identical retype is unreachable by the old admission');
});

test('inflight pushes never clear: only the send\'s own admitted ack spends the draft', async () => {
  const st = baseState();
  const { rec, textarea } = view(st);
  rec.emit(st);
  textarea.value = 't in flight';
  textarea.dispatchEvent(new FakeEvent('input'));
  rec.sendDefer = true;
  textarea.dispatchEvent(new FakeEvent('keydown', { key: 'Enter', shiftKey: false, isComposing: false }));
  const send = { text: 't in flight', target: { sessionId: 's-1', sessionKey: 'k1' }, at: '2026-10-16T01:00:00.000Z' };
  rec.emit({ ...st, conversation: { ...st.conversation, lastSend: { ...send, outcome: 'inflight' } } });
  rec.emit({ ...st, conversation: { ...st.conversation, lastSend: { ...send, outcome: 'inflight' } } });
  assert.equal(textarea.value, 't in flight', 'inflight notifications never clear');
  rec.flushSend();
  await tick();
  assert.equal(textarea.value, '', 'the send\'s own ack clears once');
  rec.emit({ ...st, conversation: { ...st.conversation, lastSend: { ...send, outcome: 'admitted', userRowId: 'r1' } } });
  assert.equal(textarea.value, '', 'the admission push after the ack is inert');
});

test('a late prior-session admission replays harmlessly: no wipe of selected editor, stored draft, or a retype', async () => {
  const st = baseState();
  const { rec, textarea } = view(st);
  rec.emit(st);
  await tick(); // initial getState hydration settles before the selection moves
  textarea.value = 's-1 pending';
  textarea.dispatchEvent(new FakeEvent('input'));
  rec.sendDefer = true;
  textarea.dispatchEvent(new FakeEvent('keydown', { key: 'Enter', shiftKey: false, isComposing: false }));
  const st2 = baseState({
    sessions: [{ sessionId: 's-1', sessionKey: 'k1', title: 'One' }, { sessionId: 's-2', sessionKey: 'k2', title: 'Two' }],
    selected: { sessionId: 's-2', sessionKey: 'k2', title: 'Two' },
  });
  st2.conversation = { ...st2.conversation, sessionId: 's-2' };
  rec.emit(st2);
  textarea.value = 's-2 work in progress';
  textarea.dispatchEvent(new FakeEvent('input'));
  const ls = { text: 's-1 pending', outcome: 'admitted',
    target: { sessionId: 's-1', sessionKey: 'k1' }, at: '2026-10-16T01:00:00.000Z', userRowId: 'r1' };
  // s-1's send settles while s-2 is selected: the ack clears s-1's stored
  // draft, and the admission pushes replaying under s-2 touch nothing.
  rec.flushSend();
  await tick();
  rec.emit({ ...st2, conversation: { ...st2.conversation, lastSend: ls } });
  rec.emit({ ...st2, conversation: { ...st2.conversation, lastSend: ls } });
  assert.equal(textarea.value, 's-2 work in progress');
  // Back on s-1: the cleared draft stays clear; a fresh identical retype is
  // safe from further replays of the old admission.
  const st1back = baseState({
    sessions: [{ sessionId: 's-1', sessionKey: 'k1', title: 'One' }, { sessionId: 's-2', sessionKey: 'k2', title: 'Two' }],
    selected: { sessionId: 's-1', sessionKey: 'k1', title: 'One' },
  });
  st1back.conversation = { ...st1back.conversation, sessionId: 's-1', lastSend: ls };
  rec.emit(st1back);
  assert.equal(textarea.value, '', 's-1\'s draft was already cleared by its own ack');
  textarea.value = 's-1 pending';
  textarea.dispatchEvent(new FakeEvent('input'));
  rec.emit({ ...st1back, conversation: { ...st1back.conversation, lastSend: ls } });
  assert.equal(textarea.value, 's-1 pending', 'replays while reselected stay inert');
});

test('an admitted lastSend under another target cannot clear this target\'s stored draft', async () => {
  const st = baseState();
  const { rec, textarea } = view(st);
  rec.emit(st);
  textarea.value = 'keep me';
  textarea.dispatchEvent(new FakeEvent('input'));   // stored under gw.example|default|s-1
  // Reconfigure to a different target: different label/profile and selection.
  const stB = baseState({
    target: { url: `https://${fixtureTailnetOther}`, label: 'other.example', profile: 'alt', authRequired: true },
    sessions: [{ sessionId: 's-9', sessionKey: 'k9', title: 'Nine' }],
    selected: { sessionId: 's-9', sessionKey: 'k9', title: 'Nine' },
  });
  stB.conversation = { ...stB.conversation, sessionId: 's-9' };
  rec.emit(stB);
  assert.equal(textarea.value, '');
  // An admission replayed under the OTHER target's projection is namespaced
  // by that target — it can never reach this target's draft-map entry.
  stB.conversation = { ...stB.conversation, lastSend: { text: 'keep me', outcome: 'admitted',
    target: { sessionId: 's-9', sessionKey: 'k9' }, at: '2026-10-16T02:00:00.000Z', userRowId: 'rB' } };
  rec.emit(stB);
  rec.emit({ ...stB });
  assert.equal(textarea.value, '');
  // Back under the original target the draft is still there, and a genuine
  // local send under THIS target still clears once.
  rec.emit(st);
  assert.equal(textarea.value, 'keep me');
  textarea.dispatchEvent(new FakeEvent('keydown', { key: 'Enter', shiftKey: false, isComposing: false }));
  await tick();
  rec.emit({ ...st, conversation: { ...st.conversation, lastSend: { text: 'keep me', outcome: 'admitted',
    target: { sessionId: 's-1', sessionKey: 'k1' }, at: '2026-10-16T02:00:01.000Z', userRowId: 'rr' } } });
  assert.equal(textarea.value, '', 'a real local send under this target still clears once');
});

// ── Draft lifetime/history: nothing survives a settled send ────────────────
// There is no consumption ledger at all — a send's pending record lives in
// its own in-flight closure and is released at settle, so no replay can ever
// become "new" again and there is no window to evict. A remounted view owns
// no stale marks because none are kept.

const iso = (ms) => new Date(Date.UTC(2026, 9, 16, 0, 0, 0, ms)).toISOString();
const admittedOn = (text, sid, sessionKey, at, userRowId) =>
  ({ text, outcome: 'admitted', target: { sessionId: sid, sessionKey }, at, userRowId });
const convo = (sid, lastSend) => ({
  phase: 'bound', sessionId: sid, transcript: [], turn: null,
  pendingRequests: [], requestOutcomes: [], transcriptDropped: 0,
  stats: { eventGaps: 0 }, lastSend, statusLine: null,
});

test('a retype survives an old admission replayed after >64 genuine foreign-session sends', async () => {
  const st = baseState();
  const { rec, textarea } = view(st);
  rec.emit(st);
  const s1 = { sessionId: 's-1', sessionKey: 'k1', title: 'One' };
  const s2 = { sessionId: 's-2', sessionKey: 'k2', title: 'Two' };
  const both = [s1, s2];
  // Session B (s-1): send T, the ack clears it, user retypes T.
  textarea.value = 'B-RETYPED';
  textarea.dispatchEvent(new FakeEvent('input'));
  textarea.dispatchEvent(new FakeEvent('keydown', { key: 'Enter', shiftKey: false, isComposing: false }));
  await tick();
  assert.equal(textarea.value, '', 'B send clears at its ack');
  const lsB = admittedOn('B-RETYPED', 's-1', 'k1', iso(0), 1);
  rec.emit({ ...st, sessions: both, conversation: convo('s-1', lsB) });
  textarea.value = 'B-RETYPED';
  textarea.dispatchEvent(new FakeEvent('input'));
  // Switch to session A (s-2): seventy genuine local sends land there.
  rec.emit({ ...st, sessions: both, selected: s2, conversation: convo('s-2', null) });
  for (let i = 1; i <= 70; i++) {
    const t = `A-MSG-${i}`;
    textarea.value = t;
    textarea.dispatchEvent(new FakeEvent('input'));
    textarea.dispatchEvent(new FakeEvent('keydown', { key: 'Enter', shiftKey: false, isComposing: false }));
    await tick();
    rec.emit({ ...st, sessions: both, selected: s2,
      conversation: convo('s-2', admittedOn(t, 's-2', 'k2', iso(i * 1000), 1000 + i)) });
    assert.equal(textarea.value, '', `A send ${i} still clears once`);
  }
  // Return to B: its retained old lastSend replays with the projection — the
  // saved retype must survive; pushes are never consumed.
  rec.emit({ ...st, sessions: both, selected: s1, conversation: convo('s-1', lsB) });
  rec.emit({ ...st, sessions: both, selected: s1, conversation: convo('s-1', lsB) });
  assert.equal(textarea.value, 'B-RETYPED', 'B retype must survive replay of the old admission');
});

test('replays of old same-session admissions stay inert after >64 newer sends', async () => {
  const st = baseState();
  const { rec, textarea } = view(st);
  rec.emit(st);
  for (let i = 1; i <= 70; i++) {
    const t = `SEND-${i}`;
    textarea.value = t;
    textarea.dispatchEvent(new FakeEvent('input'));
    textarea.dispatchEvent(new FakeEvent('keydown', { key: 'Enter', shiftKey: false, isComposing: false }));
    await tick();
    rec.emit({ ...st, conversation: convo('s-1', admittedOn(t, 's-1', 'k1', iso(i * 1000), i)) });
    assert.equal(textarea.value, '', `send ${i} clears once`);
  }
  // A recent admission's replay stays inert…
  textarea.value = 'SEND-70';
  textarea.dispatchEvent(new FakeEvent('input'));
  rec.emit({ ...st, conversation: convo('s-1', admittedOn('SEND-70', 's-1', 'k1', iso(70000), 70)) });
  assert.equal(textarea.value, 'SEND-70', 'recent send replay must stay inert');
  // …and so does the OLDEST one's — there is no stored mark to lose.
  textarea.value = 'SEND-1';
  textarea.dispatchEvent(new FakeEvent('input'));
  rec.emit({ ...st, conversation: convo('s-1', admittedOn('SEND-1', 's-1', 'k1', iso(1000), 1)) });
  rec.emit({ ...st, conversation: convo('s-1', admittedOn('SEND-1', 's-1', 'k1', iso(1000), 1)) });
  assert.equal(textarea.value, 'SEND-1', 'oldest send replay must stay inert — nothing is kept to evict');
});

test('a replacement view cannot re-consume an admission its first snapshot missed', async () => {
  const st = baseState(); // conversation.lastSend: null — snapshot omits it
  const rec = makeApi(st); // the SAME bridge channel serves both views
  const root1 = new FakeNode('div');
  const v1 = createHermesView({ api: rec.api, root: root1 });
  await tick();
  const ta1 = root1.findAll((n) => n.tagName === 'TEXTAREA')[0];
  rec.emit(st);
  ta1.value = 'SAME-DRAFT';
  ta1.dispatchEvent(new FakeEvent('input'));
  ta1.dispatchEvent(new FakeEvent('keydown', { key: 'Enter', shiftKey: false, isComposing: false }));
  await tick();
  assert.equal(ta1.value, '', 'first view\'s own send clears at its ack');
  const ls = admittedOn('SAME-DRAFT', 's-1', 'k1', iso(0), 1);
  rec.emit({ ...st, conversation: convo('s-1', ls) });
  v1.dispose();
  // Remount: the replacement's hydration legitimately lacks the admission
  // (controller projection raced/rebound). The user retypes the same text.
  const root2 = new FakeNode('div');
  createHermesView({ api: rec.api, root: root2 });
  await tick();
  const ta2 = root2.findAll((n) => n.tagName === 'TEXTAREA')[0];
  rec.emit(st);
  ta2.value = 'SAME-DRAFT';
  ta2.dispatchEvent(new FakeEvent('input'));
  // The stale admission resurfaces on a later push — it must stay inert.
  rec.emit({ ...st, conversation: convo('s-1', ls) });
  rec.emit({ ...st, conversation: convo('s-1', ls) });
  assert.equal(ta2.value, 'SAME-DRAFT', 'stale admission must not wipe the new view\'s identical draft');
  // A genuinely new LOCAL send by the remount still clears exactly once.
  ta2.dispatchEvent(new FakeEvent('keydown', { key: 'Enter', shiftKey: false, isComposing: false }));
  await tick();
  rec.emit({ ...st, conversation: convo('s-1', admittedOn('SAME-DRAFT', 's-1', 'k1', iso(5000), 2)) });
  assert.equal(ta2.value, '', 'the remount\'s own send still clears once');
  ta2.value = 'SAME-DRAFT';
  ta2.dispatchEvent(new FakeEvent('input'));
  rec.emit({ ...st, conversation: convo('s-1', ls) });
  assert.equal(ta2.value, 'SAME-DRAFT', 'the old admission stays inert after the new send');
});

test('dispose unsubscribes the state listener; late pushes and a late getState are ignored', async () => {
  const st = baseState();
  let resolveGet;
  const calls = [], listeners = [];
  const api = {
    getState: () => new Promise((r) => { resolveGet = r; }),
    command: async (name, value) => { calls.push({ name, value }); return { ok: true }; },
    onState: (cb) => {
      listeners.push(cb);
      return () => { const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); };
    },
  };
  const root = new FakeNode('div');
  const v = createHermesView({ api, root });
  assert.equal(listeners.length, 1, 'view subscribes on mount');
  v.dispose();
  assert.equal(listeners.length, 0, 'dispose must remove the onState listener');
  assert.equal(root.children.length, 0, 'dispose empties the view root');
  // Belt-and-braces: a stale handle or a directly invoked setState after
  // disposal must not process state or touch the detached DOM.
  v.setState(st);
  resolveGet(st); // hydration settles after disposal — must be ignored
  await new Promise((r) => setImmediate(r));
  assert.equal(root.children.length, 0, 'no state may render into a disposed view');
});

test('dispose clears drafts, answers and the view\'s own DOM', async () => {
  const st = baseState();
  const rec = makeApi(st);
  const root = new FakeNode('div');
  const v = createHermesView({ api: rec.api, root });
  await new Promise((r) => setImmediate(r));
  const textarea = root.findAll((n) => n.tagName === 'TEXTAREA')[0];
  textarea.value = 'same text';
  textarea.dispatchEvent(new FakeEvent('input'));
  textarea.dispatchEvent(new FakeEvent('keydown', { key: 'Enter', shiftKey: false, isComposing: false }));
  await tick();
  rec.emit({ ...st, conversation: { ...st.conversation,
    lastSend: { text: 'same text', outcome: 'admitted',
      target: { sessionId: 's-1', sessionKey: 'k1' }, at: '2026-10-16T01:00:00.000Z', userRowId: 'r1' } } });
  assert.equal(textarea.value, '');
  v.dispose();
  assert.equal(root.children.length, 0, 'dispose empties the view root');
  // A view on a DIFFERENT bridge channel shares nothing with this one — and
  // even on the same channel a foreign admission never touches an unsent
  // draft.
  const rec2 = makeApi(st);
  const root2 = new FakeNode('div');
  createHermesView({ api: rec2.api, root: root2 });
  await new Promise((r) => setImmediate(r));
  const textarea2 = root2.findAll((n) => n.tagName === 'TEXTAREA')[0];
  textarea2.value = 'unrelated draft';
  textarea2.dispatchEvent(new FakeEvent('input'));
  rec2.emit({ ...st, conversation: { ...st.conversation,
    lastSend: { text: 'same text', outcome: 'admitted',
      target: { sessionId: 's-1', sessionKey: 'k1' }, at: '2026-10-16T01:00:00.000Z', userRowId: 'r1' } } });
  assert.equal(textarea2.value, 'unrelated draft', 'a new view keeps its own drafts');
});

// ── Multi-view + settlement-after-dispose (module contract) ────────────────
// The shipped app mounts one view and never disposes it; these cases guard
// the mechanism's own invariants on surfaces the module exposes.

test('two undisposed views on one channel: the sending view clears; the sibling keeps its draft', async () => {
  const st = baseState();
  const rec = makeApi(st);                       // one bridge channel, two views
  const root1 = new FakeNode('div');
  const root2 = new FakeNode('div');
  createHermesView({ api: rec.api, root: root1 });
  await tick();
  const ta1 = root1.findAll((n) => n.tagName === 'TEXTAREA')[0];
  rec.emit(st);
  ta1.value = 'SHARED-TEXT';
  ta1.dispatchEvent(new FakeEvent('input'));     // v1 holds an identical draft
  createHermesView({ api: rec.api, root: root2 }); // v1 deliberately NOT disposed
  await tick();
  const ta2 = root2.findAll((n) => n.tagName === 'TEXTAREA')[0];
  rec.emit(st);
  ta2.value = 'SHARED-TEXT';
  ta2.dispatchEvent(new FakeEvent('input'));
  ta2.dispatchEvent(new FakeEvent('keydown', { key: 'Enter', shiftKey: false, isComposing: false }));
  await tick();
  assert.equal(ta2.value, '', 'the view that sent the text clears its own draft at the ack');
  assert.equal(ta1.value, 'SHARED-TEXT',
    'a send v1 never issued must not consume its draft — listener order cannot steal or spend');
  // The admission push itself reaches both views but spends nothing.
  rec.emit({ ...st, conversation: { ...st.conversation, lastSend: {
    text: 'SHARED-TEXT', outcome: 'admitted',
    target: { sessionId: 's-1', sessionKey: 'k1' }, at: '2026-10-16T01:00:00.000Z', userRowId: 'r9' } } });
  assert.equal(ta2.value, '');
  assert.equal(ta1.value, 'SHARED-TEXT');
});

test('a send whose ack settles after dispose does no work on the dead view', async () => {
  const st = baseState();
  const rec = makeApi(st);
  const root = new FakeNode('div');
  const v = createHermesView({ api: rec.api, root });
  await tick();
  const textarea = root.findAll((n) => n.tagName === 'TEXTAREA')[0];
  textarea.value = 'LATE-ACK';
  textarea.dispatchEvent(new FakeEvent('input'));
  rec.sendDefer = true;
  textarea.dispatchEvent(new FakeEvent('keydown', { key: 'Enter', shiftKey: false, isComposing: false }));
  v.dispose();
  rec.flushSend(); // the ack lands into the dead view — must be ignored
  await tick();
  rec.emit({ ...st, conversation: { ...st.conversation, lastSend: {
    text: 'LATE-ACK', outcome: 'admitted',
    target: { sessionId: 's-1', sessionKey: 'k1' }, at: '2026-10-16T01:00:00.000Z', userRowId: 'r10' } } });
  assert.equal(root.children.length, 0, 'disposed view must not re-render');
  assert.equal(textarea.value, 'LATE-ACK', 'detached DOM must be untouched');
});

// ── A→B→A through the REAL hub / wire / controller ─────────────────────────
// The FRB d2-a-draft-restored-on-return failure: a probe that ran right after
// 'select' resolved read an empty composer. These tests exercise the same
// product surfaces the app does — createHermesHub on the real
// HermesSessionWire and real HermesConversation controllers, with state
// pushed through the very scheduler main.cjs uses (shell-support coalesce at
// 60 ms, matching pushHermesState). The only fakes are what Electron/the OS
// own in production: the DOM, the gateway's socket, and the IPC bridge.
//
// That bridge reproduces the asymmetry that matters: a command() reply
// resolves as soon as hub.command settles, while onState pushes ride the
// coalesced send — so a select reply can legitimately resolve while the
// renderer still shows the previous session's composer. The view's draft map
// is private to the renderer; an empty textarea there means "this is the
// last consumed state", not "the draft is gone".

const { PassThrough } = require('node:stream');
const { createHermesHub } = require('../src/hermes-hub.cjs');
const { normalizeBaseUrl } = require('../src/hermes-remote.cjs');
const { coalesce } = require('../src/shell-support.cjs');

// Loopback peer for the real wire — the same newline-JSON-RPC vocabulary a
// stock tui_gateway speaks (see frb-relay.cjs). holdSubmits defers
// prompt.submit responses so a send stays genuinely in flight across a
// session switch; onSubmit answers with a JSON-RPC error for the reject leg.
function fakeGateway() {
  const c2s = new PassThrough();
  const s2c = new PassThrough();
  const sessions = new Map();
  let seq = 0, creates = 0;
  const held = [];
  const gw = { input: s2c, output: c2s, socket: { close() { try { s2c.end(); } catch {} } },
    sent: [], responses: [], storedSessions: [], holdSubmits: false, onSubmit: null,
    release() { for (const fn of held.splice(0)) fn(); } };
  const write = (f) => s2c.write(JSON.stringify(f) + '\n');
  const event = (type, sessionId, payload = {}) =>
    write({ jsonrpc: '2.0', method: 'event',
      params: { type, session_id: sessionId, seq: ++seq, payload } });
  gw.event = event;
  gw.request = (id, method, params) => write({ jsonrpc: '2.0', id, method, params });
  gw.ready = () => write({ jsonrpc: '2.0', method: 'event',
    params: { type: 'gateway.ready', payload: { replay_epoch: 'ep-1' } } });
  let buf = '';
  c2s.on('data', (chunk) => {
    buf += chunk;
    for (;;) {
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (line.trim()) answer(JSON.parse(line));
    }
  });
  function answer(f) {
    const { id, method, params = {} } = f;
    if (!method) { gw.responses.push(f); return; }
    const ok = (result) => write({ jsonrpc: '2.0', id, result });
    if (method === 'gateway.capabilities')
      return ok({ per_session_exclusive_submit: true });
    if (method === 'client.capabilities')
      return ok({ server_requests: ['clarify', 'approval'] });
    if (method === 'session.active_list')
      return ok({ sessions: [...sessions.entries()].map(([sid, s]) =>
        ({ id: sid, session_key: s.key, title: s.title })) });
    if (method === 'session.list') return ok({ sessions: gw.storedSessions.map(s => ({ id: s.id, title: s.title })) });
    if (method === 'session.resume') {
      const saved = gw.storedSessions.find(s => s.id === params.session_id);
      assert.ok(saved, 'only listed saved history may resume');
      const id = `resumed-${++creates}`;
      sessions.set(id, { key: saved.id, title: saved.title, messages: saved.messages });
      return ok({ session_id: id, session_key: saved.id, resumed: saved.id, messages: saved.messages, inflight: null });
    }
    if (method === 'session.create') {
      const sid = `sess-${++creates}`;
      sessions.set(sid, { key: `key-${creates}`, title: `S${creates}` });
      return ok({ session_id: sid, session_key: `key-${creates}` });
    }
    if (method === 'session.activate') {
      const s = sessions.get(params.session_id);
      return ok({ session_id: params.session_id, session_key: s && s.key,
        messages: s?.messages || [], open_requests: [] });
    }
    if (method === 'session.events.since')
      return ok({ epoch: 'ep-1', events: [], open_requests: [], latest_seq: seq, truncated: false });
    if (method === 'prompt.submit') {
      gw.sent.push({ session_id: params.session_id, text: params.text });
      if (gw.onSubmit) return write({ jsonrpc: '2.0', id, error: gw.onSubmit });
      const admit = () => {
        ok({ status: 'admitted', user_row_id: `r${gw.sent.length}` });
        event('message.complete', params.session_id, { text: 'ok', status: 'complete' });
      };
      return gw.holdSubmits ? held.push(admit) : admit();
    }
    ok({});
  }
  return gw;
}

// The same bridge the preload exposes: getState is a live hub read, command
// invokes and resolves with the hub, onState delivers coalesced snapshots.
// pushState is the real coalesced sender; flush() delivers a pending push
// synchronously (deterministic stand-in for the 60 ms window elapsing).
function realStack({ holdSubmits = false, onSubmit = null } = {}) {
  const gw = fakeGateway();
  gw.holdSubmits = holdSubmits;
  gw.onSubmit = onSubmit;
  const remote = {
    normalizeBaseUrl,
    probe: async () => ({ authRequired: false, authFlows: [], authProviders: [] }),
    wsUrl: () => 'ws://loopback/ws',
    connectSocket: async () => {
      setImmediate(() => gw.ready());
      return { input: gw.input, output: gw.output, socket: gw.socket };
    },
  };
  const listeners = [];
  const pushState = coalesce(() => {
    const s = hub.getState();
    for (const cb of [...listeners]) cb(s);
  }, 60);
  const hub = createHermesHub({ remote, notify: () => pushState(), persist: () => {}, load: () => ({}) });
  const api = {
    getState: () => Promise.resolve(hub.getState()),
    command: (name, value) => Promise.resolve(hub.command(name, value)),
    onState: (cb) => { listeners.push(cb); return () => listeners.splice(listeners.indexOf(cb), 1); },
  };
  const root = new FakeNode('div');
  createHermesView({ api, root });
  const textarea = root.findAll((n) => n.tagName === 'TEXTAREA')[0];
  return { api, gw, root, hub, textarea, pushState,
    delivered: () => { pushState.flush(); } };
}

async function realBoot(s) {
  await s.api.command('configure', { url: `http://${fixtureTailnet}:9119`, localToken: 'tok' });
  await s.api.command('connect', {});
  const a = await s.api.command('new-session', {});
  const b = await s.api.command('new-session', {});
  return { sidA: a.sessionId, sidB: b.sessionId };
}

const typeIn = (s, text) => { s.textarea.value = text; s.textarea.dispatchEvent(new FakeEvent('input')); };
const enterIn = (s) => s.textarea.dispatchEvent(new FakeEvent('keydown', { key: 'Enter', shiftKey: false, isComposing: false }));
const settle = () => new Promise((r) => setTimeout(r, 0));

test('session wire deltas reach visible assistant text before message.complete through the real hub', async () => {
  const s = realStack();
  try {
    const { sidA } = await realBoot(s);
    await s.api.command('select', { sessionId: sidA }); s.delivered();
    const assistant = () => s.root.findAll(n => n.hasClass('hermes-msg') && n.hasClass('assistant')).at(-1);
    s.gw.event('message.start', sidA); s.delivered();
    assert.ok(assistant().hasClass('streaming'));
    assert.equal(assistant().querySelector('.hermes-text').textContent, '…');
    s.gw.event('message.delta', sidA, { text: 'The lighthouse ' }); s.delivered();
    assert.ok(assistant().hasClass('streaming'));
    assert.equal(assistant().querySelector('.hermes-text').textContent, 'The lighthouse ');
    s.gw.event('message.delta', sidA, { text: 'glowed.\n' }); s.delivered();
    assert.equal(assistant().querySelector('.hermes-text').textContent, 'The lighthouse glowed.\n');
    assert.ok(assistant().hasClass('streaming'), 'intermediate text is visible before completion');
    s.gw.event('message.complete', sidA, { text: 'The lighthouse glowed.\n', status: 'complete' }); s.delivered();
    assert.equal(assistant().querySelector('.hermes-text').textContent, 'The lighthouse glowed.\n');
    assert.ok(!assistant().hasClass('streaming'));
    assert.equal(s.root.findAll(n => n.hasClass('hermes-msg') && n.hasClass('assistant')).length, 1);
  } finally { s.hub.dispose(); s.pushState.flush(); }
});

test('ready empty states distinguish saved history, no conversations and failed history lookup with Refresh', async () => {
  const initial = baseState({ selected: null, conversation: null, sessions: [], storedSessions: [], storedSessionsError: null });
  const { root, transcript, rec } = view(initial); await tick();
  assert.match(transcript.textContent, /No live or saved conversations/);
  rec.emit({ ...initial, storedSessions: [{ id: 'stored-1', title: 'Saved' }] });
  assert.match(transcript.textContent, /Resume a saved conversation/);
  rec.emit({ ...initial, storedSessionsError: 'Saved conversations could not be loaded.' });
  assert.match(transcript.textContent, /Saved conversations could not be loaded/);
  root.findAll(n => n.tagName === 'BUTTON' && n.textContent === 'Refresh conversations')[0].click();
  await tick();
  assert.equal(rec.calls.at(-1).name, 'refresh-sessions');
});

test('saved history resume through the real wire hydrates the transcript and enables the composer without resending', async () => {
  const s = realStack();
  s.gw.storedSessions = [{ id: 'saved-key', title: 'Lighthouse', messages: [
    { role: 'user', text: 'A story' }, { role: 'assistant', text: 'Saved lighthouse reply.' },
  ] }];
  try {
    await s.api.command('configure', { url: `http://${fixtureTailnet}:9119`, localToken: 'fixture' });
    await s.api.command('connect', {}); s.delivered();
    const before = await s.api.getState();
    assert.deepEqual(before.sessions, []);
    assert.deepEqual(before.storedSessions, [{ id: 'saved-key', title: 'Lighthouse' }]);
    assert.equal(s.textarea.disabled, true);
    await s.api.command('resume-session', { storedSessionId: 'saved-key', generation: before.generation }); s.delivered();
    const after = await s.api.getState();
    assert.equal(after.selected.sessionKey, 'saved-key');
    assert.notEqual(after.selected.sessionId, 'saved-key', 'persisted key is never treated as a runtime id');
    assert.equal(after.conversation.phase, 'bound');
    assert.equal(s.root.querySelector('.hermes-transcript').textContent, 'A storySaved lighthouse reply.');
    assert.equal(s.textarea.disabled, false);
    assert.deepEqual(s.gw.sent, [], 'resume never submits a prompt');
  } finally { s.hub.dispose(); s.pushState.flush(); }
});

test('A→B→A through real hub/wire/controller restores the draft once the select push is delivered', async () => {
  const s = realStack();
  const { sidA, sidB } = await realBoot(s);
  await s.api.command('select', { sessionId: sidA }); s.delivered();
  typeIn(s, 'DRAFT-A');
  await s.api.command('select', { sessionId: sidB }); s.delivered();
  assert.equal(s.textarea.value, '', "B's composer starts empty");

  typeIn(s, 'B-SEND');
  enterIn(s);
  await settle();                                    // B's send admitted

  // Arm the coalesce window so the select's notify defers — the same
  // geometry the FRB run observed: the reply resolves while the renderer
  // still shows B's composer.
  s.pushState();
  await s.api.command('select', { sessionId: sidA });
  assert.equal(s.textarea.value, '', 'pre-delivery read shows the prior session, not lost data');
  s.delivered();
  assert.equal(s.textarea.value, 'DRAFT-A', 'A\'s draft survives an admitted B send');
});

test('A→B→A with the B send still in flight; the late ack clears only B\'s stored draft', async () => {
  const s = realStack({ holdSubmits: true });
  const { sidA, sidB } = await realBoot(s);
  await s.api.command('select', { sessionId: sidA }); s.delivered();
  typeIn(s, 'DRAFT-A');
  await s.api.command('select', { sessionId: sidB }); s.delivered();

  typeIn(s, 'B-SEND');
  enterIn(s);
  await settle();                                    // submit on the wire, ack held

  s.pushState();                                     // arm the window
  await s.api.command('select', { sessionId: sidA });
  assert.equal(s.textarea.value, 'B-SEND', 'in-flight send still shows its text pre-delivery');
  s.delivered();
  assert.equal(s.textarea.value, 'DRAFT-A', 'A\'s draft restored on delivery');

  s.gw.release();                                    // B's ack lands while viewing A
  await settle(); s.delivered();
  assert.equal(s.textarea.value, 'DRAFT-A', 'the late ack never wipes the visible A draft');

  await s.api.command('select', { sessionId: sidB }); s.delivered();
  assert.equal(s.textarea.value, '', 'the ack cleared only B\'s own stored draft');
});

test('A→B→A with a rejected B send preserves both drafts', async () => {
  const s = realStack({ onSubmit: { code: 'queue_full', message: 'queue full' } });
  const { sidA, sidB } = await realBoot(s);
  await s.api.command('select', { sessionId: sidA }); s.delivered();
  typeIn(s, 'DRAFT-A');
  await s.api.command('select', { sessionId: sidB }); s.delivered();

  typeIn(s, 'B-SEND');
  enterIn(s);
  await settle(); s.delivered();                     // definite reject settles

  s.pushState();
  await s.api.command('select', { sessionId: sidA });
  assert.equal(s.textarea.value, 'B-SEND', 'pre-delivery composer still shows the rejected text');
  s.delivered();
  assert.equal(s.textarea.value, 'DRAFT-A', 'A\'s draft survives a failed B send');

  await s.api.command('select', { sessionId: sidB }); s.delivered();
  assert.equal(s.textarea.value, 'B-SEND', 'the rejected send\'s draft is never consumed');
});

test('outside a command burst the select push is delivered before the reply resolves', async () => {
  const s = realStack();
  const { sidA, sidB } = await realBoot(s);
  await s.api.command('select', { sessionId: sidA }); s.delivered();
  typeIn(s, 'DRAFT-A');
  await s.api.command('select', { sessionId: sidB }); s.delivered();
  // Let the 60 ms coalesce window expire (the human-paced case): select's
  // first changed() then sends immediately, so the view consumes sel=A while
  // the command is still resolving.
  await new Promise((r) => setTimeout(r, 80));
  await s.api.command('select', { sessionId: sidA });
  assert.equal(s.textarea.value, 'DRAFT-A', 'immediate delivery restores A\'s draft');
});

// ── Disconnect keeps the selected conversation's context in place ──────────
// The hub disposes every controller on teardown, so `conversation` goes null
// while `selected` survives. The view's ONE retained copy of the freshest
// live conversation is the only place a last-known transcript can render —
// identity-fenced, visibly stale, never interactive, dropped on an explicit
// target change. Nothing in the retained path may send, answer, or replay.

const liveConvo = (over = {}) => ({
  phase: 'bound', sessionId: 's-1',
  transcript: [
    { role: 'user', text: 'first question', status: 'admitted' },
    { role: 'assistant', text: 'first answer', status: 'complete' },
  ],
  turn: null, pendingRequests: [], requestOutcomes: [], transcriptDropped: 0,
  stats: { eventGaps: 0 },
  lastSend: { text: 'first question', outcome: 'uncertain',
    target: { sessionId: 's-1', sessionKey: 'k1' }, at: '2026-10-16T01:00:00.000Z' },
  statusLine: null, ...over,
});
const droppedFrom = (st, over = {}) => ({
  ...st, status: 'error', generation: (st.generation || 7) + 1,
  sessions: [], conversation: null,
  error: { code: 'disconnected', message: 'Connection closed (failed)' },
  uncertain: {
    sessionId: 's-1', sessionKey: 'k1', text: 'first question',
    at: '2026-10-16T01:00:01.000Z', outcome: 'uncertain',
    reason: 'Connection closed (failed)',
  },
  ...over,
});

test('a dropped socket keeps the last-known transcript, draft and tombstone in place with one recovery action', async () => {
  const st = baseState({ conversation: liveConvo() });
  const { root, rec, textarea, transcript } = view(st);
  rec.emit(st);
  await tick();
  textarea.value = 'unsent draft';
  textarea.dispatchEvent(new FakeEvent('input'));

  rec.emit(droppedFrom(st));
  // The transcript stays — visibly stale, session identity named in place.
  assert.ok(transcript.hasClass('stale'), 'retained transcript is marked stale');
  assert.ok(transcript.textContent.includes('first answer'));
  const note = transcript.findAll((n) => n.hasClass && n.hasClass('hermes-stale-note'))[0];
  assert.ok(note && note.textContent.includes('One'), 'the stale notice names the selected session');
  assert.ok(note.textContent.includes('last known transcript'));
  // Exactly one scoped recovery action; it is the connection's, not a replay.
  const retries = root.findAll((n) => n.className.includes('hermes-retry'));
  assert.equal(retries.length, 1);
  assert.equal(retries[0].textContent, 'Reconnect');
  // Draft retained, composer firmly disabled, tombstone + durable warn kept.
  assert.equal(textarea.value, 'unsent draft');
  assert.equal(textarea.disabled, true);
  assert.equal(root.findAll((n) => n.tagName === 'BUTTON' && n.className.includes('hermes-send'))[0].disabled, true);
  assert.equal(root.findAll((n) => n.hasClass && n.hasClass('uncertain')).length, 1);
  const warn = root.findAll((n) => n.hasClass && n.hasClass('hermes-send-warn'))[0];
  assert.ok(!warn.hasClass('hidden'), 'delivery-unconfirmed warning stays understandable in place');
  // The stale transcript offers no dead inline retry.
  assert.equal(transcript.findAll((n) => n.className.includes('hermes-inline-retry')).length, 0);

  retries[0].click();
  await tick();
  assert.equal(rec.calls.filter((c) => c.name === 'connect').length, 1);
  assert.equal(rec.calls.filter((c) => c.name === 'send').length, 0, 'reconnect alone never resends');

  // Reconnecting keeps the same last-known context, now as a passive chip.
  rec.emit({ ...droppedFrom(st), status: 'connecting', error: null });
  assert.ok(transcript.textContent.includes('first answer'));
  assert.equal(root.findAll((n) => n.className.includes('hermes-retry')).length, 0);
  assert.ok(root.findAll((n) => n.textContent === 'Reconnecting…').length >= 1);
  assert.equal(rec.calls.filter((c) => c.name === 'send').length, 0);

  // Ready + live conversation replaces the stale view; the draft survived.
  rec.emit({ ...st, generation: 9 });
  assert.ok(!transcript.hasClass('stale'));
  assert.ok(transcript.textContent.includes('first answer'));
  assert.equal(textarea.value, 'unsent draft');
  assert.equal(textarea.disabled, false);
});

test('an error+disconnected projection and a clean disconnect each show exactly one recovery action', async () => {
  const st = baseState({ conversation: liveConvo() });
  const { root, rec } = view(st);
  rec.emit(st);
  // A projection carrying both error and disconnected shows ONE action.
  rec.emit(droppedFrom(st, { status: 'disconnected' }));
  let retries = root.findAll((n) => n.className.includes('hermes-retry'));
  assert.equal(retries.length, 1, 'error+disconnected must not show Connect and Reconnect together');
  assert.equal(retries[0].textContent, 'Reconnect');
  // A clean disconnect (error cleared) shows exactly Connect.
  rec.emit(droppedFrom(st, { status: 'disconnected', error: null }));
  retries = root.findAll((n) => n.className.includes('hermes-retry'));
  assert.equal(retries.length, 1);
  assert.equal(retries[0].textContent, 'Connect');
  retries[0].click();
  await tick();
  assert.deepEqual(rec.calls.at(-1), { name: 'connect', value: {} });
});

test('cold-start disconnect with a persisted selection is honest: empty state, single Connect, no invented transcript', async () => {
  const cold = baseState({
    status: 'disconnected', sessions: [], conversation: null, error: null,
  });
  const { root, rec, transcript } = view(cold);
  await tick();
  assert.ok(!transcript.hasClass('stale'));
  assert.equal(root.findAll((n) => n.className.includes('hermes-msg')).length, 0,
    'a fresh view must not invent a transcript');
  assert.ok(transcript.textContent.includes('reconnect'));
  const retries = root.findAll((n) => n.className.includes('hermes-retry'));
  assert.equal(retries.length, 1);
  assert.equal(retries[0].textContent, 'Connect');
  retries[0].click();
  await tick();
  assert.deepEqual(rec.calls, [{ name: 'connect', value: {} }]);
});

test('a switched target or selection never inherits the retained conversation', async () => {
  const st = baseState({ conversation: liveConvo({
    transcript: [{ role: 'assistant', text: 'A-SECRET-TEXT', status: 'complete' }],
  }) });
  const { rec, transcript } = view(st);
  rec.emit(st);
  // Same target, different selection with nothing bound yet: dormant.
  const s2 = baseState({
    status: 'disconnected', sessions: [], conversation: null, error: null,
    selected: { sessionId: 's-2', sessionKey: 'k2', title: 'Two' },
  });
  rec.emit(s2);
  assert.ok(!transcript.textContent.includes('A-SECRET-TEXT'),
    'another selection must not show s-1\'s retained rows');
  // A different target drops the retained copy outright.
  const stB = baseState({
    status: 'disconnected',
    target: { url: `https://${fixtureTailnetOther}`, label: 'other.example', profile: 'alt' },
    sessions: [], conversation: null, error: null,
    selected: { sessionId: 's-9', sessionKey: 'k9', title: 'Nine' },
  });
  rec.emit(stB);
  assert.ok(!transcript.textContent.includes('A-SECRET-TEXT'));
  assert.ok(!transcript.hasClass('stale'));
  // Equal label, equal profile, even an equal session id — a different backend
  // URL is still a different target and inherits nothing.
  const stTwin = baseState({
    status: 'disconnected',
    target: { url: `https://${fixtureTailnetOther}`, label: `${fixtureTailnet}`, profile: 'default' },
    sessions: [], conversation: null, error: null,
    selected: { sessionId: 's-1', sessionKey: 'k1', title: 'Twin' },
  });
  rec.emit(stTwin);
  assert.ok(!transcript.textContent.includes('A-SECRET-TEXT'),
    'a matching label/session id on another URL must not inherit the retained copy');
  assert.ok(!transcript.hasClass('stale'));
  // B's own live conversation then drops: the retained view is B's, never A's.
  rec.emit({ ...stB, status: 'ready', conversation: liveConvo({
    sessionId: 's-9', lastSend: null,
    transcript: [{ role: 'assistant', text: 'B-LIVE-TEXT', status: 'complete' }],
  }) });
  rec.emit({ ...stB, status: 'error', generation: 11, error: { code: 'disconnected', message: 'closed' } });
  assert.ok(transcript.textContent.includes('B-LIVE-TEXT'));
  assert.ok(!transcript.textContent.includes('A-SECRET-TEXT'));
  // And A's retained transcript is gone for good, even back on A's identity.
  rec.emit(droppedFrom(st, { status: 'disconnected', error: null }));
  assert.ok(!transcript.textContent.includes('A-SECRET-TEXT'),
    'a target round-trip must not resurrect A\'s stale copy');
});

test('retained pending requests leave no answerable cards and nothing replays on reconnect', async () => {
  const st = baseState({
    conversation: liveConvo({
      pendingRequests: [{
        id: 'a1', method: 'approval', sessionId: 's-1', attributed: true,
        params: { description: 'Run rm -rf?', command: 'rm -rf build', choices: ['deny', 'once'] },
      }],
    }),
  });
  const { root, rec } = view(st);
  rec.emit(st);
  assert.equal(root.findAll((n) => n.hasClass && n.hasClass('hermes-card')).length, 1);
  rec.emit(droppedFrom(st));
  // The live tombstone still renders, but retained request cards do not —
  // nothing stale can be answered.
  const cards = root.findAll((n) => n.hasClass && n.hasClass('hermes-card'));
  assert.equal(cards.length, 1);
  assert.ok(cards[0].hasClass('uncertain'), 'only the live tombstone survives');
  assert.equal(rec.calls.filter((c) => c.name === 'answer-request').length, 0);
  assert.equal(rec.calls.filter((c) => c.name === 'send').length, 0);
});

test('Change backend stays reachable while connected and recovering and reaches the host once per click', async () => {
  const st = baseState({ conversation: liveConvo() });
  const rec = makeApi(st);
  const root = new FakeNode('div');
  let setups = 0;
  createHermesView({ api: rec.api, root, onShowSetup: () => { setups += 1; } });
  await tick();
  rec.emit(st);
  const connected = root.findAll((n) => n.className.includes('hermes-change-backend'));
  assert.equal(connected.length, 1, 'a live conversation keeps backend setup reachable');
  connected[0].click();
  assert.equal(setups, 1);
  rec.emit(droppedFrom(st));
  const change = root.findAll((n) => n.className.includes('hermes-change-backend'))[0];
  assert.ok(change, 'the recovery surface keeps backend setup reachable');
  change.click();
  assert.equal(setups, 2);
  // Input-requiring states land on the setup card itself — no affordance.
  rec.emit({ ...droppedFrom(st), status: 'needs_signin', error: null });
  assert.equal(root.findAll((n) => n.className.includes('hermes-change-backend')).length, 0);
});

test('Hermes command errors remove IPC and exception wrappers while retaining the useful message', () => {
  for (const [raw, plain] of [
    ["Error invoking remote method 'hermes:command': RemoteError: POST /auth/password-login: Invalid credentials", 'Wrong username or password.'],
    ["Error invoking remote method 'hermes:command': HubError: Configure a backend first.", 'Configure a backend first.'],
    ["Error invoking remote method 'hermes:command': ConversationError: Select a session first.", 'Select a session first.'],
    ["Error invoking remote method 'hermes:command': WireError: prompt.submit timed out", 'prompt.submit timed out'],
    ['Error: WebSocket closed 1006', 'WebSocket closed 1006'],
    ['Delivery unconfirmed', 'Delivery unconfirmed'],
  ]) assert.equal(commandErrorMessage(new Error(raw)), plain);
});

test('a rejected conversation command displays its useful cause without the raw IPC prefix', async () => {
  const { root, textarea, rec } = view(baseState());
  await tick();
  rec.sendReplies.push(new Error("Error invoking remote method 'hermes:command': ConversationError: Select a session first."));
  textarea.value = 'test';
  textarea.dispatchEvent(new FakeEvent('keydown', { key: 'Enter' }));
  await tick();
  assert.equal(root.querySelector('.hermes-flash').textContent, 'Select a session first.');
});

test('input-requiring startup states show no transcript and no stale marker', async () => {
  for (const status of ['unconfigured', 'needs_signin', 'needs_local_token']) {
    const { root, transcript } = view(baseState({
      status, sessions: [], selected: null, conversation: null,
      target: status === 'unconfigured' ? null : baseState().target,
    }));
    await tick();
    assert.equal(root.findAll((n) => n.className.includes('hermes-msg')).length, 0, status);
    assert.ok(!transcript.hasClass('stale'), status);
  }
});

test('a send typed before the drop stays disabled — reconnect alone never resends it', async () => {
  const st = baseState({ conversation: liveConvo({ lastSend: null }) });
  const { root, rec, textarea } = view(st);
  rec.emit(st);
  textarea.value = 'typed but never sent';
  textarea.dispatchEvent(new FakeEvent('input'));
  rec.emit(droppedFrom(st, { uncertain: null }));
  // Enter on the disabled composer must not dispatch.
  textarea.dispatchEvent(new FakeEvent('keydown', { key: 'Enter', shiftKey: false, isComposing: false }));
  await tick();
  // Ready + live again: still no send without a fresh gesture.
  rec.emit({ ...st, generation: 9 });
  await tick();
  assert.equal(rec.calls.filter((c) => c.name === 'send').length, 0, 'no replay across the whole drop/recovery cycle');
  assert.equal(textarea.value, 'typed but never sent', 'the draft was preserved for the user');
  assert.equal(root.findAll((n) => n.tagName === 'BUTTON' && n.className.includes('hermes-send'))[0].disabled, false);
});

const reviewButton = (root, text) => root.findAll(n => n.tagName === 'BUTTON' && n.textContent === text)[0];
const reviewInput = root => root.findAll(n => n.tagName === 'INPUT')[0];
const editReview = (node, text) => { node.value = text; node.dispatchEvent(new FakeEvent('input')); };

for (const field of ['url', 'sessionKey']) test(`message drafts are isolated by exact ${field}`, async () => {
  const a = baseState({ target: { url: `http://${fixtureTailnet}`, label: `${fixtureTailnet}`, profile: 'default' } });
  const s = view(a); await tick();
  try {
    editReview(s.textarea, 'private unsent draft');
    const b = field === 'url' ? { ...a, target: { ...a.target, url: `https://${fixtureTailnet}` } }
      : { ...a, selected: { ...a.selected, sessionKey: 'other-stored-session' } };
    s.rec.emit({ ...b, generation: 8 });
    assert.equal(s.textarea.value, '');
    s.rec.emit({ ...a, generation: 9 }); assert.equal(s.textarea.value, 'private unsent draft');
  } finally { s.v.dispose(); }
});

for (const boundary of ['backend', 'profile', 'session']) test(`answer drafts do not cross the ${boundary} boundary with a reused request id`, async () => {
  const request = { id: 'r1', method: 'secret', sessionId: 's-1', attributed: true, supported: true, params: { prompt: 'Server A secret' } };
  const a = baseState({ conversation: { ...baseState().conversation, pendingRequests: [request] } });
  const s = view(a); await tick();
  try {
    editReview(reviewInput(s.root), 'A-only-secret-draft');
    const b = { ...a, generation: 8, target: { ...a.target }, selected: { ...a.selected } };
    if (boundary === 'backend') b.target.url = `https://${fixtureTailnetOther}`;
    if (boundary === 'profile') b.target.profile = 'other';
    if (boundary === 'session') b.selected.sessionKey = 'other-key';
    s.rec.emit({ ...b, status: 'disconnected', conversation: null });
    s.rec.emit(b);
    assert.equal(reviewInput(s.root).value, '');
    const send = s.root.findAll(n => n.hasClass?.('hermes-card'))[0].findAll(n => n.tagName === 'BUTTON' && n.textContent === 'Send')[0];
    send.click(); await tick(); assert.equal(s.rec.calls.at(-1).value.result.value, '');
    s.rec.emit({ ...a, generation: 9 }); assert.equal(reviewInput(s.root).value, 'A-only-secret-draft');
  } finally { s.v.dispose(); }
});

for (const changeId of [true, false]) test(`coalesced request replacement rerenders ${changeId ? 'new identity' : 'changed contents'} and fences the old control`, async () => {
  const request = { id: 'r-old', method: 'approval', sessionId: 's-1', attributed: true, supported: true, params: { description: 'OLD command', choices: ['deny', 'once'] } };
  const a = baseState({ conversation: { ...baseState().conversation, pendingRequests: [request] } });
  const s = view(a); await tick();
  try {
    const old = reviewButton(s.root, 'Allow once');
    s.rec.emit({ ...a, conversation: { ...a.conversation, pendingRequests: [{ ...request, id: changeId ? 'r-new' : request.id, params: { ...request.params, description: 'NEW command' } }] } });
    assert.ok(s.root.textContent.includes('NEW command')); assert.ok(!s.root.textContent.includes('OLD command'));
    old.click(); assert.equal(s.rec.calls.length, 0);
    reviewButton(s.root, 'Allow once').click(); assert.equal(s.rec.calls.at(-1).value.generation, 7);
  } finally { s.v.dispose(); }
});

test('recovered requests are honest and noninteractive until the wire can answer them', async () => {
  const request = { id: 'r1', method: 'approval', sessionId: 's-1', attributed: true, supported: true, answerable: false, replayed: true, params: { choices: ['once', 'deny'] } };
  const a = baseState({ conversation: { ...baseState().conversation, pendingRequests: [request] } });
  const s = view(a); await tick();
  try {
    assert.match(s.root.textContent, /not answerable on this connection/i);
    assert.equal(reviewButton(s.root, 'Allow once'), undefined);
    s.rec.emit({ ...a, conversation: { ...a.conversation, pendingRequests: [{ ...request, answerable: true }] } });
    reviewButton(s.root, 'Allow once').click(); assert.equal(s.rec.calls.length, 1);
  } finally { s.v.dispose(); }
});

test('review has an explicit acknowledgement and blocked has a reconnect path', async () => {
  const a = baseState({ conversation: { ...baseState().conversation, phase: 'review' } });
  const s = view(a); await tick();
  try {
    assert.equal(s.textarea.disabled, true);
    reviewButton(s.root, 'Continue after review').click();
    assert.deepEqual(s.rec.calls.at(-1), { name: 'acknowledge-review', value: { sessionId: 's-1', generation: 7 } });
    s.rec.emit({ ...a, conversation: { ...a.conversation, phase: 'blocked' } });
    assert.equal(s.textarea.disabled, true); reviewButton(s.root, 'Reconnect').click();
    assert.equal(s.rec.calls.at(-1).name, 'connect');
  } finally { s.v.dispose(); }
});

test('disconnected Stop stays visible with an honest unavailable state and works after reconnect', async () => {
  const a = baseState({ conversation: { ...baseState().conversation, turn: { streaming: true, text: 'Working', tools: [] } } });
  const s = view(a); await tick();
  try {
    s.rec.emit(droppedFrom(a, { uncertain: null }));
    const stop = s.root.querySelector('.hermes-stop');
    assert.equal(stop.hasClass('hidden'), false); assert.equal(stop.disabled, true);
    assert.match(s.root.textContent, /work may still be running/i);
    stop.click(); assert.equal(s.rec.calls.length, 0);
    s.rec.emit({ ...a, generation: 9 });
    assert.equal(stop.disabled, false); stop.click();
    assert.deepEqual(s.rec.calls.at(-1), { name: 'stop', value: { sessionId: 's-1', generation: 9 } });
  } finally { s.v.dispose(); }
});

test('status errors and request updates have live regions', async () => {
  const s = view(baseState()); await tick();
  try {
    assert.equal(s.root.querySelector('.hermes-bar').attributes['aria-live'], 'polite');
    assert.equal(s.root.querySelector('.hermes-requests').attributes['aria-live'], 'polite');
    assert.equal(s.root.querySelector('.hermes-send-warn').attributes['aria-live'], 'polite');
  } finally { s.v.dispose(); }
});

test('reconnect restores composer focus without stealing focus from outside the pane', async () => {
  const a = baseState(); const s = view(a); await tick();
  try {
    s.textarea.focus(); s.rec.emit(droppedFrom(a));
    assert.equal(document.activeElement, reviewButton(s.root, 'Reconnect'));
    s.rec.emit({ ...droppedFrom(a), status: 'connecting', error: null });
    s.rec.emit({ ...a, generation: 9 });
    assert.equal(document.activeElement, s.textarea);
    s.rec.emit(droppedFrom(a));
    const outside = new FakeNode('button'); outside.focus();
    s.rec.emit({ ...a, generation: 10 }); assert.equal(document.activeElement, outside);
  } finally { s.v.dispose(); document.activeElement = null; }
});

test('a focused answer survives request rendering and reconnect for the exact target', async () => {
  const request = { id: 'r1', method: 'secret', sessionId: 's-1', attributed: true, supported: true, params: { prompt: 'Secret' } };
  const a = baseState({ conversation: { ...baseState().conversation, pendingRequests: [request] } });
  const s = view(a); await tick();
  try {
    editReview(reviewInput(s.root), 'kept'); reviewInput(s.root).focus();
    s.rec.emit(droppedFrom(a)); s.rec.emit({ ...a, generation: 9 });
    assert.equal(document.activeElement, reviewInput(s.root)); assert.equal(reviewInput(s.root).value, 'kept');
  } finally { s.v.dispose(); document.activeElement = null; }
});

for (const action of ['Allow once', 'Refuse']) test(`stale ${action} cannot cross a completed reconnect before the coalesced push`, async () => {
  let gw;
  const remote = { normalizeBaseUrl, probe: async () => ({ authRequired: false, authFlows: [], authProviders: [] }), wsUrl: () => 'ws://fake',
    connectSocket: async () => { gw = fakeGateway(); setImmediate(() => gw.ready()); return { input: gw.input, output: gw.output, socket: gw.socket }; } };
  const hub = createHermesHub({ remote }); let v;
  try {
    await hub.command('configure', { url: `http://${fixtureTailnet}`, localToken: 'fixture' }); await hub.command('connect'); await hub.command('new-session');
    gw.request('reused-id', 'approval', { session_id: 'sess-1', description: 'Old action', choices: ['once', 'deny'] });
    const old = hub.getState(), calls = [], root = new FakeNode('div');
    v = createHermesView({ root, api: { getState: async () => old, onState: () => () => {}, command: (name, value) => { calls.push({ name, value }); return hub.command(name, value); } } });
    await tick(); const oldButton = reviewButton(root, action); assert.ok(oldButton);
    await hub.command('disconnect'); await hub.command('connect'); await hub.command('new-session');
    gw.request('reused-id', 'approval', { session_id: 'sess-1', description: 'New action', choices: ['once', 'deny'] });
    oldButton.click(); await tick();
    assert.equal(calls[0].value.generation, old.generation);
    assert.deepEqual(gw.responses, [], 'stale UI must not answer or refuse the new wire request');
    v.setState(hub.getState()); reviewButton(root, action).click(); await tick();
    assert.equal(gw.responses.length, 1); assert.equal(gw.responses[0].id, 'reused-id');
  } finally { v?.dispose(); hub.dispose(); }
});

test('changed approval contents do not inherit keyboard focus from the prior decision', async () => {
  const request = { id: 'r1', method: 'approval', sessionId: 's-1', attributed: true, supported: true, params: { description: 'Old action', choices: ['once'] } };
  const a = baseState({ conversation: { ...baseState().conversation, pendingRequests: [request] } });
  const s = view(a); await tick();
  try {
    reviewButton(s.root, 'Allow once').focus();
    s.rec.emit({ ...a, conversation: { ...a.conversation, pendingRequests: [{ ...request, params: { ...request.params, description: 'New action' } }] } });
    assert.equal(document.activeElement, s.textarea);
    assert.equal(s.rec.calls.length, 0);
  } finally { s.v.dispose(); document.activeElement = null; }
});

test('review acknowledgement leaves the missing-history warning visible', async () => {
  const a = baseState({ conversation: { ...baseState().conversation, phase: 'review', truncated: { replay: true } } });
  const s = view(a); await tick();
  try {
    reviewButton(s.root, 'Continue after review').click();
    s.rec.emit({ ...a, conversation: { ...a.conversation, phase: 'bound' } });
    assert.equal(s.textarea.disabled, false);
    assert.match(s.root.textContent, /earlier events are unavailable/);
  } finally { s.v.dispose(); }
});

test('a late recovered request does not take focus back from the restored composer', async () => {
  const request = { id: 'r1', method: 'secret', sessionId: 's-1', attributed: true, supported: true, params: { prompt: 'Secret' } };
  const a = baseState({ conversation: { ...baseState().conversation, pendingRequests: [request] } });
  const s = view(a); await tick();
  try {
    reviewInput(s.root).focus(); s.rec.emit(droppedFrom(a));
    s.rec.emit({ ...a, generation: 9, conversation: { ...a.conversation, pendingRequests: [{ ...request, answerable: false }] } });
    assert.equal(document.activeElement, s.textarea);
    s.rec.emit({ ...a, generation: 9 });
    assert.equal(document.activeElement, s.textarea);
  } finally { s.v.dispose(); document.activeElement = null; }
});

test('Stop remains honestly unavailable while a fresh controller is attaching', async () => {
  const a = baseState({ conversation: { ...baseState().conversation, turn: { streaming: true, text: 'Working', tools: [] } } });
  const s = view(a); await tick();
  try {
    s.rec.emit(droppedFrom(a));
    s.rec.emit({ ...a, generation: 9, conversation: { ...a.conversation, phase: 'binding', turn: null } });
    const stop = s.root.querySelector('.hermes-stop');
    assert.equal(stop.hasClass('hidden'), false); assert.equal(stop.disabled, true);
    assert.match(s.root.textContent, /work may still be running/i);
    s.rec.emit({ ...a, generation: 9, conversation: { ...a.conversation, turn: null } });
    assert.equal(stop.hasClass('hidden'), true, 'a fresh idle snapshot is authoritative');
  } finally { s.v.dispose(); }
});
