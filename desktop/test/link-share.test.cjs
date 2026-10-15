// node --test test/link-share.test.cjs
const assert = require('node:assert/strict');
const test = require('node:test');
const { firstLink, scanLinks } = require('../src/link-share.cjs');

function msg(text, extra = {}) {
  return { content: { text: { text, ...(extra.entities ? { entities: extra.entities } : {}) } }, ...extra.fields };
}

test('plain text url is detected', () => {
  assert.equal(firstLink(msg('check https://example.com/a?b=1 now')), 'https://example.com/a?b=1');
});

test('no url returns empty', () => {
  assert.equal(firstLink(msg('nothing here v1.2 ok')), '');
  assert.equal(firstLink({}), '');
});

test('text-url entity url wins over plain text', () => {
  const url = firstLink(msg('click this', { entities: [{ type: 'MessageEntityTextUrl', offset: 0, length: 4, url: 'https://target.example/x' }] }));
  assert.equal(url, 'https://target.example/x');
});

test('url entity slices the covered text', () => {
  const url = firstLink(msg('see https://sliced.example here', {
    entities: [{ type: 'MessageEntityUrl', offset: 4, length: 22 }] }));
  assert.equal(url, 'https://sliced.example');
});

test('telegram-internal links are skipped', () => {
  assert.equal(firstLink(msg('https://t.me/somebot')), '');
  assert.equal(firstLink(msg('https://web.telegram.org/a/#123')), '');
});

test('trailing punctuation is stripped by the regex boundary', () => {
  assert.equal(firstLink(msg('open https://a.b/c.')).endsWith('/c'), true);
});

function fixture() {
  return { seen: new Map(), sent: new Set(), sentMessages: [] };
}
function scan(fx, lastId, byId) {
  scanLinks({ userId: '42', byId, lastId, currentUserId: 'me',
    seen: fx.seen, sent: fx.sent, send: v => fx.sentMessages.push(v) });
}

// The RC.2 live repro's outgoing message used TextUrl, not Url, entities.
// Its preview was populated too; neither representation opts into auto-open.
for (const outgoing of [false, true]) {
  for (const preview of [false, true]) {
    test(`filename TextUrl message never opens a tab (outgoing=${outgoing}, preview=${preview})`, () => {
      const message = { isOutgoing: outgoing, content: {
        ...(preview ? { webPage: { url: 'http://SKILL.md/', title: 'Agent Skills' } } : {}),
        text: {
          text: 'Filename display test only: SKILL.md and setup.sh. Reply noted; do not open anything or take any other action.',
          entities: [
            { type: 'MessageEntityTextUrl', offset: 28, length: 8, url: 'http://SKILL.md/' },
            { type: 'MessageEntityTextUrl', offset: 41, length: 8, url: 'http://setup.sh/' },
          ],
        },
      } };
      const fx = fixture();
      scan(fx, 7, { 7: msg('previous message') });
      scan(fx, 8, { 8: message });
      assert.deepEqual(fx.sentMessages, [], 'no telegram:link IPC means no tab creation or activation');
      assert.equal(fx.seen.get('42'), 8);
      assert.equal(fx.sent.size, 0);
    });
  }
}

for (const label of ['SKILL.md', 'setup.sh', 'config.yaml', 'README.md', 'example.com', 'example.com/docs', 'example.com:8080/docs', ' SKILL.md ']) {
  test(`TextUrl bare filename or host label is ignored: ${label}`, () => {
    const entity = { type: 'MessageEntityTextUrl', offset: 0, length: label.length, url: 'https://target.example/docs' };
    assert.equal(firstLink(msg(label, { entities: [entity] })), '');
    assert.equal(firstLink(msg(label + ' https://explicit.example', { entities: [entity] })), 'https://explicit.example');
    assert.equal(firstLink(msg(label + ' documentation', { entities: [entity,
      { type: 'MessageEntityTextUrl', offset: label.length + 1, length: 13, url: 'https://docs.example' },
    ] })), 'https://docs.example');
  });
}

for (const label of ['https://example.com', 'http://example.com', 'HTTPS://example.com', 'Documentation v1.2', 'Read the docs.']) {
  test(`intentional TextUrl label is preserved: ${label}`, () => {
    assert.equal(firstLink(msg(label, { entities: [
      { type: 'MessageEntityTextUrl', offset: 0, length: label.length, url: 'https://target.example/docs' },
    ] })), 'https://target.example/docs');
  });
}

