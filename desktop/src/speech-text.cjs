// Turns an agent's chat reply into text a TTS engine can speak. Runs before
// Kokoro, which truncates at the first newline, spells emoji literally, and
// reads [...] as IPA hints — sanitization is load-bearing, not cosmetic.

function decodeEntities(text) {
  return text.replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, name) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[name])
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code) || 32))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16) || 32));
}

const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu;
const BOX_DRAWING = /[\u2500-\u257F\u2580-\u259F]/;

// Remove or rewrite anything that sounds wrong when read aloud. Returns flags
// so the caller can announce what was dropped ("I put some code in the chat").
function sanitizeForSpeech(raw) {
  const flags = { code: false, table: false, link: false };
  let text = String(raw || '');
  // Fenced code blocks first — their contents must never reach rules below.
  text = text.replace(/```[\s\S]*?(?:```|$)/g, () => { flags.code = true; return '\n'; });
  text = text.replace(/~~~[\s\S]*?(?:~~~|$)/g, () => { flags.code = true; return '\n'; });
  // Tables and box-drawing: drop whole lines.
  text = text.split('\n').filter((line) => {
    if (BOX_DRAWING.test(line)) { flags.table = true; return false; }
    const pipes = (line.match(/\|/g) || []).length;
    if (pipes >= 2 && /\S/.test(line.replace(/\|/g, ''))) { flags.table = true; return false; }
    return true;
  }).join('\n');
  // Images and reference links carry no speakable payload.
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  // Inline links keep their label — the label is the meaningful text.
  text = text.replace(/\[([^\]]*)\]\((?:[^)\s]| [\s\S])*?\)/g, (_, label) => { flags.link = true; return label || 'link'; });
  // Bare URLs have no spoken form.
  text = text.replace(/<?https?:\/\/\S+>?/g, () => { flags.link = true; return 'the link'; });
  // Citation/stage-direction brackets out before Kokoro reads them as IPA.
  text = text.replace(/\[\d+\]/g, '');
  text = text.replace(/\[[^\]\n]{1,40}\]/g, (match) => { const inner = match.slice(1, -1).trim(); return /^[A-Z]{2,}|\s/.test(inner) || /\d/.test(inner) ? '' : inner; });
  text = text.replace(/[\[\]]/g, '');
  // *stage directions* and *emphasis* — emphasis keeps its text either way;
  // italic action narration (*sighs*, *laughs*) reads wrong, so drop verbs-only
  // italics that look like narration.
  text = text.replace(/\*([a-z ]{1,20}(?:s|ing|ed))\*/gi, (m, inner) => inner.split(/\s+/).every(w => /(s|ing|ed)$/i.test(w)) ? '' : inner);
  text = text.replace(/(\*\*|__)(.*?)\1/g, '$2').replace(/(\*|_)(.*?)\1/g, '$2').replace(/~~(.*?)~~/g, '$1');
  text = text.replace(/^#{1,6}\s+/gm, '').replace(/^>\s?/gm, '');
  text = text.replace(/`([^`]+)`/g, '$1').replace(/`/g, '');
  // List markers: keep the item text; a pause reads the structure.
  text = text.replace(/^\s*[-*+]\s+/gm, '').replace(/^\s*\d+[.)]\s+/gm, '');
  // Symbols Kokoro mangles mid-word.
  text = text.replace(/(\S)@(\S)/g, '$1 at $2').replace(/#/g, ' ').replace(/&/g, ' and ').replace(/(?<=\s)\+(?=\s)/g, ' plus ');
  text = text.replace(/(<\/?[a-zA-Z][^>]*>)/g, ' ');
  text = decodeEntities(text);
  text = text.replace(EMOJI, ' ');
  // Kokoro truncation guard: every newline becomes a sentence break.
  text = text.replace(/\n{2,}/g, '. ').replace(/\n/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return { text, flags };
}

const ABBREVS = /(?:mr|mrs|ms|dr|prof|sr|jr|st|vs|etc|e\.g|i\.e|no|fig|approx|dept|inc|ltd|co)\.$/i;
// Split into speakable sentences. Conservative: a boundary needs a following
// space + capital/digit/quote, and abbreviation/decimal tails never split.
function sentences(text) {
  const out = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (!'.!?…'.includes(c)) continue;
    if (i + 1 < text.length && '.!?…'.includes(text[i + 1])) continue; // runs like "!!" close once
    if (c === '.' && i > 0 && /\d/.test(text[i - 1]) && /\d/.test(text[i + 1] || '')) continue; // decimals
    const tail = text.slice(start, i + 1);
    const word = tail.match(/[\w.]+$/);
    if (word && ABBREVS.test(word[0])) continue;
    const next = text.slice(i + 1).match(/\S/);
    if (next && !/[A-Z0-9"'“‘(\[]/.test(next[0]) && c !== '!' && c !== '?') continue;
    const piece = tail.trim();
    if (piece) out.push(piece);
    start = i + 1;
  }
  const rest = text.slice(start).trim();
  if (rest) out.push(rest);
  return out;
}

const SPOKEN_MAX_SENTENCES = 4;
const SPOKEN_MAX_WORDS = 45;
// Alexa's one-breath rule, scaled to agent replies: a handful of sentences,
// then hand off to the thread.
function capForSpeech(text) {
  const parts = sentences(text);
  const kept = [];
  let words = 0;
  for (const part of parts) {
    const count = part.split(/\s+/).length;
    if (kept.length && (kept.length >= SPOKEN_MAX_SENTENCES || words + count > SPOKEN_MAX_WORDS)) break;
    kept.push(part); words += count;
  }
  const truncated = kept.length < parts.length;
  if (truncated) kept.push('Full details are in the chat.');
  return { text: kept.join(' '), truncated, total: parts.length };
}

// One entry point: raw reply → speakable text + what was withheld.
function toSpeech(raw) {
  const { text, flags } = sanitizeForSpeech(raw);
  const { text: capped, truncated } = capForSpeech(text);
  const announcements = [];
  if (flags.code) announcements.push('There is some code in the chat.');
  if (flags.table) announcements.push('There is a table in the chat.');
  if (truncated && !text) return { text: 'I replied in the chat — it was too long to read out.', flags, truncated: true };
  return { text: [capped, ...announcements].filter(Boolean).join(' '), flags, truncated };
}

module.exports = { sanitizeForSpeech, sentences, capForSpeech, toSpeech };
