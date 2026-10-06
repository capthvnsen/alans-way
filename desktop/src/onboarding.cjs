'use strict';

// Upgraders who already wired a computer never see the wizard unless they reopen it.
function shouldOnboard(prefs) {
  if (prefs.onboarded === false) return true;
  return !prefs.onboarded && !prefs.macSshHost;
}

module.exports = { shouldOnboard };