for (const { text, entities, expected } of [
  ...['SKILL.md', 'setup.sh', 'config.yaml', 'README.md', 'example.com'].map(text => ({
    text, entities: [{ type: 'MessageEntityUrl', offset: 0, length: text.length }], expected: '',
  })),
  { text: 'https://example.com', entities: [{ type: 'MessageEntityUrl', offset: 0, length: 19 }], expected: 'https://example.com' },
  { text: 'http://example.com', entities: [{ type: 'MessageEntityUrl', offset: 0, length: 18 }], expected: 'http://example.com' },
  { text: 'HTTPS://example.com', expected: 'HTTPS://example.com' },
  { text: 'documentation', entities: [{ type: 'MessageEntityTextUrl', offset: 0, length: 13, url: 'https://example.com/docs' }], expected: 'https://example.com/docs' },
  { text: 'documentation (bare text_link target)', entities: [{ type: 'MessageEntityTextUrl', offset: 0, length: 13, url: 'example.com/docs' }], expected: 'https://example.com/docs' },
  { text: 'setup.sh https://example.com', entities: [
    { type: 'MessageEntityUrl', offset: 0, length: 8 },
    { type: 'MessageEntityUrl', offset: 9, length: 19 },
  ], expected: 'https://example.com' },
  { text: 'SKILL.md https://example.com', entities: [{ type: 'MessageEntityUrl', offset: 0, length: 8 }], expected: 'https://example.com' },
]) {
  test(`auto-open requires an explicit scheme or text_link: ${text}`, () => {
    const message = msg(text, { entities });
    assert.equal(firstLink(message), expected);
    const fx = fixture();
    scan(fx, 7, { 7: msg('previous message') });
    scan(fx, 8, { 8: message });
    assert.deepEqual(fx.sentMessages, expected ? [{ chatId: '42', url: expected, outgoing: false }] : []);
    assert.equal(fx.seen.get('42'), 8, 'ignored filenames still advance the scan');
  });
}

test('first observation seeds the watermark without emitting', () => {
  const fx = fixture();
  scan(fx, 7, { 7: msg('https://old.example') });
  assert.equal(fx.sentMessages.length, 0);
});

test('a new message with a link emits once', () => {
  const fx = fixture();
  scan(fx, 7, { 7: msg('hi') });
  scan(fx, 8, { 7: msg('hi'), 8: msg('look https://new.example') });
  assert.deepEqual(fx.sentMessages.map(m => m.url), ['https://new.example']);
  assert.equal(fx.sentMessages[0].chatId, '42');
  scan(fx, 8, { 7: msg('hi'), 8: msg('look https://new.example') });
  assert.equal(fx.sentMessages.length, 1, 'repeat tick does not re-emit');
});

test('outgoing flag follows sender', () => {
  const fx = fixture();
  scan(fx, 5, { 5: msg('x') });
  scan(fx, 7, { 6: msg('bot link https://bot.example'), 7: { ...msg('mine https://me.example'), isOutgoing: true } });
  assert.equal(fx.sentMessages.length, 2);
  assert.equal(fx.sentMessages[0].outgoing, false);
  assert.equal(fx.sentMessages[1].outgoing, true);
});

test('a link is not lost when the last id is known before its message body', () => {
  const fx = fixture();
  scan(fx, 7, { 7: msg('hi') });
  scan(fx, 8, { 7: msg('hi') });
  assert.equal(fx.sentMessages.length, 0);
  scan(fx, 8, { 7: msg('hi'), 8: msg('look https://late.example') });
  assert.deepEqual(fx.sentMessages.map(m => m.url), ['https://late.example']);
  scan(fx, 8, { 8: msg('look https://late.example') });
  assert.equal(fx.sentMessages.length, 1, 'still emitted once');
});

test('the watermark advances only past ids whose message is present', () => {
  const fx = fixture();
  scan(fx, 5, { 5: msg('x') });
  scan(fx, 9, { 6: msg('a https://six.example') });
  assert.deepEqual(fx.sentMessages.map(m => m.url), ['https://six.example']);
  assert.equal(fx.seen.get('42'), 6);
  scan(fx, 9, { 6: msg('a https://six.example'), 9: msg('b https://nine.example') });
  assert.deepEqual(fx.sentMessages.map(m => m.url), ['https://six.example', 'https://nine.example']);
  assert.equal(fx.seen.get('42'), 9);
});
