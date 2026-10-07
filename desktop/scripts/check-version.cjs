'use strict';

// desktop/package.json "version" is the single source of truth. A final tag
// vX.Y.Z must equal it; a release candidate vX.Y.Z-rc.N must have it as its
// base. On success the version to build is the tag's.
const TAG = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(-rc\.(?:0|[1-9]\d*))?$/;

function checkTag(tag, packageVersion) {
  const match = TAG.exec(String(tag || ''));
  if (!match) return { ok: false, message: `Tag "${tag}" is not vX.Y.Z or vX.Y.Z-rc.N.` };
  if (match[1] !== packageVersion) return { ok: false, message: `Tag ${tag} does not match desktop/package.json version ${packageVersion}. Run "npm version ${match[1]} --no-git-tag-version" in desktop/, commit, and re-tag.` };
  return { ok: true, version: match[1] + (match[2] || '') };
}

if (require.main === module) {
  const result = checkTag(process.argv[2], require('../package.json').version);
  if (!result.ok) { console.error(`::error::${result.message}`); process.exit(1); }
  console.log(result.version);
}

module.exports = { checkTag };
