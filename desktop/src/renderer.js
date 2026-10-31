const api = window.workspace;
const hermesApi = window.hermes || null;
let hermesView = null;
let latestUiStateRevision = -1;
let state, lastRecording = null, resumeToasts = new Set(), stoppedRecordingAt = 0, draggingBot = '', focusMode = false, modalOpen = false, resizeFrame, toastTimer, botListSignature = '', handoffBusy = false;
const $ = (id) => document.getElementById(id);
function element(tag, className, text) { const el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = text; return el; }
function toast(message) { $('toast').textContent = message; $('toast').classList.remove('hidden'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.add('hidden'), 5000); }
async function command(name, value = {}) { try { return await api.command(name, value); } catch (error) { toast(error.message); } }
const remoteName = () => (state?.remotePlatform === 'mac' ? 'Mac VM' : 'VPS');
const hostName = (host) => (host === 'vps' || host === 'remote' ? remoteName() : ({ mac: 'Mac', windows: 'PC', linux: 'local computer' })[host] || 'this computer');
const thisComputer = () => hostName(state?.hostLabel || 'mac');
const HANDBACK_TEXT = { captcha: 'solve the CAPTCHA.', login: 'sign in.', two_factor: 'enter the verification code.', payment_details: 'enter the card details.', review: 'review the page.', other: 'take a look.' };
function orderedBots(includeHidden = false) {
  const bots = state.bots.filter((bot) => includeHidden || !state.hidden.includes(bot.id));
  const mode = state.botSort || 'manual';
  if (mode === 'recent') bots.sort((a, b) => (b.lastId || 0) - (a.lastId || 0));
  else if (mode === 'alpha') bots.sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }));
  else {
    const order = new Map(state.order.map((id, index) => [id, index]));
    bots.sort((a, b) => (order.get(a.id) ?? 10000) - (order.get(b.id) ?? 10000));
  }
  return bots.sort((a, b) => Number(b.id === state.primaryBotId) - Number(a.id === state.primaryBotId));
}
function colorFor(value) {
  const colors = ['#e6e6eb', '#00ba83', '#e9428b', '#f18b31', '#9673e1', '#22b9b7', '#689be4'];
  return colors[Array.from(value).reduce((sum, letter) => sum + letter.charCodeAt(0), 0) % colors.length];
}
function renderBots() {
  const list = $('bot-list'), focused = document.activeElement.closest('.bot-row');
  // Capture ownership before a zero-result filter can hide and blur the list.
  const focusedId = focused?.dataset.botId, focusedHide = document.activeElement.classList.contains('bot-hide');
  const previousIds = [...list.children].map(row => row.dataset.botId), focusedIndex = previousIds.indexOf(focusedId);
  const search = $('bot-search').value.trim().toLowerCase();
  const visibleBots = orderedBots();
  const bots = visibleBots.filter((bot) => `${bot.name || ''} ${bot.username || ''}`.toLowerCase().includes(search));
  list.classList.toggle('hidden', !!search && !bots.length);
  $('bot-search-clear').classList.toggle('hidden', !search);
  $('bot-search-empty').classList.toggle('hidden', !search || bots.length > 0);
  $('bot-search-status').textContent = search ? (bots.length ? `${bots.length} agent${bots.length === 1 ? '' : 's'} found.` : 'No agents found.') : '';
  $('bot-count').textContent = visibleBots.length;
  $('empty-bots').classList.toggle('hidden', !!search || state.bots.length > 0);
  $('empty-bots').querySelector('p').textContent = state.telegramStatus === 'connected' ? 'Finding your Telegram bot chats…' : 'Sign in to Telegram to load your bot chats here.';
  const signature = JSON.stringify([bots.map(({ activity, ...bot }) => bot), state.selectedBotId, state.primaryBotId, state.botSort]);
  if (signature === botListSignature) {
    for (const row of list.children) {
      const bot = bots.find(item => item.id === row.dataset.botId);
      if (bot) { window.HermesAvatars.paint(row.querySelector('.avatar'), bot, state); renderBotActivity(row, bot); }
    }
    document.querySelectorAll('.bridge-dot').forEach((dot) => dot.classList.toggle('offline', !state.api.ready));
    return;
  }
  const remainingIds = new Set(bots.map(bot => bot.id));
  // Continue at the next surviving neighbor; at the end, use the previous one.
  const focusId = remainingIds.has(focusedId) ? focusedId : previousIds.slice(focusedIndex + 1).find(id => remainingIds.has(id))
    || previousIds.slice(0, focusedIndex).reverse().find(id => remainingIds.has(id)) || bots[0]?.id;
  const entryId = focusedId ? focusId : bots.find(bot => bot.id === state.selectedBotId)?.id || bots[0]?.id;
  botListSignature = signature; list.replaceChildren();
  for (const bot of bots) {
    const row = element('div', `bot-row${state.selectedBotId === bot.id ? ' selected' : ''}${state.primaryBotId === bot.id ? ' primary' : ''}`);
    row.setAttribute('role', 'listitem'); row.draggable = (state.botSort || 'manual') === 'manual'; row.dataset.botId = bot.id;
    const open = element('button', 'bot-open'); open.type = 'button'; open.setAttribute('aria-label', `Open ${bot.name}`);
    open.setAttribute('aria-current', String(state.selectedBotId === bot.id)); open.tabIndex = bot.id === entryId ? 0 : -1;
    const avatar = element('span', 'avatar'); window.HermesAvatars.paint(avatar, bot, state);
    const copy = element('span', 'bot-copy');
    const nameLine = element('div', 'bot-name', bot.name);
    if (state.primaryBotId === bot.id) nameLine.append(element('span', 'primary-badge', 'PRIMARY'));
    copy.append(nameLine, element('div', 'bot-preview', bot.preview || (bot.username ? `@${bot.username}` : 'Telegram bot')), element('div', 'bot-activity'));
    const hide = element('button', 'bot-hide', '×'); hide.title = `Hide ${bot.name}`; hide.setAttribute('aria-label', hide.title);
    hide.tabIndex = bot.id === entryId ? 0 : -1;
    hide.onclick = (event) => { event.stopPropagation(); command('hide-bot', { id: bot.id }); };
    open.append(avatar, copy); if (bot.unread) open.append(element('span', 'unread')); row.append(open, hide);
    row.onclick = () => command('open-bot', { id: bot.id });
    open.onfocus = () => {
      for (const item of list.querySelectorAll('.bot-row')) {
        item.querySelector('.bot-open').tabIndex = item === row ? 0 : -1;
        item.querySelector('.bot-hide').tabIndex = item === row ? 0 : -1;
      }
    };
    open.onkeydown = (event) => moveNavigationFocus(event, [...list.querySelectorAll('.bot-open')], 'vertical');
    row.ondragstart = (event) => { draggingBot = bot.id; row.classList.add('dragging'); event.dataTransfer.setData('text/plain', bot.id); event.dataTransfer.effectAllowed = 'move'; };
    row.ondragend = () => { draggingBot = ''; row.classList.remove('dragging'); document.querySelectorAll('.drop-target').forEach((el) => el.classList.remove('drop-target')); };
    row.ondragover = (event) => { if (draggingBot && draggingBot !== bot.id && bot.id !== state.primaryBotId) { event.preventDefault(); row.classList.add('drop-target'); } };
    row.ondragleave = () => row.classList.remove('drop-target');
    row.ondrop = (event) => {
      event.preventDefault(); row.classList.remove('drop-target');
      const ids = orderedBots(true).map((item) => item.id), from = ids.indexOf(draggingBot), to = ids.indexOf(bot.id);
      if (from >= 0 && to >= 0) { ids.splice(from, 1); ids.splice(to, 0, draggingBot); command('sort-bots', { ids }); }
    };
    renderBotActivity(row, bot); list.append(row);
  }
  if (focusedId) {
    const target = [...list.children].find(row => row.dataset.botId === focusId);
    if (target && canFocus(target.querySelector('.bot-open'))) {
      // Focusing Open aligns both roving stops before restoring the Hide action.
      target.querySelector('.bot-open').focus({ preventScroll: true });
      if (focusedHide) target.querySelector('.bot-hide').focus({ preventScroll: true });
      // Reveal the row's padding too, so the focus outline stays inside the clip.
      target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    } else {
      const fallback = [$('bot-search'), $('search-toggle')].find(canFocus);
      fallback?.focus();
    }
  }
  $('sort-bots').classList.toggle('active', (state.botSort || 'manual') !== 'manual');
  document.querySelectorAll('.bridge-dot').forEach((dot) => dot.classList.toggle('offline', !state.api.ready));
}
function renderBotActivity(row, bot) {
  const status = row.querySelector('.bot-activity'), activity = bot.activity;
  const active = activity?.state === 'active' && (!activity.expiresAt || activity.expiresAt > Date.now());
  status.replaceChildren();
  if (active) {
    const dots = element('span', 'hw-dots');
    dots.append(element('i'), element('i'), element('i'));
    if (bot.hue !== undefined) dots.style.setProperty('--h', String(bot.hue));
    status.append(dots, document.createTextNode(activity.label || 'Telegram activity'));
  } else {
    status.textContent = activity?.state === 'idle' ? 'Idle' : 'Activity unavailable';
  }
  status.classList.toggle('active', active);
  status.title = activity?.detail || 'Live Telegram chat actions. No activity signal does not prove a bot has stopped working.';
}
function tabIcon(tab) {
  const icon = element('span', 'tab-icon');
  if (tab.favicon) { const img = element('img', 'tab-favicon'); img.src = tab.favicon; img.alt = ''; img.onerror = () => { img.replaceWith(tab.symbol || '◈'); }; icon.append(img); }
  if (tab.controller === 'agent') {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 19 25');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', 'M1 1v19l5-5 4 9 4-2-4-8h7Z'); svg.append(path);
    const cursor = element('span', 'tab-agent-cursor'); cursor.style.setProperty('--h', String(tab.agentHue ?? 168));
    cursor.append(svg); icon.append(cursor); return icon;
  }
  if (!tab.favicon) icon.textContent = tab.symbol;
  return icon;
}
function tabStripEntries() { return state.tabs.filter(tab => tab.host !== 'vps' || tab.handback?.state === 'awaiting_human'); }
function renderTabs() {
  const container = $('tabs'), focused = document.activeElement.closest('.tab');
  const focusedId = focused?.dataset.tabId, focusedHost = focused?.dataset.host, focusedClose = document.activeElement.classList.contains('tab-close');
  const focusedIndex = focused ? [...container.children].indexOf(focused) : -1;
  container.replaceChildren();
  const entries = tabStripEntries().map((tab) => ({ ...tab, symbol: tab.loading ? '◌' : '◈' }));
  entries.forEach((tab, index) => {
    const selected = state.browserTabId === tab.id && state.browserTabHost === tab.host;
    const node = element('div', `tab${selected ? ' active' : ''}`); node.setAttribute('role', 'presentation'); node.dataset.tabId = tab.id; node.dataset.host = tab.host;
    const select = element('button', 'tab-select'); select.setAttribute('role', 'tab'); select.setAttribute('aria-selected', String(selected));
    select.setAttribute('aria-setsize', String(entries.length)); select.setAttribute('aria-posinset', String(index + 1));
    select.setAttribute('aria-label', tab.title || 'New tab'); select.tabIndex = selected || (!state.tabs.some(item => item.id === state.browserTabId) && tab.id === entries[0]?.id) ? 0 : -1;
    select.append(tabIcon(tab), element('span', 'tab-title', tab.title || 'New tab')); node.append(select);
    if (tab.controller === 'agent') { node.classList.add('agent'); node.append(element('span', 'agent-dot')); }
    if (tab.agentBusy) node.classList.add('busy');
    if (tab.handback?.state === 'awaiting_human') { const badge = element('span', 'needs-you-badge'); badge.style.setProperty('--h', String(tab.agentHue ?? 168)); badge.title = `${state.bots.find(bot=>bot.id===tab.botId)?.name || 'Agent'} needs you`; node.append(badge); }
    if(tab.host)node.title=`${hostName(tab.host)} · ${state.bots.find(bot=>bot.id===tab.botId)?.name || tab.botId}${tab.controller === 'agent' ? ' · agent-controlled' : ''}`;
    node.onclick = () => command('activate', { id: tab.id, host: tab.host });
    select.onkeydown = (event) => {
      if (event.key === 'Delete') { event.preventDefault(); if (tab.host !== 'vps') command('close-tab', { id: tab.id, host: tab.host }); return; }
      const target = moveNavigationFocus(event, [...container.querySelectorAll('.tab:not(.tab-off) [role=tab]')], 'horizontal');
      if (target) command('activate', { id: target.closest('.tab').dataset.tabId, host: target.closest('.tab').dataset.host });
    };
    if (tab.host !== 'vps') {
      const close = element('button', 'tab-close', '×'); close.title = `Close ${tab.title || 'tab'}`; close.setAttribute('aria-label', close.title);
      close.tabIndex = selected ? 0 : -1;
      close.onclick = (event) => { event.stopPropagation(); command('close-tab', { id: tab.id, host: tab.host }); }; node.append(close);
    }
    container.append(node);
  });
  fitTabs();
  if (focusedId) {
    const target = [...container.children].find(node => node.dataset.tabId === focusedId && node.dataset.host === focusedHost) || container.children[Math.min(focusedIndex, container.children.length - 1)];
    const fallback = target?.querySelector(focusedClose ? '.tab-close' : '[role=tab]');
    (canFocus(fallback) ? fallback : canFocus($('tabs-menu')) ? $('tabs-menu') : $('new-tab')).focus({ preventScroll: true });
  }
}
// The strip never clips a tab mid-element: tabs that cannot fit hide into the
// all-tabs menu (leftmost first, the active tab always stays). Every tab stays
// selectable and closable through the panel when the strip is full.
function fitTabs() {
  const container = $('tabs'), menu = $('tabs-menu'), nodes = [...container.children];
  for (const node of nodes) node.classList.remove('tab-off');
  menu.classList.add('hidden');
  let hiddenCount = 0;
  if (container.scrollWidth > container.clientWidth + 1) {
    menu.classList.remove('hidden');
    while (container.scrollWidth > container.clientWidth + 1) {
      const candidate = nodes.find(node => !node.classList.contains('tab-off') && (node.dataset.tabId !== state?.browserTabId || node.dataset.host !== state?.browserTabHost));
      if (!candidate) break;
      candidate.classList.add('tab-off'); hiddenCount++;
    }
  }
  // Keep one tabbable stop inside the visible strip: when the selected tab is
  // absent (VPS view) and the first tab hid, the next visible tab takes the stop.
  if (!container.querySelector('.tab:not(.tab-off) [role=tab][tabindex="0"]')) {
    const first = container.querySelector('.tab:not(.tab-off) [role=tab]'); if (first) first.tabIndex = 0;
  }
  $('tabs-menu-count').textContent = hiddenCount ? `+${hiddenCount}` : '';
  const label = hiddenCount ? `Show all tabs, ${hiddenCount} more not currently visible` : 'Show all tabs';
  menu.title = label; menu.setAttribute('aria-label', label);
  if (menu.classList.contains('hidden')) setTabsPanel(false);
  else if (!$('tabs-panel').classList.contains('hidden')) renderTabsPanel();
}
function setTabsPanel(open) {
  const panel = $('tabs-panel'), wasOpen = !panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !open);
  $('tabs-menu').setAttribute('aria-expanded', String(open));
  $('tabs-menu').classList.toggle('active', open);
  if (!open && wasOpen && document.activeElement && $('tabs-panel').contains(document.activeElement)) $('tabs-menu').focus({ preventScroll: true });
  if (open) renderTabsPanel();
  // The panel extends over the native browser view; like the app's dialogs it
  // obscures the slot so the menu can paint and be picked reliably.
  if (open !== wasOpen) scheduleLayout();
}
function renderTabsPanel() {
  const panel = $('tabs-panel'), focusedRow = document.activeElement?.closest('.tabs-panel-row'), focusedTab = focusedRow?.dataset.tabId, focusedHost = focusedRow?.dataset.host;
  panel.replaceChildren();
  for (const tab of tabStripEntries()) {
    const selected = state.browserTabId === tab.id && state.browserTabHost === tab.host;
    const row = element('div', `tabs-panel-row${selected ? ' active' : ''}`); row.dataset.tabId = tab.id; row.dataset.host = tab.host;
    const pick = element('button', 'tabs-panel-select'); pick.setAttribute('role', 'menuitemradio'); pick.setAttribute('aria-checked', String(selected));
    pick.setAttribute('aria-label', tab.title || 'New tab');
    const owner = tab.host ? `${hostName(tab.host)} · ${state.bots.find(bot => bot.id === tab.botId)?.name || tab.botId}${tab.controller === 'agent' ? ' · agent-controlled' : ''}` : '';
    pick.title = `${tab.title || 'New tab'}${owner ? ` · ${owner}` : ''}`;
    pick.append(tabIcon(tab), element('span', 'tab-title', tab.title || 'New tab'), element('span', 'tabs-panel-owner', owner));
    pick.onclick = () => { command('activate', { id: tab.id, host: tab.host }); setTabsPanel(false); };
    row.append(pick);
    if (tab.host !== 'vps') {
      const close = element('button', 'tabs-panel-close', '×'); close.title = `Close ${tab.title || 'tab'}`; close.setAttribute('aria-label', close.title);
      close.onclick = (event) => { event.stopPropagation(); command('close-tab', { id: tab.id, host: tab.host }); };
      row.append(close);
    }
    panel.append(row);
  }
  if (focusedTab) panel.querySelector(`.tabs-panel-row[data-tab-id="${CSS.escape(focusedTab)}"][data-host="${CSS.escape(focusedHost)}"] .tabs-panel-select`)?.focus({ preventScroll: true });
}
// The compact status affordance and its panel report both exact footer texts
// whenever the narrow footer suppresses a status span (and on demand at any
// width). It obscures native views while open, like the tab panel and dialogs.
function setStatusPanel(open) {
  const panel = $('status-panel'), wasOpen = !panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !open);
  $('status-more').setAttribute('aria-expanded', String(open));
  if (!open && wasOpen && document.activeElement && panel.contains(document.activeElement)) (canFocus($('status-more')) ? $('status-more') : $('workspace-status')).focus({ preventScroll: true });
  if (open) renderStatusPanel();
  if (open !== wasOpen) scheduleLayout();
}
function renderStatusPanel() {
  const panel = $('status-panel'), focused = document.activeElement?.closest('.status-panel-row')?.dataset.status;
  panel.replaceChildren();
  for (const [key, label, text] of [['workspace', 'Workspace', $('workspace-status').textContent], ['connector', 'Connector', $('connection-status').textContent]]) {
    const row = element('div', 'status-panel-row'); row.dataset.status = key; row.tabIndex = 0; row.setAttribute('role', 'status');
    row.append(element('span', 'status-panel-label', label), document.createTextNode(text || '-'));
    panel.append(row);
  }
  if (focused) panel.querySelector(`.status-panel-row[data-status="${focused}"]`)?.focus({ preventScroll: true });
}
function moveNavigationFocus(event, items, orientation) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const previous = orientation === 'vertical' ? 'ArrowUp' : 'ArrowLeft', next = orientation === 'vertical' ? 'ArrowDown' : 'ArrowRight';
  const index = items.indexOf(event.currentTarget);
  const target = event.key === 'Home' ? items[0] : event.key === 'End' ? items.at(-1)
    : event.key === previous ? items[(index - 1 + items.length) % items.length] : event.key === next ? items[(index + 1) % items.length] : null;
  if (!target) return;
  event.preventDefault(); target.focus(); target.scrollIntoView({ block: 'nearest', inline: 'nearest' }); return target;
}
function extensionIcon(item) {
  if (!item.icon) return element('span', 'extension-letter', item.name.slice(0, 1));
  const image = element('img'); image.src = item.icon; image.alt = ''; return image;
}
function openExtension(item, button) {
  const box = button.getBoundingClientRect();
  closeModal(); command('open-extension', { key: item.key, anchor: { x: box.right, y: box.bottom + 6 } });
}
function renderExtensions() {
  const items = state.extensions || [], signature = JSON.stringify(items);
  let actions = $('native-extension-actions');
  if (!actions) {
    actions = element('browser-action-list'); actions.id = 'native-extension-actions'; actions.setAttribute('partition', 'persist:browser'); actions.setAttribute('alignment', 'bottom'); $('pinned-extensions').append(actions);
    actions.addEventListener('click', event => {
      const button = event.composedPath().find(node => node.tagName === 'BUTTON'), item = state.extensions.find(item => item.id === button?.id);
      if (item) { event.preventDefault(); event.stopImmediatePropagation(); openExtension(item, button); }
    }, true);
    actions.addEventListener('contextmenu', event => { event.preventDefault(); event.stopImmediatePropagation(); showExtensions(); }, true);
  }
  actions.setAttribute('tab', String(state.browserContentsId || -1));
  if (actions.shadowRoot) {
    let style = actions.shadowRoot.querySelector('#pin-filter');
    if (!style) { style = element('style'); style.id = 'pin-filter'; actions.shadowRoot.append(style); }
    const pinned = items.filter(item => item.pinned && item.loaded && item.enabled && /^[a-p]{32}$/.test(item.id));
    style.textContent = `.action${pinned.map(item => `:not([id="${item.id}"])`).join('')}{display:none!important}`;
  }
  const list = $('extension-list'); if (!modalOpen || !list || list.dataset.signature === signature) return;
  const focused = document.activeElement?.getAttribute('aria-label');
  list.dataset.signature = signature; list.replaceChildren();
  if (!items.length) list.append(element('p', 'settings-note', 'No extensions added yet. Browse the Chrome Web Store to add one.'));
  for (const item of items) {
    const row = element('div', 'extension-row'), icon = element('span', 'extension-manager-icon'), copy = element('div', 'visibility-copy'); icon.append(extensionIcon(item));
    const name = element('button', 'visibility-name extension-name', item.name); name.setAttribute('aria-label', `Open ${item.name}`);
    name.disabled = !item.loaded || state.activeTabId === 'vps'; name.onclick = () => openExtension(item, $('extensions-button'));
    copy.append(name, element('span', 'visibility-username', `${item.version} · ${item.error ? 'Could not load' : !item.enabled ? 'Disabled' : item.hasPopup ? 'Popup available' : 'Runs on matching pages'}`));
    if (item.error) copy.append(element('p', 'settings-note', item.error));
    if (item.nativeMessaging) copy.append(element('p', 'settings-note', 'Desktop app connection may require signed-browser approval in that app.'));
    const actions = element('div', 'extension-row-actions'), enabled = element('input'); enabled.type = 'checkbox'; enabled.checked = item.enabled;
    enabled.setAttribute('role', 'switch'); enabled.setAttribute('aria-label', `Enable ${item.name}`);
    enabled.onchange = async () => { enabled.disabled = true; const result = await command('enable-extension', { key: item.key, enabled: enabled.checked }); if (result) render(result); else { enabled.disabled = false; enabled.checked = item.enabled; } };
    const pin = element('button', 'secondary-button', item.pinned ? 'Unpin' : 'Pin'); pin.setAttribute('aria-label', `${item.pinned ? 'Unpin' : 'Pin'} ${item.name}`);
    pin.onclick = () => command('pin-extension', { key: item.key, pinned: !item.pinned });
    const remove = element('button', 'text-button', 'Remove'); remove.setAttribute('aria-label', `Remove ${item.name}`); remove.onclick = () => command('remove-extension', { key: item.key });
    actions.append(enabled, pin, remove); row.append(icon, copy, actions); list.append(row);
  }
  if (focused) [...list.querySelectorAll('[aria-label]')].find(node => node.getAttribute('aria-label') === focused)?.focus({ preventScroll: true });
}
function showExtensions() {
  openModal('Extensions');
  const body = $('modal-body');
  body.append(element('p', 'settings-note', 'Install extensions from the Chrome Web Store, then pin them beside the address bar. They run in your local browser tabs.'));
  const browse = element('button', 'primary-button', 'Browse Chrome Web Store'); browse.onclick = async () => { closeModal(); await command('browse-extensions'); }; body.append(browse);
  const list = element('div'); list.id = 'extension-list'; body.append(list);
  const add = element('button', 'secondary-button', 'Add unpacked extension'); add.onclick = async () => { add.disabled = true; const result = await command('add-extension'); if (result) { render(result); toast('Extension list updated. Reload existing pages to apply content scripts.'); } add.disabled = false; };
  body.append(add, element('hr', 'section-divider'), element('h3', '', 'Sign-in and passwords'));
  body.append(element('p', 'settings-note', 'This browser is Chromium, not Chrome, so Google sync and Chrome’s built-in password manager are not included. For passwords and passkeys, install your manager’s extension from the Web Store and sign in inside it.'));
  renderExtensions();
}
function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = Number(bytes) || 0, unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++; }
  return `${size >= 10 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
}
function downloadStatus(item) {
  if (item.state === 'progressing') {
    if (item.paused) return `Paused · ${formatBytes(item.receivedBytes)}${item.totalBytes ? ` of ${formatBytes(item.totalBytes)}` : ''}`;
    if (item.totalBytes > 0) return `${Math.min(100, Math.round(item.receivedBytes / item.totalBytes * 100))}% of ${formatBytes(item.totalBytes)}`;
    return `Downloading · ${formatBytes(item.receivedBytes)}`;
  }
  if (item.state === 'completed') return formatBytes(item.totalBytes || item.receivedBytes);
  if (item.state === 'interrupted') return 'Interrupted';
  return 'Cancelled';
}
function closeDownloads() {
  $('downloads-menu').classList.add('hidden');
  $('downloads-button').setAttribute('aria-expanded', 'false');
}
function renderDownloads() {
  const items = state?.downloads || [];
  $('downloads-button').classList.toggle('active', items.some(item => item.state === 'progressing'));
  const menu = $('downloads-menu');
  if (menu.classList.contains('hidden')) return;
  const signature = JSON.stringify(items);
  if (menu.dataset.signature === signature) return;
  menu.dataset.signature = signature; menu.replaceChildren();
  const head = element('div', 'downloads-head');
  head.append(element('span', 'downloads-title', 'Downloads'));
  if (items.some(item => item.state !== 'progressing')) {
    const clear = element('button', 'downloads-clear', 'Clear all');
    clear.onclick = () => command('clear-downloads'); head.append(clear);
  }
  menu.append(head);
  if (!items.length) menu.append(element('p', 'downloads-empty', 'No downloads yet.'));
  for (const item of items.slice(0, 20)) {
    const row = element('div', 'download-row'); row.setAttribute('role', 'menuitem');
    row.append(element('span', 'download-badge', (item.name || '?').trim().charAt(0).toUpperCase() || '?'));
    const copy = element('span', 'download-copy'), name = element('span', 'download-name', item.name || 'download');
    name.title = item.path || item.name;
    copy.append(name, element('span', 'download-status', [item.source, downloadStatus(item)].filter(Boolean).join(' · ')));
    if (item.state === 'progressing' && item.totalBytes > 0) {
      const bar = element('span', 'download-progress'), fill = element('i');
      fill.style.width = `${Math.min(100, item.receivedBytes / item.totalBytes * 100)}%`;
      bar.append(fill); copy.append(bar);
    }
    row.append(copy);
    if (item.state === 'progressing') {
      const pause = element('button', 'download-action', item.paused ? 'Resume' : 'Pause');
      pause.title = `${item.paused ? 'Resume' : 'Pause'} ${item.name}`;
      pause.onclick = () => command('pause-download', { id: item.id, paused: !item.paused });
      const cancel = element('button', 'download-action', 'Cancel');
      cancel.title = `Cancel ${item.name}`; cancel.setAttribute('aria-label', cancel.title);
      cancel.onclick = () => command('cancel-download', { id: item.id });
      row.append(pause, cancel);
    } else {
      if (item.state === 'completed') {
        const open = () => { command('open-download', { id: item.id }); closeDownloads(); };
        row.classList.add('openable'); row.tabIndex = 0; row.onclick = open;
        row.onkeydown = (event) => { if (event.key === 'Enter') open(); };
      }
      const reveal = element('button', 'download-action', 'Show in folder');
      reveal.title = `Show ${item.name} in Finder`; reveal.setAttribute('aria-label', reveal.title);
      reveal.onclick = (event) => { event.stopPropagation(); command('show-download', { id: item.id }); closeDownloads(); };
      row.append(reveal);
    }
    menu.append(row);
  }
  if (items.length) {
    const footer = element('div', 'downloads-foot'), all = element('button', 'download-action', 'Show all downloads');
    all.onclick = () => { command('downloads-folder'); closeDownloads(); };
    footer.append(all); menu.append(footer);
  }
}
function render(next) {
  // Replies can arrive after newer broadcasts, even within one Settings session.
  // Keep local re-renders of the current revision and accept unversioned hosts
  // until this native IPC authority has supplied its first revision.
  if (Number.isSafeInteger(next.uiStateRevision) && next.uiStateRevision >= 0) {
    if (next.uiStateRevision < latestUiStateRevision) return;
    latestUiStateRevision = next.uiStateRevision;
  } else if (latestUiStateRevision >= 0) return;
  state = next;
  window.HermesAvatars.update(state);
  const bot = state.bots.find((item) => item.id === state.selectedBotId);
  document.documentElement.style.setProperty('--chat-width', `${state.chatWidth}px`);
  $('shell').classList.toggle('bots-hidden', state.showBots === false);
  $('bots-toggle').setAttribute('aria-pressed', String(state.showBots !== false));
  $('bots-toggle').title = state.showBots === false ? 'Show agent list' : 'Hide agent list';
  // The chat pane hosts either the Telegram WebContentsView or the native
  // Hermes DOM surface. When the Hermes pane is up the slot collapses and its
  // reported rect goes zero — main then hides the Telegram view for us.
  const hermesActive = state.chatTarget === 'hermes';
  $('telegram-slot').classList.toggle('hidden', hermesActive);
  $('telegram-note').classList.toggle('hidden', hermesActive);
  $('hermes-pane').classList.toggle('hidden', !hermesActive);
  const hermesSelected = hermesActive && state.hermes?.sessions?.find((s) => s.selected);
  $('chat-title').textContent = hermesActive
    ? (hermesSelected?.title || `Hermes${state.hermes?.target ? ` · ${state.hermes.target.label}` : ''}`)
    : (bot?.name || 'Telegram');
  $('chat-avatar').style.display = hermesActive ? 'none' : '';
  window.HermesAvatars.paint($('chat-avatar'), bot || { id: '', name: 'Telegram' }, state);
  $('chat-avatar').title = bot ? `Customize ${bot.name} avatar` : 'Select a bot to customize its avatar';
  renderHermes();
  $('agent-presence').classList.toggle('hidden', !bot);
  if (bot) {
    window.HermesAvatars.paint($('presence-avatar'), bot, state);
    $('presence-name').textContent = bot.name;
    $('presence-status').textContent = window.HermesAvatars.activityLabel(bot.activity);
    $('presence-status').classList.toggle('active', window.HermesAvatars.isActive(bot.activity));
  }
  renderBots(); renderTabs(); renderSettingsBots(); renderRecordings(); renderSitePermissions(); renderExtensions(); renderDownloads(); refreshSettingsSections();
  const tab = state.tabs.find((item) => item.id === state.activeTabId && item.host === state.hostLabel);
  const remote = state.activeTabId==='vps';
  $('vm-toggle').title = remote ? 'Return to browser' : 'Expand virtual desktop';
  $('vm-toggle').setAttribute('aria-label', $('vm-toggle').title);
  $('vm-toggle').setAttribute('aria-pressed', String(remote));
  $('shell').classList.toggle('browser-hidden', state.showBrowser === false);
  $('browser-collapse').title = state.showBrowser === false ? 'Show browser pane' : 'Hide browser pane';
  $('browser-collapse').setAttribute('aria-label', $('browser-collapse').title);
  $('browser-collapse').setAttribute('aria-pressed', String(state.showBrowser === false));
  renderHome(bot, !!tab || state.activeTabId === 'vps' || !!state.onboarding);
  renderOnboarding(!tab && state.activeTabId !== 'vps' && !!state.onboarding);
  $('browser-toolbar').classList.toggle('hidden', state.activeTabId === 'vps');
  $('remote-preview-slot').classList.toggle('hidden', !state.preview || remote || !!state.onboarding);
  $('preview-chip').classList.toggle('hidden', state.preview || remote);
  $('preview-label').textContent = state.remoteStatus === 'connected' ? `${remoteName()} desktop` : `${remoteName()} · ${state.remoteStatus}`;
  document.body.classList.toggle('win32', state.platform === 'win32');
  $('new-tab').title = state.platform === 'darwin' ? 'New local browser tab (⌘T)' : 'New local browser tab (Ctrl+T)';
  positionPreview();
  const sharedTab = tab?.botId === 'shared';
  const ownerName = tab && !sharedTab ? state.bots.find((item) => item.id === tab.botId)?.name || tab.botId : '';
  const controlButton = $('control-button');
  controlButton.textContent = tab?.controller === 'agent' ? 'Take over'
    : sharedTab ? `Give to ${bot?.name || state.selectedBotId || 'agents'}`
    : `Give to ${ownerName || 'agent'}`;
  controlButton.classList.toggle('agent', tab?.controller === 'agent');
  controlButton.disabled = !tab || tab.extensionPage || tab.localPdf;
  const askBot = $('ask-bot'); askBot.disabled = !tab || !/^https?:\/\//.test(tab?.url || ''); askBot.title = tab ? `Share ${tab.title || 'this page'} with ${bot?.name || 'the selected bot'}` : 'Discuss this page with your agent';
  $('browser-slot').classList.toggle('agent-live', !!tab && tab.controller === 'agent');
  if (tab?.extensionPage || tab?.localPdf) controlButton.textContent = 'You';
  const controlOffer = /^(Give|Take)/.test(controlButton.textContent) ? ` · ${controlButton.textContent}` : '';
  controlButton.title = tab ? `Browser runs on ${tab.host==='vps'||tab.host==='remote'?'the '+remoteName():'your '+thisComputer()} · ${tab.controller === 'agent' ? (sharedTab ? 'Agents share control' : `${ownerName || 'Agent'} controls it`) : `You control it${sharedTab && !state.selectedBotId ? ' · an agent can claim it' : ''}`}${controlOffer}` : 'Open a browser tab first';
  if (document.activeElement !== $('address')) $('address').value = tab?.recoveryUrl || (tab?.internal ? '' : tab?.url || '');
  $('browser-error-banner').classList.toggle('hidden', !tab?.error);
  $('browser-error-text').textContent = tab?.error ? `${tab.error}${tab.recoveryUrl ? ` · ${tab.recoveryUrl}` : ''}` : '';
  $('reload').title = tab?.error ? 'Reload page' : 'Reload';
  const agentName = tab ? state.bots.find(bot => bot.id === tab.botId)?.name || 'Agent' : '';
  // The retired local copy of a handed-off tab is the way back: it offers to
  // pull the remote tab's current page state onto this computer again.
  const handedOff = tab?.handoff?.phase === 'handed_off' && tab.handoff.destinationTabId ? tab.handoff.destinationTabId : '';
  // A handed-off source stays retired once its remote copy came back: the new
  // local tab carries a handoff record pointing at that remote tab id.
  const movedBack = !!handedOff && state.tabs.some((item) => item !== tab && item.handoff?.sourceTabId === handedOff);
  const canHandoff = state.vpsBrowserStatus === 'connected' && !!tab && !tab.extensionPage && !tab.internal && (tab.controller === 'agent' || (!!handedOff && !movedBack));
  const handoffButton = $('handoff-button');
  handoffButton.classList.toggle('hidden', !canHandoff);
  handoffButton.disabled = !canHandoff || handoffBusy;
  handoffButton.textContent = handoffBusy ? 'Moving…' : handedOff ? 'Move back' : `Move to ${remoteName()}`;
  handoffButton.title = `${handedOff ? `Bring the ${remoteName()} copy of this page back to your ${thisComputer()}` : `Move ${agentName || 'the agent'}’s page to the ${remoteName()} desktop`}. ${state.carrySignIns ? 'Its sign-in cookies go along over Tailscale; passwords and site storage stay.' : 'Sign-ins stay here (Settings › General).'}`;
  // The VM resumed agent tabs while this computer slept; say so once.
  const continued = state.continuedNotice;
  if (continued && !resumeToasts.has(`continued:${continued.at}`)) { resumeToasts.add(`continued:${continued.at}`); toast(`${continued.count === 1 ? 'A task' : `${continued.count} tasks`} continued on the ${remoteName()} while this computer was away. Press Move back to bring ${continued.count === 1 ? 'it' : 'one'} here.`); }
  // The bot's note is plain text from the page side of the trust line: it
  // only ever reaches the DOM through textContent.
  const handbackTab = remote ? state.tabs.find(item => item.id === state.activeVpsTabId && item.host === 'vps') : tab;
  const needsYou = handbackTab?.handback?.state === 'awaiting_human' ? handbackTab.handback : null;
  $('needs-you-banner').classList.toggle('hidden', !needsYou);
  if (needsYou) {
    $('needs-you-banner').style.setProperty('--h', String(handbackTab.agentHue ?? 168));
    $('needs-you-text').textContent = `${state.bots.find(bot => bot.id === handbackTab.botId)?.name || 'Agent'} needs you: ${needsYou.note || HANDBACK_TEXT[needsYou.reason] || 'take a look.'}`;
  }
  // Main clears the takeover notice a few seconds after a bot took the tab.
  const takeover = tab?.takeover && tab.controller === 'agent';
  $('takeover-banner').classList.toggle('hidden', !takeover);
  if (takeover) {
    $('takeover-banner').style.setProperty('--h', String(tab.agentHue ?? 168));
    $('takeover-text').textContent = `${agentName} took over this tab`;
  }
  // The app gave a CAPTCHA tab back on its own once the challenge cleared.
  for (const item of state.tabs) {
    const key = item.handback?.resumed === 'auto' ? `${item.id}:${item.handback.returnedAt}` : '';
    if (key && !resumeToasts.has(key)) { resumeToasts.add(key); toast('Thanks, continuing.'); }
  }
  // Recording runs only on a tab the human controls; a bot taking it, or the
  // tab closing, stops and saves it in main.
  const recording = state.recording;
  $('record-button').disabled = !recording && (!tab || tab.controller !== 'human' || tab.extensionPage);
  $('record-button').classList.toggle('recording', !!recording);
  $('record-button').setAttribute('aria-pressed', String(!!recording));
  $('record-button').title = recording ? 'Stop recording and save' : tab?.controller === 'agent' ? 'Take over this tab to record a task' : 'Record a task to teach your agent';
  $('recording-banner').classList.toggle('hidden', !recording);
  if (recording) $('recording-text').textContent = `Recording${recording.tabId === tab?.id ? '' : ' another tab'} · ${recording.steps} ${recording.steps === 1 ? 'step' : 'steps'}. Do the task once. Passwords, card numbers and codes are never saved.`;
  if (lastRecording && !recording && lastRecording.startedAt !== stoppedRecordingAt) toast('Recording stopped. Anything it caught is in Settings → Recordings.');
  lastRecording = recording;
  $('workspace-status').textContent = tab?.error ? `Page: ${tab.error}` : tab?.loading ? 'Loading…' : tab ? `${tab.controller === 'agent' ? `${agentName}${tab.agentBusy ? ' is working' : ' is browsing'}` : 'You'} in control${tab.controller === 'agent' ? ' · Take over anytime' : ''} · ${hostName(tab.host)}${tab.handoff?.phase==='handed_off'?` · Handed off to the ${hostName(tab.handoff.destinationHost)} (agents continue there)`:tab.handoff&&tab.handoff.phase!=='reviewed'?' · Handoff: review page before continuing':''}` : state.activeTabId === 'vps' ? `${remoteName()} · ${state.remoteStatus}` : 'Ready';
  $('workspace-status').title = $('workspace-status').textContent;
  $('workspace-status').setAttribute('aria-label', $('workspace-status').textContent);
  renderUpdate();
  $('connection-status').textContent = state.api.ready ? 'Browser connector ready' : state.api.error ? 'Browser connector unavailable' : 'Browser connector starting…';
  $('connection-status').title = $('connection-status').textContent;
  $('connection-status').setAttribute('aria-label', $('connection-status').textContent);
  $('status-more').title = `${$('workspace-status').textContent} · ${$('connection-status').textContent}`;
  if (!$('status-panel').classList.contains('hidden')) renderStatusPanel();
  const notes = { login: 'Sign in with your Telegram account. Your bots appear on the left.', connected: 'Your Telegram account · bot chats only', locked: 'Unlock Telegram to load your bot chats.', offline: 'Telegram is offline. Retrying automatically; or sync in Settings.', loading: 'Connecting to Telegram…', 'layout-changed': 'Telegram layout changed. Bot chats may not load until Alan’s Workspace is updated.' };
  $('telegram-note').textContent = notes[state.telegramStatus] || notes.loading;
  $('telegram-note').classList.toggle('warn', state.telegramStatus === 'layout-changed');
  if (!$('shortcut-dialog').classList.contains('hidden')) refreshShortcutAvailability();
  scheduleLayout();
}
let updatePopupPinned = false;
function renderUpdate() {
  const version = $('version-label'); version.textContent = `v${state.version}`; version.title = `Release notes for v${state.version}`; version.onclick = () => command('open-release-notes');
  const badge = $('build-badge'), b = state.buildBadge;
  badge.classList.toggle('hidden', !b); if (b) { badge.textContent = b.text; badge.title = b.title; badge.className = `build-badge ${b.tone}`; }
  const note = $('update-note'), u = state.update || {};
  const label = u.busy ? 'Updating…' : u.error ? 'Update failed · Open download page' : u.ready ? `Restart to update to v${u.available}` : u.available ? `Update to v${u.available}` : '';
  note.classList.toggle('hidden', !label); note.textContent = label; note.disabled = !!u.busy;
  note.onclick = () => { if (u.error) command('open-download-page'); else { updatePopupPinned = true; renderUpdatePopup(); } };
  renderUpdatePopup();
  renderVersions();
  renderVmBanner();
  $('bundle-banner').classList.toggle('hidden', !state.bundleWarning);
  $('bundle-banner-text').textContent = state.bundleWarning || '';
  $('bundle-banner-dismiss').onclick = () => command('dismiss-bundle-warning');
  if (u.justUpdatedFrom) {
    toast(`Updated to v${state.version}.${u.vmRetry?.show ? ' A VM update did not finish: use Retry above, or send your agent the update prompt from Settings → Agent setup.' : ''}${state.platform === 'darwin' ? ' If your agent can no longer use this Mac, turn Alan’s Workspace (listed as alans-way-localapp) off and on again in System Settings → Privacy & Security → Accessibility.' : ''}`);
    command('dismiss-updated');
  }
}
// The dialog stays while an update runs so per-VM progress is visible. Escape
// and Later both mean "not now" and only snooze before the update starts.
function renderUpdatePopup() {
  const u = state.update || {}, popup = $('update-popup');
  const show = Boolean(u.popup || u.busy || (updatePopupPinned && u.available));
  // The popup is a DOM overlay painted below every attached view, so showing
  // or hiding it must reschedule the layout pass that obscures those views.
  setDialogVisible(popup, show, () => $('update-now'));
  scheduleLayout();
  if (!show) { updatePopupPinned = false; return; }
  $('update-popup-title').textContent = u.busy ? 'Updating' : 'Update available';
  $('update-popup-copy').textContent = u.busy ? 'Your VMs update first, then this app.' : `Alan’s Workspace v${u.available} is ready. You have v${state.version}.`;
  const progress = $('update-progress'); progress.replaceChildren();
  const single = (u.vms || []).length === 1;
  for (const vm of u.vms || []) {
    if (!vm.state) continue;
    const detail = vm.state === 'updating' ? String(vm.detail || '') : '';
    const line = single
      ? (vm.state === 'updating' ? detail || 'Updating your VM…' : vm.state === 'ok' ? 'VM updated' : `VM not updated: ${vm.error || 'unknown reason'}`)
      : `${vm.label}: ${vm.state === 'updating' ? detail || 'updating…' : vm.state === 'ok' ? 'updated' : `not updated: ${vm.error || 'unknown reason'}`}`;
    progress.append(element('p', `update-line ${vm.state}`, line));
    for (const pl of vm.pluginLines || []) {
      progress.append(element('p', `update-line plugin-line ${pl.tone === 'warn' ? 'warn' : pl.tone === 'ok' ? 'ok' : ''}`, String(pl.text || '')));
    }
  }
  if (u.error) progress.append(element('p', 'update-line failed', `Update failed: ${u.error}`));
  const now = $('update-now'), later = $('update-later');
  now.disabled = !!u.busy; later.disabled = !!u.busy;
  now.textContent = u.busy ? 'Updating…' : 'Update now';
}
// The bottom bar's versions and "Update everything". The dialog shows the
// plan first and nothing runs until its button is clicked; then it shows each
// step's progress, the closing summary and, when the app staged an update,
// "Restart to finish".
let updateAllOpen = false, updateAllView = 'plan', updateAllError = '';
const STEP_MARK = { pending: '·', running: '…', done: '✓', warn: '⚠', failed: '✗', skipped: '–' };
function renderVersions() {
  const v = state.versions || {}, run = state.updateAll || {};
  const label = $('version-label');
  label.textContent = v.text || `v${state.version}`;
  label.title = `${v.tooltip ? `${v.tooltip}\n` : ''}Click for the v${state.version} release notes`;
  const button = $('update-all');
  button.textContent = run.busy ? 'Updating…' : v.hasUpdate ? '↑ Update' : 'Update';
  button.classList.toggle('has-update', !!v.hasUpdate);
  button.title = v.hasUpdate ? 'Updates are available. Review them before anything runs.' : 'Check what can be updated';
  renderUpdateAll();
}
function renderUpdateAll() {
  const popup = $('update-all-popup'), v = state.versions || {}, run = state.updateAll || {};
  const show = updateAllOpen || !!run.busy;
  setDialogVisible(popup, show, () => $('update-all-go'));
  scheduleLayout();
  if (!show) return;
  const planning = updateAllView === 'plan' && !run.busy;
  const steps = v.steps || [], list = $('update-all-steps'), go = $('update-all-go'), cancel = $('update-all-cancel');
  list.replaceChildren();
  if (planning) {
    $('update-all-copy').textContent = v.upToDate ? 'Everything is up to date.' : steps.length ? 'This updates, in this order:' : 'Some components are missing or have not been verified. Check now to refresh their versions.';
    for (const step of steps) list.append(element('p', 'update-line', `${step.name}: ${step.from} → ${step.to}`));
    for (const row of v.components || []) {
      if (!steps.some((step) => step.id === row.id)) list.append(element('p', 'update-line', `${row.name}: ${row.version ? `${row.version} · ` : ''}${row.status}`));
    }
    if (steps.some((step) => step.id !== 'app')) list.append(element('p', 'update-line warn', 'Your bots restart briefly while the server updates.'));
    if (steps.some((step) => step.id === 'app')) list.append(element('p', 'update-line', 'The app update installs when you click Restart to finish.'));
  } else {
    $('update-all-copy').textContent = run.busy ? 'Updating. You can keep working; this takes a few minutes.'
      : run.summary || (updateAllError ? `Update everything stopped: ${updateAllError}` : '');
    for (const row of run.steps || []) {
      if (row.state === 'warn') {
        list.append(element('p', 'update-line warn', `⚠ ${row.warningText}`));
        continue;
      }
      const tail = row.state === 'failed' ? `: ${row.error}` : row.state === 'skipped' ? ' (not started)' : row.detail ? ` · ${row.detail}` : '';
      list.append(element('p', `update-line ${row.state}`, `${STEP_MARK[row.state] || ''} ${row.name}: ${row.from} → ${row.to}${tail}`));
    }
  }
  go.classList.toggle('hidden', planning ? false : !run.restart || run.busy);
  go.textContent = planning ? 'Update everything' : 'Restart to finish';
  go.disabled = planning ? !steps.length : false;
  $('update-all-check').classList.toggle('hidden', !planning);
  cancel.textContent = planning ? 'Cancel' : 'Close';
  cancel.disabled = !!run.busy;
}
function closeUpdateAll() { if (state?.updateAll?.busy) return; updateAllOpen = false; renderUpdateAll(); }
function renderVmBanner() {
  const u = state.update || {}, retry = u.vmRetry || {};
  const banner = $('vm-banner');
  banner.classList.toggle('hidden', !retry.show);
  if (!retry.show) return;
  $('vm-banner-text').textContent = u.vmRetrying ? 'Updating your VM…' : retry.version ? `Your VM is on v${retry.version}.` : 'Your VM is not up to date.';
  $('vm-banner-retry').disabled = !!(u.vmRetrying || u.busy);
}
let onboardingStep = 1, onboardingSignature = '', homeWasVisible = false;
function renderHome(bot, hidden) {
  $('home').classList.toggle('hidden', hidden);
  if (!hidden && !homeWasVisible && document.activeElement === document.body && canFocus($('home-address'))) $('home-address').focus({ preventScroll: true });
  homeWasVisible = !hidden;
  const homeAgent = $('home-agent');
  homeAgent.classList.toggle('hidden', !bot);
  if (bot) {
    homeAgent.style.setProperty('--h', String(bot.hue ?? 168));
    homeAgent.querySelector('.home-agent-name').textContent = bot.name;
    homeAgent.title = `Open a page for ${bot.name}`;
    homeAgent.setAttribute('aria-label', homeAgent.title);
  }
  const computer = state.platform === 'darwin' ? 'Mac' : thisComputer();
  const remoteKnown = state.remoteStatus === 'connected' || !!state.remoteUrl || !!state.vpsBrowser?.sshHost;
  // The chat offer is only real once the app observes a connected account; a
  // saved agent list alone proves nothing about sign-in or chat readiness.
  const waiting = {
    loading: bot ? `${bot.name}’s chat is still connecting.` : 'Telegram is still connecting.',
    login: bot ? `Sign in on the left to bring ${bot.name}’s chat here.` : 'Sign in to Telegram on the left to bring your agents here.',
    locked: 'Unlock Telegram on the left to load your bot chats.',
    offline: 'Telegram is offline. Reconnecting automatically.',
    'layout-changed': 'Telegram’s layout changed. Bot chats may not load until Alan’s Workspace is updated.',
  };
  const firstLine = state.telegramStatus === 'connected'
    ? bot ? `Talk to ${bot.name} in the left chat.` : state.bots.length ? 'Pick an agent on the left.' : 'Your agents appear on the left as bot chats.'
    : waiting[state.telegramStatus] || waiting.loading;
  $('home-copy').replaceChildren(
    document.createTextNode(firstLine),
    element('br'),
    document.createTextNode(`${bot ? `Or open a page on your ${computer} and hand it to ${bot.name}.` : `Pages open on your ${computer} below.`}${remoteKnown ? ' Keep their computer in view.' : ''}`));
}
function renderOnboarding(show) {
  const panel = $('onboarding');
  panel.classList.toggle('hidden', !show);
  if (!show) { onboardingSignature = ''; return; }
  const cloud = state.cloud || {};
  const signature = JSON.stringify(cloud.step === 'connect' ? ['cloud', cloud.step, cloud.diy, cloud.error] : cloud.step ? ['cloud', cloud.step, cloud.computer?.state, cloud.computer?.step, cloud.computer?.name, cloud.error, cloud.migration, cloud.telegramFallback, cloud.diy, cloud.botUsername, cloud.model, cloud.existingModel, cloud.modelDetected,
    cloud.tokenedProfiles, cloud.existingBotId, cloud.existingBotProfile, cloud.step === 'bot-chat' ? state.bots?.map(({ id, name, username }) => [id, name, username]) : null] : onboardingStep === 1 ? [1, state.telegramStatus, state.inApplications, cloud.error] : [onboardingStep]);
  if (signature === onboardingSignature) return;
  onboardingSignature = signature;
  const go = (step) => { onboardingStep = step; renderOnboarding(true); };
  const finish = async () => { onboardingStep = 1; await command('onboarding-done'); };
  const button = (label, className, onclick) => { const el = element('button', className, label); el.onclick = onclick; return el; };
  const card = element('div', 'onboarding-card');
  const actions = element('div', 'onboarding-actions');
  const windows = state.platform === 'win32';
  if (cloud.step) {
    renderCloudOnboarding(card, actions, cloud);
    card.append(actions);
    panel.replaceChildren(card);
    return;
  }
  card.append(element('p', 'onboarding-step', `Step ${onboardingStep} of 3`));
  if (onboardingStep === 1) {
    card.append(element('h2', '', 'Welcome to Alan’s Workspace'), element('p', 'settings-note', 'Three short steps connect your Hermes agent to this computer.'));
    // A failed deep-link claim lands here: explain it instead of showing a
    // silent ordinary wizard.
    if (cloud.error) card.append(element('p', 'settings-note', cloud.error));
    const signedIn = state.telegramStatus === 'connected';
    card.append(element('p', `check-item${signedIn ? ' done' : ''}`, signedIn ? '✓ Signed in to Telegram' : '○ Scan the QR code on the left with your phone: Telegram → Settings → Devices → Link Desktop Device.'));
    if (state.inApplications === false) {
      const move = element('div', 'onboarding-move');
      move.append(element('p', 'settings-note', 'Move Alan’s Workspace to your Applications folder so your agent can find it.'),
        button('Move to Applications', 'secondary-button', () => command('move-to-applications')));
      card.append(move);
    }
    const claimWrap = element('div', 'field'), claimLabel = element('label', '', 'Have a claim code from openalan.com?');
    claimLabel.htmlFor = 'ob-claim-code';
    const claimInput = element('input');
    claimInput.id = 'ob-claim-code'; claimInput.placeholder = 'Paste your claim code or link'; claimInput.autocomplete = 'off';
    const claimButton = button('Claim computer', 'secondary-button', async () => {
      claimButton.disabled = true;
      await command('cloud-claim-code', { code: claimInput.value.trim() });
      claimButton.disabled = false;
    });
    claimWrap.append(claimLabel, claimInput, claimButton);
    card.append(claimWrap);
    card.append(button('Use my own server', 'link-button', () => command('cloud-diy')));
    actions.append(button('Skip setup', 'secondary-button', finish), button('Next', 'primary-button', () => go(2)));
  } else if (onboardingStep === 2) {
    card.append(element('h2', '', 'Give your agent this prompt'));
    const box = element('textarea', 'onboarding-prompt'); box.readOnly = true; box.rows = 7; box.setAttribute('aria-label', 'Setup prompt for your agent');
    command('agent-prompt', { botId: state.selectedBotId, copy: false }).then((text) => { if (typeof text === 'string') box.value = text; });
    card.append(box, element('p', 'settings-note', 'Paste it into the chat with your Hermes bot on the left. It tells your bot to use the installed Alan’s Way setup skill.'));
    const help = button('No Hermes agent yet? Start here ↗', 'link-button', () => command('create-tab', { url: 'https://github.com/NousResearch/hermes-agent' }));
    card.append(help);
    actions.append(button('Back', 'secondary-button', () => go(1)),
      button('Next', 'secondary-button', () => go(3)),
      button('Copy prompt', 'primary-button', async () => { if (typeof await command('agent-prompt', { botId: state.selectedBotId }) === 'string') toast('Prompt copied. Paste it to your Hermes bot.'); }));
  } else {
    card.append(element('h2', '', 'Finish the connection'),
      element('p', 'settings-note', `Your agent will send you one command. ${windows ? 'Open PowerShell as Administrator' : 'Open Terminal'}, paste it, and send back what it prints. Your agent then tells you the two addresses below.`));
    const field = (id, label, placeholder, value) => {
      const wrap = element('div', 'field'), lab = element('label', '', label), input = element('input');
      lab.htmlFor = id; input.id = id; input.placeholder = placeholder; input.value = value || ''; input.autocomplete = 'off';
      wrap.append(lab, input); card.append(wrap); return input;
    };
    const vps = field('ob-vps-ssh-host', 'Agent machine SSH address', 'you@your-vps', state.vpsBrowser?.sshHost);
    const mine = field('ob-mac-ssh-host', `This ${windows ? 'PC' : 'Mac'}’s SSH address`, windows ? 'you@mypc' : 'you@mymac', state.macSshHost);
    const results = element('div', 'checklist hidden');
    const checkButton = button('Check setup', 'secondary-button', async () => {
      if (!await command('settings', { macSshHost: mine.value.trim(), vpsBrowser: { ...state.vpsBrowser, sshHost: vps.value.trim() } })) return;
      await runSetupCheck(checkButton, results);
    });
    appendServerSetup(card, () => command('settings', { macSshHost: mine.value.trim(), vpsBrowser: { ...state.vpsBrowser, sshHost: vps.value.trim() } }));
    card.append(checkButton, button('Copy report', 'secondary-button', copyReport), results);
    actions.append(button('Back', 'secondary-button', () => go(2)), button('Done', 'primary-button', finish));
  }
  card.append(actions);
  panel.replaceChildren(card);
}
function renderCloudOnboarding(card, actions, cloud) {
  const button = (label, className, onclick) => { const el = element('button', className, label); el.onclick = onclick; return el; };
  const go = (step) => command('cloud-goto', { step });
  const next = () => command('cloud-next');
  if (cloud.diy && cloud.model === 'existing') {
    const found = cloud.existingModel;
    card.append(element('p', 'settings-note', found
      ? `Using your server’s configured model: ${found.provider} / ${found.model}.`
      : 'Using the model already set on your server.'));
  }
  if (cloud.step === 'cloud-wait') {
    const labels = { new: 'Creating your computer…', client_created: 'Creating your computer…', computer_created: 'Booting your computer…', bootstrapping: 'Installing your agent…' };
    card.append(element('h2', '', 'Setting up your Alan computer'),
      element('p', 'settings-note', labels[cloud.computer?.state] || 'Asking our servers for your computer…'),
      element('p', 'settings-note', cloud.computer?.step ? `Status: ${cloud.computer.step}` : 'This usually takes a couple of minutes. Keep this window open.'));
    if (cloud.error) card.append(element('p', 'settings-note', cloud.error));
    actions.append(button('Get help', 'secondary-button', () => go('support')));
  } else if (cloud.step === 'connect') {
    const status = element('p', 'settings-note', '');
    let input, attempt = 0;
    const check = async (extra = {}) => {
      const request = ++attempt;
      status.textContent = 'Checking…';
      const result = await api.command('cloud-connect', extra).catch(error => ({ host: extra.host, detail: error.message }));
      if (request !== attempt || !status.isConnected) return;
      if (cloud.diy && result?.host !== input.value.trim()) { status.textContent = ''; return; }
      status.textContent = result?.detail || '';
      if (result?.existingModel) toast(result.detail);
      if (cloud.diy && result?.ok && !result.cancelled) await go('model');
    };
    if (cloud.diy) {
      card.append(element('h2', '', 'Use your own server'), element('p', 'settings-note', 'Enter the SSH address of the machine that will run your agent.'));
      const field = element('div', 'field'), lab = element('label', '', 'Server SSH address'); lab.htmlFor = 'ob-diy-host';
      input = element('input'); input.id = 'ob-diy-host'; input.placeholder = 'you@your-server'; input.autocomplete = 'off'; input.value = state.vpsBrowser?.sshHost || '';
      field.append(lab, input); card.append(field);
      actions.append(button('Back', 'secondary-button', () => command('cloud-diy', { off: true })),
        button('Connect', 'primary-button', () => check({ host: input.value.trim() })));
    } else {
      card.append(element('h2', '', 'Connect to your computer'),
        element('p', 'settings-note', `${cloud.computer?.name || 'Your computer'} pairs over Tailscale. Install Tailscale, open the pairing page, then check again.`));
      actions.append(button('Install Tailscale', 'secondary-button', () => command('cloud-tailscale-download')),
        button('Open pairing page', 'secondary-button', () => command('cloud-open-pairing')),
        button('Check again', 'primary-button', () => check()));
    }
    card.append(status);
  } else if (cloud.step === 'migrate') {
    card.append(element('h2', '', 'Bring your existing Hermes?'), element('p', 'settings-note', 'Move your old Hermes setup to the new computer, or start fresh.'));
    const status = element('p', 'settings-note', '');
    if (cloud.migration === 'bring') {
      const box = element('textarea', 'onboarding-prompt'); box.readOnly = true; box.rows = 3; box.setAttribute('aria-label', 'Migrate command'); box.value = cloud.migrateCommand || '';
      card.append(element('p', 'settings-note', 'Run this on the old machine, in a terminal. It packs up Hermes and ships it to the new computer.'), box, status);
      const log = element('pre', 'settings-note', '');
      const check = button('Check again', 'primary-button', async () => {
        status.textContent = 'Checking…';
        const result = await command('cloud-migrate-check');
        status.textContent = result?.done ? `Migration found.${result.sharedToken ? ' The shared env already has a bot token.' : ''}${result.profiles?.length ? ` ${result.profiles.length} profile(s) already have a bot token.` : ''}` : result?.detail || '';
      });
      actions.append(
        button('Start fresh instead', 'secondary-button', () => command('cloud-migrate', { choice: 'fresh' })),
        button('Copy command', 'secondary-button', async () => { await command('cloud-migrate-copy'); toast('Migrate command copied.'); }),
        ...(state.platform === 'darwin' ? [button('Run on this Mac', 'secondary-button', async () => {
          card.append(log);
          status.textContent = 'Running the migrate script on this Mac…';
          const result = await command('cloud-migrate-local');
          status.textContent = result?.detail || '';
          if (result?.done) await command('cloud-migrate-check');
        })] : []),
        check);
      cloudLogEl = log;
    } else {
      actions.append(button('Start fresh', 'secondary-button', () => command('cloud-migrate', { choice: 'fresh' })),
        button('Bring my existing Hermes', 'primary-button', () => command('cloud-migrate', { choice: 'bring' })));
    }
  } else if (cloud.step === 'model') {
    const found = cloud.diy && cloud.existingModel;
    card.append(element('h2', '', 'Choose the model login'), element('p', 'settings-note', 'Sign in with your Claude subscription, or paste an Anthropic API key for the agent.'));
    const status = element('p', 'settings-note', found ? `Your server already uses ${found.provider} · ${found.model}.` : '');
    const field = element('div', 'field'), lab = element('label', '', 'Anthropic API key'); lab.htmlFor = 'ob-api-key';
    const input = element('input'); input.id = 'ob-api-key'; input.placeholder = 'sk-ant-…'; input.type = 'password'; input.autocomplete = 'off';
    field.append(lab, input);
    card.append(field, status);
    actions.append(
      button('Use my Claude subscription', found ? 'secondary-button' : 'primary-button', async () => {
        status.textContent = 'Starting the sign-in…';
        const result = await command('cloud-model-subscribe');
        status.textContent = result?.detail || '';
        if (!actions.querySelector('.cloud-check-signin')) actions.append(button('Check sign-in', 'secondary-button cloud-check-signin', async () => {
          status.textContent = 'Checking…';
          const check = await command('cloud-model-check');
          if (!check?.done) status.textContent = check?.detail || 'Still waiting.';
        }));
      }),
      button('Save API key', 'secondary-button', async () => {
        status.textContent = 'Saving…';
        const result = await command('cloud-model', { choice: 'apikey', key: input.value.trim() });
        status.textContent = result?.detail || '';
      }));
    if (cloud.diy) {
      const keep = button(found ? 'Use the model already on my server' : 'Use the model already set on my server',
        found ? 'primary-button' : 'secondary-button', () => command('cloud-model-existing'));
      if (found) actions.prepend(keep); else actions.append(keep);
      card.append(element('p', 'settings-note', 'Your bot’s first reply after pairing will confirm the model works. Return here with “Change model” during pairing or “Run setup wizard” in Settings.'));
      if (!cloud.modelDetected) {
        if (!found) status.textContent = 'Reading your server’s configured model…';
        command('cloud-model-detect').then((result) => { status.textContent = result?.detail || ''; });
      } else if (!found) {
        status.textContent = 'Could not detect a configured model. You can use the model already set on your server, or choose a new login.';
      }
    }
  } else if (cloud.step === 'bot-chat' && cloud.diy) {
    card.append(element('h2', '', 'Continue with your existing bot'),
      element('p', 'settings-note', 'Open the Telegram bot already used by your Hermes gateway, then paste the setup prompt into its chat on the left.'));
    const profiles = cloud.tokenedProfiles || [];
    const profile = element('select'); profile.id = 'ob-bot-profile';
    if (profiles.length > 1) profile.append(element('option', '', 'Choose a profile…'));
    for (const name of profiles) {
      const option = element('option', '', name === '*' ? 'Shared Hermes bot' : name);
      option.value = name; profile.append(option);
    }
    if (profiles.length > 1) profile.options[0].value = '';
    if (cloud.existingBotProfile) profile.value = cloud.existingBotProfile;
    if (profiles.length) {
      const field = element('div', 'field'), label = element('label', '', 'Hermes profile');
      label.htmlFor = profile.id; field.append(label, profile); card.append(field);
    }
    const field = element('div', 'field'), label = element('label', '', 'Telegram bot username');
    const input = element('input'); input.id = 'ob-existing-bot'; input.placeholder = '@your_hermes_bot'; input.autocomplete = 'off';
    label.htmlFor = input.id;
    const bots = (state.bots || []).filter(bot => bot.username && bot.username.toLowerCase() !== 'botfather');
    const selected = bots.find(bot => bot.id === (cloud.existingBotId || state.selectedBotId));
    input.value = selected?.username || '';
    if (bots.length) {
      const picker = element('select'); picker.setAttribute('aria-label', 'Choose an existing Telegram bot');
      const placeholder = element('option', '', 'Choose a bot chat…'); placeholder.value = ''; picker.append(placeholder);
      for (const bot of bots) {
        const option = element('option', '', `${bot.name || bot.username} (@${bot.username})`);
        option.value = bot.username; picker.append(option);
      }
      picker.value = input.value;
      picker.onchange = () => { input.value = picker.value; };
      field.append(picker);
    }
    field.append(label, input); card.append(field);
    const status = element('p', 'settings-note', ''); card.append(status);
    actions.append(button('Change model', 'secondary-button', () => go('model')),
      button('Create a new bot', 'secondary-button', () => go('telegram')),
      button('Open bot chat', cloud.existingBotId ? 'secondary-button' : 'primary-button', async () => {
        status.textContent = 'Opening your bot…';
        const result = await command('cloud-existing-bot', { profile: profile.value, username: input.value.trim() });
        status.textContent = result?.ok ? 'Your bot chat is open.' : 'Could not open the bot. Check your profile, username and Telegram sign-in, then try again.';
      }));
    if (cloud.existingBotId) {
      const box = element('textarea', 'onboarding-prompt'); box.readOnly = true; box.rows = 7;
      box.setAttribute('aria-label', 'Setup prompt for your existing bot');
      command('agent-prompt', { botId: cloud.existingBotId, copy: false }).then(text => { if (typeof text === 'string') box.value = text; });
      card.append(box);
      actions.append(button('Copy setup prompt', 'primary-button', async () => {
        if (typeof await command('agent-prompt', { botId: cloud.existingBotId }) === 'string') toast('Prompt copied. Paste it into your Hermes bot chat.');
      }), button('Done', 'secondary-button', next));
    }
  } else if (cloud.step === 'telegram') {
    if (cloud.diy) actions.append(button('Change model', 'secondary-button', () => go('model')));
    card.append(element('h2', '', 'Set up your Telegram bot'),
      element('p', 'settings-note', 'Alan talks to you through a Telegram bot. We can make one with @BotFather, or you can paste a token you already have.'));
    const status = element('p', 'settings-note', '');
    card.append(status);
    if (cloud.telegramFallback) {
      card.append(element('p', 'settings-note', 'To make a bot by hand: 1. Open @BotFather in Telegram. 2. Send /newbot and follow the prompts. 3. Copy the token it gives you and paste it here.'));
      const field = element('div', 'field'), lab = element('label', '', 'Bot token'); lab.htmlFor = 'ob-bot-token';
      const input = element('input'); input.id = 'ob-bot-token'; input.placeholder = '123456789:AAE…'; input.autocomplete = 'off';
      field.append(lab, input); card.append(field);
      actions.append(button('Save token', 'primary-button', async () => {
        status.textContent = 'Checking…';
        const result = await command('cloud-telegram-paste', { token: input.value.trim() });
        status.textContent = result?.detail || '';
      }));
    } else {
      if (cloud.diy) actions.append(button('Use my existing bot', 'primary-button', () => go('bot-chat')));
      actions.append(button(cloud.diy ? 'Create a new bot' : 'Create my bot', cloud.diy ? 'secondary-button' : 'primary-button', async () => {
        status.textContent = 'Talking to @BotFather…';
        const result = await command('cloud-telegram');
        status.textContent = result?.done ? 'Bot created.' : result?.detail || '';
      }));
    }
  } else if (cloud.step === 'support') {
    card.append(element('h2', '', 'We’re on it'),
      element('p', 'settings-note', 'Something on our side needs a look. The support Discord has the team and your setup details handy.'));
    if (cloud.computer?.error) card.append(element('p', 'settings-note', `Detail: ${cloud.computer.error}`));
    actions.append(button('Join support Discord', 'primary-button', () => command('cloud-discord')), button('Skip', 'secondary-button', () => go('done')));
  } else {
    card.append(element('h2', '', 'Continue setup'), element('p', 'settings-note', `Step: ${cloud.step}`));
    actions.append(button('Get help', 'secondary-button', () => go('support')), button('Continue', 'primary-button', next));
  }
}
function rect(id) {
  const el = $(id); if (!el || el.classList.contains('hidden')) return null;
  const box = el.getBoundingClientRect(); if (!box.width || !box.height) return null;
  return { x: box.x + 1, y: box.y + 1, width: box.width - 2, height: box.height - 2 };
}
function scheduleLayout() {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => api.layout({ telegram: focusMode ? null : rect('telegram-slot'), browser: rect('browser-slot'), preview: rect('preview-screen'), obscured: dialogStack.length > 0 || !$('tabs-panel').classList.contains('hidden') || !$('status-panel').classList.contains('hidden') }));
}
// The mini VM window is anchored bottom-right until dragged; its saved offset
// is relative to the workspace pane and clamped so it can never get lost.
let previewDragging = false;
function positionPreview() {
  const slot = $('remote-preview-slot'), pos = state?.previewPos;
  if (previewDragging) return;
  if (state?.showBrowser === false || !pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) { slot.style.left = ''; slot.style.top = ''; slot.style.right = ''; slot.style.bottom = ''; return; }
  const pane = slot.parentElement.getBoundingClientRect();
  const x = Math.max(0, Math.min(pos.x, pane.width - slot.offsetWidth));
  const y = Math.max(0, Math.min(pos.y, pane.height - slot.offsetHeight));
  slot.style.left = `${x}px`; slot.style.top = `${y}px`; slot.style.right = 'auto'; slot.style.bottom = 'auto';
}
function wirePreviewDrag() {
  const chrome = $('preview-chrome'), slot = $('remote-preview-slot');
  let drag = null;
  chrome.addEventListener('pointerdown', (event) => {
    if (event.target.closest('button') || state?.showBrowser === false) return;
    previewDragging = true;
    const paneBox = slot.parentElement.getBoundingClientRect(), slotBox = slot.getBoundingClientRect();
    drag = { dx: event.clientX - slotBox.left, dy: event.clientY - slotBox.top, pane: paneBox };
    chrome.setPointerCapture(event.pointerId);
  });
  chrome.addEventListener('pointermove', (event) => {
    if (!drag) return;
    const x = Math.max(0, Math.min(event.clientX - drag.pane.left - drag.dx, drag.pane.width - slot.offsetWidth));
    const y = Math.max(0, Math.min(event.clientY - drag.pane.top - drag.dy, drag.pane.height - slot.offsetHeight));
    slot.style.left = `${x}px`; slot.style.top = `${y}px`; slot.style.right = 'auto'; slot.style.bottom = 'auto';
    drag.pos = { x: Math.round(x), y: Math.round(y) };
    scheduleLayout();
  });
  const end = () => { if (drag?.pos) command('preview-move', drag.pos).catch(() => {}); drag = null; previewDragging = false; };
  chrome.addEventListener('pointerup', end); chrome.addEventListener('pointercancel', end);
}
// A drag started inside the streamed picture lands here as deltas — the slot
// moves live and the drop point persists exactly like a chrome-strip drag.
let previewLivePos = null;
api.onPreviewNudge?.(({ dx, dy }) => {
  if (!state?.preview || state.activeTabId === 'vps' || state?.showBrowser === false) return;
  const slot = $('remote-preview-slot'), pane = slot.parentElement.getBoundingClientRect(), box = slot.getBoundingClientRect();
  const x = Math.max(0, Math.min(box.left - pane.left + dx, pane.width - slot.offsetWidth));
  const y = Math.max(0, Math.min(box.top - pane.top + dy, pane.height - slot.offsetHeight));
  slot.style.left = `${x}px`; slot.style.top = `${y}px`; slot.style.right = 'auto'; slot.style.bottom = 'auto';
  previewLivePos = { x: Math.round(x), y: Math.round(y) };
  previewDragging = true;
  scheduleLayout();
});
api.onPreviewDrop?.(() => {
  if (previewLivePos) command('preview-move', previewLivePos).catch(() => {});
  previewLivePos = null; previewDragging = false;
});
// Registered once with a mutable target: re-rendering the migrate card must
// not stack listeners or every log chunk would append once per past render.
let cloudLogEl = null;
api.onCloudLog?.((text) => { if (cloudLogEl?.isConnected) cloudLogEl.textContent = (cloudLogEl.textContent + text).slice(-8000); });
// All DOM dialogs share one focus boundary, including busy updates that have
// no enabled actions. Inert keeps the obscured workspace out of the tab order.
const dialogStack = [], dialogOpeners = new Map();
function canFocus(node) {
  return node instanceof HTMLElement && node.isConnected && !node.matches(':disabled') && !node.closest('[inert]')
    && (node.tabIndex >= 0 || node.hasAttribute('tabindex') || node.isContentEditable)
    && node.getClientRects().length > 0 && !['hidden', 'collapse'].includes(getComputedStyle(node).visibility);
}
function dialogItems(dialog) {
  return [...dialog.querySelectorAll('button, input, select, textarea, a[href], summary, [tabindex]')].filter(node => node.tabIndex >= 0 && canFocus(node));
}
function focusDialog(dialog, preferred) {
  (canFocus(preferred) ? preferred : dialogItems(dialog)[0] || dialog).focus({ preventScroll: true });
}
function setDialogVisible(dialog, show, initialFocus) {
  const index = dialogStack.indexOf(dialog), changed = show !== (index >= 0), wasTop = dialogStack.at(-1) === dialog;
  if (show && index < 0) { dialogOpeners.set(dialog, document.activeElement); dialogStack.push(dialog); }
  if (!show && index >= 0) dialogStack.splice(index, 1);
  dialog.classList.toggle('hidden', !show);
  const top = dialogStack.at(-1);
  $('shell').inert = !!top;
  for (const id of ['modal', 'update-popup', 'update-all-popup', 'shortcut-dialog']) {
    const popup = $(id); popup.inert = popup !== top;
    popup.style.zIndex = String(100 + Math.max(0, dialogStack.indexOf(popup)));
  }
  if (show) {
    queueMicrotask(() => {
      if (dialogStack.at(-1) === dialog && (!dialog.contains(document.activeElement) || !canFocus(document.activeElement))) focusDialog(dialog, changed ? initialFocus?.() : null);
    });
  } else if (changed) {
    const opener = dialogOpeners.get(dialog); dialogOpeners.delete(dialog);
    if (wasTop) {
      if (canFocus(opener)) opener.focus({ preventScroll: true });
      else if (top) focusDialog(top);
      else [$('settings-button'), $('settings-fallback'), $('search-toggle'), $('new-tab')].find(canFocus)?.focus({ preventScroll: true });
    }
  }
}
document.addEventListener('focusin', event => {
  const dialog = dialogStack.at(-1);
  if (dialog && !dialog.contains(event.target)) focusDialog(dialog);
});
document.addEventListener('keydown', event => {
  const dialog = dialogStack.at(-1);
  if (!dialog) return;
  if (event.key === 'Escape') {
    event.preventDefault(); event.stopImmediatePropagation();
    if (dialog.id === 'shortcut-dialog') closeShortcuts();
    else if (dialog.id === 'modal') {
      if (settingsSession && $('settings-search')?.value) clearSettingsSearch();
      else closeModal();
    }
    else if (dialog.id === 'update-all-popup') closeUpdateAll();
    else if (!state?.update?.busy) $('update-later').click();
  } else if (event.key === 'Tab') {
    const items = dialogItems(dialog), index = items.indexOf(document.activeElement);
    if (!items.length || index < 0 || (event.shiftKey ? index === 0 : index === items.length - 1)) {
      event.preventDefault(); focusDialog(dialog, event.shiftKey ? items.at(-1) : items[0]);
    }
  }
}, true);
function openModal(title) {
  settingsSession = null; $('modal').classList.remove('settings-modal');
  modalOpen = true; $('modal-title').textContent = title; $('modal-body').replaceChildren();
  setDialogVisible($('modal'), true, () => $('modal-close')); scheduleLayout();
}
function closeModal() { settingsSession = null; modalOpen = false; setDialogVisible($('modal'), false); scheduleLayout(); }
function refreshShortcutAvailability() {
  const available = state?.tabs.some(tab => tab.id === state.activeTabId && tab.host !== 'vps' && tab.host !== 'remote');
  // Update badges in place: state broadcasts must not rebuild the reading
  // region, steal its focus, reset a query, or move it back to the first row.
  for (const item of $('shortcut-results').querySelectorAll('[data-requires="local-tab"]')) {
    const note = item.querySelector('.shortcut-unavailable');
    if (available) note?.remove();
    else if (!note) item.querySelector('.shortcut-copy').append(element('span', 'shortcut-unavailable', 'No local tab open'));
  }
}
function renderShortcuts() {
  const query = $('shortcut-search').value.trim().toLocaleLowerCase(), results = $('shortcut-results');
  const keyNames = { '⌘': 'Command', '⇧': 'Shift', '⇥': 'Tab', '↩': 'Return', '⌦': 'Forward Delete', '↑': 'Up arrow', '↓': 'Down arrow', '←': 'Left arrow', '→': 'Right arrow' };
  results.replaceChildren(); let count = 0;
  for (const group of api.shortcuts.groups) {
    const matches = group.rows.filter(row => window.WorkspaceShortcuts.matchesShortcut(row, query));
    if (!matches.length) continue;
    count += matches.length;
    const section = element('section', 'shortcut-section'), heading = element('h3', '', group.title);
    section.append(heading, element('p', 'shortcut-scope', group.note));
    const list = element('div', 'shortcut-list'); list.setAttribute('role', 'list'); list.setAttribute('aria-label', group.title);
    for (const row of matches) {
      const item = element('div', 'shortcut-row'), copy = element('div', 'shortcut-copy'), keys = element('div', 'shortcut-keys');
      item.dataset.shortcut = row.id; item.setAttribute('role', 'listitem');
      if (row.requires) item.dataset.requires = row.requires;
      copy.append(element('div', 'shortcut-name', row.title), element('p', 'shortcut-description', row.description));
      row.keys.forEach((chord, index) => {
        if (index) keys.append(element('span', 'shortcut-or', 'or'));
        const combo = element('span', 'shortcut-chord');
        for (const key of chord) {
          const cap = element('kbd', '', key); cap.setAttribute('aria-label', keyNames[key] || key); combo.append(cap);
        }
        keys.append(combo);
      });
      item.append(copy, keys); list.append(item);
    }
    section.append(list); results.append(section);
  }
  $('shortcut-clear').classList.toggle('hidden', !query);
  $('shortcut-status').textContent = count ? `${count} shortcut${count === 1 ? '' : 's'}${query ? ' found' : ''}.` : 'No shortcuts found.';
  if (!count) {
    const empty = element('div', 'shortcut-empty');
    empty.append(element('h3', '', 'No shortcuts found'), element('p', '', 'Try an action, a key, or a place like “agent” or “tab”.'));
    results.append(empty);
  }
  refreshShortcutAvailability();
}
function showShortcuts() {
  if (!$('shortcut-dialog').classList.contains('hidden')) { $('shortcut-search').focus(); return; }
  $('shortcut-platform').textContent = api.shortcuts.platform;
  $('shortcut-search').value = ''; renderShortcuts();
  setDialogVisible($('shortcut-dialog'), true, () => $('shortcut-search')); scheduleLayout();
}
function closeShortcuts() { setDialogVisible($('shortcut-dialog'), false); scheduleLayout(); }
function renderSettingsBots() {
  const list = $('settings-bots');
  if (!modalOpen || !list || list.querySelector('[aria-busy="true"]')) return;
  const bots = orderedBots(true);
  const signature = JSON.stringify(bots.map(bot => [bot.id, bot.name, bot.username, !state.hidden.includes(bot.id)]));
  if (list.dataset.signature === signature) return;
  const focusedId = document.activeElement?.dataset.botId;
  list.dataset.signature = signature; list.replaceChildren();
  if (!bots.length) list.append(element('p', 'settings-note', 'Sign in to Telegram and sync to find your bot chats.'));
  for (const bot of bots) {
    const row = element('label', 'bot-visibility'), toggle = element('input');
    toggle.type = 'checkbox'; toggle.setAttribute('role', 'switch'); toggle.setAttribute('aria-label', `Show ${bot.name}`);
    toggle.dataset.botId = bot.id; toggle.checked = !state.hidden.includes(bot.id);
    const copy = element('span', 'visibility-copy');
    copy.append(element('span', 'visibility-name', bot.name));
    if (bot.username) copy.append(element('span', 'visibility-username', `@${bot.username}`));
    const status = element('span', 'settings-action-status settings-inline-status'); status.setAttribute('role', 'status'); copy.append(status);
    toggle.onchange = async () => {
      const visible = toggle.checked;
      const reply = await runSettingsAction(toggle, status, () => api.command('set-bot-visibility', { id: bot.id, visible }));
      if (!reply.ok) toggle.checked = !state.hidden.includes(bot.id);
    };
    row.append(copy, toggle); list.append(row);
    if (focusedId === bot.id) toggle.focus({ preventScroll: true });
  }
}
const permissionLabels = { geolocation: 'Precise location', 'geolocation-approximate': 'General area', notifications: 'Notifications', camera: 'Camera', microphone: 'Microphone', 'clipboard-read': 'Read clipboard' };
function renderRecordings() {
  const list = $('recordings-list');
  if (!modalOpen || !list) return;
  const signature = JSON.stringify([state.recordings, state.bots.map(bot => [bot.id, bot.name])]);
  if (list.dataset.signature === signature) return;
  list.dataset.signature = signature; list.replaceChildren();
  if (!state.recordings.length) list.append(element('p', 'settings-note', 'No recordings yet.'));
  for (const item of state.recordings) {
    const row = element('div', 'setting-row'), copy = element('span', 'visibility-copy');
    copy.append(element('span', 'visibility-name', item.title), element('span', 'visibility-username',
      `${item.steps} ${item.steps === 1 ? 'step' : 'steps'} · ${new Date(item.createdAt).toLocaleString()}${item.keepTyped ? ' · typed text kept' : ''}`));
    const remove = element('button', 'secondary-button', 'Delete'); remove.setAttribute('aria-label', `Delete recording ${item.title}`);
    remove.onclick = () => command('recording-delete', { id: item.id });
    const shares = element('div', 'recording-shares');
    shares.append(element('span', '', 'Shared with'));
    for (const bot of state.bots) {
      const label = element('label'), box = element('input');
      box.type = 'checkbox'; box.dataset.botId = bot.id; box.checked = item.sharedWith.includes(bot.id);
      box.onchange = () => command('recording-share', { id: item.id, botIds: [...shares.querySelectorAll('input:checked')].map(input => input.dataset.botId) });
      label.append(box, ` ${bot.name}`); shares.append(label);
    }
    row.append(copy, remove); list.append(row, shares);
  }
}
function permissionChoice(selected, onChange) {
  const select = element('select');
  for (const [value, label] of [['block', 'Block'], ['allow', 'Allow'], ['ask', 'Use default']]) {
    const option = element('option', '', label); option.value = value; option.selected = selected === value; select.append(option);
  }
  select.onchange = () => onChange(select.value); return select;
}
function renderSitePermissions() {
  const list = $('site-permissions'); if (!modalOpen || !list) return;
  const signature = JSON.stringify(state.sitePermissions);
  if (list.dataset.signature === signature) return;
  const focused = document.activeElement?.getAttribute('aria-label');
  list.dataset.signature = signature; list.replaceChildren();
  for (const [scope, sites] of Object.entries(state.sitePermissions || {})) {
    for (const [origin, permissions] of Object.entries(sites)) for (const [permission, decision] of Object.entries(permissions)) {
      if (!permissionLabels[permission]) continue;
      const row = element('div', 'setting-row'), copy = element('span', 'visibility-copy');
      copy.append(element('span', 'visibility-name', `${permissionLabels[permission]} · ${scope === 'telegram' ? 'Telegram' : 'Browser'}`), element('span', 'visibility-username', origin));
      const status = element('span', 'settings-action-status settings-inline-status'); status.setAttribute('role', 'status'); copy.append(status);
      const choice = permissionChoice(decision, async value => { const reply = await runSettingsAction(choice, status, () => api.command('set-site-permission', { scope, origin, permission, decision:value })); if (!reply.ok) choice.value = decision; });
      choice.setAttribute('aria-label', `${origin} ${permissionLabels[permission]}`); row.append(copy, choice); list.append(row);
    }
  }
  if (focused) { const target = [...list.querySelectorAll('[aria-label]')].find(node => node.getAttribute('aria-label') === focused); if (canFocus(target)) target.focus({ preventScroll: true }); }
}
function showSitePermissionSettings(body) {
  const details = element('details', 'settings-details'); details.append(element('summary', '', 'How site permissions work'), element('p', 'settings-note', 'General area only blocks precise location and allows approximate requests where supported. Sites can also estimate your area from your IP. Camera, microphone, notifications and clipboard access ask once per site and remember your choice. Only the tab you control can request access.')); body.append(details);
  const locationRow = element('div', 'setting-row'); locationRow.append(element('span', '', 'Location requests'));
  const location = element('select'); location.setAttribute('aria-label', 'Default location access');
  for (const [value, label] of [['approximate', 'General area only'], ['block', 'Block device location'], ['ask', 'Ask once for precise location']]) { const option = element('option', '', label); option.value = value; option.selected = state.locationDefault === value; location.append(option); }
  locationRow.append(location); body.append(locationRow); const locationStatus = settingsStatus(body);
  location.onchange = async () => { await runSettingsAction(location, locationStatus, () => api.command('settings', { locationDefault: location.value }), 'Saving…', 'Location access saved.'); location.value = state.locationDefault; };
  const field = element('div', 'field'), label = element('label', '', 'Add a site permission'), input = element('input');
  input.id = 'permission-origin'; label.htmlFor = input.id; input.placeholder = 'https://www.google.com';
  const permission = element('select'); permission.setAttribute('aria-label', 'Site permission type');
  for (const [value, label] of Object.entries(permissionLabels)) { const option = element('option', '', label); option.value = value; permission.append(option); }
  const decision = permissionChoice('block', () => {}); decision.setAttribute('aria-label', 'Site permission setting');
  const save = element('button', 'secondary-button', 'Save site permission');
  field.append(label, input, permission, decision, save); body.append(field);
  const saveStatus = settingsStatus(body);
  save.onclick = async () => { const reply = await runSettingsAction(save, saveStatus, () => api.command('set-site-permission', { origin:input.value.trim(), permission:permission.value, decision:decision.value }), 'Saving site permission…', 'Site permission saved. Reload the site to apply it.'); if (reply.ok) input.value = ''; };
  const list = element('div'); list.id = 'site-permissions'; body.append(list); renderSitePermissions();
  settingsAction(body, 'Reset browser permissions', 'reset-site-permissions', {}, { success: 'Browser permissions reset.' });
  return () => { if (document.activeElement !== location) location.value = state.locationDefault; };
}
function showCookieSettings(body) {
  const list = element('div'); list.id = 'cookie-list';
  const status = settingsStatus(body);
  const retry = element('button', 'secondary-button', 'Refresh cookies'); retry.id = 'settings-refresh-cookies';
  const replaceRows = rows => {
    const replacingFocus = list.contains(document.activeElement);
    list.replaceChildren(...rows);
    if (replacingFocus && !body.closest('[hidden]')) retry.focus({ preventScroll: true });
  };
  const refresh = async () => {
    const reply = await runSettingsAction(retry, status, () => api.command('list-cookies'), 'Loading cookies…');
    if (reply.stale || reply.busy) return;
    const items = reply.result;
    if (!reply.ok || !Array.isArray(items) || items.some(item => !item || typeof item.domain !== 'string' || !Number.isInteger(item.count) || item.count < 1)) {
      if (reply.ok) { status.textContent = 'Cookies could not be read. Try Refresh cookies.'; status.classList.add('error'); }
      replaceRows([element('p', 'settings-note', 'Current cookie data is unavailable. Refresh cookies to try again.')]); return;
    }
    replaceRows(items.length ? items.map((item) => {
      const row = element('div', 'setting-row');
      row.append(element('span', '', `${item.domain} · ${item.count} ${item.count === 1 ? 'cookie' : 'cookies'}`));
      const clear = element('button', 'secondary-button', 'Clear'); clear.setAttribute('aria-label', `Clear cookies for ${item.domain}`);
      clear.onclick = async () => { const reply = await runSettingsAction(clear, status, () => api.command('clear-cookies', { domain: item.domain }), 'Clearing cookies…'); if (reply.ok) await refresh(); };
      row.append(clear); return row;
    }) : [element('p', 'settings-note', 'No cookies stored.')]);
  };
  retry.onclick = refresh;
  const clearAll = element('button', 'secondary-button', 'Clear all cookies'); clearAll.id = 'settings-clear-cookies';
  clearAll.onclick = async () => { const reply = await runSettingsAction(clearAll, status, () => api.command('clear-cookies'), 'Clearing cookies…'); if (reply.ok) await refresh(); };
  body.append(list, retry, clearAll); refresh();
}
function showMacPermissions(body) {
  command('request-screen-permission');
  body.append(element('p', 'settings-note', 'In System Settings, the app is listed as alans-way-localapp.'));
  const rows = [['accessibility', 'Accessibility'], ['screen', 'Screen Recording']].map(([pane, label]) => {
    const row = element('div', 'setting-row'), status = element('span', '', `${label}: checking…`), open = element('button', 'secondary-button', 'Open settings');
    open.setAttribute('aria-label', `Open ${label} settings`);
    open.onclick = () => command('open-mac-privacy', { pane });
    row.append(status, open); body.append(row);
    return { pane, label, status };
  });
  const retry = element('button', 'secondary-button', 'Refresh permission status'); body.append(retry); const message = settingsStatus(body);
  const restartNote = element('p', 'settings-note', "After enabling Screen Recording, quit and reopen Alan's Workspace to apply it. You can keep using available app controls and menus before then.");
  const restart = element('button', 'secondary-button', "Quit and reopen Alan's Workspace");
  restartNote.hidden = restart.hidden = true;
  restart.onclick = () => runSettingsAction(restart, message, () => api.command('relaunch-for-permissions'), 'Reopening…');
  body.append(restartNote, restart);
  const refresh = async () => {
    const reply = await runSettingsAction(retry, message, () => api.command('mac-permissions'), 'Checking permission status…');
    for (const { pane, label, status } of rows) {
      const value = reply.ok && reply.result ? reply.result[pane] : null;
      status.textContent = `${label}: ${value === true || value === 'granted' ? 'on' : value === false || value === 'denied' ? 'off' : 'unavailable'}`;
    }
    restartNote.hidden = restart.hidden = !reply.ok || !(reply.result?.restartRequired || reply.result?.screen === 'denied');
  };
  retry.onclick = refresh; refresh();
}
const CHECK_GROUPS = [['computer', 'This computer'], ['connection', 'Connection'], ['server', 'Server']];
const CHECK_MARKS = { ok: '✓', warn: '!', fail: '✗' };
const CHECK_ACTIONS = {
  'move-to-applications': ['Move to Applications', () => command('move-to-applications')],
  'open-accessibility': ['Open settings', () => command('open-mac-privacy', { pane: 'accessibility' })],
  'open-screen': ['Open settings', () => command('open-mac-privacy', { pane: 'screen' })],
  'relaunch-for-permissions': ["Quit and reopen Alan's Workspace", () => command('relaunch-for-permissions')],
  'remove-old-connector': ['Remove old copy', async () => { if (await command('remove-old-connector')) toast('Old connector copy removed.'); }],
  'update-server': ['Update server', async () => { toast('Updating the server…'); await command('vm-update-retry', { force: true }); }],
};
function renderFindings(container, findings) {
  container.replaceChildren();
  for (const [group, label] of CHECK_GROUPS) {
    const rows = findings.filter((f) => f.group === group);
    if (!rows.length) continue;
    container.append(element('p', 'check-group', label));
    for (const f of rows) {
      const item = element('div', `check-row ${f.level}`);
      item.append(element('p', 'check-item', `${CHECK_MARKS[f.level]} ${f.title}`));
      if (f.level !== 'ok' && f.fix) item.append(element('p', 'settings-note', f.fix));
      const action = f.level !== 'ok' && CHECK_ACTIONS[f.action];
      if (action) { const fix = element('button', 'secondary-button', action[0]); fix.onclick = action[1]; item.append(fix); }
      container.append(item);
    }
  }
  const footer = element('div', 'check-footer');
  const report = element('button', 'secondary-button', 'Copy report'); report.onclick = copyReport;
  const support = element('button', 'link-button', 'Get help on Discord ↗'); support.onclick = () => command('open-support');
  footer.append(report, support); container.append(footer);
}
async function runSetupCheck(trigger, container) {
  trigger.disabled = true; trigger.textContent = 'Checking…';
  container.classList.remove('hidden');
  container.replaceChildren(element('p', 'settings-note', 'Checking this computer, the connection and the server. This can take up to two minutes.'));
  const findings = await command('setup-check');
  trigger.disabled = false; trigger.textContent = 'Check setup';
  if (Array.isArray(findings)) renderFindings(container, findings); else container.classList.add('hidden');
}
async function copyReport() {
  if (await command('copy-report')) toast('Report copied. Paste it in Discord so we can take a look.');
}
// The bot prepares public setup inputs. The user's click runs the reviewed
// script from the app's SSH process, outside the gateway lifecycle boundary.
function appendServerSetup(container, beforeRun) {
  container.append(element('p', 'settings-note', 'When your bot gives you a setup plan, paste it here. Finish setup runs it over SSH and lets setup restart your bot after its checks pass. Wait about a minute, then message your bot and run Check setup.'));
  const plan = element('textarea', 'onboarding-prompt');
  plan.rows = 4; plan.placeholder = 'Paste the JSON setup plan from your bot';
  plan.setAttribute('aria-label', 'Server setup plan');
  const result = element('pre', 'settings-note'); result.style.whiteSpace = 'pre-wrap';
  const run = element('button', 'secondary-button', 'Finish setup and restart my bot');
  run.onclick = async () => {
    run.disabled = true;
    result.textContent = 'Running setup over SSH. This can take several minutes. Keep the app open.';
    try {
      if (beforeRun && !await beforeRun()) return;
      const reply = await command('server-setup', { plan: plan.value });
      result.textContent = reply && typeof reply.ok === 'boolean'
        ? `${reply.ok ? '✓' : '✗'} ${reply.detail}${reply.note ? `\n\n${reply.note}` : ''}`
        : 'Setup did not return a report. Check the connection and retry.';
    } catch (error) { result.textContent = error.message || 'Setup could not start. Check the connection and retry.'; }
    finally { run.disabled = false; }
  };
  container.append(plan, run, result);
}
// A section owns its mounted controls and may return a refresh function. Search
// uses this public copy only; field contents, URLs and credentials never enter it.
let settingsSession = null;
const SETTINGS_CATEGORIES = [
  ['general', 'General'], ['bots', 'Bots & appearance'], ['browser', 'Browser'],
  ['recordings', 'Recordings'], ['computer', 'Computer access'],
  ['connections', 'Connections'], ['support', 'Updates & help'],
];
const SETTINGS_SECTIONS = [
  { id: 'keyboard', category: 'general', title: 'Keyboard shortcuts', description: 'Find the keys for moving between agents, browser tabs and dialogs.', words: 'keyboard navigation keys guide shortcuts search', mount(body) { const button = element('button', 'secondary-button', 'Keyboard shortcuts'); button.id = 'settings-shortcuts'; button.onclick = showShortcuts; body.append(button); } },
  { id: 'tab-behavior', category: 'general', title: 'Links and tab control', description: 'Choose how links from bot chats open and when bots can take back browser tabs.', words: 'automatic takeover auto open links control browser hand back', mount: mountTabBehavior },
  { id: 'bot-appearance', category: 'bots', title: 'Bot appearance', description: 'Choose a marble avatar or import an image for your selected bot.', words: 'avatars image customize appearance eyes', mount(body) { const button = element('button', 'secondary-button', 'Customize bot avatars'); button.onclick = () => openSettingsDetail(() => showAvatarEditor()); body.append(button, element('p', 'settings-note', 'Eyes follow your mouse only while Telegram reports activity.')); } },
  { id: 'primary-bot', category: 'bots', title: 'Primary bot', description: 'Pin one bot at the top of your sidebar. Without a preference, the overseer bot is used.', words: 'default primary pinned order sidebar', mount: mountPrimaryBot },
  { id: 'bot-visibility', category: 'bots', title: 'Bot visibility', description: 'Choose which Telegram bots appear in your sidebar. Changes save immediately.', words: 'agents show hide hidden bots visibility sidebar telegram sync', mount: mountBotVisibility },
  { id: 'extensions', category: 'browser', title: 'Browser extensions', description: 'Manage installed extensions, toolbar pins and password managers.', words: 'chrome web store add unpacked sign in passwords passkeys extension', mount(body) { const button = element('button', 'secondary-button', 'Manage browser extensions'); button.onclick = () => openSettingsDetail(showExtensions); body.append(button); } },
  { id: 'site-permissions', category: 'browser', title: 'Site permissions', description: 'Manage location, camera, microphone, notifications and clipboard access for websites. These choices apply to browser sites, separately from computer permissions.', words: 'browser permission precise approximate general area privacy allow block reset', mount: showSitePermissionSettings },
  { id: 'cookies', category: 'browser', title: 'Cookies and site data', description: 'Review cookies shared by local browser tabs. Clearing a site signs you out of it.', words: 'cookies site data storage clear delete logins privacy', mount: showCookieSettings },
  { id: 'downloads', category: 'browser', title: 'Downloads', description: 'Open your downloads folder. Download progress and file actions are available beside the browser address bar.', words: 'downloads files folder save progress pause resume cancel', mount(body) { settingsAction(body, 'Open downloads folder', 'downloads-folder'); } },
  { id: 'recordings', category: 'recordings', title: 'Task recordings', description: 'Teach a bot a task using the Record button on a browser tab you control. Share saved recordings with the bots you choose.', words: 'recordings record teach demonstration task skills share delete typed text', mount: mountTaskRecordings },
  { id: 'computer-permissions', category: 'computer', title: 'Computer permissions', description: 'Allow agents to read and operate apps on this Mac. Accessibility and Screen Recording are managed in System Settings.', words: 'accessibility screen recording privacy permissions desktop apps', available: () => state.platform === 'darwin', mount: showMacPermissions },
  { id: 'browser-connector', category: 'connections', title: 'This computer', description: 'Browser tabs and logins stay here.', words: 'browser connector local api pair connection token app data copy open details', mount: mountBrowserConnector },
  { id: 'agent-setup', category: 'connections', title: 'Agent machine', description: 'Your existing Hermes machine.', words: 'agent setup remote connection cloud setup server hermes ssh address gateway tailscale wizard connect migrate manual command update prompt copy save addresses run bot', mount: mountAgentSetup },
  { id: 'remote-desktop', category: 'connections', title: 'Remote desktop · Optional', description: 'Viewer only, separate from agent setup.', words: 'remote connection desktop preview vps vm novnc vnc tailscale watch macos linux viewer address save computer runs platform corner', mount: mountRemoteConnection },
  { id: 'updates', category: 'support', title: 'Updates', description: 'Choose Stable or Nightly and review version and update status for this app, Hermes and the agent plugin.', words: 'update status versions check refresh restart available errors hermes plugin release channel stable nightly', mount: mountSettingsUpdates },
  { id: 'diagnostics', category: 'support', title: 'Diagnostics and help', description: 'Check this computer, your connection and the server. Copy a report or get help from the team.', words: 'diagnostics support help setup check troubleshoot error report discord', mount: mountSettingsDiagnostics },
];
function settingsSearchText(value) { return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); }
function availableSettingsSections() { return SETTINGS_SECTIONS.filter(section => !section.available || section.available()); }
function refreshSettingsSections() {
  if (!settingsSession) return;
  for (const { refresh } of settingsSession.mounted.values()) refresh?.();
}
function clearSettingsSearch() { if (!$('settings-search')) return; $('settings-search').value = ''; filterSettingsSections(); $('settings-search').focus(); }
function selectSettingsCategory(category) {
  settingsSession.category = category; $('settings-search').value = ''; filterSettingsSections();
}
function filterSettingsSections() {
  const session = settingsSession; if (!session) return;
  const query = $('settings-search').value.trim();
  const words = settingsSearchText(query).split(' ').filter(word => word && !['a', 'an', 'the', 'my', 'i', 'can', 'how', 'do', 'where', 'to', 'and'].includes(word));
  const matches = availableSettingsSections().filter(section => query
    ? words.every(word => settingsSearchText(`${section.title} ${section.description} ${section.words || ''} ${SETTINGS_CATEGORIES.find(([id]) => id === section.category)[1]}`).includes(word))
    : section.category === session.category);
  for (const button of $('settings-navigation').children) {
    const selected = !query && button.dataset.category === session.category;
    button.setAttribute('aria-selected', String(selected)); button.tabIndex = button.dataset.category === session.category ? 0 : -1;
  }
  const content = $('settings-content'); content.setAttribute('role', query ? 'region' : 'tabpanel');
  if (query) { content.removeAttribute('aria-labelledby'); content.setAttribute('aria-label', 'Settings search results'); }
  else { content.setAttribute('aria-labelledby', `settings-category-${session.category}`); content.removeAttribute('aria-label'); }
  $('settings-content-title').textContent = query ? 'Search results' : SETTINGS_CATEGORIES.find(([id]) => id === session.category)[1];
  $('settings-search-status').textContent = query ? `${matches.length} section${matches.length === 1 ? '' : 's'} found` : 'Search all settings';
  $('settings-clear').hidden = !query;
  for (const { node } of session.mounted.values()) node.hidden = true;
  for (const section of matches) {
    let mounted = session.mounted.get(section.id);
    if (!mounted) {
      const node = element('section', 'settings-section'); node.dataset.settingsSection = section.id;
      const scope = element('p', 'settings-section-category', SETTINGS_CATEGORIES.find(([id]) => id === section.category)[1]);
      const heading = element('h3', '', section.title); heading.id = `settings-section-${section.id}`; node.setAttribute('aria-labelledby', heading.id);
      node.append(scope, heading, element('p', 'settings-section-description', section.description));
      const body = element('div', 'settings-section-body'); node.append(body); content.append(node);
      mounted = { node, scope, refresh: section.mount(body) }; session.mounted.set(section.id, mounted);
    }
    mounted.node.hidden = false; mounted.scope.hidden = !query; content.append(mounted.node);
  }
  $('settings-empty').hidden = matches.length > 0;
  $('settings-empty-query').textContent = query ? `No settings match “${query}”.` : 'No settings are available in this category.';
  content.scrollTop = 0; refreshSettingsSections();
}
function showSettings() {
  if (settingsSession && modalOpen) { $('settings-search').focus(); return; }
  openModal('Workspace settings'); $('modal').classList.add('settings-modal');
  const categories = SETTINGS_CATEGORIES.filter(([category]) => availableSettingsSections().some(section => section.category === category));
  settingsSession = { category: categories[0][0], mounted: new Map() };
  const body = $('modal-body'), searchRow = element('div', 'settings-search-row'), wrap = element('div', 'settings-search-wrap');
  const icon = element('span', '', '⌕'); icon.setAttribute('aria-hidden', 'true');
  const search = element('input'); search.id = 'settings-search'; search.type = 'search'; search.placeholder = 'Search settings…'; search.autocomplete = 'off'; search.spellcheck = false;
  search.setAttribute('aria-label', 'Search settings'); search.setAttribute('aria-controls', 'settings-content'); search.setAttribute('aria-describedby', 'settings-search-status'); search.oninput = filterSettingsSections;
  const clear = element('button', 'icon-button', '×'); clear.id = 'settings-clear'; clear.setAttribute('aria-label', 'Clear settings search'); clear.onclick = clearSettingsSearch; clear.hidden = true;
  wrap.append(icon, search, clear); const status = element('p', 'settings-search-status'); status.id = 'settings-search-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  searchRow.append(wrap, status);
  const layout = element('div', 'settings-layout'), navigation = element('nav', 'settings-navigation'); navigation.id = 'settings-navigation';
  navigation.setAttribute('role', 'tablist'); navigation.setAttribute('aria-label', 'Settings categories'); navigation.setAttribute('aria-orientation', 'vertical');
  for (const [id, label] of categories) {
    const button = element('button', 'settings-category', label); button.id = `settings-category-${id}`; button.dataset.category = id;
    button.setAttribute('role', 'tab'); button.setAttribute('aria-controls', 'settings-content'); button.onclick = () => selectSettingsCategory(id);
    button.onkeydown = event => { const target = moveNavigationFocus(event, [...navigation.children], 'vertical'); if (target) selectSettingsCategory(target.dataset.category); };
    navigation.append(button);
  }
  const content = element('div', 'settings-content'); content.id = 'settings-content'; content.tabIndex = 0;
  const title = element('h2', 'settings-content-title'); title.id = 'settings-content-title';
  const empty = element('div', 'settings-empty'); empty.id = 'settings-empty'; empty.hidden = true;
  const emptyQuery = element('h3'); emptyQuery.id = 'settings-empty-query';
  const reset = element('button', 'secondary-button', 'Clear search'); reset.id = 'settings-reset'; reset.onclick = clearSettingsSearch;
  empty.append(emptyQuery, element('p', '', 'Try “cookies”, “remote connection” or “Accessibility”.'), reset);
  content.append(title, empty); layout.append(navigation, content); body.append(searchRow, layout);
  content.addEventListener('focusin', event => {
    if (event.target === content) return;
    // Keep the entire outline inside this sole scroller, in either direction.
    const box = event.target.getBoundingClientRect(), pane = content.getBoundingClientRect(), margin = 8;
    if (box.top < pane.top + margin) content.scrollTop -= pane.top + margin - box.top;
    else if (box.bottom > pane.bottom - margin) content.scrollTop += box.bottom - pane.bottom + margin;
  });
  filterSettingsSections(); search.focus({ preventScroll: true });
}
function settingsStatus(body) {
  const status = element('p', 'settings-action-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); body.append(status); return status;
}
const pendingSettingsActions = new WeakSet();
async function runSettingsAction(button, status, task, busy = 'Saving…', success = '') {
  if (pendingSettingsActions.has(status)) return { ok: false, busy: true };
  const session = settingsSession;
  const current = () => settingsSession === session && button.isConnected && status.isConnected;
  const initiatedHere = document.activeElement === button;
  // Native disabled controls blur and disappear from the Tab order. Keep the
  // action reachable while guarding both activation and native value changes.
  const block = event => {
    if (event.type === 'keydown' && (event.key === 'Tab' || event.key === 'Escape' || event.ctrlKey || event.metaKey || (button.tagName !== 'SELECT' && !['Enter', ' '].includes(event.key)))) return;
    event.preventDefault(); event.stopImmediatePropagation();
  };
  const events = ['click', 'pointerdown', 'keydown'];
  pendingSettingsActions.add(status);
  for (const type of events) button.addEventListener(type, block, true);
  button.setAttribute('aria-disabled', 'true'); button.setAttribute('aria-busy', 'true');
  status.textContent = busy; status.classList.remove('error');
  if (initiatedHere) revealSettingsFeedback(button, status);
  try {
    const result = await task();
    if (result === false) throw new Error('The action did not finish. Try again.');
    if (result?.bots && result?.api) render(result);
    if (!current()) return { ok: false, stale: true };
    status.textContent = success; return { ok: true, result };
  } catch (error) {
    if (!current()) return { ok: false, stale: true };
    status.classList.add('error'); status.textContent = String(error?.message || error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
    return { ok: false };
  } finally {
    pendingSettingsActions.delete(status);
    for (const type of events) button.removeEventListener(type, block, true);
    button.removeAttribute('aria-disabled'); button.removeAttribute('aria-busy');
    if (current() && document.activeElement === button) revealSettingsFeedback(button, status);
    if (current() && button.closest('#settings-bots')) renderSettingsBots();
  }
}
function revealSettingsFeedback(button, status) {
  const pane = $('settings-content');
  if (!pane?.contains(button) || !status.isConnected || button.closest('[hidden]')) return;
  const a = button.getBoundingClientRect(), b = status.getBoundingClientRect(), p = pane.getBoundingClientRect();
  const top = Math.min(a.top, b.height ? b.top : a.top), bottom = Math.max(a.bottom, b.bottom);
  if (bottom - top > p.height - 16) return;
  if (bottom > p.bottom - 8) pane.scrollTop += bottom - p.bottom + 8;
  else if (top < p.top + 8) pane.scrollTop -= p.top + 8 - top;
}
function settingsAction(body, label, name, value = {}, options = {}) {
  const button = element('button', options.primary ? 'primary-button' : 'secondary-button', label);
  body.append(button); const status = settingsStatus(body);
  button.onclick = async () => {
    const reply = await runSettingsAction(button, status, () => api.command(name, typeof value === 'function' ? value() : value), options.busy || 'Working…', options.success || '');
    if (reply.ok) options.done?.(reply.result);
  };
  return button;
}
function settingsField(body, id, labelText, value, placeholder) {
  const field = element('div', 'field'), label = element('label', '', labelText), input = element('input');
  label.htmlFor = id; input.id = id; input.value = value || ''; input.placeholder = placeholder || ''; input.autocomplete = 'off'; input.spellcheck = false;
  input.oninput = () => { input.dataset.dirty = 'true'; };
  field.append(label, input); body.append(field); return input;
}
// Drafts live only in this renderer session and belong to a bot + saved target.
// A submitted save may move that target; unrelated host changes get a new draft.
const settingsDrafts = new Map();
const settingsSwitchWrites = new Map();
function pruneSettingsDrafts() {
  for (const [key, draft] of settingsDrafts) {
    for (const button of draft.mounts || []) if (!button.isConnected || !settingsSession) draft.mounts.delete(button);
    if (!draft.pending && !draft.dirty.some(Boolean) && !draft.mounts?.size) settingsDrafts.delete(key);
  }
}
let settingsWriteSequence = 0;
const SETTINGS_SAVE_WAIT_MS = 5000;
function settingsWriteContext() {
  return { bot: state.selectedBotId || '', host: state.hostLabel, platform: state.remotePlatform || 'linux', mac: state.macSshHost || '', vps: state.vpsBrowser?.sshHost || '', broker: state.vpsBrowser?.brokerSshHost || '' };
}
function settingsWriteFeedback(owner, busy) {
  if (!owner.pending) return owner.notice || '';
  if (owner.pending.checking) return 'Checking saved state… Your later edits are kept.';
  return owner.pending.stalled ? `${owner.pending.issue || 'This save is taking longer than expected.'} Your later edits are kept. Check saved state before saving again.`
    : `${busy} You can close Settings; this save stays pending.`;
}
function refreshSettingsWriteFeedback(button, status) {
  refreshSettingsSections();
  pruneSettingsDrafts();
  if (document.activeElement === button) revealSettingsFeedback(button, status);
}
function startSettingsWrite(owner, slot, payload, settled, button, status) {
  if (owner.pending) return;
  const context = ['addresses', 'viewer'].includes(slot) ? settingsWriteContext() : null;
  const base = { ...state.settingsFieldRevisions };
  const op = { token: { client: performance.timeOrigin, sequence: ++settingsWriteSequence, slot }, stalled: false, checking: false };
  owner.pending = op; owner.notice = ''; owner.error = false;
  const receive = result => {
    if (owner.pending !== op) return;
    const receipt = result?.settingsWrite;
    if (!receipt || receipt.status === 'unknown') {
      op.stalled = true; op.issue = receipt?.detail || 'The save reply could not be confirmed.'; return;
    }
    clearTimeout(op.timer); owner.pending = null;
    settled(receipt, result.state);
    if (result.state?.bots && result.state?.api) render(result.state);
  };
  op.receive = receive;
  op.timer = setTimeout(() => { if (owner.pending === op) { op.stalled = true; refreshSettingsWriteFeedback(button, status); } }, SETTINGS_SAVE_WAIT_MS);
  refreshSettingsWriteFeedback(button, status);
  // No timeout replays the write. A late response can settle only its own owner.
  Promise.resolve().then(() => api.command('settings', { ...payload, _settingsWrite: op.token, _settingsBase: base,
    ...(context ? { _settingsContext: context } : {}) }))
    .then(receive, () => { if (owner.pending === op) { op.stalled = true; op.issue = 'The save reply could not be confirmed.'; } })
    .finally(() => refreshSettingsWriteFeedback(button, status));
}
function settingsWriteRecovery(body, id, owner, button, status) {
  const check = element('button', 'secondary-button', 'Check saved state'); check.id = id; check.hidden = true; body.append(check);
  check.onclick = () => {
    const currentOwner = owner(), op = currentOwner.pending;
    if (!op?.stalled || op.checking) return;
    op.checking = true;
    const attempt = op.checkAttempt = (op.checkAttempt || 0) + 1;
    const current = () => currentOwner.pending === op && op.checkAttempt === attempt;
    const timer = setTimeout(() => { if (current()) { op.checking = false; refreshSettingsWriteFeedback(check, status); } }, SETTINGS_SAVE_WAIT_MS);
    refreshSettingsWriteFeedback(check, status);
    Promise.resolve().then(() => api.command('settings-write-status', op.token)).then(result => {
      if (current()) op.receive(result);
    }, () => { if (current()) op.issue = 'Saved state could not be checked.'; }).finally(() => {
      clearTimeout(timer);
      if (current()) op.checking = false;
      refreshSettingsWriteFeedback(check, status);
    });
  };
  return () => {
    const pending = owner().pending;
    const focused = document.activeElement === check;
    check.hidden = !pending?.stalled;
    check.setAttribute('aria-disabled', String(!!pending?.checking));
    if (pending?.checking) check.setAttribute('aria-busy', 'true'); else check.removeAttribute('aria-busy');
    if (focused && check.hidden && button.isConnected && !button.closest('[hidden]')) { button.focus({ preventScroll: true }); revealSettingsFeedback(button, status); }
  };
}
function settingsSaveFields(body, label, fields, value, options = {}) {
  const keyFor = values => JSON.stringify([options.draftScope(), state.remotePlatform || 'linux', ...values]);
  const move = (draft, key) => {
    const existing = settingsDrafts.get(key);
    // An already retained draft at this target owns its own later edits.
    if (existing && existing !== draft && (existing.pending || existing.dirty.some(Boolean))) return;
    for (const [old, item] of settingsDrafts) if (item === draft) settingsDrafts.delete(old);
    settingsDrafts.set(key, draft);
  };
  let draft;
  const button = element('button', options.primary ? 'primary-button' : 'secondary-button', label);
  body.append(button); const status = settingsStatus(body);
  const discard = element('button', 'secondary-button', 'Discard unsaved changes'); body.append(discard);
  discard.id = fields[0].id === 'remote-url' ? 'settings-discard-viewer' : 'settings-discard-addresses';
  const recovery = settingsWriteRecovery(body, fields[0].id + '-check-save', () => draft, button, status);
  body.append(element('p', 'settings-note', 'Unsaved changes stay in this app session when Settings closes. Save or discard them here before quitting the app.'));
  const refresh = () => {
    const saved = options.saved(), key = keyFor(saved), previous = draft;
    draft = settingsDrafts.get(key);
    if (!draft) {
      // Main can broadcast a completed write before its held IPC reply arrives.
      // Only that exact submitted target can carry the draft into the new scope.
      draft = [...settingsDrafts.values()].find(item => item.pending?.key === key);
      if (draft) move(draft, key);
      else { draft = { values: saved, revisions: fields.map(() => 0), dirty: fields.map(() => false), notice: '' }; settingsDrafts.set(key, draft); }
    }
    if (previous !== draft) previous?.mounts?.delete(button);
    (draft.mounts ||= new Set()).add(button);
    pruneSettingsDrafts();
    fields.forEach((field, index) => {
      const next = draft.dirty[index] ? draft.values[index] : saved[index];
      if (field.value !== next) field.value = next;
      if (draft.dirty[index]) field.dataset.dirty = 'true'; else delete field.dataset.dirty;
    });
    const dirty = draft.dirty.some(Boolean);
    button.setAttribute('aria-disabled', String(!!draft.pending));
    if (draft.pending) button.setAttribute('aria-busy', 'true'); else button.removeAttribute('aria-busy');
    discard.setAttribute('aria-disabled', String(!!draft.pending || !dirty));
    status.classList.toggle('error', !!draft.error);
    status.textContent = settingsWriteFeedback(draft, options.busy || 'Saving…') || (dirty ? 'Unsaved changes · Kept in this app session.' : '');
    recovery();
  };
  fields.forEach((field, index) => field.addEventListener('input', () => {
    draft.values[index] = field.value; draft.revisions[index]++; draft.dirty[index] = true;
    draft.notice = ''; draft.error = false; refresh();
  }));
  discard.onclick = () => {
    refresh(); if (draft.pending || !draft.dirty.some(Boolean)) return;
    draft.values = options.saved(); draft.dirty.fill(false);
    draft.revisions = draft.revisions.map(revision => revision + 1);
    draft.notice = 'Unsaved changes discarded. Saved addresses are unchanged.'; draft.error = false;
    refresh(); fields[0].dispatchEvent(new Event('change'));
  };
  button.onclick = () => {
    refresh(); if (draft.pending) return;
    const submittedDraft = draft, revisions = [...draft.revisions], payload = value();
    const values = fields.map(field => field.value.trim());
    const targetKey = keyFor(values);
    startSettingsWrite(submittedDraft, fields[0].id === 'remote-url' ? 'viewer' : 'addresses', payload, (receipt, result) => {
      if (receipt.status === 'saved') {
        if (!Number.isSafeInteger(result?.uiStateRevision) || result.uiStateRevision >= latestUiStateRevision
          // Unrelated state updates can precede this reply. A matching saved
          // target still confirms this write without accepting an older UI state.
          || JSON.stringify(options.saved()) === JSON.stringify(values)) {
          move(submittedDraft, targetKey);
          // A save owns only each field revision it submitted. Even another
          // input event with the same value remains an unsaved, newer edit.
          fields.forEach((_field, index) => { if (revisions[index] === submittedDraft.revisions[index]) submittedDraft.dirty[index] = false; });
          submittedDraft.notice = (options.success || 'Saved values confirmed.') + (submittedDraft.dirty.some(Boolean) ? ' Newer edits are not saved.' : '');
        } else submittedDraft.notice = 'Earlier save reply received. Review the current saved addresses before saving again.';
      } else {
        submittedDraft.error = true;
        submittedDraft.notice = receipt.status === 'failed' ? 'Settings could not be saved. Your draft is kept; review it and choose Save again.' : receipt.status === 'not-applied' ? 'Saved state checked. That save was not applied. Your draft is kept; save again when ready.'
          : 'Saved state checked. The submitted values are not the current saved addresses. Your draft is kept; review and save again.';
        if (receipt.detail) submittedDraft.notice += ' ' + receipt.detail;
      }
    }, button, status);
    // Main may announce persistence before returning the reply. Only the exact
    // submitted context/target may carry this draft across that announcement.
    submittedDraft.pending.key = targetKey; submittedDraft.pending.values = values;
    refresh();
  };
  button.refreshDraft = refresh; refresh(); return button;
}
function settingsToggle(body, id, label, key) {
  const row = element('div', 'setting-row'), copy = element('span', '', label), button = element('button', 'secondary-button'); button.id = id;
  button.setAttribute('role', 'switch'); button.setAttribute('aria-label', label); row.append(copy, button); body.append(row);
  if (!settingsSwitchWrites.has(key)) settingsSwitchWrites.set(key, { notice: '' });
  const owner = settingsSwitchWrites.get(key), status = settingsStatus(body);
  const recovery = settingsWriteRecovery(body, id + '-check-save', () => owner, button, status);
  const refresh = () => {
    button.textContent = state[key] ? 'On' : 'Off'; button.setAttribute('aria-checked', String(!!state[key]));
    button.setAttribute('aria-disabled', String(!!owner.pending));
    if (owner.pending) button.setAttribute('aria-busy', 'true'); else button.removeAttribute('aria-busy');
    status.textContent = settingsWriteFeedback(owner, 'Saving…'); status.classList.toggle('error', !!owner.error); recovery();
  };
  button.onclick = () => {
    if (owner.pending) return;
    const desired = !state[key];
    startSettingsWrite(owner, key, { [key]: desired }, (receipt, result) => {
      owner.error = receipt.status !== 'saved';
      const older = result?.uiStateRevision < latestUiStateRevision && desired !== state[key];
      owner.notice = receipt.status === 'failed' ? 'Settings could not be saved. The saved value is still shown. Choose the switch again to save your change.' : receipt.status === 'saved' ? older ? 'Earlier save confirmed. The current saved value is shown.' : 'Saved.' : receipt.status === 'not-applied'
        ? 'Saved state checked. That change was not applied. Choose the switch again to save it.'
        : 'Saved state checked. The current value is shown. Choose the switch again to change it.';
      if (receipt.detail) owner.notice += ' ' + receipt.detail;
    }, button, status);
  };
  refresh(); return refresh;
}
function openSettingsDetail(open) {
  const category = settingsSession?.category;
  open();
  if (!category || !modalOpen || settingsSession) return;
  const back = element('button', 'settings-detail-back', '← Back to settings');
  back.onclick = () => { showSettings(); selectSettingsCategory(category); $('settings-category-' + category).focus(); };
  $('modal-body').prepend(back);
}
function mountTabBehavior(body) {
  const links = settingsToggle(body, 'settings-auto-links', 'Open links sent in bot chats as tabs', 'autoOpenLinks');
  const takeover = settingsToggle(body, 'settings-auto-takeover', 'Let bots take over tabs automatically', 'autoTakeover');
  const signIns = settingsToggle(body, 'settings-carry-sign-ins', 'Carry sign-ins when a task moves to the VM', 'carrySignIns');
  const detail = element('details', 'settings-details'); detail.append(element('summary', '', 'How tab control works'));
  detail.append(element('p', 'settings-note', 'Links open local tabs assigned to the bot, so both of you can see them. If this computer is unreachable, the bot opens its own copy on the remote desktop.'));
  detail.append(element('p', 'settings-note', 'Automatic takeover lets a bot take back a tab after you pause for 3 seconds. Take back keeps bots off it for a minute. A tab handed to you, or one you are recording, stays yours. With automatic takeover off, taking control blocks new agent actions on that tab. Remote desktop control uses the existing shared desktop and does not pause your bots.'));
  detail.append(element('p', 'settings-note', 'When this computer sleeps, or you press Move, a bot’s page continues on the VM. With sign-ins carried, the page’s own cookies go too (including session cookies), so the VM stays signed in. Passwords, site storage (localStorage, IndexedDB), partitioned cookies and the page’s memory never move. Cookies only travel over SSH to a VM on your Tailscale network; any other address gets the page without sign-ins.'));
  body.append(detail); return () => { links(); takeover(); signIns(); };
}
function mountPrimaryBot(body) {
  const field = element('div', 'field'), label = element('label', '', 'Primary bot'), select = element('select'); select.id = 'primary-bot'; label.htmlFor = select.id; field.append(label, select); body.append(field);
  const status = settingsStatus(body); let signature;
  const refresh = () => {
    const next = JSON.stringify(state.bots.map(bot => [bot.id, bot.name, bot.username]));
    if (signature !== next) {
      signature = next; select.replaceChildren(); const none = element('option', '', 'None (use the overseer bot)'); none.value = ''; select.append(none);
      for (const bot of state.bots) { const option = element('option', '', `${bot.name}${bot.username ? ` @${bot.username}` : ''}`); option.value = bot.id; select.append(option); }
    }
    select.value = state.primaryBotPref || '';
  };
  select.onchange = async () => { await runSettingsAction(select, status, () => api.command('settings', { primaryBotId: select.value }), 'Saving…', 'Primary bot saved.'); refresh(); };
  refresh(); return refresh;
}
function mountBotVisibility(body) {
  body.append(element('p', 'settings-note', 'Hiding a bot changes only this app. Its Telegram chat, messages and Hermes agent stay available. Drag visible bots in the sidebar to sort them.'));
  const list = element('div', 'settings-bots'); list.id = 'settings-bots'; body.append(list); renderSettingsBots();
  const sync = settingsAction(body, 'Sync Telegram bots', 'sync-telegram', {}, { busy: 'Reading Telegram’s bot chat list…', success: 'Bot list refreshed.' }); sync.id = 'settings-sync-bots';
  body.append(element('p', 'settings-note', 'Newly opened bot chats appear after Telegram saves them. Your Telegram session and browser logins stay on this computer.'));
}
function mountTaskRecordings(body) {
  const detail = element('details', 'settings-details'); detail.append(element('summary', '', 'What a recording saves'));
  detail.append(element('p', 'settings-note', 'Recordings contain clicks, typed fields and pages, never video. Passwords, card numbers, one-time codes and hidden fields are never saved. Other typed text is kept only if you choose Keep typed text. Each bot sees only recordings shared with it and can turn one into a skill. Up to 20 recordings.')); body.append(detail);
  const list = element('div'); list.id = 'recordings-list'; body.append(list); renderRecordings();
}
function settingsConnectionDetails(body, id, label, search) {
  body.closest('.settings-section').classList.add('settings-connection-section');
  const details = element('details', 'settings-details connection-details'); details.id = id;
  details.append(element('summary', '', label));
  const content = element('div'); details.append(content); body.append(details);
  return { content, details, reveal() { if (search.test($('settings-search')?.value || '')) details.open = true; } };
}
function mountRemoteConnection(body) {
  const connection = element('p', 'connection-state'); body.append(connection);
  const advanced = settingsConnectionDetails(body, 'settings-remote-details', 'Viewer address and preview', /remote connection|viewer|novnc|vnc|preview|remote desktop|remote computer|platform|linux|macos/i);
  const input = settingsField(advanced.content, 'remote-url', 'Viewer address', state.savedRemoteUrl ?? state.remoteUrl, 'https://your-server/vnc.html or wss://…');
  advanced.content.append(element('p', 'settings-note', 'Existing installs keep their legacy transport until tailnet enforcement is enabled by the administrator. Provision pinned tailnet addresses and SSH keys first; enforcement pauses incompatible saved addresses without deleting them. Saving an address does not verify a connection; preview starts in watch mode.'));
  const save = settingsSaveFields(advanced.content, 'Save connection', [input], () => ({ remoteUrl: input.value.trim() }), { primary: true, busy: 'Saving connection…', success: 'Viewer address saved. Connection status is shown above.', draftScope: () => ['viewer', state.selectedBotId || '', state.hostLabel, state.vpsBrowser?.sshHost || '', state.vpsBrowser?.brokerSshHost || '', state.macSshHost || ''], saved: () => [state.savedRemoteUrl ?? state.remoteUrl ?? ''] });
  const row = element('div', 'setting-row'), label = element('span', '', 'Remote computer runs'), os = element('select'); os.id = 'settings-remote-platform'; os.setAttribute('aria-label', 'Remote computer runs');
  for (const [value, name] of [['linux', 'Linux'], ['mac', 'macOS']]) { const option = element('option', '', name); option.value = value; os.append(option); }
  row.append(label, os); advanced.content.append(row); const status = settingsStatus(advanced.content);
  os.onchange = async () => { await runSettingsAction(os, status, () => api.command('settings', { remotePlatform: os.value }), 'Saving…', 'Saved.'); os.value = state.remotePlatform || 'linux'; };
  const preview = settingsToggle(advanced.content, 'settings-preview', 'Remote desktop preview in the corner', 'preview');
  return () => {
    advanced.reveal(); save.refreshDraft(); os.value = state.remotePlatform || 'linux'; preview();
    connection.textContent = (state.savedRemoteUrl ?? state.remoteUrl) ? `Viewer address saved · ${state.remoteStatus || 'not connected'}.` : 'No viewer address saved.';
  };
}
function mountBrowserConnector(body) {
  const status = element('p', 'connection-state'); body.append(status);
  const advanced = settingsConnectionDetails(body, 'settings-connector-details', 'Connector details', /connector|api|token|app data|pair|copy connection/i);
  advanced.content.append(element('p', 'settings-note', 'Local availability does not confirm remote Hermes access. Share the private connection only with your own agent connector.'));
  settingsAction(advanced.content, 'Copy connection', 'copy-connection', {}, { success: 'Local URL and private token copied. Paste into your own agent connector’s connection configuration.' });
  settingsAction(advanced.content, 'Open app data', 'show-data');
  return () => { advanced.reveal(); status.textContent = state.api.ready ? 'Local browser connector available · Agent access not checked.' : state.api.error || 'Local browser connector is starting…'; };
}
function mountAgentSetup(body) {
  const review = element('div', 'setting-row connection-bot'), label = element('label', '', 'Bot to set up'), botSelect = element('select');
  botSelect.id = 'settings-setup-bot'; label.htmlFor = botSelect.id; review.append(label, botSelect); body.append(review);
  let reviewedBotId = state.selectedBotId || state.bots[0]?.id || '', selectedSource = state.selectedBotId, botSignature, scope, epoch = 0, checked = false;
  const bot = () => state.bots.find(item => item.id === reviewedBotId);
  const botName = () => bot()?.username ? `@${bot().username}` : bot()?.name || 'your bot';
  const summary = element('p', 'connection-state'); summary.id = 'settings-agent-summary'; body.append(summary);
  const actions = element('div', 'connection-actions'); body.append(actions);
  const prompt = element('button', 'primary-button', 'Copy setup prompt'); prompt.id = 'settings-copy-setup-prompt'; actions.append(prompt);
  const promptStatus = settingsStatus(actions);
  const destination = element('p', 'settings-note connection-destination'), destinationText = element('span'); body.append(destination);
  const continuation = element('button', 'link-button', 'Enter addresses from the agent’s reply'); continuation.id = 'settings-enter-addresses'; destination.append(destinationText, ' ', continuation);
  continuation.onclick = () => { advanced.details.open = true; local.focus(); };
  const advanced = settingsConnectionDetails(body, 'settings-agent-details', 'Addresses and manual setup', /ssh|address|manual|command|update|wizard|cloud|gateway|tailscale/i);
  advanced.content.append(element('p', 'settings-note', 'Follow the agent’s restart instructions. Its final report should include installed revisions, checks, warnings and unfinished steps. Enter its verified server and computer SSH addresses, Save addresses, then Check saved path (SSH only). Follow its browser task to verify setup.'));
  const vps = settingsField(advanced.content, 'vps-ssh-host', 'Agent machine SSH address', state.vpsBrowser?.sshHost, 'you@your-agent-machine');
  const broker = settingsField(advanced.content, 'vps-broker-ssh-host', 'Browser broker SSH address (after separate OS user is provisioned)', state.vpsBrowser?.brokerSshHost, 'broker@tailnet-address');
  advanced.content.append(element('p', 'settings-note', 'An empty broker address keeps the existing legacy shared login; it does not isolate bots. Provision a separate broker account before selecting it. A selected broker never falls back to the agent login.'));
  const local = settingsField(advanced.content, 'mac-ssh-host', 'This computer’s SSH address', state.macSshHost, 'you@your-computer');
  advanced.content.append(element('p', 'settings-note', 'Use this computer’s address as reached from the trusted broker. Agent accounts must not have shell access to the human account. These addresses are shared by your bots; setup instructions are specific to the bot selected above.'));
  const save = settingsSaveFields(advanced.content, 'Save addresses', [local, vps, broker], () => ({ macSshHost: local.value.trim(), vpsBrowser: { ...state.vpsBrowser, sshHost: vps.value.trim(), brokerSshHost: broker.value.trim() } }), { success: 'Addresses saved. Check the saved path next.', draftScope: () => ['agent', reviewedBotId, state.hostLabel], saved: () => [state.macSshHost || '', state.vpsBrowser?.sshHost || '', state.vpsBrowser?.brokerSshHost || ''] }); save.id = 'settings-save-addresses';
  appendServerSetup(advanced.content, () => {
    if (local.value.trim() !== (state.macSshHost || '') || vps.value.trim() !== (state.vpsBrowser?.sshHost || ''))
      throw Error('Save address changes before running setup.');
    return true;
  });
  const test = element('button', 'primary-button', 'Check saved path'); test.id = 'settings-test-path'; actions.prepend(test); const result = settingsStatus(actions); result.classList.add('connection-check-status');
  const invalidate = () => {
    epoch++; checked = false;
    if (result.textContent) { result.classList.remove('error'); result.textContent = 'Addresses or bot changed. Check the saved path again.'; }
  };
  for (const input of [local, vps, broker]) for (const event of ['input', 'change']) input.addEventListener(event, () => { invalidate(); refresh(); });
  const copy = async (button, status, name, kind) => {
    const id = reviewedBotId, target = botName(), started = epoch;
    const reply = await runSettingsAction(button, status, () => {
      if (!bot()) throw Error('Choose a bot to prepare its setup instructions.');
      if (local.value.trim() !== (state.macSshHost || '') || vps.value.trim() !== (state.vpsBrowser?.sshHost || '')) throw Error('Save address changes before copying instructions.');
      return api.command(name, { botId: id, ...(kind ? { kind } : {}) });
    }, 'Preparing instructions…');
    if (reply.ok) status.textContent = started !== epoch || id !== reviewedBotId
      ? `Instructions copied for ${target}. Bot or addresses changed; copy again for the current selection.`
      : name === 'agent-setup' ? `Review notes copied for ${target}. Read them before guided setup; use Copy setup prompt in that bot’s Hermes chat to begin.`
        : `${kind === 'update' ? 'Update' : 'Setup'} prompt copied for ${target}. Paste in that bot’s Hermes chat.`;
    if (reply.ok && name === 'agent-setup') revealSettingsFeedback(button, status);
  };
  prompt.onclick = () => copy(prompt, promptStatus, 'agent-prompt');
  const manual = element('div'); advanced.content.append(manual);
  manual.append(element('p', 'settings-note', 'Review setup before running commands. These notes list this bot, saved addresses, required revision pins and human handoffs. Begin with Copy setup prompt above; the installed plugin skill supplies the procedure. Copying runs no setup or restart.'));
  const setup = element('button', 'secondary-button', 'Copy setup review notes'); setup.id = 'settings-copy-setup-notes'; manual.append(setup); const setupStatus = settingsStatus(manual); setup.onclick = () => copy(setup, setupStatus, 'agent-setup');
  const update = element('button', 'secondary-button', 'Copy agent update prompt'); manual.append(update); const updateStatus = settingsStatus(manual); update.onclick = () => copy(update, updateStatus, 'agent-prompt', 'update');
  settingsAction(advanced.content, 'Run setup wizard', 'onboarding-open', {}, { done: closeModal });
  const cloud = element('p', 'settings-note'), error = element('p', 'settings-note error'); advanced.content.append(cloud, error);
  test.onclick = async () => {
    if (local.value.trim() !== (state.macSshHost || '') || vps.value.trim() !== (state.vpsBrowser?.sshHost || '')) {
      result.classList.add('error'); result.textContent = 'Save address changes before checking this path.'; advanced.details.open = true; save.focus(); return;
    }
    const started = epoch;
    checked = false; refresh();
    const reply = await runSettingsAction(test, result, () => api.command('test-agent-path'), 'Checking the saved broker SSH path to this computer…');
    if (reply.stale || !result.isConnected) return;
    if (started !== epoch) { result.classList.remove('error'); result.textContent = 'Addresses or bot changed. Check the saved path again.'; return; }
    if (reply.ok) {
      checked = reply.result?.ok === true;
      result.textContent = checked ? 'Saved SSH path passed. Hermes authentication and bot setup were not checked.' : reply.result?.detail || 'The path check returned no result. Try again.';
      result.classList.toggle('error', !checked); refresh();
    }
  };
  botSelect.onchange = () => { reviewedBotId = botSelect.value; invalidate(); refresh(); };
  const refresh = () => {
    advanced.reveal();
    if (selectedSource !== state.selectedBotId) { selectedSource = state.selectedBotId; reviewedBotId = selectedSource || ''; }
    const signature = JSON.stringify(state.bots.map(item => [item.id, item.name, item.username]));
    if (signature !== botSignature) {
      botSignature = signature; botSelect.replaceChildren();
      if (!state.bots.length) { const option = element('option', '', 'Open a Telegram bot first'); option.value = ''; botSelect.append(option); }
      for (const item of state.bots) { const option = element('option', '', item.username ? `${item.name} · @${item.username}` : item.name); option.value = item.id; botSelect.append(option); }
    }
    if (!bot()) reviewedBotId = state.bots[0]?.id || ''; botSelect.value = reviewedBotId; botSelect.disabled = !state.bots.length;
    const next = JSON.stringify([reviewedBotId, bot()?.name, bot()?.username, state.vpsBrowser?.sshHost || '', state.vpsBrowser?.brokerSshHost || '', state.macSshHost || '']);
    if (scope && scope !== next) invalidate(); scope = next;
    save.refreshDraft();
    const addresses = !!state.vpsBrowser?.sshHost && !!state.macSshHost;
    test.hidden = !addresses; prompt.disabled = setup.disabled = !bot();
    test.className = 'primary-button'; prompt.className = addresses ? 'secondary-button' : 'primary-button';
    summary.textContent = checked ? 'SSH path checked · Hermes setup unverified.' : addresses ? 'Addresses saved · Path not checked.' : state.vpsBrowser?.sshHost ? 'Agent address saved · Add this computer’s address to check the path.' : 'No agent address saved · Start with your bot.';
    if (state.vpsBrowser?.sshHost) summary.append(element('span', 'connection-target', `${state.vpsBrowser.sshHost}${state.macSshHost ? ` → ${state.macSshHost}` : ''}`));
    destinationText.textContent = !bot() ? 'Open a bot in Telegram, then return here to prepare its instructions.'
      : `Paste in ${botName()}’s Hermes chat: follow openalan.com/agent-prompt to set up the Alan’s Way Plugin, preserving Hermes. Expect approval steps and a report: checks, warnings and unfinished work.`;
    continuation.hidden = !bot();
    error.textContent = state.vpsBrowserError || '';
    cloud.textContent = state.cloud?.error || (state.cloud?.step === 'done' ? 'Cloud wizard completed. Use the path check to check the saved SSH route.' : state.cloud?.step ? 'Cloud setup is in progress. Continue in the setup wizard.' : 'The setup wizard also supports cloud setup and your own server.');
  };
  return refresh;
}
function mountSettingsUpdates(body) {
  const channel = element('select', 'settings-select'); channel.id = 'settings-release-channel'; channel.setAttribute('aria-label', 'Release channel');
  for (const [value, label] of [['stable', 'Stable (default)'], ['nightly', 'Nightly (less tested)']]) { const option = element('option', '', label); option.value = value; channel.append(option); }
  const current = element('p', 'settings-note'), channelNote = element('p', 'settings-note', 'Nightly follows daily builds from main and is less tested. Channel changes apply after you quit and reopen the app. Returning to Stable waits for a newer stable version; it never downgrades.');
  body.append(current, channel, channelNote); const channelStatus = settingsStatus(body);
  channel.onchange = async () => { await runSettingsAction(channel, channelStatus, () => command('settings', { releaseChannel: channel.value }), 'Saving channel…', 'Channel saved. Quit and reopen the app to apply it.'); channel.value = state.releaseChannel || 'stable'; };

  const summary = element('p', 'settings-update-summary'), versions = element('p', 'settings-note settings-version-detail'), error = element('p', 'settings-note');
  summary.id = 'settings-update-summary'; summary.setAttribute('role', 'status'); body.append(summary, versions, error);
  settingsAction(body, 'Check for updates', 'versions-refresh', {}, { busy: 'Requesting update status…', success: 'Update check requested. New version information appears here when it is available.' });
  const review = element('button', 'secondary-button', 'Review updates'); review.id = 'settings-review-updates'; review.onclick = () => $('update-all').click(); body.append(review);
  const hermes = element('button', 'secondary-button', 'Update Hermes'); body.append(hermes); const status = settingsStatus(body);
  hermes.onclick = async () => { const reply = await runSettingsAction(hermes, status, () => api.command('hermes-update'), 'Updating Hermes on the agent machine. This can take a few minutes.'); if (reply.ok) { status.textContent = reply.result?.detail || 'The update returned no result.'; status.classList.toggle('error', !reply.result?.ok); } };
  return () => {
    const v = state.versions || {}, u = state.update || {}, run = state.updateAll || {};
    channel.value = state.releaseChannel || 'stable';
    current.textContent = `Current channel: ${state.activeReleaseChannel === 'nightly' ? 'Nightly (less tested)' : 'Stable'} · Installed v${state.version}${state.releaseChannel !== state.activeReleaseChannel ? ' · Restart required to apply selected channel' : ''}`;
    summary.textContent = run.busy || u.busy ? 'Updating…' : u.ready ? 'Restart is ready to finish the app update.' : v.hasUpdate || u.available ? 'Updates are available.' : v.tooltip ? 'No available updates reported.' : 'Version status has not been checked yet.';
    versions.textContent = v.tooltip || v.text || `Alan’s Workspace ${state.version || ''}`;
    error.textContent = u.error || run.summary || ''; error.classList.toggle('error', !!u.error);
  };
}
function mountSettingsDiagnostics(body) {
  const check = element('button', 'secondary-button', 'Check setup'); body.append(check); const status = settingsStatus(body), findings = element('div', 'checklist hidden'); body.append(findings);
  check.onclick = async () => {
    findings.classList.add('hidden'); const reply = await runSettingsAction(check, status, () => api.command('setup-check'), 'Checking this computer, the connection and the server. This can take up to two minutes.');
    if (reply.ok && Array.isArray(reply.result)) { findings.classList.remove('hidden'); renderFindings(findings, reply.result); }
  };
  settingsAction(body, 'Copy report', 'copy-report', {}, { success: 'Report copied. Paste it in Discord so the team can take a look.' });
  settingsAction(body, 'Get help on Discord ↗', 'open-support');
}
function showAvatarEditor(botId = state.selectedBotId || orderedBots()[0]?.id) {
  if (!botId) return toast('Open a Telegram bot before customizing its avatar.');
  openModal('Bot appearance');
  window.HermesAvatars.mountEditor($('modal-body'), { botId, command, onState: render, toast });
}
function showAddBot() {
  openModal('Open a Telegram bot');
  const form = element('form'), field = element('div', 'field'), label = element('label', '', 'Bot username'); label.htmlFor = 'bot-username';
  const input = element('input'); input.id = 'bot-username'; input.placeholder = '@your_agent_bot'; input.autocomplete = 'off';
  field.append(label, input, element('p', '', 'The chat opens in Telegram. Only verified bot accounts are added to your agent list.'));
  const submit = element('button', 'primary-button', 'Open bot'); submit.type = 'submit';
  const error = element('p', 'settings-note'); error.setAttribute('role', 'alert');
  form.append(field, error, submit); form.onsubmit = async (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    submit.disabled = true; input.disabled = true; submit.textContent = 'Opening…'; error.textContent = '';
    try {
      const result = await api.command('open-username', { username: input.value.trim() });
      if (result?.ok !== true) throw new Error('Telegram did not open the bot. Try again.');
      if (form.isConnected) closeModal();
    } catch (failure) { error.textContent = failure.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''); }
    finally { submit.disabled = false; input.disabled = false; submit.textContent = 'Open bot'; }
  };
  $('modal-body').append(form); input.focus();
}
function clearBotSearch() { $('bot-search').value = ''; renderBots(); $('bot-search').focus(); }
function toggleBotSearch(show) {
  $('bot-search-controls').classList.toggle('hidden', !show); $('bot-search').classList.toggle('hidden', !show);
  $('search-toggle').setAttribute('aria-expanded', String(show));
  if (show) $('bot-search').focus();
  else { $('bot-search').value = ''; renderBots(); $('search-toggle').focus(); }
}
$('search-toggle').onclick = () => toggleBotSearch($('bot-search').classList.contains('hidden'));
$('bot-search-clear').onclick = clearBotSearch;
$('bot-search-reset').onclick = clearBotSearch;
function handleBotSearchKey(event) {
  if (event.key === 'Escape') {
    event.preventDefault(); event.stopPropagation();
    if ($('bot-search').value) clearBotSearch(); else toggleBotSearch(false);
  } else if (event.key === 'ArrowDown' && event.target === $('bot-search')) {
    const first = $('bot-list').querySelector('.bot-open');
    if (first) { event.preventDefault(); first.focus(); }
  }
}
$('bot-search-controls').onkeydown = handleBotSearchKey;
$('bot-search-empty').onkeydown = handleBotSearchKey;
$('bot-search').oninput = renderBots;
$('add-bot').onclick = showAddBot;
$('settings-button').onclick = showSettings;
$('settings-fallback').onclick = showSettings;
$('shortcuts-button').onclick = showShortcuts;
$('shortcut-close').onclick = closeShortcuts;
$('shortcut-search').oninput = renderShortcuts;
$('shortcut-clear').onclick = () => { $('shortcut-search').value = ''; renderShortcuts(); $('shortcut-search').focus(); };
$('shortcut-dialog').onclick = event => { if (event.target === $('shortcut-dialog')) closeShortcuts(); };
$('browser-collapse').onclick = () => { if (focusMode) { focusMode = false; $('shell').classList.remove('focus-workspace'); } command('settings', { showBrowser: state?.showBrowser === false }); };
$('bots-toggle').onclick = () => command('settings', { showBots: state.showBots === false });
$('sort-bots').onclick = (event) => {
  event.stopPropagation();
  const menu = $('sort-menu'), open = menu.classList.contains('hidden');
  menu.classList.toggle('hidden', !open);
  $('sort-bots').setAttribute('aria-expanded', String(open));
  if (open) menu.querySelectorAll('button').forEach((button) => {
    const active = button.dataset.sort === (state.botSort || 'manual');
    button.classList.toggle('selected', active);
    button.setAttribute('aria-checked', String(active));
    if (!button.querySelector('.sort-check')) button.prepend(element('span', 'sort-check', '✓'));
  });
};
$('sort-menu').onclick = (event) => {
  const button = event.target.closest('button[data-sort]');
  if (button) command('bot-sort', { mode: button.dataset.sort });
  $('sort-menu').classList.add('hidden'); $('sort-bots').setAttribute('aria-expanded', 'false');
};
document.addEventListener('click', (event) => {
  if (!event.target.closest('#sort-menu') && !event.target.closest('#sort-bots')) { $('sort-menu').classList.add('hidden'); $('sort-bots').setAttribute('aria-expanded', 'false'); }
  if (!event.target.closest('#downloads-menu') && !event.target.closest('#downloads-button')) closeDownloads();
  if (!event.target.closest('#tabs-panel') && !event.target.closest('#tabs-menu')) setTabsPanel(false);
  if (!event.target.closest('#status-panel') && !event.target.closest('#status-more')) setStatusPanel(false);
});
const openStatusPanel = () => { setStatusPanel(true); $('status-panel').querySelector('.status-panel-row')?.focus({ preventScroll: true }); };
$('status-more').onclick = (event) => { event.stopPropagation(); if ($('status-panel').classList.contains('hidden')) openStatusPanel(); else setStatusPanel(false); };
for (const id of ['workspace-status', 'connection-status']) {
  const el = $(id);
  el.onclick = (event) => { event.stopPropagation(); openStatusPanel(); };
  el.onkeydown = (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); el.click(); } };
}
$('status-panel').onkeydown = (event) => {
  if (event.key === 'Escape') { event.preventDefault(); setStatusPanel(false); (canFocus($('status-more')) ? $('status-more') : $('workspace-status')).focus({ preventScroll: true }); return; }
  moveNavigationFocus(event, [...$('status-panel').querySelectorAll('.status-panel-row')], 'vertical');
};
$('presence-avatar').onclick = () => showAvatarEditor();
$('chat-avatar').onclick = () => showAvatarEditor();
$('chat-avatar').onkeydown = (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); showAvatarEditor(); } };
$('vm-toggle').onclick = () => { if (state?.showBrowser === false) command('settings', { showBrowser: true }); command('toggle-vps-view'); };
$('preview-expand').onclick = () => command('toggle-vps-view');
$('preview-hide').onclick = () => command('settings', { preview: false });
$('preview-chip').onclick = () => command('settings', { preview: true });
wirePreviewDrag();
$('extensions-button').onclick = showExtensions;
$('downloads-button').onclick = (event) => {
  event.stopPropagation();
  const menu = $('downloads-menu'), open = menu.classList.contains('hidden');
  menu.classList.toggle('hidden', !open);
  $('downloads-button').setAttribute('aria-expanded', String(open));
  if (open) { delete menu.dataset.signature; renderDownloads(); }
};
$('tabs-menu').onclick = (event) => {
  event.stopPropagation();
  const open = $('tabs-panel').classList.contains('hidden');
  setTabsPanel(open);
  if (open) $('tabs-panel').querySelector('.tabs-panel-select')?.focus({ preventScroll: true });
};
$('tabs-menu').onkeydown = (event) => {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  event.preventDefault();
  setTabsPanel(true);
  const items = [...$('tabs-panel').querySelectorAll('.tabs-panel-select')];
  (event.key === 'ArrowDown' ? items[0] : items.at(-1))?.focus({ preventScroll: true });
};
$('tabs-panel').onkeydown = (event) => {
  if (event.key === 'Escape') { event.preventDefault(); setTabsPanel(false); $('tabs-menu').focus({ preventScroll: true }); return; }
  moveNavigationFocus(event, [...$('tabs-panel').querySelectorAll('.tabs-panel-select')], 'vertical');
};
$('new-tab').onclick = async () => { await command('create-tab'); $('address').focus(); };
function submitUrl(event, inputId) { event.preventDefault(); const url = $(inputId).value.trim(); if (!url) return; if (state.tabs.some((tab) => tab.id === state.activeTabId)) command('navigate', { id: state.activeTabId, url }); else command('create-tab', { url }); }
$('address-form').onsubmit = (event) => submitUrl(event, 'address');
$('home-search').onsubmit = (event) => submitUrl(event, 'home-address');
$('home-agent').onclick = async () => {
  const button = $('home-agent');
  button.disabled = true;
  try {
    const created = await command('create-tab', { url: $('home-address').value.trim() || 'about:blank' });
    if (created?.id) await command('control', { id: created.id, controller: 'agent' });
  } finally { button.disabled = false; }
};
document.querySelectorAll('[data-url]').forEach((button) => { button.onclick = () => command('create-tab', { url: button.dataset.url }); });
for (const action of ['back', 'forward', 'reload']) $(action).onclick = () => command('history', { id: state.activeTabId, action });
$('browser-error-reload').onclick = () => command('history', { id: state.activeTabId, action: 'reload' });
$('control-button').onclick = () => { const tab = state.tabs.find((item) => item.id === state.activeTabId); if (tab) command('control', { id: tab.id, host: tab.host, controller: tab.controller === 'agent' ? 'human' : 'agent' }); };
async function stopRecording(save) {
  stoppedRecordingAt = state.recording?.startedAt || 0;
  const saved = await command('record-stop', { save, keepTyped: $('recording-keep').checked });
  const bot = state.bots.find(item => item.id === state.selectedBotId);
  if (saved) toast(`Saved “${saved.title}” (${saved.steps} steps)${bot ? `, shared with ${bot.name}. Ask ${bot.name} to turn it into a skill` : '. Share it with a bot in Settings → Recordings'}.`);
  else if (saved === null && save) toast('Nothing was recorded.');
}
$('record-button').onclick = () => {
  if (state.recording) return stopRecording(true);
  $('recording-keep').checked = false;
  command('record-start', { id: state.activeTabId });
};
$('recording-stop').onclick = () => stopRecording(true);
$('recording-discard').onclick = () => stopRecording(false);
$('takeover-take-back').onclick = () => { const tab = state.tabs.find((item) => item.id === state.activeTabId); if (tab) command('control', { id: tab.id, host: tab.host, controller: 'human', takeBack: true }); };
$('needs-you-give-back').onclick = async () => {
  const tab = state.tabs.find((item) => item.id === (state.activeTabId === 'vps' ? state.activeVpsTabId : state.activeTabId) && item.host === (state.activeTabId === 'vps' ? 'vps' : state.hostLabel));
  if (tab) {
    const reply = await command('control', { id: tab.id, host: tab.host, controller: 'agent', giveBack: true, epoch: tab.epoch });
    if (reply?.refused === 'stale') toast('That changed while you were looking. Press Give back again.');
  }
};
$('handoff-button').onclick = async () => {
  const tab = state.tabs.find((item) => item.id === state.activeTabId);
  if (!tab) return;
  const back = tab.handoff?.phase === 'handed_off' ? tab.handoff.destinationTabId : '';
  handoffBusy = true; render(state);
  try {
    const record = await command('handoff', back
      ? { id: back, destination: 'mac', includeDrafts: true }
      : { id: tab.id, destination: 'vps', includeDrafts: true });
    if (record) toast(`${back ? `Moved back to your ${thisComputer()}` : `Moved to the ${remoteName()}`}${record.signIns ? ` with ${record.signIns} sign-in cookie${record.signIns === 1 ? '' : 's'}` : record.signInsCarried ? '' : ', without sign-ins'}.${record.verification && record.verification !== 'ready' ? ' Review the page before the agent continues.' : ''}`);
  } finally { handoffBusy = false; render(state); }
};
$('ask-bot').onclick = () => command('share-page');

$('modal-close').onclick = closeModal;
$('modal').onclick = (event) => { if (event.target === $('modal')) closeModal(); };
$('update-now').onclick = () => command('update-now');
$('update-later').onclick = () => { updatePopupPinned = false; command('update-later'); };
$('vm-banner-retry').onclick = () => command('vm-update-retry');
// Opening re-checks the machine, so the plan does not lean on a cache that can
// be half an hour old; it re-renders when the answer lands.
$('update-all').onclick = () => { updateAllOpen = true; updateAllView = state?.updateAll?.busy ? 'run' : 'plan'; renderUpdateAll(); if (updateAllView === 'plan') command('versions-refresh'); };
$('update-all-cancel').onclick = closeUpdateAll;
$('update-all-check').onclick = () => command('versions-refresh');
$('update-all-go').onclick = () => {
  // The run view starts empty, not on a previous run's rows, until main's
  // first broadcast lands.
  if (updateAllView === 'plan') {
    updateAllView = 'run'; updateAllError = ''; state.updateAll = { busy: true, steps: [] }; renderUpdateAll();
    // api.command, not command(): a failure lands in the dialog itself, never
    // a toast behind an empty run view. Main refuses while another update
    // holds the lock or when nothing is behind; that goes back to the plan.
    api.command('update-all').then((reply) => {
      if (reply?.refused) { updateAllView = 'plan'; toast(reply.refused); }
    }).catch((error) => { updateAllError = error?.message || String(error); })
      .then(() => api.getState()).then(render)
      .catch((error) => { state.updateAll = { busy: false, steps: [] }; updateAllError ||= error?.message || String(error); renderUpdateAll(); });
  }
  else command('update-all-restart');
};
$('update-all-popup').onclick = (event) => { if (event.target === $('update-all-popup')) closeUpdateAll(); };
$('update-popup').onclick = (event) => { if (event.target === $('update-popup') && !state?.update?.busy) $('update-later').click(); };
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') { if (modalOpen) closeModal(); else if (!$('tabs-panel').classList.contains('hidden')) { setTabsPanel(false); $('tabs-menu').focus({ preventScroll: true }); } else if (!$('status-panel').classList.contains('hidden')) { setStatusPanel(false); (canFocus($('status-more')) ? $('status-more') : $('workspace-status')).focus({ preventScroll: true }); } else closeDownloads(); } });
$('splitter').onpointerdown = (event) => {
  const startX = event.clientX, startWidth = document.querySelector('.chat-pane').getBoundingClientRect().width; $('splitter').setPointerCapture(event.pointerId); $('splitter').classList.add('active');
  const sidebar = document.querySelector('.sidebar');
  const handleMove = (ev) => { const max = Math.min(680, innerWidth - sidebar.getBoundingClientRect().width - 355); const width = Math.max(320, Math.min(max, startWidth + ev.clientX - startX)); document.documentElement.style.setProperty('--chat-width', `${width}px`); scheduleLayout(); };
  const end = () => { $('splitter').classList.remove('active'); $('splitter').removeEventListener('pointermove', handleMove); $('splitter').removeEventListener('pointerup', end); command('settings', { chatWidth: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--chat-width')) }); };
  $('splitter').addEventListener('pointermove', handleMove); $('splitter').addEventListener('pointerup', end);
};
// ── Native Hermes chat: sidebar section, setup card, surface mount ─────────
async function hermesCommand(name, value = {}) {
  try { return await hermesApi.command(name, value); }
  catch (error) { toast(window.HermesView.commandErrorMessage(error)); return null; }
}
function renderHermes() {
  const h = state.hermes || { status: 'unconfigured', sessions: [] };
  const list = $('hermes-list'), connect = $('hermes-connect');
  $('hermes-new').classList.toggle('hidden', h.status !== 'ready');
  // The Telegram row is the way back — always present while a Hermes target is
  // showing, so a bot-less workspace is never stranded on the Hermes pane.
  list.innerHTML = '';
  if (state.chatTarget === 'hermes') {
    const back = element('div', 'bot-row hermes-row');
    const open = element('button', 'bot-open', '← Telegram');
    open.onclick = () => command('show-telegram');
    back.append(open);
    list.append(back);
  }
  for (const session of h.sessions) {
    const row = element('div', `bot-row hermes-row${session.selected ? ' selected' : ''}`);
    const open = element('button', 'bot-open', session.title || session.id);
    open.onclick = () => hermesCommand('select', { sessionId: session.id, sessionKey: session.key });
    row.append(open);
    list.append(row);
  }
  if (h.status === 'ready') {
    if (!h.sessions.length) list.append(element('div', 'hermes-note', 'No live conversations.'));
    if (h.storedSessions?.length) {
      list.append(element('div', 'hermes-note', 'Saved conversations'));
      for (const saved of h.storedSessions) {
        const row = element('div', 'bot-row hermes-row');
        const resume = element('button', 'bot-open', `Resume ${saved.title || saved.id}`);
        const generation = h.generation;
        resume.onclick = () => hermesCommand('resume-session', { storedSessionId: saved.id, generation });
        row.append(resume); list.append(row);
      }
    } else if (!h.sessions.length && !h.storedSessionsError) {
      list.append(element('div', 'hermes-note', 'No saved conversations.'));
    }
    if (h.storedSessionsError) list.append(element('div', 'hermes-note', h.storedSessionsError));
  }
  // Compact connection status in the sidebar; the full form lives in the pane.
  connect.classList.remove('hidden');
  connect.innerHTML = '';
  const label = { unconfigured: 'No backend configured', disconnected: 'Not connected', connecting: 'Connecting…', needs_signin: 'Sign in required', needs_local_token: 'Session token required', ready: `Connected · ${h.target?.label || ''}`, error: 'Connection error' }[h.status] || h.status;
  const row = element('button', 'hermes-connect-row');
  row.append(element('span', `status-dot hermes-dot ${h.status === 'ready' ? 'on' : ''}`), element('span', 'hermes-connect-label', label));
  row.title = h.target?.label ? `Hermes backend: ${h.target.label}` : 'Set up a Hermes backend';
  row.onclick = () => command('show-hermes');
  connect.append(row);
  renderHermesSetup(h);
}
// The setup card owns the pane only when the backend genuinely needs input —
// first configure, sign-in, session token — or no established conversation
// exists to recover. A dropped socket with a selected session keeps the
// conversation surface instead: its last-known transcript, draft, tombstone
// and one recovery action stay in place; explicit setup stays reachable via
// the view's Change backend affordance and resets itself the moment input is
// required anyway or the pane loses the target. Connected state pushes must
// not close an explicitly opened backend editor.
let hermesSetupForced = false;
function renderHermesSetup(h) {
  const setup = $('hermes-setup'), convo = $('hermes-convo');
  if (!setup) return;
  const needsInput = h.status === 'unconfigured' || h.status === 'needs_signin' || h.status === 'needs_local_token';
  if (needsInput || state.chatTarget !== 'hermes') hermesSetupForced = false;
  const needsSetup = state.chatTarget === 'hermes'
    && (hermesSetupForced || needsInput || (h.status !== 'ready' && !h.selected));
  setup.classList.toggle('hidden', !needsSetup);
  convo.classList.toggle('hidden', !!needsSetup);
  const renderedKey = JSON.stringify([h.status, h.target?.url, h.target?.profile, h.providers, !!h.signInPending, hermesSetupForced]);
  if (!needsSetup) return;
  const updateError = () => {
    const error = setup.querySelector('.hermes-setup-error');
    if (!error) return;
    error.textContent = h.error?.message ? window.HermesView.commandErrorMessage(h.error) : '';
    error.classList.toggle('hidden', !error.textContent);
  };
  if (setup.dataset.rendered === renderedKey) { updateError(); return; }
  setup.dataset.rendered = renderedKey;
  setup.innerHTML = '';
  const card = element('div', 'hermes-setup-card');
  card.append(element('h2', '', 'Hermes backend'));
  card.append(element('p', 'settings-note', h.target
    ? `${h.target.label}${h.target.profile ? ` · profile ${h.target.profile}` : ''}`
    : 'Point this app at an existing Hermes backend (hermes serve). Nothing is shared with Telegram or the remote browser.'));
  const urlInput = element('input', 'settings-input hermes-field');
  urlInput.placeholder = 'https://host:9119 or http://127.0.0.1:9119';
  urlInput.value = h.target?.url || '';
  urlInput.setAttribute('aria-label', 'Hermes backend URL');
  const profileInput = element('input', 'settings-input hermes-field');
  profileInput.placeholder = 'Profile (optional)';
  profileInput.value = h.target?.profile || '';
  profileInput.setAttribute('aria-label', 'Hermes profile');
  card.append(urlInput, profileInput);
  if (h.status === 'needs_local_token') {
    const tok = element('input', 'settings-input hermes-field');
    tok.type = 'password';
    tok.placeholder = 'Per-launch session token';
    tok.setAttribute('aria-label', 'Backend session token');
    card.append(element('p', 'settings-note', 'This backend runs unauthenticated loopback mode. Enter its session token (set HERMES_DASHBOARD_SESSION_TOKEN when launching it), or start the backend with authentication.'));
    card.append(tok);
    card.append(setupButton('Connect', async () => {
      const r = await hermesCommand('configure', { url: urlInput.value, profile: profileInput.value, localToken: tok.value });
      if (r) await hermesCommand('connect');
    }));
  } else {
    if (h.status === 'needs_signin') {
      // Provider capabilities come from the backend probe. Unknown metadata
      // must not turn into a guessed password form or browser authorization.
      const providers = Array.isArray(h.providers) ? h.providers : [];
      const browserProviders = providers.filter(p => p.browser === true);
      const passwordProviders = providers.filter(p => p.password === true);
      const prepareSignIn = async () => {
        const unchanged = urlInput.value === h.target?.url && profileInput.value === (h.target?.profile || '');
        if (unchanged) return true;
        // Capabilities belong to the original target. Probe the edited target
        // before offering its own methods on the next state push.
        const configured = await hermesCommand('configure', { url: urlInput.value, profile: profileInput.value });
        if (configured) await hermesCommand('connect');
        return false;
      };
      if (h.signInPending) {
        card.append(element('p', 'settings-note', 'Finish signing in in your browser, then return here.'));
        card.append(setupButton('Cancel sign-in', () => hermesCommand('cancel-sign-in')));
      } else {
        for (const provider of browserProviders) {
          card.append(setupButton(`Continue with ${provider.displayName || provider.name} in browser`, async () => {
            if (await prepareSignIn()) await hermesCommand('sign-in-browser', { provider: provider.name });
          }));
        }
        if (passwordProviders.length) {
          const user = element('input', 'settings-input hermes-field');
          user.placeholder = 'Username';
          user.setAttribute('aria-label', 'Username');
          user.autocomplete = 'username';
          const pass = element('input', 'settings-input hermes-field');
          pass.type = 'password';
          pass.placeholder = 'Password';
          pass.setAttribute('aria-label', 'Password');
          pass.autocomplete = 'current-password';
          card.append(user, pass);
          for (const provider of passwordProviders) card.append(setupButton(passwordProviders.length === 1
            ? 'Sign in and connect' : `Sign in with ${provider.displayName || provider.name}`, async () => {
              try {
                if (await prepareSignIn()) await hermesCommand('sign-in', { provider: provider.name, username: user.value, password: pass.value });
              } finally { pass.value = ''; }
          }));
        }
        if (!browserProviders.length && !passwordProviders.length) {
          card.append(element('p', 'settings-note', 'No supported sign-in method was advertised by this backend. Check the backend address and authentication configuration.'));
        }
      }
    } else {
      card.append(setupButton('Save and connect', async () => {
        const r = await hermesCommand('configure', { url: urlInput.value, profile: profileInput.value });
        if (r) { hermesSetupForced = false; await hermesCommand('connect'); }
      }));
    }
  }
  const error = element('p', 'hermes-setup-error hidden');
  error.setAttribute('role', 'status');
  error.setAttribute('aria-live', 'polite');
  card.append(error);
  if (hermesSetupForced) {
    const back = element('button', 'link-button hermes-setup-back', 'Back to conversation');
    back.type = 'button';
    back.onclick = () => { hermesSetupForced = false; render(state); };
    card.append(back);
  }
  setup.append(card);
  updateError();
}
function setupButton(text, onClick) {
  const b = element('button', 'primary-button hermes-setup-go', text);
  b.type = 'button';
  b.onclick = async () => { b.disabled = true; try { await onClick(); } finally { b.disabled = false; } };
  return b;
}
$('hermes-new').onclick = () => hermesCommand('new-session');
if (window.HermesView && hermesApi) {
  hermesView = window.HermesView.createHermesView({ api: hermesApi, root: $('hermes-convo'),
    onShowSetup: () => { hermesSetupForced = true; render(state); } });
}
api.onState(render);
api.onPointer?.(point => window.HermesAvatars.receivePointer(point));
api.onFocusAddress(() => { $('address').focus(); $('address').select(); });
api.onSettings?.(() => { if (!dialogStack.length) showSettings(); });
api.onShortcuts?.(showShortcuts);
api.onFocusWorkspace?.(() => { if (state?.showBrowser === false) return; focusMode = !focusMode; $('shell').classList.toggle('focus-workspace', focusMode); scheduleLayout(); });
new ResizeObserver(scheduleLayout).observe($('shell'));
new ResizeObserver(() => fitTabs()).observe($('tabs'));
window.addEventListener('resize', () => { positionPreview(); scheduleLayout(); });
api.getState().then(render).catch((error) => toast(error.message));
