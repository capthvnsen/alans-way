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

// Cloud onboarding steps in order. 'support' sits outside the linear flow: a
// failed computer lands there, and the user can skip it to finish.
const CLOUD_STEPS = ['cloud-wait', 'connect', 'migrate', 'model', 'telegram', 'support', 'done'];
const CLOUD_FLOW = ['cloud-wait', 'connect', 'migrate', 'model', 'telegram', 'done'];

// Which wizard step a stored (or absent) cloud onboarding resolves to. The
// stored step wins so a restart resumes where it left off; a failed computer
// always resolves to support instead of spinning.
function cloudStep(prefs, computer) {
  const cloud = prefs?.cloud;
  if (!cloud || typeof cloud !== 'object' || (!cloud.sessionEnc && cloud.diy !== true)) return null;
  if (cloud.step === 'done') return null;
  if (computer?.state === 'failed') return 'support';
  if (cloud.step === 'cloud-wait' && computer?.state === 'ready') return 'connect';
  return CLOUD_STEPS.includes(cloud.step) ? cloud.step : 'cloud-wait';
}

// The step after `current`. A migrated profile that already carries a
// TELEGRAM_BOT_TOKEN skips the telegram step entirely — no new bot is made.
function nextCloudStep(prefs, current) {
  const index = CLOUD_FLOW.indexOf(current);
  let next = index === -1 ? 'done' : CLOUD_FLOW[index + 1] || 'done';
  const tokened = prefs?.cloud?.tokenedProfiles;
  if (next === 'telegram' && Array.isArray(tokened) && tokened.length) next = 'done';
  return next;
}

function setCloudStep(prefs, step) {
  const cloud = prefs?.cloud;
  if (!cloud || typeof cloud !== 'object' || !CLOUD_STEPS.includes(step)) return false;
  cloud.step = step;
  return true;
}

module.exports = { shouldOnboard, pinOnboarding, cloudStep, nextCloudStep, setCloudStep, CLOUD_STEPS };
