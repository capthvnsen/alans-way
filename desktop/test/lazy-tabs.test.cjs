'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { restorePlan, loadPending, savedUrl } = require('../src/lazy-tabs.cjs');

const saved = [
  { url: 'https://a.test/', owner: 'user' },
  { url: 'https://b.test/', owner: 'user', active: true },
  { url: 'https://c.test/', owner: 'user' },
  { url: 'file:///tmp/doc.pdf', owner: 'user', localPdf: true },
  { url: 'about:blank', owner: 'user' },
  { url: 'about:blank' },
  { url: '', owner: 'user' },
];

// Stands in for restoreBrowserTabs: a tab loads at creation unless it was deferred.
function restore(items) {
  const loads = [];
  const tabs = restorePlan(items).map(({ item, defer }) => {
    const tab = { url: item.url, ...(defer ? { pendingUrl: item.url } : {}) };
    if (!defer) loads.push(item.url);
    return tab;
  });
  return { tabs, loads };
}

test('only the active web tab loads at startup; files and the new-tab page keep loading', () => {
  const { tabs, loads } = restore(saved);
  assert.equal(tabs.length, 5, 'blank non-user and empty entries are skipped as before');
  assert.deepEqual(loads, ['https://b.test/', 'file:///tmp/doc.pdf', 'about:blank']);
  assert.deepEqual(tabs.filter(tab => tab.pendingUrl).map(tab => tab.pendingUrl), ['https://a.test/', 'https://c.test/']);
});

test('startup page loads: every restored tab before, one web tab after', () => {
  const web = Array.from({ length: 12 }, (_, i) => ({ url: `https://t${i}.test/`, owner: 'user', active: i === 7 }));
  assert.equal(restorePlan(web).length, 12, 'before: each of 12 tabs loaded at creation');
  assert.equal(restore(web).loads.length, 1, 'after: 1 load');
  assert.equal(restore(web.map(item => ({ ...item, active: false }))).loads.length, 0, 'no active tab: none');
});

test('a pending tab loads once on activation', async () => {
  const tab = { pendingUrl: 'https://a.test/' };
  const urls = [];
  const load = async url => { urls.push(url); };
  await loadPending(tab, load);
  await loadPending(tab, load);
  assert.deepEqual(urls, ['https://a.test/']);
  assert.equal(tab.pendingUrl, '');
});

test('a load that is already running is not repeated by a second access', async () => {
  const tab = { pendingUrl: 'https://a.test/' };
  let calls = 0, finish;
  const load = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
  const first = loadPending(tab, load), second = loadPending(tab, load);
  finish(); await first; await second;
  assert.equal(calls, 1);
});

test('an agent access loads a pending tab through the given loader and never a blank page', async () => {
  const tab = { pendingUrl: 'https://c.test/' };
  let committed = 'about:blank';
  await loadPending(tab, async url => { committed = url; });
  assert.equal(committed, 'https://c.test/');
});

test('a never-activated tab is saved with its original URL', () => {
  const tab = { requestedUrl: 'https://a.test/', pendingUrl: 'https://a.test/' };
  assert.equal(savedUrl(tab, ''), 'https://a.test/');
  assert.equal(savedUrl(tab, 'about:blank'), 'https://a.test/');
});

test('a loaded tab saves what it showed, an uncommitted navigation its target', () => {
  const loaded = { requestedUrl: 'https://a.test/', pendingUrl: '' };
  assert.equal(savedUrl(loaded, 'https://a.test/next'), 'https://a.test/next');
  assert.equal(savedUrl({ ...loaded, navigationUrl: 'https://a.test/going' }, 'about:blank'), 'https://a.test/going');
  assert.equal(savedUrl({ ...loaded, recoveryUrl: 'https://a.test/failed' }, 'https://a.test/'), 'https://a.test/failed');
  assert.equal(savedUrl({ pendingUrl: '' }, 'https://popup.test/'), 'https://popup.test/', 'a tab with no requested URL saves its committed one');
});

test('main.cjs wires the loader into every way a waiting tab becomes used', () => {
  const main = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/main.cjs'), 'utf8');
  assert.match(main, /requireActor\(tab, botId[^\n]*\n\s*await settleWithin\(loadPendingTab\(tab\)/, 'agent API loads after the actor check, before any read or action');
  assert.match(main, /function applyLayout\(\) \{\n\s*const shown = shownTabId\(\);\n\s*const shownTab = tabs\.get\(shown\);\n\s*if \(shownTab\) loadPendingTab\(shownTab\)/, 'showing a tab loads it');
  assert.match(main, /tab\.requestedUrl = target; tab\.pendingUrl = ''/, 'navigating a waiting tab drops its old destination');
  assert.match(main, /function reloadBrowserPage\(tab\) \{\n\s*if \(tab\.pendingUrl\) return loadPendingTab\(tab\)/, 'reload loads a waiting tab');
});
