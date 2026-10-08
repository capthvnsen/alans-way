'use strict';
const { SHARED_TOKEN } = require('./cloud-migrate.cjs');

// Upgraders who already wired a computer never see the wizard unless they reopen it.
function shouldOnboard(prefs) {
  if (prefs.onboarded === false) return true;
  return !prefs.onboarded && !prefs.macSshHost;
}

// Decide once at launch: step 3 saves an SSH address, which must not end the wizard.
function pinOnboarding(prefs) {
  if (prefs.onboarded === undefined && shouldOnboard(prefs)) prefs.onboarded = false;
}

// "Set up a server" steps in order; the wizard resolves to the stored step so
// a restart resumes where it left off.
const CLOUD_STEPS = ['connect', 'migrate', 'model', 'telegram', 'done'];
const CLOUD_FLOW = CLOUD_STEPS;

// Which wizard step the stored setup state resolves to. A stored step wins so
// a restart resumes where it left off; anything stale or unknown starts at
// connect, which is safe to re-run.
function cloudStep(prefs) {
  const cloud = prefs?.cloud;
  if (!cloud || typeof cloud !== 'object' || typeof cloud.step !== 'string') return null;
  if (cloud.step === 'done') return null;
  return CLOUD_STEPS.includes(cloud.step) ? cloud.step : 'connect';
}

// Entry points to the wizard: the "Set up a server" button and the
// alansway://setup?host= deep link. A host from the link is already validated;
// it only prefills the connect field — Connect still runs the first remote
// command, and only when the user clicks it.
function startServerSetup(prefs, host) {
  const cloud = prefs.cloud && typeof prefs.cloud === 'object' ? prefs.cloud : {};
  prefs.cloud = { ...cloud, step: 'connect' };
  if (host) prefs.cloud.setupHost = host;
  prefs.onboarded = false;
  return prefs.cloud;
}

// The telegram step mints a bot only for profiles that lack one: skip it when
// every discovered profile already carries a TELEGRAM_BOT_TOKEN, or a token
// lives in the shared home env / secrets dir (SHARED_TOKEN covers them all).
// Mixed coverage keeps the step so untokenedProfile can pick a target.
function telegramCovered(prefs) {
  const tokened = prefs?.cloud?.tokenedProfiles;
  if (!Array.isArray(tokened) || !tokened.length) return false;
  if (tokened.includes(SHARED_TOKEN)) return true;
  const profiles = prefs?.cloud?.profiles;
  // No recorded profile inventory means the tokens we know about are all we
  // can see — do not mint a conflicting second bot.
  if (!Array.isArray(profiles) || !profiles.length) return true;
  return profiles.every((name) => tokened.includes(name));
}

// The step after `current`.
function nextCloudStep(prefs, current) {
  const index = CLOUD_FLOW.indexOf(current);
  let next = index === -1 ? 'done' : CLOUD_FLOW[index + 1] || 'done';
  if (next === 'telegram' && telegramCovered(prefs)) next = 'done';
  return next;
}

function setCloudStep(prefs, step) {
  const cloud = prefs?.cloud;
  if (!cloud || typeof cloud !== 'object' || !CLOUD_STEPS.includes(step)) return false;
  cloud.step = step;
  return true;
}

module.exports = { shouldOnboard, pinOnboarding, cloudStep, startServerSetup, nextCloudStep, setCloudStep, CLOUD_STEPS };
