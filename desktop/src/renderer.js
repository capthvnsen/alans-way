const api = window.workspace;
let state, draggingBot = '', focusMode = false, modalOpen = false, resizeFrame, toastTimer, botListSignature = '';
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
  const list = $('bot-list');
  const signature = JSON.stringify([bots.map(({ activity, ...bot }) => bot), state.selectedBotId]);
  if (signature === botListSignature) {
    for (const row of list.children) {
      const bot = bots.find(item => item.id === row.dataset.botId);
      if (bot) { window.HermesAvatars.paint(row.querySelector('.avatar'), bot, state); renderBotActivity(row, bot); }
    }
    $('bridge-dot').classList.toggle('offline', !state.api.ready);
    return;
  }
  botListSignature = signature; list.replaceChildren();
  for (const bot of bots) {
    const row = element('div', `bot-row${state.selectedBotId === bot.id ? ' selected' : ''}`);
    row.setAttribute('role', 'button'); row.setAttribute('tabindex', '0'); row.setAttribute('aria-label', `Open ${bot.name}`); row.draggable = true; row.dataset.botId = bot.id;
    const avatar = element('span', 'avatar'); window.HermesAvatars.paint(avatar, bot, state);
    const copy = element('span', 'bot-copy'); copy.append(element('div', 'bot-name', bot.name), element('div', 'bot-preview', bot.preview || (bot.username ? `@${bot.username}` : 'Telegram bot')), element('div', 'bot-activity'));
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
    renderBotActivity(row, bot); list.append(row);
  }
  $('bot-count').textContent = orderedBots().length;
  $('empty-bots').classList.toggle('hidden', state.bots.length > 0);
  $('empty-bots').querySelector('p').textContent = state.telegramStatus === 'connected' ? 'Finding your Telegram bot chats…' : 'Sign in to Telegram to load your bot chats here.';
  $('restore-bots').classList.toggle('hidden', !state.hidden.length);
  $('bridge-dot').classList.toggle('offline', !state.api.ready);
}
function renderBotActivity(row, bot) {
  const status = row.querySelector('.bot-activity'), activity = bot.activity;
  const active = activity?.state === 'active' && (!activity.expiresAt || activity.expiresAt > Date.now());
  status.textContent = active ? activity.label || 'Telegram activity' : activity?.state === 'idle' ? 'Idle' : 'Activity unavailable';
  status.classList.toggle('active', active);
  status.title = activity?.detail || 'Live Telegram chat actions. No activity signal does not prove a bot has stopped working.';
}
function renderTabs() {
  const container = $('tabs'); container.replaceChildren();
  const visible=state.tabs.filter(tab=>state.allAgentTabs || !state.selectedBotId || tab.botId===state.selectedBotId || tab.allowedBots.includes(state.selectedBotId) || tab.id===state.activeTabId);
  const entries = [{ id: 'home', title: 'Start', symbol: '◔' }, ...visible.map((tab) => ({ ...tab, symbol: tab.loading ? '◌' : tab.host==='vps'?'▣':'◈' })), { id: 'vps', title: 'VPS desktop', symbol: '▣' }];
  for (const tab of entries) {
    const node = element('div', `tab${state.activeTabId === tab.id ? ' active' : ''}`); node.setAttribute('role', 'tab'); node.setAttribute('aria-selected', state.activeTabId === tab.id ? 'true' : 'false'); node.tabIndex = 0;
    node.append(element('span', 'tab-icon', tab.symbol), element('span', 'tab-title', tab.title || 'New tab'));
    if(tab.host)node.title=`${tab.host==='vps'?'VPS':'Mac'} · ${state.bots.find(bot=>bot.id===tab.botId)?.name || tab.botId}`;
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
  window.HermesAvatars.update(state);
  const bot = state.bots.find((item) => item.id === state.selectedBotId);
  document.documentElement.style.setProperty('--chat-width', `${state.chatWidth}px`);
  $('chat-title').textContent = bot?.name || 'Telegram';
  window.HermesAvatars.paint($('chat-avatar'), bot || { id: '', name: 'Telegram' }, state);
  $('chat-avatar').title = bot ? `Customize ${bot.name} avatar` : 'Select a bot to customize its avatar';
  $('agent-presence').classList.toggle('hidden', !bot);
  if (bot) {
    window.HermesAvatars.paint($('presence-avatar'), bot, state);
    $('presence-name').textContent = bot.name;
    $('presence-status').textContent = window.HermesAvatars.activityLabel(bot.activity);
    $('presence-status').classList.toggle('active', window.HermesAvatars.isActive(bot.activity));
  }
  renderBots(); renderTabs(); renderSettingsBots(); renderSitePermissions();
  const tab = state.tabs.find((item) => item.id === state.activeTabId);
  const remote = state.activeTabId==='vps';
  $('home').classList.toggle('hidden', !!tab || state.activeTabId === 'vps');
  $('browser-toolbar').classList.toggle('hidden', state.activeTabId === 'vps');
  $('remote-preview-slot').classList.toggle('hidden', !state.preview || remote);
  $('agent-workspace-name').textContent=bot?.name || 'Your tabs';
  $('all-agent-tabs').textContent=state.allAgentTabs?'All tabs':'Agent tabs';
  $('all-agent-tabs').title=state.allAgentTabs?'Show this agent’s tabs':'Show every agent’s tabs';
  $('control-button').textContent = tab?.controller === 'agent' ? 'Take over' : 'Give to agent';
  $('control-button').classList.toggle('agent', tab?.controller === 'agent');
  $('control-button').disabled = !tab;
  $('tab-access').disabled = !tab;
  $('control-button').title = tab ? `Browser runs on ${tab.host==='vps'?'the VPS':'your Mac'} · ${tab.controller === 'agent' ? 'Agent' : 'You'} control it` : 'Open a browser tab first';
  if (document.activeElement !== $('address')) $('address').value = tab?.url === 'about:blank' ? '' : tab?.url || '';
  $('local-label').textContent = remote ? 'ON YOUR VPS' : 'ON YOUR MAC';
  $('workspace-status').textContent = tab?.error ? `Page: ${tab.error}` : tab?.loading ? 'Loading…' : tab ? `${tab.controller === 'agent' ? 'Agent' : 'You'} in control · ${tab.host==='vps'?'VPS':'Mac'}${tab.handoff?' · Handoff: review page before continuing':''}` : state.activeTabId === 'vps' ? `VPS · ${state.remoteStatus}` : 'Ready';
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
function renderSettingsBots() {
  const list = $('settings-bots');
  if (!modalOpen || !list) return;
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
    toggle.onchange = async () => {
      const visible = toggle.checked; toggle.disabled = true;
      const result = await command('set-bot-visibility', { id: bot.id, visible });
      if (result) render(result);
      else { toggle.checked = !state.hidden.includes(bot.id); toggle.disabled = false; }
    };
    row.append(copy, toggle); list.append(row);
    if (focusedId === bot.id) toggle.focus({ preventScroll: true });
  }
}
const permissionLabels = { geolocation: 'Precise location', 'geolocation-approximate': 'General area', notifications: 'Notifications', camera: 'Camera', microphone: 'Microphone', 'clipboard-read': 'Read clipboard' };
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
  list.dataset.signature = signature; list.replaceChildren();
  for (const [scope, sites] of Object.entries(state.sitePermissions || {})) {
    for (const [origin, permissions] of Object.entries(sites)) for (const [permission, decision] of Object.entries(permissions)) {
      if (!permissionLabels[permission]) continue;
      const row = element('div', 'setting-row'), copy = element('span', 'visibility-copy');
      copy.append(element('span', 'visibility-name', `${permissionLabels[permission]} · ${scope === 'telegram' ? 'Telegram' : 'Browser'}`), element('span', 'visibility-username', origin));
      const choice = permissionChoice(decision, value => command('set-site-permission', {scope, origin, permission, decision:value}));
      choice.setAttribute('aria-label', `${origin} ${permissionLabels[permission]}`); row.append(copy, choice); list.append(row);
    }
  }
}
function showSitePermissionSettings(body) {
  body.append(element('h3', '', 'Site permissions'), element('p', 'settings-note', 'General area only blocks precise location and allows approximate requests where supported. Sites can also estimate your area from your IP. Camera, microphone, notifications and clipboard access ask once per site and remember your choice. Only the tab you control can request access.'));
  const locationRow = element('div', 'setting-row'); locationRow.append(element('span', '', 'Location requests'));
  const location = element('select'); location.setAttribute('aria-label', 'Default location access');
  for (const [value, label] of [['approximate', 'General area only'], ['block', 'Block device location'], ['ask', 'Ask once for precise location']]) { const option = element('option', '', label); option.value = value; option.selected = state.locationDefault === value; location.append(option); }
  location.onchange = () => command('settings', { locationDefault:location.value }); locationRow.append(location); body.append(locationRow);
  const field = element('div', 'field'), label = element('label', '', 'Add a site permission'), input = element('input');
  input.id = 'permission-origin'; label.htmlFor = input.id; input.placeholder = 'https://www.google.com';
  const permission = element('select'); permission.setAttribute('aria-label', 'Site permission type');
  for (const [value, label] of Object.entries(permissionLabels)) { const option = element('option', '', label); option.value = value; permission.append(option); }
  const decision = permissionChoice('block', () => {}); decision.setAttribute('aria-label', 'Site permission setting');
  const save = element('button', 'secondary-button', 'Save site permission');
  save.onclick = async () => { const result = await command('set-site-permission', { origin:input.value.trim(), permission:permission.value, decision:decision.value }); if (result) { input.value = ''; toast('Site permission saved. Reload the site to apply it.'); } };
  field.append(label, input, permission, decision, save); body.append(field);
  const list = element('div'); list.id = 'site-permissions'; body.append(list); renderSitePermissions();
  const reset = element('button', 'secondary-button', 'Reset browser permissions'); reset.onclick = () => command('reset-site-permissions'); body.append(reset, element('hr', 'section-divider'));
}
function showSettings() {
  openModal('Workspace settings');
  const body = $('modal-body'), field = element('div', 'field');
  body.append(element('h3', '', 'Telegram bots'));
  body.append(element('p', 'settings-note', 'Choose which bots appear in your sidebar. Changes save immediately. Drag visible bots in the sidebar to sort them.'));
  const bots = element('div', 'settings-bots'); bots.id = 'settings-bots';
  body.append(bots); renderSettingsBots();
  body.append(element('p', 'settings-note', 'Hiding a bot only changes this app. Its Telegram chat, messages and Hermes agent stay available.'), element('hr', 'section-divider'));
  const avatars = element('button', 'secondary-button', 'Customize bot avatars');
  avatars.onclick = () => showAvatarEditor(); body.append(avatars);
  body.append(element('p', 'settings-note', 'Pick a marble avatar or import your own. Eyes follow your mouse only while Telegram reports activity.'), element('hr', 'section-divider'));
  showSitePermissionSettings(body);
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
  body.append(element('p', 'settings-note', 'Shared tabs use the same page and control state. Grants apply to this browser tab. The general VPS desktop viewer remains shared.'), save);
}
$('search-toggle').onclick = () => { $('bot-search').classList.toggle('hidden'); if (!$('bot-search').classList.contains('hidden')) $('bot-search').focus(); else { $('bot-search').value = ''; renderBots(); } };
$('bot-search').oninput = renderBots;
$('add-bot').onclick = showAddBot;
$('restore-bots').onclick = () => command('restore-bots');
$('settings-button').onclick = showSettings;
$('presence-avatar').onclick = () => showAvatarEditor();
$('chat-avatar').onclick = () => showAvatarEditor();
$('chat-avatar').onkeydown = (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); showAvatarEditor(); } };
$('computer-button').onclick = () => command('activate', { id: 'vps' });
$('home-vps').onclick = () => command('activate', { id: 'vps' });
$('new-tab').onclick = async () => { await command('create-tab'); $('address').focus(); };
$('all-agent-tabs').onclick=()=>command('settings',{allAgentTabs:!state.allAgentTabs});
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
api.onPointer?.(point => window.HermesAvatars.receivePointer(point));
api.onFocusAddress(() => { $('address').focus(); $('address').select(); });
api.onSettings?.(showSettings);
api.onFocusWorkspace?.(() => { focusMode = !focusMode; $('shell').classList.toggle('focus-workspace', focusMode); scheduleLayout(); });
new ResizeObserver(scheduleLayout).observe($('shell'));
window.addEventListener('resize', scheduleLayout);
api.getState().then(render).catch((error) => toast(error.message));
