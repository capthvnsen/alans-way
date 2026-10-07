'use strict';

// electron-builder writes app-update.yml only for an NSIS target. The install
// script builds with --dir, so those apps have no feed and must be given one.
function windowsFeed(hasUpdateYml, pkg) {
  if (hasUpdateYml) return null;
  const github = (pkg?.build?.publish || []).find((entry) => entry?.provider === 'github');
  return github ? { provider: 'github', owner: github.owner, repo: github.repo } : null;
}

module.exports = { windowsFeed };
