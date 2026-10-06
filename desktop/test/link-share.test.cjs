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
