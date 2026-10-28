import RFB from '../node_modules/@novnc/novnc/core/rfb.js';
const api = window.workspace;
const $ = (id) => document.getElementById(id);
let rfb, currentUrl = '', connected = false, state, connectionVersion = 0, reconnectTimer, retryNow;
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
function hasFrame() {
  const canvas = $('screen').querySelector('canvas');
  if (!canvas?.width || !canvas.height) return false;
  try {
    // shortcut: opaque pixels mark first paint; use a frame event if the viewer adds one.
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 3; i < pixels.length; i += 4) if (pixels[i]) return true;
  } catch {}
  return false;
}
function connect(value, retryAttempt = 0, frameRetried = false) {
  const version = ++connectionVersion;
  let retryAllowed = true;
  clearTimeout(reconnectTimer);
  retryNow = undefined;
  rfb?.disconnect(); connected = false; currentUrl = value;
  $('credentials').classList.add('hidden'); $('vnc-password').value = '';
  $('connection-dot').classList.remove('connected');
  if (!value) { showEmpty('Your agent’s computer', 'Connect your VPS to see its desktop here.', 'Connect VPS'); return; }
  showEmpty('Connecting…', 'Opening your VPS desktop through its existing viewer.', 'Connection settings'); status('connecting');
  try {
    rfb = new RFB($('screen'), toSocket(value));
    rfb.scaleViewport = true; rfb.resizeSession = false; rfb.focusOnClick = true; rfb.viewOnly = !state?.remoteControl; rfb.background = '#070708';
    rfb.addEventListener('connect', () => {
      if (version !== connectionVersion) return;
      retryAllowed = true; retryAttempt = 0; retryNow = undefined; clearTimeout(reconnectTimer);
      connected = true; $('remote-empty').classList.add('hidden'); $('connection-dot').classList.add('connected'); status('connected'); render(state);
      if (retryAllowed) reconnectTimer = setTimeout(() => {
        if (version !== connectionVersion || !retryAllowed || !connected || hasFrame()) return;
        if (!frameRetried) connect(currentUrl, 0, true);
        else {
          showEmpty('Desktop has no picture', 'The desktop connected without a picture. Try reconnecting.'); status('no picture');
        }
      }, 2000);
    });
    rfb.addEventListener('disconnect', (event) => {
      if (version !== connectionVersion) return;
      clearTimeout(reconnectTimer);
      retryNow = undefined;
      connected = false; api.command('remote-control',{enabled:false}).catch(()=>{}); $('connection-dot').classList.remove('connected');
      if (event.detail.clean === false && retryAllowed && currentUrl) {
        const backoff = Math.min(30000, 2000 * 2 ** Math.min(retryAttempt, 4));
        const delay = Math.round(Math.min(30000, backoff * (0.8 + Math.random() * 0.4)));
        const nextAttempt = new Date(Date.now() + delay).toLocaleTimeString();
        showEmpty('Reconnecting…', `The desktop connection dropped. Next attempt at ${nextAttempt}.`); status('reconnecting');
        retryNow = () => {
          if (version === connectionVersion && retryAllowed && !connected) connect(currentUrl, retryAttempt + 1, frameRetried);
        };
        reconnectTimer = setTimeout(retryNow, delay);
        return;
      }
      retryAllowed = false;
      showEmpty('Desktop disconnected', 'Check Tailscale and your desktop viewer, then reconnect.'); status('disconnected');
    });
    rfb.addEventListener('credentialsrequired', () => {
      if (version !== connectionVersion) return;
      retryAllowed = false; retryNow = undefined; clearTimeout(reconnectTimer);
      $('credentials').classList.remove('hidden'); $('vnc-password').focus();
    });
    rfb.addEventListener('securityfailure', () => { if (version === connectionVersion) { retryAllowed = false; retryNow = undefined; clearTimeout(reconnectTimer); showEmpty('Connection needs attention', 'The desktop rejected the connection. Check the viewer URL and credentials.', 'Connection settings'); status('authentication failed'); } });
    // A socket can stay open without completing VNC negotiation after sleep.
    reconnectTimer = setTimeout(() => {
      if (version === connectionVersion && retryAllowed && !connected) connect(currentUrl, retryAttempt + 1, frameRetried);
    }, 15000);
  } catch (error) { showEmpty('Unable to connect', error.message, 'Connection settings'); status('disconnected'); }
}
function render(next) {
  if (!next) return;
  const viewerSettingsChanged = state && next.settingsFieldRevisions?.remoteUrl !== state.settingsFieldRevisions?.remoteUrl;
  state = next;
  if (state.remoteUrl !== currentUrl || (viewerSettingsChanged && !connected)) connect(state.remoteUrl);
  if (rfb) { rfb.viewOnly = !state.remoteControl; if(!state.remoteControl)rfb.blur(); }
  $('control').textContent = state.remoteControl ? 'Stop control' : 'Take control'; $('control').classList.toggle('controlling', state.remoteControl);
  $('control').setAttribute('aria-pressed',String(state.remoteControl));
  $('control').disabled = !connected;
  $('remote-name').textContent=state.remotePlatform==='mac'?'Mac VM':'VPS computer';
  $('control').title = state.remoteControl ? 'Return to watch mode' : 'Enable your mouse and keyboard · desktop agents may still be active';
  $('remote-hint').textContent = state.remoteControl ? 'You control this view · click, drag, scroll and type' : state.activeTabId === 'vps' ? 'Watching · click Take control to use your mouse and keyboard' : 'Watching · drag the preview anywhere · Take control for mouse and keyboard';
  $('paste').disabled=!connected || !state.remoteControl;
}
window.addEventListener('online', () => retryNow?.());
window.addEventListener('focus', () => retryNow?.());
document.addEventListener('visibilitychange', () => { if (!document.hidden) retryNow?.(); });
api.onRemoteRetry?.(() => retryNow?.());
$('control').onclick = async () => {
  try {
    if(!state.remoteControl){await api.command('remote-control',{enabled:true});rfb?.focus();}
    else await api.command('remote-control',{enabled:false});
  }catch(error){$('remote-hint').textContent=error.message;}
};
// The guest's primary modifier: Command reaches a macOS guest as Super.
function shortcut(key,shift=false){if(!connected || !state.remoteControl)return;rfb.focus();const mod=state.remotePlatform==='mac'?[0xffeb,'MetaLeft']:[0xffe3,'ControlLeft'];rfb.sendKey(mod[0],mod[1],true);if(shift)rfb.sendKey(0xffe1,'ShiftLeft',true);rfb.sendKey(key.charCodeAt(0),'Key'+key.toUpperCase());if(shift)rfb.sendKey(0xffe1,'ShiftLeft',false);rfb.sendKey(mod[0],mod[1],false);}
api.onRemoteShortcut?.(({key,shift})=>shortcut(key,shift));
$('paste').onclick=async()=>{try{const text=await api.command('remote-paste');rfb.clipboardPasteFrom(text);shortcut('v');}catch(error){$('remote-hint').textContent=error.message;}};
// In watch-mode preview, dragging anywhere in the viewer moves the floating
// window: deltas are relayed to the window renderer, which owns the position.
// Buttons, links and the password form keep their normal behavior.
let pdrag = null, suppressScreenClick = false;
document.addEventListener('pointerdown', (event) => {
  if (!state || state.remoteControl || state.activeTabId === 'vps' || event.target.closest('button, input, a, form')) return;
  // The native view moves underneath the pointer, so use stable screen coordinates.
  pdrag = { x: event.screenX, y: event.screenY, moved: false };
  event.target.setPointerCapture(event.pointerId);
});
document.addEventListener('pointermove', (event) => {
  if (!pdrag) return;
  const dx = event.screenX - pdrag.x, dy = event.screenY - pdrag.y;
  if (!pdrag.moved && Math.hypot(dx, dy) < 4) return;
  pdrag.moved = true; pdrag.x = event.screenX; pdrag.y = event.screenY;
  api.command('preview-nudge', { dx, dy }).catch(() => {});
});
document.addEventListener('pointerup', () => { if (pdrag?.moved) { suppressScreenClick = true; api.command('preview-drop').catch(() => {}); } pdrag = null; });
document.addEventListener('pointercancel', () => { if (pdrag?.moved) api.command('preview-drop').catch(() => {}); pdrag = null; });
$('screen').onclick = () => { if (suppressScreenClick) { suppressScreenClick = false; return; } if (!state.remoteControl && state.activeTabId !== 'vps') api.command('activate', { id: 'vps' }); };
$('credentials').onsubmit = (event) => { event.preventDefault(); rfb?.sendCredentials({ password: $('vnc-password').value }); $('vnc-password').value = ''; $('credentials').classList.add('hidden'); };
$('configure').onclick = () => { if (currentUrl && $('configure').textContent === 'Reconnect') connect(currentUrl); else api.command('open-settings'); };
api.onState(render); api.getState().then((next) => { render(next); if (!currentUrl) showEmpty('Your agent’s computer', 'Connect your VPS to see its desktop here.', 'Connect VPS'); });
