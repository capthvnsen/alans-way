const PERMISSIONS = Object.freeze({ geolocation: 'Precise location', 'geolocation-approximate': 'General area', notifications: 'Notifications', camera: 'Camera', microphone: 'Microphone', 'clipboard-read': 'Read clipboard' });

function originOf(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.origin : '';
  } catch { return ''; }
}
function permissionKeys(permission, details = {}) {
  if (permission !== 'media') return Object.hasOwn(PERMISSIONS, permission) ? [permission] : [];
  const types = Array.isArray(details.mediaTypes) && details.mediaTypes.length ? details.mediaTypes : [details.mediaType || 'audio', ...(details.mediaType ? [] : ['video'])];
  if (types.some(type => !['audio', 'video'].includes(type))) return [];
  return [...new Set(types.map(type => type === 'audio' ? 'microphone' : 'camera'))];
}
function createSitePermissions({ getPreferences, savePreferences, canRequest, prompt }) {
  const pending = new Map();
  function decision(scope, origin, key) {
    const prefs = getPreferences();
    const stored = prefs.sitePermissions?.[scope]?.[origin]?.[key];
    if (['allow', 'block'].includes(stored)) return stored;
    if (key === 'geolocation-approximate') return prefs.locationDefault === 'approximate' ? 'allow' : 'block';
    return key === 'geolocation' && prefs.locationDefault !== 'ask' ? 'block' : 'ask';
  }
  function set({ scope = 'browser', origin, permission, decision: choice }) {
    origin = originOf(origin);
    if (!origin || !['browser', 'telegram'].includes(scope) || !Object.hasOwn(PERMISSIONS, permission) || !['allow', 'block', 'ask'].includes(choice)) throw new Error('Choose a valid site, permission and setting.');
    const prefs = getPreferences();
    prefs.sitePermissions ||= {};
    prefs.sitePermissions[scope] ||= {};
    prefs.sitePermissions[scope][origin] ||= {};
    if (choice === 'ask') delete prefs.sitePermissions[scope][origin][permission];
    else prefs.sitePermissions[scope][origin][permission] = choice;
    if (!Object.keys(prefs.sitePermissions[scope][origin]).length) delete prefs.sitePermissions[scope][origin];
    savePreferences();
  }
  function reset(scope = 'browser') {
    if (!['browser', 'telegram'].includes(scope)) throw new Error('Unknown browser session.');
    const prefs = getPreferences();
    if (prefs.sitePermissions) delete prefs.sitePermissions[scope];
    savePreferences();
  }
  function context(wc, details, requestingOrigin) {
    const origin = originOf(requestingOrigin || details.securityOrigin || details.requestingUrl || wc?.getURL());
    return { origin, url: wc?.getURL(), eligible: !!wc && !wc.isDestroyed() && canRequest(wc) };
  }
  function install(session, scope) {
    session.setPermissionCheckHandler((wc, permission, requestingOrigin, details = {}) => {
      const ctx = context(wc, details, requestingOrigin);
      if (!ctx.eligible) return false;
      if (permission === 'fullscreen') return true;
      const keys = permissionKeys(permission, details);
      return !!ctx.origin && keys.length > 0 && keys.every(key => decision(scope, ctx.origin, key) === 'allow');
    });
    session.setPermissionRequestHandler(async (wc, permission, callback, details = {}) => {
      let allowed = false;
      try {
        const ctx = context(wc, details);
        if (!ctx.eligible) return;
        if (permission === 'fullscreen') { allowed = true; return; }
        const keys = permissionKeys(permission, details);
        if (!ctx.origin || !keys.length || keys.some(key => decision(scope, ctx.origin, key) === 'block')) return;
        const unknown = keys.filter(key => decision(scope, ctx.origin, key) === 'ask');
        if (unknown.length) {
          const id = JSON.stringify([scope, ctx.origin, unknown.slice().sort()]);
          if (!pending.has(id)) {
            const answer = Promise.resolve().then(() => prompt(ctx.origin, unknown.map(key => PERMISSIONS[key]))).then(choice => {
              // Persist the human's choice even if a tab was closed while the dialog was open.
              for (const key of unknown) set({ scope, origin: ctx.origin, permission: key, decision: choice === true ? 'allow' : 'block' });
            }).finally(() => pending.delete(id));
            pending.set(id, answer);
          }
          await pending.get(id);
        }
        // A takeover, tab switch or navigation during the prompt must not authorize the new page/agent.
        allowed = !wc.isDestroyed() && wc.getURL() === ctx.url && canRequest(wc) && keys.every(key => decision(scope, ctx.origin, key) === 'allow');
      } catch { allowed = false; }
      finally { callback(allowed); }
    });
  }
  return { install, set, reset };
}
module.exports = { createSitePermissions, originOf, PERMISSIONS };
