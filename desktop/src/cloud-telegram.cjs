// The telegram step: drive @BotFather inside the embedded Telegram Web view to
// mint a bot, validate the token against getMe, then drop the user into the
// bot chat with /start sent. Token strings never leave this module except as
// the value written to the remote env file — nothing logs them.
'use strict';

const TOKEN_PATTERN = /\d{6,}:[A-Za-z0-9_-]{30,}/;
const TOKEN_STRICT = /^\d{6,}:[A-Za-z0-9_-]{30,}$/;

// BotFather's last word on a username: a minted token, a taken handle, a rate
// limit, or anything else. A reply containing a token always wins — the
// congratulations text mentions the taken username back on retries.
function parseBotFatherReply(text) {
  const source = String(text || '');
  const token = TOKEN_PATTERN.exec(source)?.[0];
  if (token) return { type: 'token', token };
  if (/already taken|is taken|unavailable/i.test(source)) return { type: 'taken' };
  if (/too many (attempts|requests)|try again later|flood|rate.?limit/i.test(source)) return { type: 'rate-limit' };
  return { type: 'unknown' };
}

function botName(firstName) {
  const first = String(firstName || '').trim().slice(0, 32) || 'My';
  return `${first}'s Alan`;
}

// Telegram usernames: a-z, 0-9 and underscore, 5-32 chars, start with a letter.
function usernameSlug(firstName) {
  let slug = String(firstName || '').toLowerCase().replace(/[^a-z0-9_]+/g, '').slice(0, 18);
  if (!slug) slug = 'alan';
  if (/^\d/.test(slug)) slug = `a${slug}`.slice(0, 18);
  return slug;
}
const randomTail = (rng, length) => Array.from({ length }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(rng() * 36)]).join('');

function botUsername(firstName, rng = Math.random) {
  return `${usernameSlug(firstName)}_alan_${randomTail(rng, 4)}_bot`;
}
// BotFather "username is already taken" retries reuse the shape with an
// attempt suffix; Review Focus 3 caps this at 3 retries before the fallback.
function retryUsername(firstName, attempt, rng = Math.random) {
  const base = `${usernameSlug(firstName)}_alan_${randomTail(rng, 4)}`;
  return attempt > 0 ? `${base}_${attempt}_bot` : `${base}_bot`;
}

async function validateToken(token, fetchImpl = globalThis.fetch) {
  if (!TOKEN_STRICT.test(String(token || ''))) return { ok: false, username: '' };
  try {
    const res = await fetchImpl(`https://api.telegram.org/bot${token}/getMe`);
    const json = await res?.json?.().catch(() => null);
    return { ok: res?.ok === true && json?.ok === true, username: json?.ok ? String(json.result?.username || '') : '' };
  } catch { return { ok: false, username: '' }; }
}

// The profile the new bot token belongs to: the first that has none yet.
function untokenedProfile(lsOutput, tokenedProfiles) {
  const taken = new Set(Array.isArray(tokenedProfiles) ? tokenedProfiles : []);
  return String(lsOutput || '').split('\n').map((line) => line.trim()).filter(Boolean).sort().find((name) => !taken.has(name)) || '';
}

// The whole conversation runs inside the page: open the chat by hash, type in
// the composer, and read each incoming reply. Works against real Telegram Web
// A anchors (#MiddleColumn header/messages, contenteditable composer) and the
// fake page the Electron suite drives.
const PAGE_HELPERS = `
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const header = () => (document.querySelector('#MiddleColumn .MiddleHeader')?.textContent || '');
  const composer = () => document.querySelector('#editable-message-text') || document.querySelector('.Composer [contenteditable="true"], #MiddleColumn [contenteditable="true"]');
  const incoming = () => [...document.querySelectorAll('#MiddleColumn .Message:not(.own)')].map((el) => (el.innerText || el.textContent || '').trim()).filter(Boolean);
  const openChat = async (handle) => {
    const probe = new RegExp(handle.replace(/^@/, ''), 'i');
    if (probe.test(header())) return true;
    location.hash = '#' + handle;
    for (let i = 0; i < 40; i++) { if (probe.test(header())) return true; await sleep(250); }
    return probe.test(header());
  };
  const typeAndSend = (text) => {
    const el = composer();
    if (!el) return false;
    el.focus();
    el.textContent = text;
    el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    for (const type of ['keydown', 'keypress', 'keyup']) el.dispatchEvent(new KeyboardEvent(type, { bubbles: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 }));
    return true;
  };
  const sendAndRead = async (text) => {
    const before = incoming().length;
    if (!typeAndSend(text)) return '';
    // A reply can land split across bubbles (greeting, then the token): read
    // until the incoming count holds still for a beat instead of grabbing the
    // first new message.
    let last = before, quiet = 0;
    for (let i = 0; i < 80; i++) {
      await sleep(500);
      const texts = incoming();
      if (texts.length !== last) { last = texts.length; quiet = 0; continue; }
      if (last > before && ++quiet >= 2) return texts.slice(before).join('\\n');
    }
    return '';
  };`;

// Sends /newbot, the display name, then the username; returns the last reply
// for parseBotFatherReply to classify in the main process.
function botFatherScript({ name, username }) {
  return `(async () => {${PAGE_HELPERS}
  if (!await openChat('@BotFather')) return { ok: false, error: 'Could not open @BotFather.' };
  for (let i = 0; i < 60 && !composer(); i++) await sleep(250);
  if (!composer()) return { ok: false, error: 'No message box.' };
  let reply = '';
  for (const text of ${JSON.stringify(['/newbot', name, username])}) reply = await sendAndRead(text);
  return { ok: true, reply }; })()`;
}

// Opens a bot chat (t.me/<username> resolves to the @handle hash) and sends a
// single message — the /start that completes setup.
function sendMessageScript(handle, text) {
  return `(async () => {${PAGE_HELPERS}
  if (!await openChat('@' + ${JSON.stringify(String(handle).replace(/^@/, ''))})) return { ok: false, error: 'Could not open the bot chat.' };
  for (let i = 0; i < 60 && !composer(); i++) await sleep(250);
  if (!typeAndSend(${JSON.stringify(text)})) return { ok: false, error: 'No message box.' };
  return { ok: true }; })()`;
}

module.exports = { TOKEN_PATTERN, parseBotFatherReply, botName, botUsername, retryUsername, validateToken, untokenedProfile, botFatherScript, sendMessageScript };
