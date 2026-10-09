'use strict';

// Squirrel.Mac needs a Developer ID signature, so an unsigned app updates
// itself: download, verify, swap the bundle, relaunch. A signed app lets
// electron-updater take over; isDeveloperIdSigned picks the path per install,
// so unsigned 0.3.x releases can still swap onto the first signed one.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');

const REPO = 'capthvnsen/alans-way';
const BUNDLE_ID = 'app.alans-way.localapp';

// Stable releases only: a pre-release tag (with '-') never offers itself.
function parse(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(version || '').trim());
  return match ? match.slice(1).map(Number) : null;
}
function isNewer(latest, current) {
  const a = parse(latest), b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
function canSelfUpdate(bundlePath) {
  return /\.app$/.test(bundlePath || '') && !bundlePath.startsWith('/Volumes/') && !bundlePath.includes('/AppTranslocation/');
}

// Updates and the agent's plugin expect /Applications/<productName>.app. A
// Finder copy ("name 3.app"), a Downloads folder or a mounted dmg is another
// install that Squirrel would update separately.
function bundleLocation(bundlePath, productName) {
  const p = String(bundlePath || '');
  if (p === `/Applications/${productName}.app`) return { ok: true, kind: 'applications', path: p };
  const kind = p.startsWith('/Volumes/') ? 'dmg'
    : /\/Downloads\//.test(p) ? 'downloads'
    : p.startsWith('/Applications/') && /^\/Applications\/[^/]*\s\d+\.app$/.test(p) ? 'duplicate'
    : 'other';
  return { ok: false, kind, path: p };
}

// codesign -dv prints the authority chain on stderr; an ad-hoc signature has
// "Signature=adhoc" and no Authority lines at all.
function isDeveloperIdSigned(bundlePath, run = spawnSync) {
  const res = run('codesign', ['-dv', '--verbose=2', bundlePath], { encoding: 'utf8' });
  const info = `${res && res.stdout || ''}\n${res && res.stderr || ''}`;
  return info.includes('Authority=Developer ID Application:');
}

// 'electron-updater' drives autoUpdater (Windows, and macOS once signed);
// 'self' is the dmg swap above; 'none' means no app updates.
function updaterDriver(platform, signed) {
  if (platform === 'win32') return 'electron-updater';
  if (platform === 'darwin') return signed ? 'electron-updater' : 'self';
  return 'none';
}

async function checkLatest() {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { accept: 'application/vnd.github+json' } });
  if (!res.ok) return null;
  const { tag_name: tag } = await res.json();
  return tag ? { tag, version: tag.replace(/^v/, '') } : null;
}

async function download(url, file) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`The update download failed (${res.status}).`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

// Downloaded by the app itself, the image carries no quarantine flag, so the
// new version opens without another Gatekeeper prompt.
async function installMacUpdate({ tag, bundlePath }) {
  if (!canSelfUpdate(bundlePath)) throw new Error('Alan’s Workspace is not in a folder it can update. Move it to Applications first.');
  const base = `https://github.com/${REPO}/releases/download/${tag}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openalan-update-'));
  const dmg = path.join(dir, 'OpenAlan-mac.dmg'), mount = path.join(dir, 'mnt');
  try {
    await download(`${base}/OpenAlan-mac.dmg`, dmg);
    const sums = await fetch(`${base}/OpenAlan-mac.dmg.sha512`);
    const want = sums.ok ? (await sums.text()).trim().split(/\s+/)[0] : '';
    const got = crypto.createHash('sha512').update(fs.readFileSync(dmg)).digest('hex');
    if (!want || want !== got) throw new Error('The downloaded update did not match its checksum.');
    fs.mkdirSync(mount);
    execFileSync('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mount, dmg]);
    try {
      const app = fs.readdirSync(mount).find((name) => name.endsWith('.app'));
      if (!app) throw new Error('The update image has no app in it.');
      const id = execFileSync('defaults', ['read', path.join(mount, app, 'Contents', 'Info'), 'CFBundleIdentifier'], { encoding: 'utf8' }).trim();
      if (id !== BUNDLE_ID) throw new Error('The update image holds a different app.');
      // Stage beside the bundle, then rename: a failure never leaves half an app.
      const staged = `${bundlePath}.update`, old = `${bundlePath}.old`;
      fs.rmSync(staged, { recursive: true, force: true });
      fs.rmSync(old, { recursive: true, force: true });
      execFileSync('ditto', [path.join(mount, app), staged]);
      fs.renameSync(bundlePath, old);
      try { fs.renameSync(staged, bundlePath); } catch (error) { fs.renameSync(old, bundlePath); throw error; }
      fs.rmSync(old, { recursive: true, force: true });
    } finally {
      try { execFileSync('hdiutil', ['detach', '-quiet', mount]); } catch {}
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { bundleLocation, isNewer, canSelfUpdate, isDeveloperIdSigned, updaterDriver, checkLatest, installMacUpdate };
