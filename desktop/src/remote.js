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
    rfb.scaleViewport = true; rfb.resizeSession = false; rfb.focusOnClick = true; rfb.viewOnly = !state?.remoteControl; rfb.background = '#070708';
    rfb.addEventListener('connect', () => {
      if (version !== connectionVersion) return;
      connected = true; $('remote-empty').classList.add('hidden'); $('connection-dot').classList.add('connected'); status('connected'); render(state);
    });
    rfb.addEventListener('disconnect', () => {
      if (version !== connectionVersion) return;
      connected = false; api.command('remote-control',{enabled:false}).catch(()=>{}); $('connection-dot').classList.remove('connected'); showEmpty('Desktop disconnected', 'Check Tailscale and your desktop viewer, then reconnect.'); status('disconnected');
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
  if (rfb) { rfb.viewOnly = !state.remoteControl; if(!state.remoteControl)rfb.blur(); }
  $('control').textContent = state.remoteControl ? 'Stop control' : 'Take control'; $('control').classList.toggle('controlling', state.remoteControl);
  $('control').setAttribute('aria-pressed',String(state.remoteControl));
  $('control').disabled = !connected;
  $('remote-name').textContent='VPS computer';
  $('control').title = state.remoteControl ? 'Return to watch mode' : 'Enable your mouse and keyboard · desktop agents may still be active';
  $('remote-hint').textContent = state.remoteControl ? 'You control this view · click, drag, scroll and type' : 'Watching · click Take control to use your mouse and keyboard';
  $('paste').disabled=!connected || !state.remoteControl;
  $('expand').textContent = state.activeTabId === 'vps' ? '↙' : '↗';
  $('expand').title = state.activeTabId === 'vps' ? 'Return to the browser workspace' : 'Expand into a workspace tab';
}
$('control').onclick = async () => {
  try {
    if(!state.remoteControl){await api.command('remote-control',{enabled:true});rfb?.focus();}
    else await api.command('remote-control',{enabled:false});
  }catch(error){$('remote-hint').textContent=error.message;}
};
function shortcut(key,shift=false){if(!connected || !state.remoteControl)return;rfb.focus();rfb.sendKey(0xffe3,'ControlLeft',true);if(shift)rfb.sendKey(0xffe1,'ShiftLeft',true);rfb.sendKey(key.charCodeAt(0),'Key'+key.toUpperCase());if(shift)rfb.sendKey(0xffe1,'ShiftLeft',false);rfb.sendKey(0xffe3,'ControlLeft',false);}
api.onRemoteShortcut?.(({key,shift})=>shortcut(key,shift));
$('paste').onclick=async()=>{try{const text=await api.command('remote-paste');rfb.clipboardPasteFrom(text);shortcut('v');}catch(error){$('remote-hint').textContent=error.message;}};
$('screen').onclick = () => { if (!state.remoteControl && state.activeTabId !== 'vps') api.command('activate', { id: 'vps' }); };
$('credentials').onsubmit = (event) => { event.preventDefault(); rfb?.sendCredentials({ password: $('vnc-password').value }); $('vnc-password').value = ''; $('credentials').classList.add('hidden'); };
$('expand').onclick = () => api.command('activate', { id: state.activeTabId === 'vps' ? state.tabs.at(-1)?.id || 'home' : 'vps' });
$('focus').onclick = async () => { await api.command('activate', { id: 'vps' }); api.command('focus-workspace'); };
$('configure').onclick = () => { if (currentUrl && $('configure').textContent === 'Reconnect') connect(currentUrl); else api.command('open-settings'); };
api.onState(render); api.getState().then((next) => { render(next); if (!currentUrl) showEmpty('Your agent’s computer', 'Connect your VPS to see its desktop here.', 'Connect VPS'); });
