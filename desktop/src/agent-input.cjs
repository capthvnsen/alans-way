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
    if (!value) { host?.remove(); document.getElementById(id + '-hl')?.remove(); return; }
    if (host && !host._root) { host.remove(); host = null; }
    if (!host) {
      host = document.createElement('div'); host.id = id;
      host.setAttribute('aria-hidden', 'true');
      host.style.cssText = 'all:initial!important;position:fixed!important;left:0!important;top:0!important;width:0!important;height:0!important;z-index:2147483647!important;pointer-events:none!important;user-select:none!important;';
      // Closed roots read null through .shadowRoot — keep our own reference.
      host._root = host.attachShadow({ mode: 'closed' });
      host._root.innerHTML = '<style>:host{pointer-events:none;transition:transform .28s cubic-bezier(.3,.9,.4,1)}svg{overflow:visible;filter:drop-shadow(0 0 5px var(--am,#69f5d4)) drop-shadow(0 0 14px var(--am,#69f5d4)) drop-shadow(0 2px 3px #0008)}span{position:absolute;left:19px;top:20px;padding:4px 7px;border:1px solid var(--ab,#a0fff4);border-radius:7px;background:var(--alb,#073b37);color:var(--alf,#d9fff8);font:600 11px/1.2 system-ui;white-space:nowrap;box-shadow:0 2px 8px #0004}.ring{fill:none;stroke:var(--am,#69f5d4);stroke-width:2;opacity:0}:host([data-action="click"]) .ring{animation:tap .48s ease-out}@keyframes tap{from{r:3;opacity:.9}to{r:23;opacity:0}}@media(prefers-reduced-motion:reduce){.ring{animation:none!important}:host{transition:none!important}}</style><svg width="19" height="25" viewBox="0 0 19 25"><circle class="ring" cx="1" cy="1" r="3"/><path d="M1 1v19l5-5 4 9 4-2-4-8h7Z" fill="var(--am,#69f5d4)" stroke="var(--as,#06332c)" stroke-width="1.5" stroke-linejoin="round"/></svg><span></span>';
      document.documentElement.appendChild(host);
    }
    if (value.c) {
      host.style.setProperty('--am', value.c.main); host.style.setProperty('--as', value.c.stroke);
      host.style.setProperty('--alb', value.c.labelBg); host.style.setProperty('--alf', value.c.labelFg); host.style.setProperty('--ab', value.c.border);
    }
    // The element highlight rides the same injection: ref actions flash their
    // target in blue while the cursor travels to it, then the outline fades.
    let box = document.getElementById(id + '-hl');
    if (box && !box._root) { box.remove(); box = null; }
    if (!box) {
      box = document.createElement('div'); box.id = id + '-hl';
      box.setAttribute('aria-hidden', 'true');
      box.style.cssText = 'all:initial!important;position:fixed!important;left:0!important;top:0!important;width:0!important;height:0!important;z-index:2147483646!important;pointer-events:none!important;user-select:none!important;';
      box._root = box.attachShadow({ mode: 'closed' });
      box._root.innerHTML = '<style>div{position:fixed;pointer-events:none;border:2px solid #6f9fff;border-radius:9px;background:#3b82f612;box-shadow:0 0 0 3px #3b82f628,inset 0 0 22px #3b82f61f;opacity:0;transition:opacity .18s ease,left .22s ease,top .22s ease,width .22s ease,height .22s ease}div.on{opacity:1}@media(prefers-reduced-motion:reduce){div{transition:opacity .18s ease!important}}</style><div></div>';
      document.documentElement.appendChild(box);
    }
    host.setAttribute('data-action', value.action);
    host._root.querySelector('span').textContent = value.name || 'Agent';
    const outline = box._root.querySelector('div');
    if (value.hl) {
      outline.style.left = value.hl.x + 'px'; outline.style.top = value.hl.y + 'px';
      outline.style.width = value.hl.width + 'px'; outline.style.height = value.hl.height + 'px';
      outline.classList.add('on');
      clearTimeout(box._hlTimer); box._hlTimer = setTimeout(() => outline.classList.remove('on'), 1600);
    }
    // A passed path tweens the overlay on local rAF while the real pointer
    // stream dispatches separately — per-step evals multiplied renderer
    // round-trips by path length for identical visuals. The returned promise
    // resolves when the glide lands, so callers can order a follow-up click.
    const pts = value.path;
    cancelAnimationFrame(host._raf); clearTimeout(host._glideTimer);
    host._glideResolve?.(); host._glideResolve = null;
    if (pts && pts.length > 1) {
      host.style.setProperty('transition', 'none');
      host.style.setProperty('transform', 'translate(' + pts[0].x + 'px,' + pts[0].y + 'px)', 'important');
      const start = performance.now(), last = pts[pts.length - 1];
      return new Promise(resolve => {
        const land = () => {
          clearTimeout(host._glideTimer); host._glideResolve = null;
          host.style.setProperty('transform', 'translate(' + last.x + 'px,' + last.y + 'px)', 'important');
          host.style.removeProperty('transition'); resolve();
        };
        // Hidden tabs never fire rAF; the timer still lands the overlay on the
        // pointer so a later captureTab screenshot shows the right position.
        host._glideTimer = setTimeout(land, pts.length * 16 + 100);
        host._glideResolve = resolve;
        const tick = () => {
          if (!host.isConnected) return land();
          const i = Math.min((performance.now() - start) / 16, pts.length - 1), i0 = Math.floor(i), f = i - i0;
          const a = pts[i0], b = pts[Math.min(i0 + 1, pts.length - 1)];
          host.style.setProperty('transform', 'translate(' + Math.round(a.x + (b.x - a.x) * f) + 'px,' + Math.round(a.y + (b.y - a.y) * f) + 'px)', 'important');
          if (i < pts.length - 1) host._raf = requestAnimationFrame(tick);
          else land();
        };
        host._raf = requestAnimationFrame(tick);
      });
    }
    host.style.removeProperty('transition');
    host.style.setProperty('transform', 'translate(' + value.x + 'px,' + value.y + 'px)', 'important');
  })()`;
}

// A static inset frame marks a page while an agent holds control. It is
// re-injected after navigation because a new document destroys the overlay.
function tintScript(on) {
  return `(() => {
    const on = ${JSON.stringify(!!on)};
    const id = ${JSON.stringify(CURSOR_ID)} + '-tint';
    let host = document.getElementById(id);
    if (!on) { host?.remove(); return; }
    if (host) return;
    host = document.createElement('div'); host.id = id;
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'all:initial!important;position:fixed!important;left:0!important;top:0!important;width:0!important;height:0!important;z-index:2147483645!important;pointer-events:none!important;user-select:none!important;';
    host.attachShadow({ mode: 'closed' }).innerHTML = '<style>div{position:fixed;inset:0;pointer-events:none;box-shadow:inset 0 0 0 3px rgba(168,233,204,.34),inset 0 -140px 160px -110px rgba(168,233,204,.15);border-radius:2px}</style><div></div>';
    document.documentElement.appendChild(host);
  })()`;
}

// One agent accent so the cursor, page tint, control state and work glow all
// read as the same avatar-glow green everywhere an agent is working.
const AGENT_HUE = 152;
function botAccent(_botId) {
  const hue = AGENT_HUE;
  return { hue, main: `hsl(${hue},75%,62%)`, stroke: `hsl(${hue},60%,26%)`, labelBg: `hsl(${hue},48%,15%)`, labelFg: '#a8e9cc', border: '#a8e9cc' };
}

function cursorPath(from, to) {
  if (!from || from.x === to.x && from.y === to.y) return [to];
  const dx = to.x - from.x, dy = to.y - from.y, distance = Math.hypot(dx, dy);
  const duration = Math.max(60, Math.min(200, 40 + distance * .3));
  const steps = Math.max(2, Math.ceil(duration / 16));
  const bend = Math.min(18, distance * .04) * ((Math.round(from.x + from.y + to.x + to.y) & 1) ? 1 : -1);
  return Array.from({ length: steps }, (_, index) => {
    const t = (index + 1) / steps;
    const eased = t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    const arc = Math.sin(Math.PI * eased) * bend;
    return { x: index === steps - 1 ? to.x : Math.round(from.x + dx * eased - dy / distance * arc),
      y: index === steps - 1 ? to.y : Math.round(from.y + dy * eased + dx / distance * arc) };
  });
}

function createAgentInput({ command, requireActor, botName = () => 'Agent', onBusy = () => {}, delay = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const states = new WeakMap();
  function state(tab) {
    if (!states.has(tab)) states.set(tab, { active: 0, revision: 0 });
    return states.get(tab);
  }
  async function clear(tab) {
    state(tab).revision++;
    tab.agentCursor = null;
    const wc = tab.view.webContents;
    if (wc.isDestroyed()) { tab.focusEmulation = false; return; }
    // Focus emulation is held per tab across actions, so clear() is the
    // teardown that actually releases it.
    if (tab.focusEmulation) {
      tab.focusEmulation = false;
      await command(tab, 'Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {});
    }
    await wc.executeJavaScript(cursorScript(null)).catch(() => {});
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
    if (body.selector !== undefined && (typeof body.selector !== 'string' || !body.selector || body.selector.length > 2000)) throw fail('Provide a CSS selector up to 2,000 characters.');
    if (body.action === 'type' && !body.ref && !body.selector) throw fail('Typing requires an element reference or selector.');
    if (['move', 'click'].includes(body.action) && !body.ref && !body.selector && (!Number.isFinite(body.x) || !Number.isFinite(body.y))) throw fail('Provide a fresh element reference, selector, or viewport x and y coordinates.');
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
    async function cursor(point, action, hl) {
      check();
      tab.agentCursor = { ...point, action, name: botName(botId), c: botAccent(botId), hl: hl || null, updatedAt: Date.now() };
      // The overlay is decoration, never evidence that an action succeeded.
      // A navigation can destroy its context after real input was delivered.
      await wc.executeJavaScript(cursorScript(tab.agentCursor)).catch(() => {});
      check();
    }
    async function moveCursor(point, hl) {
      const path = cursorPath(tab.agentCursor, point);
      check();
      // The overlay glide is one injection animating the same path on rAF;
      // the dispatched stream below keeps its own 16ms pacing without evals.
      const glide = wc.executeJavaScript(cursorScript({ ...point, action: 'move', name: botName(botId), c: botAccent(botId), hl: hl || null, path: path.length > 1 ? path : null })).catch(() => {});
      for (const next of path) {
        if (path.length > 1) { await delay(16); check(); }
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...next, button: 'none', buttons: 0 });
        tab.agentCursor = { ...next, action: 'move', name: botName(botId), c: botAccent(botId), hl: hl || null, updatedAt: Date.now() };
      }
      // A stalled frame must not hang the action — bound the tail wait.
      await Promise.race([glide, delay(path.length * 16 + 150)]);
    }
    own.active++;
    if (own.active === 1) onBusy(tab, true);
    wc.setIgnoreMenuShortcuts(true);
    let succeeded = false;
    try {
      // Focus emulation persists for the tab's agent lifetime; toggling it per
      // action was two CDP round-trips on every dispatch.
      if (!tab.focusEmulation) { tab.focusEmulation = true; await send('Emulation.setFocusEmulationEnabled', { enabled: true }); }
      let point;
      if (body.ref || body.selector) {
        point = await wc.executeJavaScript(`(async () => {
          let el = null;
          try { el = document.querySelector(${JSON.stringify(body.ref ? `[data-hermes-workspace-ref~="${body.ref}"]` : body.selector)}); } catch {}
          if (!el || el.disabled || el.closest('[inert]')) return { fail: 'missing or disabled' };
          el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
          await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
          void el.offsetHeight;
          const r = el.getBoundingClientRect();
          const l = Math.max(0, r.left), t = Math.max(0, r.top), rr = Math.min(innerWidth, r.right), b = Math.min(innerHeight, r.bottom);
          const w = rr - l, h = b - t;
          if (!r.width || !r.height || w <= 0 || h <= 0) return { fail: 'no visible area' };
          let point = null, coveredBy = '';
          for (const [fx, fy] of [[.5,.5],[.5,.25],[.5,.75],[.25,.5],[.75,.5],[.2,.2],[.8,.2],[.2,.8],[.8,.8]]) {
            const x = Math.round(l + w * fx), y = Math.round(t + h * fy);
            const hit = document.elementFromPoint(x, y);
            if (hit && (hit === el || el.contains(hit))) { point = { x, y }; break; }
            if (hit && !coveredBy && !el.contains(hit)) coveredBy = hit.tagName.toLowerCase() + (hit.id ? '#' + hit.id : hit.className && typeof hit.className === 'string' ? '.' + hit.className.trim().split(/\\s+/)[0] : '');
          }
          if (!point) return { fail: coveredBy ? 'covered by ' + coveredBy : 'no clickable point' };
          if (${body.action === 'type' || body.action === 'press'}) {
            if (${body.action === 'type'} && !(el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' && /^(text|search|email|url|tel|password|number)$/.test(el.type)) || el.readOnly) return { fail: 'element cannot accept text' };
            el.focus({ preventScroll: true });
            if (${body.action === 'type'}) {
              if (typeof el.select === 'function') el.select();
              else { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
            }
          }
          return { ...point, hl: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) } };
        })()`);
        check();
        if (!point || point.fail) throw fail(`Element is ${point ? point.fail : 'unavailable'} — request a fresh snapshot or use a different selector.`);
      } else if (body.action === 'move' || body.action === 'click') {
        const viewport = await wc.executeJavaScript('({ width: innerWidth, height: innerHeight })');
        check();
        if (body.x < 0 || body.y < 0 || body.x >= viewport.width || body.y >= viewport.height) throw fail('Pointer coordinates must be inside the tab viewport.');
        point = { x: body.x, y: body.y };
      }
      const hl = point?.hl || null;
      if (point) delete point.hl;
      if (body.action === 'move' || body.action === 'click') {
        await moveCursor(point, hl);
        if (body.action === 'click') {
          const submitClick = (body.ref || body.selector) && await wc.executeJavaScript(`(() => {
            let el = null;
            try { el = document.querySelector(${JSON.stringify(body.ref ? `[data-hermes-workspace-ref~="${body.ref}"]` : body.selector)}); } catch {}
            if (!el?.form) return false;
            const t = (el.type || '').toLowerCase();
            return (el.tagName === 'BUTTON' && (!t || t === 'submit')) || (el.tagName === 'INPUT' && t === 'submit');
          })()`) === true;
          if (submitClick) {
            await wc.executeJavaScript(`(() => {
              const el = document.querySelector(${JSON.stringify(body.ref ? `[data-hermes-workspace-ref~="${body.ref}"]` : body.selector)});
              el.form.requestSubmit();
            })()`);
          } else {
            mouseDown = point;
            await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 });
            await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1 });
            mouseDown = null;
          }
          await cursor(point, 'click', hl);
        }
      } else if (body.action === 'type') {
        // insertText is actual Chromium input (including input/beforeinput).
        // The selection belongs to the agent tab, never the human's focused tab.
        if (body.text) await send('Input.insertText', { text: body.text });
        else await keys(keyboardEvent({ key: 'Backspace' }));
        await cursor(point, 'type', hl);
      } else if (body.action === 'press') {
        await keys(keyEvent);
        if (point || tab.agentCursor) await cursor(point || { x: tab.agentCursor.x, y: tab.agentCursor.y }, 'press', hl);
      } else if (body.action === 'scroll') {
        const viewport = await wc.executeJavaScript('({ width: innerWidth, height: innerHeight })');
        check();
        point = { x: Math.max(0, Math.min(tab.agentCursor?.x ?? 100, viewport.width - 1)), y: Math.max(0, Math.min(tab.agentCursor?.y ?? 100, viewport.height - 1)) };
        await send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: Math.max(-2000, Math.min(2000, body.x || 0)), deltaY: Math.max(-2000, Math.min(2000, body.y || 0)) });
        await cursor(point, 'scroll');
      }
      succeeded = true;
      return { dispatched: true, input: 'tab-cdp', cursor: tab.agentCursor || null };
    } finally {
      if (!wc.isDestroyed()) {
        // Releasing outside the viewport cannot finish a revoked click on its
        // old target. No native input or synthetic retry is used for cleanup.
        if (mouseDown) await command(tab, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: -1, y: -1, button: 'left', buttons: 0, clickCount: 0 }).catch(() => {});
        if (keyDown) { const { text, ...released } = keyDown; await command(tab, 'Input.dispatchKeyEvent', { type: 'keyUp', ...released }).catch(() => {}); }
        // Failures release the per-tab focus hold; success leaves it on until
        // clear() runs on teardown or a control change.
        if (!succeeded && tab.focusEmulation) { tab.focusEmulation = false; await command(tab, 'Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {}); }
        wc.setIgnoreMenuShortcuts(false);
      }
      own.active--;
      if (!own.active) onBusy(tab, false);
    }
  }
  return { perform, clear, isDispatching };
}

module.exports = { createAgentInput, tintScript, botAccent, cursorPath, INPUT_ACTIONS, keyboardEvent };
