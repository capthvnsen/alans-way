(function (root) {
  'use strict';

  const DEFAULT_EYES = { enabled: false, style: 'classic', radius: 0.045, aspect: 1, left: { x: 0.37, y: 0.43, scaleX: 1 }, right: { x: 0.63, y: 0.43, scaleX: 1 } };
  const bounded = (value, min, max, fallback) => typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;

  function normalizeEyes(value) {
    const source = value && typeof value === 'object' ? value : {};
    const point = (side) => ({
      x: bounded(source[side]?.x, 0.05, 0.95, DEFAULT_EYES[side].x),
      y: bounded(source[side]?.y, 0.05, 0.95, DEFAULT_EYES[side].y),
      scaleX: bounded(source[side]?.scaleX, 0.5, 1.5, 1),
    });
    return { enabled: source.enabled === true, style: source.style === 'obsidian' ? 'obsidian' : 'classic',
      radius: bounded(source.radius, 0.008, 0.12, DEFAULT_EYES.radius),
      aspect: bounded(source.aspect, 0.5, 3, 1), left: point('left'), right: point('right') };
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
    return { selectedId: entry?.id || 'telegram', src: entry?.dataUrl || bot?.avatar || '',
      name: entry?.name || 'Telegram picture', eyes: normalizeEyes(preference.eyes || entry?.eyes), entry };
  }

  // Return a bounded direction in an ellipse. Coordinates are CSS pixels in the
  // workspace renderer, including when the pointer is over a native child view.
  function gazeOffset(pointer, center, travelX, travelY, sensitivity = 100) {
    if (!pointer || ![pointer.x, pointer.y, center.x, center.y].every(Number.isFinite)) return { x: 0, y: 0 };
    const dx = pointer.x - center.x, dy = pointer.y - center.y;
    const distance = Math.hypot(dx, dy), divisor = Math.max(distance, sensitivity, 1);
    return { x: dx / divisor * travelX, y: dy / divisor * travelY };
  }

  const exported = { normalizeEyes, isActive, activityLabel, resolveAvatar, gazeOffset };
  if (typeof module === 'object' && module.exports) module.exports = exported;
  if (!root?.document) return;

  const document = root.document;
  let currentState = {}, lastPointer, pointerFrame = 0, expireTimer, scheduledExpiry = Infinity;
  const mounted = new Map(), editors = new Set();
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
      eye.style.width = `${eyes.radius * 200 * point.scaleX}%`; eye.style.height = `${eyes.radius * 200 * eyes.aspect}%`;
      eye.setAttribute('aria-hidden', 'true');
      const pupil = element('span', 'hermes-pupil'); eye.append(pupil); face.append(eye);
      return { eye, pupil, side };
    });
  }

  function setActivity(record) {
    const active = isActive(record.bot?.activity);
    record.node.classList.toggle('hermes-avatar-active', active);
    const activity = record.bot?.activity;
    const idle = activity?.state === 'idle' || (activity?.state === 'active' && Number.isFinite(activity.expiresAt) && activity.expiresAt <= Date.now());
    record.node.dataset.activity = active ? 'active' : idle ? 'idle' : 'unknown';
    record.node.title = `${record.bot?.name || 'Telegram'} · ${activityLabel(record.bot?.activity)}`;
    record.node.setAttribute('aria-label', record.node.title);
    // Returning to the neutral pose is immediate: idle avatars never keep moving.
    if (!active || reduceMotion.matches) record.eyes.forEach(({ pupil }) => { pupil.style.transform = 'translate(-50%, -50%)'; });
  }

  function paint(node, bot, state = currentState, override) {
    if (!node) return;
    const avatar = resolveAvatar(bot, state, override);
    const signature = JSON.stringify([avatar.src, avatar.eyes, initial(bot)]);
    let record = mounted.get(node);
    if (!record || record.signature !== signature || record.face.parentElement !== node) {
      const face = element('span', 'hermes-avatar-face');
      face.append(element('span', 'hermes-avatar-initial', initial(bot)));
      if (avatar.src) {
        const image = element('img'); image.src = avatar.src; image.alt = ''; image.draggable = false;
        image.onerror = () => { image.remove(); face.querySelectorAll('.hermes-eye').forEach((eye) => eye.remove()); };
        face.append(image);
      }
      const ring = element('span', 'hermes-avatar-ring'); ring.setAttribute('aria-hidden', 'true');
      node.classList.add('hermes-avatar'); node.replaceChildren(face, ring);
      record = { node, face, signature, bot, override, eyes: avatar.src ? drawEyes(face, avatar.eyes) : [], config: avatar.eyes };
      mounted.set(node, record);
    }
    record.bot = bot; record.override = override; setActivity(record);
    const expiry = bot?.activity?.expiresAt;
    if (isActive(bot?.activity) && Number.isFinite(expiry) && expiry < scheduledExpiry) {
      clearTimeout(expireTimer); scheduledExpiry = expiry;
      expireTimer = root.setTimeout(pruneAndExpire, Math.max(16, expiry - Date.now() + 5));
    }
    schedulePointer();
    return node;
  }

  function applyPointer() {
    pointerFrame = 0;
    for (const [node, record] of mounted) {
      if (!node.isConnected) { mounted.delete(node); continue; }
      if (!isActive(record.bot?.activity) || reduceMotion.matches) continue;
      const rect = record.face.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      for (const { pupil, side } of record.eyes) {
        const eye = record.config[side], radius = rect.width * record.config.radius;
        const offset = gazeOffset(lastPointer, { x: rect.x + rect.width * eye.x, y: rect.y + rect.height * eye.y }, radius * eye.scaleX * 0.47, radius * record.config.aspect * 0.40, Math.max(70, rect.width * 0.65));
        pupil.style.transform = `translate(calc(-50% + ${offset.x.toFixed(2)}px), calc(-50% + ${offset.y.toFixed(2)}px))`;
      }
    }
  }
  function schedulePointer() { if (!pointerFrame) pointerFrame = root.requestAnimationFrame(applyPointer); }
  function receivePointer(point) {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    lastPointer = point; schedulePointer();
  }
  function pruneAndExpire() {
    clearTimeout(expireTimer);
    scheduledExpiry = Infinity;
    let nextExpiry = Infinity;
    for (const [node, record] of mounted) {
      if (!node.isConnected) { mounted.delete(node); continue; }
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
      if (!node.isConnected) { mounted.delete(node); continue; }
      const bot = state.bots?.find((item) => item.id === record.bot?.id);
      if (bot) paint(node, bot, state, record.override);
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
      element('p', 'settings-note', 'The ring and gaze move only while a live bot activity signal is present. Idle stays still.'));
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
    for (const [value, label] of [['obsidian', 'Glossy black'], ['classic', 'Light eyes with dark pupils']]) { const option = element('option', '', label); option.value = value; style.append(option); }
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
        const next = await command('set-bot-avatar', { id: botId, selectedId: draft.selectedId, eyes: normalizeEyes(draft.eyes) });
        if (next) { acceptState(next); saved.textContent = 'Saved on this Mac'; notify('Bot picture saved.'); }
      } catch (error) { notify(error.message); }
      finally { saving = false; save.disabled = false; save.textContent = 'Save avatar'; }
    });
    footer.append(saved, save); wrap.append(footer, element('p', 'settings-note', 'These pictures are private to this workspace. Your bot’s Telegram profile picture stays the same.'));

    function bot() { return currentState.bots?.find((item) => item.id === botId); }
    function readDraft() {
      const avatar = resolveAvatar(bot(), currentState);
      draft = { selectedId: avatar.selectedId, eyes: avatar.eyes };
      saved.textContent = '';
    }
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
        const picture = element('span', 'avatar-choice-picture');
        if (entry.dataUrl) { const image = element('img'); image.src = entry.dataUrl; image.alt = ''; picture.append(image); }
        else picture.textContent = initial(bot());
        const check = element('span', 'avatar-choice-check', '✓'); check.setAttribute('aria-hidden', 'true');
        tile.append(picture, element('span', 'avatar-choice-name', entry.name), check); gallery.append(tile);
      }
      librarySignature = JSON.stringify([(currentState.avatarLibrary || []).map((entry) => entry.id), botId, bot()?.avatar]);
    }
    function refreshDraft() {
      refreshLive();
      enabled.checked = draft.eyes.enabled; controls.hidden = !draft.eyes.enabled;
      const calibrating = draft.eyes.enabled && controls.open;
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
      if (!saving) saved.textContent = JSON.stringify(draft) === JSON.stringify({ selectedId: resolveAvatar(bot(), currentState).selectedId, eyes: resolveAvatar(bot(), currentState).eyes }) ? '' : 'Unsaved changes';
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

  document.addEventListener('pointermove', (event) => receivePointer({ x: event.clientX, y: event.clientY }), { passive: true });
  root.addEventListener('resize', schedulePointer);
  document.addEventListener('scroll', schedulePointer, true);
  reduceMotion.addEventListener('change', () => { pruneAndExpire(); schedulePointer(); });
  root.HermesAvatars = { ...exported, paint, update, receivePointer, mountEditor };
})(typeof window === 'object' ? window : undefined);
