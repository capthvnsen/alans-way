// Teach by demonstration. The user presses Record on a tab they control and
// does a task once; each click, typed field, choice and page change becomes a
// step {url, action, role, name, selector, value?} that a bot can read and
// turn into a skill. Replay is the bot's own job with its existing actions.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { writePrivateJson } = require('./shell-support.cjs');

const MAX_RECORDINGS = 20, MAX_STEPS = 500, REDACTED = '[redacted]';
const BINDING = '__alansWayRecord', WORLD = 'alans-way-recorder';
// Passwords, card fields and one-time codes, by type or autocomplete token.
const SECRET_TYPES = /^(password|hidden)$/;
const SECRET_AUTOCOMPLETE = /(^|\s)(cc-[a-z-]+|one-time-code|current-password|new-password)(\s|$)/i;
// URL parameters that carry a secret: a GET login form, a magic link, an OAuth code.
const SECRET_PARAM = /pass|pwd|token|secret|otp|code|card|cvc|cvv|auth|session|sig|api_?key/i;

// Runs in an isolated world on each document of the recorded tab, so the page
// can neither see nor call the binding. Only trusted (real user) events count,
// and a secret field's value never leaves the page. Role and name follow the
// snapshot's rules so a bot can match a step to a fresh elements[] entry.
const PAGE_SCRIPT = `(() => {
  if (window.__alansWayRecorder) return;
  window.__alansWayRecorder = true;
  const pick = 'a[href],button,summary,input,textarea,select,label,[onclick],[contenteditable="true"],[contenteditable=""],' + ['button', 'link', 'tab', 'checkbox', 'radio', 'switch', 'menuitem',
    'menuitemcheckbox', 'menuitemradio', 'option', 'treeitem', 'slider', 'combobox', 'textbox', 'searchbox', 'spinbutton'].map(role => '[role="' + role + '"]').join(',');
  const secret = el => (el.localName === 'input' && ${SECRET_TYPES}.test(el.type)) || ${SECRET_AUTOCOMPLETE}.test(el.getAttribute('autocomplete') || '');
  const textEntry = el => el.isContentEditable || el.localName === 'textarea'
    || (el.localName === 'input' && !/^(checkbox|radio|button|submit|reset|image|file|range|color)$/.test(el.type));
  const unique = s => { try { return document.querySelectorAll(s).length === 1; } catch { return false; } };
  const selectorOf = el => {
    if (el.id && unique('#' + CSS.escape(el.id))) return '#' + CSS.escape(el.id);
    for (const attr of ['name', 'data-testid', 'aria-label']) {
      const v = el.getAttribute(attr), s = v && el.localName + '[' + attr + '="' + CSS.escape(v) + '"]';
      if (s && unique(s)) return s;
    }
    const parts = [];
    for (let node = el; node && node.parentElement && parts.length < 6; node = node.parentElement) {
      const same = [...node.parentElement.children].filter(child => child.localName === node.localName);
      parts.unshift(node.localName + (same.length > 1 ? ':nth-of-type(' + (same.indexOf(node) + 1) + ')' : ''));
      if (unique(parts.join(' > '))) break;
    }
    return parts.join(' > ');
  };
  const nameOf = el => {
    let name = '';
    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) name = labelledby.split(/\\s+/).map(id => { const node = document.getElementById(id); return node ? (node.innerText || node.textContent || '').trim() : ''; }).filter(Boolean).join(' ');
    if (!name) name = (el.getAttribute('aria-label') || el.placeholder || el.title || '').trim();
    if (!name && el.labels && el.labels[0]) name = (el.labels[0].innerText || '').trim();
    // A field's value is what the user typed, never its name; only a button input is labelled by it.
    if (!name) name = (el.innerText || (el.localName === 'input' && /^(button|submit|reset)$/.test(el.type) ? el.value : '') || '').trim();
    return name.slice(0, 200);
  };
  const send = (kind, el, value) => {
    const event = { kind, url: location.href, role: el.getAttribute('role') || el.localName, name: nameOf(el), selector: selectorOf(el),
      type: el.localName === 'input' ? el.type : '', autocomplete: el.getAttribute('autocomplete') || '' };
    if (value !== undefined) { if (secret(el)) event.secret = true; else event.value = String(value).slice(0, 2000); }
    try { ${BINDING}(JSON.stringify(event)); } catch {}
  };
  const origin = event => { const el = event.composedPath()[0]; return el && el.nodeType === 1 ? el : null; };
  addEventListener('click', event => {
    const el = event.isTrusted && origin(event), target = el && el.closest(pick);
    // Clicks on plain content are noise. A label passes its click on to its
    // control, a text field is recorded by what is typed into it, and a select
    // by what is chosen.
    if (!target || textEntry(target) || target.localName === 'select' || (target.localName === 'label' && target.control)) return;
    send('click', target);
  }, true);
  addEventListener('input', event => {
    const el = event.isTrusted && origin(event);
    if (el && textEntry(el)) send('input', el, el.isContentEditable ? el.innerText : el.value);
  }, true);
  addEventListener('change', event => {
    const el = event.isTrusted && origin(event);
    if (el && el.localName === 'select') send('change', el, [...el.selectedOptions].map(option => option.label || option.text).join(', '));
  }, true);
  addEventListener('submit', event => { if (event.isTrusted && event.target.localName === 'form') send('submit', event.target); }, true);
})()`;

