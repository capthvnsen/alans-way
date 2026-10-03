// All input stays inside this tab's Chromium target. Never focus a native view,
// activate a window, use the clipboard for typing, or move the system pointer.
const INPUT_ACTIONS = new Set(['move', 'click', 'type', 'press', 'scroll']);
const CURSOR_ID = 'hermes-workspace-agent-cursor';
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

function keyboardEvent(body) {
  if (typeof body.key !== 'string' || !body.key || body.key.length > 30) throw fail('Invalid key.');
  if (body.modifiers !== undefined && (!Array.isArray(body.modifiers) || body.modifiers.some(key => !['alt', 'control', 'meta', 'shift'].includes(key)))) throw fail('Invalid key modifiers.');
  const modifiers = (body.modifiers || []).reduce((bits, key) => bits | ({ alt: 1, control: 2, meta: 4, shift: 8 }[key]), 0);
  const key = ({ Return: 'Enter', Esc: 'Escape', Space: ' ' })[body.key] || body.key;
  const codes = { Enter: 13, Tab: 9, Backspace: 8, Escape: 27, Delete: 46, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35, PageUp: 33, PageDown: 34, ' ': 32 };
  const code = codes[key] || (key.length === 1 ? key.toUpperCase().charCodeAt(0) : /^F(?:[1-9]|1[0-2])$/.test(key) ? 111 + Number(key.slice(1)) : 0);
  if (!code) throw fail('Unsupported key. Use a character, Enter, Tab, Escape, Backspace, Delete, an arrow, Home, End, PageUp, PageDown or F1–F12.');
  return { key, modifiers, windowsVirtualKeyCode: code,
    ...(key === 'Enter' && !(modifiers & 7) ? { text: '\r' } : key.length === 1 && !(modifiers & 7) ? { text: key } : {}) };
}

function cursorScript(cursor) {
  // A closed shadow tree keeps the decorative label out of page snapshots.
  return `(() => {
    const id = ${JSON.stringify(CURSOR_ID)}, value = ${JSON.stringify(cursor)};
    let host = document.getElementById(id);
    if (!value) { host?.remove(); return; }
    if (!host) {
      host = document.createElement('div'); host.id = id;
      host.setAttribute('aria-hidden', 'true');
      host.style.cssText = 'all:initial!important;position:fixed!important;left:0!important;top:0!important;width:0!important;height:0!important;z-index:2147483647!important;pointer-events:none!important;user-select:none!important;';
      const root = host.attachShadow({ mode: 'closed' });
      root.innerHTML = '<style>:host{pointer-events:none}svg{overflow:visible;filter:drop-shadow(0 2px 3px #0008)}span{position:absolute;left:19px;top:20px;padding:4px 7px;border:1px solid #a0fff4;border-radius:7px;background:#073b37;color:#d9fff8;font:600 11px/1.2 system-ui;white-space:nowrap;box-shadow:0 2px 8px #0004}.ring{fill:none;stroke:#69f5d4;stroke-width:2;opacity:0}:host([data-action="click"]) .ring{animation:tap .48s ease-out}@keyframes tap{from{r:3;opacity:.9}to{r:23;opacity:0}}@media(prefers-reduced-motion:reduce){.ring{animation:none!important}}</style><svg width="19" height="25" viewBox="0 0 19 25"><circle class="ring" cx="1" cy="1" r="3"/><path d="M1 1v19l5-5 4 9 4-2-4-8h7Z" fill="#69f5d4" stroke="#06332c" stroke-width="1.5" stroke-linejoin="round"/></svg><span>Agent</span>';
      document.documentElement.appendChild(host);
    }
    host.style.setProperty('transform', 'translate(' + value.x + 'px,' + value.y + 'px)', 'important');
    host.setAttribute('data-action', value.action);
  })()`;
}

