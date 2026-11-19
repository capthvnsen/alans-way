'use strict';
// One-time import of an API key left in ~/.config/alans-way/<name>-api-key: checked, saved
// sealed, read back from disk, and only then deleted. No result or error carries the key.
const path = require('node:path');

const NAME = /^[a-z0-9-]{1,40}$/, SUFFIX = '-api-key';
const keyDir = (home) => path.join(home, '.config', 'alans-way');

function keyFiles({ fs, home }) {
  try { return fs.readdirSync(keyDir(home)).filter((f) => f.endsWith(SUFFIX) && NAME.test(f.slice(0, -SUFFIX.length))).map((f) => f.slice(0, -SUFFIX.length)).sort(); }
  catch { return []; }
}

function importKey({ name, fs, home, safeStorage, save, readBack, platform = process.platform, uid = process.getuid?.() }) {
  if (!keyFiles({ fs, home }).includes(name)) throw new Error('That key file is not there any more.');
  const file = path.join(keyDir(home), `${name}${SUFFIX}`), shown = `~/.config/alans-way/${name}${SUFFIX}`;
  let stat;
  try { stat = fs.lstatSync(file); } catch { throw new Error('That key file is not there any more.'); }
  if (!stat.isFile()) throw new Error(`${shown} must be a regular file, not a link or folder.`);
  if (platform !== 'win32' && stat.uid !== uid) throw new Error(`${shown} must belong to you.`);
  if (platform !== 'win32' && (stat.mode & 0o777) !== 0o600) throw new Error(`${shown} must have mode 600 (chmod 600 ${shown}).`);
  if (stat.size < 16 || stat.size > 500) throw new Error(`${shown} must hold 16 to 500 bytes.`);
  if (!safeStorage.isEncryptionAvailable() || (platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) throw new Error('This computer has no secure storage for the key, so it was not imported.');
  const key = fs.readFileSync(file, 'utf8').replace(/\r?\n$/, '');
  if (!/^[\x21-\x7e]{16,}$/.test(key)) throw new Error(`${shown} must hold one key of at least 16 characters with no spaces.`);
  try { save(key); } catch { throw new Error('The key could not be saved, so the file was left in place.'); }
  let saved = '';
  try { saved = readBack(); } catch {}
  if (saved !== key) throw new Error('The saved key did not read back the same, so the file was left in place.');
  try { fs.unlinkSync(file); } catch {}
  let gone = false;
  try { fs.lstatSync(file); } catch (e) { gone = e.code === 'ENOENT'; }
  return { ok: true, deleted: gone, detail: gone ? 'Key imported and the file deleted.' : 'Imported, but could not delete the file: remove it yourself.' };
}

module.exports = { keyFiles, importKey };
