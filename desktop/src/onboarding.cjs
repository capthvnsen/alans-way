'use strict';

// Upgraders who already wired a computer never see the wizard unless they reopen it.
function shouldOnboard(prefs) {
  if (prefs.onboarded === false) return true;
  return !prefs.onboarded && !prefs.macSshHost;
}

// Decide once at launch: step 3 saves an SSH address, which must not end the wizard.
function pinOnboarding(prefs) {
  if (prefs.onboarded === undefined && shouldOnboard(prefs)) prefs.onboarded = false;
}

module.exports = { shouldOnboard, pinOnboarding };
