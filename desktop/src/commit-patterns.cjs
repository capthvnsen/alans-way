// What counts as a commit (buy, book, send, post, submit, delete) for the
// app's last check before agent input is dispatched. The plugin router
// (alans-way-agents alans-way/scripts/workspace-router.cjs) judges the same
// actions from outside; the app sees the resolved element.
//
// KEEP IN SYNC: commit-patterns.json is a copy of the router's file of the
// same name, read the same way, and ACTION_URL and isActionUrl below are
// copied from the router. test/commit-patterns.test.cjs compares both when a
// plugin checkout is found, and pins the name list so an edit here is a
// deliberate one made in both places.
const COMMIT_PATTERNS = require('./commit-patterns.json');
const SEP = '[\\s_-]+';
const phrase = (text) => text.split(' ').join(SEP);
const COMMIT_NAME = new RegExp(`(?<![\\p{L}\\p{N}])(?:${COMMIT_PATTERNS.names.map(phrase).join('|')})(?![\\p{L}\\p{N}])|${COMMIT_PATTERNS.namesAnywhere.join('|')}`, 'iu');
const NOT_COMMIT = new RegExp(COMMIT_PATTERNS.notCommit.map(phrase).join('|'), 'giu');
const isCommitName = (name) => COMMIT_NAME.test(String(name).replace(NOT_COMMIT, ' '));
const selectorWords = (selector) => selector.replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2').replace(/[^\p{L}\p{N}]+/gu, ' ');
const READ_ONLY_CDP = /^(?:\w+\.(?:get|describe|query|search|capture|enable|disable)\w*|Emulation\.\w+|Page\.(?:navigate|reload|stopLoading))$/;
const ACTION_URL = new RegExp(`(?<![\\p{L}\\p{N}])(?:confirm|place${SEP}order|order${SEP}place|placeorder|(?:checkout|order)${SEP}complete|pay|buy|submit|delete)(?![\\p{L}\\p{N}])`, 'iu');
// Whether a navigation on a page of `origin` lands on such an address, read
// the way the app reads it (trimmed, and no scheme means https).
function isActionUrl(url, origin) {
  let parsed;
  const address = url.trim();
  try {
    parsed = new URL(/^[a-z][\w+.-]*:\/\//i.test(address) ? address : `https://${address}`);
  } catch {
    return false;
  }
  if (origin && parsed.origin !== origin) return false;
  let words = `${parsed.pathname} ${parsed.search}`;
  try {
    words = decodeURIComponent(words);
  } catch { /* judge it encoded */ }
  return ACTION_URL.test(selectorWords(words));
}

// A page can spell "Pay" so it reads the same to a person but not to a regex:
// fullwidth or styled letters, zero-width or bidi marks, Cyrillic or Greek
// look-alikes. Names are folded to plain Latin before matching.
const INVISIBLE = /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\u{E0000}-\u{E007F}]/gu;
const CONFUSABLE = {
  '\u0410': 'A', '\u0412': 'B', '\u0415': 'E', '\u041A': 'K', '\u041C': 'M', '\u041D': 'H', '\u041E': 'O', '\u0420': 'P', '\u0421': 'C', '\u0422': 'T', '\u0425': 'X', '\u0423': 'Y', '\u0405': 'S', '\u0406': 'I', '\u0408': 'J', '\u04AE': 'Y', '\u0500': 'D', '\u051A': 'Q', '\u051C': 'W',
  '\u0430': 'a', '\u0435': 'e', '\u0451': 'e', '\u043E': 'o', '\u0440': 'p', '\u0441': 'c', '\u0443': 'y', '\u0445': 'x', '\u0455': 's', '\u0456': 'i', '\u0457': 'i', '\u0458': 'j', '\u04BB': 'h', '\u0501': 'd', '\u051B': 'q', '\u051D': 'w', '\u04CF': 'l', '\u04AF': 'y', '\u044C': 'b',
  '\u0391': 'A', '\u0392': 'B', '\u0395': 'E', '\u0396': 'Z', '\u0397': 'H', '\u0399': 'I', '\u039A': 'K', '\u039C': 'M', '\u039D': 'N', '\u039F': 'O', '\u03A1': 'P', '\u03A4': 'T', '\u03A5': 'Y', '\u03A7': 'X',
  '\u03B1': 'a', '\u03B5': 'e', '\u03B9': 'i', '\u03BA': 'k', '\u03BD': 'v', '\u03BF': 'o', '\u03C1': 'p', '\u03C4': 't', '\u03C5': 'u', '\u03C7': 'x', '\u03B3': 'y', '\u0131': 'i', '\u0261': 'g',
};
// Cherokee capitals that read as Latin letters (Ꮲ for P), with their small
// forms, and a few Armenian ones.
for (const [cp, latin] of [[0x13A0, 'D'], [0x13A1, 'R'], [0x13A2, 'T'], [0x13A5, 'i'], [0x13A9, 'Y'], [0x13AA, 'A'], [0x13AB, 'J'], [0x13AC, 'E'], [0x13B3, 'W'], [0x13B7, 'M'], [0x13BB, 'H'], [0x13BD, 'Y'], [0x13C0, 'G'], [0x13C2, 'h'], [0x13C3, 'Z'], [0x13CF, 'b'], [0x13D2, 'R'], [0x13D4, 'W'], [0x13D5, 'S'], [0x13D9, 'V'], [0x13DA, 'S'], [0x13DE, 'L'], [0x13DF, 'C'], [0x13E2, 'P'], [0x13E6, 'K'], [0x13F3, 'G'], [0x13F4, 'B']]) {
  CONFUSABLE[String.fromCodePoint(cp)] = latin;
  CONFUSABLE[String.fromCodePoint(cp < 0x13F0 ? cp - 0x13A0 + 0xAB70 : cp + 8)] = latin.toLowerCase();
}
Object.assign(CONFUSABLE, { '\u0585': 'o', '\u057D': 'u', '\u0570': 'h', '\u0578': 'n', '\u0581': 'g' });
const CONFUSABLES = new RegExp(`[${Object.keys(CONFUSABLE).join('')}]`, 'g');
// A name is read several ways and is a commit if any reading is:
// - plain: width, invisible marks, spacing and case undone; it keeps a name
//   written in Cyrillic or Greek whole, for words from those scripts in the list;
// - folded: look-alike letters mapped to Latin as well;
// - skeleton: decomposed (NFKD) with combining marks and format characters
//   (word joiners, soft hyphens) taken out, look-alikes folded and hyphens
//   inside a word dropped, so "P̲lace order" and "Pur-chase" read plainly;
//   format characters are also read as a space, since "Place<word joiner>order"
//   shows as two words.
const fold = (text) => text.replace(CONFUSABLES, (ch) => CONFUSABLE[ch]);
const plainName = (name) => String(name ?? '').normalize('NFKC').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim().toLowerCase();
const normalizeName = (name) => plainName(fold(String(name ?? '').normalize('NFKC')));
const skeleton = (name, gap) => plainName(fold(String(name ?? '').normalize('NFKD').replace(/\p{M}/gu, '').replace(/\p{Cf}/gu, gap))
  .replace(/(?<=\p{L})[\u002D\u2010\u2011\u2212\uFE63\uFF0D](?=\p{L})/gu, ''));
