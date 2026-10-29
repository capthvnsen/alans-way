'use strict';

const { compareVersions } = require('./update-version.cjs');
const REPO = 'capthvnsen/alans-way';
const normalizeChannel = value => value === 'nightly' ? 'nightly' : 'stable';
const nightlyTag = /^nightly-(\d{8})$/;

function releaseVersion(release, channel) {
  if (!release || release.draft) return '';
  if (normalizeChannel(channel) === 'stable') return !release.prerelease && /^v\d+\.\d+\.\d+$/.test(release.tag_name) ? release.tag_name.slice(1) : '';
  const date = nightlyTag.exec(release.tag_name)?.[1];
  // The release title carries the SemVer stamped into the installers.
  return release.prerelease && date && new RegExp(`^\\d+\\.\\d+\\.\\d+-nightly\\.${date}$`).test(release.name) ? release.name : '';
}

async function checkLatest(channel = 'stable', fetchImpl = fetch) {
  const nightly = normalizeChannel(channel) === 'nightly';
  const res = await fetchImpl(`https://api.github.com/repos/${REPO}/releases${nightly ? '?per_page=100' : '/latest'}`, {
    headers: { accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) return null;
  const data = await res.json();
  // shortcut: scan 100 recent releases; paginate if other releases crowd the latest nightly out.
  const releases = nightly ? (Array.isArray(data) ? data : []).sort((a, b) => String(b.tag_name).localeCompare(String(a.tag_name))) : [data];
  for (const release of releases) {
    const version = releaseVersion(release, channel);
    if (version) return { tag: release.tag_name, version };
  }
  return null;
}

function canUpdate(version, current, activeChannel, selectedChannel) {
  const channel = normalizeChannel(activeChannel);
  const matchesChannel = channel === 'nightly' ? /^\d+\.\d+\.\d+-nightly\.\d{8}$/.test(version) : /^\d+\.\d+\.\d+$/.test(version);
  return matchesChannel && channel === normalizeChannel(selectedChannel) && compareVersions(version, current) === 1;
}

function configureUpdater(updater, channel, tag) {
  updater.setFeedURL({ provider: 'generic', url: `https://github.com/${REPO}/releases/download/${tag}/`, channel: 'latest' });
  updater.channel = 'latest';
  // The channel setter enables downgrades; override it after every feed change.
  updater.allowDowngrade = false;
  updater.allowPrerelease = normalizeChannel(channel) === 'nightly';
  updater.autoDownload = false;
}

function nightlyBuild(version, date = new Date()) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(version);
  if (!match) throw new Error('Nightly builds require a semantic package version.');
  const day = date.toISOString().slice(0, 10).replaceAll('-', '');
  return { tag: `nightly-${day}`, version: `${match[1]}.${match[2]}.${Number(match[3]) + 1}-nightly.${day}` };
}

module.exports = { normalizeChannel, releaseVersion, checkLatest, canUpdate, configureUpdater, nightlyBuild };
