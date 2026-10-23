'use strict';

const { performance } = require('node:perf_hooks');
const { calls, context, remainingMs, checkCall, waitInCall, READ_BUDGET_MS } = require('./call-budget.cjs');

const APP = 'alans-way-localapp';
const VERBS = ['apps', 'snapshot', 'screenshot', 'menu', 'action', 'launch'];
const screenHelp = `Turn on System Settings > Privacy & Security > Screen & System Audio Recording (Screen Recording on older macOS) > ${APP}, then quit and reopen Alan's Workspace. Continue with available controls and menus; they do not need Screen Recording. Unknown window titles do not mean an app is closed.`;
// Older callers keep the permission caps; one shared deadline bounds nested read retries.
const READ_WAIT_MS = 35000;
const ACTION_WAIT_MS = 4000;

// macOS credits Accessibility and Screen Recording to this app, never to the SSH
// session that relays the agent's request, so a failure here is always fixable
// at the Mac. Say exactly where, and ask macOS to show its own prompt once.
function createMacPermissionHelp({ systemPreferences, platform = process.platform, waitMs = 60000, pollMs = 1000, sleep = require('node:timers/promises').setTimeout }) {
  let prompted = false;
  let computer, screenRequested = false, screenWasOff = false, screenStatus = 'unknown';
  const screenNotified = new Set();

  function requestScreen() {
    if (platform !== 'darwin' || screenRequested || !computer?.requestScreenAccess) return;
    let status;
    try { status = systemPreferences.getMediaAccessStatus('screen'); } catch { return; }
    if (status === 'granted') { screenStatus = 'granted'; return; }
    screenRequested = true;
    screenStatus = ['denied', 'not-determined', 'restricted'].includes(status) ? 'denied' : 'unknown';
    screenWasOff ||= screenStatus === 'denied';
    try { Promise.resolve(computer.requestScreenAccess()).catch(() => {}); } catch { /* settings still offer the switch */ }
  }

  function screenNotice(bot) {
    if (screenStatus !== 'denied' || screenNotified.has(bot)) return '';
    screenNotified.add(bot);
    if (screenNotified.size > 500) screenNotified.delete(screenNotified.values().next().value);
    return `Screen Recording is off for ${APP}. ${screenHelp}`;
  }

  async function read(service) {
    const status = await readMacPermissions(service);
    screenStatus = status.screen;
    if (status.screen === 'denied') screenWasOff = true;
    return { ...status, ...(screenWasOff ? { restartRequired: true } : {}) };
  }

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
      return Object.assign(new Error(`${status === 'unknown' ? 'Screen Recording could not be checked' : 'Screen Recording is off'} for ${APP} (${status}). ${screenHelp}`), { code: 'permission' });
    }
    return error;
  }

  const wrap = (service) => {
    if (platform !== 'darwin') return service;
    computer = service;
    return {
      ...service,
      ...Object.fromEntries(VERBS.map((verb) => [verb, (...args) => calls.run(calls.getStore() || context(undefined, undefined, verb === 'action' ? Infinity : READ_BUDGET_MS), async () => {
        const started = performance.now();
        checkCall();
        requestScreen();
        const bot = ['snapshot', 'action'].includes(verb) ? args[0] : verb === 'screenshot' ? args[2]?.bot : undefined;
        return service[verb](...args).then((result) => {
          const notice = bot === undefined ? '' : screenNotice(bot);
          return notice ? { ...result, note: [result.note, notice].filter(Boolean).join(' ') } : result;
        }).catch(async (error) => {
          if (computer.requestScreenAccess && error?.code === 'permission' && /Screen Recording/i.test(error.message || '')) {
            screenWasOff = true;
            screenStatus = 'denied';
            throw Object.assign(new Error(screenNotice(bot) || 'Screenshots are unavailable. Continue with available controls and menus.'), { code: 'permission' });
          }
          const explained = explain(error);
          if (error?.code === 'permission' && /Accessibility/i.test(error.message || '')) {
            // Budgeted actions reserve 20s for input, or 65s for a batch/wait, leaving input time intact.
            const reserve = ['batch', 'wait'].includes(args[2]?.action) ? 65000 : 20000;
            const waitUntil = verb === 'action' && calls.getStore()?.budgeted
              ? performance.now() + Math.max(0, remainingMs() - reserve)
              : started + (verb === 'action' ? ACTION_WAIT_MS : READ_WAIT_MS);
            const deadline = Math.min(performance.now() + waitMs, waitUntil, performance.now() + remainingMs());
            while (performance.now() < deadline) {
              checkCall();
              await waitInCall(sleep(Math.min(pollMs, deadline - performance.now())));
              try {
                if (!systemPreferences.isTrustedAccessibilityClient(false)) continue;
              } catch { break; }
              if (performance.now() > deadline) break;
              checkCall();
              return service[verb](...args).catch((error) => { throw explain(error); });
            }
          }
          throw explained;
        });
      })])),
    };
  };

  return { explain, wrap, requestScreen, read };
}

async function readMacPermissions(service) {
  try {
    const { accessibility, screenRecording } = await service.permissions();
    return { accessibility: typeof accessibility === 'boolean' ? accessibility : null,
      screen: screenRecording === true ? 'granted' : screenRecording === false ? 'denied' : 'unknown' };
  } catch { return { accessibility: null, screen: 'unknown' }; }
}

module.exports = { createMacPermissionHelp, readMacPermissions };
