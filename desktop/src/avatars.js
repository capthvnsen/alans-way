(function (root) {
  'use strict';

  const DEFAULT_EYES = { enabled: false, style: 'classic', radius: 0.045, aspect: 1, left: { x: 0.37, y: 0.43, scaleX: 1, scaleY: 1, rotate: 0 }, right: { x: 0.63, y: 0.43, scaleX: 1, scaleY: 1, rotate: 0 },
    travel: { left: 0.02, right: 0.02, up: 0.012, down: 0.016 } };
  const TINTS = ['none', 'red', 'blue', 'yellow'];
  const bounded = (value, min, max, fallback) => typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
  const normalizeTint = (value) => TINTS.includes(value) ? value : 'none';

  // Geometry is fractions of the image: an eye is an ellipse of radius * scaleX by radius * aspect * scaleY,
  // tilted `rotate` degrees. `travel` is how far the eyes may move from rest on each side, so they stay on the face.
  function normalizeEyes(value) {
    const source = value && typeof value === 'object' ? value : {};
    const point = (side) => ({
      x: bounded(source[side]?.x, 0.05, 0.95, DEFAULT_EYES[side].x),
      y: bounded(source[side]?.y, 0.05, 0.95, DEFAULT_EYES[side].y),
      scaleX: bounded(source[side]?.scaleX, 0.5, 1.5, 1),
      scaleY: bounded(source[side]?.scaleY, 0.5, 1.5, 1),
      rotate: bounded(source[side]?.rotate, -45, 45, 0),
    });
    const reach = (edge) => bounded(source.travel?.[edge], 0, 0.05, DEFAULT_EYES.travel[edge]);
    return { enabled: source.enabled === true, style: source.style === 'obsidian' ? 'obsidian' : 'classic',
      radius: bounded(source.radius, 0.008, 0.12, DEFAULT_EYES.radius),
      aspect: bounded(source.aspect, 0.5, 3, 1), left: point('left'), right: point('right'),
      travel: { left: reach('left'), right: reach('right'), up: reach('up'), down: reach('down') } };
  }

  function isActive(activity, now = Date.now()) {
    return activity?.state === 'active' && (activity.expiresAt === undefined || (Number.isFinite(activity.expiresAt) && activity.expiresAt > now));
  }

  function activityLabel(activity, now = Date.now()) {
    if (isActive(activity, now)) return activity.label || 'Activity detected';
    if (activity?.state === 'idle' || (activity?.state === 'active' && Number.isFinite(activity.expiresAt) && activity.expiresAt <= now)) return 'Idle · no live activity signal';
    return 'Activity unavailable';
  }

  function resolveAvatar(bot, state, override) {
    const preference = override || state?.avatarPreferences?.[bot?.id] || {};
    const entry = (state?.avatarLibrary || []).find((item) => item.id === preference.selectedId);
    // The marble PNGs have no eyes of their own, so a bot's saved calibration never overrides the manifest.
    const eyes = entry?.builtIn === true ? normalizeEyes({ ...entry.eyes, enabled: true }) : normalizeEyes(preference.eyes || entry?.eyes);
    return { selectedId: entry?.id || 'telegram', src: entry?.dataUrl || bot?.avatar || '',
      name: entry?.name || 'Telegram picture', cutout: entry?.cutout === true, builtIn: entry?.builtIn === true, tint: normalizeTint(preference.tint), eyes, entry };
  }

  // Return a bounded direction in an ellipse. Coordinates are CSS pixels in the
  // workspace renderer, including when the pointer is over a native child view.
  function gazeOffset(pointer, center, travelX, travelY, sensitivity = 100) {
    if (!pointer || ![pointer.x, pointer.y, center.x, center.y].every(Number.isFinite)) return { x: 0, y: 0 };
    const dx = pointer.x - center.x, dy = pointer.y - center.y;
    const distance = Math.hypot(dx, dy), divisor = Math.max(distance, sensitivity, 1);
    return { x: dx / divisor * travelX, y: dy / divisor * travelY };
  }

  // Move `current` towards `target` with a time constant of `tau` ms. Exact for any step size, never overshoots.
  function easeGaze(current, target, dt, tau) {
    const k = 1 - Math.exp(-Math.max(dt, 0) / tau);
    return { x: current.x + (target.x - current.x) * k, y: current.y + (target.y - current.y) * k };
  }

  // Where one eye sits for a gaze `look` (unit disk) and eyelid closure `blink` (0 open, 1 shut):
  // a shift as a percentage of the eye's own box, so no layout is needed to place it.
  function eyePose(eyes, side, look, blink = 0) {
    const finite = look && Number.isFinite(look.x) && Number.isFinite(look.y) ? look : { x: 0, y: 0 };
    const length = Math.hypot(finite.x, finite.y), k = length > 1 ? 1 / length : 1;
    const x = finite.x * k, y = finite.y * k, point = eyes[side];
    const reachX = x * (x > 0 ? eyes.travel.right : eyes.travel.left), reachY = y * (y > 0 ? eyes.travel.down : eyes.travel.up);
    return { x: reachX / (2 * eyes.radius * point.scaleX) * 100, y: reachY / (2 * eyes.radius * eyes.aspect * point.scaleY) * 100,
      scaleY: 1 - 0.92 * bounded(blink, 0, 1, 0) };
  }

  // A working bot's gaze: unhurried glances between a few spots (often back to centre), a faint continuous
  // drift, and blinks at irregular intervals, now and then a double. Returns a sampler of (ms) => { x, y, blink }.
  function createWander(random = Math.random) {
    const between = (low, high) => low + (high - low) * random();
    let glanceAt, blinkAt, blinkFrom = -Infinity, blinkFor = 150, target = { x: 0, y: 0 };
    return (now) => {
      if (glanceAt === undefined) { glanceAt = now + between(500, 1600); blinkAt = now + between(1200, 3200); }
      if (now >= glanceAt) {
        const angle = between(0, 2 * Math.PI), reach = between(0.35, 0.85);
        target = random() < 0.3 ? { x: 0, y: 0 } : { x: Math.cos(angle) * reach, y: Math.sin(angle) * reach * 0.7 };
        glanceAt = now + between(900, 2800);
      }
      if (now >= blinkAt) {
        blinkFrom = now; blinkFor = between(120, 190);
        blinkAt = now + (random() < 0.18 ? blinkFor + between(60, 140) : between(2400, 6500));
      }
      const t = (now - blinkFrom) / blinkFor;
      return { x: target.x + 0.06 * Math.sin(now / 1700) + 0.04 * Math.sin(now / 713 + 1), y: target.y + 0.05 * Math.sin(now / 1130 + 2),
        blink: t >= 0 && t < 1 ? Math.sin(Math.PI * t) : 0 };
    };
  }

  const exported = { normalizeEyes, normalizeTint, TINTS, isActive, activityLabel, resolveAvatar, gazeOffset, easeGaze, eyePose, createWander };
  if (typeof module === 'object' && module.exports) module.exports = exported;
  if (!root?.document) return;

  const document = root.document;
  let currentState = {}, expireTimer, scheduledExpiry = Infinity, frameId = 0, lastFrame = 0, hoverRow, hoverRecord;
  const mounted = new Map(), editors = new Set(), live = new Set();
  const reduceMotion = root.matchMedia('(prefers-reduced-motion: reduce)');
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function button(text, className, action) {
    const node = element('button', className, text); node.type = 'button'; node.onclick = action; return node;
  }
  function initial(bot) { return (bot?.name || '◔').split(/\s+/).map((word) => word[0]).slice(0, 2).join('').toUpperCase(); }

  function drawEyes(face, eyes) {
    if (!eyes.enabled) return [];
    return ['left', 'right'].map((side) => {
      const point = eyes[side], eye = element('span', `hermes-eye hermes-eye-${eyes.style}`);
      eye.dataset.side = side;
      eye.style.left = `${point.x * 100}%`; eye.style.top = `${point.y * 100}%`;
      eye.style.width = `${eyes.radius * 200 * point.scaleX}%`; eye.style.height = `${eyes.radius * 200 * eyes.aspect * point.scaleY}%`;
      eye.setAttribute('aria-hidden', 'true');
      // Flat eyes are the shape itself and move as a whole; classic eyes keep a pupil that moves inside.
      let pupil;
      if (eyes.style === 'classic') { pupil = element('span', 'hermes-pupil'); eye.append(pupil); }
      face.append(eye);
      return { eye, pupil, side };
    });
  }

  // Placement is transform-only, so moving eyes never touches layout.
  function pose(record) {
    const { look, blink, config } = record;
    for (const { eye, pupil, side } of record.eyes) {
      const rotate = `rotate(${config[side].rotate}deg)`;
      if (pupil) {
        const x = Math.max(-1, Math.min(1, look.x)), y = Math.max(-1, Math.min(1, look.y));
        eye.style.transform = `translate(-50%, -50%) ${rotate} scale(1, ${eyePose(config, side, look, blink).scaleY.toFixed(3)})`;
        pupil.style.transform = `translate(calc(-50% + ${(x * 47).toFixed(1)}%), calc(-50% + ${(y * 36).toFixed(1)}%))`;
      } else {
        const place = eyePose(config, side, look, blink);
        eye.style.transform = `translate(calc(-50% + ${place.x.toFixed(2)}%), calc(-50% + ${place.y.toFixed(2)}%)) ${rotate} scale(1, ${place.scaleY.toFixed(3)})`;
      }
    }
  }
  function rest(record) {
    live.delete(record);
    if (record.look.x || record.look.y || record.blink) { record.look = { x: 0, y: 0 }; record.blink = 0; pose(record); }
  }

  function frame(now) {
    frameId = 0;
    if (document.hidden) return;
    const dt = lastFrame ? Math.min(now - lastFrame, 64) : 16;
    lastFrame = now;
    for (const record of live) {
      if (!record.node.isConnected || reduceMotion.matches) { rest(record); continue; }
      let target = { x: 0, y: 0 }, blink = 0;
      if (record.working) { const sample = record.wander(now); target = sample; blink = sample.blink; }
      if (record.hoverTarget) target = record.hoverTarget;
      record.look = easeGaze(record.look, target, dt, record.hoverTarget ? 90 : 160);
      record.blink = blink;
      pose(record);
      if (!record.working && !record.hoverTarget && Math.hypot(record.look.x, record.look.y) < 0.004) rest(record);
    }
    if (live.size) frameId = root.requestAnimationFrame(frame);
  }
  function wake(record) {
    if (!record.eyes.length || reduceMotion.matches) return;
    live.add(record);
    if (!frameId && !document.hidden) { lastFrame = 0; frameId = root.requestAnimationFrame(frame); }
  }

  function setActivity(record) {
    const active = isActive(record.bot?.activity);
    record.node.classList.toggle('hermes-avatar-active', active);
    const activity = record.bot?.activity;
    const idle = activity?.state === 'idle' || (activity?.state === 'active' && Number.isFinite(activity.expiresAt) && activity.expiresAt <= Date.now());
    record.node.dataset.activity = active ? 'active' : idle ? 'idle' : 'unknown';
    if (!record.decorative) {
      record.node.title = `${record.bot?.name || 'Telegram'} · ${activityLabel(record.bot?.activity)}`;
      record.node.setAttribute('aria-label', record.node.title);
    }
    // The same live-activity signal that lights the avatar ring is what makes the eyes wander. Idle eyes are still.
    record.working = active && !reduceMotion.matches;
    if (record.working) { record.wander ||= createWander(); wake(record); }
    else if (!record.hoverTarget) rest(record);
  }

  function paint(node, bot, state = currentState, override, options = {}) {
    if (!node) return;
    const avatar = resolveAvatar(bot, state, override);
    const signature = JSON.stringify([avatar.src, avatar.cutout, avatar.eyes, initial(bot)]);
    let record = mounted.get(node);
    if (!record || record.signature !== signature || record.face.parentElement !== node) {
      live.delete(record);
      const face = element('span', 'hermes-avatar-face');
      face.append(element('span', 'hermes-avatar-initial', initial(bot)));
      if (avatar.src) {
        const image = element('img'); image.alt = ''; image.draggable = false;
        image.onload = () => face.classList.add('has-image');
        image.onerror = () => {
          image.remove(); face.classList.remove('has-image');
          if (face.parentElement === node) node.classList.remove('hermes-avatar-cutout');
          face.querySelectorAll('.hermes-eye').forEach((eye) => eye.remove());
        };
        image.src = avatar.src;
        face.append(image);
      }
      const ring = element('span', 'hermes-avatar-ring'); ring.setAttribute('aria-hidden', 'true');
      node.classList.add('hermes-avatar'); node.classList.toggle('hermes-avatar-cutout', avatar.cutout); node.replaceChildren(face, ring);
      record = { node, face, signature, bot, override, eyes: avatar.src ? drawEyes(face, avatar.eyes) : [], config: avatar.eyes, look: { x: 0, y: 0 }, blink: 0 };
      pose(record);
      mounted.set(node, record);
    }
    record.bot = bot; record.override = override; record.decorative = options.decorative === true;
    // Only the marble busts are tinted; photos and imported pictures render as they always did.
    if (avatar.cutout && avatar.tint !== 'none') node.dataset.tint = avatar.tint; else delete node.dataset.tint;
    setActivity(record);
    const expiry = bot?.activity?.expiresAt;
    if (isActive(bot?.activity) && Number.isFinite(expiry) && expiry < scheduledExpiry) {
      clearTimeout(expireTimer); scheduledExpiry = expiry;
      expireTimer = root.setTimeout(pruneAndExpire, Math.max(16, expiry - Date.now() + 5));
    }
    return node;
  }

  // The pointer over a bot's own row in the list makes that bot's eyes look at it.
  function aim(record, x, y) {
    const rect = record.face.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const { left, right } = record.config;
    const centre = { x: rect.x + rect.width * (left.x + right.x) / 2, y: rect.y + rect.height * (left.y + right.y) / 2 };
    record.hoverTarget = gazeOffset({ x, y }, centre, 1, 1, Math.max(20, rect.width * 0.65));
    wake(record);
  }
  function releaseHover() {
    if (hoverRecord) { hoverRecord.hoverTarget = null; wake(hoverRecord); }
    hoverRow = hoverRecord = undefined;
  }
  function hoverRowAt(event) {
    const row = event.target.closest?.('.bot-row');
    if (row !== hoverRow) { releaseHover(); hoverRow = row; hoverRecord = row && mounted.get(row.querySelector('.hermes-avatar')); }
    if (hoverRecord?.eyes.length && !reduceMotion.matches) aim(hoverRecord, event.clientX, event.clientY);
  }
  // The workspace also reports the pointer while it is over native child views (where DOM events do not
  // arrive): once it is outside the list, nothing is hovered.
  function receivePointer(point) {
    if (!hoverRow || !point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    const rect = hoverRow.parentElement?.getBoundingClientRect();
    if (!rect || point.x < rect.left || point.x > rect.right || point.y < rect.top || point.y > rect.bottom) releaseHover();
  }
  function pruneAndExpire() {
    clearTimeout(expireTimer);
    scheduledExpiry = Infinity;
    let nextExpiry = Infinity;
    for (const [node, record] of mounted) {
      if (!node.isConnected) { mounted.delete(node); live.delete(record); continue; }
      setActivity(record);
      const expiry = record.bot?.activity?.expiresAt;
      if (isActive(record.bot?.activity) && Number.isFinite(expiry)) nextExpiry = Math.min(nextExpiry, expiry);
    }
    for (const editor of editors) {
      if (!editor.body.isConnected) editors.delete(editor);
      else editor.refresh();
    }
    if (Number.isFinite(nextExpiry)) {
      clearTimeout(expireTimer);
      scheduledExpiry = nextExpiry;
      expireTimer = root.setTimeout(pruneAndExpire, Math.max(16, nextExpiry - Date.now() + 5));
    }
  }
  function update(state) {
    currentState = state;
    for (const [node, record] of mounted) {
      if (!node.isConnected) { mounted.delete(node); live.delete(record); continue; }
      const bot = state.bots?.find((item) => item.id === record.bot?.id);
      if (bot) paint(node, bot, state, record.override, { decorative: record.decorative });
    }
    pruneAndExpire();
  }

  function mountEditor(body, options) {
    const command = options.command, notify = options.toast || (() => {});
    let botId = options.botId || currentState.selectedBotId || currentState.bots?.[0]?.id;
    let draft, placement = 'left', librarySignature = '', saving = false;
    const wrap = element('div', 'avatar-editor'); body.append(wrap);
    const selectorLabel = element('label', 'avatar-field-label', 'Choose a bot');
    const selector = element('select', 'avatar-select'); selector.id = 'avatar-bot-select'; selectorLabel.htmlFor = selector.id;
    for (const bot of currentState.bots || []) { const option = element('option', '', bot.name); option.value = bot.id; selector.append(option); }
    selector.value = botId || '';
    wrap.append(selectorLabel, selector);
    if (!currentState.bots?.length) { wrap.append(element('p', 'settings-note', 'Sign in to Telegram to customize your bots.')); return; }

    const stage = element('div', 'avatar-stage'), preview = element('div', 'avatar-editor-preview');
    const previewCopy = element('div', 'avatar-preview-copy'), live = element('span', 'avatar-live-label');
    previewCopy.append(element('span', 'avatar-eyebrow', 'LIVE PREVIEW'), live,
      element('p', 'settings-note', 'The glow and the wandering eyes run only while a live bot activity signal is present, and the eyes look at your pointer while it is over this bot’s row in the list. Idle stays still.'));
    stage.append(preview, previewCopy); wrap.append(stage);

    const libraryHeading = element('div', 'avatar-library-heading');
    const importButton = button('Import pictures…', 'secondary-button', async () => {
      importButton.disabled = true;
      try { const next = await command('import-avatars'); if (next) acceptState(next); }
      catch (error) { notify(error.message); }
      finally { importButton.disabled = false; }
    });
    libraryHeading.append(element('h3', '', 'Bot picture'), importButton); wrap.append(libraryHeading);
    const gallery = element('div', 'avatar-gallery'); gallery.setAttribute('aria-label', 'Available bot pictures'); wrap.append(gallery);
    const remove = button('Remove imported picture', 'avatar-remove', async () => {
      remove.disabled = true;
      try { const next = await command('remove-avatar', { avatarId: draft.selectedId }); if (next) { acceptState(next); readDraft(); refreshDraft(); } }
      catch (error) { notify(error.message); }
      finally { remove.disabled = false; }
    });
    wrap.append(remove);

    const tintField = element('div', 'avatar-tint-field'), tintLabel = element('span', 'avatar-field-label', 'Marble tint');
    const tintRow = element('div', 'avatar-tints'); tintRow.setAttribute('role', 'radiogroup'); tintRow.setAttribute('aria-label', 'Marble tint');
    const swatches = TINTS.map((value) => {
      const label = value === 'none' ? 'No tint' : value[0].toUpperCase() + value.slice(1);
      const swatch = button('', 'avatar-swatch', () => chooseTint(value));
      swatch.dataset.tint = value; swatch.title = label; swatch.setAttribute('role', 'radio'); swatch.setAttribute('aria-label', label);
      swatch.onkeydown = (event) => {
        const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
        if (!step) return;
        event.preventDefault();
        const next = swatches[(TINTS.indexOf(value) + step + TINTS.length) % TINTS.length];
        chooseTint(next.dataset.tint); next.focus();
      };
      tintRow.append(swatch); return swatch;
    });
    tintField.append(tintLabel, tintRow); wrap.append(tintField);

    const toggleRow = element('label', 'avatar-eye-toggle'), enabled = element('input'); enabled.type = 'checkbox';
    toggleRow.append(enabled, element('span', '', 'Eyes follow my mouse while this bot is active')); wrap.append(toggleRow);
    const controls = element('details', 'avatar-calibration');
    controls.append(element('summary', '', 'Adjust eye placement and appearance'));
    controls.append(element('p', 'settings-note', 'Select an eye, then click its center on the preview. Use the arrow keys on the preview for fine adjustments.'));
    const eyeButtons = element('div', 'avatar-eye-buttons');
    const left = button('Left eye', 'secondary-button', () => chooseEye('left'));
    const right = button('Right eye', 'secondary-button', () => chooseEye('right'));
    eyeButtons.append(left, right); controls.append(eyeButtons);
    const styleLabel = element('label', 'avatar-field-label', 'Eye appearance'), style = element('select', 'avatar-select'); style.id = 'avatar-eye-style'; styleLabel.htmlFor = style.id;
    for (const [value, label] of [['obsidian', 'Flat black'], ['classic', 'Light eyes with dark pupils']]) { const option = element('option', '', label); option.value = value; style.append(option); }
    controls.append(styleLabel, style);
    function slider(labelText, min, max, step, change) {
      const label = element('label', 'avatar-range-label'), text = element('span', '', labelText), input = element('input'), value = element('output');
      input.type = 'range'; input.min = min; input.max = max; input.step = step; input.setAttribute('aria-label', labelText);
      label.append(text, input, value); controls.append(label);
      input.oninput = () => { change(Number(input.value)); refreshDraft(); };
      return { input, value };
    }
    const size = slider('Eye size', 0.008, 0.12, 0.001, (value) => { draft.eyes.radius = value; });
    const shape = slider('Eye height', 0.5, 3, 0.05, (value) => { draft.eyes.aspect = value; });
    const width = slider('Selected eye width', 0.5, 1.5, 0.02, (value) => { draft.eyes[placement].scaleX = value; });
    wrap.append(controls);
    const footer = element('div', 'avatar-editor-footer'), saved = element('span', 'avatar-save-note');
    const save = button('Save avatar', 'primary-button', async () => {
      saving = true; save.disabled = true; save.textContent = 'Saving…';
      try {
        const next = await command('set-bot-avatar', { id: botId, selectedId: draft.selectedId, eyes: normalizeEyes(draft.eyes), tint: normalizeTint(draft.tint) });
        if (next) { acceptState(next); saved.textContent = 'Saved on this Mac'; notify('Bot picture saved.'); }
      } catch (error) { notify(error.message); }
      finally { saving = false; save.disabled = false; save.textContent = 'Save avatar'; }
    });
    footer.append(saved, save); wrap.append(footer, element('p', 'settings-note', 'These pictures are private to this workspace. Your bot’s Telegram profile picture stays the same.'));

    function bot() { return currentState.bots?.find((item) => item.id === botId); }
    function readDraft() {
      const avatar = resolveAvatar(bot(), currentState);
      draft = { selectedId: avatar.selectedId, eyes: avatar.eyes, tint: avatar.tint };
      saved.textContent = '';
    }
    function chooseTint(value) { draft.tint = value; saved.textContent = 'Unsaved changes'; refreshDraft(); }
    const isMarble = () => currentState.avatarLibrary?.some((item) => item.id === draft.selectedId && item.builtIn === true);
    function acceptState(next) { update(next); options.onState?.(next); }
    function chooseEye(side) { placement = side; refreshDraft(); preview.focus({ preventScroll: true }); }
    function refreshLive() {
      if (!draft || !bot()) return;
      paint(preview, bot(), currentState, draft);
      live.textContent = activityLabel(bot().activity);
      live.classList.toggle('active', isActive(bot().activity));
      preview.querySelectorAll('.hermes-eye').forEach((eye) => eye.classList.toggle('calibrating', draft.eyes.enabled && controls.open && eye.dataset.side === placement));
    }
    function drawGallery() {
      gallery.replaceChildren();
      const entries = [{ id: 'telegram', name: 'Telegram', dataUrl: bot()?.avatar }, ...(currentState.avatarLibrary || [])];
      for (const entry of entries) {
        const tile = button('', 'avatar-choice', () => {
          draft.selectedId = entry.id;
          const savedPreference = currentState.avatarPreferences?.[botId];
          draft.eyes = normalizeEyes(savedPreference?.selectedId === entry.id ? savedPreference.eyes || entry.eyes : entry.eyes);
          saved.textContent = 'Unsaved changes'; refreshDraft();
        });
        tile.dataset.avatarId = entry.id; tile.title = entry.name; tile.setAttribute('aria-label', entry.name);
        const picture = element('span', `avatar-choice-picture${entry.cutout ? ' avatar-choice-cutout' : ''}`);
        paint(picture, { name: bot()?.name, avatar: bot()?.avatar }, currentState, { selectedId: entry.id }, { decorative: true });
        const check = element('span', 'avatar-choice-check', '✓'); check.setAttribute('aria-hidden', 'true');
        tile.append(picture, element('span', 'avatar-choice-name', entry.name), check); gallery.append(tile);
      }
      librarySignature = JSON.stringify([(currentState.avatarLibrary || []).map((entry) => entry.id), botId, bot()?.avatar]);
    }
    function refreshDraft() {
      refreshLive();
      // Marble busts always use the manifest eyes; only imported pictures can be calibrated by hand.
      const marble = isMarble();
      enabled.checked = draft.eyes.enabled; toggleRow.hidden = marble; controls.hidden = marble || !draft.eyes.enabled;
      tintField.hidden = !marble; gallery.dataset.tint = draft.tint;
      swatches.forEach((swatch) => { const on = swatch.dataset.tint === draft.tint; swatch.setAttribute('aria-checked', String(on)); swatch.tabIndex = on ? 0 : -1; });
      const calibrating = !marble && draft.eyes.enabled && controls.open;
      preview.classList.toggle('avatar-calibrating', calibrating);
      preview.tabIndex = calibrating ? 0 : -1;
      preview.setAttribute('role', calibrating ? 'application' : 'img');
      if (calibrating) preview.setAttribute('aria-label', `Position ${placement} eye. Click the preview or use arrow keys. Shift moves faster.`);
      left.setAttribute('aria-pressed', placement === 'left'); right.setAttribute('aria-pressed', placement === 'right');
      style.value = draft.eyes.style; size.input.value = draft.eyes.radius; size.value.textContent = `${Math.round(draft.eyes.radius * 200)}%`;
      shape.input.value = draft.eyes.aspect; shape.value.textContent = `${draft.eyes.aspect.toFixed(2)}×`;
      width.input.value = draft.eyes[placement].scaleX; width.value.textContent = `${draft.eyes[placement].scaleX.toFixed(2)}×`;
      gallery.querySelectorAll('.avatar-choice').forEach((tile) => tile.setAttribute('aria-pressed', String(tile.dataset.avatarId === draft.selectedId)));
      const entry = currentState.avatarLibrary?.find((item) => item.id === draft.selectedId);
      remove.hidden = !entry || entry.builtIn === true;
      const stored = resolveAvatar(bot(), currentState);
      if (!saving) saved.textContent = JSON.stringify(draft) === JSON.stringify({ selectedId: stored.selectedId, eyes: stored.eyes, tint: stored.tint }) ? '' : 'Unsaved changes';
    }
    enabled.onchange = () => { draft.eyes.enabled = enabled.checked; refreshDraft(); };
    controls.ontoggle = refreshDraft;
    style.onchange = () => { draft.eyes.style = style.value; refreshDraft(); };
    preview.onclick = (event) => {
      if (!draft.eyes.enabled || !controls.open) return;
      const rect = preview.getBoundingClientRect();
      draft.eyes[placement].x = bounded((event.clientX - rect.x) / rect.width, 0.05, 0.95, 0.5);
      draft.eyes[placement].y = bounded((event.clientY - rect.y) / rect.height, 0.05, 0.95, 0.5);
      refreshDraft();
    };
    preview.onkeydown = (event) => {
      if (!draft.eyes.enabled || !controls.open || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault(); const point = draft.eyes[placement], step = event.shiftKey ? 0.01 : 0.002;
      const axis = ['ArrowLeft', 'ArrowRight'].includes(event.key) ? 'x' : 'y';
      point[axis] = bounded(point[axis] + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -step : step), 0.05, 0.95, point[axis]); refreshDraft();
    };
    selector.onchange = () => { botId = selector.value; readDraft(); drawGallery(); refreshDraft(); };
    const editor = { body: wrap, refresh() {
      if (!bot()) return;
      if (librarySignature !== JSON.stringify([(currentState.avatarLibrary || []).map((entry) => entry.id), botId, bot()?.avatar])) { drawGallery(); refreshDraft(); }
      else refreshLive();
    } };
    readDraft(); drawGallery(); refreshDraft(); editors.add(editor);
    return () => { editors.delete(editor); mounted.delete(preview); };
  }

  const list = document.getElementById('bot-list');
  list?.addEventListener('pointermove', hoverRowAt, { passive: true });
  list?.addEventListener('pointerleave', releaseHover);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { root.cancelAnimationFrame(frameId); frameId = 0; }
    else if (live.size && !frameId) { lastFrame = 0; frameId = root.requestAnimationFrame(frame); }
  });
  reduceMotion.addEventListener('change', () => { releaseHover(); pruneAndExpire(); });
  root.HermesAvatars = { ...exported, paint, update, receivePointer, mountEditor };
})(typeof window === 'object' ? window : undefined);
