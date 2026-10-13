const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { COMMIT_PATTERNS, isCommitName, normalizeName, looksLikeCommit, isActionUrl } = require('../src/commit-patterns.cjs');

const COMMITS = ['Place order', 'Place your order', 'Pay', 'Buy now', 'Buy-now', 'buy_now', 'Purchase', 'Confirm and pay', 'Complete booking', 'Book now', 'Reserve',
  'Request to book', 'Confirm order', 'Submit order', 'Order now', 'Send', 'Post', 'Publish', 'Submit', 'Easy Apply', 'Delete', 'Subscribe', 'Donate', 'Transfer',
  'Jetzt bezahlen', 'Kauf abschließen', 'Valider la commande', 'Réserver', 'Realizar pedido', '注文を確定する',
  'Complete reservation', 'Confirm reservation', 'Confirm', 'Confirm payment', 'Make payment', 'Reply', 'Comment', 'Remove', 'Schedule Event', 'Place bid', 'Close account',
  'Pay with Google Pay now', 'Confirm email and pay'];
const LOOK_ALIKES = ['Add to cart', 'Send code', 'Send me a verification code', 'Pay with Google Pay', 'Pay with PayPal', 'Purchase history', 'Delete filter', 'Remove filter', 'Brand filter, remove',
  'Confirm email', 'Confirm password', 'Confirm your e-mail address', 'Address book', 'Comments', 'Replies', 'Booking details', 'Cancel subscription', 'Repay', 'Sendung verfolgen'];

test('commit names match, and the look-alikes the router lets through stay allowed', () => {
  for (const name of COMMITS) assert.equal(looksLikeCommit(name), true, name);
  for (const name of LOOK_ALIKES) assert.equal(looksLikeCommit(name), false, name);
});

test('names are folded before matching: NFKC, zero-width and bidi marks, Cyrillic and Greek look-alikes, spacing and case', () => {
  assert.equal(normalizeName('\uFF30\uFF4C\uFF41\uFF43\uFF45\u3000\uFF2F\uFF32\uFF24\uFF25\uFF32'), 'place order', 'fullwidth letters and spaces');
  assert.equal(normalizeName('𝐁𝐮𝐲 𝐧𝐨𝐰'), 'buy now', 'styled math letters');
  assert.equal(normalizeName('Pl\u200Bace\u00AD or\u200Dder\uFEFF'), 'place order', 'zero-width and soft hyphen');
  assert.equal(normalizeName('\u202EPay\u202C'), 'pay', 'bidi controls');
  assert.equal(normalizeName('P\u0430y'), 'pay', 'Cyrillic a');
  assert.equal(normalizeName('\u0421\u041E\u041D\u0424\u0406RM'), 'co\u043D\u0444irm'.replace('\u043D', 'h').replace('\u0444', '\u0444'), 'only look-alikes are folded');
  assert.equal(normalizeName('\u0392\u03A5\u03A5'), 'byy', 'Greek capitals');
  assert.equal(normalizeName('  Buy \n\t now  '), 'buy now');
  for (const sly of ['P\u0430y', 'Pl\u200Bace order', '\uFF22\uFF55\uFF59 \uFF4E\uFF4F\uFF57', 'D\u0435lete', '\u0405ubmit', 'S\u0435nd', 'C\u043Enfirm']) {
    assert.equal(isCommitName(sly), false, `the raw router regex misses ${JSON.stringify(sly)}`);
    assert.equal(looksLikeCommit(sly), true, `folded, ${JSON.stringify(sly)} is a commit`);
  }
  assert.equal(looksLikeCommit('Send c\u043Ede'), false, 'folding keeps a look-alike exception working');
});

test('a same-origin address that reads like an action is one; another origin or an ordinary place page is not', () => {
  const origin = 'https://shop.example';
  for (const url of ['https://shop.example/checkout/complete', 'shop.example/orders/7/delete', 'https://shop.example/cart?step=confirm', 'https://shop.example/placeOrder'])
    assert.equal(isActionUrl(url, origin), true, url);
  for (const url of ['https://other.example/checkout/complete', 'https://shop.example/maps/place/x', 'https://shop.example/cart'])
    assert.equal(isActionUrl(url, origin), false, url);
});

// Pinned so an edit here is deliberate; the same edit goes to the router's copy.
test('the commit name list is the one the router was given', () => {
  assert.deepEqual(COMMIT_PATTERNS.names, [
    'place order', 'place your order', 'complete order', 'order now', 'purchase', 'buy',
    'pay(?:ment)?', 'confirm', 'book', 'complete booking', 'reserv(?:e|ation)',
    'send', 'post', 'publish', 'reply', 'comment', 'submit', 'easy apply',
    'delete', 'remove', 'close account', 'subscribe', 'donate', 'transfer', 'schedule', 'bid',
    'bestellen', 'kauf abschlie(?:ß|ss)en', 'kaufen', 'bezahlen',
    'commander', 'payer', 'valider la commande', 'confirmer la commande', 'réserver',
    'comprar', 'pagar', 'realizar pedido', 'confirmar pedido',
  ]);
  assert.equal(COMMIT_PATTERNS.notCommit.length, 6);
});

// The router (alans-way-agents PR #89) reads its own commit-patterns.json.
// With a plugin checkout beside this repo, or ALANS_WAY_AGENTS pointing at
// one, the two files must be the same and both sides must judge every name
// and address the same way.
function routerCheckout() {
  const roots = [process.env.ALANS_WAY_AGENTS, path.resolve(__dirname, '../../../alans-way-agents'), path.join(os.homedir(), 'alans-way-agents')].filter(Boolean);
  return roots.map((root) => path.join(root, 'alans-way/scripts')).find((dir) => fs.existsSync(path.join(dir, 'commit-patterns.json'))) || null;
}
const routerDir = routerCheckout();
test('the router copy is the same list and judges every name the same way', { skip: !routerDir && 'no alans-way-agents checkout with commit-patterns.json (set ALANS_WAY_AGENTS)' }, () => {
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(routerDir, 'commit-patterns.json'), 'utf8')), COMMIT_PATTERNS, `${routerDir}/commit-patterns.json and src/commit-patterns.json differ`);
  const router = require(path.join(routerDir, 'workspace-router.cjs'));
  assert.deepEqual([...COMMITS, ...LOOK_ALIKES].filter((name) => router.isCommitName(name) !== isCommitName(name)), [], 'the router and the app disagree on these names');
  if (router.isActionUrl) for (const url of ['https://s.example/order/complete', 'https://s.example/buy', ' https://s.example/x?step=confirm ', 'https://s.example/maps/place/x'])
    assert.equal(router.isActionUrl(url, 'https://s.example'), isActionUrl(url, 'https://s.example'), url);
});
