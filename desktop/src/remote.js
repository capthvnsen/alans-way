import RFB from '../node_modules/@novnc/novnc/core/rfb.js';
const api = window.workspace;
const $ = (id) => document.getElementById(id);
let rfb, currentUrl = '', connected = false, state, connectionVersion = 0;
function toSocket(value) {
  const url = new URL(value);
  if (url.protocol === 'https:' || url.protocol === 'http:') {
    const remotePath = url.searchParams.get('path') || 'websockify';
    const prefix = url.pathname.endsWith('/') ? url.pathname : url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1);
    url.pathname = remotePath.startsWith('/') ? remotePath : `${prefix}${remotePath}`;
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'; url.search = '';
  }
  url.hash = ''; return url.href;
}
function status(message) { api.command('remote-status', { status: message }).catch(() => {}); }
function showEmpty(title, message, action = 'Reconnect') {
  $('remote-title').textContent = title; $('remote-message').textContent = message; $('configure').textContent = action; $('remote-empty').classList.remove('hidden');
}
function connect(value) {
  const version = ++connectionVersion;
  rfb?.disconnect(); connected = false; currentUrl = value;
  $('connection-dot').classList.remove('connected');
  if (!value) { showEmpty('Your agent’s computer', 'Connect your VPS to see its desktop here.', 'Connect VPS'); return; }
  showEmpty('Connecting…', 'Opening your VPS desktop through its existing viewer.', 'Connection settings'); status('connecting');
  try {
    rfb = new RFB($('screen'), toSocket(value));
    rfb.scaleViewport = true; rfb.resizeSession = false; rfb.viewOnly = !state?.remoteControl; rfb.background = '#070708';
    rfb.addEventListener('connect', () => {
      if (version !== connectionVersion) return;
      connected = true; $('remote-empty').classList.add('hidden'); $('connection-dot').classList.add('connected'); status('connected'); render(state);
    });
    rfb.addEventListener('disconnect', () => {
      if (version !== connectionVersion) return;
      connected = false; $('connection-dot').classList.remove('connected'); showEmpty('Desktop disconnected', 'Check Tailscale and your desktop viewer, then reconnect.'); status('disconnected');
    });
    rfb.addEventListener('credentialsrequired', () => {
      $('credentials').classList.remove('hidden'); $('vnc-password').focus();
    });
    rfb.addEventListener('securityfailure', () => { if (version === connectionVersion) { showEmpty('Connection needs attention', 'The desktop rejected the connection. Check the viewer URL and credentials.', 'Connection settings'); status('authentication failed'); } });
  } catch (error) { showEmpty('Unable to connect', error.message, 'Connection settings'); status('disconnected'); }
}
function render(next) {
  if (!next) return;
  state = next;
  if (state.remoteUrl !== currentUrl) connect(state.remoteUrl);
  if (rfb) rfb.viewOnly = !state.remoteControl;
  $('control').textContent = state.remoteControl ? 'Control' : 'Watch'; $('control').classList.toggle('controlling', state.remoteControl);
  $('control').disabled = !connected;
  $('control').title = state.remoteControl ? 'Stop sending input to the shared VPS desktop' : 'Enable input · Hermes agents may still use this shared desktop';
  $('remote-hint').textContent = state.remoteControl ? 'Input enabled · shared VPS desktop' : state.activeTabId === 'vps' ? 'Watching · Control enables mouse and keyboard' : 'Watching · click ↗ to expand';
  $('expand').textContent = state.activeTabId === 'vps' ? '↙' : '↗';
  $('expand').title = state.activeTabId === 'vps' ? 'Return to the browser workspace' : 'Expand into a workspace tab';
}
$('control').onclick = () => api.command('remote-control', { enabled: !state.remoteControl });
$('screen').onclick = () => { if (!state.remoteControl && state.activeTabId !== 'vps') api.command('activate', { id: 'vps' }); };
$('credentials').onsubmit = (event) => { event.preventDefault(); rfb?.sendCredentials({ password: $('vnc-password').value }); $('vnc-password').value = ''; $('credentials').classList.add('hidden'); };
$('expand').onclick = () => api.command('activate', { id: state.activeTabId === 'vps' ? state.tabs.at(-1)?.id || 'home' : 'vps' });
$('focus').onclick = async () => { await api.command('activate', { id: 'vps' }); api.command('focus-workspace'); };
$('configure').onclick = () => { if (currentUrl && $('configure').textContent === 'Reconnect') connect(currentUrl); else api.command('open-settings'); };
api.onState(render); api.getState().then((next) => { render(next); if (!currentUrl) showEmpty('Your agent’s computer', 'Connect your VPS to see its desktop here.', 'Connect VPS'); });
