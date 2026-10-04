const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const FOLDER = /^ext-[a-f0-9]{32}$/;
function resourcePath(directory, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.includes('\\')) throw new Error('Invalid extension resource.');
  const file = path.resolve(directory, relative);
  if (!file.startsWith(path.resolve(directory) + path.sep)) throw new Error('Extension resources must stay inside their folder.');
  return file;
}
function readManifest(directory) {
  const file = path.join(directory, 'manifest.json');
  if (!fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > 1024 * 1024) throw new Error('Choose an unpacked extension folder containing manifest.json.');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (![2, 3].includes(manifest.manifest_version) || typeof manifest.name !== 'string' || typeof manifest.version !== 'string') throw new Error('This folder does not contain a valid Chrome extension manifest.');
  return manifest;
}
function validateFiles(directory) {
  let bytes = 0, count = 0;
  function visit(folder) {
    for (const name of fs.readdirSync(folder)) {
      const file = path.join(folder, name), stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error('Extension folders cannot contain links or special files.');
      if (++count > 30000 || (bytes += stat.isFile() ? stat.size : 0) > 128 * 1024 * 1024) throw new Error('This extension folder is too large to import.');
      if (stat.isDirectory()) visit(file);
    }
  }
  if (!fs.lstatSync(directory).isDirectory()) throw new Error('Choose an extension folder.');
  visit(directory);
}
function createExtensionStore({ root, session, dialog, nativeImage, getWindow, getPreferences, savePreferences }) {
  const directory = path.join(root, 'browser-extensions'), loaded = new Map(), errors = new Map(), icons = new Map();
  let busy = false;
  const records = () => getPreferences().browserExtensions;
  const folder = key => { if (!FOLDER.test(key)) throw new Error('Unknown extension.'); return path.join(directory, key); };
  function find(key) { const record = records().find(item => item.key === key); if (!record) throw new Error('Extension not found.'); return record; }
  function info(record) {
    const extension = loaded.get(record.key);
    let manifest = extension?.manifest || {};
    try { if (!extension) manifest = readManifest(folder(record.key)); } catch {}
    let icon = icons.get(record.key) || '';
    try { if (!icons.has(record.key)) {
      const iconFiles = manifest.action?.default_icon || manifest.browser_action?.default_icon || manifest.icons;
      const relative = typeof iconFiles === 'string' ? iconFiles : iconFiles?.['32'] || iconFiles?.['48'] || iconFiles?.['16'] || Object.values(iconFiles || {})[0];
      const file = resourcePath(folder(record.key), relative);
      if (fs.statSync(file).size < 2 * 1024 * 1024) {
        const image = nativeImage.createFromPath(file);
        if (!image.isEmpty()) icon = image.resize({ width: 32, height: 32 }).toDataURL();
      }
    } } catch {}
    icons.set(record.key, icon);
    const popup = manifest.action?.default_popup || manifest.browser_action?.default_popup;
    return { key: record.key, id: extension?.id || '', name: extension?.name || record.name || manifest.name || 'Extension', version: extension?.version || manifest.version || '',
      pinned: record.pinned === true, enabled: record.enabled !== false, loaded: !!extension, icon, hasPopup: typeof popup === 'string' && !!popup,
      error: errors.get(record.key) || '', nativeMessaging: manifest.permissions?.includes('nativeMessaging') === true };
  }
  function unload(record) { const extension = loaded.get(record.key); if (extension) session.extensions.removeExtension(extension.id); loaded.delete(record.key); }
  async function load(record) {
    try {
      // File URL access stays disabled; extensions belong only to the browser session.
      const extension = await session.extensions.loadExtension(folder(record.key), { allowFileAccess: false });
      loaded.set(record.key, extension); errors.delete(record.key); record.name = extension.name;
    } catch (error) { errors.set(record.key, String(error.message).slice(0, 500)); throw error; }
  }
  async function restore() {
    const prefs = getPreferences();
    prefs.browserExtensions = Array.isArray(prefs.browserExtensions) ? prefs.browserExtensions.filter(record => record && FOLDER.test(record.key)) : [];
    for (const record of records()) if (record.enabled !== false) { try { await load(record); } catch {} }
  }
  async function importFolder() {
    if (busy) throw new Error('An extension is already being added.');
    busy = true;
    let destination, record;
    try {
      const selection = await dialog.showOpenDialog(getWindow(), { title: 'Add an unpacked Chrome extension', properties: ['openDirectory'] });
      if (selection.canceled || !selection.filePaths.length) return;
      const source = fs.realpathSync(selection.filePaths[0]);
      const manifest = readManifest(source); validateFiles(source);
      if (manifest.key && records().some(item => { try { return readManifest(folder(item.key)).key === manifest.key; } catch { return false; } })) throw new Error('This extension is already added. Remove its previous version before adding a replacement.');
      const permissions = [...(manifest.permissions || []), ...(manifest.host_permissions || []), ...(manifest.content_scripts || []).flatMap(script => script.matches || [])];
      const answer = await dialog.showMessageBox(getWindow(), { type: 'question', message: `Add ${manifest.name}?`,
        detail: `This extension will run in your local browser tabs.\n\nRequested access:\n${[...new Set(permissions)].join('\n') || 'No permissions listed.'}\n\nChrome API compatibility is limited. Desktop password-manager integration is not available.`,
        buttons: ['Cancel', 'Add extension'], defaultId: 0, cancelId: 0 });
      if (answer.response !== 1) return;
      // Copy code only, never Chrome cookies, extension storage or vault data.
      record = { key: 'ext-' + crypto.randomBytes(16).toString('hex'), name: manifest.name, pinned: true, enabled: true };
      destination = folder(record.key);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      fs.cpSync(source, destination, { recursive: true, dereference: false });
      validateFiles(destination);
      await load(record);
      records().push(record); savePreferences(); destination = undefined;
    } catch (error) {
      if (record) { unload(record); getPreferences().browserExtensions = records().filter(item => item.key !== record.key); errors.delete(record.key); }
      throw error;
    } finally { if (destination) fs.rmSync(destination, { recursive: true, force: true }); busy = false; }
  }
  async function setEnabled(key, enabled) {
    if (typeof enabled !== 'boolean') throw new Error('Choose whether to enable this extension.');
    const record = find(key);
    if (enabled && !loaded.has(key)) await load(record);
    if (!enabled) unload(record);
    record.enabled = enabled; savePreferences();
  }
  function pin(key, pinned) { if (typeof pinned !== 'boolean') throw new Error('Choose whether to pin this extension.'); find(key).pinned = pinned; savePreferences(); }
  function remove(key) { const record = find(key); unload(record); getPreferences().browserExtensions = records().filter(item => item.key !== key); errors.delete(key); icons.delete(key); fs.rmSync(folder(key), { recursive: true, force: true }); savePreferences(); }
  function popup(key) {
    find(key);
    const extension = loaded.get(key); if (!extension) throw new Error('Enable this extension before opening it.');
    const relative = extension.manifest.action?.default_popup || extension.manifest.browser_action?.default_popup;
    const file = resourcePath(folder(key), relative);
    if (!fs.existsSync(file)) throw new Error('This extension has no available popup. Its content scripts run on matching pages.');
    const base = `chrome-extension://${extension.id}/`, url = new URL(relative, base);
    if (!url.href.startsWith(base)) throw new Error('Invalid extension popup URL.');
    return { url: url.href, name: extension.name, origin: base };
  }
  return { restore, importFolder, list: () => records().map(info), setEnabled, pin, remove, popup };
}
module.exports = { createExtensionStore, resourcePath, readManifest, validateFiles };
