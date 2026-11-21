'use strict';

// A restored web tab that is not the active one is created without loading: its URL waits in tab.pendingUrl until the tab is
// shown or an agent addresses it. Local files, the new-tab page and everything else restore as before.
const WEB_URL = /^https?:\/\//i;

// The saved tabs worth restoring, in order, each marked with whether it may wait. At most 40 are restored.
function restorePlan(saved) {
  return saved.slice(0, 40)
    .filter(item => item.url && !(item.url === 'about:blank' && item.owner !== 'user'))
    .map(item => ({ item, defer: WEB_URL.test(item.url) && item.active !== true }));
}

// Loads a waiting tab exactly once; a tab that is not waiting costs nothing. `load` goes through the sign-in gate.
function loadPending(tab, load) {
  const url = tab.pendingUrl;
  if (!url) return Promise.resolve();
  tab.pendingUrl = '';
  return load(url);
}

// The URL a tab is saved with: a waiting tab keeps its original one, and a navigation that has not committed yet keeps its target.
function savedUrl(tab, committed) {
  if (tab.pendingUrl) return tab.pendingUrl;
  if (!tab.requestedUrl) return committed;
  return tab.recoveryUrl || tab.navigationUrl || (committed && committed !== 'about:blank' ? committed : tab.requestedUrl);
}

module.exports = { restorePlan, loadPending, savedUrl };
