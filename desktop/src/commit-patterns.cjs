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
const READ_ONLY_CDP = /^(?:\w+\.(?:get|describe|query|search|capture|enable|disable)|Emulation\.|Page\.(?:navigate|reload|stopLoading)$)/;
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

module.exports = { COMMIT_PATTERNS, isCommitName, plainName, normalizeName, readings, looksLikeCommit, isActionUrl, READ_ONLY_CDP };
