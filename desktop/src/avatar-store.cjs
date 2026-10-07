const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const LIMIT = 40;
const AVATAR_SCHEME = 'hw-avatar';
function normalizeEyes(value) {
  const number = (value, fallback, min, max) => Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
  const point = (value, x) => ({ x: number(value?.x, x, 0, 1), y: number(value?.y, 0.4, 0, 1), scaleX: number(value?.scaleX, 1, 0.5, 1.5) });
  return { enabled: value?.enabled === true, left: point(value?.left, 0.4), right: point(value?.right, 0.6),
    radius: number(value?.radius, 0.025, 0.005, 0.12), aspect: number(value?.aspect, 1.6, 0.5, 3), style: value?.style === 'obsidian' ? 'obsidian' : 'classic' };
}

function createAvatarStore({ root, nativeImage, dialog, getWindow, getPreferences }) {
  let builtins;
  function library() {
    if (!builtins) {
      const manifest = JSON.parse(fs.readFileSync(path.join(root, '../assets/avatars/manifest.json'), 'utf8'));
      builtins = manifest.map(item => ({ id: item.id, name: item.name, builtIn: true, cutout: item.cutout === true,
        dataUrl: `../assets/avatars/${path.basename(item.file)}`, eyes: normalizeEyes(item.eyes) }));
    }
    return [...builtins, ...(getPreferences().avatarLibrary || [])];
  }
  // State goes to two renderers on every change, so images stay out of it:
  // they are served once per id by the hw-avatar protocol and cached by the
  // renderer.
  function publicLibrary() {
    return library().map(item => item.builtIn ? item : { ...item, dataUrl: `${AVATAR_SCHEME}://library/${item.id}` });
  }
  const botVersions = new Map();
  function publicBots() {
    return (getPreferences().bots || []).map(bot => {
      if (!bot.avatar) { botVersions.delete(bot.id); return bot; }
      let known = botVersions.get(bot.id);
      if (known?.avatar !== bot.avatar) { known = { avatar: bot.avatar, version: crypto.createHash('sha1').update(bot.avatar).digest('hex').slice(0, 10) }; botVersions.set(bot.id, known); }
      return { ...bot, avatar: `${AVATAR_SCHEME}://bot/${bot.id}?v=${known.version}` };
    });
  }
  function imageFor(href) {
    let url;
    try { url = new URL(href); } catch { return null; }
    if (url.protocol !== `${AVATAR_SCHEME}:`) return null;
    const id = decodeURIComponent(url.pathname.replace(/^\//, ''));
    const prefs = getPreferences();
    const stored = url.hostname === 'library' ? prefs.avatarLibrary?.find(item => item.id === id)?.dataUrl
      : url.hostname === 'bot' ? prefs.bots?.find(bot => bot.id === id)?.avatar : '';
    const match = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(stored || '');
    return match ? { mime: match[1], data: Buffer.from(match[2], 'base64') } : null;
  }
  function set(value) {
    const prefs = getPreferences(), id = String(value.id);
    if (!prefs.bots.some(bot => bot.id === id)) throw new Error('Choose a Telegram bot first.');
    if (value.selectedId !== 'telegram' && !library().some(item => item.id === value.selectedId)) throw new Error('Choose an available avatar.');
    prefs.avatarPreferences ||= {};
    prefs.avatarPreferences[id] = { selectedId: value.selectedId, eyes: normalizeEyes(value.eyes) };
  }
  async function importFiles() {
    const prefs = getPreferences();
    const accountId = prefs.accountId;
    const result = await dialog.showOpenDialog(getWindow(), { title: 'Import bot avatars', properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
    if (result.canceled) return;
    const existing = prefs.avatarLibrary || [];
    if (existing.length + result.filePaths.length > LIMIT) throw new Error(`Keep up to ${LIMIT} imported avatars. Remove one before importing more.`);
    const imported = [];
    for (const file of result.filePaths) {
      if (fs.statSync(file).size > 20 * 1024 * 1024) throw new Error('Choose images smaller than 20 MB.');
      const image = nativeImage.createFromPath(file);
      if (image.isEmpty()) throw new Error(`Could not read ${path.basename(file)}. Choose a PNG, JPEG or WebP image.`);
      const size = image.getSize(), edge = Math.min(size.width, size.height);
      const square = image.crop({ x: Math.floor((size.width - edge) / 2), y: Math.floor((size.height - edge) / 2), width: edge, height: edge });
      const dataUrl = square.resize({ width: Math.min(edge, 384), quality: 'best' }).toDataURL();
      imported.push({ id: `custom-${crypto.randomUUID()}`, name: path.basename(file, path.extname(file)).slice(0, 70), dataUrl, eyes: normalizeEyes(null) });
    }
    // Account switches while the native picker is open must not write into another account.
    if (accountId !== getPreferences().accountId) throw new Error('Telegram account changed. Import again in the current account.');
    prefs.avatarLibrary = [...existing, ...imported];
  }
  function remove(avatarId) {
    const prefs = getPreferences();
    if (library().some(item => item.id === avatarId && item.builtIn)) throw new Error('Built-in avatars stay in the gallery.');
    prefs.avatarLibrary = (prefs.avatarLibrary || []).filter(item => item.id !== avatarId);
    for (const [id, config] of Object.entries(prefs.avatarPreferences || {})) {
      if (config.selectedId === avatarId) delete prefs.avatarPreferences[id];
    }
  }
  return { library, publicLibrary, publicBots, imageFor, set, importFiles, remove };
}
module.exports = { createAvatarStore, normalizeEyes, AVATAR_SCHEME };
