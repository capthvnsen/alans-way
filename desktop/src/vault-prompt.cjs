'use strict';
// The prompt before Hermes's vault fills a saved password into an agent tab. A native dialog from the main
// process: no page or renderer HTML can imitate it. It names the bot and the site, never the password. Hermes's
// request does not carry the account name, so the prompt cannot show it. Resolves true (Allow once), false (Deny)
// or null when nobody answered: the signal fired first, or there was no window to ask in.
// It is a sheet on the app window on purpose: on macOS a message box with no parent window blocks the whole main
// process until answered and ignores `signal`, so a timeout or a withdrawn request could never close it.
function createVaultPrompt({ dialog, app, getWindow }) {
  return async function askVaultFill({ botName, origin }, signal) {
    const win = getWindow();
    if (!win || win.isDestroyed() || signal.aborted) return null;
    if (win.isMinimized()) win.restore();
    win.show();
    app.dock?.bounce('critical');
    const { response } = await dialog.showMessageBox(win, { type: 'question', signal, buttons: ['Deny', 'Allow once'], defaultId: 0, cancelId: 0, noLink: true,
      message: `Let ${botName} fill a saved password on ${origin}?`,
      detail: `${botName} asked Hermes to fill your saved login into its tab at ${origin}.${origin.startsWith('http:') ? ' This site is not encrypted (http).' : ''} The password goes straight into the page; ${botName} and this app never show it. Allow covers this one fill.` });
    return signal.aborted ? null : response === 1;
  };
}

module.exports = { createVaultPrompt };
