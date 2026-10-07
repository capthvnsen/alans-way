'use strict';

// electron-builder writes app-update.yml only for an installer target (NSIS
// on Windows, zip on macOS). A --dir build has no feed and must be given one.
function githubFeed(hasUpdateYml, publish) {
  if (hasUpdateYml) return null;
  const github = (publish || []).find((entry) => entry?.provider === 'github');
  return github ? { provider: 'github', owner: github.owner, repo: github.repo } : null;
}

module.exports = { githubFeed };