function createAgentInput({ command, requireActor }) {
  const states = new WeakMap();
  function state(tab) {
    if (!states.has(tab)) states.set(tab, { active: 0, revision: 0 });
    return states.get(tab);
  }
  async function clear(tab) {
    state(tab).revision++;
    tab.agentCursor = null;
    if (!tab.view.webContents.isDestroyed()) await tab.view.webContents.executeJavaScript(cursorScript(null)).catch(() => {});
  }
  function isDispatching(tab) { return !!tab && (states.get(tab)?.active || 0) > 0; }

  async function perform(tab, body, botId) {
    const wc = tab.view.webContents;
    const own = state(tab), revision = own.revision;
    const check = () => {
      requireActor(tab, botId, body.epoch, true);
      if (own.revision !== revision || wc.isDestroyed()) throw fail('Agent input was cancelled. Request fresh tab state.', 409);
    };
    check();
    if (!INPUT_ACTIONS.has(body.action)) throw fail('Unsupported agent input action.');
    if (body.action === 'type' && (typeof body.text !== 'string' || body.text.length > 20000)) throw fail('Provide text up to 20,000 characters.');
    const keyEvent = body.action === 'press' ? keyboardEvent(body) : null;
    if (body.ref !== undefined && (typeof body.ref !== 'string' || !/^s\d+-\d+$/.test(body.ref) || !tab.refs.has(body.ref))) throw fail('Stale or unknown reference. Request a fresh snapshot.', 409);
    if (body.action === 'type' && !body.ref) throw fail('Typing requires a fresh element reference.');
    if (['move', 'click'].includes(body.action) && !body.ref && (!Number.isFinite(body.x) || !Number.isFinite(body.y))) throw fail('Provide a fresh element reference or viewport x and y coordinates.');
    if (body.action === 'scroll' && [body.x, body.y].some(value => value !== undefined && !Number.isFinite(value))) throw fail('Scroll deltas must be finite numbers.');

    // The API owner serializes perform() with screenshots and navigation in
    // tab.queue. Checks after awaits also stop an already queued revoked action.
    const send = async (method, params) => { check(); const result = await command(tab, method, params); check(); return result; };
    let mouseDown = null, keyDown = null;
    async function keys(event) {
      keyDown = event;
      await send('Input.dispatchKeyEvent', { type: 'keyDown', ...event });
      const { text, ...released } = event;
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...released });
      keyDown = null;
    }
    async function cursor(point, action) {
      check();
      tab.agentCursor = { ...point, action, updatedAt: Date.now() };
      // The overlay is decoration, never evidence that an action succeeded.
      // A navigation can destroy its context after real input was delivered.
      await wc.executeJavaScript(cursorScript(tab.agentCursor)).catch(() => {});
      check();
    }
    own.active++;
    wc.setIgnoreMenuShortcuts(true);
    try {
      await send('Emulation.setFocusEmulationEnabled', { enabled: true });
      let point;
      if (body.ref) {
        point = await wc.executeJavaScript(`(() => {
          const el = document.querySelector(${JSON.stringify(`[data-hermes-workspace-ref="${body.ref}"]`)});
          if (!el || el.disabled || el.closest('[inert]')) return null;
          el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
          const r = el.getBoundingClientRect();
          const x = Math.max(0, r.left) + (Math.min(innerWidth, r.right) - Math.max(0, r.left)) / 2;
          const y = Math.max(0, r.top) + (Math.min(innerHeight, r.bottom) - Math.max(0, r.top)) / 2;
          if (!r.width || !r.height || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return null;
          const hit = document.elementFromPoint(x, y);
          if (!hit || (hit !== el && !el.contains(hit))) return null;
          if (${body.action === 'type' || body.action === 'press'}) {
            if (${body.action === 'type'} && !(el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' && /^(text|search|email|url|tel|password|number)$/.test(el.type)) || el.readOnly) return null;
            el.focus({ preventScroll: true });
            if (${body.action === 'type'}) {
              if (typeof el.select === 'function') el.select();
              else { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
            }
          }
          return { x: Math.round(x), y: Math.round(y) };
        })()`);
        check();
        if (!point) throw fail('Element is unavailable, covered, or cannot accept this input. Request a fresh snapshot.');
      } else if (body.action === 'move' || body.action === 'click') {
        const viewport = await wc.executeJavaScript('({ width: innerWidth, height: innerHeight })');
        check();
        if (body.x < 0 || body.y < 0 || body.x >= viewport.width || body.y >= viewport.height) throw fail('Pointer coordinates must be inside the tab viewport.');
        point = { x: body.x, y: body.y };
      }
      if (body.action === 'move' || body.action === 'click') {
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point, button: 'none', buttons: 0 });
        await cursor(point, 'move');
        if (body.action === 'click') {
          mouseDown = point;
          await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 });
          await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1 });
          mouseDown = null;
          await cursor(point, 'click');
        }
      } else if (body.action === 'type') {
        // insertText is actual Chromium input (including input/beforeinput).
        // The selection belongs to the agent tab, never the human's focused tab.
        if (body.text) await send('Input.insertText', { text: body.text });
        else await keys(keyboardEvent({ key: 'Backspace' }));
        await cursor(point, 'type');
      } else if (body.action === 'press') {
        await keys(keyEvent);
        if (point || tab.agentCursor) await cursor(point || { x: tab.agentCursor.x, y: tab.agentCursor.y }, 'press');
      } else if (body.action === 'scroll') {
        const viewport = await wc.executeJavaScript('({ width: innerWidth, height: innerHeight })');
        check();
        point = { x: Math.min(tab.agentCursor?.x ?? 100, viewport.width - 1), y: Math.min(tab.agentCursor?.y ?? 100, viewport.height - 1) };
        await send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: Math.max(-2000, Math.min(2000, body.x || 0)), deltaY: Math.max(-2000, Math.min(2000, body.y || 0)) });
        await cursor(point, 'scroll');
      }
      return { dispatched: true, input: 'tab-cdp', cursor: tab.agentCursor || null };
    } finally {
      if (!wc.isDestroyed()) {
        // Releasing outside the viewport cannot finish a revoked click on its
        // old target. No native input or synthetic retry is used for cleanup.
        if (mouseDown) await command(tab, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: -1, y: -1, button: 'left', buttons: 0, clickCount: 0 }).catch(() => {});
        if (keyDown) { const { text, ...released } = keyDown; await command(tab, 'Input.dispatchKeyEvent', { type: 'keyUp', ...released }).catch(() => {}); }
        await command(tab, 'Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {});
        wc.setIgnoreMenuShortcuts(false);
      }
      own.active--;
    }
  }
  return { perform, clear, isDispatching };
}

module.exports = { createAgentInput, INPUT_ACTIONS, keyboardEvent };
