'use strict';

const APP = 'alans-way-localapp';
const VERBS = ['apps', 'snapshot', 'screenshot', 'menu', 'action'];
// Reads: 35+2*20=75<80 s; batches: 4+45+.15+2*20=89.15<90/100 s.
const READ_WAIT_MS = 35000;
const ACTION_WAIT_MS = 4000;

// macOS credits Accessibility and Screen Recording to this app, never to the SSH
// session that relays the agent's request, so a failure here is always fixable
// at the Mac. Say exactly where, and ask macOS to show its own prompt once.
function createMacPermissionHelp({ systemPreferences, platform = process.platform, waitMs = 60000, pollMs = 1000, sleep = require('node:timers/promises').setTimeout }) {
  let prompted = false;

  function explain(error) {
    if (platform !== 'darwin' || !error) return error;
    const text = String(error.message || '');
    if (error.code === 'permission' && /Accessibility/i.test(text)) {
      if (!prompted) { prompted = true; try { systemPreferences.isTrustedAccessibilityClient(true); } catch { /* the message below still tells the user */ } }
      return Object.assign(new Error(`Accessibility is off for ${APP}. Ask the user to turn it on at the Mac: System Settings > Privacy & Security > Accessibility > ${APP}. Then retry.`), { code: 'permission' });
    }
    if ((error.code === 'permission' && /Screen Recording/i.test(text)) || /could not create image from display/i.test(text)) {
      let status = 'unknown';
      try { status = systemPreferences.getMediaAccessStatus('screen'); } catch { /* keep unknown */ }
      if (status === 'granted') return error;
      return Object.assign(new Error(`Screen Recording is off for ${APP} (${status}). Ask the user to turn it on at the Mac: System Settings > Privacy & Security > Screen Recording > ${APP}. Then retry.`), { code: 'permission' });
    }
    return error;
  }

  const wrap = (service) => platform !== 'darwin' ? service : {
    ...service,
    ...Object.fromEntries(VERBS.map((verb) => [verb, (...args) => {
      const started = Date.now();
      return service[verb](...args).catch(async (error) => {
        const explained = explain(error);
        if (error?.code === 'permission' && /Accessibility/i.test(error.message || '')) {
          const deadline = Math.min(Date.now() + waitMs, started + (verb === 'action' ? ACTION_WAIT_MS : READ_WAIT_MS));
          while (Date.now() < deadline) {
            await sleep(Math.min(pollMs, deadline - Date.now()));
            try {
              if (!systemPreferences.isTrustedAccessibilityClient(false)) continue;
            } catch { break; }
            if (Date.now() > deadline) break;
            return service[verb](...args).catch((error) => { throw explain(error); });
          }
        }
        throw explained;
      });
    }])),
  };

  return { explain, wrap };
}

module.exports = { createMacPermissionHelp };
