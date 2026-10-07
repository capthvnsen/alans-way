'use strict';

const fs = require('node:fs');

const CHANNELS = new Set(['release', 'prerelease', 'main', 'dev']);
const str = (value) => (typeof value === 'string' ? value : '');

function normalizeBuildInfo(raw) {
  const info = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return { channel: CHANNELS.has(info.channel) ? info.channel : 'dev', commit: str(info.commit), dirty: info.dirty === true, builtAt: str(info.builtAt) };
}

// A missing file is how an unstamped `npx electron .` run looks.
function readBuildInfo(file) {
  try { return normalizeBuildInfo(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { return normalizeBuildInfo(null); }
}

function describeBuild(raw) {
  const { channel, commit, dirty, builtAt } = normalizeBuildInfo(raw);
  const title = [commit && `Commit ${commit}`, builtAt && `built ${builtAt.replace('T', ' ').replace(/\.\d+Z$/, 'Z')}`].filter(Boolean).join(' · ') || 'Not a stamped build';
  if (channel === 'release' || channel === 'main') return { text: 'Production', tone: 'prod', title };
  if (channel === 'prerelease') return { text: 'Pre-release', tone: 'pre', title };
  return { text: `Dev${commit ? ` · ${commit}` : ''}${dirty ? ' + local changes' : ''}`, tone: 'dev', title };
}

module.exports = { describeBuild, normalizeBuildInfo, readBuildInfo };
