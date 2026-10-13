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
const CONFUSABLES = new RegExp(`[${Object.keys(CONFUSABLE).join('')}]`, 'g');
function normalizeName(name) {
  return String(name ?? '').normalize('NFKC').replace(INVISIBLE, '').replace(CONFUSABLES, (ch) => CONFUSABLE[ch])
    .replace(/\s+/g, ' ').trim().toLowerCase();
}
const looksLikeCommit = (name) => isCommitName(normalizeName(name));

module.exports = { COMMIT_PATTERNS, isCommitName, normalizeName, looksLikeCommit, isActionUrl, READ_ONLY_CDP };
