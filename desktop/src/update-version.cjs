'use strict';

// Plugin manifests use YAML scalars; only the semantic version is compared.
function normalizeVersion(value) {
  return String(value || '').trim().replace(/\s+#.*$/, '').trim().replace(/^(['"])(.*)\1$/, '$2').replace(/^v/, '');
}

// SemVer 2.0 precedence (semver.org §11). mac-update's isNewer only takes
// plain X.Y.Z, so an installed 1.2.0-rc.1 or a 1.2.0+build would never count
// as behind. Pre-release identifiers compare numerically when both are
// numbers (rc.10 > rc.2), numbers sort below words, a release beats its
// pre-releases, and build metadata never matters. null when unparseable.
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
// Probe tokens are not YAML scalars: validate the whole token without
// stripping comments or quotes that could disguise malformed evidence.
const validVersionToken = (value) => SEMVER.test(String(value || ''));
function compareVersions(a, b) {
  const x = SEMVER.exec(normalizeVersion(a)), y = SEMVER.exec(normalizeVersion(b));
  if (!x || !y) return null;
  for (let i = 1; i <= 3; i++) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) > Number(y[i]) ? 1 : -1;
  if (!x[4] || !y[4]) return x[4] ? -1 : y[4] ? 1 : 0;
  const p = x[4].split('.'), q = y[4].split('.');
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    if (p[i] === undefined || q[i] === undefined) return p[i] === undefined ? -1 : 1;
    const pn = /^\d+$/.test(p[i]), qn = /^\d+$/.test(q[i]);
    if (pn && qn) { if (Number(p[i]) !== Number(q[i])) return Number(p[i]) > Number(q[i]) ? 1 : -1; }
    else if (pn !== qn) return pn ? -1 : 1;
    else if (p[i] !== q[i]) return p[i] > q[i] ? 1 : -1;
  }
  return 0;
}

module.exports = { normalizeVersion, compareVersions, validVersionToken };
