const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeForSpeech, sentences, capForSpeech, toSpeech } = require('../src/speech-text.cjs');

test('strips fenced code and flags it', () => {
  const { text, flags } = sanitizeForSpeech('Here is the fix:\n```js\nconst x = 1;\n```\nDone.');
  assert.equal(flags.code, true);
  assert.ok(!text.includes('const x'));
  assert.ok(text.includes('Here is the fix'));
});

test('drops tables and flags them', () => {
  const { text, flags } = sanitizeForSpeech('| a | b |\n| --- | --- |\n| 1 | 2 |\nSummary line.');
  assert.equal(flags.table, true);
  assert.ok(!text.includes('|'));
  assert.ok(text.includes('Summary line.'));
});

test('keeps link labels, rewrites bare urls', () => {
  const { text, flags } = sanitizeForSpeech('See [the docs](https://example.com/a) and https://x.io/b.pdf now.');
  assert.equal(flags.link, true);
  assert.ok(text.includes('the docs'));
  assert.ok(text.includes('the link'));
  assert.ok(!text.includes('https'));
});

test('markdown markers survive as plain words', () => {
  const { text } = sanitizeForSpeech('Use **bold** and `inline code` — done.\n\n# Title\n> quote');
  assert.ok(text.includes('bold'));
  assert.ok(text.includes('inline code'));
  assert.ok(!/[#>*`]/.test(text));
});

test('newlines become sentence breaks, whitespace collapses', () => {
  const { text } = sanitizeForSpeech('Line one\nLine two\n\n\nPara two');
  assert.ok(!text.includes('\n'));
  assert.ok(text.includes('Line one Line two. Para two'));
});

test('emoji and box chars are removed', () => {
  const { text } = sanitizeForSpeech('Great news 🎉 — done ✅');
  assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(text));
  assert.ok(text.includes('Great news'));
});

test('bracketed citation noise is dropped, brackets never survive', () => {
  const { text } = sanitizeForSpeech('Result [1] was clear [NOTE: checked].');
  assert.ok(!text.includes('[') && !text.includes(']'));
});

test('sentences split on real boundaries only', () => {
  assert.deepEqual(sentences('Dr. Smith left. He went home.'), ['Dr. Smith left.', 'He went home.']);
  assert.deepEqual(sentences('Version 3.5 ships today. Really.'), ['Version 3.5 ships today.', 'Really.']);
  assert.deepEqual(sentences('No punctuation at all'), ['No punctuation at all']);
});

test('cap limits spoken length and appends the handoff', () => {
  const long = Array.from({ length: 8 }, (_, i) => `Sentence number ${i + 1} explains more.`).join(' ');
  const { text, truncated } = capForSpeech(long);
  assert.equal(truncated, true);
  assert.ok(text.endsWith('Full details are in the chat.'));
  assert.ok(text.split(/\s+/).length <= 60);
});

test('toSpeech announces dropped content', () => {
  const { text, flags } = toSpeech('Sure.\n```python\nprint(1)\n```');
  assert.equal(flags.code, true);
  assert.ok(text.includes('code in the chat'));
});
