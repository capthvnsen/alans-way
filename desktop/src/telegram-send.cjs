// One path for putting text into the embedded Telegram composer: open the bot
// chat, focus the input through CDP so insertText lands in the real editable,
// and optionally press Enter. Shared by share-page and voice mode — every
// caller goes through the same trusted send path.

const COMPOSER_PROBE = `(() => {
  const el = document.querySelector('#editable-message-text') || document.querySelector('.Composer [contenteditable="true"], #MiddleColumn [contenteditable="true"]');
  if (!el || !el.offsetParent) return null;
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})()`;
// After the click focuses the composer, drop the caret at the end so injected
// text appends to any existing draft instead of landing mid-sentence.
const COLLAPSE_TO_END = `(() => {
  const el = document.querySelector('#editable-message-text') || document.querySelector('.Composer [contenteditable="true"], #MiddleColumn [contenteditable="true"]');
  if (!el) return false;
  el.focus();
  const sel = el.ownerDocument.getSelection();
  const range = el.ownerDocument.createRange();
  range.selectNodeContents(el); range.collapse(false);
  sel.removeAllRanges(); sel.addRange(range);
  return true;
})()`;

// deps: { getView: () => telegramView, openBot: (botId) => Promise<void> }
function createTelegramSend({ getView, openBot }) {
  async function compose(botId, text, { submit }) {
    const tg = getView()?.webContents;
    if (!tg || tg.isDestroyed()) throw new Error('Telegram is not loaded.');
    const chatHash = new RegExp(`#${String(botId).replace(/\W/g, '')}(?:_|/|$)`);
    if (!chatHash.test(tg.getURL())) await openBot(botId);
    if (tg.isLoading()) throw new Error('Telegram is still loading — try again in a moment.');
    let point = null;
    for (let i = 0; i < 16 && !point; i++) {
      // A stopped or never-committed page can leave executeJavaScript pending
      // forever; bound the probe so the button reports instead of hanging.
      point = await Promise.race([
        tg.executeJavaScript(COMPOSER_PROBE).catch(() => null),
        new Promise(resolve => setTimeout(() => resolve(null), 3000)),
      ]);
      if (!point) await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!point) throw new Error('The bot chat opened but no message box appeared.');
    if (!tg.debugger.isAttached()) tg.debugger.attach('1.3');
    try {
      await tg.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
      await tg.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
      await tg.executeJavaScript(COLLAPSE_TO_END).catch(() => {});
      await tg.debugger.sendCommand('Input.insertText', { text });
      if (submit) {
        const enter = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
        await tg.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', ...enter });
        await tg.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...enter });
      }
    } finally { tg.debugger.detach(); }
  }
  return {
    // Draft dictation: append text to the composer without sending.
    insertDraft: (botId, text) => compose(botId, text, { submit: false }),
    // Voice turn / share-page: text goes out immediately.
    send: (botId, text) => compose(botId, text, { submit: true }),
  };
}
module.exports = { createTelegramSend };
