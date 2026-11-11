const test = require('node:test');
const assert = require('node:assert/strict');
const markdownit = require('markdown-it');
const { parseDirective, renderMarkdown, setupMarkdown } = require('../src/native-chat.js');

const md = setupMarkdown(markdownit({ html: false, linkify: true }));

test('parseDirective reads ::name{key="value"} and only that', () => {
  assert.deepEqual(parseDirective('::link{title="Docs" url="https://example.com/a?b=1"}'), { name: 'link', attrs: { title: 'Docs', url: 'https://example.com/a?b=1' } });
  assert.deepEqual(parseDirective('  ::preview{file="out/report.html"}  '), { name: 'preview', attrs: { file: 'out/report.html' } });
  assert.deepEqual(parseDirective('::card{title="Pick" action="Yes" action="No"}'), { name: 'card', attrs: { title: 'Pick', action: ['Yes', 'No'] } });
  assert.deepEqual(parseDirective('::empty{}'), { name: 'empty', attrs: {} });
  for (const text of ['see ::link{url="x"}', '::link{url="x"} trailing', '::link{url=x}', '::link{url="a\nb"}', ':link{url="x"}', '::1bad{}', '']) assert.equal(parseDirective(text), null, text);
});

test('a directive renders as a block only when it is the whole paragraph', () => {
  const out = renderMarkdown(md, 'Intro.\n\n::file{name="a.txt" size="12" path="/tmp/a.txt"}\n\nInline ::file{name="b"} stays prose.');
  assert.deepEqual(out.blocks, [{ name: 'file', attrs: { name: 'a.txt', size: '12', path: '/tmp/a.txt' }, raw: '::file{name="a.txt" size="12" path="/tmp/a.txt"}' }]);
  assert.match(out.html, /<div class="nc-slot" data-block="0"><\/div>/);
  assert.match(out.html, /Inline ::file\{name=&quot;b&quot;\} stays prose\./);
});

test('raw HTML stays text, links are linkified, javascript: links are dropped', () => {
  const out = renderMarkdown(md, '<img src=x onerror=alert(1)> <script>x</script> https://example.com [bad](javascript:alert(1))');
  assert.doesNotMatch(out.html, /<img|<script/);
  assert.match(out.html, /&lt;script&gt;/);
  assert.match(out.html, /<a href="https:\/\/example\.com">/);
  assert.doesNotMatch(out.html, /href="javascript/);
});

test('fenced code gets a language label and copy source; tables keep their markdown', () => {
  const src = 'Text\n\n| Name | Count |\n|---|---|\n| a | 1 |\n\n```js\nconst x = "<b>";\n```';
  const out = renderMarkdown(md, src);
  assert.deepEqual(out.codes, ['const x = "<b>";\n']);
  assert.match(out.html, /<div class="nc-code-head"><span>js<\/span>/);
  assert.match(out.html, /&lt;b&gt;/);
  assert.deepEqual(out.tables, ['| Name | Count |\n|---|---|\n| a | 1 |']);
  assert.match(out.html, /<div class="nc-table-scroll"><table>/);
});

test('an html widget fence becomes a widget slot, and a placeholder while streaming', () => {
  const src = '```html widget\n<button>Hi</button>\n```';
  assert.deepEqual(renderMarkdown(md, src).widgets, ['<button>Hi</button>\n']);
  assert.match(renderMarkdown(md, src).html, /data-widget="0"/);
  assert.doesNotMatch(renderMarkdown(md, src, { streaming: true }).html, /data-widget/);
  assert.match(renderMarkdown(md, '```html\n<b>x</b>\n```').html, /nc-code/, 'plain html fences stay code');
});

test('$…$ is inline code-styled text, not a price', () => {
  assert.match(renderMarkdown(md, 'math $a^2+b^2$ here').html, /<code class="nc-math">a\^2\+b\^2<\/code>/);
  assert.doesNotMatch(renderMarkdown(md, 'costs $5 and $10').html, /nc-math/);
});
