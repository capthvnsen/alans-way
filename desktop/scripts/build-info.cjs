'use strict';

// Stamps desktop/build-info.json so the app can say whether this build is what
// is live on GitHub: release (final tag), prerelease (rc tag), main (clean
// checkout contained in origin/main, or an install-script tarball of main), or
// dev (anything else).
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const { checkTag } = require('./check-version.cjs');
const { nightlyBuild } = require('../src/release-channel.cjs');

const ROOT = path.join(__dirname, '..', '..');

function tryGit(git, args) {
  // Porcelain status uses leading spaces to distinguish unstaged changes.
  try { return String(git(args)).trimEnd(); } catch { return null; }
}

// The release gate runs before npm version, but this script runs afterward.
// Keep checkTag's gate rules intact; accept either the base or exact RC stamp.
function buildTag(name, version) {
  const day = /^nightly-(\d{8})$/.exec(name)?.[1];
  if (day) return { ok: new RegExp(`^\\d+\\.\\d+\\.\\d+-nightly\\.${day}$`).test(version), version };
  const base = version.replace(/-rc\.(?:0|[1-9]\d*)$/, '');
  const tag = checkTag(name, base);
  return tag.ok && (version === base || version === tag.version) ? tag : { ok: false };
}

function onlyVersionStamp(status, git, readFile, tag) {
  // Do not ignore other edits, staged changes, untracked files or renames.
  const files = status.split('\n');
  if (!files.every(line => /^ M desktop\/package(?:-lock)?\.json$/.test(line))) return false;
  try {
    return files.every(line => {
      const file = line.slice(3);
      const original = JSON.parse(tryGit(git, ['show', `HEAD:${file}`]));
      const day = /-nightly\.(\d{4})(\d{2})(\d{2})$/.exec(tag.version);
      if (day ? nightlyBuild(original.version, new Date(`${day[1]}-${day[2]}-${day[3]}`)).version !== tag.version : !checkTag(`v${tag.version}`, original.version).ok) return false;
      const stamped = JSON.parse(readFile(file));
      original.version = tag.version;
      if (file.endsWith('package-lock.json') && original.packages?.['']) original.packages[''].version = tag.version;
      return isDeepStrictEqual(original, stamped);
    });
  } catch { return false; }
}

function buildInfo({ version, env, git, readFile = file => fs.readFileSync(path.join(ROOT, file), 'utf8'), tarball = false, now = new Date() }) {
  const builtAt = now.toISOString();
  const tag = env.GITHUB_REF_TYPE === 'tag' ? buildTag(env.GITHUB_REF_NAME, version) : { ok: false };
  const commit = tarball ? '' : tryGit(git, ['rev-parse', '--short', 'HEAD']) || '';
  const status = !tarball && commit ? tryGit(git, ['status', '--porcelain']) : '';
  const dirty = status !== '' && !(tag.ok && status !== null && onlyVersionStamp(status, git, readFile, tag));
  let channel = 'dev';
  if (tag.ok && !dirty) channel = tag.version.includes('-') ? 'prerelease' : 'release';
  else if (tarball) channel = 'main';
  else if (commit && !dirty && tryGit(git, ['merge-base', '--is-ancestor', 'HEAD', 'origin/main']) !== null) channel = 'main';
  return { channel, version: tag.ok ? tag.version : version, commit, dirty, builtAt };
}

if (require.main === module) {
  const info = buildInfo({
    version: require('../package.json').version,
    env: process.env,
    git: (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }),
    tarball: fs.existsSync(path.join(ROOT, '.alans-way-tarball')),
  });
  fs.writeFileSync(path.join(__dirname, '..', 'build-info.json'), JSON.stringify(info, null, 2) + '\n');
  console.log(`build-info: ${info.channel} ${info.commit}${info.dirty ? ' (dirty)' : ''}`);
}

module.exports = { buildInfo };
