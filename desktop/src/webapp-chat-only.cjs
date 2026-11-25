'use strict';

// Hermes Desktop has no exact embed preset beyond secondary windows (v0.23.x). These selectors use
// its stable pane and chrome data attributes; when any of them disappears the rule simply stops matching.
const CHROME_GROUP_IDS = ['grp-sessions', 'grp-terminal', 'grp-review', 'grp-files'];

const CHROME_PANE_MARKERS = [
  '[data-tree-tab="sessions"]',
  '[data-tree-tab="hermes-bots:pane"]',
  '[data-tree-tab="hermes-bots:routines"]',
  '[data-tree-tab="terminal"]',
  '[data-tree-tab="files"]',
  '[data-tree-tab="review"]',
  '[data-slot="sidebar"]',
].map((marker) => `> [data-tree-group] ${marker}`).join(',');

const DIRECT_CHROME_GROUPS = CHROME_GROUP_IDS.map((id) => `[data-tree-split] > div:has(> [data-tree-group="${id}"])`).join(',\n');
const CHROME_GROUP_MARKERS = CHROME_GROUP_IDS.map((id) => `[data-tree-group="${id}"]`).join(',');

const CHAT_ONLY_CSS = `
${DIRECT_CHROME_GROUPS},
[data-tree-split] > div:has(${CHROME_PANE_MARKERS}):not(:has(> [data-tree-group="grp-main"])):not(:has(> [data-tree-group] [data-tree-tab="workspace"])),
[data-tree-split] > div:has(${CHROME_GROUP_MARKERS}):not(:has([data-tree-group="grp-main"])) {
  display: none !important;
}
[data-panel-header],
[data-titlebar-cluster],
[data-slot="statusbar"],
[data-slot="butterbar"],
[data-sash-overlap],
[data-narrow-overlay],
[data-narrow-overlay-backdrop] {
  display: none !important;
}
`;

function secondarySearch(search) {
  const params = new URLSearchParams(String(search || '').replace(/^\?/, ''));
  params.set('win', 'secondary');
  return `?${params.toString()}`;
}

// The browser-hosted Webapp uses the same flag for its own single-session pop-outs
// (apps/desktop/src/lib/browser-window.ts). It must stay before the HashRouter fragment.
function chatOnlyTarget(value) {
  const url = new URL(value);
  url.search = secondarySearch(url.search);
  return url.href;
}

function withoutSecondarySearch(search) {
  const params = new URLSearchParams(String(search || '').replace(/^\?/, ''));
  const entries = [...params.entries()];
  const kept = entries.filter(([name, value]) => !(name === 'win' && value === 'secondary'));
  if (kept.length === entries.length) return String(search || '');
  const next = new URLSearchParams(kept).toString();
  return next ? `?${next}` : '';
}

// A private launch link carries the post-handoff query inside its own fragment, encoded as
// `query`. The ticket and every other handoff parameter stay encoded in the same fragment.
function chatOnlyLaunchFragment(fragment) {
  if (!String(fragment || '').startsWith('#')) return '';
  const params = new URLSearchParams(fragment.slice(1));
  params.set('query', secondarySearch(params.get('query') || ''));
  return `#${params.toString()}`;
}

const PAGE_ROUTES = new Set([
  '/settings',
  '/command-center',
  '/session-import',
  '/capabilities',
  '/messaging',
  '/webhooks',
  '/artifacts',
  '/cron',
  '/profiles',
  '/agents',
  '/starmap',
]);

const routePathname = (target) => {
  const cut = target.search(/[?#]/);
  return cut === -1 ? target : target.slice(0, cut);
};

function chatHashRoute(hash) {
  const path = routePathname(hash || '/');
  if (path === '/') return true;
  if (!path.startsWith('/') || PAGE_ROUTES.has(path)) return false;
  const id = path.slice(1);
  return !!id && !id.includes('/');
}

function shouldUseChatOnly(value) {
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.pathname.endsWith('/webapp/launch') || url.pathname.endsWith('/webapp/window') || url.pathname.endsWith('/login')) return false;
  return chatHashRoute(url.hash.startsWith('#') ? url.hash.slice(1) : url.hash);
}

// inserted CSS does not survive a reload, and HashRouter changes do not reload: both events feed
// the same sync. Removing first on non-chat routes keeps an in-page Settings/Cron visit readable.
const installations = new WeakMap();

function installChatOnly(contents, enabled = true) {
  let key = '', generation = 0, active = enabled !== false;
  const remove = (cssKey) => { if (cssKey) contents.removeInsertedCSS(cssKey).catch(() => {}); };
  const sync = async () => {
    const mine = ++generation;
    if (!active || !shouldUseChatOnly(contents.getURL())) {
      const old = key; key = '';
      remove(old);
      return;
    }
    const inserted = await contents.insertCSS(CHAT_ONLY_CSS).catch(() => '');
    if (!inserted) return;
    if (mine !== generation) { remove(inserted); return; }
    const old = key; key = inserted;
    if (old !== inserted) remove(old);
  };
  const installation = { sync, setEnabled(next) { const value = next === true; if (value === active) return; active = value; sync(); } };
  installations.set(contents, installation);
  contents.on('did-navigate', sync);
  contents.on('did-navigate-in-page', (_event, _url, isMainFrame) => { if (isMainFrame) sync(); });
  contents.on('did-stop-loading', sync);
  contents.once('destroyed', () => { generation += 1; });
  sync();
  return installation;
}

// The stylesheet changes in place; the secondary-window flag lives in the URL, so only that part navigates.
function setChatOnly(contents, on) {
  const enabled = on === true;
  installations.get(contents)?.setEnabled(enabled);
  let target;
  try {
    const url = new URL(contents.getURL());
    const before = url.search;
    url.search = enabled ? secondarySearch(url.search) : withoutSecondarySearch(url.search);
    if (url.search === before) return;
    target = url.href;
  } catch { return; }
  if (typeof contents.loadURL !== 'function') return;
  try { contents.loadURL(target)?.catch(() => {}); } catch {}
}

module.exports = { CHAT_ONLY_CSS, chatOnlyLaunchFragment, chatOnlyTarget, installChatOnly, setChatOnly, shouldUseChatOnly };
