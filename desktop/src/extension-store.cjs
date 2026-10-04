const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { installChromeWebStore, uninstallExtension } = require('electron-chrome-web-store');

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
function createExtensionStore({ root, session, dialog, nativeImage, getWindow, getPreferences, savePreferences, onChanged = () => {}, canInstall = () => false }) {
  const directory = path.join(root, 'browser-extensions'), storeDirectory = path.join(root, 'chrome-web-store'), loaded = new Map(), errors = new Map(), icons = new Map();
  let busy = false;
  const records = () => getPreferences().browserExtensions;
  const folder = key => { if (!FOLDER.test(key)) throw new Error('Unknown extension.'); return path.join(directory, key); };
  const recordFolder = record => {
    if (record.source !== 'webstore') return folder(record.key);
    if (!/^[a-p]{32}$/.test(record.storeId) || !/^[0-9.]+_0$/.test(record.storeVersion)) throw new Error('Invalid Web Store installation.');
    return path.join(storeDirectory, record.storeId, record.storeVersion);
  };
  function find(key) { const record = records().find(item => item.key === key); if (!record) throw new Error('Extension not found.'); return record; }
  function info(record) {
    const extension = loaded.get(record.key);
    let manifest = extension?.manifest || {};
    try { if (!extension) manifest = readManifest(recordFolder(record)); } catch {}
    let icon = icons.get(record.key) || '';
    try { if (!icons.has(record.key)) {
      const iconFiles = manifest.action?.default_icon || manifest.browser_action?.default_icon || manifest.icons;
      const relative = typeof iconFiles === 'string' ? iconFiles : iconFiles?.['32'] || iconFiles?.['48'] || iconFiles?.['16'] || Object.values(iconFiles || {})[0];
      const file = resourcePath(recordFolder(record), relative);
      if (fs.statSync(file).size < 2 * 1024 * 1024) {
        const image = nativeImage.createFromPath(file);
        if (!image.isEmpty()) icon = image.resize({ width: 32, height: 32 }).toDataURL();
      }
    } } catch {}
    icons.set(record.key, icon);
    const popup = manifest.action?.default_popup || manifest.browser_action?.default_popup;
    return { key: record.key, id: extension?.id || '', name: extension?.name || record.name || manifest.name || 'Extension', version: extension?.version || manifest.version || '',
      pinned: record.pinned === true, enabled: record.enabled !== false, loaded: !!extension, icon, hasPopup: typeof popup === 'string' && !!popup,
      error: errors.get(record.key) || '', nativeMessaging: manifest.permissions?.includes('nativeMessaging') === true, source: record.source || 'unpacked' };
  }
  function unload(record) { const extension = loaded.get(record.key); if (extension) session.extensions.removeExtension(extension.id); loaded.delete(record.key); }
  async function load(record) {
    try {
      // File URL access stays disabled; extensions belong only to the browser session.
      const extension = await session.extensions.loadExtension(recordFolder(record), { allowFileAccess: false });
      loaded.set(record.key, extension); errors.delete(record.key); record.name = extension.name;
      if (extension.manifest.manifest_version === 3 && extension.manifest.background?.service_worker) await session.serviceWorkers.startWorkerForScope(`chrome-extension://${extension.id}`).catch(() => {});
    } catch (error) { errors.set(record.key, String(error.message).slice(0, 500)); throw error; }
  }
  async function restore() {
    const prefs = getPreferences();
    prefs.browserExtensions = Array.isArray(prefs.browserExtensions) ? prefs.browserExtensions.filter(record => record && FOLDER.test(record.key)) : [];
    for (const record of records()) if (record.enabled !== false) { try { await load(record); } catch {} }
  }
  function rememberStoreExtension(extension) {
    const relative = path.relative(storeDirectory, extension.path).split(path.sep);
    if (relative.length !== 2 || relative[0] !== extension.id || !/^[a-p]{32}$/.test(extension.id) || !/^[0-9.]+_0$/.test(relative[1])) return;
    let record = records().find(item => item.source === 'webstore' && item.storeId === extension.id);
    if (record?.enabled === false) { session.extensions.removeExtension(extension.id); return; }
    if (!record) { record = { key: 'ext-' + crypto.randomBytes(16).toString('hex'), source: 'webstore', storeId: extension.id, pinned: true, enabled: true }; records().push(record); }
    record.storeVersion = relative[1]; record.name = extension.name;
    loaded.set(record.key, extension); errors.delete(record.key); icons.delete(record.key); savePreferences(); onChanged();
  }
  async function confirm(name, manifest) {
    if (manifest.theme) return false;
    const permissions = [...(manifest.permissions || []), ...(manifest.host_permissions || []), ...(manifest.content_scripts || []).flatMap(script => script.matches || [])];
    const answer = await dialog.showMessageBox(getWindow(), { type: 'question', message: `Add ${name}?`,
      detail: `This extension will run in your local browser tabs.\n\nRequested access:\n${[...new Set(permissions)].join('\n') || 'No permissions listed.'}`,
      buttons: ['Cancel', 'Add extension'], defaultId: 0, cancelId: 0 });
    return answer.response === 1;
  }
  async function installStore() {
    session.extensions.on('extension-loaded', (_event, extension) => rememberStoreExtension(extension));
    session.extensions.on('extension-unloaded', (_event, extension) => { for (const [key, item] of loaded) if (item.id === extension.id) loaded.delete(key); onChanged(); });
    await installChromeWebStore({ session, extensionsPath: storeDirectory, loadExtensions: false, autoUpdate: true,
      beforeInstall: async details => {
        if (!canInstall(details.frame) || !await confirm(details.localizedName, details.manifest) || !canInstall(details.frame)) return { action: 'deny' };
        const record = records().find(item => item.storeId === details.id); if (record) record.enabled = true;
        return { action: 'allow' };
      } });
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
      if (manifest.key && records().some(item => { try { return readManifest(recordFolder(item)).key === manifest.key; } catch { return false; } })) throw new Error('This extension is already added. Remove its previous version before adding a replacement.');
      if (!await confirm(manifest.name, manifest)) return;
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
    const previous = record.enabled; record.enabled = enabled;
    try { if (enabled && !loaded.has(key)) await load(record); } catch (error) { record.enabled = previous; throw error; }
    if (!enabled) unload(record);
    record.enabled = enabled; savePreferences();
  }
  function pin(key, pinned) { if (typeof pinned !== 'boolean') throw new Error('Choose whether to pin this extension.'); find(key).pinned = pinned; savePreferences(); }
  async function remove(key) {
    const record = find(key); unload(record);
    if (record.source === 'webstore') await uninstallExtension(record.storeId, { session, extensionsPath: storeDirectory });
    else fs.rmSync(folder(key), { recursive: true, force: true });
    getPreferences().browserExtensions = records().filter(item => item.key !== key); errors.delete(key); icons.delete(key); savePreferences();
  }
  return { restore, installStore, importFolder, list: () => records().map(info), setEnabled, pin, remove };
}
module.exports = { createExtensionStore, resourcePath, readManifest, validateFiles };
