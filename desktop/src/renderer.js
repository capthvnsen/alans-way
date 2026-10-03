const api = window.workspace;
let state, draggingBot = '', focusMode = false, modalOpen = false, resizeFrame, toastTimer;
const $ = (id) => document.getElementById(id);
function element(tag, className, text) { const el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = text; return el; }
function toast(message) { $('toast').textContent = message; $('toast').classList.remove('hidden'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.add('hidden'), 5000); }
async function command(name, value = {}) { try { return await api.command(name, value); } catch (error) { toast(error.message); } }
function orderedBots(includeHidden = false) {
  const order = new Map(state.order.map((id, index) => [id, index]));
  return state.bots.filter((bot) => includeHidden || !state.hidden.includes(bot.id)).sort((a, b) => (order.get(a.id) ?? 10000) - (order.get(b.id) ?? 10000));
}
function colorFor(value) {
  const colors = ['#e6e6eb', '#00ba83', '#e9428b', '#f18b31', '#9673e1', '#22b9b7', '#689be4'];
  return colors[Array.from(value).reduce((sum, letter) => sum + letter.charCodeAt(0), 0) % colors.length];
}
function renderBots() {
  const search = $('bot-search').value.toLowerCase();
  const bots = orderedBots().filter((bot) => `${bot.name} ${bot.username}`.toLowerCase().includes(search));
  const list = $('bot-list'); list.replaceChildren();
  for (const bot of bots) {
    const row = element('div', `bot-row${state.selectedBotId === bot.id ? ' selected' : ''}`);
    row.setAttribute('role', 'button'); row.setAttribute('tabindex', '0'); row.setAttribute('aria-label', `Open ${bot.name}`); row.draggable = true; row.dataset.botId = bot.id;
    const avatar = element('span', 'avatar', bot.name.split(/\s+/).map((word) => word[0]).slice(0, 2).join('').toUpperCase()); avatar.style.backgroundColor = colorFor(bot.id);
    if (bot.avatar) { const img = element('img'); img.src = bot.avatar; img.alt = ''; avatar.replaceChildren(img); }
    const copy = element('span', 'bot-copy'); copy.append(element('div', 'bot-name', bot.name), element('div', 'bot-preview', bot.preview || (bot.username ? `@${bot.username}` : 'Telegram bot')));
    const hide = element('button', 'bot-hide', '×'); hide.title = `Hide ${bot.name}`; hide.setAttribute('aria-label', hide.title);
    hide.onclick = (event) => { event.stopPropagation(); command('hide-bot', { id: bot.id }); };
    row.append(avatar, copy); if (bot.unread) row.append(element('span', 'unread')); row.append(hide);
    row.onclick = () => command('open-bot', { id: bot.id });
    row.onkeydown = (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); command('open-bot', { id: bot.id }); } };
    row.ondragstart = (event) => { draggingBot = bot.id; row.classList.add('dragging'); event.dataTransfer.setData('text/plain', bot.id); event.dataTransfer.effectAllowed = 'move'; };
    row.ondragend = () => { draggingBot = ''; row.classList.remove('dragging'); document.querySelectorAll('.drop-target').forEach((el) => el.classList.remove('drop-target')); };
    row.ondragover = (event) => { if (draggingBot && draggingBot !== bot.id) { event.preventDefault(); row.classList.add('drop-target'); } };
    row.ondragleave = () => row.classList.remove('drop-target');
    row.ondrop = (event) => {
      event.preventDefault(); row.classList.remove('drop-target');
      const ids = orderedBots(true).map((item) => item.id), from = ids.indexOf(draggingBot), to = ids.indexOf(bot.id);
      if (from >= 0 && to >= 0) { ids.splice(from, 1); ids.splice(to, 0, draggingBot); command('sort-bots', { ids }); }
    };
    list.append(row);
  }
  $('bot-count').textContent = orderedBots().length;
  $('empty-bots').classList.toggle('hidden', state.bots.length > 0);
  $('empty-bots').querySelector('p').textContent = state.telegramStatus === 'connected' ? 'Finding your Telegram bot chats…' : 'Sign in to Telegram to load your bot chats here.';
  $('restore-bots').classList.toggle('hidden', !state.hidden.length);
  $('bridge-dot').classList.toggle('offline', !state.api.ready);
}
function renderTabs() {
  const container = $('tabs'); container.replaceChildren();
  const entries = [{ id: 'home', title: 'Start', symbol: '◔' }, ...state.tabs.map((tab) => ({ ...tab, symbol: tab.loading ? '◌' : '◈' })), { id: 'vps', title: 'VPS computer', symbol: '▣' }];
  for (const tab of entries) {
    const node = element('div', `tab${state.activeTabId === tab.id ? ' active' : ''}`); node.setAttribute('role', 'tab'); node.setAttribute('aria-selected', state.activeTabId === tab.id ? 'true' : 'false'); node.tabIndex = 0;
    node.append(element('span', 'tab-icon', tab.symbol), element('span', 'tab-title', tab.title || 'New tab'));
    node.onclick = () => command('activate', { id: tab.id });
    node.onkeydown = (event) => { if (event.key === 'Enter') command('activate', { id: tab.id }); };
    if (tab.id !== 'home' && tab.id !== 'vps') {
      const close = element('button', 'tab-close', '×'); close.title = `Close ${tab.title || 'tab'}`; close.setAttribute('aria-label', close.title);
      close.onclick = (event) => { event.stopPropagation(); command('close-tab', { id: tab.id }); }; node.append(close);
    }
    container.append(node);
  }
}
function render(next) {
  state = next;
  const bot = state.bots.find((item) => item.id === state.selectedBotId);
  document.documentElement.style.setProperty('--chat-width', `${state.chatWidth}px`);
  $('chat-title').textContent = bot?.name || 'Telegram';
  $('chat-avatar').textContent = bot ? bot.name[0].toUpperCase() : '◔';
  $('chat-avatar').style.backgroundColor = bot ? colorFor(bot.id) : '#e7e7e9';
  if (bot?.avatar) { const img = element('img'); img.src = bot.avatar; img.alt = ''; $('chat-avatar').replaceChildren(img); }
  renderBots(); renderTabs();
  const tab = state.tabs.find((item) => item.id === state.activeTabId);
  $('home').classList.toggle('hidden', !!tab || state.activeTabId === 'vps');
  $('browser-toolbar').classList.toggle('hidden', state.activeTabId === 'vps');
  $('remote-preview-slot').classList.toggle('hidden', !state.preview || state.activeTabId === 'vps');
  $('control-button').textContent = tab?.controller === 'agent' ? 'Take over' : 'Give to agent';
  $('control-button').classList.toggle('agent', tab?.controller === 'agent');
  $('control-button').disabled = !tab;
  $('tab-access').disabled = !tab;
  $('control-button').title = tab ? `Browser runs on your Mac · ${tab.controller === 'agent' ? 'Agent' : 'You'} control it` : 'Open a browser tab first';
  if (document.activeElement !== $('address')) $('address').value = tab?.url === 'about:blank' ? '' : tab?.url || '';
  $('local-label').textContent = state.activeTabId === 'vps' ? 'ON YOUR VPS' : 'ON YOUR MAC';
  $('workspace-status').textContent = tab?.error ? `Page: ${tab.error}` : tab?.loading ? 'Loading…' : tab ? `${tab.controller === 'agent' ? 'Agent' : 'You'} in control · Mac` : state.activeTabId === 'vps' ? `VPS · ${state.remoteStatus}` : 'Ready';
  $('connection-status').textContent = state.api.ready ? 'Browser connector ready' : state.api.error ? 'Browser connector unavailable' : 'Browser connector starting…';
  const notes = { login: 'Sign in with your Telegram account. Your bots appear on the left.', connected: 'Your Telegram account · bot chats only', locked: 'Unlock Telegram to load your bot chats.', offline: 'Telegram is offline. Check your connection, then sync in Settings.', loading: 'Connecting to Telegram…' };
  $('telegram-note').textContent = notes[state.telegramStatus] || notes.loading;
  scheduleLayout();
}
function rect(id) {
  const el = $(id); if (!el || el.classList.contains('hidden')) return null;
  const box = el.getBoundingClientRect(); if (!box.width || !box.height) return null;
  return { x: box.x + 1, y: box.y + 1, width: box.width - 2, height: box.height - 2 };
}
function scheduleLayout() {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => api.layout({ telegram: focusMode ? null : rect('telegram-slot'), browser: rect('browser-slot'), preview: rect('remote-preview-slot'), obscured: modalOpen }));
}
function openModal(title) {
  modalOpen = true; $('modal-title').textContent = title; $('modal-body').replaceChildren(); $('modal').classList.remove('hidden'); scheduleLayout();
}
function closeModal() { modalOpen = false; $('modal').classList.add('hidden'); scheduleLayout(); }
function showSettings() {
  openModal('Workspace settings');
  const body = $('modal-body'), field = element('div', 'field');
  const label = element('label', '', 'VPS desktop connection'); label.htmlFor = 'remote-url';
  const input = element('input'); input.id = 'remote-url'; input.placeholder = 'https://your-server/vnc.html or wss://…'; input.value = state.remoteUrl;
  field.append(label, input, element('p', '', 'Paste your existing noVNC viewer URL. Connect through Tailscale when your server is private. The small preview starts in watch mode.'));
  const save = element('button', 'primary-button', 'Save connection'); save.onclick = async () => { const result = await command('settings', { remoteUrl: input.value.trim() }); if (result) { closeModal(); toast('VPS connection saved.'); } };
  body.append(field, save, element('hr', 'section-divider'));
  const row = element('div', 'setting-row'); row.append(element('span', '', 'VPS preview in the corner'));
  const toggle = element('button', 'secondary-button', state.preview ? 'Hide preview' : 'Show preview'); toggle.onclick = async () => { await command('settings', { preview: !state.preview }); toggle.textContent = state.preview ? 'Hide preview' : 'Show preview'; }; row.append(toggle); body.append(row);
  body.append(element('hr', 'section-divider'), element('h3', '', 'Browser connector'));
  body.append(element('p', 'settings-note', state.api.ready ? `Ready at ${state.api.url}. Your add-on can pair with this local connection to operate assigned tabs.` : state.api.error || 'Starting…'));
  const copy = element('button', 'secondary-button', 'Copy connection'); copy.onclick = async () => { await command('copy-connection'); toast('Connection URL and private token copied. Share only with your own agent connector.'); };
  const folder = element('button', 'secondary-button', 'Open app data'); folder.onclick = () => command('show-data'); body.append(copy, folder);
  body.append(element('p', 'settings-note', 'Taking over a local tab blocks new agent actions on that tab. VPS control currently uses your existing shared desktop; it does not pause your Hermes bots.'));
  body.append(element('hr', 'section-divider'));
  const sync = element('button', 'secondary-button', 'Sync Telegram bots'); sync.onclick = () => { command('sync-telegram'); toast('Reading Telegram’s bot chat list…'); };
  const restore = element('button', 'secondary-button', 'Restore hidden bots'); restore.onclick = () => { command('restore-bots'); toast('Hidden bots restored.'); };
  body.append(sync, restore, element('p', 'settings-note', 'Bot discovery reads Telegram Web A’s local cache. Newly opened bot chats appear after Telegram saves them. Your Telegram session and browser logins stay on this Mac.'));
}
function showAddBot() {
  openModal('Open a Telegram bot');
  const form = element('form'), field = element('div', 'field'), label = element('label', '', 'Bot username'); label.htmlFor = 'bot-username';
  const input = element('input'); input.id = 'bot-username'; input.placeholder = '@your_agent_bot'; input.autocomplete = 'off';
  field.append(label, input, element('p', '', 'The chat opens in Telegram. Only verified bot accounts are added to your agent list.'));
  const submit = element('button', 'primary-button', 'Open bot'); submit.type = 'submit';
  form.append(field, submit); form.onsubmit = async (event) => { event.preventDefault(); const result = await command('open-username', { username: input.value.trim() }); if (result) closeModal(); };
  $('modal-body').append(form); input.focus();
}
function showTabAccess() {
  const tab = state.tabs.find(item => item.id === state.activeTabId); if (!tab) return;
  openModal('Browser tab access');
  const body = $('modal-body'), field = element('div', 'field');
  const label = element('label', '', 'Assigned bot ID'); label.htmlFor = 'tab-bot-id';
  const owner = element('input'); owner.id = 'tab-bot-id'; owner.value = tab.botId;
  field.append(label, owner, element('p', '', 'Use this ID with --bot-id in the browser connector. Each connector normally sees only its own tabs.'));
  body.append(field, element('h3', '', 'Allow another bot to share this tab'));
  const choices = [];
  for (const bot of orderedBots()) {
    if (bot.id === tab.botId) continue;
    const row = element('label', 'access-choice'), checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.checked = tab.allowedBots.includes(bot.id);
    choices.push({ id: bot.id, checkbox }); row.append(checkbox, element('span', '', bot.name)); body.append(row);
  }
  const save = element('button', 'primary-button', 'Save access');
  save.onclick = async () => { if (!owner.value.trim()) return toast('Enter a bot ID.'); const result = await command('grant-tab', { id: tab.id, botId: owner.value.trim(), botIds: choices.filter(item => item.checkbox.checked).map(item => item.id) }); if (result) closeModal(); };
  body.append(element('p', 'settings-note', 'Shared tabs use the same page and control state. These grants apply to this local tab. They do not change VPS desktop access.'), save);
}
$('search-toggle').onclick = () => { $('bot-search').classList.toggle('hidden'); if (!$('bot-search').classList.contains('hidden')) $('bot-search').focus(); else { $('bot-search').value = ''; renderBots(); } };
$('bot-search').oninput = renderBots;
$('add-bot').onclick = showAddBot;
$('restore-bots').onclick = () => command('restore-bots');
$('settings-button').onclick = showSettings;
$('computer-button').onclick = () => command('activate', { id: 'vps' });
$('home-vps').onclick = () => command('activate', { id: 'vps' });
$('new-tab').onclick = async () => { await command('create-tab'); $('address').focus(); };
$('preview-toggle').onclick = () => command('settings', { preview: !state.preview });
$('focus-toggle').onclick = () => { focusMode = !focusMode; $('shell').classList.toggle('focus-workspace', focusMode); scheduleLayout(); };
function submitUrl(event, inputId) { event.preventDefault(); const url = $(inputId).value.trim(); if (!url) return; if (state.tabs.some((tab) => tab.id === state.activeTabId)) command('navigate', { id: state.activeTabId, url }); else command('create-tab', { url }); }
$('address-form').onsubmit = (event) => submitUrl(event, 'address');
$('home-search').onsubmit = (event) => submitUrl(event, 'home-address');
document.querySelectorAll('[data-url]').forEach((button) => { button.onclick = () => command('create-tab', { url: button.dataset.url }); });
for (const action of ['back', 'forward', 'reload']) $(action).onclick = () => command('history', { id: state.activeTabId, action });
$('control-button').onclick = () => { const tab = state.tabs.find((item) => item.id === state.activeTabId); if (tab) command('control', { id: tab.id, controller: tab.controller === 'agent' ? 'human' : 'agent' }); };
$('tab-access').onclick = showTabAccess;
$('modal-close').onclick = closeModal;
$('modal').onclick = (event) => { if (event.target === $('modal')) closeModal(); };
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && modalOpen) closeModal(); });
$('splitter').onpointerdown = (event) => {
  const startX = event.clientX, startWidth = state.chatWidth; $('splitter').setPointerCapture(event.pointerId); $('splitter').classList.add('active');
  const sidebar = document.querySelector('.sidebar');
  const handleMove = (ev) => { const max = Math.min(680, innerWidth - sidebar.getBoundingClientRect().width - 355); const width = Math.max(320, Math.min(max, startWidth + ev.clientX - startX)); document.documentElement.style.setProperty('--chat-width', `${width}px`); scheduleLayout(); };
  const end = () => { $('splitter').classList.remove('active'); $('splitter').removeEventListener('pointermove', handleMove); $('splitter').removeEventListener('pointerup', end); command('settings', { chatWidth: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--chat-width')) }); };
  $('splitter').addEventListener('pointermove', handleMove); $('splitter').addEventListener('pointerup', end);
};
api.onState(render);
api.onFocusAddress(() => { $('address').focus(); $('address').select(); });
api.onSettings?.(showSettings);
api.onFocusWorkspace?.(() => { focusMode = !focusMode; $('shell').classList.toggle('focus-workspace', focusMode); scheduleLayout(); });
new ResizeObserver(scheduleLayout).observe($('shell'));
window.addEventListener('resize', scheduleLayout);
api.getState().then(render).catch((error) => toast(error.message));
