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
// Fields whose id, name or label says they hold a secret stay redacted even
// when the user keeps typed text.
const SECRET_WORDS = new Set(['password', 'passwd', 'pwd', 'passcode', 'pin', 'otp', 'totp', 'token', 'secret', 'cvv', 'cvv2', 'cvc', 'csc', 'cvn', 'ssn', 'sin']);
// Matched against a label with case, spaces, _ and - removed, so security code,
// security_code, security-code and securityCode all read securitycode. Card
// fields often have no autocomplete attribute, only a name like ccnum.
const SECRET_PHRASE = /securitycode|socialsecurity|verificationcode|onetime(code|pass|pin)|cardnum|creditcard|ccnum|cvc|cvv|cardexp|ccexp|exp(iry|iration)?(date|month|year|mm|yy)/;
// "card no" and "cc no" count only at a word edge, ending the name or before
// a digit or "number". It is matched against the label split into words, so
// spaces, _- and camelCase all mark edges: paymentCardNo is a card field,
// postcard_notes, gift card note and acc_no are not.
const CARD_NO = /(^|[^a-z0-9])(?:card|cc)[\s._-]*no(?:[\s._-]*number)?($|[^a-z])/;
// A run-together lowercase word ending in "cardno"/"ccno" (paymentcardno,
// customerccno, ccno2) is a card field too; "acc" before "no" is not.
const CARD_NO_TAIL = /(?:card|(?<!a)cc)no(?:number)?\d*$/;

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
  const textEntry = el => el.isContentEditable || el.localName === 'textarea' || /^(textbox|searchbox)$/.test(el.getAttribute('role') || '')
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
    // What is typed into a field is never its name: a text field is named only
    // by its label, aria-label, placeholder or title, and a label or labelling
    // node loses any form controls inside it first.
    const typed = textEntry(el) || el.localName === 'input';
    const labelText = node => {
      const copy = node.cloneNode(true);
      copy.querySelectorAll('input,textarea,select,[contenteditable],[role=textbox],[role=searchbox]').forEach(control => control.remove());
      return (copy.textContent || '').replace(/\\s+/g, ' ').trim();
    };
    let name = '';
    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) name = labelledby.split(/\\s+/).map(id => { const node = document.getElementById(id); return node && !node.contains(el) ? labelText(node) : ''; }).filter(Boolean).join(' ');
    if (!name) name = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.title || '').trim();
    if (!name && el.labels && el.labels[0]) name = labelText(el.labels[0]);
    if (!name && !typed) name = (el.innerText || '').trim();
    // Only a button input is labelled by its value.
    if (!name && el.localName === 'input' && /^(button|submit|reset)$/.test(el.type)) name = (el.value || '').trim();
    return name.slice(0, 200);
  };
  const send = (kind, el, value) => {
    const event = { kind, url: location.href, role: el.getAttribute('role') || el.localName, name: nameOf(el), selector: selectorOf(el),
      type: el.localName === 'input' ? el.type : '', autocomplete: el.getAttribute('autocomplete') || '', field: [el.id, el.getAttribute('name') || ''].join(' ') };
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
// A path segment that looks like a key rather than a word: a hex id or UUID,
// or a long run of mixed letters and digits that is not a hyphenated slug.
function opaqueSegment(segment) {
  if (/^[0-9a-f-]{16,}$/i.test(segment) && /\d/.test(segment)) return true;
  return segment.length >= 20 && /^[\w.~%-]+$/.test(segment) && /\d/.test(segment) && /[a-z]/i.test(segment) && !/^[a-z]+(-[a-z0-9]+)+$/i.test(segment);
}
// Only the origin and path are kept: query strings and fragments carry search
// terms, form fields sent by GET, magic links and OAuth codes, and opaque
// tokens in the path (reset links, invites) are redacted.
function safeUrl(value) {
  try {
    const url = new URL(String(value));
    if (!/^https?:$/.test(url.protocol)) return '';
    const path = url.pathname.split('/').map(segment => opaqueSegment(segment) ? REDACTED : segment).join('/');
    return (url.origin + path).slice(0, 2000);
  } catch { return ''; }
}
const words = value => String(value || '').replace(/([a-z\d])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/);
function isSecret(raw) {
  if (raw.secret === true || SECRET_TYPES.test(String(raw.type || '')) || SECRET_AUTOCOMPLETE.test(String(raw.autocomplete || ''))) return true;
  const labels = [raw.name, raw.field, raw.selector].map(String);
  return labels.some(label => {
    const parts = words(label);
    return SECRET_PHRASE.test(label.toLowerCase().replace(/[^a-z0-9]/g, '')) || CARD_NO.test(parts.join(' ')) || parts.some(word => SECRET_WORDS.has(word) || CARD_NO_TAIL.test(word));
  });
}

// A page event becomes a step, or null when it is malformed or not from a web
// page. Secret values are redacted here as well as in the page.
function normalizeEvent(raw) {
  if (!raw || typeof raw !== 'object' || !Object.hasOwn(ACTIONS, raw.kind)) return null;
  const url = safeUrl(raw.url);
  if (!url) return null;
  const step = { url, action: ACTIONS[raw.kind], role: clip(raw.role, 60), name: clip(raw.name, 200), selector: String(raw.selector ?? '').slice(0, 500) };
  if (raw.kind === 'input' || raw.kind === 'change') step.value = isSecret(raw) ? REDACTED : String(raw.value ?? '').slice(0, 2000);
  // Backstop: a name read from the field's own contents is exactly its text.
  if (raw.kind === 'input' && step.name && step.name === clip(raw.value, 200)) step.name = '';
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

// Typed text stays only when the user ticked "keep typed text". Without it,
// a page that echoes what was typed must not carry it to disk either: a path
// segment, title, step name or selector holding a typed value or one of its
// 3+ letter words as a substring (/search/<term>, /s/<term>.html,
// /prefix<term>suffix, a clicked suggestion) is redacted.
const plain = value => { try { value = decodeURIComponent(value); } catch {} return value.toLowerCase().replace(/[\s+_-]+/g, ' ').trim(); };
function finishRecording(steps, { keepTyped = false, title = '', fallbackTitle = '' } = {}) {
  if (keepTyped) return { title, steps: steps.map(step => ({ ...step })) };
  const typed = steps.filter(step => step.action === 'type' && step.value !== REDACTED).map(step => plain(step.value)).filter(value => value.length >= 2);
  const terms = [...new Set(typed.flatMap(value => words(value)).filter(word => word.length >= 3))];
  const leaks = text => {
    const flat = plain(text);
    return typed.some(value => value.length >= 3 ? flat.includes(value) : flat === value) || terms.some(term => flat.includes(term));
  };
  const scrub = href => {
    const url = new URL(href);
    return url.origin + url.pathname.split('/').map(segment => segment && leaks(segment) ? REDACTED : segment).join('/');
  };
  return {
    title: !title || leaks(title) ? fallbackTitle : title,
    steps: steps.map(step => ({ ...step, url: scrub(step.url),
      ...(step.action === 'type' ? { value: REDACTED } : {}),
      ...(leaks(step.name) ? { name: REDACTED } : {}),
      ...(leaks(step.selector) ? { selector: REDACTED } : {}) })),
  };
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

module.exports = { MAX_RECORDINGS, MAX_STEPS, REDACTED, BINDING, WORLD, PAGE_SCRIPT, normalizeEvent, navigateStep, addStep, finishRecording, createRecordingStore };
