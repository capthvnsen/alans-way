'use strict';

// Stamps desktop/build-info.json so the app can say whether this build is what
// is live on GitHub: release (final tag), prerelease (rc tag), main (clean
// checkout contained in origin/main, or an install-script tarball of main), or
// dev (anything else).
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { checkTag } = require('./check-version.cjs');

const ROOT = path.join(__dirname, '..', '..');

function tryGit(git, args) {
  try { return String(git(args)).trim(); } catch { return null; }
}

function buildInfo({ version, env, git, tarball = false, now = new Date() }) {
  const builtAt = now.toISOString();
  const tag = env.GITHUB_REF_TYPE === 'tag' ? checkTag(env.GITHUB_REF_NAME, version) : { ok: false };
  const commit = tarball ? '' : tryGit(git, ['rev-parse', '--short', 'HEAD']) || '';
  const dirty = !tarball && commit !== '' && tryGit(git, ['status', '--porcelain']) !== '';
  let channel = 'dev';
  if (tag.ok) channel = tag.version.includes('-') ? 'prerelease' : 'release';
  else if (tarball) channel = 'main';
  else if (commit && !dirty && tryGit(git, ['merge-base', '--is-ancestor', 'HEAD', 'origin/main']) !== null) channel = 'main';
  return { channel, version, commit, dirty, builtAt };
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
