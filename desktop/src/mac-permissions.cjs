'use strict';

const APP = 'alans-way-localapp';
const VERBS = ['apps', 'snapshot', 'screenshot', 'menu', 'action'];

// macOS credits Accessibility and Screen Recording to this app, never to the SSH
// session that relays the agent's request, so a failure here is always fixable
// at the Mac. Say exactly where, and ask macOS to show its own prompt once.
function createMacPermissionHelp({ systemPreferences, platform = process.platform }) {
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
    ...Object.fromEntries(VERBS.map((verb) => [verb, (...args) => service[verb](...args).catch((error) => { throw explain(error); })])),
  };

  return { explain, wrap };
}

module.exports = { createMacPermissionHelp };