const readings = (name) => [plainName(name), normalizeName(name), skeleton(name, ''), skeleton(name, ' ')];
const looksLikeCommit = (name) => readings(name).some(isCommitName);

// Whether a page script provably only reads the page, so the commit gate has nothing to judge. An allowlist over
// tokens, not a search for bad words: every name after a dot, and every bare name that is not declared in the script
// itself, must be a known read. Anything else (a call to click or fetch, a write, a computed or dynamic member,
// `new`, `this`, comments, regexes, `${}`) is not provably read-only, and the caller gates it. Not a sandbox: it
// only decides whether the commit check can be skipped.
const READ_MEMBERS = new Set(`title innerText textContent innerHTML outerHTML length href pathname origin search hash host hostname protocol readyState body head
documentElement links forms images children childElementCount parentElement firstElementChild lastElementChild nextElementSibling previousElementSibling tagName id className
classList dataset getAttribute hasAttribute getAttributeNames querySelector querySelectorAll getElementById getElementsByClassName getElementsByTagName closest matches contains
getBoundingClientRect top left right bottom width height x y map filter find findIndex some every forEach reduce slice join includes indexOf lastIndexOf flat flatMap trim
toLowerCase toUpperCase startsWith endsWith split substring charAt at isArray from keys values entries stringify parse min max round floor ceil abs toString toFixed
isNaN isInteger parseInt parseFloat`.split(/\s+/));
const READ_GLOBALS = new Set(['document', 'location', 'Array', 'Math', 'JSON', 'Number', 'String', 'Boolean', 'undefined', 'NaN', 'Infinity', 'innerWidth', 'innerHeight']);
const KEYWORDS = new Set(['typeof', 'const', 'let', 'return', 'if', 'else', 'for', 'of', 'in', 'function']);
const WORDS = new Set([...KEYWORDS, 'null', 'true', 'false']);
const SCRIPT_TOKEN = /\s+|(?<str>"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\$]|\\.|\$(?!\{))*`)|(?<num>\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|(?<id>[A-Za-z_$][\w$]*)|(?<op>\.\.\.|\+\+|--|\?\.|=>|===|!==|==|!=|<=|>=|&&|\|\||\?\?|[-+*%!<>=?:,;.(){}[\]])/y;
function isReadOnlyScript(source) {
  const tokens = [];
  SCRIPT_TOKEN.lastIndex = 0;
  const text = String(source);
  while (SCRIPT_TOKEN.lastIndex < text.length) {
    const m = SCRIPT_TOKEN.exec(text);
    if (!m) return false;
    if (m.groups.str !== undefined) tokens.push({ t: 'str', v: m.groups.str });
    else if (m.groups.num !== undefined) tokens.push({ t: 'num', v: m.groups.num });
    else if (m.groups.id !== undefined) tokens.push({ t: 'id', v: m.groups.id });
    else if (m.groups.op !== undefined) tokens.push({ t: 'op', v: m.groups.op });
  }
  if (!tokens.length) return false;
  const locals = new Set();
  const isId = (tok) => tok?.t === 'id';
  // Parameters are plain names only: a destructured one (`({ submit: s }) => ...`) would pull out a method by a name
  // this check never sees after a dot, and forEach(s, form) would then call it.
  const param = (tok) => tok.v === ',' || (isId(tok) && !WORDS.has(tok.v) && Boolean(locals.add(tok.v)));
  // Names the script declares itself: const/let names and the parameters of function expressions and arrows.
  for (let i = 0; i < tokens.length; i++) {
    const { t, v } = tokens[i];
    if (t === 'id' && (v === 'const' || v === 'let') && isId(tokens[i + 1])) locals.add(tokens[i + 1].v);
    if (t === 'op' && v === '=>') {
      if (isId(tokens[i - 1])) locals.add(tokens[i - 1].v);
      else if (tokens[i - 1]?.v === ')') for (let j = i - 2; j >= 0 && tokens[j].v !== '('; j--) if (!param(tokens[j])) return false;
    }
    if (t === 'id' && v === 'function' && tokens[i + 1]?.v === '(') for (let j = i + 2; j < tokens.length && tokens[j].v !== ')'; j++) if (!param(tokens[j])) return false;
  }
  const depth = { '(': 0, '[': 0, '{': 0 };
  const close = { ')': '(', ']': '[', '}': '{' };
  for (let i = 0; i < tokens.length; i++) {
    const { t, v } = tokens[i];
    const prev = tokens[i - 1];
    const next = tokens[i + 1];
    const afterValue = prev && (prev.t === 'op' ? prev.v === ')' || prev.v === ']' : !KEYWORDS.has(prev.v));
    if (t === 'str') { if (v[0] === '`' && afterValue) return false; continue; }
    if (t === 'num') continue;
    if (t === 'id') {
      if (prev?.v === '.' || prev?.v === '?.') { if (!READ_MEMBERS.has(v)) return false; continue; }
      if (WORDS.has(v)) {
        // `function` only as an anonymous expression; `in` and `of` are loop and test words.
        if (v === 'function' && next?.v !== '(') return false;
        continue;
      }
      if (READ_GLOBALS.has(v) || locals.has(v)) continue;
      // A key in an object literal: `{ count: rows.length }`.
      if (next?.v === ':' && (prev?.v === '{' || prev?.v === ',')) continue;
      return false;
    }
    if (v === '=') {
      if (!(isId(prev) && locals.has(prev.v) && tokens[i - 2]?.v !== '.' && tokens[i - 2]?.v !== '?.')) return false;
      continue;
    }
    if (v === '++' || v === '--') return false;
    if (v === '.' || v === '?.') { if (!isId(next)) return false; continue; }
    if (v === '[') {
      // Index with a plain number only; any other computed member could spell fetch or click.
      if (afterValue && !(next?.t === 'num' && tokens[i + 2]?.v === ']')) return false;
    }
    if (v in depth) depth[v]++;
    if (v in close && --depth[close[v]] < 0) return false;
  }
  return !depth['('] && !depth['['] && !depth['{'];
}

module.exports = { isReadOnlyScript, COMMIT_PATTERNS, isCommitName, plainName, normalizeName, readings, looksLikeCommit, isActionUrl, READ_ONLY_CDP };
