'use strict';
// The saved Hermes Desktop sign-in. The password is encrypted with safeStorage (the OS
// keychain) and tied to the origin it was saved for, so a changed or look-alike address
// never receives it. It is sent only to that origin's own password-login route.
function createWebappSignIn({ safeStorage, getPreferences, savePreferences }) {
  const secure = () => safeStorage.isEncryptionAvailable()
    && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text');
  const saved = (origin) => { const entry = getPreferences().webappSignIn; return entry?.origin === origin ? entry : null; };
  return {
    username: (origin) => saved(origin)?.username || '',
    save(origin, username, password) {
      username = String(username || '').trim(); password = String(password || '');
      if (!username || !password) throw new Error('Enter the username and password from webapp-signin.txt on your Hermes server.');
      if (!secure()) throw new Error("This computer has no keychain Workspace can use, so the password can't be saved. Sign in inside the chat pane instead.");
      getPreferences().webappSignIn = { origin, username, passwordEnc: safeStorage.encryptString(password).toString('base64') };
      savePreferences();
    },
    read(origin) {
      const entry = saved(origin);
      try { return entry && secure() ? { username: entry.username, password: safeStorage.decryptString(Buffer.from(entry.passwordEnc, 'base64')) } : null; }
      catch { return null; }
    },
    forget() { if (getPreferences().webappSignIn) { delete getPreferences().webappSignIn; savePreferences(); } },
  };
}

// Signs in through the Webapp's own form route; the session cookies land in the
// session whose fetch is passed. Returns '' on success, else why it failed.
async function signInToWebapp(fetch, target, { username, password }) {
  let reply;
  try {
    reply = await fetch(new URL('auth/password-login', target), { method: 'POST', cache: 'no-store', credentials: 'include', redirect: 'manual',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'basic', username, password }), signal: AbortSignal.timeout(10000) });
  } catch { return 'unreachable'; }
  if (reply.ok) return '';
  return { 401: 'refused', 404: 'no-password-sign-in', 429: 'throttled' }[reply.status] || 'error';
}
const SIGN_IN_ERRORS = {
  refused: 'Hermes refused the saved username and password. Copy them again from webapp-signin.txt on your Hermes server and save them here.',
  'no-password-sign-in': 'This Hermes has no password sign-in. On your Hermes server, run webapp-signin.sh, then hermes gateway restart.',
  throttled: 'Too many sign-in tries. Wait a minute, then save the sign-in again.',
  unreachable: "Can't reach your Hermes server to sign in. Check that Tailscale is on on this computer.",
  error: "Hermes couldn't sign you in. On your Hermes server, run hermes webapp --status.",
};

module.exports = { createWebappSignIn, signInToWebapp, SIGN_IN_ERRORS };
