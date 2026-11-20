'use strict';
// The prompt before Hermes's vault fills a saved password into an agent tab. A native dialog from the main
// process: no page or renderer HTML can imitate it. It names the bot and the site and says what Allow does.
// Hermes's request does not carry the account name, so the prompt cannot show it.
// Resolves true (Allow once), false (Deny), 'inactive' (the app is not the active app, so nothing was shown: it
// never raises the window or bounces the dock to get attention) or null (nobody answered: the signal fired first,
// or there was no window to ask in).
// It is a sheet on the app window on purpose: on macOS a message box with no parent window blocks the whole main
// process until answered and ignores `signal`, so a timeout or a withdrawn request could never close it.
// Text for a native dialog is plain, but a bidi override, a control character or a newline in a page's own address could
// still reorder or fake lines of it, so those are stripped. A long address is cut in the middle: both ends are kept.
const strip = (text) => String(text).replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, '');
const elide = (text, max = 120) => {
  if (text.length <= max) return text;
  const head = Math.ceil((max - 1) * 0.6);
  return `${text.slice(0, head)}…${text.slice(text.length - (max - 1 - head))}`;
};
const active = (win) => win.isFocused() && win.isVisible() && !win.isMinimized();

function createVaultPrompt({ dialog, getWindow, isActive = active }) {
  return async function askVaultFill({ botName: rawName, origin, page }, signal) {
    const botName = strip(rawName);
    const win = getWindow();
    if (!win || win.isDestroyed() || signal.aborted) return null;
    if (!isActive(win)) return 'inactive';
    const { response } = await dialog.showMessageBox(win, { type: 'question', signal, buttons: ['Deny', 'Allow once'], defaultId: 0, cancelId: 0, noLink: true,
      message: `Let ${botName} fill a saved password on ${origin}?`,
      detail: `${botName} asked Hermes to fill your saved login into its tab at ${origin}.${origin.startsWith('http:') ? ' This site is not encrypted (http).' : ''}${page ? `\n\nPage: ${elide(strip(page))}` : ''}\n\nThe password is typed into that page, and the page can read it. Until the page changes (a navigation or reload), ${botName}'s reading tools on that tab are paused: page scripts, DevTools, screenshots, and form values in page reads. ${botName} can still click, type and press keys there to submit the login.\n\nAllow covers this one fill.` });
    return signal.aborted ? null : response === 1;
  };
}

module.exports = { createVaultPrompt };