const ACTIONS = { click: 'click', input: 'type', change: 'select', submit: 'submit' };
const clip = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
function safeUrl(value) {
  try {
    const url = new URL(String(value));
    if (!/^https?:$/.test(url.protocol)) return '';
    url.username = ''; url.password = '';
    for (const [key, value] of [...url.searchParams]) if (value && SECRET_PARAM.test(key)) url.searchParams.set(key, REDACTED);
    if (SECRET_PARAM.test(url.hash)) url.hash = '';
    return url.href.slice(0, 2000);
  } catch { return ''; }
}
function isSecret(raw) {
  return raw.secret === true || SECRET_TYPES.test(String(raw.type || '')) || SECRET_AUTOCOMPLETE.test(String(raw.autocomplete || ''));
}

// A page event becomes a step, or null when it is malformed or not from a web
// page. Secret values are redacted here as well as in the page.
function normalizeEvent(raw) {
  if (!raw || typeof raw !== 'object' || !Object.hasOwn(ACTIONS, raw.kind)) return null;
  const url = safeUrl(raw.url);
  if (!url) return null;
  const step = { url, action: ACTIONS[raw.kind], role: clip(raw.role, 60), name: clip(raw.name, 200), selector: String(raw.selector ?? '').slice(0, 500) };
  if (raw.kind === 'input' || raw.kind === 'change') step.value = isSecret(raw) ? REDACTED : String(raw.value ?? '').slice(0, 2000);
  return step;
}
function navigateStep(url) {
  const href = safeUrl(url);
  return href ? { url: href, action: 'navigate', role: '', name: '', selector: '' } : null;
}

// Adds a step in place: keystrokes in one field become one type step, a
// redirect chain one navigate, and the submit a clicked button caused is
// already that click.
function addStep(steps, step) {
  if (!step) return steps;
  const last = steps[steps.length - 1];
  if (last && step.action === 'type' && last.action === 'type' && last.selector === step.selector && last.url === step.url) steps[steps.length - 1] = step;
  else if (last && step.action === 'navigate' && last.action === 'navigate') steps[steps.length - 1] = step;
  else if (last && step.action === 'navigate' && last.url === step.url) return steps;
  else if (last && step.action === 'submit' && last.action === 'click') return steps;
  else if (steps.length < MAX_STEPS) steps.push(step);
  return steps;
}

// Typed text stays only when the user ticked "keep typed text".
function finishSteps(steps, { keepTyped = false } = {}) {
  return steps.map(step => step.action === 'type' && !keepTyped ? { ...step, value: REDACTED } : { ...step });
}

// One private JSON file per recording under userData/recordings, cached in
// memory so the app state can list them without touching the disk.
const ID = /^[\w-]{8,64}$/;
function createRecordingStore(dir) {
  const file = id => path.join(dir, `${id}.json`);
  let cache = null;
  const load = () => {
    if (cache) return cache;
    let names = [];
    try { names = fs.readdirSync(dir); } catch {}
    cache = names.filter(name => name.endsWith('.json') && ID.test(name.slice(0, -5))).map(name => {
      try { return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { return null; }
    }).filter(record => record && ID.test(record.id) && Array.isArray(record.steps)).sort((a, b) => b.createdAt - a.createdAt);
    return cache;
  };
  const summary = record => ({ id: record.id, title: record.title, startUrl: record.startUrl, createdAt: record.createdAt, steps: record.steps.length, keepTyped: record.keepTyped === true });
  const write = record => { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); writePrivateJson(file(record.id), record); };
  const find = id => load().find(record => record.id === id);
  return {
    list: () => load().map(record => ({ ...summary(record), sharedWith: record.sharedWith || [] })),
    // A bot sees only what the user shared with it.
    listFor: botId => load().filter(record => (record.sharedWith || []).includes(botId)).map(summary),
    getFor(id, botId) {
      const record = find(id);
      return record && (record.sharedWith || []).includes(botId) ? { ...summary(record), steps: record.steps } : null;
    },
    save({ title, steps, keepTyped, sharedWith }) {
      if (load().length >= MAX_RECORDINGS) throw new Error(`You have ${MAX_RECORDINGS} recordings. Delete one in Settings to record another.`);
      const record = { id: crypto.randomUUID(), title: clip(title, 200) || 'Recording', startUrl: steps[0]?.url || '', createdAt: Date.now(),
        keepTyped: keepTyped === true, sharedWith: [...new Set(sharedWith)].map(String), steps };
      write(record);
      cache = [record, ...load()];
      return summary(record);
    },
    share(id, botIds) {
      const record = find(id);
      if (!record) throw new Error('Recording not found.');
      record.sharedWith = [...new Set((Array.isArray(botIds) ? botIds : []).map(String))].slice(0, 100);
      write(record);
    },
    remove(id) {
      if (!find(id)) return;
      fs.rmSync(file(id), { force: true });
      cache = load().filter(record => record.id !== id);
    },
    full: () => load().length >= MAX_RECORDINGS,
  };
}

module.exports = { MAX_RECORDINGS, MAX_STEPS, REDACTED, BINDING, WORLD, PAGE_SCRIPT, normalizeEvent, navigateStep, addStep, finishSteps, createRecordingStore };
